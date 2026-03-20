# TS Entities for Home Assistant

Define Home Assistant entities, automations, and reactive behaviors in TypeScript.

A Node.js runtime deployed as a Home Assistant add-on. User-authored `.ts` files declare entities using a typed SDK. The runtime registers them with Home Assistant via MQTT discovery. A built-in Monaco editor with full IntelliSense runs inside the HA ingress panel.

## Why TypeScript?

The SDK generates types from your live HA installation — every entity ID, state value, attribute, and service parameter becomes a typed construct. Autocomplete guides you. The compiler catches references to entities that don't exist, services with invalid parameters, and typos before anything runs.

```typescript
// Every entity ID autocompletes. State values are literal unions.
ha.on('input_select.house_mode', (e) => {
  // e.new_state: 'home' | 'away' | 'sleeping' | 'vacation'
  if (e.new_state === 'away') {
    ha.callService('light.living_room', 'turn_off');
  }
});

// Service parameters are typed with constraints from your HA instance.
ha.callService('light.living_room', 'turn_on', {
  brightness: 200,   // typed as number (0–255)
  transition: 2,
});
```

## How It Works

1. **Type generation** — connects to HA's WebSocket API, pulls the entity registry, service definitions, and state data. Generates `.d.ts` types with per-entity overloads.
2. **Build** — esbuild bundles your `.ts` files. tsc type-checks in parallel.
3. **Deploy** — entities registered via MQTT discovery. State updates published to MQTT. Commands received via MQTT subscriptions.

## Defining Entities

Entities are defined using factory functions (`sensor()`, `defineSwitch()`, `light()`, `cover()`, `climate()`) and must be **exported** to be deployed.

### Sensor

Read-only entity that publishes state to HA.

```typescript
export default sensor({
  id: 'backyard_temp',
  name: 'Backyard Temperature',
  config: {
    device_class: 'temperature',
    unit_of_measurement: '°C',
    state_class: 'measurement',
  },
  init() {
    // Poll an external API every 30 seconds
    this.poll(async () => {
      const resp = await this.fetch('http://192.168.1.50/api/temp');
      return (await resp.json()).celsius;
    }, { interval: 30_000 });
    return 0;
  },
});
```

### Switch

Bidirectional entity that receives commands from HA.

```typescript
export const pump = defineSwitch({
  id: 'irrigation_pump',
  name: 'Irrigation Pump',
  onCommand(command) {
    // command: 'ON' | 'OFF'
    setGPIO(17, command === 'ON');
    this.update(command === 'ON' ? 'on' : 'off');
  },
  init() {
    return 'off';
  },
});
```

### Light

Supports brightness, color modes, and effects.

```typescript
export const desk = light({
  id: 'desk_lamp',
  name: 'Desk Lamp',
  config: {
    supported_color_modes: ['brightness', 'color_temp'],
    min_color_temp_kelvin: 2700,
    max_color_temp_kelvin: 6500,
  },
  onCommand(command) {
    sendToDevice(command);
    this.update({
      state: command.state === 'ON' ? 'on' : 'off',
      brightness: command.brightness,
    });
  },
  init() {
    return { state: 'off' };
  },
});
```

### Entity Factory

Generate entities dynamically at runtime — useful for creating entities based on external data or HA state.

```typescript
export default entityFactory(async () => {
  const rooms = await fetchRoomList();
  return rooms.map(room =>
    sensor({
      id: `${room.id}_occupancy`,
      name: `${room.name} Occupancy`,
      config: { device_class: 'occupancy' },
      init() {
        this.poll(() => checkOccupancy(room.id), { interval: 10_000 });
        return 'off';
      },
    })
  );
});
```

## Reactive Patterns

### Subscribing to State Changes

`ha.on()` subscribes to state changes with fully typed events. Entity IDs autocomplete, and the callback receives typed `new_state` and `new_attributes`.

```typescript
// Subscribe to a specific entity
ha.on('sensor.outdoor_temperature', (e) => {
  ha.log.info(`Temperature: ${e.new_state}°C`);
});

// Subscribe to a whole domain
ha.on('light', (e) => {
  ha.log.info(`${e.entity_id} is now ${e.new_state}`);
});

// Subscribe to multiple entities
ha.on(['sensor.temp_indoor', 'sensor.temp_outdoor'], (e) => {
  ha.log.info(`${e.entity_id}: ${e.new_state}`);
});
```

### Calling Services

```typescript
ha.callService('light.kitchen', 'turn_on', { brightness: 255 });
ha.callService('notify.mobile_app_phone', 'send_message', {
  message: 'Motion detected!',
});
```

### Declarative Reactions

Set up reaction rules with typed entity IDs. The `to` field is typed per entity (e.g. `'on' | 'off'` for lights). Delayed reactions auto-cancel if state changes again.

```typescript
ha.reactions({
  'binary_sensor.front_door': {
    to: 'on',
    do: () => ha.callService('light.porch', 'turn_on', { brightness: 255 }),
  },
  'binary_sensor.garage_door': {
    to: 'on',
    after: 600_000, // 10 minutes
    do: () => {
      ha.callService('cover.garage', 'close_cover');
      ha.callService('notify.mobile_app_phone', 'send_message', {
        message: 'Garage was open for 10 minutes — closing.',
      });
    },
  },
});
```

### Querying State

```typescript
const state = await ha.getState('sensor.outdoor_temperature');
if (state && Number(state.state) < 5) {
  ha.callService('climate.living_room', 'set_temperature', {
    temperature: 22,
  });
}
```

### Utility

```typescript
// Get friendly name from HA state cache
const name = ha.friendlyName('light.kitchen'); // 'Kitchen Light'

// List all entities in a domain
const lights = await ha.getEntities('light');
```

## Entity Context (`this`)

Inside `init()`, `destroy()`, and `onCommand()`, `this` provides:

| Property | Description |
|---|---|
| `this.update(value, attrs?)` | Publish new state to HA |
| `this.poll(fn, { interval })` | Start a polling loop (auto-cleaned on teardown) |
| `this.log` | Scoped logger — `debug`, `info`, `warn`, `error` |
| `this.ha` | Full HA client — `on()`, `callService()`, `getState()`, etc. |
| `this.fetch` | Standard `fetch()` for HTTP requests |
| `this.setTimeout(fn, ms)` | One-shot timer (auto-cleaned on teardown) |
| `this.setInterval(fn, ms)` | Repeating timer (auto-cleaned on teardown) |
| `this.mqtt.publish(topic, payload)` | Publish to an arbitrary MQTT topic |
| `this.mqtt.subscribe(topic, handler)` | Subscribe to an MQTT topic (auto-cleaned on teardown) |

## Supported Entity Types

The SDK provides factory functions for the most common types:

| Function | Entity type |
|---|---|
| `sensor()` | Read-only sensor |
| `defineSwitch()` | On/off switch |
| `light()` | Light with brightness/color |
| `cover()` | Cover (blind, garage door, curtain) |
| `climate()` | Climate (thermostat, AC, heater) |

The MQTT transport supports all 25 HA entity platforms: sensor, binary_sensor, switch, light, cover, climate, fan, lock, humidifier, valve, water_heater, vacuum, lawn_mower, siren, number, select, text, button, scene, event, device_tracker, camera, alarm_control_panel, notify, update, and image.

Factory functions for additional entity types are coming — see [TODO.md](TODO.md).

## Web Editor

The add-on includes a browser-based Monaco editor accessible via the HA ingress panel:

- Full TypeScript IntelliSense with types generated from your HA instance
- File tree with create and edit (rename/delete coming — see [TODO.md](TODO.md))
- Build button with output console
- Entity dashboard showing deployed entities and their state
- Log viewer with level, entity, and search filters
- Real-time updates via WebSocket

## Architecture

- **Add-on**: Node.js LTS in Docker on HAOS. Connects to Mosquitto (MQTT) and HA WebSocket API.
- **Editor**: Ingress-based Monaco editor with full IntelliSense.
- **Transport**: MQTT discovery for 25 entity platforms.
- **Health monitoring**: Scheduled type validation detects HA registry drift. Health entities (`binary_sensor.ts_entities_build_healthy`) can trigger HA automations on breakage.

## Requirements

- Home Assistant OS with Mosquitto MQTT broker add-on
- Node.js LTS (bundled in the add-on container)

## Documentation

See [SPEC.md](SPEC.md) for the full technical specification and [TODO.md](TODO.md) for known issues and planned features.

Architecture docs live in `docs/architecture/`.
