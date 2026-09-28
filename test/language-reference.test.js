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

test('language references agree with implemented float, position and standard-library syntax', () => {
  const syntax = fs.readFileSync(path.join(__dirname, '..', 'syntax-draft.md'), 'utf8');
  const guide = fs.readFileSync(path.join(__dirname, '..', 'docs', 'tds-language-and-editor-guide.md'), 'utf8');
  assert.match(syntax, /基本型は `int`、`float`、`str`/);
  assert.match(syntax, /配置位置は `far_left`、`left`、`center`、`right`、`far_right` の5種類/);
  assert.match(syntax, /`%` は `int` 同士のみ/);
  assert.match(syntax, /`-`、`\*`、`\/` は左右が同じ数値型/);
  assert.match(syntax, /`std\/motion\/walk\.tds`/);
  assert.doesNotMatch(syntax, /辞書の値型も `int` または `str` のみ/);
  assert.doesNotMatch(syntax, /配置位置は `left`、`center`、`right`/);
  assert.doesNotMatch(syntax, /`-`、`\*`、`\/`、`%` は `int` 専用/);
  assert.match(guide, /`dict\[float\]`/);
  assert.match(guide, /structの入れ子/);
  assert.match(guide, /`min` \/ `max` は `int` と `float` に指定でき/);
  assert.doesNotMatch(guide, /型は int、str、dict\[int\]、dict\[str\]/);
  assert.doesNotMatch(guide, /min\/maxはint専用/);
});
