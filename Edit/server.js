/* Local-only editor server. Project data is separate from editor files. */
const http = require('node:http');
const { spawn } = require('node:child_process');
const { compileProject, resolveProjectScript, projectContext, inside } = require('../tools/project');
const { pack } = require('../tools/pack');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');

const EDIT_ROOT = __dirname;
const REPO_ROOT = path.resolve(EDIT_ROOT, '..');
const RECENT_FILE = path.join(os.homedir(), '.novel-editor', 'recent.json');
const { projectLayout, projectOption, looksLikeProject, seedEmptyProject, parseSettings, settingTemplate, assertProjectSettingFile } = require('../tools/project-layout');
const { readStaticVariables } = require('../tools/static-variables');
let layout = projectLayout(projectOption(require.main === module ? process.argv.slice(2) : []));
let PROJECT_ROOT = layout.projectRoot;
let SCENES_ROOT = layout.scenesRoot;
let SETTING_FILE = layout.settingFile;
let DATA_ROOT = layout.dataRoot;
let ASSETS_ROOT = layout.assetsRoot;
let NATIVE_PACKAGES_ROOT = layout.buildRoot;
const CATALOG_FILE = path.join(EDIT_ROOT, 'catalog.txt');
const NATIVE_EXE = path.join(REPO_ROOT, 'native', 'build', 'Release', 'novel_player.exe');
const IMAGE_CHECK_EXE = path.join(REPO_ROOT, 'native', 'build', 'Release', 'check_image.exe');
let nativeBuildInFlight = null;

function bindLayout(root) {
  layout = projectLayout(root);
  PROJECT_ROOT = layout.projectRoot;
  SCENES_ROOT = layout.scenesRoot;
  SETTING_FILE = layout.settingFile;
  DATA_ROOT = layout.dataRoot;
  ASSETS_ROOT = layout.assetsRoot;
  NATIVE_PACKAGES_ROOT = layout.buildRoot;
  return layout;
}
const INITIAL_PORT = Number(process.env.PORT || 4173);
const MAX_PORT_ATTEMPTS = 10;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set(['.tds']);
const CONTENT_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};
const HIDDEN_BROWSE = new Set(['$recycle.bin', 'system volume information', 'node_modules']);
const DEFAULT_PLAYER_UI_THEME = Object.freeze({
  version: 1,
  screen: {
    width: 1280,
    height: 720,
    backdrop: { bottomFog: { enabled: false, color: [255, 250, 253, 255], height: 300 } },
  },
  dialog: {
    image: '', x: 48, y: 500, width: 1184, height: 190,
    message: { x: 28, y: 48, width: 1128, height: 112, size: 24, color: [255, 255, 255, 255] },
    nameplate: {
      x: 24, y: -46, width: 240, height: 40, image: '',
      text: { x: 0, y: 0, width: 240, height: 40, size: 22, color: [255, 255, 255, 255] },
    },
  },
  choices: {
    x: 330, y: 220, width: 620, height: 240, itemHeight: 48, gap: 10, image: '', activeImage: '',
    text: { x: 24, y: 0, width: 572, height: 48, size: 20, color: [255, 255, 255, 255] },
  },
});

function isEditorTree(root) {
  const resolved = path.resolve(root);
  return resolved === EDIT_ROOT || resolved === REPO_ROOT;
}

async function readRecentProjects() {
  try {
    const data = JSON.parse(await fs.readFile(RECENT_FILE, 'utf8'));
    const paths = Array.isArray(data?.paths) ? data.paths : [];
    const existing = [];
    for (const entry of paths) {
      if (typeof entry !== 'string' || !entry.trim()) continue;
      try {
        const stat = await fs.stat(entry);
        if (stat.isDirectory()) existing.push(path.resolve(entry));
      } catch { /* skip missing folders */ }
    }
    return [...new Set(existing)].slice(0, 12);
  } catch {
    return [];
  }
}

async function rememberProject(root) {
  const resolved = path.resolve(root);
  const paths = [resolved, ...(await readRecentProjects()).filter((entry) => entry !== resolved)].slice(0, 12);
  await fs.mkdir(path.dirname(RECENT_FILE), { recursive: true });
  await fs.writeFile(RECENT_FILE, JSON.stringify({ paths }, null, 2) + '\n', 'utf8');
  return paths;
}

async function projectInfo() {
  return { title: layout.title, projectRoot: PROJECT_ROOT, settings: layout.settings, recent: await readRecentProjects() };
}

async function playerUiTheme() {
  if (!layout.settings.native_ui_theme) {
    return { path: '', theme: JSON.parse(JSON.stringify(DEFAULT_PLAYER_UI_THEME)) };
  }
  const theme = JSON.parse(await fs.readFile(await safeAssetPath(layout.settings.native_ui_theme), 'utf8'));
  if (theme.version !== 1 || !theme.screen || !theme.dialog?.message || !theme.dialog?.nameplate?.text || !theme.choices) throw Error('再生機UIテーマは現行のscreen/dialog/choices形式で指定してください');
  return { path: layout.settings.native_ui_theme, theme };
}

async function playerUiThemeWriteFile() {
  if (!layout.settings.native_ui_theme) await updateProjectSettings({ native_ui_theme: 'ui/player-ui.json' });
  return safeAssetPath(layout.settings.native_ui_theme, { createParents: true });
}

async function updatePlayerUiTheme(theme) {
  if (theme?.version === 1 && theme.screen && theme.dialog?.message && theme.dialog?.nameplate?.text && theme.choices) {
    await fs.writeFile(await playerUiThemeWriteFile(), JSON.stringify(theme, null, 2) + '\n', 'utf8');
    return { ok: true, theme };
  }
  throw Error('再生機UIテーマは現行のscreen/dialog/choices形式で指定してください');
}

async function updateProjectSettings(values) {
  const next = { ...layout.settings };
  const keys = ['scenario_dir', 'asset_dir', 'start_file', 'native_ui_theme'];
  for (const key of keys) {
    if (values[key] !== undefined) next[key] = String(values[key]).trim();
  }
  const title = values.title === undefined ? layout.title : String(values.title).replace(/[\r\n]/g, '').trim();
  const source = [
    '# Novel Script project settings',
    '# すべて作品フォルダーからの相対パス。/ を使用する。',
    `scenario_dir = ${next.scenario_dir}`,
    `asset_dir = ${next.asset_dir}`,
    `start_file = ${next.start_file}`,
    `title = ${title}`,
    ...['native_ui_theme'].filter((key) => next[key]).map((key) => `${key} = ${next[key]}`),
  ].join('\n') + '\n';
  parseSettings(source);
  await ensureProjectDirectory(path.resolve(PROJECT_ROOT, next.scenario_dir), 'scenario_dir');
  await ensureProjectDirectory(path.resolve(PROJECT_ROOT, next.asset_dir), 'asset_dir');
  await ensureProjectDirectory(DATA_ROOT, '.novel');
  assertProjectSettingFile(PROJECT_ROOT);
  await fs.writeFile(SETTING_FILE, source, 'utf8');
  bindLayout(PROJECT_ROOT);
  return projectInfo();
}

function runTool(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: options.cwd || REPO_ROOT, env: options.env || process.env, shell: options.shell || false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const append = (chunk) => { output += String(chunk); if (output.length > 2_000_000) output = output.slice(-2_000_000); };
    child.stdout.on('data', append); child.stderr.on('data', append);
    child.once('error', (error) => resolve({ code: 1, output: `${output}\n${error.message}`.trim() }));
    child.once('close', (code) => resolve({ code: code ?? 1, output: output.trim() }));
  });
}

async function nativeRuntimeExists() {
  try { await fs.access(NATIVE_EXE); return true; }
  catch { return false; }
}

function ensureNativeBuild() {
  if (!nativeBuildInFlight) {
    nativeBuildInFlight = nativeRuntimeExists().then((exists) => {
      if (exists) return { code: 0, output: '配布済みNativeランタイムを使用します。' };
      return runTool(process.execPath, [path.join(REPO_ROOT, 'tools', 'native-build.js')]);
    })
      .then((result) => { if (result.code !== 0) throw Error(`ネイティブビルドに失敗しました。\n${result.output}`); return result; })
      .finally(() => { nativeBuildInFlight = null; });
  }
  return nativeBuildInFlight;
}

async function runNativeTests() {
  const build = await ensureNativeBuild();
  const env = { ...process.env, NOVEL_NATIVE_EXE: NATIVE_EXE };
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const tests = await runTool(npm, ['test'], { env, shell: process.platform === 'win32' });
  const output = [`[native build]\n${build.output}`, `[npm test]\n${tests.output}`].filter((part) => part.trim()).join('\n\n');
  if (tests.code !== 0) return { ok: false, stage: 'tests', output };
  const smoke = await runTool(process.execPath, [path.join(REPO_ROOT, 'test', 'native-smoke.cjs')], { env });
  return { ok: smoke.code === 0, stage: smoke.code === 0 ? 'complete' : 'native-smoke', output: [output, `[native smoke]\n${smoke.output}`].filter((part) => part.trim()).join('\n\n') };
}

async function imagePathsForProject() {
  const found = new Set();
  const addFile = (file) => { if (/\.(?:png|jpe?g|webp|bmp|gif|tiff?)$/i.test(file)) found.add(path.resolve(file)); };
  const add = async (relativePath) => {
    if (typeof relativePath !== 'string' || !relativePath.trim()) return;
    const normalized = relativePath.replaceAll('\\', '/').replace(/^asset\//i, '');
    const file = await safeAssetPath(normalized);
    const rel = path.relative(path.resolve(ASSETS_ROOT), file);
    if (!rel || rel === '.' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw Error(`素材パスがassetフォルダー外です: ${relativePath}`);
    addFile(file);
  };
  const scan = async (directory) => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await scan(file);
      else if (entry.isFile()) addFile(file);
    }
  };
  await ensureProjectDirectory(ASSETS_ROOT, 'asset_dir');
  await scan(await realProjectDirectory(ASSETS_ROOT, 'asset_dir'));
  const catalog = JSON.parse(await fs.readFile(await safeDataPath('assets.json', { createParents: true }), 'utf8'));
  for (const asset of catalog.assets || []) if (['bg', 'char', 'image'].includes(asset.type)) await add(asset.path);
  if (layout.settings.native_ui_theme) {
    const themeRelative = layout.settings.native_ui_theme.replaceAll('\\', '/');
    const themePath = await safeAssetPath(themeRelative);
    const rel = path.relative(path.resolve(ASSETS_ROOT), themePath);
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw Error('再生UIテーマのパスがassetフォルダー外です');
    const theme = JSON.parse(await fs.readFile(themePath, 'utf8'));
    const directory = path.posix.dirname(themeRelative);
    for (const image of [theme.dialog?.image, theme.dialog?.nameplate?.image, theme.choices?.image, theme.choices?.activeImage]) if (typeof image === 'string' && image) await add(path.posix.join(directory, image));
  }
  return [...found].sort();
}

async function checkProjectImages() {
  await ensureNativeBuild();
  await rebuildAssets();
  const files = await imagePathsForProject();
  if (!files.length) return { ok: true, stage: 'complete', output: '検査対象の画像素材がありません。' };
  const reports = [];
  for (let i = 0; i < files.length; i += 80) {
    const result = await runTool(IMAGE_CHECK_EXE, files.slice(i, i + 80));
    if (result.output) reports.push(result.output);
    if (result.code !== 0) return { ok: false, stage: 'image-check', output: `${reports.join('\n')}\n\n画像 ${files.length}件中、${Math.min(i + 80, files.length)}件を検査しました。` };
  }
  return { ok: true, stage: 'complete', output: `${files.length}件の画像をネイティブ側で読み込みました。\n${reports.join('\n')}` };
}

async function playWithNativeEngine(name) {
  const scene = sceneName(name);
  if (!scene) throw Error('再生するシーンを指定してください');
  const sourceFile = await safeScenePath(scene);
  await fs.access(sourceFile);
  await ensureNativeBuild();
  await ensureProjectDirectory(NATIVE_PACKAGES_ROOT, '.novel/build');
  const packageName = path.basename(scene, path.extname(scene)) + '.nsp.json';
  const packagePath = await safeBuildPath(packageName, { createParents: true });
  await pack(sourceFile, packagePath, { projectRoot: PROJECT_ROOT });
  const child = spawn(NATIVE_EXE, [packagePath], {
    cwd: path.dirname(NATIVE_EXE),
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.unref();
  return { ok: true, package: '.novel/build/' + packageName };
}

async function listDriveRoots() {
  if (process.platform !== 'win32') return ['/'];
  const roots = [];
  for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    const root = `${letter}:\\`;
    try {
      await fs.stat(root);
      roots.push(root);
    } catch { /* drive not present */ }
  }
  return roots.length ? roots : ['C:\\'];
}

async function browseDirectories(requested) {
  const home = os.homedir();
  const desktop = path.join(home, 'Desktop');
  if (!requested) {
    const roots = await listDriveRoots();
    const extras = [];
    for (const [name, target] of [['ホーム', home], ['デスクトップ', desktop]]) {
      try {
        if ((await fs.stat(target)).isDirectory()) extras.push({ name, path: target, directory: true, shortcut: true });
      } catch { /* optional shortcut */ }
    }
    return {
      path: '',
      parent: null,
      roots: true,
      entries: [
        ...extras,
        ...roots.map((root) => ({ name: root.replace(/[\\/]+$/, ''), path: root, directory: true })),
      ],
    };
  }
  const target = path.resolve(String(requested));
  const stat = await fs.stat(target);
  if (!stat.isDirectory()) throw new Error('フォルダーではありません。');
  const parent = path.dirname(target) === target ? '' : path.dirname(target);
  const entries = [];
  for (const entry of await fs.readdir(target, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (entry.name.startsWith('.') || HIDDEN_BROWSE.has(entry.name.toLowerCase())) continue;
    const child = path.join(target, entry.name);
    try {
      if ((await fs.stat(child)).isDirectory()) entries.push({ name: entry.name, path: child, directory: true });
    } catch { /* unreadable */ }
  }
  entries.sort((left, right) => left.name.localeCompare(right.name, 'ja'));
  return { path: target, parent, roots: false, entries: entries.slice(0, 400) };
}

async function prepareProject() {
  try { assertProjectSettingFile(PROJECT_ROOT); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await fs.mkdir(PROJECT_ROOT, { recursive: true });
    await fs.writeFile(SETTING_FILE, settingTemplate(path.basename(PROJECT_ROOT)), { encoding: 'utf8', flag: 'wx' });
    bindLayout(PROJECT_ROOT);
  }
  await ensureProjectDirectory(SCENES_ROOT, 'scenario_dir');
  await ensureProjectDirectory(ASSETS_ROOT, 'asset_dir');
  await ensureProjectDirectory(DATA_ROOT, '.novel');
  for (const schema of ['variables.schema.json', 'assets.schema.json']) {
    try { await fs.copyFile(path.join(EDIT_ROOT, 'schemas', schema), await safeDataPath(schema, { createParents: true }), require('node:fs').constants.COPYFILE_EXCL); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  await rebuildProjectIndexes();
}

async function openProjectFolder(requested, create = false) {
  if (typeof requested !== 'string' || !requested.trim()) throw new Error('作品フォルダーを指定してください。');
  const resolved = path.resolve(requested.trim());
  if (isEditorTree(resolved)) throw new Error('エディター本体のフォルダーは作品として開けません。Title など別の作品フォルダーを選んでください。');
  let stat;
  try { stat = await fs.stat(resolved); }
  catch (error) {
    if (error?.code !== 'ENOENT' || !create) throw new Error('フォルダーが見つかりません。');
    await fs.mkdir(resolved, { recursive: true });
    stat = await fs.stat(resolved);
  }
  if (!stat.isDirectory()) throw new Error('フォルダーを指定してください。');
  if (!looksLikeProject(resolved) && !create) {
    const error = new Error('作品フォルダーではありません。新規作成しますか？');
    error.needsCreate = true;
    error.projectRoot = resolved;
    error.isEmpty = (await fs.readdir(resolved)).length === 0;
    throw error;
  }
  if (create) seedEmptyProject(resolved);
  bindLayout(resolved);
  await prepareProject();
  await rememberProject(resolved);
  return projectInfo();
}

function json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

function sceneRevision(source) {
  return crypto.createHash('sha256').update(String(source), 'utf8').digest('hex');
}

function text(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  response.end(value);
}

function sceneName(value) {
  if (typeof value !== 'string') return null;
  let name = value.trim().replaceAll('\\', '/');
  const parts = name.split('/');
  const safeDirectory = (part) => part.length <= 120 && part !== '.' && part !== '..' && !/[<>:"|?*\x00-\x1f]/.test(part) && !/[. ]$/.test(part) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part);
  if (name.startsWith('/') || name.length > 240 || parts.some((part) => !part)) return null;
  const file = parts.pop();
  if (parts.some((part) => !safeDirectory(part)) || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(file)) return null;
  if (/\.txt$/i.test(file)) return null;
  name = [...parts, file].join('/');
  return ALLOWED_EXTENSIONS.has(path.extname(name).toLowerCase()) ? name : `${name}.tds`;
}

function nativePackageName(value) {
  const name = String(value || '');
  return /^[A-Za-z0-9][A-Za-z0-9_.-]*\.nsp\.json$/.test(name) ? name : null;
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('ファイルは 2 MB 以下にしてください。');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('JSON の形式が正しくありません。');
  }
}

async function listScenes() {
  const result = [];
  const root = await realProjectDirectory(SCENES_ROOT, 'scenario_dir');
  async function visit(directory, prefix = '') {
    const info = await fs.lstat(directory);
    const resolvedDirectory = await fs.realpath(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || !isPathInside(root, resolvedDirectory)) throw outsideProjectPath('シナリオパス');
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory() && !entry.isSymbolicLink()) await visit(path.join(directory, entry.name), relative);
      else if (entry.isFile() && ALLOWED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        try { await safeScenePath(relative); result.push(relative); }
        catch { /* Ignore links, aliases, and paths outside the scene file rules. */ }
      }
    }
  }
  await visit(SCENES_ROOT);
  return result.sort((left, right) => left.localeCompare(right, 'ja'));
}

async function readSceneSource(name) {
  return fs.readFile(await safeScenePath(name), 'utf8');
}

async function createProjectAnalysisContext() {
  const { parse } = require('../dist');
  const names = await listScenes();
  const scripts = await Promise.all(names.map(async (name) => {
    const source = await readSceneSource(name);
    try { return { name, source, ast: parse(source), error: null }; }
    catch (error) { return { name, source, ast: null, error }; }
  }));
  return { names, scripts, configured: await readStaticVariables(DATA_ROOT) };
}

async function globalVariableTable(excludeName = '', analysis = null) {
  const { inferValueType } = require('../dist/checker/type-checker');
  await safeDataPath('variables.json', { createParents: true });
  const context = analysis || await createProjectAnalysisContext();
  const configured = context.configured;
  const table = new Map(configured.table);
  table.readonlyNames = new Set();
  for (const name of configured.table.readonlyNames) table.readonlyNames.add(name);
  table.staticDeclarations = configured.declarations;
  table.constraints = new Map(configured.table.constraints || []);
  const owners = new Map();
  for (const name of configured.table.keys()) owners.set(name, '.novel/variables.json');
  const scripts = [];
  for (const { name, ast, error } of context.scripts) {
    if (name === excludeName) continue;
    if (error) throw error;
    const script = ast;
    scripts.push(script);
    const implicitGlobals = name.toLowerCase() === 'main.tds';
    for (const statement of script.globals) {
      if (statement.kind !== 'declare') continue;
      if (!implicitGlobals && !statement.global) continue;
      if (statement.type === 'infer') continue;
      const owner = owners.get(statement.name);
      if (owner) throw new Error(`変数 '${statement.name}' は '${owner}' で既に宣言されています。'${name}' では set を使用してください`);
      table.set(statement.name, statement.type);
      if (statement.constant) table.readonlyNames.add(statement.name);
      owners.set(statement.name, name);
    }
  }
  const pending = scripts.flatMap((script) => script.globals.filter((statement) => statement.kind === 'declare' && statement.type === 'infer' && statement.global).map((statement) => ({ statement: { ...statement }, functions: script.functions })));
  let lastError;
  while (pending.length) {
    let progress = false;
    for (let index = pending.length - 1; index >= 0; index--) {
      const { statement, functions } = pending[index];
      try {
        statement.type = inferValueType(statement.initial, table, functions);
        const owner = owners.get(statement.name);
        if (owner) throw new Error(`変数 '${statement.name}' は '${owner}' で既に宣言されています。再宣言せず set を使用してください`);
        table.set(statement.name, statement.type); owners.set(statement.name, '別のシナリオ'); pending.splice(index, 1); progress = true;
      } catch (error) { lastError = error; }
    }
    if (!progress) throw lastError || new Error('グローバル変数の型を推論できません');
  }
  return table;
}

async function globalCharacterTable(excludeName = '', analysis = null) {
  const context = analysis || await createProjectAnalysisContext();
  const characters = new Map();
  for (const { name, ast, error } of context.scripts) {
    if (name === excludeName) continue;
    if (error) throw error;
    const script = ast;
    for (const character of script.characters) {
      if (characters.has(character.name)) throw new Error(`キャラクター '${character.name}' が複数ファイルで宣言されています`);
      const fields = Object.fromEntries(character.properties.map((property) => [property.name, property.value.kind === 'literal' && typeof property.value.value === 'string' ? 'str' : 'int']));
      characters.set(character.name, { poses: new Set(character.poses.map((pose) => pose.name)), fields, definition: character });
    }
  }
  return characters;
}

async function listProjectFiles() {
  const result = [];
  async function visit(directory, prefix = '') {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { result.push({ path: relative, directory: true }); await visit(path.join(directory, entry.name), relative); }
      else result.push({ path: relative, directory: false });
    }
  }
  for (const directory of [layout.settings.asset_dir, layout.settings.scenario_dir]) {
    result.push({ path: directory, directory: true });
    await visit(path.join(PROJECT_ROOT, directory), directory);
  }
  return result.sort((a, b) => a.path.localeCompare(b.path, 'ja'));
}

async function sceneGraph() {
  const { sceneReachability } = require('../dist/checker/analyzer');
  const analysis = await createProjectAnalysisContext();
  const nodes = [];
  const edges = [];
  const edgeKeys = new Set();
  const addEdge = (from, to, kind) => {
    const key = JSON.stringify([from, to, kind]);
    if (!to || edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ from, to, kind });
  };
  const diagnosticForError = (error, file) => ({
    code: 'project-error', severity: 'error',
    message: error instanceof Error ? error.message : String(error),
    file, line: Number(error?.line || 1), column: Number(error?.column || 1),
  });
  for (const { name, source } of analysis.scripts) {
    let ast;
    try {
      ast = await resolveProjectScript(source, SCENES_ROOT, new Set(), name);
    } catch (error) {
      nodes.push({ id: name, label: name, variables: [], diagnostics: [diagnosticForError(error, name)], error: true });
      continue;
    }
    const reachability = sceneReachability(ast);
    const scenesByName = new Map(ast.scenes.map((scene) => [scene.name, scene]));
    const localGotos = [];
    const seenLocalGotos = new Set();
    for (const match of source.matchAll(/^\s*goto\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:#.*)?$/gmi)) {
      const target = scenesByName.get(match[1]);
      if (!target) continue;
      const file = target.file || name;
      const key = JSON.stringify([target.name, file]);
      if (seenLocalGotos.has(key)) continue;
      seenLocalGotos.add(key);
      localGotos.push({ scene: target.name, file, gotoLine: source.slice(0, match.index).split(/\r?\n/).length });
    }
    for (const target of ast.includes.map((value) => sceneName(value)).filter(Boolean)) addEdge(name, target, 'include');
    let diagnostics = [];
    let report = null;
    try {
      report = await validate(source, name, analysis, true);
      diagnostics = Array.isArray(report.diagnostics) ? report.diagnostics : [];
    } catch (error) {
      diagnostics = [diagnosticForError(error, name)];
    }
    let error = diagnostics.some((item) => item.severity === 'error');
    let variables = [];
    try {
      let program = report?.program;
      if (!program) {
        const [globalVariables, characters] = await Promise.all([
          globalVariableTable(name, analysis), globalCharacterTable(name, analysis),
        ]);
        program = await compileProject(source, ASSETS_ROOT, SCENES_ROOT, globalVariables, characters, name);
      }
      variables = program.variables.map((variable) => ({ ...variable, file: name }));
    } catch (compileError) {
      error = true;
      if (!diagnostics.some((item) => item.severity === 'error')) diagnostics.push(diagnosticForError(compileError, name));
    }
    nodes.push({
      id: name,
      label: name,
      variables,
      localGotos,
      diagnostics,
      error,
      scenes: {
        total: ast.scenes.length,
        reachable: reachability.reachableScenes.size,
      },
    });
    for (const target of reachability.externalGotos) addEdge(name, sceneName(target) || target, 'goto');
  }
  const config = await readSceneConfig();
  const start = sceneName(config.start_file || '');
  const nodeIds = new Set(nodes.map((node) => node.id));
  const adjacency = new Map();
  for (const edge of edges) {
    if (!nodeIds.has(edge.to)) continue;
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);
    adjacency.get(edge.from).push(edge.to);
  }
  const reachableFiles = new Set(), pending = start ? [start] : [];
  while (pending.length) {
    const id = pending.pop();
    if (reachableFiles.has(id)) continue;
    reachableFiles.add(id);
    pending.push(...(adjacency.get(id) || []));
  }
  nodes.forEach((node) => { node.reachable = !start || reachableFiles.has(node.id); });
  return {
    version: 2,
    start,
    nodes,
    edges,
    summary: {
      nodes: nodes.length,
      reachable: nodes.filter((node) => node.reachable).length,
      transitions: edges.filter((edge) => edge.kind === 'goto').length,
      includes: edges.filter((edge) => edge.kind === 'include').length,
      diagnostics: nodes.reduce((count, node) => count + (node.diagnostics?.length || 0), 0),
    },
  };
}

async function validateFlow(start, end) {
  return validateGraph(await sceneGraph(), start, end);
}

function validateGraph(graph, start, end) {
  const nodeMap = new Map(graph.nodes.map((node) => [node.id, node]));
  const fromNode = nodeMap.get(start), toNode = nodeMap.get(end);
  if (!fromNode || !toNode) {
    return { ok: false, errors: [{ file: start || end || 'unknown', message: '開始・終了ファイルの範囲が不正です。' }] };
  }

  // start から end への到達経路（BFS）
  const queue = [[start]];
  const visited = new Set([start]);
  let pathFound = null;

  while (queue.length > 0) {
    const currentPath = queue.shift();
    const tail = currentPath[currentPath.length - 1];
    if (tail === end) {
      pathFound = currentPath;
      break;
    }
    const nextNodes = graph.edges.filter((e) => e.from === tail && (!e.kind || e.kind === 'goto' || e.kind === 'include')).map((e) => e.to);
    for (const next of nextNodes) {
      if (!visited.has(next)) {
        visited.add(next);
        queue.push([...currentPath, next]);
      }
    }
  }

  // 経路が見つからなければ node.id 順をフォールバックとしつつ通知
  if (!pathFound) return { ok: false, errors: [{ file: end, message: '開始ファイルから終了ファイルへの経路がありません。' }] };
  // Validate every branch in the selected range, but do not continue beyond end.
  const reachable = new Set(), pending = [start];
  while (pending.length) {
    const id = pending.pop();
    if (reachable.has(id)) continue;
    reachable.add(id);
    if (id !== end) graph.edges.filter((edge) => edge.from === id && (!edge.kind || edge.kind === 'goto' || edge.kind === 'include')).forEach((edge) => pending.push(edge.to));
  }
  const checkOrder = [...reachable];
  const errors = [];

  for (const fileId of checkOrder) {
    const node = nodeMap.get(fileId);
    if (!node) { errors.push({ file: fileId, message: '遷移先ファイルが存在しません。' }); continue; }
    if (node.error) {
      errors.push({ file: node.id, message: 'シナリオに解析または型検査エラーが存在します。' });
      continue;
    }
    // Each file is type checked in sceneGraph; local bindings must not be
    // compared against a project-wide set of global names.

  }

  const states = [{ file: start, defined: new Set() }];
  const seenStates = new Set();
  while (states.length) {
    const state = states.pop();
    const stateKey = `${state.file}\0${[...state.defined].sort().join('\0')}`;
    if (seenStates.has(stateKey)) continue;
    seenStates.add(stateKey);
    const node = nodeMap.get(state.file);
    if (!node || node.error) continue;
    const declared = new Set();
    const required = new Set();
    for (const variable of node.variables || []) {
      if (variable.scope !== 'global') continue;
      const definitions = (variable.definitions || []).filter((loc) => loc.scope === 'global');
      const references = variable.references || [];
      if (definitions.length) declared.add(variable.name);
      const firstDefinition = Math.min(...definitions.map((loc) => loc.line ?? Number.MAX_SAFE_INTEGER));
      if (references.some((loc) => !definitions.length || (loc.scope === 'global' && (loc.line ?? 1) < firstDefinition))) required.add(variable.name);
    }
    const missing = [...required].filter((name) => !state.defined.has(name));
    if (missing.length) errors.push({ file: state.file, message: `初期化前のグローバル変数を参照しています: ${missing.join(', ')}` });
    const nextDefined = new Set([...state.defined, ...declared]);
    if (state.file !== end) graph.edges.filter((edge) => edge.from === state.file).forEach((edge) => states.push({ file: edge.to, defined: nextDefined }));
  }

  return { ok: errors.length === 0, start, end, path: pathFound, checked: checkOrder, errors };
}

async function readSceneConfig() {
  const config = { ...layout.settings };
  try {
    assertProjectSettingFile(PROJECT_ROOT);
    Object.assign(config, parseSettings(await fs.readFile(SETTING_FILE, 'utf8')));
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return config;
}

async function rebuildProjectIndexes({ variables = true, assets = true } = {}) {
  const analysis = await createProjectAnalysisContext();
  const entries = new Map();
  const assetEntries = new Map();
  if (variables) {
    for (const declaration of analysis.configured.declarations) {
      entries.set(JSON.stringify(['global', 'global', declaration.name]), {
        name: declaration.name, type: declaration.type, scope: 'global', definedIn: 'global',
        definitions: [{ scope: 'global', container: 'global', kind: 'definition', file: '.novel/variables.json' }],
        references: [], mutable: !declaration.constant, static: true,
      });
    }
  }
  const { parse, compile } = require('../dist');
  for (const { name, source } of analysis.scripts) {
    try {
      const [globalVariables, characters] = await Promise.all([
        globalVariableTable(name, analysis), globalCharacterTable(name, analysis),
      ]);
      const program = compile(parse(source), globalVariables, characters);
      if (variables) {
        for (const variable of program.variables) {
          const definitions = (variable.definitions || []).map((location) => ({ ...location, file: name }));
          const references = (variable.references || []).map((reference) => ({ ...reference, file: name }));
          // A variable is project-wide metadata. Do not repeat entries merely
          // because a file can see a global declared in another file.
          const key = JSON.stringify([variable.scope, variable.definedIn, variable.name]);
          const existing = entries.get(key);
          if (existing) { existing.definitions.push(...definitions); existing.references.push(...references); }
          else entries.set(key, { ...variable, definitions, references });
        }
      }
      if (assets) {
        program.assets.forEach((asset) => assetEntries.set(`${asset.type}:${asset.name}`, { type: asset.type, name: asset.name, path: asset.path, definedIn: name }));
        program.characters.forEach((character) => character.poses.forEach((pose) => assetEntries.set(`char:${character.name}.${pose.name}`, { type: 'char', name: character.name, pose: pose.name, path: pose.path, definedIn: name })));
      }
    } catch { /* Invalid files remain available for editor validation. */ }
  }
  const result = {};
  if (variables) {
    const file = await safeDataPath('variables.json', { createParents: true });
    result.variables = [...entries.values()];
    await fs.writeFile(file, JSON.stringify({ $schema: './variables.schema.json', staticVariables: analysis.configured.source.staticVariables || [], variables: result.variables }, null, 2) + '\n', 'utf8');
  }
  if (assets) {
    const file = await safeDataPath('assets.json', { createParents: true });
    result.assets = [...assetEntries.values()];
    await fs.writeFile(file, JSON.stringify({ $schema: './assets.schema.json', assets: result.assets }, null, 2) + '\n', 'utf8');
  }
  return result;
}

async function rebuildVariables() {
  return (await rebuildProjectIndexes({ assets: false })).variables;
}

async function rebuildAssets() {
  return (await rebuildProjectIndexes({ variables: false })).assets;
}

function scenePath(value) {
  const name = sceneName(value);
  if (!name) return null;
  const root = path.resolve(SCENES_ROOT);
  const target = path.resolve(root, name);
  return target.startsWith(`${root}${path.sep}`) ? target : null;
}

function isPathInside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function outsideProjectPath(label) {
  const error = new Error(`${label} は作品フォルダー外を参照できません`);
  error.code = 'EPATHOUTSIDE';
  return error;
}

function assertRegularProjectFile(info, label) {
  if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) throw outsideProjectPath(label);
}

async function realProjectDirectory(directory, label) {
  const projectRoot = await fs.realpath(PROJECT_ROOT);
  const resolved = await fs.realpath(directory);
  if (!isPathInside(projectRoot, resolved)) throw outsideProjectPath(label);
  return resolved;
}

async function ensureProjectDirectory(directory, label) {
  const lexicalProjectRoot = path.resolve(PROJECT_ROOT);
  const target = path.resolve(directory);
  if (!isPathInside(lexicalProjectRoot, target)) throw outsideProjectPath(label);
  const projectRoot = await fs.realpath(PROJECT_ROOT);
  let probe = target;
  while (true) {
    try {
      const resolved = await fs.realpath(probe);
      if (!isPathInside(projectRoot, resolved)) throw outsideProjectPath(label);
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(probe);
      if (parent === probe) throw error;
      probe = parent;
    }
  }
  await fs.mkdir(target, { recursive: true });
  return realProjectDirectory(target, label);
}

async function safeScenePath(value, { createParents = false } = {}) {
  const target = scenePath(value);
  if (!target) throw new Error('無効なシナリオファイル名です');
  const root = await realProjectDirectory(SCENES_ROOT, 'scenario_dir');

  // Check existing ancestors before mkdir so a symlink cannot redirect even
  // directory creation outside the selected project.
  let probe = path.dirname(target);
  while (true) {
    try {
      const resolved = await fs.realpath(probe);
      if (!isPathInside(root, resolved)) throw outsideProjectPath('シナリオパス');
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(probe);
      if (parent === probe) throw error;
      probe = parent;
    }
  }

  if (createParents) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    const resolvedParent = await fs.realpath(path.dirname(target));
    if (!isPathInside(root, resolvedParent)) throw outsideProjectPath('シナリオパス');
  }

  try {
    const info = await fs.lstat(target);
    assertRegularProjectFile(info, 'シナリオパス');
    const resolved = await fs.realpath(target);
    if (!isPathInside(root, resolved)) throw outsideProjectPath('シナリオパス');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return target;
}

async function safeAssetPath(relative, { createParents = false } = {}) {
  const requested = path.resolve(ASSETS_ROOT, relative);
  const lexicalRoot = path.resolve(ASSETS_ROOT);
  if (requested === lexicalRoot || !isPathInside(lexicalRoot, requested)) throw outsideProjectPath('素材パス');
  if (createParents) await ensureProjectDirectory(path.dirname(requested), 'asset_dir');
  const root = await realProjectDirectory(ASSETS_ROOT, 'asset_dir');
  try {
    const info = await fs.lstat(requested);
    assertRegularProjectFile(info, '素材パス');
    const resolved = await fs.realpath(requested);
    if (!isPathInside(root, resolved)) throw outsideProjectPath('素材パス');
    return resolved;
  } catch (error) {
    if (error.code !== 'ENOENT' || !createParents) throw error;
    return requested;
  }
}

async function safeBuildPath(relative, { createParents = false } = {}) {
  const requested = path.resolve(NATIVE_PACKAGES_ROOT, relative);
  const lexicalRoot = path.resolve(NATIVE_PACKAGES_ROOT);
  if (requested === lexicalRoot || !isPathInside(lexicalRoot, requested)) throw outsideProjectPath('.novel/build');
  if (createParents) await ensureProjectDirectory(path.dirname(requested), '.novel/build');
  const root = await realProjectDirectory(NATIVE_PACKAGES_ROOT, '.novel/build');
  try {
    const info = await fs.lstat(requested);
    assertRegularProjectFile(info, '.novel/build');
    const resolved = await fs.realpath(requested);
    if (!isPathInside(root, resolved)) throw outsideProjectPath('.novel/build');
    return resolved;
  } catch (error) {
    if (error.code !== 'ENOENT' || !createParents) throw error;
    return requested;
  }
}

async function safeDataPath(relative, { createParents = false } = {}) {
  const requested = path.resolve(DATA_ROOT, relative);
  const lexicalRoot = path.resolve(DATA_ROOT);
  if (requested === lexicalRoot || !isPathInside(lexicalRoot, requested)) throw outsideProjectPath('.novel');
  if (createParents) await ensureProjectDirectory(path.dirname(requested), '.novel');
  const root = await realProjectDirectory(DATA_ROOT, '.novel');
  try {
    const info = await fs.lstat(requested);
    assertRegularProjectFile(info, '.novel');
    const resolved = await fs.realpath(requested);
    if (!isPathInside(root, resolved)) throw outsideProjectPath('.novel');
    return resolved;
  } catch (error) {
    if (error.code !== 'ENOENT' || !createParents) throw error;
    return requested;
  }
}

function parseCatalog(source) {
  const catalog = {};
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, '').trim();
    if (!line) continue;
    const asset = /^([A-Za-z][A-Za-z0-9_-]*)\s+([A-Za-z][A-Za-z0-9_.-]*)\s*=\s*(\S+)$/.exec(line);
    if (asset) {
      (catalog[asset[1]] ||= []).push(asset[2]);
      continue;
    }
    const match = /^([A-Za-z][A-Za-z0-9_-]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const values = match[2].split(',').map((value) => value.trim()).filter(Boolean);
    catalog[match[1]] = [...new Set(values)];
  }
  return catalog;
}

async function readCatalog() {
  const source = await fs.readFile(CATALOG_FILE, 'utf8');
  return { source, catalog: parseCatalog(source) };
}

function splitSourceLines(source) {
  return source.split(/\r\n|[\r\n\u2028\u2029]/);
}

function collectSyntaxDiagnostics(source, file = 'current') {
  const { parse } = require('../dist');
  const diagnostics = [];
  const lines = splitSourceLines(source);
  const maskedLines = [...lines];
  const removed = new Set();
  for (let attempt = 0; attempt < Math.min(lines.length, 100); attempt++) {
    try { parse(maskedLines.join('\n')); break; }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const line = Number(error?.token?.line || message.match(/line\s+(\d+)/i)?.[1] || 1);
      const column = Number(error?.token?.column || message.match(/column\s+(\d+)/i)?.[1] || 1);
      const index = line - 1;
      if (index < 0 || index >= maskedLines.length || removed.has(index)) break;
      const tokenLength = String(error?.token?.value || '').length;
      const endColumn = error?.token ? column + Math.max(1, tokenLength) : Math.max(column, lines[index].length + 1);
      diagnostics.push({ code: 'syntax-error', severity: 'error', message, file, line, column, endColumn });
      removed.add(index);
      maskedLines[index] = ' '.repeat(maskedLines[index].length);
    }
  }
  return diagnostics;
}

async function validateSourceAssets(script, file) {
  const entries = [
    ...(script.assets || []).map((asset) => ({ path: asset.path, line: asset.line, column: asset.column })),
    ...(script.characters || []).filter((character) => !character.external).flatMap((character) => character.poses.map((pose) => ({ path: pose.path, line: pose.line || character.line, column: pose.column || character.column }))),
  ];
  const diagnostics = [];
  for (const entry of entries) {
    try {
      await inside(ASSETS_ROOT, String(entry.path || '').replace(/^asset[\\/]/, ''));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      diagnostics.push({
        code: 'project-error', severity: 'error',
        message: `アセット '${entry.path}' を読み込めません: ${reason}`,
        file, line: Number(entry.line) || 1, column: Number(entry.column) || 1,
        endColumn: (Number(entry.column) || 1) + String(entry.path || '').length,
      });
    }
  }
  return diagnostics;
}

async function validate(source, name = '', analysis = null, includeProgram = false) {
  const sourceFile = name || 'current';
  const syntaxDiagnostics = collectSyntaxDiagnostics(source, sourceFile);
  if (syntaxDiagnostics.length) return { ok: false, diagnostics: syntaxDiagnostics, error: syntaxDiagnostics[0].message };
  try {
    const { parse } = require('../dist');
    const { analyzeScript } = require('../dist/checker/analyzer');
    const ast = await resolveProjectScript(source, SCENES_ROOT, new Set(), sourceFile);
    const sourceAssetDiagnostics = await validateSourceAssets(ast, sourceFile);
    const projectAnalysis = analysis || await createProjectAnalysisContext();
    const globalVariables = await globalVariableTable(name, projectAnalysis);
    const characters = await globalCharacterTable(name, projectAnalysis);
    const context = projectContext(ast, globalVariables, characters, sourceFile);
    const staticDeclarations = globalVariables.staticDeclarations || [];
    const analysisScript = staticDeclarations.length
      ? { ...ast, globals: [...staticDeclarations, ...ast.globals], body: [...staticDeclarations, ...ast.body] }
      : ast;
    const diagnostics = analyzeScript(analysisScript, sourceFile, context.globals, context.characters);
    if (diagnostics.some((item) => item.severity === 'error')) {
      const combinedDiagnostics = [...diagnostics, ...sourceAssetDiagnostics].sort((left, right) => (left.line - right.line) || (left.column - right.column));
      return { ok: false, diagnostics: combinedDiagnostics, error: combinedDiagnostics.find((item) => item.severity === 'error').message };
    }
    try {
      // Keep live IDE validation on the exact same compiler entry point as
      // /api/compile and the player loader.  This prevents the editor from
      // accepting a script that only the project compiler can reject.
      const program = await compileSource(source, sourceFile, projectAnalysis);
      return {
        ok: true, diagnostics, statements: ast.body.length, instructions: program.globals.length,
        ...(includeProgram ? { program } : {}),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const projectDiagnostics = message.split(/\r?\n/).filter(Boolean).map((entry) => {
        const assetPath = entry.match(/(?:asset|アセット)\s*'([^']+)'/)?.[1] || entry.match(/'(assets[\\/][^']+)'/)?.[1];
        const sourceLines = splitSourceLines(source);
        const assetLineIndex = assetPath ? sourceLines.findIndex((line) => line.includes(assetPath)) : -1;
        const assetLine = assetLineIndex >= 0 ? assetLineIndex + 1 : 0;
        const assetColumn = assetLineIndex >= 0 ? sourceLines[assetLineIndex].indexOf(assetPath) + 1 : 1;
        const line = Number(entry.match(/line\s+(\d+)/i)?.[1] || entry.match(/行\s*(\d+)/)?.[1] || assetLine || 1);
        const referencedPath = assetPath || entry.match(/'([^']+\.(?:tds|txt))'/i)?.[1];
        const referencedLineIndex = referencedPath ? sourceLines.findIndex((lineText) => lineText.includes(referencedPath)) : -1;
        const reportedLine = referencedLineIndex >= 0 ? referencedLineIndex + 1 : line;
        const locationLine = referencedLineIndex >= 0 ? sourceLines[referencedLineIndex] : '';
        const column = referencedLineIndex >= 0 ? locationLine.indexOf(referencedPath) + 1 : (line === assetLine ? assetColumn : 1);
        const endColumn = referencedPath ? column + referencedPath.length : column;
        return { code: 'project-error', severity: 'error', message: entry, file: sourceFile, line: reportedLine, column, endColumn };
      });
      diagnostics.push(...projectDiagnostics);
      return { ok: false, diagnostics, error: message };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const projectResolutionError = error?.code === 'ENOENT' || error?.code === 'EISDIR' || /(?:lstat|realpath).*no such file|no such file.*(?:lstat|realpath)/i.test(message);
    const sourceLines = splitSourceLines(source);
    const includeLineIndex = sourceLines.findIndex((lineText) => /^\s*include\b/i.test(lineText));
    const includeTarget = includeLineIndex >= 0 ? sourceLines[includeLineIndex].match(/^\s*include\s+["']?([^\s"']+)/i)?.[1] : '';
    const line = Number(message.match(/line\s+(\d+)/i)?.[1] || (includeLineIndex >= 0 ? includeLineIndex + 1 : 1));
    const lineText = sourceLines[line - 1] || '';
    const column = includeTarget && lineText.includes(includeTarget)
      ? lineText.indexOf(includeTarget) + 1
      : Number(message.match(/column\s+(\d+)/i)?.[1] || (includeLineIndex >= 0 ? lineText.indexOf('include') + 1 : 1));
    const endColumn = includeTarget ? column + includeTarget.length : column;
    return { ok: false, diagnostics: [{ code: projectResolutionError ? 'project-error' : 'syntax-error', severity: 'error', message, file: name || 'current', line, column, endColumn }], error: message };
  }
}

async function compileSource(source, name = '', analysis = null) {
  const projectAnalysis = analysis || await createProjectAnalysisContext();
  const [globalVariables, characters] = await Promise.all([
    globalVariableTable(name, projectAnalysis), globalCharacterTable(name, projectAnalysis),
  ]);
  return compileProject(source, ASSETS_ROOT, SCENES_ROOT, globalVariables, characters, name || 'current');
}

async function buildWholeProject(name) {
  const entry = sceneName(name);
  const sceneFiles = await listScenes();
  if (!entry || !sceneFiles.includes(entry)) return {
    ok: false,
    build: true,
    fileCount: sceneFiles.length,
    diagnostics: [{ code: 'project-error', severity: 'error', message: '開始ファイルが見つかりません', file: entry || 'current', line: 1, column: 1 }],
    error: '開始ファイルが見つかりません',
  };

  const diagnostics = [];
  for (const file of sceneFiles) {
    const source = await readSceneSource(file);
    diagnostics.push(...collectSyntaxDiagnostics(source, file));
  }

  if (!diagnostics.length) {
    for (const file of sceneFiles) {
      const source = await readSceneSource(file);
      const report = await validate(source, file);
      diagnostics.push(...(report.diagnostics || []));
    }
  }

  const uniqueDiagnostics = [...new Map(diagnostics.map((item) => [
    JSON.stringify([item.code, item.severity, item.file, item.line, item.column, item.endLine, item.endColumn, item.message]), item,
  ])).values()];
  const firstError = uniqueDiagnostics.find((item) => item.severity === 'error');
  if (firstError) return { ok: false, build: true, fileCount: sceneFiles.length, diagnostics: uniqueDiagnostics, error: firstError.message };

  try {
    await ensureProjectDirectory(NATIVE_PACKAGES_ROOT, '.novel/build');
    const packageName = `${path.basename(entry, path.extname(entry))}.nsp.json`;
    const packagePath = await safeBuildPath(packageName, { createParents: true });
    const data = await pack(scenePath(entry), packagePath, { projectRoot: PROJECT_ROOT, scenesRoot: SCENES_ROOT, assetsRoot: ASSETS_ROOT });
    return {
      ok: true, build: true, fileCount: sceneFiles.length, diagnostics: uniqueDiagnostics,
      name: packageName, path: `.novel/build/${packageName}`,
      instructions: Object.values(data.files || {}).reduce((count, program) => count + (program.globals?.length || 0) + (program.scenes || []).reduce((sum, scene) => sum + (scene.instructions?.length || 0), 0), 0),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false, build: true, fileCount: sceneFiles.length,
      diagnostics: [...uniqueDiagnostics, { code: 'project-error', severity: 'error', message, file: entry, line: Number(message.match(/line\s+(\d+)/i)?.[1] || 1), column: 1 }],
      error: message,
    };
  }
}

async function serveStatic(response, pathname) {
  if (pathname === '/asset' || pathname.startsWith('/asset/')) {
    const relative = decodeURIComponent(pathname.slice('/asset/'.length));
    try {
      const requested = await safeAssetPath(relative);
      const stat = await fs.stat(requested);
      if (!stat.isFile()) {
        text(response, 404, 'Not found');
        return;
      }
      const extension = path.extname(requested).toLowerCase();
      const contentType = CONTENT_TYPES[extension];
      if (!contentType) {
        text(response, 415, 'Unsupported media type');
        return;
      }
      response.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
      response.end(await fs.readFile(requested));
    } catch (error) {
      if (error?.code === 'EPATHOUTSIDE') {
        text(response, 403, 'Forbidden');
        return;
      }
      if (error && error.code === 'ENOENT') {
        text(response, 404, 'Not found');
        return;
      }
      throw error;
    }
    return;
  }
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (!['index.html', 'editor.js', 'styles.css', 'player.html', 'player.js', 'runtime.js', 'player.css', 'flow.html', 'flow.js', 'flow-validation.js', 'flow.css', 'engine.html', 'assets/desktop-icon.png', 'shared/formatter.js', 'docs/tds-language-and-editor-guide.md'].includes(relative)) {
    text(response, 404, 'Not found');
    return;
  }
  const extension = path.extname(relative);
  response.writeHead(200, { 'Content-Type': CONTENT_TYPES[extension], 'Cache-Control': 'no-store' });
  const root = relative.startsWith('shared/') || relative.startsWith('docs/') ? REPO_ROOT : EDIT_ROOT;
  response.end(await fs.readFile(path.join(root, relative)));
}

async function serveNativePackage(response, url) {
  const name = nativePackageName(url.searchParams.get('name'));
  if (!name) return json(response, 400, { error: 'Invalid native package name' });
  try {
    const file = await safeBuildPath(name).catch((error) => { if (error?.code === 'EPATHOUTSIDE') return ''; throw error; });
    if (!file) return json(response, 403, { error: 'Invalid native package path' });
    const data = await fs.readFile(file);
    response.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${name}"`,
      'Cache-Control': 'no-store',
    });
    response.end(data);
  } catch (error) {
    if (error?.code === 'ENOENT') return json(response, 404, { error: 'ネイティブパッケージが見つかりません。' });
    throw error;
  }
}

async function handleApi(request, response, url) {
  if (request.method === 'GET' && url.pathname === '/api/scenes') {
    return json(response, 200, { scenes: await listScenes() });
  }
  if (request.method === 'GET' && url.pathname === '/api/files') return json(response, 200, { title: layout.title, projectRoot: PROJECT_ROOT, scenarioDir: layout.settings.scenario_dir, files: await listProjectFiles() });
  if (request.method === 'GET' && url.pathname === '/api/project') return json(response, 200, await projectInfo());
  if (request.method === 'PUT' && url.pathname === '/api/project/settings') {
    try { return json(response, 200, { ok: true, ...(await updateProjectSettings(await readJson(request))) }); }
    catch (error) { return json(response, 400, { error: error instanceof Error ? error.message : String(error) }); }
  }
  if (request.method === 'GET' && url.pathname === '/api/player-ui') {
    try { return json(response, 200, await playerUiTheme()); }
    catch (error) { return json(response, 400, { error: error instanceof Error ? error.message : String(error) }); }
  }
  if (request.method === 'PUT' && url.pathname === '/api/player-ui') {
    try { return json(response, 200, await updatePlayerUiTheme((await readJson(request)).theme)); }
    catch (error) { return json(response, 400, { error: error instanceof Error ? error.message : String(error) }); }
  }
  if (request.method === 'GET' && url.pathname === '/api/browse') {
    try { return json(response, 200, await browseDirectories(url.searchParams.get('path') || '')); }
    catch (error) { return json(response, 400, { error: error instanceof Error ? error.message : String(error) }); }
  }
  if (request.method === 'POST' && url.pathname === '/api/project/open') {
    const body = await readJson(request);
    try { return json(response, 200, { ok: true, ...(await openProjectFolder(body.path, Boolean(body.create))) }); }
    catch (error) {
      const payload = { error: error instanceof Error ? error.message : String(error) };
      if (error?.needsCreate) { payload.needsCreate = true; payload.projectRoot = error.projectRoot; payload.isEmpty = error.isEmpty; return json(response, 409, payload); }
      return json(response, 400, payload);
    }
  }
  if (request.method === 'DELETE' && url.pathname === '/api/file') {
    const body = await readJson(request); const name = String(body.path || '').replaceAll('\\', '/');
    if (!/^[A-Za-z0-9_./-]+$/.test(name) || name.split('/').some((part) => !part || part === '.' || part === '..')) return json(response, 400, { error: '削除できないパスです' });
    const assetPrefix = `${layout.settings.asset_dir}/`;
    const scenePrefix = `${layout.settings.scenario_dir}/`;
    try {
      const target = name.startsWith(assetPrefix)
        ? await safeAssetPath(name.slice(assetPrefix.length))
        : name.startsWith(scenePrefix)
          ? await safeScenePath(name.slice(scenePrefix.length))
          : null;
      if (!target) return json(response, 400, { error: '削除できない場所です' });
      const info = await fs.lstat(target);
      if (!info.isFile()) return json(response, 400, { error: 'ファイルだけ削除できます' });
      await fs.unlink(target);
    } catch (error) {
      return json(response, error?.code === 'ENOENT' ? 404 : 400, { error: error instanceof Error ? error.message : String(error) });
    }
    await rebuildProjectIndexes();
    return json(response, 200, { ok: true });
  }
  if (request.method === 'GET' && url.pathname === '/api/scene-graph') return json(response, 200, await sceneGraph());
  if (request.method === 'POST' && url.pathname === '/api/validate-flow') { const body = await readJson(request); return json(response, 200, await validateFlow(body.start, body.end)); }
  if (request.method === 'GET' && url.pathname === '/api/scene-config') {
    return json(response, 200, await readSceneConfig());
  }
  if (request.method === 'GET' && url.pathname === '/api/variables') {
    try { return json(response, 200, JSON.parse(await fs.readFile(await safeDataPath('variables.json', { createParents: true }), 'utf8'))); }
    catch (error) {
      if (error?.code === 'ENOENT') return json(response, 200, { variables: [] });
      if (error?.code === 'EPATHOUTSIDE' || error instanceof SyntaxError) return json(response, 400, { error: 'Project variables metadata is invalid or outside the project.' });
      return json(response, 500, { error: 'Could not read project variables metadata.' });
    }
  }
  if (request.method === 'GET' && url.pathname === '/api/assets') {
    try { return json(response, 200, JSON.parse(await fs.readFile(await safeDataPath('assets.json', { createParents: true }), 'utf8'))); }
    catch (error) {
      if (error?.code === 'ENOENT') return json(response, 200, { assets: [] });
      if (error?.code === 'EPATHOUTSIDE' || error instanceof SyntaxError) return json(response, 400, { error: 'Project assets metadata is invalid or outside the project.' });
      return json(response, 500, { error: 'Could not read project assets metadata.' });
    }
  }
  if (request.method === 'GET' && url.pathname === '/api/catalog') {
    return json(response, 200, await readCatalog());
  }
  if (request.method === 'GET' && url.pathname === '/api/scene') {
    const name = sceneName(url.searchParams.get('name'));
    if (!name) return json(response, 400, { error: '無効なファイル名です。' });
    try {
      const target = await safeScenePath(name);
      const source = await fs.readFile(target, 'utf8');
      return json(response, 200, { name, source, revision: sceneRevision(source) });
    } catch (error) {
      if (error && error.code === 'ENOENT') return json(response, 404, { error: 'ファイルが見つかりません。' });
      return json(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (request.method === 'PUT' && url.pathname === '/api/scene') {
    const body = await readJson(request);
    const name = sceneName(String(body.name || '').replace(new RegExp(`^${layout.settings.scenario_dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`), ''));
    if (!name) return json(response, 400, { error: 'ファイル名は英数字・._- を使ってください。' });
    if (typeof body.source !== 'string') return json(response, 400, { error: '保存する本文がありません。' });
    if (Buffer.byteLength(body.source, 'utf8') > MAX_BODY_BYTES) return json(response, 413, { error: 'ファイルは 2 MB 以下にしてください。' });
    if (body.expectedRevision !== undefined && typeof body.expectedRevision !== 'string') return json(response, 400, { error: 'Invalid scene revision.' });
    let target;
    try { target = await safeScenePath(name, { createParents: true }); }
    catch (error) { return json(response, 400, { error: error instanceof Error ? error.message : String(error) }); }
    if (body.expectedRevision !== undefined) {
      try {
        const currentSource = await fs.readFile(target, 'utf8');
        const currentRevision = sceneRevision(currentSource);
        if (currentRevision !== body.expectedRevision) return json(response, 409, { error: 'Scene changed externally; reload before saving.', code: 'SCENE_CONFLICT', revision: currentRevision });
      } catch (error) {
        if (error?.code !== 'ENOENT') return json(response, 400, { error: error instanceof Error ? error.message : String(error) });
        return json(response, 409, { error: 'Scene was created or removed externally; reload before saving.', code: 'SCENE_CONFLICT' });
      }
    }
    try { await compileSource(body.source, name); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 編集途中の構文・型エラーは保存を妨げないが、既存変数の再宣言だけは
      // プロジェクト全体の変数契約を壊すため書き込み前に拒否する。
      if (/既に宣言|再宣言/.test(message)) return json(response, 400, { error: message });
    }
    await fs.writeFile(target, body.source, 'utf8');
    await fs.mkdir(DATA_ROOT, { recursive: true });
    // 保存した1ファイルだけでなく全ファイルの集計を実行して更新
    await rebuildProjectIndexes();
    return json(response, 200, { ok: true, name, revision: sceneRevision(body.source) });
  }
  if (request.method === 'POST' && url.pathname === '/api/validate') {
    const body = await readJson(request);
    if (typeof body.source !== 'string') return json(response, 400, { error: '検証する本文がありません。' });
    return json(response, 200, await validate(body.source, sceneName(body.name || '') || '', null, true));
  }
  if (request.method === 'POST' && url.pathname === '/api/compile') {
    const body = await readJson(request);
    if (typeof body.source !== 'string') return json(response, 400, { error: 'source is required' });
    try { return json(response, 200, { ok: true, program: await compileSource(body.source, sceneName(body.name || '') || '') }); }
    catch (error) { return json(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) }); }
  }
  if (request.method === 'POST' && url.pathname === '/api/native-build') {
    const body = await readJson(request);
    const name = sceneName(body.name);
    if (!name) return json(response, 400, { error: 'Invalid scene name' });
    try {
      const sourceFile = await safeScenePath(name);
      await fs.access(sourceFile);
      await ensureProjectDirectory(NATIVE_PACKAGES_ROOT, '.novel/build');
      const packageName = `${path.basename(name, path.extname(name))}.nsp.json`;
      await pack(sourceFile, await safeBuildPath(packageName, { createParents: true }), {
        projectRoot: PROJECT_ROOT,
        scenesRoot: SCENES_ROOT,
        assetsRoot: ASSETS_ROOT,
      });
      return json(response, 200, { ok: true, name: packageName, path: `.novel/build/${packageName}` });
    } catch (error) {
      return json(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (request.method === 'POST' && url.pathname === '/api/native-play') {
    try {
      const body = await readJson(request);
      return json(response, 200, await playWithNativeEngine(body.name));
    } catch (error) {
      return json(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (request.method === 'POST' && url.pathname === '/api/native-tools/build') {
    try { const result = await ensureNativeBuild(); return json(response, 200, { ok: true, stage: 'complete', output: result.output }); }
    catch (error) { return json(response, 200, { ok: false, stage: 'build', output: error instanceof Error ? error.message : String(error) }); }
  }
  if (request.method === 'POST' && url.pathname === '/api/native-tools/test') {
    try { return json(response, 200, await runNativeTests()); }
    catch (error) { return json(response, 200, { ok: false, stage: 'build', output: error instanceof Error ? error.message : String(error) }); }
  }
  if (request.method === 'POST' && url.pathname === '/api/native-tools/images') {
    try { return json(response, 200, await checkProjectImages()); }
    catch (error) { return json(response, 200, { ok: false, stage: 'image-check', output: error instanceof Error ? error.message : String(error) }); }
  }
  if (request.method === 'POST' && url.pathname === '/api/project-build') {
    const body = await readJson(request);
    return json(response, 200, await buildWholeProject(body.name));
  }
  return json(response, 404, { error: 'API が見つかりません。' });
}

async function main() {
  console.log(`Project: ${PROJECT_ROOT}`);
  await prepareProject();
  if (process.env.NOVEL_TEMP_STARTUP_WORKSPACE !== '1') await rememberProject(PROJECT_ROOT);
  try {
    await fs.access(CATALOG_FILE);
  } catch {
    await fs.writeFile(CATALOG_FILE, '# GUIで使う素材候補。カンマ区切りで追加できます。\ncharacter = heroine\nbg = school\nbgm = peaceful\nse = door_open\nvoice = heroine_greeting\nvideo = opening\nimage = logo\nposition = left, center, right\n', 'utf8');
  }
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`);
      if (request.method === 'GET' && url.pathname === '/api/native-package') await serveNativePackage(response, url);
      else if (url.pathname.startsWith('/api/')) await handleApi(request, response, url);
      else if (request.method === 'GET') await serveStatic(response, url.pathname);
      else text(response, 405, 'Method not allowed');
    } catch (error) {
      console.error(error);
      json(response, error?.code === 'EPATHOUTSIDE' ? 403 : 500, { error: error instanceof Error ? error.message : '予期しないエラーです。' });
    }
  });
  listenOnAvailablePort(server, INITIAL_PORT);
}

function listenOnAvailablePort(server, port, attempts = 0) {
  const onListening = () => {
    server.off('error', onError);
    console.log(`Novel Script Editor: http://127.0.0.1:${server.address().port}`);
  };
  const onError = (error) => {
    server.off('listening', onListening);
    if (error && error.code === 'EADDRINUSE' && attempts < MAX_PORT_ATTEMPTS) {
      const nextPort = port + 1;
      console.warn(`Port ${port} は使用中です。${nextPort} を試します。`);
      listenOnAvailablePort(server, nextPort, attempts + 1);
      return;
    }
    console.error(error);
    process.exitCode = 1;
  };
  server.once('error', onError);
  server.once('listening', onListening);
  server.listen(port, '127.0.0.1');
}

module.exports = { sceneGraph, validate, validateGraph, validateFlow, compileSource, buildWholeProject, collectSyntaxDiagnostics, handleApi, serveStatic };
if (require.main === module) main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
