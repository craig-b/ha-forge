/**
 * Shared AST helpers used by ast-analyzers, ast-finders, and ast-code-actions.
 *
 * Provides the lazy TypeScript API reference, common AST traversal utilities,
 * constant maps, and shared types.
 */

import type { AnalyzerDiagnostic } from './analyzers.js';
import { FACTORY_NAMES } from './analyzers.js';

export type { AnalyzerDiagnostic };
export { FACTORY_NAMES };

// TypeScript compiler API — loaded lazily from Monaco's CDN
let ts: typeof import('typescript') | null = null;

/** Called once after Monaco loads to provide the TypeScript API. */
export function setTypeScriptApi(tsApi: typeof import('typescript')) {
  ts = tsApi;
}

/** Whether the TypeScript API has been loaded. */
export function isReady(): boolean {
  return ts !== null;
}

/** Get the current TypeScript API instance (or null if not yet loaded). */
export function getTs(): typeof import('typescript') | null {
  return ts;
}

// Behavior wrapper names that pass through to an inner factory call
export const WRAPPER_NAMES = new Set([
  'debounced', 'filtered', 'sampled', 'buffered',
]);

export interface EntityInfo {
  id: string;
  line: number;
  startCol: number;
  endCol: number;
}

export interface AstAnalysisResult {
  diagnostics: AnalyzerDiagnostic[];
  entities: EntityInfo[];
}

export function getCalledName(node: import('typescript').CallExpression): string | null {
  if (!ts) return null;
  if (ts.isIdentifier(node.expression)) return node.expression.text;
  if (ts.isPropertyAccessExpression(node.expression)) return node.expression.name.text;
  return null;
}

/** Unwrap behavior wrappers to find the innermost factory call. */
export function findFactoryCall(node: import('typescript').CallExpression): import('typescript').CallExpression | null {
  if (!ts) return null;
  const name = getCalledName(node);
  if (name && FACTORY_NAMES.includes(name)) return node;
  if (name && WRAPPER_NAMES.has(name) && node.arguments.length > 0) {
    const inner = node.arguments[0];
    if (ts.isCallExpression(inner)) return findFactoryCall(inner);
  }
  return null;
}

export function markerAt(
  node: import('typescript').Node,
  sf: import('typescript').SourceFile,
  message: string,
  severity: 'error' | 'warning' | 'info',
): AnalyzerDiagnostic {
  const start = node.getStart(sf);
  const end = node.getEnd();
  const { line: startLine, character: startChar } = sf.getLineAndCharacterOfPosition(start);
  const { line: endLine, character: endChar } = sf.getLineAndCharacterOfPosition(end);
  return {
    startLine: startLine + 1,
    startCol: startChar + 1,
    endLine: endLine + 1,
    endCol: endChar + 1,
    message,
    severity,
  };
}

/** Maps factory names to their HA entity domain. Exported for CodeLens/inlay hints. */
export const FACTORY_DOMAINS: Record<string, string> = {
  sensor: 'sensor',
  binarySensor: 'binary_sensor',
  light: 'light',
  defineSwitch: 'switch',
  cover: 'cover',
  climate: 'climate',
  fan: 'fan',
  lock: 'lock',
  number: 'number',
  select: 'select',
  text: 'text',
  button: 'button',
  siren: 'siren',
  humidifier: 'humidifier',
  valve: 'valve',
  waterHeater: 'water_heater',
  vacuum: 'vacuum',
  lawnMower: 'lawn_mower',
  alarmControlPanel: 'alarm_control_panel',
  computed: 'sensor',
  cron: 'binary_sensor',
  notify: 'notify',
  update: 'update',
  image: 'image',
};

/** Extract literal values from an AST object literal expression (numbers, strings, arrays of numbers). */
export function extractObjectLiteral(node: import('typescript').Node): Record<string, unknown> {
  if (!ts || !ts.isObjectLiteralExpression(node)) return {};
  const result: Record<string, unknown> = {};
  for (const prop of node.properties) {
    if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;
    const key = prop.name.text;
    const val = prop.initializer;
    if (ts.isNumericLiteral(val)) {
      result[key] = Number(val.text);
    } else if (ts.isStringLiteral(val)) {
      result[key] = val.text;
    } else if (ts.isPrefixUnaryExpression(val) && val.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(val.operand)) {
      result[key] = -Number(val.operand.text);
    } else if (ts.isArrayLiteralExpression(val)) {
      const items: unknown[] = [];
      for (const el of val.elements) {
        if (ts.isNumericLiteral(el)) items.push(Number(el.text));
        else if (ts.isStringLiteral(el)) items.push(el.text);
      }
      if (items.length === val.elements.length) result[key] = items;
    }
  }
  return result;
}

/** Convert a snake_case entity ID to a Title Case name. */
export function idToTitle(id: string): string {
  return id
    .split('_')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Convert an arbitrary string to snake_case.
 * Returns null if the result would be empty or invalid.
 */
export function toSnakeCase(input: string): string | null {
  const result = input
    // Insert underscore before uppercase runs: "camelCase" → "camel_Case", "XMLParser" → "XML_Parser"
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    // Replace non-alphanumeric with underscore
    .replace(/[^a-zA-Z0-9]/g, '_')
    .toLowerCase()
    // Collapse multiple underscores
    .replace(/_+/g, '_')
    // Trim leading/trailing underscores
    .replace(/^_|_$/g, '');

  if (!result || !/^[a-z][a-z0-9_]*$/.test(result)) return null;
  return result;
}

/** Convert snake_case to camelCase for variable names. */
export function toCamelCase(input: string): string | null {
  const snake = toSnakeCase(input);
  if (!snake) return null;
  return snake.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
}

export function getPropName(prop: import('typescript').ObjectLiteralElementLike): string | null {
  if (!ts) return null;
  if ((ts.isPropertyAssignment(prop) || ts.isMethodDeclaration(prop)) &&
      prop.name && ts.isIdentifier(prop.name)) {
    return prop.name.text;
  }
  return null;
}

export function hasExportModifier(node: import('typescript').VariableStatement): boolean {
  if (!ts) return false;
  return node.modifiers?.some(m => m.kind === ts!.SyntaxKind.ExportKeyword) ?? false;
}
