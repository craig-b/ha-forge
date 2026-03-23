# Signal Simulation & Visualization

Test behavior chains (debounce, filter, throttle) without real devices. Define synthetic signals that shadow real entity IDs, preview how operator chains transform them, and tune parameters before deploying.

## The Problem

You've written a sensor with `.debounce(5000).distinctUntilChanged()` — but does it actually filter the noise you expect? Without real devices you can't tell, and with real devices the feedback loop is slow.

## `simulate()` — Define a Synthetic Signal

`simulate()` creates a source-only definition that the runtime skips during deploy. It shadows a real entity ID so the web editor can match it to stream subscriptions.

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
