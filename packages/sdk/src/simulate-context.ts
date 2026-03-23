import type { SignalEvent, StatefulEntityDefinition, EntityContext } from './types.js';
import type { SimulationResult, OperatorStats } from './simulate-engine.js';

// ---- Virtual timer queue ----

interface VirtualTimer {
  id: number;
  fireAt: number;
  callback: () => void;
  interval?: number; // If set, repeating
}

/**
 * Run a behavior-wrapped entity (debounced, filtered, sampled, buffered)
 * against a simulated signal using a mock EntityContext with virtual timers.
 *
 * Captures `this.update()` calls as output events and uses a virtual clock
 * for `this.setTimeout`/`this.setInterval`/`this.clearTimeout`/`this.clearInterval`.
 */
export function runBehaviorSimulation(
  entity: StatefulEntityDefinition,
  input: SignalEvent[],
): SimulationResult {
  const sorted = [...input].sort((a, b) => a.t - b.t);
  const output: SignalEvent[] = [];
  const timers: VirtualTimer[] = [];
  let nextTimerId = 1;
  let currentTime = sorted.length > 0 ? sorted[0].t : 0;

  // Mock EntityContext
  const mockContext: Partial<EntityContext> = {
    update(value: unknown) {
      output.push({ t: currentTime, value: value as string | number });
    },
    setTimeout(callback: () => void, ms: number): unknown {
      const id = nextTimerId++;
      const timer: VirtualTimer = { id, fireAt: currentTime + ms, callback };
      insertTimer(timers, timer);
      return id;
    },
    setInterval(callback: () => void, ms: number): unknown {
      const id = nextTimerId++;
      const timer: VirtualTimer = { id, fireAt: currentTime + ms, callback, interval: ms };
      insertTimer(timers, timer);
      return id;
    },
    clearTimeout(id: unknown) {
      const idx = timers.findIndex(t => t.id === id);
      if (idx !== -1) timers.splice(idx, 1);
    },
    clearInterval(id: unknown) {
      const idx = timers.findIndex(t => t.id === id);
      if (idx !== -1) timers.splice(idx, 1);
    },
    // Stubs for other context methods
    log: { debug() {}, info() {}, warn() {}, error() {} },
  };

  // Call entity init to set up the behavior wrappers
  const initFn = entity.init as ((this: EntityContext) => unknown) | undefined;
  if (initFn) {
    initFn.call(mockContext as EntityContext);
  }

  // Get the (possibly wrapped) update function
  const wrappedUpdate = mockContext.update!;

  // Process each input event
  for (let i = 0; i < sorted.length; i++) {
    const event = sorted[i];
    currentTime = event.t;

    // Flush timers up to current time
    flushTimersUpTo(timers, currentTime, (t) => {
      currentTime = t;
    });

    // Feed event through the (wrapped) update
    wrappedUpdate.call(mockContext, event.value);

    // Flush timers between events
    const nextTime = i + 1 < sorted.length ? sorted[i + 1].t : event.t + 60_000;
    flushTimersUpTo(timers, nextTime - 1, (t) => {
      currentTime = t;
    });
  }

  // Final flush
  if (sorted.length > 0) {
    const finalTime = sorted[sorted.length - 1].t + 60_000;
    flushTimersUpTo(timers, finalTime, (t) => {
      currentTime = t;
    });
  }

  output.sort((a, b) => a.t - b.t);

  const inputCount = input.length;
  const outputCount = output.length;

  // We can't track per-operator stats for behavior simulation since
  // the behaviors compose by wrapping update(), not as discrete stages
  const perOperator: OperatorStats[] = [{
    name: 'behavior',
    inputCount,
    outputCount,
  }];

  return {
    input,
    output,
    stats: {
      inputCount,
      outputCount,
      passRate: inputCount > 0 ? outputCount / inputCount : 0,
      perOperator,
    },
  };
}

function insertTimer(timers: VirtualTimer[], timer: VirtualTimer) {
  let lo = 0;
  let hi = timers.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (timers[mid].fireAt <= timer.fireAt) lo = mid + 1;
    else hi = mid;
  }
  timers.splice(lo, 0, timer);
}

function flushTimersUpTo(
  timers: VirtualTimer[],
  upTo: number,
  setTime: (t: number) => void,
) {
  let safety = 10000;
  while (timers.length > 0 && timers[0].fireAt <= upTo && safety-- > 0) {
    const timer = timers.shift()!;
    setTime(timer.fireAt);
    timer.callback();
    // Re-queue interval timers
    if (timer.interval) {
      const next: VirtualTimer = {
        id: timer.id,
        fireAt: timer.fireAt + timer.interval,
        callback: timer.callback,
        interval: timer.interval,
      };
      insertTimer(timers, next);
    }
  }
}
