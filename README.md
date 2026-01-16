# RoyaFrame Bridge

A Home Assistant add-on that provides a bridge between Home Assistant and RoyaFrame with real-time WebSocket streaming and optional secure remote access.

## What This Add-on Does

RoyaFrame Bridge runs as a Home Assistant add-on and provides:

- A web interface accessible via Home Assistant Ingress (sidebar)
- REST API endpoints to query Home Assistant entities and status
- WebSocket endpoint (`/ws`) for real-time state updates
- Optional secure remote access via outbound relay connection (no open ports required)

## Installation

### Add Custom Repository

1. Open Home Assistant
2. Go to **Settings** → **Add-ons** → **Add-on Store**
3. Click the three dots (⋮) in the top right corner
4. Select **Repositories**
5. Add this repository URL:
   ```
   https://github.com/YOUR_USERNAME/royaframe-ha-bridge
   ```
6. Click **Add** → **Close**

### Install the Add-on

1. Find **RoyaFrame Bridge** in the add-on store
2. Click **Install**
3. Wait for the installation to complete
4. Click **Start**
5. Enable **Show in sidebar** for easy access

## Usage

### Local Mode (Default)

After installation, access RoyaFrame Bridge from the Home Assistant sidebar. The web interface shows:

- **Bridge Status**: Server running, HA REST/WebSocket connections
- **WebSocket Clients**: Number of connected local clients
- **Remote Access**: Pairing status (if configured)
- **Entities**: View all entities with live updates

Connect to the WebSocket endpoint at `/ws` for real-time state updates:

```javascript
// Example: Connect from browser
const ws = new WebSocket('ws://your-ha-host:8099/ws');

ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'state_changed') {
        console.log('Entity changed:', msg.data.entity_id, msg.data.new_state.state);
    }
};

// Call a service
ws.send(JSON.stringify({
    type: 'call_service',
    domain: 'light',
    service: 'turn_on',
    data: { brightness: 255 },
    target: { entity_id: 'light.living_room' }
}));
```

### Pairing Mode (Remote Access)

To enable secure remote access from the RoyaFrame app:

1. Configure add-on options with `relay_url` and `relay_token` (provided by RoyaFrame)
2. Open the bridge UI in Home Assistant
3. Click **Generate Pair Code** in the Remote Access section
4. Enter the 6-character code in the RoyaFrame app
5. Once paired, the connection is established and the code is invalidated

Remote access is **outbound only** - no ports need to be opened on your network.

## API Endpoints

### REST Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Bridge health status with WebSocket info |
| `/ha/status` | GET | Home Assistant connection status |
| `/ha/info` | GET | Home Assistant configuration info |
| `/ha/entities` | GET | List all entities with states |
| `/ws/status` | GET | WebSocket server status |
| `/relay/status` | GET | Relay connection status |
| `/relay/pair` | POST | Start pairing mode (optional: `{pair_code}`) |
| `/relay/stop` | POST | Stop relay connection |

### WebSocket Protocol (`/ws`)

**Outbound messages (server to client):**

```json
// Connection status
{"type": "connection_status", "connected": true}

// State change event
{"type": "state_changed", "data": {"entity_id": "light.living_room", "new_state": {...}, "old_state": {...}}}

// Response to request
{"type": "service_result", "id": 1, "success": true, "result": {...}}
{"type": "states", "id": 2, "data": [...]}
{"type": "error", "id": 3, "error": "message"}
{"type": "pong", "id": 4}
```

**Inbound messages (client to server):**

```json
// Call a Home Assistant service
{"type": "call_service", "id": 1, "domain": "light", "service": "turn_on", "data": {"brightness": 255}, "target": {"entity_id": "light.living_room"}}

// Get all entity states
{"type": "get_states", "id": 2}

// Ping/pong for keepalive
{"type": "ping", "id": 3}
```

## Architecture

```
┌───────────────────────────────────────────────────────────────────┐
│                      Home Assistant                                │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │                    Ingress Proxy                             │  │
│  └────────────────────────┬────────────────────────────────────┘  │
│                           │                                        │
│  ┌────────────────────────▼────────────────────────────────────┐  │
│  │              RoyaFrame Bridge Add-on                         │  │
│  │  ┌───────────────────────────────────────────────────────┐  │  │
│  │  │              Node.js Bridge Server                     │  │  │
│  │  │  ┌─────────────┐  ┌─────────────┐  ┌──────────────┐   │  │  │
│  │  │  │ HTTP Server │  │  WS Server  │  │ Relay Client │   │  │  │
│  │  │  │  (REST API) │  │    (/ws)    │  │  (outbound)  │   │  │  │
│  │  │  └─────────────┘  └─────────────┘  └──────────────┘   │  │  │
│  │  │            │              │               │            │  │  │
│  │  │            └──────────────┼───────────────┘            │  │  │
│  │  │                           │                            │  │  │
│  │  │                 ┌─────────▼─────────┐                  │  │  │
│  │  │                 │   HA WS Client    │                  │  │  │
│  │  │                 │ (state_changed)   │                  │  │  │
│  │  │                 └─────────┬─────────┘                  │  │  │
│  │  └───────────────────────────┼───────────────────────────┘  │  │
│  └──────────────────────────────┼──────────────────────────────┘  │
│                                 │                                  │
│  ┌──────────────────────────────▼──────────────────────────────┐  │
│  │   Supervisor (REST: http://supervisor/core/api)              │  │
│  │              (WS: ws://supervisor/core/api/websocket)        │  │
│  └──────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────┘
                                  │
                                  │ (optional outbound)
                                  ▼
                    ┌─────────────────────────┐
                    │    RoyaFrame Relay      │
                    │      (cloud)            │
                    └─────────────────────────┘
```

## Supported Platforms

- Home Assistant OS
- Home Assistant Supervised
- Architectures: `amd64`, `aarch64`

## Development

### Local Testing

```bash
cd royaframe_bridge/bridge
npm install
SUPERVISOR_TOKEN=your_token node src/server.js
```

### Project Structure

```
royaframe-ha-bridge/
└── royaframe_bridge/
    ├── config.yaml           # Add-on configuration
    ├── Dockerfile            # Container build
    ├── build.yaml            # Build base images
    ├── bridge/
    │   ├── package.json
    │   ├── src/
    │   │   ├── server.js     # Main HTTP server + routing
    │   │   ├── ha.js         # HA REST API client
    │   │   ├── haWebSocket.js # HA WebSocket client
    │   │   ├── wsServer.js   # Local WebSocket server
    │   │   └── relay.js      # Optional relay client
    │   └── public/
    │       ├── index.html    # Web UI
    │       └── app.js        # UI logic
    └── rootfs/
        └── etc/services.d/   # s6-overlay services
```

## Smoke Test Checklist

After installing/updating the add-on, verify:

1. **Health Check**
   - Open bridge UI from HA sidebar
   - Verify "Bridge Server" shows green "Running"
   - Verify "Home Assistant REST" shows green "Connected"
   - Verify "Home Assistant WebSocket" shows green "Connected"

2. **Entity Loading**
   - Click "Load Entities"
   - Verify entities appear with current states
   - Change an entity state in HA (e.g., toggle a light)
   - Verify the entity state updates in the bridge UI (live)

3. **WebSocket Endpoint**
   - Use browser devtools or wscat to connect to `/ws`
   - Verify you receive `connection_status` message
   - Verify you receive `state_changed` messages when entities change

4. **REST API**
   ```bash
   # From within HA network or via Ingress
   curl http://localhost:8099/health
   curl http://localhost:8099/ha/entities
   curl http://localhost:8099/ws/status
   ```

5. **Relay Mode** (if configured)
   - Click "Generate Pair Code"
   - Verify 6-character code appears
   - Verify relay status shows "Connected" then "Registered"

## Roadmap

- **Phase-1**: Local bridge via Ingress with REST API
- **Phase-2** (current): WebSocket streaming + optional relay pairing
- **Phase-3**: Full RoyaFrame app integration

## License

MIT
