# SDK

The SDK is the TypeScript API that user scripts import. It provides entity definition functions, the `ha.*` API for interacting with Home Assistant, and a generated type registry that makes everything type-safe.

## Type System

### HAEntityMap

The generated type registry maps every entity ID in the HA installation to its domain, state type, attributes, and available services:

```typescript
type HAEntityMap = {
  'light.living_room': {
    domain: 'light';
    state: 'on' | 'off';
    attributes: {
      brightness: NumberInRange<0, 255>;
      color_temp: NumberInRange<153, 500>;
      rgb_color: [number, number, number];
      friendly_name: string;
    };
    services: {
      turn_on: {
        brightness?: NumberInRange<0, 255>;
        color_temp?: NumberInRange<153, 500>;
        rgb_color?: [number, number, number];
        transition?: NumberInRange<0, 300>;
        flash?: 'short' | 'long';
        effect?: string;
      };
      turn_off: { transition?: NumberInRange<0, 300> };
      toggle: {};
    };
  };
  // ... every entity, helper, and group
};
```

### Utility Types

```typescript
// All entity IDs as a union
type HAEntityId = keyof HAEntityMap;

// All domains as a union
type HADomain = HAEntityMap[HAEntityId]['domain'];

// Entity IDs filtered to a specific domain
type EntitiesInDomain<D extends HADomain> = {
  [K in HAEntityId]: HAEntityMap[K]['domain'] extends D ? K : never;
}[HAEntityId];
```

### NumberInRange — Branded Numeric Types

TypeScript has no native numeric range type. The SDK uses branded types to encode constraints at the type level:

```typescript
type NumberInRange<Min extends number, Max extends number> = number & {
  readonly __min: Min;
  readonly __max: Max;
  readonly __brand: 'RangeValidated';
};
```

A raw `number` cannot be assigned where `NumberInRange<0, 255>` is expected. Values must pass through a validator to obtain the branded type.

### What Gets Typed

- **Entity IDs**: All entity IDs across all domains as string literal unions.
- **State values**: Literal unions where possible (`'on' | 'off'` for switches, configured options for `input_select`). `string` where state is freeform (sensors).
- **Attributes**: Per entity, with constrained numeric ranges where HA metadata provides min/max.
- **Services**: Per domain with typed parameters. Numeric fields carry `NumberInRange` constraints. Select fields use string literal unions. Required fields are non-optional.
- **Helper entities**: `input_boolean`, `input_number`, `input_select`, `input_text`, `input_datetime`, `counter`, `timer` — all with their configured constraints.
- **Groups, areas, labels**: String literal types for filtering.

### Fallback for Unknown Selectors

New selector types added in future HA versions fall back to `unknown`. This ensures the generated types always compile, even if the type generator hasn't been updated for a new selector type. The runtime validator for unknown selectors is a pass-through.

## Runtime Validators

Generated alongside types from the same selector metadata. Types and validators are always in sync.

### Validator Functions

```typescript
function rangeValidator<Min extends number, Max extends number>(min: Min, max: Max) {
  return (value: number): NumberInRange<Min, Max> => {
    if (typeof value !== 'number' || value < min || value > max) {
      throw new RangeError(`Expected number in range ${min}–${max}, got ${value}`);
    }
    return value as NumberInRange<Min, Max>;
  };
}

function oneOfValidator<T extends readonly string[]>(options: T) {
  return (value: string): T[number] => {
    if (!options.includes(value)) {
      throw new TypeError(`Expected one of [${options.join(', ')}], got '${value}'`);
    }
    return value as T[number];
  };
}

function rgbValidator() {
  return (value: unknown): [number, number, number] => {
    if (!Array.isArray(value) || value.length !== 3 ||
        !value.every((v) => typeof v === 'number' && v >= 0 && v <= 255)) {
      throw new TypeError(`Expected [r, g, b] with values 0–255, got ${JSON.stringify(value)}`);
    }
    return value as [number, number, number];
  };
}
```

### Two Modes of Use

**Strict mode (opt-in):** User explicitly validates values. The compiler enforces it — passing a raw `number` where `NumberInRange` is expected is a type error.

```typescript
import { validators } from '.generated/ha-validators';

const brightness = validators['light.turn_on'].brightness(userInput);
ha.callService('light.living_room', 'turn_on', { brightness }); // compiles
```

**Convenience mode (default):** `ha.callService()` accepts raw values and validates internally before sending to HA. Service parameter types accept `number` (not branded) in this mode. The runtime still throws on invalid input with a descriptive error.

```typescript
ha.callService('light.living_room', 'turn_on', {
  brightness: 200,  // accepted, validated at runtime
});

ha.callService('light.living_room', 'turn_on', {
  brightness: 999,  // compiles, throws RangeError at runtime
});
```

Both modes use the same underlying validators. Strict mode catches errors at compile time. Convenience mode catches them at runtime with descriptive messages logged to SQLite.

### Using Validators Directly

Validators are also useful for validating external input in entity scripts:

```typescript
import { validators } from '.generated/ha-validators';

const level = readAnalogInput();
try {
  const brightness = validators['light.turn_on'].brightness(level);
  ha.callService('light.living_room', 'turn_on', { brightness });
} catch (e) {
  this.log.warn('Invalid brightness from analog input', { level, error: e.message });
}
```

## Entity Definition API

### Base Interface

```typescript
interface DeviceInfo {
  id: string;
  name: string;
  manufacturer?: string;
  model?: string;
  sw_version?: string;
  suggested_area?: string;
}

interface BaseEntity<TState, TConfig = {}> {
  id: string;
  name: string;
  type: EntityType;
  device?: DeviceInfo;
  category?: 'config' | 'diagnostic';
  icon?: string;
  config?: TConfig;
  init?: () => TState | Promise<TState>;
  destroy?: () => void | Promise<void>;
}
```

- **`id`**: Becomes the entity's unique ID (prefixed with `ha_forge_`) and the default entity ID in HA.
- **`name`**: Entity name. Following HA's `has_entity_name` convention, this describes the data point (e.g., "Temperature"), and the device name is prepended automatically in HA's UI.
- **`device`**: Groups entities into a device for HA's device registry. Entities sharing the same `device.id` appear together in HA.
- **`category`**: Maps to HA's entity category. `'config'` for settings entities, `'diagnostic'` for read-only diagnostics. `undefined` (default) for primary entities.

### Entity Types

#### Sensor (Read-Only)

```typescript
interface SensorConfig {
  device_class?: SensorDeviceClass;  // 'temperature' | 'humidity' | 'energy' | ... (70+ classes)
  unit_of_measurement?: string;
  state_class?: 'measurement' | 'total' | 'total_increasing';
  suggested_display_precision?: number;
}

const temp = sensor({
  id: 'backyard_temp',
  name: 'Temperature',
  config: {
    device_class: 'temperature',
    unit_of_measurement: '°C',
    state_class: 'measurement',
  },
  init() {
    this.poll(readSensor, { interval: 30_000 });
    return readSensor();
  },
});
```

State type: `string | number`. HA stores sensor state as a string but displays it according to `device_class` and `unit_of_measurement`.

#### Binary Sensor (Read-Only, Two-State)

```typescript
interface BinarySensorConfig {
  device_class?: BinarySensorDeviceClass;
  // 'battery' | 'door' | 'motion' | 'moisture' | 'smoke' | ... (20+ classes)
}

const motion = binarySensor({
  id: 'office_motion',
  name: 'Motion',
  config: { device_class: 'motion' },
  init() {
    this.poll(checkMotionSensor, { interval: 1_000 });
    return checkMotionSensor();
  },
});
```

State type: `'on' | 'off'`.

#### Switch (Bidirectional)

```typescript
const pump = defineSwitch({
  id: 'irrigation_pump',
  name: 'Pump',
  config: { device_class: 'switch' },  // 'outlet' | 'switch'
  onCommand(cmd) {
    // cmd: 'ON' | 'OFF'
    actuate(cmd);
  },
});
```

State type: `'on' | 'off'`. Command type: `'ON' | 'OFF'`.

#### Light (Complex Bidirectional)

```typescript
interface LightConfig {
  supported_color_modes: ColorMode[];
  // 'onoff' | 'brightness' | 'color_temp' | 'hs' | 'rgb' | 'rgbw' | 'rgbww' | 'xy' | 'white'
  effect_list?: string[];
  min_color_temp_kelvin?: number;
  max_color_temp_kelvin?: number;
}

const desk = light({
  id: 'desk_light',
  name: 'Desk Light',
  config: {
    supported_color_modes: ['rgb', 'brightness'],
    effect_list: ['rainbow', 'breathe'],
  },
  onCommand(cmd) {
    // cmd.state: 'ON' | 'OFF'
    // cmd.brightness?: number (1-255)
    // cmd.color?: { r: number, g: number, b: number }
    // cmd.color_temp?: number (Kelvin)
    // cmd.effect?: 'rainbow' | 'breathe'
    // cmd.transition?: number (seconds)
    sendToLedController(cmd);
  },
});
```

Color modes must match HA's supported set exactly. HA rejects discovery payloads with invalid color modes.

#### Climate

```typescript
interface ClimateConfig {
  hvac_modes: HVACMode[];
  // 'off' | 'heat' | 'cool' | 'heat_cool' | 'auto' | 'dry' | 'fan_only'
  fan_modes?: string[];
  preset_modes?: string[];   // 'eco' | 'away' | 'boost' | 'comfort' | 'home' | 'sleep' | ...
  swing_modes?: string[];
  min_temp?: number;
  max_temp?: number;
  temp_step?: number;
}

const hvac = climate({
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
    // cmd.preset_mode?: string
    setThermostat(cmd);
  },
});
```

#### Cover

```typescript
interface CoverConfig {
  device_class?: CoverDeviceClass;
  // 'awning' | 'blind' | 'curtain' | 'damper' | 'door' | 'garage' | 'gate' | 'shade' | 'shutter' | 'window'
  position?: boolean;       // supports set_position
  tilt?: boolean;           // supports tilt control
}
```

#### Other Types

All 26 MQTT-supported types follow the same pattern: a typed `config` object matching HA's discovery payload fields, and an `onCommand` callback for bidirectional types. See the HA MQTT integration docs (`docs/integrations/mqtt.markdown`) for the full field list per platform.

### Entity Factory — Dynamic Entities

For entity sets determined at runtime:

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
      },
    })
  );
});
```

The factory function runs during deploy. It can be async. Returns an array of entity definitions. Entities are registered and initialized normally after the factory resolves.

### Conditional Entity Creation

Entities that adapt to the HA installation:

```typescript
export default entityFactory(async () => {
  const lights = await ha.getEntities('light');
  return lights.map((id) =>
    sensor({
      id: `${id}_daily_usage`,
      name: `${ha.friendlyName(id)} Daily Usage`,
      config: { unit_of_measurement: 'hours', state_class: 'total_increasing' },
      init() {
        let onMinutes = 0;
        ha.on(id, (e) => {
          if (e.new_state === 'on') this.update((onMinutes += 1) / 60);
        });
      },
    })
  );
});
```

## Composable Behaviors

Reusable higher-order wrappers that decorate entity definitions:

```typescript
const smoothedTemp = debounced(
  sensor({
    id: 'smoothed_bedroom_temp',
    name: 'Bedroom Temperature (Smoothed)',
    config: { device_class: 'temperature', unit_of_measurement: '°C' },
    init() {
      ha.on('sensor.bedroom_temp', (e) => this.update(Number(e.new_state)));
    },
  }),
  { window: 5, strategy: 'average' }
);
```

`debounced` wraps `this.update()` to buffer values and emit smoothed output. Other composable behaviors can follow the same pattern — wrapping the entity definition and intercepting context methods.

## Higher-Level Entity Types

Beyond the 22 MQTT platform factories, the SDK provides higher-level constructs:

- **`automation()`** — Pure reactive script with managed lifecycle. Gets `this.ha`, `this.events`, `this.log`. Optional `entity: true` surfaces as binary_sensor.
- **`task()`** — One-shot script surfaced as a button entity. `run()` triggered on press or deploy. Gets `this.ha`, `this.log`, `this.mqtt` (raw MQTT publish/subscribe) but no `this.events` or timers.
- **`computed()`** — Derived sensor. State is a pure function of watched entities. Re-evaluates reactively, debounced (100ms default), only publishes on change.
- **`cron()`** — Schedule entity surfaced as binary_sensor. ON during matching cron minutes, OFF otherwise.
- **`mode()`** — State machine surfaced as select entity. Named states with `enter`/`exit`/`guard` transition hooks.
- **`device()`** — Groups entities under shared lifecycle with one `init()`, coordinated polling, `this.entities.<name>` access.
- **`entityFactory()`** — Dynamic entity generation from async function. Returns array of entity definitions.

## this.events — Entity-Scoped Reactive API

Inside entity `init()`, `this.events` provides lifecycle-managed subscriptions:

- **`on()`** — State change subscription. Returns chainable `EventStream` with operators: `.filter()`, `.map()`, `.debounce()`, `.throttle()`, `.distinctUntilChanged()`, `.onTransition()`.
- **`reactions()`** — Declarative reaction rules with `to`, `when`, `do`, `after` (delayed, auto-cancelled).
- **`combine()`** — Watch multiple entities, callback gets all snapshots on any change.
- **`withState()`** — Enrich trigger events with context entity snapshots.
- **`watchdog()`** — Detect missing expected events within time windows.
- **`invariant()`** — Periodic condition checking with violation handlers.
- **`sequence()`** — Ordered event detection across entities within time windows.

All subscriptions auto-clean on entity teardown. See the [Entity Context API reference](../reference/entity-context.md) for full signatures.

## ha.* API

The global `ha` object provides typed access to Home Assistant:

### ha.on() — State Subscriptions

```typescript
// Discriminated by entity — callback typed to that entity's state/attributes
ha.on<E extends HAEntityId>(
  entity: E,
  callback: (event: StateChangedEvent<E>) => void
): void;

// Discriminated by domain — fires for all entities in that domain
ha.on<D extends HADomain>(
  domain: D,
  callback: (event: StateChangedEvent<EntitiesInDomain<D>>) => void
): void;

// Multiple specific entities
ha.on<E extends HAEntityId>(
  entities: E[],
  callback: (event: StateChangedEvent<E>) => void
): void;
```

Event type:

```typescript
type StateChangedEvent<E extends HAEntityId> = {
  entity_id: E;
  old_state: HAEntityMap[E]['state'];
  new_state: HAEntityMap[E]['state'];
  old_attributes: HAEntityMap[E]['attributes'];
  new_attributes: HAEntityMap[E]['attributes'];
  timestamp: number;
};
```

### ha.callService() — Typed Service Calls

```typescript
ha.callService<E extends HAEntityId, S extends keyof HAEntityMap[E]['services']>(
  entity: E,
  service: S,
  data?: HAEntityMap[E]['services'][S]
): Promise<void>;
```

Autocomplete guides every parameter. Invalid parameters are compile errors. Values are validated at runtime before dispatch.

### ha.getState() — Typed State Reads

```typescript
ha.getState<E extends HAEntityId>(entity: E): Promise<{
  state: HAEntityMap[E]['state'];
  attributes: HAEntityMap[E]['attributes'];
  last_changed: string;
  last_updated: string;
}>;
```

### ha.getEntities() — Entity Listing

```typescript
ha.getEntities<D extends HADomain>(domain?: D): Promise<EntitiesInDomain<D>[]>;
```

Returns all entity IDs, optionally filtered by domain.

### ha.friendlyName()

```typescript
ha.friendlyName(entityId: HAEntityId): string;
```

Returns the `friendly_name` attribute of an entity. Convenience for display strings.

### ha.fireEvent()

```typescript
ha.fireEvent(eventType: string, eventData?: Record<string, unknown>): Promise<void>;
```

Fires a custom event on the HA event bus via WebSocket.
