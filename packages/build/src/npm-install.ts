import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

export interface NpmInstallResult {
  success: boolean;
  skipped: boolean;
  duration: number;
  error?: string;
}

/**
 * Runs `pnpm install` in the user scripts directory if package.json has changed.
 * Uses a hash file to detect changes and skip redundant installs.
 *
 * @param scriptsDir Directory containing package.json
 * @param nodeModulesDir Optional separate directory for node_modules.
 *   When provided, package.json is copied there, pnpm install runs there,
 *   and a symlink is created at `scriptsDir/node_modules` pointing to
 *   `nodeModulesDir/node_modules` so that esbuild/tsc resolve transparently.
 * @param storeDir Optional pnpm content-addressable store directory.
 */
export async function npmInstall(scriptsDir: string, nodeModulesDir?: string, storeDir?: string): Promise<NpmInstallResult> {
  const startTime = Date.now();

  const packageJsonPath = path.join(scriptsDir, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    return {
      success: true,
      skipped: true,
      duration: Date.now() - startTime,
    };
  }

  // When nodeModulesDir is set, pnpm runs there (with a copy of package.json)
  // and scriptsDir/node_modules is symlinked to nodeModulesDir/node_modules.
  const installDir = nodeModulesDir ?? scriptsDir;
  const effectiveNodeModules = path.join(installDir, 'node_modules');

  // Collect sidecar deps to merge into the install
  const sidecarDeps = collectSidecarDependencies(scriptsDir);

  // Hash package.json, lockfile, and sidecar deps together
  const currentHash = hashInstallInputs(scriptsDir, sidecarDeps);
  const hashFilePath = path.join(effectiveNodeModules, '.package-json-hash');

  if (fs.existsSync(hashFilePath)) {
    const storedHash = fs.readFileSync(hashFilePath, 'utf-8').trim();
    if (storedHash === currentHash) {
      // Ensure symlink exists even if skipping install
      if (nodeModulesDir) {
        ensureNodeModulesSymlink(scriptsDir, effectiveNodeModules);
      }
      return {
        success: true,
        skipped: true,
        duration: Date.now() - startTime,
      };
    }
  }

  // Run pnpm install
  try {
    if (nodeModulesDir) {
      fs.mkdirSync(nodeModulesDir, { recursive: true });
      // Copy package.json to the install directory, merging in sidecar deps
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
      if (Object.keys(sidecarDeps).length > 0) {
        pkg.dependencies = { ...(pkg.dependencies ?? {}), ...sidecarDeps };
      }
      fs.writeFileSync(path.join(nodeModulesDir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n', 'utf-8');
      const lockPath = path.join(scriptsDir, 'pnpm-lock.yaml');
      if (fs.existsSync(lockPath)) {
        fs.copyFileSync(lockPath, path.join(nodeModulesDir, 'pnpm-lock.yaml'));
      }
    }

    await runPnpmInstall(installDir, storeDir);

    // Symlink scriptsDir/node_modules → nodeModulesDir/node_modules
    if (nodeModulesDir) {
      ensureNodeModulesSymlink(scriptsDir, effectiveNodeModules);
      // Copy lockfile back to scriptsDir if pnpm generated/updated one
      const lockPath = path.join(nodeModulesDir, 'pnpm-lock.yaml');
      if (fs.existsSync(lockPath)) {
        fs.copyFileSync(lockPath, path.join(scriptsDir, 'pnpm-lock.yaml'));
      }
    }

    // Store hash after successful install
    fs.mkdirSync(effectiveNodeModules, { recursive: true });
    fs.writeFileSync(hashFilePath, currentHash, 'utf-8');

    return {
      success: true,
      skipped: false,
      duration: Date.now() - startTime,
    };
  } catch (err) {
    return {
      success: false,
      skipped: false,
      duration: Date.now() - startTime,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Ensures a symlink exists at `scriptsDir/node_modules` pointing to `target`.
 * Handles the case where a real node_modules directory already exists (removes it).
 */
function ensureNodeModulesSymlink(scriptsDir: string, target: string): void {
  const symlinkPath = path.join(scriptsDir, 'node_modules');

  try {
    const stat = fs.lstatSync(symlinkPath);
    if (stat.isSymbolicLink()) {
      if (fs.readlinkSync(symlinkPath) === target) return;
      fs.unlinkSync(symlinkPath);
    } else if (stat.isDirectory()) {
      fs.rmSync(symlinkPath, { recursive: true, force: true });
    } else {
      fs.unlinkSync(symlinkPath);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  fs.symlinkSync(target, symlinkPath, 'dir');
}

/** Hash package.json, pnpm-lock.yaml, and sidecar deps together for change detection. */
function hashInstallInputs(scriptsDir: string, sidecarDeps?: Record<string, string>): string {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(path.join(scriptsDir, 'package.json'), 'utf-8'));
  const lockPath = path.join(scriptsDir, 'pnpm-lock.yaml');
  if (fs.existsSync(lockPath)) {
    hash.update(fs.readFileSync(lockPath, 'utf-8'));
  }
  if (sidecarDeps && Object.keys(sidecarDeps).length > 0) {
    hash.update(JSON.stringify(sidecarDeps));
  }
  return hash.digest('hex');
}

/**
 * Scan all *.package.json sidecar files and collect their dependencies
 * into a single merged object. Used to build a combined package.json
 * for the shared node_modules directory.
 */
export function collectSidecarDependencies(scriptsDir: string): Record<string, string> {
  const merged: Record<string, string> = {};
  if (!fs.existsSync(scriptsDir)) return merged;

  const entries = fs.readdirSync(scriptsDir);
  for (const entry of entries) {
    if (!entry.endsWith('.package.json')) continue;
    try {
      const content = JSON.parse(fs.readFileSync(path.join(scriptsDir, entry), 'utf-8'));
      const deps = content.dependencies as Record<string, string> | undefined;
      if (deps) {
        Object.assign(merged, deps);
      }
    } catch { /* skip malformed sidecars */ }
  }
  return merged;
}

function runPnpmInstall(cwd: string, storeDir?: string): Promise<string> {
  const args = ['install', '--no-frozen-lockfile'];
  if (storeDir) {
    args.push('--store-dir', storeDir);
  }
  return new Promise((resolve, reject) => {
    execFile(
      'pnpm',
      args,
      { cwd, timeout: 120_000, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`pnpm install failed: ${stderr || error.message}`));
          return;
        }
        resolve(stdout);
      },
    );
  });
}
