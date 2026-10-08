'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { inflateSync } = require('node:zlib');
const { chromium } = require('../build/audit-tools/node_modules/playwright');
const { pack } = require('../tools/pack');
const { seedEmptyProject } = require('../tools/project-layout');

function decodePng(buffer) {
  let width = 0, height = 0, bitDepth = 0, colorType = 0;
  const chunks = [];
  for (let offset = 8; offset < buffer.length;) {
    const length = buffer.readUInt32BE(offset), type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length); offset += length + 12;
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; }
    if (type === 'IDAT') chunks.push(data);
    if (type === 'IEND') break;
  }
  assert.equal(bitDepth, 8);
  assert.ok(colorType === 2 || colorType === 6);
  const channels = colorType === 6 ? 4 : 3, stride = width * channels;
  const raw = inflateSync(Buffer.concat(chunks)), pixels = Buffer.alloc(height * stride);
  const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
  let source = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[source++], row = y * stride;
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? pixels[row + x - channels] : 0;
      const above = y ? pixels[row - stride + x] : 0;
      const upperLeft = y && x >= channels ? pixels[row - stride + x - channels] : 0;
      const predictor = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? above : filter === 3 ? Math.floor((left + above) / 2) : paeth(left, above, upperLeft);
      pixels[row + x] = (raw[source++] + predictor) & 255;
    }
  }
  return { width, height, channels, pixels };
}

function pixel(image, x, y) {
  const offset = (y * image.width + x) * image.channels;
  return [...image.pixels.subarray(offset, offset + 3)];
}

async function startServer(projectRoot) {
  const serverScript = path.resolve(__dirname, '../Edit/server.js');
  const child = spawn(process.execPath, [serverScript, '--project', projectRoot], {
    cwd: path.resolve(__dirname, '..'), env: { ...process.env, PORT: '0' }, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += String(chunk); });
  child.stderr.on('data', chunk => { output += String(chunk); });
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error(`server startup timeout: ${output}`)), 15_000);
    const inspect = () => { const match = output.match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timer); resolve(match[0]); } };
    child.stdout.on('data', inspect); child.stderr.on('data', inspect);
    child.once('exit', code => { clearTimeout(timer); reject(Error(`server exited ${code}: ${output}`)); });
  });
  return { child, base };
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  await new Promise(resolve => { child.once('exit', resolve); child.kill(); });
}

(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-screen-focus-'));
  let server, browser;
  try {
    const project = seedEmptyProject(path.join(tempRoot, 'project'));
    await fs.writeFile(path.join(project.scenesRoot, 'main.tds'), 'scene main {\n  start()\n}\n', 'utf8');
    await fs.mkdir(path.join(project.settingsRoot, 'screens'), { recursive: true });
    await fs.writeFile(path.join(project.settingsRoot, 'game-screens.json'), JSON.stringify({
      version: 1, initial: 'title', stylesheet: 'screens/focus.css',
      screens: { title: { template: 'screens/focus.html' } },
    }), 'utf8');
    await fs.writeFile(path.join(project.settingsRoot, 'screens', 'focus.html'), '<main><div class="probe" id="focus-negative" tabindex="-1" data-action="back">Skip in keyboard order</div><button class="probe" id="focus-click" data-action="setting-value" data-target="audio.bgmMuted" data-value="true">Toggle</button><div id="focus-underlay"></div><button class="probe" id="focus-start" tabindex="1" data-action="start"><span id="focus-label">Start</span></button><button class="probe no-id" tabindex="2">Static button</button><button class="probe dup-first" id="duplicate" tabindex="3">First duplicate</button><button class="probe dup-second" id="duplicate" tabindex="4">Second duplicate</button><div class="probe" id="disabled-continue" tabindex="5" data-action="continue">Continue disabled</div><button class="probe hidden-action" id="hidden-action" tabindex="6" data-action="back">Hidden action</button><div id="paint-high"></div><div id="paint-low"></div></main>\n', 'utf8');
    await fs.writeFile(path.join(project.settingsRoot, 'screens', 'focus.css'), 'main{width:1280px;height:720px;background-color:#111111}.probe{position:absolute;width:220px;height:70px;color:#ffffff;background-color:#222222}#focus-start{left:40px;top:40px;z-index:2;opacity:0.5}#focus-click{left:40px;top:140px}.no-id{left:40px;top:240px}.dup-first{left:40px;top:340px;z-index:20}.dup-second{left:40px;top:440px;z-index:1}#disabled-continue{left:40px;top:540px}.hidden-action{display:none}#focus-underlay{position:absolute;left:40px;top:40px;width:220px;height:70px;z-index:1;background-color:#0000ff}#paint-high,#paint-low{position:absolute;left:700px;top:40px;width:120px;height:80px}#paint-high{z-index:20;background-color:#0000ff}#paint-low{z-index:1;background-color:#ff0000}.probe:focus{background-color:#00cc00}.probe:focus-visible{background-color:#cc0000;color:#00ff00}\n', 'utf8');
    const packagePath = path.join(project.buildRoot, 'focus.nsp.json');
    await pack(path.join(project.scenesRoot, 'main.tds'), packagePath, { projectRoot: project.projectRoot });

    server = await startServer(project.projectRoot);
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.setDefaultTimeout(8_000);
    await page.goto(`${server.base}/player.html?source=main.tds`);
    const clickButton = page.locator('#screen-overlay #focus-click');
    await clickButton.waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.activeElement?.id === 'focus-start', null, { timeout: 8_000 });
    const browserStacking = decodePng(await page.locator('#screen-overlay').screenshot());
    assert.deepEqual(pixel(browserStacking, 705, 45), [0, 0, 255], 'Browser paints the earlier higher-z sibling above the later lower-z sibling');
    const disabledContinue = page.locator('#screen-overlay #disabled-continue');
    assert.equal(await disabledContinue.getAttribute('aria-disabled'), 'true', 'a disabled non-button action exposes its unavailable state');
    assert.equal(await disabledContinue.evaluate(node => node.tabIndex), -1, 'a disabled non-button action is removed from Browser keyboard traversal');
    assert.equal(await page.locator('#screen-overlay #hidden-action').evaluate(node => node.getClientRects().length), 0, 'display:none action stays out of the rendered screen');
    await clickButton.click();
    const mouseState = await clickButton.evaluate(node => ({
      background: getComputedStyle(node).backgroundColor,
      focusVisible: node.matches(':focus-visible'),
      focused: document.activeElement === node,
    }));
    assert.deepEqual(mouseState, { background: 'rgb(0, 204, 0)', focusVisible: false, focused: true }, 'a pointer-focused action receives :focus declarations but not :focus-visible declarations');
    const browserMousePixels = decodePng(await clickButton.screenshot());
    const browserMousePixel = pixel(browserMousePixels, 15, 15);
    assert.deepEqual(browserMousePixel, [0, 204, 0], 'Browser screenshot contains the ordinary-focus green state after a real click');

    await page.keyboard.press('Tab');
    const keyboardButton = page.locator('#screen-overlay #focus-start');
    await page.waitForFunction(() => document.activeElement?.id === 'focus-start' && document.activeElement.matches(':focus-visible'));
    const keyboardState = await keyboardButton.evaluate(node => ({ background: getComputedStyle(node).backgroundColor, focusVisible: node.matches(':focus-visible') }));
    assert.deepEqual(keyboardState, { background: 'rgb(204, 0, 0)', focusVisible: true }, 'Tab navigation applies :focus-visible declarations');
    assert.equal(await page.locator('#focus-label').evaluate(node => getComputedStyle(node).color), 'rgb(0, 255, 0)', 'inherited focus-visible text styles cascade to unstyled descendants in Browser');
    const browserKeyboardPixels = decodePng(await keyboardButton.screenshot());
    const browserKeyboardPixel = pixel(browserKeyboardPixels, 15, 15);
    assert.ok(browserKeyboardPixel[0] > 90 && browserKeyboardPixel[0] < 115 && browserKeyboardPixel[1] < 8 && browserKeyboardPixel[2] > 115 && browserKeyboardPixel[2] < 140, `Browser composes focused red with the blue lower-z sibling through parent opacity: ${browserKeyboardPixel}`);
    await page.keyboard.press('Tab');
    await page.waitForFunction(() => document.activeElement?.textContent === 'Static button');
    assert.equal(await page.locator('#screen-overlay #focus-negative').evaluate(node => node.tabIndex), -1, 'negative tabindex remains excluded while Tab proceeds in authored order');
    assert.equal(await page.locator('#screen-overlay button').filter({ hasText: 'Static button' }).evaluate(node => node.matches(':focus-visible')), true, 'a semantic button without id or data-action remains in Browser keyboard order');
    await page.keyboard.press('Tab');
    await page.waitForFunction(() => document.activeElement?.textContent === 'First duplicate');
    assert.equal(await page.locator('#screen-overlay button').filter({ hasText: 'Second duplicate' }).evaluate(node => node.matches(':focus-visible')), false, 'duplicate IDs do not affect Browser focus identity');
    await page.keyboard.press('Tab');
    await page.waitForFunction(() => document.activeElement?.textContent === 'Second duplicate');
    await page.keyboard.press('Tab');
    await page.waitForFunction(() => document.activeElement?.id === 'focus-click');
    await page.keyboard.press('Tab');
    await page.waitForFunction(() => document.activeElement?.id === 'focus-start');
    assert.notEqual(await page.evaluate(() => document.activeElement?.id), 'hidden-action', 'display:none action never enters the Browser keyboard cycle');

    const captureDirectory = path.join(tempRoot, 'native-captures'); await fs.mkdir(captureDirectory);
    const exe = process.env.NOVEL_NATIVE_EXE || path.resolve(__dirname, '../native/build/Release/novel_player.exe');
    const native = spawnSync(exe, [packagePath, '--screen-focus-visual-smoke'], {
      encoding: 'utf8', timeout: 20_000,
      env: { ...process.env, NOVEL_SCREEN_CAPTURE_DIR: captureDirectory, SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy' },
    });
    assert.equal(native.status, 0, native.stderr || native.error?.message || native.stdout);
    const nativeStacking = decodePng(await fs.readFile(path.join(captureDirectory, 'stacking-order.png')));
    assert.deepEqual(pixel(nativeStacking, 705, 45), [0, 0, 255], 'Native paints the earlier higher-z sibling above the later lower-z sibling');
    const nativeMouse = decodePng(await fs.readFile(path.join(captureDirectory, 'mouse-focus.png')));
    const nativeKeyboard = decodePng(await fs.readFile(path.join(captureDirectory, 'keyboard-focus.png')));
    const nativeStaticButton = decodePng(await fs.readFile(path.join(captureDirectory, 'static-button-focus.png')));
    const nativeDuplicateFirst = decodePng(await fs.readFile(path.join(captureDirectory, 'duplicate-first-focus.png')));
    const nativeDuplicateSecond = decodePng(await fs.readFile(path.join(captureDirectory, 'duplicate-second-focus.png')));
    const nativeMousePixel = pixel(nativeMouse, 55, 155), nativeKeyboardPixel = pixel(nativeKeyboard, 55, 55);
    assert.ok(nativeMousePixel[1] > nativeMousePixel[0] * 1.4 && nativeMousePixel[1] > nativeMousePixel[2] * 1.2, `Native SDL mouse-focus pixel is green-dominant: ${nativeMousePixel}`);
    assert.ok(nativeKeyboardPixel[0] > 90 && nativeKeyboardPixel[0] < 115 && nativeKeyboardPixel[1] < 8 && nativeKeyboardPixel[2] > 115 && nativeKeyboardPixel[2] < 140, `Native SDL composes focused red with the blue lower-z sibling through parent opacity: ${nativeKeyboardPixel}`);
    const nativeStaticButtonPixel = pixel(nativeStaticButton, 245, 290);
    assert.ok(nativeStaticButtonPixel[0] > nativeStaticButtonPixel[1] * 1.4 && nativeStaticButtonPixel[0] > nativeStaticButtonPixel[2] * 1.2, `Native SDL focuses the semantic button without data-action: ${nativeStaticButtonPixel}`);
    const duplicateFirstPixel = pixel(nativeDuplicateFirst, 245, 390), duplicateOtherPixel = pixel(nativeDuplicateFirst, 245, 490);
    assert.ok(duplicateFirstPixel[0] > duplicateFirstPixel[1] * 1.4 && duplicateFirstPixel[0] > duplicateFirstPixel[2] * 1.2, `Native SDL focuses the first duplicate-id button: ${duplicateFirstPixel}`);
    assert.ok(duplicateOtherPixel[0] < 100 && duplicateOtherPixel[1] < 100, `Native SDL leaves the second duplicate-id button unfocused: ${duplicateOtherPixel}`);
    const duplicateSecondPixel = pixel(nativeDuplicateSecond, 245, 490);
    assert.ok(duplicateSecondPixel[0] > duplicateSecondPixel[1] * 1.4 && duplicateSecondPixel[0] > duplicateSecondPixel[2] * 1.2, `Native SDL independently focuses the second duplicate-id button: ${duplicateSecondPixel}`);
    let nativeInheritedFocusGlyphs = 0;
    for (let y = 40; y < 110; y++) for (let x = 40; x < 260; x++) {
      const [red, green, blue] = pixel(nativeKeyboard, x, y);
      if (green > 150 && green > red * 1.5 && green > blue * 1.5) nativeInheritedFocusGlyphs++;
    }
    assert.ok(nativeInheritedFocusGlyphs > 0, `Native SDL draws descendant text using inherited focus-visible color inside the z-index/opacity context (green pixels=${nativeInheritedFocusGlyphs})`);
    const browserKeyboardGlyphs = decodePng(await keyboardButton.locator('#focus-label').screenshot());
    let browserInheritedFocusGlyphs = 0;
    for (let y = 0; y < browserKeyboardGlyphs.height; y++) for (let x = 0; x < browserKeyboardGlyphs.width; x++) {
      const [red, green, blue] = pixel(browserKeyboardGlyphs, x, y);
      if (green > 90 && green > red * 1.5 && green >= blue * 0.8) browserInheritedFocusGlyphs++;
    }
    assert.ok(browserInheritedFocusGlyphs > 0, `Browser paints descendant text using inherited focus color through parent opacity (green pixels=${browserInheritedFocusGlyphs})`);
    console.log(`PASS focus visual parity: Browser button click=${browserMousePixel}, Tab=${browserKeyboardPixel}; Native SDL button click=${nativeMousePixel}, Tab=${nativeKeyboardPixel}, no-id=${nativeStaticButtonPixel}, duplicate-id=${duplicateFirstPixel}/${duplicateSecondPixel}`);
  } finally {
    if (browser) await browser.close();
    if (server) await stopServer(server.child);
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
