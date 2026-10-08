const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parse, compile } = require('../dist');
const { Runtime } = require('../Edit/runtime');

function nativePackage(program) {
  const source = program.sourceFile || 'main.tds';
  return { format: 'novel-script-package', version: 1, source, program, files: { [source]: program }, native_ui: {} };
}

function makeCase(seed) {
  const start = 1 + (seed % 4);
  const branchA = 2 + ((seed * 3) % 7);
  const branchB = 1 + ((seed * 5) % 6);
  const flag = seed % 2;
  const threshold = 8 + (seed % 8);
  const step = 1 + (seed % 3);
  const stop = seed % 4;
  const selected = seed % (stop + 1);
  const markerStart = seed % 3;

  let value = flag === 1 ? branchA : branchB;
  let marker = markerStart;
  while (value < threshold) {
    value += step;
    marker += 1;
  }
  for (let i = 0; i <= stop; i += 1) {
    if (i === selected) value += i + 1;
    else value += 1;
  }
  const expected = BigInt(value + marker);
  const source = `
    int marker = ${markerStart}
    fn bump() -> none { set marker = marker + 1 }
    fn compute(flag: int) -> int {
      int value = ${start}
      if flag == 1 {
        set value = ${branchA}
      } else {
        set value = ${branchB}
      }
      while value < ${threshold} {
        set value = value + ${step}
        bump()
      }
      for i from 0 to ${stop} {
        if i == ${selected} {
          set value = value + i + 1
        } else {
          set value = value + 1
        }
      }
      return value + marker
    }
    int result = compute(${flag})
  `;
  return { source, expected };
}

test('compiler differential corpus preserves generated branch and loop semantics', async () => {
  for (let seed = 0; seed < 128; seed += 1) {
    const { source, expected } = makeCase(seed);
    const script = parse(source);
    const optimized = new Runtime();
    const raw = new Runtime();
    await optimized.run(compile(script));
    await raw.run(compile(script, new Map(), new Map(), true));
    assert.equal(optimized.get('result'), expected, `optimized seed ${seed}`);
    assert.equal(raw.get('result'), expected, `raw seed ${seed}`);
    assert.equal(optimized.get('result'), raw.get('result'), `optimized/raw mismatch at seed ${seed}`);
  }
});

test('optimizer preserves effectful for-bound order and goto iteration counts', async () => {
  const source = `
global int order = 0
global int visits = 0
global int observed = 0
fn start_bound() -> int {
  set order = order * 10 + 1
  return 0
}
fn stop_bound() -> int {
  set order = order * 10 + 2
  return 3
}
fn step_bound() -> int {
  set order = order * 10 + 3
  return 1
}
scene main {
  for i from start_bound() to stop_bound() step step_bound() {
    set visits = visits + 1
    if i == 1 { goto done }
  }
  set observed = -1
}
scene done { set observed = order * 10 + visits }
`;
  const script = parse(source);
  const execute = async debug => {
    const runtime = new Runtime();
    await runtime.run(compile(script, new Map(), new Map(), debug));
    return { order: runtime.get('order'), visits: runtime.get('visits'), observed: runtime.get('observed') };
  };

  const optimized = await execute(false);
  const raw = await execute(true);
  assert.deepEqual(optimized, { order: 123n, visits: 2n, observed: 1232n });
  assert.deepEqual(raw, optimized, 'for bounds run once in start/stop/step order, and goto exits after the second body execution');
});

test('range loops terminate consistently at signed 64-bit endpoints', async t => {
  const executable = process.env.NOVEL_NATIVE_EXE || path.resolve(__dirname, '../native/build/Release/novel_player.exe');
  try { await fs.access(executable); }
  catch { t.skip('Build the Native player or set NOVEL_NATIVE_EXE to enable Browser/Native differential checks'); return; }
  const boundaries = [
    ['9223372036854775807', '9223372036854775807', '1'],
    ['9223372036854775806', '9223372036854775807', '2'],
    ['-9223372036854775808', '-9223372036854775808', '-1'],
  ];
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-loop-int64-boundary-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const [index, [start, stop, step]] of boundaries.entries()) {
    const script = parse(`global int visits = 0\nscene main { for i from ${start} to ${stop} step ${step} { set visits = visits + 1 } }`);
    for (const debug of [false, true]) {
      const program = compile(script, new Map(), new Map(), debug);
      const browser = new Runtime();
      await browser.run(program);
      assert.equal(browser.get('visits'), 1n, `Browser ${debug ? 'raw' : 'optimized'} endpoint case ${index}`);
      const packagePath = path.join(dir, `${index}-${debug ? 'raw' : 'optimized'}.nsp.json`);
      await fs.writeFile(packagePath, JSON.stringify(nativePackage(JSON.parse(JSON.stringify(program)))));
      const native = spawnSync(executable, [packagePath, '--headless'], { encoding: 'utf8', timeout: 10000 });
      assert.equal(native.status, 0, native.stderr || native.error?.message);
      assert.equal(JSON.parse(native.stdout).globals.visits, 1, `Native ${debug ? 'raw' : 'optimized'} endpoint case ${index}`);
    }
  }
});

test('optimizer preserves effectful argument order and short-circuit calls', async () => {
  const source = `
int counter = 0
fn tick() -> int {
  set counter = counter + 1
  return counter
}
fn pair(left: int, right: int) -> int { return left * 10 + right }
int argument_order = pair(tick(), tick())
bool short_false = false and tick() == 99
bool short_true = true or tick() == 99
int final_order = pair(tick(), tick())
`;
  const script = parse(source);
  const run = async (debug) => {
    const runtime = new Runtime();
    await runtime.run(compile(script, new Map(), new Map(), debug));
    return Object.fromEntries(['counter', 'argument_order', 'short_false', 'short_true', 'final_order']
      .map((name) => [name, runtime.get(name)]));
  };
  const optimized = await run(false);
  const raw = await run(true);
  assert.deepEqual(optimized, raw);
  assert.deepEqual(optimized, {
    counter: 4n,
    argument_order: 12n,
    short_false: false,
    short_true: true,
    final_order: 34n,
  });
});

test('forEach iterates a snapshot when its source list is mutated across Browser/Native and optimization modes', async t => {
  const script = parse(`
global list[int] values = [1, 2, 3]
global list[int] seen = []
scene main {
  for item in values {
    set seen = list.append(seen, item)
    if item == 1 { set values[1] = 8 }
  }
}
`);
  const expected = { values: [1, 8, 3], seen: [1, 2, 3] };
  for (const debug of [false, true]) {
    const browser = new Runtime();
    await browser.run(compile(script, new Map(), new Map(), debug));
    assert.deepEqual({ values: browser.get('values').map(Number), seen: browser.get('seen').map(Number) }, expected,
      `Browser ${debug ? 'raw' : 'optimized'} keeps the evaluated iterable snapshot`);
  }

  const executable = process.env.NOVEL_NATIVE_EXE || path.resolve(__dirname, '../native/build/Release/novel_player.exe');
  try { await fs.access(executable); }
  catch { t.skip('Build the Native player or set NOVEL_NATIVE_EXE to enable Browser/Native differential checks'); return; }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-foreach-mutation-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const debug of [false, true]) {
    const packagePath = path.join(dir, `${debug ? 'raw' : 'optimized'}.nsp.json`);
    const program = compile(script, new Map(), new Map(), debug);
    await fs.writeFile(packagePath, JSON.stringify(nativePackage(JSON.parse(JSON.stringify(program)))));
    const native = spawnSync(executable, [packagePath, '--headless'], { encoding: 'utf8', timeout: 10000 });
    assert.equal(native.status, 0, native.stderr || native.error?.message);
    assert.deepEqual(JSON.parse(native.stdout).globals, expected,
      `Native ${debug ? 'raw' : 'optimized'} keeps the evaluated iterable snapshot`);
  }
});

test('optimizer invalidates global facts written by parallel command arguments', async () => {
  const script = parse(`
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
`);
  const run = async (debug) => {
    const runtime = new Runtime({ command: async () => {}, parallel: async () => {} });
    await runtime.run(compile(script, new Map(), new Map(), debug));
    return { zoom: runtime.get('zoom'), result: runtime.get('result') };
  };
  const optimized = await run(false);
  const raw = await run(true);
  assert.deepEqual(optimized, raw);
  assert.deepEqual(optimized, { zoom: 2, result: 2n });
});

test('optimizer preserves label-before-prompt effects in choices', async () => {
  const source = `
str template = "safe"
fn label() -> str {
  set template = "updated"
  return "option"
}
scene main {
  choice "{template}" { "{label()}" { } }
}
`;
  const script = parse(source);
  const execute = async debug => {
    let observed;
    const runtime = new Runtime({ choice: async (prompt, labels) => { observed = { prompt, labels }; return 0; } });
    await runtime.run(compile(script, new Map(), new Map(), debug));
    return { observed, template: runtime.get('template') };
  };
  const optimized = await execute(false);
  const raw = await execute(true);
  assert.deepEqual(optimized, raw);
  assert.deepEqual(optimized, { observed: { prompt: 'updated', labels: ['option'] }, template: 'updated' });
});

test('optimizer reevaluates later elif conditions after earlier condition side effects', async () => {
  const source = `
int value = 0
int result = 0
fn mutate() -> bool {
  set value = 1
  return false
}
scene main {
  set value = 0
  if false {
    set result = 1
  } elif mutate() {
    set result = 2
  } elif value == 1 {
    set result = 3
  } else {
    set result = 4
  }
}
`;
  const script = parse(source);
  const execute = async debug => {
    const runtime = new Runtime();
    await runtime.run(compile(script, new Map(), new Map(), debug));
    return { value: runtime.get('value'), result: runtime.get('result') };
  };
  assert.deepEqual(await execute(false), { value: 1n, result: 3n });
  assert.deepEqual(await execute(true), { value: 1n, result: 3n });
});

test('optimizer preserves value-before-index evaluation and invalidates index-call effects', async () => {
  const source = `
int value = 0
int result = 0
dict[int] data = {"key": 0}
fn mutate_key() -> str {
  set value = 2
  return "key"
}
scene main {
  set value = 1
  set data[mutate_key()] = value
  if value == 2 {
    set result = data["key"]
  }
}
`;
  const script = parse(source);
  const execute = async debug => {
    const runtime = new Runtime();
    await runtime.run(compile(script, new Map(), new Map(), debug));
    return { value: runtime.get('value'), result: runtime.get('result'), data: { ...runtime.get('data') } };
  };
  const expected = { value: 2n, result: 1n, data: { key: 1n } };
  assert.deepEqual(await execute(false), expected);
  assert.deepEqual(await execute(true), expected);
});

test('nested dictionary assignment keeps RHS-before-key effects across Browser/Native and optimizer modes', async t => {
  const source = `
dict[int] data = {"key": 1}
int order = 0
fn rhs() -> int {
  set data = {"key": 10}
  set order = order * 10 + 1
  return 7
}
fn key() -> str {
  set order = order * 10 + 2
  return "key"
}
scene main {
  set data[key()] = rhs()
}
`;
  const script = parse(source);
  const expected = { data: { key: 7n }, order: 12n };
  for (const debug of [false, true]) {
    const runtime = new Runtime();
    await runtime.run(compile(script, new Map(), new Map(), debug));
    assert.deepEqual({ data: { ...runtime.get('data') }, order: runtime.get('order') }, expected,
      `Browser ${debug ? 'raw' : 'optimized'} preserves RHS-before-key and resolves the replaced dictionary`);
  }

  const executable = process.env.NOVEL_NATIVE_EXE || path.resolve(__dirname, '../native/build/Release/novel_player.exe');
  try { await fs.access(executable); }
  catch { t.skip('Build the Native player or set NOVEL_NATIVE_EXE to enable Browser/Native differential checks'); return; }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-compiler-effect-parity-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const debug of [false, true]) {
    const packagePath = path.join(dir, `${debug ? 'raw' : 'optimized'}.nsp.json`);
    const data = nativePackage(JSON.parse(JSON.stringify(compile(script, new Map(), new Map(), debug))));
    await fs.writeFile(packagePath, JSON.stringify(data));
    const result = spawnSync(executable, [packagePath, '--headless'], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.deepEqual(JSON.parse(result.stdout).globals, { data: { key: 7 }, order: 12 },
      `Native ${debug ? 'raw' : 'optimized'} preserves RHS-before-key and resolves the replaced dictionary`);
  }
});

test('list indexed assignment keeps RHS-before-index effects across Browser/Native and optimizer modes', async t => {
  const script = parse(`
list[int] values = [1, 2, 3]
int order = 0
fn rhs() -> int {
  set values = [10, 20, 30]
  set order = order * 10 + 1
  return 7
}
fn index() -> int {
  set values = [40, 50, 60]
  set order = order * 10 + 2
  return 1
}
scene main {
  set values[index()] = rhs()
}
`);
  const expected = { values: [40n, 7n, 60n], order: 12n };
  for (const debug of [false, true]) {
    const runtime = new Runtime();
    await runtime.run(compile(script, new Map(), new Map(), debug));
    assert.deepEqual({ values: runtime.get('values'), order: runtime.get('order') }, expected,
      `Browser ${debug ? 'raw' : 'optimized'} evaluates RHS before the mutating list index expression`);
  }

  const executable = process.env.NOVEL_NATIVE_EXE || path.resolve(__dirname, '../native/build/Release/novel_player.exe');
  try { await fs.access(executable); }
  catch { t.skip('Build the Native player or set NOVEL_NATIVE_EXE to enable Browser/Native differential checks'); return; }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-list-index-effect-parity-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const debug of [false, true]) {
    const packagePath = path.join(dir, `${debug ? 'raw' : 'optimized'}.nsp.json`);
    const data = nativePackage(JSON.parse(JSON.stringify(compile(script, new Map(), new Map(), debug))));
    await fs.writeFile(packagePath, JSON.stringify(data));
    const result = spawnSync(executable, [packagePath, '--headless'], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.deepEqual(JSON.parse(result.stdout).globals, { values: [40, 7, 60], order: 12 },
      `Native ${debug ? 'raw' : 'optimized'} evaluates RHS before the mutating list index expression`);
  }
});

test('list.append snapshots its first argument before later argument side effects across runtimes', async t => {
  const script = parse(`
list[int] values = [1]
list[int] result = []
fn replace_values() -> int {
  set values = [9]
  return 2
}
scene main {
  set result = list.append(values, replace_values())
}
`);
  const expected = { values: [9n], result: [1n, 2n] };
  for (const debug of [false, true]) {
    const runtime = new Runtime();
    await runtime.run(compile(script, new Map(), new Map(), debug));
    assert.deepEqual({ values: runtime.get('values'), result: runtime.get('result') }, expected,
      `Browser ${debug ? 'raw' : 'optimized'} evaluates list.append arguments from left to right`);
  }

  const executable = process.env.NOVEL_NATIVE_EXE || path.resolve(__dirname, '../native/build/Release/novel_player.exe');
  try { await fs.access(executable); }
  catch { t.skip('Build the Native player or set NOVEL_NATIVE_EXE to enable Browser/Native differential checks'); return; }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-list-effect-parity-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const debug of [false, true]) {
    const packagePath = path.join(dir, `${debug ? 'raw' : 'optimized'}.nsp.json`);
    const data = nativePackage(JSON.parse(JSON.stringify(compile(script, new Map(), new Map(), debug))));
    await fs.writeFile(packagePath, JSON.stringify(data));
    const result = spawnSync(executable, [packagePath, '--headless'], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.deepEqual(JSON.parse(result.stdout).globals, { values: [9], result: [1, 2] },
      `Native ${debug ? 'raw' : 'optimized'} evaluates list.append arguments from left to right`);
  }
});

test('execution source line returns to the caller after a user function call across runtimes', async t => {
  const script = parse(`
global int observed = 0
global str observed_file = ""
fn helper() -> int {
  return 1
}
scene main {
  set observed = helper() + runtime.state.execution.current_line()
  set observed_file = runtime.state.execution.current_file()
}
`);
  const locatedProgram = debug => {
    const program = compile(script, new Map(), new Map(), debug);
    program.sourceFile = 'main.tds';
    for (const instruction of program.functions[0].body) {
      instruction.file = 'library.tds';
      instruction.line = 37;
    }
    program.scenes[0].instructions.forEach((instruction, index) => {
      instruction.file = 'main.tds';
      instruction.line = index === 0 ? 10 : 11;
    });
    return program;
  };
  for (const debug of [false, true]) {
    const runtime = new Runtime();
    await runtime.run(locatedProgram(debug));
    assert.equal(runtime.get('observed'), 11n, `Browser ${debug ? 'raw' : 'optimized'} restores the caller line`);
    assert.equal(runtime.get('observed_file'), 'main.tds', `Browser ${debug ? 'raw' : 'optimized'} restores the caller file`);
  }

  const executable = process.env.NOVEL_NATIVE_EXE || path.resolve(__dirname, '../native/build/Release/novel_player.exe');
  try { await fs.access(executable); }
  catch { t.skip('Build the Native player or set NOVEL_NATIVE_EXE to enable Browser/Native differential checks'); return; }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-caller-source-parity-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const debug of [false, true]) {
    const packagePath = path.join(dir, `${debug ? 'raw' : 'optimized'}.nsp.json`);
    const data = nativePackage(JSON.parse(JSON.stringify(locatedProgram(debug))));
    await fs.writeFile(packagePath, JSON.stringify(data));
    const result = spawnSync(executable, [packagePath, '--headless'], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.deepEqual(JSON.parse(result.stdout).globals, { observed: 11, observed_file: 'main.tds' },
      `Native ${debug ? 'raw' : 'optimized'} restores the caller line`);
  }
});

test('constant-folded function return preserves source lines across Browser and Native', async t => {
  const script = parse(`const int base = 40
global int observed = 0
fn helper() -> int {
  return base + 2
}
scene main {
  set observed = helper() + runtime.state.execution.current_line()
}`);
  assert.deepEqual([script.functions[0].body[0].line, script.functions[0].body[0].value.line], [4, 4]);
  const makeProgram = debug => {
    const program = compile(script, new Map(), new Map(), debug);
    program.sourceFile = 'main.tds';
    program.functions.forEach(fn => fn.body.forEach(instruction => { instruction.file = 'main.tds'; }));
    program.scenes.forEach(scene => {
      scene.file = 'main.tds';
      scene.instructions.forEach(instruction => { instruction.file = 'main.tds'; });
    });
    return program;
  };
  const optimized = makeProgram(false);
  const raw = makeProgram(true);
  assert.deepEqual([optimized.functions[0].body[0].line, optimized.functions[0].body[0].value], [4, { kind: 'integer', value: '42' }]);
  assert.deepEqual([raw.functions[0].body[0].line, raw.functions[0].body[0].value.kind], [4, 'binary']);
  assert.equal(optimized.scenes[0].instructions[0].line, 7);

  const executable = process.env.NOVEL_NATIVE_EXE || path.resolve(__dirname, '../native/build/Release/novel_player.exe');
  try { await fs.access(executable); }
  catch { t.skip('Build the Native player or set NOVEL_NATIVE_EXE to enable Browser/Native differential checks'); return; }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-folded-location-parity-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const debug of [false, true]) {
    const program = debug ? raw : optimized;
    const expected = { base: 40, observed: 49 };
    const browser = new Runtime();
    await browser.run(program);
    assert.deepEqual({ base: Number(browser.get('base')), observed: Number(browser.get('observed')) }, expected,
      `Browser ${debug ? 'raw' : 'optimized'} returns to caller line 7 after helper line 4`);

    const packagePath = path.join(dir, `${debug ? 'raw' : 'optimized'}.nsp.json`);
    await fs.writeFile(packagePath, JSON.stringify(nativePackage(JSON.parse(JSON.stringify(program)))));
    const native = spawnSync(executable, [packagePath, '--headless'], { encoding: 'utf8', timeout: 10000 });
    assert.equal(native.status, 0, native.stderr || native.error?.message);
    assert.deepEqual(JSON.parse(native.stdout).globals, expected,
      `Native ${debug ? 'raw' : 'optimized'} returns to caller line 7 after helper line 4`);
  }
});

test('seeded expression effects preserve optimizer and Browser/Native evaluation order', async t => {
  const executable = process.env.NOVEL_NATIVE_EXE || path.resolve(__dirname, '../native/build/Release/novel_player.exe');
  try { await fs.access(executable); }
  catch { t.skip('Build the Native player or set NOVEL_NATIVE_EXE to enable Browser/Native differential checks'); return; }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-expression-order-seeds-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const templates = [
    `set result = combine(value, tick_a(), value)`,
    `set result = value + tick_a() * (value + tick_b())`,
    `set result = combine(tick_a(), combine(value, tick_b(), value), tick_a())`,
    `set result = values[tick_index()] + value`,
    `set values[tick_index()] = value + tick_a()`,
    `set result = list.length(list.append(values, tick_a())) + value`,
    `if list.contains(values, tick_a()) { set result = 1 } else { set result = 2 }`,
    `set values = list.remove_all(values, tick_a())\nset result = list.length(values)`,
  ];
  const toJsonValue = value => typeof value === 'bigint' ? Number(value)
    : Array.isArray(value) ? value.map(toJsonValue)
      : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toJsonValue(item)]))
        : value;

  for (let seed = 0; seed < 24; seed += 1) {
    const initial = 1 + (seed % 7);
    const source = `
global int value = ${initial}
global int result = 0
global list[int] values = [${initial}, ${initial + 1}, ${initial + 2}]
fn tick_a() -> int {
  set value = value + 1
  return value
}
fn tick_b() -> int {
  set value = value + 2
  return value
}
fn tick_index() -> int {
  set value = value + 1
  return ${seed % 3}
}
fn combine(a: int, b: int, c: int) -> int { return a * 100 + b * 10 + c }
scene main {
  ${templates[seed % templates.length]}
}
`;
    const script = parse(source);
    let optimizedGlobals;
    for (const debug of [false, true]) {
      const program = compile(script, new Map(), new Map(), debug);
      const browser = new Runtime();
      await browser.run(program);
      const browserGlobals = Object.fromEntries(['value', 'result', 'values'].map(name => [name, browser.get(name)]));
      if (!debug) optimizedGlobals = browserGlobals;
      else assert.deepEqual(browserGlobals, optimizedGlobals, `Browser optimized/raw mismatch at seed ${seed}`);

      const packagePath = path.join(dir, `seed-${seed}-${debug ? 'raw' : 'optimized'}.nsp.json`);
      await fs.writeFile(packagePath, JSON.stringify(nativePackage(program)));
      const native = spawnSync(executable, [packagePath, '--headless'], { encoding: 'utf8', timeout: 10000 });
      assert.equal(native.status, 0, native.stderr || native.error?.message || `Native seed ${seed}`);
      const nativeGlobals = JSON.parse(native.stdout).globals;
      assert.deepEqual(nativeGlobals, toJsonValue(browserGlobals), `Native/Browser ${debug ? 'raw' : 'optimized'} mismatch at seed ${seed}`);
    }
  }
});
