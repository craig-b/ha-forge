import type { AlarmControlPanelConfig, AlarmControlPanelDefinition, AlarmControlPanelCommand, AlarmControlPanelState, EntityContext, ComputedAttribute } from '../types.js';

/** Options for defining an alarm control panel entity. */
export interface AlarmControlPanelOptions<TAttrs extends Record<string, unknown> = Record<string, unknown>> {
  /** Unique entity identifier. Becomes the object_id in MQTT topics (e.g. `'home_alarm'` → `alarm_control_panel.home_alarm`). */
  id: string;
  /** Human-readable name shown in the HA UI. */
  name: string;
  /** Optional device to group this entity under. */
  device?: AlarmControlPanelDefinition['device'];
  /** Entity category — `'config'` or `'diagnostic'` entities are hidden from the default UI. */
  category?: AlarmControlPanelDefinition['category'];
  /** MDI icon override (e.g. `'mdi:shield-home'`). */
  icon?: string;
  /** Alarm panel-specific MQTT discovery config (code requirements). */
  config?: AlarmControlPanelConfig;
  /** Declarative attributes published alongside the entity state. Values can be static or reactive via `computed()`. */
  attributes?: { [K in keyof TAttrs]: TAttrs[K] | ComputedAttribute };
  /**
   * Called when HA sends a command to this alarm panel.
   * @param command - The alarm command (e.g. `'ARM_HOME'`, `'DISARM'`).
   */
  onCommand(this: EntityContext<AlarmControlPanelState, TAttrs>, command: AlarmControlPanelCommand): void | Promise<void>;
  /**
   * Called once when the entity is deployed. Return the initial alarm state.
   */
  init?(this: EntityContext<AlarmControlPanelState, TAttrs>): AlarmControlPanelState | Promise<AlarmControlPanelState>;
  /** Called when the entity is torn down. Use for cleanup of external resources. */
  destroy?(this: EntityContext<AlarmControlPanelState, TAttrs>): void | Promise<void>;
}

/**
 * Define a security alarm control panel entity.
 *
 * @param options - Alarm panel configuration including id, name, onCommand handler, and optional init/destroy.
 * @returns An `AlarmControlPanelDefinition` registered with Home Assistant via MQTT discovery.
 *
 * @example
 * ```ts
 * alarmControlPanel({
 *   id: 'home_alarm',
 *   name: 'Home Alarm',
 *   config: { code_arm_required: false, code_disarm_required: true },
 *   onCommand(command) {
 *     switch (command) {
 *       case 'ARM_HOME': this.update('armed_home'); break;
 *       case 'ARM_AWAY': this.update('armed_away'); break;
 *       case 'DISARM': this.update('disarmed'); break;
 *     }
 *   },
 *   init() {
 *     return 'disarmed';
 *   },
 * });
 * ```
 */
export function alarmControlPanel<TAttrs extends Record<string, unknown> = Record<string, unknown>>(options: AlarmControlPanelOptions<TAttrs>): AlarmControlPanelDefinition {
  return {
    ...options,
    type: 'alarm_control_panel',
  };
}
