'use strict';
const $ = id => document.getElementById(id);
// Keep scene content in a camera-controlled world while dialogue and screen UI
// remain in screen space. This also works with older packaged player.html.
(() => {
  const stage = $('stage');
  if (!stage || $('world')) return;
  const world = document.createElement('div'); world.id = 'world';
  const background = $('background'), characters = $('characters'), images = $('images');
  stage.insertBefore(world, background);
  for (const layer of [background, $('video-layer'), characters, images].filter(Boolean)) world.append(layer);
  if (!$('video-layer')) { const layer = document.createElement('div'); layer.id = 'video-layer'; world.insertBefore(layer, characters || null); }
})();
let playerTheme = null;
const uiPreviewMode = new URLSearchParams(location.search).get('ui-preview') === '1';
let playerStageFitHandler = null;
let visualBackgroundOffset = { x: 0, y: 0 };
let visualCamera = { zoom: 1, focusX: 640, focusY: 360 };
const DEFAULT_RENDER_LAYERS = Object.freeze({ background: 0, video: 1, character: 2, image: 3, fog: 4, dialogue: 5, controls: 6, menu: 7 });
let activeRenderLayers = { ...DEFAULT_RENDER_LAYERS };
let gameScreenConfig = null;
let activeGameScreen = null;
function uiSettingRule(key) { return gameScreenConfig?.controlSchema?.settings?.[key]; }
function isValidUiSettingValue(key, value) {
  const rule = uiSettingRule(key);
  if (rule?.type === 'boolean') return typeof value === 'boolean';
  if (rule?.type === 'number') return Number.isFinite(value) && value >= rule.minimum && value <= rule.maximum;
  if (rule?.type === 'enum') return typeof value === 'string' && rule.values?.includes(value);
  const fallback = gameScreenConfig?.controlDefaults?.[key];
  if (typeof fallback === 'boolean') return typeof value === 'boolean';
  if (typeof fallback === 'number') return Number.isFinite(value) && value >= 0 && value <= 1;
  if (typeof fallback === 'string') return /^ui\.shortcut\.F(?:[1-9]|1[0-2])$/.test(key)
    ? NovelScreenDocument.shortcutActions.includes(value)
    : key === 'ui.fontFamily' && ['default', 'gothic', 'mincho'].includes(value);
  return false;
}
function uiShortcutActions() { return gameScreenConfig?.controlSchema?.shortcutActions || NovelScreenDocument.shortcutActions; }
function uiShortcutActionLabel(action) { return gameScreenConfig?.controlSchema?.shortcutActionLabels?.[action] || NovelScreenDocument.shortcutActionLabels[action] || action; }
function gameScreenBackground(screen) { return Object.hasOwn(screen, 'background') ? screen.background : gameScreenConfig?.defaultBackground || ''; }
function setActiveGameScreen(id) {
  activeGameScreen = id;
  const stage = $('stage');
  if (stage) {
    if (id) stage.dataset.gameScreenOpen = 'true';
    else delete stage.dataset.gameScreenOpen;
  }
  resetCursorHideTimer?.();
}
function layerZIndex(value, order = 0) {
  const layer = Number(value);
  if (!Number.isFinite(layer) || layer < 0 || layer >= 8) return 0;
  return Math.round(layer * 1000) * 100000 + Math.min(99999, Math.max(0, Number(order) || 0));
}
function applyRenderLayers(layers = activeRenderLayers) {
  activeRenderLayers = { ...DEFAULT_RENDER_LAYERS, ...(layers || {}) };
  const styleLayer = (element, category, override, order) => {
    if (!element) return;
    element.style.zIndex = String(layerZIndex(override ?? activeRenderLayers[category], order));
  };
  styleLayer($('background'), 'background');
  document.querySelectorAll('#video-layer video').forEach((video, index) => styleLayer(video, 'video', video.dataset.layer, index));
  document.querySelectorAll('#characters .actor').forEach((actor, index) => styleLayer(actor, 'character', actor.dataset.layer, Number(actor.dataset.visualOrder) || index));
  document.querySelectorAll('#images .image').forEach((image, index) => styleLayer(image, 'image', image.dataset.layer, Number(image.dataset.visualOrder) || index));
  styleLayer($('bottom-fog'), 'fog');
  styleLayer($('dialogue'), 'dialogue');
  styleLayer($('player-controls'), 'controls');
  styleLayer($('screen-overlay'), 'menu');
  document.querySelectorAll('.player-effect').forEach((effect, index) => styleLayer(effect, 'menu', undefined, 90000 + index));
}
let gameStarted = false;
let gameStartHandler = null;
let startWaitResolve = null;
let saveStoragePrefix = '';
let saveStore = null;
const saveSlotCache = new Map();
const saveSlotStates = new Map();
const saveThumbnailUrls = new Map();
const activeSlotPages = { save: 0, load: 0 };
let selectedSlotIndex = -1;
let deleteArmedSlotIndex = -1;
let currentExecution = null;
const seenSayLines = new Set();
let autoPlayActive = false;
let skipActive = false;
let holdActive = false;
const dialogueHistory = [];
let activeTextReveal = null;
let lastVoiceAsset = '';
let lastVoiceCharacter = '';
let autoAdvanceTimer = null;
let pendingScreenMusic = '';
const bgmLayers = new Set();
const bgmAnimationIds = new WeakMap();
const bgmGainNodes = new WeakMap();
const uiAudioRoutes = new WeakMap();
const bgmAutomations = new Map();
const activeUiAudio = new Set();
let userUiSettings = Object.create(null);
let cursorHideTimer = null;
function cursorHideDelayMs() {
  const option = Math.max(0, Math.min(3, Math.round(Number(userUiSettings['ui.cursorHideDelay'] ?? gameScreenConfig?.controlDefaults?.['ui.cursorHideDelay'] ?? 0) * 3)));
  return [0, 5000, 10000, 20000][option];
}
function resetCursorHideTimer() {
  clearTimeout(cursorHideTimer); cursorHideTimer = null;
  document.documentElement.classList.remove('player-cursor-hidden');
  const delay = cursorHideDelayMs();
  if (gameStarted && !activeGameScreen && delay) cursorHideTimer = setTimeout(() => document.documentElement.classList.add('player-cursor-hidden'), delay);
}
for (const eventName of ['pointermove', 'pointerdown', 'keydown']) window.addEventListener(eventName, resetCursorHideTimer, { passive: true });
const cursorHideStyle = document.createElement('style');
cursorHideStyle.textContent = 'html.player-cursor-hidden,html.player-cursor-hidden *{cursor:none!important}';
document.head.append(cursorHideStyle);
document.addEventListener('fullscreenchange', () => {
  const value = Boolean(document.fullscreenElement);
  if (userUiSettings['ui.fullscreen'] !== value) updateUiSetting('ui.fullscreen', value, false);
});
let audioBuses = null;
const testPlaybackOutputScale = new URLSearchParams(location.search).has('debug') ? 0.5 : 1;
let currentDialogBaseOpacity = 1;
function applyDialogOpacity(base) {
  currentDialogBaseOpacity = Number.isFinite(Number(base)) ? Number(base) : 1;
  $('dialogue')?.style.setProperty('--dialog-opacity', String(currentDialogBaseOpacity * Number(userUiSettings['ui.dialogOpacity'] ?? 1)));
}
window.addEventListener('message', event => {
  if (!uiPreviewMode || event.origin !== location.origin || event.source !== window.parent || event.data?.type !== 'novel-ui-preview:theme') return;
  if (typeof event.data.path !== 'string' || !event.data.theme || typeof event.data.theme !== 'object') return;
  try {
    applyPlayerUi(event.data.path, event.data.theme);
  } catch (error) {
    console.warn('編集中のUIテーマをプレビューに適用できませんでした。', error);
  }
});
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
function applyUiFontFamily() {
  const selected = userUiSettings['ui.fontFamily'] ?? gameScreenConfig?.controlDefaults?.['ui.fontFamily'] ?? 'default';
  const family = selected === 'gothic' ? 'sans-serif' : selected === 'mincho' ? 'serif' : '';
  $('stage')?.style.setProperty('font-family', family);
}
function characterVoiceGain(characterId) {
  if (!characterId) return 1;
  if (settingOn(`audio.voice.${characterId}.muted`)) return 0;
  return Number(userUiSettings[`audio.voice.${characterId}`] ?? gameScreenConfig?.controlDefaults?.[`audio.voice.${characterId}`] ?? 1);
}
function settingGain(kind) { return settingOn(`audio.${kind}Muted`) ? 0 : Number(userUiSettings[`audio.${kind}`] ?? gameScreenConfig?.controlDefaults?.[`audio.${kind}`] ?? (kind === 'voice' ? 0.5 : 1)); }
function applyUiAudioMix() {
  if (audioBuses && bgmAudioContext) {
    const now = bgmAudioContext.currentTime;
    audioBuses.master.gain.setTargetAtTime(Number(userUiSettings['audio.master'] ?? gameScreenConfig?.controlDefaults?.['audio.master'] ?? 1) * testPlaybackOutputScale, now, 0.015);
    for (const kind of ['bgm', 'se', 'voice']) audioBuses[kind].gain.setTargetAtTime(settingGain(kind), now, 0.015);
  }
  for (const audio of activeUiAudio) {
    if (!audio.isConnected || bgmGainNodes.has(audio)) continue;
    const base = Number(audio.dataset.userGain ?? 1);
    const kind = audio.dataset.audioKind || 'se';
    const speakerGain = kind === 'voice' ? characterVoiceGain(audio.dataset.voiceCharacter || '') : 1;
    const route = uiAudioRoutes.get(audio);
    if (route) { route.gain.gain.setTargetAtTime(base * speakerGain, bgmAudioContext.currentTime, 0.015); continue; }
    audio.volume = Math.max(0, Math.min(1, base * Number(userUiSettings['audio.master'] ?? 1) * testPlaybackOutputScale * settingGain(kind) * speakerGain));
  }
}
async function loadUiSettings() {
  const defaults = gameScreenConfig?.controlDefaults || {};
  const stored = await saveStore.readPreference('ui-settings') || {};
  userUiSettings = Object.create(null);
  for (const [key, fallback] of Object.entries(defaults)) {
    const value = stored[key];
    userUiSettings[key] = isValidUiSettingValue(key, value) ? value : fallback;
  }
  applyUiFontFamily();
  applyDialogOpacity(currentDialogBaseOpacity);
  applyUiAudioMix();
  resetCursorHideTimer();
}
function updateUiSetting(key, value, applyDisplay = true) {
  const fallback = gameScreenConfig?.controlDefaults?.[key];
  if (!isValidUiSettingValue(key, value) || fallback === undefined) return;
  userUiSettings[key] = value;
  if (key === 'ui.cursorHideDelay') resetCursorHideTimer();
  if (key === 'ui.fullscreen' && applyDisplay) {
    if (value && !document.fullscreenElement) void document.documentElement.requestFullscreen?.().catch(() => updateUiSetting('ui.fullscreen', false, false));
    else if (!value && document.fullscreenElement) void document.exitFullscreen?.();
  }
  void saveStore.writePreference('ui-settings', { ...userUiSettings }).catch(error => {
    const notice = document.createElement('div'); notice.className = 'game-screen-error';
    notice.textContent = `設定を保存できませんでした: ${error.message}`; $('screen-overlay').append(notice);
  });
  if (key === 'ui.dialogOpacity') applyDialogOpacity(currentDialogBaseOpacity);
  if (key === 'ui.fontFamily') applyUiFontFamily();
  applyUiAudioMix();
}
function clearAutoAdvance() {
  if (autoAdvanceTimer !== null) clearTimeout(autoAdvanceTimer);
  autoAdvanceTimer = null;
}
function autoAdvanceDelay() {
  const speed = Number(userUiSettings['ui.autoSpeed'] ?? gameScreenConfig?.controlDefaults?.['ui.autoSpeed'] ?? 0.45);
  return Math.round(8500 - Math.max(0, Math.min(1, speed)) * 7600);
}
async function revealDialogueText(fullText) {
  const speed = Number(userUiSettings['ui.textSpeed'] ?? gameScreenConfig?.controlDefaults?.['ui.textSpeed'] ?? 1);
  const interval = Math.round((1 - Math.max(0, Math.min(1, speed))) * 48);
  const characters = Array.from(fullText);
  $('text').textContent = '';
  if (!interval || !characters.length) { $('text').textContent = fullText; return; }
  await new Promise(resolve => {
    let index = 0, timer = null, finished = false;
    const finish = () => {
      if (finished) return;
      finished = true; clearTimeout(timer); $('text').textContent = fullText;
      if (activeTextReveal === finish) activeTextReveal = null;
      resolve();
    };
    activeTextReveal = finish;
    const step = () => {
      if (finished) return;
      $('text').append(characters[index++]);
      if (index >= characters.length) finish();
      else timer = setTimeout(step, interval);
    };
    step();
  });
}
function pausePlaybackModes() { autoPlayActive = false; skipActive = false; clearAutoAdvance(); }
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
  const normalizedThemePath = themePath.replaceAll('\\', '/');
  // New projects keep the theme JSON under setting/, but UI artwork paths are
  // rooted at the project asset directory (e.g. asset/ui/panel.png). Legacy
  // projects store the theme inside asset/ and keep paths relative to it.
  const directory = normalizedThemePath.startsWith('setting/')
    ? []
    : normalizedThemePath.split('/').slice(0, -1);
  return '/asset/' + [...directory, ...image.replaceAll('\\', '/').split('/')].map(encodeURIComponent).join('/');
}
function uiBackground(themePath, image, fallback) {
  return image ? `url("${uiAsset(themePath, image)}") center / 100% 100% no-repeat` : fallback;
}
function applyPlayerUi(themePath, theme) {
  playerTheme = { path: themePath, ...theme };
  const { screen, dialog, choices } = theme;
  applyRenderLayers(theme.layers || DEFAULT_RENDER_LAYERS);
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
  applyRenderLayers(theme.layers || DEFAULT_RENDER_LAYERS);
  if (!playerStageFitHandler) {
    playerStageFitHandler = () => {
      const currentScreen = playerTheme.screen;
      const portrait = innerHeight > innerWidth;
      // Fill the viewport to avoid letterboxing. The stage remains clipped at its
      // edges, which is preferable to unused black bands above and below the game.
      const scale = portrait
        ? Math.max(innerWidth / currentScreen.height, innerHeight / currentScreen.width)
        : Math.max(innerWidth / currentScreen.width, innerHeight / currentScreen.height);
      stage.style.position = 'fixed';
      stage.style.left = '50%';
      stage.style.top = '50%';
      stage.style.margin = '0';
      stage.style.transformOrigin = 'center center';
      stage.style.transform = `translate(-50%, -50%) ${portrait ? 'rotate(90deg) ' : ''}scale(${scale})`;
    };
    window.addEventListener('resize', playerStageFitHandler);
    window.visualViewport?.addEventListener('resize', playerStageFitHandler);
  }
  playerStageFitHandler();
  const debugSession = new URLSearchParams(location.search).get('debug');
  if (debugSession && window.parent !== window) {
    window.parent.postMessage({ type: 'novel-debug:screen', session: debugSession, width: screen.width, height: screen.height }, location.origin);
  }
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
    && (saved.saveId === undefined || saved.saveId === '' || saved.saveId === (gameScreenConfig?.saveId || ''))
    && typeof saved.scene === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(saved.scene)
    && Number.isSafeInteger(saved.line) && saved.line >= 1
    && saved.variables !== null && typeof saved.variables === 'object' && !Array.isArray(saved.variables)
    && (saved.locals === undefined || Array.isArray(saved.locals) && saved.locals.every(frame => frame !== null && typeof frame === 'object' && !Array.isArray(frame)))
    && (saved.readonlyLocals === undefined || Array.isArray(saved.readonlyLocals)
      && saved.readonlyLocals.every(frame => Array.isArray(frame) && frame.every(name => typeof name === 'string'))
      && (saved.locals === undefined ? saved.readonlyLocals.length === 0 : saved.readonlyLocals.length === saved.locals.length));
}
function readSaveSlot(index) {
  return saveSlotCache.get(index) || null;
}
function showPlayerToast(message, isError = false) {
  const toast = document.createElement('div');
  toast.className = isError ? 'player-toast player-toast-error' : 'player-toast';
  toast.setAttribute('role', isError ? 'alert' : 'status');
  toast.textContent = message;
  $('stage').append(toast);
  setTimeout(() => toast.remove(), 3000);
  return toast;
}
function saveSlotState(index) {
  return readSaveSlot(index) ? 'ready' : saveSlotStates.get(index) || 'empty';
}
function latestSaveSlotIndex() {
  const screen = gameScreenConfig?.screens?.[screenForRole('load-slots')];
  const count = (screen?.slotLayout?.count || 8) * (screen?.slotPages || 1);
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
  if (id) { activeSlotPages[action] = 0; selectedSlotIndex = -1; deleteArmedSlotIndex = -1; showGameScreen(id); }
  else showGameScreen('pause');
}
function selectedSlotRole() { return gameScreenConfig?.screens?.[activeGameScreen]?.role || ''; }
function firstEmptySlot(except = -1) {
  for (let index = 0; index < 120; index++) if (index !== except && saveSlotState(index) === 'empty') return index;
  return -1;
}
function updateSlotTools(overlay) {
  const summary = overlay.querySelector('[data-role="selected-slot-summary"]');
  const saved = selectedSlotIndex >= 0 ? readSaveSlot(selectedSlotIndex) : null;
  if (summary) summary.textContent = selectedSlotIndex < 0
    ? 'Select a Save Slot.'
    : `枠 ${String(selectedSlotIndex + 1).padStart(2, '0')}　${saved ? `${saved.scene || ''}\n${saved.speaker || 'Narrator'}: ${saved.text || ''}\n${formatSavedAt(saved.savedAt || 0)}${saved.locked ? '\n保護中' : ''}` : '空き枠'}`;
  const role = selectedSlotRole();
  const ready = Boolean(saved) && saveSlotState(selectedSlotIndex) === 'ready';
  const locked = Boolean(saved?.locked);
  const canCommit = selectedSlotIndex >= 0 && (role === 'save-slots' ? Boolean(currentExecution?.line && !locked) : role === 'load-slots' && ready);
  const hasFreeSlot = ready && firstEmptySlot(selectedSlotIndex) >= 0;
  const enablement = {
    'slot-commit': canCommit,
    'slot-copy': hasFreeSlot,
    'slot-move': hasFreeSlot && !locked,
    'slot-delete': ready && !locked,
    'slot-lock': ready,
  };
  for (const [action, enabled] of Object.entries(enablement)) {
    const button = overlay.querySelector(`[data-action="${action}"]`);
    if (!button) continue;
    button.disabled = !enabled;
    button.classList.toggle('slot-tool-disabled', !enabled);
    if (action === 'slot-delete') button.textContent = deleteArmedSlotIndex === selectedSlotIndex ? 'もう一度押して消去' : 'データ消去';
    if (action === 'slot-lock') button.textContent = locked ? 'ロック解除' : 'ロック';
  }
}
async function runSelectedSlotAction(action) {
  const source = selectedSlotIndex;
  const saved = source >= 0 ? readSaveSlot(source) : null;
  if (action === 'slot-commit') {
    if (source < 0) return;
    if (selectedSlotRole() === 'save-slots') await saveGameToSlot(source);
    else if (selectedSlotRole() === 'load-slots') loadGameSlot(source);
    return;
  }
  if (!saved || saveSlotState(source) !== 'ready') return;
  if (action === 'slot-lock') {
    const changed = { ...saved, locked: !saved.locked };
    const thumbnail = await saveStore.readThumbnail(source);
    await saveStore.writeSlot(source, encodeSave(changed), { scene: changed.scene, speaker: changed.speaker, text: changed.text, savedAt: changed.savedAt }, thumbnail);
    saveSlotCache.set(source, changed); saveSlotStates.set(source, 'ready'); deleteArmedSlotIndex = -1;
  } else if (action === 'slot-delete') {
    if (saved.locked) return;
    if (deleteArmedSlotIndex !== source) { deleteArmedSlotIndex = source; showGameScreen(activeGameScreen, { push: false }); return; }
    await saveStore.deleteSlot(source);
    saveSlotCache.delete(source); saveSlotStates.delete(source);
    const thumbnail = saveThumbnailUrls.get(source); if (thumbnail) URL.revokeObjectURL(thumbnail);
    saveThumbnailUrls.delete(source); selectedSlotIndex = -1; deleteArmedSlotIndex = -1;
  } else if (action === 'slot-copy' || action === 'slot-move') {
    if (action === 'slot-move' && saved.locked) return;
    const destination = firstEmptySlot(source); if (destination < 0) return;
    const moved = await saveStore.transferSlot(source, destination, { move: action === 'slot-move' });
    if (!moved) return;
    const clone = { ...saved, locked: Boolean(saved.locked) };
    saveSlotCache.set(destination, clone); saveSlotStates.set(destination, 'ready');
    const sourceThumbnail = await saveStore.readThumbnail(destination);
    const previousThumbnail = saveThumbnailUrls.get(destination); if (previousThumbnail) URL.revokeObjectURL(previousThumbnail);
    if (sourceThumbnail instanceof Blob) saveThumbnailUrls.set(destination, URL.createObjectURL(sourceThumbnail));
    if (action === 'slot-move') {
      saveSlotCache.delete(source); saveSlotStates.delete(source);
      const previous = saveThumbnailUrls.get(source); if (previous) URL.revokeObjectURL(previous);
      saveThumbnailUrls.delete(source);
    }
    selectedSlotIndex = destination; deleteArmedSlotIndex = -1;
  }
  showGameScreen(activeGameScreen, { push: false });
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
    case 'status': return `${({ ready: '記録あり', empty: '空き', corrupt: '破損', incompatible: '非対応' })[saveSlotState(index)] || ''}${saved?.locked ? ' 🔒' : ''}`;
    case 'scene': return saved?.scene || '';
    case 'speaker': return saved?.speaker || '';
    case 'text': return saved?.text || '';
    case 'saved-at': return saved?.savedAt ? formatSavedAt(saved.savedAt) : '';
    default: return '';
  }
}
async function captureSaveThumbnail(includeDialogue = true) {
  const screen = playerTheme.screen;
  const canvas = document.createElement('canvas');
  canvas.width = 320; canvas.height = 180;
  const context = canvas.getContext('2d');
  context.fillStyle = '#101a22'; context.fillRect(0, 0, canvas.width, canvas.height);
  const sx = canvas.width / screen.width, sy = canvas.height / screen.height;
  const elementRect = element => {
    let x = 0, y = 0, node = element;
    while (node && node !== $('stage')) { x += node.offsetLeft || 0; y += node.offsetTop || 0; node = node.offsetParent; }
    return { x: x * sx, y: y * sy, width: (element.offsetWidth || element.clientWidth) * sx, height: (element.offsetHeight || element.clientHeight) * sy };
  };
  const imageCache = new Map();
  const loadImage = async source => {
    if (!source) return null;
    if (!imageCache.has(source)) {
      const image = new Image(); image.src = source;
      imageCache.set(source, image.decode().then(() => image).catch(() => null));
    }
    return imageCache.get(source);
  };
  const drawImage = async (source, rect, fit = 'contain', alpha = 1) => {
    const image = await loadImage(source);
    if (!image || !rect.width || !rect.height) return false;
    let x = rect.x, y = rect.y, width = rect.width, height = rect.height;
    if (fit === 'cover') {
      const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight);
      const cropW = width / scale, cropH = height / scale;
      context.globalAlpha = alpha;
      context.drawImage(image, (image.naturalWidth - cropW) / 2, (image.naturalHeight - cropH) / 2, cropW, cropH, x, y, width, height);
      context.globalAlpha = 1;
    } else {
      if (fit === 'contain') {
        const scale = Math.min(width / image.naturalWidth, height / image.naturalHeight);
        width = image.naturalWidth * scale; height = image.naturalHeight * scale;
        x += (rect.width - width) / 2; y += (rect.height - height) / 2;
      }
      context.globalAlpha = alpha; context.drawImage(image, x, y, width, height); context.globalAlpha = 1;
    }
    return true;
  };
  const assetUrl = source => uiAsset(playerTheme.path, source);
  const background = $('background');
  const backgroundUrl = /url\(["']?([^"')]+)["']?\)/.exec(background.style.backgroundImage)?.[1];
  if (backgroundUrl) await drawImage(backgroundUrl, { x: 0, y: 0, width: canvas.width, height: canvas.height }, 'cover');
  for (const selector of ['#characters img', '#images img']) for (const element of document.querySelectorAll(selector)) {
    const rect = elementRect(element);
    const transformed = getComputedStyle(element).transform;
    if (transformed && transformed !== 'none' && element.matches('.actor,.image')) rect.x -= rect.width / 2;
    await drawImage(element.currentSrc || element.src, rect, getComputedStyle(element).objectFit || 'contain', Number(getComputedStyle(element).opacity || 1));
  }
  const fog = $('bottom-fog');
  if (fog?.width && getComputedStyle(fog).display !== 'none') context.drawImage(fog, 0, 0, fog.width, fog.height, 0, canvas.height - fog.offsetHeight * sy, canvas.width, fog.offsetHeight * sy);
  const drawText = element => {
    const rect = elementRect(element), style = getComputedStyle(element);
    if (!rect.width || !rect.height || !element.textContent) return;
    context.save(); context.beginPath(); context.rect(rect.x, rect.y, rect.width, rect.height); context.clip();
    context.font = style.font; context.fillStyle = style.color; context.textBaseline = 'top';
    const lineHeight = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.2;
    const lines = [];
    for (const paragraph of element.textContent.split('\n')) {
      let line = '';
      for (const character of paragraph) {
        const next = line + character;
        if (line && context.measureText(next).width > rect.width) { lines.push(line); line = character; }
        else line = next;
      }
      lines.push(line);
    }
    let y = rect.y;
    for (const line of lines) {
      if (y + lineHeight > rect.y + rect.height) break;
      let x = rect.x;
      const align = style.textAlign === 'start' ? 'left' : style.textAlign;
      if (align === 'center') x += Math.max(0, (rect.width - context.measureText(line).width) / 2);
      else if (align === 'right' || align === 'end') x += Math.max(0, rect.width - context.measureText(line).width);
      context.fillText(line, x, y); y += lineHeight;
    }
    context.restore();
  };
  if (includeDialogue) {
    const dialog = $('dialogue'), dialogRect = elementRect(dialog);
    const dialogOpacity = Number(getComputedStyle(dialog, '::before').opacity || 1);
    const dialogDrawn = playerTheme.dialog.image && await drawImage(assetUrl(playerTheme.dialog.image), dialogRect, 'fill', dialogOpacity);
    if (!dialogDrawn) { context.globalAlpha = dialogOpacity; context.fillStyle = getComputedStyle(dialog, '::before').backgroundColor; if (context.fillStyle === 'rgba(0, 0, 0, 0)') context.fillStyle = '#07111ddd'; context.fillRect(dialogRect.x, dialogRect.y, dialogRect.width, dialogRect.height); context.globalAlpha = 1; }
    const speaker = $('speaker'), speakerRect = elementRect(speaker);
    if (playerTheme.dialog.nameplate.image) await drawImage(assetUrl(playerTheme.dialog.nameplate.image), speakerRect, 'fill');
    else { context.fillStyle = getComputedStyle(speaker).backgroundColor; context.fillRect(speakerRect.x, speakerRect.y, speakerRect.width, speakerRect.height); }
    drawText($('speaker-text')); drawText($('text'));
    for (const button of document.querySelectorAll('#choices .choice')) {
      const rect = elementRect(button), style = getComputedStyle(button);
      const imageUrl = /url\(["']?([^"')]+)["']?\)/.exec(style.backgroundImage)?.[1];
      if (imageUrl) await drawImage(imageUrl, rect, 'fill');
      else { context.fillStyle = style.backgroundColor; context.fillRect(rect.x, rect.y, rect.width, rect.height); }
      const label = button.querySelector('span'); if (label) drawText(label);
    }
    const next = $('next'), nextStyle = getComputedStyle(next);
    if (next && nextStyle.display !== 'none' && nextStyle.visibility !== 'hidden') drawText(next);
  }
  const video = document.querySelector('#stage video');
  if (video?.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth && video.videoHeight) {
    const rect = elementRect(video); context.drawImage(video, rect.x, rect.y, rect.width || canvas.width, rect.height || canvas.height);
  }
  for (const button of document.querySelectorAll('#player-controls .player-control-button')) {
    const rect = elementRect(button), style = getComputedStyle(button);
    context.fillStyle = style.backgroundColor; context.fillRect(rect.x, rect.y, rect.width, rect.height);
    const imageUrl = /url\(["']?([^"')]+)["']?\)/.exec(style.backgroundImage)?.[1];
    if (imageUrl) await drawImage(imageUrl, rect, 'fill');
    const label = button.querySelector('span'); if (label) drawText(label);
  }
  for (const element of document.querySelectorAll('.player-effect')) {
    const rect = elementRect(element), style = getComputedStyle(element);
    context.globalAlpha = Number(style.opacity || 1); context.fillStyle = style.backgroundColor;
    context.fillRect(rect.x, rect.y, rect.width, rect.height); context.globalAlpha = 1;
  }
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
  if (readSaveSlot(index)?.locked) return;
  try {
    runtime.assertSaveBoundary();
    const snapshot = {
      version: 1, saveId: gameScreenConfig?.saveId || '', file: execution.file, scene: execution.scene, line: execution.line,
      variables: runtime.globals, locals: runtime.frames.slice(1),
      readonlyLocals: runtime.frames.slice(1).map(frame => [...(runtime.readonlyFrames.get(frame) || [])]),
      sceneState: runtime.sceneState,
      text: $('text').textContent, speaker: $('speaker-text').textContent,
      savedAt: Date.now(), locked: false,
    };
    const encoded = encodeSave(snapshot);
    if (encoded.length > 3_500_000) throw Error('Save dataのサイズが上限を超えています。変数または演出状態を減らしてください。');
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
async function saveQuickGame() {
  const execution = currentExecution;
  if (!execution?.file || !execution.scene || !execution.line) return;
  try {
    runtime.assertSaveBoundary();
    const snapshot = {
      version: 1, saveId: gameScreenConfig?.saveId || '', file: execution.file, scene: execution.scene, line: execution.line,
      variables: runtime.globals, locals: runtime.frames.slice(1),
      readonlyLocals: runtime.frames.slice(1).map(frame => [...(runtime.readonlyFrames.get(frame) || [])]),
      sceneState: runtime.sceneState, text: $('text').textContent, speaker: $('speaker-text').textContent, savedAt: Date.now(),
    };
    const encoded = encodeSave(snapshot);
    if (encoded.length > 3_500_000) throw Error('Quick Save dataのサイズが上限を超えています。');
    await saveStore.writePreference('quick-save', encoded);
    showPlayerToast('Quick Saveを実行しました。');
  } catch (error) {
    showPlayerToast(`Quick Saveに失敗しました: ${error.message}`, true);
  }
}
async function loadQuickGame() {
  try {
    const encoded = await saveStore.readPreference('quick-save');
    const saved = typeof encoded === 'string' ? decodeSave(encoded) : null;
    if (!isLoadableSave(saved)) throw Error('Quick Saveがありません。');
    sessionStorage.setItem(`${saveStoragePrefix}:resume`, encoded);
    location.reload();
  } catch (error) {
    const notice = document.createElement('div'); notice.className = 'game-screen-error'; notice.textContent = `Quick Loadに失敗しました: ${error.message}`; $('screen-overlay').append(notice);
  }
}
function loadGameSlot(index) {
  const saved = readSaveSlot(index);
  if (!saved) return;
  try {
    sessionStorage.setItem(`${saveStoragePrefix}:resume-slot`, String(index));
    location.reload();
  } catch (error) {
    const notice = document.createElement('div'); notice.className = 'game-screen-error'; notice.textContent = `Loadに失敗しました: ${error.message}`; $('screen-overlay').append(notice);
  }
}
async function activateGameScreenAction(action, target, node) {
  const overlay = $('screen-overlay');
  const slotIndex = node?.attrs?.['data-slot-index'];
  if (slotIndex !== undefined) {
    if (action === 'slot-select') {
      selectedSlotIndex = Number(slotIndex); deleteArmedSlotIndex = -1;
      showGameScreen(activeGameScreen, { push: false });
    }
    else if (action === 'save') saveGameToSlot(Number(slotIndex), overlay);
    else loadGameSlot(Number(slotIndex));
  } else if (action === 'setting-value') {
    const value = node?.attrs?.['data-value'];
    const candidate = typeof userUiSettings[target] === 'boolean' ? value === 'true' : value;
    if (Object.hasOwn(userUiSettings, target) && isValidUiSettingValue(target, candidate)) {
      updateUiSetting(target, candidate);
      showGameScreen(activeGameScreen, { push: false });
    }
  } else if (action === 'shortcut-cycle') {
    const key = `ui.shortcut.${target}`;
    const allowed = uiShortcutActions();
    const current = allowed.indexOf(userUiSettings[key] ?? gameScreenConfig?.controlDefaults?.[key]);
    updateUiSetting(key, allowed[(current + 1 + allowed.length) % allowed.length]);
    showGameScreen(activeGameScreen, { push: false });
  } else if (action === 'slot-commit' || action === 'slot-copy' || action === 'slot-move' || action === 'slot-delete' || action === 'slot-lock') {
    await runSelectedSlotAction(action);
  } else if (action === 'start') {
    primeBgmAudioContext(); resumeScreenMusic(); overlay.hidden = true; setActiveGameScreen(null); screenHistory.length = 0;
    if (startWaitResolve) { const resolve = startWaitResolve; startWaitResolve = null; resolve(); }
    else try { await gameStartHandler?.(); } catch (error) { $('speaker-text').textContent = 'Runtime Error'; $('text').textContent = error.message; }
  } else if (action === 'continue') {
    const index = latestSaveSlotIndex();
    if (index >= 0) loadGameSlot(index);
  } else if (action === 'quick-save') await saveQuickGame();
  else if (action === 'quick-load') await loadQuickGame();
  else if (action === 'next') {
    if (holdActive) return;
    overlay.hidden = true; setActiveGameScreen(null); screenHistory.length = 0; $('next').click();
  } else if (action === 'auto' || action === 'skip') {
    holdActive = false;
    if (action === 'auto') { autoPlayActive = !autoPlayActive; skipActive = false; clearAutoAdvance(); }
    else { skipActive = !skipActive; autoPlayActive = false; clearAutoAdvance(); }
    overlay.hidden = true; setActiveGameScreen(null); screenHistory.length = 0;
    $('next').click();
  }
  else if (action === 'hold') {
    holdActive = !holdActive;
    pausePlaybackModes();
    overlay.hidden = true; setActiveGameScreen(null); screenHistory.length = 0;
  }
  else if (action === 'resume') {
    overlay.hidden = true; setActiveGameScreen(null); screenHistory.length = 0;
  } else if (action === 'save' || action === 'load') openSlotScreen(action);
  else if (action === 'slot-page') {
    const role = gameScreenConfig?.screens?.[activeGameScreen]?.role === 'save-slots' ? 'save' : 'load';
    activeSlotPages[role] = Number(target);
    showGameScreen(activeGameScreen, { push: false });
  } else if (action === 'reset-settings') {
    for (const [key, value] of Object.entries(gameScreenConfig?.controlDefaults || {})) updateUiSetting(key, value, true, false);
    void saveStore.writePreference('ui-settings', { ...userUiSettings }).catch(error => {
      const notice = document.createElement('div'); notice.className = 'game-screen-error';
      notice.textContent = `險ｭ螳壹ｒ菫晏ｭ倥〒縺阪∪縺帙ｓ縺ｧ縺励◆: ${error.message}`; $('screen-overlay').append(notice);
    });
    showGameScreen(activeGameScreen, { push: false });
  } else if (action === 'reset-window-size') {
    if (document.fullscreenElement) void document.exitFullscreen?.();
    const width = Number(playerTheme?.screen?.width) || NovelScreenDocument.DEFAULT_CANVAS.width;
    const height = Number(playerTheme?.screen?.height) || NovelScreenDocument.DEFAULT_CANVAS.height;
    try { window.resizeTo(width + Math.max(0, window.outerWidth - window.innerWidth), height + Math.max(0, window.outerHeight - window.innerHeight)); } catch { /* Browser hosts may disallow resizing; native players implement this action directly. */ }
  }
  else if (action === 'open-screen') showGameScreen(target);
  else if (action === 'back') {
    const previous = screenHistory.pop();
    if (previous) showGameScreen(previous, { push: false });
    else if (gameStarted) { overlay.hidden = true; setActiveGameScreen(null); }
  } else if (action === 'quit') {
    if (window.opener) window.close();
    else location.assign('/');
  }
}
function showGameScreen(id, { push = true } = {}) {
  const screen = gameScreenConfig?.screens?.[id];
  if (!screen) throw Error(`画面 '${id}' が定義されていません。`);
  if (push && activeGameScreen && activeGameScreen !== id) screenHistory.push(activeGameScreen);
  setActiveGameScreen(id);
  const overlay = $('screen-overlay');
  const screenAccessibleNames = { title: 'Title screen', pause: 'Pause menu', save: 'Save slots', load: 'Load slots', system: 'System settings', sound: 'Sound settings', log: 'Dialogue history', guide: 'Guide', about: 'About', extra: 'Extra screen' };
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', screen.title || screenAccessibleNames[id] || `${id} screen`);
  const transform = NovelScreenDocument.canvasTransform(playerTheme.screen.width, playerTheme.screen.height, gameScreenConfig.canvas, gameScreenConfig.scaleMode || 'contain');
  const { scaleX, scaleY, offsetX, offsetY } = transform;
  overlay.replaceChildren(); overlay.hidden = false;
  overlay.onkeydown = event => navigateScreenFocus(overlay, event);
  // A screen without an authored background is an overlay on the live game
  // frame (pause/menu), matching Native's transparent SDL canvas.
  const screenBackground = gameScreenBackground(screen);
  overlay.style.backgroundImage = screenBackground ? `url("${screenAsset(screenBackground)}")` : 'none';
  if (screen.title) {
    const title = document.createElement('div'); title.className = 'game-screen-title'; title.textContent = screen.title;
    Object.assign(title.style, { left: `${offsetX + 64 * scaleX}px`, top: `${offsetY + 42 * scaleY}px`, fontSize: `${36 * scaleY}px` }); overlay.append(title);
  }
  if (screen.description) {
    const description = document.createElement('div'); description.className = 'game-screen-description'; description.textContent = screen.description;
    Object.assign(description.style, { left: `${offsetX + 64 * scaleX}px`, top: `${offsetY + 112 * scaleY}px`, width: `${Math.min(560, gameScreenConfig.canvas.width - 128) * scaleX}px`, fontSize: `${21 * scaleY}px` }); overlay.append(description);
  }
  if (screen.music) playScreenMusic(screen.music);
  if (Array.isArray(screen.uiTree)) {
    overlay.append(NovelScreenDocument.buildScreenDom(screen.uiTree, document, {
      scaleX, scaleY, offsetX, offsetY, assetUrl: screenAsset,
      slotIndexOffset: activeSlotPages[screen.role === 'save-slots' ? 'save' : 'load'] * (screen.slotLayout?.count || 12),
      settings: userUiSettings, controlDefaults: gameScreenConfig.controlDefaults,
      disableContinue: latestSaveSlotIndex() < 0,
      onSettingChange: updateUiSetting,
      onAction: (action, target, _event, node) => { void activateGameScreenAction(action, target, node); },
      slotField: saveSlotField,
      slotState: saveSlotState,
      roleContent: (host, node) => {
        if (node.attrs['data-role'] === 'selected-slot-summary') { host.textContent = 'Select a Save Slot.'; return; }
        if (node.attrs['data-role'] !== 'dialogue-history') return;
        host.style.overflowY = 'auto';
        host.replaceChildren();
        const entries = dialogueHistory.slice(-500);
        if (!entries.length) {
          const empty = document.createElement('div'); empty.className = 'history-empty'; empty.textContent = 'まだ会話履歴はありません。'; host.append(empty); return;
        }
        for (const entry of entries) {
          const row = document.createElement('div'); row.className = 'history-entry';
          if (entry.speaker) { const speaker = document.createElement('span'); speaker.className = 'history-speaker'; speaker.textContent = entry.speaker; row.append(speaker); }
          const text = document.createElement('span'); text.className = 'history-text'; text.textContent = entry.text; row.append(text); host.append(row);
        }
        requestAnimationFrame(() => { host.scrollTop = host.scrollHeight; });
      },
      roleSlot: (button, index, node) => {
        const saved = readSaveSlot(index);
        button.classList.toggle('save-slot-selected', selectedSlotIndex === index);
        button.setAttribute('aria-pressed', selectedSlotIndex === index ? 'true' : 'false');
        if (!node.children.length) {
          button.classList.add('game-save-slot');
          button.textContent = saved
            ? `Slot ${String(index + 1).padStart(2, '0')} | ${saved.speaker || 'Narrator'}: ${saved.text || 'No text'}`
            : `Slot ${String(index + 1).padStart(2, '0')} | Empty`;
        }
        button.setAttribute('aria-label', `${String(index + 1).padStart(2, '0')} ${saved ? `${saved.scene || ''} ${saved.text || ''}` : '空き'}`);
        button.disabled = node.attrs['data-action'] === 'slot-select' && screen.role === 'load-slots' ? !saved : screen.role === 'save-slots' && !currentExecution?.line;
      },
    }));
    if (saveStore?.backend === 'localStorage' && ['save-slots', 'load-slots'].includes(screen.role)) {
      const message = 'Browser storage fallbackを使用中のため、再読み込み後はthumbnail previewを表示できません。';
      const hint = overlay.querySelector('.data-hint');
      if (hint) hint.textContent = message;
      else {
        const notice = document.createElement('div');
        notice.className = 'game-screen-notice';
        notice.setAttribute('role', 'note');
        notice.textContent = message;
        overlay.append(notice);
      }
    }
    overlay.querySelectorAll('[data-action="setting-value"]').forEach(button => {
      const setting = button.dataset.target;
      const selectedValue = typeof userUiSettings[setting] === 'boolean' ? button.dataset.value === 'true' : button.dataset.value;
      const selected = userUiSettings[setting] === selectedValue;
      button.classList.toggle('option-selected', selected);
      button.setAttribute('aria-pressed', selected ? 'true' : 'false');
    });
    overlay.querySelectorAll('[data-action="shortcut-cycle"]').forEach(button => {
      const key = `ui.shortcut.${button.dataset.target}`;
      const action = userUiSettings[key] ?? gameScreenConfig?.controlDefaults?.[key] ?? 'none';
      const label = uiShortcutActionLabel(action);
      button.textContent = `${label}　▼`;
      button.setAttribute('aria-label', `${button.dataset.target}: ${label}。クリックで変更`);
    });
    if (screen.role === 'save-slots' || screen.role === 'load-slots') {
      const page = activeSlotPages[screen.role === 'save-slots' ? 'save' : 'load'];
      overlay.querySelectorAll('[data-action="slot-page"]').forEach(button => button.classList.toggle('slot-page-active', Number(button.dataset.target) === page));
      updateSlotTools(overlay);
    }
    if (id === 'pause') {
      overlay.querySelector('[data-action="auto"]')?.classList.toggle('pause-selected', autoPlayActive);
      overlay.querySelector('[data-action="skip"]')?.classList.toggle('pause-selected', skipActive);
      overlay.querySelector('[data-action="hold"]')?.classList.toggle('pause-selected', holdActive);
    }
    focusFirstScreenControl(overlay);
    return;
  }
  for (const item of screen.items || []) {
    if (item.type !== 'button') continue;
    const button = document.createElement('button'); button.type = 'button'; button.className = 'game-screen-button'; button.setAttribute('aria-label', item.label);
    if (item.action === 'continue' && latestSaveSlotIndex() < 0) button.disabled = true;
    const label = document.createElement('span'); label.textContent = item.label; button.append(label);
    if (item.display === 'image') label.hidden = true;
    Object.assign(button.style, { left: `${offsetX + item.x * scaleX}px`, top: `${offsetY + item.y * scaleY}px`, width: `${item.width * scaleX}px`, height: `${item.height * scaleY}px`, fontSize: `${(item.fontSize || 22) * scaleY}px` });
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
  focusFirstScreenControl(overlay);
}
function focusFirstScreenControl(overlay) {
  screenFocusCandidates(overlay)[0]?.focus();
}
function navigateScreenFocus(overlay, event) {
  const controls = screenFocusCandidates(overlay);
  if (event.key === 'Tab') {
    if (!controls.length) { event.preventDefault(); overlay.focus(); return; }
    const currentIndex = controls.indexOf(document.activeElement);
    const step = event.shiftKey ? -1 : 1;
    const nextIndex = currentIndex < 0
      ? (step > 0 ? 0 : controls.length - 1)
      : (currentIndex + step + controls.length) % controls.length;
    event.preventDefault();
    controls[nextIndex].focus();
    return;
  }
  const direction = ({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] })[event.key];
  if (!direction) return;
  const current = document.activeElement;
  if (current instanceof HTMLInputElement && current.type === 'range' && direction[1] === 0) return;
  if (current instanceof HTMLInputElement && current.type === 'checkbox' && direction[1] === 0) { event.preventDefault(); current.click(); return; }
  if (!controls.length) return;
  let target = controls[0];
  if (controls.includes(current)) {
    const from = current.getBoundingClientRect(), cx = from.left + from.width / 2, cy = from.top + from.height / 2;
    let bestScore = Infinity;
    for (const candidate of controls) {
      if (candidate === current) continue;
      const rect = candidate.getBoundingClientRect(), x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
      const primary = direction[0] ? (x - cx) * direction[0] : (y - cy) * direction[1];
      if (primary <= 0.5) continue;
      const cross = direction[0] ? Math.abs(y - cy) : Math.abs(x - cx);
      const score = primary + cross * 2.5 + cross * cross / Math.max(1, primary);
      if (score < bestScore) { bestScore = score; target = candidate; }
    }
    if (bestScore === Infinity) {
      for (const candidate of controls) {
        if (candidate === current) continue;
        const rect = candidate.getBoundingClientRect(), x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
        const primary = direction[0] ? (x - cx) * direction[0] : (y - cy) * direction[1];
        const cross = direction[0] ? Math.abs(y - cy) : Math.abs(x - cx);
        const score = (primary < 0 ? 100000 : 0) + Math.abs(primary) + cross * 2.5;
        if (score < bestScore) { bestScore = score; target = candidate; }
      }
    }
  }
  if (target !== current) { event.preventDefault(); target.focus(); }
}
function screenFocusCandidates(overlay) {
  const candidates = [...overlay.querySelectorAll('a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]')]
    .filter(control => control.tabIndex >= 0 && control.getClientRects().length && getComputedStyle(control).visibility !== 'hidden');
  return candidates.map((control, index) => ({ control, index })).sort((a, b) => {
    const aTab = a.control.tabIndex, bTab = b.control.tabIndex;
    if (aTab > 0 && bTab > 0) return aTab - bTab || a.index - b.index;
    if (aTab > 0) return -1;
    if (bTab > 0) return 1;
    return a.index - b.index;
  }).map(({ control }) => control);
}
const screenHistory = [];
function url(type, name, pose) {
  let a = runtime.program?.assets?.find((x) => x.name === name && x.type === type);
  if (type === 'char') {
    const c = runtime.program?.characters?.find((x) => x.name === name);
    a = c?.poses?.find((x) => x.name === pose) || a;
  }
  return a ? `/asset/${a.path.replace(/^asset[\\/]/, '').replaceAll('\\', '/').split('/').map(encodeURIComponent).join('/')}` : name;
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

function positionSpriteInSlot(sprite, slot, offsetX = 0) {
  const width = Number(playerTheme?.screen?.width) || $('stage')?.clientWidth || 0;
  const spriteWidth = Number.parseFloat(sprite.style.width) || 0;
  const requestedCenter = slot === 'far-left' ? width * 0.08
    : slot === 'left' ? width * 0.26
      : slot === 'right' ? width * 0.74
        : slot === 'far-right' ? width * 0.92 : width * 0.5;
  let center = requestedCenter;
  if (slot === 'far-left') center = Math.max(center, spriteWidth * 0.5);
  else if (slot === 'far-right') center = Math.min(center, width - spriteWidth * 0.5);
  sprite.style.left = slot === 'far-left' || slot === 'far-right' ? `${center}px` : '';
  sprite.style.transform = `translateX(calc(-50% + ${Number(offsetX) || 0}px))`;
}

function setBackgroundSourceSize(element, image) {
  if (!element || !image?.naturalWidth || !image?.naturalHeight) return;
  element.dataset.sourceWidth = String(image.naturalWidth);
  element.dataset.sourceHeight = String(image.naturalHeight);
}

function syncBackgroundCoverage(element = $('background'), offset = visualBackgroundOffset, camera = visualCamera) {
  if (!element) return;
  const stage = $('stage');
  const width = stage?.clientWidth || playerTheme?.screen?.width || 1280;
  const height = stage?.clientHeight || playerTheme?.screen?.height || 720;
  const sourceWidth = Number(element.dataset.sourceWidth) || 0;
  const sourceHeight = Number(element.dataset.sourceHeight) || 0;
  const zoom = Math.max(0.0001, Number(camera.zoom) || 1);
  let scale = 1;
  if (sourceWidth > 0 && sourceHeight > 0) {
    const coverScale = Math.max(width / sourceWidth, height / sourceHeight);
    const coverWidth = sourceWidth * coverScale;
    const coverHeight = sourceHeight * coverScale;
    const focusX = Number(camera.focusX) || 0;
    const focusY = Number(camera.focusY) || 0;
    const visibleLeft = focusX - focusX / zoom;
    const visibleRight = focusX + (width - focusX) / zoom;
    const visibleTop = focusY - focusY / zoom;
    const visibleBottom = focusY + (height - focusY) / zoom;
    const centerX = width / 2, centerY = height / 2;
    const offsetX = Number(offset.x) || 0, offsetY = Number(offset.y) || 0;
    const edgeSafety = 1 + 2 / Math.min(coverWidth, coverHeight);
    const scaleX = Math.max(edgeSafety,
      2 * (centerX + offsetX - visibleLeft) / coverWidth,
      2 * (visibleRight - centerX - offsetX) / coverWidth);
    const scaleY = Math.max(edgeSafety,
      2 * (centerY + offsetY - visibleTop) / coverHeight,
      2 * (visibleBottom - centerY - offsetY) / coverHeight);
    scale = Math.max(scaleX, scaleY);
  }
  element.style.transformOrigin = 'center center';
  element.style.transform = `translate(${Number(offset.x) || 0}px, ${Number(offset.y) || 0}px) scale(${scale})`;
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
  const scaledTarget = target * testPlaybackOutputScale;
  const finish = () => {
    if (bgmAnimationIds.get(audio) !== animationId) return;
    audio.volume = scaledTarget;
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
    audio.volume = initial + (scaledTarget - initial) * progress;
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
    if (type === 'voice') { lastVoiceAsset = name; lastVoiceCharacter = String(operation?.characterId || ''); }
    const a = new Audio(src);
    const kind = type === 'voice' ? 'voice' : 'se';
    const gain = Math.max(0, Math.min(1, Number(operation?.gain ?? 1)));
    const characterId = type === 'voice' ? String(operation?.characterId || '') : '';
    a.dataset.audioKind = kind; a.dataset.userGain = String(gain); a.dataset.voiceCharacter = characterId; activeUiAudio.add(a);
    a.volume = gain * Number(userUiSettings['audio.master'] ?? 1) * testPlaybackOutputScale * settingGain(kind) * (kind === 'voice' ? characterVoiceGain(characterId) : 1);
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
    a.onerror = () => fail(Error('音声の再生に失敗しました。'));
    try { await connectUiAudio(a, kind, gain * (kind === 'voice' ? characterVoiceGain(characterId) : 1)); await a.play(); }
    catch (error) { fail(error); throw error; }
    if (mode === 'blocking') await ended;
  }
}

async function playVideo(name, mode, operation, runtime) {
  const src = url('video', name);
  const previous = $('active-video');
  const video = document.createElement('video');
  const blocksStory = mode !== 'async';
  const previousVisualOnly = $('stage').dataset.visualOnly;
  // Keep the current video until its replacement has actually started. This
  // matches Native, where make_unique constructs the new decoder before the
  // assignment destroys the previous Video.
  if (operation?.actionId) video.dataset.actionId = operation.actionId;
  if (operation?.only) $('stage').dataset.visualOnly = 'video';
  video.src = src;
  video.autoplay = true;
  video.style.position = 'absolute';
  video.style.inset = '0';
  video.style.width = '100%';
  video.style.height = '100%';
  video.style.objectFit = 'contain';
  video.style.opacity = String(operation?.opacity ?? 1);
  if (operation?.layer !== undefined) video.dataset.layer = String(operation.layer);
  if (operation?.visualOrder !== undefined) video.dataset.visualOrder = String(operation.visualOrder);
  if (blocksStory) $('stage').dataset.videoBlocking = 'true';
  $('video-layer').append(video);
  applyRenderLayers(runtime?.sceneState?.layers || activeRenderLayers);
  let resolveEnded, rejectEnded;
  const ended = new Promise((resolve, reject) => { resolveEnded = resolve; rejectEnded = reject; });
  ended.catch(() => {});
  const stopCandidate = (reason) => {
    video.pause();
    video.remove();
    if (blocksStory) delete $('stage').dataset.videoBlocking;
    if (operation?.only) {
      if (previousVisualOnly === undefined) delete $('stage').dataset.visualOnly;
      else $('stage').dataset.visualOnly = previousVisualOnly;
    }
    runtime?.stopAction(operation?.actionId, reason);
  };
  video.onended = () => { video.remove(); if (blocksStory) delete $('stage').dataset.videoBlocking; if (operation?.only && $('stage').dataset.visualOnly === 'video') delete $('stage').dataset.visualOnly; runtime?.completeAction(operation?.actionId); resolveEnded(); };
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
  if (!settingOn('ui.effects')) { element.style.opacity = String(to); runtime?.reportTransitionProgress(actionId, 1); return; }
  const ms = Number(duration);
  if (ms < 0 || !Number.isSafeInteger(ms)) throw Error('演出時間が不正です');
  if (!ms) { element.style.opacity = String(to); runtime?.reportTransitionProgress(actionId, 1); return; }
  const animation = element.animate([{ opacity: from }, { opacity: to }], { duration: ms, easing: 'linear', fill: 'forwards' });
  reportAnimationProgress(animation, runtime, actionId, ms);
  await animation.finished;
  element.style.opacity = String(to);
  animation.cancel();
}
async function transitionBackground(src, operation, runtime, decodedImage = null) {
  const base = $('background');
  const incoming = document.createElement('div');
  incoming.className = 'background-transition-layer';
  incoming.style.cssText = `position:absolute;z-index:0;inset:0;background:center/cover no-repeat url("${src}");pointer-events:none;`;
  const preload = decodedImage || new Image();
  if (!decodedImage) { preload.src = src; await preload.decode(); }
  setBackgroundSourceSize(incoming, preload);
  const transition = operation?.transition || { type: 'instant', durationMs: 0 };
  const duration = settingOn('ui.effects') ? Math.max(0, Number(transition.durationMs) || 0) : 0;
  const type = transition.type || 'instant';
  if (!duration || type === 'instant') {
    base.style.backgroundImage = `url("${src}")`;
    setBackgroundSourceSize(base, preload);
    visualBackgroundOffset = { x: 0, y: 0 };
    syncBackgroundCoverage(base);
    return;
  }
  syncBackgroundCoverage(incoming, { x: 0, y: 0 }, visualCamera);
  $('world').append(incoming);
  const start = performance.now();
  await new Promise(resolve => {
    const tick = now => {
      const t = Math.min(1, (now - start) / duration);
      runtime?.reportTransitionProgress(operation?.actionId, t);
      if (type === 'fade' || type === 'crossfade') incoming.style.opacity = String(t);
      else if (type === 'wipe-left') incoming.style.clipPath = `inset(0 ${(1-t)*100}% 0 0)`;
      else if (type === 'wipe-right') incoming.style.clipPath = `inset(0 0 0 ${(1-t)*100}%)`;
      else if (type === 'wipe-up') incoming.style.clipPath = `inset(0 0 ${(1-t)*100}% 0)`;
      else if (type === 'wipe-down') incoming.style.clipPath = `inset(${(1-t)*100}% 0 0 0)`;
      if (t < 1) requestAnimationFrame(tick); else resolve();
    };
    requestAnimationFrame(tick);
  });
  base.style.backgroundImage = `url("${src}")`;
  setBackgroundSourceSize(base, preload);
  visualBackgroundOffset = { x: 0, y: 0 };
  syncBackgroundCoverage(base);
  incoming.remove();
}
async function animateCamera(operation, runtime) {
  const world = $('world'), camera = operation?.camera;
  if (!camera || !world) return;
  const { from, to, durationMs } = camera;
  const set = t => {
    const zoom = from.zoom + (to.zoom - from.zoom) * t;
    const x = from.focusX + (to.focusX - from.focusX) * t;
    const y = from.focusY + (to.focusY - from.focusY) * t;
    visualCamera = { zoom, focusX: x, focusY: y };
    world.style.transform = 'none';
    world.style.zoom = String(zoom);
    world.style.left = `${zoom ? x * (1 - zoom) / zoom : 0}px`;
    world.style.top = `${zoom ? y * (1 - zoom) / zoom : 0}px`;
    syncBackgroundCoverage();
  };
  if (!durationMs || !settingOn('ui.effects')) { set(1); runtime?.reportTransitionProgress(operation.actionId, 1); return; }
  const start = performance.now();
  await new Promise(resolve => {
    const tick = now => { const t = Math.min(1, (now-start)/durationMs); set(t); runtime?.reportTransitionProgress(operation.actionId,t); if(t<1) requestAnimationFrame(tick); else resolve(); };
    requestAnimationFrame(tick);
  });
}
async function applyEffect(type, color, ms = 500n, runtime, actionId) {
  const overlay = document.createElement('div');
  overlay.className = 'player-effect';
  Object.assign(overlay.style, { position: 'absolute', inset: '0', backgroundColor: color, zIndex: String(layerZIndex(activeRenderLayers.menu, 90000)), pointerEvents: 'none' });
  $('stage').append(overlay);
  try { await fade(overlay, 1, 0, ms, runtime, actionId); } finally { overlay.remove(); }
}
async function moveLayer(operation, runtime) {
  const move = operation?.move;
  if (!move) throw Error('移動操作の情報がありません。');
  const element = move.targetKind === 'bg' ? $('background') : $(`char-${move.target}`);
  if (!element) throw Error(`moveの対象「${move.target}」は表示されていません`);
  if (move.targetKind === 'bg') {
    const apply = progress => {
      visualBackgroundOffset = {
        x: move.fromX + (move.toX - move.fromX) * progress,
        y: move.fromY + (move.toY - move.fromY) * progress,
      };
      syncBackgroundCoverage(element);
      runtime?.reportTransitionProgress(operation.actionId, progress);
    };
    if (!move.durationMs) { apply(1); return; }
    const start = performance.now();
    await new Promise(resolve => {
      const tick = now => {
        const progress = Math.min(1, (now - start) / move.durationMs);
        apply(progress);
        if (progress < 1) requestAnimationFrame(tick); else resolve();
      };
      requestAnimationFrame(tick);
    });
    return;
  }
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

async function command(c, deferAnimation = false) {
  const a = c.args;
  const n = c.name;
  const poseReference = n === 'show' && /^([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(a[0]);
  const showChar = n === 'show' && Boolean(poseReference);

  if (n === 'move') {
    if (deferAnimation) return () => moveLayer(c.operation, c.runtime);
    await moveLayer(c.operation, c.runtime);
  } else if (n === 'bg') {
    const src = url('bg', c.operation?.assetName || a[0]);
    if (deferAnimation) {
      const decodedImage = new Image(); decodedImage.src = src; await decodedImage.decode();
      return () => transitionBackground(src, c.operation, c.runtime, decodedImage);
    }
    await transitionBackground(src, c.operation, c.runtime);
    const sceneBackground = c.runtime?.sceneState?.background;
    $('background').dataset.layer = String(sceneBackground?.layer ?? activeRenderLayers.background);
    applyRenderLayers(c.runtime?.sceneState?.layers || activeRenderLayers);
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
    const actorState = c.runtime?.sceneState?.characters?.[charName];
    if (actorState?.layer !== undefined) e.dataset.layer = String(actorState.layer);
    if (actorState?.visualOrder !== undefined) e.dataset.visualOrder = String(actorState.visualOrder);
    if (deferAnimation && a[transitionIndex] === 'fade') e.style.opacity = '0';
    e.style.bottom = `${-offsetY}px`;
    e.src = url('char', charName, pose);
    await e.decode();
    sizeSpriteLikeNative(e);
    positionSpriteInSlot(e, pos, offsetX);
    const install = () => {
      if (existing) existing.replaceWith(e);
      else $('characters').append(e);
      document.querySelectorAll(`#characters .actor[data-slot="${CSS.escape(pos)}"]`).forEach(actor => {
        if (actor !== e) actor.remove();
      });
      applyRenderLayers(c.runtime?.sceneState?.layers || activeRenderLayers);
    };
    if (deferAnimation) return async () => {
      install();
      if (a[transitionIndex] === 'fade') await fade(e, 0, 1, a[transitionIndex + 1], c.runtime, c.operation?.actionId);
    };
    install();
    if (a[transitionIndex] === 'fade') {
      await fade(e, 0, 1, a[transitionIndex + 1], c.runtime, c.operation?.actionId);
    }
  } else if (n === 'hide') {
    const charName = a[0];
    const fadeOffset = 1;
    const e = $(`char-${charName}`);
    if (deferAnimation && e && a[fadeOffset] === 'fade') return async () => { await fade(e, 1, 0, a[fadeOffset + 1], c.runtime, c.operation?.actionId); e.remove(); };
    if (e && a[fadeOffset] === 'fade') await fade(e, 1, 0, a[fadeOffset + 1], c.runtime, c.operation?.actionId);
    e?.remove();
  } else if (n === 'clear') {
    const target = a[0];
    if (target === 'bg') {
      visualBackgroundOffset = { x: 0, y: 0 };
      $('background').style.backgroundImage = 'none'; $('background').style.transform = '';
      delete $('background').dataset.layer;
      delete $('background').dataset.sourceWidth; delete $('background').dataset.sourceHeight;
    }
    else if (target === 'bgm') {
      stopBgm();
    } else if (target === 'image') $(`image-${a[1]}`)?.remove();
  } else if (n === 'bgm') {
    await media('bgm', a[0], undefined, c.operation, c.runtime);
  } else if (n === 'play') {
    if (a[0] === 'video') await playVideo(c.operation?.assetName || a[1], c.operation?.mode, c.operation, c.runtime);
    else await media(a[0], a[1], c.operation?.mode, c.operation, c.runtime);
  } else if (n === 'dialog') {
    if (a[0] === 'visible') $('dialogue').hidden = c.operation?.visible === false;
    else $('dialogue').style.setProperty('--dialog-opacity', String(c.operation?.dialogOpacity ?? a[1]));
  } else if (n === 'camera') {
    if (deferAnimation) return () => animateCamera(c.operation, c.runtime);
    await animateCamera(c.operation, c.runtime);
  } else if (n === 'layer') {
    applyRenderLayers(c.runtime?.sceneState?.layers || activeRenderLayers);
  } else if (n === 'effect') {
    if (deferAnimation) {
      return async () => {
        const overlay = document.createElement('div');
        overlay.className = 'player-effect';
        Object.assign(overlay.style, { position: 'absolute', inset: '0', backgroundColor: a[1], opacity: '0', zIndex: String(layerZIndex(activeRenderLayers.menu, 90000)), pointerEvents: 'none' });
        $('stage').append(overlay);
        overlay.style.opacity = '1';
        try { await fade(overlay, 1, 0, a[2] ?? 500n, c.runtime, c.operation?.actionId); } finally { overlay.remove(); }
      };
    }
    await applyEffect(a[0], a[1], a[2], c.runtime, c.operation?.actionId);
  } else if (n === 'show' && a[0] === 'image') {
    const imgName = a[1];
    const pos = slotClass(a[2]);
    const existing = $(`image-${imgName}`);
    const e = document.createElement('img');
    e.id = `image-${imgName}`;
    e.className = `image ${pos}`;
    e.dataset.slot = pos;
    const imageState = c.runtime?.sceneState?.images?.[imgName];
    if (imageState?.layer !== undefined) e.dataset.layer = String(imageState.layer);
    if (imageState?.visualOrder !== undefined) e.dataset.visualOrder = String(imageState.visualOrder);
    e.src = url('image', c.operation?.assetName || imgName);
    await e.decode();
    sizeSpriteLikeNative(e);
    positionSpriteInSlot(e, pos);
    existing?.remove();
    $('images').append(e);
    applyRenderLayers(c.runtime?.sceneState?.layers || activeRenderLayers);
  }
}
// The whole dialogue panel is the advance target. Choices keep their own click behavior.
$('dialogue').addEventListener('click', (event) => {
  if (event.target.closest('#choices, .choice, #next')) return;
  if (activeTextReveal) { activeTextReveal(); return; }
  $('next').click();
});
$('next').addEventListener('click', () => activeTextReveal?.());
window.addEventListener('keydown', (event) => {
  if (/^F(?:[1-9]|1[0-2])$/.test(event.key) && (gameStarted || activeGameScreen) && !$('stage').dataset.videoBlocking) {
    event.preventDefault();
    activeTextReveal?.();
    const binding = userUiSettings[`ui.shortcut.${event.key}`] ?? gameScreenConfig?.controlDefaults?.[`ui.shortcut.${event.key}`] ?? 'none';
    switch (binding) {
      case 'system': if (gameScreenConfig?.screens?.system) showGameScreen('system'); break;
      case 'save': openSlotScreen('save'); break;
      case 'load': openSlotScreen('load'); break;
      case 'replay-voice': if (lastVoiceAsset) void media('voice', lastVoiceAsset, 'async', { characterId: lastVoiceCharacter }, runtime); break;
      case 'auto': if (gameStarted) void activateGameScreenAction('auto'); break;
      case 'clear-text': $('text').textContent = ''; break;
      case 'fullscreen': updateUiSetting('ui.fullscreen', !settingOn('ui.fullscreen')); break;
      case 'skip': if (gameStarted) void activateGameScreenAction('skip'); break;
      case 'quick-save': if (gameStarted) void saveQuickGame(); break;
      case 'history': if (gameScreenConfig?.screens?.log) showGameScreen('log'); break;
      case 'quick-load': if (gameStarted) void loadQuickGame(); break;
      default: break;
    }
    return;
  }
  if ((event.code === 'Space' || event.code === 'Enter') && gameStarted && !activeGameScreen && !event.repeat && !event.target.closest('button,input')) {
    event.preventDefault();
    if (activeTextReveal) activeTextReveal(); else $('next').click();
    return;
  }
  if (event.key !== 'Escape' || !gameStarted || !gameScreenConfig?.screens?.pause) return;
  if (activeGameScreen) {
    if (activeGameScreen === 'pause') {
      event.preventDefault();
      $('screen-overlay').hidden = true; setActiveGameScreen(null); screenHistory.length = 0;
    } else if (screenHistory.length) {
      event.preventDefault();
      showGameScreen(screenHistory.pop(), { push: false });
    }
    return;
  }
  event.preventDefault(); activeTextReveal?.(); pausePlaybackModes(); showGameScreen('pause', { push: false });
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
    const file = instruction.file || rt.program?.sourceFile || '';
    const line = Number(instruction.line) || 0;
    const key = `${file}:${line}`;
    const previouslySeen = seenSayLines.has(key);
    currentExecution = {
      file,
      scene: rt.currentSceneName || '',
      line,
      previouslySeen,
      key,
    };
    return reportDebugLocation(instruction, rt);
  },
  async parallel(items, rt) {
    const start = [];
    for (const item of items) {
      const begin = await command({ name: item.name, args: item.args, operation: item.operation, runtime: rt }, true);
      if (typeof begin !== 'function') throw Error(`命令「${item.name}」は並列の画面演出として実行できません`);
      start.push(begin);
    }
    await Promise.all(start.map(begin => begin()));
  },
  async command(name, args, rt, operation) {
    if (name === 'say') {
      let speaker = args[0] === 'none' || args[0] === 'narrator' ? '' : args[0];
      if (speaker) {
        try { speaker = rt.get(speaker)?.name || speaker; } catch {}
      }
      $('speaker-text').textContent = speaker;
      const fullText = await rt.textAsync(args[1]);
      dialogueHistory.push({ speaker, text: fullText });
      if (dialogueHistory.length > 500) dialogueHistory.shift();
      if (currentExecution?.key) seenSayLines.add(currentExecution.key);
      if (skipActive) {
        const skipAllowed = !settingOn('ui.skipUnseen') || currentExecution?.previouslySeen;
        if (skipAllowed) { $('text').textContent = fullText; return; }
        skipActive = false;
      }
      await revealDialogueText(fullText);
      $('text').scrollTop = 0;
      const restoreOpacity = rt.sceneState.ui?.dialogOpacity ?? playerTheme?.dialog?.opacity ?? 1;
      if (operation?.dialogOpacityTemporary) applyDialogOpacity(operation.dialogOpacity);
      try { await new Promise(resolve => {
        clearAutoAdvance();
        $('next').onclick = () => { if (holdActive) return; clearAutoAdvance(); $('next').onclick = null; resolve(); };
        if (autoPlayActive) autoAdvanceTimer = setTimeout(() => $('next').click(), autoAdvanceDelay());
      }); }
      finally { if (operation?.dialogOpacityTemporary) applyDialogOpacity(restoreOpacity); }
    } else if (name === 'wait') {
      if (args[0] < 0n || args[0] > 2147483647n) throw Error('待機時間が不正です');
      await new Promise(resolve => setTimeout(resolve, Number(args[0])));
    } else await command({ name, args, operation, runtime: rt });
  },
  async start() {
    if (!gameScreenConfig?.screens?.[gameScreenConfig.initial]) throw Error('start()を使うには開始画面を設定してください');
    await new Promise((resolve, reject) => {
      startWaitResolve = resolve;
      try { showGameScreen(gameScreenConfig.initial, { push: false }); }
      catch (error) {
        if (startWaitResolve === resolve) startWaitResolve = null;
        reject(error);
      }
    });
  },
  sceneState(state, event) {
    document.body.dataset.sceneRevision = String(state.revision);
    const applyVisualOnly = () => {
    const only = state.visualOnly;
    document.querySelectorAll('#characters .visual-only-target,#images .visual-only-target').forEach((element) => element.classList.remove('visual-only-target'));
    if (only?.kind) {
      document.querySelector('#stage').dataset.visualOnly = only.kind;
      document.querySelector('#stage').dataset.visualOnlyId = only.id || only.asset || '';
      if (only.kind === 'character' || only.kind === 'image') document.getElementById(`${only.kind === 'character' ? 'char' : 'image'}-${only.id}`)?.classList.add('visual-only-target');
    } else {
      delete document.querySelector('#stage').dataset.visualOnly;
      delete document.querySelector('#stage').dataset.visualOnlyId;
    }
    };
    if (event?.name === 'restore') return restorePlayerState(state, runtime).then(applyVisualOnly);
    applyVisualOnly();
  },
  choice(prompt, labels) {
    $('text').textContent = prompt;
    $('choices').replaceChildren();
    return new Promise(resolve => labels.forEach((label, index) => {
      const button = makeChoice(label, index);
      button.onclick = () => {
        if (autoPlayActive && settingOn('ui.autoAfterChoice')) autoPlayActive = false;
        if (skipActive && settingOn('ui.skipAfterChoice')) skipActive = false;
        clearAutoAdvance(); $('choices').replaceChildren(); resolve(index);
      };
      $('choices').append(button);
    }));
  }
});
let launchName = '';
let scenarioLaunchName = '';
let launchVariables = Object.create(null);
let launchDebug = null;
async function restorePlayerState(state, rt) {
  const bg = state.background;
  applyDialogOpacity(state.ui?.dialogOpacity ?? playerTheme?.dialog?.opacity ?? 1);
  $('dialogue').hidden = state.ui?.dialogVisible === false;
  const camera = state.camera || { zoom: 1, focusX: 640, focusY: 360 };
  visualCamera = { zoom: Number(camera.zoom ?? 1), focusX: Number(camera.focusX ?? 640), focusY: Number(camera.focusY ?? 360) };
  const world = $('world'), zoom = visualCamera.zoom;
  world.style.transform = 'none'; world.style.zoom = String(zoom);
  world.style.left = `${zoom ? visualCamera.focusX * (1 - zoom) / zoom : 0}px`;
  world.style.top = `${zoom ? visualCamera.focusY * (1 - zoom) / zoom : 0}px`;
  applyRenderLayers(state.layers || playerTheme?.layers || DEFAULT_RENDER_LAYERS);
  const backgroundElement = $('background');
  if (bg?.layer !== undefined) backgroundElement.dataset.layer = String(bg.layer); else delete backgroundElement.dataset.layer;
  visualBackgroundOffset = { x: Number(bg?.offsetX) || 0, y: Number(bg?.offsetY) || 0 };
  backgroundElement.style.backgroundImage = bg?.asset ? `url("${url('bg', bg.asset)}")` : 'none';
  if (bg?.asset) {
    const source = new Image(); source.src = url('bg', bg.asset);
    try { await source.decode(); setBackgroundSourceSize(backgroundElement, source); } catch {}
  }
  syncBackgroundCoverage(backgroundElement);
  $('characters').replaceChildren(); $('images').replaceChildren();
  for (const character of Object.values(state.characters || {})) {
    if (!character.visible) continue;
    const sprite = document.createElement('img');
    sprite.id = `char-${character.id}`; sprite.className = `actor ${slotClass(character.slot)}`; sprite.dataset.slot = slotClass(character.slot);
    sprite.style.bottom = `${-(Number(character.offsetY) || 0)}px`; sprite.style.opacity = String(Number(character.opacity ?? 1));
    if (character.layer !== undefined) sprite.dataset.layer = String(character.layer);
    sprite.dataset.visualOrder = String(Number(character.visualOrder) || 0); sprite.src = url('char', character.id, character.pose);
    $('characters').append(sprite);
    try { await sprite.decode(); sizeSpriteLikeNative(sprite); } catch {}
    positionSpriteInSlot(sprite, slotClass(character.slot), Number(character.offsetX) || 0);
  }
  for (const [name, image] of Object.entries(state.images || {})) {
    const sprite = document.createElement('img'); sprite.id = `image-${name}`; sprite.className = `image ${slotClass(image.slot)}`; sprite.dataset.slot = slotClass(image.slot);
    if (image.layer !== undefined) sprite.dataset.layer = String(image.layer);
    sprite.dataset.visualOrder = String(Number(image.visualOrder) || 0);
    sprite.src = url('image', image.asset || name); $('images').append(sprite);
    try { await sprite.decode(); sizeSpriteLikeNative(sprite); } catch {}
    positionSpriteInSlot(sprite, slotClass(image.slot), Number(image.offsetX) || 0);
  }
  applyRenderLayers(state.layers || playerTheme?.layers || DEFAULT_RENDER_LAYERS);
  const bgm = state.audio?.bgm;
  stopBgm();
  if (bgm?.asset) {
    const audio = $('bgm'); audio.loop = true; audio.dataset.audioKind = 'bgm'; audio.dataset.userGain = String(Number(bgm.gain ?? 1)); activeUiAudio.add(audio); audio.src = url('bgm', bgm.asset); audio.volume = Number(bgm.gain ?? 1);
    try { await connectBgmAudio(audio, audio.volume); await audio.play(); bgmLayers.add(audio); applyUiAudioMix(); }
    catch { /* Audio may remain blocked until the next input after a reload. */ }
  }
  document.body.dataset.sceneRevision = String(state.revision || 0);
}
async function launchGame(source = launchName || scenarioLaunchName, debug = launchDebug) {
  if (gameStarted) return;
  gameStarted = true;
  resetCursorHideTimer();
  let completed = false;
  try {
    runtime.globals = Object.create(null);
    runtime.frames = [runtime.globals];
    await runtime.run(await loadScene(source), debug);
    completed = true;
  } finally {
    gameStarted = false;
    resetCursorHideTimer();
  }
  if (completed) {
    reportDebug('novel-debug:done');
    if (!debugSession) {
      stopBgm();
      $('speaker-text').textContent = '';
      $('text').textContent = '';
      $('choices').replaceChildren();
      $('characters').replaceChildren();
      $('images').replaceChildren();
      $('background').style.backgroundImage = 'none';
      currentExecution = null;
    }
  }
}
(async () => {
  const ui = await (await fetch('/api/player-ui')).json();
  applyPlayerUi(ui.path, ui.theme);
  if (uiPreviewMode) {
    $('speaker-text').textContent = '妹';
    $('text').textContent = 'おはよう。もう起きてたんだ？\n今日はいつもより少し早く出かけよう。';
    $('choices').replaceChildren(
      makeChoice('朝食を食べてから出かける', 0),
      makeChoice('急いで支度をする', 1),
      makeChoice('窓の外を少し眺める', 2),
    );
    try {
      const imageData = await (await fetch('/api/ui-assets')).json();
      const images = imageData.images || [];
      const assetUrl = value => '/asset/' + String(value || '').replaceAll('\\', '/').replace(/^asset\//i, '').split('/').map(encodeURIComponent).join('/');
      const background = images.find(value => /^bg\//i.test(value));
      if (background) $('background').style.backgroundImage = `url("${assetUrl(background)}")`;
    } catch { /* A project without indexed artwork still previews the real UI renderer. */ }
    window.parent.postMessage({ type: 'novel-ui-preview:ready' }, location.origin);
    return;
  }
  runtime.configurePresentationDefaults(ui.theme);
  const settings = await (await fetch('/api/scene-config')).json();
  launchName = debugParams.get('source') || settings.start_file;
  scenarioLaunchName = launchName;
  const projectInfo = await (await fetch('/api/project')).json();
  saveStoragePrefix = `novel-script:${encodeURIComponent(projectInfo.projectRoot || location.origin)}:${debugSession ? 'test' : 'game'}`;
  const variables = launchVariables;
  if (debugSession) {
    const supplied = JSON.parse(debugParams.get('variables') || '{}');
    for (const [key, entry] of Object.entries(supplied)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw Error(`debug variable 名が正しくありません: ${key}`);
      if (entry?.type === 'int' && typeof entry.value === 'string') variables[key] = NovelRuntime.integer(entry.value);
      else if (entry?.type === 'float' && typeof entry.value === 'string') variables[key] = NovelRuntime.floating(entry.value);
      else if (entry?.type === 'str' && typeof entry.value === 'string') variables[key] = entry.value;
      else if (entry?.type === 'bool' && ['true', 'false'].includes(entry.value)) variables[key] = entry.value === 'true';
      else if (/^list<(int|float|str|bool)>$/.test(entry?.type || '')) {
        const source = JSON.parse(entry.value);
        if (!Array.isArray(source)) throw Error(`debug list が正しくありません: ${key}`);
        const elementType = entry.type.slice(5, -1);
        variables[key] = source.map((value) => {
          if (elementType === 'int' && (Number.isSafeInteger(value) || typeof value === 'string' && /^[+-]?\d+$/.test(value))) return NovelRuntime.integer(value);
          if (elementType === 'float' && (typeof value === 'number' || typeof value === 'string')) return NovelRuntime.floating(value);
          if (elementType === 'str' && typeof value === 'string') return value;
          if (elementType === 'bool' && typeof value === 'boolean') return value;
          throw Error(`debug list の要素typeが正しくありません: ${key}`);
        });
      }
      else if (entry?.type === 'dict<int>' || entry?.type === 'dict<float>' || entry?.type === 'dict<str>' || entry?.type === 'dict<bool>') {
        const source = JSON.parse(entry.value);
        if (!source || typeof source !== 'object' || Array.isArray(source)) throw Error(`debug dictionary が正しくありません: ${key}`);
        const dictionary = Object.create(null);
        for (const [field, value] of Object.entries(source)) {
          if (entry.type === 'dict<int>') dictionary[field] = NovelRuntime.integer(value);
          else if (entry.type === 'dict<float>') dictionary[field] = NovelRuntime.floating(value);
          else if (entry.type === 'dict<bool>' && typeof value === 'boolean') dictionary[field] = value;
          else if (typeof value === 'string') dictionary[field] = value;
          else throw Error(`debug dictionary の要素typeが正しくありません: ${key}.${field}`);
        }
        variables[key] = dictionary;
      } else if (entry?.type === 'struct') {
        const source = JSON.parse(entry.value);
        const fields = entry.fields;
        if (!source || typeof source !== 'object' || Array.isArray(source) || !fields || typeof fields !== 'object' || Object.keys(source).length !== Object.keys(fields).length) throw Error(`debug struct が正しくありません: ${key}`);
        const structure = Object.create(null);
        for (const [field, type] of Object.entries(fields)) {
          if (!Object.hasOwn(source, field)) throw Error(`debug struct にfieldがありません: ${field}`);
          if (type === 'int') structure[field] = NovelRuntime.integer(source[field]);
          else if (type === 'float') structure[field] = NovelRuntime.floating(source[field]);
          else if (type === 'str' && typeof source[field] === 'string') structure[field] = source[field];
          else if (type === 'bool' && typeof source[field] === 'boolean') structure[field] = source[field];
          else throw Error(`debug struct のfieldが正しくありません: ${field}`);
        }
        variables[key] = structure;
      } else throw Error(`未対応のdebug variable typeです: ${key}`);
    }
  }
  const debugLineText = debugParams.get('line');
  let debugLine;
  if (debugSession && debugLineText !== null) {
    if (!/^\d+$/.test(debugLineText)) throw Error('debug line は0以上の整数で指定してください');
    debugLine = Number(debugLineText);
    if (!Number.isSafeInteger(debugLine)) throw Error('debug line が整数の有効範囲外です');
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
  await Promise.all(Array.from({ length: 120 }, async (_, index) => {
    const encoded = await saveStore.readSlot(index);
    if (encoded === null) return;
    try {
      const saved = decodeSave(encoded);
      if (!isLoadableSave(saved)) {
        const incompatibleVersion = saved && typeof saved === 'object' && !Array.isArray(saved)
          && Number.isSafeInteger(saved.version) && saved.version !== 1;
        const incompatibleSaveId = saved && typeof saved === 'object' && !Array.isArray(saved)
          && typeof saved.saveId === 'string' && saved.saveId !== '' && saved.saveId !== (gameScreenConfig.saveId || '');
        saveSlotStates.set(index, incompatibleVersion || incompatibleSaveId ? 'incompatible' : 'corrupt');
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
      const rawResume = sessionStorage.getItem(`${saveStoragePrefix}:resume`) || localStorage.getItem(`${saveStoragePrefix}:resume`);
      sessionStorage.removeItem(`${saveStoragePrefix}:resume`);
      if (rawResume) localStorage.removeItem(`${saveStoragePrefix}:resume`);
      if (slotPointer !== null || rawResume) {
        const savedResume = slotPointer !== null && /^\d+$/.test(slotPointer) ? readSaveSlot(Number(slotPointer)) : decodeSave(rawResume);
        if (isLoadableSave(savedResume)) {
          launchName = savedResume.file;
          launchDebug = { file: savedResume.file, scene: savedResume.scene, line: savedResume.line, variables: savedResume.variables || {}, locals: savedResume.locals || [], readonlyLocals: savedResume.readonlyLocals || [], sceneState: savedResume.sceneState };
          $('text').textContent = String(savedResume.text || ''); $('speaker-text').textContent = String(savedResume.speaker || '');
        }
      }
    } catch {}
  }
  if (!debugSession) gameStartHandler = () => launchGame(scenarioLaunchName, null);
  await launchGame();
})().catch(error => { $('speaker-text').textContent = 'Runtime Error'; $('text').textContent = error.message; $('choices').replaceChildren(); reportDebug('novel-debug:error', { error: error.message }); });
