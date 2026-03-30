import { LitElement, html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { HistoryEntry } from '../types.js';

@customElement('tse-history-panel')
export class TseHistoryPanel extends LitElement {
  @property({ type: String }) filePath = '';
  @property({ type: String }) basePath = '';
  @state() private _history: HistoryEntry[] = [];
  @state() private _loading = false;
  @state() private _error = '';

  createRenderRoot() { return this; }

  updated(changed: Map<string, unknown>) {
    if (changed.has('filePath') && this.filePath) {
      this._fetchHistory();
    }
  }

  render() {
    if (!this.filePath) {
      return html`<div class="history-empty">Select a file to view history</div>`;
    }
    if (this._loading) {
      return html`<div class="history-loading">Loading history...</div>`;
    }
    if (this._error) {
      return html`<div class="history-error">${this._error}</div>`;
    }
    if (this._history.length === 0) {
      return html`<div class="history-empty">No version history</div>`;
    }

    return html`
      <div class="history-list">
        ${this._history.map((entry) => html`
          <div class="history-entry ${entry.deployed ? 'deployed' : ''}">
            <div class="history-info">
              <span class="history-sha" title="${entry.sha}">${entry.sha.slice(0, 7)}</span>
              <span class="history-time">${this._formatTime(entry.timestamp)}</span>
              ${entry.deployed ? html`<span class="history-badge">deployed</span>` : ''}
            </div>
            <div class="history-actions">
              <button class="history-btn" @click=${() => this._deployVersion(entry.sha)}
                title="Deploy this version">Deploy</button>
              <button class="history-btn" @click=${() => this._viewDiff(entry.sha)}
                title="View diff">Diff</button>
            </div>
          </div>
        `)}
      </div>
    `;
  }

  private async _fetchHistory() {
    this._loading = true;
    this._error = '';
    try {
      const res = await fetch(`${this.basePath}/api/history/${this.filePath}`);
      if (!res.ok) throw new Error('Failed to fetch history');
      const data = await res.json();
      this._history = data.history ?? [];
    } catch (err) {
      this._error = err instanceof Error ? err.message : 'Failed to load history';
    } finally {
      this._loading = false;
    }
  }

  private _deployVersion(sha: string) {
    this.dispatchEvent(new CustomEvent('tse-deploy-version', {
      bubbles: true, composed: true,
      detail: { file: this.filePath, commit: sha },
    }));
  }

  private _viewDiff(sha: string) {
    this.dispatchEvent(new CustomEvent('tse-view-diff', {
      bubbles: true, composed: true,
      detail: { file: this.filePath, commit: sha },
    }));
  }

  private _formatTime(iso: string): string {
    try {
      const d = new Date(iso);
      return d.toLocaleString(undefined, {
        month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit',
      });
    } catch {
      return iso;
    }
  }
}
