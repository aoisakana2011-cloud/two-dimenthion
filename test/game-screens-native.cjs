'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { deflateSync, inflateSync } = require('node:zlib');
const { pack } = require('../tools/pack');
const { seedEmptyProject } = require('../tools/project-layout');

function decodePng(buffer) {
  let width, height, bitDepth, colorType;
  const chunks = [];
  for (let offset = 8; offset < buffer.length;) {
    const length = buffer.readUInt32BE(offset); const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length); offset += length + 12;
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; }
    if (type === 'IDAT') chunks.push(data);
    if (type === 'IEND') break;
  }
  assert.equal(bitDepth, 8); assert.ok(colorType === 2 || colorType === 6, `supported PNG color type: ${colorType}`);
  const channels = colorType === 6 ? 4 : 3, stride = width * channels;
  const compressed = inflateSync(Buffer.concat(chunks)); const pixels = Buffer.alloc(height * stride);
  const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
  let input = 0;
  for (let y = 0; y < height; y++) {
    const filter = compressed[input++], row = y * stride;
    for (let x = 0; x < stride; x++) {
      const raw = compressed[input++], left = x >= channels ? pixels[row + x - channels] : 0;
      const above = y ? pixels[row - stride + x] : 0, upperLeft = y && x >= channels ? pixels[row - stride + x - channels] : 0;
      const predictor = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? above : filter === 3 ? Math.floor((left + above) / 2) : paeth(left, above, upperLeft);
      pixels[row + x] = (raw + predictor) & 255;
    }
  }
  return { width, height, channels, pixels };
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
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

function brightPixelBounds(image, region) {
  let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
  for (let y = region.y; y < region.y + region.height; y++) for (let x = region.x; x < region.x + region.width; x++) {
    const at = (y * image.width + x) * image.channels;
    if (image.pixels[at] > 235 && image.pixels[at + 1] > 235 && image.pixels[at + 2] > 235) {
      left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
    }
  }
  return { left, right, top, bottom };
}

(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-game-screens-native-'));
  try {
    const project = seedEmptyProject(path.join(tempRoot, 'project'));
    const probeVoice = Buffer.alloc(44 + 80000 * 2);
    probeVoice.write('RIFF', 0); probeVoice.writeUInt32LE(probeVoice.length - 8, 4); probeVoice.write('WAVE', 8);
    probeVoice.write('fmt ', 12); probeVoice.writeUInt32LE(16, 16); probeVoice.writeUInt16LE(1, 20); probeVoice.writeUInt16LE(1, 22);
    probeVoice.writeUInt32LE(8000, 24); probeVoice.writeUInt32LE(16000, 28); probeVoice.writeUInt16LE(2, 32); probeVoice.writeUInt16LE(16, 34);
    probeVoice.write('data', 36); probeVoice.writeUInt32LE(probeVoice.length - 44, 40);
    await fs.mkdir(path.join(project.assetsRoot, 'voice'), { recursive: true });
    await fs.writeFile(path.join(project.assetsRoot, 'voice', 'mixer-probe.wav'), probeVoice);
    const mainPath = path.join(project.scenesRoot, 'main.tds');
    await fs.writeFile(mainPath, 'asset voice mixer_probe = "asset/voice/mixer-probe.wav"\ncharacter ayaka { name = "綾瀬あやか" }\nscene main {\n  start()\n  say narrator "Native screen smoke complete"\n}\n', 'utf8');
    const uiTheme = JSON.parse(await fs.readFile(path.resolve(__dirname, '../Title/setting/player-ui.json'), 'utf8'));
    uiTheme.screen.width = 1440;
    uiTheme.screen.height = 810;
    await fs.writeFile(path.join(project.settingsRoot, 'player-ui.json'), JSON.stringify(uiTheme, null, 2));
    await fs.appendFile(project.settingFile, 'native_ui_theme = player-ui.json\n');
    const imagePath = path.join(project.assetsRoot, 'bg', 'title.png');
    await fs.copyFile(path.resolve(__dirname, '../Title/asset/bg/title.png'), imagePath);
    await fs.copyFile(path.resolve(__dirname, '../Title/asset/bg/near_home.jpg'), path.join(project.assetsRoot, 'bg', 'near_home.jpg'));
    await fs.copyFile(path.resolve(__dirname, '../Title/asset/bg/school.jpg'), path.join(project.assetsRoot, 'bg', 'school.jpg'));
    const characterDirectory = path.join(project.assetsRoot, 'char');
    await fs.mkdir(characterDirectory, { recursive: true });
    for (const name of ['ayaka_normal.png', 'ayaka_dere.png', 'sisiter_normal.png', 'sisiter_normal_cutout.png', 'sister_dere.png']) {
      await fs.copyFile(path.resolve(__dirname, `../Title/asset/char/${name}`), path.join(characterDirectory, name));
    }
    const uiAssetDirectory = path.join(project.assetsRoot, 'ui');
    await fs.mkdir(uiAssetDirectory, { recursive: true });
    for (const name of ['dialogue-panel-romance.png', 'speaker-plate-romance.png', 'choice-romance.png']) {
      await fs.copyFile(path.resolve(__dirname, `../Title/asset/ui/${name}`), path.join(uiAssetDirectory, name));
    }
    const generatedUiAssets = [
      ['backgrounds/spring-ensemble-key-visual.jpg', 'backgrounds/spring-ensemble-key-visual.jpg'],
      ['portraits/ayaka-volume.png', 'portraits/ayaka-volume.png'],
      ['portraits/sister-volume.png', 'portraits/sister-volume.png'],
      ['buttons/sakura-menu-plate.png', 'buttons/sakura-menu-plate.png'],
      ['buttons/sakura-menu-plate-hover.png', 'buttons/sakura-menu-plate-hover.png'],
      ['buttons/sakura-menu-plate-hover-v2.png', 'buttons/sakura-menu-plate-hover-v2.png'],
      ['logos/spring-late-love-title-v2.png', 'logos/spring-late-love-title-v2.png'],
      ...['save', 'load', 'system', 'sound', 'favorite', 'tips', 'menu-back', 'menu-next', 'menu-auto', 'menu-skip', 'menu-log', 'menu-close', 'menu-hold'].map(name => [`icons/${name}.png`, `icons/${name}.png`]),
    ];
    for (const [sourceName, targetName] of generatedUiAssets) {
      const target = path.join(uiAssetDirectory, ...targetName.split('/'));
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(path.resolve(__dirname, `../Title/asset/ui/${sourceName}`), target);
    }
    const config = JSON.parse(await fs.readFile(path.resolve(__dirname, '../Title/setting/game-screens.json'), 'utf8'));
    config.controlSkins = {
      ...(config.controlSkins || {}),
      nativeSmoke: {
        type: 'range', track: 'ui/choice-romance.png', fill: 'ui/speaker-plate-romance.png', thumb: 'ui/dialogue-panel-romance.png',
        trackHeight: 8, thumbWidth: 28, thumbHeight: 28,
      },
      nativeToggle: { type: 'checkbox', off: 'ui/choice-romance.png', on: 'ui/speaker-plate-romance.png' },
    };
    for (const skin of Object.values(config.controlSkins)) {
      for (const key of ['track', 'fill', 'thumb', 'thumbHover', 'off', 'on', 'offHover', 'onHover']) {
        if (!skin[key]) continue;
        const relative = skin[key].replace(/^asset[\\/]/, '');
        const target = path.join(project.assetsRoot, ...relative.split('/'));
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.copyFile(path.resolve(__dirname, '../Title/asset', ...relative.split('/')), target);
      }
    }
    await fs.writeFile(path.join(project.settingsRoot, 'game-screens.json'), JSON.stringify(config, null, 2));
    for (const name of new Set([config.stylesheet, config.controlSettings, ...Object.values(config.screens).map(screen => screen.template)].filter(Boolean))) {
      const target = path.join(project.settingsRoot, ...name.split('/'));
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(path.resolve(__dirname, '../Title/setting', ...name.split('/')), target);
    }
    const titleTemplatePath = path.join(project.settingsRoot, ...config.screens.title.template.split('/'));
    const titleCssPath = path.join(project.settingsRoot, ...config.stylesheet.split('/'));
    await fs.mkdir(path.join(project.assetsRoot, 'ui'), { recursive: true });
    await fs.copyFile(path.resolve(__dirname, '../Title/asset/ui/speaker-plate-romance.png'), path.join(project.assetsRoot, 'ui', 'screen-badge.png'));
    await fs.writeFile(path.join(project.assetsRoot, 'ui', 'padding-probe.png'), solidPng(20, 230, 80));
    await fs.writeFile(path.join(project.assetsRoot, 'ui', 'crop-probe.png'), cropProbePng());
    const titleMarkup = await fs.readFile(titleTemplatePath, 'utf8');
    await fs.writeFile(titleTemplatePath, titleMarkup.replace('</main>', '<input class="control-smoke-slider" type="range" min="0" max="1" step="0.01" data-setting="audio.bgm" data-skin="nativeSmoke" aria-label="BGM"><input class="control-precision-slider" type="range" min="0" max="1" step="0.00000001" data-setting="audio.se" aria-label="Precise SE"><input class="accent-color-probe" type="range" min="0" max="1" step="0.01" data-setting="audio.master" value="1" aria-label="Accent probe"><input class="control-smoke-toggle" type="checkbox" data-setting="audio.bgmMuted" data-skin="nativeToggle" aria-label="Mute BGM"><img id="package-art" src="asset/ui/screen-badge.png" alt="title art"><img id="padding-art" src="asset/ui/padding-probe.png" alt="padding probe"><div id="fit-contain"></div><div id="fit-cover"></div><div id="fit-stretch"></div><div id="hover-underlay"><div id="hover-probe"></div></div><div id="parity-center">W</div><div id="text-top-probe">W</div><div id="text-no-padding-probe">W</div><div id="right-position-parent"><div id="right-position-child"></div></div><div id="bottom-position-parent"><div id="bottom-position-child"></div></div><img id="object-fit-contain-probe" src="asset/ui/crop-probe.png" alt=""><img id="object-fit-cover-probe" src="asset/ui/crop-probe.png" alt=""><img id="object-fit-fill-probe" src="asset/ui/crop-probe.png" alt=""><div id="flex-grow-probe"><div id="flex-grow-red"></div><div id="flex-grow-green"></div></div><div id="flex-cross-axis-probe"><div id="flex-cross-red"></div><div id="flex-cross-green"></div></div><div id="wide-border-probe"></div><div id="z-parent"><div id="z-nested"></div></div><div id="z-sibling"></div><div id="opacity-backdrop"></div><div id="opacity-group"><div id="opacity-green"></div><div id="opacity-red"></div></div><div id="grid-overflow"><span id="grid-red"></span><span id="grid-green"></span><span id="grid-yellow"></span><span id="grid-cyan"></span><span id="grid-blue"></span></div><div id="flex-overflow-probe"><span id="flex-overflow-red"></span><span id="flex-overflow-green"></span></div><div id="flex-overflow-end"><span id="flex-end-red"></span><span id="flex-end-green"></span></div><div id="flex-overflow-between"><span id="flex-between-red"></span><span id="flex-between-green"></span></div><div id="flex-overflow-around"><span id="flex-around-red"></span><span id="flex-around-green"></span></div><div id="flex-overflow-evenly"><span id="flex-evenly-red"></span><span id="flex-evenly-green"></span></div><div id="grid-gap-probe"><i id="grid-gap-red"></i><i id="grid-gap-green"></i><i id="grid-gap-blue"></i></div><div id="grid-intrinsic-probe"><i class="grid-intrinsic-cell"></i><i class="grid-intrinsic-cell"></i><i class="grid-intrinsic-cell"></i><i class="grid-intrinsic-cell"></i></div><div id="auto-grid-probe"><i id="auto-grid-tall-a" class="auto-grid-cell"></i><i id="auto-grid-tall-b" class="auto-grid-cell"></i><i id="auto-grid-short-a" class="auto-grid-cell"></i><i id="auto-grid-short-b" class="auto-grid-cell"></i></div><div id="grid-flex-auto-probe"><div id="grid-flex-auto-child"><i></i><i></i></div><div id="grid-flex-auto-next"></div></div></main>'), 'utf8');
    const screenMarkup = await fs.readFile(titleTemplatePath, 'utf8');
    await fs.writeFile(titleTemplatePath, screenMarkup.replace('</main>', '<div id="line-height-percent-parent"><div id="line-height-percent-probe">First<br>Second</div></div><div id="line-height-unitless-parent"><div id="line-height-unitless-probe">First<br>Second</div></div><div id="line-height-zero-probe">First<br>Second</div></main>'), 'utf8');
    await fs.writeFile(titleTemplatePath, (await fs.readFile(titleTemplatePath, 'utf8')).replace('</main>', '<div id="cover-crop"></div></main>'), 'utf8');
    await fs.appendFile(titleCssPath, '\n#cover-crop{position:absolute;left:1120px;top:80px;width:40px;height:40px;background-color:#000000;background-image:url(asset/ui/crop-probe.png);background-size:cover;z-index:20}\n', 'utf8');
    await fs.appendFile(titleCssPath, '#grid-overflow{z-index:99}', 'utf8');
    await fs.appendFile(titleCssPath, '\n#line-height-percent-parent{position:absolute;left:800px;top:660px;width:90px;height:80px;background-color:#010203;color:#fefefe;font-size:20px;line-height:150%;z-index:100}#line-height-percent-probe{font-size:10px}#line-height-unitless-parent{position:absolute;left:900px;top:660px;width:90px;height:80px;background-color:#010203;color:#fefefe;font-size:20px;line-height:2;z-index:100}#line-height-unitless-probe{font-size:10px}#line-height-zero-probe{position:absolute;left:800px;top:760px;width:90px;height:40px;background-color:#010203;color:#fefefe;font-size:20px;line-height:0;z-index:100}\n', 'utf8');

    await fs.appendFile(titleCssPath, '\n#flex-cross-axis-probe{position:absolute;left:900px;top:60px;width:100px;height:100px;display:flex;flex-direction:column;align-items:flex-end;justify-content:space-between;gap:10px;z-index:10}#flex-cross-red{width:120px;height:20px;flex-grow:1;background-color:#ff0000}#flex-cross-green{width:20px;height:10px;background-color:#00ff00}\n', 'utf8');
    await fs.appendFile(titleCssPath, '\n#flex-grow-probe{position:absolute;left:1100px;top:220px;width:300px;height:40px;display:flex;z-index:10}#flex-grow-red{width:50px;height:40px;flex-grow:1;background-color:#ff0000}#flex-grow-green{width:100px;height:40px;flex-grow:1;background-color:#00ff00}\n', 'utf8');
    await fs.appendFile(titleCssPath, '\n#wide-border-probe{position:absolute;left:1100px;top:280px;width:80px;height:50px;background-color:#ff0000;border:30px solid #0000ff;z-index:10}\n', 'utf8');
    await fs.appendFile(titleCssPath, '\n#z-parent{position:absolute;left:1100px;top:340px;width:80px;height:50px}#z-nested{position:absolute;left:0;top:0;width:80px;height:50px;background-color:#ff0000;z-index:99}#z-sibling{position:absolute;left:1100px;top:340px;width:80px;height:50px;background-color:#0000ff;z-index:1}\n', 'utf8');
    await fs.appendFile(titleCssPath, '\n#opacity-backdrop{position:absolute;left:1100px;top:400px;width:100px;height:60px;background-color:#000000;z-index:999}#opacity-group{position:absolute;left:1100px;top:400px;width:100px;height:60px;opacity:0.5;z-index:1000}#opacity-green{position:absolute;left:0;top:0;width:100px;height:60px;background-color:#00ff00}#opacity-red{position:absolute;left:0;top:0;width:50px;height:60px;background-color:#ff0000}\n', 'utf8');
    await fs.appendFile(titleCssPath, '\n#hover-underlay{position:absolute;left:650px;top:140px;width:100px;height:40px;background-color:#000000}#hover-probe{position:absolute;left:0;top:0;width:100px;height:40px;background-color:#ff0000;opacity:0.5}#hover-probe:hover{opacity:1}\n', 'utf8');
    await fs.appendFile(titleCssPath, '\n#grid-overflow{position:absolute;left:1100px;top:470px;width:100px;height:30px;display:grid;grid-template-columns:40px 1fr;grid-auto-rows:20px;column-gap:5px;row-gap:7px;z-index:99}#grid-red{background-color:#ff0000}#grid-green{background-color:#00ff00}#grid-yellow{background-color:#ffff00}#grid-cyan{background-color:#00ffff}#grid-blue{background-color:#0000ff}\n', 'utf8');
    await fs.appendFile(titleCssPath, '\n#flex-overflow-probe{position:absolute;left:900px;top:500px;width:100px;height:20px;display:flex;justify-content:center;z-index:50}#flex-overflow-end,#flex-overflow-between,#flex-overflow-around,#flex-overflow-evenly{position:absolute;left:800px;width:100px;height:20px;display:flex;z-index:50}#flex-overflow-end{top:525px;justify-content:flex-end}#flex-overflow-between{top:550px;justify-content:space-between}#flex-overflow-around{top:575px;justify-content:space-around}#flex-overflow-evenly{top:600px;justify-content:space-evenly}#flex-overflow-red,#flex-overflow-green,#flex-end-red,#flex-end-green,#flex-between-red,#flex-between-green,#flex-around-red,#flex-around-green,#flex-evenly-red,#flex-evenly-green{width:80px;height:20px}#flex-overflow-red,#flex-end-red,#flex-between-red,#flex-around-red,#flex-evenly-red{background-color:#ff0000}#flex-overflow-green,#flex-end-green,#flex-between-green,#flex-around-green,#flex-evenly-green{background-color:#00ff00}\n', 'utf8');
    await fs.appendFile(titleCssPath, '\n#grid-gap-probe{position:absolute;left:900px;top:540px;width:100px;height:60px;display:grid;grid-template-columns:20px 20px;grid-auto-rows:20px;gap:10px 20px;column-gap:30px;row-gap:5px;z-index:50}#grid-gap-red{background-color:#ff0000}#grid-gap-green{background-color:#00ff00}#grid-gap-blue{background-color:#0000ff}\n', 'utf8');
    await fs.appendFile(titleCssPath, '\n#padding-art{position:absolute;left:650px;top:20px;width:100px;height:40px;padding:5px 10px 5px 20px;z-index:10}\n', 'utf8');
    await fs.appendFile(titleCssPath, '\n.control-smoke-slider{position:absolute;left:820px;top:110px;width:280px;height:24px}.control-smoke-toggle{position:absolute;left:820px;top:150px;width:24px;height:24px}.control-precision-slider{position:absolute;left:820px;top:180px;width:280px;height:24px}\n', 'utf8');
    await fs.appendFile(titleCssPath, '\n#auto-grid-probe{position:absolute;left:1020px;top:540px;width:100px;height:100px;display:grid;grid-template-columns:20px 20px;row-gap:5px;background-color:#ffff00;z-index:50}.auto-grid-cell{width:20px;height:20px}#auto-grid-tall-a,#auto-grid-tall-b{height:30px;background-color:#ff0000}#auto-grid-short-a,#auto-grid-short-b{height:10px;background-color:#0000ff}\n#grid-intrinsic-probe{position:absolute;left:900px;top:600px;width:100px;display:grid;grid-template-columns:20px 20px;grid-auto-rows:20px;row-gap:5px;background-color:#ffff00;z-index:50}.grid-intrinsic-cell{width:20px;height:20px}\n', 'utf8');
    await fs.appendFile(titleCssPath, '\n#grid-flex-auto-probe{position:absolute;left:1000px;top:530px;width:250px;height:40px;display:flex;z-index:200}#grid-flex-auto-child{display:grid;grid-template-columns:100px 100px;column-gap:5px;height:30px;background-color:#ff0000}#grid-flex-auto-next{width:20px;height:30px;background-color:#00ff00}\n', 'utf8');
    await fs.appendFile(titleCssPath, '\n#text-no-padding-probe{position:absolute;left:1000px;top:700px;width:300px;height:60px;background-color:#010203;color:#fefefe;font-size:32px;z-index:10}.accent-color-probe{position:absolute;left:1200px;top:400px;width:200px;height:24px;accent-color:#ff00ff}\n', 'utf8');
    await fs.appendFile(titleCssPath, '\n#parity-center{position:absolute;left:1000px;top:585px;width:300px;height:50px;text-align:center;padding-left:30px;padding-right:0;background-color:#010203;color:#fefefe;font-size:32px;z-index:5}\n', 'utf8');
    await fs.appendFile(titleCssPath, '\n#fit-contain,#fit-cover,#fit-stretch{position:absolute;top:100px;width:100px;height:60px;background-color:#000000;background-image:url(asset/ui/padding-probe.png);z-index:100}#fit-contain{left:650px;background-size:contain}#fit-cover{left:750px;background-size:cover}#fit-stretch{left:850px;background-size:100% 100%}\n', 'utf8');
    await fs.appendFile(titleCssPath, '\n#right-position-parent{position:absolute;left:1250px;top:120px;width:150px;height:40px}#right-position-child{position:absolute;right:13px;top:7px;width:21px;height:20px;background-color:#00ff00}\n', 'utf8');
    await fs.appendFile(titleCssPath, '\n#bottom-position-parent{position:absolute;left:1230px;top:300px;width:70px;height:30px}#bottom-position-child{position:absolute;left:5px;bottom:6px;width:13px;height:8px;background-color:#0000ff}\n', 'utf8');
    await fs.appendFile(titleCssPath, '\n#object-fit-contain-probe,#object-fit-cover-probe,#object-fit-fill-probe{position:absolute;top:600px;width:60px;height:60px;background-color:#000000;z-index:10}#object-fit-contain-probe{left:1180px;object-fit:contain}#object-fit-cover-probe{left:1250px;object-fit:cover}#object-fit-fill-probe{left:1320px;object-fit:fill}\n', 'utf8');
    const justifyCoverage = ['start', 'flex-start', 'end', 'flex-end', 'center', 'space-between', 'space-around', 'space-evenly'];
    const alignCoverage = ['stretch', 'start', 'flex-start', 'end', 'flex-end', 'center'];
    const justifyNodes = justifyCoverage.map((_, index) => `<div class="alignment-justify j${index}"><i class="alignment-red"></i><i class="alignment-green"></i></div>`).join('');
    const alignNodes = alignCoverage.map((_, index) => `<div class="alignment-align alignment-coverage-box-${index}"><i class="alignment-child alignment-coverage-child-${index}"></i></div>`).join('');
    await fs.writeFile(titleTemplatePath, (await fs.readFile(titleTemplatePath, 'utf8')).replace('</main>', `${justifyNodes}${alignNodes}</main>`), 'utf8');
    const justifyRules = justifyCoverage.map((value, index) => `.j${index}{top:${700 + index * 11}px;justify-content:${value}}`).join('');
    const alignRules = alignCoverage.map((value, index) => `.alignment-coverage-box-${index}{left:${200 + index * 32}px;align-items:${value}}${value === 'stretch' ? '' : `.alignment-coverage-child-${index}{height:10px}`}`).join('');
    await fs.appendFile(titleCssPath, `\n.alignment-justify{position:absolute;left:20px;width:100px;height:10px;display:flex;gap:10px;z-index:80}.alignment-red,.alignment-green{width:10px;height:8px}.alignment-red,.alignment-child{background-color:#ff0000}.alignment-green{background-color:#00ff00}${justifyRules}.alignment-align{position:absolute;top:700px;width:20px;height:60px;display:flex;flex-direction:row;z-index:80}.alignment-child{width:10px}${alignRules}\n`, 'utf8');
    const packagePath = path.join(project.buildRoot, 'main.nsp.json');
    const packaged = await pack(path.join(project.scenesRoot, 'main.tds'), packagePath, { projectRoot: project.projectRoot });
    assert.equal(packaged.native_ui.game_screens, 'ui/game-screens.json');
    const packagedScreens = JSON.parse(await fs.readFile(path.join(path.dirname(packagePath), 'asset', 'ui', 'game-screens.json'), 'utf8'));
    assert.deepEqual(packagedScreens.canvas, { width: 1440, height: 810 }, 'native package receives display dimensions resolved from the shared UI settings');
    assert.equal(packagedScreens.scaleMode, 'contain', 'native package preserves the reference-canvas scaling policy');
    assert.ok(packagedScreens.screens.title.uiTree?.length, 'HTML/CSS is compiled to the renderer-neutral layout tree');
    const lineHeightProbe = (() => { const find = nodes => { for (const node of nodes || []) { if (node.attrs?.id === 'line-height-percent-probe') return node; const child = find(node.children); if (child) return child; } return null; }; return find(packagedScreens.screens.title.uiTree); })();
    assert.equal(lineHeightProbe?.text, 'First\nSecond', 'Native package keeps explicit line breaks in screen text');
    assert.equal(lineHeightProbe?.style?.['line-height'], '30px', 'Native package receives the computed inherited percentage line-height');
    const parityNode = (() => { const find = nodes => { for (const node of nodes || []) { if (node.attrs?.id === 'parity-center') return node; const child = find(node.children); if (child) return child; } return null; }; return find(packagedScreens.screens.title.uiTree); })();
    assert.equal(parityNode?.style?.['text-align'], 'center');
    assert.equal(parityNode?.style?.['padding-left'], '30px');
    assert.equal(parityNode?.style?.['padding-right'], '0');
    const flexCrossNode = (() => { const find = nodes => { for (const node of nodes || []) { if (node.attrs?.id === 'flex-cross-red') return node; const child = find(node.children); if (child) return child; } return null; }; return find(packagedScreens.screens.title.uiTree); })();
    assert.deepEqual({ x: flexCrossNode?.rect.x, y: flexCrossNode?.rect.y, width: flexCrossNode?.rect.width, height: flexCrossNode?.rect.height }, { x: 880, y: 60, width: 120, height: 80 }, 'shared column flex geometry keeps the full oversized cross-axis item while distributing grow space and gap');
    const stretchAlignNode = (() => { const find = nodes => { for (const node of nodes || []) { if ((node.attrs?.class || '').split(/\s+/).includes('alignment-coverage-child-0')) return node; const child = find(node.children); if (child) return child; } return null; }; return find(packagedScreens.screens.title.uiTree); })();
    assert.deepEqual(stretchAlignNode?.rect, { x: 200, y: 700, width: 10, height: 60 }, 'align-items:stretch expands the Native parity child to the cross-axis size');
    const intrinsicGridNode = (() => { const find = nodes => { for (const node of nodes || []) { if (node.attrs?.id === 'grid-intrinsic-probe') return node; const child = find(node.children); if (child) return child; } return null; }; return find(packagedScreens.screens.title.uiTree); })();
    const gridFlexAutoNode = (() => { const find = nodes => { for (const node of nodes || []) { if (node.attrs?.id === 'grid-flex-auto-child') return node; const child = find(node.children); if (child) return child; } return null; }; return find(packagedScreens.screens.title.uiTree); })();
    const gridFlexAutoNext = (() => { const find = nodes => { for (const node of nodes || []) { if (node.attrs?.id === 'grid-flex-auto-next') return node; const child = find(node.children); if (child) return child; } return null; }; return find(packagedScreens.screens.title.uiTree); })();
    assert.equal(gridFlexAutoNode?.rect?.width, 205, 'Native package gives an auto-sized Grid its fixed track widths and gap');
    assert.equal(gridFlexAutoNext?.rect?.x, 1205, 'Native package places the next Flex item after the Grid tracks');
    assert.equal(intrinsicGridNode?.rect.height, 45, 'Native package grid intrinsic height includes two rows and the authored row gap');
    const autoGridNode = (() => { const find = nodes => { for (const node of nodes || []) { if (node.attrs?.id === 'auto-grid-probe') return node; const child = find(node.children); if (child) return child; } return null; }; return find(packagedScreens.screens.title.uiTree); })();
    assert.equal(autoGridNode?.children?.[0]?.rect.height, 30, 'Native first auto row retains its 30px intrinsic item contribution');
    assert.equal(autoGridNode?.children?.[2]?.rect.y, 602.5, 'Native second auto row starts after the first row is stretched from its larger intrinsic contribution');
    assert.equal(packagedScreens.controlDefaults['audio.voice'], 0.5, 'native package receives the validated shared control defaults');
    assert.equal(packagedScreens.controlDefaults['audio.voice.ayaka'], 1, 'native package receives character-specific voice defaults');
    assert.equal(packagedScreens.controlDefaults['audio.voice.ayaka.muted'], false, 'native package receives per-character mute defaults');
    assert.equal(packagedScreens.controlDefaults['ui.shortcut.F1'], 'system', 'function-key bindings are delivered as shared player settings');
    assert.equal(packagedScreens.controlDefaults['ui.shortcut.F12'], 'none', 'all twelve keys have an explicit safe default');
    assert.equal(packagedScreens.controlDefaults['ui.fontFamily'], 'default', 'font preference uses an explicit shared safe default');
    const settingsTree = packagedScreens.screens.system.uiTree;
    const settingsControlKeys = [];
    const settingsShortcutRows = [];
    const collectSettingsControls = nodes => { for (const node of nodes || []) { if (node.tag === 'input') settingsControlKeys.push(node.attrs['data-setting']); if ((node.attrs?.class || '').split(/\s+/).includes('shortcut-row')) settingsShortcutRows.push(node); collectSettingsControls(node.children); } };
    collectSettingsControls(settingsTree);
    assert.deepEqual(settingsControlKeys.sort(), ['ui.autoSpeed', 'ui.cursorHideDelay', 'ui.textSpeed'].sort(), 'continuous playback preferences are serialized as shared Native range controls');
    assert.equal(packagedScreens.screens.system.items.filter(item => item.action === 'setting-value').length, 13, 'binary settings and the three font choices compile into actionable Native UI items');
    assert.ok(packagedScreens.screens.system.items.some(item => item.action === 'reset-window-size'), 'the window-size reset is a real cross-runtime screen action');
    assert.equal(settingsShortcutRows.length, 12, 'the two-column shortcut panel is included in the Native screen tree');
    const shortcutButtons = [];
    const collectShortcutButtons = nodes => { for (const node of nodes || []) { if (node.attrs?.['data-action'] === 'shortcut-cycle') shortcutButtons.push(node); collectShortcutButtons(node.children); } };
    collectShortcutButtons(settingsTree);
    assert.equal(shortcutButtons.length, 12, 'each binding is an actionable shared UI control rather than a static label');
    const soundTree = packagedScreens.screens.sound.uiTree;
    const controlKeys = [];
    const collectControls = nodes => { for (const node of nodes || []) { if (node.tag === 'input') controlKeys.push(node.attrs['data-setting']); collectControls(node.children); } };
    collectControls(soundTree);
    assert.ok(controlKeys.includes('audio.bgm') && controlKeys.includes('audio.bgmMuted') && controlKeys.includes('ui.dialogOpacity'), 'the same declarative sliders and toggles reach the Native renderer');
    assert.ok(packagedScreens.screens.title.items.some(item => item.action === 'start'), 'compiled click targets survive native packaging');
    const historyNode = (() => { const visit = nodes => { for (const node of nodes || []) { if (node.attrs?.['data-role'] === 'dialogue-history') return node; const child = visit(node.children); if (child) return child; } return null; }; return visit(packagedScreens.screens.log.uiTree); })();
    assert.ok(historyNode, 'LOG uses the shared renderer-neutral dialogue-history role');
    assert.ok(packagedScreens.screens.pause.items.some(item => item.action === 'hold'), 'HOLD is compiled as a native-operable pause action');
    const pauseIconSources = [];
    const collectPauseIcons = nodes => { for (const node of nodes || []) { if (node.tag === 'img' && (node.attrs?.['class'] || '').split(/\s+/).includes('pause-icon')) pauseIconSources.push(node.attrs.src); collectPauseIcons(node.children); } };
    collectPauseIcons(packagedScreens.screens.pause.uiTree);
    assert.equal(pauseIconSources.length, 14, 'Native receives all fourteen image-based pause menu operation icons');
    for (const source of pauseIconSources) assert.ok((await fs.stat(path.join(path.dirname(packagePath), 'asset', source))).size > 1000, `Native package includes pause icon ${source}`);
    assert.ok(JSON.stringify(packagedScreens.screens.title.uiTree).includes('buttons/sakura-menu-plate.png'), 'the generated title button art is part of the shared Native screen tree');
    assert.ok(JSON.stringify(packagedScreens.screens.title.uiTree).includes('buttons/sakura-menu-plate-hover-v2.png'), 'the clearly illuminated selected-state artwork is compiled into the shared Native screen tree');
    assert.ok(JSON.stringify(packagedScreens.screens.title.uiTree).includes('ui/logos/spring-late-love-title-v2.png'), 'the generated Japanese title logo is part of the common Native title tree');
    await fs.access(path.join(path.dirname(packagePath), 'asset', 'ui', 'backgrounds', 'spring-ensemble-key-visual.jpg'));
    await fs.access(path.join(path.dirname(packagePath), 'asset', 'ui', 'buttons', 'sakura-menu-plate.png'));
    await fs.access(path.join(path.dirname(packagePath), 'asset', 'ui', 'buttons', 'sakura-menu-plate-hover-v2.png'));
    await fs.access(path.join(path.dirname(packagePath), 'asset', 'ui', 'logos', 'spring-late-love-title-v2.png'));
    for (const name of ['save', 'load', 'system', 'sound', 'favorite', 'tips']) await fs.access(path.join(path.dirname(packagePath), 'asset', 'ui', 'icons', `${name}.png`));
    assert.ok(JSON.stringify(packagedScreens.screens.title.uiTree).includes('ui/screen-badge.png'), 'asset-relative HTML images are retained in the shared tree');
    const card = packagedScreens.screens.save.uiTree[0].children.find(node => node.attrs?.['data-role'] === 'save-slots')?.children[0];
    assert.equal(card?.children.find(node => node.attrs?.['data-slot-field'] === 'number')?.attrs['data-slot-field'], 'number', 'Native package retains slot-card field bindings');
    assert.equal(card?.slotStateStyles?.corrupt?.['background-color'], '#f7ece7', 'Native receives the common corrupt-slot style table');
    assert.equal(card?.slotStateStyles?.incompatible?.['border-color'], '#aa956b', 'Native receives the common incompatible-slot style table');
    for (const state of ['empty', 'ready', 'corrupt', 'incompatible']) assert.equal(card?.slotStateStyles?.[state]?.opacity, '1', `Native keeps ${state} slot information cards fully opaque`);
    await fs.access(path.join(path.dirname(packagePath), 'asset', 'ui', 'screen-badge.png'));
    await fs.access(path.join(path.dirname(packagePath), 'asset', 'ui', 'dialogue-panel-romance.png'));
    await fs.access(path.join(path.dirname(packagePath), 'asset', 'ui', 'controls', 'audio', 'volume', 'thumb-hover.png'));
    await fs.access(path.join(path.dirname(packagePath), 'asset', 'ui', 'controls', 'audio', 'volume', 'mute-off-hover.png'));
    await fs.access(path.join(path.dirname(packagePath), 'asset', 'ui', 'choice-romance.png'));
    await fs.access(path.join(path.dirname(packagePath), 'asset', 'ui', 'speaker-plate-romance.png'));
    for (const name of ['choice-romance.png', 'speaker-plate-romance.png', 'dialogue-panel-romance.png']) await fs.access(path.join(path.dirname(packagePath), 'asset', 'ui', name));
    const findSkinnedControl = nodes => {
      for (const node of nodes || []) {
        if (node.attrs?.['data-skin'] === 'nativeSmoke') return node;
        const nested = findSkinnedControl(node.children);
        if (nested) return nested;
      }
      return null;
    };
    const titleSmokeControl = findSkinnedControl(packagedScreens.screens.title.uiTree);
    assert.equal(titleSmokeControl?.controlSkin?.type, 'range', 'Native screen tree includes its validated image skin');
    assert.equal(titleSmokeControl?.controlSkin?.thumbWidth, 28);
    const titleSmokeToggle = (() => {
      const find = nodes => { for (const node of nodes || []) { if (node.attrs?.['data-skin'] === 'nativeToggle') return node; const child = find(node.children); if (child) return child; } return null; };
      return find(packagedScreens.screens.title.uiTree);
    })();
    assert.equal(titleSmokeToggle?.controlSkin?.type, 'checkbox', 'Native screen tree includes the matching image checkbox skin');
    const exe = process.env.NOVEL_NATIVE_EXE || path.resolve(__dirname, '../native/build/Release/novel_player.exe');
    const smoke = spawnSync(exe, [packagePath, '--screen-smoke'], {
      encoding: 'utf8', timeout: 15000,
      env: { ...process.env, SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy' },
    });
    assert.equal(smoke.status, 0, smoke.stderr || smoke.error?.message);
    const saveSmoke = spawnSync(exe, [packagePath, '--screen-save-smoke'], {
      encoding: 'utf8', timeout: 15000,
      env: { ...process.env, NOVEL_SAVE_ROOT: path.join(tempRoot, 'capture-saves'), SDL_AUDIODRIVER: 'dummy', SDL_VIDEODRIVER: 'dummy' },
    });
    assert.equal(saveSmoke.status, 0, saveSmoke.stderr || saveSmoke.error?.message || saveSmoke.stdout);
    assert.deepEqual(JSON.parse(saveSmoke.stdout.trim()), { save: true, thumbnail: true, fullFrame: true, text: 'revised' });
    const captureDirectory = path.join(tempRoot, 'native-screen-captures');
    const renderSmoke = spawnSync(exe, [packagePath, '--screen-render-smoke'], {
      encoding: 'utf8', timeout: 15000,
      env: { ...process.env, NOVEL_SCREEN_CAPTURE_DIR: captureDirectory, NOVEL_SAVE_ROOT: path.join(tempRoot, 'native-render-saves'), SDL_AUDIODRIVER: 'dummy', SDL_VIDEODRIVER: 'dummy' },
    });
    assert.equal(renderSmoke.status, 0, renderSmoke.stderr || renderSmoke.error?.message || renderSmoke.stdout);
    const renderedScreens = JSON.parse(renderSmoke.stdout.trim());
    assert.ok(renderedScreens.count >= 5, 'Native captures every authored screen as rendered pixels');
    assert.ok(renderedScreens.captured.includes('title-hover'), 'Native moves the real SDL pointer over GAME START and renders its hover state');
    assert.ok(renderedScreens.captured.includes('pause'), 'Native captures the image-based game menu as rendered pixels');
    for (const screen of renderedScreens.captured) {
      const image = await fs.readFile(path.join(captureDirectory, `${screen}.png`));
      assert.ok(image.length > 2048 && image.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])), `Native ${screen} is a PNG screen capture`);
    }
    const titleCapture = decodePng(await fs.readFile(path.join(captureDirectory, 'title.png')));
    assert.equal(titleCapture.width, renderedScreens.width); assert.equal(titleCapture.height, renderedScreens.height);
    const sx = titleCapture.width / packagedScreens.canvas.width, sy = titleCapture.height / packagedScreens.canvas.height;
    const bounds = brightPixelBounds(titleCapture, { x: Math.floor((1000 + 30 + 135 - 60) * sx), y: Math.floor(585 * sy), width: Math.ceil(120 * sx), height: Math.ceil(50 * sy) });
    assert.ok(Number.isFinite(bounds.left), `Native alignment fixture rendered bright text inside the expected region: ${JSON.stringify(bounds)}`);
    const nativeTextCenter = (bounds.left + bounds.right) / 2;
    const contentBoxCenter = (1000 + 30 + (300 - 30) / 2) * sx;
    assert.ok(Math.abs(nativeTextCenter - contentBoxCenter) <= 6, `Native centered text pixel bounds match the asymmetric-padding content box: text=${nativeTextCenter}, content=${contentBoxCenter}, bounds=${JSON.stringify(bounds)}`);
    const topAligned = brightPixelBounds(titleCapture, { x: Math.floor(1008 * sx), y: Math.floor(650 * sy), width: Math.ceil(300 * sx), height: Math.ceil(120 * sy) });
    assert.ok(Number.isFinite(topAligned.top), `Native top-alignment fixture rendered text: ${JSON.stringify(topAligned)}`);
    assert.ok(topAligned.top - 650 * sy < 22, `Native ordinary block text begins at its padded top edge like Browser CSS: ${JSON.stringify({ topAligned, sy, canvas: packagedScreens.canvas, capture: { width: titleCapture.width, height: titleCapture.height } })}`);
    const noPaddingText = brightPixelBounds(titleCapture, { x: Math.floor(1000 * sx), y: Math.floor(700 * sy), width: Math.ceil(300 * sx), height: Math.ceil(60 * sy) });
    assert.ok(Number.isFinite(noPaddingText.left), `Native renders the unpadded text fixture: ${JSON.stringify(noPaddingText)}`);
    assert.ok(noPaddingText.left - 1000 * sx <= 3, `Native text without authored padding starts at the zero-padding content edge like Browser CSS: ${JSON.stringify({ noPaddingText, sx })}`);
    const pixelAt = (logicalX, logicalY) => {
      const x = Math.floor(logicalX * sx), y = Math.floor(logicalY * sy), at = (y * titleCapture.width + x) * titleCapture.channels;
      return [...titleCapture.pixels.subarray(at, at + 3)];
    };
    const lineStartsAt = (logicalX, logicalY, logicalWidth, logicalHeight) => {
      const rows = [];
      for (let y = Math.floor(logicalY * sy); y < Math.floor((logicalY + logicalHeight) * sy); y++) {
        let bright = false;
        for (let x = Math.floor(logicalX * sx); x < Math.floor((logicalX + logicalWidth) * sx); x++) {
          const at = (y * titleCapture.width + x) * titleCapture.channels;
          if (titleCapture.pixels[at] > 180 && titleCapture.pixels[at + 1] > 180 && titleCapture.pixels[at + 2] > 180) { bright = true; break; }
        }
        if (bright) rows.push(y);
      }
      return rows.filter((row, index) => index === 0 || row - rows[index - 1] > 2);
    };
    const percentLineStarts = lineStartsAt(800, 660, 90, 80);
    assert.equal(percentLineStarts.length, 2, `Native draws both lines with inherited percentage line-height: ${JSON.stringify(percentLineStarts)}`);
    assert.ok(Math.abs((percentLineStarts[1] - percentLineStarts[0]) - 30 * sy) <= 4 * sy, `Native resolves parent 150% line-height against its 20px font before a child overrides font-size to 10px: ${JSON.stringify({ percentLineStarts, sy })}`);
    const unitlessLineStarts = lineStartsAt(900, 660, 90, 80);
    assert.equal(unitlessLineStarts.length, 2, `Native draws both lines with inherited unitless line-height: ${JSON.stringify(unitlessLineStarts)}`);
    assert.ok(Math.abs((unitlessLineStarts[1] - unitlessLineStarts[0]) - 20 * sy) <= 4 * sy, `Native unitless line-height remains a multiplier for the child font-size: ${JSON.stringify({ unitlessLineStarts, sy })}`);
    assert.equal(lineStartsAt(800, 760, 90, 40).length, 1, 'Native applies explicit line-height:0 by overlapping the two rendered lines');
    const assertPixelNear = (actual, expected, message) => assert.ok(actual.every((channel, index) => Math.abs(channel - expected[index]) <= 10), `${message}: ${JSON.stringify(actual)}`);
    assert.deepEqual(pixelAt(655, 100), [0, 0, 0], 'Native background-size:contain keeps letterbox pixels at the box background color');
    assert.deepEqual(pixelAt(700, 100), [20, 230, 80], 'Native background-size:contain paints the centered image');
    assert.deepEqual(pixelAt(765, 100), [20, 230, 80], 'Native background-size:cover fills the outer box');
    assert.deepEqual(pixelAt(875, 100), [20, 230, 80], 'Native background-size:100% 100% stretches to the outer box');
    assert.deepEqual(pixelAt(1125, 100), [0, 255, 0], 'Native background-size:cover crops the left red source edge');
    assert.deepEqual(pixelAt(1155, 100), [0, 255, 0], 'Native background-size:cover crops the right blue source edge');
    assert.deepEqual(pixelAt(1200, 240), [255, 0, 0], 'Native flex-grow expands the first child from its 50px basis to the shared 125px rect');
    assert.deepEqual(pixelAt(1230, 240), [0, 255, 0], 'Native flex-grow starts the second child at the shared 125px boundary');
    assert.deepEqual(pixelAt(1210, 540), [0, 255, 0], 'Native SDL renders the following Flex item after the auto-sized Grid track area');
    assert.deepEqual(pixelAt(990, 70), [255, 0, 0], 'Native paints the full cross-axis width of a grown item aligned to flex-end');
    for (const [index, x] of [24, 24, 94, 94, 59, 24, 41, 47].entries()) assert.deepEqual(pixelAt(x, 705 + index * 11), [255, 0, 0], `Native pixel confirms justify-content:${justifyCoverage[index]} first-child placement`);
    for (const [index, y] of [730, 705, 705, 755, 755, 730].entries()) assert.deepEqual(pixelAt(204 + index * 32, y), [255, 0, 0], `Native pixel confirms align-items:${alignCoverage[index]} child placement`);
    assert.deepEqual(pixelAt(1125, 300), [0, 0, 255], 'Native paints the scaled 30px border beyond the prior 12px renderer cap');
    assert.deepEqual(pixelAt(1370, 130), [0, 255, 0], 'Native draws the absolute child at parent right edge minus right offset and child width');
    assert.deepEqual(pixelAt(1236, 317), [0, 0, 255], 'Native draws the absolute child at parent bottom edge minus bottom offset and child height');
    assertPixelNear(pixelAt(1220, 411), [255, 0, 255], 'Native unskinned range fill uses the declared accent-color magenta');
    assertPixelNear(pixelAt(1210, 602), [0, 0, 0], 'Native object-fit:contain leaves the top letterbox at the image background color');
    assertPixelNear(pixelAt(1185, 630), [255, 0, 0], 'Native object-fit:contain preserves the left red stripe of the 3:1 source');
    assertPixelNear(pixelAt(1210, 630), [0, 255, 0], 'Native object-fit:contain centers the middle green stripe');
    assertPixelNear(pixelAt(1235, 630), [0, 0, 255], 'Native object-fit:contain preserves the right blue stripe of the 3:1 source');
    assertPixelNear(pixelAt(1210, 658), [0, 0, 0], 'Native object-fit:contain leaves the bottom letterbox at the image background color');
    for (const y of [602, 630, 658]) assertPixelNear(pixelAt(1280, y), [0, 255, 0], `Native object-fit:cover crops both source edges to the center green stripe at y=${y}`);
    for (const y of [602, 658]) {
      assertPixelNear(pixelAt(1325, y), [255, 0, 0], `Native object-fit:fill stretches the red source stripe to y=${y}`);
      assertPixelNear(pixelAt(1350, y), [0, 255, 0], `Native object-fit:fill stretches the green source stripe to y=${y}`);
      assertPixelNear(pixelAt(1375, y), [0, 0, 255], `Native object-fit:fill stretches the blue source stripe to y=${y}`);
    }
    assert.deepEqual(pixelAt(1140, 365), [0, 0, 255], 'Native hierarchical paint order keeps the later z-index sibling above its earlier parent descendant');
    assert.deepEqual(pixelAt(1125, 430), [128, 0, 0], 'Native opacity group composites overlapping children as one CSS element');
    assert.deepEqual(pixelAt(1120, 480), [255, 0, 0], 'Native paints the first grid cell at its shared rect');
    assert.deepEqual(pixelAt(1170, 480), [0, 255, 0], 'Native paints the fractional grid cell at its shared rect');
    assert.deepEqual(pixelAt(1120, 527), [0, 0, 255], 'Native leaves the third implicit grid row visible beyond its container');
    assert.deepEqual(pixelAt(1022, 545), [255, 0, 0], 'Native paints the taller first auto row at its shared track position');
    assert.deepEqual(pixelAt(1022, 604), [0, 0, 255], 'Native paints the shorter second auto row after the stretched first track and row gap');
    assert.deepEqual(pixelAt(910, 510), [255, 0, 0], 'Native center alignment clips the leading overflow at the shared canvas edge');
    assert.deepEqual(pixelAt(960, 510), [0, 255, 0], 'Native paints the second centered item after half of the negative free space');
    assert.deepEqual(pixelAt(745, 535), [255, 0, 0], 'Native flex-end places the first overflowing item before the container start');
    assert.deepEqual(pixelAt(825, 535), [0, 255, 0], 'Native flex-end aligns the overflowing group to the container end');
    for (const y of [560, 585, 610]) { assert.deepEqual(pixelAt(805, y), [255, 0, 0], "Native space-* fallback at y=" + y); assert.deepEqual(pixelAt(885, y), [0, 255, 0], "Native second overflow item at y=" + y); }
    assert.deepEqual(pixelAt(905, 545), [255, 0, 0], 'Native paints the first grid cell with row and column gap shorthand');
    assert.deepEqual(pixelAt(955, 545), [0, 255, 0], 'Native uses the overriding 30px column-gap longhand');
    assert.deepEqual(pixelAt(905, 570), [0, 0, 255], 'Native uses the overriding 5px row-gap longhand');
    assert.deepEqual(pixelAt(905, 622), [255, 255, 0], 'Native paints the auto-height grid background through an implicit row gap');
    assert.deepEqual(pixelAt(1025, 580), [255, 255, 0], 'Native paints the stretched auto-track background below a fixed-size grid item');
    const baseOpacityPixel = pixelAt(675, 160);
    assert.ok(baseOpacityPixel[0] >= 126 && baseOpacityPixel[0] <= 129 && baseOpacityPixel[1] === 0 && baseOpacityPixel[2] === 0, `Native ancestor opacity and background alpha compose to half red: ${JSON.stringify(baseOpacityPixel)}`);
    const probeHoverCapture = decodePng(await fs.readFile(path.join(captureDirectory, 'title-probe-hover.png')));
    const hoverX = Math.floor(675 * sx), hoverY = Math.floor(160 * sy), hoverAt = (hoverY * probeHoverCapture.width + hoverX) * probeHoverCapture.channels;
    const hoverOpacityPixel = [...probeHoverCapture.pixels.subarray(hoverAt, hoverAt + 3)];
    assert.deepEqual(hoverOpacityPixel, [255, 0, 0], `Native :hover on a non-action node applies opacity:1: ${JSON.stringify(hoverOpacityPixel)}`);
    const isProbeGreen = color => color[0] === 20 && color[1] === 230 && color[2] === 80;
    assert.ok(isProbeGreen(pixelAt(675, 30)), `Native image content renders inside the padded content box: ${JSON.stringify(pixelAt(675, 30))}`);
    assert.ok(!isProbeGreen(pixelAt(655, 30)) && !isProbeGreen(pixelAt(745, 30)), `Native image content leaves the authored left and right padding clear: ${JSON.stringify({ left: pixelAt(655, 30), right: pixelAt(745, 30) })}`);
    if (process.env.NOVEL_NATIVE_SCREEN_CAPTURE_DIR) {
      await fs.mkdir(process.env.NOVEL_NATIVE_SCREEN_CAPTURE_DIR, { recursive: true });
      for (const screen of renderedScreens.captured) await fs.copyFile(path.join(captureDirectory, `${screen}.png`), path.join(process.env.NOVEL_NATIVE_SCREEN_CAPTURE_DIR, `${screen}.png`));
    }
    assert.notDeepEqual(await fs.readFile(path.join(captureDirectory, 'title.png')), await fs.readFile(path.join(captureDirectory, 'title-hover.png')), 'Native hover rendering changes the captured title pixels');
    const quickSmoke = spawnSync(exe, [packagePath, '--screen-quick-smoke'], {
      encoding: 'utf8', timeout: 15000,
      env: { ...process.env, NOVEL_SAVE_ROOT: path.join(tempRoot, 'quick-saves'), SDL_AUDIODRIVER: 'dummy', SDL_VIDEODRIVER: 'dummy' },
    });
    assert.equal(quickSmoke.status, 0, quickSmoke.stderr || quickSmoke.error?.message || quickSmoke.stdout);
    assert.deepEqual(JSON.parse(quickSmoke.stdout.trim()), { saved: true, restored: true }, 'Native quick save/load uses its own persistent file, independently of numbered slots');
    const quickReloadSmoke = spawnSync(exe, [packagePath, '--screen-quick-load-smoke'], {
      encoding: 'utf8', timeout: 15000,
      env: { ...process.env, NOVEL_SAVE_ROOT: path.join(tempRoot, 'quick-saves'), SDL_AUDIODRIVER: 'dummy', SDL_VIDEODRIVER: 'dummy' },
    });
    assert.equal(quickReloadSmoke.status, 0, quickReloadSmoke.stderr || quickReloadSmoke.error?.message || quickReloadSmoke.stdout);
    assert.deepEqual(JSON.parse(quickReloadSmoke.stdout.trim()), { loaded: true }, 'Native quick save remains loadable from disk after the writer process exits');
    await fs.mkdir(path.join(project.buildRoot, 'saves'), { recursive: true });
    await fs.writeFile(path.join(project.buildRoot, 'saves', 'slot-1.json'), JSON.stringify({ version: 1, file: 'main.tds', scene: 'main', line: 1, variables: {}, speaker: '語り手', text: '保存した場面', savedAt: Date.now() }));
    await fs.writeFile(path.join(project.buildRoot, 'saves', 'slot-2.json'), JSON.stringify({ version: 1, scene: 'broken', line: 1, variables: {} }));
    await fs.writeFile(path.join(project.buildRoot, 'saves', 'slot-3.json'), JSON.stringify({ version: 1, saveId: 'another-work', file: 'main.tds', scene: 'main', line: 1, variables: {} }));
    await fs.writeFile(path.join(project.buildRoot, 'saves', 'slot-20.json'), JSON.stringify({ version: 2, file: 'main.tds', scene: 'main', line: 1, variables: {} }));
    await fs.writeFile(path.join(project.buildRoot, 'saves', 'slot-21.json'), JSON.stringify({ file: 'main.tds', scene: 'main', line: 1, variables: {} }));
    await fs.writeFile(path.join(project.buildRoot, 'saves', 'slot-13.json'), JSON.stringify({ version: 1, file: 'main.tds', scene: 'main', line: 1, variables: {}, speaker: '13番目', text: '2ページ目' }));
    await fs.copyFile(path.join(path.dirname(packagePath), 'asset', 'ui', 'screen-badge.png'), path.join(project.buildRoot, 'saves', 'thumb-slot-1.png'));
    const slotSmoke = spawnSync(exe, [packagePath, '--screen-slot-smoke'], {
      encoding: 'utf8', timeout: 15000,
      env: { ...process.env, SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy' },
    });
    assert.equal(slotSmoke.status, 0, slotSmoke.stderr || slotSmoke.error?.message);
    const slotResult = JSON.parse(slotSmoke.stdout.trim());
    assert.equal(slotResult.continueAvailable, true);
    assert.match(slotResult.selectedSummaryTimestamp, /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}$/, 'Native selected-slot summary exposes the same saved timestamp as Browser');
    assert.ok(slotResult.selectedSummary.includes(slotResult.selectedSummaryTimestamp), 'the rendered Native selected-slot summary contains its saved timestamp');
    for (const role of ['save-slots', 'load-slots']) {
      assert.equal(slotResult[role].secondState, 'corrupt', `${role} preserves the damaged-slot state for rendering`);
      assert.equal(slotResult[role].thirdState, 'incompatible', `${role} preserves the foreign-project state for rendering`);
      assert.equal(slotResult[role].unsupportedVersionState, 'incompatible', `${role} classifies an unsupported integer snapshot version as incompatible`);
      assert.equal(slotResult[role].missingVersionState, 'corrupt', `${role} classifies a missing snapshot version as corrupt`);
      assert.equal(slotResult[role].secondStateStyle, true, `${role} resolves the corrupt slot style in the shared tree`);
      assert.equal(slotResult[role].thirdStateStyle, true, `${role} resolves the incompatible slot style in the shared tree`);
      delete slotResult[role].secondState;
      delete slotResult[role].secondStateStyle;
      delete slotResult[role].thirdStateStyle;
      delete slotResult[role].unsupportedVersionState;
      delete slotResult[role].missingVersionState;
    }
    assert.deepEqual(slotResult['save-slots'], { count: 12, firstStatus: 'saved', secondStatus: 'empty', thirdStatus: 'empty', firstStatusText: '記録あり', secondStatusText: '破損', thirdStatusText: '非対応', thirdState: 'incompatible' });
    assert.deepEqual(slotResult['load-slots'], { count: 12, firstStatus: 'saved', secondStatus: 'empty', thirdStatus: 'empty', firstStatusText: '記録あり', secondStatusText: '破損', thirdStatusText: '非対応', thirdState: 'incompatible' });
    assert.equal(slotResult.thumbnailDisplayed, true, 'Native save/load templates render each slot thumbnail from the user save directory');
    assert.deepEqual(slotResult.secondPage, { save: 12, load: 12 }, 'Native page buttons bind the second page to save slots 13-24');
    assert.deepEqual(slotResult.operations, { locked: true, unlocked: true, copied: true, moved: true, deleteArmed: true, deleted: true }, 'Native slot management persists locks, previews, copies, moves, and confirms deletion');
    // This control smoke asserts that Continue is unavailable. Clear the slot fixtures created above before it starts.
    for (const name of await fs.readdir(path.join(project.buildRoot, 'saves'))) {
      if (/^slot-\d+\.json$/.test(name)) await fs.rm(path.join(project.buildRoot, 'saves', name), { force: true });
    }
    const controlSaveRoot = path.join(tempRoot, 'control-smoke-saves');
    const controlSmoke = spawnSync(exe, [packagePath, '--screen-control-smoke'], {
      encoding: 'utf8', timeout: 15000,
      env: { ...process.env, NOVEL_SAVE_ROOT: controlSaveRoot, SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy' },
    });
    assert.equal(controlSmoke.status, 0, controlSmoke.stderr || controlSmoke.error?.message);
    const controlResult = JSON.parse(controlSmoke.stdout.trim());
    assert.equal(controlResult.uiSettings['ui.shortcut.F1'], 'save', 'Native stores the remapped key after interacting with the actual screen control');
    assert.equal(controlResult.uiSettings['ui.shortcut.F12'], 'history', 'Native persists the remapped F12 action');
    const preferencesBeforeReset = controlResult.uiSettingsPersistedBeforeReset;
    const preferences = JSON.parse(await fs.readFile(path.join(controlSaveRoot, 'ui-settings.json'), 'utf8'));
    assert.ok(Math.abs(preferencesBeforeReset['audio.bgm'] - 0.75) < 0.03, 'Native range interaction updates the stored value before reset');
    assert.equal(preferencesBeforeReset['audio.bgmMuted'], true, 'Native checkbox interaction persists the toggle before reset');
    assert.ok(Math.abs(preferencesBeforeReset['audio.voice.ayaka'] - 0.6) < 0.02, 'Native per-character voice level persists before reset');
    assert.equal(preferencesBeforeReset['audio.voice.ayaka.muted'], false, 'Native per-character mute preference is restored before reset');
    assert.ok(controlResult.uiSettings['audio.master'] < 0.15, 'Native pause-menu vertical volume click maps its bottom to minimum after reset');
    assert.equal(preferencesBeforeReset['ui.textSpeed'], 0.25, 'Native persists the common dialogue-speed preference before reset');
    assert.equal(preferences['ui.effects'], true, 'Native reset persists the default effects setting');
    assert.equal(preferences['audio.bgm'], 1, 'Native reset persists the default BGM volume');
    assert.equal(preferences['ui.fontFamily'], 'default', 'Native reset persists the default font family');
    const titleBuildRoot = path.resolve(__dirname, '../Title/.novel/build');
    const titlePackage = path.join(titleBuildRoot, 'main.nsp.json');
    const titleScreens = JSON.parse(await fs.readFile(path.join(titleBuildRoot, 'asset/ui/game-screens.json'), 'utf8'));
    const findClass = (nodes, className) => {
      for (const node of nodes || []) {
        if ((node.attrs?.class || '').split(/\s+/).includes(className)) return node;
        const child = findClass(node.children, className);
        if (child) return child;
      }
      return null;
    };
    const voiceCard = findClass(titleScreens.screens.sound.uiTree, 'sound-voice-card');
    const voiceSlider = findClass(voiceCard?.children, 'voice-character-volume');
    const voiceNameplate = findClass(voiceCard?.children, 'sound-character');
    assert.ok(voiceCard && voiceSlider, 'the actual Title project packages portrait cards and an editable per-character slider');
    assert.ok(voiceNameplate && voiceNameplate.rect.y + voiceNameplate.rect.height <= voiceSlider.rect.y
      && voiceNameplate.style['background-color'] === 'rgba(17,25,43,0.70)', 'Native uses the same legible character-name strip above each portrait volume control');
    assert.ok(voiceSlider.rect.x >= voiceCard.rect.x && voiceSlider.rect.x + voiceSlider.rect.width <= voiceCard.rect.x + voiceCard.rect.width
      && voiceSlider.rect.y >= voiceCard.rect.y && voiceSlider.rect.y + voiceSlider.rect.height <= voiceCard.rect.y + voiceCard.rect.height,
    'the actual packaged SDL layout keeps each character volume control inside its portrait card');
    await fs.access(path.join(titleBuildRoot, 'asset/ui/portraits/ayaka-volume.png'));
    const titleCaptureRoot = path.join(tempRoot, 'actual-title-render');
    const titleRenderSmoke = spawnSync(exe, [titlePackage, '--screen-render-smoke'], {
      encoding: 'utf8', timeout: 15000,
      env: { ...process.env, NOVEL_SCREEN_CAPTURE_DIR: titleCaptureRoot, NOVEL_SAVE_ROOT: path.join(tempRoot, 'actual-title-render-saves'), SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy' },
    });
    assert.equal(titleRenderSmoke.status, 0, titleRenderSmoke.stderr || titleRenderSmoke.error?.message || titleRenderSmoke.stdout);
    const titleRendered = JSON.parse(titleRenderSmoke.stdout.trim());
    assert.equal(titleRendered.count, 11, 'the actual Title package renders every authored screen in Native');
    for (const screen of ['title', 'system', 'sound', 'load', 'save', 'pause']) {
      const image = await fs.readFile(path.join(titleCaptureRoot, `${screen}.png`));
      assert.ok(image.length > 4096, `actual Title ${screen} screen produced a rendered Native image`);
    }
    const titleInteractionSaveRoot = path.join(tempRoot, 'actual-title-control-saves');
    const titleControlSmoke = spawnSync(exe, [titlePackage, '--screen-control-smoke'], {
      encoding: 'utf8', timeout: 20000,
      env: { ...process.env, NOVEL_SAVE_ROOT: titleInteractionSaveRoot, SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy' },
    });
    assert.equal(titleControlSmoke.status, 0, titleControlSmoke.stderr || titleControlSmoke.error?.message || titleControlSmoke.stdout);
    const titleControlResult = JSON.parse(titleControlSmoke.stdout.trim());
    const titleControlSettings = titleControlResult.uiSettingsBeforeReset;
    assert.ok(Math.abs(titleControlSettings['audio.bgm'] - 0.75) < 0.03 && titleControlSettings['audio.bgmMuted'] === true,
      'Native SDL input changes the actual Title project global sound controls');
    assert.ok(Math.abs(titleControlSettings['audio.voice.ayaka'] - 0.4) < 0.03 && titleControlSettings['audio.voice.ayaka.muted'] === true,
      'Native SDL input changes the actual Title project character-specific sound controls');
    const titlePreferences = titleControlResult.uiSettingsPersistedBeforeReset;
    assert.equal(titlePreferences['audio.voice.ayaka.muted'], true, 'the actual Title Native player persists character mute changes');
    const restartSmoke = spawnSync(exe, [packagePath, '--screen-shortcut-restart-smoke'], {
      encoding: 'utf8', timeout: 15000,
      env: { ...process.env, NOVEL_SAVE_ROOT: controlSaveRoot, SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy' },
    });
    assert.equal(restartSmoke.status, 0, restartSmoke.stderr || restartSmoke.error?.message);
    assert.deepEqual(JSON.parse(restartSmoke.stdout.trim()), { F1: 'save', F12: 'history' }, 'Native reloads customized shortcut bindings in a fresh player process');
    console.log('PASS Native screen fixture and actual Title project: screen captures, mouse-driven audio controls, persistence and shortcuts');
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
