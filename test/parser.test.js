const test = require('node:test');
const assert = require('node:assert/strict');
const { parse, compile, checkTypes, analyzeScript } = require('../dist');

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
  assert.throws(() => checkTypes(parse('fn bad() -> none { global int value = 1 }')), /global.*トップレベル/);
});

test('rejects every DSL keyword documented as unavailable for identifiers', () => {
  const reserved = [
    'scene', 'asset', 'character', 'struct', 'pose', 'include',
    'int', 'str', 'dict', 'none', 'global', 'set', 'unset',
    'say', 'bg', 'bgm', 'char', 'show', 'at', 'hide', 'image', 'clear', 'play', 'effect', 'wait',
    'if', 'elif', 'else', 'and', 'or', 'not', 'choice', 'for', 'from', 'to', 'step', 'while',
    'fn', 'return', 'goto', 'async', 'blocking', 'voice', 'video', 'const', 'let',
  ];
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
  assert.throws(() => parse('say message'), /quoted text/);
  assert.throws(() => parse('say narrator'), /quoted text/);
  const hero = 'character hero {\n  name = "Hero"\n  pose normal = "asset/hero.png"\n}\n';
  assert.doesNotThrow(() => checkTypes(parse(hero + 'show hero.normal center')));
  assert.throws(() => parse('Unknown value = { "x": 1 }'), /Expected expression/);
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
  assert.throws(() => checkTypes(parse('character ayase {\nname = "A"\npose normal = "asset/a.png"\n}\nshow ayase.missing center')), /ポーズ/);
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
  assert.throws(() => checkTypes(parse('struct User { age: int }\nUser user = { "age": "bad" }')), /フィールド 'age' の型が一致しません/);
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
  assert.throws(() => parse('say narrator "broken'), /Unterminated string at line 1/);
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
  assert.throws(() => parse('say narrator "before"\uFEFF\nsay narrator "after"'), /Unexpected character/);
});

test('rejects non-canonical Windows separators in asset paths', () => {
  assert.throws(() => compile(parse('asset bg school = "asset\\\\bg\\\\mori.jpg"')), /アセットパス|asset.*path/i);
});

test('reports malformed dictionary and blocks at exact locations', () => {
  assert.throws(() => parse('dict[int] x = {foo: 1}\n'), /Dictionary keys must be strings/);
  assert.throws(() => checkTypes(parse('dict[str] x = {"same": "first", "same": "second"}')), /duplicate dictionary key/);
  assert.throws(() => parse('scene broken {\n  say narrator "x"\n'), /Expected '}'/);
});

test('rejects unknown escapes and non-canonical asset paths', () => {
  assert.throws(() => parse(String.raw`say "hello\q"`), /Unknown escape sequence/);
  assert.throws(() => parse(String.raw`asset bg school = "asset\q\mori.jpg"`), /Unknown escape sequence/);
  assert.throws(() => parse(String.raw`character hero { pose normal = "asset\q\hero.png" }`), /Unknown escape sequence/);
  assert.throws(() => parse(String.raw`include "chapter\q.tds"`), /Unknown escape sequence/);
  assert.throws(() => parse(String.raw`goto "chapter\q.tds"`), /Unknown escape sequence/);
  assert.throws(() => compile(parse(String.raw`asset bg school = "asset\\bg\\mori.jpg"`)), /アセットパス|asset.*path/i);
});

test('speakerless say accepts any string expression that starts with a string literal', () => {
  const script = parse('str name = "ユイ"\nscene main { say "こんにちは、" + name }');
  assert.doesNotThrow(() => checkTypes(script));
  const say = script.scenes[0].body[0];
  assert.equal(say.kind, 'command');
  assert.equal(say.args[0].value, 'narrator');
  assert.equal(say.args[1].kind, 'binary');
  assert.throws(() => parse('scene main { say name }'), /say requires quoted text/);
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
  assert.ok(conflicts.some((item) => item.message.includes("image 'first'")));
  assert.ok(conflicts.some((item) => item.message.includes("image 'second'")));
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
    scene main {
      bg first
      bg second
      bgm calm
      play bgm tense
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
  assert.ok(background[0].message.includes("'first' is replaced by 'second'"));
  assert.ok(bgm[0].message.includes("'calm' is replaced by 'tense'"));
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
  assert.throws(() => parse('scene start { goto chapter-1/route.next.tds }'), /External scene paths must be quoted/);
  assert.throws(() => parse(String.raw`scene start { goto chapter\\next.tds }`), /External scene paths must be quoted/);
  assert.throws(() => parse('scene start { goto "chapter//route.tds" }'), /Invalid scene path/);
  assert.throws(() => parse('scene start { goto "con.tds" }'), /Invalid scene path/);
  assert.throws(() => parse('scene start { goto "chapter/next." }'), /Invalid scene path/);
  assert.throws(() => parse('include chapter / route.tds'), /Include path cannot contain spaces/);
});

test('rejects non-canonical asset path components', () => {
  assert.throws(() => checkTypes(parse('asset bg broken = "asset//bg.png"')), /アセットパス|asset.*path/i);
  assert.throws(() => checkTypes(parse('asset bg broken = "asset/./bg.png"')), /アセットパス|asset.*path/i);
  assert.throws(() => checkTypes(parse('asset bg broken = "asset/con.png"')), /アセットパス|asset.*path/i);
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
  assert.doesNotThrow(() => compile(parse('int value = int("+-1")')));
});

test('warns when a constant for range exceeds the runtime loop limit', () => {
  const diagnostics = analyzeScript(parse('scene start { for i from 0 to 100000 { wait 1 } }'));
  assert.ok(diagnostics.some((item) => item.code === 'loop-limit' && item.severity === 'warning'));
  const exact = analyzeScript(parse('scene start { for i from 0 to 99999 { wait 1 } }'));
  assert.equal(exact.some((item) => item.code === 'loop-limit'), false);
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
  assert.ok(overflowDiagnostics.some((item) => item.code === 'integer-overflow' && item.severity === 'error'));
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
