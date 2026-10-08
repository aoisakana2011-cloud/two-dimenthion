'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { inflateSync } = require('node:zlib');
const { chromium } = require('../build/audit-tools/node_modules/playwright');
const { pack } = require('../tools/pack');
const { seedEmptyProject } = require('../tools/project-layout');

function decodePng(buffer) {
  let width = 0, height = 0, depth = 0, type = 0;
  const chunks = [];
  for (let offset = 8; offset < buffer.length;) {
    const length = buffer.readUInt32BE(offset), kind = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length); offset += length + 12;
    if (kind === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); depth = data[8]; type = data[9]; }
    if (kind === 'IDAT') chunks.push(data);
    if (kind === 'IEND') break;
  }
  assert.equal(depth, 8);
  assert.ok(type === 2 || type === 6);
  const channels = type === 6 ? 4 : 3, stride = width * channels;
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

function redBounds(image) {
  let left = Infinity, top = Infinity, right = -1, bottom = -1;
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    const at = (y * image.width + x) * image.channels;
    if (image.pixels[at] === 255 && image.pixels[at + 1] === 0 && image.pixels[at + 2] === 0) {
      left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
    }
  }
  return { left, top, right, bottom };
}

function pixelAt(image, x, y) {
  const at = (Math.floor(y) * image.width + Math.floor(x)) * image.channels;
  return [...image.pixels.subarray(at, at + 3)];
}

(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-screen-scale-'));
  let browser;
  try {
    const project = seedEmptyProject(path.join(tempRoot, 'project'));
    await fs.mkdir(path.join(project.settingsRoot, 'screens'), { recursive: true });
    const uiTheme = JSON.parse(await fs.readFile(path.resolve(__dirname, '../Title/setting/player-ui.json'), 'utf8'));
    uiTheme.screen.width = 960; uiTheme.screen.height = 680;
    await fs.writeFile(path.join(project.settingsRoot, 'player-ui.json'), JSON.stringify(uiTheme), 'utf8');
    await fs.appendFile(project.settingFile, 'native_ui_theme = player-ui.json\n', 'utf8');
    for (const assetName of ['dialogue-panel-romance.png', 'speaker-plate-romance.png']) {
      const target = path.join(project.assetsRoot, 'ui', assetName);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(path.resolve(__dirname, '../Title/asset/ui', assetName), target);
    }
    const probeBackground = path.join(project.assetsRoot, 'ui', 'backgrounds', 'spring-ensemble-key-visual.jpg');
    await fs.mkdir(path.dirname(probeBackground), { recursive: true });
    await fs.copyFile(path.resolve(__dirname, '../Title/asset/ui/backgrounds/spring-ensemble-key-visual.jpg'), probeBackground);
    await fs.writeFile(path.join(project.scenesRoot, 'main.tds'), 'scene main {\n  start()\n}\n', 'utf8');
    const canvas = { width: 1440, height: 810 }, viewport = { width: 960, height: 680 };
    await fs.writeFile(path.join(project.settingsRoot, 'game-screens.json'), JSON.stringify({
      version: 1, canvas, scaleMode: 'contain', initial: 'title', stylesheet: 'screens/scale.css',
      screens: { title: { title: 'Scale Probe', template: 'screens/scale.html' } },
    }), 'utf8');
    await fs.writeFile(path.join(project.settingsRoot, 'screens', 'scale.html'),
      '<main><button id="title-start" data-action="start">Start</button><div id="scale-probe"></div><div id="border-probe"><i id="border-probe-child"></i></div></main>\n', 'utf8');
    await fs.writeFile(path.join(project.settingsRoot, 'screens', 'scale.css'),
      'main{width:1440px;height:810px;background-color:#000000}#start{position:absolute;left:20px;top:20px;width:120px;height:40px}#scale-probe{position:absolute;left:300px;top:100px;width:100px;height:80px;background-color:#ff0000;z-index:100}#border-probe{position:absolute;left:500px;top:400px;width:60px;height:60px;padding:8px;border:4px solid #0000ff}#border-probe-child{position:absolute;left:0;top:0;width:10px;height:10px;background-color:#00ff00}\n', 'utf8');
    const packagePath = path.join(project.buildRoot, 'scale.nsp.json');
    await pack(path.join(project.scenesRoot, 'main.tds'), packagePath, { projectRoot: project.projectRoot });
    const packagedBackground = path.join(path.dirname(packagePath), 'asset', 'ui', 'backgrounds', 'spring-ensemble-key-visual.jpg');
    await fs.mkdir(path.dirname(packagedBackground), { recursive: true });
    await fs.copyFile(probeBackground, packagedBackground);
    const packagedScreensPath = path.join(path.dirname(packagePath), 'asset', 'ui', 'game-screens.json');
    const baseConfig = JSON.parse(await fs.readFile(packagedScreensPath, 'utf8'));

    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage({ viewport });
    await page.setContent('<!doctype html><meta charset="utf-8"><body style="margin:0;background:#000"></body>');
    await page.addScriptTag({ path: path.resolve(__dirname, '../Edit/screen-document.js') });
    const exe = process.env.NOVEL_NATIVE_EXE || path.resolve(__dirname, '../native/build/Release/novel_player.exe');
    for (const mode of ['cover', 'stretch']) {
      const config = { ...baseConfig, canvas, scaleMode: mode };
      await fs.writeFile(packagedScreensPath, JSON.stringify(config), 'utf8');
      const browserPng = await page.evaluate(async ({ tree, canvas, mode, viewport }) => {
        const transform = NovelScreenDocument.canvasTransform(viewport.width, viewport.height, canvas, mode);
        const host = document.createElement('div');
        Object.assign(host.style, { position: 'absolute', left: '0', top: '0', width: `${viewport.width}px`, height: `${viewport.height}px`, overflow: 'hidden', background: '#000' });
        host.append(NovelScreenDocument.buildScreenDom(tree, document, transform));
        document.body.replaceChildren(host);
        return await new Promise(resolve => requestAnimationFrame(() => resolve(true)));
      }, { tree: config.screens.title.uiTree, canvas, mode, viewport }).then(async () => page.screenshot());
      const browserBounds = redBounds(decodePng(browserPng));
      const browserImage = decodePng(browserPng);
      const browserProbeRect = await page.locator('#scale-probe').evaluate(node => ({ inline: { left: node.style.left, top: node.style.top, width: node.style.width, height: node.style.height }, rect: node.getBoundingClientRect().toJSON() }));

      const captureDir = path.join(tempRoot, `native-${mode}`);
      const native = spawnSync(exe, [packagePath, '--screen-render-smoke'], {
        encoding: 'utf8', timeout: 20_000,
        env: { ...process.env, NOVEL_SCREEN_CAPTURE_DIR: captureDir, NOVEL_SAVE_ROOT: path.join(tempRoot, `saves-${mode}`), SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy' },
      });
      assert.equal(native.status, 0, native.stderr || native.error?.message || native.stdout);
      const nativeCapture = decodePng(await fs.readFile(path.join(captureDir, 'title.png')));
      assert.deepEqual({ width: nativeCapture.width, height: nativeCapture.height }, viewport, `Native ${mode} capture uses the SDL window dimensions`);
      const nativeBounds = redBounds(nativeCapture);
      const scale = mode === 'cover' ? Math.max(viewport.width / canvas.width, viewport.height / canvas.height) : undefined;
      const scaleX = mode === 'stretch' ? viewport.width / canvas.width : scale;
      const scaleY = mode === 'stretch' ? viewport.height / canvas.height : scale;
      const offsetX = (viewport.width - canvas.width * scaleX) / 2, offsetY = (viewport.height - canvas.height * scaleY) / 2;
      const expected = {
        left: Math.floor(offsetX + 300 * scaleX), top: Math.floor(offsetY + 100 * scaleY),
        right: Math.ceil(offsetX + 400 * scaleX) - 1, bottom: Math.ceil(offsetY + 180 * scaleY) - 1,
      };
      for (const [edge, value] of Object.entries(expected)) {
        assert.ok(Math.abs(nativeBounds[edge] - value) <= 2, `Native ${mode} ${edge}=${nativeBounds[edge]} matches transformed geometry ${value}: ${JSON.stringify(nativeBounds)}`);
        assert.ok(Math.abs(browserBounds[edge] - value) <= 2, `Browser ${mode} ${edge}=${browserBounds[edge]} matches transformed geometry ${value}: ${JSON.stringify({ browserBounds, browserProbeRect, canvas: config.canvas })}`);
        assert.ok(Math.abs(nativeBounds[edge] - browserBounds[edge]) <= 1, `Browser and Native ${mode} ${edge} pixel geometry agrees: ${JSON.stringify({ nativeBounds, browserBounds })}`);
      }
      const childX = Math.floor(offsetX + 513 * scaleX), childY = Math.floor(offsetY + 413 * scaleY);
      assert.deepEqual(pixelAt(browserImage, childX, childY), [0, 255, 0], `Browser places an absolute child after both parent border and padding (${mode})`);
      assert.deepEqual(pixelAt(nativeCapture, childX, childY), [0, 255, 0], `Native SDL places the same child after both parent border and padding (${mode})`);
    }
    console.log('PASS Native cover/stretch SDL readback matches Browser DOM pixels at a 960x680 viewport for a 1440x810 logical canvas');
  } finally {
    if (browser) await browser.close();
    await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
