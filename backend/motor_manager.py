"""
BOB-ROV — Gestionnaire des 8 moteurs (propulseurs)
Configuration en X : 4 horizontaux + 4 verticaux
"""
import logging
import threading
from typing import Dict, List, Any

logger = logging.getLogger(__name__)


class MotorManager:
    """Gère l'état des 8 propulseurs du ROV"""

    # Numérotation officielle : départ avant-droit, sens horaire strict :
    # M1-M4 : Horizontaux (canaux I2C 0..3) — Surge / Sway / Yaw
    # M5-M8 : Verticaux   (canaux I2C 4..7) — Heave / Roll / Pitch
    MOTOR_NAMES = {
        1: "M1: Horiz Av-D",   # Horizontal Avant-Droit    (ch0)
        2: "M2: Horiz Ar-D",   # Horizontal Arrière-Droit  (ch1)
        3: "M3: Horiz Ar-G",   # Horizontal Arrière-Gauche (ch2)
        4: "M4: Horiz Av-G",   # Horizontal Avant-Gauche   (ch3)
        5: "M5: Vert Av-D",    # Vertical Avant-Droit    (ch4)
        6: "M6: Vert Ar-D",    # Vertical Arrière-Droit  (ch5)
        7: "M7: Vert Ar-G",    # Vertical Arrière-Gauche (ch6)
        8: "M8: Vert Av-G",    # Vertical Avant-Gauche   (ch7)
    }

    def __init__(self, config=None):
        self._lock = threading.Lock()
        self.config = config

        # État des moteurs : puissance de -1.0 à +1.0
        self._motors = {i: 0.0 for i in range(1, 9)}

        # Configuration depuis config.txt [MOTORS]
        self._enabled = True
        self._display_in_osd = True
        self._display_position = 'bottom-left'
        self._display_style = 'circles'  # 'circles' ou 'bars'

        if config and hasattr(config, 'config') and config.config.has_section('MOTORS'):
            section = dict(config.config['MOTORS'])
            self._enabled = section.get('enabled', 'True').lower() == 'true'
            self._display_in_osd = section.get('display_in_osd', 'True').lower() == 'true'
            self._display_position = section.get('display_position', 'bottom-left')
            self._display_style = section.get('display_style', 'circles')

        # Contrôleur I2C (optionnel, pour usage futur)
        self._i2c_controller = None

        logger.info(f"MotorManager initialisé ({8} moteurs, style={self._display_style})")

    def set_i2c_controller(self, controller):
        """Connecte le contrôleur I2C pour envoi hardware"""
        self._i2c_controller = controller
        logger.info("I2C Controller connecté au MotorManager")

    def set_thrust(self, motor_id: int, value: float):
        """Définir la puissance d'un moteur (-1.0 à +1.0)"""
        if motor_id < 1 or motor_id > 8:
            return
        value = max(-1.0, min(1.0, float(value)))
        with self._lock:
            self._motors[motor_id] = value

    def set_all_thrust(self, values: Dict[int, float]):
        """Définir la puissance de plusieurs moteurs"""
        with self._lock:
            for motor_id, value in values.items():
                mid = int(motor_id)
                if 1 <= mid <= 8:
                    self._motors[mid] = max(-1.0, min(1.0, float(value)))

    def stop_all(self):
        """Arrêter tous les moteurs"""
        with self._lock:
            for i in range(1, 9):
                self._motors[i] = 0.0
        logger.info("Tous les moteurs arrêtés")

    def get_motor_data(self) -> List[Dict[str, Any]]:
        """Retourne l'état de tous les moteurs pour l'OSD (ordre M1..M8)"""
        with self._lock:
            return [
                {
                    "id": i,
                    "name": self.MOTOR_NAMES[i],
                    "group": "horizontal" if i <= 4 else "vertical",
                    "channel": i - 1,
                    "thrust": self._motors[i],
                    "percent": int(abs(self._motors[i]) * 100),
                    "direction": "forward" if self._motors[i] > 0 else "reverse" if self._motors[i] < 0 else "stop",
                }
                for i in range(1, 9)
            ]

    def get_status(self) -> Dict[str, Any]:
        """Retourne l'état complet pour l'API"""
        return {
            "status": "ok",
            "enabled": self._enabled,
            "display_in_osd": self._display_in_osd,
            "display_position": self._display_position,
            "display_style": self._display_style,
            "motors": self.get_motor_data(),
        }

    @property
    def enabled(self) -> bool:
        return self._enabled

    @property
    def display_in_osd(self) -> bool:
        return self._display_in_osd

    @property
    def display_style(self) -> str:
        return self._display_style

    @property
    def display_position(self) -> str:
        return self._display_position
