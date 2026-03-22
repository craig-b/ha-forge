# HA Forge

Define Home Assistant entities, automations, and reactive behaviors in TypeScript. Deployed as an HA add-on with MQTT discovery.

```typescript
import { sensor, defineSwitch, automation } from 'ha-forge';

// A temperature sensor that polls an external API
export const temp = sensor({
  id: 'backyard_temp',
  name: 'Temperature',
  config: { device_class: 'temperature', unit_of_measurement: '°C', state_class: 'measurement' },
  init() {
    this.poll(async () => {
      const r = await fetch('http://sensor.local/api');
      return (await r.json()).celsius;
    }, { interval: 30_000 });
    return 0;
  },
});

// A switch that controls hardware
export const pump = defineSwitch({
  id: 'irrigation_pump',
  name: 'Pump',
  onCommand(cmd) {
    setGPIO(17, cmd === 'ON');          // cmd: 'ON' | 'OFF'
    this.update(cmd === 'ON' ? 'on' : 'off');
  },
});

// React to HA state changes with full type safety
export const doorLight = automation({
  id: 'door_light',
  init() {
    this.events.on('binary_sensor.front_door', (e) => {
      if (e.new_state === 'on') {       // typed: 'on' | 'off'
        this.ha.callService('light.porch', 'turn_on', { brightness: 200 });
      }
    });
  },
});
```

Every entity ID, state value, attribute, and service parameter is typed from your live HA installation. Autocomplete guides you. The compiler catches mistakes. Runtime validators stop invalid values before they reach HA.

## Why HA Forge

**Type safety from your HA instance** — The SDK generates TypeScript types from your entity registry. `ha.callService('light.living_room', 'turn_on', { brightness: 999 })` throws a `RangeError` before the call leaves the add-on. Misspell an entity ID and the compiler tells you.

**A real editor in your browser** — Monaco editor with IntelliSense, error squiggles, entity dashboard, and log viewer, accessible from the HA sidebar.

**Composable behaviors** — Wrap any entity with `debounced()`, `filtered()`, `sampled()`, or `buffered()` to shape how state reaches HA:

```typescript
import { sensor, buffered, average } from 'ha-forge';

// Poll every 2s, publish 1-minute averages to HA
export const solarAvg = buffered(
  sensor({
    id: 'solar_avg',
    name: 'Solar (1min avg)',
    config: { device_class: 'power', unit_of_measurement: 'W', state_class: 'measurement' },
    init() { this.poll(readInverter, { interval: 2_000 }); return 0; },
  }),
  { interval: 60_000, reduce: average },
);
```

**Declarative reactions** with delayed auto-cancellation:

```typescript
this.events.reactions({
  'switch.garage_door': {
    to: 'on',
    after: 600_000,   // auto-cancelled if state changes before firing
    do: () => {
      this.ha.callService('switch.garage_door', 'turn_off');
      this.ha.callService('notify.mobile', 'send_message', {
        message: 'Garage open 10 minutes — closing.',
      });
    },
  },
});
```

**Devices with coordinated lifecycle** — group sensors, computed entities, modes, and tasks under one device with a single `init()`:

```typescript
import { device, sensor, computed, mode, task } from 'ha-forge';

export default device({
  id: 'weather',
  name: 'Weather Station',
  entities: {
    temp:      sensor({ id: 'ws_temp',     name: 'Temperature', config: { device_class: 'temperature', unit_of_measurement: '°C' } }),
    humidity:  sensor({ id: 'ws_humidity', name: 'Humidity',    config: { device_class: 'humidity', unit_of_measurement: '%' } }),
    clothing:  computed({
      id: 'ws_clothing', name: 'Clothing Suggestion',
      watch: ['sensor.ws_temp', 'sensor.ws_humidity'],
      compute: (s) => Number(s['sensor.ws_temp']?.state) < 15 ? 'Jacket' : 'T-shirt',
    }),
    refresh:   task({ id: 'ws_refresh', name: 'Refresh', icon: 'mdi:refresh', run() { /* re-poll */ } }),
  },
  init() {
    this.poll(async () => {
      const data = await fetch('https://api.weather.example/current').then(r => r.json());
      this.entities.temp.update(data.temperature);
      this.entities.humidity.update(data.humidity);
    }, { interval: 600_000 });
  },
});
```

**Watchdogs, sequences, and invariants** for complex automation:

```typescript
// Alert when a sensor goes silent
this.events.watchdog({
  'sensor.weather_station': {
    expect: 'change', within: 3_600_000,
    else: () => this.ha.callService('notify.phone', 'send_message', {
      message: 'Weather station silent for 1 hour',
    }),
  },
});

// Detect an arrival pattern across multiple sensors
this.events.sequence({
  name: 'arrival',
  steps: [
    { entity: 'binary_sensor.driveway', to: 'on', within: 0 },
    { entity: 'binary_sensor.front_door', to: 'on', within: 120_000 },
    { entity: 'lock.front_door', to: 'unlocked', within: 30_000 },
  ],
  do: () => this.ha.callService('scene.welcome_home', 'turn_on'),
});
```

## How It Works

```
Your .ts files
  → Build (type generation → tsc check → esbuild bundle → deploy)
  → MQTT discovery registers entities with HA
  → State updates flow over MQTT topics
  → HA state subscriptions flow over WebSocket
```

The add-on connects to your MQTT broker (Mosquitto) for entity registration and state, and to HA's WebSocket API for type generation, state subscriptions, and service calls. No custom integration needed.

## Installation

Requires the Mosquitto MQTT broker add-on.

1. Add the HA Forge repository to the add-on store
2. Install and start the add-on
3. Open it from the HA sidebar
4. Write your first entity and click Build

## Entity Types

**24 entity platforms** via MQTT discovery: sensor, binary_sensor, switch, light, cover, climate, fan, lock, number, select, text, button, siren, humidifier, valve, water_heater, vacuum, lawn_mower, alarm_control_panel, notify, update, image

**Higher-level constructs**: `computed` (reactive derived sensors), `mode` (state machines with guards), `cron` (schedule-based binary sensors), `automation` (pure reactive scripts), `task` (one-shot button scripts), `device` (grouped lifecycle), `entityFactory` (dynamic generation)

## Documentation

| | What | Start here |
|---|---|---|
| **Guide** | Installation, tutorials, patterns | [Getting Started](docs/guide/getting-started.md) |
| **Reference** | Full API, all options, every type | [Entity Context](docs/reference/entity-context.md) |
| **Architecture** | System internals, data flows, design | [Overview](docs/architecture/overview.md) |
