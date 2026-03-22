# Getting Started

## Prerequisites

- **Home Assistant OS** (HAOS) or a Supervised installation.
- **Mosquitto MQTT broker** installed as an HA add-on. HA Forge uses MQTT discovery to register entities.
- Basic TypeScript familiarity. You do not need a local development environment -- everything runs inside the add-on.

## Installation

1. In Home Assistant, go to **Settings > Add-ons > Add-on Store**.
2. Click the three-dot menu and select **Repositories**. Paste the HA Forge repository URL.
3. Find **HA Forge** in the store, click **Install**.
4. Start the add-on. It appears in the sidebar as **HA Forge**.
5. Click to open the web editor.

## Your First Entity

Create a new file called `weather.ts` in the editor. Paste this sensor that polls a temperature API:

```typescript
import { sensor } from 'ha-forge';

export const temp = sensor({
  id: 'my_temp',
  name: 'My Temperature',
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

Key concepts:

- **`export`** is required. The runtime only sees exported entity definitions.
- **`id`** becomes the entity's unique ID in HA (prefixed with `ha_forge_`).
- **`name`** is the display name. With device grouping, HA prepends the device name automatically.
- **`config`** maps to MQTT discovery fields -- `device_class`, `unit_of_measurement`, and `state_class` control how HA displays and records the value.
- **`init()`** runs when the entity starts. Set up polling, subscriptions, or any async work here. The return value is the initial state published to HA.
- **`this.poll()`** calls a function on an interval and publishes the return value as the entity's state. The poll and its timer are automatically cleaned up when the entity is torn down.

## Building and Deploying

Click the **Build** button in the editor toolbar. The build pipeline runs these steps:

1. **Type generation** -- pulls your HA entity registry and generates TypeScript types.
2. **npm install** -- installs any packages from `package.json` (only if changed).
3. **Type check** -- runs `tsc` to find type errors. Errors appear as squiggles in the editor but do not block the build.
4. **Bundle** -- esbuild compiles and bundles your TypeScript into JavaScript.
5. **Deploy** -- the runtime loads the bundle, registers entities via MQTT discovery, calls `init()`, and publishes initial state.

Your entity appears in HA immediately. Check **Developer Tools > States** for `sensor.my_temp`.

## Adding a Controllable Entity

Read-only sensors are one direction. Controllable entities like switches handle commands from HA:

```typescript
import { defineSwitch } from 'ha-forge';

export const pump = defineSwitch({
  id: 'garden_pump',
  name: 'Garden Pump',
  onCommand(command) {
    setGPIO(17, command === 'ON');
    this.update(command === 'ON' ? 'on' : 'off');
  },
  init() {
    return 'off';
  },
});
```

The flow is bidirectional:

1. User toggles the switch in HA.
2. HA publishes `ON` or `OFF` to the MQTT command topic.
3. The runtime calls your `onCommand()` with the command.
4. Your code acts on the hardware, then calls `this.update()` to confirm the new state back to HA.

The `init()` return value sets the initial state when the entity first loads.

## Reacting to HA State

Use `this.events.on()` inside `init()` to subscribe to state changes from any entity in your HA installation:

```typescript
import { automation } from 'ha-forge';

export const porchLight = automation({
  id: 'porch_light_on_door_open',
  name: 'Porch Light on Door Open',
  init() {
    this.events.on('binary_sensor.front_door', (e) => {
      if (e.new_state === 'on') {
        this.ha.callService('light.porch', 'turn_on', { brightness: 255 });
      }
    });
  },
});
```

Entity IDs autocomplete from your HA installation. The callback event is typed -- `e.new_state` for a binary sensor is `'on' | 'off'`, and attributes like `brightness` carry their valid ranges.

All subscriptions created through `this.events` are lifecycle-managed. When the entity is torn down (on rebuild or shutdown), subscriptions are cleaned up automatically. You never need to manually unsubscribe.

## Grouping Entities

Entities in the same file are automatically grouped into a device in HA, named after the file. A file called `garden.ts` with three exports produces a device named "Garden" containing those three entities.

For explicit control, provide a `device` config:

```typescript
import { sensor, defineSwitch } from 'ha-forge';

const weatherStation = {
  id: 'weather_station',
  name: 'Weather Station',
  manufacturer: 'Acme',
  model: 'WS-3000',
  suggested_area: 'Garden',
};

export const temp = sensor({
  id: 'outdoor_temp',
  name: 'Temperature',
  device: weatherStation,
  config: { device_class: 'temperature', unit_of_measurement: '°C' },
  init() { /* ... */ return 0; },
});

export const rain = sensor({
  id: 'rain_rate',
  name: 'Rain Rate',
  device: weatherStation,
  config: { unit_of_measurement: 'mm/h' },
  init() { /* ... */ return 0; },
});
```

Both entities share the same `device.id`, so they appear under one device in HA.

For a file with a single entity where you do not want the device wrapper, set `name: null` on the entity definition.

## Using npm Packages

Your scripts directory contains a `package.json` (scaffolded automatically on first run). Add packages by editing it directly or through the planned dependency management UI. Dependencies are installed during the build pipeline and bundled by esbuild, so they work seamlessly in the editor and at runtime.

Types from installed packages (including `@types/*`) are injected into the Monaco editor for full IntelliSense.

## What's Next

- [Entity Types](entities.md) -- all 24 entity platforms and higher-level constructs.
- [Reactive Patterns](reactive.md) -- event streams, reactions, watchdogs, and more.
- [Composable Behaviors](behaviors.md) -- debouncing, filtering, sampling, and buffering.
- [Web Editor](web-editor.md) -- Monaco features, entity dashboard, and log viewer.
- [Advanced Patterns](advanced.md) -- entity factories, computed entities, cron, state machines, and health monitoring.
