import { LitElement, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import type { FileEntry, OpenFile, BuildStep, EntityInfo, LogEntry } from './types.js';
import { runAllAnalyzers, findEntitySymbols, setAstAnalyzerActive, type AnalyzerDiagnostic } from './analyzers.js';
import { setTypeScriptApi, analyzeWithAst, isReady as isAstReady, generateDeviceRefactor, getDeviceInfoInsertion, findCronStrings } from './ast-analyzers.js';

import './components/tse-header.js';
import './components/tse-sidebar.js';
import './components/tse-editor-tabs.js';
import './components/tse-bottom-panel.js';

// Minimal Monaco type declarations for what we use
declare const require: {
  config(opts: Record<string, unknown>): void;
  (deps: string[], cb: () => void): void;
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

interface MonacoEditorInstance {
  setModel(model: MonacoModelInstance | null): void;
  getModel(): MonacoModelInstance | null;
  onDidChangeModelContent(listener: () => void): { dispose(): void };
  setPosition(pos: { lineNumber: number; column: number }): void;
  revealPositionInCenterIfOutsideViewport(pos: { lineNumber: number; column: number }): void;
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
    return fetch(this._base + path, opts).then((res) => res.json() as Promise<Record<string, unknown>>);
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
    }).catch(() => {});

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
    }).catch(() => {});
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
      }
    };
    document.head.appendChild(script);

    // Load cronstrue for human-readable cron descriptions in hover tooltips
    const cronstrueScript = document.createElement('script');
    cronstrueScript.src = 'https://cdn.jsdelivr.net/npm/cronstrue@2.52.0/dist/cronstrue.min.js';
    cronstrueScript.onload = () => { this._setupCronHoverProvider(); };
    document.head.appendChild(cronstrueScript);
  }

  private _setupCronHoverProvider() {
    const cronstrue = (globalThis as Record<string, unknown>).cronstrue as
      { toString(expr: string, opts?: { throwExceptionOnParseError?: boolean }): string } | undefined;
    if (!cronstrue) return;

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

  // ---- Custom diagnostics ----

  private _diagTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly DIAG_OWNER = 'ha-forge-lint';
  private static readonly AST_DIAG_OWNER = 'ha-forge-ast';
  private static readonly DIAG_DEBOUNCE = 300;

  private _setupCustomDiagnostics() {
    if (!this._editor) return;

    // Run diagnostics on content change (debounced)
    this._editor.onDidChangeModelContent(() => {
      if (this._diagTimer) clearTimeout(this._diagTimer);
      this._diagTimer = setTimeout(() => this._runDiagnostics(), TseApp.DIAG_DEBOUNCE);
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
    }
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
    } catch {
      this._buildMessages = [...this._buildMessages, 'Type regeneration request failed'];
    }
  }

  // ---- Entities ----

  private async _loadEntities() {
    const data = await this._api('GET', '/api/entities');
    this._entities = (data.entities as EntityInfo[]) ?? [];
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
        } catch { /* ignore parse errors */ }
      };
      ws.onclose = () => { setTimeout(() => this._connectWebSocket(), 3000); };
    } catch {
      setTimeout(() => this._connectWebSocket(), 5000);
    }
  }
}
