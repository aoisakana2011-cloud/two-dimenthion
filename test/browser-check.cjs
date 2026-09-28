// Run after npm run build and installing playwright in build/audit-tools.
const { chromium } = require('../build/audit-tools/node_modules/playwright');
const { handleApi, serveStatic } = require('../Edit/server');
const fs = require('node:fs/promises'), os = require('node:os'), http = require('node:http'), path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { pack } = require('../tools/pack');
(async () => {
  const root = path.resolve(__dirname, '../Title/asset');
  const dir = await fs.mkdtemp(path.join(root, '__audit_'));
  const relative = path.basename(dir) + '/pixel.png';
   await fs.copyFile(path.resolve(__dirname, '../native/engine_data/ui/dialogue_box.png'), path.join(dir, 'pixel.png'));
   const audioRelative = path.basename(dir) + '/tone.ogg';
   const lateAudioRelative = path.basename(dir) + '/late.ogg';
   await fs.copyFile(path.resolve(__dirname, '../build/audit-smoke/assets/tone.ogg'), path.join(dir, 'tone.ogg'));
   await fs.copyFile(path.resolve(__dirname, '../build/audit-smoke/assets/tone.ogg'), path.join(dir, 'late.ogg'));
   const videoRelative = path.basename(dir) + '/clip.mp4';
   const brokenVideoRelative = path.basename(dir) + '/broken.mp4';
   const brokenAudioRelative = path.basename(dir) + '/broken.ogg';
   const brokenImageRelative = path.basename(dir) + '/broken.png';
   await fs.copyFile(path.resolve(__dirname, '../build/audit-smoke/assets/clip.mp4'), path.join(dir, 'clip.mp4'));
   await fs.writeFile(path.join(dir, 'broken.mp4'), 'not a decodable video');
   await fs.writeFile(path.join(dir, 'broken.ogg'), 'not a decodable audio stream');
   await fs.writeFile(path.join(dir, 'broken.png'), 'not a decodable image');
  const server = http.createServer(async (req, res) => {
    try { const url = new URL(req.url, 'http://127.0.0.1'); if (url.pathname.startsWith('/api/')) await handleApi(req, res, url); else await serveStatic(res, url.pathname); }
    catch (error) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: error.message })); }
  });
  let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
    const page = await browser.newPage(); page.setDefaultTimeout(10_000); const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(() => {
      window.__playedMedia = [];
      window.__bgmGainNodes = [];
      window.__bgmRamps = [];
      window.__bgmParamContexts = new WeakMap();
      window.__heldAnimationFrames = [];
      window.__holdAnimationFrames = new URLSearchParams(location.search).has('hold-bgm-raf');
      const decodeImage = HTMLImageElement.prototype.decode;
      if (new URLSearchParams(location.search).has('delay-image-decode')) {
        HTMLImageElement.prototype.decode = function (...args) {
          if (this.src.endsWith('/broken.png'))
            return new Promise((resolve, reject) => setTimeout(() => decodeImage.apply(this, args).then(resolve, reject),
              new URLSearchParams(location.search).get('delay-image-decode') === 'long' ? 1150 : 350));
          return decodeImage.apply(this, args);
        };
      }
      const requestFrame = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = callback => {
        if (window.__holdAnimationFrames) { window.__heldAnimationFrames.push(callback); return window.__heldAnimationFrames.length; }
        return requestFrame(callback);
      };
      if (window.AudioContext) {
        if (new URLSearchParams(location.search).has('stall-audio-resume')) {
          AudioContext.prototype.resume = () => new Promise(() => {});
          let prototype = AudioContext.prototype;
          while (prototype && !Object.getOwnPropertyDescriptor(prototype, 'state')) prototype = Object.getPrototypeOf(prototype);
          const state = Object.getOwnPropertyDescriptor(prototype, 'state');
          Object.defineProperty(prototype, 'state', { ...state, get: () => 'suspended' });
        }
        const createGain = AudioContext.prototype.createGain;
        AudioContext.prototype.createGain = function (...args) {
          const node = createGain.apply(this, args);
          window.__bgmGainNodes.push({ node, context: this });
          window.__bgmParamContexts.set(node.gain, this);
          return node;
        };
        const linearRamp = AudioParam.prototype.linearRampToValueAtTime;
        AudioParam.prototype.linearRampToValueAtTime = function (value, endTime) {
          const context = window.__bgmParamContexts.get(this);
          if (context) window.__bgmRamps.push({ value, endTime, scheduledAt: context.currentTime });
          return linearRamp.call(this, value, endTime);
        };
      }
      const play = HTMLMediaElement.prototype.play;
      const simulateAudioError = new URLSearchParams(location.search).has('simulate-audio-error');
      HTMLMediaElement.prototype.play = function (...args) {
        window.__playedMedia.push(this);
        const result = play.apply(this, args);
        if (simulateAudioError && this instanceof HTMLAudioElement && this.src.endsWith('/late.ogg')) {
          setTimeout(() => { this.pause(); this.dispatchEvent(new Event('error')); }, 40);
        }
        return result;
      };
    });
    let compiledSceneName = '';
    page.on('request', async request => {
      if (new URL(request.url()).pathname === '/api/compile') compiledSceneName = request.postDataJSON()?.name || '';
    });
    let source = `asset image first = "asset/${relative}"
 asset image second = "asset/${relative}"
asset bg room = "asset/${relative}"
 asset voice greeting = "asset/${audioRelative}"
 asset bgm first_bgm = "asset/${audioRelative}"
 asset bgm second_bgm = "asset/${audioRelative}"
character hero {
  name = "五位殿"
  pose normal = "asset/${relative}"
}
character friend {
  name = "Friend"
  pose normal = "asset/${relative}"
}
str result = str(9007199254740992 + 1)
float shift = 0.5
fn answer() -> int { int n = 7
return n }
show image first left
 show image second right
 play bgm first_bgm
 play bgm second_bgm crossfade 900
 play voice greeting blocking
bg room
show hero.normal left fade 10
show friend.normal right x-(shift * 23.0) y+(shift * 69.0)
move character friend by x+(7.25) y-(5.25) over 10
move bg by x+(6.5) y-(3.25)
clear image first
choice "choose" {
"continue" { show friend.normal left\nplay bgm first_bgm crossfade 2\nplay bgm second_bgm crossfade 2\nplay bgm first_bgm crossfade 2\nwait 80\nclear bgm\nsay hero result + ":" + str(answer()) }
}`;
    const routedScenes = new Map(), routedSceneRequests = [];
    await page.route('**/api/scene**', route => {
      const name = new URL(route.request().url()).searchParams.get('name') || '__audit.tds';
      routedSceneRequests.push(name);
      route.fulfill({ json: { name, source: routedScenes.get(name) ?? source } });
    });
    await page.goto(base + '/player.html?source=__audit.tds&debug=offset-smoke');
    await page.waitForFunction(() => {
      const voice = window.__playedMedia.find(audio => !audio.loop && audio.src.endsWith('/tone.ogg'));
      const transition = runtime.sceneState.audio.bgm?.transition;
      const voiceAction = Object.values(runtime.sceneState.actions).find(action => action.kind === 'voice');
      return voice && !voice.paused && transition?.status === 'running' && voiceAction?.status === 'running';
    }, null, { polling: 20 });
    await page.waitForFunction(() => {
      const incoming = document.querySelector('audio[data-player-bgm="true"]');
      return incoming && window.__bgmRamps.length >= 2;
    }).catch(async (error) => {
      const state = await page.evaluate(() => ({
        audio: [...document.querySelectorAll('audio')].map(audio => ({
          id: audio.id, bgm: audio.dataset.playerBgm, src: audio.currentSrc, paused: audio.paused,
          volume: audio.volume, readyState: audio.readyState, error: audio.error?.code,
        })),
        ramps: window.__bgmRamps,
      }));
      throw new Error(`BGM crossfade did not enter its fade window: ${JSON.stringify(state)}; ${errors.join('; ') || error.message}`);
    });
    const liveBgmMix = await page.evaluate(() => ({
      sceneLayers: runtime.sceneState.audio.bgm.layers.map(({ asset, gain, role }) => ({ asset, gain, role })),
      renderedLayers: [...document.querySelectorAll('audio')].filter(audio => audio.loop && !audio.paused).length,
      transition: runtime.sceneState.audio.bgm.transition.status,
    }));
    assert.equal(liveBgmMix.transition, 'running');
    assert.equal(liveBgmMix.sceneLayers.length, 2, 'SceneState must retain both simultaneous crossfade tracks');
    assert.equal(liveBgmMix.renderedLayers, 2, 'Browser must actually render the two layers represented in SceneState');
    assert.ok(liveBgmMix.sceneLayers.every(layer => layer.gain >= 0 && layer.gain <= 1));
    assert.ok(Math.abs(liveBgmMix.sceneLayers.reduce((sum, layer) => sum + layer.gain, 0) - 1) < 1e-9,
      'linear crossfade layer gains must complement each other');
    await page.waitForFunction(() => {
      const layers = runtime.sceneState.audio.bgm?.layers || [];
      return layers.length === 2 && layers.every(layer => layer.gain >= 0.46 && layer.gain <= 0.54);
    }, null, { polling: 10 });
    const browserMidpointMix = await page.evaluate(() => runtime.sceneState.audio.bgm.layers
      .map(({ asset, gain, role }) => ({ asset, gain, role })));
    assert.deepEqual(browserMidpointMix.map(layer => layer.role).sort(), ['incoming', 'outgoing']);
    assert.ok(browserMidpointMix.every(layer => Math.abs(layer.gain - 0.5) <= 0.04),
      `Browser AudioContext must render both tracks at a linear 50/50 crossfade midpoint like Native: ${JSON.stringify(browserMidpointMix)}`);
    await page.waitForFunction(() => runtime.sceneState.audio.bgm.transition.status === 'complete', null, { polling: 20 });
    const concurrentAudio = await page.evaluate(() => ({
      transition: runtime.sceneState.audio.bgm.transition.status,
      voice: Object.values(runtime.sceneState.actions).find(action => action.kind === 'voice')?.status,
      voicePlaying: window.__playedMedia.some(audio => !audio.loop && !audio.paused && audio.src.endsWith('/tone.ogg')),
    }));
    assert.deepEqual(concurrentAudio, { transition: 'complete', voice: 'running', voicePlaying: true },
      'BGM crossfade completes while blocking Voice continues playing');
    await page.locator('.choice').waitFor().catch(async (error) => {
      throw new Error(`choice was not shown: ${await page.locator('#speaker').textContent()} / ${await page.locator('#text').textContent()} (${errors.join('; ') || error.message})`);
    });
    assert.equal(compiledSceneName, '__audit.tds');
    assert.equal(await page.locator('audio[data-player-bgm="true"]').count(), 1);
    assert.equal(await page.locator('#image-first').count(), 0);
    assert.equal(await page.locator('#image-second').count(), 1);
    assert.equal(await page.locator('#char-hero').count(), 1);
    assert.equal(await page.locator('#char-friend').count(), 1);
    assert.equal(await page.locator('#char-friend').evaluate(element => element.style.transform), 'translateX(calc(-50% - 4.25px))');
    assert.equal(await page.locator('#char-friend').evaluate(element => element.style.bottom), '-29.25px');
    assert.equal(await page.locator('#background').evaluate(element => element.style.transform), 'translate(6.5px, -3.25px)');
    assert.equal(await page.locator('#background').evaluate(element => getComputedStyle(element).backgroundSize), 'cover', 'Browser backgrounds preserve aspect ratio and center-crop like Native cover geometry');
    await page.locator('.choice').click();
    await page.waitForFunction(() => document.querySelector('#text').textContent === '9007199254740993:7');
    assert.equal(await page.locator('#characters .actor').count(), 1, 'selected branch replaces the previous occupant instead of stacking characters in one slot');
    assert.equal(await page.locator('#char-friend').getAttribute('data-slot'), 'left');
    assert.equal(await page.locator('#char-hero').count(), 0);
    assert.equal(await page.locator('audio[data-player-bgm="true"]').count(), 0, 'clear bgm removes every fading and active BGM layer');
    assert.equal(await page.locator('#speaker').textContent(), '五位殿', 'Browser dialogue must render the character display name, not its identifier');
    await page.screenshot({ path: path.resolve(__dirname, '../build/browser-regression.png') });
    const auditCases = require('./fixtures/audit-cases.json');
    for (const [id, expression, expected] of [
      ['loop', 'str(hits)', '1'],
      ['condition_effect', 'str(result)', '1'],
      ['argument_effect', 'str(result)', '1'],
      ['dictionary_alias', 'str(result)', '1'],
      ['dictionary_side_effect', 'str(d["y"])', '9'],
      ['const_shadow', 'str(result)', '2'],
    ]) {
      source = auditCases[id].source + '\nsay narrator ' + expression;
      await page.reload();
      await page.waitForFunction(value => document.querySelector('#text').textContent === value, expected);
      // Narrator lines intentionally suppress the speaker nameplate text.
      assert.equal(await page.locator('#speaker').textContent(), '', id);
    }
    source = auditCases.interpolation_side_effect.source + '\nsay narrator str(state)';
    await page.reload();
    await page.locator('.choice').click();
    await page.waitForFunction(() => document.querySelector('#text').textContent === '1');
    const invalidConst = await page.request.post(base + '/api/validate', { data: { name: '__audit.tds', source: 'const dict[int] d = {"x":1}\nunset d["x"]' } });
    const constReport = await invalidConst.json();
    assert.equal(constReport.ok, false);
    assert.ok(constReport.diagnostics.some(item => item.severity === 'error' && /const/.test(item.message)));
    const reservedName = await page.request.post(base + '/api/validate', { data: { name: '__audit.tds', source: 'int const = 1' } });
    const reservedReport = await reservedName.json();
    assert.equal(reservedReport.ok, false);
    assert.ok(reservedReport.diagnostics.some(item => item.severity === 'error' && /予約語/.test(item.message)));
    const slotSource = `character hero {
  name = "Hero"
  pose normal = "asset/char/aokami.png"
}
show hero.normal far_left`;
    const slotValidation = await page.request.post(base + '/api/validate', { data: { name: '__audit.tds', source: slotSource } });
    const slotReport = await slotValidation.json();
    assert.equal(slotReport.ok, true, slotReport.error);
    const slotCompile = await page.request.post(base + '/api/compile', { data: { name: '__audit.tds', source: slotSource } });
    const slotCompiled = await slotCompile.json();
    assert.equal(slotCompiled.ok, true, slotCompiled.error);
    assert.deepEqual(slotCompiled.program.globals.at(-1).args.slice(0, 2).map(argument => argument.value), ['hero.normal', 'far_left']);
    source = 'choice { "bad" { int x = 1 / 0 } }';
    await page.reload(); await page.locator('.choice').click();
    await page.waitForFunction(() => document.querySelector('#speaker').textContent === 'PLAYER ERROR');
    assert.match(await page.locator('#text').textContent(), /除算/);
    source = `character zara {
  name = "Zara"
  pose normal = "asset/${relative}"
}
character ayase {
  name = "Ayase"
  pose normal = "asset/${relative}"
}
scene main {
  show zara.normal left
  show ayase.normal right
  say narrator "stack order"
}`;
    await page.reload();
    await page.locator('#text').getByText('stack order').waitFor();
    assert.deepEqual(await page.locator('#characters .actor').evaluateAll(actors => actors.map(actor => actor.id)), ['char-zara', 'char-ayase'], 'Browser overlap order follows first placement, not character-name sort');
  source = `asset bg room = "asset/${relative}"
character hero {
  name = "Hero"
  pose normal = "asset/${relative}"
}
scene main {
  bg room
  show hero.normal center fade 1000
  move character hero by y+40 over 1000
  move bg by y+40 over 1000
  effect fade black 1000
  hide hero fade 1000
  say narrator "linear done"
}`;
    await page.reload();
    const timedActor = page.locator('#char-hero');
    await timedActor.waitFor();
    await page.waitForFunction(() => document.querySelector('#char-hero')?.getAnimations().length > 0);
    await page.waitForFunction(() => {
      const action = Object.values(runtime.sceneState.actions).find(item => item.kind === 'show');
      return action?.progress >= 0.45 && action.progress <= 0.65;
    });
    const fadeSample = await timedActor.evaluate(element => {
      const animation = element.getAnimations()[0];
      const easing = animation.effect.getTiming().easing;
      const progress = Object.values(runtime.sceneState.actions).find(item => item.kind === 'show').progress;
      const opacity = Number(getComputedStyle(element).opacity);
      const sceneOpacity = runtime.sceneState.characters.hero.opacity;
      animation.finish();
      return { easing, opacity, sceneOpacity, progress };
    });
    assert.equal(fadeSample.easing, 'linear');
    assert.ok(Math.abs(fadeSample.opacity - fadeSample.progress) < 0.04 && Math.abs(fadeSample.sceneOpacity - fadeSample.opacity) < 0.04 && Math.abs(fadeSample.progress - 0.5) < 0.16,
      `SceneState character fade progress must describe the opacity actually rendered in Browser: ${JSON.stringify(fadeSample)}`);
    await page.waitForFunction(() => [...(document.querySelector('#char-hero')?.getAnimations() || [])].some(animation => animation.effect.getTiming().duration === 1000));
    await page.waitForFunction(() => {
      const action = Object.values(runtime.sceneState.actions).find(item => item.kind === 'move' && item.target === 'hero');
      return action?.progress >= 0.45 && action.progress <= 0.65;
    });
    const moveSample = await timedActor.evaluate(element => {
      const animation = element.getAnimations().find(candidate => candidate.effect.getTiming().duration === 1000);
      const easing = animation.effect.getTiming().easing;
      const action = Object.values(runtime.sceneState.actions).find(item => item.kind === 'move' && item.target === 'hero');
      const renderedY = Number(action.progress * 40);
      const bottom = getComputedStyle(element).bottom;
      const scenePosition = { x: runtime.sceneState.characters.hero.offsetX, y: runtime.sceneState.characters.hero.offsetY };
      animation.finish();
      return { easing, bottom, progress: action.progress, renderedY, scenePosition };
    });
    assert.equal(moveSample.easing, 'linear');
    assert.ok(Math.abs(Number(moveSample.bottom.slice(0, -2)) + moveSample.renderedY) < 1,
      `SceneState character move progress must reconstruct its Browser-rendered y position: ${JSON.stringify(moveSample)}`);
    assert.ok(Math.abs(moveSample.scenePosition.y - moveSample.renderedY) < 1,
      `SceneState character offset itself must equal its currently rendered position: ${JSON.stringify(moveSample)}`);
    assert.ok(Math.abs(moveSample.progress - 0.5) < 0.16, `character move sample should be near the Native midpoint: ${JSON.stringify(moveSample)}`);
    const timedBackground = page.locator('#background');
    await page.waitForFunction(() => [...(document.querySelector('#background')?.getAnimations() || [])].some(animation => animation.effect.getTiming().duration === 1000));
    await page.waitForFunction(() => runtime.sceneState.background?.transition.progress >= 0.45 && runtime.sceneState.background.transition.progress <= 0.65);
    const backgroundMoveSample = await timedBackground.evaluate(element => {
      const animation = element.getAnimations().find(candidate => candidate.effect.getTiming().duration === 1000);
      const progress = runtime.sceneState.background.transition.progress;
      const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform);
      const sceneY = runtime.sceneState.background.offsetY;
      animation.finish();
      return { x: matrix.m41, y: matrix.m42, progress, sceneY, expectedY: 40 * progress };
    });
    assert.equal(backgroundMoveSample.x, 0);
    assert.ok(Math.abs(backgroundMoveSample.y - backgroundMoveSample.expectedY) < 1 && Math.abs(backgroundMoveSample.sceneY - backgroundMoveSample.y) < 1 && Math.abs(backgroundMoveSample.progress - 0.5) < 0.16,
      `SceneState background move progress must match the Browser transform and Native midpoint: ${JSON.stringify(backgroundMoveSample)}`);
    await page.waitForFunction(() => [...document.querySelector('#stage').children].some(element => element.style.backgroundColor === 'black' && element.getAnimations().length));
    await page.waitForFunction(() => runtime.sceneState.effects.at(-1)?.transition.progress >= 0.45 && runtime.sceneState.effects.at(-1).transition.progress <= 0.65);
    const effectSample = await page.evaluate(() => {
      const element = [...document.querySelector('#stage').children].find(candidate => candidate.style.backgroundColor === 'black' && candidate.getAnimations().length);
      const animation = element.getAnimations()[0];
      const easing = animation.effect.getTiming().easing;
      const progress = runtime.sceneState.effects.at(-1).transition.progress;
      const opacity = Number(getComputedStyle(element).opacity);
      const sceneOpacity = runtime.sceneState.effects.at(-1).opacity;
      animation.finish();
      return { easing, opacity, sceneOpacity, progress };
    });
    assert.equal(effectSample.easing, 'linear');
    assert.ok(Math.abs(effectSample.opacity - (1 - effectSample.progress)) < 0.04 && Math.abs(effectSample.sceneOpacity - effectSample.opacity) < 0.04 && Math.abs(effectSample.progress - 0.5) < 0.16,
      `SceneState screen-effect progress must match its rendered overlay and Native midpoint: ${JSON.stringify(effectSample)}`);
    await page.waitForFunction(() => document.querySelector('#char-hero')?.getAnimations().some(animation => animation.effect.getTiming().duration === 1000));
    await page.waitForFunction(() => {
      const action = Object.values(runtime.sceneState.actions).find(item => item.kind === 'hide');
      return action?.progress >= 0.45 && action.progress <= 0.65;
    });
    const hideSample = await timedActor.evaluate(element => {
      const animation = element.getAnimations()[0];
      const progress = Object.values(runtime.sceneState.actions).find(item => item.kind === 'hide').progress;
      const opacity = Number(getComputedStyle(element).opacity);
      const sceneOpacity = runtime.sceneState.characters.hero.opacity;
      animation.finish();
      return { progress, opacity, sceneOpacity };
    });
    assert.ok(Math.abs(hideSample.opacity - (1 - hideSample.progress)) < 0.04 && Math.abs(hideSample.sceneOpacity - hideSample.opacity) < 0.04 && Math.abs(hideSample.progress - 0.5) < 0.16,
      `SceneState hide progress must match the rendered sprite fade and Native midpoint: ${JSON.stringify(hideSample)}`);
    await page.locator('#text').getByText('linear done').waitFor();
    source = `asset voice greeting = "asset/${audioRelative}"
scene main {
  play voice greeting blocking
  say narrator "voice ended first"
}`;
    await page.reload();
    await page.locator('#text').getByText('voice ended first').waitFor();
    assert.deepEqual(await page.evaluate(() => window.__playedMedia.map(audio => ({ ended: audio.ended, paused: audio.paused }))), [{ ended: true, paused: true }], 'the next dialogue is not reached until blocking Voice ends');
    source = `asset se click = "asset/${audioRelative}"
scene main {
  play se click
  say narrator "SE is still playing"
}`;
    await page.reload();
    await page.locator('#text').getByText('SE is still playing').waitFor();
    const seState = await page.evaluate(() => window.__playedMedia.map(audio => ({ ended: audio.ended, paused: audio.paused })));
    assert.deepEqual(seState, [{ ended: false, paused: false }], 'SE playback remains non-blocking while dialogue continues');
    await page.locator('#dialogue').click();
    await page.waitForFunction(() => window.__playedMedia.length === 1 && window.__playedMedia[0].ended);
    source = `asset se click = "asset/${audioRelative}"
asset voice greeting = "asset/${audioRelative}"
scene main {
  play se click
  play voice greeting async
  effect fade black 1100
  say narrator "media ended during blocking effect"
}`;
    await page.reload();
    await page.locator('#text').getByText('media ended during blocking effect').waitFor();
    const mediaDuringEffect = await page.evaluate(() => ({
      media: window.__playedMedia.map(audio => ({ ended: audio.ended, paused: audio.paused })),
      time: runtime.sceneState.logicalTimeMs,
      activeMedia: Object.values(runtime.sceneState.actions).filter(action => ['se', 'voice'].includes(action.kind) && action.status === 'running'),
      effect: Object.values(runtime.sceneState.actions).filter(action => action.kind === 'effect').at(-1)?.status,
    }));
    assert.deepEqual(mediaDuringEffect.media, [{ ended: true, paused: true }, { ended: true, paused: true }], 'nonblocking SE and async Voice naturally end while the blocking visual effect runs');
    assert.equal(mediaDuringEffect.time, 1100, 'blocking visual effect advances the same deterministic presentation clock');
    assert.deepEqual(mediaDuringEffect.activeMedia, [], 'naturally ended Browser media actions are no longer active after the effect');
    assert.equal(mediaDuringEffect.effect, 'complete', 'the blocking effect completes before dialogue resumes');
    const parityRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-effect-media-parity-'));
    try {
      const scenePath = path.join(parityRoot, 'main.tds'), packagePath = path.join(parityRoot, 'presentation.nsp.json');
      await fs.writeFile(scenePath, source, 'utf8');
      await pack(scenePath, packagePath, { scenesRoot: parityRoot, assetsRoot: root });
      const nativeExe = process.env.NOVEL_NATIVE_EXE || path.resolve(__dirname, '../native/build/Release/novel_player.exe');
      const native = spawnSync(nativeExe, [packagePath, '--smoke'], { encoding: 'utf8', timeout: 15000, env: { ...process.env, SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy' } });
      assert.equal(native.status, 0, native.stderr || native.error?.message || `Native player exit ${native.status}`);
      const nativeState = JSON.parse(native.stdout).presentationTrace.at(-1).state;
      const browserState = await page.evaluate(() => ({
        logicalTimeMs: runtime.sceneState.logicalTimeMs,
        background: runtime.sceneState.background ? { asset: runtime.sceneState.background.asset, offsetX: runtime.sceneState.background.offsetX || 0, offsetY: runtime.sceneState.background.offsetY || 0 } : null,
        video: runtime.sceneState.video ? { asset: runtime.sceneState.video.asset } : null,
        characters: Object.values(runtime.sceneState.characters).filter(actor => actor.visible).map(actor => ({
          id: actor.id, pose: actor.pose, slot: actor.slot, opacity: actor.opacity, offsetX: actor.offsetX, offsetY: actor.offsetY, visualOrder: actor.visualOrder,
        })).sort((a, b) => a.id.localeCompare(b.id)),
        images: Object.values(runtime.sceneState.images).map(image => ({ asset: image.asset, slot: image.position, opacity: image.opacity, offsetX: image.offsetX, offsetY: image.offsetY, visualOrder: image.visualOrder })),
        bgm: runtime.sceneState.audio.bgm ? { asset: runtime.sceneState.audio.bgm.asset, transition: runtime.sceneState.audio.bgm.transition.status } : null,
        activeMedia: Object.values(runtime.sceneState.actions).filter(action => ['se', 'voice'].includes(action.kind) && action.status === 'running')
          .map(action => ({ kind: action.kind, asset: action.asset })).sort((a, b) => `${a.kind}:${a.asset}`.localeCompare(`${b.kind}:${b.asset}`)),
        effect: runtime.sceneState.effects.find(item => item.transition.status === 'running')?.type || null,
      }));
      assert.deepEqual(browserState, nativeState,
        'the real Browser ended events and Native mixer completion must produce the same final presentation snapshot after the exact same blocking-effect scenario');
    } finally {
      await fs.rm(parityRoot, { recursive: true, force: true });
    }
    const transferRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-browser-goto-parity-'));
    try {
      const transferMain = `asset bg room = "asset/${relative}"
asset bgm music = "asset/${audioRelative}"
include "effects.tds" as fx
character hero {
  name = "Hero"
  pose normal = "asset/${relative}"
}
scene main {
  choice "route" {
    "continue" {
      bg room
      show hero.normal left fade 20
      play bgm music crossfade 900
      fx.fade_black(25)
      goto "next.tds"
    }
    "skip" { wait 1 }
  }
}`;
      const transferDestination = `asset se click = "asset/${audioRelative}"
asset voice greeting = "asset/${audioRelative}"
include "effects.tds" as fx
scene next {
  play se click
  play voice greeting async
  fx.fade_white(1100)
  say narrator "browser crossed external goto"
  clear bgm
}`;
      const transferScenes = path.join(transferRoot, 'scenes');
      await fs.mkdir(transferScenes, { recursive: true });
      await fs.writeFile(path.join(transferScenes, 'effects.tds'), `fn fade_black(duration: int) -> none { effect fade black duration }\nfn fade_white(duration: int) -> none { effect fade white duration }`, 'utf8');
      const transferMainPath = path.join(transferScenes, '__audit_cross_main.tds');
      await fs.writeFile(transferMainPath, transferMain, 'utf8');
      await fs.writeFile(path.join(transferScenes, 'next.tds'), transferDestination, 'utf8');
      const transferPackagePath = path.join(transferRoot, 'transfer.nsp.json');
      await pack(transferMainPath, transferPackagePath, { scenesRoot: transferScenes, assetsRoot: root, debug: true });
      const transferPackage = JSON.parse(await fs.readFile(transferPackagePath, 'utf8'));
      const transferLine = transferMain.split('\n').findIndex(line => line.trim() === 'bg room') + 1;
      routedScenes.set('__audit_cross_main.tds', transferMain);
      routedScenes.set('next.tds', transferDestination);
      const transferCompileRoute = route => {
        const name = route.request().postDataJSON()?.name;
        const program = transferPackage.files[name];
        return program ? route.fulfill({ json: { ok: true, program } }) : route.continue();
      };
      await page.route('**/api/compile', transferCompileRoute);
      const native = spawnSync(process.env.NOVEL_NATIVE_EXE || path.resolve(__dirname, '../native/build/Release/novel_player.exe'),
        [transferPackagePath, '--smoke', '--debug-start', '__audit_cross_main.tds', 'main', String(transferLine), '{}'],
        { encoding: 'utf8', timeout: 15000, env: { ...process.env, SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy' } });
      assert.equal(native.status, 0, native.stderr || native.error?.message || `Native player exit ${native.status}`);
      const expectedTrace = JSON.parse(native.stdout).presentationTrace;
      await page.goto(`${base}/player.html?source=__audit_cross_main.tds&scene=main&debug=browser-goto-parity&line=${transferLine}`);
      await page.locator('#text').getByText('browser crossed external goto').waitFor().catch(async error => {
        const state = await page.evaluate(() => ({ speaker: document.querySelector('#speaker-text')?.textContent,
          text: document.querySelector('#text')?.textContent, runtime: typeof runtime === 'undefined' ? null : runtime.sceneState,
          errors: window.__playedMedia.map(audio => ({ src: audio.currentSrc, error: audio.error?.message, paused: audio.paused })) }));
        throw new Error(`real Browser debug-start did not reach the transferred file dialogue: requested=${JSON.stringify(routedSceneRequests)} state=${JSON.stringify(state)} (${errors.join('; ') || error.message})`);
      });
      assert.equal(await page.locator('#choices .choice').count(), 0, 'real Browser player starts inside the selected choice body without reopening its prompt');
      assert.deepEqual(await page.evaluate(() => ({
        logicalTimeMs: runtime.sceneState.logicalTimeMs,
        background: runtime.sceneState.background ? { asset: runtime.sceneState.background.asset, offsetX: runtime.sceneState.background.offsetX || 0, offsetY: runtime.sceneState.background.offsetY || 0 } : null,
        video: runtime.sceneState.video ? { asset: runtime.sceneState.video.asset } : null,
        characters: Object.values(runtime.sceneState.characters).filter(actor => actor.visible).map(actor => ({ id: actor.id, pose: actor.pose, slot: actor.slot, opacity: actor.opacity, offsetX: actor.offsetX, offsetY: actor.offsetY, visualOrder: actor.visualOrder })).sort((a, b) => a.id.localeCompare(b.id)),
        images: [], bgm: runtime.sceneState.audio.bgm ? { asset: runtime.sceneState.audio.bgm.asset, transition: runtime.sceneState.audio.bgm.transition.status } : null,
        activeMedia: Object.values(runtime.sceneState.actions).filter(action => ['se', 'voice'].includes(action.kind) && action.status === 'running').map(action => ({ kind: action.kind, asset: action.asset })).sort((a, b) => `${a.kind}:${a.asset}`.localeCompare(`${b.kind}:${b.asset}`)),
        effect: runtime.sceneState.effects.find(item => item.transition.status === 'running')?.type || null,
      })), expectedTrace.at(-2).state,
      'real Browser player at the destination dialogue must match Native scene state after external goto and natural media completion');
      const ended = await page.evaluate(() => window.__playedMedia.filter(audio => !audio.loop).map(audio => ({ ended: audio.ended, paused: audio.paused })));
      assert.deepEqual(ended, [{ ended: true, paused: true }, { ended: true, paused: true }], 'both real Browser media tracks ended before destination dialogue');
      assert.deepEqual(await page.evaluate(() => ({ se: runtime.sceneState.audio.se, voices: runtime.sceneState.audio.voices })),
        { se: [], voices: [] }, 'naturally ended Browser SE/Voice are absent from the active audio state');
      await page.locator('#dialogue').click();
      await page.waitForFunction(() => runtime.sceneState.audio.bgm === null);
      const browserFinal = await page.evaluate(() => ({
        logicalTimeMs: runtime.sceneState.logicalTimeMs,
        background: runtime.sceneState.background ? { asset: runtime.sceneState.background.asset, offsetX: runtime.sceneState.background.offsetX || 0, offsetY: runtime.sceneState.background.offsetY || 0 } : null,
        video: runtime.sceneState.video ? { asset: runtime.sceneState.video.asset } : null,
        characters: Object.values(runtime.sceneState.characters).filter(actor => actor.visible).map(actor => ({ id: actor.id, pose: actor.pose, slot: actor.slot, opacity: actor.opacity, offsetX: actor.offsetX, offsetY: actor.offsetY, visualOrder: actor.visualOrder })).sort((a, b) => a.id.localeCompare(b.id)),
        images: [], bgm: null,
        activeMedia: Object.values(runtime.sceneState.actions).filter(action => ['se', 'voice'].includes(action.kind) && action.status === 'running').map(action => ({ kind: action.kind, asset: action.asset })).sort((a, b) => `${a.kind}:${a.asset}`.localeCompare(`${b.kind}:${b.asset}`)),
        effect: runtime.sceneState.effects.find(item => item.transition.status === 'running')?.type || null,
      }));
      assert.deepEqual(browserFinal, expectedTrace.at(-1).state, 'Browser cleanup after dialogue must match Native clear-bgm state across the transferred file');
    } finally {
      await page.unroute('**/api/compile');
      routedScenes.delete('__audit_cross_main.tds');
      routedScenes.delete('next.tds');
      await fs.rm(transferRoot, { recursive: true, force: true });
      await page.goto(base + '/player.html?source=__audit.tds&debug=offset-smoke');
    }
    source = `asset bgm first = "asset/${audioRelative}"
asset bgm second = "asset/${audioRelative}"
scene main {
  bgm first
  play bgm second crossfade 60
  say narrator "crossfade completes during dialogue"
}`;
    await page.reload();
    await page.locator('#text').getByText('crossfade completes during dialogue').waitFor();
    await page.waitForFunction(() => eval('runtime.sceneState.audio.bgm.transition.status') === 'complete');
    const completedCrossfade = await page.evaluate(() => eval('({logicalTimeMs: runtime.sceneState.logicalTimeMs, transition: runtime.sceneState.audio.bgm.transition, action: runtime.sceneState.actions[runtime.sceneState.audio.bgm.actionId]})'));
    assert.equal(completedCrossfade.logicalTimeMs, 0, 'unmeasured dialogue pause does not invent deterministic script time');
    assert.equal(completedCrossfade.transition.progress, 1);
    assert.equal(completedCrossfade.transition.status, 'complete', 'the visual/audio transition closes on elapsed player time');
    assert.equal(completedCrossfade.action.status, 'running', 'the looping BGM remains active after its crossfade ends');
    assert.deepEqual(await page.locator('audio').evaluateAll(nodes => nodes.map(audio => ({ id: audio.id, candidate: audio.dataset.playerBgm || null, paused: audio.paused }))), [
      { id: '', candidate: 'true', paused: false },
    ], 'after a completed crossfade Browser releases the outgoing layer and keeps exactly the new looping track');
    source = `asset bgm first = "asset/${audioRelative}"
asset bgm second = "asset/${audioRelative}"
scene main {
  bgm first
  play bgm second crossfade 800
  wait 300
  say narrator "suspended crossfade state stays truthful"
}`;
    await page.reload();
    await page.waitForFunction(() => runtime.sceneState.audio.bgm?.transition.status === 'running' && window.__bgmGainNodes.some(({ context }) => context.state === 'running'));
    await page.evaluate(async () => { await window.__bgmGainNodes[0].context.suspend(); });
    await page.locator('#text').getByText('suspended crossfade state stays truthful').waitFor();
    const suspendedBgm = await page.evaluate(() => ({
      state: runtime.sceneState.audio.bgm.layers.map(({ asset, gain }) => ({ asset, gain })),
      ramps: window.__bgmRamps.map(({ value, endTime, scheduledAt }) => ({ value, endTime, scheduledAt })),
      contextTimes: window.__bgmGainNodes.map(({ context }) => context.currentTime),
      transition: runtime.sceneState.audio.bgm.transition.status,
    }));
    assert.equal(suspendedBgm.transition, 'running');
    assert.equal(suspendedBgm.state.length, 2);
    assert.equal(suspendedBgm.contextTimes[0], suspendedBgm.contextTimes.at(-1), 'the suspended context clock must stop advancing');
    assert.ok(suspendedBgm.state.every((layer, index) => {
      const ramp = suspendedBgm.ramps[index];
      const contextTime = suspendedBgm.contextTimes[0];
      const progress = Math.max(0, Math.min(1, (contextTime - ramp.scheduledAt) / (ramp.endTime - ramp.scheduledAt)));
      const gain = ramp.value === 0 ? 1 - progress : progress;
      return Math.abs(layer.gain - gain) < 0.08;
    }),
      `logical wait time must not move externally clocked BGM layers while the audio clock is suspended: ${JSON.stringify(suspendedBgm)}`);
    await page.evaluate(async () => { await window.__bgmGainNodes[0].context.resume(); });
    await page.waitForFunction(() => runtime.sceneState.audio.bgm?.transition.status === 'complete');
    const resumedBgm = await page.evaluate(() => ({
      layers: runtime.sceneState.audio.bgm.layers.map(({ asset, gain, role }) => ({ asset, gain, role })),
      tracks: [...document.querySelectorAll('audio[data-player-bgm="true"]')].map(audio => ({ paused: audio.paused, hasSource: audio.hasAttribute('src') })),
      action: runtime.sceneState.actions[runtime.sceneState.audio.bgm.actionId].status,
    }));
    assert.deepEqual(resumedBgm, {
      layers: [{ asset: 'second', gain: 1, role: 'active' }],
      tracks: [{ paused: false, hasSource: true }],
      action: 'running',
    }, 'resuming the host clock completes the fade, retires its outgoing layer, and keeps the looping BGM action active');
    source = `asset bgm first = "asset/${audioRelative}"
asset bgm second = "asset/${audioRelative}"
asset bgm third = "asset/${audioRelative}"
scene main {
  bgm first
  play bgm second crossfade 800
  wait 300
  play bgm third crossfade 300
  say narrator "replacement while audio clock is suspended"
}`;
    await page.reload();
    await page.waitForFunction(() => runtime.sceneState.audio.bgm?.transition.status === 'running' && window.__bgmGainNodes.some(({ context }) => context.state === 'running'));
    await page.evaluate(async () => { await window.__bgmGainNodes[0].context.suspend(); });
    await page.locator('#text').getByText('replacement while audio clock is suspended').waitFor();
    await page.waitForFunction(() => runtime.sceneState.audio.bgm?.transition.status === 'complete');
    await page.evaluate(async () => { await window.__bgmGainNodes[0].context.resume(); });
    const replacedWhileSuspended = await page.evaluate(() => ({
      layers: runtime.sceneState.audio.bgm.layers.map(({ asset, gain, role }) => ({ asset, gain, role })),
      tracks: [...document.querySelectorAll('audio')].map(audio => ({ paused: audio.paused, hasSource: audio.hasAttribute('src') })),
    }));
    assert.deepEqual(replacedWhileSuspended, {
      layers: [{ asset: 'third', gain: 1, role: 'active' }],
      tracks: [{ paused: false, hasSource: true }],
    }, `a crossfade requested while the prior audio clock is suspended must not resurrect orphaned tracks after resume: ${JSON.stringify(replacedWhileSuspended)}`);
    source = `asset bgm first = "asset/${audioRelative}"
asset bgm second = "asset/${audioRelative}"
scene main {
  bgm first
  play bgm second crossfade 100
  effect fade black 500
  say narrator "concurrent transition ended"
}`;
    await page.reload();
    await page.waitForFunction(() => [...document.querySelector('#stage').children].some(element => element.style.backgroundColor === 'black' && element.getAnimations().some(animation => animation.effect.getTiming().duration === 500)));
    await page.waitForFunction(() => runtime.sceneState.audio.bgm.transition.status === 'complete');
    const concurrentTransitionSample = await page.evaluate(() => {
      const overlay = [...document.querySelector('#stage').children].find(element => element.style.backgroundColor === 'black' && element.getAnimations().length);
      const animation = overlay.getAnimations()[0];
      animation.pause(); animation.currentTime = 250;
      const result = {
        effect: { color: getComputedStyle(overlay).backgroundColor, opacity: Number(getComputedStyle(overlay).opacity) },
        bgm: runtime.sceneState.audio.bgm.transition.status,
      };
      animation.finish();
      return result;
    });
    assert.deepEqual(concurrentTransitionSample, { effect: { color: 'rgb(0, 0, 0)', opacity: 0.5 }, bgm: 'complete' },
      'the BGM fade must finish on the audio clock while an independent black screen fade is at its visual midpoint');
    await page.locator('#text').getByText('concurrent transition ended').waitFor();
    source = `asset bgm first = "asset/${audioRelative}"
asset bgm second = "asset/${audioRelative}"
scene main {
  bgm first
  play bgm second crossfade 1000
  say narrator "crossfade uses the audio clock"
}`;
    await page.goto(base + '/player.html?source=__audit.tds&debug=offset-smoke&hold-bgm-raf=1');
    await page.locator('#text').getByText('crossfade uses the audio clock').waitFor().catch(async error => {
      const state = await page.evaluate(() => ({
        speaker: document.querySelector('#speaker-text')?.textContent,
        text: document.querySelector('#text')?.textContent,
        scene: runtime.sceneState,
        contexts: window.__bgmGainNodes.map(({ context }) => ({ state: context.state, time: context.currentTime })),
        audio: [...document.querySelectorAll('audio')].map(node => ({ src: node.currentSrc, paused: node.paused, ready: node.readyState, error: node.error?.code })),
      }));
      throw new Error(`audio-clock BGM scenario did not reach dialogue: ${JSON.stringify(state)} (${errors.join('; ') || error.message})`);
    });
    await page.waitForTimeout(500);
    const audioClockMidpoint = await page.evaluate(() => ({
      gains: window.__bgmGainNodes.map(({ node, context }) => ({ value: node.gain.value, time: context.currentTime, state: context.state })),
      sceneLayers: runtime.sceneState.audio.bgm.layers.map(({ asset, gain }) => ({ asset, gain })),
      ramps: window.__bgmRamps,
      transition: runtime.sceneState.audio.bgm.transition.status,
      heldFrames: window.__heldAnimationFrames.length,
    }));
    assert.equal(audioClockMidpoint.transition, 'running');
    assert.equal(audioClockMidpoint.heldFrames, 0, 'no display frame is needed to advance the audio curve');
    assert.equal(audioClockMidpoint.gains.length, 2);
    assert.ok(audioClockMidpoint.gains.every(({ value }) => Math.abs(value - 0.5) < 0.08),
      `outgoing and incoming BGM gains should be complementary at the linear midpoint: ${JSON.stringify(audioClockMidpoint)}`);
    assert.equal(audioClockMidpoint.sceneLayers.length, audioClockMidpoint.gains.length);
    assert.ok(audioClockMidpoint.sceneLayers.every((layer, index) => Math.abs(layer.gain - audioClockMidpoint.gains[index].value) < 0.08),
      `SceneState layer gains must reflect the live WebAudio gains: ${JSON.stringify(audioClockMidpoint)}`);
    await page.waitForTimeout(550);
    const audioClockFade = await page.evaluate(() => ({
      ramps: window.__bgmRamps.map(({ value, endTime, scheduledAt }) => ({ value, duration: endTime - scheduledAt })),
      heldFrames: window.__heldAnimationFrames.length,
      transition: runtime.sceneState.audio.bgm.transition.status,
      audioCount: document.querySelectorAll('audio').length,
    }));
    assert.deepEqual(audioClockFade.ramps.map(({ value }) => value), [0, 1]);
    assert.ok(audioClockFade.ramps.every(({ duration }) => Math.abs(duration - 1) < 0.01), 'AudioParam ramps use the declared 1000ms duration');
    assert.equal(audioClockFade.heldFrames, 0, 'the audio transition does not schedule requestAnimationFrame callbacks');
    assert.equal(audioClockFade.transition, 'complete', 'the BGM transition completes on the audio clock without display frames');
    assert.equal(audioClockFade.audioCount, 1, 'the outgoing audio element is released after the audio-clock ramp');
    source = `asset bgm first = "asset/${audioRelative}"
asset bgm second = "asset/${audioRelative}"
scene main {
  bgm first
  play bgm second crossfade 40
  say narrator "audio resume fallback stays responsive"
}`;
    await page.goto(base + '/player.html?source=__audit.tds&debug=audio-resume-fallback&stall-audio-resume=1');
    await page.locator('#text').getByText('audio resume fallback stays responsive').waitFor();
    const audioResumeFallback = await page.evaluate(() => ({
      routedNodes: window.__bgmGainNodes.length,
      audio: [...document.querySelectorAll('audio')].map(node => ({ paused: node.paused, volume: node.volume })),
    }));
    assert.equal(audioResumeFallback.routedNodes, 0, 'a suspended audio clock falls back without creating a muted MediaElementAudioSourceNode');
    assert.equal(audioResumeFallback.audio.length, 1);
    assert.equal(audioResumeFallback.audio[0].paused, false, 'a pending AudioContext.resume must not block scenario playback');
    source = `asset bgm first = "asset/${audioRelative}"
asset bgm second = "asset/${audioRelative}"
asset bgm third = "asset/${audioRelative}"
scene main {
  bgm first
  play bgm second crossfade 20
  wait 60
  play bgm third
  clear bgm
  say narrator "instant replacement after completed crossfade"
}`;
    await page.reload();
    await page.locator('#text').getByText('instant replacement after completed crossfade').waitFor();
    assert.equal(await page.locator('audio').count(), 1, 'clear keeps only the reusable, empty #bgm element');
    assert.equal(await page.locator('#bgm').evaluate(audio => audio.paused && !audio.hasAttribute('src')), true);
    assert.equal(await page.locator('audio[data-player-bgm="true"]').count(), 0, 'no fading or active crossfade layers remain');
    assert.deepEqual(await page.evaluate(() => window.__playedMedia.map(audio => audio.paused)), [true, true, true], 'all three BGM tracks stop after clear');
    source = `asset bgm first = "asset/${audioRelative}"
asset bgm second = "asset/${audioRelative}"
asset bgm third = "asset/${audioRelative}"
scene main {
  bgm first
  play bgm second crossfade 1000
  wait 400
  play bgm third crossfade 1000
  effect fade black 1000
  say narrator "replacement fade wins"
}`;
    await page.goto(base + '/player.html?source=__audit.tds&debug=offset-smoke');
    await page.waitForFunction(() => [...document.querySelector('#stage').children].some(element => element.style.backgroundColor === 'black' && element.getAnimations().some(animation => animation.effect.getTiming().duration === 1000)));
    await page.waitForFunction(() => window.__bgmGainNodes[0].context.currentTime - window.__bgmRamps[2].scheduledAt >= 0.48);
    const interruptedSample = await page.evaluate(() => {
      const overlay = [...document.querySelector('#stage').children].find(element => element.style.backgroundColor === 'black' && element.getAnimations().length);
      const animation = overlay.getAnimations()[0];
      const result = {
        effect: { color: getComputedStyle(overlay).backgroundColor, opacity: Number(getComputedStyle(overlay).opacity) },
        gains: window.__bgmGainNodes.map(({ node }) => node.gain.value),
        sceneLayers: runtime.sceneState.audio.bgm.layers.map(({ asset, gain }) => ({ asset, gain })),
        now: window.__bgmGainNodes[0].context.currentTime,
        firstStart: window.__bgmRamps[0].scheduledAt,
        replacementStart: window.__bgmRamps[2].scheduledAt,
        transition: runtime.sceneState.audio.bgm.transition.status,
        transitionProgress: runtime.sceneState.audio.bgm.transition.progress,
      };
      const old = Object.values(runtime.sceneState.actions).find(action => action.kind === 'bgm' && action.asset === 'second');
      const staleProgressAccepted = runtime.reportTransitionProgress(old.id, 0.99);
      runtime.completeTransition(old.id);
      const current = runtime.sceneState.audio.bgm;
      result.stale = { old: { status: old.status, reason: old.reason }, asset: current.asset,
        transition: current.transition.status, logicalTimeMs: runtime.sceneState.logicalTimeMs,
        progress: current.transition.progress, staleProgressAccepted,
        activeAction: runtime.sceneState.actions[current.actionId].status };
      animation.finish();
      return result;
    });
    const beforeReplacement = Math.max(0, Math.min(1, interruptedSample.replacementStart - interruptedSample.firstStart));
    const afterReplacement = Math.max(0, Math.min(1, interruptedSample.now - interruptedSample.replacementStart));
    const expectedInterruptedGains = [
      (1 - beforeReplacement) * (1 - afterReplacement),
      beforeReplacement * (1 - afterReplacement),
      afterReplacement,
    ];
    assert.deepEqual(interruptedSample.effect.color, 'rgb(0, 0, 0)');
    assert.ok(Math.abs(interruptedSample.effect.opacity - 0.5) < 0.08, `screen effect should be at midpoint during successor crossfade: ${JSON.stringify(interruptedSample)}`);
    assert.equal(interruptedSample.transition, 'running');
    assert.ok(Math.abs(interruptedSample.transitionProgress - afterReplacement) < 0.08,
      `SceneState BGM progress must follow the audio-clock crossfade envelope: ${JSON.stringify({ sample: interruptedSample.transitionProgress, expected: afterReplacement })}`);
    assert.equal(interruptedSample.gains.length, 3);
    assert.ok(interruptedSample.gains.every((gain, index) => Math.abs(gain - expectedInterruptedGains[index]) < 0.08),
      `replacing a running crossfade must continue each track from its actual audio-clock gain: ${JSON.stringify({ ...interruptedSample, expectedInterruptedGains })}`);
    assert.equal(interruptedSample.sceneLayers.length, interruptedSample.gains.length);
    assert.ok(interruptedSample.sceneLayers.every((layer, index) => Math.abs(layer.gain - interruptedSample.gains[index]) < 0.08),
      `SceneState must track every actual gain across an interrupted three-track crossfade: ${JSON.stringify(interruptedSample)}`);
    assert.deepEqual(interruptedSample.stale, {
      old: { status: 'stopped', reason: 'replaced' }, asset: 'third', transition: 'running', logicalTimeMs: 400,
      progress: interruptedSample.transitionProgress, staleProgressAccepted: false, activeAction: 'running',
    }, 'a delayed completion event from a replaced BGM must not finish its successor');
    await page.waitForFunction(() => eval('runtime.sceneState.audio.bgm.transition.status') === 'complete', null, { polling: 50 }).catch(async error => {
      throw new Error(`successor BGM fade did not complete: ${JSON.stringify(await page.evaluate(() => ({ bgm: runtime.sceneState.audio.bgm, contexts: window.__bgmGainNodes.map(({ context }) => ({ state: context.state, time: context.currentTime })), ramps: window.__bgmRamps, audio: [...document.querySelectorAll('audio')].map(node => ({ paused: node.paused, src: node.currentSrc })) })))}; ${error.message}`);
    });
    source = `asset image first = "asset/${relative}"
asset image second = "asset/${relative}"
scene main {
  show image first left
  show image second right
  show image first center
  say narrator "image order updated"
}`;
    await page.reload();
    await page.locator('#text').getByText('image order updated').waitFor();
    const imageOrder = await page.locator('#images').evaluate(container => [...container.children].map(image => image.id));
    assert.deepEqual(imageOrder, ['image-second', 'image-first'], 'redisplaying an image raises it to the top of the Native visual-order stack');
    source = `asset se late = "asset/${lateAudioRelative}"
scene main {
  play se late
  wait 100
  say narrator "after late audio error"
}`;
    await page.goto(base + '/player.html?source=__audit.tds&debug=audio-error&simulate-audio-error=1');
    await page.locator('#text').getByText('after late audio error').waitFor().catch(async error => {
      throw new Error(`late-audio scenario did not continue: speaker=${await page.locator('#speaker').textContent()}, text=${await page.locator('#text').textContent()}, media=${JSON.stringify(await page.evaluate(() => window.__playedMedia.map(item => ({ src: item.src, paused: item.paused }))))}, errors=${errors.join('; ') || error.message}`);
    });
    const failedSe = await page.evaluate(() => ({
      mediaPaused: window.__playedMedia[0]?.paused,
      activeSe: runtime.sceneState.audio.se,
      action: eval('Object.values(runtime.sceneState.actions).find(({kind}) => kind === "se") && (({status, reason}) => ({status, reason}))(Object.values(runtime.sceneState.actions).find(({kind}) => kind === "se"))'),
    }));
    assert.deepEqual(failedSe, { mediaPaused: true, activeSe: [], action: { status: 'stopped', reason: 'failed' } },
      'a nonblocking SE that errors after start must leave active SceneState and release playback while retaining its action record');
    source = `asset bgm stable = "asset/${audioRelative}"
asset bgm late = "asset/${lateAudioRelative}"
scene main {
  bgm stable
  play bgm late crossfade 500
  wait 100
  say narrator "failed incoming BGM clears outgoing audio"
}`;
    await page.goto(base + '/player.html?source=__audit.tds&debug=late-incoming-bgm-error&simulate-audio-error=1');
    await page.locator('#text').getByText('failed incoming BGM clears outgoing audio').waitFor();
    const failedIncomingBgm = await page.evaluate(() => ({
      bgm: runtime.sceneState.audio.bgm,
      audio: [...document.querySelectorAll('audio')].map(node => ({ id: node.id, paused: node.paused, hasSource: node.hasAttribute('src') })),
      runningBgm: Object.values(runtime.sceneState.actions).filter(action => action.kind === 'bgm' && action.status === 'running').map(action => action.asset),
    }));
    assert.deepEqual(failedIncomingBgm, {
      bgm: null,
      audio: [{ id: 'bgm', paused: true, hasSource: false }],
      runningBgm: [],
    }, `a failed incoming BGM must not leave an unrepresented outgoing track playing: ${JSON.stringify(failedIncomingBgm)}`);
    source = `asset bgm late = "asset/${lateAudioRelative}"
scene main {
  play bgm late crossfade 120
  wait 160
  say narrator "after late BGM error"
}`;
    await page.goto(base + '/player.html?source=__audit.tds&debug=late-bgm-error&simulate-audio-error=1');
    await page.locator('#text').getByText('after late BGM error').waitFor();
    const failedLateBgm = await page.evaluate(() => ({
      bgm: runtime.sceneState.audio.bgm,
      action: Object.values(runtime.sceneState.actions).find(({ kind }) => kind === 'bgm'),
      audio: [...document.querySelectorAll('audio')].map(node => ({ paused: node.paused, source: node.currentSrc })),
    }));
    assert.equal(failedLateBgm.bgm, null, `late BGM failure must clear the active SceneState track: ${JSON.stringify(failedLateBgm)}`);
    assert.deepEqual({ status: failedLateBgm.action.status, reason: failedLateBgm.action.reason }, { status: 'stopped', reason: 'failed' });
    assert.deepEqual(failedLateBgm.audio, [{ paused: true, source: '' }], 'late BGM failure must release the failed audio layer and leave only the reusable empty player element');
    source = `asset bgm late = "asset/${lateAudioRelative}"
scene main {
  bgm late
  wait 80
  say narrator "after late instant BGM error"
}`;
    await page.goto(base + '/player.html?source=__audit.tds&debug=late-instant-bgm-error&simulate-audio-error=1');
    await page.locator('#text').getByText('after late instant BGM error').waitFor();
    const failedLateInstantBgm = await page.evaluate(() => ({
      bgm: runtime.sceneState.audio.bgm,
      action: Object.values(runtime.sceneState.actions).find(({ kind }) => kind === 'bgm'),
      audio: [...document.querySelectorAll('audio')].map(node => ({ id: node.id, paused: node.paused, hasSource: node.hasAttribute('src') })),
    }));
    assert.equal(failedLateInstantBgm.bgm, null, 'late instant BGM failure must clear the active SceneState track');
    assert.deepEqual({ status: failedLateInstantBgm.action.status, reason: failedLateInstantBgm.action.reason }, { status: 'stopped', reason: 'failed' });
    assert.deepEqual(failedLateInstantBgm.audio, [{ id: 'bgm', paused: true, hasSource: false }], 'instant BGM failure preserves the reusable empty audio element');
    source = `asset bgm late = "asset/${lateAudioRelative}"
asset bgm stable = "asset/${audioRelative}"
scene main {
  play bgm late crossfade 1200
  play bgm stable crossfade 1000
  effect fade black 500
  say narrator "stale BGM error preserves replacement"
}`;
    await page.goto(base + '/player.html?source=__audit.tds&debug=stale-late-bgm-error&simulate-audio-error=1');
    await page.locator('#text').getByText('stale BGM error preserves replacement').waitFor();
    const staleLateBgm = await page.evaluate(() => ({
      bgm: runtime.sceneState.audio.bgm,
      layers: runtime.sceneState.audio.bgm.layers.map(({ asset, gain, role }) => ({ asset, gain, role })),
      actions: Object.values(runtime.sceneState.actions).filter(({ kind }) => kind === 'bgm').map(({ asset, status, reason }) => ({ asset, status, reason })),
      audio: [...document.querySelectorAll('audio')].map(node => ({ id: node.id, paused: node.paused, hasSource: node.hasAttribute('src') })),
    }));
    assert.equal(staleLateBgm.bgm.asset, 'stable', 'an outgoing track error must not clear the new active BGM');
    assert.equal(staleLateBgm.bgm.transition.status, 'running', 'the replacement fade remains active while checking the stale failure');
    assert.deepEqual(staleLateBgm.layers.map(({ asset, role }) => ({ asset, role })), [{ asset: 'stable', role: 'incoming' }],
      `a failed outgoing BGM is removed from active SceneState layers without disturbing its successor: ${JSON.stringify(staleLateBgm.layers)}`);
    assert.ok(staleLateBgm.layers[0].gain > 0.2 && staleLateBgm.layers[0].gain < 0.8,
      `the surviving layer keeps its current crossfade gain: ${JSON.stringify(staleLateBgm.layers)}`);
    assert.deepEqual(staleLateBgm.actions, [
      { asset: 'late', status: 'stopped', reason: 'replaced' },
      { asset: 'stable', status: 'running', reason: undefined },
    ], 'the stale late error cannot overwrite the old action reason or stop the replacement action');
    assert.deepEqual(staleLateBgm.audio, [
      { id: 'bgm', paused: true, hasSource: false },
      { id: '', paused: false, hasSource: true },
    ], 'the failed outgoing element is released while the reusable base element and new BGM have the expected state');
    source = `asset video first = "asset/${videoRelative}"
asset video broken = "asset/${brokenVideoRelative}"
scene main {
  play video first async
  play video broken async
  say narrator "replacement failed"
}`;
    await page.reload();
    await page.locator('#speaker').getByText('PLAYER ERROR').waitFor();
    const failedVideoReplacement = await page.evaluate(() => ({
      active: document.querySelector('#active-video') && {
        source: document.querySelector('#active-video').currentSrc,
        paused: document.querySelector('#active-video').paused,
        objectFit: document.querySelector('#active-video').style.objectFit,
      },
      sceneVideo: runtime.sceneState.video && { asset: runtime.sceneState.video.asset, actionId: runtime.sceneState.video.actionId },
      actions: eval('Object.values(runtime.sceneState.actions).map(({kind, status, reason}) => ({kind, status, reason}))'),
    }));
    assert.ok(failedVideoReplacement.active && failedVideoReplacement.active.source.endsWith('/clip.mp4') && !failedVideoReplacement.active.paused && failedVideoReplacement.active.objectFit === 'contain',
      `a failed replacement must leave the currently playing video intact: ${JSON.stringify(failedVideoReplacement)}`);
    assert.equal(failedVideoReplacement.sceneVideo.asset, 'first', 'SceneState video identity must match the still-rendered video after failed replacement');
    assert.deepEqual(failedVideoReplacement.actions, [
      { kind: 'video', status: 'running', reason: undefined },
      { kind: 'video', status: 'stopped', reason: 'failed' },
    ], 'SceneState keeps the old video action and records the failed candidate as stopped');
    source = `character hero {
  name = "Hero"
  pose normal = "asset/${relative}"
}
character ghost {
  name = "Ghost"
  pose normal = "asset/${brokenImageRelative}"
}
scene main {
  show hero.normal left
  show ghost.normal left
  say narrator "replacement failed"
}`;
    await page.reload();
    await page.locator('#speaker').getByText('PLAYER ERROR').waitFor();
    const failedSpriteReplacement = await page.evaluate(() => ({
      rendered: [...document.querySelectorAll('#characters .actor')].map(actor => actor.id),
      state: eval('({slot: runtime.sceneState.slots.left, heroVisible: runtime.sceneState.characters.hero.visible, ghostVisible: runtime.sceneState.characters.ghost?.visible})'),
    }));
    assert.deepEqual(failedSpriteReplacement.rendered, ['char-hero'], 'a pose decode failure must not remove the existing slot occupant');
    assert.deepEqual(failedSpriteReplacement.state, { slot: 'hero', heroVisible: true, ghostVisible: undefined },
      'SceneState rollback and the rendered character slot remain consistent');
    source = `asset bgm first = "asset/${audioRelative}"
asset bgm broken = "asset/${brokenAudioRelative}"
include "std/math.tds" as math
scene main {
  bgm first
  choice "replace" { "try replacement" { play bgm broken crossfade int(math.max(100.0, 100.0)) } "keep" { wait 1 } }
  say narrator "replacement failed"
}`;
    await page.reload();
    await page.locator('.choice').getByText('try replacement').waitFor();
    await page.locator('.choice').getByText('try replacement').click();
    await page.locator('#speaker').getByText('PLAYER ERROR').waitFor();
    const failedInstantBgmReplacement = await page.evaluate(() => ({
      active: { source: document.querySelector('#bgm').currentSrc, paused: document.querySelector('#bgm').paused },
      state: eval('({active: runtime.sceneState.audio.bgm.asset, actions: Object.values(runtime.sceneState.actions).map(({asset, status, reason}) => ({asset, status, reason}))})'),
    }));
    assert.ok(failedInstantBgmReplacement.active.source.endsWith('/tone.ogg') && !failedInstantBgmReplacement.active.paused,
      `a failed instant BGM replacement must preserve the previous track: ${JSON.stringify(failedInstantBgmReplacement)}`);
    assert.deepEqual(failedInstantBgmReplacement.state, {
      active: 'first',
      actions: [
        { asset: 'first', status: 'running', reason: undefined },
        { asset: 'broken', status: 'stopped', reason: 'failed' },
      ],
    }, 'failed instant BGM state rollback must match the actually playing track');
    source = `asset bgm first = "asset/${audioRelative}"
asset bgm broken = "asset/${brokenAudioRelative}"
scene main {
  bgm first
  play bgm broken crossfade 1000
  say narrator "replacement failed"
}`;
    await page.reload();
    await page.locator('#speaker').getByText('PLAYER ERROR').waitFor();
    const failedBgmReplacement = await page.evaluate(() => ({
      active: { source: document.querySelector('#bgm').currentSrc, paused: document.querySelector('#bgm').paused },
      fadingLayers: document.querySelectorAll('audio[data-player-bgm="true"]').length,
      state: eval('({active: runtime.sceneState.audio.bgm.asset, actions: Object.values(runtime.sceneState.actions).map(({kind, asset, status, reason}) => ({kind, asset, status, reason}))})'),
    }));
    assert.ok(failedBgmReplacement.active.source.endsWith('/tone.ogg') && !failedBgmReplacement.active.paused,
      `a failed crossfade must leave the current BGM playing: ${JSON.stringify(failedBgmReplacement)}`);
    assert.equal(failedBgmReplacement.fadingLayers, 0);
    assert.deepEqual(failedBgmReplacement.state, {
      active: 'first',
      actions: [
        { kind: 'bgm', asset: 'first', status: 'running', reason: undefined },
        { kind: 'bgm', asset: 'broken', status: 'stopped', reason: 'failed' },
      ],
    }, 'SceneState rolls back the failed crossfade while preserving the failure record');
    source = `asset bg room = "asset/${relative}"
asset bg broken = "asset/${brokenImageRelative}"
asset bgm first = "asset/${audioRelative}"
scene main {
  bg room
  play bgm first crossfade 1000
  bg broken
}`;
    await page.goto(base + '/player.html?source=__audit.tds&debug=rollback-progress&delay-image-decode=1');
    await page.locator('#speaker').getByText('PLAYER ERROR').waitFor();
    const rollbackProgress = await page.evaluate(() => ({
      background: runtime.sceneState.background?.asset,
      bgm: runtime.sceneState.audio.bgm && {
        asset: runtime.sceneState.audio.bgm.asset,
        progress: runtime.sceneState.audio.bgm.transition.progress,
        actionProgress: runtime.sceneState.actions[runtime.sceneState.audio.bgm.actionId]?.progress,
        status: runtime.sceneState.audio.bgm.transition.status,
      },
      activeBgm: [...document.querySelectorAll('audio')].some(audio => audio.loop && !audio.paused),
    }));
    assert.equal(rollbackProgress.background, 'room', 'failed delayed background decode must rollback only its candidate');
    assert.equal(rollbackProgress.bgm.asset, 'first');
    assert.ok(rollbackProgress.bgm.progress >= 0.15 && rollbackProgress.bgm.progress < 1,
      `the concurrent BGM fade must retain measured progress after background rollback: ${JSON.stringify(rollbackProgress)}`);
    assert.equal(rollbackProgress.bgm.actionProgress, rollbackProgress.bgm.progress,
      'the restored BGM transition and action progress must remain synchronized');
    assert.equal(rollbackProgress.bgm.status, 'running');
    assert.equal(rollbackProgress.activeBgm, true, 'the retained BGM must still be playing after the failed asset decode');
    source = `asset bg room = "asset/${relative}"
asset bg broken = "asset/${brokenImageRelative}"
asset se click = "asset/${audioRelative}"
scene main {
  bg room
  play se click
  bg broken
}`;
    await page.goto(base + '/player.html?source=__audit.tds&debug=rollback-media-end&delay-image-decode=long');
    await page.locator('#speaker').getByText('PLAYER ERROR').waitFor();
    const rollbackMediaEnd = await page.evaluate(() => ({
      background: runtime.sceneState.background?.asset,
      seActions: Object.values(runtime.sceneState.actions).filter(action => action.kind === 'se').map(action => action.status),
      audioEnded: window.__playedMedia.find(audio => !audio.loop)?.ended,
    }));
    assert.deepEqual(rollbackMediaEnd, { background: 'room', seActions: ['complete'], audioEnded: true },
      `a concurrent SE end event must survive rollback of a later failed blocking asset load: ${JSON.stringify(rollbackMediaEnd)}`);
    source = 'scene main { say narrator "must not silently start" }';
    await page.goto(base + '/player.html?source=__audit.tds&debug=invalid-start-line&line=2.5');
    await page.locator('#speaker').getByText('PLAYER ERROR').waitFor();
    assert.match(await page.locator('#text').textContent(), /Debug line must be a non-negative integer/,
      'the Browser player must reject a malformed debug line instead of silently running from the scene start');
    source = 'global str label = "base"\nscene main { say narrator label }';
    const malformedDebugVariables = encodeURIComponent(JSON.stringify({ label: { type: 'str', value: 7 } }));
    await page.goto(`${base}/player.html?source=__audit.tds&debug=invalid-debug-value&variables=${malformedDebugVariables}`);
    await page.locator('#speaker').getByText('PLAYER ERROR').waitFor();
    assert.match(await page.locator('#text').textContent(), /Unsupported debug variable type: label/,
      'Browser must reject a non-string str override just as Native debug-start rejects its typed payload');
    source = `global str label = "base"
global dict[float] weights = {"key": 0.5}
global dict[str] words = {"key": "base"}
scene main { say narrator label + ":" + str(weights["key"]) + ":" + words["key"] }`;
    const validDebugVariables = encodeURIComponent(JSON.stringify({
      label: { type: 'str', value: 'debug' },
      weights: { type: 'dict<float>', value: JSON.stringify({ key: '3.75' }) },
      words: { type: 'dict<str>', value: JSON.stringify({ key: 'edited' }) },
    }));
    await page.goto(`${base}/player.html?source=__audit.tds&debug=valid-debug-values&variables=${validDebugVariables}`);
    await page.waitForFunction(() => document.querySelector('#text').textContent === 'debug:3.75:edited');
    assert.deepEqual(errors, []);
    console.log('PASS browser: presentation parity, transactional image/video/audio replacement, SceneState rollback, audit runtime cases and const diagnostics');
  } finally {
    await browser?.close(); await new Promise(resolve => server.close(resolve));
    // dir was created with mkdtemp directly below the resolved assets root.
    if (path.dirname(dir) === root) await fs.rm(dir, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
