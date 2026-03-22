# Infrastructure

The add-on container, persistent storage, MQTT connection management, SQLite logging, health entities, and backup integration.

## Add-on Container

### Dockerfile

Node.js LTS runtime in a Docker container. Currently built for `amd64` only.

Key layers:
- Base image: Node.js LTS Alpine.
- Runtime dependencies: `npm`, `esbuild`, `typescript` (for tsc diagnostics).
- Application code: `dist/` directory with compiled runtime.
- Entry point: `run.sh` (or direct `node dist/runtime.js`).

### config.yaml

```yaml
name: HA Forge
description: Define Home Assistant entities in TypeScript
slug: ha_forge
url: https://github.com/craig-b/ha-forge
arch:
  - amd64
init: false
homeassistant_api: true
map:
  - addon_config:rw
services:
  - mqtt:want
ingress: true
ingress_port: 8099
ingress_entry: /
panel_icon: mdi:language-typescript
panel_title: HA Forge
options:
  log_level: info
  log_retention_days: 7
  validation_schedule_minutes: 60
  auto_build_on_save: false
  auto_rebuild_on_registry_change: false
  mqtt_host: ""
  mqtt_port: 1883
  mqtt_username: ""
  mqtt_password: ""
schema:
  log_level: list(debug|info|warn|error)
  log_retention_days: int
  validation_schedule_minutes: int
  auto_build_on_save: bool
  auto_rebuild_on_registry_change: bool
  mqtt_host: str?
  mqtt_port: port?
  mqtt_username: str?
  mqtt_password: str?
```

Key configuration choices:

- **`homeassistant_api: true`**: Grants access to HA's WebSocket API via `ws://supervisor/core/websocket` and REST API via `http://supervisor/core/api/`, authenticated with the `SUPERVISOR_TOKEN` environment variable.
- **`map: [addon_config:rw]`**: Maps `/addon_configs/ha_forge/` on the host to `/config/` in the container. This is where user scripts, `package.json`, `node_modules/`, and `.generated/` live. Automatically included in HA backups.
- **`services: [mqtt:want]`**: Declares MQTT as an optional (but expected) service. The add-on starts even if Mosquitto is unavailable and will connect when the broker becomes reachable. MQTT credentials obtained via `GET http://supervisor/services/mqtt` or manual config options.
- **`ingress: true`**: Web UI proxied through HA's ingress gateway. No exposed ports.
- **`init: false`**: We manage our own process lifecycle (no s6-overlay).

### Filesystem Layout

```
Container:
/config/                    ← addon_config mapping (user scripts)
├── *.ts                    ← User TypeScript files
├── package.json            ← npm dependencies
├── tsconfig.json           ← TypeScript config (scaffolded)
├── node_modules/           ← npm packages
└── .generated/             ← Generated types + validators
    ├── ha-registry.d.ts
    ├── ha-validators.ts
    ├── ha-registry-meta.json
    ├── ha-completion-registry.json
    └── sdk/                ← SDK type declarations (symlinked)

/data/                      ← Persistent add-on storage
├── logs.db                 ← SQLite log database
├── last-build/             ← Cached last successful build
│   └── *.js                ← Bundled JS files
└── options.json            ← Add-on configuration

/dist/                      ← Application code (in image)
├── runtime.js
├── build/
├── transports/
├── sdk/
├── logging/
└── web/
```

### Startup Sequence

1. Read add-on options from `/data/options.json`.
2. Connect to MQTT broker (credentials from `GET http://supervisor/services/mqtt`).
3. Configure MQTT LWT: publish `offline` to `ha-forge/availability` on unexpected disconnect.
4. Publish `online` to `ha-forge/availability`.
5. Connect to HA WebSocket API (`ws://supervisor/core/websocket`, auth via `SUPERVISOR_TOKEN`).
6. Start web server on ingress port (8099).
7. If `/data/last-build/` exists, load cached build (fast startup without recompilation).
8. Start scheduled validation timer.
9. Subscribe to `homeassistant/status` MQTT topic — when HA publishes `online` (after restart), re-publish all discovery messages.

## MQTT Connection Manager

### Credential Retrieval

MQTT credentials are obtained from the Supervisor API by default, or from the manual `mqtt_host`/`mqtt_port`/`mqtt_username`/`mqtt_password` add-on options when set:

```
GET http://supervisor/services/mqtt
Authorization: Bearer ${SUPERVISOR_TOKEN}

Response:
{
  "host": "core-mosquitto",
  "port": 1883,
  "ssl": false,
  "username": "addons",
  "password": "..."
  "protocol": "3.1.1"
}
```

### Connection Lifecycle

1. Connect to MQTT broker with credentials + LWT configuration.
2. Subscribe to `homeassistant/status` (HA birth topic).
3. Publish `online` to `ha-forge/availability` (retained).
4. On unexpected disconnect: LWT fires, HA marks entities unavailable.
5. Reconnect with a fixed 1-second interval (`reconnectPeriod: 1000`).
6. On reconnect: re-publish `online` to availability topic. Re-publish all discovery messages. Re-publish current state for all entities.
7. On `homeassistant/status` = `online`: HA has restarted. Re-publish all discovery messages (HA lost them).

### Topic Namespace

All MQTT topics prefixed with `ha-forge/` to avoid collisions:

```
ha-forge/
├── availability                              # Global LWT
├── <entity_id>/state                         # State per entity
├── <entity_id>/set                           # Command per entity
homeassistant/device/<device_id>/config       # Discovery (HA namespace)
```

## SQLite Logging

### Schema

```sql
CREATE TABLE logs (
  id INTEGER PRIMARY KEY,
  timestamp INTEGER NOT NULL,          -- unix milliseconds
  level TEXT NOT NULL,                  -- debug, info, warn, error
  source_file TEXT NOT NULL,            -- user .ts filename or '_runtime'
  entity_id TEXT,                       -- null for file-level or system logs
  message TEXT NOT NULL,
  data TEXT,                            -- JSON blob for structured context
  caller TEXT                           -- caller location, e.g. "weather.ts:15"
);

CREATE INDEX idx_logs_time ON logs(timestamp);
CREATE INDEX idx_logs_entity ON logs(entity_id, timestamp);
CREATE INDEX idx_logs_level ON logs(level, timestamp);
CREATE INDEX idx_logs_file ON logs(source_file, timestamp);
```

### How Logging Works

- `this.log.*` in entity context writes to SQLite, auto-tagged with `entity_id` and `source_file`.
- Runtime system events (MQTT connection, build results, lifecycle events) logged with `source_file: '_runtime'` and `entity_id: null`.
- Structured data (stack traces, state snapshots, command payloads) stored in the `data` JSON column as serialized JSON.
- Writes are batched (every 100ms or 50 entries, whichever comes first) to avoid SQLite write contention.

### Retention

- Configurable max age via `log_retention_days` add-on option (default: 7 days).
- Cleanup runs on startup and every 6 hours.
- `DELETE FROM logs WHERE timestamp < ?` with the cutoff timestamp.
- SQLite `VACUUM` runs after cleanup to reclaim disk space.

### Query API

The web UI's log viewer queries via REST:

```
GET /api/logs?entity_id=backyard_temp&level=warn,error&since=1705312200000&limit=100
```

Parameters:
- `entity_id` — filter by entity
- `source_file` — filter by file
- `level` — comma-separated levels
- `since` / `until` — timestamp range (unix ms)
- `search` — text search in message and data
- `limit` / `offset` — pagination

Real-time tailing via WebSocket. The add-on pushes new rows to connected clients as they're written.

## Health Entities

The runtime dogfoods its own system by registering health entities via MQTT discovery:

### binary_sensor.ha_forge_build_healthy

```
state: on | off     (device_class: problem)
  on  = build errors found (problem detected)
  off = all scripts compile cleanly (no problem)
```

### sensor.ha_forge_type_errors

```
state: <error count as integer>
attributes:
  errors: [
    {
      file: 'garage-door.ts',
      line: 14,
      column: 8,
      message: "Property 'old_entity' does not exist on type 'HAEntityId'"
    }
  ]
  last_checked: ISO timestamp
  check_trigger: 'scheduled' | 'registry_change' | 'build'
```

### HA Automation Example

Users can automate on health entity state changes:

```yaml
trigger:
  - platform: state
    entity_id: binary_sensor.ha_forge_build_healthy
    to: 'off'
action:
  - service: notify.mobile_app
    data:
      title: "HA Forge: Build Broken"
      message: >
        {{ state_attr('sensor.ha_forge_type_errors', 'errors') | length }}
        type error(s) detected after HA registry change.
```

### When Health Entities Update

- After every scheduled validation run (default: hourly).
- After registry change events (if subscribed).
- After each build (validation runs as part of the pipeline).

## Backup Integration

### What's Included Automatically

Since we use `addon_config` mapping, the scripts directory (`/addon_configs/ha_forge/`) is automatically included when the user backs up this add-on in HA's built-in backup system. This covers:

- All user `.ts` files.
- `package.json` and `tsconfig.json`.
- `.generated/` types (can be regenerated, but included for convenience).

### What's in /data/ (Separate)

The `/data/` volume is included in add-on backups if selected:

- `logs.db` — SQLite log database.
- `last-build/` — cached build output.
- `options.json` — add-on configuration.

### What's Excluded

- `node_modules/` — regenerated via `npm install`. Can be large. The `.gitignore`/backup exclusion pattern should skip this directory. If the backup system doesn't support exclusion within `addon_config`, document that `npm install` runs on first build after restore.

## Supervisor API Usage

Summary of Supervisor API endpoints used by the add-on:

| Endpoint | When | Purpose |
|---|---|---|
| `GET /services/mqtt` | Startup | Get MQTT broker credentials |
| `GET /core/websocket` (WebSocket) | Startup + ongoing | HA WebSocket API for type generation, state subscriptions, service calls |
| `GET /addons/self/info` | Startup | Read add-on metadata, version |
| `GET /info` | Startup | System info (HA version, arch) for origin field in MQTT discovery |

All authenticated via `Authorization: Bearer ${SUPERVISOR_TOKEN}`.
