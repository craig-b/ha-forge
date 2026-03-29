import type { EntityContext, DeviceInfo } from './core.js';

/**
 * Context bound as `this` inside a task's `run()` callback.
 * Minimal context: HA API, logging, and raw MQTT. No event subscriptions or timers.
 */
export type TaskContext = Pick<EntityContext, 'ha' | 'log' | 'mqtt'>;

/**
 * A one-shot script surfaced as a button entity in HA.
 * Created by the `task()` factory function.
 */
export interface TaskDefinition {
  /** Discriminant for loader detection. */
  __kind: 'task';
  /** Unique task identifier. Becomes the button entity's object_id. */
  id: string;
  /** Human-readable name shown in the HA UI. */
  name: string;
  /** Also execute `run()` on deploy (default: button-only). */
  runOnDeploy?: boolean;
  /** Optional device to group the button entity under. */
  device?: DeviceInfo;
  /** MDI icon override (e.g. `'mdi:play'`). */
  icon?: string;
  /** Called when the button is pressed (or on deploy if `runOnDeploy` is true). */
  run(this: TaskContext): void | Promise<void>;
}
