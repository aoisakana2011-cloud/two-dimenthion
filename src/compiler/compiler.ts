import { Asset, Character, Expr, ExternalCharacter, FunctionDef, Script, Statement, ValueType } from '../parser';
import { assertAnalyzed } from '../checker/analyzer';

export type CompiledExpr =
  | { kind: 'integer'; value: string }
  | { kind: 'literal'; value: number | string | bigint }
  | { kind: 'load'; name: string }
  | { kind: 'index'; target: CompiledExpr; key: CompiledExpr }
  | { kind: 'binary'; operator: string; left: CompiledExpr; right: CompiledExpr }
  | { kind: 'unary'; operator: string; value: CompiledExpr }
  | { kind: 'call'; name: string; args: CompiledExpr[] }
  | { kind: 'dict'; entries: Array<{ key: string; value: CompiledExpr }> };

export type Instruction =
  | { op: 'declare'; type: ValueType; name: string; initial?: CompiledExpr; constant?: boolean }
  | { op: 'set'; target: CompiledExpr; value: CompiledExpr }
  | { op: 'unset'; target: CompiledExpr }
  | { op: 'command'; name: string; args: CompiledExpr[] }
  | { op: 'sayBlock'; speaker: CompiledExpr; lines: CompiledExpr[] }
  | { op: 'if'; condition: CompiledExpr; body: Instruction[]; elseIf: Array<{ condition: CompiledExpr; body: Instruction[] }>; otherwise: Instruction[] }
  | { op: 'for'; name: string; start: CompiledExpr; stop: CompiledExpr; step: CompiledExpr; body: Instruction[] }
  | { op: 'while'; condition: CompiledExpr; body: Instruction[] }
  | { op: 'choice'; prompt?: CompiledExpr; options: Array<{ label: CompiledExpr; body: Instruction[] }> }
  | { op: 'function'; name: string; returnType: ValueType; params: Array<{ type: ValueType; name: string }>; body: Instruction[] }
  | { op: 'call'; name: string; args: CompiledExpr[] }
  | { op: 'return'; value?: CompiledExpr }
  | { op: 'goto'; scene: string };

export interface CompiledCondition { expression: CompiledExpr; }
export interface CompiledScene { name: string; instructions: Instruction[]; }
export interface VariableLocation { file?: string; line?: number; column?: number; scope: 'global' | 'function' | 'scene' | 'local'; container: string; kind?: 'definition' | 'expression' | 'interpolation' | 'assignment'; }
export interface VariableEntry { name: string; type: ValueType; scope: 'global' | 'function' | 'scene' | 'local'; definedIn: string; definitions: VariableLocation[]; references: VariableLocation[]; mutable: boolean; }
export type CompiledCharacter = Omit<Character, 'properties'> & { external?: boolean };
export interface CompiledProgram { version: 2; assets: Asset[]; characters: CompiledCharacter[]; globals: Instruction[]; functions: Instruction[]; scenes: CompiledScene[]; variables: VariableEntry[]; }
export class CompileError extends Error {}

type ConstantValue = bigint | string | boolean;

function constantValue(expression: CompiledExpr | undefined, constants: Map<string, ConstantValue>): ConstantValue | undefined {
  if (!expression) return undefined;
  if (expression.kind === 'integer') return BigInt(expression.value);
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
  if (expression.operator === '+' && typeof left === 'string' && typeof right === 'string') return left + right;
  return undefined;
}

function visitExpressionCalls(expression: CompiledExpr | undefined, visit: (name: string) => void): void {
  if (!expression) return;
  if (expression.kind === 'call') { visit(expression.name); expression.args.forEach((argument) => visitExpressionCalls(argument, visit)); }
  if (expression.kind === 'binary') { visitExpressionCalls(expression.left, visit); visitExpressionCalls(expression.right, visit); }
  if (expression.kind === 'unary') visitExpressionCalls(expression.value, visit);
  if (expression.kind === 'index') { visitExpressionCalls(expression.target, visit); visitExpressionCalls(expression.key, visit); }
  if (expression.kind === 'dict') expression.entries.forEach((entry) => visitExpressionCalls(entry.value, visit));
}

function functionWrites(functions: Instruction[], globalNames: Set<string>): Map<string, Set<string>> {
  const direct = new Map<string, Set<string>>(), calls = new Map<string, Set<string>>();
  const walk = (instructions: Instruction[], writes: Set<string>, invoked: Set<string>): void => {
    for (const instruction of instructions) {
      if ((instruction.op === 'set' || instruction.op === 'unset') && instruction.target.kind === 'load' && globalNames.has(instruction.target.name)) writes.add(instruction.target.name);
      if (instruction.op === 'call') { invoked.add(instruction.name); instruction.args.forEach((argument) => visitExpressionCalls(argument, (name) => invoked.add(name))); }
      if (instruction.op === 'declare') visitExpressionCalls(instruction.initial, (name) => invoked.add(name));
      if (instruction.op === 'set') { visitExpressionCalls(instruction.target, (name) => invoked.add(name)); visitExpressionCalls(instruction.value, (name) => invoked.add(name)); }
      if (instruction.op === 'unset') visitExpressionCalls(instruction.target, (name) => invoked.add(name));
      if (instruction.op === 'command') instruction.args.forEach((argument) => visitExpressionCalls(argument, (name) => invoked.add(name)));
      if (instruction.op === 'sayBlock') { visitExpressionCalls(instruction.speaker, (name) => invoked.add(name)); instruction.lines.forEach((line) => visitExpressionCalls(line, (name) => invoked.add(name))); }
      if (instruction.op === 'return') visitExpressionCalls(instruction.value, (name) => invoked.add(name));
      if (instruction.op === 'if') {
        visitExpressionCalls(instruction.condition, (name) => invoked.add(name));
        walk(instruction.body, writes, invoked);
        instruction.elseIf.forEach((branch) => { visitExpressionCalls(branch.condition, (name) => invoked.add(name)); walk(branch.body, writes, invoked); });
        walk(instruction.otherwise, writes, invoked);
      }
      if (instruction.op === 'for') { visitExpressionCalls(instruction.start, (name) => invoked.add(name)); visitExpressionCalls(instruction.stop, (name) => invoked.add(name)); visitExpressionCalls(instruction.step, (name) => invoked.add(name)); walk(instruction.body, writes, invoked); }
      if (instruction.op === 'while') { visitExpressionCalls(instruction.condition, (name) => invoked.add(name)); walk(instruction.body, writes, invoked); }
      if (instruction.op === 'choice') { visitExpressionCalls(instruction.prompt, (name) => invoked.add(name)); instruction.options.forEach((option) => { visitExpressionCalls(option.label, (name) => invoked.add(name)); walk(option.body, writes, invoked); }); }
    }
  };
  for (const instruction of functions) {
    if (instruction.op !== 'function') continue;
    const writes = new Set<string>(), invoked = new Set<string>();
    walk(instruction.body, writes, invoked);
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

function optimizeInstructions(instructions: Instruction[], effects: Map<string, Set<string>>, constants = new Map<string, ConstantValue>()): Instruction[] {
  const output: Instruction[] = [];
  const invalidateCall = (name: string) => { for (const variable of effects.get(name) || []) constants.delete(variable); };
  const invalidateExpression = (expression: CompiledExpr | undefined) => visitExpressionCalls(expression, invalidateCall);
  const invalidateAssigned = (items: Instruction[]): void => {
    for (const item of items) {
      if ((item.op === 'set' || item.op === 'unset') && item.target.kind === 'load') constants.delete(item.target.name);
      if (item.op === 'call') { invalidateCall(item.name); item.args.forEach(invalidateExpression); }
      if (item.op === 'declare') constants.delete(item.name);
      if (item.op === 'declare') invalidateExpression(item.initial);
      if (item.op === 'set') { invalidateExpression(item.target); invalidateExpression(item.value); }
      if (item.op === 'unset') invalidateExpression(item.target);
      if (item.op === 'command') item.args.forEach(invalidateExpression);
      if (item.op === 'sayBlock') { invalidateExpression(item.speaker); item.lines.forEach(invalidateExpression); }
      if (item.op === 'return') invalidateExpression(item.value);
      if (item.op === 'if') { invalidateExpression(item.condition); invalidateAssigned(item.body); item.elseIf.forEach((branch) => { invalidateExpression(branch.condition); invalidateAssigned(branch.body); }); invalidateAssigned(item.otherwise); }
      if (item.op === 'for') { invalidateExpression(item.start); invalidateExpression(item.stop); invalidateExpression(item.step); invalidateAssigned(item.body); }
      if (item.op === 'while') { invalidateExpression(item.condition); invalidateAssigned(item.body); }
      if (item.op === 'choice') { invalidateExpression(item.prompt); item.options.forEach((option) => { invalidateExpression(option.label); invalidateAssigned(option.body); }); }
    }
  };
  for (const instruction of instructions) {
    if (instruction.op === 'declare') {
      const value = constantValue(instruction.initial, constants);
      if (value === undefined) constants.delete(instruction.name); else constants.set(instruction.name, value);
      invalidateExpression(instruction.initial);
      output.push(instruction);
      continue;
    }
    if (instruction.op === 'set') {
      if (instruction.target.kind === 'load') {
        const value = constantValue(instruction.value, constants);
        if (value === undefined) constants.delete(instruction.target.name); else constants.set(instruction.target.name, value);
      } else if (instruction.target.kind === 'index' && instruction.target.target.kind === 'load') constants.delete(instruction.target.target.name);
      invalidateExpression(instruction.target); invalidateExpression(instruction.value);
      output.push(instruction);
      continue;
    }
    if (instruction.op === 'unset') {
      if (instruction.target.kind === 'load') constants.delete(instruction.target.name);
      else if (instruction.target.kind === 'index' && instruction.target.target.kind === 'load') constants.delete(instruction.target.target.name);
      invalidateExpression(instruction.target);
      output.push(instruction);
      continue;
    }
    if (instruction.op === 'call') {
      instruction.args.forEach(invalidateExpression);
      invalidateCall(instruction.name);
      output.push(instruction);
      continue;
    }
    if (instruction.op === 'if') {
      invalidateExpression(instruction.condition);
      instruction.elseIf.forEach((branch) => invalidateExpression(branch.condition));
      const first = constantValue(instruction.condition, constants);
      if (first === true) {
        output.push(...optimizeInstructions(instruction.body, effects, constants));
        continue;
      }
      if (first === false) {
        let selected: Instruction[] | undefined;
        let unknown = false;
        for (const branch of instruction.elseIf) {
          const value = constantValue(branch.condition, constants);
          if (value === true) { selected = branch.body; break; }
          if (value !== false) { unknown = true; break; }
        }
        if (!unknown) {
          output.push(...optimizeInstructions(selected || instruction.otherwise, effects, constants));
          continue;
        }
      }
      const optimized: Instruction = {
        ...instruction,
        body: optimizeInstructions(instruction.body, effects, new Map(constants)),
        elseIf: instruction.elseIf.map((branch) => ({ ...branch, body: optimizeInstructions(branch.body, effects, new Map(constants)) })),
        otherwise: optimizeInstructions(instruction.otherwise, effects, new Map(constants)),
      };
      output.push(optimized);
      invalidateExpression(instruction.condition);
      instruction.elseIf.forEach((branch) => invalidateExpression(branch.condition));
      invalidateAssigned([instruction]);
      continue;
    }
    if (instruction.op === 'for' || instruction.op === 'while') {
      if (instruction.op === 'for') { invalidateExpression(instruction.start); invalidateExpression(instruction.stop); invalidateExpression(instruction.step); }
      else invalidateExpression(instruction.condition);
      invalidateAssigned(instruction.body);
      const loopConstants = new Map(constants);
      if (instruction.op === 'for') loopConstants.delete(instruction.name);
      output.push({ ...instruction, body: optimizeInstructions(instruction.body, effects, loopConstants) });
      continue;
    }
    if (instruction.op === 'choice') {
      invalidateExpression(instruction.prompt); instruction.options.forEach((option) => invalidateExpression(option.label));
      output.push({ ...instruction, options: instruction.options.map((option) => ({ ...option, body: optimizeInstructions(option.body, effects, new Map(constants)) })) });
      instruction.options.forEach((option) => invalidateAssigned(option.body));
      invalidateExpression(instruction.prompt); instruction.options.forEach((option) => invalidateExpression(option.label));
      continue;
    }
    if (instruction.op === 'command') instruction.args.forEach(invalidateExpression);
    if (instruction.op === 'sayBlock') { invalidateExpression(instruction.speaker); instruction.lines.forEach(invalidateExpression); }
    if (instruction.op === 'return') invalidateExpression(instruction.value);
    output.push(instruction);
  }
  return output;
}

const characterTypeName = (name: string) => `character:${name}`;
function characterDeclarations(script: Script): Statement[] {
  return script.characters.map((character) => ({
    kind: 'declare', name: character.name, type: { kind: 'struct', name: characterTypeName(character.name) },
    initial: { kind: 'dict', entries: character.properties.map((property) => ({ key: property.name, value: property.value })) },
    line: character.line, column: character.column,
  }));
}

export function compile(script: Script, externalGlobals = new Map<string, ValueType>(), externalCharacters = new Map<string, Set<string> | ExternalCharacter>()): CompiledProgram {
  assertAnalyzed(script, 'current', externalGlobals, externalCharacters);
  const compiler = new Compiler();
  const implicitCharacterGlobals = characterDeclarations(script);
  const runtimeScript = { ...script, globals: [...implicitCharacterGlobals, ...script.globals] };
  const metadataGlobals = new Map(externalGlobals);
  for (const name of externalCharacters.keys()) metadataGlobals.set(name, { kind: 'struct', name: characterTypeName(name) });
  const variables = compiler.variables(runtimeScript, metadataGlobals);
  const rawGlobals = compiler.statements(runtimeScript.globals);
  const rawFunctions = script.functions.map((fn) => compiler.function(fn));
  const effects = functionWrites(rawFunctions, new Set([...externalGlobals.keys(), ...runtimeScript.globals.filter((statement) => statement.kind === 'declare').map((statement) => statement.name)]));
  const globals = optimizeInstructions(rawGlobals, effects);
  const functions = rawFunctions.map((instruction) => instruction.op === 'function'
    ? { ...instruction, body: optimizeInstructions(instruction.body, effects) }
    : instruction);
  const externalCharacterDefinitions = [...externalCharacters.values()]
    .filter((character): character is ExternalCharacter => !(character instanceof Set))
    .flatMap((character) => character.definition ? [character.definition] : [])
    .map(({ properties: _properties, ...character }) => ({ ...character, external: true }));

  return {
    version: 2,
    assets: script.assets,
    characters: [...externalCharacterDefinitions, ...script.characters.map(({ properties: _properties, ...character }) => character)],
    globals,
    functions,
    scenes: script.scenes.map((scene) => ({ name: scene.name, instructions: optimizeInstructions(compiler.statements(scene.body), effects) })),
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
      if (e.kind === 'literal' && typeof e.value === 'string') for (const m of e.value.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\}/g)) bindings.get(m[1].split('.')[0])?.references.push({ ...loc, line: e.line, column: e.column, kind: 'interpolation' });
      if (e.kind === 'binary') { ref(e.left, bindings, loc); ref(e.right, bindings, loc); }
      if (e.kind === 'unary') ref(e.value, bindings, loc);
      if (e.kind === 'index') { ref(e.target, bindings, loc); ref(e.key, bindings, loc); }
      if (e.kind === 'dict') e.entries.forEach(x => ref(x.value, bindings, loc));
      if (e.kind === 'call') e.args.forEach(x => ref(x, bindings, loc));
    };
    let scopeId = 0;
    const walk = (list: Statement[], bindings: Bindings, loc: VariableLocation, declarations = bindings, declarationLoc = loc) => {
      for (const s of list) {
        if (s.kind === 'declare') { if (s.initial) ref(s.initial, bindings, loc); if (s.type === 'infer') throw new CompileError(`変数 '${s.name}' の型推論が完了していません`); declare(s.name, s.type, declarations, { ...declarationLoc, line: s.line, column: s.column, kind: 'definition' }); const entry = declarations.get(s.name)!; entry.mutable = !s.constant; bindings.set(s.name, entry); }
        if (s.kind === 'set') {
          if (s.target.kind === 'variable') ref(s.target, bindings, { ...loc, kind: 'assignment' });
          else { ref(s.target.target, bindings, loc); ref(s.target.key, bindings, loc); }
          ref(s.value, bindings, loc);
        }
        if (s.kind === 'unset') ref(s.target, bindings, loc);
        if (s.kind === 'command' || s.kind === 'call') s.args.forEach(e => ref(e, bindings, loc));
        if (s.kind === 'sayBlock') { ref(s.speaker, bindings, loc); s.lines.forEach(e => ref(e, bindings, loc)); }
        if (s.kind === 'return' && s.value) ref(s.value, bindings, loc);
        if (s.kind === 'if') {
          ref(s.condition.expression, bindings, loc); walk(s.body, bindings, loc, declarations, declarationLoc);
          s.elseIf.forEach(b => { ref(b.condition.expression, bindings, loc); walk(b.body, bindings, loc, declarations, declarationLoc); });
          walk(s.otherwise, bindings, loc, declarations, declarationLoc);
        }
        if (s.kind === 'while') { ref(s.condition.expression, bindings, loc); walk(s.body, bindings, loc, declarations, declarationLoc); }
        if (s.kind === 'for') {
          [s.start, s.stop, s.step].forEach(e => ref(e, bindings, loc));
          const child = new Map(bindings), at: VariableLocation = { scope: 'local', container: `${loc.container}:for${++scopeId}` };
          declare(s.name, 'int', child, at); walk(s.body, child, at, declarations, declarationLoc);
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
      fn.params.forEach(p => declare(p.name, p.type, bindings, loc)); walk(fn.body, bindings, loc);
    }
    script.scenes.forEach(s => walk(s.body, new Map(globals), { scope: 'scene', container: s.name }));
    return result;
  }

  statements(statements: Statement[]): Instruction[] {
    return statements.map((statement) => this.statement(statement));
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
      case 'sayBlock': return { op: 'sayBlock', speaker: this.expr(statement.speaker), lines: statement.lines.map((v) => this.expr(v)) };
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
      case 'literal': return typeof expression.value === 'bigint' ? { kind: 'integer', value: expression.value.toString() } : expression;
      case 'variable': return { kind: 'load', name: expression.name };
      case 'index': return { kind: 'index', target: this.expr(expression.target), key: this.expr(expression.key) };
      case 'binary': return { kind: 'binary', operator: expression.operator, left: this.expr(expression.left), right: this.expr(expression.right) };
      case 'unary': return { kind: 'unary', operator: expression.operator, value: this.expr(expression.value) };
      case 'call': return { kind: 'call', name: expression.name, args: expression.args.map((v) => this.expr(v)) };
      case 'dict': return { kind: 'dict', entries: expression.entries.map((entry) => ({ key: entry.key, value: this.expr(entry.value) })) };
    }
  }
}
