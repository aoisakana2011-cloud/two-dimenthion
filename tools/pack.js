 'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { compileProject, sceneFile, inside, assetPaths, gotos } = require('./project');
const { parse } = require('../dist');
const { inferValueType } = require('../dist/checker/type-checker');

async function projectGlobalVariables(scenesRoot) {
  const table = new Map();
  const owners = new Map();
  const declarationsByFile = new Map();
  const scripts = [];
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (/\.(tds|txt)$/i.test(entry.name) && entry.name.toLowerCase() !== 'config.txt') {
        const script = parse(await fs.readFile(file, 'utf8'));
        const relative = path.relative(scenesRoot, file).replaceAll('\\', '/');
        scripts.push({ script, file: relative });
        declarationsByFile.set(relative, new Set(script.globals.filter(statement => statement.kind === 'declare').map(statement => statement.name)));
        for (const statement of script.globals) {
          if (statement.kind !== 'declare') continue;
          if (statement.type === 'infer') continue;
          const owner = owners.get(statement.name);
          if (owner) throw new Error(`変数 '${statement.name}' は '${owner}' で既に宣言されています。'${relative}' では set を使用してください`);
          table.set(statement.name, statement.type);
          owners.set(statement.name, relative);
        }
      }
    }
  }
  await visit(scenesRoot);
  const pending = scripts.flatMap(({ script, file }) => script.globals.filter(statement => statement.kind === 'declare' && statement.type === 'infer').map(statement => ({ statement, functions: script.functions, file })));
  let lastError;
  while (pending.length) {
    let progress = false;
    for (let index = pending.length - 1; index >= 0; index--) {
      const { statement, functions, file } = pending[index];
      try {
        statement.type = inferValueType(statement.initial, table, functions);
        const owner = owners.get(statement.name);
        if (owner) throw new Error(`変数 '${statement.name}' は '${owner}' で既に宣言されています。'${file}' では set を使用してください`);
        table.set(statement.name, statement.type); owners.set(statement.name, file); pending.splice(index, 1); progress = true;
      } catch (error) { lastError = error; }
    }
    if (!progress) throw lastError || new Error('Unable to infer global variable types');
  }
  return { table, declarationsByFile };
}

function variableContract(program) {
  const declared = new Set();
  const required = new Set();
  for (const variable of program.variables || []) {
    if (variable.scope !== 'global') continue;
    const definitions = variable.definitions || [];
    const references = variable.references || [];
    const globalDefinitions = definitions.filter((loc) => loc.scope === 'global');
    if (globalDefinitions.length) declared.add(variable.name);
    const firstDefinition = Math.min(...globalDefinitions.map((loc) => loc.line ?? Number.MAX_SAFE_INTEGER));
    if (references.some((loc) => !globalDefinitions.length || (loc.scope === 'global' && (loc.line ?? 1) < firstDefinition))) required.add(variable.name);
  }
  return { declared, required };
}

function validateVariableFlow(files, entry) {
  const pending = [{ file: entry, defined: new Set() }];
  const visited = new Set();
  while (pending.length) {
    const state = pending.pop();
    const key = `${state.file}\0${[...state.defined].sort().join('\0')}`;
    if (visited.has(key)) continue;
    visited.add(key);
    const program = files[state.file];
    if (!program) throw new Error(`遷移先 '${state.file}' がパッケージに含まれていません`);
    const { declared, required } = variableContract(program);
    const missing = [...required].filter((name) => !state.defined.has(name));
    if (missing.length) throw new Error(`シーン '${state.file}' で初期化前のグローバル変数を参照しています: ${missing.join(', ')}`);
    const nextDefined = new Set([...state.defined, ...declared]);
    const local = new Set(program.scenes.map((scene) => scene.name));
    for (const target of gotos([...program.globals, ...program.scenes.flatMap((scene) => scene.instructions)])) {
      if (!local.has(target)) pending.push({ file: sceneFile(target), defined: nextDefined });
    }
  }
}
async function pack(input, output, roots = {}) {
  const scenesRoot = roots.scenesRoot || path.resolve(__dirname, '../Edit/scenes');
  const assetsRoot = roots.assetsRoot || path.resolve(__dirname, '../Edit/assets');
  const { table: globalVariables, declarationsByFile } = await projectGlobalVariables(scenesRoot);
  const files = Object.create(null), pending = [path.relative(scenesRoot, path.resolve(input)).replaceAll('\\', '/')];
  const entry = pending[0];
  while (pending.length) {
    const file = pending.pop();
    if (Object.hasOwn(files, file)) continue;
    const source = await fs.readFile(await inside(scenesRoot, file), 'utf8');
    const localScript = parse(source);
    const visibleGlobals = new Map(globalVariables);
    for (const name of declarationsByFile.get(file) || []) visibleGlobals.delete(name);
    const p = await compileProject(source, assetsRoot, scenesRoot, visibleGlobals);
    const localFunctions = new Set(localScript.functions.map((fn) => fn.name));
    p.functions = p.functions.filter((fn) => localFunctions.has(fn.name));
    p.includes = localScript.includes;
    files[file] = p;
    for (const include of localScript.includes) pending.push(sceneFile(include));
    const local = new Set(p.scenes.map(s => s.name));
    for (const target of gotos([...p.globals, ...p.scenes.flatMap(s => s.instructions)])) if (!local.has(target)) pending.push(sceneFile(target));
  }
  validateVariableFlow(files, entry);
  const entryGlobals = new Map(globalVariables);
  for (const name of declarationsByFile.get(entry) || []) entryGlobals.delete(name);
  const program = await compileProject(await fs.readFile(await inside(scenesRoot, entry), 'utf8'), assetsRoot, scenesRoot, entryGlobals);
  const destination = path.resolve(output);
  for (const asset of new Set(Object.values(files).flatMap(assetPaths))) {
    const relative = asset.replace(/^assets[\\/]/, '').replaceAll('\\', '/');
    const source = await inside(assetsRoot, relative);
    const target = path.resolve(path.dirname(destination), 'assets', relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    if (path.resolve(source) !== target) await fs.copyFile(source, target);
  }
  const data = { format: 'novel-script-package', version: 1, source: entry, program, files };
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, JSON.stringify(data, null, 2) + '\n', 'utf8');
  return data;
}
module.exports = { pack, validateVariableFlow };
if (require.main === module) {
  const input = process.argv[2] || 'Edit/scenes/main.tds';
  const output = process.argv[3] || 'build/main.nsp.json';
  pack(input, output).then(() => console.log(`Packed ${input} -> ${output}`)).catch(e => { console.error(`Pack failed: ${e.message}`); process.exitCode = 1; });
}
