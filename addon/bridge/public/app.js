/**
 * RoyaFrame Bridge - Web UI
 * Simple interface for monitoring the bridge and viewing entities
 */

// Get the base path for API calls (handles Ingress path)
function getBasePath() {
    // When served via Ingress, we need to use relative paths
    // The browser URL will be something like /api/hassio_ingress/<token>/
    return '';
}

/**
 * Make API request to the bridge server
 */
async function api(endpoint) {
    const response = await fetch(getBasePath() + endpoint);
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
    const statusClass = isOk ? 'status-ok' : 'status-error';
    el.innerHTML = `<span class="status-indicator ${statusClass}"></span>${text}`;
}

/**
 * Check bridge health
 */
async function checkBridgeHealth() {
    try {
        const data = await api('/health');
        setStatus('bridge-status', true, 'Running');
        return true;
    } catch (error) {
        setStatus('bridge-status', false, 'Error');
        return false;
    }
}

/**
 * Check Home Assistant connection and get info
 */
async function checkHaConnection() {
    try {
        const status = await api('/ha/status');
        if (status.connected) {
            setStatus('ha-status', true, 'Connected');
            // Fetch additional info
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

        if (entities.length === 0) {
            container.innerHTML = '<p>No entities found.</p>';
        } else {
            // Sort by entity_id
            entities.sort((a, b) => a.entity_id.localeCompare(b.entity_id));

            container.innerHTML = entities.map(entity => `
                <div class="entity-item">
                    <span class="entity-id" title="${entity.friendly_name}">${entity.entity_id}</span>
                    <span class="entity-state">${entity.state}</span>
                </div>
            `).join('');
        }
    } catch (error) {
        container.innerHTML = `<div class="error">Failed to load entities: ${error.message}</div>`;
        countEl.textContent = '';
    }

    btn.disabled = false;
    btn.textContent = 'Load Entities';
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
    checkBridgeHealth();
    checkHaConnection();
});
