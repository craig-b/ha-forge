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
 * Runs `npm install` in the user scripts directory if package.json has changed.
 * Uses a hash file to detect changes and skip redundant installs.
 *
 * @param scriptsDir Directory containing package.json
 * @param nodeModulesDir Optional separate directory for node_modules.
 *   When provided, package.json is copied there, npm install runs there,
 *   and a symlink is created at `scriptsDir/node_modules` pointing to
 *   `nodeModulesDir/node_modules` so that esbuild/tsc resolve transparently.
 */
export async function npmInstall(scriptsDir: string, nodeModulesDir?: string): Promise<NpmInstallResult> {
  const startTime = Date.now();

  const packageJsonPath = path.join(scriptsDir, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    return {
      success: true,
      skipped: true,
      duration: Date.now() - startTime,
    };
  }

  // When nodeModulesDir is set, npm runs there (with a copy of package.json)
  // and scriptsDir/node_modules is symlinked to nodeModulesDir/node_modules.
  const installDir = nodeModulesDir ?? scriptsDir;
  const effectiveNodeModules = path.join(installDir, 'node_modules');

  // Check if package.json changed since last install
  const currentHash = hashFile(packageJsonPath);
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

  // Run npm install
  try {
    if (nodeModulesDir) {
      fs.mkdirSync(nodeModulesDir, { recursive: true });
      // Copy package.json and lockfile to the install directory
      fs.copyFileSync(packageJsonPath, path.join(nodeModulesDir, 'package.json'));
      const lockPath = path.join(scriptsDir, 'package-lock.json');
      if (fs.existsSync(lockPath)) {
        fs.copyFileSync(lockPath, path.join(nodeModulesDir, 'package-lock.json'));
      }
    }

    await runNpmInstall(installDir);

    // Symlink scriptsDir/node_modules → nodeModulesDir/node_modules
    if (nodeModulesDir) {
      ensureNodeModulesSymlink(scriptsDir, effectiveNodeModules);
      // Copy lockfile back to scriptsDir if npm generated/updated one
      const lockPath = path.join(nodeModulesDir, 'package-lock.json');
      if (fs.existsSync(lockPath)) {
        fs.copyFileSync(lockPath, path.join(scriptsDir, 'package-lock.json'));
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

function hashFile(filePath: string): string {
  const content = fs.readFileSync(filePath, 'utf-8');
  return crypto.createHash('sha256').update(content).digest('hex');
}

function runNpmInstall(cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'npm',
      ['install', '--no-audit', '--no-fund'],
      { cwd, timeout: 120_000, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`npm install failed: ${stderr || error.message}`));
          return;
        }
        resolve(stdout);
      },
    );
  });
}
