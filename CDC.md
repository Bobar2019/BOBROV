# Cahier des Charges Technique & Architecture Système
**Projet :** Cockpit-Lite ROV — Système de Contrôle embarqué Raspberry Pi 5  
**Auteur :** Didier Dero  
**Plateforme :** Raspberry Pi 5 (Raspberry Pi OS Lite 64-bit)  
**Environnement de dev :** Qoder / SSH Remote  
**Version :** 1.0  
**Date :** Juillet 2026  

---

## 1. Vision Générale du Projet

Le projet **Cockpit-Lite ROV** a pour objectif de fournir une solution logicielle légère, robuste et modulaire d'interface de pilotage et d'incrustation vidéo pour sous-marin téléguidé (ROV). Inspirez-vous de l'esprit d'**ArduSub Cockpit**, mais en conservant une architecture minimaliste, rapide et facile à maintenir.

L'application s'exécute localement sur le Raspberry Pi 5 et fournit :
1. Un flux vidéo haute définition ultra-faible latence (< 100ms) capturé depuis une caméra USB Plug & Play.
2. Un moteur d'incrustation vidéo OSD (*On-Screen Display*) de la télémétrie en temps réel (profondeur, température, cap, état batterie).
3. Un serveur web embarqué offrant un tableau de bord (Dashboard) interactif.
4. Une interface utilisateur fluide à **menus par tuiles** (Navigation modulaire type BOBCNC).
5. Un fichier de configuration centralisé unique et lisible par l'utilisateur (`config.txt`).

---

## 2. Spécifications Fonctions & Interfaces

### 2.1 Navigation & Interface Web (Menu par Tuiles)
L'interface Web principale est structurée sous forme de Dashboard à onglets / tuiles dynamiques :

* **Tuile 1 : Dashboard / Informations (`Info`)**
  * Statistiques système du Pi 5 (Utilisation CPU, Température SoC, RAM, Espace disque NVMe/SD).
  * État de connexion de la caméra USB et des bus de capteurs (I2C/UART/SPI).
  * Statut du réseau (Adresse IP, Débit de streaming, Latence).
  * Journal de bord système (Logs en temps réel via WebSocket).

* **Tuile 2 : Poste de Contrôle / Pilotage (`Cockpit`)**
  * Affichage vidéo principal grand écran (WebRTC / Fast MJPEG-Stream).
  * Superposition de la télémétrie (Incrustation OSD graphique : Horizon artificiel, Jauge de profondeur, Température eau/boîtier).
  * Support de la manette de jeu (API HTML5 Gamepad) pour le pilotage des propulseurs et des servos/LED.
  * Boutons de commande d'urgence (Armer / Désarmer, Enregistrement vidéo local, Éclairage LED).

* **Tuile 3 : Configuration Interface (`Config Interface`)**
  * Personnalisation des éléments graphiques du poste de pilotage (Masquer/Afficher l'OSD, changer les couleurs des jauges, choix de la disposition).
  * Réglage de la fréquence de rafraîchissement des télémétries (10Hz, 20Hz, 50Hz).
  * Configuration du mappage des touches / axes du Gamepad.

* **Tuile 4 : Configuration Caméra & Vidéo (`Config Caméra`)**
  * Sélection de la caméra USB (`/dev/video0`, `/dev/video1`, etc.).
  * Réglage de la résolution (720p, 1080p, etc.) et du framerate (30 fps, 60 fps).
  * Contrôle des paramètres V4L2 en direct (Luminosité, Contraste, Exposition, Balance des blancs, Saturation).
  * Sélection du format de compression (MJPEG, H.264 / YUYV).

---

## 3. Système de Configuration (`config.txt`)

L'ensemble des paramètres de fonctionnement de l'application est stocké dans un fichier plat texte ultra-lisible nommé `config.txt` à la racine du projet (similaire au fonctionnement de `config.txt` de Raspberry Pi OS ou Grbl/FluidNC).

### Structure type de `config.txt` :
```ini
# ==========================================================
# CONFIGURATION GENERALE COCKPIT-LITE ROV
# ==========================================================

[SERVER]
port = 8080
websocket_port = 8081
log_level = INFO

[CAMERA]
device = /dev/video0
width = 1280
height = 720
fps = 30
format = MJPEG
osd_enabled = true

[TELEMETRY]
i2c_bus = 1
depth_sensor_i2c_addr = 0x76
imu_i2c_addr = 0x68
update_frequency_hz = 20

[OSD_DISPLAY]
show_horizon = true
show_depth = true
show_temperature = true
show_battery = true
primary_color = #00FF00
font_scale = 0.8

[ROV_CONTROL]
max_thrust = 100
light_default_brightness = 0

Comportement requis :

Au démarrage de l'application, config.txt est parsé.

Si des modifications sont enregistrées depuis l'interface Web (dans la Tuile Configuration), le fichier config.txt est mis à jour dynamiquement sur le disque sans altérer la mise en page des commentaires.

4. Architecture Logicielle (Stack Technique)
Backend (Python sur Raspberry Pi 5)
Framework Web : FastAPI pour l'API REST et la distribution du frontend.

Communication Temps Réel : WebSockets / AsyncIO pour le transfert à haute fréquence des données capteurs vers l'interface web.

Traitement Vidéo / OSD : OpenCV (cv2) + GStreamer pour la capture vidéo V4L2, l'incrustation graphique (textes, lignes, gauges) et la diffusion vidéo à faible latence.

Acquisition Capteurs : Threads dédiés non-bloquants (smbus2 pour I2C, pyserial pour UART).

Frontend (Interface Web Client - Sans Framework lourd)
Technologies : HTML5, CSS3 (Grid / Flexbox responsive), JavaScript ES6 Vanilla.

Visualisation : HTML5 <canvas> ou SVG pour le rendu d'instruments d'aviation (Horizon artificiel / Compass).

Flux Vidéo : Élement HTML5 optimisé (WebRTC ou Stream MJPEG binaire très basse latence).

5. Contraintes Techniques & Stratégie Vidéo
5.1 Accélération Vidéo sur Raspberry Pi 5
Le Raspberry Pi 5 ne dispose pas d'encodeur matériel dédié pour les flux H.264/H.265, contrairement aux modèles précédents. Le codage sera donc effectué par logiciel sur le CPU.

Stratégie adoptée :

Privilégier MJPEG : Dans la mesure du possible, le flux sera streamé et affiché dans le format MJPEG natif, ce qui évite un retranscodage CPU-intensif. L'incrustation OSD sera réalisée côté client (JavaScript) par un traitement léger sur le flux MJPEG ou par superposition HTML/CSS.

Optimiser l'encodeur H.264 : Si un encodage H.264 s'avère nécessaire, nous utiliserons la bibliothèque libav (via Picamera2/FFmpeg) pour bénéficier des optimisations logicielles. Les paramètres de l'encodeur (bitrate, profil, etc.) seront configurables pour trouver le meilleur compromis latence/qualité/charge CPU.

Préférer les formats bruts : Si la caméra USB le supporte, nous favoriserons les formats non compressés (YUYV, NV12) pour éviter la phase de décompression MJPEG en amont du traitement.

Limites acceptables : Une charge CPU jusqu'à 50% en pic est acceptable. L'objectif principal reste la latence < 100ms.

6. Environnement de Développement et Workflow Qoder
L'intégralité du développement se fera via Qoder en connexion SSH directe sur le Raspberry Pi 5.

Workflow :

Connexion : Qoder est connecté au Pi à l'adresse 172.22.22.142 avec l'utilisateur bob.

Développement local : Les modifications de code sont effectuées dans l'éditeur Qoder sur le poste de travail, mais le code est exécuté et testé sur le Pi.

Débogage assisté : En cas d'erreur (ex: un capteur I2C non reconnu), les logs, l'état du système et la configuration seront analysés par l'IA via Qoder, qui pourra proposer des corrections et les tester directement sur le Pi.

Workflow Git (optionnel) : Un dépôt Git local sur le Pi pourra être utilisé pour versionner le code.

7. Exigences Non-Fonctionnelles & Performance
Latence Vidéo : La latence totale entre la capture physique de la caméra USB et l'affichage à l'écran du navigateur de surface ne doit pas dépasser 100 ms.

Charge Processeur : L'utilisation du processeur du Raspberry Pi 5 ne doit pas dépasser 50% de charge globale en régime permanent avec encodage vidéo et télémétrie active (un pic à 60-70% est acceptable). L'objectif initial de 25% est révisé à la hausse en raison de l'absence d'encodeur matériel.

Résilience : En cas de déconnexion temporaire de la caméra USB ou d'un capteur I2C, l'application ne doit pas crasher. Elle doit tenter une reconnexion automatique en arrière-plan tout en envoyant un avertissement au journal des logs.

Prêt pour Qoder : Structure de code modulaire, typée en Python (type hinting), bien documentée pour permettre l'édition et l'exécution directe via l'extension SSH de Qoder.

Sécurité : Une authentification par mot de passe (ou clé SSH) sera mise en place pour l'accès à l'interface web en production. En développement, l'authentification pourra être désactivée.

8. Arborescence du Projet
text
cockpit-lite-rov/
├── config.txt                 # Fichier de configuration principal
├── main.py                    # Point d'entrée de l'application
├── requirements.txt           # Dépendances Python
├── README.md                  # Documentation utilisateur
├── backend/
│   ├── __init__.py
│   ├── server.py              # Serveur FastAPI / WebSockets
│   ├── video_streamer.py      # Module de capture vidéo OpenCV/GStreamer + OSD
│   ├── sensor_manager.py      # Module de lecture I2C/UART capteurs
│   └── config_parser.py       # Gestionnaire du fichier config.txt
└── frontend/
    ├── index.html             # Interface à tuiles / Onglets
    ├── css/
    │   └── style.css          # Thème sombre Cockpit
    └── js/
        ├── app.js             # Gestionnaire du menu par tuiles & UI
        ├── telemetry.js       # Réception WebSockets & Rendu Canvas OSD
        └── gamepad.js         # Interface Manette de jeu
9. Plan d'Implémentation
Phase 1 : Fondation (Jour 1-2)
Structure de projet (création des dossiers)

config_parser.py avec validation des types

Serveur FastAPI basique avec route / et /api/health

Test de connexion sur http://172.22.22.142:8080

Phase 2 : Vidéo (Jour 3-5)
Capture OpenCV avec cv2.VideoCapture(0)

Flux MJPEG avec endpoint /video_feed

Test de latence avec différents formats (MJPEG, YUYV)

Premières incrustations OSD côté backend (texte)

Phase 3 : Télémétrie (Jour 6-8)
Capteurs I2C (profondeur, température) avec smbus2

IMU (MPU6050/ICM20948) avec pympu6050

WebSockets pour le streaming des données

Mode simulation (capteurs mockés)

Phase 4 : Interface (Jour 9-12)
Dashboard avec 4 tuiles

Rendu OSD complet (horizon, jauges, température)

Intégration Gamepad (API HTML5)

WebSockets pour les commandes de contrôle

Phase 5 : Polissage (Jour 13-15)
Tests de charge

Optimisation latence

Documentation utilisateur (README.md)

Script de démarrage automatique (systemd)

Approbations :

Rôle	Nom	Date	Signature
Auteur	Didier Dero	Juillet 2026	✓
Validateur			
Client			
Ce document est la propriété de Didier Dero. Toute reproduction est interdite sans autorisation.

