import type { LockConfig, LockDefinition, LockCommand, LockState, EntityContext, ComputedAttribute } from '../types.js';

/** Options for defining a lock entity. */
export interface LockOptions<TAttrs extends Record<string, unknown> = Record<string, unknown>> {
  /** Unique entity identifier. Becomes the object_id in MQTT topics (e.g. `'front_door'` → `lock.front_door`). */
  id: string;
  /** Human-readable name shown in the HA UI. */
  name: string;
  /** Optional device to group this entity under. */
  device?: LockDefinition['device'];
  /** Entity category — `'config'` or `'diagnostic'` entities are hidden from the default UI. */
  category?: LockDefinition['category'];
  /** MDI icon override (e.g. `'mdi:lock'`). */
  icon?: string;
  /** Lock-specific MQTT discovery config (code_format). */
  config?: LockConfig;
  /** Declarative attributes published alongside the entity state. Values can be static or reactive via `computed()`. */
  attributes?: { [K in keyof TAttrs]: TAttrs[K] | ComputedAttribute };
  /**
   * Called when HA sends a command to this lock.
   * @param command - `'LOCK'`, `'UNLOCK'`, or `'OPEN'`.
   */
  onCommand(this: EntityContext<LockState, TAttrs>, command: LockCommand): void | Promise<void>;
  /**
   * Called once when the entity is deployed. Return the initial lock state.
   */
  init?(this: EntityContext<LockState, TAttrs>): LockState | Promise<LockState>;
  /** Called when the entity is torn down. Use for cleanup of external resources. */
  destroy?(this: EntityContext<LockState, TAttrs>): void | Promise<void>;
}

/**
 * Define a controllable lock entity.
 *
 * @param options - Lock configuration including id, name, onCommand handler, and optional init/destroy.
 * @returns A `LockDefinition` registered with Home Assistant via MQTT discovery.
 *
 * @example
 * ```ts
 * lock({
 *   id: 'front_door',
 *   name: 'Front Door Lock',
 *   onCommand(command) {
 *     if (command === 'LOCK') this.update('locked');
 *     else if (command === 'UNLOCK') this.update('unlocked');
 *   },
 *   init() {
 *     return 'locked';
 *   },
 * });
 * ```
 */
export function lock<TAttrs extends Record<string, unknown> = Record<string, unknown>>(options: LockOptions<TAttrs>): LockDefinition {
  return {
    ...options,
    type: 'lock',
  };
}
