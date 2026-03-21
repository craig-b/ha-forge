import type { VacuumConfig, VacuumDefinition, VacuumCommand, VacuumState, EntityContext } from '../types.js';

/** Options for defining a vacuum entity. */
export interface VacuumOptions {
  /** Unique entity identifier. Becomes the object_id in MQTT topics (e.g. `'robo_vac'` → `vacuum.robo_vac`). */
  id: string;
  /** Human-readable name shown in the HA UI. */
  name: string;
  /** Optional device to group this entity under. */
  device?: VacuumDefinition['device'];
  /** Entity category — `'config'` or `'diagnostic'` entities are hidden from the default UI. */
  category?: VacuumDefinition['category'];
  /** MDI icon override (e.g. `'mdi:robot-vacuum'`). */
  icon?: string;
  /** Vacuum-specific MQTT discovery config (fan_speed_list). */
  config?: VacuumConfig;
  /**
   * Called when HA sends a command to this vacuum.
   * @param command - The vacuum command (start, pause, stop, return_to_base, etc.).
   */
  onCommand(this: EntityContext<VacuumState>, command: VacuumCommand): void | Promise<void>;
  /**
   * Called once when the entity is deployed. Return the initial vacuum state.
   */
  init?(this: EntityContext<VacuumState>): VacuumState | Promise<VacuumState>;
  /** Called when the entity is torn down. Use for cleanup of external resources. */
  destroy?(this: EntityContext<VacuumState>): void | Promise<void>;
}

/**
 * Define a robot vacuum entity.
 *
 * @param options - Vacuum configuration including id, name, onCommand handler, and optional init/destroy.
 * @returns A `VacuumDefinition` registered with Home Assistant via MQTT discovery.
 *
 * @example
 * ```ts
 * vacuum({
 *   id: 'robo_vac',
 *   name: 'Robot Vacuum',
 *   config: { fan_speed_list: ['quiet', 'standard', 'turbo'] },
 *   onCommand(command) {
 *     switch (command.action) {
 *       case 'start': this.update('cleaning'); break;
 *       case 'pause': this.update('paused'); break;
 *       case 'return_to_base': this.update('returning'); break;
 *     }
 *   },
 *   init() {
 *     return 'docked';
 *   },
 * });
 * ```
 */
export function vacuum(options: VacuumOptions): VacuumDefinition {
  return {
    ...options,
    type: 'vacuum',
  };
}
