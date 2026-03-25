import { LitElement, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';

import './tse-signal-chart.js';

interface HAState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
}

interface SignalEvent {
  t: number;
  value: string | number;
}

@customElement('tse-capture-modal')
export class TseCaptureModal extends LitElement {
  @state() private _entityFilter = '';
  @state() private _selectedEntity = '';
  @state() private _haStates: HAState[] = [];
  @state() private _loadingStates = false;
  @state() private _start = '';
  @state() private _end = '';
  @state() private _name = '';
  @state() private _previewEvents: SignalEvent[] = [];
  @state() private _previewLoading = false;
  @state() private _previewStats = '';
  @state() private _saving = false;
  @state() private _error = '';
  @state() private _showDropdown = false;

  private _base = (window as unknown as Record<string, unknown>).__INGRESS_PATH__ as string || '';

  createRenderRoot() { return this; }

  connectedCallback() {
    super.connectedCallback();
    this._loadStates();
    // Default start to 24h ago, end to now
    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    this._start = this._toLocalDatetime(yesterday);
    this._end = this._toLocalDatetime(now);
  }

  render() {
    const filteredStates = this._entityFilter
      ? this._haStates.filter(s => s.entity_id.includes(this._entityFilter.toLowerCase()))
      : this._haStates;

    // Group by domain
    const grouped = new Map<string, HAState[]>();
    for (const s of filteredStates.slice(0, 100)) {
      const domain = s.entity_id.split('.')[0];
      const list = grouped.get(domain) || [];
      list.push(s);
      grouped.set(domain, list);
    }

    const timeRange = this._previewEvents.length > 0
      ? { start: 0, end: Math.max(...this._previewEvents.map(e => e.t), 1000) }
      : { start: 0, end: 60_000 };

    return html`
      <div class="capture-modal-backdrop" @click=${this._onBackdropClick}>
        <div class="capture-modal" @click=${(e: Event) => e.stopPropagation()}>
          <div class="capture-modal-header">
            <span>Capture History Data</span>
            <button class="capture-modal-close" @click=${this._close}>&times;</button>
          </div>

          <div class="capture-modal-body">
            <label class="capture-field">
              <span class="capture-label">Entity</span>
              <div class="capture-entity-picker">
                <input
                  type="text"
                  class="capture-input"
                  placeholder="Search entities..."
                  .value=${this._entityFilter}
                  @input=${this._onEntityFilter}
                  @focus=${() => { this._showDropdown = true; }}
                  @blur=${() => { setTimeout(() => { this._showDropdown = false; }, 200); }}
                >
                ${this._loadingStates ? html`<span class="capture-loading">Loading...</span>` : nothing}
                ${this._showDropdown && filteredStates.length > 0 ? html`
                  <div class="capture-dropdown">
                    ${[...grouped.entries()].map(([domain, entities]) => html`
                      <div class="capture-dropdown-group">${domain}</div>
                      ${entities.map(s => html`
                        <div class="capture-dropdown-item${s.entity_id === this._selectedEntity ? ' selected' : ''}"
                             @mousedown=${() => this._selectEntity(s.entity_id)}>
                          ${s.entity_id}
                        </div>
                      `)}
                    `)}
                  </div>
                ` : nothing}
              </div>
            </label>

            <div class="capture-time-row">
              <label class="capture-field capture-field-half">
                <span class="capture-label">Start</span>
                <input type="datetime-local" class="capture-input" .value=${this._start} @change=${this._onStartChange}>
                <div class="capture-presets">
                  <button class="capture-preset" @click=${() => this._setPresetStart(1)}>1h ago</button>
                  <button class="capture-preset" @click=${() => this._setPresetStart(24)}>24h ago</button>
                  <button class="capture-preset" @click=${() => this._setPresetStart(168)}>7d ago</button>
                </div>
              </label>

              <label class="capture-field capture-field-half">
                <span class="capture-label">End</span>
                <input type="datetime-local" class="capture-input" .value=${this._end} @change=${this._onEndChange}>
                <div class="capture-presets">
                  <button class="capture-preset" @click=${() => this._setOffsetEnd(1)}>+1h</button>
                  <button class="capture-preset" @click=${() => this._setOffsetEnd(6)}>+6h</button>
                  <button class="capture-preset" @click=${() => this._setOffsetEnd(24)}>+24h</button>
                  <button class="capture-preset" @click=${() => this._setOffsetEnd(168)}>+7d</button>
                </div>
              </label>
            </div>

            <button class="capture-preview-btn" @click=${this._preview} ?disabled=${!this._selectedEntity || this._previewLoading}>
              ${this._previewLoading ? 'Loading...' : 'Preview'}
            </button>

            ${this._previewEvents.length > 0 ? html`
              <div class="capture-preview-chart">
                <tse-signal-chart
                  .events=${this._previewEvents}
                  .signalType=${this._detectSignalType(this._previewEvents)}
                  .timeRange=${timeRange}
                  label="Preview">
                </tse-signal-chart>
                <div class="capture-preview-stats">${this._previewStats}</div>
              </div>
            ` : nothing}

            <label class="capture-field">
              <span class="capture-label">Name</span>
              <input type="text" class="capture-input" placeholder="e.g. washer-monday"
                     .value=${this._name} @input=${(e: Event) => { this._name = (e.target as HTMLInputElement).value; }}>
            </label>

            ${this._error ? html`<div class="capture-error">${this._error}</div>` : nothing}
          </div>

          <div class="capture-modal-footer">
            <button class="capture-btn-cancel" @click=${this._close}>Cancel</button>
            <button class="capture-btn-save" @click=${this._save}
                    ?disabled=${!this._selectedEntity || !this._name || this._previewEvents.length === 0 || this._saving}>
              ${this._saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    `;
  }

  private async _loadStates() {
    this._loadingStates = true;
    try {
      const resp = await fetch(this._base + '/api/ha/states');
      if (resp.ok) {
        this._haStates = await resp.json() as HAState[];
      }
    } catch { /* ignore */ }
    this._loadingStates = false;
  }

  private _onEntityFilter(e: Event) {
    this._entityFilter = (e.target as HTMLInputElement).value;
    this._showDropdown = true;
  }

  private _selectEntity(entityId: string) {
    this._selectedEntity = entityId;
    this._entityFilter = entityId;
    this._showDropdown = false;
    // Auto-generate name from entity and date
    if (!this._name) {
      const shortId = entityId.split('.').pop() || entityId;
      const date = this._start.split('T')[0];
      this._name = `${shortId}-${date}`;
    }
  }

  private _onStartChange(e: Event) {
    this._start = (e.target as HTMLInputElement).value;
  }

  private _onEndChange(e: Event) {
    this._end = (e.target as HTMLInputElement).value;
  }

  private _setPresetStart(hoursAgo: number) {
    const now = new Date();
    const start = new Date(now.getTime() - hoursAgo * 60 * 60 * 1000);
    this._start = this._toLocalDatetime(start);
    this._end = this._toLocalDatetime(now);
  }

  private _setOffsetEnd(hours: number) {
    if (!this._start) return;
    const start = new Date(this._start);
    const end = new Date(start.getTime() + hours * 60 * 60 * 1000);
    this._end = this._toLocalDatetime(end);
  }

  private async _preview() {
    if (!this._selectedEntity || !this._start || !this._end) return;
    this._previewLoading = true;
    this._previewEvents = [];
    this._previewStats = '';
    this._error = '';

    try {
      const startIso = new Date(this._start).toISOString();
      const endIso = new Date(this._end).toISOString();
      const url = `${this._base}/api/ha/history?entity_id=${encodeURIComponent(this._selectedEntity)}&start=${encodeURIComponent(startIso)}&end=${encodeURIComponent(endIso)}`;
      const resp = await fetch(url);
      if (!resp.ok) {
        this._error = `HA API returned ${resp.status}`;
        this._previewLoading = false;
        return;
      }
      const haResponse = await resp.json() as Array<Array<{ state: string; last_changed: string }>>;
      if (!haResponse || !haResponse[0] || haResponse[0].length === 0) {
        this._error = 'No history data found for this entity and time range';
        this._previewLoading = false;
        return;
      }

      const events = this._transformHAHistory(haResponse, startIso);
      this._previewEvents = events;

      // Compute stats
      const numericValues = events.filter(e => typeof e.value === 'number').map(e => e.value as number);
      if (numericValues.length > 0) {
        const min = Math.min(...numericValues);
        const max = Math.max(...numericValues);
        this._previewStats = `${events.length} events \u00b7 ${min.toFixed(1)}\u2013${max.toFixed(1)}`;
      } else {
        const uniqueStates = new Set(events.map(e => String(e.value)));
        this._previewStats = `${events.length} events \u00b7 ${uniqueStates.size} unique states`;
      }

      // Auto-generate name if empty
      if (!this._name && this._selectedEntity) {
        const shortId = this._selectedEntity.split('.').pop() || this._selectedEntity;
        const date = this._start.split('T')[0];
        this._name = `${shortId}-${date}`;
      }
    } catch (err) {
      this._error = `Preview failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    this._previewLoading = false;
  }

  private async _save() {
    if (!this._selectedEntity || !this._name || this._previewEvents.length === 0) return;
    this._saving = true;
    this._error = '';

    try {
      const resp = await fetch(this._base + '/api/captures', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entity_id: this._selectedEntity,
          name: this._name,
          start: new Date(this._start).toISOString(),
          end: new Date(this._end).toISOString(),
          events: this._previewEvents,
        }),
      });

      if (!resp.ok) {
        const data = await resp.json();
        this._error = (data as Record<string, string>).error || 'Save failed';
        this._saving = false;
        return;
      }

      // Dispatch event to notify the app
      this.dispatchEvent(new CustomEvent('tse-capture-saved', { bubbles: true, composed: true }));
      this._close();
    } catch (err) {
      this._error = `Save failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    this._saving = false;
  }

  private _close() {
    this.dispatchEvent(new CustomEvent('tse-capture-close', { bubbles: true, composed: true }));
  }

  private _onBackdropClick() {
    this._close();
  }

  private _transformHAHistory(
    haResponse: Array<Array<{ state: string; last_changed: string }>>,
    startIso: string,
  ): SignalEvent[] {
    const startMs = new Date(startIso).getTime();
    return haResponse[0]
      .filter(e => e.state !== 'unavailable' && e.state !== 'unknown')
      .map(e => ({
        t: new Date(e.last_changed).getTime() - startMs,
        value: isNaN(Number(e.state)) ? e.state : Number(e.state),
      }));
  }

  private _detectSignalType(events: SignalEvent[]): 'numeric' | 'binary' | 'enum' {
    if (events.length === 0) return 'numeric';
    const values = events.map(e => e.value);
    if (values.every(v => typeof v === 'number')) return 'numeric';
    const strs = new Set(values.map(v => String(v).toLowerCase()));
    if (strs.size <= 2 && [...strs].every(s => s === 'on' || s === 'off')) return 'binary';
    return 'enum';
  }

  private _toLocalDatetime(d: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
}
