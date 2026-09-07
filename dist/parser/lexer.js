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
        if (c === '\n') {
            this.advance();
            return this.token('newline', '\n', start);
        }
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
        if ('{}[]=():,+-*/%<>!.'.includes(c)) {
            this.advance();
            return this.token('symbol', c, start);
        }
        if (this.isAlpha(c))
            return this.readWord(start);
        throw this.error(`Unexpected character '${c}'`, start);
    }
    skipTrivia() {
        while (true) {
            const c = this.peek();
            if (c === ' ' || c === '\t' || c === '\r')
                this.advance();
            else if (c === '#' || (c === '/' && this.peek(1) === '/')) {
                if (c === '/') {
                    this.advance();
                    this.advance();
                }
                while (this.peek() !== undefined && this.peek() !== '\n')
                    this.advance();
            }
            else
                break;
        }
    }
    readString(start) {
        this.advance();
        let value = '';
        while (true) {
            const c = this.peek();
            if (c === undefined || c === '\n')
                throw this.error('Unterminated string', start);
            if (c === '"') {
                this.advance();
                return this.token('string', value, start);
            }
            if (c !== '\\') {
                value += this.advance();
                continue;
            }
            this.advance();
            const escaped = this.peek();
            if (escaped === undefined || escaped === '\n')
                throw this.error('Unterminated string', start);
            if (escaped === 'n')
                value += '\n';
            else if (escaped === '\\' || escaped === '"')
                value += escaped;
            else
                value += `\\${escaped}`;
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
    peek(ahead = 0) { return this.source[this.offset + ahead]; }
    advance() { const c = this.source[this.offset++]; if (c === '\n') {
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
