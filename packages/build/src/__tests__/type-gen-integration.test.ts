import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { generateTypes } from '../type-generator.js';
import type { HARegistryData } from '../type-generator.js';

/**
 * Integration test: generates types from realistic HA data and verifies
 * the output files are syntactically valid and structurally correct.
 */
describe('Type generation integration', () => {
  let outputDir: string;

  function setup() {
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'typegen-int-'));
  }

  function cleanup() {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }

  function makeRealisticData(): HARegistryData {
    return {
      services: {
        light: {
          turn_on: {
            fields: {
              brightness: {
                required: false,
                selector: { number: { min: 0, max: 255, step: 1, mode: 'slider' } },
              },
              color_temp: {
                required: false,
                selector: { color_temp: { min: 153, max: 500 } },
              },
              rgb_color: {
                required: false,
                selector: { color_rgb: {} },
              },
              transition: {
                required: false,
                selector: { number: { min: 0, max: 300 } },
              },
              flash: {
                required: false,
                selector: { select: { options: ['short', 'long'] } },
              },
              effect: {
                required: false,
                selector: { text: {} },
              },
            },
          },
          turn_off: {
            fields: {
              transition: {
                required: false,
                selector: { number: { min: 0, max: 300 } },
              },
            },
          },
          toggle: {
            fields: {},
          },
        },
        switch: {
          turn_on: { fields: {} },
          turn_off: { fields: {} },
          toggle: { fields: {} },
        },
        climate: {
          set_temperature: {
            fields: {
              temperature: {
                required: true,
                selector: { number: { min: 7, max: 35, step: 0.5 } },
              },
              hvac_mode: {
                required: false,
                selector: { select: { options: ['off', 'heat', 'cool', 'auto'] } },
              },
            },
          },
          set_hvac_mode: {
            fields: {
              hvac_mode: {
                required: true,
                selector: { select: { options: ['off', 'heat', 'cool', 'heat_cool', 'auto', 'dry', 'fan_only'] } },
              },
            },
          },
        },
        input_select: {
          select_option: {
            fields: {
              option: { required: true, selector: { text: {} } },
            },
          },
          select_next: { fields: {} },
          select_previous: { fields: {} },
        },
        automation: {
          trigger: { fields: {} },
          turn_on: { fields: {} },
          turn_off: { fields: {} },
        },
      },
      states: [
        {
          entity_id: 'light.living_room',
          state: 'on',
          attributes: {
            brightness: 200,
            color_temp: 350,
            rgb_color: [255, 200, 100],
            friendly_name: 'Living Room Light',
            supported_features: 63,
          },
          last_changed: '2024-01-15T10:00:00.000Z',
          last_updated: '2024-01-15T10:00:01.000Z',
        },
        {
          entity_id: 'light.bedroom',
          state: 'off',
          attributes: {
            friendly_name: 'Bedroom Light',
            supported_features: 1,
          },
          last_changed: '2024-01-15T09:00:00.000Z',
          last_updated: '2024-01-15T09:00:00.000Z',
        },
        {
          entity_id: 'switch.pump',
          state: 'off',
          attributes: {
            friendly_name: 'Irrigation Pump',
            device_class: 'switch',
          },
          last_changed: '2024-01-15T08:00:00.000Z',
          last_updated: '2024-01-15T08:00:00.000Z',
        },
        {
          entity_id: 'sensor.temperature',
          state: '22.5',
          attributes: {
            unit_of_measurement: '°C',
            device_class: 'temperature',
            friendly_name: 'Outside Temperature',
            state_class: 'measurement',
          },
          last_changed: '2024-01-15T07:00:00.000Z',
          last_updated: '2024-01-15T07:30:00.000Z',
        },
        {
          entity_id: 'climate.bedroom',
          state: 'heat',
          attributes: {
            hvac_modes: ['off', 'heat', 'cool', 'auto'],
            min_temp: 7,
            max_temp: 35,
            temperature: 22,
            current_temperature: 20.5,
            friendly_name: 'Bedroom Climate',
          },
          last_changed: '2024-01-15T06:00:00.000Z',
          last_updated: '2024-01-15T06:30:00.000Z',
        },
        {
          entity_id: 'input_select.house_mode',
          state: 'home',
          attributes: {
            options: ['home', 'away', 'sleeping', 'vacation'],
            friendly_name: 'House Mode',
          },
          last_changed: '2024-01-15T05:00:00.000Z',
          last_updated: '2024-01-15T05:00:00.000Z',
        },
        {
          entity_id: 'automation.morning_lights',
          state: 'on',
          attributes: {
            friendly_name: 'Morning Lights',
            last_triggered: '2024-01-15T07:00:00.000Z',
          },
          last_changed: '2024-01-15T04:00:00.000Z',
          last_updated: '2024-01-15T07:00:00.000Z',
        },
      ],
      entities: [
        { entity_id: 'light.living_room', unique_id: 'abc1', platform: 'mqtt' },
        { entity_id: 'light.bedroom', unique_id: 'abc2', platform: 'mqtt' },
        { entity_id: 'switch.pump', unique_id: 'abc3', platform: 'mqtt' },
        { entity_id: 'sensor.temperature', unique_id: 'abc4', platform: 'mqtt' },
        { entity_id: 'climate.bedroom', unique_id: 'abc5', platform: 'mqtt' },
        { entity_id: 'input_select.house_mode', unique_id: 'abc6', platform: 'input_select' },
        { entity_id: 'automation.morning_lights', unique_id: 'abc7', platform: 'automation' },
      ],
      devices: [
        { id: 'dev1', name: 'Living Room Hub', manufacturer: 'Acme', area_id: 'living_room' },
      ],
      areas: [
        { area_id: 'living_room', name: 'Living Room' },
        { area_id: 'bedroom', name: 'Bedroom' },
      ],
      labels: [
        { label_id: 'important', name: 'Important' },
      ],
      haVersion: '2024.3.0',
    };
  }

  it('generates valid output from realistic HA data', () => {
    setup();
    const result = generateTypes(makeRealisticData(), outputDir);

    expect(result.success).toBe(true);
    expect(result.entityCount).toBe(7);
    expect(result.serviceCount).toBeGreaterThan(0);
    expect(result.errors).toHaveLength(0);
    expect(result.duration).toBeGreaterThanOrEqual(0);
    cleanup();
  });

  it('generates ha-registry.d.ts with all entities and domains', () => {
    setup();
    generateTypes(makeRealisticData(), outputDir);
    const dts = fs.readFileSync(path.join(outputDir, 'ha-registry.d.ts'), 'utf-8');

    // All entities present
    expect(dts).toContain("'light.living_room'");
    expect(dts).toContain("'light.bedroom'");
    expect(dts).toContain("'switch.pump'");
    expect(dts).toContain("'sensor.temperature'");
    expect(dts).toContain("'climate.bedroom'");
    expect(dts).toContain("'input_select.house_mode'");
    expect(dts).toContain("'automation.morning_lights'");

    // Correct domains
    expect(dts).toContain("domain: 'light'");
    expect(dts).toContain("domain: 'switch'");
    expect(dts).toContain("domain: 'sensor'");
    expect(dts).toContain("domain: 'climate'");
    expect(dts).toContain("domain: 'input_select'");
    expect(dts).toContain("domain: 'automation'");

    // input_select uses options for state type
    expect(dts).toMatch(/input_select\.house_mode.*'home' \| 'away' \| 'sleeping' \| 'vacation'/s);

    // Light uses 'on' | 'off'
    expect(dts).toMatch(/light\.living_room.*'on' \| 'off'/s);

    // Services are present
    expect(dts).toContain('turn_on');
    expect(dts).toContain('turn_off');
    expect(dts).toContain('toggle');
    expect(dts).toContain('set_temperature');

    // Utility types (ambient — no export keyword)
    expect(dts).toContain('type HAEntityId = keyof HAEntityMap');
    expect(dts).toContain('type HADomain');
    expect(dts).toContain('type EntitiesInDomain');

    // Typed HAClient interface
    expect(dts).toContain('interface HAClient {');
    expect(dts).not.toMatch(/^import\b/m);
    expect(dts).not.toMatch(/^export\b/m);

    cleanup();
  });

  it('generates ha-validators.ts with validators for constrained fields', () => {
    setup();
    generateTypes(makeRealisticData(), outputDir);
    const validators = fs.readFileSync(path.join(outputDir, 'ha-validators.ts'), 'utf-8');

    // Brightness validator
    expect(validators).toContain('rangeValidator(0, 255)');

    // Transition validator
    expect(validators).toContain('rangeValidator(0, 300)');

    // Color temp validator
    expect(validators).toContain('rangeValidator(153, 500)');

    // RGB validator
    expect(validators).toContain('rgbValidator()');

    // Flash select validator
    expect(validators).toContain("oneOfValidator(['short', 'long'] as const)");

    // Temperature validator
    expect(validators).toContain('rangeValidator(7, 35)');

    // HVAC mode validator
    expect(validators).toContain("oneOfValidator(['off', 'heat', 'cool', 'heat_cool', 'auto', 'dry', 'fan_only'] as const)");

    // Service keys
    expect(validators).toContain("'light.turn_on'");
    expect(validators).toContain("'light.turn_off'");
    expect(validators).toContain("'climate.set_temperature'");
    expect(validators).toContain("'climate.set_hvac_mode'");

    cleanup();
  });

  it('generates correct ha-registry-meta.json', () => {
    setup();
    generateTypes(makeRealisticData(), outputDir);
    const meta = JSON.parse(fs.readFileSync(path.join(outputDir, 'ha-registry-meta.json'), 'utf-8'));

    expect(meta.haVersion).toBe('2024.3.0');
    expect(meta.entityCount).toBe(7);
    expect(meta.serviceCount).toBeGreaterThan(10);
    expect(meta.domainCount).toBe(5);
    expect(meta.areaCount).toBe(2);
    expect(meta.deviceCount).toBe(1);
    expect(meta.labelCount).toBe(1);
    expect(meta.generatedAt).toBeDefined();

    cleanup();
  });

  it('handles service field optionality correctly', () => {
    setup();
    generateTypes(makeRealisticData(), outputDir);
    const dts = fs.readFileSync(path.join(outputDir, 'ha-registry.d.ts'), 'utf-8');

    // brightness is optional (required: false)
    expect(dts).toContain('brightness?:');

    // temperature in climate.set_temperature is required (required: true)
    expect(dts).toMatch(/set_temperature:.*temperature: number/s);

    cleanup();
  });
});
