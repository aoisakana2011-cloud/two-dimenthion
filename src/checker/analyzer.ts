import { Expr, FunctionDef, NodeLocation, Script, Statement, ValueType } from '../parser';
import { checkTypes } from './type-checker';

export type DiagnosticSeverity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  code: string;
  severity: DiagnosticSeverity;
  message: string;
  file: string;
  line: number;
  column: number;
}

type Constant = bigint | string | boolean | undefined;
const INT_MIN = -(1n << 63n);
const INT_MAX = (1n << 63n) - 1n;

function at(node?: NodeLocation): Pick<Diagnostic, 'line' | 'column'> {
  return { line: node?.line ?? 1, column: node?.column ?? 1 };
}

function diagnostic(file: string, code: string, severity: DiagnosticSeverity, message: string, node?: NodeLocation): Diagnostic {
  return { code, severity, message, file, ...at(node) };
}

function errorDiagnostic(error: unknown, file: string): Diagnostic {
  const message = error instanceof Error ? error.message : String(error);
  const line = Number(message.match(/(?:at )?line\s+(\d+)/i)?.[1] || 1);
  const column = Number(message.match(/column\s+(\d+)/i)?.[1] || 1);
  return { code: error instanceof SyntaxError ? 'syntax-error' : 'type-error', severity: 'error', message, file, line, column };
}

function integer(value: number | bigint): bigint | undefined {
  if (typeof value === 'bigint') return value;
  return Number.isSafeInteger(value) ? BigInt(value) : undefined;
}

function constant(expr: Expr): Constant {
  if (expr.kind === 'literal') return typeof expr.value === 'string' ? expr.value : integer(expr.value);
  if (expr.kind === 'unary') {
    const value = constant(expr.value);
    if (expr.operator === 'not' && typeof value === 'boolean') return !value;
    if ((expr.operator === '+' || expr.operator === '-') && typeof value === 'bigint') return expr.operator === '-' ? -value : value;
    return undefined;
  }
  if (expr.kind !== 'binary') return undefined;
  const left = constant(expr.left);
  if (expr.operator === 'and' && typeof left === 'boolean') return left ? constant(expr.right) : false;
  if (expr.operator === 'or' && typeof left === 'boolean') return left ? true : constant(expr.right);
  const right = constant(expr.right);
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
  if (expr.operator === '+' && typeof left === 'string' && typeof right === 'string') return left + right;
  return undefined;
}

function expressionKey(expr: Expr): string {
  if (expr.kind === 'literal') return `literal:${String(expr.value)}`;
  if (expr.kind === 'variable') return `variable:${expr.name}`;
  if (expr.kind === 'unary') return `${expr.operator}(${expressionKey(expr.value)})`;
  if (expr.kind === 'binary') return `(${expressionKey(expr.left)}${expr.operator}${expressionKey(expr.right)})`;
  if (expr.kind === 'index') return `${expressionKey(expr.target)}[${expressionKey(expr.key)}]`;
  if (expr.kind === 'call') return `${expr.name}(${expr.args.map(expressionKey).join(',')})`;
  return `{${expr.entries.map((entry) => `${entry.key}:${expressionKey(entry.value)}`).join(',')}}`;
}

function visitExpressions(expr: Expr, visit: (expr: Expr) => void): void {
  visit(expr);
  if (expr.kind === 'binary') { visitExpressions(expr.left, visit); visitExpressions(expr.right, visit); }
  if (expr.kind === 'unary') visitExpressions(expr.value, visit);
  if (expr.kind === 'index') { visitExpressions(expr.target, visit); visitExpressions(expr.key, visit); }
  if (expr.kind === 'call') expr.args.forEach((arg) => visitExpressions(arg, visit));
  if (expr.kind === 'dict') expr.entries.forEach((entry) => visitExpressions(entry.value, visit));
}

function statementExpressions(statement: Statement): Expr[] {
  if (statement.kind === 'declare') return statement.initial ? [statement.initial] : [];
  if (statement.kind === 'set') return [statement.value, statement.target];
  if (statement.kind === 'unset') return [statement.target];
  if (statement.kind === 'command' || statement.kind === 'call') return statement.args;
  if (statement.kind === 'sayBlock') return [statement.speaker, ...statement.lines];
  if (statement.kind === 'if' || statement.kind === 'while') return [statement.condition.expression];
  if (statement.kind === 'for') return [statement.start, statement.stop, statement.step];
  if (statement.kind === 'choice') return [...(statement.prompt ? [statement.prompt] : []), ...statement.options.map((option) => option.label)];
  if (statement.kind === 'return') return statement.value ? [statement.value] : [];
  return [];
}

function nested(statement: Statement): Statement[][] {
  if (statement.kind === 'if') return [statement.body, ...statement.elseIf.map((branch) => branch.body), statement.otherwise];
  if (statement.kind === 'for' || statement.kind === 'while') return [statement.body];
  if (statement.kind === 'choice') return statement.options.map((option) => option.body);
  return [];
}

function definitelyTerminates(statement: Statement): boolean {
  if (statement.kind === 'return' || statement.kind === 'goto') return true;
  if (statement.kind === 'if') {
    const branches = [{ condition: statement.condition.expression, body: statement.body }, ...statement.elseIf.map((branch) => ({ condition: branch.condition.expression, body: branch.body }))];
    let allTerminate = true;
    let canFallThrough = true;
    for (const branch of branches) {
      if (!canFallThrough) break;
      const value = constant(branch.condition);
      if (value === false) continue;
      allTerminate = allTerminate && blockTerminates(branch.body);
      if (value === true) canFallThrough = false;
    }
    if (canFallThrough) {
      if (!statement.otherwise.length) return false;
      allTerminate = allTerminate && blockTerminates(statement.otherwise);
    }
    return allTerminate;
  }
  if (statement.kind === 'while') return constant(statement.condition.expression) === true;
  if (statement.kind === 'choice') return statement.options.length > 0 && statement.options.every((option) => blockTerminates(option.body));
  return false;
}

function blockTerminates(statements: Statement[]): boolean {
  return statements.some(definitelyTerminates);
}

function analyzeExpression(expr: Expr, file: string, out: Diagnostic[]): void {
  const walk = (current: Expr, parent?: Expr): void => {
    if (current.kind === 'binary') {
      const right = constant(current.right);
      if ((current.operator === '/' || current.operator === '%') && right === 0n) {
        out.push(diagnostic(file, 'division-by-zero', 'warning', '0 による除算または剰余は実行時エラーになります', current));
      }
    }
    const value = constant(current);
    const minimumMagnitude = current.kind === 'literal' && value === INT_MAX + 1n && parent?.kind === 'unary' && parent.operator === '-';
    if (typeof value === 'bigint' && (value < INT_MIN || value > INT_MAX) && !minimumMagnitude) {
      out.push(diagnostic(file, 'integer-overflow', 'error', '定数式で64bit整数オーバーフローが発生します', current));
    }
    if (current.kind === 'binary') { walk(current.left, current); walk(current.right, current); }
    if (current.kind === 'unary') walk(current.value, current);
    if (current.kind === 'index') { walk(current.target, current); walk(current.key, current); }
    if (current.kind === 'call') current.args.forEach((arg) => walk(arg, current));
    if (current.kind === 'dict') current.entries.forEach((entry) => walk(entry.value, current));
  };
  walk(expr);
}

function analyzeBlock(statements: Statement[], file: string, out: Diagnostic[], reachable = true): void {
  let canReach = reachable;
  for (const statement of statements) {
    if (!canReach) out.push(diagnostic(file, 'unreachable-code', 'warning', 'この文には到達できません', statement));
    statementExpressions(statement).forEach((expr) => analyzeExpression(expr, file, out));

    if (statement.kind === 'set' && statement.target.kind === 'variable' && statement.value.kind === 'variable' && statement.target.name === statement.value.name) {
      out.push(diagnostic(file, 'self-assignment', 'warning', `変数 '${statement.target.name}' を同じ値で上書きしています`, statement));
    }
    if (statement.kind === 'if') {
      const branches = [{ expression: statement.condition.expression, body: statement.body }, ...statement.elseIf.map((branch) => ({ expression: branch.condition.expression, body: branch.body }))];
      const seen = new Set<string>();
      let previousAlways = false;
      for (const branch of branches) {
        const key = expressionKey(branch.expression);
        const value = constant(branch.expression);
        if (seen.has(key)) out.push(diagnostic(file, 'duplicate-condition', 'warning', '前の分岐と同じ条件なので、この分岐には到達できません', branch.expression));
        if (previousAlways) out.push(diagnostic(file, 'unreachable-branch', 'warning', '前の条件が常に真なので、この分岐には到達できません', branch.expression));
        else if (value === false) out.push(diagnostic(file, 'constant-condition', 'warning', '条件は常に偽です。この分岐には到達できません', branch.expression));
        else if (value === true) out.push(diagnostic(file, 'constant-condition', 'info', '条件は常に真です。後続の分岐は実行されません', branch.expression));
        analyzeBlock(branch.body, file, out, canReach && !previousAlways && value !== false && !seen.has(key));
        seen.add(key);
        if (value === true) previousAlways = true;
      }
      if (statement.otherwise.length) analyzeBlock(statement.otherwise, file, out, canReach && !previousAlways);
      if (previousAlways && statement.otherwise.length) out.push(diagnostic(file, 'unreachable-branch', 'warning', '前の条件が常に真なので、else には到達できません', statement.otherwise[0]));
    } else if (statement.kind === 'while') {
      const value = constant(statement.condition.expression);
      if (value === false) out.push(diagnostic(file, 'constant-condition', 'warning', 'while の条件は常に偽です。ループ本体には到達できません', statement.condition));
      if (value === true) out.push(diagnostic(file, 'infinite-loop', 'warning', 'while の条件は常に真で、ループを抜ける文がありません', statement.condition));
      analyzeBlock(statement.body, file, out, canReach && value !== false);
    } else {
      for (const body of nested(statement)) analyzeBlock(body, file, out, canReach);
    }
    if (canReach && definitelyTerminates(statement)) canReach = false;
  }
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
          for (const match of current.value.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) used.add(match[1]);
        }
      });
      nested(statement).forEach(walk);
    }
  };
  walk(fn.body);
  for (const [name, loc] of declared) if (!used.has(name)) out.push(diagnostic(file, 'unused-variable', 'warning', `変数または引数 '${name}' は使用されていません`, loc));
}

export function analyzeScript(script: Script, file = 'current', externalGlobals = new Map<string, ValueType>(), externalCharacters = new Map<string, Set<string>>()): Diagnostic[] {
  const out: Diagnostic[] = [];
  try {
    checkTypes(script, file, externalGlobals, externalCharacters);
  } catch (error) {
    out.push(errorDiagnostic(error, file));
  }
  analyzeBlock(script.globals, file, out);
  for (const fn of script.functions) {
    analyzeBlock(fn.body, file, out);
    analyzeUnused(fn, file, out);
    if (fn.returnType !== 'none' && !blockTerminates(fn.body)) {
      out.push(diagnostic(file, 'missing-return', 'error', `関数 '${fn.name}' はすべての経路で値を返していません`, fn));
    }
  }
  script.scenes.forEach((scene) => analyzeBlock(scene.body, file, out));
  return out.sort((a, b) => a.line - b.line || a.column - b.column || ({ error: 0, warning: 1, info: 2 }[a.severity] - { error: 0, warning: 1, info: 2 }[b.severity]));
}

export function assertAnalyzed(script: Script, file = 'current', externalGlobals = new Map<string, ValueType>(), externalCharacters = new Map<string, Set<string>>()): Diagnostic[] {
  const diagnostics = analyzeScript(script, file, externalGlobals, externalCharacters);
  const first = diagnostics.find((item) => item.severity === 'error');
  if (first) throw new Error(`line ${first.line}, column ${first.column}: ${first.message}`);
  return diagnostics;
}
