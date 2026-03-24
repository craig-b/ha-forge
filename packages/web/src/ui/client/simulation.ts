/**
 * Client-side signal generators for simulation.
 * Self-contained — no dependencies on @ha-forge/sdk at runtime.
 */

// ---- Types ----

export interface SignalEvent {
  t: number;
  value: string | number;
}

export interface TimeRange {
  start: number;
  end: number;
  stepMs: number;
}

// ---- Seeded PRNG: xoshiro128** ----

function xoshiro128ss(seed: number): () => number {
  let s0 = seed >>> 0 || 1;
  let s1 = (seed * 1831565813) >>> 0 || 1;
  let s2 = (seed * 1103515245 + 12345) >>> 0 || 1;
  let s3 = (seed * 2654435761) >>> 0 || 1;

  return () => {
    const result = (((s1 * 5) << 7 | (s1 * 5) >>> 25) * 9) >>> 0;
    const t = (s1 << 9) >>> 0;
    s2 ^= s0; s3 ^= s1; s1 ^= s2; s0 ^= s3; s2 ^= t;
    s3 = (s3 << 11 | s3 >>> 21) >>> 0;
    return result / 4294967296;
  };
}

// ---- Signal generators ----

type SignalGenerator = (range: TimeRange) => SignalEvent[];

export const signals = {
  numeric(opts: {
    base: number; noise: number; interval: number; seed: number;
    spikeTo?: number; spikeChance?: number; dropoutEvery?: number;
  }): SignalGenerator {
    return (range: TimeRange) => {
      const rng = xoshiro128ss(opts.seed);
      const events: SignalEvent[] = [];
      let eventIndex = 0;
      for (let t = range.start; t <= range.end; t += opts.interval) {
        eventIndex++;
        if (opts.dropoutEvery && opts.dropoutEvery > 0 && eventIndex % opts.dropoutEvery === 0) {
          events.push({ t, value: 'unavailable' });
          continue;
        }
        if (opts.spikeTo !== undefined && opts.spikeChance && rng() < opts.spikeChance) {
          events.push({ t, value: opts.spikeTo });
          continue;
        }
        const noise = (rng() * 2 - 1) * opts.noise;
        events.push({ t, value: Math.round((opts.base + noise) * 100) / 100 });
      }
      return events;
    };
  },

  binary(opts: {
    onDuration: [number, number]; offDuration: [number, number]; seed: number;
    falseRetrigger?: number;
  }): SignalGenerator {
    return (range: TimeRange) => {
      const rng = xoshiro128ss(opts.seed);
      const events: SignalEvent[] = [];
      let t = range.start;
      let isOn = false;
      while (t <= range.end) {
        isOn = !isOn;
        events.push({ t, value: isOn ? 'on' : 'off' });
        const dur = isOn ? opts.onDuration : opts.offDuration;
        const dwell = dur[0] + rng() * (dur[1] - dur[0]);
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
  },

  enum(opts: { states: string[]; dwellRange: [number, number]; seed: number }): SignalGenerator {
    return (range: TimeRange) => {
      const rng = xoshiro128ss(opts.seed);
      const events: SignalEvent[] = [];
      let t = range.start;
      let idx = 0;
      while (t <= range.end) {
        events.push({ t, value: opts.states[idx % opts.states.length] });
        t += opts.dwellRange[0] + rng() * (opts.dwellRange[1] - opts.dwellRange[0]);
        idx++;
      }
      return events;
    };
  },
};
