# Web Editor

HA Forge includes a browser-based code editor accessible from the HA sidebar. It is built on Monaco (the engine behind VS Code) and provides full TypeScript IntelliSense tailored to your HA installation.

## IntelliSense

The editor loads with complete type information:

- **SDK types** -- all entity factories, `ha.*` API, behaviors, and utility types from `ha-forge`.
- **HA registry types** -- generated from your installation. Every entity ID, state value, attribute, and service parameter autocompletes.
- **npm package types** -- types from installed packages (including `@types/*`) are injected automatically after build.

This means you get autocomplete, hover documentation, and error squiggles without any manual setup. When you type `ha.callService('light.`, you see every light entity in your installation. When you add `brightness:`, you see its valid range.

## File Tree

The left sidebar shows `.ts` files in your scripts directory (`/config/`). You can:

- **Create** new files (right-click context menu or toolbar button).
- **Rename** and **delete** files.
- Browse the `.generated/` directory (read-only -- these are auto-generated types).
- Edit `package.json` for dependency management.
- `node_modules/` is hidden.

Clicking a file opens it in the editor. Multiple files can be open as tabs.

## Saving

Save with **Ctrl+S** (or **Cmd+S** on macOS). Save As with **Ctrl+Shift+S** to save the current file under a new name.

## Build Button

The toolbar contains a **Build** button that triggers the full pipeline:

1. **Type generation** -- regenerates types from your current HA entity registry.
2. **npm install** -- runs if `package.json` has changed.
3. **Type check** -- `tsc` finds errors. These appear as squiggles in the editor and entries in the build console.
4. **Bundle** -- esbuild compiles TypeScript to JavaScript.
5. **Deploy** -- runtime loads the bundle, registers entities, calls `init()`.

Each step shows its status (running / success / failure) in the build output console.

### Build Output Console

The bottom panel shows build results:

- Type errors with clickable file:line:column links that navigate the editor.
- Bundle sizes and warnings from esbuild.
- Deploy results: entities registered, entities removed, errors.

Type errors warn but do not block the build. Entities with errors may fail to load at runtime, but other entities in the same file still work.

## Entity Dashboard

The sidebar shows a live-updating list of all registered entities:

- **Entity ID** -- the HA entity ID.
- **Name** -- from the entity definition.
- **Type** -- platform (sensor, switch, light, etc.).
- **State** -- current published state.
- **Source File** -- which `.ts` file defines this entity.
- **Status** -- healthy, error count, or unavailable.

The entity list supports **per-file filtering**: click a file in the file tree to see only entities defined in that file.

Data updates in real-time via WebSocket.

## Log Viewer

A panel showing the real-time log stream from all entities and the runtime system.

### Display

Each log entry shows:
- Timestamp
- Level (debug / info / warn / error) with color coding
- Source file
- Entity ID (if applicable)
- Message
- Expandable structured data (JSON)

### Filtering

- **By entity** -- dropdown or click-to-filter from the entity dashboard.
- **By file** -- click-to-filter from the file tree.
- **By level** -- toggle buttons for debug / info / warn / error.
- **Text search** -- free-text search across message and data fields.

Logs are stored in SQLite with configurable retention (default: 7 days, controlled by the `log_retention_days` add-on option).

### Real-Time Tailing

New log entries appear as they are written. The viewer auto-scrolls to the latest entry unless you have scrolled up to inspect history.

## Auto-Build on Save

An opt-in setting (disabled by default). When enabled, saving a file triggers a build after a short debounce. Controlled by the `auto_build_on_save` add-on option.

Disabled by default to avoid surprises during multi-file edits.

## Type Regeneration

A dedicated button regenerates HA registry types on demand without running a full build. The editor shows:

- When types were last generated.
- Whether the HA registry has changed since the last generation.

After regeneration, the Monaco language service restarts with the new types, and open files are re-checked.

## VS Code Alternative

The same types exist on disk:

- SDK types: `/config/node_modules/ha-forge/`
- Generated HA types: `/config/.generated/`
- TypeScript config: `/config/tsconfig.json` (scaffolded on first run)

Any TypeScript-aware editor (VS Code Server add-on, SSH + local editor, or Samba mount) picks up these types automatically. You get the same autocomplete and error checking as the built-in Monaco editor.

The build must still be triggered from the HA Forge UI (or via auto-build on save).
