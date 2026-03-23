# Reactive Patterns

HA Forge provides a layered reactive API for responding to state changes in Home Assistant. All subscriptions created through `this.events` are lifecycle-managed -- they are automatically cleaned up when the entity is torn down on rebuild or shutdown.

## this.events.stream()

The primary subscription method. Available inside `init()` on all entity types that support events (sensor, binarySensor, switch, light, automation, device, and all other stateful entities). `.stream()` returns a lazy `EventStream` -- no listener is registered until `.subscribe()` is called.

### Basic Usage

```typescript
this.events.stream('binary_sensor.front_door')
  .subscribe((e) => {
    // e.entity_id: 'binary_sensor.front_door'
    // e.old_state: 'on' | 'off'
    // e.new_state: 'on' | 'off'
    // e.old_attributes, e.new_attributes: typed
    // e.timestamp: number
    if (e.new_state === 'on') {
      this.ha.callService('light.porch', 'turn_on');
    }
  });
```

### Overloads

```typescript
// Single entity -- callback typed to that entity
this.events.stream('light.living_room')
  .subscribe((e) => { /* ... */ });

// Domain -- fires for ALL entities in that domain
this.events.stream('light')
  .subscribe((e) => {
    // e.entity_id: 'light.living_room' | 'light.bedroom' | ...
  });

// Array of entities -- fires for any in the list
this.events.stream(['light.living_room', 'light.bedroom'])
  .subscribe((e) => { /* ... */ });
```

Entity IDs and domains autocomplete from your HA installation's type registry.

## EventStream Operators

`.stream()` returns a lazy `EventStream`. Operators transform or filter events before they reach the callback in `.subscribe()`, which terminates the chain and activates the listener.

### .filter(predicate)

Passes events only when the predicate returns true.

```typescript
this.events.stream('sensor.outdoor_temp')
  .filter((e) => Number(e.new_state) > 30)
  .subscribe((e) => {
    this.ha.callService('notify.mobile', 'send_message', {
      message: `Temperature is ${e.new_state}°C`,
    });
  });
```

### .map(transform)

Transforms the event before passing it downstream.

```typescript
this.events.stream('sensor.power_meter')
  .map((e) => ({ ...e, new_state: String(Math.round(Number(e.new_state))) }))
  .filter((e) => Number(e.new_state) > 1000)
  .subscribe((e) => {
    this.log.warn('High power draw', { watts: Number(e.new_state) });
  });
```

### .debounce(ms)

Waits for `ms` milliseconds of silence before passing the last event. Resets the timer on each new event.

```typescript
this.events.stream('sensor.temperature')
  .debounce(5000)
  .subscribe((e) => {
    // Only fires after temperature stops changing for 5 seconds
    this.update(Number(e.new_state));
  });
```

### .throttle(ms)

Passes at most one event per `ms` milliseconds. The first event passes immediately; subsequent events within the window are dropped.

```typescript
this.events.stream('sensor.energy_meter')
  .throttle(60_000)
  .subscribe((e) => {
    // At most one update per minute
    recordEnergyReading(Number(e.new_state));
  });
```

### .distinctUntilChanged()

Drops events where the new state equals the previous state. Useful for entities that fire attribute-only changes.

```typescript
this.events.stream('input_select.house_mode')
  .distinctUntilChanged()
  .subscribe((e) => {
    this.log.info('Mode changed', { from: e.old_state, to: e.new_state });
  });
```

### .onTransition(from, to)

Passes events only when the state transitions from one specific value to another. A shorthand for filtering on `old_state` and `new_state`. Accepts `'*'` as a wildcard for either side.

```typescript
this.events.stream('binary_sensor.front_door')
  .onTransition('off', 'on')
  .subscribe(() => {
    this.ha.callService('light.hallway', 'turn_on');
  });
```

### Subscription.unsubscribe()

`.subscribe()` returns a `Subscription` with `.unsubscribe()`. Tears down the subscription and all internal timers. Usually not needed -- subscriptions are automatically cleaned up when the entity is torn down.

### Chaining

Operators chain naturally. Order matters -- each operator processes the output of the previous one, and `.subscribe()` fires last.

```typescript
this.events.stream('sensor.power_meter')
  .filter((e) => Number(e.new_state) > 0)       // drop zero readings
  .throttle(10_000)                               // at most every 10s
  .distinctUntilChanged()                          // skip duplicates
  .subscribe((e) => this.update(Number(e.new_state)));
```

## Declarative Reactions

`this.events.reactions()` provides a declarative syntax for common patterns. Each key is an entity ID, and the value describes when and what to do.

```typescript
this.events.reactions({
  'binary_sensor.front_door': {
    to: 'on',
    do: () => this.ha.callService('light.porch', 'turn_on', { brightness: 255 }),
  },
  'sensor.bedroom_temp': {
    when: (e) => Number(e.new_state) > 25,
    do: () => this.ha.callService('climate.bedroom', 'set_temperature', { temperature: 22 }),
  },
  'switch.garage_door': {
    to: 'on',
    after: 600_000,  // 10 minutes
    do: () => {
      this.ha.callService('switch.garage_door', 'turn_off');
      this.ha.callService('notify.mobile', 'send_message', {
        message: 'Garage open 10 minutes, closing.',
      });
    },
  },
});
```

### Reaction Fields

- **`to`** -- Match when state equals this value. Typed to the entity's valid states.
- **`when`** -- Match when this predicate returns true. Receives the typed event.
- **`do`** -- The action to execute.
- **`after`** -- Delay in milliseconds. If the entity's state changes before the timer fires, the timer is cancelled automatically. This prevents stale reactions.

Use `to` for simple state matching. Use `when` for conditions like thresholds or complex logic.

## combine()

Watch multiple entities at once. The callback fires on any change and receives the current state snapshot of all watched entities.

```typescript
this.events.combine(
  ['sensor.indoor_temp', 'sensor.outdoor_temp', 'input_boolean.hvac_enabled'],
  (states) => {
    const indoor = Number(states['sensor.indoor_temp']?.state ?? 0);
    const outdoor = Number(states['sensor.outdoor_temp']?.state ?? 0);
    const enabled = states['input_boolean.hvac_enabled']?.state === 'on';

    if (enabled && indoor > 25 && outdoor < indoor) {
      this.ha.callService('switch.window_fan', 'turn_on');
    }
  },
);
```

## withState()

Subscribe to a trigger entity, but enrich the event with snapshots of additional context entities. Useful when you need to check conditions across multiple entities but only want to trigger on one.

```typescript
this.events.withState(
  'binary_sensor.motion_kitchen',          // trigger
  ['input_boolean.away_mode', 'light.kitchen'],  // context
  (event, states) => {
    const awayMode = states['input_boolean.away_mode']?.state === 'on';
    const lightOn = states['light.kitchen']?.state === 'on';

    if (event.new_state === 'on' && awayMode && !lightOn) {
      this.ha.callService('notify.mobile', 'send_message', {
        message: 'Motion detected in kitchen while away!',
      });
    }
  },
);
```

## watchdog()

Detects missing expected events within a time window. Fires the `else` handler if no matching event arrives within the deadline. The timer resets on each matching event.

```typescript
this.events.watchdog({
  'sensor.server_room_temp': {
    within: 120_000,  // expect an update every 2 minutes
    expect: 'change', // any state change resets the timer
    else: () => this.ha.callService('notify.ops', 'send_message', {
      message: 'Server room temperature sensor is offline!',
    }),
  },
});
```

### expect Options

- **`'change'`** -- Any state change resets the timer (default).
- **`{ to: value }`** -- Only a transition to a specific state resets the timer.
- **predicate function** -- A function `(event) => boolean` that determines whether the event counts.

```typescript
this.events.watchdog({
  'binary_sensor.heartbeat': {
    within: 30_000,
    expect: { to: 'on' },  // only 'on' events count
    else: () => this.log.error('Heartbeat missed'),
  },
});
```

## invariant()

Periodically checks a condition and fires a handler when it is violated. Unlike watchdog (which watches for missing events), invariant actively polls a condition.

```typescript
this.events.invariant({
  name: 'smoke_check',
  condition: async () => {
    const state = await this.ha.getState('binary_sensor.smoke_detector');
    return state?.state === 'off';  // true = condition holds
  },
  check: { interval: 60_000 },  // check every minute
  violated: () => {
    this.ha.callService('notify.emergency', 'send_message', {
      message: 'Smoke detected!',
    });
  },
});
```

The `check` field accepts a `ScheduleOptions` object: either `{ interval: number }` for a fixed polling interval, or `{ cron: string }` for a cron expression. Both support an optional `fireImmediately` flag to run the first check at startup.

## sequence()

Detects ordered events across multiple entities within a time window. All steps must occur in order, each within their time constraint, for the handler to fire.

```typescript
this.events.sequence({
  steps: [
    { entity: 'binary_sensor.front_door', to: 'on' },
    { entity: 'binary_sensor.hallway_motion', to: 'on', within: 30_000 },
    { entity: 'binary_sensor.living_room_motion', to: 'on', within: 60_000 },
  ],
  do: () => {
    this.log.info('Someone entered and walked to the living room');
    this.ha.callService('light.living_room', 'turn_on');
  },
});
```

The sequence resets if a step times out or the events arrive out of order.

### Negated Steps

A step with `negate: true` matches when the entity does *not* reach the target state within the time window. This requires `within` to be set. Useful for "X happened, but Y never followed" patterns:

```typescript
this.events.sequence({
  name: 'doorbell_then_no_answer',
  steps: [
    { entity: 'binary_sensor.doorbell', to: 'on' },
    { entity: 'lock.front_door', to: 'unlocked', within: 120_000, negate: true },
  ],
  do: () => this.ha.callService('notify.mobile', 'send_message', {
    message: 'Someone rang the doorbell and nobody answered',
  }),
});
```

## Where Each API is Available

| API | automation | sensor / switch / etc. | device | task |
|---|---|---|---|---|
| `this.events.stream()` | Yes | Yes | Yes | No |
| `this.events.reactions()` | Yes | Yes | Yes | No |
| `this.events.combine()` | Yes | Yes | Yes | No |
| `this.events.withState()` | Yes | Yes | Yes | No |
| `this.events.watchdog()` | Yes | Yes | Yes | No |
| `this.events.invariant()` | Yes | Yes | Yes | No |
| `this.events.sequence()` | Yes | Yes | Yes | No |
| `this.ha.callService()` | Yes | Yes | Yes | Yes |
| `this.update()` | No | Yes | Via entities | No |

`task` entities are one-shot scripts. They get `this.ha` and `this.log` but no `this.events` -- they are not designed for long-running subscriptions.

`automation` entities get the full reactive API but no `this.update()` (they have no state of their own, unless `entity: true` is set).

## this.ha (StatelessHAApi)

The `this.ha` object is a stateless API for querying and acting on Home Assistant. It provides `callService`, `getState`, `getEntities`, `fireEvent`, and `friendlyName`. It does **not** have subscription methods -- all event subscriptions go through `this.events`.
