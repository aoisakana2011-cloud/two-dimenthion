'use strict';
const path = require('node:path');
const fs = require('node:fs');
const defaultRoot = path.resolve(__dirname, '../Title');
const SETTINGS_DIRECTORY = 'setting';
const SETTING_FILE = 'setting.txt';
const LEGACY_SETTING_FILE = 'setting.txt';
const DEFAULT_SETTINGS = Object.freeze({ scenario_dir: 'senario', asset_dir: 'asset', start_file: 'main.tds', native_ui_theme: '' });
function safeRelative(value, key) {
  const text = String(value || '').trim().replaceAll('\\', '/');
  const parts = text.split('/');
  const invalidPart = part => !part || part === '.' || part === '..'
    || /[<>:\"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part);
  if (!text || path.posix.isAbsolute(text) || path.win32.isAbsolute(text) || /^[A-Za-z]:/.test(text) || parts.some(invalidPart)) throw Error(`${key}には安全な作品相対パスを指定してください`);
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
  const nestedSettingFile = path.join(projectRoot, SETTINGS_DIRECTORY, SETTING_FILE);
  const settingFile = fs.existsSync(nestedSettingFile) ? nestedSettingFile : path.join(projectRoot, LEGACY_SETTING_FILE);
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
    const commentStart = raw.search(/(?<!\\)#/);
    const line = (commentStart < 0 ? raw : raw.slice(0, commentStart)).replaceAll('\\#', '#').trim();
    if (!line) continue;
    const match = /^([a-z][a-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) throw Error(`setting.txt の記法が不正です: ${raw}`);
    const [, key, value] = match;
    if (!Object.hasOwn(DEFAULT_SETTINGS, key) && key !== 'title') throw Error(`setting.txt の設定項目 '${key}' は未対応です`);
    if (seen.has(key)) throw Error(`setting.txt の設定項目 '${key}' が重複しています`);
    settings[key] = value;
    seen.add(key);
  }
  if (['scenario_dir', 'asset_dir', 'start_file'].some((key) => !seen.has(key))) throw Error('setting.txtにはscenario_dir、asset_dir、start_fileが必要です');
  settings.scenario_dir = safeRelative(settings.scenario_dir, 'scenario_dir');
  settings.asset_dir = safeRelative(settings.asset_dir, 'asset_dir');
  settings.start_file = safeRelative(settings.start_file, 'start_file');
  if (settings.native_ui_theme) settings.native_ui_theme = safeRelative(settings.native_ui_theme, 'native_ui_theme');
  if (!/\.tds$/i.test(settings.start_file)) throw Error('start_file は .tds を指定してください');
  return settings;
}
function readSettings(projectRoot) {
  const settingFile = assertProjectSettingFile(projectRoot);
  return parseSettings(fs.readFileSync(settingFile, 'utf8'));
}
function settingTemplate(title) {
  const escapedTitle = String(title).replaceAll('#', '\\#');
  return `# Novel Scriptのプロジェクト設定\n# パスは作品フォルダーからの相対パスで、区切りには / を使います。\nscenario_dir = senario\nasset_dir = asset\nstart_file = main.tds\ntitle = ${escapedTitle}\n`;
}
function projectOption(args = []) {
  const index = args.indexOf('--project');
  if (index >= 0 && (!args[index + 1] || args[index + 1].startsWith('--'))) throw Error('--project に作品フォルダーを指定してください');
  return index >= 0 ? args[index + 1] : process.env.NOVEL_PROJECT_ROOT;
}
function projectLayout(root = projectOption() || defaultRoot) {
  const projectRoot = path.resolve(root);
  const settings = readSettings(projectRoot);
  const settingFile = assertProjectSettingFile(projectRoot);
  return { projectRoot, settingsRoot: path.dirname(settingFile), settingFile, legacySettings: path.dirname(settingFile) === projectRoot, settings, title: settings.title || path.basename(projectRoot), scenesRoot: path.join(projectRoot, settings.scenario_dir), assetsRoot: path.join(projectRoot, settings.asset_dir), dataRoot: path.join(projectRoot, '.novel'), buildRoot: path.join(projectRoot, '.novel', 'build') };
}
function layoutForInput(input) {
  const file = path.resolve(input);
  let directory = path.dirname(file);
  while (directory !== path.dirname(directory)) {
    if (!looksLikeProject(directory)) { directory = path.dirname(directory); continue; }
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
  const projectRoot = path.resolve(root);
  return fs.existsSync(path.join(projectRoot, SETTINGS_DIRECTORY, SETTING_FILE)) || fs.existsSync(path.join(projectRoot, LEGACY_SETTING_FILE));
}
function seedEmptyProject(root) {
  const projectRoot = path.resolve(root);
  const settingsRoot = path.join(projectRoot, SETTINGS_DIRECTORY);
  const settingFile = path.join(settingsRoot, SETTING_FILE);
  fs.mkdirSync(projectRoot, { recursive: true });
  ensureProjectDirectory(projectRoot, settingsRoot, SETTINGS_DIRECTORY);
  if (!fs.existsSync(path.join(projectRoot, LEGACY_SETTING_FILE))) ensureProjectFile(projectRoot, settingFile, settingTemplate(path.basename(projectRoot)), 'setting/setting.txt');
  const layout = projectLayout(projectRoot);
  ensureProjectDirectory(layout.projectRoot, layout.scenesRoot, 'scenario_dir');
  ensureProjectDirectory(layout.projectRoot, layout.assetsRoot, 'asset_dir');
  ensureProjectDirectory(layout.projectRoot, layout.dataRoot, '.novel');
  ensureProjectFile(projectRoot, path.join(settingsRoot, 'README.md'), [
    '# Project settings and conventions', '',
    '`setting/` is the single editable home for project rules and presentation configuration.', '',
    '- `setting.txt`: project title, entry scenario, scenario/assets directories, and player UI config path.',
    '- `player-ui.json`: dialogue window, nameplate, choices, and display geometry.',
    '- `game-screens.json`: title, load/menu, and other front-end screens.',
    '- `asset-folders.txt`: asset folder purpose and path conventions.',
    '- `story-adaptation.md` (optional): work-specific adaptation/story agreements.',
    '- `.novel/`: generated compiler indexes and build outputs; do not hand-edit generated files.', '',
    'Paths in `setting.txt` are project-root relative. Paths to images in screen/UI JSON are relative to the project asset folder.',
    'The display canvas size is owned by `player-ui.json`; `game-screens.json` reuses it and does not store another width/height pair.',
    '`player-ui.json` may define `controls` (`enabled`, `anchor`, `buttons`) for Save/Load buttons above the dialogue. Each button supports pixel geometry, text/image/both display, normal/hover labels, images, and colors.',
    '`game-screens.json` uses the initial screen when main.tds calls start(). New projects include a Start screen; put startup video or demo commands before start() in main.tds and story commands after it or in a later scene.',
    '`game-screens.json` screens may use `role: \"save-slots\"` or `\"load-slots\"`;  `slotLayout` and `slotStyle` control the slot list. Missing slot screens and Pause-menu actions are supplied as defaults for older projects.',
    'The entry scene is selected by `start_file`. Put title sequencing in main.tds and call start() to display the configured initial screen.',
    'Browser Save/Load slots use browser storage scoped to the project; Test-play has its own namespace. Native Save/Load uses the operating system user-data folder (or `NOVEL_SAVE_ROOT` when configured), so moving the package does not move its saves.',
    'The editor exposes text, Markdown, and JSON files in this folder under Explorer → `setting/`.', '',
  ].join('\n'), 'setting README');
  ensureProjectFile(projectRoot, path.join(settingsRoot, 'asset-folders.txt'), [
    'Asset folder conventions', '', 'bg/     backgrounds', 'char/   character portraits and poses',
    'bgm/    background music', 'se/     sound effects', 'voice/  dialogue voice clips',
    'image/  general images', 'video/  video clips', 'ui/     optional UI artwork (image paths remain asset-relative)', '',
  ].join('\n'), 'asset folder conventions');
  for (const kind of ['bg', 'bgm', 'char', 'image', 'se', 'video', 'voice']) {
    const directory = path.join(layout.assetsRoot, kind);
    ensureProjectDirectory(layout.projectRoot, directory, 'asset_dir');
  }
  ensureProjectFile(projectRoot, path.join(layout.assetsRoot, 'bg', 'README.txt'), [
    'Background assets', '',
    'Place background images in this folder. Reference them by asset name in scenario commands.',
    'Supported formats: PNG, JPG, JPEG, WebP, GIF.', '',
  ].join('\n'), 'background asset guide');
  const main = path.join(layout.scenesRoot, 'main.tds');
  ensureProjectFile(layout.projectRoot, main, 'scene main {\n  # Play an intro video or demo before opening the title screen.\n  start()\n  goto story\n}\n\nscene story {\n  say narrator "Write your story here."\n  goto main\n}\n', 'main.tds');
  ensureProjectFile(layout.projectRoot, path.join(layout.settingsRoot, 'game-screens.json'), JSON.stringify({ version: 1, initial: 'title', screens: { title: { title: '', background: '', items: [{ id: 'start', type: 'button', label: 'Start', action: 'start', x: 64, y: 150, width: 300, height: 56 }] } } }, null, 2) + '\n', 'game-screens.json');
  return layout;
}
module.exports = { projectLayout, projectOption, layoutForInput, entryFile, positionalArguments, looksLikeProject, seedEmptyProject, parseSettings, settingTemplate, assertProjectSettingFile, assertProjectDirectory, ensureProjectDirectory };
