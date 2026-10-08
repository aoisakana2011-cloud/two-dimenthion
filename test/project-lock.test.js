const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createProjectLockFs} = require('../Edit/project-lock-fs');

test('project lock cleanup only removes a lock owned by this server process', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-project-lock-owner-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const lockDirectory = path.join(root, 'project.lock');
  await fs.mkdir(lockDirectory);
  await fs.writeFile(path.join(lockDirectory, '.novel-editor-owner'), 'next-process');

  createProjectLockFs(fsSync, 'old-process').rmdirSync(lockDirectory);
  assert.equal(await fs.stat(lockDirectory).then(() => true, () => false), true, 'an old process exit handler cannot remove the new owner lock');

  createProjectLockFs(fsSync, 'next-process').rmdirSync(lockDirectory);
  assert.equal(await fs.stat(lockDirectory).then(() => true, () => false), false, 'the current owner can release its own lock');
});

test('a process can remove a stale lock after claiming it under a unique reclaim path', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-project-lock-reclaim-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const claimedDirectory = path.join(root, 'project.lock.reclaim-123-random');
  await fs.mkdir(claimedDirectory);
  await fs.writeFile(path.join(claimedDirectory, '.novel-editor-owner'), 'dead-process');
  const lockFs = createProjectLockFs(fsSync, 'reclaimer');
  await new Promise((resolve, reject) => lockFs.rmdir(claimedDirectory, error => error ? reject(error) : resolve()));
  assert.equal(await fs.stat(claimedDirectory).then(() => true, () => false), false, 'the claimed stale directory is removed after rename');
});
