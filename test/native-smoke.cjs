const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { pack } = require('../tools/pack');
const { Runtime } = require('../Edit/runtime');
(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-native-smoke-'));
  const assetsRoot = path.join(root, 'assets'), scenesRoot = path.join(root, 'scenes');
  await fs.mkdir(assetsRoot, { recursive: true }); await fs.mkdir(scenesRoot, { recursive: true });
  await fs.copyFile(path.resolve(__dirname, '../native/engine_data/ui/dialogue_box.png'), path.join(assetsRoot, 'pixel.png'));
  await fs.writeFile(path.join(assetsRoot, 'broken.wav'), 'not a decodable audio stream');
  await fs.writeFile(path.join(assetsRoot, 'broken.mp4'), 'not a decodable video stream');
  await fs.writeFile(path.join(assetsRoot, 'broken.png'), 'not a decodable image');
  const ffmpeg = process.env.FFMPEG_EXE || 'ffmpeg';
  function encode(args) { const r = spawnSync(ffmpeg, ['-y', '-loglevel', 'error', ...args], { encoding: 'utf8', timeout: 20000 }); assert.equal(r.status, 0, r.stderr || r.error?.message); }
  encode(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.0', path.join(assetsRoot, 'tone.wav')]);
  for (const extension of ['flac', 'ogg', 'mp3']) encode(['-i', path.join(assetsRoot, 'tone.wav'), path.join(assetsRoot, `tone.${extension}`)]);
  for (const extension of ['jpg', 'webp', 'gif']) encode(['-i', path.join(assetsRoot, 'pixel.png'), '-vf', 'scale=160:90', '-frames:v', '1', path.join(assetsRoot, `pixel.${extension}`)]);
  encode(['-f', 'lavfi', '-i', 'color=c=blue:s=160x90:d=0.4:r=25', '-i', path.join(assetsRoot, 'tone.wav'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path.join(assetsRoot, 'clip.mp4')]);
  await fs.writeFile(path.join(scenesRoot, 'audio.tds'), 'fn transition_duration() -> int { return 1000 }');
  const source = `asset bg room = "asset/pixel.png"
asset image first = "asset/pixel.png"
asset image second = "asset/pixel.png"
asset image jpeg = "asset/pixel.jpg"
asset image webp = "asset/pixel.webp"
asset image gif = "asset/pixel.gif"
asset bgm music = "asset/tone.wav"
asset bgm music_alt = "asset/tone.wav"
asset bgm broken_bgm = "asset/broken.wav"
asset se sound = "asset/tone.wav"
asset voice narrator_voice = "asset/tone.wav"
asset se flac = "asset/tone.flac"
asset se vorbis = "asset/tone.ogg"
asset se mpthree = "asset/tone.mp3"
asset video clip = "asset/clip.mp4"
asset video broken_video = "asset/broken.mp4"
include audio.tds as audio
character hero {
  name = "五位殿"
  pose normal = "asset/pixel.png"
}
character friend {
  name = "Friend"
  pose normal = "asset/pixel.png"
}
character ghost {
  name = "Ghost"
  pose normal = "asset/broken.png"
}
int x = 9007199254740993
float shift = 0.5
bg room
bgm music
play bgm music_alt crossfade 900
play se sound
for sound_index from 1 to 12 { play se sound }
play voice narrator_voice blocking
play se flac
play se vorbis
play se mpthree
show image jpeg center
show image webp center
show image gif center
clear image jpeg
clear image webp
clear image gif
show image first left
show image second right
show image first center
show hero.normal left fade 10
choice "sprite replacement" { "test failure" { show ghost.normal left } "continue" { wait 1 } }
choice "successful sprite replacement" { "replace slot" { show friend.normal left } }
show friend.normal right x-(shift * 23.0) y+(shift * 69.0) fade 10
move character friend by x+(7.25) y-(5.25) over 10
move bg by x+(6.5) y-(3.25)
show hero.normal center
clear image first
hide friend
hide hero fade 10
effect fade white 10
play video clip blocking
play video clip async
choice "transition" { "crossfade" { play bgm music_alt crossfade audio.transition_duration()\nplay bgm music crossfade audio.transition_duration()\nwait 60\nplay bgm broken_bgm crossfade audio.transition_duration()\nbgm broken_bgm\nplay video clip async\nplay video broken_video async } "keep" { wait 1 } }
wait 1050
clear bgm
clear bg
say none str(x)
say hero "speaker label parity"
`;
  await fs.writeFile(path.join(scenesRoot, 'main.tds'), source);
  const output = path.join(root, 'package.nsp.json');
  const scenarioPackage = await pack(path.join(scenesRoot, 'main.tds'), output, { scenesRoot, assetsRoot });
  const exe = process.env.NOVEL_NATIVE_EXE || path.resolve(__dirname, '../native/build/Release/novel_player.exe');
  const geometryTest = path.resolve(__dirname, '../native/build/Release/scene_geometry_test.exe');
  const audioTransitionTest = path.resolve(__dirname, '../native/build/Release/audio_transition_test.exe');
  const geometryResult = spawnSync(geometryTest, [], { encoding: 'utf8', timeout: 5000 });
  assert.equal(geometryResult.status, 0, geometryResult.stderr || geometryResult.error?.message);
  assert.match(geometryResult.stdout, /PASS Native presentation geometry\/order/);
  const audioTransitionResult = spawnSync(audioTransitionTest, [], { encoding: 'utf8', timeout: 5000 });
  assert.equal(audioTransitionResult.status, 0, audioTransitionResult.stderr || audioTransitionResult.error?.message);
  assert.match(audioTransitionResult.stdout, /PASS Native BGM crossfade gain/);
  const start = Date.now();
  const child = spawnSync(exe, [output, '--smoke'], { encoding: 'utf8', timeout: 15000, env: { ...process.env, SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy' } });
  assert.equal(child.status, 0, child.stderr || child.error?.message);
  const smokeResult = JSON.parse(child.stdout.trim());
  assert.deepEqual(smokeResult.dialogue, { speaker: '五位殿', text: 'speaker label parity' },
    'Native dialogue must render the Japanese character display name while preserving the dialogue text');
  assert.equal(smokeResult.failedCrossfadeRetained, true, 'a rejected Native BGM crossfade must not stop the playing track');
  assert.equal(smokeResult.failedInstantBgmRetained, true, 'a rejected Native instant BGM replacement must retain the playing track');
  assert.equal(smokeResult.failedVideoReplacementRetained, true, 'a rejected Native video replacement must retain the currently playing decoder');
  assert.equal(smokeResult.failedSpriteReplacementRetained, true, 'a rejected Native sprite replacement must retain the previous character in that slot');
  assert.equal(smokeResult.repeatedImageRaised, true, 'redisplaying an image must raise it above previously shown Native images');
  assert.equal(smokeResult.completedBgmCrossfadeAfterBlockingWait, true, 'a Native BGM fade must reach full gain after its declared duration while remaining non-blocking');
  assert.equal(smokeResult.bgmCrossfadeCompletedDuringBlockingVoice, true, 'Native BGM fade must keep progressing while blocking Voice holds the script');
  assert.equal(smokeResult.relativeCharacterMoveMatched, true, 'Native character move must accumulate fractional show offsets and relative movement');
  assert.equal(smokeResult.relativeBackgroundMoveMatched, true, 'Native background move must preserve fractional pixel offsets');
  assert.equal(smokeResult.characterSlotReplacementMatched, true, 'a selected story branch must replace the character already occupying the target slot');
  const playbackTimings = smokeResult.playbackTimings;
  const playbackTime = (type, mode) => playbackTimings.find(item => item.type === type && item.mode === mode)?.elapsedMs;
  assert.ok(playbackTime('voice', 'blocking') >= 800, `blocking Voice must wait for its 1000ms asset: ${JSON.stringify(playbackTimings)}`);
  assert.ok(playbackTime('se', 'nonblocking') < playbackTime('voice', 'blocking') - 200, `SE must return while its 1000ms asset is still playing: ${JSON.stringify(playbackTimings)}`);
  assert.ok(playbackTime('video', 'blocking') >= 300, `blocking video must wait for its 400ms asset: ${JSON.stringify(playbackTimings)}`);
  assert.ok(playbackTime('video', 'async') < playbackTime('video', 'blocking') - 100, `async video must return before media completion: ${JSON.stringify(playbackTimings)}`);
  const crossfades = playbackTimings.filter(item => item.type === 'bgm' && item.mode === 'crossfade');
  assert.ok(crossfades.length >= 2 && crossfades.every(item => item.elapsedMs < 250), `BGM crossfades must not block on their 1000ms fade: ${JSON.stringify(playbackTimings)}`);
  assert.ok(Date.now() - start >= 800, 'blocking video must wait for playback');
  const lateFailureScenes = path.join(root, 'late-bgm-failure-scenes');
  await fs.mkdir(lateFailureScenes, { recursive: true });
  await fs.writeFile(path.join(lateFailureScenes, 'main.tds'), `asset bgm stable = "asset/tone.wav"
asset bgm simulate_late_failure = "asset/tone.wav"
scene main {
  bgm stable
  play bgm simulate_late_failure crossfade 500
  wait 100
  say narrator "failed incoming track retired outgoing layers"
}`, 'utf8');
  const lateFailurePackagePath = path.join(root, 'late-bgm-failure-package.nsp.json');
  await pack(path.join(lateFailureScenes, 'main.tds'), lateFailurePackagePath, { scenesRoot: lateFailureScenes, assetsRoot });
  const lateBgmFailure = spawnSync(exe, [lateFailurePackagePath, '--smoke'], { encoding: 'utf8', timeout: 10000,
    env: { ...process.env, SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy' } });
  assert.equal(lateBgmFailure.status, 0, lateBgmFailure.stderr || lateBgmFailure.error?.message);
  assert.equal(JSON.parse(lateBgmFailure.stdout).failedIncomingBgmRetiredOutgoing, true,
    'a current BGM track that stops after starting must stop its still-fading outgoing Native layers');
  const browserCommands = [];
  const parityRuntime = new Runtime({ command: async (name, args) => browserCommands.push({ name, args }), choice: async () => 0 });
  await parityRuntime.run(scenarioPackage.program);
  const nativeHeadless = spawnSync(exe, [output, '--headless'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(nativeHeadless.status, 0, nativeHeadless.stderr || nativeHeadless.error?.message);
  const toJsonValue = value => typeof value === 'bigint' ? Number(value) : Array.isArray(value) ? value.map(toJsonValue) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toJsonValue(item)])) : value;
  assert.deepEqual(JSON.parse(nativeHeadless.stdout).commands, toJsonValue(browserCommands), 'Native headless and Browser Runtime must receive the same compiled presentation commands');
  await fs.writeFile(path.join(scenesRoot, 'debug-helper.tds'), 'fn increment(value: int) -> int { return value + 1 }');
  const debugSource = `global int score = 1
global float ratio = 0.5
global str label = "base"
global dict[int] counts = {"key": 1}
global dict[float] weights = {"key": 0.5}
global dict[str] words = {"key": "base"}
struct Pair {
  left: int
  right: float
  label: str
}
Pair pair = {"left": 1, "right": 0.5, "label": "base"}
include debug-helper.tds as helper
scene intro {
  if score >= 0 {
    say narrator "before"
    set score = helper.increment(score)
    say narrator str(score) + ":" + str(ratio) + ":" + label + ":" + str(counts["key"]) + ":" + str(weights["key"]) + ":" + words["key"] + ":" + str(pair.left) + ":" + str(pair.right) + ":" + pair.label
  }
}`;
  const debugPath = path.join(scenesRoot, 'debug-main.tds');
  const debugPackagePath = path.join(root, 'debug-package.nsp.json');
  await fs.writeFile(debugPath, debugSource);
  const debugPackage = await pack(debugPath, debugPackagePath, { scenesRoot, assetsRoot, debug: true });
  const debugStartLine = debugSource.split('\n').findIndex(line => line.trim() === 'set score = helper.increment(score)') + 1;
  const browserLines = [];
  const browserRuntime = new Runtime({ command: async (name, args, runtime) => {
    if (name === 'say') browserLines.push(await runtime.textAsync(args[1]));
  } });
  const debugValues = {
    score: { type: 'int', value: '40' }, ratio: { type: 'float', value: '1.25' },
    label: { type: 'str', value: 'debug' }, counts: { type: 'dict<int>', value: JSON.stringify({ key: '7' }) },
    weights: { type: 'dict<float>', value: JSON.stringify({ key: '3.75' }) },
    words: { type: 'dict<str>', value: JSON.stringify({ key: 'edited' }) },
    pair: { type: 'struct', value: JSON.stringify({ left: '8', right: '2.5', label: 'field' }), fields: { left: 'int', right: 'float', label: 'str' } },
  };
  const browserValues = {
    score: 40n, ratio: 1.25, label: 'debug',
    counts: Object.assign(Object.create(null), { key: 7n }),
    weights: Object.assign(Object.create(null), { key: 3.75 }),
    words: Object.assign(Object.create(null), { key: 'edited' }),
    pair: Object.assign(Object.create(null), { left: 8n, right: 2.5, label: 'field' }),
  };
  await browserRuntime.run(debugPackage.program, { scene: 'intro', line: debugStartLine, variables: browserValues });
  const nativeDebug = spawnSync(exe, [debugPackagePath, '--headless', '--debug-start', 'debug-main.tds', 'intro', String(debugStartLine), JSON.stringify(debugValues)], { encoding: 'utf8', timeout: 10000 });
  assert.equal(nativeDebug.status, 0, nativeDebug.stderr || nativeDebug.error?.message);
  const nativeTranscript = JSON.parse(nativeDebug.stdout);
  assert.deepEqual(nativeTranscript.commands.filter(command => command.name === 'say').map(command => command.args[1]), browserLines);
  assert.deepEqual(browserLines, ['41:1.25:debug:7:3.75:edited:8:2.5:field']);
  assert.equal(nativeTranscript.globals.score, 41);
  const nativeVisualDebug = spawnSync(exe, [debugPackagePath, '--smoke', '--debug-start', 'debug-main.tds', 'intro', String(debugStartLine), JSON.stringify(debugValues)], { encoding: 'utf8', timeout: 10000, env: { ...process.env, SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy' } });
  assert.equal(nativeVisualDebug.status, 0, nativeVisualDebug.stderr || nativeVisualDebug.error?.message);
  const nativeWrapper = spawnSync(process.execPath, [path.resolve(__dirname, '../tools/native.js'), debugPackagePath, '--headless', '--debug-start', 'debug-main.tds', 'intro', String(debugStartLine), JSON.stringify(debugValues)], { encoding: 'utf8', timeout: 10000 });
  assert.equal(nativeWrapper.status, 0, nativeWrapper.stderr || nativeWrapper.error?.message);
  assert.deepEqual(JSON.parse(nativeWrapper.stdout).commands.filter(command => command.name === 'say').map(command => command.args[1]), browserLines);
  const invalidDebug = spawnSync(exe, [debugPackagePath, '--headless', '--debug-start', 'debug-main.tds', 'intro', '99', '{}'], { encoding: 'utf8', timeout: 10000 });
  assert.notEqual(invalidDebug.status, 0, 'invalid start lines must fail consistently rather than silently start elsewhere');
  const malformedDebugString = spawnSync(exe, [debugPackagePath, '--headless', '--debug-start', 'debug-main.tds', 'intro', String(debugStartLine), JSON.stringify({
    label: { type: 'str', value: 7 },
  })], { encoding: 'utf8', timeout: 10000 });
  assert.notEqual(malformedDebugString.status, 0, 'Native debug-start must reject a string override whose serialized value is not a string');
  const loopDebugSource = `global int total = 0
scene main {
  for i from 1 to 3 {
    set total = total + i
    say narrator str(i)
  }
  say narrator str(total)
}
global int outer = 0
global int inner = 0
scene nested {
  while outer < 2 {
    set inner = 0
    for i from 1 to 2 {
      set inner = inner + 1
      say narrator str(outer) + ":" + str(i) + ":" + str(inner)
    }
    set outer = outer + 1
  }
}`;
  const loopDebugPath = path.join(scenesRoot, 'debug-loop.tds');
  const loopDebugPackagePath = path.join(root, 'debug-loop-package.nsp.json');
  await fs.writeFile(loopDebugPath, loopDebugSource);
  const loopDebugPackage = await pack(loopDebugPath, loopDebugPackagePath, { scenesRoot, assetsRoot, debug: true });
  const loopBrowserLines = [];
  const loopBrowser = new Runtime({ command: async (name, args) => { if (name === 'say') loopBrowserLines.push(args[1]); } });
  await loopBrowser.run(loopDebugPackage.program, { scene: 'main', line: 5 });
  const loopNative = spawnSync(exe, [loopDebugPackagePath, '--headless', '--debug-start', 'debug-loop.tds', 'main', '5', '{}'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(loopNative.status, 0, loopNative.stderr || loopNative.error?.message);
  assert.deepEqual(JSON.parse(loopNative.stdout).commands.filter(command => command.name === 'say').map(command => command.args[1]), loopBrowserLines);
  assert.deepEqual(loopBrowserLines, ['1', '2', '3', '5']);
  const nestedBrowserLines = [];
  const nestedBrowser = new Runtime({ command: async (name, args) => { if (name === 'say') nestedBrowserLines.push(args[1]); } });
  await nestedBrowser.run(loopDebugPackage.program, { scene: 'nested', line: 16 });
  const nestedNative = spawnSync(exe, [loopDebugPackagePath, '--headless', '--debug-start', 'debug-loop.tds', 'nested', '16', '{}'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(nestedNative.status, 0, nestedNative.stderr || nestedNative.error?.message);
  assert.deepEqual(JSON.parse(nestedNative.stdout).commands.filter(command => command.name === 'say').map(command => command.args[1]), nestedBrowserLines);
  assert.deepEqual(nestedBrowserLines, ['0:1:0', '0:2:1', '1:1:1', '1:2:2']);
  const lineMatrixSource = `global int count = 0
global int index = 0
scene main {
  say narrator "entry"
  if count == 0 {
    set count = count + 1
    say narrator "then"
  } else {
    say narrator "else"
  }
  choice "choose a path" {
    "loop" {
      for index from 1 to 2 {
        say narrator str(index)
      }
    }
    "direct" { say narrator "direct" }
  }
  while count < 2 {
    set count = count + 1
    say narrator "while" + str(count)
  }
  say narrator "done"
}`;
  const lineMatrixPath = path.join(scenesRoot, 'debug-line-matrix.tds');
  const lineMatrixPackagePath = path.join(root, 'debug-line-matrix-package.nsp.json');
  await fs.writeFile(lineMatrixPath, lineMatrixSource, 'utf8');
  const lineMatrixPackage = await pack(lineMatrixPath, lineMatrixPackagePath, { scenesRoot, assetsRoot, debug: true });
  for (let line = 1; line <= lineMatrixSource.split('\n').length; line++) {
    const browserLineCommands = [];
    const browserLineRuntime = new Runtime({ choice: async () => 0, command: async (name, args) => browserLineCommands.push({ name, args }) });
    let browserSucceeded = true;
    try { await browserLineRuntime.run(lineMatrixPackage.program, { file: 'debug-line-matrix.tds', scene: 'main', line }); }
    catch { browserSucceeded = false; }
    const nativeLine = spawnSync(exe, [lineMatrixPackagePath, '--headless', '--debug-start', 'debug-line-matrix.tds', 'main', String(line), '{}'], { encoding: 'utf8', timeout: 10000 });
    assert.equal(nativeLine.status === 0, browserSucceeded, `Browser and Native must agree whether source line ${line} is executable`);
    if (browserSucceeded) {
      const nativeLineCommands = JSON.parse(nativeLine.stdout).commands.map(({ name, args }) => ({ name, args }));
      assert.deepEqual(nativeLineCommands, toJsonValue(browserLineCommands), `Browser and Native must resolve debug start line ${line} to the same command sequence`);
    }
  }
  for (const invalidLine of [-1, 2.5]) {
    const invalidBrowserRuntime = new Runtime();
    let invalidBrowserRejected = false;
    try { await invalidBrowserRuntime.run(lineMatrixPackage.program, { file: 'debug-line-matrix.tds', scene: 'main', line: invalidLine }); }
    catch { invalidBrowserRejected = true; }
    const invalidNativeLine = spawnSync(exe, [lineMatrixPackagePath, '--headless', '--debug-start', 'debug-line-matrix.tds', 'main', String(invalidLine), '{}'], { encoding: 'utf8', timeout: 10000 });
    assert.notEqual(invalidNativeLine.status, 0, `Native must reject invalid debug start line ${invalidLine}`);
    assert.equal(invalidBrowserRejected, true, `Browser must reject invalid debug start line ${invalidLine} instead of silently starting elsewhere`);
  }
  const wrongFileRuntime = new Runtime();
  let wrongFileRejected = false;
  try { await wrongFileRuntime.run(lineMatrixPackage.program, { file: 'another.tds', scene: 'main', line: 4 }); }
  catch { wrongFileRejected = true; }
  const wrongFileNative = spawnSync(exe, [lineMatrixPackagePath, '--headless', '--debug-start', 'another.tds', 'main', '4', '{}'], { encoding: 'utf8', timeout: 10000 });
  assert.notEqual(wrongFileNative.status, 0, 'Native must reject an executable line that belongs to a different source file');
  assert.equal(wrongFileRejected, true, 'Browser must honor the requested debug source file like Native');
  const choiceLocalSource = `scene local_choice {
  choice "run local setup?" {
    "run" {
      int branchValue = 2
      set branchValue = branchValue + 3
      say narrator "Choice local {branchValue}"
    }
  }
}`;
  const choiceLocalPath = path.join(scenesRoot, 'choice-local.tds');
  const choiceLocalPackagePath = path.join(root, 'choice-local-package.nsp.json');
  await fs.writeFile(choiceLocalPath, choiceLocalSource, 'utf8');
  const choiceLocalPackage = await pack(choiceLocalPath, choiceLocalPackagePath, { scenesRoot, assetsRoot, debug: true });
  const choiceLocalLine = choiceLocalSource.split('\n').findIndex(line => line.includes('say narrator "Choice local')) + 1;
  const choiceLocalBrowserLines = [];
  const choiceLocalBrowser = new Runtime({ command: async (name, args, runtime) => {
    if (name === 'say') choiceLocalBrowserLines.push(await runtime.textAsync(args[1]));
  } });
  await choiceLocalBrowser.run(choiceLocalPackage.program, {
    file: 'choice-local.tds', scene: 'local_choice', line: choiceLocalLine, variables: { branchValue: 5n },
  });
  const choiceLocalNative = spawnSync(exe, [choiceLocalPackagePath, '--headless', '--debug-start', 'choice-local.tds', 'local_choice', String(choiceLocalLine), JSON.stringify({
    branchValue: { type: 'int', value: '5' },
  })], { encoding: 'utf8', timeout: 10000 });
  assert.equal(choiceLocalNative.status, 0, choiceLocalNative.stderr || choiceLocalNative.error?.message);
  assert.deepEqual(JSON.parse(choiceLocalNative.stdout).commands.filter(command => command.name === 'say').map(command => command.args[1]), choiceLocalBrowserLines,
    'Browser and Native debug-start must resolve choice-local declarations to the same explicitly seeded value');
  assert.deepEqual(choiceLocalBrowserLines, ['Choice local 5']);
  const branchScopedSource = `scene branch_scoped {
  choice "select a value type" {
    "number" {
      int token = 7
      say narrator str(token)
    }
    "text" {
      str token = "ready"
      say narrator token
    }
  }
}`;
  const branchScopedPath = path.join(scenesRoot, 'branch-scoped.tds');
  const branchScopedPackagePath = path.join(root, 'branch-scoped-package.nsp.json');
  await fs.writeFile(branchScopedPath, branchScopedSource, 'utf8');
  const branchScopedPackage = await pack(branchScopedPath, branchScopedPackagePath, { scenesRoot, assetsRoot, debug: true });
  const branchScopedLine = branchScopedSource.split('\n').findIndex(line => line.includes('say narrator token')) + 1;
  const branchScopedBrowserLines = [];
  const branchScopedBrowser = new Runtime({ command: async (name, args, runtime) => {
    if (name === 'say') branchScopedBrowserLines.push(await runtime.textAsync(args[1]));
  } });
  await branchScopedBrowser.run(branchScopedPackage.program, {
    file: 'branch-scoped.tds', scene: 'branch_scoped', line: branchScopedLine, variables: { token: 'ready' },
  });
  const branchScopedNative = spawnSync(exe, [branchScopedPackagePath, '--headless', '--debug-start', 'branch-scoped.tds', 'branch_scoped', String(branchScopedLine), JSON.stringify({
    token: { type: 'str', value: 'ready' },
  })], { encoding: 'utf8', timeout: 10000 });
  assert.equal(branchScopedNative.status, 0, branchScopedNative.stderr || branchScopedNative.error?.message);
  assert.deepEqual(JSON.parse(branchScopedNative.stdout).commands.filter(command => command.name === 'say').map(command => command.args[1]), branchScopedBrowserLines,
    'Browser and Native debug-start must select the same same-named local with a branch-specific type');
  assert.deepEqual(branchScopedBrowserLines, ['ready']);
  await fs.writeFile(path.join(scenesRoot, 'timed-helper.tds'), 'fn fade_for(duration: int) -> none { effect fade black duration }');
  const timedSource = `asset bg room = "asset/pixel.png"
asset bgm music = "asset/tone.wav"
asset se click = "asset/tone.wav"
asset voice greeting = "asset/tone.wav"
asset video clip = "asset/clip.mp4"
character timed_hero {
  name = "Timed Hero"
  pose normal = "asset/pixel.png"
}
include timed-helper.tds as timed
global int duration = 45
scene main {
  choice "run timed transition?" {
    "run" {
      bg room
      show timed_hero.normal left fade 10
      move character timed_hero by x+5 y-3 over 10
      play video clip async
      play bgm music crossfade 900
      play se click
      play voice greeting async
      timed.fade_for(duration)
      play voice greeting blocking
    }
    "skip" { wait 1 }
  }
  say narrator "continued after the blocking effect"
  clear bgm
}`;
  const timedPath = path.join(scenesRoot, 'timed-main.tds');
  const timedPackagePath = path.join(root, 'timed-package.nsp.json');
  await fs.writeFile(timedPath, timedSource);
  const timedPackage = await pack(timedPath, timedPackagePath, { scenesRoot, assetsRoot, debug: true });
  const timedChoiceBodyLine = timedSource.split('\n').findIndex(line => line.trim() === '"run" {') + 1;
  const timedBrowserCommands = [];
  let timedBrowserAtDialogue = null;
  const presentationCommandNames = new Set(['bg', 'bgm', 'show', 'hide', 'move', 'play', 'clear', 'effect', 'say', 'wait']);
  const toPresentationSnapshot = state => ({
    logicalTimeMs: state.logicalTimeMs,
    background: state.background ? { asset: state.background.asset, offsetX: state.background.offsetX || 0, offsetY: state.background.offsetY || 0 } : null,
    video: state.video ? { asset: state.video.asset } : null,
    characters: Object.values(state.characters).filter(actor => actor.visible).map(actor => ({
      id: actor.id, pose: actor.pose, slot: actor.slot, opacity: actor.opacity, offsetX: actor.offsetX, offsetY: actor.offsetY, visualOrder: actor.visualOrder,
    })).sort((left, right) => left.id.localeCompare(right.id)),
    images: Object.values(state.images).map(image => ({
      asset: image.asset, slot: image.slot, opacity: 1, offsetX: 0, offsetY: 0, visualOrder: image.visualOrder,
    })).sort((left, right) => left.asset.localeCompare(right.asset)),
    bgm: state.audio.bgm ? { asset: state.audio.bgm.asset, transition: state.audio.bgm.transition.status } : null,
    activeMedia: [...state.audio.se.map(({ asset }) => ({ kind: 'se', asset })), ...state.audio.voices.map(({ asset }) => ({ kind: 'voice', asset }))]
      .sort((left, right) => `${left.kind}:${left.asset}`.localeCompare(`${right.kind}:${right.asset}`)),
    effect: state.effects.find(item => item.transition.status === 'running')?.type || null,
  });
  const failureSource = `asset bg room = "asset/pixel.png"
character hero {
  name = "Hero"
  pose normal = "asset/pixel.png"
}
character ghost {
  name = "Ghost"
  pose normal = "asset/broken.png"
}
scene main {
  bg room
  show hero.normal left
  show ghost.normal left
}`;
  const failureScenesRoot = path.join(root, 'failure-scenes');
  await fs.mkdir(failureScenesRoot, { recursive: true });
  await fs.writeFile(path.join(failureScenesRoot, 'main.tds'), failureSource, 'utf8');
  const failurePackagePath = path.join(root, 'failure-package.nsp.json');
  const failurePackage = await pack(path.join(failureScenesRoot, 'main.tds'), failurePackagePath, { scenesRoot: failureScenesRoot, assetsRoot });
  const failureBrowser = new Runtime({ command: async (name, args) => {
    if (name === 'show' && args[0] === 'ghost.normal') throw new Error('injected sprite decode failure');
  }});
  await assert.rejects(failureBrowser.run(failurePackage.program), /injected sprite decode failure/);
  const failureNative = spawnSync(exe, [failurePackagePath, '--smoke'], { encoding: 'utf8', timeout: 10000, env: { ...process.env, SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy' } });
  assert.equal(failureNative.status, 0, failureNative.stderr || failureNative.error?.message);
  const failureNativeTrace = JSON.parse(failureNative.stdout).presentationTrace;
  assert.deepEqual(failureNativeTrace.at(-1).state, toPresentationSnapshot(failureBrowser.sceneState),
    'Browser SceneState rollback after failed sprite replacement must match the Native renderer state at the same failed-command boundary');
  assert.equal(failureBrowser.sceneState.slots.left, 'hero', 'failed Browser replacement must retain the prior slot occupant');
  const videoFailureSource = `asset video clip = "asset/clip.mp4"
asset video broken_video = "asset/broken.mp4"
scene main {
  play video clip async
  play video broken_video async
}`;
  const videoFailureScenesRoot = path.join(root, 'video-failure-scenes');
  await fs.mkdir(videoFailureScenesRoot, { recursive: true });
  await fs.writeFile(path.join(videoFailureScenesRoot, 'main.tds'), videoFailureSource, 'utf8');
  const videoFailurePackagePath = path.join(root, 'video-failure-package.nsp.json');
  const videoFailurePackage = await pack(path.join(videoFailureScenesRoot, 'main.tds'), videoFailurePackagePath, { scenesRoot: videoFailureScenesRoot, assetsRoot });
  const videoFailureBrowser = new Runtime({ command: async (name, args) => {
    if (name === 'play' && args[0] === 'video' && args[1] === 'broken_video') throw Error('injected video decoder failure');
  } });
  await assert.rejects(videoFailureBrowser.run(videoFailurePackage.program), /injected video decoder failure/);
  assert.equal(videoFailureBrowser.sceneState.video.asset, 'clip', 'failed candidate rollback retains the existing active video');
  const videoFailureNative = spawnSync(exe, [videoFailurePackagePath, '--smoke'], { encoding: 'utf8', timeout: 10000, env: { ...process.env, SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy' } });
  assert.equal(videoFailureNative.status, 0, videoFailureNative.stderr || videoFailureNative.error?.message);
  const videoFailureResult = JSON.parse(videoFailureNative.stdout);
  assert.equal(videoFailureResult.failedVideoReplacementRetained, true);
  assert.deepEqual(videoFailureResult.presentationTrace[1].state, toPresentationSnapshot(videoFailureBrowser.sceneState),
    'failed Browser and Native video replacement must preserve the same active visual at the command boundary');
  const backgroundFailureScenesRoot = path.join(root, 'background-failure-scenes');
  await fs.mkdir(backgroundFailureScenesRoot, { recursive: true });
  const backgroundFailureSource = `asset bg room = "asset/pixel.png"
include presentation.tds as presentation
scene main {
  bg room
  choice "replace background?" {
    "try included replacement" { presentation.fail_background() }
    "keep current" { say narrator "background retained" }
  }
}`;
  await fs.writeFile(path.join(backgroundFailureScenesRoot, 'presentation.tds'),
    'asset bg broken_bg = "asset/broken.png"\nfn fail_background() -> none { bg broken_bg }', 'utf8');
  await fs.writeFile(path.join(backgroundFailureScenesRoot, 'main.tds'), backgroundFailureSource, 'utf8');
  const backgroundFailurePackagePath = path.join(root, 'background-failure-package.nsp.json');
  const backgroundFailurePackage = await pack(path.join(backgroundFailureScenesRoot, 'main.tds'), backgroundFailurePackagePath, { scenesRoot: backgroundFailureScenesRoot, assetsRoot });
  const backgroundFailureBrowser = new Runtime({ choice: async () => 0, command: async (name, args) => {
    if (name === 'bg' && args[0] === 'broken_bg') throw new Error('injected background decode failure');
  }});
  await assert.rejects(backgroundFailureBrowser.run(backgroundFailurePackage.program), /injected background decode failure/);
  const backgroundFailureNative = spawnSync(exe, [backgroundFailurePackagePath, '--smoke'], { encoding: 'utf8', timeout: 10000, env: { ...process.env, SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy' } });
  assert.equal(backgroundFailureNative.status, 0, backgroundFailureNative.stderr || backgroundFailureNative.error?.message);
  const backgroundFailureResult = JSON.parse(backgroundFailureNative.stdout);
  assert.equal(backgroundFailureResult.failedBackgroundReplacementRetained, true, 'Native must retain the original decoded background after replacement failure');
  assert.deepEqual(backgroundFailureResult.presentationTrace[1].state, toPresentationSnapshot(backgroundFailureBrowser.sceneState),
    'Browser SceneState rollback after failed background replacement must match the Native renderer at that command boundary');
  assert.equal(backgroundFailureBrowser.sceneState.background.asset, 'room', 'failed Browser background replacement must retain the prior asset');
  const bgmFailureScenesRoot = path.join(root, 'bgm-failure-scenes');
  await fs.mkdir(bgmFailureScenesRoot, { recursive: true });
  const bgmFailureSource = `asset bgm stable = "asset/tone.wav"
asset bgm broken_bgm = "asset/broken.wav"
scene main {
  bgm stable
  play bgm broken_bgm crossfade 900
  clear bgm
}`;
  await fs.writeFile(path.join(bgmFailureScenesRoot, 'main.tds'), bgmFailureSource, 'utf8');
  const bgmFailurePackagePath = path.join(root, 'bgm-failure-package.nsp.json');
  const bgmFailurePackage = await pack(path.join(bgmFailureScenesRoot, 'main.tds'), bgmFailurePackagePath, { scenesRoot: bgmFailureScenesRoot, assetsRoot });
  const bgmFailureBrowser = new Runtime({ command: async (name, args) => {
    if (name === 'play' && args[0] === 'bgm' && args[1] === 'broken_bgm') throw new Error('injected BGM decode failure');
  }});
  await assert.rejects(bgmFailureBrowser.run(bgmFailurePackage.program), /injected BGM decode failure/);
  const bgmFailureNative = spawnSync(exe, [bgmFailurePackagePath, '--smoke'], { encoding: 'utf8', timeout: 10000, env: { ...process.env, SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy' } });
  assert.equal(bgmFailureNative.status, 0, bgmFailureNative.stderr || bgmFailureNative.error?.message);
  const bgmFailureResult = JSON.parse(bgmFailureNative.stdout);
  assert.equal(bgmFailureResult.failedCrossfadeRetained, true, 'Native must keep the old BGM playing when the crossfade candidate cannot be decoded');
  assert.deepEqual(bgmFailureResult.presentationTrace[1].state, toPresentationSnapshot(bgmFailureBrowser.sceneState),
    'Browser SceneState rollback after failed BGM crossfade must match the actually retained Native track');
  assert.equal(bgmFailureBrowser.sceneState.audio.bgm.asset, 'stable', 'failed Browser crossfade must retain the previous BGM identity');
  const mediaFailureScenesRoot = path.join(root, 'media-failure-scenes');
  await fs.mkdir(mediaFailureScenesRoot, { recursive: true });
  const mediaFailureSource = `asset se broken_se = "asset/broken.wav"
asset voice broken_voice = "asset/broken.wav"
scene main {
  play se broken_se
  play voice broken_voice blocking
  say narrator "continued after failed media starts"
}`;
  await fs.writeFile(path.join(mediaFailureScenesRoot, 'main.tds'), mediaFailureSource, 'utf8');
  const mediaFailurePackagePath = path.join(root, 'media-failure-package.nsp.json');
  const mediaFailurePackage = await pack(path.join(mediaFailureScenesRoot, 'main.tds'), mediaFailurePackagePath, { scenesRoot: mediaFailureScenesRoot, assetsRoot, debug: true });
  const mediaFailureNative = spawnSync(exe, [mediaFailurePackagePath, '--smoke'], { encoding: 'utf8', timeout: 10000, env: { ...process.env, SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy' } });
  assert.equal(mediaFailureNative.status, 0, mediaFailureNative.stderr || mediaFailureNative.error?.message);
  const mediaFailureResult = JSON.parse(mediaFailureNative.stdout);
  assert.equal(mediaFailureResult.failedSePlaybackRejected, true, 'Native must reject an undecodable SE before adding an active track');
  assert.equal(mediaFailureResult.failedVoicePlaybackRejected, true, 'Native must reject an undecodable blocking Voice before waiting');
  const seFailureBrowser = new Runtime({ command: async (name, args) => {
    if (name === 'play' && args[0] === 'se') throw new Error('injected SE decode failure');
  }});
  const seFailureLine = mediaFailureSource.split('\n').findIndex(line => line.trim() === 'play se broken_se') + 1;
  await assert.rejects(seFailureBrowser.run(mediaFailurePackage.program, { scene: 'main', line: seFailureLine }), /injected SE decode failure/);
  assert.deepEqual(mediaFailureResult.presentationTrace[0].state, toPresentationSnapshot(seFailureBrowser.sceneState),
    'Browser rollback after failed SE start must match Native with no live effect track');
  const voiceFailureBrowser = new Runtime({ command: async (name, args) => {
    if (name === 'play' && args[0] === 'voice') throw new Error('injected Voice decode failure');
  }});
  const voiceFailureLine = mediaFailureSource.split('\n').findIndex(line => line.trim() === 'play voice broken_voice blocking') + 1;
  await assert.rejects(voiceFailureBrowser.run(mediaFailurePackage.program, { scene: 'main', line: voiceFailureLine }), /injected Voice decode failure/);
  const mediaFailureDebugNative = spawnSync(exe, [mediaFailurePackagePath, '--smoke', '--debug-start', 'main.tds', 'main', String(voiceFailureLine), '{}'], { encoding: 'utf8', timeout: 10000, env: { ...process.env, SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy' } });
  assert.equal(mediaFailureDebugNative.status, 0, mediaFailureDebugNative.stderr || mediaFailureDebugNative.error?.message);
  assert.deepEqual(JSON.parse(mediaFailureDebugNative.stdout).presentationTrace[0].state, toPresentationSnapshot(voiceFailureBrowser.sceneState),
    'Browser rollback after failed blocking Voice start must match Native at the same nested debug-start boundary');
  const expiryScenesRoot = path.join(root, 'media-expiry-scenes');
  await fs.mkdir(expiryScenesRoot, { recursive: true });
  const expirySource = `asset se sound = "asset/tone.wav"
asset voice greeting = "asset/tone.wav"
scene main {
  play se sound
  play voice greeting async
  wait 1100
  say narrator "both nonblocking tracks ended"
}`;
  await fs.writeFile(path.join(expiryScenesRoot, 'main.tds'), expirySource, 'utf8');
  const expiryPackagePath = path.join(root, 'media-expiry-package.nsp.json');
  const expiryPackage = await pack(path.join(expiryScenesRoot, 'main.tds'), expiryPackagePath, { scenesRoot: expiryScenesRoot, assetsRoot });
  const expiryBrowserTrace = [], expiryBrowserMediaIds = [];
  const expiryBrowser = new Runtime({
    command: async (name, args, runtime, operation) => {
      if (name === 'play' && ['se', 'voice'].includes(args[0])) expiryBrowserMediaIds.push(operation.actionId);
      if (name === 'wait') {
        await new Promise(resolve => setTimeout(resolve, Number(args[0])));
        for (const actionId of expiryBrowserMediaIds) runtime.completeAction(actionId);
      }
    },
    sceneState: (state, operation) => {
      if (presentationCommandNames.has(operation?.name)) expiryBrowserTrace.push({ command: operation.name, state: toPresentationSnapshot(state) });
    },
  });
  await expiryBrowser.run(expiryPackage.program);
  assert.equal(expiryBrowserTrace[1].state.activeMedia.length, 2, 'SE and async Voice must overlap while both are playing');
  assert.equal(expiryBrowserTrace[2].state.logicalTimeMs, 1100, 'Browser wait must advance the presentation clock by its declared duration');
  assert.deepEqual(expiryBrowserTrace[2].state.activeMedia, [], 'completed nonblocking Browser media must leave the active presentation state');
  const expiryNative = spawnSync(exe, [expiryPackagePath, '--smoke'], { encoding: 'utf8', timeout: 10000, env: { ...process.env, SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy' } });
  assert.equal(expiryNative.status, 0, expiryNative.stderr || expiryNative.error?.message);
  assert.deepEqual(JSON.parse(expiryNative.stdout).presentationTrace, expiryBrowserTrace,
    'Native mixer natural completion and Browser media-ended events must agree on overlapping nonblocking SE/Voice and elapsed wait state');
  const effectExpirySource = `asset se sound = "asset/tone.wav"
asset voice greeting = "asset/tone.wav"
scene main {
  play se sound
  play voice greeting async
  effect fade black 1100
  say narrator "media ended during blocking effect"
}`;
  await fs.writeFile(path.join(expiryScenesRoot, 'effect-expiry.tds'), effectExpirySource, 'utf8');
  const effectExpiryPackagePath = path.join(root, 'effect-expiry-package.nsp.json');
  const effectExpiryPackage = await pack(path.join(expiryScenesRoot, 'effect-expiry.tds'), effectExpiryPackagePath, { scenesRoot: expiryScenesRoot, assetsRoot });
  const effectExpiryBrowserTrace = [], effectExpiryMediaIds = [];
  const effectExpiryBrowser = new Runtime({
    command: async (name, args, runtime, operation) => {
      if (name === 'play' && ['se', 'voice'].includes(args[0])) effectExpiryMediaIds.push(operation.actionId);
      if (name === 'effect') {
        await new Promise(resolve => setTimeout(resolve, Number(args.at(-1))));
        for (const actionId of effectExpiryMediaIds) runtime.completeAction(actionId);
      }
    },
    sceneState: (state, operation) => {
      if (presentationCommandNames.has(operation?.name)) effectExpiryBrowserTrace.push({ command: operation.name, state: toPresentationSnapshot(state) });
    },
  });
  await effectExpiryBrowser.run(effectExpiryPackage.program);
  assert.equal(effectExpiryBrowserTrace.at(-1).state.logicalTimeMs, 1100, 'blocking effect advances Browser presentation time by its declared duration');
  assert.deepEqual(effectExpiryBrowserTrace.at(-1).state.activeMedia, [], 'nonblocking SE and Voice complete while Browser awaits the blocking effect');
  const effectExpiryNative = spawnSync(exe, [effectExpiryPackagePath, '--smoke'], { encoding: 'utf8', timeout: 10000, env: { ...process.env, SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy' } });
  assert.equal(effectExpiryNative.status, 0, effectExpiryNative.stderr || effectExpiryNative.error?.message);
  assert.deepEqual(JSON.parse(effectExpiryNative.stdout).presentationTrace, effectExpiryBrowserTrace,
    'Native audio natural completion during a blocking visual effect must match Browser media-ended state and deterministic effect time');
  const midpointScenesRoot = path.join(root, 'animation-midpoint-scenes');
  await fs.mkdir(midpointScenesRoot, { recursive: true });
  const midpointSource = `asset bg room = "asset/pixel.png"
character hero {
  name = "Hero"
  pose normal = "asset/pixel.png"
}
scene main {
  bg room
  show hero.normal center fade 1000
  move character hero by y+40 over 1000
  move bg by y+40 over 1000
  effect fade black 1000
  hide hero fade 1000
}`;
  await fs.writeFile(path.join(midpointScenesRoot, 'main.tds'), midpointSource, 'utf8');
  const midpointPackagePath = path.join(root, 'animation-midpoint-package.nsp.json');
  await pack(path.join(midpointScenesRoot, 'main.tds'), midpointPackagePath, { scenesRoot: midpointScenesRoot, assetsRoot });
  const midpointNative = spawnSync(exe, [midpointPackagePath, '--smoke'], { encoding: 'utf8', timeout: 10000, env: { ...process.env, SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy' } });
  assert.equal(midpointNative.status, 0, midpointNative.stderr || midpointNative.error?.message);
  const midpointSamples = JSON.parse(midpointNative.stdout).animationMidpoints;
  const characterMidpoint = midpointSamples.find(sample => sample.state.characters.some(actor => actor.id === 'hero'));
  assert.ok(characterMidpoint && Math.abs(characterMidpoint.state.characters.find(actor => actor.id === 'hero').opacity - 0.5) <= 0.06,
    `Native character fade must render at half opacity near its linear midpoint: ${JSON.stringify(characterMidpoint)}`);
  assert.ok(characterMidpoint && Math.abs(characterMidpoint.progress - 0.5) <= 0.06,
    `Native character transition clock must be near the Browser SceneState progress midpoint: ${JSON.stringify(characterMidpoint)}`);
  const characterMoveMidpoint = midpointSamples.find(sample => sample.state.characters.some(actor => actor.id === 'hero' && actor.offsetY > 1));
  assert.ok(characterMoveMidpoint && Math.abs(characterMoveMidpoint.state.characters.find(actor => actor.id === 'hero').offsetY - 20) <= 2,
    `Native character y+40 move must render 20px downward at its linear midpoint: ${JSON.stringify(characterMoveMidpoint)}`);
  const backgroundMoveMidpoint = midpointSamples.find(sample => sample.state.background?.offsetY > 1);
  assert.ok(backgroundMoveMidpoint && Math.abs(backgroundMoveMidpoint.state.background.offsetY - 20) <= 2,
    `Native background y+40 move must render 20px downward at its linear midpoint: ${JSON.stringify(backgroundMoveMidpoint)}`);
  const effectMidpoint = midpointSamples.find(sample => sample.state.effect?.type === 'fade');
  assert.ok(effectMidpoint && effectMidpoint.state.effect.color === 'black' && Math.abs(effectMidpoint.state.effect.opacity - 0.5) <= 0.06,
    `Native screen fade must render the right color at half opacity near its linear midpoint: ${JSON.stringify(effectMidpoint)}`);
  const hideMidpoint = midpointSamples.filter(sample => sample.state.characters.some(actor => actor.id === 'hero' && actor.opacity < 0.75)).at(-1);
  assert.ok(hideMidpoint && Math.abs(hideMidpoint.progress - 0.5) <= 0.06
    && Math.abs(hideMidpoint.state.characters.find(actor => actor.id === 'hero').opacity - 0.5) <= 0.06,
    `Native hide transition must render at the same progress and opacity as Browser SceneState: ${JSON.stringify(hideMidpoint)}`);
  const overlapScenesRoot = path.join(root, 'overlap-scenes');
  await fs.mkdir(overlapScenesRoot, { recursive: true });
  const overlapSource = `asset bgm first = "asset/tone.wav"
asset bgm second = "asset/tone.wav"
scene main {
  bgm first
  play bgm second crossfade 100
  effect fade black 500
  clear bgm
}`;
  await fs.writeFile(path.join(overlapScenesRoot, 'main.tds'), overlapSource, 'utf8');
  const overlapPackagePath = path.join(root, 'overlap-package.nsp.json');
  await pack(path.join(overlapScenesRoot, 'main.tds'), overlapPackagePath, { scenesRoot: overlapScenesRoot, assetsRoot });
  const overlapNative = spawnSync(exe, [overlapPackagePath, '--smoke'], { encoding: 'utf8', timeout: 10000, env: { ...process.env, SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy' } });
  assert.equal(overlapNative.status, 0, overlapNative.stderr || overlapNative.error?.message);
  const overlapMidpoint = JSON.parse(overlapNative.stdout).animationMidpoints.find(sample => sample.state.effect?.type === 'fade');
  assert.ok(overlapMidpoint && overlapMidpoint.state.effect.color === 'black' && Math.abs(overlapMidpoint.state.effect.opacity - 0.5) <= 0.06
    && overlapMidpoint.state.bgm?.asset === 'second' && overlapMidpoint.state.bgm.transition === 'complete',
    `Native BGM crossfade must complete independently before the black effect reaches its visual midpoint: ${JSON.stringify(overlapMidpoint)}`);
  const interruptedBgmScenesRoot = path.join(root, 'interrupted-bgm-scenes');
  await fs.mkdir(interruptedBgmScenesRoot, { recursive: true });
  const interruptedBgmSource = `asset bgm first = "asset/tone.wav"
asset bgm second = "asset/tone.wav"
asset bgm third = "asset/tone.wav"
scene main {
  bgm first
  play bgm second crossfade 1000
  wait 400
  play bgm third crossfade 1000
  effect fade black 1000
  clear bgm
}`;
  await fs.writeFile(path.join(interruptedBgmScenesRoot, 'main.tds'), interruptedBgmSource, 'utf8');
  const interruptedBgmPackagePath = path.join(root, 'interrupted-bgm-package.nsp.json');
  await pack(path.join(interruptedBgmScenesRoot, 'main.tds'), interruptedBgmPackagePath, { scenesRoot: interruptedBgmScenesRoot, assetsRoot });
  const interruptedBgmNative = spawnSync(exe, [interruptedBgmPackagePath, '--smoke'], { encoding: 'utf8', timeout: 10000, env: { ...process.env, SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy' } });
  assert.equal(interruptedBgmNative.status, 0, interruptedBgmNative.stderr || interruptedBgmNative.error?.message);
  const interruptedBgmMidpoint = JSON.parse(interruptedBgmNative.stdout).animationMidpoints.find(sample => sample.state.effect?.type === 'fade');
  assert.ok(interruptedBgmMidpoint && Math.abs(interruptedBgmMidpoint.progress - 0.5) <= 0.06,
    `Native effect sample must capture the interrupted crossfade at its midpoint: ${JSON.stringify(interruptedBgmMidpoint)}`);
  assert.ok(interruptedBgmMidpoint && Math.abs(interruptedBgmMidpoint.bgmProgress - 0.5) <= 0.06,
    `Native BGM transition clock must match the Browser audio-clock progress at the replacement midpoint: ${JSON.stringify(interruptedBgmMidpoint)}`);
  const interruptedBgmGains = Object.fromEntries(interruptedBgmMidpoint.bgmLayers.map(({ asset, gain }) => [asset, gain]));
  assert.equal(Object.keys(interruptedBgmGains).length, 3, `all three overlapping Native BGM tracks must be measured: ${JSON.stringify(interruptedBgmMidpoint.bgmLayers)}`);
  for (const [asset, expectedGain] of [['first', 0.3], ['second', 0.2], ['third', 0.5]])
    assert.ok(Math.abs(interruptedBgmGains[asset] - expectedGain) <= 0.04,
      `interrupted Native BGM '${asset}' gain should continue from its pre-replacement envelope: ${JSON.stringify(interruptedBgmMidpoint.bgmLayers)}`);
  const repeatedScenesRoot = path.join(root, 'repeated-presentation-scenes');
  await fs.mkdir(repeatedScenesRoot, { recursive: true });
  const repeatedSource = `asset bg room = "asset/pixel.png"
character hero {
  name = "Hero"
  pose normal = "asset/pixel.png"
  pose smile = "asset/pixel.png"
}
character friend {
  name = "Friend"
  pose normal = "asset/pixel.png"
}
scene main {
  bg room
  show hero.normal left x+4 y-2 fade 20
  move character hero by x+6 y+3 over 20
  move character hero by x-2 y+5 over 20
  move bg by y+10 over 20
  move bg by x-8 y-4 over 20
  show hero.smile right x-3 y+7 fade 20
  show friend.normal right
  show hero.normal left
}`;
  await fs.writeFile(path.join(repeatedScenesRoot, 'main.tds'), repeatedSource, 'utf8');
  const repeatedPackagePath = path.join(root, 'repeated-presentation-package.nsp.json');
  const repeatedPackage = await pack(path.join(repeatedScenesRoot, 'main.tds'), repeatedPackagePath, { scenesRoot: repeatedScenesRoot, assetsRoot });
  const repeatedBrowserTrace = [];
  const repeatedBrowser = new Runtime({
    command: async () => {},
    sceneState: (state, operation) => {
      if (presentationCommandNames.has(operation?.name)) repeatedBrowserTrace.push({ command: operation.name, state: toPresentationSnapshot(state) });
    },
  });
  await repeatedBrowser.run(repeatedPackage.program);
  const repeatedNative = spawnSync(exe, [repeatedPackagePath, '--smoke'], { encoding: 'utf8', timeout: 10000, env: { ...process.env, SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy' } });
  assert.equal(repeatedNative.status, 0, repeatedNative.stderr || repeatedNative.error?.message);
  assert.deepEqual(JSON.parse(repeatedNative.stdout).presentationTrace, repeatedBrowserTrace,
    'repeated shows, same-slot replacement, and accumulated character/background moves must keep Browser scene state and Native renderer state synchronized after each command');
  assert.deepEqual(repeatedBrowser.sceneState.slots, { left: 'hero', center: null, right: 'friend', far_left: null, far_right: null });
  const createTimedBrowserRuntime = (commandLog, trace, onCommandState) => {
    let bgmTransitionId = null;
    const concurrentAudioIds = [];
    return new Runtime({
      command: async (name, args, runtime, operation) => {
        commandLog.push({ name, args });
        if (name === 'play' && args[0] === 'bgm') bgmTransitionId = operation.transitionId;
        if (name === 'play' && args[0] === 'video') setTimeout(() => runtime.completeAction(operation.actionId), 400);
        if (name === 'play' && (args[0] === 'se' || args[0] === 'voice') && args[2] !== 'blocking') concurrentAudioIds.push(operation.actionId);
        if (name === 'play' && args[0] === 'voice' && args[2] === 'blocking') {
          await new Promise(resolve => setTimeout(resolve, 1050));
          if (bgmTransitionId) runtime.completeTransition(bgmTransitionId);
          for (const actionId of concurrentAudioIds) runtime.completeAction(actionId);
        }
      },
      sceneState: (state, operation) => {
        if (presentationCommandNames.has(operation?.name)) {
          trace.push({ command: operation.name, state: toPresentationSnapshot(state) });
          onCommandState?.(operation.name, structuredClone(state));
        }
      },
      choice: async () => 0,
    });
  };
  const timedBrowserTrace = [];
  const timedBrowserStates = {};
  const timedBrowser = createTimedBrowserRuntime(timedBrowserCommands, timedBrowserTrace, (name, state) => { timedBrowserStates[name] = state; });
  await timedBrowser.run(timedPackage.program);
  timedBrowserAtDialogue = timedBrowserStates.say;
  assert.equal(timedBrowserAtDialogue.logicalTimeMs, 65);
  assert.equal(timedBrowserAtDialogue.background.asset, 'room');
  assert.equal(timedBrowserAtDialogue.characters.timed_hero.visible, true);
  assert.deepEqual([timedBrowserAtDialogue.characters.timed_hero.offsetX, timedBrowserAtDialogue.characters.timed_hero.offsetY], [5, -3]);
  assert.equal(timedBrowserAtDialogue.audio.bgm.asset, 'music');
  assert.equal(timedBrowserStates.effect.audio.bgm.transition.status, 'running', 'BGM is still fading at the effect command boundary');
  assert.ok(Object.values(timedBrowserStates.effect.actions).some(action => action.kind === 'se' && action.status === 'running'));
  assert.ok(Object.values(timedBrowserStates.effect.actions).some(action => action.kind === 'voice' && action.blocking === false && action.status === 'running'));
  assert.ok(Object.values(timedBrowserStates.effect.actions).some(action => action.kind === 'effect' && action.blocking && action.status === 'complete'));
  assert.equal(timedBrowserAtDialogue.audio.bgm.transition.status, 'complete', 'BGM fade completes during the subsequent blocking Voice');
  assert.equal(Object.values(timedBrowserAtDialogue.actions).filter(action => ['se', 'voice'].includes(action.kind) && action.status === 'running').length, 0);
  assert.equal(timedBrowser.sceneState.audio.bgm, null, 'the selected scenario explicitly clears its background music after the dialogue');
  const timedNativeHeadless = spawnSync(exe, [timedPackagePath, '--headless'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(timedNativeHeadless.status, 0, timedNativeHeadless.stderr || timedNativeHeadless.error?.message);
  assert.deepEqual(JSON.parse(timedNativeHeadless.stdout).commands, toJsonValue(timedBrowserCommands), 'Native and Browser must follow the same include-selected timed branch and continue after its blocking effect');
  let debugChoiceCalled = false;
  const timedDebugCommands = [];
  const timedDebugTrace = [];
  const timedDebugStates = {};
  const timedDebugBrowser = createTimedBrowserRuntime(timedDebugCommands, timedDebugTrace, (name, state) => { timedDebugStates[name] = state; });
  timedDebugBrowser.host.choice = async () => { debugChoiceCalled = true; return 1; };
  await timedDebugBrowser.run(timedPackage.program, { scene: 'main', line: timedChoiceBodyLine });
  assert.equal(debugChoiceCalled, false, 'starting on a choice branch line should enter that branch directly');
  assert.equal(timedDebugStates.effect.logicalTimeMs, 65);
  assert.equal(timedDebugStates.effect.background.asset, 'room');
  assert.deepEqual([timedDebugStates.effect.characters.timed_hero.offsetX, timedDebugStates.effect.characters.timed_hero.offsetY], [5, -3]);
  assert.equal(timedDebugStates.effect.audio.bgm.transition.status, 'running');
  assert.equal(Object.values(timedDebugStates.effect.actions).filter(action => action.kind === 'se').length, 1);
  assert.equal(Object.values(timedDebugStates.effect.actions).filter(action => action.kind === 'voice' && !action.blocking).length, 1);
  assert.ok(Object.values(timedDebugStates.say.actions).some(action => action.kind === 'voice' && action.blocking && action.status === 'complete'));
  const timedDebugNative = spawnSync(exe, [timedPackagePath, '--headless', '--debug-start', 'timed-main.tds', 'main', String(timedChoiceBodyLine), '{}'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(timedDebugNative.status, 0, timedDebugNative.stderr || timedDebugNative.error?.message);
  assert.deepEqual(JSON.parse(timedDebugNative.stdout).commands, toJsonValue(timedDebugCommands), 'debug-start within a selected choice branch must preserve the include call and timed state change in both runtimes');
  assert.deepEqual(timedDebugCommands.map(({ name, args }) => [name, ...args]), [
    ['bg', 'room'], ['show', 'timed_hero.normal', 'left', 'fade', 10n],
    ['move', 'character', 'timed_hero', 'by', 'x+5', 'y-3', 'over', 10n],
    ['play', 'video', 'clip', 'async'],
    ['play', 'bgm', 'music', 'crossfade', 900n], ['play', 'se', 'click'], ['play', 'voice', 'greeting', 'async'],
    ['effect', 'fade', 'black', 45n], ['play', 'voice', 'greeting', 'blocking'],
    ['say', 'narrator', 'continued after the blocking effect'], ['clear', 'bgm'],
  ]);
  const timedStart = Date.now();
  const timedNativeVisual = spawnSync(exe, [timedPackagePath, '--smoke'], { encoding: 'utf8', timeout: 10000, env: { ...process.env, SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy' } });
  const timedElapsed = Date.now() - timedStart;
  assert.equal(timedNativeVisual.status, 0, timedNativeVisual.stderr || timedNativeVisual.error?.message);
  assert.ok(timedElapsed >= 800, `the debug branch must wait for its blocking Voice after the included effect (observed ${timedElapsed}ms)`);
  const timedDebugStart = Date.now();
  const timedDebugVisual = spawnSync(exe, [timedPackagePath, '--smoke', '--debug-start', 'timed-main.tds', 'main', String(timedChoiceBodyLine), '{}'], { encoding: 'utf8', timeout: 10000, env: { ...process.env, SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy' } });
  const timedDebugElapsed = Date.now() - timedDebugStart;
  assert.equal(timedDebugVisual.status, 0, timedDebugVisual.stderr || timedDebugVisual.error?.message);
  assert.ok(timedDebugElapsed >= 800, `debug-start inside the choice branch must wait for blocking Voice after the included effect (observed ${timedDebugElapsed}ms)`);
  const timedDebugPlayback = JSON.parse(timedDebugVisual.stdout);
  assert.equal(timedDebugPlayback.bgmCrossfadeCompletedDuringBlockingVoice, true, 'the nonblocking BGM transition must complete while the start-line branch waits for Voice');
  assert.ok(timedDebugPlayback.playbackTimings.some(item => item.type === 'voice' && item.mode === 'blocking' && item.elapsedMs >= 800), 'the selected debug branch must block for the Voice asset');
  assert.deepEqual(timedDebugTrace, timedDebugPlayback.presentationTrace,
    'Browser SceneState and Native rendered state must match after every debug-start command, including logical time, visible sprites, active audio, transitions and clears');
  const blockingVoiceLine = timedSource.split('\n').findIndex(line => line.trim() === 'play voice greeting blocking') + 1;
  assert.ok(blockingVoiceLine > 0, 'the timed fixture must retain a source line for its blocking Voice command');
  const voiceStartCommands = [], voiceStartTrace = [];
  const voiceStartStates = {};
  const voiceStartBrowser = createTimedBrowserRuntime(voiceStartCommands, voiceStartTrace, (name, state) => { voiceStartStates[name] = state; });
  let voiceStartChoiceCalled = false;
  voiceStartBrowser.host.choice = async () => { voiceStartChoiceCalled = true; return 0; };
  await voiceStartBrowser.run(timedPackage.program, { scene: 'main', line: blockingVoiceLine });
  assert.equal(voiceStartChoiceCalled, false, 'a start line inside the selected choice body must bypass the choice prompt');
  assert.deepEqual(voiceStartCommands.map(({ name, args }) => [name, ...args]), [
    ['play', 'voice', 'greeting', 'blocking'], ['say', 'narrator', 'continued after the blocking effect'], ['clear', 'bgm'],
  ], 'starting at the blocking Voice line must skip earlier timed effects but retain following scene commands');
  assert.ok(Object.values(voiceStartStates.play.actions).some(action => action.kind === 'voice' && action.blocking && action.status === 'complete'),
    'debug-start must wait for and complete the selected blocking Voice');
  const voiceStartNativeStart = Date.now();
  const voiceStartNative = spawnSync(exe, [timedPackagePath, '--smoke', '--debug-start', 'timed-main.tds', 'main', String(blockingVoiceLine), '{}'], { encoding: 'utf8', timeout: 10000, env: { ...process.env, SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy' } });
  assert.equal(voiceStartNative.status, 0, voiceStartNative.stderr || voiceStartNative.error?.message);
  assert.ok(Date.now() - voiceStartNativeStart >= 800, 'Native debug-start must block for the selected Voice asset');
  assert.deepEqual(JSON.parse(voiceStartNative.stdout).presentationTrace, voiceStartTrace,
    'starting directly at a nested blocking media command must match Browser state through its continuation and cleanup');
  const transferScenesRoot = path.join(root, 'debug-transfer-scenes');
  await fs.mkdir(transferScenesRoot, { recursive: true });
  await fs.writeFile(path.join(transferScenesRoot, 'effects.tds'), `
fn fade_black(duration: int) -> none { effect fade black duration }
fn fade_white(duration: int) -> none { effect fade white duration }
`, 'utf8');
  const transferMainSource = `asset bg room = "asset/pixel.png"
asset bgm music = "asset/tone.wav"
include "effects.tds" as fx
character hero {
  name = "Hero"
  pose normal = "asset/pixel.png"
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
  const transferNextSource = `asset se click = "asset/tone.wav"
asset voice greeting = "asset/tone.wav"
include "effects.tds" as fx
scene next {
  move character hero by y+8 over 20
  play se click
  play voice greeting async
  fx.fade_white(1100)
  say narrator "transferred presentation state retained"
  clear bgm
}`;
  const transferMainPath = path.join(transferScenesRoot, 'main.tds');
  await fs.writeFile(transferMainPath, transferMainSource, 'utf8');
  await fs.writeFile(path.join(transferScenesRoot, 'next.tds'), transferNextSource, 'utf8');
  const transferPackagePath = path.join(root, 'debug-transfer-package.nsp.json');
  const transferPackage = await pack(transferMainPath, transferPackagePath, { scenesRoot: transferScenesRoot, assetsRoot, debug: true });
  const transferLine = transferMainSource.split('\n').findIndex(line => line.trim() === 'bg room') + 1;
  const transferBrowserTrace = [], transferMediaIds = [];
  let transferChoiceCalled = false;
  let transferBgmId = null;
  const transferBrowser = new Runtime({
    load: async target => transferPackage.files[target],
    choice: async () => { transferChoiceCalled = true; return 0; },
    command: async (name, args, runtime, operation) => {
      if (name === 'play' && args[0] === 'bgm') transferBgmId = operation.transitionId;
      if (name === 'play' && ['se', 'voice'].includes(args[0])) transferMediaIds.push(operation.actionId);
      if (name === 'effect') {
        const duration = Number(args[2] ?? 500);
        await new Promise(resolve => setTimeout(resolve, duration));
        if (transferBgmId && duration >= 900) runtime.completeTransition(transferBgmId);
        for (const actionId of transferMediaIds) runtime.completeAction(actionId);
      }
    },
    sceneState: (state, operation) => {
      if (presentationCommandNames.has(operation?.name)) transferBrowserTrace.push({ command: operation.name, state: toPresentationSnapshot(state) });
    },
  });
  await transferBrowser.run(transferPackage.program, { file: 'main.tds', scene: 'main', line: transferLine });
  assert.equal(transferChoiceCalled, false, 'debug-start inside a choice body bypasses the prompt before crossing the file boundary');
  assert.equal(transferBrowser.sceneState.background.asset, 'room', 'debug-start state survives the external file transfer');
  assert.equal(transferBrowser.sceneState.characters.hero.offsetY, 8, 'the destination file continues moving the sprite created before transfer');
  assert.equal(transferBrowser.sceneState.logicalTimeMs, 1165, 'only blocking transitions across both files advance the deterministic scene clock');
  assert.deepEqual(toPresentationSnapshot(transferBrowser.sceneState).activeMedia, [], 'completed nonblocking SE and Voice leave the active-media set after the destination effect');
  assert.ok(Object.values(transferBrowser.sceneState.actions).filter(action => ['se', 'voice'].includes(action.kind)).every(action => action.status === 'complete'),
    'the retained media history marks both nonblocking tracks complete rather than deleting their audit records');
  const transferNative = spawnSync(exe, [transferPackagePath, '--smoke', '--debug-start', 'main.tds', 'main', String(transferLine), '{}'], { encoding: 'utf8', timeout: 15000, env: { ...process.env, SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy' } });
  assert.equal(transferNative.status, 0, transferNative.stderr || transferNative.error?.message);
  assert.deepEqual(JSON.parse(transferNative.stdout).presentationTrace, transferBrowserTrace,
    'debug-start must preserve background, sprite, BGM transition, naturally ended SE/Voice, and blocking-effect time across external goto in Browser and Native');
  console.log(`PASS native SDL smoke: Voice ${playbackTime('voice', 'blocking')}ms blocking, SE ${playbackTime('se', 'nonblocking')}ms nonblocking, video ${playbackTime('video', 'blocking')}ms blocking/${playbackTime('video', 'async')}ms async, BGM crossfade ${crossfades.map(item => `${item.elapsedMs}ms`).join('/')}; debug-start parity`);
  await fs.rm(root, { recursive: true, force: true });
})().catch(e => { console.error(e); process.exitCode = 1; });
