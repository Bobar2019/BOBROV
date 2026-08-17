// ============================================================================
// BOB-ROV · Sub-Simulator — Moteur de simulation sous-marine 6DOF
// Scene Three.js autonome, gamepad, physique hydrodynamique, OSD cockpit
// ============================================================================
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// --- Masquer les avertissements GLTFLoader pour extensions PBR non supportées ---
{
    const _origWarn = console.warn;
    console.warn = function (...args) {
        const msg = (args[0] || '').toString();
        if (msg.includes('KHR_materials_pbrSpecularGlossiness') || msg.includes('KHR_materials_unlit')) return;
        _origWarn.apply(console, args);
    };
}

// --- Constantes ROV ---
const MODEL_LENGTH = 0.4;
const MOTOR_NAMES = {
    1: 'M1 Av-D', 2: 'M2 Ar-D', 3: 'M3 Ar-G', 4: 'M4 Av-G',
    5: 'M5 Vt Av-D', 6: 'M6 Vt Ar-D', 7: 'M7 Vt Ar-G', 8: 'M8 Vt Av-G',
};
const H_MOTORS = [1, 2, 3, 4];
const V_MOTORS = [5, 6, 7, 8];
const DOF_ORDER = ['surge', 'sway', 'heave', 'yaw', 'roll', 'pitch'];
const DOF_LABELS = { surge: 'Surge', sway: 'Sway', heave: 'Heave', yaw: 'Yaw', roll: 'Roll', pitch: 'Pitch' };

// --- Physique ---
const ROT_ACCEL = 0.0024;
const TRANS_ACCEL = 0.0024;
const HULL_CLEARANCE = 0.25;
const CEIL_Y = 0.0;
const IMPACT_MIN_SPEED = 0.002;
const IMPACT_MAX_SPEED = 0.020;
const IMPACT_COOLDOWN_MS = 300;

// --- État global ---
let scene, camera, renderer, controls;
let fpvCamera, isFpvActive = false;
let followROV = true;  // true = orbite suit le ROV, false = caméra libre
let modelGroup;
let gridHelper, shadowGround;
let wallsGroup = null, terrainMesh = null;
let sunDir, sunFill, sunAmbient;
let surfaceMesh = null, causticsMesh = null, godRaysGroup = null;
const clock = new THREE.Clock();

const physState = { inertia: 0.90, gain: 1.0, sens: 0.45, rollSens: 1.0, pitchSens: 1.0, speedBoost: 1.0 };
const diveState = { depth: 30, visibility: 25, extent: 100, walls: true, terrain: false,
                    beachExtent: 10, beachDepthPct: 5,    // plage : 10% largeur, 5% profondeur
                    reefExtent: 20, reefDepthPct: 20,    // récif : 20% largeur, 20% profondeur
                    led: false, ledIntensity: 80, ledTilt: 12 };
let FLOOR_Y = -30.0;
let WALL_LIMIT = 9.5;
let WALL_POS = 10.0;

// --- Topographie par zones % (pentes tangentes smoothstep) ---
// REEF_DEPTH devient dynamique (calculé depuis les % zones)
let REEF_DEPTH = 20;    // m : profondeur du sommet du plateau récifal (mis à jour par applyBasinSize)
const HEIGHT_MAX   = 10.0;   // amplitude max du relief (mètres)
const TERRAIN_SLOPE_MAX = 1.7; // ~60° : pente = butée latérale
const SUN_FADE_DEPTH = 11;   // m : profondeur d'extinction lumière après REEF_DEPTH

/** Profondeur absolue du bas de la plage (en mètres, négatif) */
function beachBottomDepth() { return diveState.depth * diveState.beachDepthPct / 100; }
/** Profondeur absolue du bas du récif (en mètres, négatif) */
function reefBottomDepth()  { return diveState.depth * (diveState.beachDepthPct + diveState.reefDepthPct) / 100; }
/** Rayon de la zone fond/abysse depuis le centre (en mètres) */
function fondZoneRadius()   { return WALL_POS * Math.max(0, 100 - diveState.beachExtent - diveState.reefExtent) / 100; }

// Persistance localStorage des réglages
const SETTINGS_KEY = 'subsim.settings';

const target = { surge: 0, sway: 0, heave: 0, yaw: 0, roll: 0, pitch: 0 };
const vel = { surge: 0, sway: 0, heave: 0, yaw: 0, roll: 0, pitch: 0 };
const current = { yaw: 0, roll: 0, pitch: 0 };
const posWorld = new THREE.Vector3();
const _bodyVel = new THREE.Vector3();
const _eulerTmp = new THREE.Euler();
const _quatTmp = new THREE.Quaternion();
const raycaster = new THREE.Raycaster();
const mouseNDC = new THREE.Vector2();
let motorState = {};
let armed = false;
let surfContacts = {};
let lastImpactTime = 0;
let rovFitScale = 1;
const rovFitOffset = new THREE.Vector3();
const envMats = [];

// --- Projecteurs LED (projecteur.glb) ---
let projGroup = null;
let projSpots = [];
const LED_MAX_INTENSITY = 8000;

// --- Vie sous-marine (InstancedMesh procéduraux) ---
const ALGAE_MAX_TUFTS = 500, ALGAE_BLADES = 5, FISH_MAX = 500;
const FISH_SCARE_DIST = 2.2, FISH_SCHOOLS = 8, LIFE_SPAWN_GUARD = 2.0;
const CORAL_CAP = [500, 400, 500, 1400];
const CORAL_PER_M2 = [0.10, 0.06, 0.10, 0.90];
const ALGAE_PER_M2 = 0.22;
const ABYSS_MAX = 36;
const PIKE_COUNT = 2;
const algaeUniforms = { uTime: { value: 0 }, uSway: { value: 0.5 } };
let algaeMesh = null, fishMesh = null, abyssMesh = null, abyssGlowMesh = null;
let coralMeshes = null, pikeGroup = null;
const algaeData = [];
const coralData = [[], [], [], []];
const fishData = [];
const abyssData = [];
const pikeData = [];
let wallTex = null, wallNrm = null, wallMat = null, terrainTex = null, sandTex = null, abyssTex = null;
let terrainBiomeUniforms = null;  // seuils de biomes pour couleurs vertex du terrain
const _lifeM4 = new THREE.Matrix4();
const _lifeQ = new THREE.Quaternion();
const _lifeQ2 = new THREE.Quaternion();
const _lifeV = new THREE.Vector3();
const _lifeScl = new THREE.Vector3();
const _Y_AXIS = new THREE.Vector3(0, 1, 0);
const _Z_AXIS = new THREE.Vector3(0, 0, 1);
const _steer = new THREE.Vector3();
const _fleeV = new THREE.Vector3();
const _terrNrm = new THREE.Vector3();
const _pikeTarget = new THREE.Vector3();
const _SURF_COL = new THREE.Color(0x0e3a55);
const _DEEP_COL = new THREE.Color(0x010409);
const _waterCol = new THREE.Color();
let _lastSunF = -1;
let _lastEnvCount = 0;

// État environnement (sera lu depuis scene_3d_config.json)
let envState = {
    algae: true, algaeDensity: 0.22, algaeLen: 1.0, current: 0.5,
    fish: true, fishCount: 360, fishSpeed: 1.0,
    corals: true, reefDensity: 100,
    abyssCreatures: true, abyssDensity: 100,
    pikes: true, pikeCount: 2,
    compactZone: 0,  // 0-100% : 0 = bassin complet, 100 = zone 20m×20m
    waves: true, waveHeight: 0.5, waveSpeed: 1.0,
    caustics: true, causticsIntensity: 0.7,
    godrays: true, godraysIntensity: 0.5,
};

// Gamepad
const gpAxisMap = {};
const gpButtonMap = {};
let gpComboList = [];
let gpComboMembers = new Set();
let gpDeadzone = 0.12;
let gpConnected = false;
let gpPrevPressed = {};
let gpPrevCombo = {};
const GP_LS_MAPPING_KEY = 'rov.gamepad.mapping';
const AXIS_NAME_TO_INDEX = { LEFT_X: 0, LEFT_Y: 1, RIGHT_X: 2, RIGHT_Y: 3, L2: 4, R2: 5 };
const BUTTON_NAME_TO_INDEX = {
    CROSS: 0, CIRCLE: 1, SQUARE: 2, TRIANGLE: 3,
    L1: 4, R1: 5, L2: 6, R2: 7,
    SHARE: 8, OPTIONS: 9, L3: 10, R3: 11,
    DPAD_UP: 12, DPAD_DOWN: 13, DPAD_LEFT: 14, DPAD_RIGHT: 15, PS: 16, TOUCHPAD: 17,
};
const BUTTON_DOF = {
    move_forward: ['surge', +1], move_backward: ['surge', -1],
    turn_left: ['yaw', -1], turn_right: ['yaw', +1],
    move_up: ['heave', +1], move_down: ['heave', -1],
    ascent: ['heave', +1], descent: ['heave', -1],
    roll_left: ['roll', -1], roll_right: ['roll', +1], roll: ['roll', +1],
    pitch_up: ['pitch', +1], pitch_down: ['pitch', -1], pitch: ['pitch', +1],
};
const UI_BUTTON_ACTIONS = {
    fpv_toggle: () => setFpv(!isFpvActive),
    reset_position: () => resetPose(),
};

// WebSocket
let ws = null, reconnectTimer = null, reconnectDelay = 1000;

// Objets scène 3D config
let scene3dObjects = [];   // [{ config, group, mixer, ... }]
let scene3dMixers = [];

// FPS counter
let fpsFrames = 0, fpsLast = performance.now(), fpsValue = 0;

// OSD
let osdCanvas, osdCtx, osdDpr = 1;
const osdFilter = { roll1: 0, roll2: 0, pitch1: 0, pitch2: 0 };
const simTelem = { depth: 0, temperature: 20, heading: 0, battery: 100, roll: 0, pitch: 0, armed: false };

// Config OSD (persistée dans subsim.settings.osd)
const osdConfig = {
    horizonVisible: true,    // Afficher/masquer l'horizon artificiel
    horizonOpacity: 100,     // 0-100 %
    horizonDiameter: 18,     // % de min(w,h) — défaut 18 = 0.18
};

// ===========================================================================
// INITIALISATION SCÈNE THREE.JS
// ===========================================================================
function initScene() {
    const container = document.getElementById('sim-container');
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b1020);
    scene.fog = new THREE.FogExp2(0x0b1020, 1.7 / diveState.visibility);

    camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.05, Math.max(100, diveState.depth * 2.5));
    camera.position.set(3, 3, 5);

    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(innerWidth, innerHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(renderer.domElement);

    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();

    // Éclairage
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
    dir.shadow.camera.near = 0.5; dir.shadow.camera.far = 80;
    dir.shadow.camera.left = -15; dir.shadow.camera.right = 15;
    dir.shadow.camera.top = 15; dir.shadow.camera.bottom = -15;
    scene.add(dir);
    const fill = new THREE.DirectionalLight(0x88aaff, 0.5);
    fill.position.set(-6, 4, -8);
    scene.add(fill);
    sunFill = fill;

    // Sol
    gridHelper = new THREE.GridHelper(20, 20, 0x35d0ba, 0x24304d);
    gridHelper.position.y = FLOOR_Y;
    gridHelper.material.transparent = true;
    scene.add(gridHelper);
    shadowGround = new THREE.Mesh(
        new THREE.PlaneGeometry(20, 20),
        new THREE.ShadowMaterial({ opacity: 0.35 })
    );
    shadowGround.rotation.x = -Math.PI / 2;
    shadowGround.position.y = FLOOR_Y;
    shadowGround.receiveShadow = true;
    scene.add(shadowGround);

    // Groupe ROV
    modelGroup = new THREE.Group();
    scene.add(modelGroup);
    dir.target = modelGroup;

    // Caméra FPV
    fpvCamera = new THREE.PerspectiveCamera(80, innerWidth / innerHeight, 0.01, Math.max(100, diveState.depth * 2.5));
    fpvCamera.position.set(-(MODEL_LENGTH / 2 + 0.02), 0.05, 0);
    fpvCamera.rotation.y = Math.PI / 2;
    modelGroup.add(fpvCamera);

    // OrbitControls — vue extérieure libre (pan/zoom/orbit sur toute la scène)
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.enablePan = true;
    controls.screenSpacePanning = false;  // pan horizontal (pas le long de l'axe Y écran)
    controls.panSpeed = 0.8;
    controls.rotateSpeed = 0.6;
    controls.zoomSpeed = 0.25;  // zoom fin pour trackpad (style Onshape)
    controls.target.set(0, 0, 0);
    controls.minDistance = 0.3;
    controls.maxDistance = Math.max(50, diveState.depth * 2.0);
    // Quand l'utilisateur interagit (orbit/pan/zoom), couper le suivi ROV
    controls.addEventListener('start', () => { if (!isFpvActive) followROV = false; });
    controls.addEventListener('change', () => { if (!isFpvActive) followROV = false; });

    // Zoom vers le point sous le curseur (raycast)
    // + Normalisation trackpad pinch pour un zoom proportionnel (style Onshape)
    let wheelGestureTimer = null;
    renderer.domElement.addEventListener('wheel', (e) => {
        if (isFpvActive) return;

        // Détection trackpad pinch : ctrlKey=true sur la plupart des navigateurs
        // Normalize deltaY pour éviter l'accumulation exponentielle
        const isPinch = e.ctrlKey && e.deltaMode === 0;
        if (isPinch) {
            // Limiter deltaY pour un zoom proportionnel (pas exponentiel)
            const maxDelta = 30;
            const clampedDelta = Math.max(-maxDelta, Math.min(maxDelta, e.deltaY));
            // Créer un nouvel événement avec deltaY borné
            const smoothEvent = new WheelEvent('wheel', {
                deltaY: clampedDelta,
                deltaX: e.deltaX,
                deltaMode: 0,
                clientX: e.clientX,
                clientY: e.clientY,
                bubbles: true,
                cancelable: true,
            });
            e.preventDefault();
            e.stopImmediatePropagation();
            renderer.domElement.dispatchEvent(smoothEvent);
        }

        // Premier tick d'un nouveau geste de zoom → raycast pour trouver la cible
        if (!wheelGestureTimer) {
            const rect = renderer.domElement.getBoundingClientRect();
            mouseNDC.x =  ((e.clientX - rect.left) / rect.width)  * 2 - 1;
            mouseNDC.y = -((e.clientY - rect.top)  / rect.height) * 2 + 1;
            raycaster.setFromCamera(mouseNDC, camera);
            const hits = raycaster.intersectObjects(scene.children, true);
            // Ignorer les hits du ROV lui-même
            const hit = hits.find(h => {
                let p = h.object;
                while (p) { if (p === modelGroup) return false; p = p.parent; }
                return true;
            });
            if (hit) {
                controls.target.copy(hit.point);
                followROV = false;
                updateFollowBadge();
            }
        }
        // Debounce : considérer le geste terminé après 200ms sans scroll
        clearTimeout(wheelGestureTimer);
        wheelGestureTimer = setTimeout(() => { wheelGestureTimer = null; }, 200);
    }, { capture: true });

    window.addEventListener('resize', onResize);
}

function onResize() {
    const w = innerWidth, h = innerHeight;
    camera.aspect = w / h; camera.updateProjectionMatrix();
    fpvCamera.aspect = w / h; fpvCamera.updateProjectionMatrix();
    renderer.setSize(w, h);
    resizeOsdCanvas();
}

// ===========================================================================
// CHARGEMENT MODÈLE ROV
// ===========================================================================
function loadModel() {
    const loader = new GLTFLoader();
    loader.load('/static/models/bob_rov_3D.glb', (gltf) => {
        const model = gltf.scene;
        const box = meshBoundingBox(model);
        const size = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z) || 1;
        const scale = MODEL_LENGTH / maxDim;
        model.scale.setScalar(scale);
        const scaledBox = meshBoundingBox(model);
        const scaledCenter = scaledBox.getCenter(new THREE.Vector3());
        model.position.sub(scaledCenter);

        const maxAniso = renderer.capabilities.getMaxAnisotropy();
        model.traverse((o) => {
            if (o.isMesh) {
                o.castShadow = true; o.receiveShadow = true;
                const mats = Array.isArray(o.material) ? o.material : [o.material];
                mats.forEach((m) => {
                    if (!m) return;
                    if (m.map) { m.map.anisotropy = maxAniso; m.map.needsUpdate = true; }
                    m.needsUpdate = true;
                    envMats.push(m);
                });
            }
        });
        modelGroup.add(model);
        rovFitScale = scale;
        rovFitOffset.copy(scaledCenter).negate();
        // Initialiser et charger les projecteurs LED
        initProjectors();
        loadProjectorModel();
        hideOverlay();
    }, (xhr) => {
        if (xhr.total) {
            const pct = Math.round((xhr.loaded / xhr.total) * 100);
            document.getElementById('sim-overlay-sub').textContent = `bob_rov_3D.glb — ${pct}%`;
        }
    }, (err) => {
        console.error('Échec chargement GLB:', err);
        showError('Impossible de charger le modèle 3D');
    });
}

// ===========================================================================
// DÉCOR : parois rocheuses + relief Blue Hole + vie sous-marine
// ===========================================================================

// Bruit de valeur 2D déterministe (hash entier + interpolation lisse)
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
function fbm2(x, z) {
    return 0.55 * noise2(x, z) + 0.30 * noise2(x * 2.1, z * 2.1) + 0.15 * noise2(x * 4.3, z * 4.3);
}

// Hauteur du relief : Blue Hole (plateau corallien + fosse abyssale + plages proportionnelles)
// Le plateau reste à une profondeur fixe (biologie récifale ~20-25 m).
// La fosse descend TOUJOURS jusqu'à FLOOR_Y quelle que soit la profondeur du bassin.
// Les plages remontent proportionnellement de la bordure (80% WALL_POS) jusqu'à la surface.
function terrainHeightAt(x, z) {
    // === Terrain par zones % : pentes tangentes smoothstep ===
    // Zones définies par distance au centre en % de WALL_POS :
    //   centre ←─── fond ───→ ←─── récif ───→ ←─── plage ───→ bord
    //   (FLOOR_Y)             (pente raide)    (pente douce)  (surface)

    const dist = Math.hypot(x, z);
    const distPct = dist / WALL_POS;  // 0 = centre, 1 = bord

    // Limites des zones en % de WALL_POS
    const beachFrac = diveState.beachExtent / 100;  // ex: 0.10
    const reefFrac  = diveState.reefExtent / 100;   // ex: 0.20
    const beachInner = 1.0 - beachFrac;             // début plage (depuis le bord)
    const reefInner  = Math.max(0, beachInner - reefFrac); // début récif

    // Profondeurs absolues (négatif)
    const surfaceY   = CEIL_Y - 0.5;                // ~surface
    const beachBotY  = -beachBottomDepth();          // bas de la plage
    const reefBotY   = -reefBottomDepth();           // bas du récif
    const floorY     = FLOOR_Y;                      // fond du bassin

    // Relief corallien : bruit fractal multi-échelle pour aspect rocheux
    const reefNoise = diveState.terrain
        ? (Math.pow(fbm2(x * 0.35 + 7.3, z * 0.35 + 3.1), 1.4) * 0.30          // gros blocs rocheux
           + fbm2(x * 1.1 + 19.7, z * 1.1 + 5.9) * 0.22                          // détail moyen
           + fbm2(x * 3.2 + 41.0, z * 3.2 + 13.7) * 0.08)                        // micro-relief rocheux
           * Math.min(diveState.depth * 0.05, 4)
        : 0;

    // Bassin trop peu profond : pas de zones distinctes → pente simple
    if (diveState.depth < 3) {
        const t = THREE.MathUtils.smoothstep(distPct, 0, 1);
        return floorY + (surfaceY - floorY) * t;
    }

    let computedY;

    if (distPct >= beachInner) {
        // ── PLAGE : pente douce de beachBotY → surfaceY ──
        const t = THREE.MathUtils.smoothstep(distPct, beachInner, 1.0);
        const s = t * t * (3 - 2 * t);  // cubique douce
        computedY = beachBotY + (surfaceY - beachBotY) * s;
        // Fondu du relief rocheux → sable lisse (transition progressive)
        const sandBlend = 1.0 - THREE.MathUtils.smoothstep(distPct, beachInner, beachInner + (1.0 - beachInner) * 0.4);
        computedY += reefNoise * sandBlend * 0.5;
    } else if (distPct >= reefInner) {
        // ── RÉCIF : pente de reefBotY → beachBotY + relief ──
        const t = THREE.MathUtils.smoothstep(distPct, reefInner, beachInner);
        const s = t * t * (3 - 2 * t);
        computedY = reefBotY + (beachBotY - reefBotY) * s + reefNoise;
    } else {
        // ── FOND / ABYSSE : plat au fond avec légère variation + fondu relief rocheux ──
        const floorVar = diveState.terrain
            ? fbm2(x * 0.06 + 3.7, z * 0.06 + 8.2) * Math.min(diveState.depth * 0.03, 3)
            : 0;
        // Pente douce du bord du fond vers le centre (pour éviter un mur vertical)
        if (reefInner > 0.01) {
            const t = THREE.MathUtils.smoothstep(distPct, 0, reefInner);
            const s = t * t * (3 - 2 * t);
            computedY = floorY + floorVar + (reefBotY - floorY) * s;
            // Fondu du relief rocheux près de la limite récif (transition douce)
            const reefProximity = THREE.MathUtils.smoothstep(distPct, reefInner * 0.5, reefInner);
            computedY += reefNoise * reefProximity;
        } else {
            computedY = floorY + floorVar;
        }
    }

    return Math.max(computedY, FLOOR_Y);
}

function floorLimitAt(x, z) {
    const base = diveState.terrain ? terrainHeightAt(x, z) : FLOOR_Y;
    return Math.min(base + HULL_CLEARANCE, CEIL_Y - 0.3);
}

// Hauteur du relief telle que RENDUE par le maillage (interpolation bilinéaire)
function terrainMeshHeightAt(x, z) {
    if (!diveState.terrain || !terrainMesh) return FLOOR_Y;
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

function terrainNormalAt(x, z) {
    if (!diveState.terrain || !terrainMesh) return _terrNrm.set(0, 1, 0);
    const e = 0.75;
    const hL = terrainHeightAt(x - e, z), hR = terrainHeightAt(x + e, z);
    const hD = terrainHeightAt(x, z - e), hU = terrainHeightAt(x, z + e);
    return _terrNrm.set(hL - hR, 2 * e, hD - hU).normalize();
}

function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Texture de roche procédurale (canvas 256²)
function makeRockTexture() {
    const size = 512;
    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(size, size);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const n1 = fbm2(x * 0.045, y * 0.045);
            const n2 = fbm2(x * 0.18 + 41, y * 0.18 + 17);
            const detail = fbm2(x * 0.4 + 83, y * 0.4 + 57);
            const n = n1 * 0.55 + n2 * 0.3 + detail * 0.15;
            const v = 35 + n * 85;
            const i = (y * size + x) * 4;
            // Variations naturelles : terre, gris, mousse
            img.data[i]     = v * (0.90 + n1 * 0.18);
            img.data[i + 1] = v * (0.85 + n2 * 0.10);
            img.data[i + 2] = v * (0.72 + detail * 0.14);
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

// Texture de sable blanc procédurale (plages peu profondes)
function makeSandTexture() {
    const size = 512;
    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(size, size);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const n1 = fbm2(x * 0.06 + 5.3, y * 0.06 + 8.1);
            const n2 = fbm2(x * 0.25 + 12, y * 0.25 + 7);
            const grain = fbm2(x * 0.8 + 33, y * 0.8 + 11);
            const n = n1 * 0.4 + n2 * 0.35 + grain * 0.25;
            const v = 180 + n * 55;
            const i = (y * size + x) * 4;
            img.data[i]     = Math.min(255, v * 1.02);
            img.data[i + 1] = Math.min(255, v * 0.96);
            img.data[i + 2] = Math.min(255, v * 0.78);
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

// Texture de limon sombre abyssal (fonds profonds)
function makeAbyssTexture() {
    const size = 512;
    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(size, size);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const n1 = fbm2(x * 0.04 + 20, y * 0.04 + 40);
            const n2 = fbm2(x * 0.15 + 60, y * 0.15 + 30);
            const n = n1 * 0.6 + n2 * 0.4;
            const v = 20 + n * 35;
            const i = (y * size + x) * 4;
            img.data[i]     = v * 0.7;
            img.data[i + 1] = v * 0.85;
            img.data[i + 2] = v * 1.1;
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
// Normal map procédural pour relief rocheux
function makeRockNormalMap() {
    const size = 512;
    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(size, size);
    const str = 3.0;
    const sc = 0.06;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const hL = fbm2((x - 1) * sc, y * sc);
            const hR = fbm2((x + 1) * sc, y * sc);
            const hU = fbm2(x * sc, (y - 1) * sc);
            const hD = fbm2(x * sc, (y + 1) * sc);
            let nx = (hL - hR) * str;
            let ny = (hU - hD) * str;
            let nz = 1.0;
            const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
            nx /= len; ny /= len; nz /= len;
            const i = (y * size + x) * 4;
            img.data[i]     = (nx * 0.5 + 0.5) * 255;
            img.data[i + 1] = (ny * 0.5 + 0.5) * 255;
            img.data[i + 2] = (nz * 0.5 + 0.5) * 255;
            img.data[i + 3] = 255;
        }
    }
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(cv);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    return tex;
}

function wallHeight() { return CEIL_Y - FLOOR_Y; }

// Parois rocheuses inclinées à 45° avec relief irrégulier
function buildWalls() {
    if (wallsGroup) { scene.remove(wallsGroup); wallsGroup.traverse(o => { if (o.isMesh) o.geometry.dispose(); }); wallsGroup = null; }
    if (!diveState.walls) return;
    if (!wallTex) wallTex = makeRockTexture();
    if (!wallNrm) wallNrm = makeRockNormalMap();
    if (!wallMat) {
        wallMat = new THREE.MeshStandardMaterial({
            map: wallTex, normalMap: wallNrm, normalScale: new THREE.Vector2(1.8, 1.8),
            roughness: 0.95, metalness: 0.0,
        });
        envMats.push(wallMat);
    }
    const h = wallHeight();
    const wallW = WALL_POS * 2;
    // Position des centres pour parois inclinées à 45° vers l'extérieur
    const halfH = h / 2;
    const offset = halfH * Math.SQRT1_2; // h/(2√2) ≈ 4.6m pour h=13
    wallsGroup = new THREE.Group();
    // 4 parois inclinées 45° vers l'extérieur (évasées)
    [
        { x: 0,             z: -(WALL_POS - offset), rx: -Math.PI / 4, ry: 0,            rz: 0 },
        { x: 0,             z:  (WALL_POS - offset), rx:  Math.PI / 4, ry: Math.PI,      rz: 0 },
        { x: -(WALL_POS - offset), z: 0,             rx: 0,             ry: Math.PI / 2,  rz: -Math.PI / 4 },
        { x:  (WALL_POS - offset), z: 0,             rx: 0,             ry: -Math.PI / 2, rz:  Math.PI / 4 },
    ].forEach(d => {
        const segs = 48;
        const geo = new THREE.PlaneGeometry(wallW, h, segs, Math.round(segs * h / wallW));
        // Déplacement de vertex pour relief irrégulier prononcé
        const pos = geo.attributes.position;
        const dispAmp = 0.55;
        for (let i = 0; i < pos.count; i++) {
            const lx = pos.getX(i), ly = pos.getY(i);
            const d1 = (fbm2(lx * 0.25 + 11, ly * 0.25 + 23) - 0.5) * dispAmp;
            const d2 = (fbm2(lx * 0.7 + 47, ly * 0.7 + 31) - 0.5) * dispAmp * 0.5;
            const d3 = (fbm2(lx * 1.8 + 91, ly * 1.8 + 63) - 0.5) * dispAmp * 0.15;
            pos.setZ(i, d1 + d2 + d3);
        }
        pos.needsUpdate = true;
        geo.computeVertexNormals();
        const m = new THREE.Mesh(geo, wallMat);
        m.position.set(d.x, FLOOR_Y + halfH, d.z);
        m.rotation.set(d.rx, d.ry, d.rz);
        m.receiveShadow = true;
        wallsGroup.add(m);
    });
    // Tiling texture
    if (wallTex) {
        const rep = Math.max(2, Math.round(wallW / 3.3));
        wallTex.repeat.set(rep, Math.max(2, Math.round(h / 3.3)));
    }
    if (wallNrm) {
        const rep = Math.max(2, Math.round(wallW / 3.3));
        wallNrm.repeat.set(rep, Math.max(2, Math.round(h / 3.3)));
    }
    scene.add(wallsGroup);
}

// Relief rocheux Blue Hole
function terrainSegs() {
    return THREE.MathUtils.clamp(Math.round((WALL_POS * 2) / 1.4), 128, 320);
}
function terrainTexRepeats() { return Math.max(2, Math.round((WALL_POS * 2) / 3.3)); }

function buildTerrain() {
    if (terrainMesh) { scene.remove(terrainMesh); terrainMesh.geometry.dispose(); terrainMesh.material.dispose(); terrainMesh = null; }
    if (!diveState.terrain) return;
    const segs = terrainSegs();
    const geo = new THREE.PlaneGeometry(WALL_POS * 2, WALL_POS * 2, segs, segs);
    geo.rotateX(-Math.PI / 2);

    // ── Couleurs biomes (seuils auto-calculés depuis zones %) ──
    terrainBiomeUniforms = {
        uBeachMax:  -beachBottomDepth(),
        uReefMax:   -reefBottomDepth(),
        uAbyssMin:  FLOOR_Y * 0.85,
        uBlend:     Math.max(diveState.depth * 0.03, 0.5),
        colorSand:  new THREE.Color(0xc8b18a),   // beige sable naturel
        colorReef:  new THREE.Color(0x3a4f47),   // roche corallienne sous-marine
        colorAbyss: new THREE.Color(0x09131d),   // limon sombre bleu nuit
    };

    // ── MeshStandardMaterial : reçoit automatiquement SpotLights + FogExp2 ──
    // Roughness élevé pour aspect rocheux mat (le sable et la roche sont tous deux mats)
    const mat = new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.95,
        metalness: 0.0,
        flatShading: false,
    });
    mat.envMapIntensity = 0.2;

    terrainMesh = new THREE.Mesh(geo, mat);
    terrainMesh.receiveShadow = true;
    updateTerrainGeometry();
    scene.add(terrainMesh);
    // Ajouter aux matériaux environnement pour maj profondeur
    envMats.push(mat);
}

/** Met à jour les seuils de biomes (auto-calculés depuis les zones %) et recalcule les couleurs vertex */
function updateTerrainBiomeUniforms() {
    if (!terrainBiomeUniforms) return;
    // Biomes = sous-produits des zones de terrain
    terrainBiomeUniforms.uBeachMax = -beachBottomDepth();     // haut de la plage (sable)
    terrainBiomeUniforms.uReefMax  = -reefBottomDepth();      // bas du récif (roche)
    terrainBiomeUniforms.uAbyssMin = FLOOR_Y * 0.85;          // seuil abysse (85% du fond)
    terrainBiomeUniforms.uBlend    = Math.max(diveState.depth * 0.03, 0.5); // fondu proportionnel
    computeTerrainVertexColors();
}

function updateTerrainGeometry() {
    if (!terrainMesh) return;
    const pos = terrainMesh.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
        pos.setY(i, terrainHeightAt(pos.getX(i), pos.getZ(i)));
    }
    pos.needsUpdate = true;
    terrainMesh.geometry.computeVertexNormals();
    computeTerrainVertexColors();
    updateAlgaeAnchors();
}

/**
 * Calcule les couleurs par vertex du terrain selon l'altitude Y (biomes).
 * Sable en surface, roche sur le plateau, limon dans l'abysse.
 * Utilise smoothstep pour des transitions fluides.
 */
function computeTerrainVertexColors() {
    if (!terrainMesh || !terrainBiomeUniforms) return;
    const geo = terrainMesh.geometry;
    const pos = geo.attributes.position;
    const count = pos.count;
    const colors = new Float32Array(count * 3);
    const _c = new THREE.Color();
    const _rock = new THREE.Color();

    const beachMax = terrainBiomeUniforms.uBeachMax;
    const reefMax  = terrainBiomeUniforms.uReefMax;
    const halfB    = Math.max(terrainBiomeUniforms.uBlend, 0.1) * 0.5;
    const cSand    = terrainBiomeUniforms.colorSand;
    const cReef    = terrainBiomeUniforms.colorReef;
    const cAbyss   = terrainBiomeUniforms.colorAbyss;

    // Palette de couleurs rocheuses pour le récif (variations naturelles)
    const rockColors = [
        new THREE.Color(0x4a5549),  // gris-vert sombre (roche moussue)
        new THREE.Color(0x5c5346),  // brun-gris (roche sèche)
        new THREE.Color(0x3d4a42),  // vert foncé (algues incrustées)
        new THREE.Color(0x524d3e),  // brun chaud (roche calcaire)
        new THREE.Color(0x3a4035),  // kaki sombre (roche profonde)
    ];

    for (let i = 0; i < count; i++) {
        const y  = pos.getY(i);
        const px = pos.getX(i);
        const pz = pos.getZ(i);

        // Transition abysse → récif (y croissant : abysse → roche)
        const tReef = THREE.MathUtils.smoothstep(y, reefMax - halfB, reefMax + halfB);
        // Transition récif → plage (y croissant : roche → sable)
        const tBeach = THREE.MathUtils.smoothstep(y, beachMax - halfB, beachMax + halfB);

        // ── Couleur de base par biome ──
        _c.copy(cAbyss).lerp(cReef, tReef);
        _c.lerp(cSand, tBeach);

        // ── Variation rocheuse progressive dans la zone récif ──
        // tBeach = 0 → plein récif, tBeach = 1 → plage (sable)
        const rockInfluence = (1.0 - tBeach) * tReef;  // max au milieu du récif
        if (rockInfluence > 0.01) {
            // Bruit pour choisir la teinte rocheuse locale
            const rockNoise = fbm2(px * 0.25 + 5.0, pz * 0.25 + 11.0);
            const rockIdx = Math.floor(rockNoise * rockColors.length) % rockColors.length;
            _rock.copy(rockColors[rockIdx]);
            // Mélanger la teinte rocheuse avec la couleur de base
            _c.lerp(_rock, rockInfluence * 0.6);
            // Assombrir les creux rocheux (bruit haute fréquence)
            const rockDetail = fbm2(px * 1.5 + 30.0, pz * 1.5 + 22.0);
            _c.multiplyScalar(0.85 + rockDetail * 0.3);
        }

        // ── Variation sable (légère) dans la zone plage ──
        if (tBeach > 0.5) {
            const sandNoise = fbm2(px * 0.8 + 2.0, pz * 0.8 + 6.0);
            _c.r += (sandNoise - 0.5) * 0.04;
            _c.g += (sandNoise - 0.5) * 0.03;
            _c.b += (sandNoise - 0.5) * 0.02;
        }

        // Légère variation globale pour casser l'uniformité
        const noise = Math.sin(px * 0.7) * Math.cos(pz * 0.9) * 0.015;
        colors[i * 3]     = THREE.MathUtils.clamp(_c.r + noise, 0, 1);
        colors[i * 3 + 1] = THREE.MathUtils.clamp(_c.g + noise, 0, 1);
        colors[i * 3 + 2] = THREE.MathUtils.clamp(_c.b + noise * 0.5, 0, 1);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

function rebuildTerrainGeometry() {
    if (!terrainMesh) return;
    terrainMesh.geometry.dispose();
    const segs = terrainSegs();
    const geo = new THREE.PlaneGeometry(WALL_POS * 2, WALL_POS * 2, segs, segs);
    geo.rotateX(-Math.PI / 2);
    terrainMesh.geometry = geo;
    updateTerrainGeometry();
}


// --- Compact zone : demi-largeur effective selon le slider (0% = bassin, 100% = 10m = zone 20×20) ---
function compactHalfW() {
    const pct = envState.compactZone / 100;
    // Interpolation : 0% → WALL_LIMIT, 100% → 10 m
    return THREE.MathUtils.lerp(WALL_LIMIT, 10, pct);
}

// Points aléatoires pour la vie sous-marine
function randomFloorPoint(rng, margin) {
    let x, z;
    const lim = compactHalfW() - margin;
    do {
        x = (rng() * 2 - 1) * lim;
        z = (rng() * 2 - 1) * lim;
    } while (Math.hypot(x, z) < LIFE_SPAWN_GUARD);
    return { x, z };
}

function randomReefPoint(rng, margin) {
    for (let k = 0; k < 24; k++) {
        const p = randomFloorPoint(rng, margin);
        if (!diveState.terrain) return p;
        // Point 7 (revue) : reefBottomDepth() = vrai BAS du plateau récifal
        // (REEF_DEPTH ≈ bas de plage ne correspondait pas à cette sémantique).
        if (terrainHeightAt(p.x, p.z) > -reefBottomDepth() - 1.5) return p;
    }
    return randomFloorPoint(rng, margin);
}

function reefPlateauArea() {
    const R = Math.max(1, WALL_LIMIT);
    const rPit = (FLOOR_Y < -REEF_DEPTH - 1) ? Math.min(R, fondZoneRadius()) : 0;
    return Math.max(1, Math.PI * (R * R - rPit * rPit));
}

function reefCount(perM2, cap, densFactor) {
    return Math.min(cap, Math.max(0, Math.round(reefPlateauArea() * perM2 * densFactor)));
}

function reefBoundingSphere() {
    return new THREE.Sphere(
        new THREE.Vector3(0, (CEIL_Y + FLOOR_Y) * 0.5, 0),
        Math.hypot(WALL_POS, Math.abs(FLOOR_Y)) + 5);
}

function scatterReefClusters(rng, cap, margin, clusterR) {
    const K = Math.max(6, Math.round(cap / 25));
    const centers = [];
    for (let k = 0; k < K; k++) centers.push(randomReefPoint(rng, margin + clusterR));
    const lim = WALL_LIMIT - margin;
    const pts = [];
    for (let i = 0; i < cap; i++) {
        const c = centers[(rng() * K) | 0];
        const a = rng() * Math.PI * 2;
        const r = Math.pow(rng(), 0.6) * clusterR;
        pts.push({
            x: THREE.MathUtils.clamp(c.x + Math.cos(a) * r, -lim, lim),
            z: THREE.MathUtils.clamp(c.z + Math.sin(a) * r, -lim, lim),
        });
    }
    return pts;
}

// ===========================================================================
// BOUNDING BOX MESH-ONLY (ignore Bones, Caméras, Helpers, Null objects)
// ===========================================================================
function meshBoundingBox(model) {
    model.updateMatrixWorld(true);
    const box = new THREE.Box3();
    let hasMesh = false;
    model.traverse((child) => {
        if (child.isMesh || child.isSkinnedMesh) {
            if (child.geometry) {
                child.geometry.computeBoundingBox();
                const meshBox = child.geometry.boundingBox.clone();
                meshBox.applyMatrix4(child.matrixWorld);
                box.union(meshBox);
                hasMesh = true;
            }
        }
    });
    if (!hasMesh) box.setFromObject(model);  // Fallback
    return box;
}

// ===========================================================================
// CHARGEMENT SCENE 3D CONFIG (faune/flore depuis JSON)
// ===========================================================================
async function loadScene3DConfig() {
    try {
        const resp = await fetch('/api/scene3d/config');
        if (!resp.ok) return;
        const config = await resp.json();
        if (!config.objects || !Array.isArray(config.objects)) return;
        const loader = new GLTFLoader();
        for (const obj of config.objects) {
            const modelUrl = `/static/models/scene/${obj.model}`;
            try {
                const gltf = await new Promise((resolve, reject) => {
                    loader.load(modelUrl, resolve, undefined, reject);
                });
                const box = meshBoundingBox(gltf.scene);
                const size = box.getSize(new THREE.Vector3());
                const maxDim = Math.max(size.x, size.y, size.z) || 1;
                let baseScale = (obj.real_size_m || 0.2) / maxDim;
                // ── Échelle minimum garantie : le modèle doit faire au moins 30% de sa taille réelle ──
                // Protège contre les GLB dont les unités internes sont très grandes (mm, cm)
                const minRenderedSize = (obj.real_size_m || 0.2) * 0.3;
                if (baseScale * maxDim < minRenderedSize) {
                    const oldBase = baseScale;
                    baseScale = minRenderedSize / maxDim;
                    console.log(`[SubSim] ⚠️ ${obj.model}: baseScale boosté de ${oldBase.toFixed(4)} → ${baseScale.toFixed(4)} (trop petit: ${oldBase * maxDim.toFixed(3)}m < ${minRenderedSize.toFixed(2)}m)`);
                }
                // Compter les meshes dans le modèle
                let meshCount = 0;
                gltf.scene.traverse(ch => { if (ch.isMesh) meshCount++; });
                console.log(`[SubSim] ${obj.model}: meshBbox=(${size.x.toFixed(3)}, ${size.y.toFixed(3)}, ${size.z.toFixed(3)}) maxDim=${maxDim.toFixed(4)} baseScale=${baseScale.toFixed(3)} → ${(baseScale * maxDim).toFixed(3)}m | meshes=${meshCount}`);
                const count = obj.count || 1;
                const validBehaviors = ['fuir', 'curieux', 'neant', 'static', 'nageant'];
                if (!validBehaviors.includes(obj.behavior)) {
                    console.warn(`[SubSim] ⚠️  "${obj.name}": behavior="${obj.behavior}" inconnu (valides: ${validBehaviors.join(', ')}), fallback neant`);
                }
                for (let i = 0; i < count; i++) {
                    const instanceGroup = new THREE.Group();
                    // SkeletonUtils.clone() préserve les squelettes et skinned meshes
                    const modelClone = SkeletonUtils.clone(gltf.scene);
                    const rScale = baseScale * ((obj.scale_min || 0.8) + Math.random() * ((obj.scale_max || 1.2) - (obj.scale_min || 0.8)));
                    modelClone.scale.setScalar(rScale);
                    // Recentrer le modèle à son centre géométrique pour éviter
                    // qu'une partie ne dépasse le point d'ancrage (caméra)
                    const cloneBox = meshBoundingBox(modelClone);
                    const cloneCenter = cloneBox.getCenter(new THREE.Vector3());
                    if (obj.type === 'flore') {
                        // Flore : centrer X/Z mais garder la BASE au sol (min Y = 0)
                        modelClone.position.x -= cloneCenter.x;
                        modelClone.position.z -= cloneCenter.z;
                        modelClone.position.y -= cloneBox.min.y;  // base à Y=0
                    } else {
                        modelClone.position.sub(cloneCenter);
                    }
                    // ── Correction heading : aligner le modèle face +Z ──
                    // Détection par moyenne pondérée des normales : on sépare les
                    // vertices en moitié avant (Z+) et arrière (Z-), puis on moyenne
                    // la composante Z des normales de chaque côté.
                    // Beaucoup plus robuste qu'un seul vertex extrême (qui peut être
                    // sur une nageoire avec une normale atypique).
                    modelClone.updateMatrixWorld(true);
                    const wm = modelClone.matrixWorld;
                    const _nmat = new THREE.Matrix3().getNormalMatrix(wm);
                    const _v = new THREE.Vector3();
                    const _n = new THREE.Vector3();
                    // Collecte positions/normales pour calculer le centre Z
                    const _verts = [];
                    const _norms = [];
                    let vPx = 0, vNx = 0;
                    modelClone.traverse(child => {
                        if ((child.isMesh || child.isSkinnedMesh) && child.geometry) {
                            const pos = child.geometry.attributes.position;
                            const norm = child.geometry.attributes.normal;
                            if (!pos) return;
                            for (let vi = 0; vi < pos.count; vi++) {
                                _v.fromBufferAttribute(pos, vi).applyMatrix4(wm);
                                if (_v.x > 0.01) vPx++; else if (_v.x < -0.01) vNx++;
                                _verts.push(_v.z);
                                if (norm) {
                                    _n.fromBufferAttribute(norm, vi).applyMatrix3(_nmat).normalize();
                                    _norms.push(_n.z);
                                } else {
                                    _norms.push(0);
                                }
                            }
                        }
                    });
                    const cloneSize = cloneBox.getSize(new THREE.Vector3());
                    let headingOffset = 0;
                    // ── Détection heading : mammifères, gros modèles (≥5m) et faune nageante ──
                    const _realSize = obj.real_size_m || 0.5;
                    const _isMamifere = obj.type === 'mamifere';
                    const _isFauneNageante = obj.type === 'faune' && obj.behavior !== 'static';
                    const skipHeading = !_isMamifere && !(_realSize >= 5 || _isFauneNageante);
                    // Moyenne pondérée des normales avant/arrière
                    let frontSum = 0, frontCount = 0;
                    let backSum = 0, backCount = 0;
                    const centerZ = (cloneBox.max.z + cloneBox.min.z) / 2;
                    for (let i = 0; i < _verts.length; i++) {
                        if (_verts[i] > centerZ) { frontSum += _norms[i]; frontCount++; }
                        else { backSum += _norms[i]; backCount++; }
                    }
                    const frontAvg = frontCount > 0 ? frontSum / frontCount : 0;
                    const backAvg = backCount > 0 ? backSum / backCount : 0;
                    if (!skipHeading) {
                        if (cloneSize.x > cloneSize.z * 1.2) {
                            headingOffset = (vPx > vNx) ? -Math.PI / 2 : Math.PI / 2;
                        } else if (cloneSize.z > cloneSize.x * 1.2) {
                            // Modèle allongé sur Z : comparer normales avant vs arrière
                            // Si les normales avant pointent -Z ET arrière pointent +Z → face à -Z → 180°
                            if (frontAvg < -0.05 && backAvg > 0.05) {
                                headingOffset = Math.PI;
                            } else if (frontAvg > 0.05 && backAvg < -0.05) {
                                headingOffset = 0; // déjà face +Z → OK
                            } else if (frontAvg < -0.05) {
                                headingOffset = Math.PI; // avant pointe -Z
                            } else if (backAvg > 0.05) {
                                headingOffset = Math.PI; // arrière pointe +Z
                            }
                        }
                    }
                    if (headingOffset !== 0) {
                        modelClone.rotation.y = headingOffset;
                        if (i === 0) console.log(`[SubSim] ${obj.name}: heading corrigé de ${(headingOffset * 180 / Math.PI).toFixed(0)}° (frontAvg=${frontAvg.toFixed(3)}, backAvg=${backAvg.toFixed(3)}, size x=${cloneSize.x.toFixed(1)} z=${cloneSize.z.toFixed(1)})`);
                    } else if (i === 0) {
                        console.log(`[SubSim] ${obj.name}: heading ${skipHeading ? 'ignoré (modèle static/petit)' : 'OK sans correction'} (frontAvg=${frontAvg.toFixed(3)}, backAvg=${backAvg.toFixed(3)})`);
                    }
                    instanceGroup.add(modelClone);
                    positionInZone(instanceGroup, obj);

                    // Animations GLB — le mixer DOIT être créé sur le clone (pas l'original)
                    // Sauf si behavior="static" : on bloque l'animation incluse du GLB
                    const skipAnim = obj.behavior === 'static';
                    const hasAnims = gltf.animations && gltf.animations.length > 0;
                    if (hasAnims && !skipAnim) {
                        const mixer = new THREE.AnimationMixer(modelClone);
                        mixer._group = instanceGroup;  // tag pour skip LOD
                        gltf.animations.forEach(clip => {
                            const action = mixer.clipAction(clip);
                            action.play();
                        });
                        scene3dMixers.push(mixer);
                    }
                    // Facteur d'échelle cinématique : les gros animaux ont
                    // des trajectoires plus larges et des mouvements plus lents
                    // cbrt pour un effet modéré : guppy=1, thon=1, esturgeon≈1.3, baleine≈2.4
                    const realSize = obj.real_size_m || 0.5;
                    const sizeCat = Math.min(2.5, Math.max(1, Math.cbrt(realSize / 0.5)));

                    // Préparer l'objet à pousser dans scene3dObjects
                    // Rayon de trajectoire proportionnel à la taille réelle de l'animal
                    const isMamifere = obj.type === 'mamifere';
                    const basinHalf = compactHalfW();
                    // ── P1 : en zone récif, le huit doit tenir DANS l'anneau [innerR, outerR] ──
                    // Sinon clampToBasin re-projette le poisson sur une frontière radiale de
                    // l'anneau à chaque frame → glissement contre un mur invisible, tangente
                    // incohérente avec le déplacement réel = nage "coincée" saccadée.
                    // (Mammifères exclus : leur huit est recalculé dynamiquement dans la boucle.)
                    const isReefZone = !isMamifere && (obj.zone === 'recif' || obj.zone === 'sol');
                    const ring = reefRingRadii();
                    // Demi-ouverture utile de l'anneau (−1 m de marge de sécurité)
                    const ringGap = Math.max(1, (ring.outerR - ring.innerR) / 2 - 1);
                    const maxPathR = isReefZone
                        ? Math.min(basinHalf * 0.65, ringGap)
                        : basinHalf * 0.65; // le huit ne dépasse pas 65% du bassin
                    // Rayons asymétriques pour éviter l'effet "ligne" (rx ≠ rz)
                    // Poissons : 2–6 m selon la taille (√realSize × 3–9), plafonnés
                    // à la demi-ouverture de l'anneau récif (ringGap) en zone récif.
                    const pathRx = isMamifere
                        ? Math.min(15 + Math.random() * 15, maxPathR)
                        : Math.min((3 + Math.random() * 6) * Math.sqrt(realSize), maxPathR);
                    const pathRz = isMamifere
                        ? Math.min(15 + Math.random() * 15, maxPathR)
                        : Math.min((3 + Math.random() * 6) * Math.sqrt(realSize), maxPathR);
                    // Vitesse linéaire désirée (m/s) — proportionnelle à la taille
                    // ── P3 : le champ "speed" du JSON est désormais appliqué en ratio ──
                    // (ex. guppy speed=1.5 → ≈0.47 m/s ; thon speed=0.9 → ≈0.32 m/s),
                    // avec bornes finales [0.2, 8] m/s pour rester physiquement plausible.
                    // Les mammifères gardent leur vitesse de référence (1.5 m/s) : leur
                    // cinématique (diveSpeed, machine à états) ne doit pas être modifiée.
                    const speedRatio = Math.max(0.1, obj.speed || 1);
                    let linearSpeed = isMamifere ? 1.5
                        : Math.max(0.3, Math.sqrt(realSize) * 0.5) * speedRatio;
                    linearSpeed = THREE.MathUtils.clamp(linearSpeed, 0.2, 8);
                    // Jitter aléatoire du centre : casse l'effet "ring" quand tous les objets
                    // sont à la même distance radiale dans une zone étroite
                    const jitterR = (2 + Math.random() * 4) * Math.sqrt(realSize);
                    const jitterAngle = Math.random() * Math.PI * 2;
                    let cx = instanceGroup.position.x + Math.cos(jitterAngle) * jitterR;
                    let cz = instanceGroup.position.z + Math.sin(jitterAngle) * jitterR;
                    // ── P1 : en zone récif, clamper le centre RADIALEMENT dans l'anneau ──
                    // (marge = extension max du huit + 1 m de sécurité) dès la création,
                    // pour que la trajectoire complète tienne dans l'anneau dès la 1re frame.
                    if (isReefZone) {
                        const maxExt = Math.max(pathRx, pathRz) + 1;
                        // Point 1 (revue) : rMin jamais au-delà du milieu d'anneau → même anneau
                        // très étroit, le centre reste DANS l'anneau (pas de snap dégénéré hors bassin).
                        const rMin = Math.min(ring.innerR + maxExt, (ring.innerR + ring.outerR) / 2);
                        const rMax = Math.max(rMin, ring.outerR - maxExt);
                        const r = Math.hypot(cx, cz);
                        if (r > 0.01 && (r < rMin || r > rMax)) {
                            const rTarget = THREE.MathUtils.clamp(r, rMin, rMax);
                            cx *= rTarget / r;
                            cz *= rTarget / r;
                        }
                    }
                    const objData = {
                        config: obj, group: instanceGroup,
                        velocity: new THREE.Vector3(),
                        targetYaw: Math.random() * Math.PI * 2,
                        changeTimer: Math.random() * 5,
                        baseY: instanceGroup.position.y,
                        sizeCat: sizeCat,
                        // Paramètres trajectoire en huit (∞) — orientation randomisée
                        path8: {
                            cx: cx,
                            cz: cz,
                            rx: pathRx,
                            rz: pathRz,
                            phase: Math.random() * Math.PI * 2,
                            dir: Math.random() > 0.5 ? 1 : -1,
                            yAmp: (0.3 + Math.random() * 0.7) * Math.sqrt(realSize),
                            linSpeed: linearSpeed,
                            // Rotation aléatoire du huit pour éparpiller les directions
                            angle: Math.random() * Math.PI * 2,
                            cosA: 0, sinA: 0,  // calculés après
                        },
                    };
                    // Calculer cosA/sinA depuis l'angle
                    objData.path8.cosA = Math.cos(objData.path8.angle);
                    objData.path8.sinA = Math.sin(objData.path8.angle);
                    // Stocker si le heading a été corrigé (pour ajuster la tangente si nage à l'envers)
                    objData.headingOffset = headingOffset;
                    // ── Mammifère : machine à états surface/plongeon/descente/profondeur/remontée ──
                    if (obj.type === 'mamifere') {
                        const midDepthY = FLOOR_Y * 0.5;
                        // Marge plancher : empêche le corps (longueur ~real_size_m) de traverser le sol
                        // quand le mammifère est en pitch. Tient compte de l'extension verticale
                        // du corps : demi-longueur × sin(pitch_max) ≈ demi-longueur × 0.89
                        const bodyHalfLen = (obj.real_size_m || 5) * 0.5 * (obj.scale_max || 1.2);
                        const bodyMargin = Math.max(5, bodyHalfLen * 0.9 + 2);
                        // Spawner près de la surface pour que le cycle démarre correctement
                        const spawnY = CEIL_Y - 5;
                        instanceGroup.position.y = spawnY;
                        objData.baseY = spawnY;
                        objData.path8.cy = spawnY;
                        objData.mammal = {
                            state: 'surface',
                            timer: 3 + Math.random() * 5,  // première remontée rapide
                            targetY: CEIL_Y - 4,
                            pitch: 0,
                            pitchTarget: 0,
                            surfDur: 8 + Math.random() * 12,
                            profDur: 15 + Math.random() * 25,
                            diveSpeed: 1.5,
                            bodyMargin,              // conservé pour recalcul dynamique
                            floorY: FLOOR_Y + bodyMargin,  // plancher sécurisé (recalculé chaque frame)
                            origRx: objData.path8.rx,
                            origRz: objData.path8.rz,
                        };
                    }
                    scene3dObjects.push(objData);
                    // Activer le frustum culling sur tous les meshes du groupe
                    instanceGroup.traverse(child => {
                        if (child.isMesh) child.frustumCulled = true;
                    });
                    scene.add(instanceGroup);
                }
            } catch (e) { console.warn(`[SubSim] ❌ Objet non chargé: ${obj.model}`, e); }
        }
        console.log(`[SubSim] ✅ Scène 3D chargée: ${scene3dObjects.length} instances, ${scene3dMixers.length} mixers animés`);
        const maxDist = diveState.visibility;
        console.log(`[SubSim] 🔭 LOD: maxRender=${maxDist.toFixed(0)}m (visibilité), WALL_POS=${WALL_POS}m`);
        // Diagnostic par zone et par modèle
        const zoneCounts = {};
        const modelCounts = {};
        scene3dObjects.forEach(o => {
            const z = o.config.zone || 'pleine_eau';
            const m = o.config.name;
            zoneCounts[z] = (zoneCounts[z] || 0) + 1;
            modelCounts[m] = (modelCounts[m] || 0) + 1;
        });
        console.log('[SubSim] 📍 Zones:', zoneCounts);
        console.log('[SubSim] 🐟 Modèles:', modelCounts);
        // Échantillon pour chaque modèle avec échelle et position
        for (const [name, count] of Object.entries(modelCounts)) {
            const sample = scene3dObjects.filter(o => o.config.name === name)[0];
            if (sample) {
                const p = sample.group.position;
                const sc = sample.group.children[0] ? sample.group.children[0].scale.x.toFixed(3) : 'N/A';
                const rx = sample.path8 ? sample.path8.rx.toFixed(1) : '-';
                const rz = sample.path8 ? sample.path8.rz.toFixed(1) : '-';
                console.log(`  ${name} (×${count}): pos=(${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)}) dist=${Math.hypot(p.x,p.z).toFixed(1)}m scale=${sc} pathR=(${rx},${rz})`);
            }
        }
    } catch (e) { console.warn('[SubSim] Config scène 3D non disponible', e); }
}

// Charge la section "environment" de scene_3d_config.json
async function loadEnvironmentConfig() {
    try {
        const resp = await fetch('/api/scene3d/config');
        if (!resp.ok) return;
        const config = await resp.json();
        const env = config.environment;
        if (!env) { console.log('[SubSim] Pas de section environment dans la config, valeurs par défaut'); return; }
        // Récif
        if (env.reef) {
            if (env.reef.algae) {
                envState.algae = env.reef.algae.enabled !== false;
                envState.algaeDensity = env.reef.algae.density ?? 0.22;
                envState.algaeLen = env.reef.algae.length ?? 1.0;
            }
            if (env.reef.corals) {
                envState.corals = env.reef.corals.enabled !== false;
                envState.reefDensity = env.reef.corals.density ?? 100;
            }
            if (env.reef.fish) {
                envState.fish = env.reef.fish.enabled !== false;
                envState.fishCount = env.reef.fish.count ?? 360;
                envState.fishSpeed = env.reef.fish.speed ?? 1.0;
            }
        }
        // Abysses
        if (env.abyss) {
            if (env.abyss.creatures) {
                envState.abyssCreatures = env.abyss.creatures.enabled !== false;
                envState.abyssDensity = env.abyss.creatures.density ?? 100;
            }
            if (env.abyss.pikes) {
                envState.pikes = env.abyss.pikes.enabled !== false;
            }
        }
        // Courant
        if (env.current !== undefined) envState.current = env.current;
        // Terrain & Parois (viennent du JSON, plus du localStorage)
        if (env.terrain) {
            diveState.terrain = env.terrain.enabled !== false;
            // Zones de terrain (%)
            if (env.terrain.zones) {
                const z = env.terrain.zones;
                if (z.beach_extent !== undefined)   diveState.beachExtent   = z.beach_extent;
                if (z.beach_depth_pct !== undefined) diveState.beachDepthPct = z.beach_depth_pct;
                if (z.reef_extent !== undefined)    diveState.reefExtent    = z.reef_extent;
                if (z.reef_depth_pct !== undefined) diveState.reefDepthPct  = z.reef_depth_pct;
            }
        }
        if (env.walls) {
            diveState.walls = env.walls.enabled !== false;
        }
        // Zone compacte
        if (env.compact_zone !== undefined) {
            envState.compactZone = Math.max(0, Math.min(100, env.compact_zone));
        }
        // Surface (vagues, caustiques, god rays)
        if (env.surface) {
            if (env.surface.waves) {
                envState.waves = env.surface.waves.enabled !== false;
                envState.waveHeight = env.surface.waves.height ?? 0.5;
                envState.waveSpeed = env.surface.waves.speed ?? 1.0;
            }
            if (env.surface.caustics) {
                envState.caustics = env.surface.caustics.enabled !== false;
                envState.causticsIntensity = env.surface.caustics.intensity ?? 0.7;
            }
            if (env.surface.godrays) {
                envState.godrays = env.surface.godrays.enabled !== false;
                envState.godraysIntensity = env.surface.godrays.intensity ?? 0.5;
            }
        }
        // Transparence de l'eau → visibilité / brouillard FogExp2
        if (env.water_transparency !== undefined) {
            diveState.visibility = Math.max(1, env.water_transparency);
            scene.fog = new THREE.FogExp2(0x0b1020, 1.7 / diveState.visibility);
        }
        // Construire/reconstruire terrain et parois selon la config JSON
        buildWalls();
        buildTerrain();
        // Mettre à jour les uniforms biomes après le chargement
        updateTerrainBiomeUniforms();
        // Surface + caustiques + god rays
        buildSurface();
        buildCaustics();
        buildGodRays();
        // Appliquer les visibilité aux meshes existants
        if (algaeMesh) algaeMesh.visible = envState.algae;
        if (fishMesh) fishMesh.visible = envState.fish;
        if (coralMeshes) coralMeshes.forEach(m => { m.visible = envState.corals; });
        if (abyssMesh) { abyssMesh.visible = envState.abyssCreatures; abyssGlowMesh.visible = abyssMesh.visible; }
        if (pikeGroup) pikeGroup.visible = envState.pikes;
        // Appliquer nombre de poissons
        if (fishMesh) fishMesh.count = Math.min(FISH_MAX, envState.fishCount);
        console.log(`[SubSim] ✅ Environment chargé: algae=${envState.algae} fish=${envState.fish}(${envState.fishCount}) corals=${envState.corals} abyss=${envState.abyssCreatures} pikes=${envState.pikes}`);
    } catch (e) { console.warn('[SubSim] Environment config non disponible', e); }
}

// SkeletonUtils.clone() utilisé ci-dessus — remplace source.clone(true) qui
// ne duplique pas correctement les squelettes des modèles animés (skinned meshes).

// ===========================================================================
// ALGUES ONDULANTES (shader GPU, InstancedMesh)
// ===========================================================================
function paintGeometry(geo, hex) {
    const c = new THREE.Color(hex);
    const n = geo.attributes.position.count;
    const arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
    geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    return geo;
}

function buildAlgae() {
    if (algaeMesh) { scene.remove(algaeMesh); algaeMesh.geometry.dispose(); algaeMesh.material.dispose(); algaeMesh = null; }
    algaeData.length = 0;
    const geo = new THREE.PlaneGeometry(0.09, 1, 1, 6);
    geo.translate(0, 0.5, 0);
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
    geo.boundingSphere = reefBoundingSphere();
    algaeMesh.frustumCulled = true;
    const cTint = new THREE.Color();
    let idx = 0;
    const centers = scatterReefClusters(rng, ALGAE_MAX_TUFTS, 0.6, Math.max(1.5, WALL_POS * 0.16));
    for (let t = 0; t < ALGAE_MAX_TUFTS; t++) {
        const p = centers[t];
        for (let b = 0; b < ALGAE_BLADES; b++) {
            const a = rng() * Math.PI * 2;
            const r = rng() * 0.28;
            algaeData.push({
                x: p.x + Math.cos(a) * r, z: p.z + Math.sin(a) * r,
                ry: rng() * Math.PI * 2, h: 0.5 + rng() * 1.0,
            });
            cTint.setHSL(0.30 + rng() * 0.10, 0.55, 0.28 + rng() * 0.14);
            algaeMesh.setColorAt(idx++, cTint);
        }
    }
    scene.add(algaeMesh);
    updateAlgaeAnchors();
}

function updateAlgaeAnchors() {
    if (!algaeMesh) return;
    for (let i = 0; i < algaeData.length; i++) {
        const d = algaeData[i];
        const y = terrainMeshHeightAt(d.x, d.z);
        _lifeQ.setFromAxisAngle(_Y_AXIS, d.ry);
        _lifeM4.compose(_lifeV.set(d.x, y - 0.02, d.z), _lifeQ, _lifeScl.set(1, d.h * envState.algaeLen, 1));
        algaeMesh.setMatrixAt(i, _lifeM4);
    }
    algaeMesh.instanceMatrix.needsUpdate = true;
    updateCoralAnchors();
}

// ===========================================================================
// CORAUX & ANÉMONES (4 espèces, InstancedMesh)
// ===========================================================================
function buildCoralGeometries() {
    const branches = [];
    for (let i = 0; i < 6; i++) {
        const g = new THREE.ConeGeometry(0.022 + (i % 3) * 0.008, 0.34 + (i % 4) * 0.11, 5);
        g.translate(0, 0.17 + (i % 4) * 0.055, 0);
        g.rotateZ((i / 6) * 1.5 - 0.75); g.rotateY(i * 2.4);
        branches.push(g);
    }
    const dome = new THREE.SphereGeometry(0.17, 8, 5, 0, Math.PI * 2, 0, Math.PI / 2);
    const parts = [new THREE.CylinderGeometry(0.07, 0.095, 0.08, 7)];
    parts[0].translate(0, 0.04, 0);
    for (let i = 0; i < 8; i++) {
        const t = new THREE.ConeGeometry(0.016, 0.17, 4);
        t.translate(0, 0.16, 0); t.rotateX(0.55); t.rotateY((i / 8) * Math.PI * 2);
        parts.push(t);
    }
    const carpet = new THREE.SphereGeometry(0.22, 6, 2, 0, Math.PI * 2, 0, Math.PI / 2);
    carpet.scale(1, 0.13, 1);
    return [mergeGeometries(branches), dome, mergeGeometries(parts), carpet];
}

function buildCorals() {
    if (coralMeshes) { coralMeshes.forEach(m => { scene.remove(m); m.geometry.dispose(); m.material.dispose(); }); coralMeshes = null; }
    coralData.forEach(a => a.length = 0);
    const geos = buildCoralGeometries();
    const palettes = [
        [0xff4f3a, 0xff8c1a, 0xd94fff, 0x58ff6e],
        [0xb05cff, 0xff7a4d, 0x39d98a, 0xffc93a],
        [0x3ae0c2, 0xff5ca8, 0x8f6bff, 0x7dff3d],
        [0xc94f6d, 0x6f9f46, 0xcf7a3a, 0x7d54c0, 0x3f9e86],
    ];
    const cTint = new THREE.Color();
    coralMeshes = geos.map((geo, t) => {
        geo.computeVertexNormals();
        geo.boundingSphere = reefBoundingSphere();
        const mat = new THREE.MeshStandardMaterial({ roughness: 0.8, metalness: 0.0, flatShading: true });
        envMats.push(mat);
        const mesh = new THREE.InstancedMesh(geo, mat, CORAL_CAP[t]);
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.frustumCulled = true;
        const rng = mulberry32(9100 + t * 37);
        const clusterR = (t === 3) ? Math.max(2, WALL_POS * 0.22) : Math.max(1.2, WALL_POS * 0.12);
        const pts = scatterReefClusters(rng, CORAL_CAP[t], 0.6, clusterR);
        for (let i = 0; i < CORAL_CAP[t]; i++) {
            const p = pts[i];
            const s = (t === 3) ? 0.6 + rng() * 1.4 : 0.7 + rng() * 1.5;
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

function updateCoralAnchors() {
    if (!coralMeshes) return;
    coralMeshes.forEach((mesh, t) => {
        for (let i = 0; i < coralData[t].length; i++) {
            const d = coralData[t][i];
            const y = terrainMeshHeightAt(d.x, d.z);
            const onReef = !diveState.terrain || y > -REEF_DEPTH - 1.5;
            if (onReef) {
                const nrm = terrainNormalAt(d.x, d.z);
                _lifeQ.setFromUnitVectors(_Y_AXIS, nrm);
                _lifeQ2.setFromAxisAngle(_Y_AXIS, d.ry);
                _lifeQ.multiply(_lifeQ2);
                _lifeM4.compose(_lifeV.set(d.x, y - 0.02, d.z), _lifeQ, _lifeScl.setScalar(d.s));
            } else {
                _lifeQ.setFromAxisAngle(_Y_AXIS, d.ry);
                _lifeM4.compose(_lifeV.set(d.x, y - 0.01, d.z), _lifeQ, _lifeScl.setScalar(0.0001));
            }
            mesh.setMatrixAt(i, _lifeM4);
        }
        mesh.instanceMatrix.needsUpdate = true;
    });
}

// ===========================================================================
// POISSONS DE RÉCIF (bancs + effarouchement)
// ===========================================================================
function buildFishGeometry() {
    const body = new THREE.SphereGeometry(0.055, 6, 5);
    body.scale(0.55, 0.85, 1.8); paintGeometry(body, 0xffffff);
    const tail = new THREE.ConeGeometry(0.045, 0.09, 4);
    tail.rotateX(Math.PI / 2); tail.scale(0.35, 1, 1); tail.translate(0, 0, -0.12);
    paintGeometry(tail, 0xdff0f2);
    const dorsal = new THREE.ConeGeometry(0.03, 0.05, 3);
    dorsal.scale(0.3, 1, 1.6); dorsal.translate(0, 0.056, -0.01);
    paintGeometry(dorsal, 0xdff0f2);
    const finL = new THREE.ConeGeometry(0.022, 0.05, 3);
    finL.rotateZ(Math.PI / 2); finL.scale(1, 0.25, 1.4); finL.translate(0.036, -0.008, 0.03);
    paintGeometry(finL, 0xdff0f2);
    const finR = new THREE.ConeGeometry(0.022, 0.05, 3);
    finR.rotateZ(-Math.PI / 2); finR.scale(1, 0.25, 1.4); finR.translate(-0.036, -0.008, 0.03);
    paintGeometry(finR, 0xdff0f2);
    const eyeL = new THREE.SphereGeometry(0.011, 5, 4);
    eyeL.translate(0.026, 0.016, 0.074); paintGeometry(eyeL, 0x0c1013);
    const eyeR = new THREE.SphereGeometry(0.011, 5, 4);
    eyeR.translate(-0.026, 0.016, 0.074); paintGeometry(eyeR, 0x0c1013);
    const merged = mergeGeometries([body, tail, dorsal, finL, finR, eyeL, eyeR]);
    merged.computeVertexNormals();
    return merged;
}

function buildFish() {
    if (fishMesh) { scene.remove(fishMesh); fishMesh.geometry.dispose(); fishMesh.material.dispose(); fishMesh = null; }
    fishData.length = 0;
    const mat = new THREE.MeshStandardMaterial({
        roughness: 0.6, metalness: 0.1, flatShading: true, vertexColors: true,
    });
    envMats.push(mat);
    fishMesh = new THREE.InstancedMesh(buildFishGeometry(), mat, FISH_MAX);
    fishMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    fishMesh.frustumCulled = false;
    const rng = mulberry32(4242);
    const palette = [0x6b8fa3, 0x8fa5a0, 0xb8a882, 0x7a9b8e, 0x5e8ea6, 0x9a8b78];
    const cTint = new THREE.Color();
    const homes = [];
    for (let s = 0; s < FISH_SCHOOLS; s++) {
        const hp = randomReefPoint(rng, 1.2);
        const hy = terrainMeshHeightAt(hp.x, hp.z);
        homes.push(new THREE.Vector3(hp.x, THREE.MathUtils.clamp(hy + 2.0, -REEF_DEPTH + 2.0, -2.5), hp.z));
    }
    for (let i = 0; i < FISH_MAX; i++) {
        const schoolHome = homes[i % FISH_SCHOOLS];
        const a = rng() * Math.PI * 2;
        fishData.push({
            pos: schoolHome.clone().add(_lifeV.set((rng() - 0.5) * 3.4, (rng() - 0.5) * 2.2, (rng() - 0.5) * 3.4)),
            dir: new THREE.Vector3(Math.cos(a), 0, Math.sin(a)),
            wander: new THREE.Vector3(Math.cos(a), 0, Math.sin(a)),
            timer: rng() * 3, phase: rng() * Math.PI * 2,
            size: 0.75 + rng() * 0.6, flee: 0, home: schoolHome,
        });
        cTint.setHex(palette[i % palette.length]).offsetHSL((rng() - 0.5) * 0.04, -0.12, (rng() - 0.5) * 0.06);
        fishMesh.setColorAt(i, cTint);
        const fi = fishData[i];
        _lifeQ.setFromUnitVectors(_Z_AXIS, fi.dir);
        _lifeM4.compose(fi.pos, _lifeQ, _lifeScl.setScalar(fi.size));
        fishMesh.setMatrixAt(i, _lifeM4);
    }
    fishMesh.instanceMatrix.needsUpdate = true;
    scene.add(fishMesh);
}

function updateFish(dt, time) {
    if (!fishMesh || !fishMesh.visible) return;
    const activity = envState.fishSpeed;
    const n = Math.min(fishMesh.count, fishData.length);
    for (let i = 0; i < n; i++) {
        const f = fishData[i];
        f.timer -= dt * (0.5 + activity * 0.5);
        if (f.timer <= 0) {
            f.timer = 2 + Math.random() * 3;
            const a = Math.random() * Math.PI * 2;
            f.wander.set(Math.cos(a), (Math.random() - 0.5) * 0.5, Math.sin(a)).normalize();
        }
        _steer.copy(f.wander);
        if (f.pos.x >  compactHalfW() - 1.5) _steer.x -= (f.pos.x - (compactHalfW() - 1.5));
        if (f.pos.x < -compactHalfW() + 1.5) _steer.x += ((-compactHalfW() + 1.5) - f.pos.x);
        if (f.pos.z >  compactHalfW() - 1.5) _steer.z -= (f.pos.z - (compactHalfW() - 1.5));
        if (f.pos.z < -compactHalfW() + 1.5) _steer.z += ((-compactHalfW() + 1.5) - f.pos.z);
        const floorLim = floorLimitAt(f.pos.x, f.pos.z) + 0.35;
        if (f.pos.y < floorLim) _steer.y += (floorLim - f.pos.y) * 2.0;
        if (f.pos.y > CEIL_Y - 1.0) _steer.y -= (f.pos.y - (CEIL_Y - 1.0)) * 2.0;
        if (f.pos.y < -REEF_DEPTH + 1.5) _steer.y += ((-REEF_DEPTH + 1.5) - f.pos.y) * 1.5;
        const dHome = f.pos.distanceTo(f.home);
        if (dHome > 2.5) {
            _fleeV.copy(f.home).sub(f.pos).normalize();
            _steer.addScaledVector(_fleeV, Math.min(1.4, (dHome - 2.5) * 0.35));
        }
        const dRov = f.pos.distanceTo(posWorld);
        if (dRov < FISH_SCARE_DIST) {
            _fleeV.copy(f.pos).sub(posWorld).normalize().multiplyScalar(3.0 * (1 - dRov / FISH_SCARE_DIST) + 1.0);
            _steer.add(_fleeV);
            f.flee = Math.min(1, f.flee + dt * 4);
        } else {
            f.flee = Math.max(0, f.flee - dt * 0.8);
        }
        _steer.normalize();
        f.dir.lerp(_steer, Math.min(1, dt * (1.5 + activity + f.flee * 4))).normalize();
        f.dir.y = THREE.MathUtils.clamp(f.dir.y, -0.4, 0.4);
        const speed = 0.35 * f.size * activity * (1 + f.flee * 0.6);
        f.pos.addScaledVector(f.dir, speed * dt);
        _lifeQ.setFromUnitVectors(_Z_AXIS, f.dir);
        const wig = Math.sin(time * (6 + activity * 4 + f.flee * 6) + f.phase) * 0.18;
        _lifeQ2.setFromAxisAngle(_Y_AXIS, wig);
        _lifeQ.multiply(_lifeQ2);
        _lifeM4.compose(f.pos, _lifeQ, _lifeScl.setScalar(f.size));
        fishMesh.setMatrixAt(i, _lifeM4);
    }
    fishMesh.instanceMatrix.needsUpdate = true;
}

// ===========================================================================
// CRÉATURES ABYSSALES BIOLUMINESCENTES
// ===========================================================================
function buildAbyss() {
    if (abyssMesh) { scene.remove(abyssMesh); scene.remove(abyssGlowMesh); abyssMesh.geometry.dispose(); abyssMesh.material.dispose(); abyssGlowMesh.geometry.dispose(); abyssGlowMesh.material.dispose(); abyssMesh = null; abyssGlowMesh = null; }
    abyssData.length = 0;
    const body = new THREE.SphereGeometry(0.05, 6, 5);
    body.scale(0.4, 0.5, 2.6);
    const tail = new THREE.ConeGeometry(0.03, 0.1, 4);
    tail.rotateX(Math.PI / 2); tail.scale(0.3, 1, 1); tail.translate(0, 0, -0.16);
    const geo = mergeGeometries([body, tail]); geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({
        roughness: 0.7, metalness: 0.05, flatShading: true,
        emissive: 0x06222e, emissiveIntensity: 0.8,
    });
    abyssMesh = new THREE.InstancedMesh(geo, mat, ABYSS_MAX);
    abyssMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    abyssMesh.frustumCulled = false;
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
            timer: rng() * 4, phase: rng() * Math.PI * 2, size: 0.8 + rng() * 0.8,
        });
        cTint.setHSL(0.45 + rng() * 0.15, 0.7, 0.10 + rng() * 0.08);
        abyssMesh.setColorAt(i, cTint);
        const ai = abyssData[i];
        _lifeQ.setFromUnitVectors(_Z_AXIS, ai.dir);
        _lifeM4.compose(ai.pos, _lifeQ, _lifeScl.setScalar(ai.size));
        abyssMesh.setMatrixAt(i, _lifeM4);
        abyssGlowMesh.setMatrixAt(i, _lifeM4);
    }
    abyssMesh.instanceMatrix.needsUpdate = true;
    abyssGlowMesh.instanceMatrix.needsUpdate = true;
    scene.add(abyssMesh); scene.add(abyssGlowMesh);
}

function updateAbyss(dt, time) {
    if (!abyssMesh || !abyssMesh.visible) return;
    const n = Math.min(abyssMesh.count, abyssData.length);
    const yTop = Math.min(-REEF_DEPTH - 3, CEIL_Y - 2);
    for (let i = 0; i < n; i++) {
        const f = abyssData[i];
        f.timer -= dt;
        if (f.timer <= 0) {
            f.timer = 3 + Math.random() * 4;
            const a = Math.random() * Math.PI * 2;
            f.wander.set(Math.cos(a), (Math.random() - 0.5) * 0.4, Math.sin(a)).normalize();
        }
        _steer.copy(f.wander);
        if (f.pos.x >  compactHalfW() - 2) _steer.x -= (f.pos.x - (compactHalfW() - 2));
        if (f.pos.x < -compactHalfW() + 2) _steer.x += ((-compactHalfW() + 2) - f.pos.x);
        if (f.pos.z >  compactHalfW() - 2) _steer.z -= (f.pos.z - (compactHalfW() - 2));
        if (f.pos.z < -compactHalfW() + 2) _steer.z += ((-compactHalfW() + 2) - f.pos.z);
        const floorLim = floorLimitAt(f.pos.x, f.pos.z) + 0.5;
        if (f.pos.y < floorLim) _steer.y += (floorLim - f.pos.y) * 2.0;
        if (f.pos.y > yTop) _steer.y -= (f.pos.y - yTop) * 1.5;
        _steer.normalize();
        f.dir.lerp(_steer, Math.min(1, dt * 0.8)).normalize();
        f.pos.addScaledVector(f.dir, 0.12 * f.size * dt);
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

// ===========================================================================
// BROCHETS ABYSSAUX GÉANTS
// ===========================================================================
function buildPikeMesh() {
    const g = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: 0x22352a, roughness: 0.85, metalness: 0.05, flatShading: true });
    envMats.push(mat);
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.09, 9, 7), mat);
    body.scale.set(0.85, 0.75, 5.6); g.add(body);
    const jawGeo = new THREE.ConeGeometry(0.055, 0.22, 6);
    jawGeo.rotateX(Math.PI / 2); jawGeo.scale(1, 0.45, 1);
    const jawUp = new THREE.Mesh(jawGeo, mat); jawUp.position.set(0, 0.03, 0.5); jawUp.rotation.x = -0.18;
    const jawLo = new THREE.Mesh(jawGeo, mat); jawLo.position.set(0, -0.035, 0.49); jawLo.rotation.x = 0.30;
    g.add(jawUp, jawLo);
    const tailGeo = new THREE.ConeGeometry(0.09, 0.16, 4);
    tailGeo.rotateX(-Math.PI / 2); tailGeo.scale(0.25, 1.6, 1);
    g.add(new THREE.Mesh(tailGeo, mat).translateZ(-0.56));
    const dorsGeo = new THREE.ConeGeometry(0.06, 0.1, 3);
    dorsGeo.scale(0.25, 1, 1.5);
    const dors = new THREE.Mesh(dorsGeo, mat); dors.position.set(0, 0.08, -0.28); g.add(dors);
    const eyeMat = new THREE.MeshBasicMaterial({ color: 0x8cff5e });
    const eyeGeo = new THREE.SphereGeometry(0.016, 6, 5);
    const eL = new THREE.Mesh(eyeGeo, eyeMat); eL.position.set(0.055, 0.035, 0.34);
    const eR = new THREE.Mesh(eyeGeo, eyeMat); eR.position.set(-0.055, 0.035, 0.34);
    g.add(eL, eR);
    return g;
}

function buildPikes() {
    if (pikeGroup) { scene.remove(pikeGroup); pikeGroup.traverse(o => { if (o.isMesh) o.geometry.dispose(); }); pikeGroup = null; }
    pikeData.length = 0;
    pikeGroup = new THREE.Group();
    const rng = mulberry32(6060);
    const patrolR = Math.max(3, fondZoneRadius() * 0.7);
    for (let i = 0; i < PIKE_COUNT; i++) {
        const g = buildPikeMesh();
        const angle = rng() * Math.PI * 2;
        const y = FLOOR_Y + 3 + rng() * 6;
        g.position.set(Math.cos(angle) * patrolR, y, Math.sin(angle) * patrolR);
        pikeData.push({ group: g, angle, y, dir: new THREE.Vector3(0, 0, 1), speed: 0.35 + rng() * 0.15 });
        pikeGroup.add(g);
    }
    scene.add(pikeGroup);
}

function updatePikes(dt) {
    if (!pikeGroup || !pikeGroup.visible) return;
    const patrolR = Math.max(3, fondZoneRadius() * 0.7);
    for (const p of pikeData) {
        const g = p.group;
        p.angle += dt * (p.speed / patrolR);
        _pikeTarget.set(Math.cos(p.angle) * patrolR, p.y + Math.sin(p.angle * 3.1) * 1.5, Math.sin(p.angle) * patrolR);
        // Point 7 (revue) : prédation sous le vrai bas du récif (reefBottomDepth),
        // pas sous REEF_DEPTH (≈ bas de plage, sémantique différente).
        if (posWorld.y < -reefBottomDepth() && g.position.distanceTo(posWorld) < 12) {
            _pikeTarget.copy(posWorld); _pikeTarget.y = Math.max(_pikeTarget.y - 0.4, FLOOR_Y + 1);
        }
        _lifeV.copy(_pikeTarget).sub(g.position);
        const d = _lifeV.length();
        if (d > 0.05) {
            _lifeV.normalize();
            p.dir.lerp(_lifeV, Math.min(1, dt * 0.5)).normalize();
            g.position.addScaledVector(p.dir, Math.min(p.speed, d) * dt);
        }
        const fl = floorLimitAt(g.position.x, g.position.z) + 0.6;
        if (g.position.y < fl) g.position.y = fl;
        _lifeQ.setFromUnitVectors(_Z_AXIS, p.dir);
        g.quaternion.slerp(_lifeQ, Math.min(1, dt * 1.2));
    }
}

// ===========================================================================
// ZONAGE RÉCIF/ABYSSES (hystérésis)
// ===========================================================================
let reefVisible = true, abyssVisible = false;

function refreshLifeZoning() {
    const depth = Math.max(0, -posWorld.y);
    if (reefVisible && depth > REEF_DEPTH + 30) reefVisible = false;
    else if (!reefVisible && depth < REEF_DEPTH + 22) reefVisible = true;
    if (!abyssVisible && depth > REEF_DEPTH + 2) abyssVisible = true;
    else if (abyssVisible && depth < REEF_DEPTH - 4) abyssVisible = false;
    if (algaeMesh) algaeMesh.visible = reefVisible && envState.algae;
    if (fishMesh) fishMesh.visible = reefVisible && envState.fish;
    if (coralMeshes) coralMeshes.forEach(m => { m.visible = reefVisible && envState.corals; });
    if (abyssMesh) { abyssMesh.visible = abyssVisible && envState.abyssCreatures; abyssGlowMesh.visible = abyssMesh.visible; }
    if (pikeGroup) pikeGroup.visible = abyssVisible && envState.pikes;
}

// ===========================================================================
// CONSTRUCTION DE TOUTE LA VIE SOUS-MARINE
// ===========================================================================
function buildAllLife() {
    buildAlgae();
    buildCorals();
    buildFish();
    buildAbyss();
    buildPikes();
}

function rebuildLife() {
    if (algaeMesh) { scene.remove(algaeMesh); algaeMesh.geometry.dispose(); const i = envMats.indexOf(algaeMesh.material); if (i >= 0) envMats.splice(i, 1); algaeMesh.material.dispose(); algaeMesh = null; }
    if (coralMeshes) { coralMeshes.forEach(m => { scene.remove(m); m.geometry.dispose(); const i = envMats.indexOf(m.material); if (i >= 0) envMats.splice(i, 1); m.material.dispose(); }); coralMeshes = null; }
    if (fishMesh) { scene.remove(fishMesh); fishMesh.geometry.dispose(); const i = envMats.indexOf(fishMesh.material); if (i >= 0) envMats.splice(i, 1); fishMesh.material.dispose(); fishMesh = null; }
    if (abyssMesh) { scene.remove(abyssMesh); scene.remove(abyssGlowMesh); abyssMesh.geometry.dispose(); abyssMesh.material.dispose(); abyssGlowMesh.geometry.dispose(); abyssGlowMesh.material.dispose(); abyssMesh = null; abyssGlowMesh = null; }
    if (pikeGroup) { scene.remove(pikeGroup); pikeGroup.traverse(o => { if (o.isMesh) { o.geometry.dispose(); const i = envMats.indexOf(o.material); if (i >= 0) envMats.splice(i, 1); o.material.dispose(); } }); pikeGroup = null; }
    algaeData.length = 0; fishData.length = 0; abyssData.length = 0; pikeData.length = 0;
    coralData.forEach(a => a.length = 0);
    buildAllLife();
}

/** Rayon minimum autour du ROV (origine) où aucun objet ne peut apparaître. */
const SPAWN_GUARD_RADIUS = 5.0;  // mètres

/**
 * Rayons intérieur/extérieur de l'anneau récif, dérivés des % du terrain
 * (mêmes formules que positionInZone()/clampToBasin() — source unique de vérité).
 * Utilisé par la correction P1 pour contraindre les trajectoires en huit
 * de la zone 'recif' DANS l'anneau (évite l'écrasement radial par clampToBasin).
 */
function reefRingRadii() {
    const beachFrac = diveState.beachExtent / 100;
    const reefFrac  = diveState.reefExtent / 100;
    return {
        innerR: WALL_POS * Math.max(0, 1.0 - beachFrac - reefFrac),
        outerR: WALL_POS * (1.0 - beachFrac),
    };
}

function positionInZone(group, obj) {
    const zone = obj.zone || 'pleine_eau';
    const halfW = compactHalfW() * 0.92;
    const SURF_MARGIN = 1.5;
    const abyssR = fondZoneRadius();

    // ── Limites réelles des zones depuis les % du terrain ──
    // Point 10 (revue) : reefRingRadii() = source unique des rayons de l'anneau récif
    const _ring = reefRingRadii();
    const beachInnerR = _ring.outerR;                             // rayon intérieur plage (= extérieur récif)
    const beachOuterR = WALL_POS;                                 // rayon extérieur plage (= mur)
    const reefInnerR  = _ring.innerR;                             // rayon intérieur récif
    const reefOuterR  = beachInnerR;                              // rayon extérieur récif = intérieur plage

    let x, z, y;

    switch (zone) {

        // ── RÉCIF : entre reefInnerR et reefOuterR, hors fosse ──
        case 'recif':
        case 'sol': {
            for (let attempt = 0; attempt < 40; attempt++) {
                const angle = Math.random() * Math.PI * 2;
                const dist = reefInnerR + Math.random() * (reefOuterR - reefInnerR);
                x = Math.cos(angle) * dist;
                z = Math.sin(angle) * dist;
                if (Math.hypot(x, z) >= SPAWN_GUARD_RADIUS && Math.hypot(x, z) > abyssR * 1.15) break;
            }
            const floorY = terrainMeshHeightAt(x, z);
            if (obj.type === 'flore') {
                y = floorY + 0.05;
            } else if (obj.type === 'objet') {
                // Objets volumineux (epave) : posés sur le sol
                y = floorY + 0.2;
            } else {
                // Faune : utiliser toute la colonne d'eau au-dessus du récif
                // (0.5m à 15m au-dessus du sol pour un effet 3D naturel)
                const reefDepth = Math.abs(floorY - CEIL_Y);
                const maxYAbove = Math.min(15, reefDepth * 0.7);
                y = floorY + 0.5 + Math.random() * maxYAbove;
            }
            break;
        }

        // ── PLAGE : entre beachInnerR et beachOuterR ──
        case 'plage': {
            for (let attempt = 0; attempt < 40; attempt++) {
                const angle = Math.random() * Math.PI * 2;
                const dist = beachInnerR + Math.random() * (beachOuterR - beachInnerR);
                x = Math.cos(angle) * dist;
                z = Math.sin(angle) * dist;
                if (Math.hypot(x, z) >= SPAWN_GUARD_RADIUS) break;
            }
            const floorY = terrainMeshHeightAt(x, z);
            if (obj.type === 'flore') {
                y = floorY + 0.05;
            } else {
                const topY = Math.max(floorY + 0.5, CEIL_Y - 1.5);
                const botY = floorY + 0.2;
                y = botY + Math.random() * Math.max(0.3, topY - botY);
            }
            break;
        }

        // ── FOND : zone centrale (0 → reefInnerR), hors fosse ──
        case 'fond': {
            const fondMaxR = Math.max(reefInnerR * 0.95, abyssR * 1.2);
            for (let attempt = 0; attempt < 30; attempt++) {
                const angle = Math.random() * Math.PI * 2;
                const dist = abyssR * 1.1 + Math.random() * Math.max(0, fondMaxR - abyssR * 1.1);
                x = Math.cos(angle) * dist;
                z = Math.sin(angle) * dist;
                if (Math.hypot(x, z) >= SPAWN_GUARD_RADIUS) break;
            }
            const floorY = terrainMeshHeightAt(x, z);
            y = (obj.type === 'flore') ? floorY + 0.05 : floorY + 0.3 + Math.random() * 2.7;
            break;
        }

        // ── ABYSSE : exclusivement dans la fosse (rayon < abyssR) ──
        case 'abysse': {
            const maxR = abyssR * 0.85;
            for (let attempt = 0; attempt < 40; attempt++) {
                const angle = Math.random() * Math.PI * 2;
                const dist = Math.random() * maxR;
                x = Math.cos(angle) * dist;
                z = Math.sin(angle) * dist;
                break;
            }
            const floorY = terrainMeshHeightAt(x, z);
            if (obj.type === 'flore') {
                y = floorY + 0.05;
            } else {
                y = floorY + 0.2 + Math.random() * 2.0;
            }
            break;
        }

        // ── SURFACE : juste sous la surface ──
        case 'surface':
            for (let attempt = 0; attempt < 30; attempt++) {
                x = (Math.random() * 2 - 1) * halfW;
                z = (Math.random() * 2 - 1) * halfW;
                if (Math.hypot(x, z) >= SPAWN_GUARD_RADIUS) break;
            }
            y = CEIL_Y - 2 - Math.random() * 3;
            break;

        // ── PLEINE EAU : colonne d'eau, biaisé vers les faibles profondeurs ──
        case 'pleine_eau': {
            for (let attempt = 0; attempt < 30; attempt++) {
                x = (Math.random() * 2 - 1) * halfW;
                z = (Math.random() * 2 - 1) * halfW;
                if (Math.hypot(x, z) >= SPAWN_GUARD_RADIUS) break;
            }
            const depth = -FLOOR_Y;
            const shallow = Math.min(depth * 0.35, 20);
            const deep = depth - 3;
            const r = Math.random();
            const biased = r * r;
            y = -(shallow + biased * (deep - shallow));
            break;
        }

        // ── MULTI_COUCHE (défaut) : surface → bas du récif, hors fosse ──
        default: {
            for (let attempt = 0; attempt < 30; attempt++) {
                x = (Math.random() * 2 - 1) * halfW;
                z = (Math.random() * 2 - 1) * halfW;
                if (Math.hypot(x, z) >= SPAWN_GUARD_RADIUS) break;
            }
            const yMax = CEIL_Y - SURF_MARGIN;
            const yMin = -reefBottomDepth();
            y = yMin + Math.random() * (yMax - yMin);
            break;
        }
    }
    group.position.set(x, y, z);
    group.rotation.y = Math.random() * Math.PI * 2;
}

// ===========================================================================
// MISE À JOUR FAUNE/FLORE (comportements dynamiques)
// ===========================================================================
// rawDt : dt brut de la frame (mixers, LOD). Le dt effectif de simulation de
// chaque objet est recalculé en tête du forEach (voir correction P2 ci-dessous).
function updateSceneObjects(rawDt) {
    if (!modelGroup) return;  // sécurité : modèle ROV pas encore initialisé
    const rovPos = modelGroup.position;

    // ── LOD : distance max = visibilité de l'eau (naturel : on voit pas à 100m) ──
    const maxRenderDist = diveState.visibility;
    const maxRenderDistSq = maxRenderDist * maxRenderDist;

    // Compteur de frame pour l'update partielle
    if (!updateSceneObjects._frame) updateSceneObjects._frame = 0;
    updateSceneObjects._frame++;
    const frame = updateSceneObjects._frame;

    // Position ROV pour distance
    const rovX = rovPos.x, rovZ = rovPos.z;

    // ── Point 5 (revue) : hoist — rayons de l'anneau récif calculés UNE fois par frame ──
    // (évite un appel + allocation d'objet par poisson dans le clamp radial de la boucle).
    const reefRing = reefRingRadii();

    // ── Debug : log périodique (toutes les ~5s) ──
    if (!updateSceneObjects._logged) {
        updateSceneObjects._logged = true;
        console.log(`[SubSim] 🔍 LOD: maxRender=${maxRenderDist.toFixed(0)}m, WALL_POS=${WALL_POS}, ${scene3dObjects.length} objets, ${scene3dMixers.length} mixers`);
    }
    if (frame % 300 === 1) {
        let vis = 0, hid = 0;
        scene3dObjects.forEach(o => { if (o.group && o.group.visible) vis++; else hid++; });
        console.log(`[SubSim] 📊 frame=${frame}: ${scene3dObjects.length} objets, visibles=${vis}, cachés=${hid}, ROV=(${rovX.toFixed(1)},${rovZ.toFixed(1)})`);
        scene3dObjects.slice(0, 5).forEach((o, i) => {
            const p = o.group ? o.group.position : {x:0,y:0,z:0};
            const d = Math.hypot(p.x - rovX, p.z - rovZ);
            console.log(`  [${i}] ${o.config.name} zone=${o.config.zone} dist=${d.toFixed(1)}m vis=${o.group ? o.group.visible : 'null'} ${o.path8 ? 'path8✓' : ''}`);
        });
    }

    // ── 1. Mise à jour des animations GLB (mixers) — uniquement pour objets visibles ──
    for (let i = 0; i < scene3dMixers.length; i++) {
        const m = scene3dMixers[i];
        if (m._group && !m._group.visible) continue;
        m.update(rawDt);
    }

    scene3dObjects.forEach((obj, idx) => {
        // ── P2 : dt effectif de simulation ──
        // Le throttling LOD (ci-dessous) saute des frames pour les objets lointains :
        // le dt de ces frames sautées est accumulé (obj._accDt) puis restitué ici pour
        // que la vitesse de nage reste constante malgré la mise à jour partielle.
        // Plafonné à 0.25 s pour éviter tout saut de position après un onglet inactif.
        let dt = Math.min(rawDt + (obj._accDt || 0), 0.25);
        obj._accDt = 0;
        const cfg = obj.config;
        const objType = cfg.type || 'faune';
        let kinematic = cfg.kinematic || 'fixe';
        if (objType === 'flore') kinematic = 'ancre_ondule';
        if (objType === 'objet') kinematic = 'fixe';
        if (objType === 'mamifere') kinematic = 'nageant';
        if (kinematic === 'fixe' && (cfg.behavior === 'nageant' || cfg.behavior === 'fuir' || cfg.behavior === 'curieux')) {
            kinematic = 'nageant';
        }

        // ── LOD : culling par distance au ROV ──
        if (obj.group) {
            const pos = obj.group.position;
            const dx = pos.x - rovX;
            const dz = pos.z - rovZ;
            const distSq = dx * dx + dz * dz;

            if (distSq > maxRenderDistSq) {
                // Masquer au-delà de la distance de rendu, MAIS ne pas retourner :
                // ── Point 4 (revue) : la simulation cinématique continue (path8 classique
                // + machine à états mammifère : arithmétique pure) pour que le radar — qui
                // dessine désormais toute la scène — reste vivant, baleine comprise.
                // Coûts maîtrisés : les AnimationMixers sont déjà skippés dans leur boucle
                // dédiée (mixerskip conservé) et le groupe invisible n'a aucun coût de rendu.
                // _accDt inutile ici : dt réel chaque frame (throttling réservé aux visibles).
                obj.group.visible = false;
            } else {
                // Visible dans la zone de rendu
                obj.group.visible = true;

                // Throttling : objets lointains mis à jour moins souvent
                // ── P2 : accumulateur — le dt des frames sautées n'est plus perdu ──
                // Il est restitué à la prochaine frame traitée (cf. dt effectif en tête
                // de callback). Sans cela, la vitesse effective était divisée par 3 à 5
                // et la nage avançait par bonds (corps figés, queues animées à pleine vitesse).
                const dist = Math.sqrt(distSq);
                let throttleMod = 0;
                if (dist > maxRenderDist * 0.75) throttleMod = 5;
                else if (dist > maxRenderDist * 0.5) throttleMod = 3;
                if (throttleMod && (frame + idx) % throttleMod !== 0) {
                    obj._accDt = Math.min((obj._accDt || 0) + dt, 0.5);  // 0.5 s max cumulés
                    return;
                }
            }
        }

        // Facteur d'échelle cinématique (mémorisé à la création, fallback 1)
        const sizeCat = obj.sizeCat || 1;
        // Vitesse de base : les gros animaux sont un peu plus lents (÷∜sizeCat)
        // Point 2 (revue) : clamp [0.2, 8] m/s — un "speed" JSON aberrant (négatif ou 100)
        // ne doit pas produire une fuite inversée ou un poisson-torpille à 150 m/s.
        const speed = THREE.MathUtils.clamp(((cfg.speed || 1) * 0.5) / Math.pow(sizeCat, 0.25), 0.2, 8);
        const behavior = cfg.behavior || 'neant';
        // "static" = fixe + pas d'animation GLB
        if (behavior === 'static') return;
        const turnSpeed = cfg.turn_speed || 0.5;        // 0..1 : rapidité de virage
        const wanderR = cfg.wander_radius || 5;         // rayon d'errance autour du spawn

        if (kinematic === 'fixe') return;

        // --- Comportement IA à l'approche du ROV (seuil proportionnel à la taille) ---
        // Les mammifères détectent le ROV de beaucoup plus loin (×3)
        const isMamifere = obj.mammal != null;
        const iaThreshold = isMamifere ? 24 * sizeCat : 8 * sizeCat;
        const dist = obj.group.position.distanceTo(rovPos);
        let currentSpeed = speed;
        let iaOverride = false;  // true = l'IA force la direction

        if (dist < iaThreshold) {
            if (behavior === 'fuir') {
                // Fuite : ×3 vitesse + réorientation immédiate à l'opposé
                currentSpeed = speed * 3;
                const away = obj.group.position.clone().sub(rovPos).normalize();
                obj.targetYaw = Math.atan2(away.x, away.z);
                iaOverride = true;
            } else if (behavior === 'curieux') {
                // Curieux : s'oriente vers le ROV, vitesse ×1.3 (approche douce)
                currentSpeed = speed * 1.3;
                const toward = rovPos.clone().sub(obj.group.position).normalize();
                obj.targetYaw = Math.atan2(toward.x, toward.z);
                iaOverride = true;
            }
            // 'neant' / 'nageant' : comportement normal inchangé
        }

        // --- Mode cinématique : nageant (trajectoire en huit ∞) ---
        if (kinematic === 'nageant') {
            const p = obj.path8;

            // ═══════════════════════════════════════════════════════════════
            //  MAMMIFÈRE — cycle surface/plongeon/descente/profondeur/remontée
            // ═══════════════════════════════════════════════════════════════
            if (obj.mammal) {
                const m = obj.mammal;
                m.timer -= dt;
                // Recalcul dynamique du plancher sécurisé (le slider profondeur peut changer FLOOR_Y)
                m.floorY = FLOOR_Y + m.bodyMargin;
                // Recalcul dynamique du rayon du huit (s'adapte au slider zone compacte)
                const dynMaxR = compactHalfW() * 0.65;
                p.rx = Math.min(m.origRx, dynMaxR);
                p.rz = Math.min(m.origRz, dynMaxR);

                if (iaOverride) {
                    // ── IA override : déplacement direct vers la cible (fuir/curieux) ──
                    // Mettre à jour rotation.y (pas le quaternion) car le code
                    // ci-dessous reconstruit le quaternion depuis rotation.y + pitch.
                    const lerpF = Math.min(0.12 / sizeCat, turnSpeed * 0.08 / sizeCat * dt * 60);
                    let diff = obj.targetYaw - obj.group.rotation.y;
                    while (diff > Math.PI) diff -= Math.PI * 2;
                    while (diff < -Math.PI) diff += Math.PI * 2;
                    obj.group.rotation.y += diff * lerpF;
                    const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(
                        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), obj.group.rotation.y)
                    );
                    obj.group.position.addScaledVector(forward, currentSpeed * dt);
                    p.cx = obj.group.position.x;
                    p.cz = obj.group.position.z;
                    // Reset pitch en mode IA
                    m.pitch = THREE.MathUtils.lerp(m.pitch, 0, Math.min(1, dt * 2));
                    // Rotation : yaw (rotation.y) + pitch (axe local X)
                    {
                        const yawQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), obj.group.rotation.y);
                        const pitchQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), m.pitch);
                        obj.group.quaternion.copy(yawQ).multiply(pitchQ);
                    }
                    // Synchroniser l'état mammifère avec la profondeur actuelle
                    if (obj.group.position.y > CEIL_Y - 6) {
                        if (m.state !== 'surface' && m.state !== 'plongeon') {
                            m.state = 'surface';
                            m.timer = m.surfDur;
                        }
                    } else {
                        if (m.state !== 'profondeur' && m.state !== 'descente') {
                            m.state = 'profondeur';
                            m.timer = m.profDur;
                        }
                    }
                } else {
                    // ── Machine à états mammifère ──
                    switch (m.state) {

                        case 'surface':
                            // Remonte d'abord à la surface, puis nage tranquille
                            m.pitchTarget = 0;
                            if (obj.group.position.y < CEIL_Y - 6) {
                                // Encore loin de la surface : remonter activement
                                obj.group.position.y += m.diveSpeed * dt;
                                // Geler le timer pendant la remontée
                                m.timer = Math.max(m.timer, m.surfDur * 0.5);
                            } else {
                                // Près de la surface : huit + oscillation douce
                                p.phase += currentSpeed * dt * (1.5 / sizeCat) * p.dir;
                                const t8 = p.phase;
                                const sinT = Math.sin(t8), cosT = Math.cos(t8);
                                const denom = 1 + sinT * sinT;
                                const newX = p.cx + p.rx * cosT / denom;
                                const newZ = p.cz + p.rz * sinT * cosT / denom;
                                // Orientation : suivre la tangente du huit
                                const dx = newX - obj.group.position.x;
                                const dz = newZ - obj.group.position.z;
                                if (Math.abs(dx) > 0.001 || Math.abs(dz) > 0.001) {
                                    const tangentYaw = Math.atan2(dx, dz);
                                    const lerpF = Math.min(0.15 / sizeCat, turnSpeed * 0.1 / sizeCat * dt * 60);
                                    // Mettre à jour rotation.y (pas le quaternion) car
                                    // le code post-switch reconstruit le quaternion depuis rotation.y
                                    let diff = tangentYaw - obj.group.rotation.y;
                                    while (diff > Math.PI) diff -= Math.PI * 2;
                                    while (diff < -Math.PI) diff += Math.PI * 2;
                                    obj.group.rotation.y += diff * lerpF;
                                }
                                obj.group.position.x = newX;
                                obj.group.position.z = newZ;
                                obj.group.position.y = (CEIL_Y - 4) + Math.sin(t8 * 2) * 0.3;
                                // Transition : timer écoulé → plongeon
                                if (m.timer <= 0) {
                                    m.state = 'plongeon';
                                    m.timer = 3 + Math.random() * 2;
                                    m.pitchTarget = -0.8 - Math.random() * 0.3;  // -46° à -63°
                                }
                            }
                            break;

                        case 'plongeon':
                            // Bascule nez vers le bas, la queue sort de l'eau !
                            m.pitch = THREE.MathUtils.lerp(m.pitch, m.pitchTarget, Math.min(1, dt * 0.6));
                            // Léger mouvement vers l'avant
                            {
                                const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(
                                    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), obj.group.rotation.y)
                                );
                                obj.group.position.addScaledVector(fwd, speed * 0.2 * dt);
                            }
                            // Maintenir Y près de la surface — le pitch fait sortir la queue
                            obj.group.position.y = THREE.MathUtils.lerp(obj.group.position.y, CEIL_Y - 3, Math.min(1, dt * 0.5));
                            if (m.timer <= 0) {
                                m.state = 'descente';
                                // Cible entre 30% et 80% de la plage utile [CEIL_Y → floorY]
                                // Toujours atteignable même si FLOOR_Y change
                                const usableRange = m.floorY - CEIL_Y;  // négatif
                                m.targetY = CEIL_Y + usableRange * (0.3 + Math.random() * 0.5);
                            }
                            break;

                        case 'descente':
                            // Descend vers la profondeur cible, gueule vers le bas
                            {
                                const diff = m.targetY - obj.group.position.y;
                                // Si le plancher est atteint → transition immédiate vers profondeur
                                if (obj.group.position.y <= m.floorY + 0.3) {
                                    m.pitchTarget = 0;
                                    m.state = 'profondeur';
                                    m.timer = m.profDur;
                                    p.cx = obj.group.position.x;
                                    p.cz = obj.group.position.z;
                                    p.phase = Math.random() * Math.PI * 2;
                                    obj.baseY = obj.group.position.y;
                                } else if (Math.abs(diff) > 0.5) {
                                    obj.group.position.y += Math.sign(diff) * m.diveSpeed * dt;
                                    // Pitch proportionnel à la distance restante
                                    const steepness = Math.min(1, Math.abs(diff) / 10);
                                    m.pitchTarget = -0.15 - steepness * 0.55;  // -0.15° à -0.70°
                                } else {
                                    m.pitchTarget = 0;
                                    m.state = 'profondeur';
                                    m.timer = m.profDur;
                                    // Nouveau centre de huit à la profondeur atteinte
                                    p.cx = obj.group.position.x;
                                    p.cz = obj.group.position.z;
                                    p.phase = Math.random() * Math.PI * 2;
                                    obj.baseY = obj.group.position.y;
                                }
                                // Avancer pendant la descente
                                const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(
                                    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), obj.group.rotation.y)
                                );
                                obj.group.position.addScaledVector(fwd, speed * 0.3 * dt);
                            }
                            m.pitch = THREE.MathUtils.lerp(m.pitch, m.pitchTarget, Math.min(1, dt * 1.5));
                            break;

                        case 'profondeur':
                            // Nage en huit à la profondeur atteinte (niveau aléatoire)
                            m.pitchTarget = 0;
                            p.phase += currentSpeed * dt * (1.5 / sizeCat) * p.dir;
                            {
                                const t8 = p.phase;
                                const sinT = Math.sin(t8), cosT = Math.cos(t8);
                                const denom = 1 + sinT * sinT;
                                const newX = p.cx + p.rx * cosT / denom;
                                const newZ = p.cz + p.rz * sinT * cosT / denom;
                                // Orientation : suivre la tangente du huit
                                const dx = newX - obj.group.position.x;
                                const dz = newZ - obj.group.position.z;
                                if (Math.abs(dx) > 0.001 || Math.abs(dz) > 0.001) {
                                    const tangentYaw = Math.atan2(dx, dz);
                                    const lerpF = Math.min(0.15 / sizeCat, turnSpeed * 0.1 / sizeCat * dt * 60);
                                    let diff = tangentYaw - obj.group.rotation.y;
                                    while (diff > Math.PI) diff -= Math.PI * 2;
                                    while (diff < -Math.PI) diff += Math.PI * 2;
                                    obj.group.rotation.y += diff * lerpF;
                                }
                                obj.group.position.x = newX;
                                obj.group.position.z = newZ;
                                const bY = obj.baseY != null ? obj.baseY : obj.group.position.y;
                                obj.group.position.y = bY + Math.sin(t8 * 2) * p.yAmp;
                                obj.baseY = bY;
                            }
                            if (m.timer <= 0) {
                                m.state = 'remontee';
                                // Cible aléatoire : 60% surface, 40% mi-profondeur (dans plage utile)
                                const uRange = m.floorY - CEIL_Y;  // négatif
                                if (Math.random() < 0.6) {
                                    m.targetY = CEIL_Y + uRange * (0.05 + Math.random() * 0.15);  // haut
                                } else {
                                    m.targetY = CEIL_Y + uRange * (0.25 + Math.random() * 0.35);  // mi-profondeur
                                }
                            }
                            break;

                        case 'remontee':
                            // Remonte, gueule vers le haut
                            {
                                const diff = m.targetY - obj.group.position.y;
                                if (Math.abs(diff) > 0.5) {
                                    obj.group.position.y += Math.sign(diff) * m.diveSpeed * dt;
                                    // Pitch positif = gueule en haut, proportionnel
                                    const steepness = Math.min(1, Math.abs(diff) / 10);
                                    m.pitchTarget = 0.1 + steepness * 0.5;  // +0.10° à +0.60°
                                } else {
                                    m.pitchTarget = 0;
                                    m.state = 'surface';
                                    m.timer = m.surfDur;
                                    // Nouveau centre de huit
                                    p.cx = obj.group.position.x;
                                    p.cz = obj.group.position.z;
                                    p.phase = Math.random() * Math.PI * 2;
                                    obj.baseY = obj.group.position.y;
                                }
                                // Avancer pendant la remontée
                                const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(
                                    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), obj.group.rotation.y)
                                );
                                obj.group.position.addScaledVector(fwd, speed * 0.3 * dt);
                            }
                            m.pitch = THREE.MathUtils.lerp(m.pitch, m.pitchTarget, Math.min(1, dt * 1.5));
                            break;
                    }

                    // Orientation yaw + pitch : quaternion composé
                    // yawQ = rotation globale Y, pitchQ = rotation locale X (tangage)
                    // multiply applique pitch APRÈS yaw → tangage correct quelle que soit la direction
                    {
                        const yawAngle = obj.group.rotation.y;
                        const yawQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yawAngle);
                        const pitchQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), m.pitch);
                        obj.group.quaternion.copy(yawQ).multiply(pitchQ);
                    }
                }

                // Limites du bassin (mammifères : zone plus large)
                clampToBasin(obj.group.position, obj.config.zone);
                // Sécurité plancher mammifère : empêche le corps de traverser le sol
                if (obj.group.position.y < m.floorY) {
                    obj.group.position.y = m.floorY;
                }
                // Clamp du centre du huit : empêche de sortir du bassin
                // sans attirer vers (0,0) — sinon tous les poissons convergent
                // vers le centre (effet siphon autour de la fosse abyssale).
                const lim = compactHalfW() * 0.85;
                p.cx = THREE.MathUtils.clamp(p.cx, -lim, lim);
                p.cz = THREE.MathUtils.clamp(p.cz, -lim, lim);

            // ═════════════════════════════════════════════════════════════
            //  NAGEANT CLASSIQUE (poissons normaux, sans cycle mammifère)
            // ═════════════════════════════════════════════════════════════
            } else {
                // Phase = vitesse linéaire / rayon moyen → vitesse cohérente quelle que soit la taille
                const avgR = (p.rx + p.rz) * 0.5 || 1;
                const desiredLinSpeed = (p.linSpeed || 1) * (currentSpeed / speed); // IA boost si fuite/curieux
                p.phase += (desiredLinSpeed / avgR) * dt * p.dir;

                // --- Comportement IA : override la trajectoire si proche du ROV ---
                if (iaOverride) {
                    // Déplacement direct vers la cible (fuir/curieux)
                    // Pour poissons (forward=-Z) : ajouter π au yaw cible
                    // P4 : sauf modèle (ré)aligné face +Z par la détection de heading
                    // (headingOffset ≠ 0) → forward=+Z comme les mammifères.
                    const isFish = (obj.config.type !== 'mamifere') && !(obj.headingOffset || 0);
                    const iaYaw = isFish ? obj.targetYaw + Math.PI : obj.targetYaw;
                    const targetQ = new THREE.Quaternion().setFromAxisAngle(
                        new THREE.Vector3(0, 1, 0), iaYaw
                    );
                    const slerpFactor = Math.min(0.12 / sizeCat, turnSpeed * 0.08 / sizeCat * dt * 60);
                    obj.group.quaternion.slerp(targetQ, slerpFactor);
                    const fwdDir = isFish ? -1 : 1;
                    const forward = new THREE.Vector3(0, 0, fwdDir).applyQuaternion(obj.group.quaternion);
                    obj.group.position.addScaledVector(forward, currentSpeed * dt);
                    // Recentrer le huit sur la nouvelle position
                    p.cx = obj.group.position.x;
                    p.cz = obj.group.position.z;
                    // Wobble de nage en mode IA (fuite = nage rapide)
                    const iaWag = 0.15 / Math.pow(sizeCat, 0.5);
                    const iaPhase = clock.elapsedTime * currentSpeed * 8 + idx * 1.7;
                    const iaWobbleQ = new THREE.Quaternion().setFromEuler(
                        new THREE.Euler(0, Math.sin(iaPhase) * iaWag, 0, 'YXZ')
                    );
                    obj.group.quaternion.multiply(iaWobbleQ);
                } else {
                    // --- Trajectoire en huit (lemniscate) avec rotation aléatoire ---
                    const t8 = p.phase;
                    const sinT = Math.sin(t8), cosT = Math.cos(t8);
                    const denom = 1 + sinT * sinT;
                    // Offset local du huit (avant rotation)
                    const localX = p.rx * cosT / denom;
                    const localZ = p.rz * sinT * cosT / denom;
                    // Appliquer la rotation aléatoire du chemin
                    const cA = p.cosA || 1, sA = p.sinA || 0;
                    const newX = p.cx + localX * cA - localZ * sA;
                    const newZ = p.cz + localX * sA + localZ * cA;
                    // Tangente = direction naturelle (inversée pour les poissons : forward=-Z)
                    // P4 — cohérence du signe fwd avec la détection de heading :
                    // - mammifère OU modèle (ré)aligné face +Z par la détection
                    //   (headingOffset ≠ 0 : flip π ou ±90°) → le nez suit la tangente (fwd=+1) ;
                    // - poisson avec headingOffset = 0 (détection muette, rien à corriger)
                    //   → convention historique conservée : GLB poissons supposés face -Z (fwd=-1).
                    const dx = newX - obj.group.position.x;
                    const dz = newZ - obj.group.position.z;
                    const fwd = (obj.config.type === 'mamifere' || (obj.headingOffset || 0) !== 0) ? 1 : -1;
                    const tangentYaw = Math.atan2(dx * fwd, dz * fwd);
                    // Orientation fluide (slerp) : plus lent pour les gros animaux
                    const slerpFactor = Math.min(0.18 / sizeCat, turnSpeed * 0.12 / sizeCat * dt * 60);
                    const targetQ = new THREE.Quaternion().setFromAxisAngle(
                        new THREE.Vector3(0, 1, 0), tangentYaw
                    );
                    obj.group.quaternion.slerp(targetQ, slerpFactor);
                    // Appliquer la position
                    obj.group.position.x = newX;
                    obj.group.position.z = newZ;
                    // Léger mouvement vertical sinusoïdal
                    const baseY = obj.baseY != null ? obj.baseY : obj.group.position.y;
                    obj.group.position.y = baseY + Math.sin(t8 * 2) * p.yAmp;
                    obj.baseY = baseY;
                    // ── Wobble de nage : oscillation queue (yaw) + roulis corps ──
                    const wobbleFreq = (p.linSpeed || 1) / avgR * 6;
                    const wobblePhase = t8 * wobbleFreq;
                    const wagAmp = 0.12 / Math.pow(sizeCat, 0.5);
                    const rollAmp = 0.06 / Math.pow(sizeCat, 0.5);
                    const wobbleQ = new THREE.Quaternion().setFromEuler(
                        new THREE.Euler(0, Math.sin(wobblePhase) * wagAmp, Math.sin(wobblePhase * 0.7) * rollAmp, 'YXZ')
                    );
                    obj.group.quaternion.multiply(wobbleQ);
                }

                // Limites du bassin + maintien dans la zone de profondeur
                clampToBasin(obj.group.position, obj.config.zone);
                // Clamp du centre du huit : empêche de sortir du bassin
                // sans attirer vers (0,0) — évite l'effet siphon.
                // ── P1 : en zone récif, clamp RADIAL dans l'anneau au lieu du clamp ──
                // cubique générique (qui projetait le centre hors anneau, laissant
                // clampToBasin écraser le poisson sur la frontière radiale chaque frame).
                if (obj.config.zone === 'recif' || obj.config.zone === 'sol') {
                    // ── Point 1 (revue) : adaptation dynamique aux sliders 🪸/🏖️ ──
                    // ringGap recalculé chaque frame (reefRing hoisté) ; si l'anneau se
                    // resserre, les rayons du huit rétrécissent (min monotone) et les
                    // centres glissent au pire vers le milieu d'anneau — jamais de snap
                    // hors anneau. Un agrandissement s'absorbe frame par frame.
                    const ringGap = Math.max(1, (reefRing.outerR - reefRing.innerR) / 2 - 1);
                    p.rx = Math.min(p.rx, ringGap);
                    p.rz = Math.min(p.rz, ringGap);
                    const maxExt = Math.max(p.rx, p.rz) + 1; // extension max du huit + marge sécurité
                    // rMin jamais au-delà du milieu d'anneau (modèle dynMaxR mammifère)
                    const rMin = Math.min(reefRing.innerR + maxExt, (reefRing.innerR + reefRing.outerR) / 2);
                    const rMax = Math.max(rMin, reefRing.outerR - maxExt);
                    const r = Math.hypot(p.cx, p.cz);
                    if (r > 0.01 && (r < rMin || r > rMax)) {
                        const rTarget = THREE.MathUtils.clamp(r, rMin, rMax);
                        p.cx *= rTarget / r;
                        p.cz *= rTarget / r;
                    }
                } else {
                    const lim = compactHalfW() * 0.8;
                    p.cx = THREE.MathUtils.clamp(p.cx, -lim, lim);
                    p.cz = THREE.MathUtils.clamp(p.cz, -lim, lim);
                }
            }

        // --- Mode cinématique : ancre_ondule (flore, algues, coraux mous) ---
        } else if (kinematic === 'ancre_ondule') {
            const t = clock.elapsedTime;
            // Restaurer Y à la base (ancré au sol) puis légère oscillation
            const baseY = obj.baseY != null ? obj.baseY : obj.group.position.y;
            const sway = (cfg.speed || 1) * 0.02;
            obj.group.position.y = baseY + Math.sin(t * 1.2 + obj.group.position.x) * sway;
            // Rotation Z = ondulation douce (courant marin)
            obj.group.rotation.z = Math.sin(t * 0.8 + obj.group.position.z) * 0.08;
        }
    });
}

function clampToBasin(pos, zone) {
    const lim = compactHalfW() * 0.9;
    const SURF_MARGIN = 1.5;
    const abyssR = fondZoneRadius();

    // ── Limites réelles des zones depuis les % du terrain ──
    // Point 10 (revue) : reefRingRadii() = source unique des rayons de l'anneau récif
    const _ring = reefRingRadii();
    const beachInnerR = _ring.outerR;   // rayon intérieur plage (= extérieur récif)
    const beachOuterR = WALL_POS;       // rayon extérieur plage (= mur)
    const reefInnerR  = _ring.innerR;   // rayon intérieur récif
    const reefOuterR  = beachInnerR;    // rayon extérieur récif = intérieur plage

    // ── Contraintes X/Z par zone ──
    switch (zone) {
        case 'abysse': {
            const dist = Math.hypot(pos.x, pos.z);
            const maxR = abyssR * 0.90;
            if (dist > maxR && dist > 0.01) {
                const scale = maxR / dist;
                pos.x *= scale;
                pos.z *= scale;
            }
            break;
        }
        case 'plage': {
            const dist = Math.hypot(pos.x, pos.z);
            if (dist < beachInnerR && dist > 0.01) {
                const scale = beachInnerR / dist;
                pos.x *= scale;
                pos.z *= scale;
            } else if (dist > beachOuterR * 0.98) {
                const scale = (beachOuterR * 0.98) / dist;
                pos.x *= scale;
                pos.z *= scale;
            }
            break;
        }
        case 'recif':
        case 'sol': {
            const dist = Math.hypot(pos.x, pos.z);
            if (dist < reefInnerR && dist > 0.01) {
                const scale = reefInnerR / dist;
                pos.x *= scale;
                pos.z *= scale;
            } else if (dist > reefOuterR) {
                const scale = reefOuterR / dist;
                pos.x *= scale;
                pos.z *= scale;
            }
            break;
        }
        case 'fond': {
            const fondMaxR = Math.max(reefInnerR * 0.95, abyssR * 1.2);
            const dist = Math.hypot(pos.x, pos.z);
            if (dist > fondMaxR && dist > 0.01) {
                const scale = fondMaxR / dist;
                pos.x *= scale;
                pos.z *= scale;
            }
            break;
        }
        default:
            pos.x = THREE.MathUtils.clamp(pos.x, -lim, lim);
            pos.z = THREE.MathUtils.clamp(pos.z, -lim, lim);
    }

    // ── Contraintes Y par zone ──
    switch (zone) {
        case 'surface':
            pos.y = THREE.MathUtils.clamp(pos.y, CEIL_Y - 8, CEIL_Y - SURF_MARGIN);
            break;
        case 'recif':
        case 'sol': {
            // Faune : colonne d'eau complète au-dessus du récif ; flore : ancrée au sol
            const floorY = terrainMeshHeightAt(pos.x, pos.z);
            const maxY = floorY + 16; // marge large pour les poissons nageant en hauteur
            pos.y = THREE.MathUtils.clamp(pos.y, floorY - 0.5, maxY);
            break;
        }
        case 'plage': {
            const floorY = terrainMeshHeightAt(pos.x, pos.z);
            pos.y = THREE.MathUtils.clamp(pos.y, floorY - 0.5, floorY + 4);
            break;
        }
        case 'abysse': {
            // Confiné au fond de la fosse
            const floorY = terrainMeshHeightAt(pos.x, pos.z);
            pos.y = THREE.MathUtils.clamp(pos.y, floorY - 0.5, floorY + 4);
            break;
        }
        case 'fond': {
            const floorY = terrainMeshHeightAt(pos.x, pos.z);
            pos.y = THREE.MathUtils.clamp(pos.y, floorY - 0.5, floorY + 5);
            break;
        }
        case 'pleine_eau':
            pos.y = THREE.MathUtils.clamp(pos.y, FLOOR_Y * 0.9, CEIL_Y - SURF_MARGIN);
            break;
        case 'multi_couches': {
            // Entre surface (-2m) et bas du récif, EXcluant la fosse
            const yMin = -reefBottomDepth();
            const yMax = CEIL_Y - SURF_MARGIN;
            pos.y = THREE.MathUtils.clamp(pos.y, yMin, yMax);
            // Repousser hors du rayon de la fosse si dedans
            const dist = Math.hypot(pos.x, pos.z);
            if (dist < abyssR * 0.95 && dist > 0.01) {
                const pushR = abyssR * 1.05;
                const scale = pushR / dist;
                pos.x *= scale;
                pos.z *= scale;
            }
            break;
        }
        default:
            pos.y = THREE.MathUtils.clamp(pos.y, FLOOR_Y + 1, CEIL_Y - SURF_MARGIN);
    }
}

// ===========================================================================
// GAMEPAD (identique au cockpit réel)
// ===========================================================================
function applyGpMapping(mapping) {
    if (!mapping) return;
    if (mapping.settings) gpDeadzone = Math.min((parseInt(mapping.settings.deadzone) || 12) / 100, 0.10);
    const next = {};
    if (mapping.axes) {
        Object.entries(mapping.axes).forEach(([name, cfg]) => {
            const idx = AXIS_NAME_TO_INDEX[name];
            if (idx !== undefined && cfg.function) {
                next[idx] = {
                    function: cfg.function, invert: cfg.invert || false,
                    deadzone: (cfg.deadzone != null) ? Math.min(parseFloat(cfg.deadzone) / 100, 0.30) : null,
                    sensitivity: (cfg.sensitivity != null) ? Math.max(10, Math.min(150, parseFloat(cfg.sensitivity))) / 100 : null,
                };
            }
        });
    }
    Object.keys(gpAxisMap).forEach(k => delete gpAxisMap[k]);
    Object.assign(gpAxisMap, next);
    const nextBtn = {}; const nextCombos = [];
    if (mapping.buttons) {
        Object.entries(mapping.buttons).forEach(([name, cfg]) => {
            if (!cfg || !cfg.function) return;
            if (name.includes('+')) {
                const indices = name.split('+').map(p => BUTTON_NAME_TO_INDEX[p.trim()]);
                if (indices.some(ix => ix === undefined)) return;
                nextCombos.push({ key: name, indices, function: cfg.function });
            } else {
                const idx = BUTTON_NAME_TO_INDEX[name];
                if (idx !== undefined) nextBtn[idx] = cfg.function;
            }
        });
    }
    nextCombos.sort((a, b) => b.indices.length - a.indices.length);
    Object.keys(gpButtonMap).forEach(k => delete gpButtonMap[k]);
    Object.assign(gpButtonMap, nextBtn);
    gpComboList = nextCombos;
    gpComboMembers = new Set();
    nextCombos.forEach(c => c.indices.forEach(ix => gpComboMembers.add(ix)));
    gpPrevCombo = {};
}

async function loadGamepadProfile() {
    try {
        const raw = localStorage.getItem(GP_LS_MAPPING_KEY);
        if (raw) { const stored = JSON.parse(raw); if (stored && (stored.buttons || stored.axes)) { applyGpMapping(stored); return; } }
    } catch (e) {}
    try {
        const resp = await fetch('/api/gamepad/mapping');
        if (!resp.ok) return;
        const data = await resp.json();
        const mapping = data.data || data.mapping;
        if (data.status !== 'ok' || !mapping) return;
        applyGpMapping(mapping);
    } catch (e) {}
}

function applyGpDeadzone(v, dzOverride) {
    const dz = (dzOverride != null) ? dzOverride : gpDeadzone;
    if (Math.abs(v) < dz) return 0;
    const sign = v > 0 ? 1 : -1;
    return sign * (Math.abs(v) - dz) / (1 - dz);
}

function axisFnToDof(fn, val, dof) {
    switch (fn) {
        case 'forward_backward': case 'move_forward': case 'move_backward': case 'surge': dof.surge = val; break;
        case 'lateral': case 'sway': dof.sway = val; break;
        case 'turn': case 'turn_left': case 'turn_right': case 'yaw': dof.yaw = val; break;
        case 'vertical': case 'heave': case 'move_up': case 'move_down': dof.heave = val; break;
        case 'ascent': if (val > 0) dof.heave = val; break;
        case 'descent': if (val > 0) dof.heave = -val; break;
        case 'roll': case 'roll_left': case 'roll_right': dof.roll = val; break;
        case 'pitch': case 'pitch_up': case 'pitch_down': dof.pitch = val; break;
    }
}

function readGamepad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let gp = null;
    for (const p of pads) { if (p && p.connected) { gp = p; break; } }
    if (!gp) { gpConnected = false; return null; }
    gpConnected = true;
    const sens = physState.sens;
    const dof = { surge: 0, sway: 0, heave: 0, yaw: 0, roll: 0, pitch: 0 };
    Object.entries(gpAxisMap).forEach(([idxStr, cfg]) => {
        const idx = parseInt(idxStr);
        if (idx >= gp.axes.length || !cfg.function) return;
        let val = gp.axes[idx];
        if (cfg.invert) val = -val;
        val = applyGpDeadzone(val, cfg.deadzone) * sens;
        if (cfg.sensitivity != null) val *= cfg.sensitivity;
        if (val === 0) return;
        axisFnToDof(cfg.function, val, dof);
    });
    const consumed = new Set();
    gpComboList.forEach(combo => {
        const allDown = combo.indices.every(ix => gp.buttons[ix] && gp.buttons[ix].pressed);
        const wasDown = gpPrevCombo[combo.key] || false;
        if (allDown) {
            combo.indices.forEach(ix => consumed.add(ix));
            const ui = UI_BUTTON_ACTIONS[combo.function];
            if (ui) { if (!wasDown) ui(); }
            else { const m = BUTTON_DOF[combo.function]; if (m) dof[m[0]] = m[1] * sens; }
        }
        gpPrevCombo[combo.key] = allDown;
    });
    Object.entries(gpButtonMap).forEach(([idxStr, fn]) => {
        const idx = parseInt(idxStr);
        const btn = gp.buttons[idx];
        const isDown = !!(btn && btn.pressed) && !consumed.has(idx);
        const wasDown = gpPrevPressed[idx] || false;
        gpPrevPressed[idx] = isDown;
        if (!isDown) return;
        const ui = UI_BUTTON_ACTIONS[fn];
        if (ui) { if (!wasDown) ui(); return; }
        const m = BUTTON_DOF[fn];
        if (m) dof[m[0]] = m[1] * sens;
    });
    return dof;
}


// ===========================================================================
// ENVOI COMMANDES AU BACKEND (WebSocket)
// ===========================================================================
let _lastMoveTime = 0;
let _lastMove = { surge: 0, sway: 0, heave: 0, yaw: 0, roll: 0, pitch: 0 };

function sendMove(dof) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const now = performance.now();
    if (now - _lastMoveTime < 50) return;
    const changed = DOF_ORDER.some(k => Math.abs(dof[k] - _lastMove[k]) > 0.01);
    if (!changed) return;
    _lastMoveTime = now;
    _lastMove = { ...dof };
    ws.send(JSON.stringify({
        command: 'move',
        forward: Math.round(dof.surge * 100), lateral: Math.round(dof.sway * 100),
        vertical: Math.round(dof.heave * 100), yaw: Math.round(dof.yaw * 100),
        roll: Math.round(dof.roll * 100), pitch: Math.round(dof.pitch * 100),
    }));
}

// ===========================================================================
// WEBSOCKET TÉLÉMETRIE
// ===========================================================================
function connectWS() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/ws/telemetry`);
    ws.onopen = () => { reconnectDelay = 1000; setWsDot(true); };
    ws.onclose = () => { setWsDot(false); scheduleReconnect(); };
    ws.onerror = () => ws.close();
    ws.onmessage = (evt) => {
        let msg; try { msg = JSON.parse(evt.data); } catch { return; }
        if (msg.type === 'action_result') return;
        applyTelemetry(msg);
    };
}

function scheduleReconnect() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => { reconnectDelay = Math.min(reconnectDelay * 1.5, 8000); connectWS(); }, reconnectDelay);
}

function setWsDot(ok) { document.getElementById('sim-ws-dot').classList.toggle('connected', ok); }

function applyTelemetry(msg) {
    if (!gpConnected) {
        if (msg.dof && typeof msg.dof === 'object') {
            DOF_ORDER.forEach(k => { if (typeof msg.dof[k] === 'number') target[k] = msg.dof[k]; });
        }
    }
    if (Array.isArray(msg.motors)) { msg.motors.forEach(m => { motorState[m.id] = m.percent || 0; }); updateMotorPanel(); }
    if (typeof msg.armed === 'boolean') setArmedUI(msg.armed);
    updateDofPanel();
}

// ===========================================================================
// PHYSIQUE 6DOF (hydrodynamique)
// ===========================================================================
function orientationQuat() {
    _eulerTmp.set(current.pitch, current.yaw, -current.roll, 'YXZ');
    return _quatTmp.setFromEuler(_eulerTmp);
}

function integratePhysics() {
    const inertia = physState.inertia;
    const gain = physState.gain;

    // Rotations (avec sensibilité indépendante roll/pitch)
    const rotSens = { yaw: 1.0, roll: physState.rollSens, pitch: physState.pitchSens };
    ['yaw', 'roll', 'pitch'].forEach(k => {
        vel[k] = (vel[k] + target[k] * ROT_ACCEL * rotSens[k]) * inertia;
        current[k] += vel[k];
    });
    current.roll = wrapPi(current.roll);
    current.pitch = wrapPi(current.pitch);
    current.yaw = wrapPi(current.yaw);

    // Translations (repère corps)
    ['surge', 'sway', 'heave'].forEach(k => {
        vel[k] = (vel[k] + target[k] * TRANS_ACCEL) * inertia;
    });
    _bodyVel.set(vel.sway, vel.heave, vel.surge).multiplyScalar(gain * physState.speedBoost).applyQuaternion(orientationQuat());
    posWorld.add(_bodyVel);

    // Collision relief latéral
    if (diveState.terrain) {
        const stepUp = floorLimitAt(posWorld.x, posWorld.z) - posWorld.y;
        const hDist = Math.hypot(_bodyVel.x, _bodyVel.z);
        if (stepUp > 0 && hDist > 1e-4 && stepUp / hDist > 0.7) {
            posWorld.x -= _bodyVel.x;
            posWorld.z -= _bodyVel.z;
            vel.surge *= 0.4; vel.sway *= 0.4;
        }
    }

    // Collisions boîte
    const floorLim = floorLimitAt(posWorld.x, posWorld.z);
    const bounds = [
        ['x', -WALL_LIMIT, WALL_LIMIT, _bodyVel.x],
        ['z', -WALL_LIMIT, WALL_LIMIT, _bodyVel.z],
        ['y', floorLim, CEIL_Y, _bodyVel.y],
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
    surfContacts = contacts;
    if (hitBound) { vel.surge *= 0.5; vel.sway *= 0.5; vel.heave *= 0.5; }
    if (impactSpeed > 0) triggerImpactRumble(impactSpeed);
}

function wrapPi(a) {
    while (a > Math.PI) a -= 2 * Math.PI;
    while (a < -Math.PI) a += 2 * Math.PI;
    return a;
}

function triggerImpactRumble(impactSpeed) {
    const now = performance.now();
    if (now - lastImpactTime < IMPACT_COOLDOWN_MS) return;
    lastImpactTime = now;
    const t = Math.min(1, Math.max(0, (impactSpeed - IMPACT_MIN_SPEED) / (IMPACT_MAX_SPEED - IMPACT_MIN_SPEED)));
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const gp of pads) {
        if (!gp || !gp.connected) continue;
        const act = gp.vibrationActuator || (gp.hapticActuators && gp.hapticActuators[0]);
        if (act && typeof act.playEffect === 'function') {
            act.playEffect('dual-rumble', { startDelay: 0, duration: Math.round(100 + t * 300), weakMagnitude: 0.1 + t * 0.9, strongMagnitude: 0.2 + t * 0.8 }).catch(() => {});
        }
        break;
    }
}

// ===========================================================================
// OSD — RENDU CANVAS (horizon, jauges, boussole, propulseurs)
// ===========================================================================
function initOsdCanvas() {
    osdCanvas = document.getElementById('sim-osd-canvas');
    osdCtx = osdCanvas.getContext('2d');
    resizeOsdCanvas();
}

function resizeOsdCanvas() {
    if (!osdCanvas) return;
    osdDpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = window.innerWidth, h = window.innerHeight;
    osdCanvas.width = w * osdDpr;
    osdCanvas.height = h * osdDpr;
    osdCanvas.style.width = w + 'px';
    osdCanvas.style.height = h + 'px';
    osdCtx.setTransform(osdDpr, 0, 0, osdDpr, 0, 0);
}

function renderOsd() {
    if (!osdCtx || !osdCanvas) return;
    const w = osdCanvas.width / osdDpr, h = osdCanvas.height / osdDpr;
    osdCtx.clearRect(0, 0, w, h);
    if (w < 100 || h < 100) return;

    const scale = Math.min(w / 1280, h / 720);
    const fontSize = Math.max(11, Math.round(14 * scale * 0.8));
    const px = pct => Math.round(w * pct / 100);
    const py = pct => Math.round(h * pct / 100);

    // Mettre à jour la télémétrie simulée depuis la physique
    simTelem.depth = Math.max(0, -posWorld.y);
    simTelem.roll = current.roll * 180 / Math.PI;
    simTelem.pitch = current.pitch * 180 / Math.PI;
    simTelem.heading = ((current.yaw * 180 / Math.PI) % 360 + 360) % 360;

    // Filtre bain d'huile
    const damping = 5;
    const alpha = 1.0 / (0.5 + damping * 0.45);
    const fRoll = oilBath(simTelem.roll, 'roll', alpha);
    const fPitch = oilBath(simTelem.pitch, 'pitch', alpha);

    // 1. Horizon artificiel (masquable + opacité + diamètre réglables)
    if (osdConfig.horizonVisible) {
        osdCtx.globalAlpha = osdConfig.horizonOpacity / 100;
        drawHorizon(osdCtx, px(50), py(50), w, h, fRoll, fPitch, '#00FF88', scale, fontSize, osdConfig.horizonDiameter);
    }
    osdCtx.globalAlpha = 1;

    // 2. Profondeur
    osdCtx.globalAlpha = 1;
    drawGauge(osdCtx, px(3), py(15), h, simTelem.depth, 100, 'm', 'PROF', '#00AAFF', scale, fontSize);

    // 3. Température
    drawTextOsd(osdCtx, px(88), py(5), `TEMP: ${simTelem.temperature.toFixed(1)}°C`, '#FFAA00', fontSize, 'right');

    // 4. Boussole
    drawCompass(osdCtx, px(50), py(92), w, simTelem.heading, '#FFFFFF', '#FFD700', scale, fontSize);

    // 5. Batterie
    drawBattery(osdCtx, px(88), py(12), simTelem.battery, '#00CC44', scale, fontSize);

    // 6. Armé/Désarmé
    osdCtx.textAlign = 'center';
    const armedFs = Math.round(fontSize * 1.1);
    osdCtx.font = `bold ${armedFs}px 'Courier New', monospace`;
    osdCtx.fillStyle = armed ? '#FF4444' : '#44FF44';
    osdCtx.fillText(armed ? '● ARMÉ' : '○ DÉSARMÉ', px(50), py(6));

    // 7. Horloge
    const now = new Date();
    drawTextOsd(osdCtx, px(99), py(98), now.toTimeString().substring(0, 8), '#FFFFFF', Math.round(fontSize * 0.85), 'right');

    // 8. FPS
    drawTextOsd(osdCtx, px(2), py(82), `FPS: ${fpsValue}`, '#FFFFFF', Math.round(fontSize * 0.85), 'left');

    // 9. Propulseurs
    const motors = [];
    for (let i = 1; i <= 8; i++) motors.push({ id: i, percent: motorState[i] || 0, thrust: 0 });
    if (motors.some(m => m.percent > 0)) drawMotors(osdCtx, w, h, motors, scale, fontSize);

    osdCtx.globalAlpha = 1;
}

function oilBath(val, key, alpha) {
    const r = applyOilBath(val, osdFilter[key + '1'], osdFilter[key + '2'], alpha);
    osdFilter[key + '1'] = r.pass1;
    osdFilter[key + '2'] = r.pass2;
    return Math.abs(osdFilter[key + '2']) < 0.1 ? 0 : osdFilter[key + '2'];
}

function applyOilBath(input, s1, s2, alpha) {
    const p1 = s1 + alpha * (input - s1);
    const p2 = s2 + alpha * (p1 - s2);
    return { pass1: p1, pass2: p2 };
}

// --- Fonctions de dessin OSD (dérivées de telemetry.js) ---
function drawTextOsd(ctx, x, y, text, color, fontSize, align) {
    ctx.font = `bold ${fontSize}px 'Courier New', monospace`;
    ctx.textAlign = align || 'left';
    ctx.textBaseline = 'middle';
    const metrics = ctx.measureText(text);
    const pad = 4;
    const bx = align === 'right' ? x - metrics.width - pad : x - pad;
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.fillRect(bx, y - fontSize / 2 - 2, metrics.width + pad * 2, fontSize + 4);
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
}

function drawHorizon(ctx, cx, cy, w, h, roll, pitch, color, scale, fontSize, diameterPct) {
    const radius = Math.min(w, h) * ((diameterPct || 18) / 100);
    const pitchScale = 2 * scale;
    const pxPerDeg = pitchScale;
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.save(); ctx.clip();
    ctx.translate(cx, cy); ctx.rotate(-pitch * Math.PI / 180);
    const pitchOffset = roll * pxPerDeg;
    const bandH = radius * 4;
    for (let k = -1; k <= 1; k++) {
        const base = pitchOffset + k * bandH * 2;
        ctx.fillStyle = '#2c6dd5'; ctx.fillRect(-radius * 2, base - bandH, radius * 4, bandH);
        ctx.fillStyle = '#3d2b1f'; ctx.fillRect(-radius * 2, base, radius * 4, bandH);
    }
    ctx.beginPath(); ctx.moveTo(-radius * 1.5, pitchOffset); ctx.lineTo(radius * 1.5, pitchOffset);
    ctx.strokeStyle = '#e6ecff'; ctx.lineWidth = 2 * scale; ctx.stroke();
    // Pitch ladder
    ctx.strokeStyle = 'rgba(230,236,255,0.75)'; ctx.fillStyle = 'rgba(230,236,255,0.75)'; ctx.lineWidth = 1;
    for (let deg = -90; deg <= 90; deg += 10) {
        if (deg === 0) continue;
        const y = -deg * pxPerDeg + pitchOffset;
        if (Math.abs(y) > radius - 4) continue;
        const isMajor = deg % 30 === 0;
        const halfW = isMajor ? radius * 0.45 : radius * 0.22;
        ctx.beginPath(); ctx.moveTo(-halfW, y); ctx.lineTo(halfW, y); ctx.stroke();
    }
    ctx.restore();
    // Ailes
    const wingLen = radius * 0.55;
    ctx.strokeStyle = '#FFFF00'; ctx.lineWidth = 2.5 * scale; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(cx - wingLen, cy); ctx.lineTo(cx - 10 * scale, cy); ctx.lineTo(cx - 5 * scale, cy + 5 * scale); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx + wingLen, cy); ctx.lineTo(cx + 10 * scale, cy); ctx.lineTo(cx + 5 * scale, cy + 5 * scale); ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy, 2.5 * scale, 0, Math.PI * 2); ctx.fillStyle = '#FFFF00'; ctx.fill();
    // Bordure
    ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = 2; ctx.stroke();
    // Texte
    const txtSize = Math.round(fontSize * 0.75);
    ctx.font = `bold ${txtSize}px 'Courier New', monospace`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    const txtY = cy + radius + 14 * scale;
    ctx.fillStyle = Math.abs(roll) > 30 ? '#FF8800' : color;
    ctx.fillText(`R: ${roll >= 0 ? '+' : ''}${roll.toFixed(1)}°`, cx - 40, txtY);
    ctx.fillStyle = Math.abs(pitch) > 30 ? '#FF8800' : color;
    ctx.fillText(`P: ${pitch >= 0 ? '+' : ''}${pitch.toFixed(1)}°`, cx + 40, txtY);
    ctx.restore();
}

function drawGauge(ctx, x, y, canvasH, value, maxVal, unit, label, color, scale, fontSize) {
    const barW = 14 * scale, barH = canvasH * 0.3;
    ctx.fillStyle = 'rgba(0,0,0,0.4)'; ctx.fillRect(x - 2, y - 18, barW + 55, barH + 35);
    const pct = Math.min(Math.max(value / maxVal, 0), 1);
    const fillH = pct * barH;
    ctx.strokeStyle = 'rgba(255,255,255,0.3)'; ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(barW), Math.round(barH));
    ctx.fillStyle = color; ctx.fillRect(x, y + barH - fillH, barW, fillH);
    ctx.font = `bold ${Math.round(fontSize * 0.9)}px 'Courier New'`;
    ctx.fillStyle = '#FFFFFF'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(`${value.toFixed(1)}${unit}`, x, y + barH + 14);
    ctx.font = `${Math.round(fontSize * 0.7)}px 'Courier New'`;
    ctx.fillStyle = color; ctx.fillText(label, x, y - 8);
}

function drawCompass(ctx, cx, cy, canvasW, heading, color, accent, scale, fontSize) {
    const barW = canvasW * 0.3;
    ctx.fillStyle = 'rgba(0,0,0,0.4)'; ctx.fillRect(cx - barW / 2 - 8, cy - 16, barW + 16, 32);
    const dirs = { 0: 'N', 90: 'E', 180: 'S', 270: 'O' };
    ctx.font = `bold ${Math.round(fontSize * 0.9)}px 'Courier New'`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const [deg, lbl] of Object.entries(dirs)) {
        let offset = parseInt(deg) - heading;
        while (offset > 180) offset -= 360;
        while (offset < -180) offset += 360;
        const pxc = cx + (offset * barW / 180);
        if (pxc >= cx - barW / 2 && pxc <= cx + barW / 2) {
            ctx.fillStyle = lbl === 'N' ? accent : color; ctx.fillText(lbl, pxc, cy);
        }
    }
    ctx.strokeStyle = accent; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(cx, cy - 12); ctx.lineTo(cx, cy + 12); ctx.stroke();
    ctx.fillStyle = color; ctx.textAlign = 'left';
    ctx.fillText(`CAP ${Math.round(heading).toString().padStart(3, '0')}°`, cx + barW / 2 + 8, cy);
}

function drawBattery(ctx, x, y, battery, color, scale, fontSize) {
    const barW = 80 * scale, barH = 12 * scale;
    ctx.fillStyle = 'rgba(0,0,0,0.4)'; ctx.fillRect(x - 4, y - 4, barW + 45, barH + 8);
    const pct = Math.max(0, Math.min(battery / 100, 1));
    ctx.fillStyle = 'rgba(80,80,80,0.6)'; ctx.fillRect(x, y, barW, barH);
    ctx.fillStyle = pct > 0.5 ? color : (pct > 0.2 ? '#FFD700' : '#FF4444');
    ctx.fillRect(x, y, barW * pct, barH);
    ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(barW), Math.round(barH));
    ctx.font = `bold ${Math.round(fontSize * 0.8)}px 'Courier New'`;
    ctx.fillStyle = '#FFFFFF'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(`${Math.round(battery)}%`, x + barW + 5, y + barH / 2);
}

function drawMotors(ctx, w, h, motors, scale, fontSize) {
    const widgetW = Math.round(150 * scale), widgetH = Math.round(130 * scale);
    const baseX = 10, baseY = h - widgetH - 10;
    ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(baseX, baseY, widgetW, widgetH);
    ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = 1;
    ctx.strokeRect(baseX + 0.5, baseY + 0.5, widgetW, widgetH);
    const titleSize = Math.max(9, Math.round(fontSize * 0.7));
    ctx.font = `bold ${titleSize}px 'Courier New', monospace`;
    ctx.fillStyle = '#FFFFFF'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText('PROP', baseX + 5, baseY + 4);
    const cx = baseX + widgetW / 2, cy = baseY + widgetH * 0.52;
    const spreadH = Math.round(48 * scale), spreadV = Math.round(28 * scale);
    const dyTop = Math.round(-28 * scale), dyBot = Math.round(28 * scale);
    const positions = {
        1: { x: cx + spreadH, y: cy + dyTop }, 2: { x: cx + spreadH, y: cy + dyBot },
        3: { x: cx - spreadH, y: cy + dyBot }, 4: { x: cx - spreadH, y: cy + dyTop },
        5: { x: cx + spreadV, y: cy + dyTop }, 6: { x: cx + spreadV, y: cy + dyBot },
        7: { x: cx - spreadV, y: cy + dyBot }, 8: { x: cx - spreadV, y: cy + dyTop },
    };
    const maxR = Math.max(4, Math.round(11 * scale)), minR = Math.max(2, Math.round(4 * scale));
    const labelSize = Math.max(8, Math.round(fontSize * 0.6));
    for (const motor of motors) {
        const pos = positions[motor.id]; if (!pos) continue;
        const pct = motor.percent || 0;
        const clr = pct > 1 ? '#00FF88' : '#555555';
        const radius = minR + Math.round((maxR - minR) * (pct / 100));
        ctx.beginPath(); ctx.arc(pos.x, pos.y, radius, 0, Math.PI * 2); ctx.fillStyle = clr; ctx.fill();
        ctx.beginPath(); ctx.arc(pos.x, pos.y, maxR, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255,255,255,0.3)'; ctx.lineWidth = 1; ctx.stroke();
        ctx.font = `bold ${labelSize}px 'Courier New', monospace`; ctx.fillStyle = '#FFFFFF';
        ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        ctx.fillText(`M${motor.id}`, pos.x, pos.y + maxR + 3);
    }
}


// ===========================================================================
// PANNEAUX UI : propulseurs, DOF, télémétrie
// ===========================================================================
function buildMotorPanel() {
    const build = (container, ids, cls) => {
        const el = document.getElementById(container);
        el.innerHTML = ids.map(id => `
            <div class="m-row">
                <span class="m-swatch ${cls}"></span>
                <span class="m-name">${MOTOR_NAMES[id]}</span>
                <div class="m-bar"><div class="m-bar-fill" id="sim-m${id}" style="width:0%"></div></div>
                <span class="m-pct" id="sim-mp${id}">0%</span>
            </div>`).join('');
    };
    build('sim-motors-h', H_MOTORS, 'h');
    build('sim-motors-v', V_MOTORS, 'v');
}

function updateMotorPanel() {
    for (let i = 1; i <= 8; i++) {
        const pct = motorState[i] || 0;
        const bar = document.getElementById(`sim-m${i}`);
        const lbl = document.getElementById(`sim-mp${i}`);
        if (bar) { bar.style.width = pct + '%'; bar.style.background = pct > 50 ? '#35d0ba' : '#ff5a6a'; }
        if (lbl) lbl.textContent = Math.round(pct) + '%';
    }
}

function buildDofPanel() {
    const el = document.getElementById('sim-dof-rows');
    el.innerHTML = DOF_ORDER.map(k => `
        <div class="dof-row">
            <span class="dof-label">${DOF_LABELS[k]}</span>
            <div class="dof-track"><div class="dof-fill" id="sim-df-${k}"></div></div>
            <span class="dof-val" id="sim-dv-${k}">0.00</span>
        </div>`).join('');
}

function updateDofPanel() {
    DOF_ORDER.forEach(k => {
        const fill = document.getElementById(`sim-df-${k}`);
        const val = document.getElementById(`sim-dv-${k}`);
        const v = target[k];
        if (fill) {
            const pct = Math.abs(v) * 50;
            fill.style.width = pct + '%';
            fill.style.left = v >= 0 ? '50%' : (50 - pct) + '%';
        }
        if (val) val.textContent = v.toFixed(2);
    });
}

function updateTelemetryPanel() {
    const el = id => document.getElementById(id);
    el('stq-depth').textContent = simTelem.depth.toFixed(1) + 'm';
    el('stq-temp').textContent = simTelem.temperature.toFixed(1) + '°C';
    el('stq-heading').textContent = Math.round(simTelem.heading).toString().padStart(3, '0') + '°';
    el('stq-battery').textContent = Math.round(simTelem.battery) + '%';
    el('stq-roll').textContent = simTelem.roll.toFixed(1) + '°';
    el('stq-pitch').textContent = simTelem.pitch.toFixed(1) + '°';
}

// ===========================================================================
// ACTIONS (armement, FPV, reset, vues)
// ===========================================================================
function setArmedUI(val) {
    armed = val;
    const btn = document.getElementById('sim-btn-arm');
    if (btn) { btn.classList.toggle('armed', val); btn.textContent = val ? '🔓 ARMÉ' : '🔒 DÉSARMÉ'; }
}

function setFpv(active) {
    isFpvActive = active;
    const btn = document.getElementById('sim-btn-fpv');
    if (btn) btn.classList.toggle('active', active);
    controls.enabled = !active;
    if (!active) {
        // En passant en vue extérieure : recentrer sur le ROV par défaut
        recenterOnROV();
    }
}

/**
 * Recentre la caméra extérieure sur le ROV et réactive le suivi.
 * Accessible via bouton IHM, touche R, ou gamepad.
 */
function recenterOnROV() {
    if (!modelGroup || !controls) return;
    const rovPos = modelGroup.position.clone();
    // Calculer un offset de caméra par rapport au ROV (derrière + au-dessus)
    const offset = new THREE.Vector3(2.5, 2.0, 3.5);
    const camTarget = rovPos.clone().add(offset);
    // Animation douce (lerp sur quelques frames via damping)
    controls.target.copy(rovPos);
    camera.position.copy(camTarget);
    controls.update();
    followROV = true;
    updateFollowBadge();
}

function updateFollowBadge() {
    const badge = document.getElementById('sim-follow-badge');
    if (badge) {
        badge.textContent = followROV ? '🎯 Suivi ROV' : '🌊 Caméra libre';
        badge.style.color = followROV ? '#35d0ba' : '#ffa726';
    }
}

function resetPose() {
    posWorld.set(0, 0, 0);
    current.yaw = current.roll = current.pitch = 0;
    vel.surge = vel.sway = vel.heave = vel.yaw = vel.roll = vel.pitch = 0;
    DOF_ORDER.forEach(k => target[k] = 0);
}

function setView(preset) {
    setFpv(false);
    if (preset === '34') camera.position.set(3, 3, 5);
    else if (preset === 'top') camera.position.set(0, 6, 0.01);
    else if (preset === 'side') camera.position.set(5, 0.5, 0);
    controls.target.copy(modelGroup.position);
    followROV = true;
    updateFollowBadge();
    controls.update();
}

function initActionButtons() {
    document.getElementById('sim-btn-arm').addEventListener('click', () => {
        armed = !armed; setArmedUI(armed);
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ command: armed ? 'arm' : 'disarm' }));
        }
    });
    document.getElementById('sim-btn-fpv').addEventListener('click', () => setFpv(!isFpvActive));
    document.getElementById('sim-btn-reset').addEventListener('click', resetPose);
    document.getElementById('sim-btn-light').addEventListener('click', function() {
        diveState.led = !diveState.led;
        this.classList.toggle('active', diveState.led);
        applyLed();
        saveSettings();
    });
    document.getElementById('sim-btn-view-34').addEventListener('click', () => setView('34'));
    document.getElementById('sim-btn-view-top').addEventListener('click', () => setView('top'));
    document.getElementById('sim-btn-view-side').addEventListener('click', () => setView('side'));
    document.getElementById('sim-btn-recenter').addEventListener('click', recenterOnROV);
    // Touche R = recentrer sur le ROV (fonctionne même en FPV)
    window.addEventListener('keydown', (e) => {
        if (e.key === 'r' || e.key === 'R') {
            // Ignorer si un champ input est actif
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
            if (!isFpvActive) recenterOnROV();
        }
    });
}

// ===========================================================================
// PERSISTANCE RÉGLAGES (localStorage)
// ===========================================================================
function loadSettings() {
    try {
        const raw = localStorage.getItem(SETTINGS_KEY);
        if (!raw) return;
        const saved = JSON.parse(raw);
        if (saved.physState) Object.assign(physState, saved.physState);
        if (saved.diveState) Object.assign(diveState, saved.diveState);
        if (saved.osdConfig) Object.assign(osdConfig, saved.osdConfig);
        // Synchroniser les constantes dérivées
        FLOOR_Y = -diveState.depth;
        WALL_POS = diveState.extent / 2;
        WALL_LIMIT = WALL_POS - 0.5;
        REEF_DEPTH = beachBottomDepth();
        // Restaurer la position et l'orientation du ROV
        if (saved.rovPos) {
            posWorld.set(saved.rovPos.x || 0, saved.rovPos.y || 0, saved.rovPos.z || 0);
        }
        if (saved.rovRot) {
            current.yaw   = saved.rovRot.yaw   || 0;
            current.pitch = saved.rovRot.pitch || 0;
            current.roll  = saved.rovRot.roll  || 0;
        }
        console.log(`[SubSim] Réglages restaurés: depth=${diveState.depth}m extent=${diveState.extent}m vis=${diveState.visibility}m pos=(${posWorld.x.toFixed(1)},${posWorld.y.toFixed(1)},${posWorld.z.toFixed(1)}) yaw=${(current.yaw * 180 / Math.PI).toFixed(0)}°`);
    } catch (e) { /* première visite, valeurs par défaut */ }
}

function saveSettings() {
    try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify({
            physState: { inertia: physState.inertia, gain: physState.gain, sens: physState.sens, rollSens: physState.rollSens, pitchSens: physState.pitchSens, speedBoost: physState.speedBoost },
            diveState: { depth: diveState.depth, visibility: diveState.visibility, extent: diveState.extent,
                         beachExtent: diveState.beachExtent, beachDepthPct: diveState.beachDepthPct,
                         reefExtent: diveState.reefExtent, reefDepthPct: diveState.reefDepthPct,
                         led: diveState.led, ledIntensity: diveState.ledIntensity, ledTilt: diveState.ledTilt },
            osdConfig: { horizonVisible: osdConfig.horizonVisible, horizonOpacity: osdConfig.horizonOpacity,
                         horizonDiameter: osdConfig.horizonDiameter },
            rovPos: { x: posWorld.x, y: posWorld.y, z: posWorld.z },
            rovRot: { yaw: current.yaw, pitch: current.pitch, roll: current.roll },
        }));
    } catch (e) {}
}

/**
 * Synchronise les valeurs HTML des sliders/checkboxes avec physState/diveState
 * (appelée après loadSettings pour afficher les valeurs restaurées).
 */
function syncSlidersUI() {
    const sync = (id, value, fmt) => {
        const slider = document.getElementById(id);
        const valEl = document.getElementById(id + '-val');
        if (slider) slider.value = value;
        if (valEl) valEl.textContent = fmt(value);
    };
    sync('sim-inertia', physState.inertia, v => parseFloat(v).toFixed(2));
    sync('sim-gain',    physState.gain,    v => parseFloat(v).toFixed(1) + '×');
    sync('sim-sens',    physState.sens,    v => Math.round(parseFloat(v) * 100) + '%');
    sync('sim-roll-sens',  physState.rollSens,  v => Math.round(parseFloat(v) * 100) + '%');
    sync('sim-pitch-sens', physState.pitchSens, v => Math.round(parseFloat(v) * 100) + '%');
    sync('sim-speed-boost', physState.speedBoost, v => v + '×');
    sync('sim-depth',     diveState.depth,     v => v + ' m');
    sync('sim-extent',    diveState.extent,    v => v + ' m');
    sync('sim-visibility', diveState.visibility, v => v + ' m');
    sync('sim-beach-extent', diveState.beachExtent, v => v + ' %');
    sync('sim-beach-depth',  diveState.beachDepthPct, v => v + ' %');
    sync('sim-reef-extent',  diveState.reefExtent, v => v + ' %');
    sync('sim-reef-depth',   diveState.reefDepthPct, v => v + ' %');
    // LED
    sync('sim-led-intensity', diveState.ledIntensity, v => v + ' %');
    sync('sim-led-tilt', diveState.ledTilt, v => v + '°');
    // Bouton lumière : synchroniser l'état visuel
    const lightBtn = document.getElementById('sim-btn-light');
    if (lightBtn) lightBtn.classList.toggle('active', diveState.led);
    // OSD
    sync('sim-osd-horizon-opacity',  osdConfig.horizonOpacity,  v => v + ' %');
    sync('sim-osd-horizon-diameter', osdConfig.horizonDiameter, v => v + ' %');
    const horizonChk = document.getElementById('sim-osd-horizon-visible');
    if (horizonChk) horizonChk.checked = osdConfig.horizonVisible;
}

// ===========================================================================
// SLIDERS PHYSIQUE & ENVIRONNEMENT
// ===========================================================================
function bindSliders() {
    const bind = (id, key, stateObj, fmt, cb) => {
        const slider = document.getElementById(id);
        const valEl = document.getElementById(id + '-val');
        if (!slider) return;
        slider.addEventListener('input', () => {
            stateObj[key] = parseFloat(slider.value);
            if (valEl) valEl.textContent = fmt(slider.value);
            if (cb) cb();
            saveSettings();
        });
    };
    bind('sim-inertia', 'inertia', physState, v => parseFloat(v).toFixed(2));
    bind('sim-gain', 'gain', physState, v => parseFloat(v).toFixed(1) + '×');
    bind('sim-sens', 'sens', physState, v => Math.round(parseFloat(v) * 100) + '%');
    bind('sim-roll-sens', 'rollSens', physState, v => Math.round(parseFloat(v) * 100) + '%');
    bind('sim-pitch-sens', 'pitchSens', physState, v => Math.round(parseFloat(v) * 100) + '%');
    bind('sim-speed-boost', 'speedBoost', physState, v => v + '×');
    bind('sim-depth', 'depth', diveState, v => v + ' m', () => applyBasinSize());
    bind('sim-extent', 'extent', diveState, v => v + ' m', () => applyBasinSize());
    bind('sim-visibility', 'visibility', diveState, v => v + ' m', () => {
        scene.fog = new THREE.FogExp2(0x0b1020, 1.7 / diveState.visibility);
        updateTerrainBiomeUniforms();
    });
    // ── Point 8 (revue) : coalescence des reconstructions lourdes pendant le drag ──
    // Chaque 'input' des sliders zones déclenchait la reconstruction complète
    // (murs + surface + caustiques + god rays + terrain ~102k vertices × fbm à extent 1000)
    // → jank sur Pi 5. Les événements sont regroupés : au plus une reconstruction
    // planifiée à la fois ; le timer lit diveState à son exécution → le DERNIER état
    // du drag est toujours appliqué (~80 ms après le dernier mouvement en continu).
    let _zoneRebuildTimer = null;
    const rebuildTerrain = () => {
        if (_zoneRebuildTimer) return;  // une reconstruction est déjà planifiée : ignorer
        _zoneRebuildTimer = setTimeout(() => {
            _zoneRebuildTimer = null;
            applyBasinSize();
            if (diveState.terrain && terrainMesh) { updateTerrainGeometry(); updateTerrainBiomeUniforms(); }
        }, 80);
    };
    bind('sim-beach-extent', 'beachExtent', diveState, v => v + ' %', rebuildTerrain);
    bind('sim-beach-depth',  'beachDepthPct', diveState, v => v + ' %', rebuildTerrain);
    bind('sim-reef-extent',  'reefExtent', diveState, v => v + ' %', rebuildTerrain);
    bind('sim-reef-depth',   'reefDepthPct', diveState, v => v + ' %', rebuildTerrain);

    // --- Projecteurs LED ---
    bind('sim-led-intensity', 'ledIntensity', diveState, v => v + ' %', () => applyLed());
    bind('sim-led-tilt', 'ledTilt', diveState, v => v + '°', () => applyLed());

    // --- OSD : Horizon artificiel ---
    document.getElementById('sim-osd-horizon-visible').addEventListener('change', function() {
        osdConfig.horizonVisible = this.checked; saveSettings();
    });
    bind('sim-osd-horizon-opacity', 'horizonOpacity', osdConfig, v => v + ' %');
    bind('sim-osd-horizon-diameter', 'horizonDiameter', osdConfig, v => v + ' %');
}

function applyBasinSize() {
    FLOOR_Y = -diveState.depth;
    WALL_POS = Math.max(10, diveState.extent / 2);
    WALL_LIMIT = WALL_POS - 0.5;
    // REEF_DEPTH dynamique : profondeur du sommet du récif (= bas de la plage)
    REEF_DEPTH = beachBottomDepth();
    const far = Math.max(100, diveState.depth * 2.5, diveState.extent * 1.8);
    camera.far = far;
    camera.updateProjectionMatrix();
    fpvCamera.far = far;
    fpvCamera.updateProjectionMatrix();
    controls.maxDistance = Math.max(25, diveState.depth * 1.5, diveState.extent * 0.9);
    // Grille
    if (gridHelper) { scene.remove(gridHelper); gridHelper.geometry.dispose(); gridHelper.material.dispose(); }
    const ext = WALL_POS * 2;
    const cell = ext <= 120 ? 1 : (ext <= 400 ? 5 : 10);
    gridHelper = new THREE.GridHelper(ext, Math.max(2, Math.round(ext / cell)), 0x35d0ba, 0x24304d);
    gridHelper.position.y = FLOOR_Y;
    gridHelper.material.transparent = true;
    scene.add(gridHelper);
    // Ombre au sol
    if (shadowGround) {
        const s = (WALL_POS * 2) / 20;
        shadowGround.scale.set(s, s, 1);
        shadowGround.position.y = FLOOR_Y;
    }
    // Parois
    if (wallsGroup) { scene.remove(wallsGroup); wallsGroup.traverse(o => { if (o.isMesh) o.geometry.dispose(); }); wallsGroup = null; }
    buildWalls();
    // Terrain
    if (diveState.terrain && terrainMesh) rebuildTerrainGeometry();
    updateAlgaeAnchors();
    // Surface + caustiques + god rays
    buildSurface();
    buildCaustics();
    buildGodRays();
    _lastSunF = -1;
}

// ===========================================================================
// PANNEAUX FLOTTANTS (drag + collapse)
// ===========================================================================
const PANEL_IDS = ['sim-actions-panel', 'sim-phys-panel', 'sim-dive-panel', 'sim-osd-panel', 'sim-motors-panel', 'sim-dof-panel', 'sim-telemetry-panel', 'sim-radar-panel'];
const PANELS_KEY = 'subsim.panels';
let panelsState = {};
let panelZTop = 20;

function loadPanelsState() {
    try { const d = JSON.parse(localStorage.getItem(PANELS_KEY) || 'null'); if (d && typeof d === 'object') panelsState = d; } catch (e) { panelsState = {}; }
}
function savePanelsState() { try { localStorage.setItem(PANELS_KEY, JSON.stringify(panelsState)); } catch (e) {} }

function placePanel(panel, x, y) {
    const cx = Math.min(Math.max(0, x), Math.max(0, innerWidth - panel.offsetWidth));
    const cy = Math.min(Math.max(0, y), Math.max(0, innerHeight - panel.offsetHeight));
    panel.style.left = cx + 'px'; panel.style.top = cy + 'px';
    panel.style.right = 'auto'; panel.style.bottom = 'auto';
}

function initFloatingPanels() {
    loadPanelsState();
    PANEL_IDS.forEach(id => {
        const panel = document.getElementById(id);
        const title = panel ? panel.querySelector('h2') : null;
        if (!panel || !title) return;
        const st = panelsState[id] || (panelsState[id] = {});

        const body = document.createElement('div'); body.className = 'panel-body';
        while (panel.firstChild) body.appendChild(panel.firstChild);
        const head = document.createElement('div'); head.className = 'panel-head';
        head.appendChild(title);
        const btn = document.createElement('button'); btn.className = 'panel-toggle'; btn.title = 'Replier / Déplier';
        head.appendChild(btn);
        panel.appendChild(head); panel.appendChild(body);

        const applyCollapsed = c => { panel.classList.toggle('collapsed', c); btn.textContent = c ? '▼' : '▲'; };
        const toggleCollapsed = () => { st.collapsed = !st.collapsed; applyCollapsed(st.collapsed); savePanelsState(); };
        applyCollapsed(!!st.collapsed);
        btn.addEventListener('click', e => { e.stopPropagation(); toggleCollapsed(); });
        if (Number.isFinite(st.x) && Number.isFinite(st.y)) placePanel(panel, st.x, st.y);
        panel.addEventListener('pointerdown', () => { panel.style.zIndex = String(++panelZTop); }, true);

        let drag = null;
        head.addEventListener('pointerdown', e => {
            if (e.pointerType === 'mouse' && e.button !== 0) return;
            if (e.target === btn) return;
            const r = panel.getBoundingClientRect();
            drag = { startX: e.clientX, startY: e.clientY, origX: r.left, origY: r.top, moved: false };
            head.setPointerCapture(e.pointerId);
        });
        head.addEventListener('pointermove', e => {
            if (!drag) return;
            const dx = e.clientX - drag.startX, dy = e.clientY - drag.startY;
            if (!drag.moved) { if (Math.hypot(dx, dy) < 5) return; drag.moved = true; panel.classList.add('dragging'); }
            placePanel(panel, drag.origX + dx, drag.origY + dy);
        });
        head.addEventListener('pointerup', () => {
            if (!drag) return; panel.classList.remove('dragging');
            if (drag.moved) { const r = panel.getBoundingClientRect(); st.x = Math.round(r.left); st.y = Math.round(r.top); savePanelsState(); }
            else toggleCollapsed();
            drag = null;
        });
        head.addEventListener('pointercancel', () => { panel.classList.remove('dragging'); drag = null; });
    });
}

// ===========================================================================
// SURFACE DE L'EAU (vagues Gerstner — shader GPU)
// ===========================================================================

// Shader vertex : 6 vagues Gerstner superposées, normales analytiques, écume
const _SURFACE_VS = /* glsl */`
uniform float uTime;
uniform float uWaveHeight;
uniform float uBeachInnerDist;   // rayon intérieur zone plage (m)
uniform float uBeachOuterDist;   // rayon extérieur zone plage = WALL_POS (m)
uniform float uBeachBoost;       // multiplicateur amplitude sur la plage (2-4×)
varying vec3 vWorldPos;
varying vec3 vNormal;
varying float vFoam;
varying float vElevation;
varying vec3 vViewDir;
varying float vBeachT;           // 0 = pleine mer, 1 = zone plage
#include <fog_pars_vertex>

// Vague Gerstner avec tangentes partielles pour normales analytiques
// Retourne vec3(dx, dy, dz) de déplacement
vec3 gerstner(vec2 pos, float amp, float freq, float speed, vec2 dir, float steepness, float t,
              out float dDx, out float dDz) {
    float phase = freq * dot(dir, pos) - speed * t;
    float s = sin(phase), c = cos(phase);
    float Q = steepness / (freq * amp * 4.0 + 0.001);
    float dx = Q * amp * dir.x * c;
    float dy = amp * s;
    float dz = Q * amp * dir.y * c;
    // Dérivées partielles pour le calcul de la normale
    dDx = Q * dir.x * dir.x * (-s) + dir.x * c * steepness * 0.25;
    dDz = Q * dir.y * dir.y * (-s) + dir.y * c * steepness * 0.25;
    return vec3(dx, dy, dz);
}

void main() {
    vec3 p = position;
    float t = uTime;
    // ── Boost plage : amplification des vagues au-dessus de la zone plage (shoaling) ──
    float dist = length(p.xz);
    float beachRange = max(uBeachOuterDist - uBeachInnerDist, 0.01);
    float beachT = smoothstep(uBeachInnerDist, uBeachOuterDist, dist);
    // Le boost augmente en allant vers le bord (eaux moins profondes = vagues plus fortes)
    float h = uWaveHeight * (1.0 + (uBeachBoost - 1.0) * beachT);
    // 6 vagues de fréquences/directions/amplitudes variées pour réalisme
    float d1, d2;
    vec3 w1 = gerstner(p.xz, h*0.45, 0.70, 1.10, normalize(vec2( 1.0,  0.3)), 0.55, t, d1, d2);
    vec3 w2 = gerstner(p.xz, h*0.30, 1.30, 0.85, normalize(vec2(-0.5,  1.0)), 0.45, t, d1, d2);
    vec3 w3 = gerstner(p.xz, h*0.18, 2.20, 1.40, normalize(vec2( 0.7, -0.6)), 0.35, t, d1, d2);
    vec3 w4 = gerstner(p.xz, h*0.10, 3.50, 1.80, normalize(vec2(-0.3, -0.8)), 0.25, t, d1, d2);
    vec3 w5 = gerstner(p.xz, h*0.06, 5.50, 2.20, normalize(vec2( 0.9,  0.5)), 0.15, t, d1, d2);
    vec3 w6 = gerstner(p.xz, h*0.03, 8.00, 2.80, normalize(vec2(-0.7,  0.4)), 0.10, t, d1, d2);
    p.x += w1.x + w2.x + w3.x + w4.x + w5.x + w6.x;
    p.y += w1.y + w2.y + w3.y + w4.y + w5.y + w6.y;
    p.z += w1.z + w2.z + w3.z + w4.z + w5.z + w6.z;
    // Élévation totale pour détection de crêtes (écume)
    float elevation = w1.y + w2.y + w3.y + w4.y + w5.y + w6.y;
    // Normale analytique par différences finies dans le vertex shader
    float eps = 0.15;
    vec3 pR = position + vec3(eps, 0.0, 0.0);
    vec3 pF = position + vec3(0.0, 0.0, eps);
    vec3 wR1 = gerstner(pR.xz, h*0.45, 0.70, 1.10, normalize(vec2( 1.0,  0.3)), 0.55, t, d1, d2);
    vec3 wR2 = gerstner(pR.xz, h*0.30, 1.30, 0.85, normalize(vec2(-0.5,  1.0)), 0.45, t, d1, d2);
    vec3 wR3 = gerstner(pR.xz, h*0.18, 2.20, 1.40, normalize(vec2( 0.7, -0.6)), 0.35, t, d1, d2);
    vec3 wR4 = gerstner(pR.xz, h*0.10, 3.50, 1.80, normalize(vec2(-0.3, -0.8)), 0.25, t, d1, d2);
    vec3 wR5 = gerstner(pR.xz, h*0.06, 5.50, 2.20, normalize(vec2( 0.9,  0.5)), 0.15, t, d1, d2);
    vec3 wR6 = gerstner(pR.xz, h*0.03, 8.00, 2.80, normalize(vec2(-0.7,  0.4)), 0.10, t, d1, d2);
    pR.x += wR1.x + wR2.x + wR3.x + wR4.x + wR5.x + wR6.x;
    pR.y += wR1.y + wR2.y + wR3.y + wR4.y + wR5.y + wR6.y;
    pR.z += wR1.z + wR2.z + wR3.z + wR4.z + wR5.z + wR6.z;
    vec3 wF1 = gerstner(pF.xz, h*0.45, 0.70, 1.10, normalize(vec2( 1.0,  0.3)), 0.55, t, d1, d2);
    vec3 wF2 = gerstner(pF.xz, h*0.30, 1.30, 0.85, normalize(vec2(-0.5,  1.0)), 0.45, t, d1, d2);
    vec3 wF3 = gerstner(pF.xz, h*0.18, 2.20, 1.40, normalize(vec2( 0.7, -0.6)), 0.35, t, d1, d2);
    vec3 wF4 = gerstner(pF.xz, h*0.10, 3.50, 1.80, normalize(vec2(-0.3, -0.8)), 0.25, t, d1, d2);
    vec3 wF5 = gerstner(pF.xz, h*0.06, 5.50, 2.20, normalize(vec2( 0.9,  0.5)), 0.15, t, d1, d2);
    vec3 wF6 = gerstner(pF.xz, h*0.03, 8.00, 2.80, normalize(vec2(-0.7,  0.4)), 0.10, t, d1, d2);
    pF.x += wF1.x + wF2.x + wF3.x + wF4.x + wF5.x + wF6.x;
    pF.y += wF1.y + wF2.y + wF3.y + wF4.y + wF5.y + wF6.y;
    pF.z += wF1.z + wF2.z + wF3.z + wF4.z + wF5.z + wF6.z;
    vec3 tangent = normalize(pR - p);
    vec3 bitangent = normalize(pF - p);
    vec3 n = normalize(cross(bitangent, tangent));
    // Écume : proportionnelle à l'élévation au-dessus du niveau moyen
    float waveMax = h * 1.1;
    vFoam = smoothstep(waveMax * 0.35, waveMax * 0.75, elevation);
    // Écume supplémentaire en zone plage (brassage continu)
    float beachChurn = sin(t * 2.5 + dist * 0.8) * 0.5 + 0.5;
    vFoam = max(vFoam, beachT * beachChurn * 0.6);
    vElevation = elevation;
    vBeachT = beachT;
    vWorldPos = (modelMatrix * vec4(p, 1.0)).xyz;
    vNormal = normalize(normalMatrix * n);
    vViewDir = cameraPosition - vWorldPos;
    vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
}`;

// Shader fragment : eau réaliste — Fresnel Schlick, réflexion ciel, SSS, écume, glitter
const _SURFACE_FS = /* glsl */`
uniform vec3 uSunDir;
uniform float uTime;
varying vec3 vWorldPos;
varying vec3 vNormal;
varying float vFoam;
varying float vElevation;
varying vec3 vViewDir;
varying float vBeachT;
#include <fog_pars_fragment>

// Fresnel Schlick : approximation physique réaliste
float fresnelSchlick(float cosTheta, float F0) {
    return F0 + (1.0 - F0) * pow(1.0 - cosTheta, 5.0);
}

// Couleur du ciel selon la direction du rayon réfléchi
vec3 skyColor(vec3 dir) {
    float y = max(dir.y, 0.0);
    // Zénith bleu profond → horizon bleu clair/orangé
    vec3 zenith  = vec3(0.18, 0.38, 0.72);
    vec3 horizon = vec3(0.55, 0.72, 0.85);
    vec3 col = mix(horizon, zenith, pow(y, 0.5));
    // Lueur solaire près du soleil
    float sunDot = max(dot(dir, uSunDir), 0.0);
    col += vec3(1.0, 0.85, 0.6) * pow(sunDot, 32.0) * 0.6;
    col += vec3(1.0, 0.95, 0.8) * pow(sunDot, 256.0) * 2.0;
    return col;
}

void main() {
    vec3 viewDir = normalize(vViewDir);
    vec3 N = normalize(vNormal);
    // Déterminer si la caméra est au-dessus ou en dessous
    bool camAbove = cameraPosition.y > vWorldPos.y;
    // Inverser la normale si on regarde depuis en dessous
    vec3 nFace = camAbove ? N : -N;
    float NdotV = max(dot(nFace, viewDir), 0.0);
    // Fresnel Schlick (F0 = 0.02 pour l'eau → réflexion ~2% face-on, ~100% rasante)
    float fresnel = fresnelSchlick(NdotV, 0.02);
    // Rayon réfléchi pour la couleur du ciel
    vec3 reflDir = reflect(-viewDir, nFace);
    vec3 reflCol = skyColor(reflDir);
    // Couleur de l'eau en profondeur (absorption)
    vec3 deepCol = vec3(0.01, 0.06, 0.12);
    vec3 shallowCol = vec3(0.04, 0.22, 0.32);
    // Subsurface scattering : lumière traversant les crêtes de vagues
    float sss = pow(max(dot(viewDir, -uSunDir), 0.0), 4.0);
    sss *= smoothstep(-0.1, 0.3, vElevation); // seulement sur les crêtes
    vec3 sssCol = vec3(0.05, 0.45, 0.35) * sss * 0.7;
    // Couleur de l'eau (profondeur variable)
    vec3 waterCol = mix(deepCol, shallowCol, 0.5 + 0.5 * vElevation);
    vec3 color;
    float baseAlpha;

    if (camAbove) {
        // Vue de dessus : eau + réflexion ciel
        color = mix(waterCol, reflCol, fresnel) + sssCol;
        baseAlpha = mix(0.35, 0.92, fresnel);
    } else {
        // Vue de dessous : la surface agit comme un miroir vers le ciel.
        // On veut un contraste net avec le bleu profond du brouillard.
        float underFresnel = fresnelSchlick(NdotV, 0.30);
        // Réflexion ciel très forte + teinte turquoise sous-marine
        vec3 underCol = mix(vec3(0.06, 0.28, 0.42), reflCol * 1.25, underFresnel);
        // Reflets du soleil à travers les vagues : taches lumineuses mobiles
        float sunUnder = pow(max(dot(N, uSunDir), 0.0), 6.0);
        underCol += vec3(0.45, 0.65, 0.75) * sunUnder;
        // ── Boost plage : vagues plus puissantes vues de dessous ──
        // Lumière solaire renforcée traversant les crêtes de plage
        float beachSun = pow(max(dot(N, uSunDir), 0.0), 3.0) * vBeachT * 1.5;
        underCol += vec3(0.6, 0.85, 0.95) * beachSun;
        // Teinte plus claire/turquoise au-dessus de la plage
        underCol = mix(underCol, vec3(0.15, 0.55, 0.65), vBeachT * 0.4);
        // Écume vue d'en dessous : zones blanchâtres aux crêtes
        // Écume beaucoup plus prononcée en zone plage (déferlement)
        float underFoam = vFoam * (0.55 + vBeachT * 0.45);
        underCol = mix(underCol, vec3(0.85, 0.92, 0.96), underFoam);
        color = underCol;
        baseAlpha = mix(0.65, 0.95, underFresnel);
        // Alpha plus élevé en zone plage pour un effet de plafond de vagues
        baseAlpha = mix(baseAlpha, min(baseAlpha + 0.2, 0.98), vBeachT);
    }

    // Specular soleil — glitter path (chemin de lumière sur l'eau)
    vec3 H = normalize(uSunDir + viewDir);
    float spec = pow(max(dot(nFace, H), 0.0), 512.0) * 1.5;
    // Glitter secondaire plus diffus
    float spec2 = pow(max(dot(nFace, H), 0.0), 64.0) * 0.3;
    color += vec3(1.0, 0.95, 0.85) * (spec + spec2);
    // Écume blanche sur les crêtes des vagues (vue de dessus)
    if (camAbove) {
        vec3 foamCol = vec3(0.85, 0.92, 0.95);
        float foamAlpha = vFoam * 0.7;
        color = mix(color, foamCol, foamAlpha);
        baseAlpha = max(baseAlpha, foamAlpha);
    }
    gl_FragColor = vec4(color, baseAlpha);
    #include <fog_fragment>
}`;

function buildSurface() {
    if (surfaceMesh) {
        scene.remove(surfaceMesh);
        surfaceMesh.geometry.dispose();
        surfaceMesh.material.dispose();
        surfaceMesh = null;
    }
    if (!envState.waves) return;
    // Surface suffisamment grande pour couvrir le champ de vision sous l'eau
    // même en FPV avec un FOV large et en regardant vers le haut depuis 10-30 m.
    const size = Math.max(WALL_POS * 2.8, -FLOOR_Y * 3.5, 120);
    const segs = THREE.MathUtils.clamp(Math.round(size / 0.75), 128, 320);
    const geo = new THREE.PlaneGeometry(size, size, segs, segs);
    geo.rotateX(-Math.PI / 2);
    const sunDirection = new THREE.Vector3(6, 12, 8).normalize();
    // Calcul des limites de la zone plage pour le boost de vagues
    const beachFrac = diveState.beachExtent / 100;
    const beachInnerDist = WALL_POS * (1.0 - beachFrac);
    // Boost proportionnel à la profondeur de la plage (% de profondeur totale)
    const beachDepthFrac = diveState.beachDepthPct / 100;
    // Point 9 (revue) : 1× à 4× selon profondeur plage — conforme à la spec du shader
    // (l'ancienne formule ×10 donnait jusqu'à ×13, contredisant la plage annoncée 2-4×).
    const beachBoost = 1.0 + 3.0 * beachDepthFrac;
    const mat = new THREE.ShaderMaterial({
        uniforms: {
            uTime: { value: 0 },
            uWaveHeight: { value: envState.waveHeight },
            uBeachInnerDist: { value: beachInnerDist },
            uBeachOuterDist: { value: WALL_POS },
            uBeachBoost: { value: beachBoost },
            uSunDir: { value: sunDirection },
            ...THREE.UniformsLib.fog,
        },
        vertexShader: _SURFACE_VS,
        fragmentShader: _SURFACE_FS,
        transparent: true,
        depthWrite: false,    // CRITIQUE : ne masque pas la scène en FPV sous l'eau
        side: THREE.DoubleSide,
        fog: true,
    });
    surfaceMesh = new THREE.Mesh(geo, mat);
    surfaceMesh.position.y = CEIL_Y;
    surfaceMesh.renderOrder = 100; // Rendu après les objets opaques
    scene.add(surfaceMesh);
}

// ===========================================================================
// CAUSTIQUES SOUS-MARINES (Voronoi léger — shader GPU)
// ===========================================================================

// Shader vertex caustiques : plan plat au niveau du sol
const _CAUSTICS_VS = /* glsl */`
varying vec2 vUv;
void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

// Shader fragment : pattern Voronoi animé (2 itérations seulement pour perf)
const _CAUSTICS_FS = /* glsl */`
uniform float uTime;
uniform float uIntensity;
varying vec2 vUv;

// Hash rapide
vec2 hash22(vec2 p) {
    p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
    return fract(sin(p) * 43758.5453);
}

// Voronoi F1 : distance au point le plus proche
float voronoi(vec2 uv) {
    vec2 i = floor(uv), f = fract(uv);
    float d = 1.0;
    for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
            vec2 n = vec2(float(x), float(y));
            vec2 p = hash22(i + n);
            // Animation douce des points
            p = 0.5 + 0.5 * sin(uTime * 0.4 + 6.2831 * p);
            float dist = length(n + p - f);
            d = min(d, dist);
        }
    }
    return d;
}

void main() {
    // UV étendu pour couvrir le bassin
    vec2 uv = vUv * 12.0;
    // Deux échelles de Voronoi pour richesse visuelle
    float v1 = voronoi(uv);
    float v2 = voronoi(uv * 1.7 + 3.7);
    // Lignes de caustiques = zones où les 2 voronois sont proches
    float caustic = smoothstep(0.0, 0.08, abs(v1 - v2));
    caustic = 1.0 - caustic;
    // Intensité avec seuil pour éviter le bruit
    float brightness = caustic * uIntensity;
    // Couleur caustique : blanc-bleuté
    vec3 color = vec3(0.6, 0.85, 1.0) * brightness * 2.5;
    float alpha = brightness * 0.6;
    gl_FragColor = vec4(color, alpha);
}`;

function buildCaustics() {
    if (causticsMesh) {
        scene.remove(causticsMesh);
        causticsMesh.geometry.dispose();
        causticsMesh.material.dispose();
        causticsMesh = null;
    }
    if (!envState.caustics) return;
    const size = WALL_POS * 2;
    const geo = new THREE.PlaneGeometry(size, size);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.ShaderMaterial({
        uniforms: {
            uTime: { value: 0 },
            uIntensity: { value: envState.causticsIntensity },
        },
        vertexShader: _CAUSTICS_VS,
        fragmentShader: _CAUSTICS_FS,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
    });
    causticsMesh = new THREE.Mesh(geo, mat);
    causticsMesh.position.y = FLOOR_Y + 0.05;
    causticsMesh.renderOrder = 50;
    scene.add(causticsMesh);
}

// ===========================================================================
// RAYONS LUMINEUX (god rays — plans volumétriques)
// ===========================================================================

function buildGodRays() {
    if (godRaysGroup) {
        scene.remove(godRaysGroup);
        godRaysGroup.traverse(o => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
        godRaysGroup = null;
    }
    if (!envState.godrays) return;
    godRaysGroup = new THREE.Group();
    const rayCount = 20;
    const rayHeight = Math.min(40, -FLOOR_Y * 1.1);
    // Texture radiale + verticale : un rayon doux qui s'atténue vers les bords et le bas
    const canvas = document.createElement('canvas');
    canvas.width = 64; canvas.height = 256;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(64, 256);
    for (let y = 0; y < 256; y++) {
        const vy = y / 255;
        const vAlpha = Math.pow(1.0 - vy, 1.4); // fort en haut, fade en bas
        for (let x = 0; x < 64; x++) {
            const vx = (x - 31.5) / 31.5;
            const radial = Math.pow(Math.max(0, 1.0 - vx * vx), 1.2);
            const a = vAlpha * radial;
            const i = (y * 64 + x) * 4;
            img.data[i]     = 200;
            img.data[i + 1] = 225;
            img.data[i + 2] = 255;
            img.data[i + 3] = Math.round(a * 90);
        }
    }
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(canvas);
    tex.needsUpdate = true;
    // Positionner les rayons en éventail autour du soleil (centre de la surface)
    for (let i = 0; i < rayCount; i++) {
        const t = i / (rayCount - 1);
        const angle = (t - 0.5) * Math.PI * 0.9; // éventail devant le ROV / au centre
        const dist = 2 + Math.pow(Math.abs(t - 0.5), 0.7) * (WALL_POS * 0.45);
        const rayWidth = 0.8 + Math.pow(Math.abs(t - 0.5), 0.5) * 1.6;
        const geo = new THREE.PlaneGeometry(rayWidth, rayHeight);
        const mat = new THREE.MeshBasicMaterial({
            map: tex,
            transparent: true,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
            side: THREE.DoubleSide,
            opacity: envState.godraysIntensity * 0.55,
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(
            Math.sin(angle) * dist,
            CEIL_Y - rayHeight / 2,
            -Math.cos(angle) * dist * 0.6
        );
        // Orientation : chaque rayon pointe vers le centre/surface
        mesh.lookAt(0, CEIL_Y + 2, 0);
        mesh.rotation.z = (Math.random() - 0.5) * 0.08;
        mesh.userData.baseX = mesh.position.x;
        mesh.userData.baseZ = mesh.position.z;
        mesh.userData.phase = Math.random() * Math.PI * 2;
        godRaysGroup.add(mesh);
    }
    scene.add(godRaysGroup);
}

// ===========================================================================
// AMBIANCE PROFONDEUR (lumière atténuée)
// ===========================================================================
function updateDepthAmbience() {
    const depthNow = Math.max(0, -posWorld.y);
    // L'extinction solaire suit la transparence de l'eau :
    // water_transparency=80m → lumière encore à 88% à -30m, 69% à -50m
    // water_transparency=15m → lumière quasi éteinte à -30m (eaux troubles)
    const sunFadeDepth = Math.max(5, diveState.visibility);
    const f = Math.exp(-Math.max(0, depthNow - REEF_DEPTH) / sunFadeDepth);
    if (Math.abs(f - _lastSunF) < 0.002 && envMats.length === _lastEnvCount) return;
    _lastSunF = f;
    _lastEnvCount = envMats.length;
    sunDir.intensity = 1.8 * f;
    sunFill.intensity = 0.5 * f;
    sunAmbient.intensity = 0.5 * f;
    _waterCol.lerpColors(_DEEP_COL, _SURF_COL, f);
    scene.background.copy(_waterCol);
    scene.fog.color.copy(_waterCol);
    for (const m of envMats) m.envMapIntensity = f;
    if (gridHelper) gridHelper.material.opacity = Math.max(0.05, f);
    // Caustiques : masquer quand la lumière est éteinte (f < 0.02)
    if (causticsMesh) {
        causticsMesh.visible = envState.caustics && f > 0.02;
        if (causticsMesh.material.uniforms) {
            causticsMesh.material.uniforms.uIntensity.value = envState.causticsIntensity * f;
        }
    }
    // God rays : masquer en profondeur totale
    if (godRaysGroup) {
        godRaysGroup.visible = envState.godrays && f > 0.05;
        godRaysGroup.traverse(o => {
            if (o.isMesh) o.material.opacity = envState.godraysIntensity * 0.6 * f;
        });
    }
}

// ===========================================================================
// PROJECTEURS LED (projecteur.glb)
// ===========================================================================

// Crée le groupe pivot des projecteurs et les 2 SpotLights (gauche / droit).
function initProjectors() {
    projGroup = new THREE.Group();
    modelGroup.add(projGroup);
    const px = -(MODEL_LENGTH / 2);   // avant visuel du ROV = -X
    projSpots = [
        makeProjectorSpot(px, 0.06, +0.09, +0.03),   // pod bâbord
        makeProjectorSpot(px, 0.06, -0.09, -0.03),   // pod tribord
    ];
    applyLed();
}

// SpotLight de projecteur : blanc bleuté (LED sous-marine), cône 26°, portée 60 m.
function makeProjectorSpot(x, y, z, zTargetPinch) {
    const s = new THREE.SpotLight(0xdff2ff, 0, 60, THREE.MathUtils.degToRad(26), 0.45, 1.6);
    s.castShadow = true;
    s.shadow.mapSize.set(1024, 1024);
    s.shadow.bias = -0.002;
    s.shadow.normalBias = 0.02;
    s.shadow.camera.near = 0.01;
    s.shadow.camera.far = 60;
    s.position.set(x - 0.01, y, z);
    s.target.position.set(x - 3.0, y - 0.35, zTargetPinch);
    projGroup.add(s);
    projGroup.add(s.target);
    s.target.updateMatrixWorld(true);
    return s;
}

// Charge projecteur.glb et l'attache au groupe pivot du Tilt.
function loadProjectorModel() {
    const loader = new GLTFLoader();
    loader.load(
        '/static/models/projecteur.glb',
        (gltf) => {
            const proj = gltf.scene;
            proj.scale.setScalar(rovFitScale);
            proj.position.copy(rovFitOffset);
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
            console.warn('projecteur.glb indisponible — faisceaux seuls:', err);
        }
    );
}

// Ajuste les SpotLights aux positions réelles des optiques du GLB.
// Convertit la bounding box monde en coordonnées locales de projGroup
// pour éviter un décalage quand modelGroup n'est pas à l'origine.
function fitSpotsToProjector(proj) {
    const worldBox = new THREE.Box3().setFromObject(proj);
    if (worldBox.isEmpty()) return;
    // Convertir les coins monde en coordonnées locales de projGroup
    const invMatrix = new THREE.Matrix4().copy(projGroup.matrixWorld).invert();
    const localMin = worldBox.min.clone().applyMatrix4(invMatrix);
    const localMax = worldBox.max.clone().applyMatrix4(invMatrix);
    // Réordonner (l'inversion peut inverser les axes)
    const bMin = new THREE.Vector3(
        Math.min(localMin.x, localMax.x),
        Math.min(localMin.y, localMax.y),
        Math.min(localMin.z, localMax.z)
    );
    const bMax = new THREE.Vector3(
        Math.max(localMin.x, localMax.x),
        Math.max(localMin.y, localMax.y),
        Math.max(localMin.z, localMax.z)
    );
    const cy = (bMin.y + bMax.y) / 2;
    const zSpan = bMax.z - bMin.z;
    const front = bMin.x - 0.04; // 4 cm devant la face avant (hors du mesh)
    const podZ = Math.max(0.04, zSpan * 0.28);
    projSpots.forEach((s, i) => {
        const side = i === 0 ? 1 : -1;
        s.position.set(front, cy, side * podZ);
        s.target.position.set(front - 3.0, cy - 0.35, side * podZ * 0.25);
        s.target.updateMatrixWorld(true);
    });
    console.log(`[SubSim] fitSpotsToProjector: front=${front.toFixed(3)}m cy=${cy.toFixed(3)}m podZ=±${podZ.toFixed(3)}m (zSpan=${zSpan.toFixed(3)}m)`);
}

// Applique l'état LED : intensité des SpotLights + tilt du groupe pivot.
function applyLed() {
    const cd = diveState.led ? LED_MAX_INTENSITY * (diveState.ledIntensity / 100) : 0;
    projSpots.forEach((s) => { s.intensity = cd; });
    if (projGroup) {
        projGroup.rotation.z = THREE.MathUtils.degToRad(diveState.ledTilt);
    }
    // Griser les sliders quand éteint
    const iRow = document.getElementById('sim-led-intensity-row');
    const tRow = document.getElementById('sim-led-tilt-row');
    if (iRow) iRow.classList.toggle('disabled', !diveState.led);
    if (tRow) tRow.classList.toggle('disabled', !diveState.led);
    console.log(`[SubSim] LED: ${diveState.led ? 'ON' : 'OFF'} intensity=${cd.toFixed(0)} cd (${diveState.ledIntensity}%), tilt=${diveState.ledTilt}°, spots=${projSpots.length}`);
}

function applyFog() {
    scene.fog.density = 1.7 / Math.max(1, diveState.visibility);
}

// ===========================================================================
// OVERLAY
// ===========================================================================
function hideOverlay() { document.getElementById('sim-overlay').classList.add('hidden'); }
function showError(msg) {
    const ov = document.getElementById('sim-overlay');
    ov.classList.remove('hidden'); ov.classList.add('error');
    document.getElementById('sim-overlay-msg').textContent = '⚠️ ' + msg;
}

// ===========================================================================
// BOUCLE D'ANIMATION PRINCIPALE
// ===========================================================================
function animate() {
    requestAnimationFrame(animate);
    const dt = Math.min(clock.getDelta(), 0.05);

    // FPS
    fpsFrames++;
    const now = performance.now();
    if (now - fpsLast >= 1000) {
        fpsValue = fpsFrames;
        fpsFrames = 0;
        fpsLast = now;
        document.getElementById('sim-fps').textContent = `FPS: ${fpsValue}`;
    }

    // Gamepad
    const gpDof = readGamepad();
    if (gpDof) {
        DOF_ORDER.forEach(k => target[k] = gpDof[k]);
        sendMove(gpDof);
        updateDofPanel();
    }
    const gpEl = document.getElementById('sim-gp-badge');
    if (gpEl) { gpEl.textContent = gpConnected ? '🎮 Manette' : '🎮 —'; gpEl.style.color = gpConnected ? '#35d0ba' : '#8aa0c8'; }

    // Physique
    if (gpConnected) integratePhysics();

    // Mise à jour modèle 3D
    if (modelGroup) {
        modelGroup.rotation.set(current.pitch, current.yaw, -current.roll, 'YXZ');
        modelGroup.position.copy(posWorld);
    }

    // Faune/flore
    try { updateSceneObjects(dt); } catch (e) { console.error('[SubSim] updateSceneObjects erreur:', e.message, e.stack); }
    const time = clock.elapsedTime;
    algaeUniforms.uTime.value = time;
    algaeUniforms.uSway.value = envState.current;
    updateFish(dt, time);
    updateAbyss(dt, time);
    updatePikes(dt);
    refreshLifeZoning();

    // Surface + caustiques + god rays (shaders GPU)
    if (surfaceMesh && surfaceMesh.material.uniforms) {
        surfaceMesh.material.uniforms.uTime.value = time * envState.waveSpeed;
        surfaceMesh.material.uniforms.uWaveHeight.value = envState.waveHeight;
    }
    if (causticsMesh && causticsMesh.visible && causticsMesh.material.uniforms) {
        causticsMesh.material.uniforms.uTime.value = time;
    }
    if (godRaysGroup && godRaysGroup.visible) {
        godRaysGroup.children.forEach(r => {
            const ph = time * 0.25 + r.userData.phase;
            r.position.x = r.userData.baseX + Math.sin(ph) * 0.25;
            r.position.z = r.userData.baseZ + Math.cos(ph * 0.7) * 0.15;
        });
    }

    // Ambiance + OSD
    updateDepthAmbience();
    renderOsd();
    updateTelemetryPanel();

    // Rendu Three.js
    if (!isFpvActive) {
        // Suivi ROV : le target OrbitControls suit la position du drone
        if (followROV && modelGroup) {
            controls.target.lerp(modelGroup.position, 0.08);
        }
        controls.update();
    }
    renderer.render(scene, isFpvActive ? fpvCamera : camera);
    // Mini-radar 2D
    drawRadar();
}

// ===========================================================================
// MINI-RADAR 2D (vue du dessus du bassin)
// ===========================================================================
let _radarCtx = null;
let _radarInfo = null;

function initRadar() {
    const canvas = document.getElementById('sim-radar-canvas');
    if (canvas) _radarCtx = canvas.getContext('2d');
    _radarInfo = document.getElementById('sim-radar-info');
}

/** Dessine la mini-carte radar 2D (appelé chaque frame si panneau visible) */
function drawRadar() {
    if (!_radarCtx) return;
    // Vérifier si le panneau n'est pas replié
    const panel = document.getElementById('sim-radar-panel');
    if (!panel || panel.classList.contains('collapsed')) return;

    const ctx = _radarCtx;
    const W = ctx.canvas.width;
    const H = ctx.canvas.height;
    const half = W / 2;
    // Échelle : WALL_POS (demi-largeur bassin) → half pixels
    const scale = half / WALL_POS;

    // Fond sombre + grille
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#060d1a';
    ctx.fillRect(0, 0, W, H);

    // Grille (tous les 10m)
    ctx.strokeStyle = 'rgba(53,208,186,0.08)';
    ctx.lineWidth = 0.5;
    for (let m = -WALL_POS; m <= WALL_POS; m += 10) {
        const px = half + m * scale;
        const py = half + m * scale;
        ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, H); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, py); ctx.lineTo(W, py); ctx.stroke();
    }

    // Limites du bassin (carré)
    ctx.strokeStyle = 'rgba(53,208,186,0.35)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(0, 0, W, H);

    // Fosse abyssale (cercle central)
    const abyssR = fondZoneRadius();
    ctx.strokeStyle = 'rgba(100,140,200,0.25)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(half, half, abyssR * scale, 0, Math.PI * 2);
    ctx.stroke();

    // Zone plage (cercle pointillé)
    // Point 3 (revue) : rayon réel de la limite intérieur plage = extérieur récif,
    // cohérent avec le slider 🏖️ beachExtent (au lieu du 0.88 × WALL_POS codé en dur).
    ctx.strokeStyle = 'rgba(200,177,138,0.2)';
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    ctx.arc(half, half, reefRingRadii().outerR * scale, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // Objets de scène (faune/flore) — petits points colorés
    // ── R1 : TOUS les objets sont dessinés, y compris ceux masqués par le LOD ──
    // (au-delà de la distance de rendu) : le radar représente ainsi toute la scène,
    // les objets hors visibilité étant affichés en style atténué.
    // ── R2 : couleurs différenciées par type, lisibles sur le fond sombre :
    // faune nageante → teal vif ; mammifère → ambre + point plus grand ;
    // flore/objet → gris discret. (Remplace l'ancien code par zone, dont le
    // vert-olive rgba(58,79,71,0.5) était illisible sur le fond #060d1a.)
    if (scene3dObjects) {
        for (const obj of scene3dObjects) {
            if (!obj.group) continue;
            const objType = obj.config.type || 'faune';
            const lodHidden = !obj.group.visible;  // masqué par LOD (hors distance de rendu)
            let size, color;
            if (objType === 'mamifere') {
                size = lodHidden ? 3 : 5;          // mammifère : point ambre plus grand
                color = lodHidden ? 'rgba(230,160,60,0.35)' : 'rgba(255,170,40,0.95)';
            } else if (objType === 'faune') {
                size = lodHidden ? 2 : 3;          // faune nageante : teal vif
                color = lodHidden ? 'rgba(120,160,180,0.3)' : 'rgba(72,219,200,0.9)';
            } else {
                size = lodHidden ? 1.5 : 2;        // flore/objet : gris discret
                color = lodHidden ? 'rgba(150,160,170,0.18)' : 'rgba(150,165,175,0.45)';
            }
            const px = half + obj.group.position.x * scale;
            const py = half + obj.group.position.z * scale;
            if (px < 0 || px > W || py < 0 || py > H) continue;
            ctx.fillStyle = color;
            ctx.fillRect(px - size / 2, py - size / 2, size, size);
        }
    }

    // ── ROV : point lumineux + flèche de cap ──
    const rx = half + posWorld.x * scale;
    const ry = half + posWorld.z * scale;

    // Halo glow
    const grd = ctx.createRadialGradient(rx, ry, 0, rx, ry, 10);
    grd.addColorStop(0, 'rgba(53,208,186,0.5)');
    grd.addColorStop(1, 'rgba(53,208,186,0)');
    ctx.fillStyle = grd;
    ctx.beginPath(); ctx.arc(rx, ry, 10, 0, Math.PI * 2); ctx.fill();

    // Point ROV
    ctx.fillStyle = '#35d0ba';
    ctx.beginPath(); ctx.arc(rx, ry, 3.5, 0, Math.PI * 2); ctx.fill();

    // Flèche de cap — convention réelle : l'avant visuel du ROV est -X
    // (cf. initProjectors : px = -MODEL_LENGTH/2). Le vecteur local -X tourné de yaw
    // donne en monde (-cos yaw, 0, sin yaw) → flèche radar (-cos yaw, sin yaw).
    // Le décalage -π/2 combiné à (sin, cos) ci-dessous produit exactement ce vecteur
    // (commentaire historique « face à -Z, +π » inexact, code inchangé).
    const rawYaw = modelGroup ? modelGroup.rotation.y : 0;
    const yaw = rawYaw - Math.PI / 2;
    const arrowLen = 12;
    const ax = rx + Math.sin(yaw) * arrowLen;
    const ay = ry + Math.cos(yaw) * arrowLen;
    ctx.strokeStyle = '#35d0ba';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(rx, ry); ctx.lineTo(ax, ay); ctx.stroke();

    // Pointe de flèche (barbes vers l'arrière depuis la pointe)
    const tipAngle = 0.45;
    const tipLen = 5;
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(
        ax - Math.sin(yaw + tipAngle) * tipLen,
        ay - Math.cos(yaw + tipAngle) * tipLen
    );
    ctx.moveTo(ax, ay);
    ctx.lineTo(
        ax - Math.sin(yaw - tipAngle) * tipLen,
        ay - Math.cos(yaw - tipAngle) * tipLen
    );
    ctx.stroke();

    // Cercle LOD (rayon de visibilité autour du ROV)
    const lodR = diveState.visibility;
    ctx.strokeStyle = 'rgba(53,208,186,0.15)';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.arc(rx, ry, lodR * scale, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // Info texte (cap réel = direction avant du ROV)
    if (_radarInfo) {
        const hdg = ((yaw * 180 / Math.PI) % 360 + 360) % 360;
        _radarInfo.textContent = `X: ${posWorld.x.toFixed(0)}m  Z: ${posWorld.z.toFixed(0)}m  Cap: ${hdg.toFixed(0).padStart(3, '0')}°`;
    }
}

// ===========================================================================
// DÉMARRAGE
// ===========================================================================
try {
    loadSettings();          // Restaurer réglages AVANT init (depth/visibility/etc.)
    initScene();
    initOsdCanvas();
    buildMotorPanel();
    buildDofPanel();
    initFloatingPanels();
    bindSliders();
    syncSlidersUI();         // Afficher les valeurs restaurées dans les sliders
    applyBasinSize();        // Appliquer l'étendue restaurée
    applyFog();              // Brouillard selon visibilité
    initActionButtons();     // Boutons + raccourcis clavier
    initRadar();             // Mini-carte radar 2D
    loadModel();
    // Charger l'environnement AVANT de construire terrain+vie+GLB
    // (buildWalls/buildTerrain sont appelés dans loadEnvironmentConfig)
    loadEnvironmentConfig().then(() => {
        loadScene3DConfig().then(() => {
            buildAllLife();      // Algues, coraux, poissons, abysses, brochets
        });
    });
    connectWS();
    loadGamepadProfile();
    setInterval(loadGamepadProfile, 5000);
    window.addEventListener('gamepadconnected', loadGamepadProfile);
    window.addEventListener('storage', e => { if (e.key === GP_LS_MAPPING_KEY) loadGamepadProfile(); });
    window.addEventListener('gamepad-mapping-changed', loadGamepadProfile);
    // Sauvegarder la position ROV en quittant la page
    window.addEventListener('beforeunload', saveSettings);
    window.addEventListener('visibilitychange', () => { if (document.hidden) saveSettings(); });
    // Sauvegarde périodique de la position (toutes les 5s)
    setInterval(saveSettings, 5000);
    animate();
    // Vue FPV par défaut
    setFpv(true);
} catch (e) {
    console.error(e);
    showError('Initialisation 3D impossible');
}
