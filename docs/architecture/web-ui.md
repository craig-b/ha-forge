# Web UI

The web UI is an ingress-based panel accessible from the HA sidebar. It provides a Monaco code editor with full IntelliSense, an entity dashboard, log viewer, build controls, and dependency management.

## Ingress Integration

### How Ingress Works

The HA Supervisor proxies requests to the add-on's web server. The add-on listens on port 8099 (configurable via `ingress_port` in config.yaml) and must only accept connections from `172.30.32.2` — the Supervisor's ingress gateway IP.

Users are pre-authenticated by Home Assistant. The Supervisor injects headers:

| Header | Value |
|---|---|
| `X-Remote-User-Id` | HA user ID |
| `X-Remote-User-Name` | HA username |
| `X-Remote-User-Display-Name` | Display name |
| `X-Ingress-Path` | Base URL path for the add-on (e.g., `/api/hassio_ingress/abc123`) |

No auth code is needed in the web UI. All requests through ingress are already authenticated.

### URL Handling

All URLs in the web UI must be relative to `X-Ingress-Path`. The base path changes per installation and per session. The UI reads this header on load and prefixes all API calls and asset URLs accordingly.

WebSocket connections for live updates (log tailing, entity state) also go through ingress — the Supervisor supports WebSocket proxying.

## Monaco Editor

### Setup

The editor loads with the full TypeScript language service configured for the user's environment:

1. **SDK types**: The `ha-forge` module type declarations injected via `addExtraLib()`.
2. **Generated HA types**: `ha-registry.d.ts` injected via `addExtraLib()` — provides autocomplete for every entity ID, state value, attribute, and service parameter.
3. **Generated validators**: Type declarations for the validator module.
4. **npm package types**: After dependency install, `.d.ts` files from `node_modules/` injected via `addExtraLib()`.

This gives full IntelliSense (autocomplete, hover docs, error squiggles) without any manual setup by the user.

### Type Re-injection

After each type generation (build or manual trigger), the Monaco instance is updated:
- Old extra libs removed.
- New type declarations injected.
- Language service restarts to pick up changes.
- Open files are re-checked against new types.

### Diagnostic Display

tsc errors from the build pipeline are displayed as:
- Red/yellow squiggles on the affected lines in the editor.
- Entries in the build output console with file, line, column, and message.

Monaco's built-in TypeScript checking (via the language service) also runs live as the user types, providing immediate feedback before building.

### File Operations

- Create, rename, delete `.ts` files.
- `.generated/` directory is read-only in the file tree (visible but not editable).
- `node_modules/` is hidden.
- `package.json` is visible and editable (but dependency changes should go through the dependency UI).

## File Tree

Left sidebar showing the contents of the scripts directory (`/config/`). Sorted alphabetically, `.ts` files only by default with toggle to show all files. Context menu for create/rename/delete. Clicking a file opens it in the editor.

## Build Controls

### Build Button

Triggers the full build pipeline: type generation → npm install → tsc check → esbuild bundle → deploy.

### Build Output Console

Bottom panel showing:
- Each pipeline step with status (running/success/failure).
- Type errors from tsc with file:line:column links (clicking navigates the editor).
- esbuild output (bundle sizes, warnings).
- Deploy result: entities registered, entities removed, errors.

### Auto-Build Toggle

Opt-in setting. When enabled, saving a file triggers a build after a short debounce. Disabled by default to avoid surprises during multi-file edits.

### Type Regeneration Button

Regenerates HA registry types on demand without a full build. Shows when types were last generated and whether the HA registry has changed since (by comparing entity counts / modification timestamps from the registry API).

## Entity Dashboard

Live-updating table of all registered entities:

| Column | Source |
|---|---|
| Entity ID | MQTT discovery unique_id → HA entity ID |
| Name | Entity definition |
| Type | Entity platform (sensor, switch, light, etc.) |
| State | Current published state |
| Source File | User `.ts` file that defines this entity |
| Transport | MQTT (v1) or Native Bridge (future) |
| Status | Healthy / Error count / Unavailable |

Data comes from the runtime's internal entity registry. Updated in real-time via WebSocket push from the add-on's API server to the UI.

Clicking an entity row could expand to show:
- Recent log entries for that entity.
- MQTT topics (discovery, state, command).
- Last error (if any).

## Log Viewer

### Display

Real-time log stream in a bottom or side panel. Each log entry shows:
- Timestamp
- Level (debug/info/warn/error) with color coding
- Source file
- Entity ID (if applicable)
- Message
- Expandable structured data (JSON)

### Filtering

- **By entity**: dropdown or click-to-filter from entity dashboard.
- **By file**: dropdown or click-to-filter from file tree.
- **By level**: toggle buttons for debug/info/warn/error.
- **By time range**: date-time range picker.
- **Text search**: free-text search across message and data fields.

### Data Source

The log viewer queries the SQLite database via a REST endpoint served by the add-on:

```
GET /api/logs?entity_id=backyard_temp&level=warn,error&since=1705312200000&limit=100
```

Real-time tailing uses a WebSocket connection. The add-on pushes new log rows as they're written to SQLite.

### Retention

Configurable max age (default: 7 days). Cleanup runs on startup and periodically. Controlled by the `log_retention_days` add-on option.

## Dependency Management

### UI Panel

A dedicated panel (tab or sidebar section) for managing npm dependencies:

- **Search**: npm package search with results showing package name, version, description.
- **Add**: Adds package to `package.json` dependencies. Flags that `npm install` is needed on next build.
- **Remove**: Removes package from `package.json`.
- **Installed list**: Shows current dependencies with versions.

### How It Works

1. User adds/removes a package via the UI.
2. UI writes the change to `package.json` via the add-on's REST API.
3. A flag is set indicating `npm install` is needed.
4. On next build, `npm install` runs before compilation.
5. After install, `node_modules/**/*.d.ts` are scanned and injected into Monaco.

Dependency changes always require an explicit build. This avoids partial install states.

## API Server

The add-on runs an HTTP + WebSocket server on the ingress port serving both the UI assets and the API:

### REST Endpoints

| Endpoint | Purpose |
|---|---|
| `GET /` | Serve Monaco UI (HTML + JS + CSS) |
| `GET /api/files` | List files in scripts directory |
| `GET /api/files/:path` | Read file contents |
| `PUT /api/files/:path` | Write file contents |
| `DELETE /api/files/:path` | Delete file |
| `POST /api/build` | Trigger build |
| `GET /api/build/status` | Current build status |
| `GET /api/entities` | List registered entities with state |
| `GET /api/logs` | Query log entries (with filters) |
| `GET /api/packages` | List installed npm packages |
| `POST /api/packages` | Add npm package |
| `DELETE /api/packages/:name` | Remove npm package |
| `POST /api/types/regenerate` | Trigger type regeneration |
| `GET /api/types/status` | Type generation status |

### WebSocket Channels

| Channel | Purpose |
|---|---|
| `build` | Live build output stream |
| `entities` | Entity state change notifications |
| `logs` | Real-time log tailing |

## VS Code Compatibility

The same generated types exist on disk at `/config/.generated/` and the SDK types at `/config/node_modules/ha-forge/`. A `tsconfig.json` is scaffolded on first run. Users who prefer VS Code Server, SSH + local editor, or any other TypeScript-aware tool get the same autocomplete and error checking without the Monaco UI.
