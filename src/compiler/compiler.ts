import { Asset, Character, Expr, ExternalCharacter, FunctionDef, Script, Statement, ValueType } from '../parser';
import { assertAnalyzed } from '../checker/analyzer';
import { inferValueType } from '../checker/type-checker';
import { isPureBuiltin } from '../language/builtins';

export type CompiledExpr =
  | { kind: 'integer'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'literal'; value: number | string | bigint | boolean }
  | { kind: 'load'; name: string }
  | { kind: 'index'; target: CompiledExpr; key: CompiledExpr }
  | { kind: 'binary'; operator: string; left: CompiledExpr; right: CompiledExpr }
  | { kind: 'unary'; operator: string; value: CompiledExpr }
  | { kind: 'call'; name: string; args: CompiledExpr[] }
  | { kind: 'dict'; entries: Array<{ key: string; value: CompiledExpr }> }
  | { kind: 'list'; items: CompiledExpr[] };

export type Instruction = (
  | { op: 'declare'; type: ValueType; name: string; initial?: CompiledExpr; constant?: boolean }
  | { op: 'set'; target: CompiledExpr; value: CompiledExpr }
  | { op: 'unset'; target: CompiledExpr }
  | { op: 'command'; name: string; args: CompiledExpr[] }
  | { op: 'if'; condition: CompiledExpr; body: Instruction[]; elseIf: Array<{ condition: CompiledExpr; body: Instruction[] }>; otherwise: Instruction[] }
  | { op: 'for'; name: string; start: CompiledExpr; stop: CompiledExpr; step: CompiledExpr; body: Instruction[] }
  | { op: 'forEach'; name: string; iterable: CompiledExpr; body: Instruction[] }
  | { op: 'while'; condition: CompiledExpr; body: Instruction[] }
  | { op: 'choice'; prompt?: CompiledExpr; options: Array<{ label: CompiledExpr; body: Instruction[] }> }
  | { op: 'function'; name: string; returnType: ValueType; params: Array<{ type: ValueType; name: string }>; body: Instruction[] }
  | { op: 'call'; name: string; args: CompiledExpr[] }
  | { op: 'return'; value?: CompiledExpr }
  | { op: 'goto'; scene: string }
) & { file?: string; line?: number };

export interface CompiledCondition { expression: CompiledExpr; }
export interface CompiledScene { name: string; file?: string; line?: number; instructions: Instruction[]; }
export interface VariableLocation { file?: string; line?: number; column?: number; scope: 'global' | 'function' | 'scene' | 'local'; container: string; kind?: 'definition' | 'expression' | 'interpolation' | 'assignment'; }
export interface VariableEntry { name: string; type: ValueType; scope: 'global' | 'function' | 'scene' | 'local'; definedIn: string; definitions: VariableLocation[]; references: VariableLocation[]; mutable: boolean; }
export type CompiledCharacter = Omit<Character, 'properties'> & { external?: boolean };
export interface CompiledProgram { version: 2; assets: Asset[]; characters: CompiledCharacter[]; globals: Instruction[]; functions: Instruction[]; scenes: CompiledScene[]; variables: VariableEntry[]; }
export class CompileError extends Error {}

type ConstantValue = bigint | number | string | boolean;
type VariableConstraint = { type: 'int' | 'float' | 'str'; min?: bigint; max?: bigint; floatMin?: number; floatMax?: number; floatValues?: ReadonlySet<number>; values?: ReadonlySet<bigint | string> };

function interpolationCalls(value: string): string[] {
  return [...value.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\(\)\}/g)].map((match) => match[1]);
}

function hasInterpolation(value: string): boolean {
  return /\{[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*(?:\(\))?\}/.test(value);
}

function metadataConstant(expression: Expr): bigint | string | boolean | undefined {
  if (expression.kind === 'literal') {
    if (typeof expression.value === 'bigint' || typeof expression.value === 'string' || typeof expression.value === 'boolean') return expression.value;
    if (typeof expression.value === 'number' && Number.isSafeInteger(expression.value)) return BigInt(expression.value);
    return undefined;
  }
  if (expression.kind === 'unary') {
    const value = metadataConstant(expression.value);
    if (expression.operator === 'not' && typeof value === 'boolean') return !value;
    if (typeof value === 'bigint' && expression.operator === '-') return -value;
    if (typeof value === 'bigint' && expression.operator === '+') return value;
    return undefined;
  }
  if (expression.kind === 'call') {
    const argument = expression.args.length === 1 ? metadataConstant(expression.args[0]) : undefined;
    if (expression.name === 'str' && typeof argument === 'bigint') return String(argument);
    if (expression.name === 'int' && typeof argument === 'string' && /^[+-]?\d+$/.test(argument)) {
      try { return BigInt(argument); } catch { return undefined; }
    }
    return undefined;
  }
  if (expression.kind !== 'binary') return undefined;
  const left = metadataConstant(expression.left);
  if (expression.operator === 'and' && typeof left === 'boolean') return left ? metadataConstant(expression.right) : false;
  if (expression.operator === 'or' && typeof left === 'boolean') return left ? true : metadataConstant(expression.right);
  const right = metadataConstant(expression.right);
  if (left === undefined || right === undefined) return undefined;
  if (expression.operator === '==') return left === right;
  if (expression.operator === '!=') return left !== right;
  if (typeof left === 'bigint' && typeof right === 'bigint') {
    if (expression.operator === '>') return left > right;
    if (expression.operator === '>=') return left >= right;
    if (expression.operator === '<') return left < right;
    if (expression.operator === '<=') return left <= right;
    if (expression.operator === '+') return left + right;
    if (expression.operator === '-') return left - right;
    if (expression.operator === '*') return left * right;
    if (expression.operator === '/' && right !== 0n) return left / right;
    if (expression.operator === '%' && right !== 0n) return left % right;
  }
  if (expression.operator === '+' && typeof left === 'string' && typeof right === 'string') return left + right;
  return undefined;
}

function metadataForRuns(statement: Extract<Statement, { kind: 'for' }>): boolean {
  const start = metadataConstant(statement.start);
  const stop = metadataConstant(statement.stop);
  const step = metadataConstant(statement.step);
  if (typeof start !== 'bigint' || typeof stop !== 'bigint' || typeof step !== 'bigint' || step === 0n) return false;
  return !((start < stop && step < 0n) || (start > stop && step > 0n));
}

function sourceBlockExits(statements: Statement[]): boolean {
  return statements.some((statement) => {
    if (statement.kind === 'return' || statement.kind === 'goto') return true;
    if (statement.kind === 'if') {
      return statement.otherwise.length > 0
        && sourceBlockExits(statement.body)
        && statement.elseIf.every((branch) => sourceBlockExits(branch.body))
        && sourceBlockExits(statement.otherwise);
    }
    if (statement.kind === 'for') return metadataForRuns(statement) && sourceBlockExits(statement.body);
    if (statement.kind === 'while') return metadataConstant(statement.condition.expression) === true && sourceBlockExits(statement.body);
    if (statement.kind === 'choice') return statement.options.length > 0 && statement.options.every((option) => sourceBlockExits(option.body));
    return false;
  });
}

function constantValue(expression: CompiledExpr | undefined, constants: Map<string, ConstantValue>): ConstantValue | undefined {
  if (!expression) return undefined;
  if (expression.kind === 'integer') return BigInt(expression.value);
  if (expression.kind === 'float') {
    const value = Number(expression.value);
    return Number.isFinite(value) ? value : undefined;
  }
  if (expression.kind === 'literal') {
    if (typeof expression.value === 'bigint' || typeof expression.value === 'string' || typeof expression.value === 'boolean') return expression.value;
    if (typeof expression.value === 'number' && Number.isInteger(expression.value)) return BigInt(expression.value);
    return undefined;
  }
  if (expression.kind === 'load') return constants.get(expression.name);
  if (expression.kind === 'unary') {
    const value = constantValue(expression.value, constants);
    if (expression.operator === 'not' && typeof value === 'boolean') return !value;
    if (typeof value === 'bigint' && expression.operator === '-') return -value;
    if (typeof value === 'bigint' && expression.operator === '+') return value;
    if (typeof value === 'number' && expression.operator === '-') return -value;
    if (typeof value === 'number' && expression.operator === '+') return value;
    return undefined;
  }
  if (expression.kind === 'call') {
    const argument = expression.args.length === 1 ? constantValue(expression.args[0], constants) : undefined;
    if (expression.name === 'str' && typeof argument === 'bigint') return String(argument);
    if (expression.name === 'int' && typeof argument === 'string' && /^[+-]?\d+$/.test(argument)) {
      const value = BigInt(argument);
      return value >= -(1n << 63n) && value <= (1n << 63n) - 1n ? value : undefined;
    }
    if (expression.name === 'int' && typeof argument === 'number' && Number.isFinite(argument)) {
      const value = BigInt(Math.trunc(argument));
      return value >= -(1n << 63n) && value <= (1n << 63n) - 1n ? value : undefined;
    }
    if (expression.name === 'float') {
      const value = typeof argument === 'bigint' || typeof argument === 'number' || typeof argument === 'string' ? Number(argument) : NaN;
      return Number.isFinite(value) ? value : undefined;
    }
    return undefined;
  }
  if (expression.kind !== 'binary') return undefined;
  const left = constantValue(expression.left, constants);
  if (expression.operator === 'and' && typeof left === 'boolean') return left ? constantValue(expression.right, constants) : false;
  if (expression.operator === 'or' && typeof left === 'boolean') return left ? true : constantValue(expression.right, constants);
  const right = constantValue(expression.right, constants);
  if (left === undefined || right === undefined) return undefined;
  if (expression.operator === '==') return left === right;
  if (expression.operator === '!=') return left !== right;
  if (typeof left === 'bigint' && typeof right === 'bigint') {
    if (expression.operator === '>') return left > right;
    if (expression.operator === '>=') return left >= right;
    if (expression.operator === '<') return left < right;
    if (expression.operator === '<=') return left <= right;
    if (expression.operator === '+') return left + right;
    if (expression.operator === '-') return left - right;
    if (expression.operator === '*') return left * right;
    if (expression.operator === '/' && right !== 0n) return left / right;
    if (expression.operator === '%' && right !== 0n) return left % right;
  }
  if (typeof left === 'number' && typeof right === 'number') {
    if (expression.operator === '>') return left > right;
    if (expression.operator === '>=') return left >= right;
    if (expression.operator === '<') return left < right;
    if (expression.operator === '<=') return left <= right;
    const value = expression.operator === '+' ? left + right : expression.operator === '-' ? left - right
      : expression.operator === '*' ? left * right : expression.operator === '/' && right !== 0 ? left / right : undefined;
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  }
  if (expression.operator === '+' && typeof left === 'string' && typeof right === 'string') return left + right;
  return undefined;
}

function constrainedCondition(expression: CompiledExpr | undefined, constraints?: ReadonlyMap<string, VariableConstraint>, locals?: Set<string>): boolean | undefined {
  if (!expression || !constraints) return undefined;
  if (expression.kind === 'unary' && expression.operator === 'not') {
    const value = constrainedCondition(expression.value, constraints, locals);
    return value === undefined ? undefined : !value;
  }
  if (expression.kind === 'binary' && (expression.operator === 'and' || expression.operator === 'or')) {
    const combined = combinedCompiledIntegerCondition(expression, constraints, locals);
    if (combined !== undefined) return combined;
    const finite = combinedCompiledFiniteCondition(expression, constraints, locals);
    if (finite !== undefined) return finite;
    const left = constrainedCondition(expression.left, constraints, locals);
    const right = constrainedCondition(expression.right, constraints, locals);
    if (expression.operator === 'and') return left === false || right === false ? false : left === true && right === true ? true : undefined;
    return left === true || right === true ? true : left === false && right === false ? false : undefined;
  }
  if (expression.kind !== 'binary' || !['==', '!=', '>', '>=', '<', '<='].includes(expression.operator)) return undefined;
  const floatLiteral = (value: CompiledExpr): number | undefined => value.kind === 'float' && Number.isFinite(Number(value.value)) ? Number(value.value) : undefined;
  let floatName: string | undefined;
  let floatExpected: number | undefined;
  let floatOperator = expression.operator;
  if (expression.left.kind === 'load') { floatName = expression.left.name; floatExpected = floatLiteral(expression.right); }
  else if (expression.right.kind === 'load') {
    floatName = expression.right.name; floatExpected = floatLiteral(expression.left);
    const flipped: Record<string, string> = { '==': '==', '!=': '!=', '>': '<', '>=': '<=', '<': '>', '<=': '>=' };
    floatOperator = flipped[floatOperator];
  }
  if (floatName && !locals?.has(floatName) && floatExpected !== undefined) {
    const floating = constraints.get(floatName);
    if (floating?.type === 'float') {
      const accepts = (value: number): boolean => floatOperator === '==' ? value === floatExpected : floatOperator === '!=' ? value !== floatExpected : floatOperator === '>' ? value > floatExpected! : floatOperator === '>=' ? value >= floatExpected! : floatOperator === '<' ? value < floatExpected! : value <= floatExpected!;
      if (floating.floatValues) {
        const results = [...floating.floatValues].map(accepts);
        if (results.length) return results.every(Boolean) ? true : results.every((value) => !value) ? false : undefined;
      }
      if (floating.floatMin !== undefined && floating.floatMax !== undefined) {
        const minResult = accepts(floating.floatMin), maxResult = accepts(floating.floatMax);
        if (floatOperator === '==' || floatOperator === '!=') {
          if (floatExpected < floating.floatMin || floatExpected > floating.floatMax) return floatOperator === '!=';
          if (floating.floatMin === floating.floatMax) return minResult;
        } else if (minResult && maxResult) return true;
        else if (!minResult && !maxResult && ((floatOperator === '>' && floating.floatMax <= floatExpected) || (floatOperator === '>=' && floating.floatMax < floatExpected) || (floatOperator === '<' && floating.floatMin >= floatExpected) || (floatOperator === '<=' && floating.floatMin > floatExpected))) return false;
      }
    }
  }
  let name: string | undefined;
  let expected: bigint | string | undefined;
  let operator = expression.operator;
  const literal = (value: CompiledExpr | undefined): bigint | string | undefined => {
    if (value?.kind === 'integer') return BigInt(value.value);
    if (value?.kind === 'literal' && (typeof value.value === 'bigint' || typeof value.value === 'string')) return value.value;
    return undefined;
  };
  if (expression.left.kind === 'load') { name = expression.left.name; expected = literal(expression.right); }
  else if (expression.right.kind === 'load') {
    name = expression.right.name; expected = literal(expression.left);
    const flipped: Record<string, string> = { '==': '==', '!=': '!=', '>': '<', '>=': '<=', '<': '>', '<=': '>=' };
    operator = flipped[operator];
  }
  if (!name || locals?.has(name) || expected === undefined) return undefined;
  const constraint = constraints.get(name);
  if (!constraint || constraint.type === 'int' && typeof expected !== 'bigint' || constraint.type === 'str' && typeof expected !== 'string') return undefined;
  const accepts = (value: bigint | string): boolean => {
    if (operator === '==') return value === expected;
    if (operator === '!=') return value !== expected;
    if (typeof value !== 'bigint' || typeof expected !== 'bigint') return false;
    if (operator === '>') return value > expected;
    if (operator === '>=') return value >= expected;
    if (operator === '<') return value < expected;
    return value <= expected;
  };
  if (constraint.values) {
    const results = [...constraint.values].map(accepts);
    if (!results.length) return false;
    return results.every(Boolean) ? true : results.every((value) => !value) ? false : undefined;
  }
  if (typeof expected !== 'bigint' || constraint.type !== 'int' || constraint.min === undefined || constraint.max === undefined) return undefined;
  if (constraint.min > constraint.max) return false;
  const minimum = accepts(constraint.min), maximum = accepts(constraint.max);
  if (operator === '==' || operator === '!=') {
    if (expected < constraint.min || expected > constraint.max) return operator === '!=';
    if (constraint.min === constraint.max) return operator === '==' ? minimum : !minimum;
    return undefined;
  }
  if (minimum && maximum) return true;
  if (!minimum && !maximum && ((operator === '>' && constraint.max <= expected) || (operator === '>=' && constraint.max < expected) || (operator === '<' && constraint.min >= expected) || (operator === '<=' && constraint.min > expected))) return false;
  return undefined;
}

function combinedCompiledIntegerCondition(expression: Extract<CompiledExpr, { kind: 'binary' }>, constraints: ReadonlyMap<string, VariableConstraint>, locals?: Set<string>): boolean | undefined {
  if (expression.operator !== 'and' && expression.operator !== 'or') return undefined;
  const parse = (value: CompiledExpr, operator: string): { name: string; operator: string; value: bigint } | undefined => {
    const literal = (item: CompiledExpr): bigint | undefined => item.kind === 'integer' ? BigInt(item.value) : item.kind === 'literal' && typeof item.value === 'bigint' ? item.value : undefined;
    if (value.kind === 'binary') {
      if (value.left.kind === 'load') { const expected = literal(value.right); return expected === undefined ? undefined : { name: value.left.name, operator, value: expected }; }
      if (value.right.kind === 'load') { const expected = literal(value.left); const flipped: Record<string, string> = { '==': '==', '!=': '!=', '>': '<', '>=': '<=', '<': '>', '<=': '>=' }; return expected === undefined ? undefined : { name: value.right.name, operator: flipped[operator], value: expected }; }
    }
    return undefined;
  };
  const left = parse(expression.left, expression.left.kind === 'binary' ? expression.left.operator : ''), right = parse(expression.right, expression.right.kind === 'binary' ? expression.right.operator : '');
  if (!left || !right || left.name !== right.name || locals?.has(left.name)) return undefined;
  const constraint = constraints.get(left.name);
  if (!constraint || constraint.type !== 'int') return undefined;
  const accepts = (predicate: { operator: string; value: bigint }, value: bigint): boolean => predicate.operator === '==' ? value === predicate.value : predicate.operator === '!=' ? value !== predicate.value : predicate.operator === '>' ? value > predicate.value : predicate.operator === '>=' ? value >= predicate.value : predicate.operator === '<' ? value < predicate.value : value <= predicate.value;
  if (constraint.values) {
    const results = [...constraint.values].map((value) => expression.operator === 'and' ? accepts(left, value as bigint) && accepts(right, value as bigint) : accepts(left, value as bigint) || accepts(right, value as bigint));
    return results.length && results.every(Boolean) ? true : results.length && results.every((value) => !value) ? false : undefined;
  }
  if (constraint.min === undefined || constraint.max === undefined || left.operator === '!=' || right.operator === '!=') return undefined;
  const interval = (predicate: { operator: string; value: bigint }): [bigint, bigint] => predicate.operator === '==' ? [predicate.value, predicate.value] : predicate.operator === '>' ? [predicate.value + 1n, constraint.max!] : predicate.operator === '>=' ? [predicate.value, constraint.max!] : predicate.operator === '<' ? [constraint.min!, predicate.value - 1n] : [constraint.min!, predicate.value];
  const a = interval(left), b = interval(right);
  if (expression.operator === 'and') return a[0] > b[1] || b[0] > a[1] ? false : undefined;
  const ordered = [a, b].sort((first, second) => first[0] < second[0] ? -1 : 1);
  return ordered[0][0] <= constraint.min && ordered[0][1] + 1n >= ordered[1][0] && ordered[1][1] >= constraint.max ? true : undefined;
}

function combinedCompiledFiniteCondition(expression: Extract<CompiledExpr, { kind: 'binary' }>, constraints: ReadonlyMap<string, VariableConstraint>, locals?: Set<string>): boolean | undefined {
  if (expression.operator !== 'and' && expression.operator !== 'or') return undefined;
  const parse = (value: CompiledExpr): { name: string; operator: string; expected: bigint | number | string } | undefined => {
    if (value.kind !== 'binary' || !['==', '!='].includes(value.operator)) return undefined;
    const literal = (item: CompiledExpr): bigint | number | string | undefined => item.kind === 'integer' ? BigInt(item.value) : item.kind === 'float' && Number.isFinite(Number(item.value)) ? Number(item.value) : item.kind === 'literal' && (typeof item.value === 'bigint' || typeof item.value === 'string') ? item.value : undefined;
    if (value.left.kind === 'load') { const expected = literal(value.right); return expected === undefined ? undefined : { name: value.left.name, operator: value.operator, expected }; }
    if (value.right.kind === 'load') { const expected = literal(value.left); return expected === undefined ? undefined : { name: value.right.name, operator: value.operator, expected }; }
    return undefined;
  };
  const left = parse(expression.left), right = parse(expression.right);
  if (!left || !right || left.name !== right.name || locals?.has(left.name)) return undefined;
  const constraint = constraints.get(left.name);
  const allowed = constraint?.type === 'float' ? constraint.floatValues : constraint?.values;
  if (!constraint || !allowed || constraint.type === 'str' && (typeof left.expected !== 'string' || typeof right.expected !== 'string') || constraint.type === 'int' && (typeof left.expected !== 'bigint' || typeof right.expected !== 'bigint') || constraint.type === 'float' && (typeof left.expected !== 'number' || typeof right.expected !== 'number')) return undefined;
  const accepts = (predicate: { operator: string; expected: bigint | number | string }, value: bigint | number | string): boolean => predicate.operator === '==' ? value === predicate.expected : value !== predicate.expected;
  const results = [...allowed].map((value) => expression.operator === 'and' ? accepts(left, value) && accepts(right, value) : accepts(left, value) || accepts(right, value));
  return results.length && results.every(Boolean) ? true : results.length && results.every((value) => !value) ? false : undefined;
}

function refineCompiledConstraints(constraints: ReadonlyMap<string, VariableConstraint> | undefined, expression: CompiledExpr | undefined, truth: boolean, locals?: Set<string>): ReadonlyMap<string, VariableConstraint> | undefined {
  if (!constraints || !expression) return undefined;
  if (expression.kind === 'unary' && expression.operator === 'not') return refineCompiledConstraints(constraints, expression.value, !truth, locals);
  if (expression.kind !== 'binary') return constraints;
  if (expression.operator === 'and' && truth) {
    const left = refineCompiledConstraints(constraints, expression.left, true, locals);
    return refineCompiledConstraints(left || constraints, expression.right, true, locals);
  }
  if (expression.operator === 'or' && !truth) {
    const left = refineCompiledConstraints(constraints, expression.left, false, locals);
    return refineCompiledConstraints(left || constraints, expression.right, false, locals);
  }
  if (!['==', '!=', '>', '>=', '<', '<='].includes(expression.operator)) return constraints;
  const floatLiteral = (value: CompiledExpr | undefined): number | undefined => value?.kind === 'float' && Number.isFinite(Number(value.value)) ? Number(value.value) : undefined;
  let floatName: string | undefined;
  let floatExpected: number | undefined;
  let floatOperator = expression.operator;
  if (expression.left.kind === 'load') { floatName = expression.left.name; floatExpected = floatLiteral(expression.right); }
  else if (expression.right.kind === 'load') {
    floatName = expression.right.name; floatExpected = floatLiteral(expression.left);
    const flipped: Record<string, string> = { '==': '==', '!=': '!=', '>': '<', '>=': '<=', '<': '>', '<=': '>=' };
    floatOperator = flipped[floatOperator];
  }
  const floating = floatName ? constraints.get(floatName) : undefined;
  if (floating?.type === 'float' && floatExpected !== undefined && !locals?.has(floatName!)) {
    const inverse: Record<string, string> = { '==': '!=', '!=': '==', '>': '<=', '>=': '<', '<': '>=', '<=': '>' };
    const effective = truth ? floatOperator : inverse[floatOperator];
    const next: VariableConstraint = { ...floating };
    if (effective === '==') { next.floatMin = floatExpected; next.floatMax = floatExpected; }
    else if (effective === '>') next.floatMin = Math.max(floating.floatMin ?? -Infinity, floatExpected);
    else if (effective === '>=') next.floatMin = Math.max(floating.floatMin ?? -Infinity, floatExpected);
    else if (effective === '<') next.floatMax = Math.min(floating.floatMax ?? Infinity, floatExpected);
    else if (effective === '<=') next.floatMax = Math.min(floating.floatMax ?? Infinity, floatExpected);
    if (floating.floatValues) next.floatValues = new Set([...floating.floatValues].filter((value) => effective === '==' ? value === floatExpected : effective === '!=' ? value !== floatExpected : effective === '>' ? value > floatExpected! : effective === '>=' ? value >= floatExpected! : effective === '<' ? value < floatExpected! : value <= floatExpected!));
    const result = new Map(constraints);
    result.set(floatName!, next);
    return result;
  }
  const literal = (value: CompiledExpr | undefined): bigint | string | undefined => {
    if (value?.kind === 'integer') return BigInt(value.value);
    if (value?.kind === 'literal' && (typeof value.value === 'bigint' || typeof value.value === 'string')) return value.value;
    return undefined;
  };
  let name: string | undefined;
  let expected: bigint | string | undefined;
  let operator = expression.operator;
  if (expression.left.kind === 'load') { name = expression.left.name; expected = literal(expression.right); }
  else if (expression.right.kind === 'load') {
    name = expression.right.name; expected = literal(expression.left);
    const flipped: Record<string, string> = { '==': '==', '!=': '!=', '>': '<', '>=': '<=', '<': '>', '<=': '>=' };
    operator = flipped[operator];
  }
  if (!name || locals?.has(name) || expected === undefined) return constraints;
  const current = constraints.get(name);
  if (!current || current.type !== (typeof expected === 'bigint' ? 'int' : 'str')) return constraints;
  const inverse: Record<string, string> = { '==': '!=', '!=': '==', '>': '<=', '>=': '<', '<': '>=', '<=': '>' };
  const effective = truth ? operator : inverse[operator];
  const next: VariableConstraint = { ...current };
  if (current.type === 'str') {
    if (effective === '==' && current.values) next.values = new Set([...current.values].filter((value) => value === expected));
    else if (effective === '!=' && current.values) next.values = new Set([...current.values].filter((value) => value !== expected));
  } else if (typeof expected === 'bigint') {
    if (effective === '==') { next.min = expected; next.max = expected; }
    else if (effective === '>') next.min = current.min === undefined || current.min <= expected ? expected + 1n : current.min;
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

function mergeCompiledConstraints(paths: Array<ReadonlyMap<string, VariableConstraint> | undefined>): ReadonlyMap<string, VariableConstraint> | undefined {
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
      merged.values = values;
    }
    result.set(name, merged);
  }
  return result;
}

function compiledIntegerBounds(
  expression: CompiledExpr,
  constants: Map<string, ConstantValue>,
  constraints: ReadonlyMap<string, VariableConstraint> | undefined,
): { min: bigint; max: bigint } | undefined {
  const value = constantValue(expression, constants);
  if (typeof value === 'bigint') return { min: value, max: value };
  if (expression.kind === 'load') {
    const constraint = constraints?.get(expression.name);
    if (!constraint || constraint.type !== 'int') return undefined;
    const values = constraint.values ? [...constraint.values].filter((item): item is bigint => typeof item === 'bigint') : [];
    const min = constraint.min ?? (values.length ? values.reduce((a, b) => a < b ? a : b) : undefined);
    const max = constraint.max ?? (values.length ? values.reduce((a, b) => a > b ? a : b) : undefined);
    return min !== undefined && max !== undefined ? { min, max } : undefined;
  }
  if (expression.kind === 'unary' && (expression.operator === '+' || expression.operator === '-')) {
    const value = compiledIntegerBounds(expression.value, constants, constraints);
    if (!value) return undefined;
    return expression.operator === '+' ? value : { min: -value.max, max: -value.min };
  }
  if (expression.kind !== 'binary' || (expression.operator !== '+' && expression.operator !== '-')) return undefined;
  const left = compiledIntegerBounds(expression.left, constants, constraints);
  const right = compiledIntegerBounds(expression.right, constants, constraints);
  if (!left || !right) return undefined;
  return expression.operator === '+'
    ? { min: left.min + right.min, max: left.max + right.max }
    : { min: left.min - right.max, max: left.max - right.min };
}

function compiledForConstraints(
  name: string,
  start: CompiledExpr,
  stop: CompiledExpr,
  step: CompiledExpr,
  constants: Map<string, ConstantValue>,
  constraints: ReadonlyMap<string, VariableConstraint> | undefined,
): ReadonlyMap<string, VariableConstraint> | undefined {
  const result = constraints ? new Map(constraints) : new Map<string, VariableConstraint>();
  result.delete(name);
  const first = compiledIntegerBounds(start, constants, constraints);
  const last = compiledIntegerBounds(stop, constants, constraints);
  const amount = compiledIntegerBounds(step, constants, constraints);
  if (!first || !last || !amount || amount.min !== amount.max || amount.min === 0n) return result;
  const min = first.min < last.min ? first.min : last.min;
  const max = first.max > last.max ? first.max : last.max;
  result.set(name, { type: 'int', min, max });
  return result;
}

function hasImpureCall(expression: CompiledExpr | undefined): boolean {
  if (!expression) return false;
  if (expression.kind === 'literal') return typeof expression.value === 'string' && hasInterpolation(expression.value);
  if (expression.kind === 'call') return !isPureBuiltin(expression.name) || expression.args.some(hasImpureCall);
  if (expression.kind === 'binary') return hasImpureCall(expression.left) || hasImpureCall(expression.right);
  if (expression.kind === 'unary') return hasImpureCall(expression.value);
  if (expression.kind === 'index') return hasImpureCall(expression.target) || hasImpureCall(expression.key);
  if (expression.kind === 'dict') return expression.entries.some((entry) => hasImpureCall(entry.value));
  if (expression.kind === 'list') return expression.items.some(hasImpureCall);
  return false;
}

function literalForConstant(value: ConstantValue): CompiledExpr | undefined {
  if (typeof value === 'boolean') return undefined;
  if (typeof value === 'bigint') return { kind: 'integer', value: value.toString() };
  if (typeof value === 'number') return { kind: 'float', value: String(value) };
  return { kind: 'literal', value };
}

function foldExpression(expression: CompiledExpr | undefined, constants: Map<string, ConstantValue>): CompiledExpr | undefined {
  if (!expression) return undefined;
  // A user function can mutate a global while evaluating an earlier operand.  Do
  // not substitute loads from the caller's environment across such a call.
  const environment = hasImpureCall(expression) ? new Map<string, ConstantValue>() : constants;
  const folded: CompiledExpr = expression.kind === 'binary'
    ? { ...expression, left: foldExpression(expression.left, environment)!, right: foldExpression(expression.right, environment)! }
    : expression.kind === 'unary'
      ? { ...expression, value: foldExpression(expression.value, environment)! }
      : expression.kind === 'index'
        ? { ...expression, target: foldExpression(expression.target, environment)!, key: foldExpression(expression.key, environment)! }
        : expression.kind === 'dict'
          ? { ...expression, entries: expression.entries.map((entry) => ({ ...entry, value: foldExpression(entry.value, environment)! })) }
          : expression.kind === 'list'
            ? { ...expression, items: expression.items.map((item) => foldExpression(item, environment)!) }
          : expression.kind === 'call'
            ? { ...expression, args: expression.args.map((argument) => foldExpression(argument, environment)!) }
            : expression;
  // Keep loads in place when the enclosing expression is not itself folded.
  // In particular, replacing the x in `x < 3` with its entry value would freeze
  // a loop condition even though x is changed by the loop body.
  if (expression.kind === 'load') return expression;
  const value = constantValue(folded, environment);
  return value === undefined ? folded : literalForConstant(value) || folded;
}

function foldAssignable(expression: CompiledExpr, constants: Map<string, ConstantValue>): CompiledExpr {
  if (expression.kind !== 'index') return expression;
  return { ...expression, target: foldAssignable(expression.target, constants), key: foldExpression(expression.key, constants)! };
}

function foldArguments(expressions: CompiledExpr[], constants: Map<string, ConstantValue>): CompiledExpr[] {
  let environment = constants;
  return expressions.map((expression) => {
    const folded = foldExpression(expression, environment)!;
    if (hasImpureCall(expression)) environment = new Map<string, ConstantValue>();
    return folded;
  });
}

function sameConstant(left: ConstantValue, right: ConstantValue): boolean {
  return left === right;
}

function mergeConstantEnvironments(target: Map<string, ConstantValue>, paths: Map<string, ConstantValue>[], allowNew = true): void {
  if (!paths.length) return;
  for (const name of [...target.keys()]) {
    const first = paths[0].get(name);
    if (first === undefined || paths.some((path) => {
      const value = path.get(name);
      return value === undefined || !sameConstant(first, value);
    })) target.delete(name);
  }
  for (const [name, value] of paths[0]) {
    if (!allowNew && !target.has(name)) continue;
    if (paths.every((path) => {
      const candidate = path.get(name);
      return candidate !== undefined && sameConstant(value, candidate);
    })) target.set(name, value);
  }
}

function declarationsInScope(instructions: Instruction[], result = new Set<string>()): Set<string> {
  for (const instruction of instructions) {
    if (instruction.op === 'declare') result.add(instruction.name);
    if (instruction.op === 'if') {
      declarationsInScope(instruction.body, result);
      instruction.elseIf.forEach((branch) => declarationsInScope(branch.body, result));
      declarationsInScope(instruction.otherwise, result);
    }
    if (instruction.op === 'for' || instruction.op === 'forEach' || instruction.op === 'while') declarationsInScope(instruction.body, result);
    // A nested choice pushes another runtime frame, so its declarations do
    // not belong to the surrounding choice option's scope.
  }
  return result;
}

function definitelyTerminates(instruction: Instruction, constants: Map<string, ConstantValue> = new Map()): boolean {
  if (instruction.op === 'return' || instruction.op === 'goto') return true;
  if (instruction.op === 'if') {
    return instruction.otherwise.length > 0
      && instruction.body.length > 0 && definitelyTerminates(instruction.body[instruction.body.length - 1], constants)
      && instruction.elseIf.every((branch) => branch.body.length > 0 && definitelyTerminates(branch.body[branch.body.length - 1], constants))
      && definitelyTerminates(instruction.otherwise[instruction.otherwise.length - 1], constants);
  }
  if (instruction.op === 'choice') {
    return instruction.options.length > 0 && instruction.options.every((option) => option.body.length > 0 && definitelyTerminates(option.body[option.body.length - 1], constants));
  }
  if (instruction.op === 'for') {
    // A valid for-loop executes its body at least once.  Invalid bounds or a
    // zero step throw before normal fall-through, so a terminating body also
    // makes the loop terminating for dead-code purposes.
    return instruction.body.length > 0 && definitelyTerminates(instruction.body[instruction.body.length - 1], constants);
  }
  if (instruction.op === 'while') {
    return constantValue(instruction.condition, constants) === true
      && instruction.body.length > 0
      && definitelyTerminates(instruction.body[instruction.body.length - 1], constants);
  }
  return false;
}

function visitExpressionCalls(expression: CompiledExpr | undefined, visit: (name: string) => void): void {
  if (!expression) return;
  if (expression.kind === 'literal' && typeof expression.value === 'string') {
    if (hasInterpolation(expression.value)) visit('*');
    interpolationCalls(expression.value).forEach(visit);
  }
  if (expression.kind === 'call') { visit(expression.name); expression.args.forEach((argument) => visitExpressionCalls(argument, visit)); }
  if (expression.kind === 'binary') { visitExpressionCalls(expression.left, visit); visitExpressionCalls(expression.right, visit); }
  if (expression.kind === 'unary') visitExpressionCalls(expression.value, visit);
  if (expression.kind === 'index') { visitExpressionCalls(expression.target, visit); visitExpressionCalls(expression.key, visit); }
  if (expression.kind === 'dict') expression.entries.forEach((entry) => visitExpressionCalls(entry.value, visit));
  if (expression.kind === 'list') expression.items.forEach((item) => visitExpressionCalls(item, visit));
}

function visitExpressionCallsInExecution(
  expression: CompiledExpr | undefined,
  constants: Map<string, ConstantValue>,
  constraints: ReadonlyMap<string, VariableConstraint> | undefined,
  locals: Set<string> | undefined,
  visit: (name: string) => void,
): void {
  if (!expression) return;
  if (expression.kind === 'literal' && typeof expression.value === 'string') {
    if (hasInterpolation(expression.value)) visit('*');
    interpolationCalls(expression.value).forEach(visit);
    return;
  }
  if (expression.kind === 'call') {
    expression.args.forEach((argument) => visitExpressionCallsInExecution(argument, constants, constraints, locals, visit));
    visit(expression.name);
    return;
  }
  if (expression.kind === 'binary') {
    const leftValue = expression.operator === 'and' || expression.operator === 'or'
      ? constantValue(expression.left, constants) ?? constrainedCondition(expression.left, constraints, locals)
      : undefined;
    visitExpressionCallsInExecution(expression.left, constants, constraints, locals, visit);
    if (expression.operator === 'and' && leftValue === false) return;
    if (expression.operator === 'or' && leftValue === true) return;
    visitExpressionCallsInExecution(expression.right, constants, constraints, locals, visit);
    return;
  }
  if (expression.kind === 'unary') visitExpressionCallsInExecution(expression.value, constants, constraints, locals, visit);
  if (expression.kind === 'index') {
    visitExpressionCallsInExecution(expression.target, constants, constraints, locals, visit);
    visitExpressionCallsInExecution(expression.key, constants, constraints, locals, visit);
  }
  if (expression.kind === 'dict') expression.entries.forEach((entry) => visitExpressionCallsInExecution(entry.value, constants, constraints, locals, visit));
  if (expression.kind === 'list') expression.items.forEach((item) => visitExpressionCallsInExecution(item, constants, constraints, locals, visit));
}

function writtenVariables(instructions: Instruction[], effects: Map<string, Set<string>>, result = new Set<string>()): Set<string> {
  const visitCalls = (expression: CompiledExpr | undefined) => visitExpressionCalls(expression, (name) => {
    for (const variable of effects.get(name) || []) result.add(variable);
  });
  for (const instruction of instructions) {
    if (instruction.op === 'declare') {
      result.add(instruction.name);
      visitCalls(instruction.initial);
    }
    if (instruction.op === 'set') {
      if (instruction.target.kind === 'load') result.add(instruction.target.name);
      if (instruction.target.kind === 'index' && instruction.target.target.kind === 'load') result.add(instruction.target.target.name);
      visitCalls(instruction.target); visitCalls(instruction.value);
    }
    if (instruction.op === 'unset') {
      if (instruction.target.kind === 'load') result.add(instruction.target.name);
      if (instruction.target.kind === 'index' && instruction.target.target.kind === 'load') result.add(instruction.target.target.name);
      visitCalls(instruction.target);
    }
    if (instruction.op === 'command') instruction.args.forEach(visitCalls);
    if (instruction.op === 'call') {
      for (const variable of effects.get(instruction.name) || []) result.add(variable);
      instruction.args.forEach(visitCalls);
    }
    if (instruction.op === 'return') visitCalls(instruction.value);
    if (instruction.op === 'if') {
      visitCalls(instruction.condition);
      writtenVariables(instruction.body, effects, result);
      instruction.elseIf.forEach((branch) => { visitCalls(branch.condition); writtenVariables(branch.body, effects, result); });
      writtenVariables(instruction.otherwise, effects, result);
    }
    if (instruction.op === 'for') {
      result.add(instruction.name);
      visitCalls(instruction.start); visitCalls(instruction.stop); visitCalls(instruction.step);
      writtenVariables(instruction.body, effects, result);
    }
    if (instruction.op === 'forEach') {
      result.add(instruction.name);
      visitCalls(instruction.iterable);
      writtenVariables(instruction.body, effects, result);
    }
    if (instruction.op === 'while') {
      visitCalls(instruction.condition);
      writtenVariables(instruction.body, effects, result);
    }
    if (instruction.op === 'choice') {
      visitCalls(instruction.prompt);
      instruction.options.forEach((option) => { visitCalls(option.label); writtenVariables(option.body, effects, result); });
    }
  }
  return result;
}

function functionWrites(functions: Instruction[], globalNames: Set<string>): Map<string, Set<string>> {
  const direct = new Map<string, Set<string>>(), calls = new Map<string, Set<string>>();
  const walk = (instructions: Instruction[], writes: Set<string>, invoked: Set<string>, locals = new Set<string>()): void => {
    const recordCall = (name: string) => { if (name === '*') globalNames.forEach((variable) => writes.add(variable)); else if (!isPureBuiltin(name)) invoked.add(name); };
    for (const instruction of instructions) {
      if (instruction.op === 'declare') {
        visitExpressionCalls(instruction.initial, recordCall);
        locals.add(instruction.name);
      }
      if ((instruction.op === 'set' || instruction.op === 'unset') && instruction.target.kind === 'load' && globalNames.has(instruction.target.name) && !locals.has(instruction.target.name)) writes.add(instruction.target.name);
      if (instruction.op === 'call') { recordCall(instruction.name); instruction.args.forEach((argument) => visitExpressionCalls(argument, recordCall)); }
      if (instruction.op === 'set') { visitExpressionCalls(instruction.target, recordCall); visitExpressionCalls(instruction.value, recordCall); }
      if (instruction.op === 'unset') visitExpressionCalls(instruction.target, recordCall);
      if (instruction.op === 'command') instruction.args.forEach((argument) => visitExpressionCalls(argument, recordCall));
      if (instruction.op === 'return') visitExpressionCalls(instruction.value, recordCall);
      if (instruction.op === 'if') {
        visitExpressionCalls(instruction.condition, recordCall);
        walk(instruction.body, writes, invoked, new Set(locals));
        instruction.elseIf.forEach((branch) => { visitExpressionCalls(branch.condition, recordCall); walk(branch.body, writes, invoked, new Set(locals)); });
        walk(instruction.otherwise, writes, invoked, new Set(locals));
      }
      if (instruction.op === 'for') { visitExpressionCalls(instruction.start, recordCall); visitExpressionCalls(instruction.stop, recordCall); visitExpressionCalls(instruction.step, recordCall); const bodyLocals = new Set(locals); bodyLocals.add(instruction.name); walk(instruction.body, writes, invoked, bodyLocals); }
      if (instruction.op === 'forEach') { visitExpressionCalls(instruction.iterable, recordCall); const bodyLocals = new Set(locals); bodyLocals.add(instruction.name); walk(instruction.body, writes, invoked, bodyLocals); }
      if (instruction.op === 'while') { visitExpressionCalls(instruction.condition, recordCall); walk(instruction.body, writes, invoked, new Set(locals)); }
      if (instruction.op === 'choice') { visitExpressionCalls(instruction.prompt, recordCall); instruction.options.forEach((option) => { visitExpressionCalls(option.label, recordCall); walk(option.body, writes, invoked, new Set(locals)); }); }
    }
  };
  for (const instruction of functions) {
    if (instruction.op !== 'function') continue;
    const writes = new Set<string>(), invoked = new Set<string>();
    walk(instruction.body, writes, invoked, new Set(instruction.params.map((param) => param.name)));
    direct.set(instruction.name, writes); calls.set(instruction.name, invoked);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, invoked] of calls) {
      const writes = direct.get(name)!;
      for (const callee of invoked) for (const variable of direct.get(callee) || []) {
        if (!writes.has(variable)) { writes.add(variable); changed = true; }
      }
    }
  }
  return direct;
}

interface OptimizationOptions { preserveDeclarations: boolean; }

function optimizeInstructions(
  instructions: Instruction[],
  effects: Map<string, Set<string>>,
  constants = new Map<string, ConstantValue>(),
  options: OptimizationOptions = { preserveDeclarations: false },
  locals?: Set<string>,
  constraints?: ReadonlyMap<string, VariableConstraint>,
): Instruction[] {
  const output: Instruction[] = [];
  const currentConstraints = constraints ? new Map(constraints) : undefined;
  const invalidateCall = (name: string) => {
    if (name === '*') {
      for (const variable of [...constants.keys()]) if (!locals?.has(variable)) constants.delete(variable);
      currentConstraints?.clear();
      return;
    }
    for (const variable of effects.get(name) || []) if (!locals?.has(variable)) { constants.delete(variable); currentConstraints?.delete(variable); }
  };
  const invalidateExpression = (expression: CompiledExpr | undefined) => visitExpressionCalls(expression, invalidateCall);
  const invalidateConditionExpression = (expression: CompiledExpr | undefined) => visitExpressionCallsInExecution(expression, constants, currentConstraints, locals, invalidateCall);
  const invalidateConstraintsFor = (items: Instruction[]) => {
    for (const variable of writtenVariables(items, effects)) if (!locals?.has(variable)) currentConstraints?.delete(variable);
  };
  const replaceConstraints = (next: ReadonlyMap<string, VariableConstraint> | undefined) => {
    if (!currentConstraints || !next) return;
    const entries = [...next.entries()];
    currentConstraints.clear();
    entries.forEach(([name, constraint]) => currentConstraints.set(name, constraint));
  };
  const invalidateAssigned = (items: Instruction[]): void => {
    for (const item of items) {
      if ((item.op === 'set' || item.op === 'unset') && item.target.kind === 'load') { constants.delete(item.target.name); currentConstraints?.delete(item.target.name); }
      if (item.op === 'call') { invalidateCall(item.name); item.args.forEach(invalidateExpression); }
      if (item.op === 'declare') constants.delete(item.name);
      if (item.op === 'declare') invalidateExpression(item.initial);
      if (item.op === 'set') { invalidateExpression(item.target); invalidateExpression(item.value); }
      if (item.op === 'unset') invalidateExpression(item.target);
      if (item.op === 'command') item.args.forEach(invalidateExpression);
      if (item.op === 'return') invalidateExpression(item.value);
      if (item.op === 'if') { invalidateExpression(item.condition); invalidateAssigned(item.body); item.elseIf.forEach((branch) => { invalidateExpression(branch.condition); invalidateAssigned(branch.body); }); invalidateAssigned(item.otherwise); }
      if (item.op === 'for') { invalidateExpression(item.start); invalidateExpression(item.stop); invalidateExpression(item.step); invalidateAssigned(item.body); }
      if (item.op === 'forEach') { invalidateExpression(item.iterable); invalidateAssigned(item.body); }
      if (item.op === 'while') { invalidateExpression(item.condition); invalidateAssigned(item.body); }
      if (item.op === 'choice') { invalidateExpression(item.prompt); item.options.forEach((option) => { invalidateExpression(option.label); invalidateAssigned(option.body); }); }
    }
  };
  for (const instruction of instructions) {
    if (instruction.op === 'declare') {
      const initial = instruction.initial?.kind === 'load' && constants.has(instruction.initial.name)
        ? literalForConstant(constants.get(instruction.initial.name)!)
        : foldExpression(instruction.initial, constants);
      const value = constantValue(initial, constants);
      // Preserve the declaration in the emitted program, but keep exact
      // immutable values available to later expressions.  This is especially
      // important for constant entries supplied by .novel/variables.json.
      if (value === undefined || (options.preserveDeclarations && !instruction.constant)) constants.delete(instruction.name); else constants.set(instruction.name, value);
      locals?.add(instruction.name);
      invalidateExpression(initial);
      output.push({ ...instruction, initial });
      continue;
    }
    if (instruction.op === 'set') {
      const valueExpression = foldExpression(instruction.value, constants)!;
      const targetExpression = foldAssignable(instruction.target, hasImpureCall(instruction.value) ? new Map<string, ConstantValue>() : constants);
      if (instruction.target.kind === 'load') {
        currentConstraints?.delete(instruction.target.name);
        const value = constantValue(valueExpression, constants);
        if (value === undefined) constants.delete(instruction.target.name); else constants.set(instruction.target.name, value);
      } else if (instruction.target.kind === 'index' && instruction.target.target.kind === 'load') constants.delete(instruction.target.target.name);
      invalidateExpression(targetExpression); invalidateExpression(valueExpression);
      output.push({ ...instruction, target: targetExpression, value: valueExpression });
      continue;
    }
    if (instruction.op === 'unset') {
      const targetExpression = foldAssignable(instruction.target, constants);
      if (instruction.target.kind === 'load') { constants.delete(instruction.target.name); currentConstraints?.delete(instruction.target.name); }
      else if (instruction.target.kind === 'index' && instruction.target.target.kind === 'load') constants.delete(instruction.target.target.name);
      invalidateExpression(targetExpression);
      output.push({ ...instruction, target: targetExpression });
      continue;
    }
    if (instruction.op === 'call') {
      const args = foldArguments(instruction.args, constants);
      args.forEach(invalidateExpression);
      invalidateCall(instruction.name);
      output.push({ ...instruction, args });
      continue;
    }
    if (instruction.op === 'if') {
      // Invalidate the environment before folding any branch condition.  A
      // call in an earlier condition may change a global read by a later one.
      invalidateConditionExpression(instruction.condition);
      const conditionConstants = new Map(constants);
      for (const name of writtenVariables(instruction.body, effects)) conditionConstants.delete(name);
      const condition = foldExpression(instruction.condition, conditionConstants)!;
      const first = constantValue(condition, constants) ?? constrainedCondition(condition, currentConstraints, locals);
      const elseIf = instruction.elseIf.map((branch) => ({ ...branch, condition: foldExpression(branch.condition, constants)! }));
      invalidateConditionExpression(condition);
      if (first === true) {
        output.push(...optimizeInstructions(instruction.body, effects, constants, options, locals, currentConstraints));
        replaceConstraints(refineCompiledConstraints(currentConstraints, condition, true, locals));
        invalidateConstraintsFor(instruction.body);
        if (output.length && definitelyTerminates(output[output.length - 1], constants)) break;
        continue;
      }
      if (first === false) {
        let selected: Instruction[] | undefined;
        let unknown = false;
        let selectedConstraints: ReadonlyMap<string, VariableConstraint> | undefined;
        let remainingConstraints = refineCompiledConstraints(currentConstraints, condition, false, locals);
        if (remainingConstraints) remainingConstraints = new Map(remainingConstraints);
        for (let index = 0; index < elseIf.length; index += 1) {
          const branch = elseIf[index];
          const value = constantValue(branch.condition, constants) ?? constrainedCondition(branch.condition, remainingConstraints, locals);
          invalidateConditionExpression(branch.condition);
          if (value === true) { selected = branch.body; selectedConstraints = refineCompiledConstraints(remainingConstraints, branch.condition, true, locals); break; }
          if (value !== false) {
            unknown = true;
            for (const dormant of elseIf.slice(index + 1)) invalidateConditionExpression(dormant.condition);
            break;
          }
          const refined = refineCompiledConstraints(remainingConstraints, branch.condition, false, locals);
          remainingConstraints = refined ? new Map(refined) : refined;
        }
        if (!unknown) {
          output.push(...optimizeInstructions(selected || instruction.otherwise, effects, constants, options, locals, currentConstraints));
          replaceConstraints(selected ? selectedConstraints : remainingConstraints);
          invalidateConstraintsFor(selected || instruction.otherwise);
          if (output.length && definitelyTerminates(output[output.length - 1], constants)) break;
          continue;
        }
      }
      if (first !== false) elseIf.forEach((branch) => invalidateConditionExpression(branch.condition));
      const branchBase = new Map(constants);
      const branchConstants = new Map(branchBase);
      const elseIfConstants = elseIf.map(() => new Map(branchBase));
      const otherwiseConstants = new Map(branchBase);
      const branchConstraints = refineCompiledConstraints(currentConstraints, condition, true, locals);
      let remainingBranchConstraints: ReadonlyMap<string, VariableConstraint> | undefined = refineCompiledConstraints(currentConstraints, condition, false, locals);
      const elseIfConstraints = elseIf.map((branch) => {
        const selected = refineCompiledConstraints(remainingBranchConstraints, branch.condition, true, locals);
        remainingBranchConstraints = refineCompiledConstraints(remainingBranchConstraints, branch.condition, false, locals);
        return selected;
      });
      let otherwiseReachable = instruction.otherwise.length > 0;
      let fallthroughConstraints: ReadonlyMap<string, VariableConstraint> | undefined = currentConstraints;
      for (const branchCondition of [condition, ...elseIf.map((branch) => branch.condition)]) {
        const value = constantValue(branchCondition, constants) ?? constrainedCondition(branchCondition, fallthroughConstraints, locals);
        if (value === true) { otherwiseReachable = false; break; }
        if (value !== false) fallthroughConstraints = refineCompiledConstraints(fallthroughConstraints, branchCondition, false, locals);
      }
      const optimized: Instruction = {
        ...instruction,
        condition,
        body: optimizeInstructions(instruction.body, effects, branchConstants, options, locals ? new Set(locals) : undefined, branchConstraints || currentConstraints),
        elseIf: elseIf.map((branch, index) => ({ ...branch, body: optimizeInstructions(branch.body, effects, elseIfConstants[index], options, locals ? new Set(locals) : undefined, elseIfConstraints[index] || currentConstraints) })),
        otherwise: otherwiseReachable ? optimizeInstructions(instruction.otherwise, effects, otherwiseConstants, options, locals ? new Set(locals) : undefined, remainingBranchConstraints || currentConstraints) : [],
      };
      output.push(optimized);
      if (definitelyTerminates(optimized, constants)) break;
      const conditionsArePure = !hasImpureCall(condition) && elseIf.every((branch) => !hasImpureCall(branch.condition));
      if (conditionsArePure) {
        const paths: Map<string, ConstantValue>[] = [];
        const terminates = (body: Instruction[], environment: Map<string, ConstantValue>) => body.length > 0 && definitelyTerminates(body[body.length - 1], environment);
        if (constantValue(condition, branchBase) !== false && !terminates(optimized.body, branchConstants)) paths.push(branchConstants);
        elseIf.forEach((branch, index) => {
          if (constantValue(branch.condition, branchBase) !== false && !terminates(optimized.elseIf[index].body, elseIfConstants[index])) paths.push(elseIfConstants[index]);
        });
        if (instruction.otherwise.length) {
          if (!terminates(optimized.otherwise, otherwiseConstants)) paths.push(otherwiseConstants);
        } else {
          paths.push(branchBase);
        }
        mergeConstantEnvironments(constants, paths);
      } else {
        invalidateAssigned([instruction]);
      }
      replaceConstraints(mergeCompiledConstraints([
        branchConstraints,
        ...elseIfConstraints,
        otherwiseReachable ? remainingBranchConstraints : undefined,
      ]));
      invalidateConstraintsFor([instruction]);
      continue;
    }
    if (instruction.op === 'for' || instruction.op === 'forEach' || instruction.op === 'while') {
      if (instruction.op === 'for') {
        const [start, stop, step] = foldArguments([instruction.start, instruction.stop, instruction.step], constants);
        invalidateExpression(start); invalidateExpression(stop); invalidateExpression(step);
        const loopConstraints = compiledForConstraints(instruction.name, start, stop, step, constants, currentConstraints);
        invalidateAssigned(instruction.body);
        const loopConstants = new Map(constants);
        loopConstants.delete(instruction.name);
        const loopLocals = locals ? new Set(locals) : new Set<string>();
        loopLocals.add(instruction.name);
        const constraintLocals = new Set(loopLocals);
        constraintLocals.delete(instruction.name);
        const optimized: Instruction = { ...instruction, start, stop, step, body: optimizeInstructions(instruction.body, effects, loopConstants, options, constraintLocals, loopConstraints) };
        output.push(optimized);
        if (definitelyTerminates(optimized, constants)) break;
        continue;
      }
      if (instruction.op === 'forEach') {
        const iterable = foldExpression(instruction.iterable, constants)!;
        invalidateExpression(iterable);
        invalidateAssigned(instruction.body);
        const loopConstants = new Map(constants);
        loopConstants.delete(instruction.name);
        const loopLocals = new Set(locals || []);
        loopLocals.add(instruction.name);
        output.push({ ...instruction, iterable, body: optimizeInstructions(instruction.body, effects, loopConstants, options, loopLocals, undefined) });
        continue;
      }
      const condition = foldExpression(instruction.condition, constants)!;
      invalidateExpression(condition);
      if (constantValue(condition, constants) === false) continue;
      const loopConstraints = refineCompiledConstraints(currentConstraints, condition, true, locals);
      invalidateAssigned(instruction.body);
      const loopConstants = new Map(constants);
      const optimized: Instruction = { ...instruction, condition, body: optimizeInstructions(instruction.body, effects, loopConstants, options, locals ? new Set(locals) : undefined, loopConstraints || currentConstraints) };
      output.push(optimized);
      if (definitelyTerminates(optimized, constants)) break;
      continue;
    }
    if (instruction.op === 'choice') {
      // Runtime order is all labels, then the prompt, then the selected body.
      // Keep each later expression from seeing constants invalidated by an
      // earlier user call, while still folding pure expressions before it.
      let choiceConstants = new Map(constants);
      const choiceOptions = instruction.options.map((option) => {
        const result = { ...option, label: foldExpression(option.label, choiceConstants)! };
        if (hasImpureCall(option.label)) choiceConstants = new Map<string, ConstantValue>();
        return result;
      });
      const prompt = foldExpression(instruction.prompt, choiceConstants);
      if (hasImpureCall(instruction.prompt)) choiceConstants = new Map<string, ConstantValue>();
      invalidateExpression(prompt); choiceOptions.forEach((option) => invalidateExpression(option.label));
      const choiceBase = new Map(choiceConstants);
      const optionConstants = choiceOptions.map(() => new Map(choiceBase));
      const optimized: Instruction = {
        ...instruction,
        prompt,
        options: choiceOptions.map((option, index) => ({
          ...option,
          body: optimizeInstructions(option.body, effects, optionConstants[index], options, new Set(locals || []), constraints),
        })),
      };
      output.push(optimized);
      if (definitelyTerminates(optimized, constants)) break;
      const labelsArePure = !hasImpureCall(prompt) && choiceOptions.every((option) => !hasImpureCall(option.label));
      if (labelsArePure) {
        const terminates = (body: Instruction[], environment: Map<string, ConstantValue>) => body.length > 0 && definitelyTerminates(body[body.length - 1], environment);
        const paths = optionConstants.map((environment, index) => {
          for (const name of declarationsInScope(optimized.options[index].body)) environment.delete(name);
          return { environment, index };
        }).filter(({ environment, index }) => !terminates(optimized.options[index].body, environment)).map(({ environment }) => environment);
        mergeConstantEnvironments(constants, paths, false);
      } else {
        instruction.options.forEach((option) => invalidateAssigned(option.body));
        invalidateExpression(prompt); choiceOptions.forEach((option) => invalidateExpression(option.label));
      }
      continue;
    }
    const simple = instruction.op === 'command' || instruction.op === 'return'
      ? { ...instruction, ...(instruction.op === 'command' ? { args: foldArguments(instruction.args, constants) } : { value: foldExpression(instruction.value, constants) }) } as Instruction
      : instruction;
    if (simple.op === 'command') simple.args.forEach(invalidateExpression);
    if (simple.op === 'return') invalidateExpression(simple.value);
    output.push(simple);
    if (definitelyTerminates(simple, constants)) break;
  }
  return output;
}

const characterTypeName = (name: string) => `character:${name}`;
function characterDeclarations(characters: Character[]): Statement[] {
  return characters.map((character) => ({
    kind: 'declare', name: character.name, type: { kind: 'struct', name: characterTypeName(character.name) },
    initial: { kind: 'dict', entries: character.properties.map((property) => ({ key: property.name, value: property.value })) },
    line: character.line, column: character.column,
  }));
}

export function compile(script: Script, externalGlobals = new Map<string, ValueType>(), externalCharacters = new Map<string, Set<string> | ExternalCharacter>(), debug = false): CompiledProgram {
  assertAnalyzed(script, 'current', externalGlobals, externalCharacters);
  const constraints = (externalGlobals as Map<string, ValueType> & { constraints?: ReadonlyMap<string, VariableConstraint> }).constraints;
  const compiler = new Compiler();
  const externalCharacterSources = [...externalCharacters.values()]
    .filter((character): character is ExternalCharacter => !(character instanceof Set))
    .flatMap((character) => character.definition ? [character.definition] : []);
  const implicitCharacterGlobals = characterDeclarations(script.characters);
  const externalCharacterGlobals = characterDeclarations(externalCharacterSources);
  const runtimeScript = { ...script, globals: [...implicitCharacterGlobals, ...script.globals] };
  const metadataGlobals = new Map(externalGlobals);
  for (const name of externalCharacters.keys()) metadataGlobals.set(name, { kind: 'struct', name: characterTypeName(name) });
  const variables = compiler.variables(runtimeScript, metadataGlobals);
  // A file can be launched directly by Scene Flow. Materialize external
  // character definitions as globals so their statically known fields (for
  // example display names) exist even when the declaring file was not run.
  // On an ordinary file transfer preserveGlobals keeps the existing value.
  const rawGlobals = compiler.statements([...externalCharacterGlobals, ...runtimeScript.globals]);
  const rawFunctions = script.functions.map((fn) => compiler.function(fn));
  const immutableGlobals = new Map<string, ConstantValue>();
  for (const instruction of rawGlobals) {
    if (instruction.op !== 'declare' || !instruction.constant || !instruction.initial) continue;
    const value = constantValue(instruction.initial, immutableGlobals);
    if (value !== undefined) immutableGlobals.set(instruction.name, value);
  }
  const effects = functionWrites(rawFunctions, new Set([...externalGlobals.keys(), ...runtimeScript.globals.filter((statement) => statement.kind === 'declare').map((statement) => statement.name)]));
  // A transferred file executes globals with preserve=true: an existing
  // global keeps its value instead of receiving the declaration initializer.
  // Do not fold declaration-derived values in this scope.
  const globals = debug ? rawGlobals : optimizeInstructions(rawGlobals, effects, new Map(), { preserveDeclarations: true }, undefined, constraints);
  const functions = debug ? rawFunctions : rawFunctions.map((instruction) => instruction.op === 'function'
    ? { ...instruction, body: optimizeInstructions(instruction.body, effects, new Map([...immutableGlobals].filter(([name]) => !instruction.params.some((param) => param.name === name))), { preserveDeclarations: false }, new Set(instruction.params.map((param) => param.name)), constraints) }
    : instruction);
  const externalCharacterDefinitions = externalCharacterSources
    .map(({ properties: _properties, ...character }) => ({ ...character, external: true }));

  return {
    version: 2,
    assets: script.assets,
    characters: [...externalCharacterDefinitions, ...script.characters.map(({ properties: _properties, ...character }) => character)],
    globals,
    functions,
    scenes: script.scenes.map((scene) => ({ name: scene.name, file: scene.file, line: scene.line, instructions: debug ? compiler.statements(scene.body) : optimizeInstructions(compiler.statements(scene.body), effects, new Map(immutableGlobals), { preserveDeclarations: false }, undefined, constraints) })),
    variables,
  };
}

class Compiler {

  variables(script: Script, externalGlobals = new Map<string, ValueType>()): VariableEntry[] {
    const result: VariableEntry[] = [];
    type Bindings = Map<string, VariableEntry>;
    const declare = (name: string, type: ValueType, bindings: Bindings, loc: VariableLocation) => {
      const existing = bindings.get(name);
      if (existing && existing.scope === loc.scope && existing.definedIn === loc.container && JSON.stringify(existing.type) === JSON.stringify(type)) {
        existing.definitions.push(loc);
        return;
      }
      const entry: VariableEntry = { name, type, scope: loc.scope, definedIn: loc.container, definitions: [loc], references: [], mutable: true };
      bindings.set(name, entry); result.push(entry);
    };
    const ref = (e: Expr, bindings: Bindings, loc: VariableLocation): void => {
      if (e.kind === 'variable') bindings.get(e.name)?.references.push({ ...loc, line: e.line, column: e.column, kind: loc.kind || 'expression' });
      if (e.kind === 'literal' && typeof e.value === 'string') for (const m of e.value.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)(\(\))?\}/g)) if (!m[2]) {
        const sourceColumn = e.sourceColumns?.[m.index + 1];
        bindings.get(m[1].split('.')[0])?.references.push({ ...loc, line: e.line, column: sourceColumn ?? (e.column === undefined ? undefined : e.column + m.index + 1), kind: 'interpolation' });
      }
      if (e.kind === 'binary') { ref(e.left, bindings, loc); ref(e.right, bindings, loc); }
      if (e.kind === 'unary') ref(e.value, bindings, loc);
      if (e.kind === 'index') { ref(e.target, bindings, loc); ref(e.key, bindings, loc); }
      if (e.kind === 'dict') e.entries.forEach(x => ref(x.value, bindings, loc));
      if (e.kind === 'list') e.items.forEach(x => ref(x, bindings, loc));
      if (e.kind === 'call') e.args.forEach(x => ref(x, bindings, loc));
    };
      const mergeBranchBindings = (bindings: Bindings, paths: Bindings[]): void => {
        const names = new Set(paths.flatMap(path => [...path.keys()]));
        for (const name of names) {
          const entries = paths.map(path => path.get(name));
          if (entries.some(entry => !entry)) continue;
          const unique = [...new Set(entries as VariableEntry[])];
          const first = unique[0]!;
          const current = bindings.get(name);
          // A name that is global (or already local) in only some paths is
          // still path-sensitive. Merge it only when every path replaced the
          // surrounding binding with a distinct, compatible local entry.
          if (current && unique.some((entry) => entry === current)) continue;
          if (!unique.every((entry) => entry.scope === first.scope && entry.definedIn === first.definedIn && JSON.stringify(entry.type) === JSON.stringify(first.type))) continue;
        for (const entry of unique.slice(1)) {
          first.definitions.push(...entry.definitions);
          first.references.push(...entry.references);
          first.mutable = first.mutable && entry.mutable;
          const index = result.indexOf(entry);
          if (index >= 0) result.splice(index, 1);
        }
        bindings.set(name, first);
      }
    };
    let scopeId = 0;
    const walk = (list: Statement[], bindings: Bindings, loc: VariableLocation, declarations = bindings, declarationLoc = loc) => {
      for (const s of list) {
        if (s.kind === 'declare') { if (s.initial) ref(s.initial, bindings, loc); if (s.type === 'infer') throw new CompileError(`変数 '${s.name}' の型推論が完了していません`); declare(s.name, s.type, declarations, { ...declarationLoc, line: s.nameLine ?? s.line, column: s.nameColumn ?? s.column, kind: 'definition' }); const entry = declarations.get(s.name)!; entry.mutable = !s.constant; bindings.set(s.name, entry); }
        if (s.kind === 'set') {
          if (s.target.kind === 'variable') ref(s.target, bindings, { ...loc, kind: 'assignment' });
          else { ref(s.target.target, bindings, loc); ref(s.target.key, bindings, loc); }
          ref(s.value, bindings, loc);
        }
        if (s.kind === 'unset') ref(s.target, bindings, loc);
        if (s.kind === 'command' || s.kind === 'call') s.args.forEach(e => ref(e, bindings, loc));
        if (s.kind === 'command' && s.args[0]?.kind === 'literal' && typeof s.args[0].value === 'string') {
          const commandName = s.name;
          const speaker = commandName === 'say' && s.args[0].value !== 'narrator' && s.args[0].value !== 'none'
            ? s.args[0].value : '';
          const shownCharacter = commandName === 'show' ? /^([A-Za-z_][A-Za-z0-9_]*)\./.exec(s.args[0].value)?.[1] || '' : '';
          const hiddenCharacter = commandName === 'hide' ? s.args[0].value : '';
          const characterName = speaker || shownCharacter || hiddenCharacter;
          if (characterName && bindings.has(characterName)) {
            ref({ kind: 'variable', name: characterName, line: s.args[0].line, column: s.args[0].column }, bindings, loc);
          }
        }
        if (s.kind === 'return' && s.value) ref(s.value, bindings, loc);
        if (s.kind === 'if') {
          ref(s.condition.expression, bindings, loc);
          const branches = [{ condition: s.condition.expression, body: s.body }, ...s.elseIf.map((branch) => ({ condition: branch.condition.expression, body: branch.body }))];
          let selected: Statement[] | undefined;
          let staticallySelected = true;
          for (const branch of branches) {
            const value = metadataConstant(branch.condition);
            if (value === true) { selected = branch.body; break; }
            if (value !== false) { staticallySelected = false; break; }
          }
          if (staticallySelected) {
            if (selected === undefined) selected = s.otherwise;
            const selectedBindings = new Map(bindings);
            walk(selected, selectedBindings, loc, selectedBindings, declarationLoc);
            for (const [name, entry] of selectedBindings) bindings.set(name, entry);
            continue;
          }
          const branchBindings = [s.body, ...s.elseIf.map(branch => branch.body), s.otherwise].map((body) => {
            const branch = new Map(bindings);
            walk(body, branch, loc, branch, declarationLoc);
            return branch;
          });
          if (!s.otherwise.length) branchBindings.push(new Map(bindings));
          mergeBranchBindings(bindings, branchBindings);
        }
        if (s.kind === 'while') {
          ref(s.condition.expression, bindings, loc);
          if (metadataConstant(s.condition.expression) === false) continue;
          const loopBindings = new Map(bindings);
          walk(s.body, loopBindings, loc, loopBindings, declarationLoc);
        }
        if (s.kind === 'for') {
          [s.start, s.stop, s.step].forEach(e => ref(e, bindings, loc));
          const child = new Map(bindings), at: VariableLocation = { scope: 'local', container: `${loc.container}:for${++scopeId}`, line: s.nameLine, column: s.nameColumn, kind: 'definition' };
          declare(s.name, 'int', child, at); walk(s.body, child, at, child, declarationLoc);
          if (metadataForRuns(s) && !sourceBlockExits(s.body)) {
            for (const [name, entry] of child) if (name !== s.name) bindings.set(name, entry);
          }
        }
        if (s.kind === 'forEach') {
          ref(s.iterable, bindings, loc);
          const child = new Map(bindings), at: VariableLocation = { scope: 'local', container: `${loc.container}:forEach${++scopeId}`, line: s.nameLine, column: s.nameColumn, kind: 'definition' };
          const visibleTypes = new Map([...bindings].map(([name, entry]) => [name, entry.type]));
          const iterableType = inferValueType(s.iterable, visibleTypes, script.functions);
          if (typeof iterableType === 'string' || iterableType.kind !== 'list') throw new CompileError('for-in iterable lost its checked list type');
          declare(s.name, iterableType.value, child, at); walk(s.body, child, at, child, declarationLoc);
        }
        if (s.kind === 'choice') {
          if (s.prompt) ref(s.prompt, bindings, loc);
          s.options.forEach(o => { ref(o.label, bindings, loc); walk(o.body, new Map(bindings), { scope: 'local', container: `${loc.container}:choice${++scopeId}` }); });
        }
      }
    };
    const globals: Bindings = new Map();
    for (const [name, type] of externalGlobals) {
      const entry: VariableEntry = { name, type, scope: 'global', definedIn: 'global', definitions: [], references: [], mutable: true };
      globals.set(name, entry);
      result.push(entry);
    }
    walk(script.globals, globals, { scope: 'global', container: 'global' });
    for (const fn of script.functions) {
      const bindings = new Map(globals), loc: VariableLocation = { scope: 'function', container: fn.name };
      fn.params.forEach(p => declare(p.name, p.type, bindings, { ...loc, line: p.line, column: p.column, kind: 'definition' })); walk(fn.body, bindings, loc);
    }
    script.scenes.forEach(s => walk(s.body, new Map(globals), { scope: 'scene', container: s.name }));
    return result;
  }

  statements(statements: Statement[]): Instruction[] {
    return statements.map((statement) => ({ ...this.statement(statement), file: statement.file, line: statement.line }));
  }

  function(fn: FunctionDef): Instruction {
    const body = this.statements(fn.body);
    return { op: 'function', name: fn.name, returnType: fn.returnType, params: fn.params, body };
  }

  private statement(statement: Statement): Instruction {
    switch (statement.kind) {
      case 'declare': {
        if (statement.type === 'infer') throw new CompileError(`変数 '${statement.name}' の型推論が完了していません`);
        return { op: 'declare', type: statement.type, name: statement.name, constant: statement.constant, initial: statement.initial && this.expr(statement.initial) };
      }
      case 'set': return { op: 'set', target: this.assignable(statement.target), value: this.expr(statement.value) };
      case 'unset': return { op: 'unset', target: this.assignable(statement.target) };
      case 'command': return { op: 'command', name: statement.name, args: statement.args.map((v) => this.expr(v)) };
      case 'if': return {
        op: 'if',
        condition: this.expr(statement.condition.expression),
        body: this.statements(statement.body),
        elseIf: statement.elseIf.map((branch) => ({ condition: this.expr(branch.condition.expression), body: this.statements(branch.body) })),
        otherwise: this.statements(statement.otherwise),
      };
      case 'for': return {
        op: 'for',
        name: statement.name,
        start: this.expr(statement.start),
        stop: this.expr(statement.stop),
        step: this.expr(statement.step),
        body: this.statements(statement.body),
      };
      case 'forEach': return { op: 'forEach', name: statement.name, iterable: this.expr(statement.iterable), body: this.statements(statement.body) };
      case 'while': return { op: 'while', condition: this.expr(statement.condition.expression), body: this.statements(statement.body) };
      case 'choice': return {
        op: 'choice',
        prompt: statement.prompt ? this.expr(statement.prompt) : undefined,
        options: statement.options.map((option) => ({ label: this.expr(option.label), body: this.statements(option.body) })),
      };
      case 'call': return { op: 'call', name: statement.name, args: statement.args.map((v) => this.expr(v)) };
      case 'return': return { op: 'return', value: statement.value && this.expr(statement.value) };
      case 'goto': return { op: 'goto', scene: statement.scene };
    }
  }

  private assignable(target: { kind: 'variable'; name: string } | { kind: 'index'; target: Expr; key: Expr }): CompiledExpr {
    return target.kind === 'variable' ? { kind: 'load', name: target.name } : this.expr(target);
  }

  private expr(expression: Expr): CompiledExpr {
    switch (expression.kind) {
      case 'float': return { kind: 'float', value: expression.value };
      case 'literal': return typeof expression.value === 'bigint' ? { kind: 'integer', value: expression.value.toString() } : expression;
      case 'variable': return { kind: 'load', name: expression.name };
      case 'index': return { kind: 'index', target: this.expr(expression.target), key: this.expr(expression.key) };
      case 'binary': return { kind: 'binary', operator: expression.operator, left: this.expr(expression.left), right: this.expr(expression.right) };
      case 'unary': return { kind: 'unary', operator: expression.operator, value: this.expr(expression.value) };
      case 'call': return { kind: 'call', name: expression.name, args: expression.args.map((v) => this.expr(v)) };
      case 'dict': return { kind: 'dict', entries: expression.entries.map((entry) => ({ key: entry.key, value: this.expr(entry.value) })) };
      case 'list': return { kind: 'list', items: expression.items.map(item => this.expr(item)) };
    }
  }
}
