/**
 * Client-side simulation engine and signal generators.
 * Self-contained — no dependencies on @ha-forge/sdk at runtime.
 * Mirrors the SDK's simulate-engine.ts and signals.ts for browser use.
 */

// ---- Types ----

export interface SignalEvent {
  t: number;
  value: string | number;
}

export interface TimeRange {
  start: number;
  end: number;
  stepMs: number;
}

export type OperatorDescriptor =
  | { type: 'debounce'; ms: number }
  | { type: 'throttle'; ms: number }
  | { type: 'distinctUntilChanged' }
  | { type: 'onTransition'; from: string; to: string }
  | { type: 'filter' }
  | { type: 'map' };

export interface OperatorStats {
  name: string;
  inputCount: number;
  outputCount: number;
}

export interface SimulationResult {
  input: SignalEvent[];
  output: SignalEvent[];
  stats: {
    inputCount: number;
    outputCount: number;
    passRate: number;
    perOperator: OperatorStats[];
  };
}

// ---- Seeded PRNG: xoshiro128** ----

function xoshiro128ss(seed: number): () => number {
  let s0 = seed >>> 0 || 1;
  let s1 = (seed * 1831565813) >>> 0 || 1;
  let s2 = (seed * 1103515245 + 12345) >>> 0 || 1;
  let s3 = (seed * 2654435761) >>> 0 || 1;

  return () => {
    const result = (((s1 * 5) << 7 | (s1 * 5) >>> 25) * 9) >>> 0;
    const t = (s1 << 9) >>> 0;
    s2 ^= s0; s3 ^= s1; s1 ^= s2; s0 ^= s3; s2 ^= t;
    s3 = (s3 << 11 | s3 >>> 21) >>> 0;
    return result / 4294967296;
  };
}

// ---- Signal generators ----

type SignalGenerator = (range: TimeRange) => SignalEvent[];

export const signals = {
  numeric(opts: { base: number; noise: number; interval: number; seed: number }): SignalGenerator {
    return (range: TimeRange) => {
      const rng = xoshiro128ss(opts.seed);
      const events: SignalEvent[] = [];
      for (let t = range.start; t <= range.end; t += opts.interval) {
        const noise = (rng() * 2 - 1) * opts.noise;
        events.push({ t, value: Math.round((opts.base + noise) * 100) / 100 });
      }
      return events;
    };
  },

  binary(opts: { onDuration: [number, number]; offDuration: [number, number]; seed: number }): SignalGenerator {
    return (range: TimeRange) => {
      const rng = xoshiro128ss(opts.seed);
      const events: SignalEvent[] = [];
      let t = range.start;
      let isOn = false;
      while (t <= range.end) {
        isOn = !isOn;
        events.push({ t, value: isOn ? 'on' : 'off' });
        const dur = isOn ? opts.onDuration : opts.offDuration;
        t += dur[0] + rng() * (dur[1] - dur[0]);
      }
      return events;
    };
  },

  enum(opts: { states: string[]; dwellRange: [number, number]; seed: number }): SignalGenerator {
    return (range: TimeRange) => {
      const rng = xoshiro128ss(opts.seed);
      const events: SignalEvent[] = [];
      let t = range.start;
      let idx = 0;
      while (t <= range.end) {
        events.push({ t, value: opts.states[idx % opts.states.length] });
        t += opts.dwellRange[0] + rng() * (opts.dwellRange[1] - opts.dwellRange[0]);
        idx++;
      }
      return events;
    };
  },
};

// ---- Operator pipeline ----

interface PendingTimer { fireAt: number; callback: () => void }

function insertTimer(queue: PendingTimer[], timer: PendingTimer) {
  let lo = 0, hi = queue.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (queue[mid].fireAt <= timer.fireAt) lo = mid + 1; else hi = mid;
  }
  queue.splice(lo, 0, timer);
}

function flushTimers(queue: PendingTimer[], upTo: number) {
  while (queue.length > 0 && queue[0].fireAt <= upTo) {
    queue.shift()!.callback();
  }
}

interface OperatorStage {
  name: string; inputCount: number; outputCount: number;
  process(event: SignalEvent): SignalEvent | null;
  flush?(): SignalEvent[];
}

function buildStages(operators: OperatorDescriptor[], timerQueue: PendingTimer[]): OperatorStage[] {
  return operators.map((op): OperatorStage => {
    switch (op.type) {
      case 'debounce': {
        let pending: { timer: PendingTimer } | null = null;
        let flushedEvent: SignalEvent | null = null;
        const stage: OperatorStage = {
          name: `debounce(${op.ms})`, inputCount: 0, outputCount: 0,
          process(event) {
            stage.inputCount++;
            if (pending) { const idx = timerQueue.indexOf(pending.timer); if (idx !== -1) timerQueue.splice(idx, 1); }
            const timer: PendingTimer = { fireAt: event.t + op.ms, callback: () => { flushedEvent = event; stage.outputCount++; } };
            pending = { timer };
            insertTimer(timerQueue, timer);
            return null;
          },
          flush() { if (flushedEvent) { const r = [flushedEvent]; flushedEvent = null; return r; } return []; },
        };
        return stage;
      }
      case 'throttle': {
        let lastFired = -Infinity;
        const stage: OperatorStage = {
          name: `throttle(${op.ms})`, inputCount: 0, outputCount: 0,
          process(event) { stage.inputCount++; if (event.t - lastFired >= op.ms) { lastFired = event.t; stage.outputCount++; return event; } return null; },
        };
        return stage;
      }
      case 'distinctUntilChanged': {
        let lastValue: string | number | undefined;
        const stage: OperatorStage = {
          name: 'distinctUntilChanged', inputCount: 0, outputCount: 0,
          process(event) { stage.inputCount++; if (event.value !== lastValue) { lastValue = event.value; stage.outputCount++; return event; } return null; },
        };
        return stage;
      }
      case 'onTransition': {
        let lastValue: string | number | undefined;
        const stage: OperatorStage = {
          name: `onTransition(${op.from}, ${op.to})`, inputCount: 0, outputCount: 0,
          process(event) {
            stage.inputCount++;
            const prev = lastValue; lastValue = event.value;
            const fromOk = op.from === '*' || String(prev) === op.from;
            const toOk = op.to === '*' || String(event.value) === op.to;
            if (prev !== undefined && fromOk && toOk) { stage.outputCount++; return event; }
            return null;
          },
        };
        return stage;
      }
      case 'filter': case 'map': {
        const stage: OperatorStage = {
          name: op.type, inputCount: 0, outputCount: 0,
          process(event) { stage.inputCount++; stage.outputCount++; return event; },
        };
        return stage;
      }
    }
  });
}

export function runSimulation(input: SignalEvent[], operators: OperatorDescriptor[]): SimulationResult {
  if (operators.length === 0) {
    return { input, output: [...input], stats: { inputCount: input.length, outputCount: input.length, passRate: 1, perOperator: [] } };
  }

  const sorted = [...input].sort((a, b) => a.t - b.t);
  const timerQueue: PendingTimer[] = [];
  const stages = buildStages(operators, timerQueue);
  const output: SignalEvent[] = [];
  let maxDebounceMs = 0;
  for (const op of operators) { if (op.type === 'debounce' && op.ms > maxDebounceMs) maxDebounceMs = op.ms; }

  function drainFlushed(fromStageIdx: number) {
    for (let i = fromStageIdx; i < stages.length; i++) {
      if (!stages[i].flush) continue;
      const flushed = stages[i].flush!();
      for (const f of flushed) {
        let carry: SignalEvent | null = f;
        for (let j = i + 1; j < stages.length; j++) { if (!carry) break; carry = stages[j].process(carry); }
        if (carry) output.push(carry);
      }
    }
  }

  for (let i = 0; i < sorted.length; i++) {
    const event = sorted[i];
    const nextTime = i + 1 < sorted.length ? sorted[i + 1].t : event.t + maxDebounceMs + 1;

    flushTimers(timerQueue, event.t); drainFlushed(0);

    let current: SignalEvent | null = event;
    for (const stage of stages) { if (!current) break; current = stage.process(current); }
    if (current) output.push(current);
    drainFlushed(0);

    flushTimers(timerQueue, nextTime - 1); drainFlushed(0);
  }

  if (sorted.length > 0) {
    flushTimers(timerQueue, sorted[sorted.length - 1].t + maxDebounceMs + 1);
    drainFlushed(0);
  }

  output.sort((a, b) => a.t - b.t);
  return {
    input, output,
    stats: {
      inputCount: input.length, outputCount: output.length,
      passRate: input.length > 0 ? output.length / input.length : 0,
      perOperator: stages.map(s => ({ name: s.name, inputCount: s.inputCount, outputCount: s.outputCount })),
    },
  };
}
