/**
 * Cockpit-Lite ROV — Module Gamepad
 * Module gamepad.js : support manette de jeu via HTML5 Gamepad API
 *
 * Utilise le profil actif (chargé depuis le serveur) pour mapper
 * les boutons/axes aux fonctions ROV via le dispatcher d'actions.
 *
 * Deux modes :
 *   - Mode ROV (défaut) : boutons → actions ROV, axes → mouvement
 *   - Mode UI  : boutons → navigation interface (GamepadNav)
 *   Basculement : appui long (1s) sur TOUCHPAD
 */

'use strict';

const Gamepad = (() => {

    // ==========================================================
    // ÉTAT INTERNE
    // ==========================================================

    let gamepadIndex = null;
    let connected = false;
    let pollTimer = null;
    let armed = false;

    // Niveau de batterie manette (null si indisponible, sinon 0–100)
    let _batteryLevel = null;

    // Failsafe : surveillance de la connexion manette
    let _failsafe = false;                // true = manette perdue, alerte active
    let _watchdogTimer = null;            // identifiant setInterval watchdog
    let _lastPollTimestamp = 0;           // horodatage du dernier poll valide
    const WATCHDOG_INTERVAL_MS = 1000;    // vérification toutes les secondes
    const WATCHDOG_TIMEOUT_MS = 2000;     // seuil d'alerte (2 s sans poll valide)

    // Mode de contrôle : 'rov' ou 'ui'
    let controlMode = 'rov';

    // Seuil de zone morte pour les sticks
    const DEADZONE = 0.12;

    // État précédent des boutons (pour détecter press/release)
    let prevButtons = {};

    // Mapping des boutons SIMPLES depuis le profil actif
    // Format: { 0: { function: 'photo', action: 'press' }, ... }
    let buttonFunctionMap = {};

    // Mapping des COMBOS de boutons (clé profil "L1+CROSS")
    // Format: [{ key: 'L1+CROSS', indices: [4, 0], function, action }] triés par taille décroissante
    let comboBindings = [];
    // Indices membres d'au moins un combo : leurs appuis simples sont différés
    let comboMemberIndices = new Set();
    // Délai de grâce avant de valider une touche simple membre d'un combo
    // (laisse le temps à la 2e touche du combo d'arriver)
    const COMBO_GRACE_MS = 250;
    let prevComboActive = {};   // key combo -> bool (front montant)
    let pendingSingle = {};     // idx -> timestamp d'appui différé

    // Mapping des axes depuis le profil actif
    // Format: { 0: { function: 'turn', invert: false, deadzone: null, sensitivity: null }, ... }
    let axisFunctionMap = {};

    // Paramètres du profil actif
    let profileSettings = {
        deadzone: 12,
        sensitivity: 100,
        response_curve: 'linear'
    };

    // Long press TOUCHPAD
    const LONG_PRESS_MS = 1000;
    let touchpadDownTime = 0;
    let touchpadLongPressFired = false;

    // Rechargement périodique du mapping (toutes les 5s)
    let _mappingReloadTimer = null;
    const MAPPING_RELOAD_INTERVAL = 5000;

    // Clé localStorage écrite par la page de configuration (gamepad_config.js).
    // Lecture prioritaire : le mapping est consommé immédiatement sans requête réseau.
    const LS_MAPPING_KEY = 'rov.gamepad.mapping';

    // Polling de détection automatique (fallback si gamepadconnected non déclenché)
    let _autoDetectTimer = null;
    const AUTO_DETECT_INTERVAL = 1000; // 1s
    let _autoDetectAttempts = 0;
    const AUTO_DETECT_MAX_ATTEMPTS = 60; // arrêter après 60s sans résultat

    // ==========================================================
    // MODE TEST MANETTE — pilote le Rov3D OSD avec les sticks
    // ==========================================================
    let _testMode = false;
    let _testRoll = 0, _testPitch = 0, _testYaw = 0, _testY = 0, _testZ = 0;
    const TEST_LERP = 0.08;           // facteur de lissage (0=inertie max, 1=instantané)
    const TEST_DEADZONE = 0.15;       // zone morte sticks mode test
    const TEST_MAX_ANGLE = 45;        // amplitude max pitch/roll en degrés
    const TEST_YAW_SPEED = 90;        // vitesse max yaw en °/s
    const TEST_MAX_HEAVE = 0.5;       // translation verticale max (unités Three.js)
    const TEST_HEAVE_SPEED = 1.5;     // vitesse max heave en unités/s
    const TEST_MAX_SURGE = 1.0;       // translation avant/arrière max
    const TEST_SURGE_SPEED = 2.0;     // vitesse max surge en unités/s

    // ==========================================================
    // Lecture unifiée d'un degré de liberté (axes + boutons)
    // Se base sur le profil actif : axisFunctionMap ET buttonFunctionMap.
    // ==========================================================
    function _readDofInput(gp, dofName) {
        // Alias de fonctions par degré de liberté (axes ET boutons)
        const DOF_FUNCS = {
            yaw:   { axis: ['yaw', 'turn', 'heading', 'rotate'],
                     pos:  ['turn_right', 'yaw_right'],
                     neg:  ['turn_left', 'yaw_left'] },
            pitch: { axis: ['pitch', 'surge', 'forward', 'forward_backward',
                            'move_forward', 'move_backward'],
                     pos:  ['pitch_up', 'move_forward', 'surge_fwd'],
                     neg:  ['pitch_down', 'move_backward', 'surge_bwd'] },
            roll:  { axis: ['roll'],
                     pos:  ['roll_right'],
                     neg:  ['roll_left'] },
            heave: { axis: ['heave', 'vertical', 'move_up', 'move_down', 'depth', 'up_down'],
                     pos:  ['move_up', 'ascent', 'heave_up'],
                     neg:  ['move_down', 'descent', 'heave_down'] },
            surge: { axis: ['surge', 'forward', 'forward_backward',
                            'move_forward', 'move_backward'],
                     pos:  ['move_forward', 'surge_fwd'],
                     neg:  ['move_backward', 'surge_bwd'] }
        };
        const cfg = DOF_FUNCS[dofName];
        if (!cfg) return 0;

        let val = 0;

        // 1. Axes : chercher dans axisFunctionMap
        for (const [idxStr, mapping] of Object.entries(axisFunctionMap)) {
            if (!cfg.axis.includes(mapping.function)) continue;
            const idx = parseInt(idxStr);
            if (idx >= gp.axes.length) continue;
            let v = gp.axes[idx] || 0;
            if (mapping.invert) v = -v;
            if (Math.abs(v) < TEST_DEADZONE) v = 0;
            val = v;
            break;
        }

        // 2. Boutons : chercher dans buttonFunctionMap (DPAD, L1/R1, etc.)
        let btnVal = 0;
        for (const [idxStr, bCfg] of Object.entries(buttonFunctionMap)) {
            if (!bCfg || !bCfg.function) continue;
            const idx = parseInt(idxStr);
            if (idx >= gp.buttons.length || !gp.buttons[idx].pressed) continue;
            if (cfg.pos.includes(bCfg.function)) btnVal += 1;
            else if (cfg.neg.includes(bCfg.function)) btnVal -= 1;
        }
        // Les boutons ont priorité sur les axes (entrée explicite utilisateur)
        if (btnVal !== 0) val = btnVal;

        return Math.max(-1, Math.min(1, val));
    }

    // Noms des boutons par index (standard gamepad)
    const INDEX_TO_BUTTON_NAME = {
        0: 'CROSS', 1: 'CIRCLE', 2: 'SQUARE', 3: 'TRIANGLE',
        4: 'L1', 5: 'R1', 6: 'L2', 7: 'R2',
        8: 'SHARE', 9: 'OPTIONS', 10: 'L3', 11: 'R3',
        12: 'DPAD_UP', 13: 'DPAD_DOWN', 14: 'DPAD_LEFT', 15: 'DPAD_RIGHT',
        16: 'PS', 17: 'TOUCHPAD'
    };

    const INDEX_TO_AXIS_NAME = {
        0: 'LEFT_X', 1: 'LEFT_Y', 2: 'RIGHT_X', 3: 'RIGHT_Y',
        4: 'L2', 5: 'R2'
    };

    // ==========================================================
    // GESTION DES CONNEXIONS
    // ==========================================================

    function init() {
        window.addEventListener('gamepadconnected', onGamepadConnected);
        window.addEventListener('gamepaddisconnected', onGamepadDisconnected);
        console.log('[Gamepad] En attente de manette...');
        loadActiveProfile();
        // Recharger le mapping périodiquement pour suivre les changements
        if (_mappingReloadTimer) clearInterval(_mappingReloadTimer);
        _mappingReloadTimer = setInterval(loadActiveProfile, MAPPING_RELOAD_INTERVAL);

        // Rechargement immédiat quand la page de config sauvegarde le mapping
        // (même page : événement custom ; autre onglet : événement storage)
        window.addEventListener('gamepad-mapping-changed', loadActiveProfile);
        window.addEventListener('storage', (e) => {
            if (e.key === LS_MAPPING_KEY) loadActiveProfile();
        });

        // Scan immédiat au montage : détecter les manettes déjà branchées
        // (le navigateur ne déclenche pas toujours gamepadconnected si la
        // manette était branchée avant le chargement de la page)
        setTimeout(() => {
            scanForGamepads();
            // Lancer le polling de détection automatique en fallback
            startAutoDetect();
        }, 100);

        // Démarrer le watchdog failsafe
        _startWatchdog();
    }

    // ----------------------------------------------------------
    // SCAN ACTIF — interroge navigator.getGamepads() directement
    // pour détecter les manettes déjà connectées sans événement.
    // ----------------------------------------------------------
    function scanForGamepads() {
        if (connected) return; // déjà connectée, rien à faire

        try {
            const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
            for (let i = 0; i < gamepads.length; i++) {
                const gp = gamepads[i];
                if (gp) {
                    console.log(`[Gamepad] Détecté au scan: "${gp.id}" (index ${gp.index})`);
                    // Simuler manuellement une connexion
                    gamepadIndex = gp.index;
                    connected = true;
                    updateStatusUI(true, gp.id);
                    loadActiveProfile();
                    startPolling();
                    if (typeof GamepadNav !== 'undefined') GamepadNav.setEnabled(false);
                    // Arrêter le polling auto-détection (manette trouvée)
                    stopAutoDetect();
                    return true;
                }
            }
        } catch (e) {
            // navigator.getGamepads() peut échouer si la page n'a pas le focus
        }
        return false;
    }

    // ----------------------------------------------------------
    // POLLING AUTO-DÉTECTION (fallback continu)
    // Tente scanForGamepads() toutes les secondes en permanence
    // pour attraper les manettes connectées à tout moment.
    // S'arrête dès qu'une manette est trouvée, redémarre à
    // chaque déconnexion ou activation du Cockpit.
    // ----------------------------------------------------------
    function startAutoDetect() {
        if (_autoDetectTimer) return;
        _autoDetectTimer = setInterval(() => {
            if (connected) {
                stopAutoDetect();
                return;
            }
            scanForGamepads();
        }, AUTO_DETECT_INTERVAL);
    }

    function stopAutoDetect() {
        if (_autoDetectTimer) {
            clearInterval(_autoDetectTimer);
            _autoDetectTimer = null;
        }
    }

    // ----------------------------------------------------------
    // APPELÉ PAR APP.JS quand l'onglet Cockpit est activé.
    // Force un nouveau scan + relance l'auto-détection si besoin.
    // ----------------------------------------------------------
    function onCockpitActivate() {
        console.log('[Gamepad] Activation Cockpit — scan immédiat');
        loadActiveProfile();
        if (!connected) {
            scanForGamepads();
            if (!connected) startAutoDetect();
        } else {
            startPolling();
        }
        // Attacher le listener Test manette
        const cb = document.getElementById('cfg-test-gamepad');
        if (cb) {
            cb.onchange = () => setTestMode(cb.checked);
            // Synchroniser l'état si la checkbox était déjà cochée
            if (cb.checked && !_testMode) setTestMode(true);
        }
    }

    // ==========================================================
    // MODE TEST MANETTE — implémentation
    // ==========================================================
    function _processTestMode(gp) {
        // === YAW (rotation continue, accumulateur) ===
        const yawInput = _readDofInput(gp, 'yaw');
        _testYaw += yawInput * TEST_YAW_SPEED / 60;
        if (_testYaw > 180) _testYaw -= 360;
        if (_testYaw < -180) _testYaw += 360;

        // === PITCH (lerp vers cible) ===
        const pitchInput = _readDofInput(gp, 'pitch');
        const pitchTarget = pitchInput * TEST_MAX_ANGLE;
        _testPitch += (pitchTarget - _testPitch) * TEST_LERP;

        // === ROLL (lerp vers cible) ===
        const rollInput = _readDofInput(gp, 'roll');
        const rollTarget = rollInput * TEST_MAX_ANGLE;
        _testRoll += (rollTarget - _testRoll) * TEST_LERP;

        // === HEAVE — translation verticale (accumulateur borné + decay) ===
        const heaveInput = _readDofInput(gp, 'heave');
        _testY += heaveInput * TEST_HEAVE_SPEED / 60;
        _testY = Math.max(-TEST_MAX_HEAVE, Math.min(TEST_MAX_HEAVE, _testY));
        if (Math.abs(heaveInput) < 0.05) {
            _testY *= 0.97;
            if (Math.abs(_testY) < 0.005) _testY = 0;
        }

        // === SURGE — translation avant/arrière (accumulateur borné + decay) ===
        const surgeInput = _readDofInput(gp, 'surge');
        _testZ -= surgeInput * TEST_SURGE_SPEED / 60;  // -Z = avant en Three.js
        _testZ = Math.max(-TEST_MAX_SURGE, Math.min(TEST_MAX_SURGE, _testZ));
        if (Math.abs(surgeInput) < 0.05) {
            _testZ *= 0.97;
            if (Math.abs(_testZ) < 0.005) _testZ = 0;
        }
        if (Math.abs(_testZ) > 0.01) {
            console.log(`[Gamepad Test] surge: input=${surgeInput.toFixed(2)} z=${_testZ.toFixed(3)}`);
        }

        // === Envoi au module Rov3D ===
        if (typeof Rov3D !== 'undefined') {
            if (Rov3D.updateAttitude) {
                // Convention telemetry.js : updateAttitude(rollDeg=pitch, pitchDeg=roll, yawDeg=yaw)
                Rov3D.updateAttitude(_testPitch, _testRoll, _testYaw);
            }
            if (Rov3D.setHeaveOffset) {
                Rov3D.setHeaveOffset(_testY);
            }
            if (Rov3D.setSurgeOffset) {
                Rov3D.setSurgeOffset(_testZ);
            }
        }
    }

    function setTestMode(enabled) {
        _testMode = enabled;
        if (!enabled) {
            _testRoll = 0;
            _testPitch = 0;
            _testYaw = 0;
            _testY = 0;
            _testZ = 0;
            if (typeof Rov3D !== 'undefined') {
                if (Rov3D.setHeaveOffset) Rov3D.setHeaveOffset(0);
                if (Rov3D.setSurgeOffset) Rov3D.setSurgeOffset(0);
            }
        }
        console.log(`[Gamepad] Mode test manette: ${enabled ? 'ACTIVÉ' : 'désactivé'}`);
    }

    function isTestMode() {
        return _testMode;
    }

    function onGamepadConnected(event) {
        const gp = event.gamepad;
        gamepadIndex = gp.index;
        connected = true;
        console.log(`[Gamepad] Connecté: "${gp.id}" (${gp.axes.length} axes, ${gp.buttons.length} boutons)`);

        // === Failsafe : désactiver si actif ===
        if (_failsafe) {
            _deactivateFailsafe();
        }

        updateStatusUI(true, gp.id);
        // Recharger le mapping à chaque connexion (au cas où il a changé)
        loadActiveProfile();
        startPolling();

        // Arrêter l'auto-détection (manette trouvée via l'événement natif)
        stopAutoDetect();

        // Mode ROV par défaut — GamepadNav désactivé
        if (typeof GamepadNav !== 'undefined') GamepadNav.setEnabled(false);
    }

    function onGamepadDisconnected(event) {
        console.log(`[Gamepad] Déconnecté: "${event.gamepad.id}"`);
        gamepadIndex = null;
        connected = false;
        _batteryLevel = null;

        // === Failsafe : activer immédiatement ===
        _activateFailsafe('gamepaddisconnected');

        updateStatusUI(false, '');
        stopPolling();

        if (typeof GamepadNav !== 'undefined') GamepadNav.setEnabled(false);

        // Relancer l'auto-détection pour reconnecter automatiquement
        // si la manette est rebranchée
        startAutoDetect();
    }

    // ==========================================================
    // POLLING
    // ==========================================================

    function startPolling() {
        if (pollTimer) return;
        pollTimer = requestAnimationFrame(pollLoop);
    }

    function stopPolling() {
        if (pollTimer) {
            cancelAnimationFrame(pollTimer);
            pollTimer = null;
        }
    }

    function pollLoop() {
        if (!connected) return;

        // Horodatage du dernier poll valide (pour le watchdog failsafe)
        _lastPollTimestamp = performance.now();

        const gamepads = navigator.getGamepads();
        const gp = gamepads[gamepadIndex];

        if (!gp) {
            connected = false;
            _batteryLevel = null;
            updateStatusUI(false, '');
            stopPolling();
            return;
        }

        // Lecture batterie manette (si supportée par le navigateur/manette)
        _batteryLevel = _readBattery(gp);

        // Détection long press TOUCHPAD (toujours actif, quel que soit le mode)
        processTouchpadLongPress(gp);

        // Mode UI : navigation interface uniquement
        if (controlMode === 'ui') {
            if (typeof GamepadNav !== 'undefined') {
                GamepadNav.processNavigation(gp);
            }
            for (let i = 0; i < gp.buttons.length; i++) {
                prevButtons[i] = gp.buttons[i].pressed;
            }
            pollTimer = requestAnimationFrame(pollLoop);
            return;
        }

        // Mode Test manette : pilotage Rov3D OSD par les sticks
        if (_testMode) {
            _processTestMode(gp);
            pollTimer = requestAnimationFrame(pollLoop);
            return;
        }

        // Mode ROV : contrôle du ROV
        processAxes(gp);
        processButtons(gp);

        pollTimer = requestAnimationFrame(pollLoop);
    }

    // ==========================================================
    // LONG PRESS TOUCHPAD — bascule mode UI / ROV
    // ==========================================================

    function processTouchpadLongPress(gp) {
        if (17 >= gp.buttons.length) return;

        const isDown = gp.buttons[17].pressed;

        if (isDown && touchpadDownTime === 0) {
            // Début de l'appui
            touchpadDownTime = Date.now();
            touchpadLongPressFired = false;
        } else if (isDown && touchpadDownTime > 0) {
            // Appui en cours — vérifier la durée
            const elapsed = Date.now() - touchpadDownTime;
            if (elapsed >= LONG_PRESS_MS && !touchpadLongPressFired) {
                touchpadLongPressFired = true;
                toggleControlMode();
            }
        } else if (!isDown) {
            // Relâché
            touchpadDownTime = 0;
            touchpadLongPressFired = false;
            // Marquer comme traité pour éviter un front montant au prochain cycle
            prevButtons[17] = false;
        }
    }

    function toggleControlMode() {
        controlMode = controlMode === 'rov' ? 'ui' : 'rov';
        console.log(`[Gamepad] Mode: ${controlMode}`);

        // Mettre à jour l'UI
        updateModeIndicator();

        if (typeof App !== 'undefined') {
            const label = controlMode === 'rov' ? '🎮 Mode ROV' : '🖥️ Mode Interface';
            App.showNotification(label);
        }

        // En mode UI, activer GamepadNav
        if (typeof GamepadNav !== 'undefined') {
            GamepadNav.setEnabled(controlMode === 'ui');
        }
    }

    function updateModeIndicator() {
        let indicator = document.getElementById('gp-mode-indicator');
        if (!indicator) {
            indicator = document.createElement('div');
            indicator.id = 'gp-mode-indicator';
            indicator.style.cssText = 'position:fixed;top:10px;right:10px;padding:6px 14px;border-radius:8px;font-size:0.8rem;font-weight:600;z-index:9999;transition:all 0.3s;pointer-events:none;';
            document.body.appendChild(indicator);
        }
        if (controlMode === 'rov') {
            indicator.textContent = '🎮 ROV';
            indicator.style.background = 'rgba(0, 200, 100, 0.85)';
            indicator.style.color = '#fff';
        } else {
            indicator.textContent = '🖥️ UI';
            indicator.style.background = 'rgba(0, 150, 255, 0.85)';
            indicator.style.color = '#fff';
        }
        // Auto-hide après 3s
        indicator.style.opacity = '1';
        setTimeout(() => { indicator.style.opacity = '0.4'; }, 3000);
    }

    // ==========================================================
    // TRAITEMENT DES AXES (mode ROV uniquement)
    // ==========================================================

    function processAxes(gp) {
        // Consignes 6DOF accumulées à partir des axes mappés dans le profil actif.
        // Extraction directe des axes du gamepad : gp.axes[0..N].
        const dof = { surge: 0, sway: 0, heave: 0, yaw: 0, roll: 0, pitch: 0 };

        Object.entries(axisFunctionMap).forEach(([idxStr, config]) => {
            const idx = parseInt(idxStr);
            if (idx >= gp.axes.length || !config.function) return;

            let val = gp.axes[idx];
            if (config.invert) val = -val;
            val = applyDeadzone(val, config.deadzone);
            if (val === 0) return;
            // Sensibilité par axe (10..150 %) si définie dans le mapping
            if (config.sensitivity !== undefined && config.sensitivity !== null) {
                val *= Math.max(10, Math.min(150, config.sensitivity)) / 100;
            }

            mapAxisFunctionToDof(config.function, val, dof);
        });

        // Affichage temps réel dans le cockpit (optionnel)
        updateGamepadDisplay(dof.heave, dof.yaw, dof.surge, dof.sway, 0);

        // Log de debug : visible dans la console F12 dès qu'un axe dépasse la deadzone
        const active = dof.surge || dof.sway || dof.heave || dof.yaw || dof.roll || dof.pitch;
        if (active) {
            console.log('[Gamepad Move]', {
                surge: +dof.surge.toFixed(3), sway: +dof.sway.toFixed(3),
                heave: +dof.heave.toFixed(3), yaw: +dof.yaw.toFixed(3),
                roll: +dof.roll.toFixed(3), pitch: +dof.pitch.toFixed(3),
                armed: isArmed()
            });
        }

        // Toujours envoyer les commandes de mouvement au backend.
        // Le backend vérifie lui-même l'état armé et bloque si désarmé.
        // Cela garantit que la liaison de données fonctionne même si
        // l'état armé n'a pas encore été propagé par la télémétrie WebSocket.
        sendMovement(dof.surge, dof.sway, dof.heave, dof.yaw, dof.roll, dof.pitch);
    }

    // Associe un nom de fonction d'axe (profil) à un canal 6DOF.
    // Gère les variantes analogiques ET les noms orientés "action" des profils.
    function mapAxisFunctionToDof(fn, val, dof) {
        switch (fn) {
            case 'forward_backward':
            case 'move_forward':
            case 'move_backward':
            case 'surge':
                dof.surge = val; break;
            case 'lateral':
            case 'sway':
                dof.sway = val; break;
            case 'turn':
            case 'turn_left':
            case 'turn_right':
            case 'yaw':
                dof.yaw = val; break;
            case 'vertical':
            case 'heave':
            case 'move_up':
            case 'move_down':
                dof.heave = val; break;
            case 'ascent':
                if (val > 0) dof.heave = val; break;
            case 'descent':
                if (val > 0) dof.heave = -val; break;
            case 'roll':
            case 'roll_left':
            case 'roll_right':
                dof.roll = val; break;
            case 'pitch':
            case 'pitch_up':
            case 'pitch_down':
                dof.pitch = val; break;
        }
    }

    // Conversion booléenne robuste (bool / number / string)
    function _bool(v) {
        if (typeof v === 'boolean') return v;
        if (typeof v === 'number') return v === 1;
        if (typeof v === 'string') {
            const s = v.toLowerCase().trim();
            return s === 'true' || s === '1' || s === 'yes' || s === 'on';
        }
        return false;
    }

    // État d'armement autoritaire : priorité à l'état serveur (télémétrie WebSocket),
    // ce qui permet d'armer via l'UI cockpit sans dépendre d'un bouton manette.
    function isArmed() {
        try {
            if (typeof Telemetry !== 'undefined' && Telemetry.getData) {
                const d = Telemetry.getData();
                if (d && typeof d.armed !== 'undefined') return _bool(d.armed);
            }
        } catch (e) {}
        return armed;
    }

    function applyDeadzone(value, override) {
        // Zone morte par axe si définie dans le mapping, sinon zone morte globale
        const pct = (override !== undefined && override !== null) ? override : (profileSettings.deadzone || 10);
        const dz = Math.min(Math.max(pct, 0) / 100, 0.30);
        if (Math.abs(value) < dz) return 0;
        const sign = value > 0 ? 1 : -1;
        return sign * (Math.abs(value) - dz) / (1 - dz);
    }

    // ==========================================================
    // TRAITEMENT DES BOUTONS (mode ROV — dispatch vers backend)
    // ==========================================================

    // Debounce par fonction (ms) — évite les appuis rapides qui cassent le flux vidéo
    const ACTION_DEBOUNCE = 500;
    const _actionLastTime = {}; // { functionName: timestamp }

    /**
     * Déclenche une fonction ROV (appui) avec debounce + gestion armée locale.
     * `label` = nom du bouton simple ou clé du combo (ex: "L1+CROSS").
     */
    function triggerFunction(label, functionName) {
        const now = Date.now();
        const lastTime = _actionLastTime[functionName] || 0;
        if (now - lastTime < ACTION_DEBOUNCE) {
            console.log(`[Gamepad] ${label} → ${functionName} (debounce, ${now - lastTime}ms)`);
            return;
        }
        _actionLastTime[functionName] = now;
        console.log(`[Gamepad] ${label} → ${functionName}`);
        sendGamepadInput(label, functionName, 1);
        // Gérer l'état armé localement pour le feedback immédiat
        if (functionName === 'arm') {
            armed = true;
        } else if (functionName === 'disarm' || functionName === 'emergency_stop') {
            armed = false;
        }
    }

    function processButtons(gp) {
        const now = Date.now();
        const nbButtons = Math.min(gp.buttons.length, 18);
        const pressed = [];
        for (let i = 0; i < nbButtons; i++) pressed[i] = gp.buttons[i].pressed;

        // --- 1. COMBOS EN PRIORITÉ (triés par taille décroissante) ---
        // Les indices utilisés par un combo actif sont "consommés" : leurs
        // fonctions simples ne se déclenchent pas (ex: L1+A actif → pas de A seul).
        const consumed = new Set();
        comboBindings.forEach((combo) => {
            const allDown = combo.indices.every((idx) => idx < nbButtons && pressed[idx]);
            const wasActive = prevComboActive[combo.key] || false;
            if (allDown) {
                combo.indices.forEach((idx) => consumed.add(idx));
                if (!wasActive) {
                    // Combo qui se complète : annuler les appuis simples différés de ses membres
                    combo.indices.forEach((idx) => { delete pendingSingle[idx]; });
                    triggerFunction(combo.key, combo.function);
                }
            } else if (wasActive && combo.action === 'hold') {
                // Relâchement du combo — front descendant pour les actions "hold"
                sendGamepadInput(combo.key, combo.function, 0);
            }
            prevComboActive[combo.key] = allDown;
        });

        // --- 2. TOUCHES SIMPLES (avec délai de grâce pour les membres de combo) ---
        for (let i = 0; i < nbButtons; i++) {
            // TOUCHPAD géré séparément (long press)
            if (i === 17) continue;

            const isDown = pressed[i];
            const wasPressed = prevButtons[i] || false;
            prevButtons[i] = isDown;

            // Membre d'un combo actuellement actif : jamais de déclenchement simple
            if (consumed.has(i)) {
                delete pendingSingle[i];
                continue;
            }

            const btnName = INDEX_TO_BUTTON_NAME[i];
            const config = buttonFunctionMap[i];

            // Front montant (appui)
            if (isDown && !wasPressed) {
                if (config && config.function) {
                    if (comboMemberIndices.has(i)) {
                        // Touche membre d'un combo : différer pour laisser le temps
                        // à la 2e touche du combo d'arriver (COMBO_GRACE_MS)
                        pendingSingle[i] = now;
                    } else {
                        triggerFunction(btnName, config.function);
                    }
                } else if (btnName) {
                    console.log(`[Gamepad] ${btnName} appuyé mais aucune fonction (map keys: ${Object.keys(buttonFunctionMap).join(',')})`);
                }
                continue;
            }

            // Appui différé toujours maintenu : délai de grâce écoulé sans combo → déclencher
            if (isDown && pendingSingle[i] !== undefined) {
                if (now - pendingSingle[i] >= COMBO_GRACE_MS) {
                    delete pendingSingle[i];
                    if (config && config.function) triggerFunction(btnName, config.function);
                }
                continue;
            }

            // Front descendant (relâchement)
            if (!isDown && wasPressed) {
                if (pendingSingle[i] !== undefined) {
                    // Relâché avant la fin du délai de grâce sans combo complété :
                    // déclencher l'appui simple maintenant (press puis release si hold)
                    delete pendingSingle[i];
                    if (config && config.function) {
                        triggerFunction(btnName, config.function);
                        if (config.action === 'hold') sendGamepadInput(btnName, config.function, 0);
                    }
                } else if (config && config.function && config.action === 'hold') {
                    // Relâchement classique — pour les actions "hold"
                    sendGamepadInput(btnName, config.function, 0);
                }
            }
        }
    }

    /**
     * Envoie une commande gamepad_input via WebSocket
     * Le backend dispatche vers l'action correspondante
     * Fallback REST API si WebSocket non connecté
     */
    function sendGamepadInput(buttonName, functionName, value) {
        if (typeof Telemetry !== 'undefined' && Telemetry.isConnected()) {
            Telemetry.sendCommand({
                command: 'gamepad_input',
                button: buttonName,
                function: functionName,
                value: value
            });
        } else {
            // Fallback REST API — dispatche aussi le résultat pour le feedback
            fetch(`/api/action/${encodeURIComponent(functionName)}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ value: value })
            })
            .then(r => r.json())
            .then(result => {
                window.dispatchEvent(new CustomEvent('rov-action-result', {
                    detail: { ...result, function: functionName }
                }));
            })
            .catch(e => console.warn('[Gamepad] Dispatch failed:', e));
        }
    }

    // ==========================================================
    // ENVOI DES COMMANDES DE MOUVEMENT
    // ==========================================================

    // Limiteur de débit WebSocket : n'envoyer les trames `move` qu'à 20 Hz max
    // (une toutes les 50 ms) pour ne pas engorger le WebSocket ni le bus I2C.
    const MOVE_THROTTLE_MS = 50;   // 20 Hz
    // Seuil d'insensibilité (deadband) : n'envoyer que si un axe a bougé de > 1%.
    const MOVE_DEADBAND = 0.01;    // 1% (valeurs normalisées -1.0..+1.0)
    let _lastMoveTime = 0;
    let _lastMoveSent = { forward: 0, lateral: 0, vertical: 0, yaw: 0, roll: 0, pitch: 0 };

    function sendMovement(forward, lateral, vertical, yaw, roll, pitch) {
        roll = roll || 0;
        pitch = pitch || 0;

        // Failsafe : bloquer tout envoi de mouvement si manette perdue
        if (_failsafe) return;

        // Vérifier les valeurs NaN (peut arriver si deadzone retourne NaN)
        if (isNaN(forward) || isNaN(lateral) || isNaN(vertical) ||
            isNaN(yaw) || isNaN(roll) || isNaN(pitch)) {
            console.warn('[Gamepad] NaN détecté dans sendMovement, ignoré');
            return;
        }

        // 1. Throttle : au plus une trame toutes les 50 ms (20 Hz)
        const now = Date.now();
        if (now - _lastMoveTime < MOVE_THROTTLE_MS) return;

        // 2. Deadband : n'envoyer que si au moins un axe a changé de plus de 1%
        const changed =
            Math.abs(forward  - _lastMoveSent.forward)  > MOVE_DEADBAND ||
            Math.abs(lateral  - _lastMoveSent.lateral)  > MOVE_DEADBAND ||
            Math.abs(vertical - _lastMoveSent.vertical) > MOVE_DEADBAND ||
            Math.abs(yaw      - _lastMoveSent.yaw)      > MOVE_DEADBAND ||
            Math.abs(roll     - _lastMoveSent.roll)     > MOVE_DEADBAND ||
            Math.abs(pitch    - _lastMoveSent.pitch)    > MOVE_DEADBAND;
        if (!changed) return;

        _lastMoveTime = now;
        _lastMoveSent = { forward, lateral, vertical, yaw, roll, pitch };

        Telemetry.sendCommand({
            command: 'move',
            forward: Math.round(forward * 100),
            lateral: Math.round(lateral * 100),
            vertical: Math.round(vertical * 100),
            yaw: Math.round(yaw * 100),
            roll: Math.round(roll * 100),
            pitch: Math.round(pitch * 100)
        });
    }

    // ==========================================================
    // INTERFACE UTILISATEUR
    // ==========================================================

    function updateStatusUI(isConnected, name) {
        const el = document.getElementById('gp-status');
        if (el) {
            if (isConnected) {
                el.innerHTML = `&#x1F3AE; Manette: <strong>${name.substring(0, 30)}</strong>`;
                el.style.color = 'var(--accent-green)';
            } else {
                el.innerHTML = '&#x1F3AE; Manette: non connectée';
                el.style.color = 'var(--text-secondary)';
            }
        }
    }

    function updateGamepadDisplay(thrustV, yaw, thrustF, thrustL, light) {
        // Affichage temps réel dans le cockpit (optionnel)
    }

    // ==========================================================
    // CHARGEMENT DU PROFIL ACTIF
    // ==========================================================

    function applyStoredSettings(settings) {
        if (!settings) return;
        profileSettings = {
            deadzone: parseInt(settings.deadzone) || 12,
            sensitivity: parseInt(settings.sensitivity) || 100,
            response_curve: settings.response_curve || 'linear'
        };
    }

    async function loadActiveProfile(forceBackend) {
        // 1. localStorage prioritaire : mapping écrit immédiatement par la page
        //    de configuration → consommation fluide sans requête réseau.
        //    forceBackend=true permet d'ignorer ce cache (ex: switch profil Lunette)
        if (!forceBackend) {
            try {
                const raw = localStorage.getItem(LS_MAPPING_KEY);
                if (raw) {
                    const stored = JSON.parse(raw);
                    if (stored && (stored.buttons || stored.axes)) {
                        applyStoredSettings(stored.settings);
                        applyProfileMapping(stored);
                        return;
                    }
                }
            } catch (e) {
                // localStorage corrompu ou indisponible : fallback API ci-dessous
            }
        }

        // 2. Fallback : profil actif côté backend
        try {
            const resp = await fetch('/api/gamepad/mapping');
            if (!resp.ok) return;
            const data = await resp.json();
            const mapping = data.data || data.mapping;
            if (data.status === 'ok' && mapping) {
                // Appliquer les settings (deadzone, sensibilité) avant le mapping
                applyStoredSettings(mapping.settings);
                applyProfileMapping(mapping);
            }
        } catch (e) {
            console.warn('[Gamepad] Impossible de charger le profil actif:', e);
        }
    }

    /**
     * Applique un mapping de profil au format { buttons: {}, axes: {} }
     */
    function applyProfileMapping(profileMapping) {
        if (!profileMapping) return;

        // Construire les nouvelles maps AVANT de remplacer les anciennes
        // (évite la race condition avec le polling loop à 60fps)
        const newButtonMap = {};
        const newAxisMap = {};
        const newComboBindings = [];

        // Boutons : nom → index
        const BUTTON_NAME_TO_INDEX = {
            'CROSS': 0, 'CIRCLE': 1, 'SQUARE': 2, 'TRIANGLE': 3,
            'L1': 4, 'R1': 5, 'L2': 6, 'R2': 7,
            'SHARE': 8, 'OPTIONS': 9, 'L3': 10, 'R3': 11,
            'DPAD_UP': 12, 'DPAD_DOWN': 13, 'DPAD_LEFT': 14, 'DPAD_RIGHT': 15,
            'PS': 16, 'TOUCHPAD': 17
        };

        if (profileMapping.buttons) {
            Object.entries(profileMapping.buttons).forEach(([name, cfg]) => {
                if (!cfg || !cfg.function) return;
                if (name.includes('+')) {
                    // Clé combo "L1+CROSS" → liste d'indices
                    const parts = name.split('+').map((p) => p.trim());
                    const indices = parts.map((p) => BUTTON_NAME_TO_INDEX[p]);
                    if (indices.some((ix) => ix === undefined)) return;
                    newComboBindings.push({
                        key: name,
                        indices: indices,
                        function: cfg.function,
                        action: cfg.action || 'press'
                    });
                } else {
                    const idx = BUTTON_NAME_TO_INDEX[name];
                    if (idx !== undefined) {
                        newButtonMap[idx] = {
                            function: cfg.function,
                            action: cfg.action || 'press'
                        };
                    }
                }
            });
        }

        // Combos les plus longs en premier (priorité aux combinaisons complexes)
        newComboBindings.sort((a, b) => b.indices.length - a.indices.length);
        const newComboMembers = new Set();
        newComboBindings.forEach((c) => c.indices.forEach((ix) => newComboMembers.add(ix)));

        // Axes : nom → index
        const AXIS_NAME_TO_INDEX = {
            'LEFT_X': 0, 'LEFT_Y': 1, 'RIGHT_X': 2, 'RIGHT_Y': 3,
            'L2': 4, 'R2': 5
        };

        if (profileMapping.axes) {
            Object.entries(profileMapping.axes).forEach(([name, cfg]) => {
                const idx = AXIS_NAME_TO_INDEX[name];
                if (idx !== undefined && cfg.function) {
                    newAxisMap[idx] = {
                        function: cfg.function,
                        invert: cfg.invert || false,
                        deadzone: (cfg.deadzone !== undefined && cfg.deadzone !== null)
                            ? parseFloat(cfg.deadzone) : null,
                        sensitivity: (cfg.sensitivity !== undefined && cfg.sensitivity !== null)
                            ? parseFloat(cfg.sensitivity) : null
                    };
                }
            });
        }

        // Swap atomique : remplacer les anciennes maps d'un coup
        buttonFunctionMap = newButtonMap;
        axisFunctionMap = newAxisMap;
        comboBindings = newComboBindings;
        comboMemberIndices = newComboMembers;
        prevComboActive = {};
        pendingSingle = {};
    }

    // ==========================================================
    // BATTERIE MANETTE
    // ==========================================================

    /**
     * Lit le niveau de batterie de la manette (propriété non-standard).
     * Retourne null si non supportée, sinon un entier 0–100.
     * Gère les formats : number (0..1), object { level }, object { dischargingTime }.
     */
    function _readBattery(gp) {
        if (!gp) return null;
        const bat = gp.battery;
        if (bat == null) return null;
        // Format number direct (0.0..1.0)
        if (typeof bat === 'number' && !isNaN(bat) && bat >= 0 && bat <= 1) {
            return Math.round(bat * 100);
        }
        // Format objet { level: 0..1 } ou { level: 0..100 }
        if (typeof bat === 'object' && bat.level != null) {
            const lvl = Number(bat.level);
            if (isNaN(lvl) || lvl < 0) return null;
            return lvl <= 1 ? Math.round(lvl * 100) : Math.min(100, Math.round(lvl));
        }
        return null;
    }

    /** Retourne le niveau de batterie manette (null si non disponible). */
    function getBatteryLevel() {
        return _batteryLevel;
    }

    // ==========================================================
    // FAILSAFE — Surveillance connexion manette (Watchdog)
    // ==========================================================

    function _startWatchdog() {
        if (_watchdogTimer) return;
        _lastPollTimestamp = performance.now();
        _watchdogTimer = setInterval(_watchdogTick, WATCHDOG_INTERVAL_MS);
    }

    function _stopWatchdog() {
        if (_watchdogTimer) {
            clearInterval(_watchdogTimer);
            _watchdogTimer = null;
        }
    }

    function _watchdogTick() {
        const elapsed = performance.now() - _lastPollTimestamp;

        if (!_failsafe && connected && elapsed > WATCHDOG_TIMEOUT_MS) {
            // Manette ne répond plus depuis trop longtemps
            _activateFailsafe('watchdog_timeout');
        }

        if (_failsafe && connected && elapsed < WATCHDOG_INTERVAL_MS) {
            // Polling actif de nouveau → manette récupérée
            _deactivateFailsafe();
        }
    }

    function _activateFailsafe(reason) {
        if (_failsafe) return;
        _failsafe = true;
        console.warn(`[Gamepad] ⚠️ FAILSAFE activé (${reason}) — manette perdue`);
        // Envoyer stop immédiat : tous les axes à 0
        Telemetry.sendCommand({
            command: 'move',
            forward: 0, lateral: 0, vertical: 0,
            yaw: 0, roll: 0, pitch: 0
        });
    }

    function _deactivateFailsafe() {
        if (!_failsafe) return;
        _failsafe = false;
        console.log('[Gamepad] ✅ Failsafe désactivé — contrôle rétabli');
    }

    function isFailsafe() {
        return _failsafe;
    }

    // ==========================================================
    // INITIALISATION
    // ==========================================================

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // Afficher l'indicateur de mode au démarrage
    setTimeout(updateModeIndicator, 500);

    // API publique
    return {
        isConnected: () => connected,
        isArmed: () => armed,
        setArmed: (val) => { armed = val; },
        getControlMode: () => controlMode,
        setControlMode: (mode) => { controlMode = mode; updateModeIndicator(); },
        loadActiveProfile,
        reloadFromBackend: () => loadActiveProfile(true),
        applyProfileMapping,
        reloadMapping: loadActiveProfile,
        onCockpitActivate,
        scanForGamepads,
        setTestMode,
        isTestMode,
        getBatteryLevel,
        isFailsafe
    };

})();
