# Composable Behaviors

Behaviors are higher-order wrappers that modify how an entity publishes state. They intercept `this.update()` inside `init()` to add timing, filtering, or aggregation logic — no runtime changes required.

Behaviors compose by nesting. The outermost wrapper runs first:

```typescript
debounced(filtered(sensor({...}), predicate), { wait: 500 })
//        └─ update hits filtered first
//  └─ then debounced delays the publish
```

All timer-based behaviors use `this.setTimeout` / `this.setInterval`, so timers are automatically cleaned up when the entity is torn down.

## API Reference

### `debounced(entity, { wait })`

Delays publishing until updates stop arriving for `wait` milliseconds. If a new update arrives during the wait, the timer resets. Only the last value is published. The first update always passes through immediately (no initial dead time).

**Important:** `debounced` is designed for bursty updates, not continuous streams. If your entity polls on a fixed interval shorter than the debounce `wait`, updates will never settle and only the first value will be published. For continuous streams, use `sampled` instead.

```typescript
import { sensor, debounced } from 'ha-forge';

export const temp = debounced(
  sensor({
    id: 'noisy_temp',
    name: 'Temperature',
    config: { device_class: 'temperature', unit_of_measurement: '°C' },
    init() {
      this.poll(async () => {
        const r = await fetch('http://sensor.local/temp');
        return (await r.json()).value;
      }, { interval: 1000 });
      return 0;
    },
  }),
  { wait: 5000 },
);
```

### `filtered(entity, predicate)`

Calls the original `update()` only when `predicate(value, attributes)` returns `true`. No timers, no buffering — purely synchronous gating.

```typescript
import { sensor, filtered } from 'ha-forge';

export const power = filtered(
  sensor({
    id: 'grid_power',
    name: 'Grid Power',
    config: { device_class: 'power', unit_of_measurement: 'W' },
    init() {
      this.poll(async () => { /* read CT clamp */ return 0; }, { interval: 1000 });
      return 0;
    },
  }),
  (watts) => watts >= 0, // discard negative glitches from the CT clamp
);
```

### `sampled(entity, { interval })`

Captures the latest value on every `update()` call but only publishes to HA on a fixed interval. The first update publishes immediately — no initial dead time.

```typescript
import { sensor, sampled } from 'ha-forge';

export const cpu = sampled(
  sensor({
    id: 'cpu_usage',
    name: 'CPU Usage',
    config: { unit_of_measurement: '%' },
    init() {
      this.poll(async () => {
        const r = await fetch('http://localhost:9100/metrics');
        return parseCpuUsage(await r.text());
      }, { interval: 1000 }); // internal: poll every second
      return 0;
    },
  }),
  { interval: 60_000 }, // external: publish once per minute
);
```

### `buffered(entity, { interval, reduce })`

Collects every value passed to `update()` into a buffer. On each interval tick, calls `reduce(buffer)` and publishes the result. The buffer is cleared after each flush. Ticks where the buffer is empty are skipped.

```typescript
import { sensor, buffered, average } from 'ha-forge';

export const solarAvg = buffered(
  sensor({
    id: 'solar_avg',
    name: 'Solar Production (1min avg)',
    config: { device_class: 'power', unit_of_measurement: 'W', state_class: 'measurement' },
    init() {
      this.poll(async () => { /* read inverter */ return 0; }, { interval: 2000 });
      return 0;
    },
  }),
  { interval: 60_000, reduce: average },
);
```

Built-in reducers: `average`, `sum`, `min`, `max`, `last`, `count`. Or pass any `(values: any[]) => any` function.

## Type Constraint

Behaviors accept `StatefulEntityDefinition` — the subset of entity definitions that carry state. This excludes:

- **`button`** — command-only, no state to intercept
- **`notify`** — write-only target, no state to intercept
- **`computed`** — declarative derivation, no `init()` to wrap

Wrapping a stateless entity is harmless at runtime (update is never called), but TypeScript will flag it.

## Patterns

### Dead-Band Filtering

Noisy analog sensors (temperature, humidity, power) jitter around the true value. A dead-band filter suppresses updates smaller than a threshold, cutting database writes without losing real changes.

```typescript
import { sensor, filtered } from 'ha-forge';

let lastPublished = 0;

export const stableTemp = filtered(
  sensor({
    id: 'stable_temp',
    name: 'Room Temperature',
    config: { device_class: 'temperature', unit_of_measurement: '°C' },
    init() {
      this.poll(async () => {
        const r = await fetch('http://sensor.local/api');
        return (await r.json()).temperature;
      }, { interval: 5000 });
      return 0;
    },
  }),
  (value) => {
    if (Math.abs(value - lastPublished) < 0.3) return false;
    lastPublished = value;
    return true;
  },
);
```

### Debounced Presence

PIR sensors go off/on/off/on as someone sits still. Debouncing the "off" transition prevents automation flicker.

```typescript
import { binarySensor, debounced } from 'ha-forge';

export const occupied = debounced(
  binarySensor({
    id: 'office_occupied',
    name: 'Office Occupied',
    config: { device_class: 'occupancy' },
    init() {
      this.events.on('binary_sensor.office_pir', (e) => {
        this.update(e.new_state as 'on' | 'off');
      }).filter((e) => e.new_state !== e.old_state);
      return 'off';
    },
  }),
  { wait: 120_000 }, // 2 minutes of silence before publishing "off"
);
```

Even with a 2-minute debounce, the first transition to "on" is instant — the first update always passes through. Subsequent rapid updates are debounced, so the "off" won't publish until 2 minutes of silence.

### Rate-Limited API Polling

External APIs have quotas. Poll aggressively internally, publish conservatively, and drop failures.

```typescript
import { sensor, filtered, sampled } from 'ha-forge';

export const weather = filtered(
  sampled(
    sensor({
      id: 'outdoor_temp',
      name: 'Outdoor Temperature',
      config: { device_class: 'temperature', unit_of_measurement: '°C' },
      init() {
        this.poll(async () => {
          const r = await fetch('https://api.weather.example/current?key=...');
          if (!r.ok) return null as any;
          return (await r.json()).temperature;
        }, { interval: 30_000 }); // poll every 30s
        return 0;
      },
    }),
    { interval: 300_000 }, // publish at most every 5 minutes
  ),
  (v) => v !== null, // silently drop failed fetches
);
```

The order matters. `sampled` wraps the sensor, capturing every poll result but only forwarding one per interval. `filtered` wraps sampled, dropping nulls before they reach HA. Reversing the order would filter before sampling — nulls from transient failures could become the "latest" value that sampled publishes.

### Appliance Finished Detection

A washing machine's power draw fluctuates wildly during a cycle: idle → wash → pause → spin → drain. Detecting "finished" from raw wattage is unreliable. Buffering + debouncing smooths the signal.

```typescript
import { sensor, debounced, buffered, average } from 'ha-forge';

export const washerState = debounced(
  buffered(
    sensor({
      id: 'washer_power_smoothed',
      name: 'Washer Power',
      config: { device_class: 'power', unit_of_measurement: 'W', state_class: 'measurement' },
      init() {
        this.events.on('sensor.washer_ct_clamp', (e) => {
          this.update(Number(e.new_state));
        });
        return 0;
      },
    }),
    { interval: 30_000, reduce: average }, // 30s moving average
  ),
  { wait: 60_000 }, // must be stable (idle) for 60s to count as "done"
);
```

Build an automation on top:

```typescript
import { automation } from 'ha-forge';

export const washerDone = automation({
  id: 'washer_done_notify',
  init() {
    this.events.on('sensor.washer_power_smoothed', () => {
        this.ha.callService('notify.mobile', 'send_message', {
          message: 'Washing machine has finished',
        });
      })
      .filter((e) => Number(e.old_state) > 10 && Number(e.new_state) <= 10);
  },
});
```

### Energy Dashboard Aggregation

CT clamps and smart plugs report instantaneous watts many times per second. The HA Energy dashboard needs clean periodic measurements, not a firehose.

```typescript
import { sensor, buffered, average, min, max } from 'ha-forge';

const ctClampSensor = (id: string, name: string) =>
  sensor({
    id,
    name,
    config: { device_class: 'power', unit_of_measurement: 'W', state_class: 'measurement' },
    init() {
      this.events.on(`sensor.${id}_raw` as any, (e) => {
        this.update(Number(e.new_state));
      });
      return 0;
    },
  });

// One-minute averages for the dashboard
export const gridAvg = buffered(ctClampSensor('grid_power', 'Grid Power'), {
  interval: 60_000,
  reduce: average,
});

// Peak wattage per minute — useful for demand monitoring
export const gridPeak = buffered(ctClampSensor('grid_peak', 'Grid Peak'), {
  interval: 60_000,
  reduce: max,
});
```

### Combining with Computed Entities

Behaviors modify how raw state is published. Computed entities derive new state from existing entities. They work on different layers and complement each other naturally.

```typescript
import { sensor, computed, debounced, filtered, sampled } from 'ha-forge';

// Layer 1: Raw sensor with dead-band filter
let lastHumidity = 0;
export const humidity = filtered(
  sensor({
    id: 'room_humidity',
    name: 'Room Humidity',
    config: { device_class: 'humidity', unit_of_measurement: '%' },
    init() {
      this.poll(async () => { /* read sensor */ return 50; }, { interval: 5000 });
      return 50;
    },
  }),
  (v) => {
    if (Math.abs(v - lastHumidity) < 1) return false;
    lastHumidity = v;
    return true;
  },
);

// Layer 2: Computed entity derives comfort index from temperature + humidity
export const comfort = computed({
  id: 'comfort_index',
  name: 'Comfort Index',
  config: { state_class: 'measurement' },
  watch: ['sensor.stable_temp', 'sensor.room_humidity'],
  compute: (states) => {
    const temp = Number(states['sensor.stable_temp']?.state ?? 20);
    const rh = Number(states['sensor.room_humidity']?.state ?? 50);
    // Simplified heat index
    return Math.round(temp + 0.5 * (rh - 40));
  },
});
```

The dead-band filter on humidity prevents the computed entity from re-evaluating on insignificant jitter. The computed entity's own debounce (default 100ms) coalesces cases where both temperature and humidity change in quick succession.

### Combining with Event Streams

The `this.events.on()` stream has its own `.debounce()`, `.throttle()`, `.filter()`, and `.distinctUntilChanged()` operators. These operate on *incoming events* — what triggers your entity's logic. Behaviors operate on *outgoing state* — what gets published. Use both when you need control over the full pipeline.

```typescript
import { sensor, sampled } from 'ha-forge';

export const doorActivity = sampled(
  sensor({
    id: 'door_activity_count',
    name: 'Door Opens (per hour)',
    init() {
      let count = 0;
      this.events.on('binary_sensor.front_door', () => this.update(++count))
        .transition('off', 'on');       // only real opens (event stream filter)

      // Reset at midnight
      this.poll(() => { count = 0; return 0; }, { cron: '0 0 * * *' });
      return 0;
    },
  }),
  { interval: 3_600_000 }, // publish hourly snapshot
);
```

The event stream's `.transition()` filters the *input* (ignoring close events and attribute-only changes). The `sampled` behavior controls the *output* (publishing at most once per hour even if the door opens 50 times).

### Combining with Reactions and Watchdogs

Behaviors don't interfere with the reactive system. A debounced sensor still fires state change events in HA — they're just less frequent. Watchdogs and reactions work on the published state, which is exactly what you want.

```typescript
import { sensor, debounced } from 'ha-forge';
import { automation } from 'ha-forge';

export const serverTemp = debounced(
  sensor({
    id: 'server_room_temp',
    name: 'Server Room Temperature',
    config: { device_class: 'temperature', unit_of_measurement: '°C' },
    init() {
      this.poll(async () => { /* read IPMI sensor */ return 22; }, { interval: 5000 });
      return 22;
    },
  }),
  { wait: 10_000 },
);

export const serverTempWatch = automation({
  id: 'server_temp_watch',
  init() {
    // Watchdog: alert if no update arrives for 2 minutes (sensor offline)
    this.events.watchdog({
      'sensor.server_room_temp': {
        within: 120_000,
        else: () => this.ha.callService('notify.ops', 'send_message', {
          message: 'Server room temperature sensor is offline!',
        }),
      },
    });

    // Reaction: alert on high temperature
    this.events.reactions({
      'sensor.server_room_temp': {
        when: (e) => Number(e.new_state) > 35,
        after: 30_000, // sustained for 30s
        do: () => this.ha.callService('notify.ops', 'send_message', {
          message: 'Server room temperature exceeds 35°C',
        }),
      },
    });
  },
});
```

Because the sensor is debounced, the watchdog's `within: 120_000` measures time between *published* updates, not raw polls. If the underlying sensor stops responding, the debounced wrapper stops calling update, and the watchdog fires.

## Composition Order

The outermost behavior processes the update first. Order matters:

| Composition | Behavior |
|---|---|
| `debounced(filtered(entity, pred), opts)` | Filter first, then debounce survivors. Rejected values don't reset the debounce timer. |
| `filtered(debounced(entity, opts), pred)` | Debounce first, then filter the debounced value. The debounce timer runs regardless of the filter. |
| `filtered(sampled(entity, opts), pred)` | Sample at interval, then filter. Nulls or stale values can be dropped post-sample. |
| `sampled(filtered(entity, pred), opts)` | Filter first, then sample survivors. The sample interval publishes the last value that passed the filter. |
| `debounced(buffered(entity, opts), opts2)` | Buffer and reduce, then debounce the reduced values. Useful when the reduce output itself is noisy. |

When in doubt: **filter early, time-shape late.** Discarding bad data before it enters a buffer or debounce timer gives the cleanest results.

## Destroy Behavior

Behaviors use `this.setTimeout` / `this.setInterval` which are lifecycle-managed — the runtime clears them automatically on teardown. The original entity's `destroy()` is preserved through the spread copy.

If an entity is torn down mid-debounce, the pending update is dropped. This is intentional — debounced values are best-effort, and publishing during teardown would race with the entity's removal from MQTT discovery.
