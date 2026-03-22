# HA Forge

Define Home Assistant entities in TypeScript. Type-safe, reactive, deployed as an HA add-on.

```ts
export default device({
  id: 'weather_station',
  name: 'Weather Station',
  entities: {
    temp:     sensor({ id: 'temp', name: 'Temperature', config: { device_class: 'temperature', unit_of_measurement: '°C' } }),
    humidity: sensor({ id: 'humidity', name: 'Humidity', config: { device_class: 'humidity', unit_of_measurement: '%' } }),
    heater:   defineSwitch({ id: 'heater', name: 'Heater' }),
    summary:  computed({
      id: 'summary', name: 'Summary',
      watch: ['sensor.temp', 'sensor.humidity'],
      compute: (s) => Number(s['sensor.temp']?.state) < 15 ? 'Cold' : 'Comfortable',
    }),
  },
  init() {
    this.poll(async () => {
      const data = await fetch('https://api.weather.example/current').then(r => r.json());
      this.entities.temp.update(data.temperature);
      this.entities.humidity.update(data.humidity);
    }, { interval: 600_000 });

    this.events.on('binary_sensor.front_door', () => {
      this.ha.callService('light.porch', 'turn_on');
    }).transition('off', 'on');
  },
});
```

Every entity ID, service, and parameter is typed from your live HA instance. The compiler catches mistakes. Runtime validators stop bad values before they reach HA.

## Why HA Forge

**Type safety from your HA instance** — Types are generated from your entity registry. Misspell an entity ID and the compiler tells you. Pass `brightness: 999` and a `RangeError` is thrown before the call leaves the add-on.

**Monaco editor in your browser** — IntelliSense, error squiggles, entity dashboard, and log viewer, accessible from the HA sidebar.

**24 entity platforms** — sensor, switch, light, climate, cover, and 19 more via MQTT discovery. Plus higher-level constructs: computed sensors, state machines, cron schedules, and automations.

**Composable behaviors** — Wrap any entity with `debounced()`, `filtered()`, `sampled()`, or `buffered()` to shape how state reaches HA.

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
