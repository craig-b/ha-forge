import type { BaseEntity, EntityContext } from './core.js';

/**
 * Device class for cover entities. Determines the default icon
 * and open/close semantics in the HA UI.
 */
export type CoverDeviceClass =
  | 'awning'
  | 'blind'
  | 'curtain'
  | 'damper'
  | 'door'
  | 'garage'
  | 'gate'
  | 'shade'
  | 'shutter'
  | 'window';

/** MQTT discovery configuration for cover entities. */
export interface CoverConfig {
  /** Cover device class — determines icon and open/close labels in HA. */
  device_class?: CoverDeviceClass;
  /** Whether this cover supports position control (0–100). */
  position?: boolean;
  /** Whether this cover supports tilt control (0–100). */
  tilt?: boolean;
}

/**
 * Command received from HA when a user interacts with a cover entity.
 * Discriminated union on the `action` field.
 */
export type CoverCommand =
  | { action: 'open' }
  | { action: 'close' }
  | { action: 'stop' }
  | { action: 'set_position'; position: number }
  | { action: 'set_tilt'; tilt: number };

/**
 * Possible states for a cover entity.
 *
 * - `'open'` — Fully open.
 * - `'opening'` — Currently opening (transitioning).
 * - `'closed'` — Fully closed.
 * - `'closing'` — Currently closing (transitioning).
 * - `'stopped'` — Stopped mid-travel (neither fully open nor closed).
 */
export type CoverState = 'open' | 'opening' | 'closed' | 'closing' | 'stopped';

/** Entity definition for a controllable cover (blind, garage door, etc.). */
export interface CoverDefinition extends BaseEntity<CoverState, CoverConfig> {
  type: 'cover';
  /**
   * Called when HA sends a command to this cover.
   * @param command - The cover command (open, close, stop, set_position, set_tilt).
   */
  onCommand(this: EntityContext<CoverState>, command: CoverCommand): void | Promise<void>;
}
