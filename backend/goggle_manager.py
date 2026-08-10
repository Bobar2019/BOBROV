"""
BOB-ROV — Gestionnaire du mode Lunette (FPV/VR)
Gère l'état du mode immersif, le switch de profil manette,
et la configuration OSD adaptée.
"""
import logging
import threading
from typing import Dict, Any, Optional

logger = logging.getLogger(__name__)


class GoggleManager:
    """Gère le mode Lunette (FPV/VR) du ROV"""

    def __init__(self, config, gamepad_manager=None, video_streamer=None):
        self._lock = threading.Lock()
        self.config = config
        self.gamepad_manager = gamepad_manager
        self.video_streamer = video_streamer

        # État du mode lunette
        self._active = False
        self._night_mode = False
        self._previous_profile = None  # Profil avant activation

        # Configuration depuis config.txt [GOGGLE]
        goggle_cfg = {}
        if config.config.has_section('GOGGLE'):
            goggle_cfg = config.get_section('GOGGLE')

        self._enabled = goggle_cfg.get('enabled', 'True').lower() == 'true'
        self._osd_scale = float(goggle_cfg.get('osd_scale', '2.0'))
        self._crosshair_enabled = goggle_cfg.get('crosshair_enabled', 'True').lower() == 'true'
        self._crosshair_color = goggle_cfg.get('crosshair_color', '#00ff88')
        self._auto_profile = goggle_cfg.get('auto_profile', 'Lunette')
        self._auto_exit_profile = goggle_cfg.get('auto_exit_profile', 'Standard')
        self._inactivity_timeout = int(goggle_cfg.get('inactivity_timeout', '3'))

        logger.info(f"GoggleManager initialisé (enabled={self._enabled}, auto_profile={self._auto_profile})")

    def activate(self) -> Dict[str, Any]:
        """Active le mode lunette + charge le profil dédié"""
        if not self._enabled:
            return {"status": "error", "message": "Mode lunette désactivé dans la configuration"}

        with self._lock:
            if self._active:
                return {"status": "ok", "message": "Mode lunette déjà actif", "already_active": True}

            # Sauvegarder le profil actuel
            if self.gamepad_manager:
                current = self.gamepad_manager.get_active_profile()
                if current:
                    self._previous_profile = current.get('name', self._auto_exit_profile)

                # Charger le profil Lunette
                result = self.gamepad_manager.set_active_profile(self._auto_profile)
                if result.get('status') != 'ok':
                    logger.warning(f"Impossible de charger le profil {self._auto_profile}: {result}")

            # Activer l'OSD mode lunette
            if self.video_streamer and hasattr(self.video_streamer, 'set_osd_scale'):
                self.video_streamer.set_osd_scale(self._osd_scale)

            self._active = True
            logger.info("🥽 Mode lunette activé")

            return {
                "status": "ok",
                "message": "🥽 Mode lunette activé",
                "profile": self._auto_profile,
                "previous_profile": self._previous_profile,
                "night_mode": self._night_mode,
                "osd_scale": self._osd_scale,
                "crosshair": self._crosshair_enabled,
            }

    def deactivate(self) -> Dict[str, Any]:
        """Désactive le mode lunette + restaure le profil précédent"""
        with self._lock:
            if not self._active:
                return {"status": "ok", "message": "Mode lunette déjà inactif"}

            # Restaurer le profil précédent
            restore_profile = self._previous_profile or self._auto_exit_profile
            if self.gamepad_manager:
                self.gamepad_manager.set_active_profile(restore_profile)

            # Restaurer l'OSD normal
            if self.video_streamer and hasattr(self.video_streamer, 'set_osd_scale'):
                self.video_streamer.set_osd_scale(1.0)

            self._active = False
            self._night_mode = False
            self._previous_profile = None
            logger.info("🥽 Mode lunette désactivé")

            return {
                "status": "ok",
                "message": "Mode lunette désactivé",
                "restored_profile": restore_profile,
            }

    def toggle_night(self) -> Dict[str, Any]:
        """Bascule le mode nuit"""
        with self._lock:
            self._night_mode = not self._night_mode
            state = "activé" if self._night_mode else "désactivé"
            logger.info(f"🌙 Mode nuit {state}")
            return {
                "status": "ok",
                "night_mode": self._night_mode,
                "message": f"🌙 Mode nuit {state}",
            }

    def get_status(self) -> Dict[str, Any]:
        """Retourne l'état complet du mode lunette"""
        return {
            "status": "ok",
            "active": self._active,
            "enabled": self._enabled,
            "night_mode": self._night_mode,
            "osd_scale": self._osd_scale,
            "crosshair_enabled": self._crosshair_enabled,
            "crosshair_color": self._crosshair_color,
            "auto_profile": self._auto_profile,
            "inactivity_timeout": self._inactivity_timeout,
            "current_profile": self._auto_profile if self._active else None,
            "previous_profile": self._previous_profile,
        }

    @property
    def is_active(self) -> bool:
        return self._active

    @property
    def is_night_mode(self) -> bool:
        return self._night_mode
