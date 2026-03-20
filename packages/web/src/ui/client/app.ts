import { LitElement, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import type { FileEntry, OpenFile, BuildStep, EntityInfo, LogEntry } from './types.js';

import './components/tse-header.js';
import './components/tse-sidebar.js';
import './components/tse-editor-tabs.js';
import './components/tse-bottom-panel.js';

// Minimal Monaco type declarations for what we use
declare const require: {
  config(opts: Record<string, unknown>): void;
  (deps: string[], cb: () => void): void;
};
declare const monaco: {
  editor: {
    create(el: HTMLElement, opts: Record<string, unknown>): MonacoEditorInstance;
    createModel(content: string, language: string, uri: unknown): MonacoModelInstance;
  };
  languages: {
    typescript: {
      typescriptDefaults: {
        setCompilerOptions(opts: Record<string, unknown>): void;
        setDiagnosticsOptions(opts: Record<string, unknown>): void;
        addExtraLib(content: string, uri: string): void;
      };
      ScriptTarget: { ES2022: number };
      ModuleResolutionKind: { NodeJs: number };
      ModuleKind: { ESNext: number };
    };
  };
  Uri: { parse(uri: string): unknown };
};

interface MonacoModelInstance {
  getValue(): string;
  setValue(value: string): void;
  onDidChangeContent(listener: () => void): { dispose(): void };
  dispose(): void;
}

interface MonacoEditorInstance {
  setModel(model: MonacoModelInstance | null): void;
  getModel(): MonacoModelInstance | null;
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
      paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs' },
    });

    require(['vs/editor/editor.main'], () => {
      monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
        target: monaco.languages.typescript.ScriptTarget.ES2022,
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

      this._loadExtraTypes();
      this._loadFileTree();
      this._loadEntities();
    });
  }

  private _loadExtraTypes() {
    this._api('GET', '/api/types/sdk').then((result) => {
      if (result?.declaration) {
        monaco.languages.typescript.typescriptDefaults.addExtraLib(
          result.declaration as string,
          'ts:sdk/globals.d.ts',
        );
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
        monaco.languages.typescript.typescriptDefaults.addExtraLib(
          content,
          'ts:ha-registry/index.d.ts',
        );
      }
    }).catch(() => {});
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
  }

  private _activateFile(filePath: string) {
    const file = this._openFiles.find((f) => f.path === filePath);
    if (!file) return;
    this._activeFile = filePath;
    this._editor?.setModel(file.model);
  }

  private _closeFile(filePath: string) {
    const idx = this._openFiles.findIndex((f) => f.path === filePath);
    if (idx === -1) return;

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

  // ---- Panel changes ----

  private _onPanelChange(panel: string) {
    if (panel === 'entities') this._loadEntities();
    if (panel === 'logs') this._loadLogs(this._logFilter);
  }

  // ---- Keyboard shortcuts ----

  private _setupKeyboard() {
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        if (this._activeFile) this._saveFile(this._activeFile);
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
          if (msg.channel === 'logs') this._loadLogs(this._logFilter);
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
