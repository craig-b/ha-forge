import * as esbuild from 'esbuild';
import * as path from 'node:path';
import * as fs from 'node:fs';

export interface BundleOptions {
  /** Directory containing user .ts files */
  inputDir: string;
  /** Directory to write bundled .js files */
  outputDir: string;
  /** Additional external modules (always includes 'ha-forge') */
  external?: string[];
  /** When set, only bundle these specific files (paths relative to inputDir or absolute).
   *  Skips output directory cleanup to preserve other bundles. */
  files?: string[];
}

export interface BundleResult {
  success: boolean;
  files: BundleFileResult[];
  errors: string[];
  duration: number;
}

export interface BundleFileResult {
  inputFile: string;
  outputFile: string;
  success: boolean;
  errors: string[];
}

export async function bundle(options: BundleOptions): Promise<BundleResult> {
  const startTime = Date.now();
  const results: BundleFileResult[] = [];
  const globalErrors: string[] = [];

  // Determine which files to bundle
  let tsFiles: string[];
  if (options.files) {
    // Bundle only specified files — resolve relative paths against inputDir
    tsFiles = options.files.map((f) =>
      path.isAbsolute(f) ? f : path.join(options.inputDir, f),
    );
    // Ensure output directory exists without cleaning it
    fs.mkdirSync(options.outputDir, { recursive: true });
  } else {
    // Find all .ts files in inputDir (not in node_modules, not in .generated)
    try {
      tsFiles = findTsFiles(options.inputDir);
    } catch (err) {
      return {
        success: false,
        files: [],
        errors: [`Failed to scan input directory: ${err instanceof Error ? err.message : String(err)}`],
        duration: Date.now() - startTime,
      };
    }

    if (tsFiles.length === 0) {
      return {
        success: true,
        files: [],
        errors: [],
        duration: Date.now() - startTime,
      };
    }

    // Clean and recreate output directory to remove stale bundles from deleted/renamed files
    fs.rmSync(options.outputDir, { recursive: true, force: true });
    fs.mkdirSync(options.outputDir, { recursive: true });
  }

  const external = ['@ha-forge/sdk', ...(options.external ?? [])];

  // Plugin to block relative imports between user scripts
  const blockRelativeImports: esbuild.Plugin = {
    name: 'block-relative-imports',
    setup(build) {
      build.onResolve({ filter: /^\.\.?\// }, (args) => {
        return {
          errors: [{
            text: 'Cross-file imports are not supported. Each script must be self-contained.',
          }],
        };
      });
    },
  };

  // Bundle each file independently
  for (const file of tsFiles) {
    const relativePath = path.relative(options.inputDir, file);
    const outputFile = path.join(
      options.outputDir,
      relativePath.replace(/\.tsx?$/, '.js'),
    );

    try {
      const result = await esbuild.build({
        entryPoints: [file],
        bundle: true,
        platform: 'node',
        target: 'node20',
        format: 'esm',
        outfile: outputFile,
        external,
        plugins: [blockRelativeImports],
        sourcemap: true,
        logLevel: 'silent',
        absWorkingDir: options.inputDir,
      });

      const errors = result.errors.map((e) => esbuild.formatMessagesSync([e], { kind: 'error' }).join('\n'));

      results.push({
        inputFile: file,
        outputFile,
        success: errors.length === 0,
        errors,
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      results.push({
        inputFile: file,
        outputFile,
        success: false,
        errors: [errorMsg],
      });
    }
  }

  return {
    success: results.every((r) => r.success),
    files: results,
    errors: globalErrors,
    duration: Date.now() - startTime,
  };
}

function findTsFiles(dir: string): string[] {
  const files: string[] = [];

  if (!fs.existsSync(dir)) {
    return files;
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    // Skip node_modules, .generated, dist, and hidden directories
    if (entry.isDirectory()) {
      if (
        entry.name === 'node_modules' ||
        entry.name === '.generated' ||
        entry.name === 'dist' ||
        entry.name.startsWith('.')
      ) {
        continue;
      }
      files.push(...findTsFiles(fullPath));
    } else if (
      entry.isFile() &&
      (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) &&
      !entry.name.endsWith('.d.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.spec.ts')
    ) {
      files.push(fullPath);
    }
  }

  return files;
}
