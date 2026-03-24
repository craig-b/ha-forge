import { LitElement, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { EntityDefinitionLocation, ScenarioLocation } from '../ast-analyzers.js';
import type { SimulationShimResult, EntitySimSummary } from '../simulation-shim.js';

import './tse-signal-chart.js';

interface SignalEvent {
  t: number;
  value: string | number;
}

@customElement('tse-simulate-panel')
export class TseSimulatePanel extends LitElement {
  /** All entity definitions in open files. */
  @property({ type: Array }) entities: EntityDefinitionLocation[] = [];
  /** All scenarios in open files. */
  @property({ type: Array }) scenarios: ScenarioLocation[] = [];
  /** Simulation result from the shim (keyed by scenario name). */
  @property({ type: Object }) shimResult: SimulationShimResult | null = null;
  @state() private _selectedEntity = '';
  @state() private _selectedScenario = '';
  @state() private _timeRangeMs = 60_000;
  @state() private _expandedEntity: string | null = null;

  createRenderRoot() { return this; }

  render() {
    const exportedEntities = this.entities.filter(e => e.isExported && e.domain !== 'device');

    if (exportedEntities.length === 0 && this.scenarios.length === 0) {
      return html`<div class="simulate-panel">
        <div class="sim-warning">
          No exported entities or scenarios. Export entities and define scenarios with
          <code>simulate.scenario()</code> to preview behavior.
        </div>
      </div>`;
    }

    const selectedEntity = this._selectedEntity
      ? exportedEntities.find(e => e.fullEntityId === this._selectedEntity)
      : exportedEntities[0];

    const selectedScenario = this._selectedScenario
      ? this.scenarios.find(s => s.name === this._selectedScenario)
      : this.scenarios[0];

    const timeRange = { start: 0, end: this._timeRangeMs };

    return html`
      <div class="simulate-panel">
        <div class="simulate-top-bar">
          ${exportedEntities.length > 0 ? html`
            <select class="scenario-picker" @change=${this._onSelectEntity}>
              ${exportedEntities.map(e => html`
                <option value="${e.fullEntityId}" ?selected=${e.fullEntityId === selectedEntity?.fullEntityId}>
                  ${e.fullEntityId}
                </option>
              `)}
            </select>
          ` : ''}
          ${this.scenarios.length > 0 ? html`
            <select class="scenario-picker" @change=${this._onSelectScenario}>
              ${this.scenarios.map(s => html`
                <option value="${s.name}" ?selected=${s.name === selectedScenario?.name}>
                  ${s.name}
                </option>
              `)}
            </select>
          ` : ''}
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

        ${this.shimResult && selectedEntity
          ? this._renderResult(this.shimResult, selectedEntity, selectedScenario, timeRange)
          : this.scenarios.length === 0
            ? html`<div class="sim-warning">Define scenarios with <code>simulate.scenario('name', [...])</code> to preview.</div>`
            : html`<div class="sim-warning">Running simulation...</div>`}
      </div>
    `;
  }

  private _renderResult(
    result: SimulationShimResult,
    entity: EntityDefinitionLocation,
    scenario: ScenarioLocation | undefined,
    timeRange: { start: number; end: number },
  ) {
    const entityEvents = result.events.get(entity.fullEntityId) || [];

    // Find source entities from the scenario
    const sourceIds = scenario?.sources || [];
    const primarySourceId = sourceIds[0];
    const sourceEvents = primarySourceId ? (result.events.get(primarySourceId) || []) : [];

    // Build entity flow from result
    const entityEntries = [...result.entities.entries()];

    return html`
      <div class="simulate-charts simulate-charts-chain">
        ${sourceEvents.length > 0 ? html`
          <tse-signal-chart
            .events=${sourceEvents}
            .signalType=${this._detectSignalType(sourceEvents)}
            .timeRange=${timeRange}
            label="Source: ${this._shortId(primarySourceId || '')}">
          </tse-signal-chart>
        ` : ''}
        <tse-signal-chart
          .events=${entityEvents}
          .signalType=${this._detectSignalType(entityEvents)}
          .timeRange=${timeRange}
          label="${this._shortId(entity.fullEntityId)}">
        </tse-signal-chart>
      </div>

      ${entityEntries.length > 1 ? this._renderEntityFlow(entityEntries) : nothing}

      ${this._expandedEntity ? this._renderExpandedEntity(result, timeRange) : nothing}

      ${result.errors.length > 0 ? html`
        <div class="sim-warning">
          ${result.errors.map(e => html`
            <div>${e.entityId ? html`<code>${e.entityId}</code> ` : ''}${e.message} (${e.phase})</div>
          `)}
        </div>
      ` : ''}

      ${result.missingEntities.length > 0 ? html`
        <div class="sim-warning">
          Missing simulation sources:
          ${result.missingEntities.map(id => html`<code>${id}</code> `)}
          — add these to the scenario to complete the chain.
        </div>
      ` : ''}

      <div class="simulation-stats">
        <span class="operator-stat">
          ${sourceEvents.length} source → ${entityEvents.length} output
        </span>
        ${result.serviceCalls.length > 0 ? html`
          <span class="operator-stat">${result.serviceCalls.length} service calls</span>
        ` : ''}
      </div>
    `;
  }

  private _renderEntityFlow(entities: [string, EntitySimSummary][]) {
    return html`
      <div class="chain-flow-bar">
        ${entities.map(([entityId, summary], i) => html`
          ${i > 0 ? html`<span class="chain-arrow">→</span>` : nothing}
          <button
            class="chain-node ${this._entityNodeClass(summary)}"
            title=${summary.simulated ? `${summary.kind}: ${summary.eventCount} events` : `${summary.kind}: no events`}
            @click=${() => this._toggleEntity(entityId)}>
            ${this._shortId(entityId)}
            <span class="chain-badge">${summary.eventCount}</span>
          </button>
        `)}
      </div>
    `;
  }

  private _renderExpandedEntity(result: SimulationShimResult, timeRange: { start: number; end: number }) {
    const events = result.events.get(this._expandedEntity!) || [];
    const summary = result.entities.get(this._expandedEntity!);

    return html`
      <div class="chain-expanded-stage">
        <div class="chain-expanded-header">
          <strong>${this._expandedEntity}</strong>
          ${summary ? html`<span class="chain-skip-reason">${summary.kind} — ${summary.eventCount} events</span>` : nothing}
          <button class="chain-close" @click=${() => this._toggleEntity(null)}>✕</button>
        </div>
        <tse-signal-chart
          .events=${events}
          .signalType=${this._detectSignalType(events)}
          .timeRange=${timeRange}
          label="${this._expandedEntity}">
        </tse-signal-chart>
      </div>
    `;
  }

  private _entityNodeClass(summary: EntitySimSummary): string {
    if (summary.kind === 'source') return 'chain-node-ok';
    if (summary.simulated && summary.eventCount > 0) return 'chain-node-ok';
    if (summary.simulated) return 'chain-node-partial';
    return 'chain-node-skip';
  }

  private _detectSignalType(events: SignalEvent[]): 'numeric' | 'binary' | 'enum' {
    if (events.length === 0) return 'numeric';
    const values = events.map(e => e.value).filter(v => v !== 'unavailable');
    if (values.length === 0) return 'numeric';
    if (values.every(v => typeof v === 'number')) return 'numeric';
    const strs = new Set(values.map(v => String(v).toLowerCase()));
    if (strs.size <= 2 && [...strs].every(s => s === 'on' || s === 'off')) return 'binary';
    return 'enum';
  }

  private _shortId(entityId: string): string {
    const dot = entityId.indexOf('.');
    return dot >= 0 ? entityId.substring(dot + 1) : entityId;
  }

  private _toggleEntity(entityId: string | null) {
    this._expandedEntity = this._expandedEntity === entityId ? null : entityId;
  }

  private _onSelectEntity(e: Event) {
    this._selectedEntity = (e.target as HTMLSelectElement).value;
    this._expandedEntity = null;
    this._fireSimulationChange();
  }

  private _onSelectScenario(e: Event) {
    this._selectedScenario = (e.target as HTMLSelectElement).value;
    this._expandedEntity = null;
    this._fireSimulationChange();
  }

  private _onTimeRange(e: Event) {
    this._timeRangeMs = Number((e.target as HTMLSelectElement).value);
    this._fireSimulationChange();
  }

  private _fireSimulationChange() {
    this.dispatchEvent(new CustomEvent('tse-simulation-change', {
      bubbles: true, composed: true,
      detail: {
        entity: this._selectedEntity,
        scenario: this._selectedScenario,
        timeRangeMs: this._timeRangeMs,
      },
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
