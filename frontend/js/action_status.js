/**
 * BOB-ROV — Module État des Fonctions / Actions
 * Affiche les indicateurs de statut des actions (implémentées, en cours, planifiées)
 */
'use strict';

const ActionStatus = (() => {
    let actions = {};
    let summary = {};
    let loaded = false;

    /**
     * Charge le statut des actions depuis l'API
     */
    async function load() {
        try {
            const resp = await fetch('/api/actions/status');
            if (!resp.ok) return;
            const data = await resp.json();
            if (data.status === 'ok') {
                actions = data.actions || {};
                summary = data.summary || {};
                loaded = true;
                updateIndicators();
            }
        } catch(e) {
            console.warn('[ActionStatus] Impossible de charger le statut des actions');
        }
    }

    /**
     * Retourne l'emoji de statut pour une action
     */
    function getStatusIcon(actionName) {
        const action = actions[actionName];
        if (!action) return '❓';
        switch(action.status) {
            case 'implemented': return '✅';
            case 'in_progress': return '🛠️';
            case 'planned': return '⏳';
            default: return '❓';
        }
    }

    /**
     * Retourne le statut d'une action
     */
    function getStatus(actionName) {
        const action = actions[actionName];
        return action ? action.status : 'unknown';
    }

    /**
     * Met à jour les indicateurs visuels dans l'interface
     */
    function updateIndicators() {
        // Badge dans le cockpit
        const badge = document.getElementById('rov-status-badge');
        if (badge) {
            const impl = summary.implemented || 0;
            const prog = summary.in_progress || 0;
            const plan = summary.planned || 0;
            badge.innerHTML = `✅ ${impl} <span class="sep">|</span> 🛠️ ${prog} <span class="sep">|</span> ⏳ ${plan}`;
            badge.title = `${impl} implémentées, ${prog} en cours, ${plan} planifiées`;
        }

        // Mettre à jour les indicateurs dans la page de mapping gamepad si visible
        document.querySelectorAll('[data-action-status]').forEach(el => {
            const actionName = el.dataset.actionStatus;
            el.textContent = getStatusIcon(actionName);
        });
    }

    /**
     * Génère le HTML pour la section "État des fonctions" dans le dashboard
     */
    function renderStatusPanel(containerId) {
        const container = document.getElementById(containerId);
        if (!container || !loaded) return;

        // Grouper par catégorie
        const categories = {};
        Object.entries(actions).forEach(([name, info]) => {
            const cat = info.category || 'autre';
            if (!categories[cat]) categories[cat] = [];
            categories[cat].push({ name, ...info });
        });

        let html = '<div class="action-status-grid">';

        // Résumé en haut
        html += `<div class="action-summary">
            <span class="summary-item implemented">✅ ${summary.implemented || 0} opérationnelles</span>
            <span class="summary-item in-progress">🛠️ ${summary.in_progress || 0} en cours</span>
            <span class="summary-item planned">⏳ ${summary.planned || 0} planifiées</span>
        </div>`;

        // Liste par catégorie
        const catLabels = {
            'capture': '📷 Capture',
            'eclairage': '💡 Éclairage',
            'mouvement': '🚀 Mouvements',
            'controle': '🎛️ Contrôle',
            'stabilisation': '⚖️ Stabilisation',
            'pince': '🦾 Pince',
            'macro': '🔄 Macros',
            'capteurs': '📡 Capteurs',
        };

        Object.entries(categories).forEach(([cat, items]) => {
            const label = catLabels[cat] || cat;
            html += `<div class="action-category">
                <h4>${label}</h4>
                <div class="action-list">`;

            items.forEach(item => {
                const icon = item.status === 'implemented' ? '✅' :
                             item.status === 'in_progress' ? '🛠️' : '⏳';
                const cls = `action-item status-${item.status}`;
                html += `<div class="${cls}">
                    <span class="action-icon">${icon}</span>
                    <span class="action-name">${item.name}</span>
                    <span class="action-desc">${item.description}</span>
                </div>`;
            });

            html += '</div></div>';
        });

        html += '</div>';
        container.innerHTML = html;
    }

    return { load, getStatusIcon, getStatus, updateIndicators, renderStatusPanel, getActions: () => actions, getSummary: () => summary };
})();
