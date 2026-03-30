import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { bundle } from '../bundler.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-ts-bundler-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('bundle', () => {
  it('returns success with no files for an empty input directory', async () => {
    const inputDir = path.join(tmpDir, 'input');
    const outputDir = path.join(tmpDir, 'output');
    fs.mkdirSync(inputDir);

    const result = await bundle({ inputDir, outputDir });

    expect(result.success).toBe(true);
    expect(result.files).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
    expect(result.duration).toBeGreaterThanOrEqual(0);
  });

  it('returns success with no files when input directory does not exist', async () => {
    const inputDir = path.join(tmpDir, 'nonexistent');
    const outputDir = path.join(tmpDir, 'output');

    const result = await bundle({ inputDir, outputDir });

    expect(result.success).toBe(true);
    expect(result.files).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it('bundles a simple .ts file and writes a valid .js output', async () => {
    const inputDir = path.join(tmpDir, 'input');
    const outputDir = path.join(tmpDir, 'output');
    fs.mkdirSync(inputDir);

    fs.writeFileSync(
      path.join(inputDir, 'hello.ts'),
      `export function greet(name: string): string {\n  return \`Hello, \${name}!\`;\n}\n`,
    );

    const result = await bundle({ inputDir, outputDir });

    expect(result.success).toBe(true);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].success).toBe(true);
    expect(result.files[0].errors).toHaveLength(0);

    const outputFile = path.join(outputDir, 'hello.js');
    expect(fs.existsSync(outputFile)).toBe(true);

    const content = fs.readFileSync(outputFile, 'utf8');
    expect(content).toContain('greet');
    // ESM format check
    expect(content).toMatch(/export\s/);
  });

  it('externalizes @ha-forge/sdk imports and does not bundle them', async () => {
    const inputDir = path.join(tmpDir, 'input');
    const outputDir = path.join(tmpDir, 'output');
    fs.mkdirSync(inputDir);

    fs.writeFileSync(
      path.join(inputDir, 'entity.ts'),
      `import { sensor } from '@ha-forge/sdk';\nexport default sensor({ id: 'test', name: 'Test', init() { return 0; } });\n`,
    );

    const result = await bundle({ inputDir, outputDir });

    expect(result.success).toBe(true);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].success).toBe(true);

    const content = fs.readFileSync(path.join(outputDir, 'entity.js'), 'utf8');
    // @ha-forge/sdk should remain as an import, not be inlined
    expect(content).toContain('@ha-forge/sdk');
  });

  it('externalizes additional external modules passed in options', async () => {
    const inputDir = path.join(tmpDir, 'input');
    const outputDir = path.join(tmpDir, 'output');
    fs.mkdirSync(inputDir);

    fs.writeFileSync(
      path.join(inputDir, 'widget.ts'),
      `import something from 'my-custom-lib';\nexport default something;\n`,
    );

    const result = await bundle({ inputDir, outputDir, external: ['my-custom-lib'] });

    expect(result.success).toBe(true);
    expect(result.files[0].success).toBe(true);

    const content = fs.readFileSync(path.join(outputDir, 'widget.js'), 'utf8');
    expect(content).toContain('my-custom-lib');
  });

  it('skips node_modules, .generated, dist, and hidden directories', async () => {
    const inputDir = path.join(tmpDir, 'input');
    const outputDir = path.join(tmpDir, 'output');

    for (const dir of ['node_modules', '.generated', 'dist', '.hidden', 'valid']) {
      fs.mkdirSync(path.join(inputDir, dir), { recursive: true });
    }

    // Place a .ts file in each directory
    for (const dir of ['node_modules', '.generated', 'dist', '.hidden', 'valid']) {
      fs.writeFileSync(
        path.join(inputDir, dir, 'file.ts'),
        `export const x = 1;\n`,
      );
    }

    const result = await bundle({ inputDir, outputDir });

    expect(result.success).toBe(true);
    // Only valid/file.ts should be bundled
    expect(result.files).toHaveLength(1);
    expect(result.files[0].inputFile).toContain(path.join('valid', 'file.ts'));
  });

  it('excludes .d.ts, .test.ts, and .spec.ts files', async () => {
    const inputDir = path.join(tmpDir, 'input');
    const outputDir = path.join(tmpDir, 'output');
    fs.mkdirSync(inputDir);

    fs.writeFileSync(path.join(inputDir, 'types.d.ts'), `export type Foo = string;\n`);
    fs.writeFileSync(path.join(inputDir, 'foo.test.ts'), `import { it } from 'vitest';\nit('x', () => {});\n`);
    fs.writeFileSync(path.join(inputDir, 'foo.spec.ts'), `import { it } from 'vitest';\nit('x', () => {});\n`);
    fs.writeFileSync(path.join(inputDir, 'real.ts'), `export const value = 42;\n`);

    const result = await bundle({ inputDir, outputDir });

    expect(result.success).toBe(true);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].inputFile).toContain('real.ts');
  });

  it('handles invalid TypeScript gracefully and reports errors', async () => {
    const inputDir = path.join(tmpDir, 'input');
    const outputDir = path.join(tmpDir, 'output');
    fs.mkdirSync(inputDir);

    // Syntax error that esbuild cannot recover from
    fs.writeFileSync(
      path.join(inputDir, 'broken.ts'),
      `export const x = @@@INVALID_SYNTAX@@@;\n`,
    );

    const result = await bundle({ inputDir, outputDir });

    expect(result.success).toBe(false);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].success).toBe(false);
    expect(result.files[0].errors.length).toBeGreaterThan(0);
  });

  it('bundles multiple .ts files independently', async () => {
    const inputDir = path.join(tmpDir, 'input');
    const outputDir = path.join(tmpDir, 'output');
    fs.mkdirSync(inputDir);

    fs.writeFileSync(path.join(inputDir, 'a.ts'), `export const a = 1;\n`);
    fs.writeFileSync(path.join(inputDir, 'b.ts'), `export const b = 2;\n`);
    fs.writeFileSync(path.join(inputDir, 'c.ts'), `export const c = 3;\n`);

    const result = await bundle({ inputDir, outputDir });

    expect(result.success).toBe(true);
    expect(result.files).toHaveLength(3);
    expect(result.files.every((f) => f.success)).toBe(true);

    for (const name of ['a.js', 'b.js', 'c.js']) {
      expect(fs.existsSync(path.join(outputDir, name))).toBe(true);
    }
  });

  it('blocks relative imports between user scripts', async () => {
    const inputDir = path.join(tmpDir, 'input');
    const outputDir = path.join(tmpDir, 'output');
    fs.mkdirSync(inputDir);

    fs.writeFileSync(path.join(inputDir, 'helper.ts'), `export const x = 1;\n`);
    fs.writeFileSync(path.join(inputDir, 'main.ts'), `import { x } from './helper';\nexport const y = x;\n`);

    const result = await bundle({ inputDir, outputDir });

    // main.ts should fail, helper.ts should also fail (if it has no relative imports it succeeds)
    const mainFile = result.files.find((f) => f.inputFile.includes('main.ts'));
    expect(mainFile).toBeDefined();
    expect(mainFile!.success).toBe(false);
    expect(mainFile!.errors.some((e) => e.includes('Cross-file imports are not supported'))).toBe(true);
  });

  it('blocks parent-relative imports (../)', async () => {
    const inputDir = path.join(tmpDir, 'input');
    const outputDir = path.join(tmpDir, 'output');
    const subDir = path.join(inputDir, 'sub');
    fs.mkdirSync(subDir, { recursive: true });

    fs.writeFileSync(path.join(inputDir, 'shared.ts'), `export const z = 99;\n`);
    fs.writeFileSync(path.join(subDir, 'child.ts'), `import { z } from '../shared';\nexport const w = z;\n`);

    const result = await bundle({ inputDir, outputDir });

    const childFile = result.files.find((f) => f.inputFile.includes('child.ts'));
    expect(childFile).toBeDefined();
    expect(childFile!.success).toBe(false);
    expect(childFile!.errors.some((e) => e.includes('Cross-file imports are not supported'))).toBe(true);
  });

  it('allows bare specifier imports (npm packages)', async () => {
    const inputDir = path.join(tmpDir, 'input');
    const outputDir = path.join(tmpDir, 'output');
    fs.mkdirSync(inputDir);

    // external modules are not resolved, so this should succeed
    fs.writeFileSync(path.join(inputDir, 'uses-lib.ts'), `import foo from 'some-lib';\nexport default foo;\n`);

    const result = await bundle({ inputDir, outputDir, external: ['some-lib'] });

    expect(result.success).toBe(true);
    expect(result.files[0].success).toBe(true);
  });

  it('bundles only specified files when files option is set', async () => {
    const inputDir = path.join(tmpDir, 'input');
    const outputDir = path.join(tmpDir, 'output');
    fs.mkdirSync(inputDir);

    fs.writeFileSync(path.join(inputDir, 'a.ts'), `export const a = 1;\n`);
    fs.writeFileSync(path.join(inputDir, 'b.ts'), `export const b = 2;\n`);
    fs.writeFileSync(path.join(inputDir, 'c.ts'), `export const c = 3;\n`);

    const result = await bundle({ inputDir, outputDir, files: ['a.ts'] });

    expect(result.success).toBe(true);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].inputFile).toContain('a.ts');
    expect(fs.existsSync(path.join(outputDir, 'a.js'))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, 'b.js'))).toBe(false);
    expect(fs.existsSync(path.join(outputDir, 'c.js'))).toBe(false);
  });

  it('does not clean output dir when files option is set', async () => {
    const inputDir = path.join(tmpDir, 'input');
    const outputDir = path.join(tmpDir, 'output');
    fs.mkdirSync(inputDir);
    fs.mkdirSync(outputDir, { recursive: true });

    // Pre-create an existing bundle
    fs.writeFileSync(path.join(outputDir, 'existing.js'), 'old bundle', 'utf-8');

    fs.writeFileSync(path.join(inputDir, 'a.ts'), `export const a = 1;\n`);

    const result = await bundle({ inputDir, outputDir, files: ['a.ts'] });

    expect(result.success).toBe(true);
    expect(fs.existsSync(path.join(outputDir, 'a.js'))).toBe(true);
    // Existing bundle should survive
    expect(fs.existsSync(path.join(outputDir, 'existing.js'))).toBe(true);
    expect(fs.readFileSync(path.join(outputDir, 'existing.js'), 'utf-8')).toBe('old bundle');
  });

  it('generates sourcemap files alongside output .js files', async () => {
    const inputDir = path.join(tmpDir, 'input');
    const outputDir = path.join(tmpDir, 'output');
    fs.mkdirSync(inputDir);

    fs.writeFileSync(path.join(inputDir, 'mapped.ts'), `export const val = 'sourcemap';\n`);

    const result = await bundle({ inputDir, outputDir });

    expect(result.success).toBe(true);
    expect(fs.existsSync(path.join(outputDir, 'mapped.js'))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, 'mapped.js.map'))).toBe(true);
  });
});
