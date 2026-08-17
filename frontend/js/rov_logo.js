/**
 * rov_logo.js — Mini-vue 3D wireframe du ROV à côté du titre dans le header.
 *
 * Charge /static/models/bob_rov_3D.glb, applique un style filaire néon cyan
 * et anime une rotation yaw continue. Le rendu se met en pause quand l'onglet
 * perd le focus pour économiser les ressources.
 *
 * Dépendances : Three.js via importmap (three@0.170.0).
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// ── Constantes ──────────────────────────────────────────────────────────────
const CANVAS_ID   = 'rov-logo-canvas';
const MODEL_URL   = '/static/models/bob_rov_3D.glb';
const WIRE_COLOR  = 0x00ff66;   // vert fluo néon
const WIRE_OPACITY = 0.9;
const ROT_SPEED   = 0.4;        // radians/seconde (rotation douce)
const CAM_FOV     = 40;
const CAM_DISTANCE = 4.5;
const TILT_ANGLE  = 0.25;       // légère plongée (~14°)

// ── État interne ────────────────────────────────────────────────────────────
let renderer = null;
let scene    = null;
let camera   = null;
let model    = null;
let animId   = null;
let running  = true;
let yaw      = 0;

// ── Initialisation ──────────────────────────────────────────────────────────
function init() {
    const canvas = document.getElementById(CANVAS_ID);
    if (!canvas) return;

    // Renderer transparent + antialiasing
    renderer = new THREE.WebGLRenderer({
        canvas,
        alpha: true,
        antialias: true,
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(canvas.width, canvas.height, false);
    renderer.setClearColor(0x000000, 0);

    // Scène
    scene = new THREE.Scene();

    // Caméra perspective avec léger angle de plongée
    camera = new THREE.PerspectiveCamera(CAM_FOV, 1, 0.1, 100);
    camera.position.set(0, Math.sin(TILT_ANGLE) * CAM_DISTANCE, Math.cos(TILT_ANGLE) * CAM_DISTANCE);
    camera.lookAt(0, 0, 0);

    // Éclairage (visible en wireframe)
    scene.add(new THREE.AmbientLight(0xffffff, 0.8));
    const dir = new THREE.DirectionalLight(0xffffff, 0.4);
    dir.position.set(2, 3, 4);
    scene.add(dir);

    // Chargement du modèle
    const loader = new GLTFLoader();
    loader.load(MODEL_URL, (gltf) => {
        model = gltf.scene;

        // Appliquer le style wireframe néon
        model.traverse((child) => {
            child.castShadow = false;
            child.receiveShadow = false;
            if (child.isMesh) {
                const mats = Array.isArray(child.material) ? child.material : [child.material];
                mats.forEach(mat => {
                    if (mat) {
                        mat.wireframe = true;
                        mat.transparent = true;
                        mat.opacity = WIRE_OPACITY;
                        mat.color.set(WIRE_COLOR);
                        mat.emissive = new THREE.Color(WIRE_COLOR);
                        mat.emissiveIntensity = 0.5;
                        mat.needsUpdate = true;
                    }
                });

                // LineSegments en renfort (garantit le filaire sur tous les renderers)
                try {
                    const edges = new THREE.EdgesGeometry(child.geometry, 15);
                    const lineMat = new THREE.LineBasicMaterial({
                        color: WIRE_COLOR,
                        transparent: true,
                        opacity: WIRE_OPACITY,
                    });
                    child.add(new THREE.LineSegments(edges, lineMat));
                } catch (_) { /* silently ignore */ }
            }
        });

        // Centrer et normaliser la taille
        const box = new THREE.Box3().setFromObject(model);
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        model.position.sub(center);
        const maxDim = Math.max(size.x, size.y, size.z);
        if (maxDim > 0) {
            model.scale.setScalar(1.8 / maxDim);
        }

        scene.add(model);
        console.log(`[RovLogo] Modèle chargé (${size.x.toFixed(2)}×${size.y.toFixed(2)}×${size.z.toFixed(2)}, scale=${(1.8/maxDim).toFixed(2)})`);
    }, undefined, (err) => {
        console.error('[RovLogo] Erreur chargement:', err);
    });

    // Gestion visibilitychange : pause quand l'onglet est masqué
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            running = false;
        } else {
            running = true;
        }
    });

    // Lancer la boucle d'animation
    _animate();
}

// ── Boucle d'animation ──────────────────────────────────────────────────────
let lastTime = 0;

function _animate(time = 0) {
    animId = requestAnimationFrame(_animate);

    if (!running || !model || !renderer) return;

    // Delta time pour rotation indépendante du framerate
    const dt = lastTime ? (time - lastTime) / 1000 : 0.016;
    lastTime = time;

    // Rotation yaw continue
    yaw += ROT_SPEED * dt;
    model.rotation.y = yaw;

    renderer.render(scene, camera);
}

// ── Démarrage quand le DOM est prêt ─────────────────────────────────────────
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
