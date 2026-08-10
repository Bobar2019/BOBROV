"""
Module de streaming vidéo pour Cockpit-Lite ROV.
Capture V4L2/OpenCV, traitement OSD avancé et diffusion MJPEG basse latence.
"""

from __future__ import annotations

import threading
import time
import math
import os
import logging
import subprocess
import shutil
from collections import deque
from queue import Queue, Empty
from typing import Optional, Dict, Any
from datetime import datetime
from pathlib import Path

# OpenCV — optionnel pour permettre le démarrage sans caméra
try:
    import cv2
    import numpy as np
    HAS_CV2 = True
except ImportError:
    HAS_CV2 = False
    cv2 = None
    np = None

logger = logging.getLogger(__name__)

if not HAS_CV2:
    logger.warning("OpenCV (cv2) non disponible — le flux vidéo sera désactivé")


class VideoStreamer:
    """
    Gestionnaire de flux vidéo avec incrustation OSD complète.
    - Capture via OpenCV avec backend V4L2 pour latence minimale
    - OSD : profondeur, température, cap, batterie, FPS, horizon artificiel
    - Reconnexion automatique en cas de déconnexion caméra
    """

    def __init__(self, config: Dict[str, Any], pip_config: Optional[Dict[str, Any]] = None, osd_config: Optional[Dict[str, Any]] = None, recording_config: Optional[Dict[str, Any]] = None):
        self.config = config
        self.pip_config = pip_config or {}
        # Config OSD live (mise à jour en temps réel via update_osd_config)
        self.osd_config = osd_config or {}
        # Config enregistrement séparée (output_dir, video_codec, etc.)
        self.recording_config = recording_config or {}
        # Cache des couleurs OSD pré-calculées (BGR) — mis à jour via _cache_osd_colors()
        self._color_primary = (0, 255, 0)
        self._color_horizon = (0, 255, 0)
        self._color_depth = (0, 255, 0)
        self._color_temperature = (0, 255, 0)
        self._color_compass = (255, 255, 255)
        self._color_battery = (0, 255, 0)
        self._color_fps = (255, 255, 255)
        self._color_wing = (0, 255, 255)
        self._cache_osd_colors()
        self.cap: Optional[cv2.VideoCapture] = None
        self.pip_cap: Optional[cv2.VideoCapture] = None
        self.running = False
        self.thread: Optional[threading.Thread] = None
        self.last_frame: Optional[np.ndarray] = None
        self._frame_bytes: Optional[bytes] = None
        self.frame_lock = threading.Lock()
        self.fps = 0
        self.frame_count = 0
        self.last_fps_time = time.time()
        self.camera_connected = False
        self.pip_connected = False
        self._reconnect_delay = 1.0
        self._max_reconnect_delay = 10.0

        # Amortissement roulis/tangage (lissage EMA)
        self._smoothed_roll: Optional[float] = None
        self._smoothed_pitch: Optional[float] = None
        self._last_damping: int = 1

        # Données de télémétrie pour l'OSD
        self.telemetry_data: Dict[str, float] = {
            'depth': 0.0,
            'temperature': 20.0,
            'heading': 0.0,
            'battery': 100.0,
            'roll': 0.0,
            'pitch': 0.0,
            'armed': False
        }

        # Enregistrement vidéo / photo
        self._recording = False
        self._video_writer: Optional[Any] = None
        self._recording_width: int = 1280
        self._recording_height: int = 720
        self._recording_with_osd: bool = True
        self._recording_frame_count: int = 0  # Compteur de frames écrites
        self._recording_target_fps: int = 15  # FPS cible
        self._recording_thread: Optional[threading.Thread] = None
        self._recording_queue: Queue = Queue(maxsize=4)  # Buffer de frames pour le thread recording
        self._recording_stop_event = threading.Event()
        # Thread OSD dédié (découplé de la capture pour ne pas ralentir le flux)
        self._osd_queue: Queue = Queue(maxsize=2)
        self._osd_thread: Optional[threading.Thread] = None
        self._osd_stop_event = threading.Event()
        self._last_osd_frame: Optional[np.ndarray] = None
        # Mesure FPS glissante et détection faible lumière
        self._fps_timestamps: deque = deque(maxlen=20)
        self._low_light_detected: bool = False
        self._photo_requested = False
        self._photo_resolution: Optional[str] = None
        self._photo_with_osd: bool = True
        self._raw_frame: Optional[np.ndarray] = None  # Frame brute sans OSD
        output_dir = self.recording_config.get('output_dir', 'recordings')
        self._recordings_dir = str(output_dir)
        if not os.path.isabs(self._recordings_dir):
            self._recordings_dir = str(Path(self._recordings_dir).resolve())
        os.makedirs(self._recordings_dir, exist_ok=True)
        self._recording_file: Optional[str] = None
        self._recording_start_time: float = 0.0
        # Fichiers en cours de conversion ffmpeg (mp4v → H.264)
        self._converting_files: set = set()
        self._converting_lock = threading.Lock()
        # Flag de swap caméra (pause le capture loop pendant l'inversion)
        self._swap_in_progress = False
        # Échelle OSD pour le mode lunette (1.0 = normal)
        self._osd_scale = 1.0
        # Gestionnaire de moteurs (injecté via set_motor_manager)
        self.motor_manager = None

    def set_motor_manager(self, manager):
        """Connecte le gestionnaire de moteurs pour l'affichage OSD"""
        self.motor_manager = manager

    def update_osd_config(self, new_config: Dict[str, Any]):
        """Met à jour la configuration OSD en temps réel (appelé depuis l'API)"""
        self.osd_config.update(new_config)
        self._cache_osd_colors()
        logger.debug(f"OSD config mise à jour: {list(new_config.keys())}")

    def _osd(self, key: str, default=None):
        """Raccourci pour lire un paramètre OSD (avec fallback)"""
        return self.osd_config.get(key, default)

    def _osd_int(self, key: str, default: int = 100) -> int:
        """Lit un paramètre OSD en tant qu'entier (gère str/int/bool)"""
        val = self._osd(key, default)
        if isinstance(val, str):
            try:
                return int(val)
            except ValueError:
                return default
        return int(val)

    def _cache_osd_colors(self):
        """Pré-calcule tous les tuples BGR depuis la config OSD (appelé à l'init et lors des MàJ API).
        Aucun appel _hex_to_bgr dans les fonctions de dessin par-frame."""
        self._color_primary = self._hex_to_bgr(self._osd('primary_color', '#00FF00'))
        self._color_horizon = self._hex_to_bgr(self._osd('horizon_color', '#00FF88'))
        self._color_depth = self._hex_to_bgr(self._osd('depth_color', '#00AAFF'))
        self._color_temperature = self._hex_to_bgr(self._osd('temperature_color', '#FFAA00'))
        self._color_compass = self._hex_to_bgr(self._osd('compass_color', '#FFFFFF'))
        self._color_battery = self._hex_to_bgr(self._osd('battery_color', '#00CC44'))
        self._color_fps = self._hex_to_bgr(self._osd('fps_color', '#FFFFFF'))
        self._color_wing = self._hex_to_bgr(self._osd('horizon_wing_color', '#FFFF00'))

    def start(self) -> bool:
        """Démarre la capture vidéo dans un thread dédié"""
        if self.running:
            return True

        # Réparer les enregistrements orphelins (serveur crashé pendant enregistrement)
        self._recover_orphaned_recordings()

        self.running = True
        self.thread = threading.Thread(target=self._capture_loop, daemon=True, name="VideoThread")
        self.thread.start()
        # Démarrer le thread OSD dédié (rendu + encodage JPEG découplé)
        self._osd_stop_event.clear()
        self._osd_thread = threading.Thread(target=self._osd_display_loop, daemon=True, name="OSDThread")
        self._osd_thread.start()
        logger.info("Threads vidéo et OSD démarrés")
        return True

    # ==========================================================
    # ENREGISTREMENT VIDÉO / PHOTO
    # ==========================================================

    def start_recording(self, resolution: Optional[str] = None, with_osd: Optional[bool] = None) -> Dict[str, Any]:
        """Démarre l'enregistrement vidéo. Retourne infos du fichier."""
        if not HAS_CV2:
            return {"status": "error", "message": "OpenCV non disponible"}
        if self._recording:
            return {"status": "error", "message": "Enregistrement déjà en cours"}

        # Résolution
        if resolution:
            try:
                rw, rh = map(int, resolution.lower().split('x'))
            except ValueError:
                rw, rh = 1280, 720
        else:
            rw = int(self.config.get('width', 1280))
            rh = int(self.config.get('height', 720))

        # Validation défensive : résolution invalide → fallback
        if rw <= 0 or rh <= 0:
            logger.warning(f"Résolution d'enregistrement invalide ({rw}x{rh}), fallback 1280x720")
            rw, rh = 1280, 720

        # Stocker la résolution pour la boucle de capture
        self._recording_width = rw
        self._recording_height = rh

        # Flag OSD pour l'enregistrement
        if with_osd is not None:
            self._recording_with_osd = with_osd
        else:
            self._recording_with_osd = self.recording_config.get('video_with_osd', True)

        # Codec et nom de fichier — format MP4 compatible navigateurs
        codec_str = str(self.recording_config.get('video_codec', 'mp4v')).upper()
        # Priorité : codec configuré → mp4v → XVID → MJPG (tous testés OK en .mp4)
        codec_candidates = [codec_str]
        for fallback in ['mp4v', 'XVID', 'MJPG']:
            if fallback not in codec_candidates:
                codec_candidates.append(fallback)

        timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
        filename = f"VIDEO_{timestamp}.mp4"
        filepath = os.path.join(self._recordings_dir, filename)

        # FPS adaptatif : utiliser le FPS réel mesuré (adapté à l'éclairage)
        config_fps = int(self.recording_config.get('video_fps', 15))
        measured_fps = self.fps if self.fps > 0 else config_fps
        target_fps = max(5, min(measured_fps, 30))  # Borner entre 5 et 30fps
        self._recording_target_fps = target_fps

        writer_opened = False
        last_error = None
        for candidate in codec_candidates:
            try:
                fourcc = cv2.VideoWriter_fourcc(*candidate)
                self._video_writer = cv2.VideoWriter(filepath, fourcc, target_fps, (rw, rh))
                if self._video_writer.isOpened():
                    writer_opened = True
                    logger.info(f"Codec vidéo utilisé: {candidate}")
                    break
                else:
                    self._video_writer.release()
                    self._video_writer = None
            except Exception as e:
                last_error = str(e)
                continue

        if not writer_opened:
            self._video_writer = None
            err_msg = f"Impossible d'ouvrir le fichier vidéo (essayé: {', '.join(codec_candidates)})"
            if last_error:
                err_msg += f" — {last_error}"
            return {"status": "error", "message": err_msg}

        self._recording = True
        self._recording_file = filepath
        self._recording_start_time = time.time()
        self._recording_frame_count = 0
        # Vider la queue de recording
        while not self._recording_queue.empty():
            try:
                self._recording_queue.get_nowait()
            except Exception:
                break
        self._recording_stop_event.clear()

        # Démarrer le thread d'écriture vidéo (découplé de la boucle de capture)
        self._recording_thread = threading.Thread(
            target=self._recording_write_loop,
            daemon=True, name="RecWriteThread"
        )
        self._recording_thread.start()

        logger.info(f"Enregistrement démarré: {filename} ({rw}x{rh} @ {target_fps}fps, OSD={self._recording_with_osd})")
        return {
            "status": "ok",
            "filename": filename,
            "resolution": f"{rw}x{rh}",
            "fps": target_fps,
            "with_osd": self._recording_with_osd
        }

    def stop_recording(self) -> Dict[str, Any]:
        """Arrête l'enregistrement vidéo et lance la conversion H.264 en arrière-plan."""
        if not self._recording:
            return {"status": "error", "message": "Aucun enregistrement en cours"}

        duration = time.time() - self._recording_start_time
        filename = self._recording_file or ""
        frame_count = self._recording_frame_count

        # FPS réel (pour info log)
        actual_fps = frame_count / duration if duration > 0 else 15
        actual_fps = max(1, min(actual_fps, 60))

        # Signaler au thread d'écriture de s'arrêter et attendre qu'il finisse
        self._recording = False
        self._recording_stop_event.set()
        if self._recording_thread is not None:
            self._recording_thread.join(timeout=3.0)
            self._recording_thread = None

        if self._video_writer is not None:
            try:
                self._video_writer.release()
            except Exception as e:
                logger.warning(f"Erreur lors de la libération du writer vidéo: {e}")
            self._video_writer = None

        file_size = os.path.getsize(filename) if filename and os.path.exists(filename) else 0
        logger.info(f"Enregistrement arrêté: {os.path.basename(filename)} ({duration:.1f}s, {frame_count} frames, {actual_fps:.1f}fps réel, {file_size/1024/1024:.1f}Mo)")
        logger.debug(f"Capture loop toujours active: running={self.running}, camera={self.camera_connected}")

        # Lancer la conversion mp4v → H.264 en arrière-plan pour compatibilité navigateurs
        if filename and os.path.exists(filename) and file_size > 0:
            t = threading.Thread(
                target=self._postprocess_video_h264,
                args=(filename, actual_fps),
                daemon=True,
                name="FFmpegConvert"
            )
            t.start()

        return {
            "status": "ok",
            "filename": os.path.basename(filename),
            "duration": round(duration, 1),
            "size_mb": round(file_size / 1024 / 1024, 2)
        }

    def _recording_write_loop(self):
        """
        Thread dédié à l'écriture vidéo.
        Reçoit des frames brutes depuis la boucle de capture via _recording_queue.
        Écrit directement chaque frame reçue (pas de duplication).
        Le FPS du fichier est géré par le VideoWriter (initialisé au FPS mesuré).
        """
        rw = self._recording_width
        rh = self._recording_height
        logger.debug(f"Recording write thread démarré (target={self._recording_target_fps}fps, {rw}x{rh})")

        while not self._recording_stop_event.is_set():
            try:
                frame = self._recording_queue.get(timeout=0.1)
            except Empty:
                continue

            try:
                # Redimensionner si nécessaire
                fh, fw = frame.shape[:2]
                if rw > 0 and rh > 0 and (fw != rw or fh != rh):
                    rec_frame = cv2.resize(frame, (rw, rh))
                else:
                    rec_frame = frame

                if self._video_writer is not None:
                    self._video_writer.write(rec_frame)
                    self._recording_frame_count += 1
            except Exception as e:
                logger.error(f"Erreur écriture vidéo (thread): {e}")

        # Vider la queue restante avant de quitter
        while True:
            try:
                frame = self._recording_queue.get_nowait()
                fh, fw = frame.shape[:2]
                if rw > 0 and rh > 0 and (fw != rw or fh != rh):
                    rec_frame = cv2.resize(frame, (rw, rh))
                else:
                    rec_frame = frame
                if self._video_writer is not None:
                    self._video_writer.write(rec_frame)
                    self._recording_frame_count += 1
            except Exception:
                break

        logger.debug(f"Recording write thread arrêté ({self._recording_frame_count} frames écrites)")

    def _postprocess_video_h264(self, filepath: str, actual_fps: float = 15.0):
        """
        Convertit un fichier vidéo mp4v (MPEG-4 Part 2) en H.264 via ffmpeg
        pour compatibilité avec les navigateurs web (Safari, Chrome, Firefox).
        -r actual_fps : corrige le framerate pour vitesse de lecture réelle
        -preset ultrafast : vitesse maximale sur Raspberry Pi
        -movflags +faststart : déplace le moov atom au début pour le streaming
        Exécuté dans un thread dédié pour ne pas bloquer l'interface.
        """
        basename = os.path.basename(filepath)
        tmp_path = filepath + ".h264tmp.mp4"

        with self._converting_lock:
            self._converting_files.add(basename)

        try:
            logger.info(f"[ffmpeg] Conversion H.264 démarrée: {basename}")
            start_time = time.time()

            cmd = [
                "ffmpeg", "-y",
                "-r", str(int(actual_fps)),  # FPS réel mesuré pour vitesse de lecture correcte
                "-i", filepath,
                "-c:v", "libx264",
                "-preset", "ultrafast",
                "-crf", "23",
                "-movflags", "+faststart",
                "-an",
                tmp_path
            ]

            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=300  # 5 min max
            )

            if result.returncode == 0 and os.path.exists(tmp_path):
                # Remplacer le fichier original par la version H.264
                shutil.move(tmp_path, filepath)
                elapsed = time.time() - start_time
                new_size = os.path.getsize(filepath) / 1024 / 1024
                logger.info(f"[ffmpeg] Conversion H.264 terminée: {basename} ({elapsed:.1f}s, {new_size:.1f}Mo)")
            else:
                # Échec — garder le fichier original
                if os.path.exists(tmp_path):
                    os.remove(tmp_path)
                logger.warning(f"[ffmpeg] Conversion échouée (rc={result.returncode}), fichier original conservé: {basename}")
                if result.stderr:
                    logger.debug(f"[ffmpeg] stderr: {result.stderr[:500]}")

        except subprocess.TimeoutExpired:
            logger.warning(f"[ffmpeg] Conversion timeout (>5min), fichier original conservé: {basename}")
            if os.path.exists(tmp_path):
                try:
                    os.remove(tmp_path)
                except OSError:
                    pass
        except Exception as e:
            logger.warning(f"[ffmpeg] Erreur conversion: {e}")
            if os.path.exists(tmp_path):
                try:
                    os.remove(tmp_path)
                except OSError:
                    pass
        finally:
            with self._converting_lock:
                self._converting_files.discard(basename)

    def is_file_converting(self, filename: str) -> bool:
        """Vérifie si un fichier est en cours de conversion ffmpeg."""
        with self._converting_lock:
            return filename in self._converting_files

    def take_photo(self, resolution: Optional[str] = None, with_osd: Optional[bool] = None) -> Dict[str, Any]:
        """Demande une capture photo au prochain cycle."""
        if not HAS_CV2:
            return {"status": "error", "message": "OpenCV non disponible"}
        self._photo_requested = True
        # Stocker la résolution demandée pour la prise
        self._photo_resolution = resolution
        if with_osd is not None:
            self._photo_with_osd = with_osd
        else:
            self._photo_with_osd = self.recording_config.get('photo_with_osd', True)
        return {"status": "ok", "message": "Photo demandée"}

    def take_pip_photo(self, resolution: Optional[str] = None, with_osd: Optional[bool] = None) -> Dict[str, Any]:
        """Prend une photo directement depuis la caméra PiP (cam2), sans passer par la boucle de capture."""
        if not HAS_CV2:
            return {"status": "error", "message": "OpenCV non disponible"}
        if not self.pip_connected or self.pip_cap is None:
            return {"status": "error", "message": "Caméra PiP non connectée"}

        ret, frame = self.pip_cap.read()
        if not ret or frame is None:
            return {"status": "error", "message": "Impossible de lire la frame PiP"}

        # Résolution
        if resolution:
            try:
                prw, prh = map(int, resolution.lower().split('x'))
                frame = cv2.resize(frame, (prw, prh))
            except Exception:
                pass

        # OSD optionnel
        use_osd = with_osd if with_osd is not None else self.recording_config.get('photo_with_osd', True)
        if use_osd and self.config.get('osd_enabled', True):
            try:
                frame = self._apply_osd(frame)
            except Exception as osd_err:
                logger.warning(f"Erreur OSD photo PiP: {osd_err}")

        timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
        photo_name = f"PHOTO_PIP_{timestamp}.jpg"
        photo_path = os.path.join(self._recordings_dir, photo_name)
        quality = int(self.recording_config.get('photo_quality', 95))
        cv2.imwrite(photo_path, frame, [cv2.IMWRITE_JPEG_QUALITY, quality])
        logger.info(f"Photo PiP sauvegardée: {photo_name} (OSD={use_osd})")
        return {"status": "ok", "message": f"Photo PiP: {photo_name}", "filename": photo_name}

    def is_recording(self) -> bool:
        return self._recording

    def get_recording_info(self) -> Dict[str, Any]:
        if self._recording:
            duration = time.time() - self._recording_start_time
            return {
                "recording": True,
                "filename": os.path.basename(self._recording_file or ""),
                "duration": round(duration, 1),
                "with_osd": self._recording_with_osd
            }
        return {"recording": False}

    def get_recordings_list(self) -> list:
        """Liste les fichiers enregistrés (vidéos + photos) avec statut de conversion."""
        files = []
        if not os.path.isdir(self._recordings_dir):
            return files
        with self._converting_lock:
            converting_set = set(self._converting_files)
        for fname in sorted(os.listdir(self._recordings_dir), reverse=True):
            # Ignorer les fichiers temporaires de conversion ffmpeg
            if fname.endswith('.h264tmp.mp4'):
                continue
            fpath = os.path.join(self._recordings_dir, fname)
            if os.path.isfile(fpath):
                size_mb = os.path.getsize(fpath) / (1024 * 1024)
                mtime = datetime.fromtimestamp(os.path.getmtime(fpath)).isoformat()
                ftype = "video" if fname.startswith("VIDEO_") else "photo"
                files.append({
                    "filename": fname,
                    "type": ftype,
                    "size_mb": round(size_mb, 2),
                    "date": mtime,
                    "converting": fname in converting_set
                })
        return files

    def stop(self):
        """Arrête la capture vidéo proprement"""
        # Arrêter l'enregistrement en cours AVANT de couper les threads
        if self._recording:
            self.stop_recording()
        # Arrêter le thread OSD
        self._osd_stop_event.set()
        if self._osd_thread:
            self._osd_thread.join(timeout=2.0)
            self._osd_thread = None
        self.running = False
        if self.thread:
            self.thread.join(timeout=3.0)
        self._release_camera()
        self._release_pip_camera()
        logger.info("Stream vidéo arrêté")

    def _recover_orphaned_recordings(self):
        """
        Détecte et supprime les fichiers MP4 corrompus (sans moov atom)
        causés par un arrêt brutal du serveur pendant un enregistrement.
        """
        if not os.path.isdir(self._recordings_dir):
            return
        import subprocess
        for fname in os.listdir(self._recordings_dir):
            if not fname.startswith("VIDEO_") or not fname.endswith(".mp4"):
                continue
            fpath = os.path.join(self._recordings_dir, fname)
            if not os.path.isfile(fpath) or os.path.getsize(fpath) == 0:
                continue
            try:
                result = subprocess.run(
                    ["ffprobe", "-v", "error", "-select_streams", "v:0",
                     "-show_entries", "stream=codec_name", "-of", "csv=p=0", fpath],
                    capture_output=True, text=True, timeout=10
                )
                if result.returncode != 0 or "moov atom not found" in result.stderr:
                    logger.warning(f"Fichier corrompu détecté (moov atom manquant): {fname} — suppression")
                    os.remove(fpath)
            except Exception as e:
                logger.debug(f"Vérification ignorée pour {fname}: {e}")

    def _open_camera(self) -> bool:
        """Ouvre la caméra avec le backend V4L2 pour latence minimale"""
        if not HAS_CV2:
            logger.warning("OpenCV non disponible, caméra désactivée")
            return False

        device = self.config.get('device', '/dev/video0')
        width = self.config.get('width', 1280)
        height = self.config.get('height', 720)
        fps = self.config.get('fps', 30)
        fmt = self.config.get('format', 'MJPEG').upper()

        try:
            # Utiliser V4L2 backend pour latence minimale sur Linux
            self.cap = cv2.VideoCapture(device, cv2.CAP_V4L2)

            if not self.cap.isOpened():
                # Fallback sur le backend par défaut
                logger.warning("V4L2 échoué, tentative avec backend par défaut")
                self.cap = cv2.VideoCapture(device)

            if not self.cap.isOpened():
                logger.error(f"Impossible d'ouvrir la caméra {device}")
                return False

            # Configurer les paramètres de capture
            self.cap.set(cv2.CAP_PROP_FRAME_WIDTH, width)
            self.cap.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
            self.cap.set(cv2.CAP_PROP_FPS, fps)

            # Préférer MJPEG natif pour minimiser la charge CPU
            if fmt == 'MJPEG':
                self.cap.set(cv2.CAP_PROP_FOURCC,
                             cv2.VideoWriter_fourcc(*'MJPG'))

            # Buffer minimal pour réduire la latence
            self.cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)

            # Vérifier les paramètres réels
            actual_w = int(self.cap.get(cv2.CAP_PROP_FRAME_WIDTH))
            actual_h = int(self.cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
            actual_fps = self.cap.get(cv2.CAP_PROP_FPS)
            logger.info(f"Caméra ouverte: {device} ({actual_w}x{actual_h}@{actual_fps:.0f}fps, format={fmt})")

            self.camera_connected = True
            self._reconnect_delay = 1.0  # Réinitialiser le délai
            return True

        except Exception as e:
            logger.error(f"Erreur ouverture caméra: {e}")
            self.camera_connected = False
            return False

    def _release_camera(self):
        """Libère la caméra principale proprement"""
        if self.cap:
            self.cap.release()
            self.cap = None
        self.camera_connected = False

    def _release_pip_camera(self):
        """Libère la caméra PiP"""
        if self.pip_cap:
            self.pip_cap.release()
            self.pip_cap = None
        self.pip_connected = False

    def swap_cameras(self, main_device: str, pip_device: str) -> bool:
        """Inverse les caméras principale et PiP de manière thread-safe."""
        self._swap_in_progress = True
        try:
            # Mettre à jour le device principal
            self.config['device'] = pip_device

            # Relâcher les deux caméras
            self._release_camera()
            self._release_pip_camera()

            # Mettre à jour la config PiP
            if hasattr(self, '_pip_config_ref'):
                self._pip_config_ref['device'] = main_device
            self.pip_config['device'] = main_device

            # Rouvrir la caméra principale (avec le nouveau device)
            self._open_camera()

            # Rouvrir le PiP (avec le nouveau device)
            pip_enabled = self.pip_config.get('pip_enabled', False) or self.pip_config.get('enabled', False)
            if pip_enabled:
                self._open_pip_camera()

            logger.info(f"Caméras inversées: principale={pip_device}, PiP={main_device}")
            return True
        except Exception as e:
            logger.error(f"Erreur swap caméras: {e}")
            return False
        finally:
            self._swap_in_progress = False

    def activate_pip(self):
        """Active le PiP à la volée (appelé depuis l'API)"""
        if self.pip_connected:
            logger.info("PiP déjà actif")
            return True
        return self._open_pip_camera()

    def deactivate_pip(self):
        """Désactive le PiP à la volée"""
        self._release_pip_camera()
        logger.info("PiP désactivé")

    def _open_pip_camera(self) -> bool:
        """Ouvre la caméra secondaire pour le Picture-in-Picture"""
        if not HAS_CV2 or not self.pip_config.get('enabled', False):
            return False
        if not self.pip_config.get('pip_enabled', False):
            return False

        device = self.pip_config.get('device', '/dev/video2')
        try:
            self.pip_cap = cv2.VideoCapture(device)
            if not self.pip_cap.isOpened():
                return False
            w = int(self.pip_config.get('width', 640))
            h = int(self.pip_config.get('height', 480))
            self.pip_cap.set(cv2.CAP_PROP_FRAME_WIDTH, w)
            self.pip_cap.set(cv2.CAP_PROP_FRAME_HEIGHT, h)
            self.pip_cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
            self.pip_connected = True
            logger.info(f"Caméra PiP ouverte: {device}")
            return True
        except Exception as e:
            logger.warning(f"Erreur caméra PiP: {e}")
            self.pip_connected = False
            return False

    def _apply_pip(self, frame):
        """Applique le Picture-in-Picture sur la frame principale"""
        if not HAS_CV2 or not self.pip_connected or self.pip_cap is None:
            return frame

        ret, pip_frame = self.pip_cap.read()
        if not ret or pip_frame is None:
            return frame

        h_main, w_main = frame.shape[:2]
        position = self.pip_config.get('pip_position', 'top-right')
        size_str = self.pip_config.get('pip_size', 'small')

        # Taille du PiP en proportion de la frame principale
        size_map = {'small': 0.2, 'medium': 0.3, 'large': 0.4}
        ratio = size_map.get(size_str, 0.2)
        pip_w = int(w_main * ratio)
        pip_h = int(pip_w * pip_frame.shape[0] / pip_frame.shape[1])

        # Redimensionner la frame PiP
        pip_resized = cv2.resize(pip_frame, (pip_w, pip_h))

        # Calculer la position
        margin = 10
        if position == 'top-left':
            x, y = margin, margin
        elif position == 'top-right':
            x, y = w_main - pip_w - margin, margin
        elif position == 'bottom-left':
            x, y = margin, h_main - pip_h - margin
        elif position == 'bottom-right':
            x, y = w_main - pip_w - margin, h_main - pip_h - margin
        else:
            x, y = w_main - pip_w - margin, margin

        # S'assurer qu'on ne déborde pas
        y = max(0, min(y, h_main - pip_h))
        x = max(0, min(x, w_main - pip_w))

        # Incruster avec bordure
        cv2.rectangle(frame, (x - 2, y - 2), (x + pip_w + 2, y + pip_h + 2), (255, 255, 255), 2)
        frame[y:y + pip_h, x:x + pip_w] = pip_resized

        return frame

    def _take_photo(self, frame):
        """Sauvegarde une photo à partir de la frame fournie (avec ou sans OSD selon contexte)"""
        try:
            self._photo_requested = False
            timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
            photo_name = f"PHOTO_{timestamp}.jpg"
            photo_path = os.path.join(self._recordings_dir, photo_name)
            # Appliquer la résolution photo si demandée
            if hasattr(self, '_photo_resolution') and self._photo_resolution:
                try:
                    prw, prh = map(int, self._photo_resolution.lower().split('x'))
                    photo_frame = cv2.resize(frame, (prw, prh))
                except Exception:
                    photo_frame = frame
            else:
                photo_frame = frame
            quality = int(self.recording_config.get('photo_quality', 95))
            cv2.imwrite(photo_path, photo_frame,
                        [cv2.IMWRITE_JPEG_QUALITY, quality])
            logger.info(f"Photo sauvegardée: {photo_name}")
        except Exception as e:
            logger.error(f"Erreur sauvegarde photo: {e}")

    def _capture_loop(self):
        """Boucle de capture vidéo avec reconnexion automatique exponentielle"""
        # Tenter d'ouvrir la caméra PiP au démarrage
        if self.pip_config.get('pip_enabled', False) and not self.pip_connected:
            self._open_pip_camera()

        while self.running:
            try:
                # Si un swap est en cours, attendre qu'il se termine
                if self._swap_in_progress:
                    time.sleep(0.05)
                    continue

                # Tenter d'ouvrir la caméra si pas connectée
                if not self.camera_connected or self.cap is None:
                    if self._open_camera():
                        logger.info("Caméra connectée avec succès")
                    else:
                        logger.warning(f"Reconnexion dans {self._reconnect_delay:.1f}s...")
                        time.sleep(self._reconnect_delay)
                        # Backoff exponentiel
                        self._reconnect_delay = min(
                            self._reconnect_delay * 1.5,
                            self._max_reconnect_delay
                        )
                        continue

                # Lire une frame
                ret, frame = self.cap.read()
                if not ret or frame is None:
                    logger.warning("Frame vide, tentative de reconnexion...")
                    self._release_camera()
                    continue

                # --- Mesure FPS par fenêtre glissante (réactif en ~200ms) ---
                self._fps_timestamps.append(time.time())
                if len(self._fps_timestamps) >= 2:
                    elapsed = self._fps_timestamps[-1] - self._fps_timestamps[0]
                    if elapsed > 0:
                        self.fps = int(len(self._fps_timestamps) / elapsed)

                # Détection faible lumière avec hystérésis (évite le clignotement)
                if self.fps < 10:
                    self._low_light_detected = True
                elif self.fps >= 12:
                    self._low_light_detected = False

                # Stocker la frame brute (pour photo sans OSD)
                self._raw_frame = frame

                # === RECORDING sans OSD : pousser la frame brute vers le thread d'écriture ===
                # (si OSD activé, c'est le thread OSD qui envoie les frames avec overlay)
                if self._recording and not self._recording_with_osd:
                    try:
                        self._recording_queue.put_nowait(frame.copy())
                    except Exception:
                        pass  # Queue pleine — skip cette frame

                # Photo sans OSD (immédiate depuis capture loop)
                if self._photo_requested and not self._photo_with_osd:
                    self._take_photo(frame)

                # Pousser vers le thread OSD (garder la dernière frame uniquement)
                try:
                    while not self._osd_queue.empty():
                        try:
                            self._osd_queue.get_nowait()
                        except Empty:
                            break
                    self._osd_queue.put_nowait(frame)
                except Exception:
                    pass

            except Exception as e:
                logger.error(f"Erreur boucle capture: {e}")
                self._release_camera()
                time.sleep(0.1)

    def _osd_display_loop(self):
        """
        Thread dédié au rendu PiP + encodage JPEG pour l'affichage.
        Découplé de la capture pour ne pas ralentir le flux vidéo.
        Fonctionne à son propre rythme (~7-10fps selon charge).

        L'OSD affichage est désormais rendu côté frontend (canvas vectoriel
        haute résolution) — le backend n'applique l'OSD OpenCV QUE pour les
        enregistrements vidéo et les captures photo qui le demandent.
        """
        logger.debug("Thread OSD démarré")
        while not self._osd_stop_event.is_set():
            # Récupérer la dernière frame disponible (vider la queue pour avoir la plus récente)
            frame = None
            while not self._osd_queue.empty():
                try:
                    frame = self._osd_queue.get_nowait()
                except Empty:
                    break
            if frame is None:
                time.sleep(0.02)  # Pas de frame disponible, attendre brièvement
                continue

            # Cacher la frame brute pour usage éventuel
            self._last_osd_frame = frame

            # Appliquer le Picture-in-Picture (commun affichage + enregistrement)
            try:
                frame = self._apply_pip(frame)
            except Exception as pip_err:
                logger.warning(f"Erreur PiP (thread OSD): {pip_err}")

            # === RECORDING avec OSD : appliquer l'OSD sur une copie dédiée ===
            if self._recording and self._recording_with_osd:
                try:
                    rec_frame = self._apply_osd(frame.copy()) if self.config.get('osd_enabled', True) else frame.copy()
                    self._recording_queue.put_nowait(rec_frame)
                except Exception:
                    pass  # Queue pleine ou erreur OSD — skip cette frame

            # Photo avec OSD (gérée dans le thread OSD)
            if self._photo_requested and self._photo_with_osd:
                try:
                    photo_frame = self._apply_osd(frame.copy()) if self.config.get('osd_enabled', True) else frame
                    self._take_photo(photo_frame)
                except Exception as osd_err:
                    logger.warning(f"Erreur OSD photo (thread): {osd_err}")
                    self._take_photo(frame)

            # Encoder en JPEG SANS OSD (l'OSD affichage est rendu par le canvas frontend)
            try:
                _, buffer = cv2.imencode(
                    '.jpg', frame,
                    [cv2.IMWRITE_JPEG_QUALITY, 80]
                )
                with self.frame_lock:
                    self._frame_bytes = buffer.tobytes()
                    self.last_frame = frame
            except Exception as e:
                logger.error(f"Erreur encodage JPEG (thread OSD): {e}")

        logger.debug("Thread OSD arrêté")

    def _apply_osd(self, frame) -> Any:
        """
        Applique l'incrustation OSD complète sur la frame :
        - Horizon artificiel (roulis/tangage)
        - Jauge de profondeur
        - Température
        - Cap (boussole)
        - Batterie
        - FPS et timestamp
        L'opacité globale est appliquée via addWeighted.
        """
        if not HAS_CV2:
            return frame

        h, w = frame.shape[:2]
        # Dessiner l'OSD sur une copie (pour le blending d'opacité)
        overlay = frame.copy()

        # Récupérer la télémétrie
        depth = self.telemetry_data.get('depth', 0.0)
        temp = self.telemetry_data.get('temperature', 20.0)
        heading = self.telemetry_data.get('heading', 0.0)
        battery = self.telemetry_data.get('battery', 100.0)
        # Correctif affichage : les valeurs roll/pitch arrivent inversées dans la
        # télémétrie — échange visuel uniquement (texte R:/P: et horizon artificiel).
        # Aucun impact sur le PID, le mixage moteurs ou les canaux I2C.
        roll = self.telemetry_data.get('pitch', 0.0)
        pitch = self.telemetry_data.get('roll', 0.0)

        # --- Lissage EMA roulis/tangage (damping configurable) ---
        damping = self._osd_int('horizon_damping', 5)
        # Détecter la transition OFF→ON (reset des smoothed)
        if damping != self._last_damping:
            if damping <= 1:
                # Passage à OFF : réinitialiser pour la prochaine activation
                self._smoothed_roll = None
                self._smoothed_pitch = None
            elif self._last_damping <= 1 and self._smoothed_roll is not None:
                # Passage ON après OFF : repartir du raw actuel
                self._smoothed_roll = None
                self._smoothed_pitch = None
            self._last_damping = damping

        if damping > 1:
            alpha = 1.0 / float(damping)  # 1/N → plus N élevé = plus lissé
            if self._smoothed_roll is None:
                # Première frame après activation
                self._smoothed_roll = roll
                self._smoothed_pitch = pitch
            else:
                self._smoothed_roll += alpha * (roll - self._smoothed_roll)
                self._smoothed_pitch += alpha * (pitch - self._smoothed_pitch)
            roll = self._smoothed_roll
            pitch = self._smoothed_pitch
        else:
            # Damping=1 → aucune atténuation, mais reset smoothed
            if self._smoothed_roll is not None:
                self._smoothed_roll = None
                self._smoothed_pitch = None

        # Couleurs pré-calculées (cachées, pas de _hex_to_bgr par frame)
        primary = self._color_primary
        dark_bg = (30, 30, 30)

        font = cv2.FONT_HERSHEY_SIMPLEX
        scale = self._osd('font_scale', 0.8) * self._osd_scale
        thin = max(1, int(scale * 1.5))
        thick = max(1, int(scale * 2.5))

        # --- 1. Horizon artificiel (centre de l'image) ---
        if self._osd('show_horizon', True):
            self._draw_horizon(overlay, w, h, roll, pitch, primary, scale)

        # --- 2. Jauge de profondeur (barre verticale à gauche) ---
        if self._osd('show_depth', True):
            dop = self._osd_int('depth_opacity', 100)
            self._draw_depth_gauge(overlay, depth, primary, dark_bg, scale, dop)

        # --- 3. Température (coin supérieur droit) ---
        if self._osd('show_temperature', True):
            top = self._osd_int('temperature_opacity', 100)
            self._draw_temperature(overlay, w, temp, dark_bg, scale, top)

        # --- 4. Cap / Boussole (bas centre) ---
        if self._osd('show_compass', True):
            cop = self._osd_int('compass_opacity', 100)
            self._draw_compass(overlay, w, h, heading, dark_bg, scale, cop)

        # --- 5. Batterie (coin supérieur droit, sous température) ---
        if self._osd('show_battery', True):
            bop = self._osd_int('battery_opacity', 100)
            self._draw_battery(overlay, w, battery, dark_bg, scale, bop)

        # --- 6. FPS (coin inférieur gauche) ---
        if self._osd('show_fps', True):
            cv2.putText(overlay, f"FPS: {self.fps}", (10, h - 15),
                        font, scale * 0.5, self._color_fps, thin)

        # --- 6.1 Alerte faible lumière ---
        if self._low_light_detected:
            alert_y = h - 45 if self._osd('show_fps', True) else h - 15
            cv2.putText(overlay, "! Manque de lumiere", (10, alert_y),
                        font, scale * 0.55, (0, 0, 255), thin)

        # --- 7. Timestamp (coin inférieur droit) ---
        timestamp = datetime.now().strftime("%H:%M:%S")
        cv2.putText(overlay, timestamp, (w - 110, h - 15),
                    font, scale * 0.5, self._color_fps, thin)

        # --- 8. Indicateur ARMÉ/DÉSARMÉ ---
        armed = self.telemetry_data.get('armed', False)
        status_text = "ARMÉ" if armed else "DÉSARMÉ"
        status_color = (0, 0, 255) if armed else (0, 200, 0)
        cv2.putText(overlay, status_text, (w // 2 - 50, 30),
                    font, scale * 0.8, status_color, thick)

        # --- 9. Propulseurs (moteurs) ---
        if self._osd('show_motors', True) and self.motor_manager and self.motor_manager.display_in_osd:
            mop = self._osd_int('motors_opacity', 100)
            self._draw_motors(overlay, w, h, scale, mop)

        # --- Appliquer l'opacité globale (blending overlay sur frame original) ---
        opacity = self._osd_int('opacity', 100)
        alpha = opacity / 100.0
        if alpha < 1.0:
            result = cv2.addWeighted(overlay, alpha, frame, 1.0 - alpha, 0)
        else:
            result = overlay

        return result

    def _draw_horizon(self, img: np.ndarray, w: int, h: int,
                      roll: float, pitch: float,
                      primary: tuple, scale: float):
        """Dessine un horizon artificiel au centre de l'image (clipping circulaire optionnel)"""
        cx, cy = w // 2, h // 2

        # Paramètres configurables depuis OSD config
        radius_pct = self._osd('horizon_radius_pct', 18)
        radius = int(min(w, h) * (radius_pct / 100.0))
        line_thick_raw = self._osd('horizon_line_thick', 2)
        try:
            line_thick_cfg = float(line_thick_raw)
        except (ValueError, TypeError):
            line_thick_cfg = 2.0
        circle_opacity = self._osd_int('horizon_circle_opacity', 15) / 100.0
        border_opacity = self._osd_int('horizon_border_opacity', 25) / 100.0
        pitch_scale = self._osd_int('horizon_pitch_scale', 2)
        show_text = self._osd('horizon_show_text', True)
        if isinstance(show_text, str):
            show_text = show_text.lower() in ('true', '1', 'yes')
        wing_color = self._color_wing
        horizon_color = self._color_horizon
        do_clip = self._osd('horizon_clip', False)
        if isinstance(do_clip, str):
            do_clip = do_clip.lower() in ('true', '1', 'yes')

        # Épaisseur en pixels directement depuis le slider (valeur décimale 1.0–10.0)
        line_thick = max(1, int(round(line_thick_cfg)))
        thin_line = max(1, int(round(line_thick_cfg * 0.6)))

        green_up = (0, 220, 0)     # Vert pour tangage positif (montée)
        red_down = (80, 80, 255)   # Rouge pour tangage négatif (descente)

        # --- ROI (éviter les copies full-frame coûteuses) ---
        if do_clip:
            margin = radius + line_thick + int(pitch_scale * 55)  # Marge pour graduations 50°
            rx1 = max(0, cx - margin)
            ry1 = max(0, cy - margin)
            rx2 = min(w, cx + margin)
            ry2 = min(h, cy + margin)
            roi = img[ry1:ry2, rx1:rx2]  # Vue sur la ROI
            roi_backup = roi.copy()       # Copie légère de la ROI
            # Centre dans la ROI
            rcx, rcy = cx - rx1, cy - ry1
            # Masque circulaire dans la ROI
            roi_mask = np.zeros((ry2 - ry1, rx2 - rx1), dtype=np.float32)
            cv2.circle(roi_mask, (rcx, rcy), radius, 1.0, -1)
            # On dessine sur img (pas de canvas séparé)
            canvas = img
        else:
            canvas = img

        # Fond du cercle (opacité paramétrable) — non clipé, appliqué sur img complet
        if circle_opacity > 0.01:
            overlay = img.copy()
            cv2.circle(overlay, (cx, cy), radius + 5, (0, 0, 0), -1)
            cv2.addWeighted(overlay, circle_opacity, img, 1.0 - circle_opacity, 0, img)

        # Cercle de bordure (opacité paramétrable)
        if border_opacity > 0.01:
            overlay2 = img.copy()
            cv2.circle(overlay2, (cx, cy), radius + 5, (120, 120, 120), 1)
            cv2.addWeighted(overlay2, border_opacity, img, 1.0 - border_opacity, 0, img)

        # Calcul rotation (roulis)
        roll_rad = math.radians(roll)
        pitch_offset = int(pitch * pitch_scale)
        cos_r = math.cos(roll_rad)
        sin_r = math.sin(roll_rad)

        # --- Ligne d'horizon ---
        dx = int(radius * cos_r)
        dy = int(radius * sin_r)
        pt1 = (cx - dx, cy - dy + pitch_offset)
        pt2 = (cx + dx, cy + dy + pitch_offset)
        cv2.line(canvas, pt1, pt2, horizon_color, line_thick)

        # --- Marqueurs de tangage (jusqu'à 50°) ---
        for deg in [-50, -40, -30, -20, -10, 10, 20, 30, 40, 50]:
            offset = int(deg * pitch_scale) - pitch_offset
            # Graduations plus courtes pour les grands angles
            if abs(deg) <= 20:
                mark_len = int(radius * 0.35)
            elif abs(deg) <= 40:
                mark_len = int(radius * 0.22)
            else:
                mark_len = int(radius * 0.15)
            m_dx = int(mark_len * cos_r)
            m_dy = int(mark_len * sin_r)
            m_cx = cx + int(offset * sin_r)
            m_cy = cy - int(offset * cos_r)
            mp1 = (m_cx - m_dx, m_cy - m_dy)
            mp2 = (m_cx + m_dx, m_cy + m_dy)
            mark_color = green_up if deg > 0 else red_down
            cv2.line(canvas, mp1, mp2, mark_color, thin_line)
            # Label du degré (tous les 10°)
            if abs(deg) % 10 == 0:
                cv2.putText(canvas, f"{abs(deg)}", (m_cx + m_dx + 5, m_cy + m_dy),
                            cv2.FONT_HERSHEY_SIMPLEX, scale * 0.4, primary, 1)

        # --- Ailes centrales ---
        wing_len = int(radius * 0.45)
        cv2.line(canvas, (cx - wing_len, cy), (cx - 10, cy), wing_color, line_thick)
        cv2.line(canvas, (cx + 10, cy), (cx + wing_len, cy), wing_color, line_thick)
        pts = np.array([[cx - 6, cy + 4], [cx + 6, cy + 4], [cx, cy - 6]], dtype=np.int32)
        cv2.fillPoly(canvas, [pts], wing_color)

        # --- Clipping circulaire (opération sur ROI uniquement) ---
        if do_clip:
            # Restaurer l'extérieur du cercle sur la ROI
            roi_view = img[ry1:ry2, rx1:rx2]
            # Blend: intérieur = canvas (déjà dans img), extérieur = backup
            roi_view[:] = (roi_view.astype(np.float32) * roi_mask[..., None] +
                           roi_backup.astype(np.float32) * (1.0 - roi_mask[..., None])).astype(np.uint8)

        # --- Texte roulis et tangage (dessiné APRÈS le clipping pour ne pas être effacé) ---
        if show_text:
            text_y = cy + radius + 25
            cv2.putText(canvas, f"R: {roll:+.1f}", (cx - 65, text_y),
                        cv2.FONT_HERSHEY_SIMPLEX, scale * 0.55, primary, max(1, int(scale * 1.5)))
            cv2.putText(canvas, f"P: {pitch:+.1f}", (cx + 10, text_y),
                        cv2.FONT_HERSHEY_SIMPLEX, scale * 0.55, primary, max(1, int(scale * 1.5)))

    def _draw_depth_gauge(self, img: np.ndarray, depth: float,
                          primary: tuple, dark_bg: tuple, scale: float,
                          opacity: int = 100):
        """Dessine la jauge de profondeur verticale à gauche (transparence individuelle)"""
        depth_color = self._color_depth
        bar_x, bar_y = 25, 70
        bar_w, bar_h = 18, int(img.shape[0] * 0.4)
        max_depth = 100.0  # Profondeur max en mètres

        # Calcul de la région totale (barre + texte)
        r_x1 = bar_x - 5
        r_y1 = bar_y - 10
        r_x2 = bar_x + bar_w + 50
        r_y2 = bar_y + bar_h + 30
        # Clamp aux dimensions de l'image
        r_x1 = max(0, r_x1)
        r_y1 = max(0, r_y1)
        r_x2 = min(img.shape[1], r_x2)
        r_y2 = min(img.shape[0], r_y2)

        # Sauvegarde de la région (blending per-element)
        if opacity < 100:
            saved = img[r_y1:r_y2, r_x1:r_x2].copy()

        # Fond semi-transparent
        cv2.rectangle(img, (bar_x - 2, bar_y - 2),
                      (bar_x + bar_w + 2, bar_y + bar_h + 2), dark_bg, -1)

        # Niveau de remplissage
        depth_pct = min(max(depth / max_depth, 0.0), 1.0)
        fill_h = int(depth_pct * bar_h)
        fill_top = bar_y + bar_h - fill_h

        # Gradient de couleur (utilise depth_color de la config)
        cv2.rectangle(img, (bar_x, fill_top),
                      (bar_x + bar_w, bar_y + bar_h), depth_color, -1)

        # Bordure
        cv2.rectangle(img, (bar_x, bar_y),
                      (bar_x + bar_w, bar_y + bar_h), depth_color, 1)

        # Texte profondeur
        cv2.putText(img, f"{depth:.1f}m", (bar_x - 5, bar_y + bar_h + 25),
                    cv2.FONT_HERSHEY_SIMPLEX, scale * 0.6, depth_color, max(1, int(scale * 1.5)))
        cv2.putText(img, "PROF", (bar_x - 2, bar_y - 8),
                    cv2.FONT_HERSHEY_SIMPLEX, scale * 0.4, primary, 1)

        # Blend per-element
        if opacity < 100:
            roi = img[r_y1:r_y2, r_x1:r_x2]
            a = opacity / 100.0
            roi[:] = (roi.astype(np.float32) * a +
                      saved.astype(np.float32) * (1.0 - a)).astype(np.uint8)

    def _draw_temperature(self, img: np.ndarray, w: int, temp: float,
                          dark_bg: tuple, scale: float,
                          opacity: int = 100):
        """Dessine la température en haut à droite (transparence individuelle)"""
        temp_color = self._color_temperature
        x, y = w - 140, 30

        # Région
        r_x1 = max(0, x - 8)
        r_y1 = max(0, y - 22)
        r_x2 = min(img.shape[1], x + 132)
        r_y2 = min(img.shape[0], y + 12)

        if opacity < 100:
            saved = img[r_y1:r_y2, r_x1:r_x2].copy()

        # Fond
        cv2.rectangle(img, (x - 5, y - 20), (x + 130, y + 10), dark_bg, -1)
        # Texte
        cv2.putText(img, f"TEMP: {temp:.1f}°C", (x, y),
                    cv2.FONT_HERSHEY_SIMPLEX, scale * 0.6, temp_color, max(1, int(scale * 1.5)))

        if opacity < 100:
            roi = img[r_y1:r_y2, r_x1:r_x2]
            a = opacity / 100.0
            roi[:] = (roi.astype(np.float32) * a +
                      saved.astype(np.float32) * (1.0 - a)).astype(np.uint8)

    def _draw_compass(self, img: np.ndarray, w: int, h: int, heading: float,
                      dark_bg: tuple, scale: float,
                      opacity: int = 100):
        """Dessine l'indicateur de cap en bas au centre (transparence individuelle)"""
        cx = w // 2
        cy = h - 50
        bar_width = int(w * 0.35)
        compass_color = self._color_compass
        yellow = (0, 255, 255)

        # Région (boussole + texte cap numérique)
        r_x1 = max(0, cx - bar_width // 2 - 10)
        r_y1 = max(0, cy - 20)
        r_x2 = min(img.shape[1], cx + bar_width // 2 + 70)
        r_y2 = min(img.shape[0], cy + 20)

        if opacity < 100:
            saved = img[r_y1:r_y2, r_x1:r_x2].copy()

        # Fond
        cv2.rectangle(img, (cx - bar_width // 2 - 5, cy - 18),
                      (cx + bar_width // 2 + 5, cy + 18), dark_bg, -1)

        # Points cardinaux
        directions = {0: 'N', 45: 'NE', 90: 'E', 135: 'SE',
                      180: 'S', 225: 'SO', 270: 'O', 315: 'NO'}

        for deg, label in directions.items():
            offset = deg - heading
            # Normaliser entre -180 et 180
            while offset > 180:
                offset -= 360
            while offset < -180:
                offset += 360
            px = cx + int(offset * bar_width / 180.0)
            if cx - bar_width // 2 <= px <= cx + bar_width // 2:
                if label in ('N', 'S', 'E', 'O'):
                    cv2.putText(img, label, (px - 5, cy + 5),
                                cv2.FONT_HERSHEY_SIMPLEX, scale * 0.5, compass_color, max(1, int(scale * 1.5)))
                else:
                    cv2.line(img, (px, cy - 8), (px, cy + 8), compass_color, 1)

        # Indicateur central
        cv2.line(img, (cx, cy - 15), (cx, cy + 15), yellow, 2)

        # Texte du cap numérique
        cv2.putText(img, f"CAP {heading:03.0f}°", (cx + bar_width // 2 + 10, cy + 5),
                    cv2.FONT_HERSHEY_SIMPLEX, scale * 0.55, compass_color, max(1, int(scale * 1.5)))

        if opacity < 100:
            roi = img[r_y1:r_y2, r_x1:r_x2]
            a = opacity / 100.0
            roi[:] = (roi.astype(np.float32) * a +
                      saved.astype(np.float32) * (1.0 - a)).astype(np.uint8)

    def _draw_battery(self, img: np.ndarray, w: int, battery: float,
                      dark_bg: tuple, scale: float, opacity: int = 100):
        """Dessine l'indicateur de batterie en haut à droite (transparence individuelle)"""
        battery_color = self._color_battery
        yellow = (0, 255, 255)
        red = (0, 0, 255)
        x, y = w - 140, 55
        bar_w, bar_h = 100, 16

        # Région
        r_x1 = max(0, x - 8)
        r_y1 = max(0, y - 7)
        r_x2 = min(img.shape[1], x + bar_w + 35)
        r_y2 = min(img.shape[0], y + bar_h + 7)

        if opacity < 100:
            saved = img[r_y1:r_y2, r_x1:r_x2].copy()

        # Fond
        cv2.rectangle(img, (x - 5, y - 5), (x + bar_w + 30, y + bar_h + 5), dark_bg, -1)

        # Niveau de batterie
        batt_pct = max(0.0, min(battery / 100.0, 1.0))
        fill_w = int(batt_pct * bar_w)

        # Couleur selon le niveau
        if batt_pct > 0.5:
            color = (0, 200, 0)
        elif batt_pct > 0.2:
            color = yellow
        else:
            color = red

        # Barre
        cv2.rectangle(img, (x, y), (x + bar_w, y + bar_h), (80, 80, 80), -1)
        cv2.rectangle(img, (x, y), (x + fill_w, y + bar_h), color, -1)
        cv2.rectangle(img, (x, y), (x + bar_w, y + bar_h), battery_color, 1)

        # Texte pourcentage
        cv2.putText(img, f"{battery:.0f}%", (x + bar_w + 5, y + bar_h - 2),
                    cv2.FONT_HERSHEY_SIMPLEX, scale * 0.45, battery_color, 1)

        if opacity < 100:
            roi = img[r_y1:r_y2, r_x1:r_x2]
            a = opacity / 100.0
            roi[:] = (roi.astype(np.float32) * a +
                      saved.astype(np.float32) * (1.0 - a)).astype(np.uint8)

    def _draw_motors(self, img, w: int, h: int, scale: float, opacity: int = 100):
        """
        Dessine l'état des 8 propulseurs sur l'OSD.
        Style 'circles' : vue du dessus du ROV, moteurs en configuration X
        Style 'bars' : 8 barres horizontales empilées
        """
        if not self.motor_manager:
            return

        motors = self.motor_manager.get_motor_data()
        style = self.motor_manager.display_style
        position = self.motor_manager.display_position

        # Couleurs
        green = (136, 255, 0)     # #00ff88 en BGR
        red = (68, 68, 255)       # #ff4444 en BGR
        gray = (85, 85, 85)       # #555555 en BGR
        white = (255, 255, 255)
        dark_bg = (30, 30, 30)
        font = cv2.FONT_HERSHEY_SIMPLEX
        thin = max(1, int(scale * 1.2))

        if style == 'bars':
            self._draw_motors_bars(img, w, h, motors, position, scale, opacity,
                                   green, red, gray, white, dark_bg, font, thin)
        else:
            self._draw_motors_circles(img, w, h, motors, position, scale, opacity,
                                      green, red, gray, white, dark_bg, font, thin)

    def _draw_motors_circles(self, img, w, h, motors, position, scale, opacity,
                             green, red, gray, white, dark_bg, font, thin):
        """
        Style cercles : vue du dessus du ROV en configuration X.
        M1-M4 horizontaux (extérieur), M5-M8 verticaux (intérieur)
        Numérotation officielle : départ avant-droit, sens horaire strict.
        """
        # Dimensions du widget
        widget_w = int(160 * scale)
        widget_h = int(140 * scale)

        # Position de base selon la config
        margin = 10
        if position == 'bottom-right':
            base_x = w - widget_w - margin
            base_y = h - widget_h - margin
        elif position == 'top-left':
            base_x = margin
            base_y = margin + 40
        elif position == 'top-right':
            base_x = w - widget_w - margin
            base_y = margin + 40
        else:  # bottom-left (défaut)
            base_x = margin
            base_y = h - widget_h - margin

        # Région pour l'opacité per-element
        r_x1 = max(0, base_x - 5)
        r_y1 = max(0, base_y - 5)
        r_x2 = min(w, base_x + widget_w + 5)
        r_y2 = min(h, base_y + widget_h + 5)

        if opacity < 100:
            saved = img[r_y1:r_y2, r_x1:r_x2].copy()

        # Fond semi-transparent
        cv2.rectangle(img, (base_x, base_y),
                      (base_x + widget_w, base_y + widget_h), dark_bg, -1)
        cv2.rectangle(img, (base_x, base_y),
                      (base_x + widget_w, base_y + widget_h), (60, 60, 60), 1)

        # Titre
        cv2.putText(img, "PROP", (base_x + 5, base_y + int(14 * scale)),
                    font, scale * 0.4, white, thin)

        # Centre du widget
        cx = base_x + widget_w // 2
        cy = base_y + int(widget_h * 0.5)

        # Espacement des moteurs en X
        spread_h = int(50 * scale)  # horizontaux (extérieur)
        spread_v = int(30 * scale)  # verticaux (intérieur)
        dy_top = int(-30 * scale)
        dy_bot = int(30 * scale)

        # Positions des 8 moteurs (vue du dessus, config X)
        # Schéma officiel (sens horaire strict depuis l'avant-droit) :
        #   M4 ↖   ↗ M1        M8 ⭕   ⭕ M5   (avant)
        #   M3 ↙   ↘ M2        M7 ⭕   ⭕ M6   (arrière)
        positions = {
            1: (cx + spread_h, cy + dy_top),    # M1 Horiz Avant-Droit
            2: (cx + spread_h, cy + dy_bot),    # M2 Horiz Arrière-Droit
            3: (cx - spread_h, cy + dy_bot),    # M3 Horiz Arrière-Gauche
            4: (cx - spread_h, cy + dy_top),    # M4 Horiz Avant-Gauche
            5: (cx + spread_v, cy + dy_top),    # M5 Vert Avant-Droit
            6: (cx + spread_v, cy + dy_bot),    # M6 Vert Arrière-Droit
            7: (cx - spread_v, cy + dy_bot),    # M7 Vert Arrière-Gauche
            8: (cx - spread_v, cy + dy_top),    # M8 Vert Avant-Gauche
        }

        max_radius = int(12 * scale)
        min_radius = int(4 * scale)

        for motor in motors:
            mid = motor['id']
            thrust = motor['thrust']
            percent = motor['percent']
            pos = positions.get(mid, (cx, cy))

            # Couleur selon la direction
            if thrust > 0.01:
                color = green
            elif thrust < -0.01:
                color = red
            else:
                color = gray

            # Rayon proportionnel à la puissance
            radius = min_radius + int((max_radius - min_radius) * (percent / 100.0))

            # Dessiner le cercle
            cv2.circle(img, pos, radius, color, -1)
            cv2.circle(img, pos, max_radius, (100, 100, 100), 1)

            # Label M1-M8
            label = f"M{mid}"
            cv2.putText(img, label, (pos[0] - int(8 * scale), pos[1] + max_radius + int(10 * scale)),
                        font, scale * 0.3, white, 1)

        # Pourcentage global moyen en bas
        avg_pct = sum(m['percent'] for m in motors) / 8
        cv2.putText(img, f"Moy: {avg_pct:.0f}%",
                    (base_x + 5, base_y + widget_h - int(5 * scale)),
                    font, scale * 0.35, white, thin)

        # Blend per-element
        if opacity < 100:
            roi = img[r_y1:r_y2, r_x1:r_x2]
            a = opacity / 100.0
            roi[:] = (roi.astype(np.float32) * a +
                      saved.astype(np.float32) * (1.0 - a)).astype(np.uint8)

    def _draw_motors_bars(self, img, w, h, motors, position, scale, opacity,
                          green, red, gray, white, dark_bg, font, thin):
        """
        Style barres : 8 barres horizontales organisées en 2 blocs distincts
        (Propulsion Horizontale M1-M4 / Propulsion Verticale M5-M8).
        Barre verte vers la droite (avant), rouge vers la gauche (arrière).
        """
        bar_w = int(100 * scale)
        bar_h = int(10 * scale)
        spacing = int(14 * scale)
        header_h = int(15 * scale)          # hauteur d'un titre de bloc
        label_w = int(92 * scale)           # place pour "M1: Horiz Av-D"
        widget_w = label_w + bar_w + int(45 * scale)
        widget_h = int(22 * scale) + 2 * header_h + 8 * spacing + int(10 * scale)

        margin = 10
        if position == 'bottom-right':
            base_x = w - widget_w - margin
            base_y = h - widget_h - margin
        elif position == 'top-left':
            base_x = margin
            base_y = margin + 40
        elif position == 'top-right':
            base_x = w - widget_w - margin
            base_y = margin + 40
        else:  # bottom-left
            base_x = margin
            base_y = h - widget_h - margin

        # Région pour opacité
        r_x1 = max(0, base_x - 5)
        r_y1 = max(0, base_y - 5)
        r_x2 = min(w, base_x + widget_w + 5)
        r_y2 = min(h, base_y + widget_h + 5)

        if opacity < 100:
            saved = img[r_y1:r_y2, r_x1:r_x2].copy()

        # Fond
        cv2.rectangle(img, (base_x, base_y),
                      (base_x + widget_w, base_y + widget_h), dark_bg, -1)
        cv2.rectangle(img, (base_x, base_y),
                      (base_x + widget_w, base_y + widget_h), (60, 60, 60), 1)

        # Titre
        cv2.putText(img, "PROP", (base_x + 5, base_y + int(14 * scale)),
                    font, scale * 0.4, white, thin)

        label_x = base_x + int(5 * scale)
        bar_start_x = base_x + label_w
        center_x = bar_start_x + bar_w // 2
        header_color = (255, 210, 130)      # bleu-cyan clair en BGR

        # Deux blocs distincts : M1-M4 horizontaux puis M5-M8 verticaux
        groups = [
            ("PROPULSION HORIZONTALE", [m for m in motors if m['id'] <= 4]),
            ("PROPULSION VERTICALE",   [m for m in motors if m['id'] >= 5]),
        ]

        y = base_y + int(20 * scale)
        for group_title, group_motors in groups:
            # Titre du bloc
            cv2.putText(img, group_title, (label_x, y + int(10 * scale)),
                        font, scale * 0.3, header_color, 1)
            y += header_h

            for motor in group_motors:
                thrust = motor['thrust']
                percent = motor['percent']

                # Label complet : "M1: Horiz Av-D" ... "M8: Vert Ar-G"
                cv2.putText(img, motor['name'], (label_x, y + bar_h - 2),
                            font, scale * 0.3, white, 1)

                # Fond de la barre
                cv2.rectangle(img, (bar_start_x, y),
                              (bar_start_x + bar_w, y + bar_h), (50, 50, 50), -1)

                # Ligne centrale (zéro)
                cv2.line(img, (center_x, y), (center_x, y + bar_h), (120, 120, 120), 1)

                # Barre de puissance
                if thrust > 0.01:
                    fill_w = int((bar_w / 2) * thrust)
                    cv2.rectangle(img, (center_x, y),
                                  (center_x + fill_w, y + bar_h), green, -1)
                elif thrust < -0.01:
                    fill_w = int((bar_w / 2) * abs(thrust))
                    cv2.rectangle(img, (center_x - fill_w, y),
                                  (center_x, y + bar_h), red, -1)

                # Pourcentage
                pct_x = bar_start_x + bar_w + int(5 * scale)
                cv2.putText(img, f"{percent}%", (pct_x, y + bar_h - 1),
                            font, scale * 0.28, white, 1)

                y += spacing

        # Blend per-element
        if opacity < 100:
            roi = img[r_y1:r_y2, r_x1:r_x2]
            a = opacity / 100.0
            roi[:] = (roi.astype(np.float32) * a +
                      saved.astype(np.float32) * (1.0 - a)).astype(np.uint8)

    @staticmethod
    def _hex_to_bgr(hex_color: str) -> tuple:
        """Convertit une couleur hex (#RRGGBB) en tuple BGR pour OpenCV"""
        try:
            hex_color = hex_color.lstrip('#')
            r = int(hex_color[0:2], 16)
            g = int(hex_color[2:4], 16)
            b = int(hex_color[4:6], 16)
            return (b, g, r)
        except (ValueError, IndexError):
            return (0, 255, 0)  # Vert par défaut

    def get_frame(self) -> Optional[bytes]:
        """Récupère la dernière frame encodée en JPEG (thread-safe)"""
        with self.frame_lock:
            return self._frame_bytes

    def get_mjpeg_generator(self):
        """
        Retourne un générateur MJPEG pour le streaming HTTP.
        Utilisé par le endpoint /video_feed.
        """
        def generate():
            while self.running:
                try:
                    frame_data = self.get_frame()
                    if frame_data:
                        yield (b'--frame\r\n'
                               b'Content-Type: image/jpeg\r\n\r\n' + frame_data + b'\r\n')
                    else:
                        # Pas de frame disponible — attendre brièvement
                        time.sleep(0.05)
                        continue
                except Exception as e:
                    logger.warning(f"Erreur dans le générateur MJPEG: {e}")
                time.sleep(0.033)  # ~30fps max
        return generate()

    def update_telemetry(self, data: Dict[str, Any]):
        """Met à jour les données de télémétrie pour l'OSD (thread-safe)"""
        with self.frame_lock:
            self.telemetry_data.update(data)

    def get_fps(self) -> int:
        """Retourne le FPS actuel"""
        return self.fps

    def is_running(self) -> bool:
        """Vérifie si le stream est actif et la caméra connectée"""
        return self.running and self.camera_connected

    def is_camera_connected(self) -> bool:
        """Vérifie si la caméra est connectée"""
        return self.camera_connected

    def set_osd_scale(self, scale: float):
        """Change l'échelle de l'OSD (pour le mode lunette)"""
        self._osd_scale = max(0.5, min(4.0, scale))
        logger.info(f"OSD scale: {self._osd_scale}")
