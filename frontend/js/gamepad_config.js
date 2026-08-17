/**
 * BOB-ROV — Module Configuration Manette
 * Tableau unique de mapping trié par thèmes, avec :
 *   - assignation par écoute (bouton simple, COMBO de boutons ou axe)
 *   - réglages par axe (inversion, deadzone, sensibilité)
 *   - sauvegarde immédiate dans localStorage (consommée par le Cockpit)
 *     + synchronisation du profil actif côté backend
 */
'use strict';

const GamepadConfig = (() => {
    let initialized = false;
    let currentProfile = null;
    let profiles = [];
    // Mapping courant { buttons: { 'CROSS'|'L1+CROSS': {function, action} }, axes: { 'LEFT_Y': {function, invert, deadzone?, sensitivity?} } }
    let currentMapping = { buttons: {}, axes: {} };

    // Clé localStorage : mapping consommé en direct par gamepad.js, simulator3d.js et les modules 3D
    const LS_KEY = 'rov.gamepad.mapping';

    // Statuts des fonctions chargés depuis /api/actions/functions : { name: {status, description} }
    let functionInfo = {};

    // ==========================================================
    // CATALOGUE DES FONCTIONS — trié strictement par thèmes
    // inputs : 'button' | 'axis' | 'both' ; hold : action maintenue
    // ==========================================================
    const FUNCTION_CATALOG = [
        {
            theme: '🧭 Déplacements / Navigation',
            rows: [
                { fn: 'forward_backward', label: 'Surge — Avancer / Reculer',          inputs: 'both' },
                { fn: 'lateral',          label: 'Sway — Translater Gauche / Droite',  inputs: 'both' },
                { fn: 'vertical',         label: 'Heave — Monter / Descendre',         inputs: 'both' },
                { fn: 'ascent',           label: 'Heave — Montée (gâchette)',          inputs: 'both' },
                { fn: 'descent',          label: 'Heave — Descente (gâchette)',        inputs: 'both' },
                { fn: 'turn',             label: 'Yaw — Pivoter Lacet Gauche / Droite', inputs: 'both' },
                { fn: 'turn_left',        label: 'Yaw — Lacet gauche (bouton)',        inputs: 'button', hold: true },
                { fn: 'turn_right',       label: 'Yaw — Lacet droite (bouton)',        inputs: 'button', hold: true },
                { fn: 'pitch',            label: 'Pitch — Inclinaison tangage (axe)',  inputs: 'axis' },
                { fn: 'pitch_up',         label: 'Pitch — Cabrer (bouton)',            inputs: 'button', hold: true },
                { fn: 'pitch_down',       label: 'Pitch — Piquer (bouton)',            inputs: 'button', hold: true },
                { fn: 'roll',             label: 'Roll — Inclinaison roulis (axe)',    inputs: 'axis' },
                { fn: 'roll_left',        label: 'Roll — Roulis gauche (bouton)',      inputs: 'button', hold: true },
                { fn: 'roll_right',       label: 'Roll — Roulis droite (bouton)',      inputs: 'button', hold: true },
            ],
        },
        {
            theme: '🛡️ Armement & Sécurité',
            rows: [
                { fn: 'arm_toggle',       label: 'Basculer Armer / Désarmer (toggle)',         inputs: 'button' },
                { fn: 'arm',              label: 'Armer les moteurs',                       inputs: 'button' },
                { fn: 'disarm',           label: 'Désarmer les moteurs',                    inputs: 'button' },
                { fn: 'emergency_stop',   label: 'Arrêt d\'urgence (Emergency Stop)',       inputs: 'button' },
                { fn: 'autolevel_toggle', label: 'Mode : Stabilisé (auto-level)',           inputs: 'button' },
                { fn: 'depth_hold',       label: 'Mode : Maintien profondeur (Hold Depth)', inputs: 'button' },
                { fn: 'heading_hold',     label: 'Mode : Maintien de cap',                  inputs: 'button' },
            ],
        },
        {
            theme: '📸 Photos & Vidéos / Éclairage',
            rows: [
                { fn: 'photo',            label: 'Prise de photo',                          inputs: 'button' },
                { fn: 'video_toggle',     label: 'Start / Stop enregistrement vidéo',       inputs: 'button' },
                { fn: 'light_toggle',     label: 'Éclairage LED ON / OFF',                  inputs: 'button' },
                { fn: 'light_up',         label: 'Éclairage — Intensité + (Up)',            inputs: 'button' },
                { fn: 'light_down',       label: 'Éclairage — Intensité − (Down)',          inputs: 'button' },
                { fn: 'light_brightness', label: 'Éclairage — Intensité (axe / slider)',    inputs: 'axis' },
                { fn: 'camera_tilt_up',   label: 'Tilt caméra — Haut (Up)',                 inputs: 'button', hold: true },
                { fn: 'camera_tilt_down', label: 'Tilt caméra — Bas (Down)',                inputs: 'button', hold: true },
                { fn: 'camera_tilt',      label: 'Tilt caméra (axe)',                       inputs: 'axis' },
            ],
        },
        {
            theme: '🖥️ Interface & Navigation IHM',
            rows: [
                { fn: 'fpv_toggle',       label: 'Switch Vue Externe / Vue FPV caméra',     inputs: 'button' },
                { fn: 'panel_toggle',     label: 'Basculer panneau latéral Cockpit (F)',     inputs: 'button' },
                { fn: 'reset_position',   label: 'Reset position / Vue 3D',                 inputs: 'button' },
                { fn: 'imu_tare',         label: 'Recalibrage zéro IMU / Tare',             inputs: 'button' },
            ],
        },
    ];

    // Mapping par défaut (miroir du profil "Standard" backend)
    const DEFAULT_MAPPING = {
        buttons: {
            CROSS:      { function: 'photo',          action: 'press' },
            CIRCLE:     { function: 'video_toggle',   action: 'press' },
            SQUARE:     { function: 'light_toggle',   action: 'press' },
            TRIANGLE:   { function: 'depth_hold',     action: 'press' },
            L1:         { function: 'roll_left',      action: 'hold' },
            R1:         { function: 'roll_right',     action: 'hold' },
            SHARE:      { function: 'reset_position', action: 'press' },
            OPTIONS:    { function: 'emergency_stop', action: 'press' },
            L3:         { function: 'heading_hold',   action: 'press' },
            R3:         { function: 'arm',            action: 'press' },
            DPAD_UP:    { function: 'pitch_up',       action: 'hold' },
            DPAD_DOWN:  { function: 'pitch_down',     action: 'hold' },
            DPAD_LEFT:  { function: 'turn_left',      action: 'hold' },
            DPAD_RIGHT: { function: 'turn_right',     action: 'hold' },
            PS:         { function: 'disarm',         action: 'press' },
            TOUCHPAD:   { function: 'reset_position', action: 'press' },
        },
        axes: {
            LEFT_X:  { function: 'turn',             invert: false },
            LEFT_Y:  { function: 'forward_backward', invert: true },
            RIGHT_X: { function: 'lateral',          invert: false },
            RIGHT_Y: { function: 'vertical',         invert: true },
            L2:      { function: 'descent',          invert: false },
            R2:      { function: 'ascent',           invert: false },
        },
    };

    // Correspondances index Gamepad API ↔ noms PS
    const BUTTON_INDEX_TO_NAME = {
        0: 'CROSS', 1: 'CIRCLE', 2: 'SQUARE', 3: 'TRIANGLE',
        4: 'L1', 5: 'R1', 6: 'L2', 7: 'R2',
        8: 'SHARE', 9: 'OPTIONS', 10: 'L3', 11: 'R3',
        12: 'DPAD_UP', 13: 'DPAD_DOWN', 14: 'DPAD_LEFT', 15: 'DPAD_RIGHT',
        16: 'PS', 17: 'TOUCHPAD'
    };
    const AXIS_INDEX_TO_NAME = {
        0: 'LEFT_X', 1: 'LEFT_Y', 2: 'RIGHT_X', 3: 'RIGHT_Y',
        4: 'L2', 5: 'R2'
    };

    // ==========================================================
    // INITIALISATION
    // ==========================================================
    function init() {
        if (initialized) { refresh(); return; }
        initialized = true;
        // Rendu SYNCHRONE immédiat : le tableau n'est jamais vide, même si le
        // backend est hors ligne et le localStorage vierge (mapping par défaut).
        if (!Object.keys(currentMapping.buttons).length &&
            !Object.keys(currentMapping.axes).length) {
            currentMapping = JSON.parse(JSON.stringify(DEFAULT_MAPPING));
        }
        renderMappingTable();
        loadAvailableFunctions();
        loadProfiles();
        loadMapping();
        setupEventListeners();
    }

    function refresh() {
        loadProfiles();
        loadMapping();
    }

    // ==========================================================
    // STATUTS DES FONCTIONS (badges ✅/🛠️/⏳)
    // ==========================================================
    async function loadAvailableFunctions() {
        try {
            const resp = await fetch('/api/actions/functions');
            if (!resp.ok) return;
            const data = await resp.json();
            if (data.status === 'ok' && Array.isArray(data.functions)) {
                functionInfo = {};
                data.functions.forEach(fn => { functionInfo[fn.name] = fn; });
                renderMappingTable();
            }
        } catch (e) {
            console.warn('[GamepadConfig] API actions/functions indisponible');
        }
    }

    function statusIcon(fn) {
        const info = functionInfo[fn];
        if (!info) return '';
        return info.status === 'implemented' ? '✅' :
               info.status === 'in_progress' ? '🛠️' : '⏳';
    }

    // ==========================================================
    // PROFILS (CRUD via backend)
    // ==========================================================
    async function loadProfiles() {
        try {
            const resp = await fetch('/api/gamepad/profiles');
            if (!resp.ok) return;
            const data = await resp.json();
            profiles = data.data || data.profiles || [];
            renderProfileSelect();

            const statusResp = await fetch('/api/gamepad/status');
            if (statusResp.ok) {
                const statusData = await statusResp.json();
                if (statusData.active_profile) {
                    const select = document.getElementById('gp-profile-select');
                    if (select) select.value = statusData.active_profile;
                    currentProfile = statusData.active_profile;
                }
            }
        } catch (e) {
            console.warn('[GamepadConfig] Erreur chargement profils:', e);
        }
    }

    function renderProfileSelect() {
        const select = document.getElementById('gp-profile-select');
        if (!select) return;
        select.innerHTML = '';
        profiles.forEach(p => {
            const opt = document.createElement('option');
            opt.value = p.name;
            opt.textContent = p.description ? `${p.name} — ${p.description}` : p.name;
            select.appendChild(opt);
        });
    }

    async function selectProfile(name) {
        try {
            const resp = await fetch(`/api/gamepad/profile/${encodeURIComponent(name)}`);
            if (!resp.ok) return;
            const data = await resp.json();
            const profileData = data.data || data.profile;
            if (data.status === 'ok' && profileData) {
                currentProfile = name;
                const mappings = profileData.mappings || profileData.mapping;
                if (mappings) {
                    currentMapping = {
                        buttons: mappings.buttons || {},
                        axes: mappings.axes || {},
                    };
                    renderMappingTable();
                }
                if (profileData.settings) renderSettings(profileData.settings);
                // Le profil chargé devient le mapping "live" du Cockpit
                persistMapping({ post: false });
                notify(`Profil "${name}" chargé`);
            }
        } catch (e) {
            console.warn('[GamepadConfig] Erreur sélection profil:', e);
        }
    }

    async function saveProfile() {
        const select = document.getElementById('gp-profile-select');
        const name = select ? select.value : null;
        if (!name) { notify('Sélectionnez un profil à sauvegarder'); return; }

        const profile = buildProfileFromUI(name);
        try {
            const resp = await fetch('/api/gamepad/profile', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, profile })
            });
            const data = await resp.json();
            if (data.status === 'ok') {
                persistMapping({ post: false });
                notify(`Profil "${name}" sauvegardé !`);
            } else {
                notify('Erreur: ' + (data.message || 'inconnue'));
            }
        } catch (e) {
            notify('Erreur de sauvegarde');
        }
    }

    async function createNewProfile() {
        const modal = document.getElementById('gp-new-profile-modal');
        const nameInput = document.getElementById('gp-new-name');
        const descInput = document.getElementById('gp-new-desc');
        const baseSelect = document.getElementById('gp-new-base');
        if (!modal) return;

        if (baseSelect) {
            baseSelect.innerHTML = '<option value="">Profil vide</option>';
            profiles.forEach(p => {
                const opt = document.createElement('option');
                opt.value = p.name;
                opt.textContent = p.name;
                baseSelect.appendChild(opt);
            });
            if (currentProfile) baseSelect.value = currentProfile;
        }
        if (nameInput) { nameInput.value = ''; nameInput.focus(); }
        if (descInput) descInput.value = '';
        modal.classList.remove('hidden');
    }

    async function confirmCreateProfile() {
        const modal = document.getElementById('gp-new-profile-modal');
        const nameInput = document.getElementById('gp-new-name');
        const descInput = document.getElementById('gp-new-desc');
        const baseSelect = document.getElementById('gp-new-base');

        const name = nameInput ? nameInput.value.trim() : '';
        if (!name) { notify('Le nom est requis'); return; }
        if (profiles.some(p => p.name === name)) {
            notify(`Un profil "${name}" existe déjà`);
            return;
        }
        if (modal) modal.classList.add('hidden');

        let profileData;
        const baseName = baseSelect ? baseSelect.value : '';
        if (baseName) {
            try {
                const resp = await fetch(`/api/gamepad/profile/${encodeURIComponent(baseName)}`);
                const data = await resp.json();
                profileData = data.data || data.profile;
            } catch (e) {
                profileData = buildProfileFromUI(name);
            }
        } else {
            profileData = { mappings: { buttons: {}, axes: {} }, settings: getSettingsFromUI() };
        }
        profileData.name = name;
        profileData.description = descInput ? descInput.value.trim() : '';

        try {
            const resp = await fetch('/api/gamepad/profile', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, profile: profileData })
            });
            const data = await resp.json();
            if (data.status === 'ok') {
                notify(`Profil "${name}" créé !`);
                await loadProfiles();
                const select = document.getElementById('gp-profile-select');
                if (select) select.value = name;
                await selectProfile(name);
            } else {
                notify('Erreur: ' + (data.message || 'inconnue'));
            }
        } catch (e) {
            notify('Erreur de création');
        }
    }

    function closeCreateProfileModal() {
        const modal = document.getElementById('gp-new-profile-modal');
        if (modal) modal.classList.add('hidden');
    }

    async function deleteProfile(name) {
        if (!name) {
            const select = document.getElementById('gp-profile-select');
            name = select ? select.value : null;
        }
        if (!name) return;
        if (!confirm(`Supprimer le profil "${name}" ?`)) return;
        try {
            const resp = await fetch(`/api/gamepad/profile/${encodeURIComponent(name)}`, { method: 'DELETE' });
            const data = await resp.json();
            if (data.status === 'ok') {
                notify(`Profil "${name}" supprimé`);
                await loadProfiles();
            } else {
                notify('Erreur: ' + (data.message || 'inconnue'));
            }
        } catch (e) {
            notify('Erreur de suppression');
        }
    }

    async function importProfile() {
        const fileInput = document.getElementById('gp-import-file');
        if (fileInput) fileInput.click();
    }

    async function handleImportFile(event) {
        const file = event.target.files[0];
        if (!file) return;
        try {
            const text = await file.text();
            JSON.parse(text); // validation syntaxique
            const resp = await fetch('/api/gamepad/profile/import', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: text
            });
            const data = await resp.json();
            if (data.status === 'ok') {
                notify('Profil importé avec succès !');
                await loadProfiles();
            } else {
                notify('Erreur import: ' + (data.message || 'inconnue'));
            }
        } catch (e) {
            notify('Fichier JSON invalide');
        }
        event.target.value = '';
    }

    async function exportProfile(name) {
        if (!name) {
            const select = document.getElementById('gp-profile-select');
            name = select ? select.value : null;
        }
        if (!name) return;
        try {
            const resp = await fetch(`/api/gamepad/profile/${encodeURIComponent(name)}/export`);
            if (!resp.ok) return;
            const data = await resp.json();
            downloadJson(data, `${name}.json`);
            notify(`Profil "${name}" exporté`);
        } catch (e) {
            notify('Erreur d\'export');
        }
    }

    async function setActiveProfile(name) {
        if (!name) {
            const select = document.getElementById('gp-profile-select');
            name = select ? select.value : null;
        }
        if (!name) return;
        try {
            const resp = await fetch('/api/gamepad/active', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name })
            });
            const data = await resp.json();
            if (data.status === 'ok') {
                currentProfile = name;
                notify(`Profil actif: "${name}"`);
                await selectProfile(name);   // recharge + persiste dans localStorage
                if (typeof Gamepad !== 'undefined' && Gamepad.reloadMapping) {
                    Gamepad.reloadMapping();
                }
            }
        } catch (e) {
            notify('Erreur activation profil');
        }
    }

    // ==========================================================
    // CHARGEMENT DU MAPPING (localStorage prioritaire, puis backend)
    // ==========================================================
    async function loadMapping() {
        // 1. localStorage : dernier mapping sauvegardé par cette page
        try {
            const local = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
            if (local && (local.buttons || local.axes)) {
                currentMapping = { buttons: local.buttons || {}, axes: local.axes || {} };
                if (local.settings) renderSettings(local.settings);
                renderMappingTable();
                return;
            }
        } catch (e) { /* localStorage corrompu : fallback API */ }

        // 2. Backend : mapping du profil actif
        try {
            const resp = await fetch('/api/gamepad/mapping');
            if (!resp.ok) return;
            const data = await resp.json();
            const mapping = data.data || data.mapping;
            if (data.status === 'ok' && mapping) {
                currentMapping = { buttons: mapping.buttons || {}, axes: mapping.axes || {} };
                if (mapping.settings) renderSettings(mapping.settings);
                renderMappingTable();
            }
        } catch (e) {
            console.warn('[GamepadConfig] Erreur chargement mapping:', e);
        }
    }

    // ==========================================================
    // PERSISTANCE — localStorage IMMÉDIAT + backend + notification live
    // ==========================================================
    function persistMapping(opts) {
        const post = !opts || opts.post !== false;
        const payload = {
            buttons: currentMapping.buttons || {},
            axes: currentMapping.axes || {},
        };
        // 1. localStorage : consommé automatiquement par le Cockpit / la vue 3D
        try {
            localStorage.setItem(LS_KEY, JSON.stringify({
                ...payload,
                settings: getSettingsFromUI(),
                savedAt: Date.now(),
            }));
        } catch (e) { /* stockage plein/indisponible : le backend reste la référence */ }

        // 2. Événement même-page : gamepad.js recharge sans attendre le polling
        window.dispatchEvent(new CustomEvent('gamepad-mapping-changed'));

        // 3. Backend : persiste dans le profil actif (best effort)
        if (post) {
            fetch('/api/gamepad/mapping', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            }).catch(() => { /* hors ligne : localStorage fait foi */ });
        }

        // 4. Tooltips du schéma SVG
        if (typeof GamepadVisual !== 'undefined') GamepadVisual.setMapping(currentMapping);
    }

    // ==========================================================
    // TABLEAU UNIQUE DE MAPPING
    // ==========================================================
    function renderMappingTable() {
        const tbody = document.getElementById('gp-map-table-body');
        if (!tbody) return;
        tbody.innerHTML = '';

        FUNCTION_CATALOG.forEach(group => {
            group.rows.forEach((row, i) => {
                const tr = document.createElement('tr');
                tr.dataset.fn = row.fn;

                // Colonne 1 : catégorie (cellule fusionnée sur le groupe)
                if (i === 0) {
                    const tdCat = document.createElement('td');
                    tdCat.className = 'gp-cat-cell';
                    tdCat.rowSpan = group.rows.length;
                    tdCat.textContent = group.theme;
                    tr.appendChild(tdCat);
                }

                // Colonne 2 : fonction
                const tdFn = document.createElement('td');
                tdFn.className = 'gp-fn-cell';
                const icon = statusIcon(row.fn);
                tdFn.innerHTML = `<span class="gp-fn-label">${row.label}</span>` +
                    (icon ? ` <span class="gp-fn-status" title="${(functionInfo[row.fn] || {}).description || ''}">${icon}</span>` : '');
                tr.appendChild(tdFn);

                // Colonne 3 : bouton(s) / axe(s) attribués
                const assigned = findAssignments(row.fn);
                const tdKey = document.createElement('td');
                tdKey.className = 'gp-key-cell';
                if (assigned.buttons.length === 0 && assigned.axes.length === 0) {
                    tdKey.innerHTML = '<span class="gp-key-none">— Non assigné —</span>';
                } else {
                    assigned.buttons.forEach(key => {
                        tdKey.appendChild(makeKeyBadge(formatKeyName(key), key.includes('+') ? 'combo' : 'button'));
                    });
                    assigned.axes.forEach(name => {
                        tdKey.appendChild(makeKeyBadge(formatKeyName(name) + ' (axe)', 'axis'));
                    });
                }
                tr.appendChild(tdKey);

                // Colonne 4 : sensibilité / inversion (uniquement pour les axes)
                const tdAdj = document.createElement('td');
                tdAdj.className = 'gp-adj-cell';
                if (assigned.axes.length > 0) {
                    assigned.axes.forEach(name => tdAdj.appendChild(makeAxisControls(name)));
                } else {
                    tdAdj.innerHTML = '<span class="gp-key-none">—</span>';
                }
                tr.appendChild(tdAdj);

                // Colonne 5 : actions (assigner / effacer)
                const tdAct = document.createElement('td');
                tdAct.className = 'gp-act-cell';
                const btnAssign = document.createElement('button');
                btnAssign.className = 'btn-sm gp-assign-btn';
                btnAssign.textContent = '🎯 Assigner';
                btnAssign.title = row.inputs === 'axis' ? 'Bougez un joystick / une gâchette' :
                                  row.inputs === 'button' ? 'Appuyez sur un bouton ou un combo (2 touches maintenues)' :
                                  'Appuyez sur un bouton/combo ou bougez un axe';
                btnAssign.addEventListener('click', () => enterLearnMode(row, btnAssign));
                tdAct.appendChild(btnAssign);

                const btnClear = document.createElement('button');
                btnClear.className = 'btn-sm gp-clear-btn';
                btnClear.textContent = '✕';
                btnClear.title = 'Effacer l\'assignation';
                btnClear.disabled = assigned.buttons.length === 0 && assigned.axes.length === 0;
                btnClear.addEventListener('click', () => clearFunction(row.fn));
                tdAct.appendChild(btnClear);

                tr.appendChild(tdAct);
                tbody.appendChild(tr);
            });
        });

        if (typeof GamepadVisual !== 'undefined') GamepadVisual.setMapping(currentMapping);
    }

    function makeKeyBadge(text, kind) {
        const span = document.createElement('span');
        span.className = `gp-key-badge gp-key-${kind}`;
        span.textContent = text;
        return span;
    }

    // Contrôles d'un axe assigné : inversion + deadzone + sensibilité
    function makeAxisControls(axisName) {
        const cfg = currentMapping.axes[axisName] || {};
        const wrap = document.createElement('div');
        wrap.className = 'gp-axis-adjust';

        const globalDz = parseInt(document.getElementById('gp-deadzone')?.value || '12');
        const globalSens = parseInt(document.getElementById('gp-sensitivity')?.value || '100');

        const lblInv = document.createElement('label');
        lblInv.className = 'gp-adj-item';
        const cbInv = document.createElement('input');
        cbInv.type = 'checkbox';
        cbInv.checked = !!cfg.invert;
        cbInv.addEventListener('change', () => {
            if (currentMapping.axes[axisName]) {
                currentMapping.axes[axisName].invert = cbInv.checked;
                persistMapping();
            }
        });
        lblInv.appendChild(cbInv);
        lblInv.appendChild(document.createTextNode(' Inverser'));
        wrap.appendChild(lblInv);

        const lblDz = document.createElement('label');
        lblDz.className = 'gp-adj-item';
        lblDz.appendChild(document.createTextNode('DZ '));
        const inDz = document.createElement('input');
        inDz.type = 'number';
        inDz.min = '0'; inDz.max = '30'; inDz.step = '1';
        inDz.value = cfg.deadzone !== undefined && cfg.deadzone !== null ? cfg.deadzone : globalDz;
        inDz.title = 'Zone morte de cet axe (%)';
        inDz.addEventListener('change', () => {
            if (currentMapping.axes[axisName]) {
                currentMapping.axes[axisName].deadzone = Math.max(0, Math.min(30, parseInt(inDz.value) || 0));
                persistMapping();
            }
        });
        lblDz.appendChild(inDz);
        lblDz.appendChild(document.createTextNode('%'));
        wrap.appendChild(lblDz);

        const lblSens = document.createElement('label');
        lblSens.className = 'gp-adj-item';
        lblSens.appendChild(document.createTextNode('Sens '));
        const inSens = document.createElement('input');
        inSens.type = 'number';
        inSens.min = '10'; inSens.max = '150'; inSens.step = '5';
        inSens.value = cfg.sensitivity !== undefined && cfg.sensitivity !== null ? cfg.sensitivity : globalSens;
        inSens.title = 'Sensibilité de cet axe (%)';
        inSens.addEventListener('change', () => {
            if (currentMapping.axes[axisName]) {
                currentMapping.axes[axisName].sensitivity = Math.max(10, Math.min(150, parseInt(inSens.value) || 100));
                persistMapping();
            }
        });
        lblSens.appendChild(inSens);
        lblSens.appendChild(document.createTextNode('%'));
        wrap.appendChild(lblSens);

        return wrap;
    }

    // Toutes les touches/axes où une fonction est assignée
    function findAssignments(fn) {
        const result = { buttons: [], axes: [] };
        Object.entries(currentMapping.buttons || {}).forEach(([k, v]) => {
            if (v && v.function === fn) result.buttons.push(k);
        });
        Object.entries(currentMapping.axes || {}).forEach(([k, v]) => {
            if (v && v.function === fn) result.axes.push(k);
        });
        return result;
    }

    // Supprime toutes les assignations d'une fonction (boutons + axes)
    function removeFunctionAssignments(fn) {
        Object.keys(currentMapping.buttons || {}).forEach(k => {
            if (currentMapping.buttons[k] && currentMapping.buttons[k].function === fn) {
                delete currentMapping.buttons[k];
            }
        });
        Object.keys(currentMapping.axes || {}).forEach(k => {
            if (currentMapping.axes[k] && currentMapping.axes[k].function === fn) {
                delete currentMapping.axes[k];
            }
        });
    }

    function clearFunction(fn) {
        removeFunctionAssignments(fn);
        persistMapping();
        renderMappingTable();
        notify('Assignation effacée');
    }

    // ==========================================================
    // MODE ÉCOUTE — bouton simple, COMBO (touches maintenues) ou axe
    // ==========================================================
    let learnRow = null;            // ligne du catalogue en cours d'assignation
    let learnBtnEl = null;          // bouton "Assigner" actif (feedback visuel)
    let learnPollTimer = null;      // requestAnimationFrame ID
    let learnBaselineAxes = null;   // positions des axes à l'entrée (référence delta)
    let learnIgnoreButtons = null;  // boutons déjà pressés à l'entrée (à ignorer)
    let learnCaptured = null;       // indices capturés, dans l'ordre d'appui
    const LEARN_AXIS_DELTA = 0.5;   // déplacement mini pour détecter un axe

    function enterLearnMode(row, btnEl) {
        exitLearnMode();
        learnRow = row;
        learnBtnEl = btnEl || null;
        learnBaselineAxes = null;
        learnIgnoreButtons = new Set();
        learnCaptured = [];

        if (learnBtnEl) learnBtnEl.classList.add('listening');
        const banner = document.getElementById('gp-learn-banner');
        const msg = document.getElementById('gp-learn-msg');
        if (banner) banner.classList.remove('hidden');
        if (msg) {
            const what = row.inputs === 'axis' ? 'Bougez un joystick ou une gâchette...' :
                         row.inputs === 'button' ? 'Appuyez sur un bouton — maintenez 2 touches pour un combo...' :
                         'Appuyez sur un bouton/combo ou bougez un axe...';
            msg.textContent = `« ${row.label} » — ${what}`;
        }
        learnPollTimer = requestAnimationFrame(learnPoll);
    }

    function learnPoll() {
        if (!learnRow) return;

        const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
        let gp = null;
        for (const p of gamepads) { if (p && p.connected) { gp = p; break; } }

        if (gp) {
            // Première frame : snapshot de référence (axes au repos, boutons déjà pressés)
            if (!learnBaselineAxes) {
                learnBaselineAxes = Array.from(gp.axes);
                for (let i = 0; i < Math.min(gp.buttons.length, 18); i++) {
                    if (gp.buttons[i].pressed) learnIgnoreButtons.add(i);
                }
                learnPollTimer = requestAnimationFrame(learnPoll);
                return;
            }

            const allowButtons = learnRow.inputs !== 'axis';
            const allowAxes = learnRow.inputs !== 'button';

            // 1. Capture des boutons : on accumule TOUTES les touches maintenues
            //    simultanément (combo) et on valide au relâchement complet.
            if (allowButtons) {
                for (let i = 0; i < Math.min(gp.buttons.length, 18); i++) {
                    const pressed = gp.buttons[i].pressed;
                    if (!pressed) { learnIgnoreButtons.delete(i); continue; }
                    if (learnIgnoreButtons.has(i)) continue;
                    if (!learnCaptured.includes(i)) learnCaptured.push(i);
                }

                if (learnCaptured.length > 0) {
                    const names = learnCaptured.map(i => formatKeyName(BUTTON_INDEX_TO_NAME[i]));
                    const msg = document.getElementById('gp-learn-msg');
                    if (msg) msg.textContent = `« ${learnRow.label} » — ${names.join(' + ')} … relâchez pour valider`;

                    const anyHeld = learnCaptured.some(i => gp.buttons[i] && gp.buttons[i].pressed);
                    if (!anyHeld) {
                        commitButtonAssignment(learnCaptured.slice());
                        return;
                    }
                }
            }

            // 2. Détection d'axe (delta par rapport au repos) — seulement si
            //    aucune capture bouton n'est en cours.
            if (allowAxes && learnCaptured.length === 0) {
                for (let i = 0; i < Math.min(gp.axes.length, 6); i++) {
                    if (Math.abs(gp.axes[i] - learnBaselineAxes[i]) > LEARN_AXIS_DELTA) {
                        commitAxisAssignment(i);
                        return;
                    }
                }
            }
        }

        learnPollTimer = requestAnimationFrame(learnPoll);
    }

    // Validation d'un bouton simple ou d'un combo → clé "L1+CROSS"
    function commitButtonAssignment(indices) {
        const row = learnRow;
        const names = indices.map(i => BUTTON_INDEX_TO_NAME[i]).filter(Boolean);
        if (!row || names.length === 0) { exitLearnMode(); return; }
        const key = names.join('+');

        removeFunctionAssignments(row.fn);
        // Une même clé ne porte qu'une fonction : l'assignation remplace l'ancienne
        currentMapping.buttons[key] = {
            function: row.fn,
            action: row.hold ? 'hold' : 'press',
        };

        console.log(`[GamepadConfig] Attribué: ${row.fn} → ${key}${names.length > 1 ? ' (combo)' : ''}`);
        exitLearnMode();
        persistMapping();
        renderMappingTable();
        flashRow(row.fn);
        notify(`✅ ${row.label} → ${formatKeyName(key)}`);
    }

    // Validation d'un axe
    function commitAxisAssignment(axisIndex) {
        const row = learnRow;
        const name = AXIS_INDEX_TO_NAME[axisIndex];
        if (!row || !name) { exitLearnMode(); return; }

        const prev = currentMapping.axes[name];
        removeFunctionAssignments(row.fn);
        currentMapping.axes[name] = {
            function: row.fn,
            invert: prev ? !!prev.invert : false,
        };
        if (prev && prev.deadzone !== undefined) currentMapping.axes[name].deadzone = prev.deadzone;
        if (prev && prev.sensitivity !== undefined) currentMapping.axes[name].sensitivity = prev.sensitivity;

        console.log(`[GamepadConfig] Attribué: ${row.fn} → axe ${name}`);
        exitLearnMode();
        persistMapping();
        renderMappingTable();
        flashRow(row.fn);
        notify(`✅ ${row.label} → ${formatKeyName(name)} (axe)`);
    }

    function exitLearnMode() {
        learnRow = null;
        if (learnPollTimer) {
            cancelAnimationFrame(learnPollTimer);
            learnPollTimer = null;
        }
        if (learnBtnEl) { learnBtnEl.classList.remove('listening'); learnBtnEl = null; }
        const banner = document.getElementById('gp-learn-banner');
        if (banner) banner.classList.add('hidden');
    }

    function flashRow(fn) {
        setTimeout(() => {
            const tr = document.querySelector(`#gp-map-table-body tr[data-fn="${fn}"]`);
            if (tr) {
                tr.classList.add('highlight');
                setTimeout(() => tr.classList.remove('highlight'), 900);
            }
        }, 50);
    }

    // ==========================================================
    // RÉINITIALISATION / EXPORT / IMPORT DU MAPPING
    // ==========================================================
    function resetToDefaults() {
        if (!confirm('Réinitialiser le mapping aux valeurs par défaut ?')) return;
        currentMapping = JSON.parse(JSON.stringify(DEFAULT_MAPPING));
        persistMapping();
        renderMappingTable();
        notify('Mapping réinitialisé aux valeurs par défaut');
    }

    function exportMappingJson() {
        downloadJson({
            name: currentProfile || 'mapping',
            mappings: { buttons: currentMapping.buttons || {}, axes: currentMapping.axes || {} },
            settings: getSettingsFromUI(),
        }, `mapping_manette_${(currentProfile || 'export').replace(/\s+/g, '_')}.json`);
        notify('Mapping exporté en JSON');
    }

    function importMappingJson() {
        const fileInput = document.getElementById('gp-map-import-file');
        if (fileInput) fileInput.click();
    }

    async function handleMappingImportFile(event) {
        const file = event.target.files[0];
        if (!file) return;
        try {
            const data = JSON.parse(await file.text());
            // Accepte { mappings: {buttons, axes} } ou directement { buttons, axes }
            const m = data.mappings || data;
            if (!m || typeof m !== 'object' || (!m.buttons && !m.axes)) {
                notify('JSON invalide : clés "buttons"/"axes" absentes');
            } else {
                currentMapping = { buttons: m.buttons || {}, axes: m.axes || {} };
                if (data.settings) renderSettings(data.settings);
                persistMapping();
                renderMappingTable();
                notify('Mapping importé !');
            }
        } catch (e) {
            notify('Fichier JSON invalide');
        }
        event.target.value = '';
    }

    function downloadJson(obj, filename) {
        const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    // ==========================================================
    // HELPERS
    // ==========================================================
    function formatKeyName(key) {
        const names = {
            'CROSS': '✕ Croix', 'CIRCLE': '○ Cercle', 'SQUARE': '□ Carré', 'TRIANGLE': '△ Triangle',
            'L1': 'L1', 'R1': 'R1', 'L2': 'L2', 'R2': 'R2', 'L3': 'L3', 'R3': 'R3',
            'SHARE': 'Share', 'OPTIONS': 'Options', 'PS': 'PS', 'TOUCHPAD': 'Touchpad',
            'DPAD_UP': '↑ D-Pad', 'DPAD_DOWN': '↓ D-Pad', 'DPAD_LEFT': '← D-Pad', 'DPAD_RIGHT': '→ D-Pad',
            'LEFT_X': 'Stick G ↔', 'LEFT_Y': 'Stick G ↕', 'RIGHT_X': 'Stick D ↔', 'RIGHT_Y': 'Stick D ↕',
        };
        if (key.includes('+')) {
            return key.split('+').map(k => names[k] || k).join(' + ');
        }
        return names[key] || key;
    }

    function notify(msg) {
        if (typeof App !== 'undefined' && App.showNotification) App.showNotification(msg);
    }

    // ==========================================================
    // SETTINGS GLOBAUX
    // ==========================================================
    function renderSettings(settings) {
        if (!settings) return;
        const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
        const setCheck = (id, val) => { const el = document.getElementById(id); if (el) el.checked = !!val; };

        if (settings.sensitivity !== undefined) {
            setVal('gp-sensitivity', settings.sensitivity);
            const valEl = document.getElementById('gp-sensitivity-val');
            if (valEl) valEl.textContent = settings.sensitivity + '%';
        }
        if (settings.deadzone !== undefined) {
            setVal('gp-deadzone', settings.deadzone);
            const valEl = document.getElementById('gp-deadzone-val');
            if (valEl) valEl.textContent = settings.deadzone + '%';
        }
        if (settings.response_curve) setVal('gp-response-curve', settings.response_curve);
        if (settings.invert_x !== undefined) setCheck('gp-invert-x', settings.invert_x);
        if (settings.invert_y !== undefined) setCheck('gp-invert-y', settings.invert_y);
        if (settings.vibration !== undefined) setCheck('gp-vibration', settings.vibration);
        if (settings.vibration_intensity !== undefined) {
            setVal('gp-vibration-intensity', settings.vibration_intensity);
            const valEl = document.getElementById('gp-vibration-intensity-val');
            if (valEl) valEl.textContent = settings.vibration_intensity + '%';
        }
        if (settings.repeat_delay !== undefined) setVal('gp-repeat-delay', settings.repeat_delay);
    }

    function getSettingsFromUI() {
        return {
            sensitivity: parseInt(document.getElementById('gp-sensitivity')?.value || '100'),
            deadzone: parseInt(document.getElementById('gp-deadzone')?.value || '12'),
            response_curve: document.getElementById('gp-response-curve')?.value || 'linear',
            invert_x: document.getElementById('gp-invert-x')?.checked || false,
            invert_y: document.getElementById('gp-invert-y')?.checked || false,
            vibration: document.getElementById('gp-vibration')?.checked || false,
            vibration_intensity: parseInt(document.getElementById('gp-vibration-intensity')?.value || '80'),
            repeat_delay: parseInt(document.getElementById('gp-repeat-delay')?.value || '200')
        };
    }

    function buildProfileFromUI(name) {
        return {
            name: name || currentProfile || 'Profil',
            mappings: {
                buttons: currentMapping.buttons || {},
                axes: currentMapping.axes || {},
            },
            settings: getSettingsFromUI()
        };
    }

    // ==========================================================
    // EVENT LISTENERS
    // ==========================================================
    function setupEventListeners() {
        // --- Profils ---
        const btnApply = document.getElementById('gp-profile-apply');
        if (btnApply) btnApply.addEventListener('click', () => setActiveProfile());
        const btnSave = document.getElementById('gp-profile-save');
        if (btnSave) btnSave.addEventListener('click', saveProfile);
        const btnNew = document.getElementById('gp-profile-new');
        if (btnNew) btnNew.addEventListener('click', createNewProfile);
        const btnDelete = document.getElementById('gp-profile-delete');
        if (btnDelete) btnDelete.addEventListener('click', () => deleteProfile());
        const btnExport = document.getElementById('gp-profile-export');
        if (btnExport) btnExport.addEventListener('click', () => exportProfile());
        const btnImport = document.getElementById('gp-profile-import');
        if (btnImport) btnImport.addEventListener('click', importProfile);
        const fileInput = document.getElementById('gp-import-file');
        if (fileInput) fileInput.addEventListener('change', handleImportFile);

        // --- Modal création profil ---
        const btnNewConfirm = document.getElementById('gp-new-confirm');
        if (btnNewConfirm) btnNewConfirm.addEventListener('click', confirmCreateProfile);
        const btnNewCancel = document.getElementById('gp-new-cancel');
        if (btnNewCancel) btnNewCancel.addEventListener('click', closeCreateProfileModal);
        const modalOverlay = document.getElementById('gp-new-profile-modal');
        if (modalOverlay) {
            modalOverlay.addEventListener('click', (e) => {
                if (e.target === modalOverlay) closeCreateProfileModal();
            });
        }
        const nameInput = document.getElementById('gp-new-name');
        if (nameInput) {
            nameInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') confirmCreateProfile();
                if (e.key === 'Escape') closeCreateProfileModal();
            });
        }

        // --- Barres d'actions du tableau (haut ET bas) ---
        document.querySelectorAll('.gp-map-save').forEach(b => b.addEventListener('click', saveProfile));
        document.querySelectorAll('.gp-map-reset').forEach(b => b.addEventListener('click', resetToDefaults));
        document.querySelectorAll('.gp-map-export').forEach(b => b.addEventListener('click', exportMappingJson));
        document.querySelectorAll('.gp-map-import').forEach(b => b.addEventListener('click', importMappingJson));
        const mapImportFile = document.getElementById('gp-map-import-file');
        if (mapImportFile) mapImportFile.addEventListener('change', handleMappingImportFile);

        // --- Mode écoute ---
        const btnCancel = document.getElementById('gp-learn-cancel');
        if (btnCancel) btnCancel.addEventListener('click', exitLearnMode);
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && learnRow) exitLearnMode();
        });

        // --- Settings globaux (affichage live + persistance immédiate) ---
        const bindRange = (id, valId) => {
            const el = document.getElementById(id);
            const valEl = valId ? document.getElementById(valId) : null;
            if (!el) return;
            el.addEventListener('input', () => { if (valEl) valEl.textContent = el.value + '%'; });
            el.addEventListener('change', () => persistMapping({ post: false }));
        };
        bindRange('gp-sensitivity', 'gp-sensitivity-val');
        bindRange('gp-deadzone', 'gp-deadzone-val');
        bindRange('gp-vibration-intensity', 'gp-vibration-intensity-val');
        ['gp-response-curve', 'gp-invert-x', 'gp-invert-y', 'gp-vibration', 'gp-repeat-delay'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('change', () => persistMapping({ post: false }));
        });

        // --- Visualisation SVG ---
        if (typeof GamepadVisual !== 'undefined') {
            GamepadVisual.init('gamepad-svg-container');
        }

        // --- Test en direct ---
        const btnTestStart = document.getElementById('gp-test-start');
        if (btnTestStart) btnTestStart.addEventListener('click', () => {
            if (typeof GamepadTest !== 'undefined') {
                GamepadTest.start();
                btnTestStart.disabled = true;
                const btnStop = document.getElementById('gp-test-stop');
                if (btnStop) btnStop.disabled = false;
            }
        });
        const btnTestStop = document.getElementById('gp-test-stop');
        if (btnTestStop) btnTestStop.addEventListener('click', () => {
            if (typeof GamepadTest !== 'undefined') {
                GamepadTest.stop();
                btnTestStop.disabled = true;
                const btnStart = document.getElementById('gp-test-start');
                if (btnStart) btnStart.disabled = false;
            }
        });
    }

    return { init, save: saveProfile, load: loadProfiles, exitLearnMode };
})();
