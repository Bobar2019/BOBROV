/**
 * BOB-ROV — Module Test Manette en direct
 * Lecture des entrées gamepad via Gamepad API et affichage temps réel
 */
'use strict';

const GamepadTest = (() => {
    let running = false;
    let animFrameId = null;
    let lastActivity = 0;
    let prevState = null;
    const INACTIVITY_TIMEOUT = 60000; // 60s auto-stop

    // ==========================================================
    // CONTRÔLE DU TEST
    // ==========================================================
    function start() {
        if (running) return;
        running = true;
        lastActivity = Date.now();
        prevState = null;
        renderTestUI();
        poll();
        updateConnectionStatus();
        console.log('[GamepadTest] Test démarré');
    }

    function stop() {
        running = false;
        if (animFrameId) {
            cancelAnimationFrame(animFrameId);
            animFrameId = null;
        }
        // Réactiver les boutons
        const btnStart = document.getElementById('gp-test-start');
        const btnStop = document.getElementById('gp-test-stop');
        if (btnStart) btnStart.disabled = false;
        if (btnStop) btnStop.disabled = true;
        console.log('[GamepadTest] Test arrêté');
    }

    // ==========================================================
    // BOUCLE DE POLLING
    // ==========================================================
    function poll() {
        if (!running) return;

        // Vérifier le timeout d'inactivité
        if (Date.now() - lastActivity > INACTIVITY_TIMEOUT) {
            App.showNotification('Test manette arrêté (inactivité)');
            stop();
            return;
        }

        const gamepads = navigator.getGamepads();
        const gp = gamepads[0] || gamepads[1] || gamepads[2] || gamepads[3];

        if (gp) {
            updateDisplay(gp);
            detectActivity(gp);
        }

        updateConnectionStatus();
        animFrameId = requestAnimationFrame(poll);
    }

    // ==========================================================
    // DÉTECTION D'ACTIVITÉ
    // ==========================================================
    function detectActivity(gp) {
        // Détecte si un bouton est pressé ou un axe est bougé
        for (let i = 0; i < gp.buttons.length; i++) {
            if (gp.buttons[i].pressed) {
                lastActivity = Date.now();
                return;
            }
        }
        for (let i = 0; i < gp.axes.length; i++) {
            if (Math.abs(gp.axes[i]) > 0.15) {
                lastActivity = Date.now();
                return;
            }
        }
    }

    // ==========================================================
    // RENDU INITIAL DE L'UI DE TEST
    // ==========================================================
    function renderTestUI() {
        // Boutons
        const btnContainer = document.getElementById('gp-test-buttons');
        if (btnContainer) {
            const buttonLabels = [
                '✕', '○', '□', '△', 'L1', 'R1', 'L2', 'R2',
                'Share', 'Opt', 'L3', 'R3', '↑', '↓', '←', '→', 'PS', 'Touch'
            ];
            btnContainer.innerHTML = buttonLabels.map((label, idx) =>
                `<div class="test-btn-indicator" id="gp-test-btn-${idx}">
                    <span class="btn-dot"></span>
                    <span>${label}</span>
                </div>`
            ).join('');
        }

        // Axes
        const axesContainer = document.getElementById('gp-test-axes');
        if (axesContainer) {
            const axisLabels = ['LX', 'LY', 'RX', 'RY', 'L2', 'R2'];
            axesContainer.innerHTML = axisLabels.map((label, idx) =>
                `<div class="test-axis-row">
                    <label>${label}</label>
                    <div class="axis-bar-wrapper">
                        <div class="axis-bar-center"></div>
                        <div class="axis-bar-fill" id="gp-test-axis-${idx}"></div>
                    </div>
                    <span class="axis-value" id="gp-test-axis-val-${idx}">0.00</span>
                </div>`
            ).join('');
        }
    }

    // ==========================================================
    // MISE À JOUR DE L'AFFICHAGE
    // ==========================================================
    function updateDisplay(gp) {
        // Mise à jour des boutons
        for (let i = 0; i < Math.min(gp.buttons.length, 18); i++) {
            const el = document.getElementById(`gp-test-btn-${i}`);
            if (el) {
                if (gp.buttons[i].pressed) {
                    el.classList.add('active');
                } else {
                    el.classList.remove('active');
                }
            }
        }

        // Mise à jour des axes
        for (let i = 0; i < Math.min(gp.axes.length, 6); i++) {
            const barEl = document.getElementById(`gp-test-axis-${i}`);
            const valEl = document.getElementById(`gp-test-axis-val-${i}`);
            if (barEl) {
                const value = gp.axes[i];
                // Calculer la position de la barre (centré à 50%)
                if (value >= 0) {
                    barEl.style.left = '50%';
                    barEl.style.width = (value * 50) + '%';
                } else {
                    barEl.style.left = (50 + value * 50) + '%';
                    barEl.style.width = (-value * 50) + '%';
                }
            }
            if (valEl) {
                valEl.textContent = gp.axes[i].toFixed(2);
            }
        }

        // Mettre à jour le visuel SVG
        if (typeof GamepadVisual !== 'undefined') {
            GamepadVisual.updateFromGamepadState(gp);
        }
    }

    // ==========================================================
    // STATUT DE CONNEXION
    // ==========================================================
    function updateConnectionStatus() {
        const badge = document.getElementById('gp-connection-badge');
        const nameEl = document.getElementById('gp-gamepad-name');
        if (!badge) return;

        const gamepads = navigator.getGamepads();
        const gp = gamepads[0] || gamepads[1] || gamepads[2] || gamepads[3];

        if (gp) {
            badge.className = 'gp-connected';
            badge.textContent = '🟢 Connectée';
            if (nameEl) nameEl.textContent = gp.id.substring(0, 40);
        } else {
            badge.className = 'gp-disconnected';
            badge.textContent = '⚪ Déconnectée';
            if (nameEl) nameEl.textContent = '';
        }
    }

    return { start, stop, isRunning: () => running };
})();
