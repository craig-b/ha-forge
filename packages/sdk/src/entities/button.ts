import type { ButtonConfig, ButtonDefinition, EntityContext, ComputedAttribute } from '../types.js';

/** Options for defining a button entity. */
export interface ButtonOptions<TAttrs extends Record<string, unknown> = Record<string, unknown>> {
  /** Unique entity identifier. Becomes the object_id in MQTT topics (e.g. `'reboot'` → `button.reboot`). */
  id: string;
  /** Human-readable name shown in the HA UI. */
  name: string;
  /** Optional device to group this entity under. */
  device?: ButtonDefinition['device'];
  /** Entity category — `'config'` or `'diagnostic'` entities are hidden from the default UI. */
  category?: ButtonDefinition['category'];
  /** MDI icon override (e.g. `'mdi:restart'`). */
  icon?: string;
  /** Button-specific MQTT discovery config (device_class). */
  config?: ButtonConfig;
  /** Declarative attributes published alongside the entity state. Values can be static or reactive via `computed()`. */
  attributes?: { [K in keyof TAttrs]: TAttrs[K] | ComputedAttribute };
  /**
   * Called when the button is pressed in HA.
   */
  onPress(this: EntityContext<never, TAttrs>): void | Promise<void>;
}

/**
 * Define a momentary button entity (command only, no state).
 *
 * @param options - Button configuration including id, name, and onPress handler.
 * @returns A `ButtonDefinition` registered with Home Assistant via MQTT discovery.
 *
 * @example
 * ```ts
 * button({
 *   id: 'reboot_server',
 *   name: 'Reboot Server',
 *   config: { device_class: 'restart' },
 *   onPress() {
 *     this.log.info('Rebooting server...');
 *     // Trigger reboot
 *   },
 * });
 * ```
 */
export function button<TAttrs extends Record<string, unknown> = Record<string, unknown>>(options: ButtonOptions<TAttrs>): ButtonDefinition {
  return {
    ...options,
    type: 'button',
  };
}
