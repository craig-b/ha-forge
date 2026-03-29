import type { BaseEntity, EntitySnapshot } from './core.js';

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

/**
 * Maps a sensor device class to its state type.
 * - `timestamp` / `date` → `Date` (runtime serializes to ISO 8601)
 * - `enum` → `string`
 * - All other device classes → `number`
 * - No device class (`undefined`) → `string | number | Date`
 */
export type SensorStateFor<DC extends SensorDeviceClass | undefined> =
  DC extends 'timestamp' | 'date' ? Date :
  DC extends 'enum' ? string :
  DC extends undefined ? string | number | Date :
  number;

/** MQTT discovery configuration for sensor entities. */
export interface SensorConfig<DC extends SensorDeviceClass | undefined = SensorDeviceClass | undefined> {
  /** Sensor device class — determines icon and default unit in HA. */
  device_class?: DC;
  /** Unit of measurement displayed alongside the state value (e.g. `'°C'`, `'kWh'`). */
  unit_of_measurement?: string;
  /** State class for long-term statistics. Use `'measurement'` for instantaneous values, `'total'` for cumulative totals. */
  state_class?: 'measurement' | 'total' | 'total_increasing';
  /** Number of decimal places to display in the HA UI. */
  suggested_display_precision?: number;
}

/** Entity definition for a read-only sensor. State type is inferred from the device class. */
export interface SensorDefinition<DC extends SensorDeviceClass | undefined = SensorDeviceClass | undefined> extends BaseEntity<SensorStateFor<DC>, SensorConfig<DC>> {
  type: 'sensor';
}

/**
 * Entity definition for a computed (derived) sensor.
 * State is a pure function of other entities' current state — no `init()` or `destroy()`.
 * The runtime auto-subscribes to `watch` entities and re-evaluates `compute()` on change.
 *
 * Created by the `computed()` factory function.
 *
 * @example
 * ```ts
 * export const comfort = computed({
 *   id: 'comfort_index',
 *   name: 'Comfort Index',
 *   watch: ['sensor.temperature', 'sensor.humidity'],
 *   compute: (states) => {
 *     const temp = Number(states['sensor.temperature']?.state);
 *     const humidity = Number(states['sensor.humidity']?.state);
 *     return Math.round(temp + 0.05 * humidity);
 *   },
 *   config: { unit_of_measurement: '°C', device_class: 'temperature' },
 * });
 * ```
 */
export interface ComputedDefinition<TWatch extends string = string> extends SensorDefinition {
  /** Entity IDs to watch. When any changes state, `compute()` is re-evaluated. */
  watch: TWatch[];
  /**
   * Pure function that derives state from current values of watched entities.
   * Receives a map of watched entity IDs to their current state snapshot (or `null` if unknown).
   * Return value becomes the entity's published state.
   */
  compute: (states: { [K in TWatch]: EntitySnapshot | null }) => string | number | Date;
  /**
   * Debounce window in ms for coalescing rapid input changes.
   * When multiple watched entities change in quick succession, `compute()` runs
   * once after the debounce window instead of once per change. Default: `100`.
   */
  debounce?: number;
  /**
   * When `true`, don't evaluate until a watched entity changes.
   * When `false` (default), fetch current state of all watched entities
   * and evaluate immediately on init.
   */
  lazy?: boolean;
}
