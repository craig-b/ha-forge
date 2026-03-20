/**
 * A branded numeric type that carries compile-time range constraints.
 * Used by generated validators to enforce min/max bounds at runtime.
 *
 * @example
 * ```ts
 * type Brightness = NumberInRange<0, 255>;
 * ```
 */
export type NumberInRange<Min extends number, Max extends number> = number & {
  readonly __min: Min;
  readonly __max: Max;
  readonly __brand: 'RangeValidated';
};

/** All supported Home Assistant entity platform types. */
export type EntityType =
  | 'sensor'
  | 'binary_sensor'
  | 'switch'
  | 'light'
  | 'cover'
  | 'climate'
  | 'fan'
  | 'lock'
  | 'humidifier'
  | 'valve'
  | 'water_heater'
  | 'vacuum'
  | 'lawn_mower'
  | 'siren'
  | 'number'
  | 'select'
  | 'text'
  | 'button'
  | 'scene'
  | 'event'
  | 'device_tracker'
  | 'camera'
  | 'alarm_control_panel'
  | 'notify'
  | 'update'
  | 'image';

/**
 * Device metadata for grouping entities under a single HA device.
 * Entities sharing the same `id` appear together in the HA device registry.
 */
export interface DeviceInfo {
  /** Unique device identifier. Entities with the same ID are grouped together. */
  id: string;
  /** Human-readable device name shown in the HA UI. */
  name: string;
  /** Device manufacturer (e.g. `'Acme Corp'`). */
  manufacturer?: string;
  /** Device model (e.g. `'Weather Station v2'`). */
  model?: string;
  /** Software/firmware version string. */
  sw_version?: string;
  /** Suggested area to assign this device to (e.g. `'Living Room'`). */
  suggested_area?: string;
}

/**
 * Logger available on `this.log` inside entity callbacks and on `ha.log` globally.
 * Messages are stored in SQLite and visible in the web UI log viewer.
 */
export interface EntityLogger {
  /** Log a debug-level message. Only visible when log level is set to `debug`. */
  debug(message: string, data?: Record<string, unknown>): void;
  /** Log an info-level message. */
  info(message: string, data?: Record<string, unknown>): void;
  /** Log a warning-level message. */
  warn(message: string, data?: Record<string, unknown>): void;
  /** Log an error-level message. */
  error(message: string, data?: Record<string, unknown>): void;
}

/**
 * Untyped state change event from the HA WebSocket API.
 * Used as the fallback when no generated types are available.
 *
 * @see {@link TypedStateChangedEvent} for the typed version with per-entity state and attributes.
 */
export interface StateChangedEvent {
  /** The entity that changed (e.g. `'light.living_room'`). */
  entity_id: string;
  /** Previous state value. */
  old_state: string;
  /** New state value after the change. */
  new_state: string;
  /** Previous entity attributes. */
  old_attributes: Record<string, unknown>;
  /** New entity attributes after the change. */
  new_attributes: Record<string, unknown>;
  /** Unix timestamp (ms) when the event was fired. */
  timestamp: number;
}

/**
 * Strongly typed state change event. Generated overloads use this to provide
 * per-entity state types, attribute types, and literal entity IDs.
 *
 * @typeParam TState - The entity's state type (e.g. `'on' | 'off'` for lights).
 * @typeParam TAttrs - The entity's attributes type.
 * @typeParam TEntityId - Literal entity ID type for narrowing in domain subscriptions.
 *
 * @example
 * ```ts
 * ha.on('light.kitchen', (event) => {
 *   event.new_state;   // 'on' | 'off'
 *   event.entity_id;   // 'light.kitchen'
 * });
 * ```
 */
export interface TypedStateChangedEvent<TState, TAttrs, TEntityId extends string = string> {
  /** The entity that changed, typed as a literal when subscribing to a specific entity. */
  entity_id: TEntityId;
  /** Previous state value, typed per entity. */
  old_state: TState;
  /** New state value after the change, typed per entity. */
  new_state: TState;
  /** Previous entity attributes, typed per entity. */
  old_attributes: TAttrs;
  /** New entity attributes after the change, typed per entity. */
  new_attributes: TAttrs;
  /** Unix timestamp (ms) when the event was fired. */
  timestamp: number;
}

/** Callback type for untyped state change subscriptions. */
export type StateChangedCallback = (event: StateChangedEvent) => void;

/**
 * A declarative reaction rule for `ha.reactions()`.
 * Defines a condition and action to take when an entity's state changes.
 *
 * @example
 * ```ts
 * ha.reactions({
 *   'binary_sensor.front_door': {
 *     to: 'on',
 *     after: 5000,
 *     do: () => ha.callService('light.porch', 'turn_on'),
 *   },
 * });
 * ```
 */
export interface ReactionRule {
  /** Fire action when the entity transitions to this state value. */
  to?: string;
  /** Custom condition function — return `true` to trigger the action. */
  when?: (event: StateChangedEvent) => boolean;
  /** Action to execute when the condition is met. */
  do: () => void | Promise<void>;
  /** Delay in milliseconds before executing. Cancelled if the entity's state changes again. */
  after?: number;
}

/**
 * Base HA client interface with methods that don't need generated registry types.
 * Extended by `HAClient` which adds `on()`, `callService()`, `getState()`, and `reactions()`.
 */
export interface HAClientBase {
  /** Logger for top-level logging outside of entity callbacks. */
  log: EntityLogger;
  /**
   * List entity IDs registered in Home Assistant.
   * @param domain - Optional domain filter (e.g. `'light'`). Returns all entities if omitted.
   * @returns Array of entity ID strings.
   *
   * @example
   * ```ts
   * const lights = await ha.getEntities('light');
   * // ['light.kitchen', 'light.bedroom', ...]
   * ```
   */
  getEntities(domain?: string): Promise<string[]>;
  /**
   * Fire a custom event on the HA event bus.
   * @param eventType - Event type name (e.g. `'my_custom_event'`).
   * @param eventData - Optional data payload attached to the event.
   */
  fireEvent(eventType: string, eventData?: Record<string, unknown>): Promise<void>;
  /**
   * Get the friendly name of a Home Assistant entity.
   * Returns the `friendly_name` attribute from cached state, or the entity ID if unavailable.
   * @param entityId - The entity ID (e.g. `'light.kitchen'`).
   * @returns The friendly name string.
   *
   * @example
   * ```ts
   * const name = ha.friendlyName('light.kitchen');
   * // 'Kitchen Light'
   * ```
   */
  friendlyName(entityId: string): string;
}

// HAClient is NOT defined in the SDK — it comes from either:
// 1. Generated ha-registry.d.ts (with typed per-entity overloads)
// 2. Untyped fallback appended by the web server when no generated types exist
// This ensures typed overloads always take priority in TypeScript's resolution order.

/**
 * Context object bound as `this` inside entity `init()`, `destroy()`, and `onCommand()` callbacks.
 * Provides methods for publishing state, polling, logging, timers, HTTP, HA API, and MQTT access.
 *
 * @typeParam TState - The entity's state type.
 *
 * @example
 * ```ts
 * sensor({
 *   id: 'cpu_temp',
 *   name: 'CPU Temperature',
 *   init() {
 *     this.poll(async () => {
 *       const resp = await this.fetch('http://localhost/api/temp');
 *       return (await resp.json()).value;
 *     }, { interval: 30_000 });
 *     return '0';
 *   },
 * });
 * ```
 */
export interface EntityContext<TState = unknown> {
  /**
   * Publish a new state value (and optional attributes) to Home Assistant.
   * @param value - The new state value.
   * @param attributes - Optional attributes to publish alongside the state.
   */
  update(value: TState, attributes?: Record<string, unknown>): void;
  /**
   * Start a polling loop that calls `fn` at a fixed interval.
   * If `fn` returns a value, it is automatically published via `update()`.
   * The interval is automatically cleaned up when the entity is destroyed.
   * @param fn - Function to call each interval. Return a value to auto-publish state.
   * @param opts - Polling options.
   */
  poll(fn: () => TState | Promise<TState>, opts: { interval: number; initialDelay?: number }): void;
  /** Scoped logger for this entity. Messages appear in the web UI log viewer. */
  log: EntityLogger;
  /**
   * Schedule a one-shot callback. Automatically cleared on entity teardown.
   * @param fn - Callback to execute.
   * @param ms - Delay in milliseconds.
   */
  setTimeout(fn: () => void, ms: number): void;
  /**
   * Schedule a repeating callback. Automatically cleared on entity teardown.
   * @param fn - Callback to execute.
   * @param ms - Interval in milliseconds.
   */
  setInterval(fn: () => void, ms: number): void;
  /** Standard `fetch()` API for making HTTP requests from entity code. */
  fetch: typeof globalThis.fetch;
  /** Home Assistant client for subscribing to state changes, calling services, and more. */
  ha: HAClientBase;
  /** Direct MQTT publish/subscribe access. */
  mqtt: {
    /** Publish a message to an MQTT topic. */
    publish(topic: string, payload: string, opts?: { retain?: boolean }): void;
    /** Subscribe to an MQTT topic. */
    subscribe(topic: string, handler: (payload: string) => void): void;
  };
}

/**
 * Base interface for all entity definitions.
 * Extended by `SensorDefinition`, `SwitchDefinition`, `LightDefinition`, etc.
 *
 * @typeParam TState - The entity's state type.
 * @typeParam TConfig - The entity's MQTT discovery config type.
 */
export interface BaseEntity<TState, TConfig = Record<string, never>> {
  /** Unique entity identifier. Used as the object_id in MQTT topics. */
  id: string;
  /**
   * Human-readable name shown in the HA UI.
   * When grouped under a device, HA prepends the device name — so set this to
   * just the distinguishing part (e.g. `'Temperature'` under a `'Weather Station'` device).
   * Set to `null` to use the device name as the entity name (for single-entity devices).
   */
  name: string | null;
  /** Entity platform type. */
  type: EntityType;
  /** Optional device to group this entity under. */
  device?: DeviceInfo;
  /** Entity category — `'config'` or `'diagnostic'` entities are hidden from the default UI. */
  category?: 'config' | 'diagnostic';
  /** MDI icon override (e.g. `'mdi:thermometer'`). */
  icon?: string;
  /** Platform-specific MQTT discovery configuration. */
  config?: TConfig;
  /**
   * Called once when the entity is deployed. Return the initial state value.
   * Use `this.poll()`, `this.ha.on()`, etc. to set up ongoing state updates.
   */
  init?(this: EntityContext<TState>): TState | Promise<TState>;
  /**
   * Called when the entity is torn down (before redeploy or shutdown).
   * Use for cleanup of external resources. Tracked timers/intervals are auto-cleared.
   */
  destroy?(this: EntityContext<TState>): void | Promise<void>;
}

// ---- Sensor ----

/**
 * Device class for sensor entities. Determines the default icon,
 * unit of measurement, and display format in the HA UI.
 *
 * @see https://developers.home-assistant.io/docs/core/entity/sensor/#available-device-classes
 */
export type SensorDeviceClass =
  | 'apparent_power'
  | 'aqi'
  | 'atmospheric_pressure'
  | 'battery'
  | 'carbon_dioxide'
  | 'carbon_monoxide'
  | 'current'
  | 'data_rate'
  | 'data_size'
  | 'date'
  | 'distance'
  | 'duration'
  | 'energy'
  | 'energy_storage'
  | 'enum'
  | 'frequency'
  | 'gas'
  | 'humidity'
  | 'illuminance'
  | 'irradiance'
  | 'moisture'
  | 'monetary'
  | 'nitrogen_dioxide'
  | 'nitrogen_monoxide'
  | 'nitrous_oxide'
  | 'ozone'
  | 'ph'
  | 'pm1'
  | 'pm10'
  | 'pm25'
  | 'power'
  | 'power_factor'
  | 'precipitation'
  | 'precipitation_intensity'
  | 'pressure'
  | 'reactive_power'
  | 'signal_strength'
  | 'sound_pressure'
  | 'speed'
  | 'sulphur_dioxide'
  | 'temperature'
  | 'timestamp'
  | 'volatile_organic_compounds'
  | 'volatile_organic_compounds_parts'
  | 'voltage'
  | 'volume'
  | 'volume_flow_rate'
  | 'volume_storage'
  | 'water'
  | 'weight'
  | 'wind_speed';

/** MQTT discovery configuration for sensor entities. */
export interface SensorConfig {
  /** Sensor device class — determines icon and default unit in HA. */
  device_class?: SensorDeviceClass;
  /** Unit of measurement displayed alongside the state value (e.g. `'°C'`, `'kWh'`). */
  unit_of_measurement?: string;
  /** State class for long-term statistics. Use `'measurement'` for instantaneous values, `'total'` for cumulative totals. */
  state_class?: 'measurement' | 'total' | 'total_increasing';
  /** Number of decimal places to display in the HA UI. */
  suggested_display_precision?: number;
}

/** Entity definition for a read-only sensor. State is a string or number. */
export interface SensorDefinition extends BaseEntity<string | number, SensorConfig> {
  type: 'sensor';
}

// ---- Binary sensor ----

/**
 * Device class for binary sensor entities. Determines the default icon
 * and on/off label text in the HA UI.
 *
 * @see https://developers.home-assistant.io/docs/core/entity/binary-sensor/#available-device-classes
 */
export type BinarySensorDeviceClass =
  | 'battery'
  | 'battery_charging'
  | 'carbon_monoxide'
  | 'cold'
  | 'connectivity'
  | 'door'
  | 'garage_door'
  | 'gas'
  | 'heat'
  | 'light'
  | 'lock'
  | 'moisture'
  | 'motion'
  | 'moving'
  | 'occupancy'
  | 'opening'
  | 'plug'
  | 'power'
  | 'presence'
  | 'problem'
  | 'running'
  | 'safety'
  | 'smoke'
  | 'sound'
  | 'tamper'
  | 'update'
  | 'vibration'
  | 'window';

/** MQTT discovery configuration for binary sensor entities. */
export interface BinarySensorConfig {
  /** Binary sensor device class — determines icon and on/off labels in HA. */
  device_class?: BinarySensorDeviceClass;
}

/** Entity definition for a binary (on/off) sensor. */
export interface BinarySensorDefinition extends BaseEntity<'on' | 'off', BinarySensorConfig> {
  type: 'binary_sensor';
}

// ---- Switch ----

/** MQTT discovery configuration for switch entities. */
export interface SwitchConfig {
  /** Switch device class — `'outlet'` for power outlets, `'switch'` for generic switches. */
  device_class?: 'outlet' | 'switch';
}

/** Entity definition for a controllable on/off switch. */
export interface SwitchDefinition extends BaseEntity<'on' | 'off', SwitchConfig> {
  type: 'switch';
  /**
   * Called when HA sends a command to this switch.
   * @param command - `'ON'` or `'OFF'`.
   */
  onCommand(this: EntityContext<'on' | 'off'>, command: 'ON' | 'OFF'): void | Promise<void>;
}

// ---- Light ----

/** Supported color modes for light entities. Determines which color controls appear in the HA UI. */
export type ColorMode =
  | 'onoff'
  | 'brightness'
  | 'color_temp'
  | 'hs'
  | 'rgb'
  | 'rgbw'
  | 'rgbww'
  | 'xy'
  | 'white';

/** MQTT discovery configuration for light entities. */
export interface LightConfig {
  /** Color modes this light supports. Determines available UI controls. */
  supported_color_modes: ColorMode[];
  /** List of named effects (e.g. `['rainbow', 'pulse']`). */
  effect_list?: string[];
  /** Minimum color temperature in Kelvin (e.g. `2000`). */
  min_color_temp_kelvin?: number;
  /** Maximum color temperature in Kelvin (e.g. `6500`). */
  max_color_temp_kelvin?: number;
}

/**
 * Command received from HA when a user interacts with a light entity.
 * Contains the desired state and any color/brightness parameters.
 */
export interface LightCommand {
  /** Desired power state. */
  state: 'ON' | 'OFF';
  /** Brightness level (0–255). */
  brightness?: number;
  /** Color temperature in mireds. */
  color_temp?: number;
  /** RGB color as an object. */
  color?: { r: number; g: number; b: number };
  /** Color temperature in Kelvin. */
  color_temp_kelvin?: number;
  /** Hue/saturation color as `[hue, saturation]`. */
  hs_color?: [number, number];
  /** CIE xy color as `[x, y]`. */
  xy_color?: [number, number];
  /** RGB color as `[r, g, b]` (0–255 each). */
  rgb_color?: [number, number, number];
  /** RGBW color as `[r, g, b, w]`. */
  rgbw_color?: [number, number, number, number];
  /** RGBWW color as `[r, g, b, cold_w, warm_w]`. */
  rgbww_color?: [number, number, number, number, number];
  /** White channel brightness (0–255). */
  white?: number;
  /** Named effect to activate. */
  effect?: string;
  /** Transition time in seconds. */
  transition?: number;
}

/** Current state of a light entity published to HA. */
export interface LightState {
  /** Power state. */
  state: 'on' | 'off';
  /** Current brightness level (0–255). */
  brightness?: number;
  /** Active color mode. */
  color_mode?: ColorMode;
  /** Current color temperature in mireds. */
  color_temp?: number;
  /** Current color temperature in Kelvin. */
  color_temp_kelvin?: number;
  /** Current hue/saturation. */
  hs_color?: [number, number];
  /** Current CIE xy color. */
  xy_color?: [number, number];
  /** Current RGB color. */
  rgb_color?: [number, number, number];
  /** Current RGBW color. */
  rgbw_color?: [number, number, number, number];
  /** Current RGBWW color. */
  rgbww_color?: [number, number, number, number, number];
  /** Currently active effect name. */
  effect?: string;
}

/** Entity definition for a controllable light with optional color and brightness support. */
export interface LightDefinition extends BaseEntity<LightState, LightConfig> {
  type: 'light';
  /**
   * Called when HA sends a command to this light (turn on/off, change color, etc.).
   * @param command - The light command with desired state and parameters.
   */
  onCommand(this: EntityContext<LightState>, command: LightCommand): void | Promise<void>;
}

// ---- Cover ----

/**
 * Device class for cover entities. Determines the default icon
 * and open/close semantics in the HA UI.
 */
export type CoverDeviceClass =
  | 'awning'
  | 'blind'
  | 'curtain'
  | 'damper'
  | 'door'
  | 'garage'
  | 'gate'
  | 'shade'
  | 'shutter'
  | 'window';

/** MQTT discovery configuration for cover entities. */
export interface CoverConfig {
  /** Cover device class — determines icon and open/close labels in HA. */
  device_class?: CoverDeviceClass;
  /** Whether this cover supports position control (0–100). */
  position?: boolean;
  /** Whether this cover supports tilt control (0–100). */
  tilt?: boolean;
}

/**
 * Command received from HA when a user interacts with a cover entity.
 * Discriminated union on the `action` field.
 */
export type CoverCommand =
  | { action: 'open' }
  | { action: 'close' }
  | { action: 'stop' }
  | { action: 'set_position'; position: number }
  | { action: 'set_tilt'; tilt: number };

/** Possible states for a cover entity. */
export type CoverState = 'open' | 'opening' | 'closed' | 'closing' | 'stopped';

/** Entity definition for a controllable cover (blind, garage door, etc.). */
export interface CoverDefinition extends BaseEntity<CoverState, CoverConfig> {
  type: 'cover';
  /**
   * Called when HA sends a command to this cover.
   * @param command - The cover command (open, close, stop, set_position, set_tilt).
   */
  onCommand(this: EntityContext<CoverState>, command: CoverCommand): void | Promise<void>;
}

// ---- Climate ----

/** HVAC operating modes for climate entities. */
export type HVACMode = 'off' | 'heat' | 'cool' | 'heat_cool' | 'auto' | 'dry' | 'fan_only';

/** MQTT discovery configuration for climate entities. */
export interface ClimateConfig {
  /** Supported HVAC modes for this climate device. */
  hvac_modes: HVACMode[];
  /** Supported fan speed modes (e.g. `['low', 'medium', 'high']`). */
  fan_modes?: string[];
  /** Supported preset modes (e.g. `['home', 'away', 'boost']`). */
  preset_modes?: string[];
  /** Supported swing modes (e.g. `['on', 'off']`). */
  swing_modes?: string[];
  /** Minimum settable temperature. */
  min_temp?: number;
  /** Maximum settable temperature. */
  max_temp?: number;
  /** Temperature increment step. */
  temp_step?: number;
  /** Temperature unit — `'C'` for Celsius, `'F'` for Fahrenheit. */
  temperature_unit?: 'C' | 'F';
}

/**
 * Command received from HA when a user interacts with a climate entity.
 * All fields are optional — only changed values are sent.
 */
export interface ClimateCommand {
  /** Target HVAC mode. */
  hvac_mode?: HVACMode;
  /** Target temperature. */
  temperature?: number;
  /** Upper bound for dual-setpoint mode. */
  target_temp_high?: number;
  /** Lower bound for dual-setpoint mode. */
  target_temp_low?: number;
  /** Target fan mode. */
  fan_mode?: string;
  /** Target swing mode. */
  swing_mode?: string;
  /** Target preset mode. */
  preset_mode?: string;
}

/** Current state of a climate entity published to HA. */
export interface ClimateState {
  /** Current HVAC operating mode. */
  mode: HVACMode;
  /** Current measured temperature from the device's sensor. */
  current_temperature?: number;
  /** Target temperature setpoint. */
  temperature?: number;
  /** Upper target temperature for dual-setpoint mode. */
  target_temp_high?: number;
  /** Lower target temperature for dual-setpoint mode. */
  target_temp_low?: number;
  /** Current fan mode. */
  fan_mode?: string;
  /** Current swing mode. */
  swing_mode?: string;
  /** Current preset mode. */
  preset_mode?: string;
  /** Current HVAC action — what the device is actually doing right now. */
  action?: 'off' | 'heating' | 'cooling' | 'drying' | 'idle' | 'fan';
}

/** Entity definition for a climate device (thermostat, AC, etc.). */
export interface ClimateDefinition extends BaseEntity<ClimateState, ClimateConfig> {
  type: 'climate';
  /**
   * Called when HA sends a command to this climate device.
   * @param command - The climate command with changed settings.
   */
  onCommand(this: EntityContext<ClimateState>, command: ClimateCommand): void | Promise<void>;
}

/** Union of all supported entity definition types. */
export type EntityDefinition =
  | SensorDefinition
  | BinarySensorDefinition
  | SwitchDefinition
  | LightDefinition
  | CoverDefinition
  | ClimateDefinition;

/**
 * A function that returns an array of entity definitions.
 * Use `entityFactory()` to create one when you need dynamic entity creation.
 */
export type EntityFactory = () => EntityDefinition[] | Promise<EntityDefinition[]>;

/** Internal type representing a resolved entity with its source file and device assignment. */
export interface ResolvedEntity {
  /** The entity definition. */
  definition: EntityDefinition;
  /** Path to the source `.ts` file that defined this entity. */
  sourceFile: string;
  /** Device ID this entity is assigned to. */
  deviceId: string;
}

// ---- Device ----

/**
 * Handle for updating an entity's state from within a device's `init()`.
 * @typeParam TState - The entity's state type.
 */
export interface DeviceEntityHandle<TState> {
  /** Publish a new state value for this entity. */
  update(value: TState, attributes?: Record<string, unknown>): void;
}

/**
 * Handle for a bidirectional entity (switch, light, cover, climate) within a device.
 * Adds `onCommand()` registration to the base handle.
 */
export interface DeviceCommandEntityHandle<TState, TCommand> extends DeviceEntityHandle<TState> {
  /** Register a command handler for this entity. */
  onCommand(handler: (command: TCommand) => void | Promise<void>): void;
}

/**
 * Maps an entity definition type to its device handle type.
 * Sensors get update-only handles; bidirectional entities also get onCommand.
 */
export type EntityHandleFor<T extends EntityDefinition> =
  T extends SwitchDefinition ? DeviceCommandEntityHandle<'on' | 'off', 'ON' | 'OFF'> :
  T extends LightDefinition ? DeviceCommandEntityHandle<LightState, LightCommand> :
  T extends CoverDefinition ? DeviceCommandEntityHandle<CoverState, CoverCommand> :
  T extends ClimateDefinition ? DeviceCommandEntityHandle<ClimateState, ClimateCommand> :
  T extends SensorDefinition ? DeviceEntityHandle<string | number> :
  T extends BinarySensorDefinition ? DeviceEntityHandle<'on' | 'off'> :
  DeviceEntityHandle<unknown>;

/**
 * Context bound as `this` inside a device's `init()` and `destroy()` callbacks.
 * Provides managed timers, HTTP access, HA client, and typed handles for each entity.
 */
export interface DeviceContext<TEntities extends Record<string, EntityDefinition>> {
  /** Typed handles for updating each entity in the device. */
  entities: { [K in keyof TEntities]: EntityHandleFor<TEntities[K]> };
  /**
   * Start a managed polling loop. Fires immediately, then repeats on interval.
   * Unlike entity poll(), this does NOT auto-update a state — call
   * `this.entities.xxx.update()` inside the callback.
   */
  poll(fn: () => void | Promise<void>, opts: { interval: number; initialDelay?: number }): void;
  /** Scoped logger for this device. */
  log: EntityLogger;
  /** Home Assistant client for state subscriptions, service calls, and more. */
  ha: HAClientBase;
  /** Standard `fetch()` API for HTTP requests. */
  fetch: typeof globalThis.fetch;
  /** Schedule a one-shot callback. Auto-cleared on device teardown. */
  setTimeout(fn: () => void, ms: number): void;
  /** Schedule a repeating callback. Auto-cleared on device teardown. */
  setInterval(fn: () => void, ms: number): void;
  /** Direct MQTT publish/subscribe access. */
  mqtt: {
    publish(topic: string, payload: string, opts?: { retain?: boolean }): void;
    subscribe(topic: string, handler: (payload: string) => void): void;
  };
}

/**
 * Options for defining a device with grouped entities.
 * @typeParam TEntities - Map of entity keys to entity definitions.
 */
export interface DeviceOptions<TEntities extends Record<string, EntityDefinition>> {
  /** Unique device identifier. */
  id: string;
  /** Human-readable device name shown in the HA UI. */
  name: string;
  /** Device manufacturer. */
  manufacturer?: string;
  /** Device model. */
  model?: string;
  /** Software/firmware version. */
  sw_version?: string;
  /** Suggested area to assign this device to. */
  suggested_area?: string;
  /** Map of entity keys to entity definitions. */
  entities: TEntities;
  /** Called once when the device is deployed. Set up polling, subscriptions, and command handlers. */
  init(this: DeviceContext<TEntities>): void | Promise<void>;
  /** Called when the device is torn down. Use for cleanup beyond auto-tracked handles. */
  destroy?(this: DeviceContext<TEntities>): void | Promise<void>;
}

/**
 * A device definition that groups multiple entities with a shared lifecycle.
 * Created by the `device()` factory function.
 */
export interface DeviceDefinition<TEntities extends Record<string, EntityDefinition> = Record<string, EntityDefinition>> {
  /** Discriminant for loader detection. */
  __kind: 'device';
  /** Unique device identifier. */
  id: string;
  /** Human-readable device name shown in the HA UI. */
  name: string;
  /** Device manufacturer. */
  manufacturer?: string;
  /** Device model. */
  model?: string;
  /** Software/firmware version. */
  sw_version?: string;
  /** Suggested area to assign this device to. */
  suggested_area?: string;
  /** Map of entity keys to entity definitions. */
  entities: TEntities;
  /** Called once when the device is deployed. */
  init(this: DeviceContext<TEntities>): void | Promise<void>;
  /** Called when the device is torn down. */
  destroy?(this: DeviceContext<TEntities>): void | Promise<void>;
}
