/**
 * BOB-ROV — Gestionnaire Wi-Fi (scan, connexion, statut)
 * Module autonome pour la carte Wi-Fi Dashboard et la modale de connexion.
 */
'use strict';

const WifiManager = (() => {
    let _selectedNetwork = null;
    let _pollingInterval = null;

    // ==========================================================
    // INITIALISATION
    // ==========================================================
    function init() {
        _bindEvents();
        refreshStatus();
        // Rafraîchir le statut Wi-Fi toutes les 10s sur le Dashboard
        if (_pollingInterval) clearInterval(_pollingInterval);
        _pollingInterval = setInterval(refreshStatus, 10000);
    }

    function _bindEvents() {
        const closeBtn = document.getElementById('wifi-modal-close');
        if (closeBtn) closeBtn.addEventListener('click', closeModal);

        const modal = document.getElementById('wifi-modal');
        if (modal) modal.addEventListener('click', (e) => {
            if (e.target === modal) closeModal();
        });

        const refreshBtn = document.getElementById('btn-wifi-refresh');
        if (refreshBtn) refreshBtn.addEventListener('click', scanNetworks);

        const connectBtn = document.getElementById('btn-wifi-connect');
        if (connectBtn) connectBtn.addEventListener('click', connectToNetwork);

        const cancelBtn = document.getElementById('btn-wifi-cancel');
        if (cancelBtn) cancelBtn.addEventListener('click', _hideConnectPanel);

        const togglePw = document.getElementById('wifi-toggle-pw');
        if (togglePw) togglePw.addEventListener('click', () => {
            const pwInput = document.getElementById('wifi-password');
            if (pwInput) pwInput.type = pwInput.type === 'password' ? 'text' : 'password';
        });

        // Touche Entrée dans le champ mot de passe
        const pwInput = document.getElementById('wifi-password');
        if (pwInput) pwInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') connectToNetwork();
        });
    }

    // ==========================================================
    // STATUT WI-FI (carte Dashboard)
    // ==========================================================
    async function refreshStatus() {
        try {
            const r = await fetch('/api/wifi/status');
            const data = await r.json();
            _updateDashboardCard(data);
        } catch (e) {
            _setText('wifi-ssid', 'Erreur');
            _setText('wifi-ip', '--');
            _setText('wifi-signal', '--');
        }
    }

    function _updateDashboardCard(data) {
        const ssidEl = document.getElementById('wifi-ssid');
        const ipEl = document.getElementById('wifi-ip');
        const signalEl = document.getElementById('wifi-signal');

        if (ssidEl) {
            if (data.connected && data.ssid) {
                ssidEl.textContent = data.ssid;
                ssidEl.style.color = 'var(--accent)';
            } else {
                ssidEl.textContent = 'Déconnecté';
                ssidEl.style.color = 'var(--accent-red)';
            }
        }
        if (ipEl) {
            ipEl.textContent = data.ip || '--';
        }
        if (signalEl) {
            if (data.signal !== undefined && data.signal !== null) {
                signalEl.textContent = data.signal + '%';
            } else {
                signalEl.textContent = '--';
            }
        }
    }

    // ==========================================================
    // MODALE — OUVERTURE / FERMETURE
    // ==========================================================
    function openModal() {
        const modal = document.getElementById('wifi-modal');
        if (modal) modal.style.display = 'flex';
        _hideConnectPanel();
        scanNetworks();
    }

    function closeModal() {
        const modal = document.getElementById('wifi-modal');
        if (modal) modal.style.display = 'none';
        _selectedNetwork = null;
    }

    // ==========================================================
    // SCAN DES RÉSEAUX
    // ==========================================================
    async function scanNetworks() {
        const statusEl = document.getElementById('wifi-scan-status');
        const listEl = document.getElementById('wifi-network-list');
        const refreshBtn = document.getElementById('btn-wifi-refresh');

        if (statusEl) statusEl.textContent = 'Scan en cours…';
        if (refreshBtn) refreshBtn.disabled = true;
        if (listEl) listEl.innerHTML = '<div class="wifi-empty">⏳ Scan Wi-Fi en cours…</div>';

        try {
            const r = await fetch('/api/wifi/scan');
            const data = await r.json();

            if (!data.networks || data.networks.length === 0) {
                if (listEl) listEl.innerHTML = '<div class="wifi-empty">Aucun réseau Wi-Fi détecté</div>';
                if (statusEl) statusEl.textContent = 'Aucun réseau trouvé';
                return;
            }

            if (statusEl) statusEl.textContent = data.networks.length + ' réseau(x) trouvé(s)';
            _renderNetworkList(data.networks);
        } catch (e) {
            if (listEl) listEl.innerHTML = '<div class="wifi-empty">❌ Erreur lors du scan</div>';
            if (statusEl) statusEl.textContent = 'Erreur';
        } finally {
            if (refreshBtn) refreshBtn.disabled = false;
        }
    }

    function _renderNetworkList(networks) {
        const listEl = document.getElementById('wifi-network-list');
        if (!listEl) return;

        listEl.innerHTML = networks.map(net => {
            const signalIcon = _signalIcon(net.signal);
            const isConnected = !!net.active;
            const securedClass = net.secured ? 'secured' : '';
            const connectedHtml = isConnected ? '<span class="wifi-connected-badge">Connecté</span>' : '';
            const securityLabel = net.secured ? '🔒 ' + (net.security || 'WPA') : 'Ouvert';

            return `<div class="wifi-network-item${isConnected ? ' connected' : ''}" data-ssid="${_escapeHtml(net.ssid)}" data-secured="${net.secured ? '1' : '0'}">
                <span class="wifi-signal-icon">${signalIcon}</span>
                <div class="wifi-network-info">
                    <div class="wifi-network-name">${_escapeHtml(net.ssid)}</div>
                    <div class="wifi-network-meta">
                        <span>${net.signal}%</span>
                        <span class="wifi-security-badge ${securedClass}">${securityLabel}</span>
                        ${connectedHtml}
                    </div>
                </div>
            </div>`;
        }).join('');

        // Attacher les clics sur chaque réseau
        listEl.querySelectorAll('.wifi-network-item').forEach(item => {
            item.addEventListener('click', () => _selectNetwork(item));
        });
    }

    function _signalIcon(signal) {
        if (signal >= 80) return '📶';
        if (signal >= 60) return '📶';
        if (signal >= 40) return '📶';
        if (signal >= 20) return '📶';
        return '📶';
    }

    // ==========================================================
    // SÉLECTION D'UN RÉSEAU
    // ==========================================================
    function _selectNetwork(item) {
        const ssid = item.dataset.ssid;
        const secured = item.dataset.secured === '1';

        // Désélectionner les autres
        document.querySelectorAll('.wifi-network-item').forEach(el => el.classList.remove('selected'));
        item.classList.add('selected');

        _selectedNetwork = { ssid, secured };

        const panel = document.getElementById('wifi-connect-panel');
        const ssidLabel = document.getElementById('wifi-connect-ssid');
        const pwInput = document.getElementById('wifi-password');
        const pwRow = document.querySelector('.wifi-password-row');

        if (ssidLabel) ssidLabel.textContent = 'Connexion à : ' + ssid;
        if (pwInput) pwInput.value = '';
        if (pwRow) pwRow.style.display = secured ? 'flex' : 'none';
        if (panel) panel.style.display = 'block';

        // Focus sur le mot de passe si sécurisé
        if (secured && pwInput) setTimeout(() => pwInput.focus(), 100);
    }

    function _hideConnectPanel() {
        const panel = document.getElementById('wifi-connect-panel');
        if (panel) panel.style.display = 'none';
        _selectedNetwork = null;
        document.querySelectorAll('.wifi-network-item').forEach(el => el.classList.remove('selected'));
    }

    // ==========================================================
    // CONNEXION À UN RÉSEAU
    // ==========================================================
    async function connectToNetwork() {
        if (!_selectedNetwork) return;

        const connectBtn = document.getElementById('btn-wifi-connect');
        const logEl = document.getElementById('wifi-connect-log');
        const pwInput = document.getElementById('wifi-password');

        const password = pwInput ? pwInput.value : '';

        // Si réseau sécurisé et pas de mot de passe
        if (_selectedNetwork.secured && !password) {
            _showLog(logEl, 'Veuillez entrer le mot de passe.', 'error');
            if (pwInput) pwInput.focus();
            return;
        }

        // Désactiver le bouton pendant la connexion
        if (connectBtn) { connectBtn.disabled = true; connectBtn.textContent = '⏳ Connexion…'; }
        _showLog(logEl, 'Connexion en cours…', 'info');

        try {
            const r = await fetch('/api/wifi/connect', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    ssid: _selectedNetwork.ssid,
                    password: password
                })
            });
            const data = await r.json();

            if (data.status === 'ok') {
                _showLog(logEl, '✅ Connecté à ' + _selectedNetwork.ssid + ' !', 'success');
                if (typeof App !== 'undefined') App.showNotification('📶 Connecté à ' + _selectedNetwork.ssid);
                // Rafraîchir le statut et la liste après 2s
                setTimeout(() => {
                    refreshStatus();
                    scanNetworks();
                    _hideConnectPanel();
                }, 2000);
            } else {
                _showLog(logEl, '❌ Échec: ' + (data.message || 'Erreur inconnue'), 'error');
            }
        } catch (e) {
            _showLog(logEl, '❌ Erreur réseau: ' + e.message, 'error');
        } finally {
            if (connectBtn) { connectBtn.disabled = false; connectBtn.textContent = 'Se connecter'; }
        }
    }

    function _showLog(el, message, type) {
        if (!el) return;
        el.classList.add('visible');
        const cls = type === 'error' ? 'log-error' : (type === 'success' ? 'log-success' : 'log-info');
        el.innerHTML = '<span class="' + cls + '">' + message + '</span>';
    }

    // ==========================================================
    // UTILITAIRES
    // ==========================================================
    function _setText(id, text) {
        const el = document.getElementById(id);
        if (el) el.textContent = text;
    }

    function _escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    // ==========================================================
    // API PUBLIQUE
    // ==========================================================
    return {
        init,
        openModal,
        closeModal,
        refreshStatus,
        scanNetworks
    };
})();

// Initialiser au chargement
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => WifiManager.init());
} else {
    WifiManager.init();
}
