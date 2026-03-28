import { LitElement, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { EntityInfo, FileEntry } from '../types.js';

@customElement('tse-sidebar')
export class TseSidebar extends LitElement {
  @property({ type: Array }) files: FileEntry[] = [];
  @property() activeFile: string | null = null;
  @property({ type: Array }) entities: EntityInfo[] = [];

  @state() private _ctxMenu: { x: number; y: number; path: string; name: string } | null = null;
  @state() private _renaming: string | null = null;
  @state() private _expanded = new Set<string>();

  createRenderRoot() { return this; }

  connectedCallback() {
    super.connectedCallback();
    this._onDocClick = this._onDocClick.bind(this);
    this._onResizeMove = this._onResizeMove.bind(this);
    this._onResizeUp = this._onResizeUp.bind(this);
    this._onSplitMove = this._onSplitMove.bind(this);
    this._onSplitUp = this._onSplitUp.bind(this);
    document.addEventListener('click', this._onDocClick);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener('click', this._onDocClick);
  }

  private _onDocClick() {
    if (this._ctxMenu) this._ctxMenu = null;
  }

  render() {
    const fileEntities = this.activeFile
      ? this.entities.filter((e) => e.sourceFile === this.activeFile)
      : [];

    // Group entities by type
    const groups = new Map<string, EntityInfo[]>();
    for (const e of fileEntities) {
      const list = groups.get(e.type) ?? [];
      list.push(e);
      groups.set(e.type, list);
    }

    return html`
      <div class="sidebar-files" style="flex: var(--sidebar-files-flex, 2)">
        <div class="sidebar-header">
          <span>Files</span>
          <button class="btn btn-sm" title="New file" @click=${this._onNewFile}>+</button>
        </div>
        <div class="file-tree">
          ${this._renderEntries(this.files, 0)}
        </div>
      </div>
      <div class="sidebar-split-handle" @mousedown=${this._onSplitStart}></div>
      <div class="sidebar-entities" style="flex: var(--sidebar-entities-flex, 3)">
        <div class="sidebar-header">
          <span>Entities${fileEntities.length ? ` (${fileEntities.length})` : ''}</span>
        </div>
        <div class="entity-list">
          ${fileEntities.length === 0
            ? html`<div class="entity-list-empty">${this.activeFile ? 'No entities in this file' : 'No file open'}</div>`
            : [...groups.entries()].map(([type, items]) => html`
              <div class="entity-group-header">${type}</div>
              ${items.map((e) => html`
                <div class="entity-list-item" title="${e.id}">
                  <span class="entity-dot ${e.status}"></span>
                  <span class="entity-list-name">${e.name}</span>
                  <span class="entity-list-state">${this._formatState(e)}</span>
                </div>
              `)}
            `)}
        </div>
      </div>
      <div class="sidebar-resize-handle"
        @mousedown=${this._onResizeStart}></div>
      ${this._ctxMenu ? html`
        <div class="ctx-menu" style="top:${this._ctxMenu.y}px;left:${this._ctxMenu.x}px">
          <div class="ctx-item" @click=${this._ctxDownload}>Download</div>
          <div class="ctx-item" @click=${this._ctxRename}>Rename</div>
          <div class="ctx-item ctx-danger" @click=${this._ctxDelete}>Delete</div>
        </div>
      ` : nothing}
    `;
  }

  private _formatState(e: EntityInfo): string {
    const s = String(e.state ?? '');
    if (!s) return '';
    const unit = e.unit_of_measurement;
    return unit ? `${s} ${unit}` : s;
  }

  private _renderEntries(entries: FileEntry[], depth: number): unknown {
    return entries.map((entry) => {
      const isRenaming = this._renaming === entry.path;
      const isDir = entry.type === 'directory';
      const isExpanded = this._expanded.has(entry.path);
      return html`
        <div class="file-item ${isDir ? 'directory' : ''} ${this.activeFile === entry.path ? 'active' : ''} ${depth > 0 ? `indent-${Math.min(depth, 2)}` : ''}"
          @click=${isDir ? () => this._toggleDir(entry.path) : () => this._onOpenFile(entry.path)}
          @contextmenu=${!isDir ? (e: MouseEvent) => this._onContext(e, entry) : nothing}>
          <span class="icon${isDir && isExpanded ? ' expanded' : ''}">${isDir ? '\u25B6' : this._fileIcon(entry)}</span>
          ${isRenaming ? html`
            <input class="rename-input" type="text" .value=${entry.name}
              @keydown=${(e: KeyboardEvent) => this._onRenameKey(e, entry)}
              @blur=${(e: FocusEvent) => this._commitRename(e, entry)}
              @click=${(e: Event) => e.stopPropagation()} />
          ` : html`<span>${entry.name}</span>`}
        </div>
        ${isDir && isExpanded && entry.children ? this._renderEntries(entry.children, depth + 1) : nothing}
      `;
    });
  }

  private _toggleDir(path: string) {
    const next = new Set(this._expanded);
    if (next.has(path)) next.delete(path); else next.add(path);
    this._expanded = next;
  }

  private _fileIcon(entry: FileEntry): string {
    if (entry.path.startsWith('captures/')) return '\u25C9'; // ◉ capture
    if (entry.name === 'package.json' || entry.name === 'tsconfig.json' || entry.name === 'package-lock.json') return '\u2699'; // ⚙ config
    if (entry.name.endsWith('.ts')) return '\u25C7'; // ◇ typescript
    return '\u25A0'; // ■ generic
  }

  updated() {
    if (this._renaming) {
      const input = this.querySelector('.rename-input') as HTMLInputElement | null;
      if (input && document.activeElement !== input) {
        input.focus();
        const dot = input.value.lastIndexOf('.');
        input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
      }
    }
  }

  private _onContext(e: MouseEvent, entry: FileEntry) {
    e.preventDefault();
    e.stopPropagation();
    this._ctxMenu = { x: e.clientX, y: e.clientY, path: entry.path, name: entry.name };
  }

  private async _ctxDownload() {
    if (!this._ctxMenu) return;
    const filePath = this._ctxMenu.path;
    const name = this._ctxMenu.name;
    this._ctxMenu = null;
    const base = (window as unknown as Record<string, unknown>).__INGRESS_PATH__ as string || '';
    try {
      const resp = await fetch(`${base}/api/files/${encodeURIComponent(filePath)}`);
      const data = await resp.json() as { content?: string };
      if (!data.content) return;
      const blob = new Blob([data.content], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
    } catch { /* ignore */ }
  }

  private _ctxRename() {
    if (!this._ctxMenu) return;
    this._renaming = this._ctxMenu.path;
    this._ctxMenu = null;
  }

  private _ctxDelete() {
    if (!this._ctxMenu) return;
    const path = this._ctxMenu.path;
    const name = this._ctxMenu.name;
    this._ctxMenu = null;
    if (confirm(`Delete "${name}"?`)) {
      this.dispatchEvent(new CustomEvent('tse-delete-file', {
        bubbles: true, composed: true, detail: { path },
      }));
    }
  }

  private _onRenameKey(e: KeyboardEvent, entry: FileEntry) {
    if (e.key === 'Enter') {
      (e.target as HTMLInputElement).blur();
    } else if (e.key === 'Escape') {
      this._renaming = null;
    }
  }

  private _commitRename(e: FocusEvent, entry: FileEntry) {
    const input = e.target as HTMLInputElement;
    const newName = input.value.trim();
    this._renaming = null;
    if (!newName || newName === entry.name) return;

    const dir = entry.path.includes('/') ? entry.path.substring(0, entry.path.lastIndexOf('/') + 1) : '';
    const newPath = dir + newName;
    this.dispatchEvent(new CustomEvent('tse-rename-file', {
      bubbles: true, composed: true, detail: { oldPath: entry.path, newPath },
    }));
  }

  private _onOpenFile(filePath: string) {
    this.dispatchEvent(new CustomEvent('tse-open-file', {
      bubbles: true, composed: true, detail: { path: filePath },
    }));
  }

  private _onNewFile() {
    this.dispatchEvent(new CustomEvent('tse-new-file', { bubbles: true, composed: true }));
  }

  // ---- Width Resize (right edge) ----

  private _startX = 0;
  private _startWidth = 0;

  private _onResizeStart(e: MouseEvent) {
    e.preventDefault();
    this._startX = e.clientX;
    this._startWidth = this.getBoundingClientRect().width;
    document.addEventListener('mousemove', this._onResizeMove);
    document.addEventListener('mouseup', this._onResizeUp);
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';
  }

  private _onResizeMove(e: MouseEvent) {
    const delta = e.clientX - this._startX;
    const newWidth = Math.max(120, Math.min(600, this._startWidth + delta));
    document.documentElement.style.setProperty('--sidebar-width', `${newWidth}px`);
  }

  private _onResizeUp() {
    document.removeEventListener('mousemove', this._onResizeMove);
    document.removeEventListener('mouseup', this._onResizeUp);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }

  // ---- Split Resize (between files and entities) ----

  private _splitStartY = 0;
  private _splitStartFilesFlex = 0;
  private _splitStartEntitiesFlex = 0;

  private _onSplitStart(e: MouseEvent) {
    e.preventDefault();
    this._splitStartY = e.clientY;
    const filesEl = this.querySelector('.sidebar-files') as HTMLElement | null;
    const entitiesEl = this.querySelector('.sidebar-entities') as HTMLElement | null;
    if (!filesEl || !entitiesEl) return;
    const totalHeight = filesEl.offsetHeight + entitiesEl.offsetHeight;
    this._splitStartFilesFlex = filesEl.offsetHeight / totalHeight;
    this._splitStartEntitiesFlex = entitiesEl.offsetHeight / totalHeight;
    document.addEventListener('mousemove', this._onSplitMove);
    document.addEventListener('mouseup', this._onSplitUp);
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
  }

  private _onSplitMove(e: MouseEvent) {
    const filesEl = this.querySelector('.sidebar-files') as HTMLElement | null;
    const entitiesEl = this.querySelector('.sidebar-entities') as HTMLElement | null;
    if (!filesEl || !entitiesEl) return;
    const totalHeight = filesEl.offsetHeight + entitiesEl.offsetHeight;
    const delta = e.clientY - this._splitStartY;
    const deltaFrac = delta / totalHeight;
    const newFilesFlex = Math.max(0.15, Math.min(0.85, this._splitStartFilesFlex + deltaFrac));
    const newEntitiesFlex = 1 - newFilesFlex;
    this.style.setProperty('--sidebar-files-flex', String(newFilesFlex));
    this.style.setProperty('--sidebar-entities-flex', String(newEntitiesFlex));
  }

  private _onSplitUp() {
    document.removeEventListener('mousemove', this._onSplitMove);
    document.removeEventListener('mouseup', this._onSplitUp);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }
}
