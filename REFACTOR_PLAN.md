# Refactor Plan

## Status
Phase: 6 - Complete
Started: 2026-03-29
Completed: 2026-03-30

## Thesis

**ast-analyzers.ts** (2,134 lines, 61 functions) mixes three unrelated concerns: diagnostic analyzers (squiggly underlines), code action generators (quick-fix lightbulbs), and structure finders (CodeLens/minimap). Each has distinct consumers. After splitting, adding a new diagnostic or finder requires navigating a focused ~400-800 line module instead of a 2,134-line file.

## Scope

### In scope
- Split ast-analyzers.ts into 4 focused modules
- Update imports in 3 consumer files (editor-diagnostics, editor-providers, app)
- Move shared helpers to ast-helpers.ts

### Out of scope
- Changing analyzer behavior
- Refactoring consumers
- mqtt-transport.ts (future work)

## Phases

### Phase A: Extract ast-helpers.ts
Shared utilities: ts ref + setTypeScriptApi/isReady, getCalledName, findFactoryCall, markerAt, WRAPPER_NAMES, FACTORY_DOMAINS, extractObjectLiteral, idToTitle, toSnakeCase, toCamelCase, EntityInfo, AstAnalysisResult types.

### Phase B: Extract ast-finders.ts
Structure finders used by editor-providers and app: findCronStrings, findEntityDefinitions, findEntityDependencies, findScenarios + their types (CronStringLocation, EntityDefinitionLocation, ScenarioLocation, EntityDependencies) + private helpers (extractWrapperInfo, extractEntityId, countDeviceMembers, collectDeviceMembers).

### Phase C: Extract ast-code-actions.ts
Code action generators used by editor-diagnostics: generateSensorToComputed, generateDeviceRefactor, generateMoveIntoDevice, getDeviceInfoInsertion + private helpers (suggestVarName, reindent, findPropInFactory, extractUpdateExpr, escapeRegExp, getPropName, removePropsFromExpr, collectStandaloneEntities, hasExportModifier).

### Phase D: Slim ast-analyzers.ts
What remains: analyzeWithAst + all check* functions (the diagnostic analyzers). Update imports to pull from ast-helpers.

## Decision Log

### Orientation — 2026-03-29
**Decision:** Target ast-analyzers.ts for refactoring.
**Reasoning:** 2,134 lines mixing three unrelated concerns with distinct consumers. Natural section boundaries already visible.
**Alternatives considered:** mqtt-transport.ts — valid target but ast-analyzers has cleaner seams.

### Split strategy — 2026-03-29
**Decision:** 4-file split: helpers, finders, code-actions, analyzers (slimmed).
**Reasoning:** Maps directly to consumer boundaries. editor-providers only needs finders, editor-diagnostics needs analyzers + code-actions, app needs finders only.
**Alternatives considered:** 2-file split (analyzers + everything else) — less clean, still mixes code-actions with finders.

### Execution complete — 2026-03-30
**Result:** ast-analyzers.ts (2,134 lines) → 4 focused modules:
- ast-helpers.ts (190 lines) — shared utilities, TypeScript API ref, constants
- ast-finders.ts (468 lines) — structure finders for CodeLens/minimap/hover
- ast-code-actions.ts (711 lines) — code action generators for quick-fixes
- ast-analyzers.ts (840 lines) — diagnostic check functions only
**Verification:** 445/445 tests pass, all packages type-check clean. All 5 consumer imports updated to import directly from new modules.
