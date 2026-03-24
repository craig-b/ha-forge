import { LitElement, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { SimulationLocation, StreamSubscriptionLocation } from '../ast-analyzers.js';
import type { ChainSimulationResult, ChainStageResult } from '../chain-simulation.js';

import './tse-signal-chart.js';

interface SignalEvent {
  t: number;
  value: string | number;
}

interface OperatorStats {
  name: string;
  inputCount: number;
  outputCount: number;
}

interface SimulationResult {
  input: SignalEvent[];
  output: SignalEvent[];
  stats: {
    inputCount: number;
    outputCount: number;
    passRate: number;
    perOperator: OperatorStats[];
  };
}

@customElement('tse-simulate-panel')
export class TseSimulatePanel extends LitElement {
  @property({ type: Array }) simulations: SimulationLocation[] = [];
  @property({ type: Array }) streams: StreamSubscriptionLocation[] = [];
  @property({ type: Object }) simulationResults: Map<string, SimulationResult> = new Map();
  @property({ type: Object }) chainResults: Map<string, ChainSimulationResult> = new Map();
  @state() private _selectedSimId = '';
  @state() private _timeRangeMs = 60_000;
  @state() private _expandedStage: string | null = null;

  createRenderRoot() { return this; }

  render() {
    if (this.simulations.length === 0) {
      return html`<div class="simulate-panel">
        <div class="sim-warning">No simulations defined. Use <code>simulate()</code> with <code>signals.*</code> to create one.</div>
      </div>`;
    }

    const selected = this._selectedSimId
      ? this.simulations.find(s => s.id === this._selectedSimId)
      : this.simulations[0];

    const result = selected ? this.simulationResults.get(selected.id) : undefined;
    const chainResult = selected ? this.chainResults.get(selected.id) : undefined;
    const timeRange = { start: 0, end: this._timeRangeMs };

    // Group simulations by shadows target for the picker
    const byShadows = new Map<string, SimulationLocation[]>();
    for (const sim of this.simulations) {
      const list = byShadows.get(sim.shadows) || [];
      list.push(sim);
      byShadows.set(sim.shadows, list);
    }

    // Check for unshadowed entities in stream subscriptions
    const shadowedEntities = new Set(this.simulations.map(s => s.shadows));
    const unshadowed = this.streams.filter(s => !shadowedEntities.has(s.entityId));

    const signalType = selected?.signalType === 'binary' ? 'binary' : selected?.signalType === 'enum' ? 'enum' : 'numeric';

    return html`
      <div class="simulate-panel">
        <div class="simulate-top-bar">
          <select class="scenario-picker" @change=${this._onSelectSim}>
            ${[...byShadows.entries()].map(([shadows, sims]) => html`
              <optgroup label="${shadows}">
                ${sims.map(sim => html`
                  <option value="${sim.id}" ?selected=${sim.id === selected?.id}>
                    ${sim.id} (${sim.signalType})
                  </option>
                `)}
              </optgroup>
            `)}
          </select>
          <label class="simulate-time-label">
            Duration:
            <select class="scenario-picker" @change=${this._onTimeRange}>
              ${[10_000, 30_000, 60_000, 300_000, 600_000, 3600_000].map(ms => html`
                <option value="${ms}" ?selected=${ms === this._timeRangeMs}>
                  ${this._fmtDuration(ms)}
                </option>
              `)}
            </select>
          </label>
        </div>

        ${chainResult ? this._renderChainMode(chainResult, signalType, timeRange) :
          result ? this._renderSingleMode(result, signalType, timeRange) :
          html`<div class="sim-warning">Select a simulation and matching stream subscription to preview.</div>`}

        ${unshadowed.length > 0 ? html`
          <div class="sim-warning">
            Unshadowed entities in stream subscriptions:
            ${unshadowed.map(s => html`<code>${s.entityId}</code> `)}
            — add <code>simulate()</code> definitions for these to enable full simulation.
          </div>
        ` : ''}
      </div>
    `;
  }

  private _renderSingleMode(result: SimulationResult, signalType: string, timeRange: { start: number; end: number }) {
    return html`
      <div class="simulate-charts">
        <tse-signal-chart
          .events=${result.input}
          .signalType=${signalType}
          .timeRange=${timeRange}
          label="Raw Signal">
        </tse-signal-chart>
        <tse-signal-chart
          .events=${result.output}
          .signalType=${signalType}
          .timeRange=${timeRange}
          label="After Operators">
        </tse-signal-chart>
      </div>

      <div class="simulation-stats">
        <span class="operator-stat">
          ${result.stats.inputCount} in → ${result.stats.outputCount} out
          (${(result.stats.passRate * 100).toFixed(0)}% pass)
        </span>
        ${result.stats.perOperator.map(op => html`
          <span class="operator-stat">
            ${op.name}: ${op.inputCount}→${op.outputCount}
            (${op.inputCount > 0 ? ((op.outputCount / op.inputCount) * 100).toFixed(0) : '0'}%)
          </span>
        `)}
      </div>
    `;
  }

  private _renderChainMode(chain: ChainSimulationResult, signalType: string, timeRange: { start: number; end: number }) {
    return html`
      <div class="simulate-charts simulate-charts-chain">
        <tse-signal-chart
          .events=${chain.sourceEvents}
          .signalType=${signalType}
          .timeRange=${timeRange}
          label="Source: ${chain.stages[0]?.entityId || 'signal'}">
        </tse-signal-chart>
        <tse-signal-chart
          .events=${chain.finalEvents}
          .signalType=${'numeric'}
          .timeRange=${timeRange}
          label="Final: ${chain.finalEntityId}">
        </tse-signal-chart>
      </div>

      ${this._renderChainFlow(chain.stages)}

      ${this._expandedStage ? this._renderExpandedStage(chain, signalType, timeRange) : nothing}

      <div class="simulation-stats">
        <span class="operator-stat">
          ${chain.sourceEvents.length} source events → ${chain.finalEvents.length} final events
        </span>
      </div>
    `;
  }

  private _renderChainFlow(stages: ChainStageResult[]) {
    return html`
      <div class="chain-flow-bar">
        ${stages.map((stage, i) => html`
          ${i > 0 ? html`<span class="chain-arrow">→</span>` : nothing}
          <button
            class="chain-node ${this._chainNodeClass(stage)}"
            title=${stage.skipReason || (stage.simulated ? 'Simulated' : 'Skipped')}
            @click=${() => this._toggleStage(stage.entityId)}>
            ${this._shortEntityId(stage.entityId)}
            <span class="chain-badge">${stage.events.length}</span>
          </button>
        `)}
      </div>
    `;
  }

  private _renderExpandedStage(chain: ChainSimulationResult, _signalType: string, timeRange: { start: number; end: number }) {
    const stage = chain.stages.find(s => s.entityId === this._expandedStage);
    if (!stage) return nothing;

    return html`
      <div class="chain-expanded-stage">
        <div class="chain-expanded-header">
          <strong>${stage.entityId}</strong>
          ${stage.skipReason ? html`<span class="chain-skip-reason">${stage.skipReason}</span>` : nothing}
          <button class="chain-close" @click=${() => this._toggleStage(null)}>✕</button>
        </div>
        <tse-signal-chart
          .events=${stage.events}
          .signalType=${'numeric'}
          .timeRange=${timeRange}
          label="${stage.entityId}">
        </tse-signal-chart>
      </div>
    `;
  }

  private _chainNodeClass(stage: ChainStageResult): string {
    if (stage.simulated && !stage.skipReason) return 'chain-node-ok';
    if (stage.simulated && stage.skipReason) return 'chain-node-partial';
    return 'chain-node-skip';
  }

  private _shortEntityId(entityId: string): string {
    // Remove domain prefix for display
    const dot = entityId.indexOf('.');
    return dot >= 0 ? entityId.substring(dot + 1) : entityId;
  }

  private _toggleStage(entityId: string | null) {
    this._expandedStage = this._expandedStage === entityId ? null : entityId;
  }

  private _onSelectSim(e: Event) {
    this._selectedSimId = (e.target as HTMLSelectElement).value;
    this._expandedStage = null;
  }

  private _onTimeRange(e: Event) {
    this._timeRangeMs = Number((e.target as HTMLSelectElement).value);
    this.dispatchEvent(new CustomEvent('tse-simulation-time-change', {
      bubbles: true, composed: true, detail: { timeRangeMs: this._timeRangeMs },
    }));
  }

  private _fmtDuration(ms: number): string {
    const s = ms / 1000;
    if (s < 60) return `${s}s`;
    const m = s / 60;
    if (m < 60) return `${m}m`;
    return `${m / 60}h`;
  }
}
