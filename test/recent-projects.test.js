'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { seedEmptyProject } = require('../tools/project-layout');
const { findStartupProject, readRecentProjects, rememberProject } = require('../Edit/recent-projects');

test('desktop startup restores the newest valid project and explicit roots take precedence', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-recent-projects-'));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const recentFile = path.join(tempRoot, 'profile', 'recent.json');
  const first = seedEmptyProject(path.join(tempRoot, 'first'));
  const second = seedEmptyProject(path.join(tempRoot, 'second'));

  await rememberProject(first.projectRoot, recentFile);
  assert.equal(await findStartupProject('', recentFile), first.projectRoot);
  await rememberProject(second.projectRoot, recentFile);
  assert.equal(await findStartupProject('', recentFile), second.projectRoot);
  assert.equal(await findStartupProject(first.projectRoot, recentFile), first.projectRoot);

  await rememberProject(first.projectRoot, recentFile);
  assert.deepEqual(await readRecentProjects(recentFile), [first.projectRoot, second.projectRoot]);
});

test('startup ignores missing folders and directories that are not valid projects', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-recent-invalid-'));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const recentFile = path.join(tempRoot, 'recent.json');
  const project = seedEmptyProject(path.join(tempRoot, 'valid'));
  const notProject = path.join(tempRoot, 'not-a-project');
  await fs.mkdir(notProject);
  await fs.writeFile(recentFile, JSON.stringify({ paths: [path.join(tempRoot, 'removed'), notProject, project.projectRoot, project.projectRoot] }));

  assert.deepEqual(await readRecentProjects(recentFile), [project.projectRoot]);
  assert.equal(await findStartupProject('', recentFile), project.projectRoot);
  assert.equal(await findStartupProject('', path.join(tempRoot, 'missing.json')), '');
});
