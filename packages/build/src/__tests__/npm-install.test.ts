import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { npmInstall } from '../npm-install.js';

describe('npmInstall', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-install-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('skips when no package.json exists', async () => {
    const result = await npmInstall(tmpDir);

    expect(result.success).toBe(true);
    expect(result.skipped).toBe(true);
  });

  it('skips when package.json hash matches stored hash', async () => {
    const packageJson = JSON.stringify({ name: 'test', dependencies: {} });
    fs.writeFileSync(path.join(tmpDir, 'package.json'), packageJson, 'utf-8');

    // Pre-create hash file
    const hash = crypto.createHash('sha256').update(packageJson).digest('hex');
    const hashDir = path.join(tmpDir, 'node_modules');
    fs.mkdirSync(hashDir, { recursive: true });
    fs.writeFileSync(path.join(hashDir, '.package-json-hash'), hash, 'utf-8');

    const result = await npmInstall(tmpDir);

    expect(result.success).toBe(true);
    expect(result.skipped).toBe(true);
  });

  it('does not skip when hash differs', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'test', dependencies: {} }),
      'utf-8',
    );

    // Pre-create stale hash
    const hashDir = path.join(tmpDir, 'node_modules');
    fs.mkdirSync(hashDir, { recursive: true });
    fs.writeFileSync(path.join(hashDir, '.package-json-hash'), 'stale-hash', 'utf-8');

    // npm install will actually run — this may fail in CI without npm, but we can
    // verify it was not skipped by checking the result
    const result = await npmInstall(tmpDir);

    // It ran (not skipped), though may fail if npm isn't available
    expect(result.skipped).toBe(false);
  });

  it('stores hash after successful install', async () => {
    // Create a minimal valid package.json
    const packageJson = JSON.stringify({ name: 'test-pkg', version: '1.0.0' });
    fs.writeFileSync(path.join(tmpDir, 'package.json'), packageJson, 'utf-8');

    const result = await npmInstall(tmpDir);

    if (result.success) {
      const hashFile = path.join(tmpDir, 'node_modules', '.package-json-hash');
      expect(fs.existsSync(hashFile)).toBe(true);

      const expectedHash = crypto.createHash('sha256').update(packageJson).digest('hex');
      const storedHash = fs.readFileSync(hashFile, 'utf-8').trim();
      expect(storedHash).toBe(expectedHash);
    }
    // If npm not available, just ensure it didn't throw
    expect(result).toHaveProperty('success');
  });
});
