import { Lexer, Token } from './lexer';
import { Asset, AssetKind, Character, Condition, Expr, FunctionDef, PrimitiveType, Scene, Script, Statement, StructDef, ValueType } from './ast';

const ASSET_TYPES = new Set<AssetKind>(['bg', 'char', 'bgm', 'se', 'voice', 'video', 'image']);
const TYPES = new Set(['int', 'str', 'none']);
const PRECEDENCE: Record<string, number> = {
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
  'include', 'struct',
]);

export class ParseError extends Error {
  constructor(message: string, readonly token: Token) {
    super(`${message} at line ${token.line}, column ${token.column}`);
    this.name = 'ParseError';
  }
}

export class Parser {
  private current: Token;
  private readonly lexer: Lexer;
  private readonly buffered: Token[] = [];

  constructor(private readonly source: string) {
    this.lexer = new Lexer(source);
    this.current = this.lexer.next();
  }

  parse(): Script {
    const assets: Asset[] = [];
    const characters: Character[] = [];
    const globals: Statement[] = [];
    const functions: FunctionDef[] = [];
    const scenes: Scene[] = [];
    const structs: StructDef[] = [];
    const includes: string[] = [];
    this.skipLines();

    while (!this.at('eof')) {
      if (this.atWord('asset')) {
        assets.push(this.parseAsset());
        this.endLine();
      } else if (this.atWord('character')) {
        characters.push(this.parseCharacter());
        this.skipLines();
      } else if (this.atWord('fn')) {
        functions.push(this.parseFunction());
        this.skipLines();
      } else if (this.atWord('struct')) {
        structs.push(this.parseStruct());
        this.skipLines();
      } else if (this.atWord('scene')) {
        scenes.push(this.parseScene());
        this.skipLines();
      } else if (this.atWord('include')) {
        includes.push(this.parseInclude());
        this.endLine();
      } else {
        const stmt = this.parseStatement();
        globals.push(stmt);
        this.endStatement(stmt);
      }
      this.skipLines();
    }
    return { kind: 'script', assets, characters, structs, globals, functions, scenes, includes, body: globals };
  }

  private parseInclude(): string {
    this.take();
    if (this.current.type === 'string') return this.take().value;
    const parts: string[] = [];
    while (!this.at('newline') && !this.at('eof')) parts.push(this.take().value);
    const value = parts.join('');
    if (!value) throw this.error('Expected include path');
    return value;
  }

  private parseAsset(): Asset {
    const start = this.take();
    const type = this.expectWord('Expected asset type') as AssetKind;
    if (!ASSET_TYPES.has(type)) throw this.error(`Unknown asset type '${type}'`);
    const name = this.expectIdentifier('Expected asset name');
    this.expect('=');
    const path = this.expect('string', 'Asset path must be a string').value;
    return { kind: 'asset', type, name, path, line: start.line, column: start.column };
  }

  private parseCharacter(): Character {
    const start = this.take();
    const name = this.expectIdentifier('Expected character name');
    this.expect('{');
    const poses: Array<{ name: string; path: string }> = [];
    this.skipLines();
    while (!this.atValue('}')) {
      const poseToken = this.current;
      const pose = this.expectIdentifier('Expected pose name');
      this.expect('=');
      const path = this.expect('string', 'Character pose path must be a string').value;
      poses.push({ name: pose, path });
      this.endLine();
      this.skipLines();
    }
    this.take();
    return { kind: 'character', name, poses, line: start.line, column: start.column };
  }

  private parseStruct(): StructDef {
    const start = this.take(); const name = this.expectIdentifier('Expected struct name');
    this.expect('{'); this.skipLines(); const fields: Record<string, PrimitiveType> = {};
    while (!this.atValue('}')) {
      const field = this.expectIdentifier('Expected field name'); this.expect(':');
      const type = this.expectWord('Expected field type') as PrimitiveType;
      if (type !== 'int' && type !== 'str') throw this.error('Struct fields must be int or str');
      if (fields[field]) throw this.error(`Duplicate struct field '${field}'`);
      fields[field] = type; this.endLine(); this.skipLines();
    }
    this.take(); return { kind: 'struct', name, fields, line: start.line, column: start.column };
  }


  private parseFunction(): FunctionDef {
    const start = this.take();
    const name = this.expectIdentifier('Expected function name');
    this.expect('(');
    const params: Array<{ type: ValueType; name: string }> = [];
    if (!this.atValue(')')) {
      while (true) {
        const paramName = this.expectIdentifier('Expected parameter name');
        this.expect(':');
        const type = this.parseType(false);
        params.push({ name: paramName, type });
        if (!this.optional(',')) break;
      }
    }
    this.expect(')');
    this.expect('->');
    const returnType = this.parseType(true);
    return { kind: 'function', name, returnType, params, body: this.parseBraced(), line: start.line, column: start.column };
  }

  private parseScene(): Scene {
    const start = this.take();
    const name = this.expectIdentifier('Expected scene name');
    return { kind: 'scene', name, body: this.parseBraced(), line: start.line, column: start.column };
  }

  private parseType(allowNone: boolean): ValueType {
    const word = this.expectWord('Expected type');
    if (word === 'dict') {
      this.expect('[');
      const value = this.expectWord('Expected dictionary value type') as PrimitiveType;
      if (value !== 'int' && value !== 'str') throw this.error('Dictionary value type must be int or str');
      this.expect(']');
      return { kind: 'dict', value };
    }
    if (TYPES.has(word) && (allowNone || word !== 'none')) return word as ValueType;
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(word)) return { kind: 'struct', name: word };
    throw this.error(`Invalid type '${word}'`);
  }

  private peekToken(): Token { if (!this.buffered.length) this.buffered.push(this.lexer.next()); return this.buffered[0]; }

  private parseStatement(): Statement {
    const token = this.current;
    if (token.type !== 'word') throw this.error('Expected command');
    const command = token.value;

    switch (command) {
      case 'const': case 'int': case 'str': case 'dict': {
        this.take();
        let type: ValueType | 'infer';
        if (command === 'const') {
          type = this.parseType(false);
        } else if (command === 'dict') {
          this.expect('[');
          const value = this.expectWord('Expected dictionary value type') as PrimitiveType;
          if (value !== 'int' && value !== 'str') throw this.error('Dictionary value type must be int or str');
          this.expect(']');
          type = { kind: 'dict', value };
        } else {
          type = command as PrimitiveType;
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
        const elseIf: Array<{ condition: Condition; body: Statement[] }> = [];
        let otherwise: Statement[] = [];
        this.skipLines();
        while (this.atWord('elif') || this.atWord('else')) {
          if (this.atWord('elif')) {
            this.take();
            elseIf.push({ condition: this.parseCondition(), body: this.parseBraced() });
            this.skipLines();
          } else {
            this.take();
            otherwise = this.parseBraced();
            break;
          }
        }
        return { kind: 'if', condition: first.condition, body: first.body, elseIf, otherwise, line: token.line, column: token.column };
      }
      case 'for': {
        this.take();
        const name = this.expectIdentifier('Expected loop variable');
        this.expectWordValue('from');
        const start = this.parseExpression();
        this.expectWordValue('to');
        const stop = this.parseExpression();
        const step = this.atWord('step') ? (this.take(), this.parseExpression()) : literal(1);
        return { kind: 'for', name, start, stop, step, body: this.parseBraced(), line: token.line, column: token.column };
      }
      case 'while': {
        this.take();
        return { kind: 'while', condition: this.parseCondition(), body: this.parseBraced(), line: token.line, column: token.column };
      }
      case 'choice': {
        this.take();
        let prompt: Expr | undefined;
        if (!this.atValue('{')) {
          prompt = this.parseExpression();
        }
        this.expect('{');
        const options: Array<{ label: Expr; body: Statement[] }> = [];
        this.skipLines();
        while (!this.atValue('}')) {
          const label = this.parseExpression();
          options.push({ label, body: this.parseBraced() });
          this.skipLines();
        }
        this.take();
        return { kind: 'choice', prompt, options, line: token.line, column: token.column };
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
        } else {
          scene = this.expectIdentifier('Expected scene name');
          while (this.atValue('/') || this.atValue('.')) {
            const sep = this.take().value;
            const nextPart = this.expectWord('Expected scene path segment');
            scene += `${sep}${nextPart}`;
          }
        }
        return { kind: 'goto', scene, line: token.line, column: token.column };
      }
      case 'say': {
        this.take();
        let speaker = 'narrator';
        let textExpr: Expr;
        if (this.atValue('{')) return this.parseSayBlock(token, { kind: 'literal', value: speaker, line: token.line, column: token.column });
        if (this.current.type === 'string' || this.atValue('(')) {
          textExpr = this.parseExpression();
        } else if (this.current.type === 'word') {
          const spkToken = this.current;
          this.take();
          if (this.atLineEnd()) {
            textExpr = { kind: 'variable', name: spkToken.value, line: spkToken.line, column: spkToken.column };
          } else if (this.atValue('{')) {
            return this.parseSayBlock(token, { kind: 'literal', value: spkToken.value, line: spkToken.line, column: spkToken.column });
          } else {
            speaker = spkToken.value;
            textExpr = this.parseExpression();
          }
        } else {
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
          const name = this.take(); this.expect('=');
          return { kind: 'declare', name: name.value, type: { kind: 'struct', name: command } as any, initial: this.parseExpression(), line: token.line, column: token.column };
        }
        if (this.atValue('(')) {
          const args = this.parseCallArgs();
          return { kind: 'call', name: command, args, line: token.line, column: token.column };
        }
        return { kind: 'command', name: command, args: this.parseCommandArgs(command), line: token.line, column: token.column };
      }
    }
  }

  private parseSayBlock(token: Token, speaker: Expr): Statement {
    this.expect('{');
    const lines: Expr[] = [];
    this.skipLines();
    while (!this.atValue('}')) {
      if (this.at('eof')) throw this.error("Expected '}'");
      lines.push(this.parseExpression());
      this.endLine();
      this.skipLines();
    }
    this.take();
    if (!lines.length) throw this.error('say ブロックには本文を1つ以上指定してください');
    return { kind: 'sayBlock', speaker, lines, line: token.line, column: token.column };
  }

  private parseAssignable(): { kind: 'variable'; name: string; line?: number; column?: number } | { kind: 'index'; target: Expr; key: Expr; line?: number; column?: number } {
    const token = this.current;
    const name = this.expectIdentifier('Expected assignment target');
    let target: any = { kind: 'variable', name, line: token.line, column: token.column };
    if (this.optional('[')) {
      const key = this.parseExpression();
      this.expect(']');
      target = { kind: 'index', target, key, line: token.line, column: token.column };
    }
    while (this.optional('.')) {
      const field = this.expectIdentifier('Expected struct field');
      target = { kind: 'index', target, key: { kind: 'literal', value: field }, line: token.line, column: token.column } as any;
    }
    return target;
  }

  private parseCommandArgs(command: string): Expr[] {
    const args: Expr[] = [];
    while (!this.atLineEnd() && !this.atValue('}')) {
      const token = this.current;
      if (token.type === 'word' && ['bg', 'bgm', 'char', 'show', 'hide', 'clear', 'play', 'effect'].includes(command)) {
        this.take();
        args.push({ kind: 'literal', value: token.value, line: token.line, column: token.column });
      } else {
        args.push(this.parseExpression());
      }
    }
    return args;
  }

  private parseCondition(): Condition {
    const expr = this.parseExpression();
    return { kind: 'condition', expression: expr, line: expr.line, column: expr.column };
  }

  private parseExpression(min = 0): Expr {
    let left = this.parsePrefix();
    while (true) {
      const op = this.current.value;
      const precedence = PRECEDENCE[op];
      if (precedence === undefined || precedence < min) break;
      this.take();
      const right = this.parseExpression(precedence + 1);
      left = { kind: 'binary', operator: op, left, right, line: left.line, column: left.column };
    }
    return left;
  }

  private parsePrefix(): Expr {
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

    let expr: Expr;
    const token = this.current;
    if (token.type === 'number') {
      this.take();
      let val: number | bigint;
      try {
        const bi = BigInt(token.value);
        val = (bi >= BigInt(Number.MIN_SAFE_INTEGER) && bi <= BigInt(Number.MAX_SAFE_INTEGER)) ? Number(token.value) : bi;
      } catch {
        val = Number(token.value);
      }
      expr = { kind: 'literal', value: val, line: token.line, column: token.column };
    } else if (token.type === 'string') {
      this.take();
      expr = { kind: 'literal', value: token.value, line: token.line, column: token.column };
    } else if (token.type === 'word') {
      this.take();
      if (this.atValue('(')) {
        expr = { kind: 'call', name: token.value, args: this.parseCallArgs(), line: token.line, column: token.column };
      } else {
        expr = { kind: 'variable', name: token.value, line: token.line, column: token.column };
      }
    } else if (this.optional('(')) {
      expr = this.parseExpression();
      this.expect(')');
    } else if (this.optional('{')) {
      this.skipLines();
      const entries: Array<{ key: string; value: Expr }> = [];
      if (!this.atValue('}')) {
        const keyToken = this.expect('string', 'Dictionary keys must be strings');
        this.skipLines();
        this.expect(':');
        this.skipLines();
        entries.push({ key: keyToken.value, value: this.parseExpression() });
        this.skipLines();
        while (this.optional(',')) {
          this.skipLines();
          if (this.atValue('}')) break;
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
    } else {
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

  private parseCallArgs(): Expr[] {
    this.expect('(');
    const args: Expr[] = [];
    if (!this.atValue(')')) {
      do {
        args.push(this.parseExpression());
      } while (this.optional(','));
    }
    this.expect(')');
    return args;
  }

  private expectIdentifier(message: string): string {
    const token = this.expect('word', message);
    if (KEYWORDS.has(token.value)) {
      throw new ParseError(`予約語 '${token.value}' は識別子として使用できません`, token);
    }
    return token.value;
  }

  private expectWordValue(value: string): void {
    const token = this.expect('word', `Expected '${value}'`);
    if (token.value !== value) throw new ParseError(`Expected '${value}'`, token);
  }

  private isBlockStatement(stmt: Statement): boolean {
    return stmt.kind === 'if' || stmt.kind === 'for' || stmt.kind === 'while' || stmt.kind === 'choice';
  }

  private endStatement(stmt: Statement): void {
    if (this.isBlockStatement(stmt)) {
      this.skipLines();
      return;
    }
    this.endLine();
  }

  private endLine(): void {
    if (this.at('newline')) this.take();
    else if (!this.at('eof') && !this.atValue('}')) throw this.error('Expected end of line');
  }

  private skipLines(): void {
    while (this.at('newline')) this.take();
  }

  private atLineEnd(): boolean {
    return this.at('newline') || this.at('eof') || this.atValue('}');
  }

  private at(type: string): boolean {
    return this.current.type === type;
  }

  private atWord(value: string): boolean {
    return this.current.type === 'word' && this.current.value === value;
  }

  private atValue(value: string): boolean {
    return this.current.value === value;
  }

  private optional(value: string): boolean {
    if (!this.atValue(value)) return false;
    this.take();
    return true;
  }

  private take(): Token {
    const token = this.current;
    this.current = this.buffered.length ? this.buffered.shift()! : this.lexer.next();
    return token;
  }

  private expect(typeOrValue: string, message = `Expected ${typeOrValue}`): Token {
    if (this.current.type !== typeOrValue && this.current.value !== typeOrValue) throw this.error(message);
    return this.take();
  }

  private expectWord(message: string): string {
    return this.expect('word', message).value;
  }

  private error(message: string): ParseError {
    return new ParseError(message, this.current);
  }

  private parseBraced(): Statement[] {
    // ブロック開始の `{` は同じ行でも次の行でも受け付ける。
    // 空白の置き方だけで if / while / for などが構文エラーになるのを避ける。
    this.skipLines();
    this.expect('{');
    const body: Statement[] = [];
    this.skipLines();
    while (!this.atValue('}')) {
      if (this.at('eof')) throw this.error("Expected '}'");
      const stmt = this.parseStatement();
      body.push(stmt);
      this.endStatement(stmt);
      this.skipLines();
    }
    this.take();
    return body;
  }
}

const literal = (value: number | string | bigint): Expr => ({ kind: 'literal', value });
export function parse(source: string): Script {
  return new Parser(source).parse();
}
