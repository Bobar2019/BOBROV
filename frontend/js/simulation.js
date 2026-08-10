/**
 * BOB-ROV — Module Simulation : Éditeur de scénario en liste
 * Constructeur d'instructions, exécution, barre de progression
 */
'use strict';

const Simulation = (() => {
    let statusInterval = null;
    let instructions = []; // Liste des instructions en mémoire

    // Actions disponibles avec leurs labels et unités
    const ACTIONS = [
        { value: 'depth',   label: 'Aller à (profondeur)', unit: 'm',   defaultVal: -10, defaultDur: 30 },
        { value: 'heading', label: 'Pivoter à (cap)',      unit: '°',   defaultVal: 180, defaultDur: 5 },
        { value: 'roll',    label: 'Incliner à (roulis)',  unit: '°',   defaultVal: 45,  defaultDur: 8 },
        { value: 'pitch',   label: 'Tangage à',            unit: '°',   defaultVal: 0,   defaultDur: 5 },
        { value: 'wait',    label: 'Attendre',             unit: 's',   defaultVal: 10,  defaultDur: 10 },
        { value: 'loop',    label: 'Répéter (boucle)',     unit: '',    defaultVal: 0,   defaultDur: 0 }
    ];

    // ==========================================================
    // INITIALISATION
    // ==========================================================
    function init() {
        // Boutons de la barre d'outils
        _bindClick('btn-sim-refresh-list', refreshList);
        _bindClick('btn-sim-load', loadSelected);
        _bindClick('btn-sim-start', execute);
        _bindClick('btn-sim-pause', pause);
        _bindClick('btn-sim-stop', stop);
        _bindClick('btn-sim-reset', reset);
        _bindClick('btn-sim-save', saveScenario);
        _bindClick('btn-sim-add-line', () => addInstruction());

        // Sliders temps réel (override)
        ['heading', 'depth', 'roll', 'pitch', 'temp'].forEach(param => {
            const slider = document.getElementById(`sim-rt-${param}`);
            const valSpan = document.getElementById(`sim-${param}-val`);
            if (slider && valSpan) {
                slider.addEventListener('input', () => {
                    const unit = param === 'depth' ? 'm' : param === 'temp' ? '°C' : '°';
                    valSpan.textContent = `${slider.value}${unit}`;
                });
                slider.addEventListener('change', () => {
                    const action = param === 'temp' ? 'temperature' : param;
                    sendRealtimeValue(action, parseFloat(slider.value));
                });
            }
        });

        // Ajouter une première instruction par défaut
        if (instructions.length === 0) {
            addInstruction('depth', -12, 30);
        }

        refreshList();
        startStatusPolling();
    }

    // ==========================================================
    // CONSTRUCTEUR D'INSTRUCTIONS
    // ==========================================================

    /**
     * Ajoute une ligne d'instruction dans l'éditeur
     */
    function addInstruction(action = 'depth', valeur = null, duree = null) {
        const actionDef = ACTIONS.find(a => a.value === action) || ACTIONS[0];
        const instr = {
            id: Date.now() + Math.random(),
            action: action,
            valeur: valeur !== null ? valeur : actionDef.defaultVal,
            duree: duree !== null ? duree : actionDef.defaultDur
        };
        instructions.push(instr);
        renderInstructions();
    }

    /**
     * Supprime une instruction par son index
     */
    function removeInstruction(index) {
        instructions.splice(index, 1);
        renderInstructions();
    }

    /**
     * Met à jour une instruction depuis les champs DOM
     */
    function updateInstruction(index, field, value) {
        if (instructions[index]) {
            instructions[index][field] = field === 'action' ? value : parseFloat(value) || 0;
        }
    }

    /**
     * Affiche toutes les instructions dans le DOM
     */
    function renderInstructions() {
        const container = document.getElementById('sim-instructions-list');
        if (!container) return;
        container.innerHTML = '';

        instructions.forEach((instr, index) => {
            const row = document.createElement('div');
            row.className = 'sim-instr-row';
            row.dataset.index = index;

            // Poignée de drag
            const drag = document.createElement('span');
            drag.className = 'drag-handle';
            drag.textContent = '⋮⋮';
            drag.title = 'Glisser pour réorganiser';
            row.appendChild(drag);

            // Sélecteur d'action
            const select = document.createElement('select');
            ACTIONS.forEach(a => {
                const opt = document.createElement('option');
                opt.value = a.value;
                opt.textContent = a.label;
                if (a.value === instr.action) opt.selected = true;
                select.appendChild(opt);
            });
            select.addEventListener('change', () => {
                updateInstruction(index, 'action', select.value);
                // Mettre à jour l'unité affichée
                const newDef = ACTIONS.find(a => a.value === select.value);
                if (newDef) {
                    valLabel.textContent = newDef.unit || '';
                    if (select.value === 'loop') {
                        valInput.style.display = 'none';
                        durInput.style.display = 'none';
                        durLabel.style.display = 'none';
                    } else {
                        valInput.style.display = '';
                        durInput.style.display = '';
                        durLabel.style.display = '';
                    }
                }
            });
            row.appendChild(select);

            // Label "Valeur"
            const actionDef = ACTIONS.find(a => a.value === instr.action) || ACTIONS[0];

            // Champ valeur
            const valInput = document.createElement('input');
            valInput.type = 'number';
            valInput.value = instr.valeur;
            valInput.step = actionDef.unit === 'm' ? '0.1' : '1';
            valInput.style.display = instr.action === 'loop' ? 'none' : '';
            valInput.addEventListener('change', () => updateInstruction(index, 'valeur', valInput.value));
            row.appendChild(valInput);

            // Unité
            const valLabel = document.createElement('span');
            valLabel.className = 'instr-label';
            valLabel.textContent = actionDef.unit || '';
            row.appendChild(valLabel);

            // Champ durée
            const durLabel2 = document.createElement('span');
            durLabel2.className = 'instr-label';
            durLabel2.textContent = 'Durée';
            durLabel2.style.display = instr.action === 'loop' ? 'none' : '';
            row.appendChild(durLabel2);

            const durInput = document.createElement('input');
            durInput.type = 'number';
            durInput.value = instr.duree;
            durInput.min = '1';
            durInput.max = '9999';
            durInput.style.display = instr.action === 'loop' ? 'none' : '';
            durInput.addEventListener('change', () => updateInstruction(index, 'duree', durInput.value));
            row.appendChild(durInput);

            const secLabel = document.createElement('span');
            secLabel.className = 'instr-label';
            secLabel.textContent = 'sec';
            secLabel.style.display = instr.action === 'loop' ? 'none' : '';
            row.appendChild(secLabel);

            // Bouton supprimer
            const btnDel = document.createElement('button');
            btnDel.className = 'btn-remove';
            btnDel.textContent = '×';
            btnDel.title = 'Supprimer cette ligne';
            btnDel.addEventListener('click', () => removeInstruction(index));
            row.appendChild(btnDel);

            // Drag & drop basique
            row.draggable = true;
            row.addEventListener('dragstart', (e) => {
                e.dataTransfer.setData('text/plain', index);
                row.style.opacity = '0.4';
            });
            row.addEventListener('dragend', () => { row.style.opacity = '1'; });
            row.addEventListener('dragover', (e) => { e.preventDefault(); row.style.borderTop = '2px solid var(--accent)'; });
            row.addEventListener('dragleave', () => { row.style.borderTop = ''; });
            row.addEventListener('drop', (e) => {
                e.preventDefault();
                row.style.borderTop = '';
                const fromIdx = parseInt(e.dataTransfer.getData('text/plain'));
                const toIdx = index;
                if (fromIdx !== toIdx) {
                    const item = instructions.splice(fromIdx, 1)[0];
                    instructions.splice(toIdx, 0, item);
                    renderInstructions();
                }
            });

            container.appendChild(row);
        });
    }

    // ==========================================================
    // GESTION DES SCÉNARIOS (API)
    // ==========================================================
    function refreshList() {
        fetch('/api/scenarios')
            .then(r => r.json())
            .then(data => {
                const select = document.getElementById('sim-scenario-select');
                if (!select) return;
                select.innerHTML = '';
                if (data.scenarios && data.scenarios.length > 0) {
                    data.scenarios.forEach(sc => {
                        const opt = document.createElement('option');
                        opt.value = sc.file;
                        opt.textContent = `${sc.name} (${sc.steps_count} étapes)`;
                        select.appendChild(opt);
                    });
                } else {
                    select.innerHTML = '<option>Aucun scénario</option>';
                }
            })
            .catch(err => console.error('[Sim] Erreur liste:', err));
    }

    function loadSelected() {
        const select = document.getElementById('sim-scenario-select');
        if (!select || !select.value) return;

        fetch('/api/scenario/load', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename: select.value })
        })
        .then(r => r.json())
        .then(data => {
            if (data.scenario) {
                const sc = data.scenario;
                // Mettre à jour le nom
                const nameInput = document.getElementById('sim-scenario-name');
                if (nameInput) nameInput.value = sc.nom || 'Sans nom';
                // Boucle
                const loopCheck = document.getElementById('sim-scenario-loop');
                if (loopCheck) loopCheck.checked = !!sc.boucle;
                // Charger les instructions
                instructions = [];
                if (sc.instructions && sc.instructions.length > 0) {
                    sc.instructions.forEach(instr => {
                        instructions.push({
                            id: Date.now() + Math.random(),
                            action: instr.action || 'depth',
                            valeur: instr.valeur !== undefined ? instr.valeur : 0,
                            duree: instr.duree !== undefined ? instr.duree : 5
                        });
                    });
                }
                renderInstructions();
                App.showNotification(`Scénario "${sc.nom}" chargé`);
            }
        })
        .catch(err => console.error('[Sim] Erreur chargement:', err));
    }

    function saveScenario() {
        const nameInput = document.getElementById('sim-scenario-name');
        const filenameInput = document.getElementById('sim-save-filename');
        const loopCheck = document.getElementById('sim-scenario-loop');

        let filename = (filenameInput?.value || '').trim();
        if (!filename) filename = (nameInput?.value || 'scenario').replace(/\s+/g, '_').toLowerCase();
        if (!filename.endsWith('.json')) filename += '.json';

        const scenario = {
            nom: nameInput?.value || 'Sans nom',
            description: '',
            boucle: loopCheck?.checked || false,
            instructions: instructions.map(i => ({
                action: i.action,
                valeur: i.valeur,
                duree: i.duree
            }))
        };

        fetch('/api/scenario/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename, scenario })
        })
        .then(r => r.json())
        .then(data => {
            App.showNotification(`Scénario "${filename}" sauvegardé`);
            refreshList();
        })
        .catch(err => console.error('[Sim] Erreur sauvegarde:', err));
    }

    // ==========================================================
    // EXÉCUTION DU SCÉNARIO
    // ==========================================================
    function execute() {
        const nameInput = document.getElementById('sim-scenario-name');
        const loopCheck = document.getElementById('sim-scenario-loop');

        const scenario = {
            nom: nameInput?.value || 'Direct',
            description: '',
            boucle: loopCheck?.checked || false,
            instructions: instructions.map(i => ({
                action: i.action,
                valeur: i.valeur,
                duree: i.duree
            }))
        };

        fetch('/api/scenario/execute', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ scenario })
        })
        .then(r => r.json())
        .then(data => {
            console.log('[Sim] Exécution:', data);
            App.showNotification('Simulation démarrée');
        })
        .catch(err => console.error('[Sim] Erreur:', err));
    }

    function pause() {
        fetch('/api/simulation/pause', { method: 'POST' })
            .then(r => r.json())
            .then(data => console.log('[Sim] Pause:', data))
            .catch(err => console.error('[Sim] Erreur:', err));
    }

    function stop() {
        fetch('/api/scenario/stop', { method: 'POST' })
            .then(r => r.json())
            .then(data => {
                console.log('[Sim] Arrêtée:', data);
                App.showNotification('Simulation arrêtée');
            })
            .catch(err => console.error('[Sim] Erreur:', err));
    }

    function reset() {
        fetch('/api/simulation/reset', { method: 'POST' })
            .then(r => r.json())
            .catch(err => console.error('[Sim] Erreur:', err));
    }

    function sendRealtimeValue(action, value) {
        fetch('/api/simulation/value', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action, value })
        }).catch(() => {});
    }

    // ==========================================================
    // POLLING DU STATUT (barre de progression + instruction en cours)
    // ==========================================================
    function startStatusPolling() {
        if (statusInterval) clearInterval(statusInterval);
        statusInterval = setInterval(updateStatus, 1000);
    }

    function updateStatus() {
        if (!document.getElementById('tile-simulation')?.classList.contains('active')) return;

        fetch('/api/scenario/status')
            .then(r => r.json())
            .then(data => {
                const stateEl = document.getElementById('sim-state');
                const elapsedEl = document.getElementById('sim-elapsed');
                const durationEl = document.getElementById('sim-duration');
                const progressBar = document.getElementById('sim-progress-bar');
                const currentInstrEl = document.getElementById('sim-current-instr');

                // État
                if (stateEl) {
                    const stateMap = { stopped: 'Arrêté', running: 'En cours', paused: 'En pause' };
                    stateEl.textContent = stateMap[data.state] || data.state;
                    stateEl.style.color = data.state === 'running' ? 'var(--accent)'
                        : (data.state === 'paused' ? 'var(--accent-yellow)' : 'var(--text-secondary)');
                }

                // Temps
                if (elapsedEl) elapsedEl.textContent = `${(data.elapsed || 0).toFixed(1)}s`;
                if (durationEl) durationEl.textContent = data.total_duration > 0 ? `${data.total_duration.toFixed(0)}s` : '--';

                // Barre de progression
                if (progressBar && data.total_duration > 0) {
                    const pct = Math.min(((data.elapsed || 0) / data.total_duration) * 100, 100);
                    progressBar.style.width = `${pct}%`;
                }

                // Instruction en cours
                if (currentInstrEl) {
                    if (data.state === 'running' && data.current_step !== undefined) {
                        const stepIdx = data.current_step;
                        const totalSteps = data.total_steps || instructions.length;
                        // Trouver l'instruction correspondante
                        const instrLabel = _getInstructionLabel(stepIdx);
                        currentInstrEl.textContent = `${instrLabel} (${stepIdx + 1}/${totalSteps})`;
                        // Surligner la ligne active
                        _highlightActiveRow(stepIdx);
                    } else {
                        currentInstrEl.textContent = '—';
                        _highlightActiveRow(-1);
                    }
                }
            })
            .catch(() => {});
    }

    /**
     * Retourne un label lisible pour l'instruction en cours
     */
    function _getInstructionLabel(stepIndex) {
        if (stepIndex >= 0 && stepIndex < instructions.length) {
            const instr = instructions[stepIndex];
            const def = ACTIONS.find(a => a.value === instr.action);
            const name = def ? def.label.split('(')[0].trim() : instr.action;
            return `${name} → ${instr.valeur}${def?.unit || ''}`;
        }
        return 'En attente...';
    }

    /**
     * Surligne la ligne d'instruction active dans l'éditeur
     */
    function _highlightActiveRow(activeIndex) {
        const rows = document.querySelectorAll('.sim-instr-row');
        rows.forEach((row, i) => {
            row.classList.toggle('active-instr', i === activeIndex);
        });
    }

    // ==========================================================
    // UTILITAIRE
    // ==========================================================
    function _bindClick(id, fn) {
        const el = document.getElementById(id);
        if (el) el.addEventListener('click', fn);
    }

    // ==========================================================
    // INIT
    // ==========================================================
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();

    return { refreshList, execute, stop, pause, reset, addInstruction, renderInstructions };
})();
