/**
 * A branded numeric type that carries compile-time range constraints.
 * Used by generated validators to enforce min/max bounds at runtime.
 */
export type NumberInRange<Min extends number, Max extends number> = number & {
  readonly __min: Min;
  readonly __max: Max;
  readonly __brand: 'RangeValidated';
};

/** All supported Home Assistant entity platform types. */
export type EntityType =
  | 'sensor'
  | 'binary_sensor'
  | 'switch'
  | 'light'
  | 'cover'
  | 'climate'
  | 'fan'
  | 'lock'
  | 'humidifier'
  | 'valve'
  | 'water_heater'
  | 'vacuum'
  | 'lawn_mower'
  | 'siren'
  | 'number'
  | 'select'
  | 'text'
  | 'button'
  | 'scene'
  | 'event'
  | 'device_tracker'
  | 'camera'
  | 'alarm_control_panel'
  | 'notify'
  | 'update'
  | 'image';

/**
 * Device metadata for grouping entities under a single HA device.
 * Entities sharing the same `id` appear together in the HA device registry.
 */
export interface DeviceInfo {
  /** Unique device identifier. Entities with the same ID are grouped together. */
  id: string;
  /** Human-readable device name shown in the HA UI. */
  name: string;
  /** Device manufacturer (e.g. `'Acme Corp'`). */
  manufacturer?: string;
  /** Device model (e.g. `'Weather Station v2'`). */
  model?: string;
  /** Software/firmware version string. */
  sw_version?: string;
  /** Suggested area to assign this device to (e.g. `'Living Room'`). */
  suggested_area?: string;
}

/**
 * Logger available on `this.log` inside entity callbacks and on `this.ha.log`.
 * Messages are stored in SQLite and visible in the web UI log viewer.
 */
export interface EntityLogger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

/**
 * Untyped state change event from the HA WebSocket API.
 */
export interface StateChangedEvent {
  entity_id: string;
  old_state: string;
  new_state: string;
  old_attributes: Record<string, unknown>;
  new_attributes: Record<string, unknown>;
  timestamp: number;
}

/**
 * Strongly typed state change event.
 */
export interface TypedStateChangedEvent<TState, TAttrs, TEntityId extends string = string> {
  entity_id: TEntityId;
  old_state: TState;
  new_state: TState;
  old_attributes: TAttrs;
  new_attributes: TAttrs;
  timestamp: number;
}

/** Callback type for untyped state change subscriptions. */
export type StateChangedCallback = (event: StateChangedEvent) => void;

/** Handle returned by `.subscribe()` — the only way to stop a live stream. */
export interface Subscription {
  unsubscribe(): void;
}

/**
 * A lazy event stream. Operators chain naturally before the terminal `.subscribe()`.
 * No HA event listener is registered until `.subscribe()` is called.
 * All internal timers and subscriptions are cleaned up on unsubscribe.
 */
export interface EventStream<TEvent extends StateChangedEvent = StateChangedEvent> {
  filter(predicate: (event: TEvent) => boolean): EventStream<TEvent>;
  map(transform: (event: TEvent) => TEvent): EventStream<TEvent>;
  debounce(ms: number): EventStream<TEvent>;
  throttle(ms: number): EventStream<TEvent>;
  distinctUntilChanged(): EventStream<TEvent>;
  onTransition(from: string | '*', to: string | '*'): EventStream<TEvent>;
  subscribe(callback: (event: TEvent) => void): Subscription;
}

/** A declarative reaction rule for `ha.reactions()`. */
export interface ReactionRule {
  to?: string;
  when?: (event: StateChangedEvent) => boolean;
  do: () => void | Promise<void>;
  after?: number;
}

/**
 * Expectation filter for watchdog rules.
 */
export type WatchdogExpect =
  | 'change'
  | { to: string }
  | ((event: StateChangedEvent) => boolean);

/** A watchdog rule for detecting entity inactivity. */
export interface WatchdogRule {
  within: number;
  expect?: WatchdogExpect;
  else: () => void | Promise<void>;
}

/**
 * Scheduling options: either a fixed interval in milliseconds or a cron expression.
 */
export type ScheduleOptions =
  | { interval: number; cron?: never; fireImmediately?: boolean }
  | { cron: string; interval?: never; fireImmediately?: boolean };

/** An invariant constraint that is checked periodically. */
export interface InvariantOptions {
  name?: string;
  condition: () => boolean | Promise<boolean>;
  check: ScheduleOptions;
  violated: () => void | Promise<void>;
}

/** A single step in a sequence pattern. */
export interface SequenceStep<TEntity extends string = string> {
  entity: TEntity;
  to: string | '*';
  within?: number;
  negate?: boolean;
}

/** Configuration for a sequence pattern detector. */
export interface SequenceOptions {
  name?: string;
  steps: SequenceStep[];
  do: () => void | Promise<void>;
}

/** A snapshot of an entity's state and attributes, as returned by combine/withState. */
export interface EntitySnapshot {
  state: string;
  attributes: Record<string, unknown>;
}

/** A reactive attribute whose value is derived from other entities. */
export interface ComputedAttribute<TWatch extends string = string> {
  __computedAttr: true;
  watch: TWatch[];
  compute: (states: { [K in TWatch]: EntitySnapshot | null }) => unknown;
  debounce?: number;
}

/** Map of entity IDs to their current state snapshot, or `null` if unknown. */
export type CombinedState = Record<string, EntitySnapshot | null>;

/** Callback for `this.events.combine()`. */
export type CombinedCallback = (states: CombinedState) => void;

/**
 * Base HA client interface with methods that don't need generated registry types.
 */
export interface HAClientBase {
  log: EntityLogger;
  fireEvent(eventType: string, eventData?: Record<string, unknown>): Promise<void>;
  friendlyName(entityId: string): string;
}

/**
 * Scoped event subscription context bound to an entity's lifecycle.
 */
export interface EventsContext {
  stream(entityOrDomain: string | string[]): EventStream;
  reactions(rules: Record<string, ReactionRule>): () => void;
  combine<E extends string>(entities: E[], callback: (states: { [K in E]: EntitySnapshot | null }) => void): () => void;
  withState<C extends string>(
    entityOrDomain: string | string[],
    context: C[],
    callback: (event: StateChangedEvent, states: { [K in C]: EntitySnapshot }) => void,
  ): Subscription;
  watchdog<K extends string>(rules: Record<K, WatchdogRule>): () => void;
  invariant(options: Omit<InvariantOptions, 'check'> & { check: { interval: number } }): () => void;
  invariant(options: Omit<InvariantOptions, 'check'> & { check: { cron: string } }): () => void;
  sequence(options: SequenceOptions): () => void;
}

/**
 * Temporal query helpers backed by HA's recorder REST API.
 */
export interface HistoryApi {
  /** Was the entity in the given state within the last `within` ms? */
  recentlyIn(entityId: string, state: string, opts: { within: number }): Promise<boolean>;
  /** Average numeric state over the last `over` ms. Returns null if no numeric data. */
  average(entityId: string, opts: { over: number }): Promise<number | null>;
  /** Count state transitions in the last `over` ms. If `to` is specified, only count transitions to that state. */
  countTransitions(entityId: string, opts: { to?: string; over: number }): Promise<number>;
  /** Total time (ms) the entity spent in the given state over the last `over` ms. */
  duration(entityId: string, state: string, opts: { over: number }): Promise<number>;
}

/**
 * Stateless HA API — safe to pass to utility functions.
 */
export interface StatelessHAApi {
  callService(entity: string, service: string, data?: Record<string, unknown>): Promise<Record<string, unknown> | null>;
  getState(entityId: string): Promise<{ state: string; attributes: Record<string, unknown>; last_changed: string; last_updated: string } | null>;
  getEntities(domain?: string): Promise<string[]>;
  fireEvent(eventType: string, eventData?: Record<string, unknown>): Promise<void>;
  friendlyName(entityId: string): string;
  secret(key: string): string | undefined;
  history: HistoryApi;
}

// HAClient is NOT defined in the SDK — it comes from either:
// 1. Generated ha-registry.d.ts (with typed per-entity overloads)
// 2. Untyped fallback appended by the web server when no generated types exist

/**
 * Context object bound as `this` inside entity `init()`, `destroy()`, and `onCommand()` callbacks.
 */
export interface EntityContext<TState = unknown, TAttrs extends Record<string, unknown> = Record<string, unknown>> {
  update(value: TState | null, attributes?: Partial<TAttrs>): void;
  attr(attributes: Partial<TAttrs>): void;
  ha: StatelessHAApi;
  events: EventsContext;
  poll(fn: () => TState | Promise<TState>, opts: { interval: number; fireImmediately?: boolean }): void;
  poll(fn: () => TState | Promise<TState>, opts: { cron: string; fireImmediately?: boolean }): void;
  log: EntityLogger;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  mqtt: {
    publish(topic: string, payload: string, opts?: { retain?: boolean }): void;
    subscribe(topic: string, handler: (payload: string) => void): void;
  };
}

/**
 * Base interface for all entity definitions.
 */
export interface BaseEntity<TState, TConfig = Record<string, never>, TAttrs extends Record<string, unknown> = Record<string, unknown>> {
  id: string;
  name: string | null;
  type: EntityType;
  device?: DeviceInfo;
  category?: 'config' | 'diagnostic';
  icon?: string;
  config?: TConfig;
  attributes?: { [K in keyof TAttrs]: TAttrs[K] | ComputedAttribute };
  init?(this: EntityContext<TState, TAttrs>): TState | null | Promise<TState | null>;
  destroy?(this: EntityContext<TState, TAttrs>): void | Promise<void>;
}

/** State type for binary (on/off) entities. */
export type BinaryState = boolean | 'on' | 'off';
