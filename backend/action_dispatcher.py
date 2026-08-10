"""
BOB-ROV — Action Dispatcher
Bridge central entre les commandes et les fonctions du ROV.
Chaque action a un statut (IMPLEMENTED, IN_PROGRESS, PLANNED) et
est exécutée, partiellement exécutée, ou mockée en conséquence.
"""

import time
import logging
import threading
from typing import Dict, Any, List, Optional
from collections import deque
from enum import Enum

from .motor_mixer import MotorMixer

logger = logging.getLogger(__name__)


class ActionStatus(Enum):
    """Statut d'implémentation d'une action"""
    IMPLEMENTED = "implemented"    # ✅ Fonction opérationnelle
    IN_PROGRESS = "in_progress"   # 🛠️ En cours de développement
    PLANNED = "planned"           # ⏳ Planifiée, non développée


class ActionDispatcher:
    """
    Dispatcher central des actions du ROV.
    Route les commandes vers les fonctions réelles ou les mocks
    selon leur statut d'implémentation.
    """
    
    def __init__(self, rov_state: Dict[str, Any], video_streamer=None):
        self._lock = threading.Lock()
        self.rov_state = rov_state
        self.video_streamer = video_streamer
        
        # Journal des actions (dernières 100 entrées)
        self._action_log: deque = deque(maxlen=100)

        # Mixeur moteur et références hardware
        self._motor_mixer = MotorMixer()
        self._motor_manager = None
        self._i2c_controller = None
        self._sensor_manager = None

        # État 6DOF accumulé (axes analogiques de la manette)
        self._dof_state = {
            'surge': 0.0,   # forward/backward
            'sway': 0.0,    # lateral
            'yaw': 0.0,     # turn
            'heave': 0.0,   # vertical
            'roll': 0.0,    # roll
            'pitch': 0.0,   # pitch
        }
        
        # Registre des actions avec leur statut et description
        self._actions: Dict[str, Dict[str, Any]] = {
            # === IMPLEMENTED ===
            'photo': {
                'status': ActionStatus.IMPLEMENTED,
                'description': 'Prendre une photo',
                'category': 'capture',
                'handler': self._action_photo,
            },
            'video_toggle': {
                'status': ActionStatus.IMPLEMENTED,
                'description': 'Démarrer/Arrêter l\'enregistrement vidéo',
                'category': 'capture',
                'handler': self._action_video_toggle,
            },
            'video_osd_toggle': {
                'status': ActionStatus.IMPLEMENTED,
                'description': 'Vidéo ON/OFF (avec OSD)',
                'category': 'capture',
                'handler': self._action_video_osd_toggle,
            },
            'video_no_osd_toggle': {
                'status': ActionStatus.IMPLEMENTED,
                'description': 'Vidéo ON/OFF (sans OSD)',
                'category': 'capture',
                'handler': self._action_video_no_osd_toggle,
            },
            'photo_cam1_osd': {
                'status': ActionStatus.IMPLEMENTED,
                'description': 'Photo Cam1 (avec OSD)',
                'category': 'capture',
                'handler': self._action_photo_cam1_osd,
            },
            'photo_cam1_no_osd': {
                'status': ActionStatus.IMPLEMENTED,
                'description': 'Photo Cam1 (sans OSD)',
                'category': 'capture',
                'handler': self._action_photo_cam1_no_osd,
            },
            'photo_cam2_osd': {
                'status': ActionStatus.IMPLEMENTED,
                'description': 'Photo Cam2 (avec OSD)',
                'category': 'capture',
                'handler': self._action_photo_cam2_osd,
            },
            'photo_cam2_no_osd': {
                'status': ActionStatus.IMPLEMENTED,
                'description': 'Photo Cam2 (sans OSD)',
                'category': 'capture',
                'handler': self._action_photo_cam2_no_osd,
            },
            
            # === IN_PROGRESS ===
            'light_toggle': {
                'status': ActionStatus.IN_PROGRESS,
                'description': 'Allumer/Éteindre l\'éclairage LED',
                'category': 'eclairage',
                'handler': self._action_light_toggle,
            },
            'autolevel_toggle': {
                'status': ActionStatus.IMPLEMENTED,
                'description': 'Activer/Désactiver l\'assiette automatique',
                'category': 'stabilisation',
                'handler': self._action_autolevel_toggle,
            },
            
            # === PLANNED — Mouvements ===
            'move_forward': {
                'status': ActionStatus.PLANNED,
                'description': 'Avancer',
                'category': 'mouvement',
                'handler': None,
            },
            'move_backward': {
                'status': ActionStatus.PLANNED,
                'description': 'Reculer',
                'category': 'mouvement',
                'handler': None,
            },
            'turn_left': {
                'status': ActionStatus.PLANNED,
                'description': 'Tourner à gauche',
                'category': 'mouvement',
                'handler': None,
            },
            'turn_right': {
                'status': ActionStatus.PLANNED,
                'description': 'Tourner à droite',
                'category': 'mouvement',
                'handler': None,
            },
            'move_up': {
                'status': ActionStatus.PLANNED,
                'description': 'Monter',
                'category': 'mouvement',
                'handler': None,
            },
            'move_down': {
                'status': ActionStatus.PLANNED,
                'description': 'Descendre',
                'category': 'mouvement',
                'handler': None,
            },
            'roll_left': {
                'status': ActionStatus.PLANNED,
                'description': 'Roulis gauche',
                'category': 'mouvement',
                'handler': None,
            },
            'roll_right': {
                'status': ActionStatus.PLANNED,
                'description': 'Roulis droite',
                'category': 'mouvement',
                'handler': None,
            },
            'pitch_up': {
                'status': ActionStatus.PLANNED,
                'description': 'Tangage haut',
                'category': 'mouvement',
                'handler': None,
            },
            'pitch_down': {
                'status': ActionStatus.PLANNED,
                'description': 'Tangage bas',
                'category': 'mouvement',
                'handler': None,
            },
            'forward_backward': {
                'status': ActionStatus.IMPLEMENTED,
                'description': 'Axe avant/arrière (analogique)',
                'category': 'mouvement',
                'handler': self._action_forward_backward,
            },
            'vertical': {
                'status': ActionStatus.IMPLEMENTED,
                'description': 'Axe vertical (analogique)',
                'category': 'mouvement',
                'handler': self._action_vertical,
            },
            'lateral': {
                'status': ActionStatus.IMPLEMENTED,
                'description': 'Axe latéral (analogique)',
                'category': 'mouvement',
                'handler': self._action_lateral,
            },
            'turn': {
                'status': ActionStatus.IMPLEMENTED,
                'description': 'Axe rotation (analogique)',
                'category': 'mouvement',
                'handler': self._action_turn,
            },
            'ascent': {
                'status': ActionStatus.IMPLEMENTED,
                'description': 'Montée (gâchette analogique)',
                'category': 'mouvement',
                'handler': self._action_ascent,
            },
            'descent': {
                'status': ActionStatus.IMPLEMENTED,
                'description': 'Descente (gâchette analogique)',
                'category': 'mouvement',
                'handler': self._action_descent,
            },
            'roll': {
                'status': ActionStatus.IMPLEMENTED,
                'description': 'Axe roulis (analogique)',
                'category': 'mouvement',
                'handler': self._action_roll,
            },
            'pitch': {
                'status': ActionStatus.IMPLEMENTED,
                'description': 'Axe tangage (analogique)',
                'category': 'mouvement',
                'handler': self._action_pitch,
            },
            
            # === PLANNED — Pince ===
            'grip_open': {
                'status': ActionStatus.PLANNED,
                'description': 'Ouvrir la pince',
                'category': 'pince',
                'handler': None,
            },
            'grip_close': {
                'status': ActionStatus.PLANNED,
                'description': 'Fermer la pince',
                'category': 'pince',
                'handler': None,
            },
            
            # === PLANNED — Éclairage ===
            'light_brightness': {
                'status': ActionStatus.PLANNED,
                'description': 'Régler la luminosité LED',
                'category': 'eclairage',
                'handler': None,
            },
            'light_up': {
                'status': ActionStatus.PLANNED,
                'description': 'Augmenter l\'intensité LED',
                'category': 'eclairage',
                'handler': None,
            },
            'light_down': {
                'status': ActionStatus.PLANNED,
                'description': 'Diminuer l\'intensité LED',
                'category': 'eclairage',
                'handler': None,
            },

            # === PLANNED — Caméra (tilt) ===
            'camera_tilt_up': {
                'status': ActionStatus.PLANNED,
                'description': 'Incliner la caméra vers le haut',
                'category': 'camera',
                'handler': None,
            },
            'camera_tilt_down': {
                'status': ActionStatus.PLANNED,
                'description': 'Incliner la caméra vers le bas',
                'category': 'camera',
                'handler': None,
            },
            'camera_tilt': {
                'status': ActionStatus.PLANNED,
                'description': 'Inclinaison caméra (axe analogique)',
                'category': 'camera',
                'handler': None,
            },

            # === PLANNED — Interface & IMU ===
            'fpv_toggle': {
                'status': ActionStatus.PLANNED,
                'description': 'Basculer vue externe / vue FPV caméra (géré côté IHM)',
                'category': 'interface',
                'handler': None,
            },
            'goggle_exit': {
                'status': ActionStatus.PLANNED,
                'description': 'Quitter le mode Lunette FPV (géré côté IHM)',
                'category': 'interface',
                'handler': None,
            },
            'night_toggle': {
                'status': ActionStatus.PLANNED,
                'description': 'Basculer le mode nuit en Lunette (géré côté IHM)',
                'category': 'interface',
                'handler': None,
            },
            'crosshair_toggle': {
                'status': ActionStatus.PLANNED,
                'description': 'Afficher/Masquer la grille de visée en Lunette (géré côté IHM)',
                'category': 'interface',
                'handler': None,
            },
            'panel_toggle': {
                'status': ActionStatus.PLANNED,
                'description': 'Basculer (ouvrir/masquer) le panneau latéral du Cockpit (géré côté IHM)',
                'category': 'interface',
                'handler': None,
            },
            'imu_tare': {
                'status': ActionStatus.PLANNED,
                'description': 'Recalibrage zéro IMU / Tare',
                'category': 'capteurs',
                'handler': None,
            },
            
            # === PLANNED — Macros ===
            'macro_180': {
                'status': ActionStatus.PLANNED,
                'description': 'Macro : demi-tour 180°',
                'category': 'macro',
                'handler': None,
            },
            'macro_surface': {
                'status': ActionStatus.PLANNED,
                'description': 'Macro : remontée en surface',
                'category': 'macro',
                'handler': None,
            },
            'macro_hold': {
                'status': ActionStatus.PLANNED,
                'description': 'Macro : maintien de position',
                'category': 'macro',
                'handler': None,
            },
            
            # === PLANNED — Capteurs ===
            'read_sensors': {
                'status': ActionStatus.IMPLEMENTED,
                'description': 'Lecture des capteurs environnement / IMU',
                'category': 'capteurs',
                'handler': self._action_read_sensors,
            },
            
            # === IMPLEMENTED — Contrôle ROV ===
            'arm': {
                'status': ActionStatus.IMPLEMENTED,
                'description': 'Armer le ROV',
                'category': 'controle',
                'handler': self._action_arm,
            },
            'disarm': {
                'status': ActionStatus.IMPLEMENTED,
                'description': 'Désarmer le ROV',
                'category': 'controle',
                'handler': self._action_disarm,
            },
            'arm_toggle': {
                'status': ActionStatus.IMPLEMENTED,
                'description': 'Basculer Armer / Désarmer (toggle)',
                'category': 'controle',
                'handler': self._action_arm_toggle,
            },
            'emergency_stop': {
                'status': ActionStatus.IMPLEMENTED,
                'description': 'Arrêt d\'urgence',
                'category': 'controle',
                'handler': self._action_emergency_stop,
            },
            'reset_position': {
                'status': ActionStatus.IMPLEMENTED,
                'description': 'Réinitialiser la position',
                'category': 'controle',
                'handler': self._action_reset_position,
            },
            'depth_hold': {
                'status': ActionStatus.PLANNED,
                'description': 'Maintien de profondeur',
                'category': 'stabilisation',
                'handler': None,
            },
            'heading_hold': {
                'status': ActionStatus.PLANNED,
                'description': 'Maintien de cap',
                'category': 'stabilisation',
                'handler': None,
            },
        }
        
        logger.info(f"ActionDispatcher initialisé : {self._count_by_status()} actions")
    
    # ==========================================================
    # API PUBLIQUE
    # ==========================================================
    
    def execute(self, action_name: str, value: Any = 1) -> Dict[str, Any]:
        """
        Exécute une action par son nom.
        Retourne un dict avec status, message, et métadonnées.
        """
        action = self._actions.get(action_name)
        if not action:
            result = {
                "status": "error",
                "action": action_name,
                "message": f"Action inconnue : {action_name}"
            }
            self._log_action(action_name, result)
            return result
        
        status = action['status']
        
        if status == ActionStatus.IMPLEMENTED:
            # Exécuter réellement
            try:
                result = action['handler'](value)
                result['action_status'] = 'implemented'
            except Exception as e:
                logger.error(f"Erreur action {action_name}: {e}")
                result = {"status": "error", "message": str(e), "action_status": "implemented"}
        
        elif status == ActionStatus.IN_PROGRESS:
            # Exécuter partiellement si handler existe, sinon mock
            if action['handler']:
                try:
                    result = action['handler'](value)
                    result['action_status'] = 'in_progress'
                    result['warning'] = '🛠️ Fonction en cours de développement'
                except Exception as e:
                    result = {"status": "warning", "message": f"🛠️ {action['description']} — Erreur partielle: {e}", "action_status": "in_progress"}
            else:
                result = {
                    "status": "warning",
                    "message": f"🛠️ {action['description']} — En cours de développement",
                    "action_status": "in_progress"
                }
        
        else:  # PLANNED
            result = {
                "status": "info",
                "message": f"⏳ {action['description']} — Fonction planifiée, pas encore disponible",
                "action_status": "planned"
            }
        
        result['action'] = action_name
        self._log_action(action_name, result)
        return result
    
    def get_status(self) -> Dict[str, Any]:
        """Retourne le statut de toutes les actions"""
        actions = {}
        for name, info in self._actions.items():
            actions[name] = {
                "status": info['status'].value,
                "description": info['description'],
                "category": info['category'],
            }
        return {
            "status": "ok",
            "actions": actions,
            "summary": self._count_by_status()
        }
    
    def get_log(self, limit: int = 20) -> List[Dict[str, Any]]:
        """Retourne les dernières actions exécutées"""
        return list(self._action_log)[-limit:]
    
    def get_available_functions(self) -> List[Dict[str, str]]:
        """Retourne la liste des fonctions disponibles pour le mapping"""
        functions = []
        for name, info in self._actions.items():
            functions.append({
                "name": name,
                "description": info['description'],
                "category": info['category'],
                "status": info['status'].value,
            })
        return functions
    
    # ==========================================================
    # ACTIONS IMPLÉMENTÉES
    # ==========================================================
    
    def _action_photo(self, value):
        """Prendre une photo via le video_streamer"""
        if self.video_streamer:
            path = self.video_streamer.take_photo()
            if path:
                return {"status": "ok", "message": f"📷 Photo enregistrée : {path}"}
            return {"status": "error", "message": "❌ Erreur lors de la prise de photo"}
        return {"status": "error", "message": "❌ Video streamer non disponible"}
    
    def _action_video_toggle(self, value):
        """Démarrer/Arrêter l'enregistrement vidéo"""
        if not self.video_streamer:
            return {"status": "error", "message": "❌ Video streamer non disponible"}
        
        if self.rov_state.get('recording', False):
            self.video_streamer.stop_recording()
            self.rov_state['recording'] = False
            return {"status": "ok", "message": "⏹️ Enregistrement arrêté"}
        else:
            self.video_streamer.start_recording()
            self.rov_state['recording'] = True
            return {"status": "ok", "message": "🔴 Enregistrement démarré"}

    def _action_video_osd_toggle(self, value):
        """Démarrer/Arrêter l'enregistrement vidéo AVEC OSD"""
        if not self.video_streamer:
            return {"status": "error", "message": "❌ Video streamer non disponible"}
        if self.rov_state.get('recording', False):
            self.video_streamer.stop_recording()
            self.rov_state['recording'] = False
            return {"status": "ok", "message": "⏹️ Enregistrement arrêté"}
        else:
            self.video_streamer.start_recording(with_osd=True)
            self.rov_state['recording'] = True
            return {"status": "ok", "message": "🔴 Enregistrement démarré (avec OSD)"}

    def _action_video_no_osd_toggle(self, value):
        """Démarrer/Arrêter l'enregistrement vidéo SANS OSD"""
        if not self.video_streamer:
            return {"status": "error", "message": "❌ Video streamer non disponible"}
        if self.rov_state.get('recording', False):
            self.video_streamer.stop_recording()
            self.rov_state['recording'] = False
            return {"status": "ok", "message": "⏹️ Enregistrement arrêté"}
        else:
            self.video_streamer.start_recording(with_osd=False)
            self.rov_state['recording'] = True
            return {"status": "ok", "message": "🔴 Enregistrement démarré (sans OSD)"}

    def _action_photo_cam1_osd(self, value):
        """Photo Cam1 (caméra principale) avec OSD"""
        if not self.video_streamer:
            return {"status": "error", "message": "❌ Video streamer non disponible"}
        result = self.video_streamer.take_photo(with_osd=True)
        if result.get('status') == 'ok':
            return {"status": "ok", "message": "📷 Photo Cam1 (avec OSD)"}
        return result

    def _action_photo_cam1_no_osd(self, value):
        """Photo Cam1 (caméra principale) sans OSD"""
        if not self.video_streamer:
            return {"status": "error", "message": "❌ Video streamer non disponible"}
        result = self.video_streamer.take_photo(with_osd=False)
        if result.get('status') == 'ok':
            return {"status": "ok", "message": "📷 Photo Cam1 (sans OSD)"}
        return result

    def _action_photo_cam2_osd(self, value):
        """Photo Cam2 (PiP) avec OSD"""
        if not self.video_streamer:
            return {"status": "error", "message": "❌ Video streamer non disponible"}
        result = self.video_streamer.take_pip_photo(with_osd=True)
        if result.get('status') == 'ok':
            return {"status": "ok", "message": f"📷 {result.get('message', 'Photo Cam2 avec OSD')}"}
        return result

    def _action_photo_cam2_no_osd(self, value):
        """Photo Cam2 (PiP) sans OSD"""
        if not self.video_streamer:
            return {"status": "error", "message": "❌ Video streamer non disponible"}
        result = self.video_streamer.take_pip_photo(with_osd=False)
        if result.get('status') == 'ok':
            return {"status": "ok", "message": f"📷 {result.get('message', 'Photo Cam2 sans OSD')}"}
        return result
    
    def _action_arm(self, value):
        """Armer le ROV"""
        self.rov_state['armed'] = True
        return {"status": "ok", "message": "🟢 ROV armé"}
    
    def _action_disarm(self, value):
        """Désarmer le ROV — stoppe tous les axes"""
        self.rov_state['armed'] = False
        # Remise à zéro de tous les axes DOF (y compris roll/pitch simulation)
        for axis in self._dof_state:
            self._dof_state[axis] = 0.0
        self._apply_dof_state()
        return {"status": "ok", "message": "🔴 ROV désarmé"}

    def _action_arm_toggle(self, value):
        """Bascule Armer / Désarmer (1er appui = arme, 2e = désarme)"""
        if self.rov_state.get('armed', False):
            return self._action_disarm(value)
        return self._action_arm(value)
    
    def _action_emergency_stop(self, value):
        """Arrêt d'urgence — désarme et coupe tout"""
        self.rov_state['armed'] = False
        self.rov_state['light'] = 0
        # Remise à zéro de tous les axes DOF (y compris roll/pitch simulation)
        for axis in self._dof_state:
            self._dof_state[axis] = 0.0
        self._apply_dof_state()
        return {"status": "ok", "message": "🚨 ARRÊT D'URGENCE — ROV désarmé"}
    
    def _action_reset_position(self, value):
        """Réinitialiser la position — remet tous les axes DOF à zéro"""
        for axis in self._dof_state:
            self._dof_state[axis] = 0.0
        self._apply_dof_state()
        return {"status": "ok", "message": "🔄 Position réinitialisée"}
    
    # === IN_PROGRESS ===
    
    def _action_light_toggle(self, value):
        """Basculer l'éclairage LED (en développement)"""
        current = self.rov_state.get('light', 0)
        if current > 0:
            self.rov_state['light'] = 0
            return {"status": "ok", "message": "💡 Éclairage éteint"}
        else:
            self.rov_state['light'] = 100
            return {"status": "ok", "message": "💡 Éclairage allumé (100%)"}
    
    def _action_autolevel_toggle(self, value):
        """Activer/Désactiver l'assiette automatique — bascule le mode Auto-Pilote
        entre PASSIF (1) et AUTO-ROLL (2), transmet via I2C à l'ESP32-S3."""
        current = self.rov_state.get('autopilot_mode', 1)
        # Bascule : PASSIF → AUTO-ROLL, AUTO-ROLL/AUTO-FULL → PASSIF
        new_mode = 1 if current >= 2 else 2
        self.rov_state['autopilot_mode'] = new_mode
        state = "activée (AUTO-ROLL)" if new_mode >= 2 else "désactivée (PASSIF)"
        logger.info(f"Auto-Pilote basculé : mode {current} → {new_mode} ({state})")
        return {"status": "ok", "message": f"⚖️ Assiette automatique {state}", "mode": new_mode}

    def _action_read_sensors(self, value):
        """Lecture complète des capteurs environnement et IMU — retourne toutes
        les valeurs courantes (profondeur, température, pression, cap, roulis, tangage)."""
        if not self._sensor_manager:
            return {"status": "warning", "message": "📡 SensorManager non disponible"}

        data = self._sensor_manager.get_data()
        readings = {
            'depth': round(data.get('depth', 0.0), 2),
            'temperature': round(data.get('temperature', 20.0), 2),
            'pressure': round(data.get('pressure', 1013.25), 1),
            'heading': round(data.get('heading', 0.0), 1),
            'roll': round(data.get('roll', 0.0), 2),
            'pitch': round(data.get('pitch', 0.0), 2),
            'battery': round(data.get('battery', 100.0), 1),
        }
        summary = (
            f"📡 Prof={readings['depth']}m "
            f"T={readings['temperature']}°C "
            f"P={readings['pressure']}hPa "
            f"Cap={readings['heading']}° "
            f"R/P={readings['roll']}/{readings['pitch']}°"
        )
        logger.info(f"Lecture capteurs : {summary}")
        return {"status": "ok", "message": summary, "readings": readings}
    
    # ==========================================================
    # SETTERS — Connexion des composants externes
    # ==========================================================

    def set_motor_manager(self, motor_manager):
        """Connecte le gestionnaire de moteurs"""
        self._motor_manager = motor_manager

    def set_i2c_controller(self, controller):
        """Connecte le contrôleur I2C"""
        self._i2c_controller = controller

    def set_sensor_manager(self, sensor_manager):
        """Connecte le gestionnaire de capteurs"""
        self._sensor_manager = sensor_manager

    # ==========================================================
    # MOUVEMENT 6DOF — execute_move et handlers analogiques
    # ==========================================================

    def execute_move(self, surge: float, sway: float, yaw: float,
                     heave: float, roll: float, pitch: float) -> Dict[str, Any]:
        """Exécute un mouvement 6DOF complet : mixage moteurs + envoi I2C"""
        # Stocker état DOF
        self._dof_state['surge'] = max(-1.0, min(1.0, surge))
        self._dof_state['sway'] = max(-1.0, min(1.0, sway))
        self._dof_state['yaw'] = max(-1.0, min(1.0, yaw))
        self._dof_state['heave'] = max(-1.0, min(1.0, heave))
        self._dof_state['roll'] = max(-1.0, min(1.0, roll))
        self._dof_state['pitch'] = max(-1.0, min(1.0, pitch))

        # Calcul mixage moteurs pour OSD
        motors = self._motor_mixer.mix(surge, sway, yaw, heave, roll, pitch)

        # Mise à jour OSD (non-bloquant)
        if self._motor_manager:
            self._motor_manager.set_all_thrust(motors)

        # Envoi canaux I2C (non-bloquant via queue).
        # L'ESP32-S3 (émulation PCA9685) pilote 8 ESC/moteurs sur les canaux
        # PWM 0..7. Numérotation officielle (avant-droit, sens horaire strict) :
        #   M1..M4 (Horizontaux : Av-D, Ar-D, Ar-G, Av-G) → ch0..3
        #   M5..M8 (Verticaux   : Av-D, Ar-D, Ar-G, Av-G) → ch4..7
        # Les canaux 13 (pitch IMU), 14 (mode Auto-Pilote) et 15 (roll IMU)
        # sont réservés et alimentés par la boucle autopilote du serveur.
        if self._i2c_controller:
            channels = {motor_id - 1: thrust for motor_id, thrust in motors.items()}
            logger.info(
                "MOVE consigne surge=%.2f sway=%.2f yaw=%.2f heave=%.2f roll=%.2f pitch=%.2f → %s",
                self._dof_state['surge'], self._dof_state['sway'], self._dof_state['yaw'],
                self._dof_state['heave'], self._dof_state['roll'], self._dof_state['pitch'],
                {f"M{mid}(ch{mid - 1})": round(t, 3) for mid, t in motors.items()}
            )
            self._i2c_controller.queue_send(channels)

        return {'status': 'ok', 'motors': motors}

    def get_dof_state(self) -> Dict[str, float]:
        """Retourne une copie de l'état 6DOF courant (consignes manette).

        Utilisé par le visualiseur 3D pour animer l'orientation et les
        translations du modèle en temps réel. Lecture seule.
        """
        return dict(self._dof_state)

    def _apply_dof_state(self):
        """Applique l'état 6DOF courant : mixage + envoi"""
        self.execute_move(
            self._dof_state['surge'],
            self._dof_state['sway'],
            self._dof_state['yaw'],
            self._dof_state['heave'],
            self._dof_state['roll'],
            self._dof_state['pitch']
        )

    def _action_forward_backward(self, value=1.0):
        """Handler axe avant/arrière analogique"""
        surge = max(-1.0, min(1.0, float(value)))
        self._dof_state['surge'] = surge
        self._apply_dof_state()
        return {'status': 'ok', 'axis': 'surge', 'value': surge}

    def _action_lateral(self, value=1.0):
        """Handler axe latéral analogique"""
        sway = max(-1.0, min(1.0, float(value)))
        self._dof_state['sway'] = sway
        self._apply_dof_state()
        return {'status': 'ok', 'axis': 'sway', 'value': sway}

    def _action_vertical(self, value=1.0):
        """Handler axe vertical analogique"""
        heave = max(-1.0, min(1.0, float(value)))
        self._dof_state['heave'] = heave
        self._apply_dof_state()
        return {'status': 'ok', 'axis': 'heave', 'value': heave}

    def _action_turn(self, value=1.0):
        """Handler axe rotation analogique"""
        yaw = max(-1.0, min(1.0, float(value)))
        self._dof_state['yaw'] = yaw
        self._apply_dof_state()
        return {'status': 'ok', 'axis': 'yaw', 'value': yaw}

    def _action_ascent(self, value=1.0):
        """Handler montée (gâchette)"""
        heave = max(0.0, min(1.0, float(value)))
        self._dof_state['heave'] = heave
        self._apply_dof_state()
        return {'status': 'ok', 'axis': 'heave', 'value': heave}

    def _action_descent(self, value=1.0):
        """Handler descente (gâchette)"""
        heave = -max(0.0, min(1.0, float(value)))
        self._dof_state['heave'] = heave
        self._apply_dof_state()
        return {'status': 'ok', 'axis': 'heave', 'value': heave}

    def _action_roll(self, value=1.0):
        """Handler axe roulis analogique (simulation/OSD uniquement, pas de moteurs)"""
        roll = max(-1.0, min(1.0, float(value)))
        self._dof_state['roll'] = roll
        # Calcul mixage OSD uniquement — pas d'envoi I2C moteurs
        if self._motor_manager:
            motors = self._motor_mixer.mix(
                self._dof_state['surge'], self._dof_state['sway'],
                self._dof_state['yaw'], self._dof_state['heave'],
                roll, self._dof_state['pitch']
            )
            self._motor_manager.set_all_thrust(motors)
        return {'status': 'ok', 'axis': 'roll', 'value': roll}

    def _action_pitch(self, value=1.0):
        """Handler axe tangage analogique (simulation/OSD uniquement, pas de moteurs)"""
        pitch = max(-1.0, min(1.0, float(value)))
        self._dof_state['pitch'] = pitch
        # Calcul mixage OSD uniquement — pas d'envoi I2C moteurs
        if self._motor_manager:
            motors = self._motor_mixer.mix(
                self._dof_state['surge'], self._dof_state['sway'],
                self._dof_state['yaw'], self._dof_state['heave'],
                self._dof_state['roll'], pitch
            )
            self._motor_manager.set_all_thrust(motors)
        return {'status': 'ok', 'axis': 'pitch', 'value': pitch}

    # ==========================================================
    # UTILITAIRES
    # ==========================================================
    
    def _log_action(self, action_name: str, result: Dict[str, Any]):
        """Enregistre une action dans le journal"""
        entry = {
            "timestamp": time.time(),
            "action": action_name,
            "status": result.get("status", "unknown"),
            "message": result.get("message", ""),
            "action_status": result.get("action_status", "unknown"),
        }
        with self._lock:
            self._action_log.append(entry)
    
    def _count_by_status(self) -> Dict[str, int]:
        """Compte les actions par statut"""
        counts = {"implemented": 0, "in_progress": 0, "planned": 0}
        for info in self._actions.values():
            counts[info['status'].value] += 1
        return counts
