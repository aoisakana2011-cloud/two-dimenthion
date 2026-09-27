"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sceneReachability = sceneReachability;
exports.analyzeScript = analyzeScript;
exports.assertAnalyzed = assertAnalyzed;
const type_checker_1 = require("./type-checker");
const INT_MIN = -(1n << 63n);
const INT_MAX = (1n << 63n) - 1n;
function at(node) {
    return {
        line: node?.line ?? 1,
        column: node?.column ?? 1,
        ...(node?.endLine ? { endLine: node.endLine } : {}),
        ...(node?.endColumn ? { endColumn: node.endColumn } : {}),
    };
}
function diagnostic(file, code, severity, message, node, variable) {
    return { code, severity, message, ...(variable !== undefined ? { variable } : {}), file: node?.file || file, ...at(node) };
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
    if (expr.kind === 'call') {
        const argument = expr.args.length === 1 ? constant(expr.args[0], constants) : undefined;
        if (expr.name === 'str' && typeof argument === 'bigint')
            return String(argument);
        if (expr.name === 'int' && typeof argument === 'string' && /^[+-]?\d+$/.test(argument))
            return BigInt(argument);
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
function checkedInteger(expr, constants = new Map()) {
    const inRange = (value) => value < INT_MIN || value > INT_MAX ? 'overflow' : value;
    if (expr.kind === 'literal') {
        if (typeof expr.value === 'string')
            return undefined;
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
                if (raw === INT_MAX + 1n)
                    return INT_MIN;
            }
        }
        const value = checkedInteger(expr.value, constants);
        if (value === 'overflow' || value === undefined)
            return value;
        if (expr.operator === '+')
            return value;
        if (expr.operator === '-')
            return value === INT_MIN ? 'overflow' : -value;
        return undefined;
    }
    if (expr.kind === 'call') {
        if (expr.name !== 'int' || expr.args.length !== 1)
            return undefined;
        const value = constant(expr.args[0], constants);
        return typeof value === 'bigint' ? inRange(value) : undefined;
    }
    if (expr.kind !== 'binary')
        return undefined;
    const left = checkedInteger(expr.left, constants);
    if (left === 'overflow')
        return 'overflow';
    const right = checkedInteger(expr.right, constants);
    if (right === 'overflow')
        return 'overflow';
    if (left === undefined || right === undefined)
        return undefined;
    let value;
    if (expr.operator === '+')
        value = left + right;
    else if (expr.operator === '-')
        value = left - right;
    else if (expr.operator === '*')
        value = left * right;
    else if (expr.operator === '/' && right !== 0n)
        value = left / right;
    else if (expr.operator === '%' && right !== 0n)
        value = left % right;
    else
        return undefined;
    return inRange(value);
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
function constrainedCondition(expr, constraints) {
    if (!constraints)
        return undefined;
    if (expr.kind === 'unary' && expr.operator === 'not') {
        const value = constrainedCondition(expr.value, constraints);
        return value === undefined ? undefined : !value;
    }
    if (expr.kind === 'binary' && (expr.operator === 'and' || expr.operator === 'or')) {
        const combined = combinedIntegerCondition(expr, constraints);
        if (combined !== undefined)
            return combined;
        const finite = combinedFiniteCondition(expr, constraints);
        if (finite !== undefined)
            return finite;
        const left = constrainedCondition(expr.left, constraints);
        const right = constrainedCondition(expr.right, constraints);
        if (expr.operator === 'and')
            return left === false || right === false ? false : left === true && right === true ? true : undefined;
        return left === true || right === true ? true : left === false && right === false ? false : undefined;
    }
    if (expr.kind !== 'binary' || !['==', '!=', '>', '>=', '<', '<='].includes(expr.operator))
        return undefined;
    let name;
    let expected;
    let operator = expr.operator;
    if (expr.left.kind === 'variable') {
        name = expr.left.name;
        expected = expr.right.kind === 'literal' ? (typeof expr.right.value === 'string' ? expr.right.value : integer(expr.right.value)) : undefined;
    }
    else if (expr.right.kind === 'variable') {
        name = expr.right.name;
        expected = expr.left.kind === 'literal' ? (typeof expr.left.value === 'string' ? expr.left.value : integer(expr.left.value)) : undefined;
        const flipped = { '==': '==', '!=': '!=', '>': '<', '>=': '<=', '<': '>', '<=': '>=' };
        operator = flipped[operator];
    }
    if (!name || expected === undefined)
        return undefined;
    const constraint = constraints.get(name);
    if (!constraint || constraint.type === 'int' && typeof expected !== 'bigint' || constraint.type === 'str' && typeof expected !== 'string')
        return undefined;
    const accepts = (value) => {
        if (operator === '==')
            return value === expected;
        if (operator === '!=')
            return value !== expected;
        if (typeof value !== 'bigint' || typeof expected !== 'bigint')
            return false;
        if (operator === '>')
            return value > expected;
        if (operator === '>=')
            return value >= expected;
        if (operator === '<')
            return value < expected;
        return value <= expected;
    };
    if (constraint.values) {
        const values = [...constraint.values];
        if (!values.length)
            return undefined;
        const results = values.map(accepts);
        return results.every(Boolean) ? true : results.every((value) => !value) ? false : undefined;
    }
    if (typeof expected !== 'bigint' || constraint.type !== 'int' || constraint.min === undefined || constraint.max === undefined)
        return undefined;
    const minimum = accepts(constraint.min), maximum = accepts(constraint.max);
    if (operator === '==' || operator === '!=') {
        if (expected < constraint.min || expected > constraint.max)
            return operator === '!=';
        if (constraint.min === constraint.max)
            return operator === '==' ? minimum : !minimum;
        return undefined;
    }
    if (minimum && maximum)
        return true;
    if (!minimum && !maximum && ((operator === '>' && constraint.max <= expected) || (operator === '>=' && constraint.max < expected) || (operator === '<' && constraint.min >= expected) || (operator === '<=' && constraint.min > expected)))
        return false;
    return undefined;
}
function conditionValue(expr, constants, facts, constraints) {
    const value = constant(expr, constants);
    if (value !== undefined || !isPureExpression(expr))
        return value;
    const constrained = constrainedCondition(expr, constraints);
    if (constrained !== undefined)
        return constrained;
    return facts.get(expressionKey(expr));
}
function recordCondition(facts, expr, value) {
    if (!isPureExpression(expr))
        return;
    facts.set(expressionKey(expr), value);
    const inverse = inverseExpressionKey(expr);
    if (inverse)
        facts.set(inverse, !value);
    if (expr.kind === 'unary' && expr.operator === 'not') {
        recordCondition(facts, expr.value, !value);
    }
    else if (expr.kind === 'binary' && expr.operator === 'and' && value) {
        recordCondition(facts, expr.left, true);
        recordCondition(facts, expr.right, true);
    }
    else if (expr.kind === 'binary' && expr.operator === 'or' && !value) {
        recordCondition(facts, expr.left, false);
        recordCondition(facts, expr.right, false);
    }
}
function refineConstraints(constraints, expr, truth) {
    if (!constraints)
        return undefined;
    if (expr.kind === 'unary' && expr.operator === 'not')
        return refineConstraints(constraints, expr.value, !truth);
    if (expr.kind !== 'binary')
        return constraints;
    if (expr.operator === 'and' && truth) {
        const left = refineConstraints(constraints, expr.left, true);
        return refineConstraints(left || constraints, expr.right, true);
    }
    if (expr.operator === 'or' && !truth) {
        const left = refineConstraints(constraints, expr.left, false);
        return refineConstraints(left || constraints, expr.right, false);
    }
    if (!['==', '!=', '>', '>=', '<', '<='].includes(expr.operator))
        return constraints;
    let name;
    let expected;
    let operator = expr.operator;
    if (expr.left.kind === 'variable') {
        name = expr.left.name;
        expected = expr.right.kind === 'literal' ? (typeof expr.right.value === 'string' ? expr.right.value : integer(expr.right.value)) : undefined;
    }
    else if (expr.right.kind === 'variable') {
        name = expr.right.name;
        expected = expr.left.kind === 'literal' ? (typeof expr.left.value === 'string' ? expr.left.value : integer(expr.left.value)) : undefined;
        const flipped = { '==': '==', '!=': '!=', '>': '<', '>=': '<=', '<': '>', '<=': '>=' };
        operator = flipped[operator];
    }
    if (!name || expected === undefined)
        return constraints;
    const current = constraints.get(name);
    if (!current || current.type !== (typeof expected === 'bigint' ? 'int' : 'str'))
        return constraints;
    const inverse = { '==': '!=', '!=': '==', '>': '<=', '>=': '<', '<': '>=', '<=': '>' };
    const effective = truth ? operator : inverse[operator];
    const next = { ...current };
    if (current.type === 'str') {
        if (effective === '==' && current.values)
            next.values = new Set([...current.values].filter((value) => value === expected));
        else if (effective === '!=' && current.values)
            next.values = new Set([...current.values].filter((value) => value !== expected));
    }
    else if (typeof expected === 'bigint') {
        if (effective === '==') {
            next.min = expected;
            next.max = expected;
            if (current.values)
                next.values = new Set([...current.values].filter((value) => value === expected));
        }
        else if (effective === '>')
            next.min = current.min === undefined || current.min <= expected ? expected + 1n : current.min;
        else if (effective === '>=')
            next.min = current.min === undefined || current.min < expected ? expected : current.min;
        else if (effective === '<')
            next.max = current.max === undefined || current.max >= expected ? expected - 1n : current.max;
        else if (effective === '<=')
            next.max = current.max === undefined || current.max > expected ? expected : current.max;
        if (current.values)
            next.values = new Set([...current.values].filter((value) => {
                if (typeof value !== 'bigint')
                    return false;
                if (effective === '==')
                    return value === expected;
                if (effective === '!=')
                    return value !== expected;
                if (effective === '>')
                    return value > expected;
                if (effective === '>=')
                    return value >= expected;
                if (effective === '<')
                    return value < expected;
                return value <= expected;
            }));
    }
    const result = new Map(constraints);
    result.set(name, next);
    return result;
}
function mergeConstraints(paths) {
    const available = paths.filter((path) => !!path);
    if (!available.length)
        return undefined;
    const result = new Map();
    for (const name of available[0].keys()) {
        const entries = available.map((path) => path.get(name));
        if (entries.some((entry) => !entry) || entries.some((entry) => entry.type !== entries[0].type))
            continue;
        const merged = { type: entries[0].type };
        const mins = entries.map((entry) => entry.min).filter((value) => value !== undefined);
        const maxs = entries.map((entry) => entry.max).filter((value) => value !== undefined);
        if (mins.length === entries.length)
            merged.min = mins.reduce((minimum, value) => value < minimum ? value : minimum);
        if (maxs.length === entries.length)
            merged.max = maxs.reduce((maximum, value) => value > maximum ? value : maximum);
        if (entries.every((entry) => !!entry.values)) {
            const values = new Set();
            entries.forEach((entry) => entry.values.forEach((value) => values.add(value)));
            merged.values = values;
        }
        result.set(name, merged);
    }
    return result;
}
function finiteBranchCoverage(statement, constraints) {
    const branches = [statement.condition.expression, ...statement.elseIf.map((branch) => branch.condition.expression)];
    let name;
    const covered = new Set();
    for (const expression of branches) {
        if (expression.kind !== 'binary' || expression.operator !== '==')
            return undefined;
        let variable;
        let value;
        if (expression.left.kind === 'variable' && expression.right.kind === 'literal') {
            variable = expression.left.name;
            value = typeof expression.right.value === 'string' ? expression.right.value : integer(expression.right.value);
        }
        else if (expression.right.kind === 'variable' && expression.left.kind === 'literal') {
            variable = expression.right.name;
            value = typeof expression.left.value === 'string' ? expression.left.value : integer(expression.left.value);
        }
        if (!variable || value === undefined || name && name !== variable)
            return undefined;
        name = variable;
        covered.add(value);
    }
    if (!name)
        return undefined;
    const constraint = constraints?.get(name);
    if (!constraint?.values)
        return undefined;
    const allowed = new Set(constraint.values);
    const typeMatches = [...allowed].every((value) => constraint.type === 'str' ? typeof value === 'string' : typeof value === 'bigint');
    return typeMatches ? { name, allowed, covered } : undefined;
}
function integerRangeCoverage(statement, constraints) {
    const branches = [statement.condition.expression, ...statement.elseIf.map((branch) => branch.condition.expression)];
    let name;
    let range;
    const intervals = [];
    for (const expression of branches) {
        if (expression.kind !== 'binary' || !['==', '<', '<=', '>', '>='].includes(expression.operator))
            return undefined;
        let variable;
        let value;
        let operator = expression.operator;
        if (expression.left.kind === 'variable') {
            variable = expression.left.name;
            value = expression.right.kind === 'literal' && typeof expression.right.value !== 'string' ? integer(expression.right.value) : undefined;
        }
        else if (expression.right.kind === 'variable') {
            variable = expression.right.name;
            value = expression.left.kind === 'literal' && typeof expression.left.value !== 'string' ? integer(expression.left.value) : undefined;
            const flipped = { '==': '==', '<': '>', '<=': '>=', '>': '<', '>=': '<=' };
            operator = flipped[operator];
        }
        if (!variable || value === undefined || name && name !== variable)
            return undefined;
        name = variable;
        const constraint = constraints?.get(name);
        if (!constraint || constraint.type !== 'int' || constraint.min === undefined || constraint.max === undefined)
            return undefined;
        range = { min: constraint.min, max: constraint.max };
        const interval = operator === '==' ? { min: value, max: value }
            : operator === '<' ? { min: range.min, max: value - 1n }
                : operator === '<=' ? { min: range.min, max: value }
                    : operator === '>' ? { min: value + 1n, max: range.max } : { min: value, max: range.max };
        const min = interval.min < range.min ? range.min : interval.min;
        const max = interval.max > range.max ? range.max : interval.max;
        if (min <= max)
            intervals.push({ min, max });
    }
    if (!name || !range)
        return undefined;
    intervals.sort((left, right) => left.min < right.min ? -1 : left.min > right.min ? 1 : 0);
    let cursor = range.min;
    for (const interval of intervals) {
        if (interval.min > cursor)
            return { name, exhaustive: false };
        if (interval.max >= cursor)
            cursor = interval.max + 1n;
        if (cursor > range.max)
            return { name, exhaustive: true };
    }
    return { name, exhaustive: cursor > range.max };
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
function combinedIntegerCondition(expr, constraints) {
    if (expr.operator !== 'and' && expr.operator !== 'or')
        return undefined;
    const left = integerConstraint(expr.left, new Map()), right = integerConstraint(expr.right, new Map());
    if (!left || !right || left.name !== right.name)
        return undefined;
    const constraint = constraints.get(left.name);
    if (!constraint || constraint.type !== 'int')
        return undefined;
    const accepts = (predicate, value) => {
        if (predicate.operator === '==')
            return value === predicate.value;
        if (predicate.operator === '!=')
            return value !== predicate.value;
        if (predicate.operator === '>')
            return value > predicate.value;
        if (predicate.operator === '>=')
            return value >= predicate.value;
        if (predicate.operator === '<')
            return value < predicate.value;
        return value <= predicate.value;
    };
    if (constraint.values) {
        const results = [...constraint.values].map((value) => expr.operator === 'and' ? accepts(left, value) && accepts(right, value) : accepts(left, value) || accepts(right, value));
        return results.length && results.every(Boolean) ? true : results.length && results.every((value) => !value) ? false : undefined;
    }
    if (constraint.min === undefined || constraint.max === undefined || left.operator === '!=' || right.operator === '!=')
        return undefined;
    const minimum = constraint.min, maximum = constraint.max;
    const interval = (predicate) => {
        if (predicate.operator === '==')
            return [predicate.value, predicate.value];
        if (predicate.operator === '>')
            return [predicate.value + 1n, maximum];
        if (predicate.operator === '>=')
            return [predicate.value, maximum];
        if (predicate.operator === '<')
            return [minimum, predicate.value - 1n];
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
function combinedFiniteCondition(expr, constraints) {
    if (expr.operator !== 'and' && expr.operator !== 'or')
        return undefined;
    const parse = (value) => {
        if (value.kind !== 'binary' || !['==', '!='].includes(value.operator))
            return undefined;
        if (value.left.kind === 'variable' && value.right.kind === 'literal') {
            const expected = typeof value.right.value === 'string' ? value.right.value : integer(value.right.value);
            return expected === undefined ? undefined : { name: value.left.name, operator: value.operator, expected };
        }
        if (value.right.kind === 'variable' && value.left.kind === 'literal') {
            const expected = typeof value.left.value === 'string' ? value.left.value : integer(value.left.value);
            return expected === undefined ? undefined : { name: value.right.name, operator: value.operator, expected };
        }
        return undefined;
    };
    const left = parse(expr.left), right = parse(expr.right);
    if (!left || !right || left.name !== right.name)
        return undefined;
    const constraint = constraints.get(left.name);
    if (!constraint?.values)
        return undefined;
    if (constraint.type === 'str' && (typeof left.expected !== 'string' || typeof right.expected !== 'string'))
        return undefined;
    if (constraint.type === 'int' && (typeof left.expected !== 'bigint' || typeof right.expected !== 'bigint'))
        return undefined;
    const accepts = (predicate, value) => predicate.operator === '==' ? value === predicate.expected : value !== predicate.expected;
    const results = [...constraint.values].map((value) => expr.operator === 'and' ? accepts(left, value) && accepts(right, value) : accepts(left, value) || accepts(right, value));
    return results.length && results.every(Boolean) ? true : results.length && results.every((value) => !value) ? false : undefined;
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
    if (expr.kind === 'literal')
        return typeof expr.value !== 'string' || !/\{[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*(?:\(\))?\}/.test(expr.value);
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
// Keep this in lockstep with the browser and native runtimes: a statically
// known zero step, or a step pointing away from its bound, is a runtime error.
// A valid inclusive for-loop always executes at least once.
function forExecution(statement, constants) {
    const start = constant(statement.start, constants);
    const stop = constant(statement.stop, constants);
    const step = constant(statement.step, constants);
    if (typeof start !== 'bigint' || typeof stop !== 'bigint' || typeof step !== 'bigint')
        return 'unknown';
    if (step === 0n || (start < stop && step < 0n) || (start > stop && step > 0n))
        return 'invalid';
    return 'runs';
}
function forIterationCount(statement, constants) {
    const start = constant(statement.start, constants);
    const stop = constant(statement.stop, constants);
    const step = constant(statement.step, constants);
    if (typeof start !== 'bigint' || typeof stop !== 'bigint' || typeof step !== 'bigint' || step === 0n)
        return undefined;
    if ((start < stop && step < 0n) || (start > stop && step > 0n))
        return undefined;
    return step > 0n ? (stop - start) / step + 1n : (start - stop) / (-step) + 1n;
}
function integerBounds(expression, constants, constraints) {
    const value = constant(expression, constants);
    if (typeof value === 'bigint')
        return { min: value, max: value };
    if (expression.kind === 'variable') {
        const constraint = constraints?.get(expression.name);
        if (constraint?.type !== 'int')
            return undefined;
        if (constraint.values?.size) {
            const values = [...constraint.values].filter((item) => typeof item === 'bigint');
            if (values.length !== constraint.values.size)
                return undefined;
            return { min: values.reduce((left, right) => left < right ? left : right), max: values.reduce((left, right) => left > right ? left : right) };
        }
        if (constraint.min !== undefined && constraint.max !== undefined)
            return { min: constraint.min, max: constraint.max };
    }
    if (expression.kind === 'binary' && (expression.operator === '+' || expression.operator === '-')) {
        const left = integerBounds(expression.left, constants, constraints);
        const right = integerBounds(expression.right, constants, constraints);
        if (left && right)
            return expression.operator === '+' ? { min: left.min + right.min, max: left.max + right.max } : { min: left.min - right.max, max: left.max - right.min };
    }
    return undefined;
}
function forVariableBounds(statement, constants, constraints) {
    const start = integerBounds(statement.start, constants, constraints);
    const stop = integerBounds(statement.stop, constants, constraints);
    const stepValue = constant(statement.step, constants);
    const step = typeof stepValue === 'bigint' ? { min: stepValue, max: stepValue } : integerBounds(statement.step, constants, constraints);
    if (!start || !stop || !step || step.min === 0n || step.min <= 0n && step.max >= 0n)
        return undefined;
    return {
        min: start.min < stop.min ? start.min : stop.min,
        max: start.max > stop.max ? start.max : stop.max,
    };
}
function forBodyConstraints(statement, constants, constraints) {
    const bounds = forVariableBounds(statement, constants, constraints);
    if (!bounds)
        return constraints;
    const result = constraints ? new Map(constraints) : new Map();
    result.set(statement.name, { type: 'int', min: bounds.min, max: bounds.max });
    return result;
}
function forIterationUpperBound(statement, constants, constraints) {
    const start = integerBounds(statement.start, constants, constraints);
    const stop = integerBounds(statement.stop, constants, constraints);
    const stepValue = constant(statement.step, constants);
    const step = typeof stepValue === 'bigint'
        ? { min: stepValue, max: stepValue }
        : integerBounds(statement.step, constants, constraints);
    if (!start || !stop || !step || step.min === 0n || step.min <= 0n && step.max >= 0n)
        return undefined;
    if (step.min > 0n) {
        if (stop.max < start.min)
            return 0n;
        return (stop.max - start.min) / step.min + 1n;
    }
    if (start.max < stop.min)
        return 0n;
    return (start.max - stop.min) / (-step.max) + 1n;
}
function referencesVariable(expression, name) {
    if (expression.kind === 'variable')
        return expression.name === name;
    if (expression.kind === 'binary')
        return referencesVariable(expression.left, name) || referencesVariable(expression.right, name);
    if (expression.kind === 'unary')
        return referencesVariable(expression.value, name);
    if (expression.kind === 'index')
        return referencesVariable(expression.target, name) || referencesVariable(expression.key, name);
    if (expression.kind === 'call')
        return expression.args.some((argument) => referencesVariable(argument, name));
    if (expression.kind === 'dict')
        return expression.entries.some((entry) => referencesVariable(entry.value, name));
    return false;
}
function loopUpdate(statement, name) {
    const updates = statement.body.filter((current) => current.kind === 'set' && current.target.kind === 'variable' && (name === undefined || current.target.name === name));
    if (updates.length !== 1 || statement.body.some((current) => current !== updates[0] && (current.kind !== 'command' || hasCalls(current))))
        return undefined;
    return updates[0];
}
function whileProgress(statement, constants) {
    const condition = statement.condition.expression;
    if (condition.kind !== 'binary' || !['<', '<=', '>', '>='].includes(condition.operator))
        return undefined;
    let name;
    let operator = condition.operator;
    let boundExpression;
    if (condition.left.kind === 'variable') {
        name = condition.left.name;
        boundExpression = condition.right;
    }
    else if (condition.right.kind === 'variable') {
        name = condition.right.name;
        boundExpression = condition.left;
        const flipped = { '>': '<', '>=': '<=', '<': '>', '<=': '>=' };
        operator = flipped[operator];
    }
    if (!name || !boundExpression || referencesVariable(boundExpression, name))
        return undefined;
    const bound = constant(boundExpression, constants);
    if (typeof bound !== 'bigint')
        return undefined;
    const update = loopUpdate(statement, name);
    if (!update)
        return undefined;
    if (update.kind !== 'set' || update.target.kind !== 'variable' || update.target.name !== name)
        return undefined;
    const expression = update.value;
    let step;
    if (expression.kind === 'binary') {
        if (expression.left.kind === 'variable' && expression.left.name === name && !referencesVariable(expression.right, name)) {
            const amount = constant(expression.right, constants);
            if (typeof amount === 'bigint')
                step = expression.operator === '+' ? amount : expression.operator === '-' ? -amount : undefined;
        }
        else if (expression.operator === '+' && expression.right.kind === 'variable' && expression.right.name === name && !referencesVariable(expression.left, name)) {
            const amount = constant(expression.left, constants);
            if (typeof amount === 'bigint')
                step = amount;
        }
    }
    const start = constants.get(name);
    if (typeof start !== 'bigint')
        return undefined;
    const initiallyTrue = operator === '>' ? start > bound
        : operator === '>=' ? start >= bound
            : operator === '<' ? start < bound : start <= bound;
    return { name, operator, start, bound, step, update: expression, initiallyTrue };
}
function whileIterationUpperBound(statement, constants, constraints) {
    const condition = statement.condition.expression;
    if (condition.kind !== 'binary' || !['<', '<=', '>', '>='].includes(condition.operator))
        return undefined;
    let name;
    let operator = condition.operator;
    let boundExpression;
    if (condition.left.kind === 'variable') {
        name = condition.left.name;
        boundExpression = condition.right;
    }
    else if (condition.right.kind === 'variable') {
        name = condition.right.name;
        boundExpression = condition.left;
        const flipped = { '>': '<', '>=': '<=', '<': '>', '<=': '>=' };
        operator = flipped[operator];
    }
    if (!name || !boundExpression || referencesVariable(boundExpression, name))
        return undefined;
    const bound = constant(boundExpression, constants);
    const start = integerBounds({ kind: 'variable', name }, constants, constraints);
    if (typeof bound !== 'bigint' || !start)
        return undefined;
    const conditionPossible = operator === '<' ? start.min < bound : operator === '<=' ? start.min <= bound : operator === '>' ? start.max > bound : start.max >= bound;
    if (!writtenVariables(statement).has(name) && !hasCalls(statement))
        return conditionPossible ? 'non-terminating' : 0n;
    const update = loopUpdate(statement, name);
    if (!update || update.target.kind !== 'variable' || update.target.name !== name || update.value.kind !== 'binary')
        return undefined;
    let step;
    if (update.value.left.kind === 'variable' && update.value.left.name === name && !referencesVariable(update.value.right, name)) {
        const amount = constant(update.value.right, constants);
        if (typeof amount === 'bigint')
            step = update.value.operator === '+' ? amount : update.value.operator === '-' ? -amount : undefined;
    }
    else if (update.value.operator === '+' && update.value.right.kind === 'variable' && update.value.right.name === name && !referencesVariable(update.value.left, name)) {
        const amount = constant(update.value.left, constants);
        if (typeof amount === 'bigint')
            step = amount;
    }
    if (step === undefined)
        return undefined;
    if (step === 0n)
        return conditionPossible ? 'non-terminating' : 0n;
    const increasing = operator === '<' || operator === '<=';
    if ((increasing && step < 0n) || (!increasing && step > 0n))
        return conditionPossible ? 'non-terminating' : 0n;
    if (increasing) {
        if (start.min > bound || (operator === '<' && start.min === bound))
            return 0n;
        const distance = bound - start.min;
        return operator === '<' ? (distance + step - 1n) / step : distance / step + 1n;
    }
    if (start.max < bound || (operator === '>' && start.max === bound))
        return 0n;
    const distance = start.max - bound;
    return operator === '>' ? (distance + (-step) - 1n) / (-step) : distance / (-step) + 1n;
}
function whileIterationCount(statement, constants) {
    const progress = whileProgress(statement, constants);
    if (!progress)
        return undefined;
    const { operator, start, bound, step, initiallyTrue } = progress;
    if (step === undefined)
        return whileExpressionIterations(progress, constants);
    if (!initiallyTrue)
        return 0n;
    if (step === 0n)
        return 'non-terminating';
    const increasing = operator === '<' || operator === '<=';
    if ((increasing && step < 0n) || (!increasing && step > 0n)) {
        const afterLimit = start + step * 100000n;
        if (afterLimit >= INT_MIN && afterLimit <= INT_MAX)
            return 'non-terminating';
        return undefined;
    }
    const distance = increasing ? bound - start : start - bound;
    const amount = step < 0n ? -step : step;
    if (operator === '<' || operator === '>')
        return (distance + amount - 1n) / amount;
    return distance / amount + 1n;
}
function whileExpressionOverflows(progress, constants) {
    let current = progress.start;
    for (let count = 0; count < 100000; count += 1) {
        const condition = progress.operator === '>' ? current > progress.bound
            : progress.operator === '>=' ? current >= progress.bound
                : progress.operator === '<' ? current < progress.bound : current <= progress.bound;
        if (!condition)
            return false;
        const iterationConstants = new Map(constants);
        iterationConstants.set(progress.name, current);
        const next = checkedInteger(progress.update, iterationConstants);
        if (next === 'overflow')
            return true;
        if (next === undefined)
            return false;
        current = next;
    }
    return false;
}
function whileExpressionIterations(progress, constants) {
    let current = progress.start;
    const seen = new Set();
    for (let count = 0; count <= 100000; count += 1) {
        const condition = progress.operator === '>' ? current > progress.bound
            : progress.operator === '>=' ? current >= progress.bound
                : progress.operator === '<' ? current < progress.bound : current <= progress.bound;
        if (!condition)
            return BigInt(count);
        if (count === 100000 || seen.has(current.toString()))
            return 'non-terminating';
        seen.add(current.toString());
        const iterationConstants = new Map(constants);
        iterationConstants.set(progress.name, current);
        const next = checkedInteger(progress.update, iterationConstants);
        if (next === 'overflow' || next === undefined)
            return undefined;
        current = next;
    }
    return 'non-terminating';
}
function whileUpdateOverflows(statement, constants) {
    const progress = whileProgress(statement, constants);
    if (!progress || !progress.initiallyTrue)
        return false;
    if (progress.step === undefined)
        return whileExpressionOverflows(progress, constants);
    if (progress.step === 0n)
        return false;
    // Count the body updates needed to leave the signed 64-bit domain in the
    // update direction. Runtime checks its 100,000-iteration limit before the
    // next body, so an overflow after that point is not the observed failure.
    const updatesToOverflow = progress.step > 0n
        ? (INT_MAX - progress.start) / progress.step + 1n
        : (progress.start - INT_MIN) / (-progress.step) + 1n;
    if (updatesToOverflow > 100000n)
        return false;
    const iterations = whileIterationCount(statement, constants);
    // Non-terminating or direction-unknown loops continue until either the
    // runtime limit or this update overflow. Finite loops only reach the
    // overflow if enough condition-true iterations are guaranteed.
    return typeof iterations !== 'bigint' ? true : updatesToOverflow <= iterations;
}
function forFirstIterationOverflows(statement, constants) {
    const start = constant(statement.start, constants);
    const stop = constant(statement.stop, constants);
    const step = constant(statement.step, constants);
    if (typeof start !== 'bigint' || typeof stop !== 'bigint' || typeof step !== 'bigint' || step === 0n)
        return false;
    if ((start < stop && step < 0n) || (start > stop && step > 0n))
        return false;
    const update = loopUpdate(statement);
    if (!update || !referencesVariable(update.value, statement.name))
        return false;
    const firstIteration = new Map(constants);
    firstIteration.set(statement.name, start);
    return checkedInteger(update.value, firstIteration) === 'overflow';
}
function forRepeatedUpdateOverflows(statement, constants) {
    const iterations = forIterationCount(statement, constants);
    if (iterations === undefined || iterations <= 0n)
        return false;
    const update = loopUpdate(statement);
    if (!update || update.target.kind !== 'variable' || update.value.kind !== 'binary')
        return false;
    const name = update.target.name;
    const start = constants.get(name);
    if (typeof start !== 'bigint')
        return false;
    let delta;
    if (update.value.left.kind === 'variable' && update.value.left.name === name && !referencesVariable(update.value.right, name)) {
        const amount = constant(update.value.right, constants);
        if (typeof amount === 'bigint')
            delta = update.value.operator === '+' ? amount : update.value.operator === '-' ? -amount : undefined;
    }
    else if (update.value.operator === '+' && update.value.right.kind === 'variable' && update.value.right.name === name && !referencesVariable(update.value.left, name)) {
        const amount = constant(update.value.left, constants);
        if (typeof amount === 'bigint')
            delta = amount;
    }
    if (delta !== undefined && delta !== 0n) {
        const updatesToOverflow = delta > 0n
            ? (INT_MAX - start) / delta + 1n
            : (start - INT_MIN) / (-delta) + 1n;
        if (updatesToOverflow <= iterations && updatesToOverflow <= 100000n)
            return true;
    }
    // A loop variable is also a constant at each individual iteration. Track
    // the accumulator for the observable prefix of the loop so expressions such
    // as `value = value + i` cannot hide an overflow on a later iteration.
    const loopStart = constant(statement.start, constants);
    const loopStep = constant(statement.step, constants);
    if (typeof loopStart !== 'bigint' || typeof loopStep !== 'bigint' || loopStep === 0n)
        return false;
    const observedIterations = iterations < 100000n ? iterations : 100000n;
    let current = start;
    let loopValue = loopStart;
    for (let index = 0n; index < observedIterations; index += 1n) {
        const iterationConstants = new Map(constants);
        iterationConstants.set(name, current);
        iterationConstants.set(statement.name, loopValue);
        const next = checkedInteger(update.value, iterationConstants);
        if (next === 'overflow')
            return true;
        if (next === undefined)
            return false;
        current = next;
        loopValue += loopStep;
    }
    return false;
}
function forConstraintUpdateOverflow(statement, constants, constraints) {
    const update = loopUpdate(statement);
    if (!update || update.target.kind !== 'variable' || update.target.name === statement.name || !constraints?.has(update.target.name) || constant(update.value, constants) !== undefined)
        return undefined;
    const bodyConstraints = forBodyConstraints(statement, constants, constraints);
    const bounds = integerBounds(update.value, constants, bodyConstraints);
    const start = integerBounds(statement.start, constants, constraints);
    const stop = integerBounds(statement.stop, constants, constraints);
    const stepValue = constant(statement.step, constants);
    const step = typeof stepValue === 'bigint' ? { min: stepValue, max: stepValue } : integerBounds(statement.step, constants, constraints);
    const guaranteed = start && stop && step && step.min === step.max && step.min !== 0n
        ? step.min > 0n ? start.max <= stop.min : start.min >= stop.max
        : false;
    let severity;
    if (bounds && (bounds.min < INT_MIN || bounds.max > INT_MAX))
        severity = bounds.min > INT_MAX || bounds.max < INT_MIN ? (guaranteed ? 'error' : 'warning') : 'warning';
    let delta;
    if (update.value.kind === 'binary') {
        if (update.value.left.kind === 'variable' && update.value.left.name === update.target.name && !referencesVariable(update.value.right, update.target.name)) {
            const amount = constant(update.value.right, constants);
            if (typeof amount === 'bigint')
                delta = update.value.operator === '+' ? amount : update.value.operator === '-' ? -amount : undefined;
        }
        else if (update.value.operator === '+' && update.value.right.kind === 'variable' && update.value.right.name === update.target.name && !referencesVariable(update.value.left, update.target.name)) {
            const amount = constant(update.value.left, constants);
            if (typeof amount === 'bigint')
                delta = amount;
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
function definitelyTerminates(statement, constants = new Map(), facts = new Map(), constraints) {
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
            const value = conditionValue(branch.condition, constants, remainingFacts, constraints);
            if (value === false) {
                recordCondition(remainingFacts, branch.condition, false);
                continue;
            }
            const key = expressionKey(branch.condition);
            if (isPureExpression(branch.condition) && (seen.has(key) || previousConditions.some((previous) => conditionImplies(branch.condition, previous, constants))))
                continue;
            const bodyFacts = new Map(remainingFacts);
            recordCondition(bodyFacts, branch.condition, true);
            allTerminate = allTerminate && blockTerminates(branch.body, constants, bodyFacts, constraints);
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
            allTerminate = allTerminate && blockTerminates(statement.otherwise, constants, remainingFacts, constraints);
        }
        return allTerminate;
    }
    if (statement.kind === 'while') {
        if (conditionValue(statement.condition.expression, constants, facts, constraints) !== true)
            return false;
        const stable = loopConstants(statement, constants);
        return conditionValue(statement.condition.expression, stable, new Map(), constraints) === true || blockTerminates(statement.body, constants, facts, constraints);
    }
    if (statement.kind === 'for')
        return forExecution(statement, constants) !== 'invalid' && blockTerminates(statement.body, constants, facts, forBodyConstraints(statement, constants, constraints));
    if (statement.kind === 'choice')
        return statement.options.length > 0 && statement.options.every((option) => blockTerminates(option.body, constants, facts, constraints));
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
let activeFunctionEffects = new Map();
function callChangesState(name) {
    if (name === 'int' || name === 'str')
        return false;
    const effects = activeFunctionEffects.get(name);
    return !effects || effects.has('*') || effects.size > 0;
}
function invalidateConstraintCalls(expressions, constraints, names = []) {
    if (!constraints)
        return;
    const invalidate = (name) => {
        if (!callChangesState(name))
            return;
        const effects = activeFunctionEffects.get(name);
        if (!effects || effects.has('*'))
            constraints.clear();
        else
            effects.forEach((effect) => constraints.delete(effect));
    };
    names.forEach(invalidate);
    expressions.forEach((expression) => visitExpressions(expression, (current) => {
        if (current.kind === 'call')
            invalidate(current.name);
    }));
}
function invalidateConstraintCallsInExecution(expression, constants, facts, constraints) {
    if (!constraints)
        return;
    if (expression.kind === 'binary' && (expression.operator === 'and' || expression.operator === 'or')) {
        invalidateConstraintCallsInExecution(expression.left, constants, facts, constraints);
        const left = conditionValue(expression.left, constants, facts, constraints);
        if (expression.operator === 'and' && left === false || expression.operator === 'or' && left === true)
            return;
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
    if (expression.kind === 'dict')
        invalidateConstraintCallsInExecutionForArguments(expression.entries.map((entry) => entry.value), constants, facts, constraints);
}
function invalidateConstraintCallsInExecutionForArguments(expressions, constants, facts, constraints) {
    expressions.forEach((expression) => invalidateConstraintCallsInExecution(expression, constants, facts, constraints));
}
function invalidateConstraintState(statement, constraints) {
    if (!constraints)
        return;
    writtenVariables(statement).forEach((name) => constraints.delete(name));
    invalidateConstraintCalls(statementExpressions(statement), constraints, statement.kind === 'call' ? [statement.name] : []);
}
function expressionCalls(expr) {
    const calls = new Set();
    visitExpressions(expr, (current) => {
        if (current.kind === 'call')
            calls.add(current.name);
        if (current.kind === 'literal' && typeof current.value === 'string') {
            for (const match of current.value.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\(\)\}/g))
                calls.add(match[1]);
        }
    });
    return calls;
}
function expressionChangesState(expr) {
    return [...expressionCalls(expr)].some(callChangesState);
}
function invalidateConstantCall(name, constants) {
    if (!callChangesState(name))
        return false;
    const effects = activeFunctionEffects.get(name);
    if (!effects || effects.has('*'))
        constants.clear();
    else
        effects.forEach((effect) => constants.delete(effect));
    return true;
}
function invalidateConstantCalls(expr, constants, facts) {
    if (expr.kind === 'binary' && (expr.operator === 'and' || expr.operator === 'or')) {
        let invalidated = invalidateConstantCalls(expr.left, constants, facts);
        const left = conditionValue(expr.left, constants, facts);
        if (expr.operator === 'and' && left === false || expr.operator === 'or' && left === true)
            return invalidated;
        return invalidateConstantCalls(expr.right, constants, facts) || invalidated;
    }
    if (expr.kind === 'binary')
        return invalidateConstantCalls(expr.right, constants, facts) || invalidateConstantCalls(expr.left, constants, facts);
    if (expr.kind === 'unary')
        return invalidateConstantCalls(expr.value, constants, facts);
    if (expr.kind === 'index')
        return invalidateConstantCalls(expr.key, constants, facts) || invalidateConstantCalls(expr.target, constants, facts);
    if (expr.kind === 'dict')
        return expr.entries.reduce((changed, entry) => invalidateConstantCalls(entry.value, constants, facts) || changed, false);
    if (expr.kind === 'call') {
        const argumentsChanged = expr.args.reduce((changed, argument) => invalidateConstantCalls(argument, constants, facts) || changed, false);
        return invalidateConstantCall(expr.name, constants) || argumentsChanged;
    }
    if (expr.kind === 'literal' && typeof expr.value === 'string') {
        let invalidated = false;
        for (const match of expr.value.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\(\)\}/g))
            invalidated = invalidateConstantCall(match[1], constants) || invalidated;
        return invalidated;
    }
    return false;
}
function hasCalls(statement) {
    return statement.kind === 'call' && callChangesState(statement.name) || statementExpressions(statement).some(expressionChangesState) || nested(statement).some((body) => body.some(hasCalls));
}
function functionEffects(functions, globals) {
    const direct = new Map(), calls = new Map();
    for (const fn of functions) {
        const writes = new Set(), invoked = new Set();
        const walk = (statements, locals) => {
            for (const statement of statements) {
                if (statement.kind === 'declare') {
                    if (statement.global) {
                        if (globals.has(statement.name))
                            writes.add(statement.name);
                    }
                    else
                        locals.add(statement.name);
                }
                if (statement.kind === 'set' || statement.kind === 'unset') {
                    const target = statement.target;
                    if (target.kind === 'variable' && !locals.has(target.name) && globals.has(target.name))
                        writes.add(target.name);
                }
                if (statement.kind === 'call' && statement.name !== 'int' && statement.name !== 'str')
                    invoked.add(statement.name);
                for (const expression of statementExpressions(statement))
                    expressionCalls(expression).forEach((name) => { if (name !== 'int' && name !== 'str')
                        invoked.add(name); });
                for (const body of nested(statement))
                    walk(body, new Set(locals));
            }
        };
        walk(fn.body, new Set(fn.params.map((param) => param.name)));
        direct.set(fn.name, writes);
        calls.set(fn.name, invoked);
    }
    for (const [name, invoked] of calls)
        for (const callee of invoked)
            if (!direct.has(callee))
                direct.get(name).add('*');
    let changed = true;
    while (changed) {
        changed = false;
        for (const [name, invoked] of calls)
            for (const callee of invoked)
                for (const effect of direct.get(callee) || ['*']) {
                    const writes = direct.get(name);
                    if (!writes.has(effect)) {
                        writes.add(effect);
                        changed = true;
                    }
                }
    }
    return direct;
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
    if (statement.kind === 'declare' || statement.kind === 'set' || statement.kind === 'unset')
        return true;
    if (statement.kind === 'call')
        return callChangesState(statement.name);
    return statementExpressions(statement).some((expr) => {
        let calls = false;
        visitExpressions(expr, (current) => {
            if (current.kind === 'call' && callChangesState(current.name))
                calls = true;
            if (current.kind === 'literal' && typeof current.value === 'string' && /\{[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*(?:\(\))?\}/.test(current.value))
                calls = true;
        });
        return calls;
    });
}
function blockTerminates(statements, constants = new Map(), facts = new Map(), constraints) {
    const known = new Map(constants);
    const knownFacts = new Map(facts);
    for (const statement of statements) {
        if (hasCalls(statement)) {
            known.clear();
            knownFacts.clear();
        }
        if (definitelyTerminates(statement, known, knownFacts, constraints))
            return true;
        updateKnownConstants(statement, known);
        if (invalidatesConditionFacts(statement))
            knownFacts.clear();
    }
    return false;
}
function reachableGotoTargets(statements, targets = new Set(), constants = new Map(), facts = new Map(), constraints) {
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
                const value = conditionValue(branch.expression, known, remainingFacts, constraints);
                const key = expressionKey(branch.expression);
                const duplicate = isPureExpression(branch.expression) && (seen.has(key) || previousConditions.some((previous) => conditionImplies(branch.expression, previous, known)));
                const bodyFacts = new Map(remainingFacts);
                recordCondition(bodyFacts, branch.expression, true);
                if (value !== false && !duplicate)
                    reachableGotoTargets(branch.body, targets, known, bodyFacts, constraints);
                if (isPureExpression(branch.expression))
                    seen.add(key);
                if (isPureExpression(branch.expression))
                    previousConditions.push(branch.expression);
                recordCondition(remainingFacts, branch.expression, false);
                if (value === true)
                    canTryNext = false;
            }
            if (canTryNext)
                reachableGotoTargets(statement.otherwise, targets, known, remainingFacts, constraints);
        }
        else if (statement.kind === 'choice')
            statement.options.forEach((option) => reachableGotoTargets(option.body, targets, known, knownFacts, constraints));
        else if (statement.kind === 'while') {
            if (conditionValue(statement.condition.expression, known, knownFacts, constraints) !== false) {
                const bodyFacts = new Map(knownFacts);
                recordCondition(bodyFacts, statement.condition.expression, true);
                reachableGotoTargets(statement.body, targets, known, bodyFacts, constraints);
            }
        }
        else if (statement.kind === 'for') {
            if (forExecution(statement, known) !== 'invalid')
                reachableGotoTargets(statement.body, targets, known, knownFacts, constraints);
        }
        if (definitelyTerminates(statement, known, knownFacts, constraints))
            break;
        updateKnownConstants(statement, known);
        if (invalidatesConditionFacts(statement))
            knownFacts.clear();
    }
    return targets;
}
function mergeConstantEnvironments(paths) {
    if (!paths.length)
        return new Map();
    const merged = new Map(paths[0]);
    for (const [name, value] of merged) {
        if (paths.some((path) => !path.has(name) || path.get(name) !== value))
            merged.delete(name);
    }
    return merged;
}
/** Propagate known values through scene-local branches to each reachable transfer. */
function reachableTransfers(statements, constants = new Map(), facts = new Map(), constraints) {
    const known = new Map(constants);
    const knownFacts = new Map(facts);
    const transfers = [];
    for (const statement of statements) {
        if (statement.kind === 'goto')
            return { transfers: [...transfers, { target: statement.scene, constants: new Map(known) }] };
        if (statement.kind === 'if') {
            const branches = [{ expression: statement.condition.expression, body: statement.body }, ...statement.elseIf.map((branch) => ({ expression: branch.condition.expression, body: branch.body }))];
            const seen = new Set(), previousConditions = [], remainingFacts = new Map(knownFacts), remainingKnown = new Map(known);
            const fallthroughs = [];
            let canTryNext = true;
            for (const branch of branches) {
                if (!canTryNext)
                    break;
                if (invalidateConstantCalls(branch.expression, remainingKnown, remainingFacts))
                    remainingFacts.clear();
                const value = conditionValue(branch.expression, remainingKnown, remainingFacts, constraints);
                const key = expressionKey(branch.expression);
                const duplicate = isPureExpression(branch.expression) && (seen.has(key) || previousConditions.some((previous) => conditionImplies(branch.expression, previous, remainingKnown)));
                const bodyFacts = new Map(remainingFacts);
                recordCondition(bodyFacts, branch.expression, true);
                const bodyConstraints = refineConstraints(constraints, branch.expression, true);
                if (value !== false && !duplicate) {
                    const flow = reachableTransfers(branch.body, remainingKnown, bodyFacts, bodyConstraints);
                    transfers.push(...flow.transfers);
                    if (flow.fallthrough)
                        fallthroughs.push(flow.fallthrough);
                    else if (!blockTerminates(branch.body, remainingKnown, bodyFacts, bodyConstraints))
                        fallthroughs.push(new Map(remainingKnown));
                }
                if (isPureExpression(branch.expression))
                    seen.add(key);
                if (isPureExpression(branch.expression))
                    previousConditions.push(branch.expression);
                recordCondition(remainingFacts, branch.expression, false);
                if (value === true)
                    canTryNext = false;
            }
            if (canTryNext) {
                const otherwiseConstraints = branches.reduce((state, branch) => refineConstraints(state, branch.expression, false), constraints);
                const flow = reachableTransfers(statement.otherwise, remainingKnown, remainingFacts, otherwiseConstraints);
                transfers.push(...flow.transfers);
                if (flow.fallthrough)
                    fallthroughs.push(flow.fallthrough);
                else if (!blockTerminates(statement.otherwise, remainingKnown, remainingFacts, otherwiseConstraints))
                    fallthroughs.push(new Map(remainingKnown));
            }
            if (!fallthroughs.length)
                return { transfers };
            const joined = mergeConstantEnvironments(fallthroughs);
            known.clear();
            joined.forEach((value, name) => known.set(name, value));
            if (invalidatesConditionFacts(statement))
                knownFacts.clear();
            continue;
        }
        if (statement.kind === 'choice') {
            if (!statement.options.length)
                continue;
            const choiceState = new Map(known);
            const choiceFacts = new Map(knownFacts);
            // Runtime evaluates every label in order, then the prompt, before any
            // option body executes. Account for state-changing calls at that point.
            for (const option of statement.options)
                if (invalidateConstantCalls(option.label, choiceState, choiceFacts))
                    choiceFacts.clear();
            if (statement.prompt && invalidateConstantCalls(statement.prompt, choiceState, choiceFacts))
                choiceFacts.clear();
            const fallthroughs = [];
            for (const option of statement.options) {
                const flow = reachableTransfers(option.body, choiceState, choiceFacts, constraints);
                transfers.push(...flow.transfers);
                if (flow.fallthrough)
                    fallthroughs.push(flow.fallthrough);
                else if (!blockTerminates(option.body, choiceState, choiceFacts, constraints))
                    fallthroughs.push(new Map(choiceState));
            }
            if (!fallthroughs.length)
                return { transfers };
            const joined = mergeConstantEnvironments(fallthroughs);
            known.clear();
            joined.forEach((value, name) => known.set(name, value));
            for (const name of writtenVariables(statement))
                known.delete(name);
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
                        if (!flow.fallthrough) {
                            fallsThrough = false;
                            break;
                        }
                        state = flow.fallthrough;
                        state.delete(statement.name);
                        value += step;
                    }
                    if (!fallsThrough)
                        return { transfers };
                    known.clear();
                    state.forEach((valueAtExit, name) => known.set(name, valueAtExit));
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
                    if (conditionValue(statement.condition.expression, state, knownFacts, constraints) === false)
                        break;
                    const flow = reachableTransfers(statement.body, state, knownFacts, constraints);
                    transfers.push(...flow.transfers);
                    if (!flow.fallthrough) {
                        fallsThrough = false;
                        break;
                    }
                    state = flow.fallthrough;
                }
                if (!fallsThrough)
                    return { transfers };
                known.clear();
                state.forEach((valueAtExit, name) => known.set(name, valueAtExit));
                knownFacts.clear();
                continue;
            }
        }
        // Preserve transfer discovery for loops and other nested flow constructs.
        // Their post-loop values are widened by updateKnownConstants below.
        if (statement.kind === 'while' || statement.kind === 'for') {
            if (statement.kind === 'while' && conditionValue(statement.condition.expression, known, knownFacts, constraints) === false)
                continue;
            const loopState = loopConstants(statement, known);
            for (const target of reachableGotoTargets([statement], new Set(), known, knownFacts, constraints)) {
                transfers.push({ target, constants: new Map(loopState) });
            }
            if (definitelyTerminates(statement, known, knownFacts, constraints))
                return { transfers };
        }
        if (definitelyTerminates(statement, known, knownFacts, constraints))
            return { transfers };
        updateKnownConstants(statement, known);
        if (invalidatesConditionFacts(statement))
            knownFacts.clear();
    }
    return { transfers, fallthrough: known };
}
function sceneReachability(script, constraints, externalGlobals = new Set()) {
    const globalNames = new Set([...externalGlobals, ...script.globals.filter((statement) => statement.kind === 'declare').map((statement) => statement.name)]);
    activeFunctionEffects = functionEffects(script.functions, globalNames);
    const scenes = new Map(script.scenes.map((scene) => [scene.name, scene]));
    const firstSceneByFile = new Map();
    const normalizeFile = (file) => file.replaceAll('\\', '/').replace(/^\.\//, '').toLocaleLowerCase('en-US');
    const firstSceneForFileTarget = (target) => {
        const normalized = normalizeFile(target);
        if (/\.txt$/i.test(normalized))
            return undefined;
        const fileName = /\.tds$/i.test(normalized) ? normalized : `${normalized}.tds`;
        return firstSceneByFile.get(fileName);
    };
    for (const scene of script.scenes) {
        if (scene.file && !firstSceneByFile.has(normalizeFile(scene.file)))
            firstSceneByFile.set(normalizeFile(scene.file), scene.name);
    }
    const reachableScenes = new Set();
    const externalGotos = new Set();
    const constants = new Map();
    const globalFlow = reachableTransfers(script.globals, constants, new Map(), constraints);
    const pending = [];
    const enqueueTarget = (target, state) => {
        if (scenes.has(target))
            pending.push({ name: target, constants: state });
        else {
            const fileEntry = firstSceneForFileTarget(target);
            if (fileEntry)
                pending.push({ name: fileEntry, constants: state });
            else
                externalGotos.add(target);
        }
    };
    if (script.scenes.length && globalFlow.fallthrough)
        pending.push({ name: script.scenes[0].name, constants: globalFlow.fallthrough });
    globalFlow.transfers.forEach((transfer) => enqueueTarget(transfer.target, transfer.constants));
    const entryStates = new Map();
    while (pending.length) {
        const { name, constants: incoming } = pending.pop();
        const scene = scenes.get(name);
        if (!scene)
            continue;
        const previous = entryStates.get(name);
        const entry = previous ? mergeConstantEnvironments([previous, incoming]) : new Map(incoming);
        if (previous && previous.size === entry.size && [...previous].every(([key, value]) => entry.get(key) === value))
            continue;
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
function constraintViolation(value, constraint) {
    if (constraint.type === 'int' && typeof value !== 'bigint')
        return '整数';
    if (constraint.type === 'str' && typeof value !== 'string')
        return '文字列';
    if (constraint.values && (typeof value === 'string' || typeof value === 'bigint') && !constraint.values.has(value))
        return '許容値集合';
    if (typeof value === 'bigint') {
        if (constraint.min !== undefined && value < constraint.min)
            return `min=${constraint.min}`;
        if (constraint.max !== undefined && value > constraint.max)
            return `max=${constraint.max}`;
    }
    return undefined;
}
function analyzeVariableConstraints(statements, file, out, constraints) {
    for (const statement of statements) {
        if (statement.kind === 'declare' || statement.kind === 'set') {
            const name = statement.kind === 'declare' ? statement.name : statement.target.kind === 'variable' ? statement.target.name : undefined;
            const expression = statement.kind === 'declare' ? statement.initial : statement.value;
            const constraint = name ? constraints.get(name) : undefined;
            const value = expression ? constant(expression) : undefined;
            const reason = constraint && value !== undefined ? constraintViolation(value, constraint) : undefined;
            if (reason)
                out.push(diagnostic(file, 'variable-constraint', 'error', `変数 '${name}' の値は変数テーブルの制約 (${reason}) を満たしません`, statement, name));
        }
        for (const body of nested(statement))
            analyzeVariableConstraints(body, file, out, constraints);
    }
}
/**
 * Track only statically known character/position pairs.  The runtime replaces
 * an existing occupant when `show` targets the same position, so this is a
 * warning rather than a type error.  Unknown positions and dynamic commands
 * are deliberately ignored to avoid claiming more certainty than the script
 * provides.
 */
function analyzeCharacterPlacements(statements, file, out, initial = new Map(), emitted = new Set()) {
    const analyze = (items, incoming) => {
        let states = [new Map(incoming)];
        for (const statement of items) {
            const next = [];
            for (const state of states) {
                const command = statement.kind === 'command' ? statement : undefined;
                if (command?.name === 'show' && command.args[0]?.kind === 'literal' && typeof command.args[0].value === 'string'
                    && command.args[0].value !== 'image' && command.args[1]?.kind === 'literal' && typeof command.args[1].value === 'string') {
                    const match = /^([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(command.args[0].value);
                    const position = command.args[1].value;
                    if (match) {
                        const previous = state.get(position);
                        const character = match[1];
                        const key = `${statement.line ?? 1}:${statement.column ?? 1}:${position}:${character}:${previous ?? ''}`;
                        if (previous && previous !== character && !emitted.has(key)) {
                            emitted.add(key);
                            out.push(diagnostic(file, 'character-slot-conflict', 'warning', `position '${position}' already contains character '${previous}'; showing '${character}' replaces it`, statement));
                        }
                        state.set(position, character);
                    }
                }
                else if (command?.name === 'hide' && command.args[0]?.kind === 'literal' && typeof command.args[0].value === 'string') {
                    const character = command.args[0].value;
                    if (![...state.values()].includes(character)) {
                        const key = `${statement.line ?? 1}:${statement.column ?? 1}:${character}`;
                        if (!emitted.has(key)) {
                            emitted.add(key);
                            out.push(diagnostic(file, 'hide-unshown-character', 'warning', `character '${character}' is hidden before it is statically shown`, statement));
                        }
                    }
                    for (const [position, occupant] of state)
                        if (occupant === character)
                            state.delete(position);
                }
                if (statement.kind === 'if') {
                    const branchStates = [];
                    branchStates.push(...analyze(statement.body, new Map(state)));
                    for (const branch of statement.elseIf)
                        branchStates.push(...analyze(branch.body, new Map(state)));
                    if (statement.otherwise.length)
                        branchStates.push(...analyze(statement.otherwise, new Map(state)));
                    else
                        branchStates.push(new Map(state));
                    next.push(...branchStates);
                }
                else if (statement.kind === 'choice') {
                    if (!statement.options.length)
                        next.push(state);
                    for (const option of statement.options)
                        next.push(...analyze(option.body, new Map(state)));
                }
                else if (statement.kind === 'while' || statement.kind === 'for') {
                    // A loop may execute zero times. Keep the incoming state and also
                    // inspect one body execution for conflicts inside the loop.
                    next.push(state, ...analyze(statement.body, new Map(state)));
                }
                else if (statement.kind !== 'goto' && statement.kind !== 'return') {
                    next.push(state);
                }
            }
            if (!next.length) {
                states = [];
                break;
            }
            states = next;
            // Avoid path explosion while preserving all facts common to the paths.
            const unique = new Map();
            for (const state of states) {
                const key = [...state.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([position, character]) => `${position}=${character}`).join('|');
                unique.set(key, state);
            }
            states = [...unique.values()].slice(0, 64);
        }
        return states;
    };
    return analyze(statements, initial);
}
/** Track statically known named image layers. `clear image` is a no-op when
 * the layer has not been shown, and separate IDs in one slot remain visible
 * together, so report both definite clears and accidental overlaps. */
function analyzeImageLayers(statements, file, out, initial = new Map(), emitted = new Set()) {
    const analyze = (items, incoming) => {
        let states = [new Map(incoming)];
        for (const statement of items) {
            const next = [];
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
                }
                else if (command?.name === 'clear' && command.args[0]?.kind === 'literal' && command.args[0].value === 'image'
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
                    const branchStates = [];
                    branchStates.push(...analyze(statement.body, new Map(state)));
                    for (const branch of statement.elseIf)
                        branchStates.push(...analyze(branch.body, new Map(state)));
                    if (statement.otherwise.length)
                        branchStates.push(...analyze(statement.otherwise, new Map(state)));
                    else
                        branchStates.push(new Map(state));
                    next.push(...branchStates);
                }
                else if (statement.kind === 'choice') {
                    if (!statement.options.length)
                        next.push(state);
                    for (const option of statement.options)
                        next.push(...analyze(option.body, new Map(state)));
                }
                else if (statement.kind === 'while' || statement.kind === 'for') {
                    next.push(state, ...analyze(statement.body, new Map(state)));
                }
                else if (statement.kind !== 'goto' && statement.kind !== 'return') {
                    next.push(state);
                }
            }
            if (!next.length) {
                states = [];
                break;
            }
            const unique = new Map();
            for (const state of next)
                unique.set([...state.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([image, slot]) => `${image}=${slot}`).join('|'), state);
            states = [...unique.values()].slice(0, 64);
        }
        return states;
    };
    return analyze(statements, initial);
}
/** Warn when a background or BGM is replaced without an explicit clear. */
function analyzeAssetReplacements(statements, file, out, kind, code, label, emitted = new Set()) {
    const analyze = (items, incoming) => {
        let states = [incoming];
        for (const statement of items) {
            const next = [];
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
                    if (current !== undefined && current !== assetName) {
                        const key = `${statement.line ?? 1}:${statement.column ?? 1}:${kind}:${current}:${assetName}`;
                        if (!emitted.has(key)) {
                            emitted.add(key);
                            out.push(diagnostic(file, code, 'warning', `${label} '${current}' is replaced by '${assetName}' without an explicit clear`, statement));
                        }
                    }
                    current = assetName;
                }
                else if (command?.name === 'clear' && command.args[0]?.kind === 'literal' && command.args[0].value === kind) {
                    current = undefined;
                }
                if (statement.kind === 'if') {
                    next.push(...analyze(statement.body, current));
                    for (const branch of statement.elseIf)
                        next.push(...analyze(branch.body, current));
                    if (statement.otherwise.length)
                        next.push(...analyze(statement.otherwise, current));
                    else
                        next.push(current);
                }
                else if (statement.kind === 'choice') {
                    for (const option of statement.options)
                        next.push(...analyze(option.body, current));
                }
                else if (statement.kind === 'while' || statement.kind === 'for') {
                    next.push(current, ...analyze(statement.body, current));
                }
                else {
                    next.push(current);
                }
            }
            states = next.length ? next.slice(0, 64) : [];
            if (statement.kind === 'goto' || statement.kind === 'return')
                break;
        }
        return states;
    };
    return analyze(statements, undefined);
}
/** The Browser and Native players expose one video layer. Track that contract
 * statically so an async video replacement is visible while editing. */
function analyzeVideoLayerReplacements(statements, file, out, emitted = new Set()) {
    const analyze = (items, incoming) => {
        let states = [incoming];
        for (const statement of items) {
            const next = [];
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
                    const branchStates = [];
                    branchStates.push(...analyze(statement.body, current));
                    for (const branch of statement.elseIf)
                        branchStates.push(...analyze(branch.body, current));
                    if (statement.otherwise.length)
                        branchStates.push(...analyze(statement.otherwise, current));
                    else
                        branchStates.push(current);
                    next.push(...branchStates);
                }
                else if (statement.kind === 'choice') {
                    if (!statement.options.length)
                        next.push(current);
                    for (const option of statement.options)
                        next.push(...analyze(option.body, current));
                }
                else if (statement.kind === 'while' || statement.kind === 'for') {
                    next.push(current, ...analyze(statement.body, current));
                }
                else if (statement.kind !== 'goto' && statement.kind !== 'return') {
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
function analyzeBgmClearDivergence(statements, file, out, emitted = new Set()) {
    const analyze = (items, incoming) => {
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
            const next = [];
            for (const active of states) {
                let current = active;
                if (command?.name === 'bgm' || (command?.name === 'play' && command.args[0]?.kind === 'literal' && command.args[0].value === 'bgm'))
                    current = true;
                else if (command?.name === 'clear' && command.args[0]?.kind === 'literal' && command.args[0].value === 'bgm')
                    current = false;
                if (statement.kind === 'if') {
                    const branchStates = [];
                    branchStates.push(...analyze(statement.body, current));
                    for (const branch of statement.elseIf)
                        branchStates.push(...analyze(branch.body, current));
                    if (statement.otherwise.length)
                        branchStates.push(...analyze(statement.otherwise, current));
                    else
                        branchStates.push(current);
                    next.push(...branchStates);
                }
                else if (statement.kind === 'choice') {
                    if (!statement.options.length)
                        next.push(current);
                    for (const option of statement.options)
                        next.push(...analyze(option.body, current));
                }
                else if (statement.kind === 'while' || statement.kind === 'for') {
                    next.push(current, ...analyze(statement.body, current));
                }
                else if (statement.kind !== 'goto' && statement.kind !== 'return') {
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
function analyzeBackgroundClearDivergence(statements, file, out, emitted = new Set()) {
    const analyze = (items, incoming) => {
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
            const next = [];
            for (const active of states) {
                let current = active;
                if (command?.name === 'bg')
                    current = true;
                else if (command?.name === 'clear' && command.args[0]?.kind === 'literal' && command.args[0].value === 'bg')
                    current = false;
                if (statement.kind === 'if') {
                    const branchStates = [];
                    branchStates.push(...analyze(statement.body, current));
                    for (const branch of statement.elseIf)
                        branchStates.push(...analyze(branch.body, current));
                    if (statement.otherwise.length)
                        branchStates.push(...analyze(statement.otherwise, current));
                    else
                        branchStates.push(current);
                    next.push(...branchStates);
                }
                else if (statement.kind === 'choice') {
                    if (!statement.options.length)
                        next.push(current);
                    for (const option of statement.options)
                        next.push(...analyze(option.body, current));
                }
                else if (statement.kind === 'while' || statement.kind === 'for') {
                    next.push(current, ...analyze(statement.body, current));
                }
                else if (statement.kind !== 'goto' && statement.kind !== 'return') {
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
function analyzeBlock(statements, file, out, reachable = true, constants = new Map(), facts = new Map(), constraints) {
    let canReach = reachable;
    const known = new Map(constants);
    const knownFacts = new Map(facts);
    const activeConstraints = constraints ? new Map(constraints) : undefined;
    for (const statement of statements) {
        if (!canReach) {
            out.push(diagnostic(file, 'unreachable-code', 'warning', 'この文には到達できません', statement));
            for (const body of nested(statement))
                analyzeBlock(body, file, out, false, known, knownFacts, activeConstraints);
            continue;
        }
        statementExpressions(statement).forEach((expr) => analyzeExpression(expr, file, out, known));
        statementExpressions(statement).forEach((expression) => invalidateConstraintCallsInExecution(expression, known, knownFacts, activeConstraints));
        if (statement.kind === 'call')
            invalidateConstraintCalls([], activeConstraints, [statement.name]);
        if (statement.kind === 'set' && statement.target.kind === 'variable' && activeConstraints?.get(statement.target.name)?.type === 'int' && constant(statement.value, known) === undefined) {
            const constraint = activeConstraints.get(statement.target.name);
            const bounds = integerBounds(statement.value, known, activeConstraints);
            if (bounds && (constraint.min !== undefined || constraint.max !== undefined)) {
                const definitelyOutside = constraint.min !== undefined && bounds.max < constraint.min || constraint.max !== undefined && bounds.min > constraint.max;
                const mayEscape = constraint.min !== undefined && bounds.min < constraint.min || constraint.max !== undefined && bounds.max > constraint.max;
                if (definitelyOutside)
                    out.push(diagnostic(file, 'variable-constraint', 'error', `変数 '${statement.target.name}' への代入値の範囲が変数テーブルの制約外です`, statement, statement.target.name));
                else if (mayEscape)
                    out.push(diagnostic(file, 'variable-constraint', 'warning', `変数 '${statement.target.name}' への代入値が変数テーブルの範囲を外れる可能性があります`, statement, statement.target.name));
            }
        }
        if (statement.kind === 'choice') {
            const labels = new Set();
            for (const option of statement.options) {
                const value = constant(option.label, known);
                const key = value !== undefined ? `${typeof value}:${String(value)}` : isPureExpression(option.label) ? expressionKey(option.label) : undefined;
                if (key && labels.has(key))
                    out.push(diagnostic(file, 'duplicate-choice-label', 'warning', '選択肢のラベルが重複しているため、利用者が区別できません', option.label));
                if (key)
                    labels.add(key);
            }
        }
        if (statement.kind === 'set' && statement.target.kind === 'variable' && statement.value.kind === 'variable' && statement.target.name === statement.value.name) {
            out.push(diagnostic(file, 'self-assignment', 'warning', `変数 '${statement.target.name}' を同じ値で上書きしています`, statement));
        }
        if (statement.kind === 'if') {
            const finiteCoverage = finiteBranchCoverage(statement, activeConstraints);
            const rangeCoverage = integerRangeCoverage(statement, activeConstraints);
            const incompleteFinite = finiteCoverage && !statement.otherwise.length && [...finiteCoverage.allowed].some((value) => !finiteCoverage.covered.has(value));
            const incompleteRange = rangeCoverage && !statement.otherwise.length && !rangeCoverage.exhaustive;
            if (incompleteFinite || incompleteRange) {
                const name = finiteCoverage?.name || rangeCoverage?.name || '変数';
                out.push(diagnostic(file, 'non-exhaustive-condition', 'warning', `変数 '${name}' の取り得る値をすべて処理していないため、未処理の値が残ります`, statement.condition));
            }
            const branches = [{ expression: statement.condition.expression, body: statement.body }, ...statement.elseIf.map((branch) => ({ expression: branch.condition.expression, body: branch.body }))];
            const seen = new Set(), previousConditions = [], remainingFacts = new Map(knownFacts);
            let remainingConstraints = activeConstraints;
            const branchConstraintPaths = [];
            let previousAlways = false;
            for (const branch of branches) {
                const key = expressionKey(branch.expression);
                const value = conditionValue(branch.expression, known, remainingFacts, remainingConstraints);
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
                const branchConstraints = refineConstraints(remainingConstraints, branch.expression, true) || remainingConstraints;
                // Branch bodies execute on separate paths.  Do not let a constant
                // learned in one branch leak into a sibling elif/else condition.
                analyzeBlock(branch.body, file, out, canReach && !previousAlways && value !== false && !duplicate, new Map(known), bodyFacts, branchConstraints);
                if (!previousAlways && value !== false && !duplicate)
                    branchConstraintPaths.push(branchConstraints);
                if (isPureExpression(branch.expression))
                    seen.add(key);
                if (isPureExpression(branch.expression))
                    previousConditions.push(branch.expression);
                recordCondition(remainingFacts, branch.expression, false);
                remainingConstraints = refineConstraints(remainingConstraints, branch.expression, false);
                if (value === true)
                    previousAlways = true;
            }
            if (statement.otherwise.length)
                analyzeBlock(statement.otherwise, file, out, canReach && !previousAlways, new Map(known), remainingFacts, remainingConstraints);
            if (!previousAlways)
                branchConstraintPaths.push(remainingConstraints);
            const mergedConstraints = mergeConstraints(branchConstraintPaths);
            if (activeConstraints && mergedConstraints) {
                const entries = [...mergedConstraints.entries()];
                activeConstraints.clear();
                entries.forEach(([name, constraint]) => activeConstraints.set(name, constraint));
            }
            if (previousAlways && statement.otherwise.length)
                out.push(diagnostic(file, 'unreachable-branch', 'warning', '前の条件が常に真なので、else には到達できません', statement.otherwise[0]));
        }
        else if (statement.kind === 'choice') {
            // Each choice option is a separate runtime path.  Keep option-local
            // constants, facts, and constraints isolated from sibling options.
            for (const option of statement.options) {
                analyzeBlock(option.body, file, out, canReach, new Map(known), new Map(knownFacts), activeConstraints ? new Map(activeConstraints) : undefined);
            }
        }
        else if (statement.kind === 'while') {
            const value = conditionValue(statement.condition.expression, known, knownFacts, activeConstraints);
            if (value === false)
                out.push(diagnostic(file, 'constant-condition', 'warning', 'while の条件は常に偽です。ループ本体には到達できません', statement.condition));
            const stable = loopConstants(statement, known);
            const bodyFacts = new Map();
            recordCondition(bodyFacts, statement.condition.expression, true);
            const stableCondition = conditionValue(statement.condition.expression, stable, new Map(), activeConstraints);
            if (stableCondition === true && !blockTerminates(statement.body, stable, bodyFacts, constraints))
                out.push(diagnostic(file, 'infinite-loop', 'warning', 'while の条件は常に真で、ループ本体は後続へ進みません', statement.condition));
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
            if (canReach && value === true && !blockTerminates(statement.body, stable, bodyFacts, activeConstraints))
                canReach = false;
        }
        else if (statement.kind === 'for') {
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
            analyzeBlock(statement.body, file, out, canReach && execution !== 'invalid', loopConstants(statement, known), new Map(), forBodyConstraints(statement, known, activeConstraints));
        }
        else {
            for (const body of nested(statement))
                analyzeBlock(body, file, out, canReach, known, knownFacts, activeConstraints);
        }
        if (canReach && definitelyTerminates(statement, known, knownFacts, activeConstraints))
            canReach = false;
        invalidateConstraintState(statement, activeConstraints);
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
                        for (const match of current.value.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\}/g))
                            used.add(match[1].split('.')[0]);
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
    const constraints = externalGlobals.constraints;
    const globalNames = new Set([...externalGlobals.keys(), ...externalCharacters.keys(), ...script.globals.filter((statement) => statement.kind === 'declare').map((statement) => statement.name)]);
    activeFunctionEffects = functionEffects(script.functions, globalNames);
    if (constraints) {
        analyzeVariableConstraints(script.globals, file, out, constraints);
        script.functions.forEach((fn) => analyzeVariableConstraints(fn.body, file, out, constraints));
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
        analyzeBlock(fn.body, file, out, true, functionConstants, new Map(), constraints);
        analyzeUnused(fn, file, out);
        if (fn.returnType !== 'none' && !blockTerminates(fn.body, functionConstants, new Map(), constraints)) {
            out.push(diagnostic(file, 'missing-return', 'error', `関数 '${fn.name}' はすべての経路で値を返していません`, fn));
        }
    }
    const { reachableScenes } = sceneReachability(script, constraints, new Set([...externalGlobals.keys(), ...externalCharacters.keys()]));
    script.scenes.forEach((scene) => {
        const reachable = reachableScenes.has(scene.name);
        if (!reachable)
            out.push(diagnostic(file, 'unreachable-scene', 'warning', `シーン '${scene.name}' には到達できません`, scene));
        // The scene-level warning already explains that this whole body cannot run.
        // Continue local analysis as reachable so we still report internal control-flow
        // mistakes without emitting a cascade of unreachable-code warnings per line.
        analyzeBlock(scene.body, file, out, true, constants, new Map(), constraints);
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
