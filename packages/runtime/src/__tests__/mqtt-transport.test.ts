import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  SensorDefinition,
  BinarySensorDefinition,
  SwitchDefinition,
  LightDefinition,
  CoverDefinition,
  ClimateDefinition,
} from '@ha-forge/sdk';
import type { ResolvedEntity } from '@ha-forge/sdk/internal';

// Mock mqtt module
vi.mock('mqtt', () => {
  const mockClient = {
    on: vi.fn(),
    publish: vi.fn((_topic: string, _payload: string, _opts: unknown, cb?: (err?: Error) => void) => {
      cb?.();
    }),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    end: vi.fn((_force: boolean, _opts: unknown, cb: () => void) => cb()),
    connected: true,
  };
  return {
    default: {
      connect: vi.fn(() => {
        // Simulate async connect
        setTimeout(() => {
          const connectHandler = mockClient.on.mock.calls.find(
            (c: unknown[]) => c[0] === 'connect'
          )?.[1] as (() => void) | undefined;
          connectHandler?.();
        }, 0);
        return mockClient;
      }),
    },
    __mockClient: mockClient,
  };
});

// Type helper matching the shape of the shared mock client
type MockClient = {
  on: ReturnType<typeof vi.fn>;
  publish: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
  unsubscribe: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  connected: boolean;
};

// Helper to get the mock client
async function getMockClient(): Promise<MockClient> {
  const mqttModule = await import('mqtt');
  return (mqttModule as unknown as { __mockClient: MockClient }).__mockClient;
}

// Helper to create a connected MqttTransport
async function createConnectedTransport() {
  const { MqttTransport } = await import('../mqtt-transport.js');
  const transport = new MqttTransport({
    credentials: {
      host: 'localhost',
      port: 1883,
      username: 'test',
      password: 'test',
    },
  });
  await transport.connect();
  return transport;
}

// Fixture: sensor entity
function makeSensorEntity(overrides?: Partial<SensorDefinition>): ResolvedEntity {
  const definition: SensorDefinition = {
    id: 'my_sensor',
    name: 'My Sensor',
    type: 'sensor',
    config: {
      device_class: 'temperature',
      unit_of_measurement: '°C',
      state_class: 'measurement',
      suggested_display_precision: 1,
    },
    ...overrides,
  };
  return {
    definition,
    sourceFile: '/scripts/sensors.ts',
    deviceId: 'sensors',
  };
}

// Fixture: binary sensor entity
function makeBinarySensorEntity(overrides?: Partial<BinarySensorDefinition>): ResolvedEntity {
  const definition: BinarySensorDefinition = {
    id: 'motion_sensor',
    name: 'Motion Sensor',
    type: 'binary_sensor',
    config: {
      device_class: 'motion',
    },
    ...overrides,
  };
  return {
    definition,
    sourceFile: '/scripts/sensors.ts',
    deviceId: 'sensors',
  };
}

// Fixture: switch entity
function makeSwitchEntity(overrides?: Partial<SwitchDefinition>): ResolvedEntity {
  const definition: SwitchDefinition = {
    id: 'my_switch',
    name: 'My Switch',
    type: 'switch',
    config: {
      device_class: 'outlet',
    },
    onCommand: vi.fn(),
    ...overrides,
  };
  return {
    definition,
    sourceFile: '/scripts/switches.ts',
    deviceId: 'switches',
  };
}

// Fixture: light entity
function makeLightEntity(overrides?: Partial<LightDefinition>): ResolvedEntity {
  const definition: LightDefinition = {
    id: 'desk_light',
    name: 'Desk Light',
    type: 'light',
    config: {
      supported_color_modes: ['rgb', 'brightness'],
      effect_list: ['rainbow', 'breathe'],
    },
    onCommand: vi.fn(),
    ...overrides,
  };
  return {
    definition,
    sourceFile: '/scripts/lights.ts',
    deviceId: 'lights',
  };
}

// Fixture: cover entity
function makeCoverEntity(overrides?: Partial<CoverDefinition>): ResolvedEntity {
  const definition: CoverDefinition = {
    id: 'garage_door',
    name: 'Garage Door',
    type: 'cover',
    config: {
      device_class: 'garage',
      position: true,
      tilt: false,
    },
    onCommand: vi.fn(),
    ...overrides,
  };
  return {
    definition,
    sourceFile: '/scripts/covers.ts',
    deviceId: 'covers',
  };
}

// Fixture: climate entity
function makeClimateEntity(overrides?: Partial<ClimateDefinition>): ResolvedEntity {
  const definition: ClimateDefinition = {
    id: 'bedroom_hvac',
    name: 'Bedroom HVAC',
    type: 'climate',
    config: {
      hvac_modes: ['off', 'heat', 'cool', 'auto'],
      min_temp: 16,
      max_temp: 30,
      temp_step: 0.5,
      fan_modes: ['low', 'medium', 'high'],
      preset_modes: ['eco', 'comfort'],
    },
    onCommand: vi.fn(),
    ...overrides,
  };
  return {
    definition,
    sourceFile: '/scripts/climate.ts',
    deviceId: 'climate',
  };
}

// Helper to extract component config from mock publish calls
function getComponentConfig(mockClient: MockClient, entityId: string): Record<string, unknown> {
  const discoveryCalls = mockClient.publish.mock.calls.filter(
    (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).startsWith('homeassistant/device/')
  );
  const [, payloadStr] = discoveryCalls[discoveryCalls.length - 1] as [string, string];
  const payload = JSON.parse(payloadStr) as Record<string, unknown>;
  const cmps = payload.cmps as Record<string, Record<string, unknown>>;
  return cmps[entityId];
}

describe('MqttTransport', () => {
  beforeEach(async () => {
    // Clear mock call history between tests (do NOT reset modules —
    // that would invalidate the vi.mock() factory applied at module load time)
    const mockClient = await getMockClient();
    mockClient.on.mockClear();
    mockClient.publish.mockClear();
    mockClient.subscribe.mockClear();
    mockClient.unsubscribe.mockClear();
    mockClient.end.mockClear();
  });

  describe('supports()', () => {
    it('returns true for all MQTT-supported entity types', async () => {
      const { MqttTransport } = await import('../mqtt-transport.js');
      const transport = new MqttTransport({
        credentials: { host: 'localhost', port: 1883, username: 'u', password: 'p' },
      });

      const supportedTypes = [
        'sensor', 'binary_sensor', 'switch', 'light', 'cover', 'climate',
        'fan', 'lock', 'humidifier', 'valve', 'water_heater', 'vacuum',
        'lawn_mower', 'siren', 'number', 'select', 'text', 'button',
        'scene', 'event', 'device_tracker', 'camera', 'alarm_control_panel',
        'notify', 'update', 'image',
      ] as const;

      for (const type of supportedTypes) {
        expect(transport.supports(type)).toBe(true);
      }
    });
  });

  describe('register() — sensor component config', () => {
    it('publishes discovery with correct abbreviated sensor keys', async () => {
      const transport = await createConnectedTransport();
      const mockClient = await getMockClient();
      const entity = makeSensorEntity();

      await transport.register(entity);

      // Find the discovery publish call
      const discoveryCalls = mockClient.publish.mock.calls.filter(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).startsWith('homeassistant/device/')
      );
      expect(discoveryCalls.length).toBeGreaterThan(0);

      const [topic, payloadStr] = discoveryCalls[discoveryCalls.length - 1] as [string, string];
      expect(topic).toBe('homeassistant/device/sensors/config');

      const payload = JSON.parse(payloadStr) as Record<string, unknown>;
      const cmps = payload.cmps as Record<string, Record<string, unknown>>;
      const comp = cmps['my_sensor'];

      expect(comp).toBeDefined();
      expect(comp.p).toBe('sensor');
      expect(comp.uniq_id).toBe('ha_forge_my_sensor');
      expect(comp.name).toBe('My Sensor');
      expect(comp.stat_t).toBe('ha-forge/my_sensor/state');
      expect(comp.dev_cla).toBe('temperature');
      expect(comp.unit_of_meas).toBe('°C');
      expect(comp.stat_cla).toBe('measurement');
      expect(comp.sug_dsp_prc).toBe(1);
    });

    it('sensor component has no cmd_t (read-only)', async () => {
      const transport = await createConnectedTransport();
      const mockClient = await getMockClient();
      const entity = makeSensorEntity();

      await transport.register(entity);

      const discoveryCalls = mockClient.publish.mock.calls.filter(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).startsWith('homeassistant/device/')
      );
      const [, payloadStr] = discoveryCalls[discoveryCalls.length - 1] as [string, string];
      const payload = JSON.parse(payloadStr) as Record<string, unknown>;
      const cmps = payload.cmps as Record<string, Record<string, unknown>>;

      expect(cmps['my_sensor'].cmd_t).toBeUndefined();
    });
  });

  describe('register() — discovery payload structure', () => {
    it('wraps components in correct top-level discovery envelope', async () => {
      const transport = await createConnectedTransport();
      const mockClient = await getMockClient();
      const entity = makeSensorEntity();

      await transport.register(entity);

      const discoveryCalls = mockClient.publish.mock.calls.filter(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).startsWith('homeassistant/device/')
      );
      const [, payloadStr] = discoveryCalls[discoveryCalls.length - 1] as [string, string];
      const payload = JSON.parse(payloadStr) as Record<string, unknown>;

      // Top-level envelope keys
      expect(payload).toHaveProperty('dev');
      expect(payload).toHaveProperty('o');
      expect(payload).toHaveProperty('cmps');
      expect(payload.avty_t).toBe('ha-forge/availability');

      // Origin block
      const o = payload.o as Record<string, unknown>;
      expect(o.name).toBe('ha-forge');
      expect(o.sw).toBe('0.1.0');
    });
  });

  describe('register() — device info from DeviceInfo', () => {
    it('uses explicit DeviceInfo when provided', async () => {
      const transport = await createConnectedTransport();
      const mockClient = await getMockClient();
      const entity = makeSensorEntity({
        device: {
          id: 'weather_station',
          name: 'Weather Station',
          manufacturer: 'Acme',
          model: 'WS-1000',
          sw_version: '2.3.0',
          suggested_area: 'Garden',
        },
      });
      // Override deviceId to match device.id grouping
      entity.deviceId = 'weather_station';

      await transport.register(entity);

      const discoveryCalls = mockClient.publish.mock.calls.filter(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).startsWith('homeassistant/device/')
      );
      const [, payloadStr] = discoveryCalls[discoveryCalls.length - 1] as [string, string];
      const payload = JSON.parse(payloadStr) as Record<string, unknown>;
      const dev = payload.dev as Record<string, unknown>;

      expect(dev.ids).toEqual(['ha_forge_weather_station']);
      expect(dev.name).toBe('Weather Station');
      expect(dev.mf).toBe('Acme');
      expect(dev.mdl).toBe('WS-1000');
      expect(dev.sw).toBe('2.3.0');
      expect(dev.sa).toBe('Garden');
    });
  });

  describe('register() — synthetic device info', () => {
    it('builds synthetic device info from file grouping when no DeviceInfo provided', async () => {
      const transport = await createConnectedTransport();
      const mockClient = await getMockClient();
      const entity = makeSensorEntity({ device: undefined });
      entity.deviceId = 'my_script_group';

      await transport.register(entity);

      const discoveryCalls = mockClient.publish.mock.calls.filter(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).startsWith('homeassistant/device/')
      );
      const [, payloadStr] = discoveryCalls[discoveryCalls.length - 1] as [string, string];
      const payload = JSON.parse(payloadStr) as Record<string, unknown>;
      const dev = payload.dev as Record<string, unknown>;

      expect(dev.ids).toEqual(['ha_forge_my_script_group']);
      expect(dev.name).toBe('my_script_group');
      expect(dev.mf).toBe('ha-forge');
      expect(dev.mdl).toBe('User Script');
    });
  });

  describe('register() — switch command topic', () => {
    it('includes cmd_t for bidirectional entities like switch', async () => {
      const transport = await createConnectedTransport();
      const mockClient = await getMockClient();
      const entity = makeSwitchEntity();

      await transport.register(entity);

      const discoveryCalls = mockClient.publish.mock.calls.filter(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).startsWith('homeassistant/device/')
      );
      const [, payloadStr] = discoveryCalls[discoveryCalls.length - 1] as [string, string];
      const payload = JSON.parse(payloadStr) as Record<string, unknown>;
      const cmps = payload.cmps as Record<string, Record<string, unknown>>;

      expect(cmps['my_switch'].cmd_t).toBe('ha-forge/my_switch/set');
    });

    it('subscribes to command topic for switch entities', async () => {
      const transport = await createConnectedTransport();
      const mockClient = await getMockClient();
      mockClient.subscribe.mockClear();

      const entity = makeSwitchEntity();
      await transport.register(entity);

      const subscribeCalls = (mockClient.subscribe.mock.calls as string[][]).map((c) => c[0]);
      expect(subscribeCalls).toContain('ha-forge/my_switch/set');
    });
  });

  describe('deregister()', () => {
    it('removes entity from device config and re-publishes', async () => {
      const transport = await createConnectedTransport();
      const mockClient = await getMockClient();
      const sensor = makeSensorEntity();
      const binarySensor = makeBinarySensorEntity();
      // Same device group
      binarySensor.deviceId = 'sensors';

      await transport.register(sensor);
      await transport.register(binarySensor);

      mockClient.publish.mockClear();

      await transport.deregister('my_sensor');

      // Should re-publish device config with only the binary sensor remaining
      const discoveryCalls = mockClient.publish.mock.calls.filter(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).startsWith('homeassistant/device/')
      );
      expect(discoveryCalls.length).toBe(1);

      const [, payloadStr] = discoveryCalls[0] as [string, string];
      const payload = JSON.parse(payloadStr) as Record<string, unknown>;
      const cmps = payload.cmps as Record<string, Record<string, unknown>>;

      expect(cmps['my_sensor']).toBeUndefined();
      expect(cmps['motion_sensor']).toBeDefined();
    });

    it('publishes empty retained message when last entity in device is removed', async () => {
      const transport = await createConnectedTransport();
      const mockClient = await getMockClient();
      const entity = makeSensorEntity();

      await transport.register(entity);
      mockClient.publish.mockClear();

      await transport.deregister('my_sensor');

      const discoveryCalls = mockClient.publish.mock.calls.filter(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).startsWith('homeassistant/device/')
      );
      expect(discoveryCalls.length).toBe(1);

      const [topic, payload] = discoveryCalls[0] as [string, string];
      expect(topic).toBe('homeassistant/device/sensors/config');
      expect(payload).toBe('');
    });

    it('unsubscribes from command topic when deregistering a switch', async () => {
      const transport = await createConnectedTransport();
      const mockClient = await getMockClient();
      const entity = makeSwitchEntity();

      await transport.register(entity);
      mockClient.unsubscribe.mockClear();

      await transport.deregister('my_switch');

      const unsubCalls = (mockClient.unsubscribe.mock.calls as string[][]).map((c) => c[0]);
      expect(unsubCalls).toContain('ha-forge/my_switch/set');
    });
  });

  describe('binary_sensor config', () => {
    it('includes dev_cla for binary sensor', async () => {
      const transport = await createConnectedTransport();
      const mockClient = await getMockClient();
      const entity = makeBinarySensorEntity();

      await transport.register(entity);

      const discoveryCalls = mockClient.publish.mock.calls.filter(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).startsWith('homeassistant/device/')
      );
      const [, payloadStr] = discoveryCalls[discoveryCalls.length - 1] as [string, string];
      const payload = JSON.parse(payloadStr) as Record<string, unknown>;
      const cmps = payload.cmps as Record<string, Record<string, unknown>>;

      expect(cmps['motion_sensor'].dev_cla).toBe('motion');
      expect(cmps['motion_sensor'].cmd_t).toBeUndefined();
    });
  });

  describe('optional entity fields', () => {
    it('includes icon and category when provided', async () => {
      const transport = await createConnectedTransport();
      const mockClient = await getMockClient();
      const entity = makeSensorEntity({
        icon: 'mdi:thermometer',
        category: 'diagnostic',
      });

      await transport.register(entity);

      const discoveryCalls = mockClient.publish.mock.calls.filter(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).startsWith('homeassistant/device/')
      );
      const [, payloadStr] = discoveryCalls[discoveryCalls.length - 1] as [string, string];
      const payload = JSON.parse(payloadStr) as Record<string, unknown>;
      const cmps = payload.cmps as Record<string, Record<string, unknown>>;

      expect(cmps['my_sensor'].ic).toBe('mdi:thermometer');
      expect(cmps['my_sensor'].ent_cat).toBe('diagnostic');
    });
  });

  describe('register() — light discovery config', () => {
    it('uses JSON schema and includes color mode config', async () => {
      const transport = await createConnectedTransport();
      const mockClient = await getMockClient();
      const entity = makeLightEntity();

      await transport.register(entity);

      const comp = getComponentConfig(mockClient, 'desk_light');
      expect(comp.p).toBe('light');
      expect(comp.schema).toBe('json');
      expect(comp.brightness).toBe(true);
      expect(comp.sup_clrm).toEqual(['rgb', 'brightness']);
      expect(comp.fx_list).toEqual(['rainbow', 'breathe']);
      expect(comp.cmd_t).toBe('ha-forge/desk_light/set');
      expect(comp.stat_t).toBe('ha-forge/desk_light/state');
    });

    it('sets color temp Kelvin fields when color_temp mode is supported', async () => {
      const transport = await createConnectedTransport();
      const mockClient = await getMockClient();
      const entity = makeLightEntity({
        id: 'ct_light',
        name: 'CT Light',
        config: {
          supported_color_modes: ['color_temp'],
          min_color_temp_kelvin: 2700,
          max_color_temp_kelvin: 6500,
        },
      });

      await transport.register(entity);

      const comp = getComponentConfig(mockClient, 'ct_light');
      expect(comp.min_klv).toBe(2700);
      expect(comp.max_klv).toBe(6500);
      expect(comp.clr_temp_klv).toBe(true);
    });

    it('brightness is false for onoff-only lights', async () => {
      const transport = await createConnectedTransport();
      const mockClient = await getMockClient();
      const entity = makeLightEntity({
        id: 'simple_light',
        name: 'Simple Light',
        config: { supported_color_modes: ['onoff'] },
      });

      await transport.register(entity);

      const comp = getComponentConfig(mockClient, 'simple_light');
      expect(comp.brightness).toBe(false);
    });

    it('subscribes to command topic for light entities', async () => {
      const transport = await createConnectedTransport();
      const mockClient = await getMockClient();
      mockClient.subscribe.mockClear();

      await transport.register(makeLightEntity());

      const subscribeCalls = (mockClient.subscribe.mock.calls as string[][]).map((c) => c[0]);
      expect(subscribeCalls).toContain('ha-forge/desk_light/set');
    });
  });

  describe('register() — cover discovery config', () => {
    it('includes position topics when position is enabled', async () => {
      const transport = await createConnectedTransport();
      const mockClient = await getMockClient();
      const entity = makeCoverEntity();

      await transport.register(entity);

      const comp = getComponentConfig(mockClient, 'garage_door');
      expect(comp.p).toBe('cover');
      expect(comp.dev_cla).toBe('garage');
      expect(comp.pl_open).toBe('OPEN');
      expect(comp.pl_cls).toBe('CLOSE');
      expect(comp.pl_stop).toBe('STOP');
      expect(comp.stat_open).toBe('open');
      expect(comp.stat_clsd).toBe('closed');
      expect(comp.pos_t).toBe('ha-forge/garage_door/position');
      expect(comp.set_pos_t).toBe('ha-forge/garage_door/position/set');
      expect(comp.pos_open).toBe(100);
      expect(comp.pos_clsd).toBe(0);
    });

    it('includes tilt topics when tilt is enabled', async () => {
      const transport = await createConnectedTransport();
      const mockClient = await getMockClient();
      const entity = makeCoverEntity({
        id: 'tilt_blind',
        name: 'Tilt Blind',
        config: { device_class: 'blind', position: true, tilt: true },
      });

      await transport.register(entity);

      const comp = getComponentConfig(mockClient, 'tilt_blind');
      expect(comp.tilt_cmd_t).toBe('ha-forge/tilt_blind/tilt/set');
      expect(comp.tilt_status_t).toBe('ha-forge/tilt_blind/tilt');
    });

    it('omits position/tilt topics when not enabled', async () => {
      const transport = await createConnectedTransport();
      const mockClient = await getMockClient();
      const entity = makeCoverEntity({
        id: 'simple_cover',
        name: 'Simple Cover',
        config: { device_class: 'curtain', position: false, tilt: false },
      });

      await transport.register(entity);

      const comp = getComponentConfig(mockClient, 'simple_cover');
      expect(comp.pos_t).toBeUndefined();
      expect(comp.set_pos_t).toBeUndefined();
      expect(comp.tilt_cmd_t).toBeUndefined();
    });

    it('subscribes to position/set topic when position is enabled', async () => {
      const transport = await createConnectedTransport();
      const mockClient = await getMockClient();
      mockClient.subscribe.mockClear();

      await transport.register(makeCoverEntity());

      const subscribeCalls = (mockClient.subscribe.mock.calls as string[][]).map((c) => c[0]);
      expect(subscribeCalls).toContain('ha-forge/garage_door/set');
      expect(subscribeCalls).toContain('ha-forge/garage_door/position/set');
    });
  });

  describe('register() — climate discovery config', () => {
    it('includes per-feature topics and mode arrays', async () => {
      const transport = await createConnectedTransport();
      const mockClient = await getMockClient();
      const entity = makeClimateEntity();

      await transport.register(entity);

      const comp = getComponentConfig(mockClient, 'bedroom_hvac');
      expect(comp.p).toBe('climate');

      // Climate should NOT have a generic cmd_t
      expect(comp.cmd_t).toBeUndefined();

      // Mode topics
      expect(comp.mode_cmd_t).toBe('ha-forge/bedroom_hvac/mode/set');
      expect(comp.mode_stat_t).toBe('ha-forge/bedroom_hvac/mode/state');
      expect(comp.modes).toEqual(['off', 'heat', 'cool', 'auto']);

      // Temperature topics
      expect(comp.temp_cmd_t).toBe('ha-forge/bedroom_hvac/temperature/set');
      expect(comp.temp_stat_t).toBe('ha-forge/bedroom_hvac/temperature/state');
      expect(comp.curr_temp_t).toBe('ha-forge/bedroom_hvac/current_temperature');

      // Temp constraints
      expect(comp.min_temp).toBe(16);
      expect(comp.max_temp).toBe(30);
      expect(comp.temp_step).toBe(0.5);
    });

    it('includes fan mode topics when fan_modes configured', async () => {
      const transport = await createConnectedTransport();
      const mockClient = await getMockClient();

      await transport.register(makeClimateEntity());

      const comp = getComponentConfig(mockClient, 'bedroom_hvac');
      expect(comp.fan_mode_cmd_t).toBe('ha-forge/bedroom_hvac/fan_mode/set');
      expect(comp.fan_mode_stat_t).toBe('ha-forge/bedroom_hvac/fan_mode/state');
      expect(comp.fan_modes).toEqual(['low', 'medium', 'high']);
    });

    it('includes preset mode topics when preset_modes configured', async () => {
      const transport = await createConnectedTransport();
      const mockClient = await getMockClient();

      await transport.register(makeClimateEntity());

      const comp = getComponentConfig(mockClient, 'bedroom_hvac');
      expect(comp.pr_mode_cmd_t).toBe('ha-forge/bedroom_hvac/preset_mode/set');
      expect(comp.pr_mode_stat_t).toBe('ha-forge/bedroom_hvac/preset_mode/state');
      expect(comp.pr_modes).toEqual(['eco', 'comfort']);
    });

    it('omits fan/preset/swing topics when not configured', async () => {
      const transport = await createConnectedTransport();
      const mockClient = await getMockClient();
      const entity = makeClimateEntity({
        id: 'simple_hvac',
        name: 'Simple',
        config: { hvac_modes: ['off', 'heat'] },
      });

      await transport.register(entity);

      const comp = getComponentConfig(mockClient, 'simple_hvac');
      expect(comp.fan_mode_cmd_t).toBeUndefined();
      expect(comp.swing_mode_cmd_t).toBeUndefined();
      expect(comp.pr_mode_cmd_t).toBeUndefined();
    });

    it('includes action topic', async () => {
      const transport = await createConnectedTransport();
      const mockClient = await getMockClient();

      await transport.register(makeClimateEntity());

      const comp = getComponentConfig(mockClient, 'bedroom_hvac');
      expect(comp.act_t).toBe('ha-forge/bedroom_hvac/action');
    });

    it('subscribes to all climate command topics', async () => {
      const transport = await createConnectedTransport();
      const mockClient = await getMockClient();
      mockClient.subscribe.mockClear();

      await transport.register(makeClimateEntity());

      const subscribeCalls = (mockClient.subscribe.mock.calls as string[][]).map((c) => c[0]);
      expect(subscribeCalls).toContain('ha-forge/bedroom_hvac/mode/set');
      expect(subscribeCalls).toContain('ha-forge/bedroom_hvac/temperature/set');
      expect(subscribeCalls).toContain('ha-forge/bedroom_hvac/temperature_high/set');
      expect(subscribeCalls).toContain('ha-forge/bedroom_hvac/temperature_low/set');
      expect(subscribeCalls).toContain('ha-forge/bedroom_hvac/fan_mode/set');
      expect(subscribeCalls).toContain('ha-forge/bedroom_hvac/preset_mode/set');
    });
  });

  describe('command dispatch', () => {
    it('dispatches light JSON command to handler', async () => {
      const transport = await createConnectedTransport();
      const mockClient = await getMockClient();
      const handler = vi.fn();
      const entity = makeLightEntity();

      await transport.register(entity);
      transport.onCommand('desk_light', handler);

      // Simulate incoming message
      const messageHandler = mockClient.on.mock.calls.find(
        (c: unknown[]) => c[0] === 'message'
      )?.[1] as (topic: string, payload: Buffer) => void;

      const lightCmd = { state: 'ON', brightness: 128, color: { r: 255, g: 0, b: 0 } };
      messageHandler('ha-forge/desk_light/set', Buffer.from(JSON.stringify(lightCmd)));

      expect(handler).toHaveBeenCalledWith(lightCmd);
    });

    it('dispatches cover OPEN/CLOSE/STOP as string commands', async () => {
      const transport = await createConnectedTransport();
      const mockClient = await getMockClient();
      const handler = vi.fn();
      const entity = makeCoverEntity();

      await transport.register(entity);
      transport.onCommand('garage_door', handler);

      const messageHandler = mockClient.on.mock.calls.find(
        (c: unknown[]) => c[0] === 'message'
      )?.[1] as (topic: string, payload: Buffer) => void;

      messageHandler('ha-forge/garage_door/set', Buffer.from('OPEN'));
      expect(handler).toHaveBeenCalledWith('OPEN');
    });

    it('dispatches cover position/set as set_position command', async () => {
      const transport = await createConnectedTransport();
      const mockClient = await getMockClient();
      const handler = vi.fn();
      const entity = makeCoverEntity();

      await transport.register(entity);
      transport.onCommand('garage_door', handler);

      const messageHandler = mockClient.on.mock.calls.find(
        (c: unknown[]) => c[0] === 'message'
      )?.[1] as (topic: string, payload: Buffer) => void;

      messageHandler('ha-forge/garage_door/position/set', Buffer.from('75'));
      expect(handler).toHaveBeenCalledWith({ action: 'set_position', position: 75 });
    });

    it('dispatches cover tilt/set as set_tilt command', async () => {
      const transport = await createConnectedTransport();
      const mockClient = await getMockClient();
      const handler = vi.fn();
      const entity = makeCoverEntity({
        id: 'tilt_blind',
        name: 'Tilt Blind',
        config: { device_class: 'blind', position: true, tilt: true },
      });

      await transport.register(entity);
      transport.onCommand('tilt_blind', handler);

      const messageHandler = mockClient.on.mock.calls.find(
        (c: unknown[]) => c[0] === 'message'
      )?.[1] as (topic: string, payload: Buffer) => void;

      messageHandler('ha-forge/tilt_blind/tilt/set', Buffer.from('45'));
      expect(handler).toHaveBeenCalledWith({ action: 'set_tilt', tilt: 45 });
    });

    it('dispatches climate mode/set as hvac_mode command', async () => {
      const transport = await createConnectedTransport();
      const mockClient = await getMockClient();
      const handler = vi.fn();

      await transport.register(makeClimateEntity());
      transport.onCommand('bedroom_hvac', handler);

      const messageHandler = mockClient.on.mock.calls.find(
        (c: unknown[]) => c[0] === 'message'
      )?.[1] as (topic: string, payload: Buffer) => void;

      messageHandler('ha-forge/bedroom_hvac/mode/set', Buffer.from('heat'));
      expect(handler).toHaveBeenCalledWith({ hvac_mode: 'heat' });
    });

    it('dispatches climate temperature/set as numeric temperature command', async () => {
      const transport = await createConnectedTransport();
      const mockClient = await getMockClient();
      const handler = vi.fn();

      await transport.register(makeClimateEntity());
      transport.onCommand('bedroom_hvac', handler);

      const messageHandler = mockClient.on.mock.calls.find(
        (c: unknown[]) => c[0] === 'message'
      )?.[1] as (topic: string, payload: Buffer) => void;

      messageHandler('ha-forge/bedroom_hvac/temperature/set', Buffer.from('22.5'));
      expect(handler).toHaveBeenCalledWith({ temperature: 22.5 });
    });

    it('dispatches climate fan_mode/set as fan_mode command', async () => {
      const transport = await createConnectedTransport();
      const mockClient = await getMockClient();
      const handler = vi.fn();

      await transport.register(makeClimateEntity());
      transport.onCommand('bedroom_hvac', handler);

      const messageHandler = mockClient.on.mock.calls.find(
        (c: unknown[]) => c[0] === 'message'
      )?.[1] as (topic: string, payload: Buffer) => void;

      messageHandler('ha-forge/bedroom_hvac/fan_mode/set', Buffer.from('high'));
      expect(handler).toHaveBeenCalledWith({ fan_mode: 'high' });
    });

    it('dispatches climate temperature_high/set as target_temp_high command', async () => {
      const transport = await createConnectedTransport();
      const mockClient = await getMockClient();
      const handler = vi.fn();

      await transport.register(makeClimateEntity());
      transport.onCommand('bedroom_hvac', handler);

      const messageHandler = mockClient.on.mock.calls.find(
        (c: unknown[]) => c[0] === 'message'
      )?.[1] as (topic: string, payload: Buffer) => void;

      messageHandler('ha-forge/bedroom_hvac/temperature_high/set', Buffer.from('25'));
      expect(handler).toHaveBeenCalledWith({ target_temp_high: 25 });
    });
  });

  describe('deregister() — bidirectional entities', () => {
    it('unsubscribes from cover position/set when deregistering', async () => {
      const transport = await createConnectedTransport();
      const mockClient = await getMockClient();
      const entity = makeCoverEntity();

      await transport.register(entity);
      mockClient.unsubscribe.mockClear();

      await transport.deregister('garage_door');

      const unsubCalls = (mockClient.unsubscribe.mock.calls as string[][]).map((c) => c[0]);
      expect(unsubCalls).toContain('ha-forge/garage_door/set');
      expect(unsubCalls).toContain('ha-forge/garage_door/position/set');
    });

    it('unsubscribes from all climate command topics when deregistering', async () => {
      const transport = await createConnectedTransport();
      const mockClient = await getMockClient();

      await transport.register(makeClimateEntity());
      mockClient.unsubscribe.mockClear();

      await transport.deregister('bedroom_hvac');

      const unsubCalls = (mockClient.unsubscribe.mock.calls as string[][]).map((c) => c[0]);
      expect(unsubCalls).toContain('ha-forge/bedroom_hvac/mode/set');
      expect(unsubCalls).toContain('ha-forge/bedroom_hvac/temperature/set');
      expect(unsubCalls).toContain('ha-forge/bedroom_hvac/temperature_high/set');
      expect(unsubCalls).toContain('ha-forge/bedroom_hvac/temperature_low/set');
      expect(unsubCalls).toContain('ha-forge/bedroom_hvac/fan_mode/set');
      expect(unsubCalls).toContain('ha-forge/bedroom_hvac/preset_mode/set');
    });
  });

  describe('publishState() — complex entities', () => {
    it('publishes light state as JSON', async () => {
      const transport = await createConnectedTransport();
      const mockClient = await getMockClient();
      const entity = makeLightEntity();

      await transport.register(entity);
      mockClient.publish.mockClear();

      const lightState = { state: 'on', brightness: 200, color_mode: 'rgb', rgb_color: [255, 0, 0] };
      await transport.publishState('desk_light', lightState);

      const stateCalls = mockClient.publish.mock.calls.filter(
        (c: unknown[]) => c[0] === 'ha-forge/desk_light/state'
      );
      expect(stateCalls.length).toBe(1);
      expect(JSON.parse(stateCalls[0][1] as string)).toEqual(lightState);
    });

    it('publishes climate state to main and per-feature topics', async () => {
      const transport = await createConnectedTransport();
      const mockClient = await getMockClient();

      await transport.register(makeClimateEntity());
      mockClient.publish.mockClear();

      const climateState = {
        mode: 'heat',
        temperature: 22,
        current_temperature: 20.5,
        fan_mode: 'low',
        action: 'heating',
      };
      await transport.publishState('bedroom_hvac', climateState);

      // Main state topic
      const mainCalls = mockClient.publish.mock.calls.filter(
        (c: unknown[]) => c[0] === 'ha-forge/bedroom_hvac/state'
      );
      expect(mainCalls.length).toBe(1);
      expect(JSON.parse(mainCalls[0][1] as string)).toEqual(climateState);

      // Per-feature topics
      const getPayload = (topic: string) => {
        const call = mockClient.publish.mock.calls.find((c: unknown[]) => c[0] === topic);
        return call ? (call[1] as string) : undefined;
      };

      expect(getPayload('ha-forge/bedroom_hvac/mode/state')).toBe('heat');
      expect(getPayload('ha-forge/bedroom_hvac/temperature/state')).toBe('22');
      expect(getPayload('ha-forge/bedroom_hvac/current_temperature')).toBe('20.5');
      expect(getPayload('ha-forge/bedroom_hvac/fan_mode/state')).toBe('low');
      expect(getPayload('ha-forge/bedroom_hvac/action')).toBe('heating');
    });
  });
});
