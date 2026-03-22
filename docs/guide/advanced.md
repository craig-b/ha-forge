# Advanced Patterns

## Entity Factory

`entityFactory()` generates entities dynamically at deploy time. The factory function can be async, make network calls, query HA, and return any number of entity definitions.

### Dynamic Discovery

Discover devices on the network and create entities for each:

```typescript
import { entityFactory, sensor } from 'ha-forge';

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

### Adapting to HA

Query the HA installation and create entities based on what exists:

```typescript
import { entityFactory, sensor } from 'ha-forge';

export default entityFactory(async () => {
  const lights = await ha.getEntities('light');
  return lights.map((id) =>
    sensor({
      id: `${id.replace('.', '_')}_daily_usage`,
      name: `${ha.friendlyName(id)} Daily Usage`,
      config: { unit_of_measurement: 'hours', state_class: 'total_increasing' },
      init() {
        let onMinutes = 0;
        this.events.on(id, (e) => {
          if (e.new_state === 'on') this.update((onMinutes += 1) / 60);
        });
        return 0;
      },
    })
  );
});
```

This creates a usage-tracking sensor for every light in the installation. Adding or removing lights in HA and rebuilding automatically adjusts the entity set.

## Computed Entities

`computed()` creates a derived sensor whose state is a pure function of watched entities. It re-evaluates reactively whenever any watched entity changes, with built-in debouncing (100ms default) and change detection (only publishes when the value actually changes).

### Basic Usage

```typescript
import { computed } from 'ha-forge';

export const avgTemp = computed({
  id: 'house_avg_temp',
  name: 'House Average Temperature',
  config: {
    device_class: 'temperature',
    unit_of_measurement: '°C',
    state_class: 'measurement',
  },
  watch: ['sensor.bedroom_temp', 'sensor.living_room_temp', 'sensor.kitchen_temp'],
  compute: (states) => {
    const temps = Object.values(states)
      .map((s) => Number(s?.state))
      .filter((n) => !isNaN(n));
    return temps.length ? Math.round((temps.reduce((a, b) => a + b) / temps.length) * 10) / 10 : 0;
  },
});
```

### Custom Debounce

When multiple watched entities change in quick succession (e.g., a group of sensors updating at the same time), the debounce prevents redundant re-evaluations:

```typescript
export const totalPower = computed({
  id: 'total_power',
  name: 'Total Power',
  config: { device_class: 'power', unit_of_measurement: 'W' },
  watch: ['sensor.grid_power', 'sensor.solar_power'],
  debounce: 500, // wait 500ms for both to settle
  compute: (states) => {
    const grid = Number(states['sensor.grid_power']?.state ?? 0);
    const solar = Number(states['sensor.solar_power']?.state ?? 0);
    return grid + solar;
  },
});
```

### Lazy Evaluation

By default, computed entities fetch the current state of all watched entities and evaluate immediately on init. Set `lazy: true` to defer evaluation until a watched entity actually changes:

```typescript
export const motion = computed({
  id: 'any_motion',
  name: 'Any Motion Detected',
  watch: ['binary_sensor.hall_motion', 'binary_sensor.kitchen_motion'],
  lazy: true, // don't evaluate until a motion sensor fires
  compute: (states) => {
    return Object.values(states).some((s) => s?.state === 'on') ? 'on' : 'off';
  },
});
```

### With Behaviors

Computed entities are compatible with all behaviors (`buffered`, `debounced`, `filtered`, `sampled`):

```typescript
import { computed, buffered, average } from 'ha-forge';

// Smooth a computed value over 30-second windows
export const smoothedPower = buffered(
  computed({
    id: 'total_power_smooth',
    name: 'Total Power (Smoothed)',
    config: { device_class: 'power', unit_of_measurement: 'W' },
    watch: ['sensor.grid_power', 'sensor.solar_power'],
    compute: (states) => {
      const grid = Number(states['sensor.grid_power']?.state ?? 0);
      const solar = Number(states['sensor.solar_power']?.state ?? 0);
      return grid + solar;
    },
  }),
  { interval: 30_000, reduce: average },
);
```

### Computed Attributes

The `compute` function can return attributes alongside the state:

```typescript
export const hvacStatus = computed({
  id: 'hvac_status',
  name: 'HVAC Status',
  watch: ['climate.living_room', 'sensor.outdoor_temp'],
  compute: (states) => {
    const climate = states['climate.living_room'];
    const outdoor = Number(states['sensor.outdoor_temp']?.state ?? 0);
    const mode = climate?.state ?? 'off';
    return {
      state: mode,
      attributes: {
        outdoor_temp: outdoor,
        target_temp: climate?.attributes?.temperature,
        efficiency: outdoor < 0 ? 'low' : 'normal',
      },
    };
  },
});
```

## Cron Schedules

`cron()` creates a binary sensor that is ON during matching cron minutes and OFF otherwise. Useful for time-based automations.

```typescript
import { cron } from 'ha-forge';

export const businessHours = cron({
  id: 'business_hours',
  name: 'Business Hours',
  schedule: '* 9-17 * * 1-5', // 9am-5pm, Monday-Friday
});

export const quietHours = cron({
  id: 'quiet_hours',
  name: 'Quiet Hours',
  schedule: '* 22-23,0-6 * * *', // 10pm-7am
});
```

Use cron entities in automations to gate time-based logic:

```typescript
import { automation } from 'ha-forge';

export const nightDoorbell = automation({
  id: 'night_doorbell',
  name: 'Night Doorbell',
  init() {
    this.events.withState(
      'binary_sensor.doorbell',
      ['binary_sensor.quiet_hours'],
      (event, states) => {
        if (event.new_state === 'on' && states['binary_sensor.quiet_hours']?.state === 'on') {
          this.ha.callService('light.bedroom', 'turn_on', { brightness: 50 });
        }
      },
    );
  },
});
```

## Mode (State Machines)

`mode()` creates a select entity backed by a state machine. States have `enter`/`exit` hooks and `guard` functions that can prevent transitions.

```typescript
import { mode } from 'ha-forge';

export const houseMode = mode({
  id: 'house_mode',
  name: 'House Mode',
  states: {
    home: {
      enter() {
        this.ha.callService('climate.living_room', 'set_temperature', { temperature: 22 });
        this.ha.callService('light.porch', 'turn_on');
      },
    },
    away: {
      guard: async () => {
        const doors = await ha.getState('group.all_doors');
        return doors.state === 'off'; // all doors must be closed
      },
      enter() {
        this.ha.callService('climate.living_room', 'set_temperature', { temperature: 16 });
        this.ha.callService('light.all', 'turn_off');
      },
    },
    sleeping: {
      enter() {
        this.ha.callService('light.all', 'turn_off');
        this.ha.callService('lock.front_door', 'lock');
      },
      exit() {
        this.ha.callService('light.hallway', 'turn_on', { brightness: 30 });
      },
    },
    vacation: {
      guard: () => houseMode.current === 'away', // can only enter from 'away'
      enter() {
        this.ha.callService('switch.water_main', 'turn_off');
      },
    },
  },
  initial: 'home',
});
```

In HA, this appears as `select.house_mode` with options `home`, `away`, `sleeping`, and `vacation`. Selecting a state in the HA UI triggers the guard check, then the exit hook of the current state, then the enter hook of the new state.

## Health Monitoring

HA Forge registers two health entities for itself:

- **`binary_sensor.ha_forge_build_healthy`** -- ON when all scripts compile cleanly, OFF when type errors exist.
- **`sensor.ha_forge_type_errors`** -- error count, with error details in attributes.

### Scheduled Validation

On a configurable schedule (default: hourly, via `validation_schedule_minutes`), the runtime:

1. Pulls the current HA entity registry.
2. Regenerates types into a temporary directory.
3. Runs `tsc --noEmit` against your scripts with the new types.
4. Updates the health entities.

This detects when HA changes (entity renames, removed helpers, changed options) break your scripts, without touching the running instance.

### HA Automation Example

Notify when scripts break due to HA registry changes:

```yaml
trigger:
  - platform: state
    entity_id: binary_sensor.ha_forge_build_healthy
    to: 'off'
action:
  - service: notify.mobile_app
    data:
      title: "HA Forge: Build Broken"
      message: >
        {{ state_attr('sensor.ha_forge_type_errors', 'errors') | length }}
        type error(s) detected after HA registry change.
```

### Auto-Rebuild

With `auto_rebuild_on_registry_change` enabled, the runtime automatically triggers a full build when scheduled validation passes with updated types. If validation fails, it keeps the old build running and flips the health sensor to unhealthy.

## Direct MQTT Access

Every entity context has `this.mqtt` for direct MQTT operations outside the managed entity state:

```typescript
import { automation } from 'ha-forge';

export const bridge = automation({
  id: 'zigbee_bridge',
  name: 'Zigbee Bridge',
  init() {
    this.mqtt.subscribe('zigbee2mqtt/+/state', (payload) => {
      this.log.info('Zigbee state', { payload });
    });

    this.mqtt.publish('zigbee2mqtt/bridge/config', JSON.stringify({
      log_level: 'warn',
    }), { retain: true });
  },
});
```

MQTT subscriptions created through `this.mqtt` are lifecycle-managed and cleaned up on teardown.

## npm Packages

Your scripts directory contains a `package.json` (scaffolded on first run). To add a package:

1. Edit `package.json` directly in the editor, adding the package to `dependencies`.
2. Click **Build**. The pipeline runs `npm install` when it detects changes to `package.json`.
3. After install, types from the package are injected into the editor for IntelliSense.

esbuild bundles your code with all dependencies into self-contained output, so packages work at runtime without any module resolution concerns.

A dedicated package management UI (search npm, add/remove packages) is planned for a future release.

## Cron Polling

In addition to fixed-interval polling, `this.poll()` supports cron expressions:

```typescript
this.poll(async () => {
  const r = await fetch('https://api.example.com/data');
  return (await r.json()).value;
}, { cron: '*/5 * * * *' }); // every 5 minutes
```

This is useful when you need polling aligned to wall-clock time rather than relative intervals.
