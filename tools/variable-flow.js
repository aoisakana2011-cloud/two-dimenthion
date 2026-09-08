'use strict';
const { sceneFile } = require('./project');

function constant(expr) {
  if (!expr) return undefined;
  if (expr.kind === 'integer') return BigInt(expr.value);
  if (expr.kind === 'literal') return typeof expr.value === 'number' ? BigInt(expr.value) : expr.value;
  if (expr.kind === 'unary') {
    const value = constant(expr.value);
    if (value === undefined) return undefined;
    return expr.operator === 'not' ? !value : expr.operator === '-' ? -value : value;
  }
  if (expr.kind !== 'binary') return undefined;
  const a = constant(expr.left), b = constant(expr.right);
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

// Follow executable instructions, preserving the definitions at each transfer.
// Declarations after a goto/return must never initialize its destination.
function validateVariableFlow(files, entry) {
  const pending = [{ file: entry, scene: null, defined: new Set() }];
  const visited = new Set();
  const clone = state => ({ defined: new Set(state.defined), locals: new Set(state.locals) });
  while (pending.length) {
    const current = pending.pop();
    const key = JSON.stringify([current.file, current.scene, [...current.defined].sort()]);
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
    function expression(expr, state) {
      if (!expr) return;
      if (expr.kind === 'load') requireName(expr.name, state);
      if (expr.kind === 'literal' && typeof expr.value === 'string') {
        for (const match of expr.value.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)(?:\.[A-Za-z_][A-Za-z0-9_]*)*\}/g)) requireName(match[1], state);
      }
      if (expr.kind === 'binary') {
        expression(expr.left, state);
        const left = constant(expr.left);
        if (!((expr.operator === 'and' && left === false) || (expr.operator === 'or' && left === true))) expression(expr.right, state);
      }
      if (expr.kind === 'unary') expression(expr.value, state);
      if (expr.kind === 'index') { expression(expr.target, state); expression(expr.key, state); }
      if (expr.kind === 'dict') expr.entries.forEach(item => expression(item.value, state));
      if (expr.kind === 'call') {
        expr.args.forEach(arg => expression(arg, state));
        const fn = functions.get(expr.name);
        if (fn && !calls.has(fn.name)) {
          calls.add(fn.name);
          walk(fn.body, [{ defined: new Set(state.defined), locals: new Set(fn.params.map(param => param.name)) }], false);
          calls.delete(fn.name);
        }
      }
    }
    function walk(list, states, globalScope) {
      for (const instruction of list) {
        const next = [];
        for (const state of states) {
          const c = instruction;
          if (c.op === 'declare') {
            if (!globalScope || !state.defined.has(c.name)) expression(c.initial, state);
            (globalScope ? state.defined : state.locals).add(c.name);
          } else if (c.op === 'goto') {
            pending.push({ file: scenes.has(c.scene) ? current.file : sceneFile(c.scene), scene: scenes.has(c.scene) ? c.scene : null, defined: new Set(state.defined) });
            continue;
          } else if (c.op === 'return') { expression(c.value, state); continue; }
          else if (c.op === 'if') {
            let fallsThrough = true;
            for (const branch of [{ condition: c.condition, body: c.body }, ...c.elseIf]) {
              expression(branch.condition, state);
              const value = constant(branch.condition);
              if (value !== false) next.push(...walk(branch.body, [clone(state)], globalScope));
              if (value === true) { fallsThrough = false; break; }
            }
            if (fallsThrough) next.push(...walk(c.otherwise, [clone(state)], globalScope));
            continue;
          } else if (c.op === 'choice') {
            expression(c.prompt, state);
            for (const option of c.options) {
              expression(option.label, state);
              for (const result of walk(option.body, [clone(state)], false)) next.push({ defined: result.defined, locals: new Set(state.locals) });
            }
            continue;
          } else if (c.op === 'for' || c.op === 'while') {
            expression(c.condition, state); expression(c.start, state); expression(c.stop, state); expression(c.step, state);
            if (c.op === 'while' && constant(c.condition) === false) { next.push(state); continue; }
            const bodyState = clone(state);
            if (c.op === 'for') bodyState.locals.add(c.name);
            for (const result of walk(c.body, [bodyState], globalScope)) if (c.op === 'for' || constant(c.condition) !== true) {
              const locals = new Set(result.locals);
              if (c.op === 'for' && !state.locals.has(c.name)) locals.delete(c.name);
              next.push({ defined: result.defined, locals });
            }
            if (c.op === 'while' && constant(c.condition) !== true) next.push(state);
            continue;
          } else if (c.op === 'set' || c.op === 'unset') { expression(c.target, state); expression(c.value, state); }
          else if (c.op === 'call') expression({ ...c, kind: 'call' }, state);
          else if (c.op === 'command') c.args.forEach(arg => expression(arg, state));
          else if (c.op === 'sayBlock') { expression(c.speaker, state); c.lines.forEach(line => expression(line, state)); }
          next.push(state);
        }
        states = [...new Map(next.map(state => [JSON.stringify([[...state.defined].sort(), [...state.locals].sort()]), state])).values()];
        if (!states.length) break;
      }
      return states;
    }
    const state = { defined: current.defined, locals: new Set() };
    if (current.scene !== null) walk(scenes.get(current.scene), [state], false);
    else {
      const afterGlobals = walk(program.globals, [state], true);
      if (program.scenes.length) walk(program.scenes[0].instructions, afterGlobals, false);
    }
  }
}
module.exports = { validateVariableFlow };
