# TS Entities

Define Home Assistant entities, automations, and reactive behaviors in TypeScript.

## Getting Started

1. Install the add-on from this repository
2. Ensure the **Mosquitto MQTT broker** add-on is installed and running
3. Start the add-on and open the **Web UI** from the sidebar

The web UI provides a Monaco code editor with full TypeScript IntelliSense, pre-loaded with types generated from your HA instance.

## Writing Your First Entity

Create a new `.ts` file in the editor:

```typescript
import { sensor } from '@ha-ts-entities/sdk';

export default sensor({
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

## Configuration

| Option | Default | Description |
|--------|---------|-------------|
| `log_level` | `info` | Minimum log level: debug, info, warn, error |
| `log_retention_days` | `7` | Days to keep logs in the SQLite database |
| `validation_schedule_minutes` | `60` | Interval for scheduled type validation (0 to disable) |
| `auto_build_on_save` | `false` | Automatically build when files are saved in the editor |
| `auto_rebuild_on_registry_change` | `false` | Rebuild when HA entity/service registry changes |

## Entity Types

Supported: sensor, binary_sensor, switch, light, cover, fan, lock, climate, humidifier, valve, water_heater, vacuum, lawn_mower, siren, number, select, text, button, scene, notify, update, event, device_tracker, camera, alarm_control_panel, image, tag.

## Reactive Patterns

Listen to HA state changes and call services with full type safety:

```typescript
import { reactions } from '@ha-ts-entities/sdk';

export default reactions({
  'binary_sensor.front_door': {
    to: 'on',
    do: () => ha.callService('light.porch', 'turn_on', { brightness: 255 }),
  },
});
```

## How It Works

1. **Type generation** — connects to HA WebSocket API, pulls registries, generates `.d.ts` types
2. **Build** — esbuild bundles `.ts` files, tsc type-checks in parallel
3. **Deploy** — entities registered via MQTT discovery, state updates flow through MQTT

## Data Storage

- **Scripts**: stored in `/addon_configs/ts_entities/` (included in HA backups)
- **Logs & cache**: stored in `/data/` (persistent across restarts)
