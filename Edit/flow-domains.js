'use strict';

// Bounded, branch-sensitive value sets for a Scene Flow debug start point.
// null is TOP: never turn an unsupported operation into a claimed exact value.
const LIMIT = 32;
const INT_MIN = -(1n << 63n);
const INT_MAX = (1n << 63n) - 1n;
const key = (value) => JSON.stringify(value, (_name, item) => typeof item === 'bigint' ? `#int:${item}` : item);
const unique = (values) => [...new Map(values.map((value) => [key(value), value])).values()];
const domain = (values) => values === null || values.length > LIMIT ? null : unique(values);
const union = (left, right) => left === null || right === null ? null : domain([...left, ...right]);
const single = (value) => [value];
const copy = (state) => new Map(state);
const get = (state, name) => state.has(name) ? state.get(name) : null;
const put = (state, name, value) => { const next = copy(state); next.set(name, value); return next; };
const withinInt = (value) => typeof value !== 'bigint' || value >= INT_MIN && value <= INT_MAX;

function combine(left, right, operation) {
  if (left === null || right === null || left.length * right.length > LIMIT) return null;
  const values = [];
  for (const a of left) for (const b of right) {
    try { const result = operation(a, b); if (!withinInt(result)) return null; values.push(result); }
    catch { return null; }
  }
  return domain(values);
}

function updateObject(state, target, value, remove = false, context = null) {
  let root = target;
  while (root?.kind === 'index') root = root.target;
  if (root?.kind !== 'variable' || target.kind !== 'index' || target.target.kind !== 'variable') return null;
  const objects = get(state, root.name), keys = evaluate(target.key, state, context);
  if (objects === null || keys === null || value === null || objects.length * keys.length * value.length > LIMIT) return null;
  const results = [];
  for (const object of objects) for (const field of keys) for (const item of value) {
    if (!object || typeof object !== 'object' || Array.isArray(object)) return null;
    const next = { ...object };
    if (remove) {
      if (!Object.hasOwn(next, field)) return null;
      delete next[field];
    } else next[field] = item;
    results.push(next);
  }
  return domain(results);
}

function evaluate(expr, state, context = null) {
  if (!expr) return null;
  if (expr.kind === 'literal') return single(typeof expr.value === 'number' ? BigInt(expr.value) : expr.value);
  if (expr.kind === 'variable') return get(state, expr.name);
  if (expr.kind === 'dict') {
    let values = [{}];
    for (const entry of expr.entries) {
      const item = evaluate(entry.value, state, context);
      if (item === null || values.length * item.length > LIMIT) return null;
      values = values.flatMap((object) => item.map((value) => ({ ...object, [entry.key]: value })));
    }
    return domain(values);
  }
  if (expr.kind === 'index') return combine(evaluate(expr.target, state, context), evaluate(expr.key, state, context), (object, name) => {
    if (!object || typeof object !== 'object' || !Object.hasOwn(object, name)) throw Error('unknown index');
    return object[name];
  });
  if (expr.kind === 'call') {
    if ((expr.name === 'str' || expr.name === 'int') && expr.args.length === 1) {
      const args = evaluate(expr.args[0], state, context);
      if (args === null) return null;
      try { return domain(args.map((item) => expr.name === 'str' ? String(item) : BigInt(item))); } catch { return null; }
    }
    const fn = context?.functions.get(expr.name), effect = context?.effects.get(expr.name);
    if (!fn || !effect || effect.unknown || effect.writes.size || expr.args.length !== fn.params.length
      || context.stack.includes(fn.name) || context.stack.length >= 8) return null;
    const args = expr.args.map((argument) => evaluate(argument, state, context));
    if (args.some((values) => values === null) || args.reduce((size, values) => size * values.length, 1) > LIMIT) return null;
    const localNames = new Set(fn.params.map((param) => param.name));
    for (const statement of fn.body) if (statement.kind === 'declare') localNames.add(statement.name);
    // Only interpret straight-line local calculations ending in one return.
    // Any control flow, global write, or unsupported statement remains unknown.
    if (!fn.body.length || fn.body.at(-1).kind !== 'return'
      || fn.body.slice(0, -1).some((statement) => !['declare', 'set'].includes(statement.kind))) return null;
    const nextContext = { ...context, stack: [...context.stack, fn.name] };
    const returned = [];
    const combinations = args.reduce((all, values) => all.flatMap((prefix) => values.map((value) => [...prefix, value])), [[]]);
    for (const combination of combinations) {
      let local = copy(state);
      fn.params.forEach((param, index) => { local = put(local, param.name, single(combination[index])); });
      let valid = true;
      for (const statement of fn.body.slice(0, -1)) {
        if (statement.kind === 'declare') {
          local = put(local, statement.name, statement.initial ? evaluate(statement.initial, local, nextContext)
            : single(statement.type === 'int' ? 0n : statement.type === 'str' ? '' : {}));
        } else if (statement.target?.kind === 'variable' && localNames.has(statement.target.name)) {
          local = put(local, statement.target.name, evaluate(statement.value, local, nextContext));
        } else { valid = false; break; }
        if (local.get(statement.kind === 'declare' ? statement.name : statement.target?.name) === null) { valid = false; break; }
      }
      if (!valid) return null;
      const value = evaluate(fn.body.at(-1).value, local, nextContext);
      if (value === null) return null;
      returned.push(...value);
    }
    return domain(returned);
  }
  if (expr.kind === 'unary') {
    const values = evaluate(expr.value, state, context);
    if (values === null) return null;
    try { const result = values.map((item) => expr.operator === 'not' ? !item : expr.operator === '-' ? -item : item); return result.every(withinInt) ? domain(result) : null; }
    catch { return null; }
  }
  if (expr.kind !== 'binary') return null;
  const left = evaluate(expr.left, state, context), right = evaluate(expr.right, state, context);
  if (expr.operator === 'and') return combine(left, right, (a, b) => Boolean(a && b));
  if (expr.operator === 'or') return combine(left, right, (a, b) => Boolean(a || b));
  return combine(left, right, (a, b) => {
    switch (expr.operator) {
      case '+': return a + b;
      case '-': return a - b;
      case '*': return a * b;
      case '/': if (b === 0n) throw Error('division by zero'); return a / b;
      case '%': if (b === 0n) throw Error('division by zero'); return a % b;
      case '==': return key(a) === key(b);
      case '!=': return key(a) !== key(b);
      case '>': return a > b;
      case '>=': return a >= b;
      case '<': return a < b;
      case '<=': return a <= b;
      default: throw Error('unsupported operator');
    }
  });
}

function mergeStates(states) {
  if (states.length <= LIMIT) return states;
  const merged = new Map();
  const names = new Set(states.flatMap((state) => [...state.keys()]));
  for (const name of names) merged.set(name, states.reduce((values, state) => union(values, get(state, name)), []));
  return [merged];
}

function split(state, condition, context = null) {
  const expr = condition.expression || condition;
  if (expr.kind === 'unary' && expr.operator === 'not') {
    const [yes, no] = split(state, expr.value, context); return [no, yes];
  }
  if (expr.kind === 'binary' && expr.operator === 'and') {
    const [leftYes, leftNo] = split(state, expr.left, context);
    const right = leftYes.map((item) => split(item, expr.right, context));
    return [right.flatMap((item) => item[0]), mergeStates([...leftNo, ...right.flatMap((item) => item[1])])];
  }
  if (expr.kind === 'binary' && expr.operator === 'or') {
    const [leftYes, leftNo] = split(state, expr.left, context);
    const right = leftNo.map((item) => split(item, expr.right, context));
    return [mergeStates([...leftYes, ...right.flatMap((item) => item[0])]), right.flatMap((item) => item[1])];
  }
  const equality = expr.kind === 'binary' && ['==', '!='].includes(expr.operator)
    ? expr.left.kind === 'variable' && expr.right.kind === 'literal' ? [expr.left.name, expr.right.value]
      : expr.right.kind === 'variable' && expr.left.kind === 'literal' ? [expr.right.name, expr.left.value] : null : null;
  if (equality && get(state, equality[0]) === null) {
    const value = typeof equality[1] === 'number' ? BigInt(equality[1]) : equality[1];
    const exact = put(state, equality[0], single(value));
    return expr.operator === '==' ? [[exact], [state]] : [[state], [exact]];
  }
  // Split a finite variable set before testing, preserving condition/value correlation.
  const names = new Set();
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.kind === 'variable') names.add(node.name);
    for (const value of Object.values(node)) if (value && typeof value === 'object') {
      if (Array.isArray(value)) value.forEach(visit); else visit(value);
    }
  };
  visit(expr);
  let variants = [state];
  for (const name of names) {
    const values = get(state, name);
    if (values === null || variants.length * values.length > LIMIT) continue;
    variants = variants.flatMap((item) => values.map((value) => put(item, name, single(value))));
  }
  const yes = [], no = [];
  for (const variant of variants) {
    const result = evaluate(expr, variant, context);
    if (result === null) { yes.push(variant); no.push(variant); }
    else {
      if (result.some(Boolean)) yes.push(variant);
      if (result.some((value) => !value)) no.push(variant);
    }
  }
  return [yes, no];
}

function writes(statements, out = new Set()) {
  for (const statement of statements || []) {
    if (statement.kind === 'set' || statement.kind === 'unset') {
      let target = statement.target;
      while (target?.kind === 'index') target = target.target;
      if (target?.kind === 'variable') out.add(target.name);
    }
    if (statement.kind === 'declare' || statement.kind === 'for') out.add(statement.name);
    if (statement.kind === 'if') {
      writes(statement.body, out); statement.elseIf.forEach((branch) => writes(branch.body, out)); writes(statement.otherwise, out);
    } else if (statement.kind === 'choice') statement.options.forEach((option) => writes(option.body, out));
    else if (statement.kind === 'for' || statement.kind === 'while') writes(statement.body, out);
  }
  return out;
}

function hasUserCall(expr) {
  if (!expr || typeof expr !== 'object') return false;
  if (expr.kind === 'call' && expr.name !== 'str' && expr.name !== 'int') return true;
  return Object.values(expr).some((value) => Array.isArray(value) ? value.some(hasUserCall) : value && typeof value === 'object' && hasUserCall(value));
}

function functionWriteEffects(script) {
  const functions = new Map((script.functions || []).map((fn) => [fn.name, fn]));
  const effects = new Map();
  for (const fn of functions.values()) {
    const locals = new Set(fn.params.map((param) => param.name));
    for (const statement of fn.body) if (statement.kind === 'declare') locals.add(statement.name);
    const writes = new Set();
    const calls = new Set();
    let unknown = false;
    const visitExpr = (expr) => {
      if (!expr || typeof expr !== 'object') return;
      if (expr.kind === 'call' && expr.name !== 'str' && expr.name !== 'int') calls.add(expr.name);
      if (expr.kind === 'literal' && typeof expr.value === 'string') {
        for (const match of expr.value.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\(\)\}/g)) calls.add(match[1]);
      }
      for (const value of Object.values(expr)) {
        if (Array.isArray(value)) value.forEach(visitExpr);
        else if (value && typeof value === 'object') visitExpr(value);
      }
    };
    const visitBlock = (block) => {
      for (const statement of block || []) {
        if (statement.kind === 'set' || statement.kind === 'unset') {
          let target = statement.target;
          while (target?.kind === 'index') target = target.target;
          if (target?.kind === 'variable') writes.add(target.name);
        }
        if (statement.kind === 'call') calls.add(statement.name);
        if (statement.kind === 'command' && statement.name === 'say'
          && (statement.args[1]?.kind !== 'literal' || typeof statement.args[1].value !== 'string'
            || /\{[A-Za-z_][A-Za-z0-9_]*\(\)\}/.test(statement.args[1].value))) unknown = true;
        if (statement.kind === 'choice' && [statement.prompt, ...statement.options.map((option) => option.label)]
          .some((expr) => expr && (expr.kind !== 'literal' || typeof expr.value !== 'string' || /\{[A-Za-z_][A-Za-z0-9_]*\(\)\}/.test(expr.value)))) unknown = true;
        for (const expression of [statement.condition?.expression, statement.prompt, statement.initial, statement.value,
          statement.target, statement.start, statement.stop, statement.step, ...(statement.args || []),
          ...(statement.options || []).flatMap((option) => [option.label, ...[]]),
          ...(statement.elseIf || []).map((branch) => branch.condition?.expression)]) visitExpr(expression);
        if (statement.kind === 'if') {
          visitBlock(statement.body);
          statement.elseIf.forEach((branch) => visitBlock(branch.body));
          visitBlock(statement.otherwise);
        } else if (statement.kind === 'choice') statement.options.forEach((option) => visitBlock(option.body));
        else if (statement.kind === 'for' || statement.kind === 'while') visitBlock(statement.body);
      }
    };
    visitBlock(fn.body);
    locals.forEach((name) => writes.delete(name));
    effects.set(fn.name, { writes, calls, unknown: unknown || [...calls].some((name) => !functions.has(name)) });
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const effect of effects.values()) for (const called of effect.calls) {
      const dependency = effects.get(called);
      if (!dependency) { if (!effect.unknown) { effect.unknown = true; changed = true; } continue; }
      if (dependency.unknown && !effect.unknown) { effect.unknown = true; changed = true; }
      for (const name of dependency.writes) {
        if (!effect.writes.has(name)) { effect.writes.add(name); changed = true; }
      }
    }
  }
  return effects;
}

function mayCallInText(value, state, depth = 0) {
  if (depth > 4) return true;
  const source = typeof value === 'string' ? value : key(value);
  if (/\{[A-Za-z_][A-Za-z0-9_]*\(\)\}/.test(source)) return true;
  for (const match of source.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\}/g)) {
    const [name, ...fields] = match[1].split('.');
    const values = get(state, name);
    if (values === null) return true;
    for (let item of values) {
      for (const field of fields) {
        if (!item || typeof item !== 'object' || !Object.hasOwn(item, field)) return true;
        item = item[field];
      }
      if (mayCallInText(item, state, depth + 1)) return true;
    }
  }
  return false;
}

function taintCalls(statement, states, mutableNames, functionEffects, context) {
  const expressions = statement.kind === 'if' ? [statement.condition, ...statement.elseIf.map((branch) => branch.condition)]
    : statement.kind === 'choice' ? [statement.prompt, ...statement.options.map((option) => option.label)]
      : statement.kind === 'set' ? [statement.target, statement.value]
        : statement.kind === 'declare' ? [statement.initial]
          : statement.kind === 'for' ? [statement.start, statement.stop, statement.step]
            : statement.kind === 'while' ? [statement.condition]
              : statement.kind === 'command' || statement.kind === 'call' ? statement.args : [];
  const direct = statement.kind === 'call' || expressions.some(hasUserCall);
  const calls = new Set();
  const collectCalls = (expr) => {
    if (!expr || typeof expr !== 'object') return;
    if (expr.kind === 'call' && expr.name !== 'str' && expr.name !== 'int') calls.add(expr.name);
    for (const value of Object.values(expr)) {
      if (Array.isArray(value)) value.forEach(collectCalls);
      else if (value && typeof value === 'object') collectCalls(value);
    }
  };
  if (statement.kind === 'call') calls.add(statement.name);
  expressions.forEach(collectCalls);
  const rendered = statement.kind === 'command' && statement.name === 'say' ? [statement.args[1]]
    : statement.kind === 'choice' ? [statement.prompt, ...statement.options.map((option) => option.label)].filter(Boolean) : [];
  return states.map((state) => {
    const indirect = rendered.some((expr) => {
      const values = evaluate(expr, state, context);
      return values === null || values.some((value) => mayCallInText(value, state));
    });
    if (!direct && !indirect) return state;
    const next = copy(state);
    if (indirect) for (const name of mutableNames) next.set(name, null);
    else {
      const affected = new Set();
      for (const name of calls) {
        const effect = functionEffects.get(name);
        if (!effect) { mutableNames.forEach((item) => affected.add(item)); continue; }
        if (effect.unknown) { mutableNames.forEach((item) => affected.add(item)); continue; }
        for (const item of effect.writes) if (mutableNames.has(item)) affected.add(item);
      }
      affected.forEach((name) => next.set(name, null));
    }
    return next;
  });
}

function execute(statement, states, mutableNames, effects, context) {
  states = taintCalls(statement, states, mutableNames, effects, context);
  const result = [];
  for (const state of states) {
    if (statement.kind === 'declare') {
      const initial = statement.initial ? evaluate(statement.initial, state, context) : single(statement.type === 'int' ? 0n : statement.type === 'str' ? '' : {});
      result.push(put(state, statement.name, initial));
    } else if (statement.kind === 'set' || statement.kind === 'unset') {
      let target = statement.target;
      while (target?.kind === 'index') target = target.target;
      if (!target?.name) { result.push(state); continue; }
      if (statement.target.kind === 'variable' && statement.kind === 'set') result.push(put(state, target.name, evaluate(statement.value, state, context)));
      else result.push(put(state, target.name, updateObject(state, statement.target, statement.kind === 'set' ? evaluate(statement.value, state, context) : [null], statement.kind === 'unset', context)));
    } else if (statement.kind === 'if') {
      let remaining = [state];
      for (const branch of [{ condition: statement.condition, body: statement.body }, ...statement.elseIf]) {
        const yes = [], no = [];
        for (const item of remaining) { const parts = split(item, branch.condition, context); yes.push(...parts[0]); no.push(...parts[1]); }
        result.push(...runBlock(branch.body, yes, mutableNames, effects, context)); remaining = no;
      }
      result.push(...runBlock(statement.otherwise, remaining, mutableNames, effects, context));
    } else if (statement.kind === 'choice') {
      for (const option of statement.options) result.push(...runBlock(option.body, [state], mutableNames, effects, context));
    } else if (statement.kind === 'for') {
      const bounds = [evaluate(statement.start, state, context), evaluate(statement.stop, state, context), evaluate(statement.step, state, context)];
      const hasTransfer = (block) => {
        for (const item of block || []) {
          if (item.kind === 'goto' || item.kind === 'return') return true;
          if (item.kind === 'if' && (hasTransfer(item.body) || item.elseIf.some((branch) => hasTransfer(branch.body)) || hasTransfer(item.otherwise))) return true;
          if (item.kind === 'choice' && item.options.some((option) => hasTransfer(option.body))) return true;
          if ((item.kind === 'for' || item.kind === 'while') && hasTransfer(item.body)) return true;
        }
        return false;
      };
      if (bounds.some((values) => values === null) || bounds.reduce((size, values) => size * values.length, 1) > LIMIT || hasTransfer(statement.body)) {
        const next = copy(state);
        for (const name of writes(statement.body)) next.set(name, null);
        if (state.has(statement.name) || mutableNames.has(statement.name)) next.set(statement.name, null);
        result.push(next);
        continue;
      }
      const combinations = bounds[0].flatMap((start) => bounds[1].flatMap((stop) => bounds[2].map((step) => [start, stop, step])));
      for (const [start, stop, step] of combinations) {
        if (typeof start !== 'bigint' || typeof stop !== 'bigint' || typeof step !== 'bigint' || step === 0n
          || (start < stop && step < 0n) || (start > stop && step > 0n)) {
          const next = copy(state);
          for (const name of writes(statement.body)) next.set(name, null);
          result.push(next);
          continue;
        }
        const existed = state.has(statement.name), previous = state.get(statement.name);
        let paths = [state];
        let index = start;
        let iterations = 0;
        while (step > 0n ? index <= stop : index >= stop) {
          if (++iterations > LIMIT * 4) { paths = null; break; }
          paths = runBlock(statement.body, paths.map((path) => put(path, statement.name, single(index))), mutableNames, effects, context);
          if (!paths.length) break;
          index += step;
        }
        if (!paths) {
          const next = copy(state);
          for (const name of writes(statement.body)) next.set(name, null);
          result.push(next);
          continue;
        }
        for (const path of paths) {
          const restored = copy(path);
          if (existed) restored.set(statement.name, previous);
          else restored.delete(statement.name);
          result.push(restored);
        }
      }
    } else if (statement.kind === 'while') {
      const [active, inactive] = split(state, statement.condition, context);
      result.push(...inactive);
      for (const path of active) {
        const tainted = copy(path);
        for (const name of writes(statement.body)) tainted.set(name, null);
        result.push(tainted);
      }
    } else if (statement.kind === 'call') {
      result.push(state);
    } else if (statement.kind !== 'goto' && statement.kind !== 'return') result.push(state);
  }
  return mergeStates(result);
}

function runBlock(block, states, mutableNames, effects, context) {
  for (const statement of block || []) {
    states = execute(statement, states, mutableNames, effects, context);
    if (!states.length) break;
  }
  return states;
}

function atLine(block, states, line, mutableNames, effects, context) {
  for (const statement of block || []) {
    if (!states.length) return [];
    if (line <= Number(statement.line || 0)) return states;
    if (line <= Number(statement.endLine || statement.line || 0)) {
      if (statement.kind === 'if') {
        states = taintCalls(statement, states, mutableNames, effects, context);
        let remaining = states;
        for (const branch of [{ condition: statement.condition, body: statement.body }, ...statement.elseIf]) {
          if (branch.body.some((item) => line >= item.line && line <= (item.endLine || item.line))) {
            const yes = remaining.flatMap((item) => split(item, branch.condition, context)[0]);
            return atLine(branch.body, yes, line, mutableNames, effects, context);
          }
          remaining = remaining.flatMap((item) => split(item, branch.condition, context)[1]);
        }
        return atLine(statement.otherwise, remaining, line, mutableNames, effects, context);
      }
      if (statement.kind === 'choice') {
        states = taintCalls(statement, states, mutableNames, effects, context);
        const option = statement.options.find((item) => item.body.some((part) => line >= part.line && line <= (part.endLine || part.line)));
        return option ? atLine(option.body, states, line, mutableNames, effects, context) : states;
      }
      if (statement.kind === 'for' || statement.kind === 'while') {
        states = taintCalls(statement, states, mutableNames, effects, context);
        if (statement.kind === 'while') {
          const paths = states.flatMap((state) => {
            const [active, inactive] = split(state, statement.condition, context);
            return [...inactive, ...active.map((item) => { const next = copy(item); for (const name of writes(statement.body)) next.set(name, null); return next; })];
          });
          return paths;
        }
        return states.map((state) => { const next = copy(state); for (const name of writes(statement.body)) next.set(name, null); return next; });
      }
      return states;
    }
    states = execute(statement, states, mutableNames, effects, context);
  }
  return states;
}

function characterStateDeclarations(characters = []) {
  return characters.map((character) => ({
    kind: 'declare',
    name: character.name,
    type: { kind: 'struct', name: `character:${character.name}` },
    initial: { kind: 'dict', entries: character.properties.map((property) => ({ key: property.name, value: property.value })) },
    line: character.line,
  }));
}

function analyzeStartDomains(script, sceneName, line, names, staticDeclarations = [], entryScene = false, constraints = new Map(), externalCharacters = []) {
  const scene = script.scenes.find((item) => item.name === sceneName);
  if (!scene) throw Error(`Unknown scene: ${sceneName}`);
  const mutableNames = new Set(names);
  const effects = functionWriteEffects(script);
  const context = { functions: new Map((script.functions || []).map((fn) => [fn.name, fn])), effects, stack: [] };
  // Project-level character files are linked into every compiled scene file.
  // Seed their constant fields too, so a direct test start has the same known
  // display-name/character state as a normal transfer from the defining file.
  let states = runBlock([...characterStateDeclarations([...script.characters, ...externalCharacters]), ...staticDeclarations], [new Map()], mutableNames, effects, context);
  states = runBlock(script.globals, states, mutableNames, effects, context);
  // Other scene entries can inherit modified globals. Only the first scene has
  // a reliable initial state without inter-scene path analysis.
  if (!entryScene || scene !== script.scenes[0]) {
    const globals = [...staticDeclarations, ...script.globals].filter((item) => item.kind === 'declare' && !item.constant);
    states = states.map((state) => { const next = copy(state); globals.forEach((item) => next.set(item.name, null)); return next; });
  }
  if (line > Number(scene.line || 0)) states = atLine(scene.body, states, line, mutableNames, effects, context);
  const result = {};
  for (const name of names) {
    let values = [];
    for (const state of states) { values = union(values, get(state, name)); if (values === null) break; }
    if (values === null && constraints.get(name)?.values) values = domain([...constraints.get(name).values]);
    result[name] = values === null || !states.length ? { kind: 'unknown', values: [] } : {
      kind: values.length === 1 ? 'exact' : 'finite',
      values: values.map((item) => typeof item === 'bigint' ? String(item) : typeof item === 'string' ? item : JSON.stringify(item, (_name, value) => typeof value === 'bigint' ? String(value) : value)),
    };
  }
  return result;
}

module.exports = { analyzeStartDomains, characterStateDeclarations };
