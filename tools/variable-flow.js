'use strict';
const { sceneFile } = require('./project');
const { isPureBuiltin } = require('../dist/language/builtins');

function constant(expr, constants = new Map()) {
  if (!expr) return undefined;
  if (expr.kind === 'integer') return BigInt(expr.value);
  if (expr.kind === 'literal') return typeof expr.value === 'number' ? BigInt(expr.value) : expr.value;
  if (expr.kind === 'load') return constants.get(expr.name);
  if (expr.kind === 'list') {
    const items = expr.items.map((item) => constant(item, constants));
    return items.every((value) => value !== undefined) ? items : undefined;
  }
  if (expr.kind === 'call') {
    const argument = expr.args.length === 1 ? constant(expr.args[0], constants) : undefined;
    if (expr.name === 'str' && typeof argument === 'bigint') return String(argument);
    if (expr.name === 'int' && typeof argument === 'string' && /^[+-]?\d+$/.test(argument)) {
      try { return BigInt(argument); } catch { return undefined; }
    }
    return undefined;
  }
  if (expr.kind === 'unary') {
    const value = constant(expr.value, constants);
    if (value === undefined) return undefined;
    return expr.operator === 'not' ? !value : expr.operator === '-' ? -value : value;
  }
  if (expr.kind !== 'binary') return undefined;
  const a = constant(expr.left, constants), b = constant(expr.right, constants);
  if (expr.operator === 'and' && a === false) return false;
  if (expr.operator === 'or' && a === true) return true;
  if (a === undefined || b === undefined) return undefined;
  switch (expr.operator) {
    case '==': return a === b; case '!=': return a !== b;
    case '<': return a < b; case '<=': return a <= b; case '>': return a > b; case '>=': return a >= b;
    case 'and': return a && b; case 'or': return a || b;
    case '+': return a + b; case '-': return a - b; case '*': return a * b;
    case '/': return b === 0n ? undefined : a / b; case '%': return b === 0n ? undefined : a % b;
  }
}

function definitelyRunsFor(instruction, constants = new Map()) {
  const start = constant(instruction.start, constants);
  const stop = constant(instruction.stop, constants);
  const step = constant(instruction.step, constants);
  if (typeof start !== 'bigint' || typeof stop !== 'bigint' || typeof step !== 'bigint' || step === 0n) return false;
  return !((start < stop && step < 0n) || (start > stop && step > 0n));
}

function knownValue(expr, state) {
  const values = new Map(state.constants);
  for (const [name, value] of state.strings) values.set(name, value);
  return constant(expr, values);
}

function possibleStringValues(expr, state, callResults = new Map()) {
  if (!expr) return new Set();
  if (expr.kind === 'literal') return typeof expr.value === 'string' ? new Set([expr.value]) : new Set();
  if (expr.kind === 'load') return new Set(state.possibleStrings.get(expr.name) || (state.strings.has(expr.name) ? [state.strings.get(expr.name)] : []));
  if (expr.kind === 'binary' && expr.operator === '+') {
    const left = possibleStringValues(expr.left, state, callResults), right = possibleStringValues(expr.right, state, callResults), result = new Set();
    for (const a of left) for (const b of right) result.add(a + b);
    return result;
  }
  if (expr.kind === 'call') {
    const returned = callResults.get(expr);
    if (returned?.length) return new Set(returned.filter(value => typeof value === 'string'));
  }
  const value = knownValue(expr, state);
  return typeof value === 'string' ? new Set([value]) : new Set();
}

function stringCandidates(expr, state, callResults = new Map()) {
  const candidates = possibleStringValues(expr, state, callResults);
  const value = knownValue(expr, state);
  if (typeof value === 'string') candidates.add(value);
  return candidates;
}

function nestedStringValues(expr, state, callResults = new Map(), dictionaryResults = new Map()) {
  if (!expr) return new Set();
  if (expr.kind === 'literal') return typeof expr.value === 'string' ? new Set([expr.value]) : new Set();
  if (expr.kind === 'load') {
    const values = new Set(state.possibleDictionaries.get(expr.name) || []);
    for (const value of state.possibleStrings.get(expr.name) || []) values.add(value);
    if (state.strings.has(expr.name)) values.add(state.strings.get(expr.name));
    return values;
  }
  if (expr.kind === 'dict') {
    const values = new Set();
    for (const entry of expr.entries) for (const value of nestedStringValues(entry.value, state, callResults, dictionaryResults)) values.add(value);
    return values;
  }
  if (expr.kind === 'list') {
    const values = new Set();
    for (const item of expr.items) for (const value of nestedStringValues(item, state, callResults, dictionaryResults)) values.add(value);
    return values;
  }
  if (expr.kind === 'binary' && expr.operator === '+') return possibleStringValues(expr, state, callResults);
  if (expr.kind === 'call') {
    const values = new Set();
    for (const value of callResults.get(expr) || []) if (typeof value === 'string') values.add(value);
    for (const value of dictionaryResults.get(expr) || []) if (typeof value === 'string') values.add(value);
    return values;
  }
  if (expr.kind === 'index') return nestedStringValues(expr.target, state, callResults, dictionaryResults);
  return new Set();
}

function dictionaryAliases(expr, state, aliasResults = new Map()) {
  if (!expr) return new Set();
  if (expr.kind === 'load') return new Set(state.dictionaryAliases.get(expr.name) || [expr.name]);
  if (expr.kind === 'call') return new Set(aliasResults.get(expr) || []);
  if (expr.kind === 'index') return dictionaryAliases(expr.target, state, aliasResults);
  return new Set();
}

function addDictionaryCandidates(state, name, candidates) {
  if (!candidates.size) return;
  const names = new Set([name, ...(state.dictionaryAliases.get(name) || [])]);
  for (const relatedName of names) {
    const values = new Set(state.possibleDictionaries.get(relatedName) || []);
    for (const value of candidates) values.add(value);
    state.possibleDictionaries.set(relatedName, values);
  }
}

function cloneDictionaryKeys(dictionaryKeys) {
  return new Map([...dictionaryKeys].map(([name, keys]) => [name, new Map(keys)]));
}

function dictionaryKeysForExpression(expr, state, keyResults = new Map()) {
  if (!expr) return undefined;
  if (expr.kind === 'dict') return new Map(expr.entries.map(entry => [entry.key, true]));
  if (expr.kind === 'load') {
    const keys = state.dictionaryKeys.get(expr.name);
    return keys ? new Map(keys) : undefined;
  }
  if (expr.kind === 'call') {
    const keys = keyResults.get(expr);
    return keys ? new Map(keys) : undefined;
  }
  return undefined;
}

function knownDictionaryKey(expr, state) {
  const value = knownValue(expr, state);
  return typeof value === 'string' ? value : undefined;
}

function dictionaryClosedForExpression(expr, state, closedResults = new Map()) {
  if (!expr) return true;
  if (expr.kind === 'dict') return true;
  if (expr.kind === 'load') return state.dictionaryClosed.get(expr.name);
  if (expr.kind === 'call') return closedResults.get(expr);
  return undefined;
}

function builtinResult(name, facts) {
  const values = (index) => [...(facts[index]?.strings || [])];
  const product = (arrays, visit) => {
    if (arrays.some((items) => !items.length)) return;
    const walk = (index, current) => {
      if (index === arrays.length) { visit(current); return; }
      for (const item of arrays[index]) walk(index + 1, [...current, item]);
    };
    walk(0, []);
  };
  const result = { strings: [], dictionaries: [], aliases: [], dictionaryKeys: undefined, dictionaryClosed: undefined };
  if (name === 'text.trim' || name === 'text.normalize_space') {
    product([values(0)], ([value]) => {
      const trimmed = name === 'text.trim'
        ? value.replace(/^[ \t\n\r\f\v\u00a0\u3000]+|[ \t\n\r\f\v\u00a0\u3000]+$/gu, '')
        : value.replace(/[ \t\n\r\f\v\u00a0\u3000]+/gu, ' ').replace(/^ | $/g, '');
      result.strings.push(trimmed);
    });
  } else if (name === 'text.split') {
    product([values(0), values(1)], ([value, separator]) => {
      if (separator) result.dictionaries.push(...value.split(separator));
    });
  } else if (name === 'text.replace') {
    product([values(0), values(1), values(2)], ([value, search, replacement]) => {
      if (search) result.strings.push(value.split(search).join(replacement));
    });
  } else if (name === 'list.append') {
    result.dictionaries.push(...(facts[0]?.dictionaries || []), ...(facts[1]?.strings || []));
  } else if (name === 'str' && facts[0]?.constant !== undefined) {
    const value = facts[0].constant;
    if (typeof value === 'string' || typeof value === 'bigint' || typeof value === 'number' || typeof value === 'boolean') result.strings.push(String(value));
  }
  result.strings = [...new Set(result.strings)];
  result.dictionaries = [...new Set(result.dictionaries)];
  return result;
}

// Follow executable instructions, preserving the definitions at each transfer.
// Declarations after a goto/return must never initialize its destination.
function validateVariableFlow(files, entry) {
  const pending = [{ file: entry, scene: null, defined: new Set(), locals: new Set(), constants: new Map(), strings: new Map(), possibleStrings: new Map(), possibleDictionaries: new Map(), dictionaryAliases: new Map(), dictionaryKeys: new Map(), dictionaryClosed: new Map(), writes: new Map() }];
  const visited = new Set();
  const clone = state => ({
    defined: new Set(state.defined),
    locals: new Set(state.locals),
    constants: new Map(state.constants),
    strings: new Map(state.strings),
    possibleStrings: new Map([...state.possibleStrings].map(([name, values]) => [name, new Set(values)])),
    possibleDictionaries: new Map([...state.possibleDictionaries].map(([name, values]) => [name, new Set(values)])),
    dictionaryAliases: new Map([...state.dictionaryAliases].map(([name, values]) => [name, new Set(values)])),
    dictionaryKeys: cloneDictionaryKeys(state.dictionaryKeys),
    dictionaryClosed: new Map(state.dictionaryClosed),
    writes: new Map(state.writes),
  });
  const stateKey = state => [
    [...state.defined].sort(),
    [...state.locals].sort(),
    [...state.constants.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([name, value]) => [name, typeof value === 'bigint' ? value.toString() : value]),
    [...state.strings.entries()].sort(([left], [right]) => left.localeCompare(right)),
    [...state.possibleStrings.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([name, values]) => [name, [...values].sort()]),
    [...state.possibleDictionaries.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([name, values]) => [name, [...values].sort()]),
    [...state.dictionaryAliases.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([name, values]) => [name, [...values].sort()]),
    [...state.dictionaryKeys.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([name, keys]) => [name, [...keys.entries()].sort(([left], [right]) => left.localeCompare(right))]),
    [...state.dictionaryClosed.entries()].sort(([left], [right]) => left.localeCompare(right)),
    [...state.writes.entries()].sort(([left], [right]) => left.localeCompare(right)),
  ];
  while (pending.length) {
    const current = pending.pop();
    const key = JSON.stringify([current.file, current.scene, stateKey(current)], (_name, value) => typeof value === 'bigint' ? `#int:${value}` : value);
    if (visited.has(key)) continue;
    visited.add(key);
    const program = files[current.file];
    if (!program) throw Error(`遷移先 '${current.file}' がパッケージに含まれていません`);
    const functions = new Map(program.functions.map(fn => [fn.name, fn]));
    const scenes = new Map(program.scenes.map(scene => [scene.name, scene.instructions]));
    const requireName = (name, state) => {
      if (!state.locals.has(name) && !state.defined.has(name)) throw Error(`シーン '${current.file}' で初期化前のグローバル変数を参照しています: ${name}`);
    };
    const calls = new Set();
    function invoke(name, state, argumentFacts = []) {
      const fn = functions.get(name);
      if (fn && !calls.has(fn.name)) {
        calls.add(fn.name);
        const parameterNames = new Set(fn.params.map(param => param.name));
        const globals = new Set([...state.defined].filter(variable => !state.locals.has(variable) && !parameterNames.has(variable)));
        for (const fact of argumentFacts) for (const alias of fact.aliases || []) {
          if (state.defined.has(alias) && !state.locals.has(alias)) globals.add(alias);
        }
        const constants = new Map([...state.constants].filter(([variable]) => globals.has(variable)));
        const strings = new Map([...state.strings].filter(([variable]) => globals.has(variable)));
        const possibleStrings = new Map([...state.possibleStrings].filter(([variable]) => globals.has(variable)).map(([name, values]) => [name, new Set(values)]));
        const possibleDictionaries = new Map([...state.possibleDictionaries].filter(([variable]) => globals.has(variable)).map(([name, values]) => [name, new Set(values)]));
        const aliases = new Map([...state.dictionaryAliases].filter(([variable]) => globals.has(variable)).map(([name, values]) => [name, new Set(values)]));
        const dictionaryKeys = cloneDictionaryKeys(new Map([...state.dictionaryKeys].filter(([variable]) => globals.has(variable))));
        const dictionaryClosed = new Map([...state.dictionaryClosed].filter(([variable]) => globals.has(variable)));
        for (let index = 0; index < fn.params.length; index++) {
          const parameter = fn.params[index];
          const fact = argumentFacts[index];
          if (!fact) continue;
          if (fact.constant !== undefined) constants.set(parameter.name, fact.constant);
          if (fact.strings?.size === 1) strings.set(parameter.name, [...fact.strings][0]);
          if (fact.strings?.size) possibleStrings.set(parameter.name, new Set(fact.strings));
          if (fact.dictionaries?.size) possibleDictionaries.set(parameter.name, new Set(fact.dictionaries));
          if (fact.aliases?.size) aliases.set(parameter.name, new Set(fact.aliases));
          if (fact.dictionaryKeys) dictionaryKeys.set(parameter.name, new Map(fact.dictionaryKeys));
          if (typeof fact.dictionaryClosed === 'boolean') dictionaryClosed.set(parameter.name, fact.dictionaryClosed);
        }
        const returned = [];
        const returnedDictionaries = [];
        const returnedAliases = [];
        const returnedDictionaryKeys = [];
        const returnedDictionaryClosed = [];
        const terminals = [];
        const fallThrough = walk(fn.body, [{ defined: new Set(state.defined), locals: parameterNames, constants, strings, possibleStrings, possibleDictionaries, dictionaryAliases: aliases, dictionaryKeys, dictionaryClosed, writes: new Map() }], false, returned, terminals, returnedDictionaries, returnedAliases, returnedDictionaryKeys, returnedDictionaryClosed);
        calls.delete(fn.name);
        // A user function may mutate any global used later. Keep only facts that
        // can be re-established by subsequent statements.
        const beforeStrings = new Map(state.strings);
        const beforePossibleStrings = new Map([...state.possibleStrings].map(([name, values]) => [name, new Set(values)]));
        const beforePossibleDictionaries = new Map([...state.possibleDictionaries].map(([name, values]) => [name, new Set(values)]));
        const beforeDictionaryAliases = new Map([...state.dictionaryAliases].map(([name, values]) => [name, new Set(values)]));
        // A function cannot access the caller's lexical locals. Preserve their
        // flow facts across the call and invalidate only globals whose effects
        // may have changed. Dictionary arguments are copied by the runtime;
        // global aliases are re-established below from the callee outcomes.
        for (const variable of globals) {
          state.constants.delete(variable);
          state.strings.delete(variable);
          state.possibleStrings.delete(variable);
          state.possibleDictionaries.delete(variable);
          state.dictionaryAliases.delete(variable);
          state.dictionaryKeys.delete(variable);
          state.dictionaryClosed.delete(variable);
        }
        const outcomes = [...fallThrough, ...terminals];
        for (const variable of globals) {
          const values = outcomes.map(outcome => outcome.writes.has(variable) ? outcome.writes.get(variable) : beforePossibleStrings.get(variable) || (beforeStrings.has(variable) ? new Set([beforeStrings.get(variable)]) : new Set()));
          const candidates = new Set(values.flatMap(value => typeof value === 'string' ? [value] : value));
          if (candidates.size) state.possibleStrings.set(variable, candidates);
          const nestedValues = outcomes.map(outcome => {
            const localAlias = outcome.locals.has(variable) && !(outcome.dictionaryAliases.get(variable)?.has(variable));
            return outcome.writes.has(variable) ? outcome.possibleDictionaries.get(variable) || new Set() : localAlias ? beforePossibleDictionaries.get(variable) || new Set() : outcome.possibleDictionaries.get(variable) || beforePossibleDictionaries.get(variable) || new Set();
          });
          const nestedCandidates = new Set(nestedValues.flatMap(value => value instanceof Set ? [...value] : typeof value === 'string' ? [value] : []));
          if (nestedCandidates.size) state.possibleDictionaries.set(variable, nestedCandidates);
          const aliasValues = outcomes.map(outcome => {
            const localAlias = outcome.locals.has(variable) && !(outcome.dictionaryAliases.get(variable)?.has(variable));
            if (localAlias) return beforeDictionaryAliases.get(variable) || new Set();
            return outcome.dictionaryAliases.get(variable) || (outcome.writes.has(variable) ? new Set() : beforeDictionaryAliases.get(variable) || new Set());
          });
          const aliasCandidates = new Set(aliasValues.flatMap(value => [...value]));
          const hasGlobalAliasWrite = outcomes.some(outcome => outcome.writes.has(variable) && !(outcome.locals.has(variable) && !(outcome.dictionaryAliases.get(variable)?.has(variable))));
          if (aliasCandidates.size) state.dictionaryAliases.set(variable, aliasCandidates);
          else if (hasGlobalAliasWrite) state.dictionaryAliases.delete(variable);
          const definiteValues = outcomes.map(outcome => {
            if (outcome.writes.has(variable)) return outcome.writes.get(variable);
            const before = beforePossibleStrings.get(variable);
            return before?.size === 1 ? [...before][0] : beforeStrings.get(variable);
          });
          if (definiteValues.length && definiteValues.every(value => typeof value === 'string' && value === definiteValues[0])) {
            state.strings.set(variable, definiteValues[0]);
          }
          const keyFacts = outcomes.map(outcome => outcome.dictionaryKeys.get(variable));
          const commonKeys = new Map();
          const keyNames = new Set(keyFacts.flatMap(facts => facts ? [...facts.keys()] : []));
          for (const key of keyNames) {
            const values = keyFacts.map(facts => facts?.get(key));
            if (values.every(value => typeof value === 'boolean' && value === values[0])) commonKeys.set(key, values[0]);
          }
          if (commonKeys.size) state.dictionaryKeys.set(variable, commonKeys);
          else if (keyFacts.some(facts => facts)) state.dictionaryKeys.delete(variable);
          const closedFacts = outcomes.map(outcome => outcome.dictionaryClosed.get(variable));
          if (closedFacts.length && closedFacts.every(value => typeof value === 'boolean' && value === closedFacts[0])) state.dictionaryClosed.set(variable, closedFacts[0]);
          else if (closedFacts.some(value => typeof value === 'boolean')) state.dictionaryClosed.delete(variable);
        }
        const written = new Set(outcomes.flatMap(outcome => [...outcome.writes.keys()]));
        for (const variable of written) {
          const values = outcomes.map(outcome => outcome.writes.get(variable));
          if (outcomes.every(outcome => outcome.writes.has(variable)) && values.every(value => value === values[0])) state.writes.set(variable, values[0]);
          else state.writes.set(variable, undefined);
        }
        const firstReturnedKeys = returnedDictionaryKeys[0];
        const sameReturnedKeys = returnedDictionaryKeys.length > 0 && firstReturnedKeys && returnedDictionaryKeys.every(keys => keys && keys.size === firstReturnedKeys.size && [...firstReturnedKeys].every(([key, value]) => keys.get(key) === value));
        const firstReturnedClosed = returnedDictionaryClosed[0];
        const sameReturnedClosed = returnedDictionaryClosed.length > 0 && typeof firstReturnedClosed === 'boolean' && returnedDictionaryClosed.every(closed => closed === firstReturnedClosed);
        return {
          strings: returned,
          dictionaries: returnedDictionaries,
          aliases: returnedAliases,
          dictionaryKeys: sameReturnedKeys ? new Map(firstReturnedKeys) : undefined,
          dictionaryClosed: sameReturnedClosed ? firstReturnedClosed : undefined,
        };
      }
      return { strings: [], dictionaries: [], aliases: [], dictionaryKeys: undefined, dictionaryClosed: undefined };
    }
    function inspectString(value, state) {
      const knownStrings = new Map(state.strings), callsToInspect = [];
      const collect = (current, seen) => {
        if (typeof current !== 'string') return;
        for (const match of current.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)(?:\.[A-Za-z_][A-Za-z0-9_]*)*\}/g)) {
          const name = match[1];
          requireName(name, state);
          const nestedValues = new Set(state.possibleDictionaries.get(name) || []);
          for (const nestedValue of state.possibleStrings.get(name) || []) nestedValues.add(nestedValue);
          if (knownStrings.has(name)) nestedValues.add(knownStrings.get(name));
          if (nestedValues.size && !seen.has(name)) {
            const nested = new Set(seen);
            nested.add(name);
            for (const nestedValue of nestedValues) collect(nestedValue, nested);
          }
        }
        for (const match of current.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\(\)\}/g)) callsToInspect.push(match[1]);
      };
      collect(value, new Set());
      for (const name of callsToInspect) invoke(name, state);
    }
    function expression(expr, state, callResults = new Map(), dictionaryResults = new Map(), aliasResults = new Map(), checkIndexedRead = true, keyResults = new Map(), closedResults = new Map()) {
      if (!expr) return [];
      const returned = [];
      const append = values => returned.push(...values);
      if (expr.kind === 'load') requireName(expr.name, state);
      if (expr.kind === 'binary') {
        append(expression(expr.left, state, callResults, dictionaryResults, aliasResults, true, keyResults, closedResults));
        const left = constant(expr.left, state.constants);
        if (!((expr.operator === 'and' && left === false) || (expr.operator === 'or' && left === true))) append(expression(expr.right, state, callResults, dictionaryResults, aliasResults, true, keyResults, closedResults));
      }
      if (expr.kind === 'unary') append(expression(expr.value, state, callResults, dictionaryResults, aliasResults, true, keyResults, closedResults));
      if (expr.kind === 'list') expr.items.forEach(item => append(expression(item, state, callResults, dictionaryResults, aliasResults, true, keyResults, closedResults)));
      if (expr.kind === 'index') {
        append(expression(expr.target, state, callResults, dictionaryResults, aliasResults, true, keyResults, closedResults));
        append(expression(expr.key, state, callResults, dictionaryResults, aliasResults, true, keyResults, closedResults));
        if (checkIndexedRead && expr.target.kind === 'load') {
          const key = knownDictionaryKey(expr.key, state), facts = state.dictionaryKeys.get(expr.target.name);
          const closed = state.dictionaryClosed.get(expr.target.name);
          if (key !== undefined && (facts?.get(key) === false || (closed === true && !facts?.has(key)))) throw Error(`繧ｷ繝ｼ繝ｳ '${current.file}' 縺ｧ蟄伜惠縺励↑縺・せ樊嶌繧ｭ繝ｼ '${key}' 繧貞・譁ｰ縺励※縺・∪縺吶・`);
        }
      }
      if (expr.kind === 'dict') expr.entries.forEach(item => append(expression(item.value, state, callResults, dictionaryResults, aliasResults, true, keyResults, closedResults)));
      if (expr.kind === 'call') {
        const argumentFacts = [];
        for (const arg of expr.args) {
          append(expression(arg, state, callResults, dictionaryResults, aliasResults, true, keyResults, closedResults));
          argumentFacts.push({
            constant: knownValue(arg, state),
            strings: stringCandidates(arg, state, callResults),
            dictionaries: nestedStringValues(arg, state, callResults, dictionaryResults),
            aliases: dictionaryAliases(arg, state, aliasResults),
            dictionaryKeys: dictionaryKeysForExpression(arg, state, keyResults),
            dictionaryClosed: dictionaryClosedForExpression(arg, state, closedResults),
          });
        }
        const result = isPureBuiltin(expr.name) ? builtinResult(expr.name, argumentFacts) : invoke(expr.name, state, argumentFacts);
        callResults.set(expr, result.strings);
        dictionaryResults.set(expr, result.dictionaries);
        aliasResults.set(expr, result.aliases);
        keyResults.set(expr, result.dictionaryKeys);
        closedResults.set(expr, result.dictionaryClosed);
        append(result.strings);
      }
      return returned;
    }
    function textExpression(expr, state) {
      const callResults = new Map();
      const dictionaryResults = new Map();
      const aliasResults = new Map();
      const keyResults = new Map();
      const closedResults = new Map();
      const returned = expression(expr, state, callResults, dictionaryResults, aliasResults, true, keyResults, closedResults);
      for (const value of returned) inspectString(value, state);
      for (const value of possibleStringValues(expr, state, callResults)) inspectString(value, state);
      for (const value of nestedStringValues(expr, state, callResults, dictionaryResults)) inspectString(value, state);
    }
    function walk(list, states, globalScope, returned = [], terminals = [], returnedDictionaries = [], returnedAliases = [], returnedDictionaryKeys = [], returnedDictionaryClosed = []) {
      for (const instruction of list) {
        const next = [];
        for (const state of states) {
          const c = instruction;
          if (c.op === 'declare') {
            const existing = globalScope && state.defined.has(c.name);
            const callResults = new Map();
            const dictionaryResults = new Map();
            const aliasResults = new Map();
            const keyResults = new Map();
            const closedResults = new Map();
            if (!existing) expression(c.initial, state, callResults, dictionaryResults, aliasResults, true, keyResults, closedResults);
            (globalScope ? state.defined : state.locals).add(c.name);
            if (c.constant && !existing) {
              const value = constant(c.initial, state.constants);
              if (value === undefined) state.constants.delete(c.name); else state.constants.set(c.name, value);
            } else if (!c.constant) state.constants.delete(c.name);
            const initialCandidates = stringCandidates(c.initial, state, callResults);
            const initialString = initialCandidates.size === 1 ? [...initialCandidates][0] : undefined;
            if (typeof initialString === 'string') state.strings.set(c.name, initialString);
            else if (!existing || !c.constant) state.strings.delete(c.name);
            if (initialCandidates.size) state.possibleStrings.set(c.name, initialCandidates);
            else if (!existing || !c.constant) state.possibleStrings.delete(c.name);
            const initialNestedCandidates = nestedStringValues(c.initial, state, callResults, dictionaryResults);
            if (initialNestedCandidates.size) state.possibleDictionaries.set(c.name, initialNestedCandidates);
            else if (!existing || !c.constant) state.possibleDictionaries.delete(c.name);
            if (!existing && c.type?.kind === 'dict') {
              state.dictionaryKeys.set(c.name, dictionaryKeysForExpression(c.initial, state, keyResults) || new Map());
              if (dictionaryClosedForExpression(c.initial, state, closedResults) === true) state.dictionaryClosed.set(c.name, true);
              else state.dictionaryClosed.delete(c.name);
              const aliases = dictionaryAliases(c.initial, state, aliasResults);
              if (aliases.size) state.dictionaryAliases.set(c.name, aliases); else state.dictionaryAliases.delete(c.name);
            } else if (!existing) { state.dictionaryKeys.delete(c.name); state.dictionaryClosed.delete(c.name); }
          } else if (c.op === 'goto') {
            pending.push({
              file: scenes.has(c.scene) ? current.file : sceneFile(c.scene),
              scene: scenes.has(c.scene) ? c.scene : null,
              defined: new Set(state.defined),
              locals: new Set(),
              constants: new Map([...state.constants].filter(([name]) => state.defined.has(name) && !state.locals.has(name))),
              strings: new Map([...state.strings].filter(([name]) => state.defined.has(name) && !state.locals.has(name))),
              possibleStrings: new Map([...state.possibleStrings].filter(([name]) => state.defined.has(name) && !state.locals.has(name)).map(([name, values]) => [name, new Set(values)])),
               possibleDictionaries: new Map([...state.possibleDictionaries].filter(([name]) => state.defined.has(name) && !state.locals.has(name)).map(([name, values]) => [name, new Set(values)])),
               dictionaryAliases: new Map([...state.dictionaryAliases].filter(([name]) => state.defined.has(name) && !state.locals.has(name)).map(([name, values]) => [name, new Set(values)])),
               dictionaryKeys: cloneDictionaryKeys(new Map([...state.dictionaryKeys].filter(([name]) => state.defined.has(name) && !state.locals.has(name)))),
               dictionaryClosed: new Map([...state.dictionaryClosed].filter(([name]) => state.defined.has(name) && !state.locals.has(name))),
               writes: new Map(),
            });
            continue;
          } else if (c.op === 'return') {
            const callResults = new Map();
            const dictionaryResults = new Map();
            const aliasResults = new Map();
            const keyResults = new Map();
            const closedResults = new Map();
            expression(c.value, state, callResults, dictionaryResults, aliasResults, true, keyResults, closedResults);
            for (const value of possibleStringValues(c.value, state, callResults)) returned.push(value);
            for (const value of nestedStringValues(c.value, state, callResults, dictionaryResults)) returnedDictionaries.push(value);
            for (const value of dictionaryAliases(c.value, state, aliasResults)) returnedAliases.push(value);
            returnedDictionaryKeys.push(dictionaryKeysForExpression(c.value, state, keyResults));
            returnedDictionaryClosed.push(dictionaryClosedForExpression(c.value, state, closedResults));
            terminals.push(state);
            continue;
          }
          else if (c.op === 'if') {
            let fallsThrough = true;
            for (const branch of [{ condition: c.condition, body: c.body }, ...c.elseIf]) {
              expression(branch.condition, state);
              const value = constant(branch.condition, state.constants);
              if (value !== false) next.push(...walk(branch.body, [clone(state)], globalScope, returned, terminals, returnedDictionaries, returnedAliases, returnedDictionaryKeys, returnedDictionaryClosed));
              if (value === true) { fallsThrough = false; break; }
            }
            if (fallsThrough) next.push(...walk(c.otherwise, [clone(state)], globalScope, returned, terminals, returnedDictionaries, returnedAliases, returnedDictionaryKeys, returnedDictionaryClosed));
            continue;
          } else if (c.op === 'choice') {
            for (const option of c.options) textExpression(option.label, state);
            textExpression(c.prompt, state);
            for (const option of c.options) {
              for (const result of walk(option.body, [clone(state)], false, returned, terminals, returnedDictionaries, returnedAliases, returnedDictionaryKeys, returnedDictionaryClosed)) {
                const outerNames = new Set([...state.defined].filter(name => !state.locals.has(name)));
                const strings = new Map([...result.strings].filter(([name]) => outerNames.has(name)));
                const possibleStrings = new Map([...result.possibleStrings].filter(([name]) => outerNames.has(name)).map(([name, values]) => [name, new Set(values)]));
                const possibleDictionaries = new Map([...result.possibleDictionaries].filter(([name]) => outerNames.has(name)).map(([name, values]) => [name, new Set(values)]));
                const dictionaryAliases = new Map([...result.dictionaryAliases].filter(([name]) => outerNames.has(name)).map(([name, values]) => [name, new Set(values)]));
                const dictionaryKeys = cloneDictionaryKeys(new Map([...result.dictionaryKeys].filter(([name]) => outerNames.has(name))));
                const dictionaryClosed = new Map([...result.dictionaryClosed].filter(([name]) => outerNames.has(name)));
                next.push({ defined: result.defined, locals: new Set(state.locals), constants: new Map(state.constants), strings, possibleStrings, possibleDictionaries, dictionaryAliases, dictionaryKeys, dictionaryClosed, writes: new Map(result.writes) });
              }
            }
            continue;
          } else if (c.op === 'forEach') {
            const callResults = new Map(), dictionaryResults = new Map(), aliasResults = new Map(), keyResults = new Map(), closedResults = new Map();
            expression(c.iterable, state, callResults, dictionaryResults, aliasResults, true, keyResults, closedResults);
            const bodyState = clone(state);
            bodyState.locals.add(c.name);
            const itemStrings = nestedStringValues(c.iterable, state, callResults, dictionaryResults);
            if (itemStrings.size) bodyState.possibleStrings.set(c.name, itemStrings);
            else bodyState.possibleStrings.delete(c.name);
            if (itemStrings.size === 1) bodyState.strings.set(c.name, [...itemStrings][0]);
            else bodyState.strings.delete(c.name);
            for (const result of walk(c.body, [bodyState], globalScope, returned, terminals, returnedDictionaries, returnedAliases, returnedDictionaryKeys, returnedDictionaryClosed)) {
              const restore = (target, source) => {
                for (const mapName of ['constants', 'strings', 'possibleStrings', 'possibleDictionaries', 'dictionaryAliases', 'dictionaryKeys', 'dictionaryClosed', 'writes']) {
                  const map = result[mapName], prior = state[mapName];
                  if (prior.has(c.name)) {
                    const value = prior.get(c.name);
                    map.set(c.name, value instanceof Set ? new Set(value) : value instanceof Map ? new Map(value) : value);
                  } else map.delete(c.name);
                }
                if (state.locals.has(c.name)) result.locals.add(c.name); else result.locals.delete(c.name);
              };
              restore(result, state);
              next.push(result);
            }
            next.push(state); // A list can be empty, so preserve the zero-iteration path.
            continue;
          } else if (c.op === 'for' || c.op === 'while') {
            expression(c.condition, state); expression(c.start, state); expression(c.stop, state); expression(c.step, state);
            if (c.op === 'while' && constant(c.condition, state.constants) === false) { next.push(state); continue; }
            const bodyState = clone(state);
            if (c.op === 'for') { bodyState.locals.add(c.name); bodyState.constants.delete(c.name); }
            for (const result of walk(c.body, [bodyState], globalScope, returned, terminals, returnedDictionaries, returnedAliases, returnedDictionaryKeys, returnedDictionaryClosed)) if (c.op === 'for' || constant(c.condition, result.constants) !== true) {
              const locals = new Set(result.locals);
              if (c.op === 'for' && !state.locals.has(c.name)) locals.delete(c.name);
              const constants = new Map(result.constants);
              if (c.op === 'for') constants.delete(c.name);
              const strings = new Map(result.strings);
              if (c.op === 'for') strings.delete(c.name);
              const possibleStrings = new Map([...result.possibleStrings].map(([name, values]) => [name, new Set(values)]));
              if (c.op === 'for') possibleStrings.delete(c.name);
              const possibleDictionaries = new Map([...result.possibleDictionaries].map(([name, values]) => [name, new Set(values)]));
              if (c.op === 'for') possibleDictionaries.delete(c.name);
              const dictionaryAliases = new Map([...result.dictionaryAliases].map(([name, values]) => [name, new Set(values)]));
              if (c.op === 'for') dictionaryAliases.delete(c.name);
              const dictionaryKeys = cloneDictionaryKeys(result.dictionaryKeys);
              if (c.op === 'for') dictionaryKeys.delete(c.name);
              const dictionaryClosed = new Map(result.dictionaryClosed);
              if (c.op === 'for') dictionaryClosed.delete(c.name);
              next.push({ defined: result.defined, locals, constants, strings, possibleStrings, possibleDictionaries, dictionaryAliases, dictionaryKeys, dictionaryClosed, writes: new Map(result.writes) });
            }
            if (c.op === 'for' && !definitelyRunsFor(c, state.constants)) next.push(state);
            if (c.op === 'while' && constant(c.condition, state.constants) !== true) next.push(state);
            continue;
          } else if (c.op === 'set' || c.op === 'unset') {
            const callResults = new Map();
            const dictionaryResults = new Map();
            const aliasResults = new Map();
            const keyResults = new Map();
            const closedResults = new Map();
            if (c.op === 'set') {
              // Runtime evaluates the assigned value before an indexed key.
              expression(c.value, state, callResults, dictionaryResults, aliasResults, true, keyResults, closedResults);
              expression(c.target, state, new Map(), new Map(), new Map(), false);
            } else {
              expression(c.target, state);
            }
            if (c.target.kind === 'load') state.constants.delete(c.target.name);
            if (c.op === 'set' && c.target.kind === 'load') {
              const assignedCandidates = stringCandidates(c.value, state, callResults);
              const assignedString = assignedCandidates.size === 1 ? [...assignedCandidates][0] : undefined;
              if (typeof assignedString === 'string') state.strings.set(c.target.name, assignedString);
              else state.strings.delete(c.target.name);
              if (assignedCandidates.size) state.possibleStrings.set(c.target.name, assignedCandidates);
              else state.possibleStrings.delete(c.target.name);
              const assignedNestedCandidates = nestedStringValues(c.value, state, callResults, dictionaryResults);
              if (assignedNestedCandidates.size) state.possibleDictionaries.set(c.target.name, assignedNestedCandidates);
              else state.possibleDictionaries.delete(c.target.name);
              const aliases = dictionaryAliases(c.value, state, aliasResults);
              if (aliases.size) state.dictionaryAliases.set(c.target.name, aliases); else state.dictionaryAliases.delete(c.target.name);
              const dictionaryKeys = dictionaryKeysForExpression(c.value, state, keyResults);
              if (dictionaryKeys) state.dictionaryKeys.set(c.target.name, dictionaryKeys); else state.dictionaryKeys.delete(c.target.name);
              if (dictionaryClosedForExpression(c.value, state, closedResults) === true) state.dictionaryClosed.set(c.target.name, true); else state.dictionaryClosed.delete(c.target.name);
              if (!state.locals.has(c.target.name)) state.writes.set(c.target.name, typeof assignedString === 'string' ? assignedString : undefined);
            } else if (c.op === 'set' && c.target.kind === 'index' && c.target.target?.kind === 'load') {
              const assignedNestedCandidates = nestedStringValues(c.value, state, callResults, dictionaryResults);
              addDictionaryCandidates(state, c.target.target.name, assignedNestedCandidates);
              const key = knownDictionaryKey(c.target.key, state);
              if (key !== undefined) {
                const facts = new Map(state.dictionaryKeys.get(c.target.target.name) || []);
                facts.set(key, true);
                state.dictionaryKeys.set(c.target.target.name, facts);
              } else state.dictionaryClosed.delete(c.target.target.name);
            } else if (c.op === 'unset' && c.target.kind === 'load') { state.strings.delete(c.target.name); state.possibleStrings.delete(c.target.name); }
            if (c.op === 'unset' && c.target.kind === 'index' && c.target.target?.kind === 'load') {
              const key = knownDictionaryKey(c.target.key, state), facts = state.dictionaryKeys.get(c.target.target.name);
              const closed = state.dictionaryClosed.get(c.target.target.name);
              if (key !== undefined && (facts?.get(key) === true || closed === true)) {
                const nextFacts = new Map(facts || []);
                nextFacts.set(key, false);
                state.dictionaryKeys.set(c.target.target.name, nextFacts);
              } else if (key === undefined) { state.dictionaryKeys.delete(c.target.target.name); state.dictionaryClosed.delete(c.target.target.name); }
            }
            if (c.op === 'unset' && c.target.kind === 'load') { state.possibleDictionaries.delete(c.target.name); state.dictionaryAliases.delete(c.target.name); }
          }
          else if (c.op === 'call') expression({ ...c, kind: 'call' }, state);
          else if (c.op === 'command') c.args.forEach((arg, index) => c.name === 'say' && index === 1 ? textExpression(arg, state) : expression(arg, state));
          next.push(state);
        }
        states = [...new Map(next.map(state => [JSON.stringify(stateKey(state)), state])).values()];
        if (!states.length) break;
      }
      return states;
    }
    const state = { defined: current.defined, locals: new Set(), constants: current.constants, strings: current.strings, possibleStrings: current.possibleStrings, possibleDictionaries: current.possibleDictionaries, dictionaryAliases: current.dictionaryAliases, dictionaryKeys: current.dictionaryKeys, dictionaryClosed: current.dictionaryClosed, writes: current.writes };
    if (current.scene !== null) walk(scenes.get(current.scene), [state], false);
    else {
      const afterGlobals = walk(program.globals, [state], true);
      if (program.scenes.length) walk(program.scenes[0].instructions, afterGlobals, false);
    }
  }
}
module.exports = { validateVariableFlow };
