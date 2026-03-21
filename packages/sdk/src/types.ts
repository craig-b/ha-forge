/**
 * A branded numeric type that carries compile-time range constraints.
 * Used by generated validators to enforce min/max bounds at runtime.
 *
 * @example
 * ```ts
 * type Brightness = NumberInRange<0, 255>;
 * ```
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
  /** Log a debug-level message. Only visible when log level is set to `debug`. */
  debug(message: string, data?: Record<string, unknown>): void;
  /** Log an info-level message. */
  info(message: string, data?: Record<string, unknown>): void;
  /** Log a warning-level message. */
  warn(message: string, data?: Record<string, unknown>): void;
  /** Log an error-level message. */
  error(message: string, data?: Record<string, unknown>): void;
}

/**
 * Untyped state change event from the HA WebSocket API.
 * Used as the fallback when no generated types are available.
 *
 * @see {@link TypedStateChangedEvent} for the typed version with per-entity state and attributes.
 */
export interface StateChangedEvent {
  /** The entity that changed (e.g. `'light.living_room'`). */
  entity_id: string;
  /** Previous state value. */
  old_state: string;
  /** New state value after the change. */
  new_state: string;
  /** Previous entity attributes. */
  old_attributes: Record<string, unknown>;
  /** New entity attributes after the change. */
  new_attributes: Record<string, unknown>;
  /** Unix timestamp (ms) when the event was fired. */
  timestamp: number;
}

/**
 * Strongly typed state change event. Generated overloads use this to provide
 * per-entity state types, attribute types, and literal entity IDs.
 *
 * @typeParam TState - The entity's state type (e.g. `'on' | 'off'` for lights).
 * @typeParam TAttrs - The entity's attributes type.
 * @typeParam TEntityId - Literal entity ID type for narrowing in domain subscriptions.
 *
 * @example
 * ```ts
 * this.events.on('light.kitchen', (event) => {
 *   event.new_state;   // 'on' | 'off'
 *   event.entity_id;   // 'light.kitchen'
 * });
 * ```
 */
export interface TypedStateChangedEvent<TState, TAttrs, TEntityId extends string = string> {
  /** The entity that changed, typed as a literal when subscribing to a specific entity. */
  entity_id: TEntityId;
  /** Previous state value, typed per entity. */
  old_state: TState;
  /** New state value after the change, typed per entity. */
  new_state: TState;
  /** Previous entity attributes, typed per entity. */
  old_attributes: TAttrs;
  /** New entity attributes after the change, typed per entity. */
  new_attributes: TAttrs;
  /** Unix timestamp (ms) when the event was fired. */
  timestamp: number;
}

/** Callback type for untyped state change subscriptions. */
export type StateChangedCallback = (event: StateChangedEvent) => void;

/**
 * A composable event stream returned by `this.events.on()`.
 * Operators transform the event stream and return a new `EventStream`,
 * enabling fluent chaining: `this.events.on('sensor.temp').filter(...).debounce(1000)`.
 *
 * Call the stream as a function or use `.unsubscribe()` to cancel.
 * All internal timers and subscriptions are cleaned up on unsubscribe.
 */
export interface EventStream {
  /** Unsubscribe from the event stream and clean up all internal timers. */
  unsubscribe(): void;

  /**
   * Skip events that don't match a predicate.
   * @param predicate - Return `true` to keep the event, `false` to skip it.
   */
  filter(predicate: (event: StateChangedEvent) => boolean): EventStream;

  /**
   * Transform the event before passing it to downstream handlers.
   * @param transform - Function that receives the event and returns a modified event.
   */
  map(transform: (event: StateChangedEvent) => StateChangedEvent): EventStream;

  /**
   * Wait for the event to stabilize — only fires after no new events arrive
   * for the specified duration. Useful for sustained state detection
   * (e.g., "motion stays on for 30 seconds").
   * @param ms - Debounce window in milliseconds.
   */
  debounce(ms: number): EventStream;

  /**
   * Limit event rate — fires at most once per interval.
   * The first event passes immediately, then subsequent events are dropped
   * until the interval expires.
   * @param ms - Throttle interval in milliseconds.
   */
  throttle(ms: number): EventStream;

  /**
   * Skip events where `new_state` hasn't actually changed from the previous event.
   * Useful for filtering out attribute-only updates.
   */
  distinctUntilChanged(): EventStream;

  /**
   * Only fire when the entity transitions between specific states.
   * @param from - Previous state value (or `'*'` for any state).
   * @param to - New state value (or `'*'` for any state).
   *
   * @example
   * ```ts
   * // Fire only when a door opens
   * this.events.on('binary_sensor.front_door')
   *   .transition('off', 'on');
   * ```
   */
  transition(from: string | '*', to: string | '*'): EventStream;
}

/**
 * A declarative reaction rule for `ha.reactions()`.
 * Defines a condition and action to take when an entity's state changes.
 *
 * @example
 * ```ts
 * this.events.reactions({
 *   'binary_sensor.front_door': {
 *     to: 'on',
 *     after: 5000,
 *     do: () => this.ha.callService('light.porch', 'turn_on'),
 *   },
 * });
 * ```
 */
export interface ReactionRule {
  /** Fire action when the entity transitions to this state value. */
  to?: string;
  /** Custom condition function — return `true` to trigger the action. */
  when?: (event: StateChangedEvent) => boolean;
  /** Action to execute when the condition is met. */
  do: () => void | Promise<void>;
  /** Delay in milliseconds before executing. Cancelled if the entity's state changes again. */
  after?: number;
}

/**
 * Expectation filter for watchdog rules.
 * - `'change'` — any state change resets the timer.
 * - `{ to: 'off' }` — only resets when entity transitions to the given state.
 * - `(event) => boolean` — custom predicate for full control.
 */
export type WatchdogExpect =
  | 'change'
  | { to: string }
  | ((event: StateChangedEvent) => boolean);

/**
 * A watchdog rule for detecting entity inactivity.
 * Fires when an entity hasn't changed state within a specified time window.
 *
 * @example
 * ```ts
 * this.events.watchdog({
 *   'sensor.heartbeat': {
 *     within: 60_000,
 *     else: () => this.ha.callService('notify.admin', 'send_message', {
 *       message: 'Heartbeat sensor stopped responding!',
 *     }),
 *   },
 *   'binary_sensor.fridge_door': {
 *     expect: { to: 'off' },
 *     within: 300_000,
 *     else: () => this.ha.callService('tts.speak', 'say', { message: 'Fridge door is still open' }),
 *   },
 * });
 * ```
 */
export interface WatchdogRule {
  /** Maximum time in ms between state changes. If exceeded, `else` fires. */
  within: number;
  /**
   * Which events reset the timer. Default: any state change.
   * - `'change'` — any state change (same as omitting).
   * - `{ to: 'off' }` — only when entity transitions to the given state.
   * - `(event) => boolean` — custom predicate.
   */
  expect?: WatchdogExpect;
  /** Action to execute when the entity goes silent past the `within` window. */
  else: () => void | Promise<void>;
}

/**
 * An invariant constraint that is checked periodically.
 * Fires when the `condition` function returns `false`, indicating a violated constraint.
 *
 * @example
 * ```ts
 * this.events.invariant({
 *   name: 'garage_locked_at_night',
 *   condition: async () => {
 *     const hour = new Date().getHours();
 *     const garage = await this.ha.getState('cover.garage');
 *     return hour < 6 || hour > 22 ? garage?.state === 'closed' : true;
 *   },
 *   check: { interval: 60_000 },
 *   violated: () => {
 *     this.ha.callService('cover.garage', 'close_cover');
 *     this.ha.callService('notify.mobile', 'send_message', { message: 'Garage was open at night — closing.' });
 *   },
 * });
 * ```
 */
export interface InvariantOptions {
  /** Human-readable name for logging and debugging. */
  name?: string;
  /** Function that returns `true` when the constraint holds, `false` when violated. */
  condition: () => boolean | Promise<boolean>;
  /** How often to evaluate the condition. */
  check: { interval: number };
  /** Action to execute when `condition()` returns `false`. */
  violated: () => void | Promise<void>;
}

/**
 * A single step in a sequence pattern.
 *
 * @example
 * ```ts
 * { entity: 'binary_sensor.front_door', to: 'on', within: 5000 }
 * ```
 */
export interface SequenceStep {
  /** Entity to watch for this step. */
  entity: string;
  /** State the entity must transition to (or `'*'` for any change). */
  to: string | '*';
  /** Maximum time in ms to wait for this step before the sequence resets. First step has no timeout. */
  within?: number;
  /** If true, this step is *negated*: it matches when the entity does NOT reach the state within the window. Requires `within`. */
  negate?: boolean;
}

/**
 * Configuration for a sequence pattern detector.
 * Steps must occur in order, each within their time window.
 *
 * @example
 * ```ts
 * this.events.sequence({
 *   name: 'doorbell_then_no_answer',
 *   steps: [
 *     { entity: 'binary_sensor.doorbell', to: 'on' },
 *     { entity: 'lock.front_door', to: 'unlocked', within: 120_000, negate: true },
 *   ],
 *   do: () => this.ha.callService('notify.mobile', 'send_message', {
 *     message: 'Someone rang the doorbell and nobody answered',
 *   }),
 * });
 * ```
 */
export interface SequenceOptions {
  /** Human-readable name for logging and debugging. */
  name?: string;
  /** Ordered steps that must all match. */
  steps: SequenceStep[];
  /** Action to execute when all steps complete in order. */
  do: () => void | Promise<void>;
}

/** A snapshot of an entity's state and attributes, as returned by combine/withState. */
export interface EntitySnapshot {
  /** Current state value (e.g. `'on'`, `'23.5'`). */
  state: string;
  /** Current entity attributes. */
  attributes: Record<string, unknown>;
}

/**
 * A reactive attribute whose value is derived from other entities.
 * Created by `computed(fn, { watch })` and used inside entity `attributes`.
 * The runtime auto-subscribes to watched entities and re-publishes
 * the owning entity's attributes when the computed value changes.
 */
export interface ComputedAttribute {
  /** Runtime marker — distinguishes from plain attribute values. */
  __computedAttr: true;
  /** Entity IDs to watch. */
  watch: string[];
  /** Pure function that derives the attribute value from watched entity snapshots. */
  compute: (states: Record<string, EntitySnapshot | null>) => unknown;
  /** Debounce window in ms. Default: `100`. */
  debounce?: number;
}

/** Map of entity IDs to their current state snapshot, or `null` if the entity state is unknown. */
export type CombinedState = Record<string, EntitySnapshot | null>;

/** Callback for `this.events.combine()` — receives a snapshot of all watched entity states. */
export type CombinedCallback = (states: CombinedState) => void;

/**
 * Base HA client interface with methods that don't need generated registry types.
 * Extended by `HAClient` which adds `on()`, `callService()`, `getState()`, `getEntities()`, and `reactions()`.
 */
export interface HAClientBase {
  /** Logger for top-level logging outside of entity callbacks. */
  log: EntityLogger;
  /**
   * Fire a custom event on the HA event bus.
   * @param eventType - Event type name (e.g. `'my_custom_event'`).
   * @param eventData - Optional data payload attached to the event.
   */
  fireEvent(eventType: string, eventData?: Record<string, unknown>): Promise<void>;
  /**
   * Get the friendly name of a Home Assistant entity.
   * Returns the `friendly_name` attribute from cached state, or the entity ID if unavailable.
   * @param entityId - The entity ID (e.g. `'light.kitchen'`).
   * @returns The friendly name string.
   *
   * @example
   * ```ts
   * const name = this.ha.friendlyName('light.kitchen');
   * // 'Kitchen Light'
   * ```
   */
  friendlyName(entityId: string): string;
}

/**
 * Scoped event subscription context bound to an entity's lifecycle.
 * Subscriptions are automatically cleaned up when the entity is torn down.
 */
export interface EventsContext {
  /**
   * Subscribe to state changes for an entity, domain, or array of entities.
   * The subscription is automatically cleaned up when the owning entity is torn down.
   *
   * Returns an `EventStream` with chainable operators for filtering and transforming events.
   *
   * @param entityOrDomain - Entity ID, domain name, or array of entity IDs.
   * @param callback - Called with a state change event. Optional when using stream operators.
   * @returns An `EventStream` with `.filter()`, `.debounce()`, `.throttle()`, `.map()`, `.distinctUntilChanged()`, and `.transition()` operators.
   *
   * @example
   * ```ts
   * // Simple callback
   * this.events.on('binary_sensor.motion', (event) => { ... });
   *
   * // With stream operators
   * this.events.on('binary_sensor.motion')
   *   .filter(e => e.new_state === 'on')
   *   .debounce(5000)
   *   .map(e => ({ ...e, new_state: 'sustained' }));
   * ```
   */
  on(entityOrDomain: string | string[], callback?: StateChangedCallback): EventStream;
  /**
   * Set up declarative reaction rules. Subscriptions and pending timers are
   * automatically cleaned up when the owning entity is torn down.
   * @param rules - Map of entity IDs to reaction rules.
   * @returns Cleanup function.
   */
  reactions(rules: Record<string, ReactionRule>): () => void;

  /**
   * Subscribe to multiple entities and receive a combined state snapshot on every change.
   * The callback fires whenever *any* of the watched entities changes state,
   * with the current state of *all* watched entities.
   *
   * @param entities - Array of entity IDs to watch.
   * @param callback - Called with a map of entity IDs to their current state snapshot (or `null` if unknown).
   * @returns Cleanup function.
   *
   * @example
   * ```ts
   * this.events.combine(
   *   ['sensor.temperature', 'sensor.humidity'],
   *   (states) => {
   *     const temp = states['sensor.temperature'];
   *     const humidity = states['sensor.humidity'];
   *     if (temp && humidity) {
   *       this.update(Number(temp.state) > 30 && Number(humidity.state) > 70 ? 'on' : 'off');
   *     }
   *   },
   * );
   * ```
   */
  combine(entities: string[], callback: CombinedCallback): () => void;

  /**
   * Subscribe to an entity's state changes with access to the current state of other entities.
   * Like `on()`, but the callback receives a second argument with a snapshot
   * of specified context entities' states.
   *
   * The callback is **only invoked when all context entities are available** —
   * if any context entity has no cached state, the event is silently skipped.
   * This acts as a Maybe-chain: no null checks needed inside the callback.
   *
   * @param entityOrDomain - Entity ID, domain, or array to watch for changes.
   * @param context - Array of entity IDs whose current state must be available.
   * @param callback - Called with the event and a guaranteed-present state snapshot of all context entities.
   * @returns An `EventStream`.
   *
   * @example
   * ```ts
   * this.events.withState(
   *   'binary_sensor.motion',
   *   ['sensor.lux', 'input_boolean.night_mode'],
   *   (event, states) => {
   *     // states are guaranteed non-null — no checks needed
   *     if (event.new_state === 'on' && Number(states['sensor.lux'].state) < 50) {
   *       this.ha.callService('light.hallway', 'turn_on');
   *     }
   *   },
   * );
   * ```
   */
  withState(
    entityOrDomain: string | string[],
    context: string[],
    callback: (event: StateChangedEvent, states: Record<string, EntitySnapshot>) => void,
  ): EventStream;

  /**
   * Set up watchdog timers that fire when entities go silent.
   * The timer resets on every matching state change. If no change arrives
   * within the `within` window, the `else` handler fires. The timer then
   * restarts, so `else` can fire repeatedly if silence continues.
   *
   * @param rules - Map of entity IDs to watchdog rules.
   * @returns Cleanup function that cancels all watchdog timers.
   *
   * @example
   * ```ts
   * this.events.watchdog({
   *   'sensor.heartbeat': {
   *     within: 60_000,
   *     else: () => this.log.warn('Heartbeat lost!'),
   *   },
   *   'binary_sensor.fridge_door': {
   *     expect: { to: 'off' },
   *     within: 300_000,
   *     else: () => this.ha.callService('tts.speak', 'say', { message: 'Fridge door is still open' }),
   *   },
   * });
   * ```
   */
  watchdog(rules: Record<string, WatchdogRule>): () => void;

  /**
   * Set up a periodic invariant check. The `check` function is evaluated
   * at the given interval. When it returns `false`, the `violated` handler fires.
   * The check continues running even after a violation.
   *
   * @param options - Invariant configuration.
   * @returns Cleanup function that stops the periodic check.
   *
   * @example
   * ```ts
   * this.events.invariant({
   *   name: 'pump_flow_check',
   *   condition: async () => {
   *     const pump = await this.ha.getState('switch.pump');
   *     const flow = await this.ha.getState('sensor.flow_rate');
   *     // Pump is on but no flow — something is wrong
   *     return !(pump?.state === 'on' && Number(flow?.state) === 0);
   *   },
   *   check: { interval: 10_000 },
   *   violated: () => this.ha.callService('switch.pump', 'turn_off'),
   * });
   * ```
   */
  invariant(options: InvariantOptions): () => void;

  /**
   * Detect a sequence of state changes across entities.
   * Steps must fire in order, each within their optional time window.
   * When all steps complete, `then()` fires and the sequence resets.
   * If a step times out, the sequence resets to step 0.
   *
   * @param options - Sequence configuration with steps and completion handler.
   * @returns Cleanup function that cancels all sequence tracking.
   *
   * @example
   * ```ts
   * // Detect "arrive home" pattern: door opens, then motion within 10s
   * this.events.sequence({
   *   name: 'arrive_home',
   *   steps: [
   *     { entity: 'binary_sensor.front_door', to: 'on' },
   *     { entity: 'binary_sensor.hallway_motion', to: 'on', within: 10_000 },
   *   ],
   *   do: () => this.ha.callService('scene.welcome_home', 'turn_on'),
   * });
   * ```
   */
  sequence(options: SequenceOptions): () => void;
}

/**
 * Stateless HA API — safe to pass to utility functions.
 * Contains only query/action methods, no subscriptions or logging.
 */
export interface StatelessHAApi {
  /** Call a Home Assistant service on an entity or domain. */
  callService(entity: string, service: string, data?: Record<string, unknown>): Promise<Record<string, unknown> | null>;
  /** Get the current state of a Home Assistant entity. Returns `null` if not found. */
  getState(entityId: string): Promise<{ state: string; attributes: Record<string, unknown>; last_changed: string; last_updated: string } | null>;
  /** List entity IDs registered in Home Assistant, optionally filtered by domain. */
  getEntities(domain?: string): Promise<string[]>;
  /**
   * Fire a custom event on the HA event bus.
   * @param eventType - Event type name (e.g. `'my_custom_event'`).
   * @param eventData - Optional data payload attached to the event.
   */
  fireEvent(eventType: string, eventData?: Record<string, unknown>): Promise<void>;
  /**
   * Get the friendly name of a Home Assistant entity.
   * Returns the `friendly_name` attribute from cached state, or the entity ID if unavailable.
   * @param entityId - The entity ID (e.g. `'light.kitchen'`).
   */
  friendlyName(entityId: string): string;
}

// HAClient is NOT defined in the SDK — it comes from either:
// 1. Generated ha-registry.d.ts (with typed per-entity overloads)
// 2. Untyped fallback appended by the web server when no generated types exist
// This ensures typed overloads always take priority in TypeScript's resolution order.

/**
 * Context object bound as `this` inside entity `init()`, `destroy()`, and `onCommand()` callbacks.
 * Provides methods for publishing state, polling, logging, timers, MQTT access,
 * HA API (`this.ha`), and lifecycle-managed event subscriptions (`this.events`).
 *
 * @typeParam TState - The entity's state type.
 *
 * @example
 * ```ts
 * sensor({
 *   id: 'cpu_temp',
 *   name: 'CPU Temperature',
 *   init() {
 *     this.poll(async () => {
 *       const resp = await fetch('http://localhost/api/temp');
 *       return (await resp.json()).value;
 *     }, { interval: 30_000 });
 *     return '0';
 *   },
 * });
 * ```
 */
export interface EntityContext<TState = unknown> {
  /**
   * Publish a new state value (and optional attributes) to Home Assistant.
   * @param value - The new state value.
   * @param attributes - Optional attributes to publish alongside the state.
   */
  update(value: TState, attributes?: Record<string, unknown>): void;
  /**
   * Update attributes without changing the entity's state value.
   * Re-publishes the current state with the new attributes.
   * @param attributes - Attributes to publish alongside the current state.
   */
  attr(attributes: Record<string, unknown>): void;
  /**
   * Stateless HA API — safe to pass to utility functions.
   * Provides callService, getState, getEntities, fireEvent, friendlyName.
   */
  ha: StatelessHAApi;
  /**
   * Scoped event subscriptions — automatically cleaned up when this entity is torn down.
   * Use `this.events.on()` for state change subscriptions and `this.events.reactions()` for declarative rules.
   */
  events: EventsContext;
  /**
   * Start a polling loop that calls `fn` at a fixed interval.
   * If `fn` returns a value, it is automatically published via `update()`.
   * Uses chained timeouts to prevent overlapping executions.
   * Automatically cleaned up when the entity is destroyed.
   * @param fn - Function to call each interval. Return a value to auto-publish state.
   * @param opts - Polling options.
   */
  poll(fn: () => TState | Promise<TState>, opts: { interval: number; initialDelay?: number }): void;
  /** Scoped logger for this entity. Messages include the entity ID and source file automatically. */
  log: EntityLogger;
  /**
   * Schedule a one-shot callback. Automatically cleared on entity teardown.
   * @param fn - Callback to execute.
   * @param ms - Delay in milliseconds.
   */
  setTimeout(fn: () => void, ms: number): void;
  /**
   * Schedule a repeating callback. Automatically cleared on entity teardown.
   * @param fn - Callback to execute.
   * @param ms - Interval in milliseconds.
   */
  setInterval(fn: () => void, ms: number): void;
  /**
   * Direct MQTT publish/subscribe access for custom topics.
   * Subscriptions are automatically cleaned up on entity teardown.
   */
  mqtt: {
    /**
     * Publish a message to an MQTT topic.
     * @param topic - The MQTT topic to publish to.
     * @param payload - The message payload as a string.
     * @param opts - Publish options.
     */
    publish(topic: string, payload: string, opts?: { retain?: boolean }): void;
    /**
     * Subscribe to an MQTT topic. The subscription is auto-cleaned on entity teardown.
     * @param topic - The MQTT topic to subscribe to (supports wildcards).
     * @param handler - Called with the message payload for each received message.
     */
    subscribe(topic: string, handler: (payload: string) => void): void;
  };
}

/**
 * Base interface for all entity definitions.
 * Extended by `SensorDefinition`, `SwitchDefinition`, `LightDefinition`, etc.
 *
 * @typeParam TState - The entity's state type.
 * @typeParam TConfig - The entity's MQTT discovery config type.
 */
export interface BaseEntity<TState, TConfig = Record<string, never>> {
  /** Unique entity identifier. Used as the object_id in MQTT topics. */
  id: string;
  /**
   * Human-readable name shown in the HA UI.
   * When grouped under a device, HA prepends the device name — so set this to
   * just the distinguishing part (e.g. `'Temperature'` under a `'Weather Station'` device).
   * Set to `null` to use the device name as the entity name (for single-entity devices).
   */
  name: string | null;
  /** Entity platform type. */
  type: EntityType;
  /** Optional device to group this entity under. */
  device?: DeviceInfo;
  /** Entity category — `'config'` or `'diagnostic'` entities are hidden from the default UI. */
  category?: 'config' | 'diagnostic';
  /** MDI icon override (e.g. `'mdi:thermometer'`). */
  icon?: string;
  /** Platform-specific MQTT discovery configuration. */
  config?: TConfig;
  /**
   * Declarative attributes published alongside the entity state.
   * Values can be static (strings, numbers, objects) or reactive via `computed()`.
   * Computed attributes auto-subscribe to watched entities and re-publish
   * the owning entity's attributes when the derived value changes.
   *
   * @example
   * ```ts
   * sensor({
   *   id: 'cpu_temp',
   *   name: 'CPU Temperature',
   *   attributes: {
   *     location: 'server-room',                    // static
   *     severity: computed(                          // reactive
   *       (states) => {
   *         const t = Number(states['sensor.cpu_temp']?.state);
   *         return t > 80 ? 'critical' : t > 60 ? 'warning' : 'normal';
   *       },
   *       { watch: ['sensor.cpu_temp'] },
   *     ),
   *   },
   * });
   * ```
   */
  attributes?: Record<string, unknown | ComputedAttribute>;
  /**
   * Called once when the entity is deployed. Return the initial state value.
   * Use `this.poll()`, `this.events.on()`, etc. to set up ongoing state updates.
   */
  init?(this: EntityContext<TState>): TState | Promise<TState>;
  /**
   * Called when the entity is torn down (before redeploy or shutdown).
   * Use for cleanup of external resources. Tracked timers/intervals are auto-cleared.
   */
  destroy?(this: EntityContext<TState>): void | Promise<void>;
}

// ---- Sensor ----

/**
 * Device class for sensor entities. Determines the default icon,
 * unit of measurement, and display format in the HA UI.
 *
 * @see https://developers.home-assistant.io/docs/core/entity/sensor/#available-device-classes
 */
export type SensorDeviceClass =
  | 'apparent_power'
  | 'aqi'
  | 'atmospheric_pressure'
  | 'battery'
  | 'carbon_dioxide'
  | 'carbon_monoxide'
  | 'current'
  | 'data_rate'
  | 'data_size'
  | 'date'
  | 'distance'
  | 'duration'
  | 'energy'
  | 'energy_storage'
  | 'enum'
  | 'frequency'
  | 'gas'
  | 'humidity'
  | 'illuminance'
  | 'irradiance'
  | 'moisture'
  | 'monetary'
  | 'nitrogen_dioxide'
  | 'nitrogen_monoxide'
  | 'nitrous_oxide'
  | 'ozone'
  | 'ph'
  | 'pm1'
  | 'pm10'
  | 'pm25'
  | 'power'
  | 'power_factor'
  | 'precipitation'
  | 'precipitation_intensity'
  | 'pressure'
  | 'reactive_power'
  | 'signal_strength'
  | 'sound_pressure'
  | 'speed'
  | 'sulphur_dioxide'
  | 'temperature'
  | 'timestamp'
  | 'volatile_organic_compounds'
  | 'volatile_organic_compounds_parts'
  | 'voltage'
  | 'volume'
  | 'volume_flow_rate'
  | 'volume_storage'
  | 'water'
  | 'weight'
  | 'wind_speed';

/** MQTT discovery configuration for sensor entities. */
export interface SensorConfig {
  /** Sensor device class — determines icon and default unit in HA. */
  device_class?: SensorDeviceClass;
  /** Unit of measurement displayed alongside the state value (e.g. `'°C'`, `'kWh'`). */
  unit_of_measurement?: string;
  /** State class for long-term statistics. Use `'measurement'` for instantaneous values, `'total'` for cumulative totals. */
  state_class?: 'measurement' | 'total' | 'total_increasing';
  /** Number of decimal places to display in the HA UI. */
  suggested_display_precision?: number;
}

/** Entity definition for a read-only sensor. State is a string or number. */
export interface SensorDefinition extends BaseEntity<string | number, SensorConfig> {
  type: 'sensor';
}

/**
 * Entity definition for a computed (derived) sensor.
 * State is a pure function of other entities' current state — no `init()` or `destroy()`.
 * The runtime auto-subscribes to `watch` entities and re-evaluates `compute()` on change.
 *
 * Created by the `computed()` factory function.
 *
 * @example
 * ```ts
 * export const comfort = computed({
 *   id: 'comfort_index',
 *   name: 'Comfort Index',
 *   watch: ['sensor.temperature', 'sensor.humidity'],
 *   compute: (states) => {
 *     const temp = Number(states['sensor.temperature']?.state);
 *     const humidity = Number(states['sensor.humidity']?.state);
 *     return Math.round(temp + 0.05 * humidity);
 *   },
 *   config: { unit_of_measurement: '°C', device_class: 'temperature' },
 * });
 * ```
 */
export interface ComputedDefinition {
  type: 'sensor';
  /** Runtime marker — distinguishes from regular sensors. */
  __computed: true;
  /** Unique entity identifier. */
  id: string;
  /** Human-readable name shown in the HA UI. */
  name: string;
  /** Optional device to group this entity under. */
  device?: DeviceInfo;
  /** Entity category. */
  category?: 'config' | 'diagnostic';
  /** MDI icon override. */
  icon?: string;
  /** Sensor-specific MQTT discovery config. */
  config?: SensorConfig;
  /** Entity IDs to watch. When any changes state, `compute()` is re-evaluated. */
  watch: string[];
  /**
   * Pure function that derives state from current values of watched entities.
   * Receives a map of entity IDs to their current state snapshot (or `null` if unknown).
   * Return value becomes the entity's published state.
   */
  compute: (states: Record<string, EntitySnapshot | null>) => string | number;
  /**
   * Debounce window in ms for coalescing rapid input changes.
   * When multiple watched entities change in quick succession, `compute()` runs
   * once after the debounce window instead of once per change. Default: `100`.
   */
  debounce?: number;
}

// ---- Binary sensor ----

/**
 * Device class for binary sensor entities. Determines the default icon
 * and on/off label text in the HA UI.
 *
 * @see https://developers.home-assistant.io/docs/core/entity/binary-sensor/#available-device-classes
 */
export type BinarySensorDeviceClass =
  | 'battery'
  | 'battery_charging'
  | 'carbon_monoxide'
  | 'cold'
  | 'connectivity'
  | 'door'
  | 'garage_door'
  | 'gas'
  | 'heat'
  | 'light'
  | 'lock'
  | 'moisture'
  | 'motion'
  | 'moving'
  | 'occupancy'
  | 'opening'
  | 'plug'
  | 'power'
  | 'presence'
  | 'problem'
  | 'running'
  | 'safety'
  | 'smoke'
  | 'sound'
  | 'tamper'
  | 'update'
  | 'vibration'
  | 'window';

/** MQTT discovery configuration for binary sensor entities. */
export interface BinarySensorConfig {
  /** Binary sensor device class — determines icon and on/off labels in HA. */
  device_class?: BinarySensorDeviceClass;
}

/** Entity definition for a binary (on/off) sensor. */
export interface BinarySensorDefinition extends BaseEntity<'on' | 'off', BinarySensorConfig> {
  type: 'binary_sensor';
}

// ---- Switch ----

/** MQTT discovery configuration for switch entities. */
export interface SwitchConfig {
  /** Switch device class — `'outlet'` for power outlets, `'switch'` for generic switches. */
  device_class?: 'outlet' | 'switch';
}

/** Entity definition for a controllable on/off switch. */
export interface SwitchDefinition extends BaseEntity<'on' | 'off', SwitchConfig> {
  type: 'switch';
  /**
   * Called when HA sends a command to this switch.
   * @param command - `'ON'` or `'OFF'`.
   */
  onCommand(this: EntityContext<'on' | 'off'>, command: 'ON' | 'OFF'): void | Promise<void>;
}

// ---- Light ----

/**
 * Supported color modes for light entities. Determines which color controls appear in the HA UI.
 *
 * - `'onoff'` — On/off only, no brightness or color control.
 * - `'brightness'` — Brightness control (0–255), no color.
 * - `'color_temp'` — Color temperature in mireds or Kelvin.
 * - `'hs'` — Hue/saturation color model.
 * - `'rgb'` — Red/green/blue color model.
 * - `'rgbw'` — RGB + dedicated white channel.
 * - `'rgbww'` — RGB + cold white + warm white channels.
 * - `'xy'` — CIE 1931 xy chromaticity color model.
 * - `'white'` — Dedicated white-only mode with brightness.
 */
export type ColorMode =
  | 'onoff'
  | 'brightness'
  | 'color_temp'
  | 'hs'
  | 'rgb'
  | 'rgbw'
  | 'rgbww'
  | 'xy'
  | 'white';

/** MQTT discovery configuration for light entities. */
export interface LightConfig {
  /** Color modes this light supports. Determines available UI controls. */
  supported_color_modes: ColorMode[];
  /** List of named effects (e.g. `['rainbow', 'pulse']`). */
  effect_list?: string[];
  /** Minimum color temperature in Kelvin (e.g. `2000`). */
  min_color_temp_kelvin?: number;
  /** Maximum color temperature in Kelvin (e.g. `6500`). */
  max_color_temp_kelvin?: number;
}

/**
 * Command received from HA when a user interacts with a light entity.
 * Contains the desired state and any color/brightness parameters.
 */
export interface LightCommand {
  /** Desired power state. */
  state: 'ON' | 'OFF';
  /** Brightness level (0–255). */
  brightness?: number;
  /** Color temperature in mireds. */
  color_temp?: number;
  /** RGB color as an object. */
  color?: { r: number; g: number; b: number };
  /** Color temperature in Kelvin. */
  color_temp_kelvin?: number;
  /** Hue/saturation color as `[hue, saturation]`. */
  hs_color?: [number, number];
  /** CIE xy color as `[x, y]`. */
  xy_color?: [number, number];
  /** RGB color as `[r, g, b]` (0–255 each). */
  rgb_color?: [number, number, number];
  /** RGBW color as `[r, g, b, w]`. */
  rgbw_color?: [number, number, number, number];
  /** RGBWW color as `[r, g, b, cold_w, warm_w]`. */
  rgbww_color?: [number, number, number, number, number];
  /** White channel brightness (0–255). */
  white?: number;
  /** Named effect to activate. */
  effect?: string;
  /** Transition time in seconds. */
  transition?: number;
}

/** Current state of a light entity published to HA. */
export interface LightState {
  /** Power state. */
  state: 'on' | 'off';
  /** Current brightness level (0–255). */
  brightness?: number;
  /** Active color mode. */
  color_mode?: ColorMode;
  /** Current color temperature in mireds. */
  color_temp?: number;
  /** Current color temperature in Kelvin. */
  color_temp_kelvin?: number;
  /** Current hue/saturation. */
  hs_color?: [number, number];
  /** Current CIE xy color. */
  xy_color?: [number, number];
  /** Current RGB color. */
  rgb_color?: [number, number, number];
  /** Current RGBW color. */
  rgbw_color?: [number, number, number, number];
  /** Current RGBWW color. */
  rgbww_color?: [number, number, number, number, number];
  /** Currently active effect name. */
  effect?: string;
}

/** Entity definition for a controllable light with optional color and brightness support. */
export interface LightDefinition extends BaseEntity<LightState, LightConfig> {
  type: 'light';
  /**
   * Called when HA sends a command to this light (turn on/off, change color, etc.).
   * @param command - The light command with desired state and parameters.
   */
  onCommand(this: EntityContext<LightState>, command: LightCommand): void | Promise<void>;
}

// ---- Cover ----

/**
 * Device class for cover entities. Determines the default icon
 * and open/close semantics in the HA UI.
 */
export type CoverDeviceClass =
  | 'awning'
  | 'blind'
  | 'curtain'
  | 'damper'
  | 'door'
  | 'garage'
  | 'gate'
  | 'shade'
  | 'shutter'
  | 'window';

/** MQTT discovery configuration for cover entities. */
export interface CoverConfig {
  /** Cover device class — determines icon and open/close labels in HA. */
  device_class?: CoverDeviceClass;
  /** Whether this cover supports position control (0–100). */
  position?: boolean;
  /** Whether this cover supports tilt control (0–100). */
  tilt?: boolean;
}

/**
 * Command received from HA when a user interacts with a cover entity.
 * Discriminated union on the `action` field.
 */
export type CoverCommand =
  | { action: 'open' }
  | { action: 'close' }
  | { action: 'stop' }
  | { action: 'set_position'; position: number }
  | { action: 'set_tilt'; tilt: number };

/**
 * Possible states for a cover entity.
 *
 * - `'open'` — Fully open.
 * - `'opening'` — Currently opening (transitioning).
 * - `'closed'` — Fully closed.
 * - `'closing'` — Currently closing (transitioning).
 * - `'stopped'` — Stopped mid-travel (neither fully open nor closed).
 */
export type CoverState = 'open' | 'opening' | 'closed' | 'closing' | 'stopped';

/** Entity definition for a controllable cover (blind, garage door, etc.). */
export interface CoverDefinition extends BaseEntity<CoverState, CoverConfig> {
  type: 'cover';
  /**
   * Called when HA sends a command to this cover.
   * @param command - The cover command (open, close, stop, set_position, set_tilt).
   */
  onCommand(this: EntityContext<CoverState>, command: CoverCommand): void | Promise<void>;
}

// ---- Climate ----

/**
 * HVAC operating modes for climate entities.
 *
 * - `'off'` — System is off.
 * - `'heat'` — Heating only.
 * - `'cool'` — Cooling only.
 * - `'heat_cool'` — Dual-setpoint heating and cooling (auto-switch).
 * - `'auto'` — Device determines heating/cooling automatically.
 * - `'dry'` — Dehumidification mode.
 * - `'fan_only'` — Fan circulation only, no heating or cooling.
 */
export type HVACMode = 'off' | 'heat' | 'cool' | 'heat_cool' | 'auto' | 'dry' | 'fan_only';

/** MQTT discovery configuration for climate entities. */
export interface ClimateConfig {
  /** Supported HVAC modes for this climate device. */
  hvac_modes: HVACMode[];
  /** Supported fan speed modes (e.g. `['low', 'medium', 'high']`). */
  fan_modes?: string[];
  /** Supported preset modes (e.g. `['home', 'away', 'boost']`). */
  preset_modes?: string[];
  /** Supported swing modes (e.g. `['on', 'off']`). */
  swing_modes?: string[];
  /** Minimum settable temperature. */
  min_temp?: number;
  /** Maximum settable temperature. */
  max_temp?: number;
  /** Temperature increment step. */
  temp_step?: number;
  /** Temperature unit — `'C'` for Celsius, `'F'` for Fahrenheit. */
  temperature_unit?: 'C' | 'F';
}

/**
 * Command received from HA when a user interacts with a climate entity.
 * All fields are optional — only changed values are sent.
 */
export interface ClimateCommand {
  /** Target HVAC mode. */
  hvac_mode?: HVACMode;
  /** Target temperature. */
  temperature?: number;
  /** Upper bound for dual-setpoint mode. */
  target_temp_high?: number;
  /** Lower bound for dual-setpoint mode. */
  target_temp_low?: number;
  /** Target fan mode. */
  fan_mode?: string;
  /** Target swing mode. */
  swing_mode?: string;
  /** Target preset mode. */
  preset_mode?: string;
}

/** Current state of a climate entity published to HA. */
export interface ClimateState {
  /** Current HVAC operating mode. */
  mode: HVACMode;
  /** Current measured temperature from the device's sensor. */
  current_temperature?: number;
  /** Target temperature setpoint. */
  temperature?: number;
  /** Upper target temperature for dual-setpoint mode. */
  target_temp_high?: number;
  /** Lower target temperature for dual-setpoint mode. */
  target_temp_low?: number;
  /** Current fan mode. */
  fan_mode?: string;
  /** Current swing mode. */
  swing_mode?: string;
  /** Current preset mode. */
  preset_mode?: string;
  /** Current HVAC action — what the device is actually doing right now. */
  action?: 'off' | 'heating' | 'cooling' | 'drying' | 'idle' | 'fan';
}

/** Entity definition for a climate device (thermostat, AC, etc.). */
export interface ClimateDefinition extends BaseEntity<ClimateState, ClimateConfig> {
  type: 'climate';
  /**
   * Called when HA sends a command to this climate device.
   * @param command - The climate command with changed settings.
   */
  onCommand(this: EntityContext<ClimateState>, command: ClimateCommand): void | Promise<void>;
}

// ---- Fan ----

/** MQTT discovery configuration for fan entities. */
export interface FanConfig {
  /** List of preset fan modes (e.g. `['auto', 'smart', 'sleep']`). */
  preset_modes?: string[];
  /** Minimum speed percentage (default: 1). */
  speed_range_min?: number;
  /** Maximum speed percentage (default: 100). */
  speed_range_max?: number;
}

/**
 * Command received from HA when a user interacts with a fan entity.
 * All fields are optional — only changed values are sent.
 */
export interface FanCommand {
  /** Desired power state. */
  state?: 'ON' | 'OFF';
  /** Speed percentage (0–100). */
  percentage?: number;
  /** Target preset mode. */
  preset_mode?: string;
  /** Oscillation state. */
  oscillation?: 'oscillate_on' | 'oscillate_off';
  /** Fan direction. */
  direction?: 'forward' | 'reverse';
}

/** Current state of a fan entity published to HA. */
export interface FanState {
  /** Power state. */
  state: 'on' | 'off';
  /** Current speed percentage (0–100). */
  percentage?: number;
  /** Current preset mode. */
  preset_mode?: string;
  /** Current oscillation state. */
  oscillation?: 'on' | 'off';
  /** Current direction. */
  direction?: 'forward' | 'reverse';
}

/** Entity definition for a controllable fan. */
export interface FanDefinition extends BaseEntity<FanState, FanConfig> {
  type: 'fan';
  /**
   * Called when HA sends a command to this fan.
   * @param command - The fan command with desired state and parameters.
   */
  onCommand(this: EntityContext<FanState>, command: FanCommand): void | Promise<void>;
}

// ---- Lock ----

/** MQTT discovery configuration for lock entities. */
export interface LockConfig {
  /** Regex pattern for code validation (e.g. `'^\\d{4,6}$'` for 4–6 digit PIN). */
  code_format?: string;
}

/** Commands that can be sent to a lock entity. */
export type LockCommand = 'LOCK' | 'UNLOCK' | 'OPEN';

/**
 * Possible states for a lock entity.
 *
 * - `'locked'` — Fully locked.
 * - `'locking'` — Currently locking (transitioning).
 * - `'unlocked'` — Fully unlocked.
 * - `'unlocking'` — Currently unlocking (transitioning).
 * - `'jammed'` — Lock is jammed and unable to operate.
 */
export type LockState = 'locked' | 'locking' | 'unlocked' | 'unlocking' | 'jammed';

/** Entity definition for a controllable lock. */
export interface LockDefinition extends BaseEntity<LockState, LockConfig> {
  type: 'lock';
  /**
   * Called when HA sends a command to this lock.
   * @param command - `'LOCK'`, `'UNLOCK'`, or `'OPEN'`.
   */
  onCommand(this: EntityContext<LockState>, command: LockCommand): void | Promise<void>;
}

// ---- Number ----

/**
 * Device class for number entities.
 *
 * @see https://developers.home-assistant.io/docs/core/entity/number/#available-device-classes
 */
export type NumberDeviceClass =
  | 'apparent_power'
  | 'aqi'
  | 'atmospheric_pressure'
  | 'battery'
  | 'carbon_dioxide'
  | 'carbon_monoxide'
  | 'current'
  | 'data_rate'
  | 'data_size'
  | 'distance'
  | 'duration'
  | 'energy'
  | 'energy_storage'
  | 'frequency'
  | 'gas'
  | 'humidity'
  | 'illuminance'
  | 'irradiance'
  | 'moisture'
  | 'monetary'
  | 'nitrogen_dioxide'
  | 'nitrogen_monoxide'
  | 'nitrous_oxide'
  | 'ozone'
  | 'ph'
  | 'pm1'
  | 'pm10'
  | 'pm25'
  | 'power'
  | 'power_factor'
  | 'precipitation'
  | 'precipitation_intensity'
  | 'pressure'
  | 'reactive_power'
  | 'signal_strength'
  | 'sound_pressure'
  | 'speed'
  | 'sulphur_dioxide'
  | 'temperature'
  | 'volatile_organic_compounds'
  | 'volatile_organic_compounds_parts'
  | 'voltage'
  | 'volume'
  | 'volume_flow_rate'
  | 'volume_storage'
  | 'water'
  | 'weight'
  | 'wind_speed';

/** MQTT discovery configuration for number entities. */
export interface NumberConfig {
  /** Number device class — determines icon and default unit in HA. */
  device_class?: NumberDeviceClass;
  /** Minimum value (default: 1). */
  min?: number;
  /** Maximum value (default: 100). */
  max?: number;
  /** Step size (default: 1, minimum: 0.001). */
  step?: number;
  /** Unit of measurement displayed alongside the value. */
  unit_of_measurement?: string;
  /** Display mode — `'auto'`, `'box'`, or `'slider'`. */
  mode?: 'auto' | 'box' | 'slider';
}

/** Entity definition for a numeric input entity. */
export interface NumberDefinition extends BaseEntity<number, NumberConfig> {
  type: 'number';
  /**
   * Called when HA sends a new value to this number entity.
   * @param command - The new numeric value.
   */
  onCommand(this: EntityContext<number>, command: number): void | Promise<void>;
}

// ---- Select ----

/** MQTT discovery configuration for select entities. */
export interface SelectConfig {
  /** List of selectable options. Required. */
  options: string[];
}

/** Entity definition for a dropdown selection entity. */
export interface SelectDefinition extends BaseEntity<string, SelectConfig> {
  type: 'select';
  /**
   * Called when HA sends a new selection to this select entity.
   * @param command - The selected option string.
   */
  onCommand(this: EntityContext<string>, command: string): void | Promise<void>;
}

// ---- Text ----

/** MQTT discovery configuration for text entities. */
export interface TextConfig {
  /** Minimum text length (default: 0). */
  min?: number;
  /** Maximum text length (default: 255). */
  max?: number;
  /** Regex pattern for input validation. */
  pattern?: string;
  /** Display mode — `'text'` or `'password'`. */
  mode?: 'text' | 'password';
}

/** Entity definition for a text input entity. */
export interface TextDefinition extends BaseEntity<string, TextConfig> {
  type: 'text';
  /**
   * Called when HA sends new text to this text entity.
   * @param command - The new text value.
   */
  onCommand(this: EntityContext<string>, command: string): void | Promise<void>;
}

// ---- Button ----

/**
 * Device class for button entities.
 *
 * @see https://developers.home-assistant.io/docs/core/entity/button/#available-device-classes
 */
export type ButtonDeviceClass = 'identify' | 'restart' | 'update';

/** MQTT discovery configuration for button entities. */
export interface ButtonConfig {
  /** Button device class — determines icon in HA. */
  device_class?: ButtonDeviceClass;
}

/** Entity definition for a momentary button entity (command only, no state). */
export interface ButtonDefinition extends BaseEntity<never, ButtonConfig> {
  type: 'button';
  /**
   * Called when the button is pressed in HA.
   */
  onPress(this: EntityContext<never>): void | Promise<void>;
}

// ---- Siren ----

/** MQTT discovery configuration for siren entities. */
export interface SirenConfig {
  /** List of available alarm tones. */
  available_tones?: string[];
  /** Whether the siren supports setting duration. */
  support_duration?: boolean;
  /** Whether the siren supports setting volume (0–1). */
  support_volume_set?: boolean;
}

/**
 * Command received from HA when a user interacts with a siren entity.
 */
export interface SirenCommand {
  /** Desired power state. */
  state: 'ON' | 'OFF';
  /** Selected tone name. */
  tone?: string;
  /** Duration in seconds. */
  duration?: number;
  /** Volume level (0.0–1.0). */
  volume_level?: number;
}

/** Entity definition for a siren/alarm entity. */
export interface SirenDefinition extends BaseEntity<'on' | 'off', SirenConfig> {
  type: 'siren';
  /**
   * Called when HA sends a command to this siren.
   * @param command - The siren command with desired state and parameters.
   */
  onCommand(this: EntityContext<'on' | 'off'>, command: SirenCommand): void | Promise<void>;
}

// ---- Humidifier ----

/**
 * Device class for humidifier entities.
 */
export type HumidifierDeviceClass = 'humidifier' | 'dehumidifier';

/** MQTT discovery configuration for humidifier entities. */
export interface HumidifierConfig {
  /** Device class — `'humidifier'` or `'dehumidifier'`. */
  device_class?: HumidifierDeviceClass;
  /** Minimum target humidity (default: 0). */
  min_humidity?: number;
  /** Maximum target humidity (default: 100). */
  max_humidity?: number;
  /** Supported operating modes. */
  modes?: string[];
}

/**
 * Command received from HA when a user interacts with a humidifier entity.
 * All fields are optional — only changed values are sent.
 */
export interface HumidifierCommand {
  /** Desired power state. */
  state?: 'ON' | 'OFF';
  /** Target humidity percentage. */
  humidity?: number;
  /** Target operating mode. */
  mode?: string;
}

/** Current state of a humidifier entity published to HA. */
export interface HumidifierState {
  /** Power state. */
  state: 'on' | 'off';
  /** Current target humidity. */
  humidity?: number;
  /** Current operating mode. */
  mode?: string;
  /** Current measured humidity. */
  current_humidity?: number;
  /** Current action — what the device is actually doing. */
  action?: 'off' | 'humidifying' | 'drying' | 'idle';
}

/** Entity definition for a humidifier/dehumidifier entity. */
export interface HumidifierDefinition extends BaseEntity<HumidifierState, HumidifierConfig> {
  type: 'humidifier';
  /**
   * Called when HA sends a command to this humidifier.
   * @param command - The humidifier command with desired state and parameters.
   */
  onCommand(this: EntityContext<HumidifierState>, command: HumidifierCommand): void | Promise<void>;
}

// ---- Valve ----

/**
 * Device class for valve entities.
 */
export type ValveDeviceClass = 'gas' | 'water';

/** MQTT discovery configuration for valve entities. */
export interface ValveConfig {
  /** Valve device class — determines icon in HA. */
  device_class?: ValveDeviceClass;
  /** Whether this valve reports numeric position (0–100). */
  reports_position?: boolean;
}

/**
 * Command received from HA when a user interacts with a valve entity.
 * Discriminated union on the `action` field.
 */
export type ValveCommand =
  | { action: 'open' }
  | { action: 'close' }
  | { action: 'stop' }
  | { action: 'set_position'; position: number };

/**
 * Possible states for a valve entity.
 */
export type ValveState = 'open' | 'opening' | 'closed' | 'closing' | 'stopped';

/** Entity definition for a controllable valve. */
export interface ValveDefinition extends BaseEntity<ValveState, ValveConfig> {
  type: 'valve';
  /**
   * Called when HA sends a command to this valve.
   * @param command - The valve command (open, close, stop, set_position).
   */
  onCommand(this: EntityContext<ValveState>, command: ValveCommand): void | Promise<void>;
}

// ---- Water Heater ----

/**
 * Operating modes for water heater entities.
 */
export type WaterHeaterMode = 'off' | 'eco' | 'electric' | 'gas' | 'heat_pump' | 'high_demand' | 'performance';

/** MQTT discovery configuration for water heater entities. */
export interface WaterHeaterConfig {
  /** Supported operating modes. */
  modes: WaterHeaterMode[];
  /** Minimum settable temperature. */
  min_temp?: number;
  /** Maximum settable temperature. */
  max_temp?: number;
  /** Temperature precision (e.g. `0.1` or `1.0`). */
  precision?: number;
  /** Temperature unit — `'C'` for Celsius, `'F'` for Fahrenheit. */
  temperature_unit?: 'C' | 'F';
}

/**
 * Command received from HA when a user interacts with a water heater entity.
 * All fields are optional — only changed values are sent.
 */
export interface WaterHeaterCommand {
  /** Target operating mode. */
  mode?: WaterHeaterMode;
  /** Target temperature. */
  temperature?: number;
}

/** Current state of a water heater entity published to HA. */
export interface WaterHeaterState {
  /** Current operating mode. */
  mode: WaterHeaterMode;
  /** Target temperature. */
  temperature?: number;
  /** Current measured temperature. */
  current_temperature?: number;
}

/** Entity definition for a water heater entity. */
export interface WaterHeaterDefinition extends BaseEntity<WaterHeaterState, WaterHeaterConfig> {
  type: 'water_heater';
  /**
   * Called when HA sends a command to this water heater.
   * @param command - The water heater command with changed settings.
   */
  onCommand(this: EntityContext<WaterHeaterState>, command: WaterHeaterCommand): void | Promise<void>;
}

// ---- Vacuum ----

/** MQTT discovery configuration for vacuum entities. */
export interface VacuumConfig {
  /** List of supported fan speed levels. */
  fan_speed_list?: string[];
}

/** Commands that can be sent to a vacuum entity. */
export type VacuumCommand =
  | { action: 'start' }
  | { action: 'pause' }
  | { action: 'stop' }
  | { action: 'return_to_base' }
  | { action: 'clean_spot' }
  | { action: 'locate' }
  | { action: 'set_fan_speed'; fan_speed: string };

/**
 * Possible states for a vacuum entity.
 */
export type VacuumState = 'cleaning' | 'docked' | 'paused' | 'idle' | 'returning' | 'error';

/** Entity definition for a robot vacuum entity. */
export interface VacuumDefinition extends BaseEntity<VacuumState, VacuumConfig> {
  type: 'vacuum';
  /**
   * Called when HA sends a command to this vacuum.
   * @param command - The vacuum command.
   */
  onCommand(this: EntityContext<VacuumState>, command: VacuumCommand): void | Promise<void>;
}

// ---- Lawn Mower ----

/** Commands that can be sent to a lawn mower entity. */
export type LawnMowerCommand = 'start_mowing' | 'pause' | 'dock';

/**
 * Possible activity states for a lawn mower entity.
 */
export type LawnMowerActivity = 'mowing' | 'paused' | 'docked' | 'error';

/** Entity definition for a robotic lawn mower entity. */
export interface LawnMowerDefinition extends BaseEntity<LawnMowerActivity> {
  type: 'lawn_mower';
  /**
   * Called when HA sends a command to this lawn mower.
   * @param command - `'start_mowing'`, `'pause'`, or `'dock'`.
   */
  onCommand(this: EntityContext<LawnMowerActivity>, command: LawnMowerCommand): void | Promise<void>;
}

// ---- Alarm Control Panel ----

/** MQTT discovery configuration for alarm control panel entities. */
export interface AlarmControlPanelConfig {
  /** Whether a code is required to arm. */
  code_arm_required?: boolean;
  /** Whether a code is required to disarm. */
  code_disarm_required?: boolean;
  /** Whether a code is required to trigger. */
  code_trigger_required?: boolean;
}

/** Commands that can be sent to an alarm control panel entity. */
export type AlarmControlPanelCommand =
  | 'ARM_HOME'
  | 'ARM_AWAY'
  | 'ARM_NIGHT'
  | 'ARM_VACATION'
  | 'ARM_CUSTOM_BYPASS'
  | 'DISARM'
  | 'TRIGGER';

/**
 * Possible states for an alarm control panel entity.
 */
export type AlarmControlPanelState =
  | 'disarmed'
  | 'armed_home'
  | 'armed_away'
  | 'armed_night'
  | 'armed_vacation'
  | 'armed_custom_bypass'
  | 'pending'
  | 'triggered'
  | 'arming'
  | 'disarming';

/** Entity definition for a security alarm control panel entity. */
export interface AlarmControlPanelDefinition extends BaseEntity<AlarmControlPanelState, AlarmControlPanelConfig> {
  type: 'alarm_control_panel';
  /**
   * Called when HA sends a command to this alarm panel.
   * @param command - The alarm command (e.g. `'ARM_HOME'`, `'DISARM'`).
   */
  onCommand(this: EntityContext<AlarmControlPanelState>, command: AlarmControlPanelCommand): void | Promise<void>;
}

// ---- Notify ----

/** Entity definition for a notification target entity (write-only). */
export interface NotifyDefinition extends BaseEntity<never> {
  type: 'notify';
  /**
   * Called when a notification is sent to this entity.
   * @param message - The notification message text.
   */
  onNotify(this: EntityContext<never>, message: string): void | Promise<void>;
}

// ---- Update ----

/**
 * Device class for update entities.
 *
 * @see https://developers.home-assistant.io/docs/core/entity/update/#available-device-classes
 */
export type UpdateDeviceClass = 'firmware';

/** MQTT discovery configuration for update entities. */
export interface UpdateConfig {
  /** Update device class. */
  device_class?: UpdateDeviceClass;
}

/** Current state of an update entity published to HA (JSON). */
export interface UpdateState {
  /** Currently installed version string. */
  installed_version: string | null;
  /** Latest available version string. */
  latest_version: string | null;
  /** Update title/name. */
  title?: string;
  /** Release summary/changelog. */
  release_summary?: string;
  /** URL to full release notes. */
  release_url?: string;
  /** URL to entity picture/icon. */
  entity_picture?: string;
}

/** Entity definition for an update availability indicator entity. */
export interface UpdateDefinition extends BaseEntity<UpdateState, UpdateConfig> {
  type: 'update';
  /**
   * Called when HA requests installation of the update.
   */
  onInstall?(this: EntityContext<UpdateState>): void | Promise<void>;
}

// ---- Image ----

/** MQTT discovery configuration for image entities. */
export interface ImageConfig {
  /** Content type of the image (default: `'image/jpeg'`). */
  content_type?: string;
}

/** Entity definition for a static image entity. State is the image URL. */
export interface ImageDefinition extends BaseEntity<string, ImageConfig> {
  type: 'image';
}

/** Union of all supported entity definition types. */
export type EntityDefinition =
  | SensorDefinition
  | ComputedDefinition
  | BinarySensorDefinition
  | SwitchDefinition
  | LightDefinition
  | CoverDefinition
  | ClimateDefinition
  | FanDefinition
  | LockDefinition
  | NumberDefinition
  | SelectDefinition
  | TextDefinition
  | ButtonDefinition
  | SirenDefinition
  | HumidifierDefinition
  | ValveDefinition
  | WaterHeaterDefinition
  | VacuumDefinition
  | LawnMowerDefinition
  | AlarmControlPanelDefinition
  | NotifyDefinition
  | UpdateDefinition
  | ImageDefinition;

/**
 * A function that returns an array of entity definitions.
 * Use `entityFactory()` to create one when you need dynamic entity creation.
 */
export type EntityFactory = () => EntityDefinition[] | Promise<EntityDefinition[]>;

// ---- Automation ----

/**
 * Context bound as `this` inside an automation's `init()` and `destroy()` callbacks.
 * Like `EntityContext` but without state publishing (`update`, `attr`, `poll`).
 */
export type AutomationContext = Omit<EntityContext, 'update' | 'attr' | 'poll'>;

/**
 * A pure reactive script with managed lifecycle. No HA entity created by default.
 * Created by the `automation()` factory function.
 */
export interface AutomationDefinition {
  /** Discriminant for loader detection. */
  __kind: 'automation';
  /** Unique automation identifier. */
  id: string;
  /** Optional: surface as a `binary_sensor` in HA (ON = running, OFF = errored). */
  entity?: boolean;
  /** Called once when the automation is deployed. Set up subscriptions and reactive logic. */
  init(this: AutomationContext): void | Promise<void>;
  /** Called when the automation is torn down. Use for cleanup beyond auto-tracked handles. */
  destroy?(this: AutomationContext): void | Promise<void>;
}

// ---- Task ----

/**
 * Context bound as `this` inside a task's `run()` callback.
 * Minimal context: HA API, logging, and raw MQTT. No event subscriptions or timers.
 */
export type TaskContext = Pick<EntityContext, 'ha' | 'log' | 'mqtt'>;

/**
 * A one-shot script surfaced as a button entity in HA.
 * Created by the `task()` factory function.
 */
export interface TaskDefinition {
  /** Discriminant for loader detection. */
  __kind: 'task';
  /** Unique task identifier. Becomes the button entity's object_id. */
  id: string;
  /** Human-readable name shown in the HA UI. */
  name: string;
  /** Also execute `run()` on deploy (default: button-only). */
  runOnDeploy?: boolean;
  /** Optional device to group the button entity under. */
  device?: DeviceInfo;
  /** MDI icon override (e.g. `'mdi:play'`). */
  icon?: string;
  /** Called when the button is pressed (or on deploy if `runOnDeploy` is true). */
  run(this: TaskContext): void | Promise<void>;
}

// ---- Device ----

/**
 * Handle for updating an entity's state from within a device's `init()`.
 * @typeParam TState - The entity's state type.
 */
export interface DeviceEntityHandle<TState> {
  /** Publish a new state value for this entity. */
  update(value: TState, attributes?: Record<string, unknown>): void;
}

/**
 * Handle for a bidirectional entity (switch, light, cover, climate) within a device.
 * Adds `onCommand()` registration to the base handle.
 */
export interface DeviceCommandEntityHandle<TState, TCommand> extends DeviceEntityHandle<TState> {
  /** Register a command handler for this entity. */
  onCommand(handler: (command: TCommand) => void | Promise<void>): void;
}

/**
 * Maps an entity definition type to its device handle type.
 * Sensors get update-only handles; bidirectional entities also get onCommand.
 */
export type EntityHandleFor<T extends EntityDefinition> =
  T extends SwitchDefinition ? DeviceCommandEntityHandle<'on' | 'off', 'ON' | 'OFF'> :
  T extends LightDefinition ? DeviceCommandEntityHandle<LightState, LightCommand> :
  T extends CoverDefinition ? DeviceCommandEntityHandle<CoverState, CoverCommand> :
  T extends ClimateDefinition ? DeviceCommandEntityHandle<ClimateState, ClimateCommand> :
  T extends FanDefinition ? DeviceCommandEntityHandle<FanState, FanCommand> :
  T extends LockDefinition ? DeviceCommandEntityHandle<LockState, LockCommand> :
  T extends NumberDefinition ? DeviceCommandEntityHandle<number, number> :
  T extends SelectDefinition ? DeviceCommandEntityHandle<string, string> :
  T extends TextDefinition ? DeviceCommandEntityHandle<string, string> :
  T extends SirenDefinition ? DeviceCommandEntityHandle<'on' | 'off', SirenCommand> :
  T extends HumidifierDefinition ? DeviceCommandEntityHandle<HumidifierState, HumidifierCommand> :
  T extends ValveDefinition ? DeviceCommandEntityHandle<ValveState, ValveCommand> :
  T extends WaterHeaterDefinition ? DeviceCommandEntityHandle<WaterHeaterState, WaterHeaterCommand> :
  T extends VacuumDefinition ? DeviceCommandEntityHandle<VacuumState, VacuumCommand> :
  T extends LawnMowerDefinition ? DeviceCommandEntityHandle<LawnMowerActivity, LawnMowerCommand> :
  T extends AlarmControlPanelDefinition ? DeviceCommandEntityHandle<AlarmControlPanelState, AlarmControlPanelCommand> :
  T extends SensorDefinition ? DeviceEntityHandle<string | number> :
  T extends BinarySensorDefinition ? DeviceEntityHandle<'on' | 'off'> :
  T extends UpdateDefinition ? DeviceEntityHandle<UpdateState> :
  T extends ImageDefinition ? DeviceEntityHandle<string> :
  DeviceEntityHandle<unknown>;

/**
 * Context bound as `this` inside a device's `init()` and `destroy()` callbacks.
 * Provides typed entity handles, managed timers, MQTT access,
 * HA API (`this.ha`), and lifecycle-managed event subscriptions (`this.events`).
 */
export interface DeviceContext<TEntities extends Record<string, EntityDefinition>> {
  /** Typed handles for updating each entity in the device. */
  entities: { [K in keyof TEntities]: EntityHandleFor<TEntities[K]> };
  /**
   * Stateless HA API — safe to pass to utility functions.
   * Provides callService, getState, getEntities, fireEvent, friendlyName.
   */
  ha: StatelessHAApi;
  /**
   * Scoped event subscriptions — automatically cleaned up when this device is torn down.
   * Use `this.events.on()` for state change subscriptions and `this.events.reactions()` for declarative rules.
   */
  events: EventsContext;
  /**
   * Start a managed polling loop. Fires immediately, then repeats on interval.
   * Uses chained timeouts to prevent overlapping executions.
   * Unlike entity poll(), this does NOT auto-update a state — call
   * `this.entities.xxx.update()` inside the callback.
   * @param fn - Function to call each interval.
   * @param opts - Polling options.
   */
  poll(fn: () => void | Promise<void>, opts: { interval: number; initialDelay?: number }): void;
  /** Scoped logger for this device. Messages include the device ID and source file automatically. */
  log: EntityLogger;
  /**
   * Schedule a one-shot callback. Automatically cleared on device teardown.
   * @param fn - Callback to execute.
   * @param ms - Delay in milliseconds.
   */
  setTimeout(fn: () => void, ms: number): void;
  /**
   * Schedule a repeating callback. Automatically cleared on device teardown.
   * @param fn - Callback to execute.
   * @param ms - Interval in milliseconds.
   */
  setInterval(fn: () => void, ms: number): void;
  /**
   * Direct MQTT publish/subscribe access for custom topics.
   * Subscriptions are automatically cleaned up on device teardown.
   */
  mqtt: {
    /**
     * Publish a message to an MQTT topic.
     * @param topic - The MQTT topic to publish to.
     * @param payload - The message payload as a string.
     * @param opts - Publish options.
     */
    publish(topic: string, payload: string, opts?: { retain?: boolean }): void;
    /**
     * Subscribe to an MQTT topic. The subscription is auto-cleaned on device teardown.
     * @param topic - The MQTT topic to subscribe to (supports wildcards).
     * @param handler - Called with the message payload for each received message.
     */
    subscribe(topic: string, handler: (payload: string) => void): void;
  };
}

/**
 * Options for defining a device with grouped entities.
 * @typeParam TEntities - Map of entity keys to entity definitions.
 */
export interface DeviceOptions<TEntities extends Record<string, EntityDefinition>> {
  /** Unique device identifier. */
  id: string;
  /** Human-readable device name shown in the HA UI. */
  name: string;
  /** Device manufacturer. */
  manufacturer?: string;
  /** Device model. */
  model?: string;
  /** Software/firmware version. */
  sw_version?: string;
  /** Suggested area to assign this device to. */
  suggested_area?: string;
  /** Map of entity keys to entity definitions. */
  entities: TEntities;
  /** Called once when the device is deployed. Set up polling, subscriptions, and command handlers. */
  init(this: DeviceContext<TEntities>): void | Promise<void>;
  /** Called when the device is torn down. Use for cleanup beyond auto-tracked handles. */
  destroy?(this: DeviceContext<TEntities>): void | Promise<void>;
}

/**
 * A device definition that groups multiple entities with a shared lifecycle.
 * Created by the `device()` factory function.
 */
export interface DeviceDefinition<TEntities extends Record<string, EntityDefinition> = Record<string, EntityDefinition>> {
  /** Discriminant for loader detection. */
  __kind: 'device';
  /** Unique device identifier. */
  id: string;
  /** Human-readable device name shown in the HA UI. */
  name: string;
  /** Device manufacturer. */
  manufacturer?: string;
  /** Device model. */
  model?: string;
  /** Software/firmware version. */
  sw_version?: string;
  /** Suggested area to assign this device to. */
  suggested_area?: string;
  /** Map of entity keys to entity definitions. */
  entities: TEntities;
  /** Called once when the device is deployed. */
  init(this: DeviceContext<TEntities>): void | Promise<void>;
  /** Called when the device is torn down. */
  destroy?(this: DeviceContext<TEntities>): void | Promise<void>;
}
