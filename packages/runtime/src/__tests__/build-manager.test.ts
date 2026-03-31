import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BuildManager } from '../build-manager.js';
import { DeployManifestManager } from '../deploy-manifest.js';
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
  let manifestManager: DeployManifestManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-mgr-test-'));
    bundleDir = path.join(tmpDir, 'bundles');
    fs.mkdirSync(bundleDir, { recursive: true });
    transport = createMockTransport();
    logger = createMockLogger();
    manifestManager = new DeployManifestManager(path.join(tmpDir, 'deploy-manifest.json'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeBundleFile(name: string, content: string): string {
    const filePath = path.join(bundleDir, name);
    fs.writeFileSync(filePath, content, 'utf-8');
    return filePath;
  }

  it('deploys entities from manifest', async () => {
    const bundlePath = writeBundleFile('sensors.js', `
      export const temp = {
        id: 'sensor.temperature',
        name: 'Temperature',
        type: 'sensor',
        device_class: 'temperature',
        unit_of_measurement: '°C',
        init() { return 22.5; },
      };
    `);

    manifestManager.setFile('sensors.ts', {
      commit: 'abc123',
      deployedAt: new Date().toISOString(),
      bundlePath,
    });

    const manager = new BuildManager({
      bundleDir,
      transport,
      logger,
    });

    const result = await manager.deployFromManifest(manifestManager);

    expect(result.success).toBe(true);
    expect(result.entityCount).toBe(1);
    expect(result.errors).toHaveLength(0);
    expect(transport.register).toHaveBeenCalled();
  });

  it('handles empty manifest', async () => {
    const manager = new BuildManager({
      bundleDir,
      transport,
      logger,
    });

    const result = await manager.deployFromManifest(manifestManager);

    expect(result.success).toBe(true);
    expect(result.entityCount).toBe(0);
  });

  it('reports error for missing bundle file', async () => {
    manifestManager.setFile('missing.ts', {
      commit: 'abc123',
      deployedAt: new Date().toISOString(),
      bundlePath: path.join(bundleDir, 'missing.js'),
    });

    const manager = new BuildManager({
      bundleDir,
      transport,
      logger,
    });

    const result = await manager.deployFromManifest(manifestManager);

    expect(result.success).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].file).toBe('missing.ts');
    expect(logger.error).toHaveBeenCalled();
  });

  it('deploys multiple files from manifest independently', async () => {
    const bundle1 = writeBundleFile('file1.js', `
      export const s1 = {
        id: 'sensor.one',
        name: 'One',
        type: 'sensor',
        device_class: 'temperature',
        unit_of_measurement: '°C',
      };
    `);

    const bundle2 = writeBundleFile('file2.js', `
      export const s2 = {
        id: 'sensor.two',
        name: 'Two',
        type: 'sensor',
        device_class: 'humidity',
        unit_of_measurement: '%',
      };
    `);

    manifestManager.setFile('file1.ts', {
      commit: 'abc123',
      deployedAt: new Date().toISOString(),
      bundlePath: bundle1,
    });
    manifestManager.setFile('file2.ts', {
      commit: 'def456',
      deployedAt: new Date().toISOString(),
      bundlePath: bundle2,
    });

    const manager = new BuildManager({
      bundleDir,
      transport,
      logger,
    });

    const result = await manager.deployFromManifest(manifestManager);

    expect(result.entityCount).toBe(2);
    expect(result.success).toBe(true);
  });

  it('exposes entity state and IDs after deploy', async () => {
    const bundlePath = writeBundleFile('test.js', `
      export const sensor = {
        id: 'sensor.test',
        name: 'Test',
        type: 'sensor',
        device_class: 'temperature',
        unit_of_measurement: '°C',
        init() { return 42; },
      };
    `);

    manifestManager.setFile('test.ts', {
      commit: 'abc123',
      deployedAt: new Date().toISOString(),
      bundlePath,
    });

    const manager = new BuildManager({
      bundleDir,
      transport,
      logger,
    });

    await manager.deployFromManifest(manifestManager);

    expect(manager.getEntityIds()).toContain('sensor.test');
    expect(manager.getEntityState('sensor.test')).toBe(42);
  });
});
