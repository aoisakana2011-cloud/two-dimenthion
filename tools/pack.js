 'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { compileProject, sceneFile, inside, assetPaths, gotos } = require('./project');
const { parse } = require('../dist');
const { inferValueType } = require('../dist/checker/type-checker');
const { projectLayout, projectOption, layoutForInput, entryFile, positionalArguments } = require('./project-layout');
const { readStaticVariables } = require('./static-variables');

async function projectGlobalVariables(scenesRoot, dataRoot) {
  const table = new Map();
  table.readonlyNames = new Set();
  const staticVariables = await readStaticVariables(dataRoot);
  for (const [name, type] of staticVariables.table) table.set(name, type);
  for (const name of staticVariables.table.readonlyNames) table.readonlyNames.add(name);
  table.staticDeclarations = staticVariables.declarations;
  const owners = new Map();
  for (const name of staticVariables.table.keys()) owners.set(name, '.novel/variables.json');
  const characterOwners = new Map();
  const characters = new Map();
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
        for (const character of script.characters) {
          if (characterOwners.has(character.name)) throw new Error(`キャラクター '${character.name}' は複数ファイルで宣言されています`);
          characterOwners.set(character.name, relative);
          characters.set(character.name, {
            poses: new Set(character.poses.map(pose => pose.name)),
            fields: Object.fromEntries(character.properties.map(property => [property.name, property.value.kind === 'literal' && typeof property.value.value === 'string' ? 'str' : 'int'])),
            definition: character,
          });
        }
        const implicitGlobals = relative.toLowerCase() === 'main.tds';
        for (const statement of script.globals) {
          if (statement.kind !== 'declare') continue;
          if (!implicitGlobals && !statement.global) continue;
          if (statement.type === 'infer') continue;
          const owner = owners.get(statement.name);
          if (owner) throw new Error(`変数 '${statement.name}' は '${owner}' で既に宣言されています。'${relative}' では set を使用してください`);
          table.set(statement.name, statement.type);
          if (statement.constant) table.readonlyNames.add(statement.name);
          owners.set(statement.name, relative);
        }
      }
    }
  }
  await visit(scenesRoot);
  const pending = scripts.flatMap(({ script, file }) => script.globals.filter(statement => statement.kind === 'declare' && statement.type === 'infer' && (file.toLowerCase() === 'main.tds' || statement.global)).map(statement => ({ statement, functions: script.functions, file })));
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
  return { table, declarationsByFile, scripts, characters, characterOwners };
}

const { validateVariableFlow } = require('./variable-flow');
async function pack(input, output, roots = {}) {
  const layout = roots.projectRoot ? projectLayout(roots.projectRoot) : (!roots.scenesRoot || !roots.assetsRoot) ? layoutForInput(input) : null;
  const scenesRoot = roots.scenesRoot || layout.scenesRoot;
  const assetsRoot = roots.assetsRoot || layout.assetsRoot;
  const dataRoot = roots.dataRoot || layout?.dataRoot || path.join(path.dirname(scenesRoot), '.novel');
  const { table: globalVariables, declarationsByFile, scripts, characters, characterOwners } = await projectGlobalVariables(scenesRoot, dataRoot);
  const files = Object.create(null);
  const entry = path.relative(scenesRoot, path.resolve(input)).replaceAll('\\', '/');
  const pending = scripts.map(({ file }) => file);
  if (!pending.includes(entry)) throw new Error(`開始ファイル '${entry}' が見つかりません`);
  while (pending.length) {
    const file = pending.pop();
    if (Object.hasOwn(files, file)) continue;
    const source = await fs.readFile(await inside(scenesRoot, file), 'utf8');
    const localScript = parse(source);
    const visibleGlobals = new Map(globalVariables);
    visibleGlobals.readonlyNames = globalVariables.readonlyNames;
    visibleGlobals.staticDeclarations = globalVariables.staticDeclarations;
    for (const name of declarationsByFile.get(file) || []) visibleGlobals.delete(name);
    const visibleCharacters = new Map(characters);
    for (const [name, owner] of characterOwners) if (owner === file) visibleCharacters.delete(name);
    const p = await compileProject(source, assetsRoot, scenesRoot, visibleGlobals, visibleCharacters);
    p.includes = []; // Each packaged program already contains its resolved includes.
    files[file] = p;
    for (const include of localScript.includes) pending.push(sceneFile(include));
    const local = new Set(p.scenes.map(s => s.name));
    for (const target of gotos([...p.globals, ...p.scenes.flatMap(s => s.instructions)])) if (!local.has(target)) pending.push(sceneFile(target));
  }
  validateVariableFlow(files, entry);
  const entryGlobals = new Map(globalVariables);
  entryGlobals.readonlyNames = globalVariables.readonlyNames;
  entryGlobals.staticDeclarations = globalVariables.staticDeclarations;
  for (const name of declarationsByFile.get(entry) || []) entryGlobals.delete(name);
  const entryCharacters = new Map(characters);
  for (const [name, owner] of characterOwners) if (owner === entry) entryCharacters.delete(name);
  const program = await compileProject(await fs.readFile(await inside(scenesRoot, entry), 'utf8'), assetsRoot, scenesRoot, entryGlobals, entryCharacters);
  const destination = path.resolve(output);
  for (const asset of new Set(Object.values(files).flatMap(assetPaths))) {
    const relative = asset.replace(/^assets?[\\/]/, '').replaceAll('\\', '/');
    const source = await inside(assetsRoot, relative);
    const target = path.resolve(path.dirname(destination), 'asset', relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    if (path.resolve(source) !== target) await fs.copyFile(source, target);
  }
  const nativeUi = layout?.settings.native_ui_theme ? { native_ui_theme: layout.settings.native_ui_theme } : {};
  if (nativeUi.native_ui_theme) {
    const themePath = nativeUi.native_ui_theme;
    const themeSource = await inside(assetsRoot, themePath);
    const themeTarget = path.resolve(path.dirname(destination), 'asset', themePath);
    await fs.mkdir(path.dirname(themeTarget), { recursive: true });
    if (path.resolve(themeSource) !== themeTarget) await fs.copyFile(themeSource, themeTarget);
    const theme = JSON.parse(await fs.readFile(await inside(assetsRoot, themePath), 'utf8'));
    if (theme.version !== 1) throw Error('Unsupported native UI theme version');
    const themeDirectory = path.posix.dirname(themePath.replaceAll('\\', '/'));
    const imageNames = [theme?.dialog?.image, theme?.dialog?.nameplate?.image, theme?.choices?.image, theme?.choices?.activeImage].filter((value) => typeof value === 'string');
    for (const imageName of imageNames) {
      const relative = path.posix.join(themeDirectory, imageName);
      const source = await inside(assetsRoot, relative);
      const target = path.resolve(path.dirname(destination), 'asset', relative);
      await fs.mkdir(path.dirname(target), { recursive: true });
      if (path.resolve(source) !== target) await fs.copyFile(source, target);
    }
  }
  const data = { format: 'novel-script-package', version: 1, source: entry, program, files, native_ui: nativeUi };
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, JSON.stringify(data, null, 2) + '\n', 'utf8');
  return data;
}
module.exports = { pack, validateVariableFlow };
if (require.main === module) {
  const args = process.argv.slice(2), positional = positionalArguments(args);
  const selected = projectOption(args);
  const layout = selected ? projectLayout(selected) : positional[0] ? layoutForInput(positional[0]) : projectLayout();
  const input = positional[0] || entryFile(layout);
  const output = positional[1] || path.join(layout.buildRoot, path.basename(input, path.extname(input)) + '.nsp.json');
  pack(input, output, { projectRoot: layout.projectRoot }).then(() => console.log(`Packed ${input} -> ${output}`)).catch(e => { console.error(`Pack failed: ${e.message}`); process.exitCode = 1; });
}
