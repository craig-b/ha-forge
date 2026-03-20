import { describe, it, expect } from 'vitest';
import { analyzeUnexportedEntities, runAllAnalyzers, findEntitySymbols } from '../ui/client/analyzers.js';

describe('analyzeUnexportedEntities', () => {
  it('warns on unexported sensor()', () => {
    const code = `const temp = sensor({ id: 'temp', name: 'Temp' });`;
    const diags = analyzeUnexportedEntities(code);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain('temp');
    expect(diags[0].message).toContain('sensor()');
    expect(diags[0].message).toContain('not exported');
    expect(diags[0].severity).toBe('warning');
    expect(diags[0].startLine).toBe(1);
  });

  it('ignores exported definitions', () => {
    const code = `export const temp = sensor({ id: 'temp', name: 'Temp' });`;
    const diags = analyzeUnexportedEntities(code);
    expect(diags).toHaveLength(0);
  });

  it('detects multiple factory functions', () => {
    const code = [
      `const a = sensor({ id: 'a', name: 'A' });`,
      `const b = light({ id: 'b', name: 'B' });`,
      `export const c = cover({ id: 'c', name: 'C' });`,
    ].join('\n');
    const diags = analyzeUnexportedEntities(code);
    expect(diags).toHaveLength(2);
    expect(diags[0].message).toContain('sensor()');
    expect(diags[1].message).toContain('light()');
  });

  it('handles re-exports via export { name }', () => {
    const code = [
      `const temp = sensor({ id: 'temp', name: 'Temp' });`,
      `export { temp };`,
    ].join('\n');
    const diags = analyzeUnexportedEntities(code);
    expect(diags).toHaveLength(0);
  });

  it('handles re-exports with alias', () => {
    const code = [
      `const temp = sensor({ id: 'temp', name: 'Temp' });`,
      `export { temp as mySensor };`,
    ].join('\n');
    const diags = analyzeUnexportedEntities(code);
    expect(diags).toHaveLength(0);
  });

  it('detects namespaced factory calls', () => {
    const code = `const myLight = ha.light({ id: 'l', name: 'L' });`;
    const diags = analyzeUnexportedEntities(code);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain('light()');
  });

  it('detects device() factory', () => {
    const code = `const myDevice = device({ id: 'd', name: 'D', entities: {} });`;
    const diags = analyzeUnexportedEntities(code);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain('device()');
  });

  it('detects entityFactory()', () => {
    const code = `const factory = entityFactory(async () => []);`;
    const diags = analyzeUnexportedEntities(code);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain('entityFactory()');
  });

  it('ignores non-factory assignments', () => {
    const code = [
      `const x = 42;`,
      `const y = someOtherFunction();`,
      `const z = fetch('http://example.com');`,
    ].join('\n');
    const diags = analyzeUnexportedEntities(code);
    expect(diags).toHaveLength(0);
  });

  it('reports correct line numbers', () => {
    const code = [
      `// comment`,
      `export const a = sensor({ id: 'a', name: 'A' });`,
      ``,
      `const b = light({ id: 'b', name: 'B' });`,
    ].join('\n');
    const diags = analyzeUnexportedEntities(code);
    expect(diags).toHaveLength(1);
    expect(diags[0].startLine).toBe(4);
  });

  it('handles let and var declarations', () => {
    const code = [
      `let a = sensor({ id: 'a', name: 'A' });`,
      `var b = light({ id: 'b', name: 'B' });`,
    ].join('\n');
    const diags = analyzeUnexportedEntities(code);
    expect(diags).toHaveLength(2);
  });
});

describe('findEntitySymbols', () => {
  it('finds exported and unexported entities', () => {
    const code = [
      `export const a = sensor({ id: 'a', name: 'A' });`,
      `const b = light({ id: 'b', name: 'B' });`,
    ].join('\n');
    const symbols = findEntitySymbols(code);
    expect(symbols).toHaveLength(2);
    expect(symbols[0].name).toBe('a');
    expect(symbols[0].factoryName).toBe('sensor');
    expect(symbols[0].isExported).toBe(true);
    expect(symbols[1].name).toBe('b');
    expect(symbols[1].factoryName).toBe('light');
    expect(symbols[1].isExported).toBe(false);
  });

  it('detects re-exported symbols as exported', () => {
    const code = [
      `const temp = sensor({ id: 'temp', name: 'Temp' });`,
      `export { temp };`,
    ].join('\n');
    const symbols = findEntitySymbols(code);
    expect(symbols).toHaveLength(1);
    expect(symbols[0].isExported).toBe(true);
  });

  it('reports correct line and column', () => {
    const code = [
      `// header`,
      `export const mySensor = sensor({ id: 's', name: 'S' });`,
    ].join('\n');
    const symbols = findEntitySymbols(code);
    expect(symbols).toHaveLength(1);
    expect(symbols[0].line).toBe(2);
    expect(symbols[0].startCol).toBe(14); // 'mySensor' starts at col 14
    expect(symbols[0].endCol).toBe(22);   // 'mySensor' is 8 chars
  });

  it('returns empty for non-entity code', () => {
    const code = `const x = someFunction();`;
    expect(findEntitySymbols(code)).toHaveLength(0);
  });
});

describe('runAllAnalyzers', () => {
  it('runs registered analyzers', () => {
    const code = `const temp = sensor({ id: 'temp', name: 'Temp' });`;
    const diags = runAllAnalyzers(code, 'test.ts');
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].message).toContain('not exported');
  });
});
