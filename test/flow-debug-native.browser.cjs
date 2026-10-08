'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require('../build/audit-tools/node_modules/playwright');
const { seedEmptyProject } = require('../tools/project-layout');

const repoRoot = path.resolve(__dirname, '..');

async function waitForNativeLocation(base, session, predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastState = null;
  while (Date.now() < deadline) {
    const response = await fetch(`${base}/api/native-play/state?session=${encodeURIComponent(session)}`);
    assert.equal(response.status, 200, `Native state request failed: ${response.status}`);
    lastState = await response.json();
    if (!lastState.active) throw Error(`Native debug process ended before reaching the expected location: ${JSON.stringify(lastState)}`);
    if (lastState.location && predicate(lastState.location)) return lastState.location;
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  throw Error(`Native Player did not report the expected execution location: ${JSON.stringify(lastState)}`);
}

async function main() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-flow-native-debug-'));
  const project = seedEmptyProject(path.join(tempRoot, 'project'));
  await fs.writeFile(path.join(project.scenesRoot, 'main.tds'), [
    'global int score = 1',
    'scene main {',
    '  set score = score + 1',
    '  goto "chapter.tds"',
    '}',
    '',
  ].join('\n'), 'utf8');
  await fs.writeFile(path.join(project.scenesRoot, 'chapter.tds'), [
    'scene chapter {',
    '  say narrator "FLOW_NATIVE_CHAPTER_SENTINEL"',
    '  wait 30000',
    '}',
    '',
  ].join('\n'), 'utf8');

  const child = spawn(process.execPath, [path.join(repoRoot, 'Edit/server.js'), '--project', project.projectRoot], {
    cwd: repoRoot,
    env: { ...process.env, PORT: '0', NOVEL_TEMP_STARTUP_WORKSPACE: '1', NOVEL_EDITOR_RECENT_FILE: path.join(tempRoot, 'recent.json') },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += String(chunk); });
  child.stderr.on('data', chunk => { output += String(chunk); });
  let browser;
  let base = '';
  let session = '';
  try {
    base = await new Promise((resolve, reject) => {
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
    await page.evaluate(() => openScene('main.tds'));
    await page.locator('[data-activity="flow"]').click();

    const flow = page.frameLocator('#scene-flow-frame');
    await flow.locator('.flow-node[data-file="main.tds"]').click();
    await flow.locator('#flow-test-line').fill('3');
    await page.waitForFunction(() => {
      const button = document.querySelector('#scene-flow-frame')?.contentDocument?.querySelector('#flow-test-run');
      return Boolean(button && !button.disabled);
    });

    const playResponsePromise = page.waitForResponse(response =>
      response.url().endsWith('/api/native-play') && response.request().method() === 'POST');
    await flow.locator('#flow-test-run').click();
    const playResponse = await playResponsePromise;
    const launch = await playResponse.json();
    assert.equal(playResponse.status(), 200, JSON.stringify(launch));
    const launchRequest = playResponse.request().postDataJSON();
    assert.equal(launchRequest.debugStart.file, 'main.tds');
    assert.equal(launchRequest.debugStart.scene, 'main');
    assert.equal(launchRequest.debugStart.line, 3);
    assert.equal(launchRequest.debugStart.variables.score?.type, 'int');
    assert.equal(launchRequest.debugStart.variables.score?.value, '1');
    assert.equal(launch.ok, true);
    assert.equal(launch.engine, 'native', 'Scene Flow must launch the Native Player');
    assert.match(launch.session, /^[0-9a-f-]{36}$/i);
    session = launch.session;
    await fs.access(path.join(project.projectRoot, launch.package));

    const nativeLocation = await waitForNativeLocation(base, session, location =>
      path.basename(location.file).toLowerCase() === 'chapter.tds'
      && location.scene === 'chapter' && location.line === 2);
    assert.equal(path.basename(nativeLocation.file).toLowerCase(), 'chapter.tds');
    assert.equal(nativeLocation.scene, 'chapter');
    assert.equal(nativeLocation.line, 2, 'the actual Native interpreter reached the blocking dialogue in the external file');
    await page.waitForFunction(() => document.querySelector('#scene-name')?.value === 'chapter.tds'
      && document.querySelector('#highlight .hl-running')?.textContent.includes('FLOW_NATIVE_CHAPTER_SENTINEL'));
    assert.equal(await page.locator('#editor').inputValue().then(source => source.includes('FLOW_NATIVE_CHAPTER_SENTINEL')), true,
      'Native execution polling opens the destination file and highlights its live source line in the Browser Editor');

    await page.locator('[data-activity="flow"]').click();
    const stopButton = flow.locator('#flow-test-stop');
    await page.waitForFunction(() => {
      const button = document.querySelector('#scene-flow-frame')?.contentDocument?.querySelector('#flow-test-stop');
      return Boolean(button && !button.disabled);
    });
    const stopResponsePromise = page.waitForResponse(response =>
      response.url().endsWith('/api/native-play/stop') && response.request().method() === 'POST');
    await stopButton.click();
    const stopResponse = await stopResponsePromise;
    const stopResult = await stopResponse.json();
    assert.equal(stopResponse.status(), 200, JSON.stringify(stopResult));
    assert.equal(stopResult.stopped, true, 'Scene Flow Stop terminates the real Native debug session');
    const inactive = await (await fetch(`${base}/api/native-play/state?session=${encodeURIComponent(session)}`)).json();
    assert.equal(inactive.active, false);
    assert.deepEqual(pageErrors, [], 'Browser Editor and Scene Flow complete the Native debug flow without page errors');
    console.log('PASS Scene Flow Native integration: Browser run request, real Native cross-file execution/location, Editor highlight, and Native stop');
  } finally {
    if (session && base && child.exitCode === null) {
      await fetch(`${base}/api/native-play/stop`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session }),
      }).catch(() => {});
    }
    await browser?.close();
    if (child.exitCode === null) {
      child.kill();
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 3000))]);
    }
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
