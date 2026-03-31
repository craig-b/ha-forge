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

  /** Re-fetch history (called externally after deploy/undeploy). */
  refresh() {
    if (this.filePath) this._fetchHistory();
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

    const deployedIndex = this._history.findIndex((e) => e.deployed);
    const isDeployed = deployedIndex >= 0;
    const commitsBehind = deployedIndex > 0 ? deployedIndex : 0;
    const isCurrent = deployedIndex === 0;

    return html`
      <div class="history-status">
        ${!isDeployed ? html`<span class="history-status-text">Not deployed</span>` : ''}
        ${isCurrent ? html`<span class="history-status-text deployed">Deployed (current)</span>` : ''}
        ${isDeployed && !isCurrent ? html`<span class="history-status-text behind">Deployed (${commitsBehind} behind)</span>` : ''}
        ${isDeployed ? html`<button class="history-btn" @click=${this._undeploy}>Undeploy</button>` : ''}
      </div>
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
              <button class="history-btn" @click=${() => this._viewChanges(entry.sha)}
                title="What this save changed">Changes</button>
              <button class="history-btn" @click=${() => this._viewDiff(entry.sha)}
                title="Compare to current editor content">vs Current</button>
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

  private _undeploy() {
    this.dispatchEvent(new CustomEvent('tse-undeploy', {
      bubbles: true, composed: true,
      detail: { file: this.filePath },
    }));
  }

  private _viewChanges(sha: string) {
    const idx = this._history.findIndex((e) => e.sha === sha);
    const parentSha = idx >= 0 && idx < this._history.length - 1
      ? this._history[idx + 1].sha
      : null;
    this.dispatchEvent(new CustomEvent('tse-view-changes', {
      bubbles: true, composed: true,
      detail: { file: this.filePath, commit: sha, parentCommit: parentSha },
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
