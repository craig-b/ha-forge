import type { SignalGenerator, ScenarioDefinition } from '../types.js';

/** A single source within a scenario. */
export interface ScenarioSource {
  /** The real HA entity_id this source stands in for. */
  shadows: string;
  /** Signal generator that produces synthetic events. */
  signal: SignalGenerator;
}

/**
 * Define simulation scenarios — groups of signal sources that run together.
 * Scenarios are source-only and never deployed. Use the web editor's scenario
 * picker to switch between them.
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
export const simulate = {
  scenario(name: string, sources: ScenarioSource[]): ScenarioDefinition {
    return { __kind: 'scenario', name, sources };
  },
};
