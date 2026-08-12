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
const clock = new THREE.Clock();

const physState = { inertia: 0.90, gain: 1.0, sens: 0.45, rollSens: 1.0, pitchSens: 1.0 };
const diveState = { depth: 30, visibility: 25, extent: 100, walls: true, terrain: false };
let FLOOR_Y = -30.0;
let WALL_LIMIT = 9.5;
let WALL_POS = 10.0;

// --- Topographie "Blue Hole" : plateau corallien + fosse abyssale ---
const REEF_DEPTH   = 20;     // m : profondeur du socle du plateau corallien
const PIT_RADIUS_K = 0.45;   // rayon extérieur du tombant (fraction de WALL_POS)
const HEIGHT_MAX   = 10.0;   // amplitude max du relief (mètres)
const TERRAIN_SLOPE_MAX = 1.7; // ~60° : pente = butée latérale
const SUN_FADE_DEPTH = 11;   // m : profondeur d'extinction lumière après REEF_DEPTH

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
let wallTex = null, wallMat = null, terrainTex = null;
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

// Hauteur du relief : Blue Hole (plateau corallien + fosse abyssale)
function terrainHeightAt(x, z) {
    // === Blue Hole : plateau corallien + fosse abyssale centrale ===
    const plateauBase = Math.max(FLOOR_Y, -REEF_DEPTH);
    const coral = Math.pow(fbm2(x * 0.35 + 7.3, z * 0.35 + 3.1), 1.6) * (diveState.terrain ? 0.9 : 0)
                + fbm2(x * 1.1 + 19.7, z * 1.1 + 5.9) * 0.8;
    const plateauY = Math.min(plateauBase + (diveState.terrain ? coral : 0), -1.0);
    if (FLOOR_Y >= -REEF_DEPTH - 1) return plateauY;
    const R = WALL_POS * PIT_RADIUS_K;
    const rim = (fbm2(x * 0.05 + 31.4, z * 0.05 + 12.8) - 0.5) * R * 0.35;
    const r = Math.hypot(x, z) + rim;
    if (r >= R) return plateauY;
    const t = THREE.MathUtils.smoothstep(r, R * 0.45, R);
    const s = t * t * (3 - 2 * t);
    const abyssY = FLOOR_Y + fbm2(x * 0.06 + 3.7, z * 0.06 + 8.2) * 3.0;
    return abyssY + (plateauY - abyssY) * s;
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
    const size = 256;
    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(size, size);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const n = fbm2(x * 0.045, y * 0.045) * 0.7 + fbm2(x * 0.18 + 41, y * 0.18 + 17) * 0.3;
            const v = 46 + n * 78;
            const i = (y * size + x) * 4;
            img.data[i] = v * 0.96; img.data[i + 1] = v * 0.90;
            img.data[i + 2] = v * 0.78; img.data[i + 3] = 255;
        }
    }
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(cv);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    return tex;
}

function wallHeight() { return CEIL_Y - FLOOR_Y; }

// Parois rocheuses texturées (faces intérieures uniquement)
function buildWalls() {
    if (wallsGroup) { scene.remove(wallsGroup); wallsGroup.traverse(o => { if (o.isMesh) o.geometry.dispose(); }); wallsGroup = null; }
    if (!diveState.walls) return;
    if (!wallTex) wallTex = makeRockTexture();
    if (!wallMat) {
        wallMat = new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.95, metalness: 0.0 });
        envMats.push(wallMat);
    }
    const h = wallHeight();
    wallsGroup = new THREE.Group();
    [
        { x: 0, z: -WALL_POS, ry: 0 },
        { x: 0, z: +WALL_POS, ry: Math.PI },
        { x: -WALL_POS, z: 0, ry: Math.PI / 2 },
        { x: +WALL_POS, z: 0, ry: -Math.PI / 2 },
    ].forEach(d => {
        const m = new THREE.Mesh(new THREE.PlaneGeometry(WALL_POS * 2, h), wallMat);
        m.position.set(d.x, FLOOR_Y + h / 2, d.z);
        m.rotation.y = d.ry;
        m.receiveShadow = true;
        wallsGroup.add(m);
    });
    if (wallTex) {
        const rep = Math.max(2, Math.round((WALL_POS * 2) / 3.3));
        wallTex.repeat.set(rep, Math.max(2, Math.round(h / 3.3)));
    }
    scene.add(wallsGroup);
}

// Relief rocheux Blue Hole
function terrainSegs() {
    return THREE.MathUtils.clamp(Math.round((WALL_POS * 2) / 1.75), 96, 256);
}
function terrainTexRepeats() { return Math.max(2, Math.round((WALL_POS * 2) / 3.3)); }

function buildTerrain() {
    if (terrainMesh) { scene.remove(terrainMesh); terrainMesh.geometry.dispose(); terrainMesh.material.dispose(); terrainMesh = null; }
    if (!diveState.terrain) return;
    const segs = terrainSegs();
    const geo = new THREE.PlaneGeometry(WALL_POS * 2, WALL_POS * 2, segs, segs);
    geo.rotateX(-Math.PI / 2);
    // Texture rocheuse
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

function updateTerrainGeometry() {
    if (!terrainMesh) return;
    const pos = terrainMesh.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
        pos.setY(i, terrainHeightAt(pos.getX(i), pos.getZ(i)));
    }
    pos.needsUpdate = true;
    terrainMesh.geometry.computeVertexNormals();
    updateAlgaeAnchors();
}

function rebuildTerrainGeometry() {
    if (!terrainMesh) return;
    terrainMesh.geometry.dispose();
    const segs = terrainSegs();
    const geo = new THREE.PlaneGeometry(WALL_POS * 2, WALL_POS * 2, segs, segs);
    geo.rotateX(-Math.PI / 2);
    terrainMesh.geometry = geo;
    if (terrainTex) terrainTex.repeat.set(terrainTexRepeats(), terrainTexRepeats());
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
        if (terrainHeightAt(p.x, p.z) > -REEF_DEPTH - 1.5) return p;
    }
    return randomFloorPoint(rng, margin);
}

function reefPlateauArea() {
    const R = Math.max(1, WALL_LIMIT);
    const rPit = (FLOOR_Y < -REEF_DEPTH - 1) ? Math.min(R, WALL_POS * PIT_RADIUS_K) : 0;
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
                const baseScale = (obj.real_size_m || 0.2) / maxDim;
                console.log(`[SubSim] ${obj.model}: meshBbox=(${size.x.toFixed(3)}, ${size.y.toFixed(3)}, ${size.z.toFixed(3)}) maxDim=${maxDim.toFixed(4)} baseScale=${baseScale.toFixed(3)} → ${(baseScale * maxDim).toFixed(3)}m`);
                const count = obj.count || 1;
                const validBehaviors = ['fuir', 'curieux', 'neant'];
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
                    modelClone.position.sub(cloneCenter);
                    instanceGroup.add(modelClone);
                    positionInZone(instanceGroup, obj);

                    // Animations GLB — le mixer DOIT être créé sur le clone (pas l'original)
                    const hasAnims = gltf.animations && gltf.animations.length > 0;
                    if (hasAnims) {
                        const mixer = new THREE.AnimationMixer(modelClone);
                        gltf.animations.forEach(clip => {
                            const action = mixer.clipAction(clip);
                            action.play();
                        });
                        scene3dMixers.push(mixer);
                        console.log(`[SubSim] ${obj.name} #${i}: ${gltf.animations.length} animation(s) lancée(s), mixer=${scene3dMixers.length}`);
                    } else {
                        console.log(`[SubSim] ${obj.name} #${i}: aucune animation dans le GLB`);
                    }
                    scene3dObjects.push({
                        config: obj, group: instanceGroup,
                        velocity: new THREE.Vector3(),
                        targetYaw: Math.random() * Math.PI * 2,
                        changeTimer: Math.random() * 5,
                    });
                    scene.add(instanceGroup);
                }
            } catch (e) { console.warn(`[SubSim] ❌ Objet non chargé: ${obj.model}`, e); }
        }
        console.log(`[SubSim] ✅ Scène 3D chargée: ${scene3dObjects.length} instances, ${scene3dMixers.length} mixers animés`);
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
        }
        if (env.walls) {
            diveState.walls = env.walls.enabled !== false;
        }
        // Zone compacte
        if (env.compact_zone !== undefined) {
            envState.compactZone = Math.max(0, Math.min(100, env.compact_zone));
        }
        // Construire/reconstruire terrain et parois selon la config JSON
        buildWalls();
        buildTerrain();
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
    const palette = [0xff7818, 0x2e6bff, 0xffd41e, 0xff9a3d, 0x27d0e8, 0xff5540];
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
        cTint.setHex(palette[i % palette.length]).offsetHSL((rng() - 0.5) * 0.05, 0, (rng() - 0.5) * 0.1);
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
    const patrolR = Math.max(3, WALL_POS * PIT_RADIUS_K * 0.7);
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
    const patrolR = Math.max(3, WALL_POS * PIT_RADIUS_K * 0.7);
    for (const p of pikeData) {
        const g = p.group;
        p.angle += dt * (p.speed / patrolR);
        _pikeTarget.set(Math.cos(p.angle) * patrolR, p.y + Math.sin(p.angle * 3.1) * 1.5, Math.sin(p.angle) * patrolR);
        if (posWorld.y < -REEF_DEPTH && g.position.distanceTo(posWorld) < 12) {
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

function positionInZone(group, obj) {
    const zone = obj.zone || 'pleine_eau';
    const halfW = compactHalfW() * 0.8;
    // --- Position X/Z avec garde anti-chevauchement ROV ---
    let x, z;
    for (let attempt = 0; attempt < 30; attempt++) {
        x = (Math.random() * 2 - 1) * halfW;
        z = (Math.random() * 2 - 1) * halfW;
        if (Math.hypot(x, z) >= SPAWN_GUARD_RADIUS) break;
    }
    // --- Altitude Y selon la zone ---
    let y;
    switch (zone) {
        case 'surface':
            // Juste sous la surface : -1 à -4 m
            y = CEIL_Y - 1 - Math.random() * 3;
            break;
        case 'fond':
            // Proche du sol : terrain + 0.3 à terrain + 3 m
            // Utilise la hauteur réelle du terrain (fosse abyssale incluse)
            {
                const floorY = terrainMeshHeightAt(x, z);
                y = floorY + 0.3 + Math.random() * 2.7;
            }
            break;
        case 'pleine_eau':
            // Colonne d'eau complète : de la surface (-1m) au fond (+ 10%)
            y = (FLOOR_Y * 0.9) + Math.random() * Math.abs(FLOOR_Y * 0.85);
            break;
        default:
            // multi-couches / inconnu : répartition uniforme
            y = FLOOR_Y * 0.15 + Math.random() * Math.abs(FLOOR_Y) * 0.7;
    }
    group.position.set(x, y, z);
    group.rotation.y = Math.random() * Math.PI * 2;
    console.log(`[SubSim] ${obj.name} → zone=${zone} kinematic=${obj.kinematic} behavior=${obj.behavior} pos=(${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)})`);
}

// ===========================================================================
// MISE À JOUR FAUNE/FLORE (comportements dynamiques)
// ===========================================================================
function updateSceneObjects(dt) {
    // 1. Mise à jour des animations GLB (mixers)
    scene3dMixers.forEach(m => m.update(dt));

    const rovPos = modelGroup.position;

    scene3dObjects.forEach(obj => {
        const cfg = obj.config;
        let kinematic = cfg.kinematic || 'fixe';
        const speed = (cfg.speed || 1) * 0.5;          // m/s de base
        const behavior = cfg.behavior || 'neant';
        const turnSpeed = cfg.turn_speed || 0.5;        // 0..1 : rapidité de virage
        const wanderR = cfg.wander_radius || 5;         // rayon d'errance autour du spawn

        if (kinematic === 'fixe') return;

        // --- Comportement IA à l'approche du ROV (seuil 8 m) ---
        const dist = obj.group.position.distanceTo(rovPos);
        let currentSpeed = speed;
        let iaOverride = false;  // true = l'IA force la direction

        if (dist < 8) {
            if (behavior === 'fuir') {
                // Fuite : ×3 vitesse + réorientation immédiate à l'opposé
                currentSpeed = speed * 3;
                const away = obj.group.position.clone().sub(rovPos).normalize();
                obj.targetYaw = Math.atan2(away.x, away.z);
                iaOverride = true;
            } else if (behavior === 'curieux') {
                // Curieux : s'oriente vers le ROV, vitesse normale
                const toward = rovPos.clone().sub(obj.group.position).normalize();
                obj.targetYaw = Math.atan2(toward.x, toward.z);
                iaOverride = true;
            }
            // 'neant' : comportement normal inchangé
        }

        // --- Mode cinématique : nageant ---
        if (kinematic === 'nageant') {
            // Changement de direction aléatoire (errance libre)
            obj.changeTimer -= dt;
            if (obj.changeTimer <= 0 && !iaOverride) {
                obj.targetYaw = Math.random() * Math.PI * 2;
                obj.changeTimer = 3 + Math.random() * 5;
            }

            // Orientation fluide (slerp) — turnSpeed pondère le facteur
            const slerpFactor = Math.min(0.15, turnSpeed * 0.1 * dt * 60);
            const targetQ = new THREE.Quaternion().setFromAxisAngle(
                new THREE.Vector3(0, 1, 0), obj.targetYaw
            );
            obj.group.quaternion.slerp(targetQ, slerpFactor);

            // Déplacement vers l'avant (axe Z local)
            const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(obj.group.quaternion);
            obj.group.position.addScaledVector(forward, currentSpeed * dt);

            // Léger balancement naturel (tangage/roulis visuel)
            const t = clock.elapsedTime;
            obj.group.rotation.x = Math.sin(t * 0.7 + obj.group.position.x * 2) * 0.04;
            obj.group.rotation.z = Math.sin(t * 0.5 + obj.group.position.z * 2) * 0.03;

            // Limites du bassin + maintien dans la zone de profondeur
            clampToBasin(obj.group.position, obj.config.zone);

        // --- Mode cinématique : ancre_ondule (algues, coraux mous) ---
        } else if (kinematic === 'ancre_ondule') {
            const t = clock.elapsedTime;
            const amp = (cfg.speed || 1) * 0.003;
            obj.group.position.y += Math.sin(t * 1.5 + obj.group.position.x) * amp;
            obj.group.rotation.z = Math.sin(t * 0.8 + obj.group.position.z) * 0.12;
        }
    });
}

function clampToBasin(pos, zone) {
    const lim = compactHalfW() * 0.9;
    pos.x = THREE.MathUtils.clamp(pos.x, -lim, lim);
    pos.z = THREE.MathUtils.clamp(pos.z, -lim, lim);

    // Contraintes Y par zone pour maintenir l'objet dans sa couche
    switch (zone) {
        case 'surface':
            pos.y = THREE.MathUtils.clamp(pos.y, CEIL_Y - 4, CEIL_Y - 0.3);
            break;
        case 'fond':
            pos.y = THREE.MathUtils.clamp(pos.y, FLOOR_Y + 0.2, FLOOR_Y + 5);
            break;
        case 'pleine_eau':
            pos.y = THREE.MathUtils.clamp(pos.y, FLOOR_Y * 0.9, CEIL_Y - 1);
            break;
        default:
            pos.y = THREE.MathUtils.clamp(pos.y, FLOOR_Y + 0.3, CEIL_Y - 0.1);
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
    _bodyVel.set(vel.sway, vel.heave, vel.surge).multiplyScalar(gain).applyQuaternion(orientationQuat());
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
        this.classList.toggle('active');
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
        console.log(`[SubSim] Réglages restaurés: depth=${diveState.depth}m extent=${diveState.extent}m vis=${diveState.visibility}m horizon=${osdConfig.horizonVisible ? 'ON' : 'OFF'} ${osdConfig.horizonOpacity}%`);
    } catch (e) { /* première visite, valeurs par défaut */ }
}

function saveSettings() {
    try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify({
            physState: { inertia: physState.inertia, gain: physState.gain, sens: physState.sens, rollSens: physState.rollSens, pitchSens: physState.pitchSens },
            diveState: { depth: diveState.depth, visibility: diveState.visibility, extent: diveState.extent },
            osdConfig: { horizonVisible: osdConfig.horizonVisible, horizonOpacity: osdConfig.horizonOpacity,
                         horizonDiameter: osdConfig.horizonDiameter }
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
    sync('sim-depth',     diveState.depth,     v => v + ' m');
    sync('sim-extent',    diveState.extent,    v => v + ' m');
    sync('sim-visibility', diveState.visibility, v => v + ' m');
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
    bind('sim-depth', 'depth', diveState, v => v + ' m', () => {
        FLOOR_Y = -diveState.depth;
        gridHelper.position.y = FLOOR_Y;
        shadowGround.position.y = FLOOR_Y;
        if (diveState.walls) buildWalls();
        if (diveState.terrain) buildTerrain();
        applyBasinSize();
    });
    bind('sim-extent', 'extent', diveState, v => v + ' m', applyBasinSize);
    bind('sim-visibility', 'visibility', diveState, v => v + ' m', () => {
        scene.fog = new THREE.FogExp2(0x0b1020, 1.7 / diveState.visibility);
    });

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
    _lastSunF = -1;
}

// ===========================================================================
// PANNEAUX FLOTTANTS (drag + collapse)
// ===========================================================================
const PANEL_IDS = ['sim-actions-panel', 'sim-phys-panel', 'sim-dive-panel', 'sim-osd-panel', 'sim-motors-panel', 'sim-dof-panel', 'sim-telemetry-panel'];
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
// AMBIANCE PROFONDEUR (lumière atténuée)
// ===========================================================================
function updateDepthAmbience() {
    const depthNow = Math.max(0, -posWorld.y);
    const f = Math.exp(-Math.max(0, depthNow - REEF_DEPTH) / SUN_FADE_DEPTH);
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
    updateSceneObjects(dt);
    const time = clock.elapsedTime;
    algaeUniforms.uTime.value = time;
    algaeUniforms.uSway.value = envState.current;
    updateFish(dt, time);
    updateAbyss(dt, time);
    updatePikes(dt);
    refreshLifeZoning();

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
    animate();
} catch (e) {
    console.error(e);
    showError('Initialisation 3D impossible');
}
