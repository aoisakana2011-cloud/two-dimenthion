const editor = document.querySelector('#editor');
const editorLineHeight = () => Number.parseFloat(getComputedStyle(editor).lineHeight) || 18.46;
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
if (documentActions) document.querySelector('.topbar-right')?.prepend(documentActions);
if (new URLSearchParams(location.search).get('embedded') === '1') document.documentElement.classList.add('embedded-editor');

const closeMenus = () => {
  document.querySelectorAll('[data-menu-popup]').forEach((popup) => { popup.hidden = true; });
  document.querySelectorAll('[data-menu]').forEach((button) => button.setAttribute('aria-expanded', 'false'));
};
document.querySelectorAll('[data-menu]').forEach((button) => button.addEventListener('click', (event) => {
  event.stopPropagation();
  const popup = document.querySelector(`[data-menu-popup="${button.dataset.menu}"]`);
  const willOpen = popup?.hidden;
  closeMenus();
  if (popup && willOpen) {
    popup.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    popup.querySelector('button')?.focus();
  }
}));
document.addEventListener('click', (event) => { if (!event.target.closest('.menu-item')) closeMenus(); });

let currentProjectRoot = '';
let scenarioDirectory = 'senario';
let pickerMode = 'open';
let pickerPath = '';
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
let fileInfoBase = '';
let validationSequence = 0;
let isDirty = false;
let sceneRevision = '';
let middleScroll = null;
let minimapDrag = null;
const undoStack = [];
const redoStack = [];
let restoringHistory = false;
const openTabs = [];
const splitTabs = [];
const fileLabel = (name) => String(name || '').replace(/[\\/]$/, '').split(/[\\/]/).pop();
const valueTypeLabel = (type) => typeof type === 'string' ? type : type?.kind === 'struct' ? type.name || 'struct' : type?.kind === 'dict' ? `dict[${type.value}]` : type?.kind || '不明';
function scenarioRelativePath(name) {
  const root = String(scenarioDirectory || '').replaceAll('\\', '/').replace(/\/+$/, '');
  const normalized = String(name || '').replaceAll('\\', '/').replace(/\/+$/, '');
  if (!root) return null;
  if (normalized.toLowerCase() === root.toLowerCase()) return '';
  const prefix = `${root}/`;
  return normalized.toLowerCase().startsWith(prefix.toLowerCase()) ? normalized.slice(prefix.length) : null;
}
const normalizedScenePath = (name) => scenarioRelativePath(name) ?? String(name || '').replaceAll('\\', '/');
const diagnosticForCurrentFile = (item) => !item.file || item.file === 'current' || normalizedScenePath(item.file) === normalizedScenePath(sceneName.value);
const diagnosticLineRange = (item) => {
  const start = Number(item.line) || 1;
  const end = Math.max(start, Number(item.endLine) || start);
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
};
const contiguousLineRanges = (lineNumbers, sourceLines = []) => {
  const lines = [...new Set(lineNumbers)].sort((a, b) => a - b);
  if (!lines.length) return [];
  const ranges = [];
  let start = lines[0], end = start;
  for (const line of lines.slice(1)) {
    const gapIsOnlySpacing = sourceLines.length && Array.from({ length: Math.max(0, line - end - 1) }, (_, index) => sourceLines[end + index]).every((text) => /^\s*(?:#.*|\/\/.*)?$/.test(text || ''));
    if (line === end + 1 || gapIsOnlySpacing) end = line;
    else { ranges.push({ start, end }); start = end = line; }
  }
  ranges.push({ start, end });
  return ranges;
};
const lineRangeLabel = ({ start, end }) => start === end ? `${start} line` : `${start}-${end} line`;
const unreachableSceneLines = (item, sourceLines) => {
  const start = Math.max(1, Number(item.line) || 1);
  const nextScene = sourceLines.findIndex((line, index) => index + 1 > start && /^\s*scene\s+[A-Za-z_][A-Za-z0-9_]*\s*\{/.test(line));
  let end = nextScene < 0 ? sourceLines.length : nextScene;
  while (end > start && /^\s*$/.test(sourceLines[end - 1] || '')) end--;
  return Array.from({ length: Math.max(1, end - start + 1) }, (_, index) => start + index);
};
const variableTooltip = document.createElement('div');
variableTooltip.className = 'variable-tooltip';
variableTooltip.hidden = true;
document.body.append(variableTooltip);
const fileContextMenu = document.createElement('div');
fileContextMenu.className = 'file-context-menu';
fileContextMenu.hidden = true;
fileContextMenu.setAttribute('role', 'menu');
document.body.append(fileContextMenu);
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
  const keywords = new Set(['scene', 'asset', 'character', 'pose', 'struct', 'say', 'bg', 'bgm', 'char', 'show', 'at', 'hide', 'clear', 'play', 'wait', 'effect', 'const', 'global', 'set', 'unset', 'if', 'elif', 'else', 'and', 'or', 'not', 'for', 'from', 'to', 'step', 'while', 'choice', 'fn', 'return', 'goto', 'include']);
  const types = new Set(['int', 'str', 'none', 'dict']);
  const builtins = new Set(['narrator', 'left', 'center', 'right', 'far_left', 'far_right', 'fade', 'black', 'white', 'async', 'blocking', 'voice', 'video', 'image', 'se']);
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
  wordAfter('pose', 'asset');
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
    if (first.value === 'global') {
      const equals = significant.findIndex((token) => token.value === '=');
      if (equals > 0 && significant[equals - 1]?.kind === 'word') significant[equals - 1].role = 'declaration';
    }
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
    const value = escape(token.value).replace(/\{([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)(\(\))?\}/g, '<span class="hl-interpolation">{$1$2}</span>');
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

const KEYWORDS = ['scene', 'asset', 'character', 'pose', 'struct', 'int', 'str', 'dict', 'const', 'global', 'say', 'bg', 'bgm', 'show', 'hide', 'clear', 'play', 'wait', 'effect', 'set', 'unset', 'if', 'elif', 'else', 'and', 'or', 'not', 'for', 'while', 'choice', 'fn', 'return', 'goto', 'include'];

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

function adjustSelectionIndent(outdent = false) {
  const source = editor.value;
  const start = editor.selectionStart;
  const end = editor.selectionEnd;
  const firstLineStart = source.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
  const selectionEndLineStart = source.lastIndexOf('\n', Math.max(0, end - 1)) + 1;
  const lastLineStart = end > firstLineStart && end === selectionEndLineStart ? Math.max(firstLineStart, selectionEndLineStart - 1) : selectionEndLineStart;
  const lineEnd = source.indexOf('\n', lastLineStart) < 0 ? source.length : source.indexOf('\n', lastLineStart);
  const before = source.slice(0, firstLineStart);
  const selectedLines = source.slice(firstLineStart, lineEnd).split('\n');
  const changedLines = selectedLines.map((line) => {
    if (!outdent) return `  ${line}`;
    if (line.startsWith('\t')) return line.slice(1);
    if (line.startsWith('  ')) return line.slice(2);
    if (line.startsWith(' ')) return line.slice(1);
    return line;
  });
  const replacement = changedLines.join('\n');
  const after = source.slice(lineEnd);
  if (replacement === source.slice(firstLineStart, lineEnd)) return false;
  const lineDeltas = changedLines.map((line, index) => line.length - selectedLines[index].length);
  const changedLength = replacement.length - (lineEnd - firstLineStart);
  const mapPosition = (position) => {
    if (position < firstLineStart) return position;
    if (position >= lineEnd) return position + changedLength;
    let mapped = position;
    let lineStart = firstLineStart;
    for (let index = 0; index < lineDeltas.length; index++) {
      if (lineStart > position) break;
      mapped += lineDeltas[index];
      lineStart += selectedLines[index].length + 1;
    }
    return Math.max(0, mapped);
  };
  const nextStart = mapPosition(start);
  const nextEnd = Math.max(nextStart, mapPosition(end));
  rememberUndo();
  editor.value = `${before}${replacement}${after}`;
  editor.focus();
  editor.setSelectionRange(nextStart, Math.min(editor.value.length, nextEnd));
  editor.dispatchEvent(new Event('input'));
  return true;
}

function notifySceneFlowRefresh() {
  const frame = document.querySelector('#scene-flow-frame');
  if (frame?.src && frame.contentWindow) frame.contentWindow.postMessage({ type: 'scene-flow:refresh' }, location.origin);
}

async function request(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (response.ok) document.querySelector('#runtime-error')?.remove();
  if (!response.ok) throw new Error(data.error || '通信に失敗しました。');
  if (options?.method && options.method !== 'GET' && (url === '/api/scene' || url === '/api/file')) {
    refreshFiles().catch(showError);
    notifySceneFlowRefresh();
  }
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
      folder.onclick = () => { contents.hidden = !contents.hidden; if (folder.firstChild) folder.firstChild.nodeValue = `${contents.hidden ? '›' : '⌄'} ${name}`; };
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
  const { files, title, projectRoot, scenarioDir } = await request('/api/files');
  if (projectRoot) currentProjectRoot = projectRoot;
  if (scenarioDir) scenarioDirectory = scenarioDir;
  document.querySelector('#project-title')?.replaceChildren(document.createTextNode(title || 'EXPLORER'));
  const pathNote = document.querySelector('#project-path');
  if (pathNote) {
    pathNote.title = currentProjectRoot || '';
    pathNote.replaceChildren(Object.assign(document.createElement('span'), { className: 'folder-icon', textContent: '▱' }), document.createTextNode(` ${currentProjectRoot || '作品フォルダー'}`));
  }
  const visible = files.map((file) => ({ ...file, displayPath: file.path }));
  const root = { folders: new Map(), files: [] };
  for (const file of visible) { const parts = file.displayPath.split('/'); let node = root; parts.forEach((part, index) => { if (index === parts.length - 1) { if (file.directory) { if (!node.folders.has(part)) node.folders.set(part, { folders: new Map(), files: [] }); } else node.files.push({ name: part, path: file.path }); } else { if (!node.folders.has(part)) node.folders.set(part, { folders: new Map(), files: [] }); node = node.folders.get(part); } }); }
  const expandedFolders = new Set([...fileTree.querySelectorAll('.scene-folder')].filter((folder) => folder.nextElementSibling && !folder.nextElementSibling.hidden).map((folder) => folder.textContent.replace(/[›⌄+]/g, '').trim()));
  fileTree.replaceChildren();
  const drawFile = (node, parent, depth = 0, folderPath = '') => {
    [...node.folders].sort().forEach(([name, child]) => {
      const folder = document.createElement('div'); folder.className = 'scene-folder'; folder.style.paddingLeft = `${depth * 14}px`; folder.textContent = `› ${name}`; const path = folderPath ? `${folderPath}/${name}` : name; const contents = document.createElement('div'); contents.className = 'scene-folder-contents'; contents.hidden = true; folder.onclick = () => { contents.hidden = !contents.hidden; if (folder.firstChild) folder.firstChild.nodeValue = `${contents.hidden ? '›' : '⌄'} ${name}`; }; folder.dataset.path = path; folder.oncontextmenu = (event) => { event.preventDefault(); if (scenarioRelativePath(path) !== null) addSceneInUi(path).catch(showError); }; parent.append(folder, contents); drawFile(child, contents, depth + 1, path);
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
        showFileContextMenu(event, file.path);
      };
      if (scenarioRelativePath(file.path) !== null && /\.(tds|txt)$/i.test(file.path)) {
        openButton.title = 'クリック: 左で開く / Shift+クリック: 右へ移動';
        openButton.onclick = (event) => {
          const name = scenarioRelativePath(file.path);
          if (event.shiftKey) moveTabToRight(name).catch(showError);
          else openScene(name).catch(showError);
        };
      }
      if (file.path.startsWith('asset/')) { openButton.title = '?????'; openButton.onclick = () => window.open('/' + file.path.split('/').map(encodeURIComponent).join('/'), '_blank', 'noopener'); }
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
        await forgetDeletedScene(scenarioRelativePath(path) ?? path);
        await refreshFiles();
        await refreshScenes();
      }
    };
    item.append(button);
  });
  fileTree.querySelectorAll('.scene-folder').forEach((folder) => {
    if (scenarioRelativePath(folder.dataset.path) === null) return;
    const button = document.createElement('button');
    button.className = 'tree-action';
    button.textContent = '+';
    button.title = 'ファイル追加';
    button.onclick = (event) => {
      event.stopPropagation();
      const name = folder.dataset.path;
      addSceneInUi(name).catch(showError);
    };
    folder.append(button);
  });
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const input = document.createElement('textarea');
    input.value = text; input.style.position = 'fixed'; input.style.opacity = '0';
    document.body.append(input); input.select(); document.execCommand('copy'); input.remove();
  }
  setStatus('パスをコピーしました', 'ok');
}

function closeFileContextMenu() {
  fileContextMenu.hidden = true;
  fileContextMenu.replaceChildren();
}

function showFileContextMenu(event, filePath) {
  const isScene = scenarioRelativePath(filePath) !== null && /\.(tds|txt)$/i.test(filePath);
  const isAsset = filePath.startsWith('asset/');
  const addAction = (label, action, className = '') => {
    const button = document.createElement('button'); button.type = 'button'; button.setAttribute('role', 'menuitem'); button.className = className;
    button.textContent = label;
    button.addEventListener('click', () => { closeFileContextMenu(); action(); });
    fileContextMenu.append(button);
  };
  const separator = () => fileContextMenu.append(Object.assign(document.createElement('span'), { className: 'file-context-separator' }));
  fileContextMenu.replaceChildren();
  if (isScene) {
    const name = scenarioRelativePath(filePath);
    addAction('開く', () => openScene(name).catch(showError));
    addAction('右ペインで開く', () => moveTabToRight(name).catch(showError));
    addAction('ファイル情報を表示', () => showFileInfo(filePath).catch(showError));
    separator();
  } else if (isAsset) {
    addAction('素材をプレビュー', () => window.open('/' + filePath.split('/').map(encodeURIComponent).join('/'), '_blank', 'noopener'));
    separator();
  }
  addAction('相対パスをコピー', () => copyText(filePath).catch(showError));
  separator();
  addAction('削除…', async () => {
    if (!await uiConfirm(`${filePath} を削除しますか？`)) return;
    await request('/api/file', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: filePath }) });
    await forgetDeletedScene(scenarioRelativePath(filePath) ?? filePath);
    await refreshFiles();
    await refreshScenes();
  }, 'danger');
  fileContextMenu.style.left = `${Math.max(8, Math.min(event.clientX, window.innerWidth - 235))}px`;
  fileContextMenu.style.top = `${Math.max(8, Math.min(event.clientY, window.innerHeight - 250))}px`;
  fileContextMenu.hidden = false;
}

async function showFileInfo(path) {
  path = normalizedScenePath(path);
  const graph = await request('/api/scene-graph');
  const node = graph.nodes.find((item) => item.id === path);
  if (node?.error) {
    if (normalizedScenePath(sceneName.value) === path) { fileInfoBase = '構文エラー'; fileInfo.textContent = fileInfoBase; }
    return;
  }
  let targets = graph.edges.filter((edge) => edge.from === path).map((edge) => edge.to);
  let variables = (node?.variables || []).map((variable) => {
    const definitions = (variable.definitions || []).length;
    const references = (variable.references || []).length;
    const counts = definitions || references ? `（定義${definitions} / 参照${references}）` : '';
    return `${variable.name}: ${valueTypeLabel(variable.type)}${counts}`;
  });
  if ((!node || node.error) && fileInfo) {
    try {
      const scene = await request(`/api/scene?name=${encodeURIComponent(path)}`);
      const source = String(scene.source || '');
      targets = [...source.matchAll(/^\s*goto\s+(?:"([^"]+)"|([^\s]+))/gmi)].map((m) => m[1] || m[2]);
      variables = [...source.matchAll(/^\s*(?:global\s+)?(?:const\s+)?(int|str|dict)\s+([A-Za-z_][A-Za-z0-9_]*)/gmi)].map((m) => `${m[2]}: ${m[1]}`);
    } catch { /* keep empty information */ }
  }
  const reachability = node?.reachable === false ? ' / 開始ファイルから到達不能' : '';
  const text = `goto: ${targets.length ? targets.join(', ') : 'なし'} / 変数: ${variables.length ? variables.join(', ') : 'なし'}${reachability}`;
  if (normalizedScenePath(sceneName.value) === path) { fileInfoBase = text; fileInfo.textContent = text; }
}
async function addSceneInUi(folder) {
  folder = scenarioRelativePath(folder);
  if (folder === null) return;
  const name = await uiPrompt(`${folder} に追加するシーン名`, '');
  if (!name) return;
  const path = [folder, name.replace(/^\/+/, '')].filter(Boolean).join('/');
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
  while (start > lineStart && !/[\s{}"=:><!+\-.]/.test(source[start - 1])) start--;
  const hyphenatedPositionPrefix = /(?:^|\s)(far-(?:left|right)?)$/.exec(line);
  if (hyphenatedPositionPrefix) start = lineStart + hyphenatedPositionPrefix.index + hyphenatedPositionPrefix[0].search(/far-/);
  // カーソルが単語の途中にあっても、右側の残りを含めて置換する。
  // 例: i|nt で int を確定したときに "int nt" を作らない。
  let replaceEnd = end;
  while (replaceEnd < source.length && !/[\s{}"=:><!+\-.]/.test(source[replaceEnd])) replaceEnd++;
  const prefix = source.slice(start, end);
  const words = source.slice(lineStart, start).trim().split(/\s+/).filter(Boolean);
  return { start, end, replaceEnd, prefix, words, line };
}

function candidatesFor(context) {
  const [command, ...args] = context.words;
  if (!command) return KEYWORDS;

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
    for (const pm of m[2].matchAll(/\bpose\s+([A-Za-z][A-Za-z0-9_-]*)\s*=/g)) {
      charDefs.get(cName).add(pm[1]);
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
  if (command === 'play' && ['voice', 'video'].includes(args[0]) && args.length === 2) return ['blocking', 'async'];
  if (command === 'play' && ['se', 'voice', 'bgm', 'video'].includes(args[0])) {
    const plays = projectAssets.filter((a) => a.type === args[0]).map((a) => a.name);
    return [...new Set([...plays, ...(catalog[args[0]] || [])])];
  }
  if (command === 'show' && args.length === 0) return [...new Set([...charDefs.keys(), 'image'])];
  if (command === 'show' && args.length === 1 && args[0].endsWith('.')) {
    const poses = charDefs.get(args[0].slice(0, -1));
    return poses && poses.size ? [...poses] : ['normal', 'smile', 'sad', 'angry'];
  }
  if (command === 'show' && args.length === 1 && args[0].includes('.')) return ['far_left', 'left', 'center', 'right', 'far_right'];
  if (command === 'show' && args.length === 2 && args[0].includes('.')) return ['fade'];
  if (command === 'show' && args[0] === 'image' && args.length === 1) {
    const imgs = projectAssets.filter((a) => a.type === 'image').map((a) => a.name);
    return [...new Set([...imgs, ...(catalog.image || [])])];
  }
  if (command === 'show' && args[0] === 'image' && args.length === 2) return ['far_left', 'left', 'center', 'right', 'far_right'];
  if (command === 'hide') {
    if (args.length === 0) return [...charDefs.keys()];
    if (args.length === 1) return ['fade'];
    return [];
  }
  if (command === 'clear') return ['bg', 'bgm', 'image'];
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
  // 候補を一つに絞り込む必要はない。入力済みの接頭辞に合う候補を
  // 上位から表示し、キーボードまたはクリックで明示的に選ばせる。
  suggestions = prefix ? matches.slice(0, 12) : [];
  suggestionIndex = 0;
  completionRange = context;
  const lineStart = editor.value.lastIndexOf('\n', editor.selectionStart - 1) + 1;
  const line = editor.value.slice(0, editor.selectionStart).split('\n').length - 1;
  const column = editor.selectionStart - lineStart;
  suggestionBox.style.left = `${78 + column * 8.4}px`;
  suggestionBox.style.top = `${21 + line * editorLineHeight() - editor.scrollTop + 25}px`;
  renderSuggestions();
}

function hideVariableTooltip() {
  variableTooltip.hidden = true;
}

function currentSourceVariable(name) {
  const declaration = new RegExp(`^\\s*(?:global\\s+)?(?:const\\s+)?(int|str|dict\\[(?:int|str)\\]|[A-Z][A-Za-z0-9_]*)\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=`, 'm');
  const match = declaration.exec(editor.value);
  if (!match) return null;
  const line = editor.value.slice(0, match.index).split(/\r?\n/).length;
  return {
    name,
    type: match[1],
    definitions: [{ file: sceneName.value, line, kind: 'definition', container: 'current' }],
    references: [],
  };
}

function renderVariableTooltipDetails(event) {
  const rect = editor.getBoundingClientRect();
  const style = getComputedStyle(editor);
  const lineHeight = Number.parseFloat(style.lineHeight) || editorLineHeight();
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
    title.textContent = `${variable.name} : ${valueTypeLabel(variable.type)}`;
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
  const lineHeight = Number.parseFloat(style.lineHeight) || editorLineHeight();
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
  const variable = knownVariables.find((item) => item.name === match[0]) || currentSourceVariable(match[0]);
  if (!variable) return hideVariableTooltip();

  variableTooltip.replaceChildren();
  const title = document.createElement('strong');
  title.className = 'variable-tooltip-title';
  title.textContent = `${variable.name} : ${valueTypeLabel(variable.type)}`;
  variableTooltip.append(title);
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
  return true;
}

function showSyntaxTooltip(event) {
  const rect = editor.getBoundingClientRect();
  const style = getComputedStyle(editor);
  const lineHeight = Number.parseFloat(style.lineHeight) || editorLineHeight();
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
  const body = document.createElement('div'); body.className = 'syntax-tooltip-signature'; body.textContent = hint;
  const recipe = syntaxRecipes[match[0]];
  variableTooltip.append(title, body);
  if (recipe?.description) {
    const description = document.createElement('div'); description.className = 'syntax-tooltip-description'; description.textContent = recipe.description;
    variableTooltip.append(description);
  }
  const guideButton = document.createElement('button'); guideButton.type = 'button'; guideButton.className = 'syntax-tooltip-link'; guideButton.textContent = '構文リファレンスを開く';
  guideButton.addEventListener('click', () => { hideVariableTooltip(); showLanguageGuide(); });
  variableTooltip.append(guideButton);
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
    button.textContent = `${index === suggestionIndex ? '› ' : '  '}${candidate}`;
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
  const replaceEnd = completionRange.replaceEnd ?? completionRange.end;
  const following = source.slice(replaceEnd, replaceEnd + 1);
  const speakerCompletion = completionRange.words[0] === 'say' && completionRange.words.length === 1;
  const showCharacterCompletion = completionRange.words[0] === 'show' && completionRange.words.length === 1 && candidate !== 'image' && candidate !== 'char';
  const insertion = speakerCompletion ? `${candidate} ""` : showCharacterCompletion ? `${candidate}.` : `${completionRange.insertLeadingSpace ? ' ' : ''}${candidate}${following && /\s/.test(following) ? '' : ' '}`;
  rememberUndo();
  editor.value = `${source.slice(0, completionRange.start)}${insertion}${source.slice(replaceEnd)}`;
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
  localStorage.setItem(lastSceneKey(), scene.name);
  if (!openTabs.includes(scene.name)) openTabs.push(scene.name);
  sceneName.value = scene.name;
  editor.value = scene.source;
  sceneRevision = String(scene.revision || '');
  clearEditorHistory();
  updateDirtyState(false);
  updateLineNumbers();
  updateHighlight();
result.textContent = '';
  setStatus(`${scene.name} を開きました`, 'ok');
  renderEditorTabs(scene.name);
  showFileInfo(scene.name).catch(() => {});
  scheduleValidation();
}

async function jumpToLocation(location) {
  const requestedFile = String(location.file || sceneName.value);
  const file = requestedFile === 'current' ? sceneName.value : scenarioRelativePath(requestedFile) ?? requestedFile;
  if (file && normalizedScenePath(file) !== normalizedScenePath(sceneName.value)) await openScene(file);
  const line = Math.max(1, Number(location.line) || 1);
  const column = Math.max(0, Number(location.column) - 1 || 0);
  const lineStart = editor.value.split(/\r?\n/).slice(0, line - 1).reduce((total, value) => total + value.length + 1, 0);
  const caret = Math.min(editor.value.length, lineStart + column);
  editor.focus();
  editor.setSelectionRange(caret, caret);
  editor.scrollTop = Math.max(0, (line - 1) * editorLineHeight() - 70);
  hideVariableTooltip();
}

function renderDiagnosticResult(summary, entries) {
  const heading = document.createElement('div');
  heading.className = 'diagnostic-summary';
  heading.textContent = summary;
  result.replaceChildren(heading);
  for (const entry of entries) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `diagnostic-link diagnostic-${entry.severity}`;
    button.textContent = entry.text;
    button.title = 'クリックして該当行へ移動';
    button.addEventListener('click', () => jumpToLocation(entry.location).catch(showError));
    result.append(button);
  }
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
    const split = document.createElement('button'); split.type = 'button'; split.className = 'editor-tab-split'; split.textContent = '→'; split.title = `${name}を右ペインで開く`;
    split.addEventListener('click', () => moveTabToRight(name).catch(showError));
    const close = document.createElement('button'); close.type = 'button'; close.className = 'editor-tab-close'; close.textContent = '×'; close.title = `${name}を閉じる`;
    close.addEventListener('click', async () => {
      if (isDirty && name === sceneName.value && !window.confirm('未保存の変更があります。タブを閉じますか？')) return;
      const index = openTabs.indexOf(name); if (index >= 0) openTabs.splice(index, 1);
      if (name === sceneName.value) {
        const next = openTabs[index] || openTabs[index - 1];
        if (next) await openScene(next); else { sceneName.value = ''; editor.value = ''; clearEditorHistory(); updateLineNumbers(); updateHighlight();
updateDirtyState(false); }
      }
      renderEditorTabs(sceneName.value);
      renderSplitTabs();
    });
    tab.append(select, split, close); return tab;
  }));
}

const FORMAT_CURSOR_MARKER = '\uE000NOVEL_EDITOR_CURSOR\uE001';
const FORMAT_SELECTION_MARKER = '\uE000NOVEL_EDITOR_SELECTION_END\uE001';
const FORMAT_MARKER_PATTERN = /^(\uE000NOVEL_EDITOR_(?:CURSOR|SELECTION_END)\uE001_*)/;

function formatTokens(line) {
  const tokens = [];
  for (let index = 0; index < line.length;) {
    const char = line[index];
    if (/\s/.test(char)) { index++; continue; }
    const markerMatch = line.slice(index).match(FORMAT_MARKER_PATTERN);
    if (markerMatch) {
      const value = markerMatch[1];
      const start = index;
      index += value.length;
      tokens.push({ kind: 'marker', value, embedded: start > 0 && start + value.length < line.length && !/\s/.test(line[start - 1]) && !/\s/.test(line[start + value.length]) });
      continue;
    }
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
    if (/[A-Za-z_]/.test(char)) {
      const start = index++;
      while (index < line.length && /[A-Za-z0-9_]/.test(line[index])) index++;
      const value = line.slice(start, index);
      tokens.push({ kind: 'word', value });
      continue;
    }
    if (/[0-9]/.test(char)) { const start = index++; while (index < line.length && /[0-9]/.test(line[index])) index++; tokens.push({ kind: 'number', value: line.slice(start, index) }); continue; }
    const pair = line.slice(index, index + 2);
    if (['==', '!=', '>=', '<=', '->', '=>', '..'].includes(pair)) { tokens.push({ kind: 'operator', value: pair }); index += 2; continue; }
    if ('=+-*/%<>!'.includes(char)) tokens.push({ kind: 'operator', value: char });
    else if ('{}[]():,.'.includes(char)) tokens.push({ kind: 'punctuation', value: char });
    else tokens.push({ kind: 'plain', value: char });
    index++;
  }
  const previousRealIndex = (index) => {
    let previousIndex = index - 1;
    while (previousIndex >= 0 && tokens[previousIndex].kind === 'marker') previousIndex--;
    return previousIndex;
  };
  const unary = tokens.map((token, index) => {
    const previousIndex = previousRealIndex(index);
    const previous = previousIndex >= 0 ? tokens[previousIndex] : undefined;
    return token.kind === 'operator' && ['+', '-', '!'].includes(token.value)
      && (previousIndex < 0 || previous?.kind === 'operator' || ['(', '[', '{', ',', ':'].includes(previous?.value)
        || (previous?.kind === 'word' && ['from', 'to', 'step', 'return'].includes(previous.value)));
  });
  let result = '';
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    let previousIndex = index - 1;
    while (previousIndex >= 0 && tokens[previousIndex].kind === 'marker') previousIndex--;
    const previous = previousIndex >= 0 ? tokens[previousIndex] : undefined;
    if (token.kind === 'marker') { result += token.value; continue; }
    if (token.kind === 'comment') { result += `${result ? '  ' : ''}${token.value}`; continue; }
    let spaced = previousIndex >= 0;
    const embeddedMarker = tokens[index - 1]?.kind === 'marker' && tokens[index - 1].embedded;
    const markerJoinsToken = embeddedMarker && (
      (['word', 'number'].includes(previous?.kind) && ['word', 'number'].includes(token.kind))
      || (previous?.kind === 'operator' && token.kind === 'operator' && ['==', '!=', '>=', '<=', '->', '=>', '..'].includes(`${previous.value}${token.value}`))
    );
    if (['[', ')', ']', ',', ':', '.'].includes(token.value) || ['(', '[', '.'].includes(previous?.value)) spaced = false;
    if (token.value === '(' && previous?.kind === 'word' && !['if', 'elif', 'while', 'not', 'return', 'choice'].includes(previous.value)) spaced = false;
    if (token.kind === 'operator') spaced = unary[index] ? !(previous?.kind === 'operator' || ['(', '[', '{', ',', ':'].includes(previous?.value)) : true;
    if (previous?.kind === 'operator') spaced = !unary[index - 1];
    if (token.kind === 'operator' && unary[index] && previous?.kind === 'operator' && unary[previousIndex]) spaced = true;
    if (token.value === '}') spaced = previous?.value !== '{';
    if (previous?.value === '{') spaced = token.value !== '}';
    if (token.value === '{') spaced = index > 0 && !['(', '[', '{'].includes(previous?.value);
    if (previous?.value === ',' || previous?.value === ':') spaced = true;
    if (markerJoinsToken) spaced = false;
    result += `${spaced && result && !result.endsWith(' ') ? ' ' : ''}${token.value}`;
  }
  return { text: result.trimEnd(), tokens: tokens.filter((token) => token.kind !== 'comment' && token.kind !== 'marker') };
}

function expandStructuralLine(raw, context = []) {
  const structural = [];
  let quote = false;
  let comment = false;
  let previousBrace = -1;
  let parenthesisDepth = Number.isInteger(context.parenthesisDepth) ? context.parenthesisDepth : 0;
  let bracketDepth = Number.isInteger(context.bracketDepth) ? context.bracketDepth : 0;
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index];
    if (comment) continue;
    if (quote) {
      if (char === '\\') index++;
      else if (char === '"') quote = false;
      continue;
    }
    if (char === '"') { quote = true; continue; }
    if (char === '#' || (char === '/' && raw[index + 1] === '/')) { comment = true; continue; }
    if (char === '(') { parenthesisDepth++; continue; }
    if (char === ')') { parenthesisDepth = Math.max(0, parenthesisDepth - 1); continue; }
    if (char === '[') { bracketDepth++; continue; }
    if (char === ']') { bracketDepth = Math.max(0, bracketDepth - 1); continue; }
    if (char === '{') {
      const before = raw.slice(0, index).trim();
      const dictionary = parenthesisDepth > 0 || bracketDepth > 0 || /(?:=|:|\[)\s*$/.test(before);
      const statementPrefix = raw.slice(previousBrace + 1, index).trim();
      const headerPrefix = raw.slice(0, index).trim();
      const keyword = /^(\w+)\b/.exec(statementPrefix)?.[1] || '';
      const statementCommand = /^(?:return|set|unset|say|show|hide|clear|bg|bgm|play|wait|effect|goto|include|global|const|int|str|dict)\b/.test(statementPrefix);
      const parent = context.at(-1);
      const choiceExpression = parent?.kind === 'choice' && !statementCommand && /^(?:"(?:\\.|[^"\\])*"|[A-Za-z_][A-Za-z0-9_.]*(?:\s*\([^{}]*\))?|\d+|[+-]|\(|!|not\b)/.test(statementPrefix);
      const block = !dictionary && (/^(?:scene|fn|if|elif|else|for|while|choice|character|struct)\b/.test(statementPrefix)
        || (previousBrace < 0 && /^(?:scene|fn|if|elif|else|for|while|choice|character|struct)\b/.test(headerPrefix))
        || /"[^"\\]*(?:\\.[^"\\]*)*"\s*$/.test(statementPrefix) || choiceExpression);
      context.push({ block, kind: block ? (choiceExpression ? 'choiceOption' : keyword) : 'literal' });
      if (block) structural.push({ index, type: 'open' });
      if (block) previousBrace = index;
    } else if (char === '}') {
      const entry = context.pop();
      if (entry?.block) structural.push({ index, type: 'close' });
      if (entry?.block) previousBrace = index;
    }
  }
  context.parenthesisDepth = parenthesisDepth;
  context.bracketDepth = bracketDepth;
  if (!structural.length) return [raw];
  const result = [];
  let cursor = 0;
  for (const brace of structural) {
    if (brace.type === 'open') {
      const before = raw.slice(cursor, brace.index + 1).trim();
      if (before) result.push(before);
      cursor = brace.index + 1;
    } else {
      const before = raw.slice(cursor, brace.index).trim();
      if (before) result.push(before);
      result.push('}');
      cursor = brace.index + 1;
    }
  }
  const tail = raw.slice(cursor).trim();
  if (tail) {
    const trailingComment = /^(?:#|\/\/)/.test(tail);
    if (trailingComment && result.length) result[result.length - 1] += `  ${tail}`;
    else result.push(tail);
  }
  return result;
}

function formatSource(source) {
  return window.NovelFormatter.format(source);
}

// 文字列とコメントを除外して、指定した開き波括弧に対応する閉じ波括弧を探す。
// 自動ブロック生成時に、既にある閉じ波括弧を重ねて追加しないために使う。
function matchingClosingBrace(source, openingIndex) {
  let depth = 0;
  for (let index = openingIndex; index < source.length; index++) {
    const char = source[index];
    if (char === '#' || (char === '/' && source[index + 1] === '/')) {
      const newline = source.indexOf('\n', index);
      if (newline < 0) return -1;
      index = newline;
      continue;
    }
    if (char === '"') {
      index++;
      while (index < source.length) {
        if (source[index] === '\\') { index++; }
        else if (source[index] === '"') break;
        index++;
      }
      continue;
    }
    if (char === '{') depth++;
    if (char === '}' && --depth === 0) return index;
  }
  return -1;
}

function replaceWithFormattedSource(source, caretOffset = null, selectionEnd = caretOffset) {
  const markerName = (base) => {
    let marker = base;
    while (source.includes(marker)) marker += '_';
    return marker;
  };
  const cursorMarker = markerName(FORMAT_CURSOR_MARKER);
  const selectionMarker = markerName(FORMAT_SELECTION_MARKER);
  let marked = source;
  const tracksEndWithoutMarker = caretOffset !== null && caretOffset === source.length && (selectionEnd ?? caretOffset) === caretOffset;
  let markerStart = null;
  if (caretOffset !== null && !tracksEndWithoutMarker) {
    const start = Math.max(0, Math.min(source.length, caretOffset));
    const end = Math.max(start, Math.min(source.length, selectionEnd ?? start));
    markerStart = start;
    marked = `${source.slice(0, start)}${cursorMarker}${source.slice(start, end)}${end > start ? selectionMarker : ''}${source.slice(end)}`;
  }
  const moveMarkerAfterInsertedSpaces = (text, marker, offset) => {
    if (offset === null || offset <= 0 || offset >= source.length || /\s/.test(source[offset - 1]) || /\s/.test(source[offset])) return text;
    const at = text.indexOf(marker);
    const after = at + marker.length;
    if (at < 0 || !/[ \t]/.test(text[after])) return text;
    let end = after;
    while (/[ \t]/.test(text[end])) end++;
    return `${text.slice(0, at)}${text.slice(after, end)}${marker}${text.slice(end)}`;
  };
  let formatted = formatSource(marked);
  formatted = moveMarkerAfterInsertedSpaces(formatted, cursorMarker, markerStart);
  formatted = formatted.split('\n').map((line) => {
    const trimmed = line.trim();
    return [cursorMarker, selectionMarker, `${cursorMarker}${selectionMarker}`].includes(trimmed) ? trimmed : line;
  }).join('\n');
  const selectionAt = formatted.indexOf(selectionMarker);
  let nextSource = formatted;
  if (selectionAt >= 0) nextSource = `${nextSource.slice(0, selectionAt)}${nextSource.slice(selectionAt + selectionMarker.length)}`;
  const adjustedMarkerAt = nextSource.indexOf(cursorMarker);
  if (adjustedMarkerAt >= 0) nextSource = `${nextSource.slice(0, adjustedMarkerAt)}${nextSource.slice(adjustedMarkerAt + cursorMarker.length)}`;
  rememberUndo();
  editor.value = nextSource;
  const caret = adjustedMarkerAt < 0 ? nextSource.length : adjustedMarkerAt;
  const end = selectionAt < 0 ? caret : selectionAt - cursorMarker.length;
  editor.focus();
  editor.setSelectionRange(caret, Math.max(caret, end));
  editor.dispatchEvent(new Event('input'));
}

function formatCode() {
  const source = editor.value;
  const formatted = formatSource(source);
  if (formatted === source) return;
  replaceWithFormattedSource(source, editor.selectionStart, editor.selectionEnd);
}

async function saveScene() {
  // Saving is a durable boundary: persist the same canonical source that the
  // editor validates and previews, using the cursor-preserving formatter path.
  formatCode();
  const saved = await request('/api/scene', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: sceneName.value, source: editor.value, ...(sceneRevision ? { expectedRevision: sceneRevision } : {}) }),
  });
  sceneName.value = saved.name;
  sceneRevision = String(saved.revision || '');
  if (!openTabs.includes(saved.name)) openTabs.push(saved.name);
  renderEditorTabs(saved.name);
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
    notifySceneFlowRefresh();
  }
  setStatus(savedNames.length ? `${savedNames.length} ファイルを保存しました` : 'すべて保存済みです', 'ok');
  return savedNames;
}

async function formatProjectScenes() {
  formatCode();
  const splitApi = !splitGroup?.hidden ? splitFrame?.contentWindow?.novelEditorApi : null;
  splitApi?.formatCurrent?.();
  await saveAllScenes();
  const { scenes = [] } = await request('/api/scenes', { cache: 'no-store' });
  const updates = [];
  for (const name of scenes) {
    const scene = await request(`/api/scene?name=${encodeURIComponent(name)}`, { cache: 'no-store' });
    const source = String(scene.source || '');
    const formatted = formatSource(source);
    if (formatted === source) continue;
    updates.push({ name, source, formatted, revision: scene.revision });
  }
  const changed = [];
  let activeUpdate = null;
  try {
    for (const update of updates) {
      activeUpdate = update;
      await request('/api/scene', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: update.name, source: update.formatted, ...(update.revision ? { expectedRevision: update.revision } : {}) }),
      });
      changed.push(update.name);
      activeUpdate = null;
    }
  } catch (error) {
    const rollbackNames = [...new Set([...changed, ...(activeUpdate ? [activeUpdate.name] : [])])].reverse();
    for (const name of rollbackNames) {
      const original = updates.find((update) => update.name === name);
      if (!original) continue;
      try {
        const current = await request(`/api/scene?name=${encodeURIComponent(name)}`, { cache: 'no-store' });
        // Never undo an unrelated external edit that happened while the
        // project-wide operation was running. Only revert content that still
        // equals the formatter output we attempted to write.
        if (current.source !== original.formatted) continue;
        await request('/api/scene', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: original.name, source: original.source }),
        });
      } catch {
        // Preserve the original failure; a secondary rollback failure is
        // surfaced by the next project refresh or explicit save attempt.
      }
    }
    throw error;
  }
  await refreshScenes(sceneName.value);
  await refreshSceneGraph();
  setStatus(`${changed.length} 繝輔ぃ繧､繝ｫ繧剃ｿ晏ｭ倥＠縺ｾ縺励◆`, 'ok');
  return changed;
}

let lastFormatProjectPromise = Promise.resolve([]);
let formatProjectActive = false;

window.novelEditorApi = {
  save: () => saveScene(),
  saveAll: () => saveAllScenes(),
  isDirty: () => isDirty,
  focus: () => editor.focus(),
  scene: () => sceneName.value,
  format: (source) => formatSource(String(source ?? '')),
  formatCurrent: () => formatCode(),
  formatProject: () => {
    if (formatProjectActive) return lastFormatProjectPromise;
    formatProjectActive = true;
    lastFormatProjectPromise = formatProjectScenes().finally(() => { formatProjectActive = false; });
    return lastFormatProjectPromise;
  },
  lastFormatProject: () => lastFormatProjectPromise,
};

async function validate(providedReport = null) {
  const sequence = ++validationSequence;
  let report = providedReport;
  if (!report) {
    setStatus('構文を検証中…');
    report = await request('/api/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: sceneName.value, source: editor.value }),
    });
    if (sequence !== validationSequence) return;
  }
  diagnostics = Array.isArray(report.diagnostics) ? report.diagnostics : [];
  if (!diagnostics.length && !report.ok) {
    const message = String(report.error || '構文エラー');
    const assetPath = message.match(/(?:asset|アセット)\s*'([^']+)'/)?.[1];
    const assetLine = assetPath ? editor.value.split(/\r?\n/).findIndex((value) => value.includes(assetPath)) + 1 : 0;
    const line = Number(message.match(/line\s+(\d+)/i)?.[1] || assetLine || 1);
    const column = Number(message.match(/column\s+(\d+)/i)?.[1] || 1);
    diagnostics = [{ severity: 'error', code: 'error', line, column, message }];
  }
  const sourceLines = editor.value.split(/\r?\n/);
  const unreachableSceneSpans = diagnostics
    .filter(diagnosticForCurrentFile)
    .filter((item) => item.code === 'unreachable-scene')
    .map((item) => unreachableSceneLines(item, sourceLines));
  const displayedDiagnostics = [];
  const unreachableGroups = new Map();
  diagnostics.forEach((item, index) => {
    if (String(item.code || '').startsWith('unreachable')) {
      const lines = item.code === 'unreachable-scene' && diagnosticForCurrentFile(item)
        ? unreachableSceneLines(item, sourceLines)
        : diagnosticLineRange(item);
      if (item.code !== 'unreachable-scene' && diagnosticForCurrentFile(item)
        && unreachableSceneSpans.some((span) => lines.every((line) => line >= span[0] && line <= span.at(-1)))) return;
      const key = JSON.stringify([item.severity, item.code, item.file || 'current', item.message]);
      const group = unreachableGroups.get(key) || { item, lines: [], index };
      group.lines.push(...lines);
      unreachableGroups.set(key, group);
      return;
    }
    displayedDiagnostics.push({
      line: Number(item.line) || 1,
      index,
      severity: item.severity,
      location: item,
      text: `${item.severity.toUpperCase()} ${item.code}  ${diagnosticForCurrentFile(item) ? '' : `${item.file} `}line ${item.line}:${item.column}  ${item.message}`,
    });
  });
  for (const group of unreachableGroups.values()) {
    const groupSourceLines = diagnosticForCurrentFile(group.item) ? sourceLines : [];
    for (const range of contiguousLineRanges(group.lines, groupSourceLines)) {
      const item = group.item;
      displayedDiagnostics.push({
        line: range.start,
        index: group.index,
        severity: item.severity,
        location: { ...item, line: range.start },
        text: `${item.severity.toUpperCase()} ${item.code}  ${diagnosticForCurrentFile(item) ? '' : `${item.file} `}${lineRangeLabel(range)}  ${item.message}`,
      });
    }
  }
  diagnosticText = displayedDiagnostics.sort((left, right) => left.line - right.line || left.index - right.index).map((item) => item.text).join('\n');
  updateHighlight();
if (fileInfo) fileInfo.textContent = fileInfoBase;
  const unreachableLines = [...unreachableGroups.values()].filter((group) => diagnosticForCurrentFile(group.item)).flatMap((group) => group.lines);
  if (fileInfo && unreachableLines.length) {
    const ranges = contiguousLineRanges(unreachableLines, sourceLines).map(lineRangeLabel);
    fileInfo.textContent += `\n到達不能\n${ranges.join('\n')}`;
  }
  if (report.ok) {
    const warningCount = displayedDiagnostics.filter((item) => item.severity === 'warning').length;
    const infoCount = displayedDiagnostics.filter((item) => item.severity === 'info').length;
    const summary = report.build
      ? `コンパイル完了: 全 ${report.fileCount} ファイル / エラー 0 / 警告 ${warningCount} / 情報 ${infoCount}`
      : `解析完了: エラー 0 / 警告 ${warningCount} / 情報 ${infoCount}`;
    if (warningCount || infoCount) renderDiagnosticResult(summary, displayedDiagnostics);
    else if (report.build) result.textContent = `${summary}\n${report.name}\n${report.path}`;
    else result.textContent = `問題ありません。\n文: ${report.statements}\nコンパイル命令: ${report.instructions}`;
    if (report.build) setStatus(`${report.fileCount} ファイル精査完了 / ${report.name} を生成しました`, warningCount ? 'warning' : 'ok');
    else setStatus(warningCount ? `警告が ${warningCount} 件あります` : '検証に成功しました', warningCount ? 'warning' : 'ok');
  } else {
    const errorCount = diagnostics.filter((item) => item.severity === 'error').length;
    renderDiagnosticResult(report.build ? `コンパイル失敗: 全 ${report.fileCount} ファイル中 ${errorCount} 件` : `解析エラー ${errorCount} 件`, displayedDiagnostics);
    setStatus('修正が必要な問題があります', 'error');
  }
}

function scheduleValidation() {
  clearTimeout(validationTimer);
  validationTimer = setTimeout(() => validate().catch(showError), 1000);
}

async function saveAllFromMenu() {
  await saveAllScenes();
  setStatus('すべて保存しました', 'ok');
}
async function compileProjectFromMenu() {
  setStatus('全ファイルを精査してネイティブビルド中…');
  // Compilation is a durable project boundary: normalize every scene before
  // the build reads closed files, not only the scene currently in the editor.
  await formatProjectScenes();
  const report = await request('/api/project-build', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: sceneName.value }),
  });
  await validate(report);
}
const splitGroup = document.querySelector('#split-group');
const splitFrame = document.querySelector('#split-frame');
const splitTabsElement = document.querySelector('#split-tabs');
const splitResizer = document.querySelector('#split-resizer');
const editorPanel = document.querySelector('.editor-panel');
let activeSplitScene = '';
function gotoAtEvent(event) {
  const rect = editor.getBoundingClientRect();
  const style = getComputedStyle(editor);
  const lineHeight = Number.parseFloat(style.lineHeight) || editorLineHeight();
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
    const move = document.createElement('button'); move.type = 'button'; move.className = 'editor-tab-unsplit'; move.textContent = '←'; move.title = `${name}を左ペインへ移動`;
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
async function playCurrentScene() {
  await saveAllScenes();
  setStatus('native player を起動中…');
  const report = await request('/api/native-play', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: sceneName.value }),
  });
  setStatus('native player を起動しました', 'ok');
  return report;
}
async function runNativeTool(action, label) {
  setStatus(`${label}を実行中...`);
  const report = await request(`/api/native-tools/${action}`, { method: 'POST' });
  const output = String(report.output || '').slice(-30000) || `${label}が完了しました。`;
  setStatus(report.ok ? `${label}が完了しました` : `${label}に失敗しました`, report.ok ? 'ok' : 'error');
  showWorkbenchMessage(`${report.ok ? '完了' : '失敗'}: ${label}`, output);
  return report;
}
async function runNativeTestSuite() {
  await saveAllScenes();
  return runNativeTool('test', 'ビルドと全テスト');
}
function createNewSceneDraft() {
  const baseName = 'chapter-new';
  let suffix = 1;
  let name = `${baseName}.tds`;
  while (sceneNames.some((scene) => scene.toLowerCase() === name.toLowerCase())) {
    suffix++;
    name = `${baseName}-${suffix}.tds`;
  }
  sceneName.value = name;
  editor.value = `# ${name}\n\n`;
  clearEditorHistory();
  updateLineNumbers();
  updateHighlight();
  updateDirtyState(true);
  scheduleValidation();
  editor.focus();
  setStatus('\u65b0\u3057\u3044\u30b7\u30fc\u30f3\u3092\u4f5c\u6210\u3057\u307e\u3057\u305f');
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
function insertFormattedExternalText(text) {
  const normalized = String(text).replace(/\r\n?/g, '\n');
  const start = editor.selectionStart;
  const end = editor.selectionEnd;
  const source = `${editor.value.slice(0, start)}${normalized}${editor.value.slice(end)}`;
  replaceWithFormattedSource(source, start + normalized.length, start + normalized.length);
}
editor.addEventListener('paste', (event) => {
  const pasted = event.clipboardData?.getData('text/plain');
  if (pasted == null) return;
  event.preventDefault();
  insertFormattedExternalText(pasted);
});
editor.addEventListener('drop', (event) => {
  const dropped = event.dataTransfer?.getData('text/plain');
  if (!dropped) return;
  event.preventDefault();
  insertFormattedExternalText(dropped);
});
editor.addEventListener('beforeinput', (event) => {
  if (event.inputType === 'insertText' && event.data === '}' && editor.selectionStart === editor.selectionEnd) {
    const caret = editor.selectionStart;
    const lineStart = editor.value.lastIndexOf('\n', caret - 1) + 1;
    const lineEnd = editor.value.indexOf('\n', lineStart) < 0 ? editor.value.length : editor.value.indexOf('\n', lineStart);
    const beforeCaret = editor.value.slice(lineStart, caret);
    const afterCaret = editor.value.slice(caret, lineEnd);
    if (/^\s*$/.test(beforeCaret) && /^\s*$/.test(afterCaret)) {
      event.preventDefault();
      replaceWithFormattedSource(`${editor.value.slice(0, caret)}}${editor.value.slice(caret)}`, caret + 1);
      return;
    }
  }
  if (event.inputType === 'insertLineBreak') {
    event.preventDefault();
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    replaceWithFormattedSource(`${editor.value.slice(0, start)}\n${editor.value.slice(end)}`, start + 1);
    return;
  }
  if (!event.inputType?.startsWith('history')) rememberUndo();
});
editor.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  // 変数の定義・参照メニューを最優先する。構文説明は変数として
  // 解決できなかった語だけに表示し、変数の右クリックを奪わない。
  if (!showGotoMenu(event) && !showVariableTooltip(event)) showSyntaxTooltip(event);
});
document.addEventListener('click', (event) => {
  if (!variableTooltip.contains(event.target)) hideVariableTooltip();
  if (!fileContextMenu.contains(event.target)) closeFileContextMenu();
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
  if (event.key === 'Enter' && suggestions.length) {
    event.preventDefault();
    event.stopImmediatePropagation();
    acceptSuggestion();
    return;
  }
  if (suggestions.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
    event.preventDefault();
    suggestionIndex = (suggestionIndex + (event.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length;
    renderSuggestions();
    return;
  }
  if (event.key === 'Tab' && suggestions.length && !event.shiftKey) {
    event.preventDefault();
    acceptSuggestion();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key === 'Enter') {
    event.preventDefault();
    playCurrentScene().catch(showError);
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    event.preventDefault();
    compileProjectFromMenu().catch(showError);
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
    refreshCatalog().catch(showError);
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault();
    saveAllScenes().catch(showError);
    return;
  }
  if (event.key === '}' && !event.ctrlKey && !event.metaKey && !event.altKey && editor.selectionStart === editor.selectionEnd) {
    const caret = editor.selectionStart;
    const lineStart = editor.value.lastIndexOf('\n', caret - 1) + 1;
    const lineEnd = editor.value.indexOf('\n', lineStart) < 0 ? editor.value.length : editor.value.indexOf('\n', lineStart);
    const beforeCaret = editor.value.slice(lineStart, caret);
    const afterCaret = editor.value.slice(caret, lineEnd);
    if (/^\s*$/.test(beforeCaret) && /^\s*$/.test(afterCaret)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const source = `${editor.value.slice(0, caret)}}${editor.value.slice(caret)}`;
      replaceWithFormattedSource(source, caret + 1);
      return;
    }
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
      const opening = lineStart + fullLine.lastIndexOf('{');
      const hasClosingBrace = matchingClosingBrace(editor.value, opening) >= caret;
      const insertion = hasClosingBrace ? '\n' : '\n\n}';
      replaceWithFormattedSource(`${editor.value.slice(0, caret)}${insertion}${editor.value.slice(caret)}`, caret + 1);
      return;
    }
    if (trimmedLine === '}' && isChoiceOptionClose(editor.value, lineStart)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const caret = lineStart + fullLine.length;
      const insertionPoint = caret < editor.value.length && editor.value[caret] === '\n' ? caret + 1 : caret;
      const insertion = '"" {\n}\n';
      replaceWithFormattedSource(`${editor.value.slice(0, insertionPoint)}${insertion}${editor.value.slice(insertionPoint)}`, insertionPoint + 1);
      return;
    }
    const ifLine = fullLine.match(/^(\s*if(?:\s+|(?=\())[^{}]+?)\s*$/);
    if (ifLine && !trimmedLine.endsWith('{')) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const caret = lineStart + fullLine.length;
      const point = caret < editor.value.length && editor.value[caret] === '\n' ? caret + 1 : caret;
      const insertion = ' {\n\n}\n';
      replaceWithFormattedSource(`${editor.value.slice(0, point)}${insertion}${editor.value.slice(point)}`, point + 3);
      return;
    }
    if (/^(?:scene|fn|if|elif|else|for|while|character|struct)\b[\s\S]*\{\s*$/.test(trimmedLine)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const caret = lineStart + fullLine.length;
      const opening = lineStart + fullLine.lastIndexOf('{');
      const hasClosingBrace = matchingClosingBrace(editor.value, opening) >= caret;
      const insertion = hasClosingBrace ? '\n' : '\n\n}';
      replaceWithFormattedSource(`${editor.value.slice(0, caret)}${insertion}${editor.value.slice(caret)}`, caret + 1);
      return;
    }
    const structuralHeader = fullLine.match(/^\s*(?:scene\s+[A-Za-z_][A-Za-z0-9_-]*|fn\s+[A-Za-z_][A-Za-z0-9_-]*\s*\([^{}]*\)(?:\s*->\s*[A-Za-z_][A-Za-z0-9_]*(?:\s*\[\s*[A-Za-z_][A-Za-z0-9_]*\s*\])?)?|for\s+.+|while\s+.+|elif\s+.+|character\s+[A-Za-z_][A-Za-z0-9_-]*|struct\s+[A-Za-z_][A-Za-z0-9_-]*|else)\s*$/);
    if (structuralHeader) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const caret = lineStart + fullLine.length;
      const point = caret < editor.value.length && editor.value[caret] === '\n' ? caret + 1 : caret;
      const insertion = ' {\n\n}\n';
      replaceWithFormattedSource(`${editor.value.slice(0, point)}${insertion}${editor.value.slice(point)}`, point + 3);
      return;
    }
    if (/^choice(?:\s+"(?:\\.|[^"\\])*")?\s*\{\s*$/.test(trimmedLine)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const caret = lineStart + fullLine.length;
      const opening = lineStart + fullLine.lastIndexOf('{');
      const hasClosingBrace = matchingClosingBrace(editor.value, opening) >= caret;
      if (hasClosingBrace) {
        replaceWithFormattedSource(`${editor.value.slice(0, caret)}\n${editor.value.slice(caret)}`, caret + 1);
      } else {
        const block = '\n"" {\n}\n}';
        replaceWithFormattedSource(`${editor.value.slice(0, caret)}${block}${editor.value.slice(caret)}`, caret + 2);
      }
      return;
    }
    const choiceLine = fullLine.match(/^(\s*choice(?:\s+"(?:\\.|[^"\\])*"\s*)?)$/);
    if (choiceLine) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const caret = lineStart + fullLine.length;
      const block = ' {\n"" {\n}\n}\n';
      replaceWithFormattedSource(`${editor.value.slice(0, caret)}${block}${editor.value.slice(caret)}`, caret + block.indexOf('""') + 1);
      return;
    }
    // 改行後の字下げは構文成形器に任せ、カーソルも成形後の行頭へ戻す。
    event.preventDefault();
    event.stopImmediatePropagation();
    const caret = editor.selectionStart;
    replaceWithFormattedSource(`${editor.value.slice(0, caret)}\n${editor.value.slice(editor.selectionEnd)}`, caret + 1);
    return;
  }
  if (event.key === 'Enter' && suggestions.length) {
    event.preventDefault();
    acceptSuggestion();
    return;
  }
  if (event.key === 'Tab' && (event.shiftKey || editor.selectionStart !== editor.selectionEnd)) {
    event.preventDefault();
    adjustSelectionIndent(event.shiftKey);
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

function lastSceneKey() { return currentProjectRoot ? `novel-editor-last-scene:${currentProjectRoot}` : 'novel-editor-last-scene'; }
function uiAsk(message, confirmLabel = 'OK') {
  return new Promise((resolve) => {
    const box = document.createElement('div');
    box.className = 'editor-dialog';
    const label = document.createElement('div');
    label.textContent = message;
    const yes = document.createElement('button');
    yes.textContent = confirmLabel;
    const no = document.createElement('button');
    no.textContent = 'キャンセル';
    box.append(label, yes, no);
    document.body.append(box);
    yes.onclick = () => { box.remove(); resolve(true); };
    no.onclick = () => { box.remove(); resolve(false); };
  });
}
function uiConfirm(message) { return new Promise((resolve) => { const box = document.createElement('div'); box.className = 'editor-dialog workbench-dialog'; box.textContent = message; const yes = document.createElement('button'); yes.textContent = '削除'; const no = document.createElement('button'); no.textContent = 'キャンセル'; box.append(yes, no); document.body.append(box); yes.onclick = () => { box.remove(); resolve(true); }; no.onclick = () => { box.remove(); resolve(false); }; }); }
function showError(error) {
  displayRuntimeError(error);
  result.textContent = `エラー\n${error.message || error}`;
  setStatus('処理に失敗しました', 'error');
}

function displayRuntimeError(error) { const message = error?.message || String(error); let banner = document.querySelector('#runtime-error'); if (!banner) { banner = document.createElement('pre'); banner.id = 'runtime-error'; document.body.append(banner); } banner.textContent = `処理に失敗しました\n${message}`; }
function uiPrompt(message, initial = '') { return new Promise((resolve) => { const box = document.createElement('div'); box.className = 'editor-dialog workbench-dialog'; const label = document.createElement('div'); label.textContent = message; const input = document.createElement('input'); input.value = initial; const ok = document.createElement('button'); ok.textContent = '決定'; const cancel = document.createElement('button'); cancel.textContent = 'キャンセル'; box.append(label, input, ok, cancel); document.body.append(box); input.focus(); ok.onclick = () => { box.remove(); resolve(input.value); }; cancel.onclick = () => { box.remove(); resolve(''); }; input.addEventListener('keydown', (event) => { if (event.key === 'Enter') ok.click(); if (event.key === 'Escape') cancel.click(); }); }); }
window.addEventListener('error', (event) => displayRuntimeError(event.error || event.message));
window.addEventListener('unhandledrejection', (event) => displayRuntimeError(event.reason));
async function loadWorkspace(keepScene = false) {
  await Promise.all([refreshScenes(), refreshCatalog(), refreshSceneGraph()]);
  if (keepScene) return;
  openTabs.length = 0;
  splitTabs.length = 0;
  closeSplit(true);
  clearLeftEditor();
  renderEditorTabs('');
  renderSplitTabs();
  const selected = new URLSearchParams(location.search).get('scene');
  const remembered = localStorage.getItem(lastSceneKey());
  const candidate = selected || remembered;
  if (candidate && sceneNames.includes(candidate)) await openScene(candidate);
  else if (sceneNames.length) await openScene(sceneNames[0]);
}

async function postProjectOpen(folder, create) {
  const response = await fetch('/api/project/open', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: folder, create }),
  });
  const data = await response.json();
  return { ok: response.ok, status: response.status, data };
}

async function confirmProjectSwitch() {
  const splitApi = !splitGroup?.hidden ? splitFrame?.contentWindow?.novelEditorApi : null;
  if (!isDirty && !splitApi?.isDirty?.()) return true;
  return uiAsk('未保存の変更があります。作品フォルダーを切り替えますか？', '切り替える');
}

async function applyOpenedProject(info) {
  currentProjectRoot = info.projectRoot || '';
  hideProjectPicker();
  await loadWorkspace(false);
  setStatus(`${info.title || '作品'} を開きました`, 'ok');
}

async function openProjectAt(folder, create = false) {
  if (!(await confirmProjectSwitch())) return;
  const result = await postProjectOpen(folder, create);
  if (result.status === 409 && result.data.needsCreate) {
    if (!await uiAsk(`${result.data.projectRoot}\nはまだ作品フォルダーではありません。ここに新規作品を作成しますか？`, '作成する')) return;
    const created = await postProjectOpen(result.data.projectRoot, true);
    if (!created.ok) throw new Error(created.data.error || '作品を作成できませんでした。');
    await applyOpenedProject(created.data);
    return;
  }
  if (!result.ok) throw new Error(result.data.error || '作品フォルダーを開けませんでした。');
  await applyOpenedProject(result.data);
}

function hideProjectPicker() {
  document.querySelector('#project-picker')?.setAttribute('hidden', '');
}

async function renderProjectPicker(target = pickerPath) {
  const list = document.querySelector('#project-picker-list');
  const pathInput = document.querySelector('#project-picker-path');
  const recentBox = document.querySelector('#project-picker-recent');
  const title = document.querySelector('#project-picker-title');
  if (!list || !pathInput) return;
  title.textContent = pickerMode === 'create' ? '新しい作品フォルダー' : '作品フォルダーを開く';
  const browse = await request(`/api/browse?path=${encodeURIComponent(target || '')}`);
  const project = await request('/api/project');
  pickerPath = browse.path || '';
  pathInput.value = pickerPath;
  list.replaceChildren();
  if (browse.parent !== null) {
    const up = document.createElement('button');
    up.type = 'button';
    up.className = 'project-picker-item';
    up.textContent = '… 上のフォルダー';
    up.onclick = () => renderProjectPicker(browse.parent).catch(showError);
    list.append(up);
  }
  for (const entry of browse.entries || []) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'project-picker-item';
    item.textContent = `${entry.shortcut ? '☆ ' : '📁 '}${entry.name}`;
    item.title = entry.path;
    item.onclick = () => renderProjectPicker(entry.path).catch(showError);
    item.ondblclick = () => (pickerMode === 'create' ? renderProjectPicker(entry.path) : openProjectAt(entry.path, false)).catch(showError);
    list.append(item);
  }
  recentBox.replaceChildren();
  for (const folder of project.recent || []) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = folder;
    button.title = folder;
    button.onclick = () => openProjectAt(folder, false).catch(showError);
    recentBox.append(button);
  }
}

async function showProjectPicker(mode = 'open') {
  pickerMode = mode;
  const overlay = document.querySelector('#project-picker');
  if (!overlay) return;
  overlay.hidden = false;
  if (!currentProjectRoot) {
    const project = await request('/api/project');
    currentProjectRoot = project.projectRoot || '';
  }
  await renderProjectPicker(currentProjectRoot || pickerPath);
  document.querySelector('#project-picker-path')?.focus();
}

document.querySelector('#open-project')?.addEventListener('click', () => showProjectPicker('open').catch(showError));
document.querySelector('#new-project')?.addEventListener('click', () => showProjectPicker('create').catch(showError));
document.querySelector('#project-picker-close')?.addEventListener('click', hideProjectPicker);
document.querySelector('#project-picker-up')?.addEventListener('click', async () => {
  const browse = await request(`/api/browse?path=${encodeURIComponent(pickerPath || '')}`);
  await renderProjectPicker(browse.parent ?? '');
});
document.querySelector('#project-picker-go')?.addEventListener('click', () => {
  renderProjectPicker(document.querySelector('#project-picker-path')?.value || '').catch(showError);
});
document.querySelector('#project-picker-path')?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') renderProjectPicker(event.currentTarget.value || '').catch(showError);
});
document.querySelector('#project-picker-open')?.addEventListener('click', () => {
  const folder = document.querySelector('#project-picker-path')?.value || pickerPath;
  openProjectAt(folder, false).catch(showError);
});
document.querySelector('#project-picker-create')?.addEventListener('click', async () => {
  const parent = document.querySelector('#project-picker-path')?.value || pickerPath;
  const name = (await uiPrompt('新しい作品フォルダー名', 'gamesenario')).trim();
  if (!name) return;
  const folder = `${parent.replace(/[\\/]+$/, '')}/${name}`;
  openProjectAt(folder, true).catch(showError);
});
document.querySelector('#project-picker')?.addEventListener('click', (event) => {
  if (event.target.id === 'project-picker') hideProjectPicker();
});
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !document.querySelector('#project-picker')?.hidden) {
    event.preventDefault();
    hideProjectPicker();
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'o' && !event.shiftKey && !document.documentElement.classList.contains('embedded-editor')) {
    event.preventDefault();
    showProjectPicker('open').catch(showError);
  }
});

Promise.all([request('/api/project'), loadWorkspace(true)])
  .then(([project]) => {
    currentProjectRoot = project.projectRoot || '';
    setStatus('編集を開始できます', 'ok');
    const startupProjectRoot = currentProjectRoot;
    const restoreStartupScene = () => {
      if (currentProjectRoot !== startupProjectRoot || sceneName.value || isDirty) return;
      const remembered = localStorage.getItem(lastSceneKey());
      const candidate = selectedScene || remembered;
      if (candidate && sceneNames.includes(candidate)) openScene(candidate).then(() => { if (!selectedSymbol) return; const match = new RegExp(`^\\s*(?:global\\s+)?(?:int|string|str|bool|struct|const)\\s+${selectedSymbol}\\b`, 'm').exec(editor.value); if (match) revealEditorRange(match.index, match.index + selectedSymbol.length); }).catch(showError);
      else if (sceneNames.length) openScene(sceneNames[0]).catch(showError);
    };
    restoreStartupScene();
    setTimeout(restoreStartupScene, 800);
  })
  .catch(showError);
updateLineNumbers();
updateHighlight();
const selectedScene = new URLSearchParams(location.search).get('scene');
const selectedSymbol = new URLSearchParams(location.search).get('symbol');
const showHelpOnLoad = new URLSearchParams(location.search).get('help') === 'language';
if (showHelpOnLoad) setTimeout(showLanguageGuide, 100);
function revealEditorRange(start, end, lineNumber = null) {
  editor.focus(); editor.setSelectionRange(start, end);
  const line = lineNumber || editor.value.slice(0, start).split(/\r?\n/).length;
  editor.scrollTop = Math.max(0, (line - 3) * editorLineHeight());
  highlight && (highlight.scrollTop = editor.scrollTop);
  lineNumbers && (lineNumbers.scrollTop = editor.scrollTop);
}
function updateMiniMap() {
  if (!minimap || !minimapContent || !minimapViewport) return;
  const lines = editor.value.split('\n');
  minimapContent.innerHTML = lines.map((line) => highlightSource(line) || ' ').join('\n');
  // Keep short files packed at the top. When there are too many lines,
  // scale the minimap text down until every line fits in the available height.
  const baseLineHeight = 4;
  const availableHeight = Math.max(1, minimap.clientHeight);
  const miniLineHeight = Math.min(baseLineHeight, availableHeight / Math.max(1, lines.length));
  minimapContent.style.top = '0px';
  minimapContent.style.lineHeight = `${Math.max(1, miniLineHeight)}px`;
  minimapContent.style.fontSize = `${Math.max(1, Math.min(3, miniLineHeight * 0.72))}px`;
  minimapContent.style.minHeight = '0px';
  const max = Math.max(1, editor.scrollHeight - editor.clientHeight);
  const ratio = editor.clientHeight / Math.max(editor.scrollHeight, editor.clientHeight);
  const height = Math.max(24, minimap.clientHeight * ratio);
  minimapViewport.style.height = `${height}px`;
  minimapViewport.style.top = `${(editor.scrollTop / max) * Math.max(0, minimap.clientHeight - height)}px`;
}
function updateHighlight() {
  if (!highlight) return;
  const lines = editor.value.split('\n');
  const visible = diagnostics.filter(diagnosticForCurrentFile);
  const byLine = new Map();
  const unreachableLines = new Set();
  for (const item of visible) {
    const line = Number(item.line) || 1;
    const previous = byLine.get(line);
    if (!previous || ({ error: 3, warning: 2, info: 1 }[item.severity] || 0) > ({ error: 3, warning: 2, info: 1 }[previous.severity] || 0)) byLine.set(line, item);
    if (String(item.code || '').startsWith('unreachable')) diagnosticLineRange(item).forEach((value) => unreachableLines.add(value));
  }
  for (const item of visible.filter((entry) => entry.code === 'unreachable-scene')) {
    const start = Math.max(0, Number(item.line) - 1);
    const next = lines.findIndex((line, index) => index > start && /^\s*scene\s+[A-Za-z_][A-Za-z0-9_]*\s*\{/.test(line));
    const end = next < 0 ? lines.length : next;
    for (let index = start; index < end; index += 1) unreachableLines.add(index + 1);
  }
  highlight.innerHTML = lines.map((line, index) => {
    const lineNumber = index + 1;
    const item = byLine.get(lineNumber);
    const classes = ['hl-line'];
    if (item) classes.push(`hl-${item.severity}`);
    if (unreachableLines.has(lineNumber)) classes.push('hl-unreachable');
    return `<span class="${classes.join(' ')}">${highlightSource(line) || ' '}</span>`;
  }).join('\n');
  updateMiniMap();
}
const dirtyStyle=document.createElement('style');dirtyStyle.textContent='.dirty-mark{display:none!important;background:transparent!important;width:auto!important;height:auto!important}.dirty-mark.visible{display:inline-block!important}.dirty-mark.visible:after{content:"•";color:#fff;font-size:13px;margin-left:4px}.document-title input{width:120px}.scene-file.file-dirty:after{position:static;margin-left:5px;color:#fff;font-size:13px}';document.head.append(dirtyStyle);
const thinDiagnosticStyle=document.createElement('style');thinDiagnosticStyle.textContent='.hl-error,.hl-warning,.hl-info{text-decoration-line:underline;text-decoration-style:wavy;text-decoration-thickness:1px!important;background:transparent!important}.hl-error{text-decoration-color:#e85b68!important}.hl-warning{text-decoration-color:#e3b35c!important}.hl-info{text-decoration-color:#6aa9d8!important}.status-chip.warning .status-dot{background:#e3b35c}';document.head.append(thinDiagnosticStyle);
highlight?.addEventListener('mouseover', (event) => { const line = event.target.closest('.hl-error,.hl-warning,.hl-info'); if (line) { const lineNumber = [...highlight.children].indexOf(line) + 1; line.title = diagnostics.filter(diagnosticForCurrentFile).filter((item) => Number(item.line) === lineNumber).map((item) => `${item.severity}: ${item.message}`).join('\n'); } });
const syntaxHints = {
  asset: 'asset <種類> <名前> = "パス"',
  character: 'character <名前> {\n  name = "表示名"\n  affection = 0\n  pose normal = "画像パス"\n}',
  struct: 'struct <名前> { field: int | str }',
  int: 'int <名前> = <整数>',
  str: 'str <名前> = "文字列"',
  dict: 'dict[int|str] <名前> = { "key": <値> }',
  const: 'const int|str|dict <名前> = <値>',
  global: 'global int|str|dict|const <名前> = <値>',
  set: 'set <既存の変数> = <値>',
  say: 'say "文字列リテラル" または say <話者> <str式>（本文は必須）',
  bg: 'bg <背景アセット>', bgm: 'bgm <BGMアセット>', se: 'play se <SEアセット>',
  show: 'show <名前>.<ポーズ> <位置> [fade <ミリ秒>]', hide: 'hide <名前> [fade <ミリ秒>]',
  if: 'if <条件> { ... } else { ... }', elif: 'elif <条件> { ... }', else: 'else { ... }',
  for: 'for <変数> from <開始> to <終了> [step <幅>] { ... }',
  while: 'while <条件> { ... }', choice: 'choice "質問" { "選択肢" { ... } }',
  fn: 'fn <名前>(<引数>: <型>) -> <戻り値> { ... }', return: 'return [値]', goto: 'goto <シーン>',
  wait: 'wait <ミリ秒>', effect: 'effect fade <色> [ミリ秒]', play: 'play <種類> <アセット>'
};
const syntaxRecipes = {
  asset: { description: '素材ファイルを名前で呼べるようにします。パスを書くのはこの宣言時だけです。', snippet: 'asset bg background = "asset/bg/¦.png"\n' },
  character: { description: '立ち絵とポーズをまとめて定義します。', snippet: 'character hero {\n  name = "主人公"\n  pose normal = "asset/char/hero/¦.png"\n}\n' },
  int: { description: '整数のローカル変数です。ファイル間で共有するなら global を付けます。', snippet: 'int count = ¦0\n' },
  str: { description: '文字列のローカル変数です。', snippet: 'str name = "¦"\n' },
  global: { description: '複数ファイルから参照できる共有変数です。トップレベルで宣言します。', snippet: 'global int score = ¦0\n' },
  say: { description: '話者を省略できるのは本文が文字列リテラルの場合だけです。変数や関数呼び出しを本文にする場合は話者を書きます。', snippet: 'say narrator "¦本文"\n' },
  bg: { description: 'asset bg で宣言済みの背景名を指定します。ここではパスを直接書きません。', snippet: 'bg ¦background\n' },
  bgm: { description: 'asset bgm で宣言済みの BGM 名を指定します。', snippet: 'bgm ¦music\n' },
  show: { description: 'character の pose を表示します。位置は far_left / left / center / right / far_right を使えます。', snippet: 'show hero.normal center¦\n' },
  hide: { description: '表示中の立ち絵を消します。', snippet: 'hide ¦hero\n' },
  if: { description: '条件が真のときだけブロックを実行します。', snippet: 'if ¦condition {\n  \n}\n' },
  for: { description: '開始から終了まで繰り返します。step は省略できます。', snippet: 'for i from 0 to ¦10 {\n  \n}\n' },
  while: { description: '条件が真の間、ブロックを繰り返します。', snippet: 'while ¦condition {\n  \n}\n' },
  choice: { description: '選択肢ごとに実行する処理を書きます。', snippet: 'choice "質問" {\n  "¦選択肢" {\n    \n  }\n}\n' },
  goto: { description: '同一ファイルのシーン、または引用符付きの外部ファイルへ遷移します。', snippet: 'goto ¦next_scene\n' },
  fn: { description: '再利用できる関数を定義します。', snippet: 'fn name() {\n  ¦\n}\n' },
};
editor.addEventListener('mousemove', (event) => {
  const line = Math.floor((event.offsetY - 21) / editorLineHeight()) + 1;
  const errorText = diagnostics.filter(diagnosticForCurrentFile).filter((item) => Number(item.line) === line).map((item) => `${item.severity}: ${item.message}`).join('\n');
  if (errorText) { editor.title = errorText; return; }
  editor.title = '';
});
window.addEventListener('pagehide', () => {
  if (!isDirty || !sceneName.value) return;
  const source = formatSource(editor.value);
  fetch('/api/scene', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: sceneName.value, source }),
    keepalive: true,
  }).catch(() => {});
});
const fileDirtyStyle=document.createElement('style');fileDirtyStyle.textContent='.scene-file{position:relative;padding-right:22px}.scene-file.file-dirty:after{content:"•";position:absolute;top:50%;right:8px;transform:translateY(calc(-50% + 1px));color:#fff;font-size:16px;line-height:1}';document.head.append(fileDirtyStyle);
const highlightSpacingStyle=document.createElement('style');highlightSpacingStyle.textContent='#highlight{font-size:var(--editor-font-size);line-height:var(--editor-line-height)}.hl-line{font-size:var(--editor-font-size);line-height:var(--editor-line-height)}';document.head.append(highlightSpacingStyle);
const explorerOnlyDirtyStyle=document.createElement('style');explorerOnlyDirtyStyle.textContent='.document-title .dirty-mark{display:none!important}';document.head.append(explorerOnlyDirtyStyle);
function isChoiceOptionClose(source, lineStart) { const before = source.slice(0, lineStart); const choiceStart = before.lastIndexOf('choice '); if (choiceStart < 0) return false; const part = before.slice(choiceStart); const depth = (part.match(/\{/g) || []).length - (part.match(/\}/g) || []).length; return depth === 2; }
const indentGuideStyle=document.createElement('style');indentGuideStyle.textContent='#highlight{background-image:repeating-linear-gradient(to right,transparent 0,transparent 27px,rgba(150,170,190,.24) 27px,rgba(150,170,190,.24) 28px);background-position:25px 0;background-size:28px 100%;background-repeat:repeat-y}';document.head.append(indentGuideStyle);
const stableGuideStyle=document.createElement('style');stableGuideStyle.textContent='#highlight{background-image:none!important}#line-numbers{position:relative;border-right:1px solid #34404d!important;box-shadow:inset -1px 0 #0a0d12;background-image:repeating-linear-gradient(to right,transparent 0,transparent 24px,rgba(150,170,190,.2) 24px,rgba(150,170,190,.2) 25px);background-size:28px 100%;background-repeat:repeat-y}';document.head.append(stableGuideStyle);
const noIndentGuideStyle=document.createElement('style');noIndentGuideStyle.textContent='#highlight,#line-numbers{background-image:none!important;box-shadow:none!important}';document.head.append(noIndentGuideStyle);
const calmSuggestionStyle=document.createElement('style');calmSuggestionStyle.textContent='.suggestion.active{color:#e3edf4!important;background:#314452!important}.suggestion{color:#aebdca!important}.suggestion:hover{background:#263844!important;color:#eef5f8!important}';document.head.append(calmSuggestionStyle);

function showWorkbenchMessage(title, message) {
  document.querySelector('.workbench-message')?.remove();
  const dialog = document.createElement('div');
  dialog.className = 'editor-dialog workbench-message';
  const heading = document.createElement('strong');
  heading.textContent = title;
  const copy = document.createElement('div');
  copy.className = 'workbench-message-copy';
  copy.textContent = message;
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = '閉じる';
  close.addEventListener('click', () => dialog.remove());
  dialog.append(heading, copy, close);
  document.body.append(dialog);
  close.focus();
}
function showLanguageGuide() {
  document.querySelector('.workbench-message')?.remove();
  const dialog = document.createElement('section'); dialog.className = 'editor-dialog workbench-message language-guide';
  const heading = document.createElement('strong'); heading.textContent = '.tds 構文リファレンス';
  const close = document.createElement('button'); close.type = 'button'; close.className = 'guide-close'; close.setAttribute('aria-label', '閉じる'); close.textContent = '×'; close.onclick = () => dialog.remove();
  dialog.append(heading, close);
  const sections = [
    ['素材を宣言する', 'asset bg classroom = "asset/bg/classroom.png"\nasset bgm morning = "asset/bgm/morning.ogg"', '素材のパスは宣言時に一度だけ指定します。以後は classroom のような名前を使います。', 'asset'],
    ['背景・音・立ち絵', 'bg classroom\nbgm morning\nshow hero.normal center\nhide hero', 'bg / bgm には、対応する asset 宣言の名前を指定します。', 'bg'],
    ['台詞', 'say narrator "こんにちは"\nsay "話者を省略した台詞"', '話者を省略できるのは本文が文字列リテラルの場合だけです。', 'say'],
    ['変数と共有変数', 'int score = 0\nstr name = "主人公"\nglobal int route = 0', 'global はファイルをまたいで共有します。ローカル変数と同じ名前にはできません。', 'global'],
    ['構造体（struct）', 'struct Player {\n  name: str\n  coins: int\n}\n\nPlayer player = { "name": "ユイ", "coins": 0 }\nset player.coins = player.coins + 10', '複数の固定フィールドを一つの値にまとめる型です。使う前にトップレベルで宣言し、フィールドは int / str で定義します。変数の宣言時は、すべてのフィールドを辞書形式で指定します。', 'struct'],
    ['構造体のコピーと更新', 'Player copy = { "name": "", "coins": 0 }\nset copy = player\nset copy.coins = copy.coins + 10', '構造体の代入はコピーです。別の構造体値や関数の戻り値を受け取るときも、まず { ... } で初期化してから set を使います。フィールドの追加・unset・構造体の入れ子はできません。', 'struct'],
    ['条件と繰り返し', 'if score >= 10 {\n  say narrator "合格"\n} else {\n  say narrator "もう一度"\n}', 'ブロックは { と } で囲みます。', 'if'],
    ['選択肢', 'choice "どうする？" {\n  "進む" {\n    goto next_scene\n  }\n}', '各選択肢の中に実行したい処理を書きます。', 'choice'],
    ['シーン遷移と関数', 'goto next_scene\n\nfn greet() {\n  say narrator "こんにちは"\n}', 'goto はシーン名へ遷移し、fn は処理を再利用するための定義です。', 'goto'],
  ];
  sections.forEach(([title, body, descriptionText]) => { const block = document.createElement('details'); block.className = 'guide-section'; const summary = document.createElement('summary'); summary.textContent = title; const description = document.createElement('p'); description.textContent = descriptionText; const pre = document.createElement('pre'); pre.textContent = body; block.append(summary, description, pre); dialog.append(block); });
  document.body.append(dialog); close.focus();
}
async function showProjectSettings() {
  document.querySelector('.project-settings')?.remove();
  const [project, variableData, assetData, playerUi] = await Promise.all([
    request('/api/project'), request('/api/variables'), request('/api/assets'), request('/api/player-ui'),
  ]);
  const dialog = document.createElement('section');
  dialog.className = 'editor-dialog project-settings';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  const heading = document.createElement('strong');
  heading.textContent = '作品設定';
  const close = document.createElement('button');
  close.type = 'button'; close.className = 'project-settings-close'; close.textContent = '×'; close.setAttribute('aria-label', '閉じる');
  close.addEventListener('click', () => dialog.remove());
  const path = document.createElement('p');
  path.className = 'project-settings-path'; path.textContent = project.projectRoot || '';
  const basic = document.createElement('section');
  basic.className = 'project-settings-section';
  const basicTitle = document.createElement('h2'); basicTitle.textContent = '基本設定';
  const fields = {};
  const field = (labelText, name, value, editable = true) => {
    const label = document.createElement('label'); label.textContent = labelText;
    const input = document.createElement('input'); input.name = name; input.value = value || ''; input.readOnly = !editable;
    label.append(input); basic.append(label); fields[name] = input;
  };
  field('作品タイトル', 'title', project.settings?.title || project.title);
  field('開始シーン', 'start_file', project.settings?.start_file || 'main.tds');
  field('シナリオフォルダー', 'scenario_dir', project.settings?.scenario_dir || '');
  field('素材フォルダー', 'asset_dir', project.settings?.asset_dir || '');
  field('再生機UIテーマ', 'native_ui_theme', project.settings?.native_ui_theme || '');
  const basicNote = document.createElement('p'); basicNote.className = 'project-settings-note'; basicNote.textContent = 'フォルダー名を変更しても既存ファイルは移動しません。先にファイルを移動してから変更してください。';
  basic.append(basicNote);
  basic.prepend(basicTitle);
  const player = document.createElement('section');
  player.className = 'project-settings-section';
  const playerTitle = document.createElement('h2'); playerTitle.textContent = '再生機UI';
  const playerFields = {};
  const playerField = (labelText, name, value, type = 'text', parent = player) => {
    const label = document.createElement('label'); label.textContent = labelText;
    const input = document.createElement('input'); input.name = name; input.type = type; input.value = value;
    label.append(input); parent.append(label); playerFields[name] = input;
  };
  const sourceTheme = playerUi.theme;
  const theme = sourceTheme;
  const rgba = (value) => value.join(',');
  const integer = (name) => Number(playerFields[name].value);
  const playerGroup = (title) => {
    const group = document.createElement('section'); group.className = 'player-ui-settings-group';
    const groupTitle = document.createElement('h3'); groupTitle.textContent = title;
    group.append(groupTitle); player.append(group); return group;
  };
  const screenGroup = playerGroup('論理画面');
  playerField('画面幅', 'screen_width', theme.screen.width, 'number', screenGroup);
  playerField('画面高さ', 'screen_height', theme.screen.height, 'number', screenGroup);
  const dialogGroup = playerGroup('会話欄（画面基準）');
  playerField('会話欄画像', 'dialog_image', theme.dialog.image, 'text', dialogGroup);
  playerField('会話欄 X', 'dialog_x', theme.dialog.x ?? Math.round((1280 - theme.dialog.width) / 2), 'number', dialogGroup);
  playerField('会話欄 Y', 'dialog_y', theme.dialog.y, 'number', dialogGroup);
  playerField('会話欄幅', 'dialog_width', theme.dialog.width, 'number', dialogGroup);
  playerField('会話欄高さ', 'dialog_height', theme.dialog.height, 'number', dialogGroup);
  const messageGroup = playerGroup('本文（会話欄基準）');
  playerField('本文 X', 'dialog_text_x', theme.dialog.message.x, 'number', messageGroup); playerField('本文 Y', 'dialog_text_y', theme.dialog.message.y, 'number', messageGroup); playerField('本文幅', 'dialog_text_width', theme.dialog.message.width, 'number', messageGroup); playerField('本文高さ', 'dialog_text_height', theme.dialog.message.height, 'number', messageGroup); playerField('本文サイズ', 'dialog_text_size', theme.dialog.message.size, 'number', messageGroup); playerField('本文色 RGBA', 'dialog_text_color', rgba(theme.dialog.message.color), 'text', messageGroup);
  const speakerGroup = playerGroup('話者欄（会話欄基準）');
  playerField('話者欄画像', 'speaker_image', theme.dialog.nameplate.image, 'text', speakerGroup); playerField('話者欄 X', 'speaker_x', theme.dialog.nameplate.x, 'number', speakerGroup); playerField('話者欄 Y', 'speaker_y', theme.dialog.nameplate.y, 'number', speakerGroup); playerField('話者欄幅', 'speaker_width', theme.dialog.nameplate.width, 'number', speakerGroup); playerField('話者欄高さ', 'speaker_height', theme.dialog.nameplate.height, 'number', speakerGroup); playerField('話者名サイズ', 'speaker_size', theme.dialog.nameplate.text.size, 'number', speakerGroup); playerField('話者名色 RGBA', 'speaker_color', rgba(theme.dialog.nameplate.text.color), 'text', speakerGroup);
  const choiceGroup = playerGroup('選択肢（画面基準）');
  playerField('選択肢画像', 'choice_image', theme.choices.image, 'text', choiceGroup); playerField('選択中画像', 'choice_active_image', theme.choices.activeImage, 'text', choiceGroup); playerField('選択肢 X', 'choice_x', theme.choices.x, 'number', choiceGroup); playerField('選択肢 Y', 'choice_y', theme.choices.y, 'number', choiceGroup); playerField('表示幅', 'choice_width', theme.choices.width, 'number', choiceGroup); playerField('表示高さ', 'choice_view_height', theme.choices.height, 'number', choiceGroup); playerField('項目高さ', 'choice_height', theme.choices.itemHeight, 'number', choiceGroup); playerField('項目間隔', 'choice_gap', theme.choices.gap, 'number', choiceGroup); playerField('本文 X', 'choice_text_x', theme.choices.text.x, 'number', choiceGroup); playerField('本文 Y', 'choice_text_y', theme.choices.text.y, 'number', choiceGroup); playerField('本文サイズ', 'choice_text_size', theme.choices.text.size, 'number', choiceGroup); playerField('本文色 RGBA', 'choice_text_color', rgba(theme.choices.text.color), 'text', choiceGroup);
  const fogLabel = document.createElement('label'); fogLabel.textContent = '下部の霧';
  const fog = document.createElement('input'); fog.type = 'checkbox'; fog.checked = Boolean(theme.screen.backdrop?.bottomFog?.enabled); fogLabel.append(fog); player.append(fogLabel);
  playerField('靄の色 RGBA', 'fog_color', rgba(theme.screen.backdrop?.bottomFog?.color || [255, 250, 253, 255]));
  playerField('靄の高さ', 'fog_height', theme.screen.backdrop?.bottomFog?.height ?? 300, 'number');
  const preview = document.createElement('div'); preview.className = 'player-ui-preview'; preview.setAttribute('aria-label', '再生機UI配置プレビュー');
  const previewDialog = document.createElement('div'); previewDialog.className = 'player-ui-preview-dialog';
  const themeDirectory = String(project.settings?.native_ui_theme || '').replaceAll('\\', '/').split('/').slice(0, -1).join('/');
  const previewAsset = (name) => `url(/asset/${[themeDirectory, name].filter(Boolean).map(encodeURIComponent).join('/')})`;
  const previewText = document.createElement('span'); previewText.className = 'player-ui-preview-message'; previewText.textContent = 'ここに本文が表示されます。';
  const previewSpeaker = document.createElement('span'); previewSpeaker.className = 'player-ui-preview-speaker'; previewSpeaker.textContent = '話者名';
  const previewChoice = document.createElement('span'); previewChoice.className = 'player-ui-preview-choice'; previewChoice.textContent = '選択肢';
  const resize = document.createElement('button'); resize.type = 'button'; resize.className = 'player-ui-preview-resize'; resize.setAttribute('aria-label', '会話欄の大きさを変更');
  previewDialog.append(previewText, previewSpeaker, resize); preview.append(previewDialog, previewChoice); player.append(preview);
  const renderPreview = () => {
    const scale = preview.clientWidth / integer('screen_width');
    preview.style.height = `${integer('screen_height') * scale}px`;
    previewDialog.style.left = `${integer('dialog_x') * scale}px`;
    previewDialog.style.top = `${integer('dialog_y') * scale}px`;
    previewDialog.style.width = `${integer('dialog_width') * scale}px`;
    previewDialog.style.height = `${integer('dialog_height') * scale}px`;
    previewDialog.style.backgroundImage = previewAsset(playerFields.dialog_image.value);
    Object.assign(previewText.style, { left: `${integer('dialog_text_x') * scale}px`, top: `${integer('dialog_text_y') * scale}px`, width: `${integer('dialog_text_width') * scale}px`, height: `${integer('dialog_text_height') * scale}px`, fontSize: `${integer('dialog_text_size') * scale}px`, color: `rgba(${playerFields.dialog_text_color.value})` });
    Object.assign(previewSpeaker.style, { left: `${integer('speaker_x') * scale}px`, top: `${integer('speaker_y') * scale}px`, width: `${integer('speaker_width') * scale}px`, height: `${integer('speaker_height') * scale}px`, fontSize: `${integer('speaker_size') * scale}px`, color: `rgba(${playerFields.speaker_color.value})`, backgroundImage: previewAsset(playerFields.speaker_image.value) });
    Object.assign(previewChoice.style, { left: `${integer('choice_x') * scale}px`, top: `${integer('choice_y') * scale}px`, width: `${integer('choice_width') * scale}px`, height: `${integer('choice_height') * scale}px`, fontSize: `${integer('choice_text_size') * scale}px`, color: `rgba(${playerFields.choice_text_color.value})`, backgroundImage: previewAsset(playerFields.choice_image.value) });
  };
  Object.values(playerFields).forEach((input) => input.addEventListener('input', renderPreview));
  const drag = (event, resizing) => {
    event.preventDefault();
    const box = preview.getBoundingClientRect(); const scale = box.width / integer('screen_width');
    const originX = integer('dialog_x'), originY = integer('dialog_y'), originWidth = integer('dialog_width'), originHeight = integer('dialog_height');
    const startX = event.clientX, startY = event.clientY;
    const move = (pointer) => {
      const dx = Math.round((pointer.clientX - startX) / scale), dy = Math.round((pointer.clientY - startY) / scale);
      if (resizing) { playerFields.dialog_width.value = Math.max(80, originWidth + dx); playerFields.dialog_height.value = Math.max(40, originHeight + dy); }
      else { playerFields.dialog_x.value = Math.max(0, Math.min(integer('screen_width') - originWidth, originX + dx)); playerFields.dialog_y.value = Math.max(0, Math.min(integer('screen_height') - originHeight, originY + dy)); }
      renderPreview();
    };
    const stop = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', stop, { once: true });
  };
  previewDialog.addEventListener('pointerdown', (event) => drag(event, event.target === resize));
  requestAnimationFrame(renderPreview);
  const variables = document.createElement('section');
  variables.className = 'project-settings-section';
  const variableTitle = document.createElement('h2'); variableTitle.textContent = '共有変数';
  const variableList = document.createElement('div'); variableList.className = 'project-settings-list';
  const staticVariables = Array.isArray(variableData.staticVariables) ? variableData.staticVariables : [];
  if (staticVariables.length) {
    staticVariables.forEach((item) => {
      const row = document.createElement('div'); row.className = 'project-settings-row';
      row.textContent = item.name + ': ' + item.type + ' = ' + JSON.stringify(item.value);
      variableList.append(row);
    });
  } else {
    const empty = document.createElement('div'); empty.className = 'project-settings-empty'; empty.textContent = '設定済みの共有変数はありません。';
    variableList.append(empty);
  }
  const variableNote = document.createElement('p'); variableNote.className = 'project-settings-note'; variableNote.textContent = '共有変数は .novel/variables.json で管理されます。';
  variables.append(variableTitle, variableList, variableNote);
  const assets = document.createElement('section');
  assets.className = 'project-settings-section';
  const assetTitle = document.createElement('h2'); assetTitle.textContent = '素材';
  const assetList = document.createElement('div'); assetList.className = 'project-settings-list project-assets-list';
  const listedAssets = Array.isArray(assetData.assets) ? assetData.assets : [];
  const assetDirectory = String(project.settings?.asset_dir || 'asset').replaceAll('\\', '/').replace(/\/$/, '');
  if (listedAssets.length) {
    listedAssets.forEach((asset) => {
      const row = document.createElement('button'); row.type = 'button'; row.className = 'project-settings-row project-asset-row';
      row.textContent = asset.type + '  ' + asset.name + (asset.pose ? '.' + asset.pose : '') + '  —  ' + asset.path;
      row.title = asset.path;
      row.addEventListener('click', () => {
        const source = String(asset.path).replaceAll('\\', '/');
        const prefix = assetDirectory + '/';
        const relative = source.startsWith(prefix) ? source.slice(prefix.length) : source;
        window.open('/asset/' + relative.split('/').map(encodeURIComponent).join('/'), '_blank', 'noopener');
      });
      assetList.append(row);
    });
  } else {
    const empty = document.createElement('div'); empty.className = 'project-settings-empty'; empty.textContent = '登録済みの素材はありません。';
    assetList.append(empty);
  }
  const assetNote = document.createElement('p'); assetNote.className = 'project-settings-note'; assetNote.textContent = '素材は asset フォルダーに置き、.tds の asset / character / pose 宣言で登録します。クリックするとプレビューを開きます。';
  const checkImages = document.createElement('button'); checkImages.type = 'button'; checkImages.className = 'project-settings-save'; checkImages.textContent = '画像読込を検証'; checkImages.addEventListener('click', () => saveAllScenes().then(() => runNativeTool('images', '画像読込を検証')).catch(showError));
  assets.append(assetTitle, assetList, assetNote, checkImages);
  const footer = document.createElement('footer');
  const save = document.createElement('button'); save.type = 'button'; save.className = 'project-settings-save'; save.textContent = '作品・再生機UI設定を保存';
  save.addEventListener('click', async () => {
    const updated = await request('/api/project/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.fromEntries(Object.entries(fields).map(([name, input]) => [name, input.value]))),
    });
    const rgbaValue = (name) => playerFields[name].value.split(',').map((part) => Number(part.trim()));
    await request('/api/player-ui', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ theme: {
      version: 1, screen: { width: integer('screen_width'), height: integer('screen_height'), backdrop: { bottomFog: { enabled: fog.checked, color: rgbaValue('fog_color'), height: integer('fog_height') } } },
      dialog: { image: playerFields.dialog_image.value, x: integer('dialog_x'), y: integer('dialog_y'), width: integer('dialog_width'), height: integer('dialog_height'), message: { x: integer('dialog_text_x'), y: integer('dialog_text_y'), width: integer('dialog_text_width'), height: integer('dialog_text_height'), size: integer('dialog_text_size'), color: rgbaValue('dialog_text_color') }, nameplate: { x: integer('speaker_x'), y: integer('speaker_y'), width: integer('speaker_width'), height: integer('speaker_height'), image: playerFields.speaker_image.value, text: { x: 0, y: 0, width: integer('speaker_width'), height: integer('speaker_height'), size: integer('speaker_size'), color: rgbaValue('speaker_color') } } },
      choices: { x: integer('choice_x'), y: integer('choice_y'), width: integer('choice_width'), height: integer('choice_view_height'), itemHeight: integer('choice_height'), gap: integer('choice_gap'), image: playerFields.choice_image.value, activeImage: playerFields.choice_active_image.value, text: { x: integer('choice_text_x'), y: integer('choice_text_y'), width: integer('choice_width') - integer('choice_text_x') * 2, height: integer('choice_height'), size: integer('choice_text_size'), color: rgbaValue('choice_text_color') } },
    } }) });
    currentProjectRoot = updated.projectRoot || currentProjectRoot;
    await Promise.all([refreshFiles(), refreshCatalog(), refreshScenes()]);
    setStatus('作品設定を保存しました', 'ok');
    dialog.remove();
  });
  footer.append(save);
  dialog.append(heading, close, path, basic, player, variables, assets, footer);
  document.body.append(dialog);
  close.focus();
}
function guideDescription(title) { const descriptions = { 'シーン': 'scene から始まり、インデントされた命令を上から順に実行します。ファイル名ではなくシーン名を遷移先に使います。', '台詞とコメント': 'say は話者名と文字列を受け取り、画面に台詞を表示します。# 以降はコメントとして無視されます。', '変数について': '変数は型を持ち、宣言後に代入できます。const は再代入できません。', '構造体について': 'struct は複数のフィールドをひとつの値にまとめる型です。フィールド名で値へアクセスします。', 'global 変数': 'global はファイルをまたいで共有する宣言です。関数や分岐ブロックの内部では宣言できません。', '条件分岐': '条件式が true のとき if ブロックを実行し、それ以外は else を実行します。', '繰り返し': 'while は条件が true の間、ブロックを繰り返します。ループ内で値を更新してください。', '選択肢': 'choice の各選択肢は表示文字列と goto 先を対応付けます。', 'シーン遷移': 'goto は指定したシーンへ移動し、return は呼び出し元へ戻ります。', '式と演算子': '数値・文字列・真偽値を組み合わせて式を作れます。型が合わない演算は診断されます。', '素材': '素材パスは asset フォルダーを基準に指定します。存在しない素材はコンパイル時に検出されます。', '構文解析': '入力中は字句解析、構文解析、型チェックが順番に実行され、該当箇所へ診断が表示されます。' }; return descriptions[title] || ''; }

function showLanguageGuide() {
  document.querySelector('.workbench-message')?.remove();
  const dialog = document.createElement('section');
  dialog.className = 'editor-dialog workbench-message language-guide';
  const heading = document.createElement('strong'); heading.textContent = '.tds 構文ヘルプ';
  const close = document.createElement('button'); close.type = 'button'; close.className = 'guide-close'; close.setAttribute('aria-label', 'ヘルプを閉じる'); close.textContent = '×'; close.onclick = () => dialog.remove();
  const intro = document.createElement('p'); intro.className = 'guide-intro'; intro.textContent = '例を貼り付けて編集できます。保存・コンパイル時には構文、型、変数、素材、シーン遷移まで検証されます。';
  const reference = document.createElement('a'); reference.href = '/docs/tds-language-and-editor-guide.md'; reference.target = '_blank'; reference.rel = 'noopener'; reference.className = 'guide-reference'; reference.textContent = '詳しい構文リファレンスを開く';
  const sections = [
    ['最小のシーン', 'scene main {\n  say narrator "こんにちは"\n  goto next\n}\n\nscene next {\n  say narrator "次の場面"\n}', 'sceneで始まり、{ }の中を上から実行します。インデントは半角スペース2個が標準です。'],
    ['素材と立ち絵', 'asset bg classroom = "asset/bg/classroom.png"\n\ncharacter hero {\n  name = "主人公"\n  pose normal = "asset/char/hero/normal.png"\n}\n\nscene main {\n  bg classroom\n  show hero.normal center\n}', 'assetで素材を登録し、シーンでは登録名を使います。showは character.pose と位置を指定します。'],
    ['台詞と変数', 'int score = 0\nstr route = "common"\n\nset score = score + 1\nsay narrator "点数: {score}"\nsay "話者を省略すると narrator"', '変数には型と初期値が必要です。constは変更できません。文字列補間は {式} で書きます。'],
    ['分岐・ループ', 'if score >= 10 {\n  say narrator "成功"\n} else {\n  say narrator "もう一度"\n}\n\nfor i from 0 to 3 step 1 {\n  say narrator "{i}"\n}', 'if/elif/else、for、whileを使えます。ループは値が変化し、実行回数が過大にならないようにします。'],
    ['選択肢', 'choice "どうする？" {\n  "進む" {\n    goto next\n  }\n  "待つ" {\n    wait 500\n  }\n}', 'choiceの各ラベルの中に処理を書きます。プロンプトは省略できます。'],
    ['演出', 'bg classroom\nbgm morning\nshow hero.smile left fade 250\nplay se door\nplay voice greeting blocking\neffect fade black 300\nclear bgm', '時間はミリ秒の非負整数です。voice/videoはblockingなら完了を待ち、asyncなら進行を止めません。'],
    ['エディタ操作', 'Ctrl+S       保存\nCtrl+Z/Y      Undo / Redo\nCtrl+Shift+F  現在シーンを整形\nTab           選択範囲をインデント\nShift+Tab     選択範囲を逆インデント', '整形は2スペース、演算子の空白、辞書とブロックの判別、改行コードを統一します。'],
    ['困ったとき', '赤い診断: 先に修正する\n黄色い警告: 意図した演出か確認\n素材エラー: asset宣言とファイルを確認\n同じ位置の警告: showの位置を分ける\n保存競合: シーンを再読み込みして差分を確認', 'IDE、Browser、Nativeは同じコンパイラの診断を共有します。'],
  ];
  dialog.append(heading, close, intro, reference);
  sections.forEach(([title, body, descriptionText], index) => {
    const block = document.createElement('details'); block.className = 'guide-section'; if (index === 0) block.open = true;
    const summary = document.createElement('summary'); summary.textContent = title;
    const description = document.createElement('p'); description.textContent = descriptionText;
    const pre = document.createElement('pre'); pre.textContent = body;
    block.append(summary, description, pre); dialog.append(block);
  });
  document.body.append(dialog); close.focus();
}

function selectCurrentLine() {
  const start = editor.value.lastIndexOf('\n', Math.max(0, editor.selectionStart - 1)) + 1;
  const next = editor.value.indexOf('\n', editor.selectionEnd);
  editor.setSelectionRange(start, next < 0 ? editor.value.length : next);
  editor.focus();
}

const searchView = document.querySelector('.search-view');
const searchInput = document.querySelector('#project-search-input');
const searchSummary = document.querySelector('#search-summary');
const searchResults = document.querySelector('#search-results');
const searchOptions = new Set();
let searchTimer = null;
let searchSequence = 0;
const sceneFlowHost = document.querySelector('#scene-flow-host');
const sceneFlowFrame = document.querySelector('#scene-flow-frame');
function hideSceneFlowView() {
  if (sceneFlowHost) sceneFlowHost.hidden = true;
}
function showSceneFlowView() {
  closeMenus();
  if (!sceneFlowHost || !sceneFlowFrame) return;
  sceneFlowHost.hidden = false;
  document.querySelectorAll('.activity-button').forEach((button) => button.classList.toggle('active', button.dataset.activity === 'flow'));
  if (!sceneFlowFrame.src) {
    const flowUrl = new URL('/flow.html', location.origin);
    if (new URLSearchParams(location.search).has('desktop')) flowUrl.searchParams.set('desktop', '1');
    sceneFlowFrame.src = flowUrl.href;
  }
  notifySceneFlowRefresh();
}
window.addEventListener('message', (event) => {
  if (event.origin !== location.origin || event.source !== sceneFlowFrame?.contentWindow) return;
  const message = event.data;
  if (!message || typeof message !== 'object') return;
  if (message.type === 'scene-flow:view' && message.view === 'explorer') {
    hideSceneFlowView();
    activateExplorerView();
  } else if (message.type === 'scene-flow:view' && message.view === 'search') {
    hideSceneFlowView();
    activateSearchView();
  } else if (message.type === 'scene-flow:open-scene' && typeof message.scene === 'string') {
    hideSceneFlowView();
    activateExplorerView();
    openScene(message.scene).then(() => {
      if (typeof message.symbol !== 'string' || !message.symbol) return;
      const symbol = message.symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const match = new RegExp(`^\\s*(?:global\\s+)?(?:int|string|str|bool|struct|const)\\s+${symbol}\\b`, 'm').exec(editor.value);
      if (match) revealEditorRange(match.index, match.index + message.symbol.length);
    }).catch(showError);
  } else if (message.type === 'scene-flow:help') {
    hideSceneFlowView();
    showLanguageGuide();
  }
});
function activateSearchView() {
  hideSceneFlowView();
  document.querySelector('.app-shell')?.classList.remove('sidebar-hidden');
  document.querySelector('.sidebar')?.classList.add('search-mode');
  document.querySelectorAll('.activity-button').forEach((button) => button.classList.toggle('active', button.dataset.activity === 'search'));
  searchView.hidden = false; searchInput.focus(); searchInput.select();
}
function activateExplorerView() {
  hideSceneFlowView();
  document.querySelector('.app-shell')?.classList.remove('sidebar-hidden');
  document.querySelector('.sidebar')?.classList.remove('search-mode');
  document.querySelectorAll('.activity-button').forEach((button) => button.classList.toggle('active', button.dataset.activity === 'explorer'));
}
function searchMatcher(query) {
  const source = searchOptions.has('regex') ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(searchOptions.has('word') ? `\\b(?:${source})\\b` : source, searchOptions.has('case') ? 'g' : 'gi');
}
function appendSearchPreview(container, text, start, length) {
  container.append(document.createTextNode(text.slice(0, start)));
  const mark = document.createElement('mark'); mark.textContent = text.slice(start, start + length);
  container.append(mark, document.createTextNode(text.slice(start + length)));
}
async function runProjectSearch() {
  const sequence = ++searchSequence; const query = searchInput.value;
  searchResults.replaceChildren(); searchSummary.classList.remove('error');
  if (!query) { searchSummary.textContent = '検索語を入力してください'; return; }
  let matcher;
  try { matcher = searchMatcher(query); } catch (error) { searchSummary.textContent = `正規表現が正しくありません: ${error.message}`; searchSummary.classList.add('error'); return; }
  searchSummary.textContent = '検索中…';
  const files = await Promise.all(sceneNames.map(async (name) => {
    try {
      const data = await request(`/api/scene?name=${encodeURIComponent(name)}`); const matches = [];
      String(data.source || '').split(/\r?\n/).forEach((line, index) => {
        matcher.lastIndex = 0; let match;
        while ((match = matcher.exec(line))) {
          matches.push({ line: index + 1, text: line, start: match.index, length: Math.max(1, match[0].length) });
          if (!match[0].length) matcher.lastIndex++;
        }
      });
      return { name, matches };
    } catch { return { name, matches: [] }; }
  }));
  if (sequence !== searchSequence) return;
  const found = files.filter((file) => file.matches.length); const total = found.reduce((sum, file) => sum + file.matches.length, 0);
  searchSummary.textContent = total ? `${found.length} 個のファイルに ${total} 件の結果` : '一致する結果はありません';
  for (const file of found) {
    const group = document.createElement('section'); group.className = 'search-file';
    const heading = document.createElement('button'); heading.type = 'button'; heading.className = 'search-file-heading';
    const chevron = document.createElement('span'); chevron.className = 'search-chevron'; chevron.textContent = '⌄';
    const name = document.createElement('span'); name.className = 'search-file-name'; name.textContent = file.name;
    const count = document.createElement('span'); count.className = 'search-count'; count.textContent = file.matches.length;
    const body = document.createElement('div'); body.className = 'search-file-matches'; heading.append(chevron, name, count);
    heading.addEventListener('click', () => { body.hidden = !body.hidden; chevron.textContent = body.hidden ? '›' : '⌄'; });
    for (const match of file.matches) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'search-match';
      const line = document.createElement('span'); line.className = 'search-line'; line.textContent = match.line;
      const preview = document.createElement('span'); preview.className = 'search-preview'; appendSearchPreview(preview, match.text, match.start, match.length); button.append(line, preview);
      button.addEventListener('click', async () => { await openScene(file.name); const lines = editor.value.split(/\r?\n/); let start = 0; for (let index = 0; index < match.line - 1; index++) start += lines[index].length + 1; revealEditorRange(start + match.start, start + match.start + match.length, match.line); });
      body.append(button);
    }
    group.append(heading, body); searchResults.append(group);
  }
}
function scheduleProjectSearch() { clearTimeout(searchTimer); searchTimer = setTimeout(() => runProjectSearch().catch(showError), 180); }

const menuActions = {
  'new-project': () => showProjectPicker('create').catch(showError),
  'open-project': () => showProjectPicker('open').catch(showError),
  'project-settings': () => showProjectSettings().catch(showError),
  save: () => saveAllFromMenu().catch(showError),
  undo: () => restoreEditorHistory(undoStack, redoStack),
  redo: () => restoreEditorHistory(redoStack, undoStack),
  format: formatCode,
  'format-project': () => window.novelEditorApi.formatProject().catch(showError),
  'select-all': () => { editor.select(); editor.focus(); },
  'select-line': selectCurrentLine,
  'toggle-sidebar': () => document.querySelector('.app-shell')?.classList.toggle('sidebar-hidden'),
  'toggle-minimap': () => document.querySelector('.app-shell')?.classList.toggle('minimap-hidden'),
  'scene-flow': showSceneFlowView,
  compile: () => compileProjectFromMenu().catch(showError),
  play: () => playCurrentScene().catch(showError),
  'native-build': () => runNativeTool('build', 'ネイティブビルド').catch(showError),
  'native-test': () => runNativeTestSuite().catch(showError),
  language: () => showLanguageGuide(),
  syntax: () => showLanguageGuide(),
  globals: () => showLanguageGuide(),
  about: () => showWorkbenchMessage('.tds シナリオエディタ', 'Title / asset / senario 構成のローカル開発環境です。')
};
document.querySelectorAll('[data-menu-action]').forEach((button) => button.addEventListener('click', () => {
  const action = menuActions[button.dataset.menuAction];
  closeMenus();
  action?.();
}));
document.querySelector('[data-activity="explorer"]')?.addEventListener('click', activateExplorerView);
document.querySelector('[data-activity="search"]')?.addEventListener('click', activateSearchView);
document.querySelector('[data-activity="flow"]')?.addEventListener('click', showSceneFlowView);
document.querySelector('.flow-link')?.addEventListener('click', (event) => { event.preventDefault(); showSceneFlowView(); });
document.querySelector('#search-close')?.addEventListener('click', activateExplorerView);
searchInput?.addEventListener('input', scheduleProjectSearch);
document.querySelectorAll('[data-search-option]').forEach((button) => button.addEventListener('click', () => {
  const option = button.dataset.searchOption;
  if (searchOptions.has(option)) searchOptions.delete(option); else searchOptions.add(option);
  button.classList.toggle('active', searchOptions.has(option));
  button.setAttribute('aria-pressed', String(searchOptions.has(option)));
  runProjectSearch().catch(showError);
}));
