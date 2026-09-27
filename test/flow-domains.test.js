'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parse, compile } = require('../dist');
const { analyzeStartDomains } = require('../Edit/flow-domains');
const { Runtime } = require('../Edit/runtime');

function at(source, marker = 'target', names = ['score'], entry = true) {
  const line = source.split('\n').findIndex((part) => part.includes(marker)) + 1;
  assert.ok(line > 0);
  return analyzeStartDomains(parse(source), 'main', line, names, [], entry);
}

async function play(source, choiceIndex = 0) {
  const output = [];
  const runtime = new Runtime({
    command: async (name, args, rt) => { if (name === 'say') output.push(await rt.textAsync(args[1])); },
    choice: async () => choiceIndex,
  });
  await runtime.run(JSON.parse(JSON.stringify(compile(parse(source)))));
  return output;
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

test('a finite while loop completes and unresolved function writes remain unknown', () => {
  const loop = `global int score = 1
scene main {
  while score < 10 { set score = score + 1 }
  say narrator "target {score}"
}`;
  assert.deepEqual(at(loop).score, { kind: 'exact', values: ['10'] });
  const call = `global int score = 1
scene main {
  change()
  say narrator "target {score}"
}`;
  assert.equal(at(call).score.kind, 'unknown');
});

test('normal-story entry mode remains conservative about inherited mutable globals', () => {
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

test('a narrow configured integer range bounds an inherited mutable variable', () => {
  const source = 'scene main { say narrator "target {score}" }';
  const staticDeclarations = [{ kind: 'declare', name: 'score', type: 'int', initial: { kind: 'literal', value: 0n } }];
  const constraints = new Map([['score', { type: 'int', min: -2n, max: 1n }]]);
  const actual = analyzeStartDomains(parse(source), 'main', 1, ['score'], staticDeclarations, false, constraints);
  assert.deepEqual(actual.score, { kind: 'finite', values: ['-2', '-1', '0', '1'] });
});

test('wide or one-sided configured integer ranges remain unknown instead of being truncated', () => {
  const source = 'scene main { say narrator "target {score}" }';
  const staticDeclarations = [{ kind: 'declare', name: 'score', type: 'int', initial: { kind: 'literal', value: 0n } }];
  for (const constraint of [
    { type: 'int', min: 0n, max: 100n },
    { type: 'int', min: 0n },
    { type: 'int', max: 10n },
  ]) {
    const constraints = new Map([['score', constraint]]);
    const actual = analyzeStartDomains(parse(source), 'main', 1, ['score'], staticDeclarations, false, constraints);
    assert.deepEqual(actual.score, { kind: 'unknown', values: [] });
  }
});

test('configured possibleValues stay narrower than their enclosing min/max range', () => {
  const source = 'scene main { say narrator "target {score}" }';
  const staticDeclarations = [{ kind: 'declare', name: 'score', type: 'int', initial: { kind: 'literal', value: 0n } }];
  const constraints = new Map([['score', { type: 'int', min: -5n, max: 5n, values: new Set([-2n, 3n]) }]]);
  const actual = analyzeStartDomains(parse(source), 'main', 1, ['score'], staticDeclarations, false, constraints);
  assert.deepEqual(actual.score, { kind: 'finite', values: ['-2', '3'] });
});

test('configured possibleValues eliminate impossible branches from inherited globals', () => {
  const source = `global int score = 0
scene main {
  if route == "unused" { set score = 1 } else { set score = 2 }
  say narrator "target {score}"
}`;
  const staticDeclarations = [{ kind: 'declare', name: 'route', type: 'str', initial: { kind: 'literal', value: 'sora' } }];
  const constraints = new Map([['route', { type: 'str', values: new Set(['sora', 'nene']) }]]);
  const line = source.split('\n').findIndex((part) => part.includes('target')) + 1;
  const actual = analyzeStartDomains(parse(source), 'main', line, ['score'], staticDeclarations, false, constraints);
  assert.deepEqual(actual.score, { kind: 'exact', values: ['2'] });
});

test('configured narrow integer ranges eliminate threshold branches that cannot run', () => {
  const source = `global int score = 0
scene main {
  if level > 4 { set score = 1 } else { set score = 2 }
  say narrator "target {score}"
}`;
  const staticDeclarations = [{ kind: 'declare', name: 'level', type: 'int', initial: { kind: 'literal', value: 0n } }];
  const constraints = new Map([['level', { type: 'int', min: 0n, max: 4n }]]);
  const line = source.split('\n').findIndex((part) => part.includes('target')) + 1;
  const actual = analyzeStartDomains(parse(source), 'main', line, ['score'], staticDeclarations, false, constraints);
  assert.deepEqual(actual.score, { kind: 'exact', values: ['2'] });
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

test('unknown integer interpolation does not widen unrelated exact values', () => {
  const source = `global int stable = 8
global int ticks = 0
scene main {
  for i from 1 to 300 { set ticks = ticks + 1 }
  say narrator "ticks={ticks}"
  say narrator "target {stable}"
}`;
  const values = at(source, 'target', ['stable', 'ticks']);
  assert.deepEqual(values.stable, { kind: 'exact', values: ['8'] });
  assert.equal(values.ticks.kind, 'unknown');
});

test('known struct-field interpolation preserves unrelated exact values', () => {
  const source = `struct Mood {
  label: str
  count: int
}
global Mood mood = {"label": "calm", "count": 2}
global int stable = 8
scene main {
  say narrator "{mood.label}"
  say narrator "target {stable}"
}`;
  assert.deepEqual(at(source, 'target', ['mood', 'stable']).stable, { kind: 'exact', values: ['8'] });
});

test('unknown string interpolation remains conservative about embedded function calls', () => {
  const source = `global int stable = 8
global str template = ""
scene main {
  for i from 1 to 300 { set template = template + "x" }
  say narrator "{template}"
  say narrator "target {stable}"
}`;
  assert.equal(at(source, 'target', ['stable', 'template']).stable.kind, 'unknown');
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

test('a function call computes its concrete global writes and preserves unrelated globals', () => {
  const source = `global int score = 4
global int route = 1
fn update_route() -> none {
  set route = 2
}
scene main {
  update_route()
  say narrator "target {score} {route}"
}`;
  const result = at(source, 'target', ['score', 'route']);
  assert.deepEqual(result.score, { kind: 'exact', values: ['4'] });
  assert.deepEqual(result.route, { kind: 'exact', values: ['2'] });
});

test('nested function calls propagate exact global writes', () => {
  const source = `global int score = 4
fn inner() -> none {
  set score = 8
}
fn outer() -> none {
  inner()
}
scene main {
  outer()
  say narrator "target {score}"
}`;
  assert.deepEqual(at(source, 'target').score, { kind: 'exact', values: ['8'] });
});

test('loop-scoped declarations restore globals before later function writes', () => {
  const source = `global int i = 4
fn update() -> none {
  for i from 1 to 1 { wait 0 }
  set i = 9
}
scene main {
  update()
  say narrator "target {i}"
}`;
  assert.deepEqual(at(source, 'target', ['i']).i, { kind: 'exact', values: ['9'] });
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

test('finite while loops are executed through every iteration', () => {
  const source = `global int score = 0
scene main {
  while score < 4 { set score = score + 1 }
  say narrator "target {score}"
}`;
  assert.deepEqual(at(source).score, { kind: 'exact', values: ['4'] });
});

test('starting on a for-loop line unions the values from each reachable iteration', () => {
  const source = `global int score = 0
scene main {
  for i from 1 to 3 {
    set score = score + i
    say narrator "target {i} {score}"
  }
}`;
  const result = at(source, 'target', ['i', 'score']);
  assert.deepEqual(result.i, { kind: 'finite', values: ['1', '2', '3'] });
  assert.deepEqual(result.score, { kind: 'finite', values: ['1', '3', '6'] });
});

test('starting on a while-loop line unions each finite iteration state', () => {
  const source = `global int score = 0
scene main {
  while score < 3 {
    set score = score + 1
    say narrator "target {score}"
  }
}`;
  assert.deepEqual(at(source).score, { kind: 'finite', values: ['1', '2', '3'] });
});

test('function while and for loops compute exact returns and preserve loop scope', () => {
  const source = `global int i = 40
fn total(limit: int) -> int {
  int sum = 0
  for i from 1 to limit {
    set sum = sum + i
  }
  return sum
}
fn countdown(value: int) -> int {
  while value > 0 { set value = value - 1 }
  return value
}
global int sumValue = total(4)
global int endValue = countdown(5)
scene main {
  say narrator "target {sumValue} {endValue} {i}"
}`;
  const result = at(source, 'target', ['sumValue', 'endValue', 'i']);
  assert.deepEqual(result.sumValue, { kind: 'exact', values: ['10'] });
  assert.deepEqual(result.endValue, { kind: 'exact', values: ['0'] });
  assert.deepEqual(result.i, { kind: 'exact', values: ['40'] });
});

test('function branch side effects merge exact alternatives without losing correlation', () => {
  const source = `global int route = 0
global int score = 0
fn apply(value: int) -> none {
  if value > 0 { set route = 3 } else { set route = 8 }
  set score = route + 1
}
scene main {
  choice "choose" {
    "a" { apply(1) }
    "b" { apply(-1) }
  }
  say narrator "target {route} {score}"
}`;
  const result = at(source, 'target', ['route', 'score']);
  assert.deepEqual(result.route, { kind: 'finite', values: ['3', '8'] });
  assert.deepEqual(result.score, { kind: 'finite', values: ['4', '9'] });
});

test('function arguments are isolated from globals with the same name', () => {
  const source = `global int score = 5
fn increment(score: int) -> int { return score + 1 }
global int result = increment(8)
scene main {
  say narrator "target {score} {result}"
}`;
  const result = at(source, 'target', ['score', 'result']);
  assert.deepEqual(result.score, { kind: 'exact', values: ['5'] });
  assert.deepEqual(result.result, { kind: 'exact', values: ['9'] });
});

test('starting at a later scene analyzes the same fresh-file globals as the player', () => {
  const source = `global int score = 6
scene first { set score = 99 }
scene second {
  say narrator "target {score}"
}`;
  const line = source.split('\n').findIndex((part) => part.includes('target')) + 1;
  const result = analyzeStartDomains(parse(source), 'second', line, ['score'], [], true);
  assert.deepEqual(result.score, { kind: 'exact', values: ['6'] });
});

test('external project globals are retained across interprocedural side effects', () => {
  const source = `global int result = 0
fn seed_external() -> none { set externalScore = 8 }
fn read_external() -> int { return externalScore }
scene main {
  seed_external()
  set result = read_external() + 1
  say narrator "target {result}"
}`;
  const line = source.split('\n').findIndex((part) => part.includes('target')) + 1;
  const result = analyzeStartDomains(parse(source), 'main', line, ['result'], [], true, new Map(), [], ['externalScore']);
  assert.deepEqual(result.result, { kind: 'exact', values: ['9'] });
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

test('function branches are evaluated and global writes are tracked', () => {
  const branch = `fn choose(value: int) -> int {
  if value > 0 { return 1 } else { return 2 }
}
global int score = choose(1)
scene main { say narrator "target {score}" }`;
  assert.deepEqual(at(branch).score, { kind: 'exact', values: ['1'] });

  const sideEffect = `global int base = 1
fn mutate() -> int {
  set base = 2
  return base
}
global int score = mutate()
scene main { say narrator "target {base} {score}" }`;
  const values = at(sideEffect, 'target', ['base', 'score']);
  assert.deepEqual(values.base, { kind: 'exact', values: ['2'] });
  assert.deepEqual(values.score, { kind: 'exact', values: ['2'] });
});

test('runtime values from every choice path are contained in the static domain', async () => {
  const source = `global int score = 0
fn apply(value: int) -> none {
  if value > 0 { set score = 12 } else { set score = 21 }
}
scene main {
  choice "choose" {
    "positive" { apply(1) }
    "negative" { apply(-1) }
  }
  say narrator "target {score}"
}`;
  const domain = at(source).score;
  assert.deepEqual(domain, { kind: 'finite', values: ['12', '21'] });
  for (const choice of [0, 1]) {
    const actual = (await play(source, choice)).at(-1).split(' ').at(-1);
    assert.ok(domain.values.includes(actual), `${actual} missing from ${JSON.stringify(domain)}`);
  }
});

test('runtime and static analysis agree on bounded loop functions', async () => {
  const cases = [
    `fn sum_to(n: int) -> int {
  int total = 0
  for i from 1 to n { set total = total + i }
  return total
}
global int result = sum_to(5)
scene main { say narrator "target {result}" }`,
    `fn descend(n: int) -> int {
  while n > 2 { set n = n - 1 }
  return n
}
global int result = descend(9)
scene main { say narrator "target {result}" }`,
    `fn negative_sum() -> int {
  int total = 0
  for i from 3 to -1 step -2 { set total = total + i }
  return total
}
global int result = negative_sum()
scene main { say narrator "target {result}" }`,
  ];
  for (const source of cases) {
    const actual = (await play(source)).at(-1).split(' ').at(-1);
    const resultName = source.match(/global int (\w+) =/)[1];
    const result = at(source, 'target', [resultName])[resultName];
    assert.notEqual(result.kind, 'unknown', source);
    assert.ok(result.values.includes(actual), `${actual} missing from ${JSON.stringify(result)}`);
  }
});

test('generated choice paths across function branches and loops are all represented', async () => {
  const inputs = Array.from({ length: 17 }, (_, index) => index - 8);
  const options = inputs.map((value) => `    "${value}" { transform(${value}) }`).join('\n');
  const source = `global int score = 0
fn transform(value: int) -> none {
  if value < 0 { set score = value } else { set score = value * 2 }
  for i from 1 to 2 { set score = score + i }
  while score < 0 { set score = score + 3 }
}
scene main {
  choice "inputs" {
${options}
  }
  say narrator "target {score}"
}`;
  const result = at(source).score;
  assert.equal(result.kind, 'finite');
  const inferred = new Set(result.values);
  for (let index = 0; index < inputs.length; index++) {
    const output = (await play(source, index)).at(-1);
    const actual = output.slice(output.lastIndexOf(' ') + 1);
    assert.ok(inferred.has(actual), `runtime path ${inputs[index]} produced ${actual}, missing from ${JSON.stringify(result)}`);
  }
  assert.deepEqual(inferred, new Set(['0', '1', '2', '3', '5', '7', '9', '11', '13', '15', '17', '19']));
});

test('nested calls propagate function return values and state updates', () => {
  const source = `global int score = 1
fn add(value: int) -> int { return value + score }
fn update(value: int) -> int {
  set score = value
  return add(4)
}
global int result = update(6)
scene main { say narrator "target {score} {result}" }`;
  const result = at(source, 'target', ['score', 'result']);
  assert.deepEqual(result.score, { kind: 'exact', values: ['6'] });
  assert.deepEqual(result.result, { kind: 'exact', values: ['10'] });
});

test('function choice statements produce a bounded return set', () => {
  const source = `fn select() -> int {
  choice "choose" {
    "a" { return 4 }
    "b" { return 7 }
  }
  return 9
}
global int score = select()
scene main { say narrator "target {score}" }`;
  assert.deepEqual(at(source).score, { kind: 'finite', values: ['4', '7'] });
});

test('early return in a loop stops that path while other paths continue', () => {
  const source = `fn first_positive(limit: int) -> int {
  for i from 0 to limit {
    if i > 2 { return i }
  }
  return 90
}
global int score = first_positive(5)
scene main { say narrator "target {score}" }`;
  assert.deepEqual(at(source).score, { kind: 'exact', values: ['3'] });
});

test('dictionary writes through functions preserve exact object fields', () => {
  const source = `global dict[int] values = {"left": 1}
fn change() -> none { set values["right"] = 8 }
scene main {
  change()
  say narrator str(values["right"])
}`;
  assert.deepEqual(at(source, 'str(values', ['values']).values, {
    kind: 'exact', values: ['{"left":"1","right":"8"}'],
  });
});

test('unbounded or cyclic function loops widen changed values instead of claiming constants', () => {
  const source = `fn forever(value: int) -> int {
  while value >= 0 { set value = value + 1 }
  return value
}
global int score = forever(0)
scene main { say narrator "target {score}" }`;
  assert.equal(at(source).score.kind, 'unknown');
});

test('recursive function evaluation is bounded and remains conservative', () => {
  const source = `fn recurse(value: int) -> int {
  if value <= 0 { return 0 }
  return recurse(value - 1)
}
global int score = recurse(4)
scene main { say narrator "target {score}" }`;
  assert.equal(at(source).score.kind, 'unknown');
});

test('function path explosion widens instead of silently dropping return alternatives', () => {
  const options = Array.from({ length: 40 }, (_, index) => `    "option${index}" { return ${index} }`).join('\n');
  const source = `fn choose() -> int {
  choice "choose" {
${options}
  }
  return 99
}
global int score = choose()
scene main { say narrator "target {score}" }`;
  assert.equal(at(source).score.kind, 'unknown');
});

test('threshold branches retain only values that can reach each return', () => {
  const source = `global int score = 0
fn classify(value: int) -> int {
  if value >= 10 { return 1 }
  if value >= 5 { return 2 }
  return 3
}
scene main {
  choice "choose" {
    "low" { set score = 2 }
    "middle" { set score = 7 }
    "high" { set score = 12 }
  }
  set score = classify(score)
  say narrator "target {score}"
}`;
  assert.deepEqual(at(source).score, { kind: 'finite', values: ['3', '2', '1'] });
});

test('function calls in if and while conditions retain their exact side effects', async () => {
  const branch = `global int score = 0
global int result = 0
fn bump() -> int {
  set score = score + 1
  return score
}
scene main {
  if bump() == 1 { set result = score + 10 } else { set result = -1 }
  say narrator "target {score} {result}"
}`;
  const branchDomains = at(branch, 'target', ['score', 'result']);
  assert.deepEqual(branchDomains.score, { kind: 'exact', values: ['1'] });
  assert.deepEqual(branchDomains.result, { kind: 'exact', values: ['11'] });
  assert.equal((await play(branch)).at(-1), 'target 1 11');

  const loop = `global int score = 0
fn bump() -> int {
  set score = score + 1
  return score
}
scene main {
  while bump() < 4 { wait 0 }
  say narrator "target {score}"
}`;
  assert.deepEqual(at(loop).score, { kind: 'exact', values: ['4'] });
  assert.equal((await play(loop)).at(-1), 'target 4');
});

test('function calls inside dialogue interpolation update the following state', async () => {
  const source = `global int score = 0
fn bump() -> int {
  set score = score + 1
  return score
}
scene main {
  say narrator "Display {bump()}"
  say narrator "target {score}"
}`;
  assert.deepEqual(at(source).score, { kind: 'exact', values: ['1'] });
  assert.deepEqual(await play(source), ['Display 1', 'target 1']);
});

test('choice-label interpolation side effects execute in runtime order', async () => {
  const source = `global int score = 0
fn bump() -> int {
  set score = score + 1
  return score
}
scene main {
  choice "Prompt {bump()}" {
    "First {bump()}" { wait 0 }
    "Second {bump()}" { wait 0 }
  }
  say narrator "target {score}"
}`;
  assert.deepEqual(at(source).score, { kind: 'exact', values: ['3'] });
  assert.deepEqual(await play(source, 1), ['target 3']);
});

test('function calls in for bounds execute left-to-right and preserve their writes', async () => {
  const source = `global int score = 0
fn next() -> int {
  set score = score + 1
  return score
}
scene main {
  for i from next() to next() + 1 {
    set score = score + i
  }
  say narrator "target {score}"
}`;
  const domain = at(source).score;
  const actual = (await play(source)).at(-1).split(' ').at(-1);
  assert.deepEqual(domain, { kind: 'exact', values: [actual] });
});

test('line selection inside a while body includes side effects from its condition', () => {
  const source = `global int score = 0
fn bump() -> int {
  set score = score + 1
  return score
}
scene main {
  while bump() <= 3 {
    say narrator "target {score}"
  }
}`;
  assert.deepEqual(at(source).score, { kind: 'finite', values: ['1', '2', '3'] });
});

test('unrelated unknown functions do not erase known values from finite loops', () => {
  const source = `fn unused() -> int { return missing() }
global int score = 0
scene main {
  for i from 1 to 3 { set score = score + i }
  say narrator "target {score}"
}`;
  assert.deepEqual(at(source).score, { kind: 'exact', values: ['6'] });
});

test('fallthrough-only functions remain unknown for expression return values', () => {
  const source = `fn maybe(value: int) -> int {
  if value > 0 { return 4 }
}
global int score = maybe(1)
scene main { say narrator "target {score}" }`;
  assert.equal(at(source).score.kind, 'exact');
});
