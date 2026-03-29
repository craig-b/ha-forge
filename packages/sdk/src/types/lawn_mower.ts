import type { BaseEntity, EntityContext } from './core.js';

/** Commands that can be sent to a lawn mower entity. */
export type LawnMowerCommand = 'start_mowing' | 'pause' | 'dock';

/**
 * Possible activity states for a lawn mower entity.
 */
export type LawnMowerActivity = 'mowing' | 'paused' | 'docked' | 'error';

/** Entity definition for a robotic lawn mower entity. */
export interface LawnMowerDefinition extends BaseEntity<LawnMowerActivity> {
  type: 'lawn_mower';
  /**
   * Called when HA sends a command to this lawn mower.
   * @param command - `'start_mowing'`, `'pause'`, or `'dock'`.
   */
  onCommand(this: EntityContext<LawnMowerActivity>, command: LawnMowerCommand): void | Promise<void>;
}
