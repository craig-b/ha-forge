import type { ModeDefinition, ModeTransition, DeviceInfo } from '../types.js';

/** Options for defining a mode (state machine) entity. */
export interface ModeOptions<TStates extends string = string> {
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

/**
 * Define a mode / state machine surfaced as a `select` entity in HA.
 *
 * The runtime registers a select entity with the mode's states as dropdown
 * options, manages enter/exit transition hooks, and enforces optional guards.
 * Other scripts can observe mode changes via `ha.on('select.<id>', ...)`.
 *
 * @param options - Mode configuration including states, initial state, and transition hooks.
 * @returns A `ModeDefinition` detected and managed by the runtime.
 *
 * @example
 * ```ts
 * export const houseMode = mode({
 *   id: 'house_mode',
 *   name: 'House Mode',
 *   states: ['home', 'away', 'sleep', 'movie'],
 *   initial: 'home',
 *   transitions: {
 *     away: {
 *       enter: () => {
 *         ha.callService('climate.main', 'set_hvac_mode', { hvac_mode: 'eco' });
 *         ha.callService('light', 'turn_off');
 *       },
 *       exit: () => ha.callService('climate.main', 'set_hvac_mode', { hvac_mode: 'auto' }),
 *       guard(from) { return from !== 'sleep'; },
 *     },
 *     movie: {
 *       enter: () => ha.callService('light.living_room', 'turn_on', { brightness: 30 }),
 *     },
 *   },
 * });
 * ```
 */
export function mode<TStates extends string>(options: ModeOptions<TStates>): ModeDefinition<TStates> {
  return {
    __kind: 'mode',
    id: options.id,
    name: options.name,
    states: options.states,
    initial: options.initial,
    ...(options.device && { device: options.device }),
    ...(options.icon && { icon: options.icon }),
    ...(options.transitions && { transitions: options.transitions }),
  };
}
