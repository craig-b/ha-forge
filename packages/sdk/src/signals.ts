import type { SignalEvent, SignalGenerator, TimeRange } from './types.js';

// ---- Seeded PRNG: xoshiro128** ----

function xoshiro128ss(seed: number): () => number {
  let s0 = seed >>> 0 || 1;
  let s1 = (seed * 1831565813) >>> 0 || 1;
  let s2 = (seed * 1103515245 + 12345) >>> 0 || 1;
  let s3 = (seed * 2654435761) >>> 0 || 1;

  return () => {
    const result = (((s1 * 5) << 7 | (s1 * 5) >>> 25) * 9) >>> 0;
    const t = (s1 << 9) >>> 0;

    s2 ^= s0;
    s3 ^= s1;
    s1 ^= s2;
    s0 ^= s3;
    s2 ^= t;
    s3 = (s3 << 11 | s3 >>> 21) >>> 0;

    return result / 4294967296; // [0, 1)
  };
}

// ---- Signal generators ----

export interface NumericSignalOptions {
  /** Base value for the signal. */
  base: number;
  /** Maximum noise amplitude added/subtracted from base. */
  noise: number;
  /** Optional spike target value. */
  spikeTo?: number;
  /** Probability of a spike per event (0-1). Default: 0 */
  spikeChance?: number;
  /** Interval (in events) at which a dropout (unavailable) occurs. 0 = none. */
  dropoutEvery?: number;
  /** Time between events in milliseconds. */
  interval: number;
  /** PRNG seed for deterministic output. */
  seed: number;
}

export interface BinarySignalOptions {
  /** Range [min, max] in ms for ON duration. */
  onDuration: [number, number];
  /** Range [min, max] in ms for OFF duration. */
  offDuration: [number, number];
  /** Probability (0-1) of a false retrigger within 500ms. Default: 0 */
  falseRetrigger?: number;
  /** PRNG seed for deterministic output. */
  seed: number;
}

export interface EnumSignalOptions {
  /** Possible state values to cycle through. */
  states: string[];
  /** Range [min, max] in ms for dwell time per state. */
  dwellRange: [number, number];
  /** PRNG seed for deterministic output. */
  seed: number;
}

function numericGenerator(opts: NumericSignalOptions): SignalGenerator {
  return (range: TimeRange): SignalEvent[] => {
    const rng = xoshiro128ss(opts.seed);
    const events: SignalEvent[] = [];
    const step = opts.interval || range.stepMs;
    let eventIndex = 0;

    for (let t = range.start; t <= range.end; t += step) {
      eventIndex++;

      // Dropout check
      if (opts.dropoutEvery && opts.dropoutEvery > 0 && eventIndex % opts.dropoutEvery === 0) {
        events.push({ t, value: 'unavailable' });
        continue;
      }

      // Spike check
      if (opts.spikeTo !== undefined && opts.spikeChance && rng() < opts.spikeChance) {
        events.push({ t, value: opts.spikeTo });
        continue;
      }

      // Normal value with noise
      const noise = (rng() * 2 - 1) * opts.noise;
      events.push({ t, value: Math.round((opts.base + noise) * 100) / 100 });
    }

    return events;
  };
}

function binaryGenerator(opts: BinarySignalOptions): SignalGenerator {
  return (range: TimeRange): SignalEvent[] => {
    const rng = xoshiro128ss(opts.seed);
    const events: SignalEvent[] = [];
    let t = range.start;
    let isOn = false;

    while (t <= range.end) {
      isOn = !isOn;
      events.push({ t, value: isOn ? 'on' : 'off' });

      const dur = isOn ? opts.onDuration : opts.offDuration;
      const dwell = dur[0] + rng() * (dur[1] - dur[0]);

      // False retrigger: bounce back within 500ms
      if (isOn && opts.falseRetrigger && rng() < opts.falseRetrigger) {
        const bounceDelay = 100 + rng() * 400;
        if (t + bounceDelay <= range.end) {
          events.push({ t: t + bounceDelay, value: 'off' });
          const retriggerDelay = bounceDelay + 50 + rng() * 200;
          if (t + retriggerDelay <= range.end) {
            events.push({ t: t + retriggerDelay, value: 'on' });
          }
        }
      }

      t += dwell;
    }

    return events;
  };
}

function enumGenerator(opts: EnumSignalOptions): SignalGenerator {
  return (range: TimeRange): SignalEvent[] => {
    const rng = xoshiro128ss(opts.seed);
    const events: SignalEvent[] = [];
    let t = range.start;
    let stateIndex = 0;

    while (t <= range.end) {
      events.push({ t, value: opts.states[stateIndex % opts.states.length] });
      const dwell = opts.dwellRange[0] + rng() * (opts.dwellRange[1] - opts.dwellRange[0]);
      t += dwell;
      stateIndex++;
    }

    return events;
  };
}

function recordedGenerator(events: SignalEvent[]): SignalGenerator {
  return (range: TimeRange): SignalEvent[] => {
    return events.filter(e => e.t >= range.start && e.t <= range.end);
  };
}

/** Library of pure signal generators for use with `simulate()`. */
export const signals = {
  /** Generate numeric signals with noise, optional spikes and dropouts. */
  numeric: numericGenerator,
  /** Generate binary ON/OFF signals with randomized durations. */
  binary: binaryGenerator,
  /** Generate enum state signals cycling through named states. */
  enum: enumGenerator,
  /** Replay a fixed array of recorded events. */
  recorded: recordedGenerator,
};
