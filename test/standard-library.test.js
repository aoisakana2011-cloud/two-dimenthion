'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Runtime } = require('../Edit/runtime');
const { projectLayout, seedEmptyProject } = require('../tools/project-layout');
const { compileProject, resolveProjectScript, isStandardLibraryInclude, listStandardLibrary, readStandardLibraryFile } = require('../tools/project');
const { pack } = require('../tools/pack');
const { analyzeScript } = require('../dist/checker/analyzer');

test('bundled std/math is namespaced, type-checked, portable, and works in the runtime', async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-stdlib-math-'));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  seedEmptyProject(projectRoot);
  const layout = projectLayout(projectRoot);
  const source = `
include "std/math.tds" as math
float sine = math.sin(math.pi() / 6.0)
float cosine = math.cos(math.pi())
float negative_sine = math.sin(-13.0 * math.pi() / 6.0)
float reduced_sine = math.sin(100.0 * math.pi() + math.pi() / 6.0)
float lower_bound = math.clamp(-4.0, 0.0, 1.0)
float upper_bound = math.clamp(4.0, 0.0, 1.0)
float midpoint = math.lerp(2.0, 6.0, 0.25)
float absolute = math.abs(-3.5)
float negative_root = math.sqrt(-1.0)
float zero_root = math.sqrt(0.0)
float root_two = math.sqrt(2.0)
float root_tiny = math.sqrt(0.00000000000000000001)
float root_min_subnormal = math.sqrt(5e-324)
float root_min_normal = math.sqrt(2.2250738585072014e-308)
float root_max_finite = math.sqrt(1.7976931348623157e308)
float negative_root_min_subnormal = math.sqrt(-5e-324)
float negative_root_max_finite = math.sqrt(-1.7976931348623157e308)
float floor_negative = math.floor(-2.2)
float ceil_negative = math.ceil(-2.2)
float rounded_positive = math.round(2.5)
float rounded_negative = math.round(-2.5)
float sign_negative = math.sign(-4.0)
float radians = math.radians(180.0)
float degrees = math.degrees(math.pi())
float smooth_mid = math.smoothstep(0.0, 1.0, 0.5)
float smoother_mid = math.smootherstep(0.0, 1.0, 0.5)
float ease_out = math.ease_out_quad(0.5)
float ease_clamped = math.ease_in_quad(2.0)
float mapped = math.map_range(5.0, 0.0, 10.0, 0.0, 100.0)
float mapped_degenerate = math.map_range(5.0, 2.0, 2.0, 7.0, 9.0)
float diagonal = math.distance(0.0, 0.0, 3.0, 4.0)
float approached = math.approach(2.0, 10.0, -3.0)
float cubic_in_out = math.ease_in_out_cubic(0.5)
scene main { wait 1 }
`;
  await fs.writeFile(path.join(layout.scenesRoot, 'main.tds'), source, 'utf8');

  const resolved = await resolveProjectScript(source, layout.scenesRoot, new Set(), 'main.tds');
  assert.ok(resolved.functions.some((fn) => fn.name === 'math.sin'));
  const flowDiagnostics = analyzeScript(resolved, 'main.tds');
  assert.equal(flowDiagnostics.some(item => item.file === 'std/math.tds' && ['infinite-loop', 'unreachable-code'].includes(item.code)), false,
    JSON.stringify(flowDiagnostics.filter(item => item.file === 'std/math.tds' && ['infinite-loop', 'unreachable-code'].includes(item.code))));
  assert.deepEqual((await listStandardLibrary()).find((module) => module.path === 'std/math.tds')?.functions.sort(), ['abs', 'approach', 'ceil', 'clamp', 'cos', 'degrees', 'distance', 'ease_in_cubic', 'ease_in_out_cubic', 'ease_in_out_quad', 'ease_in_quad', 'ease_out_cubic', 'ease_out_quad', 'floor', 'lerp', 'map_range', 'max', 'min', 'pi', 'radians', 'round', 'sign', 'sin', 'smootherstep', 'smoothstep', 'sqrt', 'tau']);
  assert.equal(isStandardLibraryInclude('std/math.tds'), true);
  assert.equal(isStandardLibraryInclude('helpers/math.tds'), false);

  const compiled = await compileProject(source, layout.assetsRoot, layout.scenesRoot, new Map(), new Map(), 'main.tds');
  const runtime = new Runtime({ command: async () => {} });
  await runtime.run(compiled);
  const closeTo = (name, expected, tolerance = 1e-9) => assert.ok(Math.abs(runtime.get(name) - expected) <= tolerance, `${name}: expected ${expected}, got ${runtime.get(name)}`);
  closeTo('sine', 0.5);
  closeTo('cosine', -1.0);
  closeTo('negative_sine', -0.5);
  closeTo('reduced_sine', 0.5, 1e-8);
  closeTo('lower_bound', 0.0);
  closeTo('upper_bound', 1.0);
  closeTo('midpoint', 3.0);
  closeTo('absolute', 3.5);
  closeTo('negative_root', 0.0);
  closeTo('zero_root', 0.0);
  closeTo('root_two', Math.SQRT2);
  closeTo('root_tiny', 1e-10, 1e-18);
  const closeRelative = (name, expected) => {
    const actual = runtime.get(name);
    const tolerance = Math.max(Number.MIN_VALUE * 4, Math.abs(expected) * 1e-12);
    assert.ok(Math.abs(actual - expected) <= tolerance, `${name}: expected ${expected}, got ${actual} (tolerance ${tolerance})`);
  };
  closeRelative('root_min_subnormal', Math.sqrt(Number.MIN_VALUE));
  closeRelative('root_min_normal', Math.sqrt(2.2250738585072014e-308));
  closeRelative('root_max_finite', Math.sqrt(Number.MAX_VALUE));
  closeTo('negative_root_min_subnormal', 0.0);
  closeTo('negative_root_max_finite', 0.0);
  closeTo('floor_negative', -3.0);
  closeTo('ceil_negative', -2.0);
  closeTo('rounded_positive', 3.0);
  closeTo('rounded_negative', -3.0);
  closeTo('sign_negative', -1.0);
  closeTo('radians', Math.PI);
  closeTo('degrees', 180.0);
  closeTo('smooth_mid', 0.5);
  closeTo('smoother_mid', 0.5);
  closeTo('ease_out', 0.75);
  closeTo('ease_clamped', 1.0);
  closeTo('mapped', 50.0);
  closeTo('mapped_degenerate', 7.0);
  closeTo('diagonal', 5.0);
  closeTo('approached', 5.0);
  closeTo('cubic_in_out', 0.5);

  const packageFile = path.join(layout.buildRoot, 'math.nsp.json');
  const packaged = await pack(path.join(layout.scenesRoot, 'main.tds'), packageFile, { projectRoot });
  assert.ok(packaged.program.functions.some((fn) => fn.name === 'math.sin'));
  const native = process.env.NOVEL_NATIVE_EXE || path.resolve(__dirname, '../native/build/Release/novel_player.exe');
  try {
    await fs.access(native);
    const result = spawnSync(native, [packageFile, '--headless'], { encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    const nativeGlobals = JSON.parse(result.stdout).globals;
    for (const name of ['sine', 'cosine', 'negative_sine', 'reduced_sine', 'lower_bound', 'upper_bound', 'midpoint', 'absolute', 'negative_root', 'zero_root', 'root_two', 'root_tiny', 'root_min_subnormal', 'root_min_normal', 'root_max_finite', 'negative_root_min_subnormal', 'negative_root_max_finite', 'floor_negative', 'ceil_negative', 'rounded_positive', 'rounded_negative', 'sign_negative', 'radians', 'degrees', 'smooth_mid', 'smoother_mid', 'ease_out', 'ease_clamped', 'mapped', 'mapped_degenerate', 'diagonal', 'approached', 'cubic_in_out']) {
      const expected = runtime.get(name);
      const tolerance = Math.max(Number.MIN_VALUE * 4, Math.abs(expected) * 1e-12);
      assert.ok(Math.abs(nativeGlobals[name] - expected) <= tolerance, `Browser/Native parity for ${name}: ${nativeGlobals[name]} vs ${expected} (tolerance ${tolerance})`);
    }
  } catch (error) {
    if (error.code === 'ENOENT' && !process.env.NOVEL_NATIVE_EXE) t.skip('Native player is not built; Browser runtime checks still ran');
    else throw error;
  }
});

test('bundled standard-library source can be opened by definition navigation without allowing path escape', async () => {
  const file = await readStandardLibraryFile('std/motion/walk.tds');
  assert.equal(file.name, 'std/motion/walk.tds');
  assert.match(file.source, /fn character\(target_character: str, distance_px: float, cycles: int, seconds: float, bob_px: float\)/);
  assert.match(file.source, /fn walk_x\(distance_px: float, progress: float\)/);
  assert.doesNotMatch(file.source, /fn walk_bob\(/);
  await assert.rejects(readStandardLibraryFile('std/..\\package.json'));
  await assert.rejects(readStandardLibraryFile('main.tds'));
});

test('std/math sqrt stays accurate across the finite float exponent range and negative inputs compile by contract', async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-stdlib-sqrt-range-'));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  seedEmptyProject(projectRoot);
  const layout = projectLayout(projectRoot);
  const probes = [];
  for (let exponent = -323; exponent <= 308; exponent += 7) {
    for (const mantissa of [1.0001, 1.5, 3.999]) {
      const value = mantissa * (10 ** exponent);
      if (!Number.isFinite(value) || value <= 0) continue;
      probes.push({ name: `sqrt_probe_${probes.length}`, value });
    }
  }
  const assignments = probes.map(({ name, value }) => {
    const literal = String(value);
    return `float ${name} = math.sqrt(${Number.isInteger(value) && !/[.e]/i.test(literal) ? `${literal}.0` : literal})`;
  }).join('\n');
  const source = `include "std/math.tds" as math\nfloat negative = math.sqrt(-1.0)\n${assignments}\nscene main { wait 1 }\n`;
  await fs.writeFile(path.join(layout.scenesRoot, 'main.tds'), source, 'utf8');

  // The standard function explicitly clamps every non-positive input to zero;
  // this is its documented runtime contract, not a compiler diagnostic case.
  const compiled = await compileProject(source, layout.assetsRoot, layout.scenesRoot, new Map(), new Map(), 'main.tds');
  const runtime = new Runtime({ command: async () => {} });
  await runtime.run(compiled);
  assert.equal(runtime.get('negative'), 0);
  for (const { name, value } of probes) {
    const expected = Math.sqrt(value);
    const actual = runtime.get(name);
    const tolerance = Math.max(Number.MIN_VALUE * 4, Math.abs(expected) * 1e-12);
    assert.ok(Math.abs(actual - expected) <= tolerance, `${name} sqrt(${value}): expected ${expected}, got ${actual}`);
  }

  const packageFile = path.join(layout.buildRoot, 'sqrt-range.nsp.json');
  await pack(path.join(layout.scenesRoot, 'main.tds'), packageFile, { projectRoot });
  const native = process.env.NOVEL_NATIVE_EXE || path.resolve(__dirname, '../native/build/Release/novel_player.exe');
  try {
    await fs.access(native);
    const result = spawnSync(native, [packageFile, '--headless'], { encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    const nativeGlobals = JSON.parse(result.stdout).globals;
    assert.equal(nativeGlobals.negative, 0);
    for (const { name } of probes) {
      const expected = runtime.get(name);
      const tolerance = Math.max(Number.MIN_VALUE * 4, Math.abs(expected) * 1e-12);
      assert.ok(Math.abs(nativeGlobals[name] - expected) <= tolerance, `Browser/Native parity for ${name}: ${nativeGlobals[name]} vs ${expected}`);
    }
  } catch (error) {
    if (error.code === 'ENOENT' && !process.env.NOVEL_NATIVE_EXE) t.skip('Native player is not built; Browser/compiler checks still ran');
    else throw error;
  }
});

test('std include paths are reserved, bundled, and cannot escape the library root', async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-stdlib-path-'));
  try {
    seedEmptyProject(projectRoot);
    const layout = projectLayout(projectRoot);
    await fs.mkdir(path.join(layout.scenesRoot, 'std'), { recursive: true });
    await fs.writeFile(path.join(layout.scenesRoot, 'std', 'math.tds'), 'fn wrong() -> int { return 0 }');
    const script = await resolveProjectScript('include "std/math.tds" as math\nscene main { wait 1 }', layout.scenesRoot, new Set(), 'main.tds');
    assert.ok(script.functions.some((fn) => fn.name === 'math.sin'), 'the shipped module wins over a project-local file in the reserved std/ namespace');
    assert.equal(script.functions.some((fn) => fn.name === 'math.wrong'), false);
    await assert.rejects(
      resolveProjectScript('include "std/../tools/project.js" as escape\nscene main { wait 1 }', layout.scenesRoot, new Set(), 'main.tds'),
      /Invalid scene path/,
    );
  } finally {
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});

test('std motion modules provide walk_x and presentation-effect offsets', async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-stdlib-motion-'));
  try {
    seedEmptyProject(projectRoot);
    const layout = projectLayout(projectRoot);
    const source = `
include "std/motion/walk.tds" as walk
include "std/motion/effects.tds" as motion
float walk_x = walk.walk_x(100.0, 0.25)
float walk_start_x = walk.walk_x(100.0, 0.0)
float walk_end_x = walk.walk_x(100.0, 1.0)
float shake = motion.shake(4.0, 0.25, 1.0)
float breathing = motion.breathe(2.0, 0.25)
float hop = motion.hop(10.0, 0.5)
float drift = motion.drift(5.0, 0.25, 2.0)
scene main { wait 1 }
`;
    await fs.writeFile(path.join(layout.scenesRoot, 'main.tds'), source, 'utf8');
    const compiled = await compileProject(source, layout.assetsRoot, layout.scenesRoot, new Map(), new Map(), 'main.tds');
    const runtime = new Runtime({ command: async () => {} });
    await runtime.run(compiled);
    const expected = {
      walk_x: 25, walk_start_x: 0, walk_end_x: 100,
      shake: 3, breathing: 2, hop: -10, drift: 0,
    };
    for (const [name, value] of Object.entries(expected)) {
      assert.ok(Math.abs(runtime.get(name) - value) <= 1e-8, `${name}: expected ${value}, got ${runtime.get(name)}`);
    }
  } finally {
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});

test('walk.character requires a statically proven visible character and guards runtime moves', async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-walk-presence-'));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  seedEmptyProject(projectRoot);
  const { scenesRoot, assetsRoot } = projectLayout(projectRoot);
  const visible = `include "std/motion/walk.tds" as walk
character rei {
  name = "Rei"
  pose normal = "asset/char/rei.png"
}
scene main {
  show rei.normal center
  walk.character("rei", 72.0, 1, 1.0, 4.0)
}`;
  await fs.writeFile(path.join(scenesRoot, 'main.tds'), visible, 'utf8');
  await fs.writeFile(path.join(assetsRoot, 'char/rei.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p8sAAAAASUVORK5CYII=', 'base64'));
  const resolved = await resolveProjectScript(visible, scenesRoot, new Set(), 'main.tds');
  const diagnostics = analyzeScript(resolved, 'main.tds');
  assert.equal(diagnostics.some(item => item.code === 'unproven-character-presence-at-call'), false, JSON.stringify(diagnostics));

  const guarded = `include "std/motion/walk.tds" as walk
character rei {
  name = "Rei"
  pose normal = "asset/char/rei.png"
}
scene main {
  if runtime.state.characters.exists("rei") {
    walk.character("rei", 72.0, 1, 1.0, 4.0)
  }
}`;
  const guardedResolved = await resolveProjectScript(guarded, scenesRoot, new Set(), 'main.tds');
  assert.equal(analyzeScript(guardedResolved, 'main.tds').some(item => item.code === 'unproven-character-presence-at-call'), false,
    'the shared runtime-state predicate proves presence in its true branch');

  const uncertain = `include "std/motion/walk.tds" as walk
character rei {
  name = "Rei"
  pose normal = "asset/char/rei.png"
}
scene main { walk.character("rei", 72.0, 1, 1.0, 4.0) }`;
  const uncertainResolved = await resolveProjectScript(uncertain, scenesRoot, new Set(), 'main.tds');
  const warning = analyzeScript(uncertainResolved, 'main.tds').find(item => item.code === 'unproven-character-presence-at-call');
  assert.ok(warning, 'call without a guaranteed show or runtime-state guard is reported');
  assert.match(warning.message, /runtime\.state\.characters\.exists/);

  const compiled = await compileProject(uncertain, assetsRoot, scenesRoot, new Map(), new Map(), 'main.tds');
  const moves = [];
  const runtime = new Runtime({ command: async (name, args) => { if (name === 'move') moves.push(args); } });
  await runtime.run(compiled);
  assert.equal(moves.length, 0, 'the function runtime guard skips movement when the character is absent');
});

test('std text and collection helpers are implemented in TDS and work in both runtimes', async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-stdlib-data-'));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  seedEmptyProject(projectRoot);
  const layout = projectLayout(projectRoot);
  const source = `include "std/text.tds" as strings
include "std/collections.tds" as collections
global list[str] words = strings.split_words("  rain　 and   roses  ")
global str joined = strings.join_words(words, "/")
global int and_index = collections.index_of_str(words, "and")
global list[str] existing_word = collections.append_unique_str(words, "and")
global list[str] appended_word = collections.append_unique_str(words, "violet")
global list[str] removed_words = collections.remove_all_str(["rain", "rose", "rain"], "rain")
global list[str] no_words = strings.split_words(" 　   ")
global str no_words_joined = strings.join_words(no_words, ",")
scene main {
  say narrator joined + ":" + str(and_index)
}`;
  const sourceFile = path.join(layout.scenesRoot, 'main.tds');
  const packageFile = path.join(layout.buildRoot, 'text-collections.nsp.json');
  await fs.writeFile(sourceFile, source, 'utf8');
  const resolved = await resolveProjectScript(source, layout.scenesRoot, new Set(), 'main.tds');
  assert.ok(resolved.functions.some(fn => fn.name === 'strings.split_words'));
  assert.ok(resolved.functions.some(fn => fn.name === 'collections.remove_all_str'));
  assert.deepEqual((await listStandardLibrary()).find(module => module.path === 'std/text.tds')?.functions.sort(), ['join_words', 'split_words']);
  assert.deepEqual((await listStandardLibrary()).find(module => module.path === 'std/collections.tds')?.functions.sort(), ['append_unique_str', 'index_of_str', 'remove_all_str']);

  const packaged = await pack(sourceFile, packageFile, { projectRoot });
  const dialogue = [];
  const browser = new Runtime({ command: async (name, args) => { if (name === 'say') dialogue.push(args[1]); } });
  await browser.run(packaged.program);
  assert.deepEqual(dialogue, ['rain/and/roses:1']);
  assert.deepEqual(browser.get('words'), ['rain', 'and', 'roses']);
  assert.deepEqual(browser.get('existing_word'), ['rain', 'and', 'roses']);
  assert.deepEqual(browser.get('appended_word'), ['rain', 'and', 'roses', 'violet']);
  assert.deepEqual(browser.get('removed_words'), ['rose']);
  assert.deepEqual(browser.get('no_words'), []);
  assert.equal(browser.get('no_words_joined'), '');

  const native = process.env.NOVEL_NATIVE_EXE || path.resolve(__dirname, '../native/build/Release/novel_player.exe');
  try {
    await fs.access(native);
    const result = spawnSync(native, [packageFile, '--headless'], { encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    const globals = JSON.parse(result.stdout).globals;
    assert.deepEqual(globals.words, browser.get('words'));
    assert.deepEqual(globals.appended_word, browser.get('appended_word'));
    assert.deepEqual(globals.removed_words, browser.get('removed_words'));
    assert.deepEqual(globals.no_words, []);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    t.diagnostic('Native parity skipped because the Native player has not been built');
  }
});
