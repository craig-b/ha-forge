import type { ValveConfig, ValveDefinition, ValveCommand, ValveState, EntityContext, ComputedAttribute } from '../types.js';

/** Options for defining a valve entity. */
export interface ValveOptions<TAttrs extends Record<string, unknown> = Record<string, unknown>> {
  /** Unique entity identifier. Becomes the object_id in MQTT topics (e.g. `'main_water'` → `valve.main_water`). */
  id: string;
  /** Human-readable name shown in the HA UI. */
  name: string;
  /** Optional device to group this entity under. */
  device?: ValveDefinition['device'];
  /** Entity category — `'config'` or `'diagnostic'` entities are hidden from the default UI. */
  category?: ValveDefinition['category'];
  /** MDI icon override (e.g. `'mdi:valve'`). */
  icon?: string;
  /** Valve-specific MQTT discovery config (device_class, reports_position). */
  config?: ValveConfig;
  /** Declarative attributes published alongside the entity state. Values can be static or reactive via `computed()`. */
  attributes?: { [K in keyof TAttrs]: TAttrs[K] | ComputedAttribute };
  /**
   * Called when HA sends a command to this valve (open, close, stop, set_position).
   * @param command - Discriminated union on `action` field.
   */
  onCommand(this: EntityContext<ValveState, TAttrs>, command: ValveCommand): void | Promise<void>;
  /**
   * Called once when the entity is deployed. Return the initial valve state.
   */
  init?(this: EntityContext<ValveState, TAttrs>): ValveState | Promise<ValveState>;
  /** Called when the entity is torn down. Use for cleanup of external resources. */
  destroy?(this: EntityContext<ValveState, TAttrs>): void | Promise<void>;
}

/**
 * Define a controllable valve entity (water valve, gas valve, etc.).
 *
 * @param options - Valve configuration including id, name, onCommand handler, and optional init/destroy.
 * @returns A `ValveDefinition` registered with Home Assistant via MQTT discovery.
 *
 * @example
 * ```ts
 * valve({
 *   id: 'garden_water',
 *   name: 'Garden Water Valve',
 *   config: { device_class: 'water' },
 *   onCommand(command) {
 *     switch (command.action) {
 *       case 'open':  this.update('open'); break;
 *       case 'close': this.update('closed'); break;
 *       case 'stop':  this.update('stopped'); break;
 *     }
 *   },
 *   init() {
 *     return 'closed';
 *   },
 * });
 * ```
 */
export function valve<TAttrs extends Record<string, unknown> = Record<string, unknown>>(options: ValveOptions<TAttrs>): ValveDefinition {
  return {
    ...options,
    type: 'valve',
  };
}
