import { LitElement, html, nothing } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import type { EntityInfo } from '../types.js';

@customElement('tse-exports-panel')
export class TseExportsPanel extends LitElement {
  @property({ type: Array }) entities: EntityInfo[] = [];

  createRenderRoot() { return this; }

  render() {
    const byFile = new Map<string, EntityInfo[]>();
    for (const e of this.entities) {
      const file = e.sourceFile || '(unknown)';
      let group = byFile.get(file);
      if (!group) { group = []; byFile.set(file, group); }
      group.push(e);
    }

    const files = [...byFile.entries()].sort((a, b) => a[0].localeCompare(b[0]));

    if (files.length === 0) {
      return html`<div class="exports-empty">No exports found. Build your project to see exported entities.</div>`;
    }

    return html`
      <div class="exports-list">
        ${files.map(([file, entities]) => html`
          <div class="exports-file-group">
            <div class="exports-file-header" @click=${() => this._openFile(file)}>
              <span class="exports-file-name">${file}</span>
              <span class="exports-file-count">${entities.length} ${entities.length === 1 ? 'entity' : 'entities'}</span>
            </div>
            <div class="exports-file-entities">
              ${entities.map((e) => html`
                <div class="exports-entity">
                  <span class="exports-entity-type">${e.type}</span>
                  <span class="exports-entity-id">${e.id}</span>
                  <span class="exports-entity-name">${e.name !== e.id ? e.name : ''}</span>
                </div>
              `)}
            </div>
          </div>
        `)}
      </div>
    `;
  }

  private _openFile(sourceFile: string) {
    if (sourceFile === '(unknown)') return;
    this.dispatchEvent(new CustomEvent('tse-open-file', {
      bubbles: true, composed: true, detail: { path: sourceFile },
    }));
  }
}
