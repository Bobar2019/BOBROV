# Protocole I2C — Backend Python (RPi 5) ↔ ESP32-S3

> Document technique décrivant la communication I2C entre le backend Python
> hébergé sur Raspberry Pi 5 et le contrôleur de vol ESP32-S3 dans le cadre
> du projet **Cockpit-Lite ROV**.

---

## 1. Adresse I2C et Bus matériel

| Paramètre | Valeur |
|---|---|
| **Adresse I2C esclave** | `0x40` (adresse PCA9685 standard) |
| **Bus I2C** | `/dev/i2c-1` (bus n° 1 sur le Raspberry Pi 5) |
| **Librairie Python** | `smbus2` (`SMBus(1)`) |
| **Mode de l'ESP32-S3** | Émulation PCA9685 **write-only** (toute lecture renvoie `0x00`) |

La configuration est définie dans `config.txt`, section `[I2C_CONTROLLER]` :

```ini
[I2C_CONTROLLER]
enabled = True
i2c_bus = 1
pca9685_address = 0x40
update_rate_hz = 20
fallback_simulation = True
reconnect_interval_s = 3.0
```

### Détection de l'ESP32-S3

L'ESP32-S3 émule un PCA9685 en mode **write-only**. La détection ne repose donc
**pas** sur une lecture (`i2cget` / `read_byte_data`) mais sur une **séquence
d'écriture** de configuration. Si les écritures ne lèvent aucune `OSError`,
l'ESP32-S3 est considéré comme connecté.

Séquence d'initialisation (`_configure_pca9685`) :

| Étape | Registre | Valeur | Description |
|---|---|---|---|
| 1 | `MODE1` (`0x00`) | `0x10` | Passage en mode Sleep |
| 2 | `PRESCALE` (`0xFE`) | `121` | Prescaler pour 50 Hz (`round(25MHz / (4096 × 50)) - 1`) |
| 3 | `MODE1` (`0x00`) | `0x00` | Réveil (mode normal) |
| 4 | — | — | Pause de 5 ms (stabilisation oscillateur) |
| 5 | `MODE1` (`0x00`) | `0x80` | Restart |

---

## 2. Format des transactions I2C

### 2.1 Émulation stricte PCA9685 (4 octets par canal)

Le protocole utilise l'émulation **stricte** d'un PCA9685 : chaque canal PWM
est configuré par l'écriture séquentielle de **4 octets** via
`write_byte_data()` :

```
Base register = LED0_ON_L + 4 × canal
              = 0x06 + 4 × canal
```

| Offset | Registre | Valeur écrite | Description |
|---|---|---|---|
| `+0` | `ON_L` | `0x00` | Bit bas du temps ON (toujours 0) |
| `+1` | `ON_H` | `0x00` | Bit haut du temps ON (toujours 0) |
| `+2` | `OFF_L` | `pwm & 0xFF` | Octet bas de la valeur PWM |
| `+3` | `OFF_H` | `(pwm >> 8) & 0x0F` | Octet haut de la valeur PWM (4 bits) |

Le signal démarre toujours au tick 0 (`ON = 0`) et s'éteint au tick
`pwm_value`. La résolution est de **12 bits** (0–4095).

### 2.2 Ordre des octets

**Little-Endian** : l'octet de poids faible (`OFF_L`) est écrit en premier
à l'adresse de base `+2`, suivi de l'octet de poids fort (`OFF_H`) à `+3`.

### 2.3 Écriture différentielle

Une **optimisation différentielle** est appliquée : seuls les canaux dont la
valeur PWM a **changé** depuis la dernière trame sont effectivement écrits sur
le bus. Le dictionnaire `_last_written` mémorise la dernière valeur PWM envoyée
par canal.

### 2.4 Mode bucket (non-bloquant)

L'API publique `queue_send(channels)` ne fait **aucune écriture I2C directe**.
Elle met à jour un bucket mémoire (`_pending_channels`) contenant la dernière
valeur connue de chaque canal. Le thread dédié (`_i2c_loop`) dépile ce bucket
à la fréquence `update_rate_hz`.

---

## 3. Cartographie des Registres / Mapping des Canaux

### 3.1 Adresses des registres par canal

| Canal | Registre de base (`0x06 + 4×ch`) | Registres utilisés |
|---|---|---|
| 0 | `0x06` | `0x06`, `0x07`, `0x08`, `0x09` |
| 1 | `0x0A` | `0x0A`, `0x0B`, `0x0C`, `0x0D` |
| 2 | `0x0E` | `0x0E`, `0x0F`, `0x10`, `0x11` |
| 3 | `0x12` | `0x12`, `0x13`, `0x14`, `0x15` |
| 4 | `0x16` | `0x16`, `0x17`, `0x18`, `0x19` |
| 5 | `0x1A` | `0x1A`, `0x1B`, `0x1C`, `0x1D` |
| 6 | `0x1E` | `0x1E`, `0x1F`, `0x20`, `0x21` |
| 7 | `0x22` | `0x22`, `0x23`, `0x24`, `0x25` |
| 13 | `0x3A` | `0x3A`, `0x3B`, `0x3C`, `0x3D` |
| 14 | `0x3E` | `0x3E`, `0x3F`, `0x40`, `0x41` |
| 15 | `0x42` | `0x42`, `0x43`, `0x44`, `0x45` |

### 3.2 Canaux moteurs (ch0 – ch7) : Commande 6 DOF

Les 8 canaux moteurs transportent les commandes de poussée issues du mixage
6 DOF. La conversion DOF → moteurs est assurée par le `MotorMixer` :

| Canal | Moteur | Position | Groupe | Axes DOF pilotés |
|---|---|---|---|---|
| **ch0** | M1 | Horizontal Avant-Droit | Horizontal | Surge, Sway, Yaw |
| **ch1** | M2 | Horizontal Arrière-Droit | Horizontal | Surge, Sway, Yaw |
| **ch2** | M3 | Horizontal Arrière-Gauche | Horizontal | Surge, Sway, Yaw |
| **ch3** | M4 | Horizontal Avant-Gauche | Horizontal | Surge, Sway, Yaw |
| **ch4** | M5 | Vertical Avant-Droit | Vertical | Heave, Roll, Pitch |
| **ch5** | M6 | Vertical Arrière-Droit | Vertical | Heave, Roll, Pitch |
| **ch6** | M7 | Vertical Arrière-Gauche | Vertical | Heave, Roll, Pitch |
| **ch7** | M8 | Vertical Avant-Gauche | Vertical | Heave, Roll, Pitch |

Numérotation : départ avant-droit, sens horaire strict, deux groupes distincts.

**Matrice de mixage horizontale** `[surge, sway, yaw]` :

| Moteur | Surge | Sway | Yaw |
|---|---|---|---|
| M1 (ch0) | +0.707 | −0.707 | −1.0 |
| M2 (ch1) | −0.707 | −0.707 | +1.0 |
| M3 (ch2) | −0.707 | +0.707 | −1.0 |
| M4 (ch3) | +0.707 | +0.707 | +1.0 |

**Matrice de mixage verticale** `[heave, roll, pitch]` :

| Moteur | Heave | Roll | Pitch |
|---|---|---|---|
| M5 (ch4) | +1.0 | −1.0 | +1.0 |
| M6 (ch5) | +1.0 | −1.0 | −1.0 |
| M7 (ch6) | +1.0 | +1.0 | −1.0 |
| M8 (ch7) | +1.0 | +1.0 | +1.0 |

### 3.3 Canaux Auto-Pilote (ch13, ch14, ch15)

Trois canaux réservés sont alimentés par la boucle `_autopilot_sync_loop` du
serveur et transmettent les données IMU et le mode de stabilisation à l'ESP32-S3 :

| Canal | Fonction | Source | Description |
|---|---|---|---|
| **ch13** | Angle de Tangage (Pitch IMU) | IMU QMI8658 | Angle en degrés converti en PWM |
| **ch14** | Mode Auto-Pilote | `rov_state['autopilot_mode']` | Sélection du mode de stabilisation |
| **ch15** | Angle de Roulis (Roll IMU) | IMU QMI8658 | Angle en degrés converti en PWM |

Ces trois canaux sont des **canaux raw** (`_RAW_CHANNELS = {13, 14, 15}`) :
leurs valeurs sont transmises directement en PWM sans passer par la conversion
`dof_to_pwm`.

### 3.4 Modes Auto-Pilote (ch14)

| Valeur `rov_state` | Mode | PWM envoyé |
|---|---|---|
| `1` | **PASSIF** (aucune stabilisation) | `205` |
| `2` | **AUTO-ROLL** (stabilisation roulis uniquement) | `307` |
| `3` | **AUTO-FULL** (stabilisation roulis + tangage) | `410` |

### 3.5 Canaux inutilisés

Les canaux **ch8 à ch12** ne sont actuellement pas utilisés.

---

## 4. Unités et Plages de Valeurs

### 4.1 Canaux moteurs (ch0 – ch7)

| Domaine | Plage |
|---|---|
| **Entrée logicielle (DOF)** | `−1.0` à `+1.0` (normalisé) |
| **Sortie PWM (12 bits)** | `205` à `410` |
| **Neutre (point mort)** | `0.0` → PWM **`307`** |

**Formule de conversion** (`dof_to_pwm`) :

```
pwm = 307 + value × 102.5
pwm = clamp(pwm, 205, 410)
```

| Valeur DOF | PWM | Impulsion @50Hz |
|---|---|---|
| `−1.0` (pleine puissance inverse) | `205` | ≈ 1.0 ms |
| `0.0` (neutre / point mort) | `307` | ≈ 1.5 ms |
| `+1.0` (pleine puissance avant) | `410` | ≈ 2.0 ms |

> La plage `[205, 410]` correspond à la plage standard ESC `[1.0 ms, 2.0 ms]`
> à la fréquence PWM de 50 Hz (période = 20 ms, 4096 ticks).
> Un tick = `20 ms / 4096 ≈ 4.88 µs`.

### 4.2 Canaux Auto-Pilote (ch13, ch15) — Angles IMU

| Domaine | Plage |
|---|---|
| **Entrée** | `−180.0°` à `+180.0°` |
| **Sortie PWM** | `205` à `410` |
| **Neutre (0°)** | PWM **`307`** |

**Formule de conversion** (`angle_to_pwm`) :

```
Si angle >= 0 :  pwm = 307 + (angle / 180.0) × 103.0
Si angle <  0 :  pwm = 307 + (angle / 180.0) × 102.0
pwm = clamp(pwm, 205, 410)
```

| Angle | PWM | Impulsion |
|---|---|---|
| `−180°` | `205` | ≈ 1.0 ms |
| `0°` (neutre) | `307` | ≈ 1.5 ms |
| `+180°` | `410` | ≈ 2.0 ms |

### 4.3 Canal Mode Auto-Pilote (ch14)

Valeurs discrètes uniquement (pas d'interpolation) :

| Mode | PWM | Signification |
|---|---|---|
| PASSIF | `205` | Aucune stabilisation embarquée |
| AUTO-ROLL | `307` | Stabilisation du roulis par l'ESP32-S3 |
| AUTO-FULL | `410` | Stabilisation roulis + tangage par l'ESP32-S3 |

---

## 5. Fréquence et Timing

### 5.1 Fréquence de transmission

| Paramètre | Valeur | Source |
|---|---|---|
| **Fréquence du thread I2C** | **20 Hz** (50 ms par cycle) | `update_rate_hz = 20` dans `config.txt` |
| **Fréquence boucle autopilote** | **20 Hz** (`asyncio.sleep(0.05)`) | `_autopilot_sync_loop` dans `server.py` |
| **Fréquence PWM PCA9685** | **50 Hz** (prescaler = 121) | Standard ESC |

Le thread `_i2c_loop` s'exécute à `update_rate_hz` (20 Hz) et traite les
canaux en attente dans le bucket `_pending_channels` à chaque itération.

### 5.2 Sources d'émission et leurs fréquences

| Source | Fréquence | Canaux concernés |
|---|---|---|
| Commandes manette / joystick (via `execute_move` → `queue_send`) | Variable (liée aux événements gamepad) | ch0 – ch7 |
| Boucle autopilote (`_autopilot_sync_loop`) | 20 Hz (toutes les 50 ms) | ch13, ch14, ch15 |

Les deux sources alimentent le **même bucket** `_pending_channels`. Le thread
I2C fusionne naturellement les deux flux et écrit l'ensemble des canaux
modifiés à chaque cycle de 50 ms.

### 5.3 Keep-Alive / Watchdog

Il n'y a **pas de message de Keep-Alive dédié**. Le mécanisme de supervision
repose sur :

1. **Réception continue des trames** : l'ESP32-S3 utilise la simple réception
   de paquets I2C comme **watchdog implicite**. Si aucune trame n'est reçue
   pendant un certain délai, l'ESP32-S3 peut couper les moteurs (comportement
   côté firmware).

2. **Reconnexion automatique** : le thread I2C tente une reconnexion toutes les
   `reconnect_interval_s` (3.0 s) si le bus est perdu. Après **3 erreurs I2C
   consécutives**, le contrôleur se marque comme déconnecté.

3. **Mode fallback** : si l'I2C est indisponible et que `fallback_simulation`
   est activé, les commandes sont ignorées silencieusement (pas d'envoi, pas
   d'erreur bloquante). Le système continue de fonctionner en mode simulation
   pour l'OSD et les tests.

4. **Désarmement logiciel** : les commandes `disarm` et `emergency_stop`
   remettent tous les axes DOF à `0.0` et envoient une trame de neutre
   (PWM `307`) sur tous les canaux moteurs.

---

## 6. Résumé visuel — Trame complète

```
Bus : /dev/i2c-1
Adresse : 0x40 (PCA9685 émulé par ESP32-S3, write-only)
Fréquence thread : 20 Hz
Fréquence PWM : 50 Hz (prescaler 121)

┌─────────┬──────────────────────────────┬────────────┬──────────────────┐
│ Canal   │ Fonction                     │ Plage PWM  │ Unité d'entrée   │
├─────────┼──────────────────────────────┼────────────┼──────────────────┤
│  ch0    │ Moteur M1 (Horiz Av-D)       │ 205 – 410  │ DOF [-1.0, +1.0]│
│  ch1    │ Moteur M2 (Horiz Ar-D)       │ 205 – 410  │ DOF [-1.0, +1.0]│
│  ch2    │ Moteur M3 (Horiz Ar-G)       │ 205 – 410  │ DOF [-1.0, +1.0]│
│  ch3    │ Moteur M4 (Horiz Av-G)       │ 205 – 410  │ DOF [-1.0, +1.0]│
│  ch4    │ Moteur M5 (Vert Av-D)        │ 205 – 410  │ DOF [-1.0, +1.0]│
│  ch5    │ Moteur M6 (Vert Ar-D)        │ 205 – 410  │ DOF [-1.0, +1.0]│
│  ch6    │ Moteur M7 (Vert Ar-G)        │ 205 – 410  │ DOF [-1.0, +1.0]│
│  ch7    │ Moteur M8 (Vert Av-G)        │ 205 – 410  │ DOF [-1.0, +1.0]│
│  ch8-12 │ (inutilisés)                 │     —      │       —          │
│  ch13   │ Tangage IMU (Pitch)          │ 205 – 410  │ Angle [-180°,+180°]│
│  ch14   │ Mode Auto-Pilote             │ 205/307/410│ 1/2/3 (discret)  │
│  ch15   │ Roulis IMU (Roll)            │ 205 – 410  │ Angle [-180°,+180°]│
└─────────┴──────────────────────────────┴────────────┴──────────────────┘

Neutre / Point mort : PWM = 307 (≈ 1.5 ms @50Hz) pour tous les canaux.
```

---

## 7. Fichiers sources de référence

| Fichier | Rôle |
|---|---|
| `backend/i2c_controller.py` | Driver I2C (SMBus), thread dédié, conversion DOF→PWM |
| `backend/action_dispatcher.py` | Mixage 6 DOF → 8 moteurs, envoi via `queue_send` |
| `backend/motor_mixer.py` | Matrices de mixage horizontal et vertical |
| `backend/motor_manager.py` | État des moteurs, OSD |
| `backend/server.py` | Boucle autopilote (ch13/ch14/ch15), constantes `AUTOPILOT_*` |
| `config.txt` | Section `[I2C_CONTROLLER]` : adresse, bus, fréquence |
