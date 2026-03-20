import { LitElement, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { FileEntry } from '../types.js';

@customElement('tse-sidebar')
export class TseSidebar extends LitElement {
  @property({ type: Array }) files: FileEntry[] = [];
  @property() activeFile: string | null = null;

  @state() private _ctxMenu: { x: number; y: number; path: string; name: string } | null = null;
  @state() private _renaming: string | null = null;

  createRenderRoot() { return this; }

  connectedCallback() {
    super.connectedCallback();
    this._onDocClick = this._onDocClick.bind(this);
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
    return html`
      <div class="sidebar-header">
        <span>Files</span>
        <button class="btn btn-sm" title="New file" @click=${this._onNewFile}>+</button>
      </div>
      <div class="file-tree">
        ${this._renderEntries(this.files, 0)}
      </div>
      ${this._ctxMenu ? html`
        <div class="ctx-menu" style="top:${this._ctxMenu.y}px;left:${this._ctxMenu.x}px">
          <div class="ctx-item" @click=${this._ctxRename}>Rename</div>
          <div class="ctx-item ctx-danger" @click=${this._ctxDelete}>Delete</div>
        </div>
      ` : nothing}
    `;
  }

  private _renderEntries(entries: FileEntry[], depth: number): unknown {
    return entries.map((entry) => {
      const isRenaming = this._renaming === entry.path;
      return html`
        <div class="file-item ${entry.type === 'directory' ? 'directory' : ''} ${this.activeFile === entry.path ? 'active' : ''} ${depth > 0 ? `indent-${Math.min(depth, 2)}` : ''}"
          @click=${entry.type === 'file' ? () => this._onOpenFile(entry.path) : nothing}
          @contextmenu=${entry.type === 'file' ? (e: MouseEvent) => this._onContext(e, entry) : nothing}>
          <span class="icon">${entry.type === 'directory' ? '\u25B6' : '\u25A0'}</span>
          ${isRenaming ? html`
            <input class="rename-input" type="text" .value=${entry.name}
              @keydown=${(e: KeyboardEvent) => this._onRenameKey(e, entry)}
              @blur=${(e: FocusEvent) => this._commitRename(e, entry)}
              @click=${(e: Event) => e.stopPropagation()} />
          ` : html`<span>${entry.name}</span>`}
        </div>
        ${entry.children ? this._renderEntries(entry.children, depth + 1) : nothing}
      `;
    });
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
}
