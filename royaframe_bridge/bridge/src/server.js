/**
 * RoyaFrame Bridge Server
 * Serves via Home Assistant Ingress with WebSocket support for real-time updates.
 * Optional relay connection for secure remote access.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const ha = require('./ha');
const haWS = require('./haWebSocket');
const wsServer = require('./wsServer');
const relay = require('./relay');

const PORT = 8099; // Must match ingress_port in config.yaml
console.log(`[env] RELAY_URL=${process.env.RELAY_URL}`);

/**
 * Fetch worker status with timeout (does not leak token)
 */
async function fetchWorkerStatus(timeoutMs = 2000) {
    const httpOrigin = relay.getWorkerHttpOrigin();
    if (!httpOrigin) {
        return { error: 'RELAY_URL not configured or invalid' };
    }

    const statusUrl = `${httpOrigin}/api/status`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(statusUrl, {
            signal: controller.signal,
            headers: { 'Accept': 'application/json' }
        });
        clearTimeout(timeoutId);

        if (!response.ok) {
            return { error: `HTTP ${response.status}`, url: statusUrl };
        }

        const data = await response.json();
        return { ok: true, url: statusUrl, data };
    } catch (err) {
        clearTimeout(timeoutId);
        if (err.name === 'AbortError') {
            return { error: `Timeout after ${timeoutMs}ms`, url: statusUrl };
        }
        return { error: err.message, url: statusUrl };
    }
}

// MIME types for static files
const MIME_TYPES = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json'
};

/**
 * Serve static files from /public
 */
function serveStatic(res, filePath) {
    const publicDir = path.join(__dirname, '..', 'public');
    const fullPath = path.join(publicDir, filePath === '/' ? 'index.html' : filePath);

    // Security: prevent path traversal
    if (!fullPath.startsWith(publicDir)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
    }

    const ext = path.extname(fullPath);
    const contentType = MIME_TYPES[ext] || 'text/plain';

    fs.readFile(fullPath, (err, data) => {
        if (err) {
            res.writeHead(404);
            res.end('Not Found');
            return;
        }
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(data);
    });
}

/**
 * Send JSON response
 */
function sendJson(res, data, status = 200) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

/**
 * Parse JSON body from request
 */
function parseBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch (e) {
                reject(new Error('Invalid JSON'));
            }
        });
        req.on('error', reject);
    });
}

/**
 * Handle API routes
 */
async function handleApi(req, res) {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const pathname = url.pathname;

    try {
        switch (pathname) {
            case '/health': {
                // Fetch worker status with short timeout (best-effort)
                const workerStatus = await fetchWorkerStatus(2000);
                sendJson(res, {
                    status: 'ok',
                    service: 'royaframe-bridge',
                    version: '1.1.0',
                    timestamp: new Date().toISOString(),
                    ha_connected: haWS.isConnected(),
                    ws_clients: wsServer.getClientCount(),
                    relay: relay.getStatus(),
                    relayWorkerStatus: workerStatus
                });
                break;
            }

            case '/ha/info':
                const config = await ha.getConfig();
                sendJson(res, {
                    location_name: config.location_name,
                    version: config.version,
                    unit_system: config.unit_system,
                    time_zone: config.time_zone
                });
                break;

            case '/ha/entities':
                const states = await ha.getStates();
                // Return simplified entity list
                const entities = states.map(entity => ({
                    entity_id: entity.entity_id,
                    state: entity.state,
                    friendly_name: entity.attributes?.friendly_name || entity.entity_id
                }));
                sendJson(res, { entities });
                break;

            case '/ha/status':
                const status = await ha.checkConnection();
                sendJson(res, {
                    ...status,
                    ws_connected: haWS.isConnected()
                });
                break;

            case '/ws/status':
                sendJson(res, {
                    ha_connected: haWS.isConnected(),
                    clients: wsServer.getClientCount()
                });
                break;

            case '/relay/status':
                const workerStatus = await fetchWorkerStatus(2000);
                sendJson(res, { ...relay.getStatus(), worker_status: workerStatus });
                break;

            case '/relay/worker-status': {
                const workerResult = await fetchWorkerStatus(5000);
                sendJson(res, workerResult);
                break;
            }

            case '/relay/pair':
                if (req.method !== 'POST') {
                    sendJson(res, { error: 'Method not allowed' }, 405);
                    break;
                }
                const body = await parseBody(req);

                // Regenerate pair code unless a specific valid code is provided
                if (body.pair_code) {
                    const ok = relay.setPairCode(body.pair_code);
                    if (!ok) {
                        sendJson(res, { error: 'Invalid pair_code (expected 6 hex chars)' }, 400);
                        break;
                    }
                } else {
                    relay.regeneratePairCode();
                }

                // Start relay connection
                const started = await relay.start();

                sendJson(res, {
                    success: started,
                    pair_code: relay.getPairCode(),
                    status: relay.getStatus()
                });
                break;

            case '/relay/regenerate-code':
                if (req.method !== 'POST') {
                    sendJson(res, { error: 'Method not allowed' }, 405);
                    break;
                }
                relay.regeneratePairCode();
                await relay.start();
                sendJson(res, { pair_code: relay.getPairCode(), status: relay.getStatus() });
                break;

            case '/relay/stop':
                if (req.method !== 'POST') {
                    sendJson(res, { error: 'Method not allowed' }, 405);
                    break;
                }
                relay.stop();
                sendJson(res, { success: true, status: relay.getStatus() });
                break;

            default:
                // Not an API route
                return false;
        }
        return true;
    } catch (error) {
        console.error(`API error: ${error.message}`);
        sendJson(res, { error: error.message }, 500);
        return true;
    }
}

/**
 * Main request handler
 */
async function requestHandler(req, res) {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    let pathname = url.pathname;

    // Handle Ingress path prefix - HA strips it but some requests may include it
    // The ingress path is typically /api/hassio_ingress/<token>/
    if (pathname.includes('/api/hassio_ingress/')) {
        const parts = pathname.split('/');
        const ingressIndex = parts.findIndex(p => p === 'hassio_ingress');
        if (ingressIndex !== -1 && parts.length > ingressIndex + 2) {
            pathname = '/' + parts.slice(ingressIndex + 2).join('/');
        }
    }

    console.log(`${req.method} ${pathname}`);

    // Try API routes first (temporarily normalize the URL for routing)
    const originalUrl = req.url;
    req.url = pathname + url.search;
    let isApi;
    try {
        isApi = await handleApi(req, res);
    } finally {
        req.url = originalUrl;
    }
    if (isApi) return;

    // Serve static files for everything else
    serveStatic(res, pathname);
}

// Create and start server
const server = http.createServer(requestHandler);

// Initialize WebSocket server (handles /ws upgrades)
wsServer.init(server);

// Connect to Home Assistant WebSocket
haWS.connect();

// Start relay immediately (auto-auth + connect)
relay.start().catch((err) => {
    console.error(`[relay] Failed to start: ${err.message}`);
});

// Forward state changes to relay if connected
haWS.on('state_changed', (data) => {
    relay.forwardStateChange(data);
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`[royaframe_bridge] listening on 0.0.0.0:${PORT}`);
    console.log(`[royaframe_bridge] WebSocket endpoint: /ws`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('Shutting down...');
    relay.stop();
    haWS.close();
    wsServer.close();
    server.close(() => process.exit(0));
});
