import type { EntityContext, DeviceInfo } from './core.js';

/**
 * Context bound as `this` inside an automation's `init()` and `destroy()` callbacks.
 * Like `EntityContext` but without state publishing (`update`, `attr`, `poll`).
 */
export type AutomationContext = Omit<EntityContext, 'update' | 'attr' | 'poll'>;

/**
 * A pure reactive script with managed lifecycle. No HA entity created by default.
 * Created by the `automation()` factory function.
 */
export interface AutomationDefinition {
  /** Discriminant for loader detection. */
  __kind: 'automation';
  /** Unique automation identifier. */
  id: string;
  /** Optional: surface as a `binary_sensor` in HA (ON = running, OFF = errored). */
  entity?: boolean;
  /** Optional device to group the binary_sensor entity under. */
  device?: DeviceInfo;
  /** Called once when the automation is deployed. Set up subscriptions and reactive logic. */
  init(this: AutomationContext): void | Promise<void>;
  /** Called when the automation is torn down. Use for cleanup beyond auto-tracked handles. */
  destroy?(this: AutomationContext): void | Promise<void>;
}
