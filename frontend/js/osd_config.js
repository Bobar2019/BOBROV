/**
 * BOB-ROV — Module Configuration OSD
 * Personnalisation des couleurs, positions et transparence de l'OSD
 */
'use strict';

const OSDConfig = (() => {

    // Helper : conversion booléenne robuste (accepte bool, string, int)
    function _toBool(v) {
        if (typeof v === 'boolean') return v;
        if (typeof v === 'number') return v === 1;
        if (typeof v === 'string') {
            const s = v.toLowerCase().trim();
            return s === 'true' || s === '1' || s === 'yes' || s === 'on';
        }
        return false;
    }

    // Valeurs par défaut
    const DEFAULTS = {
        show_horizon: true, show_depth: true, show_temperature: true,
        show_battery: true, show_compass: true, show_fps: true, show_motors: true,
        show_rov3d: true, show_clock: true, show_armed: true,
        show_gamepad_battery: true, show_display_mode: true,
        horizon_color: '#00FF88', depth_color: '#00AAFF', temperature_color: '#FFAA00',
        compass_color: '#FFFFFF', battery_color: '#00CC44', fps_color: '#FFFFFF',
        primary_color: '#00FF00', font_scale: 0.8, opacity: 100,
        depth_opacity: 100, temperature_opacity: 100,
        compass_opacity: 100, battery_opacity: 100, motors_opacity: 100,
        horizon_opacity: 100, rov3d_opacity: 100,
        fps_opacity: 100, clock_opacity: 100, armed_opacity: 100,
        gamepad_battery_opacity: 100, display_mode_opacity: 100,
        horizon_x: 50, horizon_y: 50, depth_x: 3, depth_y: 15,
        temperature_x: 88, temperature_y: 5, compass_x: 50, compass_y: 92,
        battery_x: 88, battery_y: 12, fps_x: 2, fps_y: 82,
        horizon_line_thick: 2, horizon_circle_opacity: 15, horizon_border_opacity: 25,
        horizon_radius_pct: 18, horizon_pitch_scale: 2, horizon_wing_color: '#FFFF00',
        horizon_show_text: true, horizon_clip: false, horizon_damping: 5,
        motors_x: 1, motors_y: 82,
        rov3d_x: 99, rov3d_y: 99,
        clock_x: 99, clock_y: 98,
        armed_x: 50, armed_y: 6,
        gamepad_battery_x: 2, gamepad_battery_y: 75,
        display_mode_x: 98, display_mode_y: 3
    };

    // ==========================================================
    // INITIALISATION
    // ==========================================================
    function init() {
        const btnSave = document.getElementById('btn-save-osd');
        if (btnSave) btnSave.addEventListener('click', save);

        const btnReset = document.getElementById('btn-reset-osd');
        if (btnReset) btnReset.addEventListener('click', resetToDefaults);

        // Sliders avec affichage en direct
        const opacitySlider = document.getElementById('cfg-opacity');
        const opacityVal = document.getElementById('opacity-val');
        if (opacitySlider && opacityVal) {
            opacitySlider.addEventListener('input', () => {
                opacityVal.textContent = `${opacitySlider.value}%`;
                _applyLive({ opacity: parseInt(opacitySlider.value) });
            });
        }

        // Sliders opacité par élément
        const elemOpacitySliders = [
            { id: 'cfg-horizon-opacity',     valId: 'horizon-opacity-val',     key: 'horizon_opacity' },
            { id: 'cfg-depth-opacity',       valId: 'depth-opacity-val',       key: 'depth_opacity' },
            { id: 'cfg-temperature-opacity', valId: 'temperature-opacity-val', key: 'temperature_opacity' },
            { id: 'cfg-compass-opacity',     valId: 'compass-opacity-val',     key: 'compass_opacity' },
            { id: 'cfg-battery-opacity',     valId: 'battery-opacity-val',     key: 'battery_opacity' },
            { id: 'cfg-motors-opacity',      valId: 'motors-opacity-val',      key: 'motors_opacity' },
            { id: 'cfg-rov3d-opacity',       valId: 'rov3d-opacity-val',       key: 'rov3d_opacity' },
            { id: 'cfg-fps-opacity',         valId: 'fps-opacity-val',         key: 'fps_opacity' },
            { id: 'cfg-clock-opacity',       valId: 'clock-opacity-val',       key: 'clock_opacity' },
            { id: 'cfg-armed-opacity',       valId: 'armed-opacity-val',       key: 'armed_opacity' },
            { id: 'cfg-gamepad-battery-opacity', valId: 'gamepad-battery-opacity-val', key: 'gamepad_battery_opacity' },
            { id: 'cfg-display-mode-opacity', valId: 'display-mode-opacity-val', key: 'display_mode_opacity' }
        ];
        elemOpacitySliders.forEach(({ id, valId, key }) => {
            const slider = document.getElementById(id);
            const display = document.getElementById(valId);
            if (slider && display) {
                slider.addEventListener('input', () => {
                    display.textContent = slider.value + '%';
                    _applyLive({ [key]: parseInt(slider.value) });
                });
            }
        });

        const fontSlider = document.getElementById('cfg-font-scale');
        const fontVal = document.getElementById('font-scale-value');
        if (fontSlider && fontVal) {
            fontSlider.addEventListener('input', () => {
                fontVal.textContent = fontSlider.value;
                _applyLive({ font_scale: parseFloat(fontSlider.value) });
            });
        }

        // Sliders horizon avancés
        const horizonSliders = [
            { id: 'cfg-horizon-line-thick',    valId: 'horizon-line-thick-val',     key: 'horizon_line_thick',     suffix: 'px', parse: parseFloat },
            { id: 'cfg-horizon-circle-opacity', valId: 'horizon-circle-opacity-val', key: 'horizon_circle_opacity', suffix: '%',   parse: parseInt },
            { id: 'cfg-horizon-border-opacity', valId: 'horizon-border-opacity-val', key: 'horizon_border_opacity', suffix: '%',   parse: parseInt },
            { id: 'cfg-horizon-radius-pct',     valId: 'horizon-radius-pct-val',     key: 'horizon_radius_pct',     suffix: '%',   parse: parseInt },
            { id: 'cfg-horizon-pitch-scale',    valId: 'horizon-pitch-scale-val',    key: 'horizon_pitch_scale',    suffix: 'x',  parse: parseInt },
            { id: 'cfg-horizon-damping',        valId: 'horizon-damping-val',        key: 'horizon_damping',        suffix: '',   parse: parseInt }
        ];
        horizonSliders.forEach(({ id, valId, key, suffix, parse }) => {
            const slider = document.getElementById(id);
            const display = document.getElementById(valId);
            if (slider && display) {
                slider.addEventListener('input', () => {
                    display.textContent = slider.value + suffix;
                    _applyLive({ [key]: parse(slider.value) });
                });
            }
        });

        // Couleur ailes (live)
        const wingColor = document.getElementById('cfg-horizon-wing-color');
        if (wingColor) {
            wingColor.addEventListener('input', () => {
                _applyLive({ horizon_wing_color: wingColor.value });
            });
        }

        // Texte R/P (live)
        const showText = document.getElementById('cfg-horizon-show-text');
        if (showText) {
            showText.addEventListener('change', () => {
                _applyLive({ horizon_show_text: showText.checked });
            });
        }

        // Clip horizon au cercle (live)
        const clipHorizon = document.getElementById('cfg-horizon-clip');
        if (clipHorizon) {
            clipHorizon.addEventListener('change', () => {
                _applyLive({ horizon_clip: clipHorizon.checked });
            });
        }

        // Checkboxes : appliquer en direct
        ['show_horizon', 'show_depth', 'show_temperature', 'show_battery', 'show_compass', 'show_fps', 'show_motors', 'show_rov3d', 'show_clock', 'show_armed', 'show_gamepad_battery', 'show_display_mode'].forEach(key => {
            const el = document.getElementById(`cfg-${key.replace(/_/g, '-')}`);
            if (el) {
                el.addEventListener('change', () => {
                    _applyLive({ [key]: el.checked });
                });
            }
        });

        // Couleurs : appliquer en direct
        ['horizon', 'depth', 'temperature', 'compass', 'battery', 'fps', 'primary'].forEach(name => {
            const el = document.getElementById(`cfg-${name}-color`);
            if (el) {
                el.addEventListener('input', () => {
                    _applyLive({ [`${name}_color`]: el.value });
                });
            }
        });

        // Positions : appliquer en direct
        ['horizon-x', 'horizon-y', 'depth-x', 'depth-y', 'temperature-x', 'temperature-y',
         'compass-x', 'compass-y', 'battery-x', 'battery-y'].forEach(id => {
            const el = document.getElementById(`cfg-${id}`);
            if (el) {
                el.addEventListener('change', () => {
                    const key = id.replace(/-/g, '_');
                    _applyLive({ [key]: parseInt(el.value) || 0 });
                });
            }
        });

        // Upload modèle 3D Rov3D
        const btnUpload = document.getElementById('btn-rov3d-upload');
        if (btnUpload) {
            btnUpload.addEventListener('click', async () => {
                const fileInput = document.getElementById('cfg-rov3d-file');
                const statusEl = document.getElementById('rov3d-upload-status');
                if (!fileInput || !fileInput.files || !fileInput.files[0]) {
                    if (statusEl) { statusEl.textContent = '⚠ Aucun fichier sélectionné'; statusEl.style.color = '#FF4444'; }
                    return;
                }
                const file = fileInput.files[0];
                if (statusEl) { statusEl.textContent = '⏳ Envoi en cours...'; statusEl.style.color = '#FFAA00'; }
                try {
                    if (window.Rov3D && window.Rov3D.uploadModel) {
                        await window.Rov3D.uploadModel(file);
                    } else {
                        // Fallback si le module n'est pas encore chargé
                        const formData = new FormData();
                        formData.append('file', file);
                        const resp = await fetch('/api/rov3d/upload', { method: 'POST', body: formData });
                        if (!resp.ok) throw new Error(`Erreur ${resp.status}`);
                    }
                    if (statusEl) { statusEl.textContent = '✔ Modèle importé !'; statusEl.style.color = '#44FF44'; }
                    fileInput.value = '';
                } catch (err) {
                    console.error('[Rov3D] Upload error:', err);
                    if (statusEl) { statusEl.textContent = '❌ ' + err.message; statusEl.style.color = '#FF4444'; }
                }
            });
        }

        // Charger la config actuelle
        load();

        // === PANNEAU MISE EN PAGE (Drag & Drop) ===
        _initLayoutPanel();
    }

    // ==========================================================
    // APPLICATION EN TEMPS RÉEL (pendant l'édition)
    // ==========================================================
    let _liveTimeout = null;
    let _liveQueue = {};

    function _applyLive(params) {
        // Mettre à jour le preview canvas immédiatement (pas besoin d'attendre le round-trip API)
        if (typeof Telemetry !== 'undefined') {
            Telemetry.updateOSDConfig(params);
        }
        // Accumuler les changements et envoyer groupé (debounce 1000ms — 1 MAJ/sec)
        Object.assign(_liveQueue, params);
        if (_liveTimeout) clearTimeout(_liveTimeout);
        _liveTimeout = setTimeout(() => {
            const toSend = { ..._liveQueue };
            _liveQueue = {};
            fetch('/api/osd/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(toSend)
            }).catch(() => {});
        }, 1000);
    }

    // ==========================================================
    // CHARGEMENT
    // ==========================================================
    function load() {
        fetch('/api/config')
            .then(r => r.json())
            .then(config => {
                const osd = config.OSD_DISPLAY || {};

                // Checkboxes
                App.setCheckbox('cfg-show-horizon', _toBool(osd.show_horizon));
                App.setCheckbox('cfg-show-depth', _toBool(osd.show_depth));
                App.setCheckbox('cfg-show-temperature', _toBool(osd.show_temperature));
                App.setCheckbox('cfg-show-battery', _toBool(osd.show_battery));
                App.setCheckbox('cfg-show-compass', _toBool(osd.show_compass));
                App.setCheckbox('cfg-show-fps', _toBool(osd.show_fps));
                App.setCheckbox('cfg-show-motors', _toBool(osd.show_motors !== undefined ? osd.show_motors : true));
                App.setCheckbox('cfg-show-rov3d', _toBool(osd.show_rov3d !== undefined ? osd.show_rov3d : true));
                App.setCheckbox('cfg-show-clock', _toBool(osd.show_clock !== undefined ? osd.show_clock : true));
                App.setCheckbox('cfg-show-armed', _toBool(osd.show_armed !== undefined ? osd.show_armed : true));
                App.setCheckbox('cfg-show-gamepad-battery', _toBool(osd.show_gamepad_battery !== undefined ? osd.show_gamepad_battery : true));
                App.setCheckbox('cfg-show-display-mode', _toBool(osd.show_display_mode !== undefined ? osd.show_display_mode : true));

                // Couleurs
                setColor('cfg-horizon-color', osd.horizon_color);
                setColor('cfg-depth-color', osd.depth_color);
                setColor('cfg-temperature-color', osd.temperature_color);
                setColor('cfg-compass-color', osd.compass_color);
                setColor('cfg-battery-color', osd.battery_color);
                setColor('cfg-fps-color', osd.fps_color);
                setColor('cfg-primary-color', osd.primary_color);

                // Sliders
                const opacity = document.getElementById('cfg-opacity');
                if (opacity) { opacity.value = osd.opacity || 100; document.getElementById('opacity-val').textContent = `${opacity.value}%`; }

                // Sliders opacité par élément
                _setSlider('cfg-horizon-opacity',     osd.horizon_opacity || 100,     'horizon-opacity-val',     '%');
                _setSlider('cfg-depth-opacity',       osd.depth_opacity || 100,       'depth-opacity-val',       '%');
                _setSlider('cfg-temperature-opacity', osd.temperature_opacity || 100, 'temperature-opacity-val', '%');
                _setSlider('cfg-compass-opacity',     osd.compass_opacity || 100,     'compass-opacity-val',     '%');
                _setSlider('cfg-battery-opacity',     osd.battery_opacity || 100,     'battery-opacity-val',     '%');
                _setSlider('cfg-motors-opacity',      osd.motors_opacity || 100,      'motors-opacity-val',      '%');
                _setSlider('cfg-rov3d-opacity',       osd.rov3d_opacity || 100,       'rov3d-opacity-val',       '%');
                _setSlider('cfg-fps-opacity',         osd.fps_opacity || 100,         'fps-opacity-val',         '%');
                _setSlider('cfg-clock-opacity',       osd.clock_opacity || 100,       'clock-opacity-val',       '%');
                _setSlider('cfg-armed-opacity',       osd.armed_opacity || 100,       'armed-opacity-val',       '%');
                _setSlider('cfg-gamepad-battery-opacity', osd.gamepad_battery_opacity || 100, 'gamepad-battery-opacity-val', '%');
                _setSlider('cfg-display-mode-opacity', osd.display_mode_opacity || 100, 'display-mode-opacity-val', '%');

                const fontScale = document.getElementById('cfg-font-scale');
                if (fontScale) { fontScale.value = osd.font_scale || 0.8; document.getElementById('font-scale-value').textContent = fontScale.value; }

                // Sliders horizon
                _setSlider('cfg-horizon-line-thick',     osd.horizon_line_thick,     'horizon-line-thick-val',     'px');
                _setSlider('cfg-horizon-circle-opacity', osd.horizon_circle_opacity, 'horizon-circle-opacity-val', '%');
                _setSlider('cfg-horizon-border-opacity', osd.horizon_border_opacity, 'horizon-border-opacity-val', '%');
                _setSlider('cfg-horizon-radius-pct',     osd.horizon_radius_pct,     'horizon-radius-pct-val',     '%');
                _setSlider('cfg-horizon-pitch-scale',    osd.horizon_pitch_scale,    'horizon-pitch-scale-val',    'x');
                _setSlider('cfg-horizon-damping',        osd.horizon_damping,        'horizon-damping-val',        '');
                setColor('cfg-horizon-wing-color', osd.horizon_wing_color || '#FFFF00');
                App.setCheckbox('cfg-horizon-show-text', _toBool(osd.horizon_show_text));
                App.setCheckbox('cfg-horizon-clip', _toBool(osd.horizon_clip));

                // Positions
                setNumber('cfg-horizon-x', osd.horizon_x);
                setNumber('cfg-horizon-y', osd.horizon_y);
                setNumber('cfg-depth-x', osd.depth_x);
                setNumber('cfg-depth-y', osd.depth_y);
                setNumber('cfg-temperature-x', osd.temperature_x);
                setNumber('cfg-temperature-y', osd.temperature_y);
                setNumber('cfg-compass-x', osd.compass_x);
                setNumber('cfg-compass-y', osd.compass_y);
                setNumber('cfg-battery-x', osd.battery_x);
                setNumber('cfg-battery-y', osd.battery_y);

                // Mettre à jour le module Telemetry
                // (sans les clés de position, gérées par osd_layouts.json)
                if (typeof Telemetry !== 'undefined') {
                    const layoutKeys = [
                        'horizon_x', 'horizon_y', 'depth_x', 'depth_y',
                        'temperature_x', 'temperature_y', 'compass_x', 'compass_y',
                        'battery_x', 'battery_y', 'fps_x', 'fps_y',
                        'motors_x', 'motors_y', 'rov3d_x', 'rov3d_y',
                        'clock_x', 'clock_y',
                        'armed_x', 'armed_y',
                        'gamepad_battery_x', 'gamepad_battery_y',
                        'display_mode_x', 'display_mode_y'
                    ];
                    const filtered = {};
                    for (const [k, v] of Object.entries(osd)) {
                        if (!layoutKeys.includes(k)) filtered[k] = v;
                    }
                    Telemetry.updateOSDConfig(filtered);
                }
            })
            .catch(err => console.error('[OSD Config] Erreur chargement:', err));
    }

    // ==========================================================
    // SAUVEGARDE
    // ==========================================================
    function save() {
        const config = {
            show_horizon: App.getCheckbox('cfg-show-horizon'),
            show_depth: App.getCheckbox('cfg-show-depth'),
            show_temperature: App.getCheckbox('cfg-show-temperature'),
            show_battery: App.getCheckbox('cfg-show-battery'),
            show_compass: App.getCheckbox('cfg-show-compass'),
            show_fps: App.getCheckbox('cfg-show-fps'),
            show_motors: App.getCheckbox('cfg-show-motors'),
            show_rov3d: App.getCheckbox('cfg-show-rov3d'),
            show_clock: App.getCheckbox('cfg-show-clock'),
            show_armed: App.getCheckbox('cfg-show-armed'),
            show_gamepad_battery: App.getCheckbox('cfg-show-gamepad-battery'),
            show_display_mode: App.getCheckbox('cfg-show-display-mode'),
            horizon_color: getColor('cfg-horizon-color'),
            depth_color: getColor('cfg-depth-color'),
            temperature_color: getColor('cfg-temperature-color'),
            compass_color: getColor('cfg-compass-color'),
            battery_color: getColor('cfg-battery-color'),
            fps_color: getColor('cfg-fps-color'),
            primary_color: getColor('cfg-primary-color'),
            opacity: parseInt(document.getElementById('cfg-opacity')?.value || '100'),
            horizon_opacity: parseInt(document.getElementById('cfg-horizon-opacity')?.value || '100'),
            depth_opacity: parseInt(document.getElementById('cfg-depth-opacity')?.value || '100'),
            temperature_opacity: parseInt(document.getElementById('cfg-temperature-opacity')?.value || '100'),
            compass_opacity: parseInt(document.getElementById('cfg-compass-opacity')?.value || '100'),
            battery_opacity: parseInt(document.getElementById('cfg-battery-opacity')?.value || '100'),
            motors_opacity: parseInt(document.getElementById('cfg-motors-opacity')?.value || '100'),
            rov3d_opacity: parseInt(document.getElementById('cfg-rov3d-opacity')?.value || '100'),
            fps_opacity: parseInt(document.getElementById('cfg-fps-opacity')?.value || '100'),
            clock_opacity: parseInt(document.getElementById('cfg-clock-opacity')?.value || '100'),
            armed_opacity: parseInt(document.getElementById('cfg-armed-opacity')?.value || '100'),
            gamepad_battery_opacity: parseInt(document.getElementById('cfg-gamepad-battery-opacity')?.value || '100'),
            display_mode_opacity: parseInt(document.getElementById('cfg-display-mode-opacity')?.value || '100'),
            font_scale: parseFloat(document.getElementById('cfg-font-scale')?.value || '0.8'),
            horizon_line_thick: parseFloat(document.getElementById('cfg-horizon-line-thick')?.value || '2'),
            horizon_circle_opacity: parseInt(document.getElementById('cfg-horizon-circle-opacity')?.value || '15'),
            horizon_border_opacity: parseInt(document.getElementById('cfg-horizon-border-opacity')?.value || '25'),
            horizon_radius_pct: parseInt(document.getElementById('cfg-horizon-radius-pct')?.value || '18'),
            horizon_pitch_scale: parseInt(document.getElementById('cfg-horizon-pitch-scale')?.value || '2'),
            horizon_damping: parseInt(document.getElementById('cfg-horizon-damping')?.value || '5'),
            horizon_wing_color: getColor('cfg-horizon-wing-color') || '#FFFF00',
            horizon_show_text: App.getCheckbox('cfg-horizon-show-text'),
            horizon_clip: App.getCheckbox('cfg-horizon-clip'),
            horizon_x: getNumber('cfg-horizon-x'),
            horizon_y: getNumber('cfg-horizon-y'),
            depth_x: getNumber('cfg-depth-x'),
            depth_y: getNumber('cfg-depth-y'),
            temperature_x: getNumber('cfg-temperature-x'),
            temperature_y: getNumber('cfg-temperature-y'),
            compass_x: getNumber('cfg-compass-x'),
            compass_y: getNumber('cfg-compass-y'),
            battery_x: getNumber('cfg-battery-x'),
            battery_y: getNumber('cfg-battery-y')
        };

        fetch('/api/osd/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(config)
        })
        .then(r => r.json())
        .then(data => {
            console.log('[OSD] Config sauvegardée:', data);
            // Mettre à jour le rendu OSD en direct
            Telemetry.updateOSDConfig(config);
            App.showNotification('Configuration OSD sauvegardée !');
        })
        .catch(err => console.error('[OSD] Erreur:', err));
    }

    // ==========================================================
    // RÉINITIALISATION
    // ==========================================================
    function resetToDefaults() {
        App.setCheckbox('cfg-show-horizon', true);
        App.setCheckbox('cfg-show-depth', true);
        App.setCheckbox('cfg-show-temperature', true);
        App.setCheckbox('cfg-show-battery', true);
        App.setCheckbox('cfg-show-compass', true);
        App.setCheckbox('cfg-show-fps', true);
        App.setCheckbox('cfg-show-motors', true);
        App.setCheckbox('cfg-show-rov3d', true);
        App.setCheckbox('cfg-show-clock', true);
        App.setCheckbox('cfg-show-armed', true);
        App.setCheckbox('cfg-show-gamepad-battery', true);
        App.setCheckbox('cfg-show-display-mode', true);

        setColor('cfg-horizon-color', DEFAULTS.horizon_color);
        setColor('cfg-depth-color', DEFAULTS.depth_color);
        setColor('cfg-temperature-color', DEFAULTS.temperature_color);
        setColor('cfg-compass-color', DEFAULTS.compass_color);
        setColor('cfg-battery-color', DEFAULTS.battery_color);
        setColor('cfg-fps-color', DEFAULTS.fps_color);
        setColor('cfg-primary-color', DEFAULTS.primary_color);

        const opacity = document.getElementById('cfg-opacity');
        if (opacity) { opacity.value = 100; document.getElementById('opacity-val').textContent = '100%'; }

        _setSlider('cfg-horizon-opacity', 100, 'horizon-opacity-val', '%');
        _setSlider('cfg-depth-opacity', 100, 'depth-opacity-val', '%');
        _setSlider('cfg-temperature-opacity', 100, 'temperature-opacity-val', '%');
        _setSlider('cfg-compass-opacity', 100, 'compass-opacity-val', '%');
        _setSlider('cfg-battery-opacity', 100, 'battery-opacity-val', '%');
        _setSlider('cfg-motors-opacity', 100, 'motors-opacity-val', '%');
        _setSlider('cfg-rov3d-opacity', 100, 'rov3d-opacity-val', '%');
        _setSlider('cfg-fps-opacity', 100, 'fps-opacity-val', '%');
        _setSlider('cfg-clock-opacity', 100, 'clock-opacity-val', '%');
        _setSlider('cfg-armed-opacity', 100, 'armed-opacity-val', '%');
        _setSlider('cfg-gamepad-battery-opacity', 100, 'gamepad-battery-opacity-val', '%');
        _setSlider('cfg-display-mode-opacity', 100, 'display-mode-opacity-val', '%');

        const fontScale = document.getElementById('cfg-font-scale');
        if (fontScale) { fontScale.value = 0.8; document.getElementById('font-scale-value').textContent = '0.8'; }

        _setSlider('cfg-horizon-line-thick', 2, 'horizon-line-thick-val', 'px');
        _setSlider('cfg-horizon-circle-opacity', 15, 'horizon-circle-opacity-val', '%');
        _setSlider('cfg-horizon-border-opacity', 25, 'horizon-border-opacity-val', '%');
        _setSlider('cfg-horizon-radius-pct', 18, 'horizon-radius-pct-val', '%');
        _setSlider('cfg-horizon-pitch-scale', 2, 'horizon-pitch-scale-val', 'x');
        _setSlider('cfg-horizon-damping', 5, 'horizon-damping-val', '');
        setColor('cfg-horizon-wing-color', '#FFFF00');
        App.setCheckbox('cfg-horizon-show-text', true);
        App.setCheckbox('cfg-horizon-clip', false);

        setNumber('cfg-horizon-x', 50); setNumber('cfg-horizon-y', 50);
        setNumber('cfg-depth-x', 3); setNumber('cfg-depth-y', 15);
        setNumber('cfg-temperature-x', 88); setNumber('cfg-temperature-y', 5);
        setNumber('cfg-compass-x', 50); setNumber('cfg-compass-y', 92);
        setNumber('cfg-battery-x', 88); setNumber('cfg-battery-y', 12);

        // Appliquer immédiatement au backend pour mise à jour en direct
        fetch('/api/osd/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(DEFAULTS)
        }).catch(() => {});

        App.showNotification('Valeurs par défaut restaurées');
    }

    // ==========================================================
    // PANNEAU MISE EN PAGE (Drag & Drop)
    // ==========================================================
    function _initLayoutPanel() {
        // Sélecteur de profil (boutons radio)
        const radios = document.querySelectorAll('input[name="osd-layout-profile"]');
        radios.forEach(r => {
            r.addEventListener('change', () => {
                if (r.checked) {
                    _switchProfile(r.value);
                }
            });
        });

        // Checkbox mode édition
        const editToggle = document.getElementById('cfg-layout-edit-mode');
        if (editToggle) {
            editToggle.addEventListener('change', () => {
                if (typeof OSDLayout !== 'undefined') {
                    OSDLayout.setEditMode(editToggle.checked);
                    const label = editToggle.closest('label');
                    if (label) label.classList.toggle('active', editToggle.checked);
                }
            });
        }

        // Bouton Enregistrer
        const btnSave = document.getElementById('btn-save-layout');
        if (btnSave) {
            btnSave.addEventListener('click', () => _saveLayout());
        }

        // Bouton Réinitialiser
        const btnReset = document.getElementById('btn-reset-layout');
        if (btnReset) {
            btnReset.addEventListener('click', () => _resetLayout());
        }
    }

    async function _switchProfile(profile) {
        if (typeof OSDLayout === 'undefined') return;
        await OSDLayout.setProfile(profile, true);
        // Mettre à jour les indicateurs visuels
        const statusEl = document.getElementById('layout-profile-status');
        if (statusEl) {
            statusEl.textContent = profile === 'goggles' ? '🥽 Profil Lunettes' : '🖥️ Profil Écran';
        }
        console.log(`[OSD Config] Profil OSD basculé: ${profile}`);
    }

    async function _saveLayout() {
        if (typeof OSDLayout === 'undefined') return;
        const result = await OSDLayout.save();
        if (result && result.status === 'ok') {
            App.showNotification('Disposition OSD sauvegardée !');
        } else {
            App.showNotification('❌ Erreur de sauvegarde');
        }
    }

    async function _resetLayout() {
        if (typeof OSDLayout === 'undefined') return;
        await OSDLayout.reset();
        App.showNotification('Disposition OSD réinitialisée');
    }

    // ==========================================================
    // UTILITAIRES
    // ==========================================================
    function setColor(id, value) { const el = document.getElementById(id); if (el && value) el.value = value; }
    function getColor(id) { const el = document.getElementById(id); return el ? el.value : '#FFFFFF'; }
    function setNumber(id, value) { const el = document.getElementById(id); if (el && value !== undefined) el.value = value; }
    function getNumber(id) { const el = document.getElementById(id); return el ? parseInt(el.value) || 0 : 0; }
    function _setSlider(id, value, valId, suffix) {
        const s = document.getElementById(id);
        const v = document.getElementById(valId);
        if (s && value !== undefined) { s.value = value; }
        if (v && s) { v.textContent = s.value + suffix; }
    }

    // ==========================================================
    // INIT
    // ==========================================================
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();

    return { load, save, resetToDefaults };
})();
