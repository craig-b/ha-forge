import type { FanConfig, FanDefinition, FanCommand, FanState, EntityContext, ComputedAttribute } from '../types.js';

/** Options for defining a fan entity. */
export interface FanOptions<TAttrs extends Record<string, unknown> = Record<string, unknown>> {
  /** Unique entity identifier. Becomes the object_id in MQTT topics (e.g. `'ceiling'` → `fan.ceiling`). */
  id: string;
  /** Human-readable name shown in the HA UI. */
  name: string;
  /** Optional device to group this entity under. */
  device?: FanDefinition['device'];
  /** Entity category — `'config'` or `'diagnostic'` entities are hidden from the default UI. */
  category?: FanDefinition['category'];
  /** MDI icon override (e.g. `'mdi:fan'`). */
  icon?: string;
  /** Fan-specific MQTT discovery config (preset_modes, speed range). */
  config?: FanConfig;
  /** Declarative attributes published alongside the entity state. Values can be static or reactive via `computed()`. */
  attributes?: { [K in keyof TAttrs]: TAttrs[K] | ComputedAttribute };
  /**
   * Called when HA sends a command to this fan (turn on/off, change speed, etc.).
   * @param command - The fan command with desired state and parameters.
   */
  onCommand(this: EntityContext<FanState, TAttrs>, command: FanCommand): void | Promise<void>;
  /**
   * Called once when the entity is deployed. Return the initial fan state.
   */
  init?(this: EntityContext<FanState, TAttrs>): FanState | Promise<FanState>;
  /** Called when the entity is torn down. Use for cleanup of external resources. */
  destroy?(this: EntityContext<FanState, TAttrs>): void | Promise<void>;
}

/**
 * Define a controllable fan entity with optional speed, oscillation, and direction support.
 *
 * @param options - Fan configuration including id, name, onCommand handler, and optional init/destroy.
 * @returns A `FanDefinition` registered with Home Assistant via MQTT discovery.
 *
 * @example
 * ```ts
 * fan({
 *   id: 'ceiling_fan',
 *   name: 'Ceiling Fan',
 *   config: { preset_modes: ['auto', 'sleep'] },
 *   onCommand(command) {
 *     this.update({
 *       state: command.state === 'ON' ? 'on' : 'off',
 *       percentage: command.percentage,
 *     });
 *   },
 *   init() {
 *     return { state: 'off' };
 *   },
 * });
 * ```
 */
export function fan<TAttrs extends Record<string, unknown> = Record<string, unknown>>(options: FanOptions<TAttrs>): FanDefinition {
  return {
    ...options,
    type: 'fan',
  };
}
