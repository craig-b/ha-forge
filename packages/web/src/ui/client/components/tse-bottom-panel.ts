import { LitElement, html } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { BuildStep, EntityInfo, LogEntry } from '../types.js';

import './tse-build-output.js';
import './tse-entity-table.js';
import './tse-exports-panel.js';
import './tse-log-viewer.js';

@customElement('tse-bottom-panel')
export class TseBottomPanel extends LitElement {
  @property({ type: Array }) buildSteps: BuildStep[] = [];
  @property({ type: Array }) buildMessages: string[] = [];
  @property({ type: Array }) entities: EntityInfo[] = [];
  @property({ type: Array }) logs: LogEntry[] = [];
  @state() private _activePanel = 'build-output';

  createRenderRoot() { return this; }

  connectedCallback() {
    super.connectedCallback();
    this._onMouseMove = this._onMouseMove.bind(this);
    this._onMouseUp = this._onMouseUp.bind(this);
  }

  render() {
    return html`
      <div class="panel-resize-handle"
        @mousedown=${this._onResizeStart}></div>
      <div class="panel-tabs">
        ${['build-output', 'entities', 'exports', 'logs'].map((panel) => html`
          <button class="panel-tab ${this._activePanel === panel ? 'active' : ''}"
            @click=${() => this._switchPanel(panel)}>
            ${{ 'build-output': 'Build Output', entities: 'Entities', exports: 'Exports', logs: 'Logs' }[panel]}
          </button>
        `)}
      </div>

      <div class="panel-content ${this._activePanel === 'build-output' ? 'active' : ''}">
        <tse-build-output .steps=${this.buildSteps} .messages=${this.buildMessages}></tse-build-output>
      </div>
      <div class="panel-content ${this._activePanel === 'entities' ? 'active' : ''}">
        <tse-entity-table .entities=${this.entities}></tse-entity-table>
      </div>
      <div class="panel-content ${this._activePanel === 'exports' ? 'active' : ''}">
        <tse-exports-panel .entities=${this.entities}></tse-exports-panel>
      </div>
      <div class="panel-content ${this._activePanel === 'logs' ? 'active' : ''}">
        <tse-log-viewer .logs=${this.logs} .entityIds=${this.entities.map((e) => e.id)}></tse-log-viewer>
      </div>
    `;
  }

  private _switchPanel(panel: string) {
    this._activePanel = panel;
    this.dispatchEvent(new CustomEvent('tse-panel-change', {
      bubbles: true, composed: true, detail: { panel },
    }));
  }

  // ---- Resize ----

  private _startY = 0;
  private _startHeight = 0;

  private _onResizeStart(e: MouseEvent) {
    e.preventDefault();
    this._startY = e.clientY;
    this._startHeight = this.getBoundingClientRect().height;
    document.addEventListener('mousemove', this._onMouseMove);
    document.addEventListener('mouseup', this._onMouseUp);
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
  }

  private _onMouseMove(e: MouseEvent) {
    const delta = this._startY - e.clientY;
    const newHeight = Math.max(100, Math.min(window.innerHeight - 200, this._startHeight + delta));
    document.documentElement.style.setProperty('--panel-height', `${newHeight}px`);
  }

  private _onMouseUp() {
    document.removeEventListener('mousemove', this._onMouseMove);
    document.removeEventListener('mouseup', this._onMouseUp);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }
}
