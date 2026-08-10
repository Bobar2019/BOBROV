/**
 * BOB-ROV — Module Réglages Caméra V4L2 en direct
 * Gère les onglets caméra, les sliders V4L2 et l'application en temps réel.
 */
'use strict';

const CameraConfig = (() => {
    // État local : devices pour chaque onglet
    let camDevices = {
        1: '/dev/video0',
        2: '/dev/video20'
    };
    let activeTab = 1;
    // Paramètres en mémoire pour chaque caméra
    let camParams = { 1: {}, 2: {} };

    // ==========================================================
    // INITIALISATION
    // ==========================================================
    function init() {
        // Onglets caméra
        document.querySelectorAll('.cam-tab').forEach(tab => {
            tab.addEventListener('click', () => switchTab(parseInt(tab.dataset.cam)));
        });

        // Boutons d'action
        _bindClick('btn-cam-apply', applyParams);
        _bindClick('btn-cam-reset', resetParams);
        _bindClick('btn-cam-refresh-params', () => loadParams(activeTab));

        // --- Mode Priorité FPS (désactive auto-exposition pour stabiliser le framerate) ---
        document.getElementById('btn-fps-priority')?.addEventListener('click', async () => {
            const btn = document.getElementById('btn-fps-priority');
            const isActive = btn.classList.toggle('active');
            // Utiliser le device de l'onglet caméra actif
            const device = camDevices[activeTab];
            try {
                await fetch(`/api/camera/params/${encodeURIComponent(device)}`, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({exposure_auto: isActive ? 1 : 3})
                });
                btn.textContent = isActive ? '⚡ Priorité FPS (ON)' : '⚡ Priorité FPS';
            } catch (e) {
                console.error('Erreur mode priorité FPS:', e);
            }
        });

        // Charger les devices depuis la config serveur
        loadConfig().then(() => {
            loadParams(activeTab);
        });
    }

    /**
     * Charge la config serveur pour connaître les devices des caméras
     */
    async function loadConfig() {
        try {
            const r = await fetch('/api/config');
            const config = await r.json();
            const cam = config.CAMERA || {};
            const cam2 = config.CAMERA2 || {};
            camDevices[1] = cam.device || '/dev/video0';
            camDevices[2] = cam2.device || '/dev/video2';
            _updateDeviceLabel();
        } catch (e) {
            console.error('[CameraConfig] Erreur config:', e);
        }
    }

    /**
     * Bascule vers un onglet caméra
     */
    function switchTab(tabNum) {
        activeTab = tabNum;
        document.querySelectorAll('.cam-tab').forEach(t => {
            t.classList.toggle('active', parseInt(t.dataset.cam) === tabNum);
        });
        _updateDeviceLabel();
        loadParams(tabNum);
    }

    /**
     * Met à jour le label du device affiché
     */
    function _updateDeviceLabel() {
        const label = document.getElementById('cam-device-label');
        if (label) label.textContent = camDevices[activeTab] || 'Inconnu';
    }

    // ==========================================================
    // CHARGEMENT DES PARAMÈTRES V4L2
    // ==========================================================
    async function loadParams(tabNum) {
        const device = camDevices[tabNum];
        if (!device) return;

        try {
            const encodedDevice = encodeURIComponent(device);
            const r = await fetch(`/api/camera/params/${encodedDevice}`);
            const data = await r.json();
            const controls = data.controls || {};

            // Stocker les valeurs en mémoire
            camParams[tabNum] = {};
            Object.entries(controls).forEach(([name, meta]) => {
                camParams[tabNum][name] = meta.value;
            });

            renderControls(controls, tabNum);
            _updateDeviceLabel();
        } catch (e) {
            console.error(`[CameraConfig] Erreur lecture ${device}:`, e);
            renderEmptyPanel();
        }
    }

    /**
     * Rend les contrôles V4L2 dans la grille
     */
    function renderControls(controls, tabNum) {
        const grid = document.getElementById('cam-controls-grid');
        if (!grid) return;
        grid.innerHTML = '';

        Object.entries(controls).forEach(([name, meta]) => {
            if (meta.type === 'boolean') {
                // Toggle switch
                const item = document.createElement('div');
                item.className = 'cam-ctrl-toggle';

                const label = document.createElement('span');
                label.textContent = meta.label || name;
                item.appendChild(label);

                const toggle = document.createElement('label');
                toggle.className = 'toggle-switch';

                const input = document.createElement('input');
                input.type = 'checkbox';
                input.checked = !!meta.value;
                input.dataset.ctrl = name;
                input.dataset.tab = tabNum;
                input.addEventListener('change', () => {
                    camParams[tabNum][name] = input.checked;
                });
                toggle.appendChild(input);

                const track = document.createElement('span');
                track.className = 'slider-track';
                toggle.appendChild(track);

                item.appendChild(toggle);
                grid.appendChild(item);
            } else {
                // Slider avec valeur
                const item = document.createElement('div');
                item.className = 'cam-ctrl-item';

                const label = document.createElement('label');
                label.innerHTML = `${meta.label || name} <span id="cam-val-${name}">${meta.value !== undefined ? meta.value : ''}</span>`;
                item.appendChild(label);

                const slider = document.createElement('input');
                slider.type = 'range';
                slider.min = meta.min || 0;
                slider.max = meta.max || 100;
                slider.step = meta.step || 1;
                slider.value = meta.value !== undefined ? meta.value : (meta.default || 0);
                slider.dataset.ctrl = name;
                slider.dataset.tab = tabNum;

                slider.addEventListener('input', () => {
                    const valSpan = document.getElementById(`cam-val-${name}`);
                    if (valSpan) valSpan.textContent = slider.value;
                    camParams[tabNum][name] = parseFloat(slider.value);
                });

                item.appendChild(slider);
                grid.appendChild(item);
            }
        });

        if (Object.keys(controls).length === 0) {
            renderEmptyPanel();
        }
    }

    /**
     * Affiche un message quand aucun contrôle n'est disponible
     */
    function renderEmptyPanel() {
        const grid = document.getElementById('cam-controls-grid');
        if (!grid) return;
        grid.innerHTML = '<p class="hint">Aucun contrôle V4L2 disponible pour cette caméra. Vérifiez que le périphérique est connecté.</p>';
    }

    // ==========================================================
    // APPLICATION DES PARAMÈTRES EN TEMPS RÉEL
    // ==========================================================
    async function applyParams() {
        const device = camDevices[activeTab];
        const params = camParams[activeTab];
        if (!device || !params || Object.keys(params).length === 0) {
            App.showNotification('Aucun paramètre à appliquer');
            return;
        }

        try {
            const encodedDevice = encodeURIComponent(device);
            const r = await fetch(`/api/camera/params/${encodedDevice}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(params)
            });
            const data = await r.json();

            // Compter les succès
            const results = data.results || {};
            const successCount = Object.values(results).filter(v => v === true).length;
            const totalCount = Object.keys(results).length;
            App.showNotification(`Caméra: ${successCount}/${totalCount} paramètres appliqués`);
        } catch (e) {
            console.error('[CameraConfig] Erreur application:', e);
            App.showNotification('Erreur lors de l\'application');
        }
    }

    /**
     * Réinitialise les paramètres de la caméra active
     */
    async function resetParams() {
        const device = camDevices[activeTab];
        if (!device) return;

        try {
            const encodedDevice = encodeURIComponent(device);
            await fetch(`/api/camera/reset/${encodedDevice}`, { method: 'POST' });
            App.showNotification('Paramètres réinitialisés');
            // Recharger les valeurs
            loadParams(activeTab);
        } catch (e) {
            console.error('[CameraConfig] Erreur reset:', e);
        }
    }

    // ==========================================================
    // ACCÈS PUBLIC (pour le panneau cockpit)
    // ==========================================================

    /**
     * Retourne le device actif de la caméra principale
     */
    function getMainDevice() {
        return camDevices[1];
    }

    /**
     * Retourne les paramètres actuels d'une caméra
     */
    function getParams(tabNum) {
        return camParams[tabNum] || {};
    }

    /**
     * Applique un seul paramètre immédiatement (pour panneau cockpit)
     * Met aussi à jour camParams en mémoire pour synchroniser la page config.
     */
    async function applySingleParam(device, control, value) {
        // Mettre à jour la valeur en mémoire pour l'onglet actif (caméra 1 = principale)
        for (const tab of [1, 2]) {
            if (camDevices[tab] === device && camParams[tab]) {
                camParams[tab][control] = value;
            }
        }
        // Mettre à jour le slider correspondant dans la page config si visible
        const valSpan = document.getElementById(`cam-val-${control}`);
        if (valSpan) valSpan.textContent = value;
        const slider = document.querySelector(`input[data-ctrl="${control}"]`);
        if (slider && slider.type === 'range') slider.value = value;

        try {
            const encodedDevice = encodeURIComponent(device);
            await fetch(`/api/camera/params/${encodedDevice}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ [control]: value })
            });
        } catch (e) {
            console.error(`[CameraConfig] Erreur ${control}:`, e);
        }
    }

    /**
     * Synchronise les sliders rapides du cockpit avec les valeurs V4L2 réelles
     * de la caméra principale. Appelé au switch d'onglet et après swap.
     */
    async function syncCockpitSliders() {
        const device = camDevices[1];
        if (!device) return;
        try {
            const encodedDevice = encodeURIComponent(device);
            const r = await fetch(`/api/camera/params/${encodedDevice}`);
            const data = await r.json();
            const controls = data.controls || {};

            // Mettre à jour camParams en mémoire
            camParams[1] = {};
            Object.entries(controls).forEach(([name, meta]) => {
                camParams[1][name] = meta.value;
            });

            // Synchroniser les sliders cockpit
            const brightnessSlider = document.getElementById('cockpit-brightness');
            const brightnessVal = document.getElementById('cockpit-brightness-val');
            if (brightnessSlider && controls.brightness !== undefined) {
                brightnessSlider.value = controls.brightness.value;
                if (brightnessVal) brightnessVal.textContent = controls.brightness.value;
            }
            const contrastSlider = document.getElementById('cockpit-contrast');
            const contrastVal = document.getElementById('cockpit-contrast-val');
            if (contrastSlider && controls.contrast !== undefined) {
                contrastSlider.value = controls.contrast.value;
                if (contrastVal) contrastVal.textContent = controls.contrast.value;
            }
        } catch (e) {
            console.error('[CameraConfig] Erreur sync sliders:', e);
        }
    }

    // ==========================================================
    // UTILITAIRE
    // ==========================================================
    function _bindClick(id, fn) {
        const el = document.getElementById(id);
        if (el) el.addEventListener('click', fn);
    }

    // ==========================================================
    // INIT
    // ==========================================================
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();

    return { switchTab, loadConfig, loadParams, applyParams, resetParams, getMainDevice, getParams, applySingleParam, syncCockpitSliders, camDevices };
})();
