# Refactor Plan

## Status
Phase: 0 - Orientation
Started: 2026-03-29

## Orientation Findings

### Codebase structure
5-package monorepo: sdk (types + entity factories), runtime (lifecycle + MQTT transport), build (type generator), web (Monaco editor + simulation), addon (entry point).

### Where it hurts

**1. `sdk/src/types.ts` — 2,325 lines, 132 exports, monolithic type file**
Every entity platform's types (Config, Definition, State, Command) live in one file. Every entity factory imports from it. It's the #4 most-changed file. Adding a new entity type means editing a single massive file. Types are already logically grouped by `// ---- Sensor ----` section headers — they're begging to be split.

**2. `runtime/src/mqtt-transport.ts` — 1,223 lines, per-entity-kind MQTT logic**
Three areas of per-entity-type branching:
- `subscribeCommandTopics()` — if/else chain for cover/climate/fan/humidifier/vacuum/lawn mower/update command topic subscriptions
- Discovery config — 22-case switch statement dispatching to 22 `apply*Config()` private methods
- `publishState()` — if/else chain publishing to per-feature sub-topics for climate/fan/humidifier/water_heater/update/lawn_mower/image
- `handleMessage()` — regex match cascade for routing MQTT messages to entity command handlers

Each entity type's MQTT knowledge (topics, payloads, discovery config) is spread across 4 different methods. Adding a new entity type requires touching 4+ places in this one class.

**3. `web/src/ui/client/ast-analyzers.ts` — 2,134 lines, growing analyzer collection**
13+ independent AST analyzers in one file. Already the second-largest file and growing. Each analyzer is independent (own function, no shared state beyond the `ts` API reference).

### What doesn't hurt (leave alone)
- `lifecycle.ts` (1,696 lines) — already refactored, per-entity init is genuinely unique
- `app.ts` (640 lines) — already refactored from 2,478
- `simulation-shim.ts` (777 lines) — heavily changed recently, still settling
- `editor-providers.ts`, `editor-diagnostics.ts` — freshly extracted

## Thesis
[Empty until Phase 1]

## Scope
[Empty until Phase 2]

## Phases
[Empty until Phase 2]

## Current Phase
[Empty until Phase 3]

## Decision Log

### Orientation — 2026-03-29
**Decision:** Identified three pain points: types.ts (monolithic 2,325-line type file), mqtt-transport.ts (per-entity MQTT logic spread across 4 methods), ast-analyzers.ts (13+ independent analyzers in one file).
**Reasoning:** types.ts and mqtt-transport.ts are the structural bottlenecks for adding new entity types. ast-analyzers.ts is the largest file and growing. All three have natural seams for extraction.
**Alternatives considered:** simulation-shim.ts is large but still actively changing — too early to refactor.

## Open Questions
1. Which of the three pain points should we prioritize? Or tackle multiple?
2. For types.ts: split per entity platform (sensor.ts, light.ts, etc.) or by category (entity-types.ts, reactive-types.ts, simulation-types.ts)?
3. For mqtt-transport: extract per-entity MQTT config into a registry pattern, or keep methods but colocate per-entity?
