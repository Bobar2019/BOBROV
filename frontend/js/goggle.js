'use strict';

const Goggle = (() => {
    let active = false;
    let nightMode = false;
    let crosshairVisible = true;
    let hideTimeout = null;
    let timerInterval = null;
    let startTime = 0;
    const INACTIVITY_TIMEOUT = 3000; // 3 secondes

    // === ÉLÉMENTS DOM ===
    let overlay, videoEl, toolbar, controls, crosshair, timerEl;

    function init() {
        overlay = document.getElementById('goggle-overlay');
        if (!overlay) return;
        videoEl = overlay.querySelector('.goggle-video');
        toolbar = overlay.querySelector('.goggle-toolbar');
        controls = overlay.querySelector('.goggle-controls');
        crosshair = overlay.querySelector('.goggle-crosshair');
        timerEl = overlay.querySelector('.goggle-timer');

        setupKeyboardShortcuts();
        setupMouseActivity();
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

            if (typeof App !== 'undefined') App.showNotification('🥽 Mode Lunette activé');

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

        // Arrêter le timer
        if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }

        // Quitter le plein écran
        exitFullscreen();

        // Arrêter le flux vidéo dans l'overlay
        videoEl.src = '';

        if (typeof App !== 'undefined') App.showNotification('Mode Lunette désactivé');
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
        if (document.fullscreenElement || document.webkitFullscreenElement) exitFullscreen();
        else requestFullscreen();
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
    };
})();
