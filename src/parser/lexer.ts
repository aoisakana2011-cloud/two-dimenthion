import { Token, TokenType } from './ast';

export class Lexer {
  private offset = 0;
  private line = 1;
  private column = 1;
  constructor(private readonly source: string) {}

  next(): Token {
    this.skipTrivia();
    const start = { offset: this.offset, line: this.line, column: this.column };
    const c = this.peek();
    if (c === undefined) return this.token('eof', '', start);
    if (this.isLineBreak(c)) return this.readLineBreak(start);
    if (c === '"') return this.readString(start);
    if (this.isDigit(c)) return this.readNumber(start);
    const pair = `${c}${this.peek(1) ?? ''}`;
    if (['==', '!=', '>=', '<=', '->', '=>', '..'].includes(pair)) { this.advance(); this.advance(); return this.token('symbol', pair, start); }
    if ('{}[]=():,+-*/%<>!.\\'.includes(c)) { this.advance(); return this.token('symbol', c, start); }
    const hyphenatedPosition = this.source.slice(this.offset).match(/^(?:far-left|far-right)\b/);
    if (hyphenatedPosition) {
      for (let index = 0; index < hyphenatedPosition[0].length; index++) this.advance();
      return this.token('word', hyphenatedPosition[0], start);
    }
    if (this.isAlpha(c)) return this.readWord(start);
    throw this.error(`Unexpected character '${c}'`, start);
  }

  private skipTrivia(): void {
    while (true) {
      const c = this.peek();
      // UTF-8 BOM is metadata, not part of the first DSL token. Consume it
      // without advancing the user-visible column so diagnostics still point
      // at column 1. A BOM elsewhere remains ordinary invalid input.
      if (this.offset === 0 && c === '\uFEFF') this.offset++;
      else if (c === ' ' || c === '\t') this.advance();
      else if (c === '#' || (c === '/' && this.peek(1) === '/')) {
        if (c === '/') { this.advance(); this.advance(); }
        while (this.peek() !== undefined && !this.isLineBreak(this.peek())) this.advance();
      }
      else break;
    }
  }
  private readLineBreak(start: Pos): Token {
    const c = this.advance();
    if (c === '\r' && this.peek() === '\n') this.offset++;
    return this.token('newline', '\n', start);
  }
  private readString(start: Pos): Token {
    this.advance(); let value = ''; const unknownEscapes: string[] = [];
    while (true) {
      const c = this.peek();
      if (c === undefined || this.isLineBreak(c)) throw this.error('Unterminated string', start);
      if (c === '"') {
        this.advance();
        const token = this.token('string', value, start);
        if (unknownEscapes.length) token.unknownEscapes = unknownEscapes;
        return token;
      }
      if (c !== '\\') { value += this.advance(); continue; }
      this.advance(); const escaped = this.peek();
      if (escaped === undefined || this.isLineBreak(escaped)) throw this.error('Unterminated string', start);
      if (escaped === 'n') value += '\n';
      else if (escaped === '\\' || escaped === '"') value += escaped;
      else { value += `\\${escaped}`; unknownEscapes.push(escaped); }
      this.advance();
    }
  }
  private readNumber(start: Pos): Token {
    let value = '';
    while (this.isDigit(this.peek())) value += this.advance();
    return this.token('number', value, start);
  }
  private readWord(start: Pos): Token {
    let value = '';
    while (this.isAlphaNumeric(this.peek())) value += this.advance();
    return this.token('word', value, start);
  }
  private isAlpha(c: string | undefined): boolean { return !!c && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_'); }
  private isAlphaNumeric(c: string | undefined): boolean { return this.isAlpha(c) || this.isDigit(c); }
  private isDigit(c: string | undefined): boolean { return !!c && c >= '0' && c <= '9'; }
  private isLineBreak(c: string | undefined): boolean { return c === '\n' || c === '\r' || c === '\u2028' || c === '\u2029'; }
  private peek(ahead = 0): string | undefined { return this.source[this.offset + ahead]; }
  private advance(): string { const c = this.source[this.offset++]!; if (this.isLineBreak(c)) { this.line++; this.column = 1; } else this.column++; return c; }
  private token(type: TokenType, value: string, position: Pos): Token { return { type, value, ...position }; }
  private error(message: string, p: Pos): SyntaxError { return new SyntaxError(`${message} at line ${p.line}, column ${p.column}`); }
}
type Pos = Pick<Token, 'line' | 'column' | 'offset'>;
export function tokenize(source: string): Token[] { const lexer = new Lexer(source); const result: Token[] = []; while (true) { const token = lexer.next(); result.push(token); if (token.type === 'eof') return result; } }
export type { Token, TokenType } from './ast';
