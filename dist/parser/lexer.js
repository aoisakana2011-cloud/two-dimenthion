"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Lexer = void 0;
exports.tokenize = tokenize;
class Lexer {
    source;
    offset = 0;
    line = 1;
    column = 1;
    constructor(source) {
        this.source = source;
    }
    next() {
        this.skipTrivia();
        const start = { offset: this.offset, line: this.line, column: this.column };
        const c = this.peek();
        if (c === undefined)
            return this.token('eof', '', start);
        if (this.isLineBreak(c))
            return this.readLineBreak(start);
        if (c === '"')
            return this.readString(start);
        if (this.isDigit(c))
            return this.readNumber(start);
        const pair = `${c}${this.peek(1) ?? ''}`;
        if (['==', '!=', '>=', '<=', '->', '=>', '..'].includes(pair)) {
            this.advance();
            this.advance();
            return this.token('symbol', pair, start);
        }
        if ('{}[]=():,+-*/%<>!.\\'.includes(c)) {
            this.advance();
            return this.token('symbol', c, start);
        }
        const hyphenatedPosition = this.source.slice(this.offset).match(/^(?:far-left|far-right)\b/);
        if (hyphenatedPosition) {
            for (let index = 0; index < hyphenatedPosition[0].length; index++)
                this.advance();
            return this.token('word', hyphenatedPosition[0], start);
        }
        if (this.isAlpha(c))
            return this.readWord(start);
        throw this.error(`Unexpected character '${c}'`, start);
    }
    skipTrivia() {
        while (true) {
            const c = this.peek();
            // UTF-8 BOM is metadata, not part of the first DSL token. Consume it
            // without advancing the user-visible column so diagnostics still point
            // at column 1. A BOM elsewhere remains ordinary invalid input.
            if (this.offset === 0 && c === '\uFEFF')
                this.offset++;
            else if (c === ' ' || c === '\t')
                this.advance();
            else if (c === '#' || (c === '/' && this.peek(1) === '/')) {
                if (c === '/') {
                    this.advance();
                    this.advance();
                }
                while (this.peek() !== undefined && !this.isLineBreak(this.peek()))
                    this.advance();
            }
            else
                break;
        }
    }
    readLineBreak(start) {
        const c = this.advance();
        if (c === '\r' && this.peek() === '\n')
            this.offset++;
        return this.token('newline', '\n', start);
    }
    readString(start) {
        this.advance();
        let value = '';
        const unknownEscapes = [];
        while (true) {
            const c = this.peek();
            if (c === undefined || this.isLineBreak(c))
                throw this.error('Unterminated string', start);
            if (c === '"') {
                this.advance();
                const token = this.token('string', value, start);
                if (unknownEscapes.length)
                    token.unknownEscapes = unknownEscapes;
                return token;
            }
            if (c !== '\\') {
                value += this.advance();
                continue;
            }
            this.advance();
            const escaped = this.peek();
            if (escaped === undefined || this.isLineBreak(escaped))
                throw this.error('Unterminated string', start);
            if (escaped === 'n')
                value += '\n';
            else if (escaped === '\\' || escaped === '"')
                value += escaped;
            else {
                value += `\\${escaped}`;
                unknownEscapes.push(escaped);
            }
            this.advance();
        }
    }
    readNumber(start) {
        let value = '';
        while (this.isDigit(this.peek()))
            value += this.advance();
        return this.token('number', value, start);
    }
    readWord(start) {
        let value = '';
        while (this.isAlphaNumeric(this.peek()))
            value += this.advance();
        return this.token('word', value, start);
    }
    isAlpha(c) { return !!c && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_'); }
    isAlphaNumeric(c) { return this.isAlpha(c) || this.isDigit(c); }
    isDigit(c) { return !!c && c >= '0' && c <= '9'; }
    isLineBreak(c) { return c === '\n' || c === '\r' || c === '\u2028' || c === '\u2029'; }
    peek(ahead = 0) { return this.source[this.offset + ahead]; }
    advance() { const c = this.source[this.offset++]; if (this.isLineBreak(c)) {
        this.line++;
        this.column = 1;
    }
    else
        this.column++; return c; }
    token(type, value, position) { return { type, value, ...position }; }
    error(message, p) { return new SyntaxError(`${message} at line ${p.line}, column ${p.column}`); }
}
exports.Lexer = Lexer;
function tokenize(source) { const lexer = new Lexer(source); const result = []; while (true) {
    const token = lexer.next();
    result.push(token);
    if (token.type === 'eof')
        return result;
} }
