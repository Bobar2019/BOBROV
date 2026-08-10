"""
Module de contrôle des caméras V4L2 pour Cockpit-Lite ROV.
Permet de lire/écrire les paramètres d'image en temps réel via v4l2-ctl.
Supporte plusieurs caméras indépendamment.
"""

import subprocess
import re
import logging
import os
from typing import Dict, Any, Optional, List

logger = logging.getLogger(__name__)

# Définition des contrôles V4L2 avec leurs métadonnées
V4L2_CONTROLS = {
    'brightness': {
        'label': '🔆 Luminosité',
        'min': -10, 'max': 10, 'default': 0, 'step': 1
    },
    'contrast': {
        'label': '🎯 Contraste',
        'min': 1, 'max': 32, 'default': 16, 'step': 1
    },
    'saturation': {
        'label': '🎨 Saturation',
        'min': 0, 'max': 20, 'default': 10, 'step': 1
    },
    'hue': {
        'label': '🌡️ Teinte',
        'min': -5, 'max': 5, 'default': 0, 'step': 1
    },
    'gamma': {
        'label': '📷 Gamma',
        'min': 100, 'max': 200, 'default': 100, 'step': 10
    },
    'sharpness': {
        'label': '🔍 Netteté',
        'min': 0, 'max': 10, 'default': 5, 'step': 1
    },
    'exposure_absolute': {
        'label': '⚡ Exposition',
        'min': 156, 'max': 5000, 'default': 500, 'step': 50
    },
    'white_balance_temperature': {
        'label': '🎚️ Balance blancs',
        'min': 2800, 'max': 6500, 'default': 4600, 'step': 100
    },
    'white_balance_temperature_auto': {
        'label': '🔄 Balance blancs auto',
        'type': 'boolean', 'default': True
    },
    'exposure_auto': {
        'label': '📷 Auto-exposition',
        'type': 'boolean', 'default': True,
        'on_value': 3, 'off_value': 1  # V4L2: 3=auto, 1=manual
    }
}


class CameraControls:
    """
    Gestionnaire de paramètres V4L2 pour plusieurs caméras.
    Chaque caméra a ses propres réglages indépendants.
    """

    def __init__(self, config_parser=None, camera_detector=None):
        """
        Initialise le gestionnaire de contrôles caméra.
        
        Args:
            config_parser: Référence au ConfigParser pour sauvegarder les préférences
            camera_detector: Instance de CameraDetector pour la détection optimisée
        """
        self.config_parser = config_parser
        self._camera_detector = camera_detector
        self._available_controls: Dict[str, List[str]] = {}  # device -> liste de contrôles supportés

    def list_devices(self) -> List[Dict[str, str]]:
        """Liste toutes les caméras USB détectées via CameraDetector"""
        if self._camera_detector:
            return self._camera_detector.list_usb_cameras()
        # Fallback si pas de CameraDetector injecté
        return self._list_devices_fallback()

    def _list_devices_fallback(self) -> List[Dict[str, str]]:
        """Fallback de détection caméras (sans CameraDetector)"""
        devices = []
        try:
            result = subprocess.run(
                ['v4l2-ctl', '--list-devices'],
                capture_output=True, text=True, timeout=5
            )
            if result.returncode == 0:
                current_name = None
                for line in result.stdout.strip().split('\n'):
                    line = line.strip()
                    if line and not line.startswith('/'):
                        current_name = line
                    elif line.startswith('/dev/video'):
                        # Ne garder que les vrais périphériques de capture (pas les metadata)
                        devices.append({
                            'path': line,
                            'name': current_name or f'Video {line[-1]}'
                        })
        except FileNotFoundError:
            logger.warning("v4l2-ctl non disponible")
        except Exception as e:
            logger.error(f"Erreur détection caméras: {e}")

        # Fallback : scanner /dev/video*
        if not devices:
            for i in range(10):
                path = f"/dev/video{i}"
                if os.path.exists(path):
                    devices.append({'path': path, 'name': f'Video {i}'})

        return devices

    def get_available_controls(self, device: str) -> Dict[str, Dict[str, Any]]:
        """
        Retourne les contrôles V4L2 disponibles pour une caméra donnée,
        avec leurs valeurs actuelles.
        """
        controls = {}
        try:
            result = subprocess.run(
                ['v4l2-ctl', '-d', device, '-l'],
                capture_output=True, text=True, timeout=5
            )
            if result.returncode != 0:
                return controls

            # Parser la sortie de v4l2-ctl -l
            # Format typique: "brightness 0x00980900 (int) : min=-10 max=10 step=1 default=0 value=0"
            # ou: "white_balance_temperature_auto 0x0098090c (bool) : default=1 value=1"
            for line in result.stdout.split('\n'):
                line = line.strip()
                if not line:
                    continue

                # Extraire le nom du contrôle
                parts = line.split()
                if len(parts) < 4:
                    continue

                ctrl_name = parts[0]
                # Vérifier si c'est un contrôle qu'on gère
                if ctrl_name in V4L2_CONTROLS:
                    meta = V4L2_CONTROLS[ctrl_name].copy()
                    # Extraire la valeur actuelle
                    value_match = re.search(r'value=(-?\d+)', line)
                    if value_match:
                        raw_val = int(value_match.group(1))
                        # Pour les booléens avec valeurs custom (exposure_auto)
                        if meta.get('type') == 'boolean':
                            if 'on_value' in meta:
                                meta['value'] = (raw_val == meta['on_value'])
                            else:
                                meta['value'] = bool(raw_val)
                        else:
                            meta['value'] = raw_val
                    controls[ctrl_name] = meta

            # Stocker les contrôles disponibles pour ce device
            self._available_controls[device] = list(controls.keys())

        except FileNotFoundError:
            logger.warning("v4l2-ctl non disponible")
        except Exception as e:
            logger.error(f"Erreur lecture contrôles {device}: {e}")

        return controls

    def get_control_value(self, device: str, control: str) -> Optional[int]:
        """Lit la valeur actuelle d'un contrôle spécifique"""
        try:
            result = subprocess.run(
                ['v4l2-ctl', '-d', device, '--get-ctrl', control],
                capture_output=True, text=True, timeout=3
            )
            if result.returncode == 0:
                # Format: "control_name: value"
                match = re.search(r':\s*(-?\d+)', result.stdout)
                if match:
                    return int(match.group(1))
        except Exception as e:
            logger.debug(f"Erreur lecture {control} sur {device}: {e}")
        return None

    def set_control_value(self, device: str, control: str, value: Any) -> bool:
        """
        Applique une valeur à un contrôle V4L2 en temps réel.
        
        Args:
            device: Chemin du périphérique (ex: /dev/video0)
            control: Nom du contrôle V4L2
            value: Valeur à appliquer (int ou bool)
            
        Returns:
            True si appliqué avec succès
        """
        # Vérifier que le contrôle est connu
        if control not in V4L2_CONTROLS:
            logger.warning(f"Contrôle inconnu: {control}")
            return False

        meta = V4L2_CONTROLS[control]

        # Convertir les booléens
        if meta.get('type') == 'boolean':
            if 'on_value' in meta:
                # Contrôle spécial (ex: exposure_auto)
                int_value = meta['on_value'] if value else meta['off_value']
            else:
                int_value = 1 if value else 0
        else:
            int_value = int(value)
            # Clamper entre min et max
            int_value = max(meta.get('min', int_value), min(meta.get('max', int_value), int_value))

        try:
            result = subprocess.run(
                ['v4l2-ctl', '-d', device, '-c', f'{control}={int_value}'],
                capture_output=True, text=True, timeout=3
            )
            if result.returncode == 0:
                logger.info(f"[{device}] {control} = {int_value}")
                return True
            else:
                logger.warning(f"[{device}] Erreur {control}: {result.stderr.strip()}")
                return False
        except FileNotFoundError:
            logger.error("v4l2-ctl non disponible")
            return False
        except Exception as e:
            logger.error(f"[{device}] Erreur application {control}: {e}")
            return False

    def apply_controls(self, device: str, controls: Dict[str, Any]) -> Dict[str, bool]:
        """
        Applique plusieurs contrôles d'un coup à une caméra.
        
        Args:
            device: Chemin du périphérique
            controls: Dict {control_name: value}
            
        Returns:
            Dict {control_name: success_bool}
        """
        results = {}
        for ctrl_name, value in controls.items():
            results[ctrl_name] = self.set_control_value(device, ctrl_name, value)
        return results

    def reset_controls(self, device: str) -> Dict[str, bool]:
        """
        Réinitialise tous les contrôles à leurs valeurs par défaut.
        
        Args:
            device: Chemin du périphérique
            
        Returns:
            Dict {control_name: success_bool}
        """
        results = {}
        available = self.get_available_controls(device)
        for ctrl_name, meta in available.items():
            default = meta.get('default')
            if default is not None:
                results[ctrl_name] = self.set_control_value(device, ctrl_name, default)
        return results

    def get_defaults(self) -> Dict[str, Any]:
        """Retourne les valeurs par défaut de tous les contrôles"""
        defaults = {}
        for name, meta in V4L2_CONTROLS.items():
            defaults[name] = meta.get('default')
        return defaults
