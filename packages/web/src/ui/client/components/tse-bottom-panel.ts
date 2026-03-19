import { LitElement, html } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { BuildStep, EntityInfo, LogEntry } from '../types.js';

import './tse-build-output.js';
import './tse-entity-table.js';
import './tse-log-viewer.js';

@customElement('tse-bottom-panel')
export class TseBottomPanel extends LitElement {
  @property({ type: Array }) buildSteps: BuildStep[] = [];
  @property({ type: Array }) buildMessages: string[] = [];
  @property({ type: Array }) entities: EntityInfo[] = [];
  @property({ type: Array }) logs: LogEntry[] = [];
  @state() private _activePanel = 'build-output';

  createRenderRoot() { return this; }

  render() {
    return html`
      <div class="panel-tabs">
        ${['build-output', 'entities', 'logs'].map((panel) => html`
          <button class="panel-tab ${this._activePanel === panel ? 'active' : ''}"
            @click=${() => this._switchPanel(panel)}>
            ${panel === 'build-output' ? 'Build Output' : panel === 'entities' ? 'Entities' : 'Logs'}
          </button>
        `)}
      </div>

      <div class="panel-content ${this._activePanel === 'build-output' ? 'active' : ''}">
        <tse-build-output .steps=${this.buildSteps} .messages=${this.buildMessages}></tse-build-output>
      </div>
      <div class="panel-content ${this._activePanel === 'entities' ? 'active' : ''}">
        <tse-entity-table .entities=${this.entities}></tse-entity-table>
      </div>
      <div class="panel-content ${this._activePanel === 'logs' ? 'active' : ''}">
        <tse-log-viewer .logs=${this.logs}></tse-log-viewer>
      </div>
    `;
  }

  private _switchPanel(panel: string) {
    this._activePanel = panel;
    this.dispatchEvent(new CustomEvent('tse-panel-change', {
      bubbles: true, composed: true, detail: { panel },
    }));
  }
}
