# RoyaFrame Bridge

A Home Assistant add-on that provides a local bridge between Home Assistant and RoyaFrame.

**Phase-1 is local-only. Remote access will be added in Phase-2.**

## What This Add-on Does

RoyaFrame Bridge runs as a Home Assistant add-on and provides:

- A web interface accessible via Home Assistant Ingress (sidebar)
- API endpoints to query Home Assistant entities and status
- Foundation for future RoyaFrame cloud integration

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

After installation, access RoyaFrame Bridge from the Home Assistant sidebar. The web interface shows:

- **Bridge Status**: Whether the bridge server is running
- **Home Assistant Status**: Connection to the HA API
- **Load Entities**: View all entities and their current states

## API Endpoints

The bridge exposes these endpoints (accessible via Ingress):

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Bridge health status |
| `GET /ha/status` | Home Assistant connection status |
| `GET /ha/info` | Home Assistant configuration info |
| `GET /ha/entities` | List all entities with states |

## Architecture

```
┌─────────────────────────────────────────────┐
│              Home Assistant                  │
│  ┌────────────────────────────────────────┐ │
│  │            Ingress Proxy               │ │
│  └──────────────────┬─────────────────────┘ │
│                     │                        │
│  ┌──────────────────▼─────────────────────┐ │
│  │         RoyaFrame Bridge Add-on        │ │
│  │  ┌─────────────────────────────────┐   │ │
│  │  │      Node.js Bridge Server      │   │ │
│  │  │   - Serves Web UI               │   │ │
│  │  │   - Provides API endpoints      │   │ │
│  │  └───────────────┬─────────────────┘   │ │
│  └──────────────────┼─────────────────────┘ │
│                     │                        │
│  ┌──────────────────▼─────────────────────┐ │
│  │        Supervisor API Proxy            │ │
│  │     (http://supervisor/core/api)       │ │
│  └────────────────────────────────────────┘ │
└─────────────────────────────────────────────┘
```

## Supported Platforms

- Home Assistant OS
- Home Assistant Supervised
- Architectures: `amd64`, `aarch64`

## Development

### Local Testing

```bash
cd addon/bridge
npm install
SUPERVISOR_TOKEN=your_token node src/server.js
```

### Project Structure

```
royaframe-ha-bridge/
├── addon/
│   ├── config.yaml          # Add-on configuration
│   ├── Dockerfile           # Container build
│   ├── bridge/
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── server.js    # Main HTTP server
│   │   │   └── ha.js        # HA API client
│   │   └── public/
│   │       ├── index.html   # Web UI
│   │       └── app.js       # UI logic
│   └── rootfs/
│       └── etc/services.d/  # s6-overlay services
└── README.md
```

## Roadmap

- **Phase-1** (current): Local-only bridge via Ingress
- **Phase-2**: Cloud tunnel for remote access
- **Phase-3**: RoyaFrame app integration

## License

MIT
