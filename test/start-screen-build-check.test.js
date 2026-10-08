'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const checkStartScreen = require('../Edit/start-screen-build-check');
const { resolveProjectScript } = require('../tools/project');
const { projectLayout, seedEmptyProject } = require('../tools/project-layout');
const { pack } = require('../tools/pack');

test('build control-flow check follows local and external scene transitions', () => {
  const sources = new Map([
    ['main.tds', 'scene main {\n  goto "chapter/next.tds"\n}'],
    ['chapter/next.tds', 'scene next {\n  start()\n  say narrator "ready"\n}'],
  ]);
  assert.deepEqual(checkStartScreen(sources, 'main.tds'), []);
});

test('a called external scene can open the screen after dialogue before ending', () => {
  const sources = new Map([
    ['main.tds', 'scene main {\n  goto "chapter/next.tds"\n}'],
    ['chapter/next.tds', 'scene next {\n  say narrator "ready"\n  start()\n}'],
  ]);
  assert.deepEqual(checkStartScreen(sources, 'main.tds'), []);
});

test('build control-flow check reports paths that can end before start()', () => {
  const source = 'scene main {\n  if should_start {\n    start()\n  }\n  say narrator "may finish"\n}';
  const [diagnostic] = checkStartScreen(new Map([['main.tds', source]]), 'main.tds');
  assert.equal(diagnostic.code, 'start-screen-not-returned');
  assert.equal(diagnostic.severity, 'warning');
  assert.equal(diagnostic.buildBlocking, true);
  assert.equal(diagnostic.file, 'main.tds');
  assert.equal(diagnostic.line, 6);
});

test('build control-flow check recognizes statically true start branches', () => {
  const source = 'scene main {\n  if true {\n    start()\n  }\n  say narrator "ready"\n}';
  assert.deepEqual(checkStartScreen(new Map([['main.tds', source]]), 'main.tds'), []);
});

test('build control-flow check recognizes an included function that calls start()', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-start-screen-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'helper.tds'), 'fn open() -> none {\n  start()\n}\n', 'utf8');
  const source = 'include "helper.tds" as helper\nscene main {\n  helper.open()\n}';
  const resolved = await resolveProjectScript(source, root, new Set(), 'main.tds');
  const result = checkStartScreen(
    new Map([['main.tds', source]]), 'main.tds',
    new Map([['main.tds', resolved.functions]]),
  );
  assert.deepEqual(result, []);
});

test('unreachable start calls inside a function do not add a screen to graph metadata', () => {
  for (const body of [
    'if false { start() }',
    'for i from 1 to 0 { start() }',
    'choice "Wait?" { "A" { while true { wait 1 } } "B" { while true { wait 1 } } } start()',
    'while true { wait 1 } start()',
  ]) {
    const source = `fn open() -> none { ${body} }\nscene main { open() }`;
    const metadata = {};
    checkStartScreen(new Map([['main.tds', source]]), 'main.tds', new Map(), metadata);
    assert.equal(metadata.usesStart, false, body);
  }
});

test('build control-flow check does not treat start after a possible function return as guaranteed', () => {
  const source = `fn maybe_open(flag: bool) -> none {
  if flag {
    return
  }
  start()
}
scene main {
  maybe_open(true)
  say narrator "can finish without opening the screen"
}`;
  const [diagnostic] = checkStartScreen(new Map([['main.tds', source]]), 'main.tds');
  assert.equal(diagnostic?.code, 'start-screen-not-returned');
});

test('build control-flow check ignores returns in statically unreachable branches', () => {
  const source = `fn open() -> none {
  if false {
    return
  }
  start()
}
scene main {
  open()
}`;
  assert.deepEqual(checkStartScreen(new Map([['main.tds', source]]), 'main.tds'), []);
});

test('build control-flow check carries guaranteed loop starts through function calls', () => {
  const source = `fn open() -> none {
  for i from 1 to 1 {
    start()
  }
}
scene main {
  open()
}`;
  assert.deepEqual(checkStartScreen(new Map([['main.tds', source]]), 'main.tds'), []);
  const nonReturning = `fn wait_forever() -> none {
  while true {
    wait 1
  }
}
scene main {
  wait_forever()
}`;
  assert.deepEqual(checkStartScreen(new Map([['main.tds', nonReturning]]), 'main.tds'), [], 'a call that cannot return does not create a scene fallthrough path');
});

test('build control-flow check recognizes nested guaranteed non-returning functions', () => {
  const source = `fn wait_forever() -> none {
  if true {
    while true { wait 1 }
  }
}
scene main {
  wait_forever()
}`;
  assert.deepEqual(checkStartScreen(new Map([['main.tds', source]]), 'main.tds'), []);
});

test('a return inside a literal-true loop does not hide caller fallthrough', () => {
  const source = `fn wait_or_return(flag: bool) -> none {
  while true {
    if flag { return }
  }
}
scene main {
  wait_or_return(true)
  say narrator "can finish without opening the screen"
}`;
  assert.equal(checkStartScreen(new Map([['main.tds', source]]), 'main.tds')[0]?.code, 'start-screen-not-returned');
});

test('a function returning from a literal-true loop does not count as calling start()', () => {
  const source = 'fn helper() -> bool { while true { return true } }\nscene main { if helper() { say narrator "finished" } }';
  assert.equal(checkStartScreen(new Map([['main.tds', source]]), 'main.tds')[0]?.code, 'start-screen-not-returned');
});

test('build control-flow check carries a top-level start() into the entry scene', () => {
  const source = 'start()\nscene main {\n  say narrator "story"\n}';
  assert.deepEqual(checkStartScreen(new Map([['main.tds', source]]), 'main.tds'), []);
});

test('scene-level start() after dialogue covers the later scene end', () => {
  const source = 'scene main {\n  say narrator "story"\n  start()\n}';
  assert.deepEqual(checkStartScreen(new Map([['main.tds', source]]), 'main.tds'), []);
});

test('build control-flow check carries a scene start() across goto', () => {
  const source = 'scene main {\n  start()\n  goto story\n}\nscene story {\n  say narrator "finished"\n}';
  assert.deepEqual(checkStartScreen(new Map([['main.tds', source]]), 'main.tds'), []);
});

test('build control-flow check sees start effects inside evaluated expressions', () => {
  const source = 'fn title() -> str {\n  start()\n  return "Title"\n}\nscene main {\n  say narrator title()\n}';
  assert.deepEqual(checkStartScreen(new Map([['main.tds', source]]), 'main.tds'), []);

  const shortCircuited = 'fn open() -> bool {\n  start()\n  return true\n}\nscene main {\n  if false and open() {\n    say narrator "unreachable"\n  }\n}';
  assert.equal(checkStartScreen(new Map([['main.tds', shortCircuited]]), 'main.tds')[0]?.code, 'start-screen-not-returned');
});


test('build control-flow check follows calls in unset target indexes', () => {
  const source = `fn open_title() -> str {
  start()
  return "x"
}
scene main {
  dict[int] values = {"x": 1}
  unset values[open_title()]
}`;
  const metadata = {};
  assert.deepEqual(checkStartScreen(new Map([['main.tds', source]]), 'main.tds', new Map(), metadata), []);
  assert.equal(metadata.usesStart, true);
});

test('build control-flow check does not treat a conditional loop start as guaranteed', () => {
  const source = 'scene main {\n  while false {\n    start()\n  }\n}';
  assert.equal(checkStartScreen(new Map([['main.tds', source]]), 'main.tds')[0]?.code, 'start-screen-not-returned');
});

test('build control-flow check respects inclusive for ranges and non-fallthrough while loops', () => {
  const requiredStart = source => checkStartScreen(new Map([['main.tds', source]]), 'main.tds');
  assert.deepEqual(requiredStart('scene main {\n  for i from 1 to 1 {\n    start()\n  }\n}'), []);
  assert.deepEqual(requiredStart('scene main {\n  for i from 2 to 1 {\n    start()\n  }\n}').map(item => item.code), ['start-screen-not-returned']);
  assert.deepEqual(requiredStart('scene main {\n  while true {\n    start()\n  }\n}'), []);
  assert.deepEqual(requiredStart('scene main {\n  while true {\n    wait 1\n  }\n}'), []);
});

test('standalone pack API remains permissive while the CLI enforces project startup flow', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-start-screen-pack-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const layout = seedEmptyProject(root);
  const entry = path.join(layout.scenesRoot, 'main.tds');
  await fs.writeFile(entry, 'scene main {\n  say narrator "Standalone"\n}\n', 'utf8');
  await pack(entry, path.join(layout.buildRoot, 'standalone.nsp.json'), { projectRoot: root });
  await assert.rejects(
    pack(entry, path.join(layout.buildRoot, 'blocked.nsp.json'), { projectRoot: root, requireStartScreenFlow: true }),
    /警告:.*start\(\)/,
  );

  const cli = path.resolve(__dirname, '../tools/pack.js');
  const blocked = spawnSync(process.execPath, [cli, '--project', root], { encoding: 'utf8', timeout: 15000 });
  assert.equal(blocked.status, 1, blocked.stdout || blocked.stderr);
  assert.match(blocked.stderr, /start\(\)/);
  assert.match(blocked.stderr, /main\.tds:\d+:\d+ \[start-screen-not-returned\]/,
    'the CLI reports the same actionable file:line:column and stable diagnostic code as the Editor build response');
  await fs.writeFile(entry, 'scene main {\n  for i from 1 to 1 {\n    start()\n  }\n  say narrator "Started"\n}\n', 'utf8');
  const allowed = spawnSync(process.execPath, [cli, '--project', root], { encoding: 'utf8', timeout: 15000 });
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.match(allowed.stdout, /^Packed .* -> .*\.nsp\.json\r?\n$/);
});
