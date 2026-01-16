/**
 * Home Assistant WebSocket Client
 * Maintains a persistent connection to HA, subscribes to state_changed events,
 * and provides methods to call services.
 */

const WebSocket = require('ws');
const EventEmitter = require('events');

const SUPERVISOR_TOKEN = process.env.SUPERVISOR_TOKEN;
const HA_WS_URL = 'ws://supervisor/core/api/websocket';

class HAWebSocket extends EventEmitter {
    constructor() {
        super();
        this.ws = null;
        this.msgId = 1;
        this.pendingRequests = new Map();
        this.authenticated = false;
        this.reconnectDelay = 5000;
        this.reconnectTimer = null;
        this.subscriptionId = null;
    }

    /**
     * Connect to Home Assistant WebSocket
     */
    connect() {
        if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
            return;
        }

        console.log('[haWS] Connecting to Home Assistant WebSocket...');

        try {
            this.ws = new WebSocket(HA_WS_URL);
        } catch (err) {
            console.error('[haWS] Failed to create WebSocket:', err.message);
            this.scheduleReconnect();
            return;
        }

        this.ws.on('open', () => {
            console.log('[haWS] WebSocket connected');
        });

        this.ws.on('message', (data) => {
            this.handleMessage(data);
        });

        this.ws.on('close', (code, reason) => {
            console.log(`[haWS] WebSocket closed: ${code} ${reason}`);
            this.authenticated = false;
            this.subscriptionId = null;
            this.emit('disconnected');
            this.scheduleReconnect();
        });

        this.ws.on('error', (err) => {
            console.error('[haWS] WebSocket error:', err.message);
        });
    }

    /**
     * Schedule a reconnection attempt
     */
    scheduleReconnect() {
        if (this.reconnectTimer) return;
        console.log(`[haWS] Reconnecting in ${this.reconnectDelay / 1000}s...`);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, this.reconnectDelay);
    }

    /**
     * Handle incoming WebSocket message
     */
    handleMessage(data) {
        let msg;
        try {
            msg = JSON.parse(data.toString());
        } catch (err) {
            console.error('[haWS] Invalid JSON:', err.message);
            return;
        }

        // Authentication flow
        if (msg.type === 'auth_required') {
            this.sendAuth();
            return;
        }

        if (msg.type === 'auth_ok') {
            console.log('[haWS] Authenticated successfully');
            this.authenticated = true;
            this.emit('connected');
            this.subscribeToStateChanges();
            return;
        }

        if (msg.type === 'auth_invalid') {
            console.error('[haWS] Authentication failed:', msg.message);
            this.ws.close();
            return;
        }

        // Handle subscription events
        if (msg.type === 'event' && msg.event?.event_type === 'state_changed') {
            const eventData = msg.event.data;
            this.emit('state_changed', {
                entity_id: eventData.entity_id,
                new_state: eventData.new_state,
                old_state: eventData.old_state
            });
            return;
        }

        // Handle responses to our requests
        if (msg.id && this.pendingRequests.has(msg.id)) {
            const { resolve, reject } = this.pendingRequests.get(msg.id);
            this.pendingRequests.delete(msg.id);

            if (msg.success === false) {
                reject(new Error(msg.error?.message || 'Unknown error'));
            } else {
                resolve(msg.result);
            }
        }
    }

    /**
     * Send authentication message
     */
    sendAuth() {
        if (!SUPERVISOR_TOKEN) {
            console.error('[haWS] No SUPERVISOR_TOKEN available');
            return;
        }
        this.send({ type: 'auth', access_token: SUPERVISOR_TOKEN });
    }

    /**
     * Subscribe to state_changed events
     */
    subscribeToStateChanges() {
        const id = this.msgId++;
        this.send({
            id,
            type: 'subscribe_events',
            event_type: 'state_changed'
        });
        this.subscriptionId = id;
        console.log('[haWS] Subscribed to state_changed events');
    }

    /**
     * Send a message through the WebSocket
     */
    send(msg) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(msg));
        }
    }

    /**
     * Send a request and wait for response
     */
    request(msg) {
        return new Promise((resolve, reject) => {
            if (!this.authenticated || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
                reject(new Error('Not connected to Home Assistant'));
                return;
            }

            const id = this.msgId++;
            this.pendingRequests.set(id, { resolve, reject });
            this.send({ ...msg, id });

            // Timeout after 30 seconds
            setTimeout(() => {
                if (this.pendingRequests.has(id)) {
                    this.pendingRequests.delete(id);
                    reject(new Error('Request timeout'));
                }
            }, 30000);
        });
    }

    /**
     * Call a Home Assistant service
     */
    async callService(domain, service, data = {}, target = {}) {
        return this.request({
            type: 'call_service',
            domain,
            service,
            service_data: data,
            target
        });
    }

    /**
     * Get current state of an entity
     */
    async getState(entityId) {
        const states = await this.request({ type: 'get_states' });
        return states.find(s => s.entity_id === entityId);
    }

    /**
     * Check if connected and authenticated
     */
    isConnected() {
        return this.authenticated && this.ws && this.ws.readyState === WebSocket.OPEN;
    }

    /**
     * Close the connection
     */
    close() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }
}

// Export singleton instance
const haWS = new HAWebSocket();
module.exports = haWS;
