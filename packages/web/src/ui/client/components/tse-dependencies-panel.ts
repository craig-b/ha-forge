import { LitElement, html } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

@customElement('tse-dependencies-panel')
export class TseDependenciesPanel extends LitElement {
  @property({ type: String }) filePath = '';
  @property({ type: String }) basePath = '';
  @state() private _deps: Record<string, string> = {};
  @state() private _loading = false;
  @state() private _newPkg = '';

  createRenderRoot() { return this; }

  updated(changed: Map<string, unknown>) {
    if (changed.has('filePath') && this.filePath) {
      this._fetchDeps();
    }
  }

  render() {
    if (!this.filePath) {
      return html`<div class="deps-empty">Select a file to manage dependencies</div>`;
    }

    const entries = Object.entries(this._deps);

    return html`
      <div class="deps-panel">
        <div class="deps-add">
          <input type="text" placeholder="Package name"
            .value=${this._newPkg}
            @input=${(e: Event) => { this._newPkg = (e.target as HTMLInputElement).value; }}
            @keydown=${(e: KeyboardEvent) => { if (e.key === 'Enter') this._addPackage(); }}>
          <button @click=${this._addPackage} ?disabled=${!this._newPkg.trim()}>Add</button>
        </div>
        ${this._loading ? html`<div class="deps-loading">Loading...</div>` : ''}
        ${entries.length === 0 && !this._loading
          ? html`<div class="deps-empty">No dependencies</div>`
          : html`
            <div class="deps-list">
              ${entries.map(([name, version]) => html`
                <div class="deps-entry">
                  <span class="deps-name">${name}</span>
                  <span class="deps-version">${version}</span>
                  <button class="deps-remove" @click=${() => this._removePackage(name)}
                    title="Remove">x</button>
                </div>
              `)}
            </div>
          `}
      </div>
    `;
  }

  private async _fetchDeps() {
    this._loading = true;
    try {
      const res = await fetch(`${this.basePath}/api/packages?file=${encodeURIComponent(this.filePath)}`);
      if (res.ok) {
        const data = await res.json();
        this._deps = data.dependencies ?? {};
      }
    } catch { /* silent */ }
    finally { this._loading = false; }
  }

  private async _addPackage() {
    const name = this._newPkg.trim();
    if (!name) return;
    try {
      const res = await fetch(`${this.basePath}/api/packages?file=${encodeURIComponent(this.filePath)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (res.ok) {
        this._newPkg = '';
        await this._fetchDeps();
      }
    } catch { /* silent */ }
  }

  private async _removePackage(name: string) {
    try {
      const res = await fetch(
        `${this.basePath}/api/packages/${encodeURIComponent(name)}?file=${encodeURIComponent(this.filePath)}`,
        { method: 'DELETE' },
      );
      if (res.ok) {
        await this._fetchDeps();
      }
    } catch { /* silent */ }
  }
}
