const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { format, lex } = require('../shared/formatter');
const { parse } = require('../dist');
const { formatFiles } = require('../tools/format');

const corpus = [
  'scene main{say narrator "hello"}',
  'scene main{if ready{say narrator "yes"}else{say narrator "no"}}',
  'choice "route"{"first"{say narrator "A"}"second"{say narrator "B"}}',
  'global dict[str] labels={"first":{"next":"go"}}',
  'fn calculate(a:int,b:dict[str])->dict[int]{return {"ok":1}}',
  'float ratio=0.5\nfloat small=1e-3\nshow hero.normal left x+(ratio*2.5)',
  'scene incomplete {\nset value = fn(\n{"key":1}\n)\n}',
  '\uFEFFscene unicode {\u2028say narrator "line"\u2029}',
  'include dir/module.tds as mod\nscene main {\n  mod.start_route()\n}',
];

function withoutLocations(value) {
  if (Array.isArray(value)) return value.map(withoutLocations);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !['line', 'column', 'endLine', 'endColumn', 'file', 'nameLine', 'nameColumn', 'sourceColumns'].includes(key)).map(([key, item]) => [key, withoutLocations(item)]));
}

test('shared formatter contract is deterministic and idempotent', () => {
  for (const source of corpus) {
    const once = format(source);
    assert.equal(format(once), once, `not idempotent: ${source}`);
    assert.equal(format(once.replace(/\n/g, '\r\n')), once, 'line ending normalization must be stable');
  }
});

test('shared formatter reaches a stable layout for malformed branch and quote input', () => {
  const source = '}\nelse ] include if else "unterminated ] "unterminated { parallel';
  const formatted = '}\nelse] include if else "unterminated ] " unterminated {\n  parallel';
  assert.equal(format(source), formatted);
  assert.equal(format(formatted), formatted);
});

test('shared formatter preserves compiler CST semantics for valid corpus', () => {
  for (const source of [...corpus.slice(0, 6), corpus[7], corpus[8]]) {
    const original = withoutLocations(parse(source));
    const formatted = withoutLocations(parse(format(source)));
    assert.deepEqual(formatted, original, `formatter changed parsed structure: ${source}`);
  }
});

test('shared formatter preserves comments and statement boundaries around braces and newlines', () => {
  const sources = [
    'scene main {\n  say narrator "a" # } comment\n  say narrator "b"\n}',
    'scene main {\n  if ready {\n    wait 1\n  } // branch comment\n  else {\n    wait 2\n  }\n}',
    'scene main { # opening brace comment\r\n  wait 1\r\n} # closing brace comment\r\n',
    'scene main {\n  say narrator "// is text"\n\n  # standalone comment\n  say narrator "# is text"\n}',
  ];

  for (const source of sources) {
    const formatted = format(source);
    assert.deepEqual(withoutLocations(parse(formatted)), withoutLocations(parse(source)), `formatter changed comment/newline semantics: ${source}`);
    assert.equal(format(formatted), formatted, `comment layout is not idempotent: ${source}`);
    for (const comment of source.match(/(?:#|\/\/)[^\r\n]*/g) || []) {
      assert.ok(formatted.includes(comment), `formatter discarded comment: ${comment}`);
    }
  }
});

test('shared formatter preserves adjacent tokens in unquoted include paths', () => {
  const source = 'include dir/module-name.tds as module';
  const formatted = format(source);
  assert.equal(formatted, 'include dir/module-name.tds as module');
  assert.equal(parse(formatted).includes[0].path, 'dir/module-name.tds');
  assert.equal(format(formatted), formatted);
});

test('shared formatter expands parallel as a statement block', () => {
  const source = 'scene main{parallel{wait 1\nparallel{wait 2}}}';
  const formatted = format(source);
  assert.equal(formatted, 'scene main {\n  parallel {\n    wait 1\n    parallel {\n      wait 2\n    }\n  }\n}');
  assert.deepEqual(withoutLocations(parse(formatted)), withoutLocations(parse(source)));
  assert.equal(format(formatted), formatted);
});

test('shared formatter joins if branches across blank lines without changing their AST', () => {
  const source = 'scene main {\n  if ready {\n    say narrator "yes"\n  }\n\n  else {\n    say narrator "no"\n  }\n}';
  const formatted = format(source);
  assert.equal(formatted, 'scene main {\n  if ready {\n    say narrator "yes"\n  } else {\n    say narrator "no"\n  }\n}');
  assert.deepEqual(withoutLocations(parse(formatted)), withoutLocations(parse(source)));
  assert.equal(format(formatted), formatted);
});

test('shared formatter preserves signed pixel offsets on character display commands', () => {
  const source = 'show hero.smile right x-10 y+40 fade 300';
  const formatted = format(source);
  assert.deepEqual(parse(formatted).globals[0].args.slice(2).map(argument => argument.value), ['x-10', 'y+40', 'fade', 300]);
  assert.equal(format(formatted), formatted);
});

test('formatter preserves float literals and expression pixel offsets', () => {
  const source = 'float ratio=0.5\nfloat small=1e-3\nshow hero.normal left x+(ratio*2.5) y-(small)';
  const formatted = format(source);
  assert.deepEqual(withoutLocations(parse(formatted)), withoutLocations(parse(source)));
  assert.equal(format(formatted), formatted);
});

test('shared formatter preserves relative move commands and px offsets', () => {
  const source = 'move character hero by x-10 y+40 over 300\nmove bg by x+5';
  const formatted = format(source);
  assert.deepEqual(parse(formatted).globals.map(statement => statement.args.map(argument => argument.value)), [
    ['character', 'hero', 'by', 'x-10', 'y+40', 'over', 300],
    ['bg', 'by', 'x+5'],
  ]);
  assert.equal(format(formatted), formatted);
});

test('IDE auto-fix preserves --only as one token on visual commands', () => {
  const source = 'scene main{play video op --only\nshow image logo center --only\nbg room --only}';
  const formatted = format(source);
  assert.match(formatted, /play video op --only/);
  assert.match(formatted, /show image logo center --only/);
  assert.match(formatted, /bg room --only/);
  assert.deepEqual(withoutLocations(parse(formatted)), withoutLocations(parse(source)));
  assert.equal(format(formatted), formatted);
});

test('IDE auto-fix preserves --layer as one token on visual commands', () => {
  const source = 'scene main{play video op --layer 2\nshow image logo center --layer 3}';
  const formatted = format(source);
  assert.match(formatted, /play video op --layer 2/);
  assert.match(formatted, /show image logo center --layer 3/);
  assert.deepEqual(withoutLocations(parse(formatted)), withoutLocations(parse(source)));
  assert.equal(format(formatted), formatted);
});

test('shared tolerant lexer keeps strings/comments and structural symbols distinct', () => {
  const tokens = lex('say narrator "{not a block}" # }\nscene main {');
  assert.deepEqual(tokens.map(({ kind, value }) => [kind, value]), [
    ['word', 'say'], ['word', 'narrator'], ['string', '"{not a block}"'], ['comment', '# }' + '\n' + 'scene main {'],
  ]);
});

test('shared formatter preserves unsupported Unicode and control whitespace', () => {
  const unsupported = ['\u3000', '\u00a0', '\u000b', '\u000c'];
  for (const character of unsupported) {
    const source = `scene main { int${character}value = 1 }`;
    const formatted = format(source);
    assert.ok(formatted.includes(character), `formatter discarded U+${character.charCodeAt(0).toString(16)}`);
    assert.equal(format(formatted), formatted);
    assert.throws(() => parse(source), 'the compiler should reject the unsupported character');
    assert.throws(() => parse(formatted), 'formatting must not turn it into valid DSL');
  }
});

test('CLI formatter uses the same shared implementation as the IDE', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-formatter-contract-'));
  try {
    const file = path.join(directory, 'scene.tds');
    const source = 'scene main{say narrator "shared"}';
    await fs.writeFile(file, source, 'utf8');
    const result = await formatFiles([file]);
    assert.deepEqual(result.changed, [file]);
    assert.equal(await fs.readFile(file, 'utf8'), format(source));
    assert.deepEqual((await formatFiles([file])).changed, []);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('formatter CLI uses English for its usage and completion messages', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-formatter-cli-'));
  try {
    const file = path.join(directory, 'scene.tds');
    await fs.writeFile(file, 'scene main{wait 1}', 'utf8');
    const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'tools', 'format.js'), file], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^Formatted scene files: 1\/1 changed\r?\n$/);

    const usage = spawnSync(process.execPath, [path.join(__dirname, '..', 'tools', 'format.js')], { encoding: 'utf8' });
    assert.equal(usage.status, 2);
    assert.match(usage.stderr, /^Usage: node tools\/format\.js <scenario file or directory>/);

    const incomplete = '}\nelse ] include if else "unterminated ] "unterminated { parallel';
    const canonical = '}\nelse] include if else "unterminated ] " unterminated {\n  parallel';
    await fs.writeFile(file, incomplete, 'utf8');
    const malformed = spawnSync(process.execPath, [path.join(__dirname, '..', 'tools', 'format.js'), file], { encoding: 'utf8' });
    assert.equal(malformed.status, 0, malformed.stderr);
    assert.equal(await fs.readFile(file, 'utf8'), canonical);
    const malformedAgain = spawnSync(process.execPath, [path.join(__dirname, '..', 'tools', 'format.js'), file], { encoding: 'utf8' });
    assert.equal(malformedAgain.status, 0, malformedAgain.stderr);
    assert.equal(await fs.readFile(file, 'utf8'), canonical, 'CLI keeps malformed input stable after the first formatting pass');
    assert.match(malformedAgain.stdout, /^Formatted scene files: 0\/1 changed\r?\n$/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
