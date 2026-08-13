# BOB-ROV - Système de Contrôle pour ROV

**Version :** 2.0.0  
**Plateforme :** Raspberry Pi 5  
**Auteur :** Didier Dero  
**Date :** Août 2026  

---

## 🎯 Philosophie du Projet

BOB-ROV est un système de contrôle embarqué pour sous-marin téléguidé (ROV). L'objectif est de fournir une solution légère, modulaire et évolutive, avec une interface web intuitive et une architecture permettant un développement progressif des fonctionnalités.

### Principes clés
- **Modulaire** : Chaque fonction est indépendante
- **Évolutif** : Développement progressif sans bloquer l'ensemble
- **Transparent** : L'utilisateur voit l'état d'avancement des fonctions
- **Robuste** : Résilience en cas de défaillance d'un module

---

## 🏗️ Architecture Technique

### Stack
- **Backend** : Python — FastAPI + WebSockets + OpenCV
- **Frontend** : HTML5 + CSS3 + JavaScript Vanilla + Three.js
- **Rendu 3D** : Three.js v0.160 (via CDN jsdelivr, importmap ES modules)
- **Base de données** : Fichiers JSON (profils, configuration, scènes 3D, layouts OSD)
- **Communication** : REST + WebSockets (temps réel)
- **Firmware** : ESP32-S3 (IMU 6 axes + contrôle moteurs PWM via I2C, voir `I2C_ESP32_PROTOCOL.md`)

### Arborescence
```
cockpit-lite-rov/
├── BOBROV.md               # Documentation du projet
├── README.md                # Documentation utilisateur
├── CDC.md                   # Cahier des charges technique
├── I2C_ESP32_PROTOCOL.md    # Protocole I2C ESP32-S3
├── config.txt              # Configuration principale
├── main.py                 # Point d'entrée
├── requirements.txt        # Dépendances Python
├── scene_3d_config.json    # Configuration scène 3D
├── osd_layouts.json        # Positions OSD (profils écran/lunettes)
├── bob-rov.service         # Service systemd
├── backend/
│   ├── action_dispatcher.py # Bridge commandes → fonctions
│   ├── server.py           # Serveur FastAPI + WebSockets
│   ├── video_streamer.py   # Capture vidéo + pipeline OSD
│   ├── sensor_manager.py   # Gestion des capteurs
│   ├── imu_manager.py      # Fusion IMU (ESP32 + filtres)
│   ├── motor_manager.py    # Contrôle des propulseurs
│   ├── motor_mixer.py      # Mixage 6DOF → PWM
│   ├── gamepad_manager.py  # Gestion manette (profils, axes, combos)
│   ├── gamepad_profiles.py # CRUD profils manette
│   ├── gamepad_controller.py# Actions manette → ROV
│   ├── camera_detector.py  # Détection caméras USB
│   ├── camera_controls.py  # Contrôles caméra (exposition, balance)
│   ├── goggle_manager.py   # Gestion mode lunettes FPV/VR
│   ├── i2c_controller.py   # Communication I2C avec ESP32-S3
│   ├── scenario_manager.py # Gestion des scénarios de mission
│   └── config_parser.py    # Lecture/écriture config.txt
├── frontend/
│   ├── index.html          # Interface principale (SPA)
│   ├── simulator3d.html    # Sub-Simulator (simulation 3D)
│   ├── mapping3d.html      # Visualiseur 3D manette
│   ├── css/
│   │   ├── style.css       # Styles principaux
│   │   ├── gamepad.css     # Styles config manette
│   │   ├── simulator3d.css # Styles Sub-Simulator
│   │   └── scene3d.css     # Styles Config Scène 3D
│   └── js/
│       ├── app.js          # Navigation par tuiles SPA
│       ├── telemetry.js    # WebSockets + rendu OSD canvas
│       ├── rov3d.js        # Module Three.js (modèle 3D OSD)
│       ├── osd_config.js   # Configuration OSD
│       ├── osd_layout.js   # Éditeur Drag & Drop OSD
│       ├── simulator3d.js  # Sub-Simulator (physique 6DOF)
│       ├── scene_config.js # IHM Config Scène 3D
│       ├── mapping3d.js    # Scène 3D manette
│       ├── gamepad.js      # Manette (polling, profils, failsafe)
│       ├── gamepad_config.js# Éditeur mapping manette
│       ├── gamepad_visual.js# SVG manette
│       ├── gamepad_test.js # Test manette
│       ├── gamepad_nav.js  # Navigation par manette
│       ├── goggle.js       # Mode lunettes FPV/VR
│       ├── simulation.js   # Mode simulation cockpit
│       ├── camera_config.js# Configuration caméras
│       ├── wifi.js         # Gestion WiFi
│       └── action_status.js# État des fonctions
├── firmware/esp32_imu/     # Firmware ESP32-S3 (IMU + PWM)
├── profiles/
│   └── manette_profiles.json# Profils manette
├── scenarios/              # Scénarios de mission
├── recordings/             # Photos et vidéos capturées
├── static/models/          # Modèles 3D (.glb)
│   └── scene/              # Modèles scène sous-marine
└── logs/                   # Journaux d'exécution
```

### Architecture en couches
```
┌─────────────────────────────────────────────────────────┐
│                 INTERFACE UTILISATEUR                     │
│   (Tuiles Dashboard, Cockpit, Config Manette, etc.)     │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│                 GAMEPAD CONTROLLER                        │
│        (Reçoit les commandes de la manette)              │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│                 ACTION DISPATCHER                         │
│         (Vérifie statut → Exécute ou mock)              │
│   IMPLEMENTED  → Exécute réellement                     │
│   IN_PROGRESS  → Exécute partiel + warning              │
│   PLANNED      → Mock + message "À venir"              │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│                 FONCTIONS RÉELLES                         │
│     (Photo, Vidéo, LED, Moteurs, Capteurs, etc.)        │
└─────────────────────────────────────────────────────────┘
```

---

## 📊 État des Fonctions

> **Bilan actuel :** ✅ 9 opérationnelles · 🛠️ 1 en cours · ⏳ 18+ planifiées

### ✅ IMPLEMENTED (Opérationnelles)

#### 📷 Capture
| Fonction | Description |
|----------|-------------|
| `photo` | Prendre une photo |
| `video_toggle` | Démarrer/Arrêter l'enregistrement vidéo |
| `video_osd_toggle` | Vidéo ON/OFF (avec OSD) |
| `video_no_osd_toggle` | Vidéo ON/OFF (sans OSD) |
| `photo_cam1_osd` | Photo Cam1 (avec OSD) |
| `photo_cam1_no_osd` | Photo Cam1 (sans OSD) |
| `photo_cam2_osd` | Photo Cam2 (avec OSD) |
| `photo_cam2_no_osd` | Photo Cam2 (sans OSD) |

#### 🚀 Mouvements (axes analogiques)
| Fonction | Description |
|----------|-------------|
| `forward_backward` | Axe avant/arrière (surge) |
| `vertical` | Axe vertical (heave) |
| `lateral` | Axe latéral (sway) |
| `turn` | Axe rotation (yaw) |
| `ascent` | Montée (gâchette analogique) |
| `descent` | Descente (gâchette analogique) |
| `roll` | Axe roulis (analogique) |
| `pitch` | Axe tangage (analogique) |

#### 🎛️ Contrôle
| Fonction | Description |
|----------|-------------|
| `arm` | Armer le ROV |
| `disarm` | Désarmer le ROV |
| `emergency_stop` | Arrêt d'urgence |
| `reset_position` | Réinitialiser la position |

#### ⚖️ Stabilisation
| Fonction | Description |
|----------|-------------|
| `autolevel_toggle` | Activer/Désactiver l'assiette automatique (bascule mode Auto-Pilote PASSIF ↔ AUTO-ROLL via ESP32-S3) |

#### 📡 Capteurs
| Fonction | Description |
|----------|-------------|
| `read_sensors` | Lecture complète des capteurs environnement et IMU (profondeur, température, pression, cap, roulis, tangage) |

### 🛠️ IN_PROGRESS (En développement)
| Fonction | Description |
|----------|-------------|
| `light_toggle` | Allumer/Éteindre l'éclairage LED (fonctionnel dans le Sub-Simulator) |

### ⏳ PLANNED (Planifiées)
| Catégorie | Fonctions | Description |
|-----------|-----------|-------------|
| **Mouvements** | `move_forward`, `move_backward`, `turn_left`, `turn_right`, `move_up`, `move_down`, `roll_left`, `roll_right`, `pitch_up`, `pitch_down` | Commandes directionnelles discrètes |
| **Pince** | `grip_open`, `grip_close` | Contrôle de la pince |
| **Éclairage** | `light_brightness`, `light_up`, `light_down` | Réglage intensité LED |
| **Caméra** | `camera_tilt_up`, `camera_tilt_down`, `camera_tilt` | Inclinaison caméra |
| **Interface** | `fpv_toggle` | Bascule vue externe / FPV |
| **Capteurs** | `imu_tare` | Recalibrage zéro IMU / Tare |
| **Stabilisation** | `depth_hold`, `heading_hold` | Maintien profondeur / cap |
| **Macros** | `macro_180`, `macro_surface`, `macro_hold` | Séquences automatisées |

> **Note :** Les mouvements analogiques (surge, sway, heave, yaw, roll, pitch) sont gérés directement par le `gamepad_controller` + `motor_mixer` (mixage 6DOF → 8 moteurs PWM via ESP32-S3) et n'apparaissent pas dans l'ActionDispatcher.

---

## 🎮 Fonctionnalités Avancées

### Sub-Simulator (Simulation 3D Sous-Marine)
Simulateur 3D complet (`simulator3d.html`) avec :
- Physique hydrodynamique 6DOF avec inertie
- Topographie "Blue Hole" : plateau corallien + fosse abyssale
- Environnement procédural : surface d'eau (Gerstner), algues, coraux, bancs de poissons, créatures abyssales
- Projecteurs LED orientables avec intensité configurable
- Caméra FPV / orbitale avec suivi du ROV
- Collisions surface/fond/parois
- OSD superposé à la scène 3D
- Configuration via IHM (Config Scène 3D) avec persistance JSON

### Éditeur OSD Drag & Drop
Repositionnement visuel des 12 éléments OSD par glisser-déposer, avec 2 profils (écran / lunettes AR) et auto-save.

### Sécurité Failsafe Manette
Watchdog gamepad : arrêt moteurs automatique + alerte OSD clignotante en cas de perte de connexion, restauration automatique au retour.

### Mode Lunettes FPV/VR
Bascule stéréoscopique avec layout OSD dédié, détection multi-écrans, et profil manette adapté.

### Configuration Scène 3D
IHM complète pour gérer les objets de la scène sous-marine : upload de modèles GLB, réglage de la faune/flore/décor, comportements (nageant, curieux, mammifère), et paramètres environnementaux.

---

## 🎮 Configuration Manette

### Mapping par défaut (Profil Standard)
| Bouton | Fonction | Statut |
|--------|----------|--------|
| ✕ (Cross) | `photo` | ✅ |
| ● (Cercle) | `video_toggle` | ✅ |
| □ (Carré) | `light_toggle` | 🛠️ |
| △ (Triangle) | `autolevel_toggle` | ✅ |
| L1 | `turn_left` | ⏳ |
| R1 | `turn_right` | ⏳ |
| L2 | `move_down` | ⏳ |
| R2 | `move_up` | ⏳ |
| Stick Gauche | `move_forward/backward` + `turn` | ⏳ |
| Stick Droit | `lateral` + `vertical` | ⏳ |
| Options | `macro_180` | ⏳ |

---

## 🔧 Installation et Démarrage

### Prérequis
- Raspberry Pi 5
- Raspberry Pi OS Lite 64-bit
- Python 3.11+
- Caméra USB compatible
- ESP32-S3 (IMU I2C + PWM, voir `I2C_ESP32_PROTOCOL.md`)

### Installation
```bash
# 1. Installation des dépendances système obligatoires
sudo apt update && sudo apt install -y git python3-pip python3-venv python3-dev build-essential libgl1-mesa-glx libglib2.0-0

# 2. Récupération du projet
cd /home/bob
git clone https://github.com/Bobar2019/BOBROV.git cockpit-lite-rov
cd cockpit-lite-rov
git checkout Sub-Simulator_VISU3DV3_SURF3

# 3. Préparation du dossier de logs et de l'environnement virtuel
mkdir -p logs
python3 -m venv venv
source venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt

# 4. Activation et démarrage du service systemd
sudo cp bob-rov.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable bob-rov.service
sudo systemctl start bob-rov.service
```

### Démarrage manuel
```bash
cd /home/bob/cockpit-lite-rov
source venv/bin/activate
python main.py
```

### Service systemd
```bash
sudo systemctl start bob-rov.service
sudo systemctl status bob-rov.service
journalctl -u bob-rov.service -f
```

### Accès
- Interface web : `http://[IP_DU_PI]:8080`
- API : `http://[IP_DU_PI]:8080/api/`

---

## 🧪 Test et Simulation

### Mode simulation
Les capteurs sont simulés automatiquement si le matériel n'est pas présent.

### Test de l'ActionDispatcher
```bash
# Tester une fonction
curl -X POST http://172.22.22.142:8080/api/action/photo

# Voir le statut des fonctions
curl http://172.22.22.142:8080/api/actions/status

# Voir le journal des actions
curl http://172.22.22.142:8080/api/actions/log?limit=20
```

---

## 📝 Commandes Utiles
| Commande | Description |
|----------|-------------|
| `python main.py` | Lancer l'application |
| `python main.py --log-level DEBUG` | Mode debug |
| `sudo systemctl start bob-rov.service` | Démarrer le service |
| `sudo systemctl stop bob-rov.service` | Arrêter le service |
| `sudo systemctl status bob-rov.service` | Vérifier l'état |
| `journalctl -u bob-rov.service -f` | Voir les logs en temps réel |
| `sudo i2cdetect -y 1` | Vérifier les capteurs I2C |

---

## 🚀 Prochaines Étapes

1. **Éclairage LED** → Finaliser `light_toggle` et `light_brightness` (backend réel)
2. **Maintien de profondeur / cap** → Implémenter `depth_hold` et `heading_hold` avec les données IMU
3. **Pince** → Implémenter `grip_open` et `grip_close`
4. **Recalibrage IMU** → Implémenter `imu_tare` (remise à zéro de l'orientation)
5. **Macros** → Créer l'interface de programmation de macros
6. **Mode FPV** → Implémenter `fpv_toggle` (bascule vue externe / vue caméra FPV réelle)
7. **Inclinaison caméra** → Servo/stepper pour le tilt caméra

---

## 📚 Documentation Complémentaire

| Document | Description |
|----------|-------------|
| `README.md` | Documentation utilisateur complète |
| `CDC.md` | Cahier des charges technique et architecture système |
| `I2C_ESP32_PROTOCOL.md` | Protocole I2C complet RPi 5 ↔ ESP32-S3 |
