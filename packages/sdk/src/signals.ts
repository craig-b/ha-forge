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

// ---- Shaped signal generators ----

export interface SineSignalOptions {
  /** Minimum value (trough). */
  min: number;
  /** Maximum value (peak). */
  max: number;
  /** Duration of one full cycle in milliseconds. */
  period: number;
  /** Where in the cycle to start (0–1). 0 = rising from midpoint, 0.25 = at peak, 0.5 = falling from midpoint, 0.75 = at trough. Default: 0 */
  phase?: number;
  /** Maximum noise amplitude added/subtracted from the wave. Default: 0 */
  noise?: number;
  /** Time between events in milliseconds. */
  interval: number;
  /** PRNG seed for deterministic noise. */
  seed: number;
}

function sineGenerator(opts: SineSignalOptions): SignalGenerator {
  return (range: TimeRange): SignalEvent[] => {
    const rng = xoshiro128ss(opts.seed);
    const events: SignalEvent[] = [];
    const amplitude = (opts.max - opts.min) / 2;
    const midpoint = opts.min + amplitude;
    const phase = opts.phase ?? 0;
    const noiseAmp = opts.noise ?? 0;

    for (let t = range.start; t <= range.end; t += opts.interval) {
      const angle = ((t - range.start) / opts.period + phase) * 2 * Math.PI;
      const base = midpoint + amplitude * Math.sin(angle);
      const noise = noiseAmp > 0 ? (rng() * 2 - 1) * noiseAmp : 0;
      events.push({ t, value: Math.round((base + noise) * 100) / 100 });
    }

    return events;
  };
}

export interface RampSignalOptions {
  /** Starting value. */
  from: number;
  /** Ending value. */
  to: number;
  /** Maximum noise amplitude added/subtracted from the ramp. Default: 0 */
  noise?: number;
  /** Time between events in milliseconds. */
  interval: number;
  /** PRNG seed for deterministic noise. */
  seed: number;
}

function rampGenerator(opts: RampSignalOptions): SignalGenerator {
  return (range: TimeRange): SignalEvent[] => {
    const rng = xoshiro128ss(opts.seed);
    const events: SignalEvent[] = [];
    const duration = range.end - range.start;
    const noiseAmp = opts.noise ?? 0;

    for (let t = range.start; t <= range.end; t += opts.interval) {
      const progress = duration > 0 ? (t - range.start) / duration : 1;
      const base = opts.from + (opts.to - opts.from) * progress;
      const noise = noiseAmp > 0 ? (rng() * 2 - 1) * noiseAmp : 0;
      events.push({ t, value: Math.round((base + noise) * 100) / 100 });
    }

    return events;
  };
}

export interface SequenceSegment {
  /** Duration of this segment in milliseconds. */
  duration: number;
  /** Signal generator for this segment. Receives a range from 0 to duration. */
  signal: SignalGenerator;
}

function sequenceGenerator(segments: SequenceSegment[]): SignalGenerator {
  return (range: TimeRange): SignalEvent[] => {
    const events: SignalEvent[] = [];
    let offset = range.start;

    for (const segment of segments) {
      if (offset >= range.end) break;
      const segEnd = Math.min(offset + segment.duration, range.end);
      const segRange: TimeRange = {
        start: 0,
        end: segEnd - offset,
        stepMs: range.stepMs,
      };
      const segEvents = segment.signal(segRange);
      for (const e of segEvents) {
        const absoluteT = e.t + offset;
        if (absoluteT >= range.start && absoluteT <= range.end) {
          events.push({ t: absoluteT, value: e.value });
        }
      }
      offset += segment.duration;
    }

    return events;
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
  /** Generate a sine wave between min and max with optional noise. Use a half-period for bell curves. */
  sine: sineGenerator,
  /** Generate a linear ramp from one value to another with optional noise. Stretches to fill the time range. */
  ramp: rampGenerator,
  /** Concatenate multiple signal segments in time. Each segment's generator receives a range starting at 0. */
  sequence: sequenceGenerator,
};
