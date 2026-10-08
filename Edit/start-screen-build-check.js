// Build-only control-flow guard: every reachable scene must explicitly
// transition with goto or call start() before it can reach its end.
module.exports = function startScreenBuildDiagnostics(sources, entry, resolvedFunctionsByFile = new Map(), metadata = {}) {
  const { parse } = require('../dist');
  const parsed = new Map();
  const sceneFilesByName = new Map();
  const firstSceneByFile = new Map();
  const normalize = value => String(value || '').replaceAll('\\', '/').toLocaleLowerCase('en-US');
  for (const [file, source] of sources) {
    try {
      const ast = parse(source);
      parsed.set(file, ast);
      if (ast.scenes[0]) firstSceneByFile.set(normalize(file), ast.scenes[0].name);
      for (const scene of ast.scenes) if (!sceneFilesByName.has(scene.name)) sceneFilesByName.set(scene.name, file);
    } catch { /* Syntax diagnostics are emitted by the regular build pass. */ }
  }
  const entryAst = parsed.get(entry);
  if (!entryAst?.scenes.length) { metadata.usesStart = false; return []; }

  const targetExpressions = target => target?.kind === 'index'
    ? [...targetExpressions(target.target), target.key]
    : [];
  const expressionsFor = statement => {
    switch (statement.kind) {
      case 'call': return [statement];
      case 'declare': return statement.initial ? [statement.initial] : [];
      case 'set': return [...targetExpressions(statement.target), statement.value].filter(Boolean);
      case 'unset': return targetExpressions(statement.target);
      case 'command': return statement.args || [];
      case 'return': return statement.value ? [statement.value] : [];
      case 'if': return [statement.condition?.expression || statement.condition].filter(Boolean);
      case 'for': return [statement.start, statement.stop, statement.step].filter(Boolean);
      case 'forEach': return [statement.iterable].filter(Boolean);
      case 'while': return [statement.condition?.expression || statement.condition].filter(Boolean);
      case 'choice': return [statement.prompt, ...statement.options.map(option => option.label)].filter(Boolean);
      case 'parallel': return (statement.body || []).flatMap(expressionsFor);
      default: return [];
    }
  };
  const expressionMayStart = (expression, ast, seen = new Set(), file = '') => {
    if (!expression || typeof expression !== 'object') return false;
    if (expression.kind === 'call') {
      return functionMayStart(ast, expression.name, new Set(seen), file)
        || (expression.args || []).some(argument => expressionMayStart(argument, ast, new Set(seen), file));
    }
    if (expression.kind === 'binary' && ['and', 'or'].includes(expression.operator)) {
      const left = expression.left;
      const known = left?.kind === 'literal' && typeof left.value === 'boolean' ? left.value : undefined;
      if (expressionMayStart(left, ast, new Set(seen), file)) return true;
      if (expression.operator === 'and' && known === false || expression.operator === 'or' && known === true) return false;
      return expressionMayStart(expression.right, ast, new Set(seen), file);
    }
    return Object.entries(expression).some(([key, value]) => key !== 'line' && key !== 'column' && key !== 'sourceColumns'
      && (Array.isArray(value) ? value.some(item => expressionMayStart(item, ast, new Set(seen), file))
        : value && typeof value === 'object' && expressionMayStart(value, ast, new Set(seen), file)));
  };
  const expressionAlwaysStarts = (expression, ast, seen = new Set(), file = '') => {
    if (!expression || typeof expression !== 'object') return false;
    if (expression.kind === 'call') {
      return (expression.args || []).some(argument => expressionAlwaysStarts(argument, ast, new Set(seen), file))
        || functionAlwaysStarts(ast, expression.name, new Set(seen), file);
    }
    if (expression.kind === 'binary' && ['and', 'or'].includes(expression.operator)) {
      const left = expression.left;
      const known = left?.kind === 'literal' && typeof left.value === 'boolean' ? left.value : undefined;
      return expressionAlwaysStarts(left, ast, new Set(seen), file)
        || (expression.operator === 'and' && known === true || expression.operator === 'or' && known === false)
          && expressionAlwaysStarts(expression.right, ast, new Set(seen), file);
    }
    return Object.entries(expression).some(([key, value]) => key !== 'line' && key !== 'column' && key !== 'sourceColumns'
      && (Array.isArray(value) ? value.some(item => expressionAlwaysStarts(item, ast, new Set(seen), file))
        : value && typeof value === 'object' && expressionAlwaysStarts(value, ast, new Set(seen), file)));
  };
  const applyExpressionEffects = (states, expressions, ast, file) => {
    for (const expression of expressions) {
      if (!expressionMayStart(expression, ast, new Set(), file)) continue;
      metadata.usesStart = true;
      if (expressionAlwaysStarts(expression, ast, new Set(), file)) states = new Set([true]);
      else states.add(true);
    }
    return states;
  };

  const functionsFor = (file, ast) => resolvedFunctionsByFile.get(file) || ast?.functions || [];
  const functionMayStart = (ast, name, seen = new Set(), file = '') => {
    if (name === 'start') return true;
    if (seen.has(name)) return false;
    seen.add(name);
    const fn = functionsFor(file, ast).find(item => item.name === name);
    return Boolean(fn && sequenceMayStart(fn.body, ast, seen, file));
  };
  const sequenceMayStart = (statements, ast, seen = new Set(), file = '') => {
    for (const statement of statements || []) {
      if (expressionsFor(statement).some(expression => expressionMayStart(expression, ast, new Set(seen), file))) return true;
      if (statement.kind === 'if') {
        let unmatched = true;
        const branches = [[statement.condition, statement.body], ...statement.elseIf.map(branch => [branch.condition, branch.body])];
        for (const [condition, body] of branches) {
          const known = knownBoolean(condition);
          if (known !== false && sequenceMayStart(body, ast, seen, file)) return true;
          if (known === true) { unmatched = false; break; }
        }
        if (unmatched && sequenceMayStart(statement.otherwise, ast, seen, file)) return true;
      } else if (statement.kind === 'choice') {
        if (statement.options.some(option => sequenceMayStart(option.body, ast, seen, file))) return true;
      } else if (statement.body) {
        const canRun = statement.kind === 'while'
          ? knownBoolean(statement.condition) !== false
          : statement.kind !== 'for' || forRangeMayIterate(statement);
        if (canRun && sequenceMayStart(statement.body, ast, seen, file)) return true;
      }
      if (statementNeverReturns(statement, ast, new Set(seen), file)) return false;
    }
    return false;
  };
  const functionAlwaysStarts = (ast, name, seen = new Set(), file = '') => {
    if (name === 'start') return true;
    if (seen.has(name)) return false;
    seen.add(name);
    const fn = functionsFor(file, ast).find(item => item.name === name);
    return Boolean(fn && sequenceAlwaysStarts(fn.body, ast, seen, file));
  };
  const functionNeverReturns = (ast, name, seen = new Set(), file = '') => {
    if (seen.has(name)) return false;
    seen.add(name);
    const fn = functionsFor(file, ast).find(item => item.name === name);
    return Boolean(fn && sequenceNeverReturns(fn.body, ast, seen, file));
  };
  const sequenceNeverReturns = (statements, ast, seen = new Set(), file = '') => {
    for (const statement of statements || []) {
      if (statementNeverReturns(statement, ast, new Set(seen), file)) return true;
      if (statement.kind === 'return' || containsReturn(statement)) return false;
    }
    return false;
  };
  const statementNeverReturns = (statement, ast, seen, file) => {
    if (statement.kind === 'call') return functionNeverReturns(ast, statement.name, new Set(seen), file);
    if (statement.kind === 'while' && knownBoolean(statement.condition) === true)
      return !containsReturnIn(statement.body);
    if (statement.kind === 'for' && guaranteedForIteration(statement))
      return sequenceNeverReturns(statement.body, ast, new Set(seen), file);
    if (statement.kind === 'choice')
      return statement.options.length > 0 && statement.options.every(option => sequenceNeverReturns(option.body, ast, new Set(seen), file));
    if (statement.kind !== 'if') return false;

    const branches = [[statement.condition, statement.body], ...statement.elseIf.map(branch => [branch.condition, branch.body])];
    for (const [condition, body] of branches) {
      const value = knownBoolean(condition);
      if (value === false) continue;
      if (!sequenceNeverReturns(body, ast, new Set(seen), file)) return false;
      if (value === true) return true;
    }
    return statement.otherwise.length > 0
      && sequenceNeverReturns(statement.otherwise, ast, new Set(seen), file);
  };
  const conditionExpression = condition => condition?.expression || condition;
  const knownBoolean = condition => {
    const expression = conditionExpression(condition);
    return expression?.kind === 'literal' && typeof expression.value === 'boolean' ? expression.value : undefined;
  };
  const statementAlwaysStarts = (statement, ast, seen, file) => {
    if (statement.kind === 'call') return functionAlwaysStarts(ast, statement.name, new Set(seen), file);
    if (statement.kind === 'for' && guaranteedForIteration(statement))
      return sequenceAlwaysStarts(statement.body, ast, new Set(seen), file);
    // A literal-true loop cannot fall through unless a return exits its
    // function. Treat it as an unconditional start only when every return path
    // from the loop body has already called start().
    if (statement.kind === 'while' && knownBoolean(statement.condition) === true)
      return sequenceAlwaysStarts(statement.body, ast, new Set(seen), file);
    if (statement.kind === 'if') {
      const branches = [[statement.condition, statement.body], ...statement.elseIf.map(branch => [branch.condition, branch.body])];
      for (const [condition, body] of branches) {
        const value = knownBoolean(condition);
        if (value === false) continue;
        if (!sequenceAlwaysStarts(body, ast, new Set(seen), file)) return false;
        if (value === true) return true;
      }
      return statement.otherwise.length > 0 && sequenceAlwaysStarts(statement.otherwise, ast, new Set(seen), file);
    }
    if (statement.kind === 'choice') return statement.options.length > 0
      && statement.options.every(option => sequenceAlwaysStarts(option.body, ast, new Set(seen), file));
    return false;
  };
  const containsReturnIn = statements => (statements || []).some(containsReturn);
  const containsReturn = statement => {
    if (statement.kind === 'return') return true;
    if (statement.kind === 'if') {
      const branches = [[statement.condition, statement.body], ...statement.elseIf.map(branch => [branch.condition, branch.body])];
      let canContinue = true;
      for (const [condition, body] of branches) {
        if (!canContinue) break;
        const value = knownBoolean(condition);
        if (value !== false && containsReturnIn(body)) return true;
        if (value === true) canContinue = false;
      }
      return canContinue && containsReturnIn(statement.otherwise);
    }
    if (statement.kind === 'while' && knownBoolean(statement.condition) === false) return false;
    if (statement.kind === 'for' && guaranteedForIteration(statement) === false) {
      const start = integerLiteral(statement.start), stop = integerLiteral(statement.stop), step = integerLiteral(statement.step);
      if (start !== undefined && stop !== undefined && step !== undefined && step !== 0n
        && (step > 0n ? start > stop : start < stop)) return false;
    }
    return containsReturnIn(statement.body)
      || containsReturnIn(statement.elseIf?.flatMap(branch => branch.body))
      || containsReturnIn(statement.otherwise)
      || (statement.options || []).some(option => containsReturnIn(option.body));
  };
  const integerLiteral = expression => {
    if (expression?.kind === 'literal' && typeof expression.value === 'bigint') return expression.value;
    if (expression?.kind === 'literal' && typeof expression.value === 'number' && Number.isSafeInteger(expression.value)) return BigInt(expression.value);
    if (expression?.kind === 'unary' && (expression.operator === '+' || expression.operator === '-')) {
      const value = integerLiteral(expression.value);
      return value === undefined ? undefined : expression.operator === '-' ? -value : value;
    }
    return undefined;
  };
  const guaranteedForIteration = statement => {
    if (statement.kind !== 'for') return false;
    const start = integerLiteral(statement.start), stop = integerLiteral(statement.stop), step = integerLiteral(statement.step);
    return start !== undefined && stop !== undefined && step !== undefined && step !== 0n
      && (step > 0n ? start <= stop : start >= stop);
  };
  const forRangeMayIterate = statement => {
    const start = integerLiteral(statement.start), stop = integerLiteral(statement.stop), step = integerLiteral(statement.step);
    if (start === undefined || stop === undefined || step === undefined) return true;
    return step !== 0n && (step > 0n ? start <= stop : start >= stop);
  };
  const sequenceAlwaysStarts = (statements, ast, seen = new Set(), file = '') => {
    for (const statement of statements || []) {
      if (expressionsFor(statement).some(expression => expressionAlwaysStarts(expression, ast, new Set(seen), file))
        || statementAlwaysStarts(statement, ast, seen, file)) return true;
      // A return path exits the function before later statements can call
      // start(). Do not let a later call make that earlier path look covered.
      if (containsReturn(statement)) return false;
    }
    return false;
  };
  const analyze = (statements, ast, initialState, file) => {
    const transitions = [];
    let states = new Set([initialState]);
    for (const statement of statements || []) {
      if (!states.size) break;
      const expressions = expressionsFor(statement);
      if (statement.kind === 'if') {
        let unmatched = new Set(states);
        const next = new Set();
        const branches = [[statement.condition, statement.body], ...statement.elseIf.map(branch => [branch.condition, branch.body])];
        for (const [condition, body] of branches) {
          const expression = condition?.expression || condition;
          unmatched = applyExpressionEffects(unmatched, [expression].filter(Boolean), ast, file);
          const known = knownBoolean(condition);
          if (known !== false) {
            const result = analyze(body, ast, unmatched, file);
            result.ends.forEach(value => next.add(value)); transitions.push(...result.transitions);
          }
          if (known === true) { unmatched = new Set(); break; }
        }
        if (unmatched.size && !statement.otherwise.length) unmatched.forEach(value => next.add(value));
        else if (unmatched.size) {
          const result = analyze(statement.otherwise, ast, unmatched, file);
          result.ends.forEach(value => next.add(value)); transitions.push(...result.transitions);
        }
        states = next; continue;
      }
      states = applyExpressionEffects(states, expressions, ast, file);
      if (statement.kind === 'goto') {
        for (const started of states) transitions.push({ target: statement.scene, started, line: statement.line || 1 });
        states = new Set(); continue;
      }
      if (statement.kind === 'call') {
        if (functionNeverReturns(ast, statement.name, new Set(), file)) states = new Set();
        continue;
      }
      if (statement.kind === 'choice') {
        const next = new Set();
        for (const state of states) for (const option of statement.options) {
          const result = analyze(option.body, ast, state, file);
          result.ends.forEach(value => next.add(value)); transitions.push(...result.transitions);
        }
        states = next; continue;
      }
      if (['for', 'forEach', 'while', 'parallel'].includes(statement.kind)) {
        const alwaysLoops = statement.kind === 'while' && statement.condition?.expression?.kind === 'literal' && statement.condition.expression.value === true;
        const maySkip = !alwaysLoops && !guaranteedForIteration(statement);
        const next = maySkip ? new Set(states) : new Set();
        for (const state of states) {
          const result = analyze(statement.body, ast, state, file);
          if (!alwaysLoops) result.ends.forEach(value => next.add(value));
          transitions.push(...result.transitions);
        }
        states = next;
      }
    }
    return { ends: states, transitions };
  };
  const resolveTarget = rawValue => {
    const raw = String(rawValue || '').replaceAll('\\', '/');
    const external = /\.(?:tds|txt)$/i.test(raw);
    const file = external ? [...parsed.keys()].find(item => normalize(item) === normalize(raw)) : sceneFilesByName.get(raw);
    const scene = external ? firstSceneByFile.get(normalize(raw)) : raw;
    return file && scene ? { file, scene } : null;
  };

  const diagnostics = [];
  const seenStates = new Set();
  const reportedScenes = new Set();
  const startup = analyze(entryAst.globals, entryAst, false, entry);
  const pending = startup.transitions.map(transition => {
    const target = resolveTarget(transition.target);
    return target && { ...target, started: transition.started };
  }).filter(Boolean);
  if (startup.ends.size) for (const started of startup.ends) pending.push({ file: entry, scene: entryAst.scenes[0].name, started });
  while (pending.length) {
    const current = pending.pop();
    const key = `${normalize(current.file)}#${current.scene}#${current.started ? 'started' : 'not-started'}`;
    if (seenStates.has(key)) continue;
    seenStates.add(key);
    const ast = parsed.get(current.file);
    const scene = ast?.scenes.find(item => item.name === current.scene);
    if (!scene) continue;
    const result = analyze(scene.body, ast, current.started, current.file);
    if (result.ends.has(false)) {
      const sceneKey = `${normalize(current.file)}#${current.scene}`;
      if (!reportedScenes.has(sceneKey)) {
        reportedScenes.add(sceneKey);
        diagnostics.push({
          code: 'start-screen-not-returned', severity: 'warning', buildBlocking: true,
          message: '到達可能なSceneに、gotoまたはstart()を実行せずに末尾へ進む経路があります。画面遷移を追加してください。',
          file: current.file, line: scene.endLine || scene.line || 1, column: 1,
        });
      }
    }
    for (const transition of result.transitions) {
      const target = resolveTarget(transition.target);
      if (target) pending.push({ ...target, started: transition.started });
    }
  }
  metadata.usesStart = Boolean(metadata.usesStart);
  return diagnostics;
};
