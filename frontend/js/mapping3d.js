// ============================================================================
// BOB-ROV · Visualiseur 3D (test du mappage télécommande)
// Charge le modèle GLB, l'anime selon les consignes 6DOF (WebSocket) et
// illustre la puissance des 8 propulseurs via le panneau HTML latéral.
// ============================================================================
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// --- Conventions d'axes du ROV (repère Three.js, Y = haut) ---
//   AVANT = +Z (vers la caméra)   ARRIÈRE = -Z
//   DROITE = +X                   GAUCHE  = -X
// Numérotation officielle (départ avant-droit, sens horaire strict) :
//   Horizontaux (rouge) : M1 Av-D, M2 Ar-D, M3 Ar-G, M4 Av-G
//   Verticaux   (vert)  : M5 Av-D, M6 Ar-D, M7 Ar-G, M8 Av-G

// Légende des 8 moteurs (panneau HTML de puissance uniquement — les sphères
// 3D sur le modèle ont été supprimées pour un rendu propre du GLB).
const MOTOR_NAMES = {
    1: 'M1 Av-D', 2: 'M2 Ar-D', 3: 'M3 Ar-G', 4: 'M4 Av-G',
    5: 'M5 Vt Av-D', 6: 'M6 Vt Ar-D', 7: 'M7 Vt Ar-G', 8: 'M8 Vt Av-G',
};

const DOF_ORDER = ['surge', 'sway', 'heave', 'yaw', 'roll', 'pitch'];
const DOF_LABELS = {
    surge: 'Surge', sway: 'Sway', heave: 'Heave',
    yaw: 'Yaw', roll: 'Roll', pitch: 'Pitch',
};

// Amplitudes de référence (fallback proportionnel télémétrie/IMU sans manette)
const MAX_TILT = THREE.MathUtils.degToRad(35);  // roll / pitch max
const MAX_YAW  = THREE.MathUtils.degToRad(60);   // cap max
const MAX_TRANS = 0.9;                            // translation max (mètres, reste au-dessus du sol)
const LERP = 0.10;                                // lissage du fallback proportionnel

// --- Échelle réelle de la scène : 1 unité Three.js = 1 mètre ---
const MODEL_LENGTH = 0.4;    // longueur réelle du ROV (~40 cm)
// Profondeur du bassin paramétrable (panneau "Simulateur de plongée") :
// la surface est à Y = 0 m (le ROV y démarre), le fond à Y = -profondeur.
let FLOOR_Y = -30.0;         // hauteur du fond, pilotée par diveState.depth

// --- Moteur physique 3D (intégrateur vitesse + friction fluide) ---
// La commande (-1..+1) applique une accélération ; la vitesse est amortie par le
// facteur d'inertie (slider 1) puis intégrée dans la position/rotation. Le gain
// d'amplitude (slider 2) ne pondère QUE la translation.
const ROT_ACCEL   = 0.0024;                       // accél. angulaire (rad/frame²)
const TRANS_ACCEL = 0.0024;                       // accél. linéaire (m/frame², ≈ 1.3 m/s en croisière)
// Boîte de collision du bassin (repère monde, en mètres) : 4 parois verticales
// juste à l'intérieur des parois visuelles (±WALL_POS, piloté par l'étendue du
// bassin), fond plat ou relief avec garde de coque, plafond = surface (Y = 0).
let WALL_LIMIT       = 9.5;    // recalculée par applyBasinSize()
const HULL_CLEARANCE = 0.25;   // garde entre le centre du ROV et le fond
const CEIL_Y         = 0.0;    // surface de l'eau : le ROV ne peut pas en sortir

// --- Simulateur de plongée : profondeur, étendue, turbidité et projecteurs ---
// depth (m) : hauteur du bassin · extent (m) : largeur/longueur horizontale du
// bassin (auto = max(100, depth × 1.5) tant que le slider n'est pas touché) ·
// visibility (m) : portée du brouillard FogExp2 · led / ledIntensity (%) /
// ledTilt (°) : état des 2 SpotLights de projecteur.glb
const diveState = {
    depth: 30, visibility: 25, extent: 100, extentManual: false,
    led: false, ledIntensity: 80, ledTilt: 12,
};
const DIVE_KEYS = {
    depth: 'mapping3d.depth', visibility: 'mapping3d.visibility',
    extent: 'mapping3d.extent', extentManual: 'mapping3d.extentManual',
    led: 'mapping3d.led', ledIntensity: 'mapping3d.ledIntensity', ledTilt: 'mapping3d.ledTilt',
};
const LED_MAX_INTENSITY = 320;   // candela des SpotLights à 100 % d'intensité
const SUN_FADE_DEPTH = 11;       // m : e-folding de la lumière SOUS le plateau (-20 m)

// Réglages physiques ajustables en direct (persistés dans localStorage).
// `sens` = facteur d'échelle appliqué aux axes manette (anti sur-sensibilité).
const physState = { inertia: 0.90, gain: 1.0, sens: 0.45 };
const PHYS_KEYS = { inertia: 'mapping3d.inertia', gain: 'mapping3d.gain', sens: 'mapping3d.sens' };

// --- Retour haptique (vibration manette) sur impact parois / fond / plafond ---
// Vitesses en m/frame (≈60 fps) : seuil de déclenchement et saturation du choc.
const IMPACT_MIN_SPEED   = 0.002;   // ~0.12 m/s : en-dessous, contact en douceur
const IMPACT_MAX_SPEED   = 0.020;   // ~1.2 m/s : choc maximal (vibration pleine)
const IMPACT_COOLDOWN_MS = 300;     // anti-rebond entre deux vibrations
let surfContacts = {};              // surfaces en contact ('x-','x+','z-','z+','y-','y+')
let lastImpactTime = 0;

let scene, camera, renderer, controls;
let fpvCamera;           // caméra embarquée FPV (fixée au nez du ROV)
let isFpvActive = false; // true = rendu via la caméra embarquée
let modelGroup;          // conteneur animé (orientation + translation)
let gridHelper, shadowGround;       // sol plat (grille + récepteur d'ombres)
let wallsGroup = null;   // 4 parois rocheuses (créées à la demande)
let terrainMesh = null;  // relief rocheux du fond (créé à la demande)
let wallTex = null;      // texture roche des parois (tiling réglable, mise en cache)
let wallMat = null;      // matériau des parois (réutilisé à chaque reconstruction)
let terrainTex = null;   // texture roche du relief (réutilisée au redimensionnement)
let algaeMesh = null;    // InstancedMesh des brins d'algues (créé à la demande)
let fishMesh = null;     // InstancedMesh des poissons de récif (créé à la demande)
let coralMeshes = null;  // [branches, dômes, anémones] : 3 InstancedMesh du récif
let abyssMesh = null;    // InstancedMesh des créatures bioluminescentes (corps)
let abyssGlowMesh = null; // photophores émissifs (matrices synchronisées au corps)
let pikeGroup = null;    // brochets abyssaux géants (groupes de meshes classiques)
let sunDir, sunFill, sunAmbient;    // lumières "jour" atténuées avec la profondeur
let projGroup = null;    // pivot Tilt : mesh projecteur.glb + SpotLights + cibles
let projSpots = [];      // les 2 SpotLights (gauche / droit)
let rovFitScale = 1;                              // échelle appliquée au GLB du ROV
const rovFitOffset = new THREE.Vector3();         // recentrage appliqué au GLB du ROV
const envMats = [];      // matériaux dont l'IBL (envMapIntensity) suit la profondeur
let horizonCtx = null;   // contexte 2D du widget horizon artificiel
let horizonDpr = 1;      // devicePixelRatio du buffer horizon (netteté HD/Retina)
const clock = new THREE.Clock();   // dt pour l'animation de la vie sous-marine

// Commande courante (-1..+1) et vitesses de l'intégrateur.
// IMPORTANT : les vitesses de translation (surge/sway/heave) sont exprimées
// dans le REPÈRE CORPS du ROV (surge = son nez, sway = son tribord) ; elles
// sont projetées dans le monde via le quaternion d'attitude avant intégration.
const target = { surge: 0, sway: 0, heave: 0, yaw: 0, roll: 0, pitch: 0 };
const vel = { surge: 0, sway: 0, heave: 0, yaw: 0, roll: 0, pitch: 0 };
const current = { yaw: 0, roll: 0, pitch: 0 };   // angles appliqués (radians)
const posWorld = new THREE.Vector3();            // position intégrée (monde)
const _bodyVel = new THREE.Vector3();            // tampon corps → monde
const _eulerTmp = new THREE.Euler();
const _quatTmp = new THREE.Quaternion();
let motorState = {};     // id -> percent (0..100)

// ---------------------------------------------------------------------------
// INITIALISATION SCÈNE
// ---------------------------------------------------------------------------
function initScene() {
    const container = document.getElementById('scene-container');

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b1020);
    // Brouillard sous-marin exponentiel : la densité est pilotée par le slider
    // "Visibilité / Turbidité" du simulateur de plongée (applyFog).
    scene.fog = new THREE.FogExp2(0x0b1020, 1.7 / diveState.visibility);

    // Caméra à l'échelle réelle : near 5 cm (pas de clipping en zoom rapproché),
    // far ajusté à la profondeur ET à l'étendue du bassin (applyBasinSize) pour
    // éviter tout découpage visuel jusqu'à 300 m de fond / 1000 m de large.
    camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.05, Math.max(100, diveState.depth * 2.5));
    camera.position.set(1.5, 1.5, 2.5);

    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    // Rendu physique : couleurs sRGB + tone mapping cinéma (ACES) + ombres douces
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(renderer.domElement);

    // Éclairage d'environnement (IBL) : reflets/GI réalistes sur les matériaux
    // PBR du GLB, généré procéduralement (aucun fichier HDR à télécharger).
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();

    // Éclairage dynamique "lumière du jour" : atténué exponentiellement avec la
    // profondeur du ROV (updateDepthAmbience) — dans les profondeurs, seuls les
    // projecteurs LED de projecteur.glb éclairent le décor.
    sunAmbient = new THREE.AmbientLight(0x4a5578, 0.5);
    scene.add(sunAmbient);
    const dir = new THREE.DirectionalLight(0xffffff, 1.8);
    sunDir = dir;
    dir.position.set(6, 12, 8);
    dir.castShadow = true;
    dir.shadow.mapSize.set(2048, 2048);
    dir.shadow.bias = -0.0004;
    dir.shadow.normalBias = 0.02;
    dir.shadow.radius = 4;
    // Frustum d'ombre serré sur le ROV (0.4 m) et suivant ses déplacements
    // (cible = modelGroup plus bas) : ombres nettes sur tout le volume de 20 m.
    dir.shadow.camera.near = 5;
    dir.shadow.camera.far = 45;
    dir.shadow.camera.left = -1.5;
    dir.shadow.camera.right = 1.5;
    dir.shadow.camera.top = 1.5;
    dir.shadow.camera.bottom = -1.5;
    scene.add(dir);
    const fill = new THREE.DirectionalLight(0x88aaff, 0.5);
    fill.position.set(-6, 4, -8);
    scene.add(fill);
    sunFill = fill;

    // Sol : grille 20 m de côté, subdivisions de 1 m, + plan récepteur d'ombres
    // (masqués tous les deux quand le relief rocheux du fond est activé)
    gridHelper = new THREE.GridHelper(20, 20, 0x35d0ba, 0x24304d);
    gridHelper.position.y = FLOOR_Y;
    gridHelper.material.transparent = true;   // fondu de la grille avec l'obscurité
    scene.add(gridHelper);
    shadowGround = new THREE.Mesh(
        new THREE.PlaneGeometry(20, 20),
        new THREE.ShadowMaterial({ opacity: 0.35 })
    );
    shadowGround.rotation.x = -Math.PI / 2;
    shadowGround.position.y = FLOOR_Y;
    shadowGround.receiveShadow = true;
    scene.add(shadowGround);

    // Conteneur du modèle (animé) — sert aussi de cible à la lumière d'ombre
    modelGroup = new THREE.Group();
    scene.add(modelGroup);
    dir.target = modelGroup;

    // Caméra embarquée FPV : enfant du modelGroup (suit position + attitude du
    // ROV), grand angle type caméra sous-marine, near très court (1 cm) pour
    // ne jamais voir l'intérieur de la coque. Orientée 90° à droite de +Z
    // (regard vers -X) pour coïncider avec le nez visuel du modèle GLB,
    // et positionnée sur ce nez, légèrement surélevée.
    fpvCamera = new THREE.PerspectiveCamera(80, window.innerWidth / window.innerHeight, 0.01, Math.max(100, diveState.depth * 2.5));
    fpvCamera.position.set(-(MODEL_LENGTH / 2 + 0.02), 0.05, 0);
    fpvCamera.rotation.y = Math.PI / 2;
    modelGroup.add(fpvCamera);

    // Contrôles souris (orbite / zoom / pan) — de 30 cm (inspection) au recul
    // nécessaire pour embrasser tout le volume du bassin (applyBasinSize).
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.target.set(0, 0, 0);
    controls.minDistance = 0.3;
    controls.maxDistance = Math.max(25, diveState.depth * 1.5);
    // Restaure la vue externe de la session précédente (zoom / orbite / pan)
    // et la sauvegarde à la fin de chaque interaction souris.
    restoreCameraState();
    controls.addEventListener('end', saveCameraState);

    window.addEventListener('resize', onResize);
}

function onResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    fpvCamera.aspect = window.innerWidth / window.innerHeight;
    fpvCamera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

// ---------------------------------------------------------------------------
// PERSISTANCE DE LA VUE EXTERNE (position caméra + cible = zoom/orbite/pan)
// ---------------------------------------------------------------------------
const CAM_KEY = 'mapping3d.camera';

function saveCameraState() {
    try {
        localStorage.setItem(CAM_KEY, JSON.stringify({
            p: camera.position.toArray(),
            t: controls.target.toArray(),
        }));
    } catch (e) { /* localStorage indisponible : ignoré */ }
}

function restoreCameraState() {
    try {
        const d = JSON.parse(localStorage.getItem(CAM_KEY) || 'null');
        if (d && Array.isArray(d.p) && d.p.length === 3 && Array.isArray(d.t) && d.t.length === 3
            && d.p.every(Number.isFinite) && d.t.every(Number.isFinite)) {
            camera.position.fromArray(d.p);
            controls.target.fromArray(d.t);
            controls.update();
        }
    } catch (e) { /* données corrompues : vue par défaut */ }
}

// ---------------------------------------------------------------------------
// CHARGEMENT DU MODÈLE GLB
// ---------------------------------------------------------------------------
function loadModel() {
    const loader = new GLTFLoader();
    loader.load(
        '/static/models/bob_rov_3D.glb',
        (gltf) => {
            const model = gltf.scene;

            // Centrer + mettre à l'échelle réelle : dimension max ≈ 0.4 m (40 cm).
            // La normalisation par la boîte englobante absorbe automatiquement
            // les exports en mm/cm/m d'Onshape (facteur ×0.001 inclus si besoin).
            const box = new THREE.Box3().setFromObject(model);
            const size = box.getSize(new THREE.Vector3());
            const center = box.getCenter(new THREE.Vector3());
            const maxDim = Math.max(size.x, size.y, size.z) || 1;
            const scale = MODEL_LENGTH / maxDim;
            model.scale.setScalar(scale);
            // Recentrage APRÈS mise à l'échelle : on recalcule la boîte englobante
            // du modèle déjà redimensionné pour placer son centre géométrique
            // exactement sur l'origine du groupe. Le pivot des rotations
            // (roll / pitch / yaw) coïncide alors avec le centre du ROV, ce qui
            // évite toute dérive hors du champ lors des inclinaisons.
            const scaledBox = new THREE.Box3().setFromObject(model);
            const scaledCenter = scaledBox.getCenter(new THREE.Vector3());
            model.position.sub(scaledCenter);
            void center;                       // centre non-scalé conservé pour ref.

            const maxAniso = renderer.capabilities.getMaxAnisotropy();
            model.traverse((o) => {
                if (o.isMesh) {
                    o.castShadow = true;
                    o.receiveShadow = true;
                    // Les matériaux/couleurs/textures PBR NATIFS du GLB sont
                    // conservés tels quels (jamais écrasés) : on force seulement
                    // leur recompilation et la netteté des textures.
                    const mats = Array.isArray(o.material) ? o.material : [o.material];
                    mats.forEach((m) => {
                        if (!m) return;
                        if (m.map) { m.map.anisotropy = maxAniso; m.map.needsUpdate = true; }
                        m.needsUpdate = true;
                        envMats.push(m);   // l'IBL sur le ROV s'éteint avec la profondeur
                    });
                }
            });

            modelGroup.add(model);
            // Mémorise la normalisation du ROV pour l'appliquer à l'identique à
            // projecteur.glb (même repère d'origine → même échelle + recentrage).
            rovFitScale = scale;
            rovFitOffset.copy(scaledCenter).negate();
            loadProjectorModel();
            hideOverlay();
        },
        (xhr) => {
            if (xhr.total) {
                const pct = Math.round((xhr.loaded / xhr.total) * 100);
                document.getElementById('overlay-sub').textContent = `bob_rov_3D.glb — ${pct}%`;
            }
        },
        (err) => {
            console.error('Échec chargement GLB:', err);
            showError('Impossible de charger le modèle 3D',
                'Vérifiez que /static/models/bob_rov_3D.glb est accessible et que Three.js (CDN) est joignable depuis ce navigateur.');
        }
    );
}

// ---------------------------------------------------------------------------
// DÉCOR DU BASSIN : parois rocheuses + relief du fond (paramétrables via UI)
// ---------------------------------------------------------------------------
let WALL_POS = 10.0;                 // demi-étendue du bassin (pilotée par diveState.extent)
// Hauteur des parois : de la surface (CEIL_Y = 0) au fond (FLOOR_Y dépend du
// slider de profondeur) — recalculée à chaque reconstruction des parois.
function wallHeight() { return CEIL_Y - FLOOR_Y; }
const HEIGHT_MAX = 10.0;             // amplitude max du slider de relief (mètres)
// Pente au-delà de laquelle le relief est traité comme un FLANC de rocher /
// stalagmite : butée latérale (le ROV percute au lieu de grimper). ≈60°.
const TERRAIN_SLOPE_MAX = 1.7;

// --- Topographie "Blue Hole" : plateau corallien + fosse abyssale centrale ---
// Le relief n'est plus un simple champ de bruit posé sur FLOOR_Y : un large
// plateau récifal périphérique culmine vers -REEF_DEPTH, et au centre un
// tombant quasi vertical plonge jusqu'au fond sédimentaire (FLOOR_Y, réglable
// jusqu'à -300 m). Même fonction pour le visuel ET la collision.
const REEF_DEPTH   = 20;     // m : profondeur du socle du plateau corallien
const PIT_RADIUS_K = 0.45;   // rayon extérieur du tombant (fraction de WALL_POS)

const decorState = { walls: false, tiling: 3.0, terrain: false, height: 0.9 };
const DECOR_KEYS = {
    walls: 'mapping3d.walls', tiling: 'mapping3d.tiling',
    terrain: 'mapping3d.terrain', height: 'mapping3d.terrainHeight',
};

// Bruit de valeur 2D déterministe (hash entier + interpolation lisse) : sert à
// la fois à la texture procédurale de roche ET aux hauteurs du relief, ce qui
// garantit une collision au fond exactement alignée sur la géométrie affichée.
function hash2(ix, iz) {
    let h = (ix * 374761393 + iz * 668265263) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function noise2(x, z) {
    const ix = Math.floor(x), iz = Math.floor(z);
    const fx = x - ix, fz = z - iz;
    const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
    const a = hash2(ix, iz), b = hash2(ix + 1, iz);
    const c = hash2(ix, iz + 1), d = hash2(ix + 1, iz + 1);
    return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
}
function fbm2(x, z) {   // 3 octaves, résultat ~0..1
    return 0.55 * noise2(x, z) + 0.30 * noise2(x * 2.1, z * 2.1) + 0.15 * noise2(x * 4.3, z * 4.3);
}

// Hauteur du relief au point monde (x, z) — aussi utilisée en collision.
// 1) Plateau corallien : socle à -REEF_DEPTH + structures coralliennes dont
//    l'amplitude est pilotée par le slider "Hauteur du relief" (exposant 1.6 :
//    vallées creusées, pics affilés) + rugosité fine, plafonné à -1 m.
// 2) Fosse centrale : rayon PIT_RADIUS_K·WALL_POS au bord ondulé par le bruit
//    (canyon découpé), transition smoothstep DOUBLE (tombant abrupt) entre le
//    plateau et le fond sédimentaire légèrement vallonné à FLOOR_Y.
function terrainHeightAt(x, z) {
    const plateauBase = Math.max(FLOOR_Y, -REEF_DEPTH);
    const coral = Math.pow(fbm2(x * 0.35 + 7.3, z * 0.35 + 3.1), 1.6) * decorState.height
                + fbm2(x * 1.1 + 19.7, z * 1.1 + 5.9) * 0.8;
    const plateauY = Math.min(plateauBase + coral, -1.0);
    // Bassin moins profond que le plateau : pas de fosse, récif seul
    if (FLOOR_Y >= -REEF_DEPTH - 1) return plateauY;
    // Distance au centre, bord du canyon irrégularisé par le bruit basse fréquence
    const R = WALL_POS * PIT_RADIUS_K;
    const rim = (fbm2(x * 0.05 + 31.4, z * 0.05 + 12.8) - 0.5) * R * 0.35;
    const r = Math.hypot(x, z) + rim;
    if (r >= R) return plateauY;
    const t = THREE.MathUtils.smoothstep(r, R * 0.45, R);   // 0 au centre → 1 au bord
    const s = t * t * (3 - 2 * t);                          // double lissage = paroi raide
    const abyssY = FLOOR_Y + fbm2(x * 0.06 + 3.7, z * 0.06 + 8.2) * 3.0;   // sédiments
    return abyssY + (plateauY - abyssY) * s;
}

// Limite basse du volume au point (x, z) : fond plat ou relief + garde de coque.
// Plafonnée sous CEIL_Y : même si un pic dépasse le plafond (relief à 10 m),
// il reste toujours un couloir navigable et le ROV n'est jamais coincé.
function floorLimitAt(x, z) {
    const base = decorState.terrain ? terrainHeightAt(x, z) : FLOOR_Y;
    return Math.min(base + HULL_CLEARANCE, CEIL_Y - 0.3);
}

// Hauteur du relief telle que RENDUE par le maillage facetté (interpolation
// bilinéaire sur la grille des sommets, et non la valeur analytique lisse) : le
// décor posé dessus (coraux, anémones, algues) épouse EXACTEMENT les triangles
// visibles au lieu de flotter au-dessus des bosses ou de s'enfoncer dans les
// creux. Sans relief actif : simple fond plat à FLOOR_Y.
function terrainMeshHeightAt(x, z) {
    if (!decorState.terrain || !terrainMesh) return FLOOR_Y;
    const half = WALL_POS;
    const segs = terrainSegs();
    const step = (half * 2) / segs;
    const gx = THREE.MathUtils.clamp((x + half) / step, 0, segs - 1e-4);
    const gz = THREE.MathUtils.clamp((z + half) / step, 0, segs - 1e-4);
    const ix = Math.floor(gx), iz = Math.floor(gz);
    const fx = gx - ix, fz = gz - iz;
    const x0 = -half + ix * step, x1 = x0 + step;
    const z0 = -half + iz * step, z1 = z0 + step;
    const h00 = terrainHeightAt(x0, z0), h10 = terrainHeightAt(x1, z0);
    const h01 = terrainHeightAt(x0, z1), h11 = terrainHeightAt(x1, z1);
    return (h00 + (h10 - h00) * fx) * (1 - fz) + (h01 + (h11 - h01) * fx) * fz;
}

// Normale du relief au point (x, z) par différences finies du gradient de
// hauteur : oriente coraux/anémones perpendiculairement à la pente rocheuse.
const _terrNrm = new THREE.Vector3();
function terrainNormalAt(x, z) {
    if (!decorState.terrain || !terrainMesh) return _terrNrm.set(0, 1, 0);
    const e = 0.75;
    const hL = terrainHeightAt(x - e, z), hR = terrainHeightAt(x + e, z);
    const hD = terrainHeightAt(x, z - e), hU = terrainHeightAt(x, z + e);
    return _terrNrm.set(hL - hR, 2 * e, hD - hU).normalize();
}

// Texture de roche procédurale (canvas 256², aucun fichier à télécharger)
function makeRockTexture() {
    const size = 256;
    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(size, size);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const n = fbm2(x * 0.045, y * 0.045) * 0.7 + fbm2(x * 0.18 + 41, y * 0.18 + 17) * 0.3;
            const v = 46 + n * 78;                      // gris-brun sombre, fond marin
            const i = (y * size + x) * 4;
            img.data[i]     = v * 0.96;
            img.data[i + 1] = v * 0.90;
            img.data[i + 2] = v * 0.78;
            img.data[i + 3] = 255;
        }
    }
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(cv);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    return tex;
}

// 4 parois verticales encadrant le volume de l'étendue courante. Faces
// orientées vers l'INTÉRIEUR uniquement (backface culling) : la paroi côté
// caméra reste invisible, on voit toujours le ROV même caméra hors du bassin.
// Texture et matériau sont mis en cache : les reconstructions (sliders
// profondeur/étendue) ne repayent pas la génération procedurale 256².
function buildWalls() {
    if (!wallTex) wallTex = makeRockTexture();
    if (!wallMat) {
        wallMat = new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.95, metalness: 0.0 });
        envMats.push(wallMat);
    }
    const h = wallHeight();
    wallsGroup = new THREE.Group();
    [
        { x: 0, z: -WALL_POS, ry: 0 },                // nord (face +Z)
        { x: 0, z: +WALL_POS, ry: Math.PI },          // sud
        { x: -WALL_POS, z: 0, ry: Math.PI / 2 },      // ouest (face +X)
        { x: +WALL_POS, z: 0, ry: -Math.PI / 2 },     // est
    ].forEach((d) => {
        const m = new THREE.Mesh(new THREE.PlaneGeometry(WALL_POS * 2, h), wallMat);
        m.position.set(d.x, FLOOR_Y + h / 2, d.z);
        m.rotation.y = d.ry;
        m.receiveShadow = true;
        wallsGroup.add(m);
    });
    scene.add(wallsGroup);
}

// Relief rocheux du fond : plan de l'étendue courante subdivisé, déformé par
// le MÊME bruit que la collision (terrainHeightAt) — remplace le GridHelper.
// Répétition de texture ≈ 1 tuile / 3.3 m quelle que soit la taille du bassin
// (pas d'étirement des rochers à 1000 m d'étendue).
function terrainTexRepeats() { return Math.max(2, Math.round((WALL_POS * 2) / 3.3)); }

// Résolution du maillage : ≈ 1 sommet / 1.75 m, bornée 96..256 subdivisions
// (256×256 max ≈ 66k sommets) — parois du tombant abyssal bien découpées.
function terrainSegs() {
    return THREE.MathUtils.clamp(Math.round((WALL_POS * 2) / 1.75), 96, 256);
}

function buildTerrain() {
    const segs = terrainSegs();
    const geo = new THREE.PlaneGeometry(WALL_POS * 2, WALL_POS * 2, segs, segs);
    geo.rotateX(-Math.PI / 2);
    if (!terrainTex) terrainTex = makeRockTexture();
    terrainTex.repeat.set(terrainTexRepeats(), terrainTexRepeats());
    terrainMesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
        map: terrainTex, roughness: 0.95, metalness: 0.0,
    }));
    envMats.push(terrainMesh.material);
    terrainMesh.receiveShadow = true;
    updateTerrainGeometry();
    scene.add(terrainMesh);
}

// Redimensionne le plan du relief à l'étendue courante (changement de la
// largeur du bassin) : nouvelle géométrie, tiling recalculé, hauteurs rééchantillonnées.
function rebuildTerrainGeometry() {
    if (!terrainMesh) return;
    terrainMesh.geometry.dispose();
    const segs = terrainSegs();
    const geo = new THREE.PlaneGeometry(WALL_POS * 2, WALL_POS * 2, segs, segs);
    geo.rotateX(-Math.PI / 2);
    terrainMesh.geometry = geo;
    terrainTex.repeat.set(terrainTexRepeats(), terrainTexRepeats());
    updateTerrainGeometry();
}

// Ré-échantillonne la carte de hauteur sur le mesh (appelé en TEMPS RÉEL par
// le slider d'amplitude) — la collision suit automatiquement puisqu'elle
// échantillonne la même fonction terrainHeightAt.
function updateTerrainGeometry() {
    if (!terrainMesh) return;
    const pos = terrainMesh.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
        pos.setY(i, terrainHeightAt(pos.getX(i), pos.getZ(i)));
    }
    pos.needsUpdate = true;
    terrainMesh.geometry.computeVertexNormals();
    updateAlgaeAnchors();   // ré-ancrer les algues sur le nouveau relief
}

// Applique l'état du décor à la scène (création paresseuse des meshes)
function applyDecor() {
    if (decorState.walls && !wallsGroup) buildWalls();
    if (wallsGroup) wallsGroup.visible = decorState.walls;
    if (wallTex) {
        // Tuiles carrées de taille CONSTANTE quelle que soit l'étendue : le slider
        // règle le nombre de répétitions pour le bassin de référence de 20 m, puis
        // la répétition réelle est proportionnelle à la largeur (pas d'étirement).
        const reps = decorState.tiling * (WALL_POS * 2) / 20;
        wallTex.repeat.set(reps, Math.max(0.5, reps * wallHeight() / (WALL_POS * 2)));
    }
    if (decorState.terrain && !terrainMesh) buildTerrain();
    if (terrainMesh) terrainMesh.visible = decorState.terrain;
    if (gridHelper) gridHelper.visible = !decorState.terrain;
    if (shadowGround) shadowGround.visible = !decorState.terrain;
    const row = document.getElementById('decor-tiling-row');
    if (row) row.classList.toggle('disabled', !decorState.walls);
    const hRow = document.getElementById('decor-height-row');
    if (hRow) hRow.classList.toggle('disabled', !decorState.terrain);
    updateAlgaeAnchors();   // le toggle relief change la hauteur d'ancrage des algues
}

function loadDecorSettings() {
    try {
        decorState.walls = localStorage.getItem(DECOR_KEYS.walls) === '1';
        decorState.terrain = localStorage.getItem(DECOR_KEYS.terrain) === '1';
        const t = parseFloat(localStorage.getItem(DECOR_KEYS.tiling));
        if (!isNaN(t)) decorState.tiling = Math.min(8, Math.max(1, t));
        const h = parseFloat(localStorage.getItem(DECOR_KEYS.height));
        if (!isNaN(h)) decorState.height = Math.min(HEIGHT_MAX, Math.max(0, h));
    } catch (e) { /* localStorage indisponible : valeurs par défaut */ }
}

function bindDecorControls() {
    const cw = document.getElementById('decor-walls');
    const ct = document.getElementById('decor-terrain');
    const st = document.getElementById('decor-tiling');
    const stVal = document.getElementById('decor-tiling-val');
    const sh = document.getElementById('decor-height');
    const shVal = document.getElementById('decor-height-val');
    const save = (k, v) => { try { localStorage.setItem(DECOR_KEYS[k], v); } catch (e) { /* ignoré */ } };

    cw.checked = decorState.walls;
    ct.checked = decorState.terrain;
    st.value = decorState.tiling;
    stVal.textContent = decorState.tiling.toFixed(1) + '×';
    sh.value = decorState.height;
    shVal.textContent = decorState.height.toFixed(2) + ' m';

    cw.addEventListener('change', () => {
        decorState.walls = cw.checked;
        save('walls', cw.checked ? '1' : '0');
        applyDecor();
    });
    ct.addEventListener('change', () => {
        decorState.terrain = ct.checked;
        save('terrain', ct.checked ? '1' : '0');
        if (decorState.terrain && !terrainMesh) {
            // Première génération du maillage abyssal : indicateur pendant le calcul
            showTerrainLoading(true);
            requestAnimationFrame(() => setTimeout(() => {
                applyDecor();
                showTerrainLoading(false);
            }, 30));
        } else {
            applyDecor();
        }
    });
    st.addEventListener('input', () => {
        decorState.tiling = parseFloat(st.value);
        stVal.textContent = decorState.tiling.toFixed(1) + '×';
        save('tiling', st.value);
        applyDecor();
    });
    let heightRafPending = false;   // ≤ 1 rééchantillonnage de heightmap par frame
    sh.addEventListener('input', () => {
        decorState.height = parseFloat(sh.value);
        shVal.textContent = decorState.height.toFixed(2) + ' m';
        save('height', sh.value);
        if (!heightRafPending) {
            heightRafPending = true;
            requestAnimationFrame(() => {
                heightRafPending = false;
                updateTerrainGeometry();   // déformation du mesh en temps réel
            });
        }
    });

    applyDecor();
}

// ---------------------------------------------------------------------------
// SIMULATEUR DE PLONGÉE : profondeur du bassin, turbidité de l'eau,
// projecteurs LED (projecteur.glb + 2 SpotLights) et ambiance de profondeur.
// ---------------------------------------------------------------------------

// Étendue automatique : proportionnelle à la profondeur (300 m → 450 m de
// côté) avec un plancher de 100 m — supprime l'effet "tunnel/puits étroit".
function autoExtent(depth) { return Math.min(1000, Math.max(100, depth * 1.5)); }

// Applique les DIMENSIONS du bassin (profondeur ET étendue horizontale) :
// fond/relief, grille, parois, récepteur d'ombres, caméras, limites de collision.
function applyBasinSize() {
    FLOOR_Y = -diveState.depth;
    WALL_POS = Math.max(10, diveState.extent / 2);
    WALL_LIMIT = WALL_POS - 0.5;
    // Far plane couvrant profondeur ET étendue : fond et parois ne sont jamais
    // coupés au loin (le brouillard FogExp2, lui, n'a pas de "far" — c'est la
    // densité pilotée par le slider de visibilité qui borne la vue).
    const far = Math.max(100, diveState.depth * 2.5, diveState.extent * 1.8);
    camera.far = far;
    camera.updateProjectionMatrix();
    fpvCamera.far = far;
    fpvCamera.updateProjectionMatrix();
    controls.maxDistance = Math.max(25, diveState.depth * 1.5, diveState.extent * 0.9);
    // Sol plat : grille reconstruite à l'étendue + récepteur d'ombres rééchelonné
    rebuildGrid();
    if (shadowGround) {
        const s = (WALL_POS * 2) / 20;   // géométrie de base : plan de 20 m
        shadowGround.scale.set(s, s, 1);
        shadowGround.position.y = FLOOR_Y;
    }
    // Parois reconstruites aux nouvelles dimensions (surface → fond, ±WALL_POS)
    if (wallsGroup) {
        scene.remove(wallsGroup);
        wallsGroup.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
        wallsGroup = null;
    }
    // Le maillage LOURD du relief n'est PAS reconstruit ici (jusqu'à 66k
    // sommets × bruit fbm) : pendant le drag des sliders, seul le décor léger
    // suit ; la regénération complète part au relâchement (rebuildTerrainAsync).
    updateAlgaeAnchors();      // ré-ancrage sur la hauteur de relief à jour
    applyDecor();              // reconstruit les parois si activées + tiling
    _lastSunF = -1;            // force la réapplication de l'ambiance de profondeur
}

// Grille du sol plat : recréée à l'étendue courante avec des cellules lisibles
// (1 m jusqu'à 120 m d'étendue, 5 m jusqu'à 400 m, 10 m au-delà).
function rebuildGrid() {
    const ext = WALL_POS * 2;
    const wasVisible = gridHelper ? gridHelper.visible : true;
    if (gridHelper) {
        scene.remove(gridHelper);
        gridHelper.geometry.dispose();
        gridHelper.material.dispose();
    }
    const cell = ext <= 120 ? 1 : (ext <= 400 ? 5 : 10);
    gridHelper = new THREE.GridHelper(ext, Math.max(2, Math.round(ext / cell)), 0x35d0ba, 0x24304d);
    gridHelper.position.y = FLOOR_Y;
    gridHelper.material.transparent = true;
    gridHelper.visible = wasVisible;
    scene.add(gridHelper);
}

// Redistribue la faune/flore sur toute la nouvelle étendue : les points de
// spawn sont tirés dans ±WALL_LIMIT à la construction, il faut donc recréer
// les InstancedMesh. Appelé au RELÂCHEMENT des sliders (événement 'change')
// pour éviter une reconstruction par tick pendant le drag.
function rebuildLife() {
    if (algaeMesh) {
        scene.remove(algaeMesh);
        algaeMesh.geometry.dispose();
        const i = envMats.indexOf(algaeMesh.material);
        if (i >= 0) envMats.splice(i, 1);
        algaeMesh.material.dispose();
        algaeMesh = null;
        algaeData.length = 0;
    }
    if (fishMesh) {
        scene.remove(fishMesh);
        fishMesh.geometry.dispose();
        const i = envMats.indexOf(fishMesh.material);
        if (i >= 0) envMats.splice(i, 1);
        fishMesh.material.dispose();
        fishMesh = null;
        fishData.length = 0;
    }
    if (coralMeshes) {
        coralMeshes.forEach((m) => {
            scene.remove(m);
            m.geometry.dispose();
            const i = envMats.indexOf(m.material);
            if (i >= 0) envMats.splice(i, 1);
            m.material.dispose();
        });
        coralMeshes = null;
        coralData.forEach((arr) => { arr.length = 0; });
    }
    if (abyssMesh) {
        scene.remove(abyssMesh);
        scene.remove(abyssGlowMesh);
        abyssMesh.geometry.dispose();
        abyssMesh.material.dispose();
        abyssGlowMesh.geometry.dispose();
        abyssGlowMesh.material.dispose();
        abyssMesh = null;
        abyssGlowMesh = null;
        abyssData.length = 0;
    }
    if (pikeGroup) {
        scene.remove(pikeGroup);
        pikeGroup.traverse((o) => {
            if (o.isMesh) {
                o.geometry.dispose();
                const i = envMats.indexOf(o.material);
                if (i >= 0) envMats.splice(i, 1);
            }
        });
        pikeGroup = null;
        pikeData.length = 0;
    }
    applyLife();               // reconstruction paresseuse selon l'état UI
    // Recalcule ET applique le zonage TOUT DE SUITE d'après la profondeur
    // courante : les maillages fraîchement reconstruits obtiennent la bonne
    // visibilité sans attendre une frame (évite un flash « tout masqué »).
    refreshLifeZoning();
    applyLifeZoning();
    _lastSunF = -1;            // ré-applique envMapIntensity aux nouveaux matériaux
}

// Indicateur IHM "Génération du relief abyssal en cours…" (overlay HTML)
function showTerrainLoading(show) {
    const el = document.getElementById('terrain-loading');
    if (el) el.style.display = show ? 'flex' : 'none';
}

// Regénération lourde (maillage abyssal + redistribution faune/flore) au
// RELÂCHEMENT des sliders profondeur/étendue : l'indicateur est affiché
// d'abord, puis rAF + timeout laissent le navigateur peindre l'overlay avant
// le calcul bloquant de la heightmap (jusqu'à 256×256 échantillons de bruit).
function rebuildTerrainAsync() {
    if (!terrainMesh) { rebuildLife(); return; }   // sol plat : rien de lourd
    showTerrainLoading(true);
    requestAnimationFrame(() => setTimeout(() => {
        rebuildTerrainGeometry();
        rebuildLife();
        showTerrainLoading(false);
    }, 30));
}

// Densité du brouillard exponentiel d'après la visibilité souhaitée : avec
// FogExp2 (facteur exp(-(d·dist)²)), il reste ~5 % de contraste à la distance
// "visibilité" pour d = √3/visibilité.
function applyFog() {
    scene.fog.density = 1.7 / Math.max(1, diveState.visibility);
}

// État des projecteurs : intensité des 2 SpotLights + Tilt du groupe pivot
// (la géométrie projecteur.glb ET les faisceaux pivotent ensemble).
function applyLed() {
    const cd = diveState.led ? LED_MAX_INTENSITY * (diveState.ledIntensity / 100) : 0;
    projSpots.forEach((s) => { s.intensity = cd; });
    if (projGroup) {
        // Rotation autour de Z : l'avant du ROV est -X, donc tilt positif = piqué
        // du faisceau vers le fond, négatif = relevé vers la surface.
        projGroup.rotation.z = THREE.MathUtils.degToRad(diveState.ledTilt);
    }
    const iRow = document.getElementById('dive-led-intensity-row');
    const tRow = document.getElementById('dive-led-tilt-row');
    if (iRow) iRow.classList.toggle('disabled', !diveState.led);
    if (tRow) tRow.classList.toggle('disabled', !diveState.led);
}

// Crée le groupe pivot des projecteurs et les 2 SpotLights (gauche / droit) à
// des positions heuristiques sur le nez du ROV — affinées dès que la boîte
// englobante réelle de projecteur.glb est connue (fitSpotsToProjector).
function initProjectors() {
    projGroup = new THREE.Group();
    modelGroup.add(projGroup);
    const px = -(MODEL_LENGTH / 2);   // avant visuel du ROV = -X (cf. caméra FPV)
    projSpots = [
        makeProjectorSpot(px, 0.06, +0.09, +0.03),   // pod gauche (bâbord)
        makeProjectorSpot(px, 0.06, -0.09, -0.03),   // pod droit (tribord)
    ];
    applyLed();
}

// Une SpotLight de projecteur : blanc légèrement bleuté (LED sous-marine),
// cône de 26°, pénombre douce, portée 60 m. La cible est ENFANT du groupe
// pivot, placée 3 m vers l'avant (-X) avec pincement vers l'axe (convergence
// des deux faisceaux) : le Tilt du groupe oriente donc mesh + faisceaux.
function makeProjectorSpot(x, y, z, zTargetPinch) {
    const s = new THREE.SpotLight(0xdff2ff, 0, 60, THREE.MathUtils.degToRad(26), 0.45, 1.6);
    s.position.set(x - 0.01, y, z);
    s.target.position.set(x - 3.0, y - 0.35, zTargetPinch);   // léger pique initial
    projGroup.add(s);
    projGroup.add(s.target);
    return s;
}

// Charge projecteur.glb (même repère d'origine que bob_rov_3D.glb) : même
// échelle + même recentrage que le ROV, attaché au groupe pivot du Tilt pour
// que géométrie et faisceaux tournent ensemble. Appelé depuis loadModel().
function loadProjectorModel() {
    const loader = new GLTFLoader();
    loader.load(
        '/static/models/projecteur.glb',
        (gltf) => {
            const proj = gltf.scene;
            proj.scale.setScalar(rovFitScale);
            proj.position.copy(rovFitOffset);   // origine commune → il se cale seul
            proj.traverse((o) => {
                if (o.isMesh) {
                    o.castShadow = true;
                    const mats = Array.isArray(o.material) ? o.material : [o.material];
                    mats.forEach((m) => { if (m) envMats.push(m); });
                }
            });
            projGroup.add(proj);
            fitSpotsToProjector(proj);
        },
        undefined,
        (err) => {
            // Non bloquant : les SpotLights heuristiques restent opérationnelles.
            console.warn('projecteur.glb indisponible — faisceaux seuls conservés:', err);
        }
    );
}

// Replace chaque SpotLight exactement au niveau des optiques des deux pods :
// face avant (-X) de la boîte englobante du GLB, pods écartés sur ±Z, cibles
// 3 m devant avec convergence (pincement) et léger pique vers le bas.
function fitSpotsToProjector(proj) {
    const box = new THREE.Box3().setFromObject(proj);
    if (box.isEmpty()) return;
    const cy = (box.min.y + box.max.y) / 2;
    const zSpan = box.max.z - box.min.z;
    const front = box.min.x - 0.005;             // vitre des optiques (avant = -X)
    const podZ = Math.max(0.04, zSpan * 0.28);   // écartement des 2 pods
    projSpots.forEach((s, i) => {
        const side = i === 0 ? 1 : -1;
        s.position.set(front, cy, side * podZ);
        s.target.position.set(front - 3.0, cy - 0.35, side * podZ * 0.25);
    });
}

// Ambiance de profondeur (appelée chaque frame) : la lumière du jour décroît
// exponentiellement avec la profondeur du ROV. Le fond, les parois, la faune
// et le ROV (envMapIntensity) s'assombrissent — à grande profondeur, seuls
// les projecteurs LED éclairent le décor. Couleur d'eau assortie au fog.
const _SURF_COL = new THREE.Color(0x0e3a55);   // eau claire sous la surface
const _DEEP_COL = new THREE.Color(0x010409);   // abysses
const _waterCol = new THREE.Color();
let _lastSunF = -1;
let _lastEnvCount = 0;   // force un rafraîchissement quand un matériau s'ajoute

function updateDepthAmbience() {
    const depthNow = Math.max(0, -posWorld.y);
    // Pleine lumière naturelle diffuse sur le plateau corallien (0 → -20 m),
    // puis extinction exponentielle dès que le ROV bascule dans la fosse :
    // vers -55 m le noir est quasi total et SEULS les projecteurs LED
    // (projecteur.glb) éclairent la paroi rocheuse et le fond sédimentaire.
    const f = Math.exp(-Math.max(0, depthNow - REEF_DEPTH) / SUN_FADE_DEPTH);
    if (Math.abs(f - _lastSunF) < 0.002 && envMats.length === _lastEnvCount) return;
    _lastSunF = f;
    _lastEnvCount = envMats.length;
    sunDir.intensity = 1.8 * f;
    sunFill.intensity = 0.5 * f;
    sunAmbient.intensity = 0.5 * f;                // aucun plancher : noir absolu en fosse
    _waterCol.lerpColors(_DEEP_COL, _SURF_COL, f);
    scene.background.copy(_waterCol);
    scene.fog.color.copy(_waterCol);
    // L'éclairage d'environnement (IBL) suit la même extinction
    for (const m of envMats) m.envMapIntensity = f;
    if (gridHelper) gridHelper.material.opacity = Math.max(0.05, f);
}

function loadDiveSettings() {
    try {
        const d = parseFloat(localStorage.getItem(DIVE_KEYS.depth));
        const v = parseFloat(localStorage.getItem(DIVE_KEYS.visibility));
        const i = parseFloat(localStorage.getItem(DIVE_KEYS.ledIntensity));
        const t = parseFloat(localStorage.getItem(DIVE_KEYS.ledTilt));
        if (!isNaN(d)) diveState.depth = Math.min(300, Math.max(5, d));
        if (!isNaN(v)) diveState.visibility = Math.min(60, Math.max(1, v));
        if (!isNaN(i)) diveState.ledIntensity = Math.min(100, Math.max(0, i));
        if (!isNaN(t)) diveState.ledTilt = Math.min(60, Math.max(-60, t));
        diveState.led = localStorage.getItem(DIVE_KEYS.led) === '1';
        // Étendue : manuelle si le slider a déjà été touché, sinon auto (∝ profondeur)
        diveState.extentManual = localStorage.getItem(DIVE_KEYS.extentManual) === '1';
        const ex = parseFloat(localStorage.getItem(DIVE_KEYS.extent));
        if (diveState.extentManual && !isNaN(ex)) {
            diveState.extent = Math.min(1000, Math.max(20, ex));
        } else {
            diveState.extentManual = false;
            diveState.extent = autoExtent(diveState.depth);
        }
    } catch (e) { /* localStorage indisponible : valeurs par défaut */ }
    // Dimensions effectives AVANT initScene / buildFish / buildAlgae
    FLOOR_Y = -diveState.depth;
    WALL_POS = Math.max(10, diveState.extent / 2);
    WALL_LIMIT = WALL_POS - 0.5;
}

function bindDiveControls() {
    const sd = document.getElementById('dive-depth');
    const se = document.getElementById('dive-extent');
    const sv = document.getElementById('dive-visibility');
    const cl = document.getElementById('dive-led');
    const si = document.getElementById('dive-led-intensity');
    const st = document.getElementById('dive-led-tilt');
    const vd = document.getElementById('dive-depth-val');
    const ve = document.getElementById('dive-extent-val');
    const vv = document.getElementById('dive-visibility-val');
    const vi = document.getElementById('dive-led-intensity-val');
    const vt = document.getElementById('dive-led-tilt-val');
    if (!sd || !sv || !cl) return;
    const save = (k, v) => { try { localStorage.setItem(DIVE_KEYS[k], v); } catch (e) { /* ignoré */ } };

    // Refléter l'état chargé (localStorage) sur les widgets
    sd.value = diveState.depth;
    if (se) se.value = diveState.extent;
    sv.value = diveState.visibility;
    cl.checked = diveState.led;
    if (si) si.value = diveState.ledIntensity;
    if (st) st.value = diveState.ledTilt;
    const render = () => {
        if (vd) vd.textContent = Math.round(diveState.depth) + ' m';
        if (ve) ve.textContent = Math.round(diveState.extent) + ' m' + (diveState.extentManual ? '' : ' (auto)');
        if (vv) vv.textContent = Math.round(diveState.visibility) + ' m';
        if (vi) vi.textContent = Math.round(diveState.ledIntensity) + '%';
        if (vt) vt.textContent = (diveState.ledTilt > 0 ? '+' : '') + Math.round(diveState.ledTilt) + '°';
    };

    sd.addEventListener('input', () => {
        diveState.depth = parseFloat(sd.value);
        // Tant que l'étendue n'a pas été fixée à la main, elle suit la profondeur
        if (!diveState.extentManual) {
            diveState.extent = autoExtent(diveState.depth);
            if (se) se.value = diveState.extent;
        }
        render();
        save('depth', sd.value);
        applyBasinSize();
    });
    sd.addEventListener('change', rebuildTerrainAsync);   // relief + faune au relâchement
    if (se) {
        se.addEventListener('input', () => {
            diveState.extentManual = true;        // le slider prend la main sur l'auto
            diveState.extent = parseFloat(se.value);
            render();
            save('extent', se.value);
            save('extentManual', '1');
            applyBasinSize();
        });
        se.addEventListener('change', rebuildTerrainAsync);
    }
    sv.addEventListener('input', () => {
        diveState.visibility = parseFloat(sv.value);
        render();
        save('visibility', sv.value);
        applyFog();
    });
    cl.addEventListener('change', () => {
        setLightUI(cl.checked);   // synchronise aussi le bouton 💡 du panneau ACTIONS
        save('led', cl.checked ? '1' : '0');
    });
    if (si) si.addEventListener('input', () => {
        diveState.ledIntensity = parseFloat(si.value);
        render();
        save('ledIntensity', si.value);
        applyLed();
    });
    if (st) st.addEventListener('input', () => {
        diveState.ledTilt = parseFloat(st.value);
        render();
        save('ledTilt', st.value);
        applyLed();
    });

    render();
    applyBasinSize();
    applyFog();
    applyLed();
}

// ---------------------------------------------------------------------------
// HORIZON ARTIFICIEL (HUD / OSD) : sphère d'attitude roll/pitch sur Canvas 2D
// + cap (yaw 0-360°) et profondeur sous la surface au centre du widget.
// ---------------------------------------------------------------------------
const HORIZON_SIZE = 182;              // côté CSS du canvas (px)
const HORIZON_PX_PER_RAD = 95;         // défilement vertical de l'échelle de pitch

function initHorizon() {
    const cv = document.getElementById('horizon-canvas');
    if (!cv) return;
    // Ratio de pixels COMPLET (Retina/4K, zoom navigateur inclus) : le canvas ne
    // fait que 182 px CSS, le surcoût d'un buffer ×2/×3 est négligeable et le
    // texte du HUD (cap, profondeur, graduations) reste parfaitement net.
    horizonDpr = window.devicePixelRatio || 1;
    cv.width = Math.round(HORIZON_SIZE * horizonDpr);
    cv.height = Math.round(HORIZON_SIZE * horizonDpr);
    cv.style.width = HORIZON_SIZE + 'px';
    cv.style.height = HORIZON_SIZE + 'px';
    horizonCtx = cv.getContext('2d');
    // setTransform (et non scale cumulatif) : la ré-initialisation est
    // idempotente quand le ratio change (zoom, fenêtre déplacée d'écran).
    horizonCtx.setTransform(horizonDpr, 0, 0, horizonDpr, 0, 0);
    horizonCtx.imageSmoothingEnabled = true;   // AA propre des arcs/rotations
}

function updateHorizon() {
    // Netteté suivie en continu : si le ratio de pixels a changé depuis l'init
    // (zoom navigateur, écran externe), ré-échantillonner le buffer d'abord.
    if (horizonCtx && (window.devicePixelRatio || 1) !== horizonDpr) initHorizon();
    const ctx = horizonCtx;
    if (!ctx) return;
    const S = HORIZON_SIZE, c = S / 2, R = c - 6;
    ctx.clearRect(0, 0, S, S);

    // --- Sphère d'horizon (ciel/mer) tournée en roulis, décalée en tangage ---
    // CORRECTION inversion tangage/roulis : le nez visuel du GLB pointe vers -X
    // (cf. caméra FPV), l'axe LONGITUDINAL du ROV est donc X et l'axe
    // TRANSVERSAL est Z. Sur le modèle (rotation.set(pitch, yaw, -roll)) :
    //   · rotation.x (= current.pitch) fait visuellement GÎTER le ROV (roulis),
    //     signe : current.pitch > 0 = gîte à gauche ;
    //   · rotation.z (= -current.roll) fait visuellement CABRER/PIQUER (tangage),
    //     signe : current.roll > 0 = nez vers le haut.
    const hudRoll  = -current.pitch;   // roulis aviation : positif = penche à droite
    const hudPitch =  current.roll;    // tangage : positif = nez vers le haut
    ctx.save();
    ctx.beginPath();
    ctx.arc(c, c, R, 0, Math.PI * 2);
    ctx.clip();
    ctx.translate(c, c);
    // Canvas : y vers le bas → rotate(-hudRoll) fait pivoter l'horizon en sens
    // ANTI-HORAIRE quand le ROV penche à droite (hudRoll positif). La rotation
    // canvas étant 2π-périodique, le roulis est illimité (tonneaux enchaînés).
    ctx.rotate(-hudRoll);
    // Tangage CYCLIQUE 360° : le fond ciel/mer est une bande périodique de
    // période 2π·K px (= 360° de tangage). Au-delà de ±90° le ciel bascule,
    // à ±180° le ROV est sur le dos (mer au-dessus) — la transition
    // 180° → -180° est invisible car wrapPi décale d'exactement une période.
    const K = HORIZON_PX_PER_RAD;
    const PK = Math.PI * K;                    // 180° de tangage en pixels
    const py = wrapPi(hudPitch) * K;           // position de l'horizon "à l'endroit"
    for (let k = -1; k <= 1; k++) {
        const yh = py + k * 2 * PK;            // horizons 0° ± k·360°
        ctx.fillStyle = '#2c6dd5';             // ciel : tangage dans (0°, +180°)
        ctx.fillRect(-S, yh - PK, S * 2, PK);
        ctx.fillStyle = '#173a5e';             // mer : tangage dans (-180°, 0°)
        ctx.fillRect(-S, yh, S * 2, PK);
    }
    // Lignes d'horizon (une par période visible)
    ctx.strokeStyle = '#e6ecff';
    ctx.lineWidth = 1.6;
    for (let k = -1; k <= 1; k++) {
        const yh = py + k * 2 * PK;
        if (Math.abs(yh) > R + 2) continue;
        ctx.beginPath();
        ctx.moveTo(-R, yh);
        ctx.lineTo(R, yh);
        ctx.stroke();
    }
    // Échelle de tangage cyclique : graduations tous les 10° sur toute la bande
    // visible, étiquettes en convention "boule" (0→90° puis 80→30→0 en vol
    // inversé), ce qui reste juste après un looping complet.
    ctx.strokeStyle = 'rgba(230, 236, 255, 0.75)';
    ctx.fillStyle = 'rgba(230, 236, 255, 0.75)';
    ctx.lineWidth = 1;
    ctx.font = '8px system-ui, sans-serif';
    ctx.textAlign = 'center';
    for (let deg = -360; deg <= 360; deg += 10) {
        if (deg % 180 === 0) continue;         // les horizons ont déjà leur ligne
        const y = py - THREE.MathUtils.degToRad(deg) * K;
        if (Math.abs(y) > R - 6) continue;     // hors du disque
        const q = Math.abs(((deg % 360) + 540) % 360 - 180);   // écart à ±180° : 0..180
        const lbl = (180 - q) <= 90 ? 180 - q : q;             // 0..90 style boule
        const w = (deg % 20 === 0) ? 26 : 15;
        ctx.beginPath();
        ctx.moveTo(-w / 2, y);
        ctx.lineTo(w / 2, y);
        ctx.stroke();
        if (deg % 20 === 0) ctx.fillText(String(lbl), w / 2 + 10, y + 2.5);
    }
    ctx.restore();

    // --- Maquette fixe (ailes jaunes, style aéronautique) ---
    ctx.strokeStyle = '#ffd23e';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(c - 34, c); ctx.lineTo(c - 12, c); ctx.lineTo(c - 6, c + 6);
    ctx.moveTo(c + 34, c); ctx.lineTo(c + 12, c); ctx.lineTo(c + 6, c + 6);
    ctx.stroke();
    ctx.fillStyle = '#ffd23e';
    ctx.fillRect(c - 1.5, c - 1.5, 3, 3);

    // --- Cercle extérieur + repère zénith ---
    ctx.strokeStyle = '#24304d';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(c, c, R, 0, Math.PI * 2);
    ctx.stroke();

    // --- Cap (yaw) en haut, profondeur en bas : cartouches lisibles ---
    const heading = ((Math.round(-THREE.MathUtils.radToDeg(current.yaw)) % 360) + 360) % 360;
    const depthNow = Math.max(0, -posWorld.y);
    ctx.font = 'bold 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(8, 12, 24, 0.72)';
    ctx.fillRect(c - 30, 10, 60, 15);
    ctx.fillRect(c - 38, S - 26, 76, 15);
    ctx.fillStyle = '#35d0ba';
    ctx.fillText('CAP ' + String(heading).padStart(3, '0') + '°', c, 21.5);
    ctx.fillText('PROF ' + depthNow.toFixed(1) + ' m', c, S - 14.5);
}

// ---------------------------------------------------------------------------
// VIE SOUS-MARINE : algues ondulantes + banc de poissons (paramétrables via UI)
// Rendu en InstancedMesh (1 draw call par espèce) pour rester fluide sur RPI5.
// ---------------------------------------------------------------------------
const ALGAE_MAX_TUFTS = 500;   // capacité (patchs d'algues) — .count suit la surface
const ALGAE_BLADES    = 5;     // brins par bouquet (1 bouquet = 1 point d'ancrage)
const FISH_MAX        = 500;   // borne haute du banc de récif (dense et foisonnant)
const FISH_SCARE_DIST = 2.2;   // distance ROV déclenchant l'effarouchement (m)
const FISH_SCHOOLS    = 8;     // nombre de bancs distincts répartis sur le plateau
const LIFE_SPAWN_GUARD = 2.0;  // rayon libre autour du point de départ du ROV (m)
// Récif DENSE piloté par la SURFACE du plateau (éléments/m²), plafonné par la
// capacité des InstancedMesh (garde-fou FPS RPi5). 4 espèces de fond fixe :
//   0 branches · 1 dômes · 2 anémones · 3 tapis encroûtant (couvre-sol).
const CORAL_CAP    = [500, 400, 500, 1400];    // capacité par espèce
const CORAL_PER_M2 = [0.10, 0.06, 0.10, 0.90]; // densité/m² à "densité récif" = 100 %
const ALGAE_PER_M2 = 0.22;                     // patchs d'algues/m² (× slider algues)
const ABYSS_MAX          = 36; // créatures bioluminescentes de la fosse
const PIKE_COUNT         = 2;  // brochets abyssaux géants (~1 m, 2× le ROV)

const lifeState = {
    algae: false, algaeCount: 40, algaeLen: 1.0, current: 0.5,
    fish: false, fishCount: 360, fishSpeed: 1.0,
    reefDensity: 0.8, abyssDensity: 0.6,
};
const LIFE_KEYS = {
    algae: 'mapping3d.algae', algaeCount: 'mapping3d.algaeCount', algaeLen: 'mapping3d.algaeLen',
    current: 'mapping3d.current',
    fish: 'mapping3d.fish', fishCount: 'mapping3d.fishCount', fishSpeed: 'mapping3d.fishSpeed',
    reefDensity: 'mapping3d.reefDensity', abyssDensity: 'mapping3d.abyssDensity',
};

// Ondulation des algues calculée en VERTEX SHADER (zéro coût CPU) : uniforms
// partagés injectés dans le MeshStandardMaterial via onBeforeCompile.
const algaeUniforms = { uTime: { value: 0 }, uSway: { value: lifeState.current } };

// PRNG déterministe (mulberry32) : même distribution d'algues / poissons à
// chaque session, sans dépendre de Math.random.
function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Tirage d'un point (x, z) sur le fond, hors zone de départ du ROV et en
// retrait des parois de collision.
function randomFloorPoint(rng, margin) {
    let x, z;
    do {
        x = (rng() * 2 - 1) * (WALL_LIMIT - margin);
        z = (rng() * 2 - 1) * (WALL_LIMIT - margin);
    } while (Math.hypot(x, z) < LIFE_SPAWN_GUARD);
    return { x, z };
}

// Tirage d'un point sur le PLATEAU RÉCIFAL (hors fosse abyssale). Sans relief
// (sol plat), tout point du bassin convient : la bande 0 / -20 m est gérée
// verticalement par les nageurs eux-mêmes.
function randomReefPoint(rng, margin) {
    for (let k = 0; k < 24; k++) {
        const p = randomFloorPoint(rng, margin);
        if (!decorState.terrain) return p;
        if (terrainHeightAt(p.x, p.z) > -REEF_DEPTH - 1.5) return p;
    }
    return randomFloorPoint(rng, margin);   // sécurité (plateau introuvable)
}

// Surface du PLATEAU corallien (couronne entre la paroi et la fosse), en m² :
// sert à dimensionner la vie AU MÈTRE CARRÉ (densité constante quelle que soit
// la taille du bassin — anti-désertification).
function reefPlateauArea() {
    const R = Math.max(1, WALL_LIMIT);
    const rPit = (FLOOR_Y < -REEF_DEPTH - 1) ? Math.min(R, WALL_POS * PIT_RADIUS_K) : 0;
    return Math.max(1, Math.PI * (R * R - rPit * rPit));
}

// Nombre d'instances cible = surface × densité/m² × facteur, plafonné par la
// capacité de l'InstancedMesh (le plafond est le vrai garde-fou FPS).
function reefCount(perM2, cap, densFactor) {
    return Math.min(cap, Math.max(0, Math.round(reefPlateauArea() * perM2 * densFactor)));
}

// Répartition en PATCHS/CLUSTERS : K centres de récif tirés sur le plateau, puis
// chaque instance rattachée à un centre ALÉATOIRE (⇒ tout préfixe d'instances
// reste spatialement représentatif : le slider densité peut réduire .count sans
// créer de trou). Concentration vers le centre du patch (aspect "massif").
function scatterReefClusters(rng, cap, margin, clusterR) {
    const K = Math.max(6, Math.round(cap / 25));
    const centers = [];
    for (let k = 0; k < K; k++) centers.push(randomReefPoint(rng, margin + clusterR));
    const lim = WALL_LIMIT - margin;
    const pts = [];
    for (let i = 0; i < cap; i++) {
        const c = centers[(rng() * K) | 0];
        const a = rng() * Math.PI * 2;
        const r = Math.pow(rng(), 0.6) * clusterR;   // densité plus forte au cœur
        pts.push({
            x: THREE.MathUtils.clamp(c.x + Math.cos(a) * r, -lim, lim),
            z: THREE.MathUtils.clamp(c.z + Math.sin(a) * r, -lim, lim),
        });
    }
    return pts;
}

// Sphère englobante du plateau : permet un FRUSTUM CULLING correct au niveau du
// batch (l'InstancedMesh entier est sauté quand tout le récif sort du champ,
// ex. plongée verticale dans la fosse) sans jamais masquer à tort une instance.
function reefBoundingSphere() {
    return new THREE.Sphere(
        new THREE.Vector3(0, -REEF_DEPTH * 0.5, 0),
        Math.hypot(WALL_POS, REEF_DEPTH) + 3);
}

// --- ALGUES -----------------------------------------------------------------
// Brins = rubans plats (plan 1×6 segments, base en y=0, hauteur unitaire) mis
// à l'échelle par instance. Le sommet ondule en shader : déplacement ∝ y²
// (base fixe ancrée au sol), phase dérivée de la position d'instance.
const algaeData = [];   // par brin : { x, z, ry, h } (l'ancrage y est recalculé)
const _lifeM4 = new THREE.Matrix4();
const _lifeQ = new THREE.Quaternion();
const _lifeQ2 = new THREE.Quaternion();
const _lifeV = new THREE.Vector3();
const _lifeScl = new THREE.Vector3();
const _Y_AXIS = new THREE.Vector3(0, 1, 0);
const _Z_AXIS = new THREE.Vector3(0, 0, 1);

function buildAlgae() {
    const geo = new THREE.PlaneGeometry(0.09, 1, 1, 6);
    geo.translate(0, 0.5, 0);   // base du ruban sur y=0 (point d'ancrage)
    const mat = new THREE.MeshStandardMaterial({
        color: 0x2e8b4f, roughness: 0.85, metalness: 0.0, side: THREE.DoubleSide,
    });
    envMats.push(mat);
    mat.onBeforeCompile = (shader) => {
        shader.uniforms.uTime = algaeUniforms.uTime;
        shader.uniforms.uSway = algaeUniforms.uSway;
        shader.vertexShader = 'uniform float uTime;\nuniform float uSway;\n' +
            shader.vertexShader.replace('#include <begin_vertex>', `
                #include <begin_vertex>
                {
                    float hFrac = clamp(position.y, 0.0, 1.0);
                    float ph = 0.0;
                    #ifdef USE_INSTANCING
                        ph = instanceMatrix[3][0] * 1.7 + instanceMatrix[3][2] * 2.3;
                    #endif
                    float w = uTime * (0.8 + uSway * 2.4) + ph;
                    float sw = sin(w) * uSway * 0.45 * hFrac * hFrac;
                    transformed.x += sw;
                    transformed.z += 0.6 * sw * sin(w * 0.63 + 1.7);
                }`);
    };

    const rng = mulberry32(1337);
    algaeMesh = new THREE.InstancedMesh(geo, mat, ALGAE_MAX_TUFTS * ALGAE_BLADES);
    algaeMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Culling au niveau du batch : sphère englobant tout le plateau (le sommet
    // ondule en shader d'au plus ~0.5 m, largement couvert par le padding).
    geo.boundingSphere = reefBoundingSphere();
    algaeMesh.frustumCulled = true;
    const cTint = new THREE.Color();
    let idx = 0;
    // Bouquets groupés en patchs sur le plateau (rayon de patch ~ 8 % de l'étendue)
    const centers = scatterReefClusters(rng, ALGAE_MAX_TUFTS, 0.6, Math.max(1.5, WALL_POS * 0.16));
    for (let t = 0; t < ALGAE_MAX_TUFTS; t++) {
        const p = centers[t];
        for (let b = 0; b < ALGAE_BLADES; b++) {
            const a = rng() * Math.PI * 2;
            const r = rng() * 0.28;   // dispersion des brins dans le bouquet
            algaeData.push({
                x: p.x + Math.cos(a) * r,
                z: p.z + Math.sin(a) * r,
                ry: rng() * Math.PI * 2,   // orientation aléatoire 360°
                h: 0.5 + rng() * 1.0,   // hauteur du brin : 0.5 à 1.5 m
            });
            // Légère variation de teinte vert/olive par brin
            cTint.setHSL(0.30 + rng() * 0.10, 0.55, 0.28 + rng() * 0.14);
            algaeMesh.setColorAt(idx++, cTint);
        }
    }
    scene.add(algaeMesh);
    updateAlgaeAnchors();
}

// (Ré)ancre chaque brin sur le fond courant : sol plat ou relief rocheux.
// La hauteur affichée = hauteur aléatoire du brin × slider "Longueur des algues"
// (le mélange petits/grands brins est donc conservé à toutes les longueurs).
// Appelé à la création, au toggle du relief et aux sliders hauteur/longueur.
function updateAlgaeAnchors() {
    if (!algaeMesh) return;
    for (let i = 0; i < algaeData.length; i++) {
        const d = algaeData[i];
        const y = terrainMeshHeightAt(d.x, d.z);
        _lifeQ.setFromAxisAngle(_Y_AXIS, d.ry);
        _lifeM4.compose(_lifeV.set(d.x, y - 0.02, d.z), _lifeQ, _lifeScl.set(1, d.h * lifeState.algaeLen, 1));
        algaeMesh.setMatrixAt(i, _lifeM4);
    }
    algaeMesh.instanceMatrix.needsUpdate = true;
    updateCoralAnchors();   // les coraux suivent les mêmes événements de ré-ancrage
}

// --- CORAUX & ANÉMONES DU RÉCIF ---------------------------------------------
// 4 espèces low-poly (branches, dômes, anémones, tapis encroûtant) = 4
// InstancedMesh (4 draw calls), couleurs vives par instance, rotation 360° et
// échelle variée ; quantité pilotée par la SURFACE du plateau (densité au m²).
const coralData = [[], [], [], []];   // par espèce : { x, z, ry, s }

function buildCoralGeometries() {
    // Espèce 0 : corail branchu — éventail de 6 cônes fins fusionnés
    const branches = [];
    for (let i = 0; i < 6; i++) {
        const g = new THREE.ConeGeometry(0.022 + (i % 3) * 0.008, 0.34 + (i % 4) * 0.11, 5);
        g.translate(0, 0.17 + (i % 4) * 0.055, 0);
        g.rotateZ((i / 6) * 1.5 - 0.75);
        g.rotateY(i * 2.4);
        branches.push(g);
    }
    // Espèce 1 : corail-cerveau — dôme hémisphérique posé au sol
    const dome = new THREE.SphereGeometry(0.17, 8, 5, 0, Math.PI * 2, 0, Math.PI / 2);
    // Espèce 2 : anémone — socle cylindrique + couronne de 8 tentacules souples
    const parts = [new THREE.CylinderGeometry(0.07, 0.095, 0.08, 7)];
    parts[0].translate(0, 0.04, 0);
    for (let i = 0; i < 8; i++) {
        const t = new THREE.ConeGeometry(0.016, 0.17, 4);
        t.translate(0, 0.16, 0);
        t.rotateX(0.55);              // tentacules évasés vers l'extérieur
        t.rotateY((i / 8) * Math.PI * 2);
        parts.push(t);
    }
    // Espèce 3 : TAPIS encroûtant — galette basse (couvre-sol dense, très légère)
    const carpet = new THREE.SphereGeometry(0.22, 6, 2, 0, Math.PI * 2, 0, Math.PI / 2);
    carpet.scale(1, 0.13, 1);
    return [mergeGeometries(branches), dome, mergeGeometries(parts), carpet];
}

function buildCorals() {
    const geos = buildCoralGeometries();
    const palettes = [
        [0xff4f3a, 0xff8c1a, 0xd94fff, 0x58ff6e],   // branches : rouge / orange / violet / vert fluo
        [0xb05cff, 0xff7a4d, 0x39d98a, 0xffc93a],   // dômes
        [0x3ae0c2, 0xff5ca8, 0x8f6bff, 0x7dff3d],   // anémones
        [0xc94f6d, 0x6f9f46, 0xcf7a3a, 0x7d54c0, 0x3f9e86],   // tapis : coraux encroûtants + algues plates
    ];
    const cTint = new THREE.Color();
    coralMeshes = geos.map((geo, t) => {
        geo.computeVertexNormals();
        geo.boundingSphere = reefBoundingSphere();   // culling correct au niveau du batch
        const mat = new THREE.MeshStandardMaterial({ roughness: 0.8, metalness: 0.0, flatShading: true });
        envMats.push(mat);
        const mesh = new THREE.InstancedMesh(geo, mat, CORAL_CAP[t]);
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.frustumCulled = true;
        const rng = mulberry32(9100 + t * 37);
        // Patchs serrés ; le tapis (t=3) s'étale plus large et bas pour couvrir le sol
        const clusterR = (t === 3) ? Math.max(2, WALL_POS * 0.22) : Math.max(1.2, WALL_POS * 0.12);
        const pts = scatterReefClusters(rng, CORAL_CAP[t], 0.6, clusterR);
        for (let i = 0; i < CORAL_CAP[t]; i++) {
            const p = pts[i];
            const s = (t === 3) ? 0.6 + rng() * 1.4 : 0.7 + rng() * 1.5;   // échelle variée
            coralData[t].push({ x: p.x, z: p.z, ry: rng() * Math.PI * 2, s });
            cTint.setHex(palettes[t][i % palettes[t].length])
                .offsetHSL((rng() - 0.5) * 0.06, 0, (rng() - 0.5) * 0.12);
            mesh.setColorAt(i, cTint);
        }
        scene.add(mesh);
        return mesh;
    });
    updateCoralAnchors();
}

// (Ré)ancre les coraux sur le plateau ; ceux tombés dans la fosse après un
// changement d'étendue/profondeur sont masqués (échelle quasi nulle).
function updateCoralAnchors() {
    if (!coralMeshes) return;
    coralMeshes.forEach((mesh, t) => {
        for (let i = 0; i < coralData[t].length; i++) {
            const d = coralData[t][i];
            const y = terrainMeshHeightAt(d.x, d.z);   // hauteur EXACTE du maillage rendu
            const onReef = !decorState.terrain || y > -REEF_DEPTH - 1.5;
            if (onReef) {
                // Axe vertical du corail aligné sur la normale du relief : il
                // « pousse » perpendiculairement à la roche, puis azimut aléatoire.
                const nrm = terrainNormalAt(d.x, d.z);
                _lifeQ.setFromUnitVectors(_Y_AXIS, nrm);
                _lifeQ2.setFromAxisAngle(_Y_AXIS, d.ry);
                _lifeQ.multiply(_lifeQ2);
                _lifeM4.compose(_lifeV.set(d.x, y - 0.02, d.z), _lifeQ, _lifeScl.setScalar(d.s));
            } else {
                // Tombé dans la fosse (hors plateau) : masqué (échelle quasi nulle).
                _lifeQ.setFromAxisAngle(_Y_AXIS, d.ry);
                _lifeM4.compose(_lifeV.set(d.x, y - 0.01, d.z), _lifeQ, _lifeScl.setScalar(0.0001));
            }
            mesh.setMatrixAt(i, _lifeM4);
        }
        mesh.instanceMatrix.needsUpdate = true;
    });
}

// --- POISSONS DE RÉCIF --------------------------------------------------------
// Modèle low-poly détaillé (corps + caudale + dorsale + pectorales + yeux) via
// vertex colors : les yeux restent sombres et les nageoires claires quelle que
// soit la teinte vive de l'instance (vColor = couleur sommet × couleur instance).
// Nage en BANCS (10 poissons par ancrage autour des coraux) + fuite du ROV.
const fishData = [];   // par poisson : { pos, dir, wander, timer, phase, size, flee, home }

// Attribut couleur constant sur toute une géométrie (avant fusion)
function paintGeometry(geo, hex) {
    const c = new THREE.Color(hex);
    const n = geo.attributes.position.count;
    const arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
    geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    return geo;
}

function buildFishGeometry() {
    // Corps : sphère basse définition étirée en fuseau (nez vers +Z), blanc =
    // prend intégralement la couleur vive de l'instance
    const body = new THREE.SphereGeometry(0.055, 6, 5);
    body.scale(0.55, 0.85, 1.8);
    paintGeometry(body, 0xffffff);
    // Caudale : pointe vers le corps, base (bord large) à l'arrière (-Z)
    const tail = new THREE.ConeGeometry(0.045, 0.09, 4);
    tail.rotateX(Math.PI / 2);
    tail.scale(0.35, 1, 1);
    tail.translate(0, 0, -0.12);
    paintGeometry(tail, 0xdff0f2);          // nageoires claires
    // Dorsale : aileron triangulaire sur le dos
    const dorsal = new THREE.ConeGeometry(0.03, 0.05, 3);
    dorsal.scale(0.3, 1, 1.6);
    dorsal.translate(0, 0.056, -0.01);
    paintGeometry(dorsal, 0xdff0f2);
    // Pectorales : deux petits ailerons latéraux
    const finL = new THREE.ConeGeometry(0.022, 0.05, 3);
    finL.rotateZ(Math.PI / 2);
    finL.scale(1, 0.25, 1.4);
    finL.translate(0.036, -0.008, 0.03);
    paintGeometry(finL, 0xdff0f2);
    const finR = new THREE.ConeGeometry(0.022, 0.05, 3);
    finR.rotateZ(-Math.PI / 2);
    finR.scale(1, 0.25, 1.4);
    finR.translate(-0.036, -0.008, 0.03);
    paintGeometry(finR, 0xdff0f2);
    // Yeux : deux billes quasi noires de part et d'autre de la tête
    const eyeL = new THREE.SphereGeometry(0.011, 5, 4);
    eyeL.translate(0.026, 0.016, 0.074);
    paintGeometry(eyeL, 0x0c1013);
    const eyeR = new THREE.SphereGeometry(0.011, 5, 4);
    eyeR.translate(-0.026, 0.016, 0.074);
    paintGeometry(eyeR, 0x0c1013);
    const merged = mergeGeometries([body, tail, dorsal, finL, finR, eyeL, eyeR]);
    merged.computeVertexNormals();
    return merged;
}

function buildFish() {
    const mat = new THREE.MeshStandardMaterial({
        roughness: 0.6, metalness: 0.1, flatShading: true, vertexColors: true,
    });
    envMats.push(mat);
    fishMesh = new THREE.InstancedMesh(buildFishGeometry(), mat, FISH_MAX);
    fishMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    fishMesh.frustumCulled = false;   // instances mobiles dans tout le volume
    const rng = mulberry32(4242);
    // Livrée vive : poisson-clown, chirurgien bleu, jaune citron, orange, cyan…
    const palette = [0xff7818, 0x2e6bff, 0xffd41e, 0xff9a3d, 0x27d0e8, 0xff5540];
    const cTint = new THREE.Color();
    // 5-10 bancs distincts répartis sur TOUT le plateau récifal, ancrés sur le
    // relief (leur hauteur suit la roche 0 / -20 m ; bande de nage gérée plus bas).
    const homes = [];
    for (let s = 0; s < FISH_SCHOOLS; s++) {
        const hp = randomReefPoint(rng, 1.2);
        const hy = terrainMeshHeightAt(hp.x, hp.z);
        homes.push(new THREE.Vector3(hp.x,
            THREE.MathUtils.clamp(hy + 2.0, -REEF_DEPTH + 2.0, -2.5), hp.z));
    }
    for (let i = 0; i < FISH_MAX; i++) {
        // Round-robin : tout préfixe de .count couvre les N bancs, donc réduire
        // la densité éclaircit chaque banc au lieu d'en faire disparaître.
        const schoolHome = homes[i % FISH_SCHOOLS];
        const a = rng() * Math.PI * 2;
        fishData.push({
            pos: schoolHome.clone().add(_lifeV.set((rng() - 0.5) * 3.4, (rng() - 0.5) * 2.2, (rng() - 0.5) * 3.4)),
            dir: new THREE.Vector3(Math.cos(a), 0, Math.sin(a)),
            wander: new THREE.Vector3(Math.cos(a), 0, Math.sin(a)),
            timer: rng() * 3,          // compte à rebours avant nouveau cap d'errance
            phase: rng() * Math.PI * 2,
            size: 0.75 + rng() * 0.6,  // échelle individuelle (poissons ~13-24 cm)
            flee: 0,                   // 0..1 : niveau d'effarouchement (lissé)
            home: schoolHome,          // cœur du banc (référence partagée)
        });
        cTint.setHex(palette[i % palette.length]).offsetHSL((rng() - 0.5) * 0.05, 0, (rng() - 0.5) * 0.1);
        fishMesh.setColorAt(i, cTint);
        // Matrice INITIALE : place chaque poisson à sa position de banc avec une
        // échelle réelle (× taille). Sans cela, les instances neuves d'un
        // InstancedMesh gardent une matrice NULLE (échelle 0 → invisibles)
        // jusqu'à la 1re frame d'updateFish. Au redimensionnement, un banc
        // reconstruit dont l'animation n'a pas encore tourné (ou masqué une
        // frame par le zonage) resterait « écrasé » à l'origine et disparaîtrait.
        const fi = fishData[i];
        _lifeQ.setFromUnitVectors(_Z_AXIS, fi.dir);
        _lifeM4.compose(fi.pos, _lifeQ, _lifeScl.setScalar(fi.size));
        fishMesh.setMatrixAt(i, _lifeM4);
    }
    fishMesh.instanceMatrix.needsUpdate = true;
    scene.add(fishMesh);
}

const _steer = new THREE.Vector3();
const _fleeV = new THREE.Vector3();

function updateFish(dt, time) {
    if (!fishMesh || !fishMesh.visible) return;
    const activity = lifeState.fishSpeed;   // slider "Vitesse / Activité"
    const n = Math.min(fishMesh.count, fishData.length);
    for (let i = 0; i < n; i++) {
        const f = fishData[i];

        // 1) Errance : nouveau cap aléatoire toutes les 2 à 5 s (module par l'activité)
        f.timer -= dt * (0.5 + activity * 0.5);
        if (f.timer <= 0) {
            f.timer = 2 + Math.random() * 3;
            const a = Math.random() * Math.PI * 2;
            f.wander.set(Math.cos(a), (Math.random() - 0.5) * 0.5, Math.sin(a)).normalize();
        }
        _steer.copy(f.wander);

        // 2) Évitement des parois, du fond (relief inclus) et de la surface
        if (f.pos.x >  WALL_LIMIT - 1.5) _steer.x -= (f.pos.x - (WALL_LIMIT - 1.5));
        if (f.pos.x < -WALL_LIMIT + 1.5) _steer.x += ((-WALL_LIMIT + 1.5) - f.pos.x);
        if (f.pos.z >  WALL_LIMIT - 1.5) _steer.z -= (f.pos.z - (WALL_LIMIT - 1.5));
        if (f.pos.z < -WALL_LIMIT + 1.5) _steer.z += ((-WALL_LIMIT + 1.5) - f.pos.z);
        const floorLim = floorLimitAt(f.pos.x, f.pos.z) + 0.35;
        if (f.pos.y < floorLim) _steer.y += (floorLim - f.pos.y) * 2.0;
        if (f.pos.y > CEIL_Y - 1.0) _steer.y -= (f.pos.y - (CEIL_Y - 1.0)) * 2.0;
        // Bande récifale : le banc reste entre la surface et le plateau (-20 m)
        if (f.pos.y < -REEF_DEPTH + 1.5) _steer.y += ((-REEF_DEPTH + 1.5) - f.pos.y) * 1.5;

        // 2bis) Cohésion de banc : rappel doux vers le cœur du banc (les poissons
        // orbitent ainsi en groupe autour des coraux au lieu de se disperser)
        const dHome = f.pos.distanceTo(f.home);
        if (dHome > 2.5) {
            _fleeV.copy(f.home).sub(f.pos).normalize();
            _steer.addScaledVector(_fleeV, Math.min(1.4, (dHome - 2.5) * 0.35));
        }

        // 3) Effarouchement : fuite du ROV sous 2,2 m, avec légère accélération
        const dRov = f.pos.distanceTo(posWorld);
        if (dRov < FISH_SCARE_DIST) {
            _fleeV.copy(f.pos).sub(posWorld).normalize().multiplyScalar(3.0 * (1 - dRov / FISH_SCARE_DIST) + 1.0);
            _steer.add(_fleeV);
            f.flee = Math.min(1, f.flee + dt * 4);
        } else {
            f.flee = Math.max(0, f.flee - dt * 0.8);   // retour au calme progressif
        }

        // 4) Virage lissé vers le cap désiré (les poissons effrayés virent plus sec)
        _steer.normalize();
        f.dir.lerp(_steer, Math.min(1, dt * (1.5 + activity + f.flee * 4))).normalize();
        f.dir.y = THREE.MathUtils.clamp(f.dir.y, -0.4, 0.4);   // assiette naturelle

        // 5) Avance : vitesse de croisière × activité × boost de fuite (+60 % max)
        const speed = 0.35 * f.size * activity * (1 + f.flee * 0.6);
        f.pos.addScaledVector(f.dir, speed * dt);

        // 6) Orientation + frétillement caudal : oscillation de lacet dont la
        // fréquence suit la vitesse de nage (battement plus rapide en fuite)
        _lifeQ.setFromUnitVectors(_Z_AXIS, f.dir);
        const wig = Math.sin(time * (6 + activity * 4 + f.flee * 6) + f.phase) * 0.18;
        _lifeQ2.setFromAxisAngle(_Y_AXIS, wig);
        _lifeQ.multiply(_lifeQ2);
        _lifeM4.compose(f.pos, _lifeQ, _lifeScl.setScalar(f.size));
        fishMesh.setMatrixAt(i, _lifeM4);
    }
    fishMesh.instanceMatrix.needsUpdate = true;
}

// --- CRÉATURES ABYSSALES -------------------------------------------------------
// Faune bioluminescente de la fosse : corps fins bleu/vert sombre légèrement
// luminescents + photophores en MeshBasicMaterial (visibles dans le noir total).
// Deux InstancedMesh aux matrices synchronisées (corps + points lumineux).
const abyssData = [];   // { pos, dir, wander, timer, phase, size }

function buildAbyss() {
    // Corps fin et allongé (nez vers +Z)
    const body = new THREE.SphereGeometry(0.05, 6, 5);
    body.scale(0.4, 0.5, 2.6);
    const tail = new THREE.ConeGeometry(0.03, 0.1, 4);
    tail.rotateX(Math.PI / 2);
    tail.scale(0.3, 1, 1);
    tail.translate(0, 0, -0.16);
    const geo = mergeGeometries([body, tail]);
    geo.computeVertexNormals();
    // Hors envMats : la silhouette doit rester faiblement luminescente même
    // dans le noir absolu de la fosse (emissive indépendante de la profondeur).
    const mat = new THREE.MeshStandardMaterial({
        roughness: 0.7, metalness: 0.05, flatShading: true,
        emissive: 0x06222e, emissiveIntensity: 0.8,
    });
    abyssMesh = new THREE.InstancedMesh(geo, mat, ABYSS_MAX);
    abyssMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    abyssMesh.frustumCulled = false;
    // Photophores : 4 points émissifs le long des flancs
    const dots = [];
    for (let i = 0; i < 4; i++) {
        const d = new THREE.SphereGeometry(0.008, 4, 3);
        d.translate((i % 2 ? 1 : -1) * 0.018, 0.012, -0.09 + i * 0.06);
        dots.push(d);
    }
    abyssGlowMesh = new THREE.InstancedMesh(mergeGeometries(dots),
        new THREE.MeshBasicMaterial({ color: 0x54f2d6 }), ABYSS_MAX);
    abyssGlowMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    abyssGlowMesh.frustumCulled = false;
    const rng = mulberry32(7788);
    const cTint = new THREE.Color();
    for (let i = 0; i < ABYSS_MAX; i++) {
        const p = randomFloorPoint(rng, 1.5);
        const a = rng() * Math.PI * 2;
        const yMin = FLOOR_Y + 1.0;
        const yMax = Math.min(-REEF_DEPTH - 4, CEIL_Y - 2);
        abyssData.push({
            pos: new THREE.Vector3(p.x, yMin + rng() * Math.max(1, yMax - yMin), p.z),
            dir: new THREE.Vector3(Math.cos(a), 0, Math.sin(a)),
            wander: new THREE.Vector3(Math.cos(a), 0, Math.sin(a)),
            timer: rng() * 4,
            phase: rng() * Math.PI * 2,
            size: 0.8 + rng() * 0.8,
        });
        cTint.setHSL(0.45 + rng() * 0.15, 0.7, 0.10 + rng() * 0.08);   // bleu/vert sombre
        abyssMesh.setColorAt(i, cTint);
        // Matrice initiale (voir buildFish) : évite l'échelle 0 invisible avant
        // la 1re frame d'updateAbyss, notamment après une reconstruction.
        const ai = abyssData[i];
        _lifeQ.setFromUnitVectors(_Z_AXIS, ai.dir);
        _lifeM4.compose(ai.pos, _lifeQ, _lifeScl.setScalar(ai.size));
        abyssMesh.setMatrixAt(i, _lifeM4);
        abyssGlowMesh.setMatrixAt(i, _lifeM4);
    }
    abyssMesh.instanceMatrix.needsUpdate = true;
    abyssGlowMesh.instanceMatrix.needsUpdate = true;
    scene.add(abyssMesh);
    scene.add(abyssGlowMesh);
}

function updateAbyss(dt, time) {
    if (!abyssMesh || !abyssMesh.visible) return;
    const n = Math.min(abyssMesh.count, abyssData.length);
    const yTop = Math.min(-REEF_DEPTH - 3, CEIL_Y - 2);   // plafond : reste dans la fosse
    for (let i = 0; i < n; i++) {
        const f = abyssData[i];
        f.timer -= dt;
        if (f.timer <= 0) {
            f.timer = 3 + Math.random() * 4;
            const a = Math.random() * Math.PI * 2;
            f.wander.set(Math.cos(a), (Math.random() - 0.5) * 0.4, Math.sin(a)).normalize();
        }
        _steer.copy(f.wander);
        if (f.pos.x >  WALL_LIMIT - 2) _steer.x -= (f.pos.x - (WALL_LIMIT - 2));
        if (f.pos.x < -WALL_LIMIT + 2) _steer.x += ((-WALL_LIMIT + 2) - f.pos.x);
        if (f.pos.z >  WALL_LIMIT - 2) _steer.z -= (f.pos.z - (WALL_LIMIT - 2));
        if (f.pos.z < -WALL_LIMIT + 2) _steer.z += ((-WALL_LIMIT + 2) - f.pos.z);
        const floorLim = floorLimitAt(f.pos.x, f.pos.z) + 0.5;
        if (f.pos.y < floorLim) _steer.y += (floorLim - f.pos.y) * 2.0;
        if (f.pos.y > yTop) _steer.y -= (f.pos.y - yTop) * 1.5;
        _steer.normalize();
        f.dir.lerp(_steer, Math.min(1, dt * 0.8)).normalize();   // réactions lentes
        f.pos.addScaledVector(f.dir, 0.12 * f.size * dt);        // dérive paresseuse
        _lifeQ.setFromUnitVectors(_Z_AXIS, f.dir);
        _lifeQ2.setFromAxisAngle(_Y_AXIS, Math.sin(time * 2.5 + f.phase) * 0.22);
        _lifeQ.multiply(_lifeQ2);
        _lifeM4.compose(f.pos, _lifeQ, _lifeScl.setScalar(f.size));
        abyssMesh.setMatrixAt(i, _lifeM4);
        abyssGlowMesh.setMatrixAt(i, _lifeM4);
    }
    abyssMesh.instanceMatrix.needsUpdate = true;
    abyssGlowMesh.instanceMatrix.needsUpdate = true;
}

// --- BROCHETS ABYSSAUX GÉANTS ---------------------------------------------------
// 1-2 prédateurs de ~1 m (2× le ROV), géométrie détaillée en meshes classiques
// (corps fuselé, gueule entrouverte, nageoires, yeux phosphorescents). Ils
// patrouillent lentement le long de la paroi de la fosse, tapis dans le noir,
// et convergent avec inertie vers la lumière des projecteurs du ROV.
const pikeData = [];   // { group, angle, y, dir, speed }
const _pikeTarget = new THREE.Vector3();

function buildPikeMesh() {
    const g = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({
        color: 0x22352a, roughness: 0.85, metalness: 0.05, flatShading: true,
    });
    envMats.push(mat);
    // Corps allongé (~1 m hors caudale), nez vers +Z
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.09, 9, 7), mat);
    body.scale.set(0.85, 0.75, 5.6);
    g.add(body);
    // Gueule : deux mâchoires coniques aplaties, entrouvertes
    const jawGeo = new THREE.ConeGeometry(0.055, 0.22, 6);
    jawGeo.rotateX(Math.PI / 2);            // pointe vers +Z
    jawGeo.scale(1, 0.45, 1);
    const jawUp = new THREE.Mesh(jawGeo, mat);
    jawUp.position.set(0, 0.03, 0.5);
    jawUp.rotation.x = -0.18;
    const jawLo = new THREE.Mesh(jawGeo, mat);
    jawLo.position.set(0, -0.035, 0.49);
    jawLo.rotation.x = 0.30;
    g.add(jawUp, jawLo);
    // Caudale (base large à l'arrière) + dorsale reculée, typique du brochet
    const tailGeo = new THREE.ConeGeometry(0.09, 0.16, 4);
    tailGeo.rotateX(-Math.PI / 2);
    tailGeo.scale(0.25, 1.6, 1);
    const tail = new THREE.Mesh(tailGeo, mat);
    tail.position.set(0, 0, -0.56);
    g.add(tail);
    const dorsGeo = new THREE.ConeGeometry(0.06, 0.1, 3);
    dorsGeo.scale(0.25, 1, 1.5);
    const dors = new THREE.Mesh(dorsGeo, mat);
    dors.position.set(0, 0.08, -0.28);
    g.add(dors);
    // Yeux phosphorescents : MeshBasicMaterial, perçants dans le noir total
    const eyeMat = new THREE.MeshBasicMaterial({ color: 0x8cff5e });
    const eyeGeo = new THREE.SphereGeometry(0.016, 6, 5);
    const eL = new THREE.Mesh(eyeGeo, eyeMat);
    eL.position.set(0.055, 0.035, 0.34);
    const eR = new THREE.Mesh(eyeGeo, eyeMat);
    eR.position.set(-0.055, 0.035, 0.34);
    g.add(eL, eR);
    return g;
}

function buildPikes() {
    pikeGroup = new THREE.Group();
    const rng = mulberry32(6060);
    const patrolR = Math.max(3, WALL_POS * PIT_RADIUS_K * 0.7);
    for (let i = 0; i < PIKE_COUNT; i++) {
        const g = buildPikeMesh();
        const angle = rng() * Math.PI * 2;
        const y = FLOOR_Y + 3 + rng() * 6;
        g.position.set(Math.cos(angle) * patrolR, y, Math.sin(angle) * patrolR);
        pikeData.push({
            group: g, angle, y,
            dir: new THREE.Vector3(0, 0, 1),
            speed: 0.35 + rng() * 0.15,   // nage lente de prédateur (m/s)
        });
        pikeGroup.add(g);
    }
    scene.add(pikeGroup);
}

function updatePikes(dt) {
    if (!pikeGroup || !pikeGroup.visible) return;
    const patrolR = Math.max(3, WALL_POS * PIT_RADIUS_K * 0.7);
    for (const p of pikeData) {
        const g = p.group;
        // Patrouille circulaire lente le long de la paroi, ondulation verticale
        p.angle += dt * (p.speed / patrolR);
        _pikeTarget.set(Math.cos(p.angle) * patrolR,
            p.y + Math.sin(p.angle * 3.1) * 1.5, Math.sin(p.angle) * patrolR);
        // Réaction LENTE à la lumière : projecteurs allumés à < 12 m dans la
        // zone sombre → le prédateur converge vers le ROV avec inertie marquée
        if (diveState.led && posWorld.y < -REEF_DEPTH && g.position.distanceTo(posWorld) < 12) {
            _pikeTarget.copy(posWorld);
            _pikeTarget.y = Math.max(_pikeTarget.y - 0.4, FLOOR_Y + 1);
        }
        _lifeV.copy(_pikeTarget).sub(g.position);
        const d = _lifeV.length();
        if (d > 0.05) {
            _lifeV.normalize();
            p.dir.lerp(_lifeV, Math.min(1, dt * 0.5)).normalize();   // virages amortis
            g.position.addScaledVector(p.dir, Math.min(p.speed, d) * dt);
        }
        // Garde au fond : reste tapi juste au-dessus du relief
        const fl = floorLimitAt(g.position.x, g.position.z) + 0.6;
        if (g.position.y < fl) g.position.y = fl;
        // Orientation : nez (+Z) vers la direction de nage, rotation très lente
        _lifeQ.setFromUnitVectors(_Z_AXIS, p.dir);
        g.quaternion.slerp(_lifeQ, Math.min(1, dt * 1.2));
    }
}

// Zonage récif/abysses selon la profondeur du ROV (perf RPi5) : la vie hors
// zone est masquée, avec HYSTÉRÉSIS pour éviter tout clignotement à la frontière.
let reefVisible = true;
let abyssVisible = false;

// Recalcule les indicateurs de zonage (récif / abysses) d'après la profondeur
// COURANTE du ROV et la présence d'une fosse. Appelée chaque frame ET juste
// après une reconstruction (rebuildLife) : un état « masqué » hérité d'une
// plongée profonde est ainsi corrigé immédiatement, sans attendre l'hystérésis.
function refreshLifeZoning() {
    const depthNow = Math.max(0, -posWorld.y);
    const hasPit = FLOOR_Y < -REEF_DEPTH - 1;   // sans fosse : pas de zone abyssale
    if (!hasPit) {
        // Bassin sans fosse : le récif occupe toute la hauteur → JAMAIS masqué,
        // et aucune faune abyssale à afficher.
        reefVisible = true;
        abyssVisible = false;
        return;
    }
    // Le récif n'est masqué que si le ROV est nettement SOUS le plateau (bien
    // engagé dans la fosse), avec hystérésis anti-clignotement. Les seuils sont
    // volontairement bas pour ne jamais éteindre le récif tant qu'on l'explore.
    if (reefVisible && depthNow > REEF_DEPTH + 30) reefVisible = false;
    else if (!reefVisible && depthNow < REEF_DEPTH + 22) reefVisible = true;
    if (abyssVisible && depthNow < REEF_DEPTH - 4) abyssVisible = false;
    else if (!abyssVisible && depthNow > REEF_DEPTH + 2) abyssVisible = true;
}

// Applique les indicateurs de zonage à la visibilité des maillages de vie.
// Les algues suivent DÉSORMAIS le même zonage que coraux/poissons : plus de
// dissymétrie « seules quelques plantes restent » quand la faune est masquée.
function applyLifeZoning() {
    const hasPit = FLOOR_Y < -REEF_DEPTH - 1;
    if (algaeMesh) algaeMesh.visible = lifeState.algae && algaeMesh.count > 0 && reefVisible;
    if (fishMesh) fishMesh.visible = lifeState.fish && fishMesh.count > 0 && reefVisible;
    if (coralMeshes) coralMeshes.forEach((m) => {
        m.visible = lifeState.algae && m.count > 0 && reefVisible;
    });
    const showAbyss = lifeState.fish && hasPit && lifeState.abyssDensity > 0;
    if (abyssMesh) {
        abyssMesh.visible = showAbyss && abyssVisible;
        abyssGlowMesh.visible = showAbyss && abyssVisible;
    }
    if (pikeGroup) pikeGroup.visible = showAbyss;   // seulement 2 : toujours actifs
}

// Mise à jour par frame de la vie sous-marine (appelée par la boucle animate)
function updateLife(dt, time) {
    algaeUniforms.uTime.value = time;
    refreshLifeZoning();
    applyLifeZoning();
    updateFish(dt, time);
    updateAbyss(dt, time);
    updatePikes(dt);
}

// Applique l'état UI à la scène : création paresseuse, visibilité et nombre
// d'instances affichées (count), sans reconstruction de géométrie.
function applyLife() {
    if (lifeState.algae && !algaeMesh) buildAlgae();
    if (algaeMesh) {
        // Nombre de brins piloté par la SURFACE (slider algues = densité en %)
        const nTuft = reefCount(ALGAE_PER_M2, ALGAE_MAX_TUFTS, lifeState.algaeCount / 100);
        algaeMesh.visible = lifeState.algae && nTuft > 0;
        algaeMesh.count = nTuft * ALGAE_BLADES;
        algaeMesh.instanceMatrix.needsUpdate = true;
    }
    algaeUniforms.uSway.value = lifeState.current;

    if (lifeState.fish && !fishMesh) buildFish();
    if (fishMesh) {
        // La densité récif module la taille effective du banc (perf RPi5)
        fishMesh.visible = lifeState.fish && lifeState.fishCount > 0;
        fishMesh.count = Math.round(Math.min(FISH_MAX, lifeState.fishCount) * lifeState.reefDensity);
        fishMesh.instanceMatrix.needsUpdate = true;
    }

    // Coraux + tapis du récif (liés à la flore) : nombre AU MÈTRE CARRÉ par espèce
    if (lifeState.algae && !coralMeshes) buildCorals();
    if (coralMeshes) {
        coralMeshes.forEach((m, t) => {
            const nC = reefCount(CORAL_PER_M2[t], CORAL_CAP[t], lifeState.reefDensity);
            m.visible = lifeState.algae && nC > 0;
            m.count = nC;
            m.instanceMatrix.needsUpdate = true;
        });
    }

    // Faune abyssale (liée à la faune) : créatures + prédateurs de la fosse
    if (lifeState.fish && !abyssMesh) buildAbyss();
    if (abyssMesh) {
        const nA = Math.round(ABYSS_MAX * lifeState.abyssDensity);
        abyssMesh.count = nA;
        abyssGlowMesh.count = nA;
        abyssMesh.instanceMatrix.needsUpdate = true;
        abyssGlowMesh.instanceMatrix.needsUpdate = true;
    }
    if (lifeState.fish && !pikeGroup) buildPikes();

    // Griser les sliders des sections décochées (même pattern que le décor)
    [['life-algae-count-row', lifeState.algae], ['life-algae-len-row', lifeState.algae],
     ['life-current-row', lifeState.algae],
     ['life-fish-count-row', lifeState.fish], ['life-fish-speed-row', lifeState.fish],
     ['life-reef-density-row', lifeState.algae || lifeState.fish],
     ['life-abyss-density-row', lifeState.fish]]
        .forEach(([id, on]) => {
            const row = document.getElementById(id);
            if (row) row.classList.toggle('disabled', !on);
        });
}

function loadLifeSettings() {
    try {
        lifeState.algae = localStorage.getItem(LIFE_KEYS.algae) === '1';
        lifeState.fish = localStorage.getItem(LIFE_KEYS.fish) === '1';
        const ac = parseInt(localStorage.getItem(LIFE_KEYS.algaeCount), 10);
        if (!isNaN(ac)) lifeState.algaeCount = Math.min(100, Math.max(0, ac));
        const al = parseFloat(localStorage.getItem(LIFE_KEYS.algaeLen));
        if (!isNaN(al)) lifeState.algaeLen = Math.min(3, Math.max(0.3, al));
        const cu = parseFloat(localStorage.getItem(LIFE_KEYS.current));
        if (!isNaN(cu)) lifeState.current = Math.min(1, Math.max(0, cu));
        const fc = parseInt(localStorage.getItem(LIFE_KEYS.fishCount), 10);
        if (!isNaN(fc)) lifeState.fishCount = Math.min(FISH_MAX, Math.max(0, fc));
        const fs = parseFloat(localStorage.getItem(LIFE_KEYS.fishSpeed));
        if (!isNaN(fs)) lifeState.fishSpeed = Math.min(3, Math.max(0.1, fs));
        const rd = parseFloat(localStorage.getItem(LIFE_KEYS.reefDensity));
        if (!isNaN(rd)) lifeState.reefDensity = Math.min(1, Math.max(0, rd));
        const ad = parseFloat(localStorage.getItem(LIFE_KEYS.abyssDensity));
        if (!isNaN(ad)) lifeState.abyssDensity = Math.min(1, Math.max(0, ad));
    } catch (e) { /* localStorage indisponible : valeurs par défaut */ }
}

function bindLifeControls() {
    const ca = document.getElementById('life-algae');
    const cf = document.getElementById('life-fish');
    const sac = document.getElementById('life-algae-count');
    const sacVal = document.getElementById('life-algae-count-val');
    const sal = document.getElementById('life-algae-len');
    const salVal = document.getElementById('life-algae-len-val');
    const scu = document.getElementById('life-current');
    const scuVal = document.getElementById('life-current-val');
    const sfc = document.getElementById('life-fish-count');
    const sfcVal = document.getElementById('life-fish-count-val');
    const sfs = document.getElementById('life-fish-speed');
    const sfsVal = document.getElementById('life-fish-speed-val');
    const srd = document.getElementById('life-reef-density');
    const srdVal = document.getElementById('life-reef-density-val');
    const sad = document.getElementById('life-abyss-density');
    const sadVal = document.getElementById('life-abyss-density-val');
    if (!ca || !cf) return;
    const save = (k, v) => { try { localStorage.setItem(LIFE_KEYS[k], v); } catch (e) { /* ignoré */ } };

    // Refléter l'état chargé (localStorage) sur les widgets
    ca.checked = lifeState.algae;
    cf.checked = lifeState.fish;
    sac.value = lifeState.algaeCount;
    sacVal.textContent = lifeState.algaeCount + ' %';
    sal.value = lifeState.algaeLen;
    salVal.textContent = lifeState.algaeLen.toFixed(1) + '×';
    scu.value = Math.round(lifeState.current * 100);
    scuVal.textContent = Math.round(lifeState.current * 100) + '%';
    sfc.value = lifeState.fishCount;
    sfcVal.textContent = String(lifeState.fishCount);
    sfs.value = lifeState.fishSpeed;
    sfsVal.textContent = lifeState.fishSpeed.toFixed(1) + '×';
    srd.value = Math.round(lifeState.reefDensity * 100);
    srdVal.textContent = Math.round(lifeState.reefDensity * 100) + '%';
    sad.value = Math.round(lifeState.abyssDensity * 100);
    sadVal.textContent = Math.round(lifeState.abyssDensity * 100) + '%';

    ca.addEventListener('change', () => {
        lifeState.algae = ca.checked;
        save('algae', ca.checked ? '1' : '0');
        applyLife();
    });
    cf.addEventListener('change', () => {
        lifeState.fish = cf.checked;
        save('fish', cf.checked ? '1' : '0');
        applyLife();
    });
    sac.addEventListener('input', () => {
        lifeState.algaeCount = parseInt(sac.value, 10);
        sacVal.textContent = sac.value + ' %';
        save('algaeCount', sac.value);
        applyLife();
    });
    sal.addEventListener('input', () => {
        lifeState.algaeLen = parseFloat(sal.value);
        salVal.textContent = lifeState.algaeLen.toFixed(1) + '×';
        save('algaeLen', sal.value);
        updateAlgaeAnchors();   // remise à l'échelle des brins en temps réel
    });
    scu.addEventListener('input', () => {
        lifeState.current = parseInt(scu.value, 10) / 100;
        scuVal.textContent = scu.value + '%';
        save('current', String(lifeState.current));
        applyLife();
    });
    sfc.addEventListener('input', () => {
        lifeState.fishCount = parseInt(sfc.value, 10);
        sfcVal.textContent = sfc.value;
        save('fishCount', sfc.value);
        applyLife();
    });
    sfs.addEventListener('input', () => {
        lifeState.fishSpeed = parseFloat(sfs.value);
        sfsVal.textContent = lifeState.fishSpeed.toFixed(1) + '×';
        save('fishSpeed', sfs.value);
        applyLife();
    });
    srd.addEventListener('input', () => {
        lifeState.reefDensity = parseInt(srd.value, 10) / 100;
        srdVal.textContent = srd.value + '%';
        save('reefDensity', String(lifeState.reefDensity));
        applyLife();
    });
    sad.addEventListener('input', () => {
        lifeState.abyssDensity = parseInt(sad.value, 10) / 100;
        sadVal.textContent = sad.value + '%';
        save('abyssDensity', String(lifeState.abyssDensity));
        applyLife();
    });

    applyLife();
}

// ---------------------------------------------------------------------------
// PANNEAUX HTML (moteurs + 6DOF)
// ---------------------------------------------------------------------------
function buildPanels() {
    const hWrap = document.getElementById('motors-horizontal');
    const vWrap = document.getElementById('motors-vertical');
    for (let id = 1; id <= 8; id++) {
        const cls = id <= 4 ? 'h' : 'v';
        const row = document.createElement('div');
        row.className = 'm-row';
        row.innerHTML = `
            <span class="m-swatch ${cls}"></span>
            <span class="m-name">${MOTOR_NAMES[id]}</span>
            <span class="m-bar"><span class="m-bar-fill" id="m-fill-${id}"></span></span>
            <span class="m-pct" id="m-pct-${id}">0%</span>`;
        (id <= 4 ? hWrap : vWrap).appendChild(row);
    }

    const dofWrap = document.getElementById('dof-rows');
    DOF_ORDER.forEach((k) => {
        const row = document.createElement('div');
        row.className = 'dof-row';
        row.innerHTML = `
            <span class="dof-label">${DOF_LABELS[k]}</span>
            <span class="dof-track"><span class="dof-fill" id="dof-fill-${k}"></span></span>
            <span class="dof-val" id="dof-val-${k}">0.00</span>`;
        dofWrap.appendChild(row);
    });
}

function updateMotorPanel() {
    for (let id = 1; id <= 8; id++) {
        const pct = motorState[id] || 0;
        const fill = document.getElementById(`m-fill-${id}`);
        const lbl = document.getElementById(`m-pct-${id}`);
        if (fill) {
            fill.style.width = `${pct}%`;
            fill.style.background = id <= 4 ? '#ff5a6a' : '#35d0ba';
        }
        if (lbl) lbl.textContent = `${pct}%`;
    }
}

function updateDofPanel() {
    DOF_ORDER.forEach((k) => {
        const v = Math.max(-1, Math.min(1, target[k] || 0));
        const fill = document.getElementById(`dof-fill-${k}`);
        const val = document.getElementById(`dof-val-${k}`);
        if (fill) {
            const half = Math.abs(v) * 50;
            if (v >= 0) { fill.style.left = '50%'; fill.style.width = half + '%'; }
            else { fill.style.left = (50 - half) + '%'; fill.style.width = half + '%'; }
            fill.style.background = v >= 0 ? '#35d0ba' : '#ff5a6a';
        }
        if (val) val.textContent = v.toFixed(2);
    });
}

// ---------------------------------------------------------------------------
// WEBSOCKET TÉLÉMÉTRIE
// ---------------------------------------------------------------------------
let ws = null, reconnectTimer = null, reconnectDelay = 1000;

function connectWS() {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${window.location.host}/ws/telemetry`);

    ws.onopen = () => { reconnectDelay = 1000; setWsDot(true); };
    ws.onclose = () => { setWsDot(false); scheduleReconnect(); };
    ws.onerror = () => ws.close();
    ws.onmessage = (evt) => {
        let msg;
        try { msg = JSON.parse(evt.data); } catch (e) { return; }
        if (msg.type === 'action_result') return;
        applyTelemetry(msg);
    };
}

function scheduleReconnect() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
        reconnectDelay = Math.min(reconnectDelay * 1.5, 8000);
        connectWS();
    }, reconnectDelay);
}

function setWsDot(ok) {
    document.getElementById('ws-dot').classList.toggle('connected', ok);
}

function applyTelemetry(msg) {
    // 1. Consignes 6DOF. La lecture directe de la manette (si branchée sur CETTE
    //    page) est prioritaire ; sinon on retombe sur le dof/IMU diffusé par le
    //    backend (ex. manette pilotée depuis un autre onglet cockpit).
    if (!gpConnected) {
        if (msg.dof && typeof msg.dof === 'object') {
            DOF_ORDER.forEach((k) => {
                if (typeof msg.dof[k] === 'number') target[k] = msg.dof[k];
            });
        } else {
            const src = msg.imu || msg;
            if (typeof src.roll === 'number') target.roll = clampDeg(src.roll);
            if (typeof src.pitch === 'number') target.pitch = clampDeg(src.pitch);
        }
    }

    // 2. Puissance des 8 moteurs
    if (Array.isArray(msg.motors)) {
        msg.motors.forEach((m) => {
            motorState[m.id] = m.percent || 0;
        });
        updateMotorPanel();
    }
    // 3. État d'armement (reflet immédiat sur le bouton d'action)
    if (typeof msg.armed === 'boolean') setArmedUI(msg.armed);
    updateDofPanel();
}

function clampDeg(deg) { return Math.max(-1, Math.min(1, deg / 45)); }

// ---------------------------------------------------------------------------
// LECTURE DIRECTE DE LA MANETTE (Gamepad API)
// Rend la page 3D autonome : elle lit elle-même la manette avec le profil
// actif, anime immédiatement le modèle, et transmet les consignes `move` au
// backend pour que les 8 moteurs soient mixés (puissance renvoyée via motors[]).
// ---------------------------------------------------------------------------
const gpAxisMap = {};      // idx -> { function, invert, deadzone, sensitivity }
const gpButtonMap = {};    // idx -> function (mouvements continus maintenus)
let gpComboList = [];      // [{ key: 'L1+CROSS', indices, function }] triés par taille décroissante
let gpComboMembers = new Set();
let gpDeadzone = 0.12;
let gpConnected = false;
let gpPrevPressed = {};    // idx -> bool (front montant boutons simples)
let gpPrevCombo = {};      // key combo -> bool (front montant)
const GP_LS_MAPPING_KEY = 'rov.gamepad.mapping';
const AXIS_NAME_TO_INDEX = { LEFT_X: 0, LEFT_Y: 1, RIGHT_X: 2, RIGHT_Y: 3, L2: 4, R2: 5 };
const BUTTON_NAME_TO_INDEX = {
    CROSS: 0, CIRCLE: 1, SQUARE: 2, TRIANGLE: 3,
    L1: 4, R1: 5, L2: 6, R2: 7,
    SHARE: 8, OPTIONS: 9, L3: 10, R3: 11,
    DPAD_UP: 12, DPAD_DOWN: 13, DPAD_LEFT: 14, DPAD_RIGHT: 15,
    PS: 16, TOUCHPAD: 17,
};
// Fonctions de mouvement continues déclenchées par un bouton maintenu → [axe, signe].
// C'est ici que se trouvent le plus souvent le roulis et le tangage (boutons/DPAD).
const BUTTON_DOF = {
    move_forward: ['surge', +1], move_backward: ['surge', -1],
    turn_left: ['yaw', -1], turn_right: ['yaw', +1],
    move_up: ['heave', +1], move_down: ['heave', -1],
    ascent: ['heave', +1], descent: ['heave', -1],
    roll_left: ['roll', -1], roll_right: ['roll', +1], roll: ['roll', +1],
    pitch_up: ['pitch', +1], pitch_down: ['pitch', -1], pitch: ['pitch', +1],
};
// Fonctions d'interface déclenchées sur front montant (bouton simple ou combo).
const UI_BUTTON_ACTIONS = {
    fpv_toggle: () => setFpvUI(!isFpvActive),
    reset_position: () => resetPose(),
};

// Applique un mapping { buttons, axes, settings } aux tables locales.
function applyGpMapping(mapping) {
    if (!mapping) return;
    if (mapping.settings) {
        gpDeadzone = Math.min((parseInt(mapping.settings.deadzone) || 12) / 100, 0.10);
    }
    const next = {};
    if (mapping.axes) {
        Object.entries(mapping.axes).forEach(([name, cfg]) => {
            const idx = AXIS_NAME_TO_INDEX[name];
            if (idx !== undefined && cfg.function) {
                next[idx] = {
                    function: cfg.function,
                    invert: cfg.invert || false,
                    deadzone: (cfg.deadzone !== undefined && cfg.deadzone !== null)
                        ? Math.min(parseFloat(cfg.deadzone) / 100, 0.30) : null,
                    sensitivity: (cfg.sensitivity !== undefined && cfg.sensitivity !== null)
                        ? Math.max(10, Math.min(150, parseFloat(cfg.sensitivity))) / 100 : null,
                };
            }
        });
    }
    Object.keys(gpAxisMap).forEach((k) => delete gpAxisMap[k]);
    Object.assign(gpAxisMap, next);
    // Boutons : simples + combos (clé "L1+CROSS") — roll/pitch fréquemment mappés ici.
    const nextBtn = {};
    const nextCombos = [];
    if (mapping.buttons) {
        Object.entries(mapping.buttons).forEach(([name, cfg]) => {
            if (!cfg || !cfg.function) return;
            if (name.includes('+')) {
                const indices = name.split('+').map((p) => BUTTON_NAME_TO_INDEX[p.trim()]);
                if (indices.some((ix) => ix === undefined)) return;
                nextCombos.push({ key: name, indices, function: cfg.function });
            } else {
                const idx = BUTTON_NAME_TO_INDEX[name];
                if (idx !== undefined) nextBtn[idx] = cfg.function;
            }
        });
    }
    // Combos les plus longs en premier (priorité aux combinaisons complexes)
    nextCombos.sort((a, b) => b.indices.length - a.indices.length);
    Object.keys(gpButtonMap).forEach((k) => delete gpButtonMap[k]);
    Object.assign(gpButtonMap, nextBtn);
    gpComboList = nextCombos;
    gpComboMembers = new Set();
    nextCombos.forEach((c) => c.indices.forEach((ix) => gpComboMembers.add(ix)));
    gpPrevCombo = {};
}

async function loadGamepadProfile() {
    // 1. localStorage prioritaire : mapping écrit immédiatement par la page
    //    de configuration manette → consommation fluide sans requête réseau.
    try {
        const raw = localStorage.getItem(GP_LS_MAPPING_KEY);
        if (raw) {
            const stored = JSON.parse(raw);
            if (stored && (stored.buttons || stored.axes)) {
                applyGpMapping(stored);
                return;
            }
        }
    } catch (e) { /* localStorage indisponible : fallback API ci-dessous */ }
    // 2. Fallback : profil actif côté backend
    try {
        const resp = await fetch('/api/gamepad/mapping');
        if (!resp.ok) return;
        const data = await resp.json();
        const mapping = data.data || data.mapping;
        if (data.status !== 'ok' || !mapping) return;
        applyGpMapping(mapping);
    } catch (e) { /* profil indisponible : la manette restera inactive */ }
}

function applyGpDeadzone(v, dzOverride) {
    // Zone morte par axe si définie dans le mapping, sinon zone morte globale
    const dz = (dzOverride !== undefined && dzOverride !== null) ? dzOverride : gpDeadzone;
    if (Math.abs(v) < dz) return 0;
    const sign = v > 0 ? 1 : -1;
    return sign * (Math.abs(v) - dz) / (1 - dz);
}

// Associe un nom de fonction d'axe (profil) à un canal 6DOF (cf. gamepad.js).
function axisFnToDof(fn, val, dof) {
    switch (fn) {
        case 'forward_backward': case 'move_forward': case 'move_backward': case 'surge':
            dof.surge = val; break;
        case 'lateral': case 'sway':
            dof.sway = val; break;
        case 'turn': case 'turn_left': case 'turn_right': case 'yaw':
            dof.yaw = val; break;
        case 'vertical': case 'heave': case 'move_up': case 'move_down':
            dof.heave = val; break;
        case 'ascent': if (val > 0) dof.heave = val; break;
        case 'descent': if (val > 0) dof.heave = -val; break;
        case 'roll': case 'roll_left': case 'roll_right':
            dof.roll = val; break;
        case 'pitch': case 'pitch_up': case 'pitch_down':
            dof.pitch = val; break;
    }
}

function readGamepad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let gp = null;
    for (const p of pads) { if (p && p.connected) { gp = p; break; } }
    if (!gp) { gpConnected = false; return null; }
    gpConnected = true;
    const sens = physState.sens;   // facteur de sensibilité (0.1 .. 1.0)
    const dof = { surge: 0, sway: 0, heave: 0, yaw: 0, roll: 0, pitch: 0 };
    Object.entries(gpAxisMap).forEach(([idxStr, cfg]) => {
        const idx = parseInt(idxStr);
        if (idx >= gp.axes.length || !cfg.function) return;
        let val = gp.axes[idx];
        if (cfg.invert) val = -val;
        val = applyGpDeadzone(val, cfg.deadzone) * sens;
        if (cfg.sensitivity !== null && cfg.sensitivity !== undefined) val *= cfg.sensitivity;
        if (val === 0) return;
        axisFnToDof(cfg.function, val, dof);
    });
    // Combos prioritaires : leurs indices sont "consommés" pour éviter de
    // déclencher en plus la fonction simple d'un bouton membre (ex: L1+A vs A).
    const consumed = new Set();
    gpComboList.forEach((combo) => {
        const allDown = combo.indices.every((ix) => gp.buttons[ix] && gp.buttons[ix].pressed);
        const wasDown = gpPrevCombo[combo.key] || false;
        if (allDown) {
            combo.indices.forEach((ix) => consumed.add(ix));
            const ui = UI_BUTTON_ACTIONS[combo.function];
            if (ui) {
                if (!wasDown) ui();   // actions IHM sur front montant uniquement
            } else {
                const m = BUTTON_DOF[combo.function];
                if (m) dof[m[0]] = m[1] * sens;
            }
        }
        gpPrevCombo[combo.key] = allDown;
    });
    // Boutons simples : actions IHM (front montant) + mouvements continus maintenus.
    Object.entries(gpButtonMap).forEach(([idxStr, fn]) => {
        const idx = parseInt(idxStr);
        const btn = gp.buttons[idx];
        const isDown = !!(btn && btn.pressed) && !consumed.has(idx);
        const wasDown = gpPrevPressed[idx] || false;
        gpPrevPressed[idx] = isDown;
        if (!isDown) return;
        const ui = UI_BUTTON_ACTIONS[fn];
        if (ui) {
            if (!wasDown) ui();
            return;
        }
        const m = BUTTON_DOF[fn];
        if (m) dof[m[0]] = m[1] * sens;
    });
    return dof;
}

// Envoi throttlé (20 Hz) des consignes au backend pour déclencher le mixage moteurs.
let _lastMoveTime = 0;
let _lastMove = { surge: 0, sway: 0, heave: 0, yaw: 0, roll: 0, pitch: 0 };
function sendMove(dof) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const now = performance.now();
    if (now - _lastMoveTime < 50) return;
    const changed = DOF_ORDER.some((k) => Math.abs(dof[k] - _lastMove[k]) > 0.01);
    if (!changed) return;
    _lastMoveTime = now;
    _lastMove = { ...dof };
    ws.send(JSON.stringify({
        command: 'move',
        forward: Math.round(dof.surge * 100),
        lateral: Math.round(dof.sway * 100),
        vertical: Math.round(dof.heave * 100),
        yaw: Math.round(dof.yaw * 100),
        roll: Math.round(dof.roll * 100),
        pitch: Math.round(dof.pitch * 100),
    }));
}

function setGpBadge(connected) {
    const el = document.getElementById('gp-badge');
    if (!el) return;
    el.textContent = connected ? '🎮 Manette' : '🎮 —';
    el.style.color = connected ? '#35d0ba' : '#8aa0c8';
}

// ---------------------------------------------------------------------------
// MOTEUR PHYSIQUE (intégrateur vitesse + inertie fluide)
// ---------------------------------------------------------------------------
// Quaternion d'attitude courant (mêmes conventions que l'affichage 3D).
function orientationQuat() {
    _eulerTmp.set(current.pitch, current.yaw, -current.roll, 'YXZ');
    return _quatTmp.setFromEuler(_eulerTmp);
}

function integratePhysics() {
    const inertia = physState.inertia;   // 0.01 (arrêt net) .. 0.99 (long glissement)
    const gain = physState.gain;         // 0.1 .. 5.0 (translation uniquement)

    // --- Rotations : 1) la commande accélère la vitesse angulaire,
    //                 2) friction fluide, 3) intégration dans l'angle ---
    ['yaw', 'roll', 'pitch'].forEach((k) => {
        vel[k] = (vel[k] + target[k] * ROT_ACCEL) * inertia;
        current[k] += vel[k];
    });
    // Rotations CONTINUES sur les 3 axes (looping / tonneau / cap libre) :
    // AUCUNE butée à ±75/90°. Simple repli 2π-périodique dans [-π, π] contre la
    // dérive flottante — invisible à l'écran : le quaternion d'attitude
    // (orientationQuat) et le HUD cyclique sont eux-mêmes 2π-périodiques.
    current.roll  = wrapPi(current.roll);
    current.pitch = wrapPi(current.pitch);
    current.yaw   = wrapPi(current.yaw);

    // --- Translations : vitesses intégrées dans le REPÈRE CORPS ---
    ['surge', 'sway', 'heave'].forEach((k) => {
        vel[k] = (vel[k] + target[k] * TRANS_ACCEL) * inertia;
    });
    // Vecteur vitesse corps (X = sway tribord, Y = heave haut, Z = surge nez)
    // projeté dans le monde via le quaternion d'attitude : "Avancer" pousse
    // toujours dans la direction où pointe le nez du ROV, quel que soit le cap.
    _bodyVel.set(vel.sway, vel.heave, vel.surge)
        .multiplyScalar(gain)
        .applyQuaternion(orientationQuat());
    const prevX = posWorld.x, prevZ = posWorld.z;
    posWorld.add(_bodyVel);

    // --- Collision LATÉRALE avec le relief (flanc de stalagmite / rocher) ---
    // Si le déplacement horizontal exige de "monter" une pente plus raide que
    // TERRAIN_SLOPE_MAX, c'est un mur de roche : butée (X/Z annulés), le ROV
    // ne traverse pas et ne téléporte pas au sommet. Les pentes douces restent
    // franchissables (glissement par-dessus via l'écrêtage vertical plus bas).
    let latContact = false;
    let latImpact = 0;
    if (decorState.terrain) {
        const stepUp = floorLimitAt(posWorld.x, posWorld.z) - posWorld.y;
        const hDist = Math.hypot(posWorld.x - prevX, posWorld.z - prevZ);
        if (stepUp > 0 && hDist > 1e-4 && stepUp / hDist > TERRAIN_SLOPE_MAX) {
            latContact = true;
            // Vitesse d'impact = norme horizontale du delta monde de la frame
            const hSpeed = Math.hypot(_bodyVel.x, _bodyVel.z);
            if (!surfContacts.lat && hSpeed > IMPACT_MIN_SPEED) latImpact = hSpeed;
            posWorld.x = prevX;
            posWorld.z = prevZ;
            vel.surge *= 0.4; vel.sway *= 0.4;
        }
    }

    // --- Boîte de collision du bassin : 4 parois, fond (plat ou relief), plafond ---
    // Pour chaque axe monde : écrêtage en butée + relevé de la vitesse d'impact
    // (composante du delta monde de la frame, AVANT écrêtage) et de la surface
    // touchée. La vibration n'est déclenchée que sur le contact INITIAL d'une
    // surface (front montant), jamais tant que le ROV reste collé dessus.
    // Le fond est échantillonné dynamiquement SOUS le ROV (relief inclus).
    const floorLim = floorLimitAt(posWorld.x, posWorld.z);
    const bounds = [
        ['x', -WALL_LIMIT, WALL_LIMIT, _bodyVel.x],   // parois ouest / est
        ['z', -WALL_LIMIT, WALL_LIMIT, _bodyVel.z],   // parois nord / sud
        ['y', floorLim, CEIL_Y, _bodyVel.y],          // fond (relief inclus) / plafond
    ];
    let hitBound = false;
    let impactSpeed = 0;
    const contacts = {};
    for (const [ax, lo, hi, v] of bounds) {
        if (posWorld[ax] <= lo) {
            posWorld[ax] = lo; hitBound = true; contacts[ax + '-'] = true;
            if (!surfContacts[ax + '-'] && v < -IMPACT_MIN_SPEED) impactSpeed = Math.max(impactSpeed, -v);
        } else if (posWorld[ax] >= hi) {
            posWorld[ax] = hi; hitBound = true; contacts[ax + '+'] = true;
            if (!surfContacts[ax + '+'] && v > IMPACT_MIN_SPEED) impactSpeed = Math.max(impactSpeed, v);
        }
    }
    if (latContact) contacts.lat = true;
    surfContacts = contacts;
    // Butée physique : amortissement des vitesses corps (glissement le long des parois)
    if (hitBound) { vel.surge *= 0.5; vel.sway *= 0.5; vel.heave *= 0.5; }
    impactSpeed = Math.max(impactSpeed, latImpact);
    if (impactSpeed > 0) triggerImpactRumble(impactSpeed);
}

// Repli d'un angle dans [-π, π] SANS discontinuité visuelle : décaler de ±2π
// ne change ni le quaternion, ni la rotation canvas, ni la bande cyclique du
// HUD. NB : on n'extrait PAS l'attitude via Euler.setFromQuaternion('YXZ'),
// qui rebriderait justement l'axe X à [-90°, +90°] — les intégrateurs
// `current.*` fournissent des angles continus déjà exempts de gimbal lock.
function wrapPi(a) {
    while (a > Math.PI) a -= 2 * Math.PI;
    while (a < -Math.PI) a += 2 * Math.PI;
    return a;
}

// ---------------------------------------------------------------------------
// RETOUR HAPTIQUE (vibration manette proportionnelle à la vitesse d'impact)
// ---------------------------------------------------------------------------
function triggerImpactRumble(impactSpeed) {
    const now = performance.now();
    if (now - lastImpactTime < IMPACT_COOLDOWN_MS) return;   // anti-rebond
    lastImpactTime = now;

    // Force du choc normalisée 0..1 entre le seuil mini et la saturation
    const t = Math.min(1, Math.max(0,
        (impactSpeed - IMPACT_MIN_SPEED) / (IMPACT_MAX_SPEED - IMPACT_MIN_SPEED)));

    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const gp of pads) {
        if (!gp || !gp.connected) continue;
        // API standard (Chrome/Edge) puis repli hapticActuators (Firefox)
        const act = gp.vibrationActuator || (gp.hapticActuators && gp.hapticActuators[0]);
        if (act && typeof act.playEffect === 'function') {
            act.playEffect('dual-rumble', {
                startDelay: 0,
                duration: Math.round(100 + t * 300),   // 100 ms (léger) → 400 ms (violent)
                weakMagnitude: 0.1 + t * 0.9,          // moteurs légers / hautes fréquences
                strongMagnitude: 0.2 + t * 0.8,        // choc sourd / basses fréquences
            }).catch(() => { /* effet refusé (onglet inactif…) : sans conséquence */ });
        } else if (act && typeof act.pulse === 'function') {
            act.pulse(0.2 + t * 0.8, 100 + t * 300);
        }
        break;   // première manette connectée uniquement (cf. readGamepad)
    }
}

// Fallback sans manette : orientation/position proportionnelle à la consigne
// diffusée (télémétrie/IMU), lissée, sans accumulation de vitesse.
function applyProportional() {
    for (const k in vel) vel[k] = 0;
    current.roll  += (target.roll  * MAX_TILT  - current.roll ) * LERP;
    current.pitch += (target.pitch * MAX_TILT  - current.pitch) * LERP;
    current.yaw   += (target.yaw   * MAX_YAW   - current.yaw  ) * LERP;
    // Cible de position exprimée dans le repère corps puis projetée dans le monde
    _bodyVel.set(target.sway, target.heave, target.surge)
        .multiplyScalar(MAX_TRANS)
        .applyQuaternion(orientationQuat());
    posWorld.lerp(_bodyVel, LERP);
    // Respect du fond (relief inclus) même en mode proportionnel
    posWorld.y = Math.max(posWorld.y, floorLimitAt(posWorld.x, posWorld.z));
}

// ---------------------------------------------------------------------------
// RÉGLAGES PHYSIQUES (sliders + persistance localStorage)
// ---------------------------------------------------------------------------
function loadPhysSettings() {
    try {
        const i = parseFloat(localStorage.getItem(PHYS_KEYS.inertia));
        const g = parseFloat(localStorage.getItem(PHYS_KEYS.gain));
        const s = parseFloat(localStorage.getItem(PHYS_KEYS.sens));
        if (!isNaN(i)) physState.inertia = Math.min(0.99, Math.max(0.01, i));
        if (!isNaN(g)) physState.gain = Math.min(5.0, Math.max(0.1, g));
        if (!isNaN(s)) physState.sens = Math.min(1.0, Math.max(0.1, s));
    } catch (e) { /* localStorage indisponible : valeurs par défaut */ }
}

function bindPhysSliders() {
    const si = document.getElementById('phys-inertia');
    const sg = document.getElementById('phys-gain');
    const ss = document.getElementById('phys-sens');
    const vi = document.getElementById('phys-inertia-val');
    const vg = document.getElementById('phys-gain-val');
    const vs = document.getElementById('phys-sens-val');
    if (!si || !sg) return;
    // Refléter l'état chargé (localStorage) sur les widgets
    si.value = physState.inertia.toFixed(2);
    sg.value = physState.gain.toFixed(1);
    if (ss) ss.value = physState.sens.toFixed(2);
    const render = () => {
        if (vi) vi.textContent = physState.inertia.toFixed(2);
        if (vg) vg.textContent = physState.gain.toFixed(1) + '×';
        if (vs) vs.textContent = Math.round(physState.sens * 100) + '%';
    };
    si.addEventListener('input', () => {
        physState.inertia = parseFloat(si.value);
        render();
        try { localStorage.setItem(PHYS_KEYS.inertia, si.value); } catch (e) { /* ignore */ }
    });
    sg.addEventListener('input', () => {
        physState.gain = parseFloat(sg.value);
        render();
        try { localStorage.setItem(PHYS_KEYS.gain, sg.value); } catch (e) { /* ignore */ }
    });
    if (ss) ss.addEventListener('input', () => {
        physState.sens = parseFloat(ss.value);
        render();
        try { localStorage.setItem(PHYS_KEYS.sens, ss.value); } catch (e) { /* ignore */ }
    });
    render();
}

// ---------------------------------------------------------------------------
// BOUTONS D'ACTION (armement, éclairage, reset position, vues caméra)
// ---------------------------------------------------------------------------
let armed = false;
let lightOn = false;

function setArmedUI(state) {
    armed = !!state;
    const b = document.getElementById('btn-arm');
    if (!b) return;
    b.classList.toggle('armed', armed);
    b.textContent = armed ? '🟢 ARMÉ' : '🔒 DÉSARMÉ';
}

function setLightUI(on) {
    lightOn = !!on;
    const b = document.getElementById('btn-light');
    if (b) b.classList.toggle('active', lightOn);
    // Synchronisation avec le simulateur de plongée : le bouton 💡 Lumière et
    // l'interrupteur "Projecteurs LED" pilotent les MÊMES SpotLights 3D.
    diveState.led = lightOn;
    const cl = document.getElementById('dive-led');
    if (cl) cl.checked = lightOn;
    applyLed();
    try { localStorage.setItem(DIVE_KEYS.led, lightOn ? '1' : '0'); } catch (e) { /* ignoré */ }
}

// Replace le ROV au centre de la scène (position, attitude et vitesses à zéro).
function resetPose() {
    posWorld.set(0, 0, 0);
    current.yaw = current.roll = current.pitch = 0;
    for (const k in vel) vel[k] = 0;
}

function setCameraView(x, y, z, btnId) {
    setFpvUI(false);   // les vues prédéfinies repassent toujours en vue externe
    camera.position.set(x, y, z);
    controls.target.set(0, 0, 0);
    saveCameraState();   // la vue choisie est retrouvée au prochain démarrage
    ['btn-view-34', 'btn-view-top', 'btn-view-side'].forEach((id) => {
        const b = document.getElementById(id);
        if (b) b.classList.toggle('active', id === btnId);
    });
}

// Bascule vue externe (orbitale) ↔ vue caméra embarquée FPV. Les OrbitControls
// sont désactivés en FPV pour éviter tout conflit d'orientation ; le libellé
// du bouton indique la vue vers laquelle un clic bascule.
function setFpvUI(on) {
    isFpvActive = !!on;
    if (controls) controls.enabled = !isFpvActive;
    const b = document.getElementById('btn-fpv');
    if (b) {
        b.classList.toggle('active', isFpvActive);
        b.textContent = isFpvActive ? '🌐 Vue Externe' : '📹 Vue Caméra ROV';
    }
}

async function postAction(url) {
    try {
        const r = await fetch(url, { method: 'POST' });
        return r.ok ? await r.json() : null;
    } catch (e) { return null; }
}

function initActionButtons() {
    const bArm = document.getElementById('btn-arm');
    const bLight = document.getElementById('btn-light');
    const bReset = document.getElementById('btn-reset');
    const bV34 = document.getElementById('btn-view-34');
    const bVTop = document.getElementById('btn-view-top');
    const bVSide = document.getElementById('btn-view-side');
    if (bArm) bArm.addEventListener('click', async () => {
        const res = await postAction(armed ? '/api/control/disarm' : '/api/control/arm');
        if (res) setArmedUI(res.status === 'armed');
    });
    if (bLight) bLight.addEventListener('click', async () => {
        const res = await postAction(`/api/control/light/${lightOn ? 0 : 100}`);
        if (res) setLightUI(res.light > 0);
    });
    if (bReset) bReset.addEventListener('click', resetPose);
    if (bV34) bV34.addEventListener('click', () => setCameraView(1.5, 1.5, 2.5, 'btn-view-34'));
    if (bVTop) bVTop.addEventListener('click', () => setCameraView(0, 4.5, 0.01, 'btn-view-top'));
    if (bVSide) bVSide.addEventListener('click', () => setCameraView(3.5, 0.5, 0, 'btn-view-side'));
    const bFpv = document.getElementById('btn-fpv');
    if (bFpv) bFpv.addEventListener('click', () => setFpvUI(!isFpvActive));
    // État initial (armement + éclairage) récupéré du backend
    fetch('/api/control/status')
        .then((r) => (r.ok ? r.json() : null))
        .then((st) => {
            if (!st) return;
            if (typeof st.armed === 'boolean') setArmedUI(st.armed);
            if (typeof st.light === 'number') setLightUI(st.light > 0);
        })
        .catch(() => { /* backend hors ligne : état par défaut */ });
}

// ---------------------------------------------------------------------------
// BOUCLE D'ANIMATION
// ---------------------------------------------------------------------------
function animate() {
    requestAnimationFrame(animate);

    // Temps écoulé (borne haute anti-saut après onglet inactif) pour la faune/flore
    const dt = Math.min(clock.getDelta(), 0.05);
    const time = clock.elapsedTime;

    // Lecture directe de la manette (prioritaire, réactivité immédiate)
    const gpDof = readGamepad();
    if (gpDof) {
        DOF_ORDER.forEach((k) => { target[k] = gpDof[k]; });
        sendMove(gpDof);
        updateDofPanel();
    }
    setGpBadge(gpConnected);

    // Mise à jour de l'état : moteur physique (manette) ou fallback proportionnel.
    if (gpConnected) {
        integratePhysics();
    } else {
        applyProportional();
    }

    if (modelGroup) {
        // Orientation : yaw (Y), pitch (X), roll (Z, signe inversé pour gîte droite).
        modelGroup.rotation.set(current.pitch, current.yaw, -current.roll, 'YXZ');
        // Translation : position monde intégrée depuis les vitesses en repère corps.
        modelGroup.position.copy(posWorld);
    }

    // Vie sous-marine : ondulation des algues (uniform shader) + nage des poissons
    updateLife(dt, time);

    // Simulateur de plongée : extinction de la lumière du jour avec la
    // profondeur + widget horizon artificiel (roll/pitch/cap/profondeur).
    updateDepthAmbience();
    updateHorizon();

    // OrbitControls uniquement en vue externe ; rendu via la caméra active.
    if (!isFpvActive) controls.update();
    renderer.render(scene, isFpvActive ? fpvCamera : camera);
}

// ---------------------------------------------------------------------------
// PANNEAUX FLOTTANTS : repli (collapse) + glisser-déplacer + premier plan
// État persisté dans localStorage : { id: { x, y, collapsed } }
// ---------------------------------------------------------------------------
const PANELS_KEY = 'mapping3d.panels';
const PANEL_IDS = ['actions-panel', 'life-panel', 'decor-panel', 'phys-panel', 'motors-panel', 'dof-panel', 'dive-panel', 'horizon-panel'];
const DRAG_THRESHOLD = 5;   // px : en-deçà, un pointerdown+up = clic (repli)
let panelsState = {};        // id -> { x, y, collapsed }
let panelZTop = 20;          // compteur z-index : le dernier panneau touché passe devant

function loadPanelsState() {
    try {
        const d = JSON.parse(localStorage.getItem(PANELS_KEY) || 'null');
        if (d && typeof d === 'object') panelsState = d;
    } catch (e) { panelsState = {}; }
}

function savePanelsState() {
    try { localStorage.setItem(PANELS_KEY, JSON.stringify(panelsState)); } catch (e) { /* ignoré */ }
}

// Positionne un panneau en le maintenant intégralement dans l'écran
function placePanel(panel, x, y) {
    const cx = Math.min(Math.max(0, x), Math.max(0, window.innerWidth - panel.offsetWidth));
    const cy = Math.min(Math.max(0, y), Math.max(0, window.innerHeight - panel.offsetHeight));
    panel.style.left = cx + 'px';
    panel.style.top = cy + 'px';
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
}

function bringToFront(panel) {
    panel.style.zIndex = String(++panelZTop);
}

function initFloatingPanels() {
    loadPanelsState();

    PANEL_IDS.forEach((id) => {
        const panel = document.getElementById(id);
        const title = panel ? panel.querySelector('h2') : null;
        if (!panel || !title) return;
        const st = panelsState[id] || (panelsState[id] = {});

        // --- Restructuration : en-tête (titre + bouton ▲/▼) et corps repliable ---
        const body = document.createElement('div');
        body.className = 'panel-body';
        while (panel.firstChild) body.appendChild(panel.firstChild);
        const head = document.createElement('div');
        head.className = 'panel-head';
        head.appendChild(title);   // sort le h2 du corps
        const btn = document.createElement('button');
        btn.className = 'panel-toggle';
        btn.title = 'Replier / Déplier le panneau';
        head.appendChild(btn);
        panel.appendChild(head);
        panel.appendChild(body);

        // --- Repli / dépli (état restauré depuis localStorage) ---
        const applyCollapsed = (c) => {
            panel.classList.toggle('collapsed', c);
            btn.textContent = c ? '▼' : '▲';
        };
        const toggleCollapsed = () => {
            st.collapsed = !st.collapsed;
            applyCollapsed(st.collapsed);
            savePanelsState();
        };
        applyCollapsed(!!st.collapsed);
        btn.addEventListener('click', (e) => { e.stopPropagation(); toggleCollapsed(); });

        // --- Position restaurée (clampée si la résolution a changé) ---
        if (Number.isFinite(st.x) && Number.isFinite(st.y)) placePanel(panel, st.x, st.y);

        // --- Premier plan dès qu'on touche le panneau (clic ou drag) ---
        panel.addEventListener('pointerdown', () => bringToFront(panel), true);

        // --- Glisser-déplacer via la barre de titre (Pointer Events) ---
        let drag = null;
        head.addEventListener('pointerdown', (e) => {
            if (e.pointerType === 'mouse' && e.button !== 0) return;
            if (e.target === btn) return;   // le bouton gère son propre clic
            const r = panel.getBoundingClientRect();
            drag = { startX: e.clientX, startY: e.clientY, origX: r.left, origY: r.top, moved: false };
            head.setPointerCapture(e.pointerId);
        });
        head.addEventListener('pointermove', (e) => {
            if (!drag) return;
            const dx = e.clientX - drag.startX;
            const dy = e.clientY - drag.startY;
            if (!drag.moved) {
                if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
                drag.moved = true;
                panel.classList.add('dragging');
            }
            placePanel(panel, drag.origX + dx, drag.origY + dy);
        });
        head.addEventListener('pointerup', () => {
            if (!drag) return;
            panel.classList.remove('dragging');
            if (drag.moved) {
                const r = panel.getBoundingClientRect();
                st.x = Math.round(r.left);
                st.y = Math.round(r.top);
                savePanelsState();
            } else {
                toggleCollapsed();   // clic simple sur l'en-tête = repli/dépli
            }
            drag = null;
        });
        head.addEventListener('pointercancel', () => {
            panel.classList.remove('dragging');
            drag = null;
        });
    });

    // Repositionnement dans les limites de l'écran après un redimensionnement
    window.addEventListener('resize', () => {
        PANEL_IDS.forEach((id) => {
            const st = panelsState[id];
            const panel = document.getElementById(id);
            if (panel && st && Number.isFinite(st.x) && Number.isFinite(st.y)) {
                placePanel(panel, st.x, st.y);
            }
        });
    });
}

// ---------------------------------------------------------------------------
// OVERLAY
// ---------------------------------------------------------------------------
function hideOverlay() { document.getElementById('overlay').classList.add('hidden'); }
function showError(msg, sub) {
    const ov = document.getElementById('overlay');
    ov.classList.remove('hidden');
    ov.classList.add('error');
    document.getElementById('overlay-msg').textContent = '⚠️ ' + msg;
    document.getElementById('overlay-sub').textContent = sub || '';
}

// ---------------------------------------------------------------------------
// DÉMARRAGE
// ---------------------------------------------------------------------------
try {
    loadPhysSettings();
    loadDecorSettings();
    loadLifeSettings();
    loadDiveSettings();   // fixe FLOOR_Y avant la création de la scène
    initScene();
    initProjectors();
    buildPanels();
    initFloatingPanels();
    bindPhysSliders();
    bindDecorControls();
    bindLifeControls();
    bindDiveControls();
    initHorizon();
    initActionButtons();
    loadModel();
    connectWS();
    loadGamepadProfile();
    setInterval(loadGamepadProfile, 5000);   // suivre les changements de profil
    window.addEventListener('gamepadconnected', loadGamepadProfile);
    // Rechargement immédiat si la page de config manette sauvegarde le mapping
    // (autre onglet → événement storage ; même page → événement custom)
    window.addEventListener('storage', (e) => {
        if (e.key === GP_LS_MAPPING_KEY) loadGamepadProfile();
    });
    window.addEventListener('gamepad-mapping-changed', loadGamepadProfile);
    animate();
} catch (e) {
    console.error(e);
    showError('Initialisation 3D impossible',
        'Three.js n\'a pas pu être chargé depuis le CDN. Connectez le navigateur à Internet ou vendorisez Three.js localement.');
}
