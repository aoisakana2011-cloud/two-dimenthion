import { AssetKind, Expr, ExternalCharacter, FunctionDef, NodeLocation, PrimitiveType, Script, Statement, ValueType } from '../parser';
import { isRuntimeStateApi, RUNTIME_STATE_APIS } from '../language/builtins';

export class TypeCheckError extends Error {
  file?: string;
  line?: number;
  column?: number;
}

type ExtendedType = ValueType | 'bool';

const ALLOWED_EXTENSIONS: Record<AssetKind, string[]> = {
  bg: ['.png', '.jpg', '.jpeg', '.webp', '.gif'],
  char: ['.png', '.jpg', '.jpeg', '.webp', '.gif'],
  image: ['.png', '.jpg', '.jpeg', '.webp', '.gif'],
  bgm: ['.wav', '.ogg', '.mp3', '.flac'],
  se: ['.wav', '.ogg', '.mp3', '.flac'],
  voice: ['.wav', '.ogg', '.mp3', '.flac'],
  video: ['.mp4', '.webm'],
};

function validAssetPath(path: string): boolean {
  if (!path || /^(?:[A-Za-z]:|[\\/])/.test(path)) return false;
  if (path.includes('\\')) return false;
  const parts = path.replace(/\\/g, '/').split('/');
  if (parts.length < 2 || parts[0] !== 'asset') return false;
  return parts.slice(1).every((part) => part.length > 0 && part !== '.' && part !== '..' && !/[<>:"|?*\x00-\x1f]/.test(part) && !/[. ]$/.test(part) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part));
}

function typeName(type: ExtendedType): string {
  if (typeof type === 'string') return type;
  return type.kind === 'dict' || type.kind === 'list' ? `${type.kind}[${type.value}]` : type.name;
}

function sameType(left: ExtendedType, right: ExtendedType): boolean {
  if (typeof left === 'string' || typeof right === 'string') return left === right;
  if (left.kind !== right.kind) return false;
  return left.kind === 'dict' || left.kind === 'list'
    ? left.value === (right as { kind: 'dict' | 'list'; value: PrimitiveType }).value
    : left.name === (right as { kind: 'struct'; name: string }).name;
}

type ExternalCharacters = Map<string, Set<string> | ExternalCharacter>;
const characterTypeName = (name: string) => `character:${name}`;
const characterInfo = (value: Set<string> | ExternalCharacter): ExternalCharacter => value instanceof Set ? { poses: value, fields: {} } : value;
function characterPropertyType(expression: Expr): PrimitiveType | undefined {
  if (expression.kind === 'float') return 'float';
  if (expression.kind === 'literal') return typeof expression.value === 'string' ? 'str' : typeof expression.value === 'boolean' ? 'bool' : (typeof expression.value === 'number' || typeof expression.value === 'bigint') ? 'int' : undefined;
  if (expression.kind === 'unary' && (expression.operator === '+' || expression.operator === '-')) return characterPropertyType(expression.value);
  return undefined;
}

function interpolationNames(value: string): string[] {
  return [...value.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)(\(\))?\}/g)].map((match) => `${match[1]}${match[2] || ''}`);
}

interface TypeContext {
  file: string;
  globals: Map<string, ValueType>;
  functions: Map<string, FunctionDef>;
  scenes: Set<string>;
  characters: Map<string, Set<string>>;
  assets: Map<string, { type: AssetKind; path: string; loc?: NodeLocation }>;
  structs: Map<string, Record<string, PrimitiveType>>;
  currentFunction?: FunctionDef;
  locals?: Set<string>;
  declaredLocals?: Set<string>;
  readonly?: Set<string>;
  externalGlobals?: Set<string>;
  knownStrings?: Map<string, string>;
  knownNumbers?: Map<string, bigint | number>;
  ambiguous?: Set<string>;
  errors?: TypeCheckError[];
}

function getLocStr(node?: NodeLocation): string {
  return `line ${node?.line ?? 1}, column ${node?.column ?? 1}`;
}

function knownStringValue(expression: Expr | undefined, knownStrings?: Map<string, string>): string | undefined {
  if (!expression) return undefined;
  if (expression.kind === 'literal') return typeof expression.value === 'string' ? expression.value : undefined;
  if (expression.kind === 'variable') return knownStrings?.get(expression.name);
  if (expression.kind === 'binary' && expression.operator === '+') {
    const left = knownStringValue(expression.left, knownStrings), right = knownStringValue(expression.right, knownStrings);
    return left !== undefined && right !== undefined ? left + right : undefined;
  }
  return undefined;
}

function validateNestedInterpolations(value: string, variables: Map<string, ValueType>, ctx: TypeContext, seen = new Set<string>()): void {
  for (const path of interpolationNames(value)) {
    if (path.endsWith('()')) continue;
    const name = path.split('.')[0];
    const nested = ctx.knownStrings?.get(name);
    if (nested !== undefined && !seen.has(name)) {
      const next = new Set(seen);
      next.add(name);
      // The ordinary literal check validates this expansion's functions,
      // variables and struct fields; recurse to cover another known template.
      expressionType({ kind: 'literal', value: nested, line: 1, column: 1 }, variables, { ...ctx, knownStrings: new Map() });
      validateNestedInterpolations(nested, variables, ctx, next);
    }
  }
}

function expressionType(expression: Expr, variables: Map<string, ValueType>, ctx: TypeContext, expected?: ValueType): ExtendedType {
  const loc = getLocStr(expression);

  if (expression.kind === 'float') return 'float';

  if (expression.kind === 'literal') {
    if (typeof expression.value === 'boolean') return 'bool';
    if (typeof expression.value === 'string') {
      for (const path of interpolationNames(expression.value)) {
        if (path.endsWith('()')) {
          const name = path.slice(0, -2);
          const fn = ctx.functions.get(name);
          if (!fn) throw new TypeCheckError(`${loc}: 補間対象の関数 '${name}' が未定義です`);
          if (fn.params.length) throw new TypeCheckError(`${loc}: 補間対象の関数 '${name}' は引数なしで呼び出せません`);
          if (fn.returnType === 'none') throw new TypeCheckError(`${loc}: 補間対象の関数 '${name}' は値を返しません`);
          continue;
        }
        const [name, ...fields] = path.split('.');
        let current: ExtendedType | undefined = variables.get(name);
        if (!current) throw new TypeCheckError(`${loc}: 型エラー (${ctx.file}): 補間対象の変数 '${name}' が未定義です`);
        for (const field of fields) {
          if (!current || typeof current === 'string' || current.kind !== 'struct') throw new TypeCheckError(`${loc}: 補間対象 '${path}' の '${field}' はフィールド参照できません`);
          const next: PrimitiveType | undefined = ctx.structs.get(current.name)?.[field];
          if (!next) throw new TypeCheckError(`${loc}: 補間対象 '${path}' にフィールド '${field}' はありません`);
          current = next;
        }
      }
      validateNestedInterpolations(expression.value, variables, ctx);
      return 'str';
    }
    return 'int';
  }

  if (expression.kind === 'variable') {
    if (ctx.ambiguous?.has(expression.name)) throw new TypeCheckError(`${loc}: 蝙九お繝ｩ繧ｼ繝ｼ (${ctx.file}): 蛻・ｲ舌�螟画焚 '${expression.name}' 縺ｮ蝙九′蜿門ｾ励〒縺阪∪縺帙ｓ`);
    const type = variables.get(expression.name);
    if (!type) throw new TypeCheckError(`${loc}: 型エラー (${ctx.file}): 未定義の変数 '${expression.name}' です`);
    return type;
  }

  if (expression.kind === 'binary') {
    const op = expression.operator;
    const left = expressionType(expression.left, variables, ctx);
    const right = expressionType(expression.right, variables, ctx);

    if (op === '+') {
      if (left === 'str' && right === 'str') return 'str';
      if (left === 'int' && right === 'int') return 'int';
      if (left === 'float' && right === 'float') return 'float';
      throw new TypeCheckError(`${loc}: 型エラー (${ctx.file}): '+' の左右の型が一致していません (${typeName(left)} と ${typeName(right)})`);
    }

    if (['-', '*', '/', '%'].includes(op)) {
      if (left === 'float' && right === 'float' && op !== '%') return 'float';
      if (left !== 'int' || right !== 'int') {
        throw new TypeCheckError(`${loc}: 型エラー (${ctx.file}): '${op}' の左右は同じ数値型でなければなりません`);
      }
      return 'int';
    }

    if (['==', '!='].includes(op)) {
      if (!sameType(left, right)) {
        throw new TypeCheckError(`${loc}: 型エラー (${ctx.file}): 比較する値の型が一致していません (${typeName(left)} と ${typeName(right)})`);
      }
      return 'bool';
    }

    if (['>', '>=', '<', '<='].includes(op)) {
      if (left !== right || left !== 'int' && left !== 'float') {
        throw new TypeCheckError(`${loc}: 型エラー (${ctx.file}): '${op}' の左右は同じ数値型でなければなりません`);
      }
      return 'bool';
    }

    if (op === 'and' || op === 'or') {
      if (left !== 'bool' || right !== 'bool') {
        throw new TypeCheckError(`${loc}: 型エラー (${ctx.file}): '${op}' の左右は条件式（真偽値）でなければなりません`);
      }
      return 'bool';
    }

    throw new TypeCheckError(`${loc}: 型エラー (${ctx.file}): 未知の演算子 '${op}' です`);
  }

  if (expression.kind === 'unary') {
    const op = expression.operator;
    const inner = expressionType(expression.value, variables, ctx);
    if (op === 'not') {
      if (inner !== 'bool') {
        throw new TypeCheckError(`${loc}: 型エラー (${ctx.file}): not の対象は条件式（真偽値）でなければなりません`);
      }
      return 'bool';
    }
    if (op === '-' || op === '+') {
      if (inner !== 'int' && inner !== 'float') {
        throw new TypeCheckError(`${loc}: 型エラー (${ctx.file}): 単項 '${op}' の対象は数値でなければなりません`);
      }
      return inner;
    }
    throw new TypeCheckError(`${loc}: 型エラー (${ctx.file}): 未知の単項演算子 '${op}' です`);
  }

  if (expression.kind === 'index') {
    const targetType = expressionType(expression.target, variables, ctx);
    const keyType = expressionType(expression.key, variables, ctx);
    if (typeof targetType !== 'string' && targetType.kind === 'struct' && expression.key.kind === 'literal' && typeof expression.key.value === 'string') {
      const field = ctx.structs.get(targetType.name)?.[expression.key.value];
      if (!field) throw new TypeCheckError(`${loc}: struct '${targetType.name}' にフィールド '${expression.key.value}' はありません`);
      return field;
    }
    if (typeof targetType !== 'string' && targetType.kind === 'list') {
      if (keyType !== 'int') throw new TypeCheckError(`${loc}: list の添字は int で指定してください`);
      return targetType.value;
    }
    if (typeof targetType === 'string' || targetType.kind !== 'dict') {
      throw new TypeCheckError(`${loc}: 型エラー (${ctx.file}): インデックス参照の対象は辞書型でなければなりません`);
    }
    if (keyType !== 'str') {
      throw new TypeCheckError(`${loc}: 型エラー (${ctx.file}): 辞書のキーは str でなければなりません`);
    }
    return targetType.value;
  }

  if (expression.kind === 'dict') {
    const keys = new Set<string>();
    for (const entry of expression.entries) {
      if (keys.has(entry.key)) throw new TypeCheckError(`${loc}: duplicate dictionary key '${entry.key}'`);
      keys.add(entry.key);
    }
    const types = expression.entries.map((entry) => expressionType(entry.value, variables, ctx));
    if (expected && typeof expected !== 'string') {
      if (expected.kind === 'struct') return { kind: 'dict', value: 'int' }; // Fields are checked against the struct declaration below.
      if (expected.kind !== 'dict') throw new TypeCheckError(`${loc}: dict の値を ${typeName(expected)} に代入できません`);
      if (types.some((type) => type !== expected.value)) throw new TypeCheckError(`${loc}: 辞書の値の型は ${expected.value} に統一してください`);
      return expected;
    }
    if (!types.length) return { kind: 'dict', value: 'int' };
    if (types.some((t) => typeof t !== 'string' || !['int', 'float', 'str', 'bool'].includes(t) || t !== types[0])) {
      throw new TypeCheckError(`${loc}: 型エラー (${ctx.file}): 辞書の値の型は統一してください`);
    }
    return { kind: 'dict', value: types[0] as PrimitiveType };
  }

  if (expression.kind === 'list') {
    const expectedList = expected && typeof expected !== 'string' && expected.kind === 'list' ? expected : undefined;
    if (!expression.items.length) {
      if (expectedList) return expectedList;
      throw new TypeCheckError(`${loc}: 空のlistは要素型を推論できません。list[str] などで型を指定してください`);
    }
    const types = expression.items.map(item => expressionType(item, variables, ctx, expectedList?.value));
    if (types.some(type => typeof type !== 'string' || !['int', 'float', 'str', 'bool'].includes(type) || type !== types[0])) {
      throw new TypeCheckError(`${loc}: list の要素型はすべて同じにしてください`);
    }
    const inferred = types[0] as PrimitiveType;
    if (expectedList && expectedList.value !== inferred) throw new TypeCheckError(`${loc}: list[${inferred}] は list[${expectedList.value}] に代入できません`);
    return expectedList || { kind: 'list', value: inferred };
  }

  if (expression.kind === 'call') {
    const runtimeApi = RUNTIME_STATE_APIS.get(expression.name);
    if (runtimeApi) {
      if (expression.args.length !== runtimeApi.parameters.length) {
        throw new TypeCheckError(`${loc}: ${expression.name} requires ${runtimeApi.parameters.length} argument(s)`);
      }
      for (let index = 0; index < runtimeApi.parameters.length; index += 1) {
        const actual = expressionType(expression.args[index], variables, ctx);
        if (actual !== runtimeApi.parameters[index]) {
          throw new TypeCheckError(`${loc}: ${expression.name} argument ${index + 1} must be ${runtimeApi.parameters[index]}`);
        }
      }
      return runtimeApi.returns as ExtendedType;
    }
    if (expression.name === 'list.length') {
      if (expression.args.length !== 1) throw new TypeCheckError(`${loc}: list.length は引数を1つ取ります`);
      const type = expressionType(expression.args[0], variables, ctx);
      if (typeof type === 'string' || type.kind !== 'list') throw new TypeCheckError(`${loc}: list.length の引数はlist型である必要があります`);
      return 'int';
    }
    if (expression.name === 'list.append' || expression.name === 'list.contains') {
      if (expression.args.length !== 2) throw new TypeCheckError(`${loc}: ${expression.name} は2引数を取ります`);
      const itemType = expressionType(expression.args[1], variables, ctx);
      if (itemType !== 'int' && itemType !== 'float' && itemType !== 'str' && itemType !== 'bool') throw new TypeCheckError(`${loc}: ${expression.name} requires a primitive list element`);
      const listType = expressionType(expression.args[0], variables, ctx, { kind: 'list', value: itemType });
      if (typeof listType === 'string' || listType.kind !== 'list' || itemType !== listType.value) throw new TypeCheckError(`${loc}: ${expression.name} のlistと要素の型が一致しません`);
      return expression.name === 'list.contains' ? 'bool' : listType;
    }
    if (expression.name === 'text.trim' || expression.name === 'text.normalize_space') {
      if (expression.args.length !== 1 || expressionType(expression.args[0], variables, ctx) !== 'str') throw new TypeCheckError(`${loc}: ${expression.name} はstr型の引数を1つ取ります`);
      return 'str';
    }
    if (expression.name === 'text.split') {
      if (expression.args.length !== 2 || expression.args.some(argument => expressionType(argument, variables, ctx) !== 'str')) throw new TypeCheckError(`${loc}: text.split はstr型の引数を2つ取ります`);
      if (knownStringValue(expression.args[1], ctx.knownStrings) === '') throw new TypeCheckError(`${loc}: text.split separator must not be empty`);
      return { kind: 'list', value: 'str' };
    }
    if (expression.name === 'text.replace') {
      if (expression.args.length !== 3 || expression.args.some(argument => expressionType(argument, variables, ctx) !== 'str')) throw new TypeCheckError(`${loc}: text.replace はstr型の引数を3つ取ります`);
      if (knownStringValue(expression.args[1], ctx.knownStrings) === '') throw new TypeCheckError(`${loc}: text.replace search must not be empty`);
      return 'str';
    }
    if (expression.name === 'str') {
      if (expression.args.length !== 1 || !['int', 'float'].includes(String(expressionType(expression.args[0], variables, ctx)))) {
        throw new TypeCheckError(`${loc}: 型エラー (${ctx.file}): str() は数値型の引数を1つ取ります`);
      }
      return 'str';
    }
    if (expression.name === 'int') {
      if (expression.args.length !== 1 || !['str', 'float'].includes(String(expressionType(expression.args[0], variables, ctx)))) {
        throw new TypeCheckError(`${loc}: 型エラー (${ctx.file}): int() は str または float 型の引数を1つ取ります`);
      }
      return 'int';
    }
    if (expression.name === 'float') {
      if (expression.args.length !== 1 || !['int', 'str', 'float'].includes(String(expressionType(expression.args[0], variables, ctx)))) {
        throw new TypeCheckError(`${loc}: 型エラー (${ctx.file}): float() は数値または str 型の引数を1つ取ります`);
      }
      return 'float';
    }

    const fn = ctx.functions.get(expression.name);
    if (!fn) {
      throw new TypeCheckError(`${loc}: 型エラー (${ctx.file}): 未定義の関数 '${expression.name}' です`);
    }
    if (expression.args.length !== fn.params.length) {
      throw new TypeCheckError(`${loc}: 型エラー (${ctx.file}): 関数 '${expression.name}' の引数の個数が一致しません (期待: ${fn.params.length}, 実際: ${expression.args.length})`);
    }
    for (let i = 0; i < fn.params.length; i++) {
      const argType = expressionType(expression.args[i], variables, ctx, fn.params[i].type);
      if (!sameType(fn.params[i].type, argType)) {
        throw new TypeCheckError(`${loc}: 型エラー (${ctx.file}): 関数 '${expression.name}' の第 ${i + 1} 引数の型が一致しません`);
      }
    }
    return fn.returnType;
  }

  return 'int';
}

export function inferValueType(expression: Expr, variables = new Map<string, ValueType>(), functions: FunctionDef[] = []): ValueType {
  const inferred = expressionType(expression, variables, {
    file: 'current', globals: variables, functions: new Map(functions.map((fn) => [fn.name, fn])), scenes: new Set(), characters: new Map(), assets: new Map(), structs: new Map(),
  });
  if (inferred === 'none') throw new TypeCheckError(`${getLocStr(expression)}: none は変数型として使用できません`);
  if (expression.kind === 'dict' && expression.entries.length === 0) throw new TypeCheckError(`${getLocStr(expression)}: 空の辞書は型を推論できません`);
  if (expression.kind === 'list' && expression.items.length === 0) throw new TypeCheckError(`${getLocStr(expression)}: empty list needs an explicit list[T] type`);
  return inferred;
}

function checkCondition(expression: Expr, variables: Map<string, ValueType>, ctx: TypeContext): void {
  const loc = getLocStr(expression);
  const type = expressionType(expression, variables, ctx);
  if (type !== 'bool') {
    throw new TypeCheckError(`${loc}: 型エラー (${ctx.file}): 条件式には比較演算子（== / != / > / >= / < / <=）または論理式が必要です`);
  }
}

const MAX_DURATION_MS = 2147483647n;

function checkDuration(expression: Expr, variables: Map<string, ValueType>, ctx: TypeContext, loc: string, label: string): void {
  if (expressionType(expression, variables, ctx) !== 'int') return;
  const value = staticValue(expression, ctx.knownNumbers);
  if (typeof value === 'bigint' && (value < 0n || value > MAX_DURATION_MS)) {
    throw new TypeCheckError(`${loc}: ${label} は 0 以上 2147483647 以下でなければなりません`);
  }
}

function checkFade(args: Expr[], variables: Map<string, ValueType>, ctx: TypeContext, loc: string): void {
  if (!args.length) return;
  if (args.length === 2 && args[0].kind === 'literal' && args[0].value === 'fade' && expressionType(args[1], variables, ctx) === 'int') checkDuration(args[1], variables, ctx, loc, 'fade の時間');
  if (args.length !== 2 || args[0].kind !== 'literal' || args[0].value !== 'fade' || expressionType(args[1], variables, ctx) !== 'int') throw new TypeCheckError(`${loc}: 演出は fade <int> で指定してください`);
}

const MAX_CHARACTER_OFFSET_PX = 1_000_000n;

function characterOffsetEnd(args: Expr[], start: number, loc: string, variables: Map<string, ValueType>, ctx: TypeContext): number {
  const axes = new Set<string>();
  let index = start;
  while (index < args.length) {
    const arg = args[index];
    const value = arg.kind === 'literal' && typeof arg.value === 'string' ? arg.value : '';
    const match = /^([xy])([+-])(\d+)?$/.exec(value);
    if (!match) break;
    if (axes.has(match[1])) throw new TypeCheckError(`${loc}: 位置ずらしは x / y をそれぞれ1回だけ指定できます`);
    axes.add(match[1]);
    if (match[3]) {
      if (BigInt(match[3]) > MAX_CHARACTER_OFFSET_PX) throw new TypeCheckError(`${loc}: 位置ずらしは ±${MAX_CHARACTER_OFFSET_PX} px 以内で指定してください`);
      index++;
    } else {
      if (!args[index + 1] || !['int', 'float'].includes(String(expressionType(args[index + 1], variables, ctx)))) throw new TypeCheckError(`${loc}: 位置ずらしの式は int または float で指定してください`);
      const amount = staticValue(args[index + 1], ctx.knownNumbers);
      if (typeof amount === 'bigint' && (amount < -MAX_CHARACTER_OFFSET_PX || amount > MAX_CHARACTER_OFFSET_PX)
        || typeof amount === 'number' && (!Number.isFinite(amount) || Math.abs(amount) > Number(MAX_CHARACTER_OFFSET_PX))) {
        throw new TypeCheckError(`${loc}: 位置ずらしは ±${MAX_CHARACTER_OFFSET_PX} px 以内で指定してください`);
      }
      index += 2;
    }
  }
  return index;
}

function checkAudioTransition(args: Expr[], variables: Map<string, ValueType>, ctx: TypeContext, loc: string): void {
  if (!args.length) return;
  if (args.length === 2 && args[0].kind === 'literal' && args[0].value === 'crossfade' && expressionType(args[1], variables, ctx) === 'int') {
    checkDuration(args[1], variables, ctx, loc, 'crossfade の時間');
    return;
  }
  throw new TypeCheckError(`${loc}: 音声遷移は crossfade <int> で指定してください`);
}

function checkCommand(name: string, args: Expr[], variables: Map<string, ValueType>, ctx: TypeContext, locStr: string): void {
  const getArgStr = (idx: number): string => {
    const a = args[idx];
    if (a && a.kind === 'literal' && typeof a.value === 'string') return a.value;
    throw new TypeCheckError(`${locStr}: 型エラー (${ctx.file}): コマンド '${name}' の第 ${idx + 1} 引数はリテラル識別子でなければなりません`);
  };

  if (name === 'show' && args[0]?.kind === 'literal' && args[0].value !== 'image' && !/^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/.test(String(args[0].value))) {
    throw new TypeCheckError(`${locStr}: show は show <character>.<pose> <position> または show image <id> <position> を使用してください`);
  }

  switch (name) {
    case 'volume': {
      if (args.length !== 2) throw new TypeCheckError(`${locStr}: volume は volume <bgm|se|voice> <float 0.0..1.0> を指定してください`);
      const kind = getArgStr(0);
      if (!['bgm', 'se', 'voice'].includes(kind)) throw new TypeCheckError(`${locStr}: volume の対象は bgm、se、voice です`);
      if (expressionType(args[1], variables, ctx) !== 'float') throw new TypeCheckError(`${locStr}: volume は float で指定してください`);
      const value = staticValue(args[1], ctx.knownNumbers);
      if (typeof value === 'number' && (value < 0 || value > 1)) throw new TypeCheckError(`${locStr}: volume は 0.0 から 1.0 の範囲です`);
      break;
    }
    case 'dialog': {
      if (args.length !== 2 || getArgStr(0) !== 'opacity') throw new TypeCheckError(`${locStr}: dialog は dialog opacity <float 0.0..1.0> を指定してください`);
      if (expressionType(args[1], variables, ctx) !== 'float') throw new TypeCheckError(`${locStr}: dialog opacity は float で指定してください`);
      const value = staticValue(args[1], ctx.knownNumbers);
      if (typeof value === 'number' && (value < 0 || value > 1)) throw new TypeCheckError(`${locStr}: dialog opacity は 0.0 から 1.0 の範囲です`);
      break;
    }
    case 'bg': {
      if (args.length !== 1) throw new TypeCheckError(`${locStr}: コマンド 'bg' は引数を1つ取ります`);
      const id = getArgStr(0);
      const asset = ctx.assets.get(id);
      if (!asset || asset.type !== 'bg') throw new TypeCheckError(`${locStr}: 未定義または型が異なる背景アセット '${id}' です`);
      break;
    }
    case 'bgm': {
      if (args.length !== 1) throw new TypeCheckError(`${locStr}: コマンド 'bgm' は引数を1つ取ります`);
      const id = getArgStr(0);
      const asset = ctx.assets.get(id);
      if (!asset || asset.type !== 'bgm') throw new TypeCheckError(`${locStr}: 未定義または型が異なるBGMアセット '${id}' です`);
      break;
    }
    case 'play': {
      if (args.length < 2) throw new TypeCheckError(`${locStr}: コマンド 'play' は最低2つの引数を取ります`);
      const kind = getArgStr(0);
      if (!['se', 'voice', 'video', 'bgm'].includes(kind)) throw new TypeCheckError(`${locStr}: 未知の再生種別 '${kind}' です`);
      const id = getArgStr(1);
      const asset = ctx.assets.get(id);
      if (!asset || asset.type !== kind) throw new TypeCheckError(`${locStr}: 未定義または型が異なるアセット '${id}' (期待: ${kind}) です`);
      const seen = new Set<string>();
      for (let index = 2; index < args.length;) {
        const option = getArgStr(index++);
        if (seen.has(option)) throw new TypeCheckError(`${locStr}: play ${option} オプションが重複しています`);
        seen.add(option);
        if (option === 'volume') {
          if (!['bgm', 'se', 'voice'].includes(kind) || index >= args.length) throw new TypeCheckError(`${locStr}: volume は音声再生だけに指定できます`);
          const value = args[index++];
          if (expressionType(value, variables, ctx) !== 'float') throw new TypeCheckError(`${locStr}: play volume は float で指定してください`);
          const constant = staticValue(value, ctx.knownNumbers);
          if (typeof constant === 'number' && (constant < 0 || constant > 1)) throw new TypeCheckError(`${locStr}: play volume は 0.0 から 1.0 の範囲です`);
        } else if (option === 'crossfade') {
          if (kind !== 'bgm' || index >= args.length) throw new TypeCheckError(`${locStr}: crossfade はBGM再生に指定してください`);
          checkAudioTransition([{ kind: 'literal', value: 'crossfade' }, args[index++]], variables, ctx, locStr);
        } else if (option === 'blocking' || option === 'async') {
          if (kind !== 'voice' && kind !== 'video') throw new TypeCheckError(`${locStr}: 再生モードは voice/video に指定してください`);
        } else throw new TypeCheckError(`${locStr}: play のオプション '${option}' は未対応です。BGMは crossfade、voice は blocking / async を使用してください`);
      }
      if ((kind === 'bgm' || kind === 'se') && seen.has('blocking') || (kind === 'bgm' || kind === 'se') && seen.has('async')) throw new TypeCheckError(`${locStr}: BGM/SE に blocking/async は指定できません`);
      break;
    }
    case 'show': {
      const poseReference = args.length ? /^([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(getArgStr(0)) : null;
      if (poseReference) {
        if (args.length < 2) throw new TypeCheckError(`${locStr}: show は show <character>.<pose> <position> で指定してください`);
        const [, charName, pose] = poseReference;
        const pos = getArgStr(1);
        if (!['far_left', 'left', 'center', 'right', 'far_right'].includes(pos)) throw new TypeCheckError(`${locStr}: 不正な表示位置 '${pos}' です`);
        const charDef = ctx.characters.get(charName);
        if (!charDef) throw new TypeCheckError(`${locStr}: 未定義のキャラクター '${charName}' です`);
        if (!charDef.has(pose)) throw new TypeCheckError(`${locStr}: キャラクター '${charName}' にポーズ '${pose}' はありません`);
        const transitionStart = characterOffsetEnd(args, 2, locStr, variables, ctx);
        checkFade(args.slice(transitionStart), variables, ctx, locStr);
        break;
      }
      if (args.length < 2) throw new TypeCheckError(`${locStr}: コマンド 'show' の引数が不足しています`);
      const targetKind = getArgStr(0);
      if (targetKind === 'image') {
        if (args.length !== 3) throw new TypeCheckError(`${locStr}: show image は画像と位置を指定してください`);
        const imgName = getArgStr(1);
        const asset = ctx.assets.get(imgName);
        if (!asset || asset.type !== 'image') throw new TypeCheckError(`${locStr}: 未定義の画像アセット '${imgName}' です`);
        if (args.length >= 3) {
          const pos = getArgStr(2);
          if (!['far_left', 'left', 'center', 'right', 'far_right'].includes(pos)) throw new TypeCheckError(`${locStr}: 不正な配置位置 '${pos}' です`);
        }
      } else {
        throw new TypeCheckError(`${locStr}: show の対象は image でなければなりません`);
      }
      break;
    }
    case 'move': {
      const targetKind = getArgStr(0);
      const targetIndex = targetKind === 'character' ? 1 : -1;
      if (!['character', 'bg'].includes(targetKind)) throw new TypeCheckError(`${locStr}: move は move character <id> by x+5 y+5 [over <ms>] または move bg by x+5 y+5 [over <ms>] を使用してください`);
      const byIndex = targetKind === 'character' ? 2 : 1;
      if (targetKind === 'character') {
        const target = args[targetIndex];
        const knownTarget = knownStringValue(target, ctx.knownStrings);
        if (knownTarget !== undefined) {
          if (!ctx.characters.has(knownTarget)) throw new TypeCheckError(`${locStr}: 未定義のキャラクター '${knownTarget}' です`);
        } else if (expressionType(target, variables, ctx) !== 'str') {
          throw new TypeCheckError(`${locStr}: move character の対象はキャラクター名を表す str で指定してください`);
        }
      }
      if (getArgStr(byIndex) !== 'by') throw new TypeCheckError(`${locStr}: move の差分の前に by を指定してください`);
      const start = byIndex + 1;
      let index = characterOffsetEnd(args, start, locStr, variables, ctx);
      if (index === start) throw new TypeCheckError(`${locStr}: move は x±px または y±px を1つ以上指定してください`);
      if (index < args.length) {
        if (index + 2 !== args.length || getArgStr(index) !== 'over' || expressionType(args[index + 1], variables, ctx) !== 'int') throw new TypeCheckError(`${locStr}: 移動時間は over <int> で指定してください`);
        checkDuration(args[index + 1], variables, ctx, locStr, 'move の時間');
      }
      break;
    }
    case 'hide': {
      if (!args.length) throw new TypeCheckError(`${locStr}: hide は hide <character> [fade <int>] で指定してください`);
      const charName = getArgStr(0);
      if (!ctx.characters.has(charName)) throw new TypeCheckError(`${locStr}: 未定義のキャラクター '${charName}' です`);
      checkFade(args.slice(1), variables, ctx, locStr);
      break;
    }
    case 'clear': {
      if (args.length < 1) throw new TypeCheckError(`${locStr}: clear の対象を指定してください`);
      const target = getArgStr(0);
      if (args.length !== (target === 'image' ? 2 : 1)) throw new TypeCheckError(`${locStr}: clear の引数が不正です`);
      if (target === 'image' && ctx.assets.get(getArgStr(1))?.type !== 'image') throw new TypeCheckError(`${locStr}: 未定義の画像です`);
      if (!['bg', 'bgm', 'image'].includes(target)) throw new TypeCheckError(`${locStr}: clear の対象 '${target}' が不正です`);
      break;
    }
    case 'wait': {
      if (args.length !== 1) throw new TypeCheckError(`${locStr}: wait は時間を1つ指定してください`);
      const waitType = expressionType(args[0], variables, ctx);
      checkDuration(args[0], variables, ctx, locStr, 'wait の時間');
      if (waitType !== 'int') throw new TypeCheckError(`${locStr}: wait の引数は int でなければなりません`);
      break;
    }
    case 'effect': {
      if (args[2] && expressionType(args[2], variables, ctx) === 'int') checkDuration(args[2], variables, ctx, locStr, 'effect の時間');
      if (args.length > 3 || args.length < 2 || getArgStr(0) !== 'fade') throw new TypeCheckError(`${locStr}: effect は effect fade <color> [<ms>] を指定してください`);
      if (!['black', 'white'].includes(getArgStr(1))) throw new TypeCheckError(`${locStr}: fade の色が不正です`);
      if (args[2] && expressionType(args[2], variables, ctx) !== 'int') throw new TypeCheckError(`${locStr}: 演出時間は int です`);
      break;
    }
    case 'say': {
      if (args.length !== 2 && args.length !== 4) throw new TypeCheckError(`${locStr}: say は話者、本文、必要なら opacity <float> を指定してください`);
      const speaker = getArgStr(0);
      if (speaker !== 'narrator' && speaker !== 'none' && !ctx.characters.has(speaker)) {
        throw new TypeCheckError(`${locStr}: 未定義の話者 '${speaker}' です`);
      }
      const textType = expressionType(args[1], variables, ctx);
      if (textType !== 'str') throw new TypeCheckError(`${locStr}: say の本文は str でなければなりません`);
      if (args.length === 4) {
        if (getArgStr(2) !== 'opacity' || expressionType(args[3], variables, ctx) !== 'float') throw new TypeCheckError(`${locStr}: say opacity は float で指定してください`);
        const value = staticValue(args[3], ctx.knownNumbers);
        if (typeof value === 'number' && (value < 0 || value > 1)) throw new TypeCheckError(`${locStr}: say opacity は 0.0 から 1.0 の範囲です`);
      }
      break;
    }
    default: throw new TypeCheckError(`${locStr}: 未知の命令 '${name}' です`);
  }
}

type StaticValue = bigint | number | string | boolean;

function staticValue(expression: Expr, knownNumbers?: ReadonlyMap<string, bigint | number>): StaticValue | undefined {
  if (expression.kind === 'variable') return knownNumbers?.get(expression.name);
  if (expression.kind === 'float') {
    const value = Number(expression.value);
    return Number.isFinite(value) ? value : undefined;
  }
  if (expression.kind === 'literal') return typeof expression.value === 'string' || typeof expression.value === 'boolean' ? expression.value : BigInt(expression.value);
  if (expression.kind === 'call') {
    const argument = expression.args.length === 1 ? staticValue(expression.args[0], knownNumbers) : undefined;
    if (expression.name === 'str' && typeof argument === 'bigint') return String(argument);
    if (expression.name === 'int' && typeof argument === 'string' && /^[+-]?\d+$/.test(argument)) return BigInt(argument);
    if (expression.name === 'int' && typeof argument === 'number' && Number.isFinite(argument)) return BigInt(Math.trunc(argument));
    if (expression.name === 'float') {
      if (typeof argument === 'string' && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(argument)) return undefined;
      const value = typeof argument === 'string' || typeof argument === 'bigint' || typeof argument === 'number' ? Number(argument) : NaN;
      return Number.isFinite(value) ? value : undefined;
    }
    return undefined;
  }
  if (expression.kind === 'unary') {
    const value = staticValue(expression.value, knownNumbers);
    if (expression.operator === 'not' && typeof value === 'boolean') return !value;
    if ((expression.operator === '+' || expression.operator === '-') && typeof value === 'bigint') return expression.operator === '-' ? -value : value;
    if ((expression.operator === '+' || expression.operator === '-') && typeof value === 'number') return expression.operator === '-' ? -value : value;
    return undefined;
  }
  if (expression.kind !== 'binary') return undefined;
  const left = staticValue(expression.left, knownNumbers);
  if (expression.operator === 'and' && typeof left === 'boolean') return left ? staticValue(expression.right, knownNumbers) : false;
  if (expression.operator === 'or' && typeof left === 'boolean') return left ? true : staticValue(expression.right, knownNumbers);
  const right = staticValue(expression.right, knownNumbers);
  if (left === undefined || right === undefined) return undefined;
  if (expression.operator === '==') return left === right;
  if (expression.operator === '!=') return left !== right;
  if (typeof left === 'bigint' && typeof right === 'bigint') {
    if (expression.operator === '>') return left > right;
    if (expression.operator === '>=') return left >= right;
    if (expression.operator === '<') return left < right;
    if (expression.operator === '<=') return left <= right;
    if (expression.operator === '+') return left + right;
    if (expression.operator === '-') return left - right;
    if (expression.operator === '*') return left * right;
    if (expression.operator === '/' && right !== 0n) return left / right;
    if (expression.operator === '%' && right !== 0n) return left % right;
  }
  if (typeof left === 'number' && typeof right === 'number') {
    if (expression.operator === '>') return left > right;
    if (expression.operator === '>=') return left >= right;
    if (expression.operator === '<') return left < right;
    if (expression.operator === '<=') return left <= right;
    const value = expression.operator === '+' ? left + right : expression.operator === '-' ? left - right
      : expression.operator === '*' ? left * right : expression.operator === '/' && right !== 0 ? left / right : undefined;
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  }
  if (expression.operator === '+' && typeof left === 'string' && typeof right === 'string') return left + right;
  return undefined;
}

function alwaysTrueCondition(expression: Expr): boolean {
  return staticValue(expression) === true;
}

function staticallyRunsFor(statement: Extract<Statement, { kind: 'for' }>): boolean {
  const start = staticValue(statement.start);
  const stop = staticValue(statement.stop);
  const step = staticValue(statement.step);
  if (typeof start !== 'bigint' || typeof stop !== 'bigint' || typeof step !== 'bigint' || step === 0n) return false;
  return !((start < stop && step < 0n) || (start > stop && step > 0n));
}

function exitsBlock(statements: Statement[]): boolean {
  return statements.some((statement) => {
    if (statement.kind === 'return' || statement.kind === 'goto') return true;
    if (statement.kind === 'if') {
      return statement.otherwise.length > 0
        && exitsBlock(statement.body)
        && statement.elseIf.every((branch) => exitsBlock(branch.body))
        && exitsBlock(statement.otherwise);
    }
    if (statement.kind === 'while') return alwaysTrueCondition(statement.condition.expression) && exitsBlock(statement.body);
    if (statement.kind === 'for') return staticallyRunsFor(statement) && exitsBlock(statement.body);
    if (statement.kind === 'choice') return statement.options.length > 0 && statement.options.every((option) => exitsBlock(option.body));
    return false;
  });
}

function checkStatements(
  statements: Statement[],
  variables: Map<string, ValueType>,
  ctx: TypeContext,
  options: { allowGoto: boolean; allowChoice: boolean; allowReturn: boolean; allowDeclaration: boolean }
): void {
  for (const statement of statements) {
    const locStr = getLocStr(statement);
    try {

    if (statement.kind === 'declare') {
      if (statement.global && ctx.locals) {
        throw new TypeCheckError(`${locStr}: global 宣言はファイルのトップレベルでのみ使用できます`);
      }
      if (!options.allowDeclaration) {
        throw new TypeCheckError(`${locStr}: 型エラー (${ctx.file}): scene 直下での変数宣言は禁止されています（選択肢ブロック内またはグローバルで宣言してください）`);
      }
      const duplicateLocal = ctx.declaredLocals?.has(statement.name) || ctx.locals?.has(statement.name) || false;
      const shadowsScenarioVariable = variables.has(statement.name) && !ctx.currentFunction;
      if (duplicateLocal || shadowsScenarioVariable) {
        throw new TypeCheckError(`${locStr}: 型エラー (${ctx.file}): 変数 '${statement.name}' は既に宣言されています。再宣言せず set を使用してください`);
      }
      if (statement.initial) {
        const actual = expressionType(statement.initial, variables, ctx, statement.type === 'infer' ? undefined : statement.type);
        if (typeof statement.type !== 'string' && statement.type.kind === 'struct') {
          const fields = ctx.structs.get(statement.type.name);
          if (!fields) throw new TypeCheckError(`${locStr}: 未定義のstruct '${statement.type.name}' です`);
          if (statement.initial.kind !== 'dict') throw new TypeCheckError(`${locStr}: struct の初期値はフィールド付きオブジェクトで指定してください`);
          const keys = new Set(statement.initial.entries.map((e) => e.key));
          for (const [field, fieldType] of Object.entries(fields)) {
            const entry = statement.initial.entries.find((e) => e.key === field);
            if (!entry) throw new TypeCheckError(`${locStr}: struct '${statement.type.name}' のフィールド '${field}' が不足しています`);
            if (expressionType(entry.value, variables, ctx) !== fieldType) throw new TypeCheckError(`${locStr}: フィールド '${field}' の型が一致しません`);
          }
          for (const key of keys) if (!fields[key]) throw new TypeCheckError(`${locStr}: struct '${statement.type.name}' にフィールド '${key}' はありません`);
        }
        if (statement.type === 'infer') {
          if (actual === 'none') {
            throw new TypeCheckError(`${locStr}: 型エラー (${ctx.file}): let '${statement.name}' の型を ${typeName(actual)} から推論できません`);
          }
          if (statement.initial.kind === 'dict' && statement.initial.entries.length === 0) {
            throw new TypeCheckError(`${locStr}: 型エラー (${ctx.file}): 空の辞書は型を推論できません。dict[int] または dict[str] を指定してください`);
          }
          statement.type = actual;
        }
        if ((typeof statement.type === 'string' || statement.type.kind === 'dict' || statement.type.kind === 'list') && !sameType(statement.type, actual)) {
          throw new TypeCheckError(`${locStr}: 型エラー (${ctx.file}): ${statement.name} は ${typeName(statement.type)} ですが、${typeName(actual)} が代入されています`);
        }
      }
      if (statement.type === 'infer') {
        throw new TypeCheckError(`${locStr}: 型エラー (${ctx.file}): let '${statement.name}' には初期値が必要です`);
      }
      variables.set(statement.name, statement.type);
      // A local declaration may shadow a file-level constant. Drop the
      // inherited numeric fact unless a scoped local evaluator can prove it.
      if (ctx.locals) {
        ctx.knownNumbers?.delete(statement.name);
        if (statement.constant && statement.initial) {
          const numeric = staticValue(statement.initial, ctx.knownNumbers);
          if (typeof numeric === 'bigint' || typeof numeric === 'number' && Number.isFinite(numeric)) ctx.knownNumbers?.set(statement.name, numeric);
        }
      }
      ctx.ambiguous?.delete(statement.name);
      ctx.declaredLocals?.add(statement.name);
      ctx.readonly?.delete(statement.name);
      if (statement.constant) ctx.readonly?.add(statement.name);
      ctx.locals?.add(statement.name);
      if (ctx.knownStrings) {
        const initialString = statement.type === 'str' ? knownStringValue(statement.initial, ctx.knownStrings) : undefined;
        if (initialString !== undefined) ctx.knownStrings.set(statement.name, initialString);
        else ctx.knownStrings.delete(statement.name);
      }
    }

    if (statement.kind === 'set') {
      if (statement.target.kind === 'variable' && ctx.ambiguous?.has(statement.target.name)) {
        throw new TypeCheckError(`${locStr}: 蝙九お繝ｩ繧ｼ繝ｼ (${ctx.file}): 蛻・ｲ舌�螟画焚 '${statement.target.name}' 縺ｮ蝙九′蜿門ｾ励〒縺阪∪縺帙ｓ`);
      }
      const expected = statement.target.kind === 'variable' ? variables.get(statement.target.name) : expressionType(statement.target, variables, ctx);
      const exprType = expressionType(statement.value, variables, ctx, expected === 'bool' ? undefined : expected);
      if (statement.target.kind === 'variable') {
        if (ctx.readonly?.has(statement.target.name)) {
          throw new TypeCheckError(`${locStr}: 型エラー (${ctx.file}): const 変数 '${statement.target.name}' は変更できません`);
        }
        const varType = variables.get(statement.target.name);
        if (!varType) {
          throw new TypeCheckError(`${locStr}: 型エラー (${ctx.file}): 未定義の変数 '${statement.target.name}' への代入です`);
        }
        if (!sameType(varType, exprType)) {
          throw new TypeCheckError(`${locStr}: 型エラー (${ctx.file}): 変数 '${statement.target.name}' (${typeName(varType)}) に ${typeName(exprType)} は代入できません`);
        }
        ctx.knownNumbers?.delete(statement.target.name);
        if (ctx.knownStrings) {
          const varType = variables.get(statement.target.name);
          const assignedString = varType === 'str' ? knownStringValue(statement.value, ctx.knownStrings) : undefined;
          if (assignedString !== undefined) ctx.knownStrings.set(statement.target.name, assignedString);
          else ctx.knownStrings.delete(statement.target.name);
        }
      } else if (statement.target.kind === 'index') {
        if (statement.target.target.kind === 'variable' && ctx.readonly?.has(statement.target.target.name)) {
          throw new TypeCheckError(`${locStr}: 型エラー (${ctx.file}): const 変数 '${statement.target.target.name}' の要素は変更できません`);
        }
        const targetType = expressionType(statement.target.target, variables, ctx);
        const keyType = expressionType(statement.target.key, variables, ctx);
        if (typeof targetType !== 'string' && targetType.kind === 'struct' && statement.target.key.kind === 'literal' && typeof statement.target.key.value === 'string') {
          const fieldType = ctx.structs.get(targetType.name)?.[statement.target.key.value];
          if (!fieldType) throw new TypeCheckError(`${locStr}: struct フィールドが存在しません`);
          if (keyType !== 'str' || !sameType(fieldType, exprType)) throw new TypeCheckError(`${locStr}: struct フィールドの型が一致しません`);
        } else if (typeof targetType !== 'string' && targetType.kind === 'list') {
          if (keyType !== 'int' || !sameType(targetType.value, exprType)) throw new TypeCheckError(`${locStr}: list assignment requires an integer index and matching element type`);
        } else {
        if (typeof targetType === 'string' || targetType.kind !== 'dict') {
          throw new TypeCheckError(`${locStr}: 型エラー (${ctx.file}): 代入対象は辞書型でなければなりません`);
        }
        if (keyType !== 'str') {
          throw new TypeCheckError(`${locStr}: 型エラー (${ctx.file}): 辞書のキーは str でなければなりません`);
        }
        if (!sameType(targetType.value, exprType)) {
          throw new TypeCheckError(`${locStr}: 型エラー (${ctx.file}): 辞書要素 (${targetType.value}) に ${typeName(exprType)} は代入できません`);
        }
        }
      }
    }

    if (statement.kind === 'unset') {
      if (statement.target.kind === 'variable') {
        throw new TypeCheckError(`${locStr}: unset は辞書要素を指定してください`);
      } else if (statement.target.kind === 'index') {
        if (statement.target.target.kind === 'variable' && ctx.readonly?.has(statement.target.target.name)) throw new TypeCheckError(`${locStr}: const 変数 '${statement.target.target.name}' の要素は変更できません`);
        const targetType = expressionType(statement.target.target, variables, ctx);
        const keyType = expressionType(statement.target.key, variables, ctx);
        if (typeof targetType === 'string' || targetType.kind !== 'dict' || keyType !== 'str') {
          throw new TypeCheckError(`${locStr}: 型エラー (${ctx.file}): unset の対象が不正です`);
        }
      }
    }

    if (statement.kind === 'command') {
      checkCommand(statement.name, statement.args, variables, ctx, locStr);
    }

    if (statement.kind === 'if') {
      checkCondition(statement.condition.expression, variables, ctx);
      const baseNames = new Set(variables.keys());
      const branchVariables: Map<string, ValueType>[] = [];
      const branchReadonly: Set<string>[] = [];
      const branchStrings: Map<string, string>[] = [];
      const branchNumbers: Array<Map<string, bigint | number>> = [];
      const branchStates: Array<{ variables: Map<string, ValueType>; readonly: Set<string>; strings: Map<string, string>; numbers: Map<string, bigint | number>; locals?: Set<string>; declaredLocals?: Set<string>; ambiguous?: Set<string>; fallsThrough: boolean }> = [];
      const checkBranch = (body: Statement[]) => {
        const branch = new Map(variables);
        const readonly = new Set(ctx.readonly);
        const strings = new Map(ctx.knownStrings);
        const numbers = new Map(ctx.knownNumbers);
        const locals = ctx.locals ? new Set(ctx.locals) : undefined;
        const declaredLocals = ctx.declaredLocals ? new Set(ctx.declaredLocals) : undefined;
        const ambiguous = ctx.ambiguous ? new Set(ctx.ambiguous) : undefined;
        checkStatements(body, branch, { ...ctx, locals, declaredLocals, readonly, knownStrings: strings, knownNumbers: numbers, ambiguous }, options);
        const fallsThrough = !exitsBlock(body);
        branchStates.push({ variables: branch, readonly, strings, numbers, locals, declaredLocals, ambiguous, fallsThrough });
        if (fallsThrough) { branchVariables.push(branch); branchReadonly.push(readonly); branchStrings.push(strings); branchNumbers.push(numbers); }
      };
      checkBranch(statement.body);
      for (const branch of statement.elseIf) {
        checkCondition(branch.condition.expression, variables, ctx);
        checkBranch(branch.body);
      }
      if (statement.otherwise.length) checkBranch(statement.otherwise);
      else {
        const variablesAfterIf = new Map(variables);
        const readonlyAfterIf = new Set(ctx.readonly);
        const stringsAfterIf = new Map(ctx.knownStrings);
        const numbersAfterIf = new Map(ctx.knownNumbers);
        const localsAfterIf = ctx.locals ? new Set(ctx.locals) : undefined;
        const declaredLocalsAfterIf = ctx.declaredLocals ? new Set(ctx.declaredLocals) : undefined;
        const ambiguousAfterIf = ctx.ambiguous ? new Set(ctx.ambiguous) : undefined;
        branchStates.push({ variables: variablesAfterIf, readonly: readonlyAfterIf, strings: stringsAfterIf, numbers: numbersAfterIf, locals: localsAfterIf, declaredLocals: declaredLocalsAfterIf, ambiguous: ambiguousAfterIf, fallsThrough: true });
        branchVariables.push(variablesAfterIf); branchReadonly.push(readonlyAfterIf); branchStrings.push(stringsAfterIf); branchNumbers.push(numbersAfterIf);
      }

      if (ctx.declaredLocals) for (const branch of branchStates) branch.declaredLocals?.forEach((name) => ctx.declaredLocals!.add(name));

      // A literal condition makes only one branch reachable. Keep checking all
      // branches for diagnostics, but use the reachable branch's bindings for
      // every statement that follows the if. This is especially important for
      // function-local declarations shadowing a global with another type.
      const conditions = [statement.condition.expression, ...statement.elseIf.map((branch) => branch.condition.expression)];
      let selectedBranch: number | undefined;
      let staticallySelected = true;
      for (let index = 0; index < conditions.length; index += 1) {
        const value = staticValue(conditions[index]);
        if (value === true) { selectedBranch = index; break; }
        if (value !== false) { staticallySelected = false; break; }
      }
      if (staticallySelected) {
        if (selectedBranch === undefined) selectedBranch = statement.otherwise.length ? conditions.length : conditions.length;
        const selected = branchStates[selectedBranch];
        if (selected?.fallsThrough) {
          variables.clear();
          for (const [name, type] of selected.variables) variables.set(name, type);
          if (ctx.readonly) { ctx.readonly.clear(); selected.readonly.forEach((name) => ctx.readonly!.add(name)); }
          if (ctx.knownStrings) { ctx.knownStrings.clear(); selected.strings.forEach((value, name) => ctx.knownStrings!.set(name, value)); }
          if (ctx.knownNumbers) { ctx.knownNumbers.clear(); selected.numbers.forEach((value, name) => ctx.knownNumbers!.set(name, value)); }
          if (ctx.locals && selected.locals) { ctx.locals.clear(); selected.locals.forEach((name) => ctx.locals!.add(name)); }
          if (ctx.ambiguous && selected.ambiguous) { ctx.ambiguous.clear(); selected.ambiguous.forEach((name) => ctx.ambiguous!.add(name)); }
        }
        continue;
      }
      const candidates = [...(branchVariables[0]?.keys() || [])].filter((name) => !baseNames.has(name));
      for (const name of candidates) {
        const types = branchVariables.map((branch) => branch.get(name));
        if (types.some((type) => type === undefined)) continue;
        if (types.some((type) => !sameType(types[0]!, type!))) {
          throw new TypeCheckError(`${locStr}: 型エラー (${ctx.file}): 分岐ごとに変数 '${name}' の型が一致していません`);
        }
        variables.set(name, types[0]!);
        if (branchReadonly.some((readonly) => readonly.has(name))) ctx.readonly?.add(name);
        ctx.locals?.add(name);
      }
      const fallthroughStates = branchStates.filter((branch) => branch.fallsThrough);
      const ambiguousBeforeIf = new Set(ctx.ambiguous || []);
      const existingNames = new Set(branchVariables.flatMap((branch) => [...branch.keys()].filter((name) => baseNames.has(name))));
      for (const name of existingNames) {
        const types = branchVariables.map((branch) => branch.get(name));
        if (types.some((type) => type === undefined)) continue;
        if (types.some((type) => !sameType(types[0]!, type!))) {
          if (fallthroughStates.some((branch) => branch.readonly.has(name))) ctx.readonly?.add(name);
          ctx.ambiguous?.add(name);
          continue;
        }
        if (fallthroughStates.some((branch) => branch.ambiguous?.has(name))) {
          if (fallthroughStates.some((branch) => branch.readonly.has(name))) ctx.readonly?.add(name);
          ctx.ambiguous?.add(name);
          continue;
        }
        variables.set(name, types[0]!);
        if (fallthroughStates.every((branch) => branch.readonly.has(name))) ctx.readonly?.add(name);
        else if (fallthroughStates.every((branch) => !branch.readonly.has(name))) ctx.readonly?.delete(name);
        else ctx.readonly?.add(name);
        const definitelyLocal = !!ctx.locals && fallthroughStates.length > 0 && fallthroughStates.every((branch) => branch.locals?.has(name));
        if (definitelyLocal) ctx.locals?.add(name);
        if (!ambiguousBeforeIf.has(name) || definitelyLocal) ctx.ambiguous?.delete(name);
      }
      if (ctx.knownStrings) {
        const names = new Set(branchStrings.flatMap((strings) => [...strings.keys()]));
        for (const name of names) {
          const first = branchStrings[0]?.get(name);
          if (first !== undefined && branchStrings.every((strings) => strings.get(name) === first)) ctx.knownStrings.set(name, first);
          else ctx.knownStrings.delete(name);
        }
        for (const name of [...ctx.knownStrings.keys()]) if (!branchStrings.every((strings) => strings.has(name) && strings.get(name) === ctx.knownStrings!.get(name))) ctx.knownStrings.delete(name);
      }
      if (ctx.knownNumbers) {
        const names = new Set(branchNumbers.flatMap((numbers) => [...numbers.keys()]));
        for (const name of names) {
          const first = branchNumbers[0]?.get(name);
          if (first !== undefined && branchNumbers.every((numbers) => numbers.get(name) === first)) ctx.knownNumbers.set(name, first);
          else ctx.knownNumbers.delete(name);
        }
        for (const name of [...ctx.knownNumbers.keys()]) if (!branchNumbers.every((numbers) => numbers.has(name) && numbers.get(name) === ctx.knownNumbers!.get(name))) ctx.knownNumbers.delete(name);
      }
    }

    if (statement.kind === 'for') {
      const startType = expressionType(statement.start, variables, ctx);
      const stopType = expressionType(statement.stop, variables, ctx);
      const stepType = expressionType(statement.step, variables, ctx);
      if (startType !== 'int' || stopType !== 'int' || stepType !== 'int') {
        throw new TypeCheckError(`${locStr}: 型エラー (${ctx.file}): for ループの範囲指定は int でなければなりません`);
      }
      const loopVars = new Map(variables);
      loopVars.set(statement.name, 'int');
      const loopReadonly = new Set(ctx.readonly); loopReadonly.delete(statement.name);
      const loopLocals = new Set(ctx.locals || variables.keys()); loopLocals.add(statement.name);
      const loopDeclaredLocals = ctx.declaredLocals ? new Set(ctx.declaredLocals) : undefined;
      const loopAmbiguous = ctx.ambiguous ? new Set(ctx.ambiguous) : undefined;
      const loopNumbers = new Map(ctx.knownNumbers);
      loopNumbers.delete(statement.name);
      checkStatements(statement.body, loopVars, { ...ctx, locals: loopLocals, declaredLocals: loopDeclaredLocals, readonly: loopReadonly, knownStrings: new Map(ctx.knownStrings), knownNumbers: loopNumbers, ambiguous: loopAmbiguous }, options);
      if (ctx.declaredLocals) loopDeclaredLocals?.forEach((name) => ctx.declaredLocals!.add(name));
      ctx.knownStrings?.clear();
      // A dynamic range may execute zero times, so declarations made only in
      // the body are not definitely initialized after the loop. Merge them
      // only when a literal range is known to execute at least once and the
      // body itself can fall through.
      const guaranteedRun = staticallyRunsFor(statement) && !exitsBlock(statement.body);
      for (const [name, type] of variables) {
        if (name === statement.name) continue;
        const loopType = loopVars.get(name);
        if (!loopType) continue;
        if (guaranteedRun) {
          if (!loopAmbiguous?.has(name) && !sameType(type, loopType)) variables.set(name, loopType);
          if (loopReadonly.has(name)) ctx.readonly?.add(name); else ctx.readonly?.delete(name);
        } else {
          if (loopAmbiguous?.has(name) || !sameType(type, loopType)) ctx.ambiguous?.add(name);
          if (loopReadonly.has(name) || ctx.readonly?.has(name)) ctx.readonly?.add(name);
          else ctx.readonly?.delete(name);
        }
      }
      if (guaranteedRun) {
        for (const [name, type] of loopVars) if (name !== statement.name && !variables.has(name)) { variables.set(name, type); ctx.locals?.add(name); if (loopReadonly.has(name)) ctx.readonly?.add(name); }
      }
    }

    if (statement.kind === 'forEach') {
      const iterableType = expressionType(statement.iterable, variables, ctx);
      if (typeof iterableType === 'string' || iterableType.kind !== 'list') throw new TypeCheckError(`${locStr}: for name in values の values はlist型である必要があります`);
      const loopVars = new Map(variables);
      loopVars.set(statement.name, iterableType.value);
      const loopReadonly = new Set(ctx.readonly); loopReadonly.delete(statement.name);
      const loopLocals = new Set(ctx.locals || variables.keys()); loopLocals.add(statement.name);
      const loopDeclaredLocals = ctx.declaredLocals ? new Set(ctx.declaredLocals) : undefined;
      const loopAmbiguous = ctx.ambiguous ? new Set(ctx.ambiguous) : undefined;
      checkStatements(statement.body, loopVars, { ...ctx, locals: loopLocals, declaredLocals: loopDeclaredLocals, readonly: loopReadonly, knownStrings: new Map(ctx.knownStrings), knownNumbers: new Map(ctx.knownNumbers), ambiguous: loopAmbiguous }, options);
      if (ctx.declaredLocals) loopDeclaredLocals?.forEach(name => ctx.declaredLocals!.add(name));
      ctx.knownStrings?.clear();
      ctx.knownNumbers?.clear();
      continue;
    }

    if (statement.kind === 'while') {
      checkCondition(statement.condition.expression, variables, ctx);
      const loopVars = new Map(variables);
      const loopReadonly = ctx.readonly ? new Set(ctx.readonly) : new Set<string>();
      const loopDeclaredLocals = ctx.declaredLocals ? new Set(ctx.declaredLocals) : undefined;
      const loopAmbiguous = ctx.ambiguous ? new Set(ctx.ambiguous) : undefined;
      checkStatements(statement.body, loopVars, { ...ctx, locals: ctx.locals ? new Set(ctx.locals) : undefined, declaredLocals: loopDeclaredLocals, readonly: loopReadonly, knownStrings: new Map(ctx.knownStrings), knownNumbers: new Map(ctx.knownNumbers), ambiguous: loopAmbiguous }, options);
      if (ctx.declaredLocals) loopDeclaredLocals?.forEach((name) => ctx.declaredLocals!.add(name));
      // A dynamic while may execute zero times, but when it does execute its
      // declarations remain in the function frame. Reject a post-loop use
      // whose type or mutability would depend on that choice.
      if (staticValue(statement.condition.expression) === undefined) {
        for (const [name, type] of variables) {
          const loopType = loopVars.get(name);
          if (!loopType) continue;
          if (loopAmbiguous?.has(name) || !sameType(type, loopType)) ctx.ambiguous?.add(name);
          if (loopReadonly.has(name) || ctx.readonly?.has(name)) ctx.readonly?.add(name);
          else ctx.readonly?.delete(name);
        }
      }
      ctx.knownStrings?.clear();
    }

    if (statement.kind === 'choice') {
      if (!options.allowChoice) {
        throw new TypeCheckError(`${locStr}: 型エラー (${ctx.file}): 関数内で choice は使用できません`);
      }
      if (!statement.options.length) throw new TypeCheckError(`${locStr}: choice には1つ以上の選択肢が必要です`);
      if (statement.prompt) {
        const promptType = expressionType(statement.prompt, variables, ctx);
        if (promptType !== 'str') throw new TypeCheckError(`${locStr}: choice の質問文は str でなければなりません`);
      }
      for (const option of statement.options) {
        const labelType = expressionType(option.label, variables, ctx);
        if (labelType !== 'str') throw new TypeCheckError(`${locStr}: 選択肢のラベルは str でなければなりません`);
        // choice ブロック内では変数宣言を許可
         checkStatements(option.body, new Map(variables), { ...ctx, locals: new Set(), declaredLocals: new Set(), readonly: ctx.readonly ? new Set(ctx.readonly) : undefined, knownStrings: new Map(ctx.knownStrings), knownNumbers: new Map(ctx.knownNumbers) }, { ...options, allowDeclaration: true });
      }
      ctx.knownStrings?.clear();
    }

    if (statement.kind === 'call') {
      expressionType({ kind: 'call', name: statement.name, args: statement.args, line: statement.line, column: statement.column }, variables, ctx);
    }

    if (statement.kind === 'return') {
      if (!options.allowReturn || !ctx.currentFunction) {
        throw new TypeCheckError(`${locStr}: 型エラー (${ctx.file}): return は関数内でのみ使用できます`);
      }
      const expectedReturn = ctx.currentFunction.returnType;
      if (expectedReturn === 'none') {
        if (statement.value) throw new TypeCheckError(`${locStr}: 型エラー (${ctx.file}): none 型の関数は値を返せません`);
      } else {
        if (!statement.value) throw new TypeCheckError(`${locStr}: 型エラー (${ctx.file}): 値を返す必要があります`);
        const actualReturn = expressionType(statement.value, variables, ctx, expectedReturn);
        if (!sameType(expectedReturn, actualReturn)) {
          throw new TypeCheckError(`${locStr}: 型エラー (${ctx.file}): 戻り値の型が一致しません (期待: ${typeName(expectedReturn)}, 実際: ${typeName(actualReturn)})`);
        }
      }
    }

    if (statement.kind === 'goto') {
      if (!options.allowGoto) {
        throw new TypeCheckError(`${locStr}: 型エラー (${ctx.file}): 関数内で goto は使用できません`);
      }
      // 同一ファイル内シーンまたは外部ファイル
      const target = statement.scene;
      if (!target.includes('/') && !/\.(tds|txt)$/i.test(target) && !ctx.scenes.has(target)) {
        throw new TypeCheckError(`${locStr}: 型エラー (${ctx.file}): 存在しないシーン '${target}' への goto です`);
      }
    }
    } catch (error) {
      if (!ctx.errors || !(error instanceof TypeCheckError)) throw error;
      error.file = statement.file || ctx.file;
      const location = error.message.match(/line\s+(\d+)\s*,\s*column\s+(\d+)/i);
      error.line ??= Number(location?.[1]) || statement.line || 1;
      error.column ??= Number(location?.[2]) || statement.column || 1;
      ctx.errors.push(error);
    }
  }
}

function staticGlobalStrings(statements: Statement[]): Map<string, string> {
  const known = new Map<string, string>();
  for (const statement of statements) {
    if (statement.kind === 'declare') {
      const value = knownStringValue(statement.initial, known);
      if (typeof value === 'string') known.set(statement.name, value); else known.delete(statement.name);
    } else if (statement.kind === 'set' && statement.target.kind === 'variable') {
      const value = knownStringValue(statement.value, known);
      if (typeof value === 'string') known.set(statement.target.name, value); else known.delete(statement.target.name);
    } else if (statement.kind === 'call' || statement.kind === 'command' || statement.kind === 'goto'
      || statement.kind === 'if' || statement.kind === 'for' || statement.kind === 'forEach' || statement.kind === 'while' || statement.kind === 'choice') {
      // A control-flow transfer or call can change a global string before the
      // function runs. Keep recursion analysis sound by discarding stale facts.
      known.clear();
    }
  }
  return known;
}

function checkRecursion(functions: FunctionDef[], initialStrings = new Map<string, string>()): void {
  const callGraph = new Map<string, Set<string>>();
  for (const fn of functions) {
    const called = new Set<string>();
    const inspectTemplate = (value: string): void => {
      for (const path of interpolationNames(value)) if (path.endsWith('()')) called.add(path.slice(0, -2));
    };
    const visitExpr = (e: Expr, knownStrings: Map<string, string>) => {
      if (e.kind === 'literal' && typeof e.value === 'string') {
        inspectTemplate(e.value);
      }
      if (e.kind === 'variable') {
        const value = knownStrings.get(e.name);
        if (value !== undefined) inspectTemplate(value);
      }
      if (e.kind === 'call') { called.add(e.name); e.args.forEach((arg) => visitExpr(arg, knownStrings)); }
      if (e.kind === 'binary') {
        visitExpr(e.left, knownStrings); visitExpr(e.right, knownStrings);
        const value = knownStringValue(e, knownStrings);
        if (value !== undefined) inspectTemplate(value);
      }
      if (e.kind === 'unary') visitExpr(e.value, knownStrings);
      if (e.kind === 'index') { visitExpr(e.target, knownStrings); visitExpr(e.key, knownStrings); }
      if (e.kind === 'dict') e.entries.forEach((ent) => visitExpr(ent.value, knownStrings));
      if (e.kind === 'list') e.items.forEach((item) => visitExpr(item, knownStrings));
    };
    const visitBlock = (statements: Statement[], knownStrings: Map<string, string>): void => {
      statements.forEach((statement) => visitStmt(statement, knownStrings));
    };
    const mergeKnownStrings = (target: Map<string, string>, paths: Map<string, string>[]): void => {
      for (const name of [...target.keys()]) {
        const value = paths[0]?.get(name);
        if (value === undefined || paths.some((path) => path.get(name) !== value)) target.delete(name);
      }
      for (const [name, value] of paths[0] || []) if (paths.every((path) => path.get(name) === value)) target.set(name, value);
    };
    const visitStmt = (s: Statement, knownStrings: Map<string, string>): void => {
      if (s.kind === 'call') { called.add(s.name); s.args.forEach((arg) => visitExpr(arg, knownStrings)); }
      if (s.kind === 'declare' && s.initial) {
        visitExpr(s.initial, knownStrings);
        const value = knownStringValue(s.initial, knownStrings);
        if (typeof value === 'string') knownStrings.set(s.name, value); else knownStrings.delete(s.name);
      }
      if (s.kind === 'set') {
        visitExpr(s.value, knownStrings);
        if (s.target.kind === 'index') { visitExpr(s.target.target, knownStrings); visitExpr(s.target.key, knownStrings); }
        if (s.target.kind === 'variable') {
          const value = knownStringValue(s.value, knownStrings);
          if (typeof value === 'string') knownStrings.set(s.target.name, value); else knownStrings.delete(s.target.name);
        }
      }
      if (s.kind === 'command') s.args.forEach((arg) => visitExpr(arg, knownStrings));
      if (s.kind === 'unset') visitExpr(s.target, knownStrings);
      if (s.kind === 'if') {
        visitExpr(s.condition.expression, knownStrings);
        const paths = [s.body, ...s.elseIf.map((branch) => branch.body), s.otherwise].map((body) => {
          const path = new Map(knownStrings); visitBlock(body, path); return path;
        });
        mergeKnownStrings(knownStrings, paths);
      }
      if (s.kind === 'for') {
        visitExpr(s.start, knownStrings); visitExpr(s.stop, knownStrings); visitExpr(s.step, knownStrings);
        visitBlock(s.body, new Map(knownStrings));
        knownStrings.clear();
      }
      if (s.kind === 'forEach') {
        visitExpr(s.iterable, knownStrings);
        visitBlock(s.body, new Map(knownStrings));
        knownStrings.clear();
      }
      if (s.kind === 'while') {
        visitExpr(s.condition.expression, knownStrings);
        visitBlock(s.body, new Map(knownStrings));
        knownStrings.clear();
      }
      if (s.kind === 'choice') {
        if (s.prompt) visitExpr(s.prompt, knownStrings);
        const paths = s.options.map((option) => {
          visitExpr(option.label, knownStrings);
          const path = new Map(knownStrings); visitBlock(option.body, path); return path;
        });
        if (paths.length) mergeKnownStrings(knownStrings, paths);
      }
      if (s.kind === 'return' && s.value) visitExpr(s.value, knownStrings);
    };
    const functionStrings = new Map(initialStrings);
    fn.params.forEach((param) => functionStrings.delete(param.name));
    visitBlock(fn.body, functionStrings);
    callGraph.set(fn.name, called);
  }

  // サイクル検出 (DFS)
  const visited = new Set<string>();
  const recStack = new Set<string>();

  function dfs(node: string, path: string[]): void {
    visited.add(node);
    recStack.add(node);
    path.push(node);

    const neighbors = callGraph.get(node) || new Set();
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        dfs(neighbor, path);
      } else if (recStack.has(neighbor)) {
        throw new TypeCheckError(`関数の再帰呼び出しは禁止されています (${[...path, neighbor].join(' -> ')})`);
      }
    }
    recStack.delete(node);
    path.pop();
  }

  for (const fn of functions) {
    if (!visited.has(fn.name)) {
      dfs(fn.name, []);
    }
  }
}

export function checkTypes(script: Script, file = 'current', externalGlobals = new Map<string, ValueType>(), externalCharacters: ExternalCharacters = new Map(), errors?: TypeCheckError[]): void {
  // 1. 重複宣言チェック
  const declaredGlobals = new Set<string>();
  const declaredFunctions = new Set<string>();
  const declaredScenes = new Set<string>();
  const declaredStructs = new Set<string>();
  const declaredCharacters = new Set<string>(externalCharacters.keys());
  const declaredAssets = new Set<string>();
  const capture = (check: () => void): void => {
    try { check(); }
    catch (error) {
      if (!errors || !(error instanceof TypeCheckError)) throw error;
      errors.push(error);
    }
  };

  for (const name of externalCharacters.keys()) {
    capture(() => {
      if (externalGlobals.has(name)) throw new TypeCheckError(`character '${name}' とグローバル変数 '${name}' の名前が重複しています`);
    });
  }

  for (const struct of script.structs) {
    capture(() => {
      if (declaredStructs.has(struct.name)) throw new TypeCheckError(`${getLocStr(struct)}: struct '${struct.name}' が重複しています`);
      declaredStructs.add(struct.name);
      for (const [field, fieldType] of Object.entries(struct.fields)) {
        if (fieldType !== 'int' && fieldType !== 'float' && fieldType !== 'str' && fieldType !== 'bool') throw new TypeCheckError(`${getLocStr(struct)}: struct フィールド '${field}' の型が不正です`);
      }
    });
  }

  for (const asset of script.assets) {
    capture(() => {
    if (declaredAssets.has(asset.name)) {
      throw new TypeCheckError(`${getLocStr(asset)}: アセット '${asset.name}' が重複して宣言されています`);
    }
    // パス検証 (項目23)
    if (!validAssetPath(asset.path)) {
      throw new TypeCheckError(`${getLocStr(asset)}: アセットパス '${asset.path}' はプロジェクト外を参照できません`);
    }
    const dotIdx = asset.path.lastIndexOf('.');
    const ext = dotIdx >= 0 ? asset.path.slice(dotIdx).toLowerCase() : '';
    const allowed = ALLOWED_EXTENSIONS[asset.type] || [];
    if (!allowed.includes(ext)) {
      throw new TypeCheckError(`${getLocStr(asset)}: アセット '${asset.name}' (${asset.type}) の拡張子 '${ext}' は不正です`);
    }
    if (asset.volume !== undefined && (!['bgm', 'se', 'voice'].includes(asset.type) || !Number.isFinite(asset.volume) || asset.volume < 0 || asset.volume > 1)) {
      throw new TypeCheckError(`${getLocStr(asset)}: volume は音声アセットに限り 0.0 から 1.0 の範囲で指定できます`);
    }
    declaredAssets.add(asset.name);
    });
  }

  for (const char of script.characters) {
    capture(() => {
    if (externalGlobals.has(char.name)) throw new TypeCheckError(`${getLocStr(char)}: character '${char.name}' とグローバル変数 '${char.name}' の名前が重複しています`);
    if (declaredCharacters.has(char.name)) {
      throw new TypeCheckError(`${getLocStr(char)}: キャラクター '${char.name}' が重複して宣言されています`);
    }
    declaredCharacters.add(char.name);
    const properties = new Set<string>();
    for (const property of char.properties) {
      if (properties.has(property.name)) throw new TypeCheckError(`${getLocStr(property)}: キャラクター '${char.name}' のフィールド '${property.name}' が重複しています`);
      if (!characterPropertyType(property.value)) throw new TypeCheckError(`${getLocStr(property)}: キャラクターフィールド '${property.name}' は int、float、str または bool の定数で指定してください`);
      properties.add(property.name);
    }
    const displayName = char.properties.find((property) => property.name === 'name');
    if (!displayName || characterPropertyType(displayName.value) !== 'str') throw new TypeCheckError(`${getLocStr(char)}: character '${char.name}' には str の name フィールドが必要です`);
    const poses = new Set<string>();
    for (const pose of char.poses) {
      if (poses.has(pose.name)) {
        throw new TypeCheckError(`${getLocStr(char)}: キャラクター '${char.name}' の表情 '${pose.name}' が重複しています`);
      }
      if (!validAssetPath(pose.path)) {
        throw new TypeCheckError(`${getLocStr(char)}: 表情パス '${pose.path}' はプロジェクト外を参照できません`);
      }
      if (!ALLOWED_EXTENSIONS.char.some(ext => pose.path.toLowerCase().endsWith(ext))) throw new TypeCheckError(`表情 '${pose.name}' の拡張子が不正です`);
      poses.add(pose.name);
    }
    });
  }

  for (const fn of script.functions) {
    capture(() => {
    if (isRuntimeStateApi(fn.name)) {
      throw new TypeCheckError(`${getLocStr(fn)}: '${fn.name}' is reserved for the runtime state API`);
    }
    if (declaredFunctions.has(fn.name)) {
      throw new TypeCheckError(`${getLocStr(fn)}: 関数 '${fn.name}' が重複して宣言されています`);
    }
    declaredFunctions.add(fn.name);
    });
  }

  for (const sc of script.scenes) {
    capture(() => {
    if (declaredScenes.has(sc.name)) {
      throw new TypeCheckError(`${getLocStr(sc)}: シーン '${sc.name}' が重複して宣言されています`);
    }
    declaredScenes.add(sc.name);
    });
  }

  // 2. 再帰検査
  capture(() => checkRecursion(script.functions, staticGlobalStrings(script.globals)));

  // 3. コンテキスト構築
  const globals = new Map(externalGlobals);
  const functions = new Map<string, FunctionDef>();
  const scenes = new Set<string>(script.scenes.map((s) => s.name));
  const characters = new Map<string, Set<string>>();
  const assets = new Map<string, { type: AssetKind; path: string; loc?: NodeLocation }>();
  const structs = new Map(script.structs.map((s) => [s.name, s.fields]));

  for (const [name, rawInfo] of externalCharacters) {
    const info = characterInfo(rawInfo);
    characters.set(name, info.poses);
    structs.set(characterTypeName(name), info.fields);
    globals.set(name, { kind: 'struct', name: characterTypeName(name) });
  }
  for (const character of script.characters) {
    const fields = Object.fromEntries(character.properties.map((property) => [property.name, characterPropertyType(property.value)!]));
    characters.set(character.name, new Set(character.poses.map((pose) => pose.name)));
    structs.set(characterTypeName(character.name), fields);
    globals.set(character.name, { kind: 'struct', name: characterTypeName(character.name) });
  }

  script.assets.forEach((a) => assets.set(a.name, { type: a.type, path: a.path, loc: a }));
  script.functions.forEach((f) => functions.set(f.name, f));

  const ctx: TypeContext = {
    file,
    globals,
    functions,
    scenes,
    characters,
    assets,
    structs,
    externalGlobals: new Set(externalGlobals.keys()),
    readonly: new Set([...(externalGlobals as Map<string, ValueType> & { readonlyNames?: Set<string> }).readonlyNames || []].filter((name) => externalGlobals.has(name))),
    knownStrings: new Map(),
    knownNumbers: new Map(),
    ambiguous: new Set(),
    errors,
  };

  // グローバル文（変数宣言）の検証
  for (const stmt of script.globals) {
    capture(() => {
      if (stmt.kind === 'declare') {
        if (declaredGlobals.has(stmt.name)) {
          throw new TypeCheckError(`${getLocStr(stmt)}: グローバル変数 '${stmt.name}' が重複して宣言されています`);
        }
        declaredGlobals.add(stmt.name);
      }
    });
  }
  const isImplicitScene = script.scenes.length === 0;
  for (const statement of script.globals) {
    if (statement.kind !== 'declare' || !statement.constant || !statement.initial) continue;
    const value = staticValue(statement.initial, ctx.knownNumbers);
    if (typeof value === 'bigint' || typeof value === 'number' && Number.isFinite(value)) ctx.knownNumbers!.set(statement.name, value);
  }
  checkStatements(script.globals, globals, ctx, { allowGoto: isImplicitScene, allowChoice: isImplicitScene, allowReturn: false, allowDeclaration: true });

  // 関数の検証
  for (const fn of script.functions) {
    capture(() => {
    const fnVars = new Map(globals);
    const paramNames = new Set<string>();
    for (const param of fn.params) {
      if (paramNames.has(param.name)) {
        throw new TypeCheckError(`${getLocStr(fn)}: 関数 '${fn.name}' の引数名 '${param.name}' が重複しています`);
      }
      paramNames.add(param.name);
      fnVars.set(param.name, param.type);
    }
    // Function bodies execute after the file globals have been initialized.
    // Carry their statically known string templates into the function scope so
    // an interpolation such as `{template}` is checked for nested variables
    // and zero-argument calls even when it appears only inside the function.
    const fnNumbers = new Map(ctx.knownNumbers);
    paramNames.forEach((name) => fnNumbers.delete(name));
    const fnCtx = { ...ctx, currentFunction: fn, locals: paramNames, declaredLocals: new Set(paramNames), knownStrings: new Map(ctx.knownStrings), knownNumbers: fnNumbers, ambiguous: new Set<string>() };
    checkStatements(fn.body, fnVars, { ...fnCtx, readonly: new Set([...ctx.readonly || []].filter((name) => !paramNames.has(name))) }, { allowGoto: false, allowChoice: false, allowReturn: true, allowDeclaration: true });
    });
  }

  // シーンの検証（scene直下での変数宣言は禁止）
  for (const scene of script.scenes) {
    const sceneVars = new Map(globals);
    // A scene runs after the file globals, just like a function call. Keep
    // statically known global templates available for nested interpolation
    // validation in scene-local dialogue and choices.
    checkStatements(scene.body, sceneVars, { ...ctx, knownStrings: new Map(ctx.knownStrings), ambiguous: new Set<string>() }, { allowGoto: true, allowChoice: true, allowReturn: false, allowDeclaration: false });
  }
}

