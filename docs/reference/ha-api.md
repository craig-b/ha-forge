# HA API Reference

> For usage examples, see the [Reactive Patterns guide](../guide/reactive.md).

The HA API provides access to Home Assistant's services, state, entity registry, event bus, and entity metadata. It is available in two forms:

- **`this.ha`** — Inside entity lifecycle callbacks (`init()`, `destroy()`, `onCommand()`, etc.), the `StatelessHAApi` interface with query/action methods only.
- **`ha`** (global) — A typed `HAClient` available at module scope. When generated types are present, entity IDs, service names, and parameters are fully typed with autocomplete.

Both forms use the same underlying implementation backed by the HA WebSocket API. The global `ha` additionally includes `on()` and `reactions()` methods for top-level subscriptions (though inside entities, prefer `this.events` for lifecycle-managed subscriptions).

---

## callService

Call a Home Assistant service on a specific entity or an entire domain.

```ts
callService(
  entity: string,
  service: string,
  data?: Record<string, unknown>,
): Promise<Record<string, unknown> | null>
```

**Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `entity` | `string` | Yes | Entity ID (e.g. `'light.kitchen'`) or domain name (e.g. `'light'`). If the string contains a `.`, it targets a specific entity. If it has no `.`, it targets all entities in the domain. |
| `service` | `string` | Yes | Service name (e.g. `'turn_on'`, `'set_temperature'`). |
| `data` | `Record<string, unknown>` | No | Service data payload. Fields depend on the service being called. |

**Returns:** `Promise<Record<string, unknown> | null>` — The service response data if the service returns a response, or `null`.

**With generated types:**

When HA registry types are generated, `callService` gains typed overloads:

```ts
callService<E extends HAEntityId, S extends keyof HAEntityMap[E]['services']>(
  entity: E,
  service: S,
  data?: HAEntityMap[E]['services'][S],
): Promise<Record<string, unknown> | null>
```

This provides:
- Autocomplete for entity IDs and service names.
- Compile-time validation of service parameters.
- `NumberInRange<Min, Max>` constraints on numeric parameters.
- String literal unions for select/option fields.

**Runtime validation:**

Before dispatching to HA, `callService` validates parameters against generated runtime validators (if available). Validation checks:

- **Range validators:** Numeric parameters checked against min/max bounds. Throws `RangeError` with a descriptive message (e.g., `"Expected number in range 0-255, got 999"`).
- **OneOf validators:** String parameters checked against allowed options. Throws `TypeError` (e.g., `"Expected one of [short, long], got medium"`).
- **RGB validators:** Color tuples checked for correct length and value ranges.

If validation fails, the service call is NOT dispatched to HA. The error is logged with full context (service name, parameter name, expected constraint, actual value).

**Error handling:**

| Scenario | Behavior |
|---|---|
| Validation failure (bad parameter) | Throws synchronously. Service call not dispatched. Error logged. |
| WebSocket disconnected | Promise rejects. Error logged. |
| Service call fails in HA | Promise rejects with HA error. |
| Entity does not exist in HA | Service call proceeds (HA handles the error). |

**Examples:**

```ts
// Target a specific entity
await this.ha.callService('light.kitchen', 'turn_on', {
  brightness: 200,
  transition: 2,
});

// Target all entities in a domain
await this.ha.callService('light', 'turn_off');

// Service with response
const result = await this.ha.callService('conversation', 'process', {
  text: 'Turn on the lights',
});
```

---

## getState

Get the current state of a Home Assistant entity.

```ts
getState(entityId: string): Promise<{
  state: string;
  attributes: Record<string, unknown>;
  last_changed: string;
  last_updated: string;
} | null>
```

**Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `entityId` | `string` | Yes | The entity ID (e.g. `'sensor.temperature'`). |

**Returns:** A state object, or `null` if the entity does not exist.

| Field | Type | Description |
|---|---|---|
| `state` | `string` | Current state value (e.g. `'on'`, `'23.5'`, `'home'`). |
| `attributes` | `Record<string, unknown>` | Entity attributes (e.g. `friendly_name`, `unit_of_measurement`, etc.). |
| `last_changed` | `string` | ISO 8601 timestamp of the last state value change. |
| `last_updated` | `string` | ISO 8601 timestamp of the last state or attribute update. |

**With generated types:**

```ts
getState<E extends HAEntityId>(entity: E): Promise<{
  state: HAEntityMap[E]['state'];
  attributes: HAEntityMap[E]['attributes'];
  last_changed: string;
  last_updated: string;
} | null>
```

**Caching:**

- The runtime maintains an in-memory state cache populated from WebSocket `state_changed` events.
- `getState()` checks the cache first. On cache hit, returns immediately without a WebSocket call.
- On cache miss, fetches all states via `get_states` WebSocket command and populates the cache.
- The cache is updated automatically as state change events arrive.

**Null cases:**

- Entity ID does not exist in HA.
- WebSocket is disconnected and entity was never cached.
- Entity was removed from HA after the cache was populated.

---

## getEntities

List entity IDs registered in Home Assistant, optionally filtered by domain.

```ts
getEntities(domain?: string): Promise<string[]>
```

**Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `domain` | `string` | No | Domain to filter by (e.g. `'light'`, `'sensor'`). If omitted, returns all entity IDs. |

**Returns:** `Promise<string[]>` — Array of entity ID strings.

**Behavior:**

- Fetches all states via `get_states` WebSocket command.
- Updates the internal state cache with all returned states.
- Filters by domain prefix if `domain` is provided (e.g., `'light'` matches `'light.kitchen'`, `'light.bedroom'`).

**Examples:**

```ts
// All entities
const all = await this.ha.getEntities();

// Only lights
const lights = await this.ha.getEntities('light');

// Dynamic entity creation based on existing entities
const sensors = await this.ha.getEntities('sensor');
```

---

## fireEvent

Fire a custom event on the HA event bus.

```ts
fireEvent(eventType: string, eventData?: Record<string, unknown>): Promise<void>
```

**Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `eventType` | `string` | Yes | Event type name (e.g. `'my_custom_event'`, `'ha_forge_notification'`). |
| `eventData` | `Record<string, unknown>` | No | Data payload attached to the event. Defaults to `{}`. |

**Behavior:**

- Sends a `fire_event` command via WebSocket.
- The event is visible to all HA automations and integrations subscribed to that event type.
- Does not wait for event processing — returns when HA acknowledges the command.

**Example:**

```ts
await this.ha.fireEvent('ha_forge_alert', {
  entity_id: 'sensor.water_leak',
  severity: 'critical',
  message: 'Water leak detected in basement',
});
```

---

## friendlyName

Get the friendly name of a Home Assistant entity. Returns the `friendly_name` attribute from cached state, or the raw entity ID if the friendly name is unavailable.

```ts
friendlyName(entityId: string): string
```

**Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `entityId` | `string` | Yes | The entity ID (e.g. `'light.kitchen'`). |

**Returns:** `string` — The friendly name (e.g. `'Kitchen Light'`) or the entity ID if no friendly name is cached.

**Behavior:**

- Synchronous — reads from the in-memory state cache only.
- Does NOT make a WebSocket call. If the entity hasn't been cached yet (e.g., `getState()` was never called and no state change event was received for it), returns the raw entity ID.
- Useful for log messages, notification text, and dynamic entity names.

---

## Global ha.on() and ha.reactions()

The global `ha` object (available at module scope) is an `HAClient`, which extends `StatelessHAApi` with two subscription methods: `on()` and `reactions()`. These are **only** on the global `ha` -- they are NOT available on `this.ha` inside entity callbacks (which is the `StatelessHAApi` interface). Inside entities, use `this.events.on()` and `this.events.reactions()` instead, which are lifecycle-managed.

### ha.on()

Subscribe to state changes for a Home Assistant entity, domain, or array of entities at module scope.

```ts
ha.on(
  entityOrDomain: string | string[],
  callback: (event: StateChangedEvent) => void,
): () => void
```

**Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `entityOrDomain` | `string \| string[]` | Yes | Entity ID (e.g. `'light.kitchen'`), domain name (e.g. `'light'`), or array of entity IDs/domains. If the string contains a `.`, it's treated as an entity ID; otherwise as a domain. |
| `callback` | `(event: StateChangedEvent) => void` | Yes | Called with each state change event. |

**Returns:** `() => void` -- Cleanup function that removes the subscription.

### ha.reactions()

Set up declarative reaction rules at module scope. Maps entity IDs to reaction rules.

```ts
ha.reactions(rules: Record<string, ReactionRule>): () => void
```

**Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `rules` | `Record<string, ReactionRule>` | Yes | Map of entity IDs to reaction rules. See [ReactionRule](#reactionrule) below. |

**Returns:** `() => void` -- Cleanup function that removes all subscriptions and cancels pending timers.

**ReactionRule:**

```ts
interface ReactionRule {
  to?: string;
  when?: (event: StateChangedEvent) => boolean;
  do: () => void | Promise<void>;
  after?: number;
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `to` | `string` | No | Fire when entity transitions to this state value. |
| `when` | `(event: StateChangedEvent) => boolean` | No | Custom condition. Mutually exclusive with `to` (if both set, `to` takes priority). |
| `do` | `() => void \| Promise<void>` | Yes | Action to execute when the condition is met. |
| `after` | `number` | No | Delay in ms before executing. Cancelled if the entity's state changes again before the timer fires. |

If neither `to` nor `when` is specified, the rule fires on every state change. When `after` is set and the state changes again before the timer fires, the pending timer is cancelled. If the new state still matches the condition, a new timer is started.

**Example:**

```ts
// Module-scope subscription — NOT inside init()
const unsub = ha.on('binary_sensor.front_door', (event) => {
  if (event.new_state === 'on') {
    ha.callService('light.porch', 'turn_on');
  }
});

// Declarative reactions at module scope
ha.reactions({
  'binary_sensor.motion_sensor': {
    to: 'off',
    after: 300_000,  // 5 minutes
    do: () => ha.callService('light.hallway', 'turn_off'),
  },
});
```

> **Prefer `this.events` inside entities.** The global `ha.on()` and `ha.reactions()` subscriptions are not lifecycle-managed -- they persist until explicitly unsubscribed or the runtime shuts down. Inside entity `init()`, always use `this.events.on()` and `this.events.reactions()`, which are automatically cleaned up when the entity is destroyed.

---

## Error Handling

### WebSocket disconnection

When the WebSocket connection to HA is unavailable:

- `callService()`, `getState()`, `getEntities()`, `fireEvent()` — promises reject with an error.
- `friendlyName()` — returns the entity ID (synchronous, cache-only).
- `on()` subscriptions continue to work for entities where state change events have already been received. New subscriptions are registered but won't receive events until the connection is restored.

The WebSocket client retries with exponential backoff. When the connection is re-established, event subscriptions are automatically restored.

### Stub behavior

If the runtime starts without a WebSocket connection (e.g., HA is not yet running), the context methods log warnings instead of throwing:

```
this.ha.callService() unavailable — no WebSocket connection
this.ha.getState() unavailable — no WebSocket connection
this.ha.getEntities() unavailable — no WebSocket connection
this.ha.fireEvent() unavailable — no WebSocket connection
```

The entity still initializes and can be used for MQTT-only operations. HA API methods become functional once the WebSocket connection is established.

### Service call validation errors

Validation errors from generated runtime validators are thrown synchronously before the WebSocket call:

- `RangeError` for numeric parameters outside their valid range.
- `TypeError` for string parameters not in the allowed set.

These errors include descriptive messages identifying the constraint, expected range/values, and actual value. They are logged to SQLite with the entity context.
