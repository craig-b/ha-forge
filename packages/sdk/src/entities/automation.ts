import type { AutomationContext, AutomationDefinition } from '../types.js';

/** Options for defining an automation. */
export interface AutomationOptions {
  /** Unique automation identifier. */
  id: string;
  /** Optional: surface as a `binary_sensor` in HA (ON = running, OFF = errored). */
  entity?: boolean;
  /** Called once when the automation is deployed. Set up subscriptions and reactive logic. */
  init(this: AutomationContext): void | Promise<void>;
  /** Called when the automation is torn down. Use for cleanup beyond auto-tracked handles. */
  destroy?(this: AutomationContext): void | Promise<void>;
}

/**
 * Define a pure reactive automation with managed lifecycle.
 *
 * Automations subscribe to events and call services but don't publish their own state.
 * Use `this.ha` for service calls and `this.events` for state change subscriptions.
 * Set `entity: true` to surface as a binary_sensor in HA (ON = running, OFF = errored).
 *
 * @param options - Automation configuration including id and init/destroy callbacks.
 * @returns An `AutomationDefinition` to export from your script.
 *
 * @example
 * ```ts
 * export const motionLights = automation({
 *   id: 'motion_lights',
 *   init() {
 *     this.events.on('binary_sensor.hallway_motion', async (event) => {
 *       if (event.new_state === 'on') {
 *         await this.ha.callService('light.hallway', 'turn_on');
 *       }
 *     });
 *   },
 * });
 * ```
 */
export function automation(options: AutomationOptions): AutomationDefinition {
  return {
    ...options,
    __kind: 'automation',
  };
}
