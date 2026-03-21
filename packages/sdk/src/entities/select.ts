import type { SelectConfig, SelectDefinition, EntityContext, ComputedAttribute } from '../types.js';

/** Options for defining a select entity. */
export interface SelectOptions<TAttrs extends Record<string, unknown> = Record<string, unknown>> {
  /** Unique entity identifier. Becomes the object_id in MQTT topics (e.g. `'wash_mode'` → `select.wash_mode`). */
  id: string;
  /** Human-readable name shown in the HA UI. */
  name: string;
  /** Optional device to group this entity under. */
  device?: SelectDefinition['device'];
  /** Entity category — `'config'` or `'diagnostic'` entities are hidden from the default UI. */
  category?: SelectDefinition['category'];
  /** MDI icon override (e.g. `'mdi:format-list-bulleted'`). */
  icon?: string;
  /** Select-specific MQTT discovery config (options list). Required. */
  config: SelectConfig;
  /** Declarative attributes published alongside the entity state. Values can be static or reactive via `computed()`. */
  attributes?: { [K in keyof TAttrs]: TAttrs[K] | ComputedAttribute };
  /**
   * Called when HA sends a new selection to this select entity.
   * @param command - The selected option string.
   */
  onCommand(this: EntityContext<string, TAttrs>, command: string): void | Promise<void>;
  /**
   * Called once when the entity is deployed. Return the initial selected option.
   */
  init?(this: EntityContext<string, TAttrs>): string | Promise<string>;
  /** Called when the entity is torn down. Use for cleanup of external resources. */
  destroy?(this: EntityContext<string, TAttrs>): void | Promise<void>;
}

/**
 * Define a dropdown selection entity.
 *
 * @param options - Select configuration including id, name, options, onCommand handler, and optional init/destroy.
 * @returns A `SelectDefinition` registered with Home Assistant via MQTT discovery.
 *
 * @example
 * ```ts
 * select({
 *   id: 'wash_mode',
 *   name: 'Wash Mode',
 *   config: { options: ['gentle', 'normal', 'intensive'] },
 *   onCommand(option) {
 *     // Set the wash mode
 *     this.update(option);
 *   },
 *   init() {
 *     return 'normal';
 *   },
 * });
 * ```
 */
export function select<TAttrs extends Record<string, unknown> = Record<string, unknown>>(options: SelectOptions<TAttrs>): SelectDefinition {
  return {
    ...options,
    type: 'select',
  };
}
