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
          const choiceImageWidth = await page.evaluate(async () => {
            const background = getComputedStyle(document.querySelector('#choices .choice')).backgroundImage;
            const assetUrl = background.match(/^url\(["']?(.*?)["']?\)$/)?.[1];
            if (!assetUrl) return 0;
            const image = new Image();
            image.src = assetUrl;
            await image.decode();
            return image.naturalWidth;
          });
          assert.ok(choiceImageWidth > 0, 'choice paper artwork did not load');
          await page.screenshot({ path: path.join(root, 'build', 'title-choice.png') });
          capturedChoice = true;
        }
        await page.locator('#choices .choice').first().click();
        choicesMade++;
        previousText = '';
        continue;
      }
      if (state.text && state.text !== '読み込み中…' && state.text !== previousText) {
        if (state.text.includes('終　—')) break;
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

    assert.ok(Date.now() < deadline, 'playthrough did not reach an ending');
    assert.ok(sayAdvances > 45, `expected substantial dialogue interaction, got ${sayAdvances}`);
    assert.ok(choicesMade >= 4, `expected to operate the story choices, got ${choicesMade}`);
    for (const expected of ['chapters/banquet.tds', 'chapters/road.tds', 'chapters/lake.tds', 'chapters/feast.tds', 'endings/quiet.tds']) {
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
        context.drawImage(image, 0, 0);
        return context.getImageData(0, 0, 1, 1).data[3];
      }
      return { goi: await alphaAt('goi.png'), toshihito: await alphaAt('toshihito.png') };
    });
    const fogGradient = await page.evaluate(() => {
      const canvas = document.querySelector('#bottom-fog');
      const context = canvas.getContext('2d', { willReadFrequently: true });
      return {
        top: context.getImageData(Math.floor(canvas.width / 2), 0, 1, 1).data[3],
        bottom: context.getImageData(Math.floor(canvas.width / 2), canvas.height - 1, 1, 1).data[3],
      };
    });
    assert.equal(fogGradient.top, 0, `historical artwork should not have a white fog overlay: ${JSON.stringify(fogGradient)}`);
    assert.equal(fogGradient.bottom, 0, `historical artwork should not have a white fog overlay: ${JSON.stringify(fogGradient)}`);
    assert.equal(spriteAlpha.goi, 0, `goi sprite corner must be transparent: ${JSON.stringify(spriteAlpha)}`);
    assert.equal(spriteAlpha.toshihito, 0, `toshihito sprite corner must be transparent: ${JSON.stringify(spriteAlpha)}`);
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
    assert.ok(mobileLayout.width >= 391 - 1 && mobileLayout.height >= 845 - 1, `stage does not cover portrait viewport: ${JSON.stringify(mobileLayout)}`);
    console.log(`MOBILE ${JSON.stringify(mobileLayout)} SPRITE_ALPHA ${JSON.stringify(spriteAlpha)} FOG ${JSON.stringify(fogGradient)} TEXT ${JSON.stringify(textLayout)}`);

    const alternatePage = await browser.newPage();
    alternatePage.setDefaultTimeout(10_000);
    const alternateErrors = [];
    const alternateFiles = [];
    alternatePage.on('pageerror', error => alternateErrors.push(error.message));
    alternatePage.on('request', request => {
      const url = new URL(request.url());
      if (url.pathname === '/api/scene') alternateFiles.push(url.searchParams.get('name'));
    });
    await alternatePage.goto(`${server.base}/player.html?source=main.tds`);
    let alternateChoices = 0;
    let alternatePreviousText = '';
    let alternateReachedEnd = false;
    const alternateDeadline = Date.now() + 60_000;
    while (Date.now() < alternateDeadline) {
      const state = await alternatePage.evaluate(() => ({
        text: document.querySelector('#text')?.textContent || '',
        choices: document.querySelectorAll('#choices .choice').length,
        error: document.querySelector('#speaker-text')?.textContent === 'PLAYER ERROR'
          ? document.querySelector('#text')?.textContent : '',
      }));
      if (state.error) throw Error(`alternate ending player error: ${state.error}`);
      if (state.choices) {
        await alternatePage.locator('#choices .choice').nth(alternateChoices === 3 ? 1 : 0).click();
        alternateChoices++;
        alternatePreviousText = '';
        continue;
      }
      if (state.text && state.text !== '読み込み中…' && state.text !== alternatePreviousText) {
        if (state.text.includes('終　—')) {
          alternateReachedEnd = true;
          break;
        }
        alternatePreviousText = state.text;
        await alternatePage.locator('#next').click();
        continue;
      }
      await alternatePage.waitForTimeout(10);
    }
    assert.ok(alternateReachedEnd, 'alternate ending did not finish');
    assert.equal(alternateChoices, 4, 'alternate ending should follow the final choice');
    assert.ok(alternateFiles.includes('endings/another.tds'), `missing alternate ending transition: ${alternateFiles.join(', ')}`);
    assert.deepEqual(alternateErrors, []);
    await alternatePage.close();

    const nativeExe = process.env.NOVEL_NATIVE_EXE || path.join(root, 'native', 'build', 'Release', 'novel_player.exe');
    const nativeRun = spawnSync(nativeExe, [path.join(project, '.novel', 'build', 'main.nsp.json'), '--headless'], {
      cwd: root, encoding: 'utf8', timeout: 30_000, maxBuffer: 20 * 1024 * 1024,
    });
    assert.equal(nativeRun.status, 0, nativeRun.stderr || nativeRun.error?.message);
    const nativeTranscript = JSON.parse(nativeRun.stdout);
    const spokenLines = nativeTranscript.commands.filter(command => command.name === 'say').map(command => String(command.args[1]));
    for (const expected of ['平安の都。摂政の邸には、名を呼ばれることのない侍がいた。', '数日後。二人は冬の都を出た。', '五位は小さくくしゃみをした。']) {
      assert.ok(spokenLines.includes(expected), `native runtime did not reach ${expected}`);
    }
    console.log(`PASS Title Native runtime: ${spokenLines.length} lines, globals ${JSON.stringify(nativeTranscript.globals)}`);
    console.log(`PASS Title Browser playthrough: ${sayAdvances} dialogue advances, ${choicesMade} choices, loaded ${loadedFiles.join(' -> ')}`);
    console.log(`PASS Title alternate ending: ${alternateChoices} choices, loaded ${alternateFiles.join(' -> ')}`);
  } finally {
    await browser?.close();
    await stopServer(server?.child);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
