"""
Module I2C Controller pour Cockpit-Lite ROV.
Communique avec un ESP32-S3 émulant un PCA9685 sur le bus I2C (adresse 0x40).
Thread dédié avec queue de commandes, conversion PWM, et gestion reconnexion.
"""

import logging
import threading
import time
from typing import Dict, Any, Optional

try:
    from smbus2 import SMBus
except ImportError:
    SMBus = None

logger = logging.getLogger(__name__)


class I2CController:
    """
    Contrôleur I2C pour PCA9685 (ESP32-S3) — gestion des signaux PWM moteurs.

    Communication via SMBus avec un PCA9685 à l'adresse 0x40.
    Thread daemon dédié avec queue de commandes à update_rate_hz max.
    Conversion DOF [-1.0, +1.0] → PWM [205, 410], neutre = 307.
    Fallback simulation si I2C indisponible.
    """

    # Registres PCA9685
    _MODE1 = 0x00
    _MODE2 = 0x01
    _PRESCALE = 0xFE
    _LED0_ON_L = 0x06  # Base register pour le canal 0

    # Canaux spéciaux : valeurs déjà en PWM raw [205, 410]
    # ch13 = Angle de Tangage IMU (205=-180°, 307=0°, 410=+180°)
    # ch14 = Mode Auto-Pilote (205=PASSIF, 307=AUTO-ROLL, 410=AUTO-FULL)
    # ch15 = Angle de Roulis IMU (205=-180°, 307=0°, 410=+180°)
    _RAW_CHANNELS = {13, 14, 15}

    def __init__(self, config: Optional[Any] = None):
        # Defaults
        self._bus_id = 1
        self._address = 0x40
        self._update_rate_hz = 20
        self._enabled = True
        self._fallback_simulation = True
        self._reconnect_interval_s = 3.0

        # Lire la config si fournie
        if config is not None:
            self._load_config(config)

        # État interne
        self._connected = False
        self._running = False
        self._bus: Optional[Any] = None
        self._lock = threading.Lock()
        self._consecutive_errors = 0
        self._error_count = 0
        self._last_error: Optional[str] = None
        self._last_reconnect_attempt = 0.0

        # Événement d'arrêt : permet un sleep interruptible et un shutdown immédiat
        self._stop_event = threading.Event()

        # Bucket mémoire : dernière valeur connue de chaque canal (mise à jour par
        # queue_send, non-bloquante). La boucle _i2c_loop dépile ce buffer à
        # update_rate_hz. Seules les valeurs CHANGÉES sont écrites sur le bus.
        self._pending_channels: Dict[int, float] = {}
        self._pending_lock = threading.Lock()
        # Dernière valeur PWM réellement écrite par canal (optimisation différentielle)
        self._last_written: Dict[int, int] = {}

        # Thread dédié
        self._thread: Optional[threading.Thread] = None

        # Initialiser le bus I2C et le PCA9685
        if self._enabled:
            self._init_i2c()

    def _load_config(self, config: Any):
        """Lit la section [I2C_CONTROLLER] depuis le ConfigParser"""
        section = 'I2C_CONTROLLER'
        try:
            if hasattr(config, 'config') and hasattr(config.config, 'has_section'):
                # Wrapper ConfigParser du projet (config.config = configparser.ConfigParser)
                if config.config.has_section(section):
                    self._bus_id = int(config.get(section, 'i2c_bus', self._bus_id))
                    addr_str = config.get(section, 'pca9685_address', str(self._address))
                    self._address = int(str(addr_str), 0)
                    self._update_rate_hz = int(config.get(section, 'update_rate_hz', self._update_rate_hz))
                    val = config.get(section, 'enabled', str(self._enabled))
                    self._enabled = str(val).lower() in ('true', '1', 'yes', 'on')
                    val = config.get(section, 'fallback_simulation', str(self._fallback_simulation))
                    self._fallback_simulation = str(val).lower() in ('true', '1', 'yes', 'on')
                    self._reconnect_interval_s = float(config.get(section, 'reconnect_interval_s', str(self._reconnect_interval_s)))
            elif hasattr(config, 'get'):
                # ConfigParser standard ou dict-like
                if hasattr(config, 'has_section') and config.has_section(section):
                        self._bus_id = int(config.get(section, 'i2c_bus', fallback=str(self._bus_id)))
                        self._address = int(config.get(section, 'pca9685_address', fallback=str(self._address)), 0)
                        self._update_rate_hz = int(config.get(section, 'update_rate_hz', fallback=str(self._update_rate_hz)))
                        self._enabled = config.get(section, 'enabled', fallback=str(self._enabled)).lower() in ('true', '1', 'yes', 'on')
                        self._fallback_simulation = config.get(section, 'fallback_simulation', fallback=str(self._fallback_simulation)).lower() in ('true', '1', 'yes', 'on')
                elif isinstance(config, dict):
                    i2c_cfg = config.get(section, config) if section in config else config
                    if isinstance(i2c_cfg, dict):
                        self._bus_id = int(i2c_cfg.get('i2c_bus', self._bus_id))
                        self._address = int(str(i2c_cfg.get('pca9685_address', self._address)), 0)
                        self._update_rate_hz = int(i2c_cfg.get('update_rate_hz', self._update_rate_hz))
                        val = i2c_cfg.get('enabled', self._enabled)
                        if isinstance(val, str):
                            self._enabled = val.lower() in ('true', '1', 'yes', 'on')
                        else:
                            self._enabled = bool(val)
                        val = i2c_cfg.get('fallback_simulation', self._fallback_simulation)
                        if isinstance(val, str):
                            self._fallback_simulation = val.lower() in ('true', '1', 'yes', 'on')
                        else:
                            self._fallback_simulation = bool(val)
        except Exception as e:
            logger.warning(f"Erreur lecture config I2C_CONTROLLER: {e}")

    def _init_i2c(self):
        """
        Initialise le bus I2C et détecte le PCA9685 (ESP32-S3) par ÉCRITURE.
        L'ESP32-S3 émule un PCA9685 en mode write-only : toute relecture (read_byte,
        i2cget) renvoie 0x00 et n'est donc PAS fiable pour la détection.
        Détection : si le bus /dev/i2c-N s'ouvre et que les écritures de config
        n'émettent aucune OSError/IOError, l'ESP32 est considéré CONNECTÉ.
        """
        if SMBus is None:
            logger.warning("smbus2 non disponible, I2C désactivé")
            self._connected = False
            self._last_error = "smbus2 non disponible"
            return

        try:
            self._bus = SMBus(self._bus_id)
        except Exception as e:
            self._connected = False
            self._last_error = str(e)
            logger.warning(f"Ouverture bus I2C {self._bus_id} échouée: {e} — mode fallback actif")
            return

        # Détection par écriture : configuration PCA9685 à 50Hz.
        # Si aucune écriture ne lève d'exception → ESP32 connecté.
        try:
            self._configure_pca9685()
            self._connected = True
            self._error_count = 0
            self._consecutive_errors = 0
            self._last_error = None
            self._last_written.clear()  # forcer une réécriture complète
            logger.info(f"PCA9685 (ESP32-S3) détecté par écriture à 0x{self._address:02X} sur bus {self._bus_id}")
        except Exception as e:
            self._connected = False
            self._last_error = str(e)
            logger.warning(f"PCA9685 non détecté (écriture échouée): {e} — mode fallback actif")

    def _configure_pca9685(self):
        """
        Écrit la séquence d'initialisation PCA9685 (50Hz).
        Lève une exception si le bus ne répond pas (device absent).
        """
        # 1. Sleep mode pour modifier le prescaler
        self._bus.write_byte_data(self._address, self._MODE1, 0x10)
        # 2. Prescale pour 50Hz : prescale = round(25MHz / (4096 * 50Hz)) - 1 = 121
        self._bus.write_byte_data(self._address, self._PRESCALE, 121)
        # 3. Mode normal (réveil)
        self._bus.write_byte_data(self._address, self._MODE1, 0x00)
        # 4. Attendre 5ms pour la stabilisation de l'oscillateur
        time.sleep(0.005)
        # 5. Restart
        self._bus.write_byte_data(self._address, self._MODE1, 0x80)
        logger.info("PCA9685 configuré (50Hz, write-only)")

    def start(self):
        """Démarre le thread dédié I2C"""
        if self._running:
            return
        self._stop_event.clear()
        self._running = True
        self._thread = threading.Thread(
            target=self._i2c_loop,
            daemon=True,
            name="I2CControllerThread"
        )
        self._thread.start()
        mode = "connecté" if self._connected else "fallback"
        logger.info(f"I2CController démarré ({mode}, {self._update_rate_hz}Hz)")

    def stop(self):
        """Arrête le thread et ferme le bus I2C (shutdown immédiat, non bloquant)"""
        self._running = False
        self._stop_event.set()  # réveille immédiatement le sleep de la boucle
        if self._thread:
            self._thread.join(timeout=2.0)
        self._close_bus()
        logger.info("I2CController arrêté")

    def _close_bus(self):
        """Ferme le bus SMBus proprement"""
        if self._bus:
            try:
                self._bus.close()
            except Exception:
                pass
            self._bus = None

    def _i2c_loop(self):
        """Boucle du thread dédié — traite les commandes de la queue à update_rate_hz
        et tente une reconnexion automatique en arrière-plan si le bus est perdu."""
        interval = 1.0 / max(self._update_rate_hz, 1)

        while self._running and not self._stop_event.is_set():
            loop_start = time.time()
            try:
                if self._connected:
                    # Dépiler le bucket : snapshot de la dernière valeur de chaque canal.
                    # send_channels n'écrit que les canaux dont la valeur a changé.
                    with self._pending_lock:
                        channels = dict(self._pending_channels) if self._pending_channels else None
                    if channels:
                        self.send_channels(channels)
                else:
                    # Reconnexion automatique en arrière-plan (throttlée)
                    if (loop_start - self._last_reconnect_attempt) >= self._reconnect_interval_s:
                        logger.debug("Tentative de reconnexion I2C automatique...")
                        self.reconnect()
            except Exception as e:
                logger.error(f"Erreur boucle I2C: {e}")

            # Maintenir la fréquence cible avec un sleep interruptible :
            # stop() déclenche _stop_event et la boucle sort sans délai.
            elapsed = time.time() - loop_start
            sleep_time = interval - elapsed
            if sleep_time > 0:
                if self._stop_event.wait(sleep_time):
                    break

    @staticmethod
    def dof_to_pwm(value: float) -> int:
        """
        Convertit une valeur DOF [-1.0, +1.0] en valeur PWM [205, 410].
        Neutre (0.0) = 307.
        """
        pwm = int(307 + value * 102.5)
        return max(205, min(410, pwm))

    def send_channels(self, channels: Dict[int, float]):
        """
        Écriture directe synchrone des canaux PWM sur le PCA9685.
        Appelée depuis le thread I2C.

        Canaux 0..7 : les 8 moteurs M0..M7 (valeurs DOF converties via dof_to_pwm).
        Canaux 14 et 15 : Auto-Pilote (mode + roll), valeurs PWM raw [205, 410].
        """
        if not self._connected or not self._bus:
            return

        written: Dict[int, int] = {}
        for channel, value in channels.items():
            if channel < 0 or channel > 15:
                continue

            # Conversion PWM
            if channel in self._RAW_CHANNELS:
                pwm_value = int(value)
                pwm_value = max(205, min(410, pwm_value))
            else:
                pwm_value = self.dof_to_pwm(value)

            # Optimisation différentielle : ne rien écrire si la valeur PWM
            # de ce canal n'a pas changé depuis la dernière trame envoyée.
            if self._last_written.get(channel) == pwm_value:
                continue

            # Registre de base pour ce canal
            base_register = self._LED0_ON_L + 4 * channel

            try:
                # LED_ON = 0 (ON_L, ON_H)
                self._bus.write_byte_data(self._address, base_register, 0)       # ON_L
                self._bus.write_byte_data(self._address, base_register + 1, 0)   # ON_H
                # LED_OFF = pwm_value (OFF_L, OFF_H)
                self._bus.write_byte_data(self._address, base_register + 2, pwm_value & 0xFF)        # OFF_L
                self._bus.write_byte_data(self._address, base_register + 3, (pwm_value >> 8) & 0x0F) # OFF_H
                # Succès : reset du compteur consécutif
                self._consecutive_errors = 0
                self._last_written[channel] = pwm_value
                written[channel] = pwm_value
            except Exception as e:
                self._consecutive_errors += 1
                self._error_count += 1
                self._last_error = str(e)
                logger.debug(f"Erreur écriture canal {channel}: {e}")

                if self._consecutive_errors >= 3:
                    self._connected = False
                    logger.error(f"3 erreurs I2C consécutives — déconnexion")
                    return

        # Log explicite de la trame PWM réellement écrite sur le bus I2C-1
        if written:
            logger.info(
                "I2C→ESP32 trame PWM (bus %d @0x%02X): %s",
                self._bus_id, self._address,
                {f"ch{ch}": pwm for ch, pwm in sorted(written.items())}
            )

    def queue_send(self, channels: Dict[int, float]):
        """
        Méthode publique non-bloquante — met à jour le bucket mémoire.
        Aucune écriture I2C synchrone ici : on stocke simplement la dernière
        valeur de chaque canal. La boucle _i2c_loop dépile ce buffer à
        update_rate_hz et n'écrit que les valeurs qui ont changé.
        Appelée depuis motor_manager ou autre thread externe (WebSocket).
        """
        if not self._connected and self._fallback_simulation:
            return

        # Dernière valeur gagnante : on écrase les anciennes consignes non écrites.
        with self._pending_lock:
            self._pending_channels.update(channels)

    def reconnect(self) -> bool:
        """
        Tente de rouvrir le bus et de re-détecter le PCA9685 par ÉCRITURE.
        Pas de read-back (l'ESP32-S3 est write-only).
        Retourne True si l'ouverture du bus et les écritures de config réussissent.
        """
        self._last_reconnect_attempt = time.time()
        self._close_bus()
        try:
            if SMBus is None:
                return False

            self._bus = SMBus(self._bus_id)
            # Détection par écriture uniquement — pas de read-back
            self._configure_pca9685()

            # Détecté → marquage connecté
            self._connected = True
            self._error_count = 0
            self._consecutive_errors = 0
            self._last_error = None
            self._last_written.clear()  # forcer une réécriture complète

            logger.info(f"PCA9685 reconnecté à 0x{self._address:02X} sur bus {self._bus_id}")
            return True

        except Exception as e:
            self._connected = False
            self._last_error = str(e)
            logger.warning(f"Reconnexion I2C échouée (écriture): {e}")
            return False

    def is_connected(self) -> bool:
        """Retourne True si le PCA9685 est connecté et opérationnel"""
        return self._connected

    def get_status(self) -> Dict[str, Any]:
        """
        Retourne le statut du contrôleur I2C — détection par probe d'adresse uniquement.
        Pas de read-back : l'ESP32-S3 est en mode write-only.
        """
        return {
            'detected': self._connected,
            'connected': self._connected,  # rétrocompatibilité
            'address': f"0x{self._address:02X}",
            'bus': self._bus_id,
            'last_error': self._last_error,
            'error_count': self._error_count,
            'mode': 'i2c' if self._connected else 'simulation'
        }
