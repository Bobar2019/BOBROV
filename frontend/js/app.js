/**
 * BOB-ROV — Gestionnaire de navigation, thème et UI principale
 */
'use strict';

const App = (() => {
    let activeTile = null;
    let currentTheme = 'night';

    // ==========================================================
    // NAVIGATION PAR TUILES (grille d'accueil)
    // ==========================================================
    function initNavigation() {
        // Les boutons .nav-tile utilisent onclick="App.switchTile(...)" directement
        // Rien à attacher ici, mais on s'assure que la page d'accueil est affichée
        document.getElementById('nav-home').style.display = '';
        document.querySelector('.main-content').classList.remove('visible');
        document.getElementById('btn-back-home').style.display = 'none';
    }

    function switchTile(tileId) {
        // Masquer la grille d'accueil
        const navHome = document.getElementById('nav-home');
        if (navHome) navHome.style.display = 'none';

        // Afficher le contenu principal
        const mainContent = document.querySelector('.main-content');
        if (mainContent) mainContent.classList.add('visible');

        // Afficher le bouton retour
        const btnBack = document.getElementById('btn-back-home');
        if (btnBack) btnBack.style.display = 'block';

        // Désactiver tous les panneaux puis activer le bon
        document.querySelectorAll('.tile-panel').forEach(p => p.classList.remove('active'));
        const panel = document.getElementById(`tile-${tileId}`);
        if (panel) { panel.classList.add('active'); activeTile = tileId; }

        // Mettre à jour la tuile active dans la grille
        document.querySelectorAll('.nav-tile').forEach(t => t.classList.remove('active'));
        const activeTileBtn = document.querySelector(`.nav-tile[data-tile="${tileId}"]`);
        if (activeTileBtn) activeTileBtn.classList.add('active');

        // Appels spécifiques à chaque tuile (conserver le comportement existant)
        if (tileId === 'config-cam') loadCameraList();
        if (tileId === 'simulation') Simulation.refreshList();
        if (tileId === 'galerie') refreshRecordings();
        if (tileId === 'config-manette' && typeof GamepadConfig !== 'undefined') GamepadConfig.init();
        if (tileId === 'cockpit') {
            initPiPClick();
            if (typeof CameraConfig !== 'undefined') CameraConfig.syncCockpitSliders();
            // Forcer un scan immédiat de la manette à l'activation du Cockpit
            // (corrige le cas où gamepadconnected n'est pas déclenché par le navigateur)
            if (typeof Gamepad !== 'undefined') Gamepad.onCockpitActivate();
        }
        // Démarrer l'OSD canvas vectoriel pour cockpit ET config OSD (aperçu en direct)
        if (tileId === 'cockpit' || tileId === 'config-osd') {
            if (typeof Telemetry !== 'undefined') Telemetry.startOSD();
            // Initialiser le module Rov3D (Three.js) si disponible
            if (typeof Rov3D !== 'undefined' && Rov3D.init) Rov3D.init();
        } else {
            if (typeof Telemetry !== 'undefined') Telemetry.stopOSD();
        }
        if (tileId === 'dashboard' && typeof ActionStatus !== 'undefined') {
            ActionStatus.renderStatusPanel('action-status-panel');
        }
        if (tileId === 'config-scene-3d' && typeof SceneConfig !== 'undefined') SceneConfig.init();
    }

    function goHome() {
        // Masquer tous les panneaux
        document.querySelectorAll('.tile-panel').forEach(p => p.classList.remove('active'));
        // Masquer le contenu principal
        const mainContent = document.querySelector('.main-content');
        if (mainContent) mainContent.classList.remove('visible');
        // Réafficher la grille d'accueil
        const navHome = document.getElementById('nav-home');
        if (navHome) navHome.style.display = '';
        // Masquer le bouton retour
        const btnBack = document.getElementById('btn-back-home');
        if (btnBack) btnBack.style.display = 'none';
        // Réinitialiser la tuile active
        document.querySelectorAll('.nav-tile').forEach(t => t.classList.remove('active'));
        // Arrêter l'OSD canvas (économie CPU hors cockpit)
        if (typeof Telemetry !== 'undefined') Telemetry.stopOSD();
        activeTile = null;

        // Informer le module de navigation manette
        if (typeof GamepadNav !== 'undefined') GamepadNav.onGoHome();
    }

    // ==========================================================
    // THÈME JOUR / NUIT
    // ==========================================================
    function initTheme() {
        const saved = localStorage.getItem('bobrov-theme');
        if (saved === 'day') setTheme('day');
        else setTheme('night');

        const btn = document.getElementById('btn-theme');
        if (btn) btn.addEventListener('click', toggleTheme);
    }

    function toggleTheme() {
        setTheme(currentTheme === 'night' ? 'day' : 'night');
    }

    function setTheme(mode) {
        currentTheme = mode;
        document.body.className = `theme-${mode}`;
        const btn = document.getElementById('btn-theme');
        if (btn) btn.textContent = mode === 'night' ? '🌙' : '☀️';
        localStorage.setItem('bobrov-theme', mode);
        // Sauvegarder côté serveur
        fetch('/api/theme', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode })
        }).catch(() => {});
    }

    // ==========================================================
    // CONTRÔLES ROV (COCKPIT)
    // ==========================================================
    function initControls() {
        const btnArm = document.getElementById('btn-arm');
        if (btnArm) btnArm.addEventListener('click', () => sendControl('arm'));

        const btnDisarm = document.getElementById('btn-disarm');
        if (btnDisarm) btnDisarm.addEventListener('click', () => sendControl('disarm'));

        const lightSlider = document.getElementById('light-slider');
        const lightValue = document.getElementById('light-value');
        if (lightSlider) {
            lightSlider.addEventListener('input', () => { if (lightValue) lightValue.textContent = `${lightSlider.value}%`; });
            lightSlider.addEventListener('change', () => sendLight(parseInt(lightSlider.value)));
        }

        // Sélecteur Auto-Pilote (3 modes → ESP32 via canal I2C 14)
        document.querySelectorAll('.btn-autopilot').forEach(btn => {
            btn.addEventListener('click', () => setAutopilotMode(parseInt(btn.dataset.apMode)));
        });
        // Synchroniser l'état initial avec le backend
        fetch('/api/autopilot/mode').then(r => r.json())
            .then(data => updateAutopilotButtons(data.mode))
            .catch(() => {});
    }

    function sendControl(command) {
        fetch(`/api/control/${command}`, { method: 'POST' })
            .then(r => r.json())
            .then(data => console.log(`[ROV] ${command}:`, data))
            .catch(err => console.error(`[ROV] Erreur:`, err));
    }

    function sendLight(value) {
        fetch(`/api/control/light/${value}`, { method: 'POST' })
            .then(r => r.json())
            .catch(err => console.error('[ROV] Erreur lumière:', err));
    }

    // ==========================================================
    // AUTO-PILOTE (stabilisation ESP32-S3)
    // ==========================================================
    const AUTOPILOT_LABELS = { 1: '🕹️ PASSIF', 2: '⚖️ AUTO-ROULIS', 3: '🎯 AUTO-FULL' };

    function setAutopilotMode(mode) {
        fetch('/api/autopilot/mode', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode: mode })
        }).then(r => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.json();
        }).then(data => {
            updateAutopilotButtons(data.mode);
            showNotification(`Auto-Pilote : ${AUTOPILOT_LABELS[data.mode] || data.mode_name}`);
            console.log('[Autopilot] Mode:', data);
        }).catch(err => {
            console.error('[Autopilot] Erreur:', err);
            showNotification('❌ Erreur changement mode Auto-Pilote');
        });
    }

    function updateAutopilotButtons(mode) {
        document.querySelectorAll('.btn-autopilot').forEach(btn => {
            btn.classList.toggle('active', parseInt(btn.dataset.apMode) === mode);
        });
    }

    // ==========================================================
    // CONFIG CAMÉRA (TUILE 4) — paramètres vidéo de base
    // ==========================================================
    function initConfigCamera() {
        const btnSave = document.getElementById('btn-save-cam-config');
        if (btnSave) btnSave.addEventListener('click', saveCameraConfig);

        const btnReload = document.getElementById('btn-reload-cam-config');
        if (btnReload) btnReload.addEventListener('click', loadCameraConfig);

        const btnRefresh = document.getElementById('btn-refresh-cameras');
        if (btnRefresh) btnRefresh.addEventListener('click', loadCameraList);

        const btnDetect = document.getElementById('btn-detect-cameras');
        if (btnDetect) btnDetect.addEventListener('click', detectCameras);

        const btnSwap = document.getElementById('btn-swap-cameras');
        if (btnSwap) btnSwap.addEventListener('click', swapCameras);

        // Les réglages V4L2 sont gérés par camera_config.js
        loadCameraConfig();
    }

    // ==========================================================
    // PANNEAU CAMÉRA COCKPIT (réglages rapides)
    // ==========================================================
    function initCockpitCam() {
        const brightnessSlider = document.getElementById('cockpit-brightness');
        const contrastSlider = document.getElementById('cockpit-contrast');
        const brightnessVal = document.getElementById('cockpit-brightness-val');
        const contrastVal = document.getElementById('cockpit-contrast-val');

        if (brightnessSlider) {
            brightnessSlider.addEventListener('input', () => {
                if (brightnessVal) brightnessVal.textContent = brightnessSlider.value;
            });
            brightnessSlider.addEventListener('change', () => {
                const device = CameraConfig.getMainDevice();
                CameraConfig.applySingleParam(device, 'brightness', parseInt(brightnessSlider.value));
            });
        }

        if (contrastSlider) {
            contrastSlider.addEventListener('input', () => {
                if (contrastVal) contrastVal.textContent = contrastSlider.value;
            });
            contrastSlider.addEventListener('change', () => {
                const device = CameraConfig.getMainDevice();
                CameraConfig.applySingleParam(device, 'contrast', parseInt(contrastSlider.value));
            });
        }

        // Mettre à jour le label du device
        _updateCockpitCamDevice();

        // Bouton Inverser caméras (cockpit)
        const btnCockpitSwap = document.getElementById('btn-cockpit-swap');
        if (btnCockpitSwap) {
            btnCockpitSwap.addEventListener('click', () => swapCamerasLive());
        }

        // Surveiller et reconnecter le flux MJPEG automatiquement
        _initVideoStreamWatchdog();
    }

    function _updateCockpitCamDevice() {
        const label = document.getElementById('cockpit-cam-device');
        if (label && typeof CameraConfig !== 'undefined') {
            label.textContent = CameraConfig.getMainDevice();
        }
    }

    // ==========================================================
    // WATCHDOG FLUX VIDÉO — auto-reconnexion MJPEG
    // ==========================================================
    let _videoWatchdogInterval = null;

    function _initVideoStreamWatchdog() {
        const img = document.getElementById('video-stream');
        if (!img) return;

        // Ne pas doubler le watchdog
        if (_videoWatchdogInterval) return;

        // Si le flux casse, tenter une reconnexion
        img.addEventListener('error', () => {
            console.warn('[VideoStream] Erreur détectée, reconnexion dans 2s...');
            setTimeout(() => _reconnectVideoStream(), 2000);
        });

        // Vérifier périodiquement que le flux est vivant (toutes les 5s)
        _videoWatchdogInterval = setInterval(() => {
            const img = document.getElementById('video-stream');
            if (!img) return;

            // Si naturalWidth === 0, l'image ne charge plus
            if (img.naturalWidth === 0 && img.src) {
                console.warn('[VideoStream] Flux inactif, reconnexion...');
                _reconnectVideoStream();
            }
        }, 5000);
    }

    function _reconnectVideoStream() {
        const img = document.getElementById('video-stream');
        if (!img) return;
        // Cache-busting pour forcer une nouvelle connexion HTTP
        const ts = Date.now();
        const newSrc = `/video_feed?_t=${ts}`;
        // Ne pas recharger si déjà sur cette URL
        if (img.src && img.src.includes(`_t=${ts}`)) return;
        img.src = newSrc;
        console.log('[VideoStream] Reconnexion MJPEG:', newSrc);
    }

    // ==========================================================
    // PiP CLIQUABLE — inversion caméras au clic sur l'imagette
    // ==========================================================
    function initPiPClick() {
        const videoContainer = document.querySelector('.video-container');
        if (!videoContainer) return;
        // Supprimer l'ancien handler pour éviter les doublons
        videoContainer.removeEventListener('click', _onPiPClick);
        videoContainer.addEventListener('click', _onPiPClick);

        // Indiquer visuellement si le PiP est actif
        fetch('/api/config')
            .then(r => r.json())
            .then(config => {
                const pip = config.CAMERA2 || {};
                videoContainer.classList.toggle('pip-active', !!pip.pip_enabled);
            }).catch(() => {});
    }

    function _onPiPClick(e) {
        // Vérifier si le PiP est activé
        fetch('/api/config')
            .then(r => r.json())
            .then(config => {
                const pip = config.CAMERA2 || {};
                const pipEnabled = pip.pip_enabled || pip.enabled;
                if (!pipEnabled) return;

                // Calculer la zone PiP en tenant compte de object-fit:contain
                const container = e.currentTarget;
                const img = container.querySelector('img');
                const containerRect = container.getBoundingClientRect();

                // Rectangle réel de l'image affichée (object-fit: contain)
                let imgLeft, imgTop, imgW, imgH;
                if (img && img.naturalWidth > 0 && img.naturalHeight > 0) {
                    const cw = containerRect.width;
                    const ch = containerRect.height;
                    const iw = img.naturalWidth;
                    const ih = img.naturalHeight;
                    const scale = Math.min(cw / iw, ch / ih);
                    imgW = iw * scale;
                    imgH = ih * scale;
                    imgLeft = (cw - imgW) / 2;
                    imgTop = (ch - imgH) / 2;
                } else {
                    imgLeft = 0; imgTop = 0;
                    imgW = containerRect.width; imgH = containerRect.height;
                }

                // Coordonnées du clic relatives à l'image affichée
                const x = (e.clientX - containerRect.left - imgLeft) / imgW;
                const y = (e.clientY - containerRect.top - imgTop) / imgH;

                // Hors de l'image → ignorer
                if (x < 0 || x > 1 || y < 0 || y > 1) return;

                const position = pip.pip_position || 'top-right';
                const sizeMap = { small: 0.2, medium: 0.3, large: 0.4 };
                const size = sizeMap[pip.pip_size] || 0.2;

                let pipX, pipY;
                if (position === 'top-left') { pipX = 0; pipY = 0; }
                else if (position === 'top-right') { pipX = 1 - size; pipY = 0; }
                else if (position === 'bottom-left') { pipX = 0; pipY = 1 - size; }
                else { pipX = 1 - size; pipY = 1 - size; }

                // Marge de tolérance (la bordure PiP backend = 10px ≈ 2% de la frame)
                const margin = 0.03;
                if (x >= pipX - margin && x <= pipX + size + margin &&
                    y >= pipY - margin && y <= pipY + size + margin) {
                    // Clic dans la zone PiP → inverser les caméras
                    swapCamerasLive();
                }
            }).catch(() => {});
    }

    function swapCamerasLive() {
        // Feedback visuel immédiat
        showNotification('⏳ Inversion des caméras…');

        fetch('/api/cameras/swap', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        })
        .then(r => r.json())
        .then(data => {
            if (data.status === 'ok') {
                showNotification('📷 Caméras inversées !');
                // Mettre à jour les selects DOM si la page config est chargée
                const mainSelect = document.getElementById('cfg-camera-device');
                const pipSelect = document.getElementById('cfg-pip-device');
                if (mainSelect && data.main) mainSelect.value = data.main;
                if (pipSelect && data.pip) pipSelect.value = data.pip;
                // Mettre à jour le label caméra cockpit et recharger les contrôles V4L2
                _updateCockpitCamDevice();
                if (typeof CameraConfig !== 'undefined' && CameraConfig.loadConfig) {
                    CameraConfig.loadConfig().then(() => {
                        CameraConfig.loadParams(1);
                        // Synchroniser les sliders luminosité/contraste du cockpit
                        CameraConfig.syncCockpitSliders();
                    });
                }
                // Attendre que les caméras soient rouvertes côté backend
                setTimeout(() => _reconnectVideoStream(), 500);
            } else {
                showNotification('❌ Erreur swap: ' + (data.message || 'inconnue'));
            }
        })
        .catch(err => {
            console.error('[PiP] Erreur swap:', err);
            showNotification('❌ Erreur swap: ' + err.message);
        });
    }

    function loadCameraList() {
        fetch('/api/cameras/list')
            .then(r => r.json())
            .then(data => {
                const select = document.getElementById('cfg-camera-device');
                const pipSelect = document.getElementById('cfg-pip-device');
                if (!select) return;
                const currentVal = select.value;
                const currentPipVal = pipSelect ? pipSelect.value : null;
                select.innerHTML = '';
                if (pipSelect) pipSelect.innerHTML = '';

                if (data.devices && data.devices.length > 0) {
                    data.devices.forEach(dev => {
                        const opt = document.createElement('option');
                        opt.value = dev.path;
                        opt.textContent = dev.type ? `${dev.path} [${dev.type}] (${dev.name})` : `${dev.path} (${dev.name})`;
                        select.appendChild(opt);
                        if (pipSelect) pipSelect.appendChild(opt.cloneNode(true));
                    });
                } else {
                    select.innerHTML = '<option value="/dev/video0">/dev/video0</option>';
                    if (pipSelect) pipSelect.innerHTML = '<option value="/dev/video2">/dev/video2</option>';
                }
                if (currentVal) select.value = currentVal;
                if (currentPipVal && pipSelect) pipSelect.value = currentPipVal;
            }).catch(() => {});
    }

    // Détection forcée des caméras (ignore le cache backend)
    function detectCameras() {
        const btn = document.getElementById('btn-detect-cameras');
        const originalText = btn ? btn.textContent : '';
        if (btn) btn.textContent = '⏳ Scan...';
        if (btn) btn.disabled = true;

        fetch('/api/cameras/detect', { method: 'POST' })
            .then(r => r.json())
            .then(data => {
                // Mettre à jour les dropdowns avec les résultats
                const select = document.getElementById('cfg-camera-device');
                const pipSelect = document.getElementById('cfg-pip-device');
                if (!select) return;
                const currentVal = select.value;
                const currentPipVal = pipSelect ? pipSelect.value : null;
                select.innerHTML = '';
                if (pipSelect) pipSelect.innerHTML = '';

                if (data.devices && data.devices.length > 0) {
                    data.devices.forEach(dev => {
                        const opt = document.createElement('option');
                        opt.value = dev.path;
                        opt.textContent = dev.type ? `${dev.path} [${dev.type}] (${dev.name})` : `${dev.path} (${dev.name})`;
                        select.appendChild(opt);
                        if (pipSelect) pipSelect.appendChild(opt.cloneNode(true));
                    });
                } else {
                    select.innerHTML = '<option value="/dev/video0">/dev/video0</option>';
                    if (pipSelect) pipSelect.innerHTML = '<option value="/dev/video2">/dev/video2</option>';
                }
                if (currentVal) select.value = currentVal;
                if (currentPipVal && pipSelect) pipSelect.value = currentPipVal;

                // Notification avec résultat
                const scanTime = data.scan_time_ms || 0;
                const count = data.count || 0;
                showNotification(`🔍 ${count} caméra(s) détectée(s) en ${scanTime}ms`);
            })
            .catch(err => {
                console.error('[Caméras] Erreur détection:', err);
                showNotification('❌ Erreur détection caméras');
            })
            .finally(() => {
                if (btn) {
                    btn.textContent = originalText || '🔍 Détecter';
                    btn.disabled = false;
                }
            });
    }

    function loadCameraConfig() {
        fetch('/api/config')
            .then(r => r.json())
            .then(config => {
                const cam = config.CAMERA || {};
                const pip = config.CAMERA2 || {};
                const rec = config.RECORDING || {};
                setSelect('cfg-width', cam.width);
                setSelect('cfg-height', cam.height);
                setSelect('cfg-fps', cam.fps);
                setSelect('cfg-format', cam.format);
                setSelect('cfg-camera-device', cam.device);
                setCheckbox('cfg-osd-enabled', cam.osd_enabled);
                setCheckbox('cfg-pip-enabled', pip.pip_enabled);
                setSelect('cfg-pip-device', pip.device);
                setSelect('cfg-pip-position', pip.pip_position);
                setSelect('cfg-pip-size', pip.pip_size);
                setSelect('cfg-video-resolution', rec.video_resolution);
                setSelect('cfg-photo-resolution', rec.photo_resolution);
                setCheckbox('cfg-video-osd', rec.video_with_osd !== undefined ? rec.video_with_osd : true);
                setCheckbox('cfg-photo-osd', rec.photo_with_osd !== undefined ? rec.photo_with_osd : true);
                // Synchroniser avec les checkboxes du cockpit
                setCheckbox('cfg-record-video-osd', rec.video_with_osd !== undefined ? rec.video_with_osd : true);
                setCheckbox('cfg-record-photo-osd', rec.photo_with_osd !== undefined ? rec.photo_with_osd : true);
            }).catch(() => {});
    }

    function saveCameraConfig() {
        const config = {
            CAMERA: {
                device: document.getElementById('cfg-camera-device')?.value || '/dev/video0',
                width: parseInt(document.getElementById('cfg-width')?.value || '1280'),
                height: parseInt(document.getElementById('cfg-height')?.value || '720'),
                fps: parseInt(document.getElementById('cfg-fps')?.value || '30'),
                format: document.getElementById('cfg-format')?.value || 'MJPEG',
                osd_enabled: getCheckbox('cfg-osd-enabled')
            },
            CAMERA2: {
                pip_enabled: getCheckbox('cfg-pip-enabled'),
                device: document.getElementById('cfg-pip-device')?.value || '/dev/video2',
                pip_position: document.getElementById('cfg-pip-position')?.value || 'top-right',
                pip_size: document.getElementById('cfg-pip-size')?.value || 'small',
                enabled: getCheckbox('cfg-pip-enabled')
            },
            RECORDING: {
                video_resolution: document.getElementById('cfg-video-resolution')?.value || '1280x720',
                photo_resolution: document.getElementById('cfg-photo-resolution')?.value || '1920x1080',
                video_with_osd: getCheckbox('cfg-video-osd'),
                photo_with_osd: getCheckbox('cfg-photo-osd')
            }
        };
        fetch('/api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(config)
        }).then(r => r.json())
          .then(data => { console.log('[Caméra] Sauvegardée:', data); showNotification('Configuration caméra sauvegardée !'); })
          .catch(err => console.error('[Caméra] Erreur:', err));
    }

    function swapCameras() {
        const main = document.getElementById('cfg-camera-device')?.value;
        const pip = document.getElementById('cfg-pip-device')?.value;
        if (main && pip) {
            document.getElementById('cfg-camera-device').value = pip;
            document.getElementById('cfg-pip-device').value = main;
            showNotification('Caméras échangées !');
        }
    }

    // ==========================================================
    // SYSTÈME (DASHBOARD)
    // ==========================================================
    function refreshSystemInfo() {
        fetch('/api/system').then(r => r.json()).then(data => {
            setText('cpu-temp', data.cpu_temp ? `${data.cpu_temp}°C` : '--');
            setText('cpu-load', data.load_1m ? data.load_1m.toFixed(2) : '--');
            if (data.mem_used_pct !== undefined) {
                setText('mem-used', `${data.mem_used_pct}%`);
                const bar = document.getElementById('mem-bar');
                if (bar) bar.style.width = `${data.mem_used_pct}%`;
            }
            if (data.disk_free_gb !== undefined) setText('disk-free', `${data.disk_free_gb} Go`);
        }).catch(() => {});

        fetch('/api/health').then(r => r.json()).then(data => {
            const camStatus = document.getElementById('cam-status');
            if (camStatus) {
                if (data.video && data.video.camera_connected) {
                    camStatus.textContent = 'Connectée';
                    camStatus.style.color = 'var(--accent)';
                } else {
                    camStatus.textContent = 'Déconnectée';
                    camStatus.style.color = 'var(--accent-red)';
                }
            }
            setText('cam-fps', data.video ? `${data.video.fps}` : '--');
            setText('sensor-mode', data.sensors && data.sensors.simulation ? 'Simulation' : 'Réel');
            const simBadge = document.getElementById('nav-sim');
            if (simBadge) simBadge.classList.toggle('visible', !!(data.sensors && data.sensors.simulation));
        }).catch(() => {});

        refreshImuStatus();
    }

    // ==========================================================
    // IMU (centrale inertielle dynamique)
    // ==========================================================
    function refreshImuStatus() {
        fetch('/api/imu/status').then(r => r.json()).then(data => {
            setText('imu-sensor-name', data.sensor_name || '--');
            setText('imu-i2c-addr', data.i2c_address || '--');
            const health = document.getElementById('imu-health');
            if (health) {
                if (data.connected && data.healthy) {
                    health.textContent = '● Connecté';
                    health.style.color = 'var(--accent)';
                } else if (data.connected) {
                    health.textContent = '● Instable';
                    health.style.color = 'var(--accent-orange, #ffaa00)';
                } else {
                    health.textContent = '● Déconnecté';
                    health.style.color = 'var(--accent-red)';
                }
            }
            if (data.orientation) {
                setText('imu-orientation',
                    `${data.orientation.roll.toFixed(1)}° / ${data.orientation.pitch.toFixed(1)}° / ${data.orientation.yaw.toFixed(1)}°`);
            }
            if (data.acceleration) {
                setText('imu-accel',
                    `${data.acceleration.x.toFixed(2)} / ${data.acceleration.y.toFixed(2)} / ${data.acceleration.z.toFixed(2)}`);
            }
            const alertEl = document.getElementById('imu-alert');
            if (alertEl) {
                if (data.alert) {
                    alertEl.textContent = `⚠ ${data.alert}`;
                    alertEl.style.display = 'block';
                } else {
                    alertEl.style.display = 'none';
                }
            }
            // Synchroniser le sélecteur avec le capteur actif (hors focus)
            const select = document.getElementById('imu-sensor-select');
            if (select && data.sensor_type && document.activeElement !== select) {
                select.value = data.sensor_type;
            }
        }).catch(() => {});
    }

    function applyImuSensor() {
        const select = document.getElementById('imu-sensor-select');
        if (!select) return;
        const sensorType = select.value;
        fetch(`/api/imu/sensor/${sensorType}`, { method: 'POST' })
            .then(r => r.json())
            .then(data => {
                if (data.connected) {
                    showNotification(`✅ IMU ${sensorType} connectée`);
                } else {
                    showNotification(`⚠ IMU ${sensorType} sélectionnée mais injoignable (valeurs neutres)`);
                }
                refreshImuStatus();
            })
            .catch(err => showNotification('❌ Erreur IMU: ' + err.message));
    }

    // ==========================================================
    // UTILITAIRES
    // ==========================================================
    function setCheckbox(id, value) { const el = document.getElementById(id); if (el) el.checked = !!value; }
    function getCheckbox(id) { const el = document.getElementById(id); return el ? el.checked : false; }
    function setSelect(id, value) { const el = document.getElementById(id); if (el) el.value = String(value); }
    function setText(id, text) { const el = document.getElementById(id); if (el) el.textContent = text; }

    function showNotification(message) {
        const existing = document.querySelector('.notification');
        if (existing) existing.remove();
        const notif = document.createElement('div');
        notif.className = 'notification';
        notif.textContent = message;
        notif.style.cssText = `position:fixed;bottom:36px;right:20px;padding:10px 18px;border-radius:8px;background:var(--accent);color:#000;font-weight:600;font-size:12px;z-index:1000;animation:fadeIn 0.3s ease;`;
        document.body.appendChild(notif);
        setTimeout(() => notif.remove(), 3000);
    }

    // ==========================================================
    // CAPTEURS INDIVIDUELS (toggle sim/réel)
    // ==========================================================
    const SENSOR_LIST = ['roll', 'pitch', 'depth', 'temperature', 'heading', 'battery'];

    function initSensors() {
        // Toggle individuel par capteur
        SENSOR_LIST.forEach(sensor => {
            const cb = document.getElementById(`sens-${sensor}`);
            if (cb) {
                cb.addEventListener('change', () => {
                    // checked = simulé (true), unchecked = réel (false)
                    const simulated = cb.checked;
                    fetch(`/api/sensors/${sensor}/${simulated}`, { method: 'POST' })
                        .then(r => r.json())
                        .then(data => {
                            console.log(`[Sensors] ${sensor} → ${simulated ? 'SIM' : 'RÉEL'}`, data);
                            if (data.status === 'error') {
                                cb.checked = true; // Revenir en sim
                                showNotification(`Impossible: ${sensor} en mode réel (matériel non dispo)`);
                            }
                        })
                        .catch(() => { cb.checked = true; });
                });
            }
        });

        // ADXL345 toggle
        const adxl = document.getElementById('sens-adxl345');
        if (adxl) {
            adxl.addEventListener('change', () => {
                fetch(`/api/sensors/adxl345/${adxl.checked}`, { method: 'POST' })
                    .then(r => r.json())
                    .then(data => {
                        console.log('[Sensors] ADXL345:', data);
                        if (data.adxl345_ok) {
                            // Désactiver sim roll/pitch
                            const rollCb = document.getElementById('sens-roll');
                            const pitchCb = document.getElementById('sens-pitch');
                            if (rollCb) { rollCb.checked = false; }
                            if (pitchCb) { pitchCb.checked = false; }
                            showNotification('ADXL345 activé — roll/pitch en mode réel');
                        } else if (adxl.checked) {
                            showNotification('ADXL345 non détecté sur I2C');
                            adxl.checked = false;
                        }
                    })
                    .catch(() => { adxl.checked = false; });
            });
        }

        // Rafraîchir l'état des capteurs
        refreshSensorsStatus();
        setInterval(refreshSensorsStatus, 3000);
    }

    function refreshSensorsStatus() {
        // Récupérer capteurs et statut I2C en parallèle
        Promise.all([
            fetch('/api/sensors').then(r => r.json()),
            fetch('/api/i2c/status').then(r => r.json()).catch(() => null)
        ])
        .then(([data, i2cStatus]) => {
            const sensors = data.sensors || {};
            const hw = data.hardware || {};

            // Mettre à jour les checkboxes et labels
            SENSOR_LIST.forEach(sensor => {
                const cb = document.getElementById(`sens-${sensor}`);
                const status = document.getElementById(`sens-${sensor}-status`);
                if (cb && status) {
                    const isSim = sensors[sensor] !== false;
                    cb.checked = isSim;
                    status.textContent = isSim ? 'SIM' : 'RÉEL';
                    status.classList.toggle('real', !isSim);
                }
            });

            // ADXL345
            const adxlCb = document.getElementById('sens-adxl345');
            const adxlStatus = document.getElementById('sens-adxl345-status');
            if (adxlCb && adxlStatus) {
                adxlCb.checked = data.adxl345_ok;
                adxlStatus.textContent = data.adxl345_ok ? 'ACTIF' : 'OFF';
                adxlStatus.classList.toggle('real', data.adxl345_ok);
            }

            // Liste matériel — capteurs existants + PCA9685
            const hwList = document.getElementById('sensor-hw-list');
            if (hwList) {
                const hwLabels = { adxl345: 'ADXL345 (0x53)', depth: 'Profondeur', imu: 'IMU' };
                let html = Object.entries(hw).map(([k, v]) => {
                    const label = hwLabels[k] || k;
                    const cls = v === 'detected' ? 'detected' : (v === 'error' ? 'error' : 'not_found');
                    const icon = v === 'detected' ? '✅' : (v === 'error' ? '❌' : '⚠️');
                    return `<div class="sensor-hw-item ${cls}">${icon} ${label}: ${v}</div>`;
                }).join('');

                // Ajouter le statut PCA9685 (contrôleur moteur I2C — write-only, pas de read-back)
                if (i2cStatus) {
                    const addr = i2cStatus.address || '0x40';
                    let pcaCls, pcaIcon, pcaLabel;
                    if (i2cStatus.detected) {
                        pcaCls = 'detected';
                        pcaIcon = '✅';
                        pcaLabel = 'Connecté';
                    } else {
                        pcaCls = 'error';
                        pcaIcon = '❌';
                        pcaLabel = 'Non détecté';
                    }
                    html += `<div class="sensor-hw-item ${pcaCls}">${pcaIcon} PCA9685 (${addr}): ${pcaLabel}</div>`;
                }

                hwList.innerHTML = html;
            }
        })
        .catch(() => {});
    }

    // ==========================================================
    // ENREGISTREMENT VIDÉO / PHOTO
    // ==========================================================
    let _recordingActive = false;
    let _recordingInterval = null;

    function initRecording() {
        const btnStart = document.getElementById('btn-record-start');
        const btnStop = document.getElementById('btn-record-stop');
        const btnPhoto = document.getElementById('btn-photo');
        const btnRefresh = document.getElementById('btn-refresh-recordings');
        const infoEl = document.getElementById('record-info');
        const dotEl = document.getElementById('record-indicator');

        // Démarrer enregistrement
        if (btnStart) {
            btnStart.addEventListener('click', async () => {
                btnStart.disabled = true;
                const resSelect = document.getElementById('cfg-video-resolution');
                const resolution = resSelect ? resSelect.value : null;
                const withOsdEl = document.getElementById('cfg-record-video-osd');
                const with_osd = withOsdEl ? withOsdEl.checked : true;
                try {
                    const r = await fetch('/api/record/start', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ resolution, with_osd })
                    });
                    const data = await r.json();
                    if (data.status === 'ok') {
                        _recordingActive = true;
                        btnStop.disabled = false;
                        dotEl.classList.add('recording');
                        infoEl.textContent = `🔴 ${data.filename}`;
                        showNotification('Enregistrement démarré !');
                        _startRecordingPoll();
                    } else {
                        btnStart.disabled = false;
                        showNotification('Erreur: ' + data.message);
                    }
                } catch (e) {
                    btnStart.disabled = false;
                }
            });
        }

        // Arrêter enregistrement
        if (btnStop) {
            btnStop.addEventListener('click', async () => {
                btnStop.disabled = true;
                try {
                    const r = await fetch('/api/record/stop', { method: 'POST' });
                    const data = await r.json();
                    _recordingActive = false;
                    btnStart.disabled = false;
                    dotEl.classList.remove('recording');
                    if (data.status === 'ok') {
                        infoEl.textContent = `✅ ${data.filename} (${data.duration}s, ${data.size_mb}Mo)`;
                    } else {
                        infoEl.textContent = 'Prêt';
                    }
                    showNotification('Enregistrement arrêté');
                    _stopRecordingPoll();
                    refreshRecordings();
                } catch (e) {
                    btnStop.disabled = false;
                }
            });
        }

        // Photo
        if (btnPhoto) {
            btnPhoto.addEventListener('click', async () => {
                btnPhoto.disabled = true;
                const resSelect = document.getElementById('cfg-photo-resolution');
                const resolution = resSelect ? resSelect.value : null;
                const withOsdEl = document.getElementById('cfg-record-photo-osd');
                const with_osd = withOsdEl ? withOsdEl.checked : true;
                try {
                    const r = await fetch('/api/photo', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ resolution, with_osd })
                    });
                    const data = await r.json();
                    if (data.status === 'ok') {
                        showNotification('📷 Photo prise !');
                    }
                    // Attendre un peu que le fichier soit écrit
                    setTimeout(refreshRecordings, 500);
                } catch (e) { /* ignore */ }
                btnPhoto.disabled = false;
            });
        }

        // Rafraîchir la liste
        if (btnRefresh) {
            btnRefresh.addEventListener('click', refreshRecordings);
        }

        // Select All checkbox
        const chkSelectAll = document.getElementById('chk-select-all');
        if (chkSelectAll) {
            chkSelectAll.addEventListener('change', () => {
                const allChks = document.querySelectorAll('.chk-file');
                allChks.forEach(chk => {
                    chk.checked = chkSelectAll.checked;
                    if (chk.checked) _selectedFiles.add(chk.dataset.file);
                    else _selectedFiles.delete(chk.dataset.file);
                });
                chkSelectAll.indeterminate = false;
                _updateBulkButtons();
            });
        }

        // Bouton télécharger sélection
        const btnDownloadSelected = document.getElementById('btn-download-selected');
        if (btnDownloadSelected) {
            btnDownloadSelected.addEventListener('click', () => {
                if (_selectedFiles.size === 0) return;
                _selectedFiles.forEach(fname => {
                    const a = document.createElement('a');
                    a.href = `/api/recordings/${encodeURIComponent(fname)}`;
                    a.download = fname;
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                });
            });
        }

        // Bouton supprimer sélection
        const btnDeleteSelected = document.getElementById('btn-delete-selected');
        if (btnDeleteSelected) {
            btnDeleteSelected.addEventListener('click', async () => {
                if (_selectedFiles.size === 0) return;
                const count = _selectedFiles.size;
                if (!confirm(`Supprimer ${count} fichier(s) ?`)) return;
                const files = Array.from(_selectedFiles);
                try {
                    await Promise.all(files.map(fname =>
                        fetch(`/api/recordings/${encodeURIComponent(fname)}`, { method: 'DELETE' })
                    ));
                    _selectedFiles.clear();
                    refreshRecordings();
                } catch (e) { /* ignore */ }
            });
        }

        // Vérifier l'état au démarrage
        checkRecordingStatus();
        refreshRecordings();
    }

    function _startRecordingPoll() {
        if (_recordingInterval) clearInterval(_recordingInterval);
        _recordingInterval = setInterval(async () => {
            try {
                const r = await fetch('/api/record/status');
                const data = await r.json();
                if (!data.recording) {
                    // Enregistrement arrêté côté serveur
                    _recordingActive = false;
                    document.getElementById('btn-record-start').disabled = false;
                    document.getElementById('btn-record-stop').disabled = true;
                    document.getElementById('record-indicator').classList.remove('recording');
                    document.getElementById('record-info').textContent = 'Prêt';
                    _stopRecordingPoll();
                    refreshRecordings();
                } else {
                    document.getElementById('record-info').textContent =
                        `🔴 ${data.filename} (${data.duration}s)`;
                }
            } catch (e) { /* ignore */ }
        }, 2000);
    }

    function _stopRecordingPoll() {
        if (_recordingInterval) {
            clearInterval(_recordingInterval);
            _recordingInterval = null;
        }
    }

    async function checkRecordingStatus() {
        try {
            const r = await fetch('/api/record/status');
            const data = await r.json();
            if (data.recording) {
                _recordingActive = true;
                document.getElementById('btn-record-start').disabled = true;
                document.getElementById('btn-record-stop').disabled = false;
                document.getElementById('record-indicator').classList.add('recording');
                document.getElementById('record-info').textContent =
                    `🔴 ${data.filename} (${data.duration}s)`;
                _startRecordingPoll();
            }
        } catch (e) { /* ignore */ }
    }

    let _convertingPollInterval = null;
    let _selectedFiles = new Set(); // fichiers cochés pour action en masse

    function refreshRecordings() {
        fetch('/api/recordings')
            .then(r => r.json())
            .then(files => {
                const tbody = document.getElementById('recordings-list');
                if (!tbody) return;
                const countEl = document.getElementById('galerie-count');
                if (countEl) countEl.textContent = files && files.length ? `${files.length} fichier(s)` : '';

                if (!files || files.length === 0) {
                    tbody.innerHTML = '<tr><td colspan="6" class="hint-cell">Aucun enregistrement</td></tr>';
                    _selectedFiles.clear();
                    _updateBulkButtons();
                    _stopConvertingPoll();
                    return;
                }

                // Vérifier si un fichier est en cours de conversion
                const hasConverting = files.some(f => f.converting);

                tbody.innerHTML = files.map(f => {
                    const icon = f.type === 'video' ? '🎬' : '📷';
                    const typeLabel = f.type === 'video' ? 'Vidéo' : 'Photo';
                    const dateShort = f.date ? f.date.substring(0, 16).replace('T', ' ') : '';
                    const isVideo = f.type === 'video';
                    const isPhoto = f.type === 'photo';
                    const isConverting = f.converting;
                    const isChecked = _selectedFiles.has(f.filename);

                    // Bouton lecture : désactivé pendant la conversion
                    let viewBtn = '';
                    if (isPhoto) {
                        viewBtn = `<button class="btn btn-sm btn-view" data-file="${f.filename}" data-type="${f.type}" title="Aperçu">👁</button>`;
                    } else if (isVideo) {
                        if (isConverting) {
                            viewBtn = `<button class="btn btn-sm btn-view" disabled title="Conversion en cours…">⏳</button>`;
                        } else {
                            viewBtn = `<button class="btn btn-sm btn-view" data-file="${f.filename}" data-type="${f.type}" title="Lire">▶</button>`;
                        }
                    }

                    const convertingBadge = isConverting
                        ? `<span class="converting-badge" title="Conversion H.264 en cours pour lecture navigateur">⚙️ conversion…</span>`
                        : '';

                    return `<tr class="recording-row${isConverting ? ' converting' : ''}">
                        <td class="col-check"><input type="checkbox" class="chk-file" data-file="${f.filename}"${isChecked ? ' checked' : ''}></td>
                        <td class="col-type">${icon}</td>
                        <td class="col-name" title="${f.filename}">${f.filename}${convertingBadge}</td>
                        <td class="col-size">${f.size_mb} Mo</td>
                        <td class="col-date">${dateShort}</td>
                        <td class="col-actions">
                            ${viewBtn}
                            <a class="btn btn-sm btn-download" href="/api/recordings/${encodeURIComponent(f.filename)}" download title="Télécharger">⬇</a>
                            <button class="btn btn-sm btn-delete" data-file="${f.filename}" title="Supprimer"${isConverting ? ' disabled' : ''}>🗑</button>
                        </td>
                    </tr>`;
                }).join('');

                // Handlers checkboxes individuels
                tbody.querySelectorAll('.chk-file').forEach(chk => {
                    chk.addEventListener('change', () => {
                        if (chk.checked) _selectedFiles.add(chk.dataset.file);
                        else _selectedFiles.delete(chk.dataset.file);
                        _updateBulkButtons();
                        _updateSelectAllCheckbox();
                    });
                });

                // Handlers suppression individuelle
                tbody.querySelectorAll('.btn-delete:not([disabled])').forEach(btn => {
                    btn.addEventListener('click', async () => {
                        const fname = btn.dataset.file;
                        if (!confirm(`Supprimer ${fname} ?`)) return;
                        try {
                            await fetch(`/api/recordings/${encodeURIComponent(fname)}`, { method: 'DELETE' });
                            _selectedFiles.delete(fname);
                            refreshRecordings();
                        } catch (e) { /* ignore */ }
                    });
                });

                // Handlers lecture popup
                tbody.querySelectorAll('.btn-view:not([disabled])').forEach(btn => {
                    btn.addEventListener('click', () => {
                        openMediaModal(btn.dataset.file, btn.dataset.type);
                    });
                });

                _updateSelectAllCheckbox();
                _updateBulkButtons();

                // Auto-refresh pendant la conversion
                if (hasConverting) {
                    _startConvertingPoll();
                } else {
                    _stopConvertingPoll();
                }
            })
            .catch(() => {});
    }

    function _updateBulkButtons() {
        const dlBtn = document.getElementById('btn-download-selected');
        const delBtn = document.getElementById('btn-delete-selected');
        const hasSelection = _selectedFiles.size > 0;
        if (dlBtn) dlBtn.disabled = !hasSelection;
        if (delBtn) delBtn.disabled = !hasSelection;
    }

    function _updateSelectAllCheckbox() {
        const selectAll = document.getElementById('chk-select-all');
        if (!selectAll) return;
        const allChks = document.querySelectorAll('.chk-file');
        if (allChks.length === 0) { selectAll.checked = false; return; }
        selectAll.checked = Array.from(allChks).every(c => c.checked);
        selectAll.indeterminate = !selectAll.checked && Array.from(allChks).some(c => c.checked);
    }

    function _startConvertingPoll() {
        if (_convertingPollInterval) return;
        _convertingPollInterval = setInterval(() => {
            refreshRecordings();
        }, 3000);
    }

    function _stopConvertingPoll() {
        if (_convertingPollInterval) {
            clearInterval(_convertingPollInterval);
            _convertingPollInterval = null;
        }
    }

    // ==========================================================
    // MODAL POPUP LECTURE
    // ==========================================================
    function initMediaModal() {
        const modal = document.getElementById('media-modal');
        const closeBtn = document.getElementById('modal-close');
        if (!modal || !closeBtn) return;

        closeBtn.addEventListener('click', () => {
            modal.style.display = 'none';
            document.getElementById('modal-body').innerHTML = '';
        });
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.style.display = 'none';
                document.getElementById('modal-body').innerHTML = '';
            }
        });
    }

    function openMediaModal(filename, type) {
        const modal = document.getElementById('media-modal');
        const title = document.getElementById('modal-title');
        const body = document.getElementById('modal-body');
        if (!modal || !title || !body) return;

        const url = `/api/recordings/${encodeURIComponent(filename)}`;
        title.textContent = filename;

        if (type === 'photo') {
            body.innerHTML = `<img src="${url}" alt="${filename}" style="max-width:100%;max-height:70vh;display:block;margin:0 auto;border-radius:4px;">`;
        } else {
            const isMp4 = filename.toLowerCase().endsWith('.mp4');
            const mimeType = isMp4 ? 'video/mp4' : 'video/x-msvideo';
            body.innerHTML = `<video controls autoplay style="max-width:100%;max-height:70vh;display:block;margin:0 auto;border-radius:4px;">
                <source src="${url}" type="${mimeType}">
                Votre navigateur ne supporte pas la lecture vidéo.
            </video>`;
        }
        modal.style.display = 'flex';
    }

    // ==========================================================
    // FEEDBACK ACTIONS (manette + dispatcher WebSocket)
    // ==========================================================
    function initActionFeedback() {
        window.addEventListener('rov-action-result', (e) => {
            const r = e.detail;
            if (!r) return;

            const msg = r.message || '';
            const status = r.status || 'error';

            // === Action manette : toggle panneau latéral Cockpit ===
            // Exécutée côté IHM (pas de handler backend). On ignore le message
            // "Fonction planifiée" envoyé par le dispatcher pour les actions PLANNED.
            if (r.function === 'panel_toggle') {
                if (activeTile === 'cockpit') {
                    togglePanel();
                } else {
                    showNotification('⚠ Panneau latéral : activez d\'abord le Cockpit');
                }
                return;
            }

            // === Actions manette : mode Lunette (gérées côté IHM) ===
            if (r.function === 'fpv_toggle' && typeof Goggle !== 'undefined') {
                Goggle.toggle();
                return;
            }
            if (r.function === 'goggle_exit' && typeof Goggle !== 'undefined') {
                Goggle.deactivate();
                return;
            }
            if (r.function === 'night_toggle' && typeof Goggle !== 'undefined') {
                Goggle.toggleNight();
                return;
            }
            if (r.function === 'crosshair_toggle' && typeof Goggle !== 'undefined') {
                Goggle.toggleCrosshair();
                return;
            }

            // Notification visuelle
            if (msg) showNotification(msg);

            // Synchroniser l'état enregistrement avec le cockpit
            if (r.function === 'video_toggle' || r.function === 'video_osd_toggle' || r.function === 'video_no_osd_toggle') {
                const btnStart = document.getElementById('btn-record-start');
                const btnStop = document.getElementById('btn-record-stop');
                const dotEl = document.getElementById('record-indicator');
                const infoEl = document.getElementById('record-info');

                if (msg.includes('démarré') || msg.includes('Enregistrement démarré')) {
                    _recordingActive = true;
                    if (btnStart) btnStart.disabled = true;
                    if (btnStop) btnStop.disabled = false;
                    if (dotEl) dotEl.classList.add('recording');
                    if (infoEl) infoEl.textContent = '🔴 Enregistrement…';
                    _startRecordingPoll();
                } else if (msg.includes('arrêté') || msg.includes('arrêt')) {
                    _recordingActive = false;
                    if (btnStart) btnStart.disabled = false;
                    if (btnStop) btnStop.disabled = true;
                    if (dotEl) dotEl.classList.remove('recording');
                    if (infoEl) infoEl.textContent = 'Prêt';
                    _stopRecordingPoll();
                    refreshRecordings();
                }
            }

            // Rafraîchir la galerie après une photo
            if (r.function === 'photo' || r.function === 'photo_cam1_osd' || r.function === 'photo_cam1_no_osd' || r.function === 'photo_cam2_osd' || r.function === 'photo_cam2_no_osd') {
                if (status === 'ok') setTimeout(refreshRecordings, 500);
            }
        });
    }

    // ==========================================================
    // VÉRIFICATION CONNEXION I2C AU DÉMARRAGE
    // ==========================================================
    async function checkI2CConnection() {
        try {
            const response = await fetch('/api/i2c/status');
            const data = await response.json();
            if (!data.connected) {
                // Récupérer les détails capteurs pour le popup
                let sensorDetails = null;
                try {
                    const sensorResp = await fetch('/api/sensors');
                    sensorDetails = await sensorResp.json();
                } catch (e) { /* ignore */ }
                showI2CPopup(data, sensorDetails);
                // Lancer le polling pour fermer auto si reconnexion réussie
                _startI2CPoll();
            }
        } catch (e) {
            console.warn('Impossible de vérifier le statut I2C:', e);
        }
    }

    function _formatSensorStatus(sensors) {
        if (!sensors) return '<span style="color:#666;">Capteurs non disponibles</span>';
        const items = [];
        const labels = { roll: 'Roulis', pitch: 'Tangage', depth: 'Profondeur', heading: 'Cap', temperature: 'Température', battery: 'Batterie' };
        const order = ['roll', 'pitch', 'depth', 'heading', 'temperature', 'battery'];
        order.forEach(key => {
            if (key in sensors) {
                const isSim = sensors[key] !== false;
                const icon = isSim ? '🟡' : '🟢';
                const label = labels[key] || key;
                items.push(`<span style="display:inline-block;margin:2px 6px;font-size:12px;"><span style="font-size:10px;">${icon}</span> ${label}</span>`);
            }
        });
        return items.length > 0 ? items.join('') : '<span style="color:#666;">Capteurs non disponibles</span>';
    }

    function showI2CPopup(statusData, sensorDetails) {
        // Créer le modal overlay
        const overlay = document.createElement('div');
        overlay.id = 'i2c-popup-overlay';
        overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;z-index:10000;';

        const modal = document.createElement('div');
        modal.style.cssText = 'background:#1a1a2e;border:1px solid #e94560;border-radius:12px;padding:30px;max-width:420px;text-align:center;color:#fff;font-family:inherit;';

        const sensorHtml = sensorDetails && sensorDetails.sensors
            ? _formatSensorStatus(sensorDetails.sensors)
            : '<span style="color:#666;">Capteurs non disponibles</span>';

        modal.innerHTML = `
            <h3 style="color:#e94560;margin:0 0 15px;">⚠️ Contrôleur I2C non détecté</h3>
            <p style="color:#ccc;margin:0 0 12px;font-size:14px;">
                L'ESP32-S3 (adresse ${statusData.address || '0x40'}) n'est pas accessible sur le bus I2C.
            </p>
            ${statusData.last_error ? '<p style="color:#888;margin:0 0 12px;font-size:12px;">Erreur: ' + statusData.last_error + '</p>' : ''}
            <div style="background:#12122a;border-radius:8px;padding:12px;margin:0 0 16px;">
                <div style="font-size:12px;color:#888;margin-bottom:6px;">État des capteurs :</div>
                <div id="i2c-sensor-status" style="line-height:1.8;">${sensorHtml}</div>
            </div>
            <p style="color:#aaa;margin:0 0 20px;font-size:13px;">
                Passer en mode simulation ? Les commandes moteur seront simulées.
            </p>
            <div style="display:flex;gap:10px;justify-content:center;">
                <button id="i2c-btn-sim" style="padding:10px 20px;border:none;border-radius:6px;background:#e94560;color:#fff;cursor:pointer;font-size:14px;">
                    Mode Simulation
                </button>
                <button id="i2c-btn-retry" style="padding:10px 20px;border:none;border-radius:6px;background:#333;color:#fff;border:1px solid #555;cursor:pointer;font-size:14px;">
                    Réessayer
                </button>
            </div>
        `;

        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        // Bouton Simulation — active le mode simulation via l'API REST
        document.getElementById('i2c-btn-sim').addEventListener('click', async () => {
            try {
                await fetch('/api/sensors/simulation/true', {method: 'POST'});
            } catch (e) {
                console.warn('Erreur activation simulation:', e);
            }
            _stopI2CPoll();
            overlay.remove();
        });

        // Bouton Réessayer
        document.getElementById('i2c-btn-retry').addEventListener('click', async () => {
            const btn = document.getElementById('i2c-btn-retry');
            btn.textContent = '...';
            btn.disabled = true;
            try {
                const resp = await fetch('/api/i2c/reconnect', {method: 'POST'});
                const result = await resp.json();
                if (result.success) {
                    _stopI2CPoll();
                    overlay.remove();
                } else {
                    btn.textContent = 'Réessayer';
                    btn.disabled = false;
                }
            } catch (e) {
                btn.textContent = 'Réessayer';
                btn.disabled = false;
            }
        });

        // Mettre à jour les capteurs toutes les 3s pendant que le popup est affiché
        const sensorInterval = setInterval(async () => {
            if (!document.getElementById('i2c-sensor-status')) {
                clearInterval(sensorInterval);
                return;
            }
            try {
                const resp = await fetch('/api/sensors');
                const data = await resp.json();
                if (data.sensors) {
                    document.getElementById('i2c-sensor-status').innerHTML = _formatSensorStatus(data.sensors);
                }
            } catch (e) { /* ignore */ }
        }, 3000);
    }

    // Polling I2C — ferme le popup automatiquement si la connexion revient
    let _i2cPollInterval = null;

    function _startI2CPoll() {
        if (_i2cPollInterval) return;
        _i2cPollInterval = setInterval(async () => {
            const overlay = document.getElementById('i2c-popup-overlay');
            if (!overlay) { _stopI2CPoll(); return; }
            try {
                const resp = await fetch('/api/i2c/status');
                const data = await resp.json();
                if (data.connected) {
                    _stopI2CPoll();
                    overlay.remove();
                    showNotification('✅ Contrôleur I2C reconnecté !');
                }
            } catch (e) { /* ignore */ }
        }, 10000);
    }

    function _stopI2CPoll() {
        if (_i2cPollInterval) {
            clearInterval(_i2cPollInterval);
            _i2cPollInterval = null;
        }
    }

    // ==========================================================
    // ACCORDÉON VERTICAL (panneau latéral Cockpit)
    // ==========================================================
    const PANEL_STATE_KEY = 'bobrov-cockpit-sections';

    function initAccordion() {
        const sections = document.querySelectorAll('#control-panel .cockpit-section');
        if (!sections.length) return;

        // Charger l'état sauvegardé (tableau d'IDs repliés)
        let collapsedIds = [];
        try {
            const raw = localStorage.getItem(PANEL_STATE_KEY);
            if (raw) collapsedIds = JSON.parse(raw) || [];
        } catch (e) { collapsedIds = []; }

        sections.forEach(sec => {
            const id = sec.dataset.section;
            const header = sec.querySelector('.section-header');
            if (!header) return;

            // Restaurer l'état replié si mémorisé
            if (collapsedIds.includes(id)) {
                sec.classList.add('collapsed');
            }

            // Handler clic sur en-tête
            header.addEventListener('click', (e) => {
                // Ne pas plier si l'utilisateur clique dans un champ du header (pas le cas ici)
                sec.classList.toggle('collapsed');
                _saveAccordionState();
            });
        });
    }

    function _saveAccordionState() {
        const sections = document.querySelectorAll('#control-panel .cockpit-section');
        const collapsed = [];
        sections.forEach(sec => {
            if (sec.classList.contains('collapsed') && sec.dataset.section) {
                collapsed.push(sec.dataset.section);
            }
        });
        try {
            localStorage.setItem(PANEL_STATE_KEY, JSON.stringify(collapsed));
        } catch (e) { /* ignore quota */ }
    }

    // ==========================================================
    // PANNEAU LATÉRAL ESCAMOTABLE (Cockpit)
    // ==========================================================
    let _panelCollapsed = false;

    function initPanelToggle() {
        const btn = document.getElementById('btn-toggle-panel');
        if (btn) {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                togglePanel();
            });
        }
        // Raccourci clavier : touche "F" (uniquement si Cockpit actif et hors input)
        document.addEventListener('keydown', (e) => {
            if (activeTile !== 'cockpit') return;
            const tag = (e.target && e.target.tagName) || '';
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
            if (e.key === 'f' || e.key === 'F') {
                e.preventDefault();
                togglePanel();
            }
        });
    }

    function togglePanel() {
        const layout = document.getElementById('cockpit-layout');
        const btn = document.getElementById('btn-toggle-panel');
        if (!layout) return;
        _panelCollapsed = !_panelCollapsed;
        layout.classList.toggle('panel-collapsed', _panelCollapsed);
        if (btn) {
            btn.textContent = _panelCollapsed ? '▶' : '◀';
            btn.classList.toggle('collapsed', _panelCollapsed);
            btn.title = _panelCollapsed ? 'Afficher le panneau (F)' : 'Masquer le panneau (F)';
        }
        // Forcer un redimensionnement de l'OSD backend après la transition
        setTimeout(() => { window.dispatchEvent(new Event('resize')); }, 360);
    }

    // ==========================================================
    // INITIALISATION
    // ==========================================================
    function init() {
        console.log('[App] BOB-ROV initialisation');
        initNavigation();
        initTheme();
        initControls();
        initConfigCamera();
        initCockpitCam();
        initPiPClick();
        initSensors();
        initRecording();
        initActionFeedback();
        initMediaModal();
        initPanelToggle();
        initAccordion();
        refreshSystemInfo();
        setInterval(refreshSystemInfo, 5000);

        // Mode Lunette
        if (typeof Goggle !== 'undefined') Goggle.init();

        // Navigation UI par manette
        if (typeof GamepadNav !== 'undefined') GamepadNav.init();

        // Charger le statut des actions
        if (typeof ActionStatus !== 'undefined') {
            ActionStatus.load();
        }

        // Vérifier la connexion I2C au démarrage
        checkI2CConnection();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();

    // ==========================================================
    // REBOOT SYSTÈME — confirmation puis appel API
    // ==========================================================
    function confirmReboot() {
        if (!confirm('⚠️ Redémarrer le Raspberry Pi ?\n\nLe ROV sera indisponible pendant ~30 secondes.')) return;
        const btn = document.getElementById('btn-reboot');
        if (btn) { btn.disabled = true; btn.textContent = '⏳ Redémarrage…'; }
        fetch('/api/system/reboot', { method: 'POST' })
            .then(r => r.json())
            .then(data => {
                showNotification('🔄 Redémarrage en cours… Reconnexion dans 30s.');
                // Tenter une reconnexion périodique
                let attempts = 0;
                const pingInterval = setInterval(() => {
                    attempts++;
                    if (attempts > 60) { clearInterval(pingInterval); return; }
                    fetch('/api/health').then(r => {
                        if (r.ok) {
                            clearInterval(pingInterval);
                            showNotification('✅ Système reconnecté !');
                            location.reload();
                        }
                    }).catch(() => {});
                }, 2000);
            })
            .catch(err => {
                if (btn) { btn.disabled = false; btn.textContent = '🔄 Redémarrer le Pi'; }
                showNotification('❌ Erreur: ' + err.message);
            });
    }

    return { switchTile, goHome, activeTile: () => activeTile, showNotification, setTheme, setCheckbox, getCheckbox, setSelect, setText, confirmReboot, applyImuSensor };
})();
