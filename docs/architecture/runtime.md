# Runtime

The runtime manages entity lifecycle and all communication with Home Assistant and the MQTT broker. It loads bundled JavaScript from the build pipeline, registers entities, handles state updates and commands, and tears everything down on redeploy or shutdown.

## Entity Lifecycle

```
Startup
  → Connect to MQTT broker (credentials from Supervisor API)
  → Connect to HA WebSocket API (auth via SUPERVISOR_TOKEN)
  → Load last successful build if exists (from /data/last-build/)
  → Register entities → call init() → publish initial state

Build triggered
  → Teardown current entities
  → Load new bundles from staging
  → Register entities → call init() → publish initial state

Shutdown
  → Call destroy() on each entity
  → Force-dispose remaining handles
  → Publish LWT (offline availability)
  → HA marks all entities unavailable
```

### Entity States

Each entity instance transitions through:

1. **Created**: Entity definition loaded from bundle. Not yet registered.
2. **Registered**: MQTT discovery payload published. Command topic subscribed (if bidirectional). Entity appears in HA.
3. **Initialized**: `init()` called. Initial state published. Polls/subscriptions started. Entity is fully operational.
4. **Running**: Steady state. State updates flow via `this.update()`. Commands flow via `onCommand()`. HA subscriptions via `ha.on()`.
5. **Destroying**: `destroy()` called. User cleanup runs.
6. **Disposed**: All tracked handles force-cleaned. If entity is being removed (not redeployed), MQTT discovery topic cleared.

### Error Isolation

Each entity's lifecycle is independent. Errors are contained:

- **init() throws**: Entity is registered first (MQTT discovery published), then `init()` is called. On failure the entity is deregistered (torn down), error logged. Other entities in the same file still load.
- **onCommand() throws**: Error logged. Entity stays registered. Command dropped. No failure tracking — consecutive failure counting only applies to publish errors, not command handler errors.
- **Poll callback throws**: Error logged. Poll continues on next interval. After N consecutive failures, entity marked unavailable.
- **destroy() throws**: Error logged. Runtime proceeds with force-dispose of handles.

## Transport Layer

### Transport Interface

```typescript
interface Transport {
  supports(type: EntityType): boolean;
  register(entity: RegistrableEntity): Promise<void>;
  publishState(entityId: string, state: unknown, attributes?: Record<string, unknown>): Promise<void>;
  onCommand(entityId: string, handler: (command: unknown) => void): void;
  deregister(entityId: string): Promise<void>;
  recordEntityFailure?(entityId: string): void;
  clearEntityFailure?(entityId: string): void;
}
```

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

User-facing API is transport-agnostic. Adding support for new entity types means adding a transport, not changing user code.

### MQTT Transport (v1)

Covers MQTT discovery-supported entity types. 22 have SDK factory functions:

```
sensor, binary_sensor, image, switch, light, cover, fan, lock,
climate, humidifier, valve, water_heater, vacuum, lawn_mower, siren,
number, select, text, button, notify, update, alarm_control_panel
```

4 additional platforms are supported by MQTT discovery but lack SDK factories: `scene`, `event`, `device_tracker`, `camera`.

#### Device Discovery

The MQTT transport uses HA's device discovery pattern — one message registers a device with all its entities.

**Discovery topic**: `homeassistant/device/<device_id>/config`

**Payload structure**:

```json
{
  "dev": {
    "ids": ["ha_forge_<device_id>"],
    "name": "Device Name",
    "mf": "ha-forge",
    "mdl": "User Script",
    "sw": "0.1.0"
  },
  "o": {
    "name": "ha-forge",
    "sw": "0.1.0",
    "url": "https://github.com/<repo>"
  },
  "cmps": {
    "backyard_temp": {
      "p": "sensor",
      "unique_id": "ha_forge_backyard_temp",
      "name": "Temperature",
      "stat_t": "ha-forge/backyard_temp/state",
      "dev_cla": "temperature",
      "unit_of_meas": "°C",
      "stat_cla": "measurement"
    },
    "garage_door": {
      "p": "switch",
      "unique_id": "ha_forge_garage_door",
      "name": "Garage Door",
      "stat_t": "ha-forge/garage_door/state",
      "cmd_t": "ha-forge/garage_door/set"
    }
  },
  "avty_t": "ha-forge/availability"
}
```

Key details:
- **Origin field** (`o`) is required for device discovery. Identifies our add-on in HA logs.
- **Abbreviated keys** used throughout (`dev`, `ids`, `mf`, `mdl`, `sw`, `p`, `stat_t`, `cmd_t`, `avty_t`, `dev_cla`, `unit_of_meas`, `stat_cla`) to reduce MQTT traffic.
- **`unique_id`** prefixed with `ha_forge_` to avoid collisions with other integrations.
- **`default_entity_id`** (`def_ent_id`) can be set to control the entity ID in HA. Only used on first registration when `unique_id` is present.
- **Retained messages**: Discovery payloads published with retain flag so HA picks them up on restart.

#### Entity Grouping

Entities are grouped into devices by:
1. **Explicit `device` config**: User provides a `DeviceInfo` object. All entities with the same `device.id` go into one device discovery message.
2. **Implicit file grouping**: Entities in the same file without explicit device config are grouped under a synthetic device named after the file.
3. **Standalone**: Single entities without siblings can use single-component discovery as fallback.

#### Topic Structure

```
ha-forge/
├── availability                          # Global LWT topic
├── <entity_id>/
│   ├── state                             # State updates (JSON or plain value)
│   └── set                               # Command topic (bidirectional entities)
```

#### Availability and LWT

- On connect: publish `online` to `ha-forge/availability` (retained).
- MQTT client configured with LWT: publish `offline` to `ha-forge/availability` on unexpected disconnect.
- On graceful shutdown: publish `offline` before disconnecting.
- All entities reference this topic via `avty_t` in their discovery payload.
- When HA sees `offline`, all ha-forge entities go unavailable.

Per-entity availability is also possible: if an entity's poll or command handler fails repeatedly, the runtime publishes `offline` to a per-entity availability topic.

#### Deregistration

When an entity is removed (present in old build, absent in new):
- Publish empty retained payload to its discovery topic component.
- For device discovery: re-publish the device config without the removed entity's component. If no components remain, publish empty payload to the device topic.

### Native Bridge Transport (Future, Not v1)

For entity types MQTT discovery doesn't cover (media_player, calendar, weather):
- Python custom integration in `custom_components/ha_forge/`.
- Communication over local WebSocket between add-on and custom component.
- Python side registers entities via HA's native platform APIs.
- User-facing TypeScript API does not change.

## HA WebSocket Client

Persistent connection to `ws://supervisor/core/websocket` for interacting with HA beyond MQTT.

### Authentication

```
1. Connect to ws://supervisor/core/websocket
2. Receive: { type: "auth_required", ha_version: "..." }
3. Send:    { type: "auth", access_token: process.env.SUPERVISOR_TOKEN }
4. Receive: { type: "auth_ok" }
5. Command phase begins
```

`SUPERVISOR_TOKEN` is provided by the Supervisor to all add-ons with `homeassistant_api: true`.

### Commands Used

**Type generation** (build pipeline):
- `get_services` — service definitions with field selectors
- `get_states` — all entity states and attributes
- `config/entity_registry/list` — entity IDs, domains, devices, areas
- `config/device_registry/list` — device metadata
- `config/area_registry/list` — area IDs and names
- `config/label_registry/list` — label IDs and names

**Runtime** (user code via `ha.*` API):
- `subscribe_events` with `event_type: "state_changed"` — state subscriptions for `ha.on()`
- `call_service` — service calls for `ha.callService()`
- `fire_event` — event bus access for `ha.fireEvent()`
- `get_states` (single entity) — state reads for `ha.getState()`

### State Subscriptions

`ha.on()` subscribes to `state_changed` events via WebSocket. The runtime maintains a single `subscribe_events` subscription and demultiplexes incoming events to registered callbacks by entity ID or domain.

Incoming event format:

```json
{
  "id": 18,
  "type": "event",
  "event": {
    "event_type": "state_changed",
    "data": {
      "entity_id": "light.living_room",
      "new_state": { "state": "on", "attributes": { "brightness": 200 } },
      "old_state": { "state": "off", "attributes": { "brightness": 0 } }
    },
    "time_fired": "2024-01-15T10:30:00.000Z"
  }
}
```

### Service Calls

`ha.callService()` sends a `call_service` message via WebSocket:

```json
{
  "id": 24,
  "type": "call_service",
  "domain": "light",
  "service": "turn_on",
  "service_data": { "brightness": 200 },
  "target": { "entity_id": "light.living_room" }
}
```

Parameters are validated against generated validators **before** dispatch. If validation fails, the call is not sent — a descriptive error is thrown and logged.

### Connection Management

- Retry with exponential backoff on disconnect.
- WebSocket unavailability is non-fatal for entity operation (MQTT still works).
- `ha.on()`, `ha.callService()`, and `ha.getState()` calls fail with logged errors if WebSocket is down.
- Subscriptions automatically re-established on reconnect.

## Entity Context

Every entity callback (`init`, `destroy`, `onCommand`, poll functions) runs with `this` bound to an `EntityContext`:

```typescript
interface EntityContext<TState> {
  update: (value: TState, attributes?: Record<string, unknown>) => void;
  attr: (attributes: Record<string, unknown>) => void;
  poll: (fn: () => TState | Promise<TState>, opts: { interval: number; fireImmediately?: boolean } | { cron: string; fireImmediately?: boolean }) => void;
  ha: StatelessHAApi;  // callService, getState, getEntities, fireEvent, friendlyName
  events: EventsContext;  // on, reactions, combine, withState, watchdog, invariant, sequence
  log: {
    debug: (message: string, data?: Record<string, unknown>) => void;
    info: (message: string, data?: Record<string, unknown>) => void;
    warn: (message: string, data?: Record<string, unknown>) => void;
    error: (message: string, data?: Record<string, unknown>) => void;
  };
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
  mqtt: {
    publish: (topic: string, payload: string, opts?: { retain?: boolean }) => void;
    subscribe: (topic: string, handler: (payload: string) => void) => void;
  };
}
```

### Handle Tracking

All handles created through the context (timers, polls, MQTT subscriptions, HA subscriptions) are tracked per entity. On teardown:

1. User `destroy()` runs first for explicit cleanup.
2. Runtime force-disposes anything remaining: clears timers, unsubscribes MQTT topics, removes HA event listeners.

This prevents resource leaks across redeploys. User code never needs to manually track cleanup unless it manages resources outside the context API (e.g., raw `setInterval` calls — which should be avoided in favor of `this.setInterval`).

## Reactive System

### this.events — Entity-Scoped Subscriptions

Entity contexts provide `this.events` with lifecycle-managed subscriptions that auto-clean on teardown. This is the preferred API for entity scripts (over the global `ha.on()`).

#### events.on()

Returns a chainable `EventStream`:

```typescript
this.events.on('light.living_room', (e) => { /* typed callback */ });

// With stream operators
this.events.on('sensor.temperature', (e) => { /* handler */ })
  .filter((e) => Number(e.new_state) > 30)
  .debounce(5000);
```

EventStream operators: `.filter()`, `.map()`, `.debounce(ms)`, `.throttle(ms)`, `.distinctUntilChanged()`, `.onTransition(from, to)`, `.unsubscribe()`.

#### events.reactions()

Declarative reaction rules with optional delayed execution (auto-cancelled on state change).

#### events.combine()

Watch multiple entities, callback fires on any change with all current snapshots.

#### events.withState()

Subscribe to a trigger entity, enriched with context entity snapshots.

#### events.watchdog()

Detect missing expected events within time windows.

#### events.invariant()

Periodic condition checks with violation handlers.

#### events.sequence()

Ordered event detection across multiple entities within time windows.

See the [Entity Context API reference](../reference/entity-context.md) for full signatures.

### ha.on() — Global State Subscriptions

Three overloads, all using discriminated unions for type safety:

```typescript
// Single entity — callback typed to that entity's state/attributes
ha.on('light.living_room', (e) => { /* e.new_state: 'on' | 'off' */ });

// Domain — fires for all entities in that domain
ha.on('light', (e) => { /* e.entity_id: 'light.living_room' | 'light.bedroom' | ... */ });

// Multiple entities
ha.on(['light.living_room', 'light.bedroom'], (e) => { /* union of both */ });
```

### Reaction Maps

Declarative reactive programming:

```typescript
reactions({
  'binary_sensor.front_door': {
    to: 'on',  // typed to entity's valid states
    do: () => ha.callService('light.porch', 'turn_on', { brightness: 255 }),
  },
  'sensor.bedroom_temp': {
    when: (e) => Number(e.new_state) > 25,  // typed event
    do: () => ha.callService('climate.bedroom', 'set_temperature', { temperature: 22 }),
  },
  'switch.garage_door': {
    to: 'on',
    after: 600_000,  // delayed reaction
    do: () => ha.callService('switch.garage_door', 'turn_off'),
  },
});
```

**Delayed reactions** (`after`): A timer is started when the condition matches. If the entity's state changes before the timer fires, the timer is cancelled. This prevents stale reactions.

### Event Demultiplexing

The runtime maintains one WebSocket subscription to `state_changed` events. A routing table maps entity IDs and domains to callback lists. When an event arrives:

1. Look up callbacks registered for the specific entity ID.
2. Look up callbacks registered for the entity's domain.
3. Dispatch to all matched callbacks with the typed event object.

This keeps WebSocket traffic minimal regardless of how many `ha.on()` calls exist.
