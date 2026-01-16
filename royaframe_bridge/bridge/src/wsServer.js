/**
 * Local WebSocket Server
 * Handles /ws endpoint for local clients to receive state updates
 * and send commands to Home Assistant.
 */

const WebSocket = require('ws');
const haWS = require('./haWebSocket');

class WSServer {
    constructor() {
        this.wss = null;
        this.clients = new Set();
    }

    /**
     * Initialize WebSocket server on an existing HTTP server
     * @param {http.Server} httpServer - The HTTP server to attach to
     */
    init(httpServer) {
        this.wss = new WebSocket.Server({ noServer: true });

        // Handle upgrade requests from HTTP server
        httpServer.on('upgrade', (request, socket, head) => {
            const url = new URL(request.url, `http://localhost`);
            let pathname = url.pathname;

            // Strip ingress prefix if present
            if (pathname.includes('/api/hassio_ingress/')) {
                const parts = pathname.split('/');
                const ingressIndex = parts.findIndex(p => p === 'hassio_ingress');
                if (ingressIndex !== -1 && parts.length > ingressIndex + 2) {
                    pathname = '/' + parts.slice(ingressIndex + 2).join('/');
                }
            }

            if (pathname === '/ws') {
                this.wss.handleUpgrade(request, socket, head, (ws) => {
                    this.wss.emit('connection', ws, request);
                });
            } else {
                socket.destroy();
            }
        });

        // Handle new connections
        this.wss.on('connection', (ws, request) => {
            console.log('[wsServer] Client connected');
            this.clients.add(ws);

            // Send current connection status
            ws.send(JSON.stringify({
                type: 'connection_status',
                connected: haWS.isConnected()
            }));

            // Handle incoming messages
            ws.on('message', (data) => {
                this.handleClientMessage(ws, data);
            });

            ws.on('close', () => {
                console.log('[wsServer] Client disconnected');
                this.clients.delete(ws);
            });

            ws.on('error', (err) => {
                console.error('[wsServer] Client error:', err.message);
                this.clients.delete(ws);
            });
        });

        // Forward state_changed events from HA to all clients
        haWS.on('state_changed', (data) => {
            this.broadcast({
                type: 'state_changed',
                data
            });
        });

        // Notify clients of HA connection status changes
        haWS.on('connected', () => {
            this.broadcast({ type: 'connection_status', connected: true });
        });

        haWS.on('disconnected', () => {
            this.broadcast({ type: 'connection_status', connected: false });
        });

        console.log('[wsServer] WebSocket server initialized on /ws');
    }

    /**
     * Handle message from a client
     */
    async handleClientMessage(ws, data) {
        let msg;
        try {
            msg = JSON.parse(data.toString());
        } catch (err) {
            this.sendError(ws, 'Invalid JSON');
            return;
        }

        const requestId = msg.id; // Optional request ID for response correlation

        try {
            switch (msg.type) {
                case 'call_service':
                    if (!msg.domain || !msg.service) {
                        this.sendError(ws, 'Missing domain or service', requestId);
                        return;
                    }
                    const result = await haWS.callService(
                        msg.domain,
                        msg.service,
                        msg.data || {},
                        msg.target || {}
                    );
                    this.sendResponse(ws, {
                        type: 'service_result',
                        success: true,
                        result
                    }, requestId);
                    break;

                case 'get_states':
                    const states = await haWS.request({ type: 'get_states' });
                    this.sendResponse(ws, {
                        type: 'states',
                        data: states
                    }, requestId);
                    break;

                case 'ping':
                    this.sendResponse(ws, { type: 'pong' }, requestId);
                    break;

                default:
                    this.sendError(ws, `Unknown message type: ${msg.type}`, requestId);
            }
        } catch (err) {
            this.sendError(ws, err.message, requestId);
        }
    }

    /**
     * Send a response to a specific client
     */
    sendResponse(ws, msg, requestId) {
        if (ws.readyState === WebSocket.OPEN) {
            const response = requestId !== undefined ? { ...msg, id: requestId } : msg;
            ws.send(JSON.stringify(response));
        }
    }

    /**
     * Send an error to a specific client
     */
    sendError(ws, message, requestId) {
        this.sendResponse(ws, {
            type: 'error',
            error: message
        }, requestId);
    }

    /**
     * Broadcast a message to all connected clients
     */
    broadcast(msg) {
        const data = JSON.stringify(msg);
        for (const client of this.clients) {
            if (client.readyState === WebSocket.OPEN) {
                client.send(data);
            }
        }
    }

    /**
     * Get number of connected clients
     */
    getClientCount() {
        return this.clients.size;
    }

    /**
     * Close all connections
     */
    close() {
        for (const client of this.clients) {
            client.close();
        }
        this.clients.clear();
        if (this.wss) {
            this.wss.close();
        }
    }
}

// Export singleton instance
const wsServer = new WSServer();
module.exports = wsServer;
