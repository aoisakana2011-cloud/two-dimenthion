const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { format, lex } = require('../shared/formatter');
const { parse } = require('../dist');
const { formatFiles } = require('../tools/format');

const corpus = [
  'scene main{say narrator "hello"}',
  'scene main{if ready{say narrator "yes"}else{say narrator "no"}}',
  'choice "route"{"first"{say narrator "A"}"second"{say narrator "B"}}',
  'global dict[str] labels={"first":{"next":"go"}}',
  'fn calculate(a:int,b:dict[str])->dict[int]{return {"ok":1}}',
  'scene incomplete {\nset value = fn(\n{"key":1}\n)\n}',
  '\uFEFFscene unicode {\u2028say narrator "line"\u2029}',
];

function withoutLocations(value) {
  if (Array.isArray(value)) return value.map(withoutLocations);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !['line', 'column', 'endLine', 'endColumn', 'file'].includes(key)).map(([key, item]) => [key, withoutLocations(item)]));
}

test('shared formatter contract is deterministic and idempotent', () => {
  for (const source of corpus) {
    const once = format(source);
    assert.equal(format(once), once, `not idempotent: ${source}`);
    assert.equal(format(once.replace(/\n/g, '\r\n')), once, 'line ending normalization must be stable');
  }
});

test('shared formatter preserves compiler CST semantics for valid corpus', () => {
  for (const source of corpus.slice(0, 5)) {
    const original = withoutLocations(parse(source));
    const formatted = withoutLocations(parse(format(source)));
    assert.deepEqual(formatted, original, `formatter changed parsed structure: ${source}`);
  }
});

test('shared tolerant lexer keeps strings/comments and structural symbols distinct', () => {
  const tokens = lex('say narrator "{not a block}" # }\nscene main {');
  assert.deepEqual(tokens.map(({ kind, value }) => [kind, value]), [
    ['word', 'say'], ['word', 'narrator'], ['string', '"{not a block}"'], ['comment', '# }' + '\n' + 'scene main {'],
  ]);
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
