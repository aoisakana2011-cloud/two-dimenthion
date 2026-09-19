'use strict';

// Values here are deliberately limited to the primitive types.  This keeps the
// project setting deterministic and lets the normal checker validate every use.
const fs = require('node:fs/promises');
const path = require('node:path');

function error(message) { throw Error(`.novel/variables.json: ${message}`); }

function declaration(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) error('staticVariables の各項目はオブジェクトにしてください');
  const { name, type, value, constant = false } = entry;
  if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) error('変数名は英数字と _ で記述してください');
  if (type !== 'int' && type !== 'str') error(`'${name}' の type は int または str にしてください`);
  if (typeof constant !== 'boolean') error(`'${name}' の constant は true または false にしてください`);
  if (type === 'str') {
    if (typeof value !== 'string') error(`'${name}' は str なので value は文字列にしてください`);
    return { kind: 'declare', global: true, constant, type, name, initial: { kind: 'literal', value } };
  }
  // JSON numbers are accepted only while exact.  A decimal string preserves all
  // signed 64-bit values without JSON's floating-point loss.
  const text = typeof value === 'string' ? value : Number.isSafeInteger(value) ? String(value) : null;
  if (!text || !/^-?(?:0|[1-9][0-9]*)$/.test(text)) error(`'${name}' は int なので value は安全な整数または整数文字列にしてください`);
  const integer = BigInt(text);
  if (integer < -9223372036854775808n || integer > 9223372036854775807n) error(`'${name}' は 64 bit 整数の範囲外です`);
  return { kind: 'declare', global: true, constant, type, name, initial: { kind: 'literal', value: integer } };
}

async function readStaticVariables(dataRoot) {
  const file = path.join(dataRoot, 'variables.json');
  let data;
  try { data = JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (e) {
    if (e.code === 'ENOENT') {
      const table = new Map(); table.readonlyNames = new Set();
      return { declarations: [], table, source: {} };
    }
    throw e;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) error('ルートはオブジェクトにしてください');
  if (data.staticVariables === undefined) {
    const table = new Map(); table.readonlyNames = new Set();
    return { declarations: [], table, source: data };
  }
  if (!Array.isArray(data.staticVariables)) error('staticVariables は配列にしてください');
  const declarations = data.staticVariables.map(declaration);
  const table = new Map(); table.readonlyNames = new Set();
  for (const item of declarations) {
    if (table.has(item.name)) error(`'${item.name}' が重複しています`);
    table.set(item.name, item.type);
    if (item.constant) table.readonlyNames.add(item.name);
  }
  return { declarations, table, source: data };
}

module.exports = { readStaticVariables };
