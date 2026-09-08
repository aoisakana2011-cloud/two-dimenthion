'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { parse, compile } = require('../dist');

function sceneFile(name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(name) || name.split('/').includes('..') || name.startsWith('/')) throw Error('不正なシーンパスです');
  return /\.(tds|txt)$/i.test(name) ? name : name + '.tds';
}
async function inside(root, relative) {
  const base = await fs.realpath(root);
  const resolved = await fs.realpath(path.resolve(base, relative));
  const rel = path.relative(base, resolved);
  if (path.isAbsolute(rel) || rel === '..' || rel.startsWith('..' + path.sep)) throw Error('プロジェクト外のパスです');
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
    try { await inside(assetsRoot, asset.replace(/^assets?[\\/]/, '')); }
    catch (e) { errors.push(`アセット '${asset}' を読み込めません: ${fsErrorMessage(e)} (行 ${entry.line || 1})`); }
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

async function resolveProjectScript(source, scenesRoot, seen = new Set(), sourceName = 'current') {
  const script = tagLocations(parse(source), sourceName);
  const assets = [...script.assets];
  const characters = [...script.characters];
  const globals = [];
  const functions = [...script.functions];
  const scenes = [...script.scenes];
  for (const include of script.includes) {
    const name = sceneFile(include);
    if (seen.has(name)) throw Error(`include が循環しています: ${name}`);
    const file = await inside(scenesRoot, name);
    const child = await resolveProjectScript(await fs.readFile(file, 'utf8'), scenesRoot, new Set([...seen, name]), name);
    assets.push(...child.assets);
    characters.push(...child.characters);
    globals.push(...child.globals);
    functions.push(...child.functions);
    scenes.push(...child.scenes);
  }
  script.assets = assets;
  script.characters = characters;
  globals.push(...script.globals);
  script.globals = globals;
  script.functions = functions;
  script.scenes = scenes;
  script.body = globals;
  return script;
}
async function compileProject(source, assetsRoot, scenesRoot, globalVariables = new Map(), characters = new Map(), sourceName = 'current') {
  const script = await resolveProjectScript(source, scenesRoot, new Set(), sourceName);
  const context = projectContext(script, globalVariables, characters, sourceName);
  return validateProgram(compile(script, context.globals, context.characters), assetsRoot, scenesRoot);
}
function projectContext(script, globalVariables, characters, sourceName = 'current') {
  const globals = new Map(globalVariables), visibleCharacters = new Map(characters);
  globals.readonlyNames = new Set(globalVariables.readonlyNames || []);
  for (const statement of script.globals) if (statement.kind === 'declare' && statement.file && statement.file !== sourceName) { globals.delete(statement.name); globals.readonlyNames.delete(statement.name); }
  for (const character of script.characters) if (character.file && character.file !== sourceName) visibleCharacters.delete(character.name);
  return { globals, characters: visibleCharacters };
}
module.exports = { sceneFile, inside, assetPaths, gotos, validateProgram, resolveProjectScript, compileProject, tagLocations, projectContext };
