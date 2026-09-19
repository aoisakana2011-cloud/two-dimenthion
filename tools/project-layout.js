'use strict';
const path = require('node:path');
const fs = require('node:fs');
const defaultRoot = path.resolve(__dirname, '../Title');
const SETTING_FILE = 'setting.txt';
const DEFAULT_SETTINGS = Object.freeze({ scenario_dir: 'senario', asset_dir: 'asset', start_file: 'main.tds', native_ui_theme: '' });
function safeRelative(value, key) {
  const text = String(value || '').trim().replaceAll('\\', '/');
  if (!text || path.posix.isAbsolute(text) || text.split('/').some((part) => !part || part === '.' || part === '..')) throw Error(`${key} は作品フォルダー内の相対パスを指定してください`);
  return text;
}
function parseSettings(source) {
  const settings = { ...DEFAULT_SETTINGS };
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const match = /^([a-z][a-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) throw Error(`setting.txt の記法が不正です: ${raw}`);
    const [, key, value] = match;
    if (!Object.hasOwn(DEFAULT_SETTINGS, key) && key !== 'title') throw Error(`setting.txt の設定項目 '${key}' は未対応です`);
    settings[key] = value;
  }
  settings.scenario_dir = safeRelative(settings.scenario_dir, 'scenario_dir');
  settings.asset_dir = safeRelative(settings.asset_dir, 'asset_dir');
  settings.start_file = safeRelative(settings.start_file, 'start_file');
  if (settings.native_ui_theme) settings.native_ui_theme = safeRelative(settings.native_ui_theme, 'native_ui_theme');
  if (!/\.(tds|txt)$/i.test(settings.start_file)) throw Error('start_file は .tds または .txt を指定してください');
  return settings;
}
function readSettings(projectRoot) {
  const settingFile = path.join(projectRoot, SETTING_FILE);
  if (fs.existsSync(settingFile)) return parseSettings(fs.readFileSync(settingFile, 'utf8'));
  return { ...DEFAULT_SETTINGS };
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
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) throw Error('start_scene は senario 内を指定してください');
  return file;
}
function positionalArguments(args) {
  const result = [];
  for (let i = 0; i < args.length; i++) { if (args[i] === '--project') i++; else result.push(args[i]); }
  return result;
}
function looksLikeProject(root) {
  const layout = projectLayout(root);
  return fs.existsSync(layout.settingFile) || fs.existsSync(layout.scenesRoot) || fs.existsSync(layout.assetsRoot) || fs.existsSync(layout.dataRoot);
}
function seedEmptyProject(root) {
  const layout = projectLayout(root);
  if (!fs.existsSync(layout.settingFile)) {
    fs.mkdirSync(layout.projectRoot, { recursive: true });
    fs.writeFileSync(layout.settingFile, settingTemplate(path.basename(layout.projectRoot)), 'utf8');
    return seedEmptyProject(root);
  }
  fs.mkdirSync(layout.scenesRoot, { recursive: true });
  fs.mkdirSync(layout.assetsRoot, { recursive: true });
  fs.mkdirSync(layout.dataRoot, { recursive: true });
  for (const kind of ['bg', 'bgm', 'char', 'image', 'se', 'video', 'voice']) {
    const directory = path.join(layout.assetsRoot, kind);
    fs.mkdirSync(directory, { recursive: true });
    const readme = path.join(directory, 'README.txt');
    if (!fs.existsSync(readme)) fs.writeFileSync(readme, `${kind} assets\n`, 'utf8');
  }
  const main = path.join(layout.scenesRoot, 'main.tds');
  if (!fs.existsSync(main)) fs.writeFileSync(main, 'scene main {\n  say narrator "新しい作品を始めます。"\n}\n', 'utf8');
  return layout;
}
module.exports = { projectLayout, projectOption, layoutForInput, entryFile, positionalArguments, looksLikeProject, seedEmptyProject, parseSettings, settingTemplate };
