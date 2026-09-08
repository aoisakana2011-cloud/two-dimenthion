"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TypeCheckError = void 0;
exports.inferValueType = inferValueType;
exports.checkTypes = checkTypes;
class TypeCheckError extends Error {
}
exports.TypeCheckError = TypeCheckError;
const ALLOWED_EXTENSIONS = {
    bg: ['.png', '.jpg', '.jpeg', '.webp', '.gif'],
    char: ['.png', '.jpg', '.jpeg', '.webp', '.gif'],
    image: ['.png', '.jpg', '.jpeg', '.webp', '.gif'],
    bgm: ['.wav', '.ogg', '.mp3', '.flac'],
    se: ['.wav', '.ogg', '.mp3', '.flac'],
    voice: ['.wav', '.ogg', '.mp3', '.flac'],
    video: ['.mp4', '.webm'],
};
function validAssetPath(path) {
    return !!path && !/^(?:[A-Za-z]:|[\\/])/.test(path) && !path.replace(/\\/g, '/').split('/').includes('..');
}
function typeName(type) {
    if (typeof type === 'string')
        return type;
    return type.kind === 'dict' ? `dict[${type.value}]` : type.name;
}
function sameType(left, right) {
    if (typeof left === 'string' || typeof right === 'string')
        return left === right;
    return left.kind === right.kind && (left.kind === 'dict' ? left.value === right.value : left.name === right.name);
}
const characterTypeName = (name) => `character:${name}`;
const characterInfo = (value) => value instanceof Set ? { poses: value, fields: {} } : value;
function characterPropertyType(expression) {
    if (expression.kind === 'literal')
        return typeof expression.value === 'string' ? 'str' : (typeof expression.value === 'number' || typeof expression.value === 'bigint') ? 'int' : undefined;
    if (expression.kind === 'unary' && (expression.operator === '+' || expression.operator === '-'))
        return characterPropertyType(expression.value) === 'int' ? 'int' : undefined;
    return undefined;
}
function interpolationNames(value) {
    return [...value.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\}/g)].map((match) => match[1]);
}
function getLocStr(node, file = 'current') {
    return `line ${node?.line ?? 1}`;
}
function expressionType(expression, variables, ctx, expected) {
    const loc = getLocStr(expression, ctx.file);
    if (expression.kind === 'literal') {
        if (typeof expression.value === 'string') {
            for (const path of interpolationNames(expression.value)) {
                const [name, ...fields] = path.split('.');
                let current = variables.get(name);
                if (!current)
                    throw new TypeCheckError(`${loc}: 型エラー (${ctx.file}): 補間対象の変数 '${name}' が未定義です`);
                for (const field of fields) {
                    if (!current || typeof current === 'string' || current.kind !== 'struct')
                        throw new TypeCheckError(`${loc}: 補間対象 '${path}' の '${field}' はフィールド参照できません`);
                    const next = ctx.structs.get(current.name)?.[field];
                    if (!next)
                        throw new TypeCheckError(`${loc}: 補間対象 '${path}' にフィールド '${field}' はありません`);
                    current = next;
                }
            }
            return 'str';
        }
        return 'int';
    }
    if (expression.kind === 'variable') {
        const type = variables.get(expression.name);
        if (!type)
            throw new TypeCheckError(`${loc}: 型エラー (${ctx.file}): 未定義の変数 '${expression.name}' です`);
        return type;
    }
    if (expression.kind === 'binary') {
        const op = expression.operator;
        const left = expressionType(expression.left, variables, ctx);
        const right = expressionType(expression.right, variables, ctx);
        if (op === '+') {
            if (left === 'str' && right === 'str')
                return 'str';
            if (left === 'int' && right === 'int')
                return 'int';
            throw new TypeCheckError(`${loc}: 型エラー (${ctx.file}): '+' の左右の型が一致していません (${typeName(left)} と ${typeName(right)})`);
        }
        if (['-', '*', '/', '%'].includes(op)) {
            if (left !== 'int' || right !== 'int') {
                throw new TypeCheckError(`${loc}: 型エラー (${ctx.file}): '${op}' の左右は int でなければなりません`);
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
            if (left !== 'int' || right !== 'int') {
                throw new TypeCheckError(`${loc}: 型エラー (${ctx.file}): '${op}' の左右は int でなければなりません`);
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
            if (inner !== 'int') {
                throw new TypeCheckError(`${loc}: 型エラー (${ctx.file}): 単項 '${op}' の対象は int でなければなりません`);
            }
            return 'int';
        }
        throw new TypeCheckError(`${loc}: 型エラー (${ctx.file}): 未知の単項演算子 '${op}' です`);
    }
    if (expression.kind === 'index') {
        const targetType = expressionType(expression.target, variables, ctx);
        const keyType = expressionType(expression.key, variables, ctx);
        if (typeof targetType !== 'string' && targetType.kind === 'struct' && expression.key.kind === 'literal' && typeof expression.key.value === 'string') {
            const field = ctx.structs.get(targetType.name)?.[expression.key.value];
            if (!field)
                throw new TypeCheckError(`${loc}: struct '${targetType.name}' にフィールド '${expression.key.value}' はありません`);
            return field;
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
        const types = expression.entries.map((entry) => expressionType(entry.value, variables, ctx));
        if (expected && typeof expected !== 'string') {
            if (expected.kind === 'struct')
                return { kind: 'dict', value: 'int' }; // Fields are checked against the struct declaration below.
            if (types.some((type) => type !== expected.value))
                throw new TypeCheckError(`${loc}: 辞書の値の型は ${expected.value} に統一してください`);
            return expected;
        }
        if (!types.length)
            return { kind: 'dict', value: 'int' };
        if (types.some((t) => typeof t !== 'string' || (t !== 'int' && t !== 'str') || t !== types[0])) {
            throw new TypeCheckError(`${loc}: 型エラー (${ctx.file}): 辞書の値の型は統一してください`);
        }
        return { kind: 'dict', value: types[0] };
    }
    if (expression.kind === 'call') {
        if (expression.name === 'str') {
            if (expression.args.length !== 1 || expressionType(expression.args[0], variables, ctx) !== 'int') {
                throw new TypeCheckError(`${loc}: 型エラー (${ctx.file}): str() は int 型の引数を1つ取ります`);
            }
            return 'str';
        }
        if (expression.name === 'int') {
            if (expression.args.length !== 1 || expressionType(expression.args[0], variables, ctx) !== 'str') {
                throw new TypeCheckError(`${loc}: 型エラー (${ctx.file}): int() は str 型の引数を1つ取ります`);
            }
            return 'int';
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
function inferValueType(expression, variables = new Map(), functions = []) {
    const inferred = expressionType(expression, variables, {
        file: 'current', globals: variables, functions: new Map(functions.map((fn) => [fn.name, fn])), scenes: new Set(), characters: new Map(), assets: new Map(), structs: new Map(),
    });
    if (inferred === 'bool')
        throw new TypeCheckError(`${getLocStr(expression)}: 真偽値は変数型として保存できません`);
    if (expression.kind === 'dict' && expression.entries.length === 0)
        throw new TypeCheckError(`${getLocStr(expression)}: 空の辞書は型を推論できません`);
    return inferred;
}
function checkCondition(expression, variables, ctx) {
    const loc = getLocStr(expression, ctx.file);
    const type = expressionType(expression, variables, ctx);
    if (type !== 'bool') {
        throw new TypeCheckError(`${loc}: 型エラー (${ctx.file}): 条件式には比較演算子（== / != / > / >= / < / <=）または論理式が必要です`);
    }
}
function checkFade(args, variables, ctx, loc) {
    if (!args.length)
        return;
    if (args.length !== 2 || args[0].kind !== 'literal' || args[0].value !== 'fade' || expressionType(args[1], variables, ctx) !== 'int')
        throw new TypeCheckError(`${loc}: 演出は fade <int> で指定してください`);
}
function checkCommand(name, args, variables, ctx, locStr) {
    const getArgStr = (idx) => {
        const a = args[idx];
        if (a && a.kind === 'literal' && typeof a.value === 'string')
            return a.value;
        throw new TypeCheckError(`${locStr}: 型エラー (${ctx.file}): コマンド '${name}' の第 ${idx + 1} 引数はリテラル識別子でなければなりません`);
    };
    switch (name) {
        case 'bg': {
            if (args.length !== 1)
                throw new TypeCheckError(`${locStr}: コマンド 'bg' は引数を1つ取ります`);
            const id = getArgStr(0);
            const asset = ctx.assets.get(id);
            if (!asset || asset.type !== 'bg')
                throw new TypeCheckError(`${locStr}: 未定義または型が異なる背景アセット '${id}' です`);
            break;
        }
        case 'bgm': {
            if (args.length !== 1)
                throw new TypeCheckError(`${locStr}: コマンド 'bgm' は引数を1つ取ります`);
            const id = getArgStr(0);
            const asset = ctx.assets.get(id);
            if (!asset || asset.type !== 'bgm')
                throw new TypeCheckError(`${locStr}: 未定義または型が異なるBGMアセット '${id}' です`);
            break;
        }
        case 'play': {
            if (args.length < 2)
                throw new TypeCheckError(`${locStr}: コマンド 'play' は最低2つの引数を取ります`);
            const kind = getArgStr(0);
            if (!['se', 'voice', 'video', 'bgm'].includes(kind))
                throw new TypeCheckError(`${locStr}: 未知の再生種別 '${kind}' です`);
            const id = getArgStr(1);
            const asset = ctx.assets.get(id);
            if (!asset || asset.type !== kind)
                throw new TypeCheckError(`${locStr}: 未定義または型が異なるアセット '${id}' (期待: ${kind}) です`);
            if (args.length > (kind === 'video' ? 3 : 2))
                throw new TypeCheckError(`${locStr}: play の引数が多すぎます`);
            if (kind === 'video' && args.length >= 3) {
                const mode = getArgStr(2);
                if (mode !== 'blocking' && mode !== 'async')
                    throw new TypeCheckError(`${locStr}: video再生モードは blocking または async で指定してください`);
            }
            break;
        }
        case 'show': {
            const poseReference = args.length ? /^([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(getArgStr(0)) : null;
            if (poseReference) {
                if (args.length < 2)
                    throw new TypeCheckError(`${locStr}: show は show <character>.<pose> <position> で指定してください`);
                const [, charName, pose] = poseReference;
                const pos = getArgStr(1);
                if (!['left', 'center', 'right'].includes(pos))
                    throw new TypeCheckError(`${locStr}: 不正な表示位置 '${pos}' です`);
                const charDef = ctx.characters.get(charName);
                if (!charDef)
                    throw new TypeCheckError(`${locStr}: 未定義のキャラクター '${charName}' です`);
                if (!charDef.has(pose))
                    throw new TypeCheckError(`${locStr}: キャラクター '${charName}' にポーズ '${pose}' はありません`);
                checkFade(args.slice(2), variables, ctx, locStr);
                break;
            }
            if (args.length >= 5 && getArgStr(1) === 'at' && getArgStr(3) === 'pose') {
                const charName = getArgStr(0);
                const pos = getArgStr(2);
                const pose = getArgStr(4);
                if (!['left', 'center', 'right'].includes(pos))
                    throw new TypeCheckError(`${locStr}: 不正な表示位置 '${pos}' です`);
                const charDef = ctx.characters.get(charName);
                if (!charDef)
                    throw new TypeCheckError(`${locStr}: 未定義のキャラクター '${charName}' です`);
                if (!charDef.has(pose))
                    throw new TypeCheckError(`${locStr}: キャラクター '${charName}' にポーズ '${pose}' はありません`);
                checkFade(args.slice(5), variables, ctx, locStr);
                break;
            }
            if (args.length < 2)
                throw new TypeCheckError(`${locStr}: コマンド 'show' の引数が不足しています`);
            const targetKind = getArgStr(0);
            if (targetKind === 'char') {
                if (args.length < 4)
                    throw new TypeCheckError(`${locStr}: show char は <char> <pos> <pose> が必要です`);
                checkFade(args.slice(4), variables, ctx, locStr);
                const charName = getArgStr(1);
                const pos = getArgStr(2);
                const pose = getArgStr(3);
                if (!['left', 'center', 'right'].includes(pos))
                    throw new TypeCheckError(`${locStr}: 不正な配置位置 '${pos}' です`);
                const charDef = ctx.characters.get(charName);
                if (!charDef)
                    throw new TypeCheckError(`${locStr}: 未定義のキャラクター '${charName}' です`);
                if (!charDef.has(pose))
                    throw new TypeCheckError(`${locStr}: キャラクター '${charName}' に表情 '${pose}' はありません`);
            }
            else if (targetKind === 'image') {
                if (args.length !== 3)
                    throw new TypeCheckError(`${locStr}: show image は画像と位置を指定してください`);
                const imgName = getArgStr(1);
                const asset = ctx.assets.get(imgName);
                if (!asset || asset.type !== 'image')
                    throw new TypeCheckError(`${locStr}: 未定義の画像アセット '${imgName}' です`);
                if (args.length >= 3) {
                    const pos = getArgStr(2);
                    if (!['left', 'center', 'right'].includes(pos))
                        throw new TypeCheckError(`${locStr}: 不正な配置位置 '${pos}' です`);
                }
            }
            else {
                throw new TypeCheckError(`${locStr}: show の対象は char または image でなければなりません`);
            }
            break;
        }
        case 'char': {
            if (args.length !== 3)
                throw new TypeCheckError(`${locStr}: char は <char> <pos> <pose> が必要です`);
            const charName = getArgStr(0);
            const pos = getArgStr(1);
            const pose = getArgStr(2);
            if (!['left', 'center', 'right'].includes(pos))
                throw new TypeCheckError(`${locStr}: 不正な配置位置 '${pos}' です`);
            const charDef = ctx.characters.get(charName);
            if (!charDef)
                throw new TypeCheckError(`${locStr}: 未定義のキャラクター '${charName}' です`);
            if (!charDef.has(pose))
                throw new TypeCheckError(`${locStr}: キャラクター '${charName}' に表情 '${pose}' はありません`);
            break;
        }
        case 'hide': {
            if (args.length && getArgStr(0) !== 'char') {
                const charName = getArgStr(0);
                if (!ctx.characters.has(charName))
                    throw new TypeCheckError(`${locStr}: 未定義のキャラクター '${charName}' です`);
                checkFade(args.slice(1), variables, ctx, locStr);
                break;
            }
            if (args.length < 2 || getArgStr(0) !== 'char')
                throw new TypeCheckError(`${locStr}: hide は hide char <name> で指定してください`);
            const charName = getArgStr(1);
            if (!ctx.characters.has(charName))
                throw new TypeCheckError(`${locStr}: 未定義のキャラクター '${charName}' です`);
            checkFade(args.slice(2), variables, ctx, locStr);
            break;
        }
        case 'clear': {
            if (args.length < 1)
                throw new TypeCheckError(`${locStr}: clear の対象を指定してください`);
            const target = getArgStr(0);
            if (args.length !== (target === 'char' || target === 'image' ? 2 : 1))
                throw new TypeCheckError(`${locStr}: clear の引数が不正です`);
            if (target === 'char' && !ctx.characters.has(getArgStr(1)))
                throw new TypeCheckError(`${locStr}: 未定義のキャラクターです`);
            if (target === 'image' && ctx.assets.get(getArgStr(1))?.type !== 'image')
                throw new TypeCheckError(`${locStr}: 未定義の画像です`);
            if (!['bg', 'bgm', 'image', 'char'].includes(target))
                throw new TypeCheckError(`${locStr}: clear の対象 '${target}' が不正です`);
            break;
        }
        case 'wait': {
            if (args.length !== 1)
                throw new TypeCheckError(`${locStr}: wait は時間を1つ指定してください`);
            const waitType = expressionType(args[0], variables, ctx);
            if (waitType !== 'int')
                throw new TypeCheckError(`${locStr}: wait の引数は int でなければなりません`);
            break;
        }
        case 'effect': {
            if (args.length > 3 || args.length < 2 || getArgStr(0) !== 'fade')
                throw new TypeCheckError(`${locStr}: effect は effect fade <color> [<ms>] を指定してください`);
            if (!['black', 'white'].includes(getArgStr(1)))
                throw new TypeCheckError(`${locStr}: fade の色が不正です`);
            if (args[2] && expressionType(args[2], variables, ctx) !== 'int')
                throw new TypeCheckError(`${locStr}: 演出時間は int です`);
            break;
        }
        case 'say': {
            if (args.length !== 2)
                throw new TypeCheckError(`${locStr}: say は話者と本文を指定してください`);
            const speaker = getArgStr(0);
            if (speaker !== 'narrator' && speaker !== 'none' && !ctx.characters.has(speaker)) {
                throw new TypeCheckError(`${locStr}: 未定義の話者 '${speaker}' です`);
            }
            const textType = expressionType(args[1], variables, ctx);
            if (textType !== 'str')
                throw new TypeCheckError(`${locStr}: say の本文は str でなければなりません`);
            break;
        }
        default: throw new TypeCheckError(`${locStr}: 未知の命令 '${name}' です`);
    }
}
function exitsBlock(statements) {
    return statements.some((statement) => statement.kind === 'return' || statement.kind === 'goto' ||
        (statement.kind === 'if' && statement.otherwise.length > 0 && exitsBlock(statement.body) && statement.elseIf.every((branch) => exitsBlock(branch.body)) && exitsBlock(statement.otherwise)));
}
function checkStatements(statements, variables, ctx, options) {
    for (const statement of statements) {
        const locStr = getLocStr(statement, ctx.file);
        try {
            if (statement.kind === 'declare') {
                if (!options.allowDeclaration) {
                    throw new TypeCheckError(`${locStr}: 型エラー (${ctx.file}): scene 直下での変数宣言は禁止されています（選択肢ブロック内またはグローバルで宣言してください）`);
                }
                const duplicateLocal = ctx.locals?.has(statement.name) || false;
                const shadowsScenarioVariable = variables.has(statement.name) && !ctx.currentFunction;
                if (duplicateLocal || shadowsScenarioVariable) {
                    throw new TypeCheckError(`${locStr}: 型エラー (${ctx.file}): 変数 '${statement.name}' は既に宣言されています。再宣言せず set を使用してください`);
                }
                if (statement.initial) {
                    const actual = expressionType(statement.initial, variables, ctx, statement.type === 'infer' ? undefined : statement.type);
                    if (typeof statement.type !== 'string' && statement.type.kind === 'struct') {
                        const fields = ctx.structs.get(statement.type.name);
                        if (!fields)
                            throw new TypeCheckError(`${locStr}: 未定義のstruct '${statement.type.name}' です`);
                        if (statement.initial.kind !== 'dict')
                            throw new TypeCheckError(`${locStr}: struct の初期値はフィールド付きオブジェクトで指定してください`);
                        const keys = new Set(statement.initial.entries.map((e) => e.key));
                        for (const [field, fieldType] of Object.entries(fields)) {
                            const entry = statement.initial.entries.find((e) => e.key === field);
                            if (!entry)
                                throw new TypeCheckError(`${locStr}: struct '${statement.type.name}' のフィールド '${field}' が不足しています`);
                            if (expressionType(entry.value, variables, ctx) !== fieldType)
                                throw new TypeCheckError(`${locStr}: フィールド '${field}' の型が一致しません`);
                        }
                        for (const key of keys)
                            if (!fields[key])
                                throw new TypeCheckError(`${locStr}: struct '${statement.type.name}' にフィールド '${key}' はありません`);
                    }
                    if (statement.type === 'infer') {
                        if (actual === 'bool' || actual === 'none') {
                            throw new TypeCheckError(`${locStr}: 型エラー (${ctx.file}): let '${statement.name}' の型を ${typeName(actual)} から推論できません`);
                        }
                        if (statement.initial.kind === 'dict' && statement.initial.entries.length === 0) {
                            throw new TypeCheckError(`${locStr}: 型エラー (${ctx.file}): 空の辞書は型を推論できません。dict[int] または dict[str] を指定してください`);
                        }
                        statement.type = actual;
                    }
                    if ((typeof statement.type === 'string' || statement.type.kind === 'dict') && !sameType(statement.type, actual)) {
                        throw new TypeCheckError(`${locStr}: 型エラー (${ctx.file}): ${statement.name} は ${typeName(statement.type)} ですが、${typeName(actual)} が代入されています`);
                    }
                }
                if (statement.type === 'infer') {
                    throw new TypeCheckError(`${locStr}: 型エラー (${ctx.file}): let '${statement.name}' には初期値が必要です`);
                }
                variables.set(statement.name, statement.type);
                ctx.readonly?.delete(statement.name);
                if (statement.constant)
                    ctx.readonly?.add(statement.name);
                ctx.locals?.add(statement.name);
            }
            if (statement.kind === 'set') {
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
                }
                else if (statement.target.kind === 'index') {
                    if (statement.target.target.kind === 'variable' && ctx.readonly?.has(statement.target.target.name)) {
                        throw new TypeCheckError(`${locStr}: 型エラー (${ctx.file}): const 変数 '${statement.target.target.name}' の要素は変更できません`);
                    }
                    const targetType = expressionType(statement.target.target, variables, ctx);
                    const keyType = expressionType(statement.target.key, variables, ctx);
                    if (typeof targetType !== 'string' && targetType.kind === 'struct' && statement.target.key.kind === 'literal' && typeof statement.target.key.value === 'string') {
                        const fieldType = ctx.structs.get(targetType.name)?.[statement.target.key.value];
                        if (!fieldType)
                            throw new TypeCheckError(`${locStr}: struct フィールドが存在しません`);
                        if (keyType !== 'str' || !sameType(fieldType, exprType))
                            throw new TypeCheckError(`${locStr}: struct フィールドの型が一致しません`);
                    }
                    else {
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
                }
                else if (statement.target.kind === 'index') {
                    if (statement.target.target.kind === 'variable' && ctx.readonly?.has(statement.target.target.name))
                        throw new TypeCheckError(`${locStr}: const 変数 '${statement.target.target.name}' の要素は変更できません`);
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
            if (statement.kind === 'sayBlock') {
                for (const line of statement.lines)
                    checkCommand('say', [statement.speaker, line], variables, ctx, locStr);
            }
            if (statement.kind === 'if') {
                checkCondition(statement.condition.expression, variables, ctx);
                const baseNames = new Set(variables.keys());
                const branchVariables = [];
                const branchReadonly = [];
                const checkBranch = (body) => {
                    const branch = new Map(variables);
                    const readonly = new Set(ctx.readonly);
                    checkStatements(body, branch, { ...ctx, locals: ctx.locals ? new Set(ctx.locals) : undefined, readonly }, options);
                    if (!exitsBlock(body)) {
                        branchVariables.push(branch);
                        branchReadonly.push(readonly);
                    }
                };
                checkBranch(statement.body);
                for (const branch of statement.elseIf) {
                    checkCondition(branch.condition.expression, variables, ctx);
                    checkBranch(branch.body);
                }
                if (statement.otherwise.length)
                    checkBranch(statement.otherwise);
                else {
                    branchVariables.push(new Map(variables));
                    branchReadonly.push(new Set(ctx.readonly));
                }
                const candidates = [...(branchVariables[0]?.keys() || [])].filter((name) => !baseNames.has(name));
                for (const name of candidates) {
                    const types = branchVariables.map((branch) => branch.get(name));
                    if (types.some((type) => type === undefined))
                        continue;
                    if (types.some((type) => !sameType(types[0], type))) {
                        throw new TypeCheckError(`${locStr}: 型エラー (${ctx.file}): 分岐ごとに変数 '${name}' の型が一致していません`);
                    }
                    variables.set(name, types[0]);
                    if (branchReadonly.some((readonly) => readonly.has(name)))
                        ctx.readonly?.add(name);
                    ctx.locals?.add(name);
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
                const loopReadonly = new Set(ctx.readonly);
                loopReadonly.delete(statement.name);
                const loopLocals = new Set(ctx.locals || variables.keys());
                loopLocals.add(statement.name);
                checkStatements(statement.body, loopVars, { ...ctx, locals: loopLocals, readonly: loopReadonly }, options);
                for (const [name, type] of loopVars)
                    if (name !== statement.name && !variables.has(name)) {
                        variables.set(name, type);
                        ctx.locals?.add(name);
                        if (loopReadonly.has(name))
                            ctx.readonly?.add(name);
                    }
            }
            if (statement.kind === 'while') {
                checkCondition(statement.condition.expression, variables, ctx);
                checkStatements(statement.body, new Map(variables), { ...ctx, locals: ctx.locals ? new Set(ctx.locals) : undefined, readonly: ctx.readonly ? new Set(ctx.readonly) : undefined }, options);
            }
            if (statement.kind === 'choice') {
                if (!options.allowChoice) {
                    throw new TypeCheckError(`${locStr}: 型エラー (${ctx.file}): 関数内で choice は使用できません`);
                }
                if (!statement.options.length)
                    throw new TypeCheckError(`${locStr}: choice には1つ以上の選択肢が必要です`);
                if (statement.prompt) {
                    const promptType = expressionType(statement.prompt, variables, ctx);
                    if (promptType !== 'str')
                        throw new TypeCheckError(`${locStr}: choice の質問文は str でなければなりません`);
                }
                for (const option of statement.options) {
                    const labelType = expressionType(option.label, variables, ctx);
                    if (labelType !== 'str')
                        throw new TypeCheckError(`${locStr}: 選択肢のラベルは str でなければなりません`);
                    // choice ブロック内では変数宣言を許可
                    checkStatements(option.body, new Map(variables), { ...ctx, locals: new Set(), readonly: ctx.readonly ? new Set(ctx.readonly) : undefined }, { ...options, allowDeclaration: true });
                }
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
                    if (statement.value)
                        throw new TypeCheckError(`${locStr}: 型エラー (${ctx.file}): none 型の関数は値を返せません`);
                }
                else {
                    if (!statement.value)
                        throw new TypeCheckError(`${locStr}: 型エラー (${ctx.file}): 値を返す必要があります`);
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
        }
        catch (error) {
            if (!ctx.errors || !(error instanceof TypeCheckError))
                throw error;
            ctx.errors.push(error);
        }
    }
}
function checkRecursion(functions) {
    const callGraph = new Map();
    for (const fn of functions) {
        const called = new Set();
        const visitExpr = (e) => {
            if (e.kind === 'call') {
                called.add(e.name);
                e.args.forEach(visitExpr);
            }
            if (e.kind === 'binary') {
                visitExpr(e.left);
                visitExpr(e.right);
            }
            if (e.kind === 'unary')
                visitExpr(e.value);
            if (e.kind === 'index') {
                visitExpr(e.target);
                visitExpr(e.key);
            }
            if (e.kind === 'dict')
                e.entries.forEach((ent) => visitExpr(ent.value));
        };
        const visitStmt = (s) => {
            if (s.kind === 'call') {
                called.add(s.name);
                s.args.forEach(visitExpr);
            }
            if (s.kind === 'declare' && s.initial)
                visitExpr(s.initial);
            if (s.kind === 'set') {
                visitExpr(s.value);
                if (s.target.kind === 'index') {
                    visitExpr(s.target.target);
                    visitExpr(s.target.key);
                }
            }
            if (s.kind === 'command')
                s.args.forEach(visitExpr);
            if (s.kind === 'sayBlock') {
                visitExpr(s.speaker);
                s.lines.forEach(visitExpr);
            }
            if (s.kind === 'unset')
                visitExpr(s.target);
            if (s.kind === 'if') {
                visitExpr(s.condition.expression);
                s.body.forEach(visitStmt);
                s.elseIf.forEach((b) => { visitExpr(b.condition.expression); b.body.forEach(visitStmt); });
                s.otherwise.forEach(visitStmt);
            }
            if (s.kind === 'for') {
                visitExpr(s.start);
                visitExpr(s.stop);
                visitExpr(s.step);
                s.body.forEach(visitStmt);
            }
            if (s.kind === 'while') {
                visitExpr(s.condition.expression);
                s.body.forEach(visitStmt);
            }
            if (s.kind === 'choice') {
                if (s.prompt)
                    visitExpr(s.prompt);
                s.options.forEach((o) => { visitExpr(o.label); o.body.forEach(visitStmt); });
            }
            if (s.kind === 'return' && s.value)
                visitExpr(s.value);
        };
        fn.body.forEach(visitStmt);
        callGraph.set(fn.name, called);
    }
    // サイクル検出 (DFS)
    const visited = new Set();
    const recStack = new Set();
    function dfs(node, path) {
        visited.add(node);
        recStack.add(node);
        path.push(node);
        const neighbors = callGraph.get(node) || new Set();
        for (const neighbor of neighbors) {
            if (!visited.has(neighbor)) {
                dfs(neighbor, path);
            }
            else if (recStack.has(neighbor)) {
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
function checkTypes(script, file = 'current', externalGlobals = new Map(), externalCharacters = new Map(), errors) {
    // 1. 重複宣言チェック
    const declaredGlobals = new Set();
    const declaredFunctions = new Set();
    const declaredScenes = new Set();
    const declaredStructs = new Set();
    const declaredCharacters = new Set(externalCharacters.keys());
    const declaredAssets = new Set();
    const capture = (check) => {
        try {
            check();
        }
        catch (error) {
            if (!errors || !(error instanceof TypeCheckError))
                throw error;
            errors.push(error);
        }
    };
    for (const name of externalCharacters.keys()) {
        capture(() => {
            if (externalGlobals.has(name))
                throw new TypeCheckError(`character '${name}' とグローバル変数 '${name}' の名前が重複しています`);
        });
    }
    for (const struct of script.structs) {
        capture(() => {
            if (declaredStructs.has(struct.name))
                throw new TypeCheckError(`${getLocStr(struct, file)}: struct '${struct.name}' が重複しています`);
            declaredStructs.add(struct.name);
            for (const [field, fieldType] of Object.entries(struct.fields)) {
                if (fieldType !== 'int' && fieldType !== 'str')
                    throw new TypeCheckError(`${getLocStr(struct, file)}: struct フィールド '${field}' の型が不正です`);
            }
        });
    }
    for (const asset of script.assets) {
        capture(() => {
            if (declaredAssets.has(asset.name)) {
                throw new TypeCheckError(`${getLocStr(asset, file)}: アセット '${asset.name}' が重複して宣言されています`);
            }
            // パス検証 (項目23)
            if (!validAssetPath(asset.path)) {
                throw new TypeCheckError(`${getLocStr(asset, file)}: アセットパス '${asset.path}' はプロジェクト外を参照できません`);
            }
            const dotIdx = asset.path.lastIndexOf('.');
            const ext = dotIdx >= 0 ? asset.path.slice(dotIdx).toLowerCase() : '';
            const allowed = ALLOWED_EXTENSIONS[asset.type] || [];
            if (!allowed.includes(ext)) {
                throw new TypeCheckError(`${getLocStr(asset, file)}: アセット '${asset.name}' (${asset.type}) の拡張子 '${ext}' は不正です`);
            }
            declaredAssets.add(asset.name);
        });
    }
    for (const char of script.characters) {
        capture(() => {
            if (externalGlobals.has(char.name))
                throw new TypeCheckError(`${getLocStr(char, file)}: character '${char.name}' とグローバル変数 '${char.name}' の名前が重複しています`);
            if (declaredCharacters.has(char.name)) {
                throw new TypeCheckError(`${getLocStr(char, file)}: キャラクター '${char.name}' が重複して宣言されています`);
            }
            declaredCharacters.add(char.name);
            const properties = new Set();
            for (const property of char.properties) {
                if (properties.has(property.name))
                    throw new TypeCheckError(`${getLocStr(property, file)}: キャラクター '${char.name}' のフィールド '${property.name}' が重複しています`);
                if (!characterPropertyType(property.value))
                    throw new TypeCheckError(`${getLocStr(property, file)}: キャラクターフィールド '${property.name}' は int または str の定数で指定してください`);
                properties.add(property.name);
            }
            const displayName = char.properties.find((property) => property.name === 'name');
            if (!displayName || characterPropertyType(displayName.value) !== 'str')
                throw new TypeCheckError(`${getLocStr(char, file)}: character '${char.name}' には str の name フィールドが必要です`);
            const poses = new Set();
            for (const pose of char.poses) {
                if (poses.has(pose.name)) {
                    throw new TypeCheckError(`${getLocStr(char, file)}: キャラクター '${char.name}' の表情 '${pose.name}' が重複しています`);
                }
                if (!validAssetPath(pose.path)) {
                    throw new TypeCheckError(`${getLocStr(char, file)}: 表情パス '${pose.path}' はプロジェクト外を参照できません`);
                }
                if (!ALLOWED_EXTENSIONS.char.some(ext => pose.path.toLowerCase().endsWith(ext)))
                    throw new TypeCheckError(`表情 '${pose.name}' の拡張子が不正です`);
                poses.add(pose.name);
            }
        });
    }
    for (const fn of script.functions) {
        capture(() => {
            if (declaredFunctions.has(fn.name)) {
                throw new TypeCheckError(`${getLocStr(fn, file)}: 関数 '${fn.name}' が重複して宣言されています`);
            }
            declaredFunctions.add(fn.name);
        });
    }
    for (const sc of script.scenes) {
        capture(() => {
            if (declaredScenes.has(sc.name)) {
                throw new TypeCheckError(`${getLocStr(sc, file)}: シーン '${sc.name}' が重複して宣言されています`);
            }
            declaredScenes.add(sc.name);
        });
    }
    // 2. 再帰検査
    capture(() => checkRecursion(script.functions));
    // 3. コンテキスト構築
    const globals = new Map(externalGlobals);
    const functions = new Map();
    const scenes = new Set(script.scenes.map((s) => s.name));
    const characters = new Map();
    const assets = new Map();
    const structs = new Map(script.structs.map((s) => [s.name, s.fields]));
    for (const [name, rawInfo] of externalCharacters) {
        const info = characterInfo(rawInfo);
        characters.set(name, info.poses);
        structs.set(characterTypeName(name), info.fields);
        globals.set(name, { kind: 'struct', name: characterTypeName(name) });
    }
    for (const character of script.characters) {
        const fields = Object.fromEntries(character.properties.map((property) => [property.name, characterPropertyType(property.value)]));
        characters.set(character.name, new Set(character.poses.map((pose) => pose.name)));
        structs.set(characterTypeName(character.name), fields);
        globals.set(character.name, { kind: 'struct', name: characterTypeName(character.name) });
    }
    script.assets.forEach((a) => assets.set(a.name, { type: a.type, path: a.path, loc: a }));
    script.functions.forEach((f) => functions.set(f.name, f));
    const ctx = {
        file,
        globals,
        functions,
        scenes,
        characters,
        assets,
        structs,
        externalGlobals: new Set(externalGlobals.keys()),
        readonly: new Set([...externalGlobals.readonlyNames || []].filter((name) => externalGlobals.has(name))),
        errors,
    };
    // グローバル文（変数宣言）の検証
    for (const stmt of script.globals) {
        capture(() => {
            if (stmt.kind === 'declare') {
                if (declaredGlobals.has(stmt.name)) {
                    throw new TypeCheckError(`${getLocStr(stmt, file)}: グローバル変数 '${stmt.name}' が重複して宣言されています`);
                }
                declaredGlobals.add(stmt.name);
            }
        });
    }
    const isImplicitScene = script.scenes.length === 0;
    checkStatements(script.globals, globals, ctx, { allowGoto: isImplicitScene, allowChoice: isImplicitScene, allowReturn: false, allowDeclaration: true });
    // 関数の検証
    for (const fn of script.functions) {
        capture(() => {
            const fnVars = new Map(globals);
            const paramNames = new Set();
            for (const param of fn.params) {
                if (paramNames.has(param.name)) {
                    throw new TypeCheckError(`${getLocStr(fn, file)}: 関数 '${fn.name}' の引数名 '${param.name}' が重複しています`);
                }
                paramNames.add(param.name);
                fnVars.set(param.name, param.type);
            }
            const fnCtx = { ...ctx, currentFunction: fn, locals: paramNames };
            checkStatements(fn.body, fnVars, { ...fnCtx, readonly: new Set([...ctx.readonly || []].filter((name) => !paramNames.has(name))) }, { allowGoto: false, allowChoice: false, allowReturn: true, allowDeclaration: true });
        });
    }
    // シーンの検証（scene直下での変数宣言は禁止）
    for (const scene of script.scenes) {
        const sceneVars = new Map(globals);
        checkStatements(scene.body, sceneVars, ctx, { allowGoto: true, allowChoice: true, allowReturn: false, allowDeclaration: false });
    }
}
