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

test('standard-library guide covers every exported TDS function and typed effect signature', async () => {
  const guide = await fs.readFile(path.join(__dirname, '../std/README.md'), 'utf8');
  const modules = [
    ['std/text.tds', '### `std/text.tds`'],
    ['std/collections.tds', '### `std/collections.tds`'],
    ['std/math.tds', '## `std/math.tds`'],
    ['std/motion/walk.tds', '### `std/motion/walk.tds`'],
    ['std/motion/effects.tds', '### `std/motion/effects.tds`'],
  ];

  for (let index = 0; index < modules.length; index += 1) {
    const [relativePath, heading] = modules[index];
    const headingStart = guide.indexOf(heading);
    assert.notEqual(headingStart, -1, `guide contains ${heading}`);
    const nextHeading = modules.slice(index + 1).map(([, next]) => guide.indexOf(next, headingStart + heading.length))
      .filter(position => position !== -1).sort((a, b) => a - b)[0] ?? guide.length;
    const section = guide.slice(headingStart, nextHeading);
    const source = await fs.readFile(path.join(__dirname, '..', relativePath), 'utf8');
    const exports = [...source.matchAll(/^fn\s+(\w+)\s*\(([^)]*)\)\s*->\s*([^\s{]+)\s*\{/gm)];
    assert.ok(exports.length > 0, `${relativePath} exports functions`);
    for (const [, name] of exports) {
      assert.match(section, new RegExp(`\\b${name}\\b`), `${relativePath}:${name} is documented in its module section`);
    }

    if (relativePath === 'std/motion/effects.tds') {
      for (const [, name, parameters, returnType] of exports) {
        const typedParameters = parameters.split(',').map(parameter => {
          const [parameterName, type] = parameter.trim().split(':').map(value => value.trim());
          return `${parameterName}: ${type}`;
        }).join(', ');
        assert.ok(section.includes(`- \`${name}(${typedParameters}) -> ${returnType}\``),
          `effects signature matches implementation: ${name}`);
      }
    }
  }
});

test('project include pre-scan uses the whitespace-separated alias delimiter', async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-include-alias-boundary-'));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  const layout = seedEmptyProject(projectRoot);
  await fs.mkdir(path.join(layout.scenesRoot, 'asset'), { recursive: true });
  await fs.writeFile(path.join(layout.scenesRoot, 'asset', 'as.tds'), 'fn echo() -> int { return 7 }\n', 'utf8');
  await fs.writeFile(path.join(layout.scenesRoot, 'as.tds'), 'fn exact() -> int { return 8 }\n', 'utf8');
  await fs.writeFile(path.join(layout.scenesRoot, 'types.tds'), 'struct Record { value: int }\n', 'utf8');

  const cases = [
    ['include asset/as.tds as items', 'items.echo()'],
    ['include as as exact', 'exact.exact()'],
  ];
  for (const [include, expression] of cases) {
    const source = `${include}\nglobal int result = ${expression}\nscene main { wait 1 }\n`;
    const resolved = await resolveProjectScript(source, layout.scenesRoot, new Set(), 'main.tds');
    assert.ok(resolved.functions.some((fn) => fn.name === expression.split('.')[0] + '.' + (expression.split('.')[1].split('(')[0])));
    const compiled = await compileProject(source, layout.assetsRoot, layout.scenesRoot, new Map(), new Map(), 'main.tds');
    assert.equal(compiled.globals.some((instruction) => instruction.op === 'declare' && instruction.name === 'result'), true);
  }
  const braceLiteralSource = 'say "{"\ninclude "types.tds" as types\nRecord record = {"value": 4}\nscene main { wait 1 }\n';
  const braceResolved = await resolveProjectScript(braceLiteralSource, layout.scenesRoot, new Set(), 'main.tds');
  assert.ok(braceResolved.structs.some((item) => item.name === 'Record'), 'a brace character inside a string does not hide later top-level includes from the struct pre-scan');
  await compileProject(braceLiteralSource, layout.assetsRoot, layout.scenesRoot, new Map(), new Map(), 'main.tds');
  await fs.writeFile(path.join(layout.scenesRoot, 'main.tds'), `${braceLiteralSource}include asset/as.tds as items\nglobal int alias_value = items.echo()\n`, 'utf8');
  const packaged = await pack(path.join(layout.scenesRoot, 'main.tds'), path.join(layout.buildRoot, 'include-pre-scan.nsp.json'), { projectRoot });
  assert.ok(packaged.program.functions.some((fn) => fn.name === 'items.echo'), 'pack includes functions from paths whose final filename token is as');
  assert.ok(packaged.program.globals.some((instruction) => instruction.op === 'declare' && instruction.name === 'record'), 'pack accepts an imported struct type after a top-level string containing a brace');
  assert.ok(packaged.program.globals.some((instruction) => instruction.op === 'declare' && instruction.name === 'alias_value'), 'pack compiles globals that call functions from a path ending in as');
});

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
float huge_sine = math.sin(1e308)
float lower_bound = math.clamp(-4.0, 0.0, 1.0)
float upper_bound = math.clamp(4.0, 0.0, 1.0)
float inverted_clamp_lower = math.clamp(-4.0, 1.0, 0.0)
float inverted_clamp_upper = math.clamp(4.0, 1.0, 0.0)
float midpoint = math.lerp(2.0, 6.0, 0.25)
float lerp_extreme_midpoint = math.lerp(-1e308, 1e308, 0.5)
float lerp_extreme_quarter = math.lerp(-1e308, 1e308, 0.75)
float lerp_extreme_extrapolation = math.lerp(-1e308, 1e308, -0.1)
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
float floor_large_positive = math.floor(1e20)
float ceil_large_negative = math.ceil(-1e20)
float round_large_positive = math.round(1e20)
float round_int64_min = math.round(-9223372036854775808.0)
float sign_negative = math.sign(-4.0)
float minimum = math.min(2.0, -3.0)
float maximum = math.max(2.0, -3.0)
float radians = math.radians(180.0)
float degrees = math.degrees(math.pi())
float smooth_mid = math.smoothstep(0.0, 1.0, 0.5)
float smoother_mid = math.smootherstep(0.0, 1.0, 0.5)
float ease_out = math.ease_out_quad(0.5)
float ease_in_out = math.ease_in_out_quad(0.5)
float ease_clamped = math.ease_in_quad(2.0)
float ease_in_cubic = math.ease_in_cubic(0.5)
float ease_out_cubic = math.ease_out_cubic(0.5)
float ease_in_out_cubic_midpoint = math.ease_in_out_cubic(0.5)
float mapped = math.map_range(5.0, 0.0, 10.0, 0.0, 100.0)
float mapped_extreme_midpoint = math.map_range(0.0, -1e308, 1e308, 0.0, 1.0)
float mapped_extreme_reversed_midpoint = math.map_range(0.0, 1e308, -1e308, 0.0, 1.0)
float mapped_opposite_sign_extrapolation = 0.0
float smooth_extreme_midpoint = math.smoothstep(-1e308, 1e308, 0.0)
float smoother_extreme_midpoint = math.smootherstep(-1e308, 1e308, 0.0)
float mapped_degenerate = math.map_range(5.0, 2.0, 2.0, 7.0, 9.0)
float smooth_equal_edge_below = math.smoothstep(2.0, 2.0, 1.0)
float smooth_equal_edge_at = math.smoothstep(2.0, 2.0, 2.0)
float smoother_equal_edge_above = math.smootherstep(2.0, 2.0, 3.0)
float smoother_equal_edge_below = math.smootherstep(2.0, 2.0, 1.0)
float smoother_equal_edge_at = math.smootherstep(2.0, 2.0, 2.0)
float diagonal = math.distance(0.0, 0.0, 3.0, 4.0)
float diagonal_large = math.distance(0.0, 0.0, 3e200, 4e200)
float diagonal_small = math.distance(0.0, 0.0, 3e-200, 4e-200)
bool distance_overflow_saturates = math.distance(-1e308, 0.0, 1e308, 0.0) == 1.7976931348623157e308
float approached = math.approach(2.0, 10.0, -3.0)
float approached_positive_overstep = math.approach(1e308, 1.7e308, 1e308)
float approached_negative_overstep = math.approach(-1e308, -1.7e308, 1e308)
float approached_positive_to_negative = math.approach(1e308, -1e308, 1.7e308)
float approached_negative_to_positive = math.approach(-1e308, 1e308, 1.7e308)
float cubic_in_out = math.ease_in_out_cubic(0.5)
fn map_range_probe(value: float) -> float { return math.map_range(value, 1e308, 1.7e308, 0.0, 1.0) }
scene main {
  set mapped_opposite_sign_extrapolation = map_range_probe(-1e308)
  wait 1
}
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
  closeTo('huge_sine', Math.sin(1e308), 1e-15);
  const nonFiniteSine = await runtime.call('math.sin', [Infinity]);
  assert.equal(nonFiniteSine, 0.0, 'non-finite angles use the documented safe fallback');
  assert.equal(await runtime.call('math.sin', [NaN]), 0.0, 'NaN also uses the documented non-finite fallback');
  assert.equal(await runtime.call('math.cos', [Infinity]), 0.0, 'cos applies the same non-finite fallback before adding its phase offset');
  assert.equal(await runtime.call('math.cos', [NaN]), 0.0, 'cos applies the fallback to NaN as well');
  const hugeFiniteSine = await runtime.call('math.sin', [1e308]);
  assert.ok(Number.isFinite(hugeFiniteSine), `finite angles must produce finite sine results, got ${hugeFiniteSine}`);
  assert.ok(Math.abs(hugeFiniteSine - Math.sin(1e308)) < 1e-8, `large-angle reduction error: expected ${Math.sin(1e308)}, got ${hugeFiniteSine}`);
  closeTo('lower_bound', 0.0);
  closeTo('upper_bound', 1.0);
  closeTo('inverted_clamp_lower', 0.0);
  closeTo('inverted_clamp_upper', 1.0);
  closeTo('midpoint', 3.0);
  closeTo('lerp_extreme_midpoint', 0.0);
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
  closeRelative('mapped_opposite_sign_extrapolation', -2.857142857142857);
  closeRelative('lerp_extreme_quarter', 5e307);
  closeRelative('lerp_extreme_extrapolation', -1.2e308);
  closeRelative('root_min_subnormal', Math.sqrt(Number.MIN_VALUE));
  closeRelative('root_min_normal', Math.sqrt(2.2250738585072014e-308));
  closeRelative('root_max_finite', Math.sqrt(Number.MAX_VALUE));
  closeTo('negative_root_min_subnormal', 0.0);
  closeTo('negative_root_max_finite', 0.0);
  closeTo('floor_negative', -3.0);
  closeTo('ceil_negative', -2.0);
  closeTo('rounded_positive', 3.0);
  closeTo('rounded_negative', -3.0);
  closeTo('floor_large_positive', 1e20);
  closeTo('ceil_large_negative', -1e20);
  closeTo('round_large_positive', 1e20);
  closeTo('round_int64_min', -9223372036854775808.0);
  closeTo('sign_negative', -1.0);
  closeTo('minimum', -3.0);
  closeTo('maximum', 2.0);
  closeTo('radians', Math.PI);
  closeTo('degrees', 180.0);
  closeTo('smooth_mid', 0.5);
  closeTo('smoother_mid', 0.5);
  closeTo('ease_out', 0.75);
  closeTo('ease_in_out', 0.5);
  closeTo('ease_clamped', 1.0);
  closeTo('ease_in_cubic', 0.125);
  closeTo('ease_out_cubic', 0.875);
  closeTo('ease_in_out_cubic_midpoint', 0.5);
  closeTo('mapped', 50.0);
  closeTo('mapped_extreme_midpoint', 0.5);
  closeTo('mapped_extreme_reversed_midpoint', 0.5);
  closeTo('smooth_extreme_midpoint', 0.5);
  closeTo('smoother_extreme_midpoint', 0.5);
  closeTo('mapped_degenerate', 7.0);
  closeTo('smooth_equal_edge_below', 0.0);
  closeTo('smooth_equal_edge_at', 1.0);
  closeTo('smoother_equal_edge_above', 1.0);
  closeTo('smoother_equal_edge_below', 0.0);
  closeTo('smoother_equal_edge_at', 1.0);
  closeTo('diagonal', 5.0);
  closeRelative('diagonal_large', 5e200);
  closeRelative('diagonal_small', 5e-200);
  assert.equal(runtime.get('distance_overflow_saturates'), true, 'finite coordinates whose true distance exceeds float range saturate at the largest finite float');
  closeTo('approached', 5.0);
  closeTo('approached_positive_overstep', 1.7e308);
  closeTo('approached_negative_overstep', -1.7e308);
  closeRelative('approached_positive_to_negative', -7e307);
  closeRelative('approached_negative_to_positive', 7e307);
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
    for (const name of ['sine', 'cosine', 'negative_sine', 'reduced_sine', 'huge_sine', 'lower_bound', 'upper_bound', 'inverted_clamp_lower', 'inverted_clamp_upper', 'midpoint', 'lerp_extreme_midpoint', 'lerp_extreme_quarter', 'lerp_extreme_extrapolation', 'absolute', 'negative_root', 'zero_root', 'root_two', 'root_tiny', 'root_min_subnormal', 'root_min_normal', 'root_max_finite', 'negative_root_min_subnormal', 'negative_root_max_finite', 'floor_negative', 'ceil_negative', 'rounded_positive', 'rounded_negative', 'sign_negative', 'minimum', 'maximum', 'radians', 'degrees', 'smooth_mid', 'smoother_mid', 'smooth_equal_edge_below', 'smooth_equal_edge_at', 'smoother_equal_edge_above', 'smoother_equal_edge_below', 'smoother_equal_edge_at', 'ease_out', 'ease_in_out', 'ease_clamped', 'ease_in_cubic', 'ease_out_cubic', 'ease_in_out_cubic_midpoint', 'mapped', 'mapped_extreme_midpoint', 'mapped_extreme_reversed_midpoint', 'mapped_opposite_sign_extrapolation', 'smooth_extreme_midpoint', 'smoother_extreme_midpoint', 'mapped_degenerate', 'diagonal', 'diagonal_large', 'diagonal_small', 'distance_overflow_saturates', 'approached', 'approached_positive_overstep', 'approached_negative_overstep', 'approached_positive_to_negative', 'approached_negative_to_positive', 'cubic_in_out']) {
      const expected = runtime.get(name);
      const tolerance = Math.max(Number.MIN_VALUE * 4, Math.abs(expected) * 1e-12);
      assert.ok(Math.abs(nativeGlobals[name] - expected) <= tolerance, `Browser/Native parity for ${name}: ${nativeGlobals[name]} vs ${expected} (tolerance ${tolerance})`);
    }
    assert.equal(nativeGlobals.distance_overflow_saturates, true, 'Native saturates overflowing finite-coordinate distance at the maximum finite float');
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

test('std/math remains importable with a namespace matching its internal trig prefix', async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-stdlib-math-alias-'));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  seedEmptyProject(projectRoot);
  const layout = projectLayout(projectRoot);
  const source = 'include "std/math.tds" as numeric\nfloat result = numeric.sin(1e308)\nscene main { wait 1 }\n';
  await fs.writeFile(path.join(layout.scenesRoot, 'main.tds'), source, 'utf8');
  const program = await compileProject(source, layout.assetsRoot, layout.scenesRoot, new Map(), new Map(), 'main.tds');
  const runtime = new Runtime({ command: async () => {} });
  await runtime.run(program);
  assert.ok(Math.abs(runtime.get('result') - Math.sin(1e308)) < 1e-15);
  const packageFile = path.join(layout.buildRoot, 'numeric-alias.nsp.json');
  const packaged = await pack(path.join(layout.scenesRoot, 'main.tds'), packageFile, { projectRoot });
  assert.ok(packaged.program.functions.some(fn => fn.name === 'numeric.sin'));
  const native = process.env.NOVEL_NATIVE_EXE || path.resolve(__dirname, '../native/build/Release/novel_player.exe');
  try {
    await fs.access(native);
    const result = spawnSync(native, [packageFile, '--headless'], { encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.ok(Math.abs(JSON.parse(result.stdout).globals.result - runtime.get('result')) < 1e-15);
  } catch (error) {
    if (error.code === 'ENOENT' && !process.env.NOVEL_NATIVE_EXE) t.skip('Native player is not built');
    else throw error;
  }
});

test('empty list intrinsics and dynamic empty text guards match Browser and Native', async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-stdlib-empty-contract-'));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  seedEmptyProject(projectRoot);
  const layout = projectLayout(projectRoot);
  const source = `global list[int] items = []
global int item_count = list.length(items)
global bool has_item = list.contains(items, 1)
scene main { wait 1 }
`;
  await fs.writeFile(path.join(layout.scenesRoot, 'main.tds'), source, 'utf8');
  const compiled = await compileProject(source, layout.assetsRoot, layout.scenesRoot, new Map(), new Map(), 'main.tds');
  const runtime = new Runtime({ command: async () => {} });
  await runtime.run(compiled);
  assert.equal(runtime.get('item_count'), 0n);
  assert.equal(runtime.get('has_item'), false);

  const packageFile = path.join(layout.buildRoot, 'empty-list.nsp.json');
  await pack(path.join(layout.scenesRoot, 'main.tds'), packageFile, { projectRoot });
  const native = process.env.NOVEL_NATIVE_EXE || path.resolve(__dirname, '../native/build/Release/novel_player.exe');
  try {
    await fs.access(native);
    const result = spawnSync(native, [packageFile, '--headless'], { encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    const globals = JSON.parse(result.stdout).globals;
    assert.equal(globals.item_count, 0);
    assert.equal(globals.has_item, false);
  } catch (error) {
    if (error.code === 'ENOENT' && !process.env.NOVEL_NATIVE_EXE) t.skip('Native player is not built; Browser runtime checks still ran');
    else throw error;
  }
});

test('dynamic empty split and replace arguments fail at runtime in Browser and Native', async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-stdlib-empty-text-'));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  seedEmptyProject(projectRoot);
  const layout = projectLayout(projectRoot);
  const native = process.env.NOVEL_NATIVE_EXE || path.resolve(__dirname, '../native/build/Release/novel_player.exe');

  for (const [label, expression, errorPattern, emptyExpression] of [
    ['split', 'text.split("x", separator)', /text\.split/, 'runtime.state.background.current()'],
    ['replace', 'text.replace("x", search, "y")', /text\.replace/, 'runtime.state.audio.current_bgm()'],
  ]) {
    const resultType = label === 'split' ? 'list[str]' : 'str';
    const source = `global str separator = ","
global str search = "x"
global ${resultType} result = ${label === 'split' ? '[]' : '""'}
scene main {
  set separator = ${emptyExpression}
  set search = ${emptyExpression}
  set result = ${expression}
  wait 1
}
`;
    await fs.writeFile(path.join(layout.scenesRoot, 'main.tds'), source, 'utf8');
    const compiled = await compileProject(source, layout.assetsRoot, layout.scenesRoot, new Map(), new Map(), 'main.tds');
    const runtime = new Runtime({ command: async () => {} });
    await assert.rejects(runtime.run(compiled), errorPattern, `Browser ${label} rejects the dynamic empty argument`);

    await pack(path.join(layout.scenesRoot, 'main.tds'), path.join(layout.buildRoot, `${label}.nsp.json`), { projectRoot });
    try {
      await fs.access(native);
      const result = spawnSync(native, [path.join(layout.buildRoot, `${label}.nsp.json`), '--headless'], { encoding: 'utf8', timeout: 15000 });
      assert.notEqual(result.status, 0, `Native ${label} rejects the dynamic empty argument`);
      assert.match(result.stderr, errorPattern);
    } catch (error) {
      if (error.code === 'ENOENT' && !process.env.NOVEL_NATIVE_EXE) t.skip('Native player is not built; Browser runtime checks still ran');
      else throw error;
    }
  }
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
    await fs.writeFile(path.join(layout.scenesRoot, 'helper.tds'), 'fn character() -> none {}');
    const script = await resolveProjectScript('include "std/math.tds" as math\nscene main { wait 1 }', layout.scenesRoot, new Set(), 'main.tds');
    assert.ok(script.functions.some((fn) => fn.name === 'math.sin'), 'the shipped module wins over a project-local file in the reserved std/ namespace');
    assert.equal(script.functions.some((fn) => fn.name === 'math.wrong'), false);
    await assert.rejects(
      resolveProjectScript('include "helper.tds" as helper\nscene main { wait 1 }', layout.scenesRoot, new Set(), 'main.tds'),
    );
    await assert.rejects(
      resolveProjectScript('include "std/../tools/project.js" as escape\nscene main { wait 1 }', layout.scenesRoot, new Set(), 'main.tds'),
      /\u4e0d\u6b63/,
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
float hop_extreme = motion.hop(1.7e308, 0.5)
float drift = motion.drift(5.0, 0.25, 2.0)
float shake_below_range = motion.shake(4.0, -0.5, 1.0)
float shake_above_range = motion.shake(4.0, 1.5, 1.0)
float breathing_above_range = motion.breathe(2.0, 1.5)
float hop_below_range = motion.hop(10.0, -0.5)
float hop_above_range = motion.hop(10.0, 1.5)
float shake_extreme_phase = motion.shake(1.0, 1e-308, 1.25e308)
float drift_extreme_phase = motion.drift(5.0, 1e-308, 1.25e308)
float shake_negative_extreme_phase = motion.shake(1.0, 1e-308, -1.25e308)
scene main { wait 1 }
`;
    await fs.writeFile(path.join(layout.scenesRoot, 'main.tds'), source, 'utf8');
    const compiled = await compileProject(source, layout.assetsRoot, layout.scenesRoot, new Map(), new Map(), 'main.tds');
    const runtime = new Runtime({ command: async () => {} });
    await runtime.run(compiled);
    const expected = {
      walk_x: 25, walk_start_x: 0, walk_end_x: 100,
      shake: 3, breathing: 2, hop: -10, hop_extreme: -1.7e308, drift: 0,
      shake_below_range: 0, shake_above_range: 0, breathing_above_range: 0,
      hop_below_range: 0, hop_above_range: 0,
      shake_extreme_phase: 1, drift_extreme_phase: 5, shake_negative_extreme_phase: -1,
    };
    for (const [name, value] of Object.entries(expected)) {
      assert.ok(Math.abs(runtime.get(name) - value) <= 1e-8, `${name}: expected ${value}, got ${runtime.get(name)}`);
    }
    const packageFile = path.join(layout.buildRoot, 'motion.nsp.json');
    await pack(path.join(layout.scenesRoot, 'main.tds'), packageFile, { projectRoot });
    const native = process.env.NOVEL_NATIVE_EXE || path.resolve(__dirname, '../native/build/Release/novel_player.exe');
    try {
      await fs.access(native);
      const result = spawnSync(native, [packageFile, '--headless'], { encoding: 'utf8', timeout: 15000 });
      assert.equal(result.status, 0, result.stderr || result.error?.message);
      const globals = JSON.parse(result.stdout).globals;
      for (const [name, value] of Object.entries(expected)) {
        assert.ok(Math.abs(globals[name] - value) <= 1e-8, `Native ${name}: expected ${value}, got ${globals[name]}`);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      t.diagnostic('Native motion parity skipped because the Native player has not been built');
    }
  } finally {
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
});

test('walk.character requires a statically proven visible character and guards runtime moves', async (t) => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-walk-presence-'));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  seedEmptyProject(projectRoot);
  const layout = projectLayout(projectRoot);
  const { scenesRoot, assetsRoot } = layout;
  const visible = `include "std/motion/walk.tds" as walk
character rei {
  name = "Rei"
  pose normal = "asset/char/rei.png"
}
scene main {
  show rei.normal center
  walk.character("rei", 72.0, 1, 1.0, 4.0)
  walk.character("rei", 72.0, 1, 1.0, -4.0)
}`;
  await fs.writeFile(path.join(scenesRoot, 'main.tds'), visible, 'utf8');
  await fs.writeFile(path.join(assetsRoot, 'char/rei.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNg+M/wHwAEAQH/cetH5QAAAABJRU5ErkJggg==', 'base64'));
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

  const visibleProgram = await compileProject(visible, assetsRoot, scenesRoot, new Map(), new Map(), 'main.tds');
  const visibleMoves = [];
  const visibleRuntime = new Runtime({ command: async (name, _args, _runtime, operation) => {
    if (name === 'move') visibleMoves.push(operation.move);
  } });
  await visibleRuntime.run(visibleProgram);
  assert.equal(visibleMoves.length, 16, 'each walk cycle emits eight timed move segments');
  assert.equal(visibleMoves.slice(0, 8).reduce((sum, move) => sum + move.durationMs, 0), 1000, 'positive-bob segments sum to the rounded requested duration');
  assert.equal(visibleMoves.slice(8).reduce((sum, move) => sum + move.durationMs, 0), 1000, 'negative-bob segments sum to the rounded requested duration');
  assert.ok(visibleMoves[0].delta.y > 0, 'positive bob starts by dipping downward');
  assert.ok(visibleMoves[8].delta.y < 0, 'negative bob reverses the vertical direction and starts upward');
  assert.ok(Math.abs(visibleMoves.slice(0, 8).reduce((sum, move) => sum + move.delta.x, 0) - 72) < 1e-8, 'positive-bob horizontal segments sum to the requested displacement');
  assert.ok(Math.abs(visibleMoves.slice(8).reduce((sum, move) => sum + move.delta.x, 0) - 72) < 1e-8, 'negative-bob horizontal segments sum to the requested displacement');
  assert.ok(Math.abs(visibleMoves.slice(0, 8).reduce((sum, move) => sum + move.delta.y, 0)) < 1e-8, 'positive bob returns to baseline');
  assert.ok(Math.abs(visibleMoves.slice(8).reduce((sum, move) => sum + move.delta.y, 0)) < 1e-8, 'negative bob returns to baseline');
  const beforeRoundedDurations = visibleMoves.length;
  await visibleRuntime.call('walk.character', ['rei', 0.0, 12501n, 0.00049, 0.0]);
  assert.equal(visibleMoves.length, beforeRoundedDurations, 'rounded-zero duration returns before the loop guard, even above the nominal cycle limit');
  await visibleRuntime.call('walk.character', ['rei', 0.0, 1n, 0.0005, 0.0]);
  assert.deepEqual(visibleMoves.slice(beforeRoundedDurations).map(move => move.durationMs), [1, 0, 0, 0, 0, 0, 0, 0], 'a 0.5 ms tie rounds away from zero and distributes the single millisecond');
  const beforeMaxSegments = visibleMoves.length;
  await visibleRuntime.call('walk.character', ['rei', 0.0, 1n, 17179869.176, 0.0]);
  assert.deepEqual(visibleMoves.slice(beforeMaxSegments).map(move => move.durationMs), Array(8).fill(2147483647), 'the exact per-segment maximum is accepted');
  const beforeMaxCycles = visibleMoves.length;
  await visibleRuntime.call('walk.character', ['rei', 0.0, 12500n, 0.001, 0.0]);
  const maxCycleMoves = visibleMoves.slice(beforeMaxCycles);
  assert.equal(maxCycleMoves.length, 100000, 'the documented maximum 12,500 cycles emits exactly 100,000 move steps');
  assert.equal(maxCycleMoves.reduce((sum, move) => sum + move.durationMs, 0), 1, 'the exact maximum cycle count preserves the rounded one-millisecond duration');
  await assert.rejects(
    visibleRuntime.call('walk.character', ['rei', 0.0, 1n, 17179869.177, 0.0]),
    /move command/,
    'one additional millisecond makes a distributed segment exceed the move limit',
  );
  await assert.rejects(visibleRuntime.call('walk.character', ['rei', 0.0, 1n, 1e16, 0.0]), 'seconds * 1000 above int64 is rejected before segment emission');
  await assert.rejects(visibleRuntime.call('walk.character', ['rei', 0.0, 1n, 1e308, 0.0]), 'seconds * 1000 float overflow is rejected before segment emission');
  await assert.rejects(
    visibleRuntime.call('walk.character', ['rei', 72.0, (1n << 63n) - 1n, 1.0, 4.0]),
    /\u7bc4\u56f2\u5916/,
    'cycles * 8 is checked signed-64-bit arithmetic before the loop guard can run',
  );
  await assert.rejects(
    visibleRuntime.call('walk.character', ['rei', 72.0, 1n, 20_000_000.0, 4.0]),
    /move command/,
    'each generated move segment must stay within the shared runtime duration limit',
  );

  const compiled = await compileProject(uncertain, assetsRoot, scenesRoot, new Map(), new Map(), 'main.tds');
  const moves = [];
  const runtime = new Runtime({ command: async (name, args) => { if (name === 'move') moves.push(args); } });
  await runtime.run(compiled);
  assert.equal(moves.length, 0, 'the function runtime guard skips movement when the character is absent');

  const packageFile = path.join(layout.buildRoot, 'walk.nsp.json');
  await pack(path.join(scenesRoot, 'main.tds'), packageFile, { projectRoot });
  const native = process.env.NOVEL_NATIVE_EXE || path.resolve(__dirname, '../native/build/Release/novel_player.exe');
  try {
    await fs.access(native);
    const result = spawnSync(native, [packageFile, '--headless'], { encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    const nativeMoves = JSON.parse(result.stdout).commands.filter(command => command.name === 'move');
    assert.equal(nativeMoves.length, 16, 'Native emits eight move segments for each positive- and negative-bob cycle');
    assert.deepEqual(nativeMoves.map(command => command.args.at(-1)), Array(16).fill(125), 'Native distributes each requested second evenly across the segments');
    const browserDeltas = visibleMoves.slice(0, 16).map(move => [move.delta.x, move.delta.y, move.durationMs]);
    const nativeDeltas = nativeMoves.map(command => [command.args[4], command.args[6], command.args.at(-1)]);
    for (let index = 0; index < browserDeltas.length; index += 1) {
      for (let component = 0; component < 3; component += 1) {
        assert.ok(Math.abs(browserDeltas[index][component] - nativeDeltas[index][component]) <= 1e-8,
          `Browser/Native walk segment ${index} component ${component}: ${browserDeltas[index][component]} vs ${nativeDeltas[index][component]}`);
      }
    }
    const sourceFile = path.join(scenesRoot, 'main.tds');
    const withoutNegativeBob = source => source.replace('  walk.character("rei", 72.0, 1, 1.0, -4.0)\n', '');
    const boundarySource = withoutNegativeBob(visible).replace('walk.character("rei", 72.0, 1, 1.0, 4.0)', `walk.character("rei", 0.0, 12501, 0.00049, 0.0)
  walk.character("rei", 0.0, 1, 0.0005, 0.0)
  walk.character("rei", 0.0, 1, 17179869.176, 0.0)`);
    await fs.writeFile(sourceFile, boundarySource, 'utf8');
    const boundaryPackage = path.join(layout.buildRoot, 'walk-boundary.nsp.json');
    await pack(sourceFile, boundaryPackage, { projectRoot });
    const boundaryResult = spawnSync(native, [boundaryPackage, '--headless'], { encoding: 'utf8', timeout: 15000 });
    assert.equal(boundaryResult.status, 0, boundaryResult.stderr || boundaryResult.error?.message);
    const boundaryMoves = JSON.parse(boundaryResult.stdout).commands.filter(command => command.name === 'move');
    assert.equal(boundaryMoves.length, 16, 'Native omits rounded-zero movement and emits the tie plus exact-maximum cycles');
    assert.deepEqual(boundaryMoves.slice(0, 8).map(command => command.args.at(-1)), [1, 0, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(boundaryMoves.slice(8).map(command => command.args.at(-1)), Array(8).fill(2147483647));

    const maxCyclesSource = withoutNegativeBob(visible).replace('walk.character("rei", 72.0, 1, 1.0, 4.0)', 'walk.character("rei", 0.0, 12500, 0.001, 0.0)');
    await fs.writeFile(sourceFile, maxCyclesSource, 'utf8');
    const maxCyclesPackage = path.join(layout.buildRoot, 'walk-max-cycles.nsp.json');
    await pack(sourceFile, maxCyclesPackage, { projectRoot });
    const maxCyclesResult = spawnSync(native, [maxCyclesPackage, '--headless'], {
      encoding: 'utf8', timeout: 45000, maxBuffer: 64 * 1024 * 1024,
    });
    assert.equal(maxCyclesResult.status, 0, maxCyclesResult.stderr || maxCyclesResult.error?.message);
    const nativeMaxCycleMoves = JSON.parse(maxCyclesResult.stdout).commands.filter(command => command.name === 'move');
    assert.equal(nativeMaxCycleMoves.length, 100000, 'Native accepts the documented 12,500-cycle boundary');
    assert.equal(nativeMaxCycleMoves.reduce((sum, command) => sum + command.args.at(-1), 0), 1, 'Native preserves the rounded one-millisecond duration at the cycle boundary');

    const overDurationSource = visible.replace('walk.character("rei", 72.0, 1, 1.0, 4.0)', 'walk.character("rei", 72.0, 1, 17179869.177, 4.0)');
    await fs.writeFile(sourceFile, overDurationSource, 'utf8');
    const overDurationPackage = path.join(layout.buildRoot, 'walk-over-duration.nsp.json');
    await pack(sourceFile, overDurationPackage, { projectRoot });
    const overDuration = spawnSync(native, [overDurationPackage, '--smoke'], {
      encoding: 'utf8', timeout: 15000,
      env: { ...process.env, SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy' },
    });
    assert.notEqual(overDuration.status, 0, 'Native rejects generated move segments above its per-command duration limit');
    assert.match(overDuration.stderr, /move command/);
    const overflowSource = visible.replace('walk.character("rei", 72.0, 1, 1.0, 4.0)', 'walk.character("rei", 72.0, 9223372036854775807, 1.0, 4.0)');
    await fs.writeFile(sourceFile, overflowSource, 'utf8');
    await assert.rejects(pack(sourceFile, path.join(layout.buildRoot, 'walk-overflow.nsp.json'), { projectRoot }), /64bit/,
      'the analyzer rejects a statically known cycles * 8 overflow before Native packaging');

    const dynamicOverflowSource = `include "std/motion/walk.tds" as walk
global int cycles = 1
character rei {
  name = "Rei"
  pose normal = "asset/char/rei.png"
}
fn run_walk(cycles: int) -> none { walk.character("rei", 72.0, cycles, 1.0, 4.0) }
scene main { show rei.normal left\nrun_walk(cycles) }`;
    await fs.writeFile(sourceFile, dynamicOverflowSource, 'utf8');
    const dynamicOverflowPackage = path.join(layout.buildRoot, 'walk-dynamic-overflow.nsp.json');
    const dynamicOverflowData = await pack(sourceFile, dynamicOverflowPackage, { projectRoot });
    const cyclesInitializer = dynamicOverflowData.program.globals.find(instruction => instruction.op === 'declare' && instruction.name === 'cycles')?.initial;
    assert.equal(cyclesInitializer?.kind, 'integer', 'the test package contains the dynamically loaded cycles global');
    cyclesInitializer.value = '9223372036854775807';
    await fs.writeFile(dynamicOverflowPackage, JSON.stringify(dynamicOverflowData, null, 2), 'utf8');
    const dynamicOverflow = spawnSync(native, [dynamicOverflowPackage, '--headless'], { encoding: 'utf8', timeout: 15000 });
    assert.notEqual(dynamicOverflow.status, 0, 'Native rejects runtime cycles * 8 overflow before emitting segments');
    assert.match(dynamicOverflow.stderr, /64\u30d3\u30c3\u30c8\u6574\u6570\u306e\u7bc4\u56f2/);

    for (const [name, seconds] of [['int64-overflow', '1e16'], ['float-overflow', '1e308']]) {
      const conversionSource = `include "std/motion/walk.tds" as walk
global float seconds = 1.0
character rei {
  name = "Rei"
  pose normal = "asset/char/rei.png"
}
fn run_walk(value: float) -> none { walk.character("rei", 0.0, 1, value, 0.0) }
scene main { show rei.normal left\nrun_walk(seconds) }`;
      await fs.writeFile(sourceFile, conversionSource, 'utf8');
      const conversionPackage = path.join(layout.buildRoot, `walk-${name}.nsp.json`);
      const conversionData = await pack(sourceFile, conversionPackage, { projectRoot });
      const secondsInitializer = conversionData.program.globals.find(instruction => instruction.op === 'declare' && instruction.name === 'seconds')?.initial;
      assert.equal(secondsInitializer?.kind, 'float');
      secondsInitializer.value = seconds;
      await fs.writeFile(conversionPackage, JSON.stringify(conversionData, null, 2), 'utf8');
      const conversionResult = spawnSync(native, [conversionPackage, '--headless'], { encoding: 'utf8', timeout: 15000 });
      assert.notEqual(conversionResult.status, 0, `Native rejects seconds * 1000 ${name} before emitting movement`);
    }
  } catch (error) {
    if (error.code === 'ENOENT' && !process.env.NOVEL_NATIVE_EXE) t.skip('Native player is not built; Browser walk movement checks still ran');
    else throw error;
  }
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
global list[str] split_empty_input = text.split("", ",")
global list[str] split_unicode_edges = text.split("😀終😀", "😀")
global list[str] split_overlapping_separator = text.split("aaaa", "aa")
global str replace_overlapping_match = text.replace("aaa", "aa", "X")
global str replace_with_search_text = text.replace("aba", "a", "aa")
global str join_empty_items = strings.join_words(["", "x", ""], "|")
global str normalized_data_space = text.normalize_space("a \tb\\n　c")
global str trimmed_data_space = text.trim("   edge　")
global str normalized_form_and_vertical_tabs = text.normalize_space("a\fb\vc")
global str trimmed_form_and_vertical_tabs = text.trim("\f\v edge \f\v")
global str preserved_other_unicode_space = text.normalize_space("a bE")
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
  assert.deepEqual(browser.get('split_empty_input'), ['']);
  assert.deepEqual(browser.get('split_unicode_edges'), ['', String.fromCodePoint(0x7d42), '']);
  assert.deepEqual(browser.get('split_overlapping_separator'), ['', '', '']);
  assert.equal(browser.get('replace_overlapping_match'), 'Xa', 'replace processes non-overlapping matches from left to right');
  assert.equal(browser.get('replace_with_search_text'), 'aabaa', 'replacement text is not searched again');
  assert.equal(browser.get('join_empty_items'), '|x|', 'join preserves empty elements at both ends');
  assert.equal(browser.get('normalized_data_space'), 'a b c');
  assert.equal(browser.get('trimmed_data_space'), 'edge');
  assert.equal(browser.get('normalized_form_and_vertical_tabs'), 'a b c');
  assert.equal(browser.get('trimmed_form_and_vertical_tabs'), 'edge');
  assert.equal(browser.get('preserved_other_unicode_space'), 'a bE', 'the documented whitespace set does not imply all Unicode White_Space characters');

  const longNeedleText = `${'hit,'.repeat(100000)}hit`;
  const longSearchSource = `include "std/collections.tds" as collections
global int first_match = collections.index_of_str(text.split("${longNeedleText}", ","), "hit")
scene main { wait 1 }
`;
  const exactScanText = `${'hit,'.repeat(99999)}hit`;
  const exactScanSource = `include "std/collections.tds" as collections
global int exact_scan = collections.index_of_str(text.split("${exactScanText}", ","), "missing")
scene main { wait 1 }
`;
  const longSearchFile = path.join(layout.scenesRoot, 'long-index.tds');
  const longSearchPackage = path.join(layout.buildRoot, 'long-index.nsp.json');
  await fs.writeFile(longSearchFile, longSearchSource, 'utf8');
  const longSearchProgram = await compileProject(longSearchSource, layout.assetsRoot, layout.scenesRoot, new Map(), new Map(), 'long-index.tds');
  const longSearchBrowser = new Runtime({ command: async () => {} });
  await longSearchBrowser.run(longSearchProgram);
  assert.equal(longSearchBrowser.get('first_match'), 0n, 'index_of_str stops at the first match instead of tripping the 100,000-iteration loop guard');
  await pack(longSearchFile, longSearchPackage, { projectRoot });
  const exactScanFile = path.join(layout.scenesRoot, 'long-index-exact.tds');
  const exactScanPackage = path.join(layout.buildRoot, 'long-index-exact.nsp.json');
  await fs.writeFile(exactScanFile, exactScanSource, 'utf8');
  const exactScanProgram = await compileProject(exactScanSource, layout.assetsRoot, layout.scenesRoot, new Map(), new Map(), 'long-index-exact.tds');
  const exactScanBrowser = new Runtime({ command: async () => {} });
  await exactScanBrowser.run(exactScanProgram);
  assert.equal(exactScanBrowser.get('exact_scan'), -1n, 'index_of_str completes a full 100,000-element miss at the exact loop limit');
  await pack(exactScanFile, exactScanPackage, { projectRoot });

  await assert.rejects(
    longSearchBrowser.call('collections.index_of_str', [Array(100001).fill('hit'), 'missing']),
    /loop の実行回数が上限の100,000回を超えました/,
    'a full scan reports the documented TDS loop limit instead of returning -1 after the iteration budget'
  );
  const longMissSource = `include "std/collections.tds" as collections\nglobal int missing_match = collections.index_of_str(text.split("${longNeedleText}", ","), "missing")\nscene main { wait 1 }\n`;
  const longMissFile = path.join(layout.scenesRoot, 'long-index-miss.tds');
  const longMissPackage = path.join(layout.buildRoot, 'long-index-miss.nsp.json');
  await fs.writeFile(longMissFile, longMissSource, 'utf8');
  await pack(longMissFile, longMissPackage, { projectRoot });

  const native = process.env.NOVEL_NATIVE_EXE || path.resolve(__dirname, '../native/build/Release/novel_player.exe');
  try {
    await fs.access(native);
    const result = spawnSync(native, [packageFile, '--headless'], { encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    const globals = JSON.parse(result.stdout).globals;
    assert.equal(BigInt(globals.and_index), browser.get('and_index'));
    assert.deepEqual(globals.words, browser.get('words'));
    assert.deepEqual(globals.existing_word, browser.get('existing_word'));
    assert.deepEqual(globals.appended_word, browser.get('appended_word'));
    assert.deepEqual(globals.removed_words, browser.get('removed_words'));
    assert.deepEqual(globals.no_words, []);
    assert.equal(globals.no_words_joined, browser.get('no_words_joined'));
    assert.deepEqual(globals.split_empty_input, ['']);
    assert.deepEqual(globals.split_unicode_edges, ['', String.fromCodePoint(0x7d42), '']);
    assert.deepEqual(globals.split_overlapping_separator, ['', '', '']);
    assert.equal(globals.replace_overlapping_match, 'Xa');
    assert.equal(globals.replace_with_search_text, 'aabaa');
    assert.equal(globals.join_empty_items, '|x|');
    assert.equal(globals.normalized_data_space, 'a b c');
    assert.equal(globals.trimmed_data_space, 'edge');
    assert.equal(globals.normalized_form_and_vertical_tabs, 'a b c');
    assert.equal(globals.trimmed_form_and_vertical_tabs, 'edge');
    assert.equal(globals.preserved_other_unicode_space, 'a bE');
    const longResult = spawnSync(native, [longSearchPackage, '--headless'], { encoding: 'utf8', timeout: 20000 });
    assert.equal(longResult.status, 0, longResult.stderr || longResult.error?.message);
    assert.equal(JSON.parse(longResult.stdout).globals.first_match, 0, 'Native index_of_str returns the early match in a list larger than the loop guard');
    const exactScanResult = spawnSync(native, [exactScanPackage, '--headless'], { encoding: 'utf8', timeout: 20000 });
    assert.equal(exactScanResult.status, 0, exactScanResult.stderr || exactScanResult.error?.message);
    assert.equal(JSON.parse(exactScanResult.stdout).globals.exact_scan, -1, 'Native index_of_str completes a 100,000-element miss at the exact loop limit');
    const longMissResult = spawnSync(native, [longMissPackage, '--headless'], { encoding: 'utf8', timeout: 20000 });
    assert.notEqual(longMissResult.status, 0, 'Native reports the same loop budget when index_of_str must scan beyond 100,000 entries');
    assert.match(longMissResult.stderr, /loop の実行回数が上限の100,000回を超えました/);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    t.diagnostic('Native parity skipped because the Native player has not been built');
  }
});
