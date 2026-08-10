"""
Cockpit-Lite ROV — Gestionnaire principal manette
Orchestre les profils et l'état actif de la manette
"""
import logging
import threading
from typing import Dict, Any, Optional

from .gamepad_profiles import GamepadProfileManager

logger = logging.getLogger(__name__)


class GamepadManager:
    """Orchestrateur manette : profils + état actif + propagation config"""

    def __init__(self, config):
        """
        Args:
            config: Instance ConfigParser du projet
        """
        self._lock = threading.Lock()
        self.config = config

        # Charger la config gamepad depuis config.txt
        gamepad_cfg = {}
        if config.config.has_section('GAMEPAD'):
            gamepad_cfg = config.get_section('GAMEPAD')

        profile_dir = gamepad_cfg.get('profile_dir', 'profiles')
        self.enabled = gamepad_cfg.get('enabled', True)
        self.profile_manager = GamepadProfileManager(profile_dir)

        # Profil actif
        self._active_profile_name = gamepad_cfg.get('active_profile', 'Standard')
        self._active_profile = self.profile_manager.load_profile(self._active_profile_name)
        if not self._active_profile:
            # Fallback : prendre le premier profil disponible
            profiles = self.profile_manager.list_profiles()
            if profiles:
                self._active_profile_name = profiles[0]['name']
                self._active_profile = self.profile_manager.load_profile(self._active_profile_name)
                logger.warning(f"Profil actif non trouvé, fallback vers '{self._active_profile_name}'")

        logger.info(f"GamepadManager initialisé — profil actif: '{self._active_profile_name}'")

    def get_status(self) -> Dict[str, Any]:
        """Retourne l'état complet du gestionnaire manette"""
        with self._lock:
            return {
                "enabled": self.enabled,
                "active_profile": self._active_profile_name,
                "profile_count": len(self.profile_manager.list_profiles()),
                "has_active_profile": self._active_profile is not None
            }

    def get_active_profile(self) -> Optional[Dict[str, Any]]:
        """Retourne le profil actif complet"""
        with self._lock:
            return self._active_profile

    def set_active_profile(self, name: str) -> Dict[str, Any]:
        """Change le profil actif et met à jour config.txt"""
        profile = self.profile_manager.load_profile(name)
        if not profile:
            return {"status": "error", "message": f"Profil '{name}' non trouvé"}

        with self._lock:
            self._active_profile_name = name
            self._active_profile = profile

        # Persister dans config.txt
        self.config.set('GAMEPAD', 'active_profile', name)
        # Mettre à jour dans le profile_manager aussi
        self.profile_manager.set_active_profile(name)

        logger.info(f"Profil actif changé: '{name}'")
        return {"status": "ok", "message": f"Profil actif: '{name}'", "data": profile}

    def get_mapping(self) -> Dict[str, Any]:
        """Retourne le mapping du profil actif (axes, boutons ET settings)"""
        with self._lock:
            if self._active_profile:
                result = self._active_profile.get('mappings', {})
                # Inclure les settings (deadzone, sensibilité) pour le frontend
                settings = self._active_profile.get('settings', {})
                if settings:
                    result = dict(result)  # copie pour ne pas modifier l'original
                    result['settings'] = settings
                return result
            return {}

    def update_mapping(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """Met à jour le mapping du profil actif et sauvegarde"""
        with self._lock:
            if not self._active_profile:
                return {"status": "error", "message": "Aucun profil actif"}

            # Fusionner les données
            if 'buttons' in data:
                self._active_profile.setdefault('mappings', {})['buttons'] = data['buttons']
            if 'axes' in data:
                self._active_profile.setdefault('mappings', {})['axes'] = data['axes']

            name = self._active_profile_name

        # Sauvegarder le profil mis à jour
        result = self.profile_manager.save_profile(name, self._active_profile)
        if result.get('status') == 'ok':
            logger.info(f"Mapping du profil '{name}' mis à jour")
        return result

    # --- Délégation CRUD vers profile_manager ---

    def list_profiles(self):
        """Liste tous les profils disponibles"""
        return self.profile_manager.list_profiles()

    def load_profile(self, name: str):
        """Charge un profil par nom"""
        return self.profile_manager.load_profile(name)

    def save_profile(self, name: str, data: Dict[str, Any]):
        """Sauvegarde un profil"""
        result = self.profile_manager.save_profile(name, data)
        # Si c'est le profil actif qui est modifié, mettre à jour le cache
        if result.get('status') == 'ok' and name == self._active_profile_name:
            with self._lock:
                self._active_profile = self.profile_manager.load_profile(name)
        return result

    def delete_profile(self, name: str):
        """Supprime un profil"""
        result = self.profile_manager.delete_profile(name)
        # Si le profil actif a été supprimé, mettre à jour
        if result.get('status') == 'ok' and name == self._active_profile_name:
            with self._lock:
                profiles = self.profile_manager.list_profiles()
                if profiles:
                    self._active_profile_name = profiles[0]['name']
                    self._active_profile = self.profile_manager.load_profile(self._active_profile_name)
                    self.config.set('GAMEPAD', 'active_profile', self._active_profile_name)
        return result

    def export_profile(self, name: str):
        """Exporte un profil pour téléchargement"""
        return self.profile_manager.export_profile(name)

    def import_profile(self, data: Dict[str, Any]):
        """Importe un profil depuis un JSON"""
        return self.profile_manager.import_profile(data)

    # --- Méthodes pour le mode Lunette ---

    def get_previous_profile_name(self) -> Optional[str]:
        """Retourne le nom du profil actif (pour sauvegarde avant switch)"""
        return self._active_profile_name

    def force_profile(self, name: str) -> Dict[str, Any]:
        """Force un profil sans sauvegarder dans config.txt (temporaire)"""
        profile = self.profile_manager.load_profile(name)
        if not profile:
            return {"status": "error", "message": f"Profil '{name}' introuvable"}
        with self._lock:
            self._active_profile = profile
            self._active_profile_name = name
        return {"status": "ok", "message": f"Profil '{name}' chargé (temporaire)"}
