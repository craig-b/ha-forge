import * as fs from 'node:fs';
import * as path from 'node:path';
import type { GitService } from './git-service.js';
import { DeployManifestManager } from './deploy-manifest.js';

/**
 * Migrates an existing installation to git-backed versioning.
 * Idempotent — safe to call on every startup.
 *
 * Steps:
 * 1. Initialize git repo if not present
 * 2. If global package.json exists, generate per-file sidecar files
 * 3. Commit all .ts and .package.json files as initial commit
 * 4. If /data/last-build has bundles, copy to /data/deployed-bundles and create manifest
 */
export async function migrateToGitVersioning(opts: {
  scriptsDir: string;
  dataDir: string;
  gitService: GitService;
  logger?: { info(msg: string): void };
}): Promise<void> {
  const { scriptsDir, dataDir, gitService, logger } = opts;

  // Already migrated if .git exists
  if (fs.existsSync(path.join(scriptsDir, '.git'))) {
    return;
  }

  logger?.info('Migrating to git-backed versioning...');

  // Step 1: Initialize git repo
  await gitService.ensureRepo();

  // Step 2: Generate per-file sidecar files from global package.json
  const globalPkgPath = path.join(scriptsDir, 'package.json');
  if (fs.existsSync(globalPkgPath)) {
    try {
      const globalPkg = JSON.parse(fs.readFileSync(globalPkgPath, 'utf-8'));
      const globalDeps = globalPkg.dependencies as Record<string, string> | undefined;
      if (globalDeps && Object.keys(globalDeps).length > 0) {
        const tsFiles = findTsFiles(scriptsDir);
        for (const tsFile of tsFiles) {
          const content = fs.readFileSync(path.join(scriptsDir, tsFile), 'utf-8');
          const usedDeps = findUsedDependencies(content, globalDeps);
          if (Object.keys(usedDeps).length > 0) {
            const sidecarPath = path.join(scriptsDir, tsFile.replace(/\.ts$/, '.package.json'));
            if (!fs.existsSync(sidecarPath)) {
              fs.writeFileSync(sidecarPath, JSON.stringify({ dependencies: usedDeps }, null, 2) + '\n', 'utf-8');
              logger?.info(`Created sidecar: ${tsFile.replace(/\.ts$/, '.package.json')}`);
            }
          }
        }
      }
    } catch { /* non-fatal: global package.json may be malformed */ }
  }

  // Step 3: Commit all .ts and .package.json files
  const filesToCommit = findCommittableFiles(scriptsDir);
  if (filesToCommit.length > 0) {
    for (const file of filesToCommit) {
      try {
        await gitService.commitFile(path.join(scriptsDir, file));
      } catch { /* skip files that fail to commit */ }
    }
    logger?.info(`Initial commit: ${filesToCommit.length} files`);
  }

  // Step 4: Copy last-build bundles to deployed-bundles and create manifest
  const lastBuildDir = path.join(dataDir, 'last-build');
  const deployedBundlesDir = path.join(dataDir, 'deployed-bundles');
  const manifestPath = path.join(dataDir, 'deploy-manifest.json');

  if (fs.existsSync(lastBuildDir) && !fs.existsSync(manifestPath)) {
    try {
      fs.mkdirSync(deployedBundlesDir, { recursive: true });
      const manifest = new DeployManifestManager(manifestPath);

      const jsFiles = fs.readdirSync(lastBuildDir).filter((f) => f.endsWith('.js') && !f.endsWith('.js.map'));
      for (const jsFile of jsFiles) {
        fs.copyFileSync(
          path.join(lastBuildDir, jsFile),
          path.join(deployedBundlesDir, jsFile),
        );
        const tsFile = jsFile.replace(/\.js$/, '.ts');
        manifest.setFile(tsFile, {
          commit: 'migration',
          deployedAt: new Date().toISOString(),
          bundlePath: path.join(deployedBundlesDir, jsFile),
        });
      }

      if (jsFiles.length > 0) {
        logger?.info(`Migrated ${jsFiles.length} bundles to deployed-bundles`);
      }
    } catch (err) {
      logger?.info(`Bundle migration failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  logger?.info('Migration complete');
}

/** Find .ts files in scriptsDir (non-recursive, excluding hidden/generated). */
function findTsFiles(dir: string): string[] {
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && !f.startsWith('.'));
}

/** Find all .ts and .package.json files suitable for initial commit. */
function findCommittableFiles(dir: string): string[] {
  return fs.readdirSync(dir)
    .filter((f) => (f.endsWith('.ts') || f.endsWith('.package.json')) && !f.startsWith('.'));
}

/** Simple regex-based import analysis to match deps from global package.json. */
function findUsedDependencies(
  content: string,
  availableDeps: Record<string, string>,
): Record<string, string> {
  const used: Record<string, string> = {};
  // Match: import ... from 'pkg' or import ... from "pkg"
  // Also match: require('pkg')
  const importRegex = /(?:from\s+['"]|require\s*\(\s*['"])([^./][^'"]*)['"]/g;
  let match;
  while ((match = importRegex.exec(content)) !== null) {
    const pkg = match[1];
    // Handle scoped packages: @scope/name
    const pkgName = pkg.startsWith('@') ? pkg.split('/').slice(0, 2).join('/') : pkg.split('/')[0];
    if (pkgName in availableDeps) {
      used[pkgName] = availableDeps[pkgName];
    }
  }
  return used;
}
