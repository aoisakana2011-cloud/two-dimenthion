'use strict';
const $ = id => document.getElementById(id);
let playerTheme = null;
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
  Object.assign(dialogue.style, { left: `${dialog.x}px`, top: `${dialog.y}px`, right: 'auto', bottom: 'auto', width: `${dialog.width}px`, height: `${dialog.height}px`, minHeight: '0', padding: '0', border: dialog.image ? '0' : '1px solid #8ab8d8', borderRadius: dialog.image ? '0' : '12px', background: uiBackground(themePath, dialog.image, '#07111ddd') });
  Object.assign(text.style, { position: 'absolute', left: `${dialog.message.x}px`, top: `${dialog.message.y}px`, width: `${dialog.message.width}px`, height: `${dialog.message.height}px`, overflowX: 'hidden', overflowY: 'auto', fontSize: `${dialog.message.size}px`, color: `rgba(${dialog.message.color.join(',')})` });
  Object.assign(speaker.style, { position: 'absolute', display: 'grid', placeItems: 'center', left: `${dialog.nameplate.x}px`, top: `${dialog.nameplate.y}px`, width: `${dialog.nameplate.width}px`, height: `${dialog.nameplate.height}px`, color: `rgba(${dialog.nameplate.text.color.join(',')})`, fontSize: `${dialog.nameplate.text.size}px`, background: uiBackground(themePath, dialog.nameplate.image, '#1d344dcc'), borderRadius: dialog.nameplate.image ? '0' : '6px' });
  Object.assign(speakerText.style, { position: 'absolute', left: `${dialog.nameplate.text.x || 0}px`, top: `${dialog.nameplate.text.y || 0}px`, width: `${dialog.nameplate.text.width}px`, height: `${dialog.nameplate.text.height}px`, display: 'grid', placeItems: 'center', overflow: 'hidden' });
  Object.assign(choiceBox.style, { position: 'absolute', left: `${choices.x - dialog.x}px`, top: `${choices.y - dialog.y}px`, width: `${choices.width}px`, height: `${choices.height}px`, overflowY: 'auto', overflowX: 'hidden' });
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
  window.addEventListener('resize', fitStage);
  window.visualViewport?.addEventListener('resize', fitStage);
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

async function media(type, name, mode, operation, runtime) {
  const src = url(type, name);
  if (type === 'bgm') {
    const a = $('bgm');
    if (a.src !== location.origin + src) a.src = src;
    await a.play();
  } else {
    const a = new Audio(src);
    let resolveEnded;
    const ended = new Promise(resolve => { resolveEnded = resolve; });
    a.onended = () => { a.remove(); runtime?.completeAction(operation?.actionId); resolveEnded(); };
    await a.play();
    if (mode === 'blocking') await ended;
  }
}

async function playVideo(name, mode, operation, runtime) {
  const src = url('video', name);
  const previous = $('active-video');
  if (previous) {
    const previousAction = previous.dataset.actionId;
    previous.pause();
    previous.remove();
    runtime?.stopAction(previousAction, 'replaced');
  }
  const video = document.createElement('video');
  video.id = 'active-video';
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
  if (mode === 'blocking') {
    await new Promise((resolve, reject) => {
      video.onended = () => { video.remove(); runtime?.completeAction(operation?.actionId); resolve(); };
      video.onerror = () => { video.remove(); reject(Error('動画の読み込みに失敗しました')); };
      video.play().catch(reject);
    });
  } else {
    video.onended = () => { video.remove(); runtime?.completeAction(operation?.actionId); };
    await video.play();
  }
}

async function fade(element, from, to, duration = 500n) {
  const ms = Number(duration);
  if (ms < 0 || !Number.isSafeInteger(ms)) throw Error('演出時間が不正です');
  if (!ms) { element.style.opacity = String(to); return; }
  const animation = element.animate([{ opacity: from }, { opacity: to }], { duration: ms, fill: 'forwards' });
  await animation.finished;
  element.style.opacity = String(to);
  animation.cancel();
}
async function applyEffect(type, color, ms = 500n) {
  const overlay = document.createElement('div');
  Object.assign(overlay.style, { position: 'absolute', inset: '0', backgroundColor: color, zIndex: '50', pointerEvents: 'none' });
  $('stage').append(overlay);
  try { await fade(overlay, 1, 0, ms); } finally { overlay.remove(); }
}

async function command(c) {
  const a = c.args;
  const n = c.name;
  const poseReference = n === 'show' && /^([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(a[0]);
  const showChar = n === 'show' && Boolean(poseReference);

  if (n === 'bg') {
    const src = url('bg', a[0]);
    const preload = new Image(); preload.src = src; await preload.decode();
    $('background').style.backgroundImage = `url("${src}")`;
  } else if (showChar) {
    const charName = poseReference[1];
    const pos = slotClass(a[1]);
    const pose = poseReference[2];
    const fadeOffset = 2;
    document.querySelectorAll(`#characters .actor[data-slot="${CSS.escape(pos)}"]`).forEach(actor => {
      if (actor.id !== `char-${charName}`) actor.remove();
    });
    const existing = $(`char-${charName}`);
    const e = existing || Object.assign(document.createElement('img'), { id: `char-${charName}` });
    e.className = `actor ${pos}`;
    e.dataset.slot = pos;
    e.src = url('char', charName, pose);
    await e.decode();
    if (!e.parentNode) $('characters').append(e);
    if (showChar && a[fadeOffset] === 'fade') await fade(e, 0, 1, a[fadeOffset + 1]);
  } else if (n === 'hide') {
    const charName = a[0];
    const fadeOffset = 1;
    const e = $(`char-${charName}`);
    if (e && a[fadeOffset] === 'fade') await fade(e, 1, 0, a[fadeOffset + 1]);
    e?.remove();
  } else if (n === 'clear') {
    const target = a[0];
    if (target === 'bg') $('background').style.backgroundImage = 'none';
    else if (target === 'bgm') {
      const bgm = $('bgm');
      bgm.pause();
      bgm.removeAttribute('src');
    } else if (target === 'image') $(`image-${a[1]}`)?.remove();
  } else if (n === 'bgm') {
    await media('bgm', a[0], undefined, c.operation, c.runtime);
  } else if (n === 'play') {
    if (a[0] === 'video') await playVideo(a[1], a[2], c.operation, c.runtime);
    else await media(a[0], a[1], a[2], c.operation, c.runtime);
  } else if (n === 'effect') {
    await applyEffect(a[0], a[1], a[2]);
  } else if (n === 'show' && a[0] === 'image') {
    const imgName = a[1];
    const pos = slotClass(a[2]);
    const e = $(`image-${imgName}`) || document.createElement('img');
    e.id = `image-${imgName}`;
    e.className = `image ${pos}`;
    e.dataset.slot = pos;
    e.src = url('image', imgName);
    await e.decode();
    $('images').append(e);
  }
}
// The whole dialogue panel is the advance target. Choices keep their own click behavior.
$('dialogue').addEventListener('click', (event) => {
  if (event.target.closest('#choices, .choice, #next')) return;
  $('next').click();
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
    const timer = setTimeout(() => { debugAcks.delete(step); resolve(); }, 5000);
    debugAcks.set(step, () => { clearTimeout(timer); debugAcks.delete(step); resolve(); });
  });
}
const runtime = new NovelRuntime.Runtime({
  load: loadScene,
  beforeInstruction(instruction, rt) {
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
      await new Promise(resolve => { $('next').onclick = () => { $('next').onclick = null; resolve(); }; });
    } else if (name === 'wait') {
      if (args[0] < 0n || args[0] > 2147483647n) throw Error('待機時間が不正です');
      await new Promise(resolve => setTimeout(resolve, Number(args[0])));
    } else await command({ name, args, operation, runtime: rt });
  },
  sceneState(state) {
    document.body.dataset.sceneRevision = String(state.revision);
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
(async () => {
  const ui = await (await fetch('/api/player-ui')).json();
  applyPlayerUi(ui.path, ui.theme);
  const settings = await (await fetch('/api/scene-config')).json();
  const name = debugParams.get('source') || settings.start_file;
  const variables = Object.create(null);
  if (debugSession) {
    const supplied = JSON.parse(debugParams.get('variables') || '{}');
    for (const [key, entry] of Object.entries(supplied)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw Error(`Invalid debug variable: ${key}`);
      if (entry?.type === 'int') variables[key] = NovelRuntime.integer(entry.value);
      else if (entry?.type === 'str') variables[key] = String(entry.value);
      else if (entry?.type === 'dict<int>' || entry?.type === 'dict<str>') {
        const source = JSON.parse(entry.value);
        if (!source || typeof source !== 'object' || Array.isArray(source)) throw Error(`Invalid debug dictionary: ${key}`);
        const dictionary = Object.create(null);
        for (const [field, value] of Object.entries(source)) dictionary[field] = entry.type === 'dict<int>' ? NovelRuntime.integer(value) : String(value);
        variables[key] = dictionary;
      } else if (entry?.type === 'struct') {
        const source = JSON.parse(entry.value);
        const fields = entry.fields;
        if (!source || typeof source !== 'object' || Array.isArray(source) || !fields || typeof fields !== 'object' || Object.keys(source).length !== Object.keys(fields).length) throw Error(`Invalid debug structure: ${key}`);
        const structure = Object.create(null);
        for (const [field, type] of Object.entries(fields)) {
          if (!Object.hasOwn(source, field)) throw Error(`Missing debug structure field: ${field}`);
          if (type === 'int') structure[field] = NovelRuntime.integer(source[field]);
          else if (type === 'str' && typeof source[field] === 'string') structure[field] = source[field];
          else throw Error(`Invalid debug structure field: ${field}`);
        }
        variables[key] = structure;
      } else throw Error(`Unsupported debug variable type: ${key}`);
    }
  }
  const line = Number(debugParams.get('line'));
  await runtime.run(await loadScene(name), debugSession ? { scene: debugParams.get('scene') || undefined, line: Number.isSafeInteger(line) && line > 0 ? line : undefined, variables } : null);
  reportDebug('novel-debug:done');
})().catch(error => { $('speaker-text').textContent = 'PLAYER ERROR'; $('text').textContent = error.message; $('choices').replaceChildren(); reportDebug('novel-debug:error', { error: error.message }); });
