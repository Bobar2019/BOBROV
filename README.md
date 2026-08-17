# BOB-ROV — Système de Contrôle pour ROV

**Version :** 2.0.0  
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
- **Base de données** : Fichiers JSON (profils, configuration, scènes 3D, layouts OSD)
- **Communication** : REST + WebSockets (temps réel)
- **Firmware** : ESP32-S3 (IMU 6 axes + contrôle moteurs PWM via I2C)

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
│   ├── simulator3d.html     # Sub-Simulator (simulation 3D sous-marine)
│   ├── css/
│   │   ├── style.css        # Styles principaux
│   │   ├── gamepad.css      # Styles config manette
│   │   ├── gamepad-nav.css  # Navigation gamepad UI
│   │   ├── goggle.css       # Styles mode lunettes FPV
│   │   ├── simulator3d.css  # Styles Sub-Simulator
│   │   └── scene3d.css      # Styles Config Scène 3D
│   └── js/
│       ├── app.js           # Navigation par tuiles SPA
│       ├── telemetry.js     # WebSockets + rendu OSD canvas
│       ├── rov3d.js         # Module ES Three.js (modèle 3D filaire OSD)
│       ├── osd_config.js    # Configuration OSD (opacités, positions, visibilité)
│       ├── osd_layout.js    # Éditeur Drag & Drop des positions OSD
│       ├── gamepad.js       # Manette (polling, profils, combos, test mode)
│       ├── gamepad_config.js# Éditeur de mapping manette
│       ├── gamepad_visual.js# Visualisation SVG manette
│       ├── gamepad_test.js  # Test manette en direct
│       ├── gamepad_nav.js   # Navigation interface par manette
│       ├── simulator3d.js   # Sub-Simulator (moteur 3D, physique 6DOF, faune/flore)
│       ├── rov_logo.js      # Logo 3D wireframe animé dans le header
│       ├── scene_config.js  # Configuration IHM Scène 3D (modèles GLB, faune, décor)
│       ├── scene3d_viewer.js# Inspecteur 3D autonome pour modèles GLB
│       ├── simulation.js    # Mode simulation (côté cockpit)
│       ├── camera_config.js # Configuration caméras
│       ├── wifi.js          # Gestion WiFi
│       ├── goggle.js        # Mode lunettes FPV/VR
│       └── action_status.js # État des fonctions
├── firmware/esp32_imu/      # Firmware ESP32-S3 (IMU I2C + PWM)
├── profiles/
│   └── manette_profiles.json# Profils manette (Standard, Plongée, etc.)
├── scenarios/               # Scénarios de mission
├── recordings/              # Photos et vidéos capturées
├── static/models/           # Modèles 3D (.glb) + textures
│   └── scene/               # Modèles 3D de la scène sous-marine
├── scene_3d_config.json     # Configuration de la scène 3D (faune, flore, décor)
├── osd_layouts.json         # Positions OSD sauvegardées (profils écran/lunettes)
├── I2C_ESP32_PROTOCOL.md    # Documentation protocole I2C ESP32-S3
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
| Élément | Affichage | Opacité indépendante | Déplaçable (D&D) |
|---------|-----------|:---:|:---:|
| Horizon artificiel | Ligne d'horizon + graduations pitch/roll | ✅ | ✅ |
| Profondeur | Jauge verticale + valeur | ✅ | ✅ |
| Température | Indicateur + valeur | ✅ | ✅ |
| Cap (boussole) | Barre horizontale + valeur | ✅ | ✅ |
| Batterie | Indicateur + pourcentage | ✅ | ✅ |
| Propulseurs | Barres de poussée (8 moteurs) | ✅ | ✅ |
| **Modèle 3D (Rov3D)** | Wireframe 3D du ROV | ✅ | ✅ |
| FPS | Compteur temps réel | ✅ | ✅ |
| Horloge | Heure système | ✅ | ✅ |
| Armé/Désarmé | Badge état ROV | ✅ | ✅ |
| Batterie manette | Indicateur niveau gamepad | ✅ | ✅ |
| Mode d'affichage | Badge écran/lunettes | ✅ | ✅ |

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

### Éditeur de Mise en Page (Drag & Drop)

Un éditeur visuel permet de repositionner tous les éléments OSD par glisser-déposer directement sur le flux vidéo.

#### Fonctionnalités
- **12 éléments déplaçables** : horizon, profondeur, température, boussole, batterie, propulseurs, Rov3D, FPS, horloge, armé/désarmé, batterie manette, mode d'affichage.
- **Auto-save** : sauvegarde automatique dans `osd_layouts.json` avec debounce (500 ms).
- **2 profils de mise en page** : `screen` (écran classique) et `goggles` (lunettes AR/FPV), indépendants.
- **Persistance JSON** : les positions sont sauvegardées en pourcentages (0–100) avec flush disque immédiat.
- Les positions sont restaurées automatiquement au chargement de l'interface.

### Sécurité Manette (Failsafe)

Un système de watchdog matériel protège le ROV en cas de perte de connexion de la manette.

#### Comportement
- **Watchdog** : surveillance continue de la connexion gamepad via l'API HTML5 Gamepad.
- **Seuil de déconnexion** : après une durée configurable sans trame, la manette est considérée comme perdue.
- **Arrêt moteurs** : tous les axes DOF sont ramenés à 0 et une trame de neutre (PWM 307) est envoyée sur tous les canaux moteurs.
- **Alerte OSD** : un badge clignotant `⚠ FAILSAFE` apparaît sur le flux vidéo.
- **Restauration automatique** : dès que la manette est reconnectée, le contrôle est restauré sans intervention manuelle.

### Sub-Simulator (Simulation 3D Sous-Marine)

Un simulateur 3D complet accessible via `simulator3d.html`, permettant l'entraînement à la plongée dans un environnement sous-marin procédural.

#### Moteur de simulation
- **Physique 6DOF** : simulation hydrodynamique avec inertie, accélération rotationnelle et translationnelle.
- **Topographie "Blue Hole"** : plateau corallien peu profond + tombant vers une fosse abyssale.
- **Collisions** : détection de collision avec la surface (plafond Y=0), le fond, et les parois latérales avec cooldown d'impact (300 ms).
- **Projecteurs LED** : spots lumineux orientables (`projecteur.glb`) avec intensité et tilt configurables.
- **Caméra FPV** : bascule entre vue extérieure (OrbitControls avec suivi du ROV) et vue FPV (caméra embarquée).

#### Environnement sous-marin procédural
| Élément | Technologie | Paramètres |
|---------|-------------|------------|
| Surface d'eau | Shader Gerstner + caustiques + rayons lumineux (god rays) | Hauteur, vitesse, intensité |
| Algues | InstancedMesh procédural (500 touffes max) | Densité, longueur, ondulation |
| Coraux | 4 types InstancedMesh sur le plateau récifal | Densité par type |
| Bancs de poissons | InstancedMesh + IA de fuite (500 poissons max, 8 bancs) | Nombre, vitesse, distance de fuite |
| Créatures abyssales | InstancedMesh dans la fosse | Densité |
| Terrain | Heightmap procédurale avec relief configurable | Hauteur du relief |
| Parois | Texturées avec tiling configurable | Activable/désactivable |

#### Configuration IHM (Config Scène 3D)
- Tableau éditable des objets 3D (nom, type, modèle GLB, taille réelle, nombre, comportement).
- Types d'objets : `faune`, `flore`, `objet`, `mamifère`.
- Comportements : `nageant`, `curieux`, `fixe`, `ancre_ondule`, `static`, `neant`.
- Upload de nouveaux modèles GLB avec aperçu miniature.
- Réglages environnement : courant, densité de vie, vagues, caustiques, god rays.
- Snapshots de configuration et notifications toast.
- Persistance dans `scene_3d_config.json`.

### Mode Lunettes FPV / VR

Bascule entre vue écran classique et mode stéréoscopique lunettes FPV via le gestionnaire `goggle_manager.py`.

#### Fonctionnalités
- Activation/désactivation depuis le Cockpit ou raccourci manette.
- Détection automatique des sorties vidéo multiples (HDMI, etc.).
- Listener `fullscreenchange` pour bascule automatique en plein écran.
- Profil manette dédié avec mapping adapté au mode lunettes.
- Layout OSD indépendant (`goggles` dans `osd_layouts.json`).
- Raccourcis clavier/manette pour basculer entre les modes.

### Enregistrement Vidéo / Photo

- Capture vidéo avec OSD incrusté dans le pipeline (via OpenCV).
- Photos avec ou sans OSD, par caméra.
- Stockage dans `recordings/` avec nommage horodaté (`PHOTO_YYYY-MM-DD_HH-MM-SS.jpg`, `VIDEO_...mp4`).

### Dashboard

- Bouton **Reboot** système pour redémarrer le Raspberry Pi à distance depuis l'interface web.
- Statistiques système (CPU, RAM, température SoC, espace disque).

---

## État des Fonctions

> **Bilan :** ✅ 9 opérationnelles · 🛠️ 1 en cours · ⏳ 18+ planifiées

### IMPLEMENTED (Opérationnelles)
- **Capture** : `photo`, `video_toggle`, `video_osd_toggle`, `video_no_osd_toggle`, `photo_cam1_osd`, `photo_cam1_no_osd`, `photo_cam2_osd`, `photo_cam2_no_osd`
- **Stabilisation** : `autolevel_toggle` — Bascule mode Auto-Pilote (PASSIF / AUTO-ROLL / AUTO-FULL via ESP32-S3)
- **Capteurs** : `read_sensors` — Lecture complète (profondeur, température, pression, cap, roulis, tangage)

> Les mouvements analogiques (`forward_backward`, `vertical`, `lateral`, `turn`, `ascent`, `descent`, `roll`, `pitch`) sont pilotés directement par le gamepad controller et le mixeur 6DOF, sans passer par l'ActionDispatcher.

### IN_PROGRESS
- `light_toggle` — Éclairage LED (fonctionnel dans le Sub-Simulator)

### PLANNED
- Commandes directionnelles discrètes (`move_forward`, `move_backward`, `turn_left`, `turn_right`, etc.)
- Pince (`grip_open`, `grip_close`)
- Réglage intensité LED (`light_brightness`, `light_up`, `light_down`)
- Inclinaison caméra (`camera_tilt_up`, `camera_tilt_down`)
- Maintien profondeur/cap (`depth_hold`, `heading_hold`)
- Macros (`macro_180`, `macro_surface`, `macro_hold`)
- Mode FPV (`fpv_toggle`)
- Recalibrage IMU (`imu_tare`)

---

## Installation et Démarrage

### Prérequis
- Raspberry Pi 5
- Raspberry Pi OS Lite 64-bit
- Python 3.11+
- Caméra compatible USB
- IMU I2C (ADXL345 / MPU6050 / QMI8658 via ESP32-S3)

---

### Installation

```bash
# 1. Dépendances système obligatoires
sudo apt update && sudo apt install -y git python3-pip python3-venv python3-dev build-essential libgl1 libglib2.0-0 i2c-tools

# 2. Cloner le projet
cd /home/bob
git clone https://github.com/Bobar2019/BOBROV.git cockpit-lite-rov
cd cockpit-lite-rov

# 3. Environnement virtuel Python & dépendances
mkdir -p logs
python3 -m venv venv
source venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt

# 4. Service systemd (démarrage automatique)
sudo cp bob-rov.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable bob-rov.service
```

### Démarrage
```bash
# Manuel (depuis le dossier projet)
source venv/bin/activate && python main.py

# Via le service systemd
sudo systemctl start bob-rov.service
sudo systemctl status bob-rov.service
sudo systemctl restart bob-rov.service   # après mise à jour du code
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

1. **Éclairage LED** — Finaliser `light_toggle` et `light_brightness` (backend réel)
2. **Maintien de profondeur / cap** — Implémenter `depth_hold` et `heading_hold`
3. **Pince** — Implémenter `grip_open` et `grip_close`
4. **Recalibrage IMU** — Implémenter `imu_tare`
5. **Macros** — Créer l'interface de programmation de macros
6. **Mode FPV** — Implémenter `fpv_toggle` (bascule vue externe / vue caméra FPV réelle)
7. **Inclinaison caméra** — Servo/stepper pour le tilt caméra

---

## Documentation Complémentaire

| Document | Description |
|----------|-------------|
| `BOBROV.md` | Documentation fonctionnelle détaillée du projet |
| `CDC.md` | Cahier des charges technique et architecture système |
| `I2C_ESP32_PROTOCOL.md` | Protocole I2C complet entre RPi 5 et ESP32-S3 (registres, canaux PWM, mixage 6DOF) |
