'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ProjectChangeTracker } = require('../Edit/project-changes');

test('project polling reports only changed paths and reuses tokens for unchanged snapshots', async () => {
  let files = new Map([['senario/main.tds', 'a'], ['asset/bg.png', '1']]);
  const tracker = new ProjectChangeTracker(async () => new Map(files));
  const first = await tracker.changes('project');
  assert.equal(first.reset, true);
  assert.deepEqual(await tracker.changes('project', first.token), { root: 'project', token: first.token, reset: false, added: [], changed: [], removed: [] });
  files = new Map([['senario/main.tds', 'b'], ['senario/next.tds', 'x']]);
  const second = await tracker.changes('project', first.token);
  assert.deepEqual([second.added, second.changed, second.removed], [['senario/next.tds'], ['senario/main.tds'], ['asset/bg.png']]);
  files = new Map([['senario/main.tds', 'c'], ['asset/bg.png', '2']]);
  const third = await tracker.changes('project', first.token);
  assert.deepEqual([third.added, third.changed, third.removed], [[], ['senario/main.tds', 'asset/bg.png'], []]);
  assert.equal((await tracker.changes('other-project', third.token)).reset, true);
});

test('project polling resets stale tokens and does not advance after a scan error', async () => {
  let files = new Map([['main.tds', 'a']]);
  let fail = false;
  const tracker = new ProjectChangeTracker(async () => {
    if (fail) throw Error('scan failed');
    return new Map(files);
  }, 1);
  const first = await tracker.changes('project');
  fail = true;
  await assert.rejects(tracker.changes('project', first.token), /scan failed/);
  fail = false;
  assert.equal((await tracker.changes('project', first.token)).token, first.token);
  files = new Map([['main.tds', 'b']]);
  const second = await tracker.changes('project', first.token);
  assert.deepEqual(second.changed, ['main.tds']);
  files = new Map([['main.tds', 'c']]);
  assert.equal((await tracker.changes('project', first.token)).reset, true);
});
