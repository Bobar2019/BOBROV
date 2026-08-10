"""
Cockpit-Lite ROV — Gestionnaire de profils manette
CRUD pour profils gamepad stockés en JSON
"""
import json
import os
import threading
import logging
import copy
from pathlib import Path
from typing import Dict, List, Any, Optional

logger = logging.getLogger(__name__)


class GamepadProfileManager:
    """Gère les profils de manette (CRUD + validation + import/export)"""

    # Structure minimale requise pour un profil valide
    REQUIRED_KEYS = {'name', 'mappings', 'settings'}
    REQUIRED_MAPPING_KEYS = {'buttons', 'axes'}
    REQUIRED_SETTINGS_KEYS = {'sensitivity', 'deadzone'}

    def __init__(self, profile_dir: str = 'profiles'):
        self._lock = threading.Lock()
        self.profile_dir = Path(profile_dir)
        self.profile_dir.mkdir(parents=True, exist_ok=True)
        self._profiles_file = self.profile_dir / 'manette_profiles.json'
        self._profiles_cache: Dict[str, Any] = {}
        self._active_profile: str = 'Standard'
        self._load_all()

    def _load_all(self):
        """Charge tous les profils depuis le fichier JSON"""
        with self._lock:
            if self._profiles_file.exists():
                try:
                    with open(self._profiles_file, 'r', encoding='utf-8') as f:
                        data = json.load(f)
                    self._profiles_cache = data.get('profiles', {})
                    self._active_profile = data.get('active_profile', 'Standard')
                    logger.info(f"Profils manette chargés: {list(self._profiles_cache.keys())}")
                except (json.JSONDecodeError, IOError) as e:
                    logger.error(f"Erreur chargement profils manette: {e}")
                    self._create_defaults()
            else:
                logger.info("Fichier profils manette non trouvé, création des défauts")
                self._create_defaults()

    def _create_defaults(self):
        """Crée le profil par défaut si aucun fichier n'existe"""
        self._profiles_cache = {
            "Standard": {
                "name": "Standard",
                "description": "Profil par défaut DualShock 4",
                "mappings": {
                    "buttons": {
                        "CROSS": {"function": "photo", "action": "press"},
                        "CIRCLE": {"function": "video_toggle", "action": "press"},
                        "SQUARE": {"function": "light_toggle", "action": "press"},
                        "TRIANGLE": {"function": "depth_hold", "action": "press"},
                        "L1": {"function": "roll_left", "action": "hold"},
                        "R1": {"function": "roll_right", "action": "hold"},
                        "SHARE": {"function": "reset_position", "action": "press"},
                        "OPTIONS": {"function": "emergency_stop", "action": "press"},
                        "L3": {"function": "heading_hold", "action": "press"},
                        "R3": {"function": "arm", "action": "press"},
                        "DPAD_UP": {"function": "pitch_up", "action": "hold"},
                        "DPAD_DOWN": {"function": "pitch_down", "action": "hold"},
                        "DPAD_LEFT": {"function": "turn_left", "action": "hold"},
                        "DPAD_RIGHT": {"function": "turn_right", "action": "hold"},
                        "PS": {"function": "disarm", "action": "press"},
                        "TOUCHPAD": {"function": "reset_position", "action": "press"}
                    },
                    "axes": {
                        "LEFT_X": {"function": "turn", "invert": False},
                        "LEFT_Y": {"function": "forward_backward", "invert": True},
                        "RIGHT_X": {"function": "lateral", "invert": False},
                        "RIGHT_Y": {"function": "vertical", "invert": True},
                        "L2": {"function": "descent", "invert": False},
                        "R2": {"function": "ascent", "invert": False}
                    }
                },
                "settings": {
                    "sensitivity": 100,
                    "deadzone": 12,
                    "invert_x": False,
                    "invert_y": False,
                    "response_curve": "linear",
                    "vibration": True,
                    "vibration_intensity": 80,
                    "repeat_delay": 200
                }
            }
        }
        self._active_profile = "Standard"
        self._save_all_unlocked()

    def _save_all(self):
        """Sauvegarde tous les profils dans le fichier JSON (thread-safe)"""
        with self._lock:
            self._save_all_unlocked()

    def _save_all_unlocked(self):
        """Sauvegarde tous les profils (sans lock, pour usage interne)"""
        try:
            data = {
                "profiles": self._profiles_cache,
                "active_profile": self._active_profile
            }
            with open(self._profiles_file, 'w', encoding='utf-8') as f:
                json.dump(data, f, indent=2, ensure_ascii=False)
            logger.info(f"Profils manette sauvegardés ({len(self._profiles_cache)} profil(s))")
        except IOError as e:
            logger.error(f"Erreur sauvegarde profils manette: {e}")

    def list_profiles(self) -> List[Dict[str, str]]:
        """Retourne la liste des profils (nom + description)"""
        with self._lock:
            result = []
            for name, profile in self._profiles_cache.items():
                result.append({
                    "name": name,
                    "description": profile.get("description", ""),
                    "active": name == self._active_profile
                })
            return result

    def load_profile(self, name: str) -> Optional[Dict[str, Any]]:
        """Charge un profil par nom"""
        with self._lock:
            profile = self._profiles_cache.get(name)
            if profile:
                return copy.deepcopy(profile)
            return None

    def save_profile(self, name: str, data: Dict[str, Any]) -> Dict[str, Any]:
        """Sauvegarde un profil (crée ou met à jour)"""
        if not name or not name.strip():
            return {"status": "error", "message": "Nom de profil requis"}

        # S'assurer que le nom est cohérent
        data['name'] = name

        if not self.validate_profile(data):
            return {"status": "error", "message": "Structure de profil invalide (clés requises: name, mappings, settings)"}

        with self._lock:
            is_new = name not in self._profiles_cache
            self._profiles_cache[name] = data
            self._save_all_unlocked()

        action = "créé" if is_new else "mis à jour"
        logger.info(f"Profil manette '{name}' {action}")
        return {"status": "ok", "message": f"Profil '{name}' {action}", "data": data}

    def delete_profile(self, name: str) -> Dict[str, Any]:
        """Supprime un profil (interdit de supprimer le dernier)"""
        with self._lock:
            if name not in self._profiles_cache:
                return {"status": "error", "message": f"Profil '{name}' non trouvé"}

            if len(self._profiles_cache) <= 1:
                return {"status": "error", "message": "Impossible de supprimer le dernier profil"}

            del self._profiles_cache[name]

            # Si le profil actif est supprimé, basculer sur le premier disponible
            if self._active_profile == name:
                self._active_profile = next(iter(self._profiles_cache))
                logger.info(f"Profil actif changé vers '{self._active_profile}'")

            self._save_all_unlocked()

        logger.info(f"Profil manette '{name}' supprimé")
        return {"status": "ok", "message": f"Profil '{name}' supprimé"}

    def export_profile(self, name: str) -> Optional[Dict[str, Any]]:
        """Exporte un profil pour téléchargement"""
        with self._lock:
            profile = self._profiles_cache.get(name)
            if not profile:
                return None
            # Retourner une copie avec métadonnées d'export
            export_data = copy.deepcopy(profile)
            export_data['_export_version'] = '1.0'
            return export_data

    def import_profile(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """Importe un profil depuis un JSON"""
        if not data:
            return {"status": "error", "message": "Données de profil vides"}

        # Nettoyer les métadonnées d'export
        data.pop('_export_version', None)

        name = data.get('name')
        if not name:
            return {"status": "error", "message": "Le profil importé doit avoir un nom"}

        if not self.validate_profile(data):
            return {"status": "error", "message": "Structure de profil importé invalide"}

        # Si le nom existe déjà, ajouter un suffixe
        with self._lock:
            original_name = name
            counter = 1
            while name in self._profiles_cache:
                name = f"{original_name} ({counter})"
                counter += 1
            data['name'] = name
            self._profiles_cache[name] = data
            self._save_all_unlocked()

        logger.info(f"Profil manette importé: '{name}'")
        return {"status": "ok", "message": f"Profil '{name}' importé", "data": data}

    def validate_profile(self, data: Dict[str, Any]) -> bool:
        """Vérifie la structure d'un profil"""
        if not isinstance(data, dict):
            return False

        # Vérifier les clés requises de premier niveau
        if not self.REQUIRED_KEYS.issubset(data.keys()):
            return False

        # Vérifier la structure des mappings
        mappings = data.get('mappings', {})
        if not isinstance(mappings, dict):
            return False
        if not self.REQUIRED_MAPPING_KEYS.issubset(mappings.keys()):
            return False

        # Vérifier que buttons et axes sont des dicts
        if not isinstance(mappings.get('buttons'), dict):
            return False
        if not isinstance(mappings.get('axes'), dict):
            return False

        # Vérifier la structure des settings
        settings = data.get('settings', {})
        if not isinstance(settings, dict):
            return False
        if not self.REQUIRED_SETTINGS_KEYS.issubset(settings.keys()):
            return False

        return True

    def get_active_profile_name(self) -> str:
        """Retourne le nom du profil actif"""
        with self._lock:
            return self._active_profile

    def set_active_profile(self, name: str) -> bool:
        """Définit le profil actif"""
        with self._lock:
            if name not in self._profiles_cache:
                return False
            self._active_profile = name
            self._save_all_unlocked()
            return True
