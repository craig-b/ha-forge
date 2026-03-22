import type { SwitchConfig, SwitchDefinition, EntityContext, ComputedAttribute } from '../types.js';

/** Options for defining a switch entity. */
export interface SwitchOptions<TAttrs extends Record<string, unknown> = Record<string, unknown>> {
  /** Unique entity identifier. Becomes the object_id in MQTT topics (e.g. `'pump'` → `switch.pump`). */
  id: string;
  /** Human-readable name shown in the HA UI. */
  name: string;
  /** Optional device to group this entity under. */
  device?: SwitchDefinition['device'];
  /** Entity category — `'config'` or `'diagnostic'` entities are hidden from the default UI. */
  category?: SwitchDefinition['category'];
  /** MDI icon override (e.g. `'mdi:water-pump'`). */
  icon?: string;
  /** Switch-specific MQTT discovery config (device_class). */
  config?: SwitchConfig;
  /** Declarative attributes published alongside the entity state. Values can be static or reactive via `computed()`. */
  attributes?: { [K in keyof TAttrs]: TAttrs[K] | ComputedAttribute };
  /**
   * When `true` (default), the runtime auto-publishes the command as state after `onCommand` returns
   * (unless it returns `false` to reject). Set to `false` to require manual `this.update()` calls.
   */
  optimistic?: boolean;
  /**
   * Called when HA sends a command to this switch (user toggles it in the UI).
   * Optional when `optimistic` is `true` (default) — the switch simply echoes commands as state.
   * @param command - `'ON'` or `'OFF'`.
   * @returns `false` to reject the command (no state change). Any other return (including `void`) confirms the command.
   */
  onCommand?(this: EntityContext<'on' | 'off', TAttrs>, command: 'ON' | 'OFF'): void | boolean | Promise<void | boolean>;
  /**
   * Called once when the entity is deployed. Return `'on'` or `'off'` as the initial state.
   */
  init?(this: EntityContext<'on' | 'off', TAttrs>): 'on' | 'off' | Promise<'on' | 'off'>;
  /** Called when the entity is torn down. Use for cleanup of external resources. */
  destroy?(this: EntityContext<'on' | 'off', TAttrs>): void | Promise<void>;
}

/**
 * Define a controllable on/off switch entity.
 *
 * @param options - Switch configuration including id, name, onCommand handler, and optional init/destroy.
 * @returns A `SwitchDefinition` registered with Home Assistant via MQTT discovery.
 *
 * @example
 * ```ts
 * // Minimal — optimistic by default, no handler needed
 * defineSwitch({
 *   id: 'pump',
 *   name: 'Irrigation Pump',
 *   init() { return 'off'; },
 * });
 *
 * // With side effects — auto-confirms after handler runs
 * defineSwitch({
 *   id: 'pump',
 *   name: 'Irrigation Pump',
 *   onCommand(command) {
 *     gpio.write(PUMP_PIN, command === 'ON' ? 1 : 0);
 *   },
 * });
 *
 * // Conditional — reject if not ready
 * defineSwitch({
 *   id: 'pump',
 *   name: 'Irrigation Pump',
 *   onCommand(command) {
 *     if (!systemReady) return false; // rejected, no state change
 *     gpio.write(PUMP_PIN, command === 'ON' ? 1 : 0);
 *   },
 * });
 * ```
 */
export function defineSwitch<TAttrs extends Record<string, unknown> = Record<string, unknown>>(options: SwitchOptions<TAttrs>): SwitchDefinition {
  return {
    ...options,
    type: 'switch',
  };
}
