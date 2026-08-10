/**
 * BOB-ROV — Module Télémétrie & OSD configurable
 * WebSocket temps réel + rendu canvas avec couleurs/positions dynamiques
 */
'use strict';

const Telemetry = (() => {
    let ws = null;
    let wsConnected = false;
    let reconnectTimer = null;
    let reconnectDelay = 1000;
    const MAX_RECONNECT_DELAY = 10000;

    let osdAnimFrame = null;
    let osdRunning = false;
    let osdDpr = 1;   // devicePixelRatio appliqué au buffer du canvas OSD (netteté HD)
    let osdResizeObserver = null;  // ResizeObserver attaché au conteneur du canvas OSD
    let osdLastBufferW = 0;        // Dernières dimensions du buffer cockpit
    let osdLastBufferH = 0;
    let osdPreviewLastW = 0;       // Dernières dimensions du buffer aperçu config
    let osdPreviewLastH = 0;

    // Liste des canvas OSD actifs (cockpit + aperçu config OSD)
    const OSD_CANVAS_IDS = ['osd-canvas', 'osd-preview-canvas'];

    // Données temps réel
    let data = {
        depth: 0, temperature: 20, heading: 0, battery: 100,
        roll: 0, pitch: 0, fps: 0, armed: false, light: 0,
        camera: false, simulation: true, timestamp: 0,
        pressure: 1013.25, accel_x: 0, accel_y: 0, accel_z: 1,
        gy91_connected: false,
        imu_sensor: null, imu_connected: false, imu_alert: null,
        motors: []
    };

    // Config OSD (chargée depuis le serveur)
    let osdConfig = {
        show_horizon: true, show_depth: true, show_temperature: true,
        show_battery: true, show_compass: true, show_fps: true, show_motors: true,
        horizon_color: '#00FF88', depth_color: '#00AAFF', temperature_color: '#FFAA00',
        compass_color: '#FFFFFF', battery_color: '#00CC44', fps_color: '#FFFFFF',
        primary_color: '#00FF00', font_scale: 0.8, opacity: 100,
        depth_opacity: 100, temperature_opacity: 100,
        compass_opacity: 100, battery_opacity: 100, motors_opacity: 100,
        horizon_opacity: 100,
        horizon_x: 50, horizon_y: 50, depth_x: 3, depth_y: 15,
        temperature_x: 88, temperature_y: 5, compass_x: 50, compass_y: 92,
        battery_x: 88, battery_y: 12, fps_x: 2, fps_y: 96,
        horizon_line_thick: 2, horizon_circle_opacity: 15, horizon_border_opacity: 25,
        horizon_radius_pct: 18, horizon_pitch_scale: 2, horizon_wing_color: '#FFFF00',
        horizon_show_text: true, horizon_clip: false, horizon_damping: 5
    };

    // ==========================================================
    // WEBSOCKET
    // ==========================================================
    function connect() {
        if (ws && ws.readyState === WebSocket.OPEN) return;
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/ws/telemetry`;
        ws = new WebSocket(wsUrl);

        ws.onopen = () => { wsConnected = true; reconnectDelay = 1000; updateConnectionStatus(true); };
        ws.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data);

                // Intercepter les résultats d'actions (gamepad, dispatcher)
                if (msg.type === 'action_result') {
                    window.dispatchEvent(new CustomEvent('rov-action-result', { detail: msg }));
                    return;
                }

                Object.assign(data, msg);

                // Correctif affichage : roll/pitch arrivent inversés dans la télémétrie
                // — échange visuel uniquement (jauges tq-roll/tq-pitch et horizon
                // artificiel). Aucun impact sur les commandes envoyées au ROV.
                if (typeof msg.roll === 'number' && typeof msg.pitch === 'number') {
                    data.roll = msg.pitch;
                    data.pitch = msg.roll;
                }

                // Structure imbriquée GY-91 (imu / environment / sensor_status)
                if (msg.imu) {
                    data.roll = msg.imu.pitch;
                    data.pitch = msg.imu.roll;
                    data.heading = msg.imu.yaw;
                    data.accel_x = msg.imu.accel_x;
                    data.accel_y = msg.imu.accel_y;
                    data.accel_z = msg.imu.accel_z;
                }
                if (msg.environment) {
                    data.temperature = msg.environment.temperature;
                    data.pressure = msg.environment.pressure;
                }
                if (msg.sensor_status) {
                    data.gy91_connected = msg.sensor_status.gy91_connected;
                    data.imu_sensor = msg.sensor_status.imu_sensor || null;
                    data.imu_connected = msg.sensor_status.imu_connected;
                    data.imu_alert = msg.sensor_status.imu_alert || null;
                }
                // État des 8 propulseurs (ordre officiel M1..M8 → ch0..7)
                if (Array.isArray(msg.motors)) {
                    data.motors = msg.motors;
                }

                updateDashboardTelemetry();
                updateCockpitTelemetry();
            } catch (e) {}
        };
        ws.onclose = () => { wsConnected = false; updateConnectionStatus(false); scheduleReconnect(); };
        ws.onerror = () => ws.close();

        // Charger la config OSD au démarrage
        loadOSDConfig();
    }

    function scheduleReconnect() {
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => { reconnectDelay = Math.min(reconnectDelay * 1.5, MAX_RECONNECT_DELAY); connect(); }, reconnectDelay);
    }

    function sendCommand(cmd) {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(cmd));
    }

    function updateConnectionStatus(connected) {
        const dot = document.getElementById('ws-status');
        if (dot) { dot.classList.toggle('connected', connected); dot.title = connected ? 'Connecté' : 'Déconnecté'; }
        const netWs = document.getElementById('net-ws');
        if (netWs) { netWs.textContent = connected ? 'Connecté' : 'Déconnecté'; netWs.style.color = connected ? 'var(--accent)' : 'var(--accent-red)'; }
    }

    // ==========================================================
    // CONVERSION BOOLÉENNE ROBUSTE
    // Accepte bool, string ("true"/"True"/"yes"/"on"/"1"), int (1)
    // ==========================================================
    function _toBool(v) {
        if (typeof v === 'boolean') return v;
        if (typeof v === 'number') return v === 1;
        if (typeof v === 'string') {
            const s = v.toLowerCase().trim();
            return s === 'true' || s === '1' || s === 'yes' || s === 'on';
        }
        return false;
    }

    // ==========================================================
    // FILTRE "BAIN D'HUILE" (double passe — 2ème ordre)
    // Simule l'inertie d'un horizon gyroscopique d'avion
    // ==========================================================
    const _filter = { roll1: 0, roll2: 0, pitch1: 0, pitch2: 0 };

    function _applyOilBathFilter(current, prev1, prev2, alpha) {
        // Passe 1 : lissage exponentiel
        const pass1 = prev1 + alpha * (current - prev1);
        // Passe 2 : re-lissage de la passe 1 → réponse 2ème ordre (inertielle)
        const pass2 = prev2 + alpha * (pass1 - prev2);
        return { pass1, pass2 };
    }

    // ==========================================================
    // CONFIG OSD
    // ==========================================================
    function loadOSDConfig() {
        fetch('/api/config').then(r => r.json()).then(config => {
            const osd = config.OSD_DISPLAY || {};
            // Champs booléens à convertir strictement
            const boolKeys = ['show_horizon', 'show_depth', 'show_temperature', 'show_battery',
                              'show_compass', 'show_fps', 'show_motors',
                              'horizon_show_text', 'horizon_clip'];
            Object.keys(osdConfig).forEach(key => {
                if (osd[key] !== undefined) {
                    if (boolKeys.includes(key)) {
                        osdConfig[key] = _toBool(osd[key]);
                    } else {
                        osdConfig[key] = osd[key];
                    }
                }
            });
        }).catch(() => {});
    }

    function updateOSDConfig(newConfig) {
        // Conversion booléenne robuste pour les champs concernés
        const boolKeys = ['show_horizon', 'show_depth', 'show_temperature', 'show_battery',
                          'show_compass', 'show_fps', 'show_motors',
                          'horizon_show_text', 'horizon_clip'];
        for (const key of boolKeys) {
            if (newConfig[key] !== undefined) {
                newConfig[key] = _toBool(newConfig[key]);
            }
        }
        Object.assign(osdConfig, newConfig);
    }

    // ==========================================================
    // MISE À JOUR UI
    // ==========================================================
    function updateDashboardTelemetry() {
        App.setText('dash-depth', `${data.depth.toFixed(1)} m`);
        App.setText('dash-temp', `${data.temperature.toFixed(1)} °C`);
        App.setText('dash-pressure', `${data.pressure.toFixed(1)} hPa`);
        App.setText('dash-gy91', data.gy91_connected ? 'Connecté' : 'Simulation');
        App.setText('nav-fps', `FPS: ${data.fps}`);
    }

    function updateCockpitTelemetry() {
        App.setText('tq-depth', `${data.depth.toFixed(1)}m`);
        App.setText('tq-temp', `${data.temperature.toFixed(1)}°C`);
        App.setText('tq-heading', `${Math.round(data.heading).toString().padStart(3, '0')}°`);
        App.setText('tq-battery', `${Math.round(data.battery)}%`);
        App.setText('tq-roll', `${data.roll.toFixed(1)}°`);
        App.setText('tq-pitch', `${data.pitch.toFixed(1)}°`);
        App.setText('tq-pressure', `${Math.round(data.pressure)} hPa`);
        updateEsp32Status();
        updateGy91Status();
        updateMotorBars();
    }

    // ==========================================================
    // BARGRAPHES PROPULSEURS (2 blocs : Horizontale M1-M4 / Verticale M5-M8)
    // ==========================================================
    function _ensureMotorBar(container, motor) {
        let row = document.getElementById(`motor-row-${motor.id}`);
        if (row) return row;
        row = document.createElement('div');
        row.className = 'motor-row';
        row.id = `motor-row-${motor.id}`;
        row.innerHTML =
            `<span class="motor-label">${motor.name}</span>` +
            `<div class="motor-bar"><div class="motor-fill" id="motor-fill-${motor.id}"></div></div>` +
            `<span class="motor-pct" id="motor-pct-${motor.id}">0%</span>`;
        container.appendChild(row);
        return row;
    }

    function updateMotorBars() {
        const hBox = document.getElementById('motors-horizontal');
        const vBox = document.getElementById('motors-vertical');
        if (!hBox || !vBox || !Array.isArray(data.motors)) return;

        data.motors.forEach(motor => {
            // M1-M4 → bloc horizontal, M5-M8 → bloc vertical
            const container = (motor.group === 'vertical' || motor.id >= 5) ? vBox : hBox;
            _ensureMotorBar(container, motor);

            const fill = document.getElementById(`motor-fill-${motor.id}`);
            const pct = document.getElementById(`motor-pct-${motor.id}`);
            if (!fill || !pct) return;

            const thrust = Math.max(-1, Math.min(1, motor.thrust || 0));
            const halfPct = Math.abs(thrust) * 50; // demi-barre depuis le centre
            if (thrust >= 0) {
                fill.style.left = '50%';
                fill.style.width = `${halfPct}%`;
                fill.classList.add('forward');
                fill.classList.remove('reverse');
            } else {
                fill.style.left = `${50 - halfPct}%`;
                fill.style.width = `${halfPct}%`;
                fill.classList.add('reverse');
                fill.classList.remove('forward');
            }
            pct.textContent = `${motor.percent || 0}%`;
        });
    }

    function updateGy91Status() {
        const badge = document.getElementById('gy91-status');
        if (!badge) return;
        // Badge IMU dynamique : capteur actif (QMI8658/GY91/ADXL345) prioritaire,
        // fallback GY-91 interne legacy
        const sensorName = data.imu_sensor || 'GY-91';
        const connected = data.imu_sensor
            ? _toBool(data.imu_connected)
            : _toBool(data.gy91_connected);
        badge.classList.toggle('connected', connected);
        badge.classList.toggle('disconnected', !connected);
        badge.textContent = connected
            ? `🧭 ${sensorName}: Connecté`
            : `🧭 ${sensorName}: ${data.imu_alert ? 'Alerte' : 'Simulation'}`;
        badge.title = data.imu_alert || '';
    }

    function updateEsp32Status() {
        const badge = document.getElementById('esp32-status');
        if (!badge) return;
        const connected = _toBool(data.esp32_connected);
        badge.classList.toggle('connected', connected);
        badge.classList.toggle('disconnected', !connected);
        badge.textContent = connected ? '🔌 ESP32: Connecté' : '🔌 ESP32: Non détecté';
    }

    // ==========================================================
    // RENDU OSD CANVAS
    // ==========================================================
    function startOSD() {
        if (osdRunning) return;
        osdRunning = true;
        resizeCanvas();
        _attachResizeObserver();
        window.addEventListener('resize', resizeCanvas);
        renderOSD();
    }

    function stopOSD() {
        osdRunning = false;
        if (osdAnimFrame) { cancelAnimationFrame(osdAnimFrame); osdAnimFrame = null; }
        _detachResizeObserver();
        window.removeEventListener('resize', resizeCanvas);
        const canvas = document.getElementById('osd-canvas');
        if (canvas) { const ctx = canvas.getContext('2d'); ctx.clearRect(0, 0, canvas.width, canvas.height); }
    }

    // Redimensionne le buffer INTERNE du canvas en haute résolution (× ratio de
    // pixels de l'écran) tout en conservant sa taille CSS : sans cela le canvas
    // 1× est étiré par le navigateur sur écran HD/Retina → télémétrie floue.
    // Le contexte est normalisé via ctx.setTransform(dpr,0,0,dpr,0,0) : tout le
    // code de dessin continue de travailler en coordonnées CSS, inchangé.
    //
    // Optimisations ajoutées :
    //   - getBoundingClientRect() pour la taille CSS réelle (sub-pixel aware),
    //     plus fiable que clientWidth/clientHeight sur conteneurs flex/grid.
    //   - Le buffer n'est réalloué (canvas.width = …) QUE si ses dimensions
    //     physiques ont effectivement changé → évite de réinitialiser le contexte
    //     et de créer un GC storm à chaque frame.
    //   - setTransform et imageSmoothingEnabled réappliqués à chaque appel,
    //     garantissant que l'état du contexte reste cohérent même après clearRect
    //     ou opérations asynchrones.
    // Redimensionne le buffer INTERNE d'un canvas OSD en haute résolution.
    // Gère à la fois le canvas cockpit et l'aperçu config OSD.
    function resizeCanvas() {
        const dpr = window.devicePixelRatio || 1;
        OSD_CANVAS_IDS.forEach(id => {
            const canvas = document.getElementById(id);
            const container = canvas?.parentElement;
            if (!canvas || !container) return;

            const rect = container.getBoundingClientRect();
            const displayWidth  = Math.max(1, Math.floor(rect.width));
            const displayHeight = Math.max(1, Math.floor(rect.height));
            const bufferW = Math.round(displayWidth  * dpr);
            const bufferH = Math.round(displayHeight * dpr);

            // Réallocation uniquement si dimensions physiques changent
            if (bufferW !== canvas._lastBufW || bufferH !== canvas._lastBufH || dpr !== osdDpr) {
                canvas.width  = bufferW;
                canvas.height = bufferH;
                canvas._lastBufW = bufferW;
                canvas._lastBufH = bufferH;
            }

            if (canvas.style.width  !== `${displayWidth}px`)  canvas.style.width  = `${displayWidth}px`;
            if (canvas.style.height !== `${displayHeight}px`) canvas.style.height = `${displayHeight}px`;

            const ctx = canvas.getContext('2d');
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.imageSmoothingEnabled = true;
        });
        osdDpr = dpr;
    }

    // Attache un ResizeObserver au conteneur du canvas OSD pour déclencher
    // resizeCanvas() automatiquement dès que le conteneur change de taille
    // (fin de rendu CSS initial, transitions de layout, bascule panneau, etc.)
    function _attachResizeObserver() {
        _detachResizeObserver();
        if (typeof ResizeObserver === 'undefined') return;

        osdResizeObserver = new ResizeObserver(() => {
            resizeCanvas();
        });
        OSD_CANVAS_IDS.forEach(id => {
            const canvas = document.getElementById(id);
            const container = canvas?.parentElement;
            if (container) osdResizeObserver.observe(container);
        });
    }

    function _detachResizeObserver() {
        if (osdResizeObserver) {
            try { osdResizeObserver.disconnect(); } catch (e) { /* ignore */ }
            osdResizeObserver = null;
        }
    }

    function hexToRgba(hex, alpha) {
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        return `rgba(${r},${g},${b},${alpha})`;
    }

    function renderOSD() {
        if (!osdRunning) return;

        // Si le ratio de pixels a changé, ré-échantillonner tous les buffers
        if ((window.devicePixelRatio || 1) !== osdDpr) resizeCanvas();

        // Pré-calcul du filtre "bain d'huile" (une seule fois, indépendant du canvas)
        let fRoll = 0, fPitch = 0;
        if (osdConfig.show_horizon) {
            const damping = osdConfig.horizon_damping != null ? osdConfig.horizon_damping : 5;
            const alpha = 1.0 / (0.5 + damping * 0.45);
            const r = _applyOilBathFilter(data.roll,  _filter.roll1,  _filter.roll2,  alpha);
            _filter.roll1 = r.pass1; _filter.roll2 = r.pass2;
            const p = _applyOilBathFilter(data.pitch, _filter.pitch1, _filter.pitch2, alpha);
            _filter.pitch1 = p.pass1; _filter.pitch2 = p.pass2;
            fRoll  = Math.abs(_filter.roll2)  < 0.1 ? 0 : _filter.roll2;
            fPitch = Math.abs(_filter.pitch2) < 0.1 ? 0 : _filter.pitch2;
        }

        // Dessiner sur CHAQUE canvas OSD visible (cockpit + aperçu config)
        OSD_CANVAS_IDS.forEach(id => {
            const canvas = document.getElementById(id);
            if (!canvas || canvas.width < 100 || canvas.height < 100) return;
            // Ignorer les canvas dont le conteneur n'est pas visible
            const container = canvas.parentElement;
            if (container && container.offsetParent === null && !container.classList.contains('active')) return;

            const ctx = canvas.getContext('2d');
            const w = canvas.width / osdDpr, h = canvas.height / osdDpr;
            ctx.clearRect(0, 0, w, h);
            if (w < 100 || h < 100) return;

            const opacity = osdConfig.opacity / 100;
            const scale = Math.min(w / 1280, h / 720);
            const fontSize = Math.max(11, Math.round(14 * scale * (osdConfig.font_scale || 0.8)));
            const elemAlpha = (elemOpacity) => opacity * ((elemOpacity != null ? elemOpacity : 100) / 100);
            const px = (pctX) => Math.round(w * pctX / 100);
            const py = (pctY) => Math.round(h * pctY / 100);

            // 1. Horizon
            if (osdConfig.show_horizon) {
                ctx.globalAlpha = elemAlpha(osdConfig.horizon_opacity);
                drawHorizon(ctx, px(osdConfig.horizon_x), py(osdConfig.horizon_y), w, h, fRoll, fPitch, osdConfig.horizon_color, scale, fontSize, osdConfig);
            }
            // 2. Profondeur
            if (osdConfig.show_depth) {
                ctx.globalAlpha = elemAlpha(osdConfig.depth_opacity);
                drawGauge(ctx, px(osdConfig.depth_x), py(osdConfig.depth_y), h, data.depth, 100, 'm', 'PROF', osdConfig.depth_color, scale, fontSize);
            }
            // 3. Température
            if (osdConfig.show_temperature) {
                ctx.globalAlpha = elemAlpha(osdConfig.temperature_opacity);
                drawText(ctx, px(osdConfig.temperature_x), py(osdConfig.temperature_y), `TEMP: ${data.temperature.toFixed(1)}°C`, osdConfig.temperature_color, fontSize, 'right');
            }
            // 4. Boussole
            if (osdConfig.show_compass) {
                ctx.globalAlpha = elemAlpha(osdConfig.compass_opacity);
                drawCompass(ctx, px(osdConfig.compass_x), py(osdConfig.compass_y), w, data.heading, osdConfig.compass_color, '#FFD700', scale, fontSize);
            }
            // 5. Batterie
            if (osdConfig.show_battery) {
                ctx.globalAlpha = elemAlpha(osdConfig.battery_opacity);
                drawBattery(ctx, px(osdConfig.battery_x), py(osdConfig.battery_y), data.battery, osdConfig.battery_color, scale, fontSize);
            }
            // 6. FPS
            if (osdConfig.show_fps) {
                ctx.globalAlpha = opacity;
                drawText(ctx, px(osdConfig.fps_x), py(osdConfig.fps_y), `FPS: ${data.fps}`, osdConfig.fps_color, Math.round(fontSize * 0.85), 'left');
            }
            // 6.1 Alerte faible lumière
            if (data.fps > 0 && data.fps < 10) {
                ctx.globalAlpha = opacity;
                drawText(ctx, px(osdConfig.fps_x), py(osdConfig.fps_y) + fontSize, '⚠ Manque de lumière', '#FF4444', Math.round(fontSize * 0.75), 'left');
            }
            // 7. Timestamp
            ctx.globalAlpha = opacity;
            const now = new Date();
            drawText(ctx, w - 10, h - 15, now.toTimeString().substring(0, 8), osdConfig.fps_color, Math.round(fontSize * 0.85), 'right');

            // 8. Armé/Désarmé
            ctx.globalAlpha = opacity;
            ctx.textAlign = 'center';
            ctx.font = `bold ${Math.round(fontSize * 1.1)}px 'Courier New', monospace`;
            ctx.fillStyle = data.armed ? '#FF4444' : '#44FF44';
            ctx.fillText(data.armed ? '● ARMÉ' : '○ DÉSARMÉ', w / 2, 25);

            // 9. Propulseurs
            if (osdConfig.show_motors && Array.isArray(data.motors) && data.motors.length > 0) {
                ctx.globalAlpha = elemAlpha(osdConfig.motors_opacity);
                drawMotors(ctx, w, h, data.motors, scale, fontSize);
            }

            ctx.globalAlpha = 1;
        });

        osdAnimFrame = requestAnimationFrame(renderOSD);
    }

    function drawText(ctx, x, y, text, color, fontSize, align) {
        ctx.font = `bold ${fontSize}px 'Courier New', monospace`;
        ctx.fillStyle = color;
        ctx.textAlign = align || 'left';
        ctx.textBaseline = 'middle';
        // Fond semi-transparent
        const metrics = ctx.measureText(text);
        const pad = 4;
        const bx = align === 'right' ? x - metrics.width - pad : x - pad;
        ctx.fillStyle = 'rgba(0,0,0,0.4)';
        ctx.fillRect(bx, y - fontSize / 2 - 2, metrics.width + pad * 2, fontSize + 4);
        ctx.fillStyle = color;
        ctx.fillText(text, x, y);
    }

    function drawHorizon(ctx, cx, cy, w, h, roll, pitch, color, scale, fontSize, cfg) {
        const rPct = (cfg && cfg.horizon_radius_pct != null) ? cfg.horizon_radius_pct / 100 : 0.15;
        const radius = Math.min(w, h) * rPct;
        const lineThick = (cfg && cfg.horizon_line_thick) || 2;
        const pitchScale = (cfg && cfg.horizon_pitch_scale) || 2;
        const circleOpacity = (cfg && cfg.horizon_circle_opacity != null) ? cfg.horizon_circle_opacity / 100 : 0.15;
        const borderOpacity = (cfg && cfg.horizon_border_opacity != null) ? cfg.horizon_border_opacity / 100 : 0.25;
        const wingColor = (cfg && cfg.horizon_wing_color) || '#FFFF00';
        const showText = cfg ? _toBool(cfg.horizon_show_text) : true;

        const pxPerDeg = pitchScale * scale;   // facteur de conversion pitch → pixels

        ctx.save();

        // === 1. FOND CIEL / SOL avec clip circulaire ===
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.save();
        ctx.clip();
        ctx.translate(cx, cy);
        ctx.rotate(-roll * Math.PI / 180);

        const pitchOffset = pitch * pxPerDeg;
        const skyColor = '#2c6dd5';
        const groundColor = '#3d2b1f';

        // Bandes ciel/sol infinies (3 périodes pour couvrir toute rotation)
        const bandH = radius * 4;
        for (let k = -1; k <= 1; k++) {
            const base = pitchOffset + k * bandH * 2;
            // Ciel (au-dessus de l'horizon)
            ctx.fillStyle = skyColor;
            ctx.fillRect(-radius * 2, base - bandH, radius * 4, bandH);
            // Sol (en-dessous de l'horizon)
            ctx.fillStyle = groundColor;
            ctx.fillRect(-radius * 2, base, radius * 4, bandH);
        }

        // Ligne d'horizon principale
        ctx.beginPath();
        ctx.moveTo(-radius * 1.5, pitchOffset);
        ctx.lineTo(radius * 1.5, pitchOffset);
        ctx.strokeStyle = '#e6ecff';
        ctx.lineWidth = lineThick * scale;
        ctx.stroke();

        // === Échelle de tangage (pitch ladder) : graduations tous les 10° ===
        ctx.strokeStyle = 'rgba(230, 236, 255, 0.75)';
        ctx.fillStyle = 'rgba(230, 236, 255, 0.75)';
        ctx.lineWidth = 1;
        const labelSize = Math.max(8, Math.round(fontSize * 0.55));
        ctx.font = `bold ${labelSize}px 'Courier New', monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        for (let deg = -90; deg <= 90; deg += 10) {
            if (deg === 0) continue; // la ligne d'horizon est déjà tracée
            const y = -deg * pxPerDeg + pitchOffset;
            if (Math.abs(y) > radius - 4) continue; // hors du disque
            const isMajor = (deg % 30 === 0);
            const halfW = isMajor ? radius * 0.45 : radius * 0.22;
            ctx.beginPath();
            ctx.moveTo(-halfW, y);
            ctx.lineTo(halfW, y);
            ctx.stroke();
            // Étiquettes numériques pour les graduations majeures (±30°, ±60°, ±90°)
            if (isMajor) {
                ctx.fillText(String(Math.abs(deg)), halfW + labelSize * 0.8, y);
                ctx.fillText(String(Math.abs(deg)), -halfW - labelSize * 0.8, y);
            }
        }
        ctx.restore(); // fin du clip circulaire

        // === 2. ÉCHELLE DE ROULIS (arc au-dessus du cercle) ===
        const rollArcR = radius + 10 * scale;
        const rollMarks = [0, 10, 20, 30, 45, 60, 90];
        ctx.strokeStyle = `rgba(255,255,255,${borderOpacity})`;
        ctx.fillStyle = `rgba(255,255,255,${Math.min(borderOpacity * 2, 0.8)})`;
        ctx.lineWidth = 1;
        ctx.font = `${Math.max(7, Math.round(fontSize * 0.5))}px 'Courier New', monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        rollMarks.forEach(deg => {
            [-1, 1].forEach(sign => {
                const d = sign * deg;
                const a = (-90 + d) * Math.PI / 180; // -90° = zénith
                const innerR = rollArcR - (deg % 30 === 0 ? 7 : 4) * scale;
                const outerR = rollArcR + 2 * scale;
                ctx.beginPath();
                ctx.moveTo(cx + Math.cos(a) * innerR, cy + Math.sin(a) * innerR);
                ctx.lineTo(cx + Math.cos(a) * outerR, cy + Math.sin(a) * outerR);
                ctx.stroke();
                // Étiquette pour les marques majeures
                if (deg > 0 && deg % 30 === 0) {
                    const lblR = rollArcR + 9 * scale;
                    ctx.fillText(String(deg), cx + Math.cos(a) * lblR, cy + Math.sin(a) * lblR);
                }
            });
        });
        // Repère zénith (triangle au sommet)
        const zenithA = -Math.PI / 2;
        const triBase = rollArcR + 3 * scale;
        const triH = 6 * scale;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(zenithA) * triBase, cy + Math.sin(zenithA) * triBase);
        ctx.lineTo(cx + Math.cos(zenithA - 0.08) * (triBase + triH), cy + Math.sin(zenithA - 0.08) * (triBase + triH));
        ctx.lineTo(cx + Math.cos(zenithA + 0.08) * (triBase + triH), cy + Math.sin(zenithA + 0.08) * (triBase + triH));
        ctx.closePath();
        ctx.fillStyle = color;
        ctx.fill();

        // Indicateur de roulis actuel (petit triangle pointant vers le bas)
        const rollA = (-90 - roll) * Math.PI / 180;
        const indR = rollArcR - 1 * scale;
        const indH = 5 * scale;
        ctx.save();
        ctx.translate(cx + Math.cos(rollA) * indR, cy + Math.sin(rollA) * indR);
        ctx.rotate(rollA + Math.PI / 2);
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(-indH * 0.5, indH);
        ctx.lineTo(indH * 0.5, indH);
        ctx.closePath();
        ctx.fillStyle = wingColor;
        ctx.fill();
        ctx.restore();

        // === 3. AILES INDICATRICES FIXES (style aéronautique) ===
        const wingLen = radius * 0.55;
        ctx.strokeStyle = wingColor;
        ctx.lineWidth = 2.5 * scale;
        ctx.lineCap = 'round';
        // Aile gauche avec décrochement vers le bas
        ctx.beginPath();
        ctx.moveTo(cx - wingLen, cy);
        ctx.lineTo(cx - 10 * scale, cy);
        ctx.lineTo(cx - 5 * scale, cy + 5 * scale);
        ctx.stroke();
        // Aile droite avec décrochement vers le bas
        ctx.beginPath();
        ctx.moveTo(cx + wingLen, cy);
        ctx.lineTo(cx + 10 * scale, cy);
        ctx.lineTo(cx + 5 * scale, cy + 5 * scale);
        ctx.stroke();

        // Point central
        ctx.beginPath();
        ctx.arc(cx, cy, 2.5 * scale, 0, Math.PI * 2);
        ctx.fillStyle = wingColor;
        ctx.fill();

        // === 4. BORDURE DU CERCLE ===
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(255,255,255,${borderOpacity})`;
        ctx.lineWidth = 2;
        ctx.stroke();

        // Fond semi-transparent autour du cercle (pour lisibilité sur la vidéo)
        ctx.beginPath();
        ctx.arc(cx, cy, radius + 8, 0, Math.PI * 2);
        ctx.arc(cx, cy, radius, 0, Math.PI * 2, true);
        ctx.fillStyle = `rgba(0,0,0,${circleOpacity})`;
        ctx.fill();

        // === 5. TEXTE ROULIS / TANGAGE ===
        if (showText) {
            const txtSize = Math.round(fontSize * 0.75);
            ctx.font = `bold ${txtSize}px 'Courier New', monospace`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';

            // Cartouche sombre sous l'horizon
            const txtY = cy + radius + 14 * scale;
            const txt1 = `R: ${roll >= 0 ? '+' : ''}${roll.toFixed(1)}°`;
            const txt2 = `P: ${pitch >= 0 ? '+' : ''}${pitch.toFixed(1)}°`;
            const fullTxt = `${txt1}  ${txt2}`;
            const met = ctx.measureText(fullTxt);
            const pad = 4;
            ctx.fillStyle = 'rgba(0,0,0,0.55)';
            ctx.fillRect(cx - met.width / 2 - pad, txtY - 2, met.width + pad * 2, txtSize + 4);

            // Roulis (couleur dynamique : vert si faible, orange si > 30°)
            ctx.fillStyle = Math.abs(roll) > 30 ? '#FF8800' : color;
            ctx.fillText(txt1, cx - met.width / 4, txtY);
            // Tangage
            ctx.fillStyle = Math.abs(pitch) > 30 ? '#FF8800' : color;
            ctx.fillText(txt2, cx + met.width / 4, txtY);
        }

        ctx.restore();
    }

    function drawGauge(ctx, x, y, canvasH, value, maxVal, unit, label, color, scale, fontSize) {
        const barW = 14 * scale, barH = canvasH * 0.3;
        ctx.fillStyle = 'rgba(0,0,0,0.4)';
        ctx.fillRect(x - 2, y - 18, barW + 55, barH + 35);
        const pct = Math.min(Math.max(value / maxVal, 0), 1);
        const fillH = pct * barH;
        // Contour 1 px calé sur la demi-grille (Math.round + 0.5) : trait net,
        // sans étalement anti-aliasé sur deux rangées de pixels.
        ctx.strokeStyle = 'rgba(255,255,255,0.3)'; ctx.lineWidth = 1;
        ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(barW), Math.round(barH));
        ctx.fillStyle = color;
        ctx.fillRect(x, y + barH - fillH, barW, fillH);
        ctx.font = `bold ${Math.round(fontSize * 0.9)}px 'Courier New'`;
        ctx.fillStyle = '#FFFFFF'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.fillText(`${value.toFixed(1)}${unit}`, x, y + barH + 14);
        ctx.font = `${Math.round(fontSize * 0.7)}px 'Courier New'`;
        ctx.fillStyle = color;
        ctx.fillText(label, x, y - 8);
    }

    function drawCompass(ctx, cx, cy, canvasW, heading, color, accent, scale, fontSize) {
        const barW = canvasW * 0.3;
        ctx.fillStyle = 'rgba(0,0,0,0.4)';
        ctx.fillRect(cx - barW / 2 - 8, cy - 16, barW + 16, 32);
        const dirs = { 0: 'N', 90: 'E', 180: 'S', 270: 'O' };
        ctx.font = `bold ${Math.round(fontSize * 0.9)}px 'Courier New'`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        for (const [deg, label] of Object.entries(dirs)) {
            let offset = parseInt(deg) - heading;
            while (offset > 180) offset -= 360;
            while (offset < -180) offset += 360;
            const pxc = cx + (offset * barW / 180);
            if (pxc >= cx - barW / 2 && pxc <= cx + barW / 2) {
                ctx.fillStyle = (label === 'N') ? accent : color;
                ctx.fillText(label, pxc, cy);
            }
        }
        ctx.strokeStyle = accent; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(cx, cy - 12); ctx.lineTo(cx, cy + 12); ctx.stroke();
        ctx.fillStyle = color; ctx.textAlign = 'left';
        ctx.fillText(`CAP ${Math.round(heading).toString().padStart(3, '0')}°`, cx + barW / 2 + 8, cy);
    }

    function drawBattery(ctx, x, y, battery, color, scale, fontSize) {
        const barW = 80 * scale, barH = 12 * scale;
        ctx.fillStyle = 'rgba(0,0,0,0.4)';
        ctx.fillRect(x - 4, y - 4, barW + 45, barH + 8);
        const pct = Math.max(0, Math.min(battery / 100, 1));
        ctx.fillStyle = 'rgba(80,80,80,0.6)';
        ctx.fillRect(x, y, barW, barH);
        let battColor = pct > 0.5 ? color : (pct > 0.2 ? '#FFD700' : '#FF4444');
        ctx.fillStyle = battColor;
        ctx.fillRect(x, y, barW * pct, barH);
        ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = 1;
        // Même alignement demi-pixel que la jauge : cadre de batterie net
        ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(barW), Math.round(barH));
        ctx.font = `bold ${Math.round(fontSize * 0.8)}px 'Courier New'`;
        ctx.fillStyle = '#FFFFFF'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.fillText(`${Math.round(battery)}%`, x + barW + 5, y + barH / 2);
    }

    // ==========================================================
    // PROPULSEURS (style cercles — vue du dessus en X)
    // M1-M4 horizontaux (extérieur), M5-M8 verticaux (intérieur)
    // Numérotation officielle : départ avant-droit, sens horaire.
    // ==========================================================
    function drawMotors(ctx, w, h, motors, scale, fontSize) {
        const widgetW = Math.round(150 * scale);
        const widgetH = Math.round(130 * scale);
        const margin = 10;
        const baseX = margin;                 // bottom-left par défaut
        const baseY = h - widgetH - margin;

        // Fond semi-transparent
        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        ctx.fillRect(baseX, baseY, widgetW, widgetH);
        ctx.strokeStyle = 'rgba(255,255,255,0.25)';
        ctx.lineWidth = 1;
        ctx.strokeRect(baseX + 0.5, baseY + 0.5, widgetW, widgetH);

        // Titre
        const titleSize = Math.max(9, Math.round(fontSize * 0.7));
        ctx.font = `bold ${titleSize}px 'Courier New', monospace`;
        ctx.fillStyle = '#FFFFFF';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText('PROP', baseX + 5, baseY + 4);

        // Centre du widget
        const cx = baseX + widgetW / 2;
        const cy = baseY + widgetH * 0.52;

        // Espacements selon l'échelle
        const spreadH = Math.round(48 * scale);  // horizontaux (extérieur)
        const spreadV = Math.round(28 * scale);  // verticaux (intérieur)
        const dyTop   = Math.round(-28 * scale);
        const dyBot   = Math.round(28 * scale);

        // Positions des 8 moteurs (vue du dessus, configuration X)
        //   M4 ↖   ↗ M1        M8 ⭕   ⭕ M5   (avant)
        //   M3 ↙   ↘ M2        M7 ⭕   ⭕ M6   (arrière)
        const positions = {
            1: { x: cx + spreadH, y: cy + dyTop },
            2: { x: cx + spreadH, y: cy + dyBot },
            3: { x: cx - spreadH, y: cy + dyBot },
            4: { x: cx - spreadH, y: cy + dyTop },
            5: { x: cx + spreadV, y: cy + dyTop },
            6: { x: cx + spreadV, y: cy + dyBot },
            7: { x: cx - spreadV, y: cy + dyBot },
            8: { x: cx - spreadV, y: cy + dyTop }
        };

        const maxR = Math.max(4, Math.round(11 * scale));
        const minR = Math.max(2, Math.round(4 * scale));
        const labelSize = Math.max(8, Math.round(fontSize * 0.6));

        for (const motor of motors) {
            const pos = positions[motor.id];
            if (!pos) continue;

            const thrust = motor.thrust || 0;
            const percent = motor.percent || 0;

            // Couleur selon la direction
            let color;
            if (thrust > 0.01)      color = '#00FF88';  // vert (avant)
            else if (thrust < -0.01) color = '#FF4444';  // rouge (arrière)
            else                     color = '#555555';  // gris (stop)

            // Rayon proportionnel à la puissance
            const radius = minR + Math.round((maxR - minR) * (percent / 100));

            // Cercle plein
            ctx.beginPath();
            ctx.arc(pos.x, pos.y, radius, 0, Math.PI * 2);
            ctx.fillStyle = color;
            ctx.fill();

            // Contour max
            ctx.beginPath();
            ctx.arc(pos.x, pos.y, maxR, 0, Math.PI * 2);
            ctx.strokeStyle = 'rgba(255,255,255,0.3)';
            ctx.lineWidth = 1;
            ctx.stroke();

            // Label M1-M8
            ctx.font = `bold ${labelSize}px 'Courier New', monospace`;
            ctx.fillStyle = '#FFFFFF';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            ctx.fillText(`M${motor.id}`, pos.x, pos.y + maxR + 3);
        }

        // Pourcentage moyen en bas
        const avgPct = motors.reduce((s, m) => s + (m.percent || 0), 0) / motors.length;
        ctx.font = `bold ${labelSize}px 'Courier New', monospace`;
        ctx.fillStyle = '#FFFFFF';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        ctx.fillText(`Moy: ${avgPct.toFixed(0)}%`, baseX + 5, baseY + widgetH - 4);
    }

    // ==========================================================
    // INIT
    // ==========================================================
    function init() { connect(); }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();

    return { connect, sendCommand, startOSD, stopOSD, getData: () => ({ ...data }), isConnected: () => wsConnected, updateOSDConfig, osdConfig: () => osdConfig };
})();
