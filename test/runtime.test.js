const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parse, compile, analyzeScript, sceneReachability } = require('../dist');
const { Runtime } = require('../Edit/runtime');
const { validate: validateEditorSource, compileSource: compileEditorSource } = require('../Edit/server');
const { pack, validateVariableFlow } = require('../tools/pack');
const { compileProject, resolveProjectScript } = require('../tools/project');
const program = source => JSON.parse(JSON.stringify(compile(parse(source))));
async function run(source, host = {}) {
  const rt = new Runtime({ command: async () => {}, choice: async () => 0, ...host });
  await rt.run(program(source)); return rt;
}

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

  const includeSource = 'include "missing-include.tds"\nscene start { wait 1 }';
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
  await assert.rejects(run('int x = 1\ngoto "next.tds"', { load: async () => program('str x = "a"') }), /型が一致/);
});
test('compiler rejects unknown commands, recursion in arguments and invalid pose paths', () => {
  assert.throws(() => program('nonsense'), /未知/);
  assert.throws(() => program('fn id(x: int) -> int { return x }\nfn f() -> int { return id(f()) }'), /再帰/);
  assert.throws(() => program('character hero {\nname = "Hero"\npose normal = "C:/outside.exe"\n}'), /パス|拡張子/);
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
  assert.equal(rt.sceneState.diagnostics.at(-1).code, 'slot-replaced');
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
  assert.equal(actions[2].status, 'running');
  assert.equal(actions[3].blocking, true);
  assert.equal(actions[3].status, 'complete');
  assert.equal(actions[3].endedAt, 0);
  rt.completeAction(actions[1].id);
  assert.equal(actions[1].status, 'complete');
  assert.equal(actions[1].endedAt, 0);
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
  assert.throws(() => program('str x = "global"\nfn f(flag: int) -> none {\nwhile flag == 0 {\nint x = 1\nset flag = 1\n}\nset x = x + "!"\n}'), /蝙九|int|str/);
  assert.doesNotThrow(() => program('str x = "global"\nfn f(flag: int) -> none {\nwhile flag == 0 {\nstr x = "local"\nset flag = 1\n}\nset x = x + "!"\n}'));
  assert.throws(() => program('int x = 0\nfn f(flag: int) -> none {\nwhile flag == 0 {\nconst int x = 1\nset flag = 1\n}\nset x = x + 1\n}'), /const|螟画峩/);
});
test('type flow tracks shadowing declarations across dynamic and fixed for loops', () => {
  assert.throws(() => program('str x = "global"\nfn f(stop: int) -> none {\nfor i from 0 to stop step 1 {\nint x = 1\n}\nset x = x + "!"\n}'), /蝙九|int|str/);
  assert.doesNotThrow(() => program('str x = "global"\nfn f(stop: int) -> none {\nfor i from 0 to stop step 1 {\nstr x = "local"\n}\nset x = x + "!"\n}'));
  assert.throws(() => program('int x = 0\nfn f(stop: int) -> none {\nfor i from 0 to stop step 1 {\nconst int x = 1\n}\nset x = x + 1\n}'), /const|螟画峩/);
  assert.throws(() => program('str x = "global"\nfn f() -> none {\nfor i from 0 to 1 step 1 {\nint x = 1\n}\nset x = x + "!"\n}'), /蝙九|int|str/);
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

test('flow validation follows include relations and keeps edge kinds', () => {
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
  assert.equal(report.ok, true);
  assert.deepEqual(report.path, ['main.tds', 'common.tds', 'ending.tds']);
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

test('scene reachability follows file-path gotos to the first included scene', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-file-goto-reachability-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, 'chapters'));
  await fs.writeFile(path.join(dir, 'chapters', 'chapter01.tds'), 'scene chapter01_s01 { goto chapter01_s02 }\nscene chapter01_s02 { goto "chapters\\\\chapter02.tds" }');
  await fs.writeFile(path.join(dir, 'chapters', 'chapter02.tds'), 'scene chapter02_s01 { wait 1 }');
  const script = await resolveProjectScript('include chapters/chapter01.tds\ninclude chapters/chapter02.tds\nscene main { goto "chapters/chapter01.tds" }', dir, new Set(), 'main.tds');
  const reachability = sceneReachability(script);
  assert.deepEqual([...reachability.reachableScenes].sort(), ['chapter01_s01', 'chapter01_s02', 'chapter02_s01', 'main']);
  assert.equal(reachability.externalGotos.size, 0);
  assert.equal(analyzeScript(script).some((item) => item.code === 'unreachable-scene'), false);

  const extensionless = await resolveProjectScript('include chapters/chapter01.tds\ninclude chapters/chapter02.tds\nscene main { goto "chapters/chapter01" }', dir, new Set(), 'main.tds');
  const extensionlessReachability = sceneReachability(extensionless);
  assert.deepEqual([...extensionlessReachability.reachableScenes].sort(), ['chapter01_s01', 'chapter01_s02', 'chapter02_s01', 'main']);
  assert.equal(extensionlessReachability.externalGotos.size, 0, 'file gotos without an extension resolve to .tds files');

  const multiSceneFile = await resolveProjectScript('include chapters/chapter01.tds\nscene main { goto "chapters/chapter01.tds" }', dir, new Set(), 'main.tds');
  const diagnostics = analyzeScript(multiSceneFile);
  assert.equal(diagnostics.filter((item) => item.code === 'unreachable-scene').length, 0);

  await fs.writeFile(path.join(dir, 'chapters', 'chapter01.tds'), 'scene chapter01_s01 { set route = "chapter"\ngoto "chapters/chapter02.tds" }');
  await fs.writeFile(path.join(dir, 'chapters', 'chapter02.tds'), 'scene chapter02_s01 { if route == "chapter" { goto selected } else { goto stale } }\nscene selected { wait 1 }\nscene stale { wait 1 }');
  const statefulFiles = await resolveProjectScript('global str route = "common"\ninclude chapters/chapter01.tds\ninclude chapters/chapter02.tds\nscene main { goto "chapters/chapter01.tds" }', dir, new Set(), 'main.tds');
  const statefulReachability = sceneReachability(statefulFiles);
  assert.equal(statefulReachability.reachableScenes.has('selected'), true, 'mutable state must survive a file-path goto');
  assert.equal(statefulReachability.reachableScenes.has('stale'), false);
});

test('include diagnostics retain the included source file', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-location-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'child.tds'), 'scene hidden {\n  wait 1\n}');
  const script = await resolveProjectScript('include child.tds\nscene start { wait 1 }', dir);
  const diagnostic = analyzeScript(script).find((item) => item.code === 'unreachable-scene' && /hidden/.test(item.message));
  assert.equal(diagnostic.file, 'child.tds');
  assert.equal(diagnostic.line, 1);
  const codes = analyzeScript(script).filter((item) => item.file === 'child.tds').map((item) => item.code);
  assert.deepEqual(codes, ['unreachable-scene']);
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
  await assert.rejects(compileProject('asset bg x = "missing.png"', assetsRoot, scenesRoot), /アセット/);
  await fs.writeFile(path.join(scenesRoot, 'broken-main.tds'), 'str text = str(later)\ngoto "broken-next.tds"');
  await fs.writeFile(path.join(scenesRoot, 'broken-next.tds'), 'global int later = 1');
  await assert.rejects(pack(path.join(scenesRoot, 'broken-main.tds'), path.join(dir, 'out/broken.json'), { scenesRoot, assetsRoot }), /初期化前.*later/);
  await fs.writeFile(path.join(scenesRoot, 'duplicate.tds'), 'global int route = 9');
  await assert.rejects(pack(path.join(scenesRoot, 'main.tds'), path.join(dir, 'out/duplicate.json'), { scenesRoot, assetsRoot }), /route.*既に宣言.*set/);
});

test('project packaging resolves Windows separators in include and goto paths', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-windows-path-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const scenesRoot = path.join(dir, 'scenes'), assetsRoot = path.join(dir, 'assets');
  await fs.mkdir(path.join(scenesRoot, 'first'), { recursive: true }); await fs.mkdir(assetsRoot);
  await fs.writeFile(path.join(scenesRoot, 'main.tds'), 'include "first\\\\common.tds"\ngoto "first\\\\next.tds"');
  await fs.writeFile(path.join(scenesRoot, 'first', 'common.tds'), 'wait 1');
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
  assert.equal(assignmentResetsThreshold.some((item) => item.code === 'constant-condition' && item.line === 2), false);
  const mayEscapeDiagnostics = analyzeScript(parse('set difficulty = difficulty + 1'), 'constraint-assignment.tds', constrainedGlobals);
  assert.ok(mayEscapeDiagnostics.some((item) => item.code === 'variable-constraint' && item.severity === 'warning'));
  const outsideDiagnostics = analyzeScript(parse('set difficulty = difficulty + 10'), 'constraint-assignment-outside.tds', constrainedGlobals);
  assert.ok(outsideDiagnostics.some((item) => item.code === 'variable-constraint' && item.severity === 'error'));
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

test('native and browser runtimes agree on nested interpolation side effects', async t => {
  const exe = process.env.NOVEL_NATIVE_EXE;
  if (!exe) return t.skip('Set NOVEL_NATIVE_EXE to the built native player');
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
  await fs.writeFile(file, JSON.stringify({ format: 'novel-script-package', version: 1, program: compiled }));
  const child = spawnSync(exe, [file, '--headless'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 0, child.stderr || child.error?.message);
  assert.equal(JSON.parse(child.stdout).globals.state, Number(browser.get('state')));
  assert.equal(browser.get('state'), 1n);
});
