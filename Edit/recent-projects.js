'use strict';

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { projectLayout } = require('../tools/project-layout');

function recentProjectsFile() {
  return process.env.NOVEL_EDITOR_RECENT_FILE || path.join(os.homedir(), '.novel-editor', 'recent.json');
}

function isValidProjectFolder(folder) {
  if (typeof folder !== 'string' || !folder.trim()) return false;
  try {
    const resolved = path.resolve(folder);
    if (!fsSync.statSync(resolved).isDirectory()) return false;
    projectLayout(resolved);
    return true;
  } catch {
    return false;
  }
}

function sameFolder(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

async function readRecentProjects(file = recentProjectsFile()) {
  try {
    const data = JSON.parse(await fs.readFile(file, 'utf8'));
    const paths = Array.isArray(data?.paths) ? data.paths : [];
    const existing = [];
    for (const entry of paths) {
      if (!isValidProjectFolder(entry)) continue;
      const resolved = path.resolve(entry);
      if (!existing.some((candidate) => sameFolder(candidate, resolved))) existing.push(resolved);
    }
    return existing.slice(0, 12);
  } catch {
    return [];
  }
}

async function rememberProject(folder, file = recentProjectsFile()) {
  const resolved = path.resolve(folder);
  if (!isValidProjectFolder(resolved)) throw new Error('Cannot remember a folder that is not a valid project.');
  const paths = [resolved, ...(await readRecentProjects(file)).filter((entry) => !sameFolder(entry, resolved))].slice(0, 12);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ paths }, null, 2) + '\n', 'utf8');
  return paths;
}

async function findStartupProject(explicitProject = process.env.NOVEL_PROJECT_ROOT, file = recentProjectsFile()) {
  if (typeof explicitProject === 'string' && explicitProject.trim()) return path.resolve(explicitProject.trim());
  return (await readRecentProjects(file))[0] || '';
}

module.exports = { recentProjectsFile, isValidProjectFolder, readRecentProjects, rememberProject, findStartupProject };
