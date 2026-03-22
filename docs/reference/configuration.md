# Configuration Reference

---

## Add-on Options

Configured in the HA Supervisor UI under the HA Forge add-on settings. Stored in the add-on's `config.yaml`.

| Option | Type | Default | Description |
|---|---|---|---|
| `log_level` | `'debug' \| 'info' \| 'warn' \| 'error'` | `'info'` | Minimum log level for SQLite storage and the web UI log viewer. `debug` is verbose; `error` is quietest. |
| `log_retention_days` | `int` | `7` | Maximum age in days for log entries. Cleanup runs on startup and periodically. |
| `validation_schedule_minutes` | `int` | `60` | Interval in minutes for scheduled type validation. The runtime re-checks user scripts against the current HA registry to detect drift (renamed entities, removed helpers, etc.). |
| `auto_build_on_save` | `bool` | `false` | When enabled, file changes in `/config/` trigger an automatic build after a 500ms debounce. Does not watch `package.json` changes. |
| `auto_rebuild_on_registry_change` | `bool` | `false` | When enabled, if scheduled validation passes with new types, automatically trigger a full build and deploy. If validation fails, keep the old build running and flip the health sensor to unhealthy. |
| `mqtt_host` | `str?` | `""` | MQTT broker hostname. When empty, credentials are obtained from the HA Supervisor API. Set this for manual MQTT configuration. |
| `mqtt_port` | `port?` | `1883` | MQTT broker port. |
| `mqtt_username` | `str?` | `""` | MQTT broker username. When empty, uses Supervisor-provided credentials. |
| `mqtt_password` | `str?` | `""` | MQTT broker password. When empty, uses Supervisor-provided credentials. |

**Add-on metadata (config.yaml):**

```yaml
name: HA Forge
slug: ha_forge
arch: [amd64]
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
```

### Supervisor API Usage

The add-on uses the HA Supervisor API for the following:

| Endpoint | Purpose |
|---|---|
| `GET /services/mqtt` | Obtain MQTT broker credentials (host, port, username, password) when manual MQTT options are not set. |
| Supervisor WebSocket proxy | Proxied connection to HA WebSocket API (`/api/websocket`). Used for entity registry introspection, state subscriptions, service calls, and event bus access. |
| Ingress proxy | HA ingress system proxies the web UI through HA authentication. No exposed ports. |

---

## tsconfig.json

Scaffolded on first run if absent. Located in the scripts directory (`/config/`).

**Default scaffolded config:**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "types": [],
    "paths": {
      "ha-forge": ["./.generated/sdk"]
    }
  },
  "include": ["*.ts", "**/*.ts", ".generated/**/*.d.ts"]
}
```

**Common modifications:**

| Setting | Purpose |
|---|---|
| `"strict": false` | Relax strict type checking (not recommended — reduces type safety). |
| `"noUnusedLocals": true` | Error on unused local variables. |
| `"noUnusedParameters": true` | Error on unused function parameters. |
| Additional `"paths"` entries | Map custom module aliases for shared utility modules. |
| `"exclude"` | Exclude specific files or directories from type checking. |

The `tsc --noEmit` step during the build uses this config. esbuild ignores it (esbuild does its own transpilation).

---

## package.json

Located in the scripts directory (`/config/`). Scaffolded on first run if absent.

**Default scaffolded config:**

```json
{
  "name": "user-scripts",
  "version": "1.0.0",
  "dependencies": {}
}
```

**Dependency management:**

- Dependencies are added via the web UI packages panel or by editing `package.json` directly.
- When `package.json` has changed since the last build, `npm install` runs as the first step of the build pipeline.
- esbuild bundles user code with all dependencies into self-contained output. No runtime module resolution is needed in the deployed bundle.
- After `npm install`, `.d.ts` files from `node_modules/` are scanned and injected into Monaco via `addExtraLib()` for editor autocomplete.
- `@types/*` packages are handled automatically.

---

## Filesystem Layout

### Container paths

```
/config/                          # addon_config mapped directory (user-writable)
  ├── *.ts                        # User TypeScript scripts
  ├── **/*.ts                     # Scripts in subdirectories
  ├── package.json                # npm dependencies (scaffolded on first run)
  ├── tsconfig.json               # TypeScript config (scaffolded on first run)
  ├── node_modules/               # Installed npm packages
  └── .generated/                 # Generated types (written by build pipeline)
      ├── ha-registry.d.ts        # Typed entity map, services, attributes
      ├── ha-validators.ts        # Runtime validation functions
      ├── ha-registry-meta.json   # Generation metadata (timestamps, counts)
      ├── ha-completion-registry.json  # Monaco autocomplete data
      └── sdk/                    # SDK type declarations (symlinked)

/data/                            # Persistent add-on data directory
  ├── logs.db                     # SQLite log database
  └── last-build/                 # Cached last successful build bundle
      └── *.js                    # Bundled JavaScript output

/app/                             # Add-on application code (read-only)
  ├── dist/                       # Compiled runtime
  ├── node_modules/               # Runtime dependencies
  └── package.json                # Runtime package manifest
```

### Key directory notes

- **`/config/`** — Maps to the HA `addon_config` directory. Included in HA's built-in backup system. Contains all user-authored files.
- **`/data/`** — Persistent across add-on restarts and updates. Contains the SQLite log database and cached build output. Included in backup when the add-on is selected.
- **`/config/node_modules/`** — Can be excluded from backup (regenerated via `npm install`).
- **`/config/.generated/`** — Regenerated on each build or manual type regeneration. Safe to delete (will be recreated).

---

## MQTT Topics

All MQTT communication uses the `ha-forge/` prefix for entity state/command topics and the standard `homeassistant/` prefix for MQTT discovery.

### Topic structure

| Topic | Direction | Retain | Description |
|---|---|---|---|
| `ha-forge/availability` | Publish | Yes | Add-on availability. LWT set to `offline` on connect. Publishes `online` on startup, `offline` on shutdown/crash. All entities reference this as their availability topic. |
| `ha-forge/<entity_id>/state` | Publish | Yes | Entity state. Published on `this.update()`. Payload format depends on entity type (string, JSON object for complex entities like climate/light). |
| `ha-forge/<entity_id>/set` | Subscribe | No | Entity command topic. HA publishes commands here when users interact with bidirectional entities. |
| `homeassistant/<component>/<entity_id>/config` | Publish | Yes | MQTT discovery config. Published on entity registration. Empty payload published on deregistration to remove the entity. Uses `device` format: `homeassistant/device/<node_id>/config`. |
| `homeassistant/status` | Subscribe | No | HA birth/will topic. When HA restarts (publishes `online`), the runtime re-publishes all discovery configs and current states to re-register entities. |

### Discovery payload format

Discovery payloads use the device-based MQTT discovery format. Each entity includes:

- `device` block with identifiers, name, manufacturer, model, sw_version.
- `availability` referencing `ha-forge/availability`.
- `state_topic` and optionally `command_topic`.
- Platform-specific fields (e.g., `device_class`, `unit_of_measurement`, `options`).
- `unique_id` and `default_entity_id` (not the deprecated `object_id`).

### HA status topic

The runtime subscribes to `homeassistant/status`. When HA restarts and publishes `online`, the runtime:

1. Re-publishes all discovery configs (retained) so HA re-creates the entities.
2. Re-publishes all current entity states.

This ensures entities survive HA restarts without requiring an add-on restart.

---

## REST API Endpoints

The web server runs on port 8099 (ingress-proxied through HA authentication). All endpoints are prefixed with the ingress base path.

### Files

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/files` | List all files in the scripts directory. Returns a tree structure. Skips `node_modules/` and hidden directories. |
| `GET` | `/api/files/:path` | Read file contents. Returns `{ path, content }`. |
| `PUT` | `/api/files/:path` | Write file contents. Body: `{ content: string }`. Creates parent directories as needed. |
| `PATCH` | `/api/files/:path` | Rename/move file. Body: `{ newPath: string }`. Returns 409 if target exists. |
| `DELETE` | `/api/files/:path` | Delete file. Returns 404 if not found. |

All file paths are resolved safely to prevent directory traversal attacks.

### Build

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/build` | Trigger a build. Returns build status with step details, diagnostics, and entity count. |
| `GET` | `/api/build/status` | Get current build status without triggering a build. |

**Build status response:**

```ts
interface BuildStatusResponse {
  building: boolean;
  lastBuild: {
    success: boolean;
    timestamp: string;
    totalDuration: number;
    steps: Array<{
      step: string;
      success: boolean;
      duration: number;
      error?: string;
      diagnostics?: Array<{
        file: string;
        line: number;
        column: number;
        code: number;
        message: string;
        severity: 'error' | 'warning';
      }>;
    }>;
    typeErrors: number;
    bundleErrors: number;
    entityCount: number;
  } | null;
}
```

### Entities

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/entities` | List all registered entities with current state, source file, and health status. |

**Entity info:**

```ts
interface EntityInfo {
  id: string;
  name: string;
  type: string;
  state: unknown;
  sourceFile: string;
  status: 'healthy' | 'error' | 'unavailable';
  unit_of_measurement?: string;
}
```

### Logs

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/logs` | Query log entries with filtering and pagination. |
| `GET` | `/api/logs/entities` | List distinct entity IDs that have log entries. |

### Packages

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/packages` | List installed npm packages (`dependencies` and `devDependencies`). |
| `POST` | `/api/packages` | Add a package. Body: `{ name: string, version?: string, dev?: boolean }`. |
| `DELETE` | `/api/packages/:name` | Remove a package. |

### Types

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/types/status` | Get type generation metadata (entity/service counts, timestamp). |
| `GET` | `/api/types/completion-registry` | Get the Monaco completion registry (entity IDs, services for autocomplete). |
| `GET` | `/api/types/sdk` | Get self-contained SDK type declarations for Monaco `addExtraLib()`. |
| `POST` | `/api/types/regenerate` | Trigger type regeneration from the current HA registry. Returns `{ success, entityCount, serviceCount, errors }`. |

### UI

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/` | Serve the single-page web application (Monaco editor + entity dashboard + log viewer). |

---

## Log Query Parameters

Parameters for `GET /api/logs`:

| Parameter | Type | Default | Description |
|---|---|---|---|
| `entity_id` | `string` | -- | Filter by entity ID. Comma-separated for multiple entities. |
| `level` | `string` | -- | Filter by log level. Supports two modes: (1) a single level acts as a minimum (e.g., `warn` returns `warn` and `error`), (2) comma-separated explicit levels (e.g., `info,error`). |
| `source_file` | `string` | -- | Filter by source file name. |
| `since` | `number` | -- | Unix timestamp (ms). Only return entries after this time. |
| `until` | `number` | -- | Unix timestamp (ms). Only return entries before this time. |
| `search` | `string` | -- | Full-text search in message content. |
| `limit` | `number` | `100` | Maximum number of entries to return. |
| `offset` | `number` | `0` | Number of entries to skip (pagination). |

**Response:**

```json
{
  "logs": [
    {
      "id": 1,
      "timestamp": 1711234567890,
      "level": "info",
      "entity_id": "sensor.cpu_temp",
      "source_file": "system-monitor.ts",
      "message": "Entity initialized",
      "data": null,
      "caller": null
    }
  ],
  "count": 1
}
```

**Log entry fields:**

| Field | Type | Description |
|---|---|---|
| `id` | `number` | Auto-incrementing row ID. |
| `timestamp` | `number` | Unix timestamp in milliseconds. |
| `level` | `'debug' \| 'info' \| 'warn' \| 'error'` | Log severity level. |
| `entity_id` | `string \| null` | Entity ID that produced the log. `null` for system/file-level logs. |
| `source_file` | `string \| null` | Source `.ts` file name. `'_runtime'` for system logs. |
| `message` | `string` | Log message text. |
| `data` | `string \| null` | JSON-serialized structured data (stack traces, state snapshots, etc.). |
| `caller` | `string \| null` | Caller context information. |

---

## WebSocket Channels

The web UI connects to a WebSocket endpoint for real-time updates. The `WSHub` manages three channels:

| Channel | Events | Description |
|---|---|---|
| `build` | Build progress, completion, errors | Real-time build pipeline output. Broadcasts step completion, diagnostics, and final result. |
| `entities` | State changes, registration, deregistration | Live entity state updates. Broadcasts when entities are registered, removed, or change state. |
| `logs` | New log entries | Real-time log tailing. Broadcasts each new log entry as it is written to SQLite. |

**WebSocket message format:**

```ts
interface WSMessage {
  channel: 'build' | 'entities' | 'logs';
  event: string;
  data: unknown;
}
```

Messages are JSON-serialized. Clients subscribe to a channel and receive all messages for that channel.

---

## SQLite Schema

The log database (`/data/logs.db`) uses the following schema:

```sql
CREATE TABLE logs (
  id INTEGER PRIMARY KEY,
  timestamp INTEGER NOT NULL,         -- unix ms
  level TEXT NOT NULL,                 -- debug, info, warn, error
  source_file TEXT NOT NULL,           -- user .ts filename or '_runtime'
  entity_id TEXT,                      -- null for file-level or system logs
  message TEXT NOT NULL,
  data TEXT                            -- JSON blob for structured context
);

CREATE INDEX idx_logs_time ON logs(timestamp);
CREATE INDEX idx_logs_entity ON logs(entity_id, timestamp);
CREATE INDEX idx_logs_level ON logs(level, timestamp);
CREATE INDEX idx_logs_file ON logs(source_file, timestamp);
```

Retention cleanup runs on startup and periodically, deleting entries older than `log_retention_days`.

---

## Health Entities

The runtime registers its own health entities (dogfooding the system):

| Entity | Type | States | Description |
|---|---|---|---|
| `binary_sensor.ha_forge_build_healthy` | `binary_sensor` | `on` / `off` | `on` = all scripts compile cleanly against the current HA registry. `off` = type errors found. |
| `sensor.ha_forge_type_errors` | `sensor` | error count | Number of type errors in user scripts. Attributes include error details, last checked timestamp, and check trigger. |

**`sensor.ha_forge_type_errors` attributes:**

| Attribute | Type | Description |
|---|---|---|
| `errors` | `Array<{ file, line, column, message }>` | Detailed error list. |
| `last_checked` | `string` | ISO 8601 timestamp of the last validation run. |
| `check_trigger` | `'scheduled' \| 'registry_change'` | What triggered the validation. |

---

## Not Yet Implemented

The following features are planned but not yet available:

| Feature | Description |
|---|---|
| **npm dependency management UI** | Visual package search, add, and remove in the web editor. Currently, edit `package.json` directly or use the REST API. |
| **Scene, Event, Device Tracker, Camera factory functions** | MQTT discovery supports these platforms, but no SDK factory functions exist yet. Creatable via `entityFactory()` with manual discovery payloads. |
| **Native bridge transport** | Python custom integration for entity types MQTT discovery doesn't cover (media_player, calendar, weather). Communication over local WebSocket. Planned for v2. |
| **Persistent state store** | Key-value store for entity state persistence across restarts via `this.store.get()`/`this.store.set()`. Backed by SQLite. |
| **Multi-file imports** | Each user `.ts` file is self-contained. Shared code goes in npm packages or a local shared module. No cross-file imports between user scripts. |
