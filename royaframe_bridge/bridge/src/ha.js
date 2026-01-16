/**
 * Home Assistant API client
 * Communicates with HA via the Supervisor proxy
 */

// Supervisor provides the token via environment variable
const SUPERVISOR_TOKEN = process.env.SUPERVISOR_TOKEN;
const HA_API_BASE = 'http://supervisor/core/api';

/**
 * Make an authenticated request to the Home Assistant API
 * @param {string} endpoint - API endpoint (e.g., '/config')
 * @returns {Promise<object>} - JSON response
 */
async function haRequest(endpoint) {
    const url = `${HA_API_BASE}${endpoint}`;

    const response = await fetch(url, {
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${SUPERVISOR_TOKEN}`,
            'Content-Type': 'application/json'
        }
    });

    if (!response.ok) {
        throw new Error(`HA API error: ${response.status} ${response.statusText}`);
    }

    return response.json();
}

/**
 * Get Home Assistant configuration/info
 */
async function getConfig() {
    return haRequest('/config');
}

/**
 * Get all entity states from Home Assistant
 */
async function getStates() {
    return haRequest('/states');
}

/**
 * Check if we can connect to Home Assistant
 */
async function checkConnection() {
    try {
        await getConfig();
        return { connected: true };
    } catch (error) {
        return { connected: false, error: error.message };
    }
}

module.exports = {
    getConfig,
    getStates,
    checkConnection
};
