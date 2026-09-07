const editor = document.querySelector('#editor');
const sceneName = document.querySelector('#scene-name');
const sceneList = document.querySelector('#scene-list');
const result = document.querySelector('#result');
const status = document.querySelector('#status');
const lineNumbers = document.querySelector('#line-numbers');
const suggestionBox = document.querySelector('#suggestions');
const fileTree = document.querySelector('#file-tree');
const fileInfo = document.querySelector('#file-info');
const sceneFlow = document.querySelector('#scene-flow');
const variableInspector = document.querySelector('#variable-inspector');
const highlight = document.querySelector('#highlight');
const minimap = document.querySelector('#minimap');
const minimapContent = document.querySelector('#minimap-content');
const minimapViewport = document.querySelector('#minimap-viewport');
const editorTabs = document.querySelector('#editor-tabs');
const documentActions = document.querySelector('.document-actions');
document.querySelector('.topbar-right')?.prepend(documentActions);
if (new URLSearchParams(location.search).get('embedded') === '1') document.documentElement.classList.add('embedded-editor');
let catalog = {};
let suggestions = [];
let suggestionIndex = 0;
let completionRange = null;
let sceneNames = [];
let knownVariables = [];
let suggestionRefreshId = 0;
let validationTimer = null;
let diagnosticText = '';
let diagnostics = [];
let validationSequence = 0;
let isDirty = false;
let middleScroll = null;
let minimapDrag = null;
const undoStack = [];
const redoStack = [];
let restoringHistory = false;
const openTabs = [];
const splitTabs = [];
const fileLabel = (name) => String(name || '').replace(/[\\/]$/, '').split(/[\\/]/).pop();
const variableTooltip = document.createElement('div');
variableTooltip.className = 'variable-tooltip';
variableTooltip.hidden = true;
document.body.append(variableTooltip);
function updateDirtyState(value) { isDirty = value; document.querySelector('.dirty-mark')?.classList.toggle('visible', value); document.querySelectorAll('#file-tree .scene-file').forEach((item) => item.classList.toggle('file-dirty', value && item.textContent.includes(sceneName.value.split('/').pop()))); }
function editorSnapshot() { return { value: editor.value, start: editor.selectionStart, end: editor.selectionEnd }; }
function rememberUndo() {
  if (restoringHistory) return;
  const state = editorSnapshot();
  const previous = undoStack.at(-1);
  if (!previous || previous.value !== state.value || previous.start !== state.start || previous.end !== state.end) undoStack.push(state);
  if (undoStack.length > 200) undoStack.shift();
  redoStack.length = 0;
}
function clearEditorHistory() { undoStack.length = 0; redoStack.length = 0; }
function restoreEditorHistory(from, to) {
  const state = from.pop();
  if (!state) return false;
  to.push(editorSnapshot());
  restoringHistory = true;
  editor.value = state.value;
  editor.setSelectionRange(state.start, state.end);
  editor.dispatchEvent(new Event('input'));
  restoringHistory = false;
  editor.focus();
  hideSuggestions();
  return true;
}
function normalizeVariables(values) {
  const merged = new Map();
  for (const variable of values) {
    if (!variable || typeof variable.name !== 'string' || !variable.name) continue;
    const key = JSON.stringify([variable.name, variable.scope || 'global', variable.definedIn || 'global']);
    const current = merged.get(key);
    if (!current) {
      merged.set(key, { ...variable, definitions: [...(variable.definitions || [])], references: [...(variable.references || [])] });
      continue;
    }
    for (const field of ['definitions', 'references']) {
      const known = new Set(current[field].map((location) => JSON.stringify(location)));
      for (const location of variable[field] || []) if (!known.has(JSON.stringify(location))) current[field].push(location);
    }
  }
  return [...merged.values()];
}
function highlightSource(source) {
  const escape = (s) => s.replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
  const tokens = [];
  const push = (kind, value, closed = true) => tokens.push({ kind, value, closed, role: '' });
  for (let i = 0; i < source.length;) {
    const c = source[i];
    if (/\s/.test(c)) { const start = i++; while (i < source.length && /\s/.test(source[i])) i++; push('space', source.slice(start, i)); continue; }
    if (c === '#' || (c === '/' && source[i + 1] === '/')) { push('comment', source.slice(i)); break; }
    if (c === '"') {
      const start = i++;
      let closed = false;
      while (i < source.length) {
        if (source[i] === '\\') { i += Math.min(2, source.length - i); continue; }
        if (source[i++] === '"') { closed = true; break; }
      }
      push('string', source.slice(start, i), closed);
      continue;
    }
    if (/[0-9]/.test(c)) { const start = i++; while (i < source.length && /[0-9]/.test(source[i])) i++; push('number', source.slice(start, i)); continue; }
    if (/[A-Za-z_]/.test(c)) { const start = i++; while (i < source.length && /[A-Za-z0-9_]/.test(source[i])) i++; push('word', source.slice(start, i)); continue; }
    const pair = source.slice(i, i + 2);
    if (['==', '!=', '>=', '<=', '->', '=>', '..'].includes(pair)) { push('operator', pair); i += 2; continue; }
    if ('=+-*/%<>!'.includes(c)) { push('operator', c); i++; continue; }
    if ('{}[]():,.'.includes(c)) { push('punctuation', c); i++; continue; }
    push('plain', c); i++;
  }

  const significant = tokens.filter((token) => token.kind !== 'space' && token.kind !== 'comment');
  const keywords = new Set(['scene', 'asset', 'character', 'struct', 'say', 'bg', 'bgm', 'char', 'show', 'hide', 'clear', 'play', 'wait', 'effect', 'const', 'set', 'unset', 'if', 'elif', 'else', 'and', 'or', 'not', 'for', 'from', 'to', 'step', 'while', 'choice', 'fn', 'return', 'goto', 'include']);
  const types = new Set(['int', 'str', 'none', 'dict']);
  const builtins = new Set(['narrator', 'left', 'center', 'right', 'fade', 'black', 'white', 'async', 'blocking', 'voice', 'video', 'image', 'se']);
  for (const token of significant) {
    if (token.kind !== 'word') continue;
    if (types.has(token.value)) token.role = 'type';
    else if (keywords.has(token.value)) token.role = 'keyword';
    else if (builtins.has(token.value)) token.role = 'builtin';
    else token.role = 'variable';
  }
  const wordAfter = (value, role, offset = 1) => {
    const index = significant.findIndex((token) => token.kind === 'word' && token.value === value);
    const target = significant[index + offset];
    if (index >= 0 && target?.kind === 'word') target.role = role;
  };
  wordAfter('scene', 'scene');
  wordAfter('character', 'asset');
  wordAfter('fn', 'function');
  wordAfter('asset', 'keyword');
  const fnIndex = significant.findIndex((token) => token.kind === 'word' && token.value === 'fn');
  if (fnIndex >= 0) {
    const open = significant.findIndex((token, index) => index > fnIndex && token.value === '(');
    const close = significant.findIndex((token, index) => index > open && token.value === ')');
    for (let index = open + 1; open >= 0 && index < (close < 0 ? significant.length : close); index++) {
      if (significant[index].kind === 'word' && significant[index + 1]?.value === ':') significant[index].role = 'declaration';
    }
  }
  const first = significant[0];
  if (first?.kind === 'word') {
    if (['int', 'str'].includes(first.value)) {
      const declaration = significant.find((token, index) => index > 0 && token.kind === 'word');
      if (declaration) declaration.role = 'declaration';
    }
    if (first.value === 'const') {
      const declaration = significant.find((token, index) => index > 1 && token.kind === 'word' && ['int', 'str', 'dict', ']'].includes(significant[index - 1]?.value));
      if (declaration) declaration.role = 'declaration';
    }
    if (first.value === 'dict') {
      const closing = significant.findIndex((token) => token.value === ']');
      if (closing >= 0 && significant[closing + 1]?.kind === 'word') significant[closing + 1].role = 'declaration';
    }
    if (first.value === 'for' && significant[1]?.kind === 'word') significant[1].role = 'declaration';
    if (first.value === 'goto') significant.slice(1).forEach((token) => { if (token.kind !== 'comment') token.role = 'scene'; });
    if (first.value === 'asset' && significant[2]?.kind === 'word') significant[2].role = 'asset';
    if (!keywords.has(first.value) && !types.has(first.value) && significant[1]?.value === '=') first.role = 'property';
  }
  significant.forEach((token, index) => {
    if (token.kind === 'word' && significant[index + 1]?.value === '(' && token.value !== 'fn') token.role = 'function';
    if (token.value === ':' && significant[index + 1]?.kind === 'word' && types.has(significant[index + 1].value)) significant[index + 1].role = 'type';
  });
  const renderString = (token) => {
    const value = escape(token.value).replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, '<span class="hl-interpolation">{$1}</span>');
    return `<span class="hl-string${token.closed ? '' : ' hl-invalid'}">${value}</span>`;
  };
  return tokens.map((token) => {
    if (token.kind === 'string') return renderString(token);
    if (token.kind === 'comment') return `<span class="hl-comment">${escape(token.value)}</span>`;
    if (token.kind === 'number') return `<span class="hl-number">${token.value}</span>`;
    if (token.kind === 'operator') return `<span class="hl-operator">${escape(token.value)}</span>`;
    if (token.kind === 'punctuation') return `<span class="hl-punctuation">${escape(token.value)}</span>`;
    if (token.role) return `<span class="hl-${token.role}">${escape(token.value)}</span>`;
    return escape(token.value);
  }).join('');
}
function updateHighlight() { if (!highlight) return; highlight.innerHTML = highlightSource(editor.value); }

const KEYWORDS = ['scene', 'asset', 'character', 'struct', 'int', 'str', 'dict', 'const', 'say', 'bg', 'bgm', 'char', 'show', 'hide', 'clear', 'play', 'wait', 'effect', 'set', 'unset', 'if', 'elif', 'else', 'and', 'or', 'not', 'for', 'while', 'choice', 'fn', 'return', 'goto', 'include'];

function setStatus(message, kind = '') {
  if (kind !== 'error') document.querySelector('#runtime-error')?.remove();
  const dot = status.querySelector('.status-dot') || document.createElement('span');
  status.replaceChildren(dot, document.createTextNode(message));
  status.className = `status-chip ${kind}`.trim();
}

function updateLineNumbers() {
  const count = editor.value.split('\n').length;
  lineNumbers.textContent = Array.from({ length: count }, (_, index) => index + 1).join('\n');
}

function insert(text, separateLine = true) {
  const start = editor.selectionStart;
  const end = editor.selectionEnd;
  const before = editor.value.slice(0, start);
  const after = editor.value.slice(end);
  const prefix = separateLine && before && !before.endsWith('\n') ? '\n' : '';
  rememberUndo();
  editor.value = `${before}${prefix}${text}${after}`;
  const caret = start + prefix.length + text.length;
  editor.focus();
  editor.setSelectionRange(caret, caret);
  editor.dispatchEvent(new Event('input'));
}

async function request(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (response.ok) document.querySelector('#runtime-error')?.remove();
  if (!response.ok) throw new Error(data.error || '通信に失敗しました。');
  if (options?.method && options.method !== 'GET' && (url === '/api/scene' || url === '/api/file')) refreshFiles().catch(showError);
  return data;
}

async function refreshScenes(selected = '') {
  const { scenes } = await request('/api/scenes');
  sceneNames = scenes;
  if (!sceneList) return refreshFiles();
  sceneList.replaceChildren();
  const root = { folders: new Map(), files: [] };
  for (const name of scenes) {
    const parts = name.split('/');
    let node = root;
    parts.forEach((part, index) => {
      if (index === parts.length - 1) node.files.push({ name: part, path: name });
      else { if (!node.folders.has(part)) node.folders.set(part, { folders: new Map(), files: [] }); node = node.folders.get(part); }
    });
  }
  const draw = (node, parent, depth = 0) => {
    [...node.folders.entries()].sort().forEach(([name, child]) => {
      const folder = document.createElement('div'); folder.className = 'scene-folder'; folder.style.paddingLeft = `${depth * 14}px`; folder.textContent = `› ${name}`; parent.append(folder);
      const contents = document.createElement('div'); contents.className = 'scene-folder-contents'; parent.append(contents);
      folder.onclick = () => { contents.hidden = !contents.hidden; folder.textContent = `${contents.hidden ? '›' : '⌄'} ${name}`; };
      draw(child, contents, depth + 1);
    });
    node.files.sort((a, b) => a.name.localeCompare(b.name, 'ja')).forEach((file) => {
      const item = document.createElement('button'); item.type = 'button'; item.className = `scene-file${file.path === selected ? ' selected' : ''}`; item.style.paddingLeft = `${depth * 14}px`; item.textContent = `≡ ${file.name}`; item.onclick = () => openScene(file.path); parent.append(item);
    });
  };
  draw(root, sceneList);
  refreshFiles().catch(showError);
}

async function refreshFiles() {
  const { files } = await request('/api/files');
  const visible = files.filter((file) => /^scenes\//.test(file.path)).map((file) => ({ ...file, displayPath: file.path.replace(/^scenes\//, '') }));
  const root = { folders: new Map(), files: [] };
  for (const file of visible) { const parts = file.displayPath.split('/'); let node = root; parts.forEach((part, index) => { if (index === parts.length - 1) { if (file.directory) { if (!node.folders.has(part)) node.folders.set(part, { folders: new Map(), files: [] }); } else node.files.push({ name: part, path: file.path }); } else { if (!node.folders.has(part)) node.folders.set(part, { folders: new Map(), files: [] }); node = node.folders.get(part); } }); }
  const expandedFolders = new Set([...fileTree.querySelectorAll('.scene-folder')].filter((folder) => folder.nextElementSibling && !folder.nextElementSibling.hidden).map((folder) => folder.textContent.replace(/[›⌄+]/g, '').trim()));
  fileTree.replaceChildren();
  const drawFile = (node, parent, depth = 0, folderPath = '') => {
    [...node.folders].sort().forEach(([name, child]) => {
      const folder = document.createElement('div'); folder.className = 'scene-folder'; folder.style.paddingLeft = `${depth * 14}px`; folder.textContent = `› ${name}`; const path = folderPath ? `${folderPath}/${name}` : name; const contents = document.createElement('div'); contents.className = 'scene-folder-contents'; contents.hidden = true; folder.onclick = () => { contents.hidden = !contents.hidden; folder.textContent = `${contents.hidden ? '›' : '⌄'} ${name}`; }; folder.oncontextmenu = (event) => { event.preventDefault(); addSceneInUi(path).catch(showError); }; parent.append(folder, contents); drawFile(child, contents, depth + 1, path);
    });
    node.files.sort((a, b) => a.name.localeCompare(b.name, 'ja')).forEach((file) => {
      const item = document.createElement('div');
      item.className = 'scene-file';
      item.dataset.path = file.path;
      const openButton = document.createElement('button');
      openButton.type = 'button';
      openButton.className = 'scene-file-open';
      openButton.style.paddingLeft = `${depth * 14}px`;
      openButton.textContent = `≡ ${file.name}`;
      item.oncontextmenu = (event) => {
        event.preventDefault();
        showFileInfo(file.path).catch(showError);
      };
      if (/\.(tds|txt)$/i.test(file.path)) {
        openButton.title = 'クリック: 左で開く / Shift+クリック: 右へ移動';
        openButton.onclick = (event) => {
          const name = file.path.replace(/^scenes\//, '');
          if (event.shiftKey) moveTabToRight(name).catch(showError);
          else openScene(name).catch(showError);
        };
      }
      item.append(openButton);
      parent.append(item);
    });
  };
  drawFile(root, fileTree);
  fileTree.querySelectorAll('.scene-folder').forEach((folder) => {
    const label = folder.textContent.replace(/[›⌄+]/g, '').trim();
    const contents = folder.nextElementSibling;
    if (expandedFolders.has(label) && contents?.classList.contains('scene-folder-contents')) {
      contents.hidden = false;
      folder.textContent = `⌄ ${label}`;
    }
  });
  fileTree.querySelectorAll('.scene-file').forEach((item) => {
    const button = document.createElement('button');
    button.className = 'tree-action delete';
    button.textContent = '🗑';
    button.title = '削除';
    button.onclick = async (event) => {
      event.stopPropagation();
      const path = item.dataset.path;
      if (path && await uiConfirm(`${path} を削除しますか？`)) {
        await request('/api/file', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path }),
        });
        await forgetDeletedScene(path.replace(/^scenes\//, ''));
        await refreshFiles();
        await refreshScenes();
      }
    };
    item.append(button);
  });
  fileTree.querySelectorAll('.scene-folder').forEach((folder) => {
    const button = document.createElement('button');
    button.className = 'tree-action';
    button.textContent = '+';
    button.title = 'ファイル追加';
    button.onclick = (event) => {
      event.stopPropagation();
      const name = folder.textContent.replace(/^\S+\s*/, '').replace('+', '').trim();
      addSceneInUi(name).catch(showError);
    };
    folder.append(button);
  });
}

async function showFileInfo(path) {
  const graph = await request('/api/scene-graph');
  const node = graph.nodes.find((item) => item.id === path);
  const targets = graph.edges.filter((edge) => edge.from === path).map((edge) => edge.to);
  const variables = (node?.variables || []).map((variable) => {
    const definitions = (variable.definitions || []).length;
    const references = (variable.references || []).length;
    return `${variable.name}: ${variable.type} (定義${definitions} / 参照${references})`;
  });
  fileInfo.textContent = `goto: ${targets.length ? targets.join(', ') : 'なし'} / 変数: ${variables.length ? variables.join(', ') : 'なし'}`;
}
async function addSceneInUi(folder) {
  const name = await uiPrompt(`${folder} に追加するシーン名`, '');
  if (!name) return;
  const path = `${folder}/${name.replace(/^\/+/, '')}`;
  await request('/api/scene', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: path, source: `# ${path}\n` }) });
  await refreshFiles();
  await refreshScenes();
}
async function refreshSceneGraph() {
  if (!sceneFlow) return;
  const graph = await request('/api/scene-graph');
  sceneFlow.replaceChildren();
  const width = 230, row = 34, height = Math.max(80, graph.nodes.length * row + 20);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', `0 0 ${width} ${height}`); svg.setAttribute('role', 'img');
  const positions = new Map(graph.nodes.map((node, index) => [node.id, { x: 8, y: 10 + index * row }]));
  graph.edges.forEach((edge) => { const from = positions.get(edge.from), to = positions.get(edge.to); if (!from || !to) return; const line = document.createElementNS('http://www.w3.org/2000/svg', 'line'); line.setAttribute('x1', 190); line.setAttribute('y1', from.y + 10); line.setAttribute('x2', 190); line.setAttribute('y2', to.y + 10); line.setAttribute('class', 'flow-edge'); svg.append(line); });
  graph.nodes.forEach((node, index) => { const p = positions.get(node.id); const group = document.createElementNS('http://www.w3.org/2000/svg', 'g'); group.setAttribute('class', `flow-node${node.error ? ' error' : ''}`); group.setAttribute('transform', `translate(${p.x},${p.y})`); const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect'); rect.setAttribute('width', 190); rect.setAttribute('height', 22); rect.setAttribute('rx', 4); const text = document.createElementNS('http://www.w3.org/2000/svg', 'text'); text.setAttribute('x', 8); text.setAttribute('y', 15); text.textContent = node.label; group.append(rect, text); group.addEventListener('mouseenter', () => showVariables(node)); group.addEventListener('click', () => openScene(node.id).catch(showError)); svg.append(group); });
  sceneFlow.append(svg);
}

function showVariables(node) {
  variableInspector.replaceChildren();
  const title = document.createElement('strong'); title.textContent = node.label; variableInspector.append(title);
  const definitions = node.variables.flatMap((variable) => variable.definitions || []).map((location) => `${location.scope}: ${location.container}`);
  const references = node.variables.flatMap((variable) => (variable.references || []).map((location) => `${variable.name} · ${location.kind || 'expression'} · ${location.scope}: ${location.container}`));
  const line = (label, values) => { const element = document.createElement('div'); element.className = 'variable-group'; element.textContent = `${label}: ${values.length ? values.join(', ') : 'なし'}`; variableInspector.append(element); };
  line('定義', definitions); line('参照', references);
}

let projectAssets = [];
async function refreshCatalog() {
  try {
    const [catData, assetData] = await Promise.all([request('/api/catalog'), request('/api/assets')]);
    catalog = catData.catalog || {};
    projectAssets = assetData.assets || [];
    setStatus('素材設定を読み込みました', 'ok');
    updateSuggestions();
  } catch {
    catalog = {};
    projectAssets = [];
  }
}

function completionContext() {
  const end = editor.selectionStart;
  if (editor.selectionStart !== editor.selectionEnd) return null;
  const source = editor.value;
  const lineStart = source.lastIndexOf('\n', end - 1) + 1;
  const line = source.slice(lineStart, end);
  if ((line.split('"').length - 1) % 2) return null;

  let start = end;
  while (start > lineStart && !/[\s{}"=:><!+\-]/.test(source[start - 1])) start--;
  const prefix = source.slice(start, end);
  const words = source.slice(lineStart, start).trim().split(/\s+/).filter(Boolean);
  return { start, end, prefix, words, line };
}

function candidatesFor(context) {
  let [command, ...args] = context.words;
  if (!command) return KEYWORDS;
  if (command === 'show' && args[0] === 'char') {
    args = args.slice(1);
    command = 'char';
  }

  // シナリオおよびプロジェクトで宣言されたキャラクターと表情を抽出
  const charDefs = new Map();
  for (const asset of projectAssets) {
    if (asset.type === 'char') {
      if (!charDefs.has(asset.name)) charDefs.set(asset.name, new Set());
      if (asset.pose) charDefs.get(asset.name).add(asset.pose);
    }
  }
  // 現在のエディタ本文のキャラクター定義もパース
  for (const m of editor.value.matchAll(/\bcharacter\s+([A-Za-z][A-Za-z0-9_-]*)\s*\{([^}]*)\}/g)) {
    const cName = m[1];
    if (!charDefs.has(cName)) charDefs.set(cName, new Set());
    for (const pm of m[2].matchAll(/([A-Za-z][A-Za-z0-9_-]*)\s*=/g)) {
      charDefs.get(cName).add(pm[1]);
    }
  }

  if (command === 'char') {
    if (args.length === 0) return [...charDefs.keys(), ...(catalog.character || [])];
    if (args.length === 1) return ['left', 'center', 'right'];
    if (args.length === 2) {
      const poses = charDefs.get(args[0]);
      return poses && poses.size ? [...poses] : ['normal', 'smile', 'sad', 'angry'];
    }
  }
  if (command === 'say' && args.length === 0) {
    return [...new Set([...charDefs.keys(), 'narrator', 'none'])];
  }
  if (command === 'bg') {
    const bgs = projectAssets.filter((a) => a.type === 'bg').map((a) => a.name);
    return [...new Set([...bgs, ...(catalog.bg || [])])];
  }
  if (command === 'bgm') {
    const bgms = projectAssets.filter((a) => a.type === 'bgm').map((a) => a.name);
    return [...new Set([...bgms, ...(catalog.bgm || [])])];
  }
  if (command === 'play' && ['se', 'voice', 'bgm', 'video'].includes(args[0])) {
    const plays = projectAssets.filter((a) => a.type === args[0]).map((a) => a.name);
    return [...new Set([...plays, ...(catalog[args[0]] || [])])];
  }
  if (command === 'show' && args.length === 0) return ['char', 'image'];
  if (command === 'show' && args[0] === 'image' && args.length === 1) {
    const imgs = projectAssets.filter((a) => a.type === 'image').map((a) => a.name);
    return [...new Set([...imgs, ...(catalog.image || [])])];
  }
  if (command === 'clear' || command === 'hide') return ['bg', 'bgm', 'char', 'image'];
  if (command === 'goto') {
    const localScenes = [...editor.value.matchAll(/^\s*scene\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/gm)].map(match => match[1]);
    return [...new Set([...localScenes, ...sceneNames])];
  }
  if (command === 'choice' && args.length === 0) return ['""'];
  if (command === 'for') {
    if (args.length === 0) return ['i', 'index'];
    if (args.length === 1) return ['from'];
    if (args.length === 2) return ['0'];
    if (args.length === 3) return ['to'];
    if (args.length === 4) return ['10', ...knownVariables.filter((variable) => variable.type === 'int').map((variable) => variable.name)];
    if (args.length === 5) return ['step'];
  }
  if (command === 'if' && args.length === 0) return knownVariables.map((variable) => variable.name);
  if (command === 'if' && args.length === 1) return ['==', '>=', '<=', '!=', '>', '<'];
  if (command === 'if' && args.length >= 2 && ['>=', '<=', '==', '!=', '>', '<'].includes(args[1])) {
    const values = knownVariables.flatMap((variable) => variable.values || variable.allowedValues || []);
    return [...new Set(values.map(String))];
  }
  if (command === 'set' && args.length === 0) return knownVariables.map((variable) => variable.name);
  if (command === 'asset' && args.length === 0) return ['bg', 'char', 'bgm', 'se', 'voice', 'image', 'video'];
  return [];
}

async function updateSuggestions() {
  if (document.activeElement !== editor) return hideSuggestions();
  const refreshId = ++suggestionRefreshId;
  try {
    const [sceneData, variableData] = await Promise.all([request('/api/scenes'), request('/api/variables')]);
    if (refreshId !== suggestionRefreshId) return;
    sceneNames = sceneData.scenes || [];
    knownVariables = normalizeVariables(variableData.variables || []);
  } catch (error) {
    showError(error);
    return;
  }
  let context = completionContext();
  if (!context) return hideSuggestions();
  // `if` を入力した直後（まだ空白を打っていない状態）も、
  // 変数候補を条件式の先頭として表示する。候補は if の後ろへ挿入する。
  if (/^if\s*$/.test(context.line.trim()) && context.words.length === 0) {
    context = { ...context, start: context.end, prefix: '', words: ['if'], insertLeadingSpace: true };
  }
  const prefix = context.prefix.toLocaleLowerCase();
  const matches = [...new Set(candidatesFor(context))]
    .filter((candidate) => candidate.toLocaleLowerCase().startsWith(prefix) && candidate !== context.prefix);
  // 入力前や複数候補が残っている間は一覧を出さない。
  // 入力によって候補が一意になったときだけ、Enter で確定できるようにする。
  suggestions = prefix && matches.length === 1 ? matches : [];
  suggestionIndex = 0;
  completionRange = context;
  const lineStart = editor.value.lastIndexOf('\n', editor.selectionStart - 1) + 1;
  const line = editor.value.slice(0, editor.selectionStart).split('\n').length - 1;
  const column = editor.selectionStart - lineStart;
  suggestionBox.style.left = `${78 + column * 8.4}px`;
  suggestionBox.style.top = `${21 + line * 23.8 - editor.scrollTop + 25}px`;
  renderSuggestions();
}

function hideVariableTooltip() {
  variableTooltip.hidden = true;
}

function showVariableTooltipLegacy(event) {
  const rect = editor.getBoundingClientRect();
  const style = getComputedStyle(editor);
  const lineHeight = Number.parseFloat(style.lineHeight) || 23.8;
  const paddingLeft = Number.parseFloat(style.paddingLeft) || 25;
  const paddingTop = Number.parseFloat(style.paddingTop) || 21;
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  context.font = style.font;
  const charWidth = context.measureText('M').width || 8.4;
  const lineIndex = Math.floor((event.clientY - rect.top + editor.scrollTop - paddingTop) / lineHeight);
  const column = Math.floor((event.clientX - rect.left + editor.scrollLeft - paddingLeft) / charWidth);
  const line = editor.value.split('\n')[lineIndex];
  if (!line || column < 0) return hideVariableTooltip();
  const match = [...line.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)].find((item) => column >= item.index && column <= item.index + item[0].length);
  if (!match) return hideVariableTooltip();
  const variables = knownVariables.filter((variable) => variable.name === match[0]);
  if (!variables.length) return hideVariableTooltip();

  variableTooltip.replaceChildren();
  variables.forEach((variable, index) => {
    if (index > 0) {
      const separator = document.createElement('div');
      separator.className = 'variable-tooltip-separator';
      variableTooltip.append(separator);
    }
    const title = document.createElement('strong');
    title.className = 'variable-tooltip-title';
    title.textContent = `${variable.name} : ${typeof variable.type === 'string' ? variable.type : `dict[${variable.type.value}]`}`;
    variableTooltip.append(title);
    const locationLine = (label, locations, kind) => {
      const lineElement = document.createElement('div');
      lineElement.className = 'variable-tooltip-row';
      const values = locations.filter((location) => !kind || location.kind === kind).map((location) => {
        const file = location.file || sceneName.value;
        const position = location.line ? `:${location.line}` : '';
        return `${file}${position}`;
      });
      lineElement.textContent = `${label}: ${values.length ? values.join(', ') : 'なし'}`;
      variableTooltip.append(lineElement);
    };
    locationLine('定義', variable.definitions || []);
    locationLine('参照', variable.references || [], 'expression');
    locationLine('埋め込み', variable.references || [], 'interpolation');
    locationLine('代入', variable.references || [], 'assignment');
  });
  const left = Math.min(event.clientX + 14, window.innerWidth - 360);
  const top = Math.min(event.clientY + 14, window.innerHeight - 180);
  variableTooltip.style.left = `${Math.max(8, left)}px`;
  variableTooltip.style.top = `${Math.max(8, top)}px`;
  variableTooltip.hidden = false;
}

function showVariableTooltip(event) {
  const rect = editor.getBoundingClientRect();
  const style = getComputedStyle(editor);
  const lineHeight = Number.parseFloat(style.lineHeight) || 23.8;
  const paddingLeft = Number.parseFloat(style.paddingLeft) || 25;
  const paddingTop = Number.parseFloat(style.paddingTop) || 21;
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  context.font = style.font;
  const charWidth = context.measureText('M').width || 8.4;
  const lineIndex = Math.floor((event.clientY - rect.top + editor.scrollTop - paddingTop) / lineHeight);
  const column = Math.floor((event.clientX - rect.left + editor.scrollLeft - paddingLeft) / charWidth);
  const sourceLine = editor.value.split('\n')[lineIndex];
  if (!sourceLine || column < 0) return hideVariableTooltip();
  const match = [...sourceLine.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)].find((item) => column >= item.index && column < item.index + item[0].length);
  if (!match) return hideVariableTooltip();
  const variable = knownVariables.find((item) => item.name === match[0]);
  if (!variable) return hideVariableTooltip();

  variableTooltip.replaceChildren();
  const title = document.createElement('strong');
  title.className = 'variable-tooltip-title';
  title.textContent = `${variable.name} : ${typeof variable.type === 'string' ? variable.type : `dict[${variable.type.value}]`}`;
  variableTooltip.append(title);
  const jumpToLocation = async (location) => {
    const file = String(location.file || sceneName.value).replace(/^scenes[\\/]/, '');
    await openScene(file);
    const line = Math.max(1, Number(location.line) || 1);
    const column = Math.max(0, Number(location.column) - 1 || 0);
    const lineStart = editor.value.split(/\r?\n/).slice(0, line - 1).reduce((total, value) => total + value.length + 1, 0);
    const caret = Math.min(editor.value.length, lineStart + column);
    editor.focus();
    editor.setSelectionRange(caret, caret);
    editor.scrollTop = Math.max(0, (line - 1) * (Number.parseFloat(getComputedStyle(editor).lineHeight) || 23.8) - 70);
    hideVariableTooltip();
  };
  const addLocations = (label, locations) => {
    const heading = document.createElement('div');
    heading.className = 'variable-tooltip-heading';
    heading.textContent = label;
    variableTooltip.append(heading);
    if (!locations.length) {
      const empty = document.createElement('div');
      empty.className = 'variable-tooltip-empty';
      empty.textContent = 'なし';
      variableTooltip.append(empty);
      return;
    }
    locations.forEach((location) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'variable-tooltip-location';
      button.textContent = `${location.file || sceneName.value}:${location.line || '?'}`;
      button.title = `${location.kind || '参照'} ${location.container || ''}`.trim();
      button.addEventListener('click', () => jumpToLocation(location).catch(showError));
      variableTooltip.append(button);
    });
  };
  const references = variable.references || [];
  addLocations('定義', variable.definitions || []);
  addLocations('代入', references.filter((location) => location.kind === 'assignment'));
  addLocations('参照', references.filter((location) => location.kind !== 'assignment'));
  const left = Math.min(event.clientX + 14, window.innerWidth - 360);
  const top = Math.min(event.clientY + 14, window.innerHeight - 180);
  variableTooltip.style.left = `${Math.max(8, left)}px`;
  variableTooltip.style.top = `${Math.max(8, top)}px`;
  variableTooltip.hidden = false;
}

function showSyntaxTooltip(event) {
  const rect = editor.getBoundingClientRect();
  const style = getComputedStyle(editor);
  const lineHeight = Number.parseFloat(style.lineHeight) || 23.8;
  const paddingLeft = Number.parseFloat(style.paddingLeft) || 25;
  const paddingTop = Number.parseFloat(style.paddingTop) || 21;
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d'); context.font = style.font;
  const charWidth = context.measureText('M').width || 8.4;
  const lineIndex = Math.floor((event.clientY - rect.top + editor.scrollTop - paddingTop) / lineHeight);
  const column = Math.floor((event.clientX - rect.left + editor.scrollLeft - paddingLeft) / charWidth);
  const sourceLine = editor.value.split(/\r?\n/)[lineIndex] || '';
  const match = [...sourceLine.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)].find((item) => column >= item.index && column < item.index + item[0].length);
  const hint = match && syntaxHints[match[0]];
  if (!hint) return false;
  variableTooltip.replaceChildren();
  const title = document.createElement('strong'); title.className = 'variable-tooltip-title'; title.textContent = match[0];
  const body = document.createElement('div'); body.textContent = hint;
  variableTooltip.append(title, body);
  variableTooltip.style.left = `${Math.max(8, Math.min(event.clientX + 14, window.innerWidth - 430))}px`;
  variableTooltip.style.top = `${Math.max(8, Math.min(event.clientY + 14, window.innerHeight - 120))}px`;
  variableTooltip.hidden = false;
  return true;
}

function hideSuggestions() {
  suggestionRefreshId += 1;
  suggestions = [];
  completionRange = null;
  suggestionBox.hidden = true;
  suggestionBox.replaceChildren();
}

function renderSuggestions() {
  suggestionBox.replaceChildren();
  if (!suggestions.length) {
    suggestionBox.hidden = true;
    return;
  }
  suggestions.forEach((candidate, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `suggestion${index === suggestionIndex ? ' active' : ''}`;
    button.textContent = `${index === suggestionIndex ? 'Enter › ' : '        '}${candidate}`;
    button.addEventListener('mousedown', (event) => {
      event.preventDefault();
      suggestionIndex = index;
      acceptSuggestion();
    });
    suggestionBox.append(button);
  });
  suggestionBox.hidden = false;
}

function acceptSuggestion() {
  if (!completionRange || !suggestions.length) return false;
  const candidate = suggestions[suggestionIndex];
  const source = editor.value;
  const following = source.slice(completionRange.end, completionRange.end + 1);
  const speakerCompletion = completionRange.words[0] === 'say' && completionRange.words.length === 1;
  const insertion = speakerCompletion ? `${candidate} ""` : `${completionRange.insertLeadingSpace ? ' ' : ''}${candidate}${following && /\s/.test(following) ? '' : ' '}`;
  rememberUndo();
  editor.value = `${source.slice(0, completionRange.start)}${insertion}${source.slice(completionRange.end)}`;
  const caret = completionRange.start + (speakerCompletion ? candidate.length + 2 : insertion.length);
  editor.focus();
  editor.setSelectionRange(caret, caret);
  editor.dispatchEvent(new Event('input'));
  hideSuggestions();
  return true;
}

async function openScene(name) {
  if (sceneName?.value && sceneName.value !== name && isDirty) await saveScene();
  const scene = await request(`/api/scene?name=${encodeURIComponent(name)}`);
  localStorage.setItem('novel-editor-last-scene', scene.name);
  if (!openTabs.includes(scene.name)) openTabs.push(scene.name);
  sceneName.value = scene.name;
  editor.value = scene.source;
  clearEditorHistory();
  updateDirtyState(false);
  updateLineNumbers();
  updateHighlight();
  result.textContent = '';
  setStatus(`${scene.name} を開きました`, 'ok');
  renderEditorTabs(scene.name);
  scheduleValidation();
}

function renderEditorTabs(activeName = sceneName?.value) {
  if (!editorTabs) return;
  editorTabs.replaceChildren(...openTabs.map((name) => {
    const tab = document.createElement('div');
    tab.className = `editor-tab${name === activeName ? ' active' : ''}`;
    tab.setAttribute('role', 'tab'); tab.setAttribute('aria-selected', String(name === activeName));
    const select = document.createElement('button'); select.type = 'button'; select.className = 'editor-tab-name'; select.textContent = fileLabel(name); select.title = name;
    select.addEventListener('click', (event) => {
      if (event.shiftKey) moveTabToRight(name).catch(showError);
      else if (name !== sceneName.value) openScene(name).catch(showError);
    });
    const split = document.createElement('button'); split.type = 'button'; split.className = 'editor-tab-split'; split.textContent = '->|'; split.title = `${name}を右ペインで開く`;
    split.addEventListener('click', () => moveTabToRight(name).catch(showError));
    const close = document.createElement('button'); close.type = 'button'; close.className = 'editor-tab-close'; close.textContent = '×'; close.title = `${name}を閉じる`;
    close.addEventListener('click', async () => {
      if (isDirty && name === sceneName.value && !window.confirm('未保存の変更があります。タブを閉じますか？')) return;
      const index = openTabs.indexOf(name); if (index >= 0) openTabs.splice(index, 1);
      if (name === sceneName.value) {
        const next = openTabs[index] || openTabs[index - 1];
        if (next) await openScene(next); else { sceneName.value = ''; editor.value = ''; clearEditorHistory(); updateLineNumbers(); updateHighlight(); updateDirtyState(false); }
      }
      renderEditorTabs(sceneName.value);
      renderSplitTabs();
    });
    tab.append(select, split, close); return tab;
  }));
}

function formatTokens(line) {
  const tokens = [];
  for (let index = 0; index < line.length;) {
    const char = line[index];
    if (/\s/.test(char)) { index++; continue; }
    if (char === '#' || (char === '/' && line[index + 1] === '/')) { tokens.push({ kind: 'comment', value: line.slice(index) }); break; }
    if (char === '"') {
      const start = index++;
      while (index < line.length) {
        if (line[index] === '\\') { index += Math.min(2, line.length - index); continue; }
        if (line[index++] === '"') break;
      }
      tokens.push({ kind: 'string', value: line.slice(start, index) });
      continue;
    }
    if (/[A-Za-z_]/.test(char)) { const start = index++; while (index < line.length && /[A-Za-z0-9_]/.test(line[index])) index++; tokens.push({ kind: 'word', value: line.slice(start, index) }); continue; }
    if (/[0-9]/.test(char)) { const start = index++; while (index < line.length && /[0-9]/.test(line[index])) index++; tokens.push({ kind: 'number', value: line.slice(start, index) }); continue; }
    const pair = line.slice(index, index + 2);
    if (['==', '!=', '>=', '<=', '->', '=>', '..'].includes(pair)) { tokens.push({ kind: 'operator', value: pair }); index += 2; continue; }
    if ('=+-*/%<>!'.includes(char)) tokens.push({ kind: 'operator', value: char });
    else if ('{}[]():,.'.includes(char)) tokens.push({ kind: 'punctuation', value: char });
    else tokens.push({ kind: 'plain', value: char });
    index++;
  }
  const unary = tokens.map((token, index) => token.kind === 'operator' && ['+', '-', '!'].includes(token.value)
    && (index === 0 || tokens[index - 1].kind === 'operator' || ['(', '[', '{', ',', ':'].includes(tokens[index - 1].value)
      || (tokens[index - 1].kind === 'word' && ['from', 'to', 'step', 'return'].includes(tokens[index - 1].value))));
  let result = '';
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index], previous = tokens[index - 1];
    if (token.kind === 'comment') { result += `${result ? '  ' : ''}${token.value}`; continue; }
    let spaced = index > 0;
    if (['[', ')', ']', ',', ':', '.'].includes(token.value) || ['(', '[', '.'].includes(previous?.value)) spaced = false;
    if (token.value === '(' && previous?.kind === 'word' && !['if', 'elif', 'while'].includes(previous.value)) spaced = false;
    if (token.kind === 'operator') spaced = unary[index] ? !(previous?.kind === 'operator' || ['(', '[', '{', ',', ':'].includes(previous?.value)) : true;
    if (previous?.kind === 'operator') spaced = !unary[index - 1];
    if (token.value === '}') spaced = previous?.value !== '{';
    if (previous?.value === '{') spaced = token.value !== '}';
    if (token.value === '{') spaced = index > 0 && !['(', '[', '{'].includes(previous?.value);
    if (previous?.value === ',' || previous?.value === ':') spaced = true;
    result += `${spaced && result && !result.endsWith(' ') ? ' ' : ''}${token.value}`;
  }
  return { text: result.trimEnd(), tokens: tokens.filter((token) => token.kind !== 'comment') };
}

function formatCode() {
  const source = editor.value;
  const lines = source.replace(/\r\n?/g, '\n').split('\n').flatMap((raw) => {
    const closingOnly = /^\s*((?:}\s*){2,})(#.*)?$/.exec(raw);
    if (!closingOnly) return [raw];
    const count = (closingOnly[1].match(/}/g) || []).length;
    return Array.from({ length: count }, (_, index) => `}${index === count - 1 && closingOnly[2] ? `  ${closingOnly[2]}` : ''}`);
  });
  let indent = 0;
  const formattedLines = lines.map((raw) => {
    if (!raw.trim()) return '';
    const formatted = formatTokens(raw.trim());
    const leadingClosers = formatted.tokens.findIndex((token) => token.value !== '}');
    const closeIndent = leadingClosers < 0 ? formatted.tokens.length : leadingClosers;
    const lineIndent = Math.max(0, indent - closeIndent);
    const opens = formatted.tokens.filter((token) => token.value === '{').length;
    const closes = formatted.tokens.filter((token) => token.value === '}').length;
    indent = Math.max(0, indent + opens - closes);
    return `${'  '.repeat(lineIndent)}${formatted.text}`;
  });
  const joinedLines = [];
  for (const line of formattedLines) {
    if (/^\s*(?:else|elif)\b/.test(line) && joinedLines.at(-1)?.trim() === '}') {
      joinedLines[joinedLines.length - 1] += ` ${line.trimStart()}`;
    } else joinedLines.push(line);
  }
  const formatted = joinedLines.join('\n');
  if (formatted === source) return;
  rememberUndo();
  editor.value = formatted;
  updateLineNumbers();
  editor.dispatchEvent(new Event('input'));
  editor.focus();
}

async function saveScene() {
  const saved = await request('/api/scene', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: sceneName.value, source: editor.value }),
  });
  sceneName.value = saved.name;
  updateDirtyState(false);
  await refreshScenes(saved.name);
  await refreshSceneGraph();
  const variableData = await request('/api/variables');
  knownVariables = normalizeVariables(variableData.variables || []);
  setStatus(`${saved.name} を保存しました`, 'ok');
}

async function saveAllScenes() {
  const savedNames = [];
  if (sceneName.value && isDirty) {
    const name = sceneName.value;
    await saveScene();
    savedNames.push(name);
  }
  const splitApi = !splitGroup?.hidden ? splitFrame?.contentWindow?.novelEditorApi : null;
  if (splitApi?.isDirty?.()) {
    const name = splitApi.scene?.() || activeSplitScene;
    await splitApi.save();
    if (name && !savedNames.includes(name)) savedNames.push(name);
  }
  setStatus(savedNames.length ? `${savedNames.length} ファイルを保存しました` : 'すべて保存済みです', 'ok');
  return savedNames;
}

window.novelEditorApi = {
  save: () => saveScene(),
  isDirty: () => isDirty,
  focus: () => editor.focus(),
  scene: () => sceneName.value,
};

async function validate() {
  const sequence = ++validationSequence;
  setStatus('構文を検証中…');
  const report = await request('/api/validate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: sceneName.value, source: editor.value }),
  });
  if (sequence !== validationSequence) return;
  diagnostics = Array.isArray(report.diagnostics) ? report.diagnostics : [];
  if (!diagnostics.length && !report.ok) {
    const message = String(report.error || '構文エラー');
    const assetPath = message.match(/(?:asset|アセット)\s*'([^']+)'/)?.[1];
    const assetLine = assetPath ? editor.value.split(/\r?\n/).findIndex((value) => value.includes(assetPath)) + 1 : 0;
    const line = Number(message.match(/line\s+(\d+)/i)?.[1] || assetLine || 1);
    const column = Number(message.match(/column\s+(\d+)/i)?.[1] || 1);
    diagnostics = [{ severity: 'error', code: 'error', line, column, message }];
  }
  diagnosticText = diagnostics.map((item) => `${item.severity.toUpperCase()} ${item.code}  line ${item.line}:${item.column}  ${item.message}`).join('\n');
  updateHighlight();
  if (report.ok) {
    const warningCount = diagnostics.filter((item) => item.severity === 'warning').length;
    const infoCount = diagnostics.filter((item) => item.severity === 'info').length;
    result.textContent = warningCount || infoCount
      ? `解析完了: エラー 0 / 警告 ${warningCount} / 情報 ${infoCount}\n${diagnosticText}`
      : `問題ありません。\n文: ${report.statements}\nコンパイル命令: ${report.instructions}`;
    setStatus(warningCount ? `警告が ${warningCount} 件あります` : '検証に成功しました', warningCount ? 'warning' : 'ok');
  } else {
    result.textContent = `解析エラー ${diagnostics.filter((item) => item.severity === 'error').length} 件\n${diagnosticText}`;
    setStatus('修正が必要な問題があります', 'error');
  }
}

document.querySelectorAll('[data-predict]').forEach((button) => {
  button.addEventListener('click', () => {
    insert(button.dataset.predict);
    updateSuggestions();
  });
});
const insertSection = document.querySelector('.insert-section');
const insertToggle = document.querySelector('#insert-toggle');
const insertToggleLabel = insertToggle?.querySelector('.insert-toggle-label');
insertToggle?.addEventListener('click', () => {
  const collapsed = insertSection.classList.toggle('is-collapsed');
  if (insertToggleLabel) insertToggleLabel.textContent = collapsed ? '展開' : '閉じる';
  insertToggle.setAttribute('aria-expanded', String(!collapsed));
  insertToggle.title = collapsed ? 'コマンドをすべて表示' : '追加コマンドを隠す';
});
function scheduleValidation() {
  clearTimeout(validationTimer);
  validationTimer = setTimeout(() => validate().catch(showError), 1000);
}

const saveAllButton = document.querySelector('#save');
saveAllButton.addEventListener('click', () => {
  saveAllButton.disabled = true;
  saveAllButton.textContent = '保存中';
  saveAllScenes().catch(showError).finally(() => {
    saveAllButton.disabled = false;
    saveAllButton.textContent = 'すべて保存';
  });
});
document.querySelector('#validate').addEventListener('click', () => validate().catch(showError));
const splitGroup = document.querySelector('#split-group');
const splitFrame = document.querySelector('#split-frame');
const splitTabsElement = document.querySelector('#split-tabs');
const splitResizer = document.querySelector('#split-resizer');
const editorPanel = document.querySelector('.editor-panel');
let activeSplitScene = '';
function gotoAtEvent(event) {
  const rect = editor.getBoundingClientRect();
  const style = getComputedStyle(editor);
  const lineHeight = Number.parseFloat(style.lineHeight) || 23.8;
  const paddingTop = Number.parseFloat(style.paddingTop) || 21;
  const lineIndex = Math.floor((event.clientY - rect.top + editor.scrollTop - paddingTop) / lineHeight);
  const sourceLine = editor.value.split(/\r?\n/)[lineIndex] || '';
  const match = /^\s*goto\s+(?:"([^"]+)"|([A-Za-z0-9_./-]+))/.exec(sourceLine);
  return match ? (match[1] || match[2]) : '';
}
function showGotoMenu(event) {
  const target = gotoAtEvent(event);
  if (!target) return false;
  variableTooltip.replaceChildren();
  const title = document.createElement('strong'); title.className = 'variable-tooltip-title'; title.textContent = `goto: ${fileLabel(target)}`; variableTooltip.append(title);
  const button = document.createElement('button'); button.type = 'button'; button.className = 'variable-tooltip-location'; button.textContent = '移動先を開く';
  button.addEventListener('click', () => openScene(target).then(hideVariableTooltip).catch(showError));
  variableTooltip.append(button);
  variableTooltip.style.left = `${Math.max(8, Math.min(event.clientX + 14, window.innerWidth - 360))}px`;
  variableTooltip.style.top = `${Math.max(8, Math.min(event.clientY + 14, window.innerHeight - 110))}px`;
  variableTooltip.hidden = false;
  return true;
}
function clearLeftEditor() {
  sceneName.value = '';
  editor.value = '';
  clearEditorHistory();
  updateLineNumbers();
  updateHighlight();
  updateDirtyState(false);
}
function renderSplitTabs() {
  if (!splitTabsElement) return;
  splitTabsElement.replaceChildren(...splitTabs.map((name) => {
    const tab = document.createElement('div');
    tab.className = `editor-tab${name === activeSplitScene ? ' active' : ''}`;
    tab.setAttribute('role', 'tab'); tab.setAttribute('aria-selected', String(name === activeSplitScene));
    const select = document.createElement('button'); select.type = 'button'; select.className = 'editor-tab-name'; select.textContent = fileLabel(name); select.title = name;
    select.addEventListener('click', () => openSplitScene(name));
    const move = document.createElement('button'); move.type = 'button'; move.className = 'editor-tab-unsplit'; move.textContent = '|<-'; move.title = `${name}を左ペインへ移動`;
    move.addEventListener('click', () => moveTabToLeft(name).catch(showError));
    const close = document.createElement('button'); close.type = 'button'; close.className = 'editor-tab-close'; close.textContent = '×'; close.title = `${name}を閉じる`;
    close.addEventListener('click', () => closeRightTab(name));
    tab.append(select, move, close);
    return tab;
  }));
}
function canActivateSplit(name) {
  const api = splitFrame?.contentWindow?.novelEditorApi;
  return !(activeSplitScene && activeSplitScene !== name && api?.isDirty?.() && !window.confirm('右ペインに未保存の変更があります。別のファイルを開きますか？'));
}
function openSplitScene(name, skipDirtyCheck = false) {
  if (!splitFrame || !name) return;
  if (!skipDirtyCheck && !canActivateSplit(name)) return false;
  if (!splitTabs.includes(name)) splitTabs.push(name);
  activeSplitScene = name;
  renderSplitTabs();
  splitFrame.src = `/?embedded=1&scene=${encodeURIComponent(name)}`;
  splitGroup.hidden = false;
  editorPanel?.classList.add('is-split');
  localStorage.setItem('novel-editor-split-scene', name);
  return true;
}
function closeSplit(skipDirtyCheck = false) {
  const api = splitFrame?.contentWindow?.novelEditorApi;
  if (!skipDirtyCheck && api?.isDirty?.() && !window.confirm('右ペインに未保存の変更があります。分割を閉じますか？')) return false;
  splitGroup.hidden = true;
  splitFrame.src = 'about:blank';
  activeSplitScene = '';
  renderSplitTabs();
  editorPanel?.classList.remove('is-split');
  return true;
}
async function moveTabToRight(name) {
  if (!name || !canActivateSplit(name)) return false;
  if (name === sceneName.value && isDirty) await saveScene();
  const index = openTabs.indexOf(name);
  if (!splitTabs.includes(name)) splitTabs.push(name);
  openSplitScene(name, true);
  if (index >= 0) openTabs.splice(index, 1);
  if (name === sceneName.value) {
    const next = openTabs[index] || openTabs[index - 1];
    if (next) await openScene(next); else clearLeftEditor();
  }
  renderEditorTabs(sceneName.value);
  renderSplitTabs();
  return true;
}
async function moveTabToLeft(name) {
  if (!name) return false;
  const index = splitTabs.indexOf(name);
  if (index < 0) return false;
  if (name === activeSplitScene) {
    const api = splitFrame?.contentWindow?.novelEditorApi;
    if (api?.isDirty?.()) await api.save();
  }
  if (!openTabs.includes(name)) openTabs.push(name);
  await openScene(name);
  splitTabs.splice(index, 1);
  if (name === activeSplitScene) {
    const next = splitTabs[index] || splitTabs[index - 1];
    if (next) openSplitScene(next, true); else closeSplit(true);
  }
  renderEditorTabs(name);
  renderSplitTabs();
  return true;
}
function closeRightTab(name) {
  const index = splitTabs.indexOf(name);
  if (index < 0) return false;
  if (name === activeSplitScene) {
    const api = splitFrame?.contentWindow?.novelEditorApi;
    if (api?.isDirty?.() && !window.confirm('右ペインに未保存の変更があります。タブを閉じますか？')) return false;
  }
  splitTabs.splice(index, 1);
  if (name === activeSplitScene) {
    const next = splitTabs[index] || splitTabs[index - 1];
    if (next) openSplitScene(next, true); else closeSplit(true);
  }
  renderSplitTabs();
  return true;
}
async function forgetDeletedScene(name) {
  const leftIndex = openTabs.indexOf(name);
  if (leftIndex >= 0) openTabs.splice(leftIndex, 1);
  if (sceneName.value === name) {
    const next = openTabs[leftIndex] || openTabs[leftIndex - 1];
    clearLeftEditor();
    if (next) await openScene(next);
  }
  const rightIndex = splitTabs.indexOf(name);
  if (rightIndex >= 0) splitTabs.splice(rightIndex, 1);
  if (activeSplitScene === name) {
    const next = splitTabs[rightIndex] || splitTabs[rightIndex - 1];
    if (next) openSplitScene(next, true); else closeSplit(true);
  }
  renderEditorTabs(sceneName.value);
  renderSplitTabs();
}
document.querySelector('#close-split')?.addEventListener('click', () => closeSplit());
function setSplitWidth(percent) {
  const width = Math.max(25, Math.min(75, Math.round(percent)));
  editorPanel?.style.setProperty('--split-left', `${width}%`);
  splitResizer?.setAttribute('aria-valuenow', String(width));
  localStorage.setItem('novel-editor-split-width', String(width));
}
const savedSplitWidth = Number(localStorage.getItem('novel-editor-split-width'));
if (Number.isFinite(savedSplitWidth) && savedSplitWidth >= 25 && savedSplitWidth <= 75) setSplitWidth(savedSplitWidth);
splitResizer?.addEventListener('pointerdown', (event) => {
  event.preventDefault();
  splitResizer.classList.add('dragging');
  splitResizer.setPointerCapture(event.pointerId);
});
splitResizer?.addEventListener('pointermove', (event) => {
  if (!splitResizer.hasPointerCapture(event.pointerId)) return;
  const bounds = editorPanel.getBoundingClientRect();
  setSplitWidth(((event.clientX - bounds.left) / bounds.width) * 100);
});
splitResizer?.addEventListener('pointerup', (event) => {
  if (splitResizer.hasPointerCapture(event.pointerId)) splitResizer.releasePointerCapture(event.pointerId);
  splitResizer.classList.remove('dragging');
});
splitResizer?.addEventListener('keydown', (event) => {
  if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  event.preventDefault();
  const current = Number(splitResizer.getAttribute('aria-valuenow') || 50);
  setSplitWidth(current + (event.key === 'ArrowLeft' ? -5 : 5));
});
const nativeBuildButton = document.createElement('button');
nativeBuildButton.id = 'native-build';
nativeBuildButton.className = 'native-build-button';
nativeBuildButton.textContent = 'NATIVE BUILD';
nativeBuildButton.title = 'nativeプレイヤー用パッケージを書き出す';
document.querySelector('.document-actions')?.append(nativeBuildButton);
nativeBuildButton.addEventListener('click', () => (async () => {
  nativeBuildButton.disabled = true;
  setStatus('nativeパッケージを生成中…');
  await saveScene();
  const built = await request('/api/native-build', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: sceneName.value }),
  });
  setStatus(`${built.name} を build/native-packages に保存しました`, 'ok');
})().catch(showError).finally(() => { nativeBuildButton.disabled = false; }));
document.querySelector('#play').addEventListener('click', () => (async () => {
  await saveScene();
  window.location.href = `/player.html?source=${encodeURIComponent(sceneName.value)}`;
})().catch(showError));
document.querySelector('#reload-catalog').addEventListener('click', () => refreshCatalog().catch(showError));
function createNewSceneDraft() {
  sceneName.value = 'chapter-new.novel';
  editor.value = '# 新しいシーン\n\n';
  clearEditorHistory();
  updateLineNumbers();
  editor.focus();
  setStatus('新規シーンを作成しました');
}
document.querySelector('#new-scene')?.addEventListener('click', createNewSceneDraft);
editor.addEventListener('input', () => {
  updateLineNumbers();
  updateHighlight();
  updateSuggestions();
  scheduleValidation();
  updateDirtyState(true);
  setStatus('未保存の変更があります');
});
editor.addEventListener('beforeinput', (event) => {
  if (!event.inputType?.startsWith('history')) rememberUndo();
});
editor.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  if (!showGotoMenu(event) && !showSyntaxTooltip(event)) showVariableTooltip(event);
});
document.addEventListener('click', (event) => {
  if (!variableTooltip.contains(event.target)) hideVariableTooltip();
});
document.addEventListener('keydown', (event) => {
  const formatKey = event.code === 'KeyF' || event.key?.toLowerCase() === 'f';
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey && formatKey) {
    event.preventDefault();
    event.stopPropagation();
    formatCode();
    return;
  }
  if (event.key === 'Escape') hideVariableTooltip();
}, true);
editor.addEventListener('scroll', () => { lineNumbers.scrollTop = editor.scrollTop; if (highlight) { highlight.scrollTop = editor.scrollTop; highlight.scrollLeft = editor.scrollLeft; } updateMiniMap(); updateSuggestions(); });
const beginMiddleScroll = (event) => {
  if (event.button !== 1) return;
  event.preventDefault();
  middleScroll = { y: event.clientY, x: event.clientX, top: editor.scrollTop, left: editor.scrollLeft };
  document.body.style.cursor = 'all-scroll';
};
editor.addEventListener('pointerdown', beginMiddleScroll);
minimap?.addEventListener('pointerdown', beginMiddleScroll);
const beginMiddleMouse = (event) => {
  if (event.button !== 1) return;
  event.preventDefault();
  middleScroll = { y: event.clientY, x: event.clientX, top: editor.scrollTop, left: editor.scrollLeft };
  document.body.style.cursor = 'all-scroll';
};
editor.addEventListener('mousedown', beginMiddleMouse);
minimap?.addEventListener('mousedown', beginMiddleMouse);
document.addEventListener('pointermove', (event) => {
  if (!middleScroll) return;
  editor.scrollTop = middleScroll.top - (event.clientY - middleScroll.y);
  editor.scrollLeft = middleScroll.left - (event.clientX - middleScroll.x);
});
document.addEventListener('pointerup', (event) => {
  if (event.button !== 1 || !middleScroll) return;
  middleScroll = null;
  document.body.style.cursor = '';
});
document.addEventListener('mousemove', (event) => {
  if (!middleScroll) return;
  editor.scrollTop = middleScroll.top - (event.clientY - middleScroll.y);
  editor.scrollLeft = middleScroll.left - (event.clientX - middleScroll.x);
});
document.addEventListener('mouseup', (event) => {
  if (event.button !== 1 || !middleScroll) return;
  middleScroll = null;
  document.body.style.cursor = '';
});
minimap?.addEventListener('pointerdown', (event) => {
  if (event.button === 1) return;
  event.preventDefault();
  if (event.target === minimapViewport) {
    minimapDrag = { y: event.clientY, top: editor.scrollTop };
    minimap.setPointerCapture?.(event.pointerId);
    return;
  }
  const rect = minimap.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
  editor.scrollTop = ratio * Math.max(0, editor.scrollHeight - editor.clientHeight);
  editor.focus({ preventScroll: true });
});
minimap?.addEventListener('pointermove', (event) => {
  if (!minimapDrag) return;
  const max = Math.max(0, editor.scrollHeight - editor.clientHeight);
  const track = Math.max(1, minimap.clientHeight - minimapViewport.offsetHeight);
  editor.scrollTop = minimapDrag.top + (event.clientY - minimapDrag.y) * (max / track);
});
minimap?.addEventListener('pointerup', () => { minimapDrag = null; });
minimap?.addEventListener('wheel', (event) => {
  event.preventDefault();
  editor.scrollTop += event.deltaY;
  editor.scrollLeft += event.deltaX;
}, { passive: false });
editor.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    restoreEditorHistory(event.shiftKey ? redoStack : undoStack, event.shiftKey ? undoStack : redoStack);
    return;
  }
  if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'y') {
    event.preventDefault();
    restoreEditorHistory(redoStack, undoStack);
    return;
  }
  if (event.key === 'Backspace' && editor.selectionStart === editor.selectionEnd) {
    const lineStart = editor.value.lastIndexOf('\n', editor.selectionStart - 1) + 1;
    const beforeCaret = editor.value.slice(lineStart, editor.selectionStart);
    if (/^\s+$/.test(beforeCaret) && beforeCaret.length >= 2 && beforeCaret.endsWith('  ')) {
      event.preventDefault();
      const caret = editor.selectionStart;
      rememberUndo();
      editor.value = `${editor.value.slice(0, caret - 2)}${editor.value.slice(caret)}`;
      editor.setSelectionRange(caret - 2, caret - 2);
      editor.dispatchEvent(new Event('input'));
      return;
    }
  }
  const templateNumber = event.code?.match(/^Digit([1-8])$/)?.[1];
  if (event.ctrlKey && event.shiftKey && !event.altKey && templateNumber) {
    event.preventDefault();
    document.querySelector(`[data-shortcut="${templateNumber}"]`)?.click();
    return;
  }
  if (event.key === 'Enter' && suggestions.length) {
    event.preventDefault();
    event.stopImmediatePropagation();
    acceptSuggestion();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key === 'Enter') {
    event.preventDefault();
    document.querySelector('#play').click();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    event.preventDefault();
    document.querySelector('#validate').click();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') {
    event.preventDefault();
    createNewSceneDraft();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'l') {
    event.preventDefault();
    sceneName.focus();
    sceneName.select();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.altKey && event.key.toLowerCase() === 'r') {
    event.preventDefault();
    document.querySelector('#reload-catalog').click();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault();
    saveAllScenes().catch(showError);
  }
  if (event.key === 'Enter') {
    const lineStart = editor.value.lastIndexOf('\n', editor.selectionStart - 1) + 1;
    const line = editor.value.slice(lineStart, editor.selectionStart);
    const lineEnd = editor.value.indexOf('\n', lineStart) < 0 ? editor.value.length : editor.value.indexOf('\n', lineStart);
    const fullLine = editor.value.slice(lineStart, lineEnd);
    const trimmedLine = fullLine.trim();
    const indent = fullLine.match(/^\s*/)?.[0] || '';
    if (/^"(?:\\.|[^"\\])*"\s*\{$/.test(trimmedLine)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const caret = lineStart + fullLine.length;
      const hasFollowingLine = editor.value[caret] === '\n';
      const insertionPoint = caret;
      const insertion = hasFollowingLine ? `\n${indent}  ` : `\n${indent}  \n${indent}`;
      rememberUndo();
      editor.value = `${editor.value.slice(0, insertionPoint)}${insertion}${editor.value.slice(insertionPoint)}`;
      editor.setSelectionRange(insertionPoint + insertion.length, insertionPoint + insertion.length);
      editor.dispatchEvent(new Event('input'));
      return;
    }
    if (trimmedLine === '}' && isChoiceOptionClose(editor.value, lineStart)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const caret = lineStart + fullLine.length;
      const insertionPoint = caret < editor.value.length && editor.value[caret] === '\n' ? caret + 1 : caret;
      const insertion = `${indent}"" {\n${indent}}\n`;
      rememberUndo();
      editor.value = `${editor.value.slice(0, insertionPoint)}${insertion}${editor.value.slice(insertionPoint)}`;
      const labelStart = insertionPoint + insertion.indexOf('""') + 1;
      editor.setSelectionRange(labelStart, labelStart);
      editor.dispatchEvent(new Event('input'));
      return;
    }
    const ifLine = fullLine.match(/^(\s*if(?:\s+|(?=\())[^{}]+?)\s*$/);
    if (ifLine && !trimmedLine.endsWith('{')) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const caret = lineStart + fullLine.length;
      const point = caret < editor.value.length && editor.value[caret] === '\n' ? caret + 1 : caret;
      const indent = fullLine.match(/^\s*/)?.[0] || '';
      const insertion = ` {\n${indent}  \n${indent}}\n`;
      rememberUndo();
      editor.value = `${editor.value.slice(0, point)}${insertion}${editor.value.slice(point)}`;
      const position = point + insertion.indexOf('\n') + 1 + indent.length + 2;
      editor.setSelectionRange(position, position);
      editor.dispatchEvent(new Event('input'));
      return;
    }
    const choiceLine = fullLine.match(/^(\s*choice\s+"(?:\\.|[^"\\])*"\s*)$/);
    if (choiceLine) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const caret = lineStart + fullLine.length;
      const block = ` {\n${indent}  "" {\n${indent}  }\n${indent}}\n`;
      rememberUndo();
      editor.value = `${editor.value.slice(0, caret)}${block}${editor.value.slice(caret)}`;
      editor.setSelectionRange(caret + block.indexOf('""') + 1, caret + block.indexOf('""') + 1);
      editor.dispatchEvent(new Event('input'));
      return;
    }
    // 通常の改行も、現在行のインデントを引き継ぐ。ブロック内は2スペースだけ増やす。
    event.preventDefault();
    event.stopImmediatePropagation();
    const currentIndent = fullLine.match(/^\s*/)?.[0] || '';
    const nextIndent = trimmedLine.startsWith('}')
      ? currentIndent.slice(0, Math.max(0, currentIndent.length - 2))
      : `${currentIndent}${trimmedLine.endsWith('{') ? '  ' : ''}`;
    const newline = `\n${nextIndent}`;
    const caret = editor.selectionStart;
    rememberUndo();
    editor.value = `${editor.value.slice(0, caret)}${newline}${editor.value.slice(caret)}`;
    editor.setSelectionRange(caret + newline.length, caret + newline.length);
    editor.dispatchEvent(new Event('input'));
    return;
  }
  if (event.key === 'Enter' && suggestions.length) {
    event.preventDefault();
    acceptSuggestion();
    return;
  }
  if (event.key === 'Tab') {
    event.preventDefault();
    insert('  ', false);
    return;
  }
  if (event.key === 'Escape') {
    hideSuggestions();
  }
});
editor.addEventListener('click', updateSuggestions);

function uiConfirm(message) { return new Promise((resolve) => { const box = document.createElement('div'); box.className = 'editor-dialog'; box.textContent = message; const yes = document.createElement('button'); yes.textContent = '削除'; const no = document.createElement('button'); no.textContent = 'キャンセル'; box.append(yes, no); document.body.append(box); yes.onclick = () => { box.remove(); resolve(true); }; no.onclick = () => { box.remove(); resolve(false); }; }); }
function showError(error) {
  displayRuntimeError(error);
  result.textContent = `エラー\n${error.message || error}`;
  setStatus('処理に失敗しました', 'error');
}

function displayRuntimeError(error) { const message = error?.message || String(error); let banner = document.querySelector('#runtime-error'); if (!banner) { banner = document.createElement('pre'); banner.id = 'runtime-error'; document.body.append(banner); } banner.textContent = `処理に失敗しました\n${message}`; }
function uiPrompt(message, initial = '') { return new Promise((resolve) => { const box = document.createElement('div'); box.className = 'editor-dialog'; const label = document.createElement('div'); label.textContent = message; const input = document.createElement('input'); input.value = initial; const ok = document.createElement('button'); ok.textContent = '決定'; const cancel = document.createElement('button'); cancel.textContent = 'キャンセル'; box.append(label, input, ok, cancel); document.body.append(box); input.focus(); ok.onclick = () => { box.remove(); resolve(input.value); }; cancel.onclick = () => { box.remove(); resolve(''); }; input.addEventListener('keydown', (event) => { if (event.key === 'Enter') ok.click(); if (event.key === 'Escape') cancel.click(); }); }); }
window.addEventListener('error', (event) => displayRuntimeError(event.error || event.message));
window.addEventListener('unhandledrejection', (event) => displayRuntimeError(event.reason));
Promise.all([refreshScenes(), refreshCatalog(), refreshSceneGraph()])
  .then(() => setStatus('編集を開始できます', 'ok'))
  .catch(showError);
updateLineNumbers();
updateHighlight();
const selectedScene = new URLSearchParams(location.search).get('scene');
setTimeout(() => {
  const remembered = localStorage.getItem('novel-editor-last-scene');
  const candidate = selectedScene || remembered;
  if (candidate && sceneNames.includes(candidate)) openScene(candidate).catch(showError);
  else if (sceneNames.length) openScene(sceneNames[0]).catch(showError);
}, 800);
function updateMiniMap() {
  if (!minimap || !minimapContent || !minimapViewport) return;
  const lines = editor.value.split('\n');
  minimapContent.innerHTML = lines.map((line) => highlightSource(line) || ' ').join('\n');
  const miniLineHeight = minimap.clientHeight / Math.max(1, lines.length);
  minimapContent.style.top = '0px';
  minimapContent.style.lineHeight = `${Math.max(2, miniLineHeight)}px`;
  minimapContent.style.fontSize = `${Math.max(2, Math.min(4, miniLineHeight * 0.72))}px`;
  minimapContent.style.minHeight = `${minimap.clientHeight}px`;
  const max = Math.max(1, editor.scrollHeight - editor.clientHeight);
  const ratio = editor.clientHeight / Math.max(editor.scrollHeight, editor.clientHeight);
  const height = Math.max(24, minimap.clientHeight * ratio);
  minimapViewport.style.height = `${height}px`;
  minimapViewport.style.top = `${(editor.scrollTop / max) * Math.max(0, minimap.clientHeight - height)}px`;
}
function updateHighlight() { if (!highlight) return; const byLine = new Map(); for (const item of diagnostics) { const line = Number(item.line) || 1; const previous = byLine.get(line); if (!previous || ({error:3,warning:2,info:1}[item.severity] || 0) > ({error:3,warning:2,info:1}[previous.severity] || 0)) byLine.set(line, item); } highlight.innerHTML = editor.value.split('\n').map((line, index) => { const item = byLine.get(index + 1); const kind = item ? ` hl-${item.severity}` : ''; return `<span class="hl-line${kind}">${highlightSource(line) || ' '}</span>`; }).join('\n'); updateMiniMap(); }
const dirtyStyle=document.createElement('style');dirtyStyle.textContent='.dirty-mark{display:none!important;background:transparent!important;width:auto!important;height:auto!important}.dirty-mark.visible{display:inline-block!important}.dirty-mark.visible:after{content:"•";color:#fff;font-size:13px;margin-left:4px}.document-title input{width:120px}.scene-file.file-dirty:after{position:static;margin-left:5px;color:#fff;font-size:13px}';document.head.append(dirtyStyle);
const thinDiagnosticStyle=document.createElement('style');thinDiagnosticStyle.textContent='.hl-error,.hl-warning,.hl-info{text-decoration-line:underline;text-decoration-style:wavy;text-decoration-thickness:1px!important;background:transparent!important}.hl-error{text-decoration-color:#e85b68!important}.hl-warning{text-decoration-color:#e3b35c!important}.hl-info{text-decoration-color:#6aa9d8!important}.status-chip.warning .status-dot{background:#e3b35c}';document.head.append(thinDiagnosticStyle);
highlight?.addEventListener('mouseover', (event) => { const line = event.target.closest('.hl-error,.hl-warning,.hl-info'); if (line) { const lineNumber = [...highlight.children].indexOf(line) + 1; line.title = diagnostics.filter((item) => Number(item.line) === lineNumber).map((item) => `${item.severity}: ${item.message}`).join('\n'); } });
const syntaxHints = {
  asset: 'asset <種類> <名前> = "パス"',
  character: 'character <名前> { pose = "画像パス" }',
  struct: 'struct <名前> { field: int | str }',
  int: 'int <名前> = <整数>',
  str: 'str <名前> = "文字列"',
  dict: 'dict[int|str] <名前> = { "key": <値> }',
  const: 'const int|str|dict <名前> = <値>',
  set: 'set <既存の変数> = <値>',
  say: 'say [話者] "本文"  または  say [話者] { "本文1" "本文2" }',
  bg: 'bg <背景アセット>', bgm: 'bgm <BGMアセット>', se: 'play se <SEアセット>',
  char: 'char <名前> <位置> <ポーズ>', show: 'show char|image ...', hide: 'hide char <名前>',
  if: 'if <条件> { ... } else { ... }', elif: 'elif <条件> { ... }', else: 'else { ... }',
  for: 'for <変数> from <開始> to <終了> [step <幅>] { ... }',
  while: 'while <条件> { ... }', choice: 'choice "質問" { "選択肢" { ... } }',
  fn: 'fn <名前>(<引数>: <型>) -> <戻り値> { ... }', return: 'return [値]', goto: 'goto <シーン>',
  wait: 'wait <ミリ秒>', effect: 'effect fade <色> [ミリ秒]', play: 'play <種類> <アセット>'
};
editor.addEventListener('mousemove', (event) => {
  const line = Math.floor((event.offsetY - 21) / 23.8) + 1;
  const errorText = diagnostics.filter((item) => Number(item.line) === line).map((item) => `${item.severity}: ${item.message}`).join('\n');
  if (errorText) { editor.title = errorText; return; }
  editor.title = '';
});
window.addEventListener('pagehide', () => { if (!isDirty || !sceneName.value) return; fetch('/api/scene', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: sceneName.value, source: editor.value }), keepalive: true }).catch(() => {}); });
const fileDirtyStyle=document.createElement('style');fileDirtyStyle.textContent='.scene-file{position:relative;padding-right:22px}.scene-file.file-dirty:after{content:"•";position:absolute;top:50%;right:8px;transform:translateY(calc(-50% + 1px));color:#fff;font-size:16px;line-height:1}';document.head.append(fileDirtyStyle);
const highlightSpacingStyle=document.createElement('style');highlightSpacingStyle.textContent='#highlight{font-size:0}.hl-line{font-size:14px}';document.head.append(highlightSpacingStyle);
const explorerOnlyDirtyStyle=document.createElement('style');explorerOnlyDirtyStyle.textContent='.document-title .dirty-mark{display:none!important}';document.head.append(explorerOnlyDirtyStyle);
function isChoiceOptionClose(source, lineStart) { const before = source.slice(0, lineStart); const choiceStart = before.lastIndexOf('choice '); if (choiceStart < 0) return false; const part = before.slice(choiceStart); const depth = (part.match(/\{/g) || []).length - (part.match(/\}/g) || []).length; return depth === 2; }
const indentGuideStyle=document.createElement('style');indentGuideStyle.textContent='#highlight{background-image:repeating-linear-gradient(to right,transparent 0,transparent 27px,rgba(150,170,190,.24) 27px,rgba(150,170,190,.24) 28px);background-position:25px 0;background-size:28px 100%;background-repeat:repeat-y}';document.head.append(indentGuideStyle);
const stableGuideStyle=document.createElement('style');stableGuideStyle.textContent='#highlight{background-image:none!important}#line-numbers{position:relative;border-right:1px solid #34404d!important;box-shadow:inset -1px 0 #0a0d12;background-image:repeating-linear-gradient(to right,transparent 0,transparent 24px,rgba(150,170,190,.2) 24px,rgba(150,170,190,.2) 25px);background-size:28px 100%;background-repeat:repeat-y}';document.head.append(stableGuideStyle);
const noIndentGuideStyle=document.createElement('style');noIndentGuideStyle.textContent='#highlight,#line-numbers{background-image:none!important;box-shadow:none!important}';document.head.append(noIndentGuideStyle);
const calmSuggestionStyle=document.createElement('style');calmSuggestionStyle.textContent='.suggestion.active{color:#e3edf4!important;background:#314452!important}.suggestion{color:#aebdca!important}.suggestion:hover{background:#263844!important;color:#eef5f8!important}';document.head.append(calmSuggestionStyle);
