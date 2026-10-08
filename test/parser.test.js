const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parse, compile, checkTypes, analyzeScript } = require('../dist');

test('parser reports excessive expression nesting as a syntax error instead of overflowing the stack', () => {
  const parenthesized = depth => `int value = ${'('.repeat(depth)}1${')'.repeat(depth)}`;
  assert.doesNotThrow(() => parse(parenthesized(255)), 'nesting below the documented limit remains accepted');
  assert.throws(() => parse(parenthesized(256)), error => error.name === 'ParseError' && /expression nesting depth exceeds 256/.test(error.message));

  const unary = `int value = ${'not '.repeat(1000)}true`;
  assert.throws(() => parse(unary), error => error.name === 'ParseError' && /expression nesting depth exceeds 256/.test(error.message));
});

test('parses and compiles assets, globals, characters, functions and scenes', () => {
  const script = parse(`
    asset bg school = "asset/bg/school.jpg"
    asset bgm peaceful = "asset/bgm/peaceful.ogg"
    asset se door = "asset/se/door.wav"
    character heroine {
      name = "Heroine"
      affection = 0
      pose normal = "asset/chara/heroine/normal.png"
      pose smile = "asset/chara/heroine/smile.png"
    }
    int score = 0
    dict[int] stats = { "hp": 100 }
    fn add_score(value: int) -> none {
      set score = score + value
    }
    scene prologue {
      bg school
      bgm peaceful
      show heroine.normal center
      set stats["hp"] = stats["hp"] - 10
      say heroine "こんにちは"
      add_score(1)
    }
  `);
  assert.equal(script.assets.length, 3);
  assert.equal(script.characters[0].poses.length, 2);
  assert.equal(script.characters[0].properties.length, 2);
  assert.equal(script.globals.length, 2);
  assert.equal(script.functions[0].name, 'add_score');
  assert.equal(script.scenes[0].name, 'prologue');
  const program = compile(script);
  assert.equal(program.version, 2);
  assert.equal(program.scenes[0].instructions.length, 6);
  assert.equal(program.assets[1].type, 'bgm');
  assert.deepEqual(program.variables.slice(0, 4).map((entry) => [entry.name, entry.scope, entry.definedIn]), [
    ['heroine', 'global', 'global'],
    ['score', 'global', 'global'],
    ['stats', 'global', 'global'],
    ['value', 'function', 'add_score'],
  ]);
});

test('compiler and parser diagnostics use English technical terms with Japanese explanations', () => {
  assert.throws(() => parse('include'), /include path を指定してください/);
  assert.throws(() => parse('asset bg image_id = 1'), /asset path は文字列で指定してください/);
  assert.throws(() => parse('scene main { fn nested() -> none {} }'), /関数宣言はファイルの top-level でのみ使用できます/);
  assert.throws(() => checkTypes(parse('fn bad() -> none { global int value = 1 }')), /global 宣言はファイルの top-level でのみ使用できます/);
  assert.throws(() => checkTypes(parse('scene main { parallel {} }')), /parallel block には時間指定のある表示命令が1つ以上必要です/);
});

test('type diagnostics keep DSL type and access terms in English', () => {
  assert.throws(
    () => compile(parse('list[int] xs = [1]\nint x = xs[true]')),
    error => error.message === 'line 2, column 9: list の添字は int で指定してください',
  );
  assert.throws(
    () => compile(parse('int x = 2[0]')),
    error => error.message === 'line 1, column 9: Type error (current): index access の対象は dict でなければなりません',
  );
  assert.throws(
    () => compile(parse('list[int] xs = list.append([1], [2])')),
    error => error.message === 'line 1, column 16: list.append には primitive type を要素とする list を指定してください',
  );
});

test('asset and playback type diagnostics keep technical identifiers in English', () => {
  assert.throws(
    () => compile(parse('scene main { bg missing }')),
    /background asset 'missing' が未定義か、type が bg ではありません/,
  );
  assert.throws(
    () => compile(parse('asset bgm music = "asset/music.ogg"\nscene main { play bgm music volume 1 }')),
    /play の volume は float で指定してください/,
  );
});

test('checker diagnostics name DSL types and fields in English', () => {
  assert.throws(() => compile(parse('global bool value = not 1')), /not の対象は bool でなければなりません/);
  assert.throws(() => compile(parse('str left = "a"\nint right = 1\nbool result = left < right')), /同じ int または float 型/);
  assert.throws(() => compile(parse('global str text = "x"\nstr result = str(true)')), /int または float 型の引数/);
  assert.throws(() => compile(parse('str layer = "bad"\nasset image logo = "asset/logo.png"\nscene main { show image logo center --layer layer }')), /--layer は int または float で指定してください/);
});

test('validates --layer range and three-decimal precision', () => {
  const source = precision => `asset image logo = "asset/logo.png"\nscene main { show image logo center --layer ${precision} }`;
  assert.doesNotThrow(() => compile(parse(source('7.999'))));
  assert.throws(() => compile(parse(source('8'))), /--layer/);
  assert.throws(() => compile(parse(source('1.2345'))), /--layer/);
});

test('parses bool values, primitive lists, list indexing, and typed for-in variables', () => {
  const script = parse(`
    struct Status {
      ready: bool
      title: str
    }
    global bool active = true
    global list[int] scores = [2, 3, 5]
    fn sum(values: list[int]) -> int {
      int total = 0
      for value in values { set total = total + value }
      return total
    }
    scene main {
      set scores[1] = 4
      set active = false
      say narrator str(sum(scores))
    }
  `);
  assert.equal(script.globals[0].type, 'bool');
  assert.deepEqual(script.globals[1].type, { kind: 'list', value: 'int' });
  assert.deepEqual(script.globals[1].initial.items.map(item => item.value), [2, 3, 5]);
  assert.equal(script.functions[0].body[1].kind, 'forEach');
  const compiled = compile(script);
  assert.deepEqual(compiled.variables.find(item => item.name === 'value').type, 'int');
  assert.deepEqual(compiled.functions[0].body[1].iterable, { kind: 'load', name: 'values' });
  assert.throws(() => compile(parse('global list[int] values = [1]\nscene main { set values[0] = "wrong" }')), /list への代入/);
  assert.throws(() => compile(parse('scene main { for value in 5 { wait value } }')), /for-in では list 型の値を指定してください/);
});

test('supports typed const declarations and rejects reassignment', () => {
  const script = parse('const int answer = 1\nconst str label = "ok"');
  assert.equal(script.globals[0].constant, true);
  assert.equal(script.globals[1].constant, true);
  const program = compile(script);
  assert.deepEqual(program.variables.slice(0, 2).map((entry) => [entry.name, entry.mutable]), [['answer', false], ['label', false]]);
  assert.throws(() => checkTypes(parse('const int answer = 1\nset answer = 2')), /const.*変更できません/);
});

test('parses explicit global declarations', () => {
  const script = parse('global int score = 1\nglobal const str title = "ok"');
  assert.deepEqual(script.globals.map((statement) => [statement.kind, statement.global, statement.constant]), [
    ['declare', true, false],
    ['declare', true, true],
  ]);
  assert.throws(() => checkTypes(parse('fn bad() -> none { global int value = 1 }')), /global.*top-level/);
});

test('top-level declarations report their own restriction when nested in executable blocks', () => {
  for (const [declaration, label] of [
    ['fn nested() -> none {}', /関数宣言.*top-level/],
    ['scene nested {}', /scene 宣言.*top-level/],
    ['struct Nested { value: int }', /struct 宣言.*top-level/],
    ['include "module.tds" as module', /include 宣言.*top-level/],
    ['asset bg nested = "asset/bg.png"', /asset 宣言.*top-level/],
    ['character nested {}', /character 宣言.*top-level/],
  ]) {
    assert.throws(() => parse(`scene main { ${declaration} }`), label, declaration);
    assert.throws(() => parse(`fn outer() -> none { ${declaration} }`), label, declaration);
  }
});

test('rejects every DSL keyword documented as unavailable for identifiers', () => {
  const implementation = fs.readFileSync(path.join(__dirname, '..', 'src', 'parser', 'parser.ts'), 'utf8');
  const syntax = fs.readFileSync(path.join(__dirname, '..', 'docs', 'syntax-reference.md'), 'utf8');
  const implementationList = implementation.match(/const KEYWORDS = new Set\(\[([\s\S]*?)\]\);/)?.[1];
  const documentedList = syntax.match(/予約語集合は `parser\.ts` の `KEYWORDS` が唯一の実装基準であり、次を含む。\n\n```text\n([\s\S]*?)\n```/)?.[1];
  assert.ok(implementationList, 'KEYWORDS must remain a directly auditable literal set');
  assert.ok(documentedList, 'syntax reference must keep the canonical keyword list');
  const reserved = [...implementationList.matchAll(/'([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual(documentedList.trim().split(/\s+/).sort(), [...reserved].sort(), 'syntax reference keyword inventory must exactly match Parser');
  for (const name of reserved) {
    assert.throws(() => parse(`int ${name} = 1`), /予約語/, `${name} must remain reserved`);
  }
});

test('defaults shorthand say to narrator', () => {
  const statement = parse('say "hello"').globals[0];
  assert.equal(statement.kind, 'command');
  assert.equal(statement.args[0].value, 'narrator');
});

test('requires a text expression for say', () => {
  assert.throws(() => parse('say message'), /say body.*\u5f15\u7528\u7b26/);
  assert.throws(() => parse('say narrator'), /say body.*\u5f15\u7528\u7b26/);
  const hero = 'character hero {\n  name = "Hero"\n  pose normal = "asset/hero.png"\n}\n';
  assert.doesNotThrow(() => checkTypes(parse(hero + 'show hero.normal center')));
  assert.throws(() => parse('Unknown value = { "x": 1 }'), /\u5f0f\u3092\u6307\u5b9a/);
});

test('ambiguous asset references use English Asset terminology in diagnostics', () => {
  const source = `asset bg first = "asset/one/shared.png"
asset bg second = "asset/two/shared.png"
scene main { bg "shared.png" }`;
  assert.throws(() => checkTypes(parse(source)), /Asset reference "shared\.png".*assets.*asset ID/);
});

test('character fields are typed runtime state with dotted interpolation', () => {
  const script = parse(`
    character ayase {
      name = "綾瀬"
      affection = 0
      pose normal = "asset/char/ayase/normal.png"
      pose smile = "asset/char/ayase/smile.png"
    }
    set ayase.affection = ayase.affection + 1
    say ayase "{ayase.name}: {ayase.affection}"
    show ayase.smile center
    hide ayase
  `);
  assert.doesNotThrow(() => checkTypes(script));
  assert.deepEqual(script.characters[0].properties.map((property) => property.name), ['name', 'affection']);
  const program = compile(script);
  assert.equal(program.globals[0].op, 'declare');
  assert.equal(program.globals[0].name, 'ayase');
  assert.deepEqual(program.globals.slice(-2).map((instruction) => instruction.args.map((arg) => arg.value)), [
    ['ayase.smile', 'center'],
    ['ayase'],
  ]);
  assert.throws(() => checkTypes(parse('character ayase {\nname = "A"\npose normal = "asset/a.png"\n}\nshow ayase.missing center')), /pose/);
});

test('parses pixel offsets on character show commands before an optional fade', () => {
  const source = `character ayase {
    name = "Ayase"
    pose smile = "asset/ayase.png"
  }
  show ayase.smile left y+50
  show ayase.smile center x+30
  show ayase.smile right x-10 y+40 fade 300`;
  const script = parse(source);
  checkTypes(script);
  const showStatements = script.globals.filter(statement => statement.kind === 'command' && statement.name === 'show');
  assert.deepEqual(showStatements.map(statement => statement.args.slice(2).map(argument => argument.value)), [
    ['y+50'], ['x+30'], ['x-10', 'y+40', 'fade', 300],
  ]);
  const compiled = compile(script);
  assert.deepEqual(compiled.globals.filter(statement => statement.op === 'command').map(statement => statement.args.slice(2).map(argument => argument.value)), [
    ['y+50'], ['x+30'], ['x-10', 'y+40', 'fade', '300'],
  ]);
});

test('rejects duplicate or excessive character pixel offsets', () => {
  const character = 'character ayase { name = "Ayase"\npose smile = "asset/ayase.png" }\n';
  assert.throws(() => checkTypes(parse(character + 'show ayase.smile left x+1 x-2')), /x \/ y をそれぞれ1回/);
  assert.throws(() => checkTypes(parse(character + 'show ayase.smile left y+1000001')), /±1000000 px/);
  assert.throws(() => parse(character + 'show ayase.smile left x+'), /x\+30 \/ x\+\(式\)/);
});

test('parses and validates relative character and background move commands', () => {
  const script = parse(`asset bg room = "asset/room.png"
character hero { name = "Hero"\npose normal = "asset/hero.png" }
bg room
show hero.normal center
move character hero by x+5 y-8 over 300
move bg by x-12 y+4`);
  checkTypes(script);
  const moves = script.globals.filter(statement => statement.kind === 'command' && statement.name === 'move');
  assert.deepEqual(moves.map(statement => statement.args.map(argument => argument.value)), [
    ['character', 'hero', 'by', 'x+5', 'y-8', 'over', 300],
    ['bg', 'by', 'x-12', 'y+4'],
  ]);
  assert.throws(() => checkTypes(parse('character hero { name = "Hero"\npose normal = "asset/hero.png" }\nmove character hero by x+1 x-2')), /x \/ y をそれぞれ1回/);
  assert.throws(() => checkTypes(parse('move bg by x+1000001')), /±1000000 px/);
  assert.throws(() => checkTypes(parse('move bg by x+1 over -1')), /2147483647/);
  assert.throws(() => checkTypes(parse('character ghost { name = "Ghost"\npose normal = "asset/ghost.png" }\nmove character absent by y+1')), /未定義の character/);
});

test('warns when a move target is not statically established', () => {
  const prefix = 'asset bg room = "asset/room.png"\ncharacter hero { name = "Hero"\npose normal = "asset/hero.png" }\n';
  const diagnostics = analyzeScript(parse(prefix + 'move character hero by x+1\nmove bg by y-1'));
  assert.deepEqual(diagnostics.filter(item => item.code.startsWith('move-')).map(item => item.code), [
    'move-unshown-character', 'move-unset-background',
  ]);
  const valid = analyzeScript(parse(prefix + 'bg room\nshow hero.normal center\nmove character hero by x+1\nmove bg by y-1'));
  assert.equal(valid.some(item => item.code.startsWith('move-')), false);
});

test('float value ranges validate character and background pixel offsets', () => {
  const globals = new Map([['offset', 'float']]);
  globals.constraints = new Map([['offset', { type: 'float', floatMin: 1000000.25, floatMax: 1000001.5 }]]);
  const moved = parse('float displacement = 0.0\nscene main { set displacement = offset\nmove bg by x+(displacement) }');
  const diagnostics = analyzeScript(moved, 'main.tds', globals);
  assert.ok(diagnostics.some(item => item.code === 'presentation-offset-range' && item.severity === 'error'));
  assert.throws(() => compile(moved, globals), /位置ずらし/);

  const exactAfterAssignment = parse('float displacement = 0.0\nscene main { set displacement = 1000001.0\nmove bg by x+(displacement) }');
  assert.ok(analyzeScript(exactAfterAssignment).some(item => item.code === 'presentation-offset-range' && item.severity === 'error'),
    'an exact mutable value must still be checked against the pixel-offset limit');
  assert.throws(() => compile(exactAfterAssignment), /±1000000 px/);

  const integerOffsets = new Map([['offset', 'int']]);
  integerOffsets.constraints = new Map([['offset', { type: 'int', min: 1000001n, max: 1000002n }]]);
  const convertedInteger = parse('scene main { move bg by x+(float(offset)) }');
  assert.ok(analyzeScript(convertedInteger, 'main.tds', integerOffsets).some(item => item.code === 'presentation-offset-range' && item.severity === 'error'),
    'float(int-variable) must retain the variable-table interval');
  assert.throws(() => compile(convertedInteger, integerOffsets), /±1000000 px/);

  const numericStrings = new Map([['offsetText', 'str']]);
  numericStrings.constraints = new Map([['offsetText', { type: 'str', values: new Set(['1000001.0', '1000002.0']) }]]);
  const convertedString = parse('scene main { move bg by x+(float(offsetText)) }');
  assert.ok(analyzeScript(convertedString, 'main.tds', numericStrings).some(item => item.code === 'presentation-offset-range' && item.severity === 'error'),
    'finite numeric string candidates must retain their converted interval');
  assert.throws(() => compile(convertedString, numericStrings), /±1000000 px/);

  const negative = analyzeScript(parse('scene main { move bg by x-(offset) }'), 'main.tds', globals);
  assert.ok(negative.some(item => item.code === 'presentation-offset-range' && item.severity === 'error'), 'the x- direction must invert the range');

  globals.constraints = new Map([['offset', { type: 'float', floatMin: 999999.5, floatMax: 1000000.5 }]]);
  const uncertain = analyzeScript(parse('scene main { show hero.normal center x+(offset) }'), 'main.tds', globals,
    new Map([['hero', new Set(['normal'])]]));
  assert.ok(uncertain.some(item => item.code === 'presentation-offset-range' && item.severity === 'warning'));
});

test('character declarations require a string name and constant primitive fields', () => {
  assert.throws(() => checkTypes(parse('character ayase { pose normal = "asset/a.png" }')), /name/);
  assert.throws(() => checkTypes(parse('character ayase { name = 1 }')), /str.*name/);
  assert.throws(() => checkTypes(parse('character ayase {\nname = "A"\naffection = score\n}\nint score = 0')), /定数/);
});

test('reports independent type errors on later lines instead of stopping at the first', () => {
  const diagnostics = analyzeScript(parse(`scene main {
    bg missing
    wait "bad"
    show missing.normal nowhere
    say missing "hello"
  }`));
  assert.deepEqual(diagnostics.filter((item) => item.severity === 'error').map((item) => item.line), [2, 3, 4, 5]);

  const declarations = analyzeScript(parse('int first = "bad"\nint second = "also bad"'));
  assert.deepEqual(declarations.filter((item) => item.severity === 'error').map((item) => item.line), [1, 2]);

  const definitionAndBody = analyzeScript(parse('character hero {\npose normal = "asset/a.png"\n}\nscene main {\nwait "bad"\n}'));
  assert.deepEqual(definitionAndBody.filter((item) => item.severity === 'error').map((item) => item.line), [1, 5]);
});

test('rejects statically invalid non-negative timing values before runtime', () => {
  assert.throws(() => checkTypes(parse('scene main { wait -1 }')), /2147483647/);
  assert.throws(() => checkTypes(parse('scene main { wait 2147483648 }')), /2147483647/);
  assert.throws(() => checkTypes(parse('scene main { effect fade black -1 }')), /2147483647/);
  assert.throws(() => checkTypes(parse('character hero {\nname = "Hero"\npose normal = "asset/hero.png"\n}\nscene main { show hero.normal center fade 2147483648 }')), /2147483647/);
});

test('duration bounds use known global and local constants in new animation commands', () => {
  const invalid = [
    'const int bad_duration = -1\nscene main { wait bad_duration }',
    'const int bad_duration = 2147483648\nscene main { effect fade black bad_duration }',
    'const int bad_duration = -1\nscene main { move bg by x+1 over bad_duration }',
    'character hero { name = "Hero"\npose normal = "asset/hero.png" }\nconst int bad_duration = -1\nscene main { show hero.normal center fade bad_duration }',
    'fn animate() -> none { const int bad_duration = 2147483648\nwait bad_duration }',
    'fn animate() -> none { const int bad_duration = -1\nmove bg by y+1 over bad_duration }',
  ];
  for (const source of invalid) assert.throws(() => checkTypes(parse(source)), /2147483647/, source);

  assert.doesNotThrow(() => checkTypes(parse('character hero { name = "Hero"\npose normal = "asset/hero.png" }\nconst int safe_duration = 250\nscene main { wait safe_duration\neffect fade black safe_duration\nshow hero.normal center fade safe_duration\nmove bg by x+1 over safe_duration }')));
  assert.doesNotThrow(() => checkTypes(parse('fn animate() -> none { int duration = 250\nset duration = 300\nwait duration }')));
});

test('validates and preserves non-blocking BGM crossfade options', () => {
  const script = parse(`
    asset bgm calm = "asset/calm.ogg"
    int fade_ms = 320
    scene main { play bgm calm crossfade fade_ms }
  `);
  checkTypes(script);
  const compiled = compile(script);
  const command = compiled.scenes[0].instructions.find(statement => statement.op === 'command');
  assert.deepEqual(command.args.slice(0, 3).map(item => item.kind === 'literal' ? item.value : item.name), ['bgm', 'calm', 'crossfade']);
  assert.equal(command.args[3].name, 'fade_ms');
  assert.throws(() => checkTypes(parse(`asset bgm calm = "asset/calm.ogg"\nplay bgm calm dissolve 100`)), /play の option 'dissolve' は未対応です。BGM では crossfade、voice では blocking \/ async/);
  assert.throws(() => checkTypes(parse(`asset bgm calm = "asset/calm.ogg"\nplay bgm calm crossfade -1`)), /譎る俣|duration|0/);
});

test('supports explicit blocking and async voice playback modes', () => {
  const source = 'asset voice greeting = "asset/voice.wav"\nplay voice greeting blocking\nplay voice greeting async';
  assert.doesNotThrow(() => checkTypes(parse(source)));
  const commands = compile(parse(source)).globals.filter((instruction) => instruction.op === 'command');
  assert.deepEqual(commands.map((instruction) => instruction.args.map((argument) => argument.value)), [
    ['voice', 'greeting', 'blocking'],
    ['voice', 'greeting', 'async'],
  ]);
  assert.throws(() => checkTypes(parse('asset voice greeting = "asset/voice.wav"\nplay voice greeting later')), /voice/);
});

test('rejects conflicting blocking and async playback options', () => {
  for (const kind of ['voice', 'video']) {
    const extension = kind === 'voice' ? 'wav' : 'mp4';
    for (const options of ['async blocking', 'blocking async']) {
      const source = `asset ${kind} sample = "asset/sample.${extension}"\nscene main { play ${kind} sample ${options} }`;
      assert.throws(() => checkTypes(parse(source)), /blocking \u3068 async \u3092\u540c\u6642\u306b\u6307\u5b9a\u3067\u304d\u307e\u305b\u3093/);
    }
  }
});

test('rejects legacy-looking words that are not engine command names', () => {
  for (const command of ['char hero', 'at center', 'image logo', 'se click']) {
    assert.throws(() => checkTypes(parse(`scene main { ${command} }`)), /未知の命令/, command);
  }
});

test('binds a voice line to a declared character without changing legacy voice playback', () => {
  const source = `asset voice greeting = "asset/voice.wav"
character ayaka { name = "綾瀬あやか" }
scene main {
  play voice greeting character ayaka volume 0.8 blocking
  play voice greeting async
}`;
  checkTypes(parse(source));
  const commands = compile(parse(source)).scenes[0].instructions.filter(instruction => instruction.op === 'command');
  assert.deepEqual(commands[0].args.map(argument => argument.kind === 'float' ? Number(argument.value) : argument.kind === 'literal' ? argument.value : argument.name), ['voice', 'greeting', 'character', 'ayaka', 'volume', 0.8, 'blocking']);
  assert.deepEqual(commands[1].args.map(argument => argument.value), ['voice', 'greeting', 'async']);
  assert.throws(() => checkTypes(parse(`asset voice greeting = "asset/voice.wav"\nscene main { play voice greeting character missing }`)), /\u767b\u5834\u4eba\u7269 'missing' \u304c\u5b9a\u7fa9\u3055\u308c\u3066\u3044\u307e\u305b\u3093/);
  assert.throws(() => checkTypes(parse(`asset se click = "asset/click.wav"\nscene main { play se click character ayaka }`)), /character/);
});

test('supports float audio defaults, persistent mix levels, and momentary playback overrides', () => {
  const source = `
asset bgm music = "asset/music.ogg" volume 0.75
asset voice greeting = "asset/voice.wav" volume 0.5
asset se click = "asset/click.wav"
float momentary = 0.25
scene main {
  volume bgm 0.4
  dialog opacity 0.8
  say narrator "一行だけ" opacity 0.6
  play voice greeting volume momentary blocking
  play bgm music volume 0.9 crossfade 250
  play se click volume 0.2
}
`;
  const parsed = parse(source);
  checkTypes(parsed);
  const compiled = compile(parsed);
  assert.equal(compiled.assets.find(asset => asset.name === 'music').volume, 0.75);
  assert.equal(compiled.assets.find(asset => asset.name === 'greeting').volume, 0.5);
  assert.equal(compiled.scenes[0].instructions.find(instruction => instruction.op === 'command' && instruction.name === 'say').args[2].value, 'opacity');
  assert.throws(() => parse('asset bgm music = "asset/music.ogg" volume 1.2'), /0.0 から 1.0/);
  assert.throws(() => checkTypes(parse('asset bgm music = "asset/music.ogg"\nscene main { play bgm music volume 2.0 }')), /0.0 から 1.0/);
  assert.throws(() => checkTypes(parse('scene main { dialog opacity 1.5 }')), /0.0 から 1.0/);
  assert.throws(() => checkTypes(parse('const float too_loud = 1.5\nscene main { volume bgm too_loud }')), /0.0 から 1.0/);
  assert.throws(() => checkTypes(parse('const float too_opaque = 1.2\nscene main { say narrator "test" opacity too_opaque }')), /0.0 から 1.0/);
});

test('reports struct field diagnostics with the language term used by the syntax', () => {
  assert.throws(() => parse('struct User { : int }'), /field nameを指定してください/);
  assert.throws(() => parse('struct User { age: string }'), /struct field の type は int、float、str、bool/);
  assert.throws(() => parse('struct User { age: int\n age: int }'), /struct field 'age' が重複しています/);
});

test('parses and type-checks named structs with field access', () => {
  const script = parse(`
    struct User {
      name: str
      age: int
    }
    User user = { "name": "太郎", "age": 20 }
    set user.age = 21
    say "{user}"
  `);
  assert.doesNotThrow(() => checkTypes(script));
  assert.equal(compile(script).globals[1].op, 'set');
  assert.throws(() => checkTypes(parse('struct User { age: int }\nUser user = { "age": "bad" }')), /field 'age' の型が一致しません/);
});

test('parses postfix field and index access in source order', () => {
  const script = parse('int result = root.field[0].tail');
  const expression = script.globals[0].initial;
  assert.equal(expression.kind, 'index');
  assert.equal(expression.key.value, 'tail');
  assert.equal(expression.target.kind, 'index');
  assert.equal(expression.target.key.value, 0);
  assert.equal(expression.target.target.key.value, 'field');
});

test('accepts empty and trivia-only source as an empty script', () => {
  for (const source of ['', ' \t\n', '# comment only\n// another comment']) {
    const script = parse(source);
    assert.deepEqual(script.globals, [], 'empty source has no global statements');
    assert.deepEqual(script.scenes, [], 'empty source has no scenes');
    assert.deepEqual(script.functions, [], 'empty source has no functions');
    assert.deepEqual(script.includes, [], 'empty source has no includes');
  }
});

test('parenthesized expressions remain valid postfix targets', () => {
  const expression = parse('int result = (root.field)[0].tail').globals[0].initial;
  assert.equal(expression.kind, 'index');
  assert.equal(expression.key.value, 'tail');
  assert.equal(expression.target.kind, 'index');
  assert.equal(expression.target.key.value, 0);
  assert.equal(expression.target.target.kind, 'index');
  assert.equal(expression.target.target.key.value, 'field');
});

test('struct fields treat object prototype names as ordinary declared fields', () => {
  const script = parse(`
    struct UserFields {
      constructor: int
      __proto__: str
    }
    UserFields user = { "constructor": 1, "__proto__": "plain data" }
    set user.constructor = 2
    say narrator user.__proto__
  `);
  assert.equal(Object.hasOwn(script.structs[0].fields, '__proto__'), true);
  assert.equal(Object.hasOwn(script.structs[0].fieldLocations, '__proto__'), true);
  assert.deepEqual(script.structs[0].fieldLocations.__proto__, { line: 4, column: 7 });
  assert.doesNotThrow(() => checkTypes(script));
  assert.doesNotThrow(() => compile(script));
  assert.throws(() => checkTypes(parse(`
    struct UserFields { name: str }
    UserFields user = { "name": "ok", "toString": "not a field" }
  `)), /field.*toString.*ありません/);
});

test('allows struct types to be referenced before their declaration', () => {
  const script = parse(`
    User player = { "name": "Yui", "age": 17 }
    struct User {
      name: str
      age: int
    }
    scene main {
      say narrator player.name
    }
  `);
  assert.equal(script.globals[0].type.kind, 'struct');
  assert.doesNotThrow(() => checkTypes(script));
});

test('parses logical conditions and choice expressions', () => {
  const script = parse(`
    int score = 0
    int route = 0
    int next_score = 0
    scene branch {
      choice "どこへ？" {
        "学校" {
          set score = score + 1
        }
        "家" {
          set score = score
        }
      }
      if (score >= 10 and route == 1) or not route == 2 {
        say narrator "分岐"
      }
    }
  `);
  const choice = script.scenes[0].body[0];
  assert.equal(choice.kind, 'choice');
  assert.equal(choice.prompt.value, 'どこへ？');
  assert.equal(choice.options[0].label.value, '学校');
  assert.equal(choice.options[0].body[0].kind, 'set');
  assert.equal(script.scenes[0].body[1].condition.expression.kind, 'binary');
});

test('reports unterminated strings', () => {
  assert.throws(() => parse('say narrator "broken'), /string literal が閉じられていません（1行、14列）/);
});

test('records asset and character pose source positions at the path text', () => {
  const assetSource = 'asset image cover = "asset/cover.png"';
  const asset = parse(assetSource).assets[0];
  assert.equal(asset.line, 1);
  assert.equal(asset.column, assetSource.indexOf('asset/cover.png') + 1);

  const poseSource = 'character hero { pose normal = "asset/hero.png" }';
  const pose = parse(poseSource).characters[0].poses[0];
  assert.equal(pose.line, 1);
  assert.equal(pose.column, poseSource.indexOf('asset/hero.png') + 1);
});

test('treats all supported external line separators as DSL newlines', () => {
  for (const separator of ['\r\n', '\r', '\u2028', '\u2029']) {
    const script = parse(`int first = 1${separator}int second = 2`);
    assert.deepEqual(script.globals.map(statement => statement.name), ['first', 'second']);
  }
});

test('accepts a leading UTF-8 BOM without shifting token locations', () => {
  const script = parse('\uFEFFsay narrator "hello"');
  assert.equal(script.globals[0].line, 1);
  assert.equal(script.globals[0].column, 1);
  assert.throws(() => parse('say narrator "before"\uFEFF\nsay narrator "after"'), /不明な文字/);
});

test('lexer syntax errors retain the exact invalid-character and unterminated-string spans', () => {
  const { tokenize } = require('../dist');
  assert.throws(() => tokenize('scene main {\n  say narrator "ok"\n  §\n}'), (error) => {
    assert.equal(error.token.line, 3);
    assert.equal(error.token.column, 3);
    assert.equal(error.token.value, '§');
    return true;
  });
  assert.throws(() => tokenize('scene main {\n  say narrator "unfinished'), (error) => {
    assert.equal(error.token.line, 2);
    assert.equal(error.token.column, 16);
    assert.equal(error.token.value, '"unfinished');
    return true;
  });
  assert.throws(() => tokenize('😀'), (error) => {
    assert.equal(error.token.value, '😀');
    assert.equal(error.token.value.length, 2);
    return true;
  });
});

test('treats a mid-file BOM according to string and comment context', () => {
  const value = parse('str text = "before\uFEFFafter"').globals[0].initial.value;
  assert.equal(value, 'before\uFEFFafter', 'a BOM inside a string remains literal text');
  assert.doesNotThrow(() => parse('say narrator "before" # comment\uFEFF\nsay narrator "after"'), 'a BOM inside a line comment is ignored with the comment');
  assert.throws(() => parse('say narrator "before"\uFEFF\nsay narrator "after"'), /不明な文字/, 'a BOM in ordinary code remains invalid');
});

test('rejects non-canonical Windows separators in asset paths', () => {
  assert.throws(() => compile(parse('asset bg school = "asset\\\\bg\\\\mori.jpg"')), /asset path/i);
});

test('reports malformed dictionary and blocks at exact locations', () => {
  assert.throws(() => parse('dict[int] x = {foo: 1}\n'), /dict の key には string literal を指定してください/);
  assert.throws(() => checkTypes(parse('dict[str] x = {"same": "first", "same": "second"}')), /dict の key .* が重複/);
  assert.throws(() => parse('scene broken {\n  say narrator "x"\n'), /'}' が必要です/);
});

test('rejects unknown escapes and non-canonical asset paths', () => {
  assert.throws(() => parse(String.raw`say "hello\q"`), /不明な escape sequence/);
  assert.throws(() => parse(String.raw`str value = "hello\q"`), /不明な escape sequence/);
  assert.throws(() => parse(String.raw`dict[str] values = {"key\q": "value"}`), /不明な escape sequence/);
  assert.throws(() => parse(String.raw`character hero { name = "Hero\q" }`), /不明な escape sequence/);
  assert.throws(() => parse(String.raw`asset bg school = "asset\q\mori.jpg"`), /不明な escape sequence/);
  assert.throws(() => parse(String.raw`character hero { pose normal = "asset\q\hero.png" }`), /不明な escape sequence/);
  assert.throws(() => parse(String.raw`include "chapter\q.tds"`), /不明な escape sequence/);
  const astralEscape = String.raw`say "x\🚀"`;
  assert.throws(() => parse(astralEscape), error => {
    assert.equal(error.startColumn, astralEscape.indexOf('🚀') + 1);
    assert.equal(error.endColumn, astralEscape.indexOf('🚀') + 3);
    return true;
  });
  assert.throws(() => parse(String.raw`goto "chapter\q.tds"`), /不明な escape sequence/);
  assert.throws(() => compile(parse(String.raw`asset bg school = "asset\\bg\\mori.jpg"`)), /asset path/i);
});

test('speakerless say accepts any string expression that starts with a string literal', () => {
  const script = parse('str name = "ユイ"\nscene main { say "こんにちは、" + name }');
  assert.doesNotThrow(() => checkTypes(script));
  const say = script.scenes[0].body[0];
  assert.equal(say.kind, 'command');
  assert.equal(say.args[0].value, 'narrator');
  assert.equal(say.args[1].kind, 'binary');
  assert.throws(() => parse('scene main { say name }'), /say body.*\u5f15\u7528\u7b26/);
});

test('preserves engine commands and scene transitions for the browser player', () => {
  const program = compile(parse(`
    asset bgm theme = "asset/bgm/theme.ogg"
    asset se click = "asset/se/click.wav"
    asset voice hello = "asset/voice/hello.wav"
    character hero {
      name = "Hero"
      pose normal = "asset/chara/hero/normal.png"
    }
    int route = 0
    scene start {
      bgm theme
      show hero.normal center
      play se click
      play voice hello
      wait 100
      choice "Choose" {
        "Next" {
          set route = 1
        }
      }
      goto ending
    }
    scene ending {
      say narrator "The end"
    }
  `));
  const instructions = program.scenes[0].instructions;
  assert.deepEqual(instructions.map((item) => item.op), ['command', 'command', 'command', 'command', 'command', 'choice', 'goto']);
  assert.equal(instructions[6].scene, 'ending');
  assert.equal(program.characters[0].poses[0].path, 'asset/chara/hero/normal.png');
});

test('rejects an initializer whose type does not match its declaration', () => {
  assert.throws(() => compile(parse('int arg = "0"\n')), /arg は int ですが、str が代入されています/);
});

test('collects expression and interpolation references', () => {
  const variables = compile(parse('str arg = "0"\nsay narrator "{arg}"\n')).variables;
  assert.deepEqual(variables[0].references, [
    { scope: 'global', container: 'global', line: 2, column: 16, kind: 'interpolation' },
  ]);
});

test('records exact interpolation columns after escaped characters and parameter definition ranges', () => {
  const source = 'fn render(value: str) -> none { say narrator "escaped \\\"quote\\\" {value}" }';
  const variables = compile(parse(source)).variables;
  const parameter = variables.find((variable) => variable.name === 'value');
  assert.deepEqual(parameter.definitions, [{ scope: 'function', container: 'render', line: 1, column: 11, kind: 'definition' }]);
  assert.deepEqual(parameter.references, [{ scope: 'function', container: 'render', line: 1, column: source.indexOf('{value}') + 2, kind: 'interpolation' }]);
});

test('accepts globals supplied by the project variable table', () => {
  const program = compile(parse('say narrator str(route)'), new Map([['route', 'int']]));
  assert.equal(program.globals[0].args[1].kind, 'call');
  assert.equal(program.globals[0].args[1].name, 'str');
});

// Phase 8: 項目64 新規テストケース
test('variable definitions point to declaration and loop identifier columns', () => {
  const variables = compile(parse('fn f() -> none {\n  int local = 1\n  for item from 0 to 1 {\n    say narrator str(item)\n  }\n}')).variables;
  const local = variables.find((variable) => variable.name === 'local');
  const item = variables.find((variable) => variable.name === 'item');
  assert.deepEqual(local.definitions, [{ scope: 'function', container: 'f', line: 2, column: 7, kind: 'definition' }]);
  assert.deepEqual(item.definitions, [{ scope: 'local', container: 'f:for1', line: 3, column: 7, kind: 'definition' }]);
});

test('parses arithmetic operators without whitespace dependency', () => {
  const script = parse(`
    int a = 1+2*3-4/2
  `);
  assert.equal(script.globals[0].initial.kind, 'binary');
  const program = compile(script);
  assert.ok(program);
});

test('parses if conditions without strict whitespace around expressions and braces', () => {
  const script = parse(`
    scene compact {
      if(1==1){
        say narrator "compact"
      }
      if 2>=1
      {
        say narrator "next-line brace"
      }
    }
  `);
  assert.equal(script.scenes[0].body.length, 2);
  assert.equal(script.scenes[0].body[0].kind, 'if');
  assert.equal(script.scenes[0].body[1].kind, 'if');
});

test('parses multi-line dictionary literal', () => {
  const script = parse(`
    dict[int] d = {
      "a": 1,
      "b": 2
    }
  `);
  assert.equal(script.globals[0].initial.kind, 'dict');
  assert.equal(script.globals[0].initial.entries.length, 2);
});

test('parses command immediately after if block without else', () => {
  const script = parse(`
    scene main {
      if 1 == 1 {
        say narrator "inside"
      }
      say narrator "outside"
    }
  `);
  assert.equal(script.scenes[0].body.length, 2);
  assert.equal(script.scenes[0].body[0].kind, 'if');
  assert.equal(script.scenes[0].body[1].kind, 'command');
});

test('precedence of not correctly captures comparison expressions', () => {
  const script = parse(`
    scene main {
      if not 1 == 2 {
        say narrator "ok"
      }
    }
  `);
  const cond = script.scenes[0].body[0].condition.expression;
  assert.equal(cond.kind, 'unary');
  assert.equal(cond.operator, 'not');
  assert.equal(cond.value.kind, 'binary');
  assert.equal(cond.value.operator, '==');
});

test('binary operator precedence and equal-precedence operators are left associative', () => {
  const expressions = parse(`
    global int arithmetic = 1 + 2 * 3 - 4 / 2 % 2
    global bool logic = true or false and not false == true
    global bool comparison = 1 < 2 == true
  `).globals.map((declaration) => declaration.initial);

  const arithmetic = expressions[0];
  assert.equal(arithmetic.operator, '-');
  assert.equal(arithmetic.left.operator, '+');
  assert.equal(arithmetic.left.right.operator, '*');
  assert.equal(arithmetic.right.operator, '%');
  assert.equal(arithmetic.right.left.operator, '/');

  const logic = expressions[1];
  assert.equal(logic.operator, 'or');
  assert.equal(logic.right.operator, 'and');
  assert.equal(logic.right.right.operator, 'not');
  assert.equal(logic.right.right.value.operator, '==');

  const comparison = expressions[2];
  assert.equal(comparison.operator, '==');
  assert.equal(comparison.left.operator, '<');
});

test('type checks elif condition for boolean expression', () => {
  const badScript = parse(`
    scene main {
      if 1 == 1 {
        say narrator "a"
      } elif 123 {
        say narrator "b"
      }
    }
  `);
  assert.throws(() => checkTypes(badScript), /条件式には比較演算子.*または論理式が必要です/);
});

test('type checks string concatenation and rejects non-str operands', () => {
  const okScript = parse(`
    str a = "hello" + " world"
  `);
  assert.doesNotThrow(() => checkTypes(okScript));

  const badScript = parse(`
    str b = "num: " + 10
  `);
  assert.throws(() => checkTypes(badScript), /'\+' の左右の型が一致していません/);
});

test('type checks recursive function call rejection (direct and indirect)', () => {
  const directRec = parse(`
    fn rec(x: int) -> none {
      rec(x - 1)
    }
  `);
  assert.throws(() => checkTypes(directRec), /関数の再帰呼び出しは禁止されています.*rec -> rec/);

  const indirectRec = parse(`
    fn funcA() -> none {
      funcB()
    }
    fn funcB() -> none {
      funcA()
    }
  `);
  assert.throws(() => checkTypes(indirectRec), /関数の再帰呼び出しは禁止されています/);
});

test('type checks duplicate declarations and invalid declaration placement in scene', () => {
  const dupLet = parse(`
    int x = 1
    int x = 2
  `);
  assert.throws(() => checkTypes(dupLet), /'x' が重複して宣言されています/);

  const letInScene = parse(`
    scene main {
      int y = 10
    }
  `);
  assert.throws(() => checkTypes(letInScene), /scene 直下での変数宣言は禁止されています/);

  const shadowedChoiceVariable = parse(`
    int j = 0
    choice "please" {
      "a" { int j = 2 }
      "b" { }
    }
  `);
  assert.throws(() => checkTypes(shadowedChoiceVariable), /変数 'j' は既に宣言されています.*set/);

  assert.throws(
    () => compile(parse('int j = 2'), new Map([['j', 'int']])),
    /変数 'j' は既に宣言されています.*set/
  );
});

test('supports 64-bit integer values without loss of precision', () => {
  const script = parse(`
    int large = 9007199254740993
  `);
  assert.equal(typeof script.globals[0].initial.value, 'bigint');
  assert.equal(script.globals[0].initial.value.toString(), '9007199254740993');
  const program = compile(script);
  assert.equal(program.globals[0].initial.value.toString(), '9007199254740993');
});

test('emits concrete runtime declarations', () => {
  const script = parse(`
    int count = 1 + 2
    str title = "Novel"
    dict[int] scores = { "first": 10 }
  `);
  const program = compile(script);
  assert.deepEqual(program.globals.map((entry) => entry.type), ['int', 'str', { kind: 'dict', value: 'int' }]);
  assert.equal(script.globals[0].inferred, undefined);
});

test('analyzes constant if branches and unreachable statements', () => {
  const diagnostics = analyzeScript(parse(`
    scene main {
      if 1 == 2 {
        say narrator "never"
      } elif 3 > 1 {
        goto ending
      } else {
        say narrator "also never"
      }
      say narrator "after goto"
    }
    scene ending { say narrator "end" }
  `));
  assert.ok(diagnostics.some((item) => item.code === 'constant-condition' && item.severity === 'warning'));
  assert.ok(diagnostics.some((item) => item.code === 'unreachable-branch'));
  assert.ok(diagnostics.some((item) => item.code === 'unreachable-code'));
});

test('float constants are propagated through conditions in diagnostics and optimized code', () => {
  const script = parse(`
    const float half = 0.5
    scene main {
      if half + 0.25 == 0.75 {
        wait 1
      } else {
        say narrator "unreachable float branch"
      }
    }
  `);
  const diagnostics = analyzeScript(script);
  assert.ok(diagnostics.some((item) => item.code === 'constant-condition' && item.severity === 'info'));
  assert.ok(diagnostics.some((item) => item.code === 'unreachable-branch'));
  const program = compile(script);
  const instructions = program.scenes.find((scene) => scene.name === 'main').instructions;
  assert.deepEqual(instructions.map((instruction) => instruction.op), ['command']);
  assert.equal(instructions[0].name, 'wait');
});

test('float division by zero and overflow are diagnosed statically', () => {
  const diagnostics = analyzeScript(parse(`
    scene main {
      if 1.0 / 0.0 > 0.0 { wait 1 }
      if 1e308 * 1e308 > 0.0 { wait 1 }
    }
  `));
  assert.ok(diagnostics.some((item) => item.code === 'division-by-zero' && item.severity === 'warning'));
  assert.ok(diagnostics.some((item) => item.code === 'float-overflow' && item.severity === 'error' && item.message === 'float の演算結果が表現可能な範囲を超えます'));
  assert.throws(() => parse('float value = 1e309'), /float literal/);
  assert.doesNotThrow(() => compile(parse('float value = 5e-324')), 'finite subnormal literals remain valid');
});

test('numeric literal syntax matches the documented decimal and exponent forms', () => {
  assert.doesNotThrow(() => parse('float a = 12.0\nfloat b = 0.25\nfloat c = 1e3\nfloat d = 2.5E-2'));
  assert.throws(() => parse('float value = .5'), /\u5f0f\u3092\u6307\u5b9a/);
  assert.throws(() => parse('float value = 5.'), /1行、17列/);
  assert.throws(() => parse('float value = 1e+'), /\u884c\u672b/);
});

test('float arithmetic is evaluated before rejecting out-of-range show offsets', () => {
  const source = `character hero {
    name = "Hero"
    pose normal = "asset/hero.png"
  }
  scene main { show hero.normal center x+(500001.0 * 2.0) }`;
  assert.throws(() => checkTypes(parse(source)), /1000000 px/);
  const constantSource = `const float shift = 500001.0
  character hero {
    name = "Hero"
    pose normal = "asset/hero.png"
  }
  scene main { show hero.normal center x+(shift * 2.0) }`;
  assert.throws(() => checkTypes(parse(constantSource)), /1000000 px/);
  assert.throws(() => checkTypes(parse('const float shift = 500001.0\nscene main { move bg by x+(shift * 2.0) }')), /1000000 px/);
  assert.throws(() => checkTypes(parse(`character hero {
    name = "Hero"
    pose normal = "asset/hero.png"
  }
  fn place() -> none {
    const float shift = 500001.0
    show hero.normal center x+(shift * 2.0)
  }`)), /1000000 px/);
  assert.doesNotThrow(() => checkTypes(parse(`const float shift = 500001.0
    character hero {
      name = "Hero"
      pose normal = "asset/hero.png"
    }
    fn place(shift: float) -> none { show hero.normal center x+(shift) }
    scene main { wait 1 }`)));
  assert.doesNotThrow(() => checkTypes(parse(`const float shift = 500001.0
    character hero {
      name = "Hero"
      pose normal = "asset/hero.png"
    }
    fn place(flag: int) -> none {
      if flag == 0 { float shift = 1.0 } else { float shift = 2.0 }
      show hero.normal center x+(shift)
    }`)));
});

test('parallel character shows cannot compete for the same exclusive slot', () => {
  const source = `character first {
    name = "First"
    pose normal = "asset/first.png"
  }
  character second {
    name = "Second"
    pose normal = "asset/second.png"
  }
  scene main {
    parallel {
      show first.normal left fade 300
      show second.normal left fade 500
    }
  }`;
  assert.throws(() => checkTypes(parse(source)), error => {
    assert.match(error.message, /same target|同じ対象/);
    assert.match(error.message, /line 12, column 7/, 'nested parallel command errors point at the offending child command');
    return true;
  });
  assert.doesNotThrow(() => checkTypes(parse(source.replace('second.normal left', 'second.normal right'))));
});
test('warns about statically conflicting character slots without rejecting intentional switches', () => {
  const diagnostics = analyzeScript(parse(`
    character hero {
      pose normal = "asset/hero-normal.png"
      pose smile = "asset/hero-smile.png"
    }
    character friend {
      pose normal = "asset/friend-normal.png"
    }
    scene main {
      show hero.normal left
      show hero.smile left
      show friend.normal left
      hide friend
      show friend.normal left
    }
  `));
  const conflicts = diagnostics.filter((item) => item.code === 'character-slot-conflict');
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].line, 12);
  assert.equal(conflicts[0].severity, 'warning');
});

test('runtime character existence refines only reachable branches for dynamic move checks', () => {
  const diagnostics = analyzeScript(parse(`
fn guarded(id: str) -> none {
  if runtime.state.characters.exists(id) {
    move character (id) by x+1
  } else {
    move character (id) by x+1
  }
}
character ayase {
  name = "Ayase"
  pose normal = "asset/ayase.png"
}
scene main {
  show ayase.normal left
  if runtime.state.characters.exists("ayase") {
    move character "ayase" by x+1
  } else {
    move character "ayase" by x+1
  }
}`));
  const warnings = diagnostics.filter(item => item.code === 'move-unshown-character');
  assert.equal(warnings.length, 1, 'the false branch for the parameter is unsafe; the proven true and impossible branches are not');
  assert.match(warnings[0].message, /id/);
});

test('runtime character list stays dynamic and cannot be mistaken for compile-time proof', () => {
  const diagnostics = analyzeScript(parse(`
fn guarded_by_list(id: str) -> none {
  if list.contains(runtime.state.characters.list(), id) {
    move character (id) by x+1
  }
}
`));
  assert.ok(diagnostics.some(item => item.code === 'move-unshown-character'),
    'only a runtime predicate with a declared compile-analysis contract may prove character presence');
});

test('character-presence path overflow joins facts instead of dropping feasible paths', () => {
  const parameters = Array.from({ length: 7 }, (_, index) => `id${index + 1}: str`).join(', ');
  const guards = Array.from({ length: 7 }, (_, index) => `if runtime.state.characters.exists(id${index + 1}) { wait 1 }`).join('\n');
  const diagnostics = analyzeScript(parse(`fn stress(${parameters}) -> none {
${guards}
  if runtime.state.characters.exists(id1) { wait 1 }
  else { move character id1 by x+1 }
}`));
  assert.ok(diagnostics.some(item => item.code === 'move-unshown-character'),
    'after the state cap, the false id1 path must remain possible rather than being unsoundly discarded');
});

test('character-existence facts are invalidated by dependent writes but survive unrelated writes', () => {
  const diagnostics = analyzeScript(parse(`
global str target = "ayase"
global int unrelated = 0
character ayase {
  name = "Ayase"
  pose normal = "asset/ayase.png"
}
fn replace_target() -> none { set target = text.trim("ghost") }
fn safe_with_unrelated_write(id: str) -> none {
  if runtime.state.characters.exists(id) {
    set unrelated = 1
    move character (id) by x+1
  }
}
scene main {
  show ayase.normal left
  if runtime.state.characters.exists(target) {
    set target = text.trim("ghost")
    move character (target) by x+1
  }
  set target = "ayase"
  if runtime.state.characters.exists(target) {
    replace_target()
    move character (target) by x+1
  }
}`));
  const warnings = diagnostics.filter(item => item.code === 'move-unshown-character');
  assert.equal(warnings.length, 2, 'both a direct assignment and a called function that rewrites the queried value must invalidate the proof');
  assert.ok(warnings.every(item => /target/.test(item.message)));
});

test('warns when hide targets a character that is not currently shown', () => {
  const diagnostics = analyzeScript(parse(`
    character hero {
      name = "Hero"
      pose normal = "asset/hero.png"
    }
    scene main {
      hide hero
      show hero.normal left
      hide hero
    }
  `));
  const warnings = diagnostics.filter((item) => item.code === 'hide-unshown-character');
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].line, 7);
  assert.equal(warnings[0].column, 7);
  assert.equal(warnings[0].endColumn, 16);
});

test('warns when clear image targets an image that is not currently shown', () => {
  const diagnostics = analyzeScript(parse(`
    asset image logo = "asset/logo.png"
    scene main {
      clear image logo
      show image logo center
      clear image logo
    }
  `));
  const warnings = diagnostics.filter((item) => item.code === 'clear-unshown-image');
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].line, 4);
  assert.equal(warnings[0].severity, 'warning');
  assert.equal(warnings[0].column, 7);
  assert.equal(warnings[0].endColumn, 23);
});

test('warns when distinct images occupy the same slot', () => {
  const diagnostics = analyzeScript(parse(`
    asset image first = "asset/first.png"
    asset image second = "asset/second.png"
    scene main {
      show image first center
      show image second center
      clear image first
      show image second center
    }
  `));
  const warnings = diagnostics.filter((item) => item.code === 'image-slot-conflict');
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].line, 6);
  assert.equal(warnings[0].severity, 'warning');
  assert.equal(warnings[0].column, 7);
  assert.equal(warnings[0].endColumn, 31);
});

test('checks character slot conflicts independently on branch and loop paths', () => {
  const diagnostics = analyzeScript(parse(`
    character hero { pose normal = "asset/hero.png" }
    character friend { pose normal = "asset/friend.png" }
    scene main {
      if n == 1 {
        show hero.normal center
        show friend.normal center
      } else {
        show friend.normal far_right
      }
      while n == 1 {
        show hero.normal right
        show friend.normal right
      }
    }
  `), 'current', new Map([['n', 'int']]));
  assert.equal(diagnostics.filter((item) => item.code === 'character-slot-conflict').length, 2);
});

test('warns when a branch-dependent character hide is a no-op on one path', () => {
  const diagnostics = analyzeScript(parse(`
    int route = 0
    character hero { pose normal = "asset/hero.png" }
    scene main {
      if route == 1 {
        show hero.normal center
      } else {
        wait 1
      }
      hide hero
    }
  `));
  const warnings = diagnostics.filter((item) => item.code === 'hide-unshown-character');
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].line, 10);
  assert.equal(warnings[0].column, 7);
  assert.equal(warnings[0].endColumn, 16);
});

test('reports each possible branch occupant when a later show replaces a merged slot', () => {
  const diagnostics = analyzeScript(parse(`
    int route = 0
    character hero { pose normal = "asset/hero.png" }
    character friend { pose normal = "asset/friend.png" }
    character rival { pose normal = "asset/rival.png" }
    scene main {
      if route == 1 {
        show hero.normal center
      } else {
        show friend.normal center
      }
      show rival.normal center
    }
  `));
  const conflicts = diagnostics.filter((item) => item.code === 'character-slot-conflict');
  assert.equal(conflicts.length, 2);
  assert.ok(conflicts.every((item) => item.line === 12 && item.column === 7 && item.endColumn === 31));
  assert.ok(conflicts.some((item) => item.message.includes("character 'hero'")));
  assert.ok(conflicts.some((item) => item.message.includes("character 'friend'")));
});

test('reports each possible branch image when a later image overlays a merged slot', () => {
  const diagnostics = analyzeScript(parse(`
    int route = 0
    asset image first = "asset/first.png"
    asset image second = "asset/second.png"
    asset image final = "asset/final.png"
    scene main {
      if route == 1 {
        show image first center
      } else {
        show image second center
      }
      show image final center
    }
  `));
  const conflicts = diagnostics.filter((item) => item.code === 'image-slot-conflict');
  assert.equal(conflicts.length, 2);
  assert.ok(conflicts.every((item) => item.line === 12 && item.column === 7 && item.endColumn === 30));
  assert.ok(conflicts.some((item) => item.message.includes("\u753b\u50cf 'first'")));
  assert.ok(conflicts.some((item) => item.message.includes("\u753b\u50cf 'second'")));
});

test('does not report character slot conflicts after a terminating transfer', () => {
  const diagnostics = analyzeScript(parse(`
    character hero { pose normal = "asset/hero.png" }
    character friend { pose normal = "asset/friend.png" }
    scene main {
      show hero.normal center
      goto end
      show friend.normal center
    }
    scene end { wait 1 }
  `));
  assert.equal(diagnostics.some((item) => item.code === 'character-slot-conflict'), false);
});

test('warns when background or BGM is replaced without an explicit clear', () => {
  const diagnostics = analyzeScript(parse(`
    asset bg first = "asset/first.png"
    asset bg second = "asset/second.png"
    asset bgm calm = "asset/calm.ogg"
    asset bgm tense = "asset/tense.ogg"
    asset bgm transition = "asset/transition.ogg"
    scene main {
      bg first
      bg second
      bgm calm
      play bgm tense
      play bgm transition crossfade 900
      clear bg
      clear bgm
      bg second
      bgm tense
    }
  `));
  const background = diagnostics.filter((item) => item.code === 'background-replacement');
  const bgm = diagnostics.filter((item) => item.code === 'bgm-replacement');
  assert.equal(background.length, 1);
  assert.equal(bgm.length, 1);
  assert.ok(background[0].message.includes("'first'"));
  assert.ok(background[0].message.includes("'second'"));
  assert.ok(background[0].message.includes("\u7f6e\u304d\u63db\u308f\u308a\u307e\u3059"));
  assert.ok(bgm[0].message.includes("'calm'"));
  assert.ok(bgm[0].message.includes("'tense'"));
  assert.ok(bgm[0].message.includes("\u7f6e\u304d\u63db\u308f\u308a\u307e\u3059"));
});

test('does not warn when a positive-duration BGM crossfade intentionally replaces the active track', () => {
  const diagnostics = analyzeScript(parse(`
    asset bgm calm = "asset/calm.ogg"
    asset bgm next = "asset/next.ogg"
    scene main {
      bgm calm
      play bgm next crossfade 900
    }
  `));
  assert.equal(diagnostics.some((item) => item.code === 'bgm-replacement'), false);
});

test('still warns when BGM crossfade duration can be zero or is not statically positive', () => {
  const zero = analyzeScript(parse(`
    asset bgm calm = "asset/calm.ogg"
    asset bgm next = "asset/next.ogg"
    scene main { bgm calm\nplay bgm next crossfade 0 }
  `));
  const variable = analyzeScript(parse(`
    int duration = 900
    asset bgm calm = "asset/calm.ogg"
    asset bgm next = "asset/next.ogg"
    scene main { bgm calm\nplay bgm next crossfade duration }
  `));
  assert.equal(zero.filter((item) => item.code === 'bgm-replacement').length, 1);
  assert.equal(variable.filter((item) => item.code === 'bgm-replacement').length, 1);
});

test('warns when a new video replaces an active async video layer', () => {
  const diagnostics = analyzeScript(parse(`
    asset video first = "asset/first.mp4"
    asset video second = "asset/second.mp4"
    scene main {
      play video first async
      play video second async
      play video first blocking
      play video second async
    }
  `));
  const replacements = diagnostics.filter((item) => item.code === 'video-layer-replaced');
  assert.equal(replacements.length, 2);
  assert.deepEqual(replacements.map((item) => item.line), [6, 7]);
  assert.ok(replacements.every((item) => item.column === 7 && item.endColumn > item.column));
});

test('video mode defaults to blocking in replacement analysis', () => {
  const diagnostics = analyzeScript(parse(`
    asset video first = "asset/first.mp4"
    asset video second = "asset/second.mp4"
    scene main {
      play video first
      play video second async
    }
  `));
  assert.equal(diagnostics.some(item => item.code === 'video-layer-replaced'), false,
    'the implicit blocking play has ended before the explicitly async video starts');
});

test('parses --only as a display modifier for image and video commands', () => {
  const script = parse(`
    asset image card = "asset/card.png"
    asset video op = "asset/video/op.mp4"
    scene main {
      show image card center --only
      play video "op.mp4" async --only
    }
  `);
  assert.deepEqual(script.scenes[0].body.map((statement) => statement.args.map((arg) => arg.value)), [
    ['image', 'card', 'center', '--only'],
    ['video', 'op.mp4', 'async', '--only'],
  ]);
  assert.doesNotThrow(() => compile(script));
});

test('rejects --only on non-visual media playback', () => {
  assert.throws(() => compile(parse(`
    asset se click = "asset/click.wav"
    scene main { play se click --only }
  `)), /--only/);
});

test('warns when clear bgm is path-dependent after a branch merge', () => {
  const diagnostics = analyzeScript(parse(`
    int route = 0
    asset bgm theme = "asset/theme.ogg"
    scene main {
      clear bgm
      if route == 1 {
        bgm theme
      } else {
        wait 1
      }
      clear bgm
    }
  `));
  const warnings = diagnostics.filter((item) => item.code === 'bgm-clear-path-dependent');
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].line, 11);
  assert.equal(warnings[0].column, 7);
  assert.equal(warnings[0].endColumn, 16);
  assert.equal(warnings[0].severity, 'warning');
});

test('warns when clear bg is path-dependent after a branch merge', () => {
  const diagnostics = analyzeScript(parse(`
    int route = 0
    asset bg first = "asset/first.png"
    scene main {
      clear bg
      if route == 1 {
        bg first
      } else {
        wait 1
      }
      clear bg
    }
  `));
  const warnings = diagnostics.filter((item) => item.code === 'background-clear-path-dependent');
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].line, 11);
  assert.equal(warnings[0].column, 7);
  assert.equal(warnings[0].endColumn, 15);
  assert.equal(warnings[0].severity, 'warning');
});

test('computes transitive scene reachability and excludes dead goto targets', () => {
  const transitive = analyzeScript(parse(`
    scene start { goto middle }
    scene middle { goto ending }
    scene ending { wait 1 }
  `));
  assert.equal(transitive.some((item) => item.code === 'unreachable-scene'), false);

  for (const source of [
    'scene start { if 1 == 2 { goto hidden } }\nscene hidden { wait 1 }',
    'scene start { if 1 == 1 { wait 1 } else { goto hidden } }\nscene hidden { wait 1 }',
    'scene start { while 1 == 2 { goto hidden } }\nscene hidden { wait 1 }',
  ]) {
    const diagnostics = analyzeScript(parse(source));
    assert.ok(diagnostics.some((item) => item.code === 'unreachable-scene' && /hidden/.test(item.message)));
  }
});

test('normalizes Windows separators in goto scene paths', () => {
  const program = compile(parse(String.raw`scene start { goto "first\\next.tds" }`));
  assert.equal(program.scenes[0].instructions[0].scene, 'first/next.tds');
});

test('requires external goto paths to be quoted while preserving local scene names', () => {
  const local = parse('scene start { goto next_scene }');
  assert.equal(local.scenes[0].body[0].scene, 'next_scene');
  const quoted = parse('scene start { goto "chapter-2/route.next.tds" }');
  assert.equal(quoted.scenes[0].body[0].scene, 'chapter-2/route.next.tds');
  assert.throws(() => parse('scene start { goto chapter-1/route.next.tds }'), /external scene path \u306f\u5f15\u7528\u7b26/);
  assert.throws(() => parse(String.raw`scene start { goto chapter\\next.tds }`), /external scene path \u306f\u5f15\u7528\u7b26/);
  assert.throws(() => parse('scene start { goto "chapter//route.tds" }'), /scene path が不正です/);
  assert.throws(() => parse('scene start { goto "con.tds" }'), /scene path が不正です/);
  assert.throws(() => parse('scene start { goto "chapter/next." }'), /scene path が不正です/);
  assert.throws(() => parse('include chapter / route.tds'), /include path \u306b\u7a7a\u767d/);
});

test('parses aliased module imports and qualified function calls', () => {
  const script = parse('include "math/numtd.tds" as nt\nscene main { int answer = nt.add(1, 2)\nnt.log(answer) }');
  assert.deepEqual(script.includes.map(({ path, alias }) => ({ path, alias })), [{ path: 'math/numtd.tds', alias: 'nt' }]);
  assert.deepEqual(parse('include asset/as.tds as items').includes.map(({ path, alias }) => ({ path, alias })), [{ path: 'asset/as.tds', alias: 'items' }],
    'the alias delimiter must be whitespace-separated so an `as` path segment remains part of an unquoted path');
  assert.deepEqual(parse('include as as items').includes.map(({ path, alias }) => ({ path, alias })), [{ path: 'as', alias: 'items' }]);
  assert.equal(script.scenes[0].body[0].initial.name, 'nt.add');
  assert.equal(script.scenes[0].body[1].name, 'nt.log');
  assert.throws(() => parse('include "math.tds"'), /'as' が必要です/);
  assert.throws(() => parse('include a.tds as math\ninclude b.tds as math'), /include alias 'math' \u306f\u3059\u3067\u306b\u4f7f\u7528/);
  assert.throws(() => parse('fn character() -> none {}'), /reserved|識別子|character/i);
});

test('rejects non-canonical asset path components', () => {
  assert.throws(() => checkTypes(parse('asset bg broken = "asset//bg.png"')), /asset path/i);
  assert.throws(() => checkTypes(parse('asset bg broken = "asset/./bg.png"')), /asset path/i);
  assert.throws(() => checkTypes(parse('asset bg broken = "asset/con.png"')), /asset path/i);
});

test('rejects removed compatibility spellings', () => {
  assert.throws(() => checkTypes(parse('asset bgm music = "asset/bgm/music.ogg"\nbgm music instant')));
  assert.throws(() => checkTypes(parse('character hero { name = "Hero"\npose normal = "asset/char/hero/normal.png" }\nshow hero.normal far-left')));
});

test('reports empty unreachable scenes and termination through for and while bodies', () => {
  const empty = analyzeScript(parse('scene start { wait 1 }\nscene hidden {\n}'));
  assert.ok(empty.some((item) => item.code === 'unreachable-scene' && item.line === 2));

  const loop = analyzeScript(parse(`
    scene start {
      for i from 1 to 3 { goto ending }
      wait 999
    }
    scene ending { wait 1 }
  `));
  assert.ok(loop.some((item) => item.code === 'unreachable-code' && item.line === 4));

  const transfer = analyzeScript(parse('scene start { while 1 == 1 { goto ending } }\nscene ending { wait 1 }'));
  assert.equal(transfer.some((item) => item.code === 'infinite-loop'), false);
});

test('rejects statically invalid for steps before compilation and excludes their goto targets', () => {
  for (const source of [
    'scene start { for i from 0 to 2 step 0 { goto hidden } }\nscene hidden { wait 1 }',
    'scene start { for i from 0 to 2 step -1 { goto hidden } }\nscene hidden { wait 1 }',
    'scene start { for i from 2 to 0 step 1 { goto hidden } }\nscene hidden { wait 1 }',
  ]) {
    const script = parse(source);
    const diagnostics = analyzeScript(script);
    assert.ok(diagnostics.some((item) => item.code === 'invalid-for-step' && item.severity === 'error'));
    assert.ok(diagnostics.some((item) => item.code === 'unreachable-scene' && /hidden/.test(item.message)));
    assert.throws(() => compile(script), /step|開始値/);
  }
});

test('does not treat repeated side-effectful conditions as duplicates', () => {
  const diagnostics = analyzeScript(parse(`
    int n = 0
    fn tick() -> int { set n = n + 1
      return n }
    scene start {
      if tick() == 2 { wait 1 } elif tick() == 2 { wait 2 }
    }
  `));
  assert.equal(diagnostics.some((item) => item.code === 'duplicate-condition' || item.code === 'unreachable-code'), false);
});

test('propagates immutable constants and enclosing condition facts', () => {
  const constants = analyzeScript(parse(`
    const int route = 1
    scene start {
      if route == 1 { goto live } else { goto hidden }
    }
    scene live { wait 1 }
    scene hidden { wait 1 }
  `));
  assert.ok(constants.some((item) => item.code === 'unreachable-scene' && /hidden/.test(item.message)));

  const nested = analyzeScript(parse(`
    int route = 0
    scene start {
      if route == 1 {
        if route != 1 { goto hidden }
      }
    }
    scene hidden { wait 1 }
  `));
  assert.ok(nested.some((item) => item.code === 'unreachable-scene' && /hidden/.test(item.message)));

  const covered = analyzeScript(parse(`
    int route = 0
    scene start {
      if route > 0 { wait 1 } elif route > 1 { goto hidden }
    }
    scene hidden { wait 1 }
  `));
  assert.ok(covered.some((item) => item.code === 'unreachable-branch'));
  assert.ok(covered.some((item) => item.code === 'unreachable-scene' && /hidden/.test(item.message)));
});

test('does not analyze a short-circuited expression operand as executable', () => {
  const diagnostics = analyzeScript(parse('scene start { if 1 == 2 and 10 / 0 == 1 { wait 1 } }'));
  assert.equal(diagnostics.some((item) => item.code === 'division-by-zero'), false);
});

test('suppresses secondary control-flow warnings inside already unreachable code', () => {
  const diagnostics = analyzeScript(parse('scene start { goto ending\n if 1 == 2 { wait 1 } }\nscene ending { wait 1 }'));
  assert.ok(diagnostics.some((item) => item.code === 'unreachable-code'));
  assert.equal(diagnostics.some((item) => item.code === 'constant-condition'), false);
});

test('reports the complete source range of unreachable say statements', () => {
  const diagnostics = analyzeScript(parse('scene start {\n  goto ending\n  say narrator "first"\n  say narrator "second"\n}\nscene ending { wait 1 }'));
  assert.ok(diagnostics.some((item) => item.code === 'unreachable-code' && item.line === 3));
  assert.ok(diagnostics.some((item) => item.code === 'unreachable-code' && item.line === 4));
});

test('reports complete source ranges for unreachable control-flow blocks', () => {
  const diagnostics = analyzeScript(parse(`scene start {
  goto ending
  choice "route" {
    "one" { wait 1 }
    "two" {
      if 1 == 1 { wait 2 }
    }
  }
  while 1 == 1 {
    wait 3
  }
}
scene ending { wait 1 }`));
  const ranges = diagnostics
    .filter((item) => item.code === 'unreachable-code')
    .map((item) => [item.line, item.endLine, item.endColumn]);
  assert.ok(ranges.some(([line, endLine, endColumn]) => line === 3 && endLine === 8 && endColumn === 3));
  assert.ok(ranges.some(([line, endLine, endColumn]) => line === 9 && endLine === 11 && endColumn === 3));
});

test('parser carries closing-brace columns through top-level ranges', () => {
  const script = parse(`fn helper() -> none {
  wait 1
}
scene start {
  wait 2
}`);
  assert.deepEqual([script.functions[0].endLine, script.functions[0].endColumn], [3, 1]);
  assert.deepEqual([script.scenes[0].endLine, script.scenes[0].endColumn], [6, 1]);
});

test('compiler folds stable local constants but preserves cross-file globals', () => {
  const local = compile(parse(`
    fn greet() -> none {
      const int j = 2
      if j == 2 {
        say narrator "hello"
      } else {
        say narrator "miss"
      }
    }
  `));
  assert.equal(local.functions[0].body.some((instruction) => instruction.op === 'if'), false);
  assert.equal(local.functions[0].body.at(-1).op, 'command');
  assert.equal(local.functions[0].body.at(-1).args[1].value, 'hello');

  const global = compile(parse(`
    int j = 2
    if j == 2 {
      say narrator "hello"
    } else {
      say narrator "miss"
    }
  `));
  assert.equal(global.globals.some((instruction) => instruction.op === 'if'), true);
});

test('compiler folds pure expressions and removes dead loop and terminated code', () => {
  const program = compile(parse(`
    fn fold() -> none {
      int value = 1 + 2 * 3
      str text = "no" + "vel"
      say narrator str(1 + 2)
      return
      say narrator "dead"
    }
    scene start {
      while 1 == 2 { say narrator "never" }
      goto ending
      say narrator "dead"
    }
    scene ending { say narrator "live" }
  `));
  const body = program.functions[0].body;
  assert.equal(body[0].initial.kind, 'integer');
  assert.equal(body[0].initial.value, '7');
  assert.equal(body[1].initial.value, 'novel');
  assert.equal(body[2].args[1].value, '3');
  assert.deepEqual(body.map((instruction) => instruction.op), ['declare', 'declare', 'command', 'return']);
  assert.deepEqual(program.scenes[0].instructions.map((instruction) => instruction.op), ['goto']);
});

test('compiler removes code after loops that cannot fall through', () => {
  const program = compile(parse(`
    fn while_return() -> none {
      while 1 == 1 {
        return
      }
      say narrator "dead"
    }
    fn for_return() -> none {
      for i from 0 to 1 {
        return
      }
      say narrator "dead"
    }
  `));
  assert.deepEqual(program.functions.map((fn) => fn.body.map((instruction) => instruction.op)), [
    ['while'],
    ['for'],
  ]);
});

test('compiler merges identical constants from all fall-through branches', () => {
  const merged = compile(parse(`
    fn merged(flag: int) -> none {
      int value = 0
      if flag == 1 {
        set value = 7
      } else {
        set value = 7
      }
      say narrator str(value)
    }
  `));
  const command = merged.functions[0].body.at(-1);
  assert.equal(command.op, 'command');
  assert.equal(command.args[1].kind, 'literal');
  assert.equal(command.args[1].value, '7');

  const dynamic = compile(parse(`
    fn dynamic(flag: int) -> none {
      int value = 0
      if flag == 1 {
        set value = 7
      }
      say narrator str(value)
    }
  `));
  const dynamicCommand = dynamic.functions[0].body.at(-1);
  assert.equal(dynamicCommand.args[1].kind, 'call');
});

test('compiler merges identical constants from all choice options', () => {
  const program = compile(parse(`
    int value = 0
    scene selected {
      set value = 0
      choice "pick" {
        "a" { set value = 9 }
        "b" { set value = 9 }
      }
      say narrator str(value)
    }
  `));
  const command = program.scenes[0].instructions.at(-1);
  assert.equal(command.op, 'command');
  assert.equal(command.args[1].kind, 'literal');
  assert.equal(command.args[1].value, '9');
});

test('compiler keeps a condition when a called function can change its global', () => {
  const program = compile(parse(`
    int j = 2
    fn change() -> none { set j = 3 }
    change()
    if j == 2 { say narrator "hello" } else { say narrator "miss" }
  `));
  assert.equal(program.globals.at(-1).op, 'if');
});

test('compiler does not treat shadowed function locals as global effects', () => {
  const program = compile(parse(`
    int state = 42
    fn local() -> none {
      int state = 1
      set state = 2
    }
    fn check() -> int {
      int state = 0
      local()
      if state == 0 { return 1 } else { return 0 }
    }
    int result = check()
  `));
  const check = program.functions.find((fn) => fn.name === 'check');
  assert.deepEqual(check.body.map((instruction) => instruction.op), ['declare', 'call', 'return']);
  assert.equal(check.body.at(-1).value.value, '1');
});

test('compiler does not invalidate a caller local for a same-named global effect', () => {
  const program = compile(parse(`
    int state = 42
    fn change_global() -> none { set state = 7 }
    fn check() -> int {
      int state = 0
      change_global()
      if state == 0 { return 1 } else { return 0 }
    }
    int result = check()
  `));
  const check = program.functions.find((fn) => fn.name === 'check');
  assert.deepEqual(check.body.map((instruction) => instruction.op), ['declare', 'call', 'return']);
  assert.equal(check.body.at(-1).value.value, '1');
});

test('compiler keeps a condition after a mutating function call inside an expression', () => {
  const program = compile(parse(`
    int j = 2
    fn change() -> int { set j = 3
      return 0 }
    int ignored = change()
    if j == 2 { say narrator "hello" } else { say narrator "miss" }
  `));
  assert.equal(program.globals.at(-1).op, 'if');
});

test('float variable-table domains drive diagnostics and compiler branch folding', () => {
  const external = new Map([['ratio', 'float']]);
  external.constraints = new Map([['ratio', { type: 'float', floatMin: 0.25, floatMax: 0.5, floatValues: new Set([0.25, 0.5]) }]]);
  const script = parse(`scene main {
    if ratio > 0.75 { say narrator "impossible" } else { wait 1 }
  }`);
  const diagnostics = analyzeScript(script, 'current', external);
  assert.ok(diagnostics.some((item) => item.code === 'constant-condition'));
  const program = compile(script, external);
  assert.deepEqual(program.scenes[0].instructions.map((instruction) => instruction.op), ['command']);
  assert.equal(program.scenes[0].instructions[0].name, 'wait');
});

test('float domains are refined inside branches without discarding possible values', () => {
  const external = new Map([['ratio', 'float']]);
  external.constraints = new Map([['ratio', { type: 'float', floatMin: 0.25, floatMax: 0.5, floatValues: new Set([0.25, 0.5]) }]]);
  const script = parse(`scene main {
    if ratio >= 0.5 {
      if ratio < 0.5 { say narrator "impossible after refinement" } else { wait 2 }
    }
  }`);
  const diagnostics = analyzeScript(script, 'current', external);
  assert.ok(diagnostics.some((item) => item.code === 'constant-condition'));
  const program = compile(script, external);
  assert.equal(program.scenes[0].instructions[0].op, 'if');
  assert.deepEqual(program.scenes[0].instructions[0].body.map((instruction) => instruction.op), ['command']);
  assert.equal(program.scenes[0].instructions[0].body[0].name, 'wait');
});

test('float finite domains prove exhaustive equality branches', () => {
  const external = new Map([['ratio', 'float']]);
  external.constraints = new Map([['ratio', { type: 'float', floatValues: new Set([0.25, 0.5]) }]]);
  const script = parse(`scene main {
    if ratio == 0.25 { wait 1 } elif ratio == 0.5 { wait 2 }
  }`);
  const diagnostics = analyzeScript(script, 'current', external);
  assert.equal(diagnostics.some((item) => item.code === 'non-exhaustive-condition'), false);
  const instructions = compile(script, external).scenes[0].instructions;
  assert.deepEqual(instructions.map((instruction) => instruction.op), ['if']);
  assert.equal(instructions[0].body[0].name, 'wait');
  assert.equal(instructions[0].elseIf[0].body[0].name, 'wait');

  const copied = parse(`float copy = 0.0
scene main {
  set copy = ratio * 2.0
  if copy == 0.5 { wait 1 } elif copy == 1.0 { wait 2 }
}`);
  const copiedDiagnostics = analyzeScript(copied, 'current', external);
  assert.equal(copiedDiagnostics.some(item => item.code === 'non-exhaustive-condition'), false,
    'float finite candidates must survive local assignment and pure arithmetic');
});

test('float finite domains evaluate combined comparisons in diagnostics and optimization', () => {
  const external = new Map([['ratio', 'float']]);
  external.constraints = new Map([['ratio', { type: 'float', floatValues: new Set([0.25, 0.5]) }]]);
  const script = parse(`scene main {
    if ratio != 0.25 and ratio != 0.5 { say narrator "impossible" } else { wait 3 }
  }`);
  const diagnostics = analyzeScript(script, 'current', external);
  assert.ok(diagnostics.some((item) => item.code === 'constant-condition'));
  const instructions = compile(script, external).scenes[0].instructions;
  assert.deepEqual(instructions.map((instruction) => instruction.op), ['command']);
  assert.equal(instructions[0].name, 'wait');
});

test('float variable constraints reject constant writes outside configured bounds', () => {
  const external = new Map([['ratio', 'float']]);
  external.constraints = new Map([['ratio', { type: 'float', floatMin: 0.25, floatMax: 0.5, floatValues: new Set([0.25, 0.5]) }]]);
  const diagnostics = analyzeScript(parse('scene main { set ratio = 0.75 }'), 'current', external);
  assert.ok(diagnostics.some((item) => item.code === 'variable-constraint' && item.severity === 'error'));
});

test('integer variable domains validate timed presentation commands', () => {
  const globals = new Map([['duration', 'int']]);
  globals.constraints = new Map([['duration', { type: 'int', min: -5n, max: -1n }]]);
  const script = parse(`character hero { name = "Hero"\npose normal = "asset/hero.png" }
scene main {
  wait duration
  effect fade black duration
  show hero.normal center fade duration
  hide hero fade duration
  move bg by x+1 over duration
}`);
  const diagnostics = analyzeScript(script, 'main.tds', globals).filter((item) => item.code === 'duration-range');
  assert.equal(diagnostics.length, 5);
  assert.ok(diagnostics.every((item) => item.severity === 'error'));
  assert.throws(() => compile(script, globals), /演出時間の値域がすべて/);

  globals.constraints = new Map([['duration', { type: 'int', values: new Set([-1n, 100n]) }]]);
  const mixed = analyzeScript(parse('scene main { wait duration }'), 'main.tds', globals);
  assert.ok(mixed.some((item) => item.code === 'duration-range' && item.severity === 'warning'));
  assert.doesNotThrow(() => compile(parse('scene main { wait duration }'), globals));

  globals.constraints = new Map([['duration', { type: 'int', min: 2147483648n }]]);
  assert.ok(analyzeScript(parse('scene main { wait duration }'), 'main.tds', globals).some((item) => item.code === 'duration-range' && item.severity === 'error'));
  globals.constraints = new Map([['duration', { type: 'int', max: -1n }]]);
  assert.ok(analyzeScript(parse('scene main { wait duration }'), 'main.tds', globals).some((item) => item.code === 'duration-range' && item.severity === 'error'));

  globals.constraints = new Map([['duration', { type: 'int', min: 0n, max: 100000n }]]);
  const valid = analyzeScript(parse('scene main { wait duration * 2 }'), 'main.tds', globals);
  assert.equal(valid.some((item) => item.code === 'duration-range'), false);

  globals.constraints = new Map([['duration', { type: 'int', min: 0n, max: 2147483648n }]]);
  const guarded = parse('scene main { if duration > 2147483647 { wait duration } }');
  const guardedDiagnostics = analyzeScript(guarded, 'main.tds', globals);
  assert.ok(guardedDiagnostics.some((item) => item.code === 'duration-range' && item.severity === 'error'));
  assert.throws(() => compile(guarded, globals), /演出時間の値域がすべて/);
  const safeBranch = analyzeScript(parse('scene main { if duration <= 2147483647 { wait duration } }'), 'main.tds', globals);
  assert.equal(safeBranch.some((item) => item.code === 'duration-range'), false);
});

test('integer bounds preserve float variable ranges through int conversion', () => {
  const globals = new Map([['ratio', 'float']]);
  globals.constraints = new Map([['ratio', { type: 'float', floatMin: -3.2, floatMax: -2.1 }]]);
  const definitelyNegative = parse('scene main { wait int(ratio) }');
  assert.ok(analyzeScript(definitelyNegative, 'main.tds', globals).some((item) => item.code === 'duration-range' && item.severity === 'error'));
  assert.throws(() => compile(definitelyNegative, globals), /演出時間/);

  globals.constraints = new Map([['ratio', { type: 'float', floatMin: -1.2, floatMax: 2.2 }]]);
  const partlyNegative = analyzeScript(parse('scene main { wait int(ratio) }'), 'main.tds', globals);
  assert.ok(partlyNegative.some((item) => item.code === 'duration-range' && item.severity === 'warning'));
  assert.doesNotThrow(() => compile(parse('scene main { wait int(ratio) }'), globals));

  globals.constraints = new Map([['ratio', { type: 'float', floatMin: -0.9, floatMax: 2.2 }]]);
  const truncatedSafe = analyzeScript(parse('scene main { wait int(ratio) }'), 'main.tds', globals);
  assert.equal(truncatedSafe.some((item) => item.code === 'duration-range'), false, 'truncation toward zero makes every value nonnegative');

  const textGlobals = new Map([['durationText', 'str']]);
  textGlobals.constraints = new Map([['durationText', { type: 'str', values: new Set(['-5', '-1']) }]]);
  const negativeTextDuration = analyzeScript(parse('scene main { wait int(durationText) }'), 'main.tds', textGlobals);
  assert.ok(negativeTextDuration.some(item => item.code === 'duration-range' && item.severity === 'error'),
    'finite integer-string candidates must survive str-to-int conversion');
  assert.throws(() => compile(parse('scene main { wait int(durationText) }'), textGlobals), /演出時間/);

  textGlobals.constraints = new Map([['durationText', { type: 'str', values: new Set(['-1', '2147483648']) }]]);
  const disjointInvalid = analyzeScript(parse('scene main { wait int(durationText) }'), 'main.tds', textGlobals);
  assert.ok(disjointInvalid.some(item => item.code === 'duration-range' && item.severity === 'error'),
    'a finite set with invalid values on both sides of the valid duration interval must not be widened into a warning');

  textGlobals.constraints = new Map([['durationText', { type: 'str', values: new Set(['-1', '100']) }]]);
  assert.ok(analyzeScript(parse('scene main { wait int(durationText) }'), 'main.tds', textGlobals)
    .some(item => item.code === 'duration-range' && item.severity === 'warning'), 'mixed valid and invalid durations must remain uncertain, not silently safe');

  const floatSource = new Map([['largeFloat', 'float']]);
  floatSource.constraints = new Map([['largeFloat', { type: 'float', floatMin: 1e20, floatMax: 1e21 }]]);
  assert.ok(analyzeScript(parse('scene main { say narrator str(int(largeFloat)) }'), 'main.tds', floatSource)
    .some(item => item.code === 'invalid-conversion' && item.severity === 'error'), 'known float domains outside int64 must be rejected before runtime');

  textGlobals.constraints = new Map([['durationText', { type: 'str', values: new Set(['not-a-number', '12']) }]]);
  assert.ok(analyzeScript(parse('scene main { say narrator str(int(durationText)) }'), 'main.tds', textGlobals)
    .some(item => item.code === 'invalid-conversion' && item.severity === 'warning'), 'mixed valid and malformed configured strings must be reported as uncertain');
});

test('integer finite candidates survive local copies for exhaustive branch analysis', () => {
  const external = new Map([['route', 'int']]);
  external.constraints = new Map([['route', { type: 'int', min: 0n, max: 2n, values: new Set([0n, 2n]) }]]);
  const script = parse(`int copy = 0
scene main {
  set copy = route
  if copy == 0 { wait 1 } elif copy == 2 { wait 2 }
}`);
  const diagnostics = analyzeScript(script, 'current', external);
  assert.equal(diagnostics.some(item => item.code === 'non-exhaustive-condition'), false,
    'finite integer alternatives must not be widened to their min/max interval on assignment');
});

test('float local assignments retain ranges through branch merges and int conversion', () => {
  const globals = new Map([['ratio', 'float'], ['gate', 'int']]);
  globals.constraints = new Map([['ratio', { type: 'float', floatMin: -3.2, floatMax: -2.1 }]]);
  const copied = parse('fn timed() -> none { float local_ratio = ratio\nwait int(local_ratio) }\nscene main { timed() }');
  assert.ok(analyzeScript(copied, 'main.tds', globals).some(item => item.code === 'duration-range' && item.severity === 'error'));
  assert.throws(() => compile(copied, globals), /演出時間/);

  const merged = parse(`float duration = 0.0
scene main {
  if gate == 1 { set duration = -2.0 } else { set duration = 50.0 }
  wait int(duration)
}`);
  const mergedDiagnostics = analyzeScript(merged, 'main.tds', globals);
  assert.ok(mergedDiagnostics.some(item => item.code === 'duration-range' && item.severity === 'warning'), 'branch merge retains that some float outcomes truncate below zero');
  assert.doesNotThrow(() => compile(merged, globals));
});

test('timed-command bounds follow values fixed by assignments and branch merges', () => {
  const assigned = parse('int duration = 100\nscene main { set duration = -1\nwait duration }');
  assert.ok(analyzeScript(assigned).some((item) => item.code === 'duration-range' && item.severity === 'error'));
  assert.throws(() => compile(assigned), /確定した演出時間/);

  const merged = parse(`int gate = 0
int duration = 100
scene main {
  if gate == 1 { set duration = -2 } else { set duration = -2 }
  wait duration
}`);
  const mergedDiagnostics = analyzeScript(merged).filter((item) => item.code === 'duration-range');
  assert.ok(mergedDiagnostics.some((item) => item.severity === 'error'));
  assert.throws(() => compile(merged), /確定した演出時間/);

  const differentValues = parse(`int gate = 0
int duration = 100
scene main {
  if gate == 1 { set duration = -2 } else { set duration = -3 }
  wait duration
}`);
  const mergedRange = analyzeScript(differentValues).filter((item) => item.code === 'duration-range');
  assert.ok(mergedRange.some((item) => item.severity === 'error'), 'both incoming values are invalid even though they are not identical');
  assert.throws(() => compile(differentValues), /演出時間/);
});

test('exactly-once for loops propagate definite numeric assignments', () => {
  const globals = new Map([['duration', 'int']]);
  globals.constraints = new Map([['duration', { type: 'int', min: -100n, max: 100n }]]);
  const script = parse(`global int duration = 100
scene main {
  for i from 0 to 0 step 1 {
    set duration = -1
  }
  wait duration
}`);
  const diagnostics = analyzeScript(script, 'current', globals).filter(item => item.code === 'duration-range');
  assert.ok(diagnostics.some(item => item.severity === 'error'), 'an exactly-once loop must propagate its definite assignment');
  assert.throws(() => compile(script), /演出時間/);
});

test('function call arguments flow into timed and movement validation', () => {
  const negativeDuration = parse('fn animate(duration: int) -> none { wait duration }\nscene main { animate(-1) }');
  assert.ok(analyzeScript(negativeDuration).some(item => item.code === 'duration-range' && item.severity === 'error'));
  assert.throws(() => compile(negativeDuration), /演出時間/);
  assert.equal(analyzeScript(parse('fn animate(duration: int) -> none { wait duration }\nscene main { animate(250) }')).some(item => item.code === 'duration-range'), false);
  const specializedBranch = parse('fn clamp(value: int) -> int { if value <= 0 { return 0 }\nreturn value }\nscene main { clamp(-1) }');
  const specializedDiagnostics = analyzeScript(specializedBranch);
  assert.equal(specializedDiagnostics.some(item => ['constant-condition', 'unreachable-code'].includes(item.code) && item.line <= 2), false,
    'call-specific branch selection must not leak internal unreachable-code noise from a shared helper');
  const nestedCall = parse('fn animate(duration: int) -> int { wait duration\nreturn duration }\nfn wrapper() -> int { return animate(-1) }\nint result = 0\nscene main { set result = wrapper() }');
  assert.ok(analyzeScript(nestedCall).some(item => item.code === 'duration-range' && item.severity === 'error'), 'expression calls in function bodies also propagate known arguments');
  const shadowedParameter = parse('const int duration = -1\nfn animate(duration: int, marker: int) -> none { wait duration }\nscene main { animate(dynamicDuration, 1) }');
  assert.doesNotThrow(() => compile(shadowedParameter, new Map([['dynamicDuration', 'int']])), 'a same-named global constant must not be mistaken for an unknown parameter');

  const finiteGlobals = new Map([['route', 'int']]);
  finiteGlobals.constraints = new Map([['route', { type: 'int', min: 0n, max: 2n, values: new Set([0n, 2n]) }]]);
  const finiteDispatch = parse('fn dispatch(route: int) -> none { if route == 0 { wait 1 } elif route == 2 { wait 1 } }\nscene main { dispatch(route) }');
  const finiteDiagnostics = analyzeScript(finiteDispatch, 'main.tds', finiteGlobals);
  assert.equal(finiteDiagnostics.some(item => item.code === 'non-exhaustive-condition'), false, JSON.stringify(finiteDiagnostics.filter(item => item.code === 'non-exhaustive-condition')));
  const transformedDispatch = parse('fn dispatch(route: int) -> none { if route == 0 { wait 1 } elif route == 4 { wait 1 } }\nscene main { dispatch(route * 2) }');
  assert.equal(analyzeScript(transformedDispatch, 'main.tds', finiteGlobals).some(item => item.code === 'non-exhaustive-condition'), false,
    'finite integer domains must survive arithmetic at an interprocedural callsite');

  const stringGlobals = new Map([['routeName', 'str'], ['gate', 'int']]);
  stringGlobals.constraints = new Map([['routeName', { type: 'str', values: new Set(['common', 'true']) }]]);
  stringGlobals.constraints.set('gate', { type: 'int', min: 0n, max: 1n, values: new Set([0n, 1n]) });
  const stringDispatch = parse('fn dispatch_name(routeName: str) -> none { if routeName == "common" { wait 1 } }\nscene main { dispatch_name(routeName) }');
  assert.ok(analyzeScript(stringDispatch, 'main.tds', stringGlobals).some(item => item.code === 'non-exhaustive-condition'), 'string possibleValues must remain finite across parameter passing');
  const stringCopy = parse(`str local_route = ""
str branched_route = ""
fn dispatch_name(routeName: str) -> none {
  if routeName == "common_" { wait 1 } elif routeName == "true_" { wait 1 }
}
scene main {
  set local_route = routeName + "_"
  if local_route == "common_" { wait 1 } elif local_route == "true_" { wait 1 }
  dispatch_name(routeName + "_")
  if gate == 0 { set branched_route = routeName + "_" } else { set branched_route = routeName + "!" }
  if branched_route == "common_" { wait 1 }
  elif branched_route == "true_" { wait 1 }
  elif branched_route == "common!" { wait 1 }
  elif branched_route == "true!" { wait 1 }
}`);
  assert.equal(analyzeScript(stringCopy, 'main.tds', stringGlobals).some(item => item.code === 'non-exhaustive-condition'), false,
    'string candidate sets must survive concatenation, local assignment, branch merge and function-call analysis');

  const globals = new Map([['offset', 'float']]);
  globals.constraints = new Map([['offset', { type: 'float', floatMin: 1000001.0, floatMax: 1000002.0 }]]);
  const moved = parse('fn shift(amount: float) -> none { move bg by x+(amount) }\nscene main { shift(offset) }');
  assert.ok(analyzeScript(moved, 'main.tds', globals).some(item => item.code === 'presentation-offset-range' && item.severity === 'error'));
  assert.throws(() => compile(moved, globals), /位置ずらし/);
});

test('float variable constraints bound arithmetic assignments and warn when only some values escape', () => {
  const external = new Map([['ratio', 'float']]);
  external.constraints = new Map([['ratio', { type: 'float', floatMin: 0.25, floatMax: 0.5 }]]);
  const diagnostics = analyzeScript(parse('scene main { set ratio = ratio + 0.1 }'), 'current', external);
  assert.ok(diagnostics.some((item) => item.code === 'variable-constraint' && item.severity === 'warning'));
  external.constraints = new Map([['ratio', { type: 'float', floatMin: 0.75, floatMax: 1.0 }]]);
  const definitelyInvalid = analyzeScript(parse('scene main { set ratio = ratio + 2.0 }'), 'current', external);
  assert.ok(definitelyInvalid.some((item) => item.code === 'variable-constraint' && item.severity === 'error'));
});

test('float value domains are invalidated by direct and compiled function side effects', () => {
  const external = new Map([['ratio', 'float']]);
  external.constraints = new Map([['ratio', { type: 'float', floatMin: 0.25, floatMax: 0.5, floatValues: new Set([0.25, 0.5]) }]]);
  const script = parse(`fn set_low() -> none { set ratio = 0.25 }
scene main {
  if ratio == 0.25 {
    set_low()
    if ratio == 0.25 { wait 1 }
  }
}`);
  const diagnostics = analyzeScript(script, 'current', external);
  assert.equal(diagnostics.some((item) => item.code === 'constant-condition' && item.line === 5), false);
  const program = compile(script, external);
  const outer = program.scenes[0].instructions[0];
  assert.equal(outer.op, 'if');
  assert.equal(outer.body.find((instruction) => instruction.op === 'if')?.condition.left.kind, 'load');
});

test('compiler does not invalidate facts from a dormant elif condition', () => {
  const external = new Map([['counter', 'int']]);
  external.constraints = new Map([['counter', { type: 'int', min: 1n, max: 3n }]]);
  const program = compile(parse(`
    fn change() -> int { set counter = counter + 1
      return 1 }
    if 1 == 1 { say narrator "first" } elif change() == 1 { say narrator "second" }
    if counter >= 1 { say narrator "stable" }
  `), external);
  assert.equal(program.globals.some((instruction) => instruction.op === 'if'), false);
});

test('compiler stops elif effect analysis after a statically selected branch', () => {
  const external = new Map([['counter', 'int']]);
  external.constraints = new Map([['counter', { type: 'int', min: 1n, max: 3n }]]);
  const program = compile(parse(`
    fn change() -> int { set counter = counter + 1
      return 1 }
    if counter < 1 { say narrator "first" } elif 1 == 1 { say narrator "second" } elif change() == 1 { say narrator "third" }
    if counter >= 1 { say narrator "stable" }
  `), external);
  assert.equal(program.globals.some((instruction) => instruction.op === 'if'), false);
});

test('compiler does not restore constraints from an effectful elif branch', () => {
  const external = new Map([['counter', 'int']]);
  external.constraints = new Map([['counter', { type: 'int', min: 1n, max: 3n }]]);
  const program = compile(parse(`
    fn change() -> int { set counter = counter + 1
      return 1 }
    if counter == 2 { say narrator "first" } elif change() == 1 { say narrator "second" }
    if counter <= 3 { say narrator "possibly changed" }
  `), external);
  assert.equal(program.globals.at(-1).op, 'if');
});

test('compiler folds dormant interpolation literals in conditions', () => {
  const program = compile(parse(`
    int counter = 0
    fn tick() -> str { set counter = counter + 1
      return str(counter) }
    scene start {
      if "{tick()}" == "{tick()}" { say narrator "same" } else { say narrator "different" }
    }
  `));
  assert.equal(program.scenes[0].instructions[0].op, 'command');
  assert.doesNotThrow(() => compile(parse(`
    fn tick() -> str { return "tick" }
    fn complete() -> int {
      while "{tick()}" == "{tick()}" { return 1 }
    }
  `)));
});

test('compiler preserves while conditions changed by their body', () => {
  const program = compile(parse(`
    fn finite() -> int {
      int value = 0
      while value < 1 {
        set value = value + 1
      }
      return value
    }
  `));
  const loop = program.functions[0].body[1];
  assert.equal(loop.op, 'while');
  assert.equal(loop.condition.kind, 'binary');
  assert.equal(loop.condition.left.kind, 'load');
});

test('reports advanced data-flow errors and unused function variables', () => {
  const source = parse(`
    fn value(unused: int) -> int {
      if 1 == 1 { return 1 }
    }
    fn broken(arg: int) -> int {
      int local = arg
      wait 10 / 0
    }
  `);
  const diagnostics = analyzeScript(source);
  assert.ok(diagnostics.some((item) => item.code === 'missing-return' && /broken/.test(item.message)));
  assert.ok(diagnostics.some((item) => item.code === 'division-by-zero' && item.severity === 'warning'));
  assert.ok(diagnostics.some((item) => item.code === 'unused-variable' && /unused/.test(item.message)));
});

test('rejects variables that are not declared on every control-flow path', () => {
  assert.throws(() => compile(parse(`
    fn conditional(n: int) -> int {
      if n == 1 { int value = 7 }
      return value
    }
  `)), /未定義の変数 'value'/);
  assert.throws(() => compile(parse(`
    fn conditional(n: int) -> int {
      while n > 0 { int value = 7 }
      return value
    }
  `)), /未定義の変数 'value'/);
  assert.doesNotThrow(() => compile(parse(`
    fn complete(n: int) -> int {
      if n == 1 { int value = 7 } else { int value = 8 }
      return value
    }
  `)));
});

test('recognizes terminating loops when merging branch variables', () => {
  assert.doesNotThrow(() => compile(parse(`
    fn conditional(n: int) -> int {
      if n == 1 {
        while 1 == 1 { return 1 }
      } else {
        int value = 8
      }
      return value
    }
  `)));
  assert.doesNotThrow(() => compile(parse(`
    fn converted(n: int) -> int {
      if n == 1 {
        while int("1") == 1 { return 1 }
      } else {
        int value = 8
      }
      return value
    }
  `)));
});

test('does not leak declarations from a possibly empty for loop', () => {
  assert.throws(() => compile(parse(`
    fn conditional(stop: int) -> int {
      for i from 0 to stop {
        int value = 8
      }
      return value
    }
  `)), /未定義の変数 'value'/);
  assert.doesNotThrow(() => compile(parse(`
    fn guaranteed() -> int {
      for i from 0 to 1 {
        int value = 8
      }
      return value
    }
  `)));
});

test('validates interpolation variables and choice cardinality', () => {
  assert.throws(() => compile(parse('say narrator "Hello {missing}"')), /補間対象.*missing.*未定義/);
  assert.doesNotThrow(() => compile(parse('dict[int] values = { "one": 1 }\nsay narrator "{values}"')));
  assert.throws(() => compile(parse('choice {\n}')), /1つ以上の選択肢/);
});

test('validates zero-argument function interpolation', () => {
  assert.doesNotThrow(() => compile(parse('fn ending_text() -> str { return "end" }\nsay narrator "{ending_text()}"')));
  assert.throws(() => compile(parse('say narrator "{missing()}"')), /補間対象の関数 'missing' が未定義/);
});

test('validates statically known nested interpolation strings', () => {
  assert.throws(() => compile(parse('str name = "missing()"\nstr template = "{" + name + "}"\nsay narrator "{template}"')), /missing/);
  assert.throws(() => compile(parse('str field = "missing"\nstr template = "{" + field + "}"\nsay narrator "{template}"')), /missing/);
  assert.throws(() => compile(parse('str name = "missing"\nstr template = "{" + name + "}"\nfn render_text() -> none { say narrator "{template}" }')), /missing/);
  assert.throws(() => compile(parse('str name = "missing"\nstr template = "{" + name + "}"\nscene start { say narrator "{template}" }')), /missing/);
});

test('counts interpolated function variables as used', () => {
  const diagnostics = analyzeScript(parse(`
    fn greet(name: str) -> none {
      say narrator "こんにちは、{name}さん"
    }
  `));
  assert.equal(diagnostics.some((item) => item.code === 'unused-variable' && /name/.test(item.message)), false);
});

test('counts dotted interpolation fields as using their root variable', () => {
  const diagnostics = analyzeScript(parse(`
    struct Person { name: str }
    fn display_person(person: Person) -> none {
      say narrator "{person.name}"
    }
  `));
  assert.equal(diagnostics.some((item) => item.code === 'unused-variable' && /person/.test(item.message)), false);
});

test('checks standalone integer literals and constant return paths', () => {
  assert.throws(() => compile(parse('int value = 9223372036854775808')), /64bit/);
  assert.throws(() => compile(parse('int value = -9223372036854775809')), /64bit/);
  assert.doesNotThrow(() => compile(parse('int value = -9223372036854775808')));
  assert.doesNotThrow(() => compile(parse(`
    fn value() -> int {
      if 1 == 2 { } else { return 1 }
    }
  `)));
});

test('analyzes constant builtin conversions for flow and range safety', () => {
  const diagnostics = analyzeScript(parse(`
    const str route = "2"
    scene start {
      if int(route) == 2 {
        goto ending
      } else {
        goto hidden
      }
    }
    scene ending { wait 1 }
    scene hidden { wait 1 }
  `));
  assert.ok(diagnostics.some((item) => item.code === 'constant-condition'));
  assert.ok(diagnostics.some((item) => item.code === 'unreachable-scene' && /hidden/.test(item.message)));
  assert.throws(() => compile(parse('int value = int("9223372036854775808")')), /64bit/);
  assert.throws(() => compile(parse('int value = int("+-1")')), /int 形式/);
  assert.throws(() => compile(parse('float value = float(" ")')), /有限の float 形式/);
  assert.throws(() => compile(parse('int value = int(1e20)')), /64-bit int/);
  assert.throws(() => compile(parse('float value = float("1e999")')), /有限の float 形式/);
  assert.doesNotThrow(() => compile(parse('int value = int("+1")\nfloat ratio = float("-1.25e2")')));
});

test('conversion diagnostics localize prose and preserve API and type names', () => {
  const item = analyzeScript(parse('int value = int("bad")')).find(entry => entry.code === 'invalid-conversion');
  assert.equal(item.message, 'int() conversion error: \u6e21\u3055\u308c\u305f str \u304c int \u5f62\u5f0f\u3067\u306f\u3042\u308a\u307e\u305b\u3093');
});

test('float conversions participate in side-effect-safe condition deduplication', () => {
  const globals = new Map([['ratio', 'float']]);
  globals.constraints = new Map([['ratio', { type: 'float', floatMin: 0.25, floatMax: 0.5 }]]);
  const diagnostics = analyzeScript(parse(`scene main {
    if float(ratio) > 0.0 { wait 1 }
    elif float(ratio) > 0.0 { wait 2 }
  }`), 'main.tds', globals);
  assert.ok(diagnostics.some((item) => item.code === 'duplicate-condition'));

  const throughFunction = analyzeScript(parse(`fn convert(value: float) -> float { return float(value) }
scene main {
  float copy = convert(ratio)
  if ratio > 1.0 { wait 1 }
}`), 'main.tds', globals);
  assert.ok(throughFunction.some((item) => item.code === 'constant-condition' && item.severity === 'warning'), 'pure conversion wrappers must not erase the static variable domain');
});

test('warns when a constant for range exceeds the runtime loop limit', () => {
  const diagnostics = analyzeScript(parse('scene start { for i from 0 to 100000 { wait 1 } }'));
  assert.ok(diagnostics.some((item) => item.code === 'loop-limit' && item.severity === 'warning'));
  const exact = analyzeScript(parse('scene start { for i from 0 to 99999 { wait 1 } }'));
  assert.equal(exact.some((item) => item.code === 'loop-limit'), false);
});

test('loop diagnostics use the English DSL term consistently', () => {
  const diagnostics = analyzeScript(parse(`scene start { for i from 0 to 100000 { wait 1 } }
fn too_long() -> none {
  int value = 0
  while value < 100001 { set value = value + 1 }
}`));
  const messages = diagnostics.filter(item => item.code === 'loop-limit').map(item => item.message);
  assert.ok(messages.some(message => message.includes('while loop')));
  assert.ok(messages.some(message => message.includes('for loop')));
  assert.ok(messages.every(message => !message.includes('ループ')));
});

test('while loop updates invalidate entry value constraints before infinite-loop analysis', () => {
  const diagnostics = analyzeScript(parse(`fn refine(value: float) -> float {
  float scaled = value
  float scale = 1.0
  while scaled >= 4.0 {
    set scaled = scaled / 4.0
    set scale = scale * 2.0
  }
  int iteration = 0
  while iteration < 8 {
    set iteration = iteration + 1
  }
  return scale
}`));
  assert.equal(diagnostics.some(item => item.code === 'infinite-loop' || item.code === 'unreachable-code'), false, JSON.stringify(diagnostics));
});

test('warns when a provably bounded while exceeds the runtime loop limit', () => {
  const diagnostics = analyzeScript(parse(`
    fn too_long() -> none {
      int value = 0
      while value < 100001 {
        set value = value + 1
      }
    }
  `));
  assert.ok(diagnostics.some((item) => item.code === 'loop-limit' && item.severity === 'warning'));
  const exact = analyzeScript(parse(`
    fn exact() -> none {
      int value = 0
      while value < 100000 {
        set value = value + 1
      }
    }
  `));
  assert.equal(exact.some((item) => item.code === 'loop-limit'), false);
  const exponential = analyzeScript(parse(`
    fn exponential() -> none {
      int value = 1
      while value < 100001 {
        set value = value + value
      }
    }
  `));
  assert.equal(exponential.some((item) => item.code === 'loop-limit'), false);
  const nonTerminating = analyzeScript(parse(`
    fn wrong_direction() -> none {
      int value = 0
      while value < 3 {
        set value = value - 1
      }
    }
    fn no_progress() -> none {
      int value = 0
      while value < 3 {
        set value = value + 0
      }
    }
  `));
  assert.equal(nonTerminating.filter((item) => item.code === 'loop-limit').length, 2);
  const overflow = parse(`
    fn overflow() -> none {
      int value = 9223372036854775807
      while value >= 0 {
        set value = value + 1
      }
    }
  `);
  const overflowDiagnostics = analyzeScript(overflow);
  assert.ok(overflowDiagnostics.some((item) => item.code === 'integer-overflow' && item.severity === 'error' && item.message.includes('integer overflow')));
  assert.throws(() => compile(overflow), /64bit/);
  const finalUpdateOverflow = parse(`
    fn final_update_overflow() -> none {
      int value = 9223372036854775806
      while value <= 9223372036854775807 {
        set value = value + 1
      }
    }
  `);
  const finalUpdateDiagnostics = analyzeScript(finalUpdateOverflow);
  assert.ok(finalUpdateDiagnostics.some((item) => item.code === 'integer-overflow' && item.severity === 'error'));
  assert.throws(() => compile(finalUpdateOverflow), /64bit/);
  const wrongDirectionOverflow = parse(`
    fn wrong_direction_overflow() -> none {
      int value = -9223372036854775807
      while value < 0 {
        set value = value - 1
      }
    }
  `);
  const wrongDirectionDiagnostics = analyzeScript(wrongDirectionOverflow);
  assert.ok(wrongDirectionDiagnostics.some((item) => item.code === 'integer-overflow' && item.severity === 'error'));
  assert.throws(() => compile(wrongDirectionOverflow), /64bit/);
  const whileCommandBeforeUpdate = parse(`
    fn while_command_before_update() -> none {
      int value = 9223372036854775807
      while value >= 0 {
        say narrator "tick"
        set value = value + 1
      }
    }
  `);
  const whileCommandDiagnostics = analyzeScript(whileCommandBeforeUpdate);
  assert.ok(whileCommandDiagnostics.some((item) => item.code === 'integer-overflow' && item.severity === 'error'));
  assert.throws(() => compile(whileCommandBeforeUpdate), /64bit/);
  const whileIntermediateOverflow = parse(`
    fn while_intermediate_overflow() -> none {
      int value = 9223372036854775807
      while value >= 0 {
        set value = value + 1 - 1
      }
    }
  `);
  const whileIntermediateDiagnostics = analyzeScript(whileIntermediateOverflow);
  assert.ok(whileIntermediateDiagnostics.some((item) => item.code === 'integer-overflow' && item.severity === 'error'));
  assert.throws(() => compile(whileIntermediateOverflow), /64bit/);
  const complexNonTerminating = analyzeScript(parse(`
    fn complex_non_terminating() -> none {
      int value = 0
      while value < 3 {
        set value = value + 1 - 1
      }
    }
  `));
  assert.ok(complexNonTerminating.some((item) => item.code === 'loop-limit' && item.severity === 'warning'));
  const complexFinite = analyzeScript(parse(`
    fn complex_finite() -> none {
      int value = 0
      while value < 3 {
        set value = value + 2 - 1
      }
    }
  `));
  assert.equal(complexFinite.some((item) => item.code === 'loop-limit'), false);
  const forOverflow = parse(`
    fn for_overflow() -> none {
      int value = 0
      for i from 9223372036854775807 to 9223372036854775807 {
        set value = i + 1
      }
    }
  `);
  const forOverflowDiagnostics = analyzeScript(forOverflow);
  assert.ok(forOverflowDiagnostics.some((item) => item.code === 'integer-overflow' && item.severity === 'error'));
  assert.throws(() => compile(forOverflow), /64bit/);
  const forRepeatedOverflow = parse(`
    fn for_repeated_overflow() -> none {
      int value = 0
      for i from 0 to 1 {
        set value = value + 9223372036854775807
      }
    }
  `);
  const forRepeatedDiagnostics = analyzeScript(forRepeatedOverflow);
  assert.ok(forRepeatedDiagnostics.some((item) => item.code === 'integer-overflow' && item.severity === 'error'));
  assert.throws(() => compile(forRepeatedOverflow), /64bit/);
  const forLongFirstOverflow = parse(`
    fn for_long_first_overflow() -> none {
      int value = 9223372036854775807
      for i from 0 to 100000 {
        set value = value + 1
      }
    }
  `);
  const forLongFirstDiagnostics = analyzeScript(forLongFirstOverflow);
  assert.ok(forLongFirstDiagnostics.some((item) => item.code === 'integer-overflow' && item.severity === 'error'));
  assert.throws(() => compile(forLongFirstOverflow), /64bit/);
  const forLoopVariableOverflow = parse(`
    fn for_loop_variable_overflow() -> none {
      int value = 9223372036854775807
      for i from 0 to 1 {
        set value = value + i
      }
    }
  `);
  const forLoopVariableDiagnostics = analyzeScript(forLoopVariableOverflow);
  assert.ok(forLoopVariableDiagnostics.some((item) => item.code === 'integer-overflow' && item.severity === 'error'));
  assert.throws(() => compile(forLoopVariableOverflow), /64bit/);
  const forReverseLoopVariableOverflow = parse(`
    fn for_reverse_loop_variable_overflow() -> none {
      int value = -9223372036854775808
      for i from 0 to 1 {
        set value = value - i
      }
    }
  `);
  const forReverseLoopVariableDiagnostics = analyzeScript(forReverseLoopVariableOverflow);
  assert.ok(forReverseLoopVariableDiagnostics.some((item) => item.code === 'integer-overflow' && item.severity === 'error'));
  assert.throws(() => compile(forReverseLoopVariableOverflow), /64bit/);
  const forCommandBeforeUpdate = parse(`
    fn for_command_before_update() -> none {
      int value = 9223372036854775807
      for i from 0 to 1 {
        say narrator "tick"
        set value = value + i
      }
    }
  `);
  const forCommandDiagnostics = analyzeScript(forCommandBeforeUpdate);
  assert.ok(forCommandDiagnostics.some((item) => item.code === 'integer-overflow' && item.severity === 'error'));
  assert.throws(() => compile(forCommandBeforeUpdate), /64bit/);
  const forIntermediateOverflow = parse(`
    fn for_intermediate_overflow() -> none {
      int value = 9223372036854775807
      for i from 0 to 0 {
        set value = value + 1 - 1
      }
    }
  `);
  const forIntermediateDiagnostics = analyzeScript(forIntermediateOverflow);
  assert.ok(forIntermediateDiagnostics.some((item) => item.code === 'integer-overflow' && item.severity === 'error'));
  assert.throws(() => compile(forIntermediateOverflow), /64bit/);
  const forEffectfulCommand = parse(`
    int value = 9223372036854775807
    fn reset() -> int {
      set value = 0
      return 0
    }
    fn for_effectful_command() -> none {
      for i from 0 to 1 {
        say narrator "{reset()}"
        set value = value + i
      }
    }
  `);
  const forEffectfulDiagnostics = analyzeScript(forEffectfulCommand);
  assert.equal(forEffectfulDiagnostics.some((item) => item.code === 'integer-overflow'), false);
  assert.doesNotThrow(() => compile(forEffectfulCommand));
});
