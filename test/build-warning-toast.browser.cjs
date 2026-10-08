'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require('../build/audit-tools/node_modules/playwright');
const { seedEmptyProject } = require('../tools/project-layout');

const root = path.resolve(__dirname, '..');

async function main() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-build-warning-'));
  const project = seedEmptyProject(path.join(tempRoot, 'project'));
  await fs.writeFile(path.join(project.scenesRoot, 'main.tds'), 'scene main {\n  goto "chapter.tds"\n}\n', 'utf8');
  await fs.writeFile(path.join(project.scenesRoot, 'chapter.tds'), 'scene chapter {\n  goto "last.tds"\n}\n', 'utf8');
  await fs.writeFile(path.join(project.scenesRoot, 'last.tds'), 'scene last {\n  start()\n  wait 1\n}\n', 'utf8');

  const child = spawn(process.execPath, [path.join(root, 'Edit/server.js'), '--project', project.projectRoot], {
    cwd: root,
    env: { ...process.env, PORT: '0', NOVEL_TEMP_STARTUP_WORKSPACE: '1', NOVEL_EDITOR_RECENT_FILE: path.join(tempRoot, 'recent.json') },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += String(chunk); });
  child.stderr.on('data', chunk => { output += String(chunk); });
  let browser;
  try {
    const base = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error(`Editor server startup timed out: ${output}`)), 30000);
      const inspect = () => {
        const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
        if (match) { clearTimeout(timer); resolve(match[0]); }
      };
      child.once('exit', code => { clearTimeout(timer); reject(Error(`Editor server exited ${code}: ${output}`)); });
      child.stdout.on('data', inspect);
      child.stderr.on('data', inspect);
      inspect();
    });
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(15000);
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(`${base}/index.html`);
    await page.waitForFunction(() => Boolean(document.querySelector('#scene-name')?.value));

    await page.route('**/api/project-build', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      ok: false,
      build: true,
      fileCount: 3,
      diagnostics: [
        { severity: 'warning', buildBlocking: true, code: 'start-screen-not-returned', file: 'chapter.tds', line: 3, column: 1, message: 'chapter warning' },
        { severity: 'warning', buildBlocking: true, code: 'start-screen-not-returned', file: 'last.tds', line: 3, column: 1, message: 'last warning' },
      ],
      error: 'build blocked',
    }) }));
    await page.locator('[data-menu="run"]').click();
    const blockedBuildResponse = page.waitForResponse(response => response.url().endsWith('/api/project-build'));
    await page.locator('[data-menu-action="build"]').click();
    const blockedBuild = await (await blockedBuildResponse).json();
    assert.equal(blockedBuild.ok, false, JSON.stringify(blockedBuild));
    const blockedWarnings = blockedBuild.diagnostics.filter(item => item.severity === 'warning' && item.buildBlocking);
    assert.deepEqual(blockedWarnings.map(item => [item.file, item.line, item.column]), [
      ['chapter.tds', 3, 1], ['last.tds', 3, 1],
    ], 'the Build response can report build-blocking warnings from multiple files with 1-based locations');

    const toast = page.locator('#build-warning-toast');
    await toast.waitFor({ state: 'visible' });
    const locations = toast.locator('.build-warning-toast-location');
    assert.deepEqual(await locations.allTextContents(), ['chapter.tds:3', 'last.tds:3'], 'toast follows the documented file:line display contract');
    await locations.nth(1).click();
    await page.waitForFunction(() => document.querySelector('#scene-name')?.value === 'last.tds');
    const caret = await page.locator('#editor').evaluate(editor => ({
      source: editor.value,
      start: editor.selectionStart,
      end: editor.selectionEnd,
    }));
    const targetOffset = caret.source.split('\n').slice(0, 2).join('\n').length + 1;
    assert.equal(caret.start, targetOffset, 'warning link opens the other file and moves the caret to the reported line');
    assert.equal(caret.end, targetOffset, 'a build warning without a symbol does not fabricate a selection range');

    await page.locator('.build-warning-toast-close').click();
    await toast.waitFor({ state: 'detached' });

    await page.unroute('**/api/project-build');
    await page.route('**/api/project-build', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      ok: false,
      build: true,
      fileCount: 3,
      diagnostics: [{ severity: 'warning', buildBlocking: true, code: 'start-screen-not-returned', file: 'last.tds', line: 3, column: 1, message: 'rebuild warning' }],
      error: 'build blocked',
    }) }));
    await page.locator('[data-menu="run"]').click();
    const repeatedBuildResponse = page.waitForResponse(response => response.url().endsWith('/api/project-build'));
    await page.locator('[data-menu-action="build"]').click();
    await repeatedBuildResponse;
    await toast.waitFor({ state: 'visible' });
    await page.unroute('**/api/project-build');

    let releaseBuild;
    let markBuildStarted;
    const buildStarted = new Promise(resolve => { markBuildStarted = resolve; });
    const heldBuild = new Promise(resolve => { releaseBuild = resolve; });
    await page.unroute('**/api/project-build');
    await page.route('**/api/project-build', async route => {
      markBuildStarted();
      await heldBuild;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        ok: true,
        build: true,
        fileCount: 3,
        name: 'stale.nsp.json',
        path: 'build/native-packages/stale.nsp.json',
        instructions: 1,
        diagnostics: [{ severity: 'warning', buildBlocking: true, code: 'stale-warning', file: 'last.tds', line: 2, column: 3, message: 'stale source snapshot' }],
      }) });
    });
    await page.locator('[data-menu="run"]').click();
    const staleBuildResponse = page.waitForResponse(response => response.url().endsWith('/api/project-build'));
    await page.locator('[data-menu-action="build"]').click();
    await buildStarted;
    await toast.waitFor({ state: 'detached' });
    await page.locator('#editor').fill('scene last {\n  start()\n  wait 2\n}\n');
    const currentValidation = page.waitForResponse(response => response.url().endsWith('/api/validate'));
    releaseBuild();
    await staleBuildResponse;
    await currentValidation;
    assert.equal(await toast.count(), 0, 'a build response for a changed editor snapshot does not restore stale warning UI');
    assert.doesNotMatch(await page.locator('#result').textContent(), /stale source snapshot|stale-warning/);

    await page.unroute('**/api/project-build');
    await page.locator('[data-menu="run"]').click();
    const rebuiltResponse = page.waitForResponse(response => response.url().endsWith('/api/project-build'));
    await page.locator('[data-menu-action="build"]').click();
    const rebuilt = await (await rebuiltResponse).json();
    assert.equal(rebuilt.ok, true, JSON.stringify(rebuilt));
    await page.locator('#result').getByText(/Compile complete/).waitFor();
    await toast.waitFor({ state: 'detached' });
    assert.deepEqual(pageErrors, [], 'the Browser Editor completes warning navigation, dismissal, and rebuild without page errors');
    console.log('PASS Build warning Browser integration: multi-file file:line navigation, close, stale response rejection, rebuild');
  } finally {
    await browser?.close();
    if (child.exitCode === null) {
      child.kill();
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 3000))]);
    }
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
