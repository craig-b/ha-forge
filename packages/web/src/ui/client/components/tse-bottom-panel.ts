import { LitElement, html } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { BuildStep, EntityInfo, LogEntry } from '../types.js';
import type { EntityDefinitionLocation, ScenarioLocation } from '../ast-finders.js';
import type { SimulationShimResult } from '../simulation-shim.js';

import './tse-build-output.js';
import './tse-exports-panel.js';
import './tse-log-viewer.js';
import './tse-simulate-panel.js';
import './tse-history-panel.js';
import './tse-dependencies-panel.js';

@customElement('tse-bottom-panel')
export class TseBottomPanel extends LitElement {
  @property({ type: Array }) buildSteps: BuildStep[] = [];
  @property({ type: Array }) buildMessages: string[] = [];
  @property({ type: Array }) entities: EntityInfo[] = [];
  @property({ type: Array }) logs: LogEntry[] = [];
  @property({ type: Array }) logEntityIds: string[] = [];
  @property({ type: Array }) simEntities: EntityDefinitionLocation[] = [];
  @property({ type: Array }) simScenarios: ScenarioLocation[] = [];
  @property({ type: Object }) shimResult: SimulationShimResult | null = null;
  @property({ type: String }) activeFile = '';
  @property({ type: String }) basePath = '';
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
        ${['build-output', 'exports', 'logs', 'simulate', 'history', 'deps'].map((panel) => html`
          <button class="panel-tab ${this._activePanel === panel ? 'active' : ''}"
            @click=${() => this._switchPanel(panel)}>
            ${{ 'build-output': 'Build Output', exports: 'Exports', logs: 'Logs', simulate: 'Simulate', history: 'History', deps: 'Dependencies' }[panel]}
          </button>
        `)}
      </div>

      <div class="panel-content ${this._activePanel === 'build-output' ? 'active' : ''}">
        <tse-build-output .steps=${this.buildSteps} .messages=${this.buildMessages}></tse-build-output>
      </div>
      <div class="panel-content ${this._activePanel === 'exports' ? 'active' : ''}">
        <tse-exports-panel .entities=${this.entities}></tse-exports-panel>
      </div>
      <div class="panel-content ${this._activePanel === 'logs' ? 'active' : ''}">
        <tse-log-viewer .logs=${this.logs} .entityIds=${this.logEntityIds}></tse-log-viewer>
      </div>
      <div class="panel-content ${this._activePanel === 'simulate' ? 'active' : ''}">
        <tse-simulate-panel
          .entities=${this.simEntities}
          .scenarios=${this.simScenarios}
          .shimResult=${this.shimResult}>
        </tse-simulate-panel>
      </div>
      <div class="panel-content ${this._activePanel === 'history' ? 'active' : ''}">
        <tse-history-panel .filePath=${this.activeFile} .basePath=${this.basePath}></tse-history-panel>
      </div>
      <div class="panel-content ${this._activePanel === 'deps' ? 'active' : ''}">
        <tse-dependencies-panel .filePath=${this.activeFile} .basePath=${this.basePath}></tse-dependencies-panel>
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
