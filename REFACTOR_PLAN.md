# Refactor Plan

## Status
Phase: 6 - Complete
Started: 2026-03-29
Completed: 2026-03-29

## Thesis

**types.ts**: The SDK's monolithic type file (2,325 lines, 132 exports) contains all entity platform types in one file. Adding a new entity type means editing a single massive file. After refactoring, each platform's types live in their own focused module (30-135 lines), and the barrel re-export preserves all existing import paths.

## Results

### types.ts: 2,325 lines → 1 line (barrel re-export)
Split into 30 focused files under `types/`:
- `core.ts` (271 lines) — shared infrastructure: EntityContext, BaseEntity, EventStream, etc.
- `simulation.ts` (33 lines) — SignalEvent, TimeRange, SignalGenerator, ScenarioDefinition
- 22 per-platform files (11-135 lines each) — sensor, binary_sensor, switch, light, cover, climate, fan, lock, number, select, text, button, siren, humidifier, valve, water_heater, vacuum, lawn_mower, alarm_control_panel, notify, update, image
- `automation.ts`, `task.ts`, `mode.ts`, `cron.ts` — meta entity types
- `device.ts` (195 lines) — EntityDefinition union, device handles, DeviceContext
- `index.ts` (86 lines) — barrel re-export

### Zero consumer changes required
Original `types.ts` is now a one-line `export type * from './types/index.js'`, so all existing `from '../types.js'` imports work unchanged.

### Tests: 445/445 passing, all 5 packages type-check clean

## Decision Log

### Orientation — 2026-03-29
**Decision:** Target types.ts for refactoring.
**Reasoning:** 2,325 lines, 132 exports, monolithic. Most-changed SDK file. Natural section boundaries already marked with `// ----` headers.
**Alternatives considered:** mqtt-transport.ts (per-entity MQTT logic spread across 4 methods), ast-analyzers.ts (13+ independent analyzers). Both valid targets for future refactoring.

### Split strategy — 2026-03-29
**Decision:** Per-platform split with barrel re-export, not category-based split.
**Reasoning:** Entity platform types are ~1,500 of 2,325 lines — they're the bulk. A category split would leave an entities file still 1,400+ lines. Per-platform files are 30-135 lines each, dead simple, self-contained. Barrel re-export means zero import changes for consumers.
**Alternatives considered:** Category split (entities vs reactive vs simulation) — would leave the core problem unsolved.

### Barrel re-export pattern — 2026-03-29
**Decision:** Keep original `types.ts` as `export type * from './types/index.js'` rather than deleting it.
**Reasoning:** With `moduleResolution: "bundler"`, `import from '../types.js'` resolves to `types.ts` only — it won't fall through to `types/index.ts`. Keeping the barrel file preserves all existing import paths with zero changes.
**Alternatives considered:** Updating all import paths to `../types/index.js` — unnecessary churn.
