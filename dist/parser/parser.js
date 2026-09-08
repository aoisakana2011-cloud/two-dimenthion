"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Parser = exports.ParseError = void 0;
exports.parse = parse;
const lexer_1 = require("./lexer");
const ASSET_TYPES = new Set(['bg', 'char', 'bgm', 'se', 'voice', 'video', 'image']);
const TYPES = new Set(['int', 'str', 'none']);
const PRECEDENCE = {
    or: 10,
    and: 20,
    '==': 40, '!=': 40, '>': 40, '>=': 40, '<': 40, '<=': 40,
    '+': 50, '-': 50,
    '*': 60, '/': 60, '%': 60,
};
const KEYWORDS = new Set([
    'scene', 'asset', 'character', 'int', 'str', 'dict', 'set', 'unset', 'say', 'bg', 'bgm', 'char', 'show', 'hide', 'image',
    'clear', 'play', 'effect', 'wait', 'if', 'elif', 'else', 'and', 'or', 'not', 'choice', 'for', 'from', 'to',
    'step', 'while', 'fn', 'return', 'goto', 'none', 'int', 'str', 'dict', 'async', 'blocking', 'voice', 'video',
    'include', 'struct', 'pose', 'at',
]);
class ParseError extends Error {
    token;
    constructor(message, token) {
        super(`${message} at line ${token.line}, column ${token.column}`);
        this.token = token;
        this.name = 'ParseError';
    }
}
exports.ParseError = ParseError;
class Parser {
    source;
    current;
    lexer;
    buffered = [];
    lastBlockEndLine = 1;
    constructor(source) {
        this.source = source;
        this.lexer = new lexer_1.Lexer(source);
        this.current = this.lexer.next();
    }
    parse() {
        const assets = [];
        const characters = [];
        const globals = [];
        const functions = [];
        const scenes = [];
        const structs = [];
        const includes = [];
        this.skipLines();
        while (!this.at('eof')) {
            if (this.atWord('asset')) {
                assets.push(this.parseAsset());
                this.endLine();
            }
            else if (this.atWord('character')) {
                characters.push(this.parseCharacter());
                this.skipLines();
            }
            else if (this.atWord('fn')) {
                functions.push(this.parseFunction());
                this.skipLines();
            }
            else if (this.atWord('struct')) {
                structs.push(this.parseStruct());
                this.skipLines();
            }
            else if (this.atWord('scene')) {
                scenes.push(this.parseScene());
                this.skipLines();
            }
            else if (this.atWord('include')) {
                includes.push(this.parseInclude());
                this.endLine();
            }
            else {
                const stmt = this.parseStatement();
                globals.push(stmt);
                this.endStatement(stmt);
            }
            this.skipLines();
        }
        return { kind: 'script', assets, characters, structs, globals, functions, scenes, includes, body: globals };
    }
    parseInclude() {
        this.take();
        if (this.current.type === 'string')
            return this.take().value;
        const parts = [];
        while (!this.at('newline') && !this.at('eof'))
            parts.push(this.take().value);
        const value = parts.join('');
        if (!value)
            throw this.error('Expected include path');
        return value;
    }
    parseAsset() {
        const start = this.take();
        const type = this.expectWord('Expected asset type');
        if (!ASSET_TYPES.has(type))
            throw this.error(`Unknown asset type '${type}'`);
        const name = this.expectIdentifier('Expected asset name');
        this.expect('=');
        const path = this.expect('string', 'Asset path must be a string').value;
        return { kind: 'asset', type, name, path, line: start.line, column: start.column };
    }
    parseCharacter() {
        const start = this.take();
        const name = this.expectIdentifier('Expected character name');
        this.skipLines();
        this.expect('{');
        const properties = [];
        const poses = [];
        this.skipLines();
        while (!this.atValue('}')) {
            const propertyToken = this.current;
            if (this.atWord('pose')) {
                this.take();
                const pose = this.expectIdentifier('Expected pose name');
                this.expect('=');
                const path = this.expect('string', 'Character pose path must be a string').value;
                poses.push({ name: pose, path, line: propertyToken.line, column: propertyToken.column });
            }
            else {
                const property = this.expectIdentifier('Expected character property or pose declaration');
                this.expect('=');
                properties.push({ name: property, value: this.parseExpression(), line: propertyToken.line, column: propertyToken.column });
            }
            this.endLine();
            this.skipLines();
        }
        const closing = this.take();
        return { kind: 'character', name, properties, poses, line: start.line, column: start.column, endLine: closing.line };
    }
    parseStruct() {
        const start = this.take();
        const name = this.expectIdentifier('Expected struct name');
        this.skipLines();
        this.expect('{');
        this.skipLines();
        const fields = {};
        while (!this.atValue('}')) {
            const field = this.expectIdentifier('Expected field name');
            this.expect(':');
            const type = this.expectWord('Expected field type');
            if (type !== 'int' && type !== 'str')
                throw this.error('Struct fields must be int or str');
            if (fields[field])
                throw this.error(`Duplicate struct field '${field}'`);
            fields[field] = type;
            this.endLine();
            this.skipLines();
        }
        this.take();
        return { kind: 'struct', name, fields, line: start.line, column: start.column };
    }
    parseFunction() {
        const start = this.take();
        const name = this.expectIdentifier('Expected function name');
        this.expect('(');
        const params = [];
        if (!this.atValue(')')) {
            while (true) {
                const paramName = this.expectIdentifier('Expected parameter name');
                this.expect(':');
                const type = this.parseType(false);
                params.push({ name: paramName, type });
                if (!this.optional(','))
                    break;
            }
        }
        this.expect(')');
        this.expect('->');
        const returnType = this.parseType(true);
        return { kind: 'function', name, returnType, params, body: this.parseBraced(), line: start.line, column: start.column };
    }
    parseScene() {
        const start = this.take();
        const name = this.expectIdentifier('Expected scene name');
        return { kind: 'scene', name, body: this.parseBraced(), line: start.line, column: start.column };
    }
    parseType(allowNone) {
        const word = this.expectWord('Expected type');
        if (word === 'dict') {
            this.expect('[');
            const value = this.expectWord('Expected dictionary value type');
            if (value !== 'int' && value !== 'str')
                throw this.error('Dictionary value type must be int or str');
            this.expect(']');
            return { kind: 'dict', value };
        }
        if (TYPES.has(word) && (allowNone || word !== 'none'))
            return word;
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(word))
            return { kind: 'struct', name: word };
        throw this.error(`Invalid type '${word}'`);
    }
    peekToken() { if (!this.buffered.length)
        this.buffered.push(this.lexer.next()); return this.buffered[0]; }
    peekContent() {
        let index = 0;
        while (true) {
            if (index === this.buffered.length)
                this.buffered.push(this.lexer.next());
            if (this.buffered[index].type !== 'newline')
                return this.buffered[index];
            index++;
        }
    }
    parseStatement() {
        const token = this.current;
        if (token.type !== 'word')
            throw this.error('Expected command');
        const command = token.value;
        switch (command) {
            case 'const':
            case 'int':
            case 'str':
            case 'dict': {
                this.take();
                let type;
                if (command === 'const') {
                    type = this.parseType(false);
                }
                else if (command === 'dict') {
                    this.expect('[');
                    const value = this.expectWord('Expected dictionary value type');
                    if (value !== 'int' && value !== 'str')
                        throw this.error('Dictionary value type must be int or str');
                    this.expect(']');
                    type = { kind: 'dict', value };
                }
                else {
                    type = command;
                }
                const name = this.expectIdentifier('Expected variable name');
                this.expect('=');
                return { kind: 'declare', name, type, constant: command === 'const', initial: this.parseExpression(), line: token.line, column: token.column };
            }
            case 'let': throw this.error('let は廃止されました。型名（int / str / dict）を使用してください');
            case 'set': {
                this.take();
                const target = this.parseAssignable();
                this.expect('=');
                return { kind: 'set', target, value: this.parseExpression(), line: token.line, column: token.column };
            }
            case 'unset': {
                this.take();
                return { kind: 'unset', target: this.parseAssignable(), line: token.line, column: token.column };
            }
            case 'if': {
                this.take();
                const first = { condition: this.parseCondition(), body: this.parseBraced() };
                let endLine = this.lastBlockEndLine;
                const elseIf = [];
                let otherwise = [];
                this.skipLines();
                while (this.atWord('elif') || this.atWord('else')) {
                    if (this.atWord('elif')) {
                        this.take();
                        elseIf.push({ condition: this.parseCondition(), body: this.parseBraced() });
                        endLine = this.lastBlockEndLine;
                        this.skipLines();
                    }
                    else {
                        this.take();
                        otherwise = this.parseBraced();
                        endLine = this.lastBlockEndLine;
                        break;
                    }
                }
                return { kind: 'if', condition: first.condition, body: first.body, elseIf, otherwise, line: token.line, column: token.column, endLine };
            }
            case 'for': {
                this.take();
                const name = this.expectIdentifier('Expected loop variable');
                this.expectWordValue('from');
                const start = this.parseExpression();
                this.expectWordValue('to');
                const stop = this.parseExpression();
                const step = this.atWord('step') ? (this.take(), this.parseExpression()) : literal(1);
                const body = this.parseBraced();
                return { kind: 'for', name, start, stop, step, body, line: token.line, column: token.column, endLine: this.lastBlockEndLine };
            }
            case 'while': {
                this.take();
                const condition = this.parseCondition();
                const body = this.parseBraced();
                return { kind: 'while', condition, body, line: token.line, column: token.column, endLine: this.lastBlockEndLine };
            }
            case 'choice': {
                this.take();
                this.skipLines();
                let prompt;
                if (!this.atValue('{')) {
                    prompt = this.parseExpression();
                }
                this.skipLines();
                this.expect('{');
                const options = [];
                this.skipLines();
                while (!this.atValue('}')) {
                    const label = this.parseExpression();
                    options.push({ label, body: this.parseBraced() });
                    this.skipLines();
                }
                const closing = this.take();
                return { kind: 'choice', prompt, options, line: token.line, column: token.column, endLine: closing.line };
            }
            case 'return': {
                this.take();
                return { kind: 'return', value: this.atLineEnd() ? undefined : this.parseExpression(), line: token.line, column: token.column };
            }
            case 'goto': {
                this.take();
                let scene = '';
                if (this.current.type === 'string') {
                    scene = this.take().value;
                }
                else {
                    while (!this.atLineEnd())
                        scene += this.take().value;
                }
                if (!/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(scene) || scene.split('/').includes('..'))
                    throw this.error('Invalid scene path');
                return { kind: 'goto', scene, line: token.line, column: token.column };
            }
            case 'say': {
                this.take();
                this.skipLines();
                let speaker = 'narrator';
                let textExpr;
                if (this.atValue('{'))
                    return this.parseSayBlock(token, { kind: 'literal', value: speaker, line: token.line, column: token.column });
                if (this.current.type === 'string' || this.atValue('(') || (this.current.type === 'word' && (['+', '-', '[', '.'].includes(this.peekToken().value) || (this.peekToken().value === '(' && this.peekToken().offset === this.current.offset + this.current.value.length)) && !['narrator', 'none'].includes(this.current.value))) {
                    textExpr = this.parseExpression();
                }
                else if (this.current.type === 'word') {
                    const spkToken = this.current;
                    const block = this.peekContent().value === '{';
                    this.take();
                    if (block) {
                        this.skipLines();
                        return this.parseSayBlock(token, { kind: 'literal', value: spkToken.value, line: spkToken.line, column: spkToken.column });
                    }
                    else if (this.atLineEnd()) {
                        textExpr = { kind: 'variable', name: spkToken.value, line: spkToken.line, column: spkToken.column };
                    }
                    else if (this.atValue('{')) {
                        return this.parseSayBlock(token, { kind: 'literal', value: spkToken.value, line: spkToken.line, column: spkToken.column });
                    }
                    else {
                        speaker = spkToken.value;
                        textExpr = this.parseExpression();
                    }
                }
                else {
                    throw this.error('say 命令の引数が不正です');
                }
                return {
                    kind: 'command',
                    name: 'say',
                    args: [
                        { kind: 'literal', value: speaker, line: token.line, column: token.column },
                        textExpr,
                    ],
                    line: token.line,
                    column: token.column,
                };
            }
            default: {
                this.take();
                if (token.type === 'word' && this.current.type === 'word' && this.peekToken().value === '=') {
                    const name = this.take();
                    this.expect('=');
                    return { kind: 'declare', name: name.value, type: { kind: 'struct', name: command }, initial: this.parseExpression(), line: token.line, column: token.column };
                }
                if (this.atValue('(')) {
                    const args = this.parseCallArgs();
                    return { kind: 'call', name: command, args, line: token.line, column: token.column };
                }
                return { kind: 'command', name: command, args: this.parseCommandArgs(command), line: token.line, column: token.column };
            }
        }
    }
    parseSayBlock(token, speaker) {
        this.expect('{');
        const lines = [];
        this.skipLines();
        while (!this.atValue('}')) {
            if (this.at('eof'))
                throw this.error("Expected '}'");
            lines.push(this.parseExpression());
            this.endLine();
            this.skipLines();
        }
        const closing = this.take();
        if (!lines.length)
            throw this.error('say ブロックには本文を1つ以上指定してください');
        return { kind: 'sayBlock', speaker, lines, line: token.line, column: token.column, endLine: closing.line };
    }
    parseAssignable() {
        const token = this.current;
        const name = this.expectIdentifier('Expected assignment target');
        let target = { kind: 'variable', name, line: token.line, column: token.column };
        if (this.optional('[')) {
            const key = this.parseExpression();
            this.expect(']');
            target = { kind: 'index', target, key, line: token.line, column: token.column };
        }
        while (this.optional('.')) {
            const field = this.expectIdentifier('Expected struct field');
            target = { kind: 'index', target, key: { kind: 'literal', value: field }, line: token.line, column: token.column };
        }
        return target;
    }
    parseCommandArgs(command) {
        const args = [];
        while (!this.atLineEnd() && !this.atValue('}')) {
            const token = this.current;
            if (command === 'show' && args.length === 0 && token.type === 'word' && this.peekToken().value === '.') {
                this.take();
                this.expect('.');
                const pose = this.expectIdentifier('Expected character pose');
                args.push({ kind: 'literal', value: `${token.value}.${pose}`, line: token.line, column: token.column });
            }
            else if (token.type === 'word' && ['bg', 'bgm', 'char', 'show', 'hide', 'clear', 'play', 'effect'].includes(command)) {
                this.take();
                args.push({ kind: 'literal', value: token.value, line: token.line, column: token.column });
            }
            else {
                args.push(this.parseExpression());
            }
        }
        return args;
    }
    parseCondition() {
        const expr = this.parseExpression();
        return { kind: 'condition', expression: expr, line: expr.line, column: expr.column };
    }
    parseExpression(min = 0) {
        let left = this.parsePrefix();
        while (true) {
            const op = this.current.value;
            const precedence = PRECEDENCE[op];
            if (precedence === undefined || precedence < min)
                break;
            this.take();
            const right = this.parseExpression(precedence + 1);
            left = { kind: 'binary', operator: op, left, right, line: left.line, column: left.column };
        }
        return left;
    }
    parsePrefix() {
        if (this.atWord('not')) {
            const token = this.take();
            const value = this.parseExpression(30);
            return { kind: 'unary', operator: 'not', value, line: token.line, column: token.column };
        }
        if (this.atValue('-') || this.atValue('+')) {
            const token = this.take();
            const value = this.parseExpression(70);
            return { kind: 'unary', operator: token.value, value, line: token.line, column: token.column };
        }
        let expr;
        const token = this.current;
        if (token.type === 'number') {
            this.take();
            let val;
            try {
                const bi = BigInt(token.value);
                val = (bi >= BigInt(Number.MIN_SAFE_INTEGER) && bi <= BigInt(Number.MAX_SAFE_INTEGER)) ? Number(token.value) : bi;
            }
            catch {
                val = Number(token.value);
            }
            expr = { kind: 'literal', value: val, line: token.line, column: token.column };
        }
        else if (token.type === 'string') {
            this.take();
            expr = { kind: 'literal', value: token.value, line: token.line, column: token.column };
        }
        else if (token.type === 'word') {
            this.take();
            if (this.atValue('(')) {
                expr = { kind: 'call', name: token.value, args: this.parseCallArgs(), line: token.line, column: token.column };
            }
            else {
                expr = { kind: 'variable', name: token.value, line: token.line, column: token.column };
            }
        }
        else if (this.optional('(')) {
            expr = this.parseExpression();
            this.expect(')');
        }
        else if (this.optional('{')) {
            this.skipLines();
            const entries = [];
            if (!this.atValue('}')) {
                const keyToken = this.expect('string', 'Dictionary keys must be strings');
                this.skipLines();
                this.expect(':');
                this.skipLines();
                entries.push({ key: keyToken.value, value: this.parseExpression() });
                this.skipLines();
                while (this.optional(',')) {
                    this.skipLines();
                    if (this.atValue('}'))
                        break;
                    const next = this.expect('string', 'Dictionary keys must be strings');
                    this.skipLines();
                    this.expect(':');
                    this.skipLines();
                    entries.push({ key: next.value, value: this.parseExpression() });
                    this.skipLines();
                }
            }
            this.skipLines();
            this.expect('}');
            expr = { kind: 'dict', entries, line: token.line, column: token.column };
        }
        else {
            throw this.error('Expected expression');
        }
        while (this.optional('[')) {
            const key = this.parseExpression();
            this.expect(']');
            expr = { kind: 'index', target: expr, key, line: expr.line, column: expr.column };
        }
        while (this.optional('.')) {
            const field = this.expectIdentifier('Expected struct field');
            expr = { kind: 'index', target: expr, key: { kind: 'literal', value: field }, line: expr.line, column: expr.column };
        }
        return expr;
    }
    parseCallArgs() {
        this.expect('(');
        const args = [];
        if (!this.atValue(')')) {
            do {
                args.push(this.parseExpression());
            } while (this.optional(','));
        }
        this.expect(')');
        return args;
    }
    expectIdentifier(message) {
        const token = this.expect('word', message);
        if (KEYWORDS.has(token.value)) {
            throw new ParseError(`予約語 '${token.value}' は識別子として使用できません`, token);
        }
        return token.value;
    }
    expectWordValue(value) {
        const token = this.expect('word', `Expected '${value}'`);
        if (token.value !== value)
            throw new ParseError(`Expected '${value}'`, token);
    }
    isBlockStatement(stmt) {
        return stmt.kind === 'if' || stmt.kind === 'for' || stmt.kind === 'while' || stmt.kind === 'choice';
    }
    endStatement(stmt) {
        if (this.isBlockStatement(stmt)) {
            this.skipLines();
            return;
        }
        this.endLine();
    }
    endLine() {
        if (this.at('newline'))
            this.take();
        else if (!this.at('eof') && !this.atValue('}'))
            throw this.error('Expected end of line');
    }
    skipLines() {
        while (this.at('newline'))
            this.take();
    }
    atLineEnd() {
        return this.at('newline') || this.at('eof') || this.atValue('}');
    }
    at(type) {
        return this.current.type === type;
    }
    atWord(value) {
        return this.current.type === 'word' && this.current.value === value;
    }
    atValue(value) {
        return this.current.value === value;
    }
    optional(value) {
        if (!this.atValue(value))
            return false;
        this.take();
        return true;
    }
    take() {
        const token = this.current;
        this.current = this.buffered.length ? this.buffered.shift() : this.lexer.next();
        return token;
    }
    expect(typeOrValue, message = `Expected ${typeOrValue}`) {
        if (this.current.type !== typeOrValue && this.current.value !== typeOrValue)
            throw this.error(message);
        return this.take();
    }
    expectWord(message) {
        return this.expect('word', message).value;
    }
    error(message) {
        return new ParseError(message, this.current);
    }
    parseBraced() {
        // ブロック開始の `{` は同じ行でも次の行でも受け付ける。
        // 空白の置き方だけで if / while / for などが構文エラーになるのを避ける。
        this.skipLines();
        this.expect('{');
        const body = [];
        this.skipLines();
        while (!this.atValue('}')) {
            if (this.at('eof'))
                throw this.error("Expected '}'");
            const stmt = this.parseStatement();
            body.push(stmt);
            this.endStatement(stmt);
            this.skipLines();
        }
        const closing = this.take();
        this.lastBlockEndLine = closing.line;
        return body;
    }
}
exports.Parser = Parser;
const literal = (value) => ({ kind: 'literal', value });
function parse(source) {
    return new Parser(source).parse();
}
