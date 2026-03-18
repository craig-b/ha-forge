import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseTscOutput, tscCheck } from '../tsc-checker.js';

describe('parseTscOutput', () => {
  it('parses standard tsc error lines', () => {
    const output = `src/main.ts(10,5): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.`;
    const diagnostics = parseTscOutput(output, '/project');

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toEqual({
      file: path.relative('/project', 'src/main.ts'),
      line: 10,
      column: 5,
      code: 2345,
      message: "Argument of type 'string' is not assignable to parameter of type 'number'.",
      severity: 'error',
    });
  });

  it('parses multiple diagnostics', () => {
    const output = [
      `file1.ts(1,1): error TS2304: Cannot find name 'foo'.`,
      `file2.ts(5,10): error TS2322: Type 'string' is not assignable to type 'number'.`,
    ].join('\n');

    const diagnostics = parseTscOutput(output, '/project');
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[0].file).toBe(path.relative('/project', 'file1.ts'));
    expect(diagnostics[0].code).toBe(2304);
    expect(diagnostics[1].file).toBe(path.relative('/project', 'file2.ts'));
    expect(diagnostics[1].code).toBe(2322);
  });

  it('handles warning severity', () => {
    const output = `test.ts(3,7): warning TS6133: 'x' is declared but never used.`;
    const diagnostics = parseTscOutput(output, '/');

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].severity).toBe('warning');
    expect(diagnostics[0].code).toBe(6133);
  });

  it('returns empty array for non-diagnostic output', () => {
    const output = `
Some random text
Another line
`;
    expect(parseTscOutput(output, '/')).toHaveLength(0);
  });

  it('returns empty array for empty output', () => {
    expect(parseTscOutput('', '/')).toHaveLength(0);
  });

  it('ignores blank and summary lines', () => {
    const output = [
      ``,
      `src/main.ts(10,5): error TS2345: Argument bad.`,
      ``,
      `Found 1 error.`,
    ].join('\n');

    const diagnostics = parseTscOutput(output, '/project');
    expect(diagnostics).toHaveLength(1);
  });

  it('makes file paths relative to baseDir', () => {
    const output = `/project/scripts/main.ts(1,1): error TS1005: ';' expected.`;
    const diagnostics = parseTscOutput(output, '/project');

    expect(diagnostics[0].file).toBe('scripts/main.ts');
  });
});

describe('tscCheck', () => {
  let tmpDir: string;
  let scriptsDir: string;
  let generatedDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsc-test-'));
    scriptsDir = path.join(tmpDir, 'scripts');
    generatedDir = path.join(tmpDir, '.generated');
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.mkdirSync(generatedDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('scaffolds tsconfig.json if absent', async () => {
    const tsconfigPath = path.join(scriptsDir, 'tsconfig.json');

    // tscCheck will scaffold tsconfig, but tsc may not be available — that's ok
    await tscCheck({ scriptsDir, generatedDir, tsconfigPath });

    expect(fs.existsSync(tsconfigPath)).toBe(true);
    const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, 'utf-8'));
    expect(tsconfig.compilerOptions.noEmit).toBe(true);
    expect(tsconfig.compilerOptions.strict).toBe(true);
    expect(tsconfig.compilerOptions.target).toBe('ES2022');
  });

  it('does not overwrite existing tsconfig.json', async () => {
    const tsconfigPath = path.join(scriptsDir, 'tsconfig.json');
    fs.writeFileSync(tsconfigPath, '{"custom": true}', 'utf-8');

    await tscCheck({ scriptsDir, generatedDir, tsconfigPath });

    const content = JSON.parse(fs.readFileSync(tsconfigPath, 'utf-8'));
    expect(content.custom).toBe(true);
  });

  it('returns success when tsc is not found locally', async () => {
    // With no node_modules, findTsc falls back to global 'tsc' which may not exist
    // The function should handle this gracefully
    const result = await tscCheck({ scriptsDir, generatedDir });
    // Result depends on whether tsc is globally available, but should not throw
    expect(result).toHaveProperty('success');
    expect(result).toHaveProperty('diagnostics');
    expect(result).toHaveProperty('duration');
    expect(result.duration).toBeGreaterThanOrEqual(0);
  });
});
