'use strict';
const path = require('node:path');
const fs = require('node:fs');
const defaultRoot = path.resolve(__dirname, '../Title');
const SETTING_FILE = 'setting.txt';
const DEFAULT_SETTINGS = Object.freeze({ scenario_dir: 'senario', asset_dir: 'asset', start_file: 'main.tds', native_ui_theme: '' });
function safeRelative(value, key) {
  const text = String(value || '').trim().replaceAll('\\', '/');
  if (!text || path.posix.isAbsolute(text) || path.win32.isAbsolute(text) || /^[A-Za-z]:/.test(text) || text.split('/').some((part) => !part || part === '.' || part === '..')) throw Error(`${key} は作品フォルダー内の相対パスを指定してください`);
  return text;
}
function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
}
function assertProjectDirectory(projectRoot, directory, key) {
  const lexicalRoot = path.resolve(projectRoot);
  const target = path.resolve(directory);
  if (!isInside(lexicalRoot, target)) throw Error(`${key} は作品フォルダー内を指定してください`);
  const realRoot = fs.realpathSync(projectRoot);
  const realTarget = fs.realpathSync(target);
  if (!isInside(realRoot, realTarget)) throw Error(`${key} は作品フォルダー外を参照できません`);
  return realTarget;
}
function assertProjectSettingFile(projectRoot) {
  const settingFile = path.join(projectRoot, SETTING_FILE);
  const info = fs.lstatSync(settingFile);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) throw Error('setting.txt はプロジェクト内の通常ファイルである必要があります');
  const realRoot = fs.realpathSync(projectRoot);
  const realFile = fs.realpathSync(settingFile);
  if (!isInside(realRoot, realFile)) throw Error('setting.txt はプロジェクト外を参照できません');
  return settingFile;
}
function ensureProjectFile(projectRoot, file, contents, label) {
  const validate = () => {
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) throw Error(`${label} は作品フォルダー内の通常ファイルである必要があります`);
    const realFile = fs.realpathSync(file);
    if (!isInside(fs.realpathSync(projectRoot), realFile)) throw Error(`${label} は作品フォルダー外を参照できません`);
  };
  try { validate(); return; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { fs.writeFileSync(file, contents, { encoding: 'utf8', flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  validate();
}
function ensureProjectDirectory(projectRoot, directory, key) {
  const lexicalRoot = path.resolve(projectRoot);
  const target = path.resolve(directory);
  if (!isInside(lexicalRoot, target)) throw Error(`${key} は作品フォルダー内のパスを指定してください`);
  const realRoot = fs.realpathSync(projectRoot);
  let probe = target;
  while (true) {
    try {
      if (!isInside(realRoot, fs.realpathSync(probe))) throw Error(`${key} は作品フォルダー外を参照できません`);
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(probe);
      if (parent === probe) throw error;
      probe = parent;
    }
  }
  fs.mkdirSync(target, { recursive: true });
  if (!isInside(realRoot, fs.realpathSync(target))) throw Error(`${key} は作品フォルダー外を参照できません`);
}
function parseSettings(source) {
  const settings = {};
  const seen = new Set();
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const match = /^([a-z][a-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) throw Error(`setting.txt の記法が不正です: ${raw}`);
    const [, key, value] = match;
    if (!Object.hasOwn(DEFAULT_SETTINGS, key) && key !== 'title') throw Error(`setting.txt の設定項目 '${key}' は未対応です`);
    settings[key] = value;
    seen.add(key);
  }
  if (['scenario_dir', 'asset_dir', 'start_file'].some((key) => !seen.has(key))) throw Error('setting.txt requires scenario_dir, asset_dir, and start_file');
  settings.scenario_dir = safeRelative(settings.scenario_dir, 'scenario_dir');
  settings.asset_dir = safeRelative(settings.asset_dir, 'asset_dir');
  settings.start_file = safeRelative(settings.start_file, 'start_file');
  if (settings.native_ui_theme) settings.native_ui_theme = safeRelative(settings.native_ui_theme, 'native_ui_theme');
  if (!/\.tds$/i.test(settings.start_file)) throw Error('start_file は .tds を指定してください');
  return settings;
}
function readSettings(projectRoot) {
  const settingFile = path.join(projectRoot, SETTING_FILE);
  assertProjectSettingFile(projectRoot);
  return parseSettings(fs.readFileSync(settingFile, 'utf8'));
}
function settingTemplate(title) {
  return `# Novel Script project settings\n# すべて作品フォルダーからの相対パス。/ を使用する。\nscenario_dir = senario\nasset_dir = asset\nstart_file = main.tds\ntitle = ${title}\n`;
}
function projectOption(args = []) {
  const index = args.indexOf('--project');
  if (index >= 0 && (!args[index + 1] || args[index + 1].startsWith('--'))) throw Error('--project に作品フォルダーを指定してください');
  return index >= 0 ? args[index + 1] : process.env.NOVEL_PROJECT_ROOT;
}
function projectLayout(root = projectOption() || defaultRoot) {
  const projectRoot = path.resolve(root);
  const settings = readSettings(projectRoot);
  return { projectRoot, settingFile: path.join(projectRoot, SETTING_FILE), settings, title: settings.title || path.basename(projectRoot), scenesRoot: path.join(projectRoot, settings.scenario_dir), assetsRoot: path.join(projectRoot, settings.asset_dir), dataRoot: path.join(projectRoot, '.novel'), buildRoot: path.join(projectRoot, '.novel', 'build') };
}
function layoutForInput(input) {
  const file = path.resolve(input);
  let directory = path.dirname(file);
  while (directory !== path.dirname(directory)) {
    if (!fs.existsSync(path.join(directory, SETTING_FILE))) { directory = path.dirname(directory); continue; }
    const layout = projectLayout(directory);
    const relative = path.relative(layout.scenesRoot, file);
    if (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep)) return layout;
    directory = path.dirname(directory);
  }
  throw Error('シナリオは setting.txt の scenario_dir 内を指定してください');
}
function entryFile(layout) {
  const file = path.resolve(layout.scenesRoot, layout.settings.start_file);
  const relative = path.relative(layout.scenesRoot, file);
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) throw Error('start_file は scenario_dir 内を指定してください');
  return file;
}
function positionalArguments(args) {
  const result = [];
  for (let i = 0; i < args.length; i++) { if (args[i] === '--project') i++; else result.push(args[i]); }
  return result;
}
function looksLikeProject(root) {
  return fs.existsSync(path.join(path.resolve(root), SETTING_FILE));
}
function seedEmptyProject(root) {
  const projectRoot = path.resolve(root);
  const settingFile = path.join(projectRoot, SETTING_FILE);
  fs.mkdirSync(projectRoot, { recursive: true });
  ensureProjectFile(projectRoot, settingFile, settingTemplate(path.basename(projectRoot)), 'setting.txt');
  const layout = projectLayout(projectRoot);
  ensureProjectDirectory(layout.projectRoot, layout.scenesRoot, 'scenario_dir');
  ensureProjectDirectory(layout.projectRoot, layout.assetsRoot, 'asset_dir');
  ensureProjectDirectory(layout.projectRoot, layout.dataRoot, '.novel');
  for (const kind of ['bg', 'bgm', 'char', 'image', 'se', 'video', 'voice']) {
    const directory = path.join(layout.assetsRoot, kind);
    ensureProjectDirectory(layout.projectRoot, directory, 'asset_dir');
    const readme = path.join(directory, 'README.txt');
    ensureProjectFile(layout.projectRoot, readme, `${kind} assets\n`, 'asset README');
  }
  const main = path.join(layout.scenesRoot, 'main.tds');
  ensureProjectFile(layout.projectRoot, main, 'scene main {\n  say narrator "新しい作品を始めます。"\n}\n', 'main.tds');
  return layout;
}
module.exports = { projectLayout, projectOption, layoutForInput, entryFile, positionalArguments, looksLikeProject, seedEmptyProject, parseSettings, settingTemplate, assertProjectSettingFile, assertProjectDirectory, ensureProjectDirectory };
