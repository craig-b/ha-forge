import type { LawnMowerDefinition, LawnMowerCommand, LawnMowerActivity, EntityContext } from '../types.js';

/** Options for defining a lawn mower entity. */
export interface LawnMowerOptions {
  /** Unique entity identifier. Becomes the object_id in MQTT topics (e.g. `'garden_mower'` → `lawn_mower.garden_mower`). */
  id: string;
  /** Human-readable name shown in the HA UI. */
  name: string;
  /** Optional device to group this entity under. */
  device?: LawnMowerDefinition['device'];
  /** Entity category — `'config'` or `'diagnostic'` entities are hidden from the default UI. */
  category?: LawnMowerDefinition['category'];
  /** MDI icon override (e.g. `'mdi:robot-mower'`). */
  icon?: string;
  /**
   * Called when HA sends a command to this lawn mower.
   * @param command - `'start_mowing'`, `'pause'`, or `'dock'`.
   */
  onCommand(this: EntityContext<LawnMowerActivity>, command: LawnMowerCommand): void | Promise<void>;
  /**
   * Called once when the entity is deployed. Return the initial activity state.
   */
  init?(this: EntityContext<LawnMowerActivity>): LawnMowerActivity | Promise<LawnMowerActivity>;
  /** Called when the entity is torn down. Use for cleanup of external resources. */
  destroy?(this: EntityContext<LawnMowerActivity>): void | Promise<void>;
}

/**
 * Define a robotic lawn mower entity.
 *
 * @param options - Lawn mower configuration including id, name, onCommand handler, and optional init/destroy.
 * @returns A `LawnMowerDefinition` registered with Home Assistant via MQTT discovery.
 *
 * @example
 * ```ts
 * lawnMower({
 *   id: 'garden_mower',
 *   name: 'Garden Mower',
 *   onCommand(command) {
 *     switch (command) {
 *       case 'start_mowing': this.update('mowing'); break;
 *       case 'pause': this.update('paused'); break;
 *       case 'dock': this.update('docked'); break;
 *     }
 *   },
 *   init() {
 *     return 'docked';
 *   },
 * });
 * ```
 */
export function lawnMower(options: LawnMowerOptions): LawnMowerDefinition {
  return {
    ...options,
    type: 'lawn_mower',
  };
}
