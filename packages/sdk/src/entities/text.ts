import type { TextConfig, TextDefinition, EntityContext } from '../types.js';

/** Options for defining a text entity. */
export interface TextOptions {
  /** Unique entity identifier. Becomes the object_id in MQTT topics (e.g. `'display_msg'` → `text.display_msg`). */
  id: string;
  /** Human-readable name shown in the HA UI. */
  name: string;
  /** Optional device to group this entity under. */
  device?: TextDefinition['device'];
  /** Entity category — `'config'` or `'diagnostic'` entities are hidden from the default UI. */
  category?: TextDefinition['category'];
  /** MDI icon override (e.g. `'mdi:text'`). */
  icon?: string;
  /** Text-specific MQTT discovery config (min, max, pattern, mode). */
  config?: TextConfig;
  /**
   * Called when HA sends new text to this text entity.
   * @param command - The new text value.
   */
  onCommand(this: EntityContext<string>, command: string): void | Promise<void>;
  /**
   * Called once when the entity is deployed. Return the initial text value.
   */
  init?(this: EntityContext<string>): string | Promise<string>;
  /** Called when the entity is torn down. Use for cleanup of external resources. */
  destroy?(this: EntityContext<string>): void | Promise<void>;
}

/**
 * Define a text input entity.
 *
 * @param options - Text configuration including id, name, onCommand handler, and optional init/destroy.
 * @returns A `TextDefinition` registered with Home Assistant via MQTT discovery.
 *
 * @example
 * ```ts
 * text({
 *   id: 'display_message',
 *   name: 'Display Message',
 *   config: { max: 32 },
 *   onCommand(value) {
 *     // Send text to display
 *     this.update(value);
 *   },
 *   init() {
 *     return 'Hello';
 *   },
 * });
 * ```
 */
export function text(options: TextOptions): TextDefinition {
  return {
    ...options,
    type: 'text',
  };
}
