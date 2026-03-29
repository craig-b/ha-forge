/**
 * AST-based code action generators for Monaco editor quick-fixes.
 *
 * Extracted from ast-analyzers.ts — these functions generate refactoring
 * edits: sensor→computed conversion, device grouping, move-into-device,
 * and device info insertion.
 */

import {
  getTs, getCalledName, findFactoryCall, getPropName, hasExportModifier,
  toSnakeCase, toCamelCase,
} from './ast-helpers.js';

// ---- Convert sensor to computed() ----

export interface SensorToComputedEdit {
  /** The replacement text (computed({...})) */
  text: string;
  /** Range of the statement to replace (1-based lines) */
  startLine: number;
  endLine: number;
}

/**
 * Convert a sensor-with-events-only init to computed().
 * Returns null if the pattern doesn't match the simple convertible case.
 */
export function generateSensorToComputed(
  sourceText: string,
  fileName: string,
  initLine: number,
): SensorToComputedEdit | null {
  const ts = getTs();
  if (!ts) return null;

  const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);

  // Find the sensor() call containing the init at this line
  let sensorCall: import('typescript').CallExpression | null = null;
  let outerExpr: import('typescript').CallExpression | null = null;
  let stmt: import('typescript').Statement | null = null;
  let varName: string | null = null;
  let isExported = false;

  for (const s of sf.statements) {
    if (ts.isVariableStatement(s)) {
      isExported = hasExportModifier(s);
      for (const decl of s.declarationList.declarations) {
        if (!decl.initializer || !ts.isCallExpression(decl.initializer)) continue;
        const factory = findFactoryCall(decl.initializer);
        if (!factory || getCalledName(factory) !== 'sensor') continue;

        // Check if the init is on the target line
        const initProp = findPropInFactory(factory, 'init');
        if (!initProp) continue;
        const { line } = sf.getLineAndCharacterOfPosition(initProp.getStart(sf));
        if (line + 1 === initLine) {
          sensorCall = factory;
          outerExpr = decl.initializer;
          stmt = s;
          varName = ts.isIdentifier(decl.name) ? decl.name.text : null;
        }
      }
    }
    if (ts.isExportAssignment(s) && !s.isExportEquals && ts.isCallExpression(s.expression)) {
      const factory = findFactoryCall(s.expression);
      if (!factory || getCalledName(factory) !== 'sensor') continue;
      const initProp = findPropInFactory(factory, 'init');
      if (!initProp) continue;
      const { line } = sf.getLineAndCharacterOfPosition(initProp.getStart(sf));
      if (line + 1 === initLine) {
        sensorCall = factory;
        outerExpr = s.expression;
        stmt = s;
        isExported = true;
      }
    }
  }

  if (!sensorCall || !stmt) return null;

  const arg = sensorCall.arguments[0];
  if (!arg || !ts.isObjectLiteralExpression(arg)) return null;

  // Extract sensor properties
  const sensorProps = new Map<string, import('typescript').Node>();
  for (const prop of arg.properties) {
    const name = getPropName(prop);
    if (name) sensorProps.set(name, prop);
  }

  // Find init body
  const initNode = sensorProps.get('init');
  if (!initNode) return null;
  let initBody: import('typescript').Block | null = null;
  if (ts.isMethodDeclaration(initNode) && initNode.body) initBody = initNode.body;
  if (ts.isFunctionExpression(initNode) && initNode.body) initBody = initNode.body;
  if (ts.isArrowFunction(initNode)) {
    if (ts.isBlock(initNode.body)) initBody = initNode.body;
  }
  if (!initBody) return null;

  // Extract this.events.stream('entityId')...subscribe(callback) patterns
  interface WatchEntry { entityId: string; paramName: string; updateExpr: string }
  const watches: WatchEntry[] = [];

  /**
   * Walk a chain of method calls to find this.events.stream('entityId') at the root.
   * Returns the entity ID string or null.
   */
  const findStreamEntityId = (node: import('typescript').Expression): string | null => {
    if (ts!.isCallExpression(node) && ts!.isPropertyAccessExpression(node.expression)) {
      const prop = node.expression;
      if (prop.name.text === 'stream' &&
          ts!.isPropertyAccessExpression(prop.expression) &&
          prop.expression.name.text === 'events' &&
          prop.expression.expression.kind === ts!.SyntaxKind.ThisKeyword) {
        if (node.arguments.length >= 1 && ts!.isStringLiteral(node.arguments[0])) {
          return node.arguments[0].text;
        }
        return null;
      }
      // Recurse into the chain (e.g. .filter().debounce() wrapping stream())
      return findStreamEntityId(prop.expression);
    }
    return null;
  };

  for (const s of initBody.statements) {
    if (!ts.isExpressionStatement(s) || !ts.isCallExpression(s.expression)) {
      // Allow return statements (initial value)
      if (ts.isReturnStatement(s)) continue;
      return null; // unexpected statement
    }
    const call = s.expression;
    const callProp = call.expression;

    // Match ...subscribe(callback) at the end of the chain
    if (!ts.isPropertyAccessExpression(callProp) || callProp.name.text !== 'subscribe') return null;
    // Walk the chain to find this.events.stream('entityId')
    const entityId = findStreamEntityId(callProp.expression);
    if (!entityId) return null;

    // First arg of .subscribe(): callback — extract parameter name and find this.update(expr)
    if (call.arguments.length < 1) return null;
    const cb = call.arguments[0];
    let paramName = 'e';
    let cbBody: import('typescript').Node | null = null;

    if (ts.isArrowFunction(cb)) {
      if (cb.parameters.length > 0 && ts.isIdentifier(cb.parameters[0].name)) {
        paramName = cb.parameters[0].name.text;
      }
      cbBody = cb.body;
    } else if (ts.isFunctionExpression(cb)) {
      if (cb.parameters.length > 0 && ts.isIdentifier(cb.parameters[0].name)) {
        paramName = cb.parameters[0].name.text;
      }
      cbBody = cb.body;
    }
    if (!cbBody) return null;

    // Extract the update expression: this.update(expr) — may be the body directly or in a block
    let updateExpr: string | null = null;
    if (ts.isBlock(cbBody)) {
      for (const cs of cbBody.statements) {
        if (!ts.isExpressionStatement(cs)) return null;
        updateExpr = extractUpdateExpr(cs.expression, sf, sourceText);
        if (!updateExpr) return null;
      }
    } else {
      // Arrow with expression body: (e) => this.update(expr)
      updateExpr = extractUpdateExpr(cbBody, sf, sourceText);
    }
    if (!updateExpr) return null;

    watches.push({ entityId, paramName, updateExpr });
  }

  if (watches.length === 0) return null;

  // Build compute body — rewrite e.new_state → states['entityId']?.state
  const watchIds = watches.map(w => w.entityId);
  let computeBody: string;
  if (watches.length === 1) {
    let expr = watches[0].updateExpr;
    // Replace paramName.new_state with states['entityId']?.state
    const p = watches[0].paramName;
    expr = expr.replace(new RegExp(`${escapeRegExp(p)}\\.new_state`, 'g'), `states['${watches[0].entityId}']?.state`);
    computeBody = `(states) => ${expr}`;
  } else {
    // Multiple watchers — more complex, generate a block body
    const lines = watches.map(w => {
      let expr = w.updateExpr;
      expr = expr.replace(new RegExp(`${escapeRegExp(w.paramName)}\\.new_state`, 'g'), `states['${w.entityId}']?.state`);
      return expr;
    });
    // This case is tricky — multiple events.on each calling this.update with different logic.
    // For now, use the last one (they all update the same sensor)
    computeBody = `(states) => ${lines[lines.length - 1]}`;
  }

  // Build computed() properties — preserve id, name, config, device; replace init with watch+compute
  const indent = '  ';
  const propLines: string[] = [];
  for (const [key, node] of sensorProps) {
    if (key === 'init' || key === 'destroy') continue;
    propLines.push(`${indent}${sourceText.slice(node.getStart(sf), node.getEnd())},`);
  }
  propLines.push(`${indent}watch: [${watchIds.map(id => `'${id}'`).join(', ')}],`);
  propLines.push(`${indent}compute: ${computeBody},`);

  const computedCall = `computed({\n${propLines.join('\n')}\n})`;

  // Build the full statement
  const stmtStart = sf.getLineAndCharacterOfPosition(stmt.getStart(sf));
  const stmtEnd = sf.getLineAndCharacterOfPosition(stmt.getEnd());

  let fullText: string;
  if (ts.isExportAssignment(stmt)) {
    fullText = `export default ${computedCall};`;
  } else {
    const exportPrefix = isExported ? 'export ' : '';
    const varPrefix = varName ? `${exportPrefix}const ${varName} = ` : exportPrefix;
    fullText = `${varPrefix}${computedCall};`;
  }

  return {
    text: fullText,
    startLine: stmtStart.line + 1,
    endLine: stmtEnd.line + 1,
  };
}

function findPropInFactory(call: import('typescript').CallExpression, propName: string): import('typescript').Node | null {
  const ts = getTs();
  if (!ts) return null;
  const arg = call.arguments[0];
  if (!arg || !ts.isObjectLiteralExpression(arg)) return null;
  for (const prop of arg.properties) {
    if (getPropName(prop) === propName) return prop;
  }
  return null;
}

function extractUpdateExpr(
  node: import('typescript').Node,
  sf: import('typescript').SourceFile,
  sourceText: string,
): string | null {
  const ts = getTs();
  if (!ts) return null;
  // this.update(expr)
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.kind === ts.SyntaxKind.ThisKeyword &&
      node.expression.name.text === 'update' && node.arguments.length === 1) {
    return sourceText.slice(node.arguments[0].getStart(sf), node.arguments[0].getEnd());
  }
  return null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---- Device refactor suggestion ----

interface StandaloneEntity {
  varName: string;
  memberKey: string;
  factoryName: string;
  /** Full source text of the initializer expression (e.g. `sensor({ ... })`) */
  exprText: string;
  /** The statement node for range info */
  startLine: number;
  endLine: number;
}

/** Names of factories that can be device members. */
const DEVICE_MEMBER_NAMES = new Set([
  'sensor', 'binarySensor', 'light', 'defineSwitch', 'cover', 'climate',
  'fan', 'lock', 'number', 'select', 'text', 'button', 'siren',
  'humidifier', 'valve', 'waterHeater', 'vacuum', 'lawnMower',
  'alarmControlPanel', 'computed',
  'automation', 'task', 'cron', 'mode',
  'notify', 'update', 'image',
]);

export function collectStandaloneEntities(
  sf: import('typescript').SourceFile,
  sourceText: string,
): StandaloneEntity[] {
  const ts = getTs();
  if (!ts) return [];
  const results: StandaloneEntity[] = [];

  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    // Only exported declarations count — unexported ones get a different warning
    if (!hasExportModifier(stmt)) continue;

    for (const decl of stmt.declarationList.declarations) {
      if (!decl.initializer || !ts.isCallExpression(decl.initializer)) continue;
      const factory = findFactoryCall(decl.initializer);
      if (!factory) continue;
      const factoryName = getCalledName(factory);
      if (!factoryName || !DEVICE_MEMBER_NAMES.has(factoryName)) continue;

      const varName = ts.isIdentifier(decl.name) ? decl.name.text : null;
      if (!varName) continue;

      // Check if the entity has a device prop that needs stripping
      // (device grouping moves to device level).
      // init/destroy are preserved — autonomous members keep their own lifecycle.
      const arg = factory.arguments[0];
      let hasDevice = false;
      if (arg && ts.isObjectLiteralExpression(arg)) {
        for (const prop of arg.properties) {
          if (getPropName(prop) === 'device') {
            hasDevice = true;
            break;
          }
        }
      }

      const exprText = hasDevice
        ? removePropsFromExpr(decl.initializer, sourceText, sf, ['device'])
        : sourceText.slice(decl.initializer.getStart(sf), decl.initializer.getEnd());

      const { line: sl } = sf.getLineAndCharacterOfPosition(stmt.getStart(sf));
      const { line: el } = sf.getLineAndCharacterOfPosition(stmt.getEnd());

      results.push({
        varName,
        memberKey: varName,
        factoryName,
        exprText,
        startLine: sl + 1,
        endLine: el + 1,
      });
    }
  }

  return results;
}

/**
 * Return the expression text with named properties removed from the inner factory call.
 */
function removePropsFromExpr(
  expr: import('typescript').CallExpression,
  sourceText: string,
  sf: import('typescript').SourceFile,
  propsToRemove: string[],
): string {
  const ts = getTs();
  if (!ts) return sourceText.slice(expr.getStart(sf), expr.getEnd());

  const factory = findFactoryCall(expr) ?? expr;
  const arg = factory.arguments[0];
  if (!arg || !ts.isObjectLiteralExpression(arg)) {
    return sourceText.slice(expr.getStart(sf), expr.getEnd());
  }

  const removeSet = new Set(propsToRemove);
  const removals: Array<{ start: number; end: number }> = [];
  const props = arg.properties;
  for (let i = 0; i < props.length; i++) {
    const propName = getPropName(props[i]);
    if (propName && removeSet.has(propName)) {
      let start = props[i].getStart(sf);
      let end = props[i].getEnd();
      // Remove trailing comma if present
      const afterEnd = sourceText.slice(end).match(/^\s*,/);
      if (afterEnd) {
        end += afterEnd[0].length;
      } else if (i > 0) {
        // Remove leading comma instead
        const beforeStart = sourceText.slice(0, start);
        const leadingComma = beforeStart.match(/,\s*$/);
        if (leadingComma) {
          start -= leadingComma[0].length;
        }
      }
      removals.push({ start, end });
    }
  }

  if (removals.length === 0) {
    return sourceText.slice(expr.getStart(sf), expr.getEnd());
  }

  // Build result by splicing out removals
  let result = '';
  let pos = expr.getStart(sf);
  for (const { start, end } of removals.sort((a, b) => a.start - b.start)) {
    result += sourceText.slice(pos, start);
    pos = end;
  }
  result += sourceText.slice(pos, expr.getEnd());
  // Clean up consecutive blank lines left by removal
  return result.replace(/\n\s*\n\s*\n/g, '\n\n');
}

/**
 * Generate the refactored source text that wraps standalone entities in a device().
 * Called from the code action provider.
 */
export function generateDeviceRefactor(sourceText: string, fileName: string): string | null {
  const ts = getTs();
  if (!ts) return null;

  const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const entities = collectStandaloneEntities(sf, sourceText);
  if (entities.length < 2) return null;

  // Derive device ID and name from filename
  const baseName = fileName.replace(/^.*\//, '').replace(/\.\w+$/, '');
  const deviceId = toSnakeCase(baseName) ?? baseName;
  const deviceVarName = toCamelCase(baseName) ?? 'myDevice';
  const deviceDisplayName = deviceId.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

  // Build the members block — re-indent each expression to 6 spaces
  // init/destroy are preserved on each entity (autonomous members keep their own lifecycle)
  const membersLines = entities.map(ent => {
    const indented = reindent(ent.exprText, 6);
    return `    ${ent.memberKey}: ${indented},`;
  }).join('\n');

  const deviceDecl = `export const ${deviceVarName} = device({
  id: '${deviceId}',
  name: '${deviceDisplayName}',
  entities: {
${membersLines}
  },
});`;

  // Replace the entity declarations in the source with the device declaration
  // Find the range from first entity to last entity
  const lines = sourceText.split('\n');
  const firstLine = entities[0].startLine - 1; // 0-based
  const lastLine = entities[entities.length - 1].endLine; // exclusive

  const before = lines.slice(0, firstLine).join('\n');
  const after = lines.slice(lastLine).join('\n');

  const parts = [before, deviceDecl, after].filter(p => p.length > 0);
  return parts.join('\n\n');
}

// ---- Move standalone entity into existing device ----

export interface MoveIntoDeviceEdit {
  /** Member key for the entities block (camelCase var name) */
  memberKey: string;
  /** Text to insert as a new member (already indented) */
  insertText: string;
  /** Line to insert at (end of the entities block, before closing brace) */
  insertLine: number;
  insertCol: number;
  /** Range of the standalone statement to delete */
  deleteStartLine: number;
  deleteEndLine: number;
}

/**
 * Generate edit info for moving a standalone entity into the existing device.
 * Returns null if the entity or device cannot be found.
 */
export function generateMoveIntoDevice(
  sourceText: string,
  fileName: string,
  entityStartLine: number,
): MoveIntoDeviceEdit | null {
  const ts = getTs();
  if (!ts) return null;

  const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);

  // Find the device() call and its entities block
  let deviceCall: import('typescript').CallExpression | null = null;
  for (const stmt of sf.statements) {
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (decl.initializer && ts.isCallExpression(decl.initializer) && getCalledName(decl.initializer) === 'device') {
          deviceCall = decl.initializer;
        }
      }
    }
    if (ts.isExportAssignment(stmt) && !stmt.isExportEquals && ts.isCallExpression(stmt.expression) && getCalledName(stmt.expression) === 'device') {
      deviceCall = stmt.expression;
    }
  }
  if (!deviceCall) return null;

  // Find the entities property in device({ ..., entities: { ... } })
  const deviceArg = deviceCall.arguments[0];
  if (!deviceArg || !ts.isObjectLiteralExpression(deviceArg)) return null;

  let entitiesObj: import('typescript').ObjectLiteralExpression | null = null;
  for (const prop of deviceArg.properties) {
    if (ts.isPropertyAssignment(prop) && getPropName(prop) === 'entities' && ts.isObjectLiteralExpression(prop.initializer)) {
      entitiesObj = prop.initializer;
      break;
    }
  }
  if (!entitiesObj) return null;

  // Find the standalone entity at the given line
  const entities = collectStandaloneEntities(sf, sourceText);
  const entity = entities.find(e => e.startLine === entityStartLine);
  if (!entity) return null;

  // Find insertion point: just before the closing brace of the entities object
  const closeBrace = entitiesObj.getEnd() - 1; // position of '}'
  const { line: insertLine } = sf.getLineAndCharacterOfPosition(closeBrace);

  // Determine indent from existing members or default to 4 spaces
  let memberIndent = '    '; // 4 spaces default
  if (entitiesObj.properties.length > 0) {
    const firstProp = entitiesObj.properties[0];
    const { character } = sf.getLineAndCharacterOfPosition(firstProp.getStart(sf));
    memberIndent = ' '.repeat(character);
  }

  const indentedExpr = reindent(entity.exprText, memberIndent.length + 2);
  const insertText = `${memberIndent}${entity.memberKey}: ${indentedExpr},\n`;

  return {
    memberKey: entity.memberKey,
    insertText,
    insertLine: insertLine + 1, // 1-based
    insertCol: 1,
    deleteStartLine: entity.startLine,
    deleteEndLine: entity.endLine,
  };
}

// ---- Fill in device info ----

export interface DeviceInfoInsertion {
  /** Line of the object literal's closing brace (where we insert before) */
  insertLine: number;
  /** Column of the closing brace */
  insertCol: number;
  /** Text to insert (the device property) */
  text: string;
  /** Whether a leading comma is needed */
  needsComma: boolean;
}

/**
 * If the cursor is on a factory call that has no `device` property,
 * return the insertion point and derived device info text.
 */
export function getDeviceInfoInsertion(
  sourceText: string,
  fileName: string,
  cursorLine: number,
): DeviceInfoInsertion | null {
  const ts = getTs();
  if (!ts) return null;

  const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const baseName = fileName.replace(/^.*\//, '').replace(/\.\w+$/, '');
  const deviceId = toSnakeCase(baseName) ?? baseName;
  const deviceName = deviceId.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

  // Find a factory call at the cursor line
  let result: DeviceInfoInsertion | null = null;

  function visit(node: import('typescript').Node) {
    if (!ts || result) return;

    if (ts.isCallExpression(node)) {
      const factory = findFactoryCall(node);
      if (factory) {
        const arg = factory.arguments[0];
        if (arg && ts.isObjectLiteralExpression(arg)) {
          const { line: objStart } = sf.getLineAndCharacterOfPosition(arg.getStart(sf));
          const { line: objEnd } = sf.getLineAndCharacterOfPosition(arg.getEnd());

          // Check if cursor is within this object literal's range
          if (cursorLine >= objStart + 1 && cursorLine <= objEnd + 1) {
            // Check if device property already exists
            const hasDevice = arg.properties.some(p => getPropName(p) === 'device');
            if (hasDevice) return;

            // Find insertion point: before the closing brace
            const closeBrace = arg.getEnd() - 1; // position of '}'
            const { line: closeLine, character: closeChar } = sf.getLineAndCharacterOfPosition(closeBrace);

            // Check if last property has a trailing comma
            const lastProp = arg.properties[arg.properties.length - 1];
            let needsComma = false;
            if (lastProp) {
              const afterLast = sourceText.slice(lastProp.getEnd(), closeBrace);
              needsComma = !afterLast.includes(',');
            }

            // Detect indentation from existing properties
            let indent = '  ';
            if (arg.properties.length > 0) {
              const firstProp = arg.properties[0];
              const { character } = sf.getLineAndCharacterOfPosition(firstProp.getStart(sf));
              indent = ' '.repeat(character);
            }

            const deviceText = [
              `${indent}device: {`,
              `${indent}  id: '${deviceId}',`,
              `${indent}  name: '${deviceName}',`,
              `${indent}  manufacturer: 'ha-forge',`,
              `${indent}  model: 'User Script',`,
              `${indent}},`,
            ].join('\n');

            result = {
              insertLine: closeLine + 1,
              insertCol: closeChar + 1,
              text: (needsComma ? ',\n' : '\n') + deviceText + '\n',
              needsComma,
            };
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sf);
  return result;
}

// ---- Helpers ----

/** Extract the entity ID from a factory call and suggest a camelCase variable name. */
export function suggestVarName(
  factory: import('typescript').CallExpression,
  factoryName: string | null,
  usedNames: Set<string>,
  fileName: string,
): string | null {
  const ts = getTs();
  if (!ts) return null;

  // 1. Try id-based camelCase name
  const arg = factory.arguments[0];
  if (arg && ts.isObjectLiteralExpression(arg)) {
    for (const prop of arg.properties) {
      if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) &&
          prop.name.text === 'id' && ts.isStringLiteral(prop.initializer) && prop.initializer.text) {
        const candidate = toCamelCase(prop.initializer.text);
        if (candidate && !usedNames.has(candidate)) return candidate;
      }
    }
  }

  // 2. Try filename + factory: washer.ts + sensor → washerSensor
  if (factoryName) {
    const baseName = fileName.replace(/^.*\//, '').replace(/\.\w+$/, '');
    const baseCC = toCamelCase(baseName);
    if (baseCC) {
      const candidate = baseCC + factoryName.charAt(0).toUpperCase() + factoryName.slice(1);
      if (!usedNames.has(candidate)) return candidate;
    }
  }

  // 3. Factory name with number suffix: sensor1, sensor2, ...
  if (factoryName) {
    for (let n = 1; n <= 99; n++) {
      const candidate = `${factoryName}${n}`;
      if (!usedNames.has(candidate)) return candidate;
    }
  }

  return null;
}

/**
 * Re-indent a multi-line code string. Detects the existing minimum indentation
 * and adjusts all lines to the target indent level. The first line is returned
 * without leading whitespace (since it follows `memberKey: ` on the same line).
 */
function reindent(text: string, targetIndent: number): string {
  const lines = text.split('\n');
  if (lines.length <= 1) return text.trim();

  // Find the minimum indentation of non-empty lines (excluding first line)
  let minIndent = Infinity;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().length === 0) continue;
    const indent = line.match(/^(\s*)/)?.[1].length ?? 0;
    if (indent < minIndent) minIndent = indent;
  }
  if (minIndent === Infinity) minIndent = 0;

  const pad = ' '.repeat(targetIndent);
  const result = [lines[0].trim()];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().length === 0) {
      result.push('');
    } else {
      result.push(pad + line.slice(minIndent));
    }
  }
  return result.join('\n');
}
