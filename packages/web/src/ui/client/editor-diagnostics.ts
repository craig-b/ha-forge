import type { Monaco, MonacoMarkerData, MonacoCodeAction, MonacoRange, MonacoModelInstance, MonacoEditorInstance, MonacoDecorationOptions, MonacoDecorationsCollection } from './monaco-types.js';
import { runAllAnalyzers, setAstAnalyzerActive, type AnalyzerDiagnostic } from './analyzers.js';
import { analyzeWithAst, isReady as isAstReady, generateDeviceRefactor, generateMoveIntoDevice, generateSensorToComputed, getDeviceInfoInsertion, findEntityDefinitions } from './ast-analyzers.js';
import type { EntityInfo } from './types.js';

const DIAG_OWNER = 'ha-forge-lint';
const AST_DIAG_OWNER = 'ha-forge-ast';
const CS_DIAG_OWNER = 'ha-forge-callservice';
const DIAG_DEBOUNCE = 300;

const MINIMAP_COLORS: Record<string, string> = {
  sensor: '#4FC3F7',
  binary_sensor: '#4FC3F7',
  light: '#FFD54F',
  switch: '#81C784',
  cover: '#A1887F',
  climate: '#FF8A65',
  fan: '#80CBC4',
  lock: '#E57373',
  number: '#9575CD',
  select: '#9575CD',
  text: '#9575CD',
  button: '#F06292',
  notify: '#F06292',
  update: '#81C784',
  image: '#4DB6AC',
  device: '#66BB6A',
};
const MINIMAP_DEFAULT_COLOR = '#90A4AE';

export interface DiagnosticsHost {
  getEntities(): EntityInfo[];
  getActiveFile(): string | null;
  getCompletionRegistry(): {
    domains: Record<string, { services: Record<string, { fields: Record<string, { type: string; description?: string; required: boolean }> }> }>;
    entities: Record<string, { domain: string; services?: string[]; states: string[] }>;
  } | null;
  onDiagnosticsRun(): void;
}

export function setupDiagnostics(m: Monaco, editor: MonacoEditorInstance, host: DiagnosticsHost): void {
  let diagTimer: ReturnType<typeof setTimeout> | null = null;
  let csDiagLines = new Set<number>();
  let minimapDecorations: MonacoDecorationsCollection | null = null;

  function toMarker(d: AnalyzerDiagnostic, source: string): MonacoMarkerData {
    return {
      severity: d.severity === 'error' ? m.MarkerSeverity.Error
        : d.severity === 'warning' ? m.MarkerSeverity.Warning
        : m.MarkerSeverity.Info,
      message: d.message,
      startLineNumber: d.startLine,
      startColumn: d.startCol,
      endLineNumber: d.endLine,
      endColumn: d.endCol,
      source,
    };
  }

  function quickFix(
    model: MonacoModelInstance,
    marker: MonacoMarkerData,
    title: string,
    range: MonacoRange,
    text: string,
  ): MonacoCodeAction {
    return {
      title,
      diagnostics: [marker],
      kind: 'quickfix',
      edit: {
        edits: [{ resource: model.uri, textEdit: { range, text }, versionId: model.getVersionId() }],
      },
      isPreferred: true,
    };
  }

  function refactorAction(
    model: MonacoModelInstance,
    title: string,
    range: MonacoRange,
    text: string,
  ): MonacoCodeAction {
    return {
      title,
      diagnostics: [],
      kind: 'refactor',
      edit: {
        edits: [{ resource: model.uri, textEdit: { range, text }, versionId: model.getVersionId() }],
      },
      isPreferred: false,
    };
  }

  function updateMinimapDecorations(sourceText: string, fileName: string) {
    if (!minimapDecorations) {
      minimapDecorations = editor.createDecorationsCollection();
    }

    const defs = findEntityDefinitions(sourceText, fileName);
    const decorations: MonacoDecorationOptions[] = defs.map(def => {
      const color = MINIMAP_COLORS[def.domain] ?? MINIMAP_DEFAULT_COLOR;
      return {
        range: new m.Range(def.line, 1, def.endLine, 1),
        options: {
          isWholeLine: true,
          minimap: { color, position: 1 },
          overviewRuler: { color, position: 4 },
        },
      };
    });

    minimapDecorations.set(decorations);
  }

  function runCallServiceDiagnostics(sourceText: string): { markers: MonacoMarkerData[]; suppressLines: Set<number> } {
    const completionRegistry = host.getCompletionRegistry();
    if (!completionRegistry) return { markers: [], suppressLines: new Set() };

    const registry = completionRegistry as {
      domains: Record<string, { services: Record<string, { fields: Record<string, { type: string; description?: string; required: boolean }> }> }>;
      entities: Record<string, { domain: string; services?: string[] }>;
    };

    const markers: MonacoMarkerData[] = [];
    const suppressLines = new Set<number>();
    const lines = sourceText.split('\n');

    const csRegex = /\.callService\s*\(/g;
    let match: RegExpExecArray | null;
    while ((match = csRegex.exec(sourceText)) !== null) {
      const afterOpen = match.index + match[0].length;
      const parsed = parseCallServiceFull(sourceText, afterOpen);
      if (!parsed || !parsed.dataKeys.length) continue;

      const entity = registry.entities[parsed.entityId];
      const domain = entity?.domain ?? parsed.entityId;
      const domainData = registry.domains[domain];
      if (!domainData) continue;

      const svc = domainData.services[parsed.serviceName];
      if (!svc) continue;

      const validKeys = Object.keys(svc.fields);
      let hasErrors = false;

      for (const key of parsed.dataKeys) {
        if (key.name in svc.fields) continue;

        hasErrors = true;
        const suggestion = findClosestMatch(key.name, validKeys);
        const suggestionMsg = suggestion
          ? `. Did you mean '${suggestion}'?`
          : '';
        const validList = validKeys.length > 0
          ? `\nValid fields: ${validKeys.join(', ')}`
          : '';

        const pos = offsetToLineCol(lines, key.offset);
        markers.push({
          severity: m.MarkerSeverity.Error,
          message: `Unknown field '${key.name}' for ${domain}.${parsed.serviceName}${suggestionMsg}${validList}`,
          startLineNumber: pos.line,
          startColumn: pos.col,
          endLineNumber: pos.line,
          endColumn: pos.col + key.name.length,
          source: CS_DIAG_OWNER,
          code: suggestion ? `suggest:${suggestion}` : undefined,
        });
      }

      if (hasErrors) {
        const csLine = offsetToLineCol(lines, match.index).line;
        suppressLines.add(csLine);
        suppressLines.add(csLine + 1);
      }
    }

    return { markers, suppressLines };
  }

  function runStateDiagnostics(sourceText: string): MonacoMarkerData[] {
    const completionRegistry = host.getCompletionRegistry();
    if (!completionRegistry) return [];

    const registry = completionRegistry as {
      entities: Record<string, { domain: string; states: string[] }>;
    };

    const markers: MonacoMarkerData[] = [];
    const lines = sourceText.split('\n');

    const ruleRegex = /\.(?:reactions|watchdog)\s*\(\s*\{/g;
    let match: RegExpExecArray | null;
    while ((match = ruleRegex.exec(sourceText)) !== null) {
      const isWatchdog = match[0].includes('watchdog');
      const objStart = match.index + match[0].length;
      const entries = parseEntityRuleEntries(sourceText, objStart);

      for (const entry of entries) {
        const entityData = registry.entities[entry.entityId];
        if (!entityData || entityData.states.length === 0) continue;

        for (const toValue of entry.toValues) {
          if (entityData.states.includes(toValue.value)) continue;

          const suggestion = findClosestMatch(toValue.value, entityData.states);
          const suggestionMsg = suggestion ? `. Did you mean '${suggestion}'?` : '';
          const method = isWatchdog ? 'watchdog' : 'reactions';

          const pos = offsetToLineCol(lines, toValue.offset);
          markers.push({
            severity: m.MarkerSeverity.Error,
            message: `Invalid state '${toValue.value}' for ${entry.entityId}${suggestionMsg}\nValid states: ${entityData.states.join(', ')}`,
            startLineNumber: pos.line,
            startColumn: pos.col,
            endLineNumber: pos.line,
            endColumn: pos.col + toValue.value.length + 2,
            source: CS_DIAG_OWNER,
            code: suggestion ? `suggest-state:${suggestion}:${pos.col}` : undefined,
          });
        }
      }
    }

    return markers;
  }

  function runDiagnostics() {
    const model = editor.getModel();
    if (!model) return;

    const sourceText = model.getValue();

    const diagnostics = runAllAnalyzers(sourceText);
    const markers: MonacoMarkerData[] = diagnostics.map((d) => toMarker(d, DIAG_OWNER));
    m.editor.setModelMarkers(model, DIAG_OWNER, markers);

    if (isAstReady()) {
      const result = analyzeWithAst(sourceText, model.uri.path || 'file.ts');

      const currentFile = host.getActiveFile();
      if (currentFile) {
        const entities = host.getEntities();
        if (entities.length > 0) {
          for (const entity of result.entities) {
            const deployed = entities.find(
              (e) => e.id === entity.id && e.sourceFile && e.sourceFile !== currentFile,
            );
            if (deployed) {
              result.diagnostics.push({
                startLine: entity.line,
                startCol: entity.startCol,
                endLine: entity.line,
                endCol: entity.endCol,
                message: `Duplicate entity ID '${entity.id}' (already deployed from ${deployed.sourceFile})`,
                severity: 'error',
              });
            }
          }
        }
      }

      const astMarkers: MonacoMarkerData[] = result.diagnostics.map((d) => toMarker(d, AST_DIAG_OWNER));
      m.editor.setModelMarkers(model, AST_DIAG_OWNER, astMarkers);

      updateMinimapDecorations(sourceText, model.uri.path || 'file.ts');
    }

    const { markers: csMarkers, suppressLines } = runCallServiceDiagnostics(sourceText);
    const stateMarkers = runStateDiagnostics(sourceText);
    csDiagLines = suppressLines;
    m.editor.setModelMarkers(model, CS_DIAG_OWNER, [...csMarkers, ...stateMarkers]);

    host.onDiagnosticsRun();
  }

  // Run diagnostics on content change (debounced)
  editor.onDidChangeModelContent(() => {
    if (diagTimer) clearTimeout(diagTimer);
    diagTimer = setTimeout(() => runDiagnostics(), DIAG_DEBOUNCE);
  });

  // Suppress TS overload errors (2769) on lines where we have our own callService diagnostics
  m.editor.onDidChangeMarkers(() => {
    const model = editor.getModel();
    if (!model || csDiagLines.size === 0) return;
    const tsMarkers = m.editor.getModelMarkers({ resource: model.uri, owner: 'typescript' });
    const filtered = tsMarkers.filter(m2 => !(String(m2.code) === '2769' && csDiagLines.has(m2.startLineNumber)));
    if (filtered.length < tsMarkers.length) {
      m.editor.setModelMarkers(model, 'typescript', filtered);
    }
  });

  // Quick-fix code actions
  m.languages.registerCodeActionProvider('typescript', {
    provideCodeActions: (model: MonacoModelInstance, range: MonacoRange, context: { markers: MonacoMarkerData[] }) => {
      const actions: MonacoCodeAction[] = [];

      if (isAstReady()) {
        const filePath = model.uri.path || 'file.ts';
        const insertion = getDeviceInfoInsertion(model.getValue(), filePath, range.startLineNumber);
        if (insertion) {
          actions.push(refactorAction(model,
            'Fill in device info (derived from filename)',
            new m.Range(insertion.insertLine, insertion.insertCol, insertion.insertLine, insertion.insertCol),
            insertion.text,
          ));
        }
      }

      for (const marker of context.markers) {
        if (marker.source === CS_DIAG_OWNER && typeof marker.code === 'string' && marker.code.startsWith('suggest:')) {
          const suggested = marker.code.slice('suggest:'.length);
          actions.push(quickFix(model, marker,
            `Replace with '${suggested}'`,
            new m.Range(marker.startLineNumber, marker.startColumn, marker.endLineNumber, marker.endColumn),
            suggested,
          ));
        }

        if (marker.source === CS_DIAG_OWNER && typeof marker.code === 'string' && marker.code.startsWith('suggest-state:')) {
          const parts = marker.code.split(':');
          const suggested = parts[1];
          actions.push(quickFix(model, marker,
            `Replace with '${suggested}'`,
            new m.Range(marker.startLineNumber, marker.startColumn, marker.endLineNumber, marker.endColumn),
            `'${suggested}'`,
          ));
        }

        if (marker.source !== DIAG_OWNER && marker.source !== AST_DIAG_OWNER) continue;

        if (marker.message.includes('is not exported')) {
          actions.push(quickFix(model, marker,
            "Add 'export' to this declaration",
            new m.Range(marker.startLineNumber, 1, marker.startLineNumber, 1),
            'export ',
          ));
        }

        if (marker.message.startsWith('Do not await')) {
          const line = model.getValue().split('\n')[marker.startLineNumber - 1];
          const awaitMatch = line.match(/^(\s*)(await\s+)/);
          if (awaitMatch) {
            const col = awaitMatch[1].length + 1;
            actions.push(quickFix(model, marker,
              'Remove await',
              new m.Range(marker.startLineNumber, col, marker.startLineNumber, col + awaitMatch[2].length),
              '',
            ));
          }
        }

        const timerMatch = marker.message.match(/^Use (this\.(?:setTimeout|setInterval))\(\) instead of (setTimeout|setInterval)\(\)/);
        if (timerMatch) {
          actions.push(quickFix(model, marker,
            `Replace with ${timerMatch[1]}()`,
            new m.Range(marker.startLineNumber, marker.startColumn, marker.endLineNumber, marker.endColumn),
            timerMatch[1],
          ));
        }

        const snakeMatch = marker.message.match(/^Entity ID '(.+?)' should be snake_case \(suggested: '(.+?)'\)$/);
        if (snakeMatch) {
          const suggested = snakeMatch[2];
          actions.push(quickFix(model, marker,
            `Change ID to '${suggested}'`,
            new m.Range(marker.startLineNumber, marker.startColumn + 1, marker.endLineNumber, marker.endColumn - 1),
            suggested,
          ));
        }

        const bareMatch = marker.message.match(/\[export const (\w+)\]$/);
        if (bareMatch) {
          const varName = bareMatch[1];
          actions.push(quickFix(model, marker,
            `Export as '${varName}'`,
            new m.Range(marker.startLineNumber, marker.startColumn, marker.startLineNumber, marker.startColumn),
            `export const ${varName} = `,
          ));
        }

        const nameMatch = marker.message.match(/(?:missing required 'name' property|name must not be empty) \(suggested: '(.+?)'\)$/);
        if (nameMatch) {
          const suggested = nameMatch[1];
          if (marker.message.includes('must not be empty')) {
            actions.push(quickFix(model, marker,
              `Set name to '${suggested}'`,
              new m.Range(marker.startLineNumber, marker.startColumn, marker.endLineNumber, marker.endColumn),
              `'${suggested}'`,
            ));
          } else {
            const lines = model.getValue().split('\n');
            for (let i = marker.startLineNumber - 1; i < Math.min(marker.endLineNumber + 5, lines.length); i++) {
              if (/^\s*id:\s*['"]/.test(lines[i])) {
                const indent = lines[i].match(/^(\s*)/)?.[1] ?? '';
                actions.push(quickFix(model, marker,
                  `Add name: '${suggested}'`,
                  new m.Range(i + 1, lines[i].length + 1, i + 1, lines[i].length + 1),
                  `\n${indent}name: '${suggested}',`,
                ));
                break;
              }
            }
          }
        }

        const unitMatch = marker.message.match(/should have unit_of_measurement \(typically '(.+?)'\)$/);
        if (unitMatch) {
          const unit = unitMatch[1];
          const line = model.getValue().split('\n')[marker.startLineNumber - 1];
          const indent = line.match(/^(\s*)/)?.[1] ?? '';
          actions.push(quickFix(model, marker,
            `Add unit_of_measurement: '${unit}'`,
            new m.Range(marker.startLineNumber, line.length + 1, marker.startLineNumber, line.length + 1),
            `\n${indent}unit_of_measurement: '${unit}',`,
          ));
        }

        if (marker.message.includes('[ha-forge:device-refactor]')) {
          const source = model.getValue();
          const filePath = model.uri.path || 'file.ts';
          const refactored = generateDeviceRefactor(source, filePath);
          if (refactored) {
            const lineCount = source.split('\n').length;
            actions.push(quickFix(model, marker,
              'Wrap entities in device()',
              new m.Range(1, 1, lineCount, source.split('\n')[lineCount - 1].length + 1),
              refactored,
            ));
          }
        }

        if (marker.message.includes('[ha-forge:suggest-computed]')) {
          const source = model.getValue();
          const filePath = model.uri.path || 'file.ts';
          const edit = generateSensorToComputed(source, filePath, marker.startLineNumber);
          if (edit) {
            const lines = source.split('\n');
            const endCol = lines[edit.endLine - 1].length + 1;
            actions.push(quickFix(model, marker,
              'Convert to computed()',
              new m.Range(edit.startLine, 1, edit.endLine, endCol),
              edit.text,
            ));
          }
        }

        if (marker.message.includes('[ha-forge:move-into-device]')) {
          const source = model.getValue();
          const filePath = model.uri.path || 'file.ts';
          const edit = generateMoveIntoDevice(source, filePath, marker.startLineNumber);
          if (edit) {
            const lines = source.split('\n');
            let delEnd = edit.deleteEndLine;
            if (delEnd < lines.length && lines[delEnd].trim() === '') delEnd++;
            const deleteRange = new m.Range(edit.deleteStartLine, 1, delEnd + 1, 1);
            const insertRange = new m.Range(edit.insertLine, edit.insertCol, edit.insertLine, edit.insertCol);
            actions.push({
              title: `Move '${edit.memberKey}' into device entities`,
              diagnostics: [marker],
              kind: 'quickfix',
              edit: {
                edits: [
                  { resource: model.uri, textEdit: { range: insertRange, text: edit.insertText }, versionId: model.getVersionId() },
                  { resource: model.uri, textEdit: { range: deleteRange, text: '' }, versionId: model.getVersionId() },
                ],
              },
              isPreferred: true,
            });
          }
        }
      }
      return { actions, dispose() {} };
    },
  });
}

// ---- Utility functions ----

function parseEntityRuleEntries(
  text: string, startOffset: number,
): Array<{ entityId: string; toValues: Array<{ value: string; offset: number }> }> {
  const entries: Array<{ entityId: string; toValues: Array<{ value: string; offset: number }> }> = [];
  let i = startOffset;

  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i])) i++;
    if (i >= text.length || text[i] === '}') break;

    if (text[i] === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (text[i] === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length - 1 && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2; continue;
    }

    if (text[i] !== "'" && text[i] !== '"') {
      i = skipValue(text, i);
      continue;
    }
    const q = text[i]; i++;
    const keyStart = i;
    while (i < text.length && text[i] !== q) {
      if (text[i] === '\\') i++;
      i++;
    }
    const entityId = text.slice(keyStart, i);
    i++;

    while (i < text.length && /\s/.test(text[i])) i++;
    if (text[i] !== ':') { i++; continue; }
    i++;

    while (i < text.length && /\s/.test(text[i])) i++;

    if (text[i] !== '{') {
      i = skipValue(text, i);
      continue;
    }
    i++;

    const toValues: Array<{ value: string; offset: number }> = [];
    let ruleDepth = 0;

    while (i < text.length) {
      while (i < text.length && /\s/.test(text[i])) i++;
      if (i >= text.length) break;
      if (text[i] === '}') {
        if (ruleDepth === 0) { i++; break; }
        ruleDepth--; i++; continue;
      }

      if (text[i] === '/' && text[i + 1] === '/') {
        while (i < text.length && text[i] !== '\n') i++;
        continue;
      }
      if (text[i] === '/' && text[i + 1] === '*') {
        i += 2;
        while (i < text.length - 1 && !(text[i] === '*' && text[i + 1] === '/')) i++;
        i += 2; continue;
      }

      let propName = '';
      if (text[i] === "'" || text[i] === '"') {
        const pq = text[i]; i++;
        const ps = i;
        while (i < text.length && text[i] !== pq) { if (text[i] === '\\') i++; i++; }
        propName = text.slice(ps, i);
        i++;
      } else if (/[a-zA-Z_$]/.test(text[i])) {
        const ps = i;
        while (i < text.length && /[\w$]/.test(text[i])) i++;
        propName = text.slice(ps, i);
      } else {
        i = skipValue(text, i);
        continue;
      }

      while (i < text.length && /\s/.test(text[i])) i++;
      if (text[i] !== ':') { i++; continue; }
      i++;
      while (i < text.length && /\s/.test(text[i])) i++;

      if (propName === 'to' && ruleDepth <= 1 && (text[i] === "'" || text[i] === '"')) {
        const vq = text[i]; i++;
        const vs = i;
        const valOffset = vs - 1;
        while (i < text.length && text[i] !== vq) { if (text[i] === '\\') i++; i++; }
        toValues.push({ value: text.slice(vs, i), offset: valOffset });
        i++;
      } else if (propName === 'expect' && text[i] === '{') {
        ruleDepth++;
        i++;
        continue;
      } else {
        i = skipValue(text, i);
      }

      while (i < text.length && /\s/.test(text[i])) i++;
      if (i < text.length && text[i] === ',') i++;
    }

    entries.push({ entityId, toValues });

    while (i < text.length && /\s/.test(text[i])) i++;
    if (i < text.length && text[i] === ',') i++;
  }

  return entries;
}

function skipValue(text: string, start: number): number {
  let i = start;
  let depth = 0;

  while (i < text.length) {
    const ch = text[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      i++;
      while (i < text.length) {
        if (text[i] === '\\') { i += 2; continue; }
        if (text[i] === ch) { i++; break; }
        i++;
      }
      if (depth === 0) return i;
      continue;
    }
    if (ch === '{' || ch === '[' || ch === '(') { depth++; i++; continue; }
    if (ch === '}' || ch === ']' || ch === ')') {
      if (depth > 0) { depth--; i++; continue; }
      return i;
    }
    if ((ch === ',' || ch === ';') && depth === 0) return i;
    i++;
  }
  return i;
}

function parseCallServiceFull(
  text: string, startOffset: number,
): { entityId: string; serviceName: string; dataKeys: Array<{ name: string; offset: number }> } | null {
  let i = startOffset;
  let parenDepth = 0;
  let braceDepth = 0;
  let inString: string | null = null;
  let argIndex = 0;
  let entityId = '';
  let serviceName = '';
  let stringStart = -1;
  const dataKeys: Array<{ name: string; offset: number }> = [];

  while (i < text.length) {
    const ch = text[i];

    if (inString) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === inString) {
        const val = text.slice(stringStart, i);
        if (argIndex === 0 && parenDepth === 0) entityId = val;
        if (argIndex === 1 && parenDepth === 0) serviceName = val;
        inString = null;
      }
      i++; continue;
    }

    if (ch === "'" || ch === '"') {
      inString = ch;
      stringStart = i + 1;
      i++; continue;
    }

    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }

    if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length - 1 && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2; continue;
    }

    if (ch === '(') { parenDepth++; i++; continue; }
    if (ch === ')') {
      if (parenDepth > 0) { parenDepth--; i++; continue; }
      break;
    }

    if (ch === '{') {
      braceDepth++;
      if (argIndex === 2 && braceDepth === 1) {
        i++;
        while (i < text.length) {
          while (i < text.length && /\s/.test(text[i])) i++;
          if (i >= text.length || text[i] === '}') break;

          if (text[i] === '/' && text[i + 1] === '/') {
            while (i < text.length && text[i] !== '\n') i++;
            continue;
          }
          if (text[i] === '/' && text[i + 1] === '*') {
            i += 2;
            while (i < text.length - 1 && !(text[i] === '*' && text[i + 1] === '/')) i++;
            i += 2; continue;
          }

          let keyName = '';
          const keyOffset = i;
          if (text[i] === "'" || text[i] === '"') {
            const q = text[i]; i++;
            const ks = i;
            while (i < text.length && text[i] !== q) {
              if (text[i] === '\\') i++;
              i++;
            }
            keyName = text.slice(ks, i);
            i++;
          } else if (/[a-zA-Z_$]/.test(text[i])) {
            const ks = i;
            while (i < text.length && /[\w$]/.test(text[i])) i++;
            keyName = text.slice(ks, i);
          } else {
            i++; continue;
          }

          while (i < text.length && /\s/.test(text[i])) i++;
          if (text[i] !== ':') { i++; continue; }
          i++;

          if (keyName) {
            dataKeys.push({ name: keyName, offset: keyOffset });
          }

          let vDepth = 0;
          while (i < text.length) {
            const vc = text[i];
            if (vc === "'" || vc === '"' || vc === '`') {
              i++;
              while (i < text.length) {
                if (text[i] === '\\') { i += 2; continue; }
                if (text[i] === vc) { i++; break; }
                i++;
              }
              continue;
            }
            if (vc === '{' || vc === '[' || vc === '(') { vDepth++; i++; continue; }
            if (vc === '}' || vc === ']' || vc === ')') {
              if (vDepth > 0) { vDepth--; i++; continue; }
              break;
            }
            if (vc === ',' && vDepth === 0) { i++; break; }
            i++;
          }
        }
        if (i < text.length && text[i] === '}') { braceDepth--; i++; }
        continue;
      }
      i++; continue;
    }
    if (ch === '}') { braceDepth--; i++; continue; }

    if (ch === ',' && parenDepth === 0 && braceDepth === 0) {
      argIndex++;
    }
    i++;
  }

  if (!entityId || !serviceName) return null;
  return { entityId, serviceName, dataKeys };
}

function offsetToLineCol(lines: string[], offset: number): { line: number; col: number } {
  let remaining = offset;
  for (let i = 0; i < lines.length; i++) {
    if (remaining <= lines[i].length) {
      return { line: i + 1, col: remaining + 1 };
    }
    remaining -= lines[i].length + 1;
  }
  return { line: lines.length, col: 1 };
}

function findClosestMatch(input: string, candidates: string[]): string | null {
  if (candidates.length === 0) return null;
  const lower = input.toLowerCase();

  const prefixMatch = candidates.find((c) => c.toLowerCase().startsWith(lower));
  if (prefixMatch) return prefixMatch;

  const revPrefix = candidates.find((c) => lower.startsWith(c.toLowerCase()));
  if (revPrefix) return revPrefix;

  const subMatch = candidates.find((c) => c.toLowerCase().includes(lower) || lower.includes(c.toLowerCase()));
  if (subMatch) return subMatch;

  let bestDist = 4;
  let bestMatch: string | null = null;
  for (const c of candidates) {
    const dist = levenshtein(lower, c.toLowerCase());
    if (dist < bestDist) {
      bestDist = dist;
      bestMatch = c;
    }
  }
  return bestMatch;
}

function levenshtein(a: string, b: string): number {
  const m2 = a.length, n = b.length;
  if (m2 === 0) return n;
  if (n === 0) return m2;

  const row = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m2; i++) {
    let prev = i - 1;
    row[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const val = Math.min(row[j] + 1, row[j - 1] + 1, prev + cost);
      prev = row[j];
      row[j] = val;
    }
  }
  return row[n];
}
