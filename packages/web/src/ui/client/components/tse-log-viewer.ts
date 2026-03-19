import { LitElement, html } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { LogEntry } from '../types.js';

@customElement('tse-log-viewer')
export class TseLogViewer extends LitElement {
  @property({ type: Array }) logs: LogEntry[] = [];
  @state() private _level = '';
  @state() private _search = '';
  private _debounceTimer: ReturnType<typeof setTimeout> | null = null;

  createRenderRoot() { return this; }

  render() {
    return html`
      <div class="log-filters">
        <select @change=${this._onLevelChange}>
          <option value="">All levels</option>
          <option value="error">Error</option>
          <option value="warn">Warning</option>
          <option value="info">Info</option>
          <option value="debug">Debug</option>
        </select>
        <input type="text" placeholder="Search logs..." @input=${this._onSearchInput} />
      </div>
      <div>
        ${this.logs.length === 0
          ? html`<div class="empty-state">No log entries</div>`
          : this.logs.map((log) => html`
            <div class="log-entry">
              <span class="log-time">${new Date(log.timestamp).toLocaleTimeString()}</span>
              <span class="log-level ${log.level}">${log.level.toUpperCase()}</span>
              <span class="log-entity">${log.entity_id ?? ''}</span>
              <span class="log-msg">${log.message}</span>
            </div>
          `)}
      </div>
    `;
  }

  private _onLevelChange(e: Event) {
    this._level = (e.target as HTMLSelectElement).value;
    this._emitFilter();
  }

  private _onSearchInput(e: Event) {
    const value = (e.target as HTMLInputElement).value;
    if (this._debounceTimer) clearTimeout(this._debounceTimer);
    this._debounceTimer = setTimeout(() => {
      this._search = value;
      this._emitFilter();
    }, 300);
  }

  private _emitFilter() {
    this.dispatchEvent(new CustomEvent('tse-filter-change', {
      bubbles: true, composed: true,
      detail: { level: this._level, search: this._search },
    }));
  }
}
