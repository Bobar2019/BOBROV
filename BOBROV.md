# BOB-ROV - Système de Contrôle pour ROV

**Version :** 1.0.0  
**Plateforme :** Raspberry Pi 5  
**Auteur :** Didier Dero  
**Date :** Juillet 2026  

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
- **Backend** : FastAPI + WebSockets + OpenCV
- **Frontend** : HTML5 + CSS3 + JavaScript Vanilla
- **Base de données** : Fichiers JSON (profils, configuration)
- **Communication** : REST + WebSockets (temps réel)

### Arborescence
```
cockpit-lite-rov/
├── BOBROV.md               # Documentation du projet
├── config.txt              # Configuration principale
├── main.py                 # Point d'entrée
├── requirements.txt        # Dépendances Python
├── backend/
│   ├── action_dispatcher.py # Bridge commandes → fonctions
│   ├── server.py           # Serveur FastAPI
│   ├── video_streamer.py   # Capture vidéo + OSD
│   ├── sensor_manager.py   # Gestion des capteurs
│   ├── gamepad_manager.py  # Gestion manette
│   ├── gamepad_profiles.py # Profils manette
│   ├── gamepad_controller.py # Actions manette → ROV
│   └── config_parser.py    # Lecture config.txt
├── frontend/
│   ├── index.html          # Interface principale
│   ├── css/
│   │   ├── style.css       # Styles principaux
│   │   └── gamepad.css     # Styles config manette
│   └── js/
│       ├── app.js          # Navigation
│       ├── telemetry.js    # WebSockets
│       ├── gamepad.js      # Manette
│       ├── gamepad_config.js # Configuration manette
│       ├── gamepad_visual.js # SVG manette
│       ├── gamepad_test.js # Test manette
│       └── action_status.js # État des fonctions
└── profiles/
    └── manette_profiles.json # Profils manette
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

> **Bilan actuel :** ✅ 22 opérationnelles · 🛠️ 1 en cours · ⏳ 25 planifiées

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
| `light_toggle` | Allumer/Éteindre l'éclairage LED |

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
- ADXL345 (I2C)

### Installation
```bash
# Cloner le projet
cd /home/bob
git clone [url-du-depot] cockpit-lite-rov
cd cockpit-lite-rov

# Créer l'environnement virtuel
python3 -m venv venv
source venv/bin/activate

# Installer les dépendances
pip install -r requirements.txt

# Configurer le service systemd (démarrage auto)
sudo cp bob-rov.service /etc/systemd/system/
sudo systemctl enable bob-rov.service
```

### Démarrage
```bash
# Manuel
cd /home/bob/cockpit-lite-rov
source venv/bin/activate
python main.py

# Service
sudo systemctl start bob-rov.service
sudo systemctl status bob-rov.service
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

1. **Éclairage LED** → Finaliser `light_toggle` et `light_brightness`
2. **Maintien de profondeur / cap** → Implémenter `depth_hold` et `heading_hold` avec les données IMU
3. **Pince** → Implémenter `grip_open` et `grip_close`
4. **Recalibrage IMU** → Implémenter `imu_tare` (remise à zéro de l'orientation)
5. **Macros** → Créer l'interface de programmation de macros
6. **Mode FPV** → Implémenter `fpv_toggle` (bascule vue externe / vue caméra FPV)
7. **Inclinaison caméra** → Servo/stepper pour le tilt caméra
