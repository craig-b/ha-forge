import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock mqtt module (same pattern as mqtt-transport.test.ts)
vi.mock('mqtt', () => {
  const mockClient = {
    on: vi.fn(),
    publish: vi.fn((_t: string, _p: string, _o: unknown, cb?: (err?: Error) => void) => cb?.()),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    end: vi.fn((_f: boolean, _o: unknown, cb: () => void) => cb()),
    connected: true,
  };
  return {
    default: {
      connect: vi.fn(() => {
        setTimeout(() => {
          const connectHandler = mockClient.on.mock.calls.find(
            (c: unknown[]) => c[0] === 'connect',
          )?.[1] as (() => void) | undefined;
          connectHandler?.();
        }, 0);
        return mockClient;
      }),
    },
    __mockClient: mockClient,
  };
});

type MockClient = {
  on: ReturnType<typeof vi.fn>;
  publish: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
  connected: boolean;
};

async function getMockClient(): Promise<MockClient> {
  const mqttModule = await import('mqtt');
  return (mqttModule as unknown as { __mockClient: MockClient }).__mockClient;
}

describe('MqttTransport — per-entity availability', () => {
  let transport: import('../mqtt-transport.js').MqttTransport;

  beforeEach(async () => {
    const client = await getMockClient();
    client.publish.mockClear();
    client.on.mockClear();

    const { MqttTransport } = await import('../mqtt-transport.js');
    transport = new MqttTransport({
      credentials: { host: 'localhost', port: 1883, username: 'test', password: 'test' },
      maxFailuresBeforeUnavailable: 3,
    });
    await transport.connect();
  });

  it('marks entity unavailable after N consecutive failures', async () => {
    expect(transport.isEntityAvailable('sensor.temp')).toBe(true);

    transport.recordEntityFailure('sensor.temp');
    transport.recordEntityFailure('sensor.temp');
    expect(transport.isEntityAvailable('sensor.temp')).toBe(true); // only 2 failures

    transport.recordEntityFailure('sensor.temp'); // 3rd failure
    expect(transport.isEntityAvailable('sensor.temp')).toBe(false);

    // Check that offline was published
    const client = await getMockClient();
    const offlineCall = client.publish.mock.calls.find(
      (c: unknown[]) => c[0] === 'ha-forge/sensor.temp/availability' && c[1] === 'offline',
    );
    expect(offlineCall).toBeDefined();
  });

  it('clears failure count and marks available again', async () => {
    transport.recordEntityFailure('sensor.temp');
    transport.recordEntityFailure('sensor.temp');
    transport.recordEntityFailure('sensor.temp');
    expect(transport.isEntityAvailable('sensor.temp')).toBe(false);

    transport.clearEntityFailure('sensor.temp');
    expect(transport.isEntityAvailable('sensor.temp')).toBe(true);

    // Check that online was published
    const client = await getMockClient();
    const onlineCall = client.publish.mock.calls.find(
      (c: unknown[]) => c[0] === 'ha-forge/sensor.temp/availability' && c[1] === 'online',
    );
    expect(onlineCall).toBeDefined();
  });

  it('does not publish online if entity was already available', async () => {
    const client = await getMockClient();
    const beforeCount = client.publish.mock.calls.length;

    transport.clearEntityFailure('sensor.new');

    // Should not have published availability (it was already available)
    const availabilityCalls = client.publish.mock.calls
      .slice(beforeCount)
      .filter((c: unknown[]) => (c[0] as string).includes('availability'));
    expect(availabilityCalls).toHaveLength(0);
  });
});
