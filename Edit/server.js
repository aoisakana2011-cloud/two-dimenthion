/* Local-only editor server. Scenario files never escape Edit/scenes. */
const http = require('node:http');
const { compileProject, resolveProjectScript } = require('../tools/project');
const { pack } = require('../tools/pack');
const fs = require('node:fs/promises');
const path = require('node:path');

const EDIT_ROOT = __dirname;
const SCENES_ROOT = path.join(EDIT_ROOT, 'scenes');
const SCENE_CONFIG = path.join(SCENES_ROOT, 'config.txt');
const DATA_ROOT = path.join(EDIT_ROOT, 'data');
const VARIABLES_FILE = path.join(DATA_ROOT, 'variables.json');
const ASSETS_FILE = path.join(DATA_ROOT, 'assets.json');
const ASSETS_ROOT = path.join(EDIT_ROOT, 'assets');
const CATALOG_FILE = path.join(EDIT_ROOT, 'catalog.txt');
const NATIVE_PACKAGES_ROOT = path.join(EDIT_ROOT, '..', 'build', 'native-packages');
const INITIAL_PORT = Number(process.env.PORT || 4173);
const MAX_PORT_ATTEMPTS = 10;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set(['.tds', '.txt']);
const CONTENT_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
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

function json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

function text(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  response.end(value);
}

function sceneName(value) {
  if (typeof value !== 'string') return null;
  let name = value.trim().replaceAll('\\', '/');
  if (name.startsWith('/') || name.includes('..') || !/^[A-Za-z0-9][A-Za-z0-9_./-]{0,159}$/.test(name)) return null;
  if (name.split('/').some((part) => !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(part))) return null;
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
  async function visit(directory, prefix = '') {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(path.join(directory, entry.name), relative);
      else if (relative.toLowerCase() !== 'config.txt' && ALLOWED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) result.push(relative);
    }
  }
  await visit(SCENES_ROOT);
  return result.sort((left, right) => left.localeCompare(right, 'ja'));
}

async function globalVariableTable(excludeName = '') {
  const { parse } = require('../dist');
  const { inferValueType } = require('../dist/checker/type-checker');
  const table = new Map();
  const owners = new Map();
  const scripts = [];
  for (const name of await listScenes()) {
    if (name === excludeName) continue;
    const script = parse(await fs.readFile(path.join(SCENES_ROOT, name), 'utf8'));
    scripts.push(script);
    for (const statement of script.globals) {
      if (statement.kind !== 'declare') continue;
      if (statement.type === 'infer') continue;
      const owner = owners.get(statement.name);
      if (owner) throw new Error(`変数 '${statement.name}' は '${owner}' で既に宣言されています。'${name}' では set を使用してください`);
      table.set(statement.name, statement.type);
      owners.set(statement.name, name);
    }
  }
  const pending = scripts.flatMap((script) => script.globals.filter((statement) => statement.kind === 'declare' && statement.type === 'infer').map((statement) => ({ statement, functions: script.functions })));
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

async function globalCharacterTable(excludeName = '') {
  const mainName = 'main.tds';
  if (excludeName === mainName) return new Map();
  const { parse } = require('../dist');
  const source = await fs.readFile(path.join(SCENES_ROOT, mainName), 'utf8');
  const script = parse(source);
  return new Map(script.characters.map((character) => [character.name, new Set(character.poses.map((pose) => pose.name))]));
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
  await visit(EDIT_ROOT);
  return result.sort((a, b) => a.path.localeCompare(b.path, 'ja'));
}

function collectGotos(instructions, result = []) {
  for (const instruction of instructions) {
    if (instruction.op === 'goto') result.push(instruction.scene);
    if (instruction.body) collectGotos(instruction.body, result);
    if (instruction.otherwise) collectGotos(instruction.otherwise, result);
    if (instruction.elseIf) instruction.elseIf.forEach((branch) => collectGotos(branch.body, result));
    if (instruction.options) instruction.options.forEach((opt) => collectGotos(opt.body, result));
  }
  return result;
}

async function sceneGraph() {
  const { parse, compile } = require('../dist');
  const nodes = [];
  const edges = [];
  for (const name of await listScenes()) {
    try {
      const globalVariables = await globalVariableTable(name);
      const characters = await globalCharacterTable(name);
      const program = await compileProject(await fs.readFile(path.join(SCENES_ROOT, name), 'utf8'), ASSETS_ROOT, SCENES_ROOT, globalVariables, characters);
      const instructions = program.scenes.flatMap((scene) => scene.instructions).concat(program.globals);
      const sceneNamesInFile = new Set(program.scenes.map((s) => s.name));
      nodes.push({ id: name, label: name, variables: program.variables.map((variable) => ({ ...variable, file: name })) });
      collectGotos(instructions).forEach((target) => {
        // 同一ファイル内のシーン遷移はファイル間エッジにしない
        if (!sceneNamesInFile.has(target)) {
          edges.push({ from: name, to: sceneName(target) || target });
        }
      });
    } catch { nodes.push({ id: name, label: name, variables: [], error: true }); }
  }
  return { nodes, edges };
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
    const nextNodes = graph.edges.filter((e) => e.from === tail).map((e) => e.to);
    for (const next of nextNodes) {
      if (!visited.has(next)) {
        visited.add(next);
        queue.push([...currentPath, next]);
      }
    }
  }

  // 経路が見つからなければ node.id 順をフォールバックとしつつ通知
  if (!pathFound) return { ok: false, errors: [{ file: end, message: '開始ファイルから終了ファイルへの経路がありません。' }] };
  // Validate every reachable branch, not just the first route found by BFS.
  const reachable = new Set(), pending = [start];
  while (pending.length) { const id = pending.pop(); if (reachable.has(id)) continue; reachable.add(id); graph.edges.filter(e => e.from === id).forEach(e => pending.push(e.to)); }
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
    graph.edges.filter((edge) => edge.from === state.file).forEach((edge) => states.push({ file: edge.to, defined: nextDefined }));
  }

  return { ok: errors.length === 0, start, end, checked: checkOrder, errors };
}

async function readSceneConfig() {
  const config = { start_scene: '' };
  try {
    const source = await fs.readFile(SCENE_CONFIG, 'utf8');
    for (const raw of source.split(/\r?\n/)) {
      const line = raw.replace(/#.*/, '').trim();
      const match = /^([A-Za-z][A-Za-z0-9_-]*)\s*=\s*(.*)$/.exec(line);
      if (match) config[match[1]] = match[2].trim();
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return config;
}

async function rebuildVariables() {
  const entries = new Map();
  for (const name of await listScenes()) {
    try {
      const globalVariables = await globalVariableTable(name);
      const { parse, compile } = require('../dist');
      const source = await fs.readFile(path.join(SCENES_ROOT, name), 'utf8');
      for (const variable of compile(parse(source), globalVariables).variables) {
        const definitions = (variable.definitions || []).map((location) => ({ ...location, file: name }));
        const references = (variable.references || []).map((reference) => ({ ...reference, file: name }));
        // A variable is project-wide metadata.  Do not create a new entry for
        // every file that merely sees the same external global.
        const key = JSON.stringify([variable.scope, variable.definedIn, variable.name]);
        const existing = entries.get(key);
        if (existing) { existing.definitions.push(...definitions); existing.references.push(...references); }
        else entries.set(key, { ...variable, definitions, references });
      }
    } catch { /* Invalid files remain available for editor validation. */ }
  }
  await fs.mkdir(DATA_ROOT, { recursive: true });
  const variables = [...entries.values()];
  await fs.writeFile(VARIABLES_FILE, JSON.stringify({ $schema: './variables.schema.json', variables }, null, 2) + '\n', 'utf8');
  return variables;
}

async function rebuildAssets() {
  const assets = new Map();
  for (const name of await listScenes()) {
    try {
      const globalVariables = await globalVariableTable(name);
      const { parse, compile } = require('../dist');
      const source = await fs.readFile(path.join(SCENES_ROOT, name), 'utf8');
      const program = compile(parse(source), globalVariables);
      program.assets.forEach((asset) => assets.set(`${asset.type}:${asset.name}`, { type: asset.type, name: asset.name, path: asset.path, definedIn: name }));
      program.characters.forEach((character) => character.poses.forEach((pose) => assets.set(`char:${character.name}.${pose.name}`, { type: 'char', name: character.name, pose: pose.name, path: pose.path, definedIn: name })));
    } catch { /* Invalid files remain available for editor validation. */ }
  }
  const result = [...assets.values()];
  await fs.mkdir(DATA_ROOT, { recursive: true });
  await fs.writeFile(ASSETS_FILE, JSON.stringify({ $schema: './assets.schema.json', assets: result }, null, 2) + '\n', 'utf8');
  return result;
}

function scenePath(value) {
  const name = sceneName(value);
  if (!name) return null;
  const root = path.resolve(SCENES_ROOT);
  const target = path.resolve(root, name);
  return target.startsWith(`${root}${path.sep}`) ? target : null;
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

async function validate(source, name = '') {
  try {
    const { parse } = require('../dist');
    const { analyzeScript } = require('../dist/checker/analyzer');
    const ast = await resolveProjectScript(source, SCENES_ROOT);
    const globalVariables = await globalVariableTable(name);
    const characters = await globalCharacterTable(name);
    const diagnostics = analyzeScript(ast, 'current', globalVariables, characters);
    if (diagnostics.some((item) => item.severity === 'error')) return { ok: false, diagnostics, error: diagnostics.find((item) => item.severity === 'error').message };
    try {
      const program = await compileProject(source, ASSETS_ROOT, SCENES_ROOT, globalVariables, characters);
      return { ok: true, diagnostics, statements: ast.body.length, instructions: program.globals.length };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const projectDiagnostics = message.split(/\r?\n/).filter(Boolean).map((entry) => {
        const assetPath = entry.match(/(?:asset|アセット)\s*'([^']+)'/)?.[1] || entry.match(/'(assets[\\/][^']+)'/)?.[1];
        const assetLine = assetPath ? source.split(/\r?\n/).findIndex((line) => line.includes(assetPath)) + 1 : 0;
        const line = Number(entry.match(/line\s+(\d+)/i)?.[1] || entry.match(/行\s*(\d+)/)?.[1] || assetLine || 1);
        return { code: 'project-error', severity: 'error', message: entry, file: 'current', line, column: 1 };
      });
      diagnostics.push(...projectDiagnostics);
      return { ok: false, diagnostics, error: message };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, diagnostics: [{ code: 'syntax-error', severity: 'error', message, file: 'current', line: Number(message.match(/line\s+(\d+)/i)?.[1] || 1), column: Number(message.match(/column\s+(\d+)/i)?.[1] || 1) }], error: message };
  }
}

async function compileSource(source, name = '') {
  return compileProject(source, ASSETS_ROOT, SCENES_ROOT, await globalVariableTable(name), await globalCharacterTable(name));
}

async function serveStatic(response, pathname) {
  if (pathname === '/assets' || pathname.startsWith('/assets/')) {
    const relative = decodeURIComponent(pathname.slice('/assets/'.length));
    const requested = path.resolve(ASSETS_ROOT, relative);
    const root = path.resolve(ASSETS_ROOT);
    if (!requested.startsWith(`${root}${path.sep}`)) {
      text(response, 403, 'Forbidden');
      return;
    }
    try {
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
      if (error && error.code === 'ENOENT') {
        text(response, 404, 'Not found');
        return;
      }
      throw error;
    }
    return;
  }
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (!['index.html', 'editor.js', 'styles.css', 'player.html', 'player.js', 'runtime.js', 'player.css', 'flow.html', 'flow.js', 'flow-validation.js', 'flow.css', 'engine.html'].includes(relative)) {
    text(response, 404, 'Not found');
    return;
  }
  const extension = path.extname(relative);
  response.writeHead(200, { 'Content-Type': CONTENT_TYPES[extension], 'Cache-Control': 'no-store' });
  response.end(await fs.readFile(path.join(EDIT_ROOT, relative)));
}

async function serveNativePackage(response, url) {
  const name = nativePackageName(url.searchParams.get('name'));
  if (!name) return json(response, 400, { error: 'Invalid native package name' });
  const file = path.join(NATIVE_PACKAGES_ROOT, name);
  try {
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
  if (request.method === 'GET' && url.pathname === '/api/files') return json(response, 200, { files: await listProjectFiles() });
  if (request.method === 'DELETE' && url.pathname === '/api/file') {
    const body = await readJson(request); const name = String(body.path || '').replaceAll('\\', '/');
    if (!/^(assets|scenes|data)\/[A-Za-z0-9_./-]+$/.test(name) || name.includes('..')) return json(response, 400, { error: '削除できないパスです' });
    const target = path.resolve(EDIT_ROOT, name); const roots = [ASSETS_ROOT, SCENES_ROOT, DATA_ROOT];
    if (!roots.some((root) => target.startsWith(`${path.resolve(root)}${path.sep}`))) return json(response, 400, { error: '削除できない場所です' });
    await fs.unlink(target);
    await rebuildVariables();
    await rebuildAssets();
    return json(response, 200, { ok: true });
  }
  if (request.method === 'GET' && url.pathname === '/api/scene-graph') return json(response, 200, await sceneGraph());
  if (request.method === 'POST' && url.pathname === '/api/validate-flow') { const body = await readJson(request); return json(response, 200, await validateFlow(body.start, body.end)); }
  if (request.method === 'GET' && url.pathname === '/api/scene-config') {
    return json(response, 200, await readSceneConfig());
  }
  if (request.method === 'GET' && url.pathname === '/api/variables') {
    try { return json(response, 200, JSON.parse(await fs.readFile(VARIABLES_FILE, 'utf8'))); }
    catch { return json(response, 200, { variables: [] }); }
  }
  if (request.method === 'GET' && url.pathname === '/api/assets') {
    try { return json(response, 200, JSON.parse(await fs.readFile(ASSETS_FILE, 'utf8'))); }
    catch { return json(response, 200, { assets: [] }); }
  }
  if (request.method === 'GET' && url.pathname === '/api/catalog') {
    return json(response, 200, await readCatalog());
  }
  if (request.method === 'GET' && url.pathname === '/api/engine-settings') {
    const file = path.join(EDIT_ROOT, '..', 'native', 'engine_data', 'engine.txt');
    const out = {}; try { for (const line of (await fs.readFile(file, 'utf8')).split(/\r?\n/)) { const i = line.indexOf('='); if (i > 0 && !line.trimStart().startsWith('#')) out[line.slice(0, i).trim()] = line.slice(i + 1).trim(); } } catch {}
    return json(response, 200, out);
  }
  if (request.method === 'PUT' && url.pathname === '/api/engine-settings') {
    const body = await readJson(request); const file = path.join(EDIT_ROOT, '..', 'native', 'engine_data', 'engine.txt');
    const allowed = ['dialog.x','dialog.y','dialog.width','dialog.height','dialog.speaker_x','dialog.text_x','dialog.speaker_y','dialog.text_y','dialog.speaker_size','dialog.text_size','dialog.text_color','dialog.background_image','font.path','font.size','window.title','window.width','window.height'];
    // 既存設定を読み込んでマージ
    const current = {};
    try {
      for (const line of (await fs.readFile(file, 'utf8')).split(/\r?\n/)) {
        const i = line.indexOf('=');
        if (i > 0 && !line.trimStart().startsWith('#')) current[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      }
    } catch {}
    for (const key of allowed) {
      if (body[key] !== undefined) current[key] = String(body[key]);
    }
    await fs.writeFile(file, Object.entries(current).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', 'utf8');
    return json(response, 200, { ok: true });
  }
  if (request.method === 'GET' && url.pathname === '/api/scene') {
    const name = sceneName(url.searchParams.get('name'));
    if (!name) return json(response, 400, { error: '無効なファイル名です。' });
    try {
      return json(response, 200, { name, source: await fs.readFile(scenePath(name), 'utf8') });
    } catch (error) {
      if (error && error.code === 'ENOENT') return json(response, 404, { error: 'ファイルが見つかりません。' });
      throw error;
    }
  }
  if (request.method === 'PUT' && url.pathname === '/api/scene') {
    const body = await readJson(request);
    const name = sceneName(String(body.name || '').replace(/^scenes\//, ''));
    if (!name) return json(response, 400, { error: 'ファイル名は英数字・._- を使ってください。' });
    if (typeof body.source !== 'string') return json(response, 400, { error: '保存する本文がありません。' });
    if (Buffer.byteLength(body.source, 'utf8') > MAX_BODY_BYTES) return json(response, 413, { error: 'ファイルは 2 MB 以下にしてください。' });
    try { await compileSource(body.source, name); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 編集途中の構文・型エラーは保存を妨げないが、既存変数の再宣言だけは
      // プロジェクト全体の変数契約を壊すため書き込み前に拒否する。
      if (/既に宣言|再宣言/.test(message)) return json(response, 400, { error: message });
    }
    const target = scenePath(name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, body.source, 'utf8');
    await fs.mkdir(DATA_ROOT, { recursive: true });
    // 保存した1ファイルだけでなく全ファイルの集計を実行して更新
    await rebuildVariables();
    await rebuildAssets();
    return json(response, 200, { ok: true, name });
  }
  if (request.method === 'POST' && url.pathname === '/api/validate') {
    const body = await readJson(request);
    if (typeof body.source !== 'string') return json(response, 400, { error: '検証する本文がありません。' });
    return json(response, 200, await validate(body.source, sceneName(body.name || '') || ''));
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
      await fs.access(scenePath(name));
      await fs.mkdir(NATIVE_PACKAGES_ROOT, { recursive: true });
      const packageName = `${path.basename(name, path.extname(name))}.nsp.json`;
      await pack(scenePath(name), path.join(NATIVE_PACKAGES_ROOT, packageName), {
        scenesRoot: SCENES_ROOT,
        assetsRoot: ASSETS_ROOT,
      });
      return json(response, 200, { ok: true, name: packageName, path: `build/native-packages/${packageName}` });
    } catch (error) {
      return json(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return json(response, 404, { error: 'API が見つかりません。' });
}

async function main() {
  await fs.mkdir(SCENES_ROOT, { recursive: true });
  try { await fs.access(SCENE_CONFIG); } catch { await fs.writeFile(SCENE_CONFIG, '# Scene project settings\nstart_scene = main.tds\ntitle = Novel Script\n', 'utf8'); }
  await fs.mkdir(ASSETS_ROOT, { recursive: true });
  await fs.mkdir(DATA_ROOT, { recursive: true });
  try {
    await fs.access(CATALOG_FILE);
  } catch {
    await fs.writeFile(CATALOG_FILE, '# GUIで使う素材候補。カンマ区切りで追加できます。\ncharacter = heroine\nbg = school\nbgm = peaceful\nse = door_open\nvoice = heroine_greeting\nvideo = opening\nimage = logo\nposition = left, center, right\n', 'utf8');
  }
  await rebuildVariables();
  await rebuildAssets();
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`);
      if (request.method === 'GET' && url.pathname === '/api/native-package') await serveNativePackage(response, url);
      else if (url.pathname.startsWith('/api/')) await handleApi(request, response, url);
      else if (request.method === 'GET') await serveStatic(response, url.pathname);
      else text(response, 405, 'Method not allowed');
    } catch (error) {
      console.error(error);
      json(response, 500, { error: error instanceof Error ? error.message : '予期しないエラーです。' });
    }
  });
  listenOnAvailablePort(server, INITIAL_PORT);
}

function listenOnAvailablePort(server, port, attempts = 0) {
  const onListening = () => {
    server.off('error', onError);
    console.log(`Novel Script Editor: http://127.0.0.1:${port}`);
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

module.exports = { sceneGraph, validateGraph, validateFlow, compileSource, handleApi, serveStatic };
if (require.main === module) main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
