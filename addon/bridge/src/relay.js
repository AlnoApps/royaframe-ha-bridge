/**
 * Relay Client
 * Optional outbound WebSocket connection to a cloud relay server.
 * Enables secure remote access without opening inbound ports.
 */

const WebSocket = require('ws');
const EventEmitter = require('events');
const crypto = require('crypto');
const haWS = require('./haWebSocket');
const ha = require('./ha');

// Environment configuration
const RELAY_URL = process.env.RELAY_URL;
const RELAY_TOKEN = process.env.RELAY_TOKEN;
const BRIDGE_VERSION = require('../package.json').version;

class RelayClient extends EventEmitter {
    constructor() {
        super();
        this.ws = null;
        this.pairCode = null;
        this.registered = false;
        this.reconnectDelay = 10000;
        this.reconnectTimer = null;
        this.enabled = false;
        this.haVersion = null;
        this.locationName = null;
    }

    /**
     * Check if relay is configured
     */
    isConfigured() {
        return !!(RELAY_URL && RELAY_TOKEN);
    }

    /**
     * Generate a new pairing code
     */
    generatePairCode() {
        // Generate a 6-character alphanumeric code
        this.pairCode = crypto.randomBytes(3).toString('hex').toUpperCase();
        return this.pairCode;
    }

    /**
     * Get the current pairing code
     */
    getPairCode() {
        return this.pairCode;
    }

    /**
     * Set a specific pairing code (for UI input)
     */
    setPairCode(code) {
        this.pairCode = code;
    }

    /**
     * Start the relay connection
     */
    async start() {
        if (!this.isConfigured()) {
            console.log('[relay] Relay not configured (RELAY_URL/RELAY_TOKEN not set)');
            return false;
        }

        if (!this.pairCode) {
            this.generatePairCode();
        }

        // Fetch HA info for registration
        try {
            const config = await ha.getConfig();
            this.haVersion = config.version;
            this.locationName = config.location_name;
        } catch (err) {
            console.error('[relay] Failed to fetch HA config:', err.message);
        }

        this.enabled = true;
        this.connect();
        return true;
    }

    /**
     * Connect to the relay server
     */
    connect() {
        if (!this.enabled) return;

        if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
            return;
        }

        console.log('[relay] Connecting to relay server...');

        try {
            this.ws = new WebSocket(RELAY_URL, {
                headers: {
                    'Authorization': `Bearer ${RELAY_TOKEN}`
                }
            });
        } catch (err) {
            console.error('[relay] Failed to create WebSocket:', err.message);
            this.scheduleReconnect();
            return;
        }

        this.ws.on('open', () => {
            console.log('[relay] Connected to relay server');
            this.register();
        });

        this.ws.on('message', (data) => {
            this.handleMessage(data);
        });

        this.ws.on('close', (code, reason) => {
            console.log(`[relay] Connection closed: ${code} ${reason}`);
            this.registered = false;
            this.emit('disconnected');
            this.scheduleReconnect();
        });

        this.ws.on('error', (err) => {
            console.error('[relay] Connection error:', err.message);
        });
    }

    /**
     * Register this bridge with the relay
     */
    register() {
        this.send({
            type: 'register_bridge',
            pair_code: this.pairCode,
            bridge_version: BRIDGE_VERSION,
            ha_version: this.haVersion,
            location_name: this.locationName
        });
    }

    /**
     * Handle incoming message from relay
     */
    async handleMessage(data) {
        let msg;
        try {
            msg = JSON.parse(data.toString());
        } catch (err) {
            console.error('[relay] Invalid JSON:', err.message);
            return;
        }

        switch (msg.type) {
            case 'registered':
                console.log('[relay] Bridge registered with relay');
                this.registered = true;
                this.emit('registered');
                break;

            case 'paired':
                console.log('[relay] Bridge paired with remote client');
                this.pairCode = null; // Invalidate pair code after use
                this.emit('paired', msg.client_id);
                break;

            case 'call_service':
                // Forward service call to HA
                try {
                    const result = await haWS.callService(
                        msg.domain,
                        msg.service,
                        msg.data || {},
                        msg.target || {}
                    );
                    this.send({
                        type: 'service_result',
                        request_id: msg.request_id,
                        success: true,
                        result
                    });
                } catch (err) {
                    this.send({
                        type: 'service_result',
                        request_id: msg.request_id,
                        success: false,
                        error: err.message
                    });
                }
                break;

            case 'get_states':
                // Forward state request to HA
                try {
                    const states = await haWS.request({ type: 'get_states' });
                    this.send({
                        type: 'states',
                        request_id: msg.request_id,
                        data: states
                    });
                } catch (err) {
                    this.send({
                        type: 'error',
                        request_id: msg.request_id,
                        error: err.message
                    });
                }
                break;

            case 'ping':
                this.send({ type: 'pong', request_id: msg.request_id });
                break;

            case 'error':
                console.error('[relay] Relay error:', msg.error);
                this.emit('error', new Error(msg.error));
                break;

            default:
                console.log('[relay] Unknown message type:', msg.type);
        }
    }

    /**
     * Send message to relay
     */
    send(msg) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(msg));
        }
    }

    /**
     * Forward a state change event to relay
     */
    forwardStateChange(data) {
        if (this.registered) {
            this.send({
                type: 'state_changed',
                data
            });
        }
    }

    /**
     * Schedule reconnection
     */
    scheduleReconnect() {
        if (this.reconnectTimer || !this.enabled) return;
        console.log(`[relay] Reconnecting in ${this.reconnectDelay / 1000}s...`);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, this.reconnectDelay);
    }

    /**
     * Stop relay connection
     */
    stop() {
        this.enabled = false;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.registered = false;
    }

    /**
     * Get relay status
     */
    getStatus() {
        return {
            configured: this.isConfigured(),
            enabled: this.enabled,
            connected: this.ws && this.ws.readyState === WebSocket.OPEN,
            registered: this.registered,
            pairCode: this.pairCode
        };
    }
}

// Export singleton instance
const relay = new RelayClient();
module.exports = relay;
