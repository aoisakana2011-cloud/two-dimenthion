'use strict';
const $ = id => document.getElementById(id);
let playerTheme = null;
let gameScreenConfig = null;
let activeGameScreen = null;
let gameStarted = false;
let gameStartHandler = null;
let saveStoragePrefix = '';
let saveStore = null;
const saveSlotCache = new Map();
const saveSlotStates = new Map();
const saveThumbnailUrls = new Map();
let currentExecution = null;
let resumeAtLaunch = null;
let pendingScreenMusic = '';
const bgmLayers = new Set();
const bgmAnimationIds = new WeakMap();
const bgmGainNodes = new WeakMap();
const uiAudioRoutes = new WeakMap();
const bgmAutomations = new Map();
const activeUiAudio = new Set();
let userUiSettings = Object.create(null);
let audioBuses = null;
let currentDialogBaseOpacity = 1;
function applyDialogOpacity(base) {
  currentDialogBaseOpacity = Number.isFinite(Number(base)) ? Number(base) : 1;
  $('dialogue')?.style.setProperty('--dialog-opacity', String(currentDialogBaseOpacity * Number(userUiSettings['ui.dialogOpacity'] ?? 1)));
}
let nextBgmAnimationId = 0;
let bgmAudioContext = null;
function getBgmAudioContext() {
  const AudioContextType = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextType) return null;
  try {
    if (!bgmAudioContext) {
      bgmAudioContext = new AudioContextType();
      const master = bgmAudioContext.createGain();
      const buses = Object.fromEntries(['bgm', 'se', 'voice'].map(kind => [kind, bgmAudioContext.createGain()]));
      for (const bus of Object.values(buses)) bus.connect(master);
      master.connect(bgmAudioContext.destination);
      audioBuses = { master, ...buses };
      applyUiAudioMix();
    }
    return bgmAudioContext;
  }
  catch { return null; }
}
function settingOn(key) { return Boolean(userUiSettings[key] ?? gameScreenConfig?.controlDefaults?.[key] ?? false); }
function settingGain(kind) { return settingOn(`audio.${kind}Muted`) ? 0 : Number(userUiSettings[`audio.${kind}`] ?? gameScreenConfig?.controlDefaults?.[`audio.${kind}`] ?? (kind === 'voice' ? 0.5 : 1)); }
function applyUiAudioMix() {
  if (audioBuses && bgmAudioContext) {
    const now = bgmAudioContext.currentTime;
    audioBuses.master.gain.setTargetAtTime(Number(userUiSettings['audio.master'] ?? gameScreenConfig?.controlDefaults?.['audio.master'] ?? 1), now, 0.015);
    for (const kind of ['bgm', 'se', 'voice']) audioBuses[kind].gain.setTargetAtTime(settingGain(kind), now, 0.015);
  }
  for (const audio of activeUiAudio) {
    if (!audio.isConnected || bgmGainNodes.has(audio) || uiAudioRoutes.has(audio)) continue;
    const base = Number(audio.dataset.userGain ?? 1);
    const kind = audio.dataset.audioKind || 'se';
    audio.volume = Math.max(0, Math.min(1, base * Number(userUiSettings['audio.master'] ?? 1) * settingGain(kind)));
  }
}
async function loadUiSettings() {
  const defaults = gameScreenConfig?.controlDefaults || {};
  const stored = await saveStore.readPreference('ui-settings') || {};
  userUiSettings = Object.create(null);
  for (const [key, fallback] of Object.entries(defaults)) {
    const value = stored[key];
    userUiSettings[key] = typeof fallback === 'boolean'
      ? (typeof value === 'boolean' ? value : fallback)
      : (Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback);
  }
  applyDialogOpacity(currentDialogBaseOpacity);
  applyUiAudioMix();
}
function updateUiSetting(key, value) {
  const fallback = gameScreenConfig?.controlDefaults?.[key];
  if (typeof fallback === 'boolean') { if (typeof value !== 'boolean') return; }
  else if (typeof fallback !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) return;
  userUiSettings[key] = value;
  void saveStore.writePreference('ui-settings', { ...userUiSettings }).catch(error => {
    const notice = document.createElement('div'); notice.className = 'game-screen-error';
    notice.textContent = `設定を保存できませんでした: ${error.message}`; $('screen-overlay').append(notice);
  });
  if (key === 'ui.dialogOpacity') applyDialogOpacity(currentDialogBaseOpacity);
  applyUiAudioMix();
}
function primeBgmAudioContext() {
  const context = getBgmAudioContext();
  if (context?.state === 'suspended') context.resume().catch(() => {});
}
async function connectBgmAudio(audio, initialGain) {
  const context = getBgmAudioContext();
  if (!context || context.state === 'closed') return false;
  try {
    if (context.state === 'suspended') {
      // resume() can remain pending indefinitely until a user gesture. Never
      // let loading a scene block on audio autoplay policy; use the legacy
      // media-element path if the audio clock is not available promptly.
      await Promise.race([
        context.resume(),
        new Promise(resolve => setTimeout(resolve, 200)),
      ]);
    }
    if (context.state !== 'running') return false;
    const source = context.createMediaElementSource(audio);
    const gain = context.createGain();
    gain.gain.setValueAtTime(initialGain, context.currentTime);
    source.connect(gain);
    gain.connect(audioBuses?.bgm || context.destination);
    bgmGainNodes.set(audio, { context, source, gain, value: initialGain, kind: 'bgm' });
    audio.volume = 1;
    return true;
  } catch {
    return false;
  }
}
function disconnectBgmAudio(audio) {
  const route = bgmGainNodes.get(audio);
  if (!route) return;
  route.source.disconnect();
  route.gain.disconnect();
  bgmGainNodes.delete(audio);
}
async function connectUiAudio(audio, kind, baseGain) {
  const context = getBgmAudioContext();
  if (!context || context.state === 'closed') return false;
  try {
    if (context.state === 'suspended') await Promise.race([context.resume(), new Promise(resolve => setTimeout(resolve, 200))]);
    if (context.state !== 'running') return false;
    const source = context.createMediaElementSource(audio);
    const gain = context.createGain();
    gain.gain.value = baseGain;
    source.connect(gain);
    gain.connect(audioBuses?.[kind] || context.destination);
    uiAudioRoutes.set(audio, { source, gain });
    audio.volume = 1;
    return true;
  } catch { return false; }
}
function disconnectUiAudio(audio) {
  const route = uiAudioRoutes.get(audio);
  if (route) { route.source.disconnect(); route.gain.disconnect(); uiAudioRoutes.delete(audio); }
  activeUiAudio.delete(audio);
}
function uiAsset(themePath, image) {
  if (!image) return '';
  const directory = themePath.replaceAll('\\', '/').split('/').slice(0, -1);
  return '/asset/' + [...directory, image].map(encodeURIComponent).join('/');
}
function uiBackground(themePath, image, fallback) {
  return image ? `url("${uiAsset(themePath, image)}") center / 100% 100% no-repeat` : fallback;
}
function applyPlayerUi(themePath, theme) {
  playerTheme = { path: themePath, ...theme };
  const { screen, dialog, choices } = theme;
  const stage = $('stage'), dialogue = $('dialogue'), speaker = $('speaker'), speakerText = $('speaker-text'), text = $('text'), choiceBox = $('choices');
  stage.style.width = `${screen.width}px`; stage.style.height = `${screen.height}px`;
  Object.assign(dialogue.style, { left: `${dialog.x}px`, top: `${dialog.y}px`, right: 'auto', bottom: 'auto', width: `${dialog.width}px`, height: `${dialog.height}px`, minHeight: '0', padding: '0', borderRadius: dialog.image ? '0' : '12px' });
  dialogue.style.setProperty('--dialog-background', uiBackground(themePath, dialog.image, '#07111ddd'));
  dialogue.style.setProperty('--dialog-border', dialog.image ? '0' : '1px solid #8ab8d8');
  applyDialogOpacity(dialog.opacity ?? 1);
  Object.assign(text.style, { position: 'absolute', left: `${dialog.message.x}px`, top: `${dialog.message.y}px`, width: `${dialog.message.width}px`, height: `${dialog.message.height}px`, overflowX: 'hidden', overflowY: 'auto', fontSize: `${dialog.message.size}px`, color: `rgba(${dialog.message.color.join(',')})` });
  Object.assign(speaker.style, { position: 'absolute', display: 'grid', placeItems: 'center', left: `${dialog.nameplate.x}px`, top: `${dialog.nameplate.y}px`, width: `${dialog.nameplate.width}px`, height: `${dialog.nameplate.height}px`, color: `rgba(${dialog.nameplate.text.color.join(',')})`, fontSize: `${dialog.nameplate.text.size}px`, background: uiBackground(themePath, dialog.nameplate.image, '#1d344dcc'), borderRadius: dialog.nameplate.image ? '0' : '6px' });
  Object.assign(speakerText.style, { position: 'absolute', left: `${dialog.nameplate.text.x || 0}px`, top: `${dialog.nameplate.text.y || 0}px`, width: `${dialog.nameplate.text.width}px`, height: `${dialog.nameplate.text.height}px`, display: 'grid', placeItems: 'center', overflow: 'hidden' });
  Object.assign(choiceBox.style, { position: 'absolute', left: `${choices.x - dialog.x}px`, top: `${choices.y - dialog.y}px`, width: `${choices.width}px`, height: `${choices.height}px`, overflowY: 'auto', overflowX: 'hidden' });
  renderPlayerControls(theme.controls || defaultPlayerControls(), theme.screen, dialog);
  const fog = screen.backdrop?.bottomFog;
  let fogLayer = $('bottom-fog');
  if (!fogLayer) { fogLayer = document.createElement('canvas'); fogLayer.id = 'bottom-fog'; stage.insertBefore(fogLayer, dialogue); }
  Object.assign(fogLayer.style, { position: 'absolute', left: '0', bottom: '0', pointerEvents: 'none', display: fog?.enabled ? 'block' : 'none' });
  if (fog?.enabled) {
    const height = Math.min(Number(fog.height || 300), screen.height * 0.6);
    fogLayer.width = screen.width; fogLayer.height = Math.ceil(height);
    fogLayer.style.width = `${screen.width}px`; fogLayer.style.height = `${height}px`;
    const [r, g, b, a = 255] = fog.color || [255, 250, 253, 255];
    const context = fogLayer.getContext('2d');
    context.clearRect(0, 0, fogLayer.width, fogLayer.height);
    for (let row = 0; row < fogLayer.height; row++) {
      const t = (row + 1) / fogLayer.height;
      context.fillStyle = `rgba(${r},${g},${b},${a / 255 * 210 / 255 * t * t})`;
      context.fillRect(0, row, fogLayer.width, 1);
    }
  }
  const fitStage = () => {
    const portrait = innerHeight > innerWidth;
    // Fill the viewport to avoid letterboxing. The stage remains clipped at its
    // edges, which is preferable to unused black bands above and below the game.
    const scale = portrait
      ? Math.max(innerWidth / screen.height, innerHeight / screen.width)
      : Math.max(innerWidth / screen.width, innerHeight / screen.height);
    stage.style.position = 'fixed';
    stage.style.left = '50%';
    stage.style.top = '50%';
    stage.style.margin = '0';
    stage.style.transformOrigin = 'center center';
    stage.style.transform = `translate(-50%, -50%) ${portrait ? 'rotate(90deg) ' : ''}scale(${scale})`;
  };
  fitStage();
  const debugSession = new URLSearchParams(location.search).get('debug');
  if (debugSession && window.parent !== window) {
    window.parent.postMessage({ type: 'novel-debug:screen', session: debugSession, width: screen.width, height: screen.height }, location.origin);
  }
  window.addEventListener('resize', fitStage);
  window.visualViewport?.addEventListener('resize', fitStage);
}

function defaultPlayerControls() {
  return { enabled: true, anchor: 'dialogue-top-left', buttons: [
    { id: 'save', label: 'Save', action: 'save', x: 0, y: -44, width: 84, height: 36 },
    { id: 'load', label: 'Load', action: 'load', x: 92, y: -44, width: 84, height: 36 },
  ] };
}
function renderPlayerControls(controls, screen, dialog) {
  const stage = $('stage');
  let bar = $('player-controls');
  if (!bar) { bar = document.createElement('nav'); bar.id = 'player-controls'; stage.append(bar); }
  bar.replaceChildren();
  if (controls?.enabled === false) { bar.hidden = true; return; }
  bar.hidden = false;
  const anchor = controls?.anchor === 'dialogue-top-left';
  for (const item of controls?.buttons || []) {
    if (!item || !['save', 'load'].includes(item.action)) continue;
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'player-control-button'; button.dataset.action = item.action;
    button.setAttribute('aria-label', item.label || item.action);
    button.title = item.label || item.action;
    const label = document.createElement('span'); label.textContent = item.label || item.action; button.append(label);
    if (item.display === 'image') label.hidden = true;
    Object.assign(button.style, {
      left: `${((anchor ? dialog.x : 0) + (Number(item.x) || 0))}px`,
      top: `${((anchor ? dialog.y : 0) + (Number(item.y) || 0))}px`,
      width: `${Math.max(24, Number(item.width) || 84)}px`, height: `${Math.max(20, Number(item.height) || 36)}px`,
      color: item.color || '', backgroundColor: item.backgroundColor || '', borderColor: item.borderColor || '',
      borderRadius: Number.isFinite(item.borderRadius) ? `${item.borderRadius}px` : '',
      fontSize: Number.isFinite(item.fontSize) ? `${item.fontSize}px` : '',
    });
    const setState = active => {
      const image = active ? item.hoverImage || item.image : item.image;
      button.style.backgroundImage = image ? `url("${screenAsset(image)}")` : 'none';
      if (active) {
        if (item.hoverLabel) label.textContent = item.hoverLabel;
        if (item.display === 'image') label.hidden = true;
        if (item.hoverColor) button.style.color = item.hoverColor;
        if (item.hoverBackgroundColor) button.style.backgroundColor = item.hoverBackgroundColor;
        if (item.hoverBorderColor) button.style.borderColor = item.hoverBorderColor;
      } else {
        label.textContent = item.label || item.action;
        label.hidden = item.display === 'image';
        button.style.color = item.color || '';
        button.style.backgroundColor = item.backgroundColor || '';
        button.style.borderColor = item.borderColor || '';
      }
    };
    setState(false);
    button.addEventListener('pointerenter', () => setState(true)); button.addEventListener('pointerleave', () => setState(false));
    button.addEventListener('focus', () => setState(true)); button.addEventListener('blur', () => setState(false));
    button.addEventListener('click', () => openSlotScreen(item.action));
    bar.append(button);
  }
}

function playScreenMusic(assetPath) {
  pendingScreenMusic = assetPath || '';
  if (!pendingScreenMusic) return;
  stopBgm();
  $('bgm')?.remove();
  const audio = document.createElement('audio'); audio.id = 'bgm'; audio.loop = true;
  const asset = runtime.program?.assets?.find(item => item.type === 'bgm' && item.name === pendingScreenMusic);
  audio.dataset.audioKind = 'bgm'; audio.dataset.userGain = '1'; activeUiAudio.add(audio);
  audio.src = asset ? url('bgm', pendingScreenMusic) : screenAsset(pendingScreenMusic); document.body.append(audio); bgmLayers.add(audio); applyUiAudioMix();
  connectBgmAudio(audio, 1).then(() => audio.play()).catch(() => { /* Browser autoplay requires a user gesture. */ });
}
function resumeScreenMusic() {
  const audio = $('bgm');
  if (audio?.paused && pendingScreenMusic) audio.play().catch(() => {});
}

function makeChoice(label, index) {
  const { path, choices } = playerTheme;
  const button = document.createElement('button');
  button.className = 'choice';
  button.type = 'button';
  button.style.height = `${choices.itemHeight}px`;
  button.style.margin = `0 0 ${choices.gap}px`;
  button.style.backgroundImage = choices.image ? `url("${uiAsset(path, choices.image)}")` : 'none';
  button.style.backgroundSize = '100% 100%';
  button.style.backgroundColor = choices.image ? 'transparent' : '#10243acc';
  button.style.border = choices.image ? '0' : '1px solid #8ab8d8';
  button.style.borderRadius = choices.image ? '0' : '8px';
  button.style.color = `rgba(${choices.text.color.join(',')})`;
  button.style.fontSize = `${choices.text.size}px`;
  button.setAttribute('aria-label', label);
  const text = document.createElement('span');
  text.textContent = label;
  Object.assign(text.style, { position: 'absolute', left: `${choices.text.x}px`, top: `${choices.text.y}px`, width: `${choices.text.width}px`, height: `${choices.text.height}px`, overflow: 'hidden', whiteSpace: 'pre-wrap', textAlign: 'left' });
  button.append(text);
  const setActive = active => {
    const image = active ? choices.activeImage : choices.image;
    button.style.backgroundImage = image ? `url("${uiAsset(path, image)}")` : 'none';
    if (!choices.image && !choices.activeImage) button.style.backgroundColor = active ? '#285577' : '#10243acc';
  };
  setActive(index === 0);
  button.addEventListener('mouseenter', () => setActive(true));
  button.addEventListener('mouseleave', () => setActive(false));
  button.addEventListener('focus', () => setActive(true));
  button.addEventListener('blur', () => setActive(false));
  return button;
}
function screenAsset(value) {
  const relative = String(value || '').replaceAll('\\', '/').replace(/^asset\//i, '');
  if (!relative || relative.split('/').some(part => !part || part === '.' || part === '..')) return '';
  return '/asset/' + relative.split('/').map(encodeURIComponent).join('/');
}
function encodeSave(value) {
  return JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? { __novelInteger: item.toString() } : item);
}
function decodeSave(value) {
  return JSON.parse(value, (_key, item) => item && typeof item === 'object' && Object.keys(item).length === 1 && typeof item.__novelInteger === 'string'
    ? NovelRuntime.integer(item.__novelInteger) : item);
}
function isLoadableSave(saved) {
  return saved?.version === 1 && typeof saved.file === 'string' && saved.file.length > 0
    && (!saved.saveId || saved.saveId === (gameScreenConfig?.saveId || ''))
    && typeof saved.scene === 'string' && saved.scene.length > 0
    && Number.isSafeInteger(saved.line) && saved.line >= 1
    && saved.variables !== null && typeof saved.variables === 'object' && !Array.isArray(saved.variables);
}
function readSaveSlot(index) {
  return saveSlotCache.get(index) || null;
}
function saveSlotState(index) {
  return readSaveSlot(index) ? 'ready' : saveSlotStates.get(index) || 'empty';
}
function latestSaveSlotIndex() {
  const count = gameScreenConfig?.screens?.[screenForRole('load-slots')]?.slotLayout?.count || 8;
  let latest = -1, latestTime = -1;
  for (let index = 0; index < count; index++) {
    const saved = readSaveSlot(index);
    if (!saved) continue;
    const timestamp = Number.isFinite(saved.savedAt) ? saved.savedAt : 0;
    if (timestamp > latestTime) { latest = index; latestTime = timestamp; }
  }
  return latest;
}
function screenForRole(role) {
  return Object.entries(gameScreenConfig?.screens || {}).find(([, screen]) => screen.role === role)?.[0] || '';
}
function openSlotScreen(action) {
  const id = screenForRole(action === 'save' ? 'save-slots' : 'load-slots');
  if (id) showGameScreen(id);
  else showGameScreen('pause');
}
function formatSavedAt(timestamp) {
  try { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(timestamp)); }
  catch { return ''; }
}
function saveSlotField(index, field) {
  const saved = readSaveSlot(index);
  switch (field) {
    case 'thumbnail': return saveThumbnailUrls.get(index) || '';
    case 'number': return String(index + 1).padStart(2, '0');
    case 'status': return ({ ready: '記録あり', empty: '空き', corrupt: '破損', incompatible: '非対応' })[saveSlotState(index)];
    case 'scene': return saved?.scene || '';
    case 'speaker': return saved?.speaker || '';
    case 'text': return saved?.text || '';
    case 'saved-at': return saved?.savedAt ? formatSavedAt(saved.savedAt) : '';
    default: return '';
  }
}
async function captureSaveThumbnail() {
  const canvas = document.createElement('canvas');
  canvas.width = 320; canvas.height = 180;
  const context = canvas.getContext('2d');
  context.fillStyle = '#101a22'; context.fillRect(0, 0, canvas.width, canvas.height);
  const stage = $('stage').getBoundingClientRect();
  const sx = canvas.width / stage.width, sy = canvas.height / stage.height;
  const background = $('background');
  const source = /url\(["']?([^"')]+)["']?\)/.exec(background.style.backgroundImage)?.[1];
  const draw = async (url, rect, fit = 'contain') => {
    if (!url) return;
    const image = new Image(); image.src = url;
    try { await image.decode(); } catch { return; }
    const x = (rect.left - stage.left) * sx, y = (rect.top - stage.top) * sy;
    const width = rect.width * sx, height = rect.height * sy;
    if (fit === 'cover') {
      const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight);
      const cropW = width / scale, cropH = height / scale;
      context.drawImage(image, (image.naturalWidth - cropW) / 2, (image.naturalHeight - cropH) / 2, cropW, cropH, x, y, width, height);
    } else context.drawImage(image, x, y, width, height);
  };
  if (source) await draw(source, stage, 'cover');
  for (const element of document.querySelectorAll('#characters img, #images img')) await draw(element.src, element.getBoundingClientRect());
  return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
}
function showSlotList(overlay, screen, scaleX, scaleY) {
  const layout = screen.slotLayout || { x: 420, y: 190, width: 440, height: 420, rowHeight: 42, gap: 8, count: 8 };
  const list = document.createElement('div'); list.className = 'game-save-slots';
  Object.assign(list.style, { left: `${layout.x * scaleX}px`, top: `${layout.y * scaleY}px`, width: `${layout.width * scaleX}px`, height: `${layout.height * scaleY}px`, gap: `${layout.gap * scaleY}px` });
  for (let index = 0; index < layout.count; index++) {
    const saved = readSaveSlot(index);
    const button = document.createElement('button'); button.type = 'button'; button.className = 'game-save-slot';
    const style = screen.slotStyle || {};
    Object.assign(button.style, {
      height: `${layout.rowHeight * scaleY}px`, fontSize: `${(style.fontSize || 15) * scaleY}px`,
      color: style.color || '', backgroundColor: style.backgroundColor || '', borderColor: style.borderColor || '',
    });
    const label = saved
      ? `Slot ${String(index + 1).padStart(2, '0')}  ·  ${saved.speaker || '語り手'}: ${saved.text || '(本文なし)'}  ·  ${formatSavedAt(saved.savedAt)}`
      : `Slot ${String(index + 1).padStart(2, '0')}  ·  空き`;
    button.textContent = label; button.disabled = screen.role === 'load-slots' ? !saved : !currentExecution?.line;
    if (style.image) button.style.backgroundImage = `url("${screenAsset(style.image)}")`;
    const active = () => {
      const image = style.hoverImage || style.image;
      button.style.backgroundImage = image ? `url("${screenAsset(image)}")` : '';
      button.style.color = style.hoverColor || style.color || '';
      button.style.backgroundColor = style.hoverBackgroundColor || style.backgroundColor || '';
      button.style.borderColor = style.hoverBorderColor || style.borderColor || '';
    };
    const inactive = () => {
      button.style.backgroundImage = style.image ? `url("${screenAsset(style.image)}")` : '';
      button.style.color = style.color || '';
      button.style.backgroundColor = style.backgroundColor || '';
      button.style.borderColor = style.borderColor || '';
    };
    button.addEventListener('pointerenter', active); button.addEventListener('focus', active);
    button.addEventListener('pointerleave', inactive); button.addEventListener('blur', inactive);
    button.addEventListener('click', () => {
      if (screen.role === 'save-slots') saveGameToSlot(index, overlay);
      else loadGameSlot(index);
    });
    list.append(button);
  }
  overlay.append(list);
}
async function saveGameToSlot(index, overlay = $('screen-overlay')) {
  const execution = currentExecution;
  if (!execution?.file || !execution.scene || !execution.line) return;
  try {
    const snapshot = {
      version: 1, saveId: gameScreenConfig?.saveId || '', file: execution.file, scene: execution.scene, line: execution.line,
      variables: runtime.globals, locals: runtime.frames.slice(1),
      readonlyLocals: runtime.frames.slice(1).map(frame => [...(runtime.readonlyFrames.get(frame) || [])]),
      sceneState: runtime.sceneState,
      text: $('text').textContent, speaker: $('speaker-text').textContent,
      savedAt: Date.now(),
    };
    const encoded = encodeSave(snapshot);
    if (encoded.length > 3_500_000) throw Error('セーブデータが大きすぎます。変数または演出状態を減らしてください。');
    const thumbnail = await captureSaveThumbnail();
    await saveStore.writeSlot(index, encoded, { scene: snapshot.scene, speaker: snapshot.speaker, text: snapshot.text, savedAt: snapshot.savedAt }, thumbnail);
    saveSlotCache.set(index, snapshot);
    saveSlotStates.set(index, 'ready');
    const previousThumbnail = saveThumbnailUrls.get(index);
    if (previousThumbnail) URL.revokeObjectURL(previousThumbnail);
    if (thumbnail) saveThumbnailUrls.set(index, URL.createObjectURL(thumbnail));
    else saveThumbnailUrls.delete(index);
    showGameScreen(activeGameScreen, { push: false });
    const notice = document.createElement('div'); notice.className = 'game-screen-notice'; notice.textContent = `Slot ${String(index + 1).padStart(2, '0')} に保存しました`;
    $('screen-overlay').append(notice);
    setTimeout(() => notice.remove(), 2500);
  } catch (error) {
    const notice = document.createElement('div'); notice.className = 'game-screen-error'; notice.textContent = `保存できませんでした: ${error.message}`; overlay.append(notice);
  }
}
function loadGameSlot(index) {
  const saved = readSaveSlot(index);
  if (!saved) return;
  try {
    sessionStorage.setItem(`${saveStoragePrefix}:resume-slot`, String(index));
    location.reload();
  } catch (error) {
    const notice = document.createElement('div'); notice.className = 'game-screen-error'; notice.textContent = `ロードできませんでした: ${error.message}`; $('screen-overlay').append(notice);
  }
}
async function activateGameScreenAction(action, target, node) {
  const overlay = $('screen-overlay');
  const slotIndex = node?.attrs?.['data-slot-index'];
  if (slotIndex !== undefined) {
    if (action === 'save') saveGameToSlot(Number(slotIndex), overlay);
    else loadGameSlot(Number(slotIndex));
  } else if (action === 'start') {
    primeBgmAudioContext(); resumeScreenMusic(); overlay.hidden = true; activeGameScreen = null; screenHistory.length = 0;
    try { await gameStartHandler?.(); } catch (error) { $('speaker-text').textContent = 'PLAYER ERROR'; $('text').textContent = error.message; }
  } else if (action === 'continue') {
    const index = latestSaveSlotIndex();
    if (index >= 0) loadGameSlot(index);
  } else if (action === 'resume') {
    overlay.hidden = true; activeGameScreen = null; screenHistory.length = 0;
  } else if (action === 'save' || action === 'load') openSlotScreen(action);
  else if (action === 'open-screen') showGameScreen(target);
  else if (action === 'back') {
    const previous = screenHistory.pop();
    if (previous) showGameScreen(previous, { push: false });
    else if (gameStarted) { overlay.hidden = true; activeGameScreen = null; }
  } else if (action === 'quit') {
    if (window.opener) window.close();
    else location.assign('/');
  }
}
function showGameScreen(id, { push = true } = {}) {
  const screen = gameScreenConfig?.screens?.[id];
  if (!screen) throw Error(`画面 '${id}' が定義されていません。`);
  if (push && activeGameScreen && activeGameScreen !== id) screenHistory.push(activeGameScreen);
  activeGameScreen = id;
  const overlay = $('screen-overlay');
  const scaleX = playerTheme.screen.width / gameScreenConfig.canvas.width;
  const scaleY = playerTheme.screen.height / gameScreenConfig.canvas.height;
  overlay.replaceChildren(); overlay.hidden = false;
  overlay.style.backgroundImage = screen.background ? `url("${screenAsset(screen.background)}")` : 'linear-gradient(110deg,#101820e8,#10182066)';
  if (screen.title) {
    const title = document.createElement('div'); title.className = 'game-screen-title'; title.textContent = screen.title;
    title.style.fontSize = `${36 * scaleY}px`; overlay.append(title);
  }
  if (screen.description) {
    const description = document.createElement('div'); description.className = 'game-screen-description'; description.textContent = screen.description;
    Object.assign(description.style, { left: `${64 * scaleX}px`, top: `${112 * scaleY}px`, width: `${Math.min(560, gameScreenConfig.canvas.width - 128) * scaleX}px`, fontSize: `${21 * scaleY}px` }); overlay.append(description);
  }
  if (screen.music) playScreenMusic(screen.music);
  if (screen.webDocument) {
    overlay.append(NovelScreenDocument.buildWebScreen(screen.webDocument.markup, screen.webDocument.stylesheet, document, {
      width: gameScreenConfig.canvas.width, height: gameScreenConfig.canvas.height, scaleX, scaleY,
      assetUrl: screenAsset, saved: readSaveSlot, slotField: saveSlotField,
      slotState: saveSlotState,
      canSave: Boolean(currentExecution?.line), canContinue: latestSaveSlotIndex() >= 0,
      settings: userUiSettings, controlDefaults: gameScreenConfig.controlDefaults,
      onSettingChange: updateUiSetting,
      onAction: (action, target, slotIndex) => { void activateGameScreenAction(action, target, slotIndex == null ? null : { attrs: { 'data-slot-index': String(slotIndex) } }); },
    }));
    overlay.querySelector('button:not(:disabled)')?.focus();
    return;
  }
  if (Array.isArray(screen.uiTree)) {
    overlay.append(NovelScreenDocument.buildScreenDom(screen.uiTree, document, {
      scaleX, scaleY, assetUrl: screenAsset,
      settings: userUiSettings, controlDefaults: gameScreenConfig.controlDefaults,
      disableContinue: latestSaveSlotIndex() < 0,
      onSettingChange: updateUiSetting,
      onAction: (action, target, _event, node) => { void activateGameScreenAction(action, target, node); },
      slotField: saveSlotField,
      roleSlot: (button, index, node) => {
        const saved = readSaveSlot(index);
        if (!node.children.length) {
          button.classList.add('game-save-slot');
          button.textContent = saved
            ? `Slot ${String(index + 1).padStart(2, '0')} | ${saved.speaker || 'Narrator'}: ${saved.text || 'No text'}`
            : `Slot ${String(index + 1).padStart(2, '0')} | Empty`;
        }
        button.setAttribute('aria-label', `${String(index + 1).padStart(2, '0')} ${saved ? `${saved.scene || ''} ${saved.text || ''}` : '空き'}`);
        button.disabled = node.attrs['data-action'] === 'load' ? !saved : !currentExecution?.line;
      },
    }));
    overlay.querySelector('button:not(:disabled)')?.focus();
    return;
  }
  for (const item of screen.items || []) {
    if (item.type !== 'button') continue;
    const button = document.createElement('button'); button.type = 'button'; button.className = 'game-screen-button'; button.setAttribute('aria-label', item.label);
    if (item.action === 'continue' && latestSaveSlotIndex() < 0) button.disabled = true;
    const label = document.createElement('span'); label.textContent = item.label; button.append(label);
    if (item.display === 'image') label.hidden = true;
    Object.assign(button.style, { left: `${item.x * scaleX}px`, top: `${item.y * scaleY}px`, width: `${item.width * scaleX}px`, height: `${item.height * scaleY}px`, fontSize: `${(item.fontSize || 22) * scaleY}px` });
    if (item.color) button.style.color = item.color;
    if (item.backgroundColor) button.style.backgroundColor = item.backgroundColor;
    if (item.borderColor) button.style.borderColor = item.borderColor;
    if (item.image) button.style.backgroundImage = `url("${screenAsset(item.image)}")`;
    const setButtonState = active => {
      const image = active ? item.hoverImage || item.image : item.image;
      button.style.backgroundImage = image ? `url("${screenAsset(image)}")` : '';
      label.textContent = active ? item.hoverLabel || item.label : item.label;
      label.hidden = item.display === 'image';
      button.style.color = active ? item.hoverColor || item.color || '' : item.color || '';
      button.style.backgroundColor = active ? item.hoverBackgroundColor || item.backgroundColor || '' : item.backgroundColor || '';
      button.style.borderColor = active ? item.hoverBorderColor || item.borderColor || '' : item.borderColor || '';
    };
    button.addEventListener('pointerenter', () => setButtonState(true)); button.addEventListener('pointerleave', () => setButtonState(false));
    button.addEventListener('focus', () => setButtonState(true)); button.addEventListener('blur', () => setButtonState(false));
    button.addEventListener('click', () => { void activateGameScreenAction(item.action, item.target); });
    overlay.append(button);
  }
  if (screen.role === 'save-slots' || screen.role === 'load-slots') showSlotList(overlay, screen, scaleX, scaleY);
  overlay.querySelector('button')?.focus();
}
const screenHistory = [];
function url(type, name, pose) {
  let a = runtime.program?.assets?.find((x) => x.name === name && x.type === type);
  if (type === 'char') {
    const c = runtime.program?.characters?.find((x) => x.name === name);
    a = c?.poses?.find((x) => x.name === pose) || a;
  }
  return a ? `/asset/${a.path.replace(/^asset[\\/]/, '').replaceAll('\\', '/')}` : name;
}
function slotClass(slot) {
  return slot === 'far_left' ? 'far-left' : slot === 'far_right' ? 'far-right' : slot;
}
function sizeSpriteLikeNative(sprite) {
  if (!sprite.naturalWidth || !sprite.naturalHeight) return;
  const { width, height } = playerTheme.screen;
  const scale = Math.min(width / sprite.naturalWidth, height / sprite.naturalHeight);
  sprite.style.width = `${sprite.naturalWidth * scale}px`;
  sprite.style.height = `${sprite.naturalHeight * scale}px`;
}

function animateBgmGain(audio, target, durationMs, removeWhenDone = false, onComplete = undefined, onProgress = undefined) {
  const animationId = ++nextBgmAnimationId;
  bgmAnimationIds.set(audio, animationId);
  const route = bgmGainNodes.get(audio);
  if (route) {
    const { context, gain } = route;
    const parameter = gain.gain;
    const now = context.currentTime;
    const durationSeconds = Math.max(0, durationMs) / 1000;
    const endTime = now + durationSeconds;
    const previousAutomation = bgmAutomations.get(audio);
    const currentValue = previousAutomation
      ? previousAutomation.startValue + (previousAutomation.target - previousAutomation.startValue)
        * Math.max(0, Math.min(1, (now - previousAutomation.startTime) / (previousAutomation.endTime - previousAutomation.startTime || 1)))
      : route.value;
    if (previousAutomation) clearTimeout(previousAutomation.timer);
    parameter.cancelScheduledValues(now);
    parameter.setValueAtTime(currentValue, now);
    if (durationSeconds) parameter.linearRampToValueAtTime(target, endTime);
    else parameter.setValueAtTime(target, now);
    const finish = () => {
      const automation = bgmAutomations.get(audio);
      if (!automation || automation.animationId !== animationId || bgmAnimationIds.get(audio) !== animationId) return;
      if (durationSeconds && context.state !== 'running') {
        automation.timer = setTimeout(finish, 100);
        return;
      }
      if (context.state === 'running' && context.currentTime + 0.002 < endTime) {
        automation.timer = setTimeout(finish, Math.max(8, (endTime - context.currentTime) * 1000));
        return;
      }
      bgmAutomations.delete(audio);
      if (automation.progressTimer) clearTimeout(automation.progressTimer);
      parameter.setValueAtTime(target, context.currentTime);
      route.value = target;
      onProgress?.(1);
      if (removeWhenDone) {
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
        audio.remove();
        bgmLayers.delete(audio);
        disconnectBgmAudio(audio);
      }
      onComplete?.();
    };
    const automation = { animationId, startTime: now, startValue: currentValue, target, endTime, timer: null, progressTimer: null, finish };
    bgmAutomations.set(audio, automation);
    route.value = target;
    if (!durationSeconds) finish();
    else {
      const reportProgress = () => {
        if (bgmAnimationIds.get(audio) !== animationId) return;
        const progress = context.state === 'running' ? Math.max(0, Math.min(1, (context.currentTime - now) / durationSeconds)) : 0;
        onProgress?.(progress);
        if (progress < 1) automation.progressTimer = setTimeout(reportProgress, context.state === 'running' ? 16 : 100);
      };
      reportProgress();
      automation.timer = setTimeout(finish, durationMs + 4);
    }
    return;
  }
  const start = performance.now();
  const initial = audio.volume;
  const finish = () => {
    if (bgmAnimationIds.get(audio) !== animationId) return;
    audio.volume = target;
    onProgress?.(1);
    if (removeWhenDone) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      audio.remove();
      bgmLayers.delete(audio);
    }
    onComplete?.();
  };
  if (durationMs <= 0) { finish(); return; }
  const tick = now => {
    if (bgmAnimationIds.get(audio) !== animationId) return;
    const progress = Math.max(0, Math.min(1, (now - start) / durationMs));
    audio.volume = initial + (target - initial) * progress;
    onProgress?.(progress);
    if (progress >= 1) finish();
    else requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
function reconcileBgmAutomations() {
  if (document.hidden) return;
  primeBgmAudioContext();
  for (const automation of bgmAutomations.values()) automation.finish();
}
document.addEventListener('visibilitychange', reconcileBgmAutomations);
window.addEventListener('pageshow', reconcileBgmAutomations);
function stopBgm() {
  const audioPlayers = new Set([...bgmLayers, $('bgm')].filter(Boolean));
  for (const audio of audioPlayers) {
    bgmAnimationIds.set(audio, ++nextBgmAnimationId);
    const automation = bgmAutomations.get(audio);
    if (automation) {
      clearTimeout(automation.timer);
      if (automation.progressTimer) clearTimeout(automation.progressTimer);
    }
    bgmAutomations.delete(audio);
    disconnectBgmAudio(audio);
    activeUiAudio.delete(audio);
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    if (audio !== $('bgm')) audio.remove();
  }
  bgmLayers.clear();
}
async function playBgm(name, transition, operation, runtime) {
  const duration = transition?.type === 'crossfade' ? Number(transition.durationMs) || 0 : 0;
  const targetGain = Math.max(0, Math.min(1, Number(operation?.gain ?? 1)));
  const audioFailed = audio => {
    if (!audio.hasAttribute('src')) return;
    const failedCurrentBgm = runtime?.sceneState.audio.bgm?.actionId === operation?.actionId;
    bgmAnimationIds.set(audio, ++nextBgmAnimationId);
    const automation = bgmAutomations.get(audio);
    if (automation) {
      clearTimeout(automation.timer);
      if (automation.progressTimer) clearTimeout(automation.progressTimer);
    }
    bgmAutomations.delete(audio);
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    if (audio !== $('bgm')) audio.remove();
    bgmLayers.delete(audio);
    disconnectBgmAudio(audio);
    activeUiAudio.delete(audio);
    // A failed incoming song invalidates its whole crossfade: outgoing layers
    // were already fading toward silence and must not keep playing invisibly
    // after SceneState drops the failed current BGM.
    if (failedCurrentBgm && audio.dataset.bgmCrossfadeStarted === 'true') stopBgm();
    runtime?.stopAction(operation?.actionId, 'failed');
  };
  if (!duration) {
    const previous = $('bgm');
    const audio = document.createElement('audio');
    audio.loop = true;
    audio.dataset.audioKind = 'bgm'; audio.dataset.userGain = String(targetGain); activeUiAudio.add(audio);
    audio.volume = targetGain;
    audio.src = url('bgm', name);
    audio.onerror = () => audioFailed(audio);
    try {
      await connectBgmAudio(audio, targetGain);
      await audio.play();
    } catch (error) {
      disconnectBgmAudio(audio);
      activeUiAudio.delete(audio);
      audio.removeAttribute('src');
      audio.load();
      throw error;
    }
    stopBgm();
    audio.id = 'bgm';
    previous?.replaceWith(audio);
    if (!audio.isConnected) document.body.append(audio);
    bgmLayers.add(audio);
    applyUiAudioMix();
    return;
  }
  const audio = document.createElement('audio');
  audio.loop = true;
  audio.dataset.audioKind = 'bgm'; audio.dataset.userGain = String(targetGain); activeUiAudio.add(audio);
  audio.volume = 0;
  audio.src = url('bgm', name);
  audio.dataset.playerBgm = 'true';
  audio.onerror = () => audioFailed(audio);
  document.body.append(audio);
  bgmLayers.add(audio);
  applyUiAudioMix();
  try {
    await connectBgmAudio(audio, 0);
    await audio.play();
  } catch (error) {
    bgmLayers.delete(audio);
    disconnectBgmAudio(audio);
    activeUiAudio.delete(audio);
    audio.remove();
    throw error;
  }
  for (const previous of [...bgmLayers]) {
    if (previous !== audio && !previous.paused) animateBgmGain(previous, 0, duration, true);
  }
  audio.dataset.bgmCrossfadeStarted = 'true';
  animateBgmGain(audio, targetGain, duration, false, () => runtime?.completeTransition(operation?.transitionId),
    progress => runtime?.reportTransitionProgress(operation?.transitionId, progress));
}

async function media(type, name, mode, operation, runtime) {
  const src = url(type, name);
  if (type === 'bgm') {
    await playBgm(name, operation?.transition, operation, runtime);
  } else {
    const a = new Audio(src);
    const kind = type === 'voice' ? 'voice' : 'se';
    const gain = Math.max(0, Math.min(1, Number(operation?.gain ?? 1)));
    a.dataset.audioKind = kind; a.dataset.userGain = String(gain); activeUiAudio.add(a);
    a.volume = gain * Number(userUiSettings['audio.master'] ?? 1) * settingGain(kind);
    let resolveEnded, rejectEnded, settled = false;
    const ended = new Promise((resolve, reject) => { resolveEnded = resolve; rejectEnded = reject; });
    ended.catch(() => {});
    const fail = error => {
      if (settled) return;
      settled = true;
      a.pause();
      a.removeAttribute('src');
      a.load();
      a.remove();
      disconnectUiAudio(a);
      runtime?.stopAction(operation?.actionId, 'failed');
      rejectEnded(error);
    };
    a.onended = () => {
      if (settled) return;
      settled = true;
      a.remove();
      disconnectUiAudio(a);
      runtime?.completeAction(operation?.actionId);
      resolveEnded();
    };
    a.onerror = () => fail(Error('Audio playback failed'));
    try { await connectUiAudio(a, kind, gain); await a.play(); }
    catch (error) { fail(error); throw error; }
    if (mode === 'blocking') await ended;
  }
}

async function playVideo(name, mode, operation, runtime) {
  const src = url('video', name);
  const previous = $('active-video');
  const video = document.createElement('video');
  // Keep the current video until its replacement has actually started. This
  // matches Native, where make_unique constructs the new decoder before the
  // assignment destroys the previous Video.
  if (operation?.actionId) video.dataset.actionId = operation.actionId;
  video.src = src;
  video.autoplay = true;
  video.style.position = 'absolute';
  video.style.inset = '0';
  video.style.width = '100%';
  video.style.height = '100%';
  video.style.objectFit = 'contain';
  video.style.zIndex = '40';
  $('stage').append(video);
  let resolveEnded, rejectEnded;
  const ended = new Promise((resolve, reject) => { resolveEnded = resolve; rejectEnded = reject; });
  ended.catch(() => {});
  const stopCandidate = (reason) => {
    video.pause();
    video.remove();
    runtime?.stopAction(operation?.actionId, reason);
  };
  video.onended = () => { video.remove(); runtime?.completeAction(operation?.actionId); resolveEnded(); };
  video.onerror = () => {
    stopCandidate('failed');
    rejectEnded(Error('動画の読み込みに失敗しました'));
  };
  try {
    await video.play();
  } catch (error) {
    stopCandidate('failed');
    throw error;
  }
  if (previous?.isConnected) {
    previous.pause();
    previous.remove();
  }
  video.id = 'active-video';
  if (mode === 'blocking') await ended;
}

function reportAnimationProgress(animation, runtime, actionId, durationMs) {
  const sample = () => {
    if (animation.playState === 'idle') return;
    const progress = durationMs ? Number(animation.currentTime || 0) / durationMs : 1;
    runtime?.reportTransitionProgress(actionId, progress);
    if (progress < 1 && animation.playState !== 'finished') requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
}
async function fade(element, from, to, duration = 500n, runtime, actionId) {
  const ms = Number(duration);
  if (ms < 0 || !Number.isSafeInteger(ms)) throw Error('演出時間が不正です');
  if (!ms) { element.style.opacity = String(to); runtime?.reportTransitionProgress(actionId, 1); return; }
  const animation = element.animate([{ opacity: from }, { opacity: to }], { duration: ms, easing: 'linear', fill: 'forwards' });
  reportAnimationProgress(animation, runtime, actionId, ms);
  await animation.finished;
  element.style.opacity = String(to);
  animation.cancel();
}
async function applyEffect(type, color, ms = 500n, runtime, actionId) {
  const overlay = document.createElement('div');
  Object.assign(overlay.style, { position: 'absolute', inset: '0', backgroundColor: color, zIndex: '50', pointerEvents: 'none' });
  $('stage').append(overlay);
  try { await fade(overlay, 1, 0, ms, runtime, actionId); } finally { overlay.remove(); }
}
async function moveLayer(operation, runtime) {
  const move = operation?.move;
  if (!move) throw Error('move operation metadata is missing');
  const element = move.targetKind === 'bg' ? $('background') : $(`char-${move.target}`);
  if (!element) throw Error(`move target '${move.target}' is not currently visible`);
  const point = (x, y) => move.targetKind === 'bg'
    ? `translate(${x}px, ${y}px)`
    : `translateX(calc(-50% + ${x}px))`;
  const styleAt = (x, y) => move.targetKind === 'bg'
    ? { transform: point(x, y) }
    : { transform: point(x, y), bottom: `${-y}px` };
  const from = styleAt(move.fromX, move.fromY);
  const to = styleAt(move.toX, move.toY);
  if (!move.durationMs) {
    Object.assign(element.style, to);
    return;
  }
  const animation = element.animate([from, to], { duration: move.durationMs, easing: 'linear', fill: 'forwards' });
  reportAnimationProgress(animation, runtime, operation.actionId, move.durationMs);
  await animation.finished;
  Object.assign(element.style, to);
  animation.cancel();
}

async function command(c) {
  const a = c.args;
  const n = c.name;
  const poseReference = n === 'show' && /^([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(a[0]);
  const showChar = n === 'show' && Boolean(poseReference);

  if (n === 'move') {
    await moveLayer(c.operation, c.runtime);
  } else if (n === 'bg') {
    const src = url('bg', a[0]);
    const preload = new Image(); preload.src = src; await preload.decode();
    $('background').style.transform = '';
    $('background').style.backgroundImage = `url("${src}")`;
  } else if (showChar) {
    const charName = poseReference[1];
    const pos = slotClass(a[1]);
    const pose = poseReference[2];
    const transitionIndex = c.operation?.transitionIndex ?? 2;
    let offsetX = 0, offsetY = 0;
    for (let index = 2; index < transitionIndex; index++) {
      const match = /^([xy])([+-])(\d+)?$/.exec(a[index]);
      if (!match) continue;
      const raw = match[3] === undefined ? a[++index] : match[3];
      const amount = Number(raw) * (match[2] === '+' ? 1 : -1);
      if (match[1] === 'x') offsetX = amount; else offsetY = amount;
    }
    const existing = $(`char-${charName}`);
    const e = document.createElement('img');
    e.id = `char-${charName}`;
    e.className = `actor ${pos}`;
    e.dataset.slot = pos;
    e.style.transform = `translateX(calc(-50% + ${offsetX}px))`;
    e.style.bottom = `${-offsetY}px`;
    e.src = url('char', charName, pose);
    await e.decode();
    sizeSpriteLikeNative(e);
    if (existing) existing.replaceWith(e);
    else $('characters').append(e);
    document.querySelectorAll(`#characters .actor[data-slot="${CSS.escape(pos)}"]`).forEach(actor => {
      if (actor !== e) actor.remove();
    });
    if (a[transitionIndex] === 'fade') await fade(e, 0, 1, a[transitionIndex + 1], c.runtime, c.operation?.actionId);
  } else if (n === 'hide') {
    const charName = a[0];
    const fadeOffset = 1;
    const e = $(`char-${charName}`);
    if (e && a[fadeOffset] === 'fade') await fade(e, 1, 0, a[fadeOffset + 1], c.runtime, c.operation?.actionId);
    e?.remove();
  } else if (n === 'clear') {
    const target = a[0];
    if (target === 'bg') { $('background').style.backgroundImage = 'none'; $('background').style.transform = ''; }
    else if (target === 'bgm') {
      stopBgm();
    } else if (target === 'image') $(`image-${a[1]}`)?.remove();
  } else if (n === 'bgm') {
    await media('bgm', a[0], undefined, c.operation, c.runtime);
  } else if (n === 'play') {
    if (a[0] === 'video') await playVideo(a[1], c.operation?.mode, c.operation, c.runtime);
    else await media(a[0], a[1], c.operation?.mode, c.operation, c.runtime);
  } else if (n === 'dialog') {
    $('dialogue').style.setProperty('--dialog-opacity', String(c.operation?.dialogOpacity ?? a[1]));
  } else if (n === 'effect') {
    await applyEffect(a[0], a[1], a[2], c.runtime, c.operation?.actionId);
  } else if (n === 'show' && a[0] === 'image') {
    const imgName = a[1];
    const pos = slotClass(a[2]);
    const existing = $(`image-${imgName}`);
    const e = document.createElement('img');
    e.id = `image-${imgName}`;
    e.className = `image ${pos}`;
    e.dataset.slot = pos;
    e.src = url('image', imgName);
    await e.decode();
    sizeSpriteLikeNative(e);
    existing?.remove();
    $('images').append(e);
  }
}
// The whole dialogue panel is the advance target. Choices keep their own click behavior.
$('dialogue').addEventListener('click', (event) => {
  if (event.target.closest('#choices, .choice, #next')) return;
  $('next').click();
});
window.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !gameStarted || !gameScreenConfig?.screens?.pause || activeGameScreen) return;
  event.preventDefault(); showGameScreen('pause', { push: false });
});

async function loadScene(name) {
  const response = await fetch(`/api/scene?name=${encodeURIComponent(name)}`);
  const scene = await response.json();
  if (!response.ok) throw Error(scene.error);
  const compiled = await fetch('/api/compile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: scene.name || name, source: scene.source, debug: Boolean(debugSession) }),
  });
  const result = await compiled.json();
  if (!result.ok) throw Error(result.error);
  result.program.sourceFile = scene.name || name;
  return result.program;
}
const debugParams = new URLSearchParams(location.search);
const debugSession = debugParams.get('debug');
let debugStep = 0;
const debugAcks = new Map();
window.addEventListener('message', (event) => {
  if (event.origin !== location.origin || event.source !== window.parent || event.data?.type !== 'novel-debug:ack' || event.data.session !== debugSession) return;
  debugAcks.get(event.data.step)?.();
});
function reportDebug(type, detail = {}) {
  if (debugSession && window.parent !== window) window.parent.postMessage({ type, session: debugSession, ...detail }, location.origin);
}
function reportDebugLocation(instruction, rt) {
  if (!debugSession || window.parent === window || !instruction.line) return undefined;
  const step = ++debugStep;
  reportDebug('novel-debug:location', { file: instruction.file || rt.program?.sourceFile, line: instruction.line, op: instruction.op, step });
  return new Promise((resolve) => {
    // A location acknowledgement is a synchronization barrier: the editor must
    // finish opening/highlighting the source before execution advances. A
    // timeout here makes slow cross-file navigation silently run ahead.
    debugAcks.set(step, () => { debugAcks.delete(step); resolve(); });
  });
}
const runtime = new NovelRuntime.Runtime({
  load: loadScene,
  beforeInstruction(instruction, rt) {
    currentExecution = {
      file: instruction.file || rt.program?.sourceFile || '',
      scene: rt.currentSceneName || '',
      line: Number(instruction.line) || 0,
    };
    return reportDebugLocation(instruction, rt);
  },
  async command(name, args, rt, operation) {
    if (name === 'say') {
      let speaker = args[0] === 'none' || args[0] === 'narrator' ? '' : args[0];
      if (speaker) {
        try { speaker = rt.get(speaker)?.name || speaker; } catch {}
      }
      $('speaker-text').textContent = speaker;
      $('text').textContent = await rt.textAsync(args[1]);
      $('text').scrollTop = 0;
      const restoreOpacity = rt.sceneState.ui?.dialogOpacity ?? playerTheme?.dialog?.opacity ?? 1;
      if (operation?.dialogOpacityTemporary) applyDialogOpacity(operation.dialogOpacity);
      try { await new Promise(resolve => { $('next').onclick = () => { $('next').onclick = null; resolve(); }; }); }
      finally { if (operation?.dialogOpacityTemporary) applyDialogOpacity(restoreOpacity); }
    } else if (name === 'wait') {
      if (args[0] < 0n || args[0] > 2147483647n) throw Error('待機時間が不正です');
      await new Promise(resolve => setTimeout(resolve, Number(args[0])));
    } else await command({ name, args, operation, runtime: rt });
  },
  sceneState(state, event) {
    document.body.dataset.sceneRevision = String(state.revision);
    if (event?.name === 'restore') return restorePlayerState(state, runtime);
  },
  choice(prompt, labels) {
    $('text').textContent = prompt;
    $('choices').replaceChildren();
    return new Promise(resolve => labels.forEach((label, index) => {
      const button = makeChoice(label, index);
      button.onclick = () => { $('choices').replaceChildren(); resolve(index); };
      $('choices').append(button);
    }));
  }
});
let launchName = '';
let launchVariables = Object.create(null);
let launchDebug = null;
async function restorePlayerState(state, rt) {
  const bg = state.background;
  applyDialogOpacity(state.ui?.dialogOpacity ?? playerTheme?.dialog?.opacity ?? 1);
  $('background').style.backgroundImage = bg?.asset ? `url("${url('bg', bg.asset)}")` : 'none';
  $('background').style.transform = `translate(${Number(bg?.offsetX) || 0}px, ${Number(bg?.offsetY) || 0}px)`;
  $('characters').replaceChildren(); $('images').replaceChildren();
  for (const character of Object.values(state.characters || {})) {
    if (!character.visible) continue;
    const sprite = document.createElement('img');
    sprite.id = `char-${character.id}`; sprite.className = `actor ${slotClass(character.slot)}`; sprite.dataset.slot = slotClass(character.slot);
    sprite.style.transform = `translateX(calc(-50% + ${Number(character.offsetX) || 0}px))`;
    sprite.style.bottom = `${-(Number(character.offsetY) || 0)}px`; sprite.style.opacity = String(Number(character.opacity ?? 1));
    sprite.style.zIndex = String(Number(character.zIndex) || 0); sprite.src = url('char', character.id, character.pose);
    $('characters').append(sprite);
    try { await sprite.decode(); sizeSpriteLikeNative(sprite); } catch {}
  }
  for (const [name, image] of Object.entries(state.images || {})) {
    const sprite = document.createElement('img'); sprite.id = `image-${name}`; sprite.className = `image ${slotClass(image.slot)}`; sprite.dataset.slot = slotClass(image.slot);
    sprite.src = url('image', image.asset || name); $('images').append(sprite);
    try { await sprite.decode(); sizeSpriteLikeNative(sprite); } catch {}
  }
  const bgm = state.audio?.bgm;
  stopBgm();
  if (bgm?.asset) {
    const audio = $('bgm'); audio.loop = true; audio.dataset.audioKind = 'bgm'; audio.dataset.userGain = String(Number(bgm.gain ?? 1)); activeUiAudio.add(audio); audio.src = url('bgm', bgm.asset); audio.volume = Number(bgm.gain ?? 1);
    try { await connectBgmAudio(audio, audio.volume); await audio.play(); bgmLayers.add(audio); applyUiAudioMix(); }
    catch { /* Audio may remain blocked until the next input after a reload. */ }
  }
  document.body.dataset.sceneRevision = String(state.revision || 0);
}
async function launchGame() {
  if (gameStarted) return;
  gameStarted = true;
  await runtime.run(await loadScene(launchName), launchDebug);
  gameStarted = false;
  reportDebug('novel-debug:done');
}
(async () => {
  const ui = await (await fetch('/api/player-ui')).json();
  applyPlayerUi(ui.path, ui.theme);
  runtime.configurePresentationDefaults(ui.theme);
  const settings = await (await fetch('/api/scene-config')).json();
  launchName = debugParams.get('source') || settings.start_file;
  const projectInfo = await (await fetch('/api/project')).json();
  saveStoragePrefix = `novel-script:${encodeURIComponent(projectInfo.projectRoot || location.origin)}:${debugSession ? 'test' : 'game'}`;
  const variables = launchVariables;
  if (debugSession) {
    const supplied = JSON.parse(debugParams.get('variables') || '{}');
    for (const [key, entry] of Object.entries(supplied)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw Error(`Invalid debug variable: ${key}`);
      if (entry?.type === 'int' && typeof entry.value === 'string') variables[key] = NovelRuntime.integer(entry.value);
      else if (entry?.type === 'float' && typeof entry.value === 'string') variables[key] = NovelRuntime.floating(entry.value);
      else if (entry?.type === 'str' && typeof entry.value === 'string') variables[key] = entry.value;
      else if (entry?.type === 'bool' && ['true', 'false'].includes(entry.value)) variables[key] = entry.value === 'true';
      else if (/^list<(int|float|str|bool)>$/.test(entry?.type || '')) {
        const source = JSON.parse(entry.value);
        if (!Array.isArray(source)) throw Error(`Invalid debug list: ${key}`);
        const elementType = entry.type.slice(5, -1);
        variables[key] = source.map((value) => {
          if (elementType === 'int' && (Number.isSafeInteger(value) || typeof value === 'string' && /^[+-]?\d+$/.test(value))) return NovelRuntime.integer(value);
          if (elementType === 'float' && (typeof value === 'number' || typeof value === 'string')) return NovelRuntime.floating(value);
          if (elementType === 'str' && typeof value === 'string') return value;
          if (elementType === 'bool' && typeof value === 'boolean') return value;
          throw Error(`Invalid debug list element type: ${key}`);
        });
      }
      else if (entry?.type === 'dict<int>' || entry?.type === 'dict<float>' || entry?.type === 'dict<str>' || entry?.type === 'dict<bool>') {
        const source = JSON.parse(entry.value);
        if (!source || typeof source !== 'object' || Array.isArray(source)) throw Error(`Invalid debug dictionary: ${key}`);
        const dictionary = Object.create(null);
        for (const [field, value] of Object.entries(source)) {
          if (entry.type === 'dict<int>') dictionary[field] = NovelRuntime.integer(value);
          else if (entry.type === 'dict<float>') dictionary[field] = NovelRuntime.floating(value);
          else if (entry.type === 'dict<bool>' && typeof value === 'boolean') dictionary[field] = value;
          else if (typeof value === 'string') dictionary[field] = value;
          else throw Error(`Invalid debug dictionary element type: ${key}.${field}`);
        }
        variables[key] = dictionary;
      } else if (entry?.type === 'struct') {
        const source = JSON.parse(entry.value);
        const fields = entry.fields;
        if (!source || typeof source !== 'object' || Array.isArray(source) || !fields || typeof fields !== 'object' || Object.keys(source).length !== Object.keys(fields).length) throw Error(`Invalid debug structure: ${key}`);
        const structure = Object.create(null);
        for (const [field, type] of Object.entries(fields)) {
          if (!Object.hasOwn(source, field)) throw Error(`Missing debug structure field: ${field}`);
          if (type === 'int') structure[field] = NovelRuntime.integer(source[field]);
          else if (type === 'float') structure[field] = NovelRuntime.floating(source[field]);
          else if (type === 'str' && typeof source[field] === 'string') structure[field] = source[field];
          else if (type === 'bool' && typeof source[field] === 'boolean') structure[field] = source[field];
          else throw Error(`Invalid debug structure field: ${field}`);
        }
        variables[key] = structure;
      } else throw Error(`Unsupported debug variable type: ${key}`);
    }
  }
  const debugLineText = debugParams.get('line');
  let debugLine;
  if (debugSession && debugLineText !== null) {
    if (!/^\d+$/.test(debugLineText)) throw Error('Debug line must be a non-negative integer.');
    debugLine = Number(debugLineText);
    if (!Number.isSafeInteger(debugLine)) throw Error('Debug line is outside the supported integer range.');
  }
  launchDebug = debugSession ? {
    file: debugParams.get('source') || undefined,
    scene: debugParams.get('scene') || undefined,
    line: debugLine > 0 ? debugLine : undefined,
    variables,
  } : null;
  const menu = await (await fetch('/api/game-screens')).json();
  gameScreenConfig = menu.screens;
  saveStore = await NovelSaveStore.open({ namespace: `${gameScreenConfig.saveId || projectInfo.projectRoot || location.origin}:${debugSession ? 'test' : 'game'}`, legacyPrefix: saveStoragePrefix });
  await Promise.all(Array.from({ length: 100 }, async (_, index) => {
    const encoded = await saveStore.readSlot(index);
    if (!encoded) return;
    try {
      const saved = decodeSave(encoded);
      if (!isLoadableSave(saved)) {
        saveSlotStates.set(index, saved?.version !== 1 || saved?.saveId && saved.saveId !== (gameScreenConfig.saveId || '') ? 'incompatible' : 'corrupt');
        return;
      }
      saveSlotCache.set(index, saved);
      saveSlotStates.set(index, 'ready');
      const thumbnail = await saveStore.readThumbnail(index);
      if (thumbnail instanceof Blob) saveThumbnailUrls.set(index, URL.createObjectURL(thumbnail));
    } catch { saveSlotStates.set(index, 'corrupt'); /* Preserve damaged bytes for recovery. */ }
  }));
  await loadUiSettings();
  if (!debugSession) {
    try {
      const slotPointer = sessionStorage.getItem(`${saveStoragePrefix}:resume-slot`);
      if (slotPointer !== null) sessionStorage.removeItem(`${saveStoragePrefix}:resume-slot`);
      const rawResume = localStorage.getItem(`${saveStoragePrefix}:resume`);
      if (rawResume) localStorage.removeItem(`${saveStoragePrefix}:resume`);
      if (slotPointer !== null || rawResume) {
        resumeAtLaunch = slotPointer !== null && /^\d+$/.test(slotPointer) ? readSaveSlot(Number(slotPointer)) : decodeSave(rawResume);
        if (resumeAtLaunch?.version === 1 && typeof resumeAtLaunch.file === 'string' && typeof resumeAtLaunch.scene === 'string'
          && /^[A-Za-z_][A-Za-z0-9_]*$/.test(resumeAtLaunch.scene) && Number.isSafeInteger(resumeAtLaunch.line) && resumeAtLaunch.line > 0) {
          launchName = resumeAtLaunch.file;
          launchDebug = { file: resumeAtLaunch.file, scene: resumeAtLaunch.scene, line: resumeAtLaunch.line, variables: resumeAtLaunch.variables || {}, locals: resumeAtLaunch.locals || [], readonlyLocals: resumeAtLaunch.readonlyLocals || [], sceneState: resumeAtLaunch.sceneState };
          $('text').textContent = String(resumeAtLaunch.text || ''); $('speaker-text').textContent = String(resumeAtLaunch.speaker || '');
        } else resumeAtLaunch = null;
      }
    } catch { resumeAtLaunch = null; }
  }
  if (!debugSession && menu.screens?.titleScene && !resumeAtLaunch) {
    launchName = menu.screens.titleScene.file;
    launchDebug = { file: menu.screens.titleScene.file, scene: menu.screens.titleScene.scene };
    await launchGame();
  } else if (!debugSession && resumeAtLaunch) {
    await launchGame();
  } else if (!debugSession && menu.configured) {
    runtime.program = await loadScene(launchName);
    gameStartHandler = launchGame;
    showGameScreen(gameScreenConfig.initial, { push: false });
  } else await launchGame();
})().catch(error => { $('speaker-text').textContent = 'PLAYER ERROR'; $('text').textContent = error.message; $('choices').replaceChildren(); reportDebug('novel-debug:error', { error: error.message }); });
