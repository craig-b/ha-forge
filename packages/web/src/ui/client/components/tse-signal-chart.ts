import { LitElement, html, svg } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

interface SignalEvent {
  t: number;
  value: string | number;
}

@customElement('tse-signal-chart')
export class TseSignalChart extends LitElement {
  @property({ type: Array }) events: SignalEvent[] = [];
  @property({ type: String }) signalType: 'numeric' | 'binary' | 'enum' = 'numeric';
  @property({ type: Object }) timeRange: { start: number; end: number } = { start: 0, end: 60000 };
  @property({ type: String }) label = '';
  @state() private _hoverIndex = -1;
  @state() private _viewStart = -1;
  @state() private _viewEnd = -1;

  createRenderRoot() { return this; }

  private get _effectiveRange(): { start: number; end: number } {
    if (this._viewStart >= 0 && this._viewEnd > this._viewStart) {
      return { start: this._viewStart, end: this._viewEnd };
    }
    return this.timeRange;
  }

  private _visibleEvents(): SignalEvent[] {
    const range = this._effectiveRange;
    const filtered = this.events.filter(e => e.t >= range.start && e.t <= range.end);
    // Downsample if too many points
    if (filtered.length > 500) {
      const step = Math.ceil(filtered.length / 500);
      return filtered.filter((_, i) => i % step === 0);
    }
    return filtered;
  }

  render() {
    const events = this._visibleEvents();
    const range = this._effectiveRange;
    const W = 600;
    const H = 120;
    const PAD = { top: 20, right: 10, bottom: 25, left: 45 };
    const plotW = W - PAD.left - PAD.right;
    const plotH = H - PAD.top - PAD.bottom;

    const hoverEvent = this._hoverIndex >= 0 && this._hoverIndex < events.length ? events[this._hoverIndex] : null;

    return html`
      <div class="signal-chart" @wheel=${this._onWheel}>
        ${this.label ? html`<div class="chart-label">${this.label}</div>` : ''}
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet"
          @mousemove=${(e: MouseEvent) => this._onMouseMove(e, events, range, PAD, plotW)}
          @mouseleave=${() => { this._hoverIndex = -1; }}>
          ${this.signalType === 'numeric' ? this._renderNumeric(events, range, PAD, plotW, plotH) : ''}
          ${this.signalType === 'binary' ? this._renderBinary(events, range, PAD, plotW, plotH) : ''}
          ${this.signalType === 'enum' ? this._renderEnum(events, range, PAD, plotW, plotH) : ''}
          ${this._renderXAxis(range, PAD, plotW, H)}
          ${hoverEvent ? this._renderCrosshair(hoverEvent, events, range, PAD, plotW, plotH, H) : ''}
        </svg>
      </div>
    `;
  }

  private _renderNumeric(
    events: SignalEvent[], range: { start: number; end: number },
    pad: typeof TseSignalChart.prototype._pad, plotW: number, plotH: number,
  ) {
    const numericEvents = events.filter(e => typeof e.value === 'number') as Array<{ t: number; value: number }>;
    if (numericEvents.length === 0) return svg``;

    const yMin = Math.min(...numericEvents.map(e => e.value));
    const yMax = Math.max(...numericEvents.map(e => e.value));
    const yRange = yMax - yMin || 1;

    const toX = (t: number) => pad.left + ((t - range.start) / (range.end - range.start)) * plotW;
    const toY = (v: number) => pad.top + plotH - ((v - yMin) / yRange) * plotH;

    const points = numericEvents.map(e => `${toX(e.t)},${toY(e.value)}`).join(' ');

    return svg`
      <text x="${pad.left - 4}" y="${pad.top + 4}" class="chart-axis-label" text-anchor="end">${this._fmtNum(yMax)}</text>
      <text x="${pad.left - 4}" y="${pad.top + plotH}" class="chart-axis-label" text-anchor="end">${this._fmtNum(yMin)}</text>
      <polyline points="${points}" fill="none" stroke="var(--accent)" stroke-width="1.5" />
      ${numericEvents.map(e => svg`
        <circle cx="${toX(e.t)}" cy="${toY(e.value)}" r="2" fill="var(--accent)" />
      `)}
    `;
  }

  private _renderBinary(
    events: SignalEvent[], range: { start: number; end: number },
    pad: typeof TseSignalChart.prototype._pad, plotW: number, plotH: number,
  ) {
    const toX = (t: number) => pad.left + ((t - range.start) / (range.end - range.start)) * plotW;
    const rects = [];

    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      const x = toX(e.t);
      const nextX = i + 1 < events.length ? toX(events[i + 1].t) : pad.left + plotW;
      const isOn = e.value === 'on' || e.value === 'ON' || e.value === 1;
      rects.push(svg`
        <rect x="${x}" y="${pad.top}" width="${Math.max(1, nextX - x)}" height="${plotH}"
          fill="${isOn ? 'var(--success)' : 'var(--bg-hover)'}" opacity="0.6" />
      `);
    }

    return svg`
      <text x="${pad.left - 4}" y="${pad.top + 10}" class="chart-axis-label" text-anchor="end">ON</text>
      <text x="${pad.left - 4}" y="${pad.top + plotH}" class="chart-axis-label" text-anchor="end">OFF</text>
      ${rects}
    `;
  }

  private _renderEnum(
    events: SignalEvent[], range: { start: number; end: number },
    pad: typeof TseSignalChart.prototype._pad, plotW: number, plotH: number,
  ) {
    const toX = (t: number) => pad.left + ((t - range.start) / (range.end - range.start)) * plotW;
    const uniqueStates = [...new Set(events.map(e => String(e.value)))];
    const colorMap = new Map<string, string>();
    const palette = ['var(--accent)', 'var(--success)', 'var(--warning)', 'var(--error)', 'var(--info)'];
    uniqueStates.forEach((s, i) => colorMap.set(s, palette[i % palette.length]));

    const rects = [];
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      const x = toX(e.t);
      const nextX = i + 1 < events.length ? toX(events[i + 1].t) : pad.left + plotW;
      rects.push(svg`
        <rect x="${x}" y="${pad.top}" width="${Math.max(1, nextX - x)}" height="${plotH}"
          fill="${colorMap.get(String(e.value)) || 'var(--bg-hover)'}" opacity="0.6" />
      `);
    }

    // State legend
    const legendY = pad.top - 5;
    const legend = uniqueStates.map((s, i) => svg`
      <rect x="${pad.left + i * 70}" y="${legendY - 6}" width="8" height="8"
        fill="${colorMap.get(s)}" rx="1" />
      <text x="${pad.left + i * 70 + 12}" y="${legendY}" class="chart-axis-label">${s}</text>
    `);

    return svg`${rects}${legend}`;
  }

  private _renderXAxis(
    range: { start: number; end: number },
    pad: { top: number; right: number; bottom: number; left: number },
    plotW: number, H: number,
  ) {
    const duration = range.end - range.start;
    const tickCount = Math.min(6, Math.max(2, Math.floor(plotW / 80)));
    const ticks = [];
    for (let i = 0; i <= tickCount; i++) {
      const t = range.start + (duration * i) / tickCount;
      const x = pad.left + (plotW * i) / tickCount;
      ticks.push(svg`
        <line x1="${x}" y1="${H - pad.bottom}" x2="${x}" y2="${H - pad.bottom + 4}" stroke="var(--text-secondary)" />
        <text x="${x}" y="${H - 4}" class="chart-axis-label" text-anchor="middle">${this._fmtTime(t - range.start)}</text>
      `);
    }
    return svg`
      <line x1="${pad.left}" y1="${H - pad.bottom}" x2="${pad.left + plotW}" y2="${H - pad.bottom}"
        stroke="var(--border)" />
      ${ticks}
    `;
  }

  private _renderCrosshair(
    event: SignalEvent, events: SignalEvent[],
    range: { start: number; end: number },
    pad: { top: number; right: number; bottom: number; left: number },
    plotW: number, plotH: number, H: number,
  ) {
    const x = pad.left + ((event.t - range.start) / (range.end - range.start)) * plotW;
    return svg`
      <line x1="${x}" y1="${pad.top}" x2="${x}" y2="${H - pad.bottom}"
        stroke="var(--text-secondary)" stroke-dasharray="2,2" class="chart-crosshair" />
      <text x="${x + 4}" y="${pad.top - 4}" class="chart-tooltip"
        fill="var(--text-bright)" font-size="10">${this._fmtTime(event.t - range.start)}: ${event.value}</text>
    `;
  }

  private _onMouseMove(
    e: MouseEvent, events: SignalEvent[],
    range: { start: number; end: number },
    pad: { top: number; right: number; bottom: number; left: number },
    plotW: number,
  ) {
    if (events.length === 0) return;
    const svgEl = (e.currentTarget as SVGSVGElement);
    const pt = svgEl.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const svgX = pt.matrixTransform(svgEl.getScreenCTM()!.inverse()).x;
    const t = range.start + ((svgX - pad.left) / plotW) * (range.end - range.start);

    // Find closest event
    let closest = 0;
    let minDist = Infinity;
    for (let i = 0; i < events.length; i++) {
      const dist = Math.abs(events[i].t - t);
      if (dist < minDist) {
        minDist = dist;
        closest = i;
      }
    }
    this._hoverIndex = closest;
  }

  private _onWheel(e: WheelEvent) {
    if (!e.ctrlKey && !e.metaKey) return; // plain scroll passes through to page
    e.preventDefault();
    const range = this._effectiveRange;
    const duration = range.end - range.start;
    const zoomFactor = e.deltaY > 0 ? 1.2 : 0.8;
    const mid = (range.start + range.end) / 2;
    const newDuration = Math.max(1000, Math.min(this.timeRange.end - this.timeRange.start, duration * zoomFactor));
    this._viewStart = Math.max(this.timeRange.start, mid - newDuration / 2);
    this._viewEnd = Math.min(this.timeRange.end, mid + newDuration / 2);
  }

  private _fmtTime(ms: number): string {
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return rem > 0 ? `${m}m${rem}s` : `${m}m`;
  }

  private _fmtNum(n: number): string {
    return Number.isInteger(n) ? String(n) : n.toFixed(1);
  }

  private get _pad() {
    return { top: 20, right: 10, bottom: 25, left: 45 };
  }
}
