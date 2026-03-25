# Behavior Shaping Examples

Complete device definitions with simulation scenarios that demonstrate how behaviors transform raw sensor data. Each example is self-contained -- paste it into the web editor and run the simulation to see the raw source signal alongside the shaped output.

All examples assume the source sensors already exist in HA (e.g., from ESPHome, Zigbee, or another integration). The `computed` entities watch those real entity IDs, and the scenarios shadow them with synthetic signals.

## Greenhouse Climate Monitor

A temperature probe jitters by several degrees on each reading. `buffered(average)` collapses 30 seconds of noise into a single clean value. The humidity probe occasionally returns wild spikes when condensation forms on the sensor element -- `filtered` rejects anything outside a plausible range before it reaches HA.

A downstream computed entity derives the dew point from the two cleaned sensors.

```typescript
export default device({
  id: 'greenhouse_climate',
  name: 'Greenhouse Climate Monitor',
  manufacturer: 'HA Forge',
  suggested_area: 'Greenhouse',
  entities: {
    temperature: buffered(
      computed({
        id: 'gh_temp',
        name: 'Temperature (30s avg)',
        config: { device_class: 'temperature', unit_of_measurement: '°C', state_class: 'measurement' },
        watch: ['sensor.gh_temp_probe'],
        compute: (states) => {
          const raw = Number(states['sensor.gh_temp_probe']?.state);
          return isNaN(raw) ? 0 : Math.round(raw * 100) / 100;
        },
      }),
      { interval: 30_000, reduce: average },
    ),

    humidity: filtered(
      computed({
        id: 'gh_humidity',
        name: 'Humidity (cleaned)',
        config: { device_class: 'humidity', unit_of_measurement: '%', state_class: 'measurement' },
        watch: ['sensor.gh_humidity_probe'],
        compute: (states) => {
          const raw = Number(states['sensor.gh_humidity_probe']?.state);
          return isNaN(raw) ? 0 : Math.round(raw * 10) / 10;
        },
      }),
      (value) => value >= 0 && value <= 95,
    ),

    dewPoint: computed({
      id: 'gh_dew_point',
      name: 'Dew Point',
      config: { device_class: 'temperature', unit_of_measurement: '°C', state_class: 'measurement' },
      watch: ['sensor.gh_temp', 'sensor.gh_humidity'],
      compute: (states) => {
        const t = Number(states['sensor.gh_temp']?.state);
        const rh = Number(states['sensor.gh_humidity']?.state);
        if (isNaN(t) || isNaN(rh) || rh <= 0) return 0;
        // Magnus formula approximation
        const a = 17.27, b = 237.7;
        const alpha = (a * t) / (b + t) + Math.log(rh / 100);
        return Math.round(((b * alpha) / (a - alpha)) * 10) / 10;
      },
    }),
  },
});

// ---- Scenarios ----

// Steady conditions: probe jitters around 24°C, humidity around 65%.
// The buffered temperature should flatten into clean ~24°C readings.
// The filtered humidity should pass most values but reject occasional spikes.
simulate.scenario('steady', [
  {
    shadows: 'sensor.gh_temp_probe',
    signal: signals.numeric({ base: 24, noise: 3, interval: 5000, seed: 1 }),
  },
  {
    shadows: 'sensor.gh_humidity_probe',
    signal: signals.numeric({ base: 65, noise: 5, spikeTo: 99, spikeChance: 0.08, interval: 5000, seed: 2 }),
  },
]);

// Ventilation event: someone opens the greenhouse door.
// Temperature ramps down as outside air floods in, holds, then slowly recovers.
// Humidity swings harder with more frequent condensation spikes.
simulate.scenario('ventilation', [
  {
    shadows: 'sensor.gh_temp_probe',
    signal: signals.sequence([
      { duration: 120_000, signal: signals.numeric({ base: 24, noise: 2, interval: 5000, seed: 10 }) },
      { duration: 180_000, signal: signals.ramp({ from: 24, to: 15, noise: 2, interval: 5000, seed: 11 }) },
      { duration: 300_000, signal: signals.numeric({ base: 15, noise: 3, interval: 5000, seed: 12 }) },
      { duration: 300_000, signal: signals.ramp({ from: 15, to: 23, noise: 2, interval: 5000, seed: 13 }) },
    ]),
  },
  {
    shadows: 'sensor.gh_humidity_probe',
    signal: signals.numeric({ base: 72, noise: 8, spikeTo: 99, spikeChance: 0.15, interval: 5000, seed: 20 }),
  },
]);
```

## Workshop Air Quality Station

A PM2.5 particulate sensor reports every second -- far too fast for HA. `sampled` captures every reading internally but only publishes the latest value every 30 seconds, keeping the database manageable without losing responsiveness.

A VOC (volatile organic compounds) sensor produces short bursts when solvents are opened or spray paint is used. `debounced` lets the first reading through immediately, then waits for the burst to settle before publishing the final value. This prevents automation flicker (e.g., an exhaust fan toggling on/off/on during a single event).

```typescript
export default device({
  id: 'workshop_air',
  name: 'Workshop Air Quality',
  manufacturer: 'HA Forge',
  suggested_area: 'Workshop',
  entities: {
    pm25: sampled(
      computed({
        id: 'ws_pm25',
        name: 'PM2.5',
        config: { device_class: 'pm25', unit_of_measurement: 'µg/m³', state_class: 'measurement' },
        watch: ['sensor.ws_pm25_raw'],
        compute: (states) => {
          const raw = Number(states['sensor.ws_pm25_raw']?.state);
          return isNaN(raw) ? 0 : Math.round(raw * 10) / 10;
        },
      }),
      { interval: 30_000 },
    ),

    voc: debounced(
      computed({
        id: 'ws_voc',
        name: 'VOC Index',
        config: { device_class: 'volatile_organic_compounds_parts', unit_of_measurement: 'ppb', state_class: 'measurement' },
        watch: ['sensor.ws_voc_raw'],
        compute: (states) => {
          const raw = Number(states['sensor.ws_voc_raw']?.state);
          return isNaN(raw) ? 0 : Math.round(raw);
        },
      }),
      { wait: 10_000 },
    ),
  },
});

// ---- Scenarios ----

// Idle workshop: low particulate, stable VOC. The sampled PM2.5 should
// thin 1-second readings down to one per 30 seconds. The debounced VOC
// should pass the first reading then go quiet (no bursts to settle).
simulate.scenario('idle', [
  {
    shadows: 'sensor.ws_pm25_raw',
    signal: signals.numeric({ base: 12, noise: 5, interval: 1000, seed: 1 }),
  },
  {
    shadows: 'sensor.ws_voc_raw',
    signal: signals.numeric({ base: 150, noise: 20, interval: 3000, seed: 2 }),
  },
]);

// Active project: sanding kicks up dust (PM2.5 base jumps, occasional
// spikes from fine particles). Spray paint creates VOC bursts that ramp
// up sharply then decay. The debounced VOC should absorb the bursts and
// publish a settled value after each one.
simulate.scenario('sanding and painting', [
  {
    shadows: 'sensor.ws_pm25_raw',
    signal: signals.sequence([
      { duration: 60_000,  signal: signals.numeric({ base: 12, noise: 5, interval: 1000, seed: 10 }) },
      { duration: 300_000, signal: signals.numeric({ base: 85, noise: 30, spikeTo: 200, spikeChance: 0.05, interval: 1000, seed: 11 }) },
      { duration: 120_000, signal: signals.ramp({ from: 85, to: 20, noise: 10, interval: 1000, seed: 12 }) },
      { duration: 120_000, signal: signals.numeric({ base: 15, noise: 5, interval: 1000, seed: 13 }) },
    ]),
  },
  {
    shadows: 'sensor.ws_voc_raw',
    signal: signals.sequence([
      { duration: 60_000,  signal: signals.numeric({ base: 150, noise: 20, interval: 3000, seed: 20 }) },
      { duration: 30_000,  signal: signals.ramp({ from: 150, to: 800, noise: 50, interval: 3000, seed: 21 }) },
      { duration: 120_000, signal: signals.numeric({ base: 800, noise: 100, interval: 3000, seed: 22 }) },
      { duration: 180_000, signal: signals.ramp({ from: 800, to: 200, noise: 40, interval: 3000, seed: 23 }) },
      { duration: 210_000, signal: signals.numeric({ base: 180, noise: 30, interval: 3000, seed: 24 }) },
    ]),
  },
]);
```

## Aquarium Controller

pH probes are notoriously glitchy -- occasional readings jump to 5.0 or 9.0 when the electrode is briefly fouled. Raw averaging would drag the reported value toward these outliers. Wrapping with `filtered` first rejects readings outside a plausible band, then `buffered(average)` averages the survivors over one minute. The filter runs before the buffer, so glitch values never enter the averaging window.

Water temperature fluctuates by fractions of a degree as the heater cycles. Most of those changes aren't meaningful. A dead-band `filtered` only publishes when the value moves by more than 0.3°C from the last published reading, cutting database writes without masking real changes.

```typescript
export default device({
  id: 'aquarium',
  name: 'Aquarium Controller',
  manufacturer: 'HA Forge',
  suggested_area: 'Living Room',
  entities: {
    // Filter glitches, then average survivors per minute.
    // Composition order: filtered wraps the inner computed, buffered wraps that.
    // Update flow: compute → filtered (reject outliers) → buffered (collect) → reduce → publish
    ph: buffered(
      filtered(
        computed({
          id: 'aq_ph',
          name: 'pH (1min avg)',
          config: { unit_of_measurement: 'pH', state_class: 'measurement' },
          watch: ['sensor.aq_ph_probe'],
          compute: (states) => {
            const raw = Number(states['sensor.aq_ph_probe']?.state);
            return isNaN(raw) ? 7.0 : Math.round(raw * 100) / 100;
          },
        }),
        (value) => value >= 6.0 && value <= 8.5,
      ),
      { interval: 60_000, reduce: average },
    ),

    // Same source, different reducer: track the range of valid readings per window.
    phMin: buffered(
      filtered(
        computed({
          id: 'aq_ph_min',
          name: 'pH (1min min)',
          config: { unit_of_measurement: 'pH', state_class: 'measurement' },
          watch: ['sensor.aq_ph_probe'],
          compute: (states) => {
            const raw = Number(states['sensor.aq_ph_probe']?.state);
            return isNaN(raw) ? 7.0 : Math.round(raw * 100) / 100;
          },
        }),
        (value) => value >= 6.0 && value <= 8.5,
      ),
      { interval: 60_000, reduce: min },
    ),

    phMax: buffered(
      filtered(
        computed({
          id: 'aq_ph_max',
          name: 'pH (1min max)',
          config: { unit_of_measurement: 'pH', state_class: 'measurement' },
          watch: ['sensor.aq_ph_probe'],
          compute: (states) => {
            const raw = Number(states['sensor.aq_ph_probe']?.state);
            return isNaN(raw) ? 7.0 : Math.round(raw * 100) / 100;
          },
        }),
        (value) => value >= 6.0 && value <= 8.5,
      ),
      { interval: 60_000, reduce: max },
    ),

    // Dead-band: only publish when temperature changes by more than 0.3°C.
    waterTemp: (() => {
      let lastPublished = 25.0;
      return filtered(
        computed({
          id: 'aq_water_temp',
          name: 'Water Temperature',
          config: { device_class: 'temperature', unit_of_measurement: '°C', state_class: 'measurement' },
          watch: ['sensor.aq_temp_probe'],
          compute: (states) => {
            const raw = Number(states['sensor.aq_temp_probe']?.state);
            return isNaN(raw) ? 25.0 : Math.round(raw * 10) / 10;
          },
        }),
        (value) => {
          if (Math.abs(value - lastPublished) < 0.3) return false;
          lastPublished = value;
          return true;
        },
      );
    })(),
  },
});

// ---- Scenarios ----

// Stable tank: pH hovers at 7.0 with tiny noise and occasional glitch spikes.
// The filtered+buffered chain should show clean 7.0 averages while
// the raw source shows scattered outliers.
// Temperature drifts in a very narrow band -- the dead-band filter
// should produce far fewer output events than input events.
simulate.scenario('stable tank', [
  {
    shadows: 'sensor.aq_ph_probe',
    signal: signals.numeric({ base: 7.0, noise: 0.08, spikeTo: 5.2, spikeChance: 0.06, interval: 5000, seed: 1 }),
  },
  {
    shadows: 'sensor.aq_temp_probe',
    signal: signals.numeric({ base: 25.0, noise: 0.2, interval: 5000, seed: 2 }),
  },
]);

// Water change: draining 30% of the tank and refilling with tap water.
// pH drops as acidic tap water mixes in, then slowly recovers as the
// buffer substrate neutralizes it. Temperature dips from cooler tap water
// then the heater brings it back up.
simulate.scenario('water change', [
  {
    shadows: 'sensor.aq_ph_probe',
    signal: signals.sequence([
      { duration: 120_000, signal: signals.numeric({ base: 7.0, noise: 0.05, interval: 5000, seed: 10 }) },
      { duration: 120_000, signal: signals.ramp({ from: 7.0, to: 6.4, noise: 0.1, interval: 5000, seed: 11 }) },
      { duration: 60_000,  signal: signals.numeric({ base: 6.4, noise: 0.15, spikeTo: 5.0, spikeChance: 0.1, interval: 5000, seed: 12 }) },
      { duration: 300_000, signal: signals.ramp({ from: 6.4, to: 6.9, noise: 0.08, interval: 5000, seed: 13 }) },
    ]),
  },
  {
    shadows: 'sensor.aq_temp_probe',
    signal: signals.sequence([
      { duration: 120_000, signal: signals.numeric({ base: 25.0, noise: 0.15, interval: 5000, seed: 20 }) },
      { duration: 90_000,  signal: signals.ramp({ from: 25.0, to: 23.5, noise: 0.2, interval: 5000, seed: 21 }) },
      { duration: 390_000, signal: signals.ramp({ from: 23.5, to: 24.8, noise: 0.15, interval: 5000, seed: 22 }) },
    ]),
  },
]);
```

## Solar Inverter Monitor

A residential inverter reports power output multiple times per second. `sampled` throttles this to one publish per minute for the real-time gauge. A second entity uses `buffered(average)` to produce 5-minute average power readings, suitable for energy dashboards and long-term trending.

The "clear day" scenario uses a half-period `sine` to model the natural bell curve of solar output -- zero at dawn, peak at midday, back to zero at dusk. "Partly cloudy" uses `sequence` to build the same general shape but with a noisy midday segment where cloud shadows cause rapid output swings.

```typescript
export default device({
  id: 'solar_inverter',
  name: 'Solar Inverter',
  manufacturer: 'HA Forge',
  model: '5kW String Inverter',
  suggested_area: 'Roof',
  entities: {
    // Real-time power: latest reading published once per minute.
    power: sampled(
      computed({
        id: 'solar_power',
        name: 'Solar Power',
        config: { device_class: 'power', unit_of_measurement: 'W', state_class: 'measurement' },
        watch: ['sensor.inverter_ac_power'],
        compute: (states) => {
          const raw = Number(states['sensor.inverter_ac_power']?.state);
          return isNaN(raw) || raw < 0 ? 0 : Math.round(raw);
        },
      }),
      { interval: 60_000 },
    ),

    // 5-minute average: smooths cloud transients for dashboards.
    powerAvg: buffered(
      computed({
        id: 'solar_power_avg',
        name: 'Solar Power (5min avg)',
        config: { device_class: 'power', unit_of_measurement: 'W', state_class: 'measurement' },
        watch: ['sensor.inverter_ac_power'],
        compute: (states) => {
          const raw = Number(states['sensor.inverter_ac_power']?.state);
          return isNaN(raw) || raw < 0 ? 0 : Math.round(raw);
        },
      }),
      { interval: 300_000, reduce: average },
    ),
  },
});

// ---- Scenarios ----

// Clear day: smooth bell curve from 0 to 4500W peak.
// The sine period is 2x the simulation range so one half-cycle fills the
// window -- starts at 0, peaks at the midpoint, returns to 0.
// The sampled entity should produce one event per minute tracking the curve.
// The buffered average should produce one per 5 minutes, slightly behind
// the real-time value since it averages over the window.
simulate.scenario('clear day', [
  {
    shadows: 'sensor.inverter_ac_power',
    signal: signals.sine({
      min: 0,
      max: 4500,
      period: 7200_000,  // 2x a 60-min sim = one half-cycle arch
      noise: 30,
      interval: 2000,
      seed: 1,
    }),
  },
]);

// Partly cloudy: same general shape but midday has rapid swings
// from passing clouds. The ramp-up and ramp-down are clean; the
// middle plateau is noisy with dips toward zero.
// The sampled real-time reading will jump around during the cloudy
// period, while the 5-minute average should stay relatively stable.
simulate.scenario('partly cloudy', [
  {
    shadows: 'sensor.inverter_ac_power',
    signal: signals.sequence([
      // Morning ramp: sunrise to ~3500W
      { duration: 600_000,  signal: signals.ramp({ from: 0, to: 3500, noise: 40, interval: 2000, seed: 10 }) },
      // Midday: clouds cause big swings around 3000W with dips
      { duration: 1800_000, signal: signals.numeric({ base: 3000, noise: 1500, interval: 2000, seed: 11 }) },
      // Afternoon clearing: stable high output
      { duration: 600_000,  signal: signals.numeric({ base: 4000, noise: 100, interval: 2000, seed: 12 }) },
      // Evening ramp-down: sunset
      { duration: 600_000,  signal: signals.ramp({ from: 4000, to: 0, noise: 30, interval: 2000, seed: 13 }) },
    ]),
  },
]);
```
