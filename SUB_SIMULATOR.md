# BOB-ROV Sub-Simulator — Documentation Technique

> Ce document décrit exhaustivement le fonctionnement du Sub-Simulator pour permettre à une IA (ou un développeur) de comprendre, analyser et modifier le code sans ambiguïté.

---

## 1. Vue d'ensemble

Le Sub-Simulator est un moteur de simulation sous-marine 6DOF basé sur **Three.js**, accessible via `/subsim` dans le navigateur. Il simule :
- Un **ROV** (modèle `bob_rov_3D.glb`) avec physique hydrodynamique inertielle
- Un **environnement sous-marin** complet (surface d'eau, terrain, parois, brouillard, lumière)
- De la **faune/flore dynamique** (poissons, mammifères, algues, coraux, créatures abyssales)
- Un **OSD cockpit** (horizon artificiel, boussole, profondeur, batteries, propulseurs)
- Le contrôle par **gamepad** avec mapping configurable
- L'**enregistrement** vidéo/photo via le backend

### Fichiers
| Fichier | Rôle |
|---------|------|
| `frontend/js/simulator3d.js` | Logique complète (~3400 lignes) |
| `frontend/simulator3d.html` | Interface HTML (panneaux, sliders, boutons) |
| `frontend/css/simulator3d.css` | Styles (panneaux flottants, OSD, tooltips) |
| `scene_3d_config.json` | Configuration des objets 3D et environnement |

---

## 2. Architecture et Initialisation

### 2.1 Ordre d'initialisation (`initSubSim`)
```
loadSettings()          → Restaurer physState/diveState/osdConfig depuis localStorage
initScene()             → Scène Three.js, caméra, renderer, éclairage, grille, OrbitControls
initOsdCanvas()         → Canvas OSD overlay (DPR adapté)
buildMotorPanel()       → HTML indicateurs propulseurs M1-M8
buildDofPanel()         → HTML indicateurs 6DOF
initFloatingPanels()    → Gestion drag/collapse des panneaux
bindSliders()           → Lier sliders UI → callbacks
syncSlidersUI()        → Afficher valeurs restaurées
applyBasinSize()        → Appliquer profondeur/étendue → reconstruire parois/terrain/surface
applyFog()              → Configurer FogExp2 selon visibilité
initActionButtons()     → Boutons (armement, FPV, reset, vues)
loadModel()             → Charger bob_rov_3D.glb + projecteurs LED
loadEnvironmentConfig() → Lire scene_3d_config.json (environnement, terrain, surface)
loadScene3DConfig()     → Charger modèles GLB faune/flore depuis JSON
buildAllLife()          → Construire algues, coraux, poissons, créatures abyssales, brochets
connectWS()             → WebSocket télémétrie backend
loadGamepadProfile()    → Charger mapping gamepad
animate()               → Démarrer boucle de rendu
setFpv(true)            → Activer vue FPV par défaut
```

### 2.2 Boucle de rendu `animate()` (~60 FPS)
Chaque frame (dt max 50ms) :
1. Compteur FPS
2. Lecture gamepad → envoi commandes mouvement backend
3. Intégration physique 6DOF (si manette connectée)
4. Application rotation/translation au modèle ROV
5. Mise à jour faune/flore (animations GLB, comportements cinématiques, IA)
6. Animation vie procédurale (algues, poissons récifaux, créatures abyssales, brochets)
7. Mise à jour shaders (surface, caustiques, god rays)
8. Ambiance profondeur (atténuation lumière/couleurs)
9. Rendu OSD (horizon, jauges, boussole, propulseurs)
10. Suivi ROV (caméra extérieure si followROV)
11. Rendu final (caméra FPV ou extérieure)

---

## 3. Système de Caméra

### 3.1 Deux modes
| Mode | Caméra | FOV | Position |
|------|--------|-----|----------|
| Extérieur | `camera` (PerspectiveCamera) | 55° | Libre (OrbitControls + damping 0.08) |
| FPV | `fpvCamera` (PerspectiveCamera) | 80° | Avant ROV : `(-MODEL_LENGTH/2 - 0.02, 0.05, 0)`, rotation Y = π/2 |

### 3.2 Basculement `setFpv(active)`
- Active/désactive FPV
- Désactive OrbitControls en FPV
- En sortie FPV : `recenterOnROV()` recentre caméra + active suivi

### 3.3 Suivi automatique `followROV`
- Mode extérieur : `controls.target` interpole vers position ROV (facteur 0.08)
- Interaction utilisateur (orbit/pan/zoom) désactive le suivi
- Touche `R` ou bouton recentre

---

## 4. Variables Globales Principales

### 4.1 diveState (état plongée)
```javascript
diveState = {
    depth: 30,           // Profondeur fond (5-300m) → FLOOR_Y = -depth
    visibility: 25,      // Visibilité/turbidité (1-60m) → densité fog
    extent: 100,         // Largeur bassin (20-1000m) → WALL_POS = extent/2
    reliefHeight: 1,     // Amplitude relief sol (0-20m)
    abyssDepth: 15,      // Profondeur fosse sous plateau (0-100m)
    abyssRadius: 45,     // Rayon fosse % bassin (10-80%)
    led: true,           // Projecteurs LED activés
    ledIntensity: 80,    // Intensité LED (0-100%)
    ledTilt: 0,          // Tilt LED (-30° à +45°)
}
```

### 4.2 Constantes dérivées
| Variable | Calcul | Rôle |
|----------|--------|------|
| `CEIL_Y` | `0.0` | Surface de l'eau |
| `FLOOR_Y` | `-depth` | Profondeur maximale (Y négatif = profond) |
| `WALL_POS` | `extent / 2` | Demi-largeur bassin |
| `WALL_LIMIT` | `WALL_POS - 0.5` | Limite collision ROV |
| `compactHalfW()` | `lerp(WALL_LIMIT, 10, compactZone/100)` | Demi-largeur effective selon zone compacte |

### 4.3 physState (physique 6DOF)
```javascript
physState = {
    inertia: 0.90,       // Inertie/glissement eau (0.01-0.99)
    gain: 1.0,           // Gain translation (0.1-5×)
    sens: 0.5,           // Sensibilité joysticks (0.1-1)
    rollSens: 1.0,       // Sensibilité roulis (0-3×)
    pitchSens: 1.0,      // Sensibilité tangage (0-3×)
}
```

### 4.4 physState.target / vel / current
Pour chaque degré de liberté (surge, sway, heave, yaw, roll, pitch) :
- `target` : consigne d'entrée (gamepad/clavier, -1 à +1)
- `vel` : vitesse courante (intégrée avec inertie)
- `current` : position/angle courant

---

## 5. Physique du ROV

### 5.1 Intégration 6DOF
```
vel = vel × inertia + target × ACCEL × (1 - inertia)
current += vel
```
- **Rotations** : `ROT_ACCEL = 0.0024`, appliquées via quaternion (Euler → quaternion)
- **Translations** : `TRANS_ACCEL = 0.0024`, appliquées en repère LOCAL (après rotation quaternion)
- Sensibilités indépendantes roll/pitch multiplient le target

### 5.2 Collisions
- **Limites X/Z** : ±WALL_LIMIT avec amortissement 0.5× vitesse
- **Plancher Y** : `floorLimitAt(x,z)` = max(terrain + HULL_CLEARANCE, FLOOR_Y), HULL_CLEARANCE = 0.25m
- **Plafond Y** : CEIL_Y - 0.3
- **Pente raide** : si gradient terrain > 0.7 (~60°), rejette translation horizontale (empêche empaler)
- **Impact rumble** : vibration gamepad si vitesse impact > 0.002, cooldown 300ms

---

## 6. Environnement Sous-Marin

### 6.1 Surface d'eau (Shaders GPU)
**Vertex Shader** (`_SURFACE_VS`) :
- 6 vagues Gerstner superposées (fréquences/amplitudes/directions variées)
- Normales calculées par différences finies (ε = 0.15)
- Détection crêtes pour écume (proportionnelle à l'élévation)

**Fragment Shader** (`_SURFACE_FS`) :
- **Fresnel Schlick** (F0=0.02) : réflexion physique eau/ciel
- **Réflexion ciel** : gradient zénith bleu profond → horizon clair + halo solaire
- **Subsurface Scattering** (SSS) : lumière traversant les crêtes (vert-turquoise)
- **Glitter path** : specular soleil (puissance 512) + specular diffuse (64)
- **Écume** : blanche sur crêtes (vue dessus uniquement)
- **Split camAbove/camBelow** : rendu différent selon côté de la surface
- `depthWrite=false` critique pour FPV sous l'eau

### 6.2 Terrain — Topographie "Blue Hole"
**`terrainHeightAt(x, z)`** :
1. **Plateau corallien** : base fixe à `-(REEF_DEPTH + reliefHeight)` (~-21 à -40m), relief fractal `fbm2` (amplitude ×0.18)
2. **Fosse abyssale centrale** : rayon `WALL_POS × abyssRadius%`, transition smoothstep cubique
3. **Fond de fosse** : `max(min(plateauY - abyssDepth, FLOOR_Y) + floorVariation, FLOOR_Y)` → atteint toujours FLOOR_Y en bassin profond
4. **Sortie plateau** : si bassin < REEF_DEPTH + reliefHeight, retourne uniquement plateau

**`terrainMeshHeightAt(x, z)`** : interpolation bilinéaire depuis le maillage terrain pour collisions précises.

### 6.3 Parois
- 4 plans inclinés à **45° vers l'extérieur** (effet canyon évasé)
- Relief irrégulier par `fbm` displacement sur vertices
- Texture roche + normalMap, tiling adaptatif

### 6.4 Brouillard (FogExp2)
- Densité : `1.7 / visibility`
- Couleur : bleu foncé en profondeur, bleu clair près surface (selon facteur `f`)

### 6.5 Effets lumineux
| Effet | Technique | Animation |
|-------|-----------|-----------|
| **God Rays** | 20 plans avec texture radiale 64×256, opacité décroissante | Sinusoïdale lente, phase par rayon |
| **Caustiques** | Shader Voronoi animé (2 échelles), blend additif | Temps continu |
| **Projecteurs LED** | 2 SpotLights (26° cône, 60m portée, ombres) | Tilt + intensité ajustables |
| **Ambiance profondeur** | Atténuation lumières × facteur `f` basé sur profondeur | Continue avec Y |

---

## 7. Faune et Flore 3D (Modèles GLB)

### 7.1 Chargement (`loadScene3DConfig`)
- Lecture `scene_3d_config.json` via API `/api/scene3d/config`
- Pour chaque objet : `GLTFLoader` + `SkeletonUtils.clone()` pour préserver squelettes
- Scale = `real_size_m / maxDimension × random(scale_min, scale_max)`
- Animations GLB lancées automatiquement (sauf `behavior=static`)

### 7.2 Détection de heading (moyenne pondérée des normales)
- Vertices séparés en **moitié avant** (Z > centre) et **arrière** (Z < centre)
- Moyenne de la composante Z des normales de chaque moitié
- Si `frontAvg < -0.05` ET `backAvg > 0.05` → modèle face à -Z → rotation 180°
- Modèle allongé sur X : rotation ±90° selon vertices +X vs -X
- **Robuste** : une nageoire à normale atypique ne fausse pas la moyenne de centaines de vertices

### 7.3 Zones de placement (`positionInZone`)
| Zone | Distribution Y |
|------|---------------|
| `surface` | CEIL_Y - 2 à CEIL_Y - 5 |
| `fond` | terrain + 0.05 (flore) ou terrain + 0.3 à + 3m (faune) |
| `pleine_eau` | **Exponentielle biaisée** : ~50% dans les 20 premiers mètres, reste dans colonne d'eau |
| `multi_couches` | Uniforme : FLOOR_Y + 1 à CEIL_Y - 1.5 |

### 7.4 Contraintes runtime (`clampToBasin`)
- X/Z : ±`compactHalfW() × 0.9`
- Y selon zone (SURF_MARGIN = 1.5m pour permettre aux mammifères de remonter en surface)

### 7.5 Types de modèles
| Type | Kinematic forcé | Notes |
|------|----------------|-------|
| `faune` | Comme configuré | Poissons, auto-upgrade fixe→nageant si behavior=mouvement |
| `mamifere` | `nageant` | Machine à états surface/plongeon/descente/profondeur/remontée |
| `flore` | `ancre_ondule` | Oscillation Y + rotation Z (courant marin) |
| `objet` | `fixe` | Épave, etc. |

---

## 8. Comportements Cinématiques

### 8.1 Trajectoire en huit (lemniscate) — `kinematic: "nageant"`
```
x = cx + rx × cos(phase) / (1 + sin²(phase))
z = cz + rz × sin(phase) × cos(phase) / (1 + sin²(phase))
```
- **Paramètres** : `cx, cz` (centre), `rx, rz` (rayons), `phase` (avancement), `dir` (±1), `yAmp` (oscillation verticale)
- **Vitesse phase** : `currentSpeed × dt × (1.5 / sizeCat) × dir` (mammifères), `(0.3 / sizeCat) × dir` (poissons)
- **Orientation** : tangente du huit → lerp `rotation.y` vers `atan2(dx, dz)`
- **sizeCat** : `min(2.5, max(1, cbrt(realSize / 0.5)))` — guppy=1, thon=1, esturgeon≈1.3, baleine≈2.5

### 8.2 Ancré avec ondulation — `kinematic: "ancre_ondule"`
- Y = baseY + sin(t × 1.2 + x) × sway
- Rotation Z = sin(t × 0.8 + z) × 0.08

### 8.3 Fixe — `kinematic: "fixe"`
- Aucun mouvement (sauf auto-upgrade si behavior implique du mouvement)

---

## 9. Machine à États Mammifère

### 9.1 Cycle de vie (5 états)
```
surface → plongeon → descente → profondeur → remontee → surface → ...
```

| État | Comportement | Transition |
|------|-------------|------------|
| **surface** | Remonte si Y < CEIL_Y-6, sinon huit en surface (Y ≈ -4m ± 0.3) | Timer surfDur écoulé → plongeon |
| **plongeon** | Pitch négatif (-46° à -63°), léger avant, Y maintenu à -3m | Timer 3-5s → descente |
| **descente** | Descend vers targetY (30-80% plage), pitch proportionnel, avance | Atteint targetY ou plancher → profondeur |
| **profondeur** | Huit à profondeur fixe avec oscillation Y | Timer profDur → remontee |
| **remontee** | Monte vers targetY (60% surface, 40% mi-prof), pitch positif (+10° à +60°) | Atteint targetY → surface |

### 9.2 Paramètres mammifère
```javascript
mammal = {
    state: 'surface',
    timer: 3-8s,           // Premier timer court pour cycle rapide
    targetY: CEIL_Y - 4,
    pitch: 0,              // Tangage courant
    pitchTarget: 0,        // Tangage cible (lerp dt × 0.6 à 1.5)
    surfDur: 8-20s,        // Durée surface
    profDur: 15-40s,       // Durée profondeur
    diveSpeed: 1.5,        // Vitesse verticale m/s
    bodyMargin: max(5, demiLongueur × 0.9 + 2),  // Sécurité plancher
    floorY: FLOOR_Y + bodyMargin,  // Recalculé chaque frame
    origRx, origRz,        // Rayons originaux (pour recalcul dynamique)
}
```

### 9.3 Orientation
- **Yaw** : `rotation.y` mis à jour par lerp vers tangente du huit
- **Pitch** : quaternion composé `yawQ × pitchQ` (tangage correct quelle que soit la direction)
- **IA override** : `rotation.y` lerpé vers `targetYaw` (pas de slerp quaternion — évite conflit avec reconstruction yaw+pitch)

### 9.4 Sécurité
- **Plancher** : `floorY = FLOOR_Y + bodyMargin` recalculé chaque frame (s'adapte au slider profondeur)
- **Centre huit clampé** : ±`compactHalfW() × 0.85` sans attirer vers (0,0) (évite effet siphon fosse)
- **Rayon dynamique** : `min(origRx, compactHalfW() × 0.65)` — s'adapte au slider zone compacte

---

## 10. Comportements IA

### 10.1 Seuils de détection
| Type | Seuil |
|------|-------|
| Mammifère | `24 × sizeCat` (~60m pour baleine) |
| Autres | `8 × sizeCat` (~20m max) |

### 10.2 Comportements
| Behavior | Effet quand distance < seuil |
|----------|------------------------------|
| `nageant` | Aucun override — comportement normal (huit) |
| `curieux` | Vitesse ×1.3, orientation vers ROV, approche douce |
| `fuir` | Vitesse ×3, orientation opposée au ROV, fuite rapide |
| `neant` | Aucun comportement IA |
| `static` | Fixe + pas d'animation GLB |

### 10.3 IA Override (`iaOverride = true`)
- Déplacement direct vers/contre le ROV via `rotation.y` lerp
- Centre du huit recentré sur position actuelle
- **Mammifères** : synchronisation état avec profondeur (surface si Y > -6, profondeur sinon)

---

## 11. Vie Procédurale (non-GLB)

### 11.1 Algues ondulantes
- **500 touffes × 5 lames** = 2500 instances (InstancedMesh)
- Shader vertex : ondulation sinusoïdale basée sur temps, sway, hauteur instance
- Ancrage sur terrain, hauteur variable

### 11.2 Coraux (4 espèces)
- Géométries procédurales (branches, dômes, tapis)
- InstancedMesh avec palette couleurs par espèce
- Visibilité hystérésis selon profondeur (récif vs abysses)

### 11.3 Poissons récifaux
- **500 instances** en 8 bancs (InstancedMesh)
- Errance + fuite ROV (distance 2.2m)
- Effarouchement temporaire

### 11.4 Créatures abyssales bioluminescentes
- 36 instances sphères allongées + points lumineux
- Émissif turquoise, animation lente
- Limite profondeur : sous -REEF_DEPTH-3

### 11.5 Brochets abyssaux
- 2 patrols circulaires dans la fosse
- Ciblage ROV si proche et profond, attaque virtuelle

---

## 12. OSD Cockpit

### 12.1 Éléments affichés (canvas 2D overlay)
| Élément | Description |
|---------|-------------|
| Horizon artificiel | Ligne horizontale + graduations tangage ±90°, ailes yaw |
| Profondeur | Jauge barre verticale 0-100m + valeur numérique |
| Boussole | N/S/E/O défilants selon cap, graduation 360° |
| Batterie | Barre pourcentage, couleur variable |
| Armement | Texte rouge/vert |
| Horloge | HH:MM:SS |
| FPS | Compteur temps réel |
| Propulseurs M1-M8 | Cercles indicateurs puissance |
| Température | Texte °C (simulé) |

### 12.2 Filtre bain d'huile (oilBath)
- Double passage EMA : `alpha = 0.5 / (0.5 + damping × 0.45)`
- Lisse roll/pitch pour éliminer bruit haute fréquence

### 12.3 Configuration OSD (`osdConfig`)
```javascript
osdConfig = {
    horizonVisible: true,
    horizonOpacity: 1.0,    // 0-1
    horizonDiameter: 20,    // % de min(width, height)
}
```

---

## 13. Gamepad

### 13.1 Chargement profil
- Priorité : localStorage `rov.gamepad.mapping`
- Fallback : API `/api/gamepad/mapping`
- Rechargé toutes les 5s + événement `gamepadconnected`

### 13.2 Mapping flexible
- **Axes** : LEFT_X/Y, RIGHT_X/Y, L2/R2 → fonctions (surge, sway, heave, yaw, roll, pitch)
- **Boutons** : individuels ou combinaisons (`+`) → fonctions DOF ou UI (fpv_toggle, reset_position, arm_toggle)
- **Deadzone** par axe ou globale (0-10%)
- **Inversion** et **sensibilité** par axe

### 13.3 Lecture (chaque frame)
- Applique deadzone, mappe fonctions → physState.target
- Détection transitions boutons (pressed/released) pour actions UI

---

## 14. WebSocket

### 14.1 Connexion
- Endpoint : `ws(s)://host:port/ws/telemetry`
- Reconnexion exponentielle : 1s → 8s max

### 14.2 Messages reçus
| Type | Contenu | Action |
|------|---------|--------|
| `dof` | Cibles mouvements | Mise à jour panneaux DOF (si pas de manette) |
| `motors` | Puissances M1-M8 (%) | Mise à jour panneaux propulseurs |
| `armed` | État armement | Mise à jour indicateur |

### 14.3 Messages envoyés
| Type | Contenu | Throttling |
|------|---------|------------|
| `move` | surge/sway/heave/yaw/roll/pitch en % | 50ms + détection changement |

---

## 15. Sliders et Contrôles UI

### 15.1 Panneau Physique 6DOF
| Slider | ID | Range | Callback |
|--------|----|-------|----------|
| Inertie/glissement | `sim-inertia` | 0.01-0.99 | `physState.inertia` + save |
| Amplitude déplacement | `sim-gain` | 0.1-5× | `physState.gain` + save |
| Sensibilité joysticks | `sim-sens` | 0.1-1 | `physState.sens` + save |
| Sensibilité roulis | `sim-roll-sens` | 0-3× | `physState.rollSens` + save |
| Sensibilité tangage | `sim-pitch-sens` | 0-3× | `physState.pitchSens` + save |

### 15.2 Panneau Environnement sous-marin
| Slider | ID | Range | Callback |
|--------|----|-------|----------|
| Profondeur fond | `sim-depth` | 5-300m | `applyBasinSize()` |
| Largeur bassin | `sim-extent` | 20-1000m | `applyBasinSize()` |
| Visibilité | `sim-visibility` | 1-60m | `applyFog()` + ambiance |
| Relief sol | `sim-relief` | 0-20m | `applyBasinSize()` |
| Fosse abyssale | `sim-abyss-depth` | 0-100m | `applyBasinSize()` |
| Rayon fosse | `sim-abyss-radius` | 10-80% | `applyBasinSize()` |
| Zone compacte | `sim-compact-zone` | 0-100% | `applyBasinSize()` |

### 15.3 Panneau Actions
| Bouton | Action |
|--------|--------|
| Armer/Désarmer | Toggle armement ROV |
| Lumière | Toggle projecteurs LED |
| Centrer ROV | Reset position (0, -depth/2, 0) |
| FPV | Bascule vue FPV/extérieure |
| Recentrer (R) | Recentre caméra sur ROV |
| Vues ¾/haut/côté | Positions caméra prédéfinies |

### 15.4 Panneau LED
| Slider | Range |
|--------|-------|
| Intensité | 0-100% (→ SpotLight intensity 0-320) |
| Tilt | -30° à +45° |

---

## 16. Persistance (localStorage)

### 16.1 Clés
| Clé | Contenu |
|-----|---------|
| `subsim.settings` | physState + diveState + osdConfig |
| `subsim.panels` | Positions x/y et état collapsed des panneaux |
| `rov.gamepad.mapping` | Mapping axes/boutons gamepad |

### 16.2 Fonctions
- `saveSettings()` : appelé à chaque modification de slider
- `loadSettings()` : appelé au démarrage avant initScene
- `syncSlidersUI()` : met à jour l'affichage des sliders depuis les états

---

## 17. Configuration `scene_3d_config.json`

### 17.1 Objets (faune/flore)
```json
{
    "name": "nom_affiché",
    "type": "faune | mamifere | flore | objet",
    "model": "fichier.glb",
    "real_size_m": 0.5,
    "count": 10,
    "scale_min": 0.8,
    "scale_max": 1.2,
    "kinematic": "fixe | nageant | ancre_ondule",
    "zone": "surface | fond | pleine_eau | multi_couches",
    "speed": 1.0,
    "behavior": "nageant | curieux | fuir | neant | static",
    "turn_speed": 0.5,
    "wander_radius": 5
}
```

### 17.2 Environnement
```json
{
    "environment": {
        "current": 0.03,
        "compact_zone": 85,
        "terrain": { "enabled": true, "height": 1 },
        "walls": { "enabled": false, "tiling": 5 },
        "surface": {
            "waves": { "enabled": true, "height": 0.2, "speed": 2 },
            "caustics": { "enabled": true, "intensity": 0.23 },
            "godrays": { "enabled": true, "intensity": 0.05 }
        },
        "reef": {
            "algae": { "enabled": true, "density": 1, "length": 2.4 },
            "corals": { "enabled": true, "density": 48 },
            "fish": { "enabled": true, "count": 500, "speed": 1.3 }
        },
        "abyss": {
            "creatures": { "enabled": true, "density": 5 },
            "pikes": { "enabled": false }
        }
    }
}
```

---

## 18. Renderer et Post-Processing

| Paramètre | Valeur |
|-----------|--------|
| Antialias | true |
| Pixel ratio | min(devicePixelRatio, 2) |
| Color space | sRGB |
| Tone mapping | ACES Filmic |
| Exposition | 1.15 |
| Ombres | PCF Soft, 2048×2048, bias -0.0004, normalBias 0.02, radius 4 |
| Brouillard | FogExp2, densité = 1.7 / visibility |
| Surface | ShaderMaterial, double face, transparent, depthWrite=false, renderOrder=100 |
| Caustiques | ShaderMaterial, blend additif, transparent, depthWrite=false |

---

## 19. Points d'Attention pour la Modification

1. **Coordonnées Y négatives** : plus négatif = plus profond. `Math.max(-10, -50) = -10` (le moins profond). Utiliser `Math.min` pour aller plus profond.
2. **Quaternion vs rotation.y** : le code mammifère reconstruit le quaternion depuis `rotation.y + pitch`. Toujours mettre à jour `rotation.y` (pas le quaternion directement) pour l'orientation yaw.
3. **SURF_MARGIN = 1.5** : marge sous la surface dans clampToBasin. Ne pas augmenter au-delà de 2m sinon la baleine ne peut plus respirer en surface.
4. **Plateau récifal fixe** : `REEF_DEPTH = 20m` — le plateau reste à ~-25m quelle que soit la profondeur du bassin (correct biologiquement pour la photosynthèse).
5. **InstancedMesh** : les algues, coraux, poissons récifaux utilisent InstancedMesh. Modifier une instance nécessite `setMatrixAt(index, matrix)` + `instanceMatrix.needsUpdate = true`.
6. **`compactHalfW()`** : fonction dynamique appelée fréquemment. Le rayon des trajectoires de la faune GLB est recalculé à chaque frame pour les mammifères.
7. **Cache-Control no-store** : les fichiers JS/CSS sont servis avec `Cache-Control: no-store` via `NoCacheStaticFiles` dans le backend — pas besoin de redémarrer le serveur après modification.
