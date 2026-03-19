import type { SwitchConfig, SwitchDefinition, EntityContext } from '../types.js';

/** Options for defining a switch entity. */
export interface SwitchOptions {
  /** Unique entity identifier. Becomes the object_id in MQTT topics (e.g. `'pump'` → `switch.pump`). */
  id: string;
  /** Human-readable name shown in the HA UI. */
  name: string;
  /** Optional device to group this entity under. */
  device?: SwitchDefinition['device'];
  /** Entity category — `'config'` or `'diagnostic'` entities are hidden from the default UI. */
  category?: SwitchDefinition['category'];
  /** MDI icon override (e.g. `'mdi:water-pump'`). */
  icon?: string;
  /** Switch-specific MQTT discovery config (device_class). */
  config?: SwitchConfig;
  /**
   * Called when HA sends a command to this switch (user toggles it in the UI).
   * @param command - `'ON'` or `'OFF'`.
   */
  onCommand(this: EntityContext<'on' | 'off'>, command: 'ON' | 'OFF'): void | Promise<void>;
  /**
   * Called once when the entity is deployed. Return `'on'` or `'off'` as the initial state.
   */
  init?(this: EntityContext<'on' | 'off'>): 'on' | 'off' | Promise<'on' | 'off'>;
  /** Called when the entity is torn down. Use for cleanup of external resources. */
  destroy?(this: EntityContext<'on' | 'off'>): void | Promise<void>;
}

/**
 * Define a controllable on/off switch entity.
 *
 * @param options - Switch configuration including id, name, onCommand handler, and optional init/destroy.
 * @returns A `SwitchDefinition` registered with Home Assistant via MQTT discovery.
 *
 * @example
 * ```ts
 * defineSwitch({
 *   id: 'pump',
 *   name: 'Irrigation Pump',
 *   config: { device_class: 'switch' },
 *   onCommand(command) {
 *     if (command === 'ON') {
 *       // Start pump
 *     } else {
 *       // Stop pump
 *     }
 *     this.update(command === 'ON' ? 'on' : 'off');
 *   },
 *   init() {
 *     return 'off';
 *   },
 * });
 * ```
 */
export function defineSwitch(options: SwitchOptions): SwitchDefinition {
  return {
    ...options,
    type: 'switch',
  };
}
