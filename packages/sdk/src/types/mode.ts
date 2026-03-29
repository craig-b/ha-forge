import type { EntityContext, DeviceInfo } from './core.js';

/**
 * Context bound as `this` inside mode transition callbacks (`enter`/`exit`/`guard`).
 * Provides HA API access and logging. No event subscriptions or timers.
 */
export type ModeContext = Pick<EntityContext, 'ha' | 'log'>;

/**
 * Transition hooks for a single mode state.
 */
export interface ModeTransition<TStates extends string = string> {
  /** Called when entering this state. */
  enter?(this: ModeContext): void | Promise<void>;
  /** Called when leaving this state. */
  exit?(this: ModeContext): void | Promise<void>;
  /**
   * Guard function — return `false` to block the transition.
   * Receives the state being transitioned from.
   */
  guard?(this: ModeContext, from: TStates): boolean | Promise<boolean>;
}

/**
 * A mode / state machine surfaced as a `select` entity in HA.
 * Created by the `mode()` factory function.
 */
export interface ModeDefinition<TStates extends string = string> {
  /** Discriminant for loader detection. */
  __kind: 'mode';
  /** Unique mode identifier. Becomes the select entity's object_id (`select.<id>`). */
  id: string;
  /** Human-readable name shown in the HA UI. */
  name: string;
  /** All valid mode states. */
  states: TStates[];
  /** Initial state on deploy. Must be one of `states`. */
  initial: TStates;
  /** Optional device to group the select entity under. */
  device?: DeviceInfo;
  /** MDI icon override (e.g. `'mdi:home-variant'`). */
  icon?: string;
  /** Transition hooks keyed by state name. */
  transitions?: Partial<Record<TStates, ModeTransition<TStates>>>;
}
