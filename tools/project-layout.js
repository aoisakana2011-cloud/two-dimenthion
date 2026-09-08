'use strict';
const path = require('node:path');
const fs = require('node:fs');
const defaultRoot = path.resolve(__dirname, '../Title');
function projectOption(args = []) {
  const index = args.indexOf('--project');
  if (index >= 0 && (!args[index + 1] || args[index + 1].startsWith('--'))) throw Error('--project に作品フォルダーを指定してください');
  return index >= 0 ? args[index + 1] : process.env.NOVEL_PROJECT_ROOT;
}
function projectLayout(root = projectOption() || defaultRoot) {
  const projectRoot = path.resolve(root);
  return { projectRoot, title: path.basename(projectRoot), scenesRoot: path.join(projectRoot, 'senario'), assetsRoot: path.join(projectRoot, 'asset'), dataRoot: path.join(projectRoot, '.novel'), buildRoot: path.join(projectRoot, '.novel', 'build') };
}
function layoutForInput(input) {
  let directory = path.dirname(path.resolve(input));
  while (directory !== path.dirname(directory)) {
    if (path.basename(directory).toLowerCase() === 'senario') return projectLayout(path.dirname(directory));
    directory = path.dirname(directory);
  }
  throw Error('シナリオは作品フォルダーの senario 内を指定してください');
}
function entryFile(layout) {
  const config = path.join(layout.scenesRoot, 'config.txt');
  const source = fs.existsSync(config) ? fs.readFileSync(config, 'utf8') : '';
  const name = source.match(/^\s*start_scene\s*=\s*(.+?)\s*$/m)?.[1] || 'main.tds';
  const file = path.resolve(layout.scenesRoot, name);
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
  return fs.existsSync(layout.scenesRoot) || fs.existsSync(layout.assetsRoot) || fs.existsSync(layout.dataRoot);
}
function seedEmptyProject(root) {
  const layout = projectLayout(root);
  fs.mkdirSync(layout.scenesRoot, { recursive: true });
  fs.mkdirSync(layout.assetsRoot, { recursive: true });
  fs.mkdirSync(layout.dataRoot, { recursive: true });
  for (const kind of ['bg', 'bgm', 'char', 'image', 'se', 'video', 'voice']) {
    const directory = path.join(layout.assetsRoot, kind);
    fs.mkdirSync(directory, { recursive: true });
    const readme = path.join(directory, 'README.txt');
    if (!fs.existsSync(readme)) fs.writeFileSync(readme, `${kind} assets\n`, 'utf8');
  }
  const config = path.join(layout.scenesRoot, 'config.txt');
  if (!fs.existsSync(config)) fs.writeFileSync(config, `# Scene project settings\nstart_scene = main.tds\ntitle = ${layout.title}\n`, 'utf8');
  const main = path.join(layout.scenesRoot, 'main.tds');
  if (!fs.existsSync(main)) fs.writeFileSync(main, 'scene main {\n  say narrator "新しい作品を始めます。"\n}\n', 'utf8');
  return layout;
}
module.exports = { projectLayout, projectOption, layoutForInput, entryFile, positionalArguments, looksLikeProject, seedEmptyProject };
