'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { chromium } = require('../build/audit-tools/node_modules/playwright');
const { seedEmptyProject } = require('../tools/project-layout');

async function main() {
  const root = path.resolve(__dirname, '..');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-project-changes-'));
  const layout = seedEmptyProject(path.join(temp, 'project'));
  const mainFile = path.join(layout.scenesRoot, 'main.tds');
  let child, browser;
  try {
    child = spawn(process.execPath, [path.join(root, 'Edit', 'server.js'), '--project', layout.projectRoot], {
      cwd: root, env: { ...process.env, PORT: '0', NOVEL_TEMP_STARTUP_WORKSPACE: '1', NOVEL_EDITOR_RECENT_FILE: path.join(temp, 'recent.json') },
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const base = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error(`Server start timeout: ${output}`)), 30000);
      const check = () => {
        const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
        if (match) { clearTimeout(timer); resolve(match[0]); }
      };
      child.stdout.on('data', check);
      child.stderr.on('data', check);
      child.once('exit', (code) => { clearTimeout(timer); reject(Error(`Server exited ${code}: ${output}`)); });
    });
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage();
    const sceneReads = [];
    page.on('request', (request) => {
      if (request.url().includes('/api/scene?')) sceneReads.push(new URL(request.url()).searchParams.get('name'));
    });
    await page.goto(`${base}/index.html`);
    await page.waitForFunction(() => document.querySelector('#scene-name')?.value === 'main.tds' && Boolean(projectChangesToken));
    // A clean external edit is picked up by the periodic timer without a page reload.
    await fs.writeFile(mainFile, 'scene main {\n  say narrator "external update"\n}\n');
    await page.waitForFunction(() => document.querySelector('#editor')?.value.includes('external update'), null, { timeout: 12000 });
    assert.deepEqual([...new Set(sceneReads)], ['main.tds'], 'unchanged scene bodies are not fetched');

    const added = path.join(layout.scenesRoot, 'later.tds');
    await fs.writeFile(added, 'scene later {\n  say narrator "later"\n}\n');
    await page.evaluate(() => pollProjectChanges());
    await page.waitForFunction(() => [...document.querySelectorAll('#file-tree .scene-file')].some((item) => item.dataset.path.endsWith('/later.tds')));
    assert.deepEqual([...new Set(sceneReads)], ['main.tds'], 'adding a file updates the tree without loading its body');
    await fs.unlink(added);
    await page.evaluate(() => pollProjectChanges());
    await page.waitForFunction(() => ![...document.querySelectorAll('#file-tree .scene-file')].some((item) => item.dataset.path.endsWith('/later.tds')));

    await page.locator('#editor').fill('scene main {\n  say narrator "unsaved local"\n}\n');
    await fs.writeFile(mainFile, 'scene main {\n  say narrator "external conflict"\n}\n');
    await page.evaluate(() => pollProjectChanges());
    assert.match(await page.locator('#editor').inputValue(), /unsaved local/, 'unsaved edits are never overwritten');
    assert.match(await page.locator('#status').textContent(), /外部で変更/, 'an external conflict is visible');
    assert.deepEqual([...new Set(sceneReads)], ['main.tds'], 'dirty files are not loaded again');
    console.log('PASS project changes browser: periodic delta reload, add/remove, and dirty-edit protection');
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (child && child.exitCode === null) {
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      else child.kill('SIGTERM');
    }
    await fs.rm(temp, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
