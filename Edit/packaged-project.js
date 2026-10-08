'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { seedEmptyProject } = require('../tools/project-layout');

const STARTUP_PREFIX = 'novel-editor-startup-';

function prepareStartupWorkspace(tempRoot) {
  const projectRoot = fs.mkdtempSync(path.join(tempRoot, STARTUP_PREFIX));
  try {
    seedEmptyProject(projectRoot);
    return projectRoot;
  } catch (error) {
    fs.rmSync(projectRoot, { recursive: true, force: true });
    throw error;
  }
}

function removeStartupWorkspace(tempRoot, projectRoot) {
  const safeTempRoot = path.resolve(tempRoot);
  const target = path.resolve(projectRoot);
  const relative = path.relative(safeTempRoot, target);
  if (path.isAbsolute(relative) || relative.startsWith(`..${path.sep}`) || path.basename(target).startsWith(STARTUP_PREFIX) === false) {
    throw new Error('起動用ではない作業フォルダーは削除できません。');
  }
  fs.rmSync(target, { recursive: true, force: true });
}

module.exports = { prepareStartupWorkspace, removeStartupWorkspace };
