import type { TaskContext, TaskDefinition } from '../types.js';

/** Options for defining a task. */
export interface TaskOptions {
  /** Unique task identifier. Becomes the button entity's object_id. */
  id: string;
  /** Human-readable name shown in the HA UI. */
  name: string;
  /** Also execute `run()` on deploy (default: button-only). */
  runOnDeploy?: boolean;
  /** Optional device to group the button entity under. */
  device?: TaskDefinition['device'];
  /** MDI icon override (e.g. `'mdi:play'`). */
  icon?: string;
  /** Called when the button is pressed (or on deploy if `runOnDeploy` is true). */
  run(this: TaskContext): void | Promise<void>;
}

/**
 * Define a one-shot task surfaced as a button entity in HA.
 *
 * Press the button in HA to trigger `run()`. Use `runOnDeploy: true` to also
 * execute on deploy. Tasks get a minimal context: `this.ha`, `this.log`, and `this.mqtt`.
 *
 * @param options - Task configuration including id, name, and run callback.
 * @returns A `TaskDefinition` to export from your script.
 *
 * @example
 * ```ts
 * export const notifyAll = task({
 *   id: 'notify_all',
 *   name: 'Notify All Devices',
 *   icon: 'mdi:bullhorn',
 *   run() {
 *     this.ha.callService('notify.all_devices', 'send_message', {
 *       message: 'Hello from HA Forge!',
 *     });
 *   },
 * });
 * ```
 */
export function task(options: TaskOptions): TaskDefinition {
  return {
    ...options,
    __kind: 'task',
  };
}
