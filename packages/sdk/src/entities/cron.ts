import type { CronDefinition, DeviceInfo } from '../types.js';

/** Options for defining a cron schedule entity. */
export interface CronOptions {
  /** Unique identifier. Becomes the binary_sensor's object_id (`binary_sensor.<id>`). */
  id: string;
  /** Human-readable name shown in the HA UI. */
  name: string;
  /** Cron expression (5-field: minute hour day-of-month month day-of-week). */
  schedule: string;
  /** Optional device to group the binary_sensor entity under. */
  device?: DeviceInfo;
  /** MDI icon override (e.g. `'mdi:clock-outline'`). */
  icon?: string;
}

/**
 * Define a schedule entity surfaced as a `binary_sensor` in HA.
 *
 * The runtime evaluates the cron expression every minute and publishes
 * `ON` when the current time matches the schedule, `OFF` otherwise.
 * Usable as a dependency in `computed()`, `this.events.stream()`, etc.
 *
 * @param options - Cron schedule configuration.
 * @returns A `CronDefinition` detected and managed by the runtime.
 *
 * @example
 * ```ts
 * export const schedule = cron({
 *   id: 'work_hours',
 *   name: 'Work Hours',
 *   schedule: '0 9-17 * * 1-5',  // weekdays 9-5
 *   // Exposed as binary_sensor — 'on' during work hours
 * });
 * ```
 */
export function cron(options: CronOptions): CronDefinition {
  return {
    __kind: 'cron',
    id: options.id,
    name: options.name,
    schedule: options.schedule,
    ...(options.device && { device: options.device }),
    ...(options.icon && { icon: options.icon }),
  };
}
