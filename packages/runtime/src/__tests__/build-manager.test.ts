import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BuildManager } from '../build-manager.js';
import type { Transport } from '../transport.js';
import type { LifecycleLogger } from '../lifecycle.js';

function createMockTransport(): Transport {
  return {
    supports: vi.fn(() => true),
    register: vi.fn(async () => {}),
    publishState: vi.fn(async () => {}),
    deregister: vi.fn(async () => {}),
    onCommand: vi.fn(),
  };
}

function createMockLogger(): LifecycleLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe('BuildManager', () => {
  let tmpDir: string;
  let bundleDir: string;
  let transport: Transport;
  let logger: LifecycleLogger;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-mgr-test-'));
    bundleDir = path.join(tmpDir, 'bundles');
    fs.mkdirSync(bundleDir, { recursive: true });
    transport = createMockTransport();
    logger = createMockLogger();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeBundleFile(name: string, content: string): void {
    fs.writeFileSync(path.join(bundleDir, name), content, 'utf-8');
  }

  it('deploys entities from bundled JS files', async () => {
    writeBundleFile('sensors.js', `
      export const temp = {
        id: 'sensor.temperature',
        name: 'Temperature',
        type: 'sensor',
        device_class: 'temperature',
        unit_of_measurement: '°C',
        init() { return 22.5; },
      };
    `);

    const manager = new BuildManager({
      bundleDir,
      transport,
      logger,
    });

    const result = await manager.deploy();

    expect(result.success).toBe(true);
    expect(result.entityCount).toBe(1);
    expect(result.errors).toHaveLength(0);
    expect(transport.register).toHaveBeenCalled();
  });

  it('handles empty bundle directory', async () => {
    const manager = new BuildManager({
      bundleDir,
      transport,
      logger,
    });

    const result = await manager.deploy();

    expect(result.success).toBe(true);
    expect(result.entityCount).toBe(0);
  });

  it('isolates failures per file', async () => {
    // Good file
    writeBundleFile('good.js', `
      export const sensor1 = {
        id: 'sensor.good',
        name: 'Good Sensor',
        type: 'sensor',
        device_class: 'temperature',
        unit_of_measurement: '°C',
      };
    `);

    // Bad file — syntax error
    writeBundleFile('bad.js', `
      export const invalid = syntax error here!!!
    `);

    const manager = new BuildManager({
      bundleDir,
      transport,
      logger,
    });

    const result = await manager.deploy();

    // Should have loaded and deployed the good file's entity
    // The bad file produces a load error
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => e.file.includes('bad.js'))).toBe(true);

    // Logger should have recorded the error
    expect(logger.error).toHaveBeenCalled();
  });

  it('tears down existing entities on redeploy', async () => {
    writeBundleFile('v1.js', `
      export const sensor = {
        id: 'sensor.temp',
        name: 'Temp',
        type: 'sensor',
        device_class: 'temperature',
        unit_of_measurement: '°C',
      };
    `);

    const manager = new BuildManager({
      bundleDir,
      transport,
      logger,
    });

    // First deploy
    await manager.deploy();
    expect(transport.register).toHaveBeenCalledTimes(1);

    // Second deploy — should teardown first
    await manager.deploy();
    expect(transport.deregister).toHaveBeenCalled();
  });

  it('reports deployed entity count accurately with multi-file', async () => {
    writeBundleFile('file1.js', `
      export const s1 = {
        id: 'sensor.one',
        name: 'One',
        type: 'sensor',
        device_class: 'temperature',
        unit_of_measurement: '°C',
      };
    `);

    writeBundleFile('file2.js', `
      export const s2 = {
        id: 'sensor.two',
        name: 'Two',
        type: 'sensor',
        device_class: 'humidity',
        unit_of_measurement: '%',
      };
    `);

    const manager = new BuildManager({
      bundleDir,
      transport,
      logger,
    });

    const result = await manager.deploy();

    expect(result.entityCount).toBe(2);
    expect(result.success).toBe(true);
  });

  it('exposes entity state and IDs after deploy', async () => {
    writeBundleFile('test.js', `
      export const sensor = {
        id: 'sensor.test',
        name: 'Test',
        type: 'sensor',
        device_class: 'temperature',
        unit_of_measurement: '°C',
        init() { return 42; },
      };
    `);

    const manager = new BuildManager({
      bundleDir,
      transport,
      logger,
    });

    await manager.deploy();

    expect(manager.getEntityIds()).toContain('sensor.test');
    expect(manager.getEntityState('sensor.test')).toBe(42);
  });
});
