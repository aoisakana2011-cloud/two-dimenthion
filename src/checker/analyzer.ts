import { Expr, ExternalCharacter, FunctionDef, NodeLocation, Script, Statement, ValueType } from '../parser';
import { checkTypes, TypeCheckError } from './type-checker';
import { isNonMutatingBuiltin, isPureBuiltin, isRuntimeStateApi } from '../language/builtins';

export type DiagnosticSeverity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  code: string;
  severity: DiagnosticSeverity;
  message: string;
  variable?: string;
  file: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
}

type Constant = bigint | number | string | boolean | undefined;
type ConstraintDomain = { type: 'int' | 'float' | 'str'; min?: bigint; max?: bigint; floatMin?: number; floatMax?: number; values?: ReadonlySet<bigint | string>; floatValues?: ReadonlySet<number> };
type VariableConstraint = ConstraintDomain & { flow?: boolean; declared?: ConstraintDomain };
const INT_MIN = -(1n << 63n);
const INT_MAX = (1n << 63n) - 1n;
const MAX_STATIC_NUMERIC_VALUES = 64;
const CALL_CONTEXT_DIAGNOSTICS = new Set([
  'duration-range', 'presentation-offset-range', 'variable-constraint',
  'non-exhaustive-condition', 'integer-overflow', 'float-overflow',
  'division-by-zero', 'invalid-conversion', 'invalid-for-step', 'loop-limit',
]);

function at(node?: NodeLocation): Pick<Diagnostic, 'line' | 'column' | 'endLine' | 'endColumn'> {
  return {
    line: node?.line ?? 1,
    column: node?.column ?? 1,
    ...(node?.endLine ? { endLine: node.endLine } : {}),
    ...(node?.endColumn ? { endColumn: node.endColumn } : {}),
  };
}

function diagnostic(file: string, code: string, severity: DiagnosticSeverity, message: string, node?: NodeLocation, variable?: string): Diagnostic {
  return { code, severity, message, ...(variable !== undefined ? { variable } : {}), file: node?.file || file, ...at(node) };
}

function errorDiagnostic(error: unknown, file: string): Diagnostic {
  const message = error instanceof Error ? error.message : String(error);
  const located = error instanceof TypeCheckError ? error : undefined;
  const line = located?.line ?? Number(message.match(/(?:at )?line\s+(\d+)/i)?.[1] || 1);
  const column = located?.column ?? Number(message.match(/column\s+(\d+)/i)?.[1] || 1);
  return { code: error instanceof SyntaxError ? 'syntax-error' : 'type-error', severity: 'error', message, file: located?.file || file, line, column };
}

function integer(value: number | bigint | boolean): bigint | undefined {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'boolean') return undefined;
  return Number.isSafeInteger(value) ? BigInt(value) : undefined;
}

function constant(expr: Expr, constants: ReadonlyMap<string, Exclude<Constant, undefined>> = new Map()): Constant {
  if (expr.kind === 'float') {
    const value = Number(expr.value);
    return Number.isFinite(value) ? value : undefined;
  }
  if (expr.kind === 'literal') return typeof expr.value === 'string' ? expr.value : integer(expr.value);
  if (expr.kind === 'variable') return constants.get(expr.name);
  if (expr.kind === 'unary') {
    const value = constant(expr.value, constants);
    if (expr.operator === 'not' && typeof value === 'boolean') return !value;
    if ((expr.operator === '+' || expr.operator === '-') && typeof value === 'bigint') return expr.operator === '-' ? -value : value;
    if ((expr.operator === '+' || expr.operator === '-') && typeof value === 'number') return expr.operator === '-' ? -value : value;
    return undefined;
  }
  if (expr.kind === 'call') {
    const argument = expr.args.length === 1 ? constant(expr.args[0], constants) : undefined;
    if (expr.name === 'str' && typeof argument === 'bigint') return String(argument);
    if (expr.name === 'int' && typeof argument === 'string' && /^[+-]?\d+$/.test(argument)) return BigInt(argument);
    if (expr.name === 'int' && typeof argument === 'number' && Number.isFinite(argument)) {
      const value = BigInt(Math.trunc(argument));
      return value >= INT_MIN && value <= INT_MAX ? value : undefined;
    }
    if (expr.name === 'float') {
      if (typeof argument === 'string' && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(argument)) return undefined;
      const value = typeof argument === 'bigint' || typeof argument === 'number' || typeof argument === 'string' ? Number(argument) : NaN;
      return Number.isFinite(value) ? value : undefined;
    }
    return undefined;
  }
  if (expr.kind !== 'binary') return undefined;
  const left = constant(expr.left, constants);
  if (expr.operator === 'and' && typeof left === 'boolean') return left ? constant(expr.right, constants) : false;
  if (expr.operator === 'or' && typeof left === 'boolean') return left ? true : constant(expr.right, constants);
  const right = constant(expr.right, constants);
  if (left === undefined || right === undefined) return undefined;
  if (expr.operator === '==') return left === right;
  if (expr.operator === '!=') return left !== right;
  if (typeof left === 'bigint' && typeof right === 'bigint') {
    if (expr.operator === '>') return left > right;
    if (expr.operator === '>=') return left >= right;
    if (expr.operator === '<') return left < right;
    if (expr.operator === '<=') return left <= right;
    if (expr.operator === '+') return left + right;
    if (expr.operator === '-') return left - right;
    if (expr.operator === '*') return left * right;
    if (expr.operator === '/' && right !== 0n) return left / right;
    if (expr.operator === '%' && right !== 0n) return left % right;
  }
  if (typeof left === 'number' && typeof right === 'number') {
    if (expr.operator === '>') return left > right;
    if (expr.operator === '>=') return left >= right;
    if (expr.operator === '<') return left < right;
    if (expr.operator === '<=') return left <= right;
    const value = expr.operator === '+' ? left + right : expr.operator === '-' ? left - right
      : expr.operator === '*' ? left * right : expr.operator === '/' && right !== 0 ? left / right : undefined;
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  }
  if (expr.operator === '+' && typeof left === 'string' && typeof right === 'string') return left + right;
  return undefined;
}

type CheckedInteger = bigint | 'overflow' | undefined;

function checkedInteger(expr: Expr, constants: ReadonlyMap<string, Exclude<Constant, undefined>> = new Map()): CheckedInteger {
  const inRange = (value: bigint): CheckedInteger => value < INT_MIN || value > INT_MAX ? 'overflow' : value;
  if (expr.kind === 'literal') {
    if (typeof expr.value === 'string') return undefined;
    const value = integer(expr.value);
    return value === undefined ? undefined : inRange(value);
  }
  if (expr.kind === 'variable') {
    const value = constants.get(expr.name);
    return typeof value === 'bigint' ? inRange(value) : undefined;
  }
  if (expr.kind === 'unary') {
    if (expr.operator === '-' && expr.value.kind === 'literal') {
      if (typeof expr.value.value !== 'string') {
        const raw = integer(expr.value.value);
        if (raw === INT_MAX + 1n) return INT_MIN;
      }
    }
    const value = checkedInteger(expr.value, constants);
    if (value === 'overflow' || value === undefined) return value;
    if (expr.operator === '+') return value;
    if (expr.operator === '-') return value === INT_MIN ? 'overflow' : -value;
    return undefined;
  }
  if (expr.kind === 'call') {
    if (expr.name !== 'int' || expr.args.length !== 1) return undefined;
    const value = constant(expr.args[0], constants);
    return typeof value === 'bigint' ? inRange(value) : undefined;
  }
  if (expr.kind !== 'binary') return undefined;
  const left = checkedInteger(expr.left, constants);
  if (left === 'overflow') return 'overflow';
  const right = checkedInteger(expr.right, constants);
  if (right === 'overflow') return 'overflow';
  if (left === undefined || right === undefined) return undefined;
  let value: bigint;
  if (expr.operator === '+') value = left + right;
  else if (expr.operator === '-') value = left - right;
  else if (expr.operator === '*') value = left * right;
  else if (expr.operator === '/' && right !== 0n) value = left / right;
  else if (expr.operator === '%' && right !== 0n) value = left % right;
  else return undefined;
  return inRange(value);
}

function expressionKey(expr: Expr): string {
  if (expr.kind === 'float') return `float:${expr.value}`;
  if (expr.kind === 'literal') return `literal:${String(expr.value)}`;
  if (expr.kind === 'variable') return `variable:${expr.name}`;
  if (expr.kind === 'unary') return `${expr.operator}(${expressionKey(expr.value)})`;
  if (expr.kind === 'binary') {
    const left = expressionKey(expr.left), right = expressionKey(expr.right);
    if (expr.operator === '==' || expr.operator === '!=') return `(${[left, right].sort().join(expr.operator)})`;
    return `(${left}${expr.operator}${right})`;
  }
  if (expr.kind === 'index') return `${expressionKey(expr.target)}[${expressionKey(expr.key)}]`;
  if (expr.kind === 'call') return `${expr.name}(${expr.args.map(expressionKey).join(',')})`;
  if (expr.kind === 'list') return `[${expr.items.map(expressionKey).join(',')}]`;
  return `{${expr.entries.map((entry) => `${entry.key}:${expressionKey(entry.value)}`).join(',')}}`;
}

function inverseExpressionKey(expr: Expr): string | undefined {
  if (expr.kind === 'unary' && expr.operator === 'not') return expressionKey(expr.value);
  if (expr.kind !== 'binary') return undefined;
  const inverse: Record<string, string> = { '==': '!=', '!=': '==', '>': '<=', '>=': '<', '<': '>=', '<=': '>' };
  const operator = inverse[expr.operator];
  return operator ? expressionKey({ ...expr, operator }) : undefined;
}

function constrainedCondition(expr: Expr, constraints?: ReadonlyMap<string, VariableConstraint>): boolean | undefined {
  if (!constraints) return undefined;
  if (expr.kind === 'unary' && expr.operator === 'not') {
    const value = constrainedCondition(expr.value, constraints);
    return value === undefined ? undefined : !value;
  }
  if (expr.kind === 'binary' && (expr.operator === 'and' || expr.operator === 'or')) {
    const combined = combinedIntegerCondition(expr, constraints);
    if (combined !== undefined) return combined;
    const finite = combinedFiniteCondition(expr, constraints);
    if (finite !== undefined) return finite;
    const left = constrainedCondition(expr.left, constraints);
    const right = constrainedCondition(expr.right, constraints);
    if (expr.operator === 'and') return left === false || right === false ? false : left === true && right === true ? true : undefined;
    return left === true || right === true ? true : left === false && right === false ? false : undefined;
  }
  if (expr.kind !== 'binary' || !['==', '!=', '>', '>=', '<', '<='].includes(expr.operator)) return undefined;
  let name: string | undefined;
  let expected: Constant;
  let operator = expr.operator;
  if (expr.left.kind === 'variable') {
    name = expr.left.name;
    expected = constant(expr.right);
  } else if (expr.right.kind === 'variable') {
    name = expr.right.name;
    expected = constant(expr.left);
    const flipped: Record<string, string> = { '==': '==', '!=': '!=', '>': '<', '>=': '<=', '<': '>', '<=': '>=' };
    operator = flipped[operator];
  }
  if (!name || expected === undefined || typeof expected === 'boolean') return undefined;
  const constraint = constraints.get(name);
  if (typeof expected === 'boolean' || !constraint || constraint.type === 'int' && typeof expected !== 'bigint' || constraint.type === 'float' && typeof expected !== 'number' || constraint.type === 'str' && typeof expected !== 'string') return undefined;
  const accepts = (value: bigint | number | string): boolean => {
    if (operator === '==') return value === expected;
    if (operator === '!=') return value !== expected;
    if (typeof value !== typeof expected || typeof value === 'string') return false;
    const right = expected as bigint | number;
    if (operator === '>') return value > right;
    if (operator === '>=') return value >= right;
    if (operator === '<') return value < right;
    return value <= right;
  };
  const knownValues = constraint.type === 'float' ? constraint.floatValues : constraint.values;
  if (knownValues) {
    const values = [...knownValues];
    if (!values.length) return undefined;
    const results = values.map(accepts);
    return results.every(Boolean) ? true : results.every((value) => !value) ? false : undefined;
  }
  const minimumBound = constraint.type === 'float' ? constraint.floatMin : constraint.min;
  const maximumBound = constraint.type === 'float' ? constraint.floatMax : constraint.max;
  if (minimumBound === undefined || maximumBound === undefined || typeof expected !== typeof minimumBound || typeof expected !== typeof maximumBound) return undefined;
  const minimum = accepts(minimumBound), maximum = accepts(maximumBound);
  if (operator === '==' || operator === '!=') {
    if (expected < (minimumBound as any) || expected > (maximumBound as any)) return operator === '!=';
    if (minimumBound === maximumBound) return operator === '==' ? minimum : !minimum;
    return undefined;
  }
  if (minimum && maximum) return true;
  const expectedNumber = expected as bigint | number;
  const minimumNumber = minimumBound as bigint | number;
  const maximumNumber = maximumBound as bigint | number;
  if (!minimum && !maximum && ((operator === '>' && maximumNumber <= expectedNumber)
    || (operator === '>=' && maximumNumber < expectedNumber)
    || (operator === '<' && minimumNumber >= expectedNumber)
    || (operator === '<=' && minimumNumber > expectedNumber))) return false;
  return undefined;
}

function conditionValue(expr: Expr, constants: ReadonlyMap<string, Exclude<Constant, undefined>>, facts: ReadonlyMap<string, boolean>, constraints?: ReadonlyMap<string, VariableConstraint>): Constant {
  const value = constant(expr, constants);
  if (value !== undefined || !isPureExpression(expr)) return value;
  const constrained = constrainedCondition(expr, constraints);
  if (constrained !== undefined) return constrained;
  return facts.get(expressionKey(expr));
}

function recordCondition(facts: Map<string, boolean>, expr: Expr, value: boolean): void {
  if (!isPureExpression(expr)) return;
  facts.set(expressionKey(expr), value);
  const inverse = inverseExpressionKey(expr);
  if (inverse) facts.set(inverse, !value);
  if (expr.kind === 'unary' && expr.operator === 'not') {
    recordCondition(facts, expr.value, !value);
  } else if (expr.kind === 'binary' && expr.operator === 'and' && value) {
    recordCondition(facts, expr.left, true);
    recordCondition(facts, expr.right, true);
  } else if (expr.kind === 'binary' && expr.operator === 'or' && !value) {
    recordCondition(facts, expr.left, false);
    recordCondition(facts, expr.right, false);
  }
}

function refineConstraints(constraints: ReadonlyMap<string, VariableConstraint> | undefined, expr: Expr, truth: boolean): ReadonlyMap<string, VariableConstraint> | undefined {
  if (!constraints) return undefined;
  if (expr.kind === 'unary' && expr.operator === 'not') return refineConstraints(constraints, expr.value, !truth);
  if (expr.kind !== 'binary') return constraints;
  if (expr.operator === 'and' && truth) {
    const left = refineConstraints(constraints, expr.left, true);
    return refineConstraints(left || constraints, expr.right, true);
  }
  if (expr.operator === 'or' && !truth) {
    const left = refineConstraints(constraints, expr.left, false);
    return refineConstraints(left || constraints, expr.right, false);
  }
  if (!['==', '!=', '>', '>=', '<', '<='].includes(expr.operator)) return constraints;
  const primitiveConstant = (value: Expr): bigint | number | string | undefined => {
    const result = constant(value);
    return typeof result === 'boolean' ? undefined : result;
  };
  let name: string | undefined;
  let expected: bigint | number | string | undefined;
  let operator = expr.operator;
  if (expr.left.kind === 'variable') {
    name = expr.left.name;
    expected = primitiveConstant(expr.right);
  } else if (expr.right.kind === 'variable') {
    name = expr.right.name;
    expected = primitiveConstant(expr.left);
    const flipped: Record<string, string> = { '==': '==', '!=': '!=', '>': '<', '>=': '<=', '<': '>', '<=': '>=' };
    operator = flipped[operator];
  }
  if (!name || expected === undefined || typeof expected === 'boolean') return constraints;
  const current = constraints.get(name);
  if (typeof expected === 'boolean' || !current || current.type !== (typeof expected === 'bigint' ? 'int' : typeof expected === 'number' ? 'float' : 'str')) return constraints;
  const inverse: Record<string, string> = { '==': '!=', '!=': '==', '>': '<=', '>=': '<', '<': '>=', '<=': '>' };
  const effective = truth ? operator : inverse[operator];
  const next: VariableConstraint = { ...current };
  if (current.type === 'str') {
    if (effective === '==' && current.values) next.values = new Set([...current.values].filter((value) => value === expected));
    else if (effective === '!=' && current.values) next.values = new Set([...current.values].filter((value) => value !== expected));
  } else if (typeof expected === 'number' && current.type === 'float') {
    if (effective === '==') { next.floatMin = expected; next.floatMax = expected; }
    else if (effective === '>') next.floatMin = Math.max(current.floatMin ?? -Infinity, expected);
    else if (effective === '>=') next.floatMin = Math.max(current.floatMin ?? -Infinity, expected);
    else if (effective === '<') next.floatMax = Math.min(current.floatMax ?? Infinity, expected);
    else if (effective === '<=') next.floatMax = Math.min(current.floatMax ?? Infinity, expected);
    if (current.floatValues) next.floatValues = new Set([...current.floatValues].filter((value) => effective === '==' ? value === expected : effective === '!=' ? value !== expected : effective === '>' ? value > expected : effective === '>=' ? value >= expected : effective === '<' ? value < expected : value <= expected));
  } else if (typeof expected === 'bigint') {
    if (effective === '==') {
      next.min = expected;
      next.max = expected;
      if (current.values) next.values = new Set([...current.values].filter((value) => value === expected));
    } else if (effective === '>') next.min = current.min === undefined || current.min <= expected ? expected + 1n : current.min;
    else if (effective === '>=') next.min = current.min === undefined || current.min < expected ? expected : current.min;
    else if (effective === '<') next.max = current.max === undefined || current.max >= expected ? expected - 1n : current.max;
    else if (effective === '<=') next.max = current.max === undefined || current.max > expected ? expected : current.max;
    if (current.values) next.values = new Set([...current.values].filter((value) => {
      if (typeof value !== 'bigint') return false;
      if (effective === '==') return value === expected;
      if (effective === '!=') return value !== expected;
      if (effective === '>') return value > expected;
      if (effective === '>=') return value >= expected;
      if (effective === '<') return value < expected;
      return value <= expected;
    }));
  }
  const result = new Map(constraints);
  result.set(name, next);
  return result;
}

function mergeConstraints(paths: Array<ReadonlyMap<string, VariableConstraint> | undefined>): ReadonlyMap<string, VariableConstraint> | undefined {
  const available = paths.filter((path): path is ReadonlyMap<string, VariableConstraint> => !!path);
  if (!available.length) return undefined;
  const result = new Map<string, VariableConstraint>();
  for (const name of available[0].keys()) {
    const entries = available.map((path) => path.get(name));
    if (entries.some((entry) => !entry) || entries.some((entry) => entry!.type !== entries[0]!.type)) continue;
    const merged: VariableConstraint = { type: entries[0]!.type };
    const mins = entries.map((entry) => entry!.min).filter((value): value is bigint => value !== undefined);
    const maxs = entries.map((entry) => entry!.max).filter((value): value is bigint => value !== undefined);
    if (mins.length === entries.length) merged.min = mins.reduce((minimum, value) => value < minimum ? value : minimum);
    if (maxs.length === entries.length) merged.max = maxs.reduce((maximum, value) => value > maximum ? value : maximum);
    if (entries.every((entry) => !!entry!.values)) {
      const values = new Set<bigint | string>();
      entries.forEach((entry) => entry!.values!.forEach((value) => values.add(value)));
      if (values.size <= MAX_STATIC_NUMERIC_VALUES) merged.values = values;
    }
    const floatMins = entries.map((entry) => entry!.floatMin).filter((value): value is number => value !== undefined);
    const floatMaxs = entries.map((entry) => entry!.floatMax).filter((value): value is number => value !== undefined);
    if (floatMins.length === entries.length) merged.floatMin = Math.min(...floatMins);
    if (floatMaxs.length === entries.length) merged.floatMax = Math.max(...floatMaxs);
    if (entries.every((entry) => !!entry!.floatValues)) {
      const values = new Set(entries.flatMap((entry) => [...entry!.floatValues!]));
      if (values.size <= MAX_STATIC_NUMERIC_VALUES) merged.floatValues = values;
    }
    if (entries.some((entry) => entry!.flow)) {
      const declared = entries.map((entry) => entry!.flow ? entry!.declared : entry!.declared || entry!);
      if (declared.every((entry) => entry === declared[0]) && declared[0]) merged.declared = declared[0];
      merged.flow = true;
    }
    result.set(name, merged);
  }
  return result;
}

function finiteBranchCoverage(statement: Extract<Statement, { kind: 'if' }>, constraints?: ReadonlyMap<string, VariableConstraint>): { name: string; allowed: Set<bigint | number | string>; covered: Set<bigint | number | string> } | undefined {
  const branches = [statement.condition.expression, ...statement.elseIf.map((branch) => branch.condition.expression)];
  let name: string | undefined;
  const covered = new Set<bigint | number | string>();
  for (const expression of branches) {
    if (expression.kind !== 'binary' || expression.operator !== '==') return undefined;
    let variable: string | undefined;
    let value: bigint | number | string | undefined;
    if (expression.left.kind === 'variable' && expression.right.kind === 'literal') {
      variable = expression.left.name;
      value = typeof expression.right.value === 'string' ? expression.right.value : integer(expression.right.value);
    } else if (expression.left.kind === 'variable' && expression.right.kind === 'float') {
      variable = expression.left.name; value = Number(expression.right.value);
    } else if (expression.right.kind === 'variable' && expression.left.kind === 'literal') {
      variable = expression.right.name;
      value = typeof expression.left.value === 'string' ? expression.left.value : integer(expression.left.value);
    } else if (expression.right.kind === 'variable' && expression.left.kind === 'float') {
      variable = expression.right.name; value = Number(expression.left.value);
    }
    if (!variable || value === undefined || name && name !== variable) return undefined;
    name = variable; covered.add(value);
  }
  if (!name) return undefined;
  const constraint = constraints?.get(name);
  const values = constraint?.type === 'float' ? constraint.floatValues : constraint?.values;
  if (!constraint || !values) return undefined;
  const allowed = new Set<bigint | number | string>(values);
  const typeMatches = [...allowed].every((value) => constraint.type === 'str' ? typeof value === 'string' : constraint.type === 'float' ? typeof value === 'number' : typeof value === 'bigint');
  return typeMatches ? { name, allowed, covered } : undefined;
}

function integerRangeCoverage(statement: Extract<Statement, { kind: 'if' }>, constraints?: ReadonlyMap<string, VariableConstraint>): { name: string; exhaustive: boolean } | undefined {
  const branches = [statement.condition.expression, ...statement.elseIf.map((branch) => branch.condition.expression)];
  let name: string | undefined;
  let range: { min: bigint; max: bigint } | undefined;
  const intervals: Array<{ min: bigint; max: bigint }> = [];
  for (const expression of branches) {
    if (expression.kind !== 'binary' || !['==', '<', '<=', '>', '>='].includes(expression.operator)) return undefined;
    let variable: string | undefined;
    let value: bigint | undefined;
    let operator = expression.operator;
    if (expression.left.kind === 'variable') { variable = expression.left.name; value = expression.right.kind === 'literal' && typeof expression.right.value !== 'string' ? integer(expression.right.value) : undefined; }
    else if (expression.right.kind === 'variable') {
      variable = expression.right.name; value = expression.left.kind === 'literal' && typeof expression.left.value !== 'string' ? integer(expression.left.value) : undefined;
      const flipped: Record<string, string> = { '==': '==', '<': '>', '<=': '>=', '>': '<', '>=': '<=' };
      operator = flipped[operator];
    }
    if (!variable || value === undefined || name && name !== variable) return undefined;
    name = variable;
    const constraint = constraints?.get(name);
    if (!constraint || constraint.type !== 'int' || constraint.min === undefined || constraint.max === undefined) return undefined;
    range = { min: constraint.min, max: constraint.max };
    const interval = operator === '==' ? { min: value, max: value }
      : operator === '<' ? { min: range.min, max: value - 1n }
        : operator === '<=' ? { min: range.min, max: value }
          : operator === '>' ? { min: value + 1n, max: range.max } : { min: value, max: range.max };
    const min = interval.min < range.min ? range.min : interval.min;
    const max = interval.max > range.max ? range.max : interval.max;
    if (min <= max) intervals.push({ min, max });
  }
  if (!name || !range) return undefined;
  intervals.sort((left, right) => left.min < right.min ? -1 : left.min > right.min ? 1 : 0);
  let cursor = range.min;
  for (const interval of intervals) {
    if (interval.min > cursor) return { name, exhaustive: false };
    if (interval.max >= cursor) cursor = interval.max + 1n;
    if (cursor > range.max) return { name, exhaustive: true };
  }
  return { name, exhaustive: cursor > range.max };
}

type IntegerConstraint = { name: string; operator: string; value: bigint };
function integerConstraint(expr: Expr, constants: ReadonlyMap<string, Exclude<Constant, undefined>>): IntegerConstraint | undefined {
  if (expr.kind !== 'binary' || !['==', '!=', '>', '>=', '<', '<='].includes(expr.operator)) return undefined;
  if (expr.left.kind === 'variable') {
    const value = constant(expr.right, constants);
    if (typeof value === 'bigint') return { name: expr.left.name, operator: expr.operator, value };
  }
  if (expr.right.kind === 'variable') {
    const value = constant(expr.left, constants);
    const flipped: Record<string, string> = { '==': '==', '!=': '!=', '>': '<', '>=': '<=', '<': '>', '<=': '>=' };
    if (typeof value === 'bigint') return { name: expr.right.name, operator: flipped[expr.operator], value };
  }
  return undefined;
}

function combinedIntegerCondition(expr: Extract<Expr, { kind: 'binary' }>, constraints: ReadonlyMap<string, VariableConstraint>): boolean | undefined {
  if (expr.operator !== 'and' && expr.operator !== 'or') return undefined;
  const left = integerConstraint(expr.left, new Map()), right = integerConstraint(expr.right, new Map());
  if (!left || !right || left.name !== right.name) return undefined;
  const constraint = constraints.get(left.name);
  if (!constraint || constraint.type !== 'int') return undefined;
  const accepts = (predicate: IntegerConstraint, value: bigint): boolean => {
    if (predicate.operator === '==') return value === predicate.value;
    if (predicate.operator === '!=') return value !== predicate.value;
    if (predicate.operator === '>') return value > predicate.value;
    if (predicate.operator === '>=') return value >= predicate.value;
    if (predicate.operator === '<') return value < predicate.value;
    return value <= predicate.value;
  };
  if (constraint.values) {
    const results = [...constraint.values].map((value) => expr.operator === 'and' ? accepts(left, value as bigint) && accepts(right, value as bigint) : accepts(left, value as bigint) || accepts(right, value as bigint));
    return results.length && results.every(Boolean) ? true : results.length && results.every((value) => !value) ? false : undefined;
  }
  if (constraint.min === undefined || constraint.max === undefined || left.operator === '!=' || right.operator === '!=') return undefined;
  const minimum = constraint.min, maximum = constraint.max;
  const interval = (predicate: IntegerConstraint): [bigint, bigint] => {
    if (predicate.operator === '==') return [predicate.value, predicate.value];
    if (predicate.operator === '>') return [predicate.value + 1n, maximum];
    if (predicate.operator === '>=') return [predicate.value, maximum];
    if (predicate.operator === '<') return [minimum, predicate.value - 1n];
    return [minimum, predicate.value];
  };
  const a = interval(left), b = interval(right);
  if (expr.operator === 'and') {
    const minimum = a[0] > b[0] ? a[0] : b[0], maximum = a[1] < b[1] ? a[1] : b[1];
    return minimum > maximum ? false : undefined;
  }
  const ordered = [a, b].sort((first, second) => first[0] < second[0] ? -1 : 1);
  return ordered[0][0] <= minimum && ordered[0][1] + 1n >= ordered[1][0] && ordered[1][1] >= maximum ? true : undefined;
}

function combinedFiniteCondition(expr: Extract<Expr, { kind: 'binary' }>, constraints: ReadonlyMap<string, VariableConstraint>): boolean | undefined {
  if (expr.operator !== 'and' && expr.operator !== 'or') return undefined;
  const parse = (value: Expr): { name: string; operator: string; expected: bigint | number | string } | undefined => {
    if (value.kind !== 'binary' || !['==', '!='].includes(value.operator)) return undefined;
    if (value.left.kind === 'variable') { const expected = constant(value.right); return expected === undefined || typeof expected === 'boolean' ? undefined : { name: value.left.name, operator: value.operator, expected }; }
    if (value.right.kind === 'variable') { const expected = constant(value.left); return expected === undefined || typeof expected === 'boolean' ? undefined : { name: value.right.name, operator: value.operator, expected }; }
    return undefined;
  };
  const left = parse(expr.left), right = parse(expr.right);
  if (!left || !right || left.name !== right.name) return undefined;
  const constraint = constraints.get(left.name);
  if (!constraint) return undefined;
  const allowed = constraint.type === 'float' ? constraint.floatValues : constraint.values;
  if (!allowed) return undefined;
  if (constraint.type === 'str' && (typeof left.expected !== 'string' || typeof right.expected !== 'string')) return undefined;
  if (constraint.type === 'int' && (typeof left.expected !== 'bigint' || typeof right.expected !== 'bigint')) return undefined;
  if (constraint.type === 'float' && (typeof left.expected !== 'number' || typeof right.expected !== 'number')) return undefined;
  const accepts = (predicate: { operator: string; expected: bigint | number | string }, value: bigint | number | string): boolean => predicate.operator === '==' ? value === predicate.expected : value !== predicate.expected;
  const results = [...allowed].map((value) => expr.operator === 'and' ? accepts(left, value) && accepts(right, value) : accepts(left, value) || accepts(right, value));
  return results.length && results.every(Boolean) ? true : results.length && results.every((value) => !value) ? false : undefined;
}

function conditionImplies(current: Expr, previous: Expr, constants: ReadonlyMap<string, Exclude<Constant, undefined>>): boolean {
  if (!isPureExpression(current) || !isPureExpression(previous)) return false;
  if (expressionKey(current) === expressionKey(previous)) return true;
  const left = integerConstraint(current, constants), right = integerConstraint(previous, constants);
  if (!left || !right || left.name !== right.name) return false;
  const accepts = (constraint: IntegerConstraint, value: bigint): boolean => {
    if (constraint.operator === '==') return value === constraint.value;
    if (constraint.operator === '!=') return value !== constraint.value;
    if (constraint.operator === '>') return value > constraint.value;
    if (constraint.operator === '>=') return value >= constraint.value;
    if (constraint.operator === '<') return value < constraint.value;
    return value <= constraint.value;
  };
  if (left.operator === '==') return accepts(right, left.value);
  if (left.operator === '!=') return right.operator === '!=' && left.value === right.value;
  if (right.operator === '!=') return !accepts(left, right.value);
  if (right.operator === '==') return false;
  const lower = (constraint: IntegerConstraint): [bigint, boolean] | undefined => constraint.operator === '>' ? [constraint.value, false] : constraint.operator === '>=' ? [constraint.value, true] : undefined;
  const upper = (constraint: IntegerConstraint): [bigint, boolean] | undefined => constraint.operator === '<' ? [constraint.value, false] : constraint.operator === '<=' ? [constraint.value, true] : undefined;
  const leftLower = lower(left), rightLower = lower(right), leftUpper = upper(left), rightUpper = upper(right);
  if (rightLower) return !!leftLower && (leftLower[0] > rightLower[0] || (leftLower[0] === rightLower[0] && (!leftLower[1] || rightLower[1])));
  if (rightUpper) return !!leftUpper && (leftUpper[0] < rightUpper[0] || (leftUpper[0] === rightUpper[0] && (!leftUpper[1] || rightUpper[1])));
  return false;
}

function isPureExpression(expr: Expr): boolean {
  if (expr.kind === 'float') return true;
  if (expr.kind === 'literal') return typeof expr.value !== 'string' || !/\{[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*(?:\(\))?\}/.test(expr.value);
  if (expr.kind === 'call') return expr.name === 'int' || expr.name === 'float' || expr.name === 'str' ? expr.args.every(isPureExpression) : false;
  if (expr.kind === 'binary') return isPureExpression(expr.left) && isPureExpression(expr.right);
  if (expr.kind === 'unary') return isPureExpression(expr.value);
  if (expr.kind === 'index') return isPureExpression(expr.target) && isPureExpression(expr.key);
  if (expr.kind === 'dict') return expr.entries.every((entry) => isPureExpression(entry.value));
  if (expr.kind === 'list') return expr.items.every(isPureExpression);
  return true;
}

function visitExpressions(expr: Expr, visit: (expr: Expr) => void): void {
  visit(expr);
  if (expr.kind === 'binary') { visitExpressions(expr.left, visit); visitExpressions(expr.right, visit); }
  if (expr.kind === 'unary') visitExpressions(expr.value, visit);
  if (expr.kind === 'index') { visitExpressions(expr.target, visit); visitExpressions(expr.key, visit); }
  if (expr.kind === 'call') expr.args.forEach((arg) => visitExpressions(arg, visit));
  if (expr.kind === 'dict') expr.entries.forEach((entry) => visitExpressions(entry.value, visit));
  if (expr.kind === 'list') expr.items.forEach((item) => visitExpressions(item, visit));
}

function statementExpressions(statement: Statement): Expr[] {
  if (statement.kind === 'declare') return statement.initial ? [statement.initial] : [];
  if (statement.kind === 'set') return [statement.value, statement.target];
  if (statement.kind === 'unset') return [statement.target];
  if (statement.kind === 'command' || statement.kind === 'call') return statement.args;
  if (statement.kind === 'if' || statement.kind === 'while') return [statement.condition.expression];
  if (statement.kind === 'for') return [statement.start, statement.stop, statement.step];
  if (statement.kind === 'forEach') return [statement.iterable];
  if (statement.kind === 'choice') return [...(statement.prompt ? [statement.prompt] : []), ...statement.options.map((option) => option.label)];
  if (statement.kind === 'return') return statement.value ? [statement.value] : [];
  return [];
}

function nested(statement: Statement): Statement[][] {
  if (statement.kind === 'if') return [statement.body, ...statement.elseIf.map((branch) => branch.body), statement.otherwise];
  if (statement.kind === 'for' || statement.kind === 'forEach' || statement.kind === 'while') return [statement.body];
  if (statement.kind === 'choice') return statement.options.map((option) => option.body);
  return [];
}

type ForExecution = 'runs' | 'invalid' | 'unknown';

// Keep this in lockstep with the browser and native runtimes: a statically
// known zero step, or a step pointing away from its bound, is a runtime error.
// A valid inclusive for-loop always executes at least once.
function forExecution(statement: Extract<Statement, { kind: 'for' }>, constants: ReadonlyMap<string, Exclude<Constant, undefined>>): ForExecution {
  const start = constant(statement.start, constants);
  const stop = constant(statement.stop, constants);
  const step = constant(statement.step, constants);
  if (typeof start !== 'bigint' || typeof stop !== 'bigint' || typeof step !== 'bigint') return 'unknown';
  if (step === 0n || (start < stop && step < 0n) || (start > stop && step > 0n)) return 'invalid';
  return 'runs';
}

function forIterationCount(statement: Extract<Statement, { kind: 'for' }>, constants: ReadonlyMap<string, Exclude<Constant, undefined>>): bigint | undefined {
  const start = constant(statement.start, constants);
  const stop = constant(statement.stop, constants);
  const step = constant(statement.step, constants);
  if (typeof start !== 'bigint' || typeof stop !== 'bigint' || typeof step !== 'bigint' || step === 0n) return undefined;
  if ((start < stop && step < 0n) || (start > stop && step > 0n)) return undefined;
  return step > 0n ? (stop - start) / step + 1n : (start - stop) / (-step) + 1n;
}

type IntegerBounds = { min: bigint; max: bigint };
function integerBounds(expression: Expr, constants: ReadonlyMap<string, Exclude<Constant, undefined>>, constraints?: ReadonlyMap<string, VariableConstraint>): IntegerBounds | undefined {
  const value = constant(expression, constants);
  if (typeof value === 'bigint') return { min: value, max: value };
  // int(floatExpr) truncates toward zero, so the interval endpoints remain
  // sufficient to bound every result (including intervals crossing zero).
  if (expression.kind === 'call' && expression.name === 'int' && expression.args.length === 1) {
    const argument = expression.args[0];
    const bounds = floatBounds(argument, constants, constraints);
    if (bounds) return { min: BigInt(Math.trunc(bounds.min)), max: BigInt(Math.trunc(bounds.max)) };
    if (argument.kind === 'variable') {
      const constraint = constraints?.get(argument.name);
      if (constraint?.type === 'str' && constraint.values?.size) {
        const integerValues = [...constraint.values].map(value => typeof value === 'string' && /^[+-]?\d+$/.test(value) ? BigInt(value) : undefined);
        if (integerValues.length && integerValues.every((value): value is bigint => value !== undefined)) {
          return {
            min: integerValues.reduce((minimum, value) => value < minimum ? value : minimum),
            max: integerValues.reduce((maximum, value) => value > maximum ? value : maximum),
          };
        }
      }
    }
  }
  if (expression.kind === 'unary' && (expression.operator === '+' || expression.operator === '-')) {
    const bounds = integerBounds(expression.value, constants, constraints);
    if (!bounds) return undefined;
    return expression.operator === '+' ? bounds : { min: -bounds.max, max: -bounds.min };
  }
  if (expression.kind === 'variable') {
    const constraint = constraints?.get(expression.name);
    if (constraint?.type !== 'int') return undefined;
    if (constraint.values?.size) {
      const values = [...constraint.values].filter((item): item is bigint => typeof item === 'bigint');
      if (values.length !== constraint.values.size) return undefined;
      return { min: values.reduce((left, right) => left < right ? left : right), max: values.reduce((left, right) => left > right ? left : right) };
    }
    if (constraint.min !== undefined && constraint.max !== undefined) return { min: constraint.min, max: constraint.max };
  }
  if (expression.kind === 'binary' && ['+', '-', '*', '/'].includes(expression.operator)) {
    const left = integerBounds(expression.left, constants, constraints);
    const right = integerBounds(expression.right, constants, constraints);
    if (!left || !right) return undefined;
    if (expression.operator === '+') return { min: left.min + right.min, max: left.max + right.max };
    if (expression.operator === '-') return { min: left.min - right.max, max: left.max - right.min };
    if (expression.operator === '*') {
      const products = [left.min * right.min, left.min * right.max, left.max * right.min, left.max * right.max];
      return { min: products.reduce((min, item) => item < min ? item : min), max: products.reduce((max, item) => item > max ? item : max) };
    }
    if (right.min <= 0n && right.max >= 0n) return undefined;
    const quotients = [left.min / right.min, left.min / right.max, left.max / right.min, left.max / right.max];
    return { min: quotients.reduce((min, item) => item < min ? item : min), max: quotients.reduce((max, item) => item > max ? item : max) };
  }
  return undefined;
}

const MAX_TIMED_COMMAND_MS = 2147483647n;
const MAX_PRESENTATION_OFFSET_PX = 1000000n;

function timedCommandValue(statement: Statement): Expr | undefined {
  if (statement.kind !== 'command') return undefined;
  const args = statement.args;
  if (statement.name === 'wait') return args[0];
  if (statement.name === 'effect') return args[2];
  if (statement.name === 'move') {
    const marker = args.findIndex((argument) => argument.kind === 'literal' && argument.value === 'over');
    return marker >= 0 ? args[marker + 1] : undefined;
  }
  if (statement.name === 'show' || statement.name === 'hide') {
    const marker = args.findIndex((argument) => argument.kind === 'literal' && argument.value === 'fade');
    return marker >= 0 ? args[marker + 1] : undefined;
  }
  return undefined;
}

function analyzePresentationOffsets(statement: Statement, constants: ReadonlyMap<string, Exclude<Constant, undefined>>, constraints: ReadonlyMap<string, VariableConstraint>, file: string, out: Diagnostic[]): void {
  if (statement.kind !== 'command') return;
  const args = statement.args;
  let index: number;
  if (statement.name === 'move') index = args[0]?.kind === 'literal' && args[0].value === 'character' ? 3 : args[0]?.kind === 'literal' && args[0].value === 'bg' ? 2 : args.length;
  else if (statement.name === 'show' && !(args[0]?.kind === 'literal' && args[0].value === 'image')) index = 2;
  else return;

  while (index < args.length) {
    const token = args[index];
    const value = token.kind === 'literal' && typeof token.value === 'string' ? token.value : '';
    const match = /^([xy])([+-])(\d+)?$/.exec(value);
    if (!match) break;
    if (match[3]) { index++; continue; } // Literal pixel offsets are already checked by type checking.
    const expression = args[index + 1];
    if (!expression) break;
    const sign = match[2] === '-' ? -1 : 1;
    const exact = constant(expression, constants);
    if (typeof exact === 'bigint' || typeof exact === 'number') {
      const signed = sign > 0 ? exact : -exact;
      const limit = typeof exact === 'bigint' ? MAX_PRESENTATION_OFFSET_PX : Number(MAX_PRESENTATION_OFFSET_PX);
      if (signed > limit || signed < -limit) {
        const alreadyReported = out.some(item => item.code === 'type-error' && item.file === (statement.file || file)
          && item.line === statement.line && item.message.includes(MAX_PRESENTATION_OFFSET_PX.toString()));
        if (!alreadyReported) out.push(diagnostic(file, 'presentation-offset-range', 'error',
          `表示位置のずらし量は±${MAX_PRESENTATION_OFFSET_PX} pxの範囲を超えています`, statement));
      }
    }
    if (exact === undefined) {
      const integerRange = integerBounds(expression, constants, constraints);
      const floatRange = integerRange ? undefined : floatBounds(expression, constants, constraints);
      if (integerRange || floatRange && Number.isFinite(floatRange.min) && Number.isFinite(floatRange.max)) {
        const limit = MAX_PRESENTATION_OFFSET_PX;
        const minimum = integerRange ? (sign > 0 ? integerRange.min : -integerRange.max) : sign > 0 ? floatRange!.min : -floatRange!.max;
        const maximum = integerRange ? (sign > 0 ? integerRange.max : -integerRange.min) : sign > 0 ? floatRange!.max : -floatRange!.min;
        const limitValue = integerRange ? limit : Number(limit);
        const definitelyOut = minimum > limitValue || maximum < -limitValue;
        const mayBeOut = definitelyOut || minimum < -limitValue || maximum > limitValue;
        if (mayBeOut) {
          const alreadyReported = out.some(item => item.code === 'type-error' && item.file === (statement.file || file)
            && item.line === statement.line && item.message.includes(limit.toString()));
          if (!alreadyReported) out.push(diagnostic(file, 'presentation-offset-range', definitelyOut ? 'error' : 'warning',
            `位置ずらし '${match[1]}' の値域が ±${limit} px の範囲を${definitelyOut ? '超えています' : '超える可能性があります'}`, statement));
        }
      }
    }
    index += 2;
  }
}

function finiteIntegerValues(expr: Expr, constants: ReadonlyMap<string, Exclude<Constant, undefined>>, constraints: ReadonlyMap<string, VariableConstraint>): Set<bigint> | undefined {
  const exact = constant(expr, constants);
  if (typeof exact === 'bigint') return new Set([exact]);
  if (expr.kind === 'variable') {
    const domain = constraints.get(expr.name);
    if (domain?.type === 'int' && domain.values?.size && domain.values.size <= MAX_STATIC_NUMERIC_VALUES) {
      const values = [...domain.values];
      return values.every((value): value is bigint => typeof value === 'bigint') ? new Set(values) : undefined;
    }
    return undefined;
  }
  if (expr.kind === 'unary' && (expr.operator === '+' || expr.operator === '-')) {
    const values = finiteIntegerValues(expr.value, constants, constraints);
    if (!values) return undefined;
    const result = new Set([...values].map(value => expr.operator === '-' ? -value : value));
    return [...result].every(value => value >= INT_MIN && value <= INT_MAX) ? result : undefined;
  }
  if (expr.kind === 'call' && expr.name === 'int' && expr.args.length === 1) {
    const argument = expr.args[0];
    const floats = finiteFloatValues(argument, constants, constraints);
    if (floats) {
      const values = new Set([...floats].map(value => BigInt(Math.trunc(value))));
      return [...values].every(value => value >= INT_MIN && value <= INT_MAX) ? values : undefined;
    }
    if (argument.kind === 'variable') {
      const domain = constraints.get(argument.name);
      if (domain?.type === 'str' && domain.values?.size && domain.values.size <= MAX_STATIC_NUMERIC_VALUES) {
        const values = [...domain.values].map(value => typeof value === 'string' && /^[+-]?\d+$/.test(value) ? BigInt(value) : undefined);
        if (values.length && values.every((value): value is bigint => value !== undefined && value >= INT_MIN && value <= INT_MAX)) return new Set(values);
      }
    }
    return undefined;
  }
  if (expr.kind !== 'binary' || !['+', '-', '*', '/', '%'].includes(expr.operator)) return undefined;
  const left = finiteIntegerValues(expr.left, constants, constraints), right = finiteIntegerValues(expr.right, constants, constraints);
  if (!left || !right || left.size * right.size > MAX_STATIC_NUMERIC_VALUES) return undefined;
  const result = new Set<bigint>();
  for (const a of left) for (const b of right) {
    if ((expr.operator === '/' || expr.operator === '%') && b === 0n) return undefined;
    const value = expr.operator === '+' ? a + b : expr.operator === '-' ? a - b : expr.operator === '*' ? a * b
      : expr.operator === '/' ? a / b : a % b;
    if (value < INT_MIN || value > INT_MAX) return undefined;
    result.add(value);
  }
  return result;
}

function finiteFloatValues(expr: Expr, constants: ReadonlyMap<string, Exclude<Constant, undefined>>, constraints: ReadonlyMap<string, VariableConstraint>): Set<number> | undefined {
  const exact = constant(expr, constants);
  if (typeof exact === 'number') return new Set([exact]);
  if (expr.kind === 'variable') {
    const domain = constraints.get(expr.name);
    return domain?.type === 'float' && domain.floatValues?.size && domain.floatValues.size <= MAX_STATIC_NUMERIC_VALUES
      ? new Set(domain.floatValues) : undefined;
  }
  if (expr.kind === 'unary' && (expr.operator === '+' || expr.operator === '-')) {
    const values = finiteFloatValues(expr.value, constants, constraints);
    return values ? new Set([...values].map(value => expr.operator === '-' ? -value : value)) : undefined;
  }
  if (expr.kind === 'call' && expr.name === 'float' && expr.args.length === 1) {
    const argument = expr.args[0];
    const integers = finiteIntegerValues(argument, constants, constraints);
    if (integers) return new Set([...integers].map(value => Number(value)));
    if (argument.kind === 'variable') {
      const domain = constraints.get(argument.name);
      if (domain?.type === 'str' && domain.values?.size && domain.values.size <= MAX_STATIC_NUMERIC_VALUES) {
        const values = [...domain.values].map(value => typeof value === 'string'
          && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value) && Number.isFinite(Number(value)) ? Number(value) : undefined);
        if (values.length && values.every((value): value is number => value !== undefined)) return new Set(values);
      }
    }
    return undefined;
  }
  if (expr.kind !== 'binary' || !['+', '-', '*', '/'].includes(expr.operator)) return undefined;
  const left = finiteFloatValues(expr.left, constants, constraints), right = finiteFloatValues(expr.right, constants, constraints);
  if (!left || !right || left.size * right.size > MAX_STATIC_NUMERIC_VALUES) return undefined;
  const result = new Set<number>();
  for (const a of left) for (const b of right) {
    if (expr.operator === '/' && b === 0) return undefined;
    const value = expr.operator === '+' ? a + b : expr.operator === '-' ? a - b : expr.operator === '*' ? a * b : a / b;
    if (!Number.isFinite(value)) return undefined;
    result.add(value);
  }
  return result;
}

function finiteStringValues(expr: Expr, constants: ReadonlyMap<string, Exclude<Constant, undefined>>, constraints: ReadonlyMap<string, VariableConstraint>): Set<string> | undefined {
  const exact = constant(expr, constants);
  if (typeof exact === 'string') return new Set([exact]);
  if (expr.kind === 'variable') {
    const domain = constraints.get(expr.name);
    if (domain?.type === 'str' && domain.values?.size && domain.values.size <= MAX_STATIC_NUMERIC_VALUES) {
      const values = [...domain.values];
      return values.every((value): value is string => typeof value === 'string') ? new Set(values) : undefined;
    }
    return undefined;
  }
  if (expr.kind === 'binary' && expr.operator === '+') {
    const left = finiteStringValues(expr.left, constants, constraints), right = finiteStringValues(expr.right, constants, constraints);
    if (!left || !right || left.size * right.size > MAX_STATIC_NUMERIC_VALUES) return undefined;
    return new Set([...left].flatMap(a => [...right].map(b => a + b)));
  }
  if (expr.kind === 'call' && expr.name === 'str' && expr.args.length === 1) {
    const argument = expr.args[0];
    const strings = finiteStringValues(argument, constants, constraints);
    if (strings) return strings;
    const integers = finiteIntegerValues(argument, constants, constraints);
    return integers && integers.size <= MAX_STATIC_NUMERIC_VALUES ? new Set([...integers].map(String)) : undefined;
  }
  return undefined;
}

function assignedIntegerFact(statement: Statement, constants: ReadonlyMap<string, Exclude<Constant, undefined>>, constraints: ReadonlyMap<string, VariableConstraint>): { name: string; bounds: IntegerBounds; values?: Set<bigint> } | undefined {
  const name = statement.kind === 'declare' ? statement.name
    : statement.kind === 'set' && statement.target.kind === 'variable' ? statement.target.name : undefined;
  const expression = statement.kind === 'declare' ? statement.initial
    : statement.kind === 'set' ? statement.value : undefined;
  if (!name || !expression) return undefined;
  const value = constant(expression, constants);
  const bounds = typeof value === 'bigint' ? { min: value, max: value } : integerBounds(expression, constants, constraints);
  const values = finiteIntegerValues(expression, constants, constraints);
  return bounds ? { name, bounds, ...(values ? { values } : {}) } : undefined;
}

function assignedFloatFact(statement: Statement, constants: ReadonlyMap<string, Exclude<Constant, undefined>>, constraints: ReadonlyMap<string, VariableConstraint>): { name: string; bounds: { min: number; max: number }; values?: Set<number> } | undefined {
  const name = statement.kind === 'declare' ? statement.name
    : statement.kind === 'set' && statement.target.kind === 'variable' ? statement.target.name : undefined;
  const expression = statement.kind === 'declare' ? statement.initial
    : statement.kind === 'set' ? statement.value : undefined;
  if (!name || !expression) return undefined;
  const bounds = floatBounds(expression, constants, constraints);
  const values = finiteFloatValues(expression, constants, constraints);
  return bounds ? { name, bounds, ...(values ? { values } : {}) } : undefined;
}

function assignedStringFact(statement: Statement, constants: ReadonlyMap<string, Exclude<Constant, undefined>>, constraints: ReadonlyMap<string, VariableConstraint>): { name: string; values: Set<string> } | undefined {
  const name = statement.kind === 'declare' ? statement.name
    : statement.kind === 'set' && statement.target.kind === 'variable' ? statement.target.name : undefined;
  const expression = statement.kind === 'declare' ? statement.initial
    : statement.kind === 'set' ? statement.value : undefined;
  if (!name || !expression) return undefined;
  const values = finiteStringValues(expression, constants, constraints);
  return values ? { name, values } : undefined;
}

function analyzeKnownFunctionCall(name: string, args: Expr[], constants: ReadonlyMap<string, Exclude<Constant, undefined>>, constraints: ReadonlyMap<string, VariableConstraint>, file: string, out: Diagnostic[]): void {
  const fn = activeFunctionDefinitions.get(name);
  if (!fn || activeFunctionCallStack.has(fn.name)) return;
  const callConstants = new Map([...constants].filter(([name]) => activeGlobalNames.has(name)));
  const callConstraints = new Map([...constraints].filter(([name]) => activeGlobalNames.has(name)));
  let hasKnownArgument = false;
  fn.params.forEach((param, index) => {
    const argument = args[index];
    callConstants.delete(param.name); // Parameters shadow constants just as they shadow globals.
    if (!argument) return;
    callConstraints.delete(param.name); // A parameter shadows a same-named global.
    const value = constant(argument, constants);
    if (value !== undefined) {
      callConstants.set(param.name, value);
      hasKnownArgument = true;
    }
    if (param.type === 'int') {
      const bounds = typeof value === 'bigint' ? { min: value, max: value } : integerBounds(argument, constants, constraints);
      if (bounds) {
        const values = finiteIntegerValues(argument, constants, constraints);
        callConstraints.set(param.name, {
          type: 'int', min: bounds.min, max: bounds.max, flow: true,
          ...(values ? { values } : {}),
        });
        hasKnownArgument = true;
      }
    } else if (param.type === 'float') {
      const bounds = typeof value === 'number' ? { min: value, max: value } : floatBounds(argument, constants, constraints);
      if (bounds) {
        const values = finiteFloatValues(argument, constants, constraints);
        callConstraints.set(param.name, {
          type: 'float', floatMin: bounds.min, floatMax: bounds.max, flow: true,
          ...(values ? { floatValues: values } : {}),
        });
        hasKnownArgument = true;
      }
    } else if (param.type === 'str') {
      const values = finiteStringValues(argument, constants, constraints);
      if (values?.size) {
        callConstraints.set(param.name, { type: 'str', values, flow: true });
        hasKnownArgument = true;
      }
    }
  });
  if (!hasKnownArgument) return;

  activeFunctionCallStack.add(fn.name);
  try {
    const contextualDiagnostics: Diagnostic[] = [];
    analyzeBlock(fn.body, file, contextualDiagnostics, true, callConstants, new Map(), callConstraints);
    const severityRank = { info: 0, warning: 1, error: 2 };
    for (const item of contextualDiagnostics) {
      // Specializing a helper with one call's argument makes ordinary branches
      // look unreachable (for example sqrt(-1) takes its documented clamp
      // branch). Those are not defects in the shared function body. Keep only
      // diagnostics whose validation meaningfully depends on the supplied
      // values or affects runtime safety.
      if (!CALL_CONTEXT_DIAGNOSTICS.has(item.code)) continue;
      const previous = out.find(existing => existing.code === item.code && existing.file === item.file && existing.line === item.line && existing.column === item.column);
      if (!previous) out.push(item);
      else if (severityRank[item.severity] > severityRank[previous.severity]) {
        previous.severity = item.severity;
        previous.message = item.message;
      }
    }
  } finally {
    activeFunctionCallStack.delete(fn.name);
  }
}

function analyzeTimedCommand(statement: Statement, constants: ReadonlyMap<string, Exclude<Constant, undefined>>, constraints: ReadonlyMap<string, VariableConstraint> | undefined, file: string, out: Diagnostic[]): void {
  const expression = timedCommandValue(statement);
  if (!expression) return;
  const exact = constant(expression, constants);
  if (typeof exact === 'bigint') {
    if (exact >= 0n && exact <= MAX_TIMED_COMMAND_MS) return;
    const sourceFile = statement.file || file;
    const alreadyReported = out.some((item) => item.code === 'type-error' && item.severity === 'error'
      && item.file === sourceFile && item.line === statement.line && item.message.includes('時間'));
    if (!alreadyReported) out.push(diagnostic(file, 'duration-range', 'error', '確定した演出時間が 0〜2147483647 ms の範囲外です', statement));
    return;
  }
  if (exact !== undefined) return;
  const finiteValues = finiteIntegerValues(expression, constants, constraints || new Map());
  if (finiteValues?.size) {
    const validValues = [...finiteValues].filter(value => value >= 0n && value <= MAX_TIMED_COMMAND_MS);
    if (!validValues.length) {
      out.push(diagnostic(file, 'duration-range', 'error', '演出時間の有限候補がすべて0〜2147483647 msの範囲外です', statement));
      return;
    }
    if (validValues.length !== finiteValues.size) {
      out.push(diagnostic(file, 'duration-range', 'warning', '演出時間の有限候補に0〜2147483647 msの範囲外が含まれます', statement));
      return;
    }
    return;
  }
  let bounds = integerBounds(expression, constants, constraints);
  if (!bounds && expression.kind === 'variable') {
    const constraint = constraints?.get(expression.name);
    if (constraint?.type === 'int' && (constraint.min !== undefined || constraint.max !== undefined)) {
      // An omitted bound is limited only by the language's signed 64-bit int domain.
      bounds = { min: constraint.min ?? INT_MIN, max: constraint.max ?? INT_MAX };
    }
  }
  if (!bounds) return;
  let minimum = bounds.min, maximum = bounds.max;
  if (expression.kind === 'variable') {
    const constraint = constraints?.get(expression.name);
    if (constraint?.type === 'int' && constraint.values?.size) {
      const values = [...constraint.values].filter((value): value is bigint => typeof value === 'bigint');
      if (values.length === constraint.values.size) {
        minimum = values.reduce((min, item) => item < min ? item : min);
        maximum = values.reduce((max, item) => item > max ? item : max);
        const validValues = values.filter((value) => value >= 0n && value <= MAX_TIMED_COMMAND_MS);
        if (!validValues.length) {
          out.push(diagnostic(file, 'duration-range', 'error', '演出時間の許容値がすべて 0〜2147483647 ms の範囲外です', statement));
          return;
        }
        if (validValues.length !== values.length) {
          out.push(diagnostic(file, 'duration-range', 'warning', '演出時間の許容値に 0〜2147483647 ms の範囲外が含まれます', statement));
          return;
        }
        return;
      }
    }
  }
  const below = minimum < 0n, above = maximum > MAX_TIMED_COMMAND_MS;
  if (!below && !above) return;
  const entirelyOutside = maximum < 0n || minimum > MAX_TIMED_COMMAND_MS;
  out.push(diagnostic(file, 'duration-range', entirelyOutside ? 'error' : 'warning', entirelyOutside
    ? '演出時間の値域がすべて 0〜2147483647 ms の範囲外です'
    : '演出時間の値域に 0〜2147483647 ms の範囲外が含まれる可能性があります', statement));
}

function forVariableBounds(statement: Extract<Statement, { kind: 'for' }>, constants: ReadonlyMap<string, Exclude<Constant, undefined>>, constraints?: ReadonlyMap<string, VariableConstraint>): IntegerBounds | undefined {
  const start = integerBounds(statement.start, constants, constraints);
  const stop = integerBounds(statement.stop, constants, constraints);
  const stepValue = constant(statement.step, constants);
  const step = typeof stepValue === 'bigint' ? { min: stepValue, max: stepValue } : integerBounds(statement.step, constants, constraints);
  if (!start || !stop || !step || step.min === 0n || step.min <= 0n && step.max >= 0n) return undefined;
  return {
    min: start.min < stop.min ? start.min : stop.min,
    max: start.max > stop.max ? start.max : stop.max,
  };
}

function forBodyConstraints(statement: Extract<Statement, { kind: 'for' }>, constants: ReadonlyMap<string, Exclude<Constant, undefined>>, constraints?: ReadonlyMap<string, VariableConstraint>): ReadonlyMap<string, VariableConstraint> | undefined {
  const bounds = forVariableBounds(statement, constants, constraints);
  if (!bounds) return constraints;
  const result = constraints ? new Map(constraints) : new Map<string, VariableConstraint>();
  result.set(statement.name, { type: 'int', min: bounds.min, max: bounds.max });
  return result;
}

function forIterationUpperBound(statement: Extract<Statement, { kind: 'for' }>, constants: ReadonlyMap<string, Exclude<Constant, undefined>>, constraints?: ReadonlyMap<string, VariableConstraint>): bigint | undefined {
  const start = integerBounds(statement.start, constants, constraints);
  const stop = integerBounds(statement.stop, constants, constraints);
  const stepValue = constant(statement.step, constants);
  const step = typeof stepValue === 'bigint'
    ? { min: stepValue, max: stepValue }
    : integerBounds(statement.step, constants, constraints);
  if (!start || !stop || !step || step.min === 0n || step.min <= 0n && step.max >= 0n) return undefined;
  if (step.min > 0n) {
    if (stop.max < start.min) return 0n;
    return (stop.max - start.min) / step.min + 1n;
  }
  if (start.max < stop.min) return 0n;
  return (start.max - stop.min) / (-step.max) + 1n;
}

function referencesVariable(expression: Expr, name: string): boolean {
  if (expression.kind === 'variable') return expression.name === name;
  if (expression.kind === 'binary') return referencesVariable(expression.left, name) || referencesVariable(expression.right, name);
  if (expression.kind === 'unary') return referencesVariable(expression.value, name);
  if (expression.kind === 'index') return referencesVariable(expression.target, name) || referencesVariable(expression.key, name);
  if (expression.kind === 'call') return expression.args.some((argument) => referencesVariable(argument, name));
  if (expression.kind === 'dict') return expression.entries.some((entry) => referencesVariable(entry.value, name));
  if (expression.kind === 'list') return expression.items.some((item) => referencesVariable(item, name));
  return false;
}

type WhileIterationEstimate = bigint | 'non-terminating';

interface WhileProgress {
  name: string;
  operator: string;
  start: bigint;
  bound: bigint;
  step?: bigint;
  update: Expr;
  initiallyTrue: boolean;
}

function loopUpdate(statement: Extract<Statement, { kind: 'while' | 'for' }>, name?: string): Extract<Statement, { kind: 'set' }> | undefined {
  const updates = statement.body.filter((current): current is Extract<Statement, { kind: 'set' }> => current.kind === 'set' && current.target.kind === 'variable' && (name === undefined || current.target.name === name));
  if (updates.length !== 1 || statement.body.some((current) => current !== updates[0] && (current.kind !== 'command' || hasCalls(current)))) return undefined;
  return updates[0];
}

function whileProgress(statement: Extract<Statement, { kind: 'while' }>, constants: ReadonlyMap<string, Exclude<Constant, undefined>>): WhileProgress | undefined {
  const condition = statement.condition.expression;
  if (condition.kind !== 'binary' || !['<', '<=', '>', '>='].includes(condition.operator)) return undefined;
  let name: string | undefined;
  let operator = condition.operator;
  let boundExpression: Expr | undefined;
  if (condition.left.kind === 'variable') {
    name = condition.left.name;
    boundExpression = condition.right;
  } else if (condition.right.kind === 'variable') {
    name = condition.right.name;
    boundExpression = condition.left;
    const flipped: Record<string, string> = { '>': '<', '>=': '<=', '<': '>', '<=': '>=' };
    operator = flipped[operator];
  }
  if (!name || !boundExpression || referencesVariable(boundExpression, name)) return undefined;
  const bound = constant(boundExpression, constants);
  if (typeof bound !== 'bigint') return undefined;
  const update = loopUpdate(statement, name);
  if (!update) return undefined;
  if (update.kind !== 'set' || update.target.kind !== 'variable' || update.target.name !== name) return undefined;
  const expression = update.value;
  let step: bigint | undefined;
  if (expression.kind === 'binary') {
    if (expression.left.kind === 'variable' && expression.left.name === name && !referencesVariable(expression.right, name)) {
      const amount = constant(expression.right, constants);
      if (typeof amount === 'bigint') step = expression.operator === '+' ? amount : expression.operator === '-' ? -amount : undefined;
    } else if (expression.operator === '+' && expression.right.kind === 'variable' && expression.right.name === name && !referencesVariable(expression.left, name)) {
      const amount = constant(expression.left, constants);
      if (typeof amount === 'bigint') step = amount;
    }
  }
  const start = constants.get(name);
  if (typeof start !== 'bigint') return undefined;
  const initiallyTrue = operator === '>' ? start > bound
    : operator === '>=' ? start >= bound
      : operator === '<' ? start < bound : start <= bound;
  return { name, operator, start, bound, step, update: expression, initiallyTrue };
}

function whileIterationUpperBound(statement: Extract<Statement, { kind: 'while' }>, constants: ReadonlyMap<string, Exclude<Constant, undefined>>, constraints?: ReadonlyMap<string, VariableConstraint>): WhileIterationEstimate | undefined {
  const condition = statement.condition.expression;
  if (condition.kind !== 'binary' || !['<', '<=', '>', '>='].includes(condition.operator)) return undefined;
  let name: string | undefined;
  let operator = condition.operator;
  let boundExpression: Expr | undefined;
  if (condition.left.kind === 'variable') { name = condition.left.name; boundExpression = condition.right; }
  else if (condition.right.kind === 'variable') {
    name = condition.right.name; boundExpression = condition.left;
    const flipped: Record<string, string> = { '>': '<', '>=': '<=', '<': '>', '<=': '>=' };
    operator = flipped[operator];
  }
  if (!name || !boundExpression || referencesVariable(boundExpression, name)) return undefined;
  const bound = constant(boundExpression, constants);
  const start = integerBounds({ kind: 'variable', name } as Expr, constants, constraints);
  if (typeof bound !== 'bigint' || !start) return undefined;
  const conditionPossible = operator === '<' ? start.min < bound : operator === '<=' ? start.min <= bound : operator === '>' ? start.max > bound : start.max >= bound;
  if (!writtenVariables(statement).has(name) && !hasCalls(statement)) return conditionPossible ? 'non-terminating' : 0n;
  const update = loopUpdate(statement, name);
  if (!update || update.target.kind !== 'variable' || update.target.name !== name || update.value.kind !== 'binary') return undefined;
  let step: bigint | undefined;
  if (update.value.left.kind === 'variable' && update.value.left.name === name && !referencesVariable(update.value.right, name)) {
    const amount = constant(update.value.right, constants);
    if (typeof amount === 'bigint') step = update.value.operator === '+' ? amount : update.value.operator === '-' ? -amount : undefined;
  } else if (update.value.operator === '+' && update.value.right.kind === 'variable' && update.value.right.name === name && !referencesVariable(update.value.left, name)) {
    const amount = constant(update.value.left, constants);
    if (typeof amount === 'bigint') step = amount;
  }
  if (step === undefined) return undefined;
  if (step === 0n) return conditionPossible ? 'non-terminating' : 0n;
  const increasing = operator === '<' || operator === '<=';
  if ((increasing && step < 0n) || (!increasing && step > 0n)) return conditionPossible ? 'non-terminating' : 0n;
  if (increasing) {
    if (start.min > bound || (operator === '<' && start.min === bound)) return 0n;
    const distance = bound - start.min;
    return operator === '<' ? (distance + step - 1n) / step : distance / step + 1n;
  }
  if (start.max < bound || (operator === '>' && start.max === bound)) return 0n;
  const distance = start.max - bound;
  return operator === '>' ? (distance + (-step) - 1n) / (-step) : distance / (-step) + 1n;
}

function whileIterationCount(statement: Extract<Statement, { kind: 'while' }>, constants: ReadonlyMap<string, Exclude<Constant, undefined>>): WhileIterationEstimate | undefined {
  const progress = whileProgress(statement, constants);
  if (!progress) return undefined;
  const { operator, start, bound, step, initiallyTrue } = progress;
  if (step === undefined) return whileExpressionIterations(progress, constants);
  if (!initiallyTrue) return 0n;
  if (step === 0n) return 'non-terminating';
  const increasing = operator === '<' || operator === '<=';
  if ((increasing && step < 0n) || (!increasing && step > 0n)) {
    const afterLimit = start + step * 100000n;
    if (afterLimit >= INT_MIN && afterLimit <= INT_MAX) return 'non-terminating';
    return undefined;
  }
  const distance = increasing ? bound - start : start - bound;
  const amount = step < 0n ? -step : step;
  if (operator === '<' || operator === '>') return (distance + amount - 1n) / amount;
  return distance / amount + 1n;
}

function whileExpressionOverflows(progress: WhileProgress, constants: ReadonlyMap<string, Exclude<Constant, undefined>>): boolean {
  let current = progress.start;
  for (let count = 0; count < 100000; count += 1) {
    const condition = progress.operator === '>' ? current > progress.bound
      : progress.operator === '>=' ? current >= progress.bound
        : progress.operator === '<' ? current < progress.bound : current <= progress.bound;
    if (!condition) return false;
    const iterationConstants = new Map(constants);
    iterationConstants.set(progress.name, current);
    const next = checkedInteger(progress.update, iterationConstants);
    if (next === 'overflow') return true;
    if (next === undefined) return false;
    current = next;
  }
  return false;
}

function whileExpressionIterations(progress: WhileProgress, constants: ReadonlyMap<string, Exclude<Constant, undefined>>): WhileIterationEstimate | undefined {
  let current = progress.start;
  const seen = new Set<string>();
  for (let count = 0; count <= 100000; count += 1) {
    const condition = progress.operator === '>' ? current > progress.bound
      : progress.operator === '>=' ? current >= progress.bound
        : progress.operator === '<' ? current < progress.bound : current <= progress.bound;
    if (!condition) return BigInt(count);
    if (count === 100000 || seen.has(current.toString())) return 'non-terminating';
    seen.add(current.toString());
    const iterationConstants = new Map(constants);
    iterationConstants.set(progress.name, current);
    const next = checkedInteger(progress.update, iterationConstants);
    if (next === 'overflow' || next === undefined) return undefined;
    current = next;
  }
  return 'non-terminating';
}

function whileUpdateOverflows(statement: Extract<Statement, { kind: 'while' }>, constants: ReadonlyMap<string, Exclude<Constant, undefined>>): boolean {
  const progress = whileProgress(statement, constants);
  if (!progress || !progress.initiallyTrue) return false;
  if (progress.step === undefined) return whileExpressionOverflows(progress, constants);
  if (progress.step === 0n) return false;
  // Count the body updates needed to leave the signed 64-bit domain in the
  // update direction. Runtime checks its 100,000-iteration limit before the
  // next body, so an overflow after that point is not the observed failure.
  const updatesToOverflow = progress.step > 0n
    ? (INT_MAX - progress.start) / progress.step + 1n
    : (progress.start - INT_MIN) / (-progress.step) + 1n;
  if (updatesToOverflow > 100000n) return false;
  const iterations = whileIterationCount(statement, constants);
  // Non-terminating or direction-unknown loops continue until either the
  // runtime limit or this update overflow. Finite loops only reach the
  // overflow if enough condition-true iterations are guaranteed.
  return typeof iterations !== 'bigint' ? true : updatesToOverflow <= iterations;
}

function forFirstIterationOverflows(statement: Extract<Statement, { kind: 'for' }>, constants: ReadonlyMap<string, Exclude<Constant, undefined>>): boolean {
  const start = constant(statement.start, constants);
  const stop = constant(statement.stop, constants);
  const step = constant(statement.step, constants);
  if (typeof start !== 'bigint' || typeof stop !== 'bigint' || typeof step !== 'bigint' || step === 0n) return false;
  if ((start < stop && step < 0n) || (start > stop && step > 0n)) return false;
  const update = loopUpdate(statement);
  if (!update || !referencesVariable(update.value, statement.name)) return false;
  const firstIteration = new Map(constants);
  firstIteration.set(statement.name, start);
  return checkedInteger(update.value, firstIteration) === 'overflow';
}

function forRepeatedUpdateOverflows(statement: Extract<Statement, { kind: 'for' }>, constants: ReadonlyMap<string, Exclude<Constant, undefined>>): boolean {
  const iterations = forIterationCount(statement, constants);
  if (iterations === undefined || iterations <= 0n) return false;
  const update = loopUpdate(statement);
  if (!update || update.target.kind !== 'variable' || update.value.kind !== 'binary') return false;
  const name = update.target.name;
  const start = constants.get(name);
  if (typeof start !== 'bigint') return false;
  let delta: bigint | undefined;
  if (update.value.left.kind === 'variable' && update.value.left.name === name && !referencesVariable(update.value.right, name)) {
    const amount = constant(update.value.right, constants);
    if (typeof amount === 'bigint') delta = update.value.operator === '+' ? amount : update.value.operator === '-' ? -amount : undefined;
  } else if (update.value.operator === '+' && update.value.right.kind === 'variable' && update.value.right.name === name && !referencesVariable(update.value.left, name)) {
    const amount = constant(update.value.left, constants);
    if (typeof amount === 'bigint') delta = amount;
  }
  if (delta !== undefined && delta !== 0n) {
    const updatesToOverflow = delta > 0n
      ? (INT_MAX - start) / delta + 1n
      : (start - INT_MIN) / (-delta) + 1n;
    if (updatesToOverflow <= iterations && updatesToOverflow <= 100000n) return true;
  }

  // A loop variable is also a constant at each individual iteration. Track
  // the accumulator for the observable prefix of the loop so expressions such
  // as `value = value + i` cannot hide an overflow on a later iteration.
  const loopStart = constant(statement.start, constants);
  const loopStep = constant(statement.step, constants);
  if (typeof loopStart !== 'bigint' || typeof loopStep !== 'bigint' || loopStep === 0n) return false;
  const observedIterations = iterations < 100000n ? iterations : 100000n;
  let current = start;
  let loopValue = loopStart;
  for (let index = 0n; index < observedIterations; index += 1n) {
    const iterationConstants = new Map(constants);
    iterationConstants.set(name, current);
    iterationConstants.set(statement.name, loopValue);
    const next = checkedInteger(update.value, iterationConstants);
    if (next === 'overflow') return true;
    if (next === undefined) return false;
    current = next;
    loopValue += loopStep;
  }
  return false;
}

function forConstraintUpdateOverflow(
  statement: Extract<Statement, { kind: 'for' }>,
  constants: ReadonlyMap<string, Exclude<Constant, undefined>>,
  constraints?: ReadonlyMap<string, VariableConstraint>,
): 'error' | 'warning' | undefined {
  const update = loopUpdate(statement);
  if (!update || update.target.kind !== 'variable' || update.target.name === statement.name || !constraints?.has(update.target.name) || constant(update.value, constants) !== undefined) return undefined;
  const bodyConstraints = forBodyConstraints(statement, constants, constraints);
  const bounds = integerBounds(update.value, constants, bodyConstraints);
  const start = integerBounds(statement.start, constants, constraints);
  const stop = integerBounds(statement.stop, constants, constraints);
  const stepValue = constant(statement.step, constants);
  const step = typeof stepValue === 'bigint' ? { min: stepValue, max: stepValue } : integerBounds(statement.step, constants, constraints);
  const guaranteed = start && stop && step && step.min === step.max && step.min !== 0n
    ? step.min > 0n ? start.max <= stop.min : start.min >= stop.max
    : false;
  let severity: 'error' | 'warning' | undefined;
  if (bounds && (bounds.min < INT_MIN || bounds.max > INT_MAX)) severity = bounds.min > INT_MAX || bounds.max < INT_MIN ? (guaranteed ? 'error' : 'warning') : 'warning';

  let delta: bigint | undefined;
  if (update.value.kind === 'binary') {
    if (update.value.left.kind === 'variable' && update.value.left.name === update.target.name && !referencesVariable(update.value.right, update.target.name)) {
      const amount = constant(update.value.right, constants);
      if (typeof amount === 'bigint') delta = update.value.operator === '+' ? amount : update.value.operator === '-' ? -amount : undefined;
    } else if (update.value.operator === '+' && update.value.right.kind === 'variable' && update.value.right.name === update.target.name && !referencesVariable(update.value.left, update.target.name)) {
      const amount = constant(update.value.left, constants);
      if (typeof amount === 'bigint') delta = amount;
    }
  }
  const targetBounds = integerBounds({ kind: 'variable', name: update.target.name }, constants, constraints);
  const iterations = forIterationCount(statement, constants);
  const iterationUpperBound = iterations === undefined ? forIterationUpperBound(statement, constants, constraints) : iterations;
  if (delta !== undefined && delta !== 0n && targetBounds && iterationUpperBound !== undefined && iterationUpperBound > 0n) {
    const finalMin = targetBounds.min + delta * iterationUpperBound;
    const finalMax = targetBounds.max + delta * iterationUpperBound;
    const repeatedOverflow = finalMin < INT_MIN || finalMax > INT_MAX;
    if (repeatedOverflow) {
      const exact = targetBounds.min === targetBounds.max && iterations !== undefined;
      severity = exact ? 'error' : severity || 'warning';
    }
  }
  return severity;
}

function definitelyTerminates(statement: Statement, constants: ReadonlyMap<string, Exclude<Constant, undefined>> = new Map(), facts: ReadonlyMap<string, boolean> = new Map(), constraints?: ReadonlyMap<string, VariableConstraint>): boolean {
  if (statement.kind === 'return' || statement.kind === 'goto') return true;
  if (statement.kind === 'if') {
    const branches = [{ condition: statement.condition.expression, body: statement.body }, ...statement.elseIf.map((branch) => ({ condition: branch.condition.expression, body: branch.body }))];
    let allTerminate = true;
    let canFallThrough = true;
    const seen = new Set<string>(), previousConditions: Expr[] = [], remainingFacts = new Map(facts);
    for (const branch of branches) {
      if (!canFallThrough) break;
      const value = conditionValue(branch.condition, constants, remainingFacts, constraints);
      if (value === false) { recordCondition(remainingFacts, branch.condition, false); continue; }
      const key = expressionKey(branch.condition);
      if (isPureExpression(branch.condition) && (seen.has(key) || previousConditions.some((previous) => conditionImplies(branch.condition, previous, constants)))) continue;
      const bodyFacts = new Map(remainingFacts); recordCondition(bodyFacts, branch.condition, true);
      allTerminate = allTerminate && blockTerminates(branch.body, constants, bodyFacts, constraints);
      if (isPureExpression(branch.condition)) seen.add(key);
      if (isPureExpression(branch.condition)) previousConditions.push(branch.condition);
      recordCondition(remainingFacts, branch.condition, false);
      if (value === true) canFallThrough = false;
    }
    if (canFallThrough) {
      if (!statement.otherwise.length) return false;
      allTerminate = allTerminate && blockTerminates(statement.otherwise, constants, remainingFacts, constraints);
    }
    return allTerminate;
  }
  if (statement.kind === 'while') {
    if (conditionValue(statement.condition.expression, constants, facts, constraints) !== true) return false;
    const stable = loopConstants(statement, constants);
    const stableConstraints = constraints ? new Map(constraints) : undefined;
    invalidateConstraintState(statement, stableConstraints);
    return conditionValue(statement.condition.expression, stable, new Map(), stableConstraints) === true || blockTerminates(statement.body, constants, facts, constraints);
  }
  if (statement.kind === 'for') return forExecution(statement, constants) !== 'invalid' && blockTerminates(statement.body, constants, facts, forBodyConstraints(statement, constants, constraints));
  if (statement.kind === 'choice') return statement.options.length > 0 && statement.options.every((option) => blockTerminates(option.body, constants, facts, constraints));
  return false;
}

function writtenVariables(statement: Statement, result = new Set<string>()): Set<string> {
  if (statement.kind === 'declare') result.add(statement.name);
  if (statement.kind === 'set' && statement.target.kind === 'variable') result.add(statement.target.name);
  for (const body of nested(statement)) for (const child of body) writtenVariables(child, result);
  return result;
}

let activeFunctionEffects: ReadonlyMap<string, ReadonlySet<string>> = new Map();
let activeFunctionDefinitions: ReadonlyMap<string, FunctionDef> = new Map();
let activeGlobalNames: ReadonlySet<string> = new Set();
const activeFunctionCallStack = new Set<string>();

function callChangesState(name: string): boolean {
  if (isNonMutatingBuiltin(name)) return false;
  const effects = activeFunctionEffects.get(name);
  return !effects || effects.has('*') || effects.size > 0;
}

function invalidateConstraintCalls(expressions: Expr[], constraints: Map<string, VariableConstraint> | undefined, names: string[] = []): void {
  if (!constraints) return;
  const invalidate = (name: string) => {
    if (!callChangesState(name)) return;
    const effects = activeFunctionEffects.get(name);
    if (!effects || effects.has('*')) constraints.clear();
    else effects.forEach((effect) => constraints.delete(effect));
  };
  names.forEach(invalidate);
  expressions.forEach((expression) => visitExpressions(expression, (current) => {
    if (current.kind === 'call') invalidate(current.name);
  }));
}

function invalidateConstraintCallsInExecution(
  expression: Expr,
  constants: ReadonlyMap<string, Exclude<Constant, undefined>>,
  facts: ReadonlyMap<string, boolean>,
  constraints: Map<string, VariableConstraint> | undefined,
): void {
  if (!constraints) return;
  if (expression.kind === 'binary' && (expression.operator === 'and' || expression.operator === 'or')) {
    invalidateConstraintCallsInExecution(expression.left, constants, facts, constraints);
    const left = conditionValue(expression.left, constants, facts, constraints);
    if (expression.operator === 'and' && left === false || expression.operator === 'or' && left === true) return;
    invalidateConstraintCallsInExecution(expression.right, constants, facts, constraints);
    return;
  }
  if (expression.kind === 'unary') {
    invalidateConstraintCallsInExecution(expression.value, constants, facts, constraints);
    return;
  }
  if (expression.kind === 'binary') {
    invalidateConstraintCallsInExecution(expression.left, constants, facts, constraints);
    invalidateConstraintCallsInExecution(expression.right, constants, facts, constraints);
    return;
  }
  if (expression.kind === 'index') {
    invalidateConstraintCallsInExecution(expression.target, constants, facts, constraints);
    invalidateConstraintCallsInExecution(expression.key, constants, facts, constraints);
    return;
  }
  if (expression.kind === 'call') {
    invalidateConstraintCallsInExecutionForArguments(expression.args, constants, facts, constraints);
    invalidateConstraintCalls([], constraints, [expression.name]);
    return;
  }
  if (expression.kind === 'dict') invalidateConstraintCallsInExecutionForArguments(expression.entries.map((entry) => entry.value), constants, facts, constraints);
  if (expression.kind === 'list') invalidateConstraintCallsInExecutionForArguments(expression.items, constants, facts, constraints);
}

function invalidateConstraintCallsInExecutionForArguments(
  expressions: Expr[],
  constants: ReadonlyMap<string, Exclude<Constant, undefined>>,
  facts: ReadonlyMap<string, boolean>,
  constraints: Map<string, VariableConstraint>,
): void {
  expressions.forEach((expression) => invalidateConstraintCallsInExecution(expression, constants, facts, constraints));
}

function invalidateConstraintState(statement: Statement, constraints: Map<string, VariableConstraint> | undefined): void {
  if (!constraints) return;
  writtenVariables(statement).forEach((name) => constraints.delete(name));
  invalidateConstraintCalls(statementExpressions(statement), constraints, statement.kind === 'call' ? [statement.name] : []);
}

function expressionCalls(expr: Expr): Set<string> {
  const calls = new Set<string>();
  visitExpressions(expr, (current) => {
    if (current.kind === 'call') calls.add(current.name);
    if (current.kind === 'literal' && typeof current.value === 'string') {
      for (const match of current.value.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\(\)\}/g)) calls.add(match[1]);
    }
  });
  return calls;
}

function expressionChangesState(expr: Expr): boolean {
  return [...expressionCalls(expr)].some(callChangesState);
}

function invalidateConstantCall(name: string, constants: Map<string, Exclude<Constant, undefined>>): boolean {
  if (!callChangesState(name)) return false;
  const effects = activeFunctionEffects.get(name);
  if (!effects || effects.has('*')) constants.clear();
  else effects.forEach((effect) => constants.delete(effect));
  return true;
}

function invalidateConstantCalls(expr: Expr, constants: Map<string, Exclude<Constant, undefined>>, facts: ReadonlyMap<string, boolean>): boolean {
  if (expr.kind === 'binary' && (expr.operator === 'and' || expr.operator === 'or')) {
    let invalidated = invalidateConstantCalls(expr.left, constants, facts);
    const left = conditionValue(expr.left, constants, facts);
    if (expr.operator === 'and' && left === false || expr.operator === 'or' && left === true) return invalidated;
    return invalidateConstantCalls(expr.right, constants, facts) || invalidated;
  }
  if (expr.kind === 'binary') return invalidateConstantCalls(expr.right, constants, facts) || invalidateConstantCalls(expr.left, constants, facts);
  if (expr.kind === 'unary') return invalidateConstantCalls(expr.value, constants, facts);
  if (expr.kind === 'index') return invalidateConstantCalls(expr.key, constants, facts) || invalidateConstantCalls(expr.target, constants, facts);
  if (expr.kind === 'dict') return expr.entries.reduce((changed, entry) => invalidateConstantCalls(entry.value, constants, facts) || changed, false);
  if (expr.kind === 'list') return expr.items.reduce((changed, item) => invalidateConstantCalls(item, constants, facts) || changed, false);
  if (expr.kind === 'call') {
    const argumentsChanged = expr.args.reduce((changed, argument) => invalidateConstantCalls(argument, constants, facts) || changed, false);
    return invalidateConstantCall(expr.name, constants) || argumentsChanged;
  }
  if (expr.kind === 'literal' && typeof expr.value === 'string') {
    let invalidated = false;
    for (const match of expr.value.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\(\)\}/g)) invalidated = invalidateConstantCall(match[1], constants) || invalidated;
    return invalidated;
  }
  return false;
}

function hasCalls(statement: Statement): boolean {
  return statement.kind === 'call' && callChangesState(statement.name) || statementExpressions(statement).some(expressionChangesState) || nested(statement).some((body) => body.some(hasCalls));
}

function functionEffects(functions: readonly FunctionDef[], globals: ReadonlySet<string>): ReadonlyMap<string, ReadonlySet<string>> {
  const direct = new Map<string, Set<string>>(), calls = new Map<string, Set<string>>();
  for (const fn of functions) {
    const writes = new Set<string>(), invoked = new Set<string>();
    const walk = (statements: Statement[], locals: Set<string>): void => {
      for (const statement of statements) {
        if (statement.kind === 'declare') {
          if ((statement as Statement & { global?: boolean }).global) {
            if (globals.has(statement.name)) writes.add(statement.name);
          } else locals.add(statement.name);
        }
        if (statement.kind === 'set' || statement.kind === 'unset') {
          const target = statement.target;
          if (target.kind === 'variable' && !locals.has(target.name) && globals.has(target.name)) writes.add(target.name);
        }
        if (statement.kind === 'call' && !isNonMutatingBuiltin(statement.name)) invoked.add(statement.name);
        for (const expression of statementExpressions(statement)) expressionCalls(expression).forEach((name) => { if (!isNonMutatingBuiltin(name)) invoked.add(name); });
        for (const body of nested(statement)) walk(body, new Set(locals));
      }
    };
    walk(fn.body, new Set(fn.params.map((param) => param.name)));
    direct.set(fn.name, writes); calls.set(fn.name, invoked);
  }
  for (const [name, invoked] of calls) for (const callee of invoked) if (!direct.has(callee)) direct.get(name)!.add('*');
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, invoked] of calls) for (const callee of invoked) for (const effect of direct.get(callee) || ['*']) {
      const writes = direct.get(name)!;
      if (!writes.has(effect)) { writes.add(effect); changed = true; }
    }
  }
  return direct;
}

function loopConstants(statement: Statement, constants: ReadonlyMap<string, Exclude<Constant, undefined>>): Map<string, Exclude<Constant, undefined>> {
  const stable = new Map(constants);
  if (hasCalls(statement)) stable.clear();
  for (const name of writtenVariables(statement)) stable.delete(name);
  if (statement.kind === 'for' || statement.kind === 'forEach') stable.delete(statement.name);
  return stable;
}

function updateKnownConstants(statement: Statement, constants: Map<string, Exclude<Constant, undefined>>): void {
  if (hasCalls(statement)) constants.clear();
  if (statement.kind === 'declare') {
    const value = statement.initial ? constant(statement.initial, constants) : undefined;
    if (value === undefined) constants.delete(statement.name); else constants.set(statement.name, value);
    return;
  }
  if (statement.kind === 'set' && statement.target.kind === 'variable') {
    const value = constant(statement.value, constants);
    if (value === undefined) constants.delete(statement.target.name); else constants.set(statement.target.name, value);
    return;
  }
  if (statement.kind === 'if' || statement.kind === 'while' || statement.kind === 'for' || statement.kind === 'forEach' || statement.kind === 'choice') {
    for (const name of writtenVariables(statement)) constants.delete(name);
  }
}

function invalidatesConditionFacts(statement: Statement): boolean {
  if (statement.kind === 'declare' || statement.kind === 'set' || statement.kind === 'unset') return true;
  if (statement.kind === 'call') return callChangesState(statement.name);
  return statementExpressions(statement).some((expr) => {
    let calls = false;
    visitExpressions(expr, (current) => {
      if (current.kind === 'call' && callChangesState(current.name)) calls = true;
      if (current.kind === 'literal' && typeof current.value === 'string' && /\{[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*(?:\(\))?\}/.test(current.value)) calls = true;
    });
    return calls;
  });
}

function blockTerminates(statements: Statement[], constants: ReadonlyMap<string, Exclude<Constant, undefined>> = new Map(), facts: ReadonlyMap<string, boolean> = new Map(), constraints?: ReadonlyMap<string, VariableConstraint>): boolean {
  const known = new Map(constants);
  const knownFacts = new Map(facts);
  for (const statement of statements) {
    if (hasCalls(statement)) { known.clear(); knownFacts.clear(); }
    if (definitelyTerminates(statement, known, knownFacts, constraints)) return true;
    updateKnownConstants(statement, known);
    if (invalidatesConditionFacts(statement)) knownFacts.clear();
  }
  return false;
}

function reachableGotoTargets(statements: Statement[], targets = new Set<string>(), constants: ReadonlyMap<string, Exclude<Constant, undefined>> = new Map(), facts: ReadonlyMap<string, boolean> = new Map(), constraints?: ReadonlyMap<string, VariableConstraint>): Set<string> {
  const known = new Map(constants);
  const knownFacts = new Map(facts);
  for (const statement of statements) {
    if (statement.kind === 'goto') {
      targets.add(statement.scene);
      break;
    }
    if (statement.kind === 'if') {
      if (hasCalls(statement)) { known.clear(); knownFacts.clear(); }
      const branches = [{ expression: statement.condition.expression, body: statement.body }, ...statement.elseIf.map((branch) => ({ expression: branch.condition.expression, body: branch.body }))];
      const seen = new Set<string>(), previousConditions: Expr[] = [], remainingFacts = new Map(knownFacts);
      let canTryNext = true;
      for (const branch of branches) {
        if (!canTryNext) break;
        const value = conditionValue(branch.expression, known, remainingFacts, constraints);
        const key = expressionKey(branch.expression);
        const duplicate = isPureExpression(branch.expression) && (seen.has(key) || previousConditions.some((previous) => conditionImplies(branch.expression, previous, known)));
        const bodyFacts = new Map(remainingFacts); recordCondition(bodyFacts, branch.expression, true);
        if (value !== false && !duplicate) reachableGotoTargets(branch.body, targets, known, bodyFacts, constraints);
        if (isPureExpression(branch.expression)) seen.add(key);
        if (isPureExpression(branch.expression)) previousConditions.push(branch.expression);
        recordCondition(remainingFacts, branch.expression, false);
        if (value === true) canTryNext = false;
      }
      if (canTryNext) reachableGotoTargets(statement.otherwise, targets, known, remainingFacts, constraints);
    } else if (statement.kind === 'choice') statement.options.forEach((option) => reachableGotoTargets(option.body, targets, known, knownFacts, constraints));
    else if (statement.kind === 'while') {
      if (conditionValue(statement.condition.expression, known, knownFacts, constraints) !== false) {
        const bodyFacts = new Map(knownFacts); recordCondition(bodyFacts, statement.condition.expression, true);
        reachableGotoTargets(statement.body, targets, known, bodyFacts, constraints);
      }
    } else if (statement.kind === 'for') {
      if (forExecution(statement, known) !== 'invalid') reachableGotoTargets(statement.body, targets, known, knownFacts, constraints);
    } else if (statement.kind === 'forEach') {
      reachableGotoTargets(statement.body, targets, known, knownFacts, constraints);
    }
    if (definitelyTerminates(statement, known, knownFacts, constraints)) break;
    updateKnownConstants(statement, known);
    if (invalidatesConditionFacts(statement)) knownFacts.clear();
  }
  return targets;
}

interface ReachableTransfer {
  target: string;
  constants: Map<string, Exclude<Constant, undefined>>;
}

interface TransferFlow {
  transfers: ReachableTransfer[];
  fallthrough?: Map<string, Exclude<Constant, undefined>>;
}

function mergeConstantEnvironments(paths: readonly ReadonlyMap<string, Exclude<Constant, undefined>>[]): Map<string, Exclude<Constant, undefined>> {
  if (!paths.length) return new Map();
  const merged = new Map(paths[0]);
  for (const [name, value] of merged) {
    if (paths.some((path) => !path.has(name) || path.get(name) !== value)) merged.delete(name);
  }
  return merged;
}

/** Propagate known values through scene-local branches to each reachable transfer. */
function reachableTransfers(
  statements: Statement[],
  constants: ReadonlyMap<string, Exclude<Constant, undefined>> = new Map(),
  facts: ReadonlyMap<string, boolean> = new Map(),
  constraints?: ReadonlyMap<string, VariableConstraint>,
): TransferFlow {
  const known = new Map(constants);
  const knownFacts = new Map(facts);
  const transfers: ReachableTransfer[] = [];
  for (const statement of statements) {
    if (statement.kind === 'goto') return { transfers: [...transfers, { target: statement.scene, constants: new Map(known) }] };
    if (statement.kind === 'if') {
      const branches = [{ expression: statement.condition.expression, body: statement.body }, ...statement.elseIf.map((branch) => ({ expression: branch.condition.expression, body: branch.body }))];
      const seen = new Set<string>(), previousConditions: Expr[] = [], remainingFacts = new Map(knownFacts), remainingKnown = new Map(known);
      const fallthroughs: Map<string, Exclude<Constant, undefined>>[] = [];
      let canTryNext = true;
      for (const branch of branches) {
        if (!canTryNext) break;
        if (invalidateConstantCalls(branch.expression, remainingKnown, remainingFacts)) remainingFacts.clear();
        const value = conditionValue(branch.expression, remainingKnown, remainingFacts, constraints);
        const key = expressionKey(branch.expression);
        const duplicate = isPureExpression(branch.expression) && (seen.has(key) || previousConditions.some((previous) => conditionImplies(branch.expression, previous, remainingKnown)));
        const bodyFacts = new Map(remainingFacts); recordCondition(bodyFacts, branch.expression, true);
        const bodyConstraints = refineConstraints(constraints, branch.expression, true);
        if (value !== false && !duplicate) {
          const flow = reachableTransfers(branch.body, remainingKnown, bodyFacts, bodyConstraints);
          transfers.push(...flow.transfers);
          if (flow.fallthrough) fallthroughs.push(flow.fallthrough);
          else if (!blockTerminates(branch.body, remainingKnown, bodyFacts, bodyConstraints)) fallthroughs.push(new Map(remainingKnown));
        }
        if (isPureExpression(branch.expression)) seen.add(key);
        if (isPureExpression(branch.expression)) previousConditions.push(branch.expression);
        recordCondition(remainingFacts, branch.expression, false);
        if (value === true) canTryNext = false;
      }
      if (canTryNext) {
        const otherwiseConstraints = branches.reduce((state, branch) => refineConstraints(state, branch.expression, false), constraints);
        const flow = reachableTransfers(statement.otherwise, remainingKnown, remainingFacts, otherwiseConstraints);
        transfers.push(...flow.transfers);
        if (flow.fallthrough) fallthroughs.push(flow.fallthrough);
        else if (!blockTerminates(statement.otherwise, remainingKnown, remainingFacts, otherwiseConstraints)) fallthroughs.push(new Map(remainingKnown));
      }
      if (!fallthroughs.length) return { transfers };
      const joined = mergeConstantEnvironments(fallthroughs);
      known.clear(); joined.forEach((value, name) => known.set(name, value));
      if (invalidatesConditionFacts(statement)) knownFacts.clear();
      continue;
    }
    if (statement.kind === 'choice') {
      if (!statement.options.length) continue;
      const choiceState = new Map(known);
      const choiceFacts = new Map(knownFacts);
      // Runtime evaluates every label in order, then the prompt, before any
      // option body executes. Account for state-changing calls at that point.
      for (const option of statement.options) if (invalidateConstantCalls(option.label, choiceState, choiceFacts)) choiceFacts.clear();
      if (statement.prompt && invalidateConstantCalls(statement.prompt, choiceState, choiceFacts)) choiceFacts.clear();
      const fallthroughs: Map<string, Exclude<Constant, undefined>>[] = [];
      for (const option of statement.options) {
        const flow = reachableTransfers(option.body, choiceState, choiceFacts, constraints);
        transfers.push(...flow.transfers);
        if (flow.fallthrough) fallthroughs.push(flow.fallthrough);
        else if (!blockTerminates(option.body, choiceState, choiceFacts, constraints)) fallthroughs.push(new Map(choiceState));
      }
      if (!fallthroughs.length) return { transfers };
      const joined = mergeConstantEnvironments(fallthroughs);
      known.clear(); joined.forEach((value, name) => known.set(name, value));
      for (const name of writtenVariables(statement)) known.delete(name);
      knownFacts.clear();
      continue;
    }
    if (statement.kind === 'for') {
      const start = constant(statement.start, known);
      const step = constant(statement.step, known);
      const iterations = forIterationCount(statement, known);
      if (forExecution(statement, known) === 'runs' && typeof start === 'bigint' && typeof step === 'bigint'
        && iterations !== undefined && iterations <= 32n) {
        const last = start + step * (iterations - 1n);
        // Do not claim a normal loop exit when incrementing the final value
        // could overflow at runtime; use the conservative loop path below.
        const next = last + step;
        if (next >= INT_MIN && next <= INT_MAX) {
          let value = start;
          let state = new Map(known);
          let fallsThrough = true;
          for (let index = 0n; index < iterations; index += 1n) {
            const iterationState = new Map(state);
            iterationState.set(statement.name, value);
            const flow = reachableTransfers(statement.body, iterationState, knownFacts, constraints);
            for (const transfer of flow.transfers) {
              const transferState = new Map(transfer.constants);
              transferState.delete(statement.name);
              transfers.push({ target: transfer.target, constants: transferState });
            }
            if (!flow.fallthrough) { fallsThrough = false; break; }
            state = flow.fallthrough;
            state.delete(statement.name);
            value += step;
          }
          if (!fallsThrough) return { transfers };
          known.clear(); state.forEach((valueAtExit, name) => known.set(name, valueAtExit));
          knownFacts.clear();
          continue;
        }
      }
    }
    if (statement.kind === 'while') {
      const iterations = whileIterationCount(statement, known);
      if (typeof iterations === 'bigint' && iterations <= 32n && whileProgress(statement, known)) {
        let state = new Map(known);
        let fallsThrough = true;
        for (let index = 0n; index < iterations; index += 1n) {
          if (conditionValue(statement.condition.expression, state, knownFacts, constraints) === false) break;
          const flow = reachableTransfers(statement.body, state, knownFacts, constraints);
          transfers.push(...flow.transfers);
          if (!flow.fallthrough) { fallsThrough = false; break; }
          state = flow.fallthrough;
        }
        if (!fallsThrough) return { transfers };
        known.clear(); state.forEach((valueAtExit, name) => known.set(name, valueAtExit));
        knownFacts.clear();
        continue;
      }
    }
    // Preserve transfer discovery for loops and other nested flow constructs.
    // Their post-loop values are widened by updateKnownConstants below.
    if (statement.kind === 'while' || statement.kind === 'for' || statement.kind === 'forEach') {
      if (statement.kind === 'while' && conditionValue(statement.condition.expression, known, knownFacts, constraints) === false) continue;
      const loopState = loopConstants(statement, known);
      for (const target of reachableGotoTargets([statement], new Set(), known, knownFacts, constraints)) {
        transfers.push({ target, constants: new Map(loopState) });
      }
      if (definitelyTerminates(statement, known, knownFacts, constraints)) return { transfers };
    }
    if (definitelyTerminates(statement, known, knownFacts, constraints)) return { transfers };
    updateKnownConstants(statement, known);
    if (invalidatesConditionFacts(statement)) knownFacts.clear();
  }
  return { transfers, fallthrough: known };
}

export interface SceneReachability {
  reachableScenes: Set<string>;
  externalGotos: Set<string>;
}

export function sceneReachability(script: Script, constraints?: ReadonlyMap<string, VariableConstraint>, externalGlobals: ReadonlySet<string> = new Set()): SceneReachability {
  const globalNames = new Set([...externalGlobals, ...script.globals.filter((statement) => statement.kind === 'declare').map((statement) => statement.name)]);
  activeFunctionEffects = functionEffects(script.functions, globalNames);
  const scenes = new Map(script.scenes.map((scene) => [scene.name, scene]));
  const firstSceneByFile = new Map<string, string>();
  const normalizeFile = (file: string) => file.replaceAll('\\', '/').replace(/^\.\//, '').toLocaleLowerCase('en-US');
  const firstSceneForFileTarget = (target: string) => {
    const normalized = normalizeFile(target);
    if (/\.txt$/i.test(normalized)) return undefined;
    const fileName = /\.tds$/i.test(normalized) ? normalized : `${normalized}.tds`;
    return firstSceneByFile.get(fileName);
  };
  for (const scene of script.scenes) {
    if (scene.file && !firstSceneByFile.has(normalizeFile(scene.file))) firstSceneByFile.set(normalizeFile(scene.file), scene.name);
  }
  const reachableScenes = new Set<string>();
  const externalGotos = new Set<string>();
  const constants = new Map<string, Exclude<Constant, undefined>>();
  const globalFlow = reachableTransfers(script.globals, constants, new Map(), constraints);
  const pending: Array<{ name: string; constants: Map<string, Exclude<Constant, undefined>> }> = [];
  const enqueueTarget = (target: string, state: Map<string, Exclude<Constant, undefined>>) => {
    if (scenes.has(target)) pending.push({ name: target, constants: state });
    else {
      const fileEntry = firstSceneForFileTarget(target);
      if (fileEntry) pending.push({ name: fileEntry, constants: state });
      else externalGotos.add(target);
    }
  };
  if (script.scenes.length && globalFlow.fallthrough) pending.push({ name: script.scenes[0].name, constants: globalFlow.fallthrough });
  globalFlow.transfers.forEach((transfer) => enqueueTarget(transfer.target, transfer.constants));
  const entryStates = new Map<string, Map<string, Exclude<Constant, undefined>>>();
  while (pending.length) {
    const { name, constants: incoming } = pending.pop()!;
    const scene = scenes.get(name);
    if (!scene) continue;
    const previous = entryStates.get(name);
    const entry = previous ? mergeConstantEnvironments([previous, incoming]) : new Map(incoming);
    if (previous && previous.size === entry.size && [...previous].every(([key, value]) => entry.get(key) === value)) continue;
    entryStates.set(name, entry);
    reachableScenes.add(name);
    const flow = reachableTransfers(scene.body, entry, new Map(), constraints);
    flow.transfers.forEach((transfer) => enqueueTarget(transfer.target, transfer.constants));
  }
  if (!script.scenes.length) {
    globalFlow.transfers.forEach((transfer) => externalGotos.add(transfer.target));
  }
  return { reachableScenes, externalGotos };
}

function analyzeExpression(expr: Expr, file: string, out: Diagnostic[], constants: ReadonlyMap<string, Exclude<Constant, undefined>> = new Map()): void {
  const walk = (current: Expr, parent?: Expr): void => {
    if (current.kind === 'call' && current.args.length === 1 && (current.name === 'int' || current.name === 'float')) {
      const argument = constant(current.args[0], constants);
      let invalid: string | undefined;
      if (current.name === 'int' && typeof argument === 'string' && !/^[+-]?\d+$/.test(argument)) invalid = 'int() 変換エラー: 渡された文字列が整数形式ではありません';
      if (current.name === 'int' && typeof argument === 'number' && Number.isFinite(argument)) {
        const value = BigInt(Math.trunc(argument));
        if (value < INT_MIN || value > INT_MAX) invalid = 'int() 変換エラー: 結果が64bit整数の範囲を超えます';
      }
      if (current.name === 'float' && typeof argument === 'string') {
        if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(argument) || !Number.isFinite(Number(argument))) invalid = 'float() 変換エラー: 渡された文字列が有限数値形式ではありません';
      }
      if (current.name === 'float' && typeof argument === 'number' && !Number.isFinite(argument)) invalid = 'float() 変換エラー: 結果が有限値ではありません';
      if (invalid) out.push(diagnostic(file, 'invalid-conversion', 'error', invalid, current));
    }
    if (current.kind === 'binary') {
      const right = constant(current.right, constants);
      if ((current.operator === '/' || current.operator === '%') && (right === 0n || right === 0)) {
        out.push(diagnostic(file, 'division-by-zero', 'warning', '0 による除算または剰余は実行時エラーになります', current));
      }
      if (['+', '-', '*', '/'].includes(current.operator)) {
        const left = constant(current.left, constants);
        if (typeof left === 'number' && typeof right === 'number') {
          const result = current.operator === '+' ? left + right : current.operator === '-' ? left - right
            : current.operator === '*' ? left * right : right === 0 ? undefined : left / right;
          if (result !== undefined && !Number.isFinite(result)) out.push(diagnostic(file, 'float-overflow', 'error', '小数演算の結果が有限値の範囲を超えます', current));
        }
      }
    }
    const value = constant(current, constants);
    const minimumMagnitude = current.kind === 'literal' && value === INT_MAX + 1n && parent?.kind === 'unary' && parent.operator === '-';
    if (typeof value === 'bigint' && (value < INT_MIN || value > INT_MAX) && !minimumMagnitude) {
      out.push(diagnostic(file, 'integer-overflow', 'error', '定数式で64bit整数オーバーフローが発生します', current));
    }
    if (current.kind === 'binary') {
      walk(current.left, current);
      const left = constant(current.left, constants);
      if (!((current.operator === 'and' && left === false) || (current.operator === 'or' && left === true))) walk(current.right, current);
    }
    if (current.kind === 'unary') walk(current.value, current);
    if (current.kind === 'index') { walk(current.target, current); walk(current.key, current); }
    if (current.kind === 'call') current.args.forEach((arg) => walk(arg, current));
    if (current.kind === 'dict') current.entries.forEach((entry) => walk(entry.value, current));
    if (current.kind === 'list') current.items.forEach((item) => walk(item, current));
  };
  walk(expr);
}

function analyzeConstrainedConversions(expr: Expr, file: string, out: Diagnostic[], constants: ReadonlyMap<string, Exclude<Constant, undefined>>, constraints: ReadonlyMap<string, VariableConstraint>): void {
  visitExpressions(expr, current => {
    if (current.kind !== 'call' || current.args.length !== 1) return;
    const argument = current.args[0];
    if (constant(argument, constants) !== undefined) return;
    if (current.name === 'int') {
      const bounds = floatBounds(argument, constants, constraints);
      if (bounds) {
        const minimum = Number(INT_MIN), maximumExclusive = Number(INT_MAX) + 1;
        const definitelyInvalid = bounds.max < minimum || bounds.min >= maximumExclusive;
        const mayBeInvalid = definitelyInvalid || bounds.min < minimum || bounds.max >= maximumExclusive;
        if (mayBeInvalid) out.push(diagnostic(file, 'invalid-conversion', definitelyInvalid ? 'error' : 'warning',
          'int() の値域に64bit整数へ変換できない値が含まれます', current));
      }
      if (argument.kind === 'variable') {
        const domain = constraints.get(argument.name);
        if (domain?.type === 'str' && domain.values?.size) {
          const valid = [...domain.values].filter((value): value is string => typeof value === 'string').filter(value => {
            if (!/^[+-]?\d+$/.test(value)) return false;
            const integerValue = BigInt(value);
            return integerValue >= INT_MIN && integerValue <= INT_MAX;
          });
          const invalidCount = domain.values.size - valid.length;
          if (invalidCount) out.push(diagnostic(file, 'invalid-conversion', valid.length ? 'warning' : 'error',
            'int() の文字列候補に整数へ変換できない値が含まれます', current));
        }
      }
    } else if (current.name === 'float' && argument.kind === 'variable') {
      const domain = constraints.get(argument.name);
      if (domain?.type === 'str' && domain.values?.size) {
        const valid = [...domain.values].filter((value): value is string => typeof value === 'string').filter(value =>
          /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value) && Number.isFinite(Number(value)));
        if (valid.length !== domain.values.size) out.push(diagnostic(file, 'invalid-conversion', valid.length ? 'warning' : 'error',
          'float() の文字列候補に有限数へ変換できない値が含まれます', current));
      }
    }
  });
}

function constraintViolation(value: Exclude<Constant, undefined>, constraint: VariableConstraint): string | undefined {
  if (constraint.type === 'int' && typeof value !== 'bigint') return '整数';
  if (constraint.type === 'str' && typeof value !== 'string') return '文字列';
  if (constraint.type === 'float' && typeof value !== 'number') return '小数';
  if (constraint.type === 'float' && constraint.floatValues && typeof value === 'number' && !constraint.floatValues.has(value)) return '許容値集合';
  if (constraint.type === 'float' && typeof value === 'number' && constraint.floatMin !== undefined && value < constraint.floatMin) return `min=${constraint.floatMin}`;
  if (constraint.type === 'float' && typeof value === 'number' && constraint.floatMax !== undefined && value > constraint.floatMax) return `max=${constraint.floatMax}`;
  if (constraint.type !== 'float' && constraint.values && (typeof value === 'string' || typeof value === 'bigint') && !constraint.values.has(value)) return '許容値集合';
  if (typeof value === 'bigint') {
    if (constraint.min !== undefined && value < constraint.min) return `min=${constraint.min}`;
    if (constraint.max !== undefined && value > constraint.max) return `max=${constraint.max}`;
  }
  return undefined;
}

function floatBounds(expr: Expr, constants: ReadonlyMap<string, Exclude<Constant, undefined>>, constraints?: ReadonlyMap<string, VariableConstraint>): { min: number; max: number } | undefined {
  const value = constant(expr, constants);
  if (typeof value === 'number') return { min: value, max: value };
  if (expr.kind === 'variable') {
    const constraint = constraints?.get(expr.name);
    if (constraint?.type !== 'float') return undefined;
    const values = constraint.floatValues ? [...constraint.floatValues] : [];
    const min = constraint.floatMin ?? (values.length ? Math.min(...values) : undefined);
    const max = constraint.floatMax ?? (values.length ? Math.max(...values) : undefined);
    return min !== undefined && max !== undefined ? { min, max } : undefined;
  }
  if (expr.kind === 'call' && expr.name === 'float' && expr.args.length === 1) {
    const argument = expr.args[0];
    const integerRange = integerBounds(argument, constants, constraints);
    if (integerRange) {
      const min = Number(integerRange.min), max = Number(integerRange.max);
      if (Number.isFinite(min) && Number.isFinite(max)) return { min, max };
    }
    if (argument.kind === 'variable') {
      const constraint = constraints?.get(argument.name);
      if (constraint?.type === 'str' && constraint.values?.size) {
        const numericValues = [...constraint.values].map(value => {
          if (typeof value !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) return undefined;
          const converted = Number(value);
          return Number.isFinite(converted) ? converted : undefined;
        });
        if (numericValues.length && numericValues.every((value): value is number => value !== undefined)) {
          return { min: Math.min(...numericValues), max: Math.max(...numericValues) };
        }
      }
    }
    return undefined;
  }
  if (expr.kind === 'unary' && (expr.operator === '+' || expr.operator === '-')) {
    const bounds = floatBounds(expr.value, constants, constraints);
    if (!bounds) return undefined;
    return expr.operator === '+' ? bounds : { min: -bounds.max, max: -bounds.min };
  }
  if (expr.kind !== 'binary' || !['+', '-', '*', '/'].includes(expr.operator)) return undefined;
  const left = floatBounds(expr.left, constants, constraints), right = floatBounds(expr.right, constants, constraints);
  if (!left || !right) return undefined;
  let candidates: number[];
  if (expr.operator === '+') candidates = [left.min + right.min, left.max + right.max];
  else if (expr.operator === '-') candidates = [left.min - right.max, left.max - right.min];
  else if (expr.operator === '*') candidates = [left.min * right.min, left.min * right.max, left.max * right.min, left.max * right.max];
  else {
    if (right.min <= 0 && right.max >= 0) return undefined;
    candidates = [left.min / right.min, left.min / right.max, left.max / right.min, left.max / right.max];
  }
  if (!candidates.every(Number.isFinite)) return undefined;
  return { min: Math.min(...candidates), max: Math.max(...candidates) };
}

function analyzeVariableConstraints(statements: Statement[], file: string, out: Diagnostic[], constraints: ReadonlyMap<string, VariableConstraint>): void {
  for (const statement of statements) {
    if (statement.kind === 'declare' || statement.kind === 'set') {
      const name = statement.kind === 'declare' ? statement.name : statement.target.kind === 'variable' ? statement.target.name : undefined;
      const expression = statement.kind === 'declare' ? statement.initial : statement.value;
      const constraint = name ? constraints.get(name) : undefined;
      const value = expression ? constant(expression) : undefined;
      const reason = constraint && value !== undefined ? constraintViolation(value, constraint) : undefined;
      if (reason) out.push(diagnostic(file, 'variable-constraint', 'error', `変数 '${name}' の値は変数テーブルの制約 (${reason}) を満たしません`, statement, name));
    }
    for (const body of nested(statement)) analyzeVariableConstraints(body, file, out, constraints);
  }
}

interface CharacterPlacementState {
  slots: Map<string, string>;
  presence: Map<string, boolean>;
  presenceDependencies: Map<string, Set<string>>;
}

function characterNameFact(name: string): string { return `character:${name}`; }
function characterExpressionFact(expression: Expr): string { return `expression:${expressionKey(expression)}`; }

function isStableCharacterExpression(expression: Expr): boolean {
  if (expression.kind === 'literal') return typeof expression.value === 'string';
  if (expression.kind === 'variable') return true;
  if (expression.kind === 'binary' && expression.operator === '+') return isStableCharacterExpression(expression.left) && isStableCharacterExpression(expression.right);
  if (expression.kind === 'index') return isStableCharacterExpression(expression.target) && isStableCharacterExpression(expression.key);
  return false;
}

function characterExpressionVariables(expression: Expr, result = new Set<string>()): Set<string> {
  if (expression.kind === 'variable') result.add(expression.name);
  else if (expression.kind === 'binary') {
    characterExpressionVariables(expression.left, result);
    characterExpressionVariables(expression.right, result);
  } else if (expression.kind === 'unary') characterExpressionVariables(expression.value, result);
  else if (expression.kind === 'index') {
    characterExpressionVariables(expression.target, result);
    characterExpressionVariables(expression.key, result);
  } else if (expression.kind === 'call') expression.args.forEach((argument) => characterExpressionVariables(argument, result));
  else if (expression.kind === 'list') expression.items.forEach((item) => characterExpressionVariables(item, result));
  else if (expression.kind === 'dict') expression.entries.forEach((entry) => characterExpressionVariables(entry.value, result));
  return result;
}

function invalidateCharacterExpressionFacts(state: CharacterPlacementState, variables?: ReadonlySet<string>): void {
  for (const [fact, dependencies] of state.presenceDependencies) {
    if (!variables || [...dependencies].some((name) => variables.has(name))) {
      state.presence.delete(fact);
      state.presenceDependencies.delete(fact);
    }
  }
}

function assignedRootVariable(target: Extract<Statement, { kind: 'set' | 'unset' }>['target']): string | undefined {
  let current: Expr = target;
  while (current.kind === 'index') current = current.target;
  return current.kind === 'variable' ? current.name : undefined;
}

function runtimeCharacterQueryKey(expression: Expr): string | undefined {
  if (expression.kind !== 'call' || expression.name !== 'runtime.state.characters.exists' || expression.args.length !== 1) return undefined;
  const target = expression.args[0];
  if (target.kind === 'literal' && typeof target.value === 'string') return characterNameFact(target.value);
  return isStableCharacterExpression(target) ? characterExpressionFact(target) : undefined;
}

function knownCharacterCondition(expression: Expr, state: CharacterPlacementState): boolean | undefined {
  const key = runtimeCharacterQueryKey(expression);
  if (key) return state.presence.get(key);
  if (expression.kind === 'unary' && expression.operator === 'not') {
    const value = knownCharacterCondition(expression.value, state);
    return value === undefined ? undefined : !value;
  }
  if (expression.kind === 'binary' && expression.operator === 'and') {
    const left = knownCharacterCondition(expression.left, state), right = knownCharacterCondition(expression.right, state);
    if (left === false || right === false) return false;
    if (left === true && right === true) return true;
  }
  if (expression.kind === 'binary' && expression.operator === 'or') {
    const left = knownCharacterCondition(expression.left, state), right = knownCharacterCondition(expression.right, state);
    if (left === true || right === true) return true;
    if (left === false && right === false) return false;
  }
  return undefined;
}

function refineCharacterCondition(state: CharacterPlacementState, expression: Expr, truth: boolean): CharacterPlacementState {
  const key = runtimeCharacterQueryKey(expression);
  if (key) {
    state.presence.set(key, truth);
    if (key.startsWith('expression:')) state.presenceDependencies.set(key, characterExpressionVariables(expression.kind === 'call' ? expression.args[0] : expression));
  }
  else if (expression.kind === 'unary' && expression.operator === 'not') refineCharacterCondition(state, expression.value, !truth);
  else if (expression.kind === 'binary' && expression.operator === 'and' && truth) {
    refineCharacterCondition(state, expression.left, true);
    refineCharacterCondition(state, expression.right, true);
  } else if (expression.kind === 'binary' && expression.operator === 'or' && !truth) {
    refineCharacterCondition(state, expression.left, false);
    refineCharacterCondition(state, expression.right, false);
  }
  return state;
}

function functionMayChangeCharacterPresence(name: string, visiting = new Set<string>()): boolean {
  if (isPureBuiltin(name) || isRuntimeStateApi(name)) return false;
  const fn = activeFunctionDefinitions.get(name);
  if (!fn) return true;
  if (visiting.has(name)) return false;
  const next = new Set(visiting); next.add(name);
  const visit = (statements: Statement[]): boolean => statements.some((statement) => {
    if (statement.kind === 'command' && (statement.name === 'show' || statement.name === 'hide')) return true;
    if (statement.kind === 'call' && functionMayChangeCharacterPresence(statement.name, next)) return true;
    if (statementExpressions(statement).some((expression) => [...expressionCalls(expression)].some(call => functionMayChangeCharacterPresence(call, next)))) return true;
    return nested(statement).some(visit);
  });
  return visit(fn.body);
}

function cloneCharacterPlacementState(state: CharacterPlacementState): CharacterPlacementState {
  return {
    slots: new Map(state.slots),
    presence: new Map(state.presence),
    presenceDependencies: new Map([...state.presenceDependencies].map(([fact, names]) => [fact, new Set(names)])),
  };
}

function mergeCharacterPlacementStates(states: CharacterPlacementState[]): CharacterPlacementState {
  const merged = cloneCharacterPlacementState(states[0]);
  for (const [slot, character] of merged.slots) if (states.some((state) => state.slots.get(slot) !== character)) merged.slots.delete(slot);
  for (const [fact, value] of merged.presence) if (states.some((state) => state.presence.get(fact) !== value)) {
    merged.presence.delete(fact);
    merged.presenceDependencies.delete(fact);
  }
  return merged;
}

/**
 * Track only statically known character/position pairs.  The runtime replaces
 * an existing occupant when `show` targets the same position, so this is a
 * warning rather than a type error.  Unknown positions and dynamic commands
 * are deliberately ignored to avoid claiming more certainty than the script
 * provides.
 */
function analyzeCharacterPlacements(statements: Statement[], file: string, out: Diagnostic[], initial: CharacterPlacementState = { slots: new Map(), presence: new Map(), presenceDependencies: new Map() }, emitted = new Set<string>()): CharacterPlacementState[] {
  const analyze = (items: Statement[], incoming: CharacterPlacementState): CharacterPlacementState[] => {
    let states: CharacterPlacementState[] = [cloneCharacterPlacementState(incoming)];
    for (const statement of items) {
      const next: CharacterPlacementState[] = [];
      for (const state of states) {
        const calledFunctions = statementExpressions(statement).flatMap((expression) => [...expressionCalls(expression)]);
        if (statement.kind === 'call') calledFunctions.push(statement.name);
        for (const name of calledFunctions) {
          if (functionMayChangeCharacterPresence(name)) {
            state.slots.clear();
            state.presence.clear();
            state.presenceDependencies.clear();
          } else if (!isNonMutatingBuiltin(name)) {
            const writes = activeFunctionEffects.get(name);
            invalidateCharacterExpressionFacts(state, writes && !writes.has('*') ? writes : undefined);
          }
        }
        if (statement.kind === 'declare') invalidateCharacterExpressionFacts(state, new Set([statement.name]));
        else if (statement.kind === 'set' || statement.kind === 'unset') {
          const root = assignedRootVariable(statement.target);
          if (root) invalidateCharacterExpressionFacts(state, new Set([root]));
        }
        const command = statement.kind === 'command' ? statement : undefined;
        if (command?.name === 'show' && command.args[0]?.kind === 'literal' && typeof command.args[0].value === 'string'
          && command.args[0].value !== 'image' && command.args[1]?.kind === 'literal' && typeof command.args[1].value === 'string') {
          const match = /^([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(command.args[0].value);
          const position = command.args[1].value;
          if (match) {
            const previous = state.slots.get(position);
            const character = match[1];
            const key = `${statement.line ?? 1}:${statement.column ?? 1}:${position}:${character}:${previous ?? ''}`;
            if (previous && previous !== character && !emitted.has(key)) {
              emitted.add(key);
              out.push(diagnostic(file, 'character-slot-conflict', 'warning', `position '${position}' already contains character '${previous}'; showing '${character}' replaces it`, statement));
            }
            invalidateCharacterExpressionFacts(state);
            if (previous && previous !== character) state.presence.set(characterNameFact(previous), false);
            state.slots.set(position, character);
            state.presence.set(characterNameFact(character), true);
          }
        } else if (command?.name === 'hide' && command.args[0]?.kind === 'literal' && typeof command.args[0].value === 'string') {
          const character = command.args[0].value;
          if (![...state.slots.values()].includes(character)) {
            const key = `${statement.line ?? 1}:${statement.column ?? 1}:${character}`;
            if (!emitted.has(key)) {
              emitted.add(key);
              out.push(diagnostic(file, 'hide-unshown-character', 'warning', `character '${character}' is hidden before it is statically shown`, statement));
            }
          }
          invalidateCharacterExpressionFacts(state);
          state.presence.set(characterNameFact(character), false);
          for (const [position, occupant] of state.slots) if (occupant === character) state.slots.delete(position);
        } else if (command?.name === 'move' && command.args[0]?.kind === 'literal' && command.args[0].value === 'character'
          && command.args[1]) {
          const target = command.args[1];
          const character = target.kind === 'literal' && typeof target.value === 'string' ? target.value : undefined;
          const fact = character === undefined ? characterExpressionFact(target) : characterNameFact(character);
          const known = state.presence.get(fact);
          if (known === false || known === undefined && (character === undefined || ![...state.slots.values()].includes(character))) {
            const label = character ?? (target.kind === 'variable' ? target.name : 'dynamic character');
            const key = `${statement.line ?? 1}:${statement.column ?? 1}:${label}`;
            if (!emitted.has(key)) {
              emitted.add(key);
              const message = character === undefined
                ? `dynamic character '${label}' is moved without proof that it is currently visible; guard it with runtime.state.characters.exists(...)`
                : `character '${label}' is moved before it is statically shown`;
              out.push(diagnostic(file, 'move-unshown-character', 'warning', message, statement));
            }
          }
        }

        if (statement.kind === 'if') {
          const branches = [{ expression: statement.condition.expression, body: statement.body }, ...statement.elseIf.map((branch) => ({ expression: branch.condition.expression, body: branch.body }))];
          let remaining: CharacterPlacementState[] = [cloneCharacterPlacementState(state)];
          for (const branch of branches) {
            const unmatched: CharacterPlacementState[] = [];
            for (const candidate of remaining) {
              const value = knownCharacterCondition(branch.expression, candidate);
              if (value !== false) next.push(...analyze(branch.body, refineCharacterCondition(cloneCharacterPlacementState(candidate), branch.expression, true)));
              if (value !== true) unmatched.push(refineCharacterCondition(candidate, branch.expression, false));
            }
            remaining = unmatched;
          }
          if (statement.otherwise.length) for (const candidate of remaining) next.push(...analyze(statement.otherwise, candidate));
          else next.push(...remaining);
        } else if (statement.kind === 'choice') {
          if (!statement.options.length) next.push(state);
          for (const option of statement.options) next.push(...analyze(option.body, cloneCharacterPlacementState(state)));
        } else if (statement.kind === 'while' || statement.kind === 'for' || statement.kind === 'forEach') {
          // A loop may execute zero times. Keep the incoming state and also
          // inspect one body execution for conflicts inside the loop.
          const bodyState = cloneCharacterPlacementState(state);
          if (statement.kind === 'for' || statement.kind === 'forEach') invalidateCharacterExpressionFacts(bodyState, new Set([statement.name]));
          next.push(state, ...analyze(statement.body, bodyState));
        } else if (statement.kind !== 'goto' && statement.kind !== 'return') {
          next.push(state);
        }
      }
      if (!next.length) {
        states = [];
        break;
      }
      states = next;
      // Avoid path explosion while preserving all facts common to the paths.
      const unique = new Map<string, CharacterPlacementState>();
      for (const state of states) {
        const slots = [...state.slots.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([position, character]) => `${position}=${character}`).join('|');
        const presence = [...state.presence.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([fact, value]) => `${fact}=${value}`).join('|');
        const key = `${slots}#${presence}`;
        unique.set(key, state);
      }
      states = [...unique.values()];
      if (states.length > 64) states = [mergeCharacterPlacementStates(states)];
    }
    return states;
  };
  return analyze(statements, initial);
}

/** Track statically known named image layers. `clear image` is a no-op when
 * the layer has not been shown, and separate IDs in one slot remain visible
 * together, so report both definite clears and accidental overlaps. */
function analyzeImageLayers(statements: Statement[], file: string, out: Diagnostic[], initial = new Map<string, string>(), emitted = new Set<string>()): Map<string, string>[] {
  const analyze = (items: Statement[], incoming: Map<string, string>): Map<string, string>[] => {
    let states: Map<string, string>[] = [new Map(incoming)];
    for (const statement of items) {
      const next: Map<string, string>[] = [];
      for (const state of states) {
        const command = statement.kind === 'command' ? statement : undefined;
        if (command?.name === 'show' && command.args[0]?.kind === 'literal' && command.args[0].value === 'image'
          && command.args[1]?.kind === 'literal' && typeof command.args[1].value === 'string'
          && command.args[2]?.kind === 'literal' && typeof command.args[2].value === 'string') {
          const image = command.args[1].value;
          const slot = command.args[2].value;
          const previous = [...state.entries()].find(([, occupiedSlot]) => occupiedSlot === slot && !state.has(image));
          const key = `${statement.line ?? 1}:${statement.column ?? 1}:${slot}:${image}:${previous?.[0] ?? ''}`;
          if (previous && !emitted.has(key)) {
            emitted.add(key);
            out.push(diagnostic(file, 'image-slot-conflict', 'warning', `position '${slot}' already contains image '${previous[0]}'; showing '${image}' overlays it`, statement));
          }
          state.set(image, slot);
        } else if (command?.name === 'clear' && command.args[0]?.kind === 'literal' && command.args[0].value === 'image'
          && command.args[1]?.kind === 'literal' && typeof command.args[1].value === 'string') {
          const image = command.args[1].value;
          const key = `${statement.line ?? 1}:${statement.column ?? 1}:${image}`;
          if (!state.has(image) && !emitted.has(key)) {
            emitted.add(key);
            out.push(diagnostic(file, 'clear-unshown-image', 'warning', `image '${image}' is cleared before it is statically shown`, statement));
          }
          state.delete(image);
        }
        if (statement.kind === 'if') {
          const branchStates: Map<string, string>[] = [];
          branchStates.push(...analyze(statement.body, new Map(state)));
          for (const branch of statement.elseIf) branchStates.push(...analyze(branch.body, new Map(state)));
          if (statement.otherwise.length) branchStates.push(...analyze(statement.otherwise, new Map(state)));
          else branchStates.push(new Map(state));
          next.push(...branchStates);
        } else if (statement.kind === 'choice') {
          if (!statement.options.length) next.push(state);
          for (const option of statement.options) next.push(...analyze(option.body, new Map(state)));
        } else if (statement.kind === 'while' || statement.kind === 'for' || statement.kind === 'forEach') {
          next.push(state, ...analyze(statement.body, new Map(state)));
        } else if (statement.kind !== 'goto' && statement.kind !== 'return') {
          next.push(state);
        }
      }
      if (!next.length) {
        states = [];
        break;
      }
      const unique = new Map<string, Map<string, string>>();
      for (const state of next) unique.set([...state.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([image, slot]) => `${image}=${slot}`).join('|'), state);
      states = [...unique.values()].slice(0, 64);
    }
    return states;
  };
  return analyze(statements, initial);
}

/** Warn when a background or BGM is replaced without an explicit clear. */
function analyzeAssetReplacements(
  statements: Statement[], file: string, out: Diagnostic[], kind: 'bg' | 'bgm', code: string, label: string,
  emitted = new Set<string>(),
): Array<string | undefined> {
  const analyze = (items: Statement[], incoming: string | undefined): Array<string | undefined> => {
    let states: Array<string | undefined> = [incoming];
    for (const statement of items) {
      const next: Array<string | undefined> = [];
      for (const active of states) {
        let current = active;
        const command = statement.kind === 'command' ? statement : undefined;
        const asset = command?.name === kind
          ? command.args[0]
          : command?.name === 'play' && command.args[0]?.kind === 'literal' && command.args[0].value === kind
            ? command.args[1]
            : undefined;
        const assetName = asset?.kind === 'literal' && typeof asset.value === 'string' ? asset.value : undefined;
        if (assetName !== undefined) {
          const fadeDuration = command?.args[3];
          const positiveFadeDuration = fadeDuration?.kind === 'literal'
            && ((typeof fadeDuration.value === 'number' && fadeDuration.value > 0)
              || (typeof fadeDuration.value === 'bigint' && fadeDuration.value > 0n));
          const intentionalBgmCrossfade = kind === 'bgm'
            && command?.name === 'play'
            && command.args[2]?.kind === 'literal'
            && command.args[2].value === 'crossfade'
            && positiveFadeDuration;
          if (current !== undefined && current !== assetName && !intentionalBgmCrossfade) {
            const key = `${statement.line ?? 1}:${statement.column ?? 1}:${kind}:${current}:${assetName}`;
            if (!emitted.has(key)) {
              emitted.add(key);
              out.push(diagnostic(file, code, 'warning', `${label} '${current}' is replaced by '${assetName}' without an explicit clear`, statement));
            }
          }
          current = assetName;
        } else if (kind === 'bg' && command?.name === 'move' && command.args[0]?.kind === 'literal' && command.args[0].value === 'bg' && current === undefined) {
          const key = `${statement.line ?? 1}:${statement.column ?? 1}:bg`;
          if (!emitted.has(key)) {
            emitted.add(key);
            out.push(diagnostic(file, 'move-unset-background', 'warning', 'background is moved before it is statically set', statement));
          }
        } else if (command?.name === 'clear' && command.args[0]?.kind === 'literal' && command.args[0].value === kind) {
          current = undefined;
        }
        if (statement.kind === 'if') {
          next.push(...analyze(statement.body, current));
          for (const branch of statement.elseIf) next.push(...analyze(branch.body, current));
          if (statement.otherwise.length) next.push(...analyze(statement.otherwise, current)); else next.push(current);
        } else if (statement.kind === 'choice') {
          for (const option of statement.options) next.push(...analyze(option.body, current));
        } else if (statement.kind === 'while' || statement.kind === 'for' || statement.kind === 'forEach') {
          next.push(current, ...analyze(statement.body, current));
        } else {
          next.push(current);
        }
      }
      states = next.length ? next.slice(0, 64) : [];
      if (statement.kind === 'goto' || statement.kind === 'return') break;
    }
    return states;
  };
  return analyze(statements, undefined);
}

/** The Browser and Native players expose one video layer. Track that contract
 * statically so an async video replacement is visible while editing. */
function analyzeVideoLayerReplacements(statements: Statement[], file: string, out: Diagnostic[], emitted = new Set<string>()): boolean[] {
  const analyze = (items: Statement[], incoming: boolean): boolean[] => {
    let states = [incoming];
    for (const statement of items) {
      const next: boolean[] = [];
      for (const active of states) {
        let current = active;
        const command = statement.kind === 'command' ? statement : undefined;
        if (command?.name === 'play' && command.args[0]?.kind === 'literal' && command.args[0].value === 'video') {
          const mode = command.args[2]?.kind === 'literal' && typeof command.args[2].value === 'string' ? command.args[2].value : 'async';
          if (current) {
            const key = `${statement.line ?? 1}:${statement.column ?? 1}`;
            if (!emitted.has(key)) {
              emitted.add(key);
              out.push(diagnostic(file, 'video-layer-replaced', 'warning', 'an active async video is replaced because the runtime has one video layer', statement));
            }
          }
          current = mode !== 'blocking';
        }
        if (statement.kind === 'if') {
          const branchStates: boolean[] = [];
          branchStates.push(...analyze(statement.body, current));
          for (const branch of statement.elseIf) branchStates.push(...analyze(branch.body, current));
          if (statement.otherwise.length) branchStates.push(...analyze(statement.otherwise, current));
          else branchStates.push(current);
          next.push(...branchStates);
        } else if (statement.kind === 'choice') {
          if (!statement.options.length) next.push(current);
          for (const option of statement.options) next.push(...analyze(option.body, current));
        } else if (statement.kind === 'while' || statement.kind === 'for' || statement.kind === 'forEach') {
          next.push(current, ...analyze(statement.body, current));
        } else if (statement.kind !== 'goto' && statement.kind !== 'return') {
          next.push(current);
        }
      }
      if (!next.length) {
        states = [];
        break;
      }
      states = [...new Set(next)];
    }
    return states;
  };
  return analyze(statements, false);
}

/** Track whether a BGM layer exists on each static path. A clear at a merge
 * point can be a no-op on only some paths, which is usually an unintended
 * scene-state divergence; an initial clear (all paths false) remains valid. */
function analyzeBgmClearDivergence(statements: Statement[], file: string, out: Diagnostic[], emitted = new Set<string>()): boolean[] {
  const analyze = (items: Statement[], incoming: boolean): boolean[] => {
    let states = [incoming];
    for (const statement of items) {
      const command = statement.kind === 'command' ? statement : undefined;
      if (command?.name === 'clear' && command.args[0]?.kind === 'literal' && command.args[0].value === 'bgm'
        && new Set(states).size > 1) {
        const key = `${statement.line ?? 1}:${statement.column ?? 1}`;
        if (!emitted.has(key)) {
          emitted.add(key);
          out.push(diagnostic(file, 'bgm-clear-path-dependent', 'warning', 'clear bgm is a no-op on some static paths because no BGM is active there', statement));
        }
      }
      const next: boolean[] = [];
      for (const active of states) {
        let current = active;
        if (command?.name === 'bgm' || (command?.name === 'play' && command.args[0]?.kind === 'literal' && command.args[0].value === 'bgm')) current = true;
        else if (command?.name === 'clear' && command.args[0]?.kind === 'literal' && command.args[0].value === 'bgm') current = false;
        if (statement.kind === 'if') {
          const branchStates: boolean[] = [];
          branchStates.push(...analyze(statement.body, current));
          for (const branch of statement.elseIf) branchStates.push(...analyze(branch.body, current));
          if (statement.otherwise.length) branchStates.push(...analyze(statement.otherwise, current));
          else branchStates.push(current);
          next.push(...branchStates);
        } else if (statement.kind === 'choice') {
          if (!statement.options.length) next.push(current);
          for (const option of statement.options) next.push(...analyze(option.body, current));
        } else if (statement.kind === 'while' || statement.kind === 'for' || statement.kind === 'forEach') {
          next.push(current, ...analyze(statement.body, current));
        } else if (statement.kind !== 'goto' && statement.kind !== 'return') {
          next.push(current);
        }
      }
      if (!next.length) {
        states = [];
        break;
      }
      states = [...new Set(next)];
    }
    return states;
  };
  return analyze(statements, false);
}

/** Background is also a single presentation layer. Keep initial clears
 * harmless, but report a clear whose effect depends on the selected path. */
function analyzeBackgroundClearDivergence(statements: Statement[], file: string, out: Diagnostic[], emitted = new Set<string>()): boolean[] {
  const analyze = (items: Statement[], incoming: boolean): boolean[] => {
    let states = [incoming];
    for (const statement of items) {
      const command = statement.kind === 'command' ? statement : undefined;
      if (command?.name === 'clear' && command.args[0]?.kind === 'literal' && command.args[0].value === 'bg'
        && new Set(states).size > 1) {
        const key = `${statement.line ?? 1}:${statement.column ?? 1}`;
        if (!emitted.has(key)) {
          emitted.add(key);
          out.push(diagnostic(file, 'background-clear-path-dependent', 'warning', 'clear bg is a no-op on some static paths because no background is active there', statement));
        }
      }
      const next: boolean[] = [];
      for (const active of states) {
        let current = active;
        if (command?.name === 'bg') current = true;
        else if (command?.name === 'clear' && command.args[0]?.kind === 'literal' && command.args[0].value === 'bg') current = false;
        if (statement.kind === 'if') {
          const branchStates: boolean[] = [];
          branchStates.push(...analyze(statement.body, current));
          for (const branch of statement.elseIf) branchStates.push(...analyze(branch.body, current));
          if (statement.otherwise.length) branchStates.push(...analyze(statement.otherwise, current));
          else branchStates.push(current);
          next.push(...branchStates);
        } else if (statement.kind === 'choice') {
          if (!statement.options.length) next.push(current);
          for (const option of statement.options) next.push(...analyze(option.body, current));
        } else if (statement.kind === 'while' || statement.kind === 'for' || statement.kind === 'forEach') {
          next.push(current, ...analyze(statement.body, current));
        } else if (statement.kind !== 'goto' && statement.kind !== 'return') {
          next.push(current);
        }
      }
      if (!next.length) {
        states = [];
        break;
      }
      states = [...new Set(next)];
    }
    return states;
  };
  return analyze(statements, false);
}

function analyzeBlock(statements: Statement[], file: string, out: Diagnostic[], reachable = true, constants: ReadonlyMap<string, Exclude<Constant, undefined>> = new Map(), facts: ReadonlyMap<string, boolean> = new Map(), constraints?: ReadonlyMap<string, VariableConstraint>): ReadonlyMap<string, VariableConstraint> | undefined {
  let canReach = reachable;
  const known = new Map(constants);
  const knownFacts = new Map(facts);
  const activeConstraints = new Map<string, VariableConstraint>();
  for (const [name, constraint] of constraints || []) {
    activeConstraints.set(name, constraint.flow || constraint.declared ? constraint : { ...constraint, declared: constraint });
  }
  for (const statement of statements) {
    let singleIterationLoopResult: ReadonlyMap<string, VariableConstraint> | undefined;
    if (!canReach) {
      out.push(diagnostic(file, 'unreachable-code', 'warning', 'この文には到達できません', statement));
      for (const body of nested(statement)) analyzeBlock(body, file, out, false, known, knownFacts, activeConstraints);
      continue;
    }
    statementExpressions(statement).forEach((expr) => analyzeExpression(expr, file, out, known));
    statementExpressions(statement).forEach((expr) => analyzeConstrainedConversions(expr, file, out, known, activeConstraints));
    statementExpressions(statement).forEach((expression) => invalidateConstraintCallsInExecution(expression, known, knownFacts, activeConstraints));
    if (statement.kind === 'call') analyzeKnownFunctionCall(statement.name, statement.args, known, activeConstraints, file, out);
    statementExpressions(statement).forEach(expression => visitExpressions(expression, current => {
      if (current.kind === 'call') analyzeKnownFunctionCall(current.name, current.args, known, activeConstraints, file, out);
    }));
    if (statement.kind === 'call') invalidateConstraintCalls([], activeConstraints, [statement.name]);

    if (statement.kind === 'set' && statement.target.kind === 'variable' && constant(statement.value, known) === undefined) {
      const name = statement.target.name, currentConstraint = activeConstraints.get(name);
      const constraint = currentConstraint?.flow ? currentConstraint.declared : currentConstraint;
      if (constraint?.type === 'int') {
        const bounds = integerBounds(statement.value, known, activeConstraints);
        if (bounds && (constraint.min !== undefined || constraint.max !== undefined)) {
          const definitelyOutside = constraint.min !== undefined && bounds.max < constraint.min || constraint.max !== undefined && bounds.min > constraint.max;
          const mayEscape = constraint.min !== undefined && bounds.min < constraint.min || constraint.max !== undefined && bounds.max > constraint.max;
          if (definitelyOutside) out.push(diagnostic(file, 'variable-constraint', 'error', `変数 '${name}' への代入値の範囲が変数テーブルの制約外です`, statement, name));
          else if (mayEscape) out.push(diagnostic(file, 'variable-constraint', 'warning', `変数 '${name}' への代入値が変数テーブルの範囲を外れる可能性があります`, statement, name));
        }
      } else if (constraint?.type === 'float') {
        const bounds = floatBounds(statement.value, known, activeConstraints);
        const values = constraint.floatValues ? [...constraint.floatValues] : [];
        const minimum = constraint.floatMin ?? (values.length ? Math.min(...values) : undefined);
        const maximum = constraint.floatMax ?? (values.length ? Math.max(...values) : undefined);
        if (bounds && (minimum !== undefined || maximum !== undefined || constraint.floatValues !== undefined)) {
          const outsideBounds = minimum !== undefined && bounds.max < minimum || maximum !== undefined && bounds.min > maximum;
          const mayEscapeBounds = minimum !== undefined && bounds.min < minimum || maximum !== undefined && bounds.max > maximum;
          const domainIntersects = !constraint.floatValues || [...constraint.floatValues].some((allowed) => allowed >= bounds.min && allowed <= bounds.max);
          const definitelyOutside = outsideBounds || !!constraint.floatValues && !domainIntersects;
          const mayEscape = mayEscapeBounds || !!constraint.floatValues && !definitelyOutside && (bounds.min !== bounds.max || !constraint.floatValues.has(bounds.min));
          if (definitelyOutside) out.push(diagnostic(file, 'variable-constraint', 'error', `変数 '${name}' への代入値の範囲が変数テーブルの制約外です`, statement, name));
          else if (mayEscape) out.push(diagnostic(file, 'variable-constraint', 'warning', `変数 '${name}' への代入値が変数テーブルの範囲を外れる可能性があります`, statement, name));
        }
      }
    }

    analyzeTimedCommand(statement, known, activeConstraints, file, out);
    analyzePresentationOffsets(statement, known, activeConstraints, file, out);

    if (statement.kind === 'choice') {
      const labels = new Set<string>();
      for (const option of statement.options) {
        const value = constant(option.label, known);
        const key = value !== undefined ? `${typeof value}:${String(value)}` : isPureExpression(option.label) ? expressionKey(option.label) : undefined;
        if (key && labels.has(key)) out.push(diagnostic(file, 'duplicate-choice-label', 'warning', '選択肢のラベルが重複しているため、利用者が区別できません', option.label));
        if (key) labels.add(key);
      }
    }
    if (statement.kind === 'set' && statement.target.kind === 'variable' && statement.value.kind === 'variable' && statement.target.name === statement.value.name) {
      out.push(diagnostic(file, 'self-assignment', 'warning', `変数 '${statement.target.name}' を同じ値で上書きしています`, statement));
    }
    if (statement.kind === 'if') {
      const finiteCoverage = finiteBranchCoverage(statement, activeConstraints);
      const rangeCoverage = integerRangeCoverage(statement, activeConstraints);
      const incompleteFinite = finiteCoverage && !statement.otherwise.length && [...finiteCoverage.allowed].some((value) => !finiteCoverage.covered.has(value));
      const incompleteRange = !finiteCoverage && rangeCoverage && !statement.otherwise.length && !rangeCoverage.exhaustive;
      if (incompleteFinite || incompleteRange) {
        const name = finiteCoverage?.name || rangeCoverage?.name || '変数';
        out.push(diagnostic(file, 'non-exhaustive-condition', 'warning', `変数 '${name}' の取り得る値をすべて処理していないため、未処理の値が残ります`, statement.condition));
      }
      const branches = [{ expression: statement.condition.expression, body: statement.body }, ...statement.elseIf.map((branch) => ({ expression: branch.condition.expression, body: branch.body }))];
      const seen = new Set<string>(), previousConditions: Expr[] = [], remainingFacts = new Map(knownFacts);
      let remainingConstraints: ReadonlyMap<string, VariableConstraint> | undefined = activeConstraints;
      const branchConstraintPaths: Array<ReadonlyMap<string, VariableConstraint> | undefined> = [];
      let previousAlways = false;
      for (const branch of branches) {
        const key = expressionKey(branch.expression);
        const value = conditionValue(branch.expression, known, remainingFacts, remainingConstraints);
        const exactDuplicate = isPureExpression(branch.expression) && seen.has(key);
        const subsumed = isPureExpression(branch.expression) && previousConditions.some((previous) => conditionImplies(branch.expression, previous, known));
        const duplicate = exactDuplicate || subsumed;
        if (exactDuplicate) out.push(diagnostic(file, 'duplicate-condition', 'warning', '前の分岐と同じ条件なので、この分岐には到達できません', branch.expression));
        else if (subsumed) out.push(diagnostic(file, 'unreachable-branch', 'warning', '前の分岐条件に含まれるため、この分岐には到達できません', branch.expression));
        if (previousAlways) out.push(diagnostic(file, 'unreachable-branch', 'warning', '前の条件が常に真なので、この分岐には到達できません', branch.expression));
        else if (value === false) out.push(diagnostic(file, 'constant-condition', 'warning', '条件は常に偽です。この分岐には到達できません', branch.expression));
        else if (value === true) out.push(diagnostic(file, 'constant-condition', 'info', '条件は常に真です。後続の分岐は実行されません', branch.expression));
        const bodyFacts = new Map(remainingFacts); recordCondition(bodyFacts, branch.expression, true);
        const branchConstraints = refineConstraints(remainingConstraints, branch.expression, true) || remainingConstraints;
        // Branch bodies execute on separate paths.  Do not let a constant
        // learned in one branch leak into a sibling elif/else condition.
        const branchResult = analyzeBlock(branch.body, file, out, canReach && !previousAlways && value !== false && !duplicate, new Map(known), bodyFacts, branchConstraints);
        if (!previousAlways && value !== false && !duplicate) branchConstraintPaths.push(branchResult || branchConstraints);
        if (isPureExpression(branch.expression)) seen.add(key);
        if (isPureExpression(branch.expression)) previousConditions.push(branch.expression);
        recordCondition(remainingFacts, branch.expression, false);
        remainingConstraints = refineConstraints(remainingConstraints, branch.expression, false);
        if (value === true) previousAlways = true;
      }
      const otherwiseResult = statement.otherwise.length
        ? analyzeBlock(statement.otherwise, file, out, canReach && !previousAlways, new Map(known), remainingFacts, remainingConstraints)
        : remainingConstraints;
      if (!previousAlways) branchConstraintPaths.push(otherwiseResult || remainingConstraints);
      const mergedConstraints = mergeConstraints(branchConstraintPaths);
      if (activeConstraints && mergedConstraints) {
        const entries = [...mergedConstraints.entries()];
        activeConstraints.clear();
        entries.forEach(([name, constraint]) => activeConstraints.set(name, constraint));
      }
      if (previousAlways && statement.otherwise.length) out.push(diagnostic(file, 'unreachable-branch', 'warning', '前の条件が常に真なので、else には到達できません', statement.otherwise[0]));
    } else if (statement.kind === 'choice') {
      // Each choice option is a separate runtime path.  Keep option-local
      // constants, facts, and constraints isolated from sibling options.
      const choiceConstraintPaths: Array<ReadonlyMap<string, VariableConstraint> | undefined> = [];
      for (const option of statement.options) {
        const optionResult = analyzeBlock(
          option.body,
          file,
          out,
          canReach,
          new Map(known),
          new Map(knownFacts),
          activeConstraints ? new Map(activeConstraints) : undefined,
        );
        choiceConstraintPaths.push(optionResult);
      }
      const mergedChoiceConstraints = mergeConstraints(choiceConstraintPaths);
      if (mergedChoiceConstraints) {
        activeConstraints.clear();
        mergedChoiceConstraints.forEach((constraint, name) => activeConstraints.set(name, constraint));
      }
    } else if (statement.kind === 'while') {
      const value = conditionValue(statement.condition.expression, known, knownFacts, activeConstraints);
      if (value === false) out.push(diagnostic(file, 'constant-condition', 'warning', 'while の条件は常に偽です。ループ本体には到達できません', statement.condition));
      const stable = loopConstants(statement, known);
      const stableConstraints = new Map(activeConstraints);
      invalidateConstraintState(statement, stableConstraints);
      const bodyFacts = new Map<string, boolean>(); recordCondition(bodyFacts, statement.condition.expression, true);
      const stableCondition = conditionValue(statement.condition.expression, stable, new Map(), stableConstraints);
      if (stableCondition === true && !blockTerminates(statement.body, stable, bodyFacts, stableConstraints)) out.push(diagnostic(file, 'infinite-loop', 'warning', 'while の条件は常に真で、ループ本体は後続へ進みません', statement.condition));
      if (whileUpdateOverflows(statement, known)) {
        out.push(diagnostic(file, 'integer-overflow', 'error', 'while ループの更新で64bit整数オーバーフローが発生します', statement.body[0]));
      }
      const iterations = whileIterationCount(statement, known);
      const iterationUpperBound = iterations === undefined ? whileIterationUpperBound(statement, known, activeConstraints) : undefined;
      if (iterations === 'non-terminating' || (typeof iterations === 'bigint' && iterations > 100000n) || iterationUpperBound === 'non-terminating' || (typeof iterationUpperBound === 'bigint' && iterationUpperBound > 100000n)) {
        out.push(diagnostic(file, 'loop-limit', 'warning', 'この while ループは実行時の最大反復回数 100,000 回を超過します', statement));
      }
      // A while body may execute zero times, so body-local narrowing must not
      // leak into the post-loop path.
      analyzeBlock(statement.body, file, out, canReach && value !== false, stable, bodyFacts, activeConstraints ? new Map(activeConstraints) : undefined);
      if (canReach && stableCondition === true && !blockTerminates(statement.body, stable, bodyFacts, stableConstraints)) canReach = false;
    } else if (statement.kind === 'for') {
      const execution = forExecution(statement, known);
      if (execution === 'invalid') {
        out.push(diagnostic(file, 'invalid-for-step', 'error', 'この for ループの step では開始値から終了値へ進めません', statement));
      }
      const iterations = forIterationCount(statement, known);
      const iterationUpperBound = forIterationUpperBound(statement, known, activeConstraints);
      if ((iterations !== undefined && iterations > 100000n) || (iterations === undefined && iterationUpperBound !== undefined && iterationUpperBound > 100000n)) {
        out.push(diagnostic(file, 'loop-limit', 'warning', 'この for ループは実行時の最大反復回数 100,000 回を超過します', statement));
      }
      if (forFirstIterationOverflows(statement, known) || forRepeatedUpdateOverflows(statement, known)) {
        out.push(diagnostic(file, 'integer-overflow', 'error', 'for ループの更新で64bit整数オーバーフローが発生します', statement.body[0]));
      }
      const constrainedOverflow = forConstraintUpdateOverflow(statement, known, activeConstraints);
      if (constrainedOverflow) {
        out.push(diagnostic(file, 'integer-overflow', constrainedOverflow, constrainedOverflow === 'error'
          ? 'for ループの値域付き更新で64bit整数オーバーフローが発生します'
          : 'for ループの値域付き更新で64bit整数オーバーフローの可能性があります', statement.body[0]));
      }
      const loopInputConstraints = forBodyConstraints(statement, known, activeConstraints);
      const loopResultConstraints = analyzeBlock(statement.body, file, out, canReach && execution !== 'invalid', loopConstants(statement, known), new Map(), loopInputConstraints);
      // A statically known single-iteration for loop is an unconditional
      // execution path. Preserve its effects after the loop, while keeping the
      // loop index and body-local declarations scoped to the body.
      if (canReach && execution !== 'invalid' && iterations === 1n) singleIterationLoopResult = loopResultConstraints;
    } else {
      for (const body of nested(statement)) analyzeBlock(body, file, out, canReach, known, knownFacts, activeConstraints);
    }
    if (canReach && definitelyTerminates(statement, known, knownFacts, activeConstraints)) canReach = false;
    const assignedFact = assignedIntegerFact(statement, known, activeConstraints);
    const assignedFloat = assignedFloatFact(statement, known, activeConstraints);
    const assignedString = assignedStringFact(statement, known, activeConstraints);
    if (statement.kind !== 'if' && statement.kind !== 'choice') {
      invalidateConstraintState(statement, activeConstraints);
      if (statement.kind === 'for' && singleIterationLoopResult) {
        const assignedInBody = writtenVariables(statement);
        const declaredInBody = new Set<string>();
        const collectDeclarations = (items: Statement[]) => items.forEach((item) => {
          if (item.kind === 'declare') declaredInBody.add(item.name);
          nested(item).forEach(collectDeclarations);
        });
        collectDeclarations(statement.body);
        for (const [name, result] of singleIterationLoopResult) {
          if (name !== statement.name && assignedInBody.has(name) && !declaredInBody.has(name)) activeConstraints.set(name, result);
        }
      }
      if (assignedFact) {
        const previous = activeConstraints.get(assignedFact.name);
        const declared = previous?.flow ? previous.declared : previous?.declared || previous;
        activeConstraints.set(assignedFact.name, {
          type: 'int', min: assignedFact.bounds.min, max: assignedFact.bounds.max, flow: true,
          ...(assignedFact.values ? { values: assignedFact.values } : {}),
          ...(declared ? { declared } : {}),
        });
      }
      if (assignedFloat) {
        const previous = activeConstraints.get(assignedFloat.name);
        const declared = previous?.flow ? previous.declared : previous?.declared || previous;
        activeConstraints.set(assignedFloat.name, {
          type: 'float', floatMin: assignedFloat.bounds.min, floatMax: assignedFloat.bounds.max, flow: true,
          ...(assignedFloat.values ? { floatValues: assignedFloat.values } : {}),
          ...(declared ? { declared } : {}),
        });
      }
      if (assignedString) {
        const previous = activeConstraints.get(assignedString.name);
        const declared = previous?.flow ? previous.declared : previous?.declared || previous;
        activeConstraints.set(assignedString.name, {
          type: 'str', values: assignedString.values, flow: true,
          ...(declared ? { declared } : {}),
        });
      }
    }
    if (statement.kind === 'if' || statement.kind === 'choice') {
      const flow = reachableTransfers([statement], known, knownFacts, activeConstraints);
      known.clear();
      flow.fallthrough?.forEach((value, name) => known.set(name, value));
    } else {
      updateKnownConstants(statement, known);
    }
    if (invalidatesConditionFacts(statement)) knownFacts.clear();
  }
  return activeConstraints;
}

function analyzeUnused(fn: FunctionDef, file: string, out: Diagnostic[]): void {
  const declared = new Map<string, NodeLocation>();
  const used = new Set<string>();
  fn.params.forEach((param) => declared.set(param.name, fn));
  const walk = (statements: Statement[]): void => {
    for (const statement of statements) {
      if (statement.kind === 'declare') declared.set(statement.name, statement);
      for (const expr of statementExpressions(statement)) visitExpressions(expr, (current) => {
        if (current.kind === 'variable' && !(statement.kind === 'set' && statement.target === current)) used.add(current.name);
        if (current.kind === 'literal' && typeof current.value === 'string') {
          for (const match of current.value.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\}/g)) used.add(match[1].split('.')[0]);
        }
      });
      nested(statement).forEach(walk);
    }
  };
  walk(fn.body);
  for (const [name, loc] of declared) if (!used.has(name)) out.push(diagnostic(file, 'unused-variable', 'warning', `変数または引数 '${name}' は使用されていません`, loc));
}

export function analyzeScript(script: Script, file = 'current', externalGlobals = new Map<string, ValueType>(), externalCharacters = new Map<string, Set<string> | ExternalCharacter>()): Diagnostic[] {
  const out: Diagnostic[] = [];
  const constants = new Map<string, Exclude<Constant, undefined>>();
  for (const statement of script.globals) {
    if (statement.kind !== 'declare' || !statement.constant || !statement.initial) continue;
    const value = constant(statement.initial, constants);
    if (value !== undefined) constants.set(statement.name, value);
  }
  try {
    const typeErrors: TypeCheckError[] = [];
    checkTypes(script, file, externalGlobals, externalCharacters, typeErrors);
    typeErrors.forEach((error) => out.push(errorDiagnostic(error, file)));
  } catch (error) {
    out.push(errorDiagnostic(error, file));
  }
  const constraints = (externalGlobals as Map<string, ValueType> & { constraints?: ReadonlyMap<string, VariableConstraint> }).constraints;
  const globalNames = new Set<string>([...externalGlobals.keys(), ...externalCharacters.keys(), ...script.globals.filter((statement) => statement.kind === 'declare').map((statement) => statement.name)]);
  activeFunctionEffects = functionEffects(script.functions, globalNames);
  activeFunctionDefinitions = new Map(script.functions.map(fn => [fn.name, fn]));
  activeGlobalNames = globalNames;
  activeFunctionCallStack.clear();
  if (constraints) {
    analyzeVariableConstraints(script.globals, file, out, constraints);
    script.functions.forEach((fn) => {
      const scopedConstraints = new Map(constraints);
      fn.params.forEach(param => scopedConstraints.delete(param.name));
      analyzeVariableConstraints(fn.body, file, out, scopedConstraints);
    });
    script.scenes.forEach((scene) => analyzeVariableConstraints(scene.body, file, out, constraints));
  }
  analyzeCharacterPlacements(script.globals, file, out);
  script.functions.forEach((fn) => analyzeCharacterPlacements(fn.body, file, out));
  script.scenes.forEach((scene) => analyzeCharacterPlacements(scene.body, file, out));
  analyzeImageLayers(script.globals, file, out);
  script.functions.forEach((fn) => analyzeImageLayers(fn.body, file, out));
  script.scenes.forEach((scene) => analyzeImageLayers(scene.body, file, out));
  analyzeVideoLayerReplacements(script.globals, file, out);
  script.functions.forEach((fn) => analyzeVideoLayerReplacements(fn.body, file, out));
  script.scenes.forEach((scene) => analyzeVideoLayerReplacements(scene.body, file, out));
    analyzeAssetReplacements(script.globals, file, out, 'bg', 'background-replacement', 'background');
    analyzeAssetReplacements(script.globals, file, out, 'bgm', 'bgm-replacement', 'BGM');
    script.functions.forEach((fn) => {
      analyzeAssetReplacements(fn.body, file, out, 'bg', 'background-replacement', 'background');
      analyzeAssetReplacements(fn.body, file, out, 'bgm', 'bgm-replacement', 'BGM');
    });
    script.scenes.forEach((scene) => {
      analyzeAssetReplacements(scene.body, file, out, 'bg', 'background-replacement', 'background');
      analyzeAssetReplacements(scene.body, file, out, 'bgm', 'bgm-replacement', 'BGM');
    });
  analyzeBgmClearDivergence(script.globals, file, out);
  script.functions.forEach((fn) => analyzeBgmClearDivergence(fn.body, file, out));
  script.scenes.forEach((scene) => analyzeBgmClearDivergence(scene.body, file, out));
  analyzeBackgroundClearDivergence(script.globals, file, out);
  script.functions.forEach((fn) => analyzeBackgroundClearDivergence(fn.body, file, out));
  script.scenes.forEach((scene) => analyzeBackgroundClearDivergence(scene.body, file, out));
  analyzeBlock(script.globals, file, out, true, constants, new Map(), constraints);
  for (const fn of script.functions) {
    const functionConstants = new Map(constants);
    fn.params.forEach((param) => functionConstants.delete(param.name));
    const functionConstraints = constraints ? new Map(constraints) : undefined;
    fn.params.forEach(param => functionConstraints?.delete(param.name));
    analyzeBlock(fn.body, file, out, true, functionConstants, new Map(), functionConstraints);
    analyzeUnused(fn, file, out);
    if (fn.returnType !== 'none' && !blockTerminates(fn.body, functionConstants, new Map(), functionConstraints)) {
      out.push(diagnostic(file, 'missing-return', 'error', `関数 '${fn.name}' はすべての経路で値を返していません`, fn));
    }
  }
  const { reachableScenes } = sceneReachability(script, constraints, new Set([...externalGlobals.keys(), ...externalCharacters.keys()]));
  script.scenes.forEach((scene) => {
    const reachable = reachableScenes.has(scene.name);
    if (!reachable) out.push(diagnostic(file, 'unreachable-scene', 'warning', `シーン '${scene.name}' には到達できません`, scene));
    // The scene-level warning already explains that this whole body cannot run.
    // Continue local analysis as reachable so we still report internal control-flow
    // mistakes without emitting a cascade of unreachable-code warnings per line.
    analyzeBlock(scene.body, file, out, true, constants, new Map(), constraints);
  });
  return out.sort((a, b) => Number(a.file !== file) - Number(b.file !== file)
    || a.line - b.line || a.column - b.column
    || ({ error: 0, warning: 1, info: 2 }[a.severity] - { error: 0, warning: 1, info: 2 }[b.severity]));
}

export function assertAnalyzed(script: Script, file = 'current', externalGlobals = new Map<string, ValueType>(), externalCharacters = new Map<string, Set<string> | ExternalCharacter>()): Diagnostic[] {
  const diagnostics = analyzeScript(script, file, externalGlobals, externalCharacters);
  const first = diagnostics.find((item) => item.severity === 'error');
  if (first) throw new Error(`line ${first.line}, column ${first.column}: ${first.message}`);
  return diagnostics;
}
