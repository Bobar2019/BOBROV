/**
 * BOB-ROV — Module de Navigation UI par Manette
 * Gère la navigation dans l'interface (grille de tuiles, menus)
 * via le D-Pad / stick gauche de la manette PlayStation.
 *
 * Séparé de gamepad.js pour éviter les conflits avec les commandes de mouvement.
 */
'use strict';

const GamepadNav = (() => {

    // ==========================================================
    // ÉTAT INTERNE
    // ==========================================================

    let enabled = false;
    let currentMode = 'home'; // 'home' (grille), 'tile' (dans un panneau), 'menu' (context menu), 'goggle'
    let selectedIndex = 0;
    let menuSelectedIndex = 0;
    let contextMenuOpen = false;
    let lastNavTime = 0;
    const NAV_COOLDOWN = 200; // ms entre chaque déplacement (anti-repeat)

    // Tuiles dans l'ordre de la grille
    const TILES = ['dashboard', 'cockpit', 'config-osd', 'config-cam', 'galerie', 'simulation', 'config-manette', 'mapping3d', 'config-scene-3d', 'subsim'];
    const GRID_COLS = 4; // colonnes en desktop

    // Éléments du menu contextuel (Triangle)
    const MENU_ITEMS = [
        { label: '🎮 Profil manette', action: 'profile', getValue: () => getCurrentProfile() },
        { label: '🌙 Mode Nuit', action: 'night', getValue: () => getNightStatus() },
        { label: '⛶ Plein écran', action: 'fullscreen', getValue: () => document.fullscreenElement ? 'ON' : 'OFF' },
        { label: '🥽 Mode Lunette', action: 'goggle', getValue: () => (typeof Goggle !== 'undefined' && Goggle.isActive()) ? 'ON' : 'OFF' },
        { label: '❓ Aide', action: 'help', getValue: () => '' },
    ];

    // État précédent des boutons (détection front montant)
    let prevButtonStates = {};

    // ==========================================================
    // INITIALISATION
    // ==========================================================

    function init() {
        updateNavBar();
        console.log('[GamepadNav] Module de navigation UI initialisé');
    }

    // ==========================================================
    // BOUCLE PRINCIPALE DE NAVIGATION
    // ==========================================================

    /**
     * Appelé à chaque frame du polling gamepad (depuis gamepad.js)
     * @param {Gamepad} gp - L'objet Gamepad natif
     */
    function processNavigation(gp) {
        if (!gp || !enabled) return;

        const now = performance.now();

        // Lire les inputs de navigation (D-Pad)
        const dpadUp = gp.buttons[12] && gp.buttons[12].pressed;
        const dpadDown = gp.buttons[13] && gp.buttons[13].pressed;
        const dpadLeft = gp.buttons[14] && gp.buttons[14].pressed;
        const dpadRight = gp.buttons[15] && gp.buttons[15].pressed;

        // Stick gauche comme alternative au D-Pad
        const stickX = Math.abs(gp.axes[0]) > 0.5 ? Math.sign(gp.axes[0]) : 0;
        const stickY = Math.abs(gp.axes[1]) > 0.5 ? Math.sign(gp.axes[1]) : 0;

        const moveUp = dpadUp || stickY < 0;
        const moveDown = dpadDown || stickY > 0;
        const moveLeft = dpadLeft || stickX < 0;
        const moveRight = dpadRight || stickX > 0;

        // Boutons d'action (front montant uniquement)
        const crossPressed = isButtonJustPressed(gp, 0);   // ✕ = Sélection
        const circlePressed = isButtonJustPressed(gp, 1);  // ● = Retour
        const trianglePressed = isButtonJustPressed(gp, 3); // △ = Menu contextuel

        // Cooldown sur les mouvements directionnels
        const canMove = (now - lastNavTime >= NAV_COOLDOWN);

        if (contextMenuOpen) {
            if (canMove) handleMenuNav(moveUp, moveDown, crossPressed, circlePressed);
        } else if (currentMode === 'home') {
            if (canMove) handleHomeNav(moveUp, moveDown, moveLeft, moveRight, crossPressed, trianglePressed);
        } else if (currentMode === 'tile') {
            // Dans un panneau : Circle = retour accueil, Triangle = menu
            if (circlePressed) {
                App.goHome();
                currentMode = 'home';
                updateSelection();
            }
            if (trianglePressed) openContextMenu();
        }

        // Marquer le temps si un mouvement directionnel a eu lieu
        if (moveUp || moveDown || moveLeft || moveRight) {
            if (canMove) lastNavTime = now;
        }
    }

    // ==========================================================
    // NAVIGATION GRILLE D'ACCUEIL
    // ==========================================================

    function handleHomeNav(up, down, left, right, select, menu) {
        let moved = false;

        if (right) { selectedIndex = Math.min(selectedIndex + 1, TILES.length - 1); moved = true; }
        if (left) { selectedIndex = Math.max(selectedIndex - 1, 0); moved = true; }
        if (down) { selectedIndex = Math.min(selectedIndex + GRID_COLS, TILES.length - 1); moved = true; }
        if (up) { selectedIndex = Math.max(selectedIndex - GRID_COLS, 0); moved = true; }

        if (moved) updateSelection();

        if (select) {
            // Activer la tuile sélectionnée
            const tileId = TILES[selectedIndex];
            App.switchTile(tileId);
            currentMode = 'tile';
            clearSelection();
        }

        if (menu) openContextMenu();
    }

    // ==========================================================
    // NAVIGATION MENU CONTEXTUEL
    // ==========================================================

    function handleMenuNav(up, down, select, back) {
        if (up) { menuSelectedIndex = Math.max(menuSelectedIndex - 1, 0); updateMenuSelection(); }
        if (down) { menuSelectedIndex = Math.min(menuSelectedIndex + 1, MENU_ITEMS.length - 1); updateMenuSelection(); }
        if (select) { executeMenuItem(MENU_ITEMS[menuSelectedIndex]); }
        if (back) { closeContextMenu(); }
    }

    // ==========================================================
    // SÉLECTION VISUELLE DES TUILES
    // ==========================================================

    function updateSelection() {
        // Supprimer toutes les sélections précédentes
        document.querySelectorAll('.nav-tile.gp-selected').forEach(el => el.classList.remove('gp-selected'));
        // Sélectionner la tuile actuelle
        const tiles = document.querySelectorAll('.nav-tile');
        if (tiles[selectedIndex]) {
            tiles[selectedIndex].classList.add('gp-selected');
        }
    }

    function clearSelection() {
        document.querySelectorAll('.nav-tile.gp-selected').forEach(el => el.classList.remove('gp-selected'));
    }

    // ==========================================================
    // MENU CONTEXTUEL (TRIANGLE)
    // ==========================================================

    function openContextMenu() {
        contextMenuOpen = true;
        menuSelectedIndex = 0;
        const menu = document.getElementById('gamepad-context-menu');
        if (!menu) return;

        // Générer le contenu du menu
        let html = '<div class="ctx-title">△ Menu rapide</div>';
        MENU_ITEMS.forEach((item, i) => {
            const cls = i === 0 ? 'ctx-item gp-selected' : 'ctx-item';
            const val = item.getValue();
            html += `<div class="${cls}" data-index="${i}" onclick="GamepadNav.executeMenuByIndex(${i})">
                <span>${item.label}</span>
                <span class="ctx-value">${val}</span>
            </div>`;
        });
        menu.innerHTML = html;
        menu.classList.add('visible');
    }

    function closeContextMenu() {
        contextMenuOpen = false;
        const menu = document.getElementById('gamepad-context-menu');
        if (menu) menu.classList.remove('visible');
    }

    function updateMenuSelection() {
        const menu = document.getElementById('gamepad-context-menu');
        if (!menu) return;
        menu.querySelectorAll('.ctx-item').forEach((el, i) => {
            el.classList.toggle('gp-selected', i === menuSelectedIndex);
        });
    }

    function executeMenuItem(item) {
        switch (item.action) {
            case 'profile':
                cycleProfile();
                break;
            case 'night':
                if (typeof App !== 'undefined') App.setTheme(document.body.classList.contains('theme-night') ? 'day' : 'night');
                break;
            case 'fullscreen':
                if (!document.fullscreenElement) document.documentElement.requestFullscreen();
                else document.exitFullscreen();
                break;
            case 'goggle':
                if (typeof Goggle !== 'undefined') {
                    if (Goggle.isActive()) Goggle.deactivate();
                    else Goggle.activate();
                }
                closeContextMenu();
                return; // Pas de rafraîchissement du menu
            case 'help':
                showHelp();
                break;
        }
        // Rafraîchir les valeurs du menu après action
        setTimeout(() => { if (contextMenuOpen) openContextMenu(); }, 150);
    }

    function executeMenuByIndex(index) {
        if (MENU_ITEMS[index]) executeMenuItem(MENU_ITEMS[index]);
    }

    // ==========================================================
    // UTILITAIRES
    // ==========================================================

    /**
     * Cycle entre les profils de manette disponibles
     */
    async function cycleProfile() {
        try {
            const resp = await fetch('/api/gamepad/profiles');
            const data = await resp.json();
            const profiles = data.data || data.profiles;
            if (profiles && profiles.length > 0) {
                const names = profiles.map(p => p.name);
                const current = getCurrentProfile();
                const idx = names.indexOf(current);
                const next = names[(idx + 1) % names.length];
                await fetch('/api/gamepad/active', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: next })
                });
                if (typeof App !== 'undefined') App.showNotification(`🎮 Profil: ${next}`);
                // Recharger le mapping après changement de profil
                if (typeof Gamepad !== 'undefined') Gamepad.reloadMapping();
            }
        } catch (e) {
            console.warn('[GamepadNav] Erreur cycle profil:', e);
        }
    }

    function getCurrentProfile() {
        // Lire depuis le select de profil si disponible
        const select = document.getElementById('gp-profile-select');
        if (select && select.value) return select.value;
        return 'Standard';
    }

    function getNightStatus() {
        return document.body.classList.contains('theme-night') ? 'Nuit' : 'Jour';
    }

    function showHelp() {
        if (typeof App !== 'undefined') {
            App.showNotification('🎮 D-Pad: naviguer | ✕: sélectionner | ●: retour | △: menu');
        }
    }

    /**
     * Détection front montant d'un bouton
     */
    function isButtonJustPressed(gp, index) {
        if (index >= gp.buttons.length) return false;
        const pressed = gp.buttons[index].pressed;
        const wasPressed = prevButtonStates[index] || false;
        prevButtonStates[index] = pressed;
        return pressed && !wasPressed;
    }

    /**
     * Met à jour la barre de navigation (afficher/masquer selon connexion manette)
     */
    function updateNavBar() {
        const bar = document.getElementById('gamepad-nav-bar');
        if (bar) {
            const isConnected = typeof Gamepad !== 'undefined' && Gamepad.isConnected();
            bar.classList.toggle('visible', isConnected);
        }
    }

    /**
     * Active ou désactive la navigation par manette
     */
    function setEnabled(val) {
        enabled = val;
        updateNavBar();
        if (!val) {
            clearSelection();
            closeContextMenu();
        } else {
            // Déterminer le mode courant
            if (typeof App !== 'undefined' && App.activeTile()) {
                currentMode = 'tile';
            } else {
                currentMode = 'home';
                updateSelection();
            }
        }
    }

    /**
     * Callback quand on revient à l'accueil
     */
    function onGoHome() {
        currentMode = 'home';
        closeContextMenu();
        updateSelection();
    }

    // ==========================================================
    // API PUBLIQUE
    // ==========================================================

    return {
        init,
        processNavigation,
        setEnabled,
        onGoHome,
        executeMenuByIndex,
        isMenuOpen: () => contextMenuOpen,
    };

})();
