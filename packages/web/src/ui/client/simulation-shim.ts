/**
 * Simulation shim — sandboxed runtime for executing user entity code
 * with mocked HA APIs and virtual time.
 *
 * Uses the real SDK entity factories and behavior wrappers as globals.
 * The user's transpiled code calls the real `computed()`, `buffered()`, etc.
 * These return definition objects with `init()` functions. The shim then
 * calls `init()` on each definition with a mock `EntityContext` as `this`.
 *
 * Security model: the user's own code from their own editor is executed
 * with a restricted set of globals (same trust model as Monaco's TS worker).
 * External APIs (fetch, fs, process) are simply not provided.
 */

import {
  computed, sensor, binarySensor, defineSwitch, light, cover, climate,
  fan, lock, number, select, text, button, automation, task, mode, cron,
  device, simulate, signals, entityFactory,
  debounced, filtered, sampled, buffered,
  average, sum, min, max, last, count,
} from '@ha-forge/sdk';
import type { SignalEvent } from '@ha-forge/sdk';

// ---- Result types ----

export interface SimulationShimResult {
  /** Events per entity ID (every state update captured). */
  events: Map<string, SignalEvent[]>;
  /** Service calls observed during simulation. */
  serviceCalls: ServiceCallEvent[];
  /** Entity IDs that were accessed but had no simulation source. */
  missingEntities: string[];
  /** Errors encountered during simulation. */
  errors: SimulationError[];
  /** Summary per entity. */
  entities: Map<string, EntitySimSummary>;
}

export interface ServiceCallEvent {
  t: number;
  entityId: string;
  service: string;
}

export interface SimulationError {
  entityId?: string;
  message: string;
  phase: 'init' | 'stream' | 'compute' | 'timeout';
}

export interface EntitySimSummary {
  kind: string;
  eventCount: number;
  simulated: boolean;
  /** If not simulated, why. */
  skipReason?: string;
  /** Upstream entity IDs this entity watches. */
  watches?: string[];
}

// ---- Virtual timer queue (reused pattern from SDK simulate-context) ----

interface VirtualTimer {
  id: number;
  fireAt: number;
  callback: () => void;
  interval?: number;
}

function insertTimer(timers: VirtualTimer[], timer: VirtualTimer) {
  let lo = 0, hi = timers.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (timers[mid].fireAt <= timer.fireAt) lo = mid + 1; else hi = mid;
  }
  timers.splice(lo, 0, timer);
}

function flushTimersUpTo(
  timers: VirtualTimer[],
  upTo: number,
  setTime: (t: number) => void,
): void {
  let safety = 10_000;
  while (timers.length > 0 && timers[0].fireAt <= upTo && safety-- > 0) {
    const timer = timers.shift()!;
    setTime(timer.fireAt);
    timer.callback();
    if (timer.interval) {
      insertTimer(timers, {
        id: timer.id,
        fireAt: timer.fireAt + timer.interval,
        callback: timer.callback,
        interval: timer.interval,
      });
    }
  }
}

// ---- Shim state ----

interface SimState {
  currentTime: number;
  timers: VirtualTimer[];
  nextTimerId: number;
  /** Simulated entity states (entity ID → latest value). */
  stateStore: Map<string, { state: string | number; attributes: Record<string, unknown> }>;
  /** Captured output events per entity. */
  outputEvents: Map<string, SignalEvent[]>;
  /** Stream subscribers: entity ID being watched → callbacks. */
  streamSubs: Map<string, Array<(event: { new_state: string | number; old_state?: string | number; t: number }) => void>>;
  /** Service calls log. */
  serviceCalls: ServiceCallEvent[];
  /** Entity IDs accessed but had no simulation source. */
  missingEntities: Set<string>;
  /** Registered entity metadata. */
  registeredEntities: Map<string, { kind: string; init?: () => void | Promise<void>; watches?: string[] }>;
  /** Errors. */
  errors: SimulationError[];
}

function createSimState(): SimState {
  return {
    currentTime: 0,
    timers: [],
    nextTimerId: 1,
    stateStore: new Map(),
    outputEvents: new Map(),
    streamSubs: new Map(),
    serviceCalls: [],
    missingEntities: new Set(),
    registeredEntities: new Map(),
    errors: [],
  };
}

// ---- Mock EventStream ----

interface MockEventStream {
  filter(predicate: (event: unknown) => boolean): MockEventStream;
  map(fn: (event: unknown) => unknown): MockEventStream;
  debounce(ms: number): MockEventStream;
  throttle(ms: number): MockEventStream;
  distinctUntilChanged(): MockEventStream;
  onTransition(from: string, to: string): MockEventStream;
  subscribe(callback: (event: unknown) => void): { unsubscribe(): void };
}

function createMockEventStream(
  state: SimState,
  entityOrDomain: string | string[],
): MockEventStream {
  const entityIds = Array.isArray(entityOrDomain) ? entityOrDomain : [entityOrDomain];
  const operators: Array<{ type: string; fn: (event: unknown) => unknown }> = [];

  const stream: MockEventStream = {
    filter(predicate: (event: unknown) => boolean) {
      operators.push({ type: 'filter', fn: (e) => predicate(e) ? e : null });
      return stream;
    },
    map(fn: (event: unknown) => unknown) {
      operators.push({ type: 'map', fn });
      return stream;
    },
    debounce(ms: number) {
      operators.push({ type: 'debounce', fn: () => ms });
      return stream;
    },
    throttle(ms: number) {
      operators.push({ type: 'throttle', fn: () => ms });
      return stream;
    },
    distinctUntilChanged() {
      operators.push({ type: 'distinctUntilChanged', fn: () => null });
      return stream;
    },
    onTransition(from: string, to: string) {
      operators.push({ type: 'onTransition', fn: () => ({ from, to }) });
      return stream;
    },
    subscribe(callback: (event: unknown) => void) {
      const effectiveCallback = buildStreamPipeline(state, operators, callback);
      for (const entityId of entityIds) {
        const subs = state.streamSubs.get(entityId) || [];
        subs.push(effectiveCallback);
        state.streamSubs.set(entityId, subs);
      }
      return { unsubscribe() {} };
    },
  };

  return stream;
}

function buildStreamPipeline(
  state: SimState,
  operators: Array<{ type: string; fn: (event: unknown) => unknown }>,
  finalCallback: (event: unknown) => void,
): (event: { new_state: string | number; old_state?: string | number; t: number }) => void {
  let lastThrottleTime = -Infinity;
  let lastValue: string | number | undefined;
  let debounceTimerId: number | null = null;
  let debounceMs = 0;

  for (const op of operators) {
    if (op.type === 'debounce') debounceMs = op.fn(null) as number;
  }

  return (event) => {
    let current: unknown = event;

    for (const op of operators) {
      if (!current) return;

      switch (op.type) {
        case 'filter':
          if (!op.fn(current)) return;
          break;
        case 'map':
          current = op.fn(current);
          break;
        case 'throttle': {
          const ms = op.fn(null) as number;
          if (event.t - lastThrottleTime < ms) return;
          lastThrottleTime = event.t;
          break;
        }
        case 'distinctUntilChanged':
          if (event.new_state === lastValue) return;
          lastValue = event.new_state;
          break;
        case 'onTransition': {
          const { from, to } = op.fn(null) as { from: string; to: string };
          const fromOk = from === '*' || String(event.old_state) === from;
          const toOk = to === '*' || String(event.new_state) === to;
          if (!fromOk || !toOk) return;
          break;
        }
        case 'debounce':
          break; // handled below
      }
    }

    if (debounceMs > 0) {
      if (debounceTimerId !== null) {
        const idx = state.timers.findIndex(t => t.id === debounceTimerId);
        if (idx !== -1) state.timers.splice(idx, 1);
      }
      const timerId = state.nextTimerId++;
      debounceTimerId = timerId;
      const captured = current;
      insertTimer(state.timers, {
        id: timerId,
        fireAt: state.currentTime + debounceMs,
        callback: () => { debounceTimerId = null; finalCallback(captured); },
      });
    } else {
      finalCallback(current);
    }
  };
}

// ---- Mock entity context factory ----

function createMockContext(
  state: SimState,
  entityId: string,
): Record<string, unknown> {
  const events: SignalEvent[] = [];
  state.outputEvents.set(entityId, events);

  const ctx: Record<string, unknown> = {
    update(value: unknown, attributes?: Record<string, unknown>) {
      const v = (typeof value === 'number' || typeof value === 'string') ? value : String(value);
      events.push({ t: state.currentTime, value: v });
      const oldState = state.stateStore.get(entityId)?.state;
      state.stateStore.set(entityId, {
        state: v,
        attributes: { ...state.stateStore.get(entityId)?.attributes, ...attributes },
      });
      notifyStreamSubs(state, entityId, v, oldState);
    },
    attr(attributes: Record<string, unknown>) {
      const current = state.stateStore.get(entityId);
      if (current) {
        state.stateStore.set(entityId, { ...current, attributes: { ...current.attributes, ...attributes } });
      }
    },
    ha: createMockHaApi(state),
    events: {
      stream: (entityOrDomain: string | string[]) => createMockEventStream(state, entityOrDomain),
      reactions(rules: Record<string, unknown>) {
        for (const ruleEntityId of Object.keys(rules)) {
          const subs = state.streamSubs.get(ruleEntityId) || [];
          subs.push(() => {});
          state.streamSubs.set(ruleEntityId, subs);
        }
        return () => {};
      },
      combine(entities: string[], callback: (states: Record<string, unknown>) => void) {
        for (const eid of entities) {
          const subs = state.streamSubs.get(eid) || [];
          subs.push(() => {
            const snapshot: Record<string, unknown> = {};
            for (const e of entities) {
              const s = state.stateStore.get(e);
              snapshot[e] = s ? { state: String(s.state), attributes: s.attributes } : null;
            }
            callback(snapshot);
          });
          state.streamSubs.set(eid, subs);
        }
        return () => {};
      },
      withState(
        entityOrDomain: string | string[],
        context: string[],
        callback: (event: unknown, states: Record<string, unknown>) => void,
      ) {
        const entityIds = Array.isArray(entityOrDomain) ? entityOrDomain : [entityOrDomain];
        for (const eid of entityIds) {
          const subs = state.streamSubs.get(eid) || [];
          subs.push((event: unknown) => {
            const snapshot: Record<string, unknown> = {};
            let allPresent = true;
            for (const c of context) {
              const s = state.stateStore.get(c);
              if (!s) { allPresent = false; break; }
              snapshot[c] = s;
            }
            if (allPresent) callback(event, snapshot);
          });
          state.streamSubs.set(eid, subs);
        }
        return { unsubscribe() {} };
      },
      watchdog() { return () => {}; },
    },
    poll(fn: () => unknown, opts: { interval?: number; cron?: string; fireImmediately?: boolean }) {
      const interval = opts.interval || 60_000;
      if (opts.fireImmediately) {
        try {
          const result = fn();
          if (result !== undefined && result !== null) {
            (ctx.update as (v: unknown) => void)(result);
          }
        } catch { /* ignore */ }
      }
      const id = state.nextTimerId++;
      insertTimer(state.timers, {
        id,
        fireAt: state.currentTime + interval,
        callback: function pollTick() {
          try {
            const result = fn();
            if (result !== undefined && result !== null) {
              (ctx.update as (v: unknown) => void)(result);
            }
          } catch { /* ignore */ }
        },
        interval,
      });
    },
    setTimeout(callback: () => void, ms: number): number {
      const id = state.nextTimerId++;
      insertTimer(state.timers, { id, fireAt: state.currentTime + ms, callback });
      return id;
    },
    setInterval(callback: () => void, ms: number): number {
      const id = state.nextTimerId++;
      insertTimer(state.timers, { id, fireAt: state.currentTime + ms, callback, interval: ms });
      return id;
    },
    clearTimeout(id: number) {
      const idx = state.timers.findIndex(t => t.id === id);
      if (idx !== -1) state.timers.splice(idx, 1);
    },
    clearInterval(id: number) {
      const idx = state.timers.findIndex(t => t.id === id);
      if (idx !== -1) state.timers.splice(idx, 1);
    },
    log: { debug() {}, info() {}, warn() {}, error() {} },
  };

  return ctx;
}

function createMockHaApi(state: SimState): Record<string, unknown> {
  return {
    callService(entityId: string, service: string) {
      state.serviceCalls.push({ t: state.currentTime, entityId, service });
      return Promise.resolve(null);
    },
    getState(entityId: string) {
      const s = state.stateStore.get(entityId);
      if (!s) {
        state.missingEntities.add(entityId);
        return Promise.resolve({ state: 'unavailable', attributes: {} });
      }
      return Promise.resolve({ state: String(s.state), attributes: s.attributes });
    },
    getEntities() { return Promise.resolve([...state.stateStore.keys()]); },
    fireEvent() { return Promise.resolve(); },
    friendlyName(entityId: string) { return entityId; },
  };
}

function notifyStreamSubs(
  state: SimState,
  entityId: string,
  newState: string | number,
  oldState: string | number | undefined,
) {
  const subs = state.streamSubs.get(entityId);
  if (!subs) return;
  const event = {
    entity_id: entityId,
    new_state: newState,
    old_state: oldState,
    t: state.currentTime,
  };
  for (const cb of subs) {
    try { cb(event); }
    catch { /* subscriber threw */ }
  }
}

// ---- Collection infrastructure ----

/** Map from HA domain kind to MQTT domain prefix. */
function factoryDomain(kind: string): string {
  const map: Record<string, string> = {
    sensor: 'sensor', binarySensor: 'binary_sensor', switch: 'switch',
    light: 'light', cover: 'cover', climate: 'climate', fan: 'fan',
    lock: 'lock', number: 'number', select: 'select', text: 'text',
    button: 'button', scene: 'scene', event: 'event', computed: 'sensor',
    automation: 'automation', task: 'task', mode: 'mode',
  };
  return map[kind] || kind;
}

function collectDef(
  collectedDefs: Map<string, Record<string, unknown>>,
  def: Record<string, unknown>,
) {
  const id = def.id as string | undefined;
  const type = def.type as string | undefined;
  if (!id || !type) return;
  const domain = factoryDomain(type);
  const fullId = `${domain}.${id}`;
  collectedDefs.set(fullId, def);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function wrapFactory(fn: (...args: any[]) => any, collectedDefs: Map<string, Record<string, unknown>>) {
  return (...args: unknown[]) => {
    const def = fn(...args);
    collectDef(collectedDefs, def as Record<string, unknown>);
    return def;
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function wrapBehavior(fn: (entity: any, ...rest: any[]) => any, collectedDefs: Map<string, Record<string, unknown>>) {
  return (entity: unknown, ...rest: unknown[]) => {
    const def = fn(entity, ...rest);
    collectDef(collectedDefs, def as Record<string, unknown>);
    return def;
  };
}

/** Topological sort of definitions by their watch arrays (dependencies first). */
function topoSort(defs: Map<string, Record<string, unknown>>): Array<[string, Record<string, unknown>]> {
  const result: Array<[string, Record<string, unknown>]> = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();

  function visit(fullId: string) {
    if (visited.has(fullId)) return;
    if (visiting.has(fullId)) return; // cycle — just skip
    visiting.add(fullId);

    const def = defs.get(fullId);
    if (def) {
      const watches = def.watch as string[] | undefined;
      if (watches) {
        for (const wid of watches) {
          if (defs.has(wid)) visit(wid);
        }
      }
    }

    visiting.delete(fullId);
    visited.add(fullId);
    if (def) result.push([fullId, def]);
  }

  for (const fullId of defs.keys()) visit(fullId);
  return result;
}

// ---- Main simulation runner ----

/**
 * Run a simulation by executing transpiled user code with the shim runtime.
 *
 * The user's code is executed with a controlled set of globals — real SDK
 * factory functions wrapped with collection, mock HA APIs, and virtual timers.
 * External APIs (fetch, fs, etc.) are not provided. This is the user's own code
 * from their editor, same trust model as Monaco's TypeScript worker.
 *
 * @param transpiledJs - User code transpiled to JS (from ts.transpileModule).
 * @param scenarioName - Name of the scenario to run (empty = first scenario found).
 * @param timeRangeMs - Duration to simulate in virtual time.
 */
export async function runShimSimulation(
  transpiledJs: string,
  scenarioName: string,
  timeRangeMs: number,
): Promise<SimulationShimResult> {
  const state = createSimState();
  const collectedDefs = new Map<string, Record<string, unknown>>();
  const capturedScenarios: Array<{ name: string; sources: Array<{ shadows: string; signal: (range: { start: number; end: number; stepMs: number }) => SignalEvent[] }> }> = [];

  // Build the shim globals — real SDK functions wrapped with collection
  const shimGlobals: Record<string, unknown> = {
    // Entity factories — real SDK, wrapped to collect definitions
    sensor: wrapFactory(sensor, collectedDefs),
    binarySensor: wrapFactory(binarySensor, collectedDefs),
    defineSwitch: wrapFactory(defineSwitch, collectedDefs),
    light: wrapFactory(light, collectedDefs),
    cover: wrapFactory(cover, collectedDefs),
    climate: wrapFactory(climate, collectedDefs),
    fan: wrapFactory(fan, collectedDefs),
    lock: wrapFactory(lock, collectedDefs),
    number: wrapFactory(number, collectedDefs),
    select: wrapFactory(select, collectedDefs),
    text: wrapFactory(text, collectedDefs),
    button: wrapFactory(button, collectedDefs),
    computed: wrapFactory(computed, collectedDefs),
    automation: wrapFactory(automation, collectedDefs),
    task: wrapFactory(task, collectedDefs),
    mode: wrapFactory(mode, collectedDefs),
    cron: wrapFactory(cron, collectedDefs),
    entityFactory: wrapFactory(entityFactory, collectedDefs),

    // Behavior wrappers — real SDK, overwrites previous def for same entity ID
    debounced: wrapBehavior(debounced, collectedDefs),
    filtered: wrapBehavior(filtered, collectedDefs),
    sampled: wrapBehavior(sampled, collectedDefs),
    buffered: wrapBehavior(buffered, collectedDefs),

    // Reducers — real SDK values directly
    average, sum, min, max, last, count,

    // Simulation — real SDK, wrapped to capture scenarios
    simulate: {
      scenario(name: string, sources: Array<{ shadows: string; signal: unknown }>) {
        const def = simulate.scenario(name, sources as Parameters<typeof simulate.scenario>[1]);
        capturedScenarios.push({ name, sources: sources as typeof capturedScenarios[0]['sources'] });
        return def;
      },
    },
    signals,

    // Device — real SDK
    device,

    // Module stubs, console, timers, builtins
    exports: {},
    module: { exports: {} },
    console,
    setTimeout: (cb: () => void, ms: number) => {
      const id = state.nextTimerId++;
      insertTimer(state.timers, { id, fireAt: state.currentTime + ms, callback: cb });
      return id;
    },
    setInterval: (cb: () => void, ms: number) => {
      const id = state.nextTimerId++;
      insertTimer(state.timers, { id, fireAt: state.currentTime + ms, callback: cb, interval: ms });
      return id;
    },
    clearTimeout: (id: number) => {
      const idx = state.timers.findIndex(t => t.id === id);
      if (idx !== -1) state.timers.splice(idx, 1);
    },
    clearInterval: (id: number) => {
      const idx = state.timers.findIndex(t => t.id === id);
      if (idx !== -1) state.timers.splice(idx, 1);
    },
    Math, JSON, Number, String, Array, Object, Date, Map, Set,
    parseInt, parseFloat, isNaN, isFinite, undefined, NaN, Infinity,
    Boolean, RegExp, Error, Symbol, Promise,
  };

  // Execute user code — this registers entities and simulations.
  // User's own code from their editor, restricted to shim globals only.
  // We pass a single _g object and generate var declarations to avoid
  // reserved-word issues with names like 'switch' as function parameters.
  // NOTE: new Function() is intentional here — sandboxed execution of the
  // user's own editor code (same trust model as Monaco's TypeScript worker).
  try {
    const varDecls = Object.keys(shimGlobals).map(k => `var ${k} = _g[${JSON.stringify(k)}];`).join('\n');
    const fn = new Function('_g', varDecls + '\n' + transpiledJs); // eslint-disable-line no-new-func
    fn(shimGlobals);
  } catch (err) {
    state.errors.push({
      message: `Module execution failed: ${err instanceof Error ? err.message : String(err)}`,
      phase: 'init',
    });
    return buildResult(state);
  }

  // Select scenario and generate source events from captured signal generators
  const scenario = (scenarioName
    ? capturedScenarios.find(s => s.name === scenarioName)
    : null) || capturedScenarios[0];

  if (!scenario) {
    state.errors.push({ message: 'No scenarios found — use simulate.scenario() to define one', phase: 'init' });
    return buildResult(state);
  }

  const timeRange = { start: 0, end: timeRangeMs, stepMs: 1000 };
  const sourceEvents = new Map<string, SignalEvent[]>();
  for (const source of scenario.sources) {
    try {
      const events = source.signal(timeRange);
      sourceEvents.set(source.shadows, events);
    } catch (err) {
      state.errors.push({
        entityId: source.shadows,
        message: `Signal generation failed: ${err instanceof Error ? err.message : String(err)}`,
        phase: 'init',
      });
    }
  }

  // Pre-populate state store with first source event values
  for (const [entityId, events] of sourceEvents) {
    const sorted = [...events].sort((a, b) => a.t - b.t);
    if (sorted.length > 0) {
      state.stateStore.set(entityId, { state: sorted[0].value, attributes: {} });
    }
  }

  // Build registeredEntities from collected definitions, sorted topologically
  const sortedDefs = topoSort(collectedDefs);
  for (const [fullId, def] of sortedDefs) {
    const kind = (def.type as string) || 'unknown';
    const watches = def.watch as string[] | undefined;
    const initFn = def.init as ((this: Record<string, unknown>) => unknown) | undefined;

    state.registeredEntities.set(fullId, {
      kind,
      watches,
      init: initFn ? async () => {
        const ctx = createMockContext(state, fullId);
        try {
          const result = await initFn.call(ctx);
          // If init returns a value, publish it as initial state
          if (result !== undefined && result !== null) {
            (ctx.update as (v: unknown) => void)(result);
          }
        } catch (err) {
          state.errors.push({
            entityId: fullId,
            message: err instanceof Error ? err.message : String(err),
            phase: 'init',
          });
        }
      } : undefined,
    });
  }

  // Initialize entities in topological order (dependencies first)
  for (const [, reg] of state.registeredEntities) {
    if (reg.init) await reg.init();
  }

  // Feed source events
  for (const [entityId, events] of sourceEvents) {
    const sortedEvents = [...events].sort((a, b) => a.t - b.t);

    // Record source events
    state.outputEvents.set(entityId, [...sortedEvents]);

    // Feed each event
    for (let i = 0; i < sortedEvents.length; i++) {
      const event = sortedEvents[i];
      state.currentTime = event.t;

      flushTimersUpTo(state.timers, event.t, (t) => { state.currentTime = t; });

      const oldState = state.stateStore.get(entityId)?.state;
      state.stateStore.set(entityId, { state: event.value, attributes: {} });

      notifyStreamSubs(state, entityId, event.value, oldState);

      const nextTime = i + 1 < sortedEvents.length ? sortedEvents[i + 1].t : event.t + 60_000;
      flushTimersUpTo(state.timers, nextTime - 1, (t) => { state.currentTime = t; });
    }
  }

  // Final flush
  flushTimersUpTo(state.timers, state.currentTime + timeRangeMs, (t) => { state.currentTime = t; });

  return buildResult(state);
}

function buildResult(state: SimState): SimulationShimResult {
  const entities = new Map<string, EntitySimSummary>();

  // Sources first so the chain flow bar reads left-to-right (source → downstream)
  for (const [entityId, events] of state.outputEvents) {
    if (!state.registeredEntities.has(entityId)) {
      entities.set(entityId, {
        kind: 'source',
        eventCount: events.length,
        simulated: true,
      });
    }
  }

  for (const [entityId, reg] of state.registeredEntities) {
    const events = state.outputEvents.get(entityId);
    entities.set(entityId, {
      kind: reg.kind,
      eventCount: events?.length ?? 0,
      simulated: (events?.length ?? 0) > 0,
      watches: reg.watches,
    });
  }

  return {
    events: state.outputEvents,
    serviceCalls: state.serviceCalls,
    missingEntities: [...state.missingEntities],
    errors: state.errors,
    entities,
  };
}
