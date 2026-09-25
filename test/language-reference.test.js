const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parse } = require('../dist');

test('TDS examples in the language references stay syntactically valid', () => {
  const references = ['syntax-draft.md', path.join('docs', 'tds-language-and-editor-guide.md')];
  let exampleCount = 0;
  for (const reference of references) {
    const source = fs.readFileSync(path.join(__dirname, '..', reference), 'utf8');
    const blocks = source.matchAll(/^(~~~|```)\s*tds\s*\r?\n([\s\S]*?)\r?\n\1\s*$/gm);
    for (const [, , example] of blocks) {
      exampleCount++;
      assert.doesNotThrow(() => parse(example), `${reference} contains invalid TDS example:\n${example}`);
    }
  }
  assert.ok(exampleCount >= 20, `expected to validate the reference examples, found ${exampleCount}`);
});
