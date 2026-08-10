"""
Module de gestion de la configuration pour Cockpit-Lite ROV.
Parse et valide le fichier config.txt, avec préservation des commentaires.
"""

import configparser
import os
import threading
from typing import Dict, Any, Optional, List
import logging

logger = logging.getLogger(__name__)


class ConfigParser:
    """
    Gestionnaire de configuration thread-safe pour Cockpit-Lite ROV.
    Supporte la lecture, l'écriture et la validation du fichier config.txt.
    """

    def __init__(self, config_path: str = "config.txt"):
        self.config_path = config_path
        self.config = configparser.ConfigParser()
        self._lock = threading.Lock()
        self.defaults = self._get_defaults()
        self._comments: List[str] = []  # Commentaires d'en-tête
        self.load()

    def _get_defaults(self) -> Dict[str, Dict[str, Any]]:
        """Retourne les valeurs par défaut pour chaque section"""
        return {
            "SERVER": {
                "port": 8080,
                "websocket_port": 8081,
                "log_level": "INFO"
            },
            "CAMERA": {
                "device": "/dev/video0",
                "width": 1280,
                "height": 720,
                "fps": 30,
                "format": "MJPEG",
                "osd_enabled": True
            },
            "TELEMETRY": {
                "i2c_bus": 1,
                "depth_sensor_i2c_addr": "0x76",
                "imu_i2c_addr": "0x68",
                "update_frequency_hz": 20,
                "simulation_mode": True,
                "adxl345_enabled": False,
                "adxl345_i2c_addr": "0x53",
                "sim_depth": True,
                "sim_temperature": True,
                "sim_heading": True,
                "sim_battery": True,
                "sim_roll": True,
                "sim_pitch": True
            },
            "IMU": {
                "sensor_type": "QMI8658",
                "i2c_bus": 1,
                "i2c_address": "0x6B",
                "update_rate_hz": 50,
                "complementary_alpha": 0.98
            },
            "OSD_DISPLAY": {
                "show_horizon": True,
                "show_depth": True,
                "show_temperature": True,
                "show_battery": True,
                "show_compass": True,
                "show_fps": True,
                "primary_color": "#00FF00",
                "horizon_color": "#00FF88",
                "depth_color": "#00AAFF",
                "temperature_color": "#FFAA00",
                "compass_color": "#FFFFFF",
                "battery_color": "#00CC44",
                "fps_color": "#FFFFFF",
                "font_scale": 0.8,
                "opacity": 100,
                "horizon_opacity": 100,
                "depth_opacity": 100,
                "temperature_opacity": 100,
                "compass_opacity": 100,
                "battery_opacity": 100,
                "horizon_x": 50,
                "horizon_y": 50,
                "depth_x": 3,
                "depth_y": 15,
                "temperature_x": 88,
                "temperature_y": 5,
                "compass_x": 50,
                "compass_y": 92,
                "battery_x": 88,
                "battery_y": 12,
                "fps_x": 2,
                "fps_y": 82,
                "horizon_line_thick": 2,
                "horizon_circle_opacity": 15,
                "horizon_radius_pct": 18,
                "horizon_wing_color": "#FFFF00",
                "horizon_show_text": True,
                "horizon_pitch_scale": 2,
                "horizon_border_opacity": 25,
                "horizon_clip": False,
                "horizon_damping": 5,
                "show_motors": True,
                "show_rov3d": True,
                "motors_opacity": 100,
                "rov3d_opacity": 100
            },
            "ROV_CONTROL": {
                "max_thrust": 100,
                "light_default_brightness": 0,
                "armed": False
            },
            "RECORDING": {
                "video_resolution": "1280x720",
                "photo_resolution": "1920x1080",
                "output_dir": "recordings",
                "video_codec": "mp4v",
                "photo_quality": 95,
                "video_fps": 15,
                "video_with_osd": True,
                "photo_with_osd": True
            },
            "CAMERA2": {
                "enabled": False,
                "device": "/dev/video2",
                "width": 640,
                "height": 480,
                "fps": 15,
                "pip_position": "top-right",
                "pip_size": "small",
                "pip_enabled": False
            },
            "THEME": {
                "mode": "night"
            }
        }

    def load(self):
        """Charge la configuration depuis le fichier"""
        with self._lock:
            if os.path.exists(self.config_path):
                try:
                    # Lire les commentaires d'en-tête avant le parsing
                    self._read_header_comments()
                    self.config.read(self.config_path)
                    self._apply_defaults()
                    logger.info(f"Configuration chargée depuis {self.config_path}")
                except Exception as e:
                    logger.error(f"Erreur lors du chargement de la config: {e}")
                    self._create_default_config()
            else:
                logger.warning(f"Fichier {self.config_path} non trouvé, création des defaults")
                self._create_default_config()

    def _read_header_comments(self):
        """Lit les commentaires d'en-tête du fichier pour les préserver"""
        self._comments = []
        try:
            with open(self.config_path, 'r') as f:
                for line in f:
                    stripped = line.strip()
                    if stripped.startswith('#') or stripped == '':
                        self._comments.append(line.rstrip('\n'))
                    else:
                        break
        except Exception:
            pass

    def _apply_defaults(self):
        """Applique les valeurs par défaut pour les clés manquantes"""
        for section, values in self.defaults.items():
            if not self.config.has_section(section):
                self.config.add_section(section)
            for key, default_value in values.items():
                if not self.config.has_option(section, key):
                    self.config.set(section, key, str(default_value))
                    logger.debug(f"Default appliqué: [{section}] {key} = {default_value}")

    def _create_default_config(self):
        """Crée un fichier de configuration par défaut"""
        self.config = configparser.ConfigParser()
        for section, values in self.defaults.items():
            self.config.add_section(section)
            for key, value in values.items():
                self.config.set(section, key, str(value))
        self._comments = [
            "# ==========================================================",
            "# CONFIGURATION GENERALE COCKPIT-LITE ROV",
            "# ==========================================================",
            ""
        ]
        self.save()

    def save(self):
        """Sauvegarde la configuration dans le fichier en préservant les commentaires"""
        with self._lock:
            try:
                with open(self.config_path, 'w') as f:
                    # Écrire les commentaires d'en-tête
                    if self._comments:
                        for comment in self._comments:
                            f.write(comment + '\n')
                    else:
                        f.write("# ==========================================================\n")
                        f.write("# CONFIGURATION GENERALE COCKPIT-LITE ROV\n")
                        f.write("# ==========================================================\n\n")
                    # Écrire les sections
                    self.config.write(f)
                logger.info(f"Configuration sauvegardée dans {self.config_path}")
            except Exception as e:
                logger.error(f"Erreur lors de la sauvegarde: {e}")

    def get(self, section: str, key: str, fallback: Any = None) -> Any:
        """
        Récupère une valeur de configuration avec conversion de type automatique.
        Utilise les defaults pour déterminer le type attendu.
        """
        try:
            value = self.config.get(section, key)
            # Déterminer le type depuis les defaults
            default = self.defaults.get(section, {}).get(key)
            if isinstance(default, bool):
                return value.lower() in ('true', '1', 'yes', 'on')
            elif isinstance(default, int):
                return int(value)
            elif isinstance(default, float):
                return float(value)
            else:
                return value
        except (configparser.NoSectionError, configparser.NoOptionError):
            if fallback is not None:
                return fallback
            # Retourner la valeur par défaut si elle existe
            return self.defaults.get(section, {}).get(key)
        except (ValueError, TypeError) as e:
            logger.warning(f"Erreur de conversion pour [{section}] {key}: {e}")
            return self.defaults.get(section, {}).get(key, fallback)

    def set(self, section: str, key: str, value: Any):
        """Définit une valeur de configuration et sauvegarde"""
        with self._lock:
            if not self.config.has_section(section):
                self.config.add_section(section)
            self.config.set(section, key, str(value))
        self.save()

    def get_section(self, section: str) -> Dict[str, Any]:
        """Récupère toute une section avec types convertis"""
        result = {}
        defaults_section = self.defaults.get(section, {})
        try:
            for key in self.config.options(section):
                result[key] = self.get(section, key)
        except configparser.NoSectionError:
            result = defaults_section.copy()
        return result

    def get_all(self) -> Dict[str, Dict[str, Any]]:
        """Récupère toute la configuration avec types convertis"""
        result = {}
        all_sections = set(self.config.sections()) | set(self.defaults.keys())
        for section in all_sections:
            result[section] = self.get_section(section)
        return result

    def reload(self):
        """Recharge la configuration depuis le fichier"""
        with self._lock:
            self.config = configparser.ConfigParser()
        self.load()

    def get_camera_config(self) -> Dict[str, Any]:
        """Retourne la configuration caméra"""
        return self.get_section("CAMERA")

    def get_telemetry_config(self) -> Dict[str, Any]:
        """Retourne la configuration télémétrie"""
        return self.get_section("TELEMETRY")

    def get_imu_config(self) -> Dict[str, Any]:
        """Retourne la configuration IMU"""
        return self.get_section("IMU")

    def get_osd_config(self) -> Dict[str, Any]:
        """Retourne la configuration OSD"""
        return self.get_section("OSD_DISPLAY")

    def get_control_config(self) -> Dict[str, Any]:
        """Retourne la configuration contrôle"""
        return self.get_section("ROV_CONTROL")
