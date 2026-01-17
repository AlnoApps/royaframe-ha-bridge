/**
 * Relay Client
 * Optional outbound WebSocket connection to a cloud relay server.
 * Uses per-install ed25519 identity and challenge-response auth.
 */

const WebSocket = require('ws');
const EventEmitter = require('events');
const fs = require('fs');
const haWS = require('./haWebSocket');
const ha = require('./ha');
const identity = require('./agentIdentity');

const DEFAULT_RELAY_ORIGIN = 'https://digital-twin.lavvimaa.workers.dev';
const RELAY_OVERRIDE_PATH = process.env.RELAY_OVERRIDE_PATH || '/data/royaframe_relay_override.json';

const STATUS = {
    DISCONNECTED: 'disconnected',
    CONFIG_ERROR: 'config_error',
    CONNECTING: 'connecting',
    AUTHENTICATING: 'authenticating',
    CONNECTED: 'connected',
    REGISTERING: 'registering',
    REGISTERED: 'registered',
    UNAUTHORIZED: 'unauthorized',
    IDLE: 'idle',
    ERROR: 'error'
};

const REGISTER_TIMEOUT_MS = 10000;
const TOKEN_REFRESH_SAFETY_MS = 60000;
const MIN_TOKEN_TTL_SECONDS = 60;
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const IDLE_POLL_INTERVAL_MS = 30000;

function normalizeRelayOrigin(value) {
    if (!value || typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
        const url = new URL(trimmed);
        if (url.protocol === 'ws:' || url.protocol === 'wss:') {
            url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
        }
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
        return url.origin;
    } catch {
        return null;
    }
}

function loadRelayOverride() {
    if (!fs.existsSync(RELAY_OVERRIDE_PATH)) return null;
    try {
        const raw = fs.readFileSync(RELAY_OVERRIDE_PATH, 'utf8');
        const data = JSON.parse(raw);
        if (data && typeof data === 'object') {
            return data.relay_origin || data.relay_url || null;
        }
    } catch (err) {
        console.error(`[relay] Failed to parse relay override file: ${err.message}`);
    }
    return null;
}

function resolveRelayOrigin() {
    const override = loadRelayOverride();
    if (override) {
        const origin = normalizeRelayOrigin(override);
        return { origin, source: origin ? 'override' : 'override_invalid' };
    }

    const envValue = process.env.RELAY_URL || '';
    if (envValue.trim()) {
        const origin = normalizeRelayOrigin(envValue);
        return { origin, source: origin ? 'env' : 'env_invalid' };
    }

    return { origin: normalizeRelayOrigin(DEFAULT_RELAY_ORIGIN), source: 'default' };
}

function extractAppCount(data) {
    if (!data || typeof data !== 'object') return null;
    const keys = [
        'app_count',
        'appCount',
        'viewer_count',
        'viewerCount',
        'active_viewers',
        'activeViewers'
    ];
    for (const key of keys) {
        if (typeof data[key] === 'number') return data[key];
    }
    return null;
}

class RelayClient extends EventEmitter {
    constructor() {
        super();
        const resolved = resolveRelayOrigin();
        this.relayOrigin = resolved.origin;
        this.relayOriginSource = resolved.source;
        this.relayOriginValid = !!this.relayOrigin;

        this.ws = null;
        this.wsUrl = null;
        this.agentToken = null;
        this.tokenExpiresAt = null;
        this.tokenRefreshTimer = null;
        this.authPromise = null;
        this.connecting = false;

        this.awaitingRegisterOk = false;
        this.registered = false;
        this.registerTimer = null;

        this.baseReconnectDelay = 5000;
        this.reconnectDelay = this.baseReconnectDelay;
        this.maxReconnectDelay = 300000;
        this.reconnectTimer = null;
        this.forceReconnect = false;

        this.enabled = false;
        this.shouldRetry = true;
        this.haVersion = null;
        this.locationName = null;
        this.homeId = null;
        this.status = STATUS.DISCONNECTED;
        this.lastError = null;

        this.appCount = null;
        this.lastAppCountAt = null;
        this.idleState = 'active';
        this.idleTimer = null;
        this.idlePollTimer = null;
        this.idleClosing = false;
    }

    validateOrigin(origin) {
        if (!origin) return { valid: false, reason: 'relay_origin is not set' };
        if (typeof origin !== 'string') return { valid: false, reason: 'relay_origin must be a string' };
        const trimmed = origin.trim();
        if (!trimmed) return { valid: false, reason: 'relay_origin is empty' };
        if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
            return { valid: false, reason: 'relay_origin must start with http:// or https://' };
        }
        return { valid: true };
    }

    isConfigured() {
        return this.relayOriginValid;
    }

    getConfigErrors() {
        const errors = [];
        const originCheck = this.validateOrigin(this.relayOrigin || '');
        if (!originCheck.valid) {
            if (this.relayOriginSource === 'env_invalid') {
                errors.push('RELAY_URL is invalid');
            } else if (this.relayOriginSource === 'override_invalid') {
                errors.push('relay override file contains an invalid relay_origin');
            } else {
                errors.push(originCheck.reason);
            }
        }
        return errors;
    }

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

    getAgentInfo() {
        const info = {};
        if (this.homeId) info.home_id = this.homeId;
        if (this.locationName) info.location_name = this.locationName;
        if (this.haVersion) info.ha_version = this.haVersion;
        const agentId = identity.getAgentId();
        if (agentId) info.agent_id = agentId;
        return info;
    }

    setStatus(status, error = null) {
        this.status = status;
        if (error) this.lastError = error;
        this.emit('status_changed', { status, error: this.lastError });
    }

    clearRegisterTimer() {
        if (this.registerTimer) {
            clearTimeout(this.registerTimer);
            this.registerTimer = null;
        }
    }

    startRegisterTimeout() {
        this.clearRegisterTimer();
        this.registerTimer = setTimeout(() => {
            if (!this.awaitingRegisterOk) return;
            const errorMsg = 'Registration timeout: expected register_ok from relay';
            console.error(`[relay] ${errorMsg}`);
            this.setStatus(STATUS.ERROR, errorMsg);
            if (this.ws) this.ws.terminate();
        }, REGISTER_TIMEOUT_MS);
    }

    clearTokenRefreshTimer() {
        if (this.tokenRefreshTimer) {
            clearTimeout(this.tokenRefreshTimer);
            this.tokenRefreshTimer = null;
        }
    }

    scheduleTokenRefresh() {
        this.clearTokenRefreshTimer();
        if (!this.tokenExpiresAt) return;
        const now = Date.now();
        const refreshIn = Math.max(this.tokenExpiresAt - now - TOKEN_REFRESH_SAFETY_MS, 10000);
        this.tokenRefreshTimer = setTimeout(() => {
            this.tokenRefreshTimer = null;
            this.refreshToken();
        }, refreshIn);
    }

    refreshToken() {
        this.agentToken = null;
        this.tokenExpiresAt = null;
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.forceReconnect = true;
            this.ws.close(1000, 'token_refresh');
            return;
        }
        this.connect();
    }

    clearIdleTimer() {
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
    }

    clearIdlePoll() {
        if (this.idlePollTimer) {
            clearInterval(this.idlePollTimer);
            this.idlePollTimer = null;
        }
    }

    scheduleIdleCheck() {
        if (this.idleTimer || this.appCount !== 0) return;
        this.idleState = 'pending';
        this.idleTimer = setTimeout(() => {
            if (this.appCount !== 0) return;
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
            this.enterIdle();
        }, IDLE_TIMEOUT_MS);
    }

    enterIdle() {
        this.clearIdleTimer();
        this.idleState = 'idle';
        this.idleClosing = true;
        if (this.ws) {
            this.ws.close(1000, 'idle');
        }
        this.startIdlePoll();
    }

    startIdlePoll() {
        if (this.idlePollTimer) return;
        this.idlePollTimer = setInterval(() => {
            this.checkForViewers();
        }, IDLE_POLL_INTERVAL_MS);
    }

    async checkForViewers() {
        const httpOrigin = this.getWorkerHttpOrigin();
        if (!httpOrigin) return;
        const statusUrl = `${httpOrigin}/api/status`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 2000);

        try {
            const response = await fetch(statusUrl, {
                signal: controller.signal,
                headers: { 'Accept': 'application/json' }
            });
            clearTimeout(timeoutId);

            if (!response.ok) return;
            const data = await response.json();
            const count = extractAppCount(data);
            if (typeof count === 'number' && count > 0) {
                this.appCount = count;
                this.idleState = 'active';
                this.clearIdlePoll();
                this.connect();
            }
        } catch (err) {
            clearTimeout(timeoutId);
        }
    }

    updateAppCount(count) {
        if (typeof count !== 'number') return;
        this.appCount = count;
        this.lastAppCountAt = Date.now();

        if (count > 0) {
            this.idleState = 'active';
            this.clearIdleTimer();
            this.clearIdlePoll();
            return;
        }

        this.scheduleIdleCheck();
    }

    async start() {
        const configErrors = this.getConfigErrors();
        if (configErrors.length > 0) {
            const errorMsg = `CONFIG ERROR: ${configErrors.join('; ')}`;
            console.error(`[relay] ${errorMsg}`);
            this.setStatus(STATUS.CONFIG_ERROR, errorMsg);
            this.shouldRetry = false;
            return false;
        }

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
        this.reconnectDelay = this.baseReconnectDelay;
        this.connect();
        return true;
    }

    async connect() {
        if (!this.enabled) return;
        if (!this.shouldRetry) return;
        if (this.connecting) return;

        if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
            return;
        }

        if (this.idleState === 'idle') {
            this.clearIdlePoll();
            this.idleState = 'active';
        }

        this.connecting = true;
        this.setStatus(STATUS.CONNECTING);

        try {
            const auth = await this.ensureAgentToken();
            if (!auth || !auth.wsUrl) {
                throw new Error('Missing ws_url from relay');
            }
            this.openWebSocket(auth.wsUrl, auth.agentToken);
        } catch (err) {
            const errorMsg = `Relay connect failed: ${err.message}`;
            console.error(`[relay] ${errorMsg}`);
            this.setStatus(STATUS.ERROR, errorMsg);
            this.scheduleReconnect();
        } finally {
            this.connecting = false;
        }
    }

    async ensureAgentToken() {
        const now = Date.now();
        if (this.agentToken && this.tokenExpiresAt && (this.tokenExpiresAt - now > TOKEN_REFRESH_SAFETY_MS)) {
            return { agentToken: this.agentToken, wsUrl: this.wsUrl };
        }
        return this.authenticate();
    }

    async authenticate() {
        if (this.authPromise) return this.authPromise;
        this.authPromise = (async () => {
            this.setStatus(STATUS.AUTHENTICATING);
            const challenge = await this.requestAgentChallenge();
            const signature = identity.sign(challenge.nonce);
            const issue = await this.requestAgentIssue(challenge.agent_id, signature);

            if (!issue.agent_token || !issue.ws_url) {
                throw new Error('Invalid token response from relay');
            }

            const now = Date.now();
            const expiresIn = Number(issue.token_expires_in) || 300;
            const ttlSeconds = Math.max(expiresIn, MIN_TOKEN_TTL_SECONDS);

            this.agentToken = issue.agent_token;
            this.wsUrl = issue.ws_url;
            this.tokenExpiresAt = now + ttlSeconds * 1000;
            this.scheduleTokenRefresh();

            const tokenLen = this.agentToken ? this.agentToken.length : 0;
            console.log(`[relay] Agent token issued (set: ${!!this.agentToken}, length: ${tokenLen}, ttl_s: ${ttlSeconds})`);

            return { agentToken: this.agentToken, wsUrl: this.wsUrl };
        })();

        try {
            return await this.authPromise;
        } finally {
            this.authPromise = null;
        }
    }

    async postJson(url, body, timeoutMs = 8000) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                body: JSON.stringify(body),
                signal: controller.signal
            });

            const text = await response.text();
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${text || response.statusText}`);
            }
            if (!text) return {};
            return JSON.parse(text);
        } catch (err) {
            if (err.name === 'AbortError') {
                throw new Error(`Timeout after ${timeoutMs}ms`);
            }
            throw err;
        } finally {
            clearTimeout(timeoutId);
        }
    }

    async requestAgentChallenge() {
        if (!this.relayOrigin) {
            throw new Error('relay_origin is not set');
        }

        const publicKey = identity.getPublicKey();
        const keyInfo = identity.getKeyInfo();

        // Debug logging (safe - no actual key values, only hashes)
        console.log(`[relay] Challenge request: public_key_string_length=${publicKey.length}, public_key_bytes=${keyInfo.public_key_bytes}, pubkey_hash=${keyInfo.public_key_hash}`);
        if (keyInfo.public_key_bytes !== 32) {
            console.error(`[relay] ERROR: public_key_bytes must be 32, got ${keyInfo.public_key_bytes}`);
        }

        const payload = {
            public_key: publicKey,
            agent_info: this.getAgentInfo()
        };

        const url = `${this.relayOrigin}/api/agent/challenge`;
        const data = await this.postJson(url, payload, 8000);

        if (!data.agent_id || !data.nonce) {
            throw new Error('Invalid challenge response from relay');
        }

        console.log(`[relay] Challenge received: agent_id=${data.agent_id}, nonce_length=${data.nonce?.length || 0}`);
        identity.setAgentId(data.agent_id);
        return data;
    }

    async requestAgentIssue(agentId, signature) {
        const url = `${this.relayOrigin}/api/agent/issue`;
        const publicKey = identity.getPublicKey();

        // Debug logging for signature (safe - uses actual decode, no values)
        const sigByteLen = identity.getSignatureByteLength(signature);
        console.log(`[relay] Issue request: signature_string_length=${signature?.length || 0}, signature_bytes=${sigByteLen}`);
        if (sigByteLen !== 64) {
            console.error(`[relay] ERROR: signature bytes must be 64, got ${sigByteLen}`);
        }

        const payload = {
            agent_id: agentId,
            public_key: publicKey,
            signature
        };

        return this.postJson(url, payload, 8000);
    }

    openWebSocket(wsUrl, agentToken) {
        const tokenLen = agentToken ? agentToken.length : 0;
        console.log(`[relay] Connecting to ${wsUrl}`);
        console.log(`[relay] Authorization: Bearer <token> (token set: ${!!agentToken}, length: ${tokenLen})`);

        try {
            this.ws = new WebSocket(wsUrl, {
                headers: {
                    'Authorization': `Bearer ${agentToken}`
                }
            });
        } catch (err) {
            console.error(`[relay] Failed to create WebSocket: ${err.message}`);
            this.setStatus(STATUS.ERROR, `Failed to create WebSocket: ${err.message}`);
            this.scheduleReconnect();
            return;
        }

        this.ws.on('unexpected-response', (req, res) => {
            const statusCode = res.statusCode;
            const errorMsg = `HTTP ${statusCode} during WebSocket upgrade`;

            if (statusCode === 401 || statusCode === 403) {
                this.handleUnauthorized(errorMsg);
            } else if (statusCode === 400 || statusCode === 200) {
                this.setStatus(STATUS.ERROR, 'Wrong endpoint or no websocket upgrade');
            } else {
                this.setStatus(STATUS.ERROR, errorMsg);
            }

            console.error(`[relay] ${errorMsg}`);
            req.destroy();
        });

        this.ws.on('open', () => {
            const readyState = this.ws ? this.ws.readyState : 'no ws';
            console.log(`[relay] WS open event fired, readyState=${readyState}`);
            this.lastError = null;
            this.reconnectDelay = this.baseReconnectDelay;
            this.setStatus(STATUS.CONNECTED);
            // Send register_bridge immediately after open
            this.register();
        });

        this.ws.on('message', (data) => {
            // Log every message type for debugging
            try {
                const parsed = JSON.parse(data.toString());
                console.log(`[relay] WS message received: type=${parsed.type || 'unknown'}`);
            } catch {
                console.log('[relay] WS message received: (unparseable)');
            }
            this.handleMessage(data);
        });

        this.ws.on('close', (code, reason) => {
            const reasonStr = reason ? reason.toString() : '';
            console.log(`[relay] WS close code=${code} reason=${reasonStr}`);

            const wasIdleClose = this.idleClosing;
            this.idleClosing = false;

            const wasForced = this.forceReconnect;
            this.forceReconnect = false;

            this.registered = false;
            this.awaitingRegisterOk = false;
            this.clearRegisterTimer();

            const preserveStatus = this.status === STATUS.UNAUTHORIZED ||
                this.status === STATUS.CONFIG_ERROR;

            if (wasIdleClose) {
                this.setStatus(STATUS.IDLE);
                return;
            }

            if (!preserveStatus) {
                if (code === 1006) {
                    this.setStatus(STATUS.DISCONNECTED, '1006 Abnormal close: relay server unavailable or rejected connection.');
                } else {
                    const closeMsg = code ? `Connection closed: ${code}` : 'Connection closed';
                    this.setStatus(STATUS.DISCONNECTED, closeMsg);
                }
            }

            this.emit('disconnected');

            if (wasForced) {
                this.reconnectDelay = this.baseReconnectDelay;
                this.connect();
                return;
            }

            if (this.shouldRetry) {
                this.scheduleReconnect();
            }
        });

        this.ws.on('error', (err) => {
            console.error(`[relay] WebSocket error: ${err.message}`);
        });
    }

    handleUnauthorized(reason) {
        const errorMsg = `Unauthorized: ${reason}`;
        console.error(`[relay] ${errorMsg}`);
        this.setStatus(STATUS.UNAUTHORIZED, errorMsg);
        this.agentToken = null;
        this.tokenExpiresAt = null;
        this.forceReconnect = true;
        if (this.ws) this.ws.close(1008, 'unauthorized');
    }

    register() {
        this.setStatus(STATUS.REGISTERING);
        this.awaitingRegisterOk = true;
        this.startRegisterTimeout();

        const pairCode = identity.getPairCode();
        const agentId = identity.getAgentId();
        const homeId = this.homeId || this.locationName || 'Home';

        // Build register_bridge message with validated fields
        const msg = {
            type: 'register_bridge',
            pair_code: String(pairCode || ''),
            home_id: String(homeId)
        };

        // Only include agent_id if it's a valid string
        if (agentId && typeof agentId === 'string') {
            msg.agent_id = agentId;
        }

        // Detailed logging before send
        console.log(`[relay] WS open -> sending register_bridge:`);
        console.log(`[relay]   pair_code=${msg.pair_code} (type=${typeof msg.pair_code}, length=${msg.pair_code.length})`);
        console.log(`[relay]   home_id=${msg.home_id} (type=${typeof msg.home_id})`);
        console.log(`[relay]   agent_id=${msg.agent_id || '(not set)'} (type=${typeof msg.agent_id})`);

        const sent = this.send(msg);
        if (sent) {
            console.log('[relay] register_bridge message sent successfully');
        } else {
            console.error('[relay] FAILED to send register_bridge - WebSocket not ready');
        }
    }

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
                console.log('[relay] Received agent_ok (ignored)');
                break;

            case 'register_ok': {
                if (!this.awaitingRegisterOk) {
                    console.warn('[relay] Unexpected register_ok; ignoring.');
                    break;
                }
                console.log('[relay] Received register_ok -> registration successful!');
                this.registered = true;
                this.awaitingRegisterOk = false;
                this.clearRegisterTimer();
                console.log(`[relay] registered=${this.registered}, status will be REGISTERED`);
                if (msg.agent_id) {
                    identity.setAgentId(msg.agent_id);
                }
                this.lastError = null;
                this.setStatus(STATUS.REGISTERED);
                this.emit('registered');
                break;
            }

            case 'registered':
                console.log('[relay] registered received - treating as register_ok');
                this.registered = true;
                this.awaitingRegisterOk = false;
                this.clearRegisterTimer();
                if (msg.agent_id) {
                    identity.setAgentId(msg.agent_id);
                }
                this.lastError = null;
                this.setStatus(STATUS.REGISTERED);
                this.emit('registered');
                break;

            case 'paired':
                console.log('[relay] Bridge paired with remote client');
                this.emit('paired', msg.client_id);
                break;

            case 'app_count':
                this.updateAppCount(msg.app_count);
                break;

            case 'viewer_online':
                this.updateAppCount(1);
                break;

            case 'viewer_offline':
                this.updateAppCount(0);
                break;

            case 'agent_unauthorized':
                this.handleUnauthorized('agent_unauthorized');
                break;

            case 'call_service':
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

            case 'error': {
                const errorStr = msg.error || 'unknown error';
                console.error(`[relay] Relay error: ${errorStr}`);

                if (errorStr === 'unauthorized' || errorStr.includes('unauthorized')) {
                    this.handleUnauthorized('relay_error');
                } else {
                    this.setStatus(STATUS.ERROR, `Relay error: ${errorStr}`);
                }
                break;
            }

            default:
                break;
        }
    }

    send(msg) {
        if (!this.ws) {
            console.error('[relay] send() called but this.ws is null');
            return false;
        }

        const state = this.ws.readyState;
        const stateNames = { 0: 'CONNECTING', 1: 'OPEN', 2: 'CLOSING', 3: 'CLOSED' };
        const stateName = stateNames[state] || `unknown(${state})`;

        if (state !== WebSocket.OPEN) {
            console.error(`[relay] send() called but WebSocket is ${stateName}, not OPEN`);
            return false;
        }

        try {
            const json = JSON.stringify(msg);
            this.ws.send(json);
            return true;
        } catch (err) {
            console.error(`[relay] send() failed: ${err.message}`);
            return false;
        }
    }

    forwardStateChange(data) {
        if (!this.registered) return;
        if (this.appCount === 0) return;
        this.send({
            type: 'state_changed',
            data
        });
    }

    scheduleReconnect() {
        if (this.reconnectTimer || !this.enabled || !this.shouldRetry) return;

        const jitter = Math.random() * 0.3 * this.reconnectDelay;
        const delay = Math.min(this.reconnectDelay + jitter, this.maxReconnectDelay);

        console.log(`[relay] Reconnecting in ${Math.round(delay / 1000)}s...`);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, delay);

        this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
    }

    stop() {
        console.log('[relay] Stopping relay connection');
        this.enabled = false;
        this.shouldRetry = false;
        this.awaitingRegisterOk = false;
        this.clearRegisterTimer();
        this.clearTokenRefreshTimer();
        this.clearIdleTimer();
        this.clearIdlePoll();

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }

        this.registered = false;
        this.setStatus(STATUS.DISCONNECTED);
    }

    regeneratePairCode() {
        const code = identity.regeneratePairCode();
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.register();
        }
        return code;
    }

    setPairCode(code) {
        const ok = identity.setPairCode(code);
        if (ok && this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.register();
        }
        return ok;
    }

    getPairCode() {
        return identity.getPairCode();
    }

    getWorkerHttpOrigin() {
        return this.relayOrigin;
    }

    getStatus() {
        const now = Date.now();
        const tokenExpiresIn = this.tokenExpiresAt ? Math.max(0, Math.floor((this.tokenExpiresAt - now) / 1000)) : null;

        // Get key info for key_ok field (only sizes, no secrets)
        const keyInfo = identity.getKeyInfo();

        return {
            configured: this.isConfigured(),
            config_errors: this.getConfigErrors(),
            enabled: this.enabled,
            relay_connected: this.ws && this.ws.readyState === WebSocket.OPEN,
            registered: this.registered,
            status: this.status,
            last_error: this.lastError,
            pair_code: identity.getPairCode(),
            agent_id: identity.getAgentId(),
            relay_origin: this.relayOrigin,
            relay_origin_source: this.relayOriginSource,
            worker_http_origin: this.getWorkerHttpOrigin(),
            idle_state: this.idleState,
            app_count: this.appCount,
            token_set: !!this.agentToken,
            token_expires_in: tokenExpiresIn,
            should_retry: this.shouldRetry,
            reconnect_delay_ms: this.reconnectDelay,
            key_ok: {
                public_key_bytes: keyInfo.public_key_bytes,
                signature_bytes: 64  // Ed25519 signatures are always 64 bytes
            }
        };
    }
}

const relay = new RelayClient();
module.exports = relay;
