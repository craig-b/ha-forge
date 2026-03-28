import { LitElement, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { OpenFile } from '../types.js';

@customElement('tse-editor-tabs')
export class TseEditorTabs extends LitElement {
  @property({ type: Array }) openFiles: OpenFile[] = [];
  @property() activeFile: string | null = null;

  createRenderRoot() { return this; }

  render() {
    return html`
      ${this.openFiles.map((file) => html`
        <div class="editor-tab ${this.activeFile === file.path ? 'active' : ''} ${file.modified ? 'modified' : ''}"
          @click=${() => this._onActivate(file.path)}
          @auxclick=${(e: MouseEvent) => { if (e.button === 1) { e.preventDefault(); this._onClose(file.path); } }}>
          <span class="name">${file.path.split('/').pop()}</span>
          <span class="close" @click=${(e: Event) => { e.stopPropagation(); this._onClose(file.path); }}>&times;</span>
        </div>
      `)}
    `;
  }

  private _onActivate(path: string) {
    this.dispatchEvent(new CustomEvent('tse-activate-file', {
      bubbles: true, composed: true, detail: { path },
    }));
  }

  private _onClose(path: string) {
    this.dispatchEvent(new CustomEvent('tse-close-file', {
      bubbles: true, composed: true, detail: { path },
    }));
  }
}
