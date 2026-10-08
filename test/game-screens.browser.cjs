'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const { spawn, spawnSync } = require('node:child_process');
const { deflateSync, inflateSync } = require('node:zlib');
const { chromium } = require('../build/audit-tools/node_modules/playwright');
const { seedEmptyProject } = require('../tools/project-layout');
const { defaultGameScreens } = require('../Edit/game-screens');

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const name = Buffer.from(type), length = Buffer.alloc(4), checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length); checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}
function solidPng(r, g, b, a = 255) {
  const header = Buffer.alloc(13); header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(Buffer.from([0,r,g,b,a]))), pngChunk('IEND', Buffer.alloc(0))]);
}
function cropProbePng() {
  const header = Buffer.alloc(13); header.writeUInt32BE(3, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  const pixels = Buffer.from([0, 255,0,0,255, 0,255,0,255, 0,0,255,255]);
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(pixels)), pngChunk('IEND', Buffer.alloc(0))]);
}
function decodePng(buffer) {
  let width = 0, height = 0, channels = 4; const chunks = [];
  for (let offset = 8; offset < buffer.length;) {
    const length = buffer.readUInt32BE(offset), type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length); offset += length + 12;
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); channels = data[9] === 6 ? 4 : 3; }
    if (type === 'IDAT') chunks.push(data);
    if (type === 'IEND') break;
  }
  const stride = width * channels, raw = inflateSync(Buffer.concat(chunks)), pixels = Buffer.alloc(height * stride);
  for (let y = 0, input = 0; y < height; y++) {
    const filter = raw[input++], row = y * stride;
    for (let x = 0; x < stride; x++) {
      const value = raw[input++], left = x >= channels ? pixels[row + x - channels] : 0;
      const up = y ? pixels[row - stride + x] : 0, upperLeft = y && x >= channels ? pixels[row - stride + x - channels] : 0;
      const predictor = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? Math.floor((left + up) / 2) : 0;
      pixels[row + x] = (value + predictor) & 255;
      if (filter === 4) pixels[row + x] = (value + (() => { const p=left+up-upperLeft, a=Math.abs(p-left), b=Math.abs(p-up), c=Math.abs(p-upperLeft); return a<=b&&a<=c?left:b<=c?up:upperLeft; })()) & 255;
    }
  }
  return { width, height, channels, pixels };
}

const root = path.resolve(__dirname, '..');

(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-game-screens-'));
  const project = seedEmptyProject(path.join(tempRoot, 'project'));
  await fs.writeFile(path.join(project.scenesRoot, 'main.tds'), 'start()\nasset bg test_background = "asset/ui/backgrounds/spring-ensemble-key-visual.jpg"\nscene main {\n  bg test_background\n  say narrator "新しい作品を始めます。"\n  say narrator "skip-stop-line"\n  say narrator "auto-start-line"\n  say narrator "auto-intermediate-line"\n  say narrator "auto-finish-line"\n}\n', 'utf8');
  await fs.writeFile(path.join(project.scenesRoot, 'title.tds'), 'scene title_front {\n  start()\n  say narrator "TDS title reached"\n}\n', 'utf8');
  const prototypeScreens = JSON.parse(await fs.readFile(path.join(root, 'Title', 'setting', 'game-screens.json'), 'utf8'));
  await fs.writeFile(path.join(project.settingsRoot, 'game-screens.json'), JSON.stringify(prototypeScreens, null, 2));
  for (const skin of Object.values(prototypeScreens.controlSkins || {})) {
    for (const key of ['track', 'fill', 'thumb', 'thumbHover', 'off', 'on', 'offHover', 'onHover']) {
      if (!skin[key]) continue;
      const relative = skin[key].replace(/^asset[\\/]/, '');
      const target = path.join(project.assetsRoot, ...relative.split('/'));
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(path.join(root, 'Title', 'asset', ...relative.split('/')), target);
    }
  }
  await fs.mkdir(path.join(project.assetsRoot, 'bg'), { recursive: true });
  await fs.copyFile(path.join(root, 'Title', 'asset', 'bg', 'title.png'), path.join(project.assetsRoot, 'bg', 'title.png'));
  await fs.copyFile(path.join(root, 'Title', 'asset', 'bg', 'near_home.jpg'), path.join(project.assetsRoot, 'bg', 'near_home.jpg'));
  await fs.copyFile(path.join(root, 'Title', 'asset', 'bg', 'school.jpg'), path.join(project.assetsRoot, 'bg', 'school.jpg'));
  await fs.mkdir(path.join(project.assetsRoot, 'ui'), { recursive: true });
  await fs.copyFile(path.join(root, 'Title', 'asset', 'ui', 'choice-romance.png'), path.join(project.assetsRoot, 'ui', 'choice-romance.png'));
  for (const name of ['backgrounds/spring-ensemble-key-visual.jpg', 'portraits/ayaka-volume.png', 'portraits/sister-volume.png', 'buttons/sakura-menu-plate.png', 'buttons/sakura-menu-plate-hover-v2.png', 'logos/spring-late-love-title-v2.png']) {
    const target = path.join(project.assetsRoot, 'ui', ...name.split('/'));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(path.join(root, 'Title', 'asset', 'ui', ...name.split('/')), target);
  }
  await fs.mkdir(path.join(project.assetsRoot, 'ui', 'icons'), { recursive: true });
  for (const name of ['save', 'load', 'system', 'sound', 'favorite', 'tips', 'menu-back', 'menu-next', 'menu-auto', 'menu-skip', 'menu-log', 'menu-close', 'menu-hold']) {
    await fs.copyFile(path.join(root, 'Title', 'asset', 'ui', 'icons', `${name}.png`), path.join(project.assetsRoot, 'ui', 'icons', `${name}.png`));
  }
  await fs.mkdir(path.join(project.assetsRoot, 'char'), { recursive: true });
  for (const name of ['ayaka_normal.png', 'ayaka_dere.png', 'sisiter_normal.png', 'sister_dere.png']) {
    await fs.copyFile(path.join(root, 'Title', 'asset', 'char', name), path.join(project.assetsRoot, 'char', name));
  }
  for (const name of new Set([prototypeScreens.stylesheet, prototypeScreens.controlSettings, ...Object.values(prototypeScreens.screens).map(screen => screen.template)].filter(Boolean))) {
    const target = path.join(project.settingsRoot, ...name.split('/'));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(path.join(root, 'Title', 'setting', ...name.split('/')), target);
  }
  const child = spawn(process.execPath, [path.join(root, 'Edit/server.js'), '--project', project.projectRoot], {
    cwd: root, env: { ...process.env, PORT: '0' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += String(chunk); });
  child.stderr.on('data', chunk => { output += String(chunk); });
  let browser;
  try {
    const base = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error(`server start timeout: ${output}`)), 15000);
      const find = () => { const match = output.match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timer); resolve(match[0]); } };
      child.stdout.on('data', find); child.stderr.on('data', find); child.once('exit', code => { clearTimeout(timer); reject(Error(`server exited ${code}: ${output}`)); }); find();
    });
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage(); page.setDefaultTimeout(10000);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Accessibility.enable');
    const accessibilityNodes = async () => (await cdp.send('Accessibility.getFullAXTree')).nodes;
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const captureScreen = async name => {
      if (!process.env.NOVEL_SCREEN_CAPTURE_DIR) return;
      await fs.mkdir(process.env.NOVEL_SCREEN_CAPTURE_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.NOVEL_SCREEN_CAPTURE_DIR, `${name}.png`) });
    };
    await page.goto(base);
    const decorativeImageAlt = await page.evaluate(() => {
      const compiled = NovelScreenDocument.compileScreenDocument('<main><img src="asset/ui/decoration.png" alt=""></main>', '', { width: 1280, height: 720 });
      const mounted = NovelScreenDocument.buildScreenDom(compiled.tree, document, { assetUrl: value => value });
      const image = mounted.querySelector('img');
      return { present: image.hasAttribute('alt'), value: image.getAttribute('alt') };
    });
    assert.deepEqual(decorativeImageAlt, { present: true, value: '' }, 'Browser mount preserves an empty alt as the decorative-image semantic');
    const labelBinding = await page.evaluate(() => {
      const controls = { 'audio.master': 0.5 };
      const skins = { volume: { type: 'range', track: 'ui/track.png', fill: 'ui/fill.png', thumb: 'ui/thumb.png' } };
      const compiled = NovelScreenDocument.compileScreenDocument('<main><label for="master-volume">Master volume</label><input id="master-volume" type="range" min="0" max="1" step="0.01" data-setting="audio.master" data-skin="volume"></main>', '', { width: 1280, height: 720 }, [], controls, skins);
      const mounted = NovelScreenDocument.buildScreenDom(compiled.tree, document, { settings: controls, controlDefaults: controls, controlSkins: skins });
      const host = document.createElement('div'); host.append(mounted); document.body.append(host);
      const label = host.querySelector('label'), input = host.querySelector('input');
      label.click();
      const result = { labelFor: label.htmlFor, associated: label.control === input, inputId: input.id, clickFocusesInput: document.activeElement === input };
      host.remove();
      return result;
    });
    assert.deepEqual(labelBinding, { labelFor: 'master-volume', associated: true, inputId: 'master-volume', clickFocusesInput: true }, 'Browser labels bind and focus the real input behind a skinned control');
    const htmlDefaults = await page.evaluate(() => {
      const compiled = NovelScreenDocument.compileScreenDocument('<main><h3>Heading</h3><p>Text</p><ul><li>Item</li></ul></main>', 'h3{position:absolute;left:0;top:0;width:200px;height:40px}p{position:absolute;left:0;top:50px;width:200px;height:40px}ul{position:absolute;left:0;top:100px;width:200px;height:40px}', { width: 300, height: 200 });
      const host = document.createElement('div');
      host.append(NovelScreenDocument.buildScreenDom(compiled.tree, document));
      document.body.append(host);
      const heading = host.querySelector('h3'), paragraph = host.querySelector('p'), list = host.querySelector('ul');
      const result = { headingMargin: getComputedStyle(heading).marginTop, paragraphMargin: getComputedStyle(paragraph).marginTop, listMargin: getComputedStyle(list).marginTop, listPadding: getComputedStyle(list).paddingLeft, listStyle: getComputedStyle(list).listStyleType };
      host.remove();
      return result;
    });
    assert.deepEqual(htmlDefaults, { headingMargin: '0px', paragraphMargin: '0px', listMargin: '0px', listPadding: '0px', listStyle: 'none' }, 'Browser user-agent defaults do not alter the shared HTML geometry or add unrendered list markers');
    const absoluteRightGeometry = await page.evaluate(() => {
      const markup = '<main><div id="right-parent"><div id="right-child"></div><div id="bottom-child"></div></div></main>';
      const css = 'main{position:relative;width:100px;height:60px}#right-parent{position:absolute;left:10px;top:10px;width:70px;height:30px}#right-child{position:absolute;right:7px;top:4px;width:13px;height:12px;background-color:#00ff00}#bottom-child{position:absolute;left:5px;bottom:6px;width:13px;height:8px;background-color:#0000ff}';
      const compiled = NovelScreenDocument.compileScreenDocument(markup, css, { width: 100, height: 60 });
      const shared = document.createElement('div'); shared.id = 'absolute-right-shared'; shared.style.cssText = 'position:fixed;left:0;top:0;width:100px;height:60px;padding:0;margin:0';
      shared.append(NovelScreenDocument.buildScreenDom(compiled.tree, document)); document.body.append(shared);
      const edge = document.createElement('div'); edge.id = 'absolute-right-edge'; edge.style.cssText = shared.style.cssText;
      const style = document.createElement('style'); style.textContent = css; edge.innerHTML = markup; edge.prepend(style); document.body.append(edge);
      const rect = (host, selector) => { const node = host.querySelector(selector), box = node.getBoundingClientRect(), origin = host.getBoundingClientRect(); return { x: box.x - origin.x, y: box.y - origin.y, width: box.width, height: box.height }; };
      return { shared: { right: rect(shared, '#right-child'), bottom: rect(shared, '#bottom-child') }, edge: { right: rect(edge, '#right-child'), bottom: rect(edge, '#bottom-child') } };
    });
    assert.deepEqual(absoluteRightGeometry.edge.right, { x: 60, y: 14, width: 13, height: 12 }, 'Edge right offset places an absolute child inside its parent content box');
    assert.deepEqual(absoluteRightGeometry.edge.bottom, { x: 15, y: 26, width: 13, height: 8 }, 'Edge bottom offset places an absolute child inside its parent content box');
    assert.deepEqual(absoluteRightGeometry.shared, absoluteRightGeometry.edge, 'shared Browser geometry matches Edge for absolute right positioning');
    for (const hostId of ['#absolute-right-shared', '#absolute-right-edge']) {
      const image = decodePng(await page.locator(hostId).screenshot());
      assert.deepEqual([...image.pixels.subarray((15 * image.width + 61) * image.channels, (15 * image.width + 61) * image.channels + 3)], [0,255,0], `${hostId} paints the right-positioned child at the measured Edge coordinate`);
      assert.deepEqual([...image.pixels.subarray((27 * image.width + 16) * image.channels, (27 * image.width + 16) * image.channels + 3)], [0,0,255], `${hostId} paints the bottom-positioned child at the measured Edge coordinate`);
    }
    await page.locator('#absolute-right-shared,#absolute-right-edge').evaluateAll(nodes => nodes.forEach(node => node.remove()));
    await page.evaluate(async imageBase64 => {
      const imageUrl = `data:image/png;base64,${imageBase64}`, image = new Image(); image.src = imageUrl; await image.decode();
      const markup = '<main><img id="object-fit-contain" src="asset/ui/crop.png" alt=""><img id="object-fit-cover" src="asset/ui/crop.png" alt=""><img id="object-fit-fill" src="asset/ui/crop.png" alt=""></main>';
      const css = 'main{position:relative;width:210px;height:60px}#object-fit-contain,#object-fit-cover,#object-fit-fill{position:absolute;top:0;width:60px;height:60px;background-color:#000000}#object-fit-contain{left:0;object-fit:contain}#object-fit-cover{left:70px;object-fit:cover}#object-fit-fill{left:140px;object-fit:fill}';
      const compiled = NovelScreenDocument.compileScreenDocument(markup, css, { width: 210, height: 60 });
      const shared = document.createElement('div'); shared.id = 'object-fit-shared'; shared.style.cssText = 'position:fixed;left:0;top:0;width:210px;height:60px;padding:0;margin:0';
      shared.append(NovelScreenDocument.buildScreenDom(compiled.tree, document, { assetUrl: () => imageUrl })); document.body.append(shared);
      const edge = document.createElement('div'); edge.id = 'object-fit-edge'; edge.style.cssText = shared.style.cssText;
      const style = document.createElement('style'); style.textContent = css; edge.innerHTML = markup; edge.querySelectorAll('img').forEach(node => { node.src = imageUrl; }); edge.prepend(style); document.body.append(edge);
      await Promise.all([...shared.querySelectorAll('img'), ...edge.querySelectorAll('img')].map(node => node.decode()));
    }, cropProbePng().toString('base64'));
    const objectFitPixels = {};
    for (const hostId of ['#object-fit-shared', '#object-fit-edge']) {
      const image = decodePng(await page.locator(hostId).screenshot());
      const pixelAt = (x, y) => [...image.pixels.subarray((y * image.width + x) * image.channels, (y * image.width + x) * image.channels + 3)];
      objectFitPixels[hostId] = {
        contain: { top: pixelAt(30, 5), red: pixelAt(5, 30), green: pixelAt(30, 30), blue: pixelAt(55, 30), bottom: pixelAt(30, 55) },
        cover: { top: pixelAt(100, 5), left: pixelAt(72, 30), center: pixelAt(100, 30), right: pixelAt(128, 30), bottom: pixelAt(100, 55) },
        fill: { topRed: pixelAt(145, 5), topGreen: pixelAt(170, 5), topBlue: pixelAt(195, 5), bottomRed: pixelAt(145, 55), bottomGreen: pixelAt(170, 55), bottomBlue: pixelAt(195, 55) },
      };
    }
    const expectedObjectFitPixels = {
      contain: { top: [0,0,0], red: [255,0,0], green: [0,255,0], blue: [0,0,255], bottom: [0,0,0] },
      cover: { top: [0,255,0], left: [0,255,0], center: [0,255,0], right: [0,255,0], bottom: [0,255,0] },
      fill: { topRed: [255,0,0], topGreen: [0,255,0], topBlue: [0,0,255], bottomRed: [255,0,0], bottomGreen: [0,255,0], bottomBlue: [0,0,255] },
    };
    for (const [hostId, modes] of Object.entries(objectFitPixels)) for (const [mode, samples] of Object.entries(modes)) for (const [sample, expected] of Object.entries(expectedObjectFitPixels[mode])) {
      assert.ok(samples[sample].every((channel, index) => Math.abs(channel - expected[index]) <= 10), `${hostId} object-fit:${mode} ${sample} sample matches expected RGB crop/fit: ${JSON.stringify(samples[sample])}`);
    }
    await page.locator('#object-fit-shared,#object-fit-edge').evaluateAll(nodes => nodes.forEach(node => node.remove()));
    const accentColorHosts = await page.evaluate(async () => {
      const markup = '<main><input id="accent-color-probe" type="range" min="0" max="1" step="0.01" data-setting="audio.master" aria-label="Accent probe"></main>';
      const css = 'main{position:relative;width:240px;height:48px}#accent-color-probe{position:absolute;left:20px;top:8px;width:200px;height:24px;accent-color:#ff00ff}';
      const defaults = { 'audio.master': 1 };
      const compiled = NovelScreenDocument.compileScreenDocument(markup, css, { width: 240, height: 48 }, [], defaults);
      const shared = document.createElement('div'); shared.id = 'accent-color-shared'; shared.style.cssText = 'position:fixed;left:0;top:0;width:240px;height:48px;padding:0;margin:0';
      shared.append(NovelScreenDocument.buildScreenDom(compiled.tree, document, { controlDefaults: defaults })); document.body.append(shared);
      const edge = document.createElement('div'); edge.id = 'accent-color-edge'; edge.style.cssText = shared.style.cssText;
      const style = document.createElement('style'); style.textContent = css; edge.innerHTML = markup; edge.querySelector('input').value = '1'; edge.prepend(style); document.body.append(edge);
      return { shared: getComputedStyle(shared.querySelector('input')).accentColor, edge: getComputedStyle(edge.querySelector('input')).accentColor };
    });
    assert.deepEqual(accentColorHosts, { shared: 'rgb(255, 0, 255)', edge: 'rgb(255, 0, 255)' }, 'shared and raw Edge range controls compute the authored accent-color');
    for (const hostId of ['#accent-color-shared', '#accent-color-edge']) {
      const image = decodePng(await page.locator(hostId).screenshot());
      const pixel = [...image.pixels.subarray((20 * image.width + 60) * image.channels, (20 * image.width + 60) * image.channels + 3)];
      assert.ok(pixel[0] >= 240 && pixel[1] <= 15 && pixel[2] >= 240, `${hostId} range fill pixel uses the authored magenta accent: ${JSON.stringify(pixel)}`);
    }
    await page.locator('#accent-color-shared,#accent-color-edge').evaluateAll(nodes => nodes.forEach(node => node.remove()));
    const paintPngBase64 = solidPng(20, 230, 80).toString('base64');
    const paintStates = await page.evaluate(async ({ pngBase64, cropPngBase64 }) => {
      const markup = '<main><div id="fit-contain"></div><div id="fit-cover"></div><div id="fit-stretch"></div><div id="opacity-parent"><div id="hover-probe"></div></div><div id="fit-crop"></div></main>';
      const css = 'main{width:320px;height:140px}#fit-contain,#fit-cover,#fit-stretch{position:absolute;top:0;width:100px;height:40px;background-color:#000000;background-image:url(asset/ui/probe.png)}#fit-contain{left:0;background-size:contain}#fit-cover{left:110px;background-size:cover}#fit-stretch{left:220px;background-size:100% 100%}#opacity-parent{position:absolute;left:0;top:50px;width:100px;height:40px;background-color:#000000}#hover-probe{position:absolute;left:0;top:0;width:100px;height:40px;background-color:#ff0000;opacity:0.5}#hover-probe:hover{opacity:1}#fit-crop{position:absolute;left:0;top:100px;width:40px;height:40px;background-color:#000000;background-image:url(asset/ui/crop.png);background-size:cover}';
      const url = `data:image/png;base64,${pngBase64}`, cropUrl = `data:image/png;base64,${cropPngBase64}`, image = new Image(); image.src = url; await image.decode();
      const cropImage = new Image(); cropImage.src = cropUrl; await cropImage.decode();
      const compiled = NovelScreenDocument.compileScreenDocument(markup, css, { width: 320, height: 140 });
      const host = document.createElement('div'); host.id = 'paint-host'; Object.assign(host.style, { position: 'relative', width: '320px', height: '140px', padding: '0', margin: '0' });
      host.append(NovelScreenDocument.buildScreenDom(compiled.tree, document, { assetUrl: source => source.endsWith('crop.png') ? cropUrl : url })); document.body.append(host);
      const sizes = ['fit-contain','fit-cover','fit-stretch'].map(id => getComputedStyle(host.querySelector(`#${id}`)).backgroundSize);
      const baseOpacity = getComputedStyle(host.querySelector('#hover-probe')).opacity;
      return { sizes, baseOpacity };
    }, { pngBase64: paintPngBase64, cropPngBase64: cropProbePng().toString('base64') });
    assert.deepEqual(paintStates, { sizes: ['contain', 'cover', '100% 100%'], baseOpacity: '0.5' }, 'Browser applies the shared background fit values and base opacity');
    const paintBase = decodePng(await page.locator('#paint-host').screenshot());
    const paintPixel = (image, x, y) => { const at = (y * image.width + x) * image.channels; return [...image.pixels.subarray(at, at + 3)]; };
    assert.deepEqual(paintPixel(paintBase, 5, 20), [0,0,0], 'Browser contain keeps the letterbox region at the background color');
    assert.deepEqual(paintPixel(paintBase, 50, 20), [20,230,80], 'Browser contain centers the image in the content box');
    assert.deepEqual(paintPixel(paintBase, 115, 20), [20,230,80], 'Browser cover fills the target box');
    assert.deepEqual(paintPixel(paintBase, 225, 20), [20,230,80], 'Browser 100% 100% stretches across the target box');
    assert.deepEqual(paintPixel(paintBase, 5, 120), [0,255,0], 'Browser background-size:cover crops the left red source edge');
    assert.deepEqual(paintPixel(paintBase, 35, 120), [0,255,0], 'Browser background-size:cover crops the right blue source edge');
    const baseOpacityPixel = paintPixel(paintBase, 50, 70);
    assert.ok(baseOpacityPixel[0] >= 126 && baseOpacityPixel[0] <= 129 && baseOpacityPixel[1] === 0 && baseOpacityPixel[2] === 0, `Browser opacity composites the red child over the black parent: ${JSON.stringify(baseOpacityPixel)}`);
    await page.locator('#hover-probe').hover();
    assert.equal(await page.locator('#hover-probe').evaluate(node => getComputedStyle(node).opacity), '1', 'Browser :hover applies the authored opacity override');
    const paintHover = decodePng(await page.locator('#paint-host').screenshot());
    assert.deepEqual(paintPixel(paintHover, 50, 70), [255,0,0], 'Browser :hover changes the actual composited pixel');
    await page.locator('#paint-host').evaluate(node => node.remove());
    const flexGrowHost = await page.evaluate(() => {
      const compiled = NovelScreenDocument.compileScreenDocument(
        '<main><div id="grow-box"><div id="grow-red"></div><div id="grow-green"></div></div></main>',
        'main{width:300px;height:40px}#grow-box{position:absolute;left:0;top:0;width:300px;height:40px;display:flex}#grow-red{width:50px;height:40px;background-color:#ff0000;flex-grow:1}#grow-green{width:100px;height:40px;background-color:#00ff00;flex-grow:1}',
        { width: 300, height: 40 },
      );
      const host = document.createElement('div'); host.id = 'flex-grow-host'; host.style.cssText = 'position:relative;width:300px;height:40px;padding:0;margin:0';
      host.append(NovelScreenDocument.buildScreenDom(compiled.tree, document)); document.body.append(host);
      return [...host.querySelectorAll('#grow-red,#grow-green')].map(node => {
        const rect = node.getBoundingClientRect(); return { x: rect.x, width: rect.width };
      });
    });
    assert.deepEqual(flexGrowHost, [{ x: 0, width: 125 }, { x: 125, width: 175 }], 'Browser mounts the shared flex-grow basis and remainder rectangles');
    const tabindexMount = await page.evaluate(() => {
      const compiled = NovelScreenDocument.compileScreenDocument(
        '<main><div id="tabindex-probe" tabindex="0" data-action="back">Back</div></main>',
        'main{width:200px;height:60px}#tabindex-probe{position:absolute;left:0;top:0;width:100px;height:40px}',
        { width: 200, height: 60 },
      );
      const host = document.createElement('div'); host.style.cssText = 'position:fixed;left:0;top:0;width:200px;height:60px';
      host.append(NovelScreenDocument.buildScreenDom(compiled.tree, document)); document.body.append(host);
      const control = host.querySelector('#tabindex-probe');
      const result = { attribute: control.getAttribute('tabindex'), tabIndex: control.tabIndex };
      control.focus(); result.receivesKeyboardFocus = document.activeElement === control;
      host.remove(); return result;
    });
    assert.deepEqual(tabindexMount, { attribute: '0', tabIndex: 0, receivesKeyboardFocus: true }, 'Browser screen mounting preserves authored tabindex on custom focusable action elements');
    const flexGrowPixels = decodePng(await page.locator('#flex-grow-host').screenshot());
    assert.deepEqual(paintPixel(flexGrowPixels, 120, 20), [255,0,0], 'Browser pixel remains in the red child through its computed 125px width');
    assert.deepEqual(paintPixel(flexGrowPixels, 130, 20), [0,255,0], 'Browser pixel enters the green child at the shared 125px boundary');
    await page.locator('#flex-grow-host').evaluate(node => node.remove());
    const overflowFlex = await page.evaluate(() => {
      const markup = '<main><div id="overflow-center"><i id="overflow-red"></i><i id="overflow-green"></i></div></main>';
      const css = 'main{width:100px;height:20px}#overflow-center{position:absolute;left:0;top:0;width:100px;height:20px;display:flex;justify-content:center}#overflow-red,#overflow-green{width:80px;height:20px}#overflow-red{background-color:#ff0000}#overflow-green{background-color:#00ff00}';
      const compiled = NovelScreenDocument.compileScreenDocument(markup, css, { width: 100, height: 20 });
      const shared = document.createElement('div'); shared.id = 'overflow-flex-shared'; shared.style.cssText = 'position:fixed;left:0;top:0;width:100px;height:20px;padding:0;margin:0';
      shared.append(NovelScreenDocument.buildScreenDom(compiled.tree, document)); document.body.append(shared);
      const raw = document.createElement('div'); raw.id = 'overflow-flex-edge'; raw.style.cssText = shared.style.cssText;
      const style = document.createElement('style'); style.textContent = css + '#overflow-red,#overflow-green{flex-shrink:0}'; raw.innerHTML = markup; raw.prepend(style); document.body.append(raw);
      const rects = host => [...host.querySelectorAll('#overflow-red,#overflow-green')].map(node => { const r=node.getBoundingClientRect(), h=host.getBoundingClientRect(); return { x:r.x-h.x, width:r.width }; });
      return { shared: rects(shared), edge: rects(raw) };
    });
    assert.deepEqual(overflowFlex.edge, [{ x: -30, width: 80 }, { x: 50, width: 80 }], 'Edge center alignment distributes negative free space around overflowing flex items');
    assert.deepEqual(overflowFlex.shared, overflowFlex.edge, 'shared geometry matches Edge negative-free-space flex positioning');
    const overflowFallbacks = await page.evaluate(() => Object.fromEntries(['space-between', 'space-around', 'space-evenly'].map((alignment, index) => {
      const markup = '<main><div class="box"><i class="item"></i><i class="item"></i></div></main>';
      const css = `main{width:100px;height:20px}.box{position:absolute;left:0;top:0;width:100px;height:20px;display:flex;justify-content:${alignment}}.item{width:80px;height:20px}`;
      const compiled = NovelScreenDocument.compileScreenDocument(markup, css, { width: 100, height: 20 });
      const shared = document.createElement('div'); shared.style.cssText = `position:fixed;left:0;top:${30 + index * 25}px;width:100px;height:20px;padding:0;margin:0`;
      shared.append(NovelScreenDocument.buildScreenDom(compiled.tree, document)); document.body.append(shared);
      const raw = document.createElement('div'); raw.style.cssText = shared.style.cssText;
      const style = document.createElement('style'); style.textContent = css + '.item{flex-shrink:0}'; raw.innerHTML = markup; raw.prepend(style); document.body.append(raw);
      const xs = host => [...host.querySelectorAll('.item')].map(node => node.getBoundingClientRect().left - host.getBoundingClientRect().left);
      const result = { shared: xs(shared), edge: xs(raw) }; shared.remove(); raw.remove(); return [alignment, result];
    })));
    assert.deepEqual(overflowFallbacks, {
      'space-between': { shared: [0, 80], edge: [0, 80] },
      'space-around': { shared: [0, 80], edge: [0, 80] },
      'space-evenly': { shared: [0, 80], edge: [0, 80] },
    }, 'Edge confirms space-between, space-around, and space-evenly all fall back to start on overflow');
    const flexAlignmentCoverage = await page.evaluate(() => {
      const justifyValues = ['start', 'flex-start', 'end', 'flex-end', 'center', 'space-between', 'space-around', 'space-evenly'];
      const alignValues = ['stretch', 'start', 'flex-start', 'end', 'flex-end', 'center'];
      const markup = `<main>${justifyValues.map((_, i) => `<div class="j j${i}"><i class="r"></i><i class="g"></i></div>`).join('')}${alignValues.map((_, i) => `<div class="a a${i}"><i class="ac ac${i}"></i></div>`).join('')}</main>`;
      const css = `main{position:relative;width:460px;height:100px}.j{position:absolute;left:0;width:100px;height:10px;display:flex;gap:10px}.r,.g{width:10px;height:8px}.r{background:#ff0000}.g{background:#00ff00}${justifyValues.map((value, i) => `.j${i}{top:${i * 11}px;justify-content:${value}}`).join('')}.a{position:absolute;top:0;width:20px;height:60px;display:flex;flex-direction:row}.ac{width:10px;background:#ff0000}${alignValues.map((value, i) => `.a${i}{left:${120 + i * 32}px;align-items:${value}}${value === 'stretch' ? '' : `.ac${i}{height:10px}`}`).join('')}`;
      const compiled = NovelScreenDocument.compileScreenDocument(markup, css, { width: 460, height: 100 });
      const shared = document.createElement('div'); shared.id = 'flex-alignment-shared'; shared.style.cssText = 'position:fixed;left:0;top:0;width:460px;height:100px;padding:0;margin:0';
      shared.append(NovelScreenDocument.buildScreenDom(compiled.tree, document)); document.body.append(shared);
      const raw = document.createElement('div'); raw.id = 'flex-alignment-edge'; raw.style.cssText = shared.style.cssText;
      const style = document.createElement('style'); style.textContent = css; raw.innerHTML = markup; raw.prepend(style); document.body.append(raw);
      const rects = host => [...host.querySelectorAll('.j .r,.j .g,.a i')].map(node => { const r = node.getBoundingClientRect(), h = host.getBoundingClientRect(); return [r.x-h.x,r.y-h.y,r.width,r.height]; });
      return { justifyValues, alignValues, shared: rects(shared), edge: rects(raw) };
    });
    assert.deepEqual(flexAlignmentCoverage.shared, flexAlignmentCoverage.edge, 'all accepted justify-content and align-items values match raw Edge element rectangles');
    assert.deepEqual(flexAlignmentCoverage.justifyValues, ['start', 'flex-start', 'end', 'flex-end', 'center', 'space-between', 'space-around', 'space-evenly']);
    assert.deepEqual(flexAlignmentCoverage.alignValues, ['stretch', 'start', 'flex-start', 'end', 'flex-end', 'center']);
    const flexAlignmentPixels = decodePng(await page.locator('#flex-alignment-shared').screenshot());
    for (const [index, x] of [5, 5, 75, 75, 40, 5, 22, 28].entries()) assert.deepEqual(paintPixel(flexAlignmentPixels, x, index * 11 + 4), [255,0,0], `Browser pixel confirms justify-content:${flexAlignmentCoverage.justifyValues[index]} first-child placement`);
    for (const [index, y] of [30, 4, 4, 54, 54, 29].entries()) assert.deepEqual(paintPixel(flexAlignmentPixels, 120 + index * 32 + 4, y), [255,0,0], `Browser pixel confirms align-items:${flexAlignmentCoverage.alignValues[index]} child placement`);
    await page.locator('#flex-alignment-shared,#flex-alignment-edge').evaluateAll(nodes => nodes.forEach(node => node.remove()));
    const overflowSharedPixels = decodePng(await page.locator('#overflow-flex-shared').screenshot());
    const overflowEdgePixels = decodePng(await page.locator('#overflow-flex-edge').screenshot());
    assert.deepEqual(paintPixel(overflowSharedPixels, 10, 10), [255,0,0]);
    assert.deepEqual(paintPixel(overflowSharedPixels, 55, 10), [0,255,0]);
    assert.deepEqual(paintPixel(overflowEdgePixels, 10, 10), [255,0,0]);
    assert.deepEqual(paintPixel(overflowEdgePixels, 55, 10), [0,255,0]);
    await page.locator('#overflow-flex-shared,#overflow-flex-edge').evaluateAll(nodes => nodes.forEach(node => node.remove()));
    const flexCrossAxisPixels = await page.evaluate(() => {
      const markup = '<div id="flex-cross-root"><div id="cross-box"><div id="cross-red"></div><div id="cross-green"></div></div></div>';
      const css = '#flex-cross-root{position:relative;width:400px;height:200px}#cross-box{position:absolute;left:200px;top:50px;width:100px;height:100px;display:flex;flex-direction:column;align-items:flex-end;justify-content:space-between;gap:10px}#cross-red{width:120px;height:20px;flex-grow:1;background-color:#ff0000}#cross-green{width:20px;height:10px;background-color:#00ff00}';
      const compiled = NovelScreenDocument.compileScreenDocument(markup, css, { width: 400, height: 200 });
      const sharedHost = document.createElement('div'); sharedHost.id = 'flex-cross-shared-host'; sharedHost.style.cssText = 'position:fixed;left:0;top:0;width:400px;height:200px;padding:0;margin:0';
      sharedHost.append(NovelScreenDocument.buildScreenDom(compiled.tree, document)); document.body.append(sharedHost);
      const rawHost = document.createElement('div'); rawHost.id = 'flex-cross-raw-host'; rawHost.style.cssText = 'position:fixed;left:0;top:0;width:400px;height:200px;padding:0;margin:0';
      const style = document.createElement('style'); style.textContent = css;
      rawHost.innerHTML = markup; rawHost.prepend(style); document.body.append(rawHost);
      const rect = (node, host) => { const box = node.getBoundingClientRect(), origin = host.getBoundingClientRect(); return { x: box.x - origin.x, y: box.y - origin.y, width: box.width, height: box.height }; };
      return { shared: rect(sharedHost.querySelector('#cross-red'), sharedHost), raw: rect(rawHost.querySelector('#cross-red'), rawHost) };
    });
    assert.deepEqual(flexCrossAxisPixels.raw, { x: 180, y: 50, width: 120, height: 80 }, 'Edge lays out the 120px cross-axis width and distributes remaining column space after the 10px gap');
    assert.deepEqual(flexCrossAxisPixels.shared, flexCrossAxisPixels.raw, 'shared geometry preserves an oversized cross-axis item positioned by align-items:flex-end in a column flex container');
    const sharedCrossPixels = decodePng(await page.locator('#flex-cross-shared-host').screenshot());
    const rawCrossPixels = decodePng(await page.locator('#flex-cross-raw-host').screenshot());
    assert.deepEqual(paintPixel(sharedCrossPixels, 290, 60), [255,0,0], 'shared Browser pixels include the full 120px cross-axis item beyond its 100px parent');
    assert.deepEqual(paintPixel(rawCrossPixels, 290, 60), [255,0,0], 'Edge CSS reference paints the same oversized cross-axis item');
    await page.locator('#flex-cross-shared-host,#flex-cross-raw-host').evaluateAll(nodes => nodes.forEach(node => node.remove()));
    await page.evaluate(() => {
      const compiled = NovelScreenDocument.compileScreenDocument('<main><div id="wide-border"></div></main>', 'main{width:100px;height:80px}#wide-border{position:absolute;left:0;top:0;width:100px;height:80px;background-color:#ff0000;border:30px solid #0000ff}', { width: 100, height: 80 });
      const host = document.createElement('div'); host.id = 'wide-border-host'; host.style.cssText = 'position:relative;width:100px;height:80px;padding:0;margin:0';
      host.append(NovelScreenDocument.buildScreenDom(compiled.tree, document)); document.body.append(host);
    });
    const wideBorderPixels = decodePng(await page.locator('#wide-border-host').screenshot());
    assert.deepEqual(paintPixel(wideBorderPixels, 25, 25), [0,0,255], 'Browser paints the full authored border width beyond the Native 12px regression threshold');
    assert.deepEqual(paintPixel(wideBorderPixels, 50, 40), [255,0,0], 'Browser preserves the content fill after the authored border band');
    await page.locator('#wide-border-host').evaluate(node => node.remove());
    await page.evaluate(() => {
      const markup = '<main><div id="z-parent"><div id="z-nested"></div></div><div id="z-sibling"></div></main>';
      const css = 'main{width:80px;height:50px}#z-parent{position:absolute;left:0;top:0;width:80px;height:50px}#z-nested{position:absolute;left:0;top:0;width:80px;height:50px;background-color:#ff0000;z-index:99}#z-sibling{position:absolute;left:0;top:0;width:80px;height:50px;background-color:#0000ff;z-index:1}';
      const compiled = NovelScreenDocument.compileScreenDocument(markup, css, { width: 80, height: 50 });
      const host = document.createElement('div'); host.id = 'z-order-host'; host.style.cssText = 'position:relative;width:80px;height:50px;padding:0;margin:0';
      host.append(NovelScreenDocument.buildScreenDom(compiled.tree, document)); document.body.append(host);
    });
    const zOrderPixels = decodePng(await page.locator('#z-order-host').screenshot());
    assert.deepEqual(paintPixel(zOrderPixels, 40, 25), [0,0,255], 'Browser follows shared hierarchical paint order when nested z-index would otherwise escape its parent');
    await page.locator('#z-order-host').evaluate(node => node.remove());
    await page.evaluate(() => {
      const markup = '<main><div id="opacity-backdrop"></div><div id="opacity-group"><div id="opacity-green"></div><div id="opacity-red"></div></div></main>';
      const css = 'main{width:100px;height:60px}#opacity-backdrop,#opacity-group,#opacity-green,#opacity-red{position:absolute;left:0;top:0;width:100px;height:60px}#opacity-backdrop{background-color:#000000}#opacity-group{opacity:0.5}#opacity-green{background-color:#00ff00}#opacity-red{width:50px;background-color:#ff0000}';
      const compiled = NovelScreenDocument.compileScreenDocument(markup, css, { width: 100, height: 60 });
      const host = document.createElement('div'); host.id = 'opacity-group-host'; host.style.cssText = 'position:relative;width:100px;height:60px;padding:0;margin:0';
      host.append(NovelScreenDocument.buildScreenDom(compiled.tree, document)); document.body.append(host);
    });
    const opacityGroupPixels = decodePng(await page.locator('#opacity-group-host').screenshot());
    assert.deepEqual(paintPixel(opacityGroupPixels, 25, 30), [128,0,0], 'Browser composites nested children together before applying the ancestor opacity');
    await page.locator('#opacity-group-host').evaluate(node => node.remove());
    const gridGapGeometry = await page.evaluate(() => {
      const markup = '<main><div class="grid"><i id="gap-red"></i><i id="gap-green"></i><i id="gap-blue"></i></div></main>';
      const css = 'main{width:100px;height:60px}.grid{position:absolute;left:0;top:0;width:100px;height:60px;display:grid;grid-template-columns:20px 20px;grid-auto-rows:20px;gap:10px 20px;column-gap:30px;row-gap:5px}#gap-red{background-color:#ff0000}#gap-green{background-color:#00ff00}#gap-blue{background-color:#0000ff}';
      const compiled = NovelScreenDocument.compileScreenDocument(markup, css, { width: 100, height: 60 });
      const shared = document.createElement('div'); shared.id = 'grid-gap-shared'; shared.style.cssText = 'position:fixed;left:0;top:0;width:100px;height:60px;padding:0;margin:0';
      shared.append(NovelScreenDocument.buildScreenDom(compiled.tree, document)); document.body.append(shared);
      const raw = document.createElement('div'); raw.id = 'grid-gap-edge'; raw.style.cssText = shared.style.cssText;
      const style = document.createElement('style'); style.textContent = css; raw.innerHTML = markup; raw.prepend(style); document.body.append(raw);
      const rects = host => [...host.querySelectorAll('#gap-red,#gap-green,#gap-blue')].map(node => { const r=node.getBoundingClientRect(), h=host.getBoundingClientRect(); return [r.x-h.x,r.y-h.y]; });
      return { shared: rects(shared), edge: rects(raw) };
    });
    assert.deepEqual(gridGapGeometry.edge, [[0,0],[50,0],[0,25]], 'Edge applies the column-gap and row-gap longhands over the earlier gap shorthand');
    assert.deepEqual(gridGapGeometry.shared, gridGapGeometry.edge, 'shared grid geometry matches Edge gap shorthand cascade');
    const gridGapSharedPixels = decodePng(await page.locator('#grid-gap-shared').screenshot());
    const gridGapEdgePixels = decodePng(await page.locator('#grid-gap-edge').screenshot());
    for (const image of [gridGapSharedPixels, gridGapEdgePixels]) {
      assert.deepEqual(paintPixel(image, 5, 5), [255,0,0]);
      assert.deepEqual(paintPixel(image, 55, 5), [0,255,0]);
      assert.deepEqual(paintPixel(image, 5, 30), [0,0,255]);
    }
    await page.locator('#grid-gap-shared,#grid-gap-edge').evaluateAll(nodes => nodes.forEach(node => node.remove()));
    const gridIntrinsic = await page.evaluate(() => {
      const markup = '<main><div id="intrinsic-grid"><i class="cell"></i><i class="cell"></i><i class="cell"></i><i class="cell"></i></div></main>';
      const css = 'main{width:100px;height:60px}#intrinsic-grid{position:absolute;left:0;top:0;width:100px;display:grid;grid-template-columns:20px 20px;grid-auto-rows:20px;row-gap:5px;background-color:#ffff00}.cell{width:20px;height:20px}';
      const compiled = NovelScreenDocument.compileScreenDocument(markup, css, { width: 100, height: 60 });
      const shared = document.createElement('div'); shared.id = 'grid-intrinsic-shared'; shared.style.cssText = 'position:fixed;left:0;top:0;width:100px;height:60px;padding:0;margin:0';
      shared.append(NovelScreenDocument.buildScreenDom(compiled.tree, document)); document.body.append(shared);
      const raw = document.createElement('div'); raw.id = 'grid-intrinsic-edge'; raw.style.cssText = shared.style.cssText;
      const style = document.createElement('style'); style.textContent = css; raw.innerHTML = markup; raw.prepend(style); document.body.append(raw);
      const gridHeight = host => host.querySelector('#intrinsic-grid').getBoundingClientRect().height;
      return { sharedHeight: gridHeight(shared), edgeHeight: gridHeight(raw) };
    });
    assert.deepEqual(gridIntrinsic, { sharedHeight: 45, edgeHeight: 45 }, 'auto-height grid includes all implicit rows and row gaps like Edge');
    const gridIntrinsicSharedPixels = decodePng(await page.locator('#grid-intrinsic-shared').screenshot());
    const gridIntrinsicEdgePixels = decodePng(await page.locator('#grid-intrinsic-edge').screenshot());
    assert.deepEqual(paintPixel(gridIntrinsicSharedPixels, 5, 22), [255,255,0], 'shared Browser paints the grid background through an implicit row gap');
    assert.deepEqual(paintPixel(gridIntrinsicEdgePixels, 5, 22), [255,255,0], 'Edge paints the grid background through an implicit row gap');
    await page.locator('#grid-intrinsic-shared,#grid-intrinsic-edge').evaluateAll(nodes => nodes.forEach(node => node.remove()));
    const autoGridStretch = await page.evaluate(() => {
      const markup = '<main><div id="auto-grid"><i class="cell"></i><i class="cell"></i><i class="cell"></i><i class="cell"></i></div></main>';
      const css = 'main{width:100px;height:100px}#auto-grid{position:absolute;left:0;top:0;width:100px;height:100px;display:grid;grid-template-columns:20px 20px;row-gap:5px}.cell{width:20px;height:20px}';
      const compiled = NovelScreenDocument.compileScreenDocument(markup, css, { width: 100, height: 100 });
      const shared = document.createElement('div'); shared.id = 'auto-grid-shared'; shared.style.cssText = 'position:fixed;left:0;top:0;width:100px;height:100px;padding:0;margin:0';
      shared.append(NovelScreenDocument.buildScreenDom(compiled.tree, document)); document.body.append(shared);
      const raw = document.createElement('div'); raw.id = 'auto-grid-edge'; raw.style.cssText = shared.style.cssText;
      const style = document.createElement('style'); style.textContent = css; raw.innerHTML = markup; raw.prepend(style); document.body.append(raw);
      const rects = host => [...host.querySelectorAll('.cell')].map(node => { const r=node.getBoundingClientRect(), h=host.getBoundingClientRect(); return [r.x-h.x,r.y-h.y,r.height]; });
      return { shared: rects(shared), edge: rects(raw) };
    });
    assert.deepEqual(autoGridStretch.edge, [[0,0,20],[20,0,20],[0,52.5,20],[20,52.5,20]], 'Edge stretches implicit auto rows around the 5px row gap');
    assert.deepEqual(autoGridStretch.shared, autoGridStretch.edge, 'shared grid auto-track sizing matches Edge');
    await page.locator('#auto-grid-shared,#auto-grid-edge').evaluateAll(nodes => nodes.forEach(node => node.remove()));
    const unevenAutoGrid = await page.evaluate(() => {
      const markup = '<main><div id="uneven-grid"><i id="tall-a"></i><i id="tall-b"></i><i id="short-a"></i><i id="short-b"></i></div></main>';
      const css = 'main{width:100px;height:100px}#uneven-grid{position:absolute;left:0;top:0;width:100px;height:100px;display:grid;grid-template-columns:20px 20px;row-gap:5px;background:#ffff00}#tall-a,#tall-b{height:30px;background:#ff0000}#short-a,#short-b{height:10px;background:#0000ff}';
      const compiled = NovelScreenDocument.compileScreenDocument(markup, css, { width: 100, height: 100 });
      const shared = document.createElement('div'); shared.id = 'uneven-grid-shared'; shared.style.cssText = 'position:fixed;left:0;top:0;width:100px;height:100px;padding:0;margin:0';
      shared.append(NovelScreenDocument.buildScreenDom(compiled.tree, document)); document.body.append(shared);
      const raw = document.createElement('div'); raw.id = 'uneven-grid-edge'; raw.style.cssText = shared.style.cssText;
      const style = document.createElement('style'); style.textContent = css; raw.innerHTML = markup; raw.prepend(style); document.body.append(raw);
      const rects = host => [...host.querySelectorAll('#tall-a,#tall-b,#short-a,#short-b')].map(node => { const r=node.getBoundingClientRect(), h=host.getBoundingClientRect(); return [r.x-h.x,r.y-h.y,r.width,r.height]; });
      return { shared: rects(shared), edge: rects(raw) };
    });
    assert.deepEqual(unevenAutoGrid.edge, [[0,0,20,30],[20,0,20,30],[0,62.5,20,10],[20,62.5,20,10]], 'Edge distributes the remaining definite grid height equally across unequal auto rows');
    assert.deepEqual(unevenAutoGrid.shared, unevenAutoGrid.edge, 'shared grid geometry matches Edge when auto rows have different intrinsic contributions');
    const unevenSharedPixels = decodePng(await page.locator('#uneven-grid-shared').screenshot());
    const unevenEdgePixels = decodePng(await page.locator('#uneven-grid-edge').screenshot());
    for (const image of [unevenSharedPixels, unevenEdgePixels]) {
      assert.deepEqual(paintPixel(image, 5, 5), [255,0,0]);
      assert.deepEqual(paintPixel(image, 5, 64), [0,0,255]);
    }
    await page.locator('#uneven-grid-shared,#uneven-grid-edge').evaluateAll(nodes => nodes.forEach(node => node.remove()));
    await page.evaluate(() => {
      const markup = '<main><div id="grid-overflow"><span id="grid-red"></span><span id="grid-green"></span><span id="grid-yellow"></span><span id="grid-cyan"></span><span id="grid-blue"></span></div></main>';
      const css = 'main{width:100px;height:80px}#grid-overflow{position:absolute;left:0;top:0;width:100px;height:30px;display:grid;grid-template-columns:40px 1fr;grid-auto-rows:20px;column-gap:5px;row-gap:7px;z-index:99}#grid-red{background-color:#ff0000}#grid-green{background-color:#00ff00}#grid-yellow{background-color:#ffff00}#grid-cyan{background-color:#00ffff}#grid-blue{background-color:#0000ff}';
      const compiled = NovelScreenDocument.compileScreenDocument(markup, css, { width: 100, height: 80 });
      const host = document.createElement('div'); host.id = 'grid-overflow-host'; host.style.cssText = 'position:relative;width:100px;height:80px;padding:0;margin:0';
      host.append(NovelScreenDocument.buildScreenDom(compiled.tree, document)); document.body.append(host);
    });
    const gridOverflowPixels = decodePng(await page.locator('#grid-overflow-host').screenshot());
    assert.deepEqual(paintPixel(gridOverflowPixels, 20, 10), [255,0,0], 'Browser paints the first grid track at its shared rect');
    assert.deepEqual(paintPixel(gridOverflowPixels, 70, 10), [0,255,0], 'Browser paints the fractional grid track at its shared rect');
    assert.deepEqual(paintPixel(gridOverflowPixels, 20, 57), [0,0,255], 'Browser leaves grid overflow visible for a third implicit row');
    await page.locator('#grid-overflow-host').evaluate(node => node.remove());
    const centeredText = await page.evaluate(() => {
      const compiled = NovelScreenDocument.compileScreenDocument('<main><div id="center">W</div><div id="top">W</div></main>', 'main{width:300px;height:60px}#center{position:absolute;left:0;top:0;width:300px;height:60px;padding-left:30px;padding-right:0;background-color:#010203;color:#fefefe;text-align:center;font-size:32px}#top{position:absolute;left:0;top:0;width:300px;height:60px;padding:8px;background-color:#010203;color:#fefefe;font-size:32px}', { width: 300, height: 60 });
      const host = document.createElement('div'); host.style.cssText = 'position:absolute;left:0;top:0;width:300px;height:60px';
      host.append(NovelScreenDocument.buildScreenDom(compiled.tree, document)); document.body.append(host);
      const element = host.querySelector('#center'), range = document.createRange(); range.selectNodeContents(element);
      const textRect = range.getBoundingClientRect(), rect = element.getBoundingClientRect(), style = getComputedStyle(element);
      const topElement = host.querySelector('#top'), topRange = document.createRange(); topRange.selectNodeContents(topElement);
      const topText = topRange.getBoundingClientRect(), topRect = topElement.getBoundingClientRect(), expectedTopOffset = parseFloat(getComputedStyle(topElement).paddingTop);
      const contentCenter = rect.left + parseFloat(style.paddingLeft) + (rect.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)) / 2;
      host.remove();
      return { width: rect.width, textCenter: (textRect.left + textRect.right) / 2, contentCenter, topTextOffset: topText.top - topRect.top, expectedTopOffset };
    });
    assert.equal(centeredText.width, 300, `Browser authored padding stays inside the shared outer rect: ${JSON.stringify(centeredText)}`);
    assert.ok(Math.abs(centeredText.textCenter - centeredText.contentCenter) <= 3, `Browser text-align:center uses the asymmetric-padding content box: ${JSON.stringify(centeredText)}`);
    assert.ok(Math.abs(centeredText.topTextOffset - centeredText.expectedTopOffset) <= 1, `Browser ordinary block text starts at the padded top edge rather than vertical center: ${JSON.stringify(centeredText)}`);
    const browserLineHeights = await page.evaluate(() => {
      const markup = '<main><div id="unitless-parent"><p id="unitless-child">First<br>Second</p></div><div id="percent-parent"><p id="percent-child">First<br>Second</p></div><div id="px-parent"><p id="px-child">First<br>Second</p></div><div id="zero-parent"><p id="zero-child">First<br>Second</p></div></main>';
      const css = 'main{width:300px;height:220px}#unitless-parent,#percent-parent,#px-parent,#zero-parent{position:absolute;left:0;width:100px;height:45px}#unitless-parent{top:0;font-size:20px;line-height:2}#percent-parent{top:50px;font-size:20px;line-height:150%}#px-parent{top:100px;font-size:20px;line-height:40px}#zero-parent{top:150px;font-size:20px;line-height:0}#unitless-child,#percent-child,#px-child,#zero-child{font-size:10px}';
      const compiled = NovelScreenDocument.compileScreenDocument(markup, css, { width: 300, height: 220 });
      const host = document.createElement('div'); host.style.cssText = 'position:absolute;left:0;top:0;width:300px;height:220px';
      host.append(NovelScreenDocument.buildScreenDom(compiled.tree, document)); document.body.append(host);
      const stats = id => { const element = host.querySelector(`#${id}`), range = document.createRange(); range.selectNodeContents(element); const lines = [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0).map(rect => rect.top); return { lineHeight: getComputedStyle(element).lineHeight, lines }; };
      const result = { unitless: stats('unitless-child'), percent: stats('percent-child'), px: stats('px-child'), zero: stats('zero-child') };
      host.remove(); return result;
    });
    for (const [name, expected] of [['unitless', 20], ['percent', 30], ['px', 40], ['zero', 0]]) {
      const sample = browserLineHeights[name];
      assert.equal(sample.lineHeight, `${expected}px`, `Browser resolves ${name} line-height through CSS inheritance: ${JSON.stringify(sample)}`);
      assert.equal(sample.lines.length, 2, `Browser retains both explicit ${name} text line boxes: ${JSON.stringify(sample)}`);
      assert.ok(Math.abs((sample.lines[1] - sample.lines[0]) - expected) <= 1, `Browser ${name} line baselines match its computed value: ${JSON.stringify(sample)}`);
    }
    const playerUi = await (await page.request.get(`${base}/api/player-ui`)).json();
    playerUi.theme.screen.width = 1440;
    playerUi.theme.screen.height = 810;
    await page.request.put(`${base}/api/player-ui`, { data: { theme: playerUi.theme } });
    await page.locator('[data-activity="presentation"]').click();
    await page.locator('[data-presentation-action="game-screens"]').click();
    await page.locator('.game-screen-settings').waitFor().catch(async error => {
      throw Error(`${error.message}\npage errors: ${errors.join('; ')}\nstate: ${await page.evaluate(() => JSON.stringify({ title: document.title, presentation: document.querySelector('.presentation-view')?.className, button: !!document.querySelector('[data-presentation-action="game-screens"]'), body: document.body.innerText.slice(0, 600) }))}`);
    });
    await page.locator('.game-screen-toolbar select[aria-label="編集する画面"]').selectOption('save');
    const scaleMode = page.locator('.game-screen-toolbar select[aria-label="画面サイズへの適応"]');
    assert.equal(await scaleMode.inputValue(), 'contain', 'screen-size adaptation defaults to aspect-preserving contain');
    const previewRatio = page.locator('.game-screen-toolbar select[aria-label="Preview Aspect Ratio"]');
    await previewRatio.selectOption('4:3');
    await scaleMode.selectOption('cover');
    await page.waitForFunction(() => !!document.querySelector('.game-screen-preview > *'));
    const coverPreview = await page.locator('.game-screen-preview > *').first().evaluate(node => ({
      left: Number.parseFloat(node.style.left), top: Number.parseFloat(node.style.top),
      transform: NovelScreenDocument.canvasTransform(node.parentElement.clientWidth, node.parentElement.clientHeight, { width: 1440, height: 810 }, 'cover'),
      ratio: getComputedStyle(node.parentElement).aspectRatio,
      backgroundSize: getComputedStyle(node.parentElement).backgroundSize,
    }));
    assert.equal(coverPreview.ratio, '4 / 3');
    assert.equal(coverPreview.backgroundSize.split(',').at(-1).trim(), 'cover', 'editor preview keeps screen backgrounds proportional like Browser and Native playback');
    assert.ok(coverPreview.transform.offsetX < 0, 'cover preview crops horizontally for a 4:3 viewport');
    assert.ok(Math.abs(coverPreview.left - coverPreview.transform.offsetX) < 1, 'editor places the authored canvas at the same cover offset used by playback');
    await scaleMode.selectOption('contain');
    const containPreview = await page.locator('.game-screen-preview > *').first().evaluate(node => ({
      top: Number.parseFloat(node.style.top),
      transform: (() => { const preview = document.querySelector('.game-screen-preview'); return NovelScreenDocument.canvasTransform(preview.clientWidth, preview.clientHeight, { width: 1440, height: 810 }, 'contain'); })(),
    }));
    assert.ok(containPreview.transform.offsetY > 0, 'contain preview letterboxes a 16:9 canvas in a 4:3 viewport');
    assert.ok(Math.abs(containPreview.top - containPreview.transform.offsetY) < 1, 'letterbox offset is reflected in editor layout');
    await scaleMode.selectOption('cover');
    assert.equal(await page.locator('.game-screen-preview [data-slot-index="0"] [data-slot-field="number"]').textContent(), '01', 'editor preview preserves authored card fields');
    assert.equal(await page.locator('.game-screen-preview [data-slot-index="0"] [data-slot-field="status"]').textContent(), '記録あり');
    await page.locator('.game-screen-toolbar select[aria-label="編集する画面"]').selectOption('title');
    assert.equal(await page.locator('.game-screen-toolbar button').filter({ hasText: 'HTML/CSSが正本' }).isDisabled(), true, 'template-backed screens cannot switch to a JSON-only visual editor');
    const apiScreens = await (await page.request.get(`${base}/api/game-screens`)).json();
    const titleHtmlPath = prototypeScreens.screens.title.template;
    const transparentButtonStyle = await page.locator('.game-screen-preview #title-start').evaluate(node => {
      const style = getComputedStyle(node);
      return { backgroundImage: style.backgroundImage, textColor: getComputedStyle(node.querySelector('.title-main')).color, borderWidth: style.borderTopWidth };
    });
    assert.match(transparentButtonStyle.backgroundImage, /sakura-menu-plate\.png/, 'the title uses the generated sakura button artwork');
    assert.equal(transparentButtonStyle.textColor, 'rgb(98, 73, 87)', 'menu labels remain independently rendered on the generated plate');
    assert.equal(transparentButtonStyle.borderWidth, '0px', 'title rows have no extra rectangular outline');
    const generatedButtonImage = await page.locator('.game-screen-preview #title-start').evaluate(async node => {
      const source = getComputedStyle(node).backgroundImage.match(/url\(["']?(.*?)["']?\)/)?.[1];
      if (!source) throw Error('Title button background image URL is missing');
      const image = new Image(); image.src = source; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d'); context.drawImage(image, 0, 0, 1, 1);
      return { width: image.naturalWidth, height: image.naturalHeight, cornerPixel: Array.from(context.getImageData(0, 0, 1, 1).data) };
    });
    assert.ok(generatedButtonImage.width > 100 && generatedButtonImage.height > 30, 'generated button art loads from the project asset route');
    assert.ok(generatedButtonImage.cornerPixel[3] > 245, 'the generated pearl button surface is an intentional solid button face, not a transparent sprite');
    await page.locator('.game-screen-inspector textarea[aria-label="画面HTML"]').fill(apiScreens.documents[titleHtmlPath].replace('GAME START', '物語を始める'));
    const sharedCss = await page.locator('.game-screen-inspector textarea[aria-label="共通CSS"]').inputValue();
    await page.locator('.game-screen-inspector textarea[aria-label="共通CSS"]').fill(`${sharedCss}\n.title-menu{background-color:rgba(16,24,32,0.85);border:1px solid #304050}\n.title-item:hover{color:#ffffff;background-color:#315f80}`);
    await page.locator('.game-screen-settings footer button').click();
    await page.getByText('画面設定を保存しました。').waitFor().catch(async error => {
      throw Error(`${error.message}\neditor status: ${await page.locator('.game-screen-status').textContent()}`);
    });
    const saved = await (await page.request.get(`${base}/api/game-screens`)).json();
    assert.equal(saved.configured, true);
    assert.deepEqual(saved.screens.canvas, { width: 1440, height: 810 }, 'game screen canvas is derived from the shared player display dimensions');
    assert.equal(saved.screens.scaleMode, 'cover', 'screen-size adaptation mode is persisted through the editor');
    const storedScreens = JSON.parse(await fs.readFile(path.join(project.settingsRoot, 'game-screens.json'), 'utf8'));
    assert.equal(Object.hasOwn(storedScreens, 'canvas'), false, 'saving screen layout does not persist a duplicate canvas size');
    assert.equal(Object.hasOwn(storedScreens.screens.title, 'items'), false, 'HTML-backed button data is not duplicated into the editable screen manifest');
    assert.equal(Object.hasOwn(storedScreens.screens.save, 'slotLayout'), false, 'HTML-backed slot geometry remains in HTML/CSS only');
    assert.match(saved.screens.screens.title.items.find(item => item.action === 'start').label, /物語を始める/);
    assert.match(saved.documents[titleHtmlPath], /物語を始める/);
    assert.ok(saved.screens.screens.title.uiTree, 'the shared UI tree is available to player and editor preview');
    assert.equal(errors.length, 0, errors.join('\n'));
    await page.goto(`${base}/player.html`);
    await page.locator('#screen-overlay [data-action="start"]').filter({ hasText: '物語を始める' }).waitFor().catch(async error => {
      throw Error(`${error.message}\nplayer errors: ${errors.join('; ')}\noverlay: ${await page.locator('#screen-overlay').evaluate(node => node.outerHTML.slice(0, 5000))}\nrealm: ${JSON.stringify(await page.evaluate(() => ({ doc: typeof NovelScreenDocument, player: typeof gameScreenConfig, tree: typeof gameScreenConfig === 'undefined' ? null : gameScreenConfig.screens.title.uiTree, active: typeof activeGameScreen === 'undefined' ? null : activeGameScreen })))}\nconfig: ${JSON.stringify((await (await page.request.get(`${base}/api/game-screens`)).json()).screens.screens.title.items)}`);
    });
    await page.evaluate(async () => {
      await saveStore.writeSlot(20, JSON.stringify({ version: 1, scene: 'damaged', line: 0, variables: {} }));
      await saveStore.writeSlot(21, JSON.stringify({ version: 1, saveId: 'another-work', file: 'main.tds', scene: 'main', line: 1, variables: {} }));
    });
    await page.reload();
    await page.locator('#screen-overlay .title-menu').waitFor();
    const titleLogo = page.locator('#screen-overlay .title-logo');
    assert.equal(await titleLogo.getAttribute('alt'), '春、遅刻から始まる恋', 'the title artwork keeps its accessible exact story name');
    await page.waitForFunction(() => { const image = document.querySelector('#screen-overlay .title-logo'); return image?.complete && image.naturalWidth > 0; });
    const titleLogoAlpha = await titleLogo.evaluate(async image => {
      const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
      const { data, width, height } = context.getImageData(0, 0, canvas.width, canvas.height);
      let left = width, top = height, right = 0, bottom = 0, edgePixels = 0;
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        if (!data[(y * width + x) * 4 + 3]) continue;
        left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
        if (!x || !y || x === width - 1 || y === height - 1) edgePixels++;
      }
      return { width, height, left, top, right, bottom, edgePixels };
    });
    assert.ok(titleLogoAlpha.left > 0 && titleLogoAlpha.top > 0 && titleLogoAlpha.right < titleLogoAlpha.width - 1 && titleLogoAlpha.bottom < titleLogoAlpha.height - 1 && titleLogoAlpha.edgePixels === 0, `generated logo has clean transparent padding and no edge speckle: ${JSON.stringify(titleLogoAlpha)}`);
    assert.ok(await titleLogo.evaluate(node => {
      const rect = node.getBoundingClientRect();
      return rect.right > window.innerWidth * 0.85 && rect.top > window.innerHeight * 0.35;
    }), 'the generated title logo occupies the lower-right title-art area');
    await captureScreen('title');
    assert.equal(await page.locator('#screen-overlay .title-menu').count(), 1, 'custom HTML layout is rendered by the player');
    assert.match(await page.locator('#screen-overlay .title-menu').evaluate(node => getComputedStyle(node).backgroundColor), /rgba\(16, 24, 32, 0\.85\)/);
    assert.equal(await page.locator('#screen-overlay').getAttribute('aria-modal'), 'true', 'front-end screens are exposed as modal dialogs');
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.action), 'start', 'the first available menu action receives keyboard focus');
    let screenAx = await accessibilityNodes();
    assert.ok(screenAx.some(node => node.role?.value === 'dialog' && node.name?.value === 'Title screen'), 'Edge accessibility tree names the modal title screen');
    assert.ok(screenAx.some(node => node.role?.value === 'button' && node.name?.value === '物語を始める'), 'Edge accessibility tree exposes the title start action by its authored name');
    assert.ok(screenAx.some(node => node.role?.value === 'image' && node.name?.value === '春、遅刻から始まる恋'), 'Edge accessibility tree exposes the title logo alternative text');
    await page.locator('#screen-overlay [data-action="quit"]').focus();
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.action), 'start', 'Tab wraps from the last title action to the first enabled action');
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.action), 'quit', 'Shift+Tab wraps from the first action to the last');
    await page.locator('#screen-overlay [data-action="start"]').focus();
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.action), 'load', 'directional navigation follows screen geometry');
    await page.keyboard.press('ArrowUp');
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.action), 'start');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.action), 'load');
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.action), 'start');
    const playerTitleStart = page.locator('#screen-overlay #title-start');
    await playerTitleStart.evaluate(node => node.blur());
    await page.mouse.move(1270, 710);
    const normalPlayerButtonImage = await playerTitleStart.evaluate(node => getComputedStyle(node).backgroundImage);
    await playerTitleStart.hover();
    const activePlayerButtonImage = await playerTitleStart.evaluate(node => getComputedStyle(node).backgroundImage);
    assert.match(activePlayerButtonImage, /sakura-menu-plate-hover-v2\.png/, 'Browser player hover switches to the clearly illuminated selected-state image');
    assert.notEqual(activePlayerButtonImage, normalPlayerButtonImage, 'Browser player applies a distinct image for the active button');
    await page.locator('#screen-overlay [data-action="quit"]').click();
    await page.waitForURL(base + '/');
    await page.goto(`${base}/player.html`);
    await page.locator('#screen-overlay .title-menu').waitFor();
    assert.equal(await page.locator('#player-controls').isVisible(), false, 'story shortcuts do not appear behind the title screen');
    await page.keyboard.press('F1');
    await page.locator('#screen-overlay .system-options').waitFor();
    assert.equal(await page.locator('#screen-overlay .screen-title').evaluate(node => getComputedStyle(node).marginTop), '0px', 'portable heading reset prevents Browser user-agent margins from shifting text away from Native geometry');
    const f1Binding = page.locator('#screen-overlay [data-action="shortcut-cycle"][data-target="F1"]');
    assert.match(await f1Binding.textContent(), /System/);
    await f1Binding.click();
    assert.match(await page.locator('#screen-overlay [data-action="shortcut-cycle"][data-target="F1"]').textContent(), /Save/, 'the SYSTEM page cycles the actual F1 binding and redraws its English label');
    await page.waitForFunction(async () => (await saveStore.readPreference('ui-settings'))?.['ui.shortcut.F1'] === 'save');
    await page.keyboard.press('F1');
    await page.locator('#screen-overlay .save-slot-grid').waitFor();
    assert.equal(await page.evaluate(() => activeGameScreen), 'save', 'remapped F1 opens the Save screen, not the hard-coded SYSTEM screen');
    await page.goto(`${base}/player.html`);
    await page.locator('#screen-overlay .title-menu').waitFor();
    await page.keyboard.press('F1');
    await page.locator('#screen-overlay .save-slot-grid').waitFor();
    assert.equal(await page.evaluate(() => activeGameScreen), 'save', 'the remapped key still opens Save after reloading the Browser player');
    await page.locator('#screen-overlay [data-action="open-screen"][data-target="system"]').click();
    await page.locator('#screen-overlay .system-options').waitFor();
    for (let index = 0; index < 11; index++) await page.locator('#screen-overlay [data-action="shortcut-cycle"][data-target="F1"]').click();
    assert.match(await page.locator('#screen-overlay [data-action="shortcut-cycle"][data-target="F1"]').textContent(), /System/, 'cycling can restore the original English label');
    await page.locator('#screen-overlay [data-action="back"]').click();
    await page.locator('#screen-overlay [data-action="back"]').click();
    await page.locator('#screen-overlay .title-menu').waitFor();
    await page.locator('#screen-overlay [data-action="open-screen"][data-target="system"]').click();
    await page.locator('#screen-overlay .system-options').waitFor();
    await page.evaluate(async () => {
      screenHistory.length = 0;
      screenHistory.push('title');
      await activateGameScreenAction('open-screen', 'system', null);
    });
    assert.equal(await page.evaluate(() => screenHistory.length), 1, 'opening the active screen again does not add a duplicate history entry');
    await page.locator('#screen-overlay [data-action="back"]').click();
    await page.locator('#screen-overlay .title-menu').waitFor();
    await page.locator('#screen-overlay [data-action="open-screen"][data-target="system"]').click();
    await page.locator('#screen-overlay .system-options').waitFor();
    assert.equal(await page.locator('#player-controls').isVisible(), false, 'story Save/Load shortcuts are hidden behind a custom game screen');
    assert.equal(await page.locator('#screen-overlay .shortcut-row').count(), 12, 'the system screen exposes twelve editable function-key bindings');
    assert.equal(await page.locator('#screen-overlay .screen-tabs .tab-button').count(), 6, 'system page has the same six top navigation tabs as the reference');
    await page.locator('#screen-overlay [data-action="setting-value"][data-target="ui.fontFamily"][data-value="mincho"]').click();
    await page.waitForFunction(async () => (await saveStore.readPreference('ui-settings'))?.['ui.fontFamily'] === 'mincho');
    await page.reload();
    await page.locator('#screen-overlay .title-menu').waitFor();
    assert.equal(await page.locator('#stage').evaluate(node => getComputedStyle(node).fontFamily), 'serif', 'the selected font is restored when the Browser player restarts');
    await page.keyboard.press('F1');
    await page.locator('#screen-overlay .system-options').waitFor();
    await page.locator('#screen-overlay [data-action="setting-value"][data-target="ui.fontFamily"][data-value="default"]').click();
    assert.equal(await page.locator('#stage').evaluate(node => node.style.fontFamily), '', 'selecting Default restores the authored project font');
    await page.waitForFunction(() => [...document.querySelectorAll('#screen-overlay .screen-tabs .tab-icon')].length === 6 && [...document.querySelectorAll('#screen-overlay .screen-tabs .tab-icon')].every(node => node.complete && node.naturalWidth > 0));
    assert.deepEqual(await page.locator('#screen-overlay .screen-tabs .tab-icon').evaluateAll(nodes => nodes.map(node => ({ source: node.getAttribute('src'), loaded: node.complete && node.naturalWidth > 0 }))), [
      { source: '/asset/ui/icons/save.png', loaded: true }, { source: '/asset/ui/icons/load.png', loaded: true },
      { source: '/asset/ui/icons/system.png', loaded: true }, { source: '/asset/ui/icons/sound.png', loaded: true },
      { source: '/asset/ui/icons/favorite.png', loaded: true }, { source: '/asset/ui/icons/tips.png', loaded: true },
    ], 'the six image-based navigation icons load as transparent project assets');
    assert.deepEqual(await page.locator('#screen-overlay input[data-setting]').evaluateAll(nodes => nodes.map(node => node.dataset.setting).sort()), ['ui.autoSpeed', 'ui.cursorHideDelay', 'ui.textSpeed'].sort(), 'continuous preferences remain native range controls');
    assert.equal(await page.locator('#screen-overlay [data-action="setting-value"]').count(), 13, 'five binary settings and three typeface choices are actionable buttons');
    await page.locator('#screen-overlay input[data-setting="ui.textSpeed"]').fill('0');
    const fullscreenToggle = page.locator('#screen-overlay [data-action="setting-value"][data-target="ui.fullscreen"][data-value="true"]');
    await fullscreenToggle.click();
    await page.waitForFunction(() => Boolean(document.fullscreenElement));
    const windowMode = page.locator('#screen-overlay [data-action="setting-value"][data-target="ui.fullscreen"][data-value="false"]');
    await windowMode.click();
    await page.waitForFunction(() => !document.fullscreenElement);
    const effectsOff = page.locator('#screen-overlay [data-action="setting-value"][data-target="ui.effects"][data-value="false"]');
    const effectsOn = page.locator('#screen-overlay [data-action="setting-value"][data-target="ui.effects"][data-value="true"]');
    await effectsOff.click();
    assert.equal(await effectsOff.getAttribute('aria-pressed'), 'true', 'the selected effects value is visibly and accessibly reflected');
    assert.equal(await effectsOn.getAttribute('aria-pressed'), 'false');
    await effectsOn.click();
    assert.equal(await effectsOn.getAttribute('aria-pressed'), 'true', 'selecting the opposite value updates the visible state');
    await captureScreen('system');
    const fontMincho = page.locator('#screen-overlay [data-action="setting-value"][data-target="ui.fontFamily"][data-value="mincho"]');
    await fontMincho.click();
    assert.equal(await fontMincho.getAttribute('aria-pressed'), 'true', 'font selection updates the checked state');
    assert.equal(await page.locator('#stage').evaluate(node => getComputedStyle(node).fontFamily), 'serif', 'font selection affects the shared game stage, not only the control label');
    await page.waitForFunction(async () => (await saveStore.readPreference('ui-settings'))?.['ui.fontFamily'] === 'mincho');
    await page.locator('#screen-overlay [data-action="setting-value"][data-target="ui.fontFamily"][data-value="default"]').click();
    assert.equal(await page.locator('#stage').evaluate(node => node.style.fontFamily), '', 'default restores the authored player font stack');
    await page.evaluate(() => { window.__novelResizeRequest = null; window.__novelResizeExpected = [playerTheme.screen.width + Math.max(0, outerWidth - innerWidth), playerTheme.screen.height + Math.max(0, outerHeight - innerHeight)]; window.resizeTo = (width, height) => { window.__novelResizeRequest = [width, height]; }; });
    await page.locator('#screen-overlay [data-action="reset-window-size"]').click();
    assert.deepEqual(await page.evaluate(() => window.__novelResizeRequest), await page.evaluate(() => window.__novelResizeExpected), 'window-size reset requests this project’s authored content viewport, including host chrome');
    await page.locator('#screen-overlay [data-action="open-screen"][data-target="sound"]').click();
    await page.locator('#screen-overlay .volume-panel').waitFor();
    await page.keyboard.press('Escape');
    await page.locator('#screen-overlay .system-options').waitFor();
    await page.locator('#screen-overlay [data-action="open-screen"][data-target="sound"]').click();
    await page.locator('#screen-overlay .volume-panel').waitFor();
    assert.equal(await page.locator('#screen-overlay .novel-skinned-control[data-skin="volume"]').count(), 7, 'global and character voice sliders use the shared art skin');
    assert.equal(await page.locator('#screen-overlay .novel-skinned-control[data-skin="mute"]').count(), 5, 'global and character mute checkboxes use the shared art skin');
    const volumeSkin = page.locator('#screen-overlay .novel-skinned-control[data-skin="volume"]').nth(1);
    await volumeSkin.hover({ position: { x: 140, y: 12 } });
    assert.match(await volumeSkin.locator('.novel-skin-thumb').getAttribute('data-asset-source'), /thumb-hover\.png$/, 'hover swaps the slider thumb artwork');
    const muteSkin = page.locator('#screen-overlay .novel-skinned-control[data-skin="mute"]').first();
    await muteSkin.hover();
    assert.match(await muteSkin.locator('.novel-skin-checkbox').getAttribute('data-asset-source'), /mute-off-hover\.png$/, 'hover swaps the unchecked control artwork');
    await muteSkin.click();
    assert.match(await muteSkin.locator('.novel-skin-checkbox').getAttribute('data-asset-source'), /mute-on-hover\.png$/, 'checked hover uses its own artwork state');
    await muteSkin.click();
    await captureScreen('sound-control-skins');
    assert.ok(await page.locator('#screen-overlay input[data-setting="audio.bgm"]').count(), 'the sound page exposes actual runtime audio controls');
    assert.ok(await page.locator('#screen-overlay [data-target="sound"]').count() >= 1, 'sound is a separate top-level page, like the reference');
    await captureScreen('sound');
    await page.locator('#screen-overlay input[data-setting="audio.bgm"]').fill('0.42');
    assert.equal(await page.locator('#screen-overlay input[data-setting="audio.bgm"]').inputValue(), '0.42');
    const ayakaVoice = page.locator('#screen-overlay input[data-setting="audio.voice.ayaka"]');
    const sisterVoice = page.locator('#screen-overlay input[data-setting="audio.voice.sister"]');
    assert.equal(await ayakaVoice.count(), 1);
    assert.equal(await sisterVoice.count(), 1);
    await ayakaVoice.fill('0.36');
    const ayakaMute = page.locator('#screen-overlay input[data-setting="audio.voice.ayaka.muted"]');
    await ayakaMute.locator('xpath=..').click();
    assert.equal(await ayakaMute.isChecked(), true, 'speaker-specific mute is an independent real checkbox');
    await page.locator('#screen-overlay [data-action="back"]').click();
    await page.locator('#screen-overlay .system-options').waitFor();
    await page.locator('#screen-overlay [data-action="back"]').click();
    await page.locator('#screen-overlay .title-menu').waitFor();
    await page.keyboard.press('F1');
    await page.locator('#screen-overlay input[data-setting="ui.textSpeed"]').waitFor();
    assert.equal(await page.locator('#screen-overlay input[data-setting="ui.textSpeed"]').inputValue(), '0', 'text speed preference persists after reopening SYSTEM');
    await page.locator('#screen-overlay [data-action="back"]').click();
    await page.locator('#screen-overlay .title-menu').waitFor();
    assert.equal(await page.locator('#player-controls').isVisible(), false, 'story shortcuts stay hidden while navigating between custom screens');
    await page.locator('#screen-overlay [data-action="open-screen"][data-target="system"]').click();
    await page.locator('#screen-overlay [data-action="open-screen"][data-target="sound"]').click();
    assert.equal(await page.locator('#screen-overlay input[data-setting="audio.bgm"]').inputValue(), '0.42', 'image-skinned slider value persists after leaving and reopening settings');
    assert.equal(await page.locator('#screen-overlay input[data-setting="audio.voice.ayaka"]').inputValue(), '0.36', 'character voice level persists independently of the common voice bus');
    assert.equal(await page.locator('#screen-overlay input[data-setting="audio.voice.sister"]').inputValue(), '1', 'another speaker retains its distinct default');
    assert.equal(await page.locator('#screen-overlay input[data-setting="audio.voice.ayaka.muted"]').isChecked(), true, 'speaker mute persists independently');
    const muteInput = page.locator('#screen-overlay input[data-setting="audio.bgmMuted"]');
    await muteInput.focus();
    await page.keyboard.press('Space');
    assert.equal(await muteInput.isChecked(), true, 'image-skinned checkbox remains keyboard-operable');
    await page.keyboard.press('Space');
    assert.equal(await muteInput.isChecked(), false, 'keyboard can restore the checkbox state');
    await page.locator('#screen-overlay [data-action="back"]').click();
    await page.locator('#screen-overlay [data-action="back"]').click();
    await page.locator('#screen-overlay .title-menu').waitFor();
    await page.locator('#screen-overlay [data-action="open-screen"][data-target="about"]').click();
    assert.match(await page.locator('#screen-overlay').innerText(), /入学式の日/);
    assert.match(await page.locator('#screen-overlay .screen-subtitle').textContent(), /\n/, 'br renders as an explicit text line break');
    assert.equal(await page.locator('#screen-overlay .screen-subtitle').evaluate(element => getComputedStyle(element).whiteSpace), 'pre-line');
    await captureScreen('extra');
    await page.locator('#screen-overlay [data-action="back"]').click();
    await page.locator('#screen-overlay .title-menu').waitFor();
    await page.locator('#screen-overlay [data-action="start"]').filter({ hasText: '物語を始める' }).click();
    await page.waitForFunction(() => { const text = document.querySelector('#text')?.textContent || ''; return text.length > 0 && text.length < '新しい作品を始めます。'.length; });
    assert.notEqual(await page.locator('#text').textContent(), '新しい作品を始めます。', 'low text-speed setting reveals dialogue progressively');
    await page.locator('#dialogue').click();
    await page.locator('#text').filter({ hasText: '新しい作品を始めます。' }).waitFor();
    assert.equal(await page.locator('#player-controls').isVisible(), true, 'Save/Load shortcuts appear during the story');
    await page.keyboard.press('Escape');
    await page.locator('#screen-overlay [data-action="resume"]').first().waitFor();
    screenAx = await accessibilityNodes();
    assert.ok(screenAx.some(node => node.role?.value === 'dialog' && node.name?.value === 'Pause menu'), 'pause overlay has a named modal dialog in the accessibility tree');
    assert.ok(screenAx.some(node => node.role?.value === 'button' && node.name?.value === 'BACK'), 'pause actions appear as named keyboard controls in the accessibility tree');
    assert.ok(screenAx.some(node => node.role?.value === 'slider' && node.name?.value === 'Master Volume'), 'pause volume control exposes its accessible name and slider role');
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.action), 'save', 'pause menu actions can be reached with directional keyboard navigation');
    await page.keyboard.press('ArrowUp');
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.action), 'back');
    assert.equal(await page.locator('#player-controls').isVisible(), false, 'Save/Load shortcuts are hidden under the pause screen');
    await page.keyboard.press('Escape');
    await page.locator('#screen-overlay').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#player-controls').isVisible(), true, 'Escape closes the pause screen and returns to the active story');
    await page.keyboard.press('Escape');
    await page.locator('#screen-overlay [data-action="resume"]').first().waitFor();
    assert.equal(await page.locator('#screen-overlay .pause-grid button.pause-button > img.pause-icon').count(), 14, 'every pause action uses a dedicated image node rather than a font glyph');
    await page.waitForFunction(() => [...document.querySelectorAll('#screen-overlay .pause-grid button.pause-button > img.pause-icon')].every(node => node.complete && node.naturalWidth > 0), null, { timeout: 10000 });
    await captureScreen('pause');
    await page.locator('#screen-overlay [data-action="open-screen"][data-target="guide"] .pause-icon').click();
    assert.equal((await page.locator('#screen-overlay .screen-subtitle').innerText()).trim(), 'Click / Enter: Advance dialogue or confirm a choice\nEsc: Open the in-game menu');
    await page.locator('#screen-overlay [data-action="back"]').click();
    await page.locator('#screen-overlay [data-action="open-screen"][data-target="log"] .pause-icon').click();
    await page.locator('#screen-overlay [data-role="dialogue-history"] .history-entry').waitFor();
    assert.equal((await page.locator('#screen-overlay .log-help').textContent()).trim(), 'Scroll with the mouse wheel.');
    assert.match(await page.locator('#screen-overlay [data-role="dialogue-history"]').innerText(), /新しい作品を始めます/);
    await page.locator('#screen-overlay [data-action="back"]').click();
    await page.locator('#screen-overlay [data-action="hold"]').click();
    await page.locator('#screen-overlay').waitFor({ state: 'hidden' });
    await page.locator('#next').click();
    assert.equal(await page.locator('#text').textContent(), '新しい作品を始めます。', 'HOLD suppresses ordinary dialogue clicks');
    await page.keyboard.press('Escape');
    await page.locator('#screen-overlay [data-action="hold"]').click();
    assert.equal(await page.locator('#text').textContent(), '新しい作品を始めます。', 'disabling HOLD does not itself consume a dialogue advance');
    await page.keyboard.press('Escape');
    await page.locator('#screen-overlay [data-action="resume"]').first().waitFor();
    await page.locator('#screen-overlay [data-action="quick-save"]').click();
    await page.locator('#stage .player-toast').filter({ hasText: 'Quick Saveを実行しました。' }).waitFor();
    const quickLoadNavigation = page.waitForNavigation();
    await page.locator('#screen-overlay [data-action="quick-load"]').click();
    await quickLoadNavigation;
    await page.locator('#text').filter({ hasText: '新しい作品を始めます。' }).waitFor();
    await page.waitForFunction(() => document.querySelector('#screen-overlay')?.hidden === true).catch(async error => {
      throw Error(`${error.message}\nquick-load overlay state: ${await page.evaluate(() => JSON.stringify({ hidden: document.querySelector('#screen-overlay')?.hidden, active: document.querySelector('#stage')?.dataset.gameScreenOpen, overlayText: document.querySelector('#screen-overlay')?.innerText.slice(0, 300), dialogue: document.querySelector('#text')?.textContent }))}`);
    });
    await page.keyboard.press('Escape');
    await page.locator('#screen-overlay [data-action="resume"]').first().waitFor();
    await page.locator('#screen-overlay [data-action="save"]').first().click();
    await page.locator('#screen-overlay [data-slot-index]').first().waitFor();
    screenAx = await accessibilityNodes();
    assert.ok(screenAx.some(node => node.role?.value === 'dialog' && node.name?.value === 'Save slots'), 'save flow has a named modal dialog in the accessibility tree');
    assert.ok(screenAx.some(node => node.role?.value === 'button' && /^01 空き$/.test(node.name?.value || '')), 'save slots appear as named, empty slot buttons in the accessibility tree');
    assert.equal(await page.locator('#screen-overlay [data-slot-index]').count(), 12, 'the HTML save-slots role expands into the configured 12-slot grid');
    assert.equal(await page.locator('#screen-overlay [data-slot-index="0"]').isDisabled(), false, 'save slot is enabled while a scenario line is active');
    assert.equal(await page.locator('#screen-overlay [data-slot-index="0"] [data-slot-field="number"]').textContent(), '01');
    assert.equal(await page.locator('#screen-overlay [data-slot-index="0"] [data-slot-field="status"]').textContent(), '空き');
    const firstSaveSlot = page.locator('#screen-overlay [data-slot-index="0"]');
    await firstSaveSlot.focus();
    await page.keyboard.press('Enter');
    assert.equal(await firstSaveSlot.getAttribute('aria-pressed'), 'true', 'save slot selection works from the keyboard and exposes its selected state');
    assert.equal(await page.locator('#screen-overlay [data-slot-index="1"] [data-slot-field="thumbnail"]').getAttribute('src'), null, 'an empty save card has no broken blank image URL');
    assert.equal(await page.locator('#screen-overlay [data-slot-index="1"] [data-slot-field="thumbnail"]').evaluate(node => getComputedStyle(node).display), 'none', 'empty cards do not render an image placeholder frame');
    const slotRects = await page.locator('#screen-overlay [data-slot-index]').evaluateAll(nodes => nodes.map(node => { const r = node.getBoundingClientRect(); return { index: node.dataset.slotIndex, x: r.x, y: r.y, w: r.width, h: r.height, inline: node.style.cssText, parent: node.parentElement.getBoundingClientRect().toJSON() }; }));
    assert.equal(new Set(slotRects.map(rect => `${rect.x},${rect.y}`)).size, 12, `save-slot cards must occupy separate CSS grid cells: ${JSON.stringify(slotRects)}`);
    const overlaps = slotRects.flatMap((a, i) => slotRects.slice(i + 1).filter(b => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y).map(b => [a.index, b.index]));
    assert.equal(overlaps.length, 0, `CSS grid cells must not overlap: ${JSON.stringify(slotRects)}`);
    await page.locator('#screen-overlay [data-slot-index="0"]').click();
    await page.waitForFunction(() => (document.querySelector('#text')?.textContent || '').length >= 11, null, { timeout: 10000 });
    await page.locator('#screen-overlay [data-action="slot-commit"]').click();
    await page.locator('#screen-overlay .game-screen-notice').filter({ hasText: '保存しました' }).waitFor();
    assert.equal(await page.locator('#screen-overlay [data-slot-index="0"] [data-slot-field="status"]').textContent(), '記録あり');
    assert.ok(await page.locator('#screen-overlay [data-slot-index="0"] [data-slot-field="thumbnail"]').getAttribute('src'), 'a saved card binds its captured thumbnail');
    assert.notEqual(await page.locator('#screen-overlay [data-slot-index="0"] [data-slot-field="thumbnail"]').evaluate(node => getComputedStyle(node).display), 'none', 'a saved card reveals its thumbnail when the screen is refreshed');
    assert.match(await page.locator('#screen-overlay [data-slot-index="0"] [data-slot-field="text"]').textContent(), /新しい作品を始めます/);
    await page.locator('#screen-overlay [data-action="back"]').click();
    await page.locator('#screen-overlay [data-action="load"]').first().click();
    await captureScreen('load');
    assert.equal(await page.locator('#screen-overlay [data-slot-index]').count(), 12, 'load screen uses the same custom slot layout and count');
    await page.locator('#screen-overlay [data-action="slot-page"][data-target="1"]').click();
    assert.equal(await page.locator('#screen-overlay [data-slot-index="12"] [data-slot-field="number"]').textContent(), '13', 'second save page binds the first card to save slot 13');
    assert.equal(await page.locator('#screen-overlay [data-slot-index="20"] [data-slot-field="status"]').textContent(), '破損', 'Browser preserves the corrupt-save state in the card UI');
    assert.equal(await page.locator('#screen-overlay [data-slot-index="21"] [data-slot-field="status"]').textContent(), '非対応', 'Browser distinguishes saves belonging to another work');
    assert.equal(await page.locator('#screen-overlay [data-slot-index="20"]').getAttribute('data-state'), 'corrupt');
    assert.equal(await page.locator('#screen-overlay [data-slot-index="21"]').getAttribute('data-state'), 'incompatible');
    for (const index of ['12', '20', '21']) assert.equal(await page.locator(`#screen-overlay [data-slot-index="${index}"]`).evaluate(node => getComputedStyle(node).opacity), '1', `disabled ${index} card remains legible without fading its thumbnail or status text`);
    assert.equal(await page.locator('#screen-overlay [data-slot-index="20"]').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(247, 236, 231)', 'the Browser applies the authored corrupt-card state style');
    assert.equal(await page.locator('#screen-overlay [data-slot-index="21"]').evaluate(node => getComputedStyle(node).borderTopColor), 'rgb(170, 149, 107)', 'the Browser applies the authored incompatible-card state style');
    assert.equal(await page.locator('#screen-overlay [data-action="slot-page"][data-target="1"]').evaluate(node => node.classList.contains('slot-page-active')), true, 'page selection is visually reflected');
    await page.locator('#screen-overlay [data-action="slot-page"][data-target="0"]').click();
    assert.equal(await page.locator('#screen-overlay [data-slot-index="0"]').isDisabled(), false, 'saved slots become loadable');
    assert.equal(await page.locator('#screen-overlay [data-slot-index="0"] [data-slot-field="status"]').textContent(), '記録あり');
    await page.locator('#screen-overlay [data-action="back"]').click();
    await page.locator('#screen-overlay [data-action="open-screen"][data-target="system"]').click();
    await page.locator('#screen-overlay [data-action="open-screen"][data-target="sound"]').click();
    assert.ok(await page.locator('#screen-overlay input[data-setting="audio.voice"]').count(), 'runtime voice volume remains functional on the sound page');
    await page.locator('#screen-overlay [data-action="back"]').click();
    await page.locator('#screen-overlay [data-action="back"]').click();
    await page.locator('#screen-overlay [data-action="resume"]').first().click();
    await page.locator('#screen-overlay').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#player-controls').isVisible(), true, 'story shortcuts return after leaving the screen menu');
    assert.equal(await page.locator('#text').textContent(), '新しい作品を始めます。');
    await page.keyboard.press('Escape');
    await page.locator('#screen-overlay [data-action="open-screen"][data-target="system"]').click();
    await page.locator('#screen-overlay input[data-setting="ui.cursorHideDelay"]').fill('0.333333');
    await page.locator('#screen-overlay [data-action="back"]').click();
    await page.locator('#screen-overlay [data-action="resume"]').first().click();
    await page.waitForTimeout(5400);
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains('player-cursor-hidden')), true, 'cursor timeout hides the pointer after the configured five seconds');
    await page.mouse.move(50, 50);
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains('player-cursor-hidden')), false, 'pointer activity restores the cursor and restarts its timeout');
    await page.keyboard.press('Escape');
    await page.locator('#screen-overlay [data-action="skip"]').click();
    await page.locator('#text').filter({ hasText: 'skip-stop-line' }).waitFor();
    await page.waitForTimeout(250);
    assert.equal(await page.locator('#text').textContent(), 'skip-stop-line', 'read-only skip stops at the first unseen line instead of consuming it');
    await page.locator('#next').click();
    await page.locator('#text').filter({ hasText: 'auto-start-line' }).waitFor();
    await page.keyboard.press('Escape');
    await page.locator('#screen-overlay [data-action="open-screen"][data-target="system"]').click();
    const autoSpeed = page.locator('#screen-overlay input[data-setting="ui.autoSpeed"]');
    await autoSpeed.fill('1');
    assert.equal(await autoSpeed.inputValue(), '1', 'auto speed control reaches its maximum setting');
    await page.locator('#screen-overlay [data-action="back"]').click();
    await page.locator('#screen-overlay [data-action="auto"]').click();
    await page.locator('#text').filter({ hasText: 'auto-finish-line' }).waitFor({ timeout: 7000 });
    assert.equal(await page.locator('#text').textContent(), 'auto-finish-line', 'auto playback uses the selected speed and advances through the next dialogue');
    assert.equal(errors.length, 0, errors.join('\n'));
    const screensForTdsTitle = (await (await page.request.get(`${base}/api/game-screens`)).json()).screens;
    screensForTdsTitle.titleScene = { file: 'title.tds', scene: 'title_front' };
    const titleConfigResponse = await page.request.put(`${base}/api/game-screens`, { data: { screens: screensForTdsTitle } });
    assert.equal(titleConfigResponse.status(), 200, 'legacy TDS title metadata is accepted for compatibility');
    await page.goto(`${base}/player.html`);
    await page.locator('#screen-overlay [data-action="start"]').first().click();
    await page.locator('#text').filter({ hasText: '新しい作品を始めます。' }).waitFor();
    assert.equal(await page.locator('#screen-overlay').isHidden(), true, 'legacy titleScene metadata does not replace the configured entry; explicit start() opens and resumes from the configured screen');
    const failedScreenStart = await page.evaluate(async () => {
      const originalShowGameScreen = showGameScreen;
      showGameScreen = () => { throw new Error('injected screen render failure'); };
      let message = '';
      try { await runtime.host.start(runtime); }
      catch (error) { message = error.message; }
      finally { showGameScreen = originalShowGameScreen; }
      return { message, resolverCleared: startWaitResolve === null };
    });
    assert.equal(failedScreenStart.message, 'injected screen render failure');
    assert.equal(failedScreenStart.resolverCleared, true, 'a synchronous screen render failure clears the pending start() continuation');
    await page.goto(`${base}/player.html?source=title.tds`);
    await page.waitForFunction(() => !document.querySelector('#screen-overlay')?.hidden, null, { timeout: 20_000 }).catch(async error => {
      throw Error(`${error.message}\nexplicit TDS start screen state: ${JSON.stringify(await page.evaluate(() => ({ text: document.querySelector('#text')?.textContent, speaker: document.querySelector('#speaker-text')?.textContent, hidden: document.querySelector('#screen-overlay')?.hidden, screen: document.querySelector('#screen-overlay')?.dataset.screen, overlay: document.querySelector('#screen-overlay')?.innerText?.slice(0, 400), errors: window.__pageErrors || [] })))}`);
    });
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.action), 'continue', 'TDS-triggered Start screen initializes focus on its first enabled action');
    screenAx = await accessibilityNodes();
    assert.ok(screenAx.some(node => node.role?.value === 'button' && node.name?.value === '物語を始める'), 'TDS-triggered Start screen retains its accessible action name');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.action), 'start', 'Start remains reachable through sequential keyboard navigation');
    await page.keyboard.press('Enter');
    await page.locator('#text').filter({ hasText: 'TDS title reached' }).waitFor().catch(async error => {
      throw Error(`${error.message}\nTDS title debug: ${JSON.stringify(await page.evaluate(() => ({ text: document.querySelector('#text')?.textContent, scene: document.querySelector('#scene')?.textContent, overlay: document.querySelector('#screen-overlay')?.textContent?.slice(0, 200), pageErrors: window.__pageErrors || [] })))}`);
    });
    assert.equal(await page.locator('#screen-overlay').isHidden(), true, 'an explicit start() opens the JSON screen and resumes TDS after its start action');
    assert.equal(errors.length, 0, errors.join('\n'));
    const legacyResponse = await page.request.put(`${base}/api/game-screens`, { data: { screens: defaultGameScreens() } });
    assert.equal(legacyResponse.status(), 200, 'legacy JSON-only screens remain accepted');
    await page.goto(`${base}/player.html`);
    await page.locator('#screen-overlay .game-screen-button').filter({ hasText: 'はじめから' }).waitFor();
    assert.equal(await page.locator('#screen-overlay .game-screen-button').count(), 1, 'JSON-only screens keep their prior Browser renderer');
    await page.goto(base);
    await page.locator('[data-activity="presentation"]').click();
    await page.locator('[data-presentation-action="game-screens"]').click();
    await page.locator('.game-screen-settings').waitFor();
    assert.equal(await page.locator('.game-screen-settings').getByText('TDSタイトルシーン').count(), 0, 'the editor no longer exposes an ignored legacy scene selector');
    await page.locator('.game-screen-toolbar button').filter({ hasText: 'HTML/CSSで編集' }).click();
    await page.locator('.game-screen-inspector textarea[aria-label="画面HTML"]').waitFor();
    await page.locator('.game-screen-settings footer button').click();
    await page.getByText('画面設定を保存しました。').waitFor();
    const migrated = await (await page.request.get(`${base}/api/game-screens`)).json();
    const htmlEditor = page.locator('.game-screen-inspector textarea.game-screen-source:not(.game-screen-source-css)');
    const gameScreenDialog = page.locator('.game-screen-settings');
    const closeGameScreenDialog = gameScreenDialog.locator('.project-settings-close');
    assert.equal(await gameScreenDialog.getAttribute('aria-modal'), 'true', 'screen authoring uses a modal dialog');
    await closeGameScreenDialog.focus();
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'SELECT', 'Tab advances from the dialog close control into the screen selector');
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('project-settings-close')), true, 'Shift+Tab wraps to the dialog close control');
    const validScreenHtml = await htmlEditor.inputValue();
    const invalidScreenHtml = validScreenHtml.replace('data-action="start"', 'data-action="unsupported-editor-action"');
    assert.notEqual(invalidScreenHtml, validScreenHtml, 'fixture contains a start action that can be made invalid');
    await htmlEditor.fill(invalidScreenHtml);
    await page.locator('.game-screen-status').filter({ hasText: 'unsupported-editor-action' }).waitFor();
    await page.locator('.game-screen-settings footer button').click();
    await page.locator('.game-screen-status').filter({ hasText: 'unsupported-editor-action' }).waitFor();
    assert.equal(await gameScreenDialog.isVisible(), true, 'a rejected screen save leaves the authoring dialog open');
    assert.equal(await htmlEditor.inputValue(), invalidScreenHtml, 'a rejected screen save retains the invalid source for correction');
    const rejectedSaveState = await (await page.request.get(`${base}/api/game-screens`)).json();
    assert.deepEqual(rejectedSaveState.documents, migrated.documents, 'server-side compile rejection does not persist a partial document set');
    await htmlEditor.fill(validScreenHtml);
    await page.locator('.game-screen-settings footer button').click();
    await page.waitForFunction(() => Boolean(document.querySelector('.game-screen-status')?.textContent));
    assert.ok(migrated.screens.screens.title.uiTree, 'legacy settings migrate to the shared HTML/CSS rendering format');
    assert.match(migrated.documents[migrated.screens.screens.title.template], /data-action="start"/);
    await page.goto(`${base}/player.html`);
    await page.locator('#screen-overlay [data-action="start"]').filter({ hasText: 'はじめから' }).waitFor();
    assert.equal(errors.length, 0, errors.join('\n'));
    console.log('PASS browser screens: HTML/CSS edit, live preview, actions, save slots, legacy fallback/migration, TDS title entry');
  } finally {
    await browser?.close();
    if (child.exitCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      else child.kill('SIGTERM');
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5000))]);
    }
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
