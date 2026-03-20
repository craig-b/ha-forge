import { LitElement, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { LogEntry } from '../types.js';

@customElement('tse-log-viewer')
export class TseLogViewer extends LitElement {
  @property({ type: Array }) logs: LogEntry[] = [];
  @property({ type: Array }) entityIds: string[] = [];
  @state() private _level = '';
  @state() private _search = '';
  @state() private _selectedEntities: string[] = [];
  @state() private _entityDropdownOpen = false;
  private _debounceTimer: ReturnType<typeof setTimeout> | null = null;

  createRenderRoot() { return this; }

  connectedCallback() {
    super.connectedCallback();
    document.addEventListener('click', this._onDocumentClick);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener('click', this._onDocumentClick);
  }

  render() {
    return html`
      <div class="log-filters">
        <select @change=${this._onLevelChange}>
          <option value="">All levels</option>
          <option value="error">Error+</option>
          <option value="warn">Warning+</option>
          <option value="info">Info+</option>
          <option value="debug">Debug+</option>
        </select>
        <div class="filter-input-wrap entity-multiselect">
          <div class="multiselect-toggle" @click=${this._toggleEntityDropdown}>
            ${this._selectedEntities.length === 0
              ? html`<span class="multiselect-placeholder">Filter entities...</span>`
              : html`<span class="multiselect-tags">${this._selectedEntities.map((id) => html`<span class="multiselect-tag">${id}<span class="tag-remove" @click=${(e: Event) => { e.stopPropagation(); this._removeEntity(id); }}>&times;</span></span>`)}</span>`
            }
          </div>
          ${this._entityDropdownOpen ? html`
            <div class="multiselect-dropdown">
              ${this.entityIds.length === 0
                ? html`<div class="multiselect-option disabled">No entities</div>`
                : this.entityIds.map((id) => html`
                  <label class="multiselect-option">
                    <input type="checkbox"
                      .checked=${this._selectedEntities.includes(id)}
                      @change=${() => this._toggleEntity(id)} />
                    ${id}
                  </label>
                `)
              }
            </div>
          ` : nothing}
        </div>
        <div class="filter-input-wrap">
          <input type="text" placeholder="Search logs..." @input=${this._onSearchInput} .value=${this._search} />
          ${this._search ? html`<span class="filter-clear" @click=${this._clearSearch}>&times;</span>` : nothing}
        </div>
      </div>
      <div>
        ${this.logs.length === 0
          ? html`<div class="empty-state">No log entries</div>`
          : this.logs.map((log) => html`
            <div class="log-entry">
              <span class="log-time">${new Date(log.timestamp).toLocaleTimeString()}</span>
              <span class="log-level ${log.level}">${log.level.toUpperCase()}</span>
              <span class="log-entity">${log.entity_id ?? ''}</span>
              <span class="log-caller">${log.caller ?? ''}</span>
              <span class="log-msg">${log.message}</span>
              ${log.data ? html`<span class="log-data" title=${log.data}>{ }</span>` : nothing}
            </div>
          `)}
      </div>
    `;
  }

  private _onLevelChange(e: Event) {
    this._level = (e.target as HTMLSelectElement).value;
    this._emitFilter();
  }

  private _toggleEntityDropdown(e: Event) {
    e.stopPropagation();
    this._entityDropdownOpen = !this._entityDropdownOpen;
  }

  private _onDocumentClick = () => {
    if (this._entityDropdownOpen) this._entityDropdownOpen = false;
  };

  private _toggleEntity(id: string) {
    if (this._selectedEntities.includes(id)) {
      this._selectedEntities = this._selectedEntities.filter((e) => e !== id);
    } else {
      this._selectedEntities = [...this._selectedEntities, id];
    }
    this._emitFilter();
  }

  private _removeEntity(id: string) {
    this._selectedEntities = this._selectedEntities.filter((e) => e !== id);
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

  private _clearSearch() {
    this._search = '';
    this._emitFilter();
  }

  private _emitFilter() {
    this.dispatchEvent(new CustomEvent('tse-filter-change', {
      bubbles: true, composed: true,
      detail: {
        level: this._level,
        entity_id: this._selectedEntities.length === 1 ? this._selectedEntities[0] : '',
        entity_ids: this._selectedEntities,
        search: this._search,
      },
    }));
  }
}
