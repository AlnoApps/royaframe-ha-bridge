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

// Connection status constants
const STATUS = {
    DISCONNECTED: 'disconnected',
    CONFIG_ERROR: 'config_error',
    CONNECTING: 'connecting',
    CONNECTED: 'connected',
    REGISTERING: 'registering',
    REGISTERED: 'registered',
    UNAUTHORIZED: 'unauthorized',
    WRONG_ENDPOINT: 'wrong_endpoint',
    ERROR: 'error'
};

const HANDSHAKE_TIMEOUT_MS = 10000;
const REGISTER_TIMEOUT_MS = 10000;

class RelayClient extends EventEmitter {
    constructor() {
        super();
        this.ws = null;
        this.pairCode = null;
        this.pendingPairCode = null; // Pair code waiting for registration confirmation
        this.awaitingAgentOk = false;
        this.awaitingRegisterOk = false;
        this.registered = false;
        this.reconnectDelay = 5000;      // Start at 5s
        this.maxReconnectDelay = 300000; // Max 5 minutes
        this.baseReconnectDelay = 5000;
        this.reconnectTimer = null;
        this.handshakeTimer = null;
        this.registerTimer = null;
        this.enabled = false;
        this.haVersion = null;
        this.locationName = null;
        this.homeId = null;
        this.status = STATUS.DISCONNECTED;
        this.lastError = null;
        this.shouldRetry = true; // Set to false on config/auth errors
    }

    /**
     * Validate relay URL format
     */
    validateUrl(url) {
        if (!url) return { valid: false, reason: 'relay_url is not set' };
        if (typeof url !== 'string') return { valid: false, reason: 'relay_url must be a string' };
        const trimmed = url.trim();
        if (!trimmed) return { valid: false, reason: 'relay_url is empty' };
        if (!trimmed.startsWith('ws://') && !trimmed.startsWith('wss://')) {
            return { valid: false, reason: 'relay_url must start with ws:// or wss://' };
        }
        return { valid: true };
    }

    /**
     * Validate relay token
     */
    validateToken(token) {
        if (!token) return { valid: false, reason: 'relay_token is not set' };
        if (typeof token !== 'string') return { valid: false, reason: 'relay_token must be a string' };
        if (!token.trim()) return { valid: false, reason: 'relay_token is empty' };
        return { valid: true };
    }

    /**
     * Check if relay is configured with valid values
     */
    isConfigured() {
        const urlCheck = this.validateUrl(RELAY_URL);
        const tokenCheck = this.validateToken(RELAY_TOKEN);
        return urlCheck.valid && tokenCheck.valid;
    }

    /**
     * Get configuration validation errors
     */
    getConfigErrors() {
        const errors = [];
        const urlCheck = this.validateUrl(RELAY_URL);
        const tokenCheck = this.validateToken(RELAY_TOKEN);
        if (!urlCheck.valid) errors.push(urlCheck.reason);
        if (!tokenCheck.valid) errors.push(tokenCheck.reason);
        return errors;
    }

    /**
     * Derive a stable home identifier from HA config
     */
    deriveHomeId(config) {
        if (!config || typeof config !== 'object') return null;
        return (
            config.home_id ||
            config.uuid ||
            config.internal_url ||
            config.external_url ||
            config.location_name ||
            null
        );
    }

    /**
     * Generate a new pairing code (internal - not exposed until registered)
     */
    generatePairCode() {
        // Generate a 6-character alphanumeric code
        this.pendingPairCode = crypto.randomBytes(3).toString('hex').toUpperCase();
        return this.pendingPairCode;
    }

    /**
     * Get the current pairing code (only valid if registered)
     */
    getPairCode() {
        // Only return pair code if we're registered with the relay
        return this.registered ? this.pairCode : null;
    }

    /**
     * Set a specific pairing code (for UI input)
     */
    setPairCode(code) {
        this.pendingPairCode = code;
        if (this.registered) {
            this.pairCode = code;
        }
    }

    /**
     * Invalidate pair code (on disconnect or error)
     */
    invalidatePairCode() {
        this.pairCode = null;
        // Keep pendingPairCode so we can re-register with the same code
    }

    /**
     * Set status and emit event
     */
    setStatus(status, error = null) {
        this.status = status;
        if (error) this.lastError = error;
        this.emit('status_changed', { status, error: this.lastError });
    }

    clearHandshakeTimer() {
        if (this.handshakeTimer) {
            clearTimeout(this.handshakeTimer);
            this.handshakeTimer = null;
        }
    }

    clearRegisterTimer() {
        if (this.registerTimer) {
            clearTimeout(this.registerTimer);
            this.registerTimer = null;
        }
    }

    startHandshakeTimeout() {
        this.clearHandshakeTimer();
        this.handshakeTimer = setTimeout(() => {
            if (!this.awaitingAgentOk) return;
            const errorMsg = 'Handshake timeout: expected agent_ok from relay';
            console.error(`[relay] ${errorMsg}`);
            this.setStatus(STATUS.DISCONNECTED, errorMsg);
            this.invalidatePairCode();
            if (this.ws) this.ws.terminate();
        }, HANDSHAKE_TIMEOUT_MS);
    }

    startRegisterTimeout() {
        this.clearRegisterTimer();
        this.registerTimer = setTimeout(() => {
            if (!this.awaitingRegisterOk) return;
            const errorMsg = 'Registration timeout: expected register_ok from relay';
            console.error(`[relay] ${errorMsg}`);
            this.setStatus(STATUS.DISCONNECTED, errorMsg);
            this.invalidatePairCode();
            if (this.ws) this.ws.terminate();
        }, REGISTER_TIMEOUT_MS);
    }

    /**
     * Start the relay connection
     */
    async start() {
        // Validate configuration first
        const configErrors = this.getConfigErrors();
        if (configErrors.length > 0) {
            const errorMsg = `CONFIG ERROR: ${configErrors.join('; ')}`;
            console.error(`[relay] ${errorMsg}`);
            console.error('[relay] Please check your add-on configuration and set valid relay_url and relay_token.');
            this.setStatus(STATUS.CONFIG_ERROR, errorMsg);
            this.shouldRetry = false; // Don't retry on config errors
            return false;
        }

        if (!this.pendingPairCode) {
            this.generatePairCode();
        }

        // Fetch HA info for registration
        try {
            const config = await ha.getConfig();
            this.haVersion = config.version;
            this.locationName = config.location_name;
            this.homeId = this.deriveHomeId(config);
        } catch (err) {
            console.error('[relay] Failed to fetch HA config:', err.message);
        }

        this.enabled = true;
        this.shouldRetry = true;
        this.lastError = null;
        this.reconnectDelay = this.baseReconnectDelay; // Reset backoff
        this.connect();
        return true;
    }

    /**
     * Connect to the relay server
     */
    connect() {
        if (!this.enabled) return;
        if (!this.shouldRetry) {
            console.log('[relay] Not retrying due to config/auth error. Fix configuration and restart.');
            return;
        }

        if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
            return;
        }

        this.setStatus(STATUS.CONNECTING);
        const hasAuthHeader = !!(RELAY_TOKEN && RELAY_TOKEN.trim());
        console.log(`[relay] Connecting to ${RELAY_URL} (Authorization header ${hasAuthHeader ? 'set' : 'missing'})...`);

        try {
            this.ws = new WebSocket(RELAY_URL, {
                headers: {
                    'Authorization': `Bearer ${RELAY_TOKEN}`
                }
            });
        } catch (err) {
            console.error(`[relay] Failed to create WebSocket: ${err.message}`);
            this.setStatus(STATUS.ERROR, `Failed to create WebSocket: ${err.message}`);
            this.scheduleReconnect();
            return;
        }

        // Handle HTTP responses before upgrade (detects 401, 200, etc.)
        this.ws.on('unexpected-response', (req, res) => {
            const statusCode = res.statusCode;
            let errorMsg;

            if (statusCode === 401) {
                errorMsg = '401 Unauthorized: token mismatch or RELAY_TOKEN not set on relay worker.';
                this.shouldRetry = false; // Don't retry auth errors
                this.setStatus(STATUS.UNAUTHORIZED, errorMsg);
            } else if (statusCode === 400) {
                errorMsg = '400 Bad Request: wrong endpoint / no websocket upgrade / bad request.';
                this.shouldRetry = false; // Don't retry wrong endpoint
                this.setStatus(STATUS.WRONG_ENDPOINT, errorMsg);
            } else if (statusCode === 200) {
                errorMsg = '200 OK: wrong endpoint / no websocket upgrade.';
                this.shouldRetry = false; // Don't retry wrong endpoint
                this.setStatus(STATUS.WRONG_ENDPOINT, errorMsg);
            } else {
                errorMsg = `Unexpected server response: HTTP ${statusCode}`;
                this.setStatus(STATUS.ERROR, errorMsg);
            }

            console.error(`[relay] ${errorMsg}`);
            this.invalidatePairCode();
            this.emit('disconnected');
            this.clearHandshakeTimer();
            this.clearRegisterTimer();
            this.awaitingAgentOk = false;
            this.awaitingRegisterOk = false;

            // Destroy the request to clean up
            req.destroy();
        });

        this.ws.on('open', () => {
            console.log('[relay] WebSocket connected; awaiting agent_ok');
            this.lastError = null;
            this.setStatus(STATUS.CONNECTING);
            this.reconnectDelay = this.baseReconnectDelay; // Reset backoff on success
            this.awaitingAgentOk = true;
            this.awaitingRegisterOk = false;
            this.startHandshakeTimeout();
        });

        this.ws.on('message', (data) => {
            this.handleMessage(data);
        });

        this.ws.on('close', (code, reason) => {
            const reasonStr = reason ? reason.toString() : '';
            this.registered = false;
            this.invalidatePairCode();
            this.awaitingAgentOk = false;
            this.awaitingRegisterOk = false;
            this.clearHandshakeTimer();
            this.clearRegisterTimer();

            // Provide actionable error messages based on close code
            const preserveStatus = this.status === STATUS.UNAUTHORIZED ||
                this.status === STATUS.WRONG_ENDPOINT ||
                this.status === STATUS.CONFIG_ERROR;

            if (code === 1006) {
                console.error('[relay] Abnormal close (code 1006): Connection was terminated unexpectedly.');
                if (!preserveStatus) {
                    this.setStatus(STATUS.DISCONNECTED, '1006 Abnormal close: relay server unavailable or rejected connection.');
                }
            } else if (!preserveStatus) {
                console.log(`[relay] Connection closed: code=${code} reason=${reasonStr}`);
                const closeMsg = code ? `Connection closed: ${code}` : 'Connection closed';
                this.setStatus(STATUS.DISCONNECTED, closeMsg);
            }

            this.emit('disconnected');

            if (this.shouldRetry) {
                this.scheduleReconnect();
            } else {
                console.log('[relay] Not reconnecting due to configuration/authorization error.');
            }
        });

        this.ws.on('error', (err) => {
            console.error(`[relay] WebSocket error: ${err.message}`);
            // Don't set status here - let close handler do it with proper code
        });
    }

    /**
     * Register this bridge with the relay
     */
    register() {
        this.setStatus(STATUS.REGISTERING);
        this.awaitingRegisterOk = true;
        this.startRegisterTimeout();
        const homeId = this.homeId || this.locationName || 'unknown';
        const msg = {
            type: 'register_bridge',
            pair_code: this.pendingPairCode,
            home_id: homeId
        };
        console.log(`[relay] Sending register_bridge with pair_code=${this.pendingPairCode}`);
        this.send(msg);
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
            case 'agent_ok':
                if (!this.awaitingAgentOk) {
                    console.warn('[relay] Unexpected agent_ok; ignoring.');
                    break;
                }
                console.log('[relay] Relay agent_ok received');
                this.awaitingAgentOk = false;
                this.clearHandshakeTimer();
                this.lastError = null;
                this.register();
                break;

            case 'agent_unauthorized': {
                const errorMsg = '401 Unauthorized: token mismatch or RELAY_TOKEN not set on relay worker.';
                console.error(`[relay] ${errorMsg}`);
                this.shouldRetry = false;
                this.setStatus(STATUS.UNAUTHORIZED, errorMsg);
                this.invalidatePairCode();
                if (this.ws) this.ws.close(1008, 'unauthorized');
                break;
            }

            case 'register_ok': {
                if (!this.awaitingRegisterOk) {
                    console.warn('[relay] Unexpected register_ok; ignoring.');
                    break;
                }
                console.log('[relay] register_ok received - bridge is now registered');
                this.registered = true;
                this.awaitingRegisterOk = false;
                this.clearRegisterTimer();
                const ackCode = msg.pair_code || this.pendingPairCode;
                if (msg.pair_code && msg.pair_code !== this.pendingPairCode) {
                    console.warn(`[relay] register_ok pair_code mismatch (expected ${this.pendingPairCode}, got ${msg.pair_code})`);
                }
                this.pairCode = ackCode;
                this.pendingPairCode = ackCode;
                this.lastError = null;
                this.setStatus(STATUS.CONNECTED);
                this.emit('registered');
                break;
            }

            case 'registered':
                console.log('[relay] registered received - treating as register_ok');
                this.registered = true;
                this.awaitingRegisterOk = false;
                this.clearRegisterTimer();
                this.pairCode = this.pendingPairCode;
                this.lastError = null;
                this.setStatus(STATUS.CONNECTED);
                this.emit('registered');
                break;

            case 'paired':
                console.log('[relay] Bridge paired with remote client');
                this.pairCode = null; // Invalidate pair code after use
                this.pendingPairCode = null;
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
     * Schedule reconnection with exponential backoff
     */
    scheduleReconnect() {
        if (this.reconnectTimer || !this.enabled || !this.shouldRetry) return;

        console.log(`[relay] Reconnecting in ${this.reconnectDelay / 1000}s...`);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, this.reconnectDelay);

        // Exponential backoff: double the delay up to max
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
    }

    /**
     * Stop relay connection
     */
    stop() {
        console.log('[relay] Stopping relay connection');
        this.enabled = false;
        this.shouldRetry = false;
        this.awaitingAgentOk = false;
        this.awaitingRegisterOk = false;
        this.clearHandshakeTimer();
        this.clearRegisterTimer();
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.registered = false;
        this.invalidatePairCode();
        this.setStatus(STATUS.DISCONNECTED);
    }

    /**
     * Get relay status with detailed information
     */
    getStatus() {
        return {
            configured: this.isConfigured(),
            configErrors: this.getConfigErrors(),
            enabled: this.enabled,
            connected: this.ws && this.ws.readyState === WebSocket.OPEN,
            registered: this.registered,
            status: this.status,
            lastError: this.lastError,
            pairCode: this.getPairCode(), // Only returns code if registered
            pendingPairCode: this.pendingPairCode, // For debugging
            relayUrl: RELAY_URL || null,
            hasToken: !!RELAY_TOKEN,
            shouldRetry: this.shouldRetry,
            reconnectDelay: this.reconnectDelay
        };
    }
}

// Export singleton instance
const relay = new RelayClient();
module.exports = relay;
