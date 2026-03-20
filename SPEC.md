# HA Forge for Home Assistant

## Specification v0.3

---

## Overview

A system for defining Home Assistant entities, automations, and reactive behaviors in TypeScript. User-authored `.ts` files declare entities using a typed SDK backed by an auto-generated type registry of the user's entire HA installation. A Node.js runtime, deployed as a Home Assistant add-on, compiles and bundles these definitions and registers them with Home Assistant via MQTT discovery.

The core differentiator is the type system. The SDK generates TypeScript types from the live HA entity registry — every entity ID, state value, attribute, service, and helper option becomes a typed construct. Numeric parameters carry range constraints as branded types. Select options become string literal unions. Autocomplete, compile-time validation, discriminated unions, and companion runtime validators make it impossible to reference an entity that doesn't exist, call a service with invalid parameters, or pass an out-of-range value without a clear error.

---

## Architecture

### Components

**1. The Add-on (Docker container on HAOS)**

- Node.js LTS runtime in a Docker container, deployed as an HA add-on.
- Connects to the Mosquitto MQTT broker for entity registration and state traffic.
- Connects to HA's WebSocket API for entity registry introspection, state subscriptions, and service calls.
- Provides an ingress-based web UI (Monaco editor + entity dashboard + log viewer).
- Manages the build pipeline: type generation → compilation → bundling → deployment.
- Manages entity lifecycle: registration, state publishing, command handling, teardown.
- Runs scheduled type validation to detect HA registry drift.

**2. User Scripts**

- TypeScript files stored in `/config/ha-forge/`.
- Each file exports one or more entity definitions, reactive behaviors, or entity factories.
- Edited via the built-in Monaco editor (primary) or VS Code Server add-on / File Editor / Samba / SSH (alternative).
- Automatically included in HA's built-in backup system.

**3. MQTT Broker**

- Mosquitto, installed as a standard HA add-on.
- All entity registration flows through MQTT discovery.
- State updates published to per-entity state topics.
- Command topics subscribed for bidirectional entities.
- Availability topic with LWT so entities go unavailable if the add-on crashes.

**4. HA WebSocket API**

- Used for entity registry introspection (type generation).
- Used for state subscriptions (`ha.on()`).
- Used for service calls (`ha.callService()`).
- Used for event bus access (`ha.fireEvent()`).

**5. Future: Companion Custom Integration (not in v1)**

- Python custom integration in `custom_components/` for entity types MQTT discovery doesn't support (media_player, calendar, weather).
- Communicates with the add-on over a local WebSocket.
- User-facing TypeScript API does not change when this is introduced.

### Data Flow

```
User .ts files
    → Monaco editor / external editor
    → User clicks Build (or auto-build on save)
    → Type registry regenerated from HA WebSocket API
    → esbuild bundles all .ts files + node_modules into dist/
    → Runtime tears down previous entities
    → Runtime loads bundled output
    → Transport router: MQTT for supported types, (future) native bridge for others
    → MQTT: publish discovery config + state topics → HA picks up entities
    → For bidirectional entities: HA → MQTT command topic → runtime → user callback
    → For HA subscriptions: HA WebSocket → runtime → user callback
```

---

## Build Pipeline

### Overview

The build is an explicit, discrete step — not implicit file watching. The user edits code in the Monaco panel and triggers a build via button (or configurable auto-build on save). This avoids ambiguity around npm install timing and partial saves.

### Steps

1. **Type generation**: pull entity registry, service definitions, and state data from HA WebSocket API (`get_services`, `get_states`, `config/entity_registry/list`, `config/device_registry/list`, `config/area_registry/list`). Generate `.d.ts` type declarations and companion runtime validator module. Write to `/config/ha-forge/.generated/`.

2. **Dependency install**: if `package.json` has changed since last build, run `npm install` in the scripts directory.

3. **Type check**: run `tsc --noEmit` against user scripts with the generated types. Collect any errors. Display in Monaco editor as diagnostics. If errors exist, warn but allow build to proceed (user's choice — errors may be in files they're not using yet).

4. **Bundle**: esbuild bundles each user `.ts` file with its dependencies into a self-contained JS output in a staging directory. This eliminates runtime module resolution issues and is fast even on constrained hardware.

5. **Deploy**: runtime tears down all current entities (calls `destroy()`, clears handles, publishes MQTT deregistration for removed entities). Loads bundled output. Registers new entities. Calls `init()`. Publishes initial state.

### Why esbuild + tsc

esbuild handles compilation and bundling. It's fast (sub-second on most hardware) and produces clean output. It doesn't type-check, so tsc runs separately in `--noEmit` mode purely for diagnostics. This gives the user the best of both: fast builds and full type checking.

---

## Monaco Editor (Ingress Panel)

The primary interface for authoring and managing entity scripts. Accessible from the HA sidebar.

### Features

- **Code editor**: Monaco with full TypeScript language service. SDK types and the generated HA registry types injected via `addExtraLib()`. Full autocomplete, hover docs, error squiggles.
- **File tree**: browse, create, rename, delete `.ts` files in the scripts directory.
- **Dependency management**: UI panel to search npm, add/remove packages. Writes `package.json`, triggers `npm install` as part of the next build.
- **Build controls**: Build button. Build output console showing compilation results, type errors, bundle status, deployment result. Optional auto-build-on-save toggle.
- **Entity dashboard**: list of all registered entities, current state, source file, transport type. Live-updating.
- **Log viewer**: real-time log stream with filters (entity, file, severity, time range). Backed by SQLite queries.
- **Type regeneration**: button to regenerate HA registry types on demand. Status indicator showing when types were last generated and whether the registry has changed since.

### Type Injection

On editor load and after each type generation:
- SDK types (`ha-forge` module, including `NumberInRange` and validation utilities) injected via `addExtraLib()`.
- Generated HA registry types and runtime validators injected via `addExtraLib()`.
- Installed npm package types (from `node_modules/**/*.d.ts`) injected via `addExtraLib()`.

This gives the user full IntelliSense without any manual setup.

### VS Code Compatibility

The same types are written to disk at `/config/ha-forge/.generated/` and `/config/ha-forge/node_modules/ha-forge/`. A `tsconfig.json` is scaffolded on first run. Users who prefer VS Code Server, SSH + local editor, or any other TypeScript-aware tool get the same autocomplete and error checking.

---

## Type System

### Data Sources

Type generation is fully data-driven from HA's live APIs. No curated mapping tables or HA source parsing required.

| API Endpoint | What It Provides |
|---|---|
| `get_services` (WebSocket) | Every registered service per domain, with `fields` containing `selector` definitions (type, min/max, options, required, default), used to generate typed service parameters. |
| `get_states` (WebSocket) | Every entity's current state and attributes, used to infer attribute shapes. |
| `config/entity_registry/list` (WebSocket) | Entity IDs, domains, device associations, categories, areas. |
| `config/device_registry/list` (WebSocket) | Device info: manufacturer, model, area assignments. |
| `config/area_registry/list` (WebSocket) | Area IDs and names. |
| `config/label_registry/list` (WebSocket) | Label IDs and names. |

The `get_services` response is the richest source. Each service field includes a `selector` that maps directly to a TypeScript type:

| Selector | TypeScript Type | Runtime Constraint |
|---|---|---|
| `number: { min: 0, max: 255 }` | `NumberInRange<0, 255>` | `rangeValidator(0, 255)` |
| `boolean` | `boolean` | — |
| `text` | `string` | — |
| `select: { options: ['a', 'b'] }` | `'a' \| 'b'` | `oneOfValidator(['a', 'b'])` |
| `entity: { domain: 'light' }` | Entity ID union filtered to lights | `entityExistsValidator('light')` |
| `color_rgb` | `[number, number, number]` | `rgbValidator()` |
| `color_temp` | `NumberInRange<min_mireds, max_mireds>` | `rangeValidator(min, max)` |
| `time` | `string` | `timeFormatValidator()` |
| `object` | `Record<string, unknown>` | — |

Fields marked `required: true` in the selector metadata become non-optional in the generated type. Fields with `default` values are optional. New selector types added in future HA versions fall back to `unknown` safely.

### Generated HA Registry

On build (or manual trigger), the runtime connects to HA's WebSocket API and generates both a type declaration file and a companion runtime validation module.

```typescript
// auto-generated: .generated/ha-registry.d.ts

export type HAEntityMap = {
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
  'input_select.house_mode': {
    domain: 'input_select';
    state: 'home' | 'away' | 'sleeping' | 'vacation';
    attributes: {
      options: string[];
      friendly_name: string;
    };
    services: {
      select_option: { option: 'home' | 'away' | 'sleeping' | 'vacation' };
      select_next: {};
      select_previous: {};
    };
  };
  'input_number.target_temperature': {
    domain: 'input_number';
    state: string;
    attributes: {
      min: 7;
      max: 35;
      step: 0.5;
      mode: 'slider' | 'box';
      friendly_name: string;
    };
    services: {
      set_value: { value: NumberInRange<7, 35> };
      reload: {};
    };
  };
  'input_boolean.guest_mode': {
    domain: 'input_boolean';
    state: 'on' | 'off';
    attributes: { editable: boolean; friendly_name: string };
    services: {
      turn_on: {};
      turn_off: {};
      toggle: {};
    };
  };
  'sensor.bedroom_temp': {
    domain: 'sensor';
    state: string;
    attributes: {
      unit_of_measurement: '°C';
      device_class: 'temperature';
      friendly_name: string;
    };
    services: never;
  };
  // ... every entity, helper, and group in the HA installation
};

export type HAEntityId = keyof HAEntityMap;
export type HADomain = HAEntityMap[HAEntityId]['domain'];
export type EntitiesInDomain<D extends HADomain> = {
  [K in HAEntityId]: HAEntityMap[K]['domain'] extends D ? K : never;
}[HAEntityId];
```

### Constrained Numeric Types

TypeScript has no native numeric range type. The SDK uses branded types to encode constraints at the type level, backed by runtime validation.

```typescript
// SDK core: constrained number type
type NumberInRange<Min extends number, Max extends number> = number & {
  readonly __min: Min;
  readonly __max: Max;
  readonly __brand: 'RangeValidated';
};
```

A raw `number` cannot be assigned where `NumberInRange<0, 255>` is expected. Values must pass through a validator to obtain the branded type. This prevents accidentally passing unvalidated input to service calls.

### Runtime Validation

The type generator emits a companion runtime module alongside the `.d.ts` file. This module contains validators derived from the same selector metadata used for type generation, meaning compile-time types and runtime checks are always in sync.

```typescript
// auto-generated: .generated/ha-validators.ts

import { rangeValidator, oneOfValidator, rgbValidator } from 'ha-forge/validate';

export const validators = {
  'light.turn_on': {
    brightness: rangeValidator(0, 255),
    color_temp: rangeValidator(153, 500),
    transition: rangeValidator(0, 300),
    flash: oneOfValidator(['short', 'long'] as const),
  },
  'climate.set_temperature': {
    temperature: rangeValidator(7, 35),
  },
  'input_number.target_temperature': {
    value: rangeValidator(7, 35),
  },
  'input_select.house_mode': {
    option: oneOfValidator(['home', 'away', 'sleeping', 'vacation'] as const),
  },
} as const;
```

The validator functions:

```typescript
// Validates and returns a branded type
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
```

### Two Modes of Use

**Strict mode (opt-in):** the user explicitly validates values. The compiler enforces it — passing a raw `number` where `NumberInRange` is expected is a type error.

```typescript
import { validators } from '.generated/ha-validators';

const brightness = validators['light.turn_on'].brightness(userInput); // validated + branded
ha.callService('light.living_room', 'turn_on', { brightness }); // ✓ compiles
```

**Convenience mode (default):** `ha.callService` accepts raw values and validates internally at runtime before sending to HA. The generated types for service parameters accept `number` (not branded) in this mode, but the runtime still throws a clear error on invalid input.

```typescript
ha.callService('light.living_room', 'turn_on', {
  brightness: 200,  // ✓ accepted, validated at runtime before dispatch
});

ha.callService('light.living_room', 'turn_on', {
  brightness: 999,  // compiles, but throws RangeError at runtime: "Expected 0–255, got 999"
});
```

Both modes use the same underlying validators. The strict mode catches errors at compile time. The convenience mode catches them at runtime with descriptive error messages (logged to SQLite with entity context).

### Validators in User Code

The validators are also useful outside of service calls — for validating external input, sensor readings, or user-provided data in entity scripts:

```typescript
import { validators } from '.generated/ha-validators';

export const dimmer = switch({
  id: 'smart_dimmer',
  name: 'Smart Dimmer',
  onCommand(cmd) {
    const level = readAnalogInput();
    try {
      const brightness = validators['light.turn_on'].brightness(level);
      ha.callService('light.living_room', 'turn_on', { brightness });
    } catch (e) {
      this.log.warn('Invalid brightness from analog input', { level, error: e.message });
    }
  },
});
```

### What Gets Typed

- All entity IDs across all domains.
- State values: literal unions where possible (`'on' | 'off'` for switches, actual configured options for `input_select`), `string` where state is freeform.
- Attributes per entity, with constrained numeric ranges where the metadata provides min/max.
- Services per domain with typed parameters. Numeric fields carry range constraints via `NumberInRange`. Select fields use string literal unions from the configured options. Required fields are non-optional.
- Helper entities (`input_boolean`, `input_number`, `input_select`, `input_text`, `input_datetime`, `counter`, `timer`) with their configured constraints.
- Groups, areas, and labels as string literal types for filtering.
- Runtime validators generated in parallel with types, always in sync.

### Discriminated Unions on `ha.on()`

The first argument to `ha.on()` narrows the callback's event type:

```typescript
type StateChangedEvent<E extends HAEntityId> = {
  entity_id: E;
  old_state: HAEntityMap[E]['state'];
  new_state: HAEntityMap[E]['state'];
  old_attributes: HAEntityMap[E]['attributes'];
  new_attributes: HAEntityMap[E]['attributes'];
  timestamp: number;
};

interface HAApi {
  // Subscribe to a specific entity
  on<E extends HAEntityId>(
    entity: E,
    callback: (event: StateChangedEvent<E>) => void
  ): void;

  // Subscribe to all entities in a domain
  on<D extends HADomain>(
    domain: D,
    callback: (event: StateChangedEvent<EntitiesInDomain<D>>) => void
  ): void;

  // Subscribe to multiple specific entities
  on<E extends HAEntityId>(
    entities: E[],
    callback: (event: StateChangedEvent<E>) => void
  ): void;
}
```

Usage:

```typescript
ha.on('light.living_room', (e) => {
  // e.new_state: 'on' | 'off'
  // e.new_attributes.brightness: NumberInRange<0, 255>
  // e.new_attributes.color_temp: NumberInRange<153, 500>
});

ha.on('input_select.house_mode', (e) => {
  // e.new_state: 'home' | 'away' | 'sleeping' | 'vacation'
  // switch(e.new_state) — compiler enforces exhaustive matching
});

ha.on('light', (e) => {
  // fires for ALL lights
  // e.entity_id: 'light.living_room' | 'light.bedroom' | ...
});
```

### Typed Service Calls

```typescript
interface HAApi {
  callService<E extends HAEntityId, S extends keyof HAEntityMap[E]['services']>(
    entity: E,
    service: S,
    data?: HAEntityMap[E]['services'][S]
  ): Promise<void>;
}

// Autocomplete guides every parameter:
ha.callService('light.living_room', 'turn_on', {
  brightness: 200,     // ✓ known parameter, validated at runtime against 0–255
  transition: 2,       // ✓ known parameter, validated against 0–300
  fake_param: true,    // ✗ compile error — does not exist on this service
});

ha.callService('input_select.house_mode', 'select_option', {
  option: 'away',      // ✓ literal union — only configured options accepted
});

ha.callService('input_number.target_temperature', 'set_value', {
  value: 22,           // ✓ validated at runtime against 7–35
});
```

### Typed State Reads

```typescript
interface HAApi {
  getState<E extends HAEntityId>(entity: E): Promise<{
    state: HAEntityMap[E]['state'];
    attributes: HAEntityMap[E]['attributes'];
    last_changed: string;
    last_updated: string;
  }>;
}
```

---

## Entity Model

### Core Interface

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

### Supported Entity Types (v1 — MQTT Transport)

```typescript
type EntityType =
  | 'sensor' | 'binary_sensor' | 'image'
  | 'switch' | 'light' | 'cover' | 'fan' | 'lock'
  | 'climate' | 'humidifier' | 'valve' | 'water_heater'
  | 'vacuum' | 'lawn_mower' | 'siren'
  | 'number' | 'select' | 'text' | 'button'
  | 'scene' | 'notify' | 'update' | 'event'
  | 'device_tracker' | 'camera' | 'alarm_control_panel' | 'tag';
```

### Entity Definitions (Selected Examples)

#### Sensor

```typescript
interface SensorConfig {
  device_class?: SensorDeviceClass;
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

#### Switch (Bidirectional)

```typescript
const garageSwitch = switch({
  id: 'garage_door',
  name: 'Garage Door',
  onCommand(cmd) {
    // cmd: 'ON' | 'OFF'
    this.log.info('Command received', { command: cmd });
    actuate(cmd);
  },
});
```

#### Light (Complex Bidirectional)

```typescript
const rgbLight = light({
  id: 'desk_light',
  name: 'Desk Light',
  config: {
    supported_color_modes: ['rgb', 'brightness'],
    effect_list: ['rainbow', 'breathe'],
  },
  onCommand(cmd) {
    // cmd.state: 'ON' | 'OFF'
    // cmd.brightness?: number
    // cmd.color?: { r, g, b }
    // cmd.effect?: 'rainbow' | 'breathe'
    sendToLedController(cmd);
  },
});
```

### Dynamic Entities

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
        this.poll(() => readModbusRegister(d.address, d.register), {
          interval: 10_000,
        });
      },
    })
  );
});
```

---

## Reactive Patterns

### Direct Subscriptions

```typescript
ha.on('binary_sensor.front_door', (e) => {
  if (e.new_state === 'on') {
    ha.callService('light.porch', 'turn_on', { brightness: 255 });
  }
});
```

### Reaction Maps

Declarative reactive programming with typed keys and values:

```typescript
export default reactions({
  'binary_sensor.front_door': {
    to: 'on',
    do: () => ha.callService('light.porch', 'turn_on', { brightness: 255 }),
  },
  'sensor.bedroom_temp': {
    when: (e) => Number(e.new_state) > 25,
    do: () => ha.callService('climate.bedroom', 'set_temperature', { temperature: 22 }),
  },
  'switch.garage_door': {
    to: 'on',
    after: 600_000,
    do: () => {
      ha.callService('switch.garage_door', 'turn_off');
      ha.callService('notify.mobile_app', 'send_message', {
        message: 'Garage open 10 minutes, closing.',
      });
    },
  },
});
```

- Every key autocompletes from the entity registry.
- `to` is typed to that entity's valid state values.
- `when` callback receives the typed event.
- `after` provides delayed reactions with automatic cancellation if state changes before the timer fires.

### Composable Behaviors

Reusable higher-order wrappers:

```typescript
export const smoothedTemp = debounced(
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

---

## SDK Utilities

```typescript
interface EntityContext<TState> {
  /** Push a state update to HA. */
  update: (value: TState, attributes?: Record<string, unknown>) => void;
  /** Polling with automatic cleanup on teardown. */
  poll: (fn: () => TState | Promise<TState>, opts: { interval: number }) => void;
  /** Structured logging, auto-tagged with entity ID and source file. */
  log: {
    debug: (message: string, data?: Record<string, unknown>) => void;
    info: (message: string, data?: Record<string, unknown>) => void;
    warn: (message: string, data?: Record<string, unknown>) => void;
    error: (message: string, data?: Record<string, unknown>) => void;
  };
  /** Timers with automatic cleanup. */
  setTimeout: (fn: () => void, ms: number) => void;
  setInterval: (fn: () => void, ms: number) => void;
  /** HTTP client. */
  fetch: typeof globalThis.fetch;
  /** Direct MQTT access for advanced use. */
  mqtt: {
    publish: (topic: string, payload: string, opts?: { retain?: boolean }) => void;
    subscribe: (topic: string, handler: (payload: string) => void) => void;
  };
}
```

All handles (timers, polls, subscriptions) are tracked by the runtime per entity and automatically disposed on teardown. User code in `destroy()` is called first for explicit cleanup, then the runtime force-disposes anything remaining.

---

## Transport Layer

### Transport Interface

```typescript
interface Transport {
  supports(type: EntityType): boolean;
  register(entity: ResolvedEntity): Promise<void>;
  publishState(entityId: string, state: unknown, attributes?: Record<string, unknown>): Promise<void>;
  onCommand(entityId: string, handler: (command: unknown) => void): void;
  deregister(entityId: string): Promise<void>;
}
```

### MQTT Transport (v1)

- Covers all 28 MQTT discovery-supported entity types.
- Discovery payloads published as retained messages.
- Uses `default_entity_id` (not the deprecated `object_id`).
- Availability topic with LWT to `offline` on crash/shutdown.
- On entity removal, publishes empty retained payload to discovery topic.

### Transport Router

```typescript
class TransportRouter {
  private transports: Transport[] = [];

  register(transport: Transport) { this.transports.push(transport); }

  resolve(type: EntityType): Transport {
    const t = this.transports.find((t) => t.supports(type));
    if (!t) throw new UnsupportedEntityTypeError(type);
    return t;
  }
}
```

User-facing API is transport-agnostic. Adding support for unsupported entity types means adding a transport, not changing user code.

### Native Bridge Transport (future, not v1)

- For entity types MQTT discovery doesn't cover.
- Python custom integration in `custom_components/ha_forge/`.
- Communication over local WebSocket.
- Python side registers entities via HA's native platform APIs.

---

## Logging

### Storage

SQLite database in the add-on's data directory.

```sql
CREATE TABLE logs (
  id INTEGER PRIMARY KEY,
  timestamp INTEGER NOT NULL,         -- unix ms
  level TEXT NOT NULL,                 -- debug, info, warn, error
  source_file TEXT NOT NULL,           -- user .ts filename or '_runtime'
  entity_id TEXT,                      -- null for file-level or system logs
  message TEXT NOT NULL,
  data TEXT                            -- JSON blob for structured context
);

CREATE INDEX idx_logs_time ON logs(timestamp);
CREATE INDEX idx_logs_entity ON logs(entity_id, timestamp);
CREATE INDEX idx_logs_level ON logs(level, timestamp);
CREATE INDEX idx_logs_file ON logs(source_file, timestamp);
```

### How Logging Works

- `this.log` in entity context writes to SQLite, auto-tagged with `entity_id` and `source_file`.
- Runtime system events (MQTT connection, build results, lifecycle events) logged with `source_file: '_runtime'` and `entity_id: null`.
- Structured data (stack traces, state snapshots, command payloads) stored in the `data` JSON column.

### Querying

The Monaco panel's log viewer issues SQL queries via a REST endpoint served by the add-on:
- Filter by entity, file, severity, time range.
- Real-time tailing via WebSocket push of new rows.
- Retention: configurable max age (default 7 days). Cleanup runs on startup and periodically.

---

## Scheduled Validation & Health Entities

### Purpose

Detect when changes to the HA installation (entity renames, removals, helper config changes) break existing TypeScript scripts. Surfaces breakage as HA entities that can trigger automations and notifications.

### How It Works

1. On a configurable schedule (default: hourly) and optionally on HA entity registry change events:
2. Pull the current entity registry from HA WebSocket API.
3. Regenerate types into a temporary directory (does not touch the live types).
4. Run `tsc --noEmit` against user scripts with the new types.
5. Collect errors.
6. Update health entities.

The running instance is never touched. This is a read-only check.

### Health Entities

Registered by the runtime itself (dogfooding the system):

```
binary_sensor.ha_forge_build_healthy
  state: on | off
  on = all scripts compile cleanly against current HA registry
  off = type errors found

sensor.ha_forge_type_errors
  state: <error count>
  attributes:
    errors: [
      {
        file: 'garage-door.ts',
        line: 14,
        column: 8,
        message: "Property 'old_entity' does not exist on type 'HAEntityId'"
      }
    ]
    last_checked: ISO timestamp
    check_trigger: 'scheduled' | 'registry_change'
```

### What Triggers Errors

- An entity ID referenced in user code was renamed or deleted from HA.
- A helper's configured options changed (e.g., an `input_select` option removed that user code matches against).
- An entity's domain changed (rare but possible via HA UI).
- An attribute a script depends on is no longer present.

### Automation Example

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

### Optional: Auto-Rebuild on Registry Change

Configurable behavior when the scheduled/triggered validation passes:
- **Manual** (default): just update health entities. User rebuilds when ready.
- **Auto-rebuild**: if validation passes with new types, automatically trigger a full build and deploy with the updated types. If it fails, keep the old build running and flip health sensor to unhealthy.

---

## Add-on Structure

### Container Contents

```
/
├── node_modules/               # Runtime dependencies
├── dist/
│   ├── runtime.js              # Main entry
│   ├── build/
│   │   ├── type-generator.js   # HA registry → .d.ts + validators
│   │   ├── compiler.js         # esbuild bundling
│   │   └── validator.js        # tsc --noEmit checker
│   ├── transports/
│   │   └── mqtt.js
│   ├── sdk/
│   │   └── index.js            # User-facing SDK
│   ├── logging/
│   │   └── sqlite.js           # Log storage
│   └── web/                    # Monaco editor + dashboard
│       ├── index.html
│       ├── editor.js
│       └── api.js              # REST + WebSocket endpoints
├── package.json
└── run.sh
```

### HA Add-on Metadata

```yaml
name: HA Forge
description: Define Home Assistant entities in TypeScript
version: 0.1.0
slug: ha_forge
arch:
  - amd64
  - aarch64
  - armv7
init: false
homeassistant_api: true
map:
  - config:rw
services:
  - mqtt:need
ingress: true
ingress_port: 8099
panel_icon: mdi:language-typescript
options:
  scripts_path: ha-forge
  log_level: info
  log_retention_days: 7
  validation_schedule_minutes: 60
  auto_rebuild_on_registry_change: false
schema:
  scripts_path: str
  log_level: list(debug|info|warn|error)
  log_retention_days: int
  validation_schedule_minutes: int
  auto_rebuild_on_registry_change: bool
```

### Entity Lifecycle

1. **Startup**: connect to MQTT broker (credentials from HA supervisor API). Connect to HA WebSocket API. Generate types. Load last successful build if exists.
2. **Build** (triggered by user or auto): type generation → npm install (if needed) → tsc check → esbuild bundle → deploy.
3. **Deploy**: tear down current entities (call `destroy()`, dispose all handles, MQTT deregistration for removed entities). Load new bundle. Register entities. Call `init()`. Publish initial state.
4. **Runtime**: state updates flow via `this.update()` → MQTT publish. Commands flow via MQTT subscribe → `onCommand()`. HA subscriptions flow via WebSocket → `ha.on()` callbacks.
5. **Shutdown**: publish LWT / offline availability. HA marks all entities unavailable.

### File Watching (Optional)

Disabled by default. When enabled:
- Watches `/config/ha-forge/` for `.ts` file changes.
- Debounces (500ms).
- Triggers a full build on change.
- Does not watch `package.json` changes (dependency changes always require explicit build via UI).

---

## Dependency Management

### How It Works

- User scripts directory contains a `package.json` (scaffolded on first run if absent).
- The Monaco panel provides a UI for searching npm and adding/removing packages.
- Adding a package updates `package.json` and flags that `npm install` is needed on next build.
- `npm install` runs as the first step of the build pipeline when `package.json` has changed.
- esbuild bundles user code with all dependencies into self-contained output. No runtime module resolution needed.

### Type Support for Dependencies

After `npm install`, the build pipeline scans `node_modules/` for `.d.ts` files and injects them into Monaco via `addExtraLib()`. Packages with `@types/*` counterparts are handled automatically. This gives the user full autocomplete for third-party packages in the editor.

---

## Backup & Persistence

- User scripts in `/config/ha-forge/` are included in HA's built-in backup.
- `node_modules/` can be excluded from backup (regenerated via `npm install`). Add-on options control this.
- SQLite log database lives in the add-on's `/data` directory. Included in backup if the add-on is selected.
- Entity state is transient — recomputed on startup via `init()`. No state persistence in v1.
- Last successful build bundle cached in `/data/last-build/` for fast startup without recompilation.

### Future: Persistent State Store

If needed, a key-value store exposed via the SDK:

```typescript
const count = await this.store.get<number>('daily_count') ?? 0;
await this.store.set('daily_count', count + 1);
```

Backed by SQLite in the same database. Per-entity key namespace.

---

## Error Handling

### Script Errors

- **Compile error**: reported in Monaco diagnostics and build output. Build can proceed (user's choice) — only affected files fail to load.
- **Runtime error in `init()`**: entity not registered. Error logged to SQLite. Other entities in same file still load.
- **Runtime error in `onCommand()`**: error logged. Entity remains registered. Command effectively dropped. Error count tracked; optionally surfaced as a diagnostic entity attribute.
- **Runtime error in poll callback**: error logged. Poll continues on next interval. After N consecutive failures (configurable), entity marked unavailable via availability topic.
- **Runtime validation error in `callService()`**: error logged with full context (service name, parameter name, expected range/options, actual value). Service call not dispatched to HA. The descriptive error message makes it clear what's wrong and which constraint was violated.

### Infrastructure Errors

- **MQTT broker unavailable**: retry with exponential backoff. Entities queued for registration.
- **HA WebSocket unavailable**: retry. Non-fatal for entity operation (MQTT still works). Fatal for `ha.on()` / `ha.callService()` — those calls fail with logged errors.
- **File system errors**: logged and surfaced in UI.

---

## Security

- User scripts run inside the add-on container with Node.js. Network access (for external APIs) and filesystem access scoped to the container + mapped `/config/`.
- No sandboxing beyond container isolation. Acceptable because: user is the script author, attack surface matches Node-RED and AppDaemon, HAOS add-ons are containerized.
- MQTT credentials obtained from HA supervisor API, not stored in user-accessible config.
- Ingress port proxied through HA auth. No exposed ports.
- The Monaco editor serves user files only from the configured scripts directory. No filesystem traversal.

---

## Out of Scope for v1

- Native bridge transport for unsupported entity types.
- Entity state persistence across restarts.
- Multi-file imports between user scripts (each file is self-contained; shared code goes in npm packages or a local shared module).
- Visual automation builder (the reaction map API is the text-based equivalent).
- Template entities (HA's template platform handles derived entities well already).

---

## Open Questions

1. **Worker threads vs single process**: running each file in a worker thread isolates crashes but adds complexity. Single process with try/catch is simpler and matches Node-RED's model. Leaning single process for v1.

2. **SDK distribution**: publish a types-only `ha-forge` package to npm for users who want to develop locally and deploy to HA? Or keep it purely internal?

3. **Hot reload granularity**: current design rebuilds everything on any change. Per-file incremental builds are possible with esbuild but add complexity around shared state and dependency tracking. Worth revisiting if build times become a problem.

4. **Auto-build on save**: should this be the default? Or keep explicit build as default with auto-build as opt-in? Leaning opt-in to avoid surprises during development.

5. **Rate limiting on HA subscriptions**: a careless `ha.on('sensor.rapidly_updating_thing', ...)` could generate enormous event volume. Should the SDK debounce by default? Configurable per subscription?
