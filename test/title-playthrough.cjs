const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
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

(async () => {
  let server;
  let browser;
  try {
    server = await startServer();
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage();
    page.setDefaultTimeout(10_000);
    const errors = [];
    const loadedFiles = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.pathname === '/api/scene') loadedFiles.push(url.searchParams.get('name'));
    });
    await page.goto(`${server.base}/player.html?source=main.tds`);

    let previousText = '';
    let sayAdvances = 0;
    let choicesMade = 0;
    let capturedDialogue = false;
    let capturedChoice = false;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const state = await page.evaluate(() => ({
        text: document.querySelector('#text')?.textContent || '',
        choices: [...document.querySelectorAll('#choices .choice')].map(button => button.textContent.trim()),
        error: document.querySelector('#speaker-text')?.textContent === 'PLAYER ERROR'
          ? document.querySelector('#text')?.textContent : '',
      }));
      if (state.error) throw Error(`player reported error: ${state.error}`);
      if (state.choices.length) {
        if (!capturedChoice) {
          await page.screenshot({ path: path.join(root, 'build', 'title-choice.png') });
          capturedChoice = true;
        }
        await page.locator('#choices .choice').first().click();
        choicesMade++;
        previousText = '';
        continue;
      }
      if (state.text && state.text !== '読み込み中…' && state.text !== previousText) {
        if (state.text.includes('この章の記録は')) break;
        const speaker = await page.locator('#speaker-text').textContent();
        if (!capturedDialogue && speaker && await page.locator('.actor').count() >= 1) {
          await page.screenshot({ path: path.join(root, 'build', 'title-dialogue.png') });
          capturedDialogue = true;
        }
        previousText = state.text;
        await page.locator('#next').click();
        sayAdvances++;
        continue;
      }
      await page.waitForTimeout(10);
    }

    assert.ok(Date.now() < deadline, 'playthrough did not reach the route chapter end');
    assert.ok(sayAdvances > 100, `expected substantial dialogue interaction, got ${sayAdvances}`);
    assert.ok(choicesMade >= 1, `expected to operate a route choice, got ${choicesMade}`);
    for (const expected of ['chapters/chapter01.tds', 'chapters/chapter02.tds', 'chapters/chapter03.tds', 'chapters/chapter04.tds', 'routes/sora.tds']) {
      assert.ok(loadedFiles.includes(expected), `missing file transition ${expected}; loaded: ${loadedFiles.join(', ')}`);
    }
    assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(root, 'build', 'title-playthrough.png'), fullPage: true });
    const layout = await page.evaluate(() => {
      const rect = selector => {
        const box = document.querySelector(selector).getBoundingClientRect();
        return { x: box.x, y: box.y, width: box.width, height: box.height, right: box.right, bottom: box.bottom };
      };
      return { viewport: { width: innerWidth, height: innerHeight }, stage: rect('#stage'), dialogue: rect('#dialogue'), text: rect('#text'), speaker: rect('#speaker'), characters: [...document.querySelectorAll('.actor')].map(node => ({ id: node.id, ...node.getBoundingClientRect().toJSON() })) };
    });
    assert.ok(layout.speaker.y >= layout.dialogue.y && layout.speaker.bottom <= layout.dialogue.bottom, 'speaker nameplate should sit inside the dialogue panel');
    assert.ok(layout.text.y >= layout.speaker.bottom, 'dialogue text should start below the speaker nameplate');
    console.log(`LAYOUT ${JSON.stringify(layout)}`);
    const spriteAlpha = await page.evaluate(async () => {
      async function alphaAt(path) {
        const image = new Image();
        image.src = `/asset/char/${path}`;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        context.drawImage(image, 0, 0, 1, 1);
        return context.getImageData(0, 0, 1, 1).data[3];
      }
      return { sora: await alphaAt('aokami-transparent.png'), nene: await alphaAt('hatena-transparent.png') };
    });
    const fogGradient = await page.evaluate(() => {
      const canvas = document.querySelector('#bottom-fog');
      const context = canvas.getContext('2d', { willReadFrequently: true });
      return {
        top: context.getImageData(Math.floor(canvas.width / 2), 0, 1, 1).data[3],
        bottom: context.getImageData(Math.floor(canvas.width / 2), canvas.height - 1, 1, 1).data[3],
      };
    });
    assert.ok(fogGradient.top < fogGradient.bottom, `mist must grow stronger from bottom to top: ${JSON.stringify(fogGradient)}`);
    assert.ok(spriteAlpha.sora < 240 && spriteAlpha.nene < 240, `character sprite corners retain the baked checker background: ${JSON.stringify(spriteAlpha)}`);
    const textLayout = await page.evaluate(() => {
      const text = document.querySelector('#text');
      const original = text.textContent;
      text.textContent = '表示の折り返し確認。'.repeat(80);
      const result = { overflowY: getComputedStyle(text).overflowY, clientHeight: text.clientHeight, scrollHeight: text.scrollHeight };
      text.textContent = original;
      return result;
    });
    assert.equal(textLayout.overflowY, 'auto');
    assert.ok(textLayout.scrollHeight > textLayout.clientHeight, `long text cannot scroll: ${JSON.stringify(textLayout)}`);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    await page.waitForTimeout(50);
    const mobileLayout = await page.evaluate(() => {
      const rect = document.querySelector('#stage').getBoundingClientRect();
      return { viewportWidth: innerWidth, viewportHeight: innerHeight, transform: getComputedStyle(document.querySelector('#stage')).transform, x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
    });
    assert.ok(mobileLayout.x >= -1 && mobileLayout.y >= -1 && mobileLayout.right <= 391 && mobileLayout.bottom <= 845, `stage does not fit portrait viewport: ${JSON.stringify(mobileLayout)}`);
    console.log(`MOBILE ${JSON.stringify(mobileLayout)} SPRITE_ALPHA ${JSON.stringify(spriteAlpha)} FOG ${JSON.stringify(fogGradient)} TEXT ${JSON.stringify(textLayout)}`);
    const nativeExe = process.env.NOVEL_NATIVE_EXE || path.join(root, 'native', 'build', 'Release', 'novel_player.exe');
    const nativeRun = spawnSync(nativeExe, [path.join(project, '.novel', 'build', 'main.nsp.json'), '--headless'], {
      cwd: root, encoding: 'utf8', timeout: 30_000, maxBuffer: 20 * 1024 * 1024,
    });
    assert.equal(nativeRun.status, 0, nativeRun.stderr || nativeRun.error?.message);
    const nativeTranscript = JSON.parse(nativeRun.stdout);
    const spokenLines = nativeTranscript.commands.filter(command => command.name === 'say').map(command => String(command.args[1]));
    for (const expected of ['第一章・雨の校舎・第1節', '第四章・最後の鍵・第1節', 'ソラルート・青い旋律・第1節']) {
      assert.ok(spokenLines.includes(expected), `native runtime did not reach ${expected}`);
    }
    console.log(`PASS Title Native runtime: ${spokenLines.length} lines, globals ${JSON.stringify(nativeTranscript.globals)}`);
    console.log(`PASS Title Browser playthrough: ${sayAdvances} dialogue advances, ${choicesMade} choices, loaded ${loadedFiles.join(' -> ')}`);
  } finally {
    await browser?.close();
    await stopServer(server?.child);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
