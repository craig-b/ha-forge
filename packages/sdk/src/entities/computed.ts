import type { SensorConfig, ComputedDefinition, ComputedAttribute, DeviceInfo, EntitySnapshot } from '../types.js';

/** Options for defining a computed (derived) sensor entity. */
export interface ComputedOptions<TWatch extends string = string> {
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
  watch: TWatch[];
  /**
   * Pure function that derives state from current values of watched entities.
   * Receives a map of watched entity IDs to their current state snapshot (or `null` if unknown).
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
  compute: (states: { [K in TWatch]: EntitySnapshot | null }) => string | number;
  /**
   * Debounce window in ms for coalescing rapid input changes. Default: `100`.
   * Set to `0` to re-evaluate immediately on every change.
   */
  debounce?: number;
}

/** Options for a computed attribute (second argument to `computed(fn, opts)`). */
export interface ComputedAttributeOptions<TWatch extends string = string> {
  /** Entity IDs to watch. When any changes state, the attribute is re-evaluated. */
  watch: TWatch[];
  /** Debounce window in ms. Default: `100`. */
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
export function computed<TWatch extends string>(options: ComputedOptions<TWatch>): ComputedDefinition<TWatch>;
/**
 * Create a reactive computed attribute for use inside entity `attributes`.
 * The runtime auto-subscribes to watched entities and re-publishes the
 * owning entity's attributes when the derived value changes.
 *
 * @param fn - Pure function that derives the attribute value from watched entity snapshots.
 * @param opts - Watch list and optional debounce.
 * @returns A `ComputedAttribute` marker used by the runtime.
 *
 * @example
 * ```ts
 * export const temp = sensor({
 *   id: 'cpu_temp',
 *   name: 'CPU Temperature',
 *   attributes: {
 *     severity: computed(
 *       (states) => {
 *         const t = Number(states['sensor.cpu_temp']?.state);
 *         return t > 80 ? 'critical' : t > 60 ? 'warning' : 'normal';
 *       },
 *       { watch: ['sensor.cpu_temp'] },
 *     ),
 *   },
 * });
 * ```
 */
export function computed<TWatch extends string>(
  fn: (states: { [K in TWatch]: EntitySnapshot | null }) => unknown,
  opts: ComputedAttributeOptions<TWatch>,
): ComputedAttribute<TWatch>;
export function computed(
  optionsOrFn: ComputedOptions | ((states: Record<string, EntitySnapshot | null>) => unknown),
  opts?: ComputedAttributeOptions,
): ComputedDefinition | ComputedAttribute {
  // Overload 2: computed(fn, { watch }) → ComputedAttribute
  if (typeof optionsOrFn === 'function') {
    if (!opts) throw new Error('computed(fn, opts): opts with watch[] is required');
    return {
      __computedAttr: true as const,
      watch: opts.watch,
      compute: optionsOrFn,
      ...(opts.debounce !== undefined && { debounce: opts.debounce }),
    };
  }

  // Overload 1: computed({ id, watch, compute, ... }) → ComputedDefinition
  const options = optionsOrFn;
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
