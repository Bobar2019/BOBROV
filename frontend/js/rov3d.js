// rov3d.js - Rendu 3D filaire du ROV dans l'OSD (ES Module)
// Utilise Three.js pour charger et animer un modèle .glb synchronisé avec roll/pitch

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// Exposer THREE globalement pour debug console
window.THREE = THREE;

// ==========================================================
// ÉTAT DU MODULE
// ==========================================================
let scene = null;
let camera = null;
let renderer = null;
let model = null;
let roll = 0, pitch = 0, yaw = 0;
let visible = true;
let _heaveY = 0;          // offset vertical (mode test manette)
let _surgeZ = 0;          // offset avant/arrière (mode test manette)
let _basePosX = 0;        // position X centrée du modèle
let _basePosY = 0;        // position Y centrée du modèle (après chargement)
let _basePosZ = 0;        // position Z centrée du modèle
let _initialized = false;

// Taille fixe du rendu WebGL (perf : pas besoin de redimensionner à chaque frame)
const RENDER_SIZE = 400;

// ==========================================================
// INITIALISATION
// ==========================================================
function init() {
    if (_initialized) return;

    try {
        scene = new THREE.Scene();

        camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
        camera.position.set(0, 1.5, 4);
        camera.lookAt(0, 0, 0);

        // Canvas caché avec alpha pour compositing sur le canvas OSD
        // preserveDrawingBuffer CRITIQUE : sans cela le buffer WebGL est vidé
        // avant que drawImage() puisse le copier sur le canvas OSD
        renderer = new THREE.WebGLRenderer({
            alpha: true,
            antialias: true,
            preserveDrawingBuffer: true
        });
        renderer.setSize(RENDER_SIZE, RENDER_SIZE);
        renderer.setClearColor(0x000000, 0);

        // Éclairage uniforme (visible en wireframe)
        scene.add(new THREE.AmbientLight(0xffffff, 1.0));
        const dirLight = new THREE.DirectionalLight(0xffffff, 0.5);
        dirLight.position.set(1, 2, 3);
        scene.add(dirLight);

        _initialized = true;
        _loadModel();
        _animate();

        console.log('[Rov3D] Module initialisé');
    } catch (e) {
        console.error('[Rov3D] Erreur d\'initialisation Three.js:', e);
    }
}

// ==========================================================
// CHARGEMENT DU MODÈLE .glb
// ==========================================================
function _loadModel(url) {
    if (!_initialized) return;

    const modelUrl = url || '/static/models/bob_rov_3D.glb';
    const loader = new GLTFLoader();

    loader.load(
        modelUrl,
        (gltf) => {
            // Supprimer l'ancien modèle de la scène
            if (model) {
                scene.remove(model);
                model = null;
            }

            model = gltf.scene;

            // Couleur et opacité wireframe
            const wireColor = new THREE.Color(0x00ff00);
            const wireOpacity = 0.85;

            let meshCount = 0;
            model.traverse((child) => {
                // Désactiver les ombres sur TOUS les nœuds
                child.castShadow = false;
                child.receiveShadow = false;

                if (child.isMesh) {
                    meshCount++;

                    // 1. Modifier les matériaux existants in-place
                    //    (fonctionne pour MeshStandardMaterial, MeshPhongMaterial, etc.)
                    const mats = Array.isArray(child.material) ? child.material : [child.material];
                    mats.forEach(mat => {
                        if (mat) {
                            mat.wireframe = true;
                            mat.transparent = true;
                            mat.opacity = wireOpacity;
                            mat.color.set(wireColor);
                            mat.needsUpdate = true;
                        }
                    });

                    // 2. Ajouter des LineSegments wireframe en renfort
                    //    (garantit un rendu filaire même si le matériau ignore wireframe)
                    try {
                        const edges = new THREE.EdgesGeometry(child.geometry, 1);
                        const lineMat = new THREE.LineBasicMaterial({
                            color: wireColor,
                            transparent: true,
                            opacity: wireOpacity
                        });
                        const wireframe = new THREE.LineSegments(edges, lineMat);
                        child.add(wireframe);
                    } catch (e) {
                        // Certaines géométries peuvent échouer (silently)
                    }
                }
            });

            // Centrer et normaliser la taille du modèle
            const box = new THREE.Box3().setFromObject(model);
            const center = box.getCenter(new THREE.Vector3());
            const size = box.getSize(new THREE.Vector3());
            model.position.sub(center);

            const maxDim = Math.max(size.x, size.y, size.z);
            if (maxDim > 0) {
                const scl = 2.0 / maxDim;
                model.scale.setScalar(scl);
            }

            // Stocker les positions centrées (base pour heave/surge)
            _basePosX = model.position.x;
            _basePosY = model.position.y;
            _basePosZ = model.position.z;

            // AJOUTER le modèle à la scène
            scene.add(model);

            console.log(`[Rov3D] Modèle chargé: ${modelUrl} (${meshCount} meshes, bbox: ${size.x.toFixed(3)}×${size.y.toFixed(3)}×${size.z.toFixed(3)}, scale: ${(2.0/maxDim).toFixed(2)})`);
        },
        undefined,
        (err) => {
            console.error('[Rov3D] Erreur chargement modèle:', err);
        }
    );
}

// ==========================================================
// BOUCLE DE RENDU
// ==========================================================
function _animate() {
    requestAnimationFrame(_animate);
    if (model && visible) {
        // Rotations en repère LOCAL via quaternions :
        const qYaw   = new THREE.Quaternion().setFromAxisAngle(
                           new THREE.Vector3(0, 1, 0), (yaw * Math.PI) / 180);
        const qPitch = new THREE.Quaternion().setFromAxisAngle(
                           new THREE.Vector3(1, 0, 0), (pitch * Math.PI) / 180);
        const qRoll  = new THREE.Quaternion().setFromAxisAngle(
                           new THREE.Vector3(0, 0, 1), (roll * Math.PI) / 180);
        model.quaternion.copy(qYaw).multiply(qPitch).multiply(qRoll);

        // Translation surge dans la direction du cap (yaw)
        // -Z local = avant du modèle, projeté dans le repère monde via yaw
        const yawRad = (yaw * Math.PI) / 180;
        const sinY = Math.sin(yawRad);
        const cosY = Math.cos(yawRad);
        model.position.x = _basePosX + _surgeZ * sinY;
        model.position.y = _basePosY + _heaveY;
        model.position.z = _basePosZ + _surgeZ * cosY;

        renderer.render(scene, camera);
    }
}

// ==========================================================
// API PUBLIQUE
// ==========================================================

// Mettre à jour l'attitude (appelé depuis telemetry.js ou gamepad.js test mode)
export function updateAttitude(rollDeg, pitchDeg, yawDeg) {
    roll = rollDeg || 0;
    pitch = pitchDeg || 0;
    yaw = yawDeg || 0;
}

// Translation verticale (heave)
export function setHeaveOffset(y) {
    _heaveY = y || 0;
}

// Translation avant/arrière (surge)
export function setSurgeOffset(z) {
    _surgeZ = z || 0;
}

// Recharger le modèle (après upload d'un nouveau .glb)
export function reloadModel(url) {
    _loadModel(url);
}

// Activer/désactiver la visibilité
export function setVisible(v) {
    visible = v;
}

// Changer la couleur du wireframe
export function setColor(hexColor) {
    if (!model) return;
    const c = new THREE.Color(hexColor);
    model.traverse((child) => {
        if (child.material && (child.isMesh || child.isLineSegments)) {
            const mats = Array.isArray(child.material) ? child.material : [child.material];
            mats.forEach(mat => { if (mat && mat.color) mat.color.copy(c); });
        }
    });
}

// Mettre à jour l'opacité (liée à rov3d_opacity de la config OSD)
export function updateOpacity(opacityPct) {
    if (!model) return;
    const alpha = Math.max(0, Math.min(1, (opacityPct || 100) / 100));
    model.traverse((child) => {
        if (child.material && (child.isMesh || child.isLineSegments)) {
            const mats = Array.isArray(child.material) ? child.material : [child.material];
            mats.forEach(mat => {
                if (mat) {
                    mat.opacity = alpha;
                    mat.transparent = alpha < 1;
                }
            });
        }
    });
}

// Initialiser le module
export function initRov3D() {
    init();
}

// Renvoie le canvas WebGL pour compositing sur le canvas OSD
// Retourne null si pas encore initialisé ou pas de rendu disponible
export function getCanvas() {
    if (!renderer || !_initialized) return null;
    return renderer.domElement;
}

// Taille du rendu WebGL (pour le dimensionnement sur le canvas OSD)
export function getRenderSize() {
    return RENDER_SIZE;
}

// ==========================================================
// UPLOAD D'UN NOUVEAU MODÈLE .glb
// ==========================================================
export async function uploadModel(file) {
    const formData = new FormData();
    formData.append('file', file);

    const resp = await fetch('/api/rov3d/upload', {
        method: 'POST',
        body: formData
    });

    if (!resp.ok) {
        const errData = await resp.json().catch(() => ({}));
        throw new Error(errData.detail || `Erreur ${resp.status}`);
    }

    const data = await resp.json();
    console.log('[Rov3D] Upload réussi:', data);

    // Recharger le modèle avec un timestamp pour bypasser le cache navigateur
    reloadModel(`/static/models/bob_rov_3D.glb?t=${Date.now()}`);
    return data;
}
