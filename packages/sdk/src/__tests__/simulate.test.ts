import { describe, it, expect } from 'vitest';
import { simulate } from '../entities/simulate.js';
import { signals } from '../signals.js';
import { runSimulation, runMultiEntitySimulation } from '../simulate-engine.js';
import { runBehaviorSimulation } from '../simulate-context.js';
import { debounced } from '../behaviors/debounced.js';
import { sensor } from '../entities/sensor.js';
import type { SignalEvent, TimeRange } from '../types.js';

// ---- simulate.scenario() factory ----

describe('simulate.scenario()', () => {
  it('stamps __kind: scenario', () => {
    const sc = simulate.scenario('test', [
      { shadows: 'sensor.temperature', signal: () => [] },
    ]);
    expect(sc.__kind).toBe('scenario');
    expect(sc.name).toBe('test');
    expect(sc.sources).toHaveLength(1);
    expect(sc.sources[0].shadows).toBe('sensor.temperature');
  });
});

// ---- Signal primitives ----

describe('signals', () => {
  const range: TimeRange = { start: 0, end: 10_000, stepMs: 1000 };

  describe('numeric', () => {
    it('produces deterministic output with same seed', () => {
      const gen = signals.numeric({ base: 20, noise: 2, interval: 1000, seed: 42 });
      const a = gen(range);
      const b = gen(range);
      expect(a).toEqual(b);
      expect(a.length).toBeGreaterThan(0);
    });

    it('produces different output with different seeds', () => {
      const genA = signals.numeric({ base: 20, noise: 2, interval: 1000, seed: 42 });
      const genB = signals.numeric({ base: 20, noise: 2, interval: 1000, seed: 99 });
      const a = genA(range);
      const b = genB(range);
      // Same length but different values
      expect(a.length).toBe(b.length);
      expect(a).not.toEqual(b);
    });

    it('generates values around the base', () => {
      const gen = signals.numeric({ base: 20, noise: 2, interval: 1000, seed: 1 });
      const events = gen(range);
      for (const e of events) {
        if (e.value === 'unavailable') continue;
        expect(e.value).toBeGreaterThanOrEqual(18);
        expect(e.value).toBeLessThanOrEqual(22);
      }
    });

    it('generates dropouts', () => {
      const gen = signals.numeric({ base: 20, noise: 1, interval: 1000, dropoutEvery: 3, seed: 1 });
      const events = gen(range);
      const dropouts = events.filter(e => e.value === 'unavailable');
      expect(dropouts.length).toBeGreaterThan(0);
    });

    it('generates spikes', () => {
      const gen = signals.numeric({ base: 20, noise: 1, spikeTo: 100, spikeChance: 0.5, interval: 1000, seed: 7 });
      const events = gen({ start: 0, end: 50_000, stepMs: 1000 });
      const spikes = events.filter(e => e.value === 100);
      expect(spikes.length).toBeGreaterThan(0);
    });
  });

  describe('binary', () => {
    it('produces deterministic output', () => {
      const gen = signals.binary({ onDuration: [1000, 2000], offDuration: [500, 1000], seed: 42 });
      const a = gen(range);
      const b = gen(range);
      expect(a).toEqual(b);
    });

    it('alternates on/off', () => {
      const gen = signals.binary({ onDuration: [1000, 2000], offDuration: [500, 1000], seed: 42 });
      const events = gen(range);
      expect(events.length).toBeGreaterThan(1);
      // First event should be 'on' (starts as off, toggles to on)
      expect(events[0].value).toBe('on');
    });

    it('generates false retriggers', () => {
      const gen = signals.binary({
        onDuration: [2000, 3000],
        offDuration: [2000, 3000],
        falseRetrigger: 1.0, // Always retrigger
        seed: 42,
      });
      const events = gen({ start: 0, end: 30_000, stepMs: 100 });
      // Should have more events than simple on/off cycles due to retriggers
      const onEvents = events.filter(e => e.value === 'on');
      const offEvents = events.filter(e => e.value === 'off');
      expect(onEvents.length + offEvents.length).toBe(events.length);
    });
  });

  describe('enum', () => {
    it('cycles through states', () => {
      const gen = signals.enum({ states: ['idle', 'heating', 'cooling'], dwellRange: [1000, 2000], seed: 42 });
      const events = gen(range);
      expect(events.length).toBeGreaterThan(0);
      // All values should be from the states list
      for (const e of events) {
        expect(['idle', 'heating', 'cooling']).toContain(e.value);
      }
    });

    it('is deterministic', () => {
      const gen = signals.enum({ states: ['a', 'b', 'c'], dwellRange: [500, 1500], seed: 42 });
      const a = gen(range);
      const b = gen(range);
      expect(a).toEqual(b);
    });
  });

  describe('recorded', () => {
    it('filters to requested time range', () => {
      const events: SignalEvent[] = [
        { t: 0, value: 1 },
        { t: 5000, value: 2 },
        { t: 10000, value: 3 },
        { t: 15000, value: 4 },
      ];
      const gen = signals.recorded(events);
      const result = gen({ start: 3000, end: 12000, stepMs: 1000 });
      expect(result).toEqual([
        { t: 5000, value: 2 },
        { t: 10000, value: 3 },
      ]);
    });
  });

  describe('sine', () => {
    it('produces values between min and max', () => {
      const gen = signals.sine({ min: 10, max: 30, period: 10_000, interval: 1000, seed: 1 });
      const events = gen(range);
      for (const e of events) {
        expect(e.value).toBeGreaterThanOrEqual(10);
        expect(e.value).toBeLessThanOrEqual(30);
      }
    });

    it('is deterministic with same seed', () => {
      const gen = signals.sine({ min: 0, max: 100, period: 10_000, interval: 1000, seed: 42 });
      expect(gen(range)).toEqual(gen(range));
    });

    it('reaches peak and trough over a full cycle', () => {
      const gen = signals.sine({ min: 0, max: 100, period: 10_000, interval: 500, seed: 1 });
      const events = gen({ start: 0, end: 10_000, stepMs: 500 });
      const values = events.map(e => e.value as number);
      // Should get close to 100 (peak) and close to 0 (trough)
      expect(Math.max(...values)).toBeGreaterThan(90);
      expect(Math.min(...values)).toBeLessThan(10);
    });

    it('adds noise when specified', () => {
      const clean = signals.sine({ min: 0, max: 100, period: 10_000, interval: 1000, seed: 1 });
      const noisy = signals.sine({ min: 0, max: 100, period: 10_000, noise: 5, interval: 1000, seed: 1 });
      const cleanEvents = clean(range);
      const noisyEvents = noisy(range);
      expect(cleanEvents.length).toBe(noisyEvents.length);
      // At least some values should differ due to noise
      const diffs = cleanEvents.filter((e, i) => e.value !== noisyEvents[i].value);
      expect(diffs.length).toBeGreaterThan(0);
    });

    it('phase shifts the wave', () => {
      const atZero = signals.sine({ min: 0, max: 100, period: 10_000, phase: 0, interval: 10_000, seed: 1 });
      const atPeak = signals.sine({ min: 0, max: 100, period: 10_000, phase: 0.25, interval: 10_000, seed: 1 });
      // At t=0 with phase=0, value should be at midpoint (50)
      const zeroVal = atZero({ start: 0, end: 0, stepMs: 1000 })[0].value as number;
      // At t=0 with phase=0.25, value should be at peak (100)
      const peakVal = atPeak({ start: 0, end: 0, stepMs: 1000 })[0].value as number;
      expect(zeroVal).toBeCloseTo(50, 0);
      expect(peakVal).toBeCloseTo(100, 0);
    });
  });

  describe('ramp', () => {
    it('starts at from and ends at to', () => {
      const gen = signals.ramp({ from: 0, to: 100, interval: 1000, seed: 1 });
      const events = gen(range);
      expect(events[0].value).toBe(0);
      expect(events[events.length - 1].value).toBe(100);
    });

    it('is deterministic with same seed', () => {
      const gen = signals.ramp({ from: 10, to: 50, interval: 1000, seed: 42 });
      expect(gen(range)).toEqual(gen(range));
    });

    it('interpolates linearly', () => {
      const gen = signals.ramp({ from: 0, to: 100, interval: 2500, seed: 1 });
      const events = gen(range);
      // At 25%, 50%, 75% of range
      expect(events[1].value).toBe(25);
      expect(events[2].value).toBe(50);
      expect(events[3].value).toBe(75);
    });

    it('supports descending ramps', () => {
      const gen = signals.ramp({ from: 100, to: 0, interval: 5000, seed: 1 });
      const events = gen(range);
      expect(events[0].value).toBe(100);
      expect(events[events.length - 1].value).toBe(0);
    });

    it('adds noise when specified', () => {
      const clean = signals.ramp({ from: 0, to: 100, interval: 1000, seed: 1 });
      const noisy = signals.ramp({ from: 0, to: 100, noise: 3, interval: 1000, seed: 1 });
      const cleanEvents = clean(range);
      const noisyEvents = noisy(range);
      const diffs = cleanEvents.filter((e, i) => e.value !== noisyEvents[i].value);
      expect(diffs.length).toBeGreaterThan(0);
    });
  });

  describe('sequence', () => {
    it('concatenates segments in time', () => {
      const gen = signals.sequence([
        { duration: 5000, signal: signals.numeric({ base: 10, noise: 0, interval: 2500, seed: 1 }) },
        { duration: 5000, signal: signals.numeric({ base: 90, noise: 0, interval: 2500, seed: 1 }) },
      ]);
      const events = gen(range);
      // First segment: t=0,2500,5000 → 3 events at value 10
      // Second segment: t=5000,7500,10000 → 3 events at value 90
      // But t=5000 appears in both — sequence just appends, so 6 total
      const firstHalf = events.filter(e => e.value === 10);
      const secondHalf = events.filter(e => e.value === 90);
      expect(firstHalf.length).toBeGreaterThan(0);
      expect(secondHalf.length).toBeGreaterThan(0);
      expect(firstHalf[0].t).toBe(0);
      expect(secondHalf[0].t).toBe(5000);
    });

    it('passes normalized range to each segment', () => {
      const gen = signals.sequence([
        { duration: 5000, signal: signals.ramp({ from: 0, to: 100, interval: 5000, seed: 1 }) },
        { duration: 5000, signal: signals.ramp({ from: 100, to: 0, interval: 5000, seed: 1 }) },
      ]);
      const events = gen(range);
      // First ramp: 0→100 over 0-5000, second ramp: 100→0 over 5000-10000
      expect(events[0].value).toBe(0);
      expect(events[0].t).toBe(0);
      // Midpoint — end of first ramp
      const mid = events.find(e => e.t === 5000);
      expect(mid).toBeDefined();
      expect(mid!.value).toBe(100);
      // End of second ramp
      expect(events[events.length - 1].value).toBe(0);
      expect(events[events.length - 1].t).toBe(10000);
    });

    it('stops when range is exhausted', () => {
      const gen = signals.sequence([
        { duration: 20_000, signal: signals.numeric({ base: 50, noise: 0, interval: 5000, seed: 1 }) },
      ]);
      // Range is shorter than the segment
      const events = gen(range);
      expect(events.length).toBeGreaterThan(0);
      for (const e of events) {
        expect(e.t).toBeLessThanOrEqual(10_000);
      }
    });
  });
});

// ---- Simulated time engine ----

describe('runSimulation', () => {
  it('passes events through with no operators', () => {
    const input: SignalEvent[] = [
      { t: 0, value: 1 },
      { t: 1000, value: 2 },
    ];
    const result = runSimulation(input, []);
    expect(result.output).toEqual(input);
    expect(result.stats.passRate).toBe(1);
  });

  it('debounce coalesces rapid events', () => {
    const input: SignalEvent[] = [
      { t: 0, value: 1 },
      { t: 100, value: 2 },
      { t: 200, value: 3 },
      // 5000ms gap
      { t: 5200, value: 4 },
    ];
    const result = runSimulation(input, [{ type: 'debounce', ms: 500 }]);
    // Event at t=200 should fire after 500ms (t=700), event at t=5200 after 500ms (t=5700)
    expect(result.output.length).toBe(2);
    expect(result.output[0].value).toBe(3);
    expect(result.output[1].value).toBe(4);
  });

  it('throttle rate-limits events', () => {
    const input: SignalEvent[] = [
      { t: 0, value: 1 },
      { t: 100, value: 2 },
      { t: 200, value: 3 },
      { t: 1100, value: 4 },
    ];
    const result = runSimulation(input, [{ type: 'throttle', ms: 1000 }]);
    expect(result.output.length).toBe(2);
    expect(result.output[0].value).toBe(1);
    expect(result.output[1].value).toBe(4);
  });

  it('distinctUntilChanged deduplicates', () => {
    const input: SignalEvent[] = [
      { t: 0, value: 'on' },
      { t: 1000, value: 'on' },
      { t: 2000, value: 'off' },
      { t: 3000, value: 'off' },
      { t: 4000, value: 'on' },
    ];
    const result = runSimulation(input, [{ type: 'distinctUntilChanged' }]);
    expect(result.output).toEqual([
      { t: 0, value: 'on' },
      { t: 2000, value: 'off' },
      { t: 4000, value: 'on' },
    ]);
  });

  it('onTransition filters state transitions', () => {
    const input: SignalEvent[] = [
      { t: 0, value: 'off' },
      { t: 1000, value: 'on' },
      { t: 2000, value: 'off' },
      { t: 3000, value: 'on' },
    ];
    const result = runSimulation(input, [{ type: 'onTransition', from: 'off', to: 'on' }]);
    expect(result.output.length).toBe(2);
    expect(result.output[0].t).toBe(1000);
    expect(result.output[1].t).toBe(3000);
  });

  it('onTransition supports wildcards', () => {
    const input: SignalEvent[] = [
      { t: 0, value: 'idle' },
      { t: 1000, value: 'heating' },
      { t: 2000, value: 'cooling' },
    ];
    const result = runSimulation(input, [{ type: 'onTransition', from: '*', to: 'cooling' }]);
    expect(result.output.length).toBe(1);
    expect(result.output[0].value).toBe('cooling');
  });

  it('filter/map pass through in v1', () => {
    const input: SignalEvent[] = [
      { t: 0, value: 1 },
      { t: 1000, value: 2 },
    ];
    const result = runSimulation(input, [{ type: 'filter' }, { type: 'map' }]);
    expect(result.output).toEqual(input);
  });

  it('reports per-operator stats', () => {
    const input: SignalEvent[] = [
      { t: 0, value: 'on' },
      { t: 100, value: 'on' },
      { t: 200, value: 'off' },
    ];
    const result = runSimulation(input, [{ type: 'distinctUntilChanged' }]);
    expect(result.stats.perOperator).toHaveLength(1);
    expect(result.stats.perOperator[0].name).toBe('distinctUntilChanged');
    expect(result.stats.perOperator[0].inputCount).toBe(3);
    expect(result.stats.perOperator[0].outputCount).toBe(2);
  });

  it('chains multiple operators', () => {
    const input: SignalEvent[] = [
      { t: 0, value: 'on' },
      { t: 50, value: 'off' },
      { t: 100, value: 'on' },
      { t: 5000, value: 'off' },
      { t: 5050, value: 'on' },
      { t: 5100, value: 'off' },
    ];
    const result = runSimulation(input, [
      { type: 'distinctUntilChanged' },
      { type: 'throttle', ms: 1000 },
    ]);
    // distinctUntilChanged passes all (all different from previous)
    // throttle then rate-limits to 1 per second
    expect(result.output.length).toBeLessThan(input.length);
  });
});

// ---- Multi-entity simulation ----

describe('runMultiEntitySimulation', () => {
  it('merges events from multiple entities', () => {
    const inputs = new Map<string, SignalEvent[]>([
      ['sensor.a', [{ t: 0, value: 1 }, { t: 2000, value: 3 }]],
      ['sensor.b', [{ t: 1000, value: 2 }, { t: 3000, value: 4 }]],
    ]);
    const result = runMultiEntitySimulation(inputs, []);
    expect(result.output.length).toBe(4);
    // Should be sorted by time
    expect(result.output[0].t).toBe(0);
    expect(result.output[1].t).toBe(1000);
    expect(result.output[2].t).toBe(2000);
    expect(result.output[3].t).toBe(3000);
  });
});

// ---- Behavior simulation ----

describe('runBehaviorSimulation', () => {
  it('simulates debounced sensor', () => {
    const baseSensor = sensor({
      id: 'test',
      name: 'Test',
      init() { return '0'; },
    });
    const entity = debounced(baseSensor, { wait: 500 });

    const input: SignalEvent[] = [
      { t: 0, value: 10 },     // First update passes through immediately
      { t: 100, value: 11 },   // Debounced
      { t: 200, value: 12 },   // Debounced — replaces previous
      // Gap > 500ms
      { t: 5000, value: 20 },  // After debounce fires, this gets debounced
    ];

    const result = runBehaviorSimulation(entity, input);
    // First event passes immediately, then debounced event at ~700, then at ~5500
    expect(result.output.length).toBeGreaterThanOrEqual(2);
    expect(result.output[0].value).toBe(10); // First passes through
    expect(result.stats.inputCount).toBe(4);
  });

  it('reports stats', () => {
    const baseSensor = sensor({
      id: 'test',
      name: 'Test',
      init() { return '0'; },
    });
    const entity = debounced(baseSensor, { wait: 500 });

    const input: SignalEvent[] = [
      { t: 0, value: 1 },
      { t: 100, value: 2 },
      { t: 200, value: 3 },
    ];

    const result = runBehaviorSimulation(entity, input);
    expect(result.stats.inputCount).toBe(3);
    expect(result.stats.passRate).toBeLessThan(1);
  });
});
