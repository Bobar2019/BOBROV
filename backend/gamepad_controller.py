"""
Cockpit-Lite ROV — Contrôleur d'actions manette
Convertit les commandes gamepad en actions ROV
"""
import logging
import threading
from typing import Dict, Any
from collections import deque

logger = logging.getLogger(__name__)


class GamepadController:
    """Convertit les commandes gamepad en actions ROV (photo/vidéo/arm + placeholders ESC)"""

    def __init__(self, rov_state: Dict[str, Any], video_streamer):
        """
        Args:
            rov_state: Dictionnaire d'état partagé du ROV
            video_streamer: Instance VideoStreamer pour photo/vidéo
        """
        self._lock = threading.Lock()
        self.rov_state = rov_state
        self.video_streamer = video_streamer
        self._command_queue = deque(maxlen=100)  # File d'attente pour futures commandes ESC

        # Registre des actions disponibles
        self._actions = {
            'photo': self._action_photo,
            'video_toggle': self._action_video_toggle,
            'light_toggle': self._action_light_toggle,
            'arm': self._action_arm,
            'disarm': self._action_disarm,
            'emergency_stop': self._action_emergency_stop,
            'reset_position': self._action_reset_position,
            'depth_hold': self._action_depth_hold,
            'heading_hold': self._action_heading_hold,
            # Placeholders ESC (commandes moteur)
            'move_forward': self._action_esc_placeholder,
            'move_backward': self._action_esc_placeholder,
            'turn_left': self._action_esc_placeholder,
            'turn_right': self._action_esc_placeholder,
            'move_up': self._action_esc_placeholder,
            'move_down': self._action_esc_placeholder,
            'roll_left': self._action_esc_placeholder,
            'roll_right': self._action_esc_placeholder,
            'pitch_up': self._action_esc_placeholder,
            'pitch_down': self._action_esc_placeholder,
            'forward_backward': self._action_esc_placeholder,
            'vertical': self._action_esc_placeholder,
            'lateral': self._action_esc_placeholder,
            'turn': self._action_esc_placeholder,
            'ascent': self._action_esc_placeholder,
            'descent': self._action_esc_placeholder,
        }

        logger.info(f"GamepadController initialisé — {len(self._actions)} actions disponibles")

    def set_dispatcher(self, dispatcher):
        """Connecte le dispatcher central"""
        self._dispatcher = dispatcher

    def execute_action(self, function_name: str, value: Any = 1) -> Dict[str, Any]:
        """Exécute une action - délègue au dispatcher si disponible"""
        if hasattr(self, '_dispatcher') and self._dispatcher:
            return self._dispatcher.execute(function_name, value)
        # Fallback sur le registre local
        action_fn = self._actions.get(function_name)
        if not action_fn:
            return {"status": "error", "message": f"Action inconnue: {function_name}"}
        try:
            return action_fn(value)
        except Exception as e:
            return {"status": "error", "message": str(e)}

    def get_available_actions(self) -> list:
        """Retourne la liste des actions disponibles"""
        return list(self._actions.keys())

    # --- Actions implémentées ---

    def _action_photo(self, value):
        """Prend une photo instantanée"""
        try:
            result = self.video_streamer.take_photo(None, with_osd=None)
            if result.get('status') == 'ok':
                return {"status": "ok", "message": "Photo prise", "data": result}
            return {"status": "error", "message": result.get('message', 'Erreur photo')}
        except Exception as e:
            return {"status": "error", "message": f"Erreur photo: {e}"}

    def _action_video_toggle(self, value):
        """Démarre ou arrête l'enregistrement vidéo"""
        try:
            if self.rov_state.get('recording', False):
                result = self.video_streamer.stop_recording()
                self.rov_state['recording'] = False
                return {"status": "ok", "message": "Enregistrement arrêté", "data": result}
            else:
                result = self.video_streamer.start_recording(None, with_osd=None)
                if result.get('status') == 'ok':
                    self.rov_state['recording'] = True
                    return {"status": "ok", "message": "Enregistrement démarré", "data": result}
                return {"status": "error", "message": result.get('message', 'Erreur enregistrement')}
        except Exception as e:
            return {"status": "error", "message": f"Erreur vidéo: {e}"}

    def _action_light_toggle(self, value):
        """Bascule l'éclairage (0 ↔ 100)"""
        current = self.rov_state.get('light', 0)
        new_value = 0 if current > 0 else 100
        self.rov_state['light'] = new_value
        state = "allumé" if new_value > 0 else "éteint"
        return {"status": "ok", "message": f"Éclairage {state} ({new_value}%)"}

    def _action_arm(self, value):
        """Arme le ROV"""
        self.rov_state['armed'] = True
        return {"status": "ok", "message": "ROV armé"}

    def _action_disarm(self, value):
        """Désarme le ROV"""
        self.rov_state['armed'] = False
        return {"status": "ok", "message": "ROV désarmé"}

    def _action_emergency_stop(self, value):
        """Arrêt d'urgence — désarme et envoie stop aux ESC"""
        self.rov_state['armed'] = False
        # Ajouter la commande à la file d'attente pour le futur contrôleur ESC
        self._command_queue.append({'action': 'emergency_stop', 'value': 0})
        logger.warning("ARRÊT D'URGENCE activé via manette")
        return {"status": "ok", "message": "⚠️ Arrêt d'urgence activé"}

    def _action_reset_position(self, value):
        """Réinitialise la position (placeholder)"""
        return {"status": "ok", "message": "Position réinitialisée"}

    def _action_depth_hold(self, value):
        """Active le maintien de profondeur (placeholder)"""
        return {"status": "ok", "message": "Maintien de profondeur activé"}

    def _action_heading_hold(self, value):
        """Active le maintien de cap (placeholder)"""
        return {"status": "ok", "message": "Maintien de cap activé"}

    def _action_esc_placeholder(self, value):
        """Placeholder pour commandes ESC non encore connectées"""
        self._command_queue.append({'action': 'esc_command', 'value': value})
        return {"status": "ok", "message": "ESC non connecté — commande en file d'attente"}

    def get_command_queue_size(self) -> int:
        """Retourne la taille actuelle de la file de commandes"""
        return len(self._command_queue)
