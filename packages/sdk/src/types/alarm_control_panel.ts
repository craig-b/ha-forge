import type { BaseEntity, EntityContext } from './core.js';

/** MQTT discovery configuration for alarm control panel entities. */
export interface AlarmControlPanelConfig {
  /** Whether a code is required to arm. */
  code_arm_required?: boolean;
  /** Whether a code is required to disarm. */
  code_disarm_required?: boolean;
  /** Whether a code is required to trigger. */
  code_trigger_required?: boolean;
}

/** Commands that can be sent to an alarm control panel entity. */
export type AlarmControlPanelCommand =
  | 'ARM_HOME'
  | 'ARM_AWAY'
  | 'ARM_NIGHT'
  | 'ARM_VACATION'
  | 'ARM_CUSTOM_BYPASS'
  | 'DISARM'
  | 'TRIGGER';

/**
 * Possible states for an alarm control panel entity.
 */
export type AlarmControlPanelState =
  | 'disarmed'
  | 'armed_home'
  | 'armed_away'
  | 'armed_night'
  | 'armed_vacation'
  | 'armed_custom_bypass'
  | 'pending'
  | 'triggered'
  | 'arming'
  | 'disarming';

/** Entity definition for a security alarm control panel entity. */
export interface AlarmControlPanelDefinition extends BaseEntity<AlarmControlPanelState, AlarmControlPanelConfig> {
  type: 'alarm_control_panel';
  /**
   * Called when HA sends a command to this alarm panel.
   * @param command - The alarm command (e.g. `'ARM_HOME'`, `'DISARM'`).
   */
  onCommand(this: EntityContext<AlarmControlPanelState>, command: AlarmControlPanelCommand): void | Promise<void>;
}
