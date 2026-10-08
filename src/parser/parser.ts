import { Lexer, Token } from './lexer';
import { Asset, AssetKind, Character, Condition, Expr, FunctionDef, Include, NodeLocation, PrimitiveType, Scene, Script, Statement, StructDef, ValueType } from './ast';

const ASSET_TYPES = new Set<AssetKind>(['bg', 'char', 'bgm', 'se', 'voice', 'video', 'image']);
const TYPES = new Set(['int', 'float', 'str', 'bool', 'none']);
const PRECEDENCE: Record<string, number> = {
  or: 10,
  and: 20,
  '==': 40, '!=': 40, '>': 40, '>=': 40, '<': 40, '<=': 40,
  '+': 50, '-': 50,
  '*': 60, '/': 60, '%': 60,
};
const MAX_EXPRESSION_NESTING = 256;

const KEYWORDS = new Set([
  'scene', 'asset', 'character', 'struct', 'pose', 'include', 'int', 'float', 'str', 'bool', 'list', 'dict', 'none', 'global', 'const', 'let', 'true', 'false',
  'set', 'unset', 'say', 'bg', 'bgm', 'char', 'show', 'at', 'hide', 'image', 'clear', 'play', 'se', 'effect', 'wait', 'camera',
  'if', 'elif', 'else', 'and', 'or', 'not', 'choice', 'for', 'from', 'to', 'step', 'while',
  'fn', 'return', 'goto', 'async', 'blocking', 'parallel', 'voice', 'video',
]);

export class ParseError extends Error {
  constructor(message: string, readonly token: Token, readonly startColumn = token.column, readonly endColumn = token.sourceEndColumn ?? token.column + Math.max(token.value.length, 1)) {
    super(`${message}（${token.line}行、${startColumn}列）`);
    this.name = 'ParseError';
  }
}

export class Parser {
  private current: Token;
  private readonly lexer: Lexer;
  private readonly buffered: Token[] = [];
  private lastBlockEndLine = 1;
  private lastBlockEndColumn = 1;
  private readonly declaredStructs = new Set<string>();
  private readonly allowCharacterMethodDeclaration: boolean;
  private expressionNesting = 0;

  constructor(source: string, knownStructs: Iterable<string> = [], options: { allowCharacterMethodDeclaration?: boolean } = {}) {
    this.allowCharacterMethodDeclaration = options.allowCharacterMethodDeclaration === true;
    for (const name of knownStructs) this.declaredStructs.add(name);
    this.discoverStructNames(source);
    this.lexer = new Lexer(source);
    this.current = this.lexer.next();
  }

  private discoverStructNames(source: string): void {
    const lexer = new Lexer(source);
    let depth = 0;
    let expectName = false;
    while (true) {
      const token = lexer.next();
      if (expectName) {
        if (depth === 0 && token.type === 'word') this.declaredStructs.add(token.value);
        expectName = false;
      } else if (depth === 0 && token.type === 'word' && token.value === 'struct') {
        expectName = true;
      }
      if (token.value === '{') depth++;
      else if (token.value === '}') depth = Math.max(0, depth - 1);
      if (token.type === 'eof') break;
    }
  }

  parse(): Script {
    const assets: Asset[] = [];
    const characters: Character[] = [];
    const globals: Statement[] = [];
    const functions: FunctionDef[] = [];
    const scenes: Scene[] = [];
    const structs: StructDef[] = [];
    const includes: Include[] = [];
    const includeAliases = new Set<string>();
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
        const include = this.parseInclude();
        if (includeAliases.has(include.alias)) throw new ParseError(`include alias '${include.alias}' はすでに使用されています`, this.current);
        includeAliases.add(include.alias);
        includes.push(include);
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

  private parseInclude(): Include {
    const start = this.take();
    let path: string;
    if (this.current.type === 'string') {
      const pathToken = this.take();
      this.rejectUnknownEscapes(pathToken);
      path = pathToken.value;
    } else {
      const parts: string[] = [];
      let previous: Token | undefined;
      while (!this.at('newline') && !this.at('eof')
        && !(this.atWord('as') && parts.length && previous && this.current.offset > previous.offset + previous.value.length)) {
        const token = this.current;
        if (previous && token.offset > previous.offset + previous.value.length) throw this.error('include path に空白は使用できません');
        previous = this.take();
        parts.push(previous.value);
      }
      path = parts.join('');
      if (!path) throw this.error('include path を指定してください');
    }
    this.expectWordValue('as');
    const alias = this.expectIdentifier('as の後に include の別名を指定してください');
    return { path, alias, line: start.line, column: start.column };
  }

  private parseAsset(): Asset {
    const start = this.take();
    const type = this.expectWord('asset の種類を指定してください') as AssetKind;
    if (!ASSET_TYPES.has(type)) throw this.error(`不明な asset type '${type}' です`);
    const name = this.expectIdentifier('asset 名を指定してください');
    this.expect('=');
    const pathToken = this.expect('string', 'asset path は文字列で指定してください');
    this.rejectUnknownEscapes(pathToken);
    const path = pathToken.value;
    let volume: number | undefined;
    if (!this.atLineEnd()) {
      if (!['bgm', 'se', 'voice'].includes(type)) throw this.error(`asset ${type} は volume を指定できません`);
      this.expectWordValue('volume');
      if (this.current.type !== 'number' || !/[.eE]/.test(this.current.value)) throw this.error('asset の volume は float literal で指定してください（例: 0.5）');
      const value = Number(this.take().value);
      if (!Number.isFinite(value) || value < 0 || value > 1) throw this.error('asset の volume は 0.0 から 1.0 の範囲で指定してください');
      volume = value;
      if (!this.atLineEnd()) throw this.error('asset 宣言の volume option が重複しているか不正です');
    }
    return { kind: 'asset', type, name, path, ...(volume === undefined ? {} : { volume }), line: pathToken.line, column: pathToken.column + 1 };
  }

  private parseCharacter(): Character {
    const start = this.take();
    const name = this.expectIdentifier('character 名を指定してください');
    this.skipLines();
    this.expect('{');
    const properties: Character['properties'] = [];
    const poses: Character['poses'] = [];
    this.skipLines();
    while (!this.atValue('}')) {
      const propertyToken = this.current;
      if (this.atWord('pose')) {
        this.take();
        const pose = this.expectIdentifier('pose name を指定してください');
        this.expect('=');
        const pathToken = this.expect('string', 'character pose の image path は string literal で指定してください');
        this.rejectUnknownEscapes(pathToken);
        const path = pathToken.value;
        let yOffset: number | undefined;
        if (this.atWord('y_offset')) {
          this.take();
          this.expect('=');
          let sign = 1;
          if (this.atValue('-') || this.atValue('+')) {
            if (this.current.value === '-') sign = -1;
            this.take();
          }
          const offsetToken = this.expect('number', 'pose y_offset は整数で指定してください');
          if (!/^\d+$/.test(offsetToken.value)) throw this.error('pose y_offset は整数で指定してください');
          const magnitude = BigInt(offsetToken.value);
          if (magnitude > 1_000_000n) throw this.error('pose y_offset は -1000000 px から 1000000 px の範囲で指定してください');
          yOffset = Number(magnitude) * sign;
        }
        poses.push({ name: pose, path, ...(yOffset === undefined ? {} : { yOffset }), line: pathToken.line, column: pathToken.column + 1 });
      } else {
        const property = this.expectIdentifier('character の property または pose declaration を指定してください');
        this.expect('=');
        properties.push({ name: property, value: this.parseExpression(), line: propertyToken.line, column: propertyToken.column });
      }
      this.endLine();
      this.skipLines();
    }
    const closing = this.take();
    return { kind: 'character', name, properties, poses, line: start.line, column: start.column, endLine: closing.line, endColumn: closing.column };
  }

  private parseStruct(): StructDef {
    const start = this.take(); const name = this.expectIdentifier('struct 名を指定してください');
    this.skipLines();
    this.expect('{'); this.skipLines(); const fields: Record<string, PrimitiveType> = {}; const fieldLocations: Record<string, NodeLocation> = {};
    while (!this.atValue('}')) {
      const fieldToken = this.current;
      const field = this.expectIdentifier('field nameを指定してください'); this.expect(':');
      const type = this.expectWord('field typeを指定してください') as PrimitiveType;
      if (type !== 'int' && type !== 'float' && type !== 'str' && type !== 'bool') throw this.error('struct field の type は int、float、str、bool のいずれかにしてください');
      if (Object.hasOwn(fields, field)) throw this.error(`struct field '${field}' が重複しています`);
      // Struct fields are user-controlled identifiers. Define them as own
      // data properties so names such as `__proto__` do not invoke Object's
      // legacy prototype setter.
      Object.defineProperty(fields, field, { value: type, enumerable: true, configurable: true, writable: true });
      Object.defineProperty(fieldLocations, field, {
        value: { line: fieldToken.line, column: fieldToken.column },
        enumerable: true,
        configurable: true,
        writable: true,
      });
      this.endLine(); this.skipLines();
    }
    this.take(); this.declaredStructs.add(name); return { kind: 'struct', name, fields, fieldLocations, line: start.line, column: start.column };
  }


  private parseFunction(): FunctionDef {
    const start = this.take();
    const nameToken = this.expect('word', '関数名を指定してください');
    // `character` is reserved as a declaration keyword, but is also the
    // intentional method name in qualified APIs such as walk.character().
    if (KEYWORDS.has(nameToken.value) && !(nameToken.value === 'character' && this.allowCharacterMethodDeclaration)) {
      throw new ParseError(`予約語 '${nameToken.value}' は関数名として使用できません`, nameToken);
    }
    const name = nameToken.value;
    this.expect('(');
    const params: Array<{ type: ValueType; name: string; line?: number; column?: number }> = [];
    if (!this.atValue(')')) {
      while (true) {
        const paramToken = this.current;
        const paramName = this.expectIdentifier('引数名を指定してください');
        this.expect(':');
        const type = this.parseType(false);
        params.push({ name: paramName, type, line: paramToken.line, column: paramToken.column });
        if (!this.optional(',')) break;
      }
    }
    this.expect(')');
    this.expect('->');
    const returnType = this.parseType(true);
    const body = this.parseBraced();
    return { kind: 'function', name, returnType, params, body, line: start.line, column: start.column, endLine: this.lastBlockEndLine, endColumn: this.lastBlockEndColumn };
  }

  private parseScene(): Scene {
    const start = this.take();
    const name = this.expectIdentifier('scene name を指定してください');
    const body = this.parseBraced();
    return { kind: 'scene', name, body, line: start.line, column: start.column, endLine: this.lastBlockEndLine, endColumn: this.lastBlockEndColumn };
  }

  private parseType(allowNone: boolean): ValueType {
    const word = this.expectWord('型を指定してください');
    if (word === 'dict' || word === 'list') {
      this.expect('[');
      const value = this.expectWord(`${word} の要素型を指定してください`) as PrimitiveType;
      if (!['int', 'float', 'str', 'bool'].includes(value)) throw this.error(`${word} の要素型は int、float、str、bool のいずれかにしてください`);
      this.expect(']');
      return { kind: word, value };
    }
    if (TYPES.has(word) && (allowNone || word !== 'none')) return word as ValueType;
    if (this.declaredStructs.has(word)) return { kind: 'struct', name: word };
    throw this.error(`不明な型 '${word}' です`);
  }

  private peekToken(offset = 0): Token {
    while (this.buffered.length <= offset) this.buffered.push(this.lexer.next());
    return this.buffered[offset];
  }
  private isQualifiedCallAhead(): boolean {
    if (this.current.type !== 'word') return false;
    let offset = 0, hasQualifier = false;
    while (this.peekToken(offset).value === '.') {
      if (this.peekToken(offset + 1).type !== 'word') return false;
      hasQualifier = true;
      offset += 2;
    }
    return hasQualifier && this.peekToken(offset).value === '(';
  }
  private parseQualifiedCallName(): string {
    const first = this.expect('word', '関数名を指定してください');
    if (KEYWORDS.has(first.value) && first.value !== 'list') throw new ParseError(`予約語 '${first.value}' は関数名として使用できません`, first);
    const parts = [first.value];
    while (this.optional('.')) {
      const part = this.expect('word', '修飾関数名を指定してください');
      // `list` is a type keyword but also a natural method name in namespaces
      // such as runtime.state.characters.list(). Keep the exception scoped to
      // qualified call segments; declarations and bare identifiers stay reserved.
      if (KEYWORDS.has(part.value) && part.value !== 'list' && part.value !== 'character') {
        throw new ParseError(`予約語 '${part.value}' は関数名として使用できません`, part);
      }
      parts.push(part.value);
    }
    return parts.join('.');
  }
  private parseStatement(): Statement {
    const token = this.current;
    if (token.type !== 'word') throw this.error('命令を指定してください');
    const command = token.value;
    const topLevelOnly: Record<string, string> = {
      asset: 'asset 宣言はファイルの top-level でのみ使用できます',
      character: 'character 宣言はファイルの top-level でのみ使用できます',
      fn: '関数宣言はファイルの top-level でのみ使用できます',
      include: 'include 宣言はファイルの top-level でのみ使用できます',
      scene: 'scene 宣言はファイルの top-level でのみ使用できます',
      struct: 'struct 宣言はファイルの top-level でのみ使用できます',
    };
    if (topLevelOnly[command]) throw this.error(topLevelOnly[command]);
    if (this.isQualifiedCallAhead()) {
      const name = this.parseQualifiedCallName();
      return { kind: 'call', name, args: this.parseCallArgs(), line: token.line, column: token.column };
    }

    switch (command) {
      case 'global': {
        this.take();
        const declaration = this.parseStatement();
        if (declaration.kind !== 'declare') throw this.error('global の後には変数宣言が必要です');
        return { ...declaration, global: true, line: token.line, column: token.column };
      }
      case 'const': case 'int': case 'float': case 'str': case 'bool': case 'dict': case 'list': {
        let type: ValueType | 'infer';
        if (command === 'const') {
          this.take();
          type = this.parseType(false);
        } else if (command === 'dict' || command === 'list') {
          type = this.parseType(false);
        } else {
          this.take();
          type = command as PrimitiveType;
        }
        const nameToken = this.current;
        const name = this.expectIdentifier('変数名を指定してください');
        this.expect('=');
        return { kind: 'declare', name, nameLine: nameToken.line, nameColumn: nameToken.column, type, constant: command === 'const', initial: this.parseExpression(), line: token.line, column: token.column };
      }
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
        let endColumn = this.lastBlockEndColumn;
        const elseIf: Array<{ condition: Condition; body: Statement[] }> = [];
        let otherwise: Statement[] = [];
        this.skipLines();
        while (this.atWord('elif') || this.atWord('else')) {
          if (this.atWord('elif')) {
            this.take();
            elseIf.push({ condition: this.parseCondition(), body: this.parseBraced() });
            endLine = this.lastBlockEndLine;
            endColumn = this.lastBlockEndColumn;
            this.skipLines();
          } else {
            this.take();
            otherwise = this.parseBraced();
            endLine = this.lastBlockEndLine;
            endColumn = this.lastBlockEndColumn;
            break;
          }
        }
        return { kind: 'if', condition: first.condition, body: first.body, elseIf, otherwise, line: token.line, column: token.column, endLine, endColumn };
      }
      case 'for': {
        this.take();
        const nameToken = this.current;
        const name = this.expectIdentifier('loop 変数名を指定してください');
        if (this.atWord('in')) {
          this.take();
          const iterable = this.parseExpression();
          const body = this.parseBraced();
          return { kind: 'forEach', name, nameLine: nameToken.line, nameColumn: nameToken.column, iterable, body, line: token.line, column: token.column, endLine: this.lastBlockEndLine, endColumn: this.lastBlockEndColumn };
        }
        this.expectWordValue('from');
        const start = this.parseExpression();
        this.expectWordValue('to');
        const stop = this.parseExpression();
        const step = this.atWord('step') ? (this.take(), this.parseExpression()) : literal(1);
        const body = this.parseBraced();
        return { kind: 'for', name, nameLine: nameToken.line, nameColumn: nameToken.column, start, stop, step, body, line: token.line, column: token.column, endLine: this.lastBlockEndLine, endColumn: this.lastBlockEndColumn };
      }
      case 'while': {
        this.take();
        const condition = this.parseCondition();
        const body = this.parseBraced();
        return { kind: 'while', condition, body, line: token.line, column: token.column, endLine: this.lastBlockEndLine, endColumn: this.lastBlockEndColumn };
      }
      case 'parallel': {
        this.take();
        const body = this.parseBraced();
        return { kind: 'parallel', body, line: token.line, column: token.column, endLine: this.lastBlockEndLine, endColumn: this.lastBlockEndColumn };
      }
      case 'choice': {
        this.take();
        this.skipLines();
        let prompt: Expr | undefined;
        if (!this.atValue('{')) {
          prompt = this.parseExpression();
        }
        this.skipLines(); this.expect('{');
        const options: Array<{ label: Expr; body: Statement[] }> = [];
        this.skipLines();
        while (!this.atValue('}')) {
          const label = this.parseExpression();
          options.push({ label, body: this.parseBraced() });
          this.skipLines();
        }
        const closing = this.take();
        return { kind: 'choice', prompt, options, line: token.line, column: token.column, endLine: closing.line, endColumn: closing.column };
      }
      case 'return': {
        this.take();
        return { kind: 'return', value: this.atLineEnd() ? undefined : this.parseExpression(), line: token.line, column: token.column };
      }
      case 'goto': {
        const start = this.take();
        let scene: string;
        if (this.current.type === 'string') {
          const path = this.take();
          this.rejectUnknownEscapes(path);
          scene = path.value;
        } else {
      scene = this.expectIdentifier('scene name または引用符で囲んだ external scene path を指定してください');
          if (!this.atLineEnd()) throw this.error('external scene path は引用符で囲んでください');
        }
        // Source may use Windows separators, but compiled programs and package
        // keys always use '/'.  Normalize at the language boundary so local
        // scene lookup and external file loading agree.
        scene = scene.replaceAll('\\', '/');
        const parts = scene.split('/');
        const safeDirectory = (part: string) => part.length > 0 && part.length <= 120 && part !== '.' && part !== '..' && !/[<>:"|?*\x00-\x1f]/.test(part) && !/[. ]$/.test(part) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part);
        const file = parts.pop() || '';
        const safeFile = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,79}$/.test(file) && !/[. ]$/.test(file) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(file);
    if (scene.startsWith('/') || parts.some((part) => !safeDirectory(part)) || !safeFile) throw this.error('scene path が不正です');
        scene = [...parts, file].join('/');
        return { kind: 'goto', scene, line: start.line, column: start.column, endLine: this.current.line, endColumn: this.current.column };
      }
      case 'say': {
        this.take();
        this.skipLines();
        let speaker = 'narrator';
        let textExpr: Expr;
        if (this.current.type === 'string') {
          textExpr = this.parseExpression();
        } else if (this.current.type === 'word') {
          const spkToken = this.current;
          this.take();
          if (this.atLineEnd()) throw this.error('say body は引用符で囲んでください');
          speaker = spkToken.value;
          textExpr = this.parseExpression();
        } else {
          throw this.error('say 命令の引数が不正です');
        }
        const args: Expr[] = [
          { kind: 'literal', value: speaker, line: token.line, column: token.column },
          textExpr,
        ];
        if (!this.atLineEnd()) {
          const opacityToken = this.current;
          this.expectWordValue('opacity');
          args.push({ kind: 'literal', value: 'opacity', line: opacityToken.line, column: opacityToken.column });
          args.push(this.parseExpression());
        }
        return {
          kind: 'command',
          name: 'say',
          args,
          line: token.line,
          column: token.column,
          endLine: this.current.line,
          endColumn: this.current.column,
        };
      }
      default: {
        this.take();
        if (this.declaredStructs.has(command)) {
          const name = this.expectIdentifier('変数名を指定してください');
          this.expect('=');
          return { kind: 'declare', name, type: { kind: 'struct', name: command }, initial: this.parseExpression(), line: token.line, column: token.column };
        }
        if (this.atValue('(')) {
          const args = this.parseCallArgs();
          return { kind: 'call', name: command, args, line: token.line, column: token.column };
        }
        const args = this.parseCommandArgs(command);
        return { kind: 'command', name: command, args, line: token.line, column: token.column, endLine: this.current.line, endColumn: this.current.column };
      }
    }
  }

  private parseAssignable(): { kind: 'variable'; name: string; line?: number; column?: number } | { kind: 'index'; target: Expr; key: Expr; line?: number; column?: number } {
    const token = this.current;
    const name = this.expectIdentifier('代入先を指定してください');
    let target: any = { kind: 'variable', name, line: token.line, column: token.column };
    if (this.optional('[')) {
      const key = this.parseExpression();
      this.expect(']');
      target = { kind: 'index', target, key, line: token.line, column: token.column };
    }
    while (this.optional('.')) {
      const field = this.expectIdentifier('struct の field nameを指定してください');
      target = { kind: 'index', target, key: { kind: 'literal', value: field }, line: token.line, column: token.column } as any;
    }
    return target;
  }

  private parseCommandArgs(command: string): Expr[] {
    const args: Expr[] = [];
    while (!this.atLineEnd() && !this.atValue('}')) {
      const token = this.current;
      const isCommandWord = token.type === 'word' && (() => {
        switch (command) {
          case 'bg': return args.length === 0 || args.length === 1 && ['fade', 'crossfade', 'wipe-left', 'wipe-right', 'wipe-up', 'wipe-down'].includes(token.value);
          case 'bgm': return args.length === 0;
          case 'show':
            if (args.some((argument) => argument.kind === 'literal' && argument.value === 'fade')) return false;
            return args.length < (args[0]?.kind === 'literal' && args[0].value === 'image' ? 3 : 2) || token.value === 'fade';
          case 'hide': return args.length === 0 || token.value === 'fade';
          case 'clear': return args.length === 0 || args[0]?.kind === 'literal' && args[0].value === 'image' && args.length === 1;
          case 'play': {
            const previous = args.at(-1);
            return args.length < 2
              || ['crossfade', 'blocking', 'async', 'volume', 'opacity', 'character', 'dissolve', 'later'].includes(token.value)
              || args.length > 2 && previous?.kind === 'literal' && previous.value === 'character';
          }
          case 'volume': return args.length === 0;
          case 'layer': return args.length === 0;
          case 'dialog': return args.length === 0 && ['opacity', 'visible'].includes(token.value);
          case 'camera': return ['zoom', 'at', 'over', 'reset'].includes(token.value);
          case 'effect': return args.length < 2;
          default: return false;
        }
      })();
      if (['bg', 'show', 'play'].includes(command) && token.value === '--only') {
        this.take();
        args.push({ kind: 'literal', value: '--only', line: token.line, column: token.column });
      } else if (['bg', 'show', 'play'].includes(command) && token.value === '--layer') {
        this.take();
        args.push({ kind: 'literal', value: '--layer', line: token.line, column: token.column });
        if (this.atLineEnd() || this.atValue('}')) throw this.error('--layer の後に layer number を指定してください');
        args.push(this.parseExpression());
      } else if (command === 'show' && args.length === 0 && token.type === 'word' && this.peekToken().value === '.') {
        this.take();
        this.expect('.');
        const pose = this.expectIdentifier('character の pose name を指定してください');
        args.push({ kind: 'literal', value: `${token.value}.${pose}`, line: token.line, column: token.column });
      } else if (['show', 'move'].includes(command) && args.length >= (command === 'show' ? 2 : args[0]?.kind === 'literal' && args[0].value === 'bg' ? 2 : 3) && token.type === 'word' && ['x', 'y'].includes(token.value) && ['+', '-'].includes(this.peekToken().value)) {
        const axis = this.take();
        const sign = this.take();
        if (this.optional('(')) {
          const value = this.parseExpression();
          this.expect(')');
          args.push({ kind: 'literal', value: `${axis.value}${sign.value}`, line: axis.line, column: axis.column }, value);
          continue;
        }
        if (this.current.type !== 'number' || !/^\d+$/.test(this.current.value)) throw this.error(`${command} の位置ずらしは x+30 / x+(式) の形式で指定してください`);
        const amount = this.take();
        args.push({ kind: 'literal', value: `${axis.value}${sign.value}${amount.value}`, line: axis.line, column: axis.column });
      } else if (command === 'move' && args.length === 0 && token.type === 'word') {
        this.take();
        args.push({ kind: 'literal', value: token.value, line: token.line, column: token.column });
      } else if (command === 'bg' && args.length === 1 && token.type === 'word' && token.value === 'wipe') {
        this.take();
        this.expect('-');
        const direction = this.expectIdentifier('wipe directionを指定してください');
    if (!['left', 'right', 'up', 'down'].includes(direction)) throw this.error('background wipe の direction は left、right、up、down のいずれかにしてください');
        args.push({ kind: 'literal', value: `wipe-${direction}`, line: token.line, column: token.column });
      } else if (command === 'move' && args.length === 1 && args[0]?.kind === 'literal' && args[0].value === 'character') {
        if (token.type === 'word' && this.peekToken().value === 'by') {
          this.take();
          args.push({ kind: 'literal', value: token.value, line: token.line, column: token.column });
        } else {
          args.push(this.parseExpression());
        }
      } else if (command === 'move' && token.type === 'word'
        && (token.value === 'over'
          || token.value === 'by' && (args.length === 1 && args[0]?.kind === 'literal' && args[0].value === 'bg'
            || args.length === 2 && args[0]?.kind === 'literal' && args[0].value === 'character'))) {
        this.take();
        args.push({ kind: 'literal', value: token.value, line: token.line, column: token.column });
      } else if (isCommandWord) {
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
    if (this.expressionNesting >= MAX_EXPRESSION_NESTING) {
      throw this.error(`expression nesting depth exceeds ${MAX_EXPRESSION_NESTING}`);
    }
    this.expressionNesting += 1;
    try {
      return this.parseExpressionBody(min);
    } finally {
      this.expressionNesting -= 1;
    }
  }

  private parseExpressionBody(min: number): Expr {
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
    if (this.atWord('true') || this.atWord('false')) {
      this.take();
      expr = { kind: 'literal', value: token.value === 'true', line: token.line, column: token.column };
    } else if (this.atValue('[')) {
      this.take();
      const items: Expr[] = [];
      if (!this.atValue(']')) {
        items.push(this.parseExpression());
        while (this.optional(',')) {
          if (this.atValue(']')) break;
          items.push(this.parseExpression());
        }
      }
      this.expect(']');
      expr = { kind: 'list', items, line: token.line, column: token.column };
    } else if (token.type === 'number') {
      this.take();
      if (/[.eE]/.test(token.value)) {
        if (!Number.isFinite(Number(token.value))) throw new ParseError('float literal は有限値で指定してください', token);
        expr = { kind: 'float', value: token.value, line: token.line, column: token.column };
      } else {
      let val: number | bigint;
      try {
        const bi = BigInt(token.value);
        val = (bi >= BigInt(Number.MIN_SAFE_INTEGER) && bi <= BigInt(Number.MAX_SAFE_INTEGER)) ? Number(token.value) : bi;
      } catch {
        val = Number(token.value);
      }
      expr = { kind: 'literal', value: val, line: token.line, column: token.column };
      }
    } else if (token.type === 'string') {
      this.rejectUnknownEscapes(this.take());
      expr = { kind: 'literal', value: token.value, line: token.line, column: token.column, sourceColumns: token.sourceColumns };
    } else if (token.type === 'word') {
      if (this.isQualifiedCallAhead()) {
        const name = this.parseQualifiedCallName();
        expr = { kind: 'call', name, args: this.parseCallArgs(), line: token.line, column: token.column };
      } else {
        this.take();
        if (this.atValue('(')) {
        expr = { kind: 'call', name: token.value, args: this.parseCallArgs(), line: token.line, column: token.column };
        } else {
          expr = { kind: 'variable', name: token.value, line: token.line, column: token.column };
        }
      }
    } else if (this.optional('(')) {
      expr = this.parseExpression();
      this.expect(')');
    } else if (this.optional('{')) {
      this.skipLines();
      const entries: Array<{ key: string; value: Expr }> = [];
      if (!this.atValue('}')) {
        const keyToken = this.expect('string', 'dict の key には string literal を指定してください');
        this.rejectUnknownEscapes(keyToken);
        this.skipLines();
        this.expect(':');
        this.skipLines();
        entries.push({ key: keyToken.value, value: this.parseExpression() });
        this.skipLines();
        while (this.optional(',')) {
          this.skipLines();
          if (this.atValue('}')) break;
          const next = this.expect('string', 'dict の key には string literal を指定してください');
          this.rejectUnknownEscapes(next);
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
      throw this.error('式を指定してください');
    }

    while (true) {
      if (this.optional('[')) {
        const key = this.parseExpression();
        this.expect(']');
        expr = { kind: 'index', target: expr, key, line: expr.line, column: expr.column };
      } else if (this.optional('.')) {
        const field = this.expectIdentifier('struct の field nameを指定してください');
        expr = { kind: 'index', target: expr, key: { kind: 'literal', value: field }, line: expr.line, column: expr.column };
      } else {
        break;
      }
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

  private rejectUnknownEscapes(token: Token): void {
    const escaped = token.unknownEscapes?.[0];
    if (escaped) {
      const column = token.unknownEscapeColumns?.[0] ?? token.column;
      const endColumn = token.unknownEscapeEndColumns?.[0] ?? column + 1;
      throw new ParseError(`不明な escape sequence '\\${escaped}' です`, token, column, endColumn);
    }
  }

  private expectWordValue(value: string): void {
    const token = this.expect('word', `'${value}' が必要です`);
    if (token.value !== value) throw new ParseError(`'${value}' が必要です`, token);
  }

  private isBlockStatement(stmt: Statement): boolean {
    return stmt.kind === 'if' || stmt.kind === 'for' || stmt.kind === 'forEach' || stmt.kind === 'while' || stmt.kind === 'choice' || stmt.kind === 'parallel';
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
    else if (!this.at('eof') && !this.atValue('}')) throw this.error('行末が必要です');
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

  private expect(typeOrValue: string, message = `${typeOrValue} が必要です`): Token {
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
      if (this.at('eof')) throw this.error("'}' が必要です");
      const stmt = this.parseStatement();
      body.push(stmt);
      this.endStatement(stmt);
      this.skipLines();
    }
    const closing = this.take();
    this.lastBlockEndLine = closing.line;
    this.lastBlockEndColumn = closing.column;
    return body;
  }
}

const literal = (value: number | string | bigint | boolean): Expr => ({ kind: 'literal', value });
export function parse(source: string, knownStructs: Iterable<string> = [], options: { allowCharacterMethodDeclaration?: boolean } = {}): Script {
  return new Parser(source, knownStructs, options).parse();
}
