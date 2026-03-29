import type { BaseEntity, EntityContext } from './core.js';

/** MQTT discovery configuration for lock entities. */
export interface LockConfig {
  /** Regex pattern for code validation (e.g. `'^\\d{4,6}$'` for 4–6 digit PIN). */
  code_format?: string;
}

/** Commands that can be sent to a lock entity. */
export type LockCommand = 'LOCK' | 'UNLOCK' | 'OPEN';

/**
 * Possible states for a lock entity.
 *
 * - `'locked'` — Fully locked.
 * - `'locking'` — Currently locking (transitioning).
 * - `'unlocked'` — Fully unlocked.
 * - `'unlocking'` — Currently unlocking (transitioning).
 * - `'jammed'` — Lock is jammed and unable to operate.
 */
export type LockState = 'locked' | 'locking' | 'unlocked' | 'unlocking' | 'jammed';

/** Entity definition for a controllable lock. */
export interface LockDefinition extends BaseEntity<LockState, LockConfig> {
  type: 'lock';
  /**
   * Called when HA sends a command to this lock.
   * @param command - `'LOCK'`, `'UNLOCK'`, or `'OPEN'`.
   */
  onCommand(this: EntityContext<LockState>, command: LockCommand): void | Promise<void>;
}
