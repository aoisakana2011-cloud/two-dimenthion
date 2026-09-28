'use strict';

// Values here are deliberately limited to the primitive types.  This keeps the
// project setting deterministic and lets the normal checker validate every use.
const fs = require('node:fs/promises');
const path = require('node:path');
function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
}

function error(message) { throw Error(`.novel/variables.json: ${message}`); }

const INT_MIN = -(1n << 63n);
const INT_MAX = (1n << 63n) - 1n;
function parseFloatValue(value, name, field) {
  if (typeof value !== 'number' && typeof value !== 'string') error(`'${name}' の ${field} は有限の小数にしてください`);
  if (typeof value === 'string' && !/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) error(`'${name}' の ${field} は有限の小数にしてください`);
  const number = Number(value);
  if (!Number.isFinite(number)) error(`'${name}' の ${field} は有限の小数にしてください`);
  return number;
}

function parseInteger(value, name, field) {
  const text = typeof value === 'string' ? value : Number.isSafeInteger(value) ? String(value) : null;
  if (!text || !/^-?(?:0|[1-9][0-9]*)$/.test(text)) error(`'${name}' の ${field} は正確な整数または整数文字列にしてください`);
  const integer = BigInt(text);
  if (integer < INT_MIN || integer > INT_MAX) error(`'${name}' の ${field} は64bit整数の範囲外です`);
  return integer;
}

function declaration(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) error('staticVariables の各項目はオブジェクトにしてください');
  const { name, type, value, constant = false, min, max, possibleValues } = entry;
  if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) error('変数名は英数字と _ で記述してください');
  if (!['int', 'float', 'str'].includes(type)) error(`'${name}' の type は int、float または str にしてください`);
  if (typeof constant !== 'boolean') error(`'${name}' の constant は true または false にしてください`);
  if (min !== undefined || max !== undefined || possibleValues !== undefined) {
    if (type === 'str' && (min !== undefined || max !== undefined)) error(`'${name}' の min/max は int でのみ使えます`);
    if (possibleValues !== undefined && (!Array.isArray(possibleValues) || possibleValues.length === 0)) error(`'${name}' の possibleValues は空でない配列にしてください`);
  }
  if (type === 'str') {
    if (possibleValues !== undefined && new Set(possibleValues).size !== possibleValues.length) error(`'${name}' possibleValues に重複があります`);
    if (typeof value !== 'string') error(`'${name}' は str なので value は文字列にしてください`);
    if (possibleValues !== undefined && possibleValues.some((item) => typeof item !== 'string')) error(`'${name}' の possibleValues は文字列だけにしてください`);
    if (possibleValues !== undefined && !possibleValues.includes(value)) error(`'${name}' の value は possibleValues に含めてください`);
    return { kind: 'declare', global: true, constant, type, name, initial: { kind: 'literal', value } };
  }
  if (type === 'float') {
    const number = parseFloatValue(value, name, 'value');
    const lower = min === undefined ? undefined : parseFloatValue(min, name, 'min');
    const upper = max === undefined ? undefined : parseFloatValue(max, name, 'max');
    const values = possibleValues === undefined ? undefined : possibleValues.map((item) => parseFloatValue(item, name, 'possibleValues'));
    if (lower !== undefined && upper !== undefined && lower > upper) error(`'${name}' の min は max 以下にしてください`);
    if (values && new Set(values).size !== values.length) error(`'${name}' の possibleValues に重複があります`);
    if (values?.some((item) => lower !== undefined && item < lower || upper !== undefined && item > upper)) error(`'${name}' の possibleValues は min/max の範囲内にしてください`);
    if (lower !== undefined && number < lower || upper !== undefined && number > upper || values && !values.includes(number)) error(`'${name}' の value は制約を満たしていません`);
    return { kind: 'declare', global: true, constant, type, name, initial: { kind: 'float', value: String(number) } };
  }
  // JSON numbers are accepted only while exact.  A decimal string preserves all
  // signed 64-bit values without JSON's floating-point loss.
  const text = typeof value === 'string' ? value : Number.isSafeInteger(value) ? String(value) : null;
  if (!text || !/^-?(?:0|[1-9][0-9]*)$/.test(text)) error(`'${name}' は int なので value は安全な整数または整数文字列にしてください`);
  const integer = BigInt(text);
  if (integer < INT_MIN || integer > INT_MAX) error(`'${name}' は 64 bit 整数の範囲外です`);
  const lower = min === undefined ? undefined : parseInteger(min, name, 'min');
  const upper = max === undefined ? undefined : parseInteger(max, name, 'max');
  if (lower !== undefined && upper !== undefined && lower > upper) error(`'${name}' の min は max 以下にしてください`);
  const values = possibleValues === undefined ? undefined : possibleValues.map((item) => parseInteger(item, name, 'possibleValues'));
  if (values && new Set(values).size !== values.length) error(`'${name}' の possibleValues に重複があります`);
  if (lower !== undefined && values?.some((item) => item < lower) || upper !== undefined && values?.some((item) => item > upper)) error(`'${name}' の possibleValues は min/max の範囲内にしてください`);
  if (lower !== undefined && integer < lower || upper !== undefined && integer > upper || values && !values.includes(integer)) error(`'${name}' の value は制約を満たしていません`);
  return { kind: 'declare', global: true, constant, type, name, initial: { kind: 'literal', value: integer } };
}

async function readStaticVariables(dataRoot) {
  const file = path.join(dataRoot, 'variables.json');
  let data;
  try {
    const rootInfo = await fs.lstat(dataRoot);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) error('.novel は作品フォルダー内の通常フォルダーである必要があります');
    const [projectRoot, realRoot] = await Promise.all([fs.realpath(path.dirname(dataRoot)), fs.realpath(dataRoot)]);
    if (!isInside(projectRoot, realRoot)) error('.novel は作品フォルダー外を参照できません');
    const fileInfo = await fs.lstat(file);
    if (!fileInfo.isFile() || fileInfo.isSymbolicLink() || fileInfo.nlink > 1) error('variables.json は通常の単独ファイルである必要があります');
    const realFile = await fs.realpath(file);
    if (!isInside(realRoot, realFile)) error('variables.json は .novel の外を参照できません');
    data = JSON.parse(await fs.readFile(realFile, 'utf8'));
  }
  catch (e) {
    if (e.code === 'ENOENT') {
      const table = new Map(); table.readonlyNames = new Set(); table.constraints = new Map();
      return { declarations: [], table, source: {} };
    }
    throw e;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) error('ルートはオブジェクトにしてください');
  if (data.staticVariables === undefined) {
    const table = new Map(); table.readonlyNames = new Set(); table.constraints = new Map();
    return { declarations: [], table, source: data };
  }
  if (!Array.isArray(data.staticVariables)) error('staticVariables は配列にしてください');
  const declarations = data.staticVariables.map(declaration);
  const table = new Map(); table.readonlyNames = new Set(); table.constraints = new Map();
  for (const item of declarations) {
    if (table.has(item.name)) error(`'${item.name}' が重複しています`);
    table.set(item.name, item.type);
    if (item.constant) table.readonlyNames.add(item.name);
    const source = data.staticVariables.find((entry) => entry.name === item.name);
    if (source?.type === 'int' && (source.min !== undefined || source.max !== undefined || source.possibleValues !== undefined)) {
      table.constraints.set(item.name, {
        type: 'int',
        ...(source.min !== undefined ? { min: parseInteger(source.min, item.name, 'min') } : {}),
        ...(source.max !== undefined ? { max: parseInteger(source.max, item.name, 'max') } : {}),
        ...(source.possibleValues !== undefined ? { values: new Set(source.possibleValues.map((value) => parseInteger(value, item.name, 'possibleValues'))) } : {}),
      });
    } else if (source?.type === 'float' && (source.min !== undefined || source.max !== undefined || source.possibleValues !== undefined)) {
      table.constraints.set(item.name, { type: 'float',
        ...(source.min !== undefined ? { floatMin: parseFloatValue(source.min, item.name, 'min') } : {}),
        ...(source.max !== undefined ? { floatMax: parseFloatValue(source.max, item.name, 'max') } : {}),
        ...(source.possibleValues !== undefined ? (() => { const values = source.possibleValues.map((value) => parseFloatValue(value, item.name, 'possibleValues')); return { floatValues: new Set(values), values: new Set(values) }; })() : {}),
      });
    } else if (source?.type === 'str' && source.possibleValues !== undefined) {
      table.constraints.set(item.name, { type: 'str', values: new Set(source.possibleValues) });
    }
  }
  return { declarations, table, source: data };
}

module.exports = { readStaticVariables };
