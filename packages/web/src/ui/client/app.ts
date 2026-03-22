import { LitElement, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import type { FileEntry, OpenFile, BuildStep, EntityInfo, LogEntry } from './types.js';
import { runAllAnalyzers, findEntitySymbols, setAstAnalyzerActive, type AnalyzerDiagnostic } from './analyzers.js';
import { setTypeScriptApi, analyzeWithAst, isReady as isAstReady, generateDeviceRefactor, generateMoveIntoDevice, generateSensorToComputed, getDeviceInfoInsertion, findCronStrings, findEntityDefinitions, FACTORY_DOMAINS } from './ast-analyzers.js';

import './components/tse-header.js';
import './components/tse-sidebar.js';
import './components/tse-editor-tabs.js';
import './components/tse-bottom-panel.js';

// Minimal Monaco type declarations for what we use
declare const require: {
  config(opts: Record<string, unknown>): void;
  (deps: string[], cb: (...args: never[]) => void, errCb?: (err: unknown) => void): void;
};

interface MonacoMarkerData {
  severity: number;
  message: string;
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
  source?: string;
}

interface MonacoCodeAction {
  title: string;
  diagnostics: MonacoMarkerData[];
  kind: string;
  edit: { edits: Array<{ resource: unknown; textEdit: { range: unknown; text: string }; versionId: number }> };
  isPreferred: boolean;
}

interface MonacoRange {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

interface MonacoDocumentSymbol {
  name: string;
  detail: string;
  kind: number;
  range: MonacoRange;
  selectionRange: MonacoRange;
  tags?: number[];
}

declare const monaco: {
  editor: {
    create(el: HTMLElement, opts: Record<string, unknown>): MonacoEditorInstance;
    createModel(content: string, language: string, uri: unknown): MonacoModelInstance;
    getModel(uri: unknown): MonacoModelInstance | null;
    setModelMarkers(model: MonacoModelInstance, owner: string, markers: MonacoMarkerData[]): void;
    getModelMarkers(filter: { resource?: unknown; owner?: string }): MonacoMarkerData[];
    onDidChangeMarkers(listener: (uris: unknown[]) => void): { dispose(): void };
    registerEditorOpener(opener: {
      openCodeEditor(
        source: MonacoEditorInstance & {
          revealRangeInCenterIfOutsideViewport(range: unknown): void;
          setSelection(range: unknown): void;
          revealPositionInCenterIfOutsideViewport(pos: unknown): void;
          setPosition(pos: unknown): void;
        },
        resource: { path: string; toString(): string },
        selectionOrPosition: unknown,
      ): boolean;
    }): { dispose(): void };
  };
  languages: {
    typescript: {
      typescriptDefaults: {
        setCompilerOptions(opts: Record<string, unknown>): void;
        setDiagnosticsOptions(opts: Record<string, unknown>): void;
        addExtraLib(content: string, uri: string): void;
      };
      ScriptTarget: { ESNext: number };
      ModuleResolutionKind: { NodeJs: number };
      ModuleKind: { ESNext: number };
    };
    registerCodeActionProvider(languageId: string, provider: {
      provideCodeActions(model: MonacoModelInstance, range: unknown, context: { markers: MonacoMarkerData[] }): { actions: MonacoCodeAction[]; dispose(): void };
    }): void;
    registerDocumentSymbolProvider(languageId: string, provider: {
      displayName?: string;
      provideDocumentSymbols(model: MonacoModelInstance): MonacoDocumentSymbol[];
    }): { dispose(): void };
    registerHoverProvider(languageId: string, provider: {
      provideHover(model: MonacoModelInstance, position: { lineNumber: number; column: number }): { range: MonacoRange; contents: Array<{ value: string }> } | null;
    }): { dispose(): void };
    registerCodeLensProvider(languageId: string, provider: {
      onDidChange?: { (listener: () => void): { dispose(): void } };
      provideCodeLenses(model: MonacoModelInstance): { lenses: Array<{ range: MonacoRange; command?: { id: string; title: string } }>; dispose(): void };
    }): { dispose(): void };
    registerDocumentHighlightProvider(languageId: string, provider: {
      provideDocumentHighlights(model: MonacoModelInstance, position: { lineNumber: number; column: number }): Array<{ range: MonacoRange; kind?: number }>;
    }): { dispose(): void };
    registerCompletionItemProvider(languageId: string, provider: {
      triggerCharacters?: string[];
      provideCompletionItems(model: MonacoModelInstance, position: { lineNumber: number; column: number }): { suggestions: Array<{ label: string; kind: number; insertText: string; insertTextRules?: number; detail?: string; documentation?: string | { value: string }; range?: MonacoRange; sortText?: string }> };
    }): { dispose(): void };
    CompletionItemKind: { Snippet: number; Function: number; Text: number };
    CompletionItemInsertTextRule: { InsertAsSnippet: number };
    DocumentHighlightKind: { Text: number; Read: number; Write: number };
    SymbolKind: { Variable: number; Function: number; Module: number };
  };
  MarkerSeverity: { Error: number; Warning: number; Info: number; Hint: number };
  Range: {
    new (startLine: number, startCol: number, endLine: number, endCol: number): MonacoRange;
    isIRange(val: unknown): boolean;
  };
  Uri: { parse(uri: string): { path: string; toString(): string } };
};

interface MonacoModelInstance {
  getValue(): string;
  setValue(value: string): void;
  onDidChangeContent(listener: () => void): { dispose(): void };
  getVersionId(): number;
  uri: { path: string; toString(): string };
  dispose(): void;
  updateOptions(opts: { readOnly?: boolean }): void;
}

interface MonacoDecorationOptions {
  range: MonacoRange;
  options: {
    isWholeLine?: boolean;
    minimap?: { color: string; position: number };
    overviewRuler?: { color: string; position: number };
  };
}

interface MonacoDecorationsCollection {
  set(decorations: MonacoDecorationOptions[]): void;
  clear(): void;
}

interface MonacoEditorInstance {
  setModel(model: MonacoModelInstance | null): void;
  getModel(): MonacoModelInstance | null;
  onDidChangeModelContent(listener: () => void): { dispose(): void };
  setPosition(pos: { lineNumber: number; column: number }): void;
  revealPositionInCenterIfOutsideViewport(pos: { lineNumber: number; column: number }): void;
  createDecorationsCollection(decorations?: MonacoDecorationOptions[]): MonacoDecorationsCollection;
}

interface OpenFileInternal {
  path: string;
  content: string;
  modified: boolean;
  model: MonacoModelInstance;
}

@customElement('tse-app')
export class TseApp extends LitElement {
  @state() private _files: FileEntry[] = [];
  @state() private _openFiles: OpenFileInternal[] = [];
  @state() private _activeFile: string | null = null;
  @state() private _building = false;
  @state() private _statusText = 'Ready';
  @state() private _statusClass = 'ready';
  @state() private _buildSteps: BuildStep[] = [];
  @state() private _buildMessages: string[] = [];
  @state() private _entities: EntityInfo[] = [];
  @state() private _logs: LogEntry[] = [];
  @state() private _logEntityIds: string[] = [];
  private _logFilter: { level?: string; entity_id?: string; search?: string } = {};

  private _editor: MonacoEditorInstance | null = null;
  private _completionRegistry: { domains: Record<string, unknown>; entities: Record<string, unknown> } | null = null;
  private _base = (window as Record<string, unknown>).__INGRESS_PATH__ as string || '';

  createRenderRoot() { return this; }

  connectedCallback() {
    super.connectedCallback();
    this._initMonaco();
    this._setupKeyboard();
    this._connectWebSocket();

    this.addEventListener('tse-build', () => this._triggerBuild());
    this.addEventListener('tse-regen-types', () => this._regenTypes());
    this.addEventListener('tse-open-file', ((e: CustomEvent) => this._openFile(e.detail.path)) as EventListener);
    this.addEventListener('tse-new-file', () => this._createNewFile());
    this.addEventListener('tse-activate-file', ((e: CustomEvent) => this._activateFile(e.detail.path)) as EventListener);
    this.addEventListener('tse-close-file', ((e: CustomEvent) => this._closeFile(e.detail.path)) as EventListener);
    this.addEventListener('tse-delete-file', ((e: CustomEvent) => this._deleteFile(e.detail.path)) as EventListener);
    this.addEventListener('tse-rename-file', ((e: CustomEvent) => this._renameFile(e.detail.oldPath, e.detail.newPath)) as EventListener);
    this.addEventListener('tse-open-diagnostic', ((e: CustomEvent) => this._openDiagnostic(e.detail.file, e.detail.line, e.detail.column)) as EventListener);
    this.addEventListener('tse-panel-change', ((e: CustomEvent) => this._onPanelChange(e.detail.panel)) as EventListener);
    this.addEventListener('tse-filter-change', ((e: CustomEvent) => {
      this._logFilter = e.detail;
      this._loadLogs(e.detail);
    }) as EventListener);
  }

  render() {
    const openFilesForTabs: OpenFile[] = this._openFiles.map((f) => ({
      path: f.path, content: f.content, modified: f.modified, model: null,
    }));

    return html`
      <tse-header
        ?building=${this._building}
        .statusText=${this._statusText}
        .statusClass=${this._statusClass}
      ></tse-header>

      <div id="main">
        <tse-sidebar .files=${this._files} .activeFile=${this._activeFile}></tse-sidebar>

        <div id="content">
          <div id="editor-container">
            <div class="editor-tabs">
              <tse-editor-tabs .openFiles=${openFilesForTabs} .activeFile=${this._activeFile}></tse-editor-tabs>
            </div>
            <div id="monaco-editor"></div>
          </div>
          <tse-bottom-panel
            .buildSteps=${this._buildSteps}
            .buildMessages=${this._buildMessages}
            .entities=${this._entities}
            .logs=${this._logs}
            .logEntityIds=${this._logEntityIds}
          ></tse-bottom-panel>
        </div>
      </div>
    `;
  }

  // ---- API helper ----

  private _api(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
    const opts: RequestInit = { method, headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    return fetch(this._base + path, opts).then((res) => {
      if (!res.ok) console.warn(`[ha-forge] API ${method} ${path} returned ${res.status}`);
      return res.json() as Promise<Record<string, unknown>>;
    });
  }

  // ---- Monaco ----

  private _initMonaco() {
    require.config({
      paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.55.1/min/vs' },
    });

    require(['vs/editor/editor.main'], () => {
      monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
        target: monaco.languages.typescript.ScriptTarget.ESNext,
        moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
        module: monaco.languages.typescript.ModuleKind.ESNext,
        strict: true,
        noEmit: true,
        esModuleInterop: true,
      });

      monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
        noSemanticValidation: false,
        noSyntaxValidation: false,
      });

      const editorEl = this.querySelector('#monaco-editor') as HTMLElement;
      this._editor = monaco.editor.create(editorEl, {
        theme: 'vs-dark',
        fontSize: 13,
        fontFamily: "'Cascadia Code', 'Fira Code', monospace",
        minimap: { enabled: true },
        automaticLayout: true,
        tabSize: 2,
        scrollBeyondLastLine: true,
        padding: { top: 8 },
        'bracketPairColorization.enabled': true,
        guides: { bracketPairs: true },
        renderWhitespace: 'selection',
        wordWrap: 'on',
        stickyScroll: { enabled: true },
        suggestOnTriggerCharacters: true,
        quickSuggestions: { other: true, comments: false, strings: true },
      });

      this._setupCustomDiagnostics();
      this._setupEditorOpener();
      this._setupEntitySymbolProvider();
      this._setupCodeLensProvider();
      this._setupDocumentHighlightProvider();
      this._setupEntityCompletionProvider();
      this._setupCallServiceCompletionProvider();
      this._loadExtraTypes();
      this._loadFileTree();
      this._loadEntities();
      this._loadTypeScriptApi();
    });
  }

  private _loadExtraTypes() {
    this._api('GET', '/api/types/sdk').then((result) => {
      if (result?.declaration) {
        const content = result.declaration as string;
        const uri = 'ts:sdk/globals.d.ts';
        monaco.languages.typescript.typescriptDefaults.addExtraLib(content, uri);
        this._createReadOnlyModel(content, uri);
      }
    }).catch(e => console.warn('[ha-forge] Failed to load SDK types', e));

    this._api('GET', '/api/types/status').then((status) => {
      if (status.generated) {
        return this._api('GET', '/api/files/.generated/ha-registry.d.ts');
      }
      return null;
    }).then((registryDts) => {
      if (registryDts?.content) {
        const content = (registryDts.content as string)
          .replace(/^import\b.*$/gm, '')
          .replace(/^export\b.*$/gm, '');
        const uri = 'ts:ha-registry/index.d.ts';
        monaco.languages.typescript.typescriptDefaults.addExtraLib(content, uri);
        this._createReadOnlyModel(content, uri);
      }
    }).catch(e => console.warn('[ha-forge] Failed to load HA registry types', e));

    this._api('GET', '/api/types/completion-registry').then((data) => {
      if (data && data.domains) {
        this._completionRegistry = data;
      }
    }).catch(e => console.warn('[ha-forge] Failed to load completion registry', e));
  }

  private _createReadOnlyModel(content: string, uri: string) {
    const parsed = monaco.Uri.parse(uri);
    const existing = monaco.editor.getModel(parsed);
    if (existing) existing.dispose();
    const model = monaco.editor.createModel(content, 'typescript', parsed);
    model.updateOptions({ readOnly: true });
  }

  private _loadTypeScriptApi() {
    // Monaco bundles TypeScript but doesn't expose ts.createSourceFile on the main thread.
    // Load TypeScript from CDN via a script tag — it registers as window.ts (UMD global).
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/typescript@5.7.3/lib/typescript.min.js';
    script.onload = () => {
      const tsGlobal = (globalThis as Record<string, unknown>).ts as typeof import('typescript') | undefined;
      if (tsGlobal?.createSourceFile) {
        setTypeScriptApi(tsGlobal);
        setAstAnalyzerActive();
        this._runDiagnostics();
        console.debug('[ha-forge] TypeScript API loaded');
      }
    };
    script.onerror = (e) => console.warn('[ha-forge] Failed to load TypeScript API', e);
    document.head.appendChild(script);

    // Load cronstrue for human-readable cron descriptions in hover tooltips.
    // cronstrue's UMD detects Monaco's AMD loader and registers as an AMD module
    // instead of setting a global — so we must load it via require(), not a script tag.
    require.config({
      paths: { cronstrue: 'https://cdn.jsdelivr.net/npm/cronstrue@2.52.0/dist/cronstrue.min' },
    });
    require(['cronstrue'], (cronstrue: { toString(expr: string, opts?: { throwExceptionOnParseError?: boolean }): string }) => {
      this._setupCronHoverProvider(cronstrue);
      console.debug('[ha-forge] cronstrue loaded');
    }, (err: unknown) => console.warn('[ha-forge] Failed to load cronstrue', err));
  }

  private _setupCronHoverProvider(cronstrue: { toString(expr: string, opts?: { throwExceptionOnParseError?: boolean }): string }) {
    monaco.languages.registerHoverProvider('typescript', {
      provideHover: (model: MonacoModelInstance, position: { lineNumber: number; column: number }) => {
        if (!isAstReady()) return null;
        const cronStrings = findCronStrings(model.getValue(), model.uri.path || 'file.ts');
        for (const cron of cronStrings) {
          if (position.lineNumber >= cron.startLine && position.lineNumber <= cron.endLine &&
              position.column >= cron.startCol && position.column <= cron.endCol) {
            try {
              const description = cronstrue.toString(cron.value, { throwExceptionOnParseError: true });
              return {
                range: new monaco.Range(cron.startLine, cron.startCol, cron.endLine, cron.endCol),
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

  // ---- Cross-file navigation ----

  private _setupEditorOpener() {
    monaco.editor.registerEditorOpener({
      openCodeEditor: (source, resource, selectionOrPosition) => {
        const path = resource.path;

        // SDK / registry .d.ts — let Monaco open peek widget (read-only inline view)
        if (!path.startsWith('/') || path.includes('node_modules')) return false;

        // User file — strip leading slash to get relative path
        const filePath = path.replace(/^\//, '');
        const existing = this._openFiles.find((f) => f.path === filePath);

        if (existing) {
          // Already open — switch to it
          this._activeFile = filePath;
          source.setModel(existing.model);
          this.requestUpdate();
        } else {
          // Open the file, then apply position after it loads
          this._openFile(filePath);
        }

        // Apply selection/position
        if (selectionOrPosition && monaco.Range.isIRange(selectionOrPosition)) {
          source.revealRangeInCenterIfOutsideViewport(selectionOrPosition);
          source.setSelection(selectionOrPosition);
        } else if (selectionOrPosition) {
          source.revealPositionInCenterIfOutsideViewport(selectionOrPosition);
          source.setPosition(selectionOrPosition);
        }

        return true;
      },
    });
  }

  // ---- Entity symbol outline (Ctrl+Shift+O) ----

  private _setupEntitySymbolProvider() {
    monaco.languages.registerDocumentSymbolProvider('typescript', {
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
            kind: monaco.languages.SymbolKind.Variable,
            range: new monaco.Range(entity.line, 1, entity.line, lineLen),
            selectionRange: new monaco.Range(entity.line, entity.startCol, entity.line, entity.endCol),
          };
        });
      },
    });
  }

  // ---- CodeLens — live entity state ----

  private _codeLensChangeListeners: Array<() => void> = [];

  private _setupCodeLensProvider() {
    monaco.languages.registerCodeLensProvider('typescript', {
      onDidChange: (listener: () => void) => {
        this._codeLensChangeListeners.push(listener);
        return { dispose: () => { this._codeLensChangeListeners = this._codeLensChangeListeners.filter(l => l !== listener); } };
      },
      provideCodeLenses: (model: MonacoModelInstance) => {
        if (!isAstReady()) return { lenses: [], dispose() {} };

        const defs = findEntityDefinitions(model.getValue(), model.uri.path || 'file.ts');
        // Build lookup by full entity ID (type.id) since _entities stores bare id + type separately
        const stateMap = new Map(this._entities.map(e => [`${e.type}.${e.id}`, e]));

        const lenses = defs.map(def => {
          let title: string;
          if (def.domain === 'device') {
            // Device: show member count and how many are deployed
            const members = def.memberCount ?? 0;
            const deployed = this._entities.filter(e => e.sourceFile === (model.uri.path || '').replace(/^\//, '')).length;
            title = def.isExported
              ? `\u25A0 device: ${def.entityId} \u2014 ${members} members${deployed > 0 ? `, ${deployed} deployed` : ''}`
              : `\u25A0 device: ${def.entityId} \u2014 not exported`;
          } else {
            const entity = stateMap.get(def.fullEntityId);
            if (!entity) {
              title = def.isExported ? `${def.fullEntityId} \u2014 not deployed` : `${def.fullEntityId} \u2014 not exported`;
            } else {
              const stateStr = entity.state != null ? String(entity.state) : '\u2014';
              const status = entity.status === 'healthy' ? '\u2713' : '\u2717';
              const unit = entity.unit_of_measurement ? ` ${entity.unit_of_measurement}` : '';
              title = `${status} ${def.fullEntityId}: ${stateStr}${unit}`;
            }
          }
          return {
            range: new monaco.Range(def.line, 1, def.line, 1),
            command: { id: '', title },
          };
        });

        return { lenses, dispose() {} };
      },
    });
  }

  private _refreshCodeLenses() {
    console.debug(`[ha-forge] CodeLens refresh, ${this._codeLensChangeListeners.length} listeners`);
    for (const listener of this._codeLensChangeListeners) listener();
  }

  // ---- Document highlights — entity ID references ----

  private _setupDocumentHighlightProvider() {
    monaco.languages.registerDocumentHighlightProvider('typescript', {
      provideDocumentHighlights: (model: MonacoModelInstance, position: { lineNumber: number; column: number }) => {
        if (!isAstReady()) return [];
        const source = model.getValue();
        const lines = source.split('\n');
        const line = lines[position.lineNumber - 1];
        if (!line) return [];

        // Find the string literal under the cursor
        const stringAt = this._findStringAtPosition(line, position.column);
        if (!stringAt) return [];

        // Check if this is an entity ID (bare or domain-qualified)
        const defs = findEntityDefinitions(source, model.uri.path || 'file.ts');
        const bareId = stringAt.includes('.') ? stringAt.split('.').slice(1).join('.') : stringAt;
        const matchingDef = defs.find(d => d.entityId === bareId || d.fullEntityId === stringAt);
        if (!matchingDef) return [];

        // Find all string literals in the file that reference this entity
        const highlights: Array<{ range: MonacoRange; kind?: number }> = [];
        const patterns = [matchingDef.entityId, matchingDef.fullEntityId];

        for (let i = 0; i < lines.length; i++) {
          for (const pattern of patterns) {
            let col = lines[i].indexOf("'" + pattern + "'");
            if (col === -1) col = lines[i].indexOf('"' + pattern + '"');
            if (col === -1) continue;
            const startCol = col + 2; // 1-based, skip the quote
            const endCol = startCol + pattern.length;
            const isDefinition = i === matchingDef.line - 1 && pattern === matchingDef.entityId;
            highlights.push({
              range: new monaco.Range(i + 1, startCol, i + 1, endCol),
              kind: isDefinition ? monaco.languages.DocumentHighlightKind.Write : monaco.languages.DocumentHighlightKind.Read,
            });
          }
        }

        return highlights;
      },
    });
  }

  private _findStringAtPosition(line: string, column: number): string | null {
    const regex = /(['"])([^'"]*)\1/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(line)) !== null) {
      const start = match.index + 2; // 1-based column of string content start
      const end = start + match[2].length;
      if (column >= start && column <= end) return match[2];
    }
    return null;
  }

  // ---- Entity template scaffolding ----

  private _setupEntityCompletionProvider() {
    const templates = TseApp._entityTemplates();

    monaco.languages.registerCompletionItemProvider('typescript', {
      triggerCharacters: ['\n', ' '],
      provideCompletionItems: (model: MonacoModelInstance, position: { lineNumber: number; column: number }) => {
        const allLines = model.getValue().split('\n');
        const lineContent = allLines[position.lineNumber - 1] ?? '';
        const beforeCursor = lineContent.slice(0, position.column - 1);
        const trimmed = beforeCursor.trim();

        // Analyze brace depth and entities context using text up to cursor
        const priorLines = allLines.slice(0, position.lineNumber - 1).join('\n');
        const textToCursor = (position.lineNumber > 1 ? priorLines + '\n' : '') + beforeCursor;
        const { depth, insideEntities } = TseApp._analyzeCompletionContext(textToCursor);

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
          suggestions: templates.map(t => ({
            label: t.label,
            kind: monaco.languages.CompletionItemKind.Snippet,
            insertText: mode === 'top-level' ? t.topLevelText
              : mode === 'expression' ? TseApp._stripVarDecl(t.topLevelText)
              : mode === 'member' ? t.memberText
              : TseApp._stripMemberKey(t.memberText),
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            detail: t.detail,
            documentation: { value: t.documentation },
            sortText: t.sortText,
          })),
        };
      },
    });
  }

  /** Scan text for brace depth and whether cursor is directly inside an `entities: { }` block. */
  private static _analyzeCompletionContext(text: string): { depth: number; insideEntities: boolean } {
    let depth = 0;
    const stack: boolean[] = [];
    let i = 0;
    const len = text.length;

    while (i < len) {
      const ch = text[i];

      // Skip string literals
      if (ch === '"' || ch === "'" || ch === '`') {
        i++;
        while (i < len) {
          if (text[i] === '\\') { i += 2; continue; }
          if (text[i] === ch) { i++; break; }
          i++;
        }
        continue;
      }

      // Skip line comments
      if (ch === '/' && i + 1 < len && text[i + 1] === '/') {
        while (i < len && text[i] !== '\n') i++;
        continue;
      }

      // Skip block comments
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

  /** Strip `export const ${1:name} = ` prefix and renumber placeholders. */
  private static _stripVarDecl(text: string): string {
    const m = text.match(/^export\s+const\s+\$\{1:[^}]+\}\s*=\s*/);
    if (!m) return text;
    return TseApp._renumberPlaceholders(text.slice(m[0].length));
  }

  /** Strip `${1:name}: ` prefix and renumber placeholders. */
  private static _stripMemberKey(text: string): string {
    const m = text.match(/^\$\{1:[^}]+\}:\s*/);
    if (!m) return text;
    return TseApp._renumberPlaceholders(text.slice(m[0].length));
  }

  /** Subtract 1 from all non-zero snippet placeholder numbers. */
  private static _renumberPlaceholders(text: string): string {
    return text.replace(/\$\{(\d+)(:[^}]*)?\}/g, (_match, numStr: string, rest?: string) => {
      const num = parseInt(numStr);
      if (num === 0) return _match;
      return `\${${num - 1}${rest || ''}}`;
    });
  }

  // ---- callService() completion provider ----

  private _setupCallServiceCompletionProvider() {
    monaco.languages.registerCompletionItemProvider('typescript', {
      triggerCharacters: ["'", '"', ',', '{', ' '],
      provideCompletionItems: (model: MonacoModelInstance, position: { lineNumber: number; column: number }) => {
        if (!this._completionRegistry) return { suggestions: [] };

        const allLines = model.getValue().split('\n');
        const lineContent = allLines[position.lineNumber - 1] ?? '';
        const beforeCursor = lineContent.slice(0, position.column - 1);

        // Scan backwards to find callService( — gather text from prior lines if needed
        const searchLines: string[] = [beforeCursor];
        for (let i = position.lineNumber - 2; i >= Math.max(0, position.lineNumber - 10); i--) {
          searchLines.unshift(allLines[i]);
          if (allLines[i].includes('callService')) break;
        }
        const searchText = searchLines.join('\n');

        const ctx = TseApp._parseCallServiceContext(searchText);
        if (!ctx) return { suggestions: [] };

        const registry = this._completionRegistry as {
          domains: Record<string, { services: Record<string, { description?: string; fields: Record<string, { type: string; description?: string; required: boolean }> }> }>;
          entities: Record<string, { domain: string; services?: string[] }>;
        };

        if (ctx.argIndex === 1) {
          // 2nd argument — service name completions
          return { suggestions: this._getServiceSuggestions(ctx.entityId, registry) };
        }

        if (ctx.argIndex === 2 && ctx.insideObject) {
          // 3rd argument inside {} — data field key completions
          return { suggestions: this._getFieldSuggestions(ctx.entityId, ctx.serviceName, registry) };
        }

        return { suggestions: [] };
      },
    });
  }

  /**
   * Parse callService context from text ending at cursor.
   * Returns the argument index (0=entity, 1=service, 2=data) and parsed arg values.
   */
  private static _parseCallServiceContext(text: string): {
    argIndex: number;
    entityId: string;
    serviceName: string;
    insideObject: boolean;
  } | null {
    // Find the last callService( occurrence
    const csIdx = text.lastIndexOf('callService(');
    if (csIdx === -1) return null;

    const afterCs = text.slice(csIdx + 'callService('.length);

    // Walk the text counting commas at depth 0 (parentheses) to find arg index
    // Also track string literals and brace depth
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

      // String handling
      if (inString) {
        if (ch === '\\') { i++; continue; }
        if (ch === inString) {
          // Closing quote — capture the string value
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
        // Closed the callService parens — cursor is outside
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

  private _getServiceSuggestions(
    entityId: string,
    registry: {
      domains: Record<string, { services: Record<string, { description?: string; fields: Record<string, unknown> }> }>;
      entities: Record<string, { domain: string; services?: string[] }>;
    },
  ) {
    const entity = registry.entities[entityId];
    // Also support domain-level calls (e.g., callService('light', ...))
    const domain = entity?.domain ?? entityId;
    const domainData = registry.domains[domain];
    if (!domainData) return [];

    // Filter to entity-specific services if available (e.g., script)
    const serviceNames = entity?.services ?? Object.keys(domainData.services);

    return serviceNames.map((svcName, i) => {
      const svc = domainData.services[svcName];
      return {
        label: svcName,
        kind: monaco.languages.CompletionItemKind.Function,
        insertText: `'${svcName}'`,
        detail: svc?.description ?? `${domain}.${svcName}`,
        sortText: String(i).padStart(3, '0'),
      };
    });
  }

  private _getFieldSuggestions(
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
      kind: monaco.languages.CompletionItemKind.Property,
      insertText: `${fieldName}: `,
      detail: field.type + (field.required ? ' (required)' : ''),
      documentation: field.description ? { value: field.description } : undefined,
      sortText: (field.required ? '0_' : '1_') + String(i).padStart(3, '0'),
    }));
  }

  private static _entityTemplates() {
    return [
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
        topLevelText: "export const ${1:myAutomation} = automation({\n  id: '${2:my_automation}',\n  init() {\n    this.events.on('${3:sensor.entity_id}', (event) => {\n      $0\n    });\n  },\n});",
        memberText: "${1:myAutomation}: automation({\n  id: '${2:my_automation}',\n  init() {\n    this.events.on('${3:sensor.entity_id}', (event) => {\n      $0\n    });\n  },\n}),",
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
  }

  // ---- Custom diagnostics ----

  private _diagTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly DIAG_OWNER = 'ha-forge-lint';
  private static readonly AST_DIAG_OWNER = 'ha-forge-ast';
  private static readonly CS_DIAG_OWNER = 'ha-forge-callservice';
  private static readonly DIAG_DEBOUNCE = 300;
  /** Lines where our callService diagnostics found errors — TS overload errors on these lines are suppressed. */
  private _csDiagLines = new Set<number>();

  private _setupCustomDiagnostics() {
    if (!this._editor) return;

    // Run diagnostics on content change (debounced)
    this._editor.onDidChangeModelContent(() => {
      if (this._diagTimer) clearTimeout(this._diagTimer);
      this._diagTimer = setTimeout(() => this._runDiagnostics(), TseApp.DIAG_DEBOUNCE);
    });

    // Suppress TS overload errors (2769) on lines where we have our own callService diagnostics
    monaco.editor.onDidChangeMarkers(() => {
      const model = this._editor?.getModel();
      if (!model || this._csDiagLines.size === 0) return;
      const tsMarkers = monaco.editor.getModelMarkers({ resource: model.uri, owner: 'typescript' });
      const filtered = tsMarkers.filter(m => !(String(m.code) === '2769' && this._csDiagLines.has(m.startLineNumber)));
      if (filtered.length < tsMarkers.length) {
        monaco.editor.setModelMarkers(model, 'typescript', filtered);
      }
    });

    // Quick-fix code actions
    monaco.languages.registerCodeActionProvider('typescript', {
      provideCodeActions: (model: MonacoModelInstance, range: MonacoRange, context: { markers: MonacoMarkerData[] }) => {
        const actions: MonacoCodeAction[] = [];

        // Refactoring: fill in derived device info (no diagnostic needed)
        if (isAstReady()) {
          const filePath = model.uri.path || 'file.ts';
          const insertion = getDeviceInfoInsertion(model.getValue(), filePath, range.startLineNumber);
          if (insertion) {
            actions.push(this._refactorAction(model,
              'Fill in device info (derived from filename)',
              new monaco.Range(insertion.insertLine, insertion.insertCol, insertion.insertLine, insertion.insertCol),
              insertion.text,
            ));
          }
        }

        for (const marker of context.markers) {
          // callService field suggestion quick fix
          if (marker.source === TseApp.CS_DIAG_OWNER && typeof marker.code === 'string' && marker.code.startsWith('suggest:')) {
            const suggested = marker.code.slice('suggest:'.length);
            actions.push(this._quickFix(model, marker,
              `Replace with '${suggested}'`,
              new monaco.Range(marker.startLineNumber, marker.startColumn, marker.endLineNumber, marker.endColumn),
              suggested,
            ));
          }

          // reactions/watchdog state value suggestion quick fix
          if (marker.source === TseApp.CS_DIAG_OWNER && typeof marker.code === 'string' && marker.code.startsWith('suggest-state:')) {
            const parts = marker.code.split(':');
            const suggested = parts[1];
            // Replace the quoted string value (marker covers the full quoted string)
            actions.push(this._quickFix(model, marker,
              `Replace with '${suggested}'`,
              new monaco.Range(marker.startLineNumber, marker.startColumn, marker.endLineNumber, marker.endColumn),
              `'${suggested}'`,
            ));
          }

          if (marker.source !== TseApp.DIAG_OWNER && marker.source !== TseApp.AST_DIAG_OWNER) continue;

          // "not exported" on a variable declaration → add export keyword
          // (bare calls like `sensor({...})` also say "not exported" but can't be fixed with just `export `)
          if (marker.message.includes('is not exported')) {
            actions.push(this._quickFix(model, marker,
              "Add 'export' to this declaration",
              new monaco.Range(marker.startLineNumber, 1, marker.startLineNumber, 1),
              'export ',
            ));
          }

          // "Do not await" → remove the await keyword
          if (marker.message.startsWith('Do not await')) {
            const line = model.getValue().split('\n')[marker.startLineNumber - 1];
            const awaitMatch = line.match(/^(\s*)(await\s+)/);
            if (awaitMatch) {
              const col = awaitMatch[1].length + 1;
              actions.push(this._quickFix(model, marker,
                'Remove await',
                new monaco.Range(marker.startLineNumber, col, marker.startLineNumber, col + awaitMatch[2].length),
                '',
              ));
            }
          }

          // "Use this.setTimeout" → replace bare setTimeout/setInterval
          const timerMatch = marker.message.match(/^Use (this\.(?:setTimeout|setInterval))\(\) instead of (setTimeout|setInterval)\(\)/);
          if (timerMatch) {
            actions.push(this._quickFix(model, marker,
              `Replace with ${timerMatch[1]}()`,
              new monaco.Range(marker.startLineNumber, marker.startColumn, marker.endLineNumber, marker.endColumn),
              timerMatch[1],
            ));
          }

          // "Entity ID should be snake_case (suggested: 'x')" → replace the ID string
          const snakeMatch = marker.message.match(/^Entity ID '(.+?)' should be snake_case \(suggested: '(.+?)'\)$/);
          if (snakeMatch) {
            const suggested = snakeMatch[2];
            // Replace the string content between quotes (marker covers the full string literal including quotes)
            actions.push(this._quickFix(model, marker,
              `Change ID to '${suggested}'`,
              new monaco.Range(marker.startLineNumber, marker.startColumn + 1, marker.endLineNumber, marker.endColumn - 1),
              suggested,
            ));
          }

          // Bare factory call "not assigned or exported [export const varName]" → wrap with export const
          const bareMatch = marker.message.match(/\[export const (\w+)\]$/);
          if (bareMatch) {
            const varName = bareMatch[1];
            actions.push(this._quickFix(model, marker,
              `Export as '${varName}'`,
              new monaco.Range(marker.startLineNumber, marker.startColumn, marker.startLineNumber, marker.startColumn),
              `export const ${varName} = `,
            ));
          }

          // Missing or empty name → add/replace name
          const nameMatch = marker.message.match(/(?:missing required 'name' property|name must not be empty) \(suggested: '(.+?)'\)$/);
          if (nameMatch) {
            const suggested = nameMatch[1];
            if (marker.message.includes('must not be empty')) {
              // Replace the empty string (marker covers the '' node)
              actions.push(this._quickFix(model, marker,
                `Set name to '${suggested}'`,
                new monaco.Range(marker.startLineNumber, marker.startColumn, marker.endLineNumber, marker.endColumn),
                `'${suggested}'`,
              ));
            } else {
              // Insert after the id line
              const lines = model.getValue().split('\n');
              for (let i = marker.startLineNumber - 1; i < Math.min(marker.endLineNumber + 5, lines.length); i++) {
                if (/^\s*id:\s*['"]/.test(lines[i])) {
                  const indent = lines[i].match(/^(\s*)/)?.[1] ?? '';
                  actions.push(this._quickFix(model, marker,
                    `Add name: '${suggested}'`,
                    new monaco.Range(i + 1, lines[i].length + 1, i + 1, lines[i].length + 1),
                    `\n${indent}name: '${suggested}',`,
                  ));
                  break;
                }
              }
            }
          }

          // Missing unit_of_measurement → add it after device_class
          const unitMatch = marker.message.match(/should have unit_of_measurement \(typically '(.+?)'\)$/);
          if (unitMatch) {
            const unit = unitMatch[1];
            // Insert after the device_class line (marker is on the device_class value)
            const line = model.getValue().split('\n')[marker.startLineNumber - 1];
            const indent = line.match(/^(\s*)/)?.[1] ?? '';
            actions.push(this._quickFix(model, marker,
              `Add unit_of_measurement: '${unit}'`,
              new monaco.Range(marker.startLineNumber, line.length + 1, marker.startLineNumber, line.length + 1),
              `\n${indent}unit_of_measurement: '${unit}',`,
            ));
          }

          // Device refactor: wrap standalone entities into device()
          if (marker.message.includes('[ha-forge:device-refactor]')) {
            const source = model.getValue();
            const filePath = model.uri.path || 'file.ts';
            const refactored = generateDeviceRefactor(source, filePath);
            if (refactored) {
              const lineCount = source.split('\n').length;
              actions.push(this._quickFix(model, marker,
                'Wrap entities in device()',
                new monaco.Range(1, 1, lineCount, source.split('\n')[lineCount - 1].length + 1),
                refactored,
              ));
            }
          }

          // Convert sensor to computed()
          if (marker.message.includes('[ha-forge:suggest-computed]')) {
            const source = model.getValue();
            const filePath = model.uri.path || 'file.ts';
            const edit = generateSensorToComputed(source, filePath, marker.startLineNumber);
            if (edit) {
              const lines = source.split('\n');
              const endCol = lines[edit.endLine - 1].length + 1;
              actions.push(this._quickFix(model, marker,
                'Convert to computed()',
                new monaco.Range(edit.startLine, 1, edit.endLine, endCol),
                edit.text,
              ));
            }
          }

          // Move standalone entity into existing device
          if (marker.message.includes('[ha-forge:move-into-device]')) {
            const source = model.getValue();
            const filePath = model.uri.path || 'file.ts';
            const edit = generateMoveIntoDevice(source, filePath, marker.startLineNumber);
            if (edit) {
              const lines = source.split('\n');
              // Delete the standalone statement (include trailing blank line if present)
              let delEnd = edit.deleteEndLine;
              if (delEnd < lines.length && lines[delEnd].trim() === '') delEnd++;
              const deleteRange = new monaco.Range(edit.deleteStartLine, 1, delEnd + 1, 1);
              // Insert into the device entities block
              const insertRange = new monaco.Range(edit.insertLine, edit.insertCol, edit.insertLine, edit.insertCol);
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

  private _quickFix(
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

  private _refactorAction(
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

  private _runDiagnostics() {
    const model = this._editor?.getModel();
    if (!model) return;

    const sourceText = model.getValue();

    // Regex-based analyzers
    const diagnostics = runAllAnalyzers(sourceText);
    const markers: MonacoMarkerData[] = diagnostics.map((d) => this._toMarker(d, TseApp.DIAG_OWNER));
    monaco.editor.setModelMarkers(model, TseApp.DIAG_OWNER, markers);

    // AST-based analyzers (if TypeScript API loaded)
    if (isAstReady()) {
      const result = analyzeWithAst(sourceText, model.uri.path || 'file.ts');
      const astMarkers: MonacoMarkerData[] = result.diagnostics.map((d) => this._toMarker(d, TseApp.AST_DIAG_OWNER));
      monaco.editor.setModelMarkers(model, TseApp.AST_DIAG_OWNER, astMarkers);

      // Update minimap entity markers
      this._updateMinimapDecorations(sourceText, model.uri.path || 'file.ts');
    }

    // callService / reactions / watchdog validation
    const { markers: csMarkers, suppressLines } = this._runCallServiceDiagnostics(sourceText);
    const stateMarkers = this._runStateDiagnostics(sourceText);
    this._csDiagLines = suppressLines;
    monaco.editor.setModelMarkers(model, TseApp.CS_DIAG_OWNER, [...csMarkers, ...stateMarkers]);
  }

  // ---- callService diagnostics ----

  private _runCallServiceDiagnostics(sourceText: string): { markers: MonacoMarkerData[]; suppressLines: Set<number> } {
    if (!this._completionRegistry) return { markers: [], suppressLines: new Set() };

    const registry = this._completionRegistry as {
      domains: Record<string, { services: Record<string, { fields: Record<string, { type: string; description?: string; required: boolean }> }> }>;
      entities: Record<string, { domain: string; services?: string[] }>;
    };

    const markers: MonacoMarkerData[] = [];
    const suppressLines = new Set<number>();
    const lines = sourceText.split('\n');

    // Find all callService( occurrences and validate data fields
    const csRegex = /\.callService\s*\(/g;
    let match: RegExpExecArray | null;
    while ((match = csRegex.exec(sourceText)) !== null) {
      const afterOpen = match.index + match[0].length;
      const parsed = TseApp._parseCallServiceFull(sourceText, afterOpen);
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
        // Unknown key — find close matches
        const suggestion = TseApp._findClosestMatch(key.name, validKeys);
        const suggestionMsg = suggestion
          ? `. Did you mean '${suggestion}'?`
          : '';
        const validList = validKeys.length > 0
          ? `\nValid fields: ${validKeys.join(', ')}`
          : '';

        // Convert offset to line/col
        const pos = TseApp._offsetToLineCol(lines, key.offset);
        markers.push({
          severity: monaco.MarkerSeverity.Error,
          message: `Unknown field '${key.name}' for ${domain}.${parsed.serviceName}${suggestionMsg}${validList}`,
          startLineNumber: pos.line,
          startColumn: pos.col,
          endLineNumber: pos.line,
          endColumn: pos.col + key.name.length,
          source: TseApp.CS_DIAG_OWNER,
          code: suggestion ? `suggest:${suggestion}` : undefined,
        });
      }

      // Track the callService line so we can suppress TS overload errors there
      if (hasErrors) {
        const csLine = TseApp._offsetToLineCol(lines, match.index).line;
        suppressLines.add(csLine);
        suppressLines.add(csLine + 1); // first arg may be on the next line
      }
    }

    return { markers, suppressLines };
  }

  // ---- reactions / watchdog state diagnostics ----

  /**
   * Validate `to` state values in reactions() and watchdog() calls.
   * Pattern: `.reactions({ 'entity.id': { to: 'value' } })`
   * Pattern: `.watchdog({ 'entity.id': { expect: { to: 'value' } } })`
   */
  private _runStateDiagnostics(sourceText: string): MonacoMarkerData[] {
    if (!this._completionRegistry) return [];

    const registry = this._completionRegistry as {
      entities: Record<string, { domain: string; states: string[] }>;
    };

    const markers: MonacoMarkerData[] = [];
    const lines = sourceText.split('\n');

    // Find reactions() and watchdog() calls
    const ruleRegex = /\.(?:reactions|watchdog)\s*\(\s*\{/g;
    let match: RegExpExecArray | null;
    while ((match = ruleRegex.exec(sourceText)) !== null) {
      const isWatchdog = match[0].includes('watchdog');
      const objStart = match.index + match[0].length; // after the opening {
      const entries = TseApp._parseEntityRuleEntries(sourceText, objStart);

      for (const entry of entries) {
        // Validate entity ID exists in registry
        const entityData = registry.entities[entry.entityId];
        if (!entityData || entityData.states.length === 0) continue;

        for (const toValue of entry.toValues) {
          if (entityData.states.includes(toValue.value)) continue;

          const suggestion = TseApp._findClosestMatch(toValue.value, entityData.states);
          const suggestionMsg = suggestion ? `. Did you mean '${suggestion}'?` : '';
          const method = isWatchdog ? 'watchdog' : 'reactions';

          const pos = TseApp._offsetToLineCol(lines, toValue.offset);
          markers.push({
            severity: monaco.MarkerSeverity.Error,
            message: `Invalid state '${toValue.value}' for ${entry.entityId}${suggestionMsg}\nValid states: ${entityData.states.join(', ')}`,
            startLineNumber: pos.line,
            startColumn: pos.col,
            endLineNumber: pos.line,
            endColumn: pos.col + toValue.value.length + 2, // +2 for quotes
            source: TseApp.CS_DIAG_OWNER,
            code: suggestion ? `suggest-state:${suggestion}:${pos.col}` : undefined,
          });
        }
      }
    }

    return markers;
  }

  /**
   * Parse entries from a reactions/watchdog rules object.
   * Returns entity IDs and their `to:` string values with offsets.
   */
  private static _parseEntityRuleEntries(
    text: string, startOffset: number,
  ): Array<{ entityId: string; toValues: Array<{ value: string; offset: number }> }> {
    const entries: Array<{ entityId: string; toValues: Array<{ value: string; offset: number }> }> = [];
    let i = startOffset;
    let braceDepth = 0; // we're already inside the outer {

    while (i < text.length) {
      // Skip whitespace
      while (i < text.length && /\s/.test(text[i])) i++;
      if (i >= text.length || text[i] === '}') break;

      // Skip comments
      if (text[i] === '/' && text[i + 1] === '/') {
        while (i < text.length && text[i] !== '\n') i++;
        continue;
      }
      if (text[i] === '/' && text[i + 1] === '*') {
        i += 2;
        while (i < text.length - 1 && !(text[i] === '*' && text[i + 1] === '/')) i++;
        i += 2; continue;
      }

      // Read entity ID key (must be quoted string for entity IDs like 'light.kitchen')
      if (text[i] !== "'" && text[i] !== '"') {
        // Skip non-string keys (computed properties, etc.)
        i = TseApp._skipValue(text, i);
        continue;
      }
      const q = text[i]; i++;
      const keyStart = i;
      while (i < text.length && text[i] !== q) {
        if (text[i] === '\\') i++;
        i++;
      }
      const entityId = text.slice(keyStart, i);
      i++; // closing quote

      // Skip to colon
      while (i < text.length && /\s/.test(text[i])) i++;
      if (text[i] !== ':') { i++; continue; }
      i++; // skip colon

      // Skip whitespace
      while (i < text.length && /\s/.test(text[i])) i++;

      // Expect opening { for the rule object
      if (text[i] !== '{') {
        i = TseApp._skipValue(text, i);
        continue;
      }
      i++; // skip opening {

      // Scan for `to:` properties inside the rule object
      const toValues: Array<{ value: string; offset: number }> = [];
      let ruleDepth = 0;

      while (i < text.length) {
        while (i < text.length && /\s/.test(text[i])) i++;
        if (i >= text.length) break;
        if (text[i] === '}') {
          if (ruleDepth === 0) { i++; break; }
          ruleDepth--; i++; continue;
        }

        // Skip comments
        if (text[i] === '/' && text[i + 1] === '/') {
          while (i < text.length && text[i] !== '\n') i++;
          continue;
        }
        if (text[i] === '/' && text[i + 1] === '*') {
          i += 2;
          while (i < text.length - 1 && !(text[i] === '*' && text[i + 1] === '/')) i++;
          i += 2; continue;
        }

        // Read property name
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
          i = TseApp._skipValue(text, i);
          continue;
        }

        // Skip to colon
        while (i < text.length && /\s/.test(text[i])) i++;
        if (text[i] !== ':') { i++; continue; }
        i++;
        while (i < text.length && /\s/.test(text[i])) i++;

        if (propName === 'to' && ruleDepth <= 1 && (text[i] === "'" || text[i] === '"')) {
          // Direct `to: 'value'` — used in reactions
          // Or nested `expect: { to: 'value' }` in watchdog (ruleDepth would be 1)
          const vq = text[i]; i++;
          const vs = i;
          const valOffset = vs - 1; // include quote for marker
          while (i < text.length && text[i] !== vq) { if (text[i] === '\\') i++; i++; }
          toValues.push({ value: text.slice(vs, i), offset: valOffset });
          i++; // closing quote
        } else if (propName === 'expect' && text[i] === '{') {
          // watchdog: expect: { to: '...' } — enter nested object
          ruleDepth++;
          i++; // skip {
          continue;
        } else {
          i = TseApp._skipValue(text, i);
        }

        // Skip trailing comma
        while (i < text.length && /\s/.test(text[i])) i++;
        if (i < text.length && text[i] === ',') i++;
      }

      entries.push({ entityId, toValues });

      // Skip trailing comma after entity rule
      while (i < text.length && /\s/.test(text[i])) i++;
      if (i < text.length && text[i] === ',') i++;
    }

    return entries;
  }

  /** Skip over a value expression (string, object, array, function, etc.) tracking depth. */
  private static _skipValue(text: string, start: number): number {
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

  /**
   * Parse a full callService call starting after the opening paren.
   * Extracts entity ID, service name, and data object key names with offsets.
   */
  private static _parseCallServiceFull(
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

      // Line comments
      if (ch === '/' && text[i + 1] === '/') {
        while (i < text.length && text[i] !== '\n') i++;
        continue;
      }

      // Block comments
      if (ch === '/' && text[i + 1] === '*') {
        i += 2;
        while (i < text.length - 1 && !(text[i] === '*' && text[i + 1] === '/')) i++;
        i += 2; continue;
      }

      if (ch === '(') { parenDepth++; i++; continue; }
      if (ch === ')') {
        if (parenDepth > 0) { parenDepth--; i++; continue; }
        break; // end of callService()
      }

      if (ch === '{') {
        braceDepth++;
        // If entering the data object (arg 2, brace depth 1), scan for keys
        if (argIndex === 2 && braceDepth === 1) {
          i++;
          // Scan object keys at this level
          while (i < text.length) {
            // Skip whitespace
            while (i < text.length && /\s/.test(text[i])) i++;
            if (i >= text.length || text[i] === '}') break;

            // Skip comments
            if (text[i] === '/' && text[i + 1] === '/') {
              while (i < text.length && text[i] !== '\n') i++;
              continue;
            }
            if (text[i] === '/' && text[i + 1] === '*') {
              i += 2;
              while (i < text.length - 1 && !(text[i] === '*' && text[i + 1] === '/')) i++;
              i += 2; continue;
            }

            // Read key name (identifier or quoted string)
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
              i++; // closing quote
            } else if (/[a-zA-Z_$]/.test(text[i])) {
              const ks = i;
              while (i < text.length && /[\w$]/.test(text[i])) i++;
              keyName = text.slice(ks, i);
            } else {
              i++; continue; // unexpected char, skip
            }

            // Skip to colon
            while (i < text.length && /\s/.test(text[i])) i++;
            if (text[i] !== ':') { i++; continue; } // not a key: value pair (spread, etc.)
            i++; // skip colon

            if (keyName) {
              dataKeys.push({ name: keyName, offset: keyOffset });
            }

            // Skip value — track nested braces/parens/brackets/strings
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
                break; // closing brace of data object
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

  private static _offsetToLineCol(lines: string[], offset: number): { line: number; col: number } {
    let remaining = offset;
    for (let i = 0; i < lines.length; i++) {
      if (remaining <= lines[i].length) {
        return { line: i + 1, col: remaining + 1 };
      }
      remaining -= lines[i].length + 1; // +1 for newline
    }
    return { line: lines.length, col: 1 };
  }

  /** Find the closest matching string from candidates using prefix, substring, then Levenshtein. */
  private static _findClosestMatch(input: string, candidates: string[]): string | null {
    if (candidates.length === 0) return null;
    const lower = input.toLowerCase();

    // 1. Exact prefix match (input is a prefix of a candidate)
    const prefixMatch = candidates.find((c) => c.toLowerCase().startsWith(lower));
    if (prefixMatch) return prefixMatch;

    // 2. Reverse prefix (candidate is a prefix of input)
    const revPrefix = candidates.find((c) => lower.startsWith(c.toLowerCase()));
    if (revPrefix) return revPrefix;

    // 3. Substring containment
    const subMatch = candidates.find((c) => c.toLowerCase().includes(lower) || lower.includes(c.toLowerCase()));
    if (subMatch) return subMatch;

    // 4. Levenshtein distance <= 3
    let bestDist = 4;
    let bestMatch: string | null = null;
    for (const c of candidates) {
      const dist = TseApp._levenshtein(lower, c.toLowerCase());
      if (dist < bestDist) {
        bestDist = dist;
        bestMatch = c;
      }
    }
    return bestMatch;
  }

  private static _levenshtein(a: string, b: string): number {
    const m = a.length, n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;

    // Single-row DP
    const row = Array.from({ length: n + 1 }, (_, i) => i);
    for (let i = 1; i <= m; i++) {
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

  // ---- Minimap entity markers ----

  private static readonly MINIMAP_COLORS: Record<string, string> = {
    sensor: '#4FC3F7',         // light blue
    binary_sensor: '#4FC3F7',
    light: '#FFD54F',          // amber
    switch: '#81C784',         // green
    cover: '#A1887F',          // brown
    climate: '#FF8A65',        // deep orange
    fan: '#80CBC4',            // teal
    lock: '#E57373',           // red
    number: '#9575CD',         // purple
    select: '#9575CD',
    text: '#9575CD',
    button: '#F06292',         // pink
    notify: '#F06292',         // pink
    update: '#81C784',         // green
    image: '#4DB6AC',          // teal
    device: '#66BB6A',         // green
  };
  private static readonly MINIMAP_DEFAULT_COLOR = '#90A4AE'; // blue grey

  private _minimapDecorations: MonacoDecorationsCollection | null = null;

  private _updateMinimapDecorations(sourceText: string, fileName: string) {
    if (!this._editor) return;
    if (!this._minimapDecorations) {
      this._minimapDecorations = this._editor.createDecorationsCollection();
    }

    const defs = findEntityDefinitions(sourceText, fileName);
    const decorations: MonacoDecorationOptions[] = defs.map(def => {
      const color = TseApp.MINIMAP_COLORS[def.domain] ?? TseApp.MINIMAP_DEFAULT_COLOR;
      return {
        range: new monaco.Range(def.line, 1, def.endLine, 1),
        options: {
          isWholeLine: true,
          minimap: { color, position: 1 },      // MinimapPosition.Inline
          overviewRuler: { color, position: 4 }, // OverviewRulerLane.Full
        },
      };
    });

    this._minimapDecorations.set(decorations);
  }

  private _toMarker(d: AnalyzerDiagnostic, source: string): MonacoMarkerData {
    return {
      severity: d.severity === 'error' ? monaco.MarkerSeverity.Error
        : d.severity === 'warning' ? monaco.MarkerSeverity.Warning
        : monaco.MarkerSeverity.Info,
      message: d.message,
      startLineNumber: d.startLine,
      startColumn: d.startCol,
      endLineNumber: d.endLine,
      endColumn: d.endCol,
      source,
    };
  }

  // ---- File tree ----

  private async _loadFileTree() {
    const data = await this._api('GET', '/api/files');
    this._files = (data.files as FileEntry[]) ?? [];
  }

  // ---- File operations ----

  private async _openFile(filePath: string) {
    const existing = this._openFiles.find((f) => f.path === filePath);
    if (existing) {
      this._activeFile = filePath;
      this._editor?.setModel(existing.model);
      this.requestUpdate();
      return;
    }

    const data = await this._api('GET', '/api/files/' + encodeURIComponent(filePath));
    if (data.error) return;

    const lang = (filePath.endsWith('.ts') || filePath.endsWith('.tsx')) ? 'typescript' : 'json';
    const model = monaco.editor.createModel(
      data.content as string, lang,
      monaco.Uri.parse('file:///' + filePath),
    );

    const file: OpenFileInternal = {
      path: filePath,
      content: data.content as string,
      modified: false,
      model,
    };

    model.onDidChangeContent(() => {
      file.modified = model.getValue() !== file.content;
      this.requestUpdate();
    });

    this._openFiles = [...this._openFiles, file];
    this._activeFile = filePath;
    this._editor?.setModel(model);
    this._runDiagnostics();
  }

  private _activateFile(filePath: string) {
    const file = this._openFiles.find((f) => f.path === filePath);
    if (!file) return;
    this._activeFile = filePath;
    this._editor?.setModel(file.model);
    this._runDiagnostics();
  }

  private _closeFile(filePath: string) {
    const idx = this._openFiles.findIndex((f) => f.path === filePath);
    if (idx === -1) return;

    if (this._openFiles[idx].modified) {
      if (!confirm(`"${filePath.split('/').pop()}" has unsaved changes. Close anyway?`)) return;
    }

    this._openFiles[idx].model.dispose();
    const newFiles = [...this._openFiles];
    newFiles.splice(idx, 1);
    this._openFiles = newFiles;

    if (this._activeFile === filePath) {
      if (newFiles.length > 0) {
        const next = newFiles[Math.min(idx, newFiles.length - 1)];
        this._activeFile = next.path;
        this._editor?.setModel(next.model);
      } else {
        this._activeFile = null;
        this._editor?.setModel(null);
      }
    }
  }

  private async _saveFile(filePath: string) {
    const file = this._openFiles.find((f) => f.path === filePath);
    if (!file) return;
    const content = file.model.getValue();
    await this._api('PUT', '/api/files/' + encodeURIComponent(filePath), { content });
    file.content = content;
    file.modified = false;
    this.requestUpdate();
  }

  private _createNewFile() {
    const name = prompt('File name (e.g., sensors.ts):');
    if (!name) return;
    const safeName = name.endsWith('.ts') ? name : name + '.ts';
    this._api('PUT', '/api/files/' + encodeURIComponent(safeName), { content: '' })
      .then(() => this._loadFileTree())
      .then(() => this._openFile(safeName));
  }

  private async _deleteFile(filePath: string) {
    await this._api('DELETE', '/api/files/' + encodeURIComponent(filePath));
    this._closeFile(filePath);
    this._loadFileTree();
  }

  private async _renameFile(oldPath: string, newPath: string) {
    const result = await this._api('PATCH', '/api/files/' + encodeURIComponent(oldPath), { newPath });
    if (result.error) return;

    // Update open file reference if renamed file is open
    const openFile = this._openFiles.find((f) => f.path === oldPath);
    if (openFile) {
      openFile.path = newPath;
      if (this._activeFile === oldPath) this._activeFile = newPath;
      this._openFiles = [...this._openFiles];
    }
    this._loadFileTree();
  }

  private async _openDiagnostic(file: string, line: number, column: number) {
    await this._openFile(file);
    if (this._editor) {
      const pos = { lineNumber: line, column };
      this._editor.setPosition(pos);
      this._editor.revealPositionInCenterIfOutsideViewport(pos);
    }
  }

  // ---- Build ----

  private async _triggerBuild() {
    if (this._building) return;
    this._building = true;
    this._statusText = 'Building...';
    this._statusClass = 'building';
    this._buildSteps = [];
    this._buildMessages = ['Starting build pipeline...'];

    // Save modified files first
    const savePromises = this._openFiles
      .filter((f) => f.modified)
      .map((f) => this._saveFile(f.path));
    await Promise.all(savePromises);

    try {
      const result = await this._api('POST', '/api/build');
      const lastBuild = result.lastBuild as Record<string, unknown> | undefined;
      if (lastBuild) {
        this._buildSteps = (lastBuild.steps as BuildStep[]) ?? [];
        if (lastBuild.entityCount !== undefined) {
          this._buildMessages = [...this._buildMessages, `Deployed ${lastBuild.entityCount} entities`];
        }
      }
      const success = lastBuild?.success;
      this._statusText = success ? 'Build OK' : 'Build Failed';
      this._statusClass = success ? 'success' : 'error';
    } catch (err) {
      this._buildMessages = [...this._buildMessages, `Build request failed: ${(err as Error).message}`];
      this._statusText = 'Error';
      this._statusClass = 'error';
    } finally {
      this._building = false;
      this._loadEntities();
    }
  }

  private async _regenTypes() {
    this._buildMessages = [...this._buildMessages, 'Regenerating types...'];
    try {
      const result = await this._api('POST', '/api/types/regenerate');
      if (result.success) {
        this._buildMessages = [
          ...this._buildMessages,
          `Types regenerated: ${result.entityCount} entities, ${result.serviceCount} services`,
        ];
        this._loadExtraTypes();
      } else {
        const errors = (result.errors as string[]) ?? [];
        this._buildMessages = [
          ...this._buildMessages,
          `Type regeneration failed: ${errors.join(', ')}`,
        ];
      }
    } catch (e) {
      console.warn('[ha-forge] Type regeneration failed', e);
      this._buildMessages = [...this._buildMessages, 'Type regeneration request failed'];
    }
  }

  // ---- Entities ----

  private async _loadEntities() {
    const data = await this._api('GET', '/api/entities');
    this._entities = (data.entities as EntityInfo[]) ?? [];
    console.debug(`[ha-forge] Loaded ${this._entities.length} entities`);
    this._refreshCodeLenses();
  }

  // ---- Logs ----

  private async _loadLogs(filter?: { level?: string; entity_id?: string; entity_ids?: string[]; search?: string }) {
    const params: string[] = [];
    if (filter?.level) params.push('level=' + encodeURIComponent(filter.level));
    // Support multi-entity filter (comma-separated)
    const entityIds = filter?.entity_ids?.length ? filter.entity_ids : filter?.entity_id ? [filter.entity_id] : [];
    if (entityIds.length > 0) params.push('entity_id=' + encodeURIComponent(entityIds.join(',')));
    if (filter?.search) params.push('search=' + encodeURIComponent(filter.search));
    params.push('limit=200');
    const data = await this._api('GET', '/api/logs?' + params.join('&'));
    this._logs = (data.logs as LogEntry[]) ?? [];
  }

  private async _loadLogEntityIds() {
    const data = await this._api('GET', '/api/logs/entities');
    this._logEntityIds = (data.entityIds as string[]) ?? [];
  }

  // ---- Panel changes ----

  private _onPanelChange(panel: string) {
    if (panel === 'entities' || panel === 'exports') this._loadEntities();
    if (panel === 'logs') { this._loadLogs(this._logFilter); this._loadLogEntityIds(); }
  }

  // ---- Keyboard shortcuts ----

  private _setupKeyboard() {
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        if (this._activeFile) this._saveFile(this._activeFile);
      }
    });

    window.addEventListener('beforeunload', (e) => {
      if (this._openFiles.some((f) => f.modified)) {
        e.preventDefault();
      }
    });
  }

  // ---- WebSocket ----

  private _connectWebSocket() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    try {
      const ws = new WebSocket(proto + '//' + location.host + this._base + '/ws');
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.channel === 'entities') this._loadEntities();
          if (msg.channel === 'logs') { this._loadLogs(this._logFilter); this._loadLogEntityIds(); }
          if (msg.channel === 'build' && msg.event === 'step_complete' && msg.data) {
            this._buildSteps = [...this._buildSteps, msg.data as BuildStep];
          }
        } catch (e) { console.warn('[ha-forge] WebSocket message parse error', e); }
      };
      ws.onopen = () => console.debug('[ha-forge] WebSocket connected');
      ws.onclose = () => { console.debug('[ha-forge] WebSocket disconnected, reconnecting...'); setTimeout(() => this._connectWebSocket(), 3000); };
    } catch (e) {
      console.warn('[ha-forge] WebSocket connection failed', e);
      setTimeout(() => this._connectWebSocket(), 5000);
    }
  }
}
