import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GitService } from '../git-service.js';
import { DeployManifestManager } from '../deploy-manifest.js';
import { migrateToGitVersioning } from '../migration.js';

describe('migrateToGitVersioning', () => {
  let scriptsDir: string;
  let dataDir: string;

  beforeEach(() => {
    scriptsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-scripts-'));
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-data-'));
  });

  afterEach(() => {
    fs.rmSync(scriptsDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('initializes git repo', async () => {
    const gitService = new GitService(scriptsDir);

    await migrateToGitVersioning({ scriptsDir, dataDir, gitService });

    expect(fs.existsSync(path.join(scriptsDir, '.git'))).toBe(true);
    expect(fs.existsSync(path.join(scriptsDir, '.gitignore'))).toBe(true);
  });

  it('is idempotent — skips if .git already exists', async () => {
    const gitService = new GitService(scriptsDir);
    await migrateToGitVersioning({ scriptsDir, dataDir, gitService });

    // Create a file after migration
    fs.writeFileSync(path.join(scriptsDir, 'new.ts'), 'const x = 1;', 'utf-8');

    // Running again should not commit the new file
    await migrateToGitVersioning({ scriptsDir, dataDir, gitService });
    const history = await gitService.getFileHistory(path.join(scriptsDir, 'new.ts'));
    expect(history).toHaveLength(0);
  });

  it('commits existing .ts files', async () => {
    fs.writeFileSync(path.join(scriptsDir, 'lights.ts'), 'export default {};', 'utf-8');
    fs.writeFileSync(path.join(scriptsDir, 'climate.ts'), 'export default {};', 'utf-8');

    const gitService = new GitService(scriptsDir);
    await migrateToGitVersioning({ scriptsDir, dataDir, gitService });

    const lightsHistory = await gitService.getFileHistory(path.join(scriptsDir, 'lights.ts'));
    const climateHistory = await gitService.getFileHistory(path.join(scriptsDir, 'climate.ts'));
    expect(lightsHistory.length).toBeGreaterThan(0);
    expect(climateHistory.length).toBeGreaterThan(0);
  });

  it('generates sidecar files from global package.json', async () => {
    fs.writeFileSync(path.join(scriptsDir, 'lights.ts'), 'import dayjs from "dayjs";', 'utf-8');
    fs.writeFileSync(path.join(scriptsDir, 'climate.ts'), 'export default {};', 'utf-8');
    fs.writeFileSync(path.join(scriptsDir, 'package.json'), JSON.stringify({
      dependencies: { dayjs: '^2.0.0', lodash: '^4.0.0' },
    }), 'utf-8');

    const gitService = new GitService(scriptsDir);
    await migrateToGitVersioning({ scriptsDir, dataDir, gitService });

    // lights.ts imports dayjs, so it should get a sidecar
    const sidecarPath = path.join(scriptsDir, 'lights.package.json');
    expect(fs.existsSync(sidecarPath)).toBe(true);
    const sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf-8'));
    expect(sidecar.dependencies.dayjs).toBe('^2.0.0');
    expect(sidecar.dependencies.lodash).toBeUndefined(); // not imported by lights.ts

    // climate.ts imports nothing, so no sidecar
    expect(fs.existsSync(path.join(scriptsDir, 'climate.package.json'))).toBe(false);
  });

  it('copies last-build bundles to deployed-bundles and creates manifest', async () => {
    // Create a last-build directory with a bundle
    const lastBuildDir = path.join(dataDir, 'last-build');
    fs.mkdirSync(lastBuildDir, { recursive: true });
    fs.writeFileSync(path.join(lastBuildDir, 'lights.js'), '// bundled', 'utf-8');
    fs.writeFileSync(path.join(lastBuildDir, 'lights.js.map'), '{}', 'utf-8');

    const gitService = new GitService(scriptsDir);
    await migrateToGitVersioning({ scriptsDir, dataDir, gitService });

    // Bundle should be copied
    const deployedBundle = path.join(dataDir, 'deployed-bundles', 'lights.js');
    expect(fs.existsSync(deployedBundle)).toBe(true);

    // Manifest should exist
    const manifestPath = path.join(dataDir, 'deploy-manifest.json');
    const manifest = new DeployManifestManager(manifestPath);
    const entry = manifest.getFile('lights.ts');
    expect(entry).toBeDefined();
    expect(entry?.commit).toBe('migration');
    expect(entry?.bundlePath).toBe(deployedBundle);
  });

  it('does not overwrite existing manifest', async () => {
    // Create an existing manifest
    const manifestPath = path.join(dataDir, 'deploy-manifest.json');
    const manifest = new DeployManifestManager(manifestPath);
    manifest.setFile('existing.ts', {
      commit: 'abc123',
      deployedAt: '2026-01-01T00:00:00Z',
      bundlePath: '/data/deployed-bundles/existing.js',
    });

    // Create last-build
    const lastBuildDir = path.join(dataDir, 'last-build');
    fs.mkdirSync(lastBuildDir, { recursive: true });
    fs.writeFileSync(path.join(lastBuildDir, 'lights.js'), '// bundled', 'utf-8');

    const gitService = new GitService(scriptsDir);
    await migrateToGitVersioning({ scriptsDir, dataDir, gitService });

    // Existing manifest entry should still be there, no new entries added
    const entry = manifest.getFile('existing.ts');
    expect(entry?.commit).toBe('abc123');
    expect(manifest.getFile('lights.ts')).toBeUndefined();
  });
});
