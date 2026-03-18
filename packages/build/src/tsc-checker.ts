import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface TscDiagnostic {
  file: string;
  line: number;
  column: number;
  code: number;
  message: string;
  severity: 'error' | 'warning';
}

export interface TscCheckResult {
  success: boolean;
  diagnostics: TscDiagnostic[];
  duration: number;
}

/**
 * Runs `tsc --noEmit` against user scripts and collects diagnostics.
 * Type errors warn but do NOT block the build.
 */
export async function tscCheck(opts: {
  /** Directory containing user .ts files */
  scriptsDir: string;
  /** Directory containing generated types (.generated/) */
  generatedDir: string;
  /** Path to tsconfig.json (created if absent) */
  tsconfigPath?: string;
}): Promise<TscCheckResult> {
  const startTime = Date.now();

  const tsconfigPath = opts.tsconfigPath ?? path.join(opts.scriptsDir, 'tsconfig.json');

  // Scaffold tsconfig.json if absent
  if (!fs.existsSync(tsconfigPath)) {
    scaffoldTsconfig(tsconfigPath, opts.generatedDir);
  }

  // Find tsc binary
  const tscPath = findTsc(opts.scriptsDir);
  if (!tscPath) {
    return {
      success: true,
      diagnostics: [],
      duration: Date.now() - startTime,
    };
  }

  try {
    const output = await runTsc(tscPath, tsconfigPath);
    const diagnostics = parseTscOutput(output, opts.scriptsDir);

    return {
      success: diagnostics.filter((d) => d.severity === 'error').length === 0,
      diagnostics,
      duration: Date.now() - startTime,
    };
  } catch (err) {
    // tsc exits non-zero when there are errors — that's expected
    if (err instanceof TscExitError) {
      const diagnostics = parseTscOutput(err.output, opts.scriptsDir);
      return {
        success: false,
        diagnostics,
        duration: Date.now() - startTime,
      };
    }
    // Unexpected error (tsc not found, permission denied, etc.)
    return {
      success: false,
      diagnostics: [{
        file: '',
        line: 0,
        column: 0,
        code: 0,
        message: `tsc execution failed: ${err instanceof Error ? err.message : String(err)}`,
        severity: 'error',
      }],
      duration: Date.now() - startTime,
    };
  }
}

class TscExitError extends Error {
  constructor(public output: string, public exitCode: number) {
    super(`tsc exited with code ${exitCode}`);
  }
}

function scaffoldTsconfig(tsconfigPath: string, generatedDir: string): void {
  const relGenerated = path.relative(path.dirname(tsconfigPath), generatedDir);
  const tsconfig = {
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'bundler',
      strict: true,
      noEmit: true,
      paths: {
        'ts-entities': [`./${relGenerated}/ts-entities.d.ts`],
        'ts-entities/*': [`./${relGenerated}/ts-entities/*.d.ts`],
      },
    },
    include: ['*.ts', `${relGenerated}/**/*.d.ts`],
  };
  fs.writeFileSync(tsconfigPath, JSON.stringify(tsconfig, null, 2), 'utf-8');
}

function findTsc(scriptsDir: string): string | null {
  // Check local node_modules first
  const localTsc = path.join(scriptsDir, 'node_modules', '.bin', 'tsc');
  if (fs.existsSync(localTsc)) return localTsc;

  // Check project root node_modules
  const projectTsc = path.resolve(scriptsDir, '..', 'node_modules', '.bin', 'tsc');
  if (fs.existsSync(projectTsc)) return projectTsc;

  // Try global tsc
  return 'tsc';
}

function runTsc(tscPath: string, tsconfigPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      tscPath,
      ['--noEmit', '--pretty', 'false', '-p', tsconfigPath],
      { timeout: 60_000, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const output = stdout + stderr;
        if (error && 'code' in error && typeof error.code === 'number' && error.code !== 0) {
          reject(new TscExitError(output, error.code));
          return;
        }
        if (error) {
          reject(error);
          return;
        }
        resolve(output);
      },
    );
  });
}

/**
 * Parses tsc output lines like:
 *   file.ts(10,5): error TS2345: Argument of type ...
 */
export function parseTscOutput(output: string, baseDir: string): TscDiagnostic[] {
  const diagnostics: TscDiagnostic[] = [];
  const lines = output.split('\n');

  // Pattern: file(line,col): error TSxxxx: message
  const pattern = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+TS(\d+):\s+(.+)$/;

  for (const line of lines) {
    const match = line.trim().match(pattern);
    if (match) {
      const [, file, lineNum, col, severity, code, message] = match;
      diagnostics.push({
        file: path.relative(baseDir, file),
        line: parseInt(lineNum, 10),
        column: parseInt(col, 10),
        code: parseInt(code, 10),
        message,
        severity: severity as 'error' | 'warning',
      });
    }
  }

  return diagnostics;
}
