import type { CoverConfig, CoverDefinition, CoverCommand, CoverState, EntityContext } from '../types.js';

/** Options for defining a cover entity. */
export interface CoverOptions {
  /** Unique entity identifier. Becomes the object_id in MQTT topics (e.g. `'garage'` → `cover.garage`). */
  id: string;
  /** Human-readable name shown in the HA UI. */
  name: string;
  /** Optional device to group this entity under. */
  device?: CoverDefinition['device'];
  /** Entity category — `'config'` or `'diagnostic'` entities are hidden from the default UI. */
  category?: CoverDefinition['category'];
  /** MDI icon override (e.g. `'mdi:garage-variant'`). */
  icon?: string;
  /** Cover-specific MQTT discovery config (device_class, position, tilt). */
  config?: CoverConfig;
  /**
   * Called when HA sends a command to this cover (open, close, stop, set position/tilt).
   * @param command - Discriminated union on `action` field.
   */
  onCommand(this: EntityContext<CoverState>, command: CoverCommand): void | Promise<void>;
  /**
   * Called once when the entity is deployed. Return the initial cover state.
   */
  init?(this: EntityContext<CoverState>): CoverState | Promise<CoverState>;
  /** Called when the entity is torn down. Use for cleanup of external resources. */
  destroy?(this: EntityContext<CoverState>): void | Promise<void>;
}

/**
 * Define a controllable cover entity (blind, garage door, curtain, etc.).
 *
 * @param options - Cover configuration including id, name, onCommand handler, and optional init/destroy.
 * @returns A `CoverDefinition` registered with Home Assistant via MQTT discovery.
 *
 * @example
 * ```ts
 * cover({
 *   id: 'garage_door',
 *   name: 'Garage Door',
 *   config: { device_class: 'garage' },
 *   onCommand(command) {
 *     switch (command.action) {
 *       case 'open':  this.update('opening'); break;
 *       case 'close': this.update('closing'); break;
 *       case 'stop':  this.update('stopped'); break;
 *     }
 *   },
 *   init() {
 *     return 'closed';
 *   },
 * });
 * ```
 */
export function cover(options: CoverOptions): CoverDefinition {
  return {
    ...options,
    type: 'cover',
  };
}
