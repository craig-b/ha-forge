import { LitElement, html, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { FileEntry } from '../types.js';

@customElement('tse-sidebar')
export class TseSidebar extends LitElement {
  @property({ type: Array }) files: FileEntry[] = [];
  @property() activeFile: string | null = null;

  createRenderRoot() { return this; }

  render() {
    return html`
      <div class="sidebar-header">
        <span>Files</span>
        <button class="btn btn-sm" title="New file" @click=${this._onNewFile}>+</button>
      </div>
      <div class="file-tree">
        ${this._renderEntries(this.files, 0)}
      </div>
    `;
  }

  private _renderEntries(entries: FileEntry[], depth: number): unknown {
    return entries.map((entry) => html`
      <div class="file-item ${entry.type === 'directory' ? 'directory' : ''} ${this.activeFile === entry.path ? 'active' : ''} ${depth > 0 ? `indent-${Math.min(depth, 2)}` : ''}"
        @click=${entry.type === 'file' ? () => this._onOpenFile(entry.path) : nothing}>
        <span class="icon">${entry.type === 'directory' ? '\u25B6' : '\u25A0'}</span>
        <span>${entry.name}</span>
      </div>
      ${entry.children ? this._renderEntries(entry.children, depth + 1) : nothing}
    `);
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
