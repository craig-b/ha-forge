# Getting Started

## Prerequisites

- **Home Assistant OS** (HAOS) or a Supervised installation.
- **Mosquitto MQTT broker** installed as an HA add-on. HA Forge uses MQTT discovery to register entities.
- Basic TypeScript familiarity. You do not need a local development environment — everything runs inside the add-on.

## Installation

1. In Home Assistant, go to **Settings > Add-ons > Add-on Store**.
2. Click the three-dot menu and select **Repositories**. Paste the HA Forge repository URL.
3. Find **HA Forge** in the store, click **Install**.
4. Start the add-on. It appears in the sidebar as **HA Forge**.
5. Click to open the web editor.

## Your First Device

Create a new file called `greenhouse.ts` in the editor:

```ts
export default device({
  id: 'greenhouse',
  name: 'Greenhouse',
  entities: {
    temp:     sensor({ id: 'temp', name: 'Temperature', config: { device_class: 'temperature', unit_of_measurement: '°C' } }),
    humidity: sensor({ id: 'humidity', name: 'Humidity', config: { device_class: 'humidity', unit_of_measurement: '%' } }),
    fan:      defineSwitch({ id: 'fan', name: 'Vent Fan' }),
  },
  init() {
    this.poll(async () => {
      const data = await fetch('http://greenhouse.local/api').then(r => r.json());
      this.entities.temp.update(data.temperature);
      this.entities.humidity.update(data.humidity);
    }, { interval: 30_000 });
  },
});
```

Key concepts:

- **No imports needed.** `device`, `sensor`, `defineSwitch`, and all other factory functions are available globally.
- **`export`** is required. The runtime only discovers exported definitions.
- **`device()`** groups entities under one device in HA with a shared lifecycle. The `init()` runs once when deployed.
- **`this.poll()`** calls a function on an interval. The timer is automatically cleaned up on teardown.
- **`this.entities.temp.update()`** publishes a new state value for that entity.
- **`defineSwitch()`** is optimistic by default — when a user toggles the switch in HA, the state updates automatically. No `onCommand` handler needed for simple toggles.

## Save and Deploy

Save your file with **Ctrl+S**. To build and deploy:

- **Automatic:** Enable `auto_build_on_save` in the add-on settings. Every time you save a `.ts` file, the build pipeline runs automatically after a short debounce.
- **Manual:** Click the **Rebuild All** button in the header bar.

The build pipeline runs these steps:

1. **Type generation** — pulls your HA entity registry and generates TypeScript types for autocomplete and validation.
2. **Type check** — runs `tsc` to find errors. Errors appear as squiggles in the editor but do not block the build.
3. **Bundle** — esbuild compiles your TypeScript into JavaScript.
4. **Deploy** — the runtime loads the bundle, registers entities via MQTT discovery, calls `init()`, and publishes initial state.

Your entities appear in HA immediately. Check **Developer Tools > States** for `sensor.temp`.

## Individual Entities

You don't always need a device. A file can export standalone entities:

```ts
export const cpuTemp = sensor({
  id: 'cpu_temp',
  name: 'CPU Temperature',
  config: {
    device_class: 'temperature',
    unit_of_measurement: '°C',
    state_class: 'measurement',
  },
  init() {
    this.poll(async () => {
      const r = await fetch('http://192.168.1.50/api/temp');
      return (await r.json()).celsius;
    }, { interval: 30_000 });
    return 0;
  },
});
```

When a sensor's `init()` returns a value, that becomes the initial state. When `this.poll()` returns a value, it's published as the new state automatically — no `this.update()` needed.

## Automatic Grouping

Entities in the same file are automatically grouped into a device named after the file. A file called `garden.ts` with these exports:

```ts
export const temp = sensor({
  id: 'garden_temp',
  name: 'Temperature',
  config: { device_class: 'temperature', unit_of_measurement: '°C' },
  init() { return 0; },
});

export const humidity = sensor({
  id: 'garden_humidity',
  name: 'Humidity',
  config: { device_class: 'humidity', unit_of_measurement: '%' },
  init() { return 0; },
});
```

produces a device called "Garden" in HA containing both sensors.

For full control over the device — shared polling, coordinated lifecycle, typed entity handles — use `device()` as shown above. For a single entity where you don't want a device wrapper, set `name: null` on the entity definition.

## Reacting to HA State

Use `this.events.stream()` inside `init()` to subscribe to state changes from any entity in your HA installation. Building on the greenhouse example:

```ts
export default device({
  id: 'greenhouse',
  name: 'Greenhouse',
  entities: {
    temp: sensor({ id: 'temp', name: 'Temperature', config: { device_class: 'temperature', unit_of_measurement: '°C' } }),
    fan:  defineSwitch({ id: 'fan', name: 'Vent Fan' }),
  },
  init() {
    this.poll(async () => {
      const data = await fetch('http://greenhouse.local/api').then(r => r.json());
      this.entities.temp.update(data.temperature);
    }, { interval: 30_000 });

    // Auto-toggle the fan based on temperature
    this.events.stream('sensor.temp')
      .subscribe((e) => {
        this.entities.fan.update(Number(e.new_state) > 30 ? 'on' : 'off');
      });
  },
});
```

Entity IDs autocomplete from your HA installation. The callback event is typed — `e.new_state` and `e.old_state` carry the correct types for each entity domain.

All subscriptions created through `this.events` are lifecycle-managed. When the entity is torn down on rebuild or shutdown, subscriptions are cleaned up automatically.

## What's Next

- [Entity Types](entities.md) — all 24 entity platforms and higher-level constructs.
- [Reactive Patterns](reactive.md) — event streams, reactions, watchdogs, and more.
- [Composable Behaviors](behaviors.md) — debouncing, filtering, sampling, and buffering.
- [Web Editor](web-editor.md) — Monaco features, entity dashboard, and log viewer.
- [Advanced Patterns](advanced.md) — entity factories, computed entities, cron, state machines, and health monitoring.
