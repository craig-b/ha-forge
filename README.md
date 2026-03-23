# HA Forge

A TypeScript runtime for Home Assistant. Define entities, compose reactive behaviors, and simulate them in the browser — deployed as an add-on with full type safety generated from your live HA instance.

```ts
export default device({
  id: 'greenhouse',
  name: 'Greenhouse',
  entities: {
    temp:     sensor({ id: 'temp', name: 'Temperature', config: { device_class: 'temperature', unit_of_measurement: '°C' } }),
    humidity: sensor({ id: 'humidity', name: 'Humidity', config: { device_class: 'humidity', unit_of_measurement: '%' } }),
    fan:      defineSwitch({ id: 'fan', name: 'Vent Fan' }),
    climate:  computed({
      id: 'climate', name: 'Climate',
      watch: ['sensor.temp', 'sensor.humidity'],
      compute: (s) => {
        const t = Number(s['sensor.temp']?.state), h = Number(s['sensor.humidity']?.state);
        return t > 30 || h > 80 ? 'Ventilate' : t < 10 ? 'Too cold' : 'Good';
      },
    }),
  },
  init() {
    this.poll(async () => {
      const data = await fetch('http://greenhouse.local/api').then(r => r.json());
      this.entities.temp.update(data.temperature);
      this.entities.humidity.update(data.humidity);
    }, { interval: 30_000 });

    this.events.stream('sensor.climate')
      .subscribe((e) => {
        this.entities.fan.update(e.new_state === 'Ventilate' ? 'on' : 'off');
      });
  },
});
```

## What this gives you

**Types generated from your HA instance** — Entity IDs, service calls, and parameter constraints are pulled from your live registry. Misspell an entity ID and the compiler tells you. Pass `brightness: 999` to a light and a `RangeError` is thrown before the call leaves the add-on.

**24 entity platforms** — sensor, switch, light, climate, cover, and 19 more via MQTT discovery. Plus higher-level constructs: `computed()` derived sensors, `mode()` state machines, `cron()` schedules, `automation()` reactive flows, `task()` one-shot actions, and `entityFactory()` for dynamic generation.

**Composable behaviors** — Wrap any entity with `debounced()`, `filtered()`, `sampled()`, or `buffered()` to control how state reaches HA. Compose them — order matters:

```ts
// Filter out jitter, then debounce the rest
export default debounced(
  filtered(
    sensor({ id: 'motion', name: 'Motion', config: { device_class: 'motion' } }),
    (value) => value !== 'unavailable',
  ),
  { wait: 5000 },
);
```

**Reactive event streams** — Chain operators on entity state changes with automatic lifecycle cleanup:

```ts
this.events.stream('sensor.temperature')
  .filter((e) => Number(e.new_state) > 30)
  .debounce(60_000)
  .subscribe((e) => {
    ha.callService('notify', 'mobile_app', { message: `Temperature hit ${e.new_state}°C` });
  });
```

**Simulate without hardware** — Define signal generators, run them against your behavior chains in the browser, and see exactly what gets through:

```ts
export const tempSim = simulate({
  id: 'temp_sim',
  shadows: 'sensor.living_room_temp',
  signal: signals.numeric({ base: 22, noise: 1.5, spikeTo: 35, spikeChance: 0.05, interval: 10_000, seed: 42 }),
});
```

The simulate panel shows raw signal vs. post-operator output side by side. CodeLens annotations show pass rates inline — tune your debounce timings and filter thresholds before deploying.

**Monaco editor in your browser** — IntelliSense, error squiggles, entity dashboard, dependency management, and log viewer — accessible from the HA sidebar with no setup.

## Installation

Requires the Mosquitto MQTT broker add-on.

1. Add the HA Forge repository to the add-on store
2. Install and start the add-on
3. Open from the HA sidebar — write your first entity and click Build

## Documentation

| | What | Start here |
|---|---|---|
| **Guide** | Installation, tutorials, patterns | [Getting Started](docs/guide/getting-started.md) |
| **Reference** | Full API, all options, every type | [Entity Context](docs/reference/entity-context.md) |
| **Architecture** | System internals, data flows | [Overview](docs/architecture/overview.md) |
