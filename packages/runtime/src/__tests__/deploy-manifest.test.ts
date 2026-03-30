import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DeployManifestManager } from '../deploy-manifest.js';

describe('DeployManifestManager', () => {
  let tmpDir: string;
  let manifestPath: string;
  let manager: DeployManifestManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-manifest-test-'));
    manifestPath = path.join(tmpDir, 'deploy-manifest.json');
    manager = new DeployManifestManager(manifestPath);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty manifest when file does not exist', () => {
    const manifest = manager.read();
    expect(manifest).toEqual({ files: {} });
  });

  it('writes and reads manifest', () => {
    const manifest = {
      files: {
        'lights.ts': {
          commit: 'abc123',
          deployedAt: '2026-03-30T14:35:00Z',
          bundlePath: '/data/deployed-bundles/lights.js',
        },
      },
    };
    manager.write(manifest);

    const read = manager.read();
    expect(read).toEqual(manifest);
  });

  it('setFile adds a new entry', () => {
    manager.setFile('lights.ts', {
      commit: 'abc123',
      deployedAt: '2026-03-30T14:35:00Z',
      bundlePath: '/data/deployed-bundles/lights.js',
    });

    const entry = manager.getFile('lights.ts');
    expect(entry).toEqual({
      commit: 'abc123',
      deployedAt: '2026-03-30T14:35:00Z',
      bundlePath: '/data/deployed-bundles/lights.js',
    });
  });

  it('setFile updates an existing entry', () => {
    manager.setFile('lights.ts', {
      commit: 'abc123',
      deployedAt: '2026-03-30T14:35:00Z',
      bundlePath: '/data/deployed-bundles/lights.js',
    });
    manager.setFile('lights.ts', {
      commit: 'def456',
      deployedAt: '2026-03-30T15:00:00Z',
      bundlePath: '/data/deployed-bundles/lights.js',
    });

    const entry = manager.getFile('lights.ts');
    expect(entry?.commit).toBe('def456');
  });

  it('removeFile deletes an entry', () => {
    manager.setFile('lights.ts', {
      commit: 'abc123',
      deployedAt: '2026-03-30T14:35:00Z',
      bundlePath: '/data/deployed-bundles/lights.js',
    });
    manager.removeFile('lights.ts');

    expect(manager.getFile('lights.ts')).toBeUndefined();
  });

  it('removeFile is a no-op for missing entries', () => {
    manager.removeFile('nonexistent.ts');
    expect(manager.read()).toEqual({ files: {} });
  });

  it('getFile returns undefined for missing entries', () => {
    expect(manager.getFile('nope.ts')).toBeUndefined();
  });

  it('handles multiple files independently', () => {
    manager.setFile('lights.ts', {
      commit: 'aaa',
      deployedAt: '2026-03-30T10:00:00Z',
      bundlePath: '/data/deployed-bundles/lights.js',
    });
    manager.setFile('climate.ts', {
      commit: 'bbb',
      deployedAt: '2026-03-30T11:00:00Z',
      bundlePath: '/data/deployed-bundles/climate.js',
    });

    manager.removeFile('lights.ts');

    expect(manager.getFile('lights.ts')).toBeUndefined();
    expect(manager.getFile('climate.ts')?.commit).toBe('bbb');
  });

  it('writes atomically (no .tmp left behind)', () => {
    manager.setFile('test.ts', {
      commit: 'abc',
      deployedAt: '2026-03-30T10:00:00Z',
      bundlePath: '/data/deployed-bundles/test.js',
    });

    expect(fs.existsSync(manifestPath + '.tmp')).toBe(false);
    expect(fs.existsSync(manifestPath)).toBe(true);
  });

  it('creates parent directory if needed', () => {
    const nestedPath = path.join(tmpDir, 'sub', 'dir', 'manifest.json');
    const nestedManager = new DeployManifestManager(nestedPath);

    nestedManager.setFile('test.ts', {
      commit: 'abc',
      deployedAt: '2026-03-30T10:00:00Z',
      bundlePath: '/data/deployed-bundles/test.js',
    });

    expect(fs.existsSync(nestedPath)).toBe(true);
  });
});
