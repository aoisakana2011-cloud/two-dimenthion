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
const assetDocumentViewer = document.querySelector('#asset-document-viewer');
const assetDocumentKind = document.querySelector('#asset-document-kind');
const assetDocumentPath = document.querySelector('#asset-document-path');
const assetDocumentMetadataFields = Object.fromEntries(
  [...document.querySelectorAll('#asset-document-metadata [data-asset-meta]')]
    .map((field) => [field.dataset.assetMeta, field]),
);
const assetDocumentMetadataLabels = Object.fromEntries(
  [...document.querySelectorAll('#asset-document-metadata [data-asset-label]')]
    .map((field) => [field.dataset.assetLabel, field]),
);
const assetDocumentImage = document.querySelector('#asset-document-image');
const assetDocumentVideo = document.querySelector('#asset-document-video');
const assetDocumentAudio = document.querySelector('#asset-document-audio');
const assetDocumentError = document.querySelector('#asset-document-error');
let flowStartPreviewFile = '';
let flowStartPreviewLine = 0;
let flowLinePicker = null;
let flowPickHoverLine = 0;
const documentActions = document.querySelector('.document-actions');
if (documentActions) document.querySelector('.topbar-right')?.prepend(documentActions);
if (new URLSearchParams(location.search).get('embedded') === '1') document.documentElement.classList.add('embedded-editor');

const closeMenus = () => {
  document.querySelectorAll('[data-menu-popup]').forEach((popup) => { popup.hidden = true; });
  document.querySelectorAll('[data-menu]').forEach((button) => button.setAttribute('aria-expanded', 'false'));
};
let activeEditorModal = null;
function activateEditorModal(dialog, initialFocus, opener = document.activeElement, { backdrop = true } = {}) {
  const heading = dialog.querySelector('h1, h2, h3, strong');
  if (heading) {
    if (!heading.id) heading.id = `editor-dialog-title-${Math.random().toString(36).slice(2)}`;
    dialog.setAttribute('aria-labelledby', heading.id);
  }
  activeEditorModal = { dialog, opener };
  document.body.classList.add('editor-modal-open');
  document.body.classList.toggle('editor-modal-no-backdrop', !backdrop);
  initialFocus?.focus();
}
function deactivateEditorModal(dialog, restoreFocus = true) {
  if (activeEditorModal?.dialog !== dialog) return;
  const { opener } = activeEditorModal;
  activeEditorModal = null;
  document.body.classList.remove('editor-modal-open', 'editor-modal-no-backdrop');
  if (restoreFocus) {
    if (opener?.isConnected && opener.getClientRects().length) {
      opener.focus({ preventScroll: true });
      if (document.activeElement !== opener) editor.focus({ preventScroll: true });
    } else editor.focus({ preventScroll: true });
  }
}
document.addEventListener('keydown', (event) => {
  const modal = activeEditorModal;
  if (!modal || !modal.dialog.isConnected || event.key !== 'Tab') return;
  const controls = [...modal.dialog.querySelectorAll('a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])')]
    .filter((element) => !element.hidden && element.getAttribute('aria-hidden') !== 'true' && element.getClientRects().length);
  if (!controls.length) {
    event.preventDefault();
    modal.dialog.focus();
    return;
  }
  const first = controls[0], last = controls.at(-1), current = document.activeElement;
  if (!modal.dialog.contains(current) || (event.shiftKey && current === first) || (!event.shiftKey && current === last)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  }
}, true);
new MutationObserver(() => {
  if (activeEditorModal && !activeEditorModal.dialog.isConnected) {
    const { opener } = activeEditorModal;
    activeEditorModal = null;
    document.body.classList.remove('editor-modal-open', 'editor-modal-no-backdrop');
    if (opener?.isConnected && opener.getClientRects().length) opener.focus({ preventScroll: true });
    else editor.focus({ preventScroll: true });
  }
}).observe(document.body, { childList: true, subtree: true });
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
document.querySelectorAll('[data-menu]').forEach((button) => button.addEventListener('keydown', (event) => {
  if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
  event.preventDefault();
  const popup = document.querySelector(`[data-menu-popup="${button.dataset.menu}"]`);
  if (popup?.hidden) {
    button.click();
    if (event.key === 'ArrowUp') [...popup.querySelectorAll('[role="menuitem"]:not(:disabled)')].at(-1)?.focus();
  }
  else {
    const items = [...popup.querySelectorAll('[role="menuitem"]')].filter((item) => !item.disabled && item.getClientRects().length);
    (event.key === 'ArrowUp' ? items.at(-1) : items[0])?.focus();
  }
}));
document.addEventListener('keydown', (event) => {
  const item = event.target.closest?.('[role="menuitem"]');
  const popup = item?.closest('[data-menu-popup]');
  if (!popup || popup.hidden) return;
  const items = [...popup.querySelectorAll('[role="menuitem"]')].filter((entry) => !entry.disabled && entry.getClientRects().length);
  const index = items.indexOf(item);
  if (event.key === 'Escape') {
    event.preventDefault();
    closeMenus();
    document.querySelector(`[data-menu="${popup.dataset.menuPopup}"]`)?.focus();
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const step = event.key === 'ArrowDown' ? 1 : -1;
    items[(index + step + items.length) % items.length]?.focus();
  } else if (event.key === 'Home' || event.key === 'End') {
    event.preventDefault();
    (event.key === 'Home' ? items[0] : items.at(-1))?.focus();
  }
});
document.addEventListener('click', (event) => { if (!event.target.closest('.menu-item')) closeMenus(); });

let currentProjectRoot = '';
let activeSettingDocument = '';
let activeStandardLibraryDocument = '';
let activeAssetDocument = '';
let flowNativeDebugSession = '';
let flowNativeDebugPollTimer = 0;
let flowNativeDebugPollBusy = false;
let flowNativeDebugLocationSequence = 0;
let flowNativeDebugLastLocationKey = '';
let flowNativeDebugActiveLoopKey = '';
let flowNativeDebugExecutionFile = '';
let flowNativeDebugExecutionLine = 0;
let flowNativeDebugLoopSourceFile = '';
let flowNativeDebugLoopSource = '';
let flowNativeDebugLoopRanges = [];
let scenarioDirectory = 'senario';
let catalog = {};
let suggestions = [];
let suggestionIndex = 0;
let completionRange = null;
let sceneNames = [];
let quickWorkspaceSymbolsPromise = null;
let pendingEditorChord = '';
let editorChordTimer = null;
let knownVariables = [];
let includedFunctionNames = [];
let standardLibraryModules = [];
let standardLibraryPromise = null;
let staticVariableDeclarations = new Map();
let knownVariableDataLoaded = false;
let currentVariableAnalysis = null;
let currentEditorSymbols = null;
let variableTooltipRequestId = 0;
let suggestionRefreshId = 0;
let validationTimer = null;
let diagnosticText = '';
let diagnostics = [];
let documentNavigationSequence = 0;
let fileInfoBase = null;
let fileInfoRequestSequence = 0;
let validationSequence = 0;
let isDirty = false;
let sceneRevision = '';
let projectChangesToken = '';
let projectChangesInFlight = false;
let workspaceReadyForPolling = false;
let middleScroll = null;
let minimapDrag = null;
const undoStack = [];
const redoStack = [];
let restoringHistory = false;
const openTabs = [];
const splitTabs = [];
const fileLabel = (name) => String(name || '').replace(/[\\/]$/, '').split(/[\\/]/).pop();
const assetMediaKind = (name) => {
  const extension = String(name || '').split('.').at(-1).toLowerCase();
  if (['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(extension)) return 'image';
  if (['wav', 'ogg', 'mp3', 'flac'].includes(extension)) return 'audio';
  if (['mp4', 'webm'].includes(extension)) return 'video';
  return '';
};
function assetDocumentUrl(name) {
  const normalized = String(name || '').replaceAll('\\', '/');
  if (!normalized.startsWith('asset/') || normalized.split('/').some(part => !part || part === '.' || part === '..')) throw Error('作品内のassetファイルを指定してください');
  return `/${normalized.split('/').map(encodeURIComponent).join('/')}`;
}
const valueTypeLabel = (type) => typeof type === 'string' ? type : type?.kind === 'struct' ? type.name || 'struct' : type?.kind === 'dict' || type?.kind === 'list' ? `${type.kind}[${type.value}]` : type?.kind || '不明';
function scenarioRelativePath(name) {
  const root = String(scenarioDirectory || '').replaceAll('\\', '/').replace(/\/+$/, '');
  const normalized = String(name || '').replaceAll('\\', '/').replace(/\/+$/, '');
  if (!root) return null;
  if (normalized.toLowerCase() === root.toLowerCase()) return '';
  const prefix = `${root}/`;
  return normalized.toLowerCase().startsWith(prefix.toLowerCase()) ? normalized.slice(prefix.length) : null;
}
const isStandardLibraryPath = (name) => {
  const normalized = String(name || '').replaceAll('\\', '/');
  return /^std\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.tds$/i.test(normalized)
    && !normalized.split('/').some(part => !part || part === '.' || part === '..');
};
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
const editorContextMenu = document.createElement('div');
editorContextMenu.className = 'editor-context-menu';
editorContextMenu.hidden = true;
editorContextMenu.setAttribute('role', 'menu');
document.body.append(editorContextMenu);
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
function normalizeVariables(values, staticVariables = []) {
  const staticByName = new Map((Array.isArray(staticVariables) ? staticVariables : []).filter((entry) => entry && typeof entry.name === 'string').map((entry) => [entry.name, entry]));
  const merged = new Map();
  for (const variable of values) {
    if (!variable || typeof variable.name !== 'string' || !variable.name) continue;
    const configured = variable.scope === 'global' ? staticByName.get(variable.name) : null;
    const constraint = configured && (configured.min !== undefined || configured.max !== undefined || Array.isArray(configured.possibleValues))
      ? Object.fromEntries(['min', 'max', 'possibleValues'].filter((key) => configured[key] !== undefined).map((key) => [key, configured[key]]))
      : variable.constraint;
    const key = JSON.stringify([variable.name, variable.scope || 'global', variable.definedIn || 'global']);
    const current = merged.get(key);
    if (!current) {
      merged.set(key, { ...variable, ...(configured ? { static: true } : {}), ...(constraint ? { constraint } : {}), definitions: [...(variable.definitions || [])], references: [...(variable.references || [])] });
      continue;
    }
    for (const field of ['definitions', 'references']) {
      const known = new Set(current[field].map((location) => JSON.stringify(location)));
      for (const location of variable[field] || []) if (!known.has(JSON.stringify(location))) current[field].push(location);
    }
  }
  return [...merged.values()];
}
function setKnownVariableData(data) {
  const declarations = Array.isArray(data?.staticVariables) ? data.staticVariables : [];
  staticVariableDeclarations = new Map(declarations.filter((entry) => entry && typeof entry.name === 'string').map((entry) => [entry.name, entry]));
  knownVariables = normalizeVariables(data?.variables || [], declarations);
  knownVariableDataLoaded = true;
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
    if (/[0-9]/.test(c)) { const value = /^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(source.slice(i))[0]; push('number', value); i += value.length; continue; }
    if (/[A-Za-z_]/.test(c)) { const start = i++; while (i < source.length && /[A-Za-z0-9_]/.test(source[i])) i++; push('word', source.slice(start, i)); continue; }
    const pair = source.slice(i, i + 2);
    if (['==', '!=', '>=', '<=', '->', '=>', '..'].includes(pair)) { push('operator', pair); i += 2; continue; }
    if ('=+-*/%<>!'.includes(c)) { push('operator', c); i++; continue; }
    if ('{}[]():,.'.includes(c)) { push('punctuation', c); i++; continue; }
    push('plain', c); i++;
  }

  const significant = tokens.filter((token) => token.kind !== 'space' && token.kind !== 'comment');
  const keywords = new Set(['scene', 'asset', 'character', 'pose', 'struct', 'say', 'bg', 'bgm', 'char', 'show', 'at', 'hide', 'clear', 'play', 'wait', 'effect', 'const', 'global', 'set', 'unset', 'if', 'elif', 'else', 'and', 'or', 'not', 'for', 'from', 'to', 'step', 'while', 'parallel', 'choice', 'fn', 'return', 'goto', 'include']);
  const types = new Set(['int', 'float', 'str', 'none', 'dict']);
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
    if (['int', 'float', 'str'].includes(first.value)) {
      const declaration = significant.find((token, index) => index > 0 && token.kind === 'word');
      if (declaration) declaration.role = 'declaration';
    }
    if (first.value === 'const') {
      const declaration = significant.find((token, index) => index > 1 && token.kind === 'word' && ['int', 'float', 'str', 'dict', ']'].includes(significant[index - 1]?.value));
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

const KEYWORDS = ['scene', 'asset', 'character', 'pose', 'struct', 'int', 'float', 'str', 'dict', 'const', 'global', 'say', 'bg', 'bgm', 'show', 'hide', 'clear', 'play', 'wait', 'effect', 'set', 'unset', 'if', 'elif', 'else', 'and', 'or', 'not', 'for', 'while', 'parallel', 'choice', 'fn', 'return', 'goto', 'include'];

function setStatus(message, kind = '') {
  if (kind !== 'error') document.querySelector('#runtime-error')?.remove();
  const dot = status.querySelector('.status-dot') || document.createElement('span');
  status.replaceChildren(dot, document.createTextNode(message));
  status.className = `status-chip ${kind}`.trim();
}

function splitEditorLines(source) { return String(source ?? '').split(/\r\n|[\r\n\u2028\u2029]/); }

function updateLineNumbers() {
  const count = splitEditorLines(editor.value).length;
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

function lineCodeBeforeComment(line) {
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '#' || (char === '/' && line[index + 1] === '/')) return line.slice(0, index);
  }
  return line;
}

function insertEditorRange(from, to, text, caretInText) {
  rememberUndo();
  editor.value = `${editor.value.slice(0, from)}${text}${editor.value.slice(to)}`;
  editor.focus();
  editor.setSelectionRange(from + caretInText, from + caretInText);
  editor.dispatchEvent(new Event('input'));
}

function insertEditorBlockAtLineEnd(caret, lineStart, openingBrace = false) {
  const header = editor.value.slice(lineStart, caret);
  const indent = /^[ \t]*/.exec(header)[0];
  const bodyIndent = `${indent}  `;
  const formattedHeader = openingBrace ? '' : `${indent}${formatSource(header.slice(indent.length)).trimEnd()}`;
  const text = openingBrace ? `\n${bodyIndent}\n${indent}}` : `${formattedHeader} {\n${bodyIndent}\n${indent}}\n`;
  const end = !openingBrace && editor.value[caret] === '\n' ? caret + 1 : caret;
  insertEditorRange(openingBrace ? caret : lineStart, end, text, (openingBrace ? 1 : formattedHeader.length + 3) + bodyIndent.length);
}

function insertEditorNewline() {
  const source = editor.value;
  const start = editor.selectionStart;
  const end = editor.selectionEnd;
  const lineStart = source.lastIndexOf('\n', start - 1) + 1;
  const lineEndAt = source.indexOf('\n', start);
  const lineEnd = lineEndAt < 0 ? source.length : lineEndAt;
  const line = source.slice(lineStart, lineEnd);
  const indent = /^[ \t]*/.exec(line)[0];
  let from = start;
  let to = end;
  let insertion = `\n${indent}`;
  let caretInInsertion = insertion.length;

  // Enter inside existing indentation starts a new line without doubling it.
  if (start === end && start <= lineStart + indent.length) {
    from = lineStart;
    to = lineStart + indent.length;
  } else if (start === end && !line.trim()) {
    // Keep the next line ready for typing, but do not leave spaces on the blank line.
    from = lineStart;
    to = lineEnd;
  } else {
    const before = source.slice(lineStart, start);
    const after = source.slice(end, lineEnd);
    const openBrace = /\{[ \t]*$/.test(lineCodeBeforeComment(before));
    if (openBrace) {
      insertion = `\n${indent}  `;
      caretInInsertion = insertion.length;
      if (/^[ \t]*\}/.test(after)) insertion += `\n${indent}`;
    }
  }

  insertEditorRange(from, to, insertion, caretInInsertion);
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
  const selectedLines = splitEditorLines(source.slice(firstLineStart, lineEnd));
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
  if (frame?.src && frame.contentWindow) frame.contentWindow.postMessage({ type: 'scene-flow:refresh', projectRoot: currentProjectRoot }, location.origin);
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
  quickWorkspaceSymbolsPromise = null;
  if (!quickAccessPanel?.hidden && quickAccessMode === 'workspace-symbol') renderQuickAccess();
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
  await refreshFiles();
}

async function refreshFiles() {
  const { files, title, projectRoot, scenarioDir } = await request('/api/files');
  if (projectRoot) currentProjectRoot = projectRoot;
  if (scenarioDir) scenarioDirectory = scenarioDir;
  document.querySelector('#project-title')?.replaceChildren(document.createTextNode(title || 'Explorer'));
  const pathNote = document.querySelector('#project-path');
  if (pathNote) {
    pathNote.title = currentProjectRoot ? `Project Folder: ${currentProjectRoot}` : 'Project Folder';
    pathNote.replaceChildren(Object.assign(document.createElement('span'), { className: 'folder-icon', textContent: '▱' }), document.createTextNode(` ${currentProjectRoot || 'Project Folder'}`));
  }
  const visible = files.map((file) => ({ ...file, displayPath: file.path }));
  const root = { folders: new Map(), files: [] };
  for (const file of visible) { const parts = file.displayPath.split('/'); let node = root; parts.forEach((part, index) => { if (index === parts.length - 1) { if (file.directory) { if (!node.folders.has(part)) node.folders.set(part, { folders: new Map(), files: [] }); } else node.files.push({ name: part, path: file.path }); } else { if (!node.folders.has(part)) node.folders.set(part, { folders: new Map(), files: [] }); node = node.folders.get(part); } }); }
  const expandedFolders = new Set([...fileTree.querySelectorAll('.scene-folder')].filter((folder) => folder.nextElementSibling && !folder.nextElementSibling.hidden).map((folder) => folder.dataset.path));
  fileTree.replaceChildren();
  let folderId = 0;
  const drawFile = (node, parent, depth = 0, folderPath = '') => {
    [...node.folders].sort().forEach(([name, child]) => {
      const path = folderPath ? `${folderPath}/${name}` : name;
      const folder = document.createElement('div'); folder.className = 'scene-folder'; folder.style.paddingLeft = `${depth * 14}px`; folder.dataset.path = path;
      const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'scene-folder-toggle'; toggle.textContent = `› ${name}`; toggle.setAttribute('aria-label', `${name} folder`); toggle.setAttribute('aria-expanded', 'false');
      const contents = document.createElement('div'); contents.className = 'scene-folder-contents'; contents.id = `file-tree-folder-${folderId++}`; contents.setAttribute('role', 'group'); contents.setAttribute('aria-label', `${name} files`); contents.hidden = true;
      toggle.setAttribute('aria-controls', contents.id);
      toggle.onclick = () => { contents.hidden = !contents.hidden; toggle.setAttribute('aria-expanded', String(!contents.hidden)); toggle.textContent = `${contents.hidden ? '›' : '⌄'} ${name}`; };
      folder.oncontextmenu = (event) => { event.preventDefault(); if (scenarioRelativePath(path) !== null) addSceneInUi(path).catch(showError); };
      folder.append(toggle); parent.append(folder, contents); drawFile(child, contents, depth + 1, path);
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
      openButton.setAttribute('aria-label', file.path);
      item.oncontextmenu = (event) => {
        event.preventDefault();
        showFileContextMenu(event, file.path);
      };
      if (scenarioRelativePath(file.path) !== null && /\.(tds|txt)$/i.test(file.path)) {
        openButton.title = 'Click: open in the left pane / Shift+Click: move to the right pane';
        openButton.onclick = (event) => {
          const name = scenarioRelativePath(file.path);
          if (event.shiftKey) moveTabToRight(name).catch(showError);
          else openScene(name).catch(showError);
        };
      }
      if ((file.path.startsWith('setting/') || file.path === 'setting.txt') && /\.(txt|md|json)$/i.test(file.path)) {
        openButton.title = '設定・規約ファイルを編集';
        openButton.onclick = () => openSettingFile(file.path).catch(showError);
      }
      if (file.path.startsWith('asset/')) {
        openButton.title = assetMediaKind(file.path) ? 'Click to open asset in editor' : 'Right-click for file actions';
        openButton.onclick = () => assetMediaKind(file.path)
          ? openAssetDocument(file.path).catch(showError)
          : setStatus('この形式はEditor内のPreviewに対応していません', 'warning');
      }
      item.append(openButton);
      parent.append(item);
    });
  };
  drawFile(root, fileTree);
  fileTree.querySelectorAll('.scene-folder').forEach((folder) => {
    const label = folder.dataset.path;
    const contents = folder.nextElementSibling;
    if (expandedFolders.has(label) && contents?.classList.contains('scene-folder-contents')) {
      contents.hidden = false;
      const toggle = folder.querySelector('.scene-folder-toggle');
      toggle?.setAttribute('aria-expanded', 'true');
      if (toggle) toggle.textContent = `⌄ ${label.split('/').at(-1)}`;
    }
  });
  fileTree.querySelectorAll('.scene-file').forEach((item) => {
    const button = document.createElement('button');
    button.className = 'tree-action delete';
    button.textContent = '🗑';
    button.title = '削除';
    button.setAttribute('aria-label', `${item.dataset.path}を削除`);
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
    button.title = 'Add File';
    button.setAttribute('aria-label', `Add file under ${folder.dataset.path}`);
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
  closeEditorContextMenu();
  variableTooltipRequestId++;
  hideVariableTooltip();
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
    addAction('Open in Right Pane', () => moveTabToRight(name).catch(showError));
    addAction('View File Info', () => showFileInfo(filePath).catch(showError));
    separator();
  } else if (isAsset) {
    const mediaKind = assetMediaKind(filePath);
    if (mediaKind) addAction(mediaKind === 'image' ? 'Open Image in Editor' : 'Open Media in Editor', () => openAssetDocument(filePath).catch(showError));
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
  fileContextMenu.style.left = '0px';
  fileContextMenu.style.top = '0px';
  fileContextMenu.hidden = false;
  const bounds = fileContextMenu.getBoundingClientRect();
  fileContextMenu.style.left = `${Math.max(6, Math.min(event.clientX, window.innerWidth - bounds.width - 6))}px`;
  fileContextMenu.style.top = `${Math.max(6, Math.min(event.clientY, window.innerHeight - bounds.height - 6))}px`;
  fileContextMenu.querySelector('button')?.focus();
}

function renderFileInfo() {
  if (!fileInfo) return;
  const info = fileInfoBase;
  if (!info || typeof info !== 'object') {
    fileInfo.textContent = typeof info === 'string' && info ? info : 'Right-click a Scene file to view its details';
    return;
  }

  fileInfo.replaceChildren();
  const header = document.createElement('div');
  header.className = 'file-info-header';
  const title = document.createElement('div');
  title.className = 'file-info-title';
  const eyebrow = document.createElement('small');
  eyebrow.textContent = 'File Info';
  const filename = document.createElement('strong');
  filename.textContent = fileLabel(info.path);
  filename.title = info.path || '';
  title.append(eyebrow, filename);
  const stats = document.createElement('div');
  stats.className = 'file-info-summary';
  const addStat = (kind, label, count) => {
    const badge = document.createElement('span');
    badge.className = `file-info-stat file-info-stat-${kind}`;
    badge.textContent = `${label} ${count}`;
    stats.append(badge);
  };
  if (info.error) {
    const error = document.createElement('span');
    error.className = 'file-info-stat file-info-stat-error';
    error.textContent = info.error;
    stats.append(error);
  } else {
    addStat('local', 'Destinations', (info.localGotos || []).length + info.targets.length);
    addStat('variables', 'Variables', info.variables.length);
    if (info.reachable === false) addStat('warning', 'Unreachable', '');
  }
  header.append(title, stats);
  fileInfo.append(header);

  const addSection = (kind, label, count, rows) => {
    if (!count) return;
    const section = document.createElement('details');
    section.className = 'file-info-section';
    section.dataset.kind = kind;
    if (count <= (kind === 'targets' || kind === 'local-targets' ? 5 : 8)) section.open = true;
    const heading = document.createElement('summary');
    const headingLabel = document.createElement('span');
    headingLabel.className = 'file-info-section-label';
    headingLabel.textContent = label;
    const headingCount = document.createElement('span');
    headingCount.className = 'file-info-section-count';
    headingCount.textContent = String(count);
    heading.append(headingLabel, headingCount);
    section.append(heading);
    const list = document.createElement('ul');
    list.className = 'file-info-list';
    for (const row of rows) list.append(row);
    section.append(list);
    fileInfo.append(section);
  };

  if (!info.error) {
    const localRows = (info.localGotos || []).map((target) => {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'file-info-link file-info-link-scene';
      button.textContent = target.scene;
      button.title = `Go to Scene definition: ${target.scene}`;
      button.addEventListener('click', () => jumpToScene(target.file, target.scene).catch(showError));
      const meta = document.createElement('small');
      meta.className = 'file-info-target-meta';
      meta.textContent = `${target.file === info.path ? 'このファイル内' : fileLabel(target.file)}${target.gotoLine ? ` · goto ${target.gotoLine}行` : ''}`;
      item.append(button, meta);
      return item;
    });
    addSection('local-targets', 'Scenes in this file', localRows.length, localRows);

    const targetRows = info.targets.map((target) => {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'file-info-link file-info-link-file';
      button.textContent = target;
      button.title = `Open destination ${target}`;
      button.addEventListener('click', () => openScene(target).catch(showError));
      item.append(button);
      return item;
    });
    addSection('targets', 'Destinations', targetRows.length, targetRows);

    const scopeLabels = { global: 'Global', function: 'Function', scene: 'Scene', local: 'Local' };
    const variableRows = [...info.variables]
      .sort((left, right) => String(left.scope).localeCompare(String(right.scope)) || left.name.localeCompare(right.name) || String(left.definedIn).localeCompare(String(right.definedIn)))
      .map((variable) => {
        const item = document.createElement('li');
        item.className = 'file-info-variable';
        const definitions = variable.definitions || [];
        const references = variable.references || [];
        const origin = definitions[0] || {};
        const container = origin.container || variable.definedIn || '';
        const label = document.createElement('span');
        label.className = 'file-info-variable-name';
        label.textContent = variable.name;
        const type = document.createElement('span');
        type.className = 'file-info-type';
        type.textContent = valueTypeLabel(variable.type);
        const definition = definitions.find((location) => location.file && location.line) || definitions.find((location) => location.line);
        if (definition) {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'file-info-variable-jump';
          button.title = 'Go to definition';
          button.append(label, type);
          button.addEventListener('click', () => jumpToLocation(definition, variable.name).catch(showError));
          item.append(button);
        } else {
          const variableHeading = document.createElement('div');
          variableHeading.className = 'file-info-variable-heading';
          variableHeading.append(label, type);
          item.append(variableHeading);
        }
        const meta = document.createElement('small');
        meta.className = 'file-info-variable-meta';
        const binding = variable.scope === 'global' || !container ? scopeLabels[variable.scope] || variable.scope : `${scopeLabels[variable.scope] || variable.scope}: ${container}`;
        meta.textContent = `${binding} · ${definitions.length} definitions · ${references.length} references`;
        item.append(meta);
        return item;
      });
    addSection('variables', 'Variables', variableRows.length, variableRows);
  }

  if (info.unreachableRanges.length) {
    const rows = info.unreachableRanges.map((range) => {
      const item = document.createElement('li');
      item.textContent = range;
      return item;
    });
    addSection('unreachable', 'Unreachable lines', rows.length, rows);
  }
}

async function showFileInfo(path) {
  path = normalizedScenePath(path);
  const requestId = ++fileInfoRequestSequence;
  const isCurrentRequest = () => requestId === fileInfoRequestSequence && normalizedScenePath(sceneName.value) === path;
  const graph = await request('/api/scene-graph');
  if (!isCurrentRequest()) return;
  const node = graph.nodes.find((item) => item.id === path);
  if (node?.error) {
    if (isCurrentRequest()) {
      fileInfoBase = { path, error: 'syntax error', targets: [], localGotos: [], variables: [], reachable: node.reachable !== false, unreachableRanges: [] };
      renderFileInfo();
    }
    return;
  }
  let targets = graph.edges.filter((edge) => edge.from === path && edge.kind === 'goto').map((edge) => edge.to);
  let variables = node?.variables || [];
  if ((!node || node.error) && fileInfo) {
    try {
      const scene = await request(`/api/scene?name=${encodeURIComponent(path)}`);
      if (!isCurrentRequest()) return;
      const source = String(scene.source || '');
      targets = [...source.matchAll(/^\s*goto\s+(?:"([^"]+)"|([^\s]+))/gmi)].map((m) => m[1] || m[2]);
      variables = [...source.matchAll(/^\s*(?:global\s+)?(?:const\s+)?(int|float|str|dict)\s+([A-Za-z_][A-Za-z0-9_]*)/gmi)].map((m) => ({ name: m[2], type: m[1], scope: 'global', definedIn: path, definitions: [], references: [] }));
    } catch { /* keep empty information */ }
  }
  if (isCurrentRequest()) {
    const unreachableRanges = fileInfoBase?.path === path ? fileInfoBase.unreachableRanges : [];
    fileInfoBase = { path, targets: [...new Set(targets)], localGotos: node?.localGotos || [], variables, reachable: node?.reachable !== false, unreachableRanges };
    renderFileInfo();
  }
}
async function addSceneInUi(folder) {
  folder = scenarioRelativePath(folder);
  if (folder === null) return;
  const name = await uiPrompt(`${folder} · Scene name`, '');
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
    setStatus('Assetsを読み込みました', 'ok');
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
  const quotedGotoPath = /^\s*goto\s+"/.test(line);
  const quotedIncludePath = /^\s*include\s+"/.test(line);
  if ((line.split('"').length - 1) % 2 && !quotedGotoPath && !quotedIncludePath) return null;

  let start = end;
  if (quotedGotoPath || quotedIncludePath) start = lineStart + line.indexOf('"') + 1;
  else while (start > lineStart && !/[\s{}"=:><!+\-.]/.test(source[start - 1])) start--;
  const hyphenatedPositionPrefix = /(?:^|\s)(far-(?:left|right)?)$/.exec(line);
  if (hyphenatedPositionPrefix) start = lineStart + hyphenatedPositionPrefix.index + hyphenatedPositionPrefix[0].search(/far-/);
  // カーソルが単語の途中にあっても、右側の残りを含めて置換する。
  // 例: i|nt で int を確定したときに "int nt" を作らない。
  let replaceEnd = end;
  if (quotedGotoPath || quotedIncludePath) {
    const newline = source.indexOf('\n', end);
    const lineEnd = newline < 0 ? source.length : newline;
    const closingQuote = source.indexOf('"', end);
    replaceEnd = closingQuote >= 0 && closingQuote < lineEnd ? closingQuote : lineEnd;
  } else {
    while (replaceEnd < source.length && !/[\s{}"=:><!+\-.]/.test(source[replaceEnd])) replaceEnd++;
  }
  const prefix = source.slice(start, end);
  const words = quotedIncludePath ? ['include'] : source.slice(lineStart, start).trim().split(/\s+/).filter(Boolean);
  return { start, end, replaceEnd, prefix, words, line, quotedIncludePath };
}

async function loadStandardLibraryModules() {
  if (!standardLibraryPromise) {
    standardLibraryPromise = request('/api/standard-library').then((data) => {
      standardLibraryModules = Array.isArray(data.modules) ? data.modules : [];
      return standardLibraryModules;
    }).catch((error) => { standardLibraryPromise = null; throw error; });
  }
  return standardLibraryPromise;
}

function completionScopes() {
  const source = editor.value;
  const scopes = [];
  const headers = /^(\s*)(fn|scene)\s+([A-Za-z_][A-Za-z0-9_-]*)\b([^{}]*\{)/gm;
  for (const match of source.matchAll(headers)) {
    const open = match.index + match[0].lastIndexOf('{');
    let depth = 1, quote = false, escaped = false, comment = false, close = open + 1;
    for (; close < source.length && depth; close++) {
      const character = source[close];
      if (comment) { if (character === '\n') comment = false; continue; }
      if (quote) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') quote = false;
        continue;
      }
      if (character === '"') quote = true;
      else if (character === '#') comment = true;
      else if (character === '{') depth++;
      else if (character === '}') depth--;
    }
    if (!depth) scopes.push({ kind: match[2], name: match[3], params: match[2] === 'fn' ? /\(([^)]*)\)/.exec(match[4])?.[1] || '' : '', open, close });
  }
  return scopes;
}

function completionScope(context) {
  return completionScopes().filter(scope => scope.kind === 'fn' && context.start > scope.open && context.start < scope.close)
    .sort((left, right) => right.open - left.open)[0] || null;
}

function completionVariableDeclarations(context) {
  const source = editor.value;
  const before = source.slice(0, context.start);
  const scopes = completionScopes();
  const active = scopes.filter(scope => context.start > scope.open && context.start < scope.close)
    .sort((left, right) => right.open - left.open)[0] || null;
  const declarations = new Map();
  const add = (name, type = '') => { if (name) declarations.set(name, { name, type }); };
  const declaredType = '(?:int|float|str|bool|character|dict\\[(?:int|float|str|bool)\\]|list\\[(?:int|float|str|bool)\\])';
  const declarationPattern = new RegExp(`\\b(?:global\\s+)?(${declaredType})\\s+([A-Za-z_][A-Za-z0-9_]*)\\b|\\blet\\s+([A-Za-z_][A-Za-z0-9_]*)\\s*(?::\\s*(${declaredType}))?`, 'g');
  for (const match of before.matchAll(declarationPattern)) {
    const owner = scopes.filter(scope => match.index > scope.open && match.index < scope.close).sort((left, right) => right.open - left.open)[0] || null;
    if (owner && owner !== active) continue;
    add(match[2] || match[3], match[1] || match[4] || '');
  }
  if (active?.kind === 'fn') {
    for (const parameter of active.params.matchAll(new RegExp(`(?:^|,)\\s*([A-Za-z_][A-Za-z0-9_]*)\\s*:\\s*(${declaredType})\\b`, 'g'))) add(parameter[1], parameter[2]);
  }
  const activeContainer = active ? `${active.kind === 'fn' ? 'function' : 'scene'} (${active.name})` : 'global';
  for (const variable of knownVariables) {
    if (variable.scope === 'global' || variable.static) add(variable.name, valueTypeLabel(variable.type));
    else if (active && variable.definedIn === activeContainer) add(variable.name, valueTypeLabel(variable.type));
  }
  return [...declarations.values()];
}

function completionVariableNames(context) {
  return completionVariableDeclarations(context).map(variable => variable.name);
}

function currentFileFunctionNames() {
  return [...new Set([...editor.value.matchAll(/\bfn\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)].map(match => match[1]))];
}

function candidatesFor(context) {
  const [command, ...args] = context.words;
  if (!command) return KEYWORDS;
  if (command === 'include' && context.quotedIncludePath) {
    return [...new Set([...sceneNames, ...standardLibraryModules.map((module) => module.path)])];
  }
  const visibleVariables = completionVariableDeclarations(context);

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
    return context.line.trimStart().startsWith('goto "')
      ? [...new Set(sceneNames)]
      : [...new Set(localScenes)];
  }
  if (command === 'choice' && args.length === 0) return ['""'];
  if (command === 'for') {
    if (args.length === 0) return ['i', 'index'];
    if (args.length === 1) return ['from'];
    if (args.length === 2) return ['0'];
    if (args.length === 3) return ['to'];
    if (args.length === 4) return ['10', ...visibleVariables.filter((variable) => variable.type === 'int').map((variable) => variable.name)];
    if (args.length === 5) return ['step'];
  }
  if (command === 'if' && args.length === 0) return visibleVariables.map((variable) => variable.name);
  if (command === 'if' && args.length === 1) return ['==', '>=', '<=', '!=', '>', '<'];
  if (command === 'if' && args.length >= 2 && ['>=', '<=', '==', '!=', '>', '<'].includes(args[1])) {
    const visibleNames = new Set(visibleVariables.map(variable => variable.name));
    const values = knownVariables.filter(variable => variable.name === args[0] && visibleNames.has(variable.name)).flatMap((variable) => variable.values || variable.allowedValues || []);
    return [...new Set(values.map(String))];
  }
  if (command === 'set' && args.length === 0) return visibleVariables.map((variable) => variable.name);
  if (args.length && args.at(-1).includes('.')) {
    const namespace = args.at(-1).slice(0, args.at(-1).lastIndexOf('.') + 1);
    const builtinMembers = {
      'list.': ['append()', 'contains()', 'length()'],
      'text.': ['normalize_space()', 'replace()', 'split()', 'trim()'],
      'runtime.state.': ['audio.', 'background.', 'characters.', 'execution.', 'ui.', 'variables.'],
      'runtime.state.audio.': ['bgm_exists()', 'current_bgm()', 'volume()'],
      'runtime.state.background.': ['current()', 'exists()'],
      'runtime.state.characters.': ['exists()', 'list()', 'position()'],
      'runtime.state.execution.': ['current_file()', 'current_line()', 'current_scene()'],
      'runtime.state.ui.': ['dialog_opacity()'],
      'runtime.state.variables.': ['exists()', 'names()'],
    }[namespace] || [];
    const members = [
      ...includedFunctionNames.filter(name => name.startsWith(namespace)).map(name => name.slice(namespace.length)),
      ...builtinMembers,
    ];
    if (members.length) return members;
  }
  if (['wait', 'set', 'if', 'return'].includes(command)) {
    return [...new Set([...completionVariableNames(context), ...currentFileFunctionNames().map(name => `${name}()`), ...includedFunctionNames])];
  }
  if (command === 'asset' && args.length === 0) return ['bg', 'char', 'bgm', 'se', 'voice', 'image', 'video'];
  return [];
}

async function updateSuggestions() {
  if (document.activeElement !== editor || activeSettingDocument || activeStandardLibraryDocument || !/\.tds$/i.test(sceneName.value)) return hideSuggestions();
  const refreshId = ++suggestionRefreshId;
  try {
    const [sceneData, variableData] = await Promise.all([request('/api/scenes'), request('/api/variables')]);
    if (refreshId !== suggestionRefreshId) return;
    sceneNames = sceneData.scenes || [];
    setKnownVariableData(variableData);
    if (/^\s*include\s+"/.test(editor.value.slice(editor.value.lastIndexOf('\n', editor.selectionStart - 1) + 1, editor.selectionStart))
      || [...editor.value.matchAll(/^\s*include\s+"([^"]+)"\s+as\s+/gm)].some(([, includePath]) => includePath.startsWith('std/'))) {
      try { await loadStandardLibraryModules(); } catch { /* Standard-library completions are optional when unavailable. */ }
      if (refreshId !== suggestionRefreshId) return;
    }
    const aliases = [...editor.value.matchAll(/^\s*include\s+"([^"]+)"\s+as\s+([A-Za-z_][A-Za-z0-9_]*)/gm)];
    includedFunctionNames = (await Promise.all(aliases.map(async ([, includePath, alias]) => {
      const normalizedPath = includePath.replaceAll('\\', '/');
      const standardModule = standardLibraryModules.find(module => module.path === normalizedPath);
      if (standardModule) return standardModule.functions.map(name => `${alias}.${name}()`);
      const file = sceneNames.find(name => name.replaceAll('\\', '/') === normalizedPath);
      if (!file) return [];
      try {
        const module = await request(`/api/scene?name=${encodeURIComponent(file)}`);
        return [...module.source.matchAll(/\bfn\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)].map(match => `${alias}.${match[1]}()`);
      } catch { return []; }
    }))).flat();
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
  const line = splitEditorLines(editor.value.slice(0, editor.selectionStart)).length - 1;
  const column = editor.selectionStart - lineStart;
  suggestionBox.style.left = `${78 + column * 8.4}px`;
  suggestionBox.style.top = `${21 + line * editorLineHeight() - editor.scrollTop + 25}px`;
  renderSuggestions();
}

function hideVariableTooltip() {
  variableTooltip.hidden = true;
}

function currentSourceVariable(name) {
  const declaration = new RegExp(`^\\s*(?:global\\s+)?(?:const\\s+)?(int|float|str|dict\\[(?:int|float|str)\\]|[A-Z][A-Za-z0-9_]*)\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=`, 'm');
  const match = declaration.exec(editor.value);
  if (!match) return null;
  const line = splitEditorLines(editor.value.slice(0, match.index)).length;
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
  const line = splitEditorLines(editor.value)[lineIndex];
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

function showVariableTooltipLegacy(event) {
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
  const sourceLine = splitEditorLines(editor.value)[lineIndex];
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

function sourceOffsetAtEvent(event) {
  if (!highlight || !highlight.textContent.startsWith(editor.value)) return null;
  const walker = document.createTreeWalker(highlight, NodeFilter.SHOW_TEXT);
  let offset = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const value = node.nodeValue || '';
    const whole = document.createRange();
    whole.selectNodeContents(node);
    const lineBoxes = [...whole.getClientRects()].filter((rect) => event.clientY >= rect.top && event.clientY <= rect.bottom);
    if (lineBoxes.length) {
      const character = document.createRange();
      for (let index = 0; index < value.length; index++) {
        if (value[index] === '\n' || value[index] === '\r') continue;
        character.setStart(node, index);
        character.setEnd(node, index + 1);
        const rect = character.getBoundingClientRect();
        if (event.clientY >= rect.top && event.clientY <= rect.bottom && event.clientX >= rect.left - 0.5 && event.clientX <= rect.right + 0.5) return offset + index;
      }
    }
    offset += value.length;
  }
  return null;
}

function tokenAtSourceOffset(offset) {
  const before = editor.value.slice(0, offset);
  const lineStart = before.lastIndexOf('\n') + 1;
  const line = splitEditorLines(before).length;
  const column = offset - lineStart;
  const sourceLine = splitEditorLines(editor.value.slice(lineStart))[0] || '';
  let inString = false; let escaped = false;
  for (let index = 0; index <= Math.min(column, sourceLine.length); index++) {
    const character = sourceLine[index];
    if (index === column) {
      if (inString) {
        const expectsFilePath = /^\s*(?:include|goto)\s+"/.test(sourceLine)
          || /^\s*asset\s+(?:bg|bgm|se|voice|video|image|char)\s+[A-Za-z_][A-Za-z0-9_]*\s*=\s*"/.test(sourceLine)
          || /^\s*pose\s+[A-Za-z_][A-Za-z0-9_]*\s*=\s*"/.test(sourceLine);
        if (expectsFilePath) return { name: 'path', line, column, sourceLine };
        let interpolationStart = -1;
        let depth = 0;
        for (let cursor = 0; cursor < sourceLine.length; cursor++) {
          if (sourceLine[cursor] === '{') { if (depth++ === 0) interpolationStart = cursor + 1; }
          else if (sourceLine[cursor] === '}' && depth > 0) { depth--; if (!depth) interpolationStart = -1; }
          if (cursor === column && depth > 0) {
            let interpolationEnd = cursor;
            while (interpolationEnd < sourceLine.length && sourceLine[interpolationEnd] !== '}') interpolationEnd++;
            const identifier = [...sourceLine.slice(interpolationStart, interpolationEnd).matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)]
              .find(match => cursor >= interpolationStart + match.index && cursor < interpolationStart + match.index + match[0].length);
            if (identifier) return { name: identifier[0], line, column: interpolationStart + identifier.index, sourceLine };
            break;
          }
        }
        return { name: 'string', line, column, sourceLine };
      }
      if (character === '#') return { name: 'comment', line, column, sourceLine };
    }
    if (index >= column) break;
    if (escaped) { escaped = false; continue; }
    if (character === '\\' && inString) { escaped = true; continue; }
    if (character === '"') inString = !inString;
    if (character === '#' && !inString) return { name: 'comment', line, column, sourceLine };
  }
  const identifier = [...sourceLine.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)].find((item) => column >= item.index && column < item.index + item[0].length);
  if (identifier) return { name: identifier[0], line, column: identifier.index, sourceLine };
  const operators = ['->', '==', '!=', '<=', '>=', '+', '-', '*', '/', '%', '<', '>', '=', ':', ',', '.', '(', ')', '[', ']', '{', '}'];
  const operator = operators.find(value => sourceLine.startsWith(value, column) || column > 0 && sourceLine.startsWith(value, column - 1));
  if (operator) return { name: operator, line, column: sourceLine.indexOf(operator, Math.max(0, column - 1)), sourceLine };
  if (/\d/.test(sourceLine[column] || '')) {
    const number = [...sourceLine.matchAll(/\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b/gi)].find(item => column >= item.index && column < item.index + item[0].length);
    if (number) return { name: 'number', line, column: number.index, sourceLine };
  }
  if (sourceLine[column] === '#') return { name: 'comment', line, column, sourceLine };
  return null;
}

function sourceTokenAtEvent(event) {
  const exactOffset = sourceOffsetAtEvent(event);
  if (exactOffset !== null) return tokenAtSourceOffset(exactOffset);
  const rect = editor.getBoundingClientRect();
  const style = getComputedStyle(editor);
  const lineHeight = Number.parseFloat(style.lineHeight) || editorLineHeight();
  const paddingLeft = Number.parseFloat(style.paddingLeft) || 25;
  const paddingTop = Number.parseFloat(style.paddingTop) || 21;
  const lineIndex = Math.floor((event.clientY - rect.top + editor.scrollTop - paddingTop) / lineHeight);
  const sourceLine = splitEditorLines(editor.value)[lineIndex];
  if (sourceLine === undefined) return null;
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.font = style.font;
  const baseWidth = context.measureText('M').width || 8.4;
  const tabWidth = baseWidth * (Number(editor.tabSize) || 2);
  const targetX = event.clientX - rect.left + editor.scrollLeft - paddingLeft;
  if (targetX < 0) return null;
  let pixel = 0;
  let column = -1;
  for (let index = 0; index < sourceLine.length; index++) {
    const character = sourceLine[index];
    const width = character === '\t' ? tabWidth - (pixel % tabWidth) : context.measureText(character).width;
    if (targetX < pixel + Math.max(width, 1) / 2) { column = index; break; }
    pixel += width;
  }
  if (column < 0) return null;
  const absolute = splitEditorLines(editor.value).slice(0, lineIndex).reduce((offset, value) => offset + value.length + 1, 0) + column;
  return tokenAtSourceOffset(absolute);
}

function mergeVariableLocations(...groups) {
  const unique = new Map();
  for (const location of groups.flat()) unique.set(JSON.stringify(location), location);
  return [...unique.values()];
}

function enrichCurrentVariableEntries(file, variables) {
  const currentFile = normalizedScenePath(file);
  return variables.map((variable) => {
    const project = knownVariables.find((item) => item.name === variable.name && item.scope === variable.scope && item.definedIn === variable.definedIn);
    const staticDeclaration = variable.scope === 'global' && variable.definedIn === 'global' ? staticVariableDeclarations.get(variable.name) : null;
    const staticConstraint = staticDeclaration && (staticDeclaration.min !== undefined || staticDeclaration.max !== undefined || Array.isArray(staticDeclaration.possibleValues))
      ? Object.fromEntries(['min', 'max', 'possibleValues'].filter((key) => staticDeclaration[key] !== undefined).map((key) => [key, staticDeclaration[key]]))
      : null;
    const here = (locations) => locations.map((location) => ({ ...location, file }));
    const elsewhere = (locations) => locations.filter((location) => normalizedScenePath(location.file || file) !== currentFile);
    const sourceDefinitions = (variable.definitions || []).filter((location) => !(staticDeclaration && location.kind === 'definition' && location.line === undefined && location.column === undefined));
    const definitions = mergeVariableLocations(here(sourceDefinitions), elsewhere(project?.definitions || []));
    if (staticDeclaration) definitions.push({ scope: 'global', container: 'global', kind: 'definition', file: '.novel/variables.json' });
    return {
      ...variable,
      ...(staticDeclaration ? { static: true, readonly: Boolean(staticDeclaration.constant) } : {}),
      ...(staticConstraint ? { constraint: staticConstraint } : project?.constraint ? { constraint: project.constraint } : {}),
      definitions: mergeVariableLocations(definitions),
      references: mergeVariableLocations(here(variable.references || []), elsewhere(project?.references || [])),
    };
  });
}

async function compiledVariablesForCurrentSource(file, source) {
  if (!knownVariableDataLoaded) setKnownVariableData(await request('/api/variables'));
  if (currentVariableAnalysis?.file === file && currentVariableAnalysis.source === source && Array.isArray(currentVariableAnalysis.variables)) return enrichCurrentVariableEntries(file, currentVariableAnalysis.variables);
  if (currentVariableAnalysis?.file === file && currentVariableAnalysis.source === source && currentVariableAnalysis.promise) return currentVariableAnalysis.promise;
  const analysis = { file, source, variables: null, promise: null };
  currentVariableAnalysis = analysis;
  analysis.promise = request('/api/compile', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: file, source }),
  }).then((response) => {
    if (!response.ok || !response.program?.variables) throw new Error(response.error || '変数の参照先を解析できませんでした');
    if (sceneName.value !== file || editor.value !== source) throw new Error('解析中に編集中のSceneが変更されました');
    analysis.variables = response.program.variables;
    analysis.promise = null;
    return enrichCurrentVariableEntries(file, analysis.variables);
  }).catch((error) => {
    if (currentVariableAnalysis === analysis) currentVariableAnalysis = null;
    throw error;
  });
  return analysis.promise;
}

async function editorSymbolsForCurrentSource(file, source) {
  if (currentEditorSymbols?.file === file && currentEditorSymbols.source === source && currentEditorSymbols.value) return currentEditorSymbols.value;
  if (currentEditorSymbols?.file === file && currentEditorSymbols.source === source && currentEditorSymbols.promise) return currentEditorSymbols.promise;
  const entry = { file, source, value: null, promise: null };
  currentEditorSymbols = entry;
  entry.promise = request('/api/editor-symbols', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: file, source }),
  }).then(response => {
    if (!response.symbols) throw new Error(response.error || '\u30b7\u30f3\u30dc\u30eb\u60c5\u5831\u3092\u89e3\u6790\u3067\u304d\u307e\u305b\u3093\u3067\u3057\u305f');
    if (sceneName.value !== file || editor.value !== source) throw new Error('表示中のSceneが変更されました');
    entry.value = response.symbols;
    entry.promise = null;
    return entry.value;
  }).catch(error => { if (currentEditorSymbols === entry) currentEditorSymbols = null; throw error; });
  return entry.promise;
}

function editorTypeName(type) {
  if (typeof type === 'string') return type;
  if (type?.kind === 'struct') return type.name;
  if (type?.kind === 'dict') return `dict[${type.value}]`;
  if (type?.kind === 'list') return `list[${type.value}]`;
  return type?.kind || '不明';
}

function expressionPreview(expression) {
  if (!expression) return '';
  if (expression.kind === 'literal') return typeof expression.value === 'string' ? JSON.stringify(expression.value) : String(expression.value);
  if (expression.kind === 'float') return expression.value;
  if (expression.kind === 'variable') return expression.name;
  if (expression.kind === 'call') return `${expression.name}(…)`;
  if (expression.kind === 'binary') return `${expressionPreview(expression.left)} ${expression.operator} ${expressionPreview(expression.right)}`;
  if (expression.kind === 'unary') return `${expression.operator}${expressionPreview(expression.value)}`;
  if (expression.kind === 'dict') return `{ ${expression.entries.map(entry => `${JSON.stringify(entry.key)}: ${expressionPreview(entry.value)}`).join(', ')} }`;
  if (expression.kind === 'list') return `[${expression.items.map(expressionPreview).join(', ')}]`;
  return '式';
}

function qualifiedTokenName(token) {
  const line = token.sourceLine || '';
  const pattern = /[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/g;
  return [...line.matchAll(pattern)].find(match => token.column >= match.index && token.column < match.index + match[0].length)?.[0] || token.name;
}

function editorContainerAtLine(source, targetLine) {
  const lines = splitEditorLines(source);
  let active = null;
  let depth = 0;
  for (let index = 0; index < lines.length; index++) {
    const header = !active && /^\s*(fn|scene)\s+([A-Za-z_][A-Za-z0-9_-]*)\b.*\{/.exec(lines[index]);
    if (header) { active = { kind: header[1], name: header[2] }; depth = 0; }
    if (active) {
      depth += (lines[index].match(/\{/g) || []).length - (lines[index].match(/\}/g) || []).length;
      if (index + 1 === targetLine && depth > 0) return active;
      if (depth <= 0) active = null;
    }
  }
  return null;
}

async function showDeclarationTooltip(event, requestId, token) {
  if (!token) return false;
  const file = sceneName.value;
  const source = editor.value;
  const symbols = await editorSymbolsForCurrentSource(file, source);
  if (requestId !== variableTooltipRequestId || sceneName.value !== file || editor.value !== source) return false;
  const symbolName = qualifiedTokenName(token);
  const matchAt = item => item.name === symbolName && (item.file === file ? Number(item.line) === token.line : true);
  const fn = symbols.functions.find(matchAt) || symbols.functions.find(item => item.name === symbolName);
  const struct = symbols.structs.find(matchAt) || symbols.structs.find(item => item.name === token.name && item.file === file && Number(item.line) === token.line);
  const structField = symbols.structs.flatMap(item => (item.fields || []).map(field => ({ ...field, structName: item.name, file: item.file })))
    .find(item => item.name === token.name && item.file === file && Number(item.line) === token.line && Number(item.column) === token.column + 1);
  const character = symbols.characters.find(matchAt) || symbols.characters.find(item => item.name === token.name && item.file === file && Number(item.line) === token.line);
  const asset = symbols.assets.find(item => item.name === token.name && item.file === file && Number(item.line) === token.line);
  const scene = symbols.scenes.find(item => item.name === token.name && item.file === file && Number(item.line) === token.line);
  const include = symbols.includes.find(item => item.alias === token.name && item.file === file && Number(item.line) === token.line);
  const declaration = symbols.variables.find(item => item.name === token.name && item.file === file && Number(item.line) === token.line);
  const container = editorContainerAtLine(source, token.line);
  const scopedVariable = declaration || symbols.variables.find(item => item.name === token.name && item.file === file
    && ((item.scope === 'function' && container?.kind === 'fn' && item.container === container.name)
      || (item.scope === 'scene' && container?.kind === 'scene' && item.container === container.name)));
  if (!fn && !struct && !structField && !character && !asset && !scene && !include && !scopedVariable) return false;
  variableTooltip.replaceChildren();
  const add = (className, text) => { const row = document.createElement('div'); row.className = className; row.textContent = text; variableTooltip.append(row); return row; };
  const addDefinition = item => {
    const fileName = item.file || file;
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'variable-tooltip-location';
    button.textContent = `定義: ${fileName}:${item.line || '?'}`;
    button.addEventListener('click', () => jumpToLocation({ file: fileName, line: item.line, column: item.column }, item.name).catch(showError));
    variableTooltip.append(button);
  };
  if (fn) {
    const signature = `${fn.name}(${fn.params.map(param => `${param.name}: ${editorTypeName(param.type)}`).join(', ')}) -> ${editorTypeName(fn.returnType)}`;
    add('variable-tooltip-title', signature);
    addDefinition(fn);
  } else if (struct) {
    add('variable-tooltip-title', `struct ${struct.name}`);
    for (const field of struct.fields || []) add('variable-tooltip-row', `${field.name}: ${editorTypeName(field.type)}`);
    addDefinition(struct);
  } else if (structField) {
    add('variable-tooltip-title', `${structField.structName}.${structField.name}: ${editorTypeName(structField.type)}`);
    addDefinition({ ...structField, name: structField.structName });
  } else if (character) {
    add('variable-tooltip-title', `character ${character.name}`);
    const displayName = character.properties?.find(property => property.name === 'name');
    if (displayName) add('variable-tooltip-row', `表示名: ${expressionPreview(displayName.value)}`);
    for (const property of character.properties || []) if (property.name !== 'name') add('variable-tooltip-row', `${property.name}: ${expressionPreview(property.value)}`);
    add('variable-tooltip-heading', `Character Poses (${character.poses.length})`);
    for (const pose of character.poses) add('variable-tooltip-row', `${pose.name} — ${pose.path}`);
    addDefinition(character);
  } else if (asset) {
    add('variable-tooltip-title', `asset ${asset.type} ${asset.name}`);
    add('variable-tooltip-row', `参照パス: ${asset.path}`);
    addDefinition(asset);
  } else if (scene) {
    add('variable-tooltip-title', `scene ${scene.name}`);
    add('variable-tooltip-row', `定義ファイル: ${scene.file}`);
    add('variable-tooltip-row', `範囲: ${scene.line}–${scene.endLine || scene.line} 行`);
    addDefinition(scene);
  } else if (include) {
    add('variable-tooltip-title', `include as ${include.alias}`);
    add('variable-tooltip-row', `読み込み先: ${include.path}`);
    const exports = symbols.functions.filter(item => item.name.startsWith(`${include.alias}.`)).map(item => item.name.slice(include.alias.length + 1));
    if (exports.length) add('variable-tooltip-row', `公開関数: ${exports.join(', ')}`);
    addDefinition(include);
  } else if (scopedVariable && !declaration) {
    add('variable-tooltip-title', `${scopedVariable.name}: ${editorTypeName(scopedVariable.type)}`);
    add('variable-tooltip-row', `Scope: ${scopedVariable.scope}${scopedVariable.container ? ` (${scopedVariable.container})` : ''}`);
    add('variable-tooltip-row', scopedVariable.constant ? '定数・読み取り専用' : '変更可能');
    addDefinition(scopedVariable);
  } else if (declaration) {
    const variable = (await compiledVariablesForCurrentSource(file, source)).find(item => item.name === declaration.name && item.definedIn === declaration.container && (item.scope === declaration.scope || declaration.scope === 'loop'));
    add('variable-tooltip-title', `${declaration.name}: ${editorTypeName(variable?.type || declaration.type)}`);
    add('variable-tooltip-row', `${declaration.constant ? '定数' : '変更可能な変数'} · ${declaration.global ? 'global' : declaration.container}`);
    if (declaration.initial) add('variable-tooltip-row', `初期値: ${expressionPreview(declaration.initial)}`);
    if (variable?.constraint) {
      const constraint = variable.constraint;
      if (constraint.min !== undefined || constraint.max !== undefined) add('variable-tooltip-constraint', `設定値域: ${constraint.min ?? '下限なし'} – ${constraint.max ?? '上限なし'}`);
      const values = constraint.possibleValues || constraint.values;
      if (Array.isArray(values) && values.length) add('variable-tooltip-constraint', `設定された値: ${values.map(String).join(', ')}`);
    }
    if (variable && !variable.constraint) add('variable-tooltip-row', '静的な値域制約は設定されていません。実行時の値はシナリオ経路に依存します。');
    addDefinition(declaration);
  }
  variableTooltip.hidden = false;
  const bounds = variableTooltip.getBoundingClientRect();
  variableTooltip.style.left = `${Math.max(8, Math.min(event.clientX + 14, window.innerWidth - bounds.width - 8))}px`;
  variableTooltip.style.top = `${Math.max(8, Math.min(event.clientY + 14, window.innerHeight - bounds.height - 8))}px`;
  return true;
}

async function showVariableTooltip(event, requestId) {
  const token = sourceTokenAtEvent(event);
  if (!token) return false;
  const file = sceneName.value;
  const source = editor.value;
  const variables = await compiledVariablesForCurrentSource(file, source);
  if (requestId !== variableTooltipRequestId || sceneName.value !== file || editor.value !== source) return false;
  const exactMatches = variables.filter((variable) => variable.name === token.name && [...(variable.definitions || []), ...(variable.references || [])].some((location) => Number(location.line) === token.line && Number(location.column) === token.column + 1));
  // Some expression forms (notably `{...}` interpolation) report line-only
  // reference locations from the compiler. Resolve those only when the line
  // identifies one unambiguous variable, preserving shadowing correctness.
  const lineMatches = exactMatches.length ? exactMatches : variables.filter((variable) => variable.name === token.name
    && [...(variable.definitions || []), ...(variable.references || [])].some((location) => Number(location.line) === token.line));
  const matches = lineMatches.length === 1 ? lineMatches : exactMatches;
  if (matches.length !== 1) return false;
  const variable = matches[0];
  let symbolInfo = null;
  try { symbolInfo = await editorSymbolsForCurrentSource(file, source); } catch { /* Compiler facts remain useful for temporarily incomplete source. */ }
  if (requestId !== variableTooltipRequestId || sceneName.value !== file || editor.value !== source) return false;
  const definitionLocations = (variable.definitions || []).filter(location => (location.file || file) === file);
  const declaration = symbolInfo?.variables?.find(item => item.name === variable.name && item.file === file
    && definitionLocations.some(location => Number(location.line) === Number(item.line) && Number(location.column) === Number(item.column)));
  variableTooltip.replaceChildren();
  const title = document.createElement('strong');
  title.className = 'variable-tooltip-title';
  title.textContent = `${variable.name} : ${valueTypeLabel(variable.type)}`;
  variableTooltip.append(title);
  const scope = document.createElement('div');
  scope.className = 'variable-tooltip-row';
  scope.textContent = `Scope: ${variable.scope}${variable.definedIn && variable.definedIn !== 'global' ? ` (${variable.definedIn})` : ''}`;
  variableTooltip.append(scope);
  if (declaration?.initial) {
    const initial = document.createElement('div');
    initial.className = 'variable-tooltip-row';
    initial.textContent = `宣言時の初期値: ${expressionPreview(declaration.initial)}`;
    variableTooltip.append(initial);
  }
  const mutability = document.createElement('div');
  mutability.className = 'variable-tooltip-row';
  mutability.textContent = declaration?.constant || variable.mutable === false || variable.readonly ? '定数・読み取り専用です' : '変更可能です';
  variableTooltip.append(mutability);
  const constraint = variable.constraint || {};
  if (constraint.min !== undefined || constraint.max !== undefined) {
    const range = document.createElement('div');
    range.className = 'variable-tooltip-row variable-tooltip-constraint';
    range.textContent = `許容範囲: ${constraint.min ?? '下限なし'} ～ ${constraint.max ?? '上限なし'}`;
    variableTooltip.append(range);
  }
  const allowedValues = constraint.possibleValues || constraint.values;
  if (Array.isArray(allowedValues) && allowedValues.length) {
    const values = document.createElement('div');
    values.className = 'variable-tooltip-row variable-tooltip-constraint';
    values.textContent = `設定された値: ${allowedValues.map(String).join(', ')}`;
    variableTooltip.append(values);
  }
  const addLocations = (label, locations) => {
    const heading = document.createElement('div');
    heading.className = 'variable-tooltip-heading';
    heading.textContent = `${label} (${locations.length})`;
    variableTooltip.append(heading);
    if (!locations.length) {
      const empty = document.createElement('div');
      empty.className = 'variable-tooltip-empty';
      empty.textContent = 'なし';
      variableTooltip.append(empty);
      return;
    }
    const appendLocation = (location) => {
      const fileName = location.file || sceneName.value;
      const position = location.line ? `:${location.line}${location.column ? `:${location.column}` : ''}` : '';
      if (!sceneNames.includes(fileName)) {
        const text = document.createElement('div');
        text.className = 'variable-tooltip-empty';
        text.textContent = `${fileName}${position}`;
        variableTooltip.append(text);
        return;
      }
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'variable-tooltip-location';
      button.textContent = `${fileName}:${location.line || '?'}${location.column ? `:${location.column}` : ''}`;
      button.title = `${location.kind || '参照'} ${location.container || ''}`.trim();
      button.addEventListener('click', () => jumpToLocation(location, variable.name).catch(showError));
      variableTooltip.append(button);
    };
    const first = locations.slice(0, 10);
    first.forEach(appendLocation);
    if (locations.length > first.length) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'variable-tooltip-more';
      more.textContent = `残り ${locations.length - first.length} 件を表示`;
      more.addEventListener('click', () => { more.remove(); locations.slice(10).forEach(appendLocation); });
      variableTooltip.append(more);
    }
  };
  const references = variable.references || [];
  addLocations('定義', variable.definitions || []);
  addLocations('代入', references.filter((location) => location.kind === 'assignment'));
  addLocations('参照・埋め込み', references.filter((location) => location.kind !== 'assignment'));
  variableTooltip.hidden = false;
  const bounds = variableTooltip.getBoundingClientRect();
  variableTooltip.style.left = `${Math.max(8, Math.min(event.clientX + 14, window.innerWidth - bounds.width - 8))}px`;
  variableTooltip.style.top = `${Math.max(8, Math.min(event.clientY + 14, window.innerHeight - bounds.height - 8))}px`;
  return true;
}

function showSyntaxTooltip(event) {
  const match = sourceTokenAtEvent(event);
  const hint = match && syntaxHints[match.name];
  if (!hint) return false;
  variableTooltip.replaceChildren();
  const title = document.createElement('strong'); title.className = 'variable-tooltip-title'; title.textContent = match.name;
  const body = document.createElement('div'); body.className = 'syntax-tooltip-signature'; body.textContent = hint;
  const recipe = syntaxRecipes[match.name];
  variableTooltip.append(title, body);
  if (recipe?.description) {
    const description = document.createElement('div'); description.className = 'syntax-tooltip-description'; description.textContent = recipe.description;
    variableTooltip.append(description);
  }
  if (recipe?.snippet && !recipe.snippet.includes('¦')) {
    const example = document.createElement('pre'); example.className = 'syntax-tooltip-example'; example.textContent = recipe.snippet;
    variableTooltip.append(example);
  }
  const guideButton = document.createElement('button'); guideButton.type = 'button'; guideButton.className = 'syntax-tooltip-link'; guideButton.textContent = 'Open Syntax Reference';
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
  const insertion = speakerCompletion ? `${candidate} ""` : showCharacterCompletion ? `${candidate}.` : `${completionRange.insertLeadingSpace ? ' ' : ''}${candidate}`;
  rememberUndo();
  editor.value = `${source.slice(0, completionRange.start)}${insertion}${source.slice(replaceEnd)}`;
  const caret = completionRange.start + (speakerCompletion ? candidate.length + 2 : candidate.endsWith('()') && !showCharacterCompletion ? insertion.length - 1 : insertion.length);
  editor.focus();
  editor.setSelectionRange(caret, caret);
  editor.dispatchEvent(new Event('input'));
  hideSuggestions();
  return true;
}

function clearAssetDocumentView() {
  activeAssetDocument = '';
  document.documentElement.classList.remove('asset-document-open');
  document.querySelector('.editor-group')?.classList.remove('image-document-open');
  if (assetDocumentViewer) assetDocumentViewer.hidden = true;
  if (assetDocumentImage) { assetDocumentImage.hidden = true; assetDocumentImage.removeAttribute('src'); }
  if (assetDocumentVideo) { assetDocumentVideo.pause(); assetDocumentVideo.hidden = true; assetDocumentVideo.removeAttribute('src'); assetDocumentVideo.load(); }
  if (assetDocumentAudio) { assetDocumentAudio.pause(); assetDocumentAudio.hidden = true; assetDocumentAudio.removeAttribute('src'); assetDocumentAudio.load(); }
  resetAssetDocumentMetadata();
  if (assetDocumentError) { assetDocumentError.hidden = true; assetDocumentError.textContent = ''; }
}

function setAssetDocumentMetadata(field, value) {
  const target = assetDocumentMetadataFields[field];
  if (!target) return;
  target.textContent = value || '—';
  target.title = value || '';
}

function resetAssetDocumentMetadata() {
  for (const field of Object.values(assetDocumentMetadataFields)) {
    field.textContent = '—';
    field.removeAttribute('title');
  }
  if (assetDocumentMetadataLabels.orientation) assetDocumentMetadataLabels.orientation.textContent = 'Orientation';
}

function formatAssetSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '取得できません';
  if (bytes < 1024) return `${bytes.toLocaleString('ja-JP')} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unitIndex = -1;
  do { value /= 1024; unitIndex++; } while (value >= 1024 && unitIndex < units.length - 1);
  return `${value.toLocaleString('ja-JP', { maximumFractionDigits: 2 })} ${units[unitIndex]} (${bytes.toLocaleString('ja-JP')} B)`;
}

function formatAssetDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = total % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}` : `${minutes}:${String(remainder).padStart(2, '0')}`;
}

function setAssetDocumentDimensions(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
  const roundedWidth = Math.round(width);
  const roundedHeight = Math.round(height);
  let a = roundedWidth;
  let b = roundedHeight;
  while (b) [a, b] = [b, a % b];
  setAssetDocumentMetadata('width', `${roundedWidth.toLocaleString('ja-JP')} px`);
  setAssetDocumentMetadata('height', `${roundedHeight.toLocaleString('ja-JP')} px`);
  setAssetDocumentMetadata('ratio', `${roundedWidth / a}:${roundedHeight / a}`);
  const pixelCount = roundedWidth * roundedHeight;
  setAssetDocumentMetadata('pixels', `${(pixelCount / 1_000_000).toLocaleString('ja-JP', { maximumFractionDigits: 2 })} MP (${pixelCount.toLocaleString('ja-JP')} px)`);
  setAssetDocumentMetadata('orientation', roundedWidth === roundedHeight ? 'Square' : roundedWidth > roundedHeight ? 'Landscape' : 'Portrait');
}

function loadAssetDocumentMetadata(name, mediaKind) {
  resetAssetDocumentMetadata();
  const extension = name.split('.').at(-1)?.toUpperCase() || 'Unknown';
  setAssetDocumentMetadata('format', extension);
  if (mediaKind === 'audio') {
    if (assetDocumentMetadataLabels.orientation) assetDocumentMetadataLabels.orientation.textContent = 'Type';
    setAssetDocumentMetadata('orientation', 'Audio');
  }
  request(`/api/asset-info?path=${encodeURIComponent(name)}`).then((info) => {
    if (activeAssetDocument !== name) return;
    const mime = info.mimeType ? ` (${info.mimeType})` : '';
    setAssetDocumentMetadata('format', `${(info.extension || extension).toUpperCase()}${mime}`);
    setAssetDocumentMetadata('size', formatAssetSize(info.sizeBytes));
    const modified = new Date(info.modifiedAt);
    setAssetDocumentMetadata('modified', Number.isNaN(modified.valueOf()) ? 'Unknown' : new Intl.DateTimeFormat('ja-JP', {
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).format(modified));
  }).catch(() => {
    if (activeAssetDocument !== name) return;
    setAssetDocumentMetadata('size', '取得できません');
    setAssetDocumentMetadata('modified', '取得できません');
  });
}

async function openAssetDocument(name) {
  const navigationSequence = ++documentNavigationSequence;
  const normalized = String(name || '').replaceAll('\\', '/');
  const mediaKind = assetMediaKind(normalized);
  if (!mediaKind) throw Error('Editor内で開ける画像・音声・動画ファイルではありません');
  const url = assetDocumentUrl(normalized);
  if (activeAssetDocument === normalized) return true;
  if (sceneName.value && sceneName.value !== normalized && isDirty) await saveScene();
  if (navigationSequence !== documentNavigationSequence) return false;
  clearAssetDocumentView();
  activeSettingDocument = '';
  activeStandardLibraryDocument = '';
  activeAssetDocument = normalized;
  editor.value = '';
  editor.readOnly = true;
  sceneRevision = '';
  clearEditorHistory();
  updateDirtyState(false);
  updateLineNumbers();
  updateHighlight();
  hideSuggestions();
  document.documentElement.classList.add('asset-document-open');
  document.querySelector('.editor-group')?.classList.add('image-document-open');
  assetDocumentViewer.hidden = false;
  assetDocumentKind.textContent = mediaKind.toUpperCase();
  assetDocumentPath.textContent = normalized;
  assetDocumentPath.title = normalized;
  loadAssetDocumentMetadata(normalized, mediaKind);
  assetDocumentError.hidden = true;
  assetDocumentError.textContent = '';
  assetDocumentImage.hidden = true;
  assetDocumentVideo.hidden = true;
  assetDocumentAudio.hidden = true;
  if (!openTabs.includes(normalized)) openTabs.push(normalized);
  renderEditorTabs(normalized);
  result.textContent = '';
  if (mediaKind === 'image') {
    assetDocumentImage.alt = normalized;
    assetDocumentImage.onload = () => {
      if (activeAssetDocument !== normalized) return;
      setAssetDocumentDimensions(assetDocumentImage.naturalWidth, assetDocumentImage.naturalHeight);
    };
    assetDocumentImage.onerror = () => {
      if (activeAssetDocument !== normalized) return;
      assetDocumentError.textContent = `画像を読み込めませんでした: ${normalized}`;
      assetDocumentError.hidden = false;
    };
    assetDocumentImage.src = url;
    assetDocumentImage.hidden = false;
  } else if (mediaKind === 'video') {
    assetDocumentVideo.onloadedmetadata = () => {
      if (activeAssetDocument === normalized) {
        setAssetDocumentDimensions(assetDocumentVideo.videoWidth, assetDocumentVideo.videoHeight);
        setAssetDocumentMetadata('duration', formatAssetDuration(assetDocumentVideo.duration));
      }
    };
    assetDocumentVideo.onerror = () => {
      if (activeAssetDocument !== normalized) return;
      assetDocumentError.textContent = `動画を読み込めませんでした: ${normalized}`;
      assetDocumentError.hidden = false;
    };
    assetDocumentVideo.src = url;
    assetDocumentVideo.hidden = false;
  } else {
    assetDocumentAudio.onloadedmetadata = () => {
      if (activeAssetDocument === normalized) setAssetDocumentMetadata('duration', formatAssetDuration(assetDocumentAudio.duration));
    };
    assetDocumentAudio.onerror = () => {
      if (activeAssetDocument !== normalized) return;
      assetDocumentError.textContent = `音声を読み込めませんでした: ${normalized}`;
      assetDocumentError.hidden = false;
    };
    assetDocumentAudio.src = url;
    assetDocumentAudio.hidden = false;
  }
  setStatus(`${normalized} をEditor内で開きました`);
  return true;
}

async function openScene(name) {
  const navigationSequence = ++documentNavigationSequence;
  if (isStandardLibraryPath(name)) return openStandardLibraryFile(name);
  if (sceneName?.value && sceneName.value !== name && isDirty) await saveScene();
  if (navigationSequence !== documentNavigationSequence) return false;
  const scene = await request(`/api/scene?name=${encodeURIComponent(name)}`);
  if (navigationSequence !== documentNavigationSequence) return false;
  clearAssetDocumentView();
  activeSettingDocument = '';
  activeStandardLibraryDocument = '';
  editor.readOnly = false;
  variableTooltipRequestId++;
  currentVariableAnalysis = null;
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
  return true;
}

async function openStandardLibraryFile(name) {
  const navigationSequence = ++documentNavigationSequence;
  if (!isStandardLibraryPath(name)) throw Error('Standard Libraryのパスが不正です。');
  if (sceneName?.value && sceneName.value !== name && isDirty && !activeStandardLibraryDocument) await saveScene();
  if (navigationSequence !== documentNavigationSequence) return false;
  const file = await request(`/api/standard-library-file?name=${encodeURIComponent(name)}`);
  if (navigationSequence !== documentNavigationSequence) return false;
  clearAssetDocumentView();
  activeSettingDocument = '';
  activeStandardLibraryDocument = file.name;
  variableTooltipRequestId++;
  currentVariableAnalysis = null;
  currentEditorSymbols = null;
  if (!openTabs.includes(file.name)) openTabs.push(file.name);
  localStorage.setItem(lastSceneKey(), file.name);
  sceneName.value = file.name;
  editor.value = file.source;
  editor.readOnly = true;
  sceneRevision = '';
  clearEditorHistory();
  updateDirtyState(false);
  updateLineNumbers();
  updateHighlight();
  result.textContent = '';
  hideSuggestions();
  setStatus(`${file.name} · Standard Library (read-only)`);
  renderEditorTabs(file.name);
  return true;
}

async function openSettingFile(name) {
  const navigationSequence = ++documentNavigationSequence;
  if (sceneName?.value && sceneName.value !== name && isDirty) await saveScene();
  if (navigationSequence !== documentNavigationSequence) return false;
  const file = await request(`/api/setting-file?name=${encodeURIComponent(name)}`);
  if (navigationSequence !== documentNavigationSequence) return false;
  clearAssetDocumentView();
  activeSettingDocument = file.name;
  if (!openTabs.includes(file.name)) openTabs.push(file.name);
  activeStandardLibraryDocument = '';
  sceneName.value = file.name;
  editor.value = file.source;
  editor.readOnly = false;
  sceneRevision = String(file.revision || '');
  clearEditorHistory();
  updateDirtyState(false);
  updateLineNumbers();
  updateHighlight();
  renderEditorTabs(file.name);
  result.textContent = '';
  hideSuggestions();
  setStatus(`${file.name} を開きました`);
  return true;
}

async function openEditorDocument(name) {
  const normalized = String(name || '').replaceAll('\\', '/');
  if (normalized.startsWith('asset/')) return openAssetDocument(normalized);
  if (normalized.startsWith('setting/') || normalized === 'setting.txt') return openSettingFile(normalized);
  if (isStandardLibraryPath(normalized)) return openStandardLibraryFile(normalized);
  return openScene(normalized);
}

async function jumpToLocation(location, symbol = '') {
  const requestedFile = String(location.file || sceneName.value);
  const file = requestedFile === 'current' ? sceneName.value : scenarioRelativePath(requestedFile) ?? requestedFile;
  if (file && isStandardLibraryPath(file) && normalizedScenePath(file) !== normalizedScenePath(sceneName.value)) {
    if (!(await openStandardLibraryFile(file))) return;
  }
  else if (file && normalizedScenePath(file) !== normalizedScenePath(sceneName.value)) {
    if (!sceneNames.includes(file)) { setStatus(`'${file}' は現在のプロジェクトにありません`, 'warning'); return; }
    if (!(await openScene(file))) return;
  }
  const line = Math.max(1, Number(location.line) || 1);
  let column = Math.max(0, Number(location.column) - 1 || 0);
  const lineStart = splitEditorLines(editor.value).slice(0, line - 1).reduce((total, value) => total + value.length + 1, 0);
  const lineText = splitEditorLines(editor.value)[line - 1] || '';
  const candidates = [...new Set([symbol, String(symbol).split('.').at(-1)].filter(Boolean))];
  let selected = 0;
  if (symbol && lineText.slice(column, column + symbol.length) === symbol) selected = symbol.length;
  else {
    const found = candidates.map(candidate => ({ candidate, index: lineText.indexOf(candidate, column) })).find(item => item.index >= 0);
    if (found) { column = found.index; selected = found.candidate.length; }
  }
  const caret = Math.min(editor.value.length, lineStart + column);
  editor.focus();
  editor.setSelectionRange(caret, caret + selected);
  editor.scrollTop = Math.max(0, (line - 1) * editorLineHeight() - 70);
  hideVariableTooltip();
}

async function jumpToScene(file, scene) {
  const requestedFile = String(file || sceneName.value);
  const targetFile = scenarioRelativePath(requestedFile) ?? requestedFile;
  if (targetFile && normalizedScenePath(targetFile) !== normalizedScenePath(sceneName.value)) await openScene(targetFile);
  const escaped = scene.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`^\\s*scene\\s+${escaped}\\b`, 'm').exec(editor.value);
  if (!match) throw Error(`Scene '${scene}' の定義が見つかりません`);
  const start = match.index + match[0].lastIndexOf(scene);
  const line = splitEditorLines(editor.value.slice(0, start)).length;
  revealEditorRange(start, start + scene.length, line);
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
    button.title = 'Click to jump to this line';
    button.addEventListener('click', () => jumpToLocation(entry.location).catch(showError));
    result.append(button);
  }
}

function showPersistentBuildWarnings(entries) {
  const warnings = entries.filter(item => item.severity === 'warning' && item.buildBlocking);
  document.querySelector('#build-warning-toast')?.remove();
  if (!warnings.length) return;
  const toast = document.createElement('section');
  toast.id = 'build-warning-toast';
  toast.className = 'build-warning-toast';
  toast.setAttribute('role', 'alert');
  toast.setAttribute('aria-labelledby', 'build-warning-title');
  const header = document.createElement('header');
  const title = document.createElement('h2');
  title.id = 'build-warning-title';
  title.textContent = `Build warnings · ${warnings.length}`;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'build-warning-toast-close';
  close.textContent = '×';
  close.setAttribute('aria-label', '警告を閉じる');
  close.addEventListener('click', () => toast.remove());
  header.append(title, close);
  const list = document.createElement('ul');
  for (const warning of warnings) {
    const item = document.createElement('li');
    const location = document.createElement('button');
    location.type = 'button';
    location.className = 'build-warning-toast-location';
    location.textContent = `${warning.file || '現在のファイル'}:${Number(warning.line) || 1}`;
    location.title = `Open ${warning.file || 'current file'} at line ${Number(warning.line) || 1}`;
    location.addEventListener('click', () => jumpToLocation(warning).catch(showError));
    const message = document.createElement('span');
    message.textContent = warning.message;
    item.append(location, message);
    list.append(item);
  }
  toast.append(header, list);
  document.body.append(toast);
  close.focus();
}

function renderEditorTabs(activeName = activeAssetDocument || sceneName?.value) {
  if (!editorTabs) return;
  editorTabs.replaceChildren(...openTabs.map((name) => {
    const tab = document.createElement('div');
    tab.className = `editor-tab${name === activeName ? ' active' : ''}`;
    const select = document.createElement('button'); select.type = 'button'; select.className = 'editor-tab-name'; select.textContent = fileLabel(name); select.title = name;
    select.setAttribute('aria-label', name); select.setAttribute('aria-pressed', String(name === activeName));
    select.addEventListener('click', (event) => {
      if (event.shiftKey && !String(name).startsWith('asset/')) moveTabToRight(name).catch(showError);
      else if (name !== sceneName.value) openEditorDocument(name).catch(showError);
    });
    if (!String(name).startsWith('asset/')) {
      const split = document.createElement('button'); split.type = 'button'; split.className = 'editor-tab-split'; split.textContent = '→'; split.title = `Open ${name} in Right Pane`; split.setAttribute('aria-label', `Open ${name} in Right Pane`);
      split.addEventListener('click', () => moveTabToRight(name).catch(showError));
      tab.append(select, split);
    } else {
      tab.append(select);
    }
    const close = document.createElement('button'); close.type = 'button'; close.className = 'editor-tab-close'; close.textContent = '×'; close.title = `${name}を閉じる`; close.setAttribute('aria-label', `${name}を閉じる`);
    close.addEventListener('click', async () => {
      const activeName = activeAssetDocument || sceneName.value;
      if (isDirty && name === activeName && !window.confirm('未保存の変更があります。タブを閉じますか？')) return;
      const index = openTabs.indexOf(name); if (index >= 0) openTabs.splice(index, 1);
      if (name === activeName) {
        const next = openTabs[index] || openTabs[index - 1];
        if (next) await openEditorDocument(next); else {
          clearAssetDocumentView();
          if (sceneName.value && !sceneName.value.startsWith('asset/')) await openEditorDocument(sceneName.value);
          else {
            activeSettingDocument = ''; activeStandardLibraryDocument = '';
            sceneName.value = ''; editor.value = ''; editor.readOnly = false; clearEditorHistory(); updateLineNumbers(); updateHighlight(); updateDirtyState(false);
          }
        }
      }
      renderEditorTabs(activeAssetDocument || sceneName.value);
      renderSplitTabs();
    });
    tab.append(close); return tab;
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
    if (/[0-9]/.test(char)) { const value = /^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(line.slice(index))[0]; tokens.push({ kind: 'number', value }); index += value.length; continue; }
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
      const statementCommand = /^(?:return|set|unset|say|show|hide|clear|bg|bgm|play|wait|effect|goto|include|global|const|int|float|str|dict)\b/.test(statementPrefix);
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
  if (activeSettingDocument || activeStandardLibraryDocument || activeAssetDocument) return;
  const source = editor.value;
  const formatted = formatSource(source);
  if (formatted === source) return;
  replaceWithFormattedSource(source, editor.selectionStart, editor.selectionEnd);
}

async function saveScene() {
  if (activeAssetDocument) {
    setStatus(`${activeAssetDocument} · Asset previewは読み取り専用です`);
    return;
  }
  if (activeStandardLibraryDocument) {
    setStatus(`${activeStandardLibraryDocument} · Standard Library is read-only`);
    return;
  }
  if (activeSettingDocument) {
    const name = activeSettingDocument;
    const submittedSource = editor.value;
    const expectedRevision = sceneRevision;
    const saved = await request('/api/setting-file', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, source: submittedSource, ...(expectedRevision ? { expectedRevision } : {}) }),
    });
    const stillActive = activeSettingDocument === name && sceneRevision === expectedRevision;
    if (stillActive) {
      sceneRevision = String(saved.revision || '');
      updateDirtyState(editor.value !== submittedSource);
      setStatus(editor.value === submittedSource ? `${saved.name} を保存しました` : `${saved.name} の保存後に行った編集は未保存です`, editor.value === submittedSource ? 'ok' : 'warning');
    }
    if (name === 'setting/setting.txt') await refreshFiles();
    return;
  }
  // Saving is a durable boundary: persist the same canonical source that the
  // editor validates and previews, using the cursor-preserving formatter path.
  formatCode();
  const name = sceneName.value;
  const submittedSource = editor.value;
  const expectedRevision = sceneRevision;
  const saved = await request('/api/scene', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, source: submittedSource, ...(expectedRevision ? { expectedRevision } : {}) }),
  });
  const stillActive = sceneName.value === name && !activeSettingDocument && sceneRevision === expectedRevision;
  if (stillActive) {
    sceneRevision = String(saved.revision || '');
    if (!openTabs.includes(saved.name)) openTabs.push(saved.name);
    renderEditorTabs(sceneName.value);
    updateDirtyState(editor.value !== submittedSource);
  }
  await refreshScenes(sceneName.value);
  await refreshSceneGraph();
  const variableData = await request('/api/variables');
  setKnownVariableData(variableData);
  if (stillActive) setStatus(editor.value === submittedSource ? `${saved.name} を保存しました` : `${saved.name} の保存後に行った編集は未保存です`, editor.value === submittedSource ? 'ok' : 'warning');
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
  const hasUnsaved = isDirty || Boolean(splitApi?.isDirty?.());
  setStatus(hasUnsaved ? '保存要求後に行った編集が残っています。再度保存してください' : savedNames.length ? `${savedNames.length} ファイルを保存しました` : 'すべて保存済みです', hasUnsaved ? 'warning' : 'ok');
  return savedNames;
}

function hasUnsavedSceneChanges() {
  const splitApi = !splitGroup?.hidden ? splitFrame?.contentWindow?.novelEditorApi : null;
  return isDirty || Boolean(splitApi?.isDirty?.());
}

async function formatProjectScenes() {
  formatCode();
  const splitApi = !splitGroup?.hidden ? splitFrame?.contentWindow?.novelEditorApi : null;
  splitApi?.formatCurrent?.();
  await saveAllScenes();
  if (isDirty || splitApi?.isDirty?.()) throw Error('保存中に新しい編集がありました。保存し直してから Build を実行してください');
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
  setStatus(`${changed.length} ファイルを保存しました`, 'ok');
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

function captureEditorSnapshot() {
  return { file: sceneName.value, source: editor.value };
}
function editorMatchesSnapshot(snapshot) {
  return !activeAssetDocument && !activeSettingDocument
    && sceneName.value === snapshot.file && editor.value === snapshot.source;
}

async function validate(providedReport = null, expectedSnapshot = null) {
  if (activeAssetDocument) return false;
  const sequence = ++validationSequence;
  const sourceSnapshot = editor.value;
  const fileSnapshot = sceneName.value;
  if (providedReport && expectedSnapshot && !editorMatchesSnapshot(expectedSnapshot)) return false;
  let report = providedReport;
  if (!report) {
    report = await request('/api/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: fileSnapshot, source: sourceSnapshot }),
    });
    if (sequence !== validationSequence || fileSnapshot !== sceneName.value || sourceSnapshot !== editor.value) return;
  }
  currentVariableAnalysis = {
    file: fileSnapshot,
    source: sourceSnapshot,
    variables: Array.isArray(report?.program?.variables) ? report.program.variables : null,
    promise: null,
  };
  diagnostics = Array.isArray(report.diagnostics) ? report.diagnostics : [];
  // File info is initially populated from the saved scene graph. While a file
  // is being edited that graph can still carry its previous parse error, so
  // let a successful validation of the current buffer supersede that stale
  // graph status instead of leaving "syntax error" stuck in the sidebar.
  if (report.ok && fileInfoBase && typeof fileInfoBase === 'object'
    && normalizedScenePath(fileInfoBase.path) === normalizedScenePath(fileSnapshot)) {
    delete fileInfoBase.error;
    renderFileInfo();
  }
  if (!diagnostics.length && !report.ok) {
    const message = String(report.error || 'syntax error');
    const assetPath = message.match(/(?:asset|アセット)\s*'([^']+)'/)?.[1];
    const assetLine = assetPath ? splitEditorLines(editor.value).findIndex((value) => value.includes(assetPath)) + 1 : 0;
    const line = Number(message.match(/line\s+(\d+)/i)?.[1] || assetLine || 1);
    const column = Number(message.match(/column\s+(\d+)/i)?.[1] || 1);
    diagnostics = [{ severity: 'error', code: 'error', line, column, message }];
  }
  const sourceLines = splitEditorLines(editor.value);
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
      text: `${({ error: 'Error', warning: 'Warning', info: 'Info' }[item.severity] || item.severity)} ${item.code}  ${diagnosticForCurrentFile(item) ? '' : `${item.file} `}行 ${item.line}:${item.column}  ${item.message}`,
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
      text: `${({ error: 'Error', warning: 'Warning', info: 'Info' }[item.severity] || item.severity)} ${item.code}  ${diagnosticForCurrentFile(item) ? '' : `${item.file} `}${lineRangeLabel(range)}  ${item.message}`,
      });
    }
  }
  diagnosticText = displayedDiagnostics.sort((left, right) => left.line - right.line || left.index - right.index).map((item) => item.text).join('\n');
  updateHighlight();
  const unreachableLines = [...unreachableGroups.values()].filter((group) => diagnosticForCurrentFile(group.item)).flatMap((group) => group.lines);
if (fileInfoBase && typeof fileInfoBase === 'object') {
  fileInfoBase.unreachableRanges = contiguousLineRanges(unreachableLines, sourceLines).map(lineRangeLabel);
  renderFileInfo();
}
  if (report.build) showPersistentBuildWarnings(diagnostics);
  if (report.ok) {
    const warningCount = displayedDiagnostics.filter((item) => item.severity === 'warning').length;
    const infoCount = displayedDiagnostics.filter((item) => item.severity === 'info').length;
    const fileCountLabel = `${report.fileCount} file${report.fileCount === 1 ? '' : 's'}`;
    const summary = report.build
      ? `Compile complete: ${fileCountLabel} / 0 errors / ${warningCount} warnings / ${infoCount} info`
      : `Analysis complete: Error 0 / Warning ${warningCount} / Info ${infoCount}`;
    if (warningCount || infoCount) renderDiagnosticResult(summary, displayedDiagnostics);
    else if (report.build) result.textContent = `${summary}\n${report.name}\n${report.path}`;
     else result.textContent = `問題ありません。\nStatements: ${report.statements}\nInstructions: ${report.instructions}`;
    if (report.build) setStatus(`Build complete: ${fileCountLabel} / Warning ${warningCount} / Info ${infoCount}`, warningCount ? 'warning' : 'ok');
    else setStatus(`Validation complete: Error 0 / Warning ${warningCount} / Info ${infoCount}`, warningCount ? 'warning' : 'ok');
  } else {
    const errorCount = diagnostics.filter((item) => item.severity === 'error').length;
    const fileCountLabel = `${report.fileCount} file${report.fileCount === 1 ? '' : 's'}`;
    renderDiagnosticResult(report.build ? `Build failed: Error ${errorCount} / ${fileCountLabel}` : `Analysis error: ${errorCount}`, displayedDiagnostics);
    setStatus(report.build ? `Build failed: Error ${errorCount} / ${fileCountLabel}` : `Validation error: ${errorCount}`, 'error');
  }
  return true;
}

function scheduleValidation() {
  clearTimeout(validationTimer);
  if (activeSettingDocument) { result.textContent = ''; return; }
  validationTimer = setTimeout(() => validate().catch(showError), 1000);
}

async function saveAllFromMenu() {
  await saveAllScenes();
  setStatus('すべて保存しました', 'ok');
}
async function compileProjectFromMenu() {
  setStatus('Native build: checking all files…');
  // A previous build warning refers to an older source snapshot. Clear it as
  // soon as another build starts, including when that response becomes stale.
  document.querySelector('#build-warning-toast')?.remove();
  // Compilation is a durable project boundary: normalize every scene before
  // the build reads closed files, not only the scene currently in the editor.
  await formatProjectScenes();
  const buildSnapshot = captureEditorSnapshot();
  const report = await request('/api/project-build', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: sceneName.value }),
  });
  if (!await validate(report, buildSnapshot)) {
    scheduleValidation();
     setStatus('Build が完了しました。現在の編集内容を検証しています…', 'warning');
  }
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
  const sourceLine = splitEditorLines(editor.value)[lineIndex] || '';
  const match = /^\s*goto\s+(?:"([^"]+)"|([A-Za-z0-9_./-]+))/.exec(sourceLine);
  return match ? (match[1] || match[2]) : '';
}
function fileReferenceAtEvent(event) {
  const exactOffset = sourceOffsetAtEvent(event);
  let location;
  if (exactOffset !== null) {
    const prefix = editor.value.slice(0, exactOffset);
    const lineStart = prefix.lastIndexOf('\n') + 1;
    location = { line: splitEditorLines(prefix).length, column: exactOffset - lineStart, sourceLine: splitEditorLines(editor.value.slice(lineStart))[0] || '' };
  } else location = sourceTokenAtEvent(event);
  if (!location) return null;
  const { sourceLine, column } = location;
  const definitions = [
    { kind: 'asset', pattern: /^\s*(?:asset\s+(?:bg|bgm|se|voice|video|image|char)\s+[A-Za-z_][A-Za-z0-9_]*\s*=\s*|pose\s+[A-Za-z_][A-Za-z0-9_]*\s*=\s*)"((?:\\.|[^"\\])*)"/i },
    { kind: 'include', pattern: /^\s*include\s+"((?:\\.|[^"\\])*)"/i },
    { kind: 'goto', pattern: /^\s*goto\s+(?:"((?:\\.|[^"\\])*)"|([A-Za-z0-9_./\\-]+))/i },
  ];
  for (const { kind, pattern } of definitions) {
    const match = pattern.exec(sourceLine);
    if (!match) continue;
    const quotedPath = match[1];
    const rawPath = quotedPath ?? match[2];
    if (!rawPath) continue;
    const start = match.index + match[0].indexOf(rawPath);
    if (column < start - 1 || column > start + rawPath.length) continue;
    const matchesSceneFile = kind === 'goto' && sceneNames.some(file => file === rawPath || file.replace(/\.tds$/i, '') === rawPath);
    if (kind === 'goto' && quotedPath === undefined && !rawPath.includes('/') && !/\.tds$/i.test(rawPath) && !matchesSceneFile) continue;
    return { kind, path: rawPath.replaceAll('\\', '/'), rawPath };
  }
  return null;
}
async function openFileReference(reference) {
  if (reference.kind === 'asset') {
    if (assetMediaKind(reference.path)) return openAssetDocument(reference.path);
    setStatus('このasset formatはEditor内でPreviewできません', 'warning');
    return;
  }
  if (isStandardLibraryPath(reference.path)) return openStandardLibraryFile(reference.path);
  return openScene(reference.path);
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

function closeEditorContextMenu() {
  editorContextMenu.hidden = true;
  editorContextMenu.replaceChildren();
}

function editorDefinitionLocation(location, symbol) {
  if (!location) return null;
  return { file: location.file || sceneName.value, line: location.line, column: location.column, symbol };
}

async function definitionLocationAtToken(token) {
  const file = sceneName.value;
  const source = editor.value;
  const symbols = await editorSymbolsForCurrentSource(file, source);
  const name = qualifiedTokenName(token);
  const groups = [symbols.functions, symbols.structs, symbols.characters, symbols.assets, symbols.scenes, symbols.includes];
  for (const items of groups) {
    const exact = (items || []).find(item => item.name === name && item.file === file && Number(item.line) === token.line);
    if (exact) return editorDefinitionLocation(exact, name.split('.').at(-1));
  }
  const named = groups.flat().filter(item => item && item.name === name);
  if (named.length === 1) return editorDefinitionLocation(named[0], name.split('.').at(-1));

  const fields = (symbols.structs || []).flatMap(item => (item.fields || []).map(field => ({ ...field, file: item.file || file, structName: item.name })));
  const field = fields.find(item => item.name === token.name && item.file === file
    && Number(item.line) === token.line && Number(item.column) === token.column + 1);
  if (field) return editorDefinitionLocation(field, field.name);

  const declaration = (symbols.variables || []).find(item => item.name === token.name && item.file === file
    && Number(item.line) === token.line && Number(item.column) === token.column + 1);
  if (declaration) return editorDefinitionLocation(declaration, token.name);

  const variables = await compiledVariablesForCurrentSource(file, source);
  const atToken = location => (location.file || file) === file && Number(location.line) === token.line && Number(location.column) === token.column + 1;
  const exactVariables = variables.filter(item => item.name === token.name
    && [...(item.definitions || []), ...(item.references || [])].some(atToken));
  const lineVariables = exactVariables.length ? exactVariables : variables.filter(item => item.name === token.name
    && [...(item.definitions || []), ...(item.references || [])].some(location => (location.file || file) === file && Number(location.line) === token.line));
  if (lineVariables.length === 1 && lineVariables[0].definitions?.length) {
    return editorDefinitionLocation(lineVariables[0].definitions[0], token.name);
  }
  return null;
}

async function jumpToTokenDefinition(token) {
  const location = await definitionLocationAtToken(token);
  if (!location) {
    setStatus('この位置の定義は見つかりません', 'warning');
    return;
  }
  await jumpToLocation(location, location.symbol);
}

async function showEditorSymbolInfo(event, token) {
  const requestId = ++variableTooltipRequestId;
  hideVariableTooltip();
  if (showGotoMenu(event)) return;
  // A reserved word may also be a method name in a qualified standard API
  // (for example `walk.character`). Prefer resolving that full symbol before
  // showing the standalone `character` declaration syntax hint.
  if (token && syntaxHints[token.name] && !qualifiedTokenName(token).includes('.')) {
    showSyntaxTooltip(event);
    return;
  }
  try {
    const shown = await showVariableTooltip(event, requestId);
    if (requestId !== variableTooltipRequestId || shown) return;
    const declared = await showDeclarationTooltip(event, requestId, token);
    if (requestId === variableTooltipRequestId && !declared) showSyntaxTooltip(event);
  } catch {
    if (requestId !== variableTooltipRequestId) return;
    try {
      const declared = await showDeclarationTooltip(event, requestId, token);
      if (requestId === variableTooltipRequestId && !declared) showSyntaxTooltip(event);
    } catch {
      if (requestId === variableTooltipRequestId) showSyntaxTooltip(event);
    }
  }
}

async function pasteEditorClipboard() {
  if (editor.readOnly) return;
  if (!navigator.clipboard?.readText) throw new Error('クリップボードの読み取りを利用できません');
  const text = await navigator.clipboard.readText();
  insertFormattedExternalText(text);
}

function showEditorContextMenu(event) {
  closeFileContextMenu();
  variableTooltipRequestId++;
  hideVariableTooltip();
  const token = sourceTokenAtEvent(event);
  const fileReference = fileReferenceAtEvent(event);
  const gotoTarget = fileReference?.kind === 'goto' ? '' : gotoAtEvent(event);
  const selectionExists = editor.selectionStart !== editor.selectionEnd;
  editorContextMenu.replaceChildren();

  const addItem = (label, shortcut, action, disabled = false) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'editor-context-item';
    button.setAttribute('role', 'menuitem');
    button.disabled = disabled;
    const title = document.createElement('span');
    title.className = 'editor-context-label';
    title.textContent = label;
    button.append(title);
    if (shortcut) {
      const key = document.createElement('span');
      key.className = 'editor-context-shortcut';
      key.textContent = shortcut;
      button.append(key);
    }
    button.addEventListener('click', event => {
      event.stopPropagation();
      if (button.disabled) return;
      closeEditorContextMenu();
      Promise.resolve().then(action).catch(showError);
    });
    editorContextMenu.append(button);
  };
  const addSeparator = () => editorContextMenu.append(Object.assign(document.createElement('span'), { className: 'editor-context-separator', role: 'separator' }));

  let hasNavigation = false;
  if (fileReference) {
    const mediaKind = fileReference.kind === 'asset' ? assetMediaKind(fileReference.path) : '';
    if (fileReference.kind !== 'asset' || mediaKind) {
      const label = fileReference.kind === 'include' ? 'include先を開く'
        : fileReference.kind === 'goto' ? '遷移ファイルを開く'
          : mediaKind === 'image' ? 'Open Image in Editor' : 'Open Media in Editor';
      addItem(label, '', () => openFileReference(fileReference));
    }
    addItem('相対パスをコピー', '', () => copyText(fileReference.path));
    hasNavigation = true;
  }
  if (gotoTarget) {
    addItem('移動先を開く', '', () => openScene(gotoTarget).catch(showError));
    hasNavigation = true;
  }
  if (token && !fileReference) {
    addItem('定義へ移動', 'F12', () => jumpToTokenDefinition(token).catch(showError));
    addItem('Show Symbol Info', '', () => showEditorSymbolInfo(event, token));
    hasNavigation = true;
  }
  if (hasNavigation) addSeparator();
  addItem('貼り付け', 'Ctrl+V', () => pasteEditorClipboard().catch(error => setStatus(error.message, 'warning')), editor.readOnly);
  addSeparator();
  addItem('すべて選択', 'Ctrl+A', () => { editor.focus(); editor.select(); });

  editorContextMenu.style.left = '0px';
  editorContextMenu.style.top = '0px';
  editorContextMenu.hidden = false;
  const bounds = editorContextMenu.getBoundingClientRect();
  editorContextMenu.style.left = `${Math.max(6, Math.min(event.clientX, window.innerWidth - bounds.width - 6))}px`;
  editorContextMenu.style.top = `${Math.max(6, Math.min(event.clientY, window.innerHeight - bounds.height - 6))}px`;
  editorContextMenu.querySelector('button:not(:disabled)')?.focus();
}

editorContextMenu.addEventListener('keydown', event => {
  const items = [...editorContextMenu.querySelectorAll('button:not(:disabled)')];
  if (!items.length) return;
  const current = items.indexOf(document.activeElement);
  let next = null;
  if (event.key === 'ArrowDown') next = (current + 1 + items.length) % items.length;
  else if (event.key === 'ArrowUp') next = (current - 1 + items.length) % items.length;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = items.length - 1;
  else if (event.key === 'Escape') {
    event.preventDefault();
    closeEditorContextMenu();
    editor.focus();
    return;
  }
  if (next !== null) {
    event.preventDefault();
    items[next].focus();
  }
});
fileContextMenu.addEventListener('keydown', event => {
  const items = [...fileContextMenu.querySelectorAll('button:not(:disabled)')];
  if (!items.length) return;
  const current = items.indexOf(document.activeElement);
  let next = null;
  if (event.key === 'ArrowDown') next = (current + 1 + items.length) % items.length;
  else if (event.key === 'ArrowUp') next = (current - 1 + items.length) % items.length;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = items.length - 1;
  else if (event.key === 'Escape') { event.preventDefault(); closeFileContextMenu(); return; }
  if (next !== null) { event.preventDefault(); items[next].focus(); }
});

function clearLeftEditor() {
  clearAssetDocumentView();
  activeSettingDocument = '';
  activeStandardLibraryDocument = '';
  editor.readOnly = false;
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
    const select = document.createElement('button'); select.type = 'button'; select.className = 'editor-tab-name'; select.textContent = fileLabel(name); select.title = name;
    select.setAttribute('aria-label', name); select.setAttribute('aria-pressed', String(name === activeSplitScene));
    select.addEventListener('click', () => openSplitScene(name));
    const move = document.createElement('button'); move.type = 'button'; move.className = 'editor-tab-unsplit'; move.textContent = '←'; move.title = `Move ${name} to Left Pane`; move.setAttribute('aria-label', `Move ${name} to Left Pane`);
    move.addEventListener('click', () => moveTabToLeft(name).catch(showError));
    const close = document.createElement('button'); close.type = 'button'; close.className = 'editor-tab-close'; close.textContent = '×'; close.title = `${name}を閉じる`; close.setAttribute('aria-label', `${name}を閉じる`);
    close.addEventListener('click', () => closeRightTab(name));
    tab.append(select, move, close);
    return tab;
  }));
}
function canActivateSplit(name) {
  const api = splitFrame?.contentWindow?.novelEditorApi;
  return !(activeSplitScene && activeSplitScene !== name && api?.isDirty?.() && !window.confirm('Right Paneに未保存の変更があります。別のファイルを開きますか？'));
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
  if (!skipDirtyCheck && api?.isDirty?.() && !window.confirm('Right Paneに未保存の変更があります。分割を閉じますか？')) return false;
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
    if (api?.isDirty?.() && !window.confirm('Right Paneに未保存の変更があります。タブを閉じますか？')) return false;
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
  if (hasUnsavedSceneChanges()) {
    setStatus('保存中に新しい編集がありました。保存し直してから再生してください', 'warning');
    return { ok: false, unsavedChanges: true };
  }
  const savedSnapshot = captureEditorSnapshot();
  const buildState = await request('/api/project-build-status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: sceneName.value }),
  });
  if (!editorMatchesSnapshot(savedSnapshot)) {
    scheduleValidation();
    setStatus('保存後に編集内容が変わりました。再生前にもう一度保存してください', 'warning');
    return { ok: false, changedWhileChecking: true };
  }
  if (!buildState.built) {
    const changed = Array.isArray(buildState.changedFiles) && buildState.changedFiles.length
      ? `\n${buildState.changedFiles.slice(0, 8).join('\n')}${buildState.changedFiles.length > 8 ? `\nほか ${buildState.changedFiles.length - 8} ファイル` : ''}`
      : '';
    if (!(await uiAsk(`The built scenario differs from the current content. Build first?${changed}`, 'Build and Play'))) return;
    if (!editorMatchesSnapshot(savedSnapshot)) {
      scheduleValidation();
      setStatus('確認中に編集内容が変わりました。再生前にもう一度保存してください', 'warning');
      return { ok: false, changedWhileChecking: true };
    }
    const buildSnapshot = captureEditorSnapshot();
    const buildReport = await request('/api/project-build', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: sceneName.value }),
    });
    if (!buildReport.ok) {
      if (!await validate(buildReport, buildSnapshot)) {
        scheduleValidation();
        setStatus('編集中に Build 対象が変更されました。現在の編集内容を検証しています…', 'warning');
      }
      return buildReport;
    }
    if (!await validate(buildReport, buildSnapshot)) {
      scheduleValidation();
      setStatus('編集中に Build 対象が変更されたため、再生を中止しました。', 'warning');
      return { ...buildReport, ok: false, changedWhileBuilding: true };
    }
  }
  if (!editorMatchesSnapshot(savedSnapshot)) {
    scheduleValidation();
    setStatus('再生前に編集内容が変わりました。再生を中止しました', 'warning');
    return { ok: false, changedWhileChecking: true };
  }
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
  return runNativeTool('test', 'Build and run all tests');
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
  editorFindScope = null;
  editorFindSelectionCandidate = null;
  editorFindScopeButton?.setAttribute('aria-pressed', 'false');
  editorFindScopeButton?.classList.remove('active');
  refreshEditorFind();
  variableTooltipRequestId++;
  hideVariableTooltip();
  currentVariableAnalysis = null;
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
  if (event.isComposing) return;
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
    insertEditorNewline();
    return;
  }
  if (!event.inputType?.startsWith('history')) rememberUndo();
});
editor.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  showEditorContextMenu(event);
});
document.addEventListener('click', (event) => {
  if (!variableTooltip.contains(event.target) && !editorContextMenu.contains(event.target)) hideVariableTooltip();
  if (!fileContextMenu.contains(event.target)) closeFileContextMenu();
  if (!editorContextMenu.contains(event.target)) closeEditorContextMenu();
});
document.addEventListener('keydown', (event) => {
  const formatKey = event.code === 'KeyF' || event.key?.toLowerCase() === 'f';
  const commandKey = event.ctrlKey || event.metaKey;
  const keyIs = (code, key) => event.code === code || event.key?.toLowerCase() === key.toLowerCase();
  if (pendingEditorChord && ['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) return;
  if (pendingEditorChord) {
    clearTimeout(editorChordTimer);
    pendingEditorChord = '';
    if (commandKey && !event.altKey && !event.shiftKey && (keyIs('KeyC', 'c') || keyIs('KeyU', 'u'))) {
      event.preventDefault();
      toggleLineComments(event.key?.toLowerCase() === 'u' ? 'uncomment' : 'comment');
      return;
    }
  }
  if (commandKey && !event.altKey && !event.shiftKey && keyIs('KeyK', 'k')) {
    event.preventDefault();
    pendingEditorChord = 'ctrl-k';
    editorChordTimer = setTimeout(() => { pendingEditorChord = ''; }, 900);
    return;
  }
  if (event.key === 'F1' || (commandKey && event.shiftKey && !event.altKey && keyIs('KeyP', 'p'))) {
    event.preventDefault();
    event.stopPropagation();
    openCommandPalette();
    return;
  }
  if (commandKey && !event.shiftKey && !event.altKey && keyIs('KeyP', 'p')) {
    event.preventDefault();
    event.stopPropagation();
    openQuickOpen();
    return;
  }
  if (commandKey && !event.shiftKey && !event.altKey && keyIs('KeyO', 'o')) {
    event.preventDefault();
    event.stopPropagation();
    chooseProjectFolder().catch(showError);
    return;
  }
  if (commandKey && !event.shiftKey && !event.altKey && keyIs('KeyG', 'g')) {
    event.preventDefault();
    event.stopPropagation();
    openQuickOpen('line');
    return;
  }
  if (commandKey && !event.shiftKey && !event.altKey && event.key === ',') {
    event.preventDefault();
    event.stopPropagation();
    showProjectSettings().catch(showError);
    return;
  }
  if (commandKey && !event.shiftKey && !event.altKey && keyIs('KeyB', 'b')) {
    event.preventDefault();
    event.stopPropagation();
    document.querySelector('.app-shell')?.classList.toggle('sidebar-hidden');
    return;
  }
  if (commandKey && event.shiftKey && !event.altKey && keyIs('KeyE', 'e')) {
    event.preventDefault();
    event.stopPropagation();
    activateExplorerView();
    if (fileTree) {
      fileTree.tabIndex = -1;
      fileTree.focus({ preventScroll: true });
    }
    return;
  }
  if (commandKey && event.shiftKey && !event.altKey && keyIs('KeyO', 'o')) {
    event.preventDefault();
    event.stopPropagation();
    openQuickOpen('symbol');
    return;
  }
  if (commandKey && !event.shiftKey && !event.altKey && keyIs('KeyT', 't')) {
    event.preventDefault();
    event.stopPropagation();
    openQuickOpen('workspace-symbol');
    return;
  }
  if (commandKey && !event.shiftKey && !event.altKey && keyIs('Slash', '/')) {
    event.preventDefault();
    toggleLineComments();
    return;
  }
  if (event.altKey && !commandKey && !event.ctrlKey && !event.shiftKey && keyIs('KeyZ', 'z')) {
    event.preventDefault();
    toggleWordWrap();
    return;
  }
  if (event.key === 'F12' && !event.shiftKey && !event.altKey) {
    event.preventDefault();
    goToDefinition().catch(showError);
    return;
  }
  if (commandKey && event.shiftKey && !event.altKey && keyIs('KeyM', 'm')) {
    event.preventDefault();
    focusProblems();
    return;
  }
  if (!quickAccessPanel.hidden && event.key === 'Escape') {
    event.preventDefault();
    closeQuickAccess();
    return;
  }
  if (quickAccessPanel.hidden && event.key === 'F8') {
    event.preventDefault();
    navigateDiagnostic(event.shiftKey ? -1 : 1);
    return;
  }
  if (commandKey && !event.altKey && !event.shiftKey && formatKey) {
    event.preventDefault();
    event.stopPropagation();
    openEditorFind(false);
    return;
  }
  if (commandKey && !event.altKey && !event.shiftKey && (event.code === 'KeyH' || event.key?.toLowerCase() === 'h')) {
    event.preventDefault();
    event.stopPropagation();
    openEditorFind(true);
    return;
  }
  if (!editorFindPanel.hidden && event.key === 'F3') {
    event.preventDefault();
    event.shiftKey ? navigateEditorFind(-1) : navigateEditorFind(1);
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey && formatKey) {
    event.preventDefault();
    event.stopPropagation();
    formatCode();
    return;
  }
  if (event.key === 'Escape' && !editorFindPanel.hidden) {
    event.preventDefault();
    closeEditorFind();
    return;
  }
  if (event.key === 'Escape') hideVariableTooltip();
}, true);
const horizontalScrollbar = document.querySelector('#editor-horizontal-scrollbar');
const horizontalThumb = horizontalScrollbar?.querySelector('.editor-horizontal-thumb');
const updateHorizontalScrollbar = () => {
  if (!horizontalScrollbar || !horizontalThumb) return;
  const editorWrap = editor.closest('.editor-wrap');
  const trackWidth = Math.max(0, (editorWrap?.clientWidth || 0) - 57);
  horizontalScrollbar.style.width = `${trackWidth}px`;
  const maxScroll = Math.max(0, editor.scrollWidth - editor.clientWidth);
  const minimapWidth = document.querySelector('.app-shell.minimap-hidden') ? 0 : (document.querySelector('#minimap')?.getBoundingClientRect().width || 0);
  const overlapsMinimap = editor.scrollWidth > editor.clientWidth - minimapWidth + 1;
  const overflow = overlapsMinimap && !document.querySelector('.app-shell')?.classList.contains('word-wrap-on') && trackWidth > 0;
  horizontalScrollbar.hidden = !overflow;
  if (!overflow) { editor.closest('.editor-wrap')?.classList.remove('horizontal-scrollbar-visible'); return; }
  const thumbWidth = Math.max(28, trackWidth * editor.clientWidth / editor.scrollWidth);
  const travel = Math.max(0, trackWidth - thumbWidth);
  horizontalThumb.style.width = `${Math.min(trackWidth, thumbWidth)}px`;
  horizontalThumb.style.transform = `translateX(${maxScroll ? travel * editor.scrollLeft / maxScroll : 0}px)`;
  horizontalScrollbar.setAttribute('aria-valuenow', String(Math.round(100 * editor.scrollLeft / maxScroll)));
};
let horizontalDrag = null;
const setHorizontalScrollFromPointer = (event) => {
  if (!horizontalDrag) return;
  const maxScroll = Math.max(0, editor.scrollWidth - editor.clientWidth);
  const travel = Math.max(1, horizontalScrollbar.clientWidth - horizontalThumb.getBoundingClientRect().width);
  const deltaX = event.clientX - horizontalDrag.pointerX;
  editor.scrollLeft = Math.max(0, Math.min(maxScroll, horizontalDrag.scrollLeft + deltaX * maxScroll / travel));
};
horizontalScrollbar?.addEventListener('pointerdown', (event) => {
  event.preventDefault();
  const thumbRect = horizontalThumb.getBoundingClientRect();
  const onThumb = event.clientX >= thumbRect.left && event.clientX <= thumbRect.right;
  horizontalDrag = { pointerX: event.clientX, scrollLeft: editor.scrollLeft };
  if (!onThumb) {
    const rect = horizontalScrollbar.getBoundingClientRect();
    const travel = Math.max(1, rect.width - thumbRect.width);
    const targetLeft = Math.max(0, Math.min(travel, event.clientX - rect.left - thumbRect.width / 2));
    horizontalDrag.scrollLeft = targetLeft * Math.max(0, editor.scrollWidth - editor.clientWidth) / travel;
  }
  horizontalScrollbar.setPointerCapture(event.pointerId);
  setHorizontalScrollFromPointer(event);
});
horizontalScrollbar?.addEventListener('pointermove', (event) => { if (horizontalScrollbar.hasPointerCapture(event.pointerId)) setHorizontalScrollFromPointer(event); });
const endHorizontalDrag = (event) => { if (horizontalScrollbar?.hasPointerCapture(event.pointerId)) horizontalScrollbar.releasePointerCapture(event.pointerId); horizontalDrag = null; };
horizontalScrollbar?.addEventListener('pointerup', endHorizontalDrag);
horizontalScrollbar?.addEventListener('pointercancel', endHorizontalDrag);
horizontalScrollbar?.addEventListener('keydown', (event) => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) return;
  event.preventDefault();
  const step = Math.max(40, editor.clientWidth * (event.key.startsWith('Page') ? 0.8 : 0.08));
  if (event.key === 'Home') editor.scrollLeft = 0;
  else if (event.key === 'End') editor.scrollLeft = editor.scrollWidth;
  else editor.scrollLeft += event.key === 'ArrowLeft' || event.key === 'PageUp' ? -step : step;
});
const editorWrap = editor.closest('.editor-wrap');
editorWrap?.addEventListener('pointermove', (event) => { updateHorizontalScrollbar(); if (!horizontalScrollbar?.hidden && event.clientY >= editorWrap.getBoundingClientRect().bottom - 20) editorWrap.classList.add('horizontal-scrollbar-visible'); });
editorWrap?.addEventListener('pointerleave', () => editorWrap.classList.remove('horizontal-scrollbar-visible'));
window.addEventListener('resize', updateHorizontalScrollbar);
const revealCaretBeforeMinimap = () => {
  const shell = document.querySelector('.app-shell');
  if (shell?.classList.contains('minimap-hidden') || shell?.classList.contains('word-wrap-on')) return;
  const caret = editor.selectionStart;
  const lineStart = editor.value.lastIndexOf('\n', Math.max(0, caret - 1)) + 1;
  const prefix = editor.value.slice(lineStart, caret);
  const style = getComputedStyle(editor);
  const canvas = revealCaretBeforeMinimap.canvas || (revealCaretBeforeMinimap.canvas = document.createElement('canvas'));
  const context = canvas.getContext('2d');
  context.font = style.font;
  const textWidth = context.measureText(prefix.replace(/\t/g, '  ')).width;
  const minimapWidth = document.querySelector('#minimap')?.getBoundingClientRect().width || 0;
  const visibleRight = editor.clientWidth - minimapWidth - 12;
  const caretRight = 25 + textWidth - editor.scrollLeft;
  if (caretRight > visibleRight) editor.scrollLeft += caretRight - visibleRight + 12;
};
editor.addEventListener('input', () => { revealCaretBeforeMinimap(); updateHorizontalScrollbar(); });
editor.addEventListener('keyup', revealCaretBeforeMinimap);
editor.addEventListener('click', revealCaretBeforeMinimap);
document.querySelector('#toggle-word-wrap')?.addEventListener('click', () => requestAnimationFrame(updateHorizontalScrollbar));
editor.addEventListener('scroll', () => { lineNumbers.scrollTop = editor.scrollTop; if (highlight) { highlight.scrollTop = editor.scrollTop; highlight.scrollLeft = editor.scrollLeft; } updateMiniMap(); updateSuggestions(); updateHorizontalScrollbar(); });
editor.addEventListener('scroll', () => { editorFindHighlights.scrollTop = editor.scrollTop; editorFindHighlights.scrollLeft = editor.scrollLeft; });
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
  if (event.isComposing || event.key === 'Process') return;
  if (event.key === 'F12' && !event.shiftKey && !event.ctrlKey && !event.altKey) {
    event.preventDefault();
    const offset = editor.selectionStart;
    const token = tokenAtSourceOffset(offset) || (offset > 0 ? tokenAtSourceOffset(offset - 1) : null);
    if (token) jumpToTokenDefinition(token).catch(showError);
    return;
  }
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
  if (event.key === 'Enter' && suggestions.length
    && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
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
  if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey
    && (event.code === 'BracketLeft' || event.code === 'BracketRight')) {
    event.preventDefault();
    adjustSelectionIndent(event.code === 'BracketLeft');
    return;
  }
  if (event.key === 'Home' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
    event.preventDefault();
    const caret = editor.selectionDirection === 'backward' ? editor.selectionStart : editor.selectionEnd;
    const lineStart = editor.value.lastIndexOf('\n', caret - 1) + 1;
    const firstText = lineStart + /^[ \t]*/.exec(editor.value.slice(lineStart))[0].length;
    const destination = caret === firstText ? lineStart : firstText;
    editor.setSelectionRange(destination, destination);
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
    const atLineEnd = editor.selectionStart === editor.selectionEnd && editor.selectionStart === lineEnd;
    if (atLineEnd && /^"(?:\\.|[^"\\])*"\s*\{$/.test(trimmedLine)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const caret = lineStart + fullLine.length;
      const opening = lineStart + fullLine.lastIndexOf('{');
      const hasClosingBrace = matchingClosingBrace(editor.value, opening) >= caret;
      if (hasClosingBrace) { insertEditorNewline(); return; }
      insertEditorBlockAtLineEnd(caret, lineStart, true);
      return;
    }
    if (atLineEnd && trimmedLine === '}' && isChoiceOptionClose(editor.value, lineStart)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const caret = lineStart + fullLine.length;
      const insertionPoint = caret < editor.value.length && editor.value[caret] === '\n' ? caret + 1 : caret;
      const insertion = '"" {\n}\n';
      replaceWithFormattedSource(`${editor.value.slice(0, insertionPoint)}${insertion}${editor.value.slice(insertionPoint)}`, insertionPoint + 1);
      return;
    }
    const ifLine = fullLine.match(/^(\s*if(?:\s+|(?=\())[^{}]+?)\s*$/);
    if (atLineEnd && ifLine && !trimmedLine.endsWith('{')) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const caret = lineStart + fullLine.length;
      insertEditorBlockAtLineEnd(caret, lineStart);
      return;
    }
    if (atLineEnd && /^(?:scene|fn|if|elif|else|for|while|character|struct)\b[\s\S]*\{\s*$/.test(trimmedLine)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const caret = lineStart + fullLine.length;
      const opening = lineStart + fullLine.lastIndexOf('{');
      const hasClosingBrace = matchingClosingBrace(editor.value, opening) >= caret;
      if (hasClosingBrace) { insertEditorNewline(); return; }
      insertEditorBlockAtLineEnd(caret, lineStart, true);
      return;
    }
    const structuralHeader = fullLine.match(/^\s*(?:scene\s+[A-Za-z_][A-Za-z0-9_-]*|fn\s+[A-Za-z_][A-Za-z0-9_-]*\s*\([^{}]*\)(?:\s*->\s*[A-Za-z_][A-Za-z0-9_]*(?:\s*\[\s*[A-Za-z_][A-Za-z0-9_]*\s*\])?)?|for\s+.+|while\s+.+|elif\s+.+|character\s+[A-Za-z_][A-Za-z0-9_-]*|struct\s+[A-Za-z_][A-Za-z0-9_-]*|else)\s*$/);
    if (atLineEnd && structuralHeader) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const caret = lineStart + fullLine.length;
      insertEditorBlockAtLineEnd(caret, lineStart);
      return;
    }
    if (atLineEnd && /^choice(?:\s+"(?:\\.|[^"\\])*")?\s*\{\s*$/.test(trimmedLine)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const caret = lineStart + fullLine.length;
      const opening = lineStart + fullLine.lastIndexOf('{');
      const hasClosingBrace = matchingClosingBrace(editor.value, opening) >= caret;
      if (hasClosingBrace) {
        insertEditorNewline();
      } else {
        const block = '\n"" {\n}\n}';
        replaceWithFormattedSource(`${editor.value.slice(0, caret)}${block}${editor.value.slice(caret)}`, caret + 2);
      }
      return;
    }
    const choiceLine = fullLine.match(/^(\s*choice(?:\s+"(?:\\.|[^"\\])*"\s*)?)$/);
    if (atLineEnd && choiceLine) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const caret = lineStart + fullLine.length;
      const block = ' {\n"" {\n}\n}\n';
      replaceWithFormattedSource(`${editor.value.slice(0, caret)}${block}${editor.value.slice(caret)}`, caret + block.indexOf('""') + 1);
      return;
    }
    // 通常の改行は現在行だけ編集し、執筆途中の文書全体を書き換えない。
    event.preventDefault();
    event.stopImmediatePropagation();
    insertEditorNewline();
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
  if (candidate && (sceneNames.includes(candidate) || isStandardLibraryPath(candidate))) await openScene(candidate);
  else if (sceneNames.length) await openScene(sceneNames[0]);
}

async function pollProjectChanges() {
  if (!workspaceReadyForPolling || !currentProjectRoot || document.hidden || projectChangesInFlight) return;
  projectChangesInFlight = true;
  const root = currentProjectRoot;
  try {
    const changes = await request(`/api/project/changes?since=${encodeURIComponent(projectChangesToken)}`, { cache: 'no-store' });
    if (!workspaceReadyForPolling || root !== currentProjectRoot || changes.root !== root) return;
    const hadToken = Boolean(projectChangesToken);
    projectChangesToken = changes.token;
    if (changes.reset && !hadToken) return;
    const scenePrefix = `${scenarioDirectory}/`;
    const added = changes.added || [], removed = changes.removed || [], changed = changes.changed || [];
    const structural = changes.reset || [...added, ...removed].some((name) => !name.startsWith('.novel/'));
    const sceneChanged = changes.reset || [...added, ...changed, ...removed].some((name) => name.startsWith(scenePrefix) && /\.tds$/i.test(name));
    const currentPath = sceneName.value ? `${scenePrefix}${sceneName.value}` : '';
    const currentChanged = changes.reset || (currentPath && [...added, ...changed, ...removed].includes(currentPath));
    let removedOpenTab = false;
    for (const removedPath of removed) {
      const removedScene = scenarioRelativePath(removedPath);
      if (!removedScene || !/\.tds$/i.test(removedScene) || removedScene === sceneName.value) continue;
      const openIndex = openTabs.indexOf(removedScene);
      if (openIndex >= 0) { openTabs.splice(openIndex, 1); removedOpenTab = true; }
      const splitIndex = splitTabs.indexOf(removedScene);
      if (splitIndex >= 0 && removedScene !== activeSplitScene) { splitTabs.splice(splitIndex, 1); removedOpenTab = true; }
    }
    if (removedOpenTab) { renderEditorTabs(activeAssetDocument || sceneName.value); renderSplitTabs(); }
    if (structural) await refreshScenes(sceneName.value);
    if (!workspaceReadyForPolling || root !== currentProjectRoot) return;
    if (sceneChanged) {
      quickWorkspaceSymbolsPromise = null;
      if (sceneFlowHost && !sceneFlowHost.hidden) notifySceneFlowRefresh();
      if (sceneFlow && !sceneFlow.hidden) refreshSceneGraph().catch(() => {});
      if (sceneName.value) scheduleValidation();
    }
    if (changes.reset || [...added, ...changed, ...removed].includes('.novel/variables.json')) {
      setKnownVariableData(await request('/api/variables', { cache: 'no-store' }));
      currentVariableAnalysis = null;
    }
    if (changes.reset || [...added, ...changed, ...removed].includes('.novel/assets.json')) await refreshCatalog();
    if (!currentChanged || !sceneName.value) return;
    if (isDirty) {
      setStatus('編集中のファイルが外部で変更されました。未保存の内容は保持しています。', 'warning');
      return;
    }
    const name = sceneName.value;
    const previousRevision = sceneRevision;
    let latest;
    try { latest = await request(`/api/scene?name=${encodeURIComponent(name)}`, { cache: 'no-store' }); }
    catch (error) {
      if (removed.includes(currentPath)) setStatus('開いているファイルが外部で削除されました。表示中の内容は保持しています。', 'warning');
      else throw error;
      return;
    }
    if (root !== currentProjectRoot || sceneName.value !== name || isDirty || sceneRevision !== previousRevision || latest.revision === previousRevision) return;
    const selectionStart = editor.selectionStart, selectionEnd = editor.selectionEnd, scrollTop = editor.scrollTop;
    editor.value = latest.source;
    sceneRevision = String(latest.revision || '');
    clearEditorHistory();
    editor.setSelectionRange(Math.min(selectionStart, editor.value.length), Math.min(selectionEnd, editor.value.length));
    editor.scrollTop = scrollTop;
    updateLineNumbers();
    updateHighlight();
    scheduleValidation();
    showFileInfo(name).catch(() => {});
    setStatus(`${name} の外部変更を反映しました`, 'ok');
  } finally {
    projectChangesInFlight = false;
  }
}

setInterval(() => pollProjectChanges().catch((error) => console.warn('作品の変更確認に失敗しました:', error)), 4000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) pollProjectChanges().catch((error) => console.warn('作品の変更確認に失敗しました:', error));
});

async function postProjectOpen(folder) {
  const response = await fetch('/api/project/open', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: folder, create: false }),
  });
  const data = await response.json();
  return { ok: response.ok, status: response.status, data };
}

async function confirmProjectSwitch() {
  const splitApi = !splitGroup?.hidden ? splitFrame?.contentWindow?.novelEditorApi : null;
  if (!isDirty && !splitApi?.isDirty?.()) return true;
  return uiAsk('未保存の変更があります。Project Folderを切り替えますか？', '切り替える');
}

async function applyOpenedProject(info) {
  await stopSceneFlowDebug().catch(() => {});
  workspaceReadyForPolling = false;
  projectChangesToken = '';
  currentProjectRoot = info.projectRoot || '';
  // A project switch is a hard workspace boundary: discard tabs, split-editor
  // state, diagnostics and the previous document before fetching the new tree.
  openTabs.length = 0;
  splitTabs.length = 0;
  closeSplit(true);
  clearLeftEditor();
  renderEditorTabs('');
  renderSplitTabs();
  result.replaceChildren();
  diagnostics = [];
  diagnosticText = '';
  await loadWorkspace(false);
  const activeProject = await request('/api/project');
  if (activeProject.projectRoot !== currentProjectRoot) throw new Error('選択したProject Folderへの切り替えを確認できませんでした。もう一度お試しください。');
  window.dispatchEvent(new CustomEvent('novel-editor:workspace-ready', { detail: { projectRoot: currentProjectRoot, scenes: [...sceneNames] } }));
  setStatus(`${info.title || '作品'} を開きました`, 'ok');
  workspaceReadyForPolling = true;
  pollProjectChanges().catch((error) => console.warn('作品の変更確認に失敗しました:', error));
}

async function openProjectAt(folder) {
  if (!(await confirmProjectSwitch())) return;
  const result = await postProjectOpen(folder);
  if (!result.ok) throw new Error(result.data.error || 'Project Folderを開けませんでした。');
  await applyOpenedProject(result.data);
}

async function chooseProjectFolder() {
  const folder = window.novelDesktop?.selectFolder
    ? await window.novelDesktop.selectFolder()
    : await uiPrompt('Folder path to open', currentProjectRoot || '');
  if (!folder?.trim()) return;
  await openProjectAt(folder.trim());
}

document.querySelector('#open-project')?.addEventListener('click', () => chooseProjectFolder().catch(showError));

Promise.all([request('/api/project'), loadWorkspace(true)])
  .then(([project]) => {
    currentProjectRoot = project.projectRoot || '';
    workspaceReadyForPolling = true;
    pollProjectChanges().catch((error) => console.warn('作品の変更確認に失敗しました:', error));
    setStatus('編集を開始できます', 'ok');
    const startupProjectRoot = currentProjectRoot;
    const restoreStartupScene = () => {
      if (currentProjectRoot !== startupProjectRoot || sceneName.value || isDirty) return;
      const remembered = localStorage.getItem(lastSceneKey());
      const candidate = selectedScene || remembered;
      if (candidate && (sceneNames.includes(candidate) || isStandardLibraryPath(candidate))) openScene(candidate).then(() => { if (!selectedSymbol) return; const match = new RegExp(`^\\s*(?:global\\s+)?(?:int|string|str|bool|struct|const)\\s+${selectedSymbol}\\b`, 'm').exec(editor.value); if (match) revealEditorRange(match.index, match.index + selectedSymbol.length); }).catch(showError);
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
  const line = lineNumber || splitEditorLines(editor.value.slice(0, start)).length;
  editor.scrollTop = Math.max(0, (line - 3) * editorLineHeight());
  highlight && (highlight.scrollTop = editor.scrollTop);
  lineNumbers && (lineNumbers.scrollTop = editor.scrollTop);
}
function updateMiniMap() {
  if (!minimap || !minimapContent || !minimapViewport) return;
  const lines = splitEditorLines(editor.value);
  const prismLanguage = editorPrismLanguage();
  const prismOutput = prismLanguage ? highlightWithPrism(editor.value, prismLanguage) : null;
  minimapContent.classList.remove('language-markup', 'language-css');
  if (prismOutput !== null) minimapContent.classList.add(`language-${prismLanguage}`);
  minimapContent.innerHTML = prismOutput ?? lines.map((line) => highlightSource(line) || ' ').join('\n');
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
  const height = Math.min(minimap.clientHeight, Math.max(1, minimap.clientHeight * ratio));
  minimapViewport.style.height = `${height}px`;
  minimapViewport.style.top = `${(editor.scrollTop / max) * Math.max(0, minimap.clientHeight - height)}px`;
}
// The editor and minimap share a flexible workbench pane. A window resize can
// change their box sizes without changing the document or dispatching scroll,
// so keep the viewport indicator synchronized with the actual rendered boxes.
let minimapResizeFrame = 0;
const scheduleMiniMapUpdate = () => {
  if (minimapResizeFrame) cancelAnimationFrame(minimapResizeFrame);
  minimapResizeFrame = requestAnimationFrame(() => {
    minimapResizeFrame = 0;
    updateMiniMap();
  });
};
if (typeof ResizeObserver !== 'undefined') {
  const minimapResizeObserver = new ResizeObserver(scheduleMiniMapUpdate);
  if (editor) minimapResizeObserver.observe(editor);
  if (minimap) minimapResizeObserver.observe(minimap);
}
window.addEventListener('resize', scheduleMiniMapUpdate);
function editorPrismLanguage() {
  const file = String(activeSettingDocument || sceneName?.value || '').toLowerCase();
  if (/\.html?$/.test(file)) return 'markup';
  if (/\.css$/.test(file)) return 'css';
  return '';
}
function highlightWithPrism(source, language) {
  const grammar = window.Prism?.languages?.[language];
  return grammar ? window.Prism.highlight(String(source ?? ''), grammar, language) : null;
}
function updateHighlight() {
  if (!highlight) return;
  const prismLanguage = editorPrismLanguage();
  if (prismLanguage) {
    const rendered = highlightWithPrism(editor.value, prismLanguage);
    if (rendered !== null) {
      highlight.classList.remove('language-markup', 'language-css');
      highlight.classList.add(`language-${prismLanguage}`);
      highlight.innerHTML = rendered;
      updateMiniMap();
      return;
    }
  }
  highlight.classList.remove('language-markup', 'language-css');
  const lines = splitEditorLines(editor.value);
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
    if (normalizedScenePath(sceneName.value) === normalizedScenePath(flowNativeDebugExecutionFile) && lineNumber === flowNativeDebugExecutionLine) classes.push('hl-running');
    if (sceneName.value === flowStartPreviewFile && lineNumber === flowStartPreviewLine) classes.push('hl-start');
    if (sceneName.value === flowLinePicker?.file && lineNumber === flowPickHoverLine) classes.push('hl-pick-hover');
    return `<span class="${classes.join(' ')}">${highlightSource(line) || ' '}</span>`;
  }).join('\n');
  updateMiniMap();
}
const dirtyStyle=document.createElement('style');dirtyStyle.textContent='.dirty-mark{display:none!important;background:transparent!important;width:auto!important;height:auto!important}.dirty-mark.visible{display:inline-block!important}.dirty-mark.visible:after{content:"•";color:#fff;font-size:13px;margin-left:4px}.document-title input{width:120px}.scene-file.file-dirty:after{position:static;margin-left:5px;color:#fff;font-size:13px}';document.head.append(dirtyStyle);
const thinDiagnosticStyle=document.createElement('style');thinDiagnosticStyle.textContent='.hl-error,.hl-warning,.hl-info{text-decoration-line:underline;text-decoration-style:wavy;text-decoration-thickness:1px!important;background:transparent!important}.hl-error{text-decoration-color:#e85b68!important}.hl-warning{text-decoration-color:#e3b35c!important}.hl-info{text-decoration-color:#6aa9d8!important}.status-chip.warning .status-dot{background:#e3b35c}';document.head.append(thinDiagnosticStyle);
highlight?.addEventListener('mouseover', (event) => { const line = event.target.closest('.hl-error,.hl-warning,.hl-info'); if (line) { const lineNumber = [...highlight.children].indexOf(line) + 1; line.title = diagnostics.filter(diagnosticForCurrentFile).filter((item) => Number(item.line) === lineNumber).map((item) => `${item.severity}: ${item.message}`).join('\n'); } });
const syntaxHints = {
  path: 'file path（include / goto / asset / pose の指定値）',
  include: 'include "module.tds" as alias',
  let: 'let <name> = <expression>', pose: 'pose <Pose Name> = "<Image Path>"',
  none: '関数の戻り値がないことを示す型です。',
  asset: 'asset <type> <name> = "<path>"',
  character: 'character <Name> {\n  name = "<display name>"\n  affection = 0\n  pose normal = "<image path>"\n}',
  struct: 'struct <名前> {\n  name: str\n  score: int\n}',
  int: 'int <name> = <integer>',
  float: 'float <name> = <float>, e.g. 0.5 / 1e-3',
  str: 'str <name> = "<string>"',
  dict: 'dict[int|float|str] <name> = { "key": <value> }',
  const: 'const <Type> <Name> = <value>',
  global: 'global [const] <Type> <Name> = <value>',
  set: 'set <existing variable> = <value>',
  unset: 'unset <existing variable> [key]',
  and: '<condition> and <condition>', or: '<condition> or <condition>', not: 'not <condition>',
  say: 'say <str expression starting with a string literal> or say <speaker> <str expression>',
  bg: 'bg <background asset>', bgm: 'bgm <BGM asset>', se: 'play se <SE asset>',
  show: 'show <Character>.<Pose> <Position> [x+(<expression>)] [y-(<expression>)] [fade <ms>] [--only]', hide: 'hide <Character> [fade <ms>]',
  move: 'move character <Name> by x+<px> y-<px> [over <ms>] / move bg by x+<px> y-<px> [over <ms>]',
  clear: 'clear bg | image | bgm',
  image: 'asset image <Name> = "<Image Path>" / show image <Name> <Position> [--only]',
  at: 'show <Character.Pose> at <Position>',
  async: 'play voice <Name> async', blocking: 'play voice <Name> blocking',
  voice: 'play voice <Name> [blocking|async]', video: 'play video <Name|"file.mp4"> [blocking|async] [--only]',
  true: 'Boolean literal representing true.', false: 'Boolean literal representing false.',
  if: 'if <condition> { ... } else { ... }', elif: 'elif <condition> { ... }', else: 'else { ... }',
  for: 'for <variable> from <start> to <end> [step <width>] { ... }',
  while: 'while <条件> { ... }', choice: 'choice "質問" { "選択肢" { ... } }',
  fn: 'fn <name>(<argument>: <type>) -> <return type> { ... }', return: 'return [value]', goto: 'goto <scene> or goto "<external file path>"',
  wait: 'wait <milliseconds>', effect: 'effect fade <color> [milliseconds]', play: 'play <kind> <asset>'
};
Object.assign(syntaxHints, {
  scene: 'scene <名前> { … }',
  string: 'String literal. Use {variable} for string interpolation in expressions.',
  number: 'Numeric literal. Integers use int; values with a decimal point or exponent use float.',
  '->': '関数の戻り値型を区切ります。例: fn score() -> int { … }',
  '==': '等しいかを比較します。条件式で使用します。', '!=': '等しくないかを比較します。',
  '<': '左辺が右辺より小さいかを比較します。', '>': '左辺が右辺より大きいかを比較します。',
  '<=': '左辺が右辺以下かを比較します。', '>=': '左辺が右辺以上かを比較します。',
  '+': '加算です。str同士では文字列を連結します。', '-': '減算または数値の符号反転です。',
  '*': '数値の乗算です。', '/': '数値の除算です。', '%': '整数の剰余です。',
  '(': '関数呼び出しの引数、または式の括弧を開始します。', ')': '関数呼び出しの引数、または式の括弧を閉じます。',
  '{': 'ブロックまたは dict の開始です。対応する } までが範囲です。', '}': 'ブロックまたは dict を閉じます。',
  ':': '関数引数・struct field の型指定、または dict key と value の区切りです。',
  '=': '宣言時の初期値、またはasset/pose定義の値です。既存変数への代入はsetを使います。',
  comment: '# から行末まではコメントで、実行されません。',
});
const syntaxRecipes = {
  path: { description: 'この位置では文字列ではなく、読み込み・遷移・asset referenceに使うfile pathを指定します。パス専用の値型を作らず、構文上の役割として扱います。' },
  include: { description: '別ファイルをmoduleとして読み込み、functionを alias.function() の形で参照します。include pathはScenario Folderからのrelative pathです。', snippet: 'include "std/math.tds" as math\nwait math.sin(angle)\n' },
  unset: { description: 'dict key を削除します。変数そのものを宣言解除する命令ではありません。', snippet: 'unset inventory["key"]\n' },
  move: { description: '表示中の立ち絵または背景を現在位置からpx単位で移動します。overを指定すると時間をかけて移動します。', snippet: 'move character hero by x+5 y-8 over 300\n' },
  clear: { description: '指定した演出layerを消去します。対象がない状態でも安全に使用できます。', snippet: 'clear bgm\n' },
  scene: { description: 'gotoなどで遷移するSceneの入口を定義します。Scene名は同一ファイル内で一意にします。', snippet: 'scene chapter_start {\n  say "始めます"\n}\n' },
  string: { description: '文字列内の {name} は変数値に置き換わります。式の結果が文字列でない場合は str(...) で変換します。', snippet: 'say narrator "好感度: {str(affection)}"\n' },
  let: { description: '型を式から推論するローカル変数宣言です。推論型は後から別の型に変えられません。', snippet: 'let count = 0\n' },
  and: { description: '左右の条件が両方とも真のとき真です。左が偽なら右側は短絡評価されません。', snippet: 'if ready and score > 0 {\n  wait 1\n}\n' },
  or: { description: '左右の条件のどちらかが真なら真です。左が真なら右側は短絡評価されません。', snippet: 'if ready or retry {\n  wait 1\n}\n' },
  not: { description: '条件の真偽を反転します。', snippet: 'if not finished {\n  wait 1\n}\n' },
  asset: { description: 'asset fileを名前で呼べるようにします。pathを書くのはこの宣言時だけです。', snippet: 'asset bg background = "asset/bg/¦.png"\n' },
  character: { description: '立ち絵とposeをまとめて定義します。', snippet: 'character hero {\n  name = "主人公"\n  pose normal = "asset/char/hero/¦.png"\n}\n' },
  int: { description: '整数のローカル変数です。ファイル間で共有するなら global を付けます。', snippet: 'int count = ¦0\n' },
  float: { description: '小数の変数です。整数との混合演算には float(整数) を使います。', snippet: 'float ratio = ¦0.5\n' },
  str: { description: '文字列のローカル変数です。', snippet: 'str name = "¦"\n' },
  global: { description: '複数ファイルから参照できる共有変数です。トップレベルで宣言します。', snippet: 'global int score = ¦0\n' },
  say: { description: '本文がString literalから始まる式なら話者を省略でき、narrator として扱います。Variableやfunction callから始める場合は話者を指定します。', snippet: 'say "¦本文"\n' },
  bg: { description: 'asset bg で宣言済みの背景名を指定します。ここではパスを直接書きません。', snippet: 'bg ¦background\n' },
  bgm: { description: 'asset bgm で宣言済みの BGM 名を指定します。', snippet: 'bgm ¦music\n' },
  volume: { description: 'bgm / se / voice の以後の基準音量を0.0〜1.0で設定します。play行のvolumeはその再生だけの指定です。', snippet: 'volume bgm ¦0.5\n' },
  opacity: { description: 'dialog opacityは会話欄の背景面、say行末のopacityはその台詞だけの背景面の不透明度を0.0〜1.0で設定します。', snippet: 'dialog opacity ¦0.85\n' },
  show: { description: 'character の pose を表示します。位置は far_left / left / center / right / far_right を使えます。', snippet: 'show hero.normal center¦\n' },
  hide: { description: '表示中の立ち絵を消します。', snippet: 'hide ¦hero\n' },
  if: { description: '条件が真のときだけブロックを実行します。', snippet: 'if ¦condition {\n  \n}\n' },
  for: { description: '開始から終了まで繰り返すfor loopです。step は省略できます。', snippet: 'for i from 0 to ¦10 {\n  \n}\n' },
  while: { description: '条件が真の間、ブロックを繰り返すwhile loopです。', snippet: 'while ¦condition {\n  \n}\n' },
  choice: { description: '選択肢ごとに実行する処理を書きます。', snippet: 'choice "質問" {\n  "¦選択肢" {\n    \n  }\n}\n' },
  goto: { description: '同一ファイルのScene名はそのまま、外部ファイルの相対pathは必ず引用符で囲んで指定します。', snippet: 'goto ¦next_scene\n' },
  fn: { description: '戻り値の型を -> で必ず指定して関数を定義します。値を返さない関数は none を使います。', snippet: 'fn name() -> none {\n  ¦\n}\n' },
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
async function showProjectSettings() {
  const opener = document.activeElement;
  document.querySelector('.project-settings')?.remove();
  const [project, variableData, assetData] = await Promise.all([
    request('/api/project'), request('/api/variables'), request('/api/assets'),
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
  field('Start Scene', 'start_file', project.settings?.start_file || 'main.tds');
  field('Scenario Folder', 'scenario_dir', project.settings?.scenario_dir || '');
  field('Asset Folder', 'asset_dir', project.settings?.asset_dir || '');
  field('Player UI Theme', 'native_ui_theme', project.settings?.native_ui_theme || '');
  const basicNote = document.createElement('p'); basicNote.className = 'project-settings-note'; basicNote.textContent = 'フォルダー名を変更しても既存ファイルは移動しません。先にファイルを移動してから変更してください。';
  basic.append(basicNote);
  basic.prepend(basicTitle);
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
  const assetTitle = document.createElement('h2'); assetTitle.textContent = 'Assets';
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
        const projectPath = source.startsWith('asset/') ? source : `asset/${relative}`;
        dialog.remove();
        openAssetDocument(projectPath).catch(showError);
      });
      assetList.append(row);
    });
  } else {
    const empty = document.createElement('div'); empty.className = 'project-settings-empty'; empty.textContent = '登録済みのassetsはありません。';
    assetList.append(empty);
  }
  const assetNote = document.createElement('p'); assetNote.className = 'project-settings-note'; assetNote.textContent = 'AssetsはAsset Folderに置き、.tdsファイルでasset / character / poseを宣言して登録します。Editorで表示するにはクリックしてください。';
  const checkImages = document.createElement('button'); checkImages.type = 'button'; checkImages.className = 'project-settings-save'; checkImages.textContent = 'Validate image loading'; checkImages.addEventListener('click', () => saveAllScenes().then(() => runNativeTool('images', 'Validate image loading')).catch(showError));
  assets.append(assetTitle, assetList, assetNote, checkImages);
  const footer = document.createElement('footer');
  const save = document.createElement('button'); save.type = 'button'; save.className = 'project-settings-save'; save.textContent = '作品設定を保存';
  save.addEventListener('click', async () => {
    const updated = await request('/api/project/settings', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.fromEntries(Object.entries(fields).map(([name, input]) => [name, input.value]))),
    });
    currentProjectRoot = updated.projectRoot || currentProjectRoot;
    await Promise.all([refreshFiles(), refreshCatalog(), refreshScenes()]);
    setStatus('作品設定を保存しました', 'ok');
    dialog.remove();
  });
  footer.append(save);
  dialog.append(heading, close, path, basic, variables, assets, footer);
  document.body.append(dialog);
  activateEditorModal(dialog, close, opener);
}
function showLanguageGuide() {
  document.querySelector('.workbench-message')?.remove();
  const dialog = document.createElement('section');
  dialog.className = 'editor-dialog workbench-message language-guide';
  dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true');
  const heading = document.createElement('strong'); heading.textContent = '.tds Syntax Help';
  const close = document.createElement('button'); close.type = 'button'; close.className = 'guide-close'; close.setAttribute('aria-label', 'ヘルプを閉じる'); close.textContent = '×'; close.onclick = () => dialog.remove();
  const intro = document.createElement('p'); intro.className = 'guide-intro'; intro.textContent = '構文を検索し、例を確認できます。「Insert into Editor」はカーソル位置にコード例を挿入します。';
  const reference = document.createElement('a'); reference.href = '/docs/tds-language-and-editor-guide.md'; reference.target = '_blank'; reference.rel = 'noopener'; reference.className = 'guide-reference'; reference.textContent = 'Open Full Syntax Reference';
  const search = document.createElement('input'); search.className = 'guide-search'; search.type = 'search'; search.placeholder = '構文・型・命令を検索'; search.setAttribute('aria-label', '構文ヘルプを検索');
  const sections = [
    ['Minimal Project - Entry Point', 'asset bg room = "asset/bg/room.jpg"\n\nscene main {\n  bg room\n  say narrator "こんにちは"\n}\n\nscene next {\n  say "Next Scene"\n}\n\n# Scene transition\ngoto next', '開始ファイルの最初のsceneから実行します。sceneは自動連続再生されず、次へ進むにはgotoが必要です。命令は上から順番に実行されます。'],
    ['File Split - include', 'include "std/math.tds" as math\ninclude "common.tds" as common\n\nscene main {\n  wait math.sin(1.0)\n  common.start_route()\n}', 'Include files are modules for reusing declarations and functions. Always add an alias, then call functions as alias.name(...). Use goto "chapter/next.tds" to move to another scenario.'],
    ['Variables & Types', 'int score = 0\nfloat opacity = 0.85\nbool unlocked = false\nstr route = "common"\nconst int max_score = 10\nglobal list[str] endings = []\n\nset score = score + 1', 'Declare variables with int, float, bool, str, and typed collections. const declarations are immutable; global declarations persist across scenes.'],
    ['dict · list · struct', 'dict[int] stats = { "hp": 100 }\nlist[str] names = ["綾瀬", "美緒"]\n\nstruct Profile {\n  name: str\n  level: int\n}\nProfile player = { "name": "ユイ", "level": 1 }\nset stats["hp"] = 90\nset player.level = 2', 'dictのkeyは文字列で、valueのtypeは宣言時に固定です。listには同じtypeの値を並べます。struct初期化では定義済みfieldをすべて指定します。indexは0始まりです。'],
    ['式・関数・戻り値', 'fn clamp_score(value: int) -> int {\n  if value > 100 { return 100 }\n  return value\n}\n\nint score = clamp_score(120)\nstr label = "score={score}"', '関数はトップレベルで宣言し、引数に型、戻り値に->型を指定します。戻り値なしは-> none。式では関数呼び出し、比較、and/or/not、算術演算を使えます。'],
    ['Dialogue, Variables & Strings', 'int score = 0\nstr route = "common"\n\nset score = score + 1\nsay narrator "点数: {score}"\nsay "点数: " + str(score)\nsay narrator "こんにちは"', '本文がString literalで始まる場合はspeakerを省略でき、narratorが使われます。本文がvariableやfunction callから始まる場合はspeakerを指定します。String interpolationではvariable、dotted field、引数なしfunction callを参照できます。'],
    ['Background, Character & Image', 'asset bg classroom = "asset/bg/classroom.png"\ncharacter ayase {\n  name = "綾瀬"\n  pose normal = "asset/char/ayase.png"\n}\nasset image logo = "asset/image/logo.png"\n\nscene main {\n  bg classroom\n  show ayase.normal center x+20 y+10 fade 300\n  show image logo right\n  hide ayase fade 200\n}', 'Register assets with asset declarations. Positions are far_left / left / center / right / far_right. show x/y values use px; fade durations use milliseconds. Relative movement uses move character ... / move bg ... by x+... y-... over ... .'],
    ['分岐・選択肢', 'if score >= 10 and unlocked {\n  goto good_end\n} elif score > 0 {\n  goto normal_end\n} else {\n  goto bad_end\n}\n\nchoice "どうする？" {\n  "進む" { goto next }\n  "待つ" { wait 500 }\n}', '条件はbool式です。choiceの各ラベルに実行ブロックを書きます。選択後は選んだブロックだけを実行し、後続命令へ戻ります。'],
    ['Loops', 'for i from 1 to 3 {\n  say narrator "{i}回目"\n}\nfor name in names {\n  say narrator name\n}\nwhile score < 3 {\n  set score = score + 1\n}', '数値for loopは両端を含み、stepで刻み幅を指定できます。for item in listは要素を順番に処理します。while loopはconditionがtrueの間繰り返すため、終了条件を更新してください。'],
    ['音声・動画・音量', 'asset bgm morning = "asset/bgm/morning.ogg"\nasset se door = "asset/se/door.wav"\nasset voice line = "asset/voice/line.ogg"\n\nvolume bgm 0.6\nbgm morning volume 0.8\nplay se door volume 0.5\nplay voice line blocking\nplay video opening\nplay video opening async\nclear bgm', '音量は0.0〜1.0。volumeは以降の基準、再生命令のvolumeはその再生だけに適用します。動画は省略時blockingで終了まで物語と入力を止めます。動画を並行再生する場合はasyncを指定します。voiceは省略時asyncです。'],
    ['時間・画面効果', 'wait 500\neffect fade black 300\nshow ayase.smile left fade 250\nmove character ayase by x+30 y+10 over 400\nmove bg by x-5 y+0 over 800', 'wait / fade / overの時間はミリ秒の整数です。moveの座標はpx。完了待ちの時間付き命令は合計時間をブロックします。'],
    ['Standard Library & Runtime State API', 'include "std/math.tds" as math\ninclude "std/motion/walk.tds" as walk\n\nif runtime.state.characters.exists("ayase") {\n  walk.character("ayase", 120.0, 2, 2.0, 6.0)\n}\nfloat x = math.clamp(1.5, 0.0, 1.0)', 'Common modules are std/math, std/text, std/collections, and std/motion. runtime.state reads the current playback state. walk.character moves only Characters proven to be visible; the IDE warns when visibility cannot be proven.'],
    ['よくあるエラー', 'say narrator "正しい"\nset score = score + 1\n\n# 間違い: score = score + 1\n# 間違い: float ratio = 1\n# 間違い: goto chapter/next.tds', '再代入にはsetが必要です。floatには1.0のようなfloat値を使います。外部ファイルへのgotoは引用符付き相対パス。asset/include/gotoのファイル存在エラーは診断一覧で場所を確認します。'],
    ['Editor shortcuts', 'Ctrl+S       Save\nCtrl+Z / Ctrl+Y  Undo / Redo\nCtrl+Shift+F  Format current scene\nTab / Shift+Tab  Indent selection\nCtrl+Enter    Build', 'Format / Save / Build run validation. Click a diagnostic to jump to its source location.'],
  ];
  const list = document.createElement('div'); list.className = 'guide-sections';
  const book = document.createElement('div'); book.className = 'guide-book'; book.hidden = true;
  const bookIndex = document.createElement('nav'); bookIndex.className = 'guide-book-index'; bookIndex.setAttribute('aria-label', 'Reference sections');
  const bookPage = document.createElement('article'); bookPage.className = 'guide-book-page';
  book.append(bookIndex, bookPage);
  let bookSections = null;
  let selectedBookSection = -1;
  const appendMarkdownBlocks = (parent, source) => {
    const lines = splitEditorLines(source);
    for (let index = 0; index < lines.length;) {
      const line = lines[index];
      if (!line.trim()) { index++; continue; }
      if (/^\s*(?:~~~|```)/.test(line)) {
        const marker = line.trim().slice(0, 3); const code = []; index++;
        while (index < lines.length && !lines[index].trim().startsWith(marker)) code.push(lines[index++]);
        if (index < lines.length) index++;
        const pre = document.createElement('pre'); pre.textContent = code.join('\n'); parent.append(pre); continue;
      }
      const headingMatch = /^(#{1,6})\s+(.+)$/.exec(line);
      if (headingMatch) {
        const headingNode = document.createElement(`h${Math.min(4, headingMatch[1].length)}`);
        headingNode.textContent = headingMatch[2].replace(/\s+#+\s*$/, ''); parent.append(headingNode); index++; continue;
      }
      if (/^\s*\|/.test(line)) {
        const rows = [];
        while (index < lines.length && /^\s*\|/.test(lines[index])) rows.push(lines[index++]);
        const table = document.createElement('table');
        rows.filter(row => !/^\s*\|?\s*:?-{3,}/.test(row)).forEach((row, rowIndex) => {
          const tr = document.createElement('tr');
          row.trim().replace(/^\||\|$/g, '').split('|').forEach(value => {
            const cell = document.createElement(rowIndex === 0 ? 'th' : 'td'); cell.textContent = value.trim().replace(/`/g, ''); tr.append(cell);
          });
          table.append(tr);
        });
        parent.append(table); continue;
      }
      if (/^\s*(?:[-*+] |\d+\. )/.test(line)) {
        const ordered = /^\s*\d+\. /.test(line); const listNode = document.createElement(ordered ? 'ol' : 'ul');
        while (index < lines.length && /^\s*(?:[-*+] |\d+\. )/.test(lines[index])) {
          const item = document.createElement('li'); item.textContent = lines[index++].replace(/^\s*(?:[-*+] |\d+\. )/, '').replace(/`/g, ''); listNode.append(item);
        }
        parent.append(listNode); continue;
      }
      const paragraph = [];
      while (index < lines.length && lines[index].trim() && !/^\s*(?:~~~|```|#{1,6}\s|\||[-*+] |\d+\. )/.test(lines[index])) paragraph.push(lines[index++].trim());
      if (paragraph.length) { const p = document.createElement('p'); p.textContent = paragraph.join(' ').replace(/`([^`]+)`/g, '$1'); parent.append(p); }
    }
  };
  const selectBookSection = (index) => {
    selectedBookSection = index;
    const query = search.value.trim().toLocaleLowerCase();
    const matches = bookSections.map((section, sectionIndex) => ({ section, sectionIndex }))
      .filter(({ section }) => !query || section.searchText.includes(query));
    if (matches.length && !matches.some(({ sectionIndex }) => sectionIndex === selectedBookSection)) selectedBookSection = matches[0].sectionIndex;
    bookIndex.replaceChildren();
    for (const { section, sectionIndex } of matches) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'guide-book-entry';
      button.classList.toggle('is-selected', sectionIndex === selectedBookSection); button.textContent = section.title;
      button.onclick = () => selectBookSection(sectionIndex); bookIndex.append(button);
    }
    if (!matches.length) { bookPage.textContent = 'No matching sections'; return; }
    const current = bookSections[selectedBookSection]; bookPage.replaceChildren();
    if (!current) { bookPage.textContent = '検索結果がありません'; return; }
    const title = document.createElement('h2'); title.textContent = current.title; bookPage.append(title);
    appendMarkdownBlocks(bookPage, current.body);
  };
  reference.addEventListener('click', async (event) => {
    event.preventDefault();
    if (bookSections && !book.hidden) {
      intro.hidden = false; list.hidden = false; book.hidden = true; dialog.classList.remove('is-book');
      search.value = '';
      reference.textContent = 'Quick Reference';
      search.placeholder = '構文・型・命令・説明を検索'; return;
    }
    try {
      if (!bookSections) {
        reference.setAttribute('aria-busy', 'true');
        const response = await fetch('/docs/tds-language-and-editor-guide.md');
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const source = await response.text(); const parsed = []; let lines = [], title = '.tds Reference', inFence = false;
        for (const line of splitEditorLines(source)) {
          if (/^\s*(?:~~~|```)/.test(line)) inFence = !inFence;
          const headingMatch = !inFence && /^(#{1,3})\s+(.+)$/.exec(line);
          if (headingMatch) {
            if (lines.some(value => value.trim())) parsed.push({ title, body: lines.join('\n') });
            title = headingMatch[2].replace(/\s+#+\s*$/, ''); lines = [];
          } else lines.push(line);
        }
        if (lines.some(value => value.trim())) parsed.push({ title, body: lines.join('\n') });
        bookSections = parsed.map(section => ({ ...section, searchText: `${section.title}\n${section.body}`.toLocaleLowerCase() }));
      }
      intro.hidden = true; list.hidden = true; book.hidden = false; dialog.classList.add('is-book');
      reference.textContent = '簡易ヘルプへ戻る'; search.placeholder = '構文・型・命令・説明を検索';
      selectBookSection(0);
    } catch (error) { reference.textContent = `読み込めませんでした: ${error.message}`; }
    finally { reference.removeAttribute('aria-busy'); }
  });
  dialog.append(book);
  dialog.append(heading, close, intro, search, reference, list);
  sections.forEach(([title, body, descriptionText], index) => {
    const block = document.createElement('details'); block.className = 'guide-section'; block.dataset.search = `${title} ${body} ${descriptionText}`.toLocaleLowerCase(); if (index === 0) block.open = true;
    const summary = document.createElement('summary'); summary.textContent = title;
    const description = document.createElement('p'); description.textContent = descriptionText;
    const pre = document.createElement('pre'); pre.textContent = body;
    const actions = document.createElement('div'); actions.className = 'guide-actions';
    const copy = document.createElement('button'); copy.type = 'button'; copy.textContent = 'コピー';
    copy.onclick = async () => { try { await navigator.clipboard.writeText(body); copy.textContent = 'コピーしました'; setTimeout(() => { if (copy.isConnected) copy.textContent = 'コピー'; }, 1200); } catch { copy.textContent = 'コピーできません'; } };
    const insert = document.createElement('button'); insert.type = 'button'; insert.textContent = 'Insert into Editor';
    insert.onclick = () => { editor.focus(); editor.setRangeText(body, editor.selectionStart, editor.selectionEnd, 'end'); editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: body })); };
    actions.append(copy, insert);
    block.append(summary, description, pre, actions); list.append(block);
  });
  search.addEventListener('input', () => {
    if (bookSections && !book.hidden) { selectBookSection(selectedBookSection); return; }
    const query = search.value.trim().toLocaleLowerCase();
    list.querySelectorAll('.guide-section').forEach(block => { block.hidden = Boolean(query) && !block.dataset.search.includes(query); if (query && !block.hidden) block.open = true; });
  });
  document.body.append(dialog); activateEditorModal(dialog, close);
}

async function showGameScreenSettings() {
  const opener = document.activeElement;
  document.querySelector('.game-screen-settings')?.remove();
  const [project, assetData, loaded] = await Promise.all([
    request('/api/project'), request('/api/assets'), request('/api/game-screens'),
  ]);
  const config = loaded.screens;
  const documents = { ...(loaded.documents || {}) };
  const dialog = document.createElement('section');
  dialog.className = 'editor-dialog game-screen-settings';
  dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true');
  const heading = document.createElement('strong'); heading.textContent = 'Title / Menu Screens';
  const close = document.createElement('button'); close.type = 'button'; close.className = 'project-settings-close'; close.textContent = '×'; close.setAttribute('aria-label', '閉じる'); close.onclick = () => dialog.remove();
  const toolbar = document.createElement('div'); toolbar.className = 'game-screen-toolbar';
  const scaleModeSelect = document.createElement('select'); scaleModeSelect.className = 'game-screen-scale-mode'; scaleModeSelect.setAttribute('aria-label', '画面サイズへの適応');
  for (const [value, label] of [['contain', '比率を維持'], ['cover', '画面を覆う'], ['stretch', '引き伸ばす']]) {
    const option = document.createElement('option'); option.value = value; option.textContent = label; scaleModeSelect.append(option);
  }
  const previewRatioSelect = document.createElement('select'); previewRatioSelect.className = 'game-screen-preview-ratio'; previewRatioSelect.setAttribute('aria-label', 'Preview Aspect Ratio');
  for (const [value, label] of [['canvas', '基準比率'], ['16:9', '16:9'], ['16:10', '16:10'], ['4:3', '4:3'], ['21:9', '21:9'], ['9:16', '9:16']]) {
    const option = document.createElement('option'); option.value = value; option.textContent = label; previewRatioSelect.append(option);
  }
  const screenSelect = document.createElement('select'); screenSelect.setAttribute('aria-label', '編集する画面');
  const addScreen = document.createElement('button'); addScreen.type = 'button'; addScreen.textContent = '画面を追加';
  const addButton = document.createElement('button'); addButton.type = 'button'; addButton.textContent = 'ボタンを追加';
  const sourceModeButton = document.createElement('button'); sourceModeButton.type = 'button'; sourceModeButton.textContent = 'HTML/CSSで編集';
  toolbar.append(screenSelect, scaleModeSelect, previewRatioSelect, addScreen, addButton, sourceModeButton);
  const workspace = document.createElement('div'); workspace.className = 'game-screen-workspace';
  const preview = document.createElement('div'); preview.className = 'game-screen-preview'; preview.setAttribute('aria-label', 'Screen Preview');
  const inspector = document.createElement('div'); inspector.className = 'game-screen-inspector';
  const status = document.createElement('div'); status.className = 'game-screen-status'; status.setAttribute('role', 'status');
  const save = document.createElement('button'); save.type = 'button'; save.className = 'project-settings-save'; save.textContent = '画面設定を保存';
  const footer = document.createElement('footer'); footer.append(status, save);
  workspace.append(preview, inspector); dialog.append(heading, close, toolbar, workspace, footer); document.body.append(dialog); activateEditorModal(dialog, close, opener);

  const assetDirectory = String(project.settings?.asset_dir || 'asset').replaceAll('\\', '/').replace(/\/$/, '');
  const imageAssets = (assetData.assets || []).filter(item => ['bg', 'image'].includes(item.type));
  const buttonAssets = assetData.assets || [];
  const assetRelative = value => {
    let rel = String(value || '').replaceAll('\\', '/').replace(/^asset\//i, '');
    if (rel.startsWith(assetDirectory + '/')) rel = rel.slice(assetDirectory.length + 1);
    return rel;
  };
  const assetUrl = value => {
    const rel = assetRelative(value);
    return rel ? '/asset/' + rel.split('/').map(encodeURIComponent).join('/') : '';
  };
  let selectedItem = null;
  let sourceMode = Object.values(config.screens).some(screen => screen.template);
  if (sourceMode) { sourceModeButton.textContent = 'HTML/CSSが正本'; sourceModeButton.disabled = true; addButton.disabled = true; }
  const escapeText = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  const createScreenDocument = (id, screen) => {
    config.stylesheet ||= 'screens/shared.css';
    const selector = `#legacy-${id}`;
    const html = [`<main id="legacy-${id}">`];
    const css = [`${selector} { position: relative; width: 100%; height: 100%; }`];
    if (screen.title) { html.push(`<h1 id="legacy-${id}-title">${escapeText(screen.title)}</h1>`); css.push(`#legacy-${id}-title { position:absolute; left:64px; top:42px; width:90%; height:48px; color:#f5f7f8; font-size:34px; }`); }
    if (screen.description) { html.push(`<p id="legacy-${id}-description">${escapeText(screen.description)}</p>`); css.push(`#legacy-${id}-description { position:absolute; left:64px; top:112px; width:560px; height:220px; color:#f0eee8; font-size:21px; }`); }
    for (const [index, item] of (screen.items || []).entries()) {
      const itemId = `legacy-${id}-button-${index}`;
      if (item.action === 'open-screen') html.push(`<button id="${itemId}" data-action="open-screen" data-target="${escapeText(item.target)}">${escapeText(item.label)}</button>`);
      else html.push(`<button id="${itemId}" data-action="${item.action}">${escapeText(item.label)}</button>`);
      const image = item.image ? assetRelative(item.image) : '';
      const hoverImage = item.hoverImage ? assetRelative(item.hoverImage) : image;
      css.push(`#${itemId} { position:absolute; left:${item.x}px; top:${item.y}px; width:${item.width}px; height:${item.height}px; color:${item.color || '#f5f5f2'}; background-color:${item.backgroundColor || '#17212bd9'}; border:1px solid ${item.borderColor || '#8797a0'}; font-size:${item.fontSize || 22}px; text-align:center;${image ? ` background-image:url("asset/${image}"); background-size:100% 100%;` : ''} }`);
      if (item.hoverColor || item.hoverBackgroundColor || item.hoverBorderColor || item.hoverImage) css.push(`#${itemId}:hover { color:${item.hoverColor || item.color || '#f5f5f2'}; background-color:${item.hoverBackgroundColor || item.backgroundColor || '#17212bd9'}; border-color:${item.hoverBorderColor || item.borderColor || '#8797a0'};${hoverImage ? ` background-image:url("asset/${hoverImage}"); background-size:100% 100%;` : ''} }`);
    }
    if (screen.role) {
      const layout = screen.slotLayout || { x: 420, y: 190, width: 440, height: 420, rowHeight: 42, gap: 8, count: 8 };
      html.push(`<div id="legacy-${id}-slots" data-role="${screen.role}" data-count="${layout.count}"></div>`);
      css.push(`#legacy-${id}-slots { position:absolute; left:${layout.x}px; top:${layout.y}px; width:${layout.width}px; height:${layout.height}px; display:grid; grid-template-columns:repeat(1, 1fr); grid-auto-rows:${layout.rowHeight}px; gap:${layout.gap}px; }`);
      css.push('.save-slot { width:100%; height:100%; color:#f5f5f2; background-color:#17212bd9; border:1px solid #8797a0; font-size:15px; text-align:left; }');
      const slotStyle = screen.slotStyle || {};
      const slotImage = slotStyle.image ? assetRelative(slotStyle.image) : '';
      const slotHoverImage = slotStyle.hoverImage ? assetRelative(slotStyle.hoverImage) : slotImage;
      const slotSelector = `.save-slot-${screen.role}`;
      css.push(`${slotSelector} { color:${slotStyle.color || '#f5f5f2'}; background-color:${slotStyle.backgroundColor || '#17212bd9'}; border-color:${slotStyle.borderColor || '#8797a0'}; font-size:${slotStyle.fontSize || 15}px;${slotImage ? ` background-image:url("asset/${slotImage}"); background-size:100% 100%;` : ''} }`);
      if (slotStyle.hoverColor || slotStyle.hoverBackgroundColor || slotStyle.hoverBorderColor || slotStyle.hoverImage) css.push(`${slotSelector}:hover { color:${slotStyle.hoverColor || slotStyle.color || '#f5f5f2'}; background-color:${slotStyle.hoverBackgroundColor || slotStyle.backgroundColor || '#17212bd9'}; border-color:${slotStyle.hoverBorderColor || slotStyle.borderColor || '#8797a0'};${slotHoverImage ? ` background-image:url("asset/${slotHoverImage}"); background-size:100% 100%;` : ''} }`);
    }
    html.push('</main>');
    screen.template = `screens/${id}.html`;
    documents[screen.template] = html.join('\n');
    documents[config.stylesheet] = `${documents[config.stylesheet] || ''}\n${css.join('\n')}\n`;
  };
  const selectedScreen = () => config.screens[screenSelect.value];
  const refreshScreenOptions = () => {
    screenSelect.replaceChildren();
    for (const id of Object.keys(config.screens)) {
      const option = document.createElement('option'); option.value = id; option.textContent = id === config.initial ? `${id}（開始）` : id; screenSelect.append(option);
    }
    screenSelect.value = config.initial;
  };
  const field = (labelText, key, value, type = 'text') => {
    const label = document.createElement('label'); label.textContent = labelText;
    const input = key === 'description' ? document.createElement('textarea') : document.createElement('input');
    if (input instanceof HTMLInputElement) input.type = type;
    input.value = value ?? '';
    if (type === 'number') { input.min = '0'; input.max = key === 'x' || key === 'y' ? '4096' : '2048'; input.step = '1'; }
    input.addEventListener('input', () => {
      const target = selectedItem || selectedScreen();
      if (!target) return;
      target[key] = type === 'number' ? Number(input.value) : input.value;
      render();
    });
    label.append(input); inspector.append(label); return input;
  };
  const selectField = (labelText, value, options, onChange) => {
    const label = document.createElement('label'); label.textContent = labelText;
    const select = document.createElement('select');
    for (const [optionValue, text] of options) { const option = document.createElement('option'); option.value = optionValue; option.textContent = text; select.append(option); }
    select.value = value ?? ''; select.addEventListener('change', () => onChange(select.value)); label.append(select); inspector.append(label); return select;
  };
  function render() {
    const screen = selectedScreen(); if (!screen) return;
    const width = config.canvas.width, height = config.canvas.height;
    const [ratioWidth, ratioHeight] = previewRatioSelect.value === 'canvas'
      ? [width, height] : previewRatioSelect.value.split(':').map(Number);
    preview.style.aspectRatio = `${ratioWidth} / ${ratioHeight}`;
    const previewWidth = preview.clientWidth, previewHeight = preview.clientHeight;
    // The settings dialog can render while hidden (and therefore measure 0x0).
    // ResizeObserver invokes render again once it becomes visible; don't turn
    // that normal lifecycle state into an uncaught canvasTransform exception.
    if (previewWidth <= 0 || previewHeight <= 0) { preview.replaceChildren(); return; }
    const transform = NovelScreenDocument.canvasTransform(previewWidth, previewHeight, { width, height }, config.scaleMode || 'contain');
    const { scaleX, scaleY, offsetX, offsetY } = transform;
    const screenBackground = Object.hasOwn(screen, 'background') ? screen.background : config.defaultBackground;
    preview.style.backgroundImage = screenBackground ? `linear-gradient(#0002,#0002),url("${assetUrl(screenBackground)}")` : 'none';
    preview.style.backgroundSize = 'cover';
    preview.replaceChildren();
    if (sourceMode && screen.template && window.NovelScreenDocument) {
      try {
        const controls = config.controlSettings && documents[config.controlSettings]
          ? NovelScreenDocument.parseControlSettings(documents[config.controlSettings]) : {};
        const compiled = NovelScreenDocument.compileScreenDocument(documents[screen.template] || '', documents[config.stylesheet] || '', config.canvas, Object.keys(config.screens), controls);
        preview.append(NovelScreenDocument.buildScreenDom(compiled.tree, document, {
          scaleX, scaleY, offsetX, offsetY, assetUrl,
          controlDefaults: controls, canSave: true, canContinue: true,
          saved: index => index === 0 ? { scene: 'main', text: 'ここに本文が表示されます。' } : null,
          onAction: () => {},
          slotField: (index, name) => {
            const sample = index === 0;
            return ({ number: String(index + 1).padStart(2, '0'), status: sample ? '記録あり' : '空き', scene: sample ? 'main' : '', speaker: sample ? '語り手' : '', text: sample ? 'ここに本文が表示されます。' : '', 'saved-at': sample ? '2026/09/30 12:00' : '' })[name] || '';
          },
          roleSlot: (button, index, node) => {
            if (!node.children.length) {
              button.classList.add('game-screen-preview-slot');
              button.textContent = `Slot ${String(index + 1).padStart(2, '0')} · Save Slot Preview`;
            }
          },
        }));
      } catch (error) {
        status.textContent = `HTML/CSS: ${error.message}`;
      }
      return;
    }
    if (screen.title) {
      const screenTitle = document.createElement('div'); screenTitle.className = 'game-screen-preview-title'; screenTitle.textContent = screen.title;
      Object.assign(screenTitle.style, { left: `${offsetX + 64 * scaleX}px`, top: `${offsetY + 42 * scaleY}px`, fontSize: `${34 * scaleY}px` }); preview.append(screenTitle);
    }
    if (screen.description) {
      const description = document.createElement('div'); description.className = 'game-screen-preview-description'; description.textContent = screen.description;
      Object.assign(description.style, { left: `${offsetX + 64 * scaleX}px`, top: `${offsetY + 112 * scaleY}px`, width: `${Math.min(560, width - 128) * scaleX}px`, fontSize: `${18 * scaleY}px` }); preview.append(description);
    }
    for (const item of screen.items) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'game-screen-preview-button';
      button.textContent = item.label;
      Object.assign(button.style, { left: `${offsetX + item.x * scaleX}px`, top: `${offsetY + item.y * scaleY}px`, width: `${item.width * scaleX}px`, height: `${item.height * scaleY}px`, fontSize: `${Math.max(9, 18 * scaleY)}px` });
      if (item.image) button.style.backgroundImage = `url("${assetUrl(item.image)}")`;
      if (selectedItem === item) button.classList.add('selected');
      button.addEventListener('pointerdown', event => {
        event.preventDefault(); selectedItem = item; renderInspector(); render();
        const origin = { x: item.x, y: item.y, px: event.clientX, py: event.clientY };
        const move = pointer => {
          item.x = Math.max(0, Math.min(width - item.width, Math.round(origin.x + (pointer.clientX - origin.px) / scaleX)));
          item.y = Math.max(0, Math.min(height - item.height, Math.round(origin.y + (pointer.clientY - origin.py) / scaleY)));
          renderInspector(); render();
        };
        const stop = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop); };
        window.addEventListener('pointermove', move); window.addEventListener('pointerup', stop, { once: true });
      });
      preview.append(button);
    }
  }
  function renderInspector() {
    inspector.replaceChildren();
    const screen = selectedScreen();
    scaleModeSelect.value = config.scaleMode || 'contain';
    if (sourceMode) {
      const heading = document.createElement('h2'); heading.textContent = '画面HTML / 共通CSS'; inspector.append(heading);
      const sourceLinks = document.createElement('div'); sourceLinks.className = 'game-screen-source-links';
      const htmlReference = screen.template || `screens/${screenSelect.value}.html`;
      const cssReference = config.stylesheet || 'screens/shared.css';
      const addSourceLink = (reference, ariaLabel) => {
        const link = document.createElement('a'); link.className = 'game-screen-source-link'; link.href = `#${reference}`; link.textContent = reference; link.setAttribute('aria-label', ariaLabel);
        link.addEventListener('click', async event => {
          event.preventDefault();
          try {
            if (reference === htmlReference && !screen.template) createScreenDocument(screenSelect.value, screen);
            status.textContent = '画面設定を保存しています…';
            await request('/api/game-screens', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ screens: config, documents }) });
            dialog.remove();
            activateExplorerView();
            await openSettingFile(`setting/${reference}`);
          } catch (error) {
            if (dialog.isConnected) status.textContent = error.message;
            else showError(error);
          }
        });
        sourceLinks.append(link);
      };
      addSourceLink(htmlReference, `HTMLをコード編集画面で開く: ${htmlReference}`);
      addSourceLink(cssReference, `CSSをコード編集画面で開く: ${cssReference}`);
      inspector.append(sourceLinks);
      return;
    }
    const title = document.createElement('h2'); title.textContent = selectedItem ? '選択中のボタン' : '画面'; inspector.append(title);
    if (!selectedItem) {
      const bgmAssets = (assetData.assets || []).filter(asset => asset.type === 'bgm');
      selectField('画面のBGM', screen.music || '', [['', 'なし'], ...bgmAssets.map(asset => [asset.name, `${asset.name}  ${asset.path}`])], value => { screen.music = value; render(); });
      selectField('共通の既定背景', config.defaultBackground || '', [['', 'なし'], ...imageAssets.map(asset => [assetRelative(asset.path), `${asset.type}  ${asset.name}`])], value => { config.defaultBackground = value; render(); });
      field('画面タイトル', 'title', screen.title);
      field('説明文', 'description', screen.description || '');
      const backgroundValue = Object.hasOwn(screen, 'background') ? screen.background : '__default__';
      const backgroundOptions = [['__default__', `共通設定 (${config.defaultBackground || 'なし'})`], ['', 'なし'], ...imageAssets.map(asset => [assetRelative(asset.path), `${asset.type}  ${asset.name}`])];
      selectField('背景画像', backgroundValue, backgroundOptions, value => { if (value === '__default__') delete screen.background; else screen.background = value; render(); });
      field('この画面のBGM（素材名）', 'music', screen.music || '');
      selectField('Screen Role', screen.role || '', [['', '通常画面'], ['save-slots', 'Save Slots'], ['load-slots', 'Load Slots']], value => {
        for (const candidate of Object.values(config.screens)) if (candidate !== screen && candidate.role === value) delete candidate.role;
        if (value) screen.role = value; else delete screen.role;
        screen.slotLayout ||= { x: 420, y: 190, width: 440, height: 420, rowHeight: 42, gap: 8, count: 8 };
        renderInspector(); render();
      });
      if (screen.role === 'save-slots' || screen.role === 'load-slots') {
        screen.slotLayout ||= { x: 420, y: 190, width: 440, height: 420, rowHeight: 42, gap: 8, count: 8 };
        for (const key of ['x', 'y', 'width', 'height', 'rowHeight', 'gap', 'count']) {
          const label = document.createElement('label'); label.textContent = `枠 ${key}`;
          const input = document.createElement('input'); input.type = 'number'; input.min = '0'; input.max = '4096'; input.step = '1'; input.value = screen.slotLayout[key];
          input.addEventListener('input', () => { screen.slotLayout[key] = Number(input.value); render(); });
          label.append(input); inspector.append(label);
        }
      }
      if (screen.role === 'save-slots' || screen.role === 'load-slots') {
        screen.slotStyle ||= {};
        selectField('Save Slot Image', screen.slotStyle.image || '', [['', 'Theme Default'], ...buttonAssets.map(asset => [assetRelative(asset.path), `${asset.type}  ${asset.name}`])], value => { screen.slotStyle.image = value; render(); });
        selectField('Save Slot Hover Image', screen.slotStyle.hoverImage || '', [['', 'Use Normal Image'], ...buttonAssets.map(asset => [assetRelative(asset.path), `${asset.type}  ${asset.name}`])], value => { screen.slotStyle.hoverImage = value; render(); });
        for (const key of ['color', 'hoverColor', 'backgroundColor', 'hoverBackgroundColor', 'borderColor', 'hoverBorderColor', 'fontSize']) {
          const label = document.createElement('label'); label.textContent = `Slot ${key}`;
          const input = document.createElement('input'); input.type = key === 'fontSize' ? 'number' : 'text'; input.value = screen.slotStyle[key] ?? '';
          input.addEventListener('input', () => { screen.slotStyle[key] = key === 'fontSize' ? Number(input.value) : input.value; });
          label.append(input); inspector.append(label);
        }
      }
      const makeInitial = document.createElement('button'); makeInitial.type = 'button'; makeInitial.textContent = 'この画面を開始画面にする'; makeInitial.disabled = config.initial === screenSelect.value;
      makeInitial.onclick = () => { config.initial = screenSelect.value; refreshScreenOptions(); renderInspector(); };
      inspector.append(makeInitial);
      if (screenSelect.value !== 'title' && screenSelect.value !== 'pause') {
        const removeScreen = document.createElement('button'); removeScreen.type = 'button'; removeScreen.textContent = 'この画面を削除';
        removeScreen.onclick = () => { if (config.initial === screenSelect.value) return; delete config.screens[screenSelect.value]; for (const candidate of Object.values(config.screens)) for (const item of candidate.items) if (item.action === 'open-screen' && item.target === screenSelect.value) { item.action = 'back'; delete item.target; } refreshScreenOptions(); renderInspector(); render(); };
        inspector.append(removeScreen);
      }
      return;
    }
    field('ボタン文字', 'label', selectedItem.label);
    field('カーソル時の文字（任意）', 'hoverLabel', selectedItem.hoverLabel || '');
    for (const key of ['x', 'y', 'width', 'height']) field({ x: 'X', y: 'Y', width: '幅', height: '高さ' }[key], key, selectedItem[key], 'number');
    selectField('動作', selectedItem.action, [['start', 'ゲーム開始'], ['continue', '前回の続きから'], ['resume', 'ゲームに戻る'], ['save', 'Save Screen'], ['load', 'Load Screen'], ['open-screen', 'Open Screen'], ['back', '前の画面に戻る'], ['quit', '終了']], value => { selectedItem.action = value; if (value !== 'open-screen') delete selectedItem.target; renderInspector(); });
    if (selectedItem.action === 'open-screen') selectField('移動先', selectedItem.target, Object.keys(config.screens).filter(id => id !== screenSelect.value).map(id => [id, id]), value => { selectedItem.target = value; });
    selectField('Button Image', selectedItem.image, [['', 'Theme Default'], ...buttonAssets.map(asset => [assetRelative(asset.path), `${asset.type}  ${asset.name}`])], value => { selectedItem.image = value; render(); });
    selectField('カーソル時の画像', selectedItem.hoverImage, [['', '通常画像を使用'], ...buttonAssets.map(asset => [assetRelative(asset.path), `${asset.type}  ${asset.name}`])], value => { selectedItem.hoverImage = value; render(); });
    selectField('画像と文字の表示', selectedItem.display || 'both', [['both', '文字と画像'], ['text', '文字のみ'], ['image', '画像のみ']], value => { selectedItem.display = value; render(); });
    field('文字サイズ', 'fontSize', selectedItem.fontSize ?? 22, 'number');
    for (const [key, label] of [['color', '文字色'], ['hoverColor', 'カーソル時の文字色'], ['backgroundColor', '背景色'], ['hoverBackgroundColor', 'カーソル時の背景色'], ['borderColor', '枠線色'], ['hoverBorderColor', 'カーソル時の枠線色']]) field(label, key, selectedItem[key] || '');
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'ボタンを削除'; remove.onclick = () => { screen.items = screen.items.filter(item => item !== selectedItem); selectedItem = null; renderInspector(); render(); }; inspector.append(remove);
  }
  refreshScreenOptions();
  sourceModeButton.addEventListener('click', () => {
    if (!sourceMode) {
      for (const [id, screen] of Object.entries(config.screens)) if (!screen.template) createScreenDocument(id, screen);
      sourceMode = true; sourceModeButton.textContent = 'HTML/CSSが正本'; sourceModeButton.disabled = true; addButton.disabled = true;
    } else {
      sourceMode = false; sourceModeButton.textContent = 'HTML/CSSで編集'; addButton.disabled = false;
    }
    renderInspector(); render();
  });
  screenSelect.addEventListener('change', () => { selectedItem = null; renderInspector(); render(); });
  scaleModeSelect.addEventListener('change', () => { config.scaleMode = scaleModeSelect.value; render(); });
  previewRatioSelect.addEventListener('change', render);
  addButton.addEventListener('click', () => {
    const screen = selectedScreen();
    const item = { id: `button_${Date.now().toString(36)}`, type: 'button', label: '新しいボタン', action: screenSelect.value === 'pause' ? 'resume' : 'start', x: 64, y: 150 + screen.items.length * 68, width: 300, height: 56 };
    screen.items.push(item); selectedItem = item; renderInspector(); render();
  });
  addScreen.addEventListener('click', () => {
    let id = prompt('画面ID（英数字、_、-）', 'screen'); if (!id) return;
    id = id.trim(); if (!/^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(id) || config.screens[id]) { status.textContent = '画面IDが不正か、すでに使われています。'; return; }
    config.screens[id] = { title: id, background: '', items: [{ id: 'back', type: 'button', label: '戻る', action: 'back', x: 64, y: 150, width: 300, height: 56 }] };
    if (sourceMode) createScreenDocument(id, config.screens[id]);
    refreshScreenOptions(); screenSelect.value = id; selectedItem = null; renderInspector(); render();
  });
  save.addEventListener('click', async () => {
    save.disabled = true;
    try { await request('/api/game-screens', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ screens: config, documents }) }); status.textContent = '画面設定を保存しました。'; }
    catch (error) { status.textContent = error.message; }
    finally { save.disabled = false; }
  });
  renderInspector(); requestAnimationFrame(render);
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(render).observe(preview);
}

function selectCurrentLine() {
  const start = editor.value.lastIndexOf('\n', Math.max(0, editor.selectionStart - 1)) + 1;
  const next = editor.value.indexOf('\n', editor.selectionEnd);
  editor.setSelectionRange(start, next < 0 ? editor.value.length : next);
  editor.focus();
}

const editorFindPanel = document.querySelector('#editor-find');
const editorFindHighlights = document.querySelector('#editor-find-highlights');
const editorFindInput = document.querySelector('#editor-find-input');
const editorReplaceInput = document.querySelector('#editor-replace-input');
const editorReplaceRow = document.querySelector('#editor-replace-row');
const editorFindCount = document.querySelector('#editor-find-count');
const editorFindScopeButton = document.querySelector('#editor-find-scope');
const MAX_EDITOR_FIND_HIGHLIGHTS = 1000;
const editorFindOptions = new Set();
const editorFindMatches = [];
const editorFindHistory = [];
let editorFindActiveIndex = -1;
let editorFindScope = null;
let editorFindSelectionCandidate = null;
let editorFindHistoryIndex = -1;
let editorFindHistoryDraft = '';

function syncEditorFindFieldWidths() {
  if (!editorFindPanel || editorFindPanel.hidden) return;
  const width = editorFindInput.getBoundingClientRect().width;
  if (width <= 0) return;
  editorReplaceInput.style.flex = `0 0 ${width}px`;
}

if (typeof ResizeObserver !== 'undefined') new ResizeObserver(syncEditorFindFieldWidths).observe(editorFindPanel);
window.addEventListener('resize', syncEditorFindFieldWidths);

function editorFindPattern(query) {
  let source = editorFindOptions.has('regex') ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (editorFindOptions.has('word')) source = `\\b(?:${source})\\b`;
  return new RegExp(source, editorFindOptions.has('case') ? 'gu' : 'giu');
}

function refreshEditorFind() {
  if (!editorFindPanel || editorFindPanel.hidden) return;
  editorFindMatches.length = 0;
  editorFindPanel.classList.remove('has-error');
  const query = editorFindInput.value;
  if (!query) {
    editorFindActiveIndex = -1;
    updateEditorFindCount();
    updateEditorFindHighlights();
    return;
  }
  let matcher;
  try { matcher = editorFindPattern(query); }
  catch (error) {
    editorFindActiveIndex = -1;
    editorFindPanel.classList.add('has-error');
    updateEditorFindCount();
    editorFindCount.textContent = `Regex Error: ${error.message}`;
    updateEditorFindHighlights();
    return;
  }
  const source = editor.value;
  const rangeStart = editorFindScope ? Math.max(0, Math.min(source.length, editorFindScope.start)) : 0;
  const rangeEnd = editorFindScope ? Math.max(rangeStart, Math.min(source.length, editorFindScope.end)) : source.length;
  const rangeText = source.slice(rangeStart, rangeEnd);
  let match;
  while ((match = matcher.exec(rangeText)) !== null) {
    if (match[0].length) {
      editorFindMatches.push({
        start: rangeStart + match.index,
        end: rangeStart + match.index + match[0].length,
        text: match[0],
        captures: Array.from(match).slice(1),
        groups: match.groups || {},
      });
    } else {
      matcher.lastIndex += 1;
    }
  }
  const selectedStart = editor.selectionStart;
  const selectedEnd = editor.selectionEnd;
  const selectedMatch = editorFindMatches.findIndex((item) => item.start === selectedStart && item.end === selectedEnd);
  editorFindActiveIndex = selectedMatch >= 0 ? selectedMatch : editorFindMatches.findIndex((item) => item.start >= selectedStart);
  if (editorFindActiveIndex < 0 && editorFindMatches.length) editorFindActiveIndex = 0;
  updateEditorFindCount();
  updateEditorFindHighlights();
  if (editorFindActiveIndex >= 0) selectEditorFindMatch(editorFindActiveIndex);
}

function updateEditorFindCount() {
  const total = editorFindMatches.length;
  editorFindCount.textContent = total && editorFindActiveIndex >= 0
    ? `${editorFindActiveIndex + 1} / ${total} 件`
    : '結果はありません。';
  document.querySelector('#editor-replace-one').disabled = editorFindActiveIndex < 0;
  document.querySelector('#editor-replace-all').disabled = total === 0;
}

function updateEditorFindHighlights() {
  if (!editorFindHighlights) return;
  if (editorFindPanel.hidden || !editorFindMatches.length) {
    editorFindHighlights.hidden = true;
    editorFindHighlights.replaceChildren();
    return;
  }
  const nodes = [];
  let cursor = 0;
  // Keep the transparent overlay DOM bounded for broad queries in large scripts.
  const visibleMatches = editorFindMatches.slice(0, MAX_EDITOR_FIND_HIGHLIGHTS).map((match, index) => ({ match, index }));
  if (editorFindActiveIndex >= MAX_EDITOR_FIND_HIGHLIGHTS) visibleMatches.push({ match: editorFindMatches[editorFindActiveIndex], index: editorFindActiveIndex });
  visibleMatches.sort((left, right) => left.match.start - right.match.start);
  visibleMatches.forEach(({ match, index }) => {
    if (match.start > cursor) nodes.push(document.createTextNode(editor.value.slice(cursor, match.start)));
    const mark = document.createElement('mark');
    mark.className = index === editorFindActiveIndex ? 'editor-find-hit editor-find-hit-active' : 'editor-find-hit';
    mark.textContent = editor.value.slice(match.start, match.end);
    nodes.push(mark);
    cursor = match.end;
  });
  if (cursor < editor.value.length) nodes.push(document.createTextNode(editor.value.slice(cursor)));
  editorFindHighlights.replaceChildren(...nodes);
  editorFindHighlights.hidden = false;
}

function selectEditorFindMatch(index) {
  if (!editorFindMatches.length) return;
  editorFindActiveIndex = (index + editorFindMatches.length) % editorFindMatches.length;
  const match = editorFindMatches[editorFindActiveIndex];
  editor.setSelectionRange(match.start, match.end);
  const line = splitEditorLines(editor.value.slice(0, match.start)).length;
  const lineHeight = editorLineHeight();
  updateEditorFindCount();
  updateEditorFindHighlights();
  revealEditorFindMatch(match, line, lineHeight);
}

function revealEditorFindMatch(match, line, lineHeight) {
  const style = getComputedStyle(editor);
  const paddingTop = Number.parseFloat(style.paddingTop) || 0;
  const paddingBottom = Number.parseFloat(style.paddingBottom) || 0;
  const targetTop = paddingTop + (line - 1) * lineHeight;
  const visibleTop = editor.scrollTop + paddingTop;
  const visibleBottom = editor.scrollTop + editor.clientHeight - paddingBottom;
  if (targetTop < visibleTop) {
    editor.scrollTop = Math.max(0, targetTop - paddingTop - lineHeight * 2);
  } else if (targetTop + lineHeight > visibleBottom) {
    editor.scrollTop = Math.max(0, targetTop + lineHeight - editor.clientHeight + paddingBottom);
  }

  const activeMark = editorFindHighlights.querySelector('.editor-find-hit-active');
  if (activeMark) {
    const markRect = activeMark.getBoundingClientRect();
    const editorRect = editor.getBoundingClientRect();
    const paddingLeft = Number.parseFloat(style.paddingLeft) || 0;
    const paddingRight = Number.parseFloat(style.paddingRight) || 0;
    const contentLeft = editorRect.left + editor.clientLeft + paddingLeft;
    const contentRight = editorRect.right - editor.clientLeft - paddingRight;
    if (markRect.left < contentLeft) editor.scrollLeft = Math.max(0, editor.scrollLeft - (contentLeft - markRect.left));
    else if (markRect.right > contentRight) editor.scrollLeft += markRect.right - contentRight;
  }

  if (highlight) { highlight.scrollTop = editor.scrollTop; highlight.scrollLeft = editor.scrollLeft; }
  editorFindHighlights.scrollTop = editor.scrollTop;
  editorFindHighlights.scrollLeft = editor.scrollLeft;
  lineNumbers.scrollTop = editor.scrollTop;
}

function navigateEditorFind(direction) {
  if (!editorFindInput.value) { editorFindInput.focus(); return; }
  if (!editorFindMatches.length) { refreshEditorFind(); return; }
  selectEditorFindMatch((editorFindActiveIndex < 0 ? 0 : editorFindActiveIndex) + direction);
}

function rememberEditorFindQuery() {
  const query = editorFindInput.value;
  if (!query) return;
  const previous = editorFindHistory.at(-1);
  if (query !== previous) editorFindHistory.push(query);
  if (editorFindHistory.length > 50) editorFindHistory.shift();
  editorFindHistoryIndex = -1;
}

function browseEditorFindHistory(direction) {
  if (!editorFindHistory.length) return;
  if (direction < 0) {
    if (editorFindHistoryIndex < 0) {
      editorFindHistoryDraft = editorFindInput.value;
      editorFindHistoryIndex = editorFindHistory.length;
    }
    editorFindHistoryIndex = Math.max(0, editorFindHistoryIndex - 1);
    editorFindInput.value = editorFindHistory[editorFindHistoryIndex];
  } else if (editorFindHistoryIndex >= 0) {
    editorFindHistoryIndex += 1;
    editorFindInput.value = editorFindHistoryIndex >= editorFindHistory.length
      ? (editorFindHistoryIndex = -1, editorFindHistoryDraft)
      : editorFindHistory[editorFindHistoryIndex];
  } else return;
  editorFindInput.setSelectionRange(editorFindInput.value.length, editorFindInput.value.length);
  refreshEditorFind();
}

function openEditorFind(showReplace) {
  const selectionStart = editor.selectionStart;
  const selectionEnd = editor.selectionEnd;
  const selectedText = editor.value.slice(selectionStart, selectionEnd);
  editorFindSelectionCandidate = selectionEnd > selectionStart ? { start: selectionStart, end: selectionEnd } : null;
  if (selectedText && !/[\n]/.test(selectedText)) editorFindInput.value = selectedText;
  editorFindPanel.hidden = false;
  editorReplaceRow.hidden = false;
  syncEditorFindFieldWidths();
  document.querySelector('#editor-find-replace-toggle').setAttribute('aria-expanded', 'true');
  document.querySelector('#editor-find-replace-toggle').setAttribute('aria-label', '置換欄を隠す');
  refreshEditorFind();
  const activeInput = showReplace ? editorReplaceInput : editorFindInput;
  activeInput.focus();
  if (activeInput === editorFindInput) editorFindInput.select();
}

function closeEditorFind() {
  rememberEditorFindQuery();
  editorFindPanel.hidden = true;
  updateEditorFindHighlights();
  editor.focus({ preventScroll: true });
}

function expandEditorFindReplacement() {
  const show = editorReplaceRow.hidden;
  editorReplaceRow.hidden = !show;
  const toggle = document.querySelector('#editor-find-replace-toggle');
  toggle.setAttribute('aria-expanded', String(show));
  toggle.setAttribute('aria-label', show ? '置換欄を隠す' : '置換欄を表示');
  if (show) editorReplaceInput.focus();
}

function editorFindReplacement(match) {
  const template = editorReplaceInput.value;
  const before = editor.value.slice(0, match.start);
  const after = editor.value.slice(match.end);
  return template.replace(/\$(\$|&|`|'|\d{1,2}|<[^>]+>)/g, (token, key) => {
    if (key === '$') return '$';
    if (key === '&') return match.text;
    if (key === '`') return before;
    if (key === "'") return after;
    if (key.startsWith('<')) return match.groups[key.slice(1, -1)] ?? token;
    const capture = Number(key);
    return match.captures[capture - 1] ?? token;
  });
}

function replaceEditorFindMatch(all = false) {
  if (!editorFindMatches.length || editorFindActiveIndex < 0) return;
  const selectedMatches = all ? [...editorFindMatches] : [editorFindMatches[editorFindActiveIndex]];
  rememberUndo();
  let source = editor.value;
  for (const match of selectedMatches.reverse()) {
    source = `${source.slice(0, match.start)}${editorFindReplacement(match)}${source.slice(match.end)}`;
  }
  editorFindScope = null;
  editorFindSelectionCandidate = null;
  editor.value = source;
  editor.setSelectionRange(selectedMatches.at(-1)?.start ?? 0, selectedMatches.at(-1)?.start ?? 0);
  editor.dispatchEvent(new Event('input', { bubbles: true }));
  editorReplaceInput.focus();
}

editorFindInput.addEventListener('input', () => {
  editorFindHistoryIndex = -1;
  refreshEditorFind();
});
editorFindInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    event.shiftKey ? navigateEditorFind(-1) : navigateEditorFind(1);
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    browseEditorFindHistory(-1);
  } else if (event.key === 'ArrowDown') {
    event.preventDefault();
    browseEditorFindHistory(1);
  }
});
editorReplaceInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && event.ctrlKey) {
    event.preventDefault();
    replaceEditorFindMatch(true);
  } else if (event.key === 'Enter') {
    event.preventDefault();
    replaceEditorFindMatch(false);
  }
});
document.querySelector('#editor-find-replace-toggle').addEventListener('click', expandEditorFindReplacement);
document.querySelector('#editor-find-close').addEventListener('click', closeEditorFind);
document.querySelector('#editor-find-previous').addEventListener('click', () => navigateEditorFind(-1));
document.querySelector('#editor-find-next').addEventListener('click', () => navigateEditorFind(1));
document.querySelector('#editor-replace-one').addEventListener('click', () => replaceEditorFindMatch(false));
document.querySelector('#editor-replace-all').addEventListener('click', () => replaceEditorFindMatch(true));
editorFindScopeButton.addEventListener('click', () => {
  if (editorFindScope) editorFindScope = null;
  else if (editorFindSelectionCandidate) editorFindScope = { ...editorFindSelectionCandidate };
  else return;
  editorFindScopeButton.setAttribute('aria-pressed', String(Boolean(editorFindScope)));
  editorFindScopeButton.classList.toggle('active', Boolean(editorFindScope));
  refreshEditorFind();
});
document.querySelectorAll('[data-editor-find-option]').forEach((button) => button.addEventListener('click', () => {
  const option = button.dataset.editorFindOption;
  if (editorFindOptions.has(option)) editorFindOptions.delete(option);
  else editorFindOptions.add(option);
  button.setAttribute('aria-pressed', String(editorFindOptions.has(option)));
  button.classList.toggle('active', editorFindOptions.has(option));
  refreshEditorFind();
}));

const searchView = document.querySelector('.search-view');
const searchInput = document.querySelector('#project-search-input');
const searchSummary = document.querySelector('#search-summary');
const searchResults = document.querySelector('#search-results');
const searchOptions = new Set();
let searchTimer = null;
let searchSequence = 0;
const sceneFlowHost = document.querySelector('#scene-flow-host');
const sceneFlowFrame = document.querySelector('#scene-flow-frame');
async function showFlowStartPreview(file, line, focus = false) {
  const target = scenarioRelativePath(file) || file;
  if (!sceneNames.includes(target) || !Number.isSafeInteger(line) || line < 1) return;
  if (focus) {
    hideSceneFlowView();
    activateExplorerView();
  }
  if (sceneName.value !== target) await openScene(target);
  flowStartPreviewFile = target;
  flowStartPreviewLine = line;
  updateHighlight();
  if (focus) {
    const lines = splitEditorLines(editor.value);
    const start = lines.slice(0, line - 1).reduce((count, text) => count + text.length + 1, 0);
    const end = Math.min(editor.value.length, start + (lines[line - 1]?.length || 0));
    revealEditorRange(start, end, line);
    setStatus(`${target}:${line} 開始行`, 'ok');
  }
}
function flowPickerLineAt(element, event) {
  const rect = element.getBoundingClientRect();
  const padding = Number.parseFloat(getComputedStyle(element).paddingTop) || 0;
  return Math.floor((event.clientY - rect.top + element.scrollTop - padding) / editorLineHeight()) + 1;
}
function finishFlowLinePicker(line = null) {
  const picker = flowLinePicker;
  if (!picker) return;
  flowLinePicker = null;
  flowPickHoverLine = 0;
  updateHighlight();
  showSceneFlowView();
  if (line !== null) sceneFlowFrame.contentWindow?.postMessage({ type: 'scene-flow:line-picked', file: picker.file, scene: picker.scene, line }, location.origin);
}
async function beginFlowLinePicker(message) {
  if (!sceneNames.includes(message.file) || typeof message.scene !== 'string' || !Number.isSafeInteger(message.startLine)
    || !Number.isSafeInteger(message.endLine) || message.startLine < 1 || message.endLine < message.startLine) throw Error('開始Sceneを選び直してください');
  hideSceneFlowView();
  activateExplorerView();
  await openScene(message.file);
  flowLinePicker = { file: message.file, scene: message.scene, startLine: message.startLine, endLine: message.endLine };
  flowPickHoverLine = message.startLine;
    const lines = splitEditorLines(editor.value);
  const start = lines.slice(0, message.startLine - 1).reduce((count, text) => count + text.length + 1, 0);
  revealEditorRange(start, start, message.startLine);
  updateHighlight();
}
function acceptFlowLinePicker(line) {
  const picker = flowLinePicker;
  if (!picker || !Number.isSafeInteger(line) || line < picker.startLine || line > picker.endLine) return false;
  finishFlowLinePicker(line);
  return true;
}
editor.addEventListener('mousemove', (event) => {
  if (!flowLinePicker) return;
  const line = flowPickerLineAt(editor, event);
  const next = line >= flowLinePicker.startLine && line <= flowLinePicker.endLine ? line : 0;
  if (next !== flowPickHoverLine) { flowPickHoverLine = next; updateHighlight(); }
});
editor.addEventListener('mouseleave', () => {
  if (!flowLinePicker || flowPickHoverLine === 0) return;
  flowPickHoverLine = 0; updateHighlight();
});
editor.addEventListener('click', (event) => {
  if (!flowLinePicker) return;
  if (acceptFlowLinePicker(flowPickerLineAt(editor, event))) event.stopImmediatePropagation();
}, true);
lineNumbers.addEventListener('mousemove', (event) => {
  if (!flowLinePicker) return;
  const line = flowPickerLineAt(lineNumbers, event);
  const next = line >= flowLinePicker.startLine && line <= flowLinePicker.endLine ? line : 0;
  if (next !== flowPickHoverLine) { flowPickHoverLine = next; updateHighlight(); }
});
lineNumbers.addEventListener('mouseleave', () => {
  if (!flowLinePicker || flowPickHoverLine === 0) return;
  flowPickHoverLine = 0; updateHighlight();
});
lineNumbers.addEventListener('click', (event) => {
  if (flowLinePicker) acceptFlowLinePicker(flowPickerLineAt(lineNumbers, event));
});
async function startSceneFlowDebug(message) {
  if (!sceneNames.includes(message.file)) throw Error('選択したnodeが現在の作品にありません');
  if (message.line !== null && (!Number.isSafeInteger(message.line) || message.line < 1)) throw Error('開始行が不正です');
  await saveAllScenes();
  if (flowNativeDebugSession) await stopSceneFlowDebug(false).catch(() => {});
  hideSceneFlowView();
  activateExplorerView();
  await openScene(message.file);
  flowNativeDebugLastLocationKey = '';
  flowNativeDebugActiveLoopKey = '';
  flowNativeDebugLoopSourceFile = '';
  setStatus('Native Playerでテスト再生を準備中…');
  const report = await request('/api/native-play', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: message.file,
      debugStart: { file: message.file, scene: message.scene, line: message.line, variables: message.variables || {} },
    }),
  });
  if (!report.session || report.engine !== 'native') throw Error('Native test Playerを開始できませんでした');
  flowNativeDebugSession = report.session;
  scheduleSceneFlowDebugPoll(report.session, 0);
  setStatus('Native Playerでテスト再生中', 'ok');
  notifySceneFlowDebugResult({ ok: true, active: true, message: 'Native Playerでテスト再生中です' });
}

function clearSceneFlowExecutionLine() {
  highlight?.querySelectorAll('.hl-running').forEach((line) => line.classList.remove('hl-running'));
  flowNativeDebugExecutionFile = '';
  flowNativeDebugExecutionLine = 0;
}

function loopRangesForDebugSource(file, source) {
  if (flowNativeDebugLoopSourceFile === file && flowNativeDebugLoopSource === source) return flowNativeDebugLoopRanges;
  flowNativeDebugLoopSourceFile = file;
  flowNativeDebugLoopSource = source;
  flowNativeDebugLoopRanges = [];
  const lineStarts = [0];
  for (let index = 0; index < source.length; index += 1) if (source[index] === '\n') lineStarts.push(index + 1);
  for (let lineIndex = 0; lineIndex < lineStarts.length; lineIndex += 1) {
    const lineStart = lineStarts[lineIndex];
    const lineEnd = source.indexOf('\n', lineStart);
    const lineText = source.slice(lineStart, lineEnd < 0 ? source.length : lineEnd);
    if (!/^\s*(?:for|while)\b/.test(lineText)) continue;
    let opening = -1;
    let quoted = false;
    let escaped = false;
    for (let index = lineStart; index < source.length; index += 1) {
      const char = source[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') { quoted = true; continue; }
      if (char === '#' || (char === '/' && source[index + 1] === '/')) {
        const newline = source.indexOf('\n', index);
        if (newline < 0) break;
        index = newline;
        continue;
      }
      if (char === '{') { opening = index; break; }
    }
    if (opening < 0) continue;
    const closing = matchingClosingBrace(source, opening);
    if (closing < 0) continue;
  const endLine = splitEditorLines(source.slice(0, closing)).length;
    flowNativeDebugLoopRanges.push({ startLine: lineIndex + 1, endLine, key: `${file}:${lineIndex + 1}:${endLine}` });
  }
  return flowNativeDebugLoopRanges;
}

function scrollExecutionLineIntoView(lineNumber) {
  const line = highlight?.children?.[lineNumber - 1];
  if (!line) return;
  const lineRect = line.getBoundingClientRect();
  const editorRect = editor.getBoundingClientRect();
  const style = getComputedStyle(editor);
  const paddingTop = Number.parseFloat(style.paddingTop) || 0;
  const paddingBottom = Number.parseFloat(style.paddingBottom) || 0;
  const visibleTop = editorRect.top + editor.clientTop + paddingTop;
  const visibleBottom = editorRect.top + editor.clientTop + editor.clientHeight - paddingBottom;
  if (lineRect.top >= visibleTop && lineRect.bottom <= visibleBottom) return;
  const contentTop = editor.scrollTop + lineRect.top - editorRect.top - editor.clientTop;
  const availableHeight = Math.max(1, editor.clientHeight - paddingTop - paddingBottom);
  editor.scrollTop = Math.max(0, contentTop - paddingTop - availableHeight * 0.35);
}

async function setSceneFlowExecutionLine(location) {
  const sequence = ++flowNativeDebugLocationSequence;
  clearSceneFlowExecutionLine();
  if (!location || !Number.isSafeInteger(Number(location.line)) || Number(location.line) < 1) return;
  const target = scenarioRelativePath(location.file) || location.file;
  if (sceneName.value !== target) {
    if (!sceneNames.includes(target)) return;
    await openScene(target);
  }
  if (sequence !== flowNativeDebugLocationSequence) return;
  const lineNumber = Number(location.line);
  flowNativeDebugExecutionFile = target;
  flowNativeDebugExecutionLine = lineNumber;
  const line = highlight?.children?.[lineNumber - 1];
  if (line?.classList.contains('hl-line')) line.classList.add('hl-running');
  const locationKey = `${normalizedScenePath(target)}:${location.scene}:${lineNumber}`;
  if (locationKey === flowNativeDebugLastLocationKey) return;
  flowNativeDebugLastLocationKey = locationKey;
  const loops = loopRangesForDebugSource(target, editor.value);
  const activeLoop = loops.filter((loop) => lineNumber >= loop.startLine && lineNumber <= loop.endLine)
    .sort((left, right) => right.endLine - left.endLine)[0];
  const activeLoopKey = activeLoop?.key || '';
  if (!activeLoopKey || activeLoopKey !== flowNativeDebugActiveLoopKey) scrollExecutionLineIntoView(lineNumber);
  flowNativeDebugActiveLoopKey = activeLoopKey;
}

function scheduleSceneFlowDebugPoll(session, delay = 100) {
  clearTimeout(flowNativeDebugPollTimer);
  flowNativeDebugPollTimer = setTimeout(async () => {
    if (flowNativeDebugSession !== session) return;
    if (flowNativeDebugPollBusy) { scheduleSceneFlowDebugPoll(session, 50); return; }
    flowNativeDebugPollBusy = true;
    try {
      const state = await request(`/api/native-play/state?session=${encodeURIComponent(session)}`);
      if (flowNativeDebugSession !== session) return;
      if (!state.active) {
        flowNativeDebugSession = '';
        clearSceneFlowExecutionLine();
        notifySceneFlowDebugResult({ ok: true, active: false, message: 'テスト再生が終了しました' });
        return;
      }
      await setSceneFlowExecutionLine(state.location);
      if (state.location) sceneFlowFrame?.contentWindow?.postMessage({ type: 'scene-flow:debug-location', location: state.location }, location.origin);
    } catch (error) {
      if (flowNativeDebugSession === session) console.warn('Nativeテスト再生位置を読み取れませんでした:', error);
    } finally {
      flowNativeDebugPollBusy = false;
      if (flowNativeDebugSession === session) scheduleSceneFlowDebugPoll(session, 90);
    }
  }, delay);
}

function notifySceneFlowDebugResult(result) {
  sceneFlowFrame?.contentWindow?.postMessage({ type: 'scene-flow:debug-play-result', ...result }, location.origin);
}

async function stopSceneFlowDebug(notify = true) {
  const session = flowNativeDebugSession;
  flowNativeDebugLocationSequence += 1;
  clearTimeout(flowNativeDebugPollTimer);
  flowNativeDebugPollTimer = 0;
  flowNativeDebugLastLocationKey = '';
  flowNativeDebugActiveLoopKey = '';
  clearSceneFlowExecutionLine();
  if (!session) {
    if (notify) notifySceneFlowDebugResult({ ok: true, active: false, message: '再生中のテストはありません' });
    return { ok: true, stopped: false };
  }
  const report = await request('/api/native-play/stop', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session }),
  });
  if (flowNativeDebugSession === session) flowNativeDebugSession = '';
  const message = report.stopped ? 'テスト再生を停止しました' : 'Test Playerはすでに終了しています';
  setStatus(message, 'ok');
  if (notify) notifySceneFlowDebugResult({ ok: true, active: false, message });
  return report;
}
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
  } else if (message.type === 'scene-flow:view' && message.view === 'presentation') {
    hideSceneFlowView();
    activatePresentationView();
  } else if (message.type === 'scene-flow:open-scene' && typeof message.scene === 'string') {
    hideSceneFlowView();
    activateExplorerView();
    openScene(message.scene).then(() => {
      if (typeof message.symbol !== 'string' || !message.symbol) return;
      const symbol = message.symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const match = new RegExp(`^\\s*(?:global\\s+)?(?:int|string|str|bool|struct|const)\\s+${symbol}\\b`, 'm').exec(editor.value);
      if (match) revealEditorRange(match.index, match.index + message.symbol.length);
    }).catch(showError);
  } else if (message.type === 'scene-flow:debug-play') {
    startSceneFlowDebug(message).catch((error) => {
      notifySceneFlowDebugResult({ ok: false, active: false, message: error.message });
      showError(error);
    });
  } else if (message.type === 'scene-flow:debug-stop') {
    stopSceneFlowDebug().catch((error) => {
      notifySceneFlowDebugResult({ ok: false, active: true, message: error.message });
      showError(error);
    });
  } else if (message.type === 'scene-flow:start-line-preview') {
    showFlowStartPreview(message.file, message.line).catch(showError);
  } else if (message.type === 'scene-flow:start-line-focus') {
    showFlowStartPreview(message.file, message.line, true).catch(showError);
  } else if (message.type === 'scene-flow:pick-line') {
    beginFlowLinePicker(message).catch(showError);
  } else if (message.type === 'scene-flow:help') {
    hideSceneFlowView();
    showLanguageGuide();
  }
});
function activateSearchView() {
  hideSceneFlowView();
  document.querySelector('.app-shell')?.classList.remove('sidebar-hidden');
  document.querySelector('.sidebar')?.classList.add('search-mode');
  document.querySelector('.sidebar')?.classList.remove('presentation-mode');
  document.querySelectorAll('.activity-button').forEach((button) => button.classList.toggle('active', button.dataset.activity === 'search'));
  searchView.hidden = false; searchInput.focus(); searchInput.select();
}
function activateExplorerView() {
  hideSceneFlowView();
  document.querySelector('.app-shell')?.classList.remove('sidebar-hidden');
  document.querySelector('.sidebar')?.classList.remove('search-mode');
  document.querySelector('.sidebar')?.classList.remove('presentation-mode');
  document.querySelectorAll('.activity-button').forEach((button) => button.classList.toggle('active', button.dataset.activity === 'explorer'));
}
function activatePresentationView() {
  hideSceneFlowView();
  document.querySelector('.app-shell')?.classList.remove('sidebar-hidden');
  const sidebar = document.querySelector('.sidebar');
  sidebar?.classList.remove('search-mode');
  sidebar?.classList.add('presentation-mode');
  document.querySelectorAll('.activity-button').forEach((button) => button.classList.toggle('active', button.dataset.activity === 'presentation'));
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
      splitEditorLines(data.source || '').forEach((line, index) => {
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
      button.addEventListener('click', async () => { await openScene(file.name); const lines = splitEditorLines(editor.value); let start = 0; for (let index = 0; index < match.line - 1; index++) start += lines[index].length + 1; revealEditorRange(start + match.start, start + match.start + match.length, match.line); });
      body.append(button);
    }
    group.append(heading, body); searchResults.append(group);
  }
}
function scheduleProjectSearch() { clearTimeout(searchTimer); searchTimer = setTimeout(() => runProjectSearch().catch(showError), 180); }

const menuActions = {
  'open-project': () => chooseProjectFolder().catch(showError),
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
  build: () => compileProjectFromMenu().catch(showError),
  compile: () => compileProjectFromMenu().catch(showError),
  play: () => playCurrentScene().catch(showError),
  'native-build': () => runNativeTool('build', 'Native build').catch(showError),
  'native-test': () => runNativeTestSuite().catch(showError),
  language: () => showLanguageGuide(),
  syntax: () => showLanguageGuide(),
  globals: () => showLanguageGuide(),
  about: () => showWorkbenchMessage('.tds Scenario Editor', 'Title・asset・scenarioを構成するローカル開発環境です。')
};
function toggleWordWrap() {
  const enabled = document.querySelector('.app-shell')?.classList.toggle('word-wrap-on') || false;
  try { localStorage.setItem('novel-editor.word-wrap.v1', enabled ? 'on' : 'off'); } catch { /* preference persistence is optional */ }
  return enabled;
}

try {
  if (localStorage.getItem('novel-editor.word-wrap.v1') === 'on') document.querySelector('.app-shell')?.classList.add('word-wrap-on');
} catch { /* local storage may be disabled */ }

function toggleLineComments(force = '') {
  const source = editor.value;
  const selectedStart = editor.selectionStart;
  const selectedEnd = editor.selectionEnd;
  const blockStart = source.lastIndexOf('\n', Math.max(0, selectedStart - 1)) + 1;
  let finalPosition = selectedEnd;
  if (finalPosition > selectedStart && source[finalPosition - 1] === '\n') finalPosition -= 1;
  const newline = source.indexOf('\n', finalPosition);
  const blockEnd = newline < 0 ? source.length : newline;
  const originalLines = splitEditorLines(source.slice(blockStart, blockEnd));
  const meaningful = originalLines.filter((line) => line.trim());
  if (!meaningful.length) return false;
  const removeComments = force === 'uncomment' || (force !== 'comment' && meaningful.every((line) => /^\s*(?:#|\/\/)/.test(line)));
  const changedLines = originalLines.map((line, index) => {
    if (!line.trim()) return line;
    if (removeComments) return line.replace(/^(\s*)(?:#|\/\/)[ \t]?/, '$1');
    if (/^\s*(?:#|\/\/)/.test(line)) return line;
    const indentation = line.match(/^\s*/)[0];
    return `${indentation}# ${line.slice(indentation.length)}`;
  });
  const replacement = changedLines.join('\n');
  if (replacement === source.slice(blockStart, blockEnd)) return false;
  rememberUndo();
  editor.value = `${source.slice(0, blockStart)}${replacement}${source.slice(blockEnd)}`;
  if (selectedStart === selectedEnd) {
    let lineColumn = selectedStart - blockStart;
    if (removeComments) {
      const marker = /^(\s*)(?:#|\/\/)[ \t]?/.exec(originalLines[0]);
      if (marker && lineColumn >= marker[0].length) lineColumn -= marker[0].length;
    } else {
      const indentationLength = originalLines[0].match(/^\s*/)[0].length;
      if (lineColumn >= indentationLength) lineColumn += 2;
    }
    const caret = Math.min(blockStart + changedLines[0].length, blockStart + lineColumn);
    editor.setSelectionRange(caret, caret);
  } else editor.setSelectionRange(blockStart, blockStart + replacement.length);
  editor.dispatchEvent(new Event('input', { bubbles: true }));
  editor.focus();
  return true;
}

async function goToDefinition() {
  const caret = editor.selectionStart;
  const lineStart = editor.value.lastIndexOf('\n', Math.max(0, caret - 1)) + 1;
  const lineText = editor.value.slice(lineStart, editor.value.indexOf('\n', lineStart) < 0 ? editor.value.length : editor.value.indexOf('\n', lineStart));
  const token = [...lineText.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)].find((match) => caret - lineStart >= match.index && caret - lineStart <= match.index + match[0].length);
  if (!token) { setStatus('定義へ移動する名前の上にカーソルを置いてください', 'warning'); return false; }
  const name = token[0];
  const localSymbol = extractQuickSymbols(editor.value, sceneName.value).find((item) => item.label === name);
  if (localSymbol && ['function', 'scene', 'struct', 'character'].includes(localSymbol.kind)) {
    await jumpToLocation(localSymbol, name);
    return true;
  }
  if (!knownVariableDataLoaded) {
    try { setKnownVariableData(await request('/api/variables')); } catch { /* local fallback below */ }
  }
  const variable = knownVariables.find((item) => item.name === name);
  const definition = variable?.definitions?.find((item) => item.file && item.line) || variable?.definitions?.find((item) => item.line);
  if (!definition) { setStatus(`'${name}' の定義位置が見つかりません`, 'warning'); return false; }
  await jumpToLocation(definition, name);
  return true;
}

function focusProblems() {
  activateExplorerView();
  const shell = document.querySelector('.app-shell');
  if (shell?.classList.contains('sidebar-hidden')) shell.classList.remove('sidebar-hidden');
  const problems = document.querySelector('.validation-card');
  if (!problems) return;
  problems.scrollIntoView({ block: 'nearest' });
  result.tabIndex = -1;
  result.focus({ preventScroll: true });
}

let diagnosticCursor = -1;
function navigateDiagnostic(direction) {
  const entries = diagnostics.filter(diagnosticForCurrentFile).sort((left, right) => Number(left.line || left.location?.line || 0) - Number(right.line || right.location?.line || 0));
  if (!entries.length) { setStatus('移動できる問題はありません', 'warning'); return false; }
  diagnosticCursor = (diagnosticCursor + direction + entries.length) % entries.length;
  const entry = entries[diagnosticCursor];
  jumpToLocation(entry.location || { file: sceneName.value, line: entry.line || 1 }).catch(showError);
  return true;
}

const quickAccessPanel = document.querySelector('#quick-access');
const quickAccessInput = document.querySelector('#quick-access-input');
const quickAccessResults = document.querySelector('#quick-access-results');
const quickAccessPrefix = document.querySelector('#quick-access-prefix');
const quickAccessHint = document.querySelector('#quick-access-hint');
const QUICK_RECENT_COMMANDS_KEY = 'novel-editor.recent-commands.v1';
const QUICK_RECENT_FILES_KEY = 'novel-editor.recent-files.v1';
const commandEntries = [
  ['open-project', 'フォルダーを開く', 'ファイル'],
  ['project-settings', '作品設定を開く', '設定'], ['save', 'すべて保存', 'ファイル', 'Ctrl+S'],
  ['undo', '元に戻す', '編集', 'Ctrl+Z'], ['redo', 'やり直す', '編集', 'Ctrl+Y'],
  ['format', 'Format current scene', '編集', 'Ctrl+Shift+F'], ['format-project', 'Format all scenes', '編集'],
  ['select-all', 'すべて選択', '選択', 'Ctrl+A'], ['select-line', '現在の行を選択', '選択'],
  ['toggle-sidebar', 'Toggle sidebar', '表示', 'Ctrl+B'], ['toggle-minimap', 'Toggle Minimap', '表示'],
  ['scene-flow', 'Open Scene Flow', '表示'], ['compile', 'Validate / Compile project', '実行', 'Ctrl+Enter'],
  ['play', 'Play current scene', '実行'], ['native-build', 'Build Native Player', '実行'],
  ['native-test', 'Test Native Player', '実行'], ['language', 'Open Syntax Guide', 'ヘルプ'],
].map(([id, label, category, key]) => ({ id, label, category, key, run: menuActions[id] }));
commandEntries.find((item) => item.id === 'open-project').key = 'Ctrl+O';
commandEntries.push(
  { id: 'new-scene', label: 'Create new scene', category: 'ファイル', key: 'Ctrl+N', run: createNewSceneDraft },
  { id: 'quick-open', label: 'Quick Open Scene File', category: '移動', key: 'Ctrl+P', run: () => openQuickOpen() },
  { id: 'go-to-line', label: '行番号へ移動', category: '移動', key: 'Ctrl+G', run: () => openQuickOpen('line') },
  { id: 'find-in-file', label: '編集中ファイルを検索', category: '検索', key: 'Ctrl+F', run: () => openEditorFind(false) },
  { id: 'replace-in-file', label: '編集中ファイルを置換', category: '検索', key: 'Ctrl+H', run: () => openEditorFind(true) },
  { id: 'search-workspace', label: 'ワークスペースを検索', category: '検索', run: activateSearchView },
  { id: 'show-explorer', label: 'Show Explorer', category: '表示', key: 'Ctrl+Shift+E', run: activateExplorerView },
  { id: 'toggle-word-wrap', label: '行の折り返しを切り替え', category: '表示', key: 'Alt+Z', run: toggleWordWrap },
  { id: 'toggle-line-comments', label: '行コメントを切り替え', category: '編集', key: 'Ctrl+/', run: toggleLineComments },
  { id: 'open-settings', label: '作品・表示設定を開く', category: '設定', key: 'Ctrl+,', run: () => showProjectSettings().catch(showError) },
  { id: 'go-to-definition', label: 'カーソル位置の定義へ移動', category: '移動', key: 'F12', run: goToDefinition },
  { id: 'show-problems', label: '問題一覧へ移動', category: '表示', key: 'Ctrl+Shift+M', run: focusProblems },
);

let quickAccessMode = 'command';
let quickAccessBaseMode = 'command';
let quickAccessItems = [];
let quickAccessActiveIndex = 0;
let quickAccessRequestId = 0;
let quickAccessDebounce = null;
let recentQuickCommands = readQuickAccessHistory(QUICK_RECENT_COMMANDS_KEY);
let recentQuickFiles = readQuickAccessHistory(QUICK_RECENT_FILES_KEY);

function readQuickAccessHistory(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(value) ? value.filter((item) => typeof item === 'string').slice(0, 20) : [];
  } catch { return []; }
}

function storeQuickAccessHistory(key, values) {
  try { localStorage.setItem(key, JSON.stringify(values.slice(0, 20))); } catch { /* storage is optional */ }
}

function fuzzyScore(query, text) {
  const needle = query.toLocaleLowerCase();
  const haystack = String(text).toLocaleLowerCase();
  if (!needle) return 0;
  let cursor = 0;
  let score = 0;
  let previous = -2;
  for (const character of needle) {
    const index = haystack.indexOf(character, cursor);
    if (index < 0) return null;
    score += index - cursor + (index === previous + 1 ? -2 : 0) + (index === 0 || /[\s/_.-]/.test(haystack[index - 1]) ? -1 : 0);
    previous = index;
    cursor = index + 1;
  }
  return score + haystack.length * 0.001;
}

function makeQuickAccessItem({ label, detail = '', key = '', run, id = '' }) {
  return { label: String(label), detail: String(detail), key, run, id };
}

function paintQuickAccessItems(items, emptyMessage = '一致する項目はありません') {
  quickAccessItems = items;
  quickAccessActiveIndex = Math.min(quickAccessActiveIndex, Math.max(0, items.length - 1));
  quickAccessResults.replaceChildren();
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'quick-access-empty';
    empty.textContent = emptyMessage;
    quickAccessResults.append(empty);
    quickAccessInput.removeAttribute('aria-activedescendant');
    return;
  }
  items.forEach((item, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.id = `quick-access-option-${index}`;
    button.className = 'quick-access-item';
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', String(index === quickAccessActiveIndex));
    const main = document.createElement('span'); main.className = 'quick-access-item-main';
    const label = document.createElement('span'); label.className = 'quick-access-item-label'; label.textContent = item.label;
    main.append(label);
    if (item.detail) { const detail = document.createElement('span'); detail.className = 'quick-access-item-description'; detail.textContent = item.detail; main.append(detail); }
    button.append(main);
    if (item.key) { const shortcut = document.createElement('kbd'); shortcut.textContent = item.key; button.append(shortcut); }
    button.addEventListener('mouseenter', () => { quickAccessActiveIndex = index; updateQuickAccessSelection(); });
    button.addEventListener('click', () => runQuickAccessItem(index));
    quickAccessResults.append(button);
  });
  updateQuickAccessSelection();
}

function updateQuickAccessSelection() {
  const items = [...quickAccessResults.querySelectorAll('.quick-access-item')];
  items.forEach((item, index) => item.setAttribute('aria-selected', String(index === quickAccessActiveIndex)));
  const active = items[quickAccessActiveIndex];
  if (active && !quickAccessPanel.hidden) quickAccessInput.setAttribute('aria-activedescendant', active.id);
  else quickAccessInput.removeAttribute('aria-activedescendant');
  quickAccessResults.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
}

function filteredItems(items, query, searchText = (item) => `${item.label} ${item.detail}`) {
  return items.map((item, index) => ({ item, index, score: fuzzyScore(query, searchText(item)) }))
    .filter((entry) => entry.score !== null)
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .slice(0, 80)
    .map((entry) => entry.item);
}

function extractQuickSymbols(source, file) {
  const symbols = [];
  const patterns = [
    ['scene', /^\s*scene\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/],
    ['function', /^\s*fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/],
    ['struct', /^\s*struct\s+([A-Za-z_][A-Za-z0-9_]*)\b/],
    ['character', /^\s*character\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/],
    ['variable', /^\s*(?:global\s+)?(?:const\s+)?(?:int|str|string|bool|float|dict(?:\[(?:int|str)\])?|[A-Z][A-Za-z0-9_]*)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:=|$)/],
  ];
  splitEditorLines(source).forEach((line, index) => {
    for (const [kind, pattern] of patterns) {
      const match = pattern.exec(line);
      if (!match) continue;
      symbols.push({ label: match[1], kind, file, line: index + 1, column: line.indexOf(match[1]) + 1 });
      break;
    }
  });
  return symbols;
}

async function workspaceQuickSymbols() {
  if (!sceneNames.length) {
    const data = await request('/api/scenes');
    sceneNames = data.scenes || [];
  }
  if (!quickWorkspaceSymbolsPromise) {
    quickWorkspaceSymbolsPromise = Promise.all(sceneNames.map(async (file) => {
      try {
        const data = await request(`/api/scene?name=${encodeURIComponent(file)}`);
        return extractQuickSymbols(data.source, file);
      } catch { return []; }
    })).then((values) => values.flat());
  }
  const symbols = await quickWorkspaceSymbolsPromise;
  const current = sceneName.value;
  return [...symbols.filter((item) => item.file !== current), ...extractQuickSymbols(editor.value, current)];
}

function quickAccessModeForValue(value) {
  if (value.startsWith('>')) return 'command';
  if (value.startsWith(':')) return 'line';
  if (value.startsWith('@')) return 'symbol';
  if (value.startsWith('#')) return 'workspace-symbol';
  return quickAccessBaseMode === 'command' ? 'command' : 'file';
}

async function renderQuickAccess() {
  const requestId = ++quickAccessRequestId;
  const value = quickAccessInput.value;
  const mode = quickAccessModeForValue(value);
  const query = mode === 'command' ? value.replace(/^>\s*/, '')
    : mode === 'line' ? value.replace(/^:/, '')
      : mode === 'symbol' || mode === 'workspace-symbol' ? value.slice(1) : value;
  quickAccessMode = mode;
  const modeLabels = {
    command: ['⌘', '> Search commands'], file: ['⌕', 'Search files'],
    line: ['＃', ': 行番号へ移動'], symbol: ['@', '@ File Symbols'],
    'workspace-symbol': ['#', '# Workspace Symbols'],
  };
  const [prefix, placeholder] = modeLabels[mode];
  quickAccessPrefix.textContent = prefix;
  quickAccessInput.placeholder = placeholder;
  quickAccessHint.textContent = mode === 'command' ? '↑↓ 選択　Enter 実行　Esc 閉じる' : '↑↓ 選択　Enter 開く　Esc 閉じる';

  if (mode === 'command') {
    const recent = recentQuickCommands.map((id) => commandEntries.find((item) => item.id === id)).filter(Boolean);
    const base = query ? commandEntries : [...recent, ...commandEntries.filter((item) => !recentQuickCommands.includes(item.id))];
    paintQuickAccessItems(filteredItems(base, query, (item) => `${item.label} ${item.category} ${item.key || ''}`)
      .map((item) => makeQuickAccessItem({ ...item, detail: item.category })));
    return;
  }
  if (mode === 'file') {
    const recent = recentQuickFiles.map((file) => sceneNames.includes(file) ? file : null).filter(Boolean);
    const files = query ? sceneNames : [...recent, ...sceneNames.filter((file) => !recent.includes(file))];
    paintQuickAccessItems(filteredItems(files.map((file) => makeQuickAccessItem({ label: fileLabel(file), detail: file })), query, (item) => `${item.label} ${item.detail}`)
      .map((item) => ({ ...item, run: () => {
        recentQuickFiles = [item.detail, ...recentQuickFiles.filter((file) => file !== item.detail)].slice(0, 20);
        storeQuickAccessHistory(QUICK_RECENT_FILES_KEY, recentQuickFiles);
        return openScene(item.detail).then(() => {
          const active = document.activeElement;
          if (quickAccessPanel.hidden && (active === document.body || active?.closest('#quick-access'))) editor.focus();
        });
      } })));
    return;
  }
  if (mode === 'line') {
    const match = /^(\d+)(?::(\d+))?$/.exec(query);
    const line = Number(match?.[1]);
    const column = Number(match?.[2] || 1);
    paintQuickAccessItems(match && line > 0 ? [makeQuickAccessItem({
      label: `行 ${line}${match[2] ? `、列 ${column}` : ''} へ移動`, detail: sceneName.value || '現在のファイル', key: 'Enter',
      run: () => jumpToLocation({ file: sceneName.value, line, column }),
    })] : [], '行番号または 行:列 を入力してください');
    return;
  }
  if (mode === 'symbol') {
    const symbols = extractQuickSymbols(editor.value, sceneName.value);
    paintQuickAccessItems(filteredItems(symbols, query, (item) => `${item.label} ${item.kind}`)
      .map((item) => makeQuickAccessItem({ label: item.label, detail: `${item.kind} · ${item.file}:${item.line}`, run: () => jumpToLocation(item, item.label) })));
    return;
  }
  quickAccessResults.replaceChildren(Object.assign(document.createElement('div'), { className: 'quick-access-empty', textContent: 'Searching workspace symbols…' }));
  try {
    const symbols = await workspaceQuickSymbols();
    if (requestId !== quickAccessRequestId || quickAccessPanel.hidden) return;
    paintQuickAccessItems(filteredItems(symbols, query, (item) => `${item.label} ${item.kind} ${item.file}`)
      .map((item) => makeQuickAccessItem({ label: item.label, detail: `${item.kind} · ${item.file}:${item.line}`, run: () => jumpToLocation(item, item.label) })));
  } catch (error) {
    if (requestId !== quickAccessRequestId) return;
    paintQuickAccessItems([], error.message || '\u30b7\u30f3\u30dc\u30eb\u3092\u8aad\u307f\u8fbc\u3081\u307e\u305b\u3093\u3067\u3057\u305f');
  }
}

function openQuickAccess(mode = 'command', seed = null) {
  const opener = document.activeElement;
  closeMenus();
  quickAccessBaseMode = mode;
  quickAccessMode = mode;
  quickAccessPanel.hidden = false;
  quickAccessInput.setAttribute('aria-expanded', 'true');
  activateEditorModal(quickAccessPanel, quickAccessInput, opener, { backdrop: false });
  quickAccessInput.value = seed ?? ({ command: '>', line: ':', symbol: '@', 'workspace-symbol': '#' }[mode] || '');
  quickAccessActiveIndex = 0;
  renderQuickAccess();
  quickAccessInput.focus();
  quickAccessInput.setSelectionRange(quickAccessInput.value.length, quickAccessInput.value.length);
}

function openCommandPalette() { openQuickAccess('command', '>'); }
function openQuickOpen(mode = 'file') { openQuickAccess(mode, ({ line: ':', symbol: '@', 'workspace-symbol': '#' }[mode] || '')); }

function closeQuickAccess(restoreFocus = true) {
  quickAccessRequestId++;
  deactivateEditorModal(quickAccessPanel, restoreFocus);
  quickAccessPanel.hidden = true;
  quickAccessInput.setAttribute('aria-expanded', 'false');
  quickAccessInput.removeAttribute('aria-activedescendant');
}

function runQuickAccessItem(index = quickAccessActiveIndex) {
  const item = quickAccessItems[index];
  if (!item) return;
  if (item.id) {
    recentQuickCommands = [item.id, ...recentQuickCommands.filter((id) => id !== item.id)].slice(0, 20);
    storeQuickAccessHistory(QUICK_RECENT_COMMANDS_KEY, recentQuickCommands);
  }
  closeQuickAccess(false);
  try { Promise.resolve(item.run?.()).catch(showError); } catch (error) { showError(error); }
}

function quickAccessFuzzyFilter() {
  quickAccessActiveIndex = 0;
  clearTimeout(quickAccessDebounce);
  renderQuickAccess().catch(showError);
}

quickAccessInput.addEventListener('input', quickAccessFuzzyFilter);
quickAccessInput.addEventListener('keydown', async (event) => {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    if (!quickAccessItems.length) return;
    event.preventDefault();
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    quickAccessActiveIndex = (quickAccessActiveIndex + delta + quickAccessItems.length) % quickAccessItems.length;
    updateQuickAccessSelection();
  } else if (event.key === 'Enter') {
    event.preventDefault();
    clearTimeout(quickAccessDebounce);
    await renderQuickAccess();
    if (!quickAccessPanel.hidden) runQuickAccessItem();
  } else if (event.key === 'Escape') {
    event.preventDefault();
    closeQuickAccess();
  }
});
quickAccessPanel.querySelector('.quick-access-backdrop').addEventListener('click', () => closeQuickAccess());

document.querySelectorAll('[data-menu-action]').forEach((button) => button.addEventListener('click', () => {
  const action = menuActions[button.dataset.menuAction];
  closeMenus();
  action?.();
}));
document.querySelector('[data-activity="explorer"]')?.addEventListener('click', activateExplorerView);
document.querySelector('[data-activity="search"]')?.addEventListener('click', activateSearchView);
document.querySelector('[data-activity="flow"]')?.addEventListener('click', showSceneFlowView);
document.querySelector('[data-activity="presentation"]')?.addEventListener('click', activatePresentationView);
document.querySelector('[data-presentation-action="game-screens"]')?.addEventListener('click', () => showGameScreenSettings().catch(showError));
document.querySelector('[data-presentation-action="project-settings"]')?.addEventListener('click', () => showProjectSettings().catch(showError));
document.querySelector('.flow-link')?.addEventListener('click', (event) => { event.preventDefault(); showSceneFlowView(); });
document.querySelector('#search-close')?.addEventListener('click', activateExplorerView);
if (new URLSearchParams(location.search).get('view') === 'presentation') activatePresentationView();
searchInput?.addEventListener('input', scheduleProjectSearch);
document.querySelectorAll('[data-search-option]').forEach((button) => button.addEventListener('click', () => {
  const option = button.dataset.searchOption;
  if (searchOptions.has(option)) searchOptions.delete(option); else searchOptions.add(option);
  button.classList.toggle('active', searchOptions.has(option));
  button.setAttribute('aria-pressed', String(searchOptions.has(option)));
  runProjectSearch().catch(showError);
}));
