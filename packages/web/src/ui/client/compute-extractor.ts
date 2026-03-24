/**
 * Extract, safety-check, and compile compute() function bodies from source text.
 * Also handles filtered() predicates and buffered() reduce functions.
 *
 * Safety model: compute() is documented as a pure function (states) => value.
 * We AST-check the function body for unsafe constructs before compiling.
 * The source comes from the user's own code in their editor (same trust model
 * as Monaco's TS worker executing user code).
 */

// TypeScript compiler API — shared with ast-analyzers
let ts: typeof import('typescript') | null = null;

export function setTypeScriptApi(tsApi: typeof import('typescript')) {
  ts = tsApi;
}

export type ComputeFn = (states: Record<string, { state: string | number }>) => string | number;
export type PredicateFn = (value: string | number) => boolean;
export type ReduceFn = (values: Array<string | number>) => string | number;

export interface ExtractedCompute {
  fnSource: string;
  watchIds: string[];
  debounce?: number;
  safe: boolean;
  unsafeReason?: string;
  compiled?: ComputeFn;
}

export interface ExtractedPredicate {
  fnSource: string;
  safe: boolean;
  unsafeReason?: string;
  compiled?: PredicateFn;
}

export interface ExtractedReduce {
  fnSource: string | null;
  builtinName?: string;
  safe: boolean;
  unsafeReason?: string;
  compiled?: ReduceFn;
}

// Globals that are safe to reference in compute/predicate/reduce bodies
const SAFE_GLOBALS = new Set([
  'Number', 'String', 'Math', 'parseInt', 'parseFloat', 'JSON',
  'Array', 'Object', 'Date', 'isNaN', 'isFinite',
  'undefined', 'null', 'NaN', 'Infinity', 'Boolean',
  'Map', 'Set', 'console',
]);

const UNSAFE_IDENTIFIERS = new Set([
  'fetch', 'XMLHttpRequest', 'document', 'window', 'localStorage',
  'sessionStorage', 'globalThis', 'eval', 'Function',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
  'importScripts', 'postMessage',
]);

// Built-in reduce functions for buffered()
const BUILTIN_REDUCERS: Record<string, ReduceFn> = {
  average: (vals) => {
    const nums = vals.map(Number).filter(n => !isNaN(n));
    return nums.length > 0 ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
  },
  sum: (vals) => vals.map(Number).filter(n => !isNaN(n)).reduce((a, b) => a + b, 0),
  min: (vals) => Math.min(...vals.map(Number).filter(n => !isNaN(n))),
  max: (vals) => Math.max(...vals.map(Number).filter(n => !isNaN(n))),
  last: (vals) => vals.length > 0 ? vals[vals.length - 1] : 0,
  count: (vals) => vals.length,
};

/**
 * Extract compute() function body and watch list from a computed() entity definition.
 */
export function extractCompute(sourceText: string, fullEntityId: string, fileName = 'file.ts'): ExtractedCompute | null {
  if (!ts) return null;
  const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);

  let result: ExtractedCompute | null = null;

  function visit(node: import('typescript').Node) {
    if (result) return;

    // Look for computed({ watch: [...], compute: (states) => ... })
    if (ts!.isCallExpression(node) && ts!.isIdentifier(node.expression) && node.expression.text === 'computed') {
      const arg = node.arguments[0];
      if (!arg || !ts!.isObjectLiteralExpression(arg)) { ts!.forEachChild(node, visit); return; }

      // Check if this is the right entity
      let id = '';
      let watchIds: string[] = [];
      let computeNode: import('typescript').Node | null = null;
      let debounce: number | undefined;

      for (const prop of arg.properties) {
        if (!ts!.isPropertyAssignment(prop) || !ts!.isIdentifier(prop.name)) continue;
        const name = prop.name.text;
        if (name === 'id' && ts!.isStringLiteral(prop.initializer)) {
          id = prop.initializer.text;
        } else if (name === 'watch') {
          if (ts!.isArrayLiteralExpression(prop.initializer)) {
            watchIds = prop.initializer.elements
              .filter((el): el is import('typescript').StringLiteral => ts!.isStringLiteral(el))
              .map(el => el.text);
          }
        } else if (name === 'compute') {
          computeNode = prop.initializer;
        } else if (name === 'debounce' && ts!.isNumericLiteral(prop.initializer)) {
          debounce = Number(prop.initializer.text);
        }
      }

      // Match by entity ID (without domain prefix)
      const entitySuffix = fullEntityId.includes('.') ? fullEntityId.split('.')[1] : fullEntityId;
      if (id !== entitySuffix || !computeNode) return;

      const fnSource = computeNode.getText(sf);
      const safetyResult = checkSafety(computeNode, sf);

      result = {
        fnSource,
        watchIds,
        debounce,
        safe: safetyResult.safe,
        unsafeReason: safetyResult.reason,
      };

      if (safetyResult.safe) {
        result.compiled = compileCompute(fnSource) || undefined;
      }
    }

    ts!.forEachChild(node, visit);
  }

  visit(sf);
  return result;
}

/**
 * Extract a filtered() predicate function.
 */
export function extractPredicate(sourceText: string, fullEntityId: string, fileName = 'file.ts'): ExtractedPredicate | null {
  if (!ts) return null;
  const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);

  let result: ExtractedPredicate | null = null;

  function visit(node: import('typescript').Node) {
    if (result) return;

    // Look for filtered(factory({...}), predicate)
    if (ts!.isCallExpression(node) && ts!.isIdentifier(node.expression) && node.expression.text === 'filtered') {
      // Find the inner factory to check entity ID
      if (node.arguments.length < 2) { ts!.forEachChild(node, visit); return; }
      const inner = node.arguments[0];
      if (!ts!.isCallExpression(inner)) { ts!.forEachChild(node, visit); return; }

      const entityId = extractEntityIdFromCall(inner);
      const entitySuffix = fullEntityId.includes('.') ? fullEntityId.split('.')[1] : fullEntityId;
      if (entityId !== entitySuffix) { ts!.forEachChild(node, visit); return; }

      const predNode = node.arguments[1];
      const fnSource = predNode.getText(sf);
      const safetyResult = checkSafety(predNode, sf);

      result = {
        fnSource,
        safe: safetyResult.safe,
        unsafeReason: safetyResult.reason,
      };

      if (safetyResult.safe) {
        result.compiled = compilePredicate(fnSource) || undefined;
      }
    }

    ts!.forEachChild(node, visit);
  }

  visit(sf);
  return result;
}

/**
 * Extract a buffered() reduce function or builtin reducer name.
 */
export function extractReduce(sourceText: string, fullEntityId: string, fileName = 'file.ts'): ExtractedReduce | null {
  if (!ts) return null;
  const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);

  let result: ExtractedReduce | null = null;

  function visit(node: import('typescript').Node) {
    if (result) return;

    // Look for buffered(factory({...}), { reduce: ... })
    if (ts!.isCallExpression(node) && ts!.isIdentifier(node.expression) && node.expression.text === 'buffered') {
      if (node.arguments.length < 2) { ts!.forEachChild(node, visit); return; }
      const inner = node.arguments[0];
      if (!ts!.isCallExpression(inner)) { ts!.forEachChild(node, visit); return; }

      const entityId = extractEntityIdFromCall(inner);
      const entitySuffix = fullEntityId.includes('.') ? fullEntityId.split('.')[1] : fullEntityId;
      if (entityId !== entitySuffix) { ts!.forEachChild(node, visit); return; }

      const optsArg = node.arguments[1];
      if (!ts!.isObjectLiteralExpression(optsArg)) { ts!.forEachChild(node, visit); return; }

      for (const prop of optsArg.properties) {
        if (!ts!.isPropertyAssignment(prop) || !ts!.isIdentifier(prop.name) || prop.name.text !== 'reduce') continue;

        // Check for builtin reducer identifier
        if (ts!.isIdentifier(prop.initializer)) {
          const name = prop.initializer.text;
          if (BUILTIN_REDUCERS[name]) {
            result = { fnSource: null, builtinName: name, safe: true, compiled: BUILTIN_REDUCERS[name] };
            return;
          }
        }

        // Custom reduce function
        const fnSource = prop.initializer.getText(sf);
        const safetyResult = checkSafety(prop.initializer, sf);
        result = {
          fnSource,
          safe: safetyResult.safe,
          unsafeReason: safetyResult.reason,
        };
        if (safetyResult.safe) {
          result.compiled = compileReduce(fnSource) || undefined;
        }
      }
    }

    ts!.forEachChild(node, visit);
  }

  visit(sf);
  return result;
}

function extractEntityIdFromCall(call: import('typescript').CallExpression): string | null {
  if (!ts) return null;
  const arg = call.arguments[0];
  if (!arg || !ts.isObjectLiteralExpression(arg)) return null;
  for (const prop of arg.properties) {
    if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) &&
        prop.name.text === 'id' && ts.isStringLiteral(prop.initializer)) {
      return prop.initializer.text;
    }
  }
  return null;
}

/**
 * Check if an AST node (function body) is safe to compile.
 */
function checkSafety(node: import('typescript').Node, sf: import('typescript').SourceFile): { safe: boolean; reason?: string } {
  if (!ts) return { safe: false, reason: 'TypeScript API not loaded' };

  let unsafe: string | undefined;

  function walk(n: import('typescript').Node) {
    if (unsafe) return;

    // await expression
    if (n.kind === ts!.SyntaxKind.AwaitExpression) {
      unsafe = 'contains await'; return;
    }

    // this keyword
    if (n.kind === ts!.SyntaxKind.ThisKeyword) {
      unsafe = 'references this'; return;
    }

    // dynamic import
    if (ts!.isCallExpression(n) && n.expression.kind === ts!.SyntaxKind.ImportKeyword) {
      unsafe = 'contains dynamic import()'; return;
    }

    // Check identifier references
    if (ts!.isIdentifier(n)) {
      const name = n.text;
      if (UNSAFE_IDENTIFIERS.has(name)) {
        unsafe = `references unsafe global: ${name}`;
        return;
      }
    }

    ts!.forEachChild(n, walk);
  }

  walk(node);
  return unsafe ? { safe: false, reason: unsafe } : { safe: true };
}

/**
 * Compile a compute function source string.
 * Only called after safety check passes.
 */
function compileCompute(fnSource: string): ComputeFn | null {
  try {
    const fn = (0, eval)(`(${fnSource})`);
    return typeof fn === 'function' ? fn as ComputeFn : null;
  } catch { return null; }
}

function compilePredicate(fnSource: string): PredicateFn | null {
  try {
    const fn = (0, eval)(`(${fnSource})`);
    return typeof fn === 'function' ? fn as PredicateFn : null;
  } catch { return null; }
}

function compileReduce(fnSource: string): ReduceFn | null {
  try {
    const fn = (0, eval)(`(${fnSource})`);
    return typeof fn === 'function' ? fn as ReduceFn : null;
  } catch { return null; }
}
