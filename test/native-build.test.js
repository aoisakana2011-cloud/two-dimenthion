'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

test('Native build reports a missing CMake executable with a nonzero status', () => {
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '../tools/native-build.js')], {
    encoding: 'utf8',
    env: { ...process.env, PATH: '' },
    timeout: 10000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Could not start CMake during configure/);
  assert.doesNotMatch(result.stderr, /UnhandledPromiseRejection|TypeError/);
});
