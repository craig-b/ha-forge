# Monaco Editor Features — Review & Roadmap

## Current Usage

| Feature | API | Purpose |
|---|---|---|
| Editor | `editor.create` | Main editor with theme, fonts, bracket pairs, sticky scroll |
| Multi-file models | `editor.createModel` / `getModel` | Tab system, SDK type definitions |
| Diagnostics | `setModelMarkers` | Squiggly underlines from regex + AST analyzers (2 owners) |
| Code actions | `registerCodeActionProvider` | 7 quick-fixes + 1 refactoring |
| Document symbols | `registerDocumentSymbolProvider` | Ctrl+Shift+O entity outline |
| Hover tooltips | `registerHoverProvider` | Cron expression descriptions via cronstrue |
| Cross-file nav | `registerEditorOpener` | Ctrl+Click between user files |
| Type injection | `addExtraLib` | SDK globals + HA registry types for IntelliSense |
| TS config | `setCompilerOptions` / `setDiagnosticsOptions` | Strict mode, semantic validation |

9 of ~40+ available API surfaces.

---

## Planned Features

### CodeLens — Live Entity State (Priority 1)

**API:** `registerCodeLensProvider`

Show live entity state above each exported entity definition: `● 23.5°C • 2m ago`. Click to filter logs or open dashboard.

**What's involved:**
- State cache populated from `GET /api/entities`, updated via WebSocket `state_changed` events
- AST walk to find exported entity definitions and extract entity IDs
- Factory-name-to-domain mapping (`binarySensor` → `binary_sensor`, `defineSwitch` → `switch`, etc.)
- State formatting per domain (sensors: value + unit, lights: on/brightness, climate: mode + temps)
- `onDidChangeCodeLenses` event fired on WebSocket state updates (debounced)
- Click commands: filter log panel, jump to entity dashboard

**Complications:**
- Entity matching requires domain derivation from factory name
- Undeployed entities (new code) won't have state — show "not deployed"
- State changes can be frequent — debounce CodeLens refresh
- Device members are dense — may need per-member or aggregated display

### Document Highlights — Entity ID Usage (Priority 2)

**API:** `registerDocumentHighlightProvider`

Click on `id: 'motion_sensor'` and all string references to that ID in the same file light up.

**What's involved:**
- Check if cursor is on a string literal inside an `id:` property of a factory call
- Search same file for all string literals containing that ID (bare or domain-qualified)
- Return `DocumentHighlight` with `Write` kind for definition, `Read` for references

**Complications:**
- Minimal — single-file string matching
- Need to handle both `'motion_sensor'` and `'binary_sensor.motion_sensor'` forms

### Minimap Entity Markers (Priority 3)

**API:** `createDecorationsCollection` with `minimap` option

Color-code regions in the minimap by entity type: green for devices, blue for sensors, purple for automations, orange for crons.

**What's involved:**
- One decoration per entity definition with `minimap.color` and `overviewRuler.color`
- Update on content change (reuse AST walk)
- Color scheme distinguishable on dark theme

**Complications:**
- Minimal — one of the simplest features to implement

### Static Template Scaffolding (Priority 4)

**API:** `registerCompletionItemProvider`

Type at top level → see "New sensor", "New automation", "New device" completions that insert full templates with tab-stop placeholders.

**What's involved:**
- Templates for each factory: sensor, binary_sensor, light, switch, device, automation, computed, cron
- Context detection: top-level (standalone with `export const`) vs inside `device({ entities: {} })` (member)
- Snippet placeholders for id, name, device_class choices, init body
- Trigger on empty lines or after `export const`

**Complications:**
- Monaco standalone may not support `InsertAsSnippet` — need to verify, fall back to plain text with TODO comments if not
- Need to detect cursor context (top-level vs device member) for appropriate templates

---

## Backlog (Not Planned)

| Feature | API | Effort | Notes |
|---|---|---|---|
| Inlay hints (full entity IDs) | `registerInlayHintsProvider` | Low-med | Show `sensor.xxx` after factory calls |
| Nested symbols (sticky scroll) | `registerDocumentSymbolProvider` | Low-med | Device → entity → init hierarchy |
| Link provider (Ctrl+Click refs) | `registerLinkProvider` | Medium | Navigate entity ID string references |
| Semantic token coloring | `registerDocumentSemanticTokensProvider` | Medium | Color factories, exported vs unexported |
| Color previews | `registerColorProvider` | Low-med | Swatches for rgb_color, color_temp |
| Dependency graph CodeLens | `registerCodeLensProvider` | Med-high | "Watches: x, y \| Controls: z" |
| Rename provider | `registerRenameProvider` | High | F2 rename entity ID across files |
| Diff editor deploy preview | `createDiffEditor` | Med-high | Side-by-side before deploy |
| Custom folding ranges | `registerFoldingRangeProvider` | Low | Semantic entity folding |
| Signature help | `registerSignatureHelpProvider` | Medium | Redundant with TS IntelliSense |
| AI scaffolding | `registerCompletionItemProvider` + LLM | High | Separate initiative |
