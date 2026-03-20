# TS Entities

Define Home Assistant entities, automations, and reactive behaviors in TypeScript.

## Getting Started

1. Install the add-on from this repository
2. Ensure the **Mosquitto MQTT broker** add-on is installed and running
3. Start the add-on and open the **Web UI** from the sidebar
4. Click **Regenerate Types** to pull entity and service types from your HA instance

The web UI provides a Monaco code editor with full TypeScript IntelliSense. All SDK functions and your HA entity/service types are available as globals — no imports needed.

## Writing Your First Entity

Create a new `.ts` file in the editor:

```typescript
export const temp = sensor({
  id: 'hello_world',
  name: 'Hello World',
  config: {
    device_class: 'temperature',
    unit_of_measurement: '°C',
    state_class: 'measurement',
  },
  init() {
    this.poll(() => Math.round(Math.random() * 30), { interval: 60_000 });
    return 22;
  },
});
```

Click **Build** to deploy. The sensor appears in Home Assistant immediately.

## Available Globals

All of these are available without imports:

| Global | Description |
|--------|-------------|
| `sensor(options)` | Define a read-only sensor entity |
| `defineSwitch(options)` | Define a controllable on/off switch |
| `light(options)` | Define a light with brightness/color support |
| `cover(options)` | Define a cover (blind, garage door, curtain) |
| `climate(options)` | Define a climate device (thermostat, AC) |
| `device(options)` | Group multiple entities into a device with shared lifecycle |
| `entityFactory(fn)` | Dynamically create entities at deploy time |
| `ha` | Home Assistant client — subscribe to state, call services, query state |

## Reacting to Home Assistant

Use the `ha` global to subscribe to state changes and call services:

```typescript
// Turn on the porch light when the front door opens
ha.on('binary_sensor.front_door', (event) => {
  if (event.new_state === 'on') {
    ha.callService('light.porch', 'turn_on', { brightness: 255 });
  }
});
```

```typescript
// Declarative reactions with optional delay and auto-cancellation
ha.reactions({
  'binary_sensor.motion_kitchen': {
    to: 'off',
    after: 300_000, // 5 minutes after motion stops
    do: () => ha.callService('light.kitchen', 'turn_off'),
  },
});
```

All entity IDs and service parameters are fully typed when you regenerate types from your HA instance.

## Devices

Group related entities under a single device with a shared polling loop:

```typescript
export const station = device({
  id: 'weather_station',
  name: 'Weather Station',
  entities: {
    temperature: sensor({
      id: 'ws_temp',
      name: 'Temperature',
      config: { device_class: 'temperature', unit_of_measurement: '°C' },
    }),
    humidity: sensor({
      id: 'ws_humidity',
      name: 'Humidity',
      config: { device_class: 'humidity', unit_of_measurement: '%' },
    }),
  },
  init() {
    this.poll(async () => {
      const data = await fetch('https://api.example.com/weather').then(r => r.json());
      this.entities.temperature.update(data.temp);
      this.entities.humidity.update(data.humidity);
    }, { interval: 60_000 });
  },
});
```

## Entity Types

Factory functions exist for: **sensor**, **switch**, **light**, **cover**, **climate**.

The MQTT transport supports all 25 HA entity platforms: sensor, binary_sensor, switch, light, cover, fan, lock, climate, humidifier, valve, water_heater, vacuum, lawn_mower, siren, number, select, text, button, scene, notify, update, event, device_tracker, camera, alarm_control_panel, image, tag.

## Entity Lifecycle

Each entity has an optional `init()` and `destroy()` callback:

- **`init()`** — Called when the entity is deployed. Return the initial state. Use `this.poll()`, `this.setTimeout()`, `this.setInterval()` for ongoing updates — all are auto-cleaned on teardown.
- **`destroy()`** — Called when the entity is torn down. Use for cleaning up external resources (connections, file handles).

Inside these callbacks, `this` provides:
- `this.update(state)` — Publish a new state to HA
- `this.poll(fn, { interval })` — Repeat a function on a timer
- `this.setTimeout(fn, ms)` / `this.setInterval(fn, ms)` — Managed timers
- `this.log` — Scoped logger (appears in the Log Viewer panel)
- `this.mqtt.publish(topic, payload)` / `this.mqtt.subscribe(topic, handler)` — Raw MQTT access

## Configuration

| Option | Default | Description |
|--------|---------|-------------|
| `log_level` | `info` | Minimum log level: debug, info, warn, error |
| `log_retention_days` | `7` | Days to keep logs in the SQLite database |
| `validation_schedule_minutes` | `60` | Interval for scheduled type validation (0 to disable) |
| `auto_build_on_save` | `false` | Automatically build when files are saved |
| `auto_rebuild_on_registry_change` | `false` | Rebuild when the HA entity/service registry changes |

MQTT connection is auto-detected from the Mosquitto add-on. Manual MQTT options (`mqtt_host`, `mqtt_port`, `mqtt_username`, `mqtt_password`) are available if you use an external broker.

## How It Works

1. **Type generation** — Connects to the HA WebSocket API, pulls entity/device/area/service registries, generates `.d.ts` files with typed entity IDs, state shapes, and service parameters.
2. **Build** — esbuild bundles your `.ts` files, tsc type-checks in parallel.
3. **Deploy** — Entities are registered via MQTT discovery. State updates and commands flow through MQTT.

## Data Storage

- **Scripts**: stored in `/addon_configs/ts_entities/` (included in HA backups)
- **Logs & build cache**: stored in `/data/` (persistent across restarts)
