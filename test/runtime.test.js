const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parse, compile, analyzeScript, sceneReachability } = require('../dist');
const { Runtime } = require('../Edit/runtime');
const { pack } = require('../tools/pack');
const { compileProject, resolveProjectScript } = require('../tools/project');
const program = source => JSON.parse(JSON.stringify(compile(parse(source))));
async function run(source, host = {}) {
  const rt = new Runtime({ command: async () => {}, choice: async () => 0, ...host });
  await rt.run(program(source)); return rt;
}
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
test('runtime rejects malformed conversions, inherited dictionary keys and missing returns', async () => {
  await assert.rejects(run('int a = int("12abc")'), /変換/);
  await assert.rejects(run('dict[int] d = {"a": 1}\nint x = d["toString"]'), /辞書キー/);
  await assert.rejects(run('fn f() -> int {\n}\nint x = f()'), /値を返し/);
  await assert.rejects(run('for i from 0 to 2 step -1 {\n}'), /step/);
});
test('dictionary interpolation uses the same JSON representation as the native runtime', async () => {
  const rt = await run('dict[int] values = { "one": 1 }');
  assert.equal(rt.text('{values}'), '{"one":1}');
});
test('character fields persist as runtime state and support dotted interpolation', async () => {
  const rt = await run(`
    character ayase {
      name = "綾瀬"
      affection = 0
      pose smile = "assets/char/ayase/smile.png"
    }
    set ayase.affection = ayase.affection + 2
  `);
  assert.deepEqual({ ...rt.get('ayase') }, { name: '綾瀬', affection: 2n });
  assert.equal(rt.text('{ayase.name}: {ayase.affection}'), '綾瀬: 2');
});
test('choice errors reject the run and restore scope', async () => {
  const rt = new Runtime({ choice: async () => 0 });
  await assert.rejects(rt.run(program('choice {\n"bad" {\nint x = 1 / 0\n}\n}')), /除算/);
  assert.equal(rt.frames.length, 1);
});
test('file transfers work without scene declarations and preserve global state', async () => {
  const visited = [];
  const rt = await run('int x = 4\ngoto "next.tds"\nset x = 99', {
    load: async name => { visited.push(name); return program('int x = 0\nset x = x + 1'); }
  });
  assert.deepEqual(visited, ['next.tds']); assert.equal(rt.get('x'), 5n);
  await assert.rejects(run('int x = 1\ngoto "next.tds"', { load: async () => program('str x = "a"') }), /型が一致/);
});
test('compiler rejects unknown commands, recursion in arguments and invalid pose paths', () => {
  assert.throws(() => program('nonsense'), /未知/);
  assert.throws(() => program('fn id(x: int) -> int { return x }\nfn f() -> int { return id(f()) }'), /再帰/);
  assert.throws(() => program('character hero {\nname = "Hero"\npose normal = "C:/outside.exe"\n}'), /パス|拡張子/);
  assert.throws(() => program('clear char'), /引数/);
});

test('runtime rejects writes to const variables', async () => {
  await assert.rejects(run('const int answer = 1\nset answer = 2'), /const.*変更できません/);
  await assert.rejects(run('const dict[int] stats = { "hp": 10 }\nset stats["hp"] = 1'), /const.*変更できません/);
});
test('metadata binds identical names to their own scopes', () => {
  const p = program('int x = 1\nfn f(x: int) -> int { return x }\nscene main { say narrator str(x) }');
  const [global, param] = p.variables;
  assert.deepEqual(global.references.map(r => r.container), ['main']);
  assert.deepEqual(param.references.map(r => r.container), ['f']);
});
test('flow validation rejects disconnected files and accepts local bindings', () => {
  const { validateGraph, collectSyntaxDiagnostics } = require('../Edit/server');
  const syntaxErrors = collectSyntaxDiagnostics('say narrator "unterminated\nwait (\nsay narrator "valid"', 'broken.tds');
  assert.deepEqual(syntaxErrors.map((item) => item.line), [1, 2]);
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

test('scene graph reachability excludes outgoing gotos from dead code and dead scenes', () => {
  const afterTransfer = sceneReachability(parse('scene start { goto live\n goto dead.tds }\nscene live { wait 1 }'));
  assert.equal(afterTransfer.externalGotos.has('dead.tds'), false);
  const deadScene = sceneReachability(parse('scene start { wait 1 }\nscene unused { goto dead.tds }'));
  assert.equal(deadScene.externalGotos.has('dead.tds'), false);
  const falseLoop = sceneReachability(parse('scene start { while 1 == 2 { goto dead.tds } }'));
  assert.equal(falseLoop.externalGotos.has('dead.tds'), false);
});

test('include diagnostics retain the included source file', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-location-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'child.tds'), 'scene hidden {\n  wait 1\n}');
  const script = await resolveProjectScript('include child.tds\nscene start { wait 1 }', dir);
  const diagnostic = analyzeScript(script).find((item) => item.code === 'unreachable-scene' && /hidden/.test(item.message));
  assert.equal(diagnostic.file, 'child.tds');
  assert.equal(diagnostic.line, 1);
});
test('package includes external scenes, validates assets and remains JSON serializable', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-regression-'));
  // Remove only this test-owned, resolved temporary directory.
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const scenesRoot = path.join(dir, 'scenes'), assetsRoot = path.join(dir, 'assets');
  await fs.mkdir(scenesRoot); await fs.mkdir(assetsRoot);
  await fs.writeFile(path.join(assetsRoot, 'hero.png'), 'placeholder');
  await fs.writeFile(path.join(scenesRoot, 'main.tds'), 'character hero {\nname = "Hero"\npose normal = "assets/hero.png"\n}\nint route = 7\ngoto "next.tds"');
  await fs.writeFile(path.join(scenesRoot, 'next.tds'), 'show hero.normal center\nsay narrator str(route)\nint a = 9007199254740993');
  await fs.writeFile(path.join(scenesRoot, 'unused.tds'), 'say narrator "compiled even when unreachable"');
  const data = await pack(path.join(scenesRoot, 'main.tds'), path.join(dir, 'out/game.json'), { scenesRoot, assetsRoot });
  assert.ok(data.files['unused.tds']);
  assert.equal(data.files['next.tds'].characters.find((character) => character.name === 'hero').poses[0].path, 'assets/hero.png');
  assert.equal(data.files['next.tds'].globals.find((entry) => entry.name === 'a').initial.value, '9007199254740993');
  assert.equal(data.files['next.tds'].globals.find((entry) => entry.name === 'say').args[1].name, 'str');
  await assert.rejects(compileProject('asset bg x = "missing.png"', assetsRoot, scenesRoot), /アセット/);
  await fs.writeFile(path.join(scenesRoot, 'broken-main.tds'), 'str text = str(later)\ngoto "broken-next.tds"');
  await fs.writeFile(path.join(scenesRoot, 'broken-next.tds'), 'int later = 1');
  await assert.rejects(pack(path.join(scenesRoot, 'broken-main.tds'), path.join(dir, 'out/broken.json'), { scenesRoot, assetsRoot }), /初期化前.*later/);
  await fs.writeFile(path.join(scenesRoot, 'duplicate.tds'), 'int route = 9');
  await assert.rejects(pack(path.join(scenesRoot, 'main.tds'), path.join(dir, 'out/duplicate.json'), { scenesRoot, assetsRoot }), /route.*既に宣言.*set/);
});
test('native and browser runtimes agree on functions, loops, choice and scene transitions', async t => {
  const exe = process.env.NOVEL_NATIVE_EXE;
  if (!exe) return t.skip('Set NOVEL_NATIVE_EXE to the built native player');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-native-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'test.nsp.json');
  await fs.writeFile(file, JSON.stringify({ format: 'novel-script-package', version: 1, program: program(scenario) }));
  const child = spawnSync(exe, [file, '--headless'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 0, child.stderr || child.error?.message);
  const actual = JSON.parse(child.stdout);
  assert.equal(actual.globals.result, (await run(scenario)).get('result'));
  const numeric = program('int large = 9007199254740992 + 1\nstr result = str(large)\nstr minimum = str(-9223372036854775808)');
  await fs.writeFile(file, JSON.stringify({ format: 'novel-script-package', version: 1, program: numeric }));
  const exact = spawnSync(exe, [file, '--headless'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(exact.status, 0, exact.stderr);
  assert.equal(JSON.parse(exact.stdout).globals.result, '9007199254740993');
  assert.equal(JSON.parse(exact.stdout).globals.minimum, '-9223372036854775808');
  await fs.writeFile(file, JSON.stringify({ format: 'novel-script-package', version: 99, program: numeric }));
  assert.equal(spawnSync(exe, [file, '--headless'], { timeout: 10000 }).status, 1);
});
