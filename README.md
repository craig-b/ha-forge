# HA Forge for Home Assistant

Define Home Assistant entities, automations, and reactive behaviors in TypeScript.

A Node.js runtime deployed as a Home Assistant add-on. User-authored `.ts` files declare entities using a typed SDK. The runtime registers them with Home Assistant via MQTT discovery. A built-in Monaco editor with full IntelliSense runs inside the HA ingress panel.

## Why TypeScript?

The SDK generates types from your live HA installation — every entity ID, state value, attribute, and service parameter becomes a typed construct. Autocomplete guides you. The compiler catches references to entities that don't exist, services with invalid parameters, and typos before anything runs.

```typescript
// Every entity ID autocompletes. State values are literal unions.
this.events.on('input_select.house_mode', (e) => {
  // e.new_state: 'home' | 'away' | 'sleeping' | 'vacation'
  if (e.new_state === 'away') {
    this.ha.callService('light.living_room', 'turn_off');
  }
});

// Service parameters are typed with constraints from your HA instance.
this.ha.callService('light.living_room', 'turn_on', {
  brightness: 200,   // typed as number (0–255)
  transition: 2,
});
```

## How It Works

1. **Type generation** — connects to HA's WebSocket API, pulls the entity registry, service definitions, and state data. Generates `.d.ts` types with per-entity overloads.
2. **Build** — esbuild bundles your `.ts` files. tsc type-checks in parallel.
3. **Deploy** — entities registered via MQTT discovery. State updates published to MQTT. Commands received via MQTT subscriptions.

## Defining Entities

Entities are defined using factory functions and must be **exported** to be deployed. The SDK covers all common HA entity platforms plus higher-level constructs like computed entities, state machines, and scheduled sensors.

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

### Device Grouping

Entities are grouped under a device in HA. By default the file name is used. Set `device` explicitly to control grouping. HA prepends the device name to the entity name, so `name` should be just the distinguishing part. Set `name: null` for single-entity devices to inherit the device name.

```typescript
// weather-station.ts — multiple sensors grouped under one device

const device = { id: 'weather_station', name: 'Weather Station' };

// Shows as "Weather Station Temperature" in HA
export const temp = sensor({
  id: 'ws_temperature',
  name: 'Temperature',
  device,
  config: { device_class: 'temperature', unit_of_measurement: '°C' },
  init() {
    this.poll(async () => {
      const data = await this.fetch('http://192.168.1.80/api').then(r => r.json());
      return data.temperature;
    }, { interval: 60_000 });
    return 0;
  },
});

// Shows as "Weather Station Humidity" in HA
export const humidity = sensor({
  id: 'ws_humidity',
  name: 'Humidity',
  device,
  config: { device_class: 'humidity', unit_of_measurement: '%' },
  init() {
    this.poll(async () => {
      const data = await this.fetch('http://192.168.1.80/api').then(r => r.json());
      return data.humidity;
    }, { interval: 60_000 });
    return 0;
  },
});
```

```typescript
// pool.ts — single sensor that IS the device

// Shows as "Pool" in HA
export default sensor({
  id: 'pool_temp',
  name: null,
  device: { id: 'pool', name: 'Pool' },
  config: { device_class: 'temperature', unit_of_measurement: '°C' },
  init() {
    this.poll(async () => {
      const resp = await this.fetch('http://192.168.1.90/temp');
      return (await resp.json()).celsius;
    }, { interval: 30_000 });
    return 0;
  },
});
```

```typescript
// fish-tank.ts — mixed entity types under one device

const device = { id: 'fish_tank', name: 'Fish Tank' };

// "Fish Tank Temperature" — read-only sensor
export const temp = sensor({
  id: 'tank_temp',
  name: 'Temperature',
  device,
  config: { device_class: 'temperature', unit_of_measurement: '°C' },
  init() {
    this.poll(async () => {
      const resp = await this.fetch('http://192.168.1.42/api/sensors');
      return (await resp.json()).water_temp;
    }, { interval: 10_000 });
    return 0;
  },
});

// "Fish Tank Heater" — controllable switch
export const heater = defineSwitch({
  id: 'tank_heater',
  name: 'Heater',
  device,
  onCommand(command) {
    this.fetch('http://192.168.1.42/api/heater', {
      method: 'POST',
      body: JSON.stringify({ state: command }),
    });
    this.update(command === 'ON' ? 'on' : 'off');
  },
  init() {
    return 'off';
  },
});

// "Fish Tank Light" — dimmable light
export const lamp = light({
  id: 'tank_light',
  name: 'Light',
  device,
  config: { supported_color_modes: ['brightness'] },
  onCommand(command) {
    this.fetch('http://192.168.1.42/api/light', {
      method: 'POST',
      body: JSON.stringify(command),
    });
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

### Device

Groups multiple entities under a shared lifecycle with one `init()`, coordinated polling, and shared data. Entity handles provide typed `update()`. This avoids the problem of independent sensors each fetching the same API or racing against shared state.

```typescript
// weather.ts — 12 sensors from one API, one fetch every 10 minutes

const API_URL =
  'https://api.open-meteo.com/v1/forecast?latitude=YOUR_LAT&longitude=YOUR_LON' +
  '&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,' +
  'cloud_cover,precipitation,wind_speed_10m,wind_gusts_10m,wind_direction_10m,pressure_msl' +
  '&daily=temperature_2m_max,temperature_2m_min,uv_index_max,precipitation_probability_max' +
  '&timezone=auto&forecast_days=1';

const WMO: Record<number, string> = {
  0: 'Clear', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Fog', 48: 'Rime fog',
  51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle',
  61: 'Light rain', 63: 'Rain', 65: 'Heavy rain',
  71: 'Light snow', 73: 'Snow', 75: 'Heavy snow',
  80: 'Light showers', 81: 'Showers', 82: 'Heavy showers',
  95: 'Thunderstorm', 96: 'Thunderstorm with hail',
};

export default device({
  id: 'open_meteo',
  name: 'Open-Meteo',
  entities: {
    condition:  sensor({ id: 'weather_condition',   name: 'Condition',   config: {} }),
    temp:       sensor({ id: 'weather_temperature', name: 'Temperature', config: { device_class: 'temperature', unit_of_measurement: '°C', state_class: 'measurement' } }),
    feelsLike:  sensor({ id: 'weather_feels_like',  name: 'Feels Like',  config: { device_class: 'temperature', unit_of_measurement: '°C', state_class: 'measurement' } }),
    humidity:   sensor({ id: 'weather_humidity',     name: 'Humidity',    config: { device_class: 'humidity', unit_of_measurement: '%', state_class: 'measurement' } }),
    wind:       sensor({ id: 'weather_wind_speed',   name: 'Wind Speed',  config: { device_class: 'wind_speed', unit_of_measurement: 'km/h', state_class: 'measurement' } }),
    gusts:      sensor({ id: 'weather_wind_gusts',   name: 'Wind Gusts',  config: { device_class: 'wind_speed', unit_of_measurement: 'km/h', state_class: 'measurement' } }),
    pressure:   sensor({ id: 'weather_pressure',     name: 'Pressure',    config: { device_class: 'pressure', unit_of_measurement: 'hPa', state_class: 'measurement' } }),
    cloud:      sensor({ id: 'weather_cloud_cover',  name: 'Cloud Cover', config: { unit_of_measurement: '%', state_class: 'measurement' } }),
    todayHigh:  sensor({ id: 'weather_today_high',   name: 'Today High',  config: { device_class: 'temperature', unit_of_measurement: '°C' } }),
    todayLow:   sensor({ id: 'weather_today_low',    name: 'Today Low',   config: { device_class: 'temperature', unit_of_measurement: '°C' } }),
    uvIndex:    sensor({ id: 'weather_uv_index',     name: 'UV Index',    config: { state_class: 'measurement' } }),
    rainChance: sensor({ id: 'weather_rain_chance',  name: 'Rain Chance', config: { unit_of_measurement: '%' } }),
  },
  init() {
    this.poll(async () => {
      const data = await this.fetch(API_URL).then(r => r.json());
      const c = data.current;
      const d = data.daily;

      this.entities.condition.update(WMO[c.weather_code] ?? 'Unknown');
      this.entities.temp.update(c.temperature_2m);
      this.entities.feelsLike.update(c.apparent_temperature);
      this.entities.humidity.update(c.relative_humidity_2m);
      this.entities.wind.update(c.wind_speed_10m);
      this.entities.gusts.update(c.wind_gusts_10m);
      this.entities.pressure.update(c.pressure_msl);
      this.entities.cloud.update(c.cloud_cover);
      this.entities.todayHigh.update(d.temperature_2m_max[0]);
      this.entities.todayLow.update(d.temperature_2m_min[0]);
      this.entities.uvIndex.update(d.uv_index_max[0]);
      this.entities.rainChance.update(d.precipitation_probability_max[0]);
    }, { interval: 600_000 });
  },
});
```

Compare this with the [manual device grouping](#device-grouping) approach — each sensor there has its own `init()` and `poll()`, so either every sensor fetches the API independently, or they share a module-level cache variable that races against poll timing. `device()` solves both problems: one fetch, one poll, all updates in one place.

### Computed

Derived sensor whose state is a pure function of other entities. No `init()`, no polling — re-evaluates reactively when inputs change.

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

Computed entities can watch other computed entities (DAG). Rapid input changes are debounced (default 100ms) and state is only published when the computed value actually differs.

#### Computed Attributes

Any entity can have reactive attributes alongside static ones:

```typescript
export const temp = sensor({
  id: 'cpu_temp',
  name: 'CPU Temperature',
  config: { device_class: 'temperature', unit_of_measurement: '°C' },
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

### Mode

State machines surfaced as `select` entities in HA. Define named states with enter/exit transition hooks and optional guards.

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
      // Block transition to 'away' from 'sleep'
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

The mode appears as a dropdown in the HA UI. Other scripts can react to mode changes via `this.events.on('select.house_mode', ...)`. Guards return `false` to block a transition — the UI reverts automatically.

### Cron

Schedule entities surfaced as `binary_sensor` — ON during matching cron windows, OFF otherwise.

```typescript
export const workHours = cron({
  id: 'work_hours',
  name: 'Work Hours',
  schedule: '0 9-17 * * 1-5',  // weekdays 9am–5pm
});

export const overnight = cron({
  id: 'overnight',
  name: 'Overnight',
  schedule: '0 23-6 * * *',  // 11pm–6am daily
});
```

Usable as a dependency in `computed()`, `this.events.on()`, or as a condition in automations — any pattern that reacts to `binary_sensor` state changes.

### Automation

Pure reactive scripts with managed lifecycle. No HA entity created by default — automations just react to things.

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

Set `entity: true` to surface as a `binary_sensor` in HA (ON = running, OFF = errored). Automations get `this.ha`, `this.events`, and `this.log` but don't publish state themselves.

### Task

One-shot scripts surfaced as button entities in HA. Press the button to trigger `run()`.

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

Use `runOnDeploy: true` to also execute on deploy. Tasks get `this.ha`, `this.log`, and `this.mqtt` but no event subscriptions.

## Reactive Patterns

Inside `init()`, use `this.events` for lifecycle-managed subscriptions that auto-cleanup on teardown. The global `ha` object provides stateless access for simple cases.

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

// Subscribe to multiple entities
this.events.on(['sensor.temp_indoor', 'sensor.temp_outdoor'], (e) => {
  this.log.info(`${e.entity_id}: ${e.new_state}`);
});
```

### Calling Services

```typescript
this.ha.callService('light.kitchen', 'turn_on', { brightness: 255 });
this.ha.callService('notify.mobile_app_phone', 'send_message', {
  message: 'Motion detected!',
});
```

### Declarative Reactions

Set up reaction rules with typed entity IDs. Delayed reactions auto-cancel if state changes again.

```typescript
this.events.reactions({
  'binary_sensor.front_door': {
    to: 'on',
    do: () => this.ha.callService('light.porch', 'turn_on', { brightness: 255 }),
  },
  'binary_sensor.garage_door': {
    to: 'on',
    after: 600_000, // 10 minutes
    do: () => {
      this.ha.callService('cover.garage', 'close_cover');
      this.ha.callService('notify.mobile_app_phone', 'send_message', {
        message: 'Garage was open for 10 minutes — closing.',
      });
    },
  },
});
```

### Querying State

```typescript
const state = await this.ha.getState('sensor.outdoor_temperature');
if (state && Number(state.state) < 5) {
  this.ha.callService('climate.living_room', 'set_temperature', {
    temperature: 22,
  });
}
```

### Stream Operators

`this.events.on()` returns a composable `EventStream` with chainable operators:

```typescript
// Debounce — only react after state stabilizes for 5 seconds
this.events.on('binary_sensor.motion')
  .debounce(5000)
  .filter((e) => e.new_state === 'off')
  .do((e) => {
    this.ha.callService('light.hallway', 'turn_off');
  });

// Throttle — limit to one notification per minute
this.events.on('sensor.cpu_temp')
  .throttle(60_000)
  .filter((e) => Number(e.new_state) > 80)
  .do((e) => {
    this.ha.callService('notify.phone', 'send_message', {
      message: `CPU at ${e.new_state}°C`,
    });
  });

// Transition — react only to specific state changes
this.events.on('alarm_control_panel.home')
  .transition('armed_away', 'triggered')
  .do(() => {
    this.ha.callService('notify.all', 'send_message', {
      message: 'Alarm triggered!',
    });
  });
```

Available operators: `.filter()`, `.map()`, `.debounce(ms)`, `.throttle(ms)`, `.distinctUntilChanged()`, `.transition(from, to)`.

### Combine / With State

Subscribe to multiple entities or enrich events with context:

```typescript
// Combine — fire when any input changes, receive all snapshots
this.events.combine(
  ['sensor.temperature', 'sensor.humidity'],
  (states) => {
    const temp = Number(states['sensor.temperature']?.state);
    const humidity = Number(states['sensor.humidity']?.state);
    this.log.info(`Temp: ${temp}, Humidity: ${humidity}`);
  },
);

// WithState — enrich a trigger event with context entity snapshots
// Silently skips when any context entity is unavailable/unknown
this.events.withState(
  'binary_sensor.motion',
  ['sensor.light_level', 'input_boolean.away_mode'],
  (event, states) => {
    const lightLevel = Number(states['sensor.light_level'].state);
    const awayMode = states['input_boolean.away_mode'].state;
    if (event.new_state === 'on' && lightLevel < 50 && awayMode === 'off') {
      this.ha.callService('light.hallway', 'turn_on');
    }
  },
);
```

### Watchdog

React to things that *should* happen but don't. Fires when an expected event doesn't arrive within a time window.

```typescript
this.events.watchdog({
  'sensor.weather_station': {
    expect: 'change',        // any state change
    within: 3_600_000,       // 1 hour
    else: () => {
      this.ha.callService('notify.phone', 'send_message', {
        message: 'Weather station has gone silent for 1 hour',
      });
    },
  },
  'binary_sensor.garage': {
    expect: { to: 'off' },   // expect it to close
    within: 600_000,          // 10 minutes
    else: () => {
      this.ha.callService('cover.garage', 'close_cover');
    },
  },
});
```

`expect` accepts `'change'` (any), `{ to: 'state' }` (specific), or a predicate function. The timer resets on matching activity and restarts after firing.

### Invariant

Declare constraints that must always hold. Continuously monitored, acted on when violated.

```typescript
this.events.invariant({
  name: 'safe_temperature',
  condition: async () => {
    const state = await this.ha.getState('sensor.server_room_temp');
    return state !== null && Number(state.state) < 35;
  },
  check: { interval: 60_000 },  // check every minute
  violated: () => {
    this.ha.callService('notify.ops', 'send_message', {
      message: 'Server room temperature exceeded 35°C!',
    });
    this.ha.callService('switch.server_room_fan', 'turn_on');
  },
});
```

### Sequence

Detect ordered events across multiple entities within time windows.

```typescript
this.events.sequence({
  name: 'arrival_pattern',
  steps: [
    { entity: 'binary_sensor.driveway_motion', to: 'on', within: 0 },
    { entity: 'binary_sensor.front_door', to: 'on', within: 120_000 },
    { entity: 'lock.front_door', to: 'unlocked', within: 30_000 },
  ],
  do: () => {
    this.ha.callService('light.entryway', 'turn_on', { brightness: 255 });
    this.ha.callService('climate.main', 'set_hvac_mode', { hvac_mode: 'auto' });
  },
});
```

Steps must complete in order. Each step's `within` is the max time after the previous step. The sequence auto-resets on timeout. Use `negate: true` on a step to match when an event does *not* happen within the window.

### Utility

```typescript
// Get friendly name from HA state cache
const name = this.ha.friendlyName('light.kitchen'); // 'Kitchen Light'

// List all entities in a domain
const lights = await this.ha.getEntities('light');
```

## Entity Context (`this`)

Inside `init()`, `destroy()`, and `onCommand()`, `this` provides:

| Property | Description |
|---|---|
| `this.update(value, attrs?)` | Publish new state (and optional attributes) to HA |
| `this.attr(attributes)` | Update attributes without changing state |
| `this.poll(fn, { interval })` | Start a polling loop (auto-cleaned on teardown) |
| `this.log` | Scoped logger — `debug`, `info`, `warn`, `error` |
| `this.ha` | Stateless HA client — `callService()`, `getState()`, `getEntities()`, `fireEvent()`, `friendlyName()` |
| `this.events` | Scoped reactive subscriptions — `on()`, `reactions()`, `combine()`, `withState()`, `watchdog()`, `invariant()`, `sequence()` |
| `this.fetch` | Standard `fetch()` for HTTP requests |
| `this.setTimeout(fn, ms)` | One-shot timer (auto-cleaned on teardown) |
| `this.setInterval(fn, ms)` | Repeating timer (auto-cleaned on teardown) |
| `this.mqtt.publish(topic, payload)` | Publish to an arbitrary MQTT topic |
| `this.mqtt.subscribe(topic, handler)` | Subscribe to an MQTT topic (auto-cleaned on teardown) |

## Supported Entity Types

The SDK provides factory functions for all common HA entity platforms:

| Function | Entity type |
|---|---|
| `sensor()` | Read-only sensor |
| `binarySensor()` | Two-state sensor (on/off) |
| `defineSwitch()` | On/off switch |
| `light()` | Light with brightness/color |
| `cover()` | Cover (blind, garage door, curtain) |
| `climate()` | Climate (thermostat, AC, heater) |
| `fan()` | Fan with speed/direction |
| `lock()` | Lock/unlock/open |
| `number()` | Numeric input with min/max |
| `select()` | Dropdown selection |
| `text()` | Text input |
| `button()` | Momentary button (command only) |
| `siren()` | Siren/alarm control |
| `humidifier()` | Humidity control |
| `valve()` | Water/gas valve |
| `waterHeater()` | Water heater with temperature |
| `vacuum()` | Robot vacuum |
| `lawnMower()` | Robotic mower |
| `alarmControlPanel()` | Security system arm/disarm |
| `notify()` | Notification target |
| `update()` | Update availability indicator |
| `image()` | Static image entity |

Higher-level constructs:

| Function | Description |
|---|---|
| `computed()` | Derived sensor — state is a pure function of other entities |
| `mode()` | State machine — select entity with enter/exit/guard transitions |
| `cron()` | Schedule — binary_sensor ON/OFF based on cron expression |
| `automation()` | Pure reactive script with managed lifecycle |
| `task()` | One-shot script surfaced as a button entity |
| `device()` | Groups entities under a shared lifecycle |
| `entityFactory()` | Dynamic entity generation at runtime |

## Web Editor

The add-on includes a browser-based Monaco editor accessible via the HA ingress panel:

- Full TypeScript IntelliSense with types generated from your HA instance
- File tree with create, edit, rename, and delete
- Build button with output console
- Entity dashboard showing deployed entities and their state
- Log viewer with level, entity, and search filters
- Real-time updates via WebSocket

## Architecture

- **Add-on**: Node.js LTS in Docker on HAOS. Connects to Mosquitto (MQTT) and HA WebSocket API.
- **Editor**: Ingress-based Monaco editor with full IntelliSense.
- **Transport**: MQTT discovery for 25 entity platforms.
- **Health monitoring**: Scheduled type validation detects HA registry drift. Health entities (`binary_sensor.ha_forge_build_healthy`) can trigger HA automations on breakage.

## Requirements

- Home Assistant OS with Mosquitto MQTT broker add-on
- Node.js LTS (bundled in the add-on container)

## Documentation

See [SPEC.md](SPEC.md) for the full technical specification and [TODO.md](TODO.md) for known issues and planned features.

Architecture docs live in `docs/architecture/`.
