const test = require('node:test');
const assert = require('node:assert/strict');
const { parse, compile, checkTypes, analyzeScript } = require('../dist');

test('parses and compiles assets, globals, characters, functions and scenes', () => {
  const script = parse(`
    asset bg school = "assets/bg/school.jpg"
    asset bgm peaceful = "assets/bgm/peaceful.ogg"
    asset se door = "assets/se/door.wav"
    character heroine {
      normal = "assets/chara/heroine/normal.png"
      smile = "assets/chara/heroine/smile.png"
    }
    int score = 0
    dict[int] stats = { "hp": 100 }
    fn add_score(value: int) -> none {
      set score = score + value
    }
    scene prologue {
      bg school
      bgm peaceful
      show char heroine center normal
      set stats["hp"] = stats["hp"] - 10
      say heroine "こんにちは"
      add_score(1)
    }
  `);
  assert.equal(script.assets.length, 3);
  assert.equal(script.characters[0].poses.length, 2);
  assert.equal(script.globals.length, 2);
  assert.equal(script.functions[0].name, 'add_score');
  assert.equal(script.scenes[0].name, 'prologue');
  const program = compile(script);
  assert.equal(program.version, 2);
  assert.equal(program.scenes[0].instructions.length, 6);
  assert.equal(program.assets[1].type, 'bgm');
  assert.deepEqual(program.variables.slice(0, 3).map((entry) => [entry.name, entry.scope, entry.definedIn]), [
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

test('defaults shorthand say to narrator', () => {
  const statement = parse('say "hello"').globals[0];
  assert.equal(statement.kind, 'command');
  assert.equal(statement.args[0].value, 'narrator');
});

test('parses consecutive say block lines', () => {
  const script = parse('character ayase {}\nsay ayase {\n  "hello"\n  "ayasedesu"\n}');
  const statement = script.globals[0];
  assert.equal(statement.kind, 'sayBlock');
  assert.equal(statement.speaker.value, 'ayase');
  assert.deepEqual(statement.lines.map((line) => line.value), ['hello', 'ayasedesu']);
  assert.equal(compile(script).globals[0].op, 'sayBlock');
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

test('preserves Windows backslashes in asset paths', () => {
  const program = compile(parse('asset bg school = "assets\\bg\\mori.jpg"'));
  assert.equal(program.assets[0].path, 'assets\\bg\\mori.jpg');
});

test('reports malformed dictionary and blocks at exact locations', () => {
  assert.throws(() => parse('dict[int] x = {foo: 1}\n'), /Dictionary keys must be strings/);
  assert.throws(() => parse('scene broken {\n  say narrator "x"\n'), /Expected '}'/);
});

test('preserves engine commands and scene transitions for the browser player', () => {
  const program = compile(parse(`
    asset bgm theme = "assets/bgm/theme.ogg"
    asset se click = "assets/se/click.wav"
    asset voice hello = "assets/voice/hello.wav"
    character hero {
      normal = "assets/chara/hero/normal.png"
    }
    int route = 0
    scene start {
      bgm theme
      show char hero center normal
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
  assert.equal(program.characters[0].poses[0].path, 'assets/chara/hero/normal.png');
});

test('rejects an initializer whose type does not match its declaration', () => {
  assert.throws(() => compile(parse('int arg = "0"\n')), /arg は int ですが、str が代入されています/);
});

test('collects expression and interpolation references', () => {
  const variables = compile(parse('str arg = "0"\nsay narrator "{arg}"\n')).variables;
  assert.deepEqual(variables[0].references, [
    { scope: 'global', container: 'global', line: 2, column: 14, kind: 'interpolation' },
  ]);
});

test('accepts globals supplied by the project variable table', () => {
  const program = compile(parse('say narrator str(route)'), new Map([['route', 'int']]));
  assert.equal(program.globals[0].args[1].kind, 'call');
  assert.equal(program.globals[0].args[1].name, 'str');
});

// Phase 8: 項目64 新規テストケース
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
  assert.throws(() => parse('let empty = {}\n'), /let は廃止されました/);
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

test('compiler removes an if branch decided by a propagated constant', () => {
  const program = compile(parse(`
    int j = 2
    str n = "nagatomo"
    fn greet(name: str) -> none {
      say narrator "{name}"
    }
    greet(n)
    if j == 2 {
      say narrator "hello"
    } else {
      say narrator "miss"
    }
  `));
  assert.equal(program.globals.some((instruction) => instruction.op === 'if'), false);
  assert.equal(program.globals.at(-1).op, 'command');
  assert.equal(program.globals.at(-1).args[1].value, 'hello');
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

test('validates interpolation variables and choice cardinality', () => {
  assert.throws(() => compile(parse('say narrator "Hello {missing}"')), /補間対象.*missing.*未定義/);
  assert.doesNotThrow(() => compile(parse('dict[int] values = { "one": 1 }\nsay narrator "{values}"')));
  assert.throws(() => compile(parse('choice {\n}')), /1つ以上の選択肢/);
});

test('counts interpolated function variables as used', () => {
  const diagnostics = analyzeScript(parse(`
    fn greet(name: str) -> none {
      say narrator "こんにちは、{name}さん"
    }
  `));
  assert.equal(diagnostics.some((item) => item.code === 'unused-variable' && /name/.test(item.message)), false);
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
