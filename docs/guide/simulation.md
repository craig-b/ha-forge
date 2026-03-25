# Signal Simulation & Visualization

Test behavior chains (debounce, filter, throttle) without real devices. Define synthetic signals that shadow real entity IDs, preview how operator chains transform them, and tune parameters before deploying.

## The Problem

You've written a sensor with `.debounce(5000).distinctUntilChanged()` — but does it actually filter the noise you expect? Without real devices you can't tell, and with real devices the feedback loop is slow.

## `simulate()` — Define a Synthetic Signal

`simulate()` creates a source-only definition that the runtime skips during deploy. It shadows a real entity ID so the web editor can match it to stream subscriptions. The `shadows` field is typed as `HAEntityId` — you get autocomplete for every entity in your HA instance, and the compiler catches typos.

```ts
export const tempSim = simulate({
  id: 'temp_sim',
  shadows: 'sensor.living_room_temp',
  signal: signals.numeric({
    base: 22,
    noise: 1.5,
    spikeTo: 35,
    spikeChance: 0.05,
    interval: 10_000,
    seed: 42,
  }),
});
```

## Signal Primitives

All generators are deterministic (seeded PRNG) and pure — same seed produces same output.

### `signals.numeric(options)`

Generates numeric values with noise, optional spikes, and dropouts.

| Option | Type | Description |
|--------|------|-------------|
| `base` | `number` | Center value |
| `noise` | `number` | Max noise amplitude |
| `spikeTo` | `number?` | Value during spikes |
| `spikeChance` | `number?` | Probability (0-1) of spike per event |
| `dropoutEvery` | `number?` | Insert "unavailable" every N events |
| `interval` | `number` | Milliseconds between events |
| `seed` | `number` | PRNG seed |

### `signals.binary(options)`

Generates ON/OFF toggles with randomized durations.

| Option | Type | Description |
|--------|------|-------------|
| `onDuration` | `[min, max]` | ON duration range in ms |
| `offDuration` | `[min, max]` | OFF duration range in ms |
| `falseRetrigger` | `number?` | Probability of bounce-back within 500ms |
| `seed` | `number` | PRNG seed |

### `signals.enum(options)`

Cycles through named states with random dwell times.

| Option | Type | Description |
|--------|------|-------------|
| `states` | `string[]` | Possible state values |
| `dwellRange` | `[min, max]` | Dwell time range in ms |
| `seed` | `number` | PRNG seed |

### `signals.recorded(events)`

Replays a fixed array of `{ t, value }` events, filtered to the requested time range.

```ts
export const replaySim = simulate({
  id: 'replay_sim',
  shadows: 'sensor.power',
  signal: signals.recorded([
    { t: 0, value: 100 },
    { t: 5000, value: 250 },
    { t: 10000, value: 80 },
    { t: 15000, value: 300 },
  ]),
});
```

### `signals.sine(options)`

Generates a sine wave between `min` and `max`. Set `period` to twice the simulation duration for a single bell curve arch (starts at `min`, peaks at midpoint, returns to `min`).

| Option | Type | Description |
|--------|------|-------------|
| `min` | `number` | Trough value |
| `max` | `number` | Peak value |
| `period` | `number` | Duration of one full cycle in ms |
| `phase` | `number?` | Start position in cycle (0-1). 0 = rising from midpoint, 0.25 = at peak |
| `noise` | `number?` | Max noise amplitude |
| `interval` | `number` | Milliseconds between events |
| `seed` | `number` | PRNG seed |

### `signals.ramp(options)`

Generates a linear transition from one value to another. Stretches to fill whatever time range it receives -- a ramp from 0 to 100 produces different slopes depending on segment duration.

| Option | Type | Description |
|--------|------|-------------|
| `from` | `number` | Starting value |
| `to` | `number` | Ending value |
| `noise` | `number?` | Max noise amplitude |
| `interval` | `number` | Milliseconds between events |
| `seed` | `number` | PRNG seed |

### `signals.sequence(segments)`

Concatenates multiple signal generators in time. Each segment gets a `duration` and a `signal` generator. The generator receives a time range starting at 0, and timestamps are offset to the segment's position in the overall timeline.

```ts
// Ramp up, noisy plateau, ramp down
signals.sequence([
  { duration: 300_000,  signal: signals.ramp({ from: 0, to: 4500, noise: 50, interval: 5000, seed: 1 }) },
  { duration: 600_000,  signal: signals.numeric({ base: 4500, noise: 200, interval: 5000, seed: 2 }) },
  { duration: 300_000,  signal: signals.ramp({ from: 4500, to: 0, noise: 50, interval: 5000, seed: 3 }) },
])
```

| Segment Field | Type | Description |
|---------------|------|-------------|
| `duration` | `number` | Segment duration in ms |
| `signal` | `SignalGenerator` | Any signal generator |

## Using the Simulate Panel

1. Define one or more `simulate()` calls in any open file
2. Write a stream subscription chain referencing the shadowed entity:
   ```ts
   this.events.stream('sensor.living_room_temp')
     .debounce(5000)
     .distinctUntilChanged()
     .subscribe((event) => { ... });
   ```
3. Open the **Simulate** tab in the bottom panel
4. Select a simulation from the scenario picker
5. View side-by-side charts: raw signal vs. after operators
6. Check the stats bar for input/output counts and pass rates

## CodeLens & InlayHints

When simulations are defined:

- **CodeLens** on `simulate()` calls shows signal type, shadows target, and a Preview link
- **CodeLens** on matching `.stream()` chains shows available simulation count
- **InlayHints** after each operator show pass rates when results are available:
  ```
  .debounce(5000)  /* 72% pass */
  .throttle(1000)  /* 45% pass */
  ```

## Multi-Entity Simulation

When using `combine()` or `withState()`, define simulations for each referenced entity:

```ts
export const tempSim = simulate({
  id: 'temp_sim',
  shadows: 'sensor.temperature',
  signal: signals.numeric({ base: 22, noise: 2, interval: 5000, seed: 1 }),
});

export const humiditySim = simulate({
  id: 'humidity_sim',
  shadows: 'sensor.humidity',
  signal: signals.numeric({ base: 55, noise: 10, interval: 5000, seed: 2 }),
});
```

The panel warns when stream subscriptions reference entities without matching simulations.

## Workflow

1. **Define simulation** — create `simulate()` with appropriate signal type
2. **Preview** — check the Simulate panel for raw and transformed signals
3. **Tweak** — adjust operator parameters (debounce timing, etc.) based on stats
4. **Deploy** — simulations are automatically skipped by the runtime

## Limitations (v1)

- `filter()` and `map()` operators are **pass-through** in simulation — closures can't be serialized from AST
- Non-literal operator arguments (e.g., `debounce(config.delay)`) show as "unknown" and are skipped
- Entity-level behaviors (`debounced()`, `filtered()`) are simulated separately from stream operators
