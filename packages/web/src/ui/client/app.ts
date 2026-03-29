import { LitElement, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import type { FileEntry, OpenFile, BuildStep, EntityInfo, LogEntry } from './types.js';
import { setAstAnalyzerActive } from './analyzers.js';
import { setTypeScriptApi, isReady as isAstReady } from './ast-helpers.js';
import { findEntityDefinitions, findScenarios, type EntityDefinitionLocation, type ScenarioLocation } from './ast-finders.js';
import { runShimSimulation, type SimulationShimResult, type CaptureData } from './simulation-shim.js';
import type { Monaco, MonacoModelInstance, MonacoEditorInstance, OpenFileInternal } from './monaco-types.js';
import { setupProviders, type ProviderHandles } from './editor-providers.js';
import { setupDiagnostics, type DiagnosticsHandles } from './editor-diagnostics.js';

import './components/tse-header.js';
import './components/tse-sidebar.js';
import './components/tse-editor-tabs.js';
import './components/tse-bottom-panel.js';

declare const require: {
  config(opts: Record<string, unknown>): void;
  (deps: string[], cb: (...args: never[]) => void, errCb?: (err: unknown) => void): void;
};

declare const monaco: Monaco;

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
  @state() private _simEntities: EntityDefinitionLocation[] = [];
  @state() private _simScenarios: ScenarioLocation[] = [];
  @state() private _shimResult: SimulationShimResult | null = null;
  private _logFilter: { level?: string; entity_id?: string; search?: string } = {};
  private _simTimeRangeMs = 60_000;
  private _simSelectedScenario = '';
  private _captureCache: CaptureData[] = [];

  private _editor: MonacoEditorInstance | null = null;
  private _completionRegistry: { domains: Record<string, unknown>; entities: Record<string, unknown> } | null = null;
  private _providerHandles: ProviderHandles | null = null;
  private _diagnosticsHandles: DiagnosticsHandles | null = null;
  private _base = (window as Record<string, unknown>).__INGRESS_PATH__ as string || '';

  createRenderRoot() { return this; }

  connectedCallback() {
    super.connectedCallback();
    this._initMonaco();
    this._setupKeyboard();
    this._connectWebSocket();

    this.addEventListener('tse-build', () => this._triggerBuild());
    this.addEventListener('tse-regen-types', () => this._regenTypes());
    this.addEventListener('tse-open-packages', () => console.log('tse-open-packages: not yet implemented'));
    this.addEventListener('tse-open-settings', () => console.log('tse-open-settings: not yet implemented'));
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
    this.addEventListener('tse-simulation-change', ((e: CustomEvent) => {
      if (e.detail.timeRangeMs) this._simTimeRangeMs = e.detail.timeRangeMs;
      if (e.detail.scenario) this._simSelectedScenario = e.detail.scenario;
      this._runShimSimulation();
    }) as EventListener);
    this.addEventListener('tse-capture-saved', (async () => {
      await this._loadCaptures();
      await this._loadFileTree();
      this._api('POST', '/api/types/regenerate');
      this._runShimSimulation();
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
        <tse-sidebar .files=${this._files} .activeFile=${this._activeFile} .entities=${this._entities}></tse-sidebar>

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
            .simEntities=${this._simEntities}
            .simScenarios=${this._simScenarios}
            .shimResult=${this._shimResult}
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
      if (!res.ok) console.error(`[ha-forge] API ${method} ${path} returned ${res.status}`);
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

      const providerHost = {
        getEntities: () => this._entities,
        getOpenFiles: () => this._openFiles,
        getCompletionRegistry: () => this._completionRegistry as ReturnType<typeof providerHost.getCompletionRegistry>,
        getActiveFile: () => this._activeFile,
        openFile: (path: string) => this._openFile(path),
        setActiveFile: (path: string) => { this._activeFile = path; },
        requestUpdate: () => this.requestUpdate(),
      };
      this._providerHandles = setupProviders(monaco, this._editor, providerHost);

      const diagHost = {
        getEntities: () => this._entities,
        getActiveFile: () => this._activeFile,
        getCompletionRegistry: () => this._completionRegistry as ReturnType<typeof diagHost.getCompletionRegistry>,
        onDiagnosticsRun: () => this._updateSimulationData(),
      };
      this._diagnosticsHandles = setupDiagnostics(monaco, this._editor, diagHost);

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
    }).catch(e => console.error('[ha-forge] Failed to load SDK types', e));

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
    }).catch(e => console.warn('[ha-forge] Failed to load HA registry types', e));  // non-fatal: editor works without HA types

    this._api('GET', '/api/types/completion-registry').then((data) => {
      if (data && data.domains) {
        this._completionRegistry = data;
      }
    }).catch(e => console.warn('[ha-forge] Failed to load completion registry', e));  // non-fatal: completions degraded
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
        this._diagnosticsHandles?.runDiagnostics();
        console.log('[ha-forge] TypeScript API loaded');
      }
    };
    script.onerror = (e) => console.error('[ha-forge] Failed to load TypeScript API', e);
    document.head.appendChild(script);

    // Load cronstrue for human-readable cron descriptions in hover tooltips.
    // cronstrue's UMD detects Monaco's AMD loader and registers as an AMD module
    // instead of setting a global — so we must load it via require(), not a script tag.
    require.config({
      paths: { cronstrue: 'https://cdn.jsdelivr.net/npm/cronstrue@2.52.0/dist/cronstrue.min' },
    });
    require(['cronstrue'], (cronstrue: { toString(expr: string, opts?: { throwExceptionOnParseError?: boolean }): string }) => {
      this._providerHandles?.setCronstrue(cronstrue);
      this._providerHandles?.refreshCodeLenses();
      console.log('[ha-forge] cronstrue loaded');
    }, (err: unknown) => console.warn('[ha-forge] Failed to load cronstrue', err));
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
    this._diagnosticsHandles?.runDiagnostics();
  }

  private _activateFile(filePath: string) {
    const file = this._openFiles.find((f) => f.path === filePath);
    if (!file) return;
    this._activeFile = filePath;
    this._editor?.setModel(file.model);
    this._diagnosticsHandles?.runDiagnostics();
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

  private async _saveFileAs(filePath: string) {
    const file = this._openFiles.find((f) => f.path === filePath);
    if (!file) return;
    const name = prompt('Save as:', filePath);
    if (!name || name === filePath) return;
    const safeName = name.endsWith('.ts') ? name : name + '.ts';
    const content = file.model.getValue();
    await this._api('PUT', '/api/files/' + encodeURIComponent(safeName), { content });
    await this._loadFileTree();
    await this._openFile(safeName);
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
    console.log(`[ha-forge] Loaded ${this._entities.length} entities`);
    this._providerHandles?.refreshCodeLenses();
    this._providerHandles?.refreshInlayHints();
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
    if (panel === 'exports') this._loadEntities();
    if (panel === 'logs') { this._loadLogs(this._logFilter); this._loadLogEntityIds(); }
    if (panel === 'simulate') { this._loadCaptures(); this._updateSimulationData(); }
  }

  // ---- Captures ----

  private async _loadCaptures() {
    try {
      const index = await this._api('GET', '/api/captures');
      const captures = (index.captures as Array<{ entity_id: string; name: string; eventCount: number }>) ?? [];
      if (captures.length === 0) { this._captureCache = []; return; }
      const loaded: CaptureData[] = [];
      for (const cap of captures) {
        try {
          const resp = await fetch(this._base + `/api/captures/${encodeURIComponent(cap.name)}`);
          if (resp.ok) {
            const data = await resp.json();
            loaded.push({ entity_id: data.entity_id, name: data.name, events: data.events });
          }
        } catch { /* skip */ }
      }
      this._captureCache = loaded;
    } catch {
      this._captureCache = [];
    }
  }

  // ---- Simulation ----

  private _updateSimulationData() {
    if (!isAstReady()) return;

    const allEntities: EntityDefinitionLocation[] = [];
    const allScenarios: ScenarioLocation[] = [];
    for (const file of this._openFiles) {
      const content = file.model.getValue();
      allEntities.push(...findEntityDefinitions(content, file.path));
      allScenarios.push(...findScenarios(content, file.path));
    }
    this._simEntities = allEntities;
    this._simScenarios = allScenarios;

    this._runShimSimulation();
  }

  private async _runShimSimulation() {
    if (this._simScenarios.length === 0 || !isAstReady()) {
      this._shimResult = null;
      return;
    }

    const tsApi = (globalThis as Record<string, unknown>).ts as typeof import('typescript') | undefined;
    if (!tsApi) {
      this._shimResult = null;
      return;
    }

    // Transpile all open files for shim execution (use live editor content, not last-saved)
    const transpiledParts: string[] = [];
    for (const file of this._openFiles) {
      try {
        const result = tsApi.transpileModule(file.model.getValue(), {
          compilerOptions: {
            target: tsApi.ScriptTarget.ES2020,
            module: tsApi.ModuleKind.None,
            removeComments: true,
          },
          fileName: file.path,
        });
        const cleaned = result.outputText
          .replace(/^export\s+(default\s+)?/gm, '')
          .replace(/^import\s+.*$/gm, '');
        transpiledParts.push(cleaned);
      } catch {
        // Skip files that fail to transpile
      }
    }

    if (transpiledParts.length === 0) {
      this._shimResult = null;
      return;
    }

    const transpiledJs = transpiledParts.join('\n;\n');

    try {
      this._shimResult = await runShimSimulation(transpiledJs, this._simSelectedScenario, this._simTimeRangeMs, this._captureCache);
    } catch {
      this._shimResult = null;
    }
  }

  // ---- Keyboard shortcuts ----

  private _setupKeyboard() {
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'S') {
        e.preventDefault();
        if (this._activeFile) this._saveFileAs(this._activeFile);
      } else if ((e.ctrlKey || e.metaKey) && e.key === 's') {
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
      ws.onopen = () => console.log('[ha-forge] WebSocket connected');
      ws.onclose = () => { console.warn('[ha-forge] WebSocket disconnected, reconnecting...'); setTimeout(() => this._connectWebSocket(), 3000); };
    } catch (e) {
      console.error('[ha-forge] WebSocket connection failed', e);
      setTimeout(() => this._connectWebSocket(), 5000);
    }
  }
}
