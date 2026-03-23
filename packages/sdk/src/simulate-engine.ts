import type { SignalEvent } from './types.js';

// ---- Operator descriptors ----

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

// ---- Timer priority queue ----

interface PendingTimer {
  fireAt: number;
  callback: () => void;
}

function insertTimer(queue: PendingTimer[], timer: PendingTimer) {
  // Binary insert to keep sorted by fireAt
  let lo = 0;
  let hi = queue.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (queue[mid].fireAt <= timer.fireAt) lo = mid + 1;
    else hi = mid;
  }
  queue.splice(lo, 0, timer);
}

function flushTimers(queue: PendingTimer[], upTo: number) {
  while (queue.length > 0 && queue[0].fireAt <= upTo) {
    const timer = queue.shift()!;
    timer.callback();
  }
}

// ---- Operator pipeline builder ----

interface OperatorStage {
  name: string;
  inputCount: number;
  outputCount: number;
  process: (event: SignalEvent) => SignalEvent | null;
  flush?: () => SignalEvent[];
}

function buildStages(
  operators: OperatorDescriptor[],
  timerQueue: PendingTimer[],
): OperatorStage[] {
  return operators.map((op): OperatorStage => {
    switch (op.type) {
      case 'debounce': {
        let pending: { timer: PendingTimer; event: SignalEvent } | null = null;
        let flushedEvent: SignalEvent | null = null;
        const stage: OperatorStage = {
          name: `debounce(${op.ms})`,
          inputCount: 0,
          outputCount: 0,
          process(event: SignalEvent): SignalEvent | null {
            stage.inputCount++;
            // Cancel previous pending timer
            if (pending) {
              const idx = timerQueue.indexOf(pending.timer);
              if (idx !== -1) timerQueue.splice(idx, 1);
            }
            const timer: PendingTimer = {
              fireAt: event.t + op.ms,
              callback: () => {
                flushedEvent = event;
                stage.outputCount++;
              },
            };
            pending = { timer, event };
            insertTimer(timerQueue, timer);
            return null; // output comes from timer
          },
          flush(): SignalEvent[] {
            if (flushedEvent) {
              const result = [flushedEvent];
              flushedEvent = null;
              return result;
            }
            return [];
          },
        };
        return stage;
      }

      case 'throttle': {
        let lastFired = -Infinity;
        const stage: OperatorStage = {
          name: `throttle(${op.ms})`,
          inputCount: 0,
          outputCount: 0,
          process(event: SignalEvent): SignalEvent | null {
            stage.inputCount++;
            if (event.t - lastFired >= op.ms) {
              lastFired = event.t;
              stage.outputCount++;
              return event;
            }
            return null;
          },
        };
        return stage;
      }

      case 'distinctUntilChanged': {
        let lastValue: string | number | undefined;
        const stage: OperatorStage = {
          name: 'distinctUntilChanged',
          inputCount: 0,
          outputCount: 0,
          process(event: SignalEvent): SignalEvent | null {
            stage.inputCount++;
            if (event.value !== lastValue) {
              lastValue = event.value;
              stage.outputCount++;
              return event;
            }
            return null;
          },
        };
        return stage;
      }

      case 'onTransition': {
        let lastValue: string | number | undefined;
        const stage: OperatorStage = {
          name: `onTransition(${op.from}, ${op.to})`,
          inputCount: 0,
          outputCount: 0,
          process(event: SignalEvent): SignalEvent | null {
            stage.inputCount++;
            const prev = lastValue;
            lastValue = event.value;
            const fromMatch = op.from === '*' || String(prev) === op.from;
            const toMatch = op.to === '*' || String(event.value) === op.to;
            if (prev !== undefined && fromMatch && toMatch) {
              stage.outputCount++;
              return event;
            }
            return null;
          },
        };
        return stage;
      }

      case 'filter':
      case 'map': {
        // Pass-through in v1 — closures can't be serialized from AST
        const stage: OperatorStage = {
          name: op.type,
          inputCount: 0,
          outputCount: 0,
          process(event: SignalEvent): SignalEvent | null {
            stage.inputCount++;
            stage.outputCount++;
            return event;
          },
        };
        return stage;
      }
    }
  });
}

/**
 * Run a simulated time engine over input events through an operator chain.
 * Time-based operators (debounce, throttle) use a virtual clock.
 */
export function runSimulation(
  input: SignalEvent[],
  operators: OperatorDescriptor[],
): SimulationResult {
  if (operators.length === 0) {
    return {
      input,
      output: [...input],
      stats: {
        inputCount: input.length,
        outputCount: input.length,
        passRate: 1,
        perOperator: [],
      },
    };
  }

  const sorted = [...input].sort((a, b) => a.t - b.t);
  const timerQueue: PendingTimer[] = [];
  const stages = buildStages(operators, timerQueue);
  const output: SignalEvent[] = [];

  // Find max debounce window for final flush
  let maxDebounceMs = 0;
  for (const op of operators) {
    if (op.type === 'debounce' && op.ms > maxDebounceMs) maxDebounceMs = op.ms;
  }

  function processEvent(event: SignalEvent) {
    let current: SignalEvent | null = event;
    for (const stage of stages) {
      if (!current) break;
      current = stage.process(current);

      // After processing, check if any stage has flushed output
      if (stage.flush) {
        const flushed = stage.flush();
        for (const f of flushed) {
          // Continue flushed events through remaining stages
          let carry: SignalEvent | null = f;
          const stageIdx = stages.indexOf(stage);
          for (let i = stageIdx + 1; i < stages.length; i++) {
            if (!carry) break;
            carry = stages[i].process(carry);
            if (stages[i].flush) {
              const nested = stages[i].flush!();
              for (const n of nested) output.push(n);
            }
          }
          if (carry) output.push(carry);
        }
      }
    }
    if (current) output.push(current);
  }

  for (let i = 0; i < sorted.length; i++) {
    const event = sorted[i];
    const nextTime = i + 1 < sorted.length ? sorted[i + 1].t : event.t + maxDebounceMs + 1;

    // Flush timers that fire before this event
    const prevTimerCount = timerQueue.length;
    flushTimers(timerQueue, event.t);
    // Collect any flushed stage output
    if (prevTimerCount !== timerQueue.length) {
      for (const stage of stages) {
        if (stage.flush) {
          const flushed = stage.flush();
          for (const f of flushed) {
            let carry: SignalEvent | null = f;
            const stageIdx = stages.indexOf(stage);
            for (let j = stageIdx + 1; j < stages.length; j++) {
              if (!carry) break;
              carry = stages[j].process(carry);
            }
            if (carry) output.push(carry);
          }
        }
      }
    }

    processEvent(event);

    // Flush timers between this event and the next
    if (timerQueue.length > 0) {
      flushTimers(timerQueue, nextTime - 1);
      for (const stage of stages) {
        if (stage.flush) {
          const flushed = stage.flush();
          for (const f of flushed) {
            let carry: SignalEvent | null = f;
            const stageIdx = stages.indexOf(stage);
            for (let j = stageIdx + 1; j < stages.length; j++) {
              if (!carry) break;
              carry = stages[j].process(carry);
            }
            if (carry) output.push(carry);
          }
        }
      }
    }
  }

  // Final flush: drain remaining timers
  if (sorted.length > 0) {
    const finalTime = sorted[sorted.length - 1].t + maxDebounceMs + 1;
    flushTimers(timerQueue, finalTime);
    for (const stage of stages) {
      if (stage.flush) {
        const flushed = stage.flush();
        for (const f of flushed) {
          let carry: SignalEvent | null = f;
          const stageIdx = stages.indexOf(stage);
          for (let j = stageIdx + 1; j < stages.length; j++) {
            if (!carry) break;
            carry = stages[j].process(carry);
          }
          if (carry) output.push(carry);
        }
      }
    }
  }

  // Sort output by time
  output.sort((a, b) => a.t - b.t);

  const inputCount = input.length;
  const outputCount = output.length;

  return {
    input,
    output,
    stats: {
      inputCount,
      outputCount,
      passRate: inputCount > 0 ? outputCount / inputCount : 0,
      perOperator: stages.map(s => ({
        name: s.name,
        inputCount: s.inputCount,
        outputCount: s.outputCount,
      })),
    },
  };
}

/** Tagged signal event for multi-entity simulation. */
interface TaggedSignalEvent extends SignalEvent {
  entityId: string;
}

/**
 * Run simulation across multiple entities.
 * Merges events from all entities into a single timeline sorted by time,
 * then processes through the operator chain.
 */
export function runMultiEntitySimulation(
  inputs: Map<string, SignalEvent[]>,
  operators: OperatorDescriptor[],
): SimulationResult {
  const merged: TaggedSignalEvent[] = [];
  for (const [entityId, events] of inputs) {
    for (const event of events) {
      merged.push({ ...event, entityId });
    }
  }
  merged.sort((a, b) => a.t - b.t);

  // Use the merged events as input (tag is preserved for downstream use)
  return runSimulation(merged, operators);
}
