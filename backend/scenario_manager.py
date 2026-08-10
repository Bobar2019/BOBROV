"""
Module de gestion des scénarios de simulation pour Cockpit-Lite ROV.
Permet de charger, exécuter et contrôler des scénarios de plongée prédéfinis.
"""

import json
import os
import threading
import time
import logging
from typing import Dict, Any, Optional, List
from pathlib import Path

logger = logging.getLogger(__name__)

# Dossier par défaut pour les scénarios
SCENARIOS_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "scenarios")


class ScenarioManager:
    """
    Gestionnaire de scénarios de simulation ROV.
    
    Un scénario est un fichier JSON contenant une liste d'étapes chronologiques :
    {
        "name": "Nom du scénario",
        "description": "Description",
        "loop": true/false,
        "steps": [
            {"time": 0, "action": "heading", "value": 90},
            ...
        ]
    }
    
    Actions supportées : heading, depth, roll, pitch, temperature
    """

    def __init__(self, sensor_manager=None):
        """
        Initialise le gestionnaire de scénarios.
        
        Args:
            sensor_manager: Référence au SensorManager pour injecter les valeurs
        """
        self.sensor_manager = sensor_manager
        self._lock = threading.Lock()
        
        # État de la simulation
        self._state = "stopped"  # stopped, running, paused
        self._current_scenario: Optional[Dict] = None
        self._current_step_index = 0
        self._start_time = 0.0
        self._pause_time = 0.0
        self._pause_accumulated = 0.0
        self._thread: Optional[threading.Thread] = None
        self._running = False

        # Créer le dossier scénarios s'il n'existe pas
        os.makedirs(SCENARIOS_DIR, exist_ok=True)

    # ==========================================================
    # GESTION DES FICHIERS DE SCÉNARIOS
    # ==========================================================

    def list_scenarios(self) -> List[Dict[str, str]]:
        """Liste tous les scénarios disponibles dans le dossier scenarios/"""
        scenarios = []
        try:
            for filename in sorted(os.listdir(SCENARIOS_DIR)):
                if filename.endswith('.json'):
                    filepath = os.path.join(SCENARIOS_DIR, filename)
                    try:
                        with open(filepath, 'r', encoding='utf-8') as f:
                            data = json.load(f)
                        scenarios.append({
                            'file': filename,
                            'name': data.get('name', filename.replace('.json', '')),
                            'description': data.get('description', ''),
                            'steps_count': len(data.get('steps', []))
                        })
                    except (json.JSONDecodeError, IOError) as e:
                        logger.warning(f"Scénario invalide {filename}: {e}")
        except Exception as e:
            logger.error(f"Erreur lecture dossier scénarios: {e}")
        return scenarios

    def load_scenario(self, filename: str) -> Dict[str, Any]:
        """
        Charge un scénario depuis un fichier JSON.
        
        Args:
            filename: Nom du fichier (ex: "default.json")
            
        Returns:
            Le contenu du scénario chargé
            
        Raises:
            FileNotFoundError: Si le fichier n'existe pas
            ValueError: Si le format est invalide
        """
        filepath = os.path.join(SCENARIOS_DIR, filename)
        if not os.path.exists(filepath):
            raise FileNotFoundError(f"Scénario non trouvé: {filename}")

        with open(filepath, 'r', encoding='utf-8') as f:
            data = json.load(f)

        # Validation minimale
        if 'steps' not in data or not isinstance(data['steps'], list):
            raise ValueError("Le scénario doit contenir une liste 'steps'")

        for i, step in enumerate(data['steps']):
            if 'time' not in step or 'action' not in step or 'value' not in step:
                raise ValueError(f"Étape {i} invalide: doit contenir time, action, value")
            if step['action'] not in ('heading', 'depth', 'roll', 'pitch', 'temperature'):
                raise ValueError(f"Action inconnue à l'étape {i}: {step['action']}")

        with self._lock:
            self._current_scenario = data

        logger.info(f"Scénario chargé: {data.get('name', filename)} ({len(data['steps'])} étapes)")
        return data

    def save_scenario(self, filename: str, scenario: Dict[str, Any]) -> str:
        """
        Sauvegarde un scénario dans un fichier JSON.
        
        Args:
            filename: Nom du fichier de destination
            scenario: Données du scénario
            
        Returns:
            Chemin complet du fichier sauvegardé
        """
        # Validation
        if 'steps' not in scenario or not isinstance(scenario['steps'], list):
            raise ValueError("Le scénario doit contenir une liste 'steps'")

        filepath = os.path.join(SCENARIOS_DIR, filename)
        with open(filepath, 'w', encoding='utf-8') as f:
            json.dump(scenario, f, indent=4, ensure_ascii=False)

        logger.info(f"Scénario sauvegardé: {filepath}")
        return filepath

    def delete_scenario(self, filename: str) -> bool:
        """Supprime un fichier de scénario"""
        filepath = os.path.join(SCENARIOS_DIR, filename)
        if os.path.exists(filepath) and filename != "default.json":
            os.remove(filepath)
            logger.info(f"Scénario supprimé: {filename}")
            return True
        return False

    # ==========================================================
    # CONTRÔLE DE LA SIMULATION
    # ==========================================================

    def start(self, scenario_name: Optional[str] = None):
        """
        Démarre l'exécution du scénario chargé (ou charge 'default.json').
        
        Args:
            scenario_name: Nom du scénario à charger avant de démarrer (optionnel)
        """
        if scenario_name:
            self.load_scenario(scenario_name)

        with self._lock:
            if self._current_scenario is None:
                raise ValueError("Aucun scénario chargé. Utilisez load_scenario() d'abord.")
            if self._state == "running":
                logger.warning("Simulation déjà en cours")
                return

            self._state = "running"
            self._current_step_index = 0
            self._start_time = time.time()
            self._pause_accumulated = 0.0
            self._running = True

        # Activer le mode simulation sur le sensor_manager
        if self.sensor_manager:
            self.sensor_manager.set_simulation(True)

        # Lancer le thread d'exécution
        self._thread = threading.Thread(
            target=self._execution_loop,
            daemon=True,
            name="ScenarioThread"
        )
        self._thread.start()
        logger.info(f"Simulation démarrée: {self._current_scenario.get('name', '?')}")

    def stop(self):
        """Arrête la simulation en cours"""
        with self._lock:
            self._state = "stopped"
            self._running = False

        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=2.0)
        self._thread = None
        logger.info("Simulation arrêtée")

    def pause(self):
        """Met en pause la simulation"""
        with self._lock:
            if self._state == "running":
                self._state = "paused"
                self._pause_time = time.time()
                logger.info("Simulation en pause")
            elif self._state == "paused":
                self._state = "running"
                self._pause_accumulated += time.time() - self._pause_time
                logger.info("Simulation reprise")

    def reset(self):
        """Réinitialise la simulation au début sans l'arrêter"""
        with self._lock:
            self._current_step_index = 0
            self._start_time = time.time()
            self._pause_accumulated = 0.0
            if self._state == "paused":
                self._pause_time = self._start_time
        logger.info("Simulation réinitialisée")

    def get_status(self) -> Dict[str, Any]:
        """Retourne l'état actuel de la simulation"""
        with self._lock:
            elapsed = 0.0
            if self._state == "running":
                elapsed = time.time() - self._start_time - self._pause_accumulated
            elif self._state == "paused":
                elapsed = self._pause_time - self._start_time - self._pause_accumulated

            total_duration = 0.0
            if self._current_scenario and 'steps' in self._current_scenario:
                steps = self._current_scenario['steps']
                if steps:
                    total_duration = max(s['time'] for s in steps)

            return {
                'state': self._state,
                'scenario': self._current_scenario.get('name', '') if self._current_scenario else '',
                'elapsed': round(elapsed, 1),
                'total_duration': total_duration,
                'current_step': self._current_step_index,
                'total_steps': len(self._current_scenario.get('steps', [])) if self._current_scenario else 0,
                'loop': self._current_scenario.get('loop', False) if self._current_scenario else False
            }

    def set_realtime_value(self, action: str, value: float):
        """
        Modifie un paramètre en temps réel (override du scénario).
        
        Args:
            action: heading, depth, roll, pitch, temperature
            value: Nouvelle valeur
        """
        if self.sensor_manager and action in ('heading', 'depth', 'roll', 'pitch', 'temperature'):
            self.sensor_manager.set_data(action, value)

    # ==========================================================
    # BOUCLE D'EXÉCUTION
    # ==========================================================

    def _execution_loop(self):
        """Boucle principale d'exécution du scénario"""
        logger.info("Thread scénario démarré")

        while self._running:
            with self._lock:
                if self._state == "stopped":
                    break
                if self._state == "paused":
                    time.sleep(0.05)
                    continue

                scenario = self._current_scenario
                if not scenario or 'steps' not in scenario:
                    break

                steps = scenario['steps']
                if not steps:
                    break

                # Temps écoulé depuis le début (hors pauses)
                elapsed = time.time() - self._start_time - self._pause_accumulated

                # Trouver les étapes encadrant le temps actuel
                prev_step = None
                next_step = None

                for i, step in enumerate(steps):
                    if step['time'] <= elapsed:
                        prev_step = step
                        self._current_step_index = i
                    elif next_step is None:
                        next_step = step

                # Si on a dépassé la dernière étape
                if next_step is None and prev_step is not None:
                    if scenario.get('loop', False):
                        # Boucler
                        self._start_time = time.time() - self._pause_accumulated
                        self._current_step_index = 0
                        logger.debug("Scénario en boucle")
                        time.sleep(0.05)
                        continue
                    else:
                        # Fin du scénario
                        self._state = "stopped"
                        self._running = False
                        logger.info("Scénario terminé")
                        break

                # Interpolation linéaire entre prev_step et next_step
                if prev_step and next_step and self.sensor_manager:
                    dt = next_step['time'] - prev_step['time']
                    if dt > 0:
                        progress = (elapsed - prev_step['time']) / dt
                    else:
                        progress = 1.0

                    # Même action : interpoler
                    if prev_step['action'] == next_step['action']:
                        value = prev_step['value'] + (next_step['value'] - prev_step['value']) * progress
                        self.sensor_manager.set_data(prev_step['action'], float(value))
                    else:
                        # Actions différentes : appliquer la précédente
                        self.sensor_manager.set_data(prev_step['action'], float(prev_step['value']))

                elif prev_step and self.sensor_manager:
                    self.sensor_manager.set_data(prev_step['action'], float(prev_step['value']))

            time.sleep(0.05)  # 20Hz

        logger.info("Thread scénario terminé")
