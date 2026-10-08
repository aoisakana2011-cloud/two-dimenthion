const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require('../build/audit-tools/node_modules/playwright');

const root = path.resolve(__dirname, '..');
const project = path.join(root, 'Title');
const serverScript = path.join(root, 'Edit', 'server.js');
const FIRST_LINE = '演出チェックを始めます。各項目のあとで画面を確認してください。';
const LAST_LINE = '演出チェックを終了します。';
const REQUIRED_LINES = [
  FIRST_LINE,
  'ここから画面とキャラクターのモーションです。',
  '背景遷移: fade',
  '会話欄の不透明度と一時的なsay不透明度を確認します。',
  LAST_LINE,
];

async function startServer() {
  const child = spawn(process.execPath, [serverScript, '--project', project], {
    cwd: root, env: { ...process.env, PORT: '0' }, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += String(chunk); });
  child.stderr.on('data', chunk => { output += String(chunk); });
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error(`server startup timeout: ${output}`)), 15_000);
    const inspect = () => {
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    };
    child.stdout.on('data', inspect);
    child.stderr.on('data', inspect);
    child.once('exit', code => { clearTimeout(timer); reject(Error(`server exited ${code}: ${output}`)); });
  });
  return { child, base };
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  await new Promise(resolve => { child.once('exit', resolve); child.kill(); });
}

async function playCurrentTitle(browser, base) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.setDefaultTimeout(8_000);
  const errors = [];
  const loadedScenes = [];
  const backgrounds = new Set();
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname === '/api/scene') loadedScenes.push(url.searchParams.get('name'));
    if (url.pathname.startsWith('/asset/bg/')) backgrounds.add(url.pathname);
  });

  await page.goto(`${base}/player.html?source=main.tds`);
  const start = page.locator('#screen-overlay #title-start');
  await start.waitFor({ state: 'visible' });
  await start.click();
  await page.waitForFunction((line) => document.querySelector('#screen-overlay')?.hidden
    && document.querySelector('#text')?.textContent.includes(line), FIRST_LINE, { timeout: 15_000 });

  const observed = new Set();
  const deadline = Date.now() + 120_000;
  let previousText = '';
  let dialogueAdvances = 0;
  let skippedOptionalVideo = false;
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => ({
      text: document.querySelector('#text')?.textContent?.trim() || '',
      choices: [...document.querySelectorAll('#choices .choice')].map(button => button.textContent.trim()),
      playerError: document.querySelector('#speaker-text')?.textContent === 'Runtime Error'
        ? document.querySelector('#text')?.textContent : '',
    }));
    if (state.playerError) throw Error(`current Title playback failed: ${state.playerError}`);

    if (state.text.includes('約108秒') && !state.choices.length && !skippedOptionalVideo) {
      await page.waitForFunction(() => [...document.querySelectorAll('#choices .choice')]
        .some(button => button.textContent.includes('動画はスキップする')), null, { timeout: 5_000 });
      continue;
    }

    if (state.choices.length) {
      const skipIndex = state.choices.findIndex(label => label.includes('動画はスキップする'));
      assert.notEqual(skipIndex, -1, `unexpected Title choice: ${JSON.stringify(state.choices)}`);
      await page.locator('#choices .choice').nth(skipIndex).click();
      skippedOptionalVideo = true;
      previousText = state.text;
      continue;
    }

    if (state.text && state.text !== previousText) {
      observed.add(state.text);
      if (state.text.includes(LAST_LINE)) break;
      previousText = state.text;
      dialogueAdvances++;
      await page.locator('#next').click();
      continue;
    }
    await page.waitForTimeout(20);
  }

  assert.ok(observed.has(LAST_LINE), `current Title did not reach its ending line; observed=${JSON.stringify([...observed])}`);
  assert.ok(dialogueAdvances >= 25, `expected the full four-scene demo, got ${dialogueAdvances} dialogue advances`);
  for (const line of REQUIRED_LINES) assert.ok([...observed].some(text => text.includes(line)), `missing scene marker: ${line}`);
  assert.equal(skippedOptionalVideo, true, 'the optional 108-second video path was explicitly skipped');
  assert.ok(loadedScenes.includes('main.tds'), `entry scenario was not loaded: ${loadedScenes}`);
  assert.ok(backgrounds.size >= 5, `expected the current scenario backgrounds, got ${[...backgrounds]}`);
  assert.deepEqual(errors, [], `current Title emitted Browser errors: ${errors.join('\n')}`);
  await page.close();
  return { dialogueAdvances, loadedScenes, backgrounds: [...backgrounds], observedMarkers: REQUIRED_LINES.length };
}

(async () => {
  let server;
  let browser;
  try {
    server = await startServer();
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const result = await playCurrentTitle(browser, server.base);
    console.log(`PASS current Title start-to-ending playthrough ${JSON.stringify(result)}`);
  } finally {
    await browser?.close();
    await stopServer(server?.child);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
