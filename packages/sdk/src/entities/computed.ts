import type { SensorConfig, ComputedDefinition, ComputedAttribute, DeviceInfo, EntitySnapshot, EntityContext } from '../types.js';

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
  compute: (states: { [K in TWatch]: EntitySnapshot | null }) => string | number | Date | Date;
  /**
   * Debounce window in ms for coalescing rapid input changes. Default: `100`.
   * Set to `0` to re-evaluate immediately on every change.
   */
  debounce?: number;
  /**
   * When `true`, don't evaluate until a watched entity changes.
   * When `false` (default), fetch current state of all watched entities
   * and evaluate immediately on init.
   */
  lazy?: boolean;
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
 * State is a pure function of other entities — no manual `init()` or polling needed.
 * The runtime auto-subscribes to watched entities and re-evaluates on change.
 * Only publishes when the computed value actually differs (deduplication).
 *
 * Compatible with behaviors (`buffered`, `debounced`, `filtered`, `sampled`)
 * since computed entities use the standard `init()` + `this.update()` lifecycle.
 *
 * @param options - Computed entity configuration.
 * @returns A `ComputedDefinition` (sensor with generated init).
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
 *
 * // Smoothed computed — evaluate every 30s average:
 * export const smoothedComfort = buffered(comfort, { interval: 30_000, reduce: average });
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
  const { watch, compute: computeFn, debounce: debounceMs = 100, lazy = false } = options;

  return {
    type: 'sensor',
    id: options.id,
    name: options.name,
    watch,
    compute: computeFn,
    lazy,
    ...(options.debounce !== undefined && { debounce: options.debounce }),
    ...(options.device && { device: options.device }),
    ...(options.category && { category: options.category }),
    ...(options.icon && { icon: options.icon }),
    ...(options.config && { config: options.config }),

    // Generated init — sets up watch subscriptions via this.events.combine()
    async init(this: EntityContext<string | number | Date>) {
      let lastValue: string | number | Date | undefined;

      const evaluate = (states: Record<string, EntitySnapshot | null>) => {
        try {
          const value = computeFn(states as Parameters<typeof computeFn>[0]);
          // Dedup — only publish when value actually changes
          if (String(value) !== String(lastValue)) {
            lastValue = value;
            this.update(value);
          }
        } catch (err) {
          this.log.error('compute() failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      };

      // Debounced evaluate
      let pending: unknown;
      const debouncedEvaluate = (states: Record<string, EntitySnapshot | null>) => {
        if (pending) this.clearTimeout(pending as ReturnType<typeof setTimeout>);
        if (debounceMs <= 0) {
          evaluate(states);
        } else {
          const captured = states;
          pending = this.setTimeout(() => {
            pending = null;
            evaluate(captured);
          }, debounceMs);
        }
      };

      // Subscribe to all watched entities
      this.events.combine(watch, debouncedEvaluate);

      // Non-lazy: fetch initial state and evaluate immediately
      if (!lazy) {
        const states: Record<string, EntitySnapshot | null> = {};
        for (const eid of watch) {
          const s = await this.ha.getState(eid);
          states[eid] = s ? { state: s.state, attributes: s.attributes } : null;
        }
        const initialValue = computeFn(states as Parameters<typeof computeFn>[0]);
        lastValue = initialValue;
        return initialValue;
      }

      // Lazy: no initial state — entity stays unknown until first watched entity changes
      return undefined as unknown as string | number | Date;
    },
  } as ComputedDefinition;
}
