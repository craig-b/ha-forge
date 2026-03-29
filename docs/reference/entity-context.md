# Entity Context API

> For a guided introduction, see the [Getting Started guide](../guide/getting-started.md) and [Entity Types guide](../guide/entities.md).

The entity context is bound as `this` inside entity lifecycle callbacks (`init()`, `destroy()`, `onCommand()`, `onPress()`, `onNotify()`, `onInstall()`). It provides methods for publishing state, polling, logging, timers, MQTT access, HA API access, and lifecycle-managed event subscriptions.

The TypeScript type is `EntityContext<TState, TAttrs>`, where `TState` is the entity's state type and `TAttrs` is the attributes type.

---

## this.update(value, attributes?)

Publish a new state value (and optional attributes) to Home Assistant via MQTT.

```ts
update(value: TState, attributes?: Partial<TAttrs>): void
```

**Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `value` | `TState` | Yes | The new state value. Type depends on the entity platform (see table below). |
| `attributes` | `Partial<TAttrs>` | No | Attributes to publish alongside the state. Merged with any existing static/computed attributes. |

**Platform state types:**

| Platform | `TState` |
|---|---|
| `sensor` | `string \| number` |
| `binary_sensor` | `'on' \| 'off'` |
| `switch` | `'on' \| 'off'` |
| `light` | `LightState` |
| `cover` | `CoverState` (`'open' \| 'opening' \| 'closed' \| 'closing' \| 'stopped'`) |
| `climate` | `ClimateState` |
| `fan` | `FanState` |
| `lock` | `LockState` (`'locked' \| 'locking' \| 'unlocked' \| 'unlocking' \| 'jammed'`) |
| `number` | `number` |
| `select` | `string` |
| `text` | `string` |
| `button` | `never` (no state) |
| `siren` | `'on' \| 'off'` |
| `humidifier` | `HumidifierState` |
| `valve` | `ValveState` (`'open' \| 'opening' \| 'closed' \| 'closing' \| 'stopped'`) |
| `water_heater` | `WaterHeaterState` |
| `vacuum` | `VacuumState` (`'cleaning' \| 'docked' \| 'paused' \| 'idle' \| 'returning' \| 'error'`) |
| `lawn_mower` | `LawnMowerActivity` (`'mowing' \| 'paused' \| 'docked' \| 'error'`) |
| `alarm_control_panel` | `AlarmControlPanelState` |
| `notify` | `never` (no state) |
| `update` | `UpdateState` |
| `image` | `string` (image URL) |

**Behavior:**

- Publishes to the entity's MQTT state topic.
- Clears the entity's failure counter on success.
- Notifies the runtime's internal state change tracker.

---

## this.attr(attributes)

Update attributes without changing the entity's state value. Re-publishes the current state with the new attributes.

```ts
attr(attributes: Partial<TAttrs>): void
```

**Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `attributes` | `Partial<TAttrs>` | Yes | Attributes to publish alongside the current (unchanged) state value. |

---

## this.poll(fn, opts)

Start a polling loop that calls `fn` on a schedule. If `fn` returns a value, it is automatically published via `update()`. Uses chained timeouts to prevent overlapping executions. Automatically cleaned up when the entity is destroyed.

```ts
// Interval-based
poll(fn: () => TState | Promise<TState>, opts: { interval: number; fireImmediately?: boolean }): void

// Cron-based
poll(fn: () => TState | Promise<TState>, opts: { cron: string; fireImmediately?: boolean }): void
```

**Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `fn` | `() => TState \| Promise<TState>` | Yes | Function to call each cycle. If it returns a value (not `undefined`), the return value is published as the new state via `update()`. If it returns `void`, you must call `this.update()` manually. |
| `opts.interval` | `number` | One of `interval` or `cron` required | Fixed interval in milliseconds between executions. |
| `opts.cron` | `string` | One of `interval` or `cron` required | 5-field cron expression (minute hour day-of-month month day-of-week). |
| `opts.fireImmediately` | `boolean` | No | When `true`, runs `fn` once immediately before starting the schedule. Default: `false`. |

**Behavior:**

- **Interval mode:** Waits for the first interval before firing, then chains `setTimeout` calls. Each execution completes before the next is scheduled — no overlap. Set `fireImmediately: true` to run once immediately before starting the interval.
- **Cron mode:** Parses the cron expression, calculates delay to the next matching time, and schedules via `setTimeout`. After each execution, re-calculates the next tick. Set `fireImmediately: true` to run once immediately before the first scheduled tick.
- **Error handling:** Errors in `fn` are caught, logged via `this.log.error()`, and the poll continues on the next cycle. After consecutive failures, the entity is marked unavailable via the MQTT availability topic. When a poll succeeds again, the failure counter is cleared.
- **Cleanup:** All poll timers are tracked and automatically disposed on entity teardown.

---

## this.log

Structured logger for this entity. Messages are stored in SQLite and visible in the web UI log viewer. Each message is automatically tagged with the entity's `entity_id` and `source_file`.

```ts
interface EntityLogger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}
```

**Parameters (all methods):**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `message` | `string` | Yes | The log message text. |
| `data` | `Record<string, unknown>` | No | Structured data stored as JSON in the `data` column. Useful for attaching stack traces, state snapshots, command payloads, etc. |

**Log levels:**

| Level | Description |
|---|---|
| `debug` | Verbose diagnostics. Only stored/visible when the add-on's `log_level` option is set to `debug`. |
| `info` | Normal operational messages. |
| `warn` | Potential issues that don't prevent operation. |
| `error` | Failures that need attention. |

---

## this.ha

Stateless HA API for calling services, querying state, listing entities, firing events, and looking up friendly names. This is the `StatelessHAApi` interface — it has no subscription methods (use `this.events` for those).

See [HA API Reference](ha-api.md) for the full API documentation.

```ts
interface StatelessHAApi {
  callService(entity: string, service: string, data?: Record<string, unknown>): Promise<Record<string, unknown> | null>;
  getState(entityId: string): Promise<{ state: string; attributes: Record<string, unknown>; last_changed: string; last_updated: string } | null>;
  getEntities(domain?: string): Promise<string[]>;
  fireEvent(eventType: string, eventData?: Record<string, unknown>): Promise<void>;
  friendlyName(entityId: string): string;
  history: HistoryApi;
}

interface HistoryApi {
  recentlyIn(entityId: string, state: string, opts: { within: number }): Promise<boolean>;
  average(entityId: string, opts: { over: number }): Promise<number | null>;
  countTransitions(entityId: string, opts: { to?: string; over: number }): Promise<number>;
  duration(entityId: string, state: string, opts: { over: number }): Promise<number>;
}
```

When generated types are available, entity IDs, service names, and service parameters are fully typed with autocomplete and compile-time validation.

---

## this.events

Scoped event subscription context. All subscriptions are automatically cleaned up when the owning entity is torn down.

See [Event Stream Reference](event-stream.md) for `EventStream` operators.

### this.events.stream(entityOrDomain)

Create a lazy `EventStream` for state changes on an entity, domain, or array of entities. No listener is registered until `.subscribe()` is called.

```ts
stream(entityOrDomain: string | string[]): EventStream
```

**Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `entityOrDomain` | `string \| string[]` | Yes | Entity ID (e.g. `'light.kitchen'`), domain name (e.g. `'light'`), or array of entity IDs. If the string contains a `.`, it's treated as an entity ID; otherwise as a domain. |

**Returns:** `EventStream` — lazy, chainable stream with `.filter()`, `.map()`, `.debounce()`, `.throttle()`, `.distinctUntilChanged()`, `.onTransition()`, and `.subscribe(callback)`. Call `.subscribe()` to activate the listener and get a `Subscription` back.

**StateChangedEvent:**

```ts
interface StateChangedEvent {
  entity_id: string;
  old_state: string;
  new_state: string;
  old_attributes: Record<string, unknown>;
  new_attributes: Record<string, unknown>;
  timestamp: number;  // Unix timestamp (ms)
}
```

With generated types, the event is narrowed to `TypedStateChangedEvent<TState, TAttrs, TEntityId>` with per-entity state and attribute types.

### this.events.reactions(rules)

Set up declarative reaction rules. Subscriptions and pending timers are automatically cleaned up.

```ts
reactions(rules: Record<string, ReactionRule>): () => void
```

**Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `rules` | `Record<string, ReactionRule>` | Yes | Map of entity IDs to reaction rules. |

**Returns:** Cleanup function.

**ReactionRule:**

```ts
interface ReactionRule {
  to?: string;
  when?: (event: StateChangedEvent) => boolean;
  do: () => void | Promise<void>;
  after?: number;
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `to` | `string` | No | Fire when entity transitions to this state value. |
| `when` | `(event: StateChangedEvent) => boolean` | No | Custom condition — return `true` to trigger. Mutually exclusive with `to` (if both are set, `to` takes priority). |
| `do` | `() => void \| Promise<void>` | Yes | Action to execute when the condition is met. |
| `after` | `number` | No | Delay in milliseconds before executing. Cancelled if the entity's state changes again before the timer fires. If the new state still matches, the timer restarts. |

If neither `to` nor `when` is specified, the rule fires on every state change.

### this.events.combine(entities, callback)

Subscribe to multiple entities and receive a combined state snapshot on every change.

```ts
combine<E extends string>(
  entities: E[],
  callback: (states: { [K in E]: EntitySnapshot | null }) => void,
): () => void
```

**Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `entities` | `E[]` | Yes | Array of entity IDs to watch. |
| `callback` | `(states: { [K in E]: EntitySnapshot \| null }) => void` | Yes | Called when any watched entity changes, with the current state of all watched entities. `null` if an entity's state is unknown. |

**Returns:** Cleanup function.

**EntitySnapshot:**

```ts
interface EntitySnapshot {
  state: string;
  attributes: Record<string, unknown>;
}
```

### this.events.withState(entityOrDomain, context, callback)

Subscribe to state changes with access to the current state of other entities. The callback is only invoked when all context entities are available and have valid state (not `'unavailable'` or `'unknown'`).

```ts
withState<C extends string>(
  entityOrDomain: string | string[],
  context: C[],
  callback: (event: StateChangedEvent, states: { [K in C]: EntitySnapshot }) => void,
): EventStream
```

**Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `entityOrDomain` | `string \| string[]` | Yes | Entity/domain/array to watch for changes (triggers the callback). |
| `context` | `C[]` | Yes | Entity IDs whose current state must be available. The callback is skipped if any context entity has no cached state or is `'unavailable'`/`'unknown'`. |
| `callback` | `(event, states) => void` | Yes | Called with the triggering event and a guaranteed-present state snapshot of all context entities. No null checks needed. |

**Returns:** `Subscription`.

### this.events.watchdog(rules)

Set up watchdog timers that fire when entities go silent. The timer resets on every matching state change. If no change arrives within the `within` window, the `else` handler fires. The timer then restarts, so `else` can fire repeatedly if silence continues.

```ts
watchdog<K extends string>(rules: Record<K, WatchdogRule>): () => void
```

**Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `rules` | `Record<K, WatchdogRule>` | Yes | Map of entity IDs to watchdog rules. |

**Returns:** Cleanup function.

**WatchdogRule:**

```ts
interface WatchdogRule {
  within: number;
  expect?: WatchdogExpect;
  else: () => void | Promise<void>;
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `within` | `number` | Yes | Maximum time in ms between state changes. If exceeded, `else` fires. |
| `expect` | `WatchdogExpect` | No | Which events reset the timer. Default: any state change. |
| `else` | `() => void \| Promise<void>` | Yes | Action to execute when the entity goes silent past the `within` window. |

**WatchdogExpect:**

```ts
type WatchdogExpect =
  | 'change'                              // Any state change (default)
  | { to: string }                        // Only when entity transitions to given state
  | ((event: StateChangedEvent) => boolean)  // Custom predicate
```

### this.events.invariant(options)

Set up a periodic invariant check. The condition is evaluated at the given schedule. When it returns `false`, the `violated` handler fires. The check continues running even after a violation.

```ts
// Interval-based
invariant(options: {
  name?: string;
  condition: () => boolean | Promise<boolean>;
  check: { interval: number };
  violated: () => void | Promise<void>;
}): () => void

// Cron-based
invariant(options: {
  name?: string;
  condition: () => boolean | Promise<boolean>;
  check: { cron: string };
  violated: () => void | Promise<void>;
}): () => void
```

**InvariantOptions fields:**

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | No | Human-readable name for logging and debugging. |
| `condition` | `() => boolean \| Promise<boolean>` | Yes | Returns `true` when the constraint holds, `false` when violated. |
| `check.interval` | `number` | One of `interval` or `cron` | Evaluation interval in milliseconds. |
| `check.cron` | `string` | One of `interval` or `cron` | 5-field cron expression for evaluation schedule. |
| `violated` | `() => void \| Promise<void>` | Yes | Action to execute when `condition()` returns `false`. |

**Returns:** Cleanup function.

### this.events.sequence(options)

Detect a sequence of state changes across entities. Steps must fire in order, each within their optional time window. When all steps complete, `do()` fires and the sequence resets. If a step times out, the sequence resets to step 0.

```ts
sequence(options: SequenceOptions): () => void
```

**SequenceOptions:**

```ts
interface SequenceOptions {
  name?: string;
  steps: SequenceStep[];
  do: () => void | Promise<void>;
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | No | Human-readable name for logging and debugging. |
| `steps` | `SequenceStep[]` | Yes | Ordered steps that must all match. |
| `do` | `() => void \| Promise<void>` | Yes | Action to execute when all steps complete in order. |

**SequenceStep:**

```ts
interface SequenceStep<TEntity extends string = string> {
  entity: TEntity;
  to: string | '*';
  within?: number;
  negate?: boolean;
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `entity` | `string` | Yes | Entity to watch for this step. |
| `to` | `string \| '*'` | Yes | State the entity must transition to. `'*'` matches any change. |
| `within` | `number` | No | Maximum time in ms to wait for this step. The first step has no timeout. If exceeded, the sequence resets. |
| `negate` | `boolean` | No | If `true`, the step matches when the entity does NOT reach the state within the `within` window. Requires `within`. Used for "absence of event" patterns (e.g., doorbell rang but nobody answered). |

**Returns:** Cleanup function.

---

## this.setTimeout / this.clearTimeout

Schedule a one-shot callback. Automatically cleared on entity teardown.

```ts
setTimeout(fn: () => void, ms: number): unknown
clearTimeout(handle: unknown): void
```

**Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `fn` | `() => void` | Yes | Callback to execute. |
| `ms` | `number` | Yes | Delay in milliseconds. |
| `handle` | `unknown` | Yes | The opaque handle returned by `setTimeout()`. |

**Returns:** An opaque handle that can be passed to `clearTimeout()`.

---

## this.setInterval / this.clearInterval

Schedule a repeating callback. Automatically cleared on entity teardown.

```ts
setInterval(fn: () => void, ms: number): unknown
clearInterval(handle: unknown): void
```

**Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `fn` | `() => void` | Yes | Callback to execute. |
| `ms` | `number` | Yes | Interval in milliseconds. |
| `handle` | `unknown` | Yes | The opaque handle returned by `setInterval()`. |

**Returns:** An opaque handle that can be passed to `clearInterval()`.

---

## this.mqtt

Direct MQTT publish/subscribe access for custom topics outside the entity's managed state/command topics. Subscriptions are automatically cleaned up on entity teardown.

### this.mqtt.publish(topic, payload, opts?)

```ts
publish(topic: string, payload: string, opts?: { retain?: boolean }): void
```

| Parameter | Type | Required | Description |
|---|---|---|---|
| `topic` | `string` | Yes | The MQTT topic to publish to. |
| `payload` | `string` | Yes | The message payload as a string. |
| `opts.retain` | `boolean` | No | If `true`, the broker retains this message for new subscribers. |

### this.mqtt.subscribe(topic, handler)

```ts
subscribe(topic: string, handler: (payload: string) => void): void
```

| Parameter | Type | Required | Description |
|---|---|---|---|
| `topic` | `string` | Yes | The MQTT topic to subscribe to. Supports MQTT wildcards (`+`, `#`). |
| `handler` | `(payload: string) => void` | Yes | Called with the message payload for each received message. |

The subscription is automatically cleaned up on entity teardown.

---

## Context Availability by Entity Type

Not all context methods are available on every entity type. The table below shows which methods exist on each context type.

| Method | `EntityContext` (sensor, switch, light, etc.) | `AutomationContext` | `TaskContext` | `ModeContext` | `DeviceContext` |
|---|---|---|---|---|---|
| `update()` | Yes | -- | -- | -- | -- (use `this.entities.xxx.update()`) |
| `attr()` | Yes | -- | -- | -- | -- |
| `poll()` | Yes | -- | -- | -- | Yes (void-only, no auto-update) |
| `log` | Yes | Yes | Yes | Yes | Yes |
| `ha` | Yes | Yes | Yes | Yes | Yes |
| `events` | Yes | Yes | -- | -- | Yes |
| `setTimeout()` / `clearTimeout()` | Yes | Yes | -- | -- | Yes |
| `setInterval()` / `clearInterval()` | Yes | Yes | -- | -- | Yes |
| `mqtt` | Yes | Yes | Yes | -- | Yes |
| `entities` | -- | -- | -- | -- | Yes |

### Context types by entity kind

| Entity Kind | Context Type | `this` bound in |
|---|---|---|
| `sensor`, `binary_sensor`, `switch`, `light`, `cover`, `climate`, `fan`, `lock`, `number`, `select`, `text`, `button`, `siren`, `humidifier`, `valve`, `water_heater`, `vacuum`, `lawn_mower`, `alarm_control_panel`, `notify`, `update`, `image` | `EntityContext<TState, TAttrs>` | `init()`, `destroy()`, `onCommand()`, `onPress()`, `onNotify()`, `onInstall()` |
| `computed` | `EntityContext<string \| number>` (generated `init()`) | `compute()` receives snapshots, `init()` is auto-generated |
| `automation` | `AutomationContext` = `Omit<EntityContext, 'update' \| 'attr' \| 'poll'>` | `init()`, `destroy()` |
| `task` | `TaskContext` = `Pick<EntityContext, 'ha' \| 'log' \| 'mqtt'>` | `run()` |
| `mode` | `ModeContext` = `Pick<EntityContext, 'ha' \| 'log'>` | `enter()`, `exit()`, `guard()` (transition hooks) |
| `cron` | No user context (declarative) | -- |
| `device` | `DeviceContext<TEntities>` | `init()`, `destroy()` |

### DeviceContext.entities handles

Inside `device()` init/destroy, `this.entities` provides typed handles for each member:

| Member Type | Handle Type | Methods |
|---|---|---|
| Standard entity (sensor, binary_sensor, image, update) | `DeviceEntityHandle<TState>` | `update(value, attributes?)` |
| Bidirectional entity (switch, light, cover, climate, fan, lock, number, select, text, siren, humidifier, valve, water_heater, vacuum, lawn_mower, alarm_control_panel) | `DeviceCommandEntityHandle<TState, TCommand>` | `update(value, attributes?)`, `onCommand(handler)` |
| `task` | `DeviceTaskHandle` | `trigger()` |
| `mode` | `DeviceModeHandle<TStates>` | `state` (readonly), `setState(state)` |
| `cron` | `DeviceCronHandle` | `isActive` (readonly) |
| `automation` | `DeviceAutomationHandle` | (empty) |

### DeviceContext.poll()

Unlike `EntityContext.poll()`, the device version does NOT auto-update state. It always takes a `void`-returning function. Use `this.entities.xxx.update()` inside the callback.

```ts
poll(fn: () => void | Promise<void>, opts: { interval: number; fireImmediately?: boolean }): void
poll(fn: () => void | Promise<void>, opts: { cron: string; fireImmediately?: boolean }): void
```
