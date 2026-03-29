# Refactor Plan

## Status
Phase: 6 - Complete
Started: 2026-03-29
Completed: 2026-03-29

## Thesis

**app.ts**: The web editor's main component (2,478 lines, 60+ methods) is a god-class handling Monaco providers, diagnostics, file ops, build, simulation, and WebSocket — all in one LitElement. It's the most-changed file (16 of last 100 commits). After refactoring, adding a new Monaco provider or diagnostics rule should require changes in one focused module, not navigating a 2,500-line class.

**lifecycle.ts**: The entity lifecycle manager (1,873 lines) handles init/teardown/context for 6 entity kinds with repeated patterns (e.g., identical HA API stubs on lines 731, 1090, 1551, 1690, 1764). After refactoring, shared patterns (context creation, teardown, HA API stubs) are extracted into reusable helpers.

## Results

### app.ts: 2,478 → 640 lines (-74%)
- Extracted Monaco language providers into `editor-providers.ts` (776 lines)
- Extracted diagnostics engine into `editor-diagnostics.ts` (~810 lines)
- Extracted shared Monaco types into `monaco-types.ts`
- Host interface pattern decouples extracted modules from LitElement

### lifecycle.ts: 1,873 → 1,696 lines (-9%)
- Extracted 5x duplicated context-creation patterns into `context-helpers.ts` (67 lines)
- Centralized: scoped logger, stub HA API, stub events, MQTT context wiring

### Tests: 445/445 passing after every commit

## Scope

### Completed
- Extract Monaco language providers from app.ts into `editor-providers.ts`
- Extract diagnostics engine from app.ts into `editor-diagnostics.ts`
- Extract shared Monaco type declarations into `monaco-types.ts`
- Extract shared context-creation patterns from lifecycle.ts into `context-helpers.ts`

### Deferred (C2-C7: per-entity-kind lifecycle extraction)
Each entity kind's init/teardown logic is genuinely unique — splitting into 6 files would scatter code without reducing complexity. The real pain (duplicated stubs and context wiring) is solved by C1.

## Decision Log

### Orientation — 2026-03-29
**Decision:** Target app.ts and lifecycle.ts for refactoring.
**Reasoning:** app.ts is the most-changed file and a 2,478-line god-class. lifecycle.ts has 6 repeated init/teardown/context patterns in 1,873 lines.
**Alternatives considered:** mqtt-transport.ts (repetitive but each entity config is genuinely unique — extraction wouldn't reduce complexity).

### Sequencing — 2026-03-29
**Decision:** app.ts first (Phase A+B), then lifecycle.ts (Phase C).
**Reasoning:** app.ts changes most frequently, so extracting it reduces merge friction soonest. Lifecycle.ts is more stable.
**Alternatives considered:** Lifecycle first (lower risk since runtime code) — but app.ts pain is more acute.

### Provider extraction pattern — 2026-03-29
**Decision:** Each provider becomes a standalone function that takes the app instance or necessary state as parameters, registers itself, and returns cleanup disposables.
**Reasoning:** Minimal API surface, no class inheritance, easy to test independently.
**Alternatives considered:** Mixin pattern (adds complexity), sub-components (providers aren't renderable).

### Phase A+B combined — 2026-03-29
**Decision:** Extract all providers into one module and all diagnostics into one module, rather than one file per provider.
**Reasoning:** Providers share state (entities, completionRegistry) and the host interface pattern works cleanly with a single setup function. Splitting into 11+ tiny files would add import overhead without meaningful benefit.
**Alternatives considered:** One file per provider (too granular for tightly-coupled Monaco registrations).

### Defer C2-C7 — 2026-03-29
**Decision:** Stop lifecycle.ts refactoring after C1 (shared context helpers).
**Reasoning:** Per-entity-kind init/teardown is genuinely unique code — splitting into 6 files would scatter without reducing complexity. The duplicated patterns (the actual pain) are already eliminated.
**Alternatives considered:** Full extraction into 6 files — would increase file count from 1 to 7 with minimal readability benefit.
