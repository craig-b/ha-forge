import type { SignalGenerator, SimulationDefinition, ScenarioDefinition } from '../types.js';

/** Options for defining a signal simulation. */
export interface SimulateOptions {
  /** Unique simulation identifier. */
  id: string;
  /** The real HA entity_id this simulation stands in for. */
  shadows: string;
  /** Signal generator that produces synthetic events. */
  signal: SignalGenerator;
}

/** A single source within a scenario. */
export interface ScenarioSource {
  /** The real HA entity_id this source stands in for. */
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

/**
 * Define a named simulation scenario — a group of signal sources that run together.
 * Scenarios are source-only and never deployed. Use the web editor's scenario
 * picker to switch between them.
 *
 * @param name - Scenario name shown in the UI picker.
 * @param sources - Array of signal sources, each shadowing a real entity.
 * @returns A `ScenarioDefinition` (never deployed).
 *
 * @example
 * ```ts
 * const washerPower = signals.numeric({ base: 5, spikeTo: 300, spikeChance: 0.1, interval: 1000, seed: 42 });
 *
 * simulate.scenario('night', [
 *   { shadows: 'sensor.washer_power', signal: washerPower },
 *   { shadows: 'sensor.lux', signal: signals.numeric({ base: 10, noise: 5, interval: 5000, seed: 1 }) },
 * ]);
 *
 * simulate.scenario('day', [
 *   { shadows: 'sensor.washer_power', signal: washerPower },
 *   { shadows: 'sensor.lux', signal: signals.numeric({ base: 500, noise: 50, interval: 5000, seed: 1 }) },
 * ]);
 * ```
 */
simulate.scenario = function scenario(name: string, sources: ScenarioSource[]): ScenarioDefinition {
  return { __kind: 'scenario', name, sources };
};
