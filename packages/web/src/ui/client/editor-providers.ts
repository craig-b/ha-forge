import type { Monaco, MonacoMarkerData, MonacoRange, MonacoDocumentSymbol, MonacoModelInstance, MonacoEditorInstance, OpenFileInternal } from './monaco-types.js';
import { findEntitySymbols } from './analyzers.js';
import { isReady as isAstReady } from './ast-helpers.js';
import { findCronStrings, findEntityDefinitions, findEntityDependencies, type EntityDefinitionLocation } from './ast-finders.js';
import type { EntityInfo } from './types.js';

export interface ProviderHost {
  getEntities(): EntityInfo[];
  getOpenFiles(): OpenFileInternal[];
  getCompletionRegistry(): {
    domains: Record<string, { services: Record<string, { description?: string; fields: Record<string, { type: string; description?: string; required: boolean }> }> }>;
    entities: Record<string, { domain: string; services?: string[] }>;
  } | null;
  getActiveFile(): string | null;
  openFile(path: string): void;
  setActiveFile(path: string): void;
  requestUpdate(): void;
}

export interface ProviderHandles {
  refreshCodeLenses(): void;
  refreshInlayHints(): void;
  setCronstrue(cronstrue: Cronstrue): void;
}

type Cronstrue = { toString(expr: string, opts?: { throwExceptionOnParseError?: boolean }): string };

export function setupProviders(m: Monaco, editor: MonacoEditorInstance, host: ProviderHost): ProviderHandles {

  // --- 1. Entity Symbol Provider (Ctrl+Shift+O) ---

  m.languages.registerDocumentSymbolProvider('typescript', {
    displayName: 'Entity Symbols',
    provideDocumentSymbols(model: MonacoModelInstance): MonacoDocumentSymbol[] {
      const sourceText = model.getValue();
      const entities = findEntitySymbols(sourceText);
      const lines = sourceText.split('\n');
      return entities.map((entity) => {
        const lineLen = (lines[entity.line - 1] || '').length + 1;
        return {
          name: entity.name,
          detail: `${entity.factoryName}()${entity.isExported ? '' : ' (not exported)'}`,
          kind: m.languages.SymbolKind.Variable,
          range: new m.Range(entity.line, 1, entity.line, lineLen),
          selectionRange: new m.Range(entity.line, entity.startCol, entity.line, entity.endCol),
        };
      });
    },
  });

  // --- 2. Code Lens Provider ---

  let codeLensChangeListeners: Array<() => void> = [];
  let inlayHintChangeListeners: Array<() => void> = [];
  let cronstrue: Cronstrue | null = null;

  m.languages.registerCodeLensProvider('typescript', {
    onDidChange: (listener: () => void) => {
      codeLensChangeListeners.push(listener);
      return { dispose: () => { codeLensChangeListeners = codeLensChangeListeners.filter(l => l !== listener); } };
    },
    provideCodeLenses: (model: MonacoModelInstance) => {
      if (!isAstReady()) return { lenses: [], dispose() {} };

      const defs = findEntityDefinitions(model.getValue(), model.uri.path || 'file.ts');
      const entities = host.getEntities();
      const stateMap = new Map(entities.map(e => [`${e.type}.${e.id}`, e]));

      const lenses: Array<{ range: unknown; command: { id: string; title: string } }> = [];
      for (const def of defs) {
        let title: string;
        if (def.domain === 'device') {
          const members = def.memberCount ?? 0;
          const deployed = entities.filter(e => e.sourceFile === (model.uri.path || '').replace(/^\//, '')).length;
          title = def.isExported
            ? `\u25A0 device: ${def.entityId} \u2014 ${members} members${deployed > 0 ? `, ${deployed} deployed` : ''}`
            : `\u25A0 device: ${def.entityId} \u2014 not exported`;
        } else {
          const entity = stateMap.get(def.fullEntityId) as (EntityInfo & { next_fire?: string; cron_description?: string }) | undefined;
          if (!entity) {
            title = def.isExported ? `${def.fullEntityId} \u2014 not deployed` : `${def.fullEntityId} \u2014 not exported`;
          } else if (entity.type === 'cron' && entity.next_fire) {
            const status = entity.status === 'healthy' ? '\u2713' : '\u2717';
            const label = entity.state === 'ON' ? 'active' : 'scheduled';
            const nextDate = new Date(entity.next_fire);
            const nextStr = nextDate.toLocaleString();
            title = `${status} ${def.fullEntityId}: ${label} \u2014 next ${nextStr}`;
          } else {
            const stateStr = entity.state != null ? String(entity.state) : '\u2014';
            const status = entity.status === 'healthy' ? '\u2713' : '\u2717';
            const unit = entity.unit_of_measurement ? ` ${entity.unit_of_measurement}` : '';
            title = `${status} ${def.fullEntityId}: ${stateStr}${unit}`;
          }
        }

        if (def.factoryName === 'cron' && cronstrue) {
          const entity = stateMap.get(def.fullEntityId) as (EntityInfo & { cron_description?: string }) | undefined;
          let description = entity?.cron_description;
          if (!description) {
            const cronStrings = findCronStrings(model.getValue(), model.uri.path || 'file.ts');
            const cronStr = cronStrings.find(c => c.startLine >= def.line && c.startLine <= (def.endLine ?? def.line + 20));
            if (cronStr) {
              try { description = cronstrue!.toString(cronStr.value, { throwExceptionOnParseError: true }); } catch { /* ignore */ }
            }
          }
          if (description) {
            lenses.push({
              range: new m.Range(def.line, 1, def.line, 1),
              command: { id: '', title: `\u23F0 ${description}` },
            });
          }
        }

        lenses.push({
          range: new m.Range(def.line, 1, def.line, 1),
          command: { id: '', title },
        });
      }

      const deps = findEntityDependencies(model.getValue(), model.uri.path || 'file.ts');
      for (const def of defs) {
        const dep = deps.get(def.fullEntityId);
        if (!dep || (dep.watches.length === 0 && dep.controls.length === 0)) continue;
        const parts: string[] = [];
        if (dep.watches.length > 0) parts.push(`Watches: ${dep.watches.join(', ')}`);
        if (dep.controls.length > 0) parts.push(`Controls: ${dep.controls.join(', ')}`);
        lenses.push({
          range: new m.Range(def.line, 1, def.line, 1),
          command: { id: '', title: `\u{1F517} ${parts.join(' | ')}` },
        });
      }

      return { lenses, dispose() {} };
    },
  });

  // --- 3. Inlay Hints Provider ---

  m.languages.registerInlayHintsProvider('typescript', {
    onDidChangeInlayHints: (listener: () => void) => {
      inlayHintChangeListeners.push(listener);
      return { dispose: () => { inlayHintChangeListeners = inlayHintChangeListeners.filter(l => l !== listener); } };
    },
    provideInlayHints: (model: MonacoModelInstance, _range: MonacoRange) => {
      if (!isAstReady()) return { hints: [], dispose() {} };

      const sourceText = model.getValue();
      const defs = findEntityDefinitions(sourceText, model.uri.path || 'file.ts');
      const lines = sourceText.split('\n');

      const hints: Array<{
        position: { lineNumber: number; column: number };
        label: string;
        kind?: number;
        paddingLeft?: boolean;
        tooltip?: string;
      }> = defs.map(def => ({
        position: { lineNumber: def.line, column: (lines[def.line - 1] || '').length + 1 },
        label: def.fullEntityId,
        kind: m.languages.InlayHintKind.Type,
        paddingLeft: true,
        tooltip: `MQTT entity: ${def.fullEntityId}`,
      }));

      return { hints, dispose() {} };
    },
  });

  // --- 4. Color Provider ---

  m.languages.registerColorProvider('typescript', {
    provideDocumentColors: (model: MonacoModelInstance) => {
      const colors: Array<{ color: { red: number; green: number; blue: number; alpha: number }; range: MonacoRange }> = [];
      const lines = model.getValue().split('\n');
      const rgbRegex = /rgb_color:\s*\[(\d+),\s*(\d+),\s*(\d+)\]/g;

      for (let i = 0; i < lines.length; i++) {
        let match: RegExpExecArray | null;
        rgbRegex.lastIndex = 0;
        while ((match = rgbRegex.exec(lines[i])) !== null) {
          const bracketStart = lines[i].indexOf('[', match.index);
          const bracketEnd = lines[i].indexOf(']', bracketStart) + 1;
          colors.push({
            color: {
              red: parseInt(match[1]) / 255,
              green: parseInt(match[2]) / 255,
              blue: parseInt(match[3]) / 255,
              alpha: 1,
            },
            range: new m.Range(i + 1, bracketStart + 1, i + 1, bracketEnd + 1),
          });
        }
      }
      return colors;
    },
    provideColorPresentations: (_model: MonacoModelInstance, colorInfo: {
      color: { red: number; green: number; blue: number; alpha: number };
      range: MonacoRange;
    }) => {
      const r = Math.round(Math.min(255, Math.max(0, colorInfo.color.red * 255)));
      const g = Math.round(Math.min(255, Math.max(0, colorInfo.color.green * 255)));
      const b = Math.round(Math.min(255, Math.max(0, colorInfo.color.blue * 255)));
      const text = `[${r}, ${g}, ${b}]`;
      return [{ label: text, textEdit: { range: colorInfo.range, text } }];
    },
  });

  // --- 5. Rename Provider ---

  function findStringAtPosition(line: string, column: number): { value: string; startCol: number; endCol: number } | null {
    const regex = /(['"])([^'"]*)\1/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(line)) !== null) {
      const start = match.index + 2;
      const end = start + match[2].length;
      if (column >= start && column <= end) return { value: match[2], startCol: start, endCol: end };
    }
    return null;
  }

  m.languages.registerRenameProvider('typescript', {
    resolveRenameLocation: (model: MonacoModelInstance, position: { lineNumber: number; column: number }) => {
      const line = model.getValue().split('\n')[position.lineNumber - 1];
      if (!line) return { range: new m.Range(0, 0, 0, 0), text: '', rejectReason: 'Not an entity ID' };

      const strResult = findStringAtPosition(line, position.column);
      if (!strResult) return { range: new m.Range(0, 0, 0, 0), text: '', rejectReason: 'Not an entity ID' };

      const defs = findEntityDefinitions(model.getValue(), model.uri.path || 'file.ts');
      const matchingDef = defs.find(d => d.entityId === strResult.value || d.fullEntityId === strResult.value);
      if (!matchingDef) return { range: new m.Range(0, 0, 0, 0), text: '', rejectReason: 'Not an entity ID' };

      const bareId = matchingDef.entityId;
      return {
        range: new m.Range(position.lineNumber, strResult.startCol, position.lineNumber, strResult.endCol),
        text: bareId,
      };
    },

    provideRenameEdits: (model: MonacoModelInstance, position: { lineNumber: number; column: number }, newName: string) => {
      if (!/^[a-z][a-z0-9_]*$/.test(newName)) {
        return { edits: [], rejectReason: 'Entity IDs must be snake_case (a-z, 0-9, _)' };
      }

      const line = model.getValue().split('\n')[position.lineNumber - 1];
      if (!line) return { edits: [] };
      const strResult = findStringAtPosition(line, position.column);
      if (!strResult) return { edits: [] };

      const defs = findEntityDefinitions(model.getValue(), model.uri.path || 'file.ts');
      const matchingDef = defs.find(d => d.entityId === strResult.value || d.fullEntityId === strResult.value);
      if (!matchingDef) return { edits: [] };

      const oldBareId = matchingDef.entityId;
      const oldFullId = matchingDef.fullEntityId;
      const newFullId = matchingDef.domain + '.' + newName;

      const allDefs: Array<{ entityId: string; fullEntityId: string }> = [];
      for (const f of host.getOpenFiles()) {
        if (isAstReady()) {
          allDefs.push(...findEntityDefinitions(f.model.getValue(), f.model.uri.path || 'file.ts'));
        }
      }
      const bareIdIsAmbiguous = allDefs.filter(d => d.entityId === oldBareId).length > 1;

      const edits: Array<{ resource: unknown; textEdit: { range: MonacoRange; text: string }; versionId?: number }> = [];

      for (const f of host.getOpenFiles()) {
        if (f.path.endsWith('.d.ts')) continue;
        const fileLines = f.model.getValue().split('\n');
        const isCurrentFile = f.model === model;

        for (let i = 0; i < fileLines.length; i++) {
          const fl = fileLines[i];
          for (const [pattern, replacement] of [
            [oldFullId, newFullId],
            ...(isCurrentFile || !bareIdIsAmbiguous ? [[oldBareId, newName]] : []),
          ] as [string, string][]) {
            let searchIdx = 0;
            while (searchIdx < fl.length) {
              let col = fl.indexOf("'" + pattern + "'", searchIdx);
              if (col === -1) col = fl.indexOf('"' + pattern + '"', searchIdx);
              if (col === -1) break;
              const startCol = col + 2;
              const endCol = startCol + pattern.length;
              edits.push({
                resource: f.model.uri,
                textEdit: {
                  range: new m.Range(i + 1, startCol, i + 1, endCol),
                  text: replacement,
                },
                versionId: f.model.getVersionId(),
              });
              searchIdx = col + 1 + pattern.length + 1;
            }
          }
        }
      }

      return { edits };
    },
  });

  // --- 6. Document Highlights Provider ---

  m.languages.registerDocumentHighlightProvider('typescript', {
    provideDocumentHighlights: (model: MonacoModelInstance, position: { lineNumber: number; column: number }) => {
      if (!isAstReady()) return [];
      const source = model.getValue();
      const lines = source.split('\n');
      const line = lines[position.lineNumber - 1];
      if (!line) return [];

      const stringResult = findStringAtPosition(line, position.column);
      if (!stringResult) return [];

      const defs = findEntityDefinitions(source, model.uri.path || 'file.ts');
      const bareId = stringResult.value.includes('.') ? stringResult.value.split('.').slice(1).join('.') : stringResult.value;
      const stringAt = stringResult.value;
      const matchingDef = defs.find(d => d.entityId === bareId || d.fullEntityId === stringAt);
      if (!matchingDef) return [];

      const highlights: Array<{ range: MonacoRange; kind?: number }> = [];
      const patterns = [matchingDef.entityId, matchingDef.fullEntityId];

      for (let i = 0; i < lines.length; i++) {
        for (const pattern of patterns) {
          let col = lines[i].indexOf("'" + pattern + "'");
          if (col === -1) col = lines[i].indexOf('"' + pattern + '"');
          if (col === -1) continue;
          const startCol = col + 2;
          const endCol = startCol + pattern.length;
          const isDefinition = i === matchingDef.line - 1 && pattern === matchingDef.entityId;
          highlights.push({
            range: new m.Range(i + 1, startCol, i + 1, endCol),
            kind: isDefinition ? m.languages.DocumentHighlightKind.Write : m.languages.DocumentHighlightKind.Read,
          });
        }
      }

      return highlights;
    },
  });

  // --- 7. Entity Completion Provider ---

  const entityTemplates = [
    {
      label: 'New sensor',
      detail: 'sensor({ ... })',
      documentation: 'Create a sensor entity with polling',
      sortText: '0_sensor',
      topLevelText: "export const ${1:mySensor} = sensor({\n  id: '${2:my_sensor}',\n  name: '${3:My Sensor}',\n  init() {\n    this.poll(async () => {\n      $0\n      return 0;\n    }, { interval: ${4:30_000} });\n  },\n});",
      memberText: "${1:mySensor}: sensor({\n  id: '${2:my_sensor}',\n  name: '${3:My Sensor}',\n}),",
    },
    {
      label: 'New binary sensor',
      detail: 'binarySensor({ ... })',
      documentation: 'Create a binary sensor (on/off)',
      sortText: '0_binary_sensor',
      topLevelText: "export const ${1:myBinarySensor} = binarySensor({\n  id: '${2:my_binary_sensor}',\n  name: '${3:My Binary Sensor}',\n  init() {\n    $0\n    return 'off';\n  },\n});",
      memberText: "${1:myBinarySensor}: binarySensor({\n  id: '${2:my_binary_sensor}',\n  name: '${3:My Binary Sensor}',\n}),",
    },
    {
      label: 'New switch',
      detail: 'defineSwitch({ ... })',
      documentation: 'Create a controllable switch entity',
      sortText: '0_switch',
      topLevelText: "export const ${1:mySwitch} = defineSwitch({\n  id: '${2:my_switch}',\n  name: '${3:My Switch}',\n  onCommand(command) {\n    $0\n  },\n});",
      memberText: "${1:mySwitch}: defineSwitch({\n  id: '${2:my_switch}',\n  name: '${3:My Switch}',\n  onCommand(command) {\n    $0\n  },\n}),",
    },
    {
      label: 'New light',
      detail: 'light({ ... })',
      documentation: 'Create a light entity with brightness/color control',
      sortText: '0_light',
      topLevelText: "export const ${1:myLight} = light({\n  id: '${2:my_light}',\n  name: '${3:My Light}',\n  config: { supported_color_modes: ['brightness'] },\n  onCommand(command) {\n    $0\n  },\n});",
      memberText: "${1:myLight}: light({\n  id: '${2:my_light}',\n  name: '${3:My Light}',\n  config: { supported_color_modes: ['brightness'] },\n  onCommand(command) {\n    $0\n  },\n}),",
    },
    {
      label: 'New device',
      detail: 'device({ ... })',
      documentation: 'Create a device grouping multiple entities',
      sortText: '0_device',
      topLevelText: "export const ${1:myDevice} = device({\n  id: '${2:my_device}',\n  name: '${3:My Device}',\n  entities: {\n    $0\n  },\n  init() {\n  },\n});",
      memberText: "device({\n  id: '${2:my_device}',\n  name: '${3:My Device}',\n  entities: {\n    $0\n  },\n  init() {\n  },\n})",
    },
    {
      label: 'New automation',
      detail: 'automation({ ... })',
      documentation: 'Create an automation with event subscriptions',
      sortText: '0_automation',
      topLevelText: "export const ${1:myAutomation} = automation({\n  id: '${2:my_automation}',\n  init() {\n    this.events.stream('${3:sensor.entity_id}')\n      .subscribe((event) => {\n        $0\n      });\n  },\n});",
      memberText: "${1:myAutomation}: automation({\n  id: '${2:my_automation}',\n  init() {\n    this.events.stream('${3:sensor.entity_id}')\n      .subscribe((event) => {\n        $0\n      });\n  },\n}),",
    },
    {
      label: 'New computed sensor',
      detail: 'computed({ ... })',
      documentation: 'Create a reactive sensor derived from other entity states',
      sortText: '0_computed',
      topLevelText: "export const ${1:myComputed} = computed({\n  id: '${2:my_computed}',\n  name: '${3:My Computed Value}',\n  watch: ['${4:sensor.source_entity}'],\n  compute(states) {\n    $0\n    return 0;\n  },\n});",
      memberText: "${1:myComputed}: computed({\n  id: '${2:my_computed}',\n  name: '${3:My Computed Value}',\n  watch: ['${4:sensor.source_entity}'],\n  compute(states) {\n    $0\n    return 0;\n  },\n}),",
    },
    {
      label: 'New cron schedule',
      detail: 'cron({ ... })',
      documentation: 'Create a cron-based binary sensor',
      sortText: '0_cron',
      topLevelText: "export const ${1:myCron} = cron({\n  id: '${2:my_schedule}',\n  name: '${3:My Schedule}',\n  schedule: '${4:*/5 * * * *}',\n});",
      memberText: "${1:myCron}: cron({\n  id: '${2:my_schedule}',\n  name: '${3:My Schedule}',\n  schedule: '${4:*/5 * * * *}',\n}),",
    },
    {
      label: 'New task',
      detail: 'task({ ... })',
      documentation: 'Create a one-shot task',
      sortText: '0_task',
      topLevelText: "export const ${1:myTask} = task({\n  id: '${2:my_task}',\n  name: '${3:My Task}',\n  async run() {\n    $0\n  },\n});",
      memberText: "${1:myTask}: task({\n  id: '${2:my_task}',\n  name: '${3:My Task}',\n  async run() {\n    $0\n  },\n}),",
    },
    {
      label: 'New mode selector',
      detail: 'mode({ ... })',
      documentation: 'Create a mode with named states and transitions',
      sortText: '0_mode',
      topLevelText: "export const ${1:myMode} = mode({\n  id: '${2:my_mode}',\n  name: '${3:My Mode}',\n  states: ['${4:home}', '${5:away}', '${6:sleep}'],\n  initial: '${4:home}',\n});",
      memberText: "${1:myMode}: mode({\n  id: '${2:my_mode}',\n  name: '${3:My Mode}',\n  states: ['${4:home}', '${5:away}', '${6:sleep}'],\n  initial: '${4:home}',\n}),",
    },
  ];

  function analyzeCompletionContext(text: string): { depth: number; insideEntities: boolean } {
    let depth = 0;
    const stack: boolean[] = [];
    let i = 0;
    const len = text.length;

    while (i < len) {
      const ch = text[i];

      if (ch === '"' || ch === "'" || ch === '`') {
        i++;
        while (i < len) {
          if (text[i] === '\\') { i += 2; continue; }
          if (text[i] === ch) { i++; break; }
          i++;
        }
        continue;
      }

      if (ch === '/' && i + 1 < len && text[i + 1] === '/') {
        while (i < len && text[i] !== '\n') i++;
        continue;
      }

      if (ch === '/' && i + 1 < len && text[i + 1] === '*') {
        i += 2;
        while (i < len - 1 && !(text[i] === '*' && text[i + 1] === '/')) i++;
        i += 2;
        continue;
      }

      if (ch === '{') {
        const before = text.slice(Math.max(0, i - 50), i);
        stack.push(/entities\s*:\s*$/.test(before));
        depth++;
      } else if (ch === '}') {
        depth = Math.max(0, depth - 1);
        if (stack.length > 0) stack.pop();
      }

      i++;
    }

    return {
      depth,
      insideEntities: stack.length > 0 && stack[stack.length - 1] === true,
    };
  }

  function stripVarDecl(text: string): string {
    const match = text.match(/^export\s+const\s+\$\{1:[^}]+\}\s*=\s*/);
    if (!match) return text;
    return renumberPlaceholders(text.slice(match[0].length));
  }

  function stripMemberKey(text: string): string {
    const match = text.match(/^\$\{1:[^}]+\}:\s*/);
    if (!match) return text;
    return renumberPlaceholders(text.slice(match[0].length));
  }

  function renumberPlaceholders(text: string): string {
    return text.replace(/\$\{(\d+)(:[^}]*)?\}/g, (_match, numStr: string, rest?: string) => {
      const num = parseInt(numStr);
      if (num === 0) return _match;
      return `\${${num - 1}${rest || ''}}`;
    });
  }

  m.languages.registerCompletionItemProvider('typescript', {
    triggerCharacters: ['\n', ' '],
    provideCompletionItems: (model: MonacoModelInstance, position: { lineNumber: number; column: number }) => {
      const allLines = model.getValue().split('\n');
      const lineContent = allLines[position.lineNumber - 1] ?? '';
      const beforeCursor = lineContent.slice(0, position.column - 1);
      const trimmed = beforeCursor.trim();

      const priorLines = allLines.slice(0, position.lineNumber - 1).join('\n');
      const textToCursor = (position.lineNumber > 1 ? priorLines + '\n' : '') + beforeCursor;
      const { depth, insideEntities } = analyzeCompletionContext(textToCursor);

      type InsertMode = 'top-level' | 'expression' | 'member' | 'member-value';
      let mode: InsertMode | null = null;

      if (depth === 0) {
        if (trimmed === '') {
          mode = 'top-level';
        } else if (
          /^export\s+default\s*;?\s*$/.test(trimmed) ||
          /^(?:export\s+)?(?:const|let)\s+\w+\s*=\s*$/.test(trimmed)
        ) {
          mode = 'expression';
        }
      } else if (insideEntities) {
        if (trimmed === '') {
          mode = 'member';
        } else if (/^\w+\s*:\s*$/.test(trimmed)) {
          mode = 'member-value';
        }
      }

      if (!mode) return { suggestions: [] };

      return {
        suggestions: entityTemplates.map(t => ({
          label: t.label,
          kind: m.languages.CompletionItemKind.Snippet,
          insertText: mode === 'top-level' ? t.topLevelText
            : mode === 'expression' ? stripVarDecl(t.topLevelText)
            : mode === 'member' ? t.memberText
            : stripMemberKey(t.memberText),
          insertTextRules: m.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          detail: t.detail,
          documentation: { value: t.documentation },
          sortText: t.sortText,
        })),
      };
    },
  });

  // --- 8. callService Completion Provider ---

  const CompletionItemKind_Property = 9;

  function parseCallServiceContext(text: string): {
    argIndex: number;
    entityId: string;
    serviceName: string;
    insideObject: boolean;
  } | null {
    const csIdx = text.lastIndexOf('callService(');
    if (csIdx === -1) return null;

    const afterCs = text.slice(csIdx + 'callService('.length);

    let parenDepth = 0;
    let braceDepth = 0;
    let inString: string | null = null;
    let argIndex = 0;
    let entityId = '';
    let serviceName = '';
    let currentStringStart = -1;
    let currentStringValue = '';

    for (let i = 0; i < afterCs.length; i++) {
      const ch = afterCs[i];

      if (inString) {
        if (ch === '\\') { i++; continue; }
        if (ch === inString) {
          const val = afterCs.slice(currentStringStart, i);
          if (argIndex === 0 && parenDepth === 0) entityId = val;
          if (argIndex === 1 && parenDepth === 0) serviceName = val;
          inString = null;
        }
        continue;
      }

      if (ch === "'" || ch === '"') {
        inString = ch;
        currentStringStart = i + 1;
        currentStringValue = '';
        continue;
      }

      if (ch === '(') { parenDepth++; continue; }
      if (ch === ')') {
        if (parenDepth > 0) { parenDepth--; continue; }
        return null;
      }
      if (ch === '{') { braceDepth++; continue; }
      if (ch === '}') { braceDepth--; continue; }

      if (ch === ',' && parenDepth === 0 && braceDepth === 0) {
        argIndex++;
      }
    }

    return {
      argIndex,
      entityId,
      serviceName,
      insideObject: braceDepth > 0,
    };
  }

  function getServiceSuggestions(
    entityId: string,
    registry: {
      domains: Record<string, { services: Record<string, { description?: string; fields: Record<string, unknown> }> }>;
      entities: Record<string, { domain: string; services?: string[] }>;
    },
  ) {
    const entity = registry.entities[entityId];
    const domain = entity?.domain ?? entityId;
    const domainData = registry.domains[domain];
    if (!domainData) return [];

    const serviceNames = entity?.services ?? Object.keys(domainData.services);

    return serviceNames.map((svcName, i) => {
      const svc = domainData.services[svcName];
      return {
        label: svcName,
        kind: m.languages.CompletionItemKind.Function,
        insertText: `'${svcName}'`,
        detail: svc?.description ?? `${domain}.${svcName}`,
        sortText: String(i).padStart(3, '0'),
      };
    });
  }

  function getFieldSuggestions(
    entityId: string,
    serviceName: string,
    registry: {
      domains: Record<string, { services: Record<string, { description?: string; fields: Record<string, { type: string; description?: string; required: boolean }> }> }>;
      entities: Record<string, { domain: string; services?: string[] }>;
    },
  ) {
    const entity = registry.entities[entityId];
    const domain = entity?.domain ?? entityId;
    const domainData = registry.domains[domain];
    if (!domainData) return [];

    const svc = domainData.services[serviceName];
    if (!svc) return [];

    return Object.entries(svc.fields).map(([fieldName, field], i) => ({
      label: fieldName,
      kind: CompletionItemKind_Property,
      insertText: `${fieldName}: `,
      detail: field.type + (field.required ? ' (required)' : ''),
      documentation: field.description ? { value: field.description } : undefined,
      sortText: (field.required ? '0_' : '1_') + String(i).padStart(3, '0'),
    }));
  }

  m.languages.registerCompletionItemProvider('typescript', {
    triggerCharacters: ["'", '"', ',', '{', ' '],
    provideCompletionItems: (model: MonacoModelInstance, position: { lineNumber: number; column: number }) => {
      const completionRegistry = host.getCompletionRegistry();
      if (!completionRegistry) return { suggestions: [] };

      const allLines = model.getValue().split('\n');
      const lineContent = allLines[position.lineNumber - 1] ?? '';
      const beforeCursor = lineContent.slice(0, position.column - 1);

      const searchLines: string[] = [beforeCursor];
      for (let i = position.lineNumber - 2; i >= Math.max(0, position.lineNumber - 10); i--) {
        searchLines.unshift(allLines[i]);
        if (allLines[i].includes('callService')) break;
      }
      const searchText = searchLines.join('\n');

      const ctx = parseCallServiceContext(searchText);
      if (!ctx) return { suggestions: [] };

      const registry = completionRegistry as {
        domains: Record<string, { services: Record<string, { description?: string; fields: Record<string, { type: string; description?: string; required: boolean }> }> }>;
        entities: Record<string, { domain: string; services?: string[] }>;
      };

      if (ctx.argIndex === 1) {
        return { suggestions: getServiceSuggestions(ctx.entityId, registry) };
      }

      if (ctx.argIndex === 2 && ctx.insideObject) {
        return { suggestions: getFieldSuggestions(ctx.entityId, ctx.serviceName, registry) };
      }

      return { suggestions: [] };
    },
  });

  // --- 9. Cron Hover Provider ---

  function setupCronHoverProvider(cronstrueLib: Cronstrue) {
    m.languages.registerHoverProvider('typescript', {
      provideHover: (model: MonacoModelInstance, position: { lineNumber: number; column: number }) => {
        if (!isAstReady()) return null;
        const cronStrings = findCronStrings(model.getValue(), model.uri.path || 'file.ts');
        for (const cron of cronStrings) {
          if (position.lineNumber >= cron.startLine && position.lineNumber <= cron.endLine &&
              position.column >= cron.startCol && position.column <= cron.endCol) {
            try {
              const description = cronstrueLib.toString(cron.value, { throwExceptionOnParseError: true });
              return {
                range: new m.Range(cron.startLine, cron.startCol, cron.endLine, cron.endCol),
                contents: [{ value: `**Cron:** ${description}` }],
              };
            } catch {
              return null;
            }
          }
        }
        return null;
      },
    });
  }

  // --- 10. Editor Opener (cross-file navigation) ---

  m.editor.registerEditorOpener({
    openCodeEditor: (source, resource, selectionOrPosition) => {
      const path = resource.path;

      if (!path.startsWith('/') || path.includes('node_modules')) return false;

      const filePath = path.replace(/^\//, '');
      const existing = host.getOpenFiles().find((f) => f.path === filePath);

      if (existing) {
        host.setActiveFile(filePath);
        source.setModel(existing.model);
        host.requestUpdate();
      } else {
        host.openFile(filePath);
      }

      if (selectionOrPosition && m.Range.isIRange(selectionOrPosition)) {
        source.revealRangeInCenterIfOutsideViewport(selectionOrPosition);
        source.setSelection(selectionOrPosition);
      } else if (selectionOrPosition) {
        source.revealPositionInCenterIfOutsideViewport(selectionOrPosition);
        source.setPosition(selectionOrPosition);
      }

      return true;
    },
  });

  // --- Return handles ---

  return {
    refreshCodeLenses() {
      console.debug(`[ha-forge] CodeLens refresh, ${codeLensChangeListeners.length} listeners`);
      for (const listener of codeLensChangeListeners) listener();
    },
    refreshInlayHints() {
      for (const listener of inlayHintChangeListeners) listener();
    },
    setCronstrue(lib: Cronstrue) {
      cronstrue = lib;
      setupCronHoverProvider(lib);
    },
  };
}
