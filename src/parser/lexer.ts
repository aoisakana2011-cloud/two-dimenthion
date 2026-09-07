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
    if (c === '\n') { this.advance(); return this.token('newline', '\n', start); }
    if (c === '"') return this.readString(start);
    if (this.isDigit(c)) return this.readNumber(start);
    const pair = `${c}${this.peek(1) ?? ''}`;
    if (['==', '!=', '>=', '<=', '->', '=>', '..'].includes(pair)) { this.advance(); this.advance(); return this.token('symbol', pair, start); }
    if ('{}[]=():,+-*/%<>!.'.includes(c)) { this.advance(); return this.token('symbol', c, start); }
    if (this.isAlpha(c)) return this.readWord(start);
    throw this.error(`Unexpected character '${c}'`, start);
  }

  private skipTrivia(): void {
    while (true) {
      const c = this.peek();
      if (c === ' ' || c === '\t' || c === '\r') this.advance();
      else if (c === '#' || (c === '/' && this.peek(1) === '/')) {
        if (c === '/') { this.advance(); this.advance(); }
        while (this.peek() !== undefined && this.peek() !== '\n') this.advance();
      }
      else break;
    }
  }
  private readString(start: Pos): Token {
    this.advance(); let value = '';
    while (true) {
      const c = this.peek();
      if (c === undefined || c === '\n') throw this.error('Unterminated string', start);
      if (c === '"') { this.advance(); return this.token('string', value, start); }
      if (c !== '\\') { value += this.advance(); continue; }
      this.advance(); const escaped = this.peek();
      if (escaped === undefined || escaped === '\n') throw this.error('Unterminated string', start);
      if (escaped === 'n') value += '\n';
      else if (escaped === '\\' || escaped === '"') value += escaped;
      else value += `\\${escaped}`;
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
  private peek(ahead = 0): string | undefined { return this.source[this.offset + ahead]; }
  private advance(): string { const c = this.source[this.offset++]!; if (c === '\n') { this.line++; this.column = 1; } else this.column++; return c; }
  private token(type: TokenType, value: string, position: Pos): Token { return { type, value, ...position }; }
  private error(message: string, p: Pos): SyntaxError { return new SyntaxError(`${message} at line ${p.line}, column ${p.column}`); }
}
type Pos = Pick<Token, 'line' | 'column' | 'offset'>;
export function tokenize(source: string): Token[] { const lexer = new Lexer(source); const result: Token[] = []; while (true) { const token = lexer.next(); result.push(token); if (token.type === 'eof') return result; } }
export type { Token, TokenType } from './ast';
