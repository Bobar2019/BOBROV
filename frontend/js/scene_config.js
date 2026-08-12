/**
 * BOB-ROV — Module Configuration Scène 3D
 * Gestion des modèles GLB, objets de scène et paramètres de faune/flore/décor
 */
'use strict';

const SceneConfig = (() => {

    let _config = { objects: [] };
    let _models = [];
    let _initialized = false;
    let _saveTimer = null;
    const _thumbnailCache = {};  // modelUrl → dataURL

    const DEFAULT_OBJECT = {
        name: "Nouvel objet",
        type: "faune",
        model: "",
        real_size_m: 1.0,
        count: 1,
        scale_min: 0.8,
        scale_max: 1.2,
        kinematic: "fixe",
        zone: "fond",
        speed: 1.0,
        behavior: "neant"
    };

    // ==========================================================
    // UTILITAIRES
    // ==========================================================

    /** Formater une taille de fichier en unités lisibles */
    function _formatSize(bytes) {
        if (bytes < 1024) return bytes + ' o';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' Ko';
        return (bytes / (1024 * 1024)).toFixed(2) + ' Mo';
    }

    /** Debounce de la sauvegarde (500 ms) */
    function _debounceSave() {
        if (_saveTimer) clearTimeout(_saveTimer);
        _saveTimer = setTimeout(() => _saveConfig(), 500);
    }

    /** Toast notification (succès / erreur / info) */
    function _showToast(message, type, duration) {
        type = type || 'success';
        duration = duration || 3000;
        var container = document.getElementById('s3d-toast-container');
        if (!container) {
            container = document.createElement('div');
            container.id = 's3d-toast-container';
            container.className = 's3d-toast-container';
            document.body.appendChild(container);
        }
        var toast = document.createElement('div');
        toast.className = 's3d-toast s3d-toast--' + type;
        toast.textContent = message;
        container.appendChild(toast);
        requestAnimationFrame(function() {
            requestAnimationFrame(function() { toast.classList.add('s3d-toast--visible'); });
        });
        setTimeout(function() {
            toast.classList.remove('s3d-toast--visible');
            setTimeout(function() { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 350);
        }, duration);
    }

    /** Génère (ou récupère du cache) une miniature et l'applique à un élément DOM */
    function _applyThumb(modelUrl, el) {
        if (!modelUrl || !el) return;
        // Déjà en cache
        if (_thumbnailCache[modelUrl]) {
            el.innerHTML = '';
            el.appendChild(_el('img', { className: 's3d-thumb-img', src: _thumbnailCache[modelUrl] }));
            return;
        }
        // Marquer comme en cours de chargement
        el.classList.add('s3d-thumb-loading');
        // Générer via Scene3DViewer (module ES)
        if (window.Scene3DViewer && typeof window.Scene3DViewer.generateThumbnail === 'function') {
            window.Scene3DViewer.generateThumbnail(modelUrl).then(function(dataUrl) {
                el.classList.remove('s3d-thumb-loading');
                if (dataUrl) {
                    _thumbnailCache[modelUrl] = dataUrl;
                    el.innerHTML = '';
                    el.appendChild(_el('img', { className: 's3d-thumb-img', src: dataUrl }));
                }
            });
        }
    }

    /** Créer un élément DOM avec attributs optionnels */
    function _el(tag, attrs, children) {
        const el = document.createElement(tag);
        if (attrs) {
            Object.keys(attrs).forEach(k => {
                if (k === 'className') el.className = attrs[k];
                else if (k === 'textContent') el.textContent = attrs[k];
                else if (k === 'innerHTML') el.innerHTML = attrs[k];
                else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
                else el.setAttribute(k, attrs[k]);
            });
        }
        if (children) {
            (Array.isArray(children) ? children : [children]).forEach(c => {
                if (typeof c === 'string') el.appendChild(document.createTextNode(c));
                else if (c) el.appendChild(c);
            });
        }
        return el;
    }

    // ==========================================================
    // COMMUNICATION BACKEND
    // ==========================================================

    /** Charger la configuration scène depuis le backend */
    async function _loadConfig() {
        try {
            const res = await fetch('/api/scene3d/config');
            if (!res.ok) throw new Error('Erreur chargement config scène 3D');
            _config = await res.json();
            if (!_config.objects) _config.objects = [];
        } catch (e) {
            console.error('[SceneConfig] _loadConfig:', e);
            _config = { objects: [] };
        }
    }

    /** Sauvegarder la configuration scène vers le backend */
    async function _saveConfig() {
        try {
            const res = await fetch('/api/scene3d/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(_config)
            });
            if (!res.ok) throw new Error('Erreur sauvegarde config scène 3D');
            _showToast('\u2705 Configuration enregistrée avec succès !', 'success');
        } catch (e) {
            console.error('[SceneConfig] _saveConfig:', e);
            _showToast('\u274c Erreur de sauvegarde de la configuration.', 'error');
        }
    }

    /** Réinitialiser la configuration (avec confirmation) */
    async function _resetConfig() {
        if (!confirm('Réinitialiser la configuration scène 3D ? Cette action est irréversible.')) return;
        try {
            const res = await fetch('/api/scene3d/config/reset', { method: 'POST' });
            if (!res.ok) throw new Error('Erreur reset config scène 3D');
            await _loadConfig();
            _renderObjects();
        } catch (e) {
            console.error('[SceneConfig] _resetConfig:', e);
        }
    }

    /** Charger la liste des modèles disponibles */
    async function _loadModels() {
        try {
            const res = await fetch('/api/scene3d/models');
            if (!res.ok) throw new Error('Erreur chargement liste modèles');
            const data = await res.json();
            _models = data.models || [];
        } catch (e) {
            console.error('[SceneConfig] _loadModels:', e);
            _models = [];
        }
    }

    /** Envoyer un fichier modèle GLB/GLTF vers le backend */
    async function _uploadModel(file) {
        var fileName = file.name;
        try {
            const fd = new FormData();
            fd.append('file', file);
            const res = await fetch('/api/scene3d/upload', { method: 'POST', body: fd });
            if (!res.ok) throw new Error('Erreur upload modèle');
            await _loadModels();
            _renderLibrary();
            _renderObjects();
            _showToast('\ud83d\udce5 Modèle ' + fileName + ' téléversé avec succès !', 'success');
        } catch (e) {
            console.error('[SceneConfig] _uploadModel:', e);
            _showToast('\u274c Erreur lors du téléversement de ' + fileName + '.', 'error');
        }
    }

    /** Supprimer un modèle du backend (avec confirmation) */
    async function _deleteModel(filename) {
        if (!confirm('Supprimer le modèle "' + filename + '" ?')) return;
        try {
            const res = await fetch('/api/scene3d/models/' + encodeURIComponent(filename), { method: 'DELETE' });
            if (!res.ok) throw new Error('Erreur suppression modèle');
            await _loadModels();
            _renderLibrary();
            _renderObjects();
        } catch (e) {
            console.error('[SceneConfig] _deleteModel:', e);
        }
    }

    // ==========================================================
    // RENDU UI — BIBLIOTHÈQUE DE MODÈLES
    // ==========================================================

    /** Rendre la grille de modèles disponibles dans #scene3d-library */
    function _renderLibrary() {
        const container = document.getElementById('scene3d-library');
        if (!container) return;
        container.innerHTML = '';

        if (_models.length === 0) {
            container.innerHTML = '<p style="color:#5c7294;font-size:0.82rem;grid-column:1/-1;text-align:center;padding:12px 0;margin:0;">Aucun modèle disponible. Uploadez un fichier .glb ou .gltf.</p>';
            return;
        }

        _models.forEach(m => {
            // Miniature : div dédié qui recevra l'image (ou placeholder)
            var thumbEl = _el('div', { className: 's3d-lib-thumb', textContent: '\ud83e\uddca' });
            _applyThumb(m.url, thumbEl);

            const card = _el('div', { className: 's3d-lib-card' }, [
                thumbEl,
                _el('div', { className: 's3d-lib-info' }, [
                    _el('span', { className: 's3d-lib-name', textContent: m.name }),
                    _el('span', { className: 's3d-lib-size', textContent: _formatSize(m.size) })
                ]),
                _el('div', { className: 's3d-lib-actions' }, [
                    _el('button', {
                        className: 's3d-lib-btn',
                        title: 'Inspecter le modèle',
                        textContent: '\ud83d\udd0d',
                        onClick: (e) => { e.stopPropagation(); _openInspector(m.url); }
                    }),
                    _el('button', {
                        className: 's3d-lib-btn s3d-lib-btn--danger',
                        title: 'Supprimer le modèle',
                        textContent: '\ud83d\uddd1\ufe0f',
                        onClick: (e) => { e.stopPropagation(); _deleteModel(m.name); }
                    })
                ])
            ]);
            // Clic sur la carte ouvre aussi l'inspecteur
            card.addEventListener('click', () => _openInspector(m.url));
            container.appendChild(card);
        });
    }

    // ==========================================================
    // RENDU UI — TABLEAU DES OBJETS DE SCÈNE
    // ==========================================================

    /** Construire les options pour un select à partir d'un tableau de valeurs */
    function _buildOptions(values, selected) {
        return values.map(v => {
            const label = typeof v === 'object' ? v.label : v;
            const val = typeof v === 'object' ? v.value : v;
            const sel = val === selected ? ' selected' : '';
            return '<option value="' + val + '"' + sel + '>' + label + '</option>';
        }).join('');
    }

    /** Rendre le tableau complet des objets configurés */
    function _renderObjects() {
        const tbody = document.getElementById('scene3d-objects-list');
        const emptyMsg = document.getElementById('scene3d-empty-msg');
        if (!tbody) return;
        tbody.innerHTML = '';

        // Afficher / masquer le message vide
        if (emptyMsg) {
            emptyMsg.style.display = _config.objects.length === 0 ? 'block' : 'none';
        }

        _config.objects.forEach((obj, idx) => {
            const tr = document.createElement('tr');

            // ── Colonne 1 : Miniature cliquable ──
            const tdThumb = document.createElement('td');
            const thumbDiv = _el('div', { className: 's3d-thumb-cell', textContent: '\ud83e\uddca', title: 'Inspecter le modèle' });
            // Appliquer la miniature si un modèle est déjà sélectionné
            if (obj.model) {
                var found = _models.find(function(m) { return m.name === obj.model; });
                if (found) _applyThumb(found.url, thumbDiv);
            }
            thumbDiv.addEventListener('click', function() {
                if (obj.model) {
                    var f = _models.find(function(m) { return m.name === obj.model; });
                    if (f) _openInspector(f.url);
                }
            });
            tdThumb.appendChild(thumbDiv);
            tr.appendChild(tdThumb);

            // ── Colonne 2 : Nom ──
            const tdName = document.createElement('td');
            tdName.appendChild(_el('input', {
                type: 'text', value: obj.name || '', placeholder: 'Nom…',
                onInput: (e) => _updateObject(idx, 'name', e.target.value)
            }));
            tr.appendChild(tdName);

            // ── Colonne 3 : Type (faune / flore / objet) ──
            const tdType = document.createElement('td');
            tdType.appendChild(_el('select', {
                innerHTML: _buildOptions([
                    { value: 'faune',  label: '🐠 Faune' },
                    { value: 'flore',  label: '🌿 Flore' },
                    { value: 'objet',  label: '📦 Objet' }
                ], obj.type),
                onChange: (e) => {
                    _updateObject(idx, 'type', e.target.value);
                    // Auto-config pour la flore : fixe au sol avec ondulation
                    if (e.target.value === 'flore') {
                        _updateObject(idx, 'kinematic', 'ancre_ondule');
                        _updateObject(idx, 'zone', 'fond');
                        _renderObjects();
                    }
                }
            }));
            tr.appendChild(tdType);

            // ── Colonne 4 : Modèle GLB ──
            const tdModel = document.createElement('td');
            const modelOpts = '<option value="">— Aucun —</option>' +
                _models.map(m => {
                    const sel = m.name === obj.model ? ' selected' : '';
                    return '<option value="' + m.name + '"' + sel + '>' + m.name + '</option>';
                }).join('');
            tdModel.appendChild(_el('select', {
                innerHTML: modelOpts,
                onChange: (e) => {
                    _updateObject(idx, 'model', e.target.value);
                    // Mise à jour réactive de la miniature
                    if (e.target.value) {
                        var m = _models.find(function(md) { return md.name === e.target.value; });
                        if (m) _applyThumb(m.url, thumbDiv);
                    } else {
                        thumbDiv.innerHTML = '\ud83e\uddca';
                    }
                }
            }));
            tr.appendChild(tdModel);

            // ── Colonne 5 : Taille (m) ──
            const tdSize = document.createElement('td');
            tdSize.appendChild(_el('input', {
                type: 'number', step: '0.01', min: '0.01', value: obj.real_size_m,
                onInput: (e) => _updateObject(idx, 'real_size_m', parseFloat(e.target.value) || 1.0)
            }));
            tr.appendChild(tdSize);

            // ── Colonne 6 : Quantité ──
            const tdQty = document.createElement('td');
            tdQty.appendChild(_el('input', {
                type: 'number', min: '1', step: '1', value: obj.count,
                onInput: (e) => _updateObject(idx, 'count', parseInt(e.target.value) || 1)
            }));
            tr.appendChild(tdQty);

            // ── Colonne 7 : Zone ──
            const tdZone = document.createElement('td');
            tdZone.appendChild(_el('select', {
                innerHTML: _buildOptions([
                    { value: 'fond',          label: 'Fond' },
                    { value: 'pleine_eau',    label: 'Pleine eau' },
                    { value: 'surface',       label: 'Surface' },
                    { value: 'multi_couches', label: 'Multi-couches' }
                ], obj.zone),
                onChange: (e) => _updateObject(idx, 'zone', e.target.value)
            }));
            tr.appendChild(tdZone);

            // ── Colonne 8 : Vitesse ──
            const tdSpeed = document.createElement('td');
            tdSpeed.appendChild(_el('input', {
                type: 'number', step: '0.1', min: '0', value: obj.speed != null ? obj.speed : 1.0,
                onInput: (e) => _updateObject(idx, 'speed', parseFloat(e.target.value) || 0)
            }));
            tr.appendChild(tdSpeed);

            // ── Colonne 9 : Comportement ──
            const tdBehav = document.createElement('td');
            tdBehav.appendChild(_el('select', {
                innerHTML: _buildOptions([
                    { value: 'fixe',    label: '📌 Fixe' },
                    { value: 'static',  label: '⏸️ Static (sans anim)' },
                    { value: 'nageant', label: '🏊 Nageant' },
                    { value: 'fuir',    label: '💨 Fuir' },
                    { value: 'curieux', label: '👀 Curieux' }
                ], obj.behavior),
                onChange: (e) => _updateObject(idx, 'behavior', e.target.value)
            }));
            tr.appendChild(tdBehav);

            // ── Colonne 10 : Supprimer ──
            const tdDel = document.createElement('td');
            tdDel.appendChild(_el('button', {
                className: 's3d-del-btn',
                title: 'Supprimer cet objet',
                textContent: '🗑️',
                onClick: () => _removeObject(idx)
            }));
            tr.appendChild(tdDel);

            tbody.appendChild(tr);
        });
    }

    // ==========================================================
    // GESTION DES OBJETS
    // ==========================================================

    /** Ajouter un nouvel objet par défaut */
    function _addObject() {
        _config.objects.push(Object.assign({}, DEFAULT_OBJECT));
        _renderObjects();
        _saveConfig();
    }

    /** Supprimer un objet (avec confirmation) */
    function _removeObject(index) {
        if (!confirm('Supprimer l\'objet "' + (_config.objects[index]?.name || '') + '" ?')) return;
        _config.objects.splice(index, 1);
        _renderObjects();
        _saveConfig();
    }

    /** Mettre à jour un champ d'un objet et auto-sauvegarder */
    function _updateObject(index, field, value) {
        if (!_config.objects[index]) return;
        _config.objects[index][field] = value;
        _debounceSave();
    }

    // ==========================================================
    // INSPECTEUR 3D
    // ==========================================================

    /** Ouvrir la modale d'inspection 3D */
    function _openInspector(modelUrl) {
        const modal = document.getElementById('scene3d-inspector-modal');
        const canvas = document.getElementById('scene3d-inspector-canvas');
        if (!modal || !canvas) return;
        modal.classList.add('active');
        if (window.Scene3DViewer && typeof window.Scene3DViewer.open === 'function') {
            window.Scene3DViewer.open(modelUrl, canvas);
        }
    }

    /** Fermer la modale d'inspection 3D */
    function _closeInspector() {
        const modal = document.getElementById('scene3d-inspector-modal');
        if (modal) modal.classList.remove('active');
        if (window.Scene3DViewer && typeof window.Scene3DViewer.close === 'function') {
            window.Scene3DViewer.close();
        }
    }

    // ==========================================================
    // ENVIRONNEMENT SOUS-MARIN
    // ==========================================================

    /** Valeurs par défaut de l'environnement */
    const DEFAULT_ENV = {
        current: 0.5,
        reef: {
            algae: { enabled: true, density: 0.22, length: 1.0 },
            corals: { enabled: true, density: 100 },
            fish: { enabled: true, count: 360, speed: 1.0 },
        },
        abyss: {
            creatures: { enabled: true, density: 100 },
            pikes: { enabled: true },
        },
        terrain: { enabled: false, height: 0.9 },
        walls: { enabled: false, tiling: 3.0 },
        surface: {
            waves: { enabled: true, height: 0.5, speed: 1.0 },
            caustics: { enabled: true, intensity: 0.7 },
            godrays: { enabled: true, intensity: 0.5 },
        },
        compact_zone: 0,
    };

    /** Garantit que la section environment existe dans la config */
    function _ensureEnv() {
        if (!_config.environment) _config.environment = JSON.parse(JSON.stringify(DEFAULT_ENV));
        const env = _config.environment;
        if (!env.reef) env.reef = JSON.parse(JSON.stringify(DEFAULT_ENV.reef));
        if (!env.abyss) env.abyss = JSON.parse(JSON.stringify(DEFAULT_ENV.abyss));
        if (!env.reef.algae) env.reef.algae = JSON.parse(JSON.stringify(DEFAULT_ENV.reef.algae));
        if (!env.reef.corals) env.reef.corals = JSON.parse(JSON.stringify(DEFAULT_ENV.reef.corals));
        if (!env.reef.fish) env.reef.fish = JSON.parse(JSON.stringify(DEFAULT_ENV.reef.fish));
        if (!env.abyss.creatures) env.abyss.creatures = JSON.parse(JSON.stringify(DEFAULT_ENV.abyss.creatures));
        if (!env.abyss.pikes) env.abyss.pikes = JSON.parse(JSON.stringify(DEFAULT_ENV.abyss.pikes));
        if (!env.terrain) env.terrain = JSON.parse(JSON.stringify(DEFAULT_ENV.terrain));
        if (!env.walls) env.walls = JSON.parse(JSON.stringify(DEFAULT_ENV.walls));
        if (!env.surface) env.surface = JSON.parse(JSON.stringify(DEFAULT_ENV.surface));
        if (!env.surface.waves) env.surface.waves = JSON.parse(JSON.stringify(DEFAULT_ENV.surface.waves));
        if (!env.surface.caustics) env.surface.caustics = JSON.parse(JSON.stringify(DEFAULT_ENV.surface.caustics));
        if (!env.surface.godrays) env.surface.godrays = JSON.parse(JSON.stringify(DEFAULT_ENV.surface.godrays));
        if (env.current === undefined) env.current = DEFAULT_ENV.current;
        if (env.compact_zone === undefined) env.compact_zone = DEFAULT_ENV.compact_zone;
    }

    /** Bind un slider : lit la valeur, met à jour le label, sauvegarde au changement */
    function _bindEnvSlider(id, getter, setter, formatter) {
        const slider = document.getElementById(id);
        const label = document.getElementById(id + '-val');
        if (!slider) return;
        slider.value = getter();
        if (label) label.textContent = formatter(getter());
        slider.addEventListener('input', () => {
            const v = parseFloat(slider.value);
            setter(v);
            if (label) label.textContent = formatter(v);
            _debounceSave();
        });
    }

    /** Bind un checkbox : lit la valeur, sauvegarde au changement */
    function _bindEnvCheck(id, getter, setter) {
        const chk = document.getElementById(id);
        if (!chk) return;
        chk.checked = getter();
        chk.addEventListener('change', () => {
            setter(chk.checked);
            _debounceSave();
        });
    }

    /** Initialise les contrôles environnement */
    function _initEnvironment() {
        _ensureEnv();
        const env = _config.environment;

        // Courant
        _bindEnvSlider('env-current',
            () => Math.round(env.current * 100),
            v => { env.current = v / 100; },
            v => v + ' %');

        // Algues
        _bindEnvCheck('env-algae-enabled', () => env.reef.algae.enabled, v => { env.reef.algae.enabled = v; });
        _bindEnvSlider('env-algae-density',
            () => Math.round(env.reef.algae.density * 100),
            v => { env.reef.algae.density = v / 100; },
            v => v + ' %');
        _bindEnvSlider('env-algae-length',
            () => env.reef.algae.length,
            v => { env.reef.algae.length = v; },
            v => v.toFixed(1) + '\u00d7');

        // Coraux
        _bindEnvCheck('env-corals-enabled', () => env.reef.corals.enabled, v => { env.reef.corals.enabled = v; });
        _bindEnvSlider('env-corals-density',
            () => env.reef.corals.density,
            v => { env.reef.corals.density = v; },
            v => v + ' %');

        // Poissons
        _bindEnvCheck('env-fish-enabled', () => env.reef.fish.enabled, v => { env.reef.fish.enabled = v; });
        _bindEnvSlider('env-fish-count',
            () => env.reef.fish.count,
            v => { env.reef.fish.count = v; },
            v => '' + v);
        _bindEnvSlider('env-fish-speed',
            () => env.reef.fish.speed,
            v => { env.reef.fish.speed = v; },
            v => v.toFixed(1) + '\u00d7');

        // Abysses - créatures
        _bindEnvCheck('env-abyss-enabled', () => env.abyss.creatures.enabled, v => { env.abyss.creatures.enabled = v; });
        _bindEnvSlider('env-abyss-density',
            () => env.abyss.creatures.density,
            v => { env.abyss.creatures.density = v; },
            v => v + ' %');

        // Brochets
        _bindEnvCheck('env-pikes-enabled', () => env.abyss.pikes.enabled, v => { env.abyss.pikes.enabled = v; });

        // Terrain
        _bindEnvCheck('env-terrain-enabled', () => env.terrain.enabled, v => { env.terrain.enabled = v; });
        _bindEnvSlider('env-terrain-height',
            () => env.terrain.height,
            v => { env.terrain.height = v; },
            v => v.toFixed(1));

        // Parois
        _bindEnvCheck('env-walls-enabled', () => env.walls.enabled, v => { env.walls.enabled = v; });
        _bindEnvSlider('env-walls-tiling',
            () => env.walls.tiling,
            v => { env.walls.tiling = v; },
            v => v.toFixed(1));

        // Surface / Vagues
        _bindEnvCheck('env-waves-enabled', () => env.surface.waves.enabled, v => { env.surface.waves.enabled = v; });
        _bindEnvSlider('env-waves-height',
            () => env.surface.waves.height,
            v => { env.surface.waves.height = v; },
            v => v.toFixed(1) + ' m');
        _bindEnvSlider('env-waves-speed',
            () => env.surface.waves.speed,
            v => { env.surface.waves.speed = v; },
            v => v.toFixed(1) + '\u00d7');
        _bindEnvCheck('env-caustics-enabled', () => env.surface.caustics.enabled, v => { env.surface.caustics.enabled = v; });
        _bindEnvSlider('env-caustics-intensity',
            () => Math.round(env.surface.caustics.intensity * 100),
            v => { env.surface.caustics.intensity = v / 100; },
            v => v + ' %');
        _bindEnvCheck('env-godrays-enabled', () => env.surface.godrays.enabled, v => { env.surface.godrays.enabled = v; });
        _bindEnvSlider('env-godrays-intensity',
            () => Math.round(env.surface.godrays.intensity * 100),
            v => { env.surface.godrays.intensity = v / 100; },
            v => v + ' %');

        // Zone compacte
        _bindEnvSlider('env-compact-zone',
            () => env.compact_zone,
            v => { env.compact_zone = v; },
            v => v + ' %');
    }

    // ==========================================================
    // INITIALISATION
    // ==========================================================

    /** Point d'entrée principal du module */
    async function init() {
        if (_initialized) {
            // Déjà initialisé : rafraîchir les données
            await _loadConfig();
            await _loadModels();
            _renderLibrary();
            _renderObjects();
            _initEnvironment();
            return;
        }

        // Premier chargement
        await _loadConfig();
        await _loadModels();
        _renderLibrary();
        _renderObjects();
        _initEnvironment();

        // Binder les boutons d'action principaux
        const btnAdd = document.getElementById('scene3d-btn-add');
        if (btnAdd) btnAdd.addEventListener('click', _addObject);

        const btnSave = document.getElementById('scene3d-btn-save');
        if (btnSave) btnSave.addEventListener('click', () => _saveConfig());

        const btnReset = document.getElementById('scene3d-btn-reset');
        if (btnReset) btnReset.addEventListener('click', _resetConfig);

        // Input file caché pour l'upload
        const uploadInput = document.getElementById('scene3d-upload-input');
        if (uploadInput) {
            uploadInput.addEventListener('change', (e) => {
                if (e.target.files && e.target.files.length > 0) {
                    _uploadModel(e.target.files[0]);
                    e.target.value = '';
                }
            });
        }

        // Drag & Drop sur la zone d'upload
        const dropZone = document.getElementById('scene3d-upload-zone');
        if (dropZone) {
            ['dragenter', 'dragover'].forEach(evt =>
                dropZone.addEventListener(evt, (e) => { e.preventDefault(); dropZone.classList.add('dragover'); })
            );
            ['dragleave', 'drop'].forEach(evt =>
                dropZone.addEventListener(evt, (e) => { e.preventDefault(); dropZone.classList.remove('dragover'); })
            );
            dropZone.addEventListener('drop', (e) => {
                const files = e.dataTransfer?.files;
                if (files && files.length > 0) _uploadModel(files[0]);
            });
            // Clic sur la zone = ouvrir le sélecteur de fichier
            dropZone.addEventListener('click', (e) => {
                if (e.target.tagName !== 'INPUT' && uploadInput) uploadInput.click();
            });
        }

        // Bouton de fermeture de la modale inspecteur
        const closeBtn = document.getElementById('scene3d-inspector-close');
        if (closeBtn) closeBtn.addEventListener('click', _closeInspector);

        _initialized = true;
        console.log('[SceneConfig] Module initialisé');
    }

    return { init };
})();
