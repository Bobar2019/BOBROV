/**
 * BOB-ROV — Module Visualisation SVG Manette (DualShock 4)
 * Affiche un schéma interactif de la manette avec état en temps réel
 */
'use strict';

const GamepadVisual = (() => {
    let svgContainer = null;
    let currentMapping = null;
    let lastUpdate = 0;
    const UPDATE_INTERVAL = 40; // 25Hz

    // ==========================================================
    // INITIALISATION
    // ==========================================================
    function init(containerId) {
        svgContainer = document.getElementById(containerId);
        if (!svgContainer) return;
        renderSVG();
    }

    // ==========================================================
    // RENDU SVG DUALSHOCK 4
    // ==========================================================
    function renderSVG() {
        if (!svgContainer) return;
        svgContainer.innerHTML = `
        <svg viewBox="0 0 400 250" xmlns="http://www.w3.org/2000/svg" id="gamepad-svg">
            <!-- Corps de la manette -->
            <path d="M80,90 C80,60 120,40 150,40 L250,40 C280,40 320,60 320,90
                     L320,130 C320,150 340,180 350,200 C360,220 340,240 320,235
                     C300,230 280,200 270,180 L260,160 L140,160 L130,180
                     C120,200 100,230 80,235 C60,240 40,220 50,200
                     C60,180 80,150 80,130 Z"
                  fill="#2a2a3a" stroke="#444" stroke-width="2"/>

            <!-- D-Pad (gauche) -->
            <rect id="gp-dpad-up" class="gp-btn" x="115" y="88" width="16" height="18" rx="3"/>
            <rect id="gp-dpad-down" class="gp-btn" x="115" y="118" width="16" height="18" rx="3"/>
            <rect id="gp-dpad-left" class="gp-btn" x="99" y="104" width="18" height="16" rx="3"/>
            <rect id="gp-dpad-right" class="gp-btn" x="131" y="104" width="18" height="16" rx="3"/>
            <!-- Centre D-Pad -->
            <rect x="115" y="104" width="16" height="16" rx="2" fill="#333" stroke="none"/>

            <!-- Sticks analogiques -->
            <!-- Stick gauche -->
            <circle cx="155" cy="160" r="22" fill="#1a1a2a" stroke="#555" stroke-width="1.5"/>
            <circle id="gp-stick-left" cx="155" cy="160" r="12" fill="#444" stroke="#666" stroke-width="1"/>
            <!-- Stick droit -->
            <circle cx="245" cy="160" r="22" fill="#1a1a2a" stroke="#555" stroke-width="1.5"/>
            <circle id="gp-stick-right" cx="245" cy="160" r="12" fill="#444" stroke="#666" stroke-width="1"/>

            <!-- Boutons face (droite) -->
            <circle id="gp-btn-triangle" class="gp-btn" cx="285" cy="85" r="10"/>
            <circle id="gp-btn-circle" class="gp-btn" cx="305" cy="105" r="10"/>
            <circle id="gp-btn-cross" class="gp-btn" cx="285" cy="125" r="10"/>
            <circle id="gp-btn-square" class="gp-btn" cx="265" cy="105" r="10"/>

            <!-- Symboles des boutons face -->
            <text x="285" y="89" text-anchor="middle" fill="#8f8" font-size="10" pointer-events="none">△</text>
            <text x="305" y="109" text-anchor="middle" fill="#f88" font-size="10" pointer-events="none">○</text>
            <text x="285" y="129" text-anchor="middle" fill="#88f" font-size="10" pointer-events="none">✕</text>
            <text x="265" y="109" text-anchor="middle" fill="#f8f" font-size="10" pointer-events="none">□</text>

            <!-- Bumpers L1/R1 -->
            <rect id="gp-btn-l1" class="gp-btn" x="100" y="50" width="55" height="14" rx="7"/>
            <rect id="gp-btn-r1" class="gp-btn" x="245" y="50" width="55" height="14" rx="7"/>
            <text x="127" y="60" text-anchor="middle" fill="var(--text-secondary)" font-size="8" pointer-events="none">L1</text>
            <text x="272" y="60" text-anchor="middle" fill="var(--text-secondary)" font-size="8" pointer-events="none">R1</text>

            <!-- Gâchettes L2/R2 -->
            <rect id="gp-btn-l2" class="gp-btn" x="105" y="32" width="45" height="12" rx="6"/>
            <rect id="gp-btn-r2" class="gp-btn" x="250" y="32" width="45" height="12" rx="6"/>
            <text x="127" y="41" text-anchor="middle" fill="var(--text-secondary)" font-size="7" pointer-events="none">L2</text>
            <text x="272" y="41" text-anchor="middle" fill="var(--text-secondary)" font-size="7" pointer-events="none">R2</text>

            <!-- Barres de gâchettes (remplissage) -->
            <rect x="108" y="26" width="39" height="4" rx="2" fill="#222" stroke="#444" stroke-width="0.5"/>
            <rect id="gp-trigger-l2" x="108" y="26" width="0" height="4" rx="2" fill="#00ff88"/>
            <rect x="253" y="26" width="39" height="4" rx="2" fill="#222" stroke="#444" stroke-width="0.5"/>
            <rect id="gp-trigger-r2" x="253" y="26" width="0" height="4" rx="2" fill="#00ff88"/>

            <!-- Boutons centraux -->
            <rect id="gp-btn-share" class="gp-btn" x="165" y="75" width="24" height="10" rx="5"/>
            <rect id="gp-btn-options" class="gp-btn" x="211" y="75" width="24" height="10" rx="5"/>
            <circle id="gp-btn-ps" class="gp-btn" cx="200" cy="105" r="9"/>
            <rect id="gp-btn-touchpad" class="gp-btn" x="175" y="58" width="50" height="12" rx="4"/>

            <!-- Labels centraux -->
            <text x="177" y="83" fill="var(--text-secondary)" font-size="6" pointer-events="none">SHARE</text>
            <text x="215" y="83" fill="var(--text-secondary)" font-size="6" pointer-events="none">OPT</text>
            <text x="200" y="108" text-anchor="middle" fill="var(--text-secondary)" font-size="6" pointer-events="none">PS</text>

            <!-- L3/R3 (clic sticks) — indicateurs invisibles -->
            <circle id="gp-btn-l3" class="gp-btn" cx="155" cy="160" r="6" fill="transparent" stroke="transparent"/>
            <circle id="gp-btn-r3" class="gp-btn" cx="245" cy="160" r="6" fill="transparent" stroke="transparent"/>
        </svg>`;
    }

    // ==========================================================
    // MISE À JOUR DES ÉLÉMENTS
    // ==========================================================
    function updateButton(name, pressed) {
        const el = document.getElementById('gp-btn-' + name);
        if (!el) return;
        if (pressed) {
            el.classList.add('pressed');
        } else {
            el.classList.remove('pressed');
        }
    }

    function updateAxis(name, x, y) {
        const el = document.getElementById('gp-stick-' + name);
        if (!el) return;
        // Borner le déplacement à ±10px
        const dx = Math.max(-10, Math.min(10, x * 10));
        const dy = Math.max(-10, Math.min(10, y * 10));
        const cx = parseFloat(el.getAttribute('cx')) || 0;
        const cy = parseFloat(el.getAttribute('cy')) || 0;
        // On récupère la position de base
        const baseCx = name === 'left' ? 155 : 245;
        const baseCy = 160;
        el.setAttribute('cx', baseCx + dx);
        el.setAttribute('cy', baseCy + dy);
    }

    function updateTrigger(name, value) {
        // value: 0 à 1
        const el = document.getElementById('gp-trigger-' + name);
        if (!el) return;
        const maxWidth = 39;
        const width = Math.max(0, Math.min(maxWidth, value * maxWidth));
        el.setAttribute('width', width);
    }

    function highlightElement(name) {
        // Retirer les highlights précédents
        if (svgContainer) {
            svgContainer.querySelectorAll('.gp-btn.highlight').forEach(el => {
                el.classList.remove('highlight');
            });
        }

        // Map des noms de touches vers les IDs SVG
        const idMap = {
            'CROSS': 'gp-btn-cross', 'CIRCLE': 'gp-btn-circle',
            'SQUARE': 'gp-btn-square', 'TRIANGLE': 'gp-btn-triangle',
            'L1': 'gp-btn-l1', 'R1': 'gp-btn-r1',
            'L2': 'gp-btn-l2', 'R2': 'gp-btn-r2',
            'L3': 'gp-btn-l3', 'R3': 'gp-btn-r3',
            'SHARE': 'gp-btn-share', 'OPTIONS': 'gp-btn-options',
            'PS': 'gp-btn-ps', 'TOUCHPAD': 'gp-btn-touchpad',
            'DPAD_UP': 'gp-dpad-up', 'DPAD_DOWN': 'gp-dpad-down',
            'DPAD_LEFT': 'gp-dpad-left', 'DPAD_RIGHT': 'gp-dpad-right'
        };

        const elId = idMap[name];
        if (elId) {
            const el = document.getElementById(elId);
            if (el) el.classList.add('highlight');
        }

        // Auto-suppression après 1.5s
        setTimeout(() => {
            if (elId) {
                const el = document.getElementById(elId);
                if (el) el.classList.remove('highlight');
            }
        }, 1500);
    }

    function setMapping(mapping) {
        currentMapping = mapping;
        // Ajouter les tooltips avec la fonction assignée
        if (!mapping) return;

        const idMap = {
            'CROSS': 'gp-btn-cross', 'CIRCLE': 'gp-btn-circle',
            'SQUARE': 'gp-btn-square', 'TRIANGLE': 'gp-btn-triangle',
            'L1': 'gp-btn-l1', 'R1': 'gp-btn-r1',
            'L2': 'gp-btn-l2', 'R2': 'gp-btn-r2',
            'L3': 'gp-btn-l3', 'R3': 'gp-btn-r3',
            'SHARE': 'gp-btn-share', 'OPTIONS': 'gp-btn-options',
            'PS': 'gp-btn-ps', 'TOUCHPAD': 'gp-btn-touchpad',
            'DPAD_UP': 'gp-dpad-up', 'DPAD_DOWN': 'gp-dpad-down',
            'DPAD_LEFT': 'gp-dpad-left', 'DPAD_RIGHT': 'gp-dpad-right'
        };

        if (mapping.buttons) {
            Object.entries(mapping.buttons).forEach(([key, cfg]) => {
                const elId = idMap[key];
                if (elId) {
                    const el = document.getElementById(elId);
                    if (el) {
                        // Supprimer l'ancien title
                        el.removeAttribute('title');
                        if (cfg.function) {
                            const titleEl = document.createElementNS('http://www.w3.org/2000/svg', 'title');
                            titleEl.textContent = `${key}: ${cfg.function}`;
                            // Supprimer l'ancien <title>
                            const existing = el.querySelector('title');
                            if (existing) existing.remove();
                            el.appendChild(titleEl);
                        }
                    }
                }
            });
        }
    }

    function updateFromGamepadState(gamepad) {
        if (!gamepad) return;

        // Throttle à 25Hz
        const now = performance.now();
        if (now - lastUpdate < UPDATE_INTERVAL) return;
        lastUpdate = now;

        // Boutons standard DualShock 4
        const buttonNames = [
            'cross', 'circle', 'square', 'triangle',
            'l1', 'r1', 'l2', 'r2',
            'share', 'options', 'l3', 'r3'
        ];

        buttonNames.forEach((name, idx) => {
            if (idx < gamepad.buttons.length) {
                updateButton(name, gamepad.buttons[idx].pressed);
            }
        });

        // D-Pad (boutons 12-15)
        const dpadNames = ['dpad-up', 'dpad-down', 'dpad-left', 'dpad-right'];
        dpadNames.forEach((name, i) => {
            const idx = 12 + i;
            if (idx < gamepad.buttons.length) {
                const el = document.getElementById('gp-' + name);
                if (el) {
                    if (gamepad.buttons[idx].pressed) {
                        el.classList.add('pressed');
                    } else {
                        el.classList.remove('pressed');
                    }
                }
            }
        });

        // PS (16), Touchpad (17)
        if (gamepad.buttons.length > 16) {
            updateButton('ps', gamepad.buttons[16].pressed);
        }
        if (gamepad.buttons.length > 17) {
            updateButton('touchpad', gamepad.buttons[17].pressed);
        }

        // Axes : sticks
        if (gamepad.axes.length >= 2) {
            updateAxis('left', gamepad.axes[0], gamepad.axes[1]);
        }
        if (gamepad.axes.length >= 4) {
            updateAxis('right', gamepad.axes[2], gamepad.axes[3]);
        }

        // Gâchettes (axes 4 et 5, ou boutons L2/R2 value)
        if (gamepad.buttons.length > 6) {
            updateTrigger('l2', gamepad.buttons[6].value);
        }
        if (gamepad.buttons.length > 7) {
            updateTrigger('r2', gamepad.buttons[7].value);
        }
    }

    return { init, updateButton, updateAxis, updateTrigger, highlightElement, setMapping, updateFromGamepadState };
})();
