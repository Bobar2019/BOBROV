"""
BOB-ROV — Gestionnaire IMU (Inertial Measurement Unit)

Couche d'orchestration au-dessus des drivers (imu_drivers.py) :
  - Sélection dynamique du capteur actif (ADXL345 / GY91 / QMI8658)
    via la section [IMU] de config.txt ou la variable d'environnement
    IMU_SENSOR_TYPE (prioritaire sur la config).
  - Thread de lecture interne (~50 Hz) avec filtre complémentaire
    pour fournir un Roll/Pitch stable à l'OSD (yaw intégré du gyro).
  - API unifiée pour le reste de l'application :
      get_orientation()  -> {"pitch", "roll", "yaw"}      (degrés)
      get_acceleration() -> {"x", "y", "z"}               (g)
      get_status()       -> capteur, adresse I2C, santé, alerte
  - Robustesse : si le capteur ne répond pas, valeurs neutres (0.0)
    sans crash, avec alerte remontée à la page Informations Système.
"""

import os
import math
import time
import threading
import logging
from typing import Dict, Any, Optional

from .imu_drivers import BaseIMU, create_imu_driver, IMU_DRIVERS

logger = logging.getLogger(__name__)

# Variable d'environnement prioritaire sur config.txt
ENV_SENSOR_TYPE = "IMU_SENSOR_TYPE"


class IMUManager:
    """
    Gestionnaire du capteur IMU actif.
    Thread-safe : les getters peuvent être appelés depuis FastAPI pendant
    que le thread d'acquisition met à jour l'orientation.
    """

    # Nombre d'échecs de lecture consécutifs avant passage en mode dégradé
    _MAX_READ_FAILURES = 10

    def __init__(self, config: Optional[Dict[str, Any]] = None):
        """
        Args:
            config: section [IMU] de config.txt (dict), ex :
                    {'sensor_type': 'QMI8658', 'i2c_bus': 1,
                     'i2c_address': '0x6B', 'update_rate_hz': 50,
                     'complementary_alpha': 0.98}
        """
        cfg = config or {}

        # --- Sélection du capteur : env > config > défaut ---
        env_type = os.environ.get(ENV_SENSOR_TYPE, "").strip()
        cfg_type = str(cfg.get("sensor_type", "QMI8658")).strip()
        self.sensor_type = (env_type or cfg_type).upper()
        if env_type:
            logger.info(f"IMU: capteur forcé par ${ENV_SENSOR_TYPE} = {env_type}")

        self.bus_id = int(cfg.get("i2c_bus", 1))
        self.address = self._parse_address(cfg.get("i2c_address"))
        self.update_rate_hz = max(1.0, float(cfg.get("update_rate_hz", 50)))
        self.alpha = min(1.0, max(0.0, float(cfg.get("complementary_alpha", 0.98))))

        # --- Driver actif ---
        self.driver: Optional[BaseIMU] = None
        self.alert: Optional[str] = None

        # --- État orientation / accélération (protégé par lock) ---
        self._lock = threading.Lock()
        self._orientation = {"pitch": 0.0, "roll": 0.0, "yaw": 0.0}
        self._acceleration = {"x": 0.0, "y": 0.0, "z": 0.0}
        self._gyro = {"x": 0.0, "y": 0.0, "z": 0.0}
        self._last_read_ok = False
        self._read_failures = 0
        self._last_update_ts = 0.0

        # --- Thread d'acquisition ---
        self._running = False
        self._thread: Optional[threading.Thread] = None

    # ==========================================================
    # HELPERS
    # ==========================================================

    @staticmethod
    def _parse_address(value: Any) -> Optional[int]:
        """Convertit '0x6B' / '107' / 107 en entier, None si absent/invalide"""
        if value is None or value == "":
            return None
        try:
            if isinstance(value, str):
                return int(value, 16) if value.lower().startswith("0x") else int(value)
            return int(value)
        except (ValueError, TypeError):
            logger.warning(f"IMU: adresse I2C invalide '{value}' — adresse par défaut utilisée")
            return None

    # ==========================================================
    # CYCLE DE VIE
    # ==========================================================

    def connect(self) -> bool:
        """
        Crée le driver via la factory et tente la connexion I2C.
        Ne lève jamais d'exception : en cas d'échec, l'IMU reste en
        mode dégradé (valeurs neutres) et une alerte est enregistrée.
        """
        self.driver = create_imu_driver(self.sensor_type, bus_id=self.bus_id,
                                        address=self.address)
        if self.driver is None:
            self.alert = (f"Type de capteur IMU inconnu '{self.sensor_type}' "
                          f"(valides: {', '.join(IMU_DRIVERS.keys())})")
            logger.error(f"IMU: {self.alert}")
            return False

        try:
            ok = self.driver.connect()
        except Exception as e:
            ok = False
            self.driver.last_error = str(e)

        if ok:
            self.alert = None
            logger.info(f"IMU: {self.sensor_type} opérationnel "
                        f"(bus {self.bus_id}, 0x{self.driver.address:02X})")
        else:
            self.alert = (f"Capteur {self.sensor_type} injoignable sur le bus I2C "
                          f"{self.bus_id} — valeurs neutres (0.0) utilisées")
            logger.warning(f"IMU: {self.alert} ({self.driver.last_error})")
        return ok

    def start(self):
        """Connecte le capteur et démarre le thread d'acquisition"""
        if self._running:
            return
        self.connect()
        self._running = True
        self._thread = threading.Thread(target=self._acquisition_loop,
                                        name="imu-manager", daemon=True)
        self._thread.start()
        logger.info(f"IMU: thread d'acquisition démarré ({self.update_rate_hz} Hz)")

    def stop(self):
        """Arrête le thread et libère le bus I2C"""
        self._running = False
        if self._thread:
            self._thread.join(timeout=2.0)
            self._thread = None
        if self.driver:
            self.driver.disconnect()
        logger.info("IMU: gestionnaire arrêté")

    def switch_sensor(self, sensor_type: str) -> bool:
        """
        Change le capteur actif à chaud (appelé par l'API).
        Retourne True si le nouveau capteur répond.
        """
        sensor_type = sensor_type.upper().strip()
        if sensor_type not in IMU_DRIVERS:
            return False
        old_driver = self.driver
        self.sensor_type = sensor_type
        self.address = None  # utiliser l'adresse par défaut du nouveau capteur
        if old_driver:
            old_driver.disconnect()
        # Réinitialiser le filtre pour éviter un saut d'orientation
        with self._lock:
            self._orientation = {"pitch": 0.0, "roll": 0.0, "yaw": 0.0}
            self._acceleration = {"x": 0.0, "y": 0.0, "z": 0.0}
            self._read_failures = 0
        return self.connect()

    # ==========================================================
    # BOUCLE D'ACQUISITION + FILTRE COMPLÉMENTAIRE
    # ==========================================================

    def _acquisition_loop(self):
        """Boucle de lecture ~update_rate_hz avec filtre complémentaire"""
        period = 1.0 / self.update_rate_hz
        last_ts = time.monotonic()
        reconnect_at = 0.0

        while self._running:
            now = time.monotonic()
            dt = now - last_ts
            last_ts = now

            raw = None
            if self.driver and self.driver.connected:
                raw = self.driver.read_raw()

            if raw is not None:
                self._apply_filter(raw, dt)
                self._read_failures = 0
                self._last_read_ok = True
                if self.alert and "injoignable" not in self.alert:
                    self.alert = None
            else:
                self._read_failures += 1
                self._last_read_ok = False
                if self._read_failures == self._MAX_READ_FAILURES:
                    # Passage en mode dégradé : valeurs neutres + alerte
                    self.alert = (f"Capteur {self.sensor_type} muet "
                                  f"({self._read_failures} lectures échouées) "
                                  f"— valeurs neutres (0.0)")
                    logger.warning(f"IMU: {self.alert}")
                    with self._lock:
                        self._orientation = {"pitch": 0.0, "roll": 0.0, "yaw": 0.0}
                        self._acceleration = {"x": 0.0, "y": 0.0, "z": 0.0}
                        self._gyro = {"x": 0.0, "y": 0.0, "z": 0.0}
                    if self.driver:
                        self.driver.connected = False

                # Tentative de reconnexion périodique (toutes les 5 s)
                if (not self.driver or not self.driver.connected) and now >= reconnect_at:
                    reconnect_at = now + 5.0
                    if self.driver and self.driver.connect():
                        self._read_failures = 0
                        self.alert = None
                        logger.info(f"IMU: {self.sensor_type} reconnecté")

            time.sleep(period)

    def _apply_filter(self, raw: Dict[str, float], dt: float):
        """
        Filtre complémentaire :
          - Roll/Pitch accéléromètre (référence gravité, bruité)
          - Intégration gyroscope (fluide, dérive)
          - Fusion : angle = alpha*(angle + gyro*dt) + (1-alpha)*angle_accel
        Le yaw est intégré du gyro seul (pas de magnétomètre exploité ici).
        """
        ax, ay, az = raw["ax"], raw["ay"], raw["az"]
        gx, gy, gz = raw["gx"], raw["gy"], raw["gz"]

        # Angles issus de l'accéléromètre (degrés)
        try:
            accel_roll = math.degrees(math.atan2(ay, az))
            accel_pitch = math.degrees(math.atan2(-ax, math.sqrt(ay * ay + az * az)))
        except ValueError:
            return

        # dt aberrant (pause système) → on se cale sur l'accéléromètre
        if dt <= 0 or dt > 0.5:
            dt = 0.0

        with self._lock:
            if self.driver and self.driver.HAS_GYRO:
                a = self.alpha
                self._orientation["roll"] = (
                    a * (self._orientation["roll"] + gx * dt) + (1.0 - a) * accel_roll)
                self._orientation["pitch"] = (
                    a * (self._orientation["pitch"] + gy * dt) + (1.0 - a) * accel_pitch)
                # Yaw : intégration gyro seule, replié sur [0, 360)
                self._orientation["yaw"] = (self._orientation["yaw"] + gz * dt) % 360.0
            else:
                # Capteur sans gyro (ADXL345) : accéléromètre seul
                self._orientation["roll"] = accel_roll
                self._orientation["pitch"] = accel_pitch
                self._orientation["yaw"] = 0.0

            self._acceleration = {"x": round(ax, 4), "y": round(ay, 4), "z": round(az, 4)}
            self._gyro = {"x": round(gx, 3), "y": round(gy, 3), "z": round(gz, 3)}
            self._last_update_ts = time.time()

    # ==========================================================
    # API UNIFIÉE
    # ==========================================================

    def is_connected(self) -> bool:
        return bool(self.driver and self.driver.connected)

    def get_orientation(self) -> Dict[str, float]:
        """Orientation filtrée en degrés : {"pitch", "roll", "yaw"}"""
        with self._lock:
            return {
                "pitch": round(self._orientation["pitch"], 2),
                "roll": round(self._orientation["roll"], 2),
                "yaw": round(self._orientation["yaw"], 2),
            }

    def get_acceleration(self) -> Dict[str, float]:
        """Accélération en g : {"x", "y", "z"}"""
        with self._lock:
            return dict(self._acceleration)

    def get_gyro(self) -> Dict[str, float]:
        """Vitesses angulaires brutes en dps : {"x", "y", "z"}"""
        with self._lock:
            return dict(self._gyro)

    def get_status(self) -> Dict[str, Any]:
        """
        État de santé complet pour l'API / la page Informations Système.
        """
        if self.driver:
            status = self.driver.get_status()
        else:
            status = {
                "sensor_name": self.sensor_type,
                "connected": False,
                "i2c_address": "N/A",
                "has_gyro": False,
                "last_error": "driver non initialisé",
            }
        with self._lock:
            status.update({
                "sensor_type": self.sensor_type,
                "available_sensors": list(IMU_DRIVERS.keys()),
                "i2c_bus": self.bus_id,
                "update_rate_hz": self.update_rate_hz,
                "healthy": self._last_read_ok,
                "read_failures": self._read_failures,
                "last_update": self._last_update_ts,
                "alert": self.alert,
            })
        return status
