"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sceneReachability = sceneReachability;
exports.analyzeScript = analyzeScript;
exports.assertAnalyzed = assertAnalyzed;
const type_checker_1 = require("./type-checker");
const INT_MIN = -(1n << 63n);
const INT_MAX = (1n << 63n) - 1n;
function at(node) {
    return { line: node?.line ?? 1, column: node?.column ?? 1, ...(node?.endLine ? { endLine: node.endLine } : {}) };
}
function diagnostic(file, code, severity, message, node) {
    return { code, severity, message, file: node?.file || file, ...at(node) };
}
function errorDiagnostic(error, file) {
    const message = error instanceof Error ? error.message : String(error);
    const line = Number(message.match(/(?:at )?line\s+(\d+)/i)?.[1] || 1);
    const column = Number(message.match(/column\s+(\d+)/i)?.[1] || 1);
    return { code: error instanceof SyntaxError ? 'syntax-error' : 'type-error', severity: 'error', message, file, line, column };
}
function integer(value) {
    if (typeof value === 'bigint')
        return value;
    return Number.isSafeInteger(value) ? BigInt(value) : undefined;
}
function constant(expr, constants = new Map()) {
    if (expr.kind === 'literal')
        return typeof expr.value === 'string' ? expr.value : integer(expr.value);
    if (expr.kind === 'variable')
        return constants.get(expr.name);
    if (expr.kind === 'unary') {
        const value = constant(expr.value, constants);
        if (expr.operator === 'not' && typeof value === 'boolean')
            return !value;
        if ((expr.operator === '+' || expr.operator === '-') && typeof value === 'bigint')
            return expr.operator === '-' ? -value : value;
        return undefined;
    }
    if (expr.kind !== 'binary')
        return undefined;
    const left = constant(expr.left, constants);
    if (expr.operator === 'and' && typeof left === 'boolean')
        return left ? constant(expr.right, constants) : false;
    if (expr.operator === 'or' && typeof left === 'boolean')
        return left ? true : constant(expr.right, constants);
    const right = constant(expr.right, constants);
    if (left === undefined || right === undefined)
        return undefined;
    if (expr.operator === '==')
        return left === right;
    if (expr.operator === '!=')
        return left !== right;
    if (typeof left === 'bigint' && typeof right === 'bigint') {
        if (expr.operator === '>')
            return left > right;
        if (expr.operator === '>=')
            return left >= right;
        if (expr.operator === '<')
            return left < right;
        if (expr.operator === '<=')
            return left <= right;
        if (expr.operator === '+')
            return left + right;
        if (expr.operator === '-')
            return left - right;
        if (expr.operator === '*')
            return left * right;
        if (expr.operator === '/' && right !== 0n)
            return left / right;
        if (expr.operator === '%' && right !== 0n)
            return left % right;
    }
    if (expr.operator === '+' && typeof left === 'string' && typeof right === 'string')
        return left + right;
    return undefined;
}
function expressionKey(expr) {
    if (expr.kind === 'literal')
        return `literal:${String(expr.value)}`;
    if (expr.kind === 'variable')
        return `variable:${expr.name}`;
    if (expr.kind === 'unary')
        return `${expr.operator}(${expressionKey(expr.value)})`;
    if (expr.kind === 'binary') {
        const left = expressionKey(expr.left), right = expressionKey(expr.right);
        if (expr.operator === '==' || expr.operator === '!=')
            return `(${[left, right].sort().join(expr.operator)})`;
        return `(${left}${expr.operator}${right})`;
    }
    if (expr.kind === 'index')
        return `${expressionKey(expr.target)}[${expressionKey(expr.key)}]`;
    if (expr.kind === 'call')
        return `${expr.name}(${expr.args.map(expressionKey).join(',')})`;
    return `{${expr.entries.map((entry) => `${entry.key}:${expressionKey(entry.value)}`).join(',')}}`;
}
function inverseExpressionKey(expr) {
    if (expr.kind === 'unary' && expr.operator === 'not')
        return expressionKey(expr.value);
    if (expr.kind !== 'binary')
        return undefined;
    const inverse = { '==': '!=', '!=': '==', '>': '<=', '>=': '<', '<': '>=', '<=': '>' };
    const operator = inverse[expr.operator];
    return operator ? expressionKey({ ...expr, operator }) : undefined;
}
function conditionValue(expr, constants, facts) {
    const value = constant(expr, constants);
    if (value !== undefined || !isPureExpression(expr))
        return value;
    return facts.get(expressionKey(expr));
}
function recordCondition(facts, expr, value) {
    if (!isPureExpression(expr))
        return;
    facts.set(expressionKey(expr), value);
    const inverse = inverseExpressionKey(expr);
    if (inverse)
        facts.set(inverse, !value);
}
function integerConstraint(expr, constants) {
    if (expr.kind !== 'binary' || !['==', '!=', '>', '>=', '<', '<='].includes(expr.operator))
        return undefined;
    if (expr.left.kind === 'variable') {
        const value = constant(expr.right, constants);
        if (typeof value === 'bigint')
            return { name: expr.left.name, operator: expr.operator, value };
    }
    if (expr.right.kind === 'variable') {
        const value = constant(expr.left, constants);
        const flipped = { '==': '==', '!=': '!=', '>': '<', '>=': '<=', '<': '>', '<=': '>=' };
        if (typeof value === 'bigint')
            return { name: expr.right.name, operator: flipped[expr.operator], value };
    }
    return undefined;
}
function conditionImplies(current, previous, constants) {
    if (!isPureExpression(current) || !isPureExpression(previous))
        return false;
    if (expressionKey(current) === expressionKey(previous))
        return true;
    const left = integerConstraint(current, constants), right = integerConstraint(previous, constants);
    if (!left || !right || left.name !== right.name)
        return false;
    const accepts = (constraint, value) => {
        if (constraint.operator === '==')
            return value === constraint.value;
        if (constraint.operator === '!=')
            return value !== constraint.value;
        if (constraint.operator === '>')
            return value > constraint.value;
        if (constraint.operator === '>=')
            return value >= constraint.value;
        if (constraint.operator === '<')
            return value < constraint.value;
        return value <= constraint.value;
    };
    if (left.operator === '==')
        return accepts(right, left.value);
    if (left.operator === '!=')
        return right.operator === '!=' && left.value === right.value;
    if (right.operator === '!=')
        return !accepts(left, right.value);
    if (right.operator === '==')
        return false;
    const lower = (constraint) => constraint.operator === '>' ? [constraint.value, false] : constraint.operator === '>=' ? [constraint.value, true] : undefined;
    const upper = (constraint) => constraint.operator === '<' ? [constraint.value, false] : constraint.operator === '<=' ? [constraint.value, true] : undefined;
    const leftLower = lower(left), rightLower = lower(right), leftUpper = upper(left), rightUpper = upper(right);
    if (rightLower)
        return !!leftLower && (leftLower[0] > rightLower[0] || (leftLower[0] === rightLower[0] && (!leftLower[1] || rightLower[1])));
    if (rightUpper)
        return !!leftUpper && (leftUpper[0] < rightUpper[0] || (leftUpper[0] === rightUpper[0] && (!leftUpper[1] || rightUpper[1])));
    return false;
}
function isPureExpression(expr) {
    if (expr.kind === 'call')
        return expr.name === 'int' || expr.name === 'str' ? expr.args.every(isPureExpression) : false;
    if (expr.kind === 'binary')
        return isPureExpression(expr.left) && isPureExpression(expr.right);
    if (expr.kind === 'unary')
        return isPureExpression(expr.value);
    if (expr.kind === 'index')
        return isPureExpression(expr.target) && isPureExpression(expr.key);
    if (expr.kind === 'dict')
        return expr.entries.every((entry) => isPureExpression(entry.value));
    return true;
}
function visitExpressions(expr, visit) {
    visit(expr);
    if (expr.kind === 'binary') {
        visitExpressions(expr.left, visit);
        visitExpressions(expr.right, visit);
    }
    if (expr.kind === 'unary')
        visitExpressions(expr.value, visit);
    if (expr.kind === 'index') {
        visitExpressions(expr.target, visit);
        visitExpressions(expr.key, visit);
    }
    if (expr.kind === 'call')
        expr.args.forEach((arg) => visitExpressions(arg, visit));
    if (expr.kind === 'dict')
        expr.entries.forEach((entry) => visitExpressions(entry.value, visit));
}
function statementExpressions(statement) {
    if (statement.kind === 'declare')
        return statement.initial ? [statement.initial] : [];
    if (statement.kind === 'set')
        return [statement.value, statement.target];
    if (statement.kind === 'unset')
        return [statement.target];
    if (statement.kind === 'command' || statement.kind === 'call')
        return statement.args;
    if (statement.kind === 'sayBlock')
        return [statement.speaker, ...statement.lines];
    if (statement.kind === 'if' || statement.kind === 'while')
        return [statement.condition.expression];
    if (statement.kind === 'for')
        return [statement.start, statement.stop, statement.step];
    if (statement.kind === 'choice')
        return [...(statement.prompt ? [statement.prompt] : []), ...statement.options.map((option) => option.label)];
    if (statement.kind === 'return')
        return statement.value ? [statement.value] : [];
    return [];
}
function nested(statement) {
    if (statement.kind === 'if')
        return [statement.body, ...statement.elseIf.map((branch) => branch.body), statement.otherwise];
    if (statement.kind === 'for' || statement.kind === 'while')
        return [statement.body];
    if (statement.kind === 'choice')
        return statement.options.map((option) => option.body);
    return [];
}
function definitelyTerminates(statement, constants = new Map(), facts = new Map()) {
    if (statement.kind === 'return' || statement.kind === 'goto')
        return true;
    if (statement.kind === 'if') {
        const branches = [{ condition: statement.condition.expression, body: statement.body }, ...statement.elseIf.map((branch) => ({ condition: branch.condition.expression, body: branch.body }))];
        let allTerminate = true;
        let canFallThrough = true;
        const seen = new Set(), previousConditions = [], remainingFacts = new Map(facts);
        for (const branch of branches) {
            if (!canFallThrough)
                break;
            const value = conditionValue(branch.condition, constants, remainingFacts);
            if (value === false) {
                recordCondition(remainingFacts, branch.condition, false);
                continue;
            }
            const key = expressionKey(branch.condition);
            if (isPureExpression(branch.condition) && (seen.has(key) || previousConditions.some((previous) => conditionImplies(branch.condition, previous, constants))))
                continue;
            const bodyFacts = new Map(remainingFacts);
            recordCondition(bodyFacts, branch.condition, true);
            allTerminate = allTerminate && blockTerminates(branch.body, constants, bodyFacts);
            if (isPureExpression(branch.condition))
                seen.add(key);
            if (isPureExpression(branch.condition))
                previousConditions.push(branch.condition);
            recordCondition(remainingFacts, branch.condition, false);
            if (value === true)
                canFallThrough = false;
        }
        if (canFallThrough) {
            if (!statement.otherwise.length)
                return false;
            allTerminate = allTerminate && blockTerminates(statement.otherwise, constants, remainingFacts);
        }
        return allTerminate;
    }
    if (statement.kind === 'while') {
        if (conditionValue(statement.condition.expression, constants, facts) !== true)
            return false;
        const stable = loopConstants(statement, constants);
        return conditionValue(statement.condition.expression, stable, new Map()) === true || blockTerminates(statement.body, constants, facts);
    }
    if (statement.kind === 'for')
        return blockTerminates(statement.body, constants, facts);
    if (statement.kind === 'choice')
        return statement.options.length > 0 && statement.options.every((option) => blockTerminates(option.body, constants, facts));
    return false;
}
function writtenVariables(statement, result = new Set()) {
    if (statement.kind === 'declare')
        result.add(statement.name);
    if (statement.kind === 'set' && statement.target.kind === 'variable')
        result.add(statement.target.name);
    for (const body of nested(statement))
        for (const child of body)
            writtenVariables(child, result);
    return result;
}
function hasCalls(statement) {
    return statement.kind === 'call' || statementExpressions(statement).some((expr) => !isPureExpression(expr)) || nested(statement).some((body) => body.some(hasCalls));
}
function loopConstants(statement, constants) {
    const stable = new Map(constants);
    if (hasCalls(statement))
        stable.clear();
    for (const name of writtenVariables(statement))
        stable.delete(name);
    if (statement.kind === 'for')
        stable.delete(statement.name);
    return stable;
}
function updateKnownConstants(statement, constants) {
    if (hasCalls(statement))
        constants.clear();
    if (statement.kind === 'declare') {
        const value = statement.initial ? constant(statement.initial, constants) : undefined;
        if (value === undefined)
            constants.delete(statement.name);
        else
            constants.set(statement.name, value);
        return;
    }
    if (statement.kind === 'set' && statement.target.kind === 'variable') {
        const value = constant(statement.value, constants);
        if (value === undefined)
            constants.delete(statement.target.name);
        else
            constants.set(statement.target.name, value);
        return;
    }
    if (statement.kind === 'if' || statement.kind === 'while' || statement.kind === 'for' || statement.kind === 'choice') {
        for (const name of writtenVariables(statement))
            constants.delete(name);
    }
}
function invalidatesConditionFacts(statement) {
    if (statement.kind === 'declare' || statement.kind === 'set' || statement.kind === 'unset' || statement.kind === 'call')
        return true;
    return statementExpressions(statement).some((expr) => {
        let calls = false;
        visitExpressions(expr, (current) => { if (current.kind === 'call' && current.name !== 'int' && current.name !== 'str')
            calls = true; });
        return calls;
    });
}
function blockTerminates(statements, constants = new Map(), facts = new Map()) {
    const known = new Map(constants);
    const knownFacts = new Map(facts);
    for (const statement of statements) {
        if (hasCalls(statement)) {
            known.clear();
            knownFacts.clear();
        }
        if (definitelyTerminates(statement, known, knownFacts))
            return true;
        updateKnownConstants(statement, known);
        if (invalidatesConditionFacts(statement))
            knownFacts.clear();
    }
    return false;
}
function reachableGotoTargets(statements, targets = new Set(), constants = new Map(), facts = new Map()) {
    const known = new Map(constants);
    const knownFacts = new Map(facts);
    for (const statement of statements) {
        if (statement.kind === 'goto') {
            targets.add(statement.scene);
            break;
        }
        if (statement.kind === 'if') {
            if (hasCalls(statement)) {
                known.clear();
                knownFacts.clear();
            }
            const branches = [{ expression: statement.condition.expression, body: statement.body }, ...statement.elseIf.map((branch) => ({ expression: branch.condition.expression, body: branch.body }))];
            const seen = new Set(), previousConditions = [], remainingFacts = new Map(knownFacts);
            let canTryNext = true;
            for (const branch of branches) {
                if (!canTryNext)
                    break;
                const value = conditionValue(branch.expression, known, remainingFacts);
                const key = expressionKey(branch.expression);
                const duplicate = isPureExpression(branch.expression) && (seen.has(key) || previousConditions.some((previous) => conditionImplies(branch.expression, previous, known)));
                const bodyFacts = new Map(remainingFacts);
                recordCondition(bodyFacts, branch.expression, true);
                if (value !== false && !duplicate)
                    reachableGotoTargets(branch.body, targets, known, bodyFacts);
                if (isPureExpression(branch.expression))
                    seen.add(key);
                if (isPureExpression(branch.expression))
                    previousConditions.push(branch.expression);
                recordCondition(remainingFacts, branch.expression, false);
                if (value === true)
                    canTryNext = false;
            }
            if (canTryNext)
                reachableGotoTargets(statement.otherwise, targets, known, remainingFacts);
        }
        else if (statement.kind === 'choice')
            statement.options.forEach((option) => reachableGotoTargets(option.body, targets, known, knownFacts));
        else if (statement.kind === 'while') {
            if (conditionValue(statement.condition.expression, known, knownFacts) !== false) {
                const bodyFacts = new Map(knownFacts);
                recordCondition(bodyFacts, statement.condition.expression, true);
                reachableGotoTargets(statement.body, targets, known, bodyFacts);
            }
        }
        else if (statement.kind === 'for')
            reachableGotoTargets(statement.body, targets, known, knownFacts);
        if (definitelyTerminates(statement, known, knownFacts))
            break;
        updateKnownConstants(statement, known);
        if (invalidatesConditionFacts(statement))
            knownFacts.clear();
    }
    return targets;
}
function sceneReachability(script) {
    const scenes = new Map(script.scenes.map((scene) => [scene.name, scene]));
    const reachableScenes = new Set();
    const externalGotos = new Set();
    const constants = new Map();
    for (const statement of script.globals) {
        if (statement.kind !== 'declare' || !statement.constant || !statement.initial)
            continue;
        const value = constant(statement.initial, constants);
        if (value !== undefined)
            constants.set(statement.name, value);
    }
    const pending = script.scenes.length && !blockTerminates(script.globals, constants) ? [script.scenes[0].name] : [];
    while (pending.length) {
        const name = pending.pop();
        if (reachableScenes.has(name))
            continue;
        const scene = scenes.get(name);
        if (!scene)
            continue;
        reachableScenes.add(name);
        for (const target of reachableGotoTargets(scene.body, new Set(), constants)) {
            if (scenes.has(target))
                pending.push(target);
            else
                externalGotos.add(target);
        }
    }
    if (!script.scenes.length) {
        for (const target of reachableGotoTargets(script.globals, new Set(), constants))
            externalGotos.add(target);
    }
    return { reachableScenes, externalGotos };
}
function analyzeExpression(expr, file, out, constants = new Map()) {
    const walk = (current, parent) => {
        if (current.kind === 'binary') {
            const right = constant(current.right, constants);
            if ((current.operator === '/' || current.operator === '%') && right === 0n) {
                out.push(diagnostic(file, 'division-by-zero', 'warning', '0 による除算または剰余は実行時エラーになります', current));
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
            if (!((current.operator === 'and' && left === false) || (current.operator === 'or' && left === true)))
                walk(current.right, current);
        }
        if (current.kind === 'unary')
            walk(current.value, current);
        if (current.kind === 'index') {
            walk(current.target, current);
            walk(current.key, current);
        }
        if (current.kind === 'call')
            current.args.forEach((arg) => walk(arg, current));
        if (current.kind === 'dict')
            current.entries.forEach((entry) => walk(entry.value, current));
    };
    walk(expr);
}
function analyzeBlock(statements, file, out, reachable = true, constants = new Map(), facts = new Map()) {
    let canReach = reachable;
    const known = new Map(constants);
    const knownFacts = new Map(facts);
    for (const statement of statements) {
        if (!canReach) {
            out.push(diagnostic(file, 'unreachable-code', 'warning', 'この文には到達できません', statement));
            for (const body of nested(statement))
                analyzeBlock(body, file, out, false, known, knownFacts);
            continue;
        }
        statementExpressions(statement).forEach((expr) => analyzeExpression(expr, file, out, known));
        if (statement.kind === 'set' && statement.target.kind === 'variable' && statement.value.kind === 'variable' && statement.target.name === statement.value.name) {
            out.push(diagnostic(file, 'self-assignment', 'warning', `変数 '${statement.target.name}' を同じ値で上書きしています`, statement));
        }
        if (statement.kind === 'if') {
            const branches = [{ expression: statement.condition.expression, body: statement.body }, ...statement.elseIf.map((branch) => ({ expression: branch.condition.expression, body: branch.body }))];
            const seen = new Set(), previousConditions = [], remainingFacts = new Map(knownFacts);
            let previousAlways = false;
            for (const branch of branches) {
                const key = expressionKey(branch.expression);
                const value = conditionValue(branch.expression, known, remainingFacts);
                const exactDuplicate = isPureExpression(branch.expression) && seen.has(key);
                const subsumed = isPureExpression(branch.expression) && previousConditions.some((previous) => conditionImplies(branch.expression, previous, known));
                const duplicate = exactDuplicate || subsumed;
                if (exactDuplicate)
                    out.push(diagnostic(file, 'duplicate-condition', 'warning', '前の分岐と同じ条件なので、この分岐には到達できません', branch.expression));
                else if (subsumed)
                    out.push(diagnostic(file, 'unreachable-branch', 'warning', '前の分岐条件に含まれるため、この分岐には到達できません', branch.expression));
                if (previousAlways)
                    out.push(diagnostic(file, 'unreachable-branch', 'warning', '前の条件が常に真なので、この分岐には到達できません', branch.expression));
                else if (value === false)
                    out.push(diagnostic(file, 'constant-condition', 'warning', '条件は常に偽です。この分岐には到達できません', branch.expression));
                else if (value === true)
                    out.push(diagnostic(file, 'constant-condition', 'info', '条件は常に真です。後続の分岐は実行されません', branch.expression));
                const bodyFacts = new Map(remainingFacts);
                recordCondition(bodyFacts, branch.expression, true);
                analyzeBlock(branch.body, file, out, canReach && !previousAlways && value !== false && !duplicate, known, bodyFacts);
                if (isPureExpression(branch.expression))
                    seen.add(key);
                if (isPureExpression(branch.expression))
                    previousConditions.push(branch.expression);
                recordCondition(remainingFacts, branch.expression, false);
                if (value === true)
                    previousAlways = true;
            }
            if (statement.otherwise.length)
                analyzeBlock(statement.otherwise, file, out, canReach && !previousAlways, known, remainingFacts);
            if (previousAlways && statement.otherwise.length)
                out.push(diagnostic(file, 'unreachable-branch', 'warning', '前の条件が常に真なので、else には到達できません', statement.otherwise[0]));
        }
        else if (statement.kind === 'while') {
            const value = conditionValue(statement.condition.expression, known, knownFacts);
            if (value === false)
                out.push(diagnostic(file, 'constant-condition', 'warning', 'while の条件は常に偽です。ループ本体には到達できません', statement.condition));
            const stable = loopConstants(statement, known);
            const bodyFacts = new Map();
            recordCondition(bodyFacts, statement.condition.expression, true);
            if (conditionValue(statement.condition.expression, stable, new Map()) === true && !blockTerminates(statement.body, stable, bodyFacts))
                out.push(diagnostic(file, 'infinite-loop', 'warning', 'while の条件は常に真で、ループ本体は後続へ進みません', statement.condition));
            analyzeBlock(statement.body, file, out, canReach && value !== false, stable, bodyFacts);
        }
        else if (statement.kind === 'for') {
            analyzeBlock(statement.body, file, out, canReach, loopConstants(statement, known), new Map());
        }
        else {
            for (const body of nested(statement))
                analyzeBlock(body, file, out, canReach, known, knownFacts);
        }
        if (canReach && definitelyTerminates(statement, known, knownFacts))
            canReach = false;
        updateKnownConstants(statement, known);
        if (invalidatesConditionFacts(statement))
            knownFacts.clear();
    }
}
function analyzeUnused(fn, file, out) {
    const declared = new Map();
    const used = new Set();
    fn.params.forEach((param) => declared.set(param.name, fn));
    const walk = (statements) => {
        for (const statement of statements) {
            if (statement.kind === 'declare')
                declared.set(statement.name, statement);
            for (const expr of statementExpressions(statement))
                visitExpressions(expr, (current) => {
                    if (current.kind === 'variable' && !(statement.kind === 'set' && statement.target === current))
                        used.add(current.name);
                    if (current.kind === 'literal' && typeof current.value === 'string') {
                        for (const match of current.value.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g))
                            used.add(match[1]);
                    }
                });
            nested(statement).forEach(walk);
        }
    };
    walk(fn.body);
    for (const [name, loc] of declared)
        if (!used.has(name))
            out.push(diagnostic(file, 'unused-variable', 'warning', `変数または引数 '${name}' は使用されていません`, loc));
}
function analyzeScript(script, file = 'current', externalGlobals = new Map(), externalCharacters = new Map()) {
    const out = [];
    const constants = new Map();
    for (const statement of script.globals) {
        if (statement.kind !== 'declare' || !statement.constant || !statement.initial)
            continue;
        const value = constant(statement.initial, constants);
        if (value !== undefined)
            constants.set(statement.name, value);
    }
    try {
        const typeErrors = [];
        (0, type_checker_1.checkTypes)(script, file, externalGlobals, externalCharacters, typeErrors);
        typeErrors.forEach((error) => out.push(errorDiagnostic(error, file)));
    }
    catch (error) {
        out.push(errorDiagnostic(error, file));
    }
    analyzeBlock(script.globals, file, out, true, constants);
    for (const fn of script.functions) {
        const functionConstants = new Map(constants);
        fn.params.forEach((param) => functionConstants.delete(param.name));
        analyzeBlock(fn.body, file, out, true, functionConstants);
        analyzeUnused(fn, file, out);
        if (fn.returnType !== 'none' && !blockTerminates(fn.body, functionConstants)) {
            out.push(diagnostic(file, 'missing-return', 'error', `関数 '${fn.name}' はすべての経路で値を返していません`, fn));
        }
    }
    const { reachableScenes } = sceneReachability(script);
    script.scenes.forEach((scene) => {
        const reachable = reachableScenes.has(scene.name);
        if (!reachable)
            out.push(diagnostic(file, 'unreachable-scene', 'warning', `シーン '${scene.name}' には到達できません`, scene));
        analyzeBlock(scene.body, file, out, reachable, constants);
    });
    return out.sort((a, b) => a.line - b.line || a.column - b.column || ({ error: 0, warning: 1, info: 2 }[a.severity] - { error: 0, warning: 1, info: 2 }[b.severity]));
}
function assertAnalyzed(script, file = 'current', externalGlobals = new Map(), externalCharacters = new Map()) {
    const diagnostics = analyzeScript(script, file, externalGlobals, externalCharacters);
    const first = diagnostics.find((item) => item.severity === 'error');
    if (first)
        throw new Error(`line ${first.line}, column ${first.column}: ${first.message}`);
    return diagnostics;
}
