'use strict';
const $ = id => document.getElementById(id);
function url(type, name, pose) {
  let a = runtime.program?.assets?.find((x) => x.name === name && x.type === type);
  if (type === 'char') {
    const c = runtime.program?.characters?.find((x) => x.name === name);
    a = c?.poses?.find((x) => x.name === pose) || a;
  }
  return a ? `/assets/${a.path.replace(/^assets[\\/]/, '').replaceAll('\\', '/')}` : name;
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
  const showChar = n === 'show' && a[0] === 'char';

  if (n === 'bg') {
    const src = url('bg', a[0]);
    const preload = new Image(); preload.src = src; await preload.decode();
    $('background').style.backgroundImage = `url("${src}")`;
  } else if (n === 'char' || showChar) {
    if (showChar) a.shift();
    const charName = a[0];
    const pos = a[1] || 'center';
    const pose = a[2];
    const existing = $(`char-${charName}`);
    if (n === 'char' && !existing) {
      throw new Error(`キャラクター '${charName}' はまだ登場していません`);
    }
    const e = existing || Object.assign(document.createElement('img'), { id: `char-${charName}` });
    e.className = `actor ${pos}`;
    e.src = url('char', charName, pose);
    await e.decode();
    if (!e.parentNode) $('characters').append(e);
    if (showChar && a[3] === 'fade') await fade(e, 0, 1, a[4]);
  } else if (n === 'hide') {
    const charName = a[0] === 'char' ? a[1] : a[0];
    const e = $(`char-${charName}`);
    if (e && a[2] === 'fade') await fade(e, 1, 0, a[3]);
    e?.remove();
  } else if (n === 'clear') {
    const target = a[0];
    if (target === 'bg') $('background').style.backgroundImage = 'none';
    else if (target === 'bgm') {
      const bgm = $('bgm');
      bgm.pause();
      bgm.removeAttribute('src');
    } else if (target === 'char') $(`char-${a[1]}`)?.remove();
    else if (target === 'image') $(`image-${a[1]}`)?.remove();
  } else if (n === 'bgm') {
    await media('bgm', a[0]);
  } else if (n === 'play') {
    if (a[0] === 'video') await playVideo(a[1], a[2]);
    else await media(a[0], a[1]);
  } else if (n === 'effect') {
    await applyEffect(a[0], a[1], a[2]);
  } else if (n === 'image' || (n === 'show' && !showChar)) {
    const imgName = a[0] === 'image' ? a[1] : a[0];
    const pos = (a[0] === 'image' ? a[2] : a[1]) || 'center';
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
      $('speaker').textContent = args[0] === 'none' ? '' : args[0];
      $('text').textContent = rt.text(args[1]);
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
  const settings = await (await fetch('/api/scene-config')).json();
  const name = new URLSearchParams(location.search).get('source') || settings.start_scene || 'main.tds';
  await runtime.run(await loadScene(name));
})().catch(error => { $('speaker').textContent = 'PLAYER ERROR'; $('text').textContent = error.message; $('choices').replaceChildren(); });
