import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ResolvedEntity, SensorDefinition, BinarySensorDefinition, SwitchDefinition } from '@ha-ts-entities/sdk';

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
      expect(comp.uniq_id).toBe('ts_entities_my_sensor');
      expect(comp.name).toBe('My Sensor');
      expect(comp.stat_t).toBe('ts-entities/my_sensor/state');
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
      expect(payload.avty_t).toBe('ts-entities/availability');

      // Origin block
      const o = payload.o as Record<string, unknown>;
      expect(o.name).toBe('ts-entities');
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

      expect(dev.ids).toEqual(['ts_entities_weather_station']);
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

      expect(dev.ids).toEqual(['ts_entities_my_script_group']);
      expect(dev.name).toBe('my_script_group');
      expect(dev.mf).toBe('ts-entities');
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

      expect(cmps['my_switch'].cmd_t).toBe('ts-entities/my_switch/set');
    });

    it('subscribes to command topic for switch entities', async () => {
      const transport = await createConnectedTransport();
      const mockClient = await getMockClient();
      mockClient.subscribe.mockClear();

      const entity = makeSwitchEntity();
      await transport.register(entity);

      const subscribeCalls = (mockClient.subscribe.mock.calls as string[][]).map((c) => c[0]);
      expect(subscribeCalls).toContain('ts-entities/my_switch/set');
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
      expect(unsubCalls).toContain('ts-entities/my_switch/set');
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
});
