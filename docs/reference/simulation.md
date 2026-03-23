# Simulation API Reference

## `simulate(options)`

Creates a source-only simulation definition. The runtime skips these during deploy.

```ts
function simulate(options: SimulateOptions): SimulationDefinition
```

### SimulateOptions

| Property | Type | Description |
|----------|------|-------------|
| `id` | `string` | Unique simulation identifier |
| `shadows` | `string` | Real HA entity_id this simulation stands in for |
| `signal` | `SignalGenerator` | Function that generates synthetic events |

### SimulationDefinition

```ts
interface SimulationDefinition {
  __kind: 'simulate';
  id: string;
  shadows: string;
  signal: SignalGenerator;
}
```

## Signal Types

### SignalEvent

```ts
interface SignalEvent {
  t: number;          // Timestamp in milliseconds
  value: string | number;
}
```

### TimeRange

```ts
interface TimeRange {
  start: number;      // Start time in ms
  end: number;        // End time in ms
  stepMs: number;     // Step size in ms
}
```

### SignalGenerator

```ts
type SignalGenerator = (range: TimeRange) => SignalEvent[];
```

## `signals.*` — Signal Generators

### `signals.numeric(options)`

Returns a `SignalGenerator` producing numeric values with noise.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `base` | `number` | — | Center value |
| `noise` | `number` | — | Max noise amplitude (+/-) |
| `spikeTo` | `number` | — | Target value during spikes |
| `spikeChance` | `number` | `0` | Probability (0-1) per event |
| `dropoutEvery` | `number` | `0` | Insert `'unavailable'` every N events |
| `interval` | `number` | — | Milliseconds between events |
| `seed` | `number` | — | PRNG seed for reproducibility |

### `signals.binary(options)`

Returns a `SignalGenerator` producing `'on'`/`'off'` toggles.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `onDuration` | `[min, max]` | — | ON duration range in ms |
| `offDuration` | `[min, max]` | — | OFF duration range in ms |
| `falseRetrigger` | `number` | `0` | Probability of bounce within 500ms |
| `seed` | `number` | — | PRNG seed |

### `signals.enum(options)`

Returns a `SignalGenerator` cycling through named states.

| Option | Type | Description |
|--------|------|-------------|
| `states` | `string[]` | Possible state values |
| `dwellRange` | `[min, max]` | Dwell time range in ms |
| `seed` | `number` | PRNG seed |

### `signals.recorded(events)`

Returns a `SignalGenerator` that filters a fixed `SignalEvent[]` to the requested range.

## Simulation Engine

### `runSimulation(input, operators)`

Evaluates an operator chain against input events using a virtual clock.

```ts
function runSimulation(
  input: SignalEvent[],
  operators: OperatorDescriptor[],
): SimulationResult
```

### OperatorDescriptor

```ts
type OperatorDescriptor =
  | { type: 'debounce'; ms: number }
  | { type: 'throttle'; ms: number }
  | { type: 'distinctUntilChanged' }
  | { type: 'onTransition'; from: string; to: string }
  | { type: 'filter' }   // pass-through in v1
  | { type: 'map' }      // pass-through in v1
```

### SimulationResult

```ts
interface SimulationResult {
  input: SignalEvent[];
  output: SignalEvent[];
  stats: {
    inputCount: number;
    outputCount: number;
    passRate: number;          // outputCount / inputCount
    perOperator: OperatorStats[];
  };
}

interface OperatorStats {
  name: string;
  inputCount: number;
  outputCount: number;
}
```

### `runMultiEntitySimulation(inputs, operators)`

Merges events from multiple entities into a single timeline, then processes through the operator chain.

```ts
function runMultiEntitySimulation(
  inputs: Map<string, SignalEvent[]>,
  operators: OperatorDescriptor[],
): SimulationResult
```

### `runBehaviorSimulation(entity, input)`

Runs a behavior-wrapped entity (`debounced()`, `filtered()`, etc.) against simulated input using a mock `EntityContext` with virtual timers.

```ts
function runBehaviorSimulation(
  entity: StatefulEntityDefinition,
  input: SignalEvent[],
): SimulationResult
```
