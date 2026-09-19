'use strict';
const $ = id => document.getElementById(id);
function uiAsset(themePath, image) {
  const directory = themePath.replaceAll('\\', '/').split('/').slice(0, -1);
  return '/asset/' + [...directory, image].map(encodeURIComponent).join('/');
}
function applyPlayerUi(themePath, theme) {
  const { screen, dialog, choices } = theme;
  const stage = $('stage'), dialogue = $('dialogue'), speaker = $('speaker'), text = $('text'), choiceBox = $('choices');
  stage.style.width = `${screen.width}px`; stage.style.height = `${screen.height}px`;
  Object.assign(dialogue.style, { left: `${dialog.x}px`, top: `${dialog.y}px`, right: 'auto', bottom: 'auto', width: `${dialog.width}px`, height: `${dialog.height}px`, minHeight: '0', padding: '0', border: '0', borderRadius: '0', background: `url("${uiAsset(themePath, dialog.image)}") center / 100% 100% no-repeat` });
  Object.assign(text.style, { position: 'absolute', left: `${dialog.message.x}px`, top: `${dialog.message.y}px`, width: `${dialog.message.width}px`, height: `${dialog.message.height}px`, overflow: 'hidden', fontSize: `${dialog.message.size}px`, color: `rgba(${dialog.message.color.join(',')})` });
  Object.assign(speaker.style, { position: 'absolute', display: 'grid', placeItems: 'center', left: `${dialog.nameplate.x}px`, top: `${dialog.nameplate.y}px`, width: `${dialog.nameplate.width}px`, height: `${dialog.nameplate.height}px`, color: `rgba(${dialog.nameplate.text.color.join(',')})`, fontSize: `${dialog.nameplate.text.size}px`, background: `url("${uiAsset(themePath, dialog.nameplate.image)}") center / 100% 100% no-repeat` });
  Object.assign(choiceBox.style, { position: 'absolute', left: `${choices.x - dialog.x}px`, top: `${choices.y - dialog.y}px`, width: `${choices.width}px`, height: `${choices.height}px`, overflowY: 'auto' });
}
function url(type, name, pose) {
  let a = runtime.program?.assets?.find((x) => x.name === name && x.type === type);
  if (type === 'char') {
    const c = runtime.program?.characters?.find((x) => x.name === name);
    a = c?.poses?.find((x) => x.name === pose) || a;
  }
  return a ? `/asset/${a.path.replace(/^assets?[\\/]/, '').replaceAll('\\', '/')}` : name;
}

async function media(type, name) {
  const src = url(type, name);
  if (type === 'bgm') {
    const a = $('bgm');
    if (a.src !== location.origin + src) a.src = src;
    await a.play();
  } else {
    const a = new Audio(src);
    await a.play();
    a.onended = () => a.remove();
  }
}

async function playVideo(name, mode) {
  const src = url('video', name);
  const video = document.createElement('video');
  video.id = 'active-video';
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
      video.onended = () => { video.remove(); resolve(); };
      video.onerror = () => { video.remove(); reject(Error('動画の読み込みに失敗しました')); };
      video.play().catch(reject);
    });
  } else {
    video.onended = () => video.remove();
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
    const pos = a[1];
    const pose = poseReference[2];
    const fadeOffset = 2;
    const existing = $(`char-${charName}`);
    const e = existing || Object.assign(document.createElement('img'), { id: `char-${charName}` });
    e.className = `actor ${pos}`;
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
    await media('bgm', a[0]);
  } else if (n === 'play') {
    if (a[0] === 'video') await playVideo(a[1], a[2]);
    else await media(a[0], a[1]);
  } else if (n === 'effect') {
    await applyEffect(a[0], a[1], a[2]);
  } else if (n === 'show' && a[0] === 'image') {
    const imgName = a[1];
    const pos = a[2];
    const e = $(`image-${imgName}`) || document.createElement('img');
    e.id = `image-${imgName}`;
    e.className = `image ${pos}`;
    e.src = url('image', imgName);
    await e.decode();
    $('images').append(e);
  }
}


async function loadScene(name) {
  const response = await fetch(`/api/scene?name=${encodeURIComponent(name)}`);
  const scene = await response.json();
  if (!response.ok) throw Error(scene.error);
  const compiled = await fetch('/api/compile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: scene.name || name, source: scene.source }),
  });
  const result = await compiled.json();
  if (!result.ok) throw Error(result.error);
  return result.program;
}
const runtime = new NovelRuntime.Runtime({
  load: loadScene,
  async command(name, args, rt) {
    if (name === 'say') {
      let speaker = args[0] === 'none' || args[0] === 'narrator' ? '' : args[0];
      if (speaker) {
        try { speaker = rt.get(speaker)?.name || speaker; } catch {}
      }
      $('speaker').textContent = speaker;
      $('text').textContent = await rt.textAsync(args[1]);
      await new Promise(resolve => { $('next').onclick = () => { $('next').onclick = null; resolve(); }; });
    } else if (name === 'wait') {
      if (args[0] < 0n || args[0] > 2147483647n) throw Error('待機時間が不正です');
      await new Promise(resolve => setTimeout(resolve, Number(args[0])));
    } else await command({ name, args });
  },
  choice(prompt, labels) {
    $('text').textContent = prompt;
    $('choices').replaceChildren();
    return new Promise(resolve => labels.forEach((label, index) => {
      const button = document.createElement('button'); button.className = 'choice'; button.textContent = label;
      button.onclick = () => { $('choices').replaceChildren(); resolve(index); };
      $('choices').append(button);
    }));
  }
});
(async () => {
  const ui = await (await fetch('/api/player-ui')).json();
  applyPlayerUi(ui.path, ui.theme);
  const settings = await (await fetch('/api/scene-config')).json();
  const name = new URLSearchParams(location.search).get('source') || settings.start_scene || 'main.tds';
  await runtime.run(await loadScene(name));
})().catch(error => { $('speaker').textContent = 'PLAYER ERROR'; $('text').textContent = error.message; $('choices').replaceChildren(); });
