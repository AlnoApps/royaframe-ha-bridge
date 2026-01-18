/**
 * RoyaFrame Bridge - Web UI
 * Interface for monitoring the bridge, viewing entities, and managing remote pairing
 */

let ws = null;
let entitiesLoaded = false;
const entityStates = new Map();

/**
 * Make API request to the bridge server
 * Uses relative paths (./) to work correctly via Ingress proxy
 */
async function api(endpoint, options = {}) {
    // Remove leading slash and use relative path for Ingress compatibility
    const path = endpoint.startsWith('/') ? endpoint.slice(1) : endpoint;
    const response = await fetch(`./${path}`, options);
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }
    return response.json();
}

/**
 * Update status indicator
 */
function setStatus(elementId, isOk, text) {
    const el = document.getElementById(elementId);
    if (!el) return;
    const statusClass = isOk ? 'status-ok' : 'status-error';
    el.innerHTML = `<span class="status-indicator ${statusClass}"></span>${text}`;
}

/**
 * Check bridge health and update all status indicators
 */
async function checkBridgeHealth() {
    try {
        const data = await api('/health');
        setStatus('bridge-status', true, 'Running');

        // Update WS client count
        const wsClientsEl = document.getElementById('ws-clients');
        if (wsClientsEl) {
            wsClientsEl.textContent = data.ws_clients || 0;
        }

        // Update HA WebSocket status
        setStatus('ha-ws-status', data.ha_connected, data.ha_connected ? 'Connected' : 'Disconnected');

        // Update relay status
        updateRelayUI(data.relay);

        return data;
    } catch (error) {
        setStatus('bridge-status', false, 'Error');
        return null;
    }
}

/**
 * Map relay ui_state to display text and status class
 * UI states: ready | connecting | authenticating | registering | error | config_error | stopped | idle | disconnected
 */
function getRelayStatusDisplay(uiState) {
    const statusMap = {
        'ready': { text: 'Connected', ok: true, class: 'status-ok', showCode: true },
        'idle': { text: 'Idle (no viewers)', ok: true, class: 'status-ok', showCode: true },
        'connecting': { text: 'Connecting...', ok: false, class: 'status-loading', showCode: false },
        'authenticating': { text: 'Authenticating...', ok: false, class: 'status-loading', showCode: false },
        'registering': { text: 'Registering...', ok: false, class: 'status-loading', showCode: false },
        'error': { text: 'Error', ok: false, class: 'status-error', showCode: false },
        'config_error': { text: 'Config Error', ok: false, class: 'status-error', showCode: false },
        'stopped': { text: 'Stopped', ok: false, class: 'status-error', showCode: false },
        'disconnected': { text: 'Disconnected', ok: false, class: 'status-error', showCode: false },
        'unauthorized': { text: 'Unauthorized', ok: false, class: 'status-error', showCode: false }
    };
    return statusMap[uiState] || { text: uiState || 'Unknown', ok: false, class: 'status-error', showCode: false };
}

/**
 * Update relay UI based on status
 */
function updateRelayUI(relayStatus) {
    const notConfigured = document.getElementById('relay-not-configured');
    const configured = document.getElementById('relay-configured');
    const pairBtn = document.getElementById('pair-btn');
    const stopBtn = document.getElementById('stop-relay-btn');
    const pairCodeDisplay = document.getElementById('pair-code-display');
    const pairCodeEl = document.getElementById('pair-code');
    const relayInfoEl = document.getElementById('relay-info');
    const relayErrorEl = document.getElementById('relay-error');

    // Update relay info display
    if (relayInfoEl) {
        const urlDisplay = relayStatus?.relay_origin || 'Not set';
        const agentIdDisplay = relayStatus?.agent_id || '-';
        const uiStateDisplay = relayStatus?.ui_state || 'unknown';
        const appCountDisplay = relayStatus?.app_count ?? '-';
        relayInfoEl.innerHTML = `
            <div class="relay-info-item"><strong>Relay Origin:</strong> <code>${escapeHtml(urlDisplay)}</code></div>
            <div class="relay-info-item"><strong>Agent ID:</strong> <code>${escapeHtml(agentIdDisplay)}</code></div>
            <div class="relay-info-item"><strong>State:</strong> ${escapeHtml(String(uiStateDisplay))}</div>
            <div class="relay-info-item"><strong>Viewers:</strong> ${escapeHtml(String(appCountDisplay))}</div>
        `;
    }

    // Show config errors or last error
    if (relayErrorEl) {
        const hasConfigErrors = relayStatus?.config_errors?.length > 0;
        const hasLastError = relayStatus?.last_error;

        if (hasConfigErrors) {
            relayErrorEl.innerHTML = `<strong>Config Error:</strong> ${escapeHtml(relayStatus.config_errors.join('; '))}`;
            relayErrorEl.style.display = 'block';
        } else if (hasLastError && !relayStatus?.registered) {
            relayErrorEl.innerHTML = `<strong>Last Error:</strong> ${escapeHtml(relayStatus.last_error)}`;
            relayErrorEl.style.display = 'block';
        } else {
            relayErrorEl.style.display = 'none';
        }
    }

    if (!relayStatus || !relayStatus.configured) {
        if (notConfigured) notConfigured.style.display = 'block';
        if (configured) configured.style.display = 'none';
        return;
    }

    if (notConfigured) notConfigured.style.display = 'none';
    if (configured) configured.style.display = 'block';

    // Get display info from ui_state (not raw status)
    const statusDisplay = getRelayStatusDisplay(relayStatus.ui_state);

    if (relayStatus.enabled) {
        setStatus('relay-status', statusDisplay.ok, statusDisplay.text);

        // CRITICAL: Only show pair code when registered (ui_state === 'ready' or 'idle')
        // The backend only sends pair_code when registered=true
        if (relayStatus.pair_code && statusDisplay.showCode) {
            // Registered and ready - show the valid pair code
            pairCodeEl.textContent = relayStatus.pair_code;
            pairCodeDisplay.style.display = 'block';
            pairCodeDisplay.classList.remove('pair-code-invalid');
        } else {
            // Not yet registered - show placeholder with status message
            pairCodeEl.textContent = '------';
            pairCodeDisplay.style.display = 'block';
            pairCodeDisplay.classList.add('pair-code-invalid');
        }

        pairBtn.style.display = 'inline-block';
        stopBtn.style.display = 'inline-block';
    } else {
        setStatus('relay-status', false, 'Stopped');
        pairCodeDisplay.style.display = 'none';  // Hide pair code when stopped
        pairBtn.style.display = 'inline-block';
        stopBtn.style.display = 'none';
    }
}

/**
 * Escape HTML to prevent XSS
 */
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * Check Home Assistant connection and get info
 */
async function checkHaConnection() {
    try {
        const status = await api('/ha/status');
        if (status.connected) {
            setStatus('ha-status', true, 'Connected');
            const info = await api('/ha/info');
            document.getElementById('ha-version').textContent = info.version || '-';
            document.getElementById('ha-info-row').style.display = 'flex';
        } else {
            setStatus('ha-status', false, 'Disconnected');
        }
    } catch (error) {
        setStatus('ha-status', false, 'Error');
    }
}

/**
 * Start pairing mode
 */
async function startPairing() {
    const btn = document.getElementById('pair-btn');
    btn.disabled = true;
    btn.textContent = 'Regenerating...';

    try {
        const result = await api('/relay/pair', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });
        updateRelayUI(result.status);
    } catch (error) {
        alert('Failed to regenerate pair code: ' + error.message);
    }

    btn.disabled = false;
    btn.textContent = 'Regenerate Pair Code';
}

/**
 * Stop relay connection
 */
async function stopRelay() {
    try {
        const result = await api('/relay/stop', { method: 'POST' });
        updateRelayUI(result.status);
    } catch (error) {
        alert('Failed to stop relay: ' + error.message);
    }
}

/**
 * Connect to local WebSocket for live updates
 */
function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    // Build WebSocket URL relative to current page path (for Ingress compatibility)
    const basePath = window.location.pathname.replace(/\/$/, ''); // Remove trailing slash
    const wsUrl = `${protocol}//${window.location.host}${basePath}/ws`;

    try {
        ws = new WebSocket(wsUrl);
    } catch (err) {
        console.log('WebSocket not available');
        return;
    }

    ws.onopen = () => {
        console.log('WebSocket connected');
        const indicator = document.getElementById('live-indicator');
        if (indicator) indicator.style.display = 'inline';
    };

    ws.onmessage = (event) => {
        try {
            const msg = JSON.parse(event.data);
            handleWsMessage(msg);
        } catch (err) {
            console.error('Invalid WS message', err);
        }
    };

    ws.onclose = () => {
        console.log('WebSocket disconnected');
        const indicator = document.getElementById('live-indicator');
        if (indicator) indicator.style.display = 'none';
        // Reconnect after delay
        setTimeout(connectWebSocket, 5000);
    };

    ws.onerror = (err) => {
        console.error('WebSocket error', err);
    };
}

/**
 * Handle incoming WebSocket message
 */
function handleWsMessage(msg) {
    switch (msg.type) {
        case 'connection_status':
            setStatus('ha-ws-status', msg.connected, msg.connected ? 'Connected' : 'Disconnected');
            break;

        case 'state_changed':
            if (entitiesLoaded && msg.data) {
                updateEntityInList(msg.data.entity_id, msg.data.new_state);
            }
            break;
    }
}

/**
 * Update a single entity in the displayed list
 */
function updateEntityInList(entityId, newState) {
    if (!newState) return;

    entityStates.set(entityId, newState);

    const container = document.getElementById('entities-container');
    const items = container.querySelectorAll('.entity-item');

    for (const item of items) {
        const idSpan = item.querySelector('.entity-id');
        if (idSpan && idSpan.textContent === entityId) {
            const stateSpan = item.querySelector('.entity-state');
            if (stateSpan) {
                stateSpan.textContent = newState.state;
                // Flash effect
                item.style.background = '#e3f2fd';
                setTimeout(() => item.style.background = '#fafafa', 500);
            }
            break;
        }
    }
}

/**
 * Load and display entities
 */
async function loadEntities() {
    const btn = document.getElementById('load-entities-btn');
    const container = document.getElementById('entities-container');
    const countEl = document.getElementById('entity-count');

    btn.disabled = true;
    btn.textContent = 'Loading...';
    container.innerHTML = '';

    try {
        const data = await api('/ha/entities');
        const entities = data.entities || [];

        countEl.textContent = `${entities.length} entities found`;
        entitiesLoaded = true;

        // Store states for live updates
        entities.forEach(e => entityStates.set(e.entity_id, { state: e.state }));

        if (entities.length === 0) {
            container.innerHTML = '<p>No entities found.</p>';
        } else {
            entities.sort((a, b) => a.entity_id.localeCompare(b.entity_id));

            container.innerHTML = entities.map(entity => `
                <div class="entity-item" data-entity-id="${entity.entity_id}">
                    <span class="entity-id" title="${entity.friendly_name}">${entity.entity_id}</span>
                    <span class="entity-state">${entity.state}</span>
                </div>
            `).join('');
        }
    } catch (error) {
        container.innerHTML = `<div class="error">Failed to load entities: ${error.message}</div>`;
        countEl.textContent = '';
        entitiesLoaded = false;
    }

    btn.disabled = false;
    btn.textContent = 'Load Entities';
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
    checkBridgeHealth();
    checkHaConnection();
    connectWebSocket();

    // Refresh status periodically
    setInterval(checkBridgeHealth, 30000);
});
