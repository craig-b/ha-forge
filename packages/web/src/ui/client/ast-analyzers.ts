/**
 * AST-based code analyzers for Monaco editor.
 *
 * Uses TypeScript's compiler API (ts.createSourceFile) to parse source
 * files and walk the AST for structural analysis that regex can't express:
 * factory call validation, scope analysis, entity ID extraction, etc.
 *
 * Designed to coexist with the regex analyzers in analyzers.ts — each
 * system uses a separate marker owner so diagnostics don't interfere.
 */

import type { AnalyzerDiagnostic } from './analyzers.js';
import { FACTORY_NAMES } from './analyzers.js';

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

// Behavior wrapper names that pass through to an inner factory call
const WRAPPER_NAMES = new Set([
  'debounced', 'filtered', 'sampled', 'buffered',
]);

interface EntityInfo {
  id: string;
  line: number;
  startCol: number;
  endCol: number;
}

export interface AstAnalysisResult {
  diagnostics: AnalyzerDiagnostic[];
  entities: EntityInfo[];
}

/**
 * Run all AST-based analyzers on a source file.
 * Returns diagnostics and extracted entity info (for cross-file analysis).
 */
export function analyzeWithAst(sourceText: string, fileName = 'file.ts'): AstAnalysisResult {
  if (!ts) return { diagnostics: [], entities: [] };

  const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, /* setParentNodes */ true);
  const diagnostics: AnalyzerDiagnostic[] = [];
  const entities: EntityInfo[] = [];

  visit(sf);
  checkUnexportedEntities(sf, diagnostics);
  return { diagnostics, entities };

  function visit(node: import('typescript').Node) {
    if (ts!.isCallExpression(node)) {
      checkFactoryCall(node, sf, diagnostics, entities);
      checkAwaitOnFactory(node, sf, diagnostics);
    }

    if (ts!.isPropertyAccessExpression(node) &&
        node.expression.kind === ts!.SyntaxKind.ThisKeyword) {
      const methodName = node.name.text;
      if (methodName === 'poll' || methodName === 'setTimeout' || methodName === 'setInterval') {
        checkThisMethodScope(node, sf, diagnostics, methodName);
      }
    }

    // Bare setTimeout/setInterval (not this.setTimeout)
    if (ts!.isCallExpression(node) && ts!.isIdentifier(node.expression)) {
      const name = node.expression.text;
      if (name === 'setTimeout' || name === 'setInterval') {
        checkBareTimer(node, sf, diagnostics, name);
      }
    }

    ts!.forEachChild(node, visit);
  }
}

// ---- Factory call validation ----

function getCalledName(node: import('typescript').CallExpression): string | null {
  if (!ts) return null;
  if (ts.isIdentifier(node.expression)) return node.expression.text;
  if (ts.isPropertyAccessExpression(node.expression)) return node.expression.name.text;
  return null;
}

/** Unwrap behavior wrappers to find the innermost factory call. */
function findFactoryCall(node: import('typescript').CallExpression): import('typescript').CallExpression | null {
  if (!ts) return null;
  const name = getCalledName(node);
  if (name && FACTORY_NAMES.includes(name)) return node;
  if (name && WRAPPER_NAMES.has(name) && node.arguments.length > 0) {
    const inner = node.arguments[0];
    if (ts.isCallExpression(inner)) return findFactoryCall(inner);
  }
  return null;
}

function checkFactoryCall(
  node: import('typescript').CallExpression,
  sf: import('typescript').SourceFile,
  diagnostics: AnalyzerDiagnostic[],
  entities: EntityInfo[],
) {
  if (!ts) return;
  const name = getCalledName(node);
  if (!name || !FACTORY_NAMES.includes(name)) return;

  // computed() has different required fields (watch, compute)
  if (name === 'computed') return;
  // automation, task, cron, mode don't require 'name'
  const requiresName = !['automation', 'task', 'cron'].includes(name);

  const arg = node.arguments[0];
  if (!arg || !ts.isObjectLiteralExpression(arg)) return;

  const props = new Map<string, import('typescript').Node>();
  for (const prop of arg.properties) {
    if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
      props.set(prop.name.text, prop.initializer);
    } else if (ts.isMethodDeclaration(prop) && prop.name && ts.isIdentifier(prop.name)) {
      props.set(prop.name.text, prop);
    } else if (ts.isShorthandPropertyAssignment(prop)) {
      props.set(prop.name.text, prop);
    }
  }

  if (!props.has('id')) {
    diagnostics.push(markerAt(arg, sf, `${name}() missing required 'id' property`, 'error'));
  }
  if (requiresName && !props.has('name')) {
    diagnostics.push(markerAt(arg, sf, `${name}() missing required 'name' property`, 'error'));
  }

  // Validate entity ID format
  const idNode = props.get('id');
  if (idNode && ts.isStringLiteral(idNode)) {
    const id = idNode.text;

    // Extract for cross-file duplicate checking
    const { line } = sf.getLineAndCharacterOfPosition(idNode.getStart(sf));
    const start = idNode.getStart(sf) - sf.getLineStarts()[line];
    entities.push({
      id,
      line: line + 1,
      startCol: start + 1,
      endCol: start + 1 + idNode.getWidth(sf),
    });

    // snake_case validation: lowercase letters, digits, underscores
    if (!/^[a-z][a-z0-9_]*$/.test(id)) {
      const suggested = toSnakeCase(id);
      const hint = suggested && suggested !== id ? ` (suggested: '${suggested}')` : '';
      diagnostics.push(markerAt(idNode, sf,
        `Entity ID '${id}' should be snake_case${hint}`,
        'warning',
      ));
    }
  }

  // Check for empty init()
  const initNode = props.get('init');
  if (initNode && (ts.isMethodDeclaration(initNode) || ts.isFunctionExpression(initNode) || ts.isArrowFunction(initNode))) {
    const body = 'body' in initNode ? initNode.body : undefined;
    if (body && ts.isBlock(body) && body.statements.length === 0) {
      diagnostics.push(markerAt(initNode, sf, `Empty init() — did you forget to set up state updates?`, 'info'));
    }
  }
}

// ---- await on factory call ----

function checkAwaitOnFactory(
  node: import('typescript').CallExpression,
  sf: import('typescript').SourceFile,
  diagnostics: AnalyzerDiagnostic[],
) {
  if (!ts) return;
  // Check if this call (or an inner factory via wrappers) is awaited
  const factory = findFactoryCall(node);
  if (!factory) return;
  const factoryName = getCalledName(factory);
  if (!factoryName) return;

  // Walk up to see if we're inside an AwaitExpression
  // Only check the immediate parent chain — don't cross function boundaries
  let current: import('typescript').Node = node;
  while (current.parent) {
    if (ts.isAwaitExpression(current.parent) && current.parent.expression === current) {
      diagnostics.push(markerAt(current.parent, sf,
        `Do not await ${factoryName}() — entity factories return synchronously`,
        'warning',
      ));
      return;
    }
    // Stop at expression boundaries
    if (ts.isExpressionStatement(current.parent)) break;
    if (ts.isVariableDeclaration(current.parent)) break;
    current = current.parent;
  }
}

// ---- this.poll() / this.setTimeout() / this.setInterval() outside init() ----

function checkThisMethodScope(
  node: import('typescript').PropertyAccessExpression,
  sf: import('typescript').SourceFile,
  diagnostics: AnalyzerDiagnostic[],
  methodName: string,
) {
  if (!ts) return;

  // Walk up to find the enclosing function boundary
  let current: import('typescript').Node | undefined = node.parent;
  while (current) {
    if (ts.isMethodDeclaration(current) && current.name && ts.isIdentifier(current.name)) {
      if (current.name.text === 'init' || current.name.text === 'onCommand' || current.name.text === 'destroy') {
        return; // Valid scope
      }
      break;
    }
    if (ts.isFunctionExpression(current) || ts.isArrowFunction(current)) {
      // Check if this function is the value of an init/onCommand/destroy property
      if (current.parent && ts.isPropertyAssignment(current.parent) &&
          ts.isIdentifier(current.parent.name)) {
        const propName = current.parent.name.text;
        if (propName === 'init' || propName === 'onCommand' || propName === 'destroy') {
          return; // Valid scope
        }
      }
      // Arrow/function inside init is fine (callbacks within init)
      // Keep walking up to see if we're nested inside init
      current = current.parent;
      continue;
    }
    current = current.parent;
  }

  diagnostics.push(markerAt(node, sf,
    `this.${methodName}() should be called inside init(), onCommand(), or destroy()`,
    'warning',
  ));
}

// ---- Bare setTimeout/setInterval ----

function checkBareTimer(
  node: import('typescript').CallExpression,
  sf: import('typescript').SourceFile,
  diagnostics: AnalyzerDiagnostic[],
  name: string,
) {
  if (!ts) return;

  // Check we're inside an init/onCommand/destroy scope (entity context)
  // If so, suggest this.setTimeout instead
  let current: import('typescript').Node | undefined = node.parent;
  let insideEntityMethod = false;
  while (current) {
    if (ts.isMethodDeclaration(current) && current.name && ts.isIdentifier(current.name)) {
      if (['init', 'onCommand', 'destroy'].includes(current.name.text)) {
        insideEntityMethod = true;
      }
      break;
    }
    if (ts.isFunctionExpression(current) || ts.isArrowFunction(current)) {
      if (current.parent && ts.isPropertyAssignment(current.parent) &&
          ts.isIdentifier(current.parent.name) &&
          ['init', 'onCommand', 'destroy'].includes(current.parent.name.text)) {
        insideEntityMethod = true;
        break;
      }
    }
    current = current.parent;
  }

  if (insideEntityMethod) {
    diagnostics.push(markerAt(node.expression, sf,
      `Use this.${name}() instead of ${name}() — managed timers are auto-cleared on teardown`,
      'warning',
    ));
  }
}

// ---- Unexported entity definitions ----

function checkUnexportedEntities(
  sf: import('typescript').SourceFile,
  diagnostics: AnalyzerDiagnostic[],
) {
  if (!ts) return;

  // Collect names that are re-exported via `export { name }` statements
  const reExported = new Set<string>();
  for (const stmt of sf.statements) {
    if (ts.isExportDeclaration(stmt) && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
      for (const spec of stmt.exportClause.elements) {
        reExported.add((spec.propertyName ?? spec.name).text);
      }
    }
  }

  for (const stmt of sf.statements) {
    // Bare factory/wrapper call as expression statement: sensor({...}) or debounced(sensor({...}))
    if (ts.isExpressionStatement(stmt) && ts.isCallExpression(stmt.expression)) {
      const factory = findFactoryCall(stmt.expression);
      if (factory) {
        const factoryName = getCalledName(factory);
        diagnostics.push(markerAt(stmt.expression, sf,
          `${factoryName}() result is not assigned or exported — it will not be deployed`,
          'warning',
        ));
      }
    }

    // Variable declaration without export: const x = sensor({...}) or const x = debounced(sensor({...}))
    if (ts.isVariableStatement(stmt) && !hasExportModifier(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (!decl.initializer || !ts.isCallExpression(decl.initializer)) continue;
        const factory = findFactoryCall(decl.initializer);
        if (!factory) continue;
        const factoryName = getCalledName(factory);
        const varName = ts.isIdentifier(decl.name) ? decl.name.text : '?';

        // Skip if re-exported
        if (reExported.has(varName)) continue;

        diagnostics.push(markerAt(decl.name, sf,
          `'${varName}' is created by ${factoryName}() but is not exported — it will not be deployed`,
          'warning',
        ));
      }
    }
  }
}

function hasExportModifier(node: import('typescript').VariableStatement): boolean {
  if (!ts) return false;
  return node.modifiers?.some(m => m.kind === ts!.SyntaxKind.ExportKeyword) ?? false;
}

// ---- Snake case conversion ----

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

// ---- Helpers ----

function markerAt(
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
