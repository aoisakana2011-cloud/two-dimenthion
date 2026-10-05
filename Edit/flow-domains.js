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
const { isPureBuiltin } = require('../dist/language/builtins');
const get = (state, name) => state.has(name) ? state.get(name) : null;
const put = (state, name, value) => { const next = copy(state); next.set(name, value); return next; };
const LOCAL_PREFIX = '\0local:';
const localKey = (name) => `${LOCAL_PREFIX}${name}`;
const readBinding = (state, name) => state.has(localKey(name)) ? state.get(localKey(name)) : get(state, name);
const putLocal = (state, name, value) => put(state, localKey(name), value);
const putBinding = (state, name, value) => state.has(localKey(name)) ? putLocal(state, name, value) : put(state, name, value);
const withinInt = (value) => typeof value !== 'bigint' || value >= INT_MIN && value <= INT_MAX;
function convertPrimitive(name, item) {
  if (name === 'str') return String(item);
  if (name === 'float') {
    const value = Number(item);
    if (!Number.isFinite(value)) throw Error('invalid float');
    return value;
  }
  const value = typeof item === 'number' ? BigInt(Math.trunc(item)) : BigInt(item);
  if (!withinInt(value)) throw Error('int overflow');
  return value;
}

function combine(left, right, operation) {
  if (left === null || right === null || left.length * right.length > LIMIT) return null;
  const values = [];
  for (const a of left) for (const b of right) {
    try { const result = operation(a, b); if (!withinInt(result) || typeof result === 'number' && !Number.isFinite(result)) return null; values.push(result); }
    catch { return null; }
  }
  return domain(values);
}

function intrinsic(name, args) {
  if (!isPureBuiltin(name) || args.some((values) => values === null)
    || args.reduce((size, values) => size * values.length, 1) > LIMIT) return null;
  const whitespace = /[ \t\n\r\f\v\u00a0\u3000]+/gu;
  const trim = (value) => value.replace(/^[ \t\n\r\f\v\u00a0\u3000]+|[ \t\n\r\f\v\u00a0\u3000]+$/gu, '');
  const results = [];
  const visit = (index, values) => {
    if (index < args.length) { for (const value of args[index]) visit(index + 1, [...values, value]); return; }
    const [first, second, third] = values;
    try {
      switch (name) {
        case 'str': results.push(String(first)); break;
        case 'int': results.push(convertPrimitive('int', first)); break;
        case 'float': results.push(convertPrimitive('float', first)); break;
        case 'list.length': results.push(BigInt(first.length)); break;
        case 'list.append': results.push([...first, second]); break;
        case 'list.contains': results.push(first.some((item) => key(item) === key(second))); break;
        case 'text.trim': results.push(trim(first)); break;
        case 'text.normalize_space': results.push(trim(first.replace(whitespace, ' '))); break;
        case 'text.split': if (!second.length) return; else results.push(first.split(second)); break;
        case 'text.replace': if (!second.length) return; else results.push(first.split(second).join(third)); break;
        default: return;
      }
    } catch { return; }
  };
  visit(0, []);
  return domain(results);
}

function indexedValue(object, index) {
  if (Array.isArray(object)) {
    if (typeof index !== 'bigint' || index < 0n || index >= BigInt(object.length)) throw Error('unknown list index');
    return object[Number(index)];
  }
  if (!object || typeof object !== 'object' || !Object.hasOwn(object, index)) throw Error('unknown index');
  return object[index];
}

function updateObject(state, target, value, remove = false, context = null) {
  let root = target;
  while (root?.kind === 'index') root = root.target;
  if (root?.kind !== 'variable' || target.kind !== 'index' || target.target.kind !== 'variable') return null;
  const objects = readBinding(state, root.name), keys = evaluate(target.key, state, context);
  return updateObjectKeys(state, target, objects, keys, value, remove);
}

function updateObjectKeys(state, target, objects, keys, value, remove = false) {
  let root = target;
  while (root?.kind === 'index') root = root.target;
  if (root?.kind !== 'variable' || target.kind !== 'index' || target.target.kind !== 'variable') return null;
  if (objects === null || keys === null || value === null || objects.length * keys.length * value.length > LIMIT) return null;
  const results = [];
  for (const object of objects) for (const field of keys) for (const item of value) {
    if (Array.isArray(object)) {
      if (remove || typeof field !== 'bigint' || field < 0n || field >= BigInt(object.length)) return null;
      const next = [...object];
      next[Number(field)] = item;
      results.push(next);
      continue;
    }
    if (!object || typeof object !== 'object') return null;
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
  if (expr.kind === 'float') return Number.isFinite(Number(expr.value)) ? single(Number(expr.value)) : null;
  if (expr.kind === 'literal') return single(typeof expr.value === 'number' ? BigInt(expr.value) : expr.value);
  if (expr.kind === 'variable') return readBinding(state, expr.name);
  if (expr.kind === 'list') {
    let values = [[]];
    for (const item of expr.items) {
      const candidates = evaluate(item, state, context);
      if (candidates === null || values.length * candidates.length > LIMIT) return null;
      values = values.flatMap((list) => candidates.map((value) => [...list, value]));
    }
    return domain(values);
  }
  if (expr.kind === 'dict') {
    let values = [{}];
    for (const entry of expr.entries) {
      const item = evaluate(entry.value, state, context);
      if (item === null || values.length * item.length > LIMIT) return null;
      values = values.flatMap((object) => item.map((value) => ({ ...object, [entry.key]: value })));
    }
    return domain(values);
  }
  if (expr.kind === 'index') return combine(evaluate(expr.target, state, context), evaluate(expr.key, state, context), indexedValue);
  if (expr.kind === 'call') {
    if (isPureBuiltin(expr.name)) return intrinsic(expr.name, expr.args.map((argument) => evaluate(argument, state, context)));
    if (['str', 'int', 'float'].includes(expr.name) && expr.args.length === 1) {
      const args = evaluate(expr.args[0], state, context);
      if (args === null) return null;
      try { return domain(args.map((item) => convertPrimitive(expr.name, item))); } catch { return null; }
    }
    const fn = context?.functions.get(expr.name);
    if (!fn || !context || expr.args.length !== fn.params.length
      || context.stack.includes(fn.name) || context.stack.length >= 12) return null;
    const args = expr.args.map((argument) => evaluate(argument, state, context));
    if (args.some((values) => values === null) || args.reduce((size, values) => size * values.length, 1) > LIMIT) return null;
    const outcomes = invokeFunction(fn, state, args, context);
    if (!outcomes?.length || outcomes.some((outcome) => outcome.transfer || !outcome.returned || outcome.value === null)) return null;
    return outcomes.reduce((values, outcome) => union(values, outcome.value), []);
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
      case '/': if (b === 0n || b === 0) throw Error('division by zero'); return a / b;
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

function mergeEvaluations(paths) {
  if (paths.length <= LIMIT) return paths;
  const values = paths.reduce((result, path) => union(result, path.values), []);
  return [{ state: widenStates(paths.map((path) => path.state))[0], values }];
}

function evaluateArguments(expressions, state, context) {
  let paths = [{ state, args: [] }];
  for (const expression of expressions || []) {
    const next = [];
    for (const path of paths) for (const outcome of evaluateWithEffects(expression, path.state, context)) {
      next.push({ state: outcome.state, args: [...path.args, outcome.values] });
    }
    if (next.length > LIMIT) {
      const mergedState = widenStates(next.map((path) => path.state))[0];
      const args = (expressions || []).slice(0, next[0]?.args.length || 0).map((_, index) => next.reduce((values, path) => union(values, path.args[index]), []));
      paths = [{ state: mergedState, args }];
    } else paths = next;
  }
  return paths;
}

function evaluateWithEffects(expr, state, context = null) {
  if (!expr) return [{ state, values: null }];
  if (expr.kind === 'literal' || expr.kind === 'float' || expr.kind === 'variable') return [{ state, values: evaluate(expr, state, context) }];
  if (expr.kind === 'list') {
    let paths = [{ state, values: [[]] }];
    for (const item of expr.items) {
      const next = [];
      for (const path of paths) for (const value of evaluateWithEffects(item, path.state, context)) {
        if (path.values === null || value.values === null || path.values.length * value.values.length > LIMIT) next.push({ state: value.state, values: null });
        else next.push({ state: value.state, values: path.values.flatMap((list) => value.values.map((entry) => [...list, entry])) });
      }
      paths = mergeEvaluations(next);
    }
    return paths;
  }
  if (expr.kind === 'call') {
    const args = evaluateArguments(expr.args, state, context);
    const result = [];
    for (const path of args) {
      if (isPureBuiltin(expr.name)) {
        result.push({ state: path.state, values: intrinsic(expr.name, path.args) });
        continue;
      } else if (['str', 'int', 'float'].includes(expr.name) && path.args.length === 1) {
        const input = path.args[0];
        if (input === null) result.push({ state: path.state, values: null });
        else {
          try { result.push({ state: path.state, values: domain(input.map((item) => convertPrimitive(expr.name, item))) }); }
          catch { result.push({ state: path.state, values: null }); }
        }
        continue;
      }
      const fn = context?.functions.get(expr.name);
      const outcomes = fn ? invokeFunction(fn, path.state, path.args, context) : null;
      if (!outcomes) result.push({ state: taintFunctionCall(path.state, expr.name, context?.effects.get(expr.name), context?.mutableNames || new Set()), values: null });
      else for (const outcome of outcomes) result.push({ state: outcome.state, values: outcome.returned ? outcome.value : null });
    }
    return mergeEvaluations(result);
  }
  if (expr.kind === 'unary') return mergeEvaluations(evaluateWithEffects(expr.value, state, context).map((path) => {
    if (path.values === null) return { ...path, values: null };
    try {
      const values = domain(path.values.map((item) => expr.operator === 'not' ? !item : expr.operator === '-' ? -item : item));
      return { ...path, values: values?.every((value) => withinInt(value) && (typeof value !== 'number' || Number.isFinite(value))) ? values : null };
    } catch { return { ...path, values: null }; }
  }));
  if (expr.kind === 'dict') {
    let paths = [{ state, values: [{}] }];
    for (const entry of expr.entries) {
      const next = [];
      for (const path of paths) for (const value of evaluateWithEffects(entry.value, path.state, context)) {
        if (path.values === null || value.values === null || path.values.length * value.values.length > LIMIT) next.push({ state: value.state, values: null });
        else next.push({ state: value.state, values: path.values.flatMap((item) => value.values.map((field) => ({ ...item, [entry.key]: field }))) });
      }
      paths = mergeEvaluations(next);
    }
    return paths;
  }
  if (expr.kind === 'index') {
    const result = [];
    for (const object of evaluateWithEffects(expr.target, state, context)) for (const name of evaluateWithEffects(expr.key, object.state, context)) {
      result.push({ state: name.state, values: combine(object.values, name.values, indexedValue) });
    }
    return mergeEvaluations(result);
  }
  if (expr.kind === 'binary') {
    const result = [];
    for (const left of evaluateWithEffects(expr.left, state, context)) {
      if (expr.operator === 'and' || expr.operator === 'or') {
        if (left.values === null) {
          result.push({ state: left.state, values: null });
          for (const right of evaluateWithEffects(expr.right, left.state, context)) result.push({ state: right.state, values: null });
          continue;
        }
        for (const value of left.values) {
          const shortCircuits = expr.operator === 'and' ? !value : Boolean(value);
          if (shortCircuits) result.push({ state: left.state, values: single(expr.operator === 'or') });
          else for (const right of evaluateWithEffects(expr.right, left.state, context)) {
            result.push({ state: right.state, values: right.values === null ? null : domain(right.values.map(Boolean)) });
          }
        }
      } else for (const right of evaluateWithEffects(expr.right, left.state, context)) {
        result.push({ state: right.state, values: combine(left.values, right.values, (a, b) => {
          switch (expr.operator) {
            case '+': return a + b;
            case '-': return a - b;
            case '*': return a * b;
            case '/': if (b === 0n || b === 0) throw Error('division by zero'); return a / b;
            case '%': if (b === 0n) throw Error('division by zero'); return a % b;
            case '==': return key(a) === key(b);
            case '!=': return key(a) !== key(b);
            case '>': return a > b;
            case '>=': return a >= b;
            case '<': return a < b;
            case '<=': return a <= b;
            default: throw Error('unsupported operator');
          }
        }) });
      }
    }
    return mergeEvaluations(result);
  }
  return [{ state, values: null }];
}

function runtimeString(value) {
  return value && typeof value === 'object'
    ? JSON.stringify(value, (_name, item) => typeof item === 'bigint' ? String(item) : item)
    : String(value ?? '');
}

function isDefinitelyIntegerTemplatePath(name, fields, context) {
  let types = [...(context.templateTypes.variables.get(name) || [])];
  if (!types.length) return false;
  for (const field of fields) {
    const next = [];
    for (const type of types) {
      const fieldType = context.templateTypes.structFields.get(type)?.[field];
      if (!fieldType) return false;
      next.push(fieldType);
    }
    types = next;
  }
  return types.length > 0 && types.every((type) => type === 'int');
}

function renderTemplate(state, value, context) {
  const source = runtimeString(value);
  const placeholders = [...source.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\}/g)];
  let rendered = [''];
  let cursor = 0;
  for (const match of placeholders) {
    rendered = rendered.map((prefix) => prefix + source.slice(cursor, match.index));
    const [name, ...fields] = match[1].split('.');
    let replacements = readBinding(state, name);
    if (replacements === null) {
      if (!isDefinitelyIntegerTemplatePath(name, fields, context)) return null;
      replacements = [''];
    }
    const texts = [];
    for (let replacement of replacements) {
      for (const field of fields) {
        if (!replacement || typeof replacement !== 'object' || !Object.hasOwn(replacement, field)) return null;
        replacement = replacement[field];
      }
      if ((replacement === null || replacement === undefined) && !isDefinitelyIntegerTemplatePath(name, fields, context)) return null;
      texts.push(runtimeString(replacement));
    }
    if (rendered.length * texts.length > LIMIT) return null;
    rendered = rendered.flatMap((prefix) => texts.map((text) => prefix + text));
    cursor = match.index + match[0].length;
  }
  return unique(rendered.map((prefix) => prefix + source.slice(cursor)));
}

function executeTextExpression(expression, state, context) {
  const result = [];
  for (const path of evaluateWithEffects(expression, state, context)) {
    if (path.values === null) {
      result.push(taintFunctionCall(path.state, '', { unknown: true }, context.mutableNames || new Set()));
      continue;
    }
    for (const value of path.values) {
      const sources = renderTemplate(path.state, value, context);
      if (sources === null) {
        result.push(taintFunctionCall(path.state, '', { unknown: true }, context.mutableNames || new Set()));
        continue;
      }
      for (const source of sources) {
        let paths = [path.state];
        for (const match of source.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\(\)\}/g)) {
          const fn = context.functions.get(match[1]);
          const next = [];
          for (const current of paths) {
            const outcomes = fn ? invokeFunction(fn, current, [], context) : null;
            if (outcomes) next.push(...outcomes.map((outcome) => outcome.state));
            else next.push(taintFunctionCall(current, match[1], context.effects.get(match[1]), context.mutableNames || new Set()));
          }
          paths = next;
        }
        result.push(...paths);
      }
    }
  }
  return mergeStates(result);
}

function executeCommandEffects(statement, state, context) {
  if (statement.name !== 'say' || statement.args.length < 2) {
    return evaluateArguments(statement.args, state, context).map((path) => path.state);
  }
  return evaluateWithEffects(statement.args[0], state, context)
    .flatMap((speaker) => executeTextExpression(statement.args[1], speaker.state, context));
}

function executeChoiceEffects(statement, state, context) {
  let states = [state];
  // The runtime expands every label first, then the prompt, before accepting a choice.
  for (const option of statement.options) states = states.flatMap((current) => executeTextExpression(option.label, current, context));
  if (statement.prompt) states = states.flatMap((current) => executeTextExpression(statement.prompt, current, context));
  return mergeStates(states);
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
  if (equality && readBinding(state, equality[0]) === null) {
    const value = typeof equality[1] === 'number' ? BigInt(equality[1]) : equality[1];
    const exact = putBinding(state, equality[0], single(value));
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
    const values = readBinding(state, name);
    if (values === null || variants.length * values.length > LIMIT) continue;
    variants = variants.flatMap((item) => values.map((value) => putBinding(item, name, single(value))));
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

function splitWithEffects(state, condition, context = null) {
  const expression = condition.expression || condition;
  if (!hasUserCall(expression)) return split(state, condition, context);
  const yes = [], no = [];
  for (const path of evaluateWithEffects(expression, state, context)) {
    if (path.values === null) { yes.push(path.state); no.push(path.state); }
    else {
      if (path.values.some(Boolean)) yes.push(path.state);
      if (path.values.some((value) => !value)) no.push(path.state);
    }
  }
  return [mergeStates(yes), mergeStates(no)];
}

function writes(statements, out = new Set()) {
  for (const statement of statements || []) {
    if (statement.kind === 'set' || statement.kind === 'unset') {
      let target = statement.target;
      while (target?.kind === 'index') target = target.target;
      if (target?.kind === 'variable') out.add(target.name);
    }
    if (statement.kind === 'declare' || statement.kind === 'for' || statement.kind === 'forEach') out.add(statement.name);
    if (statement.kind === 'if') {
      writes(statement.body, out); statement.elseIf.forEach((branch) => writes(branch.body, out)); writes(statement.otherwise, out);
    } else if (statement.kind === 'choice') statement.options.forEach((option) => writes(option.body, out));
    else if (statement.kind === 'for' || statement.kind === 'forEach' || statement.kind === 'while' || statement.kind === 'parallel') writes(statement.body, out);
  }
  return out;
}

function hasUserCall(expr) {
  if (!expr || typeof expr !== 'object') return false;
  if (expr.kind === 'call' && !isPureBuiltin(expr.name)) return true;
  return Object.values(expr).some((value) => Array.isArray(value) ? value.some(hasUserCall) : value && typeof value === 'object' && hasUserCall(value));
}

function functionWriteEffects(script) {
  const functions = new Map((script.functions || []).map((fn) => [fn.name, fn]));
  const effects = new Map();
  for (const fn of functions.values()) {
    const locals = functionLocalNames(fn);
    const writes = new Set();
    const calls = new Set();
    let unknown = false;
    const visitExpr = (expr) => {
      if (!expr || typeof expr !== 'object') return;
      if (expr.kind === 'call' && !isPureBuiltin(expr.name)) calls.add(expr.name);
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
        if (statement.kind === 'call' && !isPureBuiltin(statement.name)) calls.add(statement.name);
        if (statement.kind === 'command' && statement.name === 'say'
          && (statement.args[1]?.kind !== 'literal' || typeof statement.args[1].value !== 'string'
            || /\{[A-Za-z_][A-Za-z0-9_]*\(\)\}/.test(statement.args[1].value))) unknown = true;
        if (statement.kind === 'choice' && [statement.prompt, ...statement.options.map((option) => option.label)]
          .some((expr) => expr && (expr.kind !== 'literal' || typeof expr.value !== 'string' || /\{[A-Za-z_][A-Za-z0-9_]*\(\)\}/.test(expr.value)))) unknown = true;
        for (const expression of [statement.condition?.expression, statement.prompt, statement.initial, statement.value,
          statement.target, statement.start, statement.stop, statement.step, statement.iterable, ...(statement.args || []),
          ...(statement.options || []).flatMap((option) => [option.label, ...[]]),
          ...(statement.elseIf || []).map((branch) => branch.condition?.expression)]) visitExpr(expression);
        if (statement.kind === 'if') {
          visitBlock(statement.body);
          statement.elseIf.forEach((branch) => visitBlock(branch.body));
          visitBlock(statement.otherwise);
        } else if (statement.kind === 'choice') statement.options.forEach((option) => visitBlock(option.body));
        else if (statement.kind === 'for' || statement.kind === 'forEach' || statement.kind === 'while' || statement.kind === 'parallel') visitBlock(statement.body);
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
    const values = readBinding(state, name);
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
              : statement.kind === 'forEach' ? [statement.iterable]
              : statement.kind === 'command' || statement.kind === 'call' ? statement.args
                : statement.kind === 'return' ? [statement.value] : [];
  const direct = expressions.some(hasUserCall);
  const calls = new Set();
  const collectCalls = (expr) => {
    if (!expr || typeof expr !== 'object') return;
    if (expr.kind === 'call' && !['str', 'int', 'float'].includes(expr.name)) calls.add(expr.name);
    for (const value of Object.values(expr)) {
      if (Array.isArray(value)) value.forEach(collectCalls);
      else if (value && typeof value === 'object') collectCalls(value);
    }
  };
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
    if (indirect) for (const name of new Set([...next.keys(), ...mutableNames])) next.set(name, null);
    else {
      const affected = new Set();
      for (const name of calls) {
        const effect = functionEffects.get(name);
        if (!effect) { for (const item of [...next.keys(), ...mutableNames]) affected.add(item); continue; }
        if (effect.unknown) { for (const item of [...next.keys(), ...mutableNames]) affected.add(item); continue; }
        for (const item of effect.writes) if (mutableNames.has(item) || next.has(item)) affected.add(item);
      }
      affected.forEach((name) => next.set(name, null));
    }
    return next;
  });
}

const MAX_FUNCTION_DEPTH = 12;
const MAX_FUNCTION_STEPS = 256;

function functionLocalNames(fn, out = new Set(fn.params.map((param) => param.name))) {
  const visit = (block) => {
    for (const statement of block || []) {
      if (statement.kind === 'declare') out.add(statement.name);
      if (statement.kind === 'if') {
        visit(statement.body); statement.elseIf.forEach((branch) => visit(branch.body)); visit(statement.otherwise);
      } else if (statement.kind === 'choice') statement.options.forEach((option) => visit(option.body));
      else if (statement.kind === 'forEach') { out.add(statement.name); visit(statement.body); }
      else if (statement.kind === 'for' || statement.kind === 'while' || statement.kind === 'parallel') visit(statement.body);
    }
  };
  visit(fn.body);
  return out;
}

function mergeFunctionOutcomes(outcomes) {
  if (outcomes.length <= LIMIT) return outcomes;
  const groups = new Map();
  for (const outcome of outcomes) {
    const id = `${outcome.returned ? 'r' : 'n'}:${outcome.transfer ? 't' : 'f'}`;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(outcome);
  }
  const merged = [];
  for (const group of groups.values()) {
    const states = widenStates(group.map((item) => item.state));
    let value = [];
    for (const item of group) value = union(value, item.value);
    for (const state of states) merged.push({ ...group[0], state, value });
  }
  return merged;
}

function widenStates(states) {
  if (!states.length) return [];
  const merged = new Map();
  const names = new Set(states.flatMap((state) => [...state.keys()]));
  for (const name of names) merged.set(name, states.reduce((values, state) => union(values, get(state, name)), []));
  return [merged];
}

function runFunctionBlock(block, outcomes, mutableNames, context) {
  let paths = outcomes;
  for (const statement of block || []) {
    if (!paths.length) break;
    const next = [];
    for (const path of paths) {
      if (path.returned || path.transfer) next.push(path);
      else next.push(...runFunctionStatement(statement, path.state, mutableNames, context));
    }
    paths = mergeFunctionOutcomes(next);
  }
  return paths;
}

function taintWritten(state, statements, context, mutableNames) {
  const next = copy(state);
  for (const name of writes(statements)) if (next.has(name) || next.has(localKey(name)) || mutableNames.has(name)) {
    if (next.has(localKey(name))) next.set(localKey(name), null);
    else next.set(name, null);
  }
  if (context.effects) for (const [name, effect] of context.effects) {
    if (!effect.unknown && !effect.writes.size) continue;
    if (effect.unknown) for (const key of [...next.keys(), ...mutableNames]) next.set(key, null);
    else for (const key of effect.writes) if (next.has(key) || mutableNames.has(key)) next.set(key, null);
  }
  return next;
}

function runFunctionWhile(statement, states, mutableNames, context) {
  let active = states.map((state) => ({ state, seen: new Set(), returned: false, transfer: false, value: null }));
  const finished = [];
  let steps = 0;
  while (active.length && steps++ < MAX_FUNCTION_STEPS) {
    const next = [];
    for (const path of active) {
      const signature = key([...path.state.entries()].map(([name, values]) => [name, values]));
      if (path.seen.has(signature)) {
        finished.push({ ...path, state: taintWritten(path.state, statement.body, context, mutableNames) });
        continue;
      }
      const seen = new Set(path.seen); seen.add(signature);
      const [yes, no] = splitWithEffects(path.state, statement.condition, context);
      no.forEach((state) => finished.push({ state, returned: false, transfer: false, value: null }));
      for (const state of yes) for (const outcome of runFunctionBlock(statement.body,
        [{ state, returned: false, transfer: false, value: null }], mutableNames, context)) {
        if (outcome.returned || outcome.transfer) finished.push(outcome);
        else next.push({ ...outcome, seen });
      }
    }
    active = mergeFunctionOutcomes(next);
  }
  if (active.length) for (const path of active) finished.push({ ...path, state: taintWritten(path.state, statement.body, context, mutableNames) });
  return mergeFunctionOutcomes(finished);
}

function runFunctionFor(statement, state, bounds, mutableNames, context) {
  const normal = (next) => ({ state: next, returned: false, transfer: false, value: null });
  if (bounds.some((values) => values === null) || bounds.reduce((size, values) => size * values.length, 1) > LIMIT) {
    const next = copy(state);
    for (const name of writes(statement.body)) if (next.has(name) || next.has(localKey(name)) || mutableNames.has(name)) next.set(next.has(localKey(name)) ? localKey(name) : name, null);
    return [normal(next)];
  }
  const result = [];
  for (const [start, stop, step] of bounds[0].flatMap((a) => bounds[1].flatMap((b) => bounds[2].map((c) => [a, b, c])))) {
    if (typeof start !== 'bigint' || typeof stop !== 'bigint' || typeof step !== 'bigint' || step === 0n
      || (start < stop && step < 0n) || (start > stop && step > 0n)) continue;
    const frameKey = localKey(statement.name);
    const hadLocal = state.has(frameKey), oldValue = state.get(frameKey);
    let paths = [normal(state)], index = start, count = 0;
    while (step > 0n ? index <= stop : index >= stop) {
      if (++count > MAX_FUNCTION_STEPS) {
        paths = paths.map((path) => ({ ...path, state: taintWritten(path.state, statement.body, context, mutableNames) }));
        break;
      }
      const next = [];
      for (const path of paths) {
        if (path.returned || path.transfer) next.push(path);
        else next.push(...runFunctionBlock(statement.body, [normal(putLocal(path.state, statement.name, single(index)))], mutableNames, context));
      }
      paths = next;
      index += step;
    }
    result.push(...paths.map((path) => ({ ...path, state: hadLocal ? putLocal(path.state, statement.name, oldValue) : (() => { const restored = copy(path.state); restored.delete(frameKey); return restored; })() })));
  }
  return mergeFunctionOutcomes(result);
}

function runFunctionEach(statement, state, iterables, mutableNames, context) {
  const normal = (next) => ({ state: next, returned: false, transfer: false, value: null });
  const frameKey = localKey(statement.name), hadLocal = state.has(frameKey), oldValue = state.get(frameKey);
  const restore = (outcome) => ({ ...outcome, state: hadLocal ? putLocal(outcome.state, statement.name, oldValue) : (() => { const next = copy(outcome.state); next.delete(frameKey); return next; })() });
  if (iterables === null) {
    const unknownState = putLocal(state, statement.name, null);
    const body = runFunctionBlock(statement.body, [normal(unknownState)], mutableNames, context)
      .map((outcome) => ({ ...outcome, state: taintWritten(outcome.state, statement.body, context, mutableNames) }));
    return mergeFunctionOutcomes([normal(state), ...body].map(restore));
  }
  const result = [];
  for (const iterable of iterables) {
    if (!Array.isArray(iterable)) return [normal(taintWritten(state, statement.body, context, mutableNames))];
    let paths = [normal(state)], count = 0;
    for (const item of iterable) {
      if (++count > MAX_FUNCTION_STEPS) {
        paths = paths.map((path) => ({ ...path, state: taintWritten(path.state, statement.body, context, mutableNames) }));
        break;
      }
      paths = paths.flatMap((path) => path.returned || path.transfer ? [path]
        : runFunctionBlock(statement.body, [normal(putLocal(path.state, statement.name, single(item)))], mutableNames, context));
    }
    result.push(...paths.map(restore));
  }
  return mergeFunctionOutcomes(result);
}

function runFunctionStatement(statement, input, mutableNames, context) {
  const stateful = ['declare', 'set', 'unset', 'call', 'return', 'command', 'choice', 'if', 'for', 'forEach', 'while', 'parallel'].includes(statement.kind);
  const states = stateful ? [input] : taintCalls(statement, [input], mutableNames, context.effects, context);
  const result = [];
  for (const state of states) {
    const normal = (next) => ({ state: next, returned: false, transfer: false, value: null });
    if (statement.kind === 'declare') {
      const initial = statement.initial ? evaluateWithEffects(statement.initial, state, context)
        : [{ state, values: single(statement.type === 'int' ? 0n : statement.type === 'float' ? 0 : statement.type === 'str' ? '' : statement.type === 'bool' ? false : statement.type?.kind === 'list' ? [] : {}) }];
      result.push(...initial.map((path) => normal(putLocal(path.state, statement.name, path.values))));
    } else if (statement.kind === 'set' || statement.kind === 'unset') {
      let target = statement.target;
      while (target?.kind === 'index') target = target.target;
      if (!target?.name) { result.push(normal(state)); continue; }
      const values = statement.kind === 'set' ? evaluateWithEffects(statement.value, state, context) : [{ state, values: [null] }];
      for (const path of values) {
        if (statement.target.kind === 'variable' && statement.kind === 'set') result.push(normal(putBinding(path.state, target.name, path.values)));
        else for (const keyPath of evaluateWithEffects(statement.target.key, path.state, context)) {
          const objects = readBinding(keyPath.state, target.name);
          result.push(normal(putBinding(keyPath.state, target.name, updateObjectKeys(keyPath.state, statement.target, objects, keyPath.values, path.values, statement.kind === 'unset'))));
        }
      }
    } else if (statement.kind === 'if') {
      let remaining = [state];
      for (const branch of [{ condition: statement.condition, body: statement.body }, ...statement.elseIf]) {
        const yes = [], no = [];
        for (const path of remaining) { const parts = splitWithEffects(path, branch.condition, context); yes.push(...parts[0]); no.push(...parts[1]); }
        result.push(...runFunctionBlock(branch.body, yes.map((item) => normal(item)), mutableNames, context));
        remaining = no;
      }
      result.push(...runFunctionBlock(statement.otherwise, remaining.map((item) => normal(item)), mutableNames, context));
    } else if (statement.kind === 'choice') {
      for (const choiceState of executeChoiceEffects(statement, state, context)) for (const option of statement.options)
        result.push(...runFunctionBlock(option.body, [normal(choiceState)], mutableNames, context));
    } else if (statement.kind === 'command') {
      result.push(...executeCommandEffects(statement, state, context).map(normal));
    } else if (statement.kind === 'for') {
      for (const bounds of evaluateArguments([statement.start, statement.stop, statement.step], state, context))
        result.push(...runFunctionFor(statement, bounds.state, bounds.args, mutableNames, context));
    } else if (statement.kind === 'forEach') {
      for (const iterable of evaluateWithEffects(statement.iterable, state, context))
        result.push(...runFunctionEach(statement, iterable.state, iterable.values, mutableNames, context));
    } else if (statement.kind === 'while') {
      result.push(...runFunctionWhile(statement, [state], mutableNames, context));
    } else if (statement.kind === 'parallel') {
      result.push(...runFunctionBlock(statement.body, [normal(state)], mutableNames, context).map(path => normal(path.state)));
    } else if (statement.kind === 'return') {
      const values = statement.value ? evaluateWithEffects(statement.value, state, context) : [{ state, values: single(null) }];
      result.push(...values.map((path) => ({ state: path.state, returned: true, transfer: false, value: path.values })));
    } else if (statement.kind === 'goto') {
      // Function goto exits the function in the runtime and does not transfer
      // the caller's scene; its return type is unavailable to the analyzer.
      result.push({ state, returned: true, transfer: false, value: single(null) });
    } else if (statement.kind === 'call') {
      const fn = context.functions.get(statement.name);
      for (const call of evaluateArguments(statement.args, state, context)) {
        const outcomes = fn && call.args.every((values) => values !== null)
          ? invokeFunction(fn, call.state, call.args, context) : null;
        if (outcomes) result.push(...outcomes.map((outcome) => normal(outcome.state)));
        else result.push(normal(taintFunctionCall(call.state, statement.name, context.effects.get(statement.name), mutableNames)));
      }
    } else result.push(normal(state));
  }
  return mergeFunctionOutcomes(result);
}

function taintFunctionCall(state, name, effect, mutableNames) {
  const next = copy(state);
  if (!effect || effect.unknown) for (const variable of new Set([...next.keys(), ...mutableNames])) next.set(variable, null);
  else for (const variable of effect.writes) if (next.has(variable) || mutableNames.has(variable)) next.set(variable, null);
  return next;
}

function invokeFunction(fn, callerState, args, context) {
  if (!fn || context.stack.includes(fn.name) || context.stack.length >= MAX_FUNCTION_DEPTH) return null;
  const combinations = args.reduce((all, values) => all.flatMap((prefix) => values.map((value) => [...prefix, value])), [[]]);
  if (combinations.length > LIMIT) return null;
  const globalNames = new Set(context.globalNames || callerState.keys());
  const visibleGlobals = globalNames;
  const nextContext = { ...context, stack: [...context.stack, fn.name] };
  const all = [];
  for (const combination of combinations) {
    let frame = new Map([...callerState].filter(([name]) => visibleGlobals.has(name)));
    fn.params.forEach((param, index) => frame.set(localKey(param.name), single(combination[index])));
    const outcomes = runFunctionBlock(fn.body, [{ state: frame, returned: false, transfer: false, value: null }],
      context.mutableNames || new Set(), nextContext);
    if (!outcomes.length) continue;
    for (const outcome of outcomes) {
      const state = copy(callerState);
      for (const name of visibleGlobals) {
        if (outcome.state.has(name)) state.set(name, outcome.state.get(name));
        else state.delete(name);
      }
      all.push({ ...outcome, state });
    }
  }
  return mergeFunctionOutcomes(all);
}

function runWhile(statement, states, mutableNames, effects, context) {
  let active = states.map((state) => ({ state, seen: new Set() }));
  const exits = [];
  let steps = 0;
  while (active.length && steps++ < MAX_FUNCTION_STEPS) {
    const next = [];
    for (const path of active) {
      const signature = key([...path.state.entries()]);
      if (path.seen.has(signature)) {
        exits.push(taintWritten(path.state, statement.body, context, mutableNames));
        continue;
      }
      const seen = new Set(path.seen); seen.add(signature);
      const [yes, no] = splitWithEffects(path.state, statement.condition, context);
      exits.push(...no);
      for (const path of yes) {
        for (const outcome of runBlock(statement.body, [path], mutableNames, effects, context)) {
          next.push({ state: outcome, seen });
        }
      }
    }
    active = next.length > LIMIT ? next.slice(0, 1).map((item) => ({ state: widenStates(next.map((path) => path.state))[0], seen: new Set() })) : next;
  }
  for (const path of active) exits.push(taintWritten(path.state, statement.body, context, mutableNames));
  return mergeStates(exits);
}

function atForLine(statement, states, line, mutableNames, effects, context) {
  const result = [];
  for (const state of states) {
    for (const path of evaluateArguments([statement.start, statement.stop, statement.step], state, context)) {
      const bounds = path.args;
      if (bounds.some((values) => values === null) || bounds.reduce((size, values) => size * values.length, 1) > LIMIT) {
        const next = copy(path.state);
        for (const name of writes(statement.body)) if (next.has(name) || mutableNames.has(name)) next.set(name, null);
        result.push(next);
        continue;
      }
      for (const [start, stop, step] of bounds[0].flatMap((a) => bounds[1].flatMap((b) => bounds[2].map((c) => [a, b, c])))) {
      if (typeof start !== 'bigint' || typeof stop !== 'bigint' || typeof step !== 'bigint' || step === 0n
        || (start < stop && step < 0n) || (start > stop && step > 0n)) continue;
      const existed = path.state.has(statement.name), previous = path.state.get(statement.name);
      let paths = [path.state], index = start, iterations = 0;
      while (step > 0n ? index <= stop : index >= stop) {
        if (++iterations > MAX_FUNCTION_STEPS) {
          const next = copy(path.state);
          for (const name of writes(statement.body)) if (next.has(name) || mutableNames.has(name)) next.set(name, null);
          if (mutableNames.has(statement.name)) next.set(statement.name, null);
          result.push(next);
          break;
        }
        const iterationStates = paths.map((path) => put(path, statement.name, single(index)));
        result.push(...atLine(statement.body, iterationStates, line, mutableNames, effects, context));
        paths = runBlock(statement.body, iterationStates, mutableNames, effects, context);
        if (!paths.length) break;
        index += step;
      }
      if (existed) result.push(...paths.map((path) => put(path, statement.name, previous)));
      }
    }
  }
  return mergeStates(result);
}

function atEachLine(statement, states, line, mutableNames, effects, context) {
  const result = [];
  const contains = (block) => (block || []).some((item) => line >= Number(item.line || 0) && line <= Number(item.endLine || item.line || 0));
  if (!contains(statement.body)) return states;
  for (const state of states) for (const path of evaluateWithEffects(statement.iterable, state, context)) {
    if (path.values === null) {
      const widened = taintWritten(path.state, statement.body, context, mutableNames);
      result.push(...atLine(statement.body, [putLocal(widened, statement.name, null)], line, mutableNames, effects, context));
      continue;
    }
    for (const iterable of path.values) {
      if (!Array.isArray(iterable)) continue;
      let paths = [path.state], count = 0;
      for (const item of iterable) {
        if (++count > MAX_FUNCTION_STEPS) {
          const widened = taintWritten(path.state, statement.body, context, mutableNames);
          result.push(...atLine(statement.body, [putLocal(widened, statement.name, null)], line, mutableNames, effects, context));
          break;
        }
        const iteration = paths.map((current) => putLocal(current, statement.name, single(item)));
        result.push(...atLine(statement.body, iteration, line, mutableNames, effects, context));
        paths = runBlock(statement.body, iteration, mutableNames, effects, context);
      }
    }
  }
  return mergeStates(result);
}

function atWhileLine(statement, states, line, mutableNames, effects, context) {
  let active = states.map((state) => ({ state, seen: new Set() }));
  const entries = [];
  let steps = 0;
  while (active.length && steps++ < MAX_FUNCTION_STEPS) {
    const next = [];
    for (const path of active) {
      const signature = key([...path.state.entries()]);
      if (path.seen.has(signature)) continue;
      const seen = new Set(path.seen); seen.add(signature);
      const [yes] = splitWithEffects(path.state, statement.condition, context);
      for (const state of yes) {
        entries.push(...atLine(statement.body, [state], line, mutableNames, effects, context));
        next.push(...runBlock(statement.body, [state], mutableNames, effects, context).map((value) => ({ state: value, seen })));
      }
    }
    active = next.length > LIMIT
      ? [{ state: widenStates(next.map((path) => path.state))[0], seen: new Set() }]
      : next;
  }
  if (active.length) for (const path of active) {
    const widened = copy(path.state);
    for (const name of writes(statement.body)) if (widened.has(name) || mutableNames.has(name)) widened.set(name, null);
    entries.push(...atLine(statement.body, [widened], line, mutableNames, effects, context));
  }
  return mergeStates(entries);
}

function executeFor(statement, state, bounds, mutableNames, effects, context) {
  if (bounds.some((values) => values === null) || bounds.reduce((size, values) => size * values.length, 1) > LIMIT) {
    const next = copy(state);
    for (const name of writes(statement.body)) if (next.has(name) || mutableNames.has(name)) next.set(name, null);
    if (state.has(statement.name) || mutableNames.has(statement.name)) next.set(statement.name, null);
    return [next];
  }
  const result = [];
  const combinations = bounds[0].flatMap((start) => bounds[1].flatMap((stop) => bounds[2].map((step) => [start, stop, step])));
  for (const [start, stop, step] of combinations) {
    if (typeof start !== 'bigint' || typeof stop !== 'bigint' || typeof step !== 'bigint' || step === 0n
      || (start < stop && step < 0n) || (start > stop && step > 0n)) continue;
    const existed = state.has(statement.name), previous = state.get(statement.name);
    let paths = [state], index = start, iterations = 0;
    while (step > 0n ? index <= stop : index >= stop) {
      if (++iterations > MAX_FUNCTION_STEPS) { paths = null; break; }
      paths = runBlock(statement.body, paths.map((path) => put(path, statement.name, single(index))), mutableNames, effects, context);
      if (!paths.length) break;
      index += step;
    }
    if (!paths) {
      const next = copy(state);
      for (const name of writes(statement.body)) if (next.has(name) || mutableNames.has(name)) next.set(name, null);
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
  return result;
}

function executeEach(statement, state, iterables, mutableNames, effects, context) {
  const frameKey = localKey(statement.name), hadLocal = state.has(frameKey), previous = state.get(frameKey);
  const restore = (path) => {
    const next = copy(path);
    if (hadLocal) next.set(frameKey, previous); else next.delete(frameKey);
    return next;
  };
  if (iterables === null) {
    const body = runBlock(statement.body, [putLocal(state, statement.name, null)], mutableNames, effects, context)
      .map((path) => restore(taintWritten(path, statement.body, context, mutableNames)));
    return mergeStates([state, ...body]);
  }
  const result = [];
  for (const iterable of iterables) {
    if (!Array.isArray(iterable)) return [taintWritten(state, statement.body, context, mutableNames)];
    let paths = [state], count = 0;
    for (const item of iterable) {
      if (++count > MAX_FUNCTION_STEPS) { paths = paths.map((path) => taintWritten(path, statement.body, context, mutableNames)); break; }
      paths = runBlock(statement.body, paths.map((path) => putLocal(path, statement.name, single(item))), mutableNames, effects, context);
    }
    result.push(...paths.map(restore));
  }
  return mergeStates(result);
}

function execute(statement, states, mutableNames, effects, context) {
  states = ['declare', 'set', 'unset', 'call', 'command', 'choice', 'if', 'for', 'forEach', 'while', 'parallel'].includes(statement.kind)
    ? states : taintCalls(statement, states, mutableNames, effects, context);
  const result = [];
  for (const state of states) {
    if (statement.kind === 'declare') {
      const initial = statement.initial ? evaluateWithEffects(statement.initial, state, context)
        : [{ state, values: single(statement.type === 'int' ? 0n : statement.type === 'float' ? 0 : statement.type === 'str' ? '' : statement.type === 'bool' ? false : statement.type?.kind === 'list' ? [] : {}) }];
      result.push(...initial.map((path) => put(path.state, statement.name, path.values)));
    } else if (statement.kind === 'set' || statement.kind === 'unset') {
      let target = statement.target;
      while (target?.kind === 'index') target = target.target;
      if (!target?.name) { result.push(state); continue; }
      const values = statement.kind === 'set' ? evaluateWithEffects(statement.value, state, context) : [{ state, values: [null] }];
      for (const path of values) {
        if (statement.target.kind === 'variable' && statement.kind === 'set') result.push(put(path.state, target.name, path.values));
        else for (const keyPath of evaluateWithEffects(statement.target.key, path.state, context)) {
          const objects = get(keyPath.state, target.name);
          result.push(put(keyPath.state, target.name, updateObjectKeys(keyPath.state, statement.target, objects, keyPath.values, path.values, statement.kind === 'unset')));
        }
      }
    } else if (statement.kind === 'if') {
      let remaining = [state];
      for (const branch of [{ condition: statement.condition, body: statement.body }, ...statement.elseIf]) {
        const yes = [], no = [];
        for (const item of remaining) { const parts = splitWithEffects(item, branch.condition, context); yes.push(...parts[0]); no.push(...parts[1]); }
        result.push(...runBlock(branch.body, yes, mutableNames, effects, context)); remaining = no;
      }
      result.push(...runBlock(statement.otherwise, remaining, mutableNames, effects, context));
    } else if (statement.kind === 'choice') {
      for (const choiceState of executeChoiceEffects(statement, state, context)) for (const option of statement.options)
        result.push(...runBlock(option.body, [choiceState], mutableNames, effects, context));
    } else if (statement.kind === 'for') {
      for (const bounds of evaluateArguments([statement.start, statement.stop, statement.step], state, context))
        result.push(...executeFor(statement, bounds.state, bounds.args, mutableNames, effects, context));
    } else if (statement.kind === 'forEach') {
      for (const iterable of evaluateWithEffects(statement.iterable, state, context))
        result.push(...executeEach(statement, iterable.state, iterable.values, mutableNames, effects, context));
    } else if (statement.kind === 'while') {
      result.push(...runWhile(statement, [state], mutableNames, effects, context));
    } else if (statement.kind === 'parallel') {
      result.push(...runBlock(statement.body, [state], mutableNames, effects, context));
    } else if (statement.kind === 'command') {
      result.push(...executeCommandEffects(statement, state, context));
    } else if (statement.kind === 'call') {
      const fn = context.functions.get(statement.name);
      for (const call of evaluateArguments(statement.args, state, context)) {
        const outcomes = fn && call.args.every((values) => values !== null)
          ? invokeFunction(fn, call.state, call.args, context) : null;
        if (outcomes) result.push(...outcomes.map((outcome) => outcome.state));
        else result.push(taintFunctionCall(call.state, statement.name, effects.get(statement.name), mutableNames));
      }
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
        let remaining = states;
        for (const branch of [{ condition: statement.condition, body: statement.body }, ...statement.elseIf]) {
          if (branch.body.some((item) => line >= item.line && line <= (item.endLine || item.line))) {
            const yes = remaining.flatMap((item) => splitWithEffects(item, branch.condition, context)[0]);
            return atLine(branch.body, yes, line, mutableNames, effects, context);
          }
          remaining = remaining.flatMap((item) => splitWithEffects(item, branch.condition, context)[1]);
        }
        return atLine(statement.otherwise, remaining, line, mutableNames, effects, context);
      }
      if (statement.kind === 'choice') {
        const option = statement.options.find((item) => item.body.some((part) => line >= part.line && line <= (part.endLine || part.line)));
        const choiceStates = states.flatMap((state) => executeChoiceEffects(statement, state, context));
        return option ? atLine(option.body, choiceStates, line, mutableNames, effects, context) : choiceStates;
      }
      if (statement.kind === 'forEach') return atEachLine(statement, states, line, mutableNames, effects, context);
      if (statement.kind === 'parallel') return atLine(statement.body, states, line, mutableNames, effects, context);
      if (statement.kind === 'for' || statement.kind === 'while') {
        return statement.kind === 'for'
          ? atForLine(statement, states, line, mutableNames, effects, context)
          : atWhileLine(statement, states, line, mutableNames, effects, context);
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

function configuredDomain(constraint) {
  if (constraint?.values) return domain([...constraint.values]);
  if (constraint?.type !== 'int' || constraint.min === undefined || constraint.max === undefined) return null;
  const count = constraint.max - constraint.min + 1n;
  // Keep a bounded interval finite only when every candidate fits the same
  // cap as ordinary path unions; never truncate a larger configured range.
  if (count <= 0n || count > BigInt(LIMIT)) return null;
  return domain(Array.from({ length: Number(count) }, (_, index) => constraint.min + BigInt(index)));
}

function templateTypeTag(type) {
  if (type === 'int' || type === 'float' || type === 'str' || type === 'bool') return type;
  if (!type || type === 'infer' || type === 'none') return null;
  if (type.kind === 'dict') return `dict:${type.value}`;
  if (type.kind === 'list') return `list:${type.value}`;
  if (type.kind === 'struct') return `struct:${type.name}`;
  if (typeof type === 'string') return `struct:${type}`;
  return null;
}

function collectTemplateTypes(script, staticDeclarations, externalCharacters, externalGlobalTypes) {
  const variables = new Map();
  const structFields = new Map();
  const addVariable = (name, type) => {
    const tag = templateTypeTag(type);
    if (!name || !tag) return;
    if (!variables.has(name)) variables.set(name, new Set());
    variables.get(name).add(tag);
  };
  const visit = (statements = []) => {
    for (const statement of statements) {
      if (statement.kind === 'declare') addVariable(statement.name, statement.type);
      else if (statement.kind === 'for') {
        addVariable(statement.name, 'int');
        visit(statement.body);
      } else if (statement.kind === 'forEach') {
        const iterable = statement.iterable;
        let elementType = null;
        if (iterable?.kind === 'call' && iterable.name === 'text.split') elementType = 'str';
        else if (iterable?.kind === 'list' && iterable.items.length) {
          const item = iterable.items[0];
          elementType = item.kind === 'float' ? 'float' : item.kind === 'literal'
            ? typeof item.value === 'string' ? 'str' : typeof item.value === 'boolean' ? 'bool' : 'int' : null;
        }
        addVariable(statement.name, elementType);
        visit(statement.body);
      } else if (statement.kind === 'if') {
        visit(statement.body);
        statement.elseIf.forEach((branch) => visit(branch.body));
        visit(statement.otherwise);
      } else if (statement.kind === 'while' || statement.kind === 'parallel') visit(statement.body);
      else if (statement.kind === 'choice') statement.options.forEach((option) => visit(option.body));
    }
  };
  for (const statement of [...(staticDeclarations || []), ...(script.globals || []), ...(script.body || [])]) {
    if (statement.kind === 'declare') addVariable(statement.name, statement.type);
  }
  for (const scene of script.scenes || []) visit(scene.body);
  for (const fn of script.functions || []) {
    fn.params.forEach((param) => addVariable(param.name, param.type));
    visit(fn.body);
  }
  for (const [name, type] of externalGlobalTypes || []) addVariable(name, type);

  for (const struct of script.structs || []) {
    structFields.set(`struct:${struct.name}`, Object.fromEntries(Object.entries(struct.fields).map(([name, type]) => [name, type])));
  }
  for (const character of [...(script.characters || []), ...(externalCharacters || [])]) {
    const fields = Object.fromEntries(character.properties.map((property) => [
      property.name, property.value.kind === 'float' ? 'float' : property.value.kind === 'literal'
        ? typeof property.value.value === 'string' ? 'str' : typeof property.value.value === 'number' || typeof property.value.value === 'bigint' ? 'int' : null
        : null,
    ]));
    const tag = `struct:character:${character.name}`;
    structFields.set(tag, fields);
    addVariable(character.name, { kind: 'struct', name: `character:${character.name}` });
  }
  return { variables, structFields };
}

function sceneGlobalNames(scenes = []) {
  const names = new Set();
  const visit = (block) => {
    for (const statement of block || []) {
      if (statement.kind === 'declare') names.add(statement.name);
      else if (statement.kind === 'if') {
        visit(statement.body); statement.elseIf.forEach((branch) => visit(branch.body)); visit(statement.otherwise);
      } else if (statement.kind === 'for' || statement.kind === 'forEach' || statement.kind === 'while') visit(statement.body);
      // Choice bodies run in a temporary runtime frame, invisible to functions.
    }
  };
  scenes.forEach((scene) => visit(scene.body));
  return names;
}

function analyzeStartDomains(script, sceneName, line, names, staticDeclarations = [], entryScene = true, constraints = new Map(), externalCharacters = [], externalGlobalNames = [], externalGlobalTypes = new Map()) {
  const scene = script.scenes.find((item) => item.name === sceneName);
  if (!scene) throw Error(`Unknown scene: ${sceneName}`);
  const mutableNames = new Set(names);
  const effects = functionWriteEffects(script);
  const globalNames = new Set([
    ...names,
    ...externalGlobalNames,
    ...sceneGlobalNames(script.scenes),
    ...script.globals.filter((item) => item.kind === 'declare').map((item) => item.name),
    ...staticDeclarations.filter((item) => item.kind === 'declare').map((item) => item.name),
    ...characterStateDeclarations([...script.characters, ...externalCharacters]).map((item) => item.name),
  ]);
  const context = {
    functions: new Map((script.functions || []).map((fn) => [fn.name, fn])), effects, stack: [], globalNames, mutableNames,
    templateTypes: collectTemplateTypes(script, staticDeclarations, externalCharacters, externalGlobalTypes),
  };
  // Project-level character files are linked into every compiled scene file.
  // Seed their constant fields too, so a direct test start has the same known
  // display-name/character state as a normal transfer from the defining file.
  let states = runBlock([...characterStateDeclarations([...script.characters, ...externalCharacters]), ...staticDeclarations], [new Map()], mutableNames, effects, context);
  states = runBlock(script.globals, states, mutableNames, effects, context);
  // Scene Flow starts the selected file as a fresh runtime and then selects a
  // scene directly. The selected scene's ordinal within the file therefore
  // does not imply that earlier scenes executed.
  if (!entryScene) {
    const globals = [...staticDeclarations, ...script.globals].filter((item) => item.kind === 'declare' && !item.constant);
    states = states.map((state) => { const next = copy(state); globals.forEach((item) => next.set(item.name, null)); return next; });
  }
  if (states.length && constraints.size) {
    const configured = [...constraints].map(([name, constraint]) => [name, configuredDomain(constraint)]).filter(([, values]) => values !== null);
    states = states.map((state) => {
      let next = state;
      for (const [name, values] of configured) if (get(next, name) === null) next = put(next, name, values);
      return next;
    });
  }
  if (line > Number(scene.line || 0)) states = atLine(scene.body, states, line, mutableNames, effects, context);
  const result = {};
  for (const name of names) {
    let values = [];
    for (const state of states) { values = union(values, readBinding(state, name)); if (values === null) break; }
    if (values === null) values = configuredDomain(constraints.get(name));
    result[name] = values === null || !states.length ? { kind: 'unknown', values: [] } : {
      kind: values.length === 1 ? 'exact' : 'finite',
      values: values.map((item) => typeof item === 'bigint' ? String(item) : typeof item === 'string' ? item : JSON.stringify(item, (_name, value) => typeof value === 'bigint' ? String(value) : value)),
    };
  }
  return result;
}

module.exports = { analyzeStartDomains, characterStateDeclarations };
