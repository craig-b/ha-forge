import type { SignalGenerator, SimulationDefinition } from '../types.js';

/** Options for defining a signal simulation. */
export interface SimulateOptions {
  /** Unique simulation identifier. */
  id: string;
  /** The real HA entity_id this simulation stands in for. */
  shadows: string;
  /** Signal generator that produces synthetic events. */
  signal: SignalGenerator;
}

/**
 * Define a signal simulation that shadows a real entity ID.
 * Simulations are source-only — the runtime skips them during deploy.
 * Use with `signals.*` generators to test behavior chains in the web editor.
 *
 * @param options - Simulation configuration including id, shadows target, and signal generator.
 * @returns A `SimulationDefinition` (never deployed).
 *
 * @example
 * ```ts
 * export const tempSim = simulate({
 *   id: 'temp_sim',
 *   shadows: 'sensor.living_room_temp',
 *   signal: signals.numeric({ base: 22, noise: 1.5, interval: 10_000, seed: 42 }),
 * });
 * ```
 */
export function simulate(options: SimulateOptions): SimulationDefinition {
  return { ...options, __kind: 'simulate' };
}
