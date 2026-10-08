'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pack } = require('../tools/pack');
const { Runtime } = require('../Edit/runtime');

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-intrinsic-parity-'));
  try {
    const scenesRoot = path.join(root, 'scenes');
    const assetsRoot = path.join(root, 'assets');
    await fs.mkdir(scenesRoot);
    await fs.mkdir(assetsRoot);
    const sceneFile = path.join(scenesRoot, 'main.tds');
    const smile = String.fromCodePoint(0x1f600);
    const end = String.fromCodePoint(0x7d42);
    const ideographicSpace = String.fromCodePoint(0x3000);
    const nbsp = String.fromCodePoint(0xa0);
    const source = `include "std/math.tds" as math
global int parsed = int("-12")
global int truncated = int(-1.9)
global float parsed_float = float("1.25")
global list[str] pieces = text.split("${smile}${end}${smile}", "${smile}")
global str replaced = text.replace("aaaa", "aa", "x")
global str trimmed = text.trim(" \t${ideographicSpace}X${nbsp} ")
global str normalized = text.normalize_space("${ideographicSpace} A \t B${nbsp}")
global list[int] appended = list.append([1,2],3)
global bool contains = list.contains(appended,3)
global list[int] removed = list.remove_all([1,2,1,3],1)
global str joined = text.join(["", "x", ""], "|")
scene main {
  volume bgm 0.25
  dialog opacity 0.4
  say narrator str(math.sin(0.3)) + "|" + str(math.cos(0.3)) + "|" + str(parsed) + "|" + str(truncated) + "|" + str(parsed_float) + "|" + replaced + "|" + trimmed + "|" + normalized
  if contains { say narrator "contains" }
  if runtime.state.variables.exists("parsed") { say narrator "state" }
  if runtime.state.execution.current_scene() == "main" { say narrator "scene" }
  if runtime.state.audio.volume("bgm") == 0.25 { say narrator "volume" }
  if runtime.state.ui.dialog_opacity() == 0.4 { say narrator "opacity" }
}`;
    await fs.writeFile(sceneFile, source, 'utf8');
    const packagePath = path.join(root, 'intrinsics.nsp.json');
    const compiled = await pack(sceneFile, packagePath, { scenesRoot, assetsRoot });

    const browserLines = [];
    const browser = new Runtime({ command: async (name, args, runtime) => {
      if (name === 'say') browserLines.push(await runtime.textAsync(args[1]));
    } });
    await browser.run(compiled.program);

    const executable = process.env.NOVEL_NATIVE_EXE || path.resolve(__dirname, '../native/build/Release/novel_player.exe');
    assert.equal(await fs.stat(executable).then(() => true, () => false), true, `Native executable not found: ${executable}`);
    const native = spawnSync(executable, [packagePath, '--headless'], { encoding: 'utf8', timeout: 10000 });
    assert.equal(native.status, 0, native.stderr || native.error?.message);
    const transcript = JSON.parse(native.stdout);
    const nativeLines = transcript.commands.filter(command => command.name === 'say').map(command => command.args[1]);
    assert.deepEqual(nativeLines, browserLines, 'Browser and Native intrinsic results and Runtime State reads must match');
    assert.deepEqual(transcript.globals.pieces, ['', end, ''], 'Unicode split must preserve complete code points');
    assert.deepEqual(transcript.globals.removed, [2, 3]);
    assert.equal(transcript.globals.joined, '|x|');

    // Exercise state APIs as one ordered Browser/Native scenario. The getters
    // are consumed by dialogue output and branches so dead-code optimization
    // cannot erase the observations.
    const stateScene = path.join(scenesRoot, 'state.tds');
    await fs.writeFile(path.join(assetsRoot, 'ayase.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lfoAAAAASUVORK5CYII=', 'base64'));
    await fs.writeFile(path.join(assetsRoot, 'room.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lfoAAAAASUVORK5CYII=', 'base64'));
    await fs.writeFile(path.join(assetsRoot, 'theme.mp3'), Buffer.alloc(0));
    const stateSource = `include "std/math.tds" as math
asset bg room = "asset/room.png"
asset bgm theme = "asset/theme.mp3"
character ayase { name = "Ayase"\npose normal = "asset/ayase.png" }
global int marker = 7
global list[str] observations = []
global int item_count = 0
global int converted_int = 0
global float sine_result = 0.0
global float cosine_result = 0.0
global bool contains_result = false
global str replace_result = ""
global list[str] split_result = []
global str trim_result = ""
global str normalize_result = ""
global list[int] removed_result = []
global str joined_result = ""
global list[int] appended_result = []
global float converted_float = 0.0
scene main {
  set item_count = list.length(runtime.state.variables.names())
  set converted_int = int(runtime.state.audio.volume("bgm"))
  set sine_result = math.sin(runtime.state.audio.volume("bgm"))
  set cosine_result = math.cos(runtime.state.audio.volume("bgm"))
  set contains_result = list.contains(runtime.state.variables.names(), "marker")
  set replace_result = text.replace("aba", "a", "X")
  set split_result = text.split("aba", "b")
  set trim_result = text.trim(" x ")
  set normalize_result = text.normalize_space("a  b")
  set removed_result = list.remove_all([1, 2], 1)
  set joined_result = text.join(["x"], ",")
  set appended_result = list.append([1], 2)
  set converted_float = float(runtime.state.ui.dialog_opacity())
  set observations = runtime.state.characters.list()
  say narrator "{observations}:" + runtime.state.characters.position("ayase")
  show ayase.normal left
  if runtime.state.characters.exists("ayase") { say narrator "character-present" }
  set observations = runtime.state.characters.list()
  say narrator "{observations}:" + runtime.state.characters.position("ayase")
  bg room
  if runtime.state.background.exists() { say narrator runtime.state.background.current() }
  bgm theme
  if runtime.state.audio.bgm_exists() { say narrator runtime.state.audio.current_bgm() }
  volume se 0.3
  volume voice 0.6
  say narrator str(runtime.state.audio.volume("se")) + ":" + str(runtime.state.audio.volume("voice"))
  if runtime.state.ui.dialog_opacity() > 0.0 { say narrator "dialog-visible" }
  set observations = runtime.state.variables.names()
  say narrator "{observations}"
  say narrator runtime.state.execution.current_scene() + ":" + runtime.state.execution.current_file() + ":" + str(runtime.state.execution.current_line())
  clear bg
  clear bgm
  hide ayase
  if runtime.state.background.exists() { say narrator "background-still-present" }
  if runtime.state.audio.bgm_exists() { say narrator "bgm-still-present" }
  if runtime.state.characters.exists("ayase") { say narrator "character-still-present" }
  if runtime.state.background.current() == "" { say narrator "background-cleared" }
  if runtime.state.audio.current_bgm() == "" { say narrator "bgm-cleared" }
  if runtime.state.characters.position("ayase") == "" { say narrator "character-hidden" }
}`;
    await fs.writeFile(stateScene, stateSource, 'utf8');

    const stateCompiled = await pack(stateScene, path.join(root, 'state.nsp.json'), { scenesRoot, assetsRoot });
    const runStatePair = async (debug, suffix) => {
      const outputPath = path.join(root, `state-${suffix}.nsp.json`);
      const packageData = { ...stateCompiled, debug, program: await pack(stateScene, outputPath, { scenesRoot, assetsRoot, debug }).then(result => result.program) };
      await fs.writeFile(outputPath, JSON.stringify(packageData), 'utf8');
      const lines = [];
      const runtime = new Runtime({ command: async (name, args, rt) => { if (name === 'say') lines.push(await rt.textAsync(args[1])); } });
      await runtime.run(packageData.program);
      const nativeResult = spawnSync(executable, [outputPath, '--headless'], { encoding: 'utf8', timeout: 10000 });
      assert.equal(nativeResult.status, 0, nativeResult.stderr || nativeResult.error?.message);
      const nativeOutput = JSON.parse(nativeResult.stdout).commands.filter(command => command.name === 'say').map(command => command.args[1]);
      assert.deepEqual(nativeOutput, lines, `Browser/Native state API parity (${suffix})`);
      assert.match(lines.join('\n'), /character-present/);
      assert.match(lines.join('\n'), /0\.3:0\.6/);
      assert.match(lines.join('\n'), /main:state\.tds:/);
      return packageData;
    };
    const optimizedStatePackage = await runStatePair(false, 'optimized');
    const rawStatePackage = await runStatePair(true, 'raw');

    // Bypass the static checker in a serialized package to assert that each
    // Runtime API family rejects malformed calls at execution time.
    const malformedCalls = [
      ['list.length', [7], rawStatePackage],
      ['list.length', [[], 2], rawStatePackage],
      ['list.append', [7, 1], rawStatePackage],
      ['list.append', [[1], 'mismatch'], rawStatePackage],
      ['list.append', [[1], 2, 3], rawStatePackage],
      ['list.contains', [7, 'marker'], rawStatePackage],
      ['list.contains', [['marker'], 1], rawStatePackage],
      ['list.contains', [['marker'], 'marker', 'extra'], rawStatePackage],
      ['list.remove_all', [7, 1], rawStatePackage],
      ['list.remove_all', [[], {}], rawStatePackage],
      ['list.remove_all', [[1], 1, 'extra'], rawStatePackage],
      // The checker and runtime-semantics.md define int as str | float -> int.
      ['int', [{ kind: 'integer', value: '3' }], rawStatePackage],
      ['int', [{ kind: 'literal', value: 3 }], rawStatePackage],
      ['str', ['ok', 'extra'], rawStatePackage],
      ['int', [{ kind: 'float', value: '1.5' }, 'extra'], rawStatePackage],
      ['float', ['1.25', 'extra'], rawStatePackage],
      ['float', [true], rawStatePackage],
      ['__intrinsic_sin', ['0.3'], rawStatePackage],
      ['__intrinsic_sin', [{ kind: 'literal', value: 3 }], rawStatePackage],
      ['__intrinsic_sin', [{ kind: 'float', value: '0.3' }, 2], rawStatePackage],
      ['__intrinsic_cos', ['0.3'], rawStatePackage],
      ['__intrinsic_cos', [{ kind: 'float', value: '0.3' }, 2], rawStatePackage],
      ['text.split', ['aba', ['b']], rawStatePackage],
      ['text.trim', [' x ', 'extra'], rawStatePackage],
      ['text.normalize_space', ['a b', 'extra'], rawStatePackage],
      ['text.split', ['aba', 'b', 'extra'], rawStatePackage],
      ['text.replace', ['aba', 'a', 2], rawStatePackage],
      ['text.replace', ['aba', 'a', 'X', 'extra'], rawStatePackage],
      ['text.join', [[1], ','], rawStatePackage],
      ['text.join', [['x'], ',', 'extra'], rawStatePackage],
      ['runtime.state.characters.list', ['extra']],
      ['runtime.state.background.exists', ['extra']],
      ['runtime.state.audio.volume', ['invalid']],
      ['runtime.state.ui.dialog_opacity', ['extra']],
      ['runtime.state.execution.current_scene', ['extra']],
      ['runtime.state.variables.names', ['extra']],
    ];
    const replaceCall = (node, name, args) => {
      if (!node || typeof node !== 'object') return false;
      if (node.kind === 'call' && node.name === name) {
        node.args = args.map(value => value && typeof value === 'object' && typeof value.kind === 'string' ? value : ({ kind: 'literal', value }));
        return true;
      }
      return Object.values(node).some(value => Array.isArray(value) ? value.some(item => replaceCall(item, name, args)) : replaceCall(value, name, args));
    };
    for (const [name, args, sourcePackage = optimizedStatePackage] of malformedCalls) {
      const packageData = JSON.parse(JSON.stringify(sourcePackage));
      const searchRoot = ['int', 'float'].includes(name) ? packageData.program.scenes : packageData.program;
      assert.ok(replaceCall(searchRoot, name, args), `fixture must contain ${name}`);
      const malformedPath = path.join(root, `invalid-${name.split('.').at(-1)}.nsp.json`);
      await fs.writeFile(malformedPath, JSON.stringify(packageData), 'utf8');
      await assert.rejects(new Runtime().run(packageData.program), undefined, `Browser must reject malformed ${name}`);
      const malformedNative = spawnSync(executable, [malformedPath, '--headless'], { encoding: 'utf8', timeout: 10000 });
      assert.notEqual(malformedNative.status, 0, `Native must reject malformed ${name}`);
    }

    const invalidScene = path.join(scenesRoot, 'invalid.tds');
    await fs.writeFile(invalidScene, `global str invalid_digits = "12abc"
global int result = 0
scene main { set result = int(invalid_digits) }`, 'utf8');
    const invalidPackage = path.join(root, 'invalid.nsp.json');
    const invalidProgram = await pack(invalidScene, invalidPackage, { scenesRoot, assetsRoot });
    const invalidBrowser = new Runtime();
    await assert.rejects(invalidBrowser.run(invalidProgram.program), /int への変換に失敗|整数に変換/);
    const invalidNative = spawnSync(executable, [invalidPackage, '--headless'], { encoding: 'utf8', timeout: 10000 });
    assert.notEqual(invalidNative.status, 0, 'Native int conversion must reject non-digit strings just like Browser');
    console.log('PASS Browser/Native intrinsic and Runtime State parity');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
