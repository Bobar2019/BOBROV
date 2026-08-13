"""
Serveur FastAPI pour Cockpit-Lite ROV.
API REST, WebSockets temps réel, diffusion MJPEG et interface web.
"""

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Response, Request, HTTPException, UploadFile, File
from fastapi.responses import HTMLResponse, StreamingResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
import asyncio
import json
import logging
import time
import os
import subprocess
from typing import List, Dict, Any, Optional
from pathlib import Path

from .config_parser import ConfigParser
from .video_streamer import VideoStreamer
from .sensor_manager import SensorManager
from .imu_manager import IMUManager
from .imu_drivers import IMU_DRIVERS
from .scenario_manager import ScenarioManager
from .camera_controls import CameraControls
from .camera_detector import CameraDetector
from .gamepad_manager import GamepadManager
from .gamepad_controller import GamepadController
from .action_dispatcher import ActionDispatcher
from .goggle_manager import GoggleManager
from .motor_manager import MotorManager
from .i2c_controller import I2CController

logger = logging.getLogger(__name__)

# === Auto-Pilote (stabilisation embarquée sur l'ESP32-S3) ===
# Le Pi transmet via le PCA9685 émulé (0x40) :
#   ch15 : angle de Roulis IMU  → -180°=205 (1.0ms) / 0°=307 (1.5ms) / +180°=410 (2.0ms)
#   ch14 : mode Auto-Pilote     → 1=PASSIF (205) / 2=AUTO-ROLL (307) / 3=AUTO-FULL (410)
#   ch13 : angle de Tangage IMU → -180°=205 (1.0ms) / 0°=307 (1.5ms) / +180°=410 (2.0ms)
AUTOPILOT_MODES = {1: 'PASSIF', 2: 'AUTO-ROLL', 3: 'AUTO-FULL'}
AUTOPILOT_MODE_PWM = {1: 205, 2: 307, 3: 410}
AUTOPILOT_MODE_CHANNEL = 14
AUTOPILOT_ROLL_CHANNEL = 15
AUTOPILOT_PITCH_CHANNEL = 13


def angle_to_pwm(angle_deg: float) -> int:
    """Convertit un angle [-180°, +180°] en impulsion PWM raw [205, 410] (307 = 0°)"""
    angle = max(-180.0, min(180.0, float(angle_deg)))
    if angle >= 0:
        return int(round(307 + angle / 180.0 * 103.0))  # 0°→307, +180°→410
    return int(round(307 + angle / 180.0 * 102.0))      # -180°→205


# Alias historique (conversion identique pour roll et pitch)
roll_to_pwm = angle_to_pwm


class WebServer:
    """
    Serveur FastAPI complet pour Cockpit-Lite ROV.
    Gère l'API REST, les WebSockets, le flux MJPEG, le PiP et le frontend statique.
    """

    def __init__(self, config_path: str = "config.txt"):
        self.config = ConfigParser(config_path)
        self.active_websockets: List[WebSocket] = []
        self._ws_lock = asyncio.Lock()

        # État du ROV
        self.rov_state = {
            'armed': False,
            'light': self.config.get('ROV_CONTROL', 'light_default_brightness', 0),
            'recording': False,
            'autopilot_mode': 1,  # 1=PASSIF, 2=AUTO-ROLL, 3=AUTO-FULL
            'start_time': time.time()
        }

        # Initialiser les modules avec la config typée
        cam_cfg = self.config.get_camera_config()
        tel_cfg = self.config.get_telemetry_config()
        osd_cfg = self.config.get_osd_config()
        pip_cfg = self.config.get_section('CAMERA2') if self.config.config.has_section('CAMERA2') else {}
        rec_cfg = self.config.get_section('RECORDING')

        self.video_streamer = VideoStreamer(cam_cfg, pip_config=pip_cfg, osd_config=osd_cfg, recording_config=rec_cfg)
        self.sensor_manager = SensorManager(tel_cfg)

        # Gestionnaire IMU dynamique (ADXL345 / GY91 / QMI8658)
        self.imu_manager = IMUManager(self.config.get_imu_config())
        self.sensor_manager.set_imu_manager(self.imu_manager)

        self.scenario_manager = ScenarioManager(sensor_manager=self.sensor_manager)
        self.camera_detector = CameraDetector()
        self.camera_controls = CameraControls(config_parser=self.config, camera_detector=self.camera_detector)
        self.gamepad_manager = GamepadManager(self.config)
        self.gamepad_controller = GamepadController(self.rov_state, self.video_streamer)

        # Action Dispatcher — Bridge central des commandes
        self.action_dispatcher = ActionDispatcher(self.rov_state, self.video_streamer)
        self.gamepad_controller.set_dispatcher(self.action_dispatcher)

        # Gestionnaire mode Lunette (FPV/VR)
        self.goggle_manager = GoggleManager(self.config, self.gamepad_manager, self.video_streamer)

        # Gestionnaire des 8 moteurs (propulseurs)
        self.motor_manager = MotorManager(self.config)

        # Contrôleur I2C ESP32-S3 (PCA9685)
        self.i2c_controller = I2CController(config=self.config)
        self.motor_manager.set_i2c_controller(self.i2c_controller)
        self.action_dispatcher.set_motor_manager(self.motor_manager)
        self.action_dispatcher.set_i2c_controller(self.i2c_controller)
        self.action_dispatcher.set_sensor_manager(self.sensor_manager)
        if self.video_streamer:
            self.video_streamer.set_motor_manager(self.motor_manager)

        # Créer l'application FastAPI avec lifespan
        self.app = FastAPI(
            title="BOB-ROV",
            version="1.0.0",
            lifespan=self._lifespan
        )

        # Configurer les middlewares et routes
        self._setup_cors()
        self._setup_static()
        self._setup_routes()
        self._setup_websocket()

        logger.info("Serveur web initialisé")

    @asynccontextmanager
    async def _lifespan(self, app: FastAPI):
        """Gestion du cycle de vie : démarrage et arrêt des modules"""
        logger.info("Démarrage des modules Cockpit-Lite ROV...")
        self.video_streamer.start()
        self.imu_manager.start()
        # Re-signaler l'IMU au SensorManager après connexion (bascule roll/pitch en réel)
        self.sensor_manager.set_imu_manager(self.imu_manager)
        self.sensor_manager.start()
        self.i2c_controller.start()

        osd_task = asyncio.create_task(self._osd_sync_loop())
        autopilot_task = asyncio.create_task(self._autopilot_sync_loop())
        logger.info("Serveur prêt !")

        yield

        logger.info("Arrêt des modules...")
        osd_task.cancel()
        autopilot_task.cancel()
        try:
            await osd_task
        except asyncio.CancelledError:
            pass
        try:
            await autopilot_task
        except asyncio.CancelledError:
            pass
        self.scenario_manager.stop()
        self.i2c_controller.stop()
        self.video_streamer.stop()
        self.sensor_manager.stop()
        self.imu_manager.stop()
        logger.info("Tous les modules arrêtés")

    async def _osd_sync_loop(self):
        """Synchronise les données capteurs vers l'OSD vidéo en arrière-plan"""
        while True:
            try:
                sensor_data = self.sensor_manager.get_data()
                sensor_data['armed'] = self.rov_state.get('armed', False)
                self.video_streamer.update_telemetry(sensor_data)
            except Exception as e:
                logger.error(f"Erreur sync OSD: {e}")
            await asyncio.sleep(0.05)

    async def _autopilot_sync_loop(self):
        """
        Transmet en continu à l'ESP32-S3 (PCA9685 0x40) :
          - ch15 : le roulis IMU (QMI8658) converti en impulsion PWM
          - ch14 : le mode Auto-Pilote sélectionné
          - ch13 : le tangage IMU (QMI8658) converti en impulsion PWM
        L'envoi passe par queue_send (non-bloquant, écriture différentielle).
        """
        while True:
            try:
                if self.imu_manager.is_connected():
                    orientation = self.imu_manager.get_orientation()
                    roll = orientation['roll']
                    pitch = orientation['pitch']
                else:
                    # Fallback : roll/pitch du SensorManager (simulation ou GY-91 interne)
                    roll = self.sensor_manager.get('roll', 0.0)
                    pitch = self.sensor_manager.get('pitch', 0.0)
                mode = self.rov_state.get('autopilot_mode', 1)
                self.i2c_controller.queue_send({
                    AUTOPILOT_ROLL_CHANNEL: angle_to_pwm(roll),
                    AUTOPILOT_MODE_CHANNEL: AUTOPILOT_MODE_PWM.get(mode, 205),
                    AUTOPILOT_PITCH_CHANNEL: angle_to_pwm(pitch),
                })
            except Exception as e:
                logger.error(f"Erreur sync Auto-Pilote: {e}")
            await asyncio.sleep(0.05)

    def _setup_cors(self):
        """Configure CORS pour le développement"""
        self.app.add_middleware(
            CORSMiddleware,
            allow_origins=["*"],
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
        )

    def _setup_static(self):
        """Monte les fichiers statiques du frontend"""

        # Sous-classe StaticFiles qui ajoute Cache-Control: no-store
        # pour éviter ERR_CONTENT_LENGTH_MISMATCH quand les fichiers JS/CSS
        # sont modifiés sans redémarrer le serveur.
        class NoCacheStaticFiles(StaticFiles):
            async def get_response(self, path, scope):
                response = await super().get_response(path, scope)
                response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate"
                return response

        frontend_path = Path("frontend")
        if frontend_path.exists():
            css_path = frontend_path / "css"
            js_path = frontend_path / "js"
            if css_path.exists():
                self.app.mount("/css", NoCacheStaticFiles(directory=str(css_path)), name="css")
            if js_path.exists():
                self.app.mount("/js", NoCacheStaticFiles(directory=str(js_path)), name="js")
            logger.info(f"Fichiers statiques montés depuis {frontend_path}")
        else:
            logger.warning(f"Dossier frontend non trouvé: {frontend_path}")

        # Ressources statiques générales (modèles 3D .glb, etc.)
        static_path = Path("static")
        if static_path.exists():
            self.app.mount("/static", StaticFiles(directory=str(static_path)), name="static")
            logger.info(f"Ressources statiques montées depuis {static_path}")
        else:
            logger.warning(f"Dossier static non trouvé: {static_path}")

    def _setup_routes(self):
        """Configure toutes les routes HTTP de l'API"""

        # === PAGE PRINCIPALE ===
        @self.app.get("/", response_class=HTMLResponse)
        async def root():
            """Page d'accueil"""
            index_path = Path("frontend/index.html")
            if index_path.exists():
                return FileResponse(str(index_path), media_type="text/html")
            return HTMLResponse("<h1>BOB-ROV</h1><p>Frontend non trouvé.</p>")

        # === VISUALISEUR 3D (test mappage télécommande) ===
        @self.app.get("/mapping3d", response_class=HTMLResponse)
        async def mapping3d():
            """Page dédiée au visualiseur 3D Three.js du ROV"""
            page_path = Path("frontend/mapping3d.html")
            if page_path.exists():
                return FileResponse(str(page_path), media_type="text/html")
            return HTMLResponse("<h1>Visualiseur 3D</h1><p>Page non trouvée.</p>")

        # === SUB-SIMULATOR (simulateur sous-marin 3D) ===
        @self.app.get("/subsim", response_class=HTMLResponse)
        async def subsim():
            """Page dédiée au Sub-Simulator 3D"""
            page_path = Path("frontend/simulator3d.html")
            if page_path.exists():
                return FileResponse(str(page_path), media_type="text/html")
            return HTMLResponse("<h1>Sub-Simulator</h1><p>Page non trouvée.</p>")

        # === API SANTÉ ===
        @self.app.get("/api/health")
        async def health():
            """État de santé du système"""
            uptime = time.time() - self.rov_state['start_time']
            sim_status = self.scenario_manager.get_status()
            return {
                "status": "ok",
                "uptime": round(uptime, 1),
                "video": {
                    "running": self.video_streamer.is_running(),
                    "camera_connected": self.video_streamer.is_camera_connected(),
                    "fps": self.video_streamer.get_fps()
                },
                "sensors": {
                    "running": self.sensor_manager.running,
                    "simulation": self.sensor_manager.is_simulation(),
                    "per_sensor": dict(self.sensor_manager.sensor_sim),
                    "hardware": dict(self.sensor_manager.sensor_status)
                },
                "rov": {
                    "armed": self.rov_state['armed'],
                    "light": self.rov_state['light'],
                    "recording": self.rov_state['recording']
                },
                "simulation": sim_status
            }

        # === API TÉLÉMETRIE ===
        @self.app.get("/api/telemetry")
        async def get_telemetry():
            """Dernières données de télémétrie (champs plats + structure imu/environment)"""
            data = self.sensor_manager.get_data()
            data.update(self.sensor_manager.get_structured_data())
            data['fps'] = self.video_streamer.get_fps()
            data['armed'] = self.rov_state['armed']
            return data

        # === API CONFIGURATION ===
        @self.app.get("/api/config")
        async def get_config():
            """Configuration complète"""
            return self.config.get_all()

        @self.app.post("/api/config")
        async def update_config(config_data: Dict[str, Any]):
            """Met à jour la configuration (section par section)"""
            try:
                updated = []
                for section, values in config_data.items():
                    if isinstance(values, dict):
                        for key, value in values.items():
                            self.config.set(section, key, value)
                            updated.append(f"{section}.{key}")

                # Si CAMERA est mis à jour, propager au video_streamer et rouvrir si nécessaire
                if 'CAMERA' in config_data:
                    cam_data = config_data['CAMERA']
                    old_device = self.video_streamer.config.get('device')
                    # Propager les changements dans le dict config du video_streamer
                    for key, value in cam_data.items():
                        self.video_streamer.config[key] = value
                    # Si le device a changé, relâcher pour forcer la réouverture
                    new_device = cam_data.get('device')
                    if new_device and new_device != old_device:
                        logger.info(f"Caméra principale changée: {old_device} → {new_device}")
                        self.video_streamer._release_camera()
                        # La capture loop rouvrira automatiquement avec le nouveau device

                # Si CAMERA2 est mis à jour, gérer le PiP à la volée
                if 'CAMERA2' in config_data:
                    pip_cfg = self.config.get_section('CAMERA2')
                    self.video_streamer.pip_config = pip_cfg
                    pip_enabled = pip_cfg.get('pip_enabled', False) or pip_cfg.get('enabled', False)
                    # Si le device PiP a changé, relâcher et rouvrir
                    old_pip_device = self.video_streamer.pip_config.get('device')
                    new_pip_device = config_data['CAMERA2'].get('device')
                    if new_pip_device and new_pip_device != old_pip_device:
                        self.video_streamer._release_pip_camera()
                    if pip_enabled:
                        self.video_streamer.activate_pip()
                    else:
                        self.video_streamer.deactivate_pip()

                return {"status": "ok", "message": f"Config mise à jour: {', '.join(updated)}"}
            except Exception as e:
                raise HTTPException(status_code=400, detail=str(e))

        @self.app.post("/api/config/reload")
        async def reload_config():
            """Recharge la configuration depuis le fichier"""
            self.config.reload()
            return {"status": "ok", "message": "Configuration rechargée"}

        # === API CONTRÔLE ROV ===
        @self.app.post("/api/control/arm")
        async def arm():
            self.rov_state['armed'] = True
            self.sensor_manager.set_data('armed', True)
            logger.info("ROV ARMÉ")
            return {"status": "armed"}

        @self.app.post("/api/control/disarm")
        async def disarm():
            self.rov_state['armed'] = False
            self.sensor_manager.set_data('armed', False)
            logger.info("ROV DÉSARMÉ")
            return {"status": "disarmed"}

        @self.app.post("/api/control/light/{value}")
        async def set_light(value: int):
            if not (0 <= value <= 100):
                raise HTTPException(status_code=400, detail="Valeur entre 0 et 100")
            self.rov_state['light'] = value
            logger.info(f"Éclairage: {value}%")
            return {"status": "ok", "light": value}

        @self.app.get("/api/control/status")
        async def control_status():
            return self.rov_state

        # === ENREGISTREMENT VIDÉO / PHOTO ===
        @self.app.post("/api/record/start")
        async def record_start(data: Dict[str, Any] = {}):
            """Démarre l'enregistrement vidéo."""
            resolution = data.get('resolution', None)
            with_osd = data.get('with_osd', None)
            result = self.video_streamer.start_recording(resolution, with_osd=with_osd)
            if result.get('status') == 'ok':
                self.rov_state['recording'] = True
            return result

        @self.app.post("/api/record/stop")
        async def record_stop():
            """Arrête l'enregistrement vidéo."""
            result = self.video_streamer.stop_recording()
            self.rov_state['recording'] = False
            return result

        @self.app.get("/api/record/status")
        async def record_status():
            """État de l'enregistrement en cours."""
            return self.video_streamer.get_recording_info()

        @self.app.post("/api/photo")
        async def take_photo(data: Dict[str, Any] = {}):
            """Prend une photo instantanée."""
            resolution = data.get('resolution', None)
            with_osd = data.get('with_osd', None)
            return self.video_streamer.take_photo(resolution, with_osd=with_osd)

        @self.app.get("/api/recordings")
        async def list_recordings():
            """Liste tous les enregistrements (vidéos + photos)."""
            return self.video_streamer.get_recordings_list()

        @self.app.get("/api/recordings/{filename}")
        async def download_recording(filename: str, request: Request):
            """Télécharge ou lit un enregistrement (support Range requests pour vidéo)."""
            rec_dir = self.video_streamer._recordings_dir
            filepath = os.path.join(rec_dir, filename)
            # Sécurité : empêcher le path traversal
            real_path = os.path.realpath(filepath)
            if not real_path.startswith(os.path.realpath(rec_dir)):
                raise HTTPException(status_code=403, detail="Accès refusé")
            if not os.path.isfile(real_path):
                raise HTTPException(status_code=404, detail="Fichier non trouvé")

            # Déterminer le Content-Type
            if filename.lower().endswith('.mp4'):
                media_type = "video/mp4"
            elif filename.lower().endswith('.avi'):
                media_type = "video/x-msvideo"
            elif filename.lower().endswith('.jpg') or filename.lower().endswith('.jpeg'):
                media_type = "image/jpeg"
            else:
                media_type = "application/octet-stream"

            # Pour les vidéos : StreamingResponse avec support Range requests
            # (FileResponse ajoute Content-Disposition: attachment qui empêche
            #  la lecture inline dans <video>)
            if filename.lower().endswith(('.mp4', '.avi')):
                file_size = os.path.getsize(real_path)

                # Parse Range header
                range_header = None
                if hasattr(request, 'headers'):
                    range_header = request.headers.get('range')

                if range_header and range_header.startswith('bytes='):
                    try:
                        range_spec = range_header[6:]
                        start_str, end_str = range_spec.split('-', 1)
                        start = int(start_str) if start_str else 0
                        end = int(end_str) if end_str else file_size - 1
                        end = min(end, file_size - 1)
                        length = end - start + 1

                        async def range_iter():
                            with open(real_path, 'rb') as f:
                                f.seek(start)
                                remaining = length
                                while remaining > 0:
                                    chunk_size = min(65536, remaining)
                                    data = f.read(chunk_size)
                                    if not data:
                                        break
                                    remaining -= len(data)
                                    yield data

                        return StreamingResponse(
                            range_iter(),
                            status_code=206,
                            media_type=media_type,
                            headers={
                                "Content-Range": f"bytes {start}-{end}/{file_size}",
                                "Accept-Ranges": "bytes",
                                "Content-Length": str(length),
                            }
                        )
                    except (ValueError, IndexError):
                        pass

                # Pas de Range header → stream complet
                async def full_iter():
                    with open(real_path, 'rb') as f:
                        while True:
                            chunk = f.read(65536)
                            if not chunk:
                                break
                            yield chunk

                return StreamingResponse(
                    full_iter(),
                    media_type=media_type,
                    headers={
                        "Accept-Ranges": "bytes",
                        "Content-Length": str(file_size),
                    }
                )

            # Photos : FileResponse simple (Content-Disposition: attachment OK)
            return FileResponse(real_path, media_type=media_type, filename=filename)

        @self.app.delete("/api/recordings/{filename}")
        async def delete_recording(filename: str):
            """Supprime un enregistrement."""
            rec_dir = self.video_streamer._recordings_dir
            filepath = os.path.join(rec_dir, filename)
            real_path = os.path.realpath(filepath)
            if not real_path.startswith(os.path.realpath(rec_dir)):
                raise HTTPException(status_code=403, detail="Accès refusé")
            if not os.path.isfile(real_path):
                raise HTTPException(status_code=404, detail="Fichier non trouvé")
            try:
                os.remove(real_path)
                logger.info(f"Fichier supprimé: {filename}")
                return {"status": "ok"}
            except Exception as e:
                raise HTTPException(status_code=500, detail=str(e))

        # === FLUX VIDÉO MJPEG ===
        @self.app.get("/video_feed")
        async def video_feed():
            return StreamingResponse(
                self.video_streamer.get_mjpeg_generator(),
                media_type="multipart/x-mixed-replace; boundary=frame"
            )

        # === API CAMÉRAS ===
        @self.app.get("/api/cameras")
        async def list_cameras():
            """Liste les caméras USB connectées (utilise le cache)"""
            return {"devices": self.camera_detector.list_usb_cameras()}

        @self.app.get("/api/cameras/list")
        async def list_cameras_alias():
            """Alias pour /api/cameras (compatibilité)"""
            return {"devices": self.camera_detector.list_usb_cameras()}

        @self.app.post("/api/cameras/detect")
        async def detect_cameras():
            """Force une nouvelle détection des caméras (ignore le cache)"""
            start_time = time.time()
            devices = self.camera_detector.list_usb_cameras(force_refresh=True)
            scan_time_ms = round((time.time() - start_time) * 1000)
            logger.info(f"Détection caméras forcée: {len(devices)} trouvée(s) en {scan_time_ms}ms")
            return {
                "devices": devices,
                "count": len(devices),
                "scan_time_ms": scan_time_ms
            }

        @self.app.post("/api/cameras/select")
        async def select_camera(data: Dict[str, Any]):
            """Sélectionne la caméra principale"""
            device = data.get('device', '/dev/video0')
            self.config.set('CAMERA', 'device', device)
            logger.info(f"Caméra principale: {device}")
            return {"status": "ok", "device": device}

        @self.app.post("/api/cameras/pip")
        async def configure_pip(data: Dict[str, Any]):
            """Configure le Picture-in-Picture"""
            for key, value in data.items():
                self.config.set('CAMERA2', key, value)
            # Mettre à jour le video_streamer et ouvrir/fermer la caméra PiP
            pip_cfg = self.config.get_section('CAMERA2')
            self.video_streamer.pip_config = pip_cfg
            pip_enabled = pip_cfg.get('pip_enabled', False) or pip_cfg.get('enabled', False)
            if pip_enabled:
                self.video_streamer.activate_pip()
            else:
                self.video_streamer.deactivate_pip()
            logger.info(f"PiP configuré: {data}")
            return {"status": "ok", "pip": data}

        @self.app.post("/api/cameras/swap")
        async def swap_cameras():
            """Inverse les caméras principale et PiP (swap atomique)."""
            main_device = self.config.get('CAMERA', 'device', '/dev/video0')
            pip_device = self.config.get('CAMERA2', 'device', '/dev/video2')

            # Inverser les devices dans la config persistante
            self.config.set('CAMERA', 'device', pip_device)
            self.config.set('CAMERA2', 'device', main_device)

            # Propager la config PiP complète au video_streamer
            pip_cfg = self.config.get_section('CAMERA2')
            self.video_streamer.pip_config = pip_cfg

            # Swap thread-safe via le video_streamer
            ok = self.video_streamer.swap_cameras(main_device, pip_device)

            if ok:
                logger.info(f"Caméras inversées: principale={pip_device}, PiP={main_device}")
                return {"status": "ok", "main": pip_device, "pip": main_device}
            else:
                logger.error("Échec du swap caméras")
                return {"status": "error", "message": "Erreur lors de l'inversion des caméras"}

        @self.app.get("/api/camera/params")
        async def get_camera_params():
            device = self.config.get('CAMERA', 'device', '/dev/video0')
            try:
                result = subprocess.run(
                    ['v4l2-ctl', '-d', device, '-l'],
                    capture_output=True, text=True, timeout=5
                )
                return {"device": device, "params": result.stdout}
            except Exception as e:
                return {"device": device, "params": f"Erreur: {e}"}

        @self.app.post("/api/camera/params/{param}/{value}")
        async def set_camera_param(param: str, value: int):
            device = self.config.get('CAMERA', 'device', '/dev/video0')
            try:
                result = subprocess.run(
                    ['v4l2-ctl', '-d', device, '-c', f'{param}={value}'],
                    capture_output=True, text=True, timeout=5
                )
                if result.returncode == 0:
                    return {"status": "ok", "param": param, "value": value}
                raise HTTPException(status_code=400, detail=result.stderr)
            except FileNotFoundError:
                raise HTTPException(status_code=500, detail="v4l2-ctl non disponible")

        # === API OSD ===
        @self.app.post("/api/osd/config")
        async def update_osd_config(data: Dict[str, Any]):
            """Met à jour la configuration OSD (appliquée en temps réel sur le flux vidéo)"""
            for key, value in data.items():
                self.config.set('OSD_DISPLAY', key, value)
            # Propager immédiatement au video_streamer
            self.video_streamer.update_osd_config(data)
            logger.info(f"Config OSD mise à jour en direct: {list(data.keys())}")
            return {"status": "ok", "updated": list(data.keys())}

        # === API OSD LAYOUT (positions drag & drop par profil) ===
        LAYOUT_FILE = Path("osd_layouts.json")

        # Layout par défaut (source unique)
        _DEFAULT_LAYOUT = {
            "depth_x": 3, "depth_y": 15,
            "temperature_x": 88, "temperature_y": 5,
            "compass_x": 50, "compass_y": 92,
            "battery_x": 88, "battery_y": 12,
            "fps_x": 2, "fps_y": 82,
            "horizon_x": 50, "horizon_y": 50,
            "motors_x": 1, "motors_y": 82,
            "rov3d_x": 99, "rov3d_y": 99,
            "clock_x": 99, "clock_y": 98,
            "armed_x": 50, "armed_y": 6,
            "gamepad_battery_x": 2, "gamepad_battery_y": 75,
            "display_mode_x": 98, "display_mode_y": 3,
        }

        def _read_layouts() -> dict:
            """Lit osd_layouts.json et complète les clés manquantes avec les defaults."""
            layouts = None
            if LAYOUT_FILE.exists():
                try:
                    layouts = json.loads(LAYOUT_FILE.read_text(encoding="utf-8"))
                except (json.JSONDecodeError, OSError):
                    pass
            if layouts is None:
                layouts = {"screen": dict(_DEFAULT_LAYOUT), "goggles": dict(_DEFAULT_LAYOUT)}
            # Compléter chaque profil avec les clés manquantes
            for profile in ("screen", "goggles"):
                if profile not in layouts:
                    layouts[profile] = dict(_DEFAULT_LAYOUT)
                else:
                    for k, v in _DEFAULT_LAYOUT.items():
                        layouts[profile].setdefault(k, v)
            return layouts

        def _write_layouts(layouts: dict):
            """Écrit osd_layouts.json avec flush explicite sur disque."""
            with open(LAYOUT_FILE, 'w', encoding='utf-8') as f:
                json.dump(layouts, f, indent=2, ensure_ascii=False)
                f.flush()
                os.fsync(f.fileno())

        @self.app.get("/api/osd/layout")
        async def get_osd_layout(profile: str = "screen"):
            """Retourne la disposition OSD pour un profil donné."""
            layouts = _read_layouts()
            data = layouts.get(profile, layouts.get("screen", {}))
            return {"status": "ok", "profile": profile, "layout": data}

        @self.app.post("/api/osd/layout")
        async def save_osd_layout(body: Dict[str, Any]):
            """Sauvegarde la disposition OSD pour un profil donné."""
            profile = body.get("profile", "screen")
            layout = body.get("layout", {})
            if profile not in ("screen", "goggles"):
                return {"status": "error", "message": f"Profil inconnu: {profile}"}
            layouts = _read_layouts()
            layouts[profile] = layout
            _write_layouts(layouts)
            # Propager en direct si c'est le profil actif
            if self.video_streamer and hasattr(self.video_streamer, 'update_osd_config'):
                self.video_streamer.update_osd_config(layout)
            logger.info(f"Layout OSD '{profile}' sauvegardé")
            return {"status": "ok", "profile": profile, "saved": list(layout.keys())}

        @self.app.get("/api/osd/layout/default")
        async def get_default_osd_layout():
            """Retourne la disposition OSD par défaut (hardcodée)."""
            return {
                "status": "ok",
                "layout": dict(_DEFAULT_LAYOUT)
            }

        # === API SIMULATION (Scénarios) ===
        @self.app.get("/api/scenarios")
        async def list_scenarios():
            """Liste les scénarios disponibles"""
            return {"scenarios": self.scenario_manager.list_scenarios()}

        @self.app.post("/api/scenarios/load")
        async def load_scenario(data: Dict[str, Any]):
            """Charge un scénario"""
            filename = data.get('filename', 'default.json')
            try:
                scenario = self.scenario_manager.load_scenario(filename)
                return {"status": "ok", "scenario": scenario}
            except (FileNotFoundError, ValueError) as e:
                raise HTTPException(status_code=400, detail=str(e))

        @self.app.post("/api/scenarios/save")
        async def save_scenario(data: Dict[str, Any]):
            """Sauvegarde un scénario"""
            filename = data.get('filename', 'custom.json')
            scenario = data.get('scenario', {})
            try:
                path = self.scenario_manager.save_scenario(filename, scenario)
                return {"status": "ok", "path": path}
            except ValueError as e:
                raise HTTPException(status_code=400, detail=str(e))

        @self.app.post("/api/simulation/start")
        async def start_simulation(data: Optional[Dict[str, Any]] = None):
            """Démarre la simulation avec le scénario chargé"""
            scenario_name = data.get('filename') if data else None
            try:
                self.scenario_manager.start(scenario_name)
                return {"status": "ok", "state": "running"}
            except ValueError as e:
                raise HTTPException(status_code=400, detail=str(e))

        @self.app.post("/api/simulation/stop")
        async def stop_simulation():
            """Arrête la simulation"""
            self.scenario_manager.stop()
            self.sensor_manager.clear_overrides()
            return {"status": "ok", "state": "stopped"}

        @self.app.post("/api/simulation/pause")
        async def pause_simulation():
            """Met en pause / reprend la simulation"""
            self.scenario_manager.pause()
            status = self.scenario_manager.get_status()
            return {"status": "ok", "state": status['state']}

        @self.app.post("/api/simulation/reset")
        async def reset_simulation():
            """Réinitialise la simulation au début"""
            self.scenario_manager.reset()
            return {"status": "ok"}

        @self.app.get("/api/simulation/status")
        async def simulation_status():
            """État actuel de la simulation"""
            return self.scenario_manager.get_status()

        @self.app.post("/api/simulation/value")
        async def set_sim_value(data: Dict[str, Any]):
            """Modifie un paramètre de simulation en temps réel"""
            action = data.get('action', '')
            value = data.get('value', 0)
            self.scenario_manager.set_realtime_value(action, float(value))
            return {"status": "ok"}

        # === API THÈME ===
        @self.app.post("/api/theme")
        async def set_theme(data: Dict[str, str]):
            """Change le thème (jour/nuit)"""
            mode = data.get('mode', 'night')
            self.config.set('THEME', 'mode', mode)
            return {"status": "ok", "theme": mode}

        # === API SIMULATION (toggle simple) ===
        @self.app.post("/api/simulation/{enabled}")
        async def toggle_simulation(enabled: bool):
            self.sensor_manager.set_simulation(enabled)
            return {"status": "ok", "simulation": enabled}

        # === API CAPTEURS INDIVIDUELS ===
        @self.app.get("/api/sensors")
        async def get_sensors_status():
            """État de tous les capteurs (simulé/réel + statut matériel)"""
            return self.sensor_manager.get_sensor_status()

        @self.app.post("/api/sensors/simulation/{enabled}")
        async def toggle_all_sensors_simulation(enabled: bool):
            """Active/désactive la simulation globale de tous les capteurs"""
            self.sensor_manager.set_simulation(enabled)
            return {"status": "ok", "simulation": enabled}

        @self.app.post("/api/sensors/adxl345/{enabled}")
        async def toggle_adxl345(enabled: bool):
            """Active/désactive l'ADXL345 (init I2C à chaud)"""
            self.config.set('TELEMETRY', 'adxl345_enabled', str(enabled))
            if enabled and not self.sensor_manager._adxl_ok:
                # Tenter l'init à chaud si le bus I2C est disponible
                if self.sensor_manager._i2c_available:
                    self.sensor_manager._adxl_enabled = True
                    self.sensor_manager._init_adxl345()
            elif not enabled:
                self.sensor_manager._adxl_ok = False
                self.sensor_manager._adxl_enabled = False
                self.sensor_manager.sensor_sim['roll'] = True
                self.sensor_manager.sensor_sim['pitch'] = True
            return {"status": "ok", "adxl345_enabled": enabled, "adxl345_ok": self.sensor_manager._adxl_ok}

        @self.app.post("/api/sensors/{sensor}/{simulated}")
        async def toggle_sensor(sensor: str, simulated: bool):
            """Active/désactive un capteur individuel (simulated=true → sim, false → réel)"""
            ok = self.sensor_manager.set_sensor_sim(sensor, simulated)
            return {
                "status": "ok" if ok else "error",
                "sensor": sensor,
                "simulated": simulated
            }

        # === API IMU (capteur inertiel dynamique) ===
        @self.app.get("/api/imu/status")
        async def imu_status():
            """État de santé du capteur IMU actif (nom, adresse I2C, alerte)"""
            status = self.imu_manager.get_status()
            status['orientation'] = self.imu_manager.get_orientation()
            status['acceleration'] = self.imu_manager.get_acceleration()
            return status

        @self.app.post("/api/imu/sensor/{sensor_type}")
        async def select_imu_sensor(sensor_type: str):
            """Change le capteur IMU actif à chaud (ADXL345 | GY91 | QMI8658)"""
            sensor_type = sensor_type.upper().strip()
            if sensor_type not in IMU_DRIVERS:
                raise HTTPException(
                    status_code=400,
                    detail=f"Capteur inconnu '{sensor_type}' "
                           f"(valides: {', '.join(IMU_DRIVERS.keys())})")
            ok = self.imu_manager.switch_sensor(sensor_type)
            # Persister le choix dans config.txt
            self.config.set('IMU', 'sensor_type', sensor_type)
            # Re-synchroniser les flags simulation roll/pitch
            if ok:
                self.sensor_manager.set_imu_manager(self.imu_manager)
            else:
                self.sensor_manager.sensor_sim['roll'] = True
                self.sensor_manager.sensor_sim['pitch'] = True
            return {
                "status": "ok" if ok else "error",
                "connected": ok,
                "imu": self.imu_manager.get_status()
            }

        # === API AUTO-PILOTE (stabilisation ESP32-S3) ===
        @self.app.get("/api/autopilot/mode")
        async def get_autopilot_mode():
            """Mode Auto-Pilote actuel + dernières valeurs PWM transmises"""
            mode = self.rov_state.get('autopilot_mode', 1)
            if self.imu_manager.is_connected():
                orientation = self.imu_manager.get_orientation()
                roll = orientation['roll']
                pitch = orientation['pitch']
            else:
                roll = self.sensor_manager.get('roll', 0.0)
                pitch = self.sensor_manager.get('pitch', 0.0)
            return {
                "mode": mode,
                "mode_name": AUTOPILOT_MODES.get(mode, 'INCONNU'),
                "modes": AUTOPILOT_MODES,
                "roll": round(roll, 2),
                "pitch": round(pitch, 2),
                "pwm_mode_ch14": AUTOPILOT_MODE_PWM.get(mode, 205),
                "pwm_roll_ch15": angle_to_pwm(roll),
                "pwm_pitch_ch13": angle_to_pwm(pitch),
            }

        @self.app.post("/api/autopilot/mode")
        async def set_autopilot_mode(payload: Dict[str, Any]):
            """Change le mode Auto-Pilote : {"mode": 1|2|3} (1=PASSIF, 2=AUTO-ROLL, 3=AUTO-FULL)"""
            try:
                mode = int(payload.get('mode'))
            except (TypeError, ValueError):
                raise HTTPException(status_code=400, detail="Champ 'mode' requis (1, 2 ou 3)")
            if mode not in AUTOPILOT_MODES:
                raise HTTPException(
                    status_code=400,
                    detail=f"Mode invalide {mode} (valides: "
                           f"{', '.join(f'{k}={v}' for k, v in AUTOPILOT_MODES.items())})")
            self.rov_state['autopilot_mode'] = mode
            # Envoi immédiat sans attendre le prochain cycle de la boucle
            self.i2c_controller.queue_send({
                AUTOPILOT_MODE_CHANNEL: AUTOPILOT_MODE_PWM[mode],
            })
            logger.info(f"Auto-Pilote → mode {mode} ({AUTOPILOT_MODES[mode]}) "
                        f"[ch14 PWM={AUTOPILOT_MODE_PWM[mode]}]")
            return {
                "status": "ok",
                "mode": mode,
                "mode_name": AUTOPILOT_MODES[mode],
                "pwm_mode_ch14": AUTOPILOT_MODE_PWM[mode],
            }

        # === API SYSTÈME ===
        @self.app.get("/api/system")
        async def system_info():
            """Informations système du Raspberry Pi"""
            info = {}
            try:
                with open('/sys/class/thermal/thermal_zone0/temp', 'r') as f:
                    info['cpu_temp'] = round(int(f.read().strip()) / 1000.0, 1)
            except Exception:
                info['cpu_temp'] = None
            try:
                with open('/proc/loadavg', 'r') as f:
                    parts = f.read().strip().split()
                    info['load_1m'] = float(parts[0])
                    info['load_5m'] = float(parts[1])
                    info['load_15m'] = float(parts[2])
            except Exception:
                info['load_1m'] = None
            try:
                with open('/proc/meminfo', 'r') as f:
                    for line in f:
                        if 'MemTotal' in line:
                            info['mem_total_kb'] = int(line.split()[1])
                        elif 'MemAvailable' in line:
                            info['mem_available_kb'] = int(line.split()[1])
                if 'mem_total_kb' in info and 'mem_available_kb' in info:
                    info['mem_used_pct'] = round(
                        (1 - info['mem_available_kb'] / info['mem_total_kb']) * 100, 1)
            except Exception:
                pass
            try:
                st = os.statvfs('/')
                info['disk_total_gb'] = round(st.f_blocks * st.f_frsize / (1024**3), 1)
                info['disk_free_gb'] = round(st.f_bfree * st.f_frsize / (1024**3), 1)
            except Exception:
                pass
            return info

        @self.app.post("/api/system/reboot")
        async def system_reboot():
            """Redémarre le Raspberry Pi (nécessite sudo sans mot de passe)."""
            import subprocess
            try:
                logger.warning("⚠️ Redémarrage système demandé via l'interface")
                subprocess.Popen(['sudo', 'reboot'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                return {"status": "ok", "message": "Redémarrage en cours…"}
            except Exception as e:
                raise HTTPException(status_code=500, detail=f"Erreur reboot: {e}")

        # === API CONTRÔLES CAMÉRA V4L2 (multi-device) ===
        @self.app.get("/api/camera/params/{device:path}")
        async def get_camera_params_device(device: str):
            """Lit tous les paramètres V4L2 d'une caméra spécifique"""
            if not device.startswith('/dev/'):
                device = f'/dev/{device}'
            controls = self.camera_controls.get_available_controls(device)
            return {"device": device, "controls": controls}

        @self.app.post("/api/camera/params/{device:path}")
        async def set_camera_params_device(device: str, data: Dict[str, Any]):
            """Applique des paramètres V4L2 à une caméra spécifique"""
            if not device.startswith('/dev/'):
                device = f'/dev/{device}'
            results = self.camera_controls.apply_controls(device, data)
            return {"status": "ok", "device": device, "results": results}

        @self.app.get("/api/camera/controls/{device:path}")
        async def get_camera_controls_device(device: str):
            """Liste des contrôles disponibles pour une caméra"""
            if not device.startswith('/dev/'):
                device = f'/dev/{device}'
            controls = self.camera_controls.get_available_controls(device)
            return {"device": device, "controls": list(controls.keys())}

        @self.app.post("/api/camera/reset/{device:path}")
        async def reset_camera_params_device(device: str):
            """Réinitialise les paramètres d'une caméra"""
            if not device.startswith('/dev/'):
                device = f'/dev/{device}'
            results = self.camera_controls.reset_controls(device)
            return {"status": "ok", "device": device, "results": results}

        # === API SCÉNARIO (format liste d'instructions) ===
        @self.app.post("/api/scenario/save")
        async def save_scenario_list(data: Dict[str, Any]):
            """Sauvegarde un scénario au format liste d'instructions"""
            filename = data.get('filename', 'custom.json')
            scenario = data.get('scenario', {})
            try:
                steps = self._convert_instructions_to_steps(scenario.get('instructions', []))
                scenario_data = {
                    'name': scenario.get('nom', scenario.get('name', 'Sans nom')),
                    'description': scenario.get('description', ''),
                    'loop': scenario.get('boucle', scenario.get('loop', False)),
                    'steps': steps,
                    'instructions': scenario.get('instructions', [])  # Conserver les instructions originales
                }
                path = self.scenario_manager.save_scenario(filename, scenario_data)
                return {"status": "ok", "path": path}
            except ValueError as e:
                raise HTTPException(status_code=400, detail=str(e))

        @self.app.post("/api/scenario/load")
        async def load_scenario_list(data: Dict[str, Any]):
            """Charge un scénario et le retourne au format liste"""
            filename = data.get('filename', 'default.json')
            try:
                scenario = self.scenario_manager.load_scenario(filename)
                # Si les instructions originales sont stockées, les utiliser directement
                if scenario.get('instructions'):
                    instructions = scenario['instructions']
                else:
                    instructions = self._convert_steps_to_instructions(scenario.get('steps', []))
                return {
                    "status": "ok",
                    "scenario": {
                        'nom': scenario.get('name', filename),
                        'description': scenario.get('description', ''),
                        'boucle': scenario.get('loop', False),
                        'instructions': instructions
                    }
                }
            except (FileNotFoundError, ValueError) as e:
                raise HTTPException(status_code=400, detail=str(e))

        @self.app.post("/api/scenario/execute")
        async def execute_scenario(data: Optional[Dict[str, Any]] = None):
            """Exécute un scénario (charge + démarre)"""
            filename = data.get('filename') if data else None
            # Si des instructions sont fournies, les sauvegarder d'abord
            if data and 'scenario' in data:
                scenario = data['scenario']
                steps = self._convert_instructions_to_steps(scenario.get('instructions', []))
                scenario_data = {
                    'name': scenario.get('nom', 'Direct'),
                    'description': scenario.get('description', ''),
                    'loop': scenario.get('boucle', False),
                    'steps': steps
                }
                fname = '_direct.json'
                self.scenario_manager.save_scenario(fname, scenario_data)
                filename = fname
            try:
                self.scenario_manager.start(filename)
                return {"status": "ok", "state": "running"}
            except ValueError as e:
                raise HTTPException(status_code=400, detail=str(e))

        @self.app.post("/api/scenario/stop")
        async def stop_scenario():
            """Arrête l'exécution du scénario"""
            self.scenario_manager.stop()
            self.sensor_manager.clear_overrides()
            return {"status": "ok", "state": "stopped"}

        @self.app.get("/api/scenario/status")
        async def scenario_status():
            """État de l'exécution du scénario"""
            return self.scenario_manager.get_status()

        @self.app.post("/api/scenario/loop")
        async def toggle_scenario_loop(data: Dict[str, Any]):
            """Active/désactive la boucle du scénario chargé"""
            enabled = data.get('enabled', True)
            if self.scenario_manager._current_scenario:
                self.scenario_manager._current_scenario['loop'] = enabled
            return {"status": "ok", "loop": enabled}

        # === API Actions (Dispatcher) ===
        @self.app.post("/api/action/{action_name}")
        async def execute_action(action_name: str):
            """Exécute une action via le dispatcher central"""
            result = self.action_dispatcher.execute(action_name)
            return result

        @self.app.get("/api/actions/status")
        async def get_actions_status():
            """Retourne le statut de toutes les actions"""
            return self.action_dispatcher.get_status()

        @self.app.get("/api/actions/log")
        async def get_actions_log(limit: int = 20):
            """Retourne le journal des dernières actions"""
            return {"status": "ok", "log": self.action_dispatcher.get_log(limit)}

        @self.app.get("/api/actions/functions")
        async def get_available_functions():
            """Retourne la liste des fonctions disponibles pour le mapping"""
            return {"status": "ok", "functions": self.action_dispatcher.get_available_functions()}

        # === API GAMEPAD (Config Manette) ===
        @self.app.get("/api/gamepad/status")
        async def gamepad_status():
            """État du gestionnaire manette"""
            return self.gamepad_manager.get_status()

        @self.app.get("/api/gamepad/profiles")
        async def gamepad_list_profiles():
            """Liste tous les profils manette"""
            return {"status": "ok", "data": self.gamepad_manager.list_profiles()}

        @self.app.get("/api/gamepad/profile/{name}")
        async def gamepad_get_profile(name: str):
            """Charge un profil manette par nom"""
            profile = self.gamepad_manager.load_profile(name)
            if profile:
                return {"status": "ok", "data": profile}
            raise HTTPException(status_code=404, detail=f"Profil '{name}' non trouvé")

        @self.app.post("/api/gamepad/profile")
        async def gamepad_save_profile(request: Request):
            """Sauvegarde un profil manette (crée ou met à jour)"""
            data = await request.json()
            name = data.get('name', '')
            if not name:
                raise HTTPException(status_code=400, detail="Nom de profil requis")
            # Extraire les données du profil (le frontend envoie { name, profile })
            profile_data = data.get('profile', data)
            return self.gamepad_manager.save_profile(name, profile_data)

        @self.app.delete("/api/gamepad/profile/{name}")
        async def gamepad_delete_profile(name: str):
            """Supprime un profil manette"""
            result = self.gamepad_manager.delete_profile(name)
            if result.get('status') == 'error':
                raise HTTPException(status_code=400, detail=result['message'])
            return result

        @self.app.post("/api/gamepad/profile/import")
        async def gamepad_import_profile(request: Request):
            """Importe un profil manette depuis un JSON"""
            data = await request.json()
            return self.gamepad_manager.import_profile(data)

        @self.app.get("/api/gamepad/profile/{name}/export")
        async def gamepad_export_profile(name: str):
            """Exporte un profil manette pour téléchargement"""
            export = self.gamepad_manager.export_profile(name)
            if export:
                return {"status": "ok", "data": export}
            raise HTTPException(status_code=404, detail=f"Profil '{name}' non trouvé")

        @self.app.post("/api/gamepad/active")
        async def gamepad_set_active(request: Request):
            """Définit le profil actif"""
            data = await request.json()
            name = data.get('name', '')
            if not name:
                raise HTTPException(status_code=400, detail="Nom de profil requis")
            result = self.gamepad_manager.set_active_profile(name)
            if result.get('status') == 'error':
                raise HTTPException(status_code=404, detail=result['message'])
            return result

        @self.app.get("/api/gamepad/mapping")
        async def gamepad_get_mapping():
            """Retourne le mapping du profil actif"""
            mapping = self.gamepad_manager.get_mapping()
            return {"status": "ok", "data": mapping}

        @self.app.post("/api/gamepad/mapping")
        async def gamepad_update_mapping(request: Request):
            """Met à jour le mapping du profil actif"""
            data = await request.json()
            return self.gamepad_manager.update_mapping(data)

        @self.app.post("/api/gamepad/calibrate")
        async def gamepad_calibrate(request: Request):
            """Lance la calibration de la manette (placeholder)"""
            data = await request.json() if request else {}
            return {
                "status": "ok",
                "message": "Calibration terminée (placeholder)",
                "deadzone": data.get('deadzone', 12),
                "sensitivity": data.get('sensitivity', 100)
            }

        # === API Mode Lunette ===
        @self.app.post("/api/goggle/activate")
        async def activate_goggle():
            """Active le mode lunette"""
            return self.goggle_manager.activate()

        @self.app.post("/api/goggle/deactivate")
        async def deactivate_goggle():
            """Désactive le mode lunette"""
            return self.goggle_manager.deactivate()

        @self.app.get("/api/goggle/status")
        async def get_goggle_status():
            """Retourne l'état du mode lunette"""
            return self.goggle_manager.get_status()

        @self.app.post("/api/goggle/night")
        async def toggle_goggle_night():
            """Bascule le mode nuit"""
            return self.goggle_manager.toggle_night()

        # === API Moteurs (Propulseurs) ===
        @self.app.get("/api/motors/status")
        async def get_motors_status():
            """Retourne l'état des 8 moteurs"""
            return self.motor_manager.get_status()

        @self.app.post("/api/motors/thrust")
        async def set_motor_thrust(data: Dict[str, Any]):
            """Définit la puissance d'un ou plusieurs moteurs"""
            if "motor_id" in data and "value" in data:
                self.motor_manager.set_thrust(int(data["motor_id"]), float(data["value"]))
            elif "motors" in data:
                self.motor_manager.set_all_thrust(data["motors"])
            return {"status": "ok"}

        @self.app.post("/api/motors/stop")
        async def stop_all_motors():
            """Arrête tous les moteurs"""
            self.motor_manager.stop_all()
            return {"status": "ok", "message": "Tous les moteurs arrêtés"}

        @self.app.post("/api/motors/move")
        async def motors_move(data: Dict[str, Any]):
            """Exécute un mouvement 6-DOF via la matrice de mixage"""
            surge = float(data.get('surge', 0))
            sway = float(data.get('sway', 0))
            yaw = float(data.get('yaw', 0))
            heave = float(data.get('heave', 0))
            roll = float(data.get('roll', 0))
            pitch = float(data.get('pitch', 0))
            result = self.action_dispatcher.execute_move(surge, sway, yaw, heave, roll, pitch)
            return {"status": "ok", "motors": result.get('motors', {})}

        # === API I2C (Contrôleur ESP32) ===
        @self.app.get("/api/i2c/status")
        async def get_i2c_status():
            """Statut de la connexion I2C ESP32"""
            return self.i2c_controller.get_status()

        @self.app.post("/api/i2c/reconnect")
        async def reconnect_i2c():
            """Tente une reconnexion au contrôleur I2C"""
            success = self.i2c_controller.reconnect()
            return {"success": success, "status": self.i2c_controller.get_status()}

        # === API WI-FI (NetworkManager / nmcli) ===

        async def _run_nmcli(cmd: list, timeout: int = 15) -> subprocess.CompletedProcess:
            """Exécute une commande nmcli dans un thread (non-bloquant)."""
            return await asyncio.to_thread(
                subprocess.run,
                cmd,
                capture_output=True, text=True, timeout=timeout
            )

        @self.app.get("/api/wifi/status")
        async def wifi_status():
            """Retourne le statut Wi-Fi actuel via nmcli (SSID, IP, signal)."""
            ssid = ""
            ip_addr = ""
            signal_val = None
            connected = False

            try:
                # Récupérer le réseau actif : active, ssid, device, ip4
                result = await _run_nmcli(
                    ['nmcli', '-t', '-f', 'ACTIVE,SSID,DEVICE,IP4', 'device', 'wifi', 'list'],
                    timeout=10
                )
                if result.returncode == 0:
                    for line in result.stdout.strip().split('\n'):
                        if not line.strip():
                            continue
                        # Format : ACTIVE:SSID:DEVICE:IP4
                        # ACTIVE peut être '*' ou 'yes' selon la version nmcli
                        parts = line.split(':', 3)
                        if len(parts) >= 4:
                            active_flag = parts[0].strip()
                            if active_flag in ('*', 'yes'):
                                ssid = parts[1].strip()
                                # IP4 peut être "172.22.22.138/24" ou vide
                                raw_ip = parts[3].strip()
                                ip_addr = raw_ip.split('/')[0] if raw_ip else ""
                                connected = bool(ssid)
                                break

                # Récupérer la force du signal séparément
                sig_result = await _run_nmcli(
                    ['nmcli', '-t', '-f', 'ACTIVE,SIGNAL', 'device', 'wifi', 'list'],
                    timeout=10
                )
                if sig_result.returncode == 0:
                    for line in sig_result.stdout.strip().split('\n'):
                        parts = line.split(':')
                        if len(parts) >= 2 and parts[0].strip() in ('*', 'yes'):
                            try:
                                signal_val = int(parts[1].strip())
                            except ValueError:
                                pass
                            break

            except subprocess.TimeoutExpired:
                logger.warning("Wi-Fi status: timeout nmcli")
            except FileNotFoundError:
                logger.error("Wi-Fi status: nmcli non trouvé (NetworkManager absent ?)")
                return {"connected": False, "ssid": "", "ip": "", "signal": None,
                        "error": "nmcli non disponible"}
            except Exception as e:
                logger.error(f"Wi-Fi status erreur: {e}")
                return {"connected": False, "ssid": "", "ip": "", "signal": None,
                        "error": str(e)}

            return {
                "connected": connected,
                "ssid": ssid,
                "ip": ip_addr,
                "signal": signal_val
            }

        @self.app.get("/api/wifi/scan")
        async def wifi_scan():
            """Exécute un scan Wi-Fi et retourne la liste des réseaux uniques."""
            try:
                result = await _run_nmcli(
                    ['nmcli', '-t', '-f', 'SSID,SIGNAL,SECURITY,ACTIVE', 'device', 'wifi', 'list', '--rescan', 'yes'],
                    timeout=30
                )
                if result.returncode != 0:
                    stderr = result.stderr.strip()
                    logger.error(f"Wi-Fi scan erreur (rc={result.returncode}): {stderr}")
                    return {"networks": [], "error": stderr or "Erreur nmcli"}

                # Parser et dédupliquer les réseaux
                # Format nmcli : SSID:SIGNAL:SECURITY:ACTIVE
                # Le SSID peut contenir '\:' (échappé), on utilise rsplit depuis la droite
                seen = {}
                for line in result.stdout.strip().split('\n'):
                    if not line.strip():
                        continue

                    # rsplit en 3 parties depuis la droite : SSID reste à gauche
                    parts = line.rsplit(':', 3)
                    if len(parts) < 4:
                        # Fallback : SSID sans ':', format standard
                        parts = line.split(':')
                        if len(parts) < 4:
                            continue

                    ssid = parts[0].strip()
                    # Remplacer les '\:' échappés par nmcli
                    ssid = ssid.replace('\\:', ':')
                    if not ssid or ssid in ('--', '\\--'):
                        continue  # Réseau masqué ou vide

                    try:
                        signal = int(parts[1].strip())
                    except ValueError:
                        signal = 0

                    security = parts[2].strip()
                    active_flag = parts[3].strip()
                    is_active = active_flag in ('*', 'yes')
                    secured = bool(security and security != '--' and
                                   any(s in security.upper() for s in ('WPA', 'WEP', 'SAE', 'OWE')))

                    # Garder le meilleur signal pour chaque SSID
                    if ssid not in seen or signal > seen[ssid]['signal']:
                        seen[ssid] = {
                            'ssid': ssid,
                            'signal': signal,
                            'secured': secured,
                            'security': security if secured else '',
                            'active': is_active
                        }

                networks = sorted(seen.values(), key=lambda x: x['signal'], reverse=True)
                logger.info(f"Wi-Fi scan: {len(networks)} réseaux trouvés")
                return {"networks": networks}

            except subprocess.TimeoutExpired:
                logger.error("Wi-Fi scan: timeout (30s)")
                return {"networks": [], "error": "Scan timeout (30s)"}
            except FileNotFoundError:
                msg = "nmcli non trouvé — NetworkManager est-il installé ?"
                logger.error(f"Wi-Fi scan: {msg}")
                return {"networks": [], "error": msg}
            except Exception as e:
                logger.error(f"Wi-Fi scan exception: {e}")
                return {"networks": [], "error": str(e)}

        @self.app.post("/api/wifi/connect")
        async def wifi_connect(data: Dict[str, Any]):
            """Connecte à un réseau Wi-Fi via nmcli (asynchrone, non-bloquant).
            Négocie nativement WPA2/WPA3 (SAE) avec fallback explicite
            pour les hotspots hybrides (iPhone, etc.).
            """
            ssid = data.get('ssid', '').strip()
            password = data.get('password', '')

            if not ssid:
                raise HTTPException(status_code=400, detail="SSID requis")

            logger.info(f"Wi-Fi connexion demandée à: {ssid}")

            try:
                # Étape 1 : supprimer tout profil existant pour ce SSID
                await _run_nmcli(
                    ['nmcli', 'connection', 'delete', 'id', ssid],
                    timeout=10
                )
                logger.debug(f"Wi-Fi: profil '{ssid}' nettoyé (si existant)")

                # Étape 2 : connexion directe native (nmcli négocie WPA2/WPA3)
                cmd = ['nmcli', 'device', 'wifi', 'connect', ssid]
                if password:
                    cmd.extend(['password', password])

                result = await _run_nmcli(cmd, timeout=45)

                if result.returncode == 0:
                    logger.info(f"Wi-Fi connecté avec succès à: {ssid}")
                    return {
                        "status": "ok",
                        "success": True,
                        "message": f"Connecté avec succès à {ssid}",
                        "ssid": ssid
                    }

                # Étape 3 : fallback si erreur de sécurité (WPA3/SAE hybride iPhone)
                raw_err = result.stderr.strip() or result.stdout.strip() or ""
                is_security_err = any(kw in raw_err.lower() for kw in (
                    'security', 'key-mgmt', 'secret', '802-11-wireless'
                ))

                if is_security_err and password:
                    logger.info(f"Wi-Fi: fallback profil WPA2/WPA3 pour '{ssid}'")

                    # Nettoyer le profil partiel créé par la première tentative
                    await _run_nmcli(
                        ['nmcli', 'connection', 'delete', 'id', ssid],
                        timeout=10
                    )

                    # 3a) Créer le profil Wi-Fi explicite
                    r1 = await _run_nmcli([
                        'nmcli', 'connection', 'add',
                        'type', 'wifi',
                        'con-name', ssid,
                        'ifname', 'wlan0',
                        'ssid', ssid
                    ], timeout=10)
                    if r1.returncode != 0:
                        err = r1.stderr.strip() or r1.stdout.strip()
                        logger.error(f"Wi-Fi fallback: création profil échouée: {err}")
                        return _wifi_error_response(ssid,
                            f"Échec création profil: {err}")

                    # 3b) Définir key-mgmt compatible WPA2+WPA3 (SAE)
                    r2 = await _run_nmcli([
                        'nmcli', 'connection', 'modify', ssid,
                        'wifi-sec.key-mgmt', 'wpa-psk sae'
                    ], timeout=10)
                    if r2.returncode != 0:
                        # Fallback : essayer sae seul, puis wpa-psk seul
                        logger.warning("Wi-Fi: 'wpa-psk sae' échoué, tentative 'sae' seul")
                        r2b = await _run_nmcli([
                            'nmcli', 'connection', 'modify', ssid,
                            'wifi-sec.key-mgmt', 'sae'
                        ], timeout=10)
                        if r2b.returncode != 0:
                            logger.warning("Wi-Fi: 'sae' échoué, tentative 'wpa-psk' seul")
                            await _run_nmcli([
                                'nmcli', 'connection', 'modify', ssid,
                                'wifi-sec.key-mgmt', 'wpa-psk'
                            ], timeout=10)

                    # 3c) Définir le mot de passe
                    r3 = await _run_nmcli([
                        'nmcli', 'connection', 'modify', ssid,
                        'wifi-sec.psk', password
                    ], timeout=10)
                    if r3.returncode != 0:
                        err = r3.stderr.strip() or r3.stdout.strip()
                        logger.error(f"Wi-Fi fallback: erreur psk: {err}")
                        return _wifi_error_response(ssid,
                            f"Échec configuration mot de passe: {err}")

                    # 3d) Activer la connexion
                    r4 = await _run_nmcli([
                        'nmcli', 'connection', 'up', 'id', ssid
                    ], timeout=45)
                    if r4.returncode == 0:
                        logger.info(f"Wi-Fi connecté via fallback WPA2/WPA3 à: {ssid}")
                        return {
                            "status": "ok",
                            "success": True,
                            "message": f"Connecté avec succès à {ssid} (WPA2/WPA3)",
                            "ssid": ssid
                        }
                    else:
                        fb_err = r4.stderr.strip() or r4.stdout.strip() or "Erreur inconnue"
                        logger.warning(f"Wi-Fi fallback connexion échouée: {fb_err}")
                        return _wifi_error_response(ssid,
                            f"Échec fallback WPA2/WPA3: {fb_err}")

                # Erreur non-sécurité : retourner l'erreur directe
                clean_msg = _clean_nmcli_error(raw_err, ssid)
                logger.warning(f"Wi-Fi connexion échouée à {ssid}: {clean_msg}")
                return _wifi_error_response(ssid,
                    f"Échec: {clean_msg} ({raw_err[:300]})")

            except subprocess.TimeoutExpired:
                logger.error(f"Wi-Fi connexion timeout pour {ssid}")
                return _wifi_error_response(ssid, "Délai de connexion dépassé (45s)")
            except FileNotFoundError:
                msg = "nmcli non trouvé — NetworkManager est-il installé ?"
                logger.error(f"Wi-Fi connect: {msg}")
                return _wifi_error_response(ssid, msg)
            except Exception as e:
                logger.error(f"Wi-Fi connexion exception: {e}")
                return _wifi_error_response(ssid, str(e))

        def _wifi_error_response(ssid: str, message: str) -> dict:
            """Construit une réponse d'erreur Wi-Fi standardisée."""
            return {
                "status": "error",
                "success": False,
                "message": message,
                "ssid": ssid
            }

        def _clean_nmcli_error(raw_err: str, ssid: str) -> str:
            """Nettoie les messages d'erreur nmcli en messages lisibles."""
            if 'Secrets were required' in raw_err or 'No suitable secret' in raw_err:
                return "Mot de passe incorrect ou requis"
            if 'No network with SSID' in raw_err:
                return f"Réseau '{ssid}' non trouvé"
            if 'Timeout' in raw_err or 'timed out' in raw_err:
                return "Délai de connexion dépassé"
            if 'already active' in raw_err.lower():
                return f"Déjà connecté à {ssid}"
            if 'No such' in raw_err or 'not found' in raw_err:
                return f"Réseau '{ssid}' non trouvé"
            if 'key-mgmt' in raw_err or '802-11-wireless-security' in raw_err:
                return "Incompatibilité sécurité Wi-Fi (WPA2/WPA3)"
            # Retourner l'erreur brute tronquée si aucun cas ne correspond
            return raw_err[:200]

        # === UPLOAD MODÈLE 3D ROV (.glb) ===
        @self.app.post("/api/rov3d/upload")
        async def upload_rov3d_model(file: UploadFile = File(...)):
            """Téléverse un nouveau modèle .glb pour le rendu Rov3D filaire"""
            # Validation extension
            if not file.filename or not file.filename.lower().endswith(('.glb', '.gltf')):
                raise HTTPException(status_code=400, detail="Seuls les fichiers .glb ou .gltf sont acceptés")

            # Validation taille (max 50 Mo)
            MAX_SIZE = 50 * 1024 * 1024
            content = await file.read()
            if len(content) > MAX_SIZE:
                raise HTTPException(status_code=413, detail="Fichier trop volumineux (max 50 Mo)")

            # Sauvegarde
            models_dir = Path("static/models")
            models_dir.mkdir(parents=True, exist_ok=True)
            dest_path = models_dir / "bob_rov_3D.glb"

            with open(dest_path, "wb") as f:
                f.write(content)

            logger.info(f"Modèle 3D téléversé: {file.filename} ({len(content)} octets)")
            return {
                "success": True,
                "filename": file.filename,
                "size": len(content),
                "path": str(dest_path)
            }

        # ============================================================
        # === SCENE 3D — Gestion des modèles et configuration =======
        # ============================================================
        SCENE3D_DIR = Path("static/models/scene")
        SCENE3D_DIR.mkdir(parents=True, exist_ok=True)
        SCENE3D_CONFIG = Path("scene_3d_config.json")

        def _read_scene3d_config() -> dict:
            """Lit scene_3d_config.json, retourne {objects:[]} si inexistant."""
            if SCENE3D_CONFIG.exists():
                try:
                    return json.loads(SCENE3D_CONFIG.read_text(encoding="utf-8"))
                except (json.JSONDecodeError, OSError):
                    pass
            return {"objects": []}

        def _write_scene3d_config(data: dict):
            """Écrit scene_3d_config.json avec flush explicite sur disque."""
            with open(SCENE3D_CONFIG, 'w', encoding='utf-8') as f:
                json.dump(data, f, indent=2, ensure_ascii=False)
                f.flush()
                os.fsync(f.fileno())

        @self.app.post("/api/scene3d/upload")
        async def upload_scene3d_model(file: UploadFile = File(...)):
            """Téléverse un modèle .glb/.gltf pour la scène 3D Mapping."""
            # Validation extension
            if not file.filename or not file.filename.lower().endswith(('.glb', '.gltf')):
                raise HTTPException(status_code=400, detail="Seuls les fichiers .glb ou .gltf sont acceptés")

            # Validation taille (max 50 Mo)
            MAX_SIZE = 50 * 1024 * 1024
            content = await file.read()
            if len(content) > MAX_SIZE:
                raise HTTPException(status_code=413, detail="Fichier trop volumineux (max 50 Mo)")

            # Sauvegarde dans static/models/scene/
            dest_path = SCENE3D_DIR / file.filename
            if dest_path.exists():
                # Suffixe timestamp si le fichier existe déjà
                stem = Path(file.filename).stem
                ext = Path(file.filename).suffix
                dest_path = SCENE3D_DIR / f"{stem}_{int(time.time())}{ext}"

            with open(dest_path, "wb") as f:
                f.write(content)

            logger.info(f"Modèle Scene 3D téléversé: {dest_path.name} ({len(content)} octets)")
            return {
                "success": True,
                "filename": dest_path.name,
                "size": len(content)
            }

        @self.app.get("/api/scene3d/models")
        async def list_scene3d_models():
            """Liste les fichiers .glb/.gltf disponibles dans la scène 3D."""
            models = []
            for f in SCENE3D_DIR.iterdir():
                if f.suffix.lower() in ('.glb', '.gltf'):
                    models.append({
                        "name": f.name,
                        "size": f.stat().st_size,
                        "url": f"/static/models/scene/{f.name}"
                    })
            return {"models": models}

        @self.app.delete("/api/scene3d/models/{filename}")
        async def delete_scene3d_model(filename: str):
            """Supprime un modèle de la scène 3D."""
            file_path = SCENE3D_DIR / filename
            if not file_path.exists():
                raise HTTPException(status_code=404, detail=f"Fichier '{filename}' introuvable")
            file_path.unlink()
            logger.info(f"Modèle Scene 3D supprimé: {filename}")
            return {"success": True, "filename": filename}

        @self.app.get("/api/scene3d/config")
        async def get_scene3d_config():
            """Retourne la configuration de la scène 3D."""
            return _read_scene3d_config()

        @self.app.post("/api/scene3d/config")
        async def save_scene3d_config(request: Request):
            """Enregistre la configuration de la scène 3D."""
            data = await request.json()
            _write_scene3d_config(data)
            logger.info("Configuration Scene 3D sauvegardée")
            return {"status": "ok"}

        @self.app.post("/api/scene3d/config/reset")
        async def reset_scene3d_config():
            """Réinitialise la configuration de la scène 3D."""
            empty_config = {"objects": []}
            _write_scene3d_config(empty_config)
            logger.info("Configuration Scene 3D réinitialisée")
            return {"status": "ok", "objects": []}

    def _convert_instructions_to_steps(self, instructions: list) -> list:
        """
        Convertit le format 'liste d'instructions' (frontend) en format 'steps' (scenario_manager).
        On stocke aussi les instructions originales pour pouvoir recharger fidèlement.
        """
        steps = []
        current_time = 0.0
        for instr in instructions:
            action = instr.get('action', 'wait')
            valeur = instr.get('valeur', 0)
            duree = instr.get('duree', 5)

            if action == 'wait':
                # wait = time gap, on avance juste le temps
                current_time += duree
                continue
            elif action == 'loop':
                # loop géré par le flag 'loop'
                continue

            steps.append({'time': current_time, 'action': action, 'value': valeur})
            current_time += duree
            steps.append({'time': current_time, 'action': action, 'value': valeur})

        return steps

    def _convert_steps_to_instructions(self, steps: list) -> list:
        """
        Convertit le format 'steps' (scenario_manager) en format 'instructions' (frontend).
        """
        if not steps:
            return []

        instructions = []
        prev_time = 0
        prev_action = None
        prev_value = None

        i = 0
        while i < len(steps):
            step = steps[i]
            time_val = step.get('time', 0)
            action = step.get('action', 'heading')
            value = step.get('value', 0)

            # Calculer la durée depuis le step précédent
            duree = time_val - prev_time if prev_time is not None else 0

            # Si c'est un step de transition (début)
            if i + 1 < len(steps) and steps[i + 1].get('action') == action:
                next_step = steps[i + 1]
                next_time = next_step.get('time', time_val)
                duree = next_time - time_val
                instructions.append({
                    'action': action,
                    'valeur': next_step.get('value', value),
                    'duree': max(duree, 1)
                })
                prev_time = next_time
                i += 2
            else:
                if duree > 0 and prev_action is not None:
                    pass  # déjà traité
                instructions.append({
                    'action': action,
                    'valeur': value,
                    'duree': max(duree, 1)
                })
                prev_time = time_val
                i += 1

            prev_action = action
            prev_value = value

        return instructions

    def _setup_websocket(self):
        """Configure le endpoint WebSocket pour la télémétrie temps réel"""

        @self.app.websocket("/ws/telemetry")
        async def websocket_telemetry(websocket: WebSocket):
            await websocket.accept()
            async with self._ws_lock:
                self.active_websockets.append(websocket)
            logger.info(f"WebSocket connecté ({len(self.active_websockets)} client(s))")

            try:
                while True:
                    data = self.sensor_manager.get_data()
                    # Structure imbriquée imu/environment/sensor_status (GY-91)
                    data.update(self.sensor_manager.get_structured_data())
                    data['fps'] = self.video_streamer.get_fps()
                    data['armed'] = self.rov_state['armed']
                    data['light'] = self.rov_state['light']
                    data['camera'] = self.video_streamer.is_camera_connected()
                    data['simulation'] = self.sensor_manager.is_simulation()
                    data['esp32_connected'] = self.i2c_controller.is_connected()
                    # État des 8 propulseurs (ordre officiel M1..M8 → ch0..7)
                    data['motors'] = self.motor_manager.get_motor_data()
                    # Consignes 6DOF courantes (pour le visualiseur 3D)
                    data['dof'] = self.action_dispatcher.get_dof_state()
                    data['low_light'] = self.video_streamer._low_light_detected if hasattr(self.video_streamer, '_low_light_detected') else False
                    data['timestamp'] = time.time()

                    await websocket.send_json(data)

                    try:
                        msg = await asyncio.wait_for(websocket.receive_json(), timeout=0.04)
                        await self._handle_ws_command(msg, websocket)
                    except asyncio.TimeoutError:
                        pass

            except WebSocketDisconnect:
                logger.info("WebSocket déconnecté (normal)")
            except Exception as e:
                logger.error(f"Erreur WebSocket: {e}")
            finally:
                async with self._ws_lock:
                    if websocket in self.active_websockets:
                        self.active_websockets.remove(websocket)
                logger.info(f"WebSocket retiré ({len(self.active_websockets)} client(s))")

    async def _handle_ws_command(self, msg: Dict[str, Any], ws: WebSocket):
        """Traite les commandes reçues via WebSocket"""
        cmd = msg.get('command', '').lower()
        try:
            if cmd == 'arm':
                self.rov_state['armed'] = True
                self.sensor_manager.set_data('armed', True)
            elif cmd == 'disarm':
                self.rov_state['armed'] = False
                self.sensor_manager.set_data('armed', False)
            elif cmd == 'light':
                value = max(0, min(100, int(msg.get('value', 0))))
                self.rov_state['light'] = value
            elif cmd == 'simulation':
                enabled = msg.get('value', True)
                self.sensor_manager.set_simulation(enabled)
            elif cmd == 'move':
                # Vérifier l'état armé côté backend (sécurité)
                if not self.rov_state.get('armed', False):
                    # Pas armé : envoyer une trame zéro pour couper les moteurs
                    self.action_dispatcher.execute_move(0, 0, 0, 0, 0, 0)
                else:
                    surge = msg.get('forward', 0) / 100.0
                    sway = msg.get('lateral', 0) / 100.0
                    heave = msg.get('vertical', 0) / 100.0
                    yaw = msg.get('yaw', 0) / 100.0
                    roll = msg.get('roll', 0) / 100.0
                    pitch = msg.get('pitch', 0) / 100.0
                    self.action_dispatcher.execute_move(surge, sway, yaw, heave, roll, pitch)
            elif cmd == 'gamepad_input':
                button = msg.get('button')
                function = msg.get('function')
                if not function:
                    mapping = self.gamepad_manager.get_mapping()
                    buttons_map = mapping.get('buttons', {})
                    if button and button in buttons_map:
                        function = buttons_map[button].get('function')
                if function:
                    result = self.action_dispatcher.execute(function, msg.get('value', 1))
                    await ws.send_json({"type": "action_result", "function": function, **result})
        except Exception as e:
            logger.warning(f"Commande WebSocket invalide: {msg} — {e}")

    def run(self, host: str = "0.0.0.0", port: int = 8080):
        """Lance le serveur avec uvicorn"""
        import uvicorn
        log_level = self.config.get('SERVER', 'log_level', 'INFO')
        if isinstance(log_level, str):
            log_level = log_level.lower()
        else:
            log_level = 'info'

        logger.info(f"Démarrage sur http://{host}:{port}")
        uvicorn.run(
            self.app, host=host, port=port,
            log_level=log_level, access_log=False
        )
