'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { prepareStartupWorkspace, removeStartupWorkspace } = require('../Edit/packaged-project');

test('desktop startup uses an isolated temporary bootstrap instead of silently opening Title', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-desktop-startup-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  const project = prepareStartupWorkspace(tempRoot);
  assert.equal(path.dirname(project), tempRoot);
  assert.match(path.basename(project), /^novel-editor-startup-/);
  assert.equal(fs.readFileSync(path.join(project, 'senario', 'main.tds'), 'utf8'), 'scene main {\n  # Play an intro video or demo before opening the title screen.\n  start()\n  goto story\n}\n\nscene story {\n  say narrator "Write your story here."\n  goto main\n}\n');
  const screens = JSON.parse(fs.readFileSync(path.join(project, 'setting', 'game-screens.json'), 'utf8'));
  assert.ok(screens.screens[screens.initial].items.some(item => item.action === 'start'));
  assert.equal(fs.existsSync(path.join(project, 'asset', 'bg', 'README.txt')), true);

  removeStartupWorkspace(tempRoot, project);
  assert.equal(fs.existsSync(project), false);
});

test('desktop shutdown cleanup refuses to remove a user project', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-desktop-safe-cleanup-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const userProject = path.join(tempRoot, 'my-game');
  fs.mkdirSync(userProject);
  fs.writeFileSync(path.join(userProject, 'keep.txt'), 'user data');

  assert.throws(() => removeStartupWorkspace(tempRoot, userProject), /作業フォルダーは削除できません/);
  assert.equal(fs.readFileSync(path.join(userProject, 'keep.txt'), 'utf8'), 'user data');
});
