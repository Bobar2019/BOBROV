# BOB-ROV — Système de Contrôle pour ROV

**Version :** 1.0.0  
**Plateforme :** Raspberry Pi 5  
**Auteur :** Didier Dero  
**Date :** Août 2026  

---

## Philosophie du Projet

BOB-ROV est un système de contrôle embarqué pour sous-marin téléguidé (ROV). L'objectif est de fournir une solution légère, modulaire et évolutive, avec une interface web intuitive et une architecture permettant un développement progressif des fonctionnalités.

### Principes clés
- **Modulaire** : Chaque fonction est indépendante
- **Évolutif** : Développement progressif sans bloquer l'ensemble
- **Transparent** : L'utilisateur voit l'état d'avancement des fonctions
- **Robuste** : Résilience en cas de défaillance d'un module

---

## Architecture Technique

### Stack
- **Backend** : Python — FastAPI + WebSockets + OpenCV
- **Frontend** : HTML5 + CSS3 + JavaScript Vanilla + Three.js
- **Rendu 3D** : Three.js v0.170 (via CDN unpkg, importmap ES modules)
- **Base de données** : Fichiers JSON (profils, configuration)
- **Communication** : REST + WebSockets (temps réel)

### Arborescence
```
cockpit-lite-rov/
├── README.md                # Cette documentation
├── BOBROV.md                # Documentation détaillée du projet
├── config.txt               # Configuration principale
├── main.py                  # Point d'entrée
├── requirements.txt         # Dépendances Python
├── bob-rov.service          # Service systemd
├── backend/
│   ├── server.py            # Serveur FastAPI + WebSockets
│   ├── action_dispatcher.py # Bridge commandes → fonctions
│   ├── video_streamer.py    # Capture vidéo + pipeline OSD
│   ├── sensor_manager.py    # Gestion des capteurs
│   ├── imu_manager.py       # Fusion IMU (ESP32 + filtres)
│   ├── motor_manager.py     # Contrôle des propulseurs
│   ├── motor_mixer.py       # Mixage 6DOF → PWM
│   ├── gamepad_manager.py   # Gestion manette (profils, axes, combos)
│   ├── gamepad_profiles.py  # CRUD profils manette
│   ├── gamepad_controller.py# Actions manette → ROV
│   ├── camera_detector.py   # Détection caméras USB
│   ├── camera_controls.py   # Contrôles caméra (exposition, balance)
│   ├── goggle_manager.py    # Gestion mode lunettes FPV/VR
│   ├── i2c_controller.py    # Communication I2C avec ESP32-S3
│   ├── scenario_manager.py  # Gestion des scénarios de mission
│   └── config_parser.py     # Lecture/écriture config.txt
├── frontend/
│   ├── index.html           # Interface principale (SPA par tuiles)
│   ├── mapping3d.html       # Visualiseur 3D manette (scène complète)
│   ├── css/
│   │   ├── style.css        # Styles principaux
│   │   ├── gamepad.css      # Styles config manette
│   │   ├── gamepad-nav.css  # Navigation gamepad UI
│   │   └── goggle.css       # Styles mode lunettes FPV
│   └── js/
│       ├── app.js           # Navigation par tuiles SPA
│       ├── telemetry.js     # WebSockets + rendu OSD canvas
│       ├── rov3d.js         # Module ES Three.js (modèle 3D filaire OSD)
│       ├── osd_config.js    # Configuration OSD (opacités, positions, visibilité)
│       ├── gamepad.js       # Manette (polling, profils, combos, test mode)
│       ├── gamepad_config.js# Éditeur de mapping manette
│       ├── gamepad_visual.js# Visualisation SVG manette
│       ├── gamepad_test.js  # Test manette en direct
│       ├── gamepad_nav.js   # Navigation interface par manette
│       ├── mapping3d.js     # Scène 3D complète (test manette avancé)
│       ├── simulation.js    # Mode simulation
│       ├── camera_config.js # Configuration caméras
│       ├── wifi.js          # Gestion WiFi
│       ├── goggle.js        # Mode lunettes FPV/VR
│       └── action_status.js # État des fonctions
├── firmware/esp32_imu/      # Firmware ESP32-S3 (IMU I2C)
├── profiles/
│   └── manette_profiles.json# Profils manette (Standard, Plongée, etc.)
├── scenarios/               # Scénarios de mission
├── recordings/              # Photos et vidéos capturées
├── static/models/           # Modèles 3D (.glb)
└── logs/                    # Journaux d'exécution
```

### Architecture en couches
```
┌─────────────────────────────────────────────────────────┐
│                 INTERFACE UTILISATEUR                     │
│   (Tuiles Dashboard, Cockpit, Config OSD, Manette)      │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│              GAMEPAD CONTROLLER / OSD RENDER              │
│   (Commandes manette + Rendu OSD canvas + Rov3D WebGL)   │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│                 ACTION DISPATCHER                         │
│   IMPLEMENTED  → Exécute réellement                     │
│   IN_PROGRESS  → Exécute partiel + warning              │
│   PLANNED      → Mock + message "À venir"              │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│                 FONCTIONS RÉELLES                         │
│     (Photo, Vidéo, Moteurs, Capteurs, IMU, I2C)         │
└─────────────────────────────────────────────────────────┘
```

---

## Fonctionnalités Principales

### OSD (On-Screen Display)

L'OSD est rendu côté navigateur sur un canvas HTML5 haute résolution, superposé au flux vidéo.

#### Rendu Haute Résolution (HD / Retina)
- Adaptation dynamique au `devicePixelRatio` pour un rendu net sur écrans Retina et HiDPI.
- `ResizeObserver` pour recalculer la résolution du canvas à chaque changement de taille du conteneur.
- Découplage complet entre la taille d'affichage CSS et la résolution interne du canvas.

#### Éléments OSD configurables
| Élément | Affichage | Opacité indépendante |
|---------|-----------|:---:|
| Horizon artificiel | Ligne d'horizon + graduations pitch/roll | ✅ |
| Profondeur | Jauge verticale + valeur | ✅ |
| Température | Indicateur + valeur | ✅ |
| Cap (boussole) | Barre horizontale + valeur | ✅ |
| Batterie | Indicateur + pourcentage | ✅ |
| Propulseurs | Barres de poussée | ✅ |
| **Modèle 3D (Rov3D)** | Wireframe 3D du ROV | ✅ |
| FPS | Compteur temps réel | ✅ |

Chaque élément dispose d'un réglage d'opacité indépendant, en plus d'une opacité globale.

### Intégration 3D dans l'OSD (Rov3D)

Un modèle 3D filaire du ROV est incrusté dans l'OSD et synchronisé en temps réel avec la télémétrie.

#### Rendu
- **Moteur** : Three.js v0.170 via importmap ES modules (CDN unpkg).
- **Modèle** : Fichier `bob_rov_3D.glb` affiché en wireframe vert (`#00FF00`).
- **Compositing** : Rendu WebGL off-screen → copié sur le canvas OSD 2D via `drawImage()`.
- **Rotations locales** : Quaternions pour la composition yaw → pitch → roll dans le repère local du modèle.

#### Synchronisation télémétrie
| Donnée | Source | Effet 3D |
|--------|--------|----------|
| Roll | IMU (filtré bain d'huile 2ème ordre) | Rotation Z locale |
| Pitch | IMU (filtré bain d'huile 2ème ordre) | Rotation X locale |
| Yaw / Cap | IMU (`msg.imu.yaw`) | Rotation Y (lacet) |

#### Configuration IHM (Config OSD)
- Checkbox **Rov3D** : afficher / masquer le modèle 3D.
- Slider **Transparence Rov3D** : réglage d'opacité du wireframe (0–100 %).
- Slider **Transparence Horizon** : réglage indépendant de l'horizon artificiel.

#### Upload de modèle personnalisé
- Bouton d'import `.glb` dans la page Config OSD.
- Endpoint backend `POST /api/rov3d/upload` (FastAPI, max 50 Mo).
- Le modèle uploadé remplace `static/models/bob_rov_3D.glb` et est rechargé immédiatement.

### Mode Test Manette (OSD 3D)

Un basculeur **"Test manette (Rov3D)"** dans la section Périphériques du Cockpit permet de piloter le modèle 3D directement avec la manette, en ignorant temporairement la télémétrie.

#### Comportement
- **Lecture dynamique du profil actif** : utilise `axisFunctionMap` ET `buttonFunctionMap` du profil manette courant (pas de mapping hardcodé). Les boutons (DPAD, L1/R1...) et les sticks analogiques sont tous deux pris en compte.
- **6 degrés de liberté simulés** :

| DOF | Entrée (profil Standard) | Effet 3D |
|-----|--------------------------|----------|
| Yaw (lacet) | `LEFT_X` (turn) | Rotation Y (accumulateur continu ±180°) |
| Pitch (tangage) | `DPAD_UP`/`DOWN` (roll_left/right) | Rotation X locale (lerp vers ±45°) |
| Roll (roulis) | — (configurable) | Rotation Z locale (lerp vers ±45°) |
| Heave (monter/descendre) | `RIGHT_Y` (vertical) | Translation Y (accumulateur ±0.5, decay) |
| Surge (avancer/reculer) | `LEFT_Y` (forward_backward) | Translation Z directionnelle (accumulateur ±1.0, decay) |
| Sway (latéral) | `RIGHT_X` (lateral) | — (non affiché) |

- **Inertie / lissage** : Facteur `LERP = 0.08` simulant la masse du ROV sous l'eau.
- **Surge directionnel** : La translation avant/arrière suit le cap actuel du modèle (projection sin/cos via yaw).
- **Retour automatique** : Au relâchement des commandes, retour progressif à la position neutre (decay ×0.97).
- **Décochage** : Réinitialisation immédiate → le modèle 3D repasse en télémétrie réelle.

### Configuration Manette

Système complet de configuration de manette PlayStation (DualShock 4 / DualSense) :
- Éditeur visuel de mapping (boutons + axes + combos).
- Profils sauvegardés en JSON (`Standard`, `Plongée`, personnalisés).
- Paramètres avancés : deadzone, sensibilité, courbes de réponse, vibration.
- Visualiseur SVG interactif de la manette.
- Polling continu permanent (auto-détection sans limite de temps).

### Mode Lunettes FPV / VR

Bascule entre vue écran classique et mode stéréoscopique lunettes FPV via le gestionnaire `goggle_manager.py`.

### Enregistrement Vidéo / Photo

- Capture vidéo avec OSD incruster dans le pipeline (via OpenCV).
- Photos avec ou sans OSD.
- Stockage dans `recordings/`.

---

## État des Fonctions

> **Bilan :** ✅ 22 opérationnelles · 🛠️ 1 en cours · ⏳ 25 planifiées

### IMPLEMENTED (Opérationnelles)
- **Capture** : `photo`, `video_toggle`, `video_osd_toggle`, `video_no_osd_toggle`, `photo_cam1_osd`, `photo_cam1_no_osd`, `photo_cam2_osd`, `photo_cam2_no_osd`
- **Mouvements** : `forward_backward`, `vertical`, `lateral`, `turn`, `ascent`, `descent`, `roll`, `pitch`
- **Contrôle** : `arm`, `disarm`, `emergency_stop`, `reset_position`
- **Stabilisation** : `autolevel_toggle`
- **Capteurs** : `read_sensors`

### IN_PROGRESS
- `light_toggle` — Éclairage LED

### PLANNED
- Commandes directionnelles discrètes, pince, réglage intensité LED, inclinaison caméra, maintien profondeur/cap, macros, mode FPV, recalibrage IMU.

---

## Installation et Démarrage

### Prérequis
- Raspberry Pi 5
- Raspberry Pi OS Lite 64-bit
- Python 3.11+
- Caméra USB compatible
- IMU I2C (ADXL345 / MPU6050 / QMI8658 via ESP32-S3)

### Installation
```bash
cd /home/bob
git clone [url-du-depot] cockpit-lite-rov
cd cockpit-lite-rov

# Environnement virtuel
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt

# Service systemd (démarrage auto)
sudo cp bob-rov.service /etc/systemd/system/
sudo systemctl enable bob-rov.service
```

### Démarrage
```bash
# Manuel
source venv/bin/activate && python main.py

# Service
sudo systemctl start bob-rov.service
sudo systemctl status bob-rov.service
```

### Accès
- Interface web : `http://[IP_DU_PI]:8080`
- API : `http://[IP_DU_PI]:8080/api/`

---

## Commandes Utiles

| Commande | Description |
|----------|-------------|
| `python main.py` | Lancer l'application |
| `python main.py --log-level DEBUG` | Mode debug |
| `sudo systemctl start bob-rov.service` | Démarrer le service |
| `sudo systemctl stop bob-rov.service` | Arrêter le service |
| `journalctl -u bob-rov.service -f` | Logs en temps réel |
| `sudo i2cdetect -y 1` | Vérifier les capteurs I2C |

---

## Prochaines Étapes

1. **Éclairage LED** — Finaliser `light_toggle` et `light_brightness`
2. **Maintien de profondeur / cap** — Implémenter `depth_hold` et `heading_hold`
3. **Pince** — Implémenter `grip_open` et `grip_close`
4. **Recalibrage IMU** — Implémenter `imu_tare`
5. **Macros** — Créer l'interface de programmation de macros
6. **Mode FPV** — Implémenter `fpv_toggle`
7. **Inclinaison caméra** — Servo/stepper pour le tilt caméra
