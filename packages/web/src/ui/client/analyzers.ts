/**
 * Custom code analyzers for Monaco editor.
 *
 * Detects patterns in user TypeScript files and produces diagnostics
 * (warnings/errors) that are shown as squiggly underlines via
 * monaco.editor.setModelMarkers(). Uses a separate owner string so
 * built-in TypeScript diagnostics are unaffected.
 */

export interface AnalyzerDiagnostic {
  startLine: number;   // 1-based
  startCol: number;    // 1-based
  endLine: number;
  endCol: number;
  message: string;
  severity: 'warning' | 'error' | 'info';
}

export type Analyzer = (sourceText: string, fileName?: string) => AnalyzerDiagnostic[];

const analyzers = new Map<string, Analyzer>();

export function registerAnalyzer(name: string, fn: Analyzer) {
  analyzers.set(name, fn);
}

export function runAllAnalyzers(sourceText: string, fileName?: string): AnalyzerDiagnostic[] {
  const results: AnalyzerDiagnostic[] = [];
  for (const fn of analyzers.values()) {
    results.push(...fn(sourceText, fileName));
  }
  return results;
}

// ---- Built-in: Unexported Entity Definitions ----

export const FACTORY_NAMES = [
  'sensor', 'light', 'defineSwitch', 'cover', 'climate',
  'device', 'entityFactory', 'automation', 'task',
  'binarySensor', 'fan', 'lock', 'number', 'select',
  'text', 'button', 'siren', 'humidifier', 'valve',
  'waterHeater', 'vacuum', 'lawnMower', 'alarmControlPanel',
  'computed', 'mode', 'cron',
];

// Matches: const/let/var <name> = <factory>(...) at the start of a line
// Captures: [1]=keyword, [2]=variable name, [3]=factory name
// Does NOT match lines starting with 'export'
const DECL_PATTERN = new RegExp(
  '^(?!export\\b)' +                              // negative lookahead for export
  '(const|let|var)\\s+' +                         // declaration keyword
  '(\\w+)\\s*=\\s*' +                             // variable name =
  '(?:\\w+\\.)?' +                                 // optional namespace (e.g. ha.)
  '(' + FACTORY_NAMES.join('|') + ')' +            // factory function name
  '\\s*\\(',                                       // opening paren
  'gm'
);

export function analyzeUnexportedEntities(sourceText: string): AnalyzerDiagnostic[] {
  const diagnostics: AnalyzerDiagnostic[] = [];
  const lines = sourceText.split('\n');

  // Collect names that are exported via `export { name }` or `export { name as ... }`
  const reExported = new Set<string>();
  for (const line of lines) {
    const reExportMatch = line.match(/export\s*\{([^}]+)\}/);
    if (reExportMatch) {
      for (const part of reExportMatch[1].split(',')) {
        const name = part.trim().split(/\s+/)[0]; // handle `name as alias`
        if (name) reExported.add(name);
      }
    }
  }

  // Reset regex state
  DECL_PATTERN.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = DECL_PATTERN.exec(sourceText)) !== null) {
    const varName = match[2];
    const factoryName = match[3];

    // Skip if re-exported later
    if (reExported.has(varName)) continue;

    // Find the line number (1-based)
    const beforeMatch = sourceText.slice(0, match.index);
    const lineNumber = beforeMatch.split('\n').length;
    const line = lines[lineNumber - 1];

    // Column of the variable name within the line
    const varStart = line.indexOf(varName);
    const startCol = varStart + 1; // 1-based
    const endCol = startCol + varName.length;

    diagnostics.push({
      startLine: lineNumber,
      startCol,
      endLine: lineNumber,
      endCol,
      message: `'${varName}' is created by ${factoryName}() but is not exported — it will not be deployed.`,
      severity: 'warning',
    });
  }

  return diagnostics;
}

// ---- Entity Symbol Finder (for DocumentSymbolProvider) ----

export interface EntitySymbol {
  name: string;
  factoryName: string;
  isExported: boolean;
  line: number;       // 1-based
  startCol: number;   // 1-based
  endCol: number;     // 1-based
}

// Matches both exported and unexported entity declarations
const SYMBOL_PATTERN = new RegExp(
  '^(export\\s+)?' +
  '(?:const|let|var)\\s+' +
  '(\\w+)\\s*=\\s*' +
  '(?:\\w+\\.)?' +
  '(' + FACTORY_NAMES.join('|') + ')' +
  '\\s*\\(',
  'gm'
);

export function findEntitySymbols(sourceText: string): EntitySymbol[] {
  const symbols: EntitySymbol[] = [];
  const lines = sourceText.split('\n');

  // Collect re-exported names
  const reExported = new Set<string>();
  for (const line of lines) {
    const reExportMatch = line.match(/export\s*\{([^}]+)\}/);
    if (reExportMatch) {
      for (const part of reExportMatch[1].split(',')) {
        const name = part.trim().split(/\s+/)[0];
        if (name) reExported.add(name);
      }
    }
  }

  SYMBOL_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SYMBOL_PATTERN.exec(sourceText)) !== null) {
    const isExported = !!match[1] || reExported.has(match[2]);
    const varName = match[2];
    const beforeMatch = sourceText.slice(0, match.index);
    const lineNumber = beforeMatch.split('\n').length;
    const line = lines[lineNumber - 1];
    const varStart = line.indexOf(varName);

    symbols.push({
      name: varName,
      factoryName: match[3],
      isExported,
      line: lineNumber,
      startCol: varStart + 1,
      endCol: varStart + 1 + varName.length,
    });
  }

  return symbols;
}

// Register built-in analyzers
registerAnalyzer('unexported-entities', analyzeUnexportedEntities);
