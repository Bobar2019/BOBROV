"""
BOB-ROV — Mixeur moteur : conversion 6 DOF → 8 propulseurs
Configuration en X : 4 horizontaux à 45° + 4 verticaux
Numérotation officielle : départ avant-droit, sens horaire strict, 2 groupes :
  - M1..M4 (ch0..3) : Horizontaux  — M1 Av-D, M2 Ar-D, M3 Ar-G, M4 Av-G
  - M5..M8 (ch4..7) : Verticaux    — M5 Av-D, M6 Ar-D, M7 Ar-G, M8 Av-G
"""
import logging
from typing import Dict

logger = logging.getLogger(__name__)


class MotorMixer:
    """
    Convertit les 6 axes DOF (surge, sway, yaw, heave, roll, pitch)
    en commandes de poussée pour 8 moteurs.

    - M1-M4 : Horizontaux (surge / sway / yaw) orientés à 45°
               M1 Av-D, M2 Ar-D, M3 Ar-G, M4 Av-G (canaux I2C 0..3)
    - M5-M8 : Verticaux   (heave / roll / pitch)
               M5 Av-D, M6 Ar-D, M7 Ar-G, M8 Av-G (canaux I2C 4..7)

    Les valeurs d'entrée sont normalisées de -1.0 à +1.0.
    La sortie est un dict {1..8: thrust} également dans [-1.0, +1.0].
    Si un moteur dépasse la plage, tout son groupe (horizontal ou
    vertical) est normalisé proportionnellement pour préserver les ratios.
    """

    # ------------------------------------------------------------------ #
    # Matrices de mixage                                                  #
    # ------------------------------------------------------------------ #

    # Coefficients [surge, sway, yaw] pour chaque moteur horizontal
    # (sway > 0 = translation vers la droite, yaw > 0 = rotation horaire)
    HORIZONTAL_MATRIX: Dict[int, list[float]] = {
        1: [+0.707, -0.707, -1.0],   # M1 Horizontal Avant-Droit    (ch0)
        2: [-0.707, -0.707, +1.0],   # M2 Horizontal Arrière-Droit  (ch1)
        3: [-0.707, +0.707, -1.0],   # M3 Horizontal Arrière-Gauche (ch2)
        4: [+0.707, +0.707, +1.0],   # M4 Horizontal Avant-Gauche   (ch3)
    }

    # Coefficients [heave, roll, pitch] pour chaque moteur vertical
    VERTICAL_MATRIX: Dict[int, list[float]] = {
        5: [+1.0, -1.0, +1.0],       # M5 Vertical Avant-Droit    (ch4)
        6: [+1.0, -1.0, -1.0],       # M6 Vertical Arrière-Droit  (ch5)
        7: [+1.0, +1.0, -1.0],       # M7 Vertical Arrière-Gauche (ch6)
        8: [+1.0, +1.0, +1.0],       # M8 Vertical Avant-Gauche   (ch7)
    }

    # ------------------------------------------------------------------ #
    # Méthodes publiques                                                  #
    # ------------------------------------------------------------------ #

    def mix(
        self,
        surge: float,
        sway: float,
        yaw: float,
        heave: float,
        roll: float,
        pitch: float,
    ) -> Dict[int, float]:
        """
        Calcule la poussée de chaque moteur à partir des 6 axes DOF.

        Paramètres
        ----------
        surge, sway, yaw   : axes horizontaux, normalisés dans [-1.0, +1.0]
        heave, roll, pitch : axes verticaux,   normalisés dans [-1.0, +1.0]

        Retourne
        --------
        Dict[int, float] : {1: thrust_m1, ..., 8: thrust_m8} dans [-1.0, +1.0]
        """
        # --- Groupe horizontal (M1-M4) ---
        h_inputs = [surge, sway, yaw]
        horizontal: Dict[int, float] = {}
        for motor_id, coeffs in self.HORIZONTAL_MATRIX.items():
            thrust = sum(axis * coeff for axis, coeff in zip(h_inputs, coeffs))
            horizontal[motor_id] = thrust

        horizontal = self._normalize_group(horizontal)

        # --- Groupe vertical (M5-M8) ---
        v_inputs = [heave, roll, pitch]
        vertical: Dict[int, float] = {}
        for motor_id, coeffs in self.VERTICAL_MATRIX.items():
            thrust = sum(axis * coeff for axis, coeff in zip(v_inputs, coeffs))
            vertical[motor_id] = thrust

        vertical = self._normalize_group(vertical)

        # --- Fusion des deux groupes ---
        result: Dict[int, float] = {}
        result.update(horizontal)
        result.update(vertical)

        return result

    def get_matrix(self) -> Dict:
        """
        Retourne la matrice complète de mixage (pour debug / API).

        Structure retournée :
        {
            "horizontal": {1: [surge_c, sway_c, yaw_c], ...},
            "vertical":   {5: [heave_c, roll_c, pitch_c], ...},
        }
        """
        return {
            "horizontal": {k: list(v) for k, v in self.HORIZONTAL_MATRIX.items()},
            "vertical":   {k: list(v) for k, v in self.VERTICAL_MATRIX.items()},
        }

    # ------------------------------------------------------------------ #
    # Méthodes internes                                                   #
    # ------------------------------------------------------------------ #

    @staticmethod
    def _normalize_group(motors: Dict[int, float]) -> Dict[int, float]:
        """
        Normalise un groupe de moteurs si au moins l'un d'eux dépasse
        l'intervalle [-1.0, +1.0].

        Tous les moteurs du groupe sont réduits proportionnellement afin
        de préserver les ratios relatifs entre eux.
        """
        if not motors:
            return motors

        # Recherche de la valeur absolue maximale du groupe
        max_abs = max(abs(v) for v in motors.values())

        if max_abs <= 1.0:
            # Aucun dépassement : rien à faire
            return motors

        # Facteur de réduction pour ramener le maximum à ±1.0
        scale = 1.0 / max_abs
        logger.debug(
            "Normalisation groupe : max_abs=%.3f → facteur=%.3f",
            max_abs, scale,
        )
        return {mid: val * scale for mid, val in motors.items()}
