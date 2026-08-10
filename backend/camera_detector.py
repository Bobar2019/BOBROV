"""
Détecteur de caméras USB — filtre les périphériques virtuels du Raspberry Pi 5.
Centralise la logique de détection pour éviter la duplication.
"""

import os
import subprocess
import time
import logging
from typing import List, Dict, Optional

logger = logging.getLogger(__name__)


class CameraDetector:
    """
    Détecte les caméras USB réellement connectées.
    Filtre les périphériques virtuels (pispbe, rpi-hevc-dec, etc.)
    et met en cache les résultats pour éviter les rescans inutiles.
    """

    # Patterns de noms de périphériques virtuels à exclure
    VIRTUAL_PATTERNS = ['pispbe', 'rpi-hevc-dec', 'rpivid-hevc', 'm2m', 'vim2m', 'vimc', 'bcm2835']

    def __init__(self, cache_ttl: float = 5.0):
        """
        Args:
            cache_ttl: Durée de vie du cache en secondes (défaut: 5s)
        """
        self._cache_ttl = cache_ttl
        self._cached_devices: List[Dict] = []
        self._cache_timestamp: float = 0.0

    def list_usb_cameras(self, force_refresh: bool = False) -> List[Dict]:
        """
        Liste les caméras USB réellement connectées.
        Utilise le cache sauf si force_refresh=True.

        Returns:
            Liste de dictionnaires:
            [{"path": "/dev/video0", "name": "...", "type": "USB", "driver": "...", "has_capture": True}]
        """
        # Vérifier le cache
        if not force_refresh and self._cached_devices:
            if (time.time() - self._cache_timestamp) < self._cache_ttl:
                return self._cached_devices

        # Scanner les périphériques
        devices = self._scan_devices()

        # Mettre à jour le cache
        self._cached_devices = devices
        self._cache_timestamp = time.time()

        return devices

    def _scan_devices(self) -> List[Dict]:
        """Scanne les périphériques vidéo et filtre les virtuels."""
        devices = []

        # Méthode 1 : v4l2-ctl --list-devices (rapide, structuré)
        try:
            result = subprocess.run(
                ['v4l2-ctl', '--list-devices'],
                capture_output=True, text=True, timeout=2
            )
            if result.returncode == 0:
                devices = self._parse_v4l2_output(result.stdout)
        except FileNotFoundError:
            logger.warning("v4l2-ctl non disponible, utilisation du fallback sysfs")
        except subprocess.TimeoutExpired:
            logger.warning("v4l2-ctl timeout (2s), utilisation du fallback sysfs")
        except Exception as e:
            logger.error(f"Erreur v4l2-ctl: {e}")

        # Fallback : scan sysfs + /dev/video*
        if not devices:
            devices = self._scan_sysfs_fallback()

        logger.info(f"Caméras détectées: {len(devices)} périphérique(s) USB réel(s)")
        return devices

    def _parse_v4l2_output(self, output: str) -> List[Dict]:
        """Parse la sortie de v4l2-ctl --list-devices et filtre les virtuels."""
        devices = []
        current_name = None

        for line in output.strip().split('\n'):
            line = line.strip()
            if not line:
                continue
            if not line.startswith('/'):
                # C'est un nom de périphérique (ex: "USB Camera (usb-...)")
                current_name = line.rstrip(':')
            elif line.startswith('/dev/video'):
                # Vérifier si le nom courant correspond à un périphérique virtuel
                if current_name and self._is_virtual_device_name(current_name):
                    continue

                # Vérifier via sysfs si c'est un vrai périphérique de capture
                if self._is_real_capture_device(line):
                    info = self._get_device_info(line, current_name)
                    if info:
                        devices.append(info)

        return devices

    def _is_virtual_device_name(self, name: str) -> bool:
        """Vérifie si le nom correspond à un périphérique virtuel connu."""
        name_lower = name.lower()
        return any(pattern in name_lower for pattern in self.VIRTUAL_PATTERNS)

    def _is_real_capture_device(self, device_path: str) -> bool:
        """
        Vérifie qu'un /dev/videoN est un vrai périphérique de capture vidéo.
        Utilise sysfs pour un check rapide avant d'appeler v4l2-ctl.
        """
        if not os.path.exists(device_path):
            return False

        # Check rapide via sysfs : lire le nom du driver/device
        dev_name = os.path.basename(device_path)  # "video0"
        sysfs_name_path = f"/sys/class/video4linux/{dev_name}/name"

        try:
            if os.path.exists(sysfs_name_path):
                with open(sysfs_name_path, 'r') as f:
                    sysfs_name = f.read().strip().lower()
                # Exclure les périphériques virtuels détectés via sysfs
                if any(pattern in sysfs_name for pattern in self.VIRTUAL_PATTERNS):
                    return False
        except (IOError, PermissionError):
            pass  # sysfs non disponible, continuer avec v4l2-ctl

        # Vérification v4l2-ctl : doit avoir la capability "Video Capture"
        try:
            result = subprocess.run(
                ['v4l2-ctl', '-d', device_path, '-D'],
                capture_output=True, text=True, timeout=1
            )
            if result.returncode == 0:
                if 'Video Capture' not in result.stdout:
                    return False
                return True
        except (subprocess.TimeoutExpired, FileNotFoundError, Exception):
            pass

        # En cas d'échec de v4l2-ctl, on accepte le device (prudence)
        return True

    def _get_device_info(self, path: str, name: Optional[str] = None) -> Optional[Dict]:
        """
        Récupère les informations enrichies d'un périphérique vidéo.

        Returns:
            Dict avec path, name, type, driver, has_capture ou None si invalide
        """
        dev_name = os.path.basename(path)
        driver = "inconnu"
        device_type = "USB"

        # Lire le driver via sysfs
        sysfs_device_path = f"/sys/class/video4linux/{dev_name}/device"
        if os.path.islink(sysfs_device_path):
            link_target = os.readlink(sysfs_device_path)
            if 'usb' in link_target.lower():
                device_type = "USB"
            elif 'platform' in link_target.lower():
                device_type = "Platform"

        # Lire le nom sysfs si pas fourni
        if not name:
            sysfs_name_path = f"/sys/class/video4linux/{dev_name}/name"
            try:
                if os.path.exists(sysfs_name_path):
                    with open(sysfs_name_path, 'r') as f:
                        name = f.read().strip()
            except (IOError, PermissionError):
                name = f"Video {dev_name}"

        # Lire le driver via v4l2-ctl (optionnel, non bloquant)
        try:
            result = subprocess.run(
                ['v4l2-ctl', '-d', path, '-D'],
                capture_output=True, text=True, timeout=1
            )
            if result.returncode == 0:
                for line in result.stdout.split('\n'):
                    if 'Driver name' in line:
                        driver = line.split(':', 1)[1].strip()
                        break
        except Exception:
            pass

        return {
            'path': path,
            'name': name or f"Video {dev_name}",
            'type': device_type,
            'driver': driver,
            'has_capture': True
        }

    def _scan_sysfs_fallback(self) -> List[Dict]:
        """
        Fallback : scanner /dev/video* en utilisant sysfs pour filtrer.
        Utilisé quand v4l2-ctl n'est pas disponible.
        """
        devices = []

        for i in range(20):
            path = f"/dev/video{i}"
            if not os.path.exists(path):
                continue

            dev_name = f"video{i}"
            sysfs_name_path = f"/sys/class/video4linux/{dev_name}/name"

            # Lire le nom sysfs
            sysfs_name = None
            try:
                if os.path.exists(sysfs_name_path):
                    with open(sysfs_name_path, 'r') as f:
                        sysfs_name = f.read().strip()
            except (IOError, PermissionError):
                pass

            # Filtrer les virtuels
            if sysfs_name and self._is_virtual_device_name(sysfs_name):
                logger.debug(f"Exclu (virtuel): {path} ({sysfs_name})")
                continue

            # Ajouter le device
            info = self._get_device_info(path, sysfs_name)
            if info:
                devices.append(info)

        return devices
