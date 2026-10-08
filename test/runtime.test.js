const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const zlib = require('node:zlib');
const { parse, compile, analyzeScript, sceneReachability } = require('../dist');
const { Runtime, createSceneState } = require('../Edit/runtime');
const { validate: validateEditorSource, compileSource: compileEditorSource } = require('../Edit/server');
const { pack, validateVariableFlow } = require('../tools/pack');
const { compileProject, resolveProjectScript } = require('../tools/project');
const { readStaticVariables } = require('../tools/static-variables');
const { seedEmptyProject, projectLayout } = require('../tools/project-layout');
const { RUNTIME_STATE_APIS, IDE_ANALYSIS_RULES } = require('../dist/language/builtins');
const program = source => JSON.parse(JSON.stringify(compile(parse(source))));
function nativePackage(program, overrides = {}) {
  const source = program.sourceFile || 'main.tds';
  return {
    format: 'novel-script-package', version: 1, source, program,
    files: { [source]: program }, native_ui: {}, ...overrides,
  };
}
async function nativeExecutableForTest(t) {
  if (process.env.NOVEL_NATIVE_EXE) {
    await fs.access(process.env.NOVEL_NATIVE_EXE);
    return process.env.NOVEL_NATIVE_EXE;
  }
  const local = path.resolve(__dirname, '../native/build/Release/novel_player.exe');
  try { await fs.access(local); return local; }
  catch { t.skip('Build the native player or set NOVEL_NATIVE_EXE to enable parity checks'); return null; }
}
function tinyPng() {
  const crc32 = bytes => {
    let value = 0xffffffff;
    for (const byte of bytes) {
      value ^= byte;
      for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    }
    return (value ^ 0xffffffff) >>> 0;
  };
  const chunk = (name, data) => {
    const type = Buffer.from(name);
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(Buffer.concat([type, data])));
    return Buffer.concat([length, type, data, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4);
  header[8] = 8; header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(Buffer.from([0, 255, 255, 255, 255]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
function tinyWav() {
  const samples = Buffer.alloc(80);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + samples.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22); header.writeUInt32LE(8000, 24); header.writeUInt32LE(8000, 28);
  header.writeUInt16LE(1, 32); header.writeUInt16LE(8, 34); header.write('data', 36);
  header.writeUInt32LE(samples.length, 40); samples.fill(128);
  return Buffer.concat([header, samples]);
}
async function run(source, host = {}) {
  const rt = new Runtime({ command: async () => {}, choice: async () => 0, ...host });
  await rt.run(program(source)); return rt;
}

test('optimizer retains code after a range loop that may execute zero times', () => {
  const compiled = program('fn f(start: int, stop: int) -> none {\nfor i from start to stop { return }\nsay narrator "after"\n}');
  assert.deepEqual(compiled.functions[0].body.map(instruction => instruction.op), ['for', 'command']);
});

test('resuming at a scene skips a top-level start call but preserves later scene start calls', async () => {
  const source = 'start()\nscene main {\n  say narrator "resume target"\n  start()\n  say narrator "after resumed start"\n}';
  const script = parse(source);
  const compiled = compile(script);
  const starts = [], dialogue = [];
  const resumed = new Runtime({ start: async () => starts.push('screen'), command: async (name, args) => { if (name === 'say') dialogue.push(args[1]); } });
  await resumed.run(compiled, { scene: 'main', line: script.scenes[0].body[0].line });
  assert.deepEqual(starts, ['screen'], 'only the explicit start() reached after the restored scene position is shown');
  assert.deepEqual(dialogue, ['resume target', 'after resumed start']);

  const normalStarts = [];
  const normal = new Runtime({ start: async () => normalStarts.push('screen'), command: async () => {} });
  await normal.run(compiled);
  assert.deepEqual(normalStarts, ['screen', 'screen'], 'normal entry still executes both top-level and scene-level start calls');
});

test('dynamic --layer values compile and are range checked when the command executes', async () => {
  const source = 'asset image logo = "asset/logo.png"\nfloat layer = 0.1234\nscene main { show image logo center --layer layer }';
  const compiled = program(source);
  assert.equal(compiled.scenes[0].instructions[0].name, 'show');
  await assert.rejects(
    new Runtime({ command: async () => {} }).run(compiled),
    /layer/,
    'the runtime rejects a dynamically evaluated value that exceeds the 0.001 precision contract',
  );
});

test('resuming at a scene suppresses start reached indirectly during global initialization', async () => {
  const source = `fn initialize() -> bool {
  start()
  return true
}
global bool initialized = initialize()
scene main {
  say narrator "resumed"
}`;
  const script = parse(source);
  const starts = [], dialogue = [];
  const runtime = new Runtime({
    start: async () => starts.push('screen'),
    command: async (name, args) => { if (name === 'say') dialogue.push(args[1]); },
  });
  await runtime.run(compile(script), { scene: 'main', line: script.scenes[0].body[0].line });
  assert.equal(runtime.globals.initialized, true, 'global initialization still runs on resume');
  assert.deepEqual(starts, [], 'an indirect top-level start must not replay before the selected scene');
  assert.deepEqual(dialogue, ['resumed']);
});

test('initial screen opens after globals have been initialized', async () => {
  const source = 'global int ready = 7\nstart()\nscene main { say narrator str(ready) }';
  let readyAtScreenOpen;
  const runtime = new Runtime({
    start: async activeRuntime => { readyAtScreenOpen = activeRuntime.globals.ready; },
    command: async () => {},
  });
  await runtime.run(program(source));
  assert.equal(readyAtScreenOpen, 7n, 'the screen callback observes initialized globals before the first scene runs');
});

test('start inside a called function suspends before the caller continues', async () => {
  const events = [];
  const rt = new Runtime({
    start: async () => events.push('screen'),
    command: async (name, args) => { if (name === 'say') events.push(args[1]); },
  });
  await rt.run(program('fn title() -> str { start()\nreturn "Title" }\nscene main { say narrator title() }'));
  assert.deepEqual(events, ['screen', 'Title']);
});

test('runtime.state.characters exposes current presentation occupancy with shared Browser and Native semantics', async t => {
  const existsApi = RUNTIME_STATE_APIS.get('runtime.state.characters.exists');
  const backgroundApi = RUNTIME_STATE_APIS.get('runtime.state.background.current');
  const bgmApi = RUNTIME_STATE_APIS.get('runtime.state.audio.current_bgm');
  const variablesApi = RUNTIME_STATE_APIS.get('runtime.state.variables.names');
  const moveRule = IDE_ANALYSIS_RULES.characterMoveRequiresPresence;
  assert.deepEqual(existsApi.effects, { reads: ['characters'], writes: [] });
  assert.deepEqual(existsApi.compile.predicate, { kind: 'membership', domain: 'characters', argument: 0, positiveMeans: 'present' });
  assert.equal(moveRule.domain, existsApi.compile.predicate.domain);
  assert.equal(moveRule.requiredFact, existsApi.compile.predicate.positiveMeans);
  assert.equal(moveRule.guardApi, 'runtime.state.characters.exists');
  assert.deepEqual(backgroundApi.effects, { reads: ['background'], writes: [] });
  assert.deepEqual(bgmApi.effects, { reads: ['audio.bgm'], writes: [] });
  assert.deepEqual(variablesApi.returns, { kind: 'list', value: 'str' });
  assert.deepEqual(variablesApi.effects, { reads: ['variables'], writes: [] });
  const source = `
asset bg placeholder = "asset/placeholder.png"
asset bgm theme = "asset/theme.wav"
character ayase {
  name = "Ayase"
  pose normal = "asset/placeholder.png"
}
character mio {
  name = "Mio"
  pose normal = "asset/placeholder.png"
}
character zara {
  name = "Zara"
  pose normal = "asset/placeholder.png"
}
global bool initially_present = runtime.state.characters.exists("ayase")
global list[str] initially_present_characters = runtime.state.characters.list()
global str initial_position = runtime.state.characters.position("ayase")
global bool background_at_entry = runtime.state.background.exists()
global str background_at_entry_id = runtime.state.background.current()
global bool bgm_at_entry = runtime.state.audio.bgm_exists()
global str bgm_at_entry_id = runtime.state.audio.current_bgm()
global str execution_scene_at_entry = runtime.state.execution.current_scene()
global int execution_line_at_entry = runtime.state.execution.current_line()
global str execution_file_at_entry = runtime.state.execution.current_file()
global float dialog_opacity_at_entry = runtime.state.ui.dialog_opacity()
global float bgm_volume_at_entry = runtime.state.audio.volume("bgm")
global float se_volume_at_entry = runtime.state.audio.volume("se")
global float voice_volume_at_entry = runtime.state.audio.volume("voice")
global bool watched_global_exists = runtime.state.variables.exists("initially_present")
global bool future_global_exists = runtime.state.variables.exists("names_in_scene")
global bool found_after_show = false
global bool found_missing = true
global list[str] after_show = []
global str position_after_show = ""
global bool background_after_set = false
global str background_after_set_id = ""
global bool bgm_after_set = false
global str bgm_after_set_id = ""
global bool background_after_clear = true
global bool bgm_after_clear = true
global str execution_scene_in_scene = ""
global int execution_line_in_scene = 0
global str execution_file_in_scene = ""
global float dialog_opacity_after_set = 0.0
global float bgm_volume_after_set = 0.0
global float se_volume_after_set = 0.0
global float voice_volume_after_set = 0.0
global bool function_parameter_exists = false
global bool missing_variable_exists = true
global list[str] names_in_scene = []
fn sees_parameter(name: str) -> bool { return runtime.state.variables.exists(name) }
global bool dynamic_move_succeeded = false
global list[str] after_slot_replacement = []
global list[str] after_hide = []
global list[str] after_hide_all = []
fn move_if_present(id: str) -> bool {
  if runtime.state.characters.exists(id) {
    move character (id) by x+1
    return true
  }
  return false
}
scene main {
  set execution_scene_in_scene = runtime.state.execution.current_scene()
  set execution_line_in_scene = runtime.state.execution.current_line()
  set execution_file_in_scene = runtime.state.execution.current_file()
  dialog opacity 0.65
  volume bgm 0.35
  volume se 0.25
  volume voice 0.75
  set dialog_opacity_after_set = runtime.state.ui.dialog_opacity()
  set bgm_volume_after_set = runtime.state.audio.volume("bgm")
  set se_volume_after_set = runtime.state.audio.volume("se")
  set voice_volume_after_set = runtime.state.audio.volume("voice")
  set function_parameter_exists = sees_parameter("name")
  set missing_variable_exists = runtime.state.variables.exists("not_declared")
  set names_in_scene = runtime.state.variables.names()
  bg placeholder
  set background_after_set = runtime.state.background.exists()
  set background_after_set_id = runtime.state.background.current()
  bgm theme
  set bgm_after_set = runtime.state.audio.bgm_exists()
  set bgm_after_set_id = runtime.state.audio.current_bgm()
  clear bg
  clear bgm
  set background_after_clear = runtime.state.background.exists()
  set bgm_after_clear = runtime.state.audio.bgm_exists()
  show zara.normal left
  show ayase.normal right
  set found_after_show = runtime.state.characters.exists("ayase")
  set found_missing = runtime.state.characters.exists("ghost")
  set after_show = runtime.state.characters.list()
  set position_after_show = runtime.state.characters.position("ayase")
  set dynamic_move_succeeded = move_if_present("ayase")
  show mio.normal left
  set after_slot_replacement = runtime.state.characters.list()
  hide ayase
  set after_hide = runtime.state.characters.list()
  hide mio
  set after_hide_all = runtime.state.characters.list()
  say narrator str(dialog_opacity_at_entry) + "|" + str(bgm_volume_at_entry) + "|" + str(runtime.state.ui.dialog_opacity()) + "|" + str(runtime.state.audio.volume("bgm"))
}`;
  const compiled = program(source);
  const executionLine = source.split('\n').findIndex(line => line.includes('set execution_line_in_scene =')) + 1;
  const browser = await run(source);
  assert.equal(browser.get('initially_present'), false);
  assert.deepEqual(browser.get('initially_present_characters'), []);
  assert.equal(browser.get('initial_position'), '');
  assert.equal(browser.get('background_at_entry'), false);
  assert.equal(browser.get('background_at_entry_id'), '');
  assert.equal(browser.get('bgm_at_entry'), false);
  assert.equal(browser.get('bgm_at_entry_id'), '');
  assert.equal(browser.get('execution_scene_at_entry'), '');
  assert.equal(browser.get('execution_file_at_entry'), '');
  assert.equal(browser.get('dialog_opacity_at_entry'), 1);
  assert.equal(browser.get('bgm_volume_at_entry'), 1);
  assert.equal(browser.get('se_volume_at_entry'), 1);
  assert.equal(browser.get('voice_volume_at_entry'), 0.5);
  assert.equal(browser.get('watched_global_exists'), true);
  assert.equal(browser.get('future_global_exists'), false, 'global initializers execute in declaration order, not via a pre-populated table');
  assert.equal(browser.get('execution_scene_in_scene'), 'main');
  assert.equal(typeof browser.get('execution_file_in_scene'), 'string');
  assert.equal(browser.get('execution_line_in_scene'), BigInt(executionLine));
  assert.equal(browser.get('dialog_opacity_after_set'), 0.65);
  assert.equal(browser.get('bgm_volume_after_set'), 0.35);
  assert.equal(browser.get('se_volume_after_set'), 0.25);
  assert.equal(browser.get('voice_volume_after_set'), 0.75);
  assert.equal(browser.get('function_parameter_exists'), true);
  assert.equal(browser.get('missing_variable_exists'), false);
  assert.ok(browser.get('names_in_scene').includes('initially_present'));
  assert.deepEqual(browser.get('names_in_scene'), [...browser.get('names_in_scene')].sort());
  assert.equal(browser.get('background_after_set'), true);
  assert.equal(browser.get('background_after_set_id'), 'placeholder');
  assert.equal(browser.get('bgm_after_set'), true);
  assert.equal(browser.get('bgm_after_set_id'), 'theme');
  assert.equal(browser.get('background_after_clear'), false);
  assert.equal(browser.get('bgm_after_clear'), false);
  assert.equal(browser.get('found_after_show'), true);
  assert.equal(browser.get('found_missing'), false);
  assert.deepEqual(browser.get('after_show'), ['ayase', 'zara']);
  assert.equal(browser.get('position_after_show'), 'right');
  assert.equal(browser.get('dynamic_move_succeeded'), true);
  assert.deepEqual(browser.get('after_slot_replacement'), ['ayase', 'mio']);
  assert.deepEqual(browser.get('after_hide'), ['mio']);
  assert.deepEqual(browser.get('after_hide_all'), []);
  assert.deepEqual(Object.values(browser.sceneState.slots).filter(Boolean), []);

  assert.throws(() => program('global bool bad = runtime.state.characters.exists(1)'), /\u7b2c 1 \u5f15\u6570\u306f str \u578b\u3067\u6307\u5b9a\u3057\u3066\u304f\u3060\u3055\u3044/);
  assert.throws(() => program('global list[str] bad = runtime.state.characters.list("extra")'), /\u306e\u5f15\u6570\u306f 0 \u500b\u5fc5\u8981\u3067\u3059/);
  assert.throws(() => program('global str bad = runtime.state.characters.position(1)'), /\u7b2c 1 \u5f15\u6570\u306f str \u578b\u3067\u6307\u5b9a\u3057\u3066\u304f\u3060\u3055\u3044/);
  await assert.rejects(new Runtime({ command: async () => {} }).run(program('global float bad = runtime.state.audio.volume("master")')), /bgm\u3001se\u3001voice/);
  assert.throws(() => program('global bool bad = runtime.state.background.exists("extra")'), /\u306e\u5f15\u6570\u306f 0 \u500b\u5fc5\u8981\u3067\u3059/);
  assert.throws(() => program('global str bad = runtime.state.background.current("extra")'), /\u306e\u5f15\u6570\u306f 0 \u500b\u5fc5\u8981\u3067\u3059/);
  assert.throws(() => program('global bool bad = runtime.state.characters.unknown()'), /unknown|未定義の関数/i);

  assert.throws(() => program('global bool bad = compile.characters.always_visible("ayase")'), /unknown|未定義の関数/i,
    'compile analysis is not a callable game-runtime namespace');
  assert.throws(() => program('global bool bad = ide.warning("example")'), /unknown|未定義の関数/i,
    'IDE diagnostics are not executable scenario functions');
  const exe = await nativeExecutableForTest(t);
  if (!exe) return;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-runtime-state-parity-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const assetsRoot = path.join(root, 'asset'), scenesRoot = path.join(root, 'senario');
  await fs.mkdir(assetsRoot); await fs.mkdir(scenesRoot);
  await fs.writeFile(path.join(assetsRoot, 'placeholder.png'), tinyPng());
  await fs.writeFile(path.join(assetsRoot, 'theme.wav'), tinyWav());
  const scenario = path.join(scenesRoot, 'main.tds');
  await fs.writeFile(scenario, source);
  const packagePath = path.join(root, 'runtime-state.nsp.json');
  await pack(scenario, packagePath, { scenesRoot, assetsRoot });
  const packagedBrowser = new Runtime({ command: async () => {}, choice: async () => 0 });
  await packagedBrowser.run(JSON.parse(await fs.readFile(packagePath, 'utf8')).program);
  const native = spawnSync(exe, [packagePath, '--headless'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(native.status, 0, native.stderr || native.error?.message);
  const nativeGlobals = JSON.parse(native.stdout).globals;
  for (const name of [
    'initially_present', 'initially_present_characters', 'initial_position',
    'background_at_entry', 'background_at_entry_id', 'bgm_at_entry', 'bgm_at_entry_id',
    'execution_scene_at_entry', 'execution_line_at_entry', 'execution_file_at_entry',
    'execution_scene_in_scene', 'execution_line_in_scene', 'execution_file_in_scene',
    'dialog_opacity_at_entry', 'bgm_volume_at_entry', 'se_volume_at_entry', 'voice_volume_at_entry',
    'dialog_opacity_after_set', 'bgm_volume_after_set', 'se_volume_after_set', 'voice_volume_after_set',
    'watched_global_exists', 'future_global_exists', 'function_parameter_exists', 'missing_variable_exists', 'names_in_scene',
    'background_after_set', 'background_after_set_id', 'bgm_after_set', 'bgm_after_set_id',
    'background_after_clear', 'bgm_after_clear', 'found_after_show', 'found_missing', 'after_show', 'position_after_show',
    'dynamic_move_succeeded', 'after_slot_replacement', 'after_hide', 'after_hide_all',
  ]) {
    const browserValue = packagedBrowser.get(name);
    assert.deepEqual(nativeGlobals[name], name === 'execution_line_at_entry' || name === 'execution_line_in_scene' ? Number(browserValue) : browserValue,
      `Native and Browser runtime API result diverged for ${name}`);
  }
  assert.equal(typeof nativeGlobals.execution_file_in_scene, 'string');
  assert.deepEqual(nativeGlobals.after_show, ['ayase', 'zara'], 'list() order is identifier-sorted and stable across runtimes');
  const engineSmoke = spawnSync(exe, [packagePath, '--smoke'], {
    encoding: 'utf8', timeout: 15000,
    env: { ...process.env, SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy' },
  });
  assert.equal(engineSmoke.status, 0, engineSmoke.stderr || engineSmoke.error?.message);
  assert.equal(JSON.parse(engineSmoke.stdout).dialogue.text, '1|1|0.65|0.35',
    'the actual Native player provider reads project defaults and scenario-overridden UI/audio state');
});

test('background and BGM presence predicates refine only facts proven by direct commands', () => {
  const source = `
asset bg room = "asset/room.png"
asset bgm theme = "asset/theme.wav"
global bool uncertain = false
fn maybe_clear() -> none { if uncertain { clear bg } }
fn maybe_clear_music() -> none { if uncertain { clear bgm } }
scene main {
  clear bg
  if runtime.state.background.exists() { move character "ghost" by x+1 }
  bg room
  if runtime.state.background.exists() { move character "ghost" by x+1 }
  maybe_clear()
  if runtime.state.background.exists() { move character "ghost" by x+1 }
  bgm theme
  if runtime.state.audio.bgm_exists() { move character "ghost" by x+1 }
  clear bgm
  if runtime.state.audio.bgm_exists() { move character "ghost" by x+1 }
  bgm theme
  maybe_clear_music()
  if runtime.state.audio.bgm_exists() { move character "ghost" by x+1 }
}`;
  const diagnostics = analyzeScript(parse(source));
  assert.equal(diagnostics.filter(item => item.code === 'move-unshown-character').length, 4,
    'direct state writes prove present/absent branches; a function with possible writes invalidates the proof');
  assert.ok(diagnostics.some(item => item.code === 'unreachable-runtime-state-branch'),
    'IDE diagnostics expose branches disproven by proven runtime-state facts');
});

test('variable-binding predicates respect declaration order and lexical frames without guessing future globals', async () => {
  const source = `
global int initialized_from_early_call = read_later()
fn read_later() -> int {
  if runtime.state.variables.exists("later_global") { return 1 } else { return 0 }
}
fn parameter_is_visible(name: str) -> none {
  if runtime.state.variables.exists("name") { wait 1 } else { say narrator "impossible" }
}
global int later_global = 2
scene main {
  int scene_local = 3
  if runtime.state.variables.exists("later_global") { wait 1 } else { say narrator "impossible" }
  if runtime.state.variables.exists("scene_local") { wait 1 } else { say narrator "impossible" }
}`;
  const diagnostics = analyzeScript(parse(source)).filter(item => item.code === 'unreachable-runtime-state-branch');
  assert.equal(diagnostics.length, 3,
    'the declared global, scene local, and function parameter are known; a function called before a later global declaration remains unknown');
  const ideReport = await validateEditorSource(`int known = 1
scene main {
  if runtime.state.variables.exists("known") { wait 1 } else { wait 2 }
}`, 'runtime-state-ide.tds');
  assert.ok(ideReport.diagnostics.some(item => item.code === 'unreachable-runtime-state-branch' && item.severity === 'info'),
    'the editor validation path exposes the analyzer fact as an IDE diagnostic');
});

test('variable-binding facts do not escape choice-local frames', () => {
  const source = `
scene main {
  if not runtime.state.variables.exists("choice_local") {
    choice {
      "first" { int choice_local = 1 }
      "second" { int choice_local = 2 }
    }
    if runtime.state.variables.exists("choice_local") { wait 1 } else { say narrator "still absent" }
  }
}`;
  const diagnostics = analyzeScript(parse(source)).filter(item => item.code === 'unreachable-runtime-state-branch');
  assert.equal(diagnostics.length, 1, 'only the outer else is impossible; choice-local declarations do not escape their runtime frame');
});

test('bool, typed lists, for-in, indexing, and text intrinsics share precise value semantics', async () => {
  const source = `
global bool active = true
global list[int] values = [1, 2, 3]
global list[str] pieces = text.split(",a,,b,", ",")
global str normalized = text.normalize_space("  a\t\u00a0b　 ")
global str trimmed = text.trim("  keep\t spacing　 ")
global str replaced = text.replace("red red", "red", "blue")
global list[int] removalSource = [1, 2, 1, 3]
global list[int] removed = list.remove_all(removalSource, 1)
global str joined = text.join(["", "x", ""], "|")
global list[int] empty = []
global int total = 0
fn sum(items: list[int]) -> int {
  int result = 0
  for item in items { set result = result + item }
  return result
}
scene main {
  set values[1] = 4
  set values = list.append(values, 7)
  for value in values { set total = total + value }
  set active = not active
  set empty = list.append(empty, 9)
  say narrator str(sum(values))
}`;
  let dialogue;
  const runtime = await run(source, { command: async (name, args) => { if (name === 'say') dialogue = args[1]; } });
  assert.equal(runtime.get('active'), false);
  assert.deepEqual(runtime.get('values'), [1n, 4n, 3n, 7n]);
  assert.deepEqual(runtime.get('pieces'), ['', 'a', '', 'b', '']);
  assert.deepEqual(runtime.get('empty'), [9n]);
  assert.deepEqual(runtime.get('removed'), [2n, 3n]);
  assert.deepEqual(runtime.get('removalSource'), [1n, 2n, 1n, 3n], 'list.remove_all preserves its input');
  assert.equal(runtime.get('joined'), '|x|');
  assert.equal(runtime.get('normalized'), 'a b');
  assert.equal(runtime.get('trimmed'), 'keep\t spacing');
  assert.equal(runtime.get('replaced'), 'blue blue');
  assert.equal(runtime.get('total'), 15n);
  assert.equal(dialogue, '15');
  assert.throws(() => program('global list[int] values = []\nscene main { set values = list.append(values, "bad") }'), /list\.append|type/i);
  assert.throws(() => program('global list[str] values = text.split("x", "")'), /text\.split \u306e\u533a\u5207\u308a\u6587\u5b57\u5217\u306f\u7a7a\u306b\u3067\u304d\u307e\u305b\u3093/);
  assert.throws(() => program('global str value = text.replace("x", "", "y")'), /text\.replace \u306e\u691c\u7d22\u6587\u5b57\u5217\u306f\u7a7a\u306b\u3067\u304d\u307e\u305b\u3093/);
  assert.throws(() => program('global list[int] invalid = list.remove_all([1], "1")'), /list\[str\]/);
  assert.throws(() => program('global str invalid = text.join([1], ",")'), /list\[str\]/);
  await assert.rejects(run('global list[int] values = [1]\nscene main { say narrator str(values[1]) }'), /\u7bc4\u56f2\u5916/);
});

test('list.remove_all and text.join preserve the 100,000-iteration ceiling in Browser and Native', async t => {
  const exe = await nativeExecutableForTest(t);
  if (!exe) return;
  const compiled = program('global list[int] removed = list.remove_all([], 1)\nglobal str joined = text.join([], "|")\nscene main { }');
  const removal = compiled.globals.find(item => item.name === 'removed').initial;
  const join = compiled.globals.find(item => item.name === 'joined').initial;
  const setSize = size => {
    removal.args[0].items = Array.from({ length: size }, (_, index) => ({ kind: 'integer', value: index % 2 ? '1' : '2' }));
    join.args[0].items = Array.from({ length: size }, () => ({ kind: 'literal', value: '' }));
  };
  const file = path.join(os.tmpdir(), `novel-linear-intrinsics-${process.pid}.nsp.json`);
  t.after(() => fs.rm(file, { force: true }));
  setSize(100000);
  await fs.writeFile(file, JSON.stringify(nativePackage(compiled)));
  const browser = new Runtime();
  await browser.run(compiled);
  assert.equal(browser.get('removed').length, 50000);
  assert.equal(browser.get('joined').length, 99999);
  const native = spawnSync(exe, [file, '--headless'], { encoding: 'utf8', timeout: 15000 });
  assert.equal(native.status, 0, native.stderr || native.error?.message);
  const nativeGlobals = JSON.parse(native.stdout).globals;
  assert.equal(nativeGlobals.removed.length, 50000);
  assert.equal(nativeGlobals.joined.length, 99999);

  setSize(100001);
  await fs.writeFile(file, JSON.stringify(nativePackage(compiled)));
  const limitMessage = 'loop の実行回数が上限の100,000回を超えました';
  await assert.rejects(new Runtime().run(compiled), error => error.message === limitMessage);
  const overLimit = spawnSync(exe, [file, '--headless'], { encoding: 'utf8', timeout: 15000 });
  assert.equal(overLimit.status, 1);
  assert.equal(overLimit.stderr.trim(), `Player error: ${limitMessage}`);
});

test('float expressions remain distinct from exact int and drive pixel offsets', async () => {
  const seen = [];
  const source = `
float phase = 0.5
float delta = 0.0
character hero {
  name = "Hero"
  pose normal = "asset/hero.png"
}
fn scale(x: float) -> float { return x * 2.0 }
scene main {
  set delta = scale(phase) + 0.25
  show hero.normal center x+(delta * 2.0) y-(float(3))
  move character hero by x+(delta) y-2 over 16
  say narrator str(delta)
}`;
  const rt = await run(source, { command: async (name, args) => seen.push({ name, args }) });
  assert.equal(rt.get('phase'), 0.5);
  assert.deepEqual(seen.find((item) => item.name === 'show').args.slice(2), ['x+', 2.5, 'y-', 3]);
  assert.deepEqual(seen.find((item) => item.name === 'move').args.slice(3), ['x+', 1.25, 'y-2', 'over', 16n]);
  assert.equal(seen.find((item) => item.name === 'say').args[1], '1.25');
  await assert.rejects(run('float bad = 1.0\nscene main { set bad = bad / 0.0 }'), /zero|0/);
  assert.throws(() => program('float bad = 1 + 0.5\nscene main { wait 1 }'), /型|type/i);
});

test('debug start inside a for loop resumes the selected first iteration and preserves subsequent iterations', async () => {
  const source = `global int total = 0
scene main {
  for i from 1 to 3 {
    set total = total + i
    say narrator str(i)
  }
  say narrator str(total)
}`;
  const lines = [];
  const runtime = new Runtime({ command: async (name, args) => { if (name === 'say') lines.push(args[1]); } });
  await runtime.run(program(source), { scene: 'main', line: 5 });
  assert.deepEqual(lines, ['1', '2', '3', '5']);
  assert.equal(runtime.get('total'), 5n);
});

test('save boundary rejects snapshots while a user function is executing', async () => {
  const script = program(`fn helper() -> none {
  say narrator "inside helper"
}
scene main {
  helper()
}`);
  let rejectedInsideFunction = false;
  const runtime = new Runtime({
    command: async () => {},
    beforeInstruction(_instruction, activeRuntime) {
      if (activeRuntime.functionCallDepth > 0) {
        assert.throws(() => activeRuntime.assertSaveBoundary(), /\u95a2\u6570\u306e\u5b9f\u884c\u4e2d\u306f\u4fdd\u5b58\u3067\u304d\u307e\u305b\u3093/);
        rejectedInsideFunction = true;
      } else activeRuntime.assertSaveBoundary();
    },
  });
  await runtime.run(script);
  assert.equal(rejectedInsideFunction, true);
  assert.equal(runtime.functionCallDepth, 0, 'the function depth is cleared after return');
  assert.doesNotThrow(() => runtime.assertSaveBoundary());
});

test('save boundary rejects snapshots in range, foreach and while loops', async () => {
  const script = program(`global int condition = 1
global list[int] values = [1]
scene main {
  for i from 1 to 1 { say narrator "range" }
  for item in values { say narrator "foreach" }
  while condition > 0 {
    set condition = 0
    say narrator "while"
  }
}`);
  const rejectedInstructions = [];
  const runtime = new Runtime({
    command: async () => {},
    beforeInstruction(instruction, activeRuntime) {
      if (activeRuntime.loopDepth > 0) {
        assert.throws(() => activeRuntime.assertSaveBoundary(), /loop\u306e\u5b9f\u884c\u4e2d\u306f\u4fdd\u5b58\u3067\u304d\u307e\u305b\u3093/);
        rejectedInstructions.push({ line: instruction.line, op: instruction.op, name: instruction.name });
      } else activeRuntime.assertSaveBoundary();
    },
  });
  await runtime.run(script);
  assert.equal(rejectedInstructions.filter(instruction => instruction.op === 'command' && instruction.name === 'say').length, 3,
    'range, foreach and while bodies all reject saves');
  assert.ok(rejectedInstructions.some(instruction => instruction.op === 'set'), 'the while condition update is also within the active loop boundary');
  assert.equal(runtime.loopDepth, 0, 'loop depth is cleared after completion');
  assert.doesNotThrow(() => runtime.assertSaveBoundary(), 'saving is available again outside the loops');
});

test('debug start inside nested while and for loops retains both loop scopes', async () => {
  const source = `global int outer = 0
global int inner = 0
scene main {
  while outer < 2 {
    set inner = 0
    for i from 1 to 2 {
      set inner = inner + 1
      say narrator str(outer) + ":" + str(i) + ":" + str(inner)
    }
    set outer = outer + 1
  }
}`;
  const lines = [];
  const runtime = new Runtime({ command: async (name, args) => { if (name === 'say') lines.push(args[1]); } });
  await runtime.run(program(source), { scene: 'main', line: 8 });
  assert.deepEqual(lines, ['0:1:0', '0:2:1', '1:1:1', '1:2:2']);
});

test('restored SceneState retains arrays for transitions, effects, and concurrent media state', async () => {
  const sceneState = createSceneState();
  sceneState.transfers.push({ target: 'saved', external: false, at: 12 });
  sceneState.effects.push({ type: 'fade', blocking: false });
  sceneState.audio.se.push({ asset: 'click', actionId: 'se-1' });
  sceneState.audio.volumes.bgm = 0.24;
  sceneState.ui.dialogOpacity = 0.42;
  let restored;
  const runtime = new Runtime({
    command: async () => {},
    sceneState: async (state, event) => { if (event.name === 'restore') restored = state; },
  });
  runtime.configurePresentationDefaults({ audio: { bgm: 0.9 }, dialog: { opacity: 0.8 } });
  await runtime.run(program('scene main { wait 1 }'), { scene: 'main', sceneState });
  assert.ok(Array.isArray(restored.transfers));
  assert.ok(Array.isArray(restored.effects));
  assert.ok(Array.isArray(restored.audio.se));
  assert.equal(restored.audio.volumes.bgm, 0.24, 'saved channel volume wins over the current presentation default');
  assert.equal(restored.ui.dialogOpacity, 0.42, 'saved dialogue opacity survives resume');
  assert.deepEqual(restored.transfers[0], { target: 'saved', external: false, at: 12 });

  const legacyState = createSceneState();
  delete legacyState.audio.volumes;
  delete legacyState.ui.dialogOpacity;
  let legacyRestored;
  const legacyRuntime = new Runtime({ sceneState: async (state, event) => { if (event.name === 'restore') legacyRestored = state; } });
  legacyRuntime.configurePresentationDefaults({ audio: { bgm: 0.9 }, dialog: { opacity: 0.8 } });
  await legacyRuntime.run(program('scene main {}'), { scene: 'main', sceneState: legacyState });
  assert.equal(legacyRestored.audio.volumes.bgm, 0.9, 'legacy snapshots without channel values inherit current defaults');
  assert.equal(legacyRestored.ui.dialogOpacity, 0.8, 'legacy snapshots without dialogue opacity inherit current defaults');
});

test('save cursor restoration preserves active choice-local values after the declaration line', async () => {
  const source = `scene main {
  choice "continue?" {
    "yes" {
      int local_value = 7
      say narrator str(local_value)
      say narrator str(local_value + 1)
    }
  }
}`;
  const compiled = program(source);
  let savedLine = 0;
  let savedLocals = [];
  let savedReadonlyLocals = [];
  const firstPass = new Runtime({ choice: async () => 0, command: async (name, args) => {}, beforeInstruction(instruction) {
    if (instruction.op === 'command' && instruction.name === 'say' && !savedLine) {
      savedLine = instruction.line;
      savedLocals = firstPass.frames.slice(1).map(frame => ({ ...frame }));
      savedReadonlyLocals = firstPass.frames.slice(1).map(frame => [...(firstPass.readonlyFrames.get(frame) || [])]);
    }
  } });
  await firstPass.run(compiled);
  const resumedLines = [];
  const resumed = new Runtime({ choice: async () => 0, command: async (name, args) => { if (name === 'say') resumedLines.push(args[1]); } });
  await resumed.run(compiled, {
    file: compiled.scenes[0].file, scene: compiled.scenes[0].name, line: savedLine, variables: firstPass.globals,
    locals: savedLocals, readonlyLocals: savedReadonlyLocals,
  });
  assert.deepEqual(resumedLines, ['7', '8']);
});

test('native and browser agree on float arithmetic, conversion and overflow', async t => {
  const exe = await nativeExecutableForTest(t);
  if (!exe) return;
  const source = `float ratio = 0.5
float result = 0.0
int truncated = 0
str display = ""
str tiny = ""
str medium = ""
str wide = ""
str signed = ""
scene main {
  set result = (ratio + 0.25) * 2.0
  set truncated = int(-result)
  set display = str(result)
  set tiny = str(1e-7)
  set medium = str(1e-5)
  set wide = str(1e20)
  set signed = str(float("+1.25"))
}`;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-float-parity-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'float.nsp.json');
  await fs.writeFile(file, JSON.stringify(nativePackage(program(source))));
  const native = spawnSync(exe, [file, '--headless'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(native.status, 0, native.stderr || native.error?.message);
  const browser = await run(source);
  const actual = JSON.parse(native.stdout).globals;
  assert.equal(actual.result, browser.get('result'));
  assert.equal(actual.truncated, Number(browser.get('truncated')));
  assert.equal(actual.display, browser.get('display'));
  assert.equal(actual.tiny, browser.get('tiny'));
  assert.equal(actual.medium, browser.get('medium'));
  assert.equal(actual.wide, browser.get('wide'));
  assert.equal(actual.signed, browser.get('signed'));
  const invalid = 'float result = 1.0\nscene main { set result = result / 0.0 }';
  await fs.writeFile(file, JSON.stringify(nativePackage(program(invalid))));
  assert.equal(spawnSync(exe, [file, '--headless'], { timeout: 10000 }).status, 1);
  await assert.rejects(run(invalid));
});

test('float static variable table retains finite bounds and exact initial value', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-float-table-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataRoot = path.join(root, '.novel');
  await fs.mkdir(dataRoot);
  const file = path.join(dataRoot, 'variables.json');
  await fs.writeFile(file, JSON.stringify({ staticVariables: [{ name: 'ratio', type: 'float', value: 0.5, min: 0, max: 1, possibleValues: [0.5, 0.75] }] }));
  const data = await readStaticVariables(dataRoot);
  assert.equal(data.declarations[0].initial.value, '0.5');
  assert.deepEqual([...data.table.constraints.get('ratio').values], [0.5, 0.75]);
  const scenesRoot = path.join(root, 'senario');
  const assetsRoot = path.join(root, 'asset');
  await fs.mkdir(scenesRoot);
  await fs.mkdir(assetsRoot);
  const sceneFile = path.join(scenesRoot, 'main.tds');
  await fs.writeFile(sceneFile, 'scene main { if ratio > 0.75 { say narrator "unreachable" } else { say narrator str(ratio) } }');
  const packed = await pack(sceneFile, path.join(root, 'float.nsp.json'), { scenesRoot, assetsRoot, dataRoot });
  assert.equal(packed.program.variables.find((variable) => variable.name === 'ratio')?.type, 'float');
  assert.deepEqual(packed.program.scenes.find((scene) => scene.name === 'main').instructions.map((instruction) => instruction.op), ['command']);
  await fs.writeFile(file, JSON.stringify({ staticVariables: [{ name: 'ratio', type: 'float', value: 'Infinity' }] }));
  await assert.rejects(readStaticVariables(dataRoot), /有限/);
});

test('float works in character fields, structs, dictionaries and conversion boundaries', async () => {
  const source = `struct Vector { dx: float }
character hero {
  name = "Hero"
  height = 1.75
  pose normal = "asset/hero.png"
}
dict[float] gains = { "left": 0.25 }
Vector vector = { "dx": 0.5 }
float result = 0.0
scene main {
  set result = hero.height + gains["left"] + vector.dx
}`;
  assert.equal((await run(source)).get('result'), 2.5);
  assert.equal((await run('float result = float("+1.25")\nscene main { wait 1 }')).get('result'), 1.25);
  assert.equal((await run('int result = int(-1.9)\nscene main { wait 1 }')).get('result'), -1n);
  await assert.rejects(run('int result = int(1e20)\nscene main { wait 1 }'), /overflow|範囲|int/i);
});

test('walk.character drives its requested distance and gait over exactly two seconds', async t => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-walk-cycle-'));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  seedEmptyProject(projectRoot);
  const { scenesRoot, assetsRoot } = projectLayout(projectRoot);
  const source = `include "std/motion/walk.tds" as walk
character rei {
  name = "Rei"
  pose normal = "asset/char/rei.png"
}
scene main {
  show rei.normal center
  walk.character("rei", 144.0, 1, 2.0, 5.0)
}
`;
  await fs.writeFile(path.join(scenesRoot, 'main.tds'), source, 'utf8');
  await fs.writeFile(path.join(assetsRoot, 'char/rei.png'), tinyPng());
  const compiled = await compileProject(source, assetsRoot, scenesRoot, new Map(), new Map(), 'main.tds');
  const moves = [];
  const runtime = new Runtime({ command: async (name, args) => { if (name === 'move') moves.push(args); } });
  await runtime.run(compiled);
  assert.equal(moves.length, 8);
  let actualX = 0;
  let actualY = 0;
  let lowestY = 0;
  for (let index = 0; index < moves.length; index++) {
    const args = moves[index];
    assert.deepEqual(args.slice(0, 4), ['character', 'rei', 'by', 'x+']);
    assert.equal(args[5], 'y+');
    assert.equal(args[7], 'over');
    assert.equal(typeof args[8], 'bigint');
    actualX += args[4];
    actualY += args[6];
    assert.ok(index !== 0 || args[6] > 0, 'the first gait segment moves downward');
    lowestY = Math.max(lowestY, actualY);
    assert.ok(actualY >= -1e-9, 'the gait never rises above its starting height');
    assert.ok(Number.isFinite(Number(args[4])) && Number.isFinite(Number(args[6])), `walk frame ${index + 1} has finite deltas`);
  }
  assert.ok(Math.abs(actualX - 144) < 1e-9, 'horizontal deltas sum to the requested distance');
  assert.ok(Math.abs(actualY) < 1e-8, 'the walk returns to its starting vertical position');
  assert.ok(Math.abs(lowestY - 5) < 1e-8, 'the downward step reaches the configured bob amplitude');
  assert.equal(moves.reduce((duration, args) => duration + Number(args[8]), 0), 2000, 'segment durations sum to the requested 2 seconds');
  const exe = await nativeExecutableForTest(t);
  if (exe) {
    const packagePath = path.join(projectRoot, 'walk.nsp.json');
    await pack(path.join(scenesRoot, 'main.tds'), packagePath, { projectRoot, scenesRoot, assetsRoot });
    const child = spawnSync(exe, [packagePath, '--headless'], { encoding: 'utf8', timeout: 10000 });
    assert.equal(child.status, 0, child.stderr || child.error?.message);
    const output = JSON.parse(child.stdout);
    assert.equal(output.commands.filter(command => command.name === 'move').length, 8);
    assert.equal(output.commands.filter(command => command.name === 'move').reduce((duration, command) => duration + Number(command.args[8]), 0), 2000);
    const start = Date.now();
    const visibleRun = spawnSync(exe, [packagePath, '--smoke'], {
      encoding: 'utf8', timeout: 10000,
      env: { ...process.env, SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy' },
    });
    assert.equal(visibleRun.status, 0, visibleRun.stderr || visibleRun.error?.message);
    assert.ok(Date.now() - start >= 1900, 'native presentation loop must spend the authored 2 seconds rendering the walk');
  }
});

test('editor validation and compile share the source-file contract', async () => {
  const source = 'scene editor_contract {\n  wait 1\n}';
  const report = await validateEditorSource(source, 'editor-contract.tds');
  assert.equal(report.ok, true);
  assert.ok(Array.isArray(report.diagnostics));
  const compiled = await compileEditorSource(source, 'editor-contract.tds');
  assert.ok(compiled.scenes.some((scene) => scene.name === 'editor_contract'));
});

test('editor compile excludes the file being edited from cross-file declarations', async () => {
  const source = 'int i = 1\nscene main {\n  wait 1\n}';
  const report = await validateEditorSource(source, 'main.tds');
  assert.equal(report.ok, true, report.error);
  const compiled = await compileEditorSource(source, 'main.tds');
  assert.equal(compiled.variables.find((variable) => variable.name === 'i')?.type, 'int');
  assert.equal(compiled.globals.find((statement) => statement.name === 'i')?.initial.value, '1');
});

test('editor validation returns file-aware syntax diagnostics before compilation', async () => {
  const report = await validateEditorSource('scene broken {\n  wait (\n}', 'broken-editor.tds');
  assert.equal(report.ok, false);
  assert.ok(report.diagnostics.some((diagnostic) => diagnostic.code === 'syntax-error'));
  assert.ok(report.diagnostics.every((diagnostic) => diagnostic.file === 'broken-editor.tds'));
});

test('editor validation locates syntax errors in included source files', async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-included-diagnostic-'));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  seedEmptyProject(projectRoot);
  const { scenesRoot } = projectLayout(projectRoot);
  await fs.writeFile(path.join(scenesRoot, 'main.tds'), 'include broken.tds as broken\nscene main { wait 1 }', 'utf8');
  await fs.writeFile(path.join(scenesRoot, 'broken.tds'), 'fn broken() -> none {\n  wait (\n}', 'utf8');
  const serverPath = path.resolve(__dirname, '../Edit/server.js');
  const childSource = `require(${JSON.stringify(serverPath)}).validate('include broken.tds as broken\\nscene main { wait 1 }', 'main.tds').then(report => process.stdout.write(JSON.stringify(report)))`;
  const child = spawnSync(process.execPath, ['-e', childSource], {
    encoding: 'utf8',
    env: { ...process.env, NOVEL_PROJECT_ROOT: projectRoot },
  });
  assert.equal(child.status, 0, child.stderr);
  const report = JSON.parse(child.stdout);
  const diagnostic = report.diagnostics.find((item) => item.code === 'syntax-error');
  assert.ok(diagnostic, JSON.stringify(report));
  assert.equal(diagnostic.file, 'broken.tds');
  assert.deepEqual([diagnostic.line, diagnostic.column], [2, 9]);
  assert.ok(diagnostic.endColumn > diagnostic.column);
});

test('editor validation rejects unsupported timed voice modes', async () => {
  const report = await validateEditorSource('asset voice greeting = "asset/missing.wav"\nplay voice greeting later', 'voice-contract.tds');
  assert.equal(report.ok, false);
  assert.ok(report.diagnostics.some((diagnostic) => diagnostic.severity === 'error' && /voice|blocking|async/i.test(diagnostic.message)));
});

test('editor project diagnostics retain the source column of a missing asset', async () => {
  const source = 'asset bg missing = "asset/missing-background.png"';
  const report = await validateEditorSource(source, 'asset-location.tds');
  const diagnostic = report.diagnostics.find((item) => item.code === 'project-error');
  assert.ok(diagnostic);
  assert.equal(diagnostic.line, 1);
  assert.equal(diagnostic.column, source.indexOf('asset/missing-background.png') + 1);
  assert.equal(diagnostic.endColumn, diagnostic.column + 'asset/missing-background.png'.length);
});

test('editor project diagnostics locate missing goto and include targets', async () => {
  const gotoSource = 'scene start {\n  goto "missing-scene.tds"\n}';
  const gotoReport = await validateEditorSource(gotoSource, 'missing-goto.tds');
  const gotoDiagnostic = gotoReport.diagnostics.find((item) => item.code === 'project-error');
  assert.ok(gotoDiagnostic);
  assert.equal(gotoDiagnostic.line, 2);
  assert.equal(gotoDiagnostic.column, gotoSource.split(/\r?\n/)[1].indexOf('missing-scene.tds') + 1);
  assert.equal(gotoDiagnostic.endColumn, gotoDiagnostic.column + 'missing-scene.tds'.length);

  const includeSource = 'include "missing-include.tds" as missing\nscene start { wait 1 }';
  const includeReport = await validateEditorSource(includeSource, 'missing-include.tds');
  const includeDiagnostic = includeReport.diagnostics[0];
  assert.equal(includeDiagnostic.code, 'project-error');
  assert.equal(includeDiagnostic.line, 1);
  assert.equal(includeDiagnostic.column, includeSource.indexOf('missing-include.tds') + 1);
  assert.equal(includeDiagnostic.endColumn, includeDiagnostic.column + 'missing-include.tds'.length);
});

test('editor validation keeps independent asset diagnostics beside type errors', async () => {
  const source = 'asset bg missing = "asset/missing-background.png"\nsay narrator unknown_value';
  const report = await validateEditorSource(source, 'mixed-errors.tds');
  assert.deepEqual(report.diagnostics.map((item) => [item.code, item.line]), [
    ['project-error', 1],
    ['type-error', 2],
  ]);
});
const scenario = `
int outer = 99
str result = ""
int changed = 0
dict[int] data = { "one": 1 }
fn calculate() -> int {
  int outer = 2
  int local = 0
  if outer == 2 {
    set local = 3
  }
  return outer + local
}
fn early() -> none {
  if 1 == 1 { return }
  set changed = 100
}
fn zero() -> int {
  if 1 == 1 { return 0 }
  set changed = 200
  return 1
}
set changed = 7
scene start {
  early()
  zero()
  for outer from 2 to 0 step -1 {
    set changed = changed + 1
  }
  set result = str(calculate()) + ":" + str(outer) + ":" + str(changed)
  choice "prompt" {
    "choose" {
      int choice_value = 5
      set result = result + ":" + str(choice_value)
      goto ending
    }
  }
  set result = "unreachable"
}
scene ending {
  unset data["one"]
  set data["two"] = 2
  set result = result + ":" + str(data["two"])
}
`;
test('JSON round trip preserves integer boundaries and arithmetic', async () => {
  const rt = await run('int a = 9007199254740992 + 1\nint b = -9223372036854775808\nstr c = str(a)');
  assert.equal(rt.get('a'), 9007199254740993n);
  assert.equal(rt.get('b'), -(1n << 63n));
  assert.equal(rt.get('c'), '9007199254740993');
  await assert.rejects(run('int a = 9223372036854775807 + 1'), /overflow|オーバーフロー/);
});
test('functions execute statements, preserve lexical scope and return falsy values', async () => {
  const rt = await run(scenario);
  assert.equal(rt.get('result'), '5:99:10:5:2');
  assert.throws(() => rt.get('choice_value'), /未定義/);
  assert.equal(rt.frames.length, 1);
});
test('runtime rejects malformed conversions, inherited dictionary keys and missing returns', async t => {
  await assert.rejects(run('int a = int("12abc")'), /conversion error/);
  await assert.rejects(run('dict[int] d = {"a": 1}\nint x = d["toString"]'), /dict key 'toString' が見つかりません/);
  const exe = await nativeExecutableForTest(t);
  if (exe) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-native-dict-key-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'missing-dict-key.nsp.json');
    const compiled = program('dict[int] d = {"a": 1}\nfn readMissing() -> int { return d["toString"] }\nscene main { readMissing() }');
    await fs.writeFile(file, JSON.stringify(nativePackage(compiled)));
    const native = spawnSync(exe, [file, '--headless'], { encoding: 'utf8', timeout: 10000 });
    assert.equal(native.status, 1);
    assert.equal(native.stderr.trim(), "Player error: dict key 'toString' が見つかりません");
  }
  await assert.rejects(run('fn f() -> int {\n}\nint x = f()'), /値を返し/);
  await assert.rejects(run('for i from 0 to 2 step -1 {\n}'), /step/);
});
test('dictionary interpolation uses the same JSON representation as the native runtime', async () => {
  const rt = await run('dict[int] values = { "one": 1 }');
  assert.equal(rt.text('{values}'), '{"one":1}');
});
test('list interpolation uses JSON arrays and matches the native runtime', async t => {
  const rt = await run('list[int] values = [1, 2]');
  assert.equal(rt.text('{values}'), '[1,2]');
  assert.equal(rt.text([[3n], [4n]]), '[[3],[4]]');
  const exe = await nativeExecutableForTest(t);
  if (!exe) return;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-native-list-text-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const scenesRoot = path.join(dir, 'scenes'), assetsRoot = path.join(dir, 'assets');
  await fs.mkdir(scenesRoot); await fs.mkdir(assetsRoot);
  const source = 'global list[int] values = [1, 2]\nscene main { say narrator "{values}" }';
  const sourceFile = path.join(scenesRoot, 'main.tds'), packageFile = path.join(dir, 'list-text.nsp.json');
  await fs.writeFile(sourceFile, source, 'utf8');
  const packaged = await pack(sourceFile, packageFile, { scenesRoot, assetsRoot });
  const browserLines = [];
  const browser = new Runtime({ command: async (name, args, runtime) => { if (name === 'say') browserLines.push(await runtime.textAsync(args[1])); } });
  await browser.run(packaged.program);
  const native = spawnSync(exe, [packageFile, '--headless'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(native.status, 0, native.stderr || native.error?.message);
  const nativeLines = JSON.parse(native.stdout).commands.filter(command => command.name === 'say').map(command => command.args[1]);
  assert.deepEqual(nativeLines, browserLines);
  assert.deepEqual(browserLines, ['[1,2]']);
});
test('float list interpolation matches Native JSON number formatting', async t => {
  const values = '[1.0, 10000.0, 1e14, 1e15, 1e16, 1e17, 0.0001, 1e-5, 1e-6, 1e-7, -0.0]';
  const expected = '[1.0,10000.0,100000000000000.0,1e+15,1e+16,1e+17,0.0001,1e-05,1e-06,1e-07,0.0]';
  const rt = await run(`list[float] values = ${values}`);
  assert.equal(rt.text('{values}'), expected);

  const exe = await nativeExecutableForTest(t);
  if (!exe) return;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-native-float-list-text-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const scenesRoot = path.join(dir, 'scenes'), assetsRoot = path.join(dir, 'assets');
  await fs.mkdir(scenesRoot); await fs.mkdir(assetsRoot);
  const sourceFile = path.join(scenesRoot, 'main.tds'), packageFile = path.join(dir, 'float-list-text.nsp.json');
  await fs.writeFile(sourceFile, `global list[float] values = ${values}\nscene main { say narrator "{values}" }`, 'utf8');
  const packaged = await pack(sourceFile, packageFile, { scenesRoot, assetsRoot });
  const browserLines = [];
  const browser = new Runtime({ command: async (name, args, runtime) => { if (name === 'say') browserLines.push(await runtime.textAsync(args[1])); } });
  await browser.run(packaged.program);
  const native = spawnSync(exe, [packageFile, '--headless'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(native.status, 0, native.stderr || native.error?.message);
  const nativeLines = JSON.parse(native.stdout).commands.filter(command => command.name === 'say').map(command => command.args[1]);
  assert.deepEqual(browserLines, [expected]);
  assert.deepEqual(nativeLines, browserLines);
});
test('dictionary assignment evaluates the right side before its key', async () => {
  const rt = await run(`
    dict[int] values = { "0": 0, "1": 0 }
    int order = 0
    fn value() -> int { set order = order * 10 + 1
      return 7 }
    fn key() -> str { set order = order * 10 + 2
      return "1" }
    set values[key()] = value()
    int result = values["1"]
  `);
  assert.equal(rt.get('order'), 12n);
  assert.equal(rt.get('result'), 7n);
});
test('character fields persist as runtime state and support dotted interpolation', async () => {
  const rt = await run(`
    character ayase {
      name = "綾瀬"
      affection = 0
      pose smile = "asset/char/ayase/smile.png"
    }
    set ayase.affection = ayase.affection + 2
  `);
  assert.deepEqual({ ...rt.get('ayase') }, { name: '綾瀬', affection: 2n });
  assert.equal(rt.text('{ayase.name}: {ayase.affection}'), '綾瀬: 2');
});

test('Native invalid theme path errors localize prose and retain the setting name', async t => {
  const executable = await nativeExecutableForTest(t);
  if (!executable) return;
  const compiled = program('scene main { say narrator "ready" }');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-theme-error-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'theme-error.nsp.json');
  await fs.writeFile(file, JSON.stringify(nativePackage(compiled, { native_ui: { native_ui_theme: '../outside.json' } })));
  const child = spawnSync(executable, [file, '--smoke'], { encoding: 'utf8', timeout: 10000, env: { ...process.env, SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy' } });
  assert.notEqual(child.status, 0, child.stdout);
  assert.match(child.stderr, /Native UI theme\u306epath\u304c\u4e0d\u6b63\u3067\u3059/);
});

test('unsupported layer category errors match in Browser and Native', async t => {
  const compiled = program('scene main { layer background 1 }');
  compiled.scenes[0].instructions[0].args[0].value = 'unknown';
  const browser = new Runtime({ command: () => {} });
  await assert.rejects(browser.run(compiled), /layer \u306f\u65e2\u77e5\u306e\u5206\u985e/);
  const executable = await nativeExecutableForTest(t);
  if (!executable) return;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-layer-error-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'layer-error.nsp.json');
  await fs.writeFile(file, JSON.stringify(nativePackage(compiled)));
  const child = spawnSync(executable, [file, '--smoke'], { encoding: 'utf8', timeout: 10000, env: { ...process.env, SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy' } });
  assert.notEqual(child.status, 0, child.stdout);
  assert.match(child.stderr, /layer \u306f\u65e2\u77e5\u306e\u5206\u985e/);
});

test('Native ambiguous asset errors localize prose and preserve technical terms', async t => {
  const executable = await nativeExecutableForTest(t);
  if (!executable) return;
  const compiled = program('asset bg first = "asset/one/shared.png"\nasset bg second = "asset/two/shared.png"\nscene main { bg first }');
  compiled.scenes[0].instructions[0].args[0].value = 'shared.png';
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-asset-ambiguity-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'asset-ambiguity.nsp.json');
  await fs.writeFile(file, JSON.stringify(nativePackage(compiled)));
  const child = spawnSync(executable, [file, '--smoke'], { encoding: 'utf8', timeout: 10000, env: { ...process.env, SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy' } });
  assert.notEqual(child.status, 0, child.stdout);
  assert.match(child.stderr, /\u540c\u3058file name\u306easset\u304c\u8907\u6570\u3042\u308a\u307e\u3059: shared\.png/);
});

test('Native missing asset errors localize prose and preserve the asset term', async t => {
  const executable = await nativeExecutableForTest(t);
  if (!executable) return;
  const compiled = program('asset bg known = "asset/known.png"\nscene main { bg known }');
  compiled.scenes[0].instructions[0].args[0].value = 'missing';
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-asset-error-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'asset-error.nsp.json');
  await fs.writeFile(file, JSON.stringify(nativePackage(compiled)));
  const child = spawnSync(executable, [file, '--smoke'], { encoding: 'utf8', timeout: 10000, env: { ...process.env, SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy' } });
  assert.notEqual(child.status, 0, child.stdout);
  assert.match(child.stderr, /asset \u304c\u898b\u3064\u304b\u308a\u307e\u305b\u3093: missing/);
});

test('missing interpolated fields use Japanese runtime errors in Browser and Native', async t => {
  const compiled = program('struct Profile { name: str }\nProfile profile = {"name": "A"}\nscene main { say narrator "{profile.name}" }');
  compiled.globals[0].initial.entries = [];
  const rt = new Runtime({ command: async (name, args, runtime) => { if (name === 'say') await runtime.textAsync(args[1]); } });
  await assert.rejects(rt.run(compiled), /\u88dc\u9593\u5bfe\u8c61\u306efield 'profile\.name' \u304c\u898b\u3064\u304b\u308a\u307e\u305b\u3093/);

  const executable = await nativeExecutableForTest(t);
  if (!executable) return;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-runtime-error-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'runtime-error.nsp.json');
  await fs.writeFile(file, JSON.stringify(nativePackage(compiled)));
  const child = spawnSync(executable, [file, '--headless'], { encoding: 'utf8', timeout: 10000 });
  assert.notEqual(child.status, 0, child.stdout);
  assert.match(child.stderr, /\u88dc\u9593\u5bfe\u8c61\u306efield 'profile\.name' \u304c\u898b\u3064\u304b\u308a\u307e\u305b\u3093/);
});
test('evaluates zero-argument function calls in interpolated text', async () => {
  const rt = await run('fn ending_text() -> str { return "静かなエンディング" }\nsay narrator "{ending_text()}"', {
    command: async (name, args) => { if (name === 'say') assert.equal(args[1], '{ending_text()}'); },
  });
  assert.equal(await rt.textAsync('{ending_text()}'), '静かなエンディング');
});
test('compiler preserves state changes made by interpolated function calls', async () => {
  const rt = await run(`
    int state = 0
    str result = ""
    fn mutate() -> str {
      set state = 1
      return "changed"
    }
    say narrator "{mutate()}"
    if state == 0 {
      set result = "stale"
    } else {
      set result = "changed"
    }
  `, { command: async (name, args, runtime) => { if (name === 'say') await runtime.textAsync(args[1]); } });
  assert.equal(rt.get('state'), 1n);
  assert.equal(rt.get('result'), 'changed');
});
test('compiler preserves state changes hidden in a second interpolation pass', async () => {
  const rt = await run(`
    str template = "{mutate()}"
    int state = 0
    str result = ""
    fn mutate() -> str {
      set state = 1
      return "changed"
    }
    say narrator "{template}"
    if state == 0 {
      set result = "stale"
    } else {
      set result = "changed"
    }
  `, { command: async (name, args, runtime) => { if (name === 'say') await runtime.textAsync(args[1]); } });
  assert.equal(rt.get('state'), 1n);
  assert.equal(rt.get('result'), 'changed');
});
test('recursion through interpolated function calls is rejected', () => {
  assert.throws(() => program(`
    fn first() -> str { return "{second()}" }
    fn second() -> str { return "{first()}" }
    str result = first()
  `), /再帰/);
  assert.throws(() => program(`
    fn first() -> str {
      str name = "first()"
      return "{" + name + "}"
    }
    str result = first()
  `), /再帰/);
  assert.throws(() => program(`
    fn first() -> str {
      str name = "second()"
      return "{" + name + "}"
    }
    fn second() -> str { return "{first()}" }
    str result = first()
  `), /再帰/);
  assert.throws(() => program(`
    str name = "first()"
    fn first() -> str { return "{" + name + "}" }
    str result = first()
  `), /再帰/);
  assert.doesNotThrow(() => program(`
    str name = "first()"
    fn first(name: str) -> str { return "{" + name + "}" }
    str result = first("safe")
  `));
});
test('choice errors reject the run and restore scope', async () => {
  const rt = new Runtime({ choice: async () => 0 });
  await assert.rejects(rt.run(program('choice {\n"bad" {\nint x = 1 / 0\n}\n}')), /除算/);
  assert.equal(rt.frames.length, 1);
});
test('choice selection is recorded before branch SceneState effects', async () => {
  const events = [];
  const rt = new Runtime({
    command: async () => {},
    choice: async () => 1,
    sceneState: async (state, event) => { if (event?.name === 'choice') events.push({ state, event }); },
  });
  await rt.run(program(`
    asset bg first = "asset/first.png"
    asset bg second = "asset/second.png"
    choice "route" {
      "first" { bg first }
      "second" { bg second }
    }
  `));
  assert.equal(rt.sceneState.choices.length, 1);
  assert.deepEqual(rt.sceneState.choices[0], { prompt: 'route', labels: ['first', 'second'], selectedIndex: 1, selectedLabel: 'second', at: 0 });
  assert.equal(rt.sceneState.background.asset, 'second');
  assert.equal(events.length, 1);
  assert.equal(events[0].event.selectedLabel, 'second');
});

test('file transfers work without scene declarations and preserve global state', async () => {
  const visited = [];
  const rt = await run('int x = 4\ngoto "next.tds"\nset x = 99', {
    load: async name => { visited.push(name); return program('int x = 0\nset x = x + 1'); }
  });
  assert.deepEqual(visited, ['next.tds']); assert.equal(rt.get('x'), 5n);
  await assert.rejects(run('int x = 1\ngoto "next.tds"', { load: async () => program('str x = "a"') }), /type が一致/);
});
test('compiler rejects unknown commands, recursion in arguments and invalid pose paths', () => {
  assert.throws(() => program('nonsense'), /未知/);
  assert.throws(() => program('fn id(x: int) -> int { return x }\nfn f() -> int { return id(f()) }'), /再帰/);
  assert.throws(() => program('character hero {\nname = "Hero"\npose normal = "C:/outside.exe"\n}'), /asset path|file extension/i);
  assert.throws(() => program('clear'), /対象/);
});

test('runtime rejects writes to const variables', async () => {
  await assert.rejects(run('const int answer = 1\nset answer = 2'), /const.*変更できません/);
  await assert.rejects(run('const dict[int] stats = { "hp": 10 }\nset stats["hp"] = 1'), /const.*変更できません/);
});

test('runtime keeps a unified scene state and replaces a slot atomically', async () => {
  const rt = await run(`
    asset bgm theme = "asset/theme.ogg"
    character hero {
      name = "Hero"
      pose normal = "asset/hero.png"
    }
    character friend {
      name = "Friend"
      pose normal = "asset/friend.png"
    }
    bgm theme
    show hero.normal far_left
    show friend.normal far_left
  `);
  assert.equal(rt.sceneState.audio.bgm.asset, 'theme');
  assert.equal(rt.sceneState.slots.far_left, 'friend');
  assert.equal(rt.sceneState.characters.hero.visible, false);
  assert.equal(rt.sceneState.characters.friend.visible, true);
  assert.equal(rt.sceneState.characters.hero.visualOrder, 1);
  assert.equal(rt.sceneState.characters.friend.visualOrder, 2);
  assert.equal(rt.sceneState.diagnostics.at(-1).code, 'slot-replaced');
});

test('SceneState visual order matches Native raise, preserve, and re-entry behavior', async () => {
  const rt = await run(`
    asset image panel = "asset/panel.png"
    asset image card = "asset/card.png"
    character hero {
      name = "Hero"
      pose normal = "asset/hero.png"
    }
    character friend {
      name = "Friend"
      pose normal = "asset/friend.png"
    }
    show hero.normal left
    show friend.normal right
    show hero.normal center
    hide hero
    show hero.normal center
    show image panel left
    show image card right
    show image panel center
  `);
  assert.equal(rt.sceneState.characters.friend.visualOrder, 2);
  assert.equal(rt.sceneState.characters.hero.visualOrder, 3, 'a still-visible character keeps order, but re-entry after hide gets a new order');
  assert.equal(rt.sceneState.images.card.visualOrder, 5);
  assert.equal(rt.sceneState.images.panel.visualOrder, 6, 'redisplaying an image raises it above the prior image');
  assert.equal(rt.sceneState.nextVisualOrder, 6);
});

test('scene state tracks blocking transition time and leaves instant actions complete', async () => {
  const rt = await run(`
    asset se click = "asset/click.wav"
    effect fade white 10
    wait 5
    play se click
  `);
  assert.equal(rt.sceneState.logicalTimeMs, 15);
  assert.equal(rt.sceneState.effects[0].transition.startedAt, 0);
  assert.equal(rt.sceneState.effects[0].transition.endsAt, 10);
  assert.equal(rt.sceneState.effects[0].transition.status, 'complete');
  assert.equal(rt.sceneState.effects[0].transition.progress, 1);
  assert.equal(rt.sceneState.audio.se[0].startedAt, 15);
});

test('character show offsets update SceneState and preserve fade timing', async () => {
  const shown = [];
  const rt = await run(`
    character hero {
      name = "Hero"
      pose normal = "asset/hero.png"
    }
    show hero.normal left y+50
    show hero.normal left y-20
    show hero.normal center x+30
    show hero.normal right x-10 y+40 fade 300
  `, { sceneState: (state, operation) => {
    if (operation.name === 'show') shown.push({ ...state.characters.hero, transitionIndex: operation.transitionIndex });
  } });
  assert.deepEqual(shown.map(({ slot, offsetX, offsetY }) => [slot, offsetX, offsetY]), [
    ['left', 0, 50], ['left', 0, -20], ['center', 30, 0], ['right', -10, 40],
  ]);
  assert.equal(shown[3].transitionIndex, 4);
  assert.equal(rt.sceneState.logicalTimeMs, 300);
  assert.equal(rt.sceneState.characters.hero.transition.durationMs, 300);
});

test('relative move commands accumulate offsets and expose blocking transition state', async () => {
  const observed = [];
  const rt = await run(`asset bg room = "asset/room.png"
character hero { name = "Hero"\npose normal = "asset/hero.png" }
bg room
show hero.normal center x+10
move character hero by x+5 y-8 over 25
move bg by x-12 y+4`, {
    command: async (name, args, runtime, operation) => {
      if (name === 'move') observed.push({ operation, character: runtime.sceneState.characters.hero, background: runtime.sceneState.background });
    },
  });
  assert.deepEqual(observed.map(({ operation }) => operation.move), [
    { targetKind: 'character', target: 'hero', delta: { x: 5, y: -8 }, durationMs: 25, fromX: 10, fromY: 0, toX: 15, toY: -8 },
    { targetKind: 'bg', target: 'bg', delta: { x: -12, y: 4 }, durationMs: 0, fromX: 0, fromY: 0, toX: -12, toY: 4 },
  ]);
  assert.equal(observed[0].operation.blocking, true);
  assert.equal(rt.sceneState.actions[observed[0].operation.actionId].status, 'complete');
  assert.equal(rt.sceneState.characters.hero.offsetX, 15);
  assert.equal(rt.sceneState.characters.hero.offsetY, -8);
  assert.equal(rt.sceneState.background.offsetX, -12);
  assert.equal(rt.sceneState.background.offsetY, 4);
  assert.equal(rt.sceneState.logicalTimeMs, 25);
});

test('scene state registers timed effects as blocking actions', async () => {
  const rt = await run('effect fade black 10');
  const action = Object.values(rt.sceneState.actions).find((item) => item.kind === 'effect');
  assert.ok(action);
  assert.equal(action.blocking, true);
  assert.equal(action.status, 'complete');
  assert.equal(action.durationMs, 10);
  assert.equal(rt.sceneState.effects[0].actionId, action.id);
  assert.equal(rt.sceneState.effects[0].transition.status, 'complete');
});

test('scene state registers blocking character fades and commits hide after completion', async () => {
  const rt = await run(`
    character hero {
      name = "Hero"
      pose normal = "asset/hero.png"
    }
    show hero.normal left fade 10
    hide hero fade 5
  `);
  const actions = Object.values(rt.sceneState.actions);
  assert.deepEqual(actions.map((item) => [item.kind, item.blocking, item.status]), [
    ['show', true, 'complete'],
    ['hide', true, 'complete'],
  ]);
  assert.equal(rt.sceneState.logicalTimeMs, 15);
  assert.equal(rt.sceneState.characters.hero.visible, false);
  assert.equal(rt.sceneState.slots.left, null);
});

test('SceneState visual values are the interpolated rendered values throughout blocking transitions', async () => {
  const samples = Object.create(null);
  const rt = await run(`
    asset bg room = "asset/room.png"
    character hero { name = "Hero"\npose normal = "asset/hero.png" }
    bg room
    show hero.normal center fade 100
    move character hero by x+20 y+40 over 100
    move bg by y+60 over 100
    effect fade black 200
    hide hero fade 100
  `, {
    command: async (name, args, runtime, operation) => {
      const actionId = operation.actionId;
      if (!actionId || !['show', 'move', 'effect', 'hide'].includes(name)) return;
      runtime.reportTransitionProgress(actionId, 0.5);
      if (name === 'show') samples.show = { opacity: runtime.sceneState.characters.hero.opacity, status: runtime.sceneState.characters.hero.transition.status };
      if (name === 'move' && args[1] === 'hero') samples.characterMove = { x: runtime.sceneState.characters.hero.offsetX, y: runtime.sceneState.characters.hero.offsetY };
      if (name === 'move' && args[0] === 'bg') samples.backgroundMove = { x: runtime.sceneState.background.offsetX, y: runtime.sceneState.background.offsetY };
      if (name === 'effect') samples.effect = runtime.sceneState.effects.at(-1).opacity;
      if (name === 'hide') samples.hide = runtime.sceneState.characters.hero.opacity;
    },
  });
  assert.deepEqual({ ...samples }, {
    show: { opacity: 0.5, status: 'running' },
    characterMove: { x: 10, y: 20 },
    backgroundMove: { x: 0, y: 30 },
    effect: 0.5,
    hide: 0.5,
  });
  assert.deepEqual([rt.sceneState.characters.hero.opacity, rt.sceneState.characters.hero.offsetX, rt.sceneState.characters.hero.offsetY], [0, 20, 40]);
  assert.deepEqual([rt.sceneState.background.offsetX, rt.sceneState.background.offsetY], [0, 60]);
  assert.equal(rt.sceneState.effects[0].opacity, 0);
  assert.equal(rt.sceneState.logicalTimeMs, 600);
});

test('scene state records concurrent audio and blocking or async video actions', async () => {
  const rt = await run(`
    asset se click = "asset/click.wav"
    asset voice hello = "asset/hello.wav"
    asset video intro = "asset/intro.mp4"
    play se click
    play voice hello
    play video intro async
    play video intro blocking
  `);
  const actions = Object.values(rt.sceneState.actions);
  assert.deepEqual(actions.map(action => action.kind), ['se', 'voice', 'video', 'video']);
  assert.equal(actions[0].blocking, false);
  assert.equal(actions[1].status, 'running');
  assert.equal(actions[2].status, 'stopped');
  assert.equal(actions[2].reason, 'replaced');
  assert.equal(actions[3].blocking, true);
  assert.equal(actions[3].status, 'complete');
  assert.equal(actions[3].endedAt, 0);
  assert.equal(rt.sceneState.audio.se.length, 1);
  assert.equal(rt.sceneState.audio.voices.length, 1);
  assert.equal(rt.sceneState.video, null, 'the blocking replacement finishes and clears the active video');
  rt.completeAction(actions[1].id);
  assert.equal(actions[1].status, 'complete');
  assert.equal(actions[1].endedAt, 0);
  assert.equal(rt.sceneState.audio.voices.length, 0, 'completed Voice is removed from the active playback state but retained in action history');
  rt.completeAction(actions[0].id);
  assert.equal(rt.sceneState.audio.se.length, 0, 'completed SE is removed from the active playback state');
  assert.deepEqual([actions[0].status, actions[1].status], ['complete', 'complete']);
});

test('voice playback state retains an explicit character binding while legacy playback stays unbound', async () => {
  const rt = await run(`
    asset voice ayaka_line = "asset/ayaka.wav"
    asset voice narration = "asset/narration.wav"
    character ayaka { name = "綾瀬あやか" }
    play voice ayaka_line character ayaka
    play voice narration async
  `);
  assert.deepEqual(rt.sceneState.audio.voices.map(voice => voice.characterId || null), ['ayaka', null]);
  const actions = Object.values(rt.sceneState.actions).filter(action => action.kind === 'voice');
  assert.equal(actions[0].characterId, 'ayaka');
  assert.equal(Object.hasOwn(actions[1], 'characterId'), false);
});

test('visual-only mode isolates background, character, image, and video without deleting scene state', async () => {
  const rt = await run(`
    asset bg room = "asset/room.png"
    asset image card = "asset/card.png"
    asset video op = "asset/video/op.mp4"
    character hero {
      name = "Hero"
      pose normal = "asset/hero.png"
    }
    scene main {
      bg room --only
      show hero.normal center --only
      show image card center --only
      show image card center
      play video "op.mp4" async --only
    }
  `);
  assert.equal(rt.sceneState.visualOnly.kind, 'video');
  assert.equal(rt.sceneState.visualOnly.asset, 'op');
  assert.equal(rt.sceneState.video.asset, 'op');
  assert.ok(rt.sceneState.background, 'isolating the video does not erase the previous background state');
  assert.ok(rt.sceneState.characters.hero.visible, 'isolating the video does not erase the character state');
  assert.ok(rt.sceneState.images.card, 'isolating the video does not erase the image state');
  const video = Object.values(rt.sceneState.actions).find((action) => action.kind === 'video');
  rt.completeAction(video.id);
  assert.equal(rt.sceneState.video, null);
  assert.equal(rt.sceneState.visualOnly, null, 'video isolation automatically ends with playback');

  const staticRt = await run(`
    asset bg room = "asset/room.png"
    asset image card = "asset/card.png"
    scene main { bg room --only\nshow image card center --only }
  `);
  assert.deepEqual(staticRt.sceneState.visualOnly, { kind: 'image', id: 'card' });
});

test('video without a mode blocks following story commands until playback ends', async () => {
  let finishVideo;
  let reachedFollowingCommand = false;
  let videoOperation;
  const runtime = new Runtime({ command: async (name, _args, _rt, operation) => {
    if (name === 'play') {
      videoOperation = operation;
      await new Promise(resolve => { finishVideo = resolve; });
    } else if (name === 'wait') reachedFollowingCommand = true;
  } });
  const running = runtime.run(program(`
    asset video intro = "asset/intro.mp4"
    scene main {
      play video intro
      wait 1
    }
  `));
  for (let attempt = 0; attempt < 10 && !finishVideo; attempt++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(videoOperation?.mode, 'blocking');
  assert.equal(videoOperation?.blocking, true);
  assert.equal(reachedFollowingCommand, false, 'the next instruction is suspended while the video is playing');
  finishVideo();
  await running;
  assert.equal(reachedFollowingCommand, true);
});

test('SceneState owns the active video and commits replacement only after the candidate starts', async () => {
  const source = `
    asset video first = "asset/first.mp4"
    asset video second = "asset/second.mp4"
    asset video broken = "asset/broken.mp4"
    play video first async
    play video second async
  `;
  const rt = await run(source);
  const videos = Object.values(rt.sceneState.actions).filter(action => action.kind === 'video');
  assert.equal(rt.sceneState.video.asset, 'second');
  assert.equal(videos[0].status, 'stopped');
  assert.equal(videos[0].reason, 'replaced');
  assert.equal(videos[1].status, 'running');
  rt.completeAction(videos[1].id);
  assert.equal(rt.sceneState.video, null, 'natural completion removes the active video but retains action history');

  const failed = new Runtime({ command: async (name, args) => {
    if (name === 'play' && args[0] === 'video' && args[1] === 'broken') throw Error('video start failed');
  } });
  await assert.rejects(failed.run(program(`
    asset video first = "asset/first.mp4"
    asset video broken = "asset/broken.mp4"
    play video first async
    play video broken async
  `)), /video start failed/);
  const failedVideos = Object.values(failed.sceneState.actions).filter(action => action.kind === 'video');
  assert.equal(failed.sceneState.video.asset, 'first', 'failed replacement rollback keeps the still-running video authoritative');
  assert.deepEqual(failedVideos.map(({ status, reason }) => [status, reason]), [['running', undefined], ['stopped', 'failed']]);
});

test('scene state can stop an async media action when its presentation layer is replaced', async () => {
  const rt = await run(`
    asset video first = "asset/first.mp4"
    play video first async
  `);
  const action = Object.values(rt.sceneState.actions).find((item) => item.kind === 'video');
  rt.stopAction(action.id, 'replaced');
  assert.equal(action.status, 'stopped');
  assert.equal(action.reason, 'replaced');
  assert.equal(action.endedAt, 0);
});

test('stopped audio leaves active playback state while retaining its terminal action record', async () => {
  const rt = await run(`
    asset se click = "asset/click.wav"
    asset voice hello = "asset/hello.wav"
    play se click
    play voice hello async
  `);
  const actions = Object.values(rt.sceneState.actions);
  rt.stopAction(actions[0].id, 'failed');
  rt.stopAction(actions[1].id, 'replaced');
  assert.deepEqual(rt.sceneState.audio.se, []);
  assert.deepEqual(rt.sceneState.audio.voices, []);
  assert.deepEqual(actions.map(({ status, reason }) => [status, reason]), [
    ['stopped', 'failed'], ['stopped', 'replaced'],
  ]);
});

test('scene state records replacement and clear reasons for BGM actions', async () => {
  const rt = await run(`
    asset bgm first = "asset/first.ogg"
    asset bgm second = "asset/second.ogg"
    bgm first
    bgm second
    clear bgm
  `);
  const actions = Object.values(rt.sceneState.actions);
  assert.equal(rt.sceneState.audio.bgm, null);
  assert.deepEqual(actions.map(action => [action.status, action.reason]), [
    ['stopped', 'replaced'],
    ['stopped', 'cleared'],
  ]);
  assert.equal(actions[0].replacedBy, actions[1].id);
});

test('BGM operations expose replacement and clear action provenance to hosts', async () => {
  const operations = [];
  const rt = new Runtime({
    command: async (name, args, runtime, operation) => operations.push(operation),
    choice: async () => 0,
  });
  await rt.run(program(`
    asset bgm first = "asset/first.ogg"
    asset bgm second = "asset/second.ogg"
    bgm first
    play bgm second
    clear bgm
  `));
  assert.equal(operations.length, 3);
  assert.equal(operations[1].replacedActionId, operations[0].actionId);
  assert.equal(operations[2].actionId, operations[1].actionId);
  assert.equal(rt.sceneState.actions[operations[0].actionId].reason, 'replaced');
  assert.equal(rt.sceneState.actions[operations[1].actionId].reason, 'cleared');
});

test('a failed BGM crossfade preserves the playing track and records only the failed candidate', async () => {
  const rt = new Runtime({ command: async (name, args) => {
    if (name === 'play' && args[0] === 'bgm' && args[1] === 'broken') throw Error('decode failed');
  } });
  await assert.rejects(rt.run(program(`
    asset bgm first = "asset/first.ogg"
    asset bgm second = "asset/second.ogg"
    asset bgm broken = "asset/broken.ogg"
    bgm first
    play bgm second crossfade 120
    play bgm broken crossfade 240
  `)), /decode failed/);
  assert.equal(rt.sceneState.audio.bgm.asset, 'second');
  const actions = Object.values(rt.sceneState.actions);
  assert.deepEqual(actions.map(({ asset, status, reason }) => [asset, status, reason]), [
    ['first', 'stopped', 'replaced'],
    ['second', 'running', undefined],
    ['broken', 'stopped', 'failed'],
  ]);
});

test('failed presentation commands roll back only their draft and retain concurrent media completion', async () => {
  let videoActionId;
  let seActionId;
  const rt = new Runtime({ command: async (name, args, runtime, operation) => {
    if (name === 'play' && args[0] === 'video') videoActionId = operation.actionId;
    if (name === 'play' && args[0] === 'se') seActionId = operation.actionId;
    if (name === 'bg' && args[0] === 'broken') {
      runtime.completeAction(videoActionId);
      runtime.completeAction(seActionId);
      assert.equal(runtime.sceneState.actions[videoActionId].status, 'complete', 'completed media must be visible during an in-flight presentation transaction');
      assert.equal(runtime.sceneState.audio.se.length, 0, 'completed SE must leave the active list while the unrelated command is pending');
      throw Error('background decode failed');
    }
  } });
  await assert.rejects(rt.run(program(`
    asset bg first = "asset/first.png"
    asset bg broken = "asset/broken.png"
    asset video intro = "asset/intro.mp4"
    asset se click = "asset/click.wav"
    bg first
    play video intro async
    play se click
    bg broken
  `)), /background decode failed/);
  assert.equal(rt.sceneState.background.asset, 'first');
  assert.equal(rt.sceneState.actions[videoActionId].status, 'complete');
  assert.equal(rt.sceneState.actions[seActionId].status, 'complete');
  assert.deepEqual(rt.sceneState.audio.se, [], 'rollback must retain the concurrent SE completion instead of resurrecting it');
});

test('failed presentation rollback retains newer progress from an unaffected concurrent BGM fade', async () => {
  let bgmTransitionId;
  const rt = new Runtime({ command: async (name, args, runtime, operation) => {
    if (name === 'play' && args[0] === 'bgm') {
      bgmTransitionId = operation.transitionId;
      runtime.reportTransitionProgress(bgmTransitionId, 0.25);
    }
    if (name === 'bg' && args[0] === 'broken') {
      runtime.reportTransitionProgress(bgmTransitionId, 0.4);
      runtime.reportTransitionProgress(bgmTransitionId, 0.6);
      runtime.reportTransitionProgress(bgmTransitionId, 0.7);
      assert.equal(runtime.pendingSceneActionEvents.filter(event => event.type === 'progress' && event.id === bgmTransitionId).length, 1,
        'the transaction journal should retain only the latest sample per live transition');
      throw Error('background decode failed');
    }
  } });
  await assert.rejects(rt.run(program(`
    asset bg room = "asset/room.png"
    asset bg broken = "asset/broken.png"
    asset bgm music = "asset/music.ogg"
    bg room
    play bgm music crossfade 1000
    bg broken
  `)), /background decode failed/);
  assert.equal(rt.sceneState.background.asset, 'room', 'the failed background candidate must roll back');
  assert.equal(rt.sceneState.audio.bgm.transition.id, bgmTransitionId);
  assert.equal(rt.sceneState.audio.bgm.transition.progress, 0.7,
    'progress reported while the failed background was loading must survive its rollback');
  assert.equal(rt.sceneState.actions[bgmTransitionId].progress, 0.7,
    'the live BGM action and its transition must remain synchronized after rollback');
});

test('failed included presentation inside a selected branch restores only its own state', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-branch-include-rollback-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const assetsRoot = path.join(dir, 'assets');
  await fs.mkdir(assetsRoot, { recursive: true });
  await fs.writeFile(path.join(assetsRoot, 'room.png'), Buffer.from([0]));
  await fs.writeFile(path.join(assetsRoot, 'broken.png'), Buffer.from([0]));
  await fs.writeFile(path.join(assetsRoot, 'music.ogg'), Buffer.from([0]));
  await fs.writeFile(path.join(dir, 'presentation.tds'), 'asset bg broken = "asset/broken.png"\nfn fail_background() -> none { bg broken }');
  const source = `asset bg room = "asset/room.png"
asset bgm music = "asset/music.ogg"
include presentation.tds as presentation
scene main {
  bg room
  play bgm music crossfade 1000
  choice "continue?" {
    "run included presentation" { presentation.fail_background() }
    "skip" { wait 1 }
  }
}`;
  await fs.writeFile(path.join(dir, 'main.tds'), source);
  const packed = await pack(path.join(dir, 'main.tds'), path.join(dir, 'test.nsp.json'), { scenesRoot: dir, assetsRoot });
  let transitionId;
  const runtime = new Runtime({ choice: async () => 0, command: async (name, args, rt, operation) => {
    if (name === 'play' && args[0] === 'bgm') {
      transitionId = operation.transitionId;
      rt.reportTransitionProgress(transitionId, 0.2);
    }
    if (name === 'bg' && args[0] === 'broken') {
      rt.reportTransitionProgress(transitionId, 0.65);
      throw Error('included background decode failed');
    }
  } });
  await assert.rejects(runtime.run(packed.program), /included background decode failed/);
  assert.equal(runtime.sceneState.background.asset, 'room', 'the included branch must rollback its failed background candidate');
  assert.equal(runtime.sceneState.audio.bgm.asset, 'music');
  assert.equal(runtime.sceneState.audio.bgm.transition.progress, 0.65,
    'the progress of an unrelated BGM transition must survive rollback through the selected include branch');
  assert.equal(runtime.sceneState.actions[transitionId].progress, 0.65);
  assert.equal(runtime.sceneState.actions[transitionId].status, 'running');
});

test('BGM crossfade in a selected branch is retained as audio-clocked non-blocking state', async () => {
  const operations = [];
  let rt;
  rt = new Runtime({ command: async (name, args, runtime, operation) => {
    operations.push({ name, args, operation, time: runtime.sceneState.logicalTimeMs });
  }, choice: async () => 0 });
  await rt.run(program(`
    asset bgm first = "asset/first.ogg"
    asset bgm second = "asset/second.ogg"
    scene main {
      choice "music" {
        "crossfade" { play bgm first\nplay bgm second crossfade 120\nwait 30 }
        "leave" { wait 1 }
      }
    }
  `));
  const crossfade = operations.find(item => item.name === 'play' && item.args[1] === 'second');
  assert.ok(crossfade);
  assert.deepEqual(crossfade.operation.transition, { type: 'crossfade', durationMs: 120 });
  assert.equal(Boolean(crossfade.operation.blocking), false);
  assert.equal(rt.sceneState.logicalTimeMs, 30);
  assert.equal(rt.sceneState.audio.bgm.asset, 'second');
  assert.equal(rt.sceneState.audio.bgm.transition.progress, 0,
    'script wait advances logical time but cannot synthesize progress for an audio-clocked fade');
  assert.equal(rt.sceneState.actions[crossfade.operation.actionId].status, 'running');
});

test('a non-blocking BGM transition completes during a dialogue wait without advancing script time', async () => {
  let rt;
  let transitionId;
  rt = new Runtime({ command: async (name, _args, runtime, operation) => {
    if (name === 'play' && operation.transition?.type === 'crossfade') {
      transitionId = operation.transitionId;
      setTimeout(() => runtime.completeTransition(transitionId), 10);
    }
    if (name === 'say') await new Promise(resolve => setTimeout(resolve, 40));
  } });
  await rt.run(program(`
    asset bgm first = "asset/first.ogg"
    asset bgm second = "asset/second.ogg"
    bgm first
    play bgm second crossfade 20
    say narrator "fade while waiting"
  `));
  assert.equal(rt.sceneState.logicalTimeMs, 0, 'dialogue input time is outside deterministic script time');
  assert.equal(rt.sceneState.audio.bgm.transition.id, transitionId);
  assert.equal(rt.sceneState.audio.bgm.transition.status, 'complete');
  assert.equal(rt.sceneState.audio.bgm.transition.progress, 1);
  assert.equal(rt.sceneState.actions[transitionId].status, 'running', 'the BGM action continues after its crossfade ends');
});

test('a stale BGM transition completion cannot finish the replacement transition', async () => {
  const transitionIds = [];
  let rt;
  rt = new Runtime({ command: async (name, _args, runtime, operation) => {
    if (name === 'play' && operation.transition?.type === 'crossfade') {
      transitionIds.push(operation.transitionId);
      const delay = transitionIds.length === 1 ? 10 : 30;
      setTimeout(() => runtime.completeTransition(operation.transitionId), delay);
    }
    if (name === 'say') await new Promise(resolve => setTimeout(resolve, 50));
  } });
  await rt.run(program(`
    asset bgm first = "asset/first.ogg"
    asset bgm second = "asset/second.ogg"
    asset bgm third = "asset/third.ogg"
    bgm first
    play bgm second crossfade 100
    play bgm third crossfade 100
    say narrator "latest fade wins"
  `));
  const [secondId, thirdId] = transitionIds;
  assert.notEqual(secondId, thirdId);
  assert.equal(rt.sceneState.audio.bgm.asset, 'third');
  assert.equal(rt.sceneState.audio.bgm.transition.id, thirdId);
  assert.equal(rt.sceneState.audio.bgm.transition.status, 'complete');
  assert.equal(rt.sceneState.actions[secondId].status, 'stopped');
  assert.equal(rt.sceneState.actions[secondId].reason, 'replaced');
  assert.equal(rt.sceneState.actions[thirdId].status, 'running');
});

test('a failed outgoing BGM layer is retired without overwriting its replacement action', async () => {
  const ids = {};
  const rt = new Runtime({ command: async (name, args, runtime, operation) => {
    if (name === 'play' && args[0] === 'bgm') ids[args[1]] = operation.actionId;
    if (name === 'play' && args[0] === 'bgm' && args[1] === 'second') runtime.reportTransitionProgress(operation.transitionId, 0.5);
    if (name === 'play' && args[0] === 'bgm' && args[1] === 'third') runtime.reportTransitionProgress(operation.transitionId, 0.4);
  } });
  await rt.run(program(`
    asset bgm first = "asset/first.ogg"
    asset bgm second = "asset/second.ogg"
    asset bgm third = "asset/third.ogg"
    play bgm first crossfade 100
    play bgm second crossfade 100
    play bgm third crossfade 100
    say narrator "fade still running"
  `));
  const bgm = rt.sceneState.audio.bgm;
  const progress = bgm.transition.progress;
  rt.stopAction(ids.first, 'failed');
  assert.equal(rt.sceneState.audio.bgm, bgm);
  assert.equal(bgm.asset, 'third');
  assert.equal(bgm.transition.status, 'running');
  assert.equal(bgm.transition.progress, progress);
  assert.deepEqual(bgm.layers.map(({ asset, gain, role }) => ({ asset, gain, role })), [
    { asset: 'second', gain: 0.3, role: 'outgoing' },
    { asset: 'third', gain: 0.4, role: 'incoming' },
  ]);
  assert.deepEqual([rt.sceneState.actions[ids.first].status, rt.sceneState.actions[ids.first].reason], ['stopped', 'replaced'],
    'a late decoder failure removes only the already-replaced track and does not rewrite action history');
  assert.equal(rt.sceneState.actions[ids.third].status, 'running');
});

test('presentation defaults, persistent channel settings, and one-play overrides resolve in order', async () => {
  const operations = [];
  const rt = new Runtime({ command: async (name, args, runtime, operation) => {
    operations.push({ name, args, gain: operation.gain, dialogOpacity: operation.dialogOpacity, temporary: operation.dialogOpacityTemporary });
  } });
  rt.configurePresentationDefaults({ audio: { bgm: 0.9, se: 0.8, voice: 0.5 }, dialog: { opacity: 0.7 } });
  await rt.run(program(`
    asset bgm track = "asset/track.ogg" volume 0.6
    asset voice line = "asset/line.wav" volume 0.4
    asset se click = "asset/click.wav"
    scene main {
      play bgm track
      volume bgm 0.3
      play bgm track volume 0.2
      play bgm track
      play voice line
      play se click
      dialog opacity 0.85
      say narrator "one line" opacity 0.25
      say narrator "next line"
    }
  `));
  const plays = operations.filter(item => item.name === 'play');
  assert.deepEqual(plays.map(item => [item.args[0], item.gain]), [
    ['bgm', 0.6], ['bgm', 0.2], ['bgm', 0.3], ['voice', 0.4], ['se', 0.8],
  ]);
  const says = operations.filter(item => item.name === 'say');
  assert.deepEqual(says.map(item => [item.dialogOpacity, item.temporary]), [[0.25, true], [undefined, undefined]]);
  assert.equal(rt.sceneState.ui.dialogOpacity, 0.85);
  assert.equal(rt.sceneState.audio.volumeOverrides.bgm, 0.3);
  assert.deepEqual(rt.sceneState.audio.volumes, { bgm: 0.9, se: 0.8, voice: 0.5 });
});

test('scene presentation effects keep transition, opacity, camera and dialogue state explicit', async () => {
  const seen = [];
  const rt = new Runtime({ command: async (name, args, runtime, operation) => {
    seen.push({ name, args, operation });
    if (operation?.actionId && operation.blocking) runtime.reportTransitionProgress(operation.actionId, 1);
  } });
  await rt.run(program(`
    asset bg first = "asset/first.png"
    asset bg second = "asset/second.png"
    asset video overlay = "asset/overlay.mp4"
    scene main {
      bg first
      bg second crossfade 40
      play video overlay async opacity 0.35
      camera zoom 1.5 at 320 240 over 60
      dialog visible false
      camera reset over 20
      dialog visible true
    }
  `));
  const bg = seen.find(item => item.name === 'bg' && item.args[0] === 'second');
  assert.equal(bg.operation.transition.type, 'crossfade');
  assert.equal(bg.operation.transition.durationMs, 40);
  const video = seen.find(item => item.name === 'play');
  assert.equal(video.operation.opacity, 0.35);
  assert.equal(video.operation.mode, 'async');
  const cameras = seen.filter(item => item.name === 'camera');
  assert.deepEqual(cameras[0].operation.camera.to, { zoom: 1.5, focusX: 320, focusY: 240 });
  assert.equal(cameras[0].operation.camera.durationMs, 60);
  assert.deepEqual(cameras[1].operation.camera.to, { zoom: 1, focusX: 640, focusY: 360 });
  assert.deepEqual(seen.filter(item => item.name === 'dialog').map(item => item.operation.visible), [false, true]);
  assert.equal(rt.sceneState.ui.dialogVisible, true);
  assert.deepEqual([rt.sceneState.camera.zoom, rt.sceneState.camera.focusX, rt.sceneState.camera.focusY], [1, 640, 360]);
  assert.equal(rt.sceneState.logicalTimeMs, 120);
});

test('SceneState models every audible BGM layer and interpolates gains through interrupted crossfades', async () => {
  const snapshots = [];
  const rt = new Runtime({ command: async (name, _args, runtime, operation) => {
    if (name !== 'play' || operation.transition?.type !== 'crossfade') return;
    if (operation.args[1] === 'second') runtime.reportTransitionProgress(operation.transitionId, 0.5);
    else if (operation.args[1] === 'third') {
      snapshots.push(runtime.sceneState.audio.bgm.layers.map(({ asset, gain, role }) => ({ asset, gain, role })));
      runtime.reportTransitionProgress(operation.transitionId, 0.5);
      snapshots.push(runtime.sceneState.audio.bgm.layers.map(({ asset, gain, role }) => ({ asset, gain, role })));
      runtime.completeTransition(operation.transitionId);
    }
  } });
  await rt.run(program(`
    asset bgm first = "asset/first.ogg"
    asset bgm second = "asset/second.ogg"
    asset bgm third = "asset/third.ogg"
    bgm first
    play bgm second crossfade 100
    play bgm third crossfade 100
    say narrator "inspect final mix"
  `));
  assert.deepEqual(snapshots[0], [
    { asset: 'first', gain: 0.5, role: 'outgoing' },
    { asset: 'second', gain: 0.5, role: 'outgoing' },
    { asset: 'third', gain: 0, role: 'incoming' },
  ]);
  assert.deepEqual(snapshots[1], [
    { asset: 'first', gain: 0.25, role: 'outgoing' },
    { asset: 'second', gain: 0.25, role: 'outgoing' },
    { asset: 'third', gain: 0.5, role: 'incoming' },
  ]);
  assert.deepEqual(rt.sceneState.audio.bgm.layers.map(({ asset, gain, role }) => ({ asset, gain, role })), [
    { asset: 'third', gain: 1, role: 'active' },
  ], 'completion retires outgoing layers and leaves one full-gain active track');
});

test('scenario-time advancement does not retire BGM layers without audio-clock progress', async () => {
  const rt = new Runtime({ command: async () => {} });
  await rt.run(program(`
    asset bgm first = "asset/first.ogg"
    asset bgm second = "asset/second.ogg"
    bgm first
    play bgm second crossfade 100
    wait 100
    say narrator "fade settled"
  `));
  assert.equal(rt.sceneState.audio.bgm.transition.status, 'running');
  assert.deepEqual(rt.sceneState.audio.bgm.layers.map(({ asset, gain, role }) => ({ asset, gain, role })), [
    { asset: 'first', gain: 1, role: 'outgoing' },
    { asset: 'second', gain: 0, role: 'incoming' },
  ], 'only audio-clock progress may advance and retire externally clocked BGM layers');
});

test('a failed active BGM action clears the SceneState track but stale failures cannot clear its replacement', async () => {
  const actionIds = [];
  let rt;
  rt = new Runtime({ command: async (name, _args, runtime, operation) => {
    if (name === 'play' && operation.actionId) {
      actionIds.push(operation.actionId);
      if (actionIds.length === 1) setTimeout(() => runtime.stopAction(operation.actionId, 'failed'), 10);
    }
    if (name === 'say') await new Promise(resolve => setTimeout(resolve, 20));
  } });
  await rt.run(program(`
    asset bgm first = "asset/first.ogg"
    asset bgm second = "asset/second.ogg"
    asset bgm third = "asset/third.ogg"
    play bgm first crossfade 30
    play bgm second crossfade 30
    wait 25
    say narrator "stale failure is ignored"
  `));
  const [firstId, secondId] = actionIds;
  assert.equal(rt.sceneState.audio.bgm.asset, 'second');
  assert.equal(rt.sceneState.actions[firstId].status, 'stopped');
  assert.equal(rt.sceneState.actions[firstId].reason, 'replaced');
  assert.equal(rt.sceneState.actions[secondId].status, 'running');
});

test('a late failure of the current BGM action clears active presentation state', async () => {
  let actionId;
  let rt;
  rt = new Runtime({ command: async (name, _args, runtime, operation) => {
    if (name === 'play' && operation.transition?.type === 'crossfade') {
      actionId = operation.actionId;
      setTimeout(() => runtime.stopAction(actionId, 'failed'), 5);
    }
    if (name === 'say') await new Promise(resolve => setTimeout(resolve, 15));
  } });
  await rt.run(program(`
    asset bgm music = "asset/music.ogg"
    play bgm music crossfade 30
    wait 10
    say narrator "BGM failed asynchronously"
  `));
  assert.equal(rt.sceneState.audio.bgm, null);
  assert.deepEqual({ status: rt.sceneState.actions[actionId].status, reason: rt.sceneState.actions[actionId].reason },
    { status: 'stopped', reason: 'failed' });
});

test('background operations expose replacement and clear provenance to hosts', async () => {
  const operations = [];
  const rt = new Runtime({
    command: async (name, args, runtime, operation) => operations.push(operation),
    choice: async () => 0,
  });
  await rt.run(program(`
    asset bg first = "asset/first.png"
    asset bg second = "asset/second.png"
    bg first
    bg second
    clear bg
  `));
  assert.equal(operations.length, 3);
  assert.equal(operations[1].replacedAsset, 'first');
  assert.equal(operations[2].clearedAsset, 'second');
  assert.equal(rt.sceneState.background, null);
});

test('scene state survives goto transfers', async () => {
  const rt = await run(`
    asset bgm theme = "asset/theme.ogg"
    bgm theme
    scene start {
      goto next
    }
    scene next {
      say narrator "next"
    }
  `, { command: async () => {} });
  assert.equal(rt.sceneState.audio.bgm.asset, 'theme');
});
test('goto transfers are recorded before the destination continues with inherited state', async () => {
  const events = [];
  const rt = new Runtime({
    command: async () => {},
    choice: async () => 0,
    sceneState: async (state, event) => { if (event?.name === 'goto') events.push(event); },
  });
  await rt.run(program(`
    asset bg first = "asset/first.png"
    scene start {
      bg first
      goto next
    }
    scene next {
      clear bg
    }
  `));
  assert.deepEqual(rt.sceneState.transfers, [{ target: 'next', external: false, at: 0 }]);
  assert.deepEqual(events, [{ name: 'goto', target: 'next', external: false, at: 0 }]);
  assert.equal(rt.sceneState.background, null);
});

test('external goto transfers preserve SceneState across loaded programs', async () => {
  const events = [];
  const rt = new Runtime({
    command: async () => {},
    choice: async () => 0,
    load: async target => {
      assert.equal(target, 'next.tds');
      return program('clear bg');
    },
    sceneState: async (state, event) => { if (event?.name === 'goto') events.push(event); },
  });
  await rt.run(program(`
    asset bg first = "asset/first.png"
    bg first
    goto "next.tds"
  `));
  assert.deepEqual(rt.sceneState.transfers, [{ target: 'next.tds', external: true, at: 0 }]);
  assert.deepEqual(events, [{ name: 'goto', target: 'next.tds', external: true, at: 0 }]);
  assert.equal(rt.sceneState.background, null);
});

test('assignment evaluates the right side before rejecting a const write', async () => {
  const rt = new Runtime({ command: async () => {}, choice: async () => 0 });
  const rawProgram = {
    version: 2, assets: [], characters: [], scenes: [], variables: [],
    globals: [
      { op: 'declare', type: 'int', name: 'locked', initial: { kind: 'integer', value: '0' }, constant: true },
      { op: 'declare', type: 'int', name: 'observed', initial: { kind: 'integer', value: '0' } },
      { op: 'set', target: { kind: 'load', name: 'locked' }, value: { kind: 'call', name: 'bump', args: [] } },
    ],
    functions: [{ op: 'function', name: 'bump', returnType: 'int', params: [], body: [
      { op: 'set', target: { kind: 'load', name: 'observed' }, value: { kind: 'integer', value: '1' } },
      { op: 'return', value: { kind: 'integer', value: '1' } },
    ] }],
  };
  await assert.rejects(rt.run(rawProgram), /const.*変更できません/);
  assert.equal(rt.get('observed'), 1n);
});
test('metadata binds identical names to their own scopes', () => {
  const p = program('int x = 1\nfn f(x: int) -> int { return x }\nscene main { say narrator str(x) }');
  const [global, param] = p.variables;
  assert.deepEqual(global.references.map(r => r.container), ['main']);
  assert.deepEqual(param.references.map(r => r.container), ['f']);
});
test('resolved include metadata and execution source locations survive Native packaging in raw and optimized builds', async t => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-include-source-provenance-'));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  seedEmptyProject(projectRoot);
  const { scenesRoot, buildRoot } = projectLayout(projectRoot);
  await fs.writeFile(path.join(scenesRoot, 'main.tds'), `include "lib.tds" as lib
global str observed_file = ""
scene main {
  set observed_file = lib.get_file("")
}
`, 'utf8');
  await fs.writeFile(path.join(scenesRoot, 'lib.tds'), `fn get_file(prefix: str) -> str {
  str local_file = runtime.state.execution.current_file()
  return prefix + local_file
}
`, 'utf8');

  const native = await nativeExecutableForTest(t);
  for (const debug of [false, true]) {
    const packagePath = path.join(buildRoot, `include-${debug ? 'raw' : 'optimized'}.nsp.json`);
    await pack(path.join(scenesRoot, 'main.tds'), packagePath, { projectRoot, debug });
    const packaged = JSON.parse(await fs.readFile(packagePath, 'utf8'));
    const metadata = packaged.files['main.tds'].variables.find(variable => variable.name === 'local_file');
    assert.deepEqual(metadata.definitions.map(location => location.file), ['lib.tds']);
    assert.deepEqual(metadata.references.map(location => location.file), ['lib.tds']);
    const parameter = packaged.files['main.tds'].variables.find(variable => variable.name === 'prefix');
    assert.deepEqual(parameter.definitions.map(location => location.file), ['lib.tds']);
    assert.deepEqual(parameter.references.map(location => location.file), ['lib.tds']);

    const browser = new Runtime();
    await browser.run(packaged.program);
    assert.equal(browser.get('observed_file'), 'lib.tds', `Browser ${debug ? 'raw' : 'optimized'} executes the included function at its source file`);
    if (!native) continue;
    const result = spawnSync(native, [packagePath, '--headless'], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.equal(JSON.parse(result.stdout).globals.observed_file, 'lib.tds', `Native ${debug ? 'raw' : 'optimized'} executes the included function at its source file`);
  }
});
test('compiled variable metadata preserves read-only status for external globals', () => {
  const externalGlobals = new Map([['fixed_score', 'int'], ['live_score', 'int']]);
  externalGlobals.readonlyNames = new Set(['fixed_score']);
  const compiled = compile(parse('scene main { say narrator "{fixed_score} {live_score}" }'), externalGlobals);
  assert.deepEqual(compiled.variables.map(({ name, mutable }) => [name, mutable]), [
    ['fixed_score', false],
    ['live_score', true],
  ]);
  assert.throws(() => compile(parse('scene main { set fixed_score = 1 }'), externalGlobals), /変更できません/);
});
test('metadata isolates sibling branch shadowing', () => {
  const p = program('int x = 1\nfn f(flag: int) -> none {\nif flag == 1 {\nint x = 2\nsay narrator "{x}"\n} else {\nsay narrator "{x}"\n}\n}');
  const global = p.variables.find((variable) => variable.name === 'x' && variable.scope === 'global');
  const local = p.variables.find((variable) => variable.name === 'x' && variable.scope === 'function');
  assert.ok(global);
  assert.ok(local);
  assert.equal(global.references.filter((reference) => reference.kind === 'interpolation').length, 1);
  assert.equal(local.references.filter((reference) => reference.kind === 'interpolation').length, 1);

  const merged = program('fn f(flag: int) -> none {\nif flag == 1 {\nint branch = 1\n} else {\nint branch = 2\n}\nsay narrator "{branch}"\n}');
  const branch = merged.variables.filter((variable) => variable.name === 'branch');
  assert.equal(branch.length, 1);
  assert.equal(branch[0].definitions.length, 2);
  assert.equal(branch[0].references.filter((reference) => reference.kind === 'interpolation').length, 1);
});
test('metadata keeps while-body declarations out of zero-iteration paths', () => {
  const p = program('int x = 1\nfn f(flag: int) -> none {\nwhile flag == 0 {\nint x = 2\nsay narrator "{x}"\nset flag = 1\n}\nsay narrator "{x}"\n}');
  const global = p.variables.find((variable) => variable.name === 'x' && variable.scope === 'global');
  const local = p.variables.find((variable) => variable.name === 'x' && variable.scope === 'function');
  assert.ok(global);
  assert.ok(local);
  assert.equal(global.references.filter((reference) => reference.kind === 'interpolation').length, 1);
  assert.equal(local.references.filter((reference) => reference.kind === 'interpolation').length, 1);
  const dead = program('int x = 1\nfn f() -> none {\nwhile 1 == 0 {\nint x = 2\nsay narrator "{x}"\n}\nsay narrator "{x}"\n}');
  assert.equal(dead.variables.filter((variable) => variable.name === 'x' && variable.scope === 'function').length, 0);
});
test('metadata keeps dynamic for declarations out of zero-iteration paths', () => {
  const dynamic = program('int x = 1\nfn f(stop: int) -> none {\nfor i from 0 to stop step 1 {\nint x = 2\nsay narrator "{x}"\n}\nsay narrator "{x}"\n}');
  const dynamicGlobal = dynamic.variables.find((variable) => variable.name === 'x' && variable.scope === 'global');
  const dynamicLocal = dynamic.variables.find((variable) => variable.name === 'x' && variable.scope === 'function');
  assert.equal(dynamicGlobal.references.filter((reference) => reference.kind === 'interpolation').length, 1);
  assert.equal(dynamicLocal.references.filter((reference) => reference.kind === 'interpolation').length, 1);

  const fixed = program('int x = 1\nfn f() -> none {\nfor i from 0 to 1 step 1 {\nint x = 2\nsay narrator "{x}"\n}\nsay narrator "{x}"\n}');
  const fixedGlobal = fixed.variables.find((variable) => variable.name === 'x' && variable.scope === 'global');
  const fixedLocal = fixed.variables.find((variable) => variable.name === 'x' && variable.scope === 'function');
  assert.equal(fixedGlobal.references.filter((reference) => reference.kind === 'interpolation').length, 0);
  assert.equal(fixedLocal.references.filter((reference) => reference.kind === 'interpolation').length, 2);
});
test('metadata follows a statically selected branch after its declaration', () => {
  const p = program('int x = 1\nfn f() -> none {\nif 1 == 1 {\nint x = 2\nsay narrator "{x}"\n}\nsay narrator "{x}"\n}');
  const global = p.variables.find((variable) => variable.name === 'x' && variable.scope === 'global');
  const local = p.variables.find((variable) => variable.name === 'x' && variable.scope === 'function');
  assert.ok(global);
  assert.ok(local);
  assert.equal(global.references.filter((reference) => reference.kind === 'interpolation').length, 0);
  assert.equal(local.references.filter((reference) => reference.kind === 'interpolation').length, 2);
});
test('type checking follows a statically selected shadowing branch', () => {
  assert.throws(() => program('str x = "global"\nfn f() -> none {\nif 1 == 1 {\nint x = 1\n}\nset x = x + "!"\n}\nf()'), /蝙九|int|str/);
  assert.throws(() => program('int x = 1\nfn f() -> none {\nif 1 == 1 {\nstr x = "local"\n}\nset x = x + 1\n}\nf()'), /蝙九|int|str/);
});
test('type and metadata flow merge same-type shadowing on every branch', () => {
  const p = program('str x = "global"\nfn f(flag: int) -> none {\nif flag == 0 {\nint x = 1\n} else {\nint x = 2\n}\nset x = x + 1\n}');
  const global = p.variables.find((variable) => variable.name === 'x' && variable.scope === 'global');
  const local = p.variables.find((variable) => variable.name === 'x' && variable.scope === 'function');
  assert.ok(global);
  assert.ok(local);
  assert.equal(global.references.length, 0);
  assert.equal(local.definitions.length, 2);
  assert.equal(local.references.length, 2);
  assert.throws(() => program('int x = 0\nfn f(flag: int) -> none {\nif flag == 0 {\nconst int x = 1\n} else {\nint x = 2\n}\nset x = x + 1\n}'), /const|螟画峩/);
});
test('type flow rejects path-dependent while shadowing after the loop', () => {
  assert.throws(() => program('str x = "global"\nfn f(flag: int) -> none {\nwhile flag == 0 {\nint x = 1\nset flag = 1\n}\nset x = x + "!"\n}'), /\u578b\u30a8\u30e9\u30fc|\u578b\u3092\u7279\u5b9a\u3067\u304d\u307e\u305b\u3093/);
  assert.doesNotThrow(() => program('str x = "global"\nfn f(flag: int) -> none {\nwhile flag == 0 {\nstr x = "local"\nset flag = 1\n}\nset x = x + "!"\n}'));
  assert.throws(() => program('int x = 0\nfn f(flag: int) -> none {\nwhile flag == 0 {\nconst int x = 1\nset flag = 1\n}\nset x = x + 1\n}'), /const|螟画峩/);
});
test('type flow tracks shadowing declarations across dynamic and fixed for loops', () => {
  assert.throws(() => program('str x = "global"\nfn f(stop: int) -> none {\nfor i from 0 to stop step 1 {\nint x = 1\n}\nset x = x + "!"\n}'), /\u578b\u30a8\u30e9\u30fc|\u578b\u3092\u7279\u5b9a\u3067\u304d\u307e\u305b\u3093/);
  assert.doesNotThrow(() => program('str x = "global"\nfn f(stop: int) -> none {\nfor i from 0 to stop step 1 {\nstr x = "local"\n}\nset x = x + "!"\n}'));
  assert.throws(() => program('int x = 0\nfn f(stop: int) -> none {\nfor i from 0 to stop step 1 {\nconst int x = 1\n}\nset x = x + 1\n}'), /const|螟画峩/);
  assert.throws(() => program('str x = "global"\nfn f() -> none {\nfor i from 0 to 1 step 1 {\nint x = 1\n}\nset x = x + "!"\n}'), /\u578b\u30a8\u30e9\u30fc|\u578b\u3092\u7279\u5b9a\u3067\u304d\u307e\u305b\u3093/);
});
test('type checking rejects redeclarations hidden in control-flow bodies', () => {
  assert.throws(() => program('int x = 0\nfn f(flag: int) -> none {\nif flag == 0 {\nint x = 1\n}\nint x = 2\n}'), /螟画焚|declare|再宣言/);
  assert.throws(() => program('int x = 0\nfn f(flag: int) -> none {\nwhile flag == 0 {\nint x = 1\nset flag = 1\n}\nint x = 2\n}'), /螟画焚|declare|再宣言/);
  assert.throws(() => program('int x = 0\nfn f(stop: int) -> none {\nfor i from 0 to stop step 1 {\nint x = 1\n}\nint x = 2\n}'), /螟画焚|declare|再宣言/);
  assert.throws(() => program('int x = 0\nfn f() -> none {\nfor i from 0 to 1 step 1 {\nint x = 1\n}\nint x = 2\n}'), /螟画焚|declare|再宣言/);
});
test('flow validation rejects disconnected files and accepts local bindings', () => {
  const { validateGraph, collectSyntaxDiagnostics } = require('../Edit/server');
  const syntaxErrors = collectSyntaxDiagnostics('say narrator "unterminated\nwait (\nsay narrator "valid"', 'broken.tds');
  assert.deepEqual(syntaxErrors.map((item) => item.line), [1, 2]);
  assert.ok(syntaxErrors.every((item) => item.endColumn > item.column));
  const invalidCharacter = collectSyntaxDiagnostics('say narrator "ok" § trailing text', 'invalid.tds')[0];
  assert.deepEqual([invalidCharacter.line, invalidCharacter.column, invalidCharacter.endColumn], [1, 19, 20]);
  const invalidEmoji = collectSyntaxDiagnostics('😀 trailing text', 'emoji.tds')[0];
  assert.deepEqual([invalidEmoji.column, invalidEmoji.endColumn], [1, 3]);
  const unknownEscape = collectSyntaxDiagnostics(String.raw`str value = "a\q"`, 'escape.tds')[0];
  assert.deepEqual([unknownEscape.column, unknownEscape.endColumn], [16, 17], 'the diagnostic points to the unsupported escape character');
  const unknownEscapeAfterDecodedNewline = collectSyntaxDiagnostics(String.raw`str value = "a\nb\q"`, 'escape-after-newline.tds')[0];
  assert.deepEqual([unknownEscapeAfterDecodedNewline.column, unknownEscapeAfterDecodedNewline.endColumn], [19, 20], 'decoded escapes before the error do not shift its source position');
  const endOfFileError = collectSyntaxDiagnostics('wait 1 +', 'eof.tds')[0];
  assert.deepEqual([endOfFileError.column, endOfFileError.endColumn], [9, 10], 'an error at end of file retains a non-empty diagnostic range');
  const sameLineErrors = collectSyntaxDiagnostics(`say narrator "ok" ${String.fromCharCode(0x00a7)} @`, 'same-line.tds');
  assert.deepEqual(sameLineErrors.map((item) => item.column), [19, 21], 'IDE validation recovers independent syntax errors on the same line');
  const belowSyntaxLimit = collectSyntaxDiagnostics('@ '.repeat(100), 'syntax-limit.tds');
  assert.equal(belowSyntaxLimit.length, 100);
  assert.ok(belowSyntaxLimit.every((item) => item.code === 'syntax-error'));
  const beyondSyntaxLimit = collectSyntaxDiagnostics('@ '.repeat(105), 'syntax-truncated.tds');
  assert.equal(beyondSyntaxLimit.filter((item) => item.code === 'syntax-error').length, 100);
  assert.equal(beyondSyntaxLimit.at(-1).code, 'syntax-diagnostics-truncated');
  assert.equal(beyondSyntaxLimit.at(-1).severity, 'warning');
  const unterminated = collectSyntaxDiagnostics('say narrator "unfinished', 'string.tds')[0];
  assert.deepEqual([unterminated.column, unterminated.endColumn], [14, 25]);
  const unicodeSyntaxErrors = collectSyntaxDiagnostics('say narrator "unterminated\u2028wait (\u2029say narrator "valid"', 'unicode.tds');
  assert.deepEqual(unicodeSyntaxErrors.map((item) => item.line), [1, 2]);
  const nodes = [{ id: 'a.tds', variables: [] }, { id: 'b.tds', variables: [] }];
  assert.equal(validateGraph({ nodes, edges: [] }, 'a.tds', 'b.tds').ok, false);
  nodes[0].variables = [{ name: 'x', definitions: [{ scope: 'function' }], references: [{ scope: 'function' }] }];
  assert.equal(validateGraph({ nodes, edges: [{ from: 'a.tds', to: 'b.tds' }] }, 'a.tds', 'b.tds').ok, true);
  nodes.push({ id: 'broken.tds', error: true, variables: [] });
  const edges = [{ from: 'a.tds', to: 'b.tds' }, { from: 'a.tds', to: 'broken.tds' }];
  assert.equal(validateGraph({ nodes, edges }, 'a.tds', 'b.tds').ok, false);
  const forward = [
    { id: 'start.tds', variables: [] },
    { id: 'next.tds', variables: [{ name: 'late', scope: 'global', definitions: [], references: [{ scope: 'global', line: 1 }] }] },
  ];
  assert.equal(validateGraph({ nodes: forward, edges: [{ from: 'start.tds', to: 'next.tds' }] }, 'start.tds', 'next.tds').ok, false);
  const bounded = [{ id: 'start.tds', variables: [] }, { id: 'end.tds', variables: [] }, { id: 'after.tds', error: true, variables: [] }];
  const boundedResult = validateGraph({ nodes: bounded, edges: [{ from: 'start.tds', to: 'end.tds' }, { from: 'end.tds', to: 'after.tds' }] }, 'start.tds', 'end.tds');
  assert.equal(boundedResult.ok, true);
  assert.deepEqual(boundedResult.path, ['start.tds', 'end.tds']);
  assert.deepEqual(boundedResult.checked, ['start.tds', 'end.tds']);
});

test('IDE static file errors are localized in Japanese', async () => {
  const { serveStatic } = require('../Edit/server');
  async function request(pathname) {
    const response = { status: 0, body: '' };
    response.writeHead = status => { response.status = status; };
    response.end = body => { response.body = body; };
    await serveStatic(response, pathname);
    return response;
  }
  const missing = await request('/missing-static-resource.js');
  assert.deepEqual([missing.status, missing.body], [404, '要求されたファイルが見つかりません']);
  const outsideAsset = await request('/asset/%2e%2e/outside.png');
  assert.deepEqual([outsideAsset.status, outsideAsset.body], [403, '作品のassetフォルダー外は参照できません']);
});

test('flow validation does not treat module imports as scenario routes', () => {
  const { validateGraph } = require('../Edit/server');
  const nodes = [
    { id: 'main.tds', variables: [] },
    { id: 'common.tds', variables: [] },
    { id: 'ending.tds', variables: [] },
  ];
  const edges = [
    { from: 'main.tds', to: 'common.tds', kind: 'include' },
    { from: 'common.tds', to: 'ending.tds', kind: 'goto' },
  ];
  const report = validateGraph({ version: 2, nodes, edges }, 'main.tds', 'ending.tds');
  assert.equal(report.ok, false);
  assert.match(report.errors[0].message, /経路がありません/);
  assert.deepEqual(edges.map((edge) => edge.kind), ['include', 'goto']);
});

test('package flow keeps the zero-iteration path of a dynamic for loop', () => {
  const functionBody = [
    { op: 'for', name: 'i', start: { kind: 'integer', value: '0' }, stop: { kind: 'load', name: 'stop' }, step: { kind: 'integer', value: '1' }, body: [
      { op: 'declare', type: 'int', name: 'value', initial: { kind: 'integer', value: '8' } },
    ] },
    { op: 'return', value: { kind: 'load', name: 'value' } },
  ];
  const files = { 'main.tds': {
    version: 2, assets: [], characters: [], globals: [
      { op: 'declare', type: 'int', name: 'stop', initial: { kind: 'integer', value: '0' } },
      { op: 'call', name: 'read', args: [] },
    ], functions: [
      { op: 'function', name: 'read', returnType: 'none', params: [], body: functionBody },
    ], scenes: [], variables: [],
  } };
  assert.throws(() => validateVariableFlow(files, 'main.tds'), /初期化前のグローバル変数.*value/);
});

test('package flow visits for-in bodies and follows strings produced by text.split', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-for-in-package-flow-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const scenesRoot = path.join(dir, 'scenes'), assetsRoot = path.join(dir, 'assets');
  await fs.mkdir(scenesRoot); await fs.mkdir(assetsRoot);
  const source = `global list[str] parts = text.split("{notDefined},ready", ",")
scene main {
  for part in parts {
    say narrator part
  }
}`;
  const file = path.join(scenesRoot, 'main.tds');
  await fs.writeFile(file, source, 'utf8');
  await assert.rejects(pack(file, path.join(dir, 'out/game.nsp.json'), { scenesRoot, assetsRoot }), /notDefined/);
});

test('package flow follows interpolated function calls', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-interpolation-flow-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const scenesRoot = path.join(dir, 'scenes'), assetsRoot = path.join(dir, 'assets');
  await fs.mkdir(scenesRoot); await fs.mkdir(assetsRoot);
  await fs.writeFile(path.join(scenesRoot, 'main.tds'), 'fn read_late() -> str { return str(later) }\nchoice "{read_late()}" {\n"continue" { }\n}\nglobal int later = 1');
  await assert.rejects(pack(path.join(scenesRoot, 'main.tds'), path.join(dir, 'out/game.json'), { scenesRoot, assetsRoot }), /初期化前のグローバル変数.*later/);
});

test('package flow does not execute dormant interpolation literals', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-dormant-interpolation-flow-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const scenesRoot = path.join(dir, 'scenes'), assetsRoot = path.join(dir, 'assets');
  await fs.mkdir(scenesRoot); await fs.mkdir(assetsRoot);
  await fs.writeFile(path.join(scenesRoot, 'main.tds'), 'fn read_late() -> str { return str(later) }\nstr template = "{read_late()}"\nglobal int later = 1');
  await assert.doesNotReject(pack(path.join(scenesRoot, 'main.tds'), path.join(dir, 'out/game.json'), { scenesRoot, assetsRoot }));
});

test('package flow executes a loaded interpolation literal only in text position', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-loaded-interpolation-flow-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const scenesRoot = path.join(dir, 'scenes'), assetsRoot = path.join(dir, 'assets');
  await fs.mkdir(scenesRoot); await fs.mkdir(assetsRoot);
  await fs.writeFile(path.join(scenesRoot, 'main.tds'), 'fn read_late() -> str { return str(later) }\nstr template = "{read_late()}"\nsay narrator template\nglobal int later = 1');
  await assert.rejects(pack(path.join(scenesRoot, 'main.tds'), path.join(dir, 'out/game.json'), { scenesRoot, assetsRoot }), /初期化前のグローバル変数.*later/);
});

test('package flow does not leak caller locals into function constant facts', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-function-local-flow-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const scenesRoot = path.join(dir, 'scenes'), assetsRoot = path.join(dir, 'assets');
  await fs.mkdir(scenesRoot); await fs.mkdir(assetsRoot);
  await fs.writeFile(path.join(scenesRoot, 'main.tds'), 'const int x = 0\nfn read() -> int { if x == 0 and later == 1 { return 1 } return 0 }\nfn caller() -> int { const int x = 1\nreturn read() }\nint result = caller()');
  await fs.writeFile(path.join(scenesRoot, 'later.tds'), 'global int later = 1');
  await assert.rejects(pack(path.join(scenesRoot, 'main.tds'), path.join(dir, 'out/game.json'), { scenesRoot, assetsRoot }), /初期化前のグローバル変数.*later/);
});

test('package flow preserves caller-local interpolation facts across function calls', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-local-template-after-call-flow-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const scenesRoot = path.join(dir, 'scenes'), assetsRoot = path.join(dir, 'assets');
  await fs.mkdir(scenesRoot); await fs.mkdir(assetsRoot);
  await fs.writeFile(path.join(scenesRoot, 'main.tds'), 'fn noop() -> none { }\nfn display() -> none { dict[str] local = { "message": "{later}" }\nnoop()\nsay narrator "{local}" }\ndisplay()');
  await fs.writeFile(path.join(scenesRoot, 'later.tds'), 'global int later = 1');
  await assert.rejects(pack(path.join(scenesRoot, 'main.tds'), path.join(dir, 'out/game.json'), { scenesRoot, assetsRoot }), /later/);
});

test('package flow follows caller-local facts after a finite while with a function call', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-local-template-after-while-flow-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const scenesRoot = path.join(dir, 'scenes'), assetsRoot = path.join(dir, 'assets');
  await fs.mkdir(scenesRoot); await fs.mkdir(assetsRoot);
  await fs.writeFile(path.join(scenesRoot, 'main.tds'), 'fn noop() -> none { }\nfn display(flag: int) -> none { dict[str] local = { "message": "{later}" }\nwhile flag == 0 { noop()\nset flag = 1 }\nsay narrator "{local}" }\ndisplay(0)');
  await fs.writeFile(path.join(scenesRoot, 'later.tds'), 'global int later = 1');
  await assert.rejects(pack(path.join(scenesRoot, 'main.tds'), path.join(dir, 'out/game.json'), { scenesRoot, assetsRoot }), /later/);
});

test('package flow rejects a statically missing dictionary key after unset', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-dictionary-key-flow-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const scenesRoot = path.join(dir, 'scenes'), assetsRoot = path.join(dir, 'assets');
  await fs.mkdir(scenesRoot); await fs.mkdir(assetsRoot);
  const sources = [
    'dict[str] values = { "key": "value" }\nunset values["key"]\nunset values["key"]',
    'dict[str] values = { "key": "value" }\nstr key = "missing"\nunset values[key]',
    'dict[str] values = { "key": "value" }\nstr key = "missing"\nstr result = values[key]',
    'fn make_values() -> dict[str] { return { "key": "value" } }\ndict[str] values = make_values()\nstr key = "missing"\nunset values[key]',
  ];
  for (const [index, source] of sources.entries()) {
    await fs.writeFile(path.join(scenesRoot, 'main.tds'), source);
    await assert.rejects(pack(path.join(scenesRoot, 'main.tds'), path.join(dir, `out/game-${index}.json`), { scenesRoot, assetsRoot }), /key|missing/);
  }
});

test('package flow does not leak a shadowing function parameter into a global string', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-parameter-shadow-flow-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const scenesRoot = path.join(dir, 'scenes'), assetsRoot = path.join(dir, 'assets');
  await fs.mkdir(scenesRoot); await fs.mkdir(assetsRoot);
  await fs.writeFile(path.join(scenesRoot, 'main.tds'), 'str x = "safe"\nfn read_late() -> str { return str(later) }\nfn mutate(x: str) -> none { set x = "{read_late()}" }\nmutate("argument")\nsay narrator "{x}"');
  await fs.writeFile(path.join(scenesRoot, 'later.tds'), 'global int later = 1');
  await assert.doesNotReject(pack(path.join(scenesRoot, 'main.tds'), path.join(dir, 'out/game.json'), { scenesRoot, assetsRoot }));
});

test('package flow does not treat a string parameter passed from a global as an alias', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-string-parameter-value-flow-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const scenesRoot = path.join(dir, 'scenes'), assetsRoot = path.join(dir, 'assets');
  await fs.mkdir(scenesRoot); await fs.mkdir(assetsRoot);
  await fs.writeFile(path.join(scenesRoot, 'main.tds'), 'fn read_late() -> str { return str(later) }\nstr x = "safe"\nfn mutate(x: str) -> none { set x = "{read_late()}" }\nmutate(x)\nsay narrator "{x}"');
  await fs.writeFile(path.join(scenesRoot, 'later.tds'), 'global int later = 1');
  await assert.doesNotReject(pack(path.join(scenesRoot, 'main.tds'), path.join(dir, 'out/game.json'), { scenesRoot, assetsRoot }));
});

test('package flow does not leak a shadowing function declaration into a global string', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-declaration-shadow-flow-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const scenesRoot = path.join(dir, 'scenes'), assetsRoot = path.join(dir, 'assets');
  await fs.mkdir(scenesRoot); await fs.mkdir(assetsRoot);
  await fs.writeFile(path.join(scenesRoot, 'main.tds'), 'str x = "safe"\nfn read_late() -> str { return str(later) }\nfn mutate() -> none { str x = "{read_late()}" }\nmutate()\nsay narrator "{x}"');
  await fs.writeFile(path.join(scenesRoot, 'later.tds'), 'global int later = 1');
  await assert.doesNotReject(pack(path.join(scenesRoot, 'main.tds'), path.join(dir, 'out/game.json'), { scenesRoot, assetsRoot }));
});

test('package flow keeps a global write that happens before a shadowing declaration', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-pre-shadow-global-flow-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const scenesRoot = path.join(dir, 'scenes'), assetsRoot = path.join(dir, 'assets');
  await fs.mkdir(scenesRoot); await fs.mkdir(assetsRoot);
  await fs.writeFile(path.join(scenesRoot, 'main.tds'), 'str x = "safe"\nfn read_late() -> str { return str(later) }\nfn mutate() -> none { set x = "{read_late()}"\nstr x = "local" }\nmutate()\nsay narrator "{x}"');
  await fs.writeFile(path.join(scenesRoot, 'later.tds'), 'global int later = 1');
  await assert.rejects(pack(path.join(scenesRoot, 'main.tds'), path.join(dir, 'out/game.json'), { scenesRoot, assetsRoot }), /later/);
});

test('package flow inspects every possible global string after a conditional function write', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-conditional-string-effect-flow-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const scenesRoot = path.join(dir, 'scenes'), assetsRoot = path.join(dir, 'assets');
  await fs.mkdir(scenesRoot); await fs.mkdir(assetsRoot);
  await fs.writeFile(path.join(scenesRoot, 'main.tds'), 'str template = "safe"\nfn read_late() -> str { return str(later) }\nfn maybe(flag: int) -> none { if flag == 0 { set template = "{read_late()}" } }\nmaybe(0)\nsay narrator "{template}"');
  await fs.writeFile(path.join(scenesRoot, 'later.tds'), 'global int later = 1');
  await assert.rejects(pack(path.join(scenesRoot, 'main.tds'), path.join(dir, 'out/game.json'), { scenesRoot, assetsRoot }), /later/);
});

test('package flow carries all static string return candidates into assignments', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-return-candidate-flow-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const scenesRoot = path.join(dir, 'scenes'), assetsRoot = path.join(dir, 'assets');
  await fs.mkdir(scenesRoot); await fs.mkdir(assetsRoot);
  await fs.writeFile(path.join(scenesRoot, 'main.tds'), 'fn read_late() -> str { return str(later) }\nfn maybe(flag: int) -> str { if flag == 0 { return "{read_late()}" } return "safe" }\nstr template = maybe(0)\nsay narrator "{template}"');
  await fs.writeFile(path.join(scenesRoot, 'later.tds'), 'global int later = 1');
  await assert.rejects(pack(path.join(scenesRoot, 'main.tds'), path.join(dir, 'out/game.json'), { scenesRoot, assetsRoot }), /later/);
});

test('package flow composes string candidates through nested function returns', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-nested-return-candidate-flow-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const scenesRoot = path.join(dir, 'scenes'), assetsRoot = path.join(dir, 'assets');
  await fs.mkdir(scenesRoot); await fs.mkdir(assetsRoot);
  await fs.writeFile(path.join(scenesRoot, 'main.tds'), 'fn read_late() -> str { return "{later}" }\nfn build() -> str { return "prefix " + read_late() }\nstr template = build()\nsay narrator "{template}"');
  await fs.writeFile(path.join(scenesRoot, 'later.tds'), 'global int later = 1');
  await assert.rejects(pack(path.join(scenesRoot, 'main.tds'), path.join(dir, 'out/game.json'), { scenesRoot, assetsRoot }), /later/);
});

test('package flow does not leak nested argument return candidates into the outer result', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-nested-argument-flow-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const scenesRoot = path.join(dir, 'scenes'), assetsRoot = path.join(dir, 'assets');
  await fs.mkdir(scenesRoot); await fs.mkdir(assetsRoot);
  await fs.writeFile(path.join(scenesRoot, 'main.tds'), 'fn inner() -> str { return "{later}" }\nfn wrapper(value: str) -> str { return "safe" }\nstr template = wrapper(inner())\nsay narrator "{template}"');
  await fs.writeFile(path.join(scenesRoot, 'later.tds'), 'global int later = 1');
  await assert.doesNotReject(pack(path.join(scenesRoot, 'main.tds'), path.join(dir, 'out/game.json'), { scenesRoot, assetsRoot }));
});

test('package flow composes builtin conversion results in returned templates', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-builtin-return-flow-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const scenesRoot = path.join(dir, 'scenes'), assetsRoot = path.join(dir, 'assets');
  await fs.mkdir(scenesRoot); await fs.mkdir(assetsRoot);
  await fs.writeFile(path.join(scenesRoot, 'main.tds'), 'fn build() -> str { return str(1) + "{later}" }\nstr template = build()\nsay narrator "{template}"');
  await fs.writeFile(path.join(scenesRoot, 'later.tds'), 'global int later = 1');
  await assert.rejects(pack(path.join(scenesRoot, 'main.tds'), path.join(dir, 'out/game.json'), { scenesRoot, assetsRoot }), /later/);
});

test('package flow merges choice constants only when every option preserves them', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-choice-constant-flow-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const scenesRoot = path.join(dir, 'scenes'), assetsRoot = path.join(dir, 'assets');
  await fs.mkdir(scenesRoot); await fs.mkdir(assetsRoot);
  await fs.writeFile(path.join(scenesRoot, 'main.tds'), 'int route = 0\nset route = 0\nchoice { "change" { set route = 1 } "keep" { } }\nif route == 0 and later == 1 { wait 1 }');
  await fs.writeFile(path.join(scenesRoot, 'later.tds'), 'global int later = 1');
  await assert.rejects(pack(path.join(scenesRoot, 'main.tds'), path.join(dir, 'out/game.json'), { scenesRoot, assetsRoot }), /初期化前のグローバル変数.*later/);
});

test('package flow follows statically constructed text returned by a function', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-returned-text-flow-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const scenesRoot = path.join(dir, 'scenes'), assetsRoot = path.join(dir, 'assets');
  await fs.mkdir(scenesRoot); await fs.mkdir(assetsRoot);
  await fs.writeFile(path.join(scenesRoot, 'main.tds'), 'fn build() -> str { str name = "later"\nreturn "{" + name + "}" }\nsay narrator build()\nglobal int later = 1');
  await assert.rejects(pack(path.join(scenesRoot, 'main.tds'), path.join(dir, 'out/game.json'), { scenesRoot, assetsRoot }), /初期化前のグローバル変数.*later/);
});

test('package flow evaluates choice labels before the prompt', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-choice-text-order-flow-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const scenesRoot = path.join(dir, 'scenes'), assetsRoot = path.join(dir, 'assets');
  await fs.mkdir(scenesRoot); await fs.mkdir(assetsRoot);
  await fs.writeFile(path.join(scenesRoot, 'main.tds'), 'str template = "safe"\nfn read_late() -> str { return str(later) }\nfn label() -> str { set template = "{read_late()}"\nreturn "label" }\nchoice "{template}" { "{label()}" { } }');
  await fs.writeFile(path.join(scenesRoot, 'later.tds'), 'global int later = 1');
  await assert.rejects(pack(path.join(scenesRoot, 'main.tds'), path.join(dir, 'out/game.json'), { scenesRoot, assetsRoot }), /初期化前のグローバル変数.*later/);
});

test('package flow carries prompt side effects into every choice body', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-choice-prompt-effect-flow-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const scenesRoot = path.join(dir, 'scenes'), assetsRoot = path.join(dir, 'assets');
  await fs.mkdir(scenesRoot); await fs.mkdir(assetsRoot);
  await fs.writeFile(path.join(scenesRoot, 'main.tds'), 'str template = "safe"\nfn read_late() -> str { return str(later) }\nfn prompt() -> str { set template = "{read_late()}"\nreturn "prompt" }\nchoice "{prompt()}" { "ok" { say narrator "{template}" } }');
  await fs.writeFile(path.join(scenesRoot, 'later.tds'), 'global int later = 1');
  await assert.rejects(pack(path.join(scenesRoot, 'main.tds'), path.join(dir, 'out/game.json'), { scenesRoot, assetsRoot }), /later/);
});

test('package flow does not leak an unselected choice body into later labels', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-choice-body-order-flow-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const scenesRoot = path.join(dir, 'scenes'), assetsRoot = path.join(dir, 'assets');
  await fs.mkdir(scenesRoot); await fs.mkdir(assetsRoot);
  await fs.writeFile(path.join(scenesRoot, 'main.tds'), 'str template = "safe"\nfn read_late() -> str { return str(later) }\nchoice { "first" { set template = "{read_late()}" } "{template}" { } }');
  await fs.writeFile(path.join(scenesRoot, 'later.tds'), 'global int later = 1');
  await assert.doesNotReject(pack(path.join(scenesRoot, 'main.tds'), path.join(dir, 'out/game.json'), { scenesRoot, assetsRoot }));
});

test('package flow carries string candidates out of selected choice bodies', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-choice-string-effect-flow-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const scenesRoot = path.join(dir, 'scenes'), assetsRoot = path.join(dir, 'assets');
  await fs.mkdir(scenesRoot); await fs.mkdir(assetsRoot);
  await fs.writeFile(path.join(scenesRoot, 'main.tds'), 'str template = "safe"\nfn read_late() -> str { return str(later) }\nchoice { "ok" { set template = "{read_late()}" } }\nsay narrator "{template}"');
  await fs.writeFile(path.join(scenesRoot, 'later.tds'), 'global int later = 1');
  await assert.rejects(pack(path.join(scenesRoot, 'main.tds'), path.join(dir, 'out/game.json'), { scenesRoot, assetsRoot }), /later/);
});

test('package flow respects immutable constants in short-circuit conditions', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-constant-flow-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const scenesRoot = path.join(dir, 'scenes'), assetsRoot = path.join(dir, 'assets');
  await fs.mkdir(scenesRoot); await fs.mkdir(assetsRoot);
  await fs.writeFile(path.join(scenesRoot, 'main.tds'), 'const int flag = 0\nif flag == 1 and later == 1 { wait 1 }');
  await fs.writeFile(path.join(scenesRoot, 'later.tds'), 'global int later = 1');
  await assert.doesNotReject(pack(path.join(scenesRoot, 'main.tds'), path.join(dir, 'out/game.json'), { scenesRoot, assetsRoot }));
});

test('package flow keeps dormant interpolation literals constant in conditions', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-interpolated-condition-flow-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const scenesRoot = path.join(dir, 'scenes'), assetsRoot = path.join(dir, 'assets');
  await fs.mkdir(scenesRoot); await fs.mkdir(assetsRoot);
  await fs.writeFile(path.join(scenesRoot, 'main.tds'), 'fn tick() -> str { return "tick" }\nfn read_late() -> str { return str(later) }\nif "{tick()}" == "{tick()}" { wait 1 } else { say narrator "{read_late()}" }');
  await fs.writeFile(path.join(scenesRoot, 'later.tds'), 'global int later = 1');
  await assert.doesNotReject(pack(path.join(scenesRoot, 'main.tds'), path.join(dir, 'out/game.json'), { scenesRoot, assetsRoot }));
});

test('package flow follows statically known nested interpolation strings', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-nested-interpolation-flow-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const scenesRoot = path.join(dir, 'scenes'), assetsRoot = path.join(dir, 'assets');
  await fs.mkdir(scenesRoot); await fs.mkdir(assetsRoot);
  await fs.writeFile(path.join(scenesRoot, 'main.tds'), 'fn read_late() -> str { return str(later) }\nstr template = "{read_late()}"\nsay narrator "{template}"');
  await fs.writeFile(path.join(scenesRoot, 'later.tds'), 'global int later = 1');
  await assert.rejects(pack(path.join(scenesRoot, 'main.tds'), path.join(dir, 'out/game.json'), { scenesRoot, assetsRoot }), /later/);
});

test('package flow inspects interpolation templates nested in displayed dictionaries', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-dictionary-interpolation-flow-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const scenesRoot = path.join(dir, 'scenes'), assetsRoot = path.join(dir, 'assets');
  await fs.mkdir(scenesRoot); await fs.mkdir(assetsRoot);
  await fs.writeFile(path.join(scenesRoot, 'main.tds'), 'fn read_late() -> str { return str(later) }\ndict[str] values = { "message": "{read_late()}" }\nsay narrator "{values}"');
  await fs.writeFile(path.join(scenesRoot, 'later.tds'), 'global int later = 1');
  await assert.rejects(pack(path.join(scenesRoot, 'main.tds'), path.join(dir, 'out/game.json'), { scenesRoot, assetsRoot }), /later/);
});

test('package flow follows templates in dictionaries returned by functions', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-returned-dictionary-interpolation-flow-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const scenesRoot = path.join(dir, 'scenes'), assetsRoot = path.join(dir, 'assets');
  await fs.mkdir(scenesRoot); await fs.mkdir(assetsRoot);
  await fs.writeFile(path.join(scenesRoot, 'main.tds'), 'fn read_late() -> str { return str(later) }\nfn make_values() -> dict[str] { return { "message": "{read_late()}" } }\ndict[str] values = make_values()\nsay narrator "{values}"');
  await fs.writeFile(path.join(scenesRoot, 'later.tds'), 'global int later = 1');
  await assert.rejects(pack(path.join(scenesRoot, 'main.tds'), path.join(dir, 'out/game.json'), { scenesRoot, assetsRoot }), /later/);
});

test('package flow follows templates passed through dictionary function parameters', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-dictionary-parameter-interpolation-flow-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const scenesRoot = path.join(dir, 'scenes'), assetsRoot = path.join(dir, 'assets');
  await fs.mkdir(scenesRoot); await fs.mkdir(assetsRoot);
  await fs.writeFile(path.join(scenesRoot, 'main.tds'), 'fn display_values(values: dict[str]) -> none { say narrator "{values}" }\nfn read_late() -> str { return str(later) }\ndict[str] values = { "message": "{read_late()}" }\ndisplay_values(values)');
  await fs.writeFile(path.join(scenesRoot, 'later.tds'), 'global int later = 1');
  await assert.rejects(pack(path.join(scenesRoot, 'main.tds'), path.join(dir, 'out/game.json'), { scenesRoot, assetsRoot }), /later/);
});

test('package flow follows templates passed through string function parameters', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-string-parameter-interpolation-flow-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const scenesRoot = path.join(dir, 'scenes'), assetsRoot = path.join(dir, 'assets');
  await fs.mkdir(scenesRoot); await fs.mkdir(assetsRoot);
  await fs.writeFile(path.join(scenesRoot, 'main.tds'), 'fn read_late() -> str { return str(later) }\nfn display_text(template: str) -> none { say narrator "{template}" }\nstr template = "{read_late()}"\ndisplay_text(template)');
  await fs.writeFile(path.join(scenesRoot, 'later.tds'), 'global int later = 1');
  await assert.rejects(pack(path.join(scenesRoot, 'main.tds'), path.join(dir, 'out/game.json'), { scenesRoot, assetsRoot }), /later/);
});

test('package flow follows templates written through dictionary function parameters', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-dictionary-parameter-write-flow-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const scenesRoot = path.join(dir, 'scenes'), assetsRoot = path.join(dir, 'assets');
  await fs.mkdir(scenesRoot); await fs.mkdir(assetsRoot);
  await fs.writeFile(path.join(scenesRoot, 'main.tds'), 'fn read_late() -> str { return str(later) }\nfn mutate_values(values: dict[str]) -> none { set values["message"] = "{read_late()}" }\ndict[str] values = { "message": "safe" }\nmutate_values(values)\nsay narrator "{values}"');
  await fs.writeFile(path.join(scenesRoot, 'later.tds'), 'global int later = 1');
  await assert.rejects(pack(path.join(scenesRoot, 'main.tds'), path.join(dir, 'out/game.json'), { scenesRoot, assetsRoot }), /later/);
});

test('package flow follows templates written through local dictionary aliases', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-local-dictionary-alias-flow-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const scenesRoot = path.join(dir, 'scenes'), assetsRoot = path.join(dir, 'assets');
  await fs.mkdir(scenesRoot); await fs.mkdir(assetsRoot);
  await fs.writeFile(path.join(scenesRoot, 'main.tds'), 'fn read_late() -> str { return str(later) }\nfn mutate_values() -> none { dict[str] alias = values\nset alias["message"] = "{read_late()}" }\ndict[str] values = { "message": "safe" }\nmutate_values()\nsay narrator "{values}"');
  await fs.writeFile(path.join(scenesRoot, 'later.tds'), 'global int later = 1');
  await assert.rejects(pack(path.join(scenesRoot, 'main.tds'), path.join(dir, 'out/game.json'), { scenesRoot, assetsRoot }), /later/);
});

test('package flow preserves dictionary aliases returned from functions', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-returned-dictionary-alias-flow-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const scenesRoot = path.join(dir, 'scenes'), assetsRoot = path.join(dir, 'assets');
  await fs.mkdir(scenesRoot); await fs.mkdir(assetsRoot);
  await fs.writeFile(path.join(scenesRoot, 'main.tds'), 'fn read_late() -> str { return str(later) }\nfn get_values() -> dict[str] { return values }\ndict[str] values = { "message": "safe" }\ndict[str] alias = get_values()\nset alias["message"] = "{read_late()}"\nsay narrator "{values}"');
  await fs.writeFile(path.join(scenesRoot, 'later.tds'), 'global int later = 1');
  await assert.rejects(pack(path.join(scenesRoot, 'main.tds'), path.join(dir, 'out/game.json'), { scenesRoot, assetsRoot }), /later/);
});

test('package flow preserves dictionary rebinding through functions', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-dictionary-rebinding-flow-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const scenesRoot = path.join(dir, 'scenes'), assetsRoot = path.join(dir, 'assets');
  await fs.mkdir(scenesRoot); await fs.mkdir(assetsRoot);
  await fs.writeFile(path.join(scenesRoot, 'main.tds'), 'fn read_late() -> str { return str(later) }\nfn replace_values() -> none { set values = replacement }\ndict[str] replacement = { "message": "safe" }\ndict[str] values = { "message": "old" }\nreplace_values()\nset values["message"] = "{read_late()}"\nsay narrator "{replacement}"');
  await fs.writeFile(path.join(scenesRoot, 'later.tds'), 'global int later = 1');
  await assert.rejects(pack(path.join(scenesRoot, 'main.tds'), path.join(dir, 'out/game.json'), { scenesRoot, assetsRoot }), /later/);
});

test('package flow inspects every nested interpolation before applying call effects', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-multi-nested-interpolation-flow-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const scenesRoot = path.join(dir, 'scenes'), assetsRoot = path.join(dir, 'assets');
  await fs.mkdir(scenesRoot); await fs.mkdir(assetsRoot);
  await fs.writeFile(path.join(scenesRoot, 'main.tds'), 'fn first() -> str { return "first" }\nfn read_late() -> str { return str(later) }\nstr first_text = "{first()}"\nstr late_text = "{read_late()}"\nsay narrator "{first_text} {late_text}"');
  await fs.writeFile(path.join(scenesRoot, 'later.tds'), 'global int later = 1');
  await assert.rejects(pack(path.join(scenesRoot, 'main.tds'), path.join(dir, 'out/game.json'), { scenesRoot, assetsRoot }), /later/);
});

test('package flow follows statically evaluated nested interpolation aliases', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-static-nested-interpolation-flow-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const scenesRoot = path.join(dir, 'scenes'), assetsRoot = path.join(dir, 'assets');
  await fs.mkdir(scenesRoot); await fs.mkdir(assetsRoot);
  await fs.writeFile(path.join(scenesRoot, 'main.tds'), 'fn read_late() -> str { return str(later) }\nstr seed = "{read_late()}"\nstr template = seed + ""\nsay narrator "{template}"');
  await fs.writeFile(path.join(scenesRoot, 'later.tds'), 'global int later = 1');
  await assert.rejects(pack(path.join(scenesRoot, 'main.tds'), path.join(dir, 'out/game.json'), { scenesRoot, assetsRoot }), /later/);
});

test('scene graph reachability excludes outgoing gotos from dead code and dead scenes', () => {
  const afterTransfer = sceneReachability(parse('scene start { goto live\n goto "dead.tds" }\nscene live { wait 1 }'));
  assert.equal(afterTransfer.externalGotos.has('dead.tds'), false);
  const deadScene = sceneReachability(parse('scene start { wait 1 }\nscene unused { goto "dead.tds" }'));
  assert.equal(deadScene.externalGotos.has('dead.tds'), false);
  const falseLoop = sceneReachability(parse('scene start { while 1 == 2 { goto "dead.tds" } }'));
  assert.equal(falseLoop.externalGotos.has('dead.tds'), false);

  const choiceEdges = sceneReachability(parse('scene start { choice { "A" { goto left } "B" { goto right } } }\nscene left { goto shared }\nscene right { goto shared }\nscene shared { goto tail }\nscene tail { wait 1 }'));
  assert.deepEqual([...choiceEdges.reachableScenes].sort(), ['left', 'right', 'shared', 'start', 'tail']);

  const emptyChoiceEdges = sceneReachability(parse('scene start { choice {}\ngoto next }\nscene next { wait 1 }'));
  assert.equal(emptyChoiceEdges.reachableScenes.has('next'), true, 'an empty choice must preserve the analyzer’s fallthrough semantics');

  const choiceLabelSideEffect = sceneReachability(parse('global int route = 0\nglobal int score = 7\nfn select_route() -> int { set route = 1\nreturn 1 }\nfn choice_label() -> str { say narrator "{select_route()}"\nreturn "label" }\nscene start { choice { "{choice_label()}" { wait 1 } "plain" { wait 1 } }\nif score == 7 { if route == 1 { goto selected } else { goto stale } } else { goto wrong_score } }\nscene selected { wait 1 }\nscene stale { wait 1 }\nscene wrong_score { wait 1 }'));
  assert.equal(choiceLabelSideEffect.reachableScenes.has('selected'), true, 'choice labels execute before branch selection and may update globals');
  assert.equal(choiceLabelSideEffect.reachableScenes.has('stale'), true, 'unknown label side effects must widen the changed value');
  assert.equal(choiceLabelSideEffect.reachableScenes.has('wrong_score'), false, 'known function effects should preserve unrelated constants');

  const choiceInvalidatesFacts = sceneReachability(parse('global int route = 0\nfn change_route() -> int { set route = 1\nreturn 1 }\nscene start { if route == 0 { choice { "{change_route()}" { wait 1 } }\nif route == 0 { goto stale } else { goto changed } } else { goto never_started } }\nscene stale { wait 1 }\nscene changed { wait 1 }\nscene never_started { wait 1 }'));
  assert.equal(choiceInvalidatesFacts.reachableScenes.has('changed'), true, 'choice label side effects invalidate prior condition facts');
  assert.equal(choiceInvalidatesFacts.reachableScenes.has('stale'), true, 'unknown side effects conservatively keep both follow-up branches');
  assert.equal(choiceInvalidatesFacts.reachableScenes.has('never_started'), false);

  const choicePromptSideEffect = sceneReachability(parse('global int route = 0\nfn prompt_route() -> int { set route = 1\nreturn 1 }\nscene start { choice "{prompt_route()}" { "continue" { wait 1 } }\nif route == 1 { goto prompted } else { goto stale_prompt } }\nscene prompted { wait 1 }\nscene stale_prompt { wait 1 }'));
  assert.equal(choicePromptSideEffect.reachableScenes.has('prompted'), true, 'the choice prompt executes after labels and before the selected option body');
  assert.equal(choicePromptSideEffect.reachableScenes.has('stale_prompt'), true, 'prompt effects must invalidate stale variable facts');

  const shortCircuitReachability = sceneReachability(parse('global int route = 0\nfn mutate_route() -> int { set route = 1\nreturn 1 }\nscene start { if 0 == 1 and mutate_route() == 1 { goto impossible_call } else { if route == 0 { goto preserved } else { goto impossible_route } } }\nscene impossible_call { wait 1 }\nscene preserved { wait 1 }\nscene impossible_route { wait 1 }'));
  assert.equal(shortCircuitReachability.reachableScenes.has('impossible_call'), false);
  assert.equal(shortCircuitReachability.reachableScenes.has('preserved'), true);
  assert.equal(shortCircuitReachability.reachableScenes.has('impossible_route'), false, 'short-circuited calls must not invalidate state');

  const falseLoopState = sceneReachability(parse('global str route = "common"\nscene start { set route = "after"\nwhile 1 == 2 { set route = "common" }\nif route == "after" { goto after } else { goto common } }\nscene after { wait 1 }\nscene common { wait 1 }'));
  assert.equal(falseLoopState.reachableScenes.has('after'), true);
  assert.equal(falseLoopState.reachableScenes.has('common'), false, 'a statically skipped while body must not invalidate values');

  const loopEdge = sceneReachability(parse('scene start { for i from 1 to 3 { goto repeated } }\nscene repeated { wait 1 }'));
  assert.deepEqual([...loopEdge.reachableScenes].sort(), ['repeated', 'start']);

  const terminatingLoop = sceneReachability(parse('scene start { while 1 == 1 { wait 1 }\ngoto dead }\nscene dead { wait 1 }'));
  assert.equal(terminatingLoop.reachableScenes.has('dead'), false, 'a goto after a definitely infinite loop is unreachable');

  const loopWidening = sceneReachability(parse('global int route = 0\nscene start { for i from 1 to 2 { set route = i\ngoto middle } }\nscene middle { if route == 1 { goto first } else { goto later } }\nscene first { wait 1 }\nscene later { wait 1 }'));
  assert.equal(loopWidening.reachableScenes.has('first'), true);
  assert.equal(loopWidening.reachableScenes.has('later'), false, 'an unconditional transfer exits on the first iteration with its exact loop value');
  const exactForReachability = sceneReachability(parse('scene start { for i from 1 to 1 { if i == 1 { goto selected } else { goto impossible } } }\nscene selected { wait 1 }\nscene impossible { wait 1 }'));
  assert.equal(exactForReachability.reachableScenes.has('selected'), true);
  assert.equal(exactForReachability.reachableScenes.has('impossible'), false, 'small constant for-loops should specialize each iteration');
  const exactForExitState = sceneReachability(parse('global int route = 0\nscene start { for i from 1 to 1 { set route = 1 }\nif route == 1 { goto selected } else { goto impossible } }\nscene selected { wait 1 }\nscene impossible { wait 1 }'));
  assert.equal(exactForExitState.reachableScenes.has('selected'), true);
  assert.equal(exactForExitState.reachableScenes.has('impossible'), false, 'small constant for-loop exit state should flow to following branches');
  const exactWhileExitState = sceneReachability(parse('global int route = 0\nscene start { while route < 2 { set route = route + 1 }\nif route == 2 { goto selected } else { goto impossible } }\nscene selected { wait 1 }\nscene impossible { wait 1 }'));
  assert.equal(exactWhileExitState.reachableScenes.has('selected'), true);
  assert.equal(exactWhileExitState.reachableScenes.has('impossible'), false, 'small statically counted while-loop exit state should flow to following branches');

  const globalSceneTransfer = sceneReachability(parse('goto destination\nscene default { wait 1 }\nscene destination { wait 1 }'));
  assert.deepEqual([...globalSceneTransfer.reachableScenes], ['destination']);
  assert.equal(globalSceneTransfer.reachableScenes.has('default'), false);

  const globalFileTransfer = sceneReachability(parse('goto "chapter.tds"\nscene default { wait 1 }\nscene chapter_entry { wait 1 }'));
  assert.equal(globalFileTransfer.reachableScenes.has('chapter_entry'), false, 'unlocated ASTs cannot resolve a file goto to a scene');
  assert.equal(globalFileTransfer.externalGotos.has('chapter.tds'), true);

  const globalOrderedTransfer = sceneReachability(parse('global str route = "common"\nif route == "common" { goto common } else { goto alternate }\nscene default { wait 1 }\nscene common { wait 1 }\nscene alternate { wait 1 }'));
  assert.equal(globalOrderedTransfer.reachableScenes.has('common'), true);
  assert.equal(globalOrderedTransfer.reachableScenes.has('alternate'), false, 'global initialization values must be evaluated in execution order');

  const routeState = sceneReachability(parse('global str route = "common"\nscene start { set route = "after"\ngoto middle }\nscene middle { if route == "after" { goto after } else { goto common } }\nscene after { wait 1 }\nscene common { wait 1 }'));
  assert.equal(routeState.reachableScenes.has('after'), true, 'mutable route state must flow across scene transitions');
  assert.equal(routeState.reachableScenes.has('common'), false, 'infeasible route alternatives should remain unreachable when proven by state');
  const mergedRouteState = sceneReachability(parse('global str route = "common"\nscene start { choice { "A" { set route = "after"\ngoto middle } "B" { set route = "common"\ngoto middle } } }\nscene middle { if route == "after" { goto after } else { goto common } }\nscene after { wait 1 }\nscene common { wait 1 }'));
  assert.equal(mergedRouteState.reachableScenes.has('after'), true);
  assert.equal(mergedRouteState.reachableScenes.has('common'), true, 'joining distinct incoming values must widen rather than keep one path value');
  const callWidening = sceneReachability(parse('global str route = "common"\nfn reset_route() -> none { set route = "common"\nreturn }\nscene start { set route = "after"\nreset_route()\ngoto middle }\nscene middle { if route == "after" { goto after } else { goto common } }\nscene after { wait 1 }\nscene common { wait 1 }'));
  assert.equal(callWidening.reachableScenes.has('after'), true);
  assert.equal(callWidening.reachableScenes.has('common'), true, 'unknown function effects must invalidate path constants');
});

test('scenario files are reached by goto and cannot be imported as modules', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-file-goto-reachability-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, 'chapters'));
  await fs.writeFile(path.join(dir, 'chapters', 'chapter01.tds'), 'scene chapter01_s01 { goto chapter01_s02 }\nscene chapter01_s02 { goto "chapters\\\\chapter02.tds" }');
  await fs.writeFile(path.join(dir, 'chapters', 'chapter02.tds'), 'scene chapter02_s01 { wait 1 }');
  const script = await resolveProjectScript('scene main { goto "chapters/chapter01.tds" }', dir, new Set(), 'main.tds');
  const reachability = sceneReachability(script);
  assert.equal(reachability.reachableScenes.has('main'), true);
  assert.equal(reachability.externalGotos.size, 1);
  assert.equal(analyzeScript(script).some((item) => item.code === 'unreachable-scene'), false);
  await assert.rejects(resolveProjectScript('include chapters/chapter01.tds as chapter\nscene main { wait 1 }', dir, new Set(), 'main.tds'), /module.*Scene/);
});

test('imported module declarations retain their source file provenance', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-location-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'child.tds'), 'global int shared = 1');
  const script = await resolveProjectScript('include child.tds as shared\nscene start { wait 1 }', dir);
  assert.equal(script.globals.find((item) => item.name === 'shared').file, 'child.tds');
  assert.equal(analyzeScript(script).some((item) => item.file === 'child.tds'), false);
});

test('runtime state APIs remain unqualified inside imported TDS modules', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-runtime-state-module-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'probe.tds'), `
fn has_character(id: str) -> bool { return runtime.state.characters.exists(id) }
fn characters() -> list[str] { return runtime.state.characters.list() }
`);
  const script = await resolveProjectScript(`include probe.tds as probe
character ayase {
  name = "Ayase"
  pose normal = "asset/ayase.png"
}
global bool visible = false
global list[str] visible_ids = []
scene main {
  show ayase.normal left
  set visible = probe.has_character("ayase")
  set visible_ids = probe.characters()
}`, dir, new Set(), 'main.tds');
  const runtime = new Runtime({ command: async () => {}, choice: async () => 0 });
  await runtime.run(compile(script));
  assert.equal(runtime.get('visible'), true);
  assert.deepEqual(runtime.get('visible_ids'), ['ayase']);
  assert.equal(script.functions.find(fn => fn.name === 'probe.has_character').body[0].value.name,
    'runtime.state.characters.exists');
});

test('included functions receive static variable domains for timed-command validation', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-module-duration-domain-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'timing.tds'), 'fn animate() -> none { wait duration }\nfn animate_parameter(value: int) -> none { wait value }');
  const script = await resolveProjectScript('include timing.tds as timing\nscene main { timing.animate() }', dir, new Set(), 'main.tds');
  const globals = new Map([['duration', 'int']]);
  globals.constraints = new Map([['duration', { type: 'int', min: -10n, max: -1n }]]);
  const diagnostics = analyzeScript(script, 'main.tds', globals);
  const error = diagnostics.find((item) => item.code === 'duration-range');
  assert.ok(error);
  assert.equal(error.severity, 'error');
  assert.equal(error.file, 'timing.tds');
  assert.throws(() => compile(script, globals), /演出時間の値域がすべて/);
});

test('aliased include call arguments receive static variable domains', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-module-parameter-domain-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'timing.tds'), 'fn animate(value: int) -> none { wait value }');
  const script = await resolveProjectScript('include timing.tds as timing\nscene main { timing.animate(duration) }', dir, new Set(), 'main.tds');
  const globals = new Map([['duration', 'int']]);
  globals.constraints = new Map([['duration', { type: 'int', min: -10n, max: -1n }]]);
  const diagnostic = analyzeScript(script, 'main.tds', globals).find(item => item.code === 'duration-range' && item.severity === 'error');
  assert.ok(diagnostic);
  assert.equal(diagnostic.file, 'timing.tds');
  assert.throws(() => compile(script, globals), /演出時間/);
});

test('aliased include analysis composes float move bounds and finite integer dispatch through expressions', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-module-composed-domains-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'motion.tds'), `
fn shift(amount: float) -> none { move bg by x+(amount) }
fn dispatch(route: int) -> none {
  if route == 0 { wait 1 } elif route == 4 { wait 1 }
}`);
  const script = await resolveProjectScript(`include motion.tds as motion
scene main {
  motion.shift(float(offset))
  motion.dispatch(route * 2)
}`, dir, new Set(), 'main.tds');
  const globals = new Map([['offset', 'int'], ['route', 'int']]);
  globals.constraints = new Map([
    ['offset', { type: 'int', min: 1000001n, max: 1000002n }],
    ['route', { type: 'int', min: 0n, max: 2n, values: new Set([0n, 2n]) }],
  ]);
  const diagnostics = analyzeScript(script, 'main.tds', globals);
  const offset = diagnostics.find(item => item.code === 'presentation-offset-range' && item.severity === 'error');
  assert.ok(offset, 'the imported move helper must receive the converted offset interval');
  assert.equal(offset.file, 'motion.tds');
  assert.equal(diagnostics.some(item => item.code === 'non-exhaustive-condition'), false,
    'the imported dispatcher must retain finite values transformed at its aliased callsite');
  assert.throws(() => compile(script, globals), /±1000000 px/);
});

test('aliased include side effects invalidate the imported function global writes', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-module-effect-domain-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'mutate.tds'), 'fn set_low() -> none { set ratio = 0.25 }\nfn bump_counter() -> none { set counter = counter + 1 }');
  const script = await resolveProjectScript(`include mutate.tds as module
scene main {
  if ratio == 0.25 {
    module.set_low()
    if ratio == 0.25 { wait 1 }
  }
}`, dir, new Set(), 'main.tds');
  const globals = new Map([['ratio', 'float'], ['counter', 'int']]);
  globals.constraints = new Map([
    ['ratio', { type: 'float', floatMin: 0.25, floatMax: 0.5, floatValues: new Set([0.25, 0.5]) }],
    ['counter', { type: 'int', min: 0n, max: 10n }],
  ]);
  const diagnostics = analyzeScript(script, 'main.tds', globals);
  assert.equal(diagnostics.some(item => item.code === 'constant-condition' && item.line === 5), false);
  const compiled = compile(script, globals);
  const outer = compiled.scenes[0].instructions[0];
  assert.equal(outer.op, 'if');
  assert.equal(outer.body.find(instruction => instruction.op === 'if')?.condition.left.kind, 'load');

  const unrelatedWrite = await resolveProjectScript(`include mutate.tds as module
scene main {
  module.bump_counter()
  if ratio > 1.0 { wait 1 }
}`, dir, new Set(), 'main.tds');
  const withCounter = new Map([['ratio', 'float'], ['counter', 'int']]);
  withCounter.constraints = new Map([
    ['ratio', { type: 'float', floatMin: 0.25, floatMax: 0.5, floatValues: new Set([0.25, 0.5]) }],
    ['counter', { type: 'int', min: 0n, max: 10n }],
  ]);
  const unrelatedDiagnostics = analyzeScript(unrelatedWrite, 'main.tds', withCounter);
  assert.ok(unrelatedDiagnostics.some(item => item.code === 'constant-condition' && item.severity === 'warning'), 'an imported write to counter must preserve ratio facts');
});

test('aliased modules namespace imported functions, nested imports and interpolations end to end', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-module-runtime-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'math.tds'), 'include inner.tds as inner\nfn twice(x: int) -> int { return inner.add(inner.add(x, 1), 1) }\nfn label() -> str { return "ready" }');
  await fs.writeFile(path.join(dir, 'inner.tds'), 'fn add(x: int, y: int) -> int { return x + y }');
  const source = 'include math.tds as nt\nint answer = nt.twice(20)\nscene main { set answer = nt.twice(answer)\nsay narrator "{nt.label()}: {answer}" }';
  const assetsRoot = path.join(dir, 'assets');
  await fs.mkdir(assetsRoot);
  await fs.writeFile(path.join(dir, 'main.tds'), source);
  const script = await resolveProjectScript(source, dir, new Set(), 'main.tds');
  assert.deepEqual(script.functions.map((fn) => fn.name).sort(), ['nt.inner.add', 'nt.label', 'nt.twice']);
  const packed = await pack(path.join(dir, 'main.tds'), path.join(dir, 'module-test.nsp.json'), { scenesRoot: dir, assetsRoot });
  const runtime = new Runtime({ command: async (name, args, rt) => { if (name === 'say') runtime.lastLine = await rt.textAsync(args[1]); } });
  await runtime.run(packed.program);
  assert.equal(runtime.get('answer'), 24n);
  assert.equal(runtime.lastLine, 'ready: 24');
  if (process.env.NOVEL_NATIVE_EXE) {
    const file = path.join(dir, 'module-test.nsp.json');
    const child = spawnSync(process.env.NOVEL_NATIVE_EXE, [file, '--headless'], { encoding: 'utf8', timeout: 10000 });
    assert.equal(child.status, 0, child.stderr || child.error?.message);
    assert.equal(JSON.parse(child.stdout).globals.answer, Number(runtime.get('answer')));
  }
});

test('included BGM transition inside a selected branch coexists with a blocking timed effect', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-scene-state-include-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const assetsRoot = path.join(dir, 'assets');
  await fs.mkdir(assetsRoot, { recursive: true });
  await fs.writeFile(path.join(assetsRoot, 'first.ogg'), Buffer.from([0]));
  await fs.writeFile(path.join(assetsRoot, 'second.ogg'), Buffer.from([0]));
  await fs.writeFile(path.join(assetsRoot, 'broken.ogg'), Buffer.from([0]));
  await fs.writeFile(path.join(dir, 'audio.tds'), 'fn duration() -> int { return 100 }');
  const source = `asset bgm first = "asset/first.ogg"
asset bgm second = "asset/second.ogg"
asset bgm broken = "asset/broken.ogg"
include audio.tds as audio
scene main {
  bgm first
  choice "music" {
    "play" { play bgm first\nplay bgm second crossfade audio.duration()\neffect fade black 40 }
    "fail" { play bgm broken crossfade audio.duration() }
  }
}`;
  await fs.writeFile(path.join(dir, 'main.tds'), source);
  const packed = await pack(path.join(dir, 'main.tds'), path.join(dir, 'test.nsp.json'), { scenesRoot: dir, assetsRoot });
  const operations = [];
  const runtime = new Runtime({ command: async (name, args, rt, operation) => operations.push({ name, args, operation, state: rt.sceneState }), choice: async () => 0 });
  await runtime.run(packed.program);
  const music = operations.find(item => item.name === 'play' && item.args[1] === 'second');
  assert.deepEqual(music.operation.transition, { type: 'crossfade', durationMs: 100 });
  assert.equal(music.operation.blocking, undefined, 'BGM crossfade remains non-blocking');
  assert.equal(runtime.sceneState.logicalTimeMs, 40, 'only the blocking effect advances scenario time');
  assert.equal(runtime.sceneState.audio.bgm.asset, 'second');
  assert.equal(runtime.sceneState.audio.bgm.transition.progress, 0,
    'a concurrent blocking visual effect must not advance the audio-clocked BGM fade by script time');
  assert.equal(Object.values(runtime.sceneState.actions).find(action => action.kind === 'effect').status, 'complete');

  let failureRuntime;
  failureRuntime = new Runtime({ command: async (name, args) => {
    if (name === 'play' && args[0] === 'bgm' && args[1] === 'broken') throw Error('crossfade decode failed');
  }, choice: async () => 1 });
  await assert.rejects(failureRuntime.run(packed.program), /crossfade decode failed/);
  assert.equal(failureRuntime.sceneState.audio.bgm.asset, 'first');
  assert.deepEqual(Object.values(failureRuntime.sceneState.actions).map(({ asset, status, reason }) => [asset, status, reason]), [
    ['first', 'running', undefined], ['broken', 'stopped', 'failed'],
  ], 'a failed crossfade through an imported function and selected branch retains the prior BGM action');
});

test('imported function type errors retain caller source locations', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-module-type-error-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'numbers.tds'), 'fn increment(value: int) -> int { return value + 1 }\nfn broken() -> int { return "wrong" }');
  const script = await resolveProjectScript('include numbers.tds as numbers\nscene main { say narrator str(numbers.increment("wrong")) }', dir, new Set(), 'main.tds');
  const diagnostics = analyzeScript(script, 'main.tds');
  const error = diagnostics.find((item) => item.severity === 'error');
  assert.ok(error);
  assert.equal(error.file, 'main.tds');
  assert.equal(error.line, 2);
  const importedError = diagnostics.find((item) => item.severity === 'error' && item.file === 'numbers.tds');
  assert.ok(importedError);
  assert.equal(importedError.line, 2);
});

test('module imports reject executable top-level commands and duplicate module paths', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-module-contract-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'commands.tds'), 'wait 1');
  await fs.writeFile(path.join(dir, 'declarations.tds'), 'fn value() -> int { return 1 }');
  await assert.rejects(resolveProjectScript('include commands.tds as commands\nscene main { wait 1 }', dir, new Set(), 'main.tds'), /\u5ba3\u8a00\u3060\u3051\u3092\u8a18\u8ff0\u3067\u304d\u307e\u3059/);
  await assert.rejects(resolveProjectScript('include declarations.tds as first\ninclude declarations.tds as second\nscene main { wait 1 }', dir, new Set(), 'main.tds'), /重複してincludeされています/);
  if (process.platform === 'win32') {
    await assert.rejects(resolveProjectScript('include declarations.tds as first\ninclude DECLARATIONS.tds as second\nscene main { wait 1 }', dir, new Set(), 'main.tds'), /重複してincludeされています/);
  }
});
test('package includes external scenes, validates assets and remains JSON serializable', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-regression-'));
  // Remove only this test-owned, resolved temporary directory.
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const scenesRoot = path.join(dir, 'scenes'), assetsRoot = path.join(dir, 'assets');
  await fs.mkdir(scenesRoot); await fs.mkdir(assetsRoot);
  await fs.writeFile(path.join(assetsRoot, 'hero.png'), 'placeholder');
  await fs.writeFile(path.join(scenesRoot, 'main.tds'), 'character hero {\nname = "Hero"\npose normal = "asset/hero.png"\n}\nint route = 7\ngoto "next.tds"');
  await fs.writeFile(path.join(scenesRoot, 'next.tds'), 'show hero.normal center\nsay narrator str(route)\nsay hero "Hello"\nint a = 9007199254740993');
  await fs.writeFile(path.join(scenesRoot, 'unused.tds'), 'say narrator "compiled even when unreachable"');
  const data = await pack(path.join(scenesRoot, 'main.tds'), path.join(dir, 'out/game.json'), { scenesRoot, assetsRoot });
  assert.ok(data.files['unused.tds']);
  assert.equal(data.files['next.tds'].characters.find((character) => character.name === 'hero').poses[0].path, 'asset/hero.png');
  assert.equal(data.files['next.tds'].globals.find((entry) => entry.name === 'hero')?.initial.entries[0].value.value, 'Hero');
  const directRuntime = new Runtime({ command: async () => {} });
  directRuntime.globals.route = 7n;
  await directRuntime.run(data.files['next.tds']);
  assert.equal(directRuntime.get('hero').name, 'Hero', 'direct file playback initializes an external character definition');
  assert.equal(data.files['next.tds'].globals.find((entry) => entry.name === 'a').initial.value, '9007199254740993');
  assert.equal(data.files['next.tds'].globals.find((entry) => entry.name === 'say').args[1].name, 'str');
  await assert.rejects(compileProject('asset bg x = "missing.png"', assetsRoot, scenesRoot), /asset/);
  await fs.writeFile(path.join(scenesRoot, 'broken-main.tds'), 'str text = str(later)\ngoto "broken-next.tds"');
  await fs.writeFile(path.join(scenesRoot, 'broken-next.tds'), 'global int later = 1');
  await assert.rejects(pack(path.join(scenesRoot, 'broken-main.tds'), path.join(dir, 'out/broken.json'), { scenesRoot, assetsRoot }), /初期化前.*later/);
  await fs.writeFile(path.join(scenesRoot, 'duplicate.tds'), 'global int route = 9');
  await assert.rejects(pack(path.join(scenesRoot, 'main.tds'), path.join(dir, 'out/duplicate.json'), { scenesRoot, assetsRoot }), /route.*既に宣言.*set/);
});

test('pack refuses output paths that would replace scenario sources or referenced assets', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-pack-source-collision-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const scenesRoot = path.join(dir, 'scenes'), assetsRoot = path.join(dir, 'assets');
  await fs.mkdir(scenesRoot); await fs.mkdir(assetsRoot);
  const mainFile = path.join(scenesRoot, 'main.tds');
  const imageFile = path.join(assetsRoot, 'pixel.png');
  const source = 'asset image pixel = "asset/pixel.png"\nscene main { show image pixel center }';
  await fs.writeFile(mainFile, source);
  await fs.writeFile(imageFile, 'original image bytes');

  await assert.rejects(pack(mainFile, mainFile, { scenesRoot, assetsRoot }), /Package output cannot overwrite a source file\./);
  assert.equal(await fs.readFile(mainFile, 'utf8'), source);
  if (process.platform === 'win32') {
    await assert.rejects(pack(mainFile, path.join(scenesRoot, 'MAIN.TDS'), { scenesRoot, assetsRoot }), /Package output cannot overwrite a source file\./);
    assert.equal(await fs.readFile(mainFile, 'utf8'), source);
  }
  await assert.rejects(pack(mainFile, imageFile, { scenesRoot, assetsRoot }), /Package output cannot overwrite a source file\./);
  assert.equal(await fs.readFile(imageFile, 'utf8'), 'original image bytes');
});

test('project packaging resolves Windows separators in include and goto paths', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-windows-path-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const scenesRoot = path.join(dir, 'scenes'), assetsRoot = path.join(dir, 'assets');
  await fs.mkdir(path.join(scenesRoot, 'first'), { recursive: true }); await fs.mkdir(assetsRoot);
  await fs.writeFile(path.join(scenesRoot, 'main.tds'), 'include "first\\\\common.tds" as common\ngoto "first\\\\next.tds"');
  await fs.writeFile(path.join(scenesRoot, 'first', 'common.tds'), 'global int shared = 1');
  await fs.writeFile(path.join(scenesRoot, 'first', 'next.tds'), 'wait 1');
  const data = await pack(path.join(scenesRoot, 'main.tds'), path.join(dir, 'out/game.json'), { scenesRoot, assetsRoot });
  assert.ok(data.files['first/common.tds']);
  assert.ok(data.files['first/next.tds']);
  assert.equal(data.program.globals.find((entry) => entry.op === 'goto').scene, 'first/next.tds');
});
test('JSON static variables are typed globals with exact integer values', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-static-variables-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const scenesRoot = path.join(dir, 'scenes'), assetsRoot = path.join(dir, 'assets'), dataRoot = path.join(dir, '.novel');
  await fs.mkdir(scenesRoot); await fs.mkdir(assetsRoot); await fs.mkdir(dataRoot);
  await fs.writeFile(path.join(dataRoot, 'variables.json'), JSON.stringify({
    staticVariables: [
      { name: 'clear_threshold', type: 'int', value: '9007199254740993', constant: true },
      { name: 'route_name', type: 'str', value: 'common', constant: true },
      { name: 'difficulty', type: 'int', value: 2, min: 1, max: 3, possibleValues: [1, 2, 3] },
      { name: 'ending', type: 'str', value: 'common', possibleValues: ['common', 'true_end'] },
    ],
  }));
  await fs.writeFile(path.join(scenesRoot, 'main.tds'), 'int result = clear_threshold + 1\nstr route = route_name\nset difficulty = difficulty\nset ending = ending');
  const data = await pack(path.join(scenesRoot, 'main.tds'), path.join(dir, 'out/game.json'), { scenesRoot, assetsRoot, dataRoot });
  assert.equal(data.program.globals.find((entry) => entry.name === 'clear_threshold').initial.value, '9007199254740993');
  assert.equal(data.program.globals.find((entry) => entry.name === 'result').initial.value, '9007199254740994');
  assert.equal(data.program.globals.find((entry) => entry.name === 'route').initial.value, 'common');
  const runtime = new Runtime({ command: async () => {}, choice: async () => 0 });
  await runtime.run(data.program);
  assert.equal(runtime.get('result'), 9007199254740994n);
  assert.equal(runtime.get('route'), 'common');
  assert.equal(runtime.get('difficulty'), 2n);
  assert.equal(runtime.get('ending'), 'common');
  const constrainedGlobals = new Map([['difficulty', 'int']]);
  constrainedGlobals.constraints = new Map([
    ['difficulty', { type: 'int', min: 1n, max: 3n }],
    ['ending', { type: 'str', values: new Set(['common', 'true_end']) }],
  ]);
  const constrainedDiagnostics = analyzeScript(parse('if difficulty > 5 { wait 1 }\nif difficulty >= 1 { wait 1 }'), 'constraints.tds', constrainedGlobals);
  assert.equal(constrainedDiagnostics.filter((item) => item.code === 'constant-condition').length, 2);
  assert.equal(constrainedDiagnostics.find((item) => item.code === 'constant-condition' && item.severity === 'warning')?.line, 1);
  assert.equal(constrainedDiagnostics.find((item) => item.code === 'constant-condition' && item.severity === 'info')?.line, 2);
  const contradictoryCompound = analyzeScript(parse('if difficulty < 2 and difficulty >= 2 { wait 1 }'), 'constraint-compound-false.tds', constrainedGlobals);
  assert.ok(contradictoryCompound.some((item) => item.code === 'constant-condition' && item.severity === 'warning'));
  const exhaustiveCompound = analyzeScript(parse('if difficulty < 2 or difficulty >= 2 { wait 1 }'), 'constraint-compound-true.tds', constrainedGlobals);
  assert.ok(exhaustiveCompound.some((item) => item.code === 'constant-condition' && item.severity === 'info'));
  const exhaustiveStringCompound = analyzeScript(parse('if ending == "common" or ending == "true_end" { wait 1 }'), 'constraint-string-compound-true.tds', constrainedGlobals);
  assert.ok(exhaustiveStringCompound.some((item) => item.code === 'constant-condition' && item.severity === 'info'));
  const compoundFacts = analyzeScript(parse('if difficulty < 2 and difficulty >= 1 { if difficulty < 2 { wait 1 } }'), 'constraint-compound-facts.tds', constrainedGlobals);
  assert.ok(compoundFacts.some((item) => item.code === 'constant-condition' && item.severity === 'info' && item.line === 1));
  const branchLocalConstraints = analyzeScript(parse('if difficulty < 2 { if difficulty >= 2 { wait 1 } } else { if difficulty < 2 { wait 1 } }'), 'constraint-branch-local.tds', constrainedGlobals);
  assert.equal(branchLocalConstraints.filter((item) => item.code === 'constant-condition' && item.severity === 'warning').length, 2);
  constrainedGlobals.set('flag', 'int');
  const siblingBranchConstants = analyzeScript(parse('if flag == 1 { set difficulty = 1\n}\nelif difficulty == 2 { wait 1 }'), 'constraint-sibling-branch-constants.tds', constrainedGlobals);
  assert.equal(siblingBranchConstants.some((item) => item.code === 'constant-condition' && item.line === 3), false);
  const siblingChoiceConstants = analyzeScript(parse('choice { "change" { set difficulty = 1 } "inspect" { if difficulty == 2 { wait 1 } } }'), 'constraint-sibling-choice-constants.tds', constrainedGlobals);
  assert.equal(siblingChoiceConstants.some((item) => item.code === 'constant-condition'), false);
  const postLoopConstraints = analyzeScript(parse('while difficulty < 2 {\nif difficulty < 2 { wait 1 }\n}\nif difficulty < 2 { wait 2 }'), 'constraint-post-loop-body-facts.tds', constrainedGlobals);
  assert.equal(postLoopConstraints.some((item) => item.code === 'constant-condition' && item.line === 4), false);
  const constrainedTermination = analyzeScript(parse('if difficulty < 2 or difficulty >= 2 { goto "done.tds" }\nwait 1'), 'constraint-termination.tds', constrainedGlobals);
  assert.ok(constrainedTermination.some((item) => item.code === 'unreachable-code' && item.line === 2));
  const pureFunctionFacts = analyzeScript(parse('fn noop() -> none { }\nif difficulty < 2 { noop()\nif difficulty < 2 { wait 1 } }'), 'constraint-pure-function.tds', constrainedGlobals);
  assert.ok(pureFunctionFacts.some((item) => item.code === 'constant-condition' && item.severity === 'info' && item.line === 3));
  const mutatingFunctionFacts = analyzeScript(parse('fn bump() -> none { set difficulty = difficulty + 1 }\nif difficulty < 2 { bump()\nif difficulty < 2 { wait 1 } }'), 'constraint-mutating-function.tds', constrainedGlobals);
  assert.equal(mutatingFunctionFacts.some((item) => item.code === 'constant-condition' && item.line === 3), false);
  const indirectMutatingFunctionFacts = analyzeScript(parse('fn inner_bump() -> none { set difficulty = difficulty + 1 }\nfn outer_bump() -> none { inner_bump() }\nif difficulty < 2 { outer_bump()\nif difficulty < 2 { wait 1 } }'), 'constraint-indirect-function.tds', constrainedGlobals);
  assert.equal(indirectMutatingFunctionFacts.some((item) => item.code === 'constant-condition' && item.line === 4), false);
  const conditionMutatingFunctionFacts = analyzeScript(parse('fn mutate() -> int { set difficulty = difficulty + 1\nreturn 1 }\nif mutate() == 1 { if difficulty < 2 { wait 1 } }'), 'constraint-condition-function.tds', constrainedGlobals);
  assert.equal(conditionMutatingFunctionFacts.some((item) => item.code === 'constant-condition'), false);
  const shortCircuitConditionFacts = analyzeScript(parse('fn mutate() -> int { set difficulty = difficulty + 1\nreturn 1 }\nif difficulty > 5 and mutate() == 1 { wait 1 }\nif difficulty < 2 { wait 1 }'), 'constraint-short-circuit-condition.tds', constrainedGlobals);
  assert.equal(shortCircuitConditionFacts.some((item) => item.code === 'constant-condition' && item.line === 4), false);
  const executedShortCircuitFacts = analyzeScript(parse('fn mutate() -> int { set difficulty = difficulty + 1\nreturn 1 }\nif difficulty < 2 or mutate() == 1 { wait 1 }\nif difficulty < 2 { wait 1 }'), 'constraint-executed-short-circuit-condition.tds', constrainedGlobals);
  assert.equal(executedShortCircuitFacts.some((item) => item.code === 'constant-condition' && item.line === 4), false);
  const constrainedReachability = sceneReachability(parse('scene start { if difficulty > 5 { goto hidden } else { wait 1 } }\nscene hidden { wait 1 }'), constrainedGlobals.constraints);
  assert.equal(constrainedReachability.reachableScenes.has('hidden'), false);
  const constrainedPathReachability = sceneReachability(parse('scene start { if difficulty >= 2 { goto selected } else { wait 1 } }\nscene selected { wait 1 }'), constrainedGlobals.constraints);
  assert.equal(constrainedPathReachability.reachableScenes.has('selected'), true, 'a feasible constrained branch must make its target reachable');
  const constrainedElseReachability = sceneReachability(parse('scene start { if difficulty > 5 { goto impossible } else { goto fallback } }\nscene impossible { wait 1 }\nscene fallback { wait 1 }'), constrainedGlobals.constraints);
  assert.equal(constrainedElseReachability.reachableScenes.has('impossible'), false);
  assert.equal(constrainedElseReachability.reachableScenes.has('fallback'), true, 'the feasible else branch must be explored');
  constrainedGlobals.set('loop_limit', 'int');
  constrainedGlobals.constraints.set('loop_limit', { type: 'int', min: 0n, max: 200000n });
  const loopDiagnostics = analyzeScript(parse('for i from 0 to loop_limit { wait 1 }'), 'constraint-loop.tds', constrainedGlobals);
  assert.ok(loopDiagnostics.some((item) => item.code === 'loop-limit'));
  constrainedGlobals.set('loop_step', 'int');
  constrainedGlobals.constraints.set('loop_step', { type: 'int', values: new Set([1n, 2n]) });
  const constrainedStepLoop = analyzeScript(parse('for i from 0 to 100000 step loop_step { wait 1 }'), 'constraint-loop-step.tds', constrainedGlobals);
  assert.ok(constrainedStepLoop.some((item) => item.code === 'loop-limit'));
  const loopVariableFacts = analyzeScript(parse('for i from difficulty to difficulty + 2 step 1 { if i < 0 { wait 1 } }'), 'constraint-loop-variable.tds', constrainedGlobals);
  assert.ok(loopVariableFacts.some((item) => item.code === 'constant-condition' && item.severity === 'warning'));
  constrainedGlobals.set('score', 'int');
  constrainedGlobals.constraints.set('score', { type: 'int', min: 9223372036854775807n, max: 9223372036854775807n });
  const constrainedOverflow = analyzeScript(parse('for i from 1 to 1 { set score = score + i }'), 'constraint-loop-overflow.tds', constrainedGlobals);
  assert.ok(constrainedOverflow.some((item) => item.code === 'integer-overflow' && item.severity === 'error'));
  constrainedGlobals.set('score2', 'int');
  constrainedGlobals.constraints.set('score2', { type: 'int', min: 9223372036854775806n, max: 9223372036854775806n });
  const repeatedConstrainedOverflow = analyzeScript(parse('for i from 0 to 1 { set score2 = score2 + 1 }'), 'constraint-loop-repeated-overflow.tds', constrainedGlobals);
  assert.ok(repeatedConstrainedOverflow.some((item) => item.code === 'integer-overflow' && item.severity === 'error'));
  constrainedGlobals.set('score3', 'int');
  constrainedGlobals.constraints.set('score3', { type: 'int', min: 9223372036854775806n, max: 9223372036854775807n });
  const possibleConstrainedOverflow = analyzeScript(parse('for i from 0 to 1 { set score3 = score3 + 1 }'), 'constraint-loop-possible-overflow.tds', constrainedGlobals);
  assert.ok(possibleConstrainedOverflow.some((item) => item.code === 'integer-overflow' && item.severity === 'warning'));
  assert.equal(possibleConstrainedOverflow.some((item) => item.code === 'integer-overflow' && item.severity === 'error'), false);
  const whileDiagnostics = analyzeScript(parse('while difficulty < 200001 { set difficulty = difficulty + 1 }'), 'constraint-while.tds', constrainedGlobals);
  assert.ok(whileDiagnostics.some((item) => item.code === 'loop-limit'));
  const stableWhileDiagnostics = analyzeScript(parse('while difficulty < 3 { wait 1 }'), 'constraint-stable-while.tds', constrainedGlobals);
  assert.ok(stableWhileDiagnostics.some((item) => item.code === 'loop-limit'));
  constrainedGlobals.set('always', 'int');
  constrainedGlobals.constraints.set('always', { type: 'int', min: 1n, max: 1n });
  const postLoopDiagnostics = analyzeScript(parse('while always < 3 { wait 1 }\nwait 2'), 'constraint-post-loop.tds', constrainedGlobals);
  assert.ok(postLoopDiagnostics.some((item) => item.code === 'infinite-loop'));
  assert.ok(postLoopDiagnostics.some((item) => item.code === 'unreachable-code' && item.line === 2));
  const incompleteStringBranches = analyzeScript(parse('if ending == "common" { wait 1 }'), 'constraint-string.tds', constrainedGlobals);
  assert.ok(incompleteStringBranches.some((item) => item.code === 'non-exhaustive-condition'));
  const completeStringBranches = analyzeScript(parse('if ending == "common" { wait 1 } elif ending == "true_end" { wait 1 }'), 'constraint-string-complete.tds', constrainedGlobals);
  assert.equal(completeStringBranches.some((item) => item.code === 'non-exhaustive-condition'), false);
  constrainedGlobals.constraints.set('difficulty', { type: 'int', values: new Set([1n, 2n, 3n]) });
  const incompleteIntegerBranches = analyzeScript(parse('if difficulty == 1 { wait 1 } elif difficulty == 2 { wait 1 }'), 'constraint-int.tds', constrainedGlobals);
  assert.ok(incompleteIntegerBranches.some((item) => item.code === 'non-exhaustive-condition'));
  const completeIntegerBranches = analyzeScript(parse('if difficulty == 1 { wait 1 } elif difficulty == 2 { wait 1 } elif difficulty == 3 { wait 1 }'), 'constraint-int-complete.tds', constrainedGlobals);
  assert.equal(completeIntegerBranches.some((item) => item.code === 'non-exhaustive-condition'), false);
  constrainedGlobals.constraints.set('difficulty', { type: 'int', min: 1n, max: 3n });
  const incompleteThresholdBranches = analyzeScript(parse('if difficulty < 2 { wait 1 }'), 'constraint-int-range.tds', constrainedGlobals);
  assert.ok(incompleteThresholdBranches.some((item) => item.code === 'non-exhaustive-condition'));
  const completeThresholdBranches = analyzeScript(parse('if difficulty < 2 { wait 1 } elif difficulty >= 2 { wait 1 }'), 'constraint-int-range-complete.tds', constrainedGlobals);
  assert.equal(completeThresholdBranches.some((item) => item.code === 'non-exhaustive-condition'), false);
  const exhaustiveThresholdElse = analyzeScript(parse('if difficulty < 2 { wait 1 } elif difficulty >= 2 { wait 1 } else { wait 2 }'), 'constraint-int-range-else.tds', constrainedGlobals);
  assert.ok(exhaustiveThresholdElse.some((item) => item.code === 'unreachable-branch'));
  const assignmentResetsThreshold = analyzeScript(parse('if difficulty < 2 { set difficulty = difficulty + 1\nif difficulty < 2 { wait 1 } }'), 'constraint-int-range-assignment.tds', constrainedGlobals);
  assert.ok(assignmentResetsThreshold.some((item) => item.code === 'constant-condition' && item.line === 2 && item.severity === 'warning'), 'the branch narrows difficulty to 1, so the assignment proves it is 2 afterward');
  const mayEscapeDiagnostics = analyzeScript(parse('set difficulty = difficulty + 1'), 'constraint-assignment.tds', constrainedGlobals);
  assert.equal(mayEscapeDiagnostics.find((item) => item.code === 'variable-constraint' && item.severity === 'warning')?.variable, 'difficulty');
  const outsideDiagnostics = analyzeScript(parse('set difficulty = difficulty + 10'), 'constraint-assignment-outside.tds', constrainedGlobals);
  assert.equal(outsideDiagnostics.find((item) => item.code === 'variable-constraint' && item.severity === 'error')?.variable, 'difficulty');
  const duplicateChoiceDiagnostics = analyzeScript(parse('choice { "same" { wait 1 } "same" { wait 1 } }'), 'duplicate-choice.tds', constrainedGlobals);
  assert.ok(duplicateChoiceDiagnostics.some((item) => item.code === 'duplicate-choice-label'));
  await fs.writeFile(path.join(scenesRoot, 'main.tds'), 'if difficulty > 5 { wait 1 } else { wait 2 }');
  const constrainedProgram = await pack(path.join(scenesRoot, 'main.tds'), path.join(dir, 'out/constraint-branch.json'), { scenesRoot, assetsRoot, dataRoot });
  assert.equal(constrainedProgram.program.globals.some((entry) => entry.op === 'if'), false);
  await fs.writeFile(path.join(scenesRoot, 'main.tds'), 'if difficulty < 2 { wait 1 } elif difficulty >= 2 { wait 2 } else { wait 3 }');
  const thresholdProgram = await pack(path.join(scenesRoot, 'main.tds'), path.join(dir, 'out/constraint-threshold-branch.json'), { scenesRoot, assetsRoot, dataRoot });
  const thresholdIf = thresholdProgram.program.globals.find((entry) => entry.op === 'if');
  assert.ok(thresholdIf);
  assert.equal(thresholdIf.otherwise.length, 0);
  await fs.writeFile(path.join(scenesRoot, 'main.tds'), 'if difficulty < 2 { if difficulty >= 2 { wait 1 } else { wait 2 } } else { wait 3 }');
  const nestedConstraintProgram = await pack(path.join(scenesRoot, 'main.tds'), path.join(dir, 'out/constraint-nested.json'), { scenesRoot, assetsRoot, dataRoot });
  const nestedConstraintIf = nestedConstraintProgram.program.globals.find((entry) => entry.op === 'if');
  assert.ok(nestedConstraintIf);
  assert.equal(nestedConstraintIf.body.some((entry) => entry.op === 'if'), false);
  await fs.writeFile(path.join(scenesRoot, 'main.tds'), 'while difficulty < 2 { if difficulty >= 2 { wait 1 } else { wait 2 }\nset difficulty = difficulty + 1 }');
  const loopConstraintProgram = await pack(path.join(scenesRoot, 'main.tds'), path.join(dir, 'out/constraint-loop.json'), { scenesRoot, assetsRoot, dataRoot });
  const loopConstraint = loopConstraintProgram.program.globals.find((entry) => entry.op === 'while');
  assert.ok(loopConstraint);
  assert.equal(loopConstraint.body.some((entry) => entry.op === 'if'), false);
  await fs.writeFile(path.join(scenesRoot, 'main.tds'), 'for i from 0 to 2 step 1 { if i < 0 { wait 1 } else { wait 2 } }');
  const forConstraintProgram = await pack(path.join(scenesRoot, 'main.tds'), path.join(dir, 'out/constraint-for.json'), { scenesRoot, assetsRoot, dataRoot });
  const forConstraint = forConstraintProgram.program.globals.find((entry) => entry.op === 'for');
  assert.ok(forConstraint);
  assert.equal(forConstraint.body.some((entry) => entry.op === 'if'), false);
  await fs.writeFile(path.join(scenesRoot, 'main.tds'), 'for i from difficulty to difficulty + 2 step 1 { if i < 0 { wait 1 } else { wait 2 } }');
  const dynamicForConstraintProgram = await pack(path.join(scenesRoot, 'main.tds'), path.join(dir, 'out/constraint-dynamic-for.json'), { scenesRoot, assetsRoot, dataRoot });
  const dynamicForConstraint = dynamicForConstraintProgram.program.globals.find((entry) => entry.op === 'for');
  assert.ok(dynamicForConstraint);
  assert.equal(dynamicForConstraint.body.some((entry) => entry.op === 'if'), false);
  await fs.writeFile(path.join(scenesRoot, 'main.tds'), 'fn noop() -> none { }\nif difficulty < 2 { noop()\nif difficulty >= 2 { wait 1 } else { wait 2 } } else { wait 3 }');
  const pureNestedProgram = await pack(path.join(scenesRoot, 'main.tds'), path.join(dir, 'out/constraint-pure-nested.json'), { scenesRoot, assetsRoot, dataRoot });
  const pureNestedIf = pureNestedProgram.program.globals.find((entry) => entry.op === 'if');
  assert.ok(pureNestedIf);
  assert.equal(pureNestedIf.body.some((entry) => entry.op === 'if'), false);
  await fs.writeFile(path.join(scenesRoot, 'main.tds'), 'fn bump() -> none { set difficulty = difficulty + 1 }\nif difficulty < 2 { bump()\nif difficulty >= 2 { wait 1 } else { wait 2 } } else { wait 3 }');
  const mutatingNestedProgram = await pack(path.join(scenesRoot, 'main.tds'), path.join(dir, 'out/constraint-mutating-nested.json'), { scenesRoot, assetsRoot, dataRoot });
  const mutatingNestedIf = mutatingNestedProgram.program.globals.find((entry) => entry.op === 'if');
  assert.ok(mutatingNestedIf);
  assert.ok(mutatingNestedIf.body.some((entry) => entry.op === 'if'));
  await fs.writeFile(path.join(scenesRoot, 'main.tds'), 'fn mutate() -> int { set difficulty = difficulty + 1\nreturn 1 }\nif 1 == 2 and mutate() == 1 { wait 1 }\nif difficulty >= 1 { wait 2 }');
  const dormantShortCircuitProgram = await pack(path.join(scenesRoot, 'main.tds'), path.join(dir, 'out/constraint-dormant-short-circuit.json'), { scenesRoot, assetsRoot, dataRoot });
  assert.equal(dormantShortCircuitProgram.program.globals.filter((entry) => entry.op === 'if').some((entry) => JSON.stringify(entry.condition).includes('mutate')), false);
  await fs.writeFile(path.join(scenesRoot, 'main.tds'), 'fn mutate() -> int { set difficulty = difficulty + 1\nreturn 1 }\nif difficulty < 2 or mutate() == 1 { wait 1 }\nif difficulty >= 1 { wait 2 }');
  const executedShortCircuitProgram = await pack(path.join(scenesRoot, 'main.tds'), path.join(dir, 'out/constraint-executed-short-circuit.json'), { scenesRoot, assetsRoot, dataRoot });
  assert.equal(executedShortCircuitProgram.program.globals.filter((entry) => entry.op === 'if').length, 2);
  await fs.writeFile(path.join(scenesRoot, 'main.tds'), 'if difficulty < 2 and difficulty >= 2 { wait 1 } else { wait 2 }');
  const compoundProgram = await pack(path.join(scenesRoot, 'main.tds'), path.join(dir, 'out/constraint-compound.json'), { scenesRoot, assetsRoot, dataRoot });
  assert.equal(compoundProgram.program.globals.some((entry) => entry.op === 'if'), false);
  await fs.writeFile(path.join(scenesRoot, 'main.tds'), 'if ending == "common" or ending == "true_end" { wait 1 } else { wait 2 }');
  const stringCompoundProgram = await pack(path.join(scenesRoot, 'main.tds'), path.join(dir, 'out/constraint-string-compound.json'), { scenesRoot, assetsRoot, dataRoot });
  assert.equal(stringCompoundProgram.program.globals.some((entry) => entry.op === 'if'), false);
  await fs.writeFile(path.join(scenesRoot, 'main.tds'), 'if ending == "common" { wait 1 } else { wait 2 }');
  const mixedProgram = await pack(path.join(scenesRoot, 'main.tds'), path.join(dir, 'out/mixed-branch.json'), { scenesRoot, assetsRoot, dataRoot });
  assert.equal(mixedProgram.program.globals.some((entry) => entry.op === 'if'), true);
  await fs.writeFile(path.join(scenesRoot, 'main.tds'), 'if ending == "common" { wait 1 } else { wait 2 }\nif ending == "missing" { wait 3 } else { wait 4 }');
  const mergedStringProgram = await pack(path.join(scenesRoot, 'main.tds'), path.join(dir, 'out/constraint-merged-string.json'), { scenesRoot, assetsRoot, dataRoot });
  assert.equal(mergedStringProgram.program.globals.filter((entry) => entry.op === 'if').length, 1);
  await fs.writeFile(path.join(scenesRoot, 'main.tds'), 'set clear_threshold = 1');
  await assert.rejects(pack(path.join(scenesRoot, 'main.tds'), path.join(dir, 'out/broken.json'), { scenesRoot, assetsRoot, dataRoot }), /const/);
  await fs.writeFile(path.join(scenesRoot, 'main.tds'), 'set difficulty = 9');
  await assert.rejects(pack(path.join(scenesRoot, 'main.tds'), path.join(dir, 'out/range.json'), { scenesRoot, assetsRoot, dataRoot }), /変数 'difficulty'.*制約/);
  await fs.writeFile(path.join(scenesRoot, 'main.tds'), 'set ending = "bad"');
  await assert.rejects(pack(path.join(scenesRoot, 'main.tds'), path.join(dir, 'out/values.json'), { scenesRoot, assetsRoot, dataRoot }), /変数 'ending'.*制約/);
  await fs.writeFile(path.join(dataRoot, 'variables.json'), JSON.stringify({ staticVariables: [{ name: 'ending', type: 'str', value: 'common', possibleValues: ['common', 'common'] }] }));
  await assert.rejects(pack(path.join(scenesRoot, 'main.tds'), path.join(dir, 'out/duplicate-values.json'), { scenesRoot, assetsRoot, dataRoot }), /possibleValues/);
});
test('native and browser runtimes agree on functions, loops, choice and scene transitions', async t => {
  const exe = await nativeExecutableForTest(t);
  if (!exe) return;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-native-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'test.nsp.json');
  await fs.writeFile(file, JSON.stringify(nativePackage(program(scenario))));
  const child = spawnSync(exe, [file, '--headless'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 0, child.stderr || child.error?.message);
  const actual = JSON.parse(child.stdout);
  assert.equal(actual.globals.result, (await run(scenario)).get('result'));
  const numeric = program('int large = 9007199254740992 + 1\nstr result = str(large)\nstr minimum = str(-9223372036854775808)');
  await fs.writeFile(file, JSON.stringify(nativePackage(numeric)));
  const exact = spawnSync(exe, [file, '--headless'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(exact.status, 0, exact.stderr);
  assert.equal(JSON.parse(exact.stdout).globals.result, '9007199254740993');
  assert.equal(JSON.parse(exact.stdout).globals.minimum, '-9223372036854775808');
  await fs.writeFile(file, JSON.stringify(nativePackage(numeric, { version: 99 })));
  assert.equal(spawnSync(exe, [file, '--headless'], { timeout: 10000 }).status, 1);
});

test('native and browser preserve global writes from parallel command arguments after optimization', async t => {
  const exe = await nativeExecutableForTest(t);
  if (!exe) return;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-parallel-optimizer-parity-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'test.nsp.json');
  const source = `
global float zoom = 0.0
global int result = 0
fn mutate_zoom() -> float {
  set zoom = 2.0
  return 1.0
}
scene main {
  set zoom = 1.0
  parallel {
    camera zoom mutate_zoom() at 640 360 over 1
  }
  if zoom == 1.0 {
    set result = 1
  } else {
    set result = 2
  }
}
`;
  const outcomes = {};
  for (const debug of [false, true]) {
    const compiled = compile(parse(source), new Map(), new Map(), debug);
    const browser = new Runtime({ command: async () => {}, parallel: async () => {} });
    await browser.run(compiled);
    await fs.writeFile(file, JSON.stringify(nativePackage(compiled)));
    const child = spawnSync(exe, [file, '--headless'], { encoding: 'utf8', timeout: 10000 });
    assert.equal(child.status, 0, child.stderr || child.error?.message);
    const native = JSON.parse(child.stdout).globals;
    const outcome = {
      zoom: browser.get('zoom'),
      result: String(browser.get('result')),
    };
    assert.deepEqual(outcome, { zoom: native.zoom, result: String(native.result) }, `debug=${debug}`);
    outcomes[debug ? 'raw' : 'optimized'] = outcome;
  }
  assert.deepEqual(outcomes.optimized, outcomes.raw);
  assert.deepEqual(outcomes.optimized, { zoom: 2, result: '2' });
});

test('parallel command arguments use each child command source line in both runtimes and compiler modes', async t => {
  const exe = await nativeExecutableForTest(t);
  if (!exe) return;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-parallel-source-line-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'test.nsp.json');
  const source = `scene main {
  parallel {
    camera zoom float(runtime.state.execution.current_line()) at 0 0 over 0
    effect fade black runtime.state.execution.current_line()
  }
}`;
  const results = {};
  for (const debug of [false, true]) {
    const compiled = compile(parse(source), new Map(), new Map(), debug);
    const browserCommands = [];
    const browser = new Runtime({ command: async (name, args, _runtime, operation) => browserCommands.push({ name, args, operation }) });
    await browser.run(compiled);
    assert.deepEqual(browserCommands.map(command => Number(command.name === 'camera' ? command.args[1] : command.args[2])), [3, 4], `Browser command source lines, debug=${debug}`);
    assert.equal(browser.sceneState.camera.zoom, 3, `Browser camera source line, debug=${debug}`);
    assert.equal(browser.sceneState.effects[0].transition.durationMs, 4, `Browser effect source line, debug=${debug}`);

    await fs.writeFile(file, JSON.stringify(nativePackage(compiled)));
    const child = spawnSync(exe, [file, '--headless'], { encoding: 'utf8', timeout: 10000 });
    assert.equal(child.status, 0, child.stderr || child.error?.message);
    const commands = JSON.parse(child.stdout).commands;
    const sourceLines = commands.map(command => command.name === 'camera' ? command.args[1] : command.args[2]);
    assert.deepEqual(sourceLines, [3, 4], `Native command argument source lines, debug=${debug}`);
    results[debug ? 'raw' : 'optimized'] = sourceLines;
  }
  assert.deepEqual(results.raw, results.optimized);
  assert.deepEqual(results.optimized, [3, 4]);
});

test('native and browser preserve ordered choice interpolation effects after optimization', async t => {
  const exe = await nativeExecutableForTest(t);
  if (!exe) return;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-choice-optimizer-parity-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'test.nsp.json');
  const source = `
global str state = "initial"
global str prompt_seen = ""
global str selected = ""
fn first_label() -> str {
  set state = "first"
  return "first label"
}
fn second_label() -> str {
  set state = "second"
  return "second label"
}
fn choice_prompt() -> str {
  set prompt_seen = state
  return state
}
scene main {
  choice "{choice_prompt()}" {
    "{first_label()}" { set selected = state }
    "{second_label()}" { set selected = "wrong option" }
  }
}
`;
  const outcomes = {};
  for (const debug of [false, true]) {
    const compiled = compile(parse(source), new Map(), new Map(), debug);
    let browserChoice;
    const browser = new Runtime({ choice: async (prompt, labels) => { browserChoice = { prompt, labels }; return 0; } });
    await browser.run(compiled);
    await fs.writeFile(file, JSON.stringify(nativePackage(compiled)));
    const child = spawnSync(exe, [file, '--headless'], { encoding: 'utf8', timeout: 10000 });
    assert.equal(child.status, 0, child.stderr || child.error?.message);
    const native = JSON.parse(child.stdout).globals;
    const outcome = {
      browserChoice,
      state: browser.get('state'),
      prompt_seen: browser.get('prompt_seen'),
      selected: browser.get('selected'),
    };
    assert.deepEqual(outcome, {
      browserChoice: { prompt: 'second', labels: ['first label', 'second label'] },
      state: native.state,
      prompt_seen: native.prompt_seen,
      selected: native.selected,
    }, `Browser/Native mismatch, debug=${debug}`);
    outcomes[debug ? 'raw' : 'optimized'] = outcome;
  }
  assert.deepEqual(outcomes.optimized, outcomes.raw);
  assert.deepEqual(outcomes.optimized, {
    browserChoice: { prompt: 'second', labels: ['first label', 'second label'] },
    state: 'second', prompt_seen: 'second', selected: 'second',
  });
});

test('native and browser preserve ordered for-bound effects after optimization', async t => {
  const exe = await nativeExecutableForTest(t);
  if (!exe) return;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-for-bound-effects-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'test.nsp.json');
  const source = `
global int phase = 0
global int result = 0
fn start_bound() -> int {
  set phase = phase + 1
  return phase
}
fn stop_bound() -> int {
  set phase = phase + 2
  return phase
}
fn step_bound() -> int {
  set phase = phase + 1
  return 2
}
scene main {
  for i from start_bound() to stop_bound() step step_bound() {
    set result = result + i
  }
}
`;
  const outcomes = {};
  for (const debug of [false, true]) {
    const compiled = compile(parse(source), new Map(), new Map(), debug);
    const browser = new Runtime();
    await browser.run(compiled);
    await fs.writeFile(file, JSON.stringify(nativePackage(compiled)));
    const child = spawnSync(exe, [file, '--headless'], { encoding: 'utf8', timeout: 10000 });
    assert.equal(child.status, 0, child.stderr || child.error?.message);
    const native = JSON.parse(child.stdout).globals;
    const outcome = { phase: String(browser.get('phase')), result: String(browser.get('result')) };
    assert.deepEqual(outcome, { phase: String(native.phase), result: String(native.result) }, `Browser/Native mismatch, debug=${debug}`);
    outcomes[debug ? 'raw' : 'optimized'] = outcome;
  }
  assert.deepEqual(outcomes.optimized, outcomes.raw);
  assert.deepEqual(outcomes.optimized, { phase: '4', result: '4' });
});

test('native and browser preserve side effects from an unset key expression after optimization', async t => {
  const exe = await nativeExecutableForTest(t);
  if (!exe) return;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-unset-key-effects-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'test.nsp.json');
  const source = `
global dict[int] values = {"obsolete": 0, "target": 1, "keep": 0}
global int marker = 0
global int result = 0
fn prepare() -> str {
  set values = {"target": 2, "keep": 3}
  set marker = 1
  return "target"
}
scene main {
  unset values[prepare()]
  if marker == 1 {
    set result = values["keep"]
  } else {
    set result = 9
  }
}
`;
  const outcomes = {};
  for (const debug of [false, true]) {
    const compiled = compile(parse(source), new Map(), new Map(), debug);
    const browser = new Runtime();
    await browser.run(compiled);
    await fs.writeFile(file, JSON.stringify(nativePackage(compiled)));
    const child = spawnSync(exe, [file, '--headless'], { encoding: 'utf8', timeout: 10000 });
    assert.equal(child.status, 0, child.stderr || child.error?.message);
    const native = JSON.parse(child.stdout).globals;
    const outcome = {
      values: Object.fromEntries(Object.entries(browser.get('values')).map(([key, value]) => [key, String(value)])),
      marker: String(browser.get('marker')),
      result: String(browser.get('result')),
    };
    const nativeOutcome = { values: Object.fromEntries(Object.entries(native.values).map(([key, value]) => [key, String(value)])), marker: String(native.marker), result: String(native.result) };
    assert.deepEqual(outcome, nativeOutcome, `Browser/Native mismatch, debug=${debug}`);
    outcomes[debug ? 'raw' : 'optimized'] = outcome;
  }
  assert.deepEqual(outcomes.optimized, outcomes.raw);
  assert.deepEqual(outcomes.optimized, { values: { keep: '3' }, marker: '1', result: '3' });
});

test('native and browser runtimes report matching loop-limit and for-in errors', async t => {
  const exe = await nativeExecutableForTest(t);
  if (!exe) return;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-native-loop-errors-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'test.nsp.json');
  const loopLimitMessage = 'loop の実行回数が上限の100,000回を超えました';
  const loopLimitProgram = program('scene main {\n  while true {}\n}');
  await assert.rejects(new Runtime().run(loopLimitProgram), error => error.message === loopLimitMessage);
  await fs.writeFile(file, JSON.stringify(nativePackage(loopLimitProgram)));
  const nativeLoopLimit = spawnSync(exe, [file, '--headless'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(nativeLoopLimit.status, 1);
  assert.equal(nativeLoopLimit.stderr.trim(), `Player error: ${loopLimitMessage}`);

  const forInMessage = 'for-in には list を指定してください';
  const invalidForInProgram = program('global list[int] values = [1]\nscene main {\n  for item in values {}\n}');
  invalidForInProgram.globals[0].initial = { kind: 'integer', value: '1' };
  await assert.rejects(new Runtime().run(invalidForInProgram), error => error.message === forInMessage);
  await fs.writeFile(file, JSON.stringify(nativePackage(invalidForInProgram)));
  const nativeForIn = spawnSync(exe, [file, '--headless'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(nativeForIn.status, 1);
  assert.equal(nativeForIn.stderr.trim(), `Player error: ${forInMessage}`);

  const listIndexMessage = 'list の添字が範囲外です: 3';
  const invalidListIndexProgram = program('global list[int] values = [1]\nfn readPastEnd() -> int { return values[3] }\nscene main { readPastEnd() }');
  await assert.rejects(new Runtime().run(invalidListIndexProgram), error => error.message === listIndexMessage);
  await fs.writeFile(file, JSON.stringify(nativePackage(invalidListIndexProgram)));
  const nativeListIndex = spawnSync(exe, [file, '--headless'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(nativeListIndex.status, 1);
  assert.equal(nativeListIndex.stderr.trim(), `Player error: ${listIndexMessage}`);

  const nonIntegerIndexMessage = 'list の添字は int で指定してください';
  const nonIntegerListIndexProgram = program('global list[int] values = [1]\nfn readWithInvalidIndex() -> int { return values[0] }\nscene main { readWithInvalidIndex() }');
  nonIntegerListIndexProgram.functions[0].body[0].value.key = { kind: 'literal', value: true };
  await assert.rejects(new Runtime().run(nonIntegerListIndexProgram), error => error.message === nonIntegerIndexMessage);
  await fs.writeFile(file, JSON.stringify(nativePackage(nonIntegerListIndexProgram)));
  const nativeNonIntegerIndex = spawnSync(exe, [file, '--headless'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(nativeNonIntegerIndex.status, 1);
  assert.equal(nativeNonIntegerIndex.stderr.trim(), `Player error: ${nonIntegerIndexMessage}`);
});

test('native and browser runtimes agree on bool, typed lists, list loops, and text intrinsics', async t => {
  const exe = await nativeExecutableForTest(t);
  if (!exe) return;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-native-list-parity-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const scenesRoot = path.join(dir, 'scenes'), assetsRoot = path.join(dir, 'assets');
  await fs.mkdir(scenesRoot); await fs.mkdir(assetsRoot);
  const source = `global bool active = true
global bool containsFour = false
global list[int] values = [2, 4]
global list[bool] flags = [true, false]
global list[str] parts = text.split(",red,,blue,", ",")
global str normalized = text.normalize_space("  a\t\u00a0b　 ")
global int total = 0
fn sum(items: list[int]) -> int {
  int result = 0
  for item in items { set result = result + item }
  return result
}
scene main {
  set active = not active
  set values = list.append(values, 6)
  set containsFour = list.contains(values, 4)
  for flag in flags { if flag { set total = total + 1 } }
  for part in parts { say narrator part }
  if active { say narrator "active" } else { say narrator "inactive" }
  say narrator str(list.length(values)) + ":" + normalized + ":" + str(sum(values))
}`;
  const sourceFile = path.join(scenesRoot, 'main.tds'), packageFile = path.join(dir, 'lists.nsp.json');
  await fs.writeFile(sourceFile, source, 'utf8');
  const packaged = await pack(sourceFile, packageFile, { scenesRoot, assetsRoot });
  const browserLines = [];
  const browser = new Runtime({ command: async (name, args, runtime) => { if (name === 'say') browserLines.push(await runtime.textAsync(args[1])); } });
  await browser.run(packaged.program);
  const native = spawnSync(exe, [packageFile, '--headless'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(native.status, 0, native.stderr || native.error?.message);
  const transcript = JSON.parse(native.stdout);
  assert.deepEqual(transcript.commands.filter((command) => command.name === 'say').map((command) => command.args[1]), browserLines);
  assert.deepEqual(browserLines, ['', 'red', '', 'blue', '', 'inactive', '3:a b:12']);
  assert.equal(transcript.globals.active, browser.get('active'));
  assert.equal(transcript.globals.containsFour, browser.get('containsFour'));
  assert.equal(transcript.globals.total, Number(browser.get('total')));
  assert.deepEqual(transcript.globals.values, browser.get('values').map(Number));
  assert.deepEqual(transcript.globals.flags, browser.get('flags'));
  assert.equal(transcript.globals.normalized, browser.get('normalized'));
});

test('native and browser runtimes serialize dictionary interpolation keys in Unicode order', async t => {
  const exe = await nativeExecutableForTest(t);
  if (!exe) return;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-native-dict-text-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const scenesRoot = path.join(dir, 'scenes'), assetsRoot = path.join(dir, 'assets');
  await fs.mkdir(scenesRoot); await fs.mkdir(assetsRoot);
  const source = `global dict[int] values = {"zeta": 1, "alpha": 2, "2": 20, "10": 10, "𐀀": 5, "": 4}
scene main { say narrator "{values}" }`;
  const sourceFile = path.join(scenesRoot, 'main.tds'), packageFile = path.join(dir, 'dict-text.nsp.json');
  await fs.writeFile(sourceFile, source, 'utf8');
  const packaged = await pack(sourceFile, packageFile, { scenesRoot, assetsRoot });
  const browserLines = [];
  const browser = new Runtime({ command: async (name, args, runtime) => { if (name === 'say') browserLines.push(await runtime.textAsync(args[1])); } });
  await browser.run(packaged.program);
  const native = spawnSync(exe, [packageFile, '--headless'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(native.status, 0, native.stderr || native.error?.message);
  const nativeLines = JSON.parse(native.stdout).commands.filter(command => command.name === 'say').map(command => command.args[1]);
  assert.deepEqual(nativeLines, browserLines);
  assert.deepEqual(browserLines, ['{"10":10,"2":20,"alpha":2,"zeta":1,"":4,"𐀀":5}']);
});

test('Browser and Native debug-start accept bool, list, dictionary, and struct overrides with matching types', async t => {
  const exe = await nativeExecutableForTest(t);
  if (!exe) return;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-native-debug-collections-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const scenesRoot = path.join(dir, 'scenes'), assetsRoot = path.join(dir, 'assets');
  await fs.mkdir(scenesRoot); await fs.mkdir(assetsRoot);
  const source = `global bool enabled = false
global list[bool] choices = [false]
global dict[bool] routeFlags = {"common": false}
struct Flags {
  active: bool
  label: str
}
global Flags state = {"active": false, "label": "base"}
scene main {
  if enabled and choices[0] and routeFlags["common"] and state.active { say narrator state.label }
}`;
  const sourceFile = path.join(scenesRoot, 'main.tds'), packageFile = path.join(dir, 'debug-collections.nsp.json');
  await fs.writeFile(sourceFile, source, 'utf8');
  const packaged = await pack(sourceFile, packageFile, { scenesRoot, assetsRoot, debug: true });
  const line = source.split('\n').findIndex(value => value.trimStart().startsWith('say narrator')) + 1;
  const overrides = {
    enabled: { type: 'bool', value: 'true' },
    choices: { type: 'list<bool>', value: '[true,false]' },
    routeFlags: { type: 'dict<bool>', value: '{"common":true}' },
    state: { type: 'struct', fields: { active: 'bool', label: 'str' }, value: '{"active":true,"label":"debug"}' },
  };
  const browserLines = [];
  const browser = new Runtime({ command: async (name, args, runtime) => { if (name === 'say') browserLines.push(await runtime.textAsync(args[1])); } });
  await browser.run(packaged.program, {
    file: 'main.tds', scene: 'main', line,
    variables: {
      enabled: true, choices: [true, false],
      routeFlags: Object.assign(Object.create(null), { common: true }),
      state: Object.assign(Object.create(null), { active: true, label: 'debug' }),
    },
  });
  const native = spawnSync(exe, [packageFile, '--headless', '--debug-start', 'main.tds', 'main', String(line), JSON.stringify(overrides)], { encoding: 'utf8', timeout: 10000 });
  assert.equal(native.status, 0, native.stderr || native.error?.message);
  const transcript = JSON.parse(native.stdout);
  assert.deepEqual(browserLines, ['debug']);
  assert.deepEqual(transcript.commands.filter(command => command.name === 'say').map(command => command.args[1]), browserLines);
  const invalid = spawnSync(exe, [packageFile, '--headless', '--debug-start', 'main.tds', 'main', String(line), JSON.stringify({ choices: { type: 'list<bool>', value: '["true"]' } })], { encoding: 'utf8', timeout: 10000 });
  assert.notEqual(invalid.status, 0, 'Native must reject debug list items that do not match the declared element type');
});

test('native and browser runtimes agree on nested interpolation side effects', async t => {
  const exe = await nativeExecutableForTest(t);
  if (!exe) return;
  const source = `
    int state = 0
    str template = "{mutate()}"
    fn mutate() -> str { set state = 1
      return "changed" }
    say narrator "{template}"
  `;
  const compiled = program(source);
  const browser = new Runtime({ command: async (name, args, runtime) => { if (name === 'say') await runtime.textAsync(args[1]); }, choice: async () => 0 });
  await browser.run(compiled);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-native-nested-interpolation-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'nested.nsp.json');
  await fs.writeFile(file, JSON.stringify(nativePackage(compiled)));
  const child = spawnSync(exe, [file, '--headless'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 0, child.stderr || child.error?.message);
  assert.equal(JSON.parse(child.stdout).globals.state, Number(browser.get('state')));
  assert.equal(browser.get('state'), 1n);
});
