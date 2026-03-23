# Entity Types

HA Forge provides factory functions for 22 entity platforms plus 7 higher-level constructs. Every entity definition must be exported from a `.ts` file. The runtime ignores unexported definitions.

All entity definitions share a common shape:

```typescript
{
  id: string;          // Unique ID (prefixed with ha_forge_)
  name: string;        // Display name
  device?: DeviceInfo; // Optional device grouping
  category?: 'config' | 'diagnostic';
  icon?: string;       // MDI icon override
  config?: {};         // Platform-specific MQTT discovery fields
  init?(): State;      // Setup function, return value is initial state
  destroy?(): void;    // Cleanup function
}
```

## Read-Only Entities

### sensor

Reports a value to HA. The most common entity type.

```typescript
export const cpuTemp = sensor({
  id: 'cpu_temp',
  name: 'CPU Temperature',
  config: {
    device_class: 'temperature',
    unit_of_measurement: '°C',
    state_class: 'measurement',
    suggested_display_precision: 1,
  },
  init() {
    this.poll(async () => {
      const r = await fetch('http://localhost:9100/metrics');
      return parseCpuTemp(await r.text());
    }, { interval: 10_000 });
    return 0;
  },
});
```

State type: `string | number`. Config options include `device_class` (70+ classes like `temperature`, `humidity`, `energy`, `power`), `unit_of_measurement`, and `state_class` (`measurement`, `total`, `total_increasing`).

### binarySensor

Two-state sensor: on or off.

```typescript
export const motion = binarySensor({
  id: 'office_motion',
  name: 'Motion',
  config: { device_class: 'motion' },
  init() {
    this.poll(checkMotionSensor, { interval: 1_000 });
    return 'off';
  },
});
```

State type: `'on' | 'off'`. Device classes include `motion`, `door`, `window`, `moisture`, `smoke`, `battery`, and 20+ others.

### image

Serves an image URL to HA.

```typescript
export const snapshot = image({
  id: 'garden_snapshot',
  name: 'Garden Camera',
  init() {
    this.poll(async () => {
      return 'http://192.168.1.100/snapshot.jpg';
    }, { interval: 60_000 });
    return 'http://192.168.1.100/snapshot.jpg';
  },
});
```

## Controllable Entities

These entities accept commands from HA via MQTT. All have an `onCommand()` callback.

### defineSwitch

On/off control. Named `defineSwitch` because `switch` is a reserved word in JavaScript.

```typescript
export const heater = defineSwitch({
  id: 'space_heater',
  name: 'Space Heater',
  config: { device_class: 'outlet' },
  onCommand(command) {
    // command: 'ON' | 'OFF'
    setRelay(1, command === 'ON');
    this.update(command === 'ON' ? 'on' : 'off');
  },
  init() { return 'off'; },
});
```

State type: `'on' | 'off'`. Command type: `'ON' | 'OFF'`.

### light

Supports brightness, color modes, effects, and transitions.

```typescript
export const desk = light({
  id: 'desk_light',
  name: 'Desk Light',
  config: {
    supported_color_modes: ['rgb', 'brightness'],
    effect_list: ['rainbow', 'breathe'],
  },
  onCommand(cmd) {
    // cmd.state: 'ON' | 'OFF'
    // cmd.brightness?: number (1-255)
    // cmd.color?: { r, g, b }
    // cmd.effect?: 'rainbow' | 'breathe'
    // cmd.transition?: number (seconds)
    sendToLedController(cmd);
  },
});
```

Color modes: `onoff`, `brightness`, `color_temp`, `hs`, `rgb`, `rgbw`, `rgbww`, `xy`, `white`.

### cover

Garage doors, blinds, curtains. Supports position and tilt.

```typescript
export const blinds = cover({
  id: 'living_room_blinds',
  name: 'Blinds',
  config: { device_class: 'blind', position: true, tilt: true },
  onCommand(cmd) {
    // cmd.action: 'open' | 'close' | 'stop' | 'set_position' | 'set_tilt'
    // cmd.position?: number (when action is 'set_position')
    // cmd.tilt?: number (when action is 'set_tilt')
    sendToBlindController(cmd);
  },
  init() { return 'closed'; },
});
```

### climate

HVAC control with modes, fan speed, presets, and temperature targets.

```typescript
export const hvac = climate({
  id: 'bedroom_climate',
  name: 'Bedroom',
  config: {
    hvac_modes: ['off', 'heat', 'cool'],
    min_temp: 16,
    max_temp: 30,
    temp_step: 0.5,
  },
  onCommand(cmd) {
    // cmd.hvac_mode?: 'off' | 'heat' | 'cool'
    // cmd.temperature?: number
    // cmd.fan_mode?: string
    setThermostat(cmd);
  },
});
```

### fan

Fan speed, direction, preset modes, and oscillation.

```typescript
export const ceilingFan = fan({
  id: 'ceiling_fan',
  name: 'Ceiling Fan',
  config: {
    speed_range_min: 1,
    speed_range_max: 6,
    preset_modes: ['breeze', 'sleep'],
  },
  onCommand(cmd) {
    // cmd.state?: 'ON' | 'OFF'
    // cmd.percentage?: number (0-100)
    // cmd.preset_mode?: 'breeze' | 'sleep'
    sendToFanController(cmd);
  },
});
```

### lock

Lock/unlock control with optional code.

```typescript
export const frontDoor = lock({
  id: 'front_door_lock',
  name: 'Front Door',
  onCommand(cmd) {
    // cmd: 'LOCK' | 'UNLOCK'
    sendToSmartLock(cmd);
    this.update(cmd === 'LOCK' ? 'locked' : 'unlocked');
  },
  init() { return 'locked'; },
});
```

### number

Numeric input with min/max/step.

```typescript
export const brightness = number({
  id: 'led_brightness',
  name: 'LED Brightness',
  config: { min: 0, max: 100, step: 5, unit_of_measurement: '%' },
  onCommand(value) {
    setLedBrightness(value);
    this.update(value);
  },
  init() { return 50; },
});
```

### select

Dropdown selection from a list of options.

```typescript
export const scene = select({
  id: 'led_scene',
  name: 'LED Scene',
  config: { options: ['relax', 'focus', 'party', 'off'] },
  onCommand(option) {
    setLedScene(option);
    this.update(option);
  },
  init() { return 'off'; },
});
```

### text

Free-form text input.

```typescript
export const message = text({
  id: 'display_message',
  name: 'Display Message',
  config: { min: 0, max: 64 },
  onCommand(value) {
    sendToDisplay(value);
    this.update(value);
  },
  init() { return ''; },
});
```

### button

Command-only entity with no state. Triggers an action on press.

```typescript
export const reboot = button({
  id: 'reboot_server',
  name: 'Reboot Server',
  onPress() {
    fetch('http://server.local/api/reboot', { method: 'POST' });
  },
});
```

## Other Platforms

These follow the same pattern -- a typed `config` object and `onCommand()` callback. Brief summaries:

| Factory | Platform | Description |
|---|---|---|
| `siren` | Siren | Alarm siren with tone/volume/duration control |
| `humidifier` | Humidifier | Humidity target with modes |
| `valve` | Valve | Open/close/position control for valves |
| `waterHeater` | Water Heater | Temperature control with operation modes |
| `vacuum` | Vacuum | Start/stop/dock/locate commands |
| `lawnMower` | Lawn Mower | Start/pause/dock commands |
| `alarmControlPanel` | Alarm | Arm/disarm with modes (home, away, night) |
| `notify` | Notify | Write-only notification target |
| `update` | Update | Firmware update entity with version tracking |

## Higher-Level Constructs

These are not direct MQTT platforms. They provide higher-level abstractions built on top of the platform entities.

### device

Groups entities under a shared lifecycle with coordinated init/destroy and cross-entity access.

```typescript
export default device({
  id: 'weather_station',
  name: 'Weather Station',
  manufacturer: 'DIY',
  entities: {
    temp: sensor({
      id: 'ws_temp',
      name: 'Temperature',
      config: { device_class: 'temperature', unit_of_measurement: '°C' },
    }),
    fan: defineSwitch({
      id: 'ws_fan',
      name: 'Cooling Fan',
    }),
  },
  init() {
    // this.entities.temp and this.entities.fan are available
    this.poll(async () => {
      const reading = await readWeatherStation();
      this.entities.temp.update(reading.temperature);
      if (reading.temperature > 40) {
        this.entities.fan.update('on');
      }
    }, { interval: 10_000 });
  },
});
```

### computed

Derived sensor whose state is a pure function of other entities. Re-evaluates reactively, debounced (100ms default), and only publishes when the value changes.

```typescript
export const comfortIndex = computed({
  id: 'comfort_index',
  name: 'Comfort Index',
  config: { state_class: 'measurement' },
  watch: ['sensor.indoor_temp', 'sensor.indoor_humidity'],
  compute: (states) => {
    const temp = Number(states['sensor.indoor_temp']?.state ?? 20);
    const rh = Number(states['sensor.indoor_humidity']?.state ?? 50);
    return Math.round(temp + 0.5 * (rh - 40));
  },
});
```

### automation

Pure reactive script with managed lifecycle. Does not create a visible entity by default. Set `entity: true` to surface it as a binary sensor.

```typescript
export const nightMode = automation({
  id: 'night_lights',
  init() {
    this.events.on('binary_sensor.front_door', (e) => {
      if (e.new_state === 'on') {
        this.ha.callService('light.porch', 'turn_on');
      }
    });
  },
});
```

### cron

Schedule entity surfaced as a binary sensor. ON during matching cron minutes, OFF otherwise.

```typescript
export const businessHours = cron({
  id: 'business_hours',
  name: 'Business Hours',
  schedule: '* 9-17 * * 1-5', // 9am-5pm weekdays
});
```

### task

One-shot script surfaced as a button entity. `run()` is triggered on button press. Set `runOnDeploy: true` to also execute on deploy. Gets `this.ha`, `this.log`, `this.mqtt` but no `this.events`.

```typescript
export const cleanup = task({
  id: 'daily_cleanup',
  name: 'Daily Cleanup',
  async run() {
    this.log.info('Running cleanup');
    await this.ha.callService('input_boolean.maintenance_mode', 'turn_on');
    // ... cleanup logic
    await this.ha.callService('input_boolean.maintenance_mode', 'turn_off');
  },
});
```

### mode

State machine surfaced as a select entity. `states` is a string array of valid modes, and `transitions` is a separate object keyed by state name with optional `enter`/`exit`/`guard` hooks.

```typescript
export const houseMode = mode({
  id: 'house_mode',
  name: 'House Mode',
  states: ['home', 'away', 'sleeping'],
  initial: 'home',
  transitions: {
    home: {
      enter() { /* lights on, heating normal */ },
      exit() { /* ... */ },
    },
    away: {
      guard() { return allDoorsLocked(); }, // must return true to allow transition
      enter() { /* lights off, heating low */ },
    },
    sleeping: {
      enter() { /* dim lights, lock doors */ },
    },
  },
});
```

### entityFactory

Generates entities dynamically at deploy time. The factory function is async and returns an array of entity definitions.

```typescript
export default entityFactory(async () => {
  const devices = await discoverModbusDevices('/dev/ttyUSB0');
  return devices.map((d) =>
    sensor({
      id: `modbus_${d.address}`,
      name: d.name,
      config: { device_class: d.class, unit_of_measurement: d.unit },
      init() {
        this.poll(() => readModbusRegister(d.address, d.register), { interval: 10_000 });
        return 0;
      },
    })
  );
});
```

## Common Patterns

### Entity Naming

Following HA's `has_entity_name` convention, the entity `name` describes the data point (e.g., "Temperature"), and the device name is prepended automatically in HA's UI. If your device is named "Weather Station" and the entity name is "Temperature", HA shows "Weather Station Temperature".

### init() and destroy()

`init()` is called after the entity is registered with HA. Use it to start polling, set up subscriptions, or do async setup. The return value is the initial state.

`destroy()` is called during teardown (rebuild or shutdown). Use it for explicit cleanup. You rarely need it -- timers, polls, and subscriptions created through the entity context are cleaned up automatically.

### Device Grouping

Entities are grouped into HA devices by:

1. **Explicit `device` config**: All entities sharing the same `device.id` go into one device.
2. **File-based grouping**: Entities in the same file without explicit device config are grouped under a device named after the file.
3. **`device()` construct**: Use the `device()` higher-level entity for coordinated lifecycle.
