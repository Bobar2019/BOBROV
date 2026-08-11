/**
 * scene3d_viewer.js — Inspecteur 3D autonome pour visualiser des modèles GLB/GLTF
 * 
 * Utilise Three.js via importmap (three@0.170.0).
 * Expose window.Scene3DViewer = { open, close } pour être appelé
 * depuis le IIFE scene_config.js ou tout autre script non-module.
 * 
 * Ce module est 100% autonome : aucune dépendance autre que Three.js.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// ── État interne du viewer ──────────────────────────────────────────────────
let _renderer = null;
let _scene = null;
let _camera = null;
let _controls = null;
let _mixer = null;
let _animFrameId = null;
let _clock = null;
let _resizeObserver = null;
let _currentContainer = null;

// ── Constantes ──────────────────────────────────────────────────────────────
const BG_COLOR = 0x12121e;            // Fond sombre bleuté
const AMBIENT_INTENSITY = 0.6;
const DIR_LIGHT_INTENSITY = 0.8;
const FILL_LIGHT_INTENSITY = 0.3;     // Lumière de remplissage (éclairage 360°)
const CAMERA_FOV = 45;
const CAMERA_NEAR = 0.01;
const CAMERA_FAR = 1000;
const DISTANCE_FACTOR = 2.5;          // Multiplicateur pour la distance caméra
const MIN_SIZE = 400;                 // Taille minimale du canvas (px)
const THUMB_SIZE = 128;              // Résolution des miniatures (px)
const THUMB_BG = 0x0e1525;           // Fond miniature (cohérent CSS)

// ── Fonctions publiques ─────────────────────────────────────────────────────

/**
 * Ouvre l'inspecteur 3D avec le modèle spécifié.
 * 
 * @param {string} modelUrl    - URL du fichier GLB/GLTF (ex: /static/models/scene/poisson.glb)
 * @param {HTMLElement} containerEl - Élément DOM conteneur pour le canvas
 */
function open(modelUrl, containerEl) {
    // Nettoyer un viewer précédent s'il existe
    close();

    if (!containerEl) {
        console.error('[Scene3DViewer] Aucun conteneur fourni.');
        return;
    }
    _currentContainer = containerEl;

    // ── 1. Renderer WebGL ───────────────────────────────────────────────
    const width = Math.max(containerEl.clientWidth, MIN_SIZE);
    const height = Math.max(containerEl.clientHeight, MIN_SIZE);

    _renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    _renderer.setPixelRatio(window.devicePixelRatio);
    _renderer.setSize(width, height);
    _renderer.outputColorSpace = THREE.SRGBColorSpace;
    _renderer.toneMapping = THREE.ACESFilmicToneMapping;
    _renderer.toneMappingExposure = 1.0;
    containerEl.appendChild(_renderer.domElement);

    // ── 2. Scène ────────────────────────────────────────────────────────
    _scene = new THREE.Scene();
    _scene.background = new THREE.Color(BG_COLOR);

    // Lumière ambiante douce
    const ambientLight = new THREE.AmbientLight(0xffffff, AMBIENT_INTENSITY);
    _scene.add(ambientLight);

    // Lumière directionnelle principale (haut-droite-devant)
    const mainLight = new THREE.DirectionalLight(0xffffff, DIR_LIGHT_INTENSITY);
    mainLight.position.set(5, 10, 7);
    mainLight.castShadow = false;
    _scene.add(mainLight);

    // Lumière de remplissage (bas-gauche-derrière) pour un éclairage 360°
    const fillLight = new THREE.DirectionalLight(0xffffff, FILL_LIGHT_INTENSITY);
    fillLight.position.set(-5, -3, -5);
    _scene.add(fillLight);

    // ── 3. Caméra ───────────────────────────────────────────────────────
    const aspect = width / height;
    _camera = new THREE.PerspectiveCamera(CAMERA_FOV, aspect, CAMERA_NEAR, CAMERA_FAR);

    // ── 4. OrbitControls ────────────────────────────────────────────────
    _controls = new OrbitControls(_camera, _renderer.domElement);
    _controls.enableDamping = true;
    _controls.dampingFactor = 0.1;
    // Rotation libre 360° : pas de restriction d'angle polaire
    _controls.minPolarAngle = 0;
    _controls.maxPolarAngle = Math.PI;
    _controls.enablePan = true;
    _controls.enableZoom = true;

    // ── 5. Chargement du modèle ─────────────────────────────────────────
    const loader = new GLTFLoader();
    loader.load(
        modelUrl,
        (gltf) => {
            _onModelLoaded(gltf);
        },
        (progress) => {
            // Progression du chargement (optionnel, pour debug)
            if (progress.total > 0) {
                const pct = ((progress.loaded / progress.total) * 100).toFixed(1);
                console.log(`[Scene3DViewer] Chargement : ${pct}%`);
            }
        },
        (error) => {
            console.error('[Scene3DViewer] Erreur de chargement du modèle :', error);
        }
    );

    // ── 6. Observateur de redimensionnement ─────────────────────────────
    _resizeObserver = new ResizeObserver(() => {
        _onResize();
    });
    _resizeObserver.observe(containerEl);

    // ── 7. Horloge et boucle de rendu ───────────────────────────────────
    _clock = new THREE.Clock();
    _startRenderLoop();
}

/**
 * Ferme l'inspecteur et nettoie toutes les ressources GPU.
 */
function close() {
    // 1. Arrêter la boucle d'animation
    if (_animFrameId) {
        cancelAnimationFrame(_animFrameId);
    }
    _animFrameId = null;

    // 2. Déconnecter l'observateur de redimensionnement
    if (_resizeObserver) {
        _resizeObserver.disconnect();
        _resizeObserver = null;
    }

    // 3. Stopper le mixer d'animations
    if (_mixer) {
        _mixer.stopAllAction();
        _mixer = null;
    }

    // 4. Disposer les OrbitControls
    if (_controls) {
        _controls.dispose();
        _controls = null;
    }

    // 5. Traverser la scène et libérer géométries, matériaux et textures
    if (_scene) {
        _scene.traverse((obj) => {
            if (obj.geometry) {
                obj.geometry.dispose();
            }
            if (obj.material) {
                if (Array.isArray(obj.material)) {
                    obj.material.forEach((m) => _disposeMaterial(m));
                } else {
                    _disposeMaterial(obj.material);
                }
            }
        });
        _scene = null;
    }

    // 6. Disposer le renderer et retirer le canvas du DOM
    if (_renderer) {
        _renderer.dispose();
        _renderer.forceContextLoss();
        if (_renderer.domElement && _renderer.domElement.parentNode) {
            _renderer.domElement.parentNode.removeChild(_renderer.domElement);
        }
        _renderer = null;
    }

    // 7. Nettoyer les références
    _camera = null;
    _clock = null;
    _currentContainer = null;
}

// ── Fonctions internes ──────────────────────────────────────────────────────

/**
 * Callback appelé une fois le modèle GLB/GLTF chargé.
 * Centre le modèle, positionne la caméra et lance les animations.
 */
function _onModelLoaded(gltf) {
    const model = gltf.scene;
    _scene.add(model);

    // ── Calcul de la BoundingBox ────────────────────────────────────────
    const box = new THREE.Box3().setFromObject(model);
    const center = new THREE.Vector3();
    const size = new THREE.Vector3();
    box.getCenter(center);
    box.getSize(size);

    // Taille maximale sur tous les axes
    const maxSize = Math.max(size.x, size.y, size.z);

    // ── Centrer le modèle à l'origine ───────────────────────────────────
    model.position.sub(center);

    // ── Positionner la caméra ───────────────────────────────────────────
    const distance = maxSize * DISTANCE_FACTOR;
    _camera.position.set(distance, distance * 0.5, distance);
    _camera.lookAt(0, 0, 0);
    _camera.near = maxSize * 0.001;
    _camera.far = maxSize * 100;
    _camera.updateProjectionMatrix();

    // ── Cibler les OrbitControls sur l'origine ──────────────────────────
    _controls.target.set(0, 0, 0);
    _controls.update();

    // ── Animations ──────────────────────────────────────────────────────
    if (gltf.animations && gltf.animations.length > 0) {
        _mixer = new THREE.AnimationMixer(model);
        gltf.animations.forEach((clip) => {
            const action = _mixer.clipAction(clip);
            action.setLoop(THREE.LoopRepeat);
            action.play();
        });
        console.log(`[Scene3DViewer] ${gltf.animations.length} animation(s) lancée(s).`);
    }

    console.log('[Scene3DViewer] Modèle chargé avec succès.',
        `Taille: ${maxSize.toFixed(2)}, Centre: (${center.x.toFixed(2)}, ${center.y.toFixed(2)}, ${center.z.toFixed(2)})`);
}

/**
 * Démarre la boucle de rendu requestAnimationFrame.
 */
function _startRenderLoop() {
    function loop() {
        _animFrameId = requestAnimationFrame(loop);

        // Mettre à jour le mixer d'animations (delta temps réel)
        if (_mixer && _clock) {
            _mixer.update(_clock.getDelta());
        }

        // Mettre à jour les OrbitControls (amortissement)
        if (_controls) {
            _controls.update();
        }

        // Rendu
        if (_renderer && _scene && _camera) {
            _renderer.render(_scene, _camera);
        }
    }
    loop();
}

/**
 * Gère le redimensionnement du conteneur via ResizeObserver.
 */
function _onResize() {
    if (!_renderer || !_camera || !_currentContainer) return;

    const width = Math.max(_currentContainer.clientWidth, MIN_SIZE);
    const height = Math.max(_currentContainer.clientHeight, MIN_SIZE);

    _camera.aspect = width / height;
    _camera.updateProjectionMatrix();
    _renderer.setSize(width, height);
}

/**
 * Dispose un matériau et toutes ses textures associées.
 * Parcourt les clés de l'objet pour trouver les textures disposables.
 */
function _disposeMaterial(material) {
    for (const key of Object.keys(material)) {
        const value = material[key];
        if (value && typeof value === 'object' && typeof value.dispose === 'function') {
            value.dispose();
        }
    }
    material.dispose();
}

// ── Miniatures hors-écran ──────────────────────────────────────────────────
let _thumbRenderer = null;

/**
 * Génère une miniature PNG (dataURL) d'un modèle GLB via rendu Three.js hors-écran.
 * Le renderer interne est réutilisé entre les appels pour éviter de recréer
 * un contexte WebGL à chaque miniature.
 *
 * @param {string} modelUrl - URL du fichier GLB/GLTF
 * @returns {Promise<string|null>} dataURL base64 ou null en cas d'erreur
 */
async function generateThumbnail(modelUrl) {
    try {
        // Créer le renderer miniature une seule fois
        if (!_thumbRenderer) {
            _thumbRenderer = new THREE.WebGLRenderer({
                antialias: true, alpha: true,
                preserveDrawingBuffer: true
            });
            _thumbRenderer.setPixelRatio(1);
            _thumbRenderer.setSize(THUMB_SIZE, THUMB_SIZE);
            _thumbRenderer.outputColorSpace = THREE.SRGBColorSpace;
            _thumbRenderer.toneMapping = THREE.ACESFilmicToneMapping;
            _thumbRenderer.toneMappingExposure = 1.0;
        }

        // Scène temporaire
        const scene = new THREE.Scene();
        scene.background = new THREE.Color(THUMB_BG);
        scene.add(new THREE.AmbientLight(0xffffff, 0.6));
        const dl1 = new THREE.DirectionalLight(0xffffff, 0.8);
        dl1.position.set(5, 10, 7);
        scene.add(dl1);
        const dl2 = new THREE.DirectionalLight(0xffffff, 0.3);
        dl2.position.set(-5, -3, -5);
        scene.add(dl2);

        // Caméra temporaire
        const camera = new THREE.PerspectiveCamera(CAMERA_FOV, 1, 0.01, 1000);

        // Charger le modèle
        const gltf = await new Promise((resolve, reject) => {
            new GLTFLoader().load(modelUrl, resolve, undefined, reject);
        });

        const model = gltf.scene;
        scene.add(model);

        // Centrer et cadrer
        const box = new THREE.Box3().setFromObject(model);
        const center = new THREE.Vector3();
        const size = new THREE.Vector3();
        box.getCenter(center);
        box.getSize(size);
        const maxSize = Math.max(size.x, size.y, size.z) || 1;

        model.position.sub(center);
        const dist = maxSize * DISTANCE_FACTOR;
        camera.position.set(dist, dist * 0.5, dist);
        camera.lookAt(0, 0, 0);
        camera.near = maxSize * 0.001;
        camera.far = maxSize * 100;
        camera.updateProjectionMatrix();

        // Rendu d'une frame unique
        _thumbRenderer.render(scene, camera);
        const dataUrl = _thumbRenderer.domElement.toDataURL('image/png');

        // Nettoyer la scène temporaire (géométries + matériaux)
        scene.traverse((obj) => {
            if (obj.geometry) obj.geometry.dispose();
            if (obj.material) {
                (Array.isArray(obj.material) ? obj.material : [obj.material])
                    .forEach(m => _disposeMaterial(m));
            }
        });

        return dataUrl;
    } catch (e) {
        console.warn('[Scene3DViewer] Thumbnail generation failed:', e);
        return null;
    }
}

/**
 * Libère le renderer miniature (contexte WebGL).
 */
function disposeThumbnailRenderer() {
    if (_thumbRenderer) {
        _thumbRenderer.dispose();
        _thumbRenderer.forceContextLoss();
        _thumbRenderer = null;
    }
}

// ── Exposition globale ──────────────────────────────────────────────────────
// Permet l'appel depuis des scripts non-modules (ex: scene_config.js en IIFE)
window.Scene3DViewer = { open, close, generateThumbnail, disposeThumbnailRenderer };
