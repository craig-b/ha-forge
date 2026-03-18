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
 */
export async function npmInstall(scriptsDir: string): Promise<NpmInstallResult> {
  const startTime = Date.now();

  const packageJsonPath = path.join(scriptsDir, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    return {
      success: true,
      skipped: true,
      duration: Date.now() - startTime,
    };
  }

  // Check if package.json changed since last install
  const currentHash = hashFile(packageJsonPath);
  const hashFilePath = path.join(scriptsDir, 'node_modules', '.package-json-hash');

  if (fs.existsSync(hashFilePath)) {
    const storedHash = fs.readFileSync(hashFilePath, 'utf-8').trim();
    if (storedHash === currentHash) {
      return {
        success: true,
        skipped: true,
        duration: Date.now() - startTime,
      };
    }
  }

  // Run npm install
  try {
    await runNpmInstall(scriptsDir);

    // Store hash after successful install
    fs.mkdirSync(path.dirname(hashFilePath), { recursive: true });
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
