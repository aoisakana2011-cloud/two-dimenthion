const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require('../build/audit-tools/node_modules/playwright');

const root = path.resolve(__dirname, '..');
const project = path.join(root, 'Title');
const serverScript = path.join(root, 'Edit', 'server.js');

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

async function playRoute(browser, base, { route, firstChoice, routeChoice, plan, ending, endingFile = `endings/${route}_together.tds` }) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.setDefaultTimeout(8_000);
  const errors = [];
  const loadedFiles = [];
  const backgroundRequests = new Set();
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname === '/api/scene') loadedFiles.push(url.searchParams.get('name'));
    if (url.pathname.startsWith('/asset/bg/')) backgroundRequests.add(url.pathname);
  });
  await page.goto(`${base}/player.html?source=main.tds`);

  let previousText = '';
  let dialogueAdvances = 0;
  let choiceNumber = 0;
  let finished = false;
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => ({
      text: document.querySelector('#text')?.textContent?.trim() || '',
      choices: [...document.querySelectorAll('#choices .choice')].map(button => button.textContent.trim()),
      speaker: document.querySelector('#speaker-text')?.textContent?.trim() || '',
      playerError: document.querySelector('#speaker-text')?.textContent === 'PLAYER ERROR'
        ? document.querySelector('#text')?.textContent : '',
    }));
    if (state.playerError) throw Error(`player error on ${route} route: ${state.playerError}`);

    if (state.choices.length) {
      const wanted = plan[choiceNumber];
      assert.notEqual(wanted, undefined, `unexpected extra choice ${JSON.stringify(state.choices)} on ${route}`);
      assert.ok(wanted < state.choices.length, `choice ${wanted} outside ${JSON.stringify(state.choices)}`);
      await page.locator('#choices .choice').nth(wanted).click();
      choiceNumber++;
      previousText = '';
      continue;
    }

    if (state.text && state.text !== previousText) {
      if (state.text.includes(ending)) { finished = true; break; }
      previousText = state.text;
      dialogueAdvances++;
      if (state.speaker && state.speaker !== 'narrator') {
        assert.notEqual(state.speaker, 'toshihito', 'obsolete Imogayu cast leaked into the new project');
      }
      await page.locator('#next').click();
      continue;
    }
    await page.waitForTimeout(5);
  }

  assert.ok(finished, `${route} route did not reach ${ending}; files=${loadedFiles.join(', ')}`);
  assert.ok(dialogueAdvances >= 18, `${route} route too short: ${dialogueAdvances} advances`);
  assert.equal(choiceNumber, plan.length, `${route} route choice count`);
  assert.ok(loadedFiles.includes(firstChoice), `initial investigation branch ${firstChoice} not loaded`);
  assert.ok(loadedFiles.includes(routeChoice), `${routeChoice} not loaded`);
  assert.ok(loadedFiles.includes(endingFile), `${endingFile} not loaded`);
  assert.deepEqual(errors, []);
  assert.ok(backgroundRequests.size >= 2, `expected multiple backgrounds, got ${[...backgroundRequests]}`);

  const sprite = await page.evaluate(async () => {
    const image = document.querySelector('#characters .actor');
    if (!image) return null;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(image, 0, 0);
    return { width: image.naturalWidth, height: image.naturalHeight, cornerAlpha: context.getImageData(0, 0, 1, 1).data[3] };
  });
  assert.ok(sprite && sprite.width > 0 && sprite.height > 0, 'waist-up sprite failed to load');
  assert.equal(sprite.cornerAlpha, 0, `sprite should preserve transparent framing: ${JSON.stringify(sprite)}`);
  await page.close();
  return { dialogueAdvances, choices: choiceNumber, files: loadedFiles, sprite };
}

(async () => {
  let server;
  let browser;
  try {
    server = await startServer();
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const runs = await Promise.all([
      playRoute(browser, server.base, {
        route: 'mio', firstChoice: 'chapters/02_digital_trace.tds', routeChoice: 'routes/mio_01_trace.tds',
        plan: [0, 0, 0, 0], ending: '澪と歩む',
      }),
      playRoute(browser, server.base, {
        route: 'chihaya', firstChoice: 'chapters/02_provenance.tds', routeChoice: 'routes/chihaya_01_origin.tds',
        plan: [1, 1, 0, 0], ending: '千早と紡ぐ',
      }),
      playRoute(browser, server.base, {
        route: 'rei', firstChoice: 'chapters/02_digital_trace.tds', routeChoice: 'routes/rei_01_mask.tds',
        plan: [0, 2, 0, 0, 0], ending: '怜と選ぶ',
      }),
      playRoute(browser, server.base, {
        route: 'mio', firstChoice: 'chapters/02_digital_trace.tds', routeChoice: 'routes/mio_01_trace.tds',
        plan: [0, 0, 1, 0], ending: '澪と始める', endingFile: 'endings/mio_unanswered.tds',
      }),
    ]);
    console.log(`PASS modern visual-novel routes ${JSON.stringify(runs)}`);
  } finally {
    await browser?.close();
    await stopServer(server?.child);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
