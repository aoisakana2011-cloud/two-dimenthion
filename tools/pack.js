 'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { compileProject, resolveProjectScript, sceneFile, inside, assetPaths, gotos } = require('./project');
const { parse } = require('../dist');
const { inferValueType } = require('../dist/checker/type-checker');
const { projectLayout, projectOption, layoutForInput, entryFile, positionalArguments, assertProjectDirectory, ensureProjectDirectory } = require('./project-layout');
const { readStaticVariables } = require('./static-variables');
const { validateGameScreens } = require('../Edit/game-screens');

async function projectGlobalVariables(scenesRoot, dataRoot) {
  const table = new Map();
  table.readonlyNames = new Set();
  const staticVariables = await readStaticVariables(dataRoot);
  for (const [name, type] of staticVariables.table) table.set(name, type);
  for (const name of staticVariables.table.readonlyNames) table.readonlyNames.add(name);
  table.staticDeclarations = staticVariables.declarations;
  table.constraints = new Map(staticVariables.table.constraints || []);
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
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.tds')) {
        const relative = path.relative(scenesRoot, file).replaceAll('\\', '/');
        const safeFile = await inside(scenesRoot, relative);
        const source = await fs.readFile(safeFile, 'utf8');
        const script = parse(source);
        const resolved = await resolveProjectScript(source, scenesRoot, new Set(), relative);
        scripts.push({ script, resolvedFunctions: resolved.functions, file: relative });
        declarationsByFile.set(relative, new Set(script.globals.filter(statement => statement.kind === 'declare').map(statement => statement.name)));
        for (const character of script.characters) {
          if (characterOwners.has(character.name)) throw new Error(`キャラクター '${character.name}' は複数ファイルで宣言されています`);
          characterOwners.set(character.name, relative);
          characters.set(character.name, {
            poses: new Set(character.poses.map(pose => pose.name)),
            fields: Object.fromEntries(character.properties.map(property => [property.name, property.value.kind === 'float' ? 'float' : property.value.kind === 'literal' && typeof property.value.value === 'string' ? 'str' : 'int'])),
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
  const pending = scripts.flatMap(({ script, resolvedFunctions, file }) => script.globals.filter(statement => statement.kind === 'declare' && statement.type === 'infer' && (file.toLowerCase() === 'main.tds' || statement.global)).map(statement => ({ statement, functions: resolvedFunctions, file })));
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
const { withSaveLoadScreens } = require('../Edit/game-screens');
async function pack(input, output, roots = {}) {
  const layout = roots.projectRoot ? projectLayout(roots.projectRoot) : (!roots.scenesRoot || !roots.assetsRoot) ? layoutForInput(input) : null;
  const scenesRoot = roots.scenesRoot || layout.scenesRoot;
  const assetsRoot = roots.assetsRoot || layout.assetsRoot;
  const dataRoot = roots.dataRoot || layout?.dataRoot || path.join(path.dirname(scenesRoot), '.novel');
  if (layout) {
    assertProjectDirectory(layout.projectRoot, scenesRoot, 'scenario_dir');
    assertProjectDirectory(layout.projectRoot, assetsRoot, 'asset_dir');
  }
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
    visibleGlobals.constraints = globalVariables.constraints;
    for (const name of declarationsByFile.get(file) || []) visibleGlobals.delete(name);
    const visibleCharacters = new Map(characters);
    for (const [name, owner] of characterOwners) if (owner === file) visibleCharacters.delete(name);
    const p = await compileProject(source, assetsRoot, scenesRoot, visibleGlobals, visibleCharacters, file, { debug: Boolean(roots.debug) });
    p.includes = []; // Each packaged program already contains its resolved includes.
    files[file] = p;
    const local = new Set(p.scenes.map(s => s.name));
    for (const target of gotos([...p.globals, ...p.scenes.flatMap(s => s.instructions)])) if (!local.has(target)) pending.push(sceneFile(target));
  }
  validateVariableFlow(files, entry);
  const entryGlobals = new Map(globalVariables);
  entryGlobals.readonlyNames = globalVariables.readonlyNames;
  entryGlobals.staticDeclarations = globalVariables.staticDeclarations;
  entryGlobals.constraints = globalVariables.constraints;
  for (const name of declarationsByFile.get(entry) || []) entryGlobals.delete(name);
  const entryCharacters = new Map(characters);
  for (const [name, owner] of characterOwners) if (owner === entry) entryCharacters.delete(name);
  const program = await compileProject(await fs.readFile(await inside(scenesRoot, entry), 'utf8'), assetsRoot, scenesRoot, entryGlobals, entryCharacters, entry, { debug: Boolean(roots.debug) });
  const destination = path.resolve(output);
  if (layout) {
    const relativeParent = path.relative(layout.projectRoot, path.dirname(destination));
    if (!path.isAbsolute(relativeParent) && relativeParent !== '..' && !relativeParent.startsWith('..' + path.sep)) {
      ensureProjectDirectory(layout.projectRoot, path.dirname(destination), '.novel/build');
    }
  }
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const outputRoot = await fs.realpath(path.dirname(destination));
  const ensureOutputDirectory = async (directory) => {
    const lexical = path.resolve(directory);
    const relative = path.relative(path.dirname(destination), lexical);
    if (path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) throw Error('Package output escaped its directory');
    let probe = lexical;
    while (true) {
      try {
        const resolved = await fs.realpath(probe);
        const fromRoot = path.relative(outputRoot, resolved);
        if (path.isAbsolute(fromRoot) || fromRoot === '..' || fromRoot.startsWith('..' + path.sep)) throw Error('Package output escaped its directory');
        break;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        const parent = path.dirname(probe);
        if (parent === probe) throw error;
        probe = parent;
      }
    }
    await fs.mkdir(lexical, { recursive: true });
    const resolved = await fs.realpath(lexical);
    const fromRoot = path.relative(outputRoot, resolved);
    if (path.isAbsolute(fromRoot) || fromRoot === '..' || fromRoot.startsWith('..' + path.sep)) throw Error('Package output escaped its directory');
  };
  const assertOutputFile = async (target) => {
    try {
      const info = await fs.lstat(target);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) throw Error('Package output must be a regular, unlinked file');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  };
  for (const asset of new Set(Object.values(files).flatMap(assetPaths))) {
    const relative = asset.replace(/^asset[\\/]/, '').replaceAll('\\', '/');
    const source = await inside(assetsRoot, relative);
    const target = path.resolve(path.dirname(destination), 'asset', relative);
    await ensureOutputDirectory(path.dirname(target));
    await assertOutputFile(target);
    if (path.resolve(source) !== target) await fs.copyFile(source, target);
  }
  const nativeUi = layout?.settings.native_ui_theme ? { native_ui_theme: layout.legacySettings ? layout.settings.native_ui_theme : 'ui/player-ui.json' } : {};
  if (nativeUi.native_ui_theme) {
    const sourceThemePath = layout.legacySettings ? layout.settings.native_ui_theme : layout.settings.native_ui_theme;
    const themeSource = await inside(layout.legacySettings ? assetsRoot : layout.settingsRoot, sourceThemePath);
    const themeTarget = path.resolve(path.dirname(destination), 'asset', 'ui', 'player-ui.json');
    await ensureOutputDirectory(path.dirname(themeTarget));
    await assertOutputFile(themeTarget);
    if (path.resolve(themeSource) !== themeTarget) await fs.copyFile(themeSource, themeTarget);
    const theme = JSON.parse(await fs.readFile(themeSource, 'utf8'));
    if (theme.version !== 1) throw Error('Unsupported native UI theme version');
    const themeDirectory = layout.legacySettings ? path.posix.dirname(sourceThemePath.replaceAll('\\', '/')) : '';
    const themedImageNames = [theme?.dialog?.image, theme?.dialog?.nameplate?.image, theme?.choices?.image, theme?.choices?.activeImage].filter((value) => typeof value === 'string' && value.length > 0);
    const controlImageNames = (theme?.controls?.buttons || []).flatMap(button => [button.image, button.hoverImage]).filter((value) => typeof value === 'string' && value.length > 0);
    for (const [imageName, relative] of [
      ...themedImageNames.map(imageName => [imageName, path.posix.join(themeDirectory, imageName)]),
      ...controlImageNames.map(imageName => [imageName, imageName]),
    ]) {
      const source = await inside(assetsRoot, relative);
      const target = path.resolve(path.dirname(destination), 'asset', relative);
      await ensureOutputDirectory(path.dirname(target));
      await assertOutputFile(target);
      if (path.resolve(source) !== target) await fs.copyFile(source, target);
    }
  }
  if (layout) {
    const screensPath = layout.legacySettings ? 'ui/game-screens.json' : 'game-screens.json';
    const screensRoot = layout.legacySettings ? assetsRoot : layout.settingsRoot;
    const screensCandidate = path.resolve(screensRoot, screensPath);
    let hasScreens = true;
    try {
      await fs.access(screensCandidate);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      hasScreens = false;
    }
    if (hasScreens) {
      const screensSource = await inside(screensRoot, screensPath);
      const screens = withSaveLoadScreens(validateGameScreens(JSON.parse(await fs.readFile(screensSource, 'utf8'))));
      if (screens.titleScene && path.posix.normalize(screens.titleScene.file.replaceAll('\\', '/')).toLowerCase() === entry.toLowerCase()) {
        const selected = program.scenes.findIndex(scene => scene.name === screens.titleScene.scene);
        if (selected < 0) throw new Error(`Title scene '${screens.titleScene.scene}' was not found in '${entry}'`);
        if (selected > 0) program.scenes.unshift(...program.scenes.splice(selected, 1));
      }
      if (!layout.legacySettings) {
        let display = { width: 1280, height: 720 };
        if (layout.settings.native_ui_theme) {
          const themePath = await inside(layout.settingsRoot, layout.settings.native_ui_theme);
          const theme = JSON.parse(await fs.readFile(themePath, 'utf8'));
          display = theme.screen;
        }
        screens.canvas = { width: display.width, height: display.height };
      }
      const target = path.resolve(path.dirname(destination), 'asset', 'ui', 'game-screens.json');
      await ensureOutputDirectory(path.dirname(target));
      await assertOutputFile(target);
      if (layout.legacySettings) {
        if (path.resolve(screensSource) !== target) await fs.copyFile(screensSource, target);
      } else {
        await fs.writeFile(target, `${JSON.stringify(screens, null, 2)}\n`, 'utf8');
      }
      nativeUi.game_screens = 'ui/game-screens.json';
      for (const screen of Object.values(screens.screens)) {
        const imageNames = [screen.background, screen.slotStyle?.image, screen.slotStyle?.hoverImage, ...screen.items.flatMap(item => [item.image || '', item.hoverImage || ''])].filter(Boolean);
        for (const imageName of imageNames) {
          const relative = imageName.replace(/^asset[\\/]/i, '').replaceAll('\\', '/');
          const imageSource = await inside(assetsRoot, relative);
          const imageTarget = path.resolve(path.dirname(destination), 'asset', relative);
          await ensureOutputDirectory(path.dirname(imageTarget));
          await assertOutputFile(imageTarget);
          if (path.resolve(imageSource) !== imageTarget) await fs.copyFile(imageSource, imageTarget);
        }
      }
    }
  }
  const data = { format: 'novel-script-package', version: 1, source: entry, ...(roots.debug ? { debug: true } : {}), program, files, native_ui: nativeUi };
  await assertOutputFile(destination);
  await fs.writeFile(destination, JSON.stringify(data, null, 2) + '\n', 'utf8');
  return data;
}
module.exports = { pack, validateVariableFlow };
if (require.main === module) {
  const args = process.argv.slice(2), debug = args.includes('--debug'), positional = positionalArguments(args.filter(arg => arg !== '--debug'));
  const selected = projectOption(args);
  const layout = selected ? projectLayout(selected) : positional[0] ? layoutForInput(positional[0]) : projectLayout();
  const input = positional[0] || entryFile(layout);
  const output = positional[1] || path.join(layout.buildRoot, path.basename(input, path.extname(input)) + '.nsp.json');
  pack(input, output, { projectRoot: layout.projectRoot, debug }).then(() => console.log(`Packed ${input} -> ${output}${debug ? ' (debug)' : ''}`)).catch(e => { console.error(`Pack failed: ${e.message}`); process.exitCode = 1; });
}
