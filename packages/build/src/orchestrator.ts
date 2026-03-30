import * as path from 'node:path';
import { generateTypes } from './type-generator.js';
import { fetchRegistryData } from './registry-fetcher.js';
import type { RegistryWSClient } from './registry-fetcher.js';
import { npmInstall } from './npm-install.js';
import type { NpmInstallResult } from './npm-install.js';
import { tscCheck } from './tsc-checker.js';
import type { TscCheckResult, TscDiagnostic } from './tsc-checker.js';
import { bundle } from './bundler.js';
import type { BundleResult } from './bundler.js';
import type { TypeGenResult } from './type-generator.js';

// ---- Result types ----

export interface BuildStepResult {
  step: string;
  success: boolean;
  duration: number;
  error?: string;
}

export interface BuildResult {
  success: boolean;
  steps: BuildStepResult[];
  typeGen: TypeGenResult | null;
  npmInstall: NpmInstallResult | null;
  tscCheck: TscCheckResult | null;
  bundle: BundleResult | null;
  totalDuration: number;
  timestamp: string;
}

export interface OrchestratorOptions {
  /** Directory containing user .ts files */
  scriptsDir: string;
  /** Directory for generated types (.generated/) */
  generatedDir: string;
  /** Directory for bundled output */
  outputDir: string;
  /** WebSocket client for fetching HA registry (null to skip type gen) */
  wsClient?: RegistryWSClient | null;
  /** Callback invoked after each step completes */
  onStep?: (step: BuildStepResult) => void;
  /** Skip npm install step */
  skipNpmInstall?: boolean;
  /** Skip tsc check step */
  skipTscCheck?: boolean;
  /** Separate directory for node_modules (default: scriptsDir/node_modules) */
  nodeModulesDir?: string;
}

/**
 * Orchestrates the full build pipeline:
 *   1. Type generation (from HA registry via WebSocket)
 *   2. npm install (hash-based change detection)
 *   3. tsc --noEmit (type checking, non-blocking)
 *   4. esbuild bundle (produces deployable JS)
 *
 * Each step is independent enough that failures in early steps
 * (like type gen) don't necessarily block later steps (like bundling).
 * tsc errors are reported but never block the build.
 */
export async function runBuild(opts: OrchestratorOptions): Promise<BuildResult> {
  const totalStart = Date.now();
  const steps: BuildStepResult[] = [];

  let typeGenResult: TypeGenResult | null = null;
  let npmResult: NpmInstallResult | null = null;
  let tscResult: TscCheckResult | null = null;
  let bundleResult: BundleResult | null = null;

  // Step 1: Type generation
  if (opts.wsClient) {
    const stepStart = Date.now();
    try {
      const registryData = await fetchRegistryData(opts.wsClient);
      typeGenResult = generateTypes(registryData, opts.generatedDir);
      const step: BuildStepResult = {
        step: 'type-gen',
        success: typeGenResult.success,
        duration: Date.now() - stepStart,
        error: typeGenResult.errors.length > 0 ? typeGenResult.errors.join('; ') : undefined,
      };
      steps.push(step);
      opts.onStep?.(step);
    } catch (err) {
      const step: BuildStepResult = {
        step: 'type-gen',
        success: false,
        duration: Date.now() - stepStart,
        error: err instanceof Error ? err.message : String(err),
      };
      steps.push(step);
      opts.onStep?.(step);
    }
  }

  // Step 2: npm install
  if (!opts.skipNpmInstall) {
    const stepStart = Date.now();
    try {
      npmResult = await npmInstall(opts.scriptsDir, opts.nodeModulesDir);
      const step: BuildStepResult = {
        step: 'npm-install',
        success: npmResult.success,
        duration: Date.now() - stepStart,
        error: npmResult.error,
      };
      steps.push(step);
      opts.onStep?.(step);
    } catch (err) {
      const step: BuildStepResult = {
        step: 'npm-install',
        success: false,
        duration: Date.now() - stepStart,
        error: err instanceof Error ? err.message : String(err),
      };
      steps.push(step);
      opts.onStep?.(step);
    }
  }

  // Step 3: tsc check (non-blocking — errors are warnings)
  if (!opts.skipTscCheck) {
    const stepStart = Date.now();
    try {
      tscResult = await tscCheck({
        scriptsDir: opts.scriptsDir,
        generatedDir: opts.generatedDir,
      });
      const step: BuildStepResult = {
        step: 'tsc-check',
        success: true, // tsc errors don't block the build
        duration: Date.now() - stepStart,
      };
      steps.push(step);
      opts.onStep?.(step);
    } catch (err) {
      const step: BuildStepResult = {
        step: 'tsc-check',
        success: true, // tsc failure is non-blocking
        duration: Date.now() - stepStart,
        error: err instanceof Error ? err.message : String(err),
      };
      steps.push(step);
      opts.onStep?.(step);
    }
  }

  // Step 4: esbuild bundle
  const bundleStart = Date.now();
  try {
    bundleResult = await bundle({
      inputDir: opts.scriptsDir,
      outputDir: opts.outputDir,
    });
    const step: BuildStepResult = {
      step: 'bundle',
      success: bundleResult.success,
      duration: Date.now() - bundleStart,
      error: allBundleErrors(bundleResult) || undefined,
    };
    steps.push(step);
    opts.onStep?.(step);
  } catch (err) {
    const step: BuildStepResult = {
      step: 'bundle',
      success: false,
      duration: Date.now() - bundleStart,
      error: err instanceof Error ? err.message : String(err),
    };
    steps.push(step);
    opts.onStep?.(step);
  }

  // Overall success requires bundle to succeed (type gen and npm install are also required if run)
  const blockingSteps = steps.filter((s) => s.step !== 'tsc-check');
  const success = blockingSteps.every((s) => s.success);

  return {
    success,
    steps,
    typeGen: typeGenResult,
    npmInstall: npmResult,
    tscCheck: tscResult,
    bundle: bundleResult,
    totalDuration: Date.now() - totalStart,
    timestamp: new Date().toISOString(),
  };
}

/** Collect all bundle errors — both global and per-file. */
export function allBundleErrors(result: BundleResult): string | null {
  const errors = [
    ...result.errors,
    ...result.files.flatMap((f) => f.errors),
  ];
  return errors.length > 0 ? errors.join('; ') : null;
}

// ---- Scheduled validation ----

export interface ValidationResult {
  success: boolean;
  typeGen: TypeGenResult | null;
  tscCheck: TscCheckResult | null;
  diagnostics: TscDiagnostic[];
  duration: number;
  timestamp: string;
}

/**
 * Runs a lightweight validation pass without building:
 *   1. Regenerate types from HA registry to a temp directory
 *   2. Run tsc --noEmit against user scripts with fresh types
 *
 * Used for scheduled checks to detect issues (e.g., renamed entities)
 * without triggering a full build+deploy.
 */
export async function runValidation(opts: {
  scriptsDir: string;
  generatedDir: string;
  wsClient: RegistryWSClient;
  /** Temp directory for regenerated types (created if absent) */
  tempDir?: string;
}): Promise<ValidationResult> {
  const startTime = Date.now();
  const { default: fsPromises } = await import('node:fs');
  const os = await import('node:os');

  // Use temp dir for regenerated types so we don't overwrite the current ones
  const tempGenDir = opts.tempDir ?? fsPromises.mkdtempSync(
    path.join(os.tmpdir(), 'ha-forge-validate-'),
  );

  let typeGenResult: TypeGenResult | null = null;
  let tscResult: TscCheckResult | null = null;

  try {
    // Step 1: Regenerate types
    const registryData = await fetchRegistryData(opts.wsClient);
    typeGenResult = generateTypes(registryData, tempGenDir);

    if (!typeGenResult.success) {
      return {
        success: false,
        typeGen: typeGenResult,
        tscCheck: null,
        diagnostics: [],
        duration: Date.now() - startTime,
        timestamp: new Date().toISOString(),
      };
    }

    // Step 2: Run tsc with the regenerated types
    tscResult = await tscCheck({
      scriptsDir: opts.scriptsDir,
      generatedDir: tempGenDir,
    });

    return {
      success: tscResult.success,
      typeGen: typeGenResult,
      tscCheck: tscResult,
      diagnostics: tscResult.diagnostics,
      duration: Date.now() - startTime,
      timestamp: new Date().toISOString(),
    };
  } catch (err) {
    return {
      success: false,
      typeGen: typeGenResult,
      tscCheck: tscResult,
      diagnostics: [],
      duration: Date.now() - startTime,
      timestamp: new Date().toISOString(),
    };
  } finally {
    // Clean up temp dir if we created it
    if (!opts.tempDir) {
      try {
        fsPromises.rmSync(tempGenDir, { recursive: true, force: true });
      } catch {
        // Best effort cleanup
      }
    }
  }
}
