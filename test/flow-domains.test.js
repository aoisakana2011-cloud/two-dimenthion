'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parse } = require('../dist');
const { analyzeStartDomains } = require('../Edit/flow-domains');

function at(source, marker = 'target', names = ['score'], entry = true) {
  const line = source.split('\n').findIndex((part) => part.includes(marker)) + 1;
  assert.ok(line > 0);
  return analyzeStartDomains(parse(source), 'main', line, names, [], entry);
}

test('choice paths retain exact alternative values at the selected line', () => {
  const source = `global int score = 0
scene main {
  choice "choose" {
    "a" { set score = 2 }
    "b" { set score = 5 }
  }
  say narrator "target {score}"
}`;
  assert.deepEqual(at(source).score, { kind: 'finite', values: ['2', '5'] });
});

test('equal values on distinct paths merge to one exact value', () => {
  const source = `global int score = 0
scene main {
  choice "choose" {
    "a" { set score = 2 }
    "b" { set score = 2 }
  }
  say narrator "target {score}"
}`;
  assert.deepEqual(at(source).score, { kind: 'exact', values: ['2'] });
});

test('known false conditions discard impossible branches', () => {
  const source = `global int score = 0
scene main {
  if score == 1 { set score = 9 } else { set score = 3 }
  say narrator "target {score}"
}`;
  assert.deepEqual(at(source).score, { kind: 'exact', values: ['3'] });
});

test('condition refinement retains only matching finite values inside a branch', () => {
  const source = `global int score = 0
scene main {
  choice "choose" {
    "a" { set score = 2 }
    "b" { set score = 5 }
  }
  if score == 5 {
    say narrator "target {score}"
  }
}`;
  assert.deepEqual(at(source).score, { kind: 'exact', values: ['5'] });
});

test('an unknown value becomes exact on the equality-true branch only', () => {
  const source = `scene main {
  if score == 5 {
    say narrator "target {score}"
  }
}`;
  assert.deepEqual(at(source).score, { kind: 'exact', values: ['5'] });
});

test('loop and user function calls are not reported as exact', () => {
  const loop = `global int score = 1
scene main {
  while score < 10 { set score = score + 1 }
  say narrator "target {score}"
}`;
  assert.equal(at(loop).score.kind, 'unknown');
  const call = `global int score = 1
scene main {
  call change()
  say narrator "target {score}"
}`;
  assert.equal(at(call).score.kind, 'unknown');
});

test('other scene entries conservatively lose mutable globals', () => {
  const source = `global int score = 1
scene main {
  say narrator "target {score}"
}`;
  assert.equal(at(source, 'target', ['score'], false).score.kind, 'unknown');
});

test('configured possibleValues bounds an inherited mutable variable', () => {
  const source = 'scene main { say narrator "target {route}" }';
  const staticDeclarations = [{ kind: 'declare', name: 'route', type: 'str', initial: { kind: 'literal', value: 'sora' } }];
  const constraints = new Map([['route', { type: 'str', values: new Set(['sora', 'nene']) }]]);
  const actual = analyzeStartDomains(parse(source), 'main', 1, ['route'], staticDeclarations, false, constraints);
  assert.deepEqual(actual.route, { kind: 'finite', values: ['sora', 'nene'] });
});

test('unknown function side effects do not retain old exact values', () => {
  const source = `global int score = 1
scene main {
  if change() == 1 { set score = 2 }
  say narrator "target {score}"
}`;
  assert.equal(at(source).score.kind, 'unknown');
});

test('dictionary element writes retain exact contents on each choice path', () => {
  const source = `global dict[int] points = {"x": 0}
scene main {
  choice "choose" {
    "a" { set points["x"] = 2 }
    "b" { set points["x"] = 5 }
  }
  say narrator "target"
}`;
  assert.deepEqual(at(source, 'target', ['points']).points, {
    kind: 'finite', values: ['{"x":"2"}', '{"x":"5"}'],
  });
});

test('a value-set cap widens to unknown rather than dropping alternatives', () => {
  const options = Array.from({ length: 33 }, (_, index) => `    "option${index}" { set score = ${index} }`).join('\n');
  const source = `global int score = 0\nscene main {\n  choice "choose" {\n${options}\n  }\n  say narrator "target"\n}`;
  assert.equal(at(source).score.kind, 'unknown');
});

test('indirect text interpolation may call functions and invalidates prior values', () => {
  const source = `global int score = 1
global str text = "{change()}"
scene main {
  say narrator text
  say narrator "target {score}"
}`;
  assert.equal(at(source).score.kind, 'unknown');
});

test('ordinary variable interpolation does not invalidate exact values', () => {
  const source = `global int score = 1
scene main {
  say narrator "Before {score}"
  say narrator "target {score}"
}`;
  assert.deepEqual(at(source).score, { kind: 'exact', values: ['1'] });
});

test('external character definitions seed exact display-name fields for direct scene starts', () => {
  const source = 'scene target {\n  say hero "Hello"\n}';
  const character = { kind: 'character', name: 'hero', line: 1, properties: [
    { name: 'name', value: { kind: 'literal', value: 'Hero Display' } },
    { name: 'age', value: { kind: 'literal', value: 17 } },
  ] };
  const line = source.split('\n').findIndex((part) => part.includes('say hero')) + 1;
  const actual = analyzeStartDomains(parse(source), 'target', line, ['hero'], [], false, new Map(), [character]);
  assert.deepEqual(actual.hero, { kind: 'exact', values: ['{"name":"Hero Display","age":"17"}'] });
});

test('a declaration is unknown on its own start line and exact after execution', () => {
  const source = 'scene main {\n  str label = "known"\n  say narrator label\n}';
  const before = analyzeStartDomains(parse(source), 'main', 2, ['label']);
  const after = analyzeStartDomains(parse(source), 'main', 3, ['label']);
  assert.equal(before.label.kind, 'unknown');
  assert.deepEqual(after.label, { kind: 'exact', values: ['known'] });
});

test('a function call only widens globals the function can modify', () => {
  const source = `global int score = 4
global int route = 1
fn update_route() -> none {
  set route = 2
}
scene main {
  call update_route()
  say narrator "target {score} {route}"
}`;
  const result = at(source, 'target', ['score', 'route']);
  assert.deepEqual(result.score, { kind: 'exact', values: ['4'] });
  assert.equal(result.route.kind, 'unknown');
});

test('transitive function writes invalidate the affected global conservatively', () => {
  const source = `global int score = 4
fn inner() -> none {
  set score = 8
}
fn outer() -> none {
  call inner()
}
scene main {
  call outer()
  say narrator "target {score}"
}`;
  assert.equal(at(source, 'target').score.kind, 'unknown');
});

test('loop-scoped declarations do not hide later writes to a same-named global', () => {
  const source = `global int i = 4
fn update() -> none {
  for i from 1 to 1 { wait 0 }
  set i = 9
}
scene main {
  call update()
  say narrator "target {i}"
}`;
  assert.equal(at(source, 'target', ['i']).i.kind, 'unknown');
});

test('small finite for loops are executed to determine an exact start value', () => {
  const source = `global int score = 0
scene main {
  for i from 1 to 3 {
    set score = score + i
  }
  say narrator "target {score}"
}`;
  assert.deepEqual(at(source).score, { kind: 'exact', values: ['6'] });
});

test('a provably false while loop leaves values unchanged', () => {
  const source = `global int score = 4
scene main {
  while 1 > 2 {
    set score = 9
  }
  say narrator "target {score}"
}`;
  assert.deepEqual(at(source).score, { kind: 'exact', values: ['4'] });
});

test('pure straight-line functions with parameters are evaluated for start domains', () => {
  const source = `fn add_bonus(value: int) -> int {
  int adjusted = value + 2
  return adjusted * 3
}
global int score = add_bonus(4)
scene main {
  say narrator "target {score}"
}`;
  assert.deepEqual(at(source).score, { kind: 'exact', values: ['18'] });
});

test('pure functions can read known globals without widening unrelated state', () => {
  const source = `global int base = 7
global int score = 0
fn read_base() -> int { return base + 1 }
scene main {
  set score = read_base()
  say narrator "target {score}"
}`;
  assert.deepEqual(at(source).score, { kind: 'exact', values: ['8'] });
});

test('functions with branches or global writes stay conservative', () => {
  const branch = `fn choose(value: int) -> int {
  if value > 0 { return 1 } else { return 2 }
}
global int score = choose(1)
scene main { say narrator "target {score}" }`;
  assert.equal(at(branch).score.kind, 'unknown');

  const sideEffect = `global int base = 1
fn mutate() -> int {
  set base = 2
  return base
}
global int score = mutate()
scene main { say narrator "target {base} {score}" }`;
  const values = at(sideEffect, 'target', ['base', 'score']);
  assert.equal(values.base.kind, 'unknown');
  assert.equal(values.score.kind, 'unknown');
});
