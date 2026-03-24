/**
 * Simulation shim — sandboxed runtime for executing user entity code
 * with mocked HA APIs and virtual time.
 *
 * Instead of extracting function bodies from AST and compiling them,
 * we transpile the user's source and run it directly. The shim provides
 * all SDK exports as mock implementations that capture entity registrations,
 * state updates, stream subscriptions, and service calls.
 *
 * Security model: the user's own code from their own editor is executed
 * with a restricted set of globals (same trust model as Monaco's TS worker).
 * External APIs (fetch, fs, process) are simply not provided.
 */

import { signals, type SignalEvent } from './simulation.js';

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
  registeredEntities: Map<string, { kind: string; init?: () => void }>;
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
            for (const e of entities) snapshot[e] = state.stateStore.get(e) ?? null;
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
    },
    getState(entityId: string) {
      const s = state.stateStore.get(entityId);
      if (!s) {
        state.missingEntities.add(entityId);
        return { state: 'unavailable', attributes: {} };
      }
      return s;
    },
    getEntities() { return [...state.stateStore.keys()]; },
    fireEvent() {},
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

// ---- Entity factory shims ----

type EntityFactoryFn = (config: Record<string, unknown>) => Record<string, unknown>;

function createEntityFactory(state: SimState, kind: string): EntityFactoryFn {
  return (config: Record<string, unknown>) => {
    const id = config.id as string;
    const domain = factoryDomain(kind);
    const fullId = `${domain}.${id}`;

    const ctx = createMockContext(state, fullId);

    state.registeredEntities.set(fullId, {
      kind,
      init: config.init ? () => {
        try {
          (config.init as (this: Record<string, unknown>) => unknown).call(ctx);
        } catch (err) {
          state.errors.push({
            entityId: fullId,
            message: err instanceof Error ? err.message : String(err),
            phase: 'init',
          });
        }
      } : undefined,
    });

    // Computed entities: set up watch + compute pipeline
    if (kind === 'computed' && config.watch && config.compute) {
      const watchIds = config.watch as string[];
      const computeFn = config.compute as (states: Record<string, { state: string | number }>) => unknown;
      const debounce = typeof config.debounce === 'number' ? config.debounce : 0;
      let debounceTimerId: number | null = null;

      const runCompute = () => {
        const states: Record<string, { state: string | number }> = {};
        for (const wid of watchIds) {
          const s = state.stateStore.get(wid);
          if (s) {
            states[wid] = { state: s.state };
          } else {
            state.missingEntities.add(wid);
            states[wid] = { state: 'unavailable' };
          }
        }
        try {
          const value = computeFn(states);
          if (value !== undefined && value !== null) {
            (ctx.update as (v: unknown) => void)(value);
          }
        } catch (err) {
          state.errors.push({
            entityId: fullId,
            message: err instanceof Error ? err.message : String(err),
            phase: 'compute',
          });
        }
      };

      for (const wid of watchIds) {
        const subs = state.streamSubs.get(wid) || [];
        subs.push(() => {
          if (debounce > 0) {
            if (debounceTimerId !== null) {
              const idx = state.timers.findIndex(t => t.id === debounceTimerId);
              if (idx !== -1) state.timers.splice(idx, 1);
            }
            debounceTimerId = state.nextTimerId++;
            insertTimer(state.timers, {
              id: debounceTimerId,
              fireAt: state.currentTime + debounce,
              callback: () => { debounceTimerId = null; runCompute(); },
            });
          } else {
            runCompute();
          }
        });
        state.streamSubs.set(wid, subs);
      }
    }

    return { __kind: kind, ...config };
  };
}

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

// ---- Main simulation runner ----

/**
 * Run a simulation by executing transpiled user code with the shim runtime.
 *
 * The user's code is executed with a controlled set of globals — SDK factory
 * functions, mock HA APIs, and virtual timers. External APIs (fetch, fs, etc.)
 * are not provided. This is the user's own code from their editor, same trust
 * model as Monaco's TypeScript worker.
 *
 * @param transpiledJs - User code transpiled to JS (from ts.transpileModule).
 * @param scenarioName - Name of the scenario to run (empty = first scenario found).
 * @param timeRangeMs - Duration to simulate in virtual time.
 */
export function runShimSimulation(
  transpiledJs: string,
  scenarioName: string,
  timeRangeMs: number,
): SimulationShimResult {
  const state = createSimState();
  const capturedScenarios: Array<{ name: string; sources: Array<{ shadows: string; signal: (range: { start: number; end: number; stepMs: number }) => SignalEvent[] }> }> = [];

  // Build the shim globals — only what we explicitly provide is available
  const factories: Record<string, EntityFactoryFn> = {};
  const factoryNames = [
    'sensor', 'binarySensor', 'defineSwitch', 'light', 'cover', 'climate',
    'fan', 'lock', 'number', 'select', 'text', 'button', 'scene',
    'event', 'computed', 'automation', 'task', 'mode',
  ];
  for (const name of factoryNames) {
    factories[name] = createEntityFactory(state, name);
  }

  // Built-in reducer implementations matching the SDK
  const builtinReducers: Record<string, (values: number[]) => number> = {
    average: (vals) => vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : 0,
    sum: (vals) => vals.reduce((a, b) => a + b, 0),
    min: (vals) => vals.length > 0 ? Math.min(...vals) : 0,
    max: (vals) => vals.length > 0 ? Math.max(...vals) : 0,
    last: (vals) => vals.length > 0 ? vals[vals.length - 1] : 0,
    count: (vals) => vals.length,
  };

  // Track behavior wrappers applied to entities (entityId → config)
  interface BehaviorWrap { type: string; intervalMs?: number; reduceFn?: (values: number[]) => number; waitMs?: number; predicate?: (v: unknown) => boolean }
  const behaviorWraps = new Map<string, BehaviorWrap>();

  function resolveReducer(reduce: unknown): (values: number[]) => number {
    if (typeof reduce === 'function') return reduce as (values: number[]) => number;
    if (typeof reduce === 'string' && builtinReducers[reduce]) return builtinReducers[reduce];
    return builtinReducers.average;
  }

  function resolveEntityId(inner: Record<string, unknown>): string {
    const id = inner.id as string;
    // Try to find matching registered entity
    for (const fullId of state.registeredEntities.keys()) {
      if (fullId.endsWith(`.${id}`)) return fullId;
    }
    return id;
  }

  const shimGlobals: Record<string, unknown> = {
    ...factories,
    simulate: {
      scenario(name: string, sources: Array<{ shadows: string; signal: unknown }>) {
        capturedScenarios.push({ name, sources: sources as typeof capturedScenarios[0]['sources'] });
        return { __kind: 'scenario', name, sources };
      },
    },
    signals,
    device: (config: Record<string, unknown>) => ({ __kind: 'device', ...config }),
    debounced: (inner: Record<string, unknown>, opts?: { wait?: number }) => {
      behaviorWraps.set(resolveEntityId(inner), { type: 'debounced', waitMs: opts?.wait || 1000 });
      return inner;
    },
    filtered: (inner: Record<string, unknown>, opts?: { predicate?: unknown }) => {
      if (typeof opts?.predicate === 'function') {
        behaviorWraps.set(resolveEntityId(inner), { type: 'filtered', predicate: opts.predicate as (v: unknown) => boolean });
      }
      return inner;
    },
    sampled: (inner: Record<string, unknown>, opts?: { interval?: number }) => {
      behaviorWraps.set(resolveEntityId(inner), { type: 'sampled', intervalMs: opts?.interval || 30_000 });
      return inner;
    },
    buffered: (inner: Record<string, unknown>, opts?: { interval?: number; reduce?: unknown }) => {
      behaviorWraps.set(resolveEntityId(inner), {
        type: 'buffered',
        intervalMs: opts?.interval || 30_000,
        reduceFn: resolveReducer(opts?.reduce),
      });
      return inner;
    },
    average: 'average', sum: 'sum', min: 'min', max: 'max', last: 'last', count: 'count',
    exports: {},  // absorb CommonJS-style exports emitted by transpiler
    module: { exports: {} },  // absorb module.exports patterns
    console,      // pass through real console so user logs appear in devtools
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
  try {
    const varDecls = Object.keys(shimGlobals).map(k => `var ${k} = _g[${JSON.stringify(k)}];`).join('\n');
    // eslint-disable-next-line @typescript-eslint/no-implied-eval -- intentional: sandbox for user's own editor code
    const fn = new Function('_g', varDecls + '\n' + transpiledJs);
    fn(shimGlobals);
  } catch (err) {
    state.errors.push({
      message: `Module execution failed: ${err instanceof Error ? err.message : String(err)}`,
      phase: 'init',
    });
    return buildResult(state);
  }

  // Initialize entities that have init()
  for (const [, reg] of state.registeredEntities) {
    if (reg.init) reg.init();
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

  for (const [entityId, events] of sourceEvents) {
    const sorted = [...events].sort((a, b) => a.t - b.t);

    // Initialize source entity state
    if (sorted.length > 0) {
      state.stateStore.set(entityId, { state: sorted[0].value, attributes: {} });
    }

    // Record source events
    state.outputEvents.set(entityId, [...sorted]);

    // Feed each event
    for (let i = 0; i < sorted.length; i++) {
      const event = sorted[i];
      state.currentTime = event.t;

      flushTimersUpTo(state.timers, event.t, (t) => { state.currentTime = t; });

      const oldState = state.stateStore.get(entityId)?.state;
      state.stateStore.set(entityId, { state: event.value, attributes: {} });

      notifyStreamSubs(state, entityId, event.value, oldState);

      const nextTime = i + 1 < sorted.length ? sorted[i + 1].t : event.t + 60_000;
      flushTimersUpTo(state.timers, nextTime - 1, (t) => { state.currentTime = t; });
    }
  }

  // Final flush
  flushTimersUpTo(state.timers, state.currentTime + timeRangeMs, (t) => { state.currentTime = t; });

  // Post-process behavior wrappers on output events
  for (const [entityId, wrap] of behaviorWraps) {
    const raw = state.outputEvents.get(entityId);
    if (!raw || raw.length === 0) continue;

    if (wrap.type === 'buffered' && wrap.intervalMs && wrap.reduceFn) {
      // Window events into intervals and apply reducer
      const processed: SignalEvent[] = [];
      let windowStart = raw[0].t;
      let windowValues: number[] = [];

      for (const event of raw) {
        if (event.t >= windowStart + wrap.intervalMs) {
          // Flush current window
          if (windowValues.length > 0) {
            const reduced = wrap.reduceFn(windowValues);
            processed.push({ t: windowStart + wrap.intervalMs, value: Math.round(reduced * 100) / 100 });
          }
          windowStart = windowStart + wrap.intervalMs * Math.floor((event.t - windowStart) / wrap.intervalMs);
          windowValues = [];
        }
        const num = typeof event.value === 'number' ? event.value : Number(event.value);
        if (!isNaN(num)) windowValues.push(num);
      }
      // Flush last window
      if (windowValues.length > 0) {
        const reduced = wrap.reduceFn(windowValues);
        processed.push({ t: windowStart + wrap.intervalMs, value: Math.round(reduced * 100) / 100 });
      }
      state.outputEvents.set(entityId, processed);
    } else if (wrap.type === 'debounced' && wrap.waitMs) {
      // Keep only events that have no successor within waitMs
      const processed: SignalEvent[] = [];
      for (let i = 0; i < raw.length; i++) {
        const next = raw[i + 1];
        if (!next || next.t - raw[i].t >= wrap.waitMs) {
          processed.push(raw[i]);
        }
      }
      state.outputEvents.set(entityId, processed);
    } else if (wrap.type === 'sampled' && wrap.intervalMs) {
      // Take the latest value at each interval boundary
      const processed: SignalEvent[] = [];
      let nextSample = raw[0].t + wrap.intervalMs;
      let latest = raw[0];
      for (const event of raw) {
        if (event.t >= nextSample) {
          processed.push({ t: nextSample, value: latest.value });
          nextSample += wrap.intervalMs;
        }
        latest = event;
      }
      state.outputEvents.set(entityId, processed);
    } else if (wrap.type === 'filtered' && wrap.predicate) {
      const pred = wrap.predicate;
      state.outputEvents.set(entityId, raw.filter(e => {
        try { return pred(e.value); } catch { return true; }
      }));
    }
  }

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
