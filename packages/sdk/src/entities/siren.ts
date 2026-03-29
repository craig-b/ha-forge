import type { SirenConfig, SirenDefinition, SirenCommand, BinaryState, EntityContext, ComputedAttribute } from '../types.js';

/** Options for defining a siren entity. */
export interface SirenOptions<TAttrs extends Record<string, unknown> = Record<string, unknown>> {
  /** Unique entity identifier. Becomes the object_id in MQTT topics (e.g. `'alarm'` → `siren.alarm`). */
  id: string;
  /** Human-readable name shown in the HA UI. */
  name: string;
  /** Optional device to group this entity under. */
  device?: SirenDefinition['device'];
  /** Entity category — `'config'` or `'diagnostic'` entities are hidden from the default UI. */
  category?: SirenDefinition['category'];
  /** MDI icon override (e.g. `'mdi:alarm-light'`). */
  icon?: string;
  /** Siren-specific MQTT discovery config (available_tones, support flags). */
  config?: SirenConfig;
  /** Declarative attributes published alongside the entity state. Values can be static or reactive via `computed()`. */
  attributes?: { [K in keyof TAttrs]: TAttrs[K] | ComputedAttribute };
  /**
   * Called when HA sends a command to this siren.
   * @param command - The siren command with desired state, tone, duration, and volume.
   */
  onCommand(this: EntityContext<BinaryState, TAttrs>, command: SirenCommand): void | Promise<void>;
  /**
   * Called once when the entity is deployed. Return `'on'` or `'off'` as the initial state.
   */
  init?(this: EntityContext<BinaryState, TAttrs>): BinaryState | Promise<BinaryState>;
  /** Called when the entity is torn down. Use for cleanup of external resources. */
  destroy?(this: EntityContext<BinaryState, TAttrs>): void | Promise<void>;
}

/**
 * Define a siren/alarm entity.
 *
 * @param options - Siren configuration including id, name, onCommand handler, and optional init/destroy.
 * @returns A `SirenDefinition` registered with Home Assistant via MQTT discovery.
 *
 * @example
 * ```ts
 * siren({
 *   id: 'alarm',
 *   name: 'House Alarm',
 *   config: { available_tones: ['ding', 'alarm', 'chime'], support_volume_set: true },
 *   onCommand(command) {
 *     this.update(command.state === 'ON' ? 'on' : 'off');
 *   },
 * });
 * ```
 */
export function siren<TAttrs extends Record<string, unknown> = Record<string, unknown>>(options: SirenOptions<TAttrs>): SirenDefinition {
  return {
    ...options,
    type: 'siren',
  };
}
