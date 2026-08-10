'use strict';

const Goggle = (() => {
    let active = false;
    let nightMode = false;
    let crosshairVisible = true;
    let hideTimeout = null;
    let timerInterval = null;
    let startTime = 0;
    let _intentionalFsToggle = false; // true quand on bascule le plein écran via F (ne pas fermer les lunettes)
    const INACTIVITY_TIMEOUT = 3000; // 3 secondes

    // === ÉLÉMENTS DOM ===
    let overlay, videoEl, toolbar, controls, crosshair, timerEl, osdCanvas;

    function init() {
        overlay = document.getElementById('goggle-overlay');
        if (!overlay) return;
        videoEl = overlay.querySelector('.goggle-video');
        toolbar = overlay.querySelector('.goggle-toolbar');
        controls = overlay.querySelector('.goggle-controls');
        crosshair = overlay.querySelector('.goggle-crosshair');
        timerEl = overlay.querySelector('.goggle-timer');

        // Créer le canvas OSD dédié au mode lunettes (une seule fois)
        osdCanvas = document.getElementById('goggle-osd-canvas');
        if (!osdCanvas && overlay) {
            osdCanvas = document.createElement('canvas');
            osdCanvas.id = 'goggle-osd-canvas';
            osdCanvas.className = 'goggle-osd-canvas';
            // Insérer après la vidéo mais avant la toolbar
            overlay.insertBefore(osdCanvas, overlay.querySelector('.goggle-toolbar') || overlay.firstChild);
        }

        setupKeyboardShortcuts();
        setupMouseActivity();
        setupFullscreenListener();
    }

    // === ACTIVATION / DÉSACTIVATION ===

    async function activate() {
        if (active) return;

        try {
            const resp = await fetch('/api/goggle/activate', { method: 'POST' });
            const data = await resp.json();
            if (data.status !== 'ok') {
                if (typeof App !== 'undefined') App.showNotification('❌ ' + data.message);
                return;
            }

            active = true;
            overlay.classList.add('active');

            // Charger le flux vidéo
            videoEl.src = '/video_feed';

            // Démarrer le timer
            startTime = Date.now();
            timerInterval = setInterval(updateTimer, 1000);

            // Mode nuit si actif
            if (data.night_mode) {
                nightMode = true;
                overlay.classList.add('night-mode');
            }

            // Crosshair
            if (data.crosshair && crosshair) {
                crosshairVisible = true;
                crosshair.style.display = '';
            }

            // Plein écran
            requestFullscreen();

            // Démarrer auto-hide
            resetInactivityTimer();

            // Basculer vers le profil OSD lunettes
            if (typeof OSDLayout !== 'undefined' && OSDLayout.setProfile) {
                OSDLayout.setProfile('goggles', true);
            }

            // Redimensionner le canvas OSD lunettes
            // Utiliser requestAnimationFrame pour laisser le navigateur calculer le layout flex
            if (osdCanvas) {
                requestAnimationFrame(() => {
                    _resizeGoggleCanvas();
                    // Synchroniser le contexte 2D via telemetry
                    if (typeof Telemetry !== 'undefined' && Telemetry.resizeCanvas) {
                        Telemetry.resizeCanvas();
                    }
                });
                // Deuxième resize différé pour garantir le layout final
                setTimeout(() => {
                    _resizeGoggleCanvas();
                    if (typeof Telemetry !== 'undefined' && Telemetry.resizeCanvas) {
                        Telemetry.resizeCanvas();
                    }
                }, 200);
            }

            if (typeof App !== 'undefined') App.showNotification('🥽 Mode Lunette activé');

            // Recharger immédiatement le mapping manette depuis le backend
            // (le profil "Lunette" vient d'être activé côté serveur)
            if (typeof Gamepad !== 'undefined' && Gamepad.reloadFromBackend) {
                Gamepad.reloadFromBackend();
            }

        } catch(e) {
            console.error('[Goggle] Erreur activation:', e);
        }
    }

    async function deactivate() {
        if (!active) return;

        try {
            await fetch('/api/goggle/deactivate', { method: 'POST' });
        } catch(e) {
            console.warn('[Goggle] Erreur désactivation API:', e);
        }

        active = false;
        overlay.classList.remove('active', 'night-mode', 'hide-ui');
        nightMode = false;

        // Restaurer le profil OSD écran
        if (typeof OSDLayout !== 'undefined' && OSDLayout.setProfile) {
            OSDLayout.setProfile('screen', true);
        }

        // Arrêter le timer
        if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }

        // Quitter le plein écran
        exitFullscreen();

        // Arrêter le flux vidéo dans l'overlay
        videoEl.src = '';

        if (typeof App !== 'undefined') App.showNotification('Mode Lunette désactivé');

        // Recharger immédiatement le mapping manette depuis le backend
        // (le profil précédent vient d'être restauré côté serveur)
        if (typeof Gamepad !== 'undefined' && Gamepad.reloadFromBackend) {
            Gamepad.reloadFromBackend();
        }
    }

    function toggle() {
        if (active) deactivate();
        else activate();
    }

    // === MODE NUIT ===

    async function toggleNight() {
        try {
            const resp = await fetch('/api/goggle/night', { method: 'POST' });
            const data = await resp.json();
            nightMode = data.night_mode;
            if (nightMode) overlay.classList.add('night-mode');
            else overlay.classList.remove('night-mode');
        } catch(e) {
            // Toggle local quand même
            nightMode = !nightMode;
            overlay.classList.toggle('night-mode', nightMode);
        }
    }

    // === CROSSHAIR ===

    function toggleCrosshair() {
        crosshairVisible = !crosshairVisible;
        if (crosshair) crosshair.style.display = crosshairVisible ? '' : 'none';
    }

    // === PLEIN ÉCRAN ===

    function requestFullscreen() {
        const el = overlay;
        if (el.requestFullscreen) el.requestFullscreen();
        else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
    }

    function exitFullscreen() {
        if (document.fullscreenElement) document.exitFullscreen();
        else if (document.webkitFullscreenElement) document.webkitExitFullscreen();
    }

    function toggleFullscreen() {
        if (document.fullscreenElement || document.webkitFullscreenElement) {
            _intentionalFsToggle = true;
            exitFullscreen();
        } else {
            requestFullscreen();
        }
    }

    // === FULLSCREEN CHANGE LISTENER ===

    function setupFullscreenListener() {
        const handler = () => {
            if (!active) return;
            // Si on bascule le plein écran via F, ne pas fermer les lunettes
            if (_intentionalFsToggle) {
                _intentionalFsToggle = false;
                return;
            }
            // Distinguer entrée vs sortie de plein écran
            const fsElement = document.fullscreenElement || document.webkitFullscreenElement;
            if (fsElement) {
                // Entrée en plein écran → rien à faire (c'est l'activation normale)
                return;
            }
            // Sortie de plein écran détectée (Escape navigateur, swipe, etc.)
            // → Désactiver le mode lunette automatiquement
            console.log('[Goggle] Sortie de plein écran détectée → désactivation');
            deactivate();
        };
        document.addEventListener('fullscreenchange', handler);
        document.addEventListener('webkitfullscreenchange', handler);
    }

    // === AUTO-HIDE UI (inactivité) ===

    function resetInactivityTimer() {
        overlay.classList.remove('hide-ui');
        if (hideTimeout) clearTimeout(hideTimeout);
        hideTimeout = setTimeout(() => {
            if (active) overlay.classList.add('hide-ui');
        }, INACTIVITY_TIMEOUT);
    }

    function setupMouseActivity() {
        document.addEventListener('mousemove', () => {
            if (active) resetInactivityTimer();
        });
        document.addEventListener('touchstart', () => {
            if (active) resetInactivityTimer();
        });
    }

    // === RACCOURCIS CLAVIER ===

    function setupKeyboardShortcuts() {
        document.addEventListener('keydown', (e) => {
            // Ne pas interférer avec les inputs
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;

            switch(e.key.toLowerCase()) {
                case 'g':
                    toggle();
                    e.preventDefault();
                    break;
                case 'f':
                    if (active) { toggleFullscreen(); e.preventDefault(); }
                    break;
                case 'n':
                    if (active) { toggleNight(); e.preventDefault(); }
                    break;
                case 'escape':
                    if (active) { deactivate(); e.preventDefault(); }
                    break;
            }
        });
    }

    // === TIMER ===

    function updateTimer() {
        if (!timerEl || !active) return;
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        const min = Math.floor(elapsed / 60).toString().padStart(2, '0');
        const sec = (elapsed % 60).toString().padStart(2, '0');
        timerEl.textContent = `${min}:${sec}`;
    }

    // === CANVAS OSD LUNETTES ===

    function _resizeGoggleCanvas() {
        if (!osdCanvas || !overlay) return;
        const rect = overlay.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const w = Math.max(1, Math.floor(rect.width));
        const h = Math.max(1, Math.floor(rect.height));
        osdCanvas.width  = Math.round(w * dpr);
        osdCanvas.height = Math.round(h * dpr);
        osdCanvas.style.width  = w + 'px';
        osdCanvas.style.height = h + 'px';
    }

    // === COMMANDES RAPIDES (boutons overlay) ===

    async function quickAction(actionName) {
        try {
            const resp = await fetch(`/api/action/${actionName}`, { method: 'POST' });
            const data = await resp.json();
            // Flash visuel pour confirmer
            if (data.status === 'ok' && typeof App !== 'undefined') {
                App.showNotification(data.message || `✓ ${actionName}`);
            }
        } catch(e) {
            console.warn(`[Goggle] Action ${actionName} échouée:`, e);
        }
    }

    return {
        init,
        activate,
        deactivate,
        toggle,
        toggleNight,
        toggleCrosshair,
        toggleFullscreen,
        quickAction,
        isActive: () => active,
        getOsdCanvas: () => osdCanvas,
    };
})();
