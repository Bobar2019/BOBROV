"""
Module de gestion des capteurs pour Cockpit-Lite ROV.
Supporte les capteurs I2C (profondeur, température, IMU) et UART.
Mode simulation activé par défaut pour les tests sans matériel.
"""

import threading
import time
import math
import random
import logging
from typing import Dict, Any, Optional

logger = logging.getLogger(__name__)

# Imports optionnels pour le matériel (évite les crashs si non disponible)
try:
    from smbus2 import SMBus
    HAS_I2C = True
except ImportError:
    HAS_I2C = False
    logger.warning("smbus2 non disponible, mode simulation forcé")

try:
    import serial
    HAS_SERIAL = True
except ImportError:
    HAS_SERIAL = False


class SensorManager:
    """
    Gestionnaire de capteurs I2C/UART avec mode simulation par capteur individuel.
    
    Chaque capteur peut être indépendamment en mode réel ou simulé :
    - Profondeur (MS5837 ou similaire)
    - Température + Pression (BMP280 du module GY-91)
    - Cap / Boussole (AK8963 du MPU-9250 via bypass I2C)
    - Batterie (ADC)
    - Roulis / Tangage / Accéléromètre (MPU-9250 du GY-91, fallback ADXL345)
    
    Mode simulation par défaut pour tous. Les capteurs physiques détectés au
    démarrage basculent automatiquement en mode réel, avec retour simulation
    sans crash en cas d'erreur de lecture.
    """

    # Registres ADXL345 (legacy — remplacé par le GY-91)
    _ADXL_DEVID       = 0x00  # Device ID (doit retourner 0xE5)
    _ADXL_POWER_CTL   = 0x2D  # Power control
    _ADXL_DATA_FORMAT = 0x31  # Data format
    _ADXL_BW_RATE     = 0x2C  # Bandwidth/rate
    _ADXL_DATAX0      = 0x32  # X-axis data LSB
    _ADXL_DATAX1      = 0x33  # X-axis data MSB
    _ADXL_DATAY0      = 0x34
    _ADXL_DATAY1      = 0x35
    _ADXL_DATAZ0      = 0x36
    _ADXL_DATAZ1      = 0x37

    # Registres MPU-9250 (GY-91, adresse 0x68)
    _MPU_WHO_AM_I     = 0x75  # 0x71 (MPU-9250) / 0x73 (MPU-9255) / 0x70 (MPU-6500)
    _MPU_PWR_MGMT_1   = 0x6B  # Power management (0x00 = réveil)
    _MPU_INT_PIN_CFG  = 0x37  # Bit 1 = BYPASS_EN → accès direct AK8963
    _MPU_ACCEL_CONFIG = 0x1C  # Plage accéléromètre (0x00 = ±2g)
    _MPU_GYRO_CONFIG  = 0x1B  # Plage gyroscope (0x00 = ±250°/s)
    _MPU_ACCEL_XOUT_H = 0x3B  # Données accéléro (6 octets, big-endian)

    # Registres AK8963 (magnétomètre, adresse 0x0C via bypass)
    _AK_WIA   = 0x00  # Device ID (doit retourner 0x48)
    _AK_ST1   = 0x02  # Status 1 (bit 0 = data ready)
    _AK_HXL   = 0x03  # Données X LSB (7 octets little-endian avec ST2)
    _AK_CNTL1 = 0x0A  # Contrôle (0x16 = continu 100Hz 16-bit)
    _AK_ASAX  = 0x10  # Sensitivity adjustment (fuse ROM, 3 octets)

    # Registres BMP280 (GY-91, adresse 0x76)
    _BMP_ID        = 0xD0  # Chip ID (0x58 = BMP280, 0x60 = BME280)
    _BMP_CTRL_MEAS = 0xF4  # Oversampling + mode
    _BMP_CONFIG    = 0xF5  # Standby + filtre IIR
    _BMP_CALIB     = 0x88  # Calibration dig_T1..dig_P9 (24 octets)
    _BMP_DATA      = 0xF7  # press_msb..temp_xlsb (6 octets)

    def __init__(self, config: Dict[str, Any]):
        self.config = config
        self.running = False
        self.thread: Optional[threading.Thread] = None
        self._lock = threading.Lock()

        # Données capteurs
        self.data: Dict[str, Any] = {
            'depth': 0.0,          # Profondeur en mètres
            'temperature': 20.0,   # Température en °C
            'heading': 0.0,        # Cap en degrés (0-360)
            'battery': 100.0,      # Batterie en %
            'roll': 0.0,           # Roulis en degrés
            'pitch': 0.0,          # Tangage en degrés
            'pressure': 1013.25,   # Pression en hPa
            'accel_x': 0.0,        # Accélération X en g
            'accel_y': 0.0,        # Accélération Y en g
            'accel_z': 1.0,        # Accélération Z en g
            'armed': False,        # État armé/désarmé
            'light': 0             # Luminosité LED (0-100)
        }

        # Mode simulation global (master switch)
        self.simulation_mode = config.get('simulation_mode', True)
        self._sim_start_time = time.time()

        # Flags par capteur : True = simulé, False = réel
        self.sensor_sim: Dict[str, bool] = {
            'depth':       self._cfg_bool('sim_depth', True),
            'temperature': self._cfg_bool('sim_temperature', True),
            'heading':     self._cfg_bool('sim_heading', True),
            'battery':     self._cfg_bool('sim_battery', True),
            'roll':        self._cfg_bool('sim_roll', True),
            'pitch':       self._cfg_bool('sim_pitch', True),
        }

        # État des capteurs matériels
        self.sensor_status: Dict[str, str] = {
            'adxl345': 'unknown',   # unknown, detected, error
            'depth':   'unknown',
            'imu':     'unknown',
            'mpu9250': 'unknown',   # MPU-9250 du GY-91
            'ak8963':  'unknown',   # Magnétomètre du GY-91
            'bmp280':  'unknown'    # Baromètre du GY-91
        }

        # Valeurs overridées par le scénario
        self._overrides: Dict[str, float] = {}

        # Gestionnaire IMU externe (imu_manager.py) — prioritaire sur le GY-91
        # interne pour roll/pitch/accélération. Injecté via set_imu_manager().
        self.imu_manager: Optional[Any] = None

        # Bus I2C
        self.i2c_bus: Optional[Any] = None
        self._i2c_available = False

        # Port série UART
        self.serial_port: Optional[Any] = None

        # Adresses I2C
        self._depth_addr = self._parse_addr(config.get('depth_sensor_i2c_addr', '0x76'))
        self._imu_addr = self._parse_addr(config.get('imu_i2c_addr', '0x68'))
        self._adxl_addr = self._parse_addr(config.get('adxl345_i2c_addr', '0x53'))
        self._adxl_enabled = self._cfg_bool('adxl345_enabled', False)
        self._adxl_ok = False  # Devient True après init réussie

        # GY-91 (MPU-9250 + BMP280) — remplaçant physique de l'ADXL345
        self._gy91_enabled = self._cfg_bool('gy91_enabled', True)
        self._mpu_addr = self._parse_addr(config.get('mpu9250_i2c_addr', '0x68'))
        self._ak_addr = self._parse_addr(config.get('ak8963_i2c_addr', '0x0C'))
        self._bmp_addr = self._parse_addr(config.get('bmp280_i2c_addr', '0x76'))
        self._mpu_ok = False   # MPU-9250 (accéléro/gyro) initialisé
        self._ak_ok = False    # AK8963 (boussole via bypass) initialisé
        self._bmp_ok = False   # BMP280 (pression/température) initialisé
        self._gy91_errors = 0  # Erreurs de lecture consécutives (fallback auto)
        self._GY91_MAX_ERRORS = 10
        self._ak_asa = (1.0, 1.0, 1.0)      # Ajustements sensibilité AK8963 (fuse ROM)
        self._bmp_calib: Dict[str, int] = {}  # Coefficients de calibration BMP280

    def _parse_addr(self, val) -> int:
        """Parse une adresse I2C depuis la config (string hex ou int)"""
        if isinstance(val, str):
            return int(val, 16)
        return int(val)

    def _cfg_bool(self, key: str, default: bool) -> bool:
        """Lit un booléen depuis la config (gère str/int/bool)"""
        val = self.config.get(key, default)
        if isinstance(val, bool):
            return val
        if isinstance(val, str):
            return val.lower() in ('true', '1', 'yes', 'on')
        return bool(val)

    def start(self):
        """Démarre l'acquisition des capteurs dans un thread dédié"""
        if self.running:
            return

        # Tenter d'initialiser le bus I2C
        self._init_i2c()

        # Initialiser le GY-91 (MPU-9250 + BMP280) en priorité
        if self._gy91_enabled and self._i2c_available:
            self._init_gy91()

        # Initialiser l'ADXL345 en fallback legacy si le MPU-9250 est absent
        if self._adxl_enabled and self._i2c_available and not self._mpu_ok:
            self._init_adxl345()

        self.running = True
        self._sim_start_time = time.time()
        self.thread = threading.Thread(
            target=self._sensor_loop,
            daemon=True,
            name="SensorThread"
        )
        self.thread.start()
        mode = "SIMULATION" if self.simulation_mode else "HYBRIDE"
        active_real = [k for k, v in self.sensor_sim.items() if not v]
        logger.info(f"Gestionnaire démarré (mode: {mode})" +
                    (f" — capteurs réels: {', '.join(active_real)}" if active_real else ""))

    def stop(self):
        """Arrête l'acquisition et libère les ressources"""
        self.running = False
        if self.thread:
            self.thread.join(timeout=2.0)
        self._cleanup()
        logger.info("Gestionnaire de capteurs arrêté")

    def set_imu_manager(self, imu_manager):
        """
        Injecte le gestionnaire IMU externe (ADXL345/GY91/QMI8658 via
        imu_manager.py). S'il est connecté, roll/pitch passent en mode RÉEL
        et ses données sont prioritaires sur le GY-91 interne.
        """
        self.imu_manager = imu_manager
        if imu_manager and imu_manager.is_connected():
            self.sensor_sim['roll'] = False
            self.sensor_sim['pitch'] = False
            logger.info(f"IMU externe {imu_manager.sensor_type} active — "
                        f"roll/pitch en mode RÉEL")

    def _init_i2c(self):
        """Initialise le bus I2C si disponible"""
        if not HAS_I2C:
            self.simulation_mode = True
            return

        try:
            bus_id = self.config.get('i2c_bus', 1)
            if isinstance(bus_id, str):
                bus_id = int(bus_id)
            self.i2c_bus = SMBus(bus_id)
            self._i2c_available = True
            logger.info(f"Bus I2C {bus_id} initialisé")

            # Vérifier la présence des capteurs
            try:
                self.i2c_bus.read_byte_data(self._depth_addr, 0x00)
                self.sensor_status['depth'] = 'detected'
                logger.info(f"Capteur de profondeur détecté à 0x{self._depth_addr:02X}")
            except Exception:
                self.sensor_status['depth'] = 'not_found'
                logger.warning(f"Capteur de profondeur non trouvé à 0x{self._depth_addr:02X}")

            try:
                self.i2c_bus.read_byte_data(self._imu_addr, 0x75)
                self.sensor_status['imu'] = 'detected'
                logger.info(f"IMU détectée à 0x{self._imu_addr:02X}")
            except Exception:
                self.sensor_status['imu'] = 'not_found'
                logger.warning(f"IMU non trouvée à 0x{self._imu_addr:02X}")

        except Exception as e:
            logger.warning(f"I2C non disponible: {e}")
            self.simulation_mode = True
            self._i2c_available = False

    def _init_adxl345(self):
        """Initialise l'accéléromètre ADXL345 sur I2C"""
        try:
            # Vérifier Device ID (0xE5 pour ADXL345)
            devid = self.i2c_bus.read_byte_data(self._adxl_addr, self._ADXL_DEVID)
            if devid != 0xE5:
                logger.error(f"ADXL345: Device ID invalide 0x{devid:02X} (attendu 0xE5)")
                self.sensor_status['adxl345'] = 'error'
                self._adxl_ok = False
                return

            # Configuration : plage ±16g, full resolution
            self.i2c_bus.write_byte_data(self._adxl_addr, self._ADXL_DATA_FORMAT, 0x0B)
            # Bande passante 100Hz
            self.i2c_bus.write_byte_data(self._adxl_addr, self._ADXL_BW_RATE, 0x0A)
            # Activer la mesure (bit 3 = MEASURE)
            self.i2c_bus.write_byte_data(self._adxl_addr, self._ADXL_POWER_CTL, 0x08)

            self._adxl_ok = True
            self.sensor_status['adxl345'] = 'detected'
            # Forcer roll/pitch en mode réel
            self.sensor_sim['roll'] = False
            self.sensor_sim['pitch'] = False
            logger.info(f"ADXL345 détecté à 0x{self._adxl_addr:02X} — roll/pitch en mode RÉEL")

        except Exception as e:
            logger.error(f"ADXL345: échec initialisation: {e}")
            self.sensor_status['adxl345'] = 'error'
            self._adxl_ok = False

    # ==========================================================
    # INITIALISATION GY-91 (MPU-9250 + AK8963 + BMP280)
    # ==========================================================

    def _init_gy91(self):
        """
        Initialise le module GY-91 (MPU-9250 + AK8963 + BMP280).
        Chaque puce est initialisée indépendamment dans un try/except :
        aucune absence de capteur ne fait crasher l'application.
        """
        self._init_mpu9250()
        if self._mpu_ok:
            # L'AK8963 n'est accessible qu'après activation du bypass MPU
            self._init_ak8963()
        self._init_bmp280()

        if self._mpu_ok and self._bmp_ok:
            logger.info("GY-91 complet détecté (MPU-9250 + BMP280) — mode CAPTEUR PHYSIQUE")
        elif self._mpu_ok or self._bmp_ok:
            logger.warning("GY-91 partiellement détecté — capteurs absents en simulation")
        else:
            logger.warning("GY-91 absent — télémétrie IMU/environnement en SIMULATION")

    def _init_mpu9250(self):
        """Initialise le MPU-9250 : réveil, plages, bypass I2C vers l'AK8963"""
        try:
            whoami = self.i2c_bus.read_byte_data(self._mpu_addr, self._MPU_WHO_AM_I)
            if whoami not in (0x71, 0x73, 0x70):
                # Certains clones répondent avec un autre ID : on continue quand même
                logger.warning(f"MPU-9250: WHO_AM_I inattendu 0x{whoami:02X} (attendu 0x71/0x73/0x70)")

            # Réveil (sortie du mode sleep, horloge interne auto)
            self.i2c_bus.write_byte_data(self._mpu_addr, self._MPU_PWR_MGMT_1, 0x00)
            time.sleep(0.05)
            # Plage accéléromètre ±2g (16384 LSB/g)
            self.i2c_bus.write_byte_data(self._mpu_addr, self._MPU_ACCEL_CONFIG, 0x00)
            # Plage gyroscope ±250°/s
            self.i2c_bus.write_byte_data(self._mpu_addr, self._MPU_GYRO_CONFIG, 0x00)
            # Mode I2C Bypass → AK8963 accessible directement à 0x0C
            self.i2c_bus.write_byte_data(self._mpu_addr, self._MPU_INT_PIN_CFG, 0x02)
            time.sleep(0.01)

            self._mpu_ok = True
            self.sensor_status['mpu9250'] = 'detected'
            # Basculer roll/pitch en mode réel
            self.sensor_sim['roll'] = False
            self.sensor_sim['pitch'] = False
            logger.info(f"MPU-9250 détecté à 0x{self._mpu_addr:02X} "
                        f"(WHO_AM_I=0x{whoami:02X}) — roll/pitch en mode RÉEL")
        except Exception as e:
            logger.warning(f"MPU-9250: non trouvé à 0x{self._mpu_addr:02X}: {e}")
            self.sensor_status['mpu9250'] = 'not_found'
            self._mpu_ok = False

    def _init_ak8963(self):
        """Initialise le magnétomètre AK8963 (accessible via bypass MPU-9250)"""
        try:
            wia = self.i2c_bus.read_byte_data(self._ak_addr, self._AK_WIA)
            if wia != 0x48:
                logger.error(f"AK8963: Device ID invalide 0x{wia:02X} (attendu 0x48)")
                self.sensor_status['ak8963'] = 'error'
                return

            # Lecture des ajustements de sensibilité usine (fuse ROM)
            self.i2c_bus.write_byte_data(self._ak_addr, self._AK_CNTL1, 0x00)  # Power down
            time.sleep(0.01)
            self.i2c_bus.write_byte_data(self._ak_addr, self._AK_CNTL1, 0x0F)  # Accès fuse ROM
            time.sleep(0.01)
            asa = self.i2c_bus.read_i2c_block_data(self._ak_addr, self._AK_ASAX, 3)
            self._ak_asa = tuple((a - 128) / 256.0 + 1.0 for a in asa)
            self.i2c_bus.write_byte_data(self._ak_addr, self._AK_CNTL1, 0x00)  # Power down
            time.sleep(0.01)
            # Mode mesure continue 100Hz, sortie 16 bits
            self.i2c_bus.write_byte_data(self._ak_addr, self._AK_CNTL1, 0x16)
            time.sleep(0.01)

            self._ak_ok = True
            self.sensor_status['ak8963'] = 'detected'
            # Basculer le cap boussole en mode réel
            self.sensor_sim['heading'] = False
            logger.info(f"AK8963 détecté à 0x{self._ak_addr:02X} (bypass) — heading en mode RÉEL")
        except Exception as e:
            logger.warning(f"AK8963: non trouvé à 0x{self._ak_addr:02X}: {e}")
            self.sensor_status['ak8963'] = 'not_found'
            self._ak_ok = False

    def _init_bmp280(self):
        """Initialise le BMP280 : lecture calibration + mesure continue"""
        try:
            chip_id = self.i2c_bus.read_byte_data(self._bmp_addr, self._BMP_ID)
            if chip_id not in (0x58, 0x60):
                logger.error(f"BMP280: Chip ID invalide 0x{chip_id:02X} (attendu 0x58/0x60)")
                self.sensor_status['bmp280'] = 'error'
                return

            # Coefficients de calibration (24 octets little-endian)
            raw = self.i2c_bus.read_i2c_block_data(self._bmp_addr, self._BMP_CALIB, 24)

            def u16(i):
                return raw[i] | (raw[i + 1] << 8)

            def s16(i):
                v = u16(i)
                return v - 0x10000 if v >= 0x8000 else v

            self._bmp_calib = {
                'T1': u16(0), 'T2': s16(2), 'T3': s16(4),
                'P1': u16(6), 'P2': s16(8), 'P3': s16(10),
                'P4': s16(12), 'P5': s16(14), 'P6': s16(16),
                'P7': s16(18), 'P8': s16(20), 'P9': s16(22),
            }

            # Filtre IIR x4, standby 62.5ms
            self.i2c_bus.write_byte_data(self._bmp_addr, self._BMP_CONFIG, 0x28)
            # Oversampling température x2 / pression x16, mode normal
            self.i2c_bus.write_byte_data(self._bmp_addr, self._BMP_CTRL_MEAS, 0x57)
            time.sleep(0.05)

            self._bmp_ok = True
            self.sensor_status['bmp280'] = 'detected'
            # Basculer la température en mode réel
            self.sensor_sim['temperature'] = False
            logger.info(f"BMP280 détecté à 0x{self._bmp_addr:02X} "
                        f"(ID=0x{chip_id:02X}) — température/pression en mode RÉEL")
        except Exception as e:
            logger.warning(f"BMP280: non trouvé à 0x{self._bmp_addr:02X}: {e}")
            self.sensor_status['bmp280'] = 'not_found'
            self._bmp_ok = False

    def _cleanup(self):
        """Libère les ressources I2C et UART"""
        if self.i2c_bus:
            try:
                self.i2c_bus.close()
            except Exception:
                pass
            self.i2c_bus = None
        if self.serial_port and hasattr(self.serial_port, 'is_open') and self.serial_port.is_open:
            self.serial_port.close()
            self.serial_port = None

    def _sensor_loop(self):
        """Boucle principale d'acquisition — mode hybride par capteur"""
        update_freq = self.config.get('update_frequency_hz', 20)
        if isinstance(update_freq, str):
            update_freq = int(update_freq)
        interval = 1.0 / max(update_freq, 1)

        while self.running:
            loop_start = time.time()
            try:
                # Mode hybride : simule ou lit chaque capteur indépendamment
                self._update_sensors_hybrid()
            except Exception as e:
                logger.error(f"Erreur boucle capteurs: {e}")

            # Maintenir la fréquence cible
            elapsed = time.time() - loop_start
            sleep_time = interval - elapsed
            if sleep_time > 0:
                time.sleep(sleep_time)

    def _update_sensors_hybrid(self):
        """
        Met à jour chaque capteur individuellement :
        - Simule si sensor_sim[key] == True
        - Lit le capteur réel si sensor_sim[key] == False
        Les lectures I2C du GY-91 sont faites HORS du lock pour ne pas
        bloquer les consommateurs de get_data().
        """
        t = time.time() - self._sim_start_time

        # --- IMU externe (IMUManager) : prioritaire sur le GY-91 interne ---
        imu_orient = None
        imu_accel = None
        if (self.imu_manager and self.imu_manager.is_connected()
                and not self.sensor_sim.get('roll', True)):
            imu_orient = self.imu_manager.get_orientation()
            imu_accel = self.imu_manager.get_acceleration()

        # --- Lectures GY-91 hors lock (I2C lent) ---
        accel = None      # (ax, ay, az) en g depuis le MPU-9250
        mag = None        # (mx, my, mz) depuis l'AK8963
        bmp = None        # (température °C, pression hPa) depuis le BMP280
        if imu_orient is None and self._mpu_ok and not self.sensor_sim.get('roll', True):
            accel = self._read_mpu_accel()
        if self._ak_ok and not self.sensor_sim.get('heading', True):
            mag = self._read_ak8963()
        if self._bmp_ok and not self.sensor_sim.get('temperature', True):
            bmp = self._read_bmp280()

        # Fallback ADXL345 legacy si pas de MPU
        adxl = None
        if not self._mpu_ok and self._adxl_ok and not self.sensor_sim.get('roll', True):
            adxl = self._read_adxl345()
            if adxl[0] is None:
                adxl = None

        with self._lock:
            # --- Profondeur ---
            if 'depth' not in self._overrides:
                if self.sensor_sim['depth']:
                    self.data['depth'] = max(0.0,
                        5.0 + 3.5 * math.sin(t * 0.08) + random.gauss(0, 0.1))
                else:
                    self.data['depth'] = self._read_depth_sensor()

            # --- Température (BMP280 ou simulation) ---
            if 'temperature' not in self._overrides:
                if bmp is not None:
                    self.data['temperature'] = round(bmp[0], 2)
                elif self.sensor_sim['temperature']:
                    self.data['temperature'] = (
                        18.0 + 2.0 * math.sin(t * 0.015) + random.gauss(0, 0.05))
                else:
                    self.data['temperature'] = self._read_temperature_sensor()

            # --- Roulis / Tangage / Accélération (IMU externe, MPU-9250, ADXL345 ou simulation) ---
            if imu_orient is not None:
                # Orientation déjà filtrée (filtre complémentaire) par IMUManager
                self.data['accel_x'] = imu_accel['x']
                self.data['accel_y'] = imu_accel['y']
                self.data['accel_z'] = imu_accel['z']
                if 'roll' not in self._overrides:
                    self.data['roll'] = imu_orient['roll']
                if 'pitch' not in self._overrides:
                    self.data['pitch'] = imu_orient['pitch']
            elif accel is not None or adxl is not None:
                ax, ay, az = accel if accel is not None else adxl
                self.data['accel_x'] = round(ax, 3)
                self.data['accel_y'] = round(ay, 3)
                self.data['accel_z'] = round(az, 3)
                if 'roll' not in self._overrides:
                    self.data['roll'] = math.degrees(math.atan2(ay, az))
                if 'pitch' not in self._overrides:
                    self.data['pitch'] = math.degrees(
                        math.atan2(-ax, math.sqrt(ay * ay + az * az)))
            else:
                # Simulation houle
                if 'roll' not in self._overrides and self.sensor_sim['roll']:
                    self.data['roll'] = (
                        4.0 * math.sin(t * 0.12) + 1.5 * math.sin(t * 0.31)
                        + random.gauss(0, 0.3))
                if 'pitch' not in self._overrides and self.sensor_sim['pitch']:
                    self.data['pitch'] = (
                        3.0 * math.sin(t * 0.09 + 0.8) + random.gauss(0, 0.2))
                # Accélération simulée cohérente avec l'attitude simulée
                roll_r = math.radians(self.data['roll'])
                pitch_r = math.radians(self.data['pitch'])
                self.data['accel_x'] = round(-math.sin(pitch_r), 3)
                self.data['accel_y'] = round(math.sin(roll_r) * math.cos(pitch_r), 3)
                self.data['accel_z'] = round(math.cos(roll_r) * math.cos(pitch_r), 3)

            # --- Cap boussole (AK8963 tilt-compensé ou simulation) ---
            if 'heading' not in self._overrides:
                if mag is not None:
                    self.data['heading'] = self._compute_heading(
                        mag, self.data['roll'], self.data['pitch'])
                elif self.sensor_sim['heading']:
                    self.data['heading'] = (t * 3.0 + 15.0 * math.sin(t * 0.05)) % 360.0
                else:
                    self.data['heading'] = self._read_heading_sensor()

            # --- Batterie ---
            if self.sensor_sim['battery']:
                self.data['battery'] = max(0.0, 100.0 - (t / 3600.0) * 10.0)
            else:
                self.data['battery'] = self._read_battery_sensor()

            # --- Pression (BMP280 réel ou corrélée à la profondeur) ---
            if bmp is not None:
                self.data['pressure'] = round(bmp[1], 2)
            else:
                self.data['pressure'] = 1013.25 + self.data['depth'] * 100.0

    def get_data(self) -> Dict[str, Any]:
        """Retourne une copie thread-safe de toutes les données capteurs"""
        with self._lock:
            return self.data.copy()

    def get(self, key: str, default: float = 0.0) -> float:
        """Retourne une valeur de télémétrie spécifique"""
        with self._lock:
            return self.data.get(key, default)

    def set_data(self, key: str, value: Any):
        """Définit une valeur de télémétrie (pour contrôle externe ou scénario)"""
        with self._lock:
            self.data[key] = value
            # Marquer comme overridé pour la simulation
            if key in ('heading', 'depth', 'roll', 'pitch', 'temperature'):
                self._overrides[key] = value

    def set_simulation(self, enabled: bool):
        """Active ou désactive le mode simulation (tous les capteurs)"""
        self.simulation_mode = enabled
        for key in self.sensor_sim:
            self.sensor_sim[key] = enabled
        mode = "activé" if enabled else "désactivé"
        logger.info(f"Mode simulation global {mode}")

    def set_sensor_sim(self, sensor: str, simulated: bool):
        """
        Active ou désactive la simulation pour un capteur spécifique.
        sensor: 'depth', 'temperature', 'heading', 'battery', 'roll', 'pitch'
        simulated: True = simulé, False = réel
        """
        if sensor not in self.sensor_sim:
            logger.warning(f"Capteur inconnu: {sensor}")
            return False

        # Vérifications matériel pour le mode réel
        if not simulated and sensor in ('roll', 'pitch') and not (
                self._mpu_ok or self._adxl_ok
                or (self.imu_manager and self.imu_manager.is_connected())):
            logger.warning(f"Aucune IMU disponible — {sensor} reste en simulation")
            return False
        if not simulated and sensor == 'heading' and not self._ak_ok:
            logger.warning("AK8963 non disponible — heading reste en simulation")
            return False
        if not simulated and sensor == 'temperature' and not self._bmp_ok:
            logger.warning("BMP280 non disponible — temperature reste en simulation")
            return False

        self.sensor_sim[sensor] = simulated
        mode = "simulé" if simulated else "réel"
        logger.info(f"Capteur {sensor} → {mode}")
        return True

    def get_sensor_status(self) -> Dict[str, Any]:
        """Retourne l'état de tous les capteurs (simulé/réel + statut matériel)"""
        return {
            'sensors': dict(self.sensor_sim),
            'hardware': dict(self.sensor_status),
            'adxl345_ok': self._adxl_ok,
            'gy91_connected': self.is_gy91_connected(),
            'mpu9250_ok': self._mpu_ok,
            'ak8963_ok': self._ak_ok,
            'bmp280_ok': self._bmp_ok,
            'imu_manager': self.imu_manager.get_status() if self.imu_manager else None,
            'simulation_mode': self.simulation_mode
        }

    def is_gy91_connected(self) -> bool:
        """True si le GY-91 est pleinement opérationnel (MPU-9250 ET BMP280)"""
        return self._mpu_ok and self._bmp_ok

    def get_structured_data(self) -> Dict[str, Any]:
        """
        Retourne la télémétrie au format structuré pour le cockpit :
        imu / environment / sensor_status (structure JSON du protocole WebSocket).
        """
        with self._lock:
            d = self.data.copy()
        # État de l'IMU externe pour le badge cockpit / page système
        imu_status = {
            'gy91_connected': self.is_gy91_connected(),
            'imu_sensor': None,
            'imu_connected': False,
            'imu_alert': None,
        }
        if self.imu_manager:
            st = self.imu_manager.get_status()
            imu_status['imu_sensor'] = st.get('sensor_name')
            imu_status['imu_connected'] = bool(st.get('connected') and st.get('healthy'))
            imu_status['imu_alert'] = st.get('alert')
        return {
            'imu': {
                'roll': round(float(d['roll']), 2),
                'pitch': round(float(d['pitch']), 2),
                'yaw': round(float(d['heading']), 2),
                'accel_x': float(d['accel_x']),
                'accel_y': float(d['accel_y']),
                'accel_z': float(d['accel_z']),
            },
            'environment': {
                'temperature': round(float(d['temperature']), 2),
                'pressure': round(float(d['pressure']), 2),
            },
            'sensor_status': imu_status
        }

    def is_simulation(self) -> bool:
        """Retourne True si le mode simulation global est actif"""
        return self.simulation_mode

    def clear_overrides(self):
        """Efface tous les overrides de scénario (retour à la simulation auto)"""
        with self._lock:
            self._overrides.clear()
        logger.info("Overrides scénario effacés")

    # ==========================================================
    # LECTURE CAPTEURS INDIVIDUELS
    # ==========================================================

    def _read_adxl345(self):
        """
        Lit l'ADXL345 et retourne (ax, ay, az) en g.
        Retourne (None, None, None) en cas d'erreur.
        """
        if not self._adxl_ok or not self.i2c_bus:
            return (None, None, None)
        try:
            # Lecture 6 octets (X0, X1, Y0, Y1, Z0, Z1)
            raw = self.i2c_bus.read_i2c_block_data(
                self._adxl_addr, self._ADXL_DATAX0, 6)
            # Convertir en valeurs signées 16-bit (little-endian)
            ax = self._to_int16(raw[0], raw[1])
            ay = self._to_int16(raw[2], raw[3])
            az = self._to_int16(raw[4], raw[5])
            # Échelle : 4mg/LSB en mode full resolution
            scale = 0.004
            return (ax * scale, ay * scale, az * scale)
        except Exception as e:
            logger.debug(f"Erreur lecture ADXL345: {e}")
            # Fallback simulation après quelques erreurs
            return (None, None, None)

    def _to_int16(self, lsb: int, msb: int) -> int:
        """Convertit 2 octets en entier signé 16 bits (little-endian)"""
        val = (msb << 8) | lsb
        if val >= 0x8000:
            val -= 0x10000
        return val

    def _gy91_read_error(self, chip: str, err: Exception):
        """Comptabilise une erreur de lecture GY-91 et bascule en simulation si besoin"""
        self._gy91_errors += 1
        logger.debug(f"Erreur lecture {chip}: {err}")
        if self._gy91_errors >= self._GY91_MAX_ERRORS:
            logger.error(f"GY-91: {self._gy91_errors} erreurs consécutives — retour en SIMULATION")
            self._mpu_ok = False
            self._ak_ok = False
            self._bmp_ok = False
            self.sensor_status['mpu9250'] = 'error'
            self.sensor_status['ak8963'] = 'error'
            self.sensor_status['bmp280'] = 'error'
            for key in ('roll', 'pitch', 'heading', 'temperature'):
                self.sensor_sim[key] = True

    def _read_mpu_accel(self):
        """
        Lit l'accéléromètre du MPU-9250 et retourne (ax, ay, az) en g.
        Retourne None en cas d'erreur (fallback simulation géré par l'appelant).
        """
        if not self.i2c_bus:
            return None
        try:
            # 6 octets big-endian à partir de ACCEL_XOUT_H
            raw = self.i2c_bus.read_i2c_block_data(
                self._mpu_addr, self._MPU_ACCEL_XOUT_H, 6)
            ax = self._to_int16(raw[1], raw[0]) / 16384.0  # ±2g → 16384 LSB/g
            ay = self._to_int16(raw[3], raw[2]) / 16384.0
            az = self._to_int16(raw[5], raw[4]) / 16384.0
            self._gy91_errors = 0
            return (ax, ay, az)
        except Exception as e:
            self._gy91_read_error('MPU-9250', e)
            return None

    def _read_ak8963(self):
        """
        Lit le magnétomètre AK8963 et retourne (mx, my, mz) en µT.
        Retourne None si pas de donnée prête, overflow magnétique ou erreur.
        """
        if not self.i2c_bus:
            return None
        try:
            # Bit 0 de ST1 = data ready
            if not (self.i2c_bus.read_byte_data(self._ak_addr, self._AK_ST1) & 0x01):
                return None
            # 7 octets little-endian : HXL..HZH + ST2 (lecture ST2 obligatoire)
            raw = self.i2c_bus.read_i2c_block_data(self._ak_addr, self._AK_HXL, 7)
            if raw[6] & 0x08:  # ST2 bit 3 = overflow magnétique
                return None
            scale = 0.15  # µT/LSB en mode 16 bits
            mx = self._to_int16(raw[0], raw[1]) * self._ak_asa[0] * scale
            my = self._to_int16(raw[2], raw[3]) * self._ak_asa[1] * scale
            mz = self._to_int16(raw[4], raw[5]) * self._ak_asa[2] * scale
            self._gy91_errors = 0
            return (mx, my, mz)
        except Exception as e:
            self._gy91_read_error('AK8963', e)
            return None

    def _read_bmp280(self):
        """
        Lit le BMP280 et retourne (température °C, pression hPa).
        Compensation via les formules flottantes du datasheet Bosch.
        Retourne None en cas d'erreur.
        """
        if not self.i2c_bus or not self._bmp_calib:
            return None
        try:
            raw = self.i2c_bus.read_i2c_block_data(self._bmp_addr, self._BMP_DATA, 6)
            adc_p = (raw[0] << 12) | (raw[1] << 4) | (raw[2] >> 4)
            adc_t = (raw[3] << 12) | (raw[4] << 4) | (raw[5] >> 4)
            c = self._bmp_calib

            # Compensation température (datasheet Bosch, version float)
            var1 = (adc_t / 16384.0 - c['T1'] / 1024.0) * c['T2']
            var2 = ((adc_t / 131072.0 - c['T1'] / 8192.0) ** 2) * c['T3']
            t_fine = var1 + var2
            temp_c = t_fine / 5120.0

            # Compensation pression
            var1 = t_fine / 2.0 - 64000.0
            var2 = var1 * var1 * c['P6'] / 32768.0
            var2 = var2 + var1 * c['P5'] * 2.0
            var2 = var2 / 4.0 + c['P4'] * 65536.0
            var1 = (c['P3'] * var1 * var1 / 524288.0 + c['P2'] * var1) / 524288.0
            var1 = (1.0 + var1 / 32768.0) * c['P1']
            if var1 == 0:
                return None  # Évite division par zéro
            p = 1048576.0 - adc_p
            p = (p - var2 / 4096.0) * 6250.0 / var1
            var1 = c['P9'] * p * p / 2147483648.0
            var2 = p * c['P8'] / 32768.0
            p = p + (var1 + var2 + c['P7']) / 16.0

            self._gy91_errors = 0
            return (temp_c, p / 100.0)  # Pa → hPa
        except Exception as e:
            self._gy91_read_error('BMP280', e)
            return None

    def _compute_heading(self, mag, roll_deg: float, pitch_deg: float) -> float:
        """
        Calcule le cap boussole (0-360°) tilt-compensé depuis le magnétomètre.
        Remappe les axes AK8963 vers le repère du MPU-9250 (X mag = Y accel).
        """
        # Remap axes magnétomètre → repère MPU (datasheet MPU-9250)
        mx, my, mz = mag[1], mag[0], -mag[2]
        roll_r = math.radians(roll_deg)
        pitch_r = math.radians(pitch_deg)
        # Compensation d'inclinaison (tilt compensation)
        xh = mx * math.cos(pitch_r) + mz * math.sin(pitch_r)
        yh = (mx * math.sin(roll_r) * math.sin(pitch_r)
              + my * math.cos(roll_r)
              - mz * math.sin(roll_r) * math.cos(pitch_r))
        return (math.degrees(math.atan2(-yh, xh)) + 360.0) % 360.0

    def _read_depth_sensor(self) -> float:
        """Lecture capteur de profondeur (TODO: implémenter selon matériel)"""
        return 0.0

    def _read_temperature_sensor(self) -> float:
        """Lecture capteur de température (TODO: implémenter selon matériel)"""
        return 20.0

    def _read_heading_sensor(self) -> float:
        """Lecture magnétomètre (TODO: implémenter selon matériel)"""
        return 0.0

    def _read_battery_sensor(self) -> float:
        """Lecture ADC batterie (TODO: implémenter selon matériel)"""
        return 100.0
