import type { SensorConfig, ComputedDefinition, DeviceInfo, EntitySnapshot } from '../types.js';

/** Options for defining a computed (derived) sensor entity. */
export interface ComputedOptions {
  /** Unique entity identifier. Becomes the object_id in MQTT topics (e.g. `'comfort_index'` → `sensor.comfort_index`). */
  id: string;
  /** Human-readable name shown in the HA UI. */
  name: string;
  /** Optional device to group this entity under. */
  device?: DeviceInfo;
  /** Entity category — `'config'` or `'diagnostic'` entities are hidden from the default UI. */
  category?: 'config' | 'diagnostic';
  /** MDI icon override (e.g. `'mdi:thermometer'`). */
  icon?: string;
  /** Sensor-specific MQTT discovery config (device_class, unit_of_measurement, state_class). */
  config?: SensorConfig;
  /** Entity IDs to watch. When any changes state, `compute()` is re-evaluated. */
  watch: string[];
  /**
   * Pure function that derives state from current values of watched entities.
   * Receives a map of entity IDs to their current state snapshot (or `null` if unknown).
   * Return value becomes the entity's published state.
   *
   * @example
   * ```ts
   * compute: (states) => {
   *   const temp = Number(states['sensor.temperature']?.state);
   *   return temp > 30 ? 'hot' : 'comfortable';
   * }
   * ```
   */
  compute: (states: Record<string, EntitySnapshot | null>) => string | number;
  /**
   * Debounce window in ms for coalescing rapid input changes. Default: `100`.
   * Set to `0` to re-evaluate immediately on every change.
   */
  debounce?: number;
}

/**
 * Define a computed (derived) sensor entity.
 * State is a pure function of other entities — no `init()`, no polling.
 * The runtime auto-subscribes to watched entities and re-evaluates on change.
 * Only publishes when the computed value actually differs.
 *
 * @param options - Computed entity configuration.
 * @returns A `ComputedDefinition` registered with Home Assistant via MQTT discovery.
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
export function computed(options: ComputedOptions): ComputedDefinition {
  return {
    type: 'sensor',
    __computed: true,
    id: options.id,
    name: options.name,
    watch: options.watch,
    compute: options.compute,
    ...(options.debounce !== undefined && { debounce: options.debounce }),
    ...(options.device && { device: options.device }),
    ...(options.category && { category: options.category }),
    ...(options.icon && { icon: options.icon }),
    ...(options.config && { config: options.config }),
  };
}
