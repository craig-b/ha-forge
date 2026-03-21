# HA Forge

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

**Entity factories:**

| Global | Description |
|--------|-------------|
| `sensor(options)` | Read-only sensor |
| `binarySensor(options)` | Two-state sensor (on/off) |
| `defineSwitch(options)` | Controllable on/off switch |
| `light(options)` | Light with brightness/color support |
| `cover(options)` | Cover (blind, garage door, curtain) |
| `climate(options)` | Climate device (thermostat, AC) |
| `fan(options)` | Fan with speed/direction |
| `lock(options)` | Lock/unlock/open |
| `number(options)` | Numeric input with min/max |
| `select(options)` | Dropdown selection |
| `text(options)` | Text input |
| `button(options)` | Momentary button (command only) |
| `siren(options)` | Siren/alarm control |
| `humidifier(options)` | Humidity control |
| `valve(options)` | Water/gas valve |
| `waterHeater(options)` | Water heater with temperature |
| `vacuum(options)` | Robot vacuum |
| `lawnMower(options)` | Robotic mower |
| `alarmControlPanel(options)` | Security system arm/disarm |
| `notify(options)` | Notification target |
| `update(options)` | Update availability indicator |
| `image(options)` | Static image entity |

**Higher-level constructs:**

| Global | Description |
|--------|-------------|
| `computed(options)` | Derived sensor — state is a pure function of other entities |
| `mode(options)` | State machine — select entity with enter/exit/guard transitions |
| `cron(options)` | Schedule — binary_sensor ON/OFF based on cron expression |
| `automation(options)` | Pure reactive script with managed lifecycle |
| `task(options)` | One-shot script surfaced as a button entity |
| `device(options)` | Group multiple entities into a device with shared lifecycle |
| `entityFactory(fn)` | Dynamically create entities at deploy time |

**Runtime:**

| Global | Description |
|--------|-------------|
| `ha` | Stateless HA client — `callService()`, `getState()`, `getEntities()`, `fireEvent()`, `friendlyName()` |

## Entity Lifecycle

Each entity has an optional `init()` and `destroy()` callback:

- **`init()`** — Called when the entity is deployed. Return the initial state. Use `this.poll()`, `this.setTimeout()`, `this.setInterval()` for ongoing updates — all are auto-cleaned on teardown.
- **`destroy()`** — Called when the entity is torn down. Use for cleaning up external resources (connections, file handles).

Inside these callbacks, `this` provides:

| Property | Description |
|----------|-------------|
| `this.update(value, attrs?)` | Publish new state (and optional attributes) to HA |
| `this.attr(attributes)` | Update attributes without changing state |
| `this.poll(fn, { interval })` | Repeat a function on a timer |
| `this.log` | Scoped logger — `debug`, `info`, `warn`, `error` (appears in the Log Viewer) |
| `this.ha` | Stateless HA client — `callService()`, `getState()`, `getEntities()`, `fireEvent()`, `friendlyName()` |
| `this.events` | Scoped reactive subscriptions — `on()`, `reactions()`, `combine()`, `withState()`, `watchdog()`, `invariant()`, `sequence()` |
| `this.fetch` | Standard `fetch()` for HTTP requests |
| `this.setTimeout(fn, ms)` | One-shot timer (auto-cleaned on teardown) |
| `this.setInterval(fn, ms)` | Repeating timer (auto-cleaned on teardown) |
| `this.mqtt.publish(topic, payload)` | Publish to an arbitrary MQTT topic |
| `this.mqtt.subscribe(topic, handler)` | Subscribe to an MQTT topic (auto-cleaned on teardown) |

## Reactive Patterns

### Subscribing to State Changes

```typescript
// Inside init() — lifecycle-managed, auto-cleaned on teardown
this.events.on('sensor.outdoor_temperature', (e) => {
  this.log.info(`Temperature: ${e.new_state}°C`);
});

// Subscribe to a whole domain
this.events.on('light', (e) => {
  this.log.info(`${e.entity_id} is now ${e.new_state}`);
});
```

### Declarative Reactions

```typescript
this.events.reactions({
  'binary_sensor.motion_kitchen': {
    to: 'off',
    after: 300_000, // 5 minutes after motion stops
    do: () => this.ha.callService('light.kitchen', 'turn_off'),
  },
});
```

### Stream Operators

`this.events.on()` returns a composable stream with chainable operators:

```typescript
this.events.on('binary_sensor.motion')
  .debounce(5000)
  .filter((e) => e.new_state === 'off')
  .do(() => this.ha.callService('light.hallway', 'turn_off'));
```

Available operators: `.filter()`, `.map()`, `.debounce(ms)`, `.throttle(ms)`, `.distinctUntilChanged()`, `.transition(from, to)`.

### Combine / With State

```typescript
// Fire when any input changes, receive all snapshots
this.events.combine(
  ['sensor.temperature', 'sensor.humidity'],
  (states) => {
    const temp = Number(states['sensor.temperature']?.state);
    const humidity = Number(states['sensor.humidity']?.state);
    this.log.info(`Temp: ${temp}, Humidity: ${humidity}`);
  },
);

// Enrich events with context (skips when any context entity is unavailable)
this.events.withState(
  'binary_sensor.motion',
  ['sensor.light_level'],
  (event, states) => {
    if (event.new_state === 'on' && Number(states['sensor.light_level'].state) < 50) {
      this.ha.callService('light.hallway', 'turn_on');
    }
  },
);
```

### Watchdog

React to things that *should* happen but don't:

```typescript
this.events.watchdog({
  'sensor.weather_station': {
    expect: 'change',
    within: 3_600_000,  // 1 hour
    else: () => this.ha.callService('notify.phone', 'send_message', {
      message: 'Weather station silent for 1 hour',
    }),
  },
});
```

### Invariant

Declare constraints that must always hold:

```typescript
this.events.invariant({
  name: 'safe_temperature',
  condition: async () => {
    const state = await this.ha.getState('sensor.server_room_temp');
    return state !== null && Number(state.state) < 35;
  },
  check: { interval: 60_000 },
  violated: () => this.ha.callService('switch.server_room_fan', 'turn_on'),
});
```

### Sequence

Detect ordered events across multiple entities:

```typescript
this.events.sequence({
  name: 'arrival_pattern',
  steps: [
    { entity: 'binary_sensor.driveway_motion', to: 'on', within: 0 },
    { entity: 'binary_sensor.front_door', to: 'on', within: 120_000 },
    { entity: 'lock.front_door', to: 'unlocked', within: 30_000 },
  ],
  do: () => this.ha.callService('light.entryway', 'turn_on', { brightness: 255 }),
});
```

## Computed Entities

Derived sensors whose state is a pure function of other entities. No `init()` needed — re-evaluates reactively when inputs change.

```typescript
export const comfort = computed({
  id: 'comfort_index',
  name: 'Comfort Index',
  watch: ['sensor.temperature', 'sensor.humidity'],
  compute: (states) => {
    const temp = Number(states['sensor.temperature']?.state);
    const humidity = Number(states['sensor.humidity']?.state);
    return Math.round(temp + 0.05 * humidity);
  },
  config: { unit_of_measurement: '°C', device_class: 'temperature' },
});
```

Computed entities can watch other computed entities. Rapid input changes are debounced (default 100ms).

### Computed Attributes

Any entity can have reactive attributes:

```typescript
export const temp = sensor({
  id: 'cpu_temp',
  name: 'CPU Temperature',
  attributes: {
    location: 'server-room',  // static
    severity: computed(       // reactive
      (states) => {
        const t = Number(states['sensor.cpu_temp']?.state);
        return t > 80 ? 'critical' : t > 60 ? 'warning' : 'normal';
      },
      { watch: ['sensor.cpu_temp'] },
    ),
  },
  init() {
    this.poll(() => readCpuTemp(), { interval: 10_000 });
    return 0;
  },
});
```

## Modes

State machines surfaced as `select` entities with enter/exit hooks and guards:

```typescript
export const houseMode = mode({
  id: 'house_mode',
  name: 'House Mode',
  states: ['home', 'away', 'sleep', 'movie'],
  initial: 'home',
  transitions: {
    away: {
      enter() {
        this.ha.callService('climate.main', 'set_hvac_mode', { hvac_mode: 'eco' });
        this.ha.callService('light', 'turn_off');
      },
      exit() {
        this.ha.callService('climate.main', 'set_hvac_mode', { hvac_mode: 'auto' });
      },
      guard(from) { return from !== 'sleep'; },
    },
    movie: {
      enter() {
        this.ha.callService('light.living_room', 'turn_on', { brightness: 30 });
      },
    },
  },
});
```

Appears as a dropdown in the HA UI. Guards return `false` to block a transition.

## Cron Schedules

Schedule entities surfaced as `binary_sensor` — ON during matching cron windows, OFF otherwise:

```typescript
export const workHours = cron({
  id: 'work_hours',
  name: 'Work Hours',
  schedule: '0 9-17 * * 1-5',  // weekdays 9am-5pm
});
```

Usable as a dependency in `computed()`, `this.events.on()`, or any pattern that reacts to binary_sensor state changes.

## Automations

Pure reactive scripts with managed lifecycle. No HA entity by default:

```typescript
export const motionLights = automation({
  id: 'motion_lights',
  init() {
    this.events.on('binary_sensor.hallway_motion', async (event) => {
      if (event.new_state === 'on') {
        await this.ha.callService('light.hallway', 'turn_on');
      }
    });
  },
});
```

Set `entity: true` to surface as a `binary_sensor` (ON = running, OFF = errored).

## Tasks

One-shot scripts surfaced as button entities:

```typescript
export const notifyAll = task({
  id: 'notify_all',
  name: 'Notify All Devices',
  icon: 'mdi:bullhorn',
  run() {
    this.ha.callService('notify.all_devices', 'send_message', {
      message: 'Hello from HA Forge!',
    });
  },
});
```

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
      const data = await this.fetch('https://api.example.com/weather').then(r => r.json());
      this.entities.temperature.update(data.temp);
      this.entities.humidity.update(data.humidity);
    }, { interval: 60_000 });
  },
});
```

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

- **Scripts**: stored in `/addon_configs/ha_forge/` (included in HA backups)
- **Logs & build cache**: stored in `/data/` (persistent across restarts)
