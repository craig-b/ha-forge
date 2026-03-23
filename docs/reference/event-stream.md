# Event Stream Reference

> For usage examples, see the [Reactive Patterns guide](../guide/reactive.md).

An `EventStream` is a composable, chainable event pipeline returned by `this.events.stream()`. The stream is **lazy** -- no listener is registered until `.subscribe()` is called. Operators transform the stream and return a new `EventStream`, enabling fluent chaining. `.subscribe()` terminates the chain, registers the listener, and returns a `Subscription` handle for cleanup.

```ts
interface EventStream<TEvent extends StateChangedEvent = StateChangedEvent> {
  filter(predicate: (event: TEvent) => boolean): EventStream<TEvent>;
  map(transform: (event: TEvent) => TEvent): EventStream<TEvent>;
  debounce(ms: number): EventStream<TEvent>;
  throttle(ms: number): EventStream<TEvent>;
  distinctUntilChanged(): EventStream<TEvent>;
  onTransition(from: string | '*', to: string | '*'): EventStream<TEvent>;
  subscribe(callback: (event: TEvent) => void): Subscription;
}

interface Subscription {
  unsubscribe(): void;
}
```

---

## Creating Streams

### From entity subscriptions

The primary way to create an `EventStream` is via `this.events.stream()`:

```ts
// Subscribe to a specific entity
const sub = this.events.stream('light.kitchen')
  .subscribe((event) => { /* ... */ });

// Subscribe to a domain
const sub = this.events.stream('light')
  .subscribe((event) => { /* ... */ });

// Subscribe to multiple entities
const sub = this.events.stream(['light.kitchen', 'light.bedroom'])
  .subscribe((event) => { /* ... */ });

// With operators before subscribe
const sub = this.events.stream('binary_sensor.motion')
  .debounce(5000)
  .subscribe((event) => {
    this.ha.callService('light.hallway', 'turn_on');
  });
```

### From withState

`this.events.withState()` returns a `Subscription`:

```ts
const sub = this.events.withState(
  'binary_sensor.motion',
  ['sensor.lux'],
  (event, states) => {
    if (Number(states['sensor.lux'].state) < 50) {
      this.ha.callService('light.hallway', 'turn_on');
    }
  },
);
```

### Internal: createEventStream()

The SDK exports `createEventStream()` for advanced use (typically not needed in user code):

```ts
const stream = createEventStream(
  (cb) => {
    // Register callback, return unsubscribe function
    return someSubscription(cb);
  },
  (event) => {
    // Optional initial callback
  },
);
```

---

## Operators

Operators are applied in reading order (left to right). The chain `.filter().debounce()` means: filter first, then debounce the filtered events.

All operators return a new `EventStream` for fluent chaining. Operators build up an internal processor pipeline and are evaluated in order for each incoming event. The stream is lazy -- no listener is registered until `.subscribe()` is called at the end of the chain.

### filter(predicate)

Skip events that don't match a predicate.

```ts
filter(predicate: (event: TEvent) => boolean): EventStream<TEvent>
```

| Parameter | Type | Description |
|---|---|---|
| `predicate` | `(event: TEvent) => boolean` | Return `true` to keep the event, `false` to skip it. |

**Behavior:** Events that fail the predicate are dropped entirely — they do not reach downstream operators or the final callback.

```ts
this.events.stream('sensor.temperature')
  .filter(e => Number(e.new_state) > 30)
  .subscribe((e) => { /* only events above 30 */ });
```

### map(transform)

Transform the event before passing it to downstream handlers.

```ts
map(transform: (event: TEvent) => TEvent): EventStream<TEvent>
```

| Parameter | Type | Description |
|---|---|---|
| `transform` | `(event: TEvent) => TEvent` | Function that receives the event and returns a modified event. |

**Behavior:** The returned event replaces the original for all downstream operators and the final callback.

```ts
this.events.stream('sensor.temperature')
  .map(e => ({
    ...e,
    new_state: String(Math.round(Number(e.new_state))),
  }))
  .subscribe((e) => { /* e.new_state is rounded */ });
```

### debounce(ms)

Wait for the event to stabilize. Only fires after no new events arrive for the specified duration. Useful for sustained state detection (e.g., "motion stays on for 30 seconds").

```ts
debounce(ms: number): EventStream<TEvent>
```

| Parameter | Type | Description |
|---|---|---|
| `ms` | `number` | Debounce window in milliseconds. |

**Behavior:**

- When an event arrives, any pending timer is cancelled and a new timer is started.
- The event only reaches downstream if no new event arrives within `ms` milliseconds.
- Only the most recent event is forwarded — earlier events within the window are discarded.
- Internal timers are tracked and cleaned up on stream disposal.

```ts
// Only react if motion stays on for 30 seconds
this.events.stream('binary_sensor.motion')
  .filter(e => e.new_state === 'on')
  .debounce(30_000)
  .subscribe((e) => { /* motion sustained for 30s */ });
```

### throttle(ms)

Limit event rate. Fires at most once per interval.

```ts
throttle(ms: number): EventStream<TEvent>
```

| Parameter | Type | Description |
|---|---|---|
| `ms` | `number` | Throttle interval in milliseconds. |

**Behavior:**

- The first event passes immediately.
- Subsequent events within `ms` milliseconds are dropped.
- After the interval expires, the next event passes through and the interval resets.
- No timers are used — this is a simple timestamp comparison (`Date.now()`).

```ts
// At most one update per second
this.events.stream('sensor.rapidly_updating')
  .throttle(1000)
  .subscribe((e) => { /* at most once per second */ });
```

### distinctUntilChanged()

Skip events where `new_state` hasn't changed from the previous event. Useful for filtering out attribute-only updates.

```ts
distinctUntilChanged(): EventStream<TEvent>
```

**Behavior:**

- Tracks the `new_state` value of the last event that passed through.
- If `event.new_state` equals the previously seen value, the event is dropped.
- The first event always passes through.
- Comparison is by string identity (`===`).

```ts
// Only fire when the state value actually changes
this.events.stream('sensor.humidity')
  .distinctUntilChanged()
  .subscribe((e) => { /* only genuine state changes */ });
```

### onTransition(from, to)

Only fire when the entity transitions between specific states.

```ts
onTransition(from: string | '*', to: string | '*'): EventStream<TEvent>
```

| Parameter | Type | Description |
|---|---|---|
| `from` | `string \| '*'` | Previous state value. `'*'` matches any state. |
| `to` | `string \| '*'` | New state value. `'*'` matches any state. |

**Behavior:**

- Checks `event.old_state` against `from` and `event.new_state` against `to`.
- Both must match for the event to pass through.
- `'*'` is a wildcard that matches any value.

```ts
// Fire only when a door opens
this.events.stream('binary_sensor.front_door')
  .onTransition('off', 'on')
  .subscribe(() => { /* door opened */ });

// Fire on any transition away from 'home'
this.events.stream('input_select.house_mode')
  .onTransition('home', '*')
  .subscribe(() => { /* left home mode */ });

// Fire on any transition to 'off'
this.events.stream('switch.pump')
  .onTransition('*', 'off')
  .subscribe(() => { /* pump turned off */ });
```

---

## Cleanup

### Subscription.unsubscribe()

`.subscribe()` returns a `Subscription` with an `unsubscribe()` method. Calling it cancels the subscription and cleans up all internal timers and the base event listener.

```ts
const sub = this.events.stream('sensor.temperature')
  .filter(e => Number(e.new_state) > 30)
  .subscribe((e) => { /* ... */ });

// Later, to cancel:
sub.unsubscribe();
```

**Behavior:**

- Marks the subscription as disposed -- no further events are processed.
- Clears all internal timers (debounce pending timers).
- Calls the base unsubscribe function to remove the HA event listener.
- Safe to call multiple times (idempotent).

### Automatic cleanup

When using `this.events.stream()` inside entity callbacks, the subscription's unsubscribe function is automatically registered with the entity's lifecycle tracker. On entity teardown:

1. The entity's `destroy()` callback is called (if defined) for explicit cleanup.
2. The runtime force-disposes all tracked handles: timers, intervals, poll refs, MQTT subscriptions, and event subscriptions (including subscription unsubscribes).

You do NOT need to manually call `.unsubscribe()` on subscriptions created via `this.events`. However, if you need to dynamically remove a subscription before entity teardown, `.unsubscribe()` is available on the `Subscription` object.

---

## Operator Order Matters

Operators are applied in the order they are chained. This affects behavior significantly:

### filter before debounce

```ts
this.events.stream('binary_sensor.motion')
  .filter(e => e.new_state === 'on')     // 1. Only pass 'on' events
  .debounce(30_000)                      // 2. Wait 30s with no 'on' events
  .subscribe((e) => { /* ... */ });
```

The debounce only sees `'on'` events. If motion goes `on -> off -> on` within 30 seconds, the debounce timer resets on the second `'on'`, but the `'off'` event is invisible. The callback fires 30 seconds after the last `'on'`.

### debounce before filter

```ts
this.events.stream('binary_sensor.motion')
  .debounce(30_000)                       // 1. Wait 30s with no events at all
  .filter(e => e.new_state === 'on')      // 2. Then check if it's 'on'
  .subscribe((e) => { /* ... */ });
```

The debounce sees ALL events. If motion goes `on -> off` within 30 seconds, the timer resets on `'off'`. After 30 seconds of silence, the `'off'` event reaches the filter and is dropped. The callback only fires if the last event in a 30-second quiet period was `'on'`.

### throttle then map

```ts
this.events.stream('sensor.power')
  .throttle(5000)                         // 1. At most one event per 5s
  .map(e => ({ ...e, new_state: String(Math.round(Number(e.new_state))) }))
                                          // 2. Round the value
  .subscribe((e) => { /* ... */ });
```

Only one event per 5 seconds reaches the map. The rounded value reflects whichever event happened to be the first in each 5-second window.

### distinctUntilChanged then onTransition

```ts
this.events.stream('cover.garage')
  .distinctUntilChanged()                 // 1. Skip attribute-only updates
  .onTransition('open', 'closed')         // 2. Only fire on open -> closed
  .subscribe((e) => { /* ... */ });
```

Attribute-only updates (where state doesn't change) are filtered out first, so `onTransition` only sees genuine state changes.

---

## EventStream vs Behaviors

`EventStream` operators and behavior wrappers (`debounced()`, `filtered()`, `sampled()`, `buffered()`) serve different purposes:

| Feature | EventStream operators | Behavior wrappers |
|---|---|---|
| Applied to | HA event subscriptions (`this.events.stream()`) | Entity definitions (wraps a sensor/switch/etc.) |
| Scope | Transforms the event stream within an entity | Transforms the entity's state publishing behavior |
| Created by | Chaining `.filter()`, `.debounce()`, etc. | `debounced(entity, opts)`, `filtered(entity, opts)` |
| Use case | React to HA state changes with filtering/timing | Smooth or aggregate state values before publishing |

**EventStream** is for consuming events from other HA entities. **Behaviors** are for producing state values in your own entities.
