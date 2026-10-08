'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { parse, compile, tokenize } = require('../dist');
const { isBuiltinFunction } = require('../dist/language/builtins');
const STANDARD_LIBRARY_PREFIX = 'std/';
const STANDARD_LIBRARY_ROOT = path.resolve(__dirname, '../std');

function isStandardLibraryInclude(includePath) {
  return typeof includePath === 'string' && includePath.replaceAll('\\', '/').startsWith(STANDARD_LIBRARY_PREFIX);
}

async function resolveIncludeFile(includePath, scenesRoot) {
  const name = sceneFile(includePath);
  if (isStandardLibraryInclude(name)) return inside(STANDARD_LIBRARY_ROOT, name.slice(STANDARD_LIBRARY_PREFIX.length));
  return inside(scenesRoot, name);
}

async function listStandardLibrary() {
  const modules = [];
  async function visit(directory, relative = '') {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(path.join(directory, entry.name), childRelative);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.tds')) {
        const file = await inside(STANDARD_LIBRARY_ROOT, childRelative);
        const declarations = scanTopLevelDeclarations(await fs.readFile(file, 'utf8'));
        modules.push({ path: `${STANDARD_LIBRARY_PREFIX}${childRelative}`, functions: declarations.functions });
      }
    }
  }
  await visit(STANDARD_LIBRARY_ROOT);
  return modules.sort((left, right) => left.path.localeCompare(right.path));
}

async function readStandardLibraryFile(name) {
  const normalized = sceneFile(name);
  if (!isStandardLibraryInclude(normalized)) throw Error('ここでは同梱のstd/ moduleだけを開けます。');
  const file = await resolveIncludeFile(normalized, '');
  return { name: normalized, source: await fs.readFile(file, 'utf8') };
}

function sceneFile(name) {
  if (typeof name !== 'string') throw Error('Scene path が不正です');
  name = name.replaceAll('\\', '/');
  if (/\.txt$/i.test(name)) throw Error('.tds形式のシナリオファイルだけを開けます');
  const parts = name.split('/');
  const safeDirectory = (part) => part.length > 0 && part.length <= 120 && part !== '.' && part !== '..' && !/[<>:"|?*\x00-\x1f]/.test(part) && !/[. ]$/.test(part) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part);
  const file = parts.pop();
  const safeFile = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,79}$/.test(file) && !/[. ]$/.test(file) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(file);
  if (name.startsWith('/') || parts.some((part) => !safeDirectory(part)) || !safeFile) throw Error('シナリオのパスが不正です');
  name = [...parts, file].join('/');
  return /\.tds$/i.test(name) ? name : name + '.tds';
}
async function inside(root, relative) {
  const base = await fs.realpath(root);
  const requested = path.resolve(base, relative);
  const info = await fs.lstat(requested);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) throw Error('作品ファイルは通常の単独ファイルである必要があります');
  const resolved = await fs.realpath(requested);
  const rel = path.relative(base, resolved);
  if (path.isAbsolute(rel) || rel === '..' || rel.startsWith('..' + path.sep)) throw Error('Path is outside the project.');
  if (!(await fs.stat(resolved)).isFile()) throw Error('ファイルではありません');
  return resolved;
}
function assetPaths(program) {
  return [...program.assets.map(a => a.path), ...program.characters.flatMap(c => c.poses.map(p => p.path))];
}
function fsErrorMessage(error) {
  if (error?.code === 'ENOENT') return 'ファイルまたはディレクトリが見つかりません';
  if (error?.code === 'EISDIR') return '指定されたパスはファイルではありません';
  return error?.message || 'ファイルを読み込めません';
}
function gotos(list, result = []) {
  for (const c of list) {
    if (c.op === 'goto') result.push(c.scene);
    if (c.body) gotos(c.body, result);
    if (c.otherwise) gotos(c.otherwise, result);
    c.elseIf?.forEach(b => gotos(b.body, result));
    c.options?.forEach(o => gotos(o.body, result));
  }
  return result;
}
async function validateProgram(program, assetsRoot, scenesRoot) {
  const errors = [];
  const assetEntries = [
    ...program.assets.map((asset) => ({ path: asset.path, line: asset.line, column: asset.column })),
    ...program.characters.filter((character) => !character.external).flatMap((character) => character.poses.map((pose) => ({ path: pose.path, line: pose.line || character.line, column: pose.column || character.column }))),
  ];
  for (const entry of assetEntries) {
    const asset = entry.path;
    try { await inside(assetsRoot, asset.replace(/^asset[\\/]/, '')); }
    catch (e) { errors.push(`asset '${asset}' を読み込めません: ${fsErrorMessage(e)} (行 ${entry.line || 1})`); }
  }
  const local = new Set(program.scenes.map(s => s.name));
  for (const target of gotos([...program.globals, ...program.scenes.flatMap(s => s.instructions)])) {
    if (!local.has(target)) {
      try { await inside(scenesRoot, sceneFile(target)); }
      catch (e) { errors.push(`遷移先 '${target}' を読み込めません: ${fsErrorMessage(e)}`); }
    }
  }
  if (errors.length) throw Error(errors.join('\n'));
  return program;
}
function tagLocations(value, file, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  if (Number.isFinite(value.line) || Number.isFinite(value.column)) value.file = file;
  if (Array.isArray(value)) value.forEach((item) => tagLocations(item, file, seen));
  else Object.values(value).forEach((item) => tagLocations(item, file, seen));
  return value;
}

// Includes are resolved after parsing for ordinary declarations, but struct
// names are needed while parsing typed declarations and function signatures.
// Read only the top-level token shape here so the main parser can validate the
// complete syntax while still accepting a type declared by an include.
function scanTopLevelDeclarations(source) {
  const tokens = tokenize(source);
  const structs = [];
  const functions = [];
  const includes = [];
  let depth = 0;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (depth === 0 && token.type === 'word' && token.value === 'struct') {
      const name = tokens[index + 1];
      if (name?.type === 'word') structs.push(name.value);
    }
    if (depth === 0 && token.type === 'word' && token.value === 'fn') {
      const name = tokens[index + 1];
      if (name?.type === 'word') functions.push(name.value);
    }
    if (depth === 0 && token.type === 'word' && token.value === 'include') {
      let includePath, cursor = index + 1;
      const next = tokens[cursor];
      if (next?.type === 'string') {
        includePath = next.value;
        cursor++;
      } else {
        const parts = [];
        let previous;
        for (; cursor < tokens.length && tokens[cursor].type !== 'newline' && tokens[cursor].type !== 'eof'
          && !(previous && tokens[cursor].type === 'word' && tokens[cursor].value === 'as' && tokens[cursor].offset > previous.offset + previous.value.length); cursor++) {
          const pathToken = tokens[cursor];
          if (previous && pathToken.offset > previous.offset + previous.value.length) throw Error('includeパスに空白は使用できません');
          parts.push(pathToken.value);
          previous = pathToken;
        }
        includePath = parts.join('');
      }
      if (tokens[cursor]?.value !== 'as' || tokens[cursor + 1]?.type !== 'word') throw Error('includeには別名が必要です: include "module.tds" as module');
      const alias = tokens[cursor + 1].value;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) throw Error(`includeの別名 '${alias}' が不正です`);
      includes.push({ path: includePath, alias });
      index = cursor + 1;
    }
    if (token.type === 'symbol' && token.value === '{') depth++;
    else if (token.type === 'symbol' && token.value === '}') depth = Math.max(0, depth - 1);
    if (token.type === 'eof') break;
  }
  return { structs, functions, includes };
}

async function collectIncludedStructs(source, scenesRoot, seen = new Set(), sourceName = 'current') {
  let declarations;
  try { declarations = scanTopLevelDeclarations(source); }
  catch (error) { if (error && typeof error === 'object' && !error.file) error.file = sourceName; throw error; }
  const discovered = new Set(declarations.structs);
  for (const include of declarations.includes) {
    const name = sceneFile(include.path);
    const file = await resolveIncludeFile(name, scenesRoot);
    if (seen.has(file)) throw Error(`includeが循環しています: ${name}`);
    let child;
    try { child = await collectIncludedStructs(await fs.readFile(file, 'utf8'), scenesRoot, new Set([...seen, file]), name); }
    catch (error) { if (error && typeof error === 'object' && !error.file) error.file = name; throw error; }
    for (const struct of child) discovered.add(struct);
  }
  return discovered;
}

function qualifyImportedFunctions(script, alias) {
  const names = new Map(script.functions.map((fn) => [fn.name, `${alias}.${fn.name}`]));
  const qualifyCall = (name) => names.get(name) || (isBuiltinFunction(name) ? name : name.includes('.') ? `${alias}.${name}` : name);
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (value.kind === 'call' && typeof value.name === 'string') value.name = qualifyCall(value.name);
    if (value.kind === 'literal' && typeof value.value === 'string') {
      value.value = value.value.replace(/\{([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\(\)\}/g, (source, name) => `{${qualifyCall(name)}()}`);
    }
    Object.values(value).forEach(visit);
  };
  visit(script.globals);
  visit(script.functions);
  script.functions.forEach((fn) => { fn.name = names.get(fn.name); });
}
async function resolveProjectScript(source, scenesRoot, seen = new Set(), sourceName = 'current', isModule = false) {
  let includedStructs;
  try { includedStructs = await collectIncludedStructs(source, scenesRoot, seen, sourceName); }
  catch (error) { if (error && typeof error === 'object' && !error.file) error.file = sourceName; throw error; }
  const normalizedSourceName = sourceName.replaceAll('\\', '/');
  const script = tagLocations(parse(source, includedStructs, {
    allowCharacterMethodDeclaration: normalizedSourceName === 'std/motion/walk.tds',
  }), sourceName);
  if (isModule) {
    if (script.scenes.length) throw Error(`module '${sourceName}' ではSceneを宣言できません。シナリオファイルへ移動するにはgotoを使ってください`);
    if (script.globals.some((statement) => statement.kind !== 'declare')) throw Error(`module '${sourceName}' には宣言だけを記述できます`);
  }
  const assets = [...script.assets];
  const characters = [...script.characters];
  const structs = [...script.structs];
  const globals = [];
  const functions = [...script.functions];
  const scenes = [...script.scenes];
  const includedPaths = new Set();
  const uniqueAssets = new Set(assets.map((item) => `${item.file || sourceName}:${item.name}`));
  const uniqueCharacters = new Set(characters.map((item) => `${item.file || sourceName}:${item.name}`));
  const uniqueStructs = new Set(structs.map((item) => `${item.file || sourceName}:${item.name}`));
  const uniqueGlobals = new Set(script.globals.filter((item) => item.kind === 'declare').map((item) => `${item.file || sourceName}:${item.name}`));
  for (const include of script.includes) {
    const name = sceneFile(include.path);
    const file = await resolveIncludeFile(name, scenesRoot);
    if (seen.has(file)) throw Error(`includeが循環しています: ${name}`);
    if (includedPaths.has(file)) throw Error(`module '${name}' が '${sourceName}' 内で重複してincludeされています`);
    includedPaths.add(file);
    let child;
    try { child = await resolveProjectScript(await fs.readFile(file, 'utf8'), scenesRoot, new Set([...seen, file]), name, true); }
    catch (error) { if (error && typeof error === 'object' && !error.file) error.file = name; throw error; }
    qualifyImportedFunctions(child, include.alias);
    for (const item of child.assets) { const key = `${item.file || name}:${item.name}`; if (!uniqueAssets.has(key)) { uniqueAssets.add(key); assets.push(item); } }
    for (const item of child.characters) { const key = `${item.file || name}:${item.name}`; if (!uniqueCharacters.has(key)) { uniqueCharacters.add(key); characters.push(item); } }
    for (const item of child.structs) { const key = `${item.file || name}:${item.name}`; if (!uniqueStructs.has(key)) { uniqueStructs.add(key); structs.push(item); } }
    for (const item of child.globals) {
      const key = item.kind === 'declare' ? `${item.file || name}:${item.name}` : '';
      if (!key || !uniqueGlobals.has(key)) { if (key) uniqueGlobals.add(key); globals.push(item); }
    }
    functions.push(...child.functions);
  }
  script.assets = assets;
  script.characters = characters;
  script.structs = structs;
  globals.push(...script.globals);
  script.globals = globals;
  script.functions = functions;
  script.scenes = scenes;
  script.body = globals;
  return script;
}
async function compileProject(source, assetsRoot, scenesRoot, globalVariables = new Map(), characters = new Map(), sourceName = 'current', options = {}) {
  const script = await resolveProjectScript(source, scenesRoot, new Set(), sourceName);
  // JSON static variables are real global declarations, not merely checker
  // metadata.  Every packaged file receives them; preserveGlobals initializes
  // them once and verifies their type on later scene transitions.
  const staticDeclarations = globalVariables.staticDeclarations || [];
  if (staticDeclarations.length) {
    script.globals = [...staticDeclarations, ...script.globals];
    script.body = script.globals;
  }
  const context = projectContext(script, globalVariables, characters, sourceName);
  return validateProgram(compile(script, context.globals, context.characters, Boolean(options.debug)), assetsRoot, scenesRoot);
}
function projectContext(script, globalVariables, characters, sourceName = 'current') {
  const globals = new Map(globalVariables), visibleCharacters = new Map(characters);
  globals.readonlyNames = new Set(globalVariables.readonlyNames || []);
  globals.constraints = new Map(globalVariables.constraints || []);
  for (const statement of globalVariables.staticDeclarations || []) {
    globals.delete(statement.name);
    globals.readonlyNames.delete(statement.name);
  }
  for (const statement of script.globals) if (statement.kind === 'declare' && statement.file && statement.file !== sourceName) { globals.delete(statement.name); globals.readonlyNames.delete(statement.name); }
  for (const character of script.characters) if (character.file && character.file !== sourceName) visibleCharacters.delete(character.name);
  return { globals, characters: visibleCharacters };
}
module.exports = { sceneFile, inside, assetPaths, gotos, validateProgram, resolveProjectScript, compileProject, tagLocations, projectContext, isStandardLibraryInclude, listStandardLibrary, readStandardLibraryFile };
