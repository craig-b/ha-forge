import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadBundles, installGlobals } from '../loader.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loader-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('loadBundles()', () => {
  it('loads entity definitions from a JS file', async () => {
    const jsContent = `
      export const temp = {
        id: 'backyard_temp',
        name: 'Temperature',
        type: 'sensor',
        config: { device_class: 'temperature', unit_of_measurement: '°C' },
      };
    `;
    fs.writeFileSync(path.join(tmpDir, 'sensors.js'), jsContent);

    const result = await loadBundles(tmpDir);
    expect(result.errors).toHaveLength(0);
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0].definition.id).toBe('backyard_temp');
    expect(result.entities[0].definition.type).toBe('sensor');
    expect(result.entities[0].sourceFile).toBe('sensors.ts');
  });

  it('groups entities by file name when no device specified', async () => {
    const jsContent = `
      export const a = { id: 'a', name: 'A', type: 'sensor' };
      export const b = { id: 'b', name: 'B', type: 'sensor' };
    `;
    fs.writeFileSync(path.join(tmpDir, 'weather.js'), jsContent);

    const result = await loadBundles(tmpDir);
    expect(result.entities).toHaveLength(2);
    expect(result.entities[0].deviceId).toBe('weather');
    expect(result.entities[1].deviceId).toBe('weather');
  });

  it('uses device.id for deviceId when device is specified', async () => {
    const jsContent = `
      export const temp = {
        id: 'temp',
        name: 'Temp',
        type: 'sensor',
        device: { id: 'my_device', name: 'My Device' },
      };
    `;
    fs.writeFileSync(path.join(tmpDir, 'sensors.js'), jsContent);

    const result = await loadBundles(tmpDir);
    expect(result.entities[0].deviceId).toBe('my_device');
  });

  it('loads multiple files', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'file1.js'),
      `export const a = { id: 'a', name: 'A', type: 'sensor' };`,
    );
    fs.writeFileSync(
      path.join(tmpDir, 'file2.js'),
      `export const b = { id: 'b', name: 'B', type: 'sensor' };`,
    );

    const result = await loadBundles(tmpDir);
    expect(result.entities).toHaveLength(2);
    expect(result.errors).toHaveLength(0);
  });

  it('resolves entity factories', async () => {
    const jsContent = `
      export default function factory() {
        return [
          { id: 'dyn1', name: 'Dynamic 1', type: 'sensor' },
          { id: 'dyn2', name: 'Dynamic 2', type: 'sensor' },
        ];
      }
    `;
    fs.writeFileSync(path.join(tmpDir, 'dynamic.js'), jsContent);

    const result = await loadBundles(tmpDir);
    expect(result.entities).toHaveLength(2);
    expect(result.entities[0].definition.id).toBe('dyn1');
    expect(result.entities[1].definition.id).toBe('dyn2');
  });

  it('reports errors for files that fail to load', async () => {
    fs.writeFileSync(path.join(tmpDir, 'bad.js'), 'this is not valid JS exports{{{');

    const result = await loadBundles(tmpDir);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].file).toContain('bad.js');
    expect(result.entities).toHaveLength(0);
  });

  it('skips .js.map files', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'test.js'),
      `export const a = { id: 'a', name: 'A', type: 'sensor' };`,
    );
    fs.writeFileSync(path.join(tmpDir, 'test.js.map'), '{"version":3}');

    const result = await loadBundles(tmpDir);
    expect(result.entities).toHaveLength(1);
  });

  it('returns empty result for non-existent directory', async () => {
    const result = await loadBundles('/tmp/nonexistent-dir-' + Date.now());
    expect(result.entities).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it('ignores exports that are not entity definitions or factories', async () => {
    const jsContent = `
      export const config = { someKey: 'value' };
      export const CONSTANT = 42;
      export const sensor1 = { id: 's1', name: 'S1', type: 'sensor' };
    `;
    fs.writeFileSync(path.join(tmpDir, 'mixed.js'), jsContent);

    const result = await loadBundles(tmpDir);
    // Only the entity definition should be loaded — config/CONSTANT lack 'type' field
    // but CONSTANT also lacks 'id' and 'name'. config lacks 'type'.
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0].definition.id).toBe('s1');
  });
});

describe('installGlobals()', () => {
  let savedHa: unknown;

  beforeEach(() => {
    savedHa = (globalThis as Record<string, unknown>).ha;
  });

  afterEach(() => {
    (globalThis as Record<string, unknown>).ha = savedHa;
  });

  it('installs stub ha global without on() or reactions() when no client', async () => {
    await installGlobals(undefined, { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

    const ha = (globalThis as Record<string, unknown>).ha as Record<string, unknown>;
    expect(typeof ha.callService).toBe('function');
    expect(typeof ha.getState).toBe('function');
    expect(typeof ha.getEntities).toBe('function');
    expect(typeof ha.fireEvent).toBe('function');
    expect(typeof ha.friendlyName).toBe('function');
    // on() and reactions() should NOT be on the global ha
    expect(ha.on).toBeUndefined();
    expect(ha.reactions).toBeUndefined();
  });
});
