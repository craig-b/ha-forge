# Composable Behaviors

Behaviors are higher-order wrappers that modify how an entity publishes state. They intercept `this.update()` to add timing, filtering, or aggregation -- without changing the entity's core logic.

## Overview

| Behavior | What It Does | When to Use |
|---|---|---|
| `debounced` | Delays publish until updates stop for N ms | Bursty updates (PIR sensors, noisy readings) |
| `filtered` | Drops updates that fail a predicate | Invalid readings, dead-band filtering |
| `sampled` | Captures every update, publishes on a fixed interval | Rate-limiting high-frequency sources |
| `buffered` | Collects values, reduces on interval (avg, sum, etc.) | Aggregation, moving averages |

Import behaviors from `ha-forge`:

```typescript
import { sensor, debounced, filtered, sampled, buffered, average } from 'ha-forge';
```

## debounced

Delays publishing until updates stop arriving for `wait` milliseconds. If a new update arrives during the wait, the timer resets. Only the last value is published.

The first update always passes through immediately -- no initial dead time.

```typescript
export const temp = debounced(
  sensor({
    id: 'noisy_temp',
    name: 'Temperature',
    config: { device_class: 'temperature', unit_of_measurement: '°C' },
    init() {
      this.poll(async () => (await readSensor()).celsius, { interval: 1000 });
      return 0;
    },
  }),
  { wait: 5000 },
);
```

Best for bursty updates. If your entity polls on a fixed interval shorter than the debounce `wait`, updates will never settle and only the first value will be published. For continuous streams, use `sampled` instead.

## filtered

Calls the original `update()` only when `predicate(value, attributes)` returns `true`. No timers, no buffering -- purely synchronous gating.

```typescript
export const power = filtered(
  sensor({
    id: 'grid_power',
    name: 'Grid Power',
    config: { device_class: 'power', unit_of_measurement: 'W' },
    init() {
      this.poll(readCtClamp, { interval: 1000 });
      return 0;
    },
  }),
  (watts) => watts >= 0, // discard negative glitches from the CT clamp
);
```

## sampled

Captures the latest value on every `update()` call but only publishes to HA on a fixed interval. The first update publishes immediately.

```typescript
export const cpu = sampled(
  sensor({
    id: 'cpu_usage',
    name: 'CPU Usage',
    config: { unit_of_measurement: '%' },
    init() {
      this.poll(readCpuUsage, { interval: 1000 }); // poll every second
      return 0;
    },
  }),
  { interval: 60_000 }, // publish once per minute
);
```

Use when you want frequent internal updates but less frequent publishes to HA.

## buffered

Collects every value into a buffer. On each interval tick, calls `reduce(buffer)` and publishes the result. The buffer is cleared after each flush. Empty buffers are skipped.

```typescript
import { sensor, buffered, average } from 'ha-forge';

export const solarAvg = buffered(
  sensor({
    id: 'solar_avg',
    name: 'Solar Production (1min avg)',
    config: { device_class: 'power', unit_of_measurement: 'W', state_class: 'measurement' },
    init() {
      this.poll(readInverter, { interval: 2000 });
      return 0;
    },
  }),
  { interval: 60_000, reduce: average },
);
```

### Built-in Reducers

| Reducer | Result |
|---|---|
| `average` | Mean of buffered values |
| `sum` | Sum of buffered values |
| `min` | Minimum value |
| `max` | Maximum value |
| `last` | Last value in buffer |
| `count` | Number of values collected |

Or pass any custom function: `(values: any[]) => any`.

## Composition Order

Behaviors compose by nesting. The outermost wrapper processes the update first.

```typescript
debounced(filtered(sensor({...}), predicate), { wait: 500 })
//        ^-- update hits filtered first
// ^-- then debounced delays the publish
```

Order matters:

| Composition | Effect |
|---|---|
| `debounced(filtered(entity, pred), opts)` | Filter first, then debounce survivors. Rejected values do not reset the debounce timer. |
| `filtered(debounced(entity, opts), pred)` | Debounce first, then filter the debounced value. The timer runs regardless of the filter. |
| `filtered(sampled(entity, opts), pred)` | Sample at interval, then filter. Drop stale or invalid values post-sample. |
| `sampled(filtered(entity, pred), opts)` | Filter first, then sample survivors. The interval publishes the last value that passed the filter. |
| `debounced(buffered(entity, opts), opts2)` | Buffer and reduce, then debounce the reduced values. |

**Rule of thumb: filter early, time-shape late.** Discard bad data before it enters a buffer or debounce timer.

## Real-World Patterns

### Dead-Band Filtering

Noisy analog sensors jitter around the true value. A dead-band filter suppresses updates smaller than a threshold, reducing database writes without losing real changes.

```typescript
let lastPublished = 0;

export const stableTemp = filtered(
  sensor({
    id: 'stable_temp',
    name: 'Room Temperature',
    config: { device_class: 'temperature', unit_of_measurement: '°C' },
    init() {
      this.poll(readTempSensor, { interval: 5000 });
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

### PIR Debouncing

PIR sensors cycle off/on/off/on as someone sits still. Debouncing the "off" transition prevents automation flicker. The first "on" is instant -- subsequent rapid changes are held until 2 minutes of silence.

```typescript
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
  { wait: 120_000 },
);
```

### Rate-Limited API Polling

External APIs have quotas. Poll frequently, publish conservatively, drop failures.

```typescript
export const weather = filtered(
  sampled(
    sensor({
      id: 'outdoor_temp',
      name: 'Outdoor Temperature',
      config: { device_class: 'temperature', unit_of_measurement: '°C' },
      init() {
        this.poll(async () => {
          const r = await fetch('https://api.weather.example/current');
          if (!r.ok) return null as any;
          return (await r.json()).temperature;
        }, { interval: 30_000 });
        return 0;
      },
    }),
    { interval: 300_000 }, // publish at most every 5 minutes
  ),
  (v) => v !== null, // drop failed fetches
);
```

Order matters here. `sampled` wraps the sensor, capturing every poll result but forwarding only one per interval. `filtered` wraps sampled, dropping nulls before they reach HA. Reversing the order would filter before sampling -- nulls could become the "latest" value that sampled publishes.

### Appliance Finished Detection

Detecting when a washing machine finishes from raw wattage is unreliable because power fluctuates wildly during cycles. Buffering + debouncing smooths the signal.

```typescript
export const washerPower = debounced(
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
  { wait: 60_000 }, // stable for 60s = "done"
);
```

## Behaviors vs Stream Operators

Both shape data flow, but they operate on different sides:

- **Behaviors** (debounced, filtered, sampled, buffered) control **outgoing state** -- what gets published to HA via `this.update()`.
- **EventStream operators** (.filter(), .debounce(), .throttle(), etc.) control **incoming events** -- what triggers your entity's logic.

Use both when you need control over the full pipeline:

```typescript
export const doorCount = sampled(
  sensor({
    id: 'door_opens_hourly',
    name: 'Door Opens (per hour)',
    init() {
      let count = 0;
      this.events.on('binary_sensor.front_door', () => this.update(++count))
        .transition('off', 'on');  // incoming: only real open events

      this.poll(() => { count = 0; return 0; }, { cron: '0 0 * * *' });
      return 0;
    },
  }),
  { interval: 3_600_000 }, // outgoing: publish hourly snapshot
);
```

The `.transition()` operator filters the input (ignoring close events). The `sampled` behavior controls the output (publishing at most once per hour).

## Type Constraint

Behaviors accept stateful entity definitions -- entities that carry state and call `this.update()`. They cannot wrap:

- **`button`** -- command-only, no state
- **`notify`** -- write-only, no state

`computed` entities are fully compatible with behaviors -- they use `init()` + `this.update()` internally, so `buffered(computed({...}))` works as expected.

## Teardown

Behaviors use `this.setTimeout` / `this.setInterval`, which are lifecycle-managed. All timers are cleaned up automatically when the entity is torn down. If an entity is destroyed mid-debounce, the pending update is dropped.
