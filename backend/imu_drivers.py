"""
BOB-ROV — Drivers IMU (Inertial Measurement Unit)
Architecture modulaire : classe abstraite BaseIMU + un driver par capteur.

Capteurs supportés :
  - ADXL345  (accéléromètre seul,          I2C 0x53)
  - GY91     (MPU-9250 accel+gyro,         I2C 0x68)
  - QMI8658  (accel+gyro Waveshare AMOLED, I2C 0x6B)

Chaque driver expose une API unifiée :
  connect() -> bool
  read_raw() -> dict | None   (accel en g, gyro en dps)
  get_status() -> dict {"sensor_name", "connected", "i2c_address"}

Le calcul d'orientation (filtre complémentaire) est réalisé par
IMUManager (imu_manager.py) à partir des données brutes.
"""

import abc
import time
import logging
from typing import Dict, Any, Optional

logger = logging.getLogger(__name__)

# Import optionnel du bus I2C (mode simulation si absent)
try:
    from smbus2 import SMBus
    HAS_I2C = True
except ImportError:
    HAS_I2C = False
    logger.warning("smbus2 non disponible — drivers IMU en mode dégradé")


def _to_int16_le(lsb: int, msb: int) -> int:
    """2 octets little-endian → entier signé 16 bits"""
    val = (msb << 8) | lsb
    return val - 0x10000 if val >= 0x8000 else val


def _to_int16_be(msb: int, lsb: int) -> int:
    """2 octets big-endian → entier signé 16 bits"""
    val = (msb << 8) | lsb
    return val - 0x10000 if val >= 0x8000 else val


# ==========================================================
# CLASSE ABSTRAITE
# ==========================================================

class BaseIMU(abc.ABC):
    """
    Interface de base pour tous les capteurs IMU.
    Les drivers concrets implémentent connect() et read_raw().
    """

    SENSOR_NAME = "BaseIMU"
    HAS_GYRO = False

    def __init__(self, bus_id: int = 1, address: int = 0x00):
        self.bus_id = bus_id
        self.address = address
        self.bus: Optional[Any] = None
        self.connected = False
        self.last_error: Optional[str] = None

    @abc.abstractmethod
    def connect(self) -> bool:
        """Initialise le capteur sur le bus I2C. Retourne True si OK."""
        ...

    @abc.abstractmethod
    def read_raw(self) -> Optional[Dict[str, float]]:
        """
        Lit les données brutes du capteur.
        Retourne {"ax","ay","az" (g), "gx","gy","gz" (dps)} ou None si erreur.
        Les capteurs sans gyroscope retournent gx=gy=gz=0.0.
        """
        ...

    def get_status(self) -> Dict[str, Any]:
        """État de santé du capteur pour l'API/frontend"""
        return {
            "sensor_name": self.SENSOR_NAME,
            "connected": self.connected,
            "i2c_address": f"0x{self.address:02X}",
            "has_gyro": self.HAS_GYRO,
            "last_error": self.last_error,
        }

    def disconnect(self):
        """Libère le bus I2C"""
        if self.bus:
            try:
                self.bus.close()
            except Exception:
                pass
            self.bus = None
        self.connected = False

    def _open_bus(self) -> bool:
        """Ouvre le bus I2C (/dev/i2c-N). Retourne False si indisponible."""
        if not HAS_I2C:
            self.last_error = "smbus2 non installé"
            return False
        try:
            self.bus = SMBus(self.bus_id)
            return True
        except Exception as e:
            self.last_error = f"Bus I2C {self.bus_id} inaccessible: {e}"
            return False


# ==========================================================
# DRIVER ADXL345 — accéléromètre 3 axes (legacy)
# ==========================================================

class ADXL345Driver(BaseIMU):
    """ADXL345 : accéléromètre seul, pas de gyroscope (adresse 0x53)"""

    SENSOR_NAME = "ADXL345"
    HAS_GYRO = False

    _REG_DEVID       = 0x00  # doit retourner 0xE5
    _REG_POWER_CTL   = 0x2D
    _REG_DATA_FORMAT = 0x31
    _REG_BW_RATE     = 0x2C
    _REG_DATAX0      = 0x32

    def __init__(self, bus_id: int = 1, address: int = 0x53):
        super().__init__(bus_id, address)

    def connect(self) -> bool:
        if not self._open_bus():
            return False
        try:
            devid = self.bus.read_byte_data(self.address, self._REG_DEVID)
            if devid != 0xE5:
                self.last_error = f"Device ID invalide 0x{devid:02X} (attendu 0xE5)"
                logger.warning(f"ADXL345: {self.last_error}")
                return False
            # Plage ±16g full resolution, 100Hz, mesure active
            self.bus.write_byte_data(self.address, self._REG_DATA_FORMAT, 0x0B)
            self.bus.write_byte_data(self.address, self._REG_BW_RATE, 0x0A)
            self.bus.write_byte_data(self.address, self._REG_POWER_CTL, 0x08)
            self.connected = True
            self.last_error = None
            logger.info(f"ADXL345 connecté à 0x{self.address:02X}")
            return True
        except Exception as e:
            self.last_error = str(e)
            logger.warning(f"ADXL345: échec connexion 0x{self.address:02X}: {e}")
            return False

    def read_raw(self) -> Optional[Dict[str, float]]:
        if not self.connected or not self.bus:
            return None
        try:
            raw = self.bus.read_i2c_block_data(self.address, self._REG_DATAX0, 6)
            scale = 0.004  # 4 mg/LSB en full resolution
            return {
                "ax": _to_int16_le(raw[0], raw[1]) * scale,
                "ay": _to_int16_le(raw[2], raw[3]) * scale,
                "az": _to_int16_le(raw[4], raw[5]) * scale,
                "gx": 0.0, "gy": 0.0, "gz": 0.0,
            }
        except Exception as e:
            self.last_error = str(e)
            return None


# ==========================================================
# DRIVER GY-91 — MPU-9250 (accéléromètre + gyroscope)
# ==========================================================

class GY91Driver(BaseIMU):
    """GY-91 : MPU-9250 accéléromètre + gyroscope (adresse 0x68)"""

    SENSOR_NAME = "GY91"
    HAS_GYRO = True

    _REG_WHO_AM_I     = 0x75  # 0x71/0x73/0x70
    _REG_PWR_MGMT_1   = 0x6B
    _REG_ACCEL_CONFIG = 0x1C
    _REG_GYRO_CONFIG  = 0x1B
    _REG_ACCEL_XOUT_H = 0x3B  # accel(6) + temp(2) + gyro(6) = 14 octets

    _ACCEL_SCALE = 16384.0  # LSB/g   (±2g)
    _GYRO_SCALE  = 131.0    # LSB/dps (±250°/s)

    def __init__(self, bus_id: int = 1, address: int = 0x68):
        super().__init__(bus_id, address)

    def connect(self) -> bool:
        if not self._open_bus():
            return False
        try:
            whoami = self.bus.read_byte_data(self.address, self._REG_WHO_AM_I)
            if whoami not in (0x71, 0x73, 0x70):
                logger.warning(f"GY91: WHO_AM_I inattendu 0x{whoami:02X} — on continue")
            # Réveil, plages ±2g / ±250°/s
            self.bus.write_byte_data(self.address, self._REG_PWR_MGMT_1, 0x00)
            time.sleep(0.05)
            self.bus.write_byte_data(self.address, self._REG_ACCEL_CONFIG, 0x00)
            self.bus.write_byte_data(self.address, self._REG_GYRO_CONFIG, 0x00)
            self.connected = True
            self.last_error = None
            logger.info(f"GY91 (MPU-9250) connecté à 0x{self.address:02X}")
            return True
        except Exception as e:
            self.last_error = str(e)
            logger.warning(f"GY91: échec connexion 0x{self.address:02X}: {e}")
            return False

    def read_raw(self) -> Optional[Dict[str, float]]:
        if not self.connected or not self.bus:
            return None
        try:
            # 14 octets big-endian : accel XYZ + temp + gyro XYZ
            raw = self.bus.read_i2c_block_data(self.address, self._REG_ACCEL_XOUT_H, 14)
            return {
                "ax": _to_int16_be(raw[0], raw[1]) / self._ACCEL_SCALE,
                "ay": _to_int16_be(raw[2], raw[3]) / self._ACCEL_SCALE,
                "az": _to_int16_be(raw[4], raw[5]) / self._ACCEL_SCALE,
                "gx": _to_int16_be(raw[8], raw[9]) / self._GYRO_SCALE,
                "gy": _to_int16_be(raw[10], raw[11]) / self._GYRO_SCALE,
                "gz": _to_int16_be(raw[12], raw[13]) / self._GYRO_SCALE,
            }
        except Exception as e:
            self.last_error = str(e)
            return None


# ==========================================================
# DRIVER QMI8658 — accel + gyro (Waveshare ESP32-S3 AMOLED)
# ==========================================================

class QMI8658Driver(BaseIMU):
    """
    QMI8658/QMI8658A : centrale inertielle 6 axes (adresse 0x6B).
    Embarquée sur la carte Waveshare ESP32-S3 AMOLED, exposée sur /dev/i2c-1.
    """

    SENSOR_NAME = "QMI8658"
    HAS_GYRO = True

    _REG_WHO_AM_I = 0x00  # doit retourner 0x05
    _REG_REVISION = 0x01
    _REG_CTRL1    = 0x02  # interface (auto-increment adresses)
    _REG_CTRL2    = 0x03  # accéléromètre : plage + ODR
    _REG_CTRL3    = 0x04  # gyroscope : plage + ODR
    _REG_CTRL5    = 0x06  # filtres passe-bas
    _REG_CTRL7    = 0x08  # activation capteurs (bit0=accel, bit1=gyro)
    _REG_RESET    = 0x60  # écriture 0xB0 = soft reset
    _REG_AX_L     = 0x35  # AX_L..GZ_H = 12 octets little-endian

    _WHOAMI_VALUE = 0x05

    # Plages configurées : accel ±4g @ ~250Hz, gyro ±512 dps @ ~250Hz
    _CTRL2_VALUE = 0x15   # aFS=001 (±4g),    aODR=0101 (~250Hz)
    _CTRL3_VALUE = 0x55   # gFS=101 (±512dps), gODR=0101 (~250Hz)
    _CTRL5_VALUE = 0x11   # LPF activés accel + gyro
    _CTRL7_VALUE = 0x03   # aEN + gEN

    _ACCEL_SCALE = 8192.0  # LSB/g   (±4g)
    _GYRO_SCALE  = 64.0    # LSB/dps (±512 dps)

    def __init__(self, bus_id: int = 1, address: int = 0x6B):
        super().__init__(bus_id, address)

    def connect(self) -> bool:
        if not self._open_bus():
            return False
        try:
            whoami = self.bus.read_byte_data(self.address, self._REG_WHO_AM_I)
            if whoami != self._WHOAMI_VALUE:
                self.last_error = f"WHO_AM_I invalide 0x{whoami:02X} (attendu 0x05)"
                logger.warning(f"QMI8658: {self.last_error}")
                return False

            # Soft reset puis reconfiguration complète
            self.bus.write_byte_data(self.address, self._REG_RESET, 0xB0)
            time.sleep(0.05)

            # CTRL1 : auto-incrément d'adresses activé (bit 6)
            self.bus.write_byte_data(self.address, self._REG_CTRL1, 0x40)
            # Accéléromètre ±4g @ 250Hz
            self.bus.write_byte_data(self.address, self._REG_CTRL2, self._CTRL2_VALUE)
            # Gyroscope ±512 dps @ 250Hz
            self.bus.write_byte_data(self.address, self._REG_CTRL3, self._CTRL3_VALUE)
            # Filtres passe-bas internes
            self.bus.write_byte_data(self.address, self._REG_CTRL5, self._CTRL5_VALUE)
            # Activer accel + gyro
            self.bus.write_byte_data(self.address, self._REG_CTRL7, self._CTRL7_VALUE)
            time.sleep(0.05)

            self.connected = True
            self.last_error = None
            rev = self.bus.read_byte_data(self.address, self._REG_REVISION)
            logger.info(f"QMI8658 connecté à 0x{self.address:02X} (révision 0x{rev:02X}) "
                        f"— accel ±4g, gyro ±512dps @ 250Hz")
            return True
        except Exception as e:
            self.last_error = str(e)
            logger.warning(f"QMI8658: échec connexion 0x{self.address:02X}: {e}")
            return False

    def read_raw(self) -> Optional[Dict[str, float]]:
        if not self.connected or not self.bus:
            return None
        try:
            # 12 octets little-endian : AX_L..AZ_H puis GX_L..GZ_H
            raw = self.bus.read_i2c_block_data(self.address, self._REG_AX_L, 12)
            return {
                "ax": _to_int16_le(raw[0], raw[1]) / self._ACCEL_SCALE,
                "ay": _to_int16_le(raw[2], raw[3]) / self._ACCEL_SCALE,
                "az": _to_int16_le(raw[4], raw[5]) / self._ACCEL_SCALE,
                "gx": _to_int16_le(raw[6], raw[7]) / self._GYRO_SCALE,
                "gy": _to_int16_le(raw[8], raw[9]) / self._GYRO_SCALE,
                "gz": _to_int16_le(raw[10], raw[11]) / self._GYRO_SCALE,
            }
        except Exception as e:
            self.last_error = str(e)
            return None


# ==========================================================
# FACTORY
# ==========================================================

# Registre des drivers disponibles : type (config) → classe + adresse défaut
IMU_DRIVERS = {
    "ADXL345": (ADXL345Driver, 0x53),
    "GY91":    (GY91Driver,    0x68),
    "QMI8658": (QMI8658Driver, 0x6B),
}


def create_imu_driver(sensor_type: str, bus_id: int = 1,
                      address: Optional[int] = None) -> Optional[BaseIMU]:
    """
    Factory : crée le driver correspondant au type demandé.
    Retourne None si le type est inconnu.
    """
    entry = IMU_DRIVERS.get(sensor_type.upper().strip())
    if not entry:
        logger.error(f"Type IMU inconnu: '{sensor_type}' "
                     f"(valides: {', '.join(IMU_DRIVERS.keys())})")
        return None
    driver_cls, default_addr = entry
    return driver_cls(bus_id=bus_id, address=address if address is not None else default_addr)
