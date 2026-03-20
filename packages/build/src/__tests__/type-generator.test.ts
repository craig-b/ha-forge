import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { selectorToType, generateTypes } from '../type-generator.js';
import type { HARegistryData } from '../type-generator.js';

// ---- selectorToType tests ----

describe('selectorToType()', () => {
  describe('number selector', () => {
    it('maps number with min/max to rangeValidator', () => {
      const result = selectorToType({ number: { min: 0, max: 255 } });
      expect(result.tsType).toBe('number');
      expect(result.validatorCode).toBe('rangeValidator(0, 255)');
    });

    it('maps number without range to plain number', () => {
      const result = selectorToType({ number: {} });
      expect(result.tsType).toBe('number');
      expect(result.validatorCode).toBeNull();
    });

    it('maps number with only min to plain number', () => {
      const result = selectorToType({ number: { min: 0 } });
      expect(result.tsType).toBe('number');
      expect(result.validatorCode).toBeNull();
    });
  });

  describe('boolean selector', () => {
    it('maps to boolean', () => {
      const result = selectorToType({ boolean: null });
      expect(result.tsType).toBe('boolean');
      expect(result.validatorCode).toBeNull();
    });
  });

  describe('text selector', () => {
    it('maps to string', () => {
      const result = selectorToType({ text: {} });
      expect(result.tsType).toBe('string');
      expect(result.validatorCode).toBeNull();
    });
  });

  describe('select selector', () => {
    it('maps string options to union type with oneOfValidator', () => {
      const result = selectorToType({ select: { options: ['home', 'away', 'sleep'] } });
      expect(result.tsType).toBe("'home' | 'away' | 'sleep'");
      expect(result.validatorCode).toBe("oneOfValidator(['home', 'away', 'sleep'] as const)");
    });

    it('handles object options with value/label pairs', () => {
      const result = selectorToType({
        select: { options: [{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }] },
      });
      expect(result.tsType).toBe("'on' | 'off'");
      expect(result.validatorCode).toBe("oneOfValidator(['on', 'off'] as const)");
    });

    it('falls back to string when no options', () => {
      const result = selectorToType({ select: {} });
      expect(result.tsType).toBe('string');
      expect(result.validatorCode).toBeNull();
    });
  });

  describe('entity selector', () => {
    it('maps to entity ID union when matching entities exist', () => {
      const entityIds = ['light.living_room', 'light.bedroom', 'switch.pump'];
      const result = selectorToType({ entity: { domain: 'light' } }, entityIds);
      expect(result.tsType).toBe("'light.living_room' | 'light.bedroom'");
    });

    it('falls back to string when no matching entities', () => {
      const result = selectorToType({ entity: { domain: 'light' } }, []);
      expect(result.tsType).toBe('string');
    });

    it('falls back to string when no entityIds provided', () => {
      const result = selectorToType({ entity: { domain: 'light' } });
      expect(result.tsType).toBe('string');
    });
  });

  describe('color_rgb selector', () => {
    it('maps to RGB tuple with rgbValidator', () => {
      const result = selectorToType({ color_rgb: {} });
      expect(result.tsType).toBe('[number, number, number]');
      expect(result.validatorCode).toBe('rgbValidator()');
    });
  });

  describe('color_temp selector', () => {
    it('maps to number with rangeValidator when range provided', () => {
      const result = selectorToType({ color_temp: { min: 153, max: 500 } });
      expect(result.tsType).toBe('number');
      expect(result.validatorCode).toBe('rangeValidator(153, 500)');
    });
  });

  describe('time/template/device/area selectors', () => {
    it('maps time to string', () => {
      expect(selectorToType({ time: {} }).tsType).toBe('string');
    });

    it('maps time_period to string', () => {
      expect(selectorToType({ time_period: {} }).tsType).toBe('string');
    });

    it('maps template to string', () => {
      expect(selectorToType({ template: {} }).tsType).toBe('string');
    });

    it('maps device to string', () => {
      expect(selectorToType({ device: {} }).tsType).toBe('string');
    });

    it('maps area to string', () => {
      expect(selectorToType({ area: {} }).tsType).toBe('string');
    });
  });

  describe('object selector', () => {
    it('maps to Record<string, unknown>', () => {
      expect(selectorToType({ object: {} }).tsType).toBe('Record<string, unknown>');
    });
  });

  describe('target selector', () => {
    it('maps to target type', () => {
      const result = selectorToType({ target: {} });
      expect(result.tsType).toContain('entity_id');
      expect(result.tsType).toContain('device_id');
      expect(result.tsType).toContain('area_id');
    });
  });

  describe('duration selector', () => {
    it('maps to time parts object', () => {
      const result = selectorToType({ duration: {} });
      expect(result.tsType).toContain('hours');
      expect(result.tsType).toContain('minutes');
      expect(result.tsType).toContain('seconds');
    });
  });

  describe('unknown selector', () => {
    it('falls back to unknown for future selectors', () => {
      const result = selectorToType({ future_new_selector: {} });
      expect(result.tsType).toBe('unknown');
      expect(result.validatorCode).toBeNull();
    });
  });

  describe('empty selector', () => {
    it('returns unknown for empty selector object', () => {
      const result = selectorToType({});
      expect(result.tsType).toBe('unknown');
    });
  });
});

// ---- generateTypes tests ----

function makeRegistryData(overrides?: Partial<HARegistryData>): HARegistryData {
  return {
    services: {
      light: {
        turn_on: {
          fields: {
            brightness: {
              required: false,
              selector: { number: { min: 0, max: 255 } },
            },
            rgb_color: {
              required: false,
              selector: { color_rgb: {} },
            },
            transition: {
              required: false,
              selector: { number: { min: 0, max: 300 } },
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
      input_select: {
        select_option: {
          fields: {
            option: {
              required: true,
              selector: { text: {} },
            },
          },
        },
      },
    },
    states: [
      {
        entity_id: 'light.living_room',
        state: 'on',
        attributes: {
          brightness: 200,
          friendly_name: 'Living Room',
          rgb_color: [255, 200, 100],
          supported_features: 63,
        },
        last_changed: '2024-01-15T10:00:00.000Z',
        last_updated: '2024-01-15T10:00:01.000Z',
      },
      {
        entity_id: 'input_select.house_mode',
        state: 'home',
        attributes: {
          options: ['home', 'away', 'sleeping'],
          friendly_name: 'House Mode',
        },
        last_changed: '2024-01-15T09:00:00.000Z',
        last_updated: '2024-01-15T09:00:00.000Z',
      },
      {
        entity_id: 'sensor.temperature',
        state: '22.5',
        attributes: {
          unit_of_measurement: '°C',
          device_class: 'temperature',
          friendly_name: 'Temperature',
        },
        last_changed: '2024-01-15T08:00:00.000Z',
        last_updated: '2024-01-15T08:00:00.000Z',
      },
    ],
    entities: [],
    devices: [],
    areas: [],
    labels: [],
    haVersion: '2024.1.0',
    ...overrides,
  };
}

describe('generateTypes()', () => {
  let outputDir: string;

  function setup() {
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'typegen-'));
  }

  function cleanup() {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }

  it('generates all three output files', () => {
    setup();
    const data = makeRegistryData();
    const result = generateTypes(data, outputDir);

    expect(result.success).toBe(true);
    expect(fs.existsSync(path.join(outputDir, 'ha-registry.d.ts'))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, 'ha-validators.ts'))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, 'ha-registry-meta.json'))).toBe(true);
    cleanup();
  });

  it('includes correct entity count and service count', () => {
    setup();
    const data = makeRegistryData();
    const result = generateTypes(data, outputDir);

    expect(result.entityCount).toBe(3);
    // light has 3 services, input_select has 1
    expect(result.serviceCount).toBe(4);
    cleanup();
  });

  describe('ha-registry.d.ts content', () => {
    it('contains HAEntityMap with all entities', () => {
      setup();
      generateTypes(makeRegistryData(), outputDir);
      const content = fs.readFileSync(path.join(outputDir, 'ha-registry.d.ts'), 'utf-8');

      expect(content).toContain("'light.living_room'");
      expect(content).toContain("'input_select.house_mode'");
      expect(content).toContain("'sensor.temperature'");
      cleanup();
    });

    it('uses binary state type for lights', () => {
      setup();
      generateTypes(makeRegistryData(), outputDir);
      const content = fs.readFileSync(path.join(outputDir, 'ha-registry.d.ts'), 'utf-8');

      // light.living_room should have 'on' | 'off' state type
      expect(content).toMatch(/light\.living_room.*state: 'on' \| 'off'/s);
      cleanup();
    });

    it('uses options for input_select state type', () => {
      setup();
      generateTypes(makeRegistryData(), outputDir);
      const content = fs.readFileSync(path.join(outputDir, 'ha-registry.d.ts'), 'utf-8');

      expect(content).toMatch(/input_select\.house_mode.*state: 'home' \| 'away' \| 'sleeping'/s);
      cleanup();
    });

    it('uses string state type for sensors', () => {
      setup();
      generateTypes(makeRegistryData(), outputDir);
      const content = fs.readFileSync(path.join(outputDir, 'ha-registry.d.ts'), 'utf-8');

      expect(content).toMatch(/sensor\.temperature.*state: string/s);
      cleanup();
    });

    it('infers attribute types from values', () => {
      setup();
      generateTypes(makeRegistryData(), outputDir);
      const content = fs.readFileSync(path.join(outputDir, 'ha-registry.d.ts'), 'utf-8');

      // brightness should be number
      expect(content).toContain('brightness: number');
      // friendly_name should be string
      expect(content).toContain('friendly_name: string');
      cleanup();
    });

    it('generates service types with field optionality', () => {
      setup();
      generateTypes(makeRegistryData(), outputDir);
      const content = fs.readFileSync(path.join(outputDir, 'ha-registry.d.ts'), 'utf-8');

      // light.turn_on brightness should be optional (not required)
      expect(content).toContain('brightness?: number');
      // input_select.select_option option should be required
      expect(content).toMatch(/option: string/);
      cleanup();
    });

    it('declares ambient utility types (no export keyword)', () => {
      setup();
      generateTypes(makeRegistryData(), outputDir);
      const content = fs.readFileSync(path.join(outputDir, 'ha-registry.d.ts'), 'utf-8');

      expect(content).toContain('type HAEntityId = keyof HAEntityMap');
      expect(content).toContain('type HADomain =');
      expect(content).toContain('type EntitiesInDomain');
      // Must be ambient — no import or export keywords
      expect(content).not.toMatch(/^import\b/m);
      expect(content).not.toMatch(/^export\b/m);
      cleanup();
    });

    it('includes HA version in header comment', () => {
      setup();
      generateTypes(makeRegistryData(), outputDir);
      const content = fs.readFileSync(path.join(outputDir, 'ha-registry.d.ts'), 'utf-8');

      expect(content).toContain('HA Version: 2024.1.0');
      cleanup();
    });

    it('generates typed HAClient interface extending HAClientBase', () => {
      setup();
      generateTypes(makeRegistryData(), outputDir);
      const content = fs.readFileSync(path.join(outputDir, 'ha-registry.d.ts'), 'utf-8');

      expect(content).toContain('interface HAClient extends HAClientBase');
      cleanup();
    });

    it('generates typed getEntities() with domain-narrowed return', () => {
      setup();
      generateTypes(makeRegistryData(), outputDir);
      const content = fs.readFileSync(path.join(outputDir, 'ha-registry.d.ts'), 'utf-8');

      expect(content).toContain('getEntities<D extends HADomain>(domain: D): Promise<EntitiesInDomain<D>[]>');
      expect(content).toContain('getEntities(domain?: string): Promise<HAEntityId[]>');
      cleanup();
    });

    it('generates typed on() overloads for each entity with entity_id literal', () => {
      setup();
      generateTypes(makeRegistryData(), outputDir);
      const content = fs.readFileSync(path.join(outputDir, 'ha-registry.d.ts'), 'utf-8');

      expect(content).toContain("on(entity: 'light.living_room',");
      expect(content).toContain("on(entity: 'sensor.temperature',");
      expect(content).toContain('TypedStateChangedEvent<');
      // Entity ID literal should be the third type parameter
      expect(content).toContain("'light.living_room'>) => void): () => void;");
      cleanup();
    });

    it('generates typed callService() overloads with generic service parameter per entity', () => {
      setup();
      generateTypes(makeRegistryData(), outputDir);
      const content = fs.readFileSync(path.join(outputDir, 'ha-registry.d.ts'), 'utf-8');

      // One generic overload per entity (service narrows via HAEntityMap, return type is conditional on responds)
      expect(content).toContain("callService<S extends keyof HAEntityMap['light.living_room']['services']>(entity: 'light.living_room', service: S, data?: HAEntityMap['light.living_room']['services'][S]['data']): Promise<HAEntityMap['light.living_room']['services'][S]['responds'] extends true ? Record<string, unknown> : null>;");
      // Entities without services for their domain should not have callService overloads
      // sensor.temperature has no sensor services in this test data
      expect(content).not.toContain("callService<S extends keyof HAEntityMap['sensor.temperature']");
      cleanup();
    });

    it('marks services with response data as responds: true in HAEntityMap', () => {
      setup();
      const data = makeRegistryData({
        services: {
          ...makeRegistryData().services,
          ai_task: {
            generate_data: {
              fields: {
                task_name: { required: true, selector: { text: {} } },
                instructions: { required: true, selector: { text: {} } },
              },
              response: { optional: false },
            },
          },
        },
        states: [
          ...makeRegistryData().states,
          {
            entity_id: 'ai_task.openai',
            state: 'idle',
            attributes: { friendly_name: 'OpenAI' },
            last_changed: '2024-01-15T10:00:00.000Z',
            last_updated: '2024-01-15T10:00:00.000Z',
          },
        ],
      });
      generateTypes(data, outputDir);
      const content = fs.readFileSync(path.join(outputDir, 'ha-registry.d.ts'), 'utf-8');

      // ai_task.generate_data should have responds: true
      expect(content).toContain('generate_data: { data: {');
      expect(content).toContain('responds: true');
      // light.turn_on should have responds: false (on a nearby line)
      expect(content).toContain('responds: false');
      cleanup();
    });

    it('generates typed getState() overloads for each entity', () => {
      setup();
      generateTypes(makeRegistryData(), outputDir);
      const content = fs.readFileSync(path.join(outputDir, 'ha-registry.d.ts'), 'utf-8');

      expect(content).toContain("getState(entityId: 'light.living_room'):");
      expect(content).toContain("getState(entityId: 'sensor.temperature'):");
      cleanup();
    });

    it('does not include string fallback overloads', () => {
      setup();
      generateTypes(makeRegistryData(), outputDir);
      const content = fs.readFileSync(path.join(outputDir, 'ha-registry.d.ts'), 'utf-8');

      // Typed overloads exist
      expect(content).toContain("on(entity: 'light.living_room',");
      expect(content).toContain("callService<S extends keyof HAEntityMap['light.living_room']");
      expect(content).toContain("getState(entityId: 'light.living_room'):");

      // No string fallbacks
      expect(content).not.toContain('on(entityOrDomain: string | string[],');
      expect(content).not.toContain('callService(entity: string, service: string,');
      expect(content).not.toContain('getState(entityId: string):');
      expect(content).not.toContain('reactions(rules: Record<string, ReactionRule>)');

      cleanup();
    });

    it('generates domain-level on() overloads', () => {
      setup();
      generateTypes(makeRegistryData(), outputDir);
      const content = fs.readFileSync(path.join(outputDir, 'ha-registry.d.ts'), 'utf-8');

      // Domain overloads for light and input_select
      expect(content).toContain("on(domain: 'light',");
      expect(content).toContain("on(domain: 'input_select',");
      // Domain on() should use EntitiesInDomain for entity_id
      expect(content).toContain("EntitiesInDomain<'light'>");
      cleanup();
    });

    it('generates typed array on() overload', () => {
      setup();
      generateTypes(makeRegistryData(), outputDir);
      const content = fs.readFileSync(path.join(outputDir, 'ha-registry.d.ts'), 'utf-8');

      expect(content).toContain('on<E extends HAEntityId>(entities: E[],');
      cleanup();
    });

    it('generates domain-level callService() overloads', () => {
      setup();
      generateTypes(makeRegistryData(), outputDir);
      const content = fs.readFileSync(path.join(outputDir, 'ha-registry.d.ts'), 'utf-8');

      // Domain callService for light (has services)
      expect(content).toContain("entity: 'light', service: S,");
      // No domain callService for sensor (no sensor services in test data)
      expect(content).not.toContain("entity: 'sensor', service: S,");
      cleanup();
    });

    it('generates typed reactions() overload', () => {
      setup();
      generateTypes(makeRegistryData(), outputDir);
      const content = fs.readFileSync(path.join(outputDir, 'ha-registry.d.ts'), 'utf-8');

      // Typed reactions with mapped entity keys
      expect(content).toContain('reactions<K extends HAEntityId>(rules: {');
      expect(content).toContain("to?: HAEntityMap[E]['state']");
      // No string fallback
      expect(content).not.toContain('reactions(rules: Record<string, ReactionRule>): () => void;');
      cleanup();
    });
  });

  describe('ha-validators.ts content', () => {
    it('generates rangeValidator for number fields', () => {
      setup();
      generateTypes(makeRegistryData(), outputDir);
      const content = fs.readFileSync(path.join(outputDir, 'ha-validators.ts'), 'utf-8');

      expect(content).toContain('rangeValidator(0, 255)');
      expect(content).toContain('rangeValidator(0, 300)');
      cleanup();
    });

    it('generates rgbValidator for color_rgb fields', () => {
      setup();
      generateTypes(makeRegistryData(), outputDir);
      const content = fs.readFileSync(path.join(outputDir, 'ha-validators.ts'), 'utf-8');

      expect(content).toContain('rgbValidator()');
      cleanup();
    });

    it('imports validators from SDK', () => {
      setup();
      generateTypes(makeRegistryData(), outputDir);
      const content = fs.readFileSync(path.join(outputDir, 'ha-validators.ts'), 'utf-8');

      expect(content).toContain("import { rangeValidator, oneOfValidator, rgbValidator } from '@ha-ts-entities/sdk/validate'");
      cleanup();
    });

    it('keys validators by domain.service', () => {
      setup();
      generateTypes(makeRegistryData(), outputDir);
      const content = fs.readFileSync(path.join(outputDir, 'ha-validators.ts'), 'utf-8');

      expect(content).toContain("'light.turn_on'");
      expect(content).toContain("'light.turn_off'");
      cleanup();
    });
  });

  describe('ha-registry-meta.json content', () => {
    it('includes all metadata fields', () => {
      setup();
      generateTypes(makeRegistryData(), outputDir);
      const meta = JSON.parse(
        fs.readFileSync(path.join(outputDir, 'ha-registry-meta.json'), 'utf-8'),
      );

      expect(meta.haVersion).toBe('2024.1.0');
      expect(meta.entityCount).toBe(3);
      expect(meta.serviceCount).toBe(4);
      expect(meta.generatedAt).toBeDefined();
      expect(typeof meta.domainCount).toBe('number');
      expect(typeof meta.areaCount).toBe('number');
      expect(typeof meta.deviceCount).toBe('number');
      expect(typeof meta.labelCount).toBe('number');
      cleanup();
    });
  });

  describe('edge cases', () => {
    it('handles empty registry data', () => {
      setup();
      const data = makeRegistryData({
        services: {},
        states: [],
        entities: [],
        devices: [],
        areas: [],
        labels: [],
      });

      const result = generateTypes(data, outputDir);
      expect(result.success).toBe(true);
      expect(result.entityCount).toBe(0);
      expect(result.serviceCount).toBe(0);

      const content = fs.readFileSync(path.join(outputDir, 'ha-registry.d.ts'), 'utf-8');
      expect(content).toContain('type HAEntityMap = {');
      cleanup();
    });

    it('handles entities with no attributes', () => {
      setup();
      const data = makeRegistryData({
        states: [{
          entity_id: 'sensor.bare',
          state: '42',
          attributes: {},
          last_changed: '2024-01-01T00:00:00Z',
          last_updated: '2024-01-01T00:00:00Z',
        }],
      });

      const result = generateTypes(data, outputDir);
      expect(result.success).toBe(true);
      cleanup();
    });

    it('handles service fields without selectors', () => {
      setup();
      const data = makeRegistryData({
        services: {
          test: {
            do_thing: {
              fields: {
                value: { description: 'A value' },
              },
            },
          },
        },
      });

      const result = generateTypes(data, outputDir);
      expect(result.success).toBe(true);
      cleanup();
    });

    it('escapes special characters in entity IDs', () => {
      setup();
      const data = makeRegistryData({
        states: [{
          entity_id: "sensor.it's_fine",
          state: '0',
          attributes: {},
          last_changed: '2024-01-01T00:00:00Z',
          last_updated: '2024-01-01T00:00:00Z',
        }],
      });

      const result = generateTypes(data, outputDir);
      expect(result.success).toBe(true);

      const content = fs.readFileSync(path.join(outputDir, 'ha-registry.d.ts'), 'utf-8');
      expect(content).toContain("sensor.it\\'s_fine");
      cleanup();
    });
  });

  describe('script service filtering', () => {
    it('only includes generic services and own object_id service per script entity', () => {
      const data = makeRegistryData({
        services: {
          script: {
            reload: { fields: {} },
            turn_on: { fields: {} },
            turn_off: { fields: {} },
            toggle: { fields: {} },
            announce: { fields: { message: { required: true, selector: { text: {} } } } },
            launch_youtube: { fields: { url: { required: false, selector: { text: {} } } } },
          },
        },
        states: [
          {
            entity_id: 'script.announce',
            state: 'off',
            attributes: { friendly_name: 'Announce' },
            last_changed: '', last_updated: '',
          },
          {
            entity_id: 'script.launch_youtube',
            state: 'off',
            attributes: { friendly_name: 'Launch YouTube' },
            last_changed: '', last_updated: '',
          },
        ],
      });

      setup();
      const result = generateTypes(data, outputDir);
      expect(result.success).toBe(true);

      const content = fs.readFileSync(path.join(outputDir, 'ha-registry.d.ts'), 'utf-8');

      // script.announce should have reload, turn_on, turn_off, toggle, announce
      // but NOT launch_youtube
      const announceMatch = content.match(/'script\.announce':\s*\{[\s\S]*?services:\s*\{([\s\S]*?)\};\s*\};/);
      expect(announceMatch).toBeTruthy();
      const announceServices = announceMatch![1];
      expect(announceServices).toContain('announce:');
      expect(announceServices).toContain('turn_on:');
      expect(announceServices).not.toContain('launch_youtube:');

      // script.launch_youtube should have generic + launch_youtube but NOT announce
      const ytMatch = content.match(/'script\.launch_youtube':\s*\{[\s\S]*?services:\s*\{([\s\S]*?)\};\s*\};/);
      expect(ytMatch).toBeTruthy();
      const ytServices = ytMatch![1];
      expect(ytServices).toContain('launch_youtube:');
      expect(ytServices).toContain('turn_on:');
      expect(ytServices).not.toContain('announce:');

      cleanup();  // uses outer cleanup()
    });
  });
});
