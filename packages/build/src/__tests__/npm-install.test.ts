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

  describe('nodeModulesDir', () => {
    let nodeModulesDir: string;

    beforeEach(() => {
      nodeModulesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nm-separate-'));
    });

    afterEach(() => {
      fs.rmSync(nodeModulesDir, { recursive: true, force: true });
    });

    it('creates symlink at scriptsDir/node_modules pointing to nodeModulesDir/node_modules', async () => {
      const packageJson = JSON.stringify({ name: 'test-pkg', version: '1.0.0' });
      fs.writeFileSync(path.join(tmpDir, 'package.json'), packageJson, 'utf-8');

      await npmInstall(tmpDir, nodeModulesDir);

      const symlinkPath = path.join(tmpDir, 'node_modules');
      const stat = fs.lstatSync(symlinkPath);
      expect(stat.isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(symlinkPath)).toBe(path.join(nodeModulesDir, 'node_modules'));
    });

    it('stores hash in nodeModulesDir/node_modules', async () => {
      const packageJson = JSON.stringify({ name: 'test', dependencies: {} });
      fs.writeFileSync(path.join(tmpDir, 'package.json'), packageJson, 'utf-8');

      // Pre-create hash file in nodeModulesDir/node_modules
      const hash = crypto.createHash('sha256').update(packageJson).digest('hex');
      const nmSubdir = path.join(nodeModulesDir, 'node_modules');
      fs.mkdirSync(nmSubdir, { recursive: true });
      fs.writeFileSync(path.join(nmSubdir, '.package-json-hash'), hash, 'utf-8');

      const result = await npmInstall(tmpDir, nodeModulesDir);

      expect(result.success).toBe(true);
      expect(result.skipped).toBe(true);
    });

    it('replaces existing real node_modules directory with symlink', async () => {
      // Create a real node_modules directory
      const realNm = path.join(tmpDir, 'node_modules');
      fs.mkdirSync(realNm, { recursive: true });
      fs.writeFileSync(path.join(realNm, 'dummy'), 'old', 'utf-8');

      const packageJson = JSON.stringify({ name: 'test-pkg', version: '1.0.0' });
      fs.writeFileSync(path.join(tmpDir, 'package.json'), packageJson, 'utf-8');

      await npmInstall(tmpDir, nodeModulesDir);

      const stat = fs.lstatSync(path.join(tmpDir, 'node_modules'));
      expect(stat.isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(path.join(tmpDir, 'node_modules'))).toBe(path.join(nodeModulesDir, 'node_modules'));
    });

    it('is idempotent when symlink already correct', async () => {
      const packageJson = JSON.stringify({ name: 'test-pkg', version: '1.0.0' });
      fs.writeFileSync(path.join(tmpDir, 'package.json'), packageJson, 'utf-8');

      await npmInstall(tmpDir, nodeModulesDir);
      await npmInstall(tmpDir, nodeModulesDir);

      const stat = fs.lstatSync(path.join(tmpDir, 'node_modules'));
      expect(stat.isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(path.join(tmpDir, 'node_modules'))).toBe(path.join(nodeModulesDir, 'node_modules'));
    });

    it('copies package.json to nodeModulesDir for npm install', async () => {
      const packageJson = JSON.stringify({ name: 'test-pkg', version: '1.0.0' });
      fs.writeFileSync(path.join(tmpDir, 'package.json'), packageJson, 'utf-8');

      await npmInstall(tmpDir, nodeModulesDir);

      expect(fs.existsSync(path.join(nodeModulesDir, 'package.json'))).toBe(true);
      expect(fs.readFileSync(path.join(nodeModulesDir, 'package.json'), 'utf-8')).toBe(packageJson);
    });
  });
});
