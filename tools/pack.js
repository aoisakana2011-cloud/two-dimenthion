 'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { compileProject, resolveProjectScript, sceneFile, inside, assetPaths, gotos } = require('./project');
const { inferValueType } = require('../dist/checker/type-checker');
const { projectLayout, projectOption, layoutForInput, entryFile, positionalArguments, assertProjectDirectory, ensureProjectDirectory } = require('./project-layout');
const { readStaticVariables } = require('./static-variables');
const { validateGameScreens } = require('../Edit/game-screens');
const screenDocumentCompiler = require('../Edit/screen-document');

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
        const script = await resolveProjectScript(source, scenesRoot, new Set(), relative);
        scripts.push({ script, resolvedFunctions: script.functions, file: relative, source });
        declarationsByFile.set(relative, new Set(script.globals.filter(statement => statement.file === relative && statement.kind === 'declare').map(statement => statement.name)));
        for (const character of script.characters.filter(character => character.file === relative)) {
          if (characterOwners.has(character.name)) throw new Error(`Character '${character.name}' は複数ファイルで宣言されています`);
          characterOwners.set(character.name, relative);
          characters.set(character.name, {
            poses: new Set(character.poses.map(pose => pose.name)),
            fields: Object.fromEntries(character.properties.map(property => [property.name, property.value.kind === 'float' ? 'float' : property.value.kind === 'literal' && typeof property.value.value === 'string' ? 'str' : 'int'])),
            definition: character,
          });
        }
        const implicitGlobals = relative.toLowerCase() === 'main.tds';
        for (const statement of script.globals.filter(statement => statement.file === relative)) {
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
  const pending = scripts.flatMap(({ script, resolvedFunctions, file }) => script.globals.filter(statement => statement.file === file && statement.kind === 'declare' && statement.type === 'infer' && (file.toLowerCase() === 'main.tds' || statement.global)).map(statement => ({ statement, functions: resolvedFunctions, file })));
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
    if (!progress) throw lastError || new Error('グローバル変数の型を推論できません');
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
  // Resolve package keys against the physical scenario root. A configured
  // scenario directory may be an in-project junction, so mixing its lexical
  // path with inside()'s realpath result would manufacture ../ paths.
  const realScenesRoot = await fs.realpath(scenesRoot);
  const canonicalScenePath = async relative => path.relative(realScenesRoot, await inside(scenesRoot, sceneFile(relative))).replaceAll('\\', '/');
  const canonicalizeGotoTargets = async compiled => {
    const localScenes = new Set(compiled.scenes.map(scene => scene.name));
    const visit = async instructions => {
      for (const instruction of instructions || []) {
        if (instruction.op === 'goto' && !localScenes.has(instruction.scene)) instruction.scene = await canonicalScenePath(instruction.scene);
        if (instruction.body) await visit(instruction.body);
        if (instruction.otherwise) await visit(instruction.otherwise);
        for (const branch of instruction.elseIf || []) await visit(branch.body);
        for (const option of instruction.options || []) await visit(option.body);
      }
    };
    await visit(compiled.globals);
    for (const scene of compiled.scenes) await visit(scene.instructions);
  };
  const entryRequest = path.relative(scenesRoot, path.resolve(input)).replaceAll('\\', '/');
  const entry = path.relative(realScenesRoot, await inside(scenesRoot, entryRequest)).replaceAll('\\', '/');
  const pending = scripts.map(({ file }) => file);
  if (!pending.includes(entry)) throw new Error(`開始ファイル '${entry}' が見つかりません`);
  if (roots.requireStartScreenFlow) {
    const startDiagnostics = require('../Edit/start-screen-build-check')(
      new Map(scripts.map(({ file, source }) => [file, source])), entry,
      new Map(scripts.map(({ file, resolvedFunctions }) => [file, resolvedFunctions])),
    );
    if (startDiagnostics.length) {
      const diagnostic = startDiagnostics[0];
      const location = `${diagnostic.file || entry}:${diagnostic.line || 1}:${diagnostic.column || 1}`;
      throw new Error(`警告: ${location} [${diagnostic.code || 'build-warning'}] ${diagnostic.message}`);
    }
  }
  while (pending.length) {
    const file = pending.pop();
    if (Object.hasOwn(files, file)) continue;
    const source = await fs.readFile(await inside(scenesRoot, file), 'utf8');
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
    for (const target of gotos([...p.globals, ...p.scenes.flatMap(s => s.instructions)])) if (!local.has(target)) pending.push(await canonicalScenePath(target));
  }
  for (const compiled of Object.values(files)) await canonicalizeGotoTargets(compiled);
  validateVariableFlow(files, entry);
  const entryGlobals = new Map(globalVariables);
  entryGlobals.readonlyNames = globalVariables.readonlyNames;
  entryGlobals.staticDeclarations = globalVariables.staticDeclarations;
  entryGlobals.constraints = globalVariables.constraints;
  for (const name of declarationsByFile.get(entry) || []) entryGlobals.delete(name);
  const entryCharacters = new Map(characters);
  for (const [name, owner] of characterOwners) if (owner === entry) entryCharacters.delete(name);
  const program = await compileProject(await fs.readFile(await inside(scenesRoot, entry), 'utf8'), assetsRoot, scenesRoot, entryGlobals, entryCharacters, entry, { debug: Boolean(roots.debug) });
  await canonicalizeGotoTargets(program);
  let destination = path.resolve(output);
  if (layout) {
    const relativeParent = path.relative(layout.projectRoot, path.dirname(destination));
    if (!path.isAbsolute(relativeParent) && relativeParent !== '..' && !relativeParent.startsWith('..' + path.sep)) {
      ensureProjectDirectory(layout.projectRoot, path.dirname(destination), '.novel/build');
    }
  }
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const outputRoot = await fs.realpath(path.dirname(destination));
  const destinationFile = path.join(outputRoot, path.basename(destination));
  // The asset tree is project source, including files that are not referenced
  // by this particular build. A custom package path must not silently replace
  // one of those files just because the compiler did not need to copy it.
  const realAssetsRoot = await fs.realpath(assetsRoot);
  const destinationFromAssets = path.relative(realAssetsRoot, destinationFile);
  if (!path.isAbsolute(destinationFromAssets) && destinationFromAssets !== '..' && !destinationFromAssets.startsWith('..' + path.sep)) {
    try {
      const info = await fs.lstat(destinationFile);
      if (info.isFile()) throw Error('Package output cannot overwrite a source file.');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const samePath = (left, right) => path.relative(path.resolve(left), path.resolve(right)) === '';
  const protectedSources = new Set(scripts.map(({ file }) => path.resolve(scenesRoot, file)));
  // Packaging consumes this file to build the project's global variable table.
  // Treat it as an input source just like TDS files so a custom output path
  // cannot silently replace the configuration after it has been read.
  protectedSources.add(path.resolve(dataRoot, 'variables.json'));
  for (const asset of new Set(Object.values(files).flatMap(assetPaths))) {
    const relative = asset.replace(/^asset[\\/]/, '').replaceAll('\\', '/');
    protectedSources.add(path.resolve(assetsRoot, relative));
  }
  const rejectSourceOverwrite = async () => {
    for (const source of protectedSources) {
      if (samePath(source, destinationFile)) throw Error('Package output cannot overwrite a source file.');
      let resolved;
      try { resolved = await fs.realpath(source); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (samePath(resolved, destinationFile)) throw Error('Package output cannot overwrite a source file.');
    }
  };
  await rejectSourceOverwrite();
  const ensureOutputDirectory = async (directory) => {
    const lexical = path.resolve(directory);
    const relative = path.relative(outputRoot, lexical);
    if (path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) throw Error('Package output must be inside the selected directory.');
    let probe = lexical;
    while (true) {
      try {
        const resolved = await fs.realpath(probe);
        const fromRoot = path.relative(outputRoot, resolved);
        if (path.isAbsolute(fromRoot) || fromRoot === '..' || fromRoot.startsWith('..' + path.sep)) throw Error('Package output must be inside the selected directory.');
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
        if (path.isAbsolute(fromRoot) || fromRoot === '..' || fromRoot.startsWith('..' + path.sep)) throw Error('Package output must be inside the selected directory.');
  };
  const assertOutputFile = async (target) => {
    try {
      const info = await fs.lstat(target);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) throw Error('Package output must be a regular file without hard links.');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  };
  await assertOutputFile(destinationFile);
  const stagingRoot = await fs.mkdtemp(path.join(outputRoot, '.novel-pack-stage-'));
  let preserveStagingForRecovery = false;
  destination = path.join(stagingRoot, path.basename(destinationFile));
  try {
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
    protectedSources.add(themeSource);
    await rejectSourceOverwrite();
    const themeTarget = path.resolve(path.dirname(destination), 'asset', nativeUi.native_ui_theme);
    await ensureOutputDirectory(path.dirname(themeTarget));
    await assertOutputFile(themeTarget);
    if (path.resolve(themeSource) !== themeTarget) await fs.copyFile(themeSource, themeTarget);
    const theme = JSON.parse(await fs.readFile(themeSource, 'utf8'));
    if (theme.version !== 1) throw Error('未対応のNative UIテーマバージョンです');
    const themeDirectory = path.posix.dirname(nativeUi.native_ui_theme.replaceAll('\\', '/'));
    const themedImagePath = (imageName, directory = themeDirectory) => {
      const normalized = imageName.replaceAll('\\', '/').replace(/^\.\//, '');
      return directory && directory !== '.' && (normalized === directory || normalized.startsWith(`${directory}/`))
        ? normalized
        : path.posix.join(directory, normalized);
    };
    const themedImageNames = [theme?.dialog?.image, theme?.dialog?.nameplate?.image, theme?.choices?.image, theme?.choices?.activeImage].filter((value) => typeof value === 'string' && value.length > 0);
    const controlImageNames = (theme?.controls?.buttons || []).flatMap(button => [button.image, button.hoverImage]).filter((value) => typeof value === 'string' && value.length > 0);
    // New-layout themes live under setting/, so Browser references are rooted
    // at asset/. Legacy themes live under asset/ui/ and resolve images beside
    // the theme. Native packages always place the theme under asset/ui/.
    const sourceThemeDirectory = layout.legacySettings ? themeDirectory : '.';
    for (const imageName of new Set([...themedImageNames, ...controlImageNames])) {
      const sourceRelative = themedImagePath(imageName, sourceThemeDirectory);
      const targetRelative = themedImagePath(imageName);
      const source = await inside(assetsRoot, sourceRelative);
      const target = path.resolve(path.dirname(destination), 'asset', targetRelative);
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
      protectedSources.add(screensSource);
      let screens = withSaveLoadScreens(validateGameScreens(JSON.parse(await fs.readFile(screensSource, 'utf8'))));
      if (!layout.legacySettings) {
        let display = screenDocumentCompiler.DEFAULT_CANVAS;
        if (layout.settings.native_ui_theme) {
          const themePath = await inside(layout.settingsRoot, layout.settings.native_ui_theme);
          const theme = JSON.parse(await fs.readFile(themePath, 'utf8'));
          display = theme.screen;
        }
        screens.canvas = { width: display.width, height: display.height };
      }
      const references = new Set([screens.stylesheet, screens.controlSettings, ...Object.values(screens.screens).map(screen => screen.template)].filter(Boolean));
      const documents = {};
      for (const reference of references) {
        const normalized = String(reference).replaceAll('\\', '/');
        const extension = path.posix.extname(normalized).toLowerCase();
        if (!normalized.startsWith('screens/') || normalized.split('/').some(part => !part || part === '.' || part === '..') || !['.html', '.css', '.txt'].includes(extension) || reference === screens.stylesheet && extension !== '.css' || reference === screens.controlSettings && extension !== '.txt' || Object.values(screens.screens).some(screen => screen.template === reference) && extension !== '.html') throw new Error(`画面文書のパスが不正です: ${reference}`);
        const documentPath = await inside(layout.settingsRoot, normalized);
        protectedSources.add(documentPath);
        await rejectSourceOverwrite();
        documents[reference] = await fs.readFile(documentPath, 'utf8');
      }
      screens = screenDocumentCompiler.compileGameScreens(screens, documents, screens.canvas);
      if (screens.saveId) nativeUi.save_id = screens.saveId;
      nativeUi.game_screens = 'ui/game-screens.json';
      for (const screen of Object.values(screens.screens)) {
        const imageNames = [screen.background === undefined ? screens.defaultBackground : screen.background, screen.slotStyle?.image, screen.slotStyle?.hoverImage, ...screen.items.flatMap(item => [item.image || '', item.hoverImage || ''])].filter(Boolean);
        const collectTreeImages = node => {
          if (node.attrs?.src) imageNames.push(node.attrs.src);
          const image = node.style?.['background-image'] || (String(node.style?.background || '').startsWith('url(') ? node.style.background : '');
          for (const match of image.matchAll(/url\(["']?([^"')]+)["']?\)/g)) imageNames.push(match[1]);
          for (const stateStyle of [node.hoverStyle, node.focusStyle, node.focusVisibleStyle]) {
            const stateImage = stateStyle?.['background-image'] || (String(stateStyle?.background || '').startsWith('url(') ? stateStyle.background : '');
            for (const match of stateImage.matchAll(/url\(["']?([^"')]+)["']?\)/g)) imageNames.push(match[1]);
          }
          for (const key of ['track', 'fill', 'thumb', 'thumbHover', 'off', 'on', 'offHover', 'onHover']) {
            if (node.controlSkin?.[key]) imageNames.push(node.controlSkin[key]);
          }
          for (const child of node.children || []) collectTreeImages(child);
        };
        for (const node of screen.uiTree || []) collectTreeImages(node);
        for (const imageName of new Set(imageNames)) {
          // Screen CSS/HTML renderers treat only the literal `asset/` prefix
          // as an alias. Preserve case-sensitive asset-root path segments such
          // as `Asset/` so Browser and Native resolve the same file.
          const relative = imageName.replace(/^asset[\\/]/, '').replaceAll('\\', '/');
          const imageSource = await inside(assetsRoot, relative);
          protectedSources.add(imageSource);
          protectedSources.add(path.resolve(outputRoot, 'asset', relative));
          await rejectSourceOverwrite();
          const imageTarget = path.resolve(path.dirname(destination), 'asset', relative);
          await ensureOutputDirectory(path.dirname(imageTarget));
          await assertOutputFile(imageTarget);
          if (path.resolve(imageSource) !== imageTarget) await fs.copyFile(imageSource, imageTarget);
        }
      }
      // Commit the compiled screen manifest only after every referenced image
      // has been resolved and copied. A missing screen image must not leave a
      // seemingly usable game-screens.json beside an incomplete package.
      const target = path.resolve(path.dirname(destination), 'asset', 'ui', 'game-screens.json');
      await ensureOutputDirectory(path.dirname(target));
      await assertOutputFile(target);
      if (layout.legacySettings) {
        if (path.resolve(screensSource) !== target) await fs.copyFile(screensSource, target);
      } else {
        await fs.writeFile(target, `${JSON.stringify(screens, null, 2)}\n`, 'utf8');
      }
    }
  }
  const data = { format: 'novel-script-package', version: 1, source: entry, ...(roots.debug ? { debug: true } : {}), program, files, native_ui: nativeUi };
  await rejectSourceOverwrite();
  await assertOutputFile(destination);
  await fs.writeFile(destination, JSON.stringify(data, null, 2) + '\n', 'utf8');
  const stagedFiles = [];
  const collectStagedFiles = async (directory, prefix = '') => {
    for (const item of await fs.readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${item.name}` : item.name;
      const file = path.join(directory, item.name);
      if (item.isDirectory()) await collectStagedFiles(file, relative);
      else if (item.isFile()) stagedFiles.push(relative);
      else throw Error('Package staging contains an unsupported file type.');
    }
  };
  await collectStagedFiles(stagingRoot);
  stagedFiles.sort();
  const committed = [];
  const backupRoot = path.join(stagingRoot, '.rollback');
  try {
    for (const relative of stagedFiles) {
      const actual = path.resolve(outputRoot, relative);
      const staged = path.resolve(stagingRoot, relative);
      await ensureOutputDirectory(path.dirname(actual));
      await assertOutputFile(actual);
      const record = { actual, installed: false, backup: null };
      try {
        await fs.lstat(actual);
        const backup = path.join(backupRoot, relative);
        await fs.mkdir(path.dirname(backup), { recursive: true });
        await fs.rename(actual, backup);
        record.backup = backup;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      committed.push(record);
      await fs.rename(staged, actual);
      record.installed = true;
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const record of committed.reverse()) {
      try {
        if (record.installed) await fs.rm(record.actual, { force: true });
        if (record.backup) await fs.rename(record.backup, record.actual);
      } catch (rollbackError) { rollbackErrors.push(rollbackError.message); }
    }
    if (rollbackErrors.length) {
      preserveStagingForRecovery = true;
      error.message = `${error.message}; output rollback failed: ${rollbackErrors.join('; ')}; recovery files remain at ${stagingRoot}`;
    }
    throw error;
  }
  return data;
  } finally {
    if (!preserveStagingForRecovery) await fs.rm(stagingRoot, { recursive: true, force: true });
  }
}
module.exports = { pack, validateVariableFlow };
if (require.main === module) {
  const args = process.argv.slice(2), debug = args.includes('--debug'), positional = positionalArguments(args.filter(arg => arg !== '--debug'));
  const selected = projectOption(args);
  const layout = selected ? projectLayout(selected) : positional[0] ? layoutForInput(positional[0]) : projectLayout();
  const input = positional[0] || entryFile(layout);
  const output = positional[1] || path.join(layout.buildRoot, path.basename(input, path.extname(input)) + '.nsp.json');
  pack(input, output, { projectRoot: layout.projectRoot, debug, requireStartScreenFlow: true }).then(() => console.log(`Packed ${input} -> ${output}${debug ? ' (debug)' : ''}`)).catch(e => { console.error(`Package creation failed: ${e.message}`); process.exitCode = 1; });
}
