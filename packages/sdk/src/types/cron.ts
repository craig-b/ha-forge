import type { DeviceInfo } from './core.js';

/**
 * A schedule entity surfaced as a `binary_sensor` in HA.
 * Created by the `cron()` factory function.
 *
 * The runtime evaluates the cron expression every minute and publishes
 * `ON` when the current time matches the schedule, `OFF` otherwise.
 */
export interface CronDefinition {
  /** Discriminant for loader detection. */
  __kind: 'cron';
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
