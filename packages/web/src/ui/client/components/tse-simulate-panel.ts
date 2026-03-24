import { LitElement, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { SimulationLocation, StreamSubscriptionLocation } from '../ast-analyzers.js';
import type { SimulationShimResult, EntitySimSummary } from '../simulation-shim.js';

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
  @property({ type: Object }) chainResults: Map<string, SimulationShimResult> = new Map();
  @state() private _selectedSimId = '';
  @state() private _timeRangeMs = 60_000;
  @state() private _expandedEntity: string | null = null;

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

        ${chainResult ? this._renderChainMode(chainResult, selected!, signalType, timeRange) :
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

  private _renderChainMode(
    chain: SimulationShimResult,
    sim: SimulationLocation,
    signalType: string,
    timeRange: { start: number; end: number },
  ) {
    const sourceEvents = chain.events.get(sim.shadows) || [];
    // Find the last entity with events (the chain output)
    let finalEntityId = sim.shadows;
    let finalEvents = sourceEvents;
    for (const [entityId, summary] of chain.entities) {
      if (entityId !== sim.shadows && summary.simulated && summary.eventCount > 0) {
        finalEntityId = entityId;
        finalEvents = chain.events.get(entityId) || [];
      }
    }

    const entityList = [...chain.entities.entries()];

    return html`
      <div class="simulate-charts simulate-charts-chain">
        <tse-signal-chart
          .events=${sourceEvents}
          .signalType=${signalType}
          .timeRange=${timeRange}
          label="Source: ${this._shortEntityId(sim.shadows)}">
        </tse-signal-chart>
        <tse-signal-chart
          .events=${finalEvents}
          .signalType=${'numeric'}
          .timeRange=${timeRange}
          label="Output: ${this._shortEntityId(finalEntityId)}">
        </tse-signal-chart>
      </div>

      ${this._renderEntityFlow(entityList, sim.shadows)}

      ${this._expandedEntity ? this._renderExpandedEntity(chain, timeRange) : nothing}

      ${chain.errors.length > 0 ? html`
        <div class="sim-warning">
          ${chain.errors.map(e => html`
            <div>${e.entityId ? html`<code>${e.entityId}</code> ` : ''}${e.message} (${e.phase})</div>
          `)}
        </div>
      ` : ''}

      ${chain.missingEntities.length > 0 ? html`
        <div class="sim-warning">
          Missing simulation sources:
          ${chain.missingEntities.map(id => html`<code>${id}</code> `)}
          — add <code>simulate()</code> for these to complete the chain.
        </div>
      ` : ''}

      <div class="simulation-stats">
        <span class="operator-stat">
          ${sourceEvents.length} source → ${finalEvents.length} output
        </span>
        ${chain.serviceCalls.length > 0 ? html`
          <span class="operator-stat">
            ${chain.serviceCalls.length} service calls
          </span>
        ` : ''}
      </div>
    `;
  }

  private _renderEntityFlow(entities: [string, EntitySimSummary][], sourceId: string) {
    return html`
      <div class="chain-flow-bar">
        ${entities.map(([entityId, summary], i) => html`
          ${i > 0 ? html`<span class="chain-arrow">→</span>` : nothing}
          <button
            class="chain-node ${this._entityNodeClass(summary, entityId === sourceId)}"
            title=${summary.simulated ? `${summary.kind}: ${summary.eventCount} events` : `${summary.kind}: no events`}
            @click=${() => this._toggleEntity(entityId)}>
            ${this._shortEntityId(entityId)}
            <span class="chain-badge">${summary.eventCount}</span>
          </button>
        `)}
      </div>
    `;
  }

  private _renderExpandedEntity(chain: SimulationShimResult, timeRange: { start: number; end: number }) {
    const events = chain.events.get(this._expandedEntity!) || [];
    const summary = chain.entities.get(this._expandedEntity!);

    return html`
      <div class="chain-expanded-stage">
        <div class="chain-expanded-header">
          <strong>${this._expandedEntity}</strong>
          ${summary ? html`<span class="chain-skip-reason">${summary.kind} — ${summary.eventCount} events</span>` : nothing}
          <button class="chain-close" @click=${() => this._toggleEntity(null)}>✕</button>
        </div>
        <tse-signal-chart
          .events=${events}
          .signalType=${'numeric'}
          .timeRange=${timeRange}
          label="${this._expandedEntity}">
        </tse-signal-chart>
      </div>
    `;
  }

  private _entityNodeClass(summary: EntitySimSummary, isSource: boolean): string {
    if (isSource) return 'chain-node-ok';
    if (summary.simulated && summary.eventCount > 0) return 'chain-node-ok';
    if (summary.simulated) return 'chain-node-partial';
    return 'chain-node-skip';
  }

  private _shortEntityId(entityId: string): string {
    const dot = entityId.indexOf('.');
    return dot >= 0 ? entityId.substring(dot + 1) : entityId;
  }

  private _toggleEntity(entityId: string | null) {
    this._expandedEntity = this._expandedEntity === entityId ? null : entityId;
  }

  private _onSelectSim(e: Event) {
    this._selectedSimId = (e.target as HTMLSelectElement).value;
    this._expandedEntity = null;
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
