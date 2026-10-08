'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { inflateSync } = require('node:zlib');
const { chromium } = require('../build/audit-tools/node_modules/playwright');
const { pack } = require('../tools/pack');
const { seedEmptyProject, projectLayout } = require('../tools/project-layout');

async function assertNativeLoadsPackage(t, destination, mode = '--headless') {
  const native = process.env.NOVEL_NATIVE_EXE || path.resolve(__dirname, '../native/build/Release/novel_player.exe');
  try {
    await fs.access(native);
    const result = spawnSync(native, [destination, mode], {
      encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy' },
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    t.skip('Native player is not built; package copy assertions passed');
  }
}

function decodePng(buffer) {
  let width = 0, height = 0, channels = 0;
  const chunks = [];
  for (let offset = 8; offset < buffer.length;) {
    const length = buffer.readUInt32BE(offset), type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    offset += length + 12;
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      assert.equal(data[8], 8, 'Native capture uses 8-bit PNG pixels');
      assert.ok(data[9] === 2 || data[9] === 6, 'Native capture uses RGB or RGBA pixels');
      channels = data[9] === 6 ? 4 : 3;
    }
    if (type === 'IDAT') chunks.push(data);
    if (type === 'IEND') break;
  }
  const raw = inflateSync(Buffer.concat(chunks)), stride = width * channels, pixels = Buffer.alloc(height * stride);
  const paeth = (a, b, c) => {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
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

test('pack preserves uppercase Asset directory names in screen CSS URLs for Browser and Native', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-screen-asset-case-pack-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, 'project');
  seedEmptyProject(projectRoot);
  const layout = projectLayout(projectRoot);
  await fs.writeFile(path.join(layout.scenesRoot, 'main.tds'), 'say narrator "screen asset case"\n', 'utf8');
  const image = path.join(layout.assetsRoot, 'Asset', 'pixel.png');
  await fs.mkdir(path.dirname(image), { recursive: true });
  // A solid color makes a Native capture prove that SDL actually decoded and
  // painted the packaged uppercase-Asset path, rather than merely parsing NSP.
  const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4xSXyHwAFMgIYcrSYSQAAAABJRU5ErkJggg==', 'base64');
  await fs.writeFile(image, imageBytes);
  const nativeSmokeBackground = path.join(layout.assetsRoot, 'ui', 'backgrounds', 'spring-ensemble-key-visual.jpg');
  await fs.mkdir(path.dirname(nativeSmokeBackground), { recursive: true });
  await fs.copyFile(path.resolve(__dirname, '../Title/asset/ui/backgrounds/spring-ensemble-key-visual.jpg'), nativeSmokeBackground);
  const screensDirectory = path.join(layout.settingsRoot, 'screens');
  await fs.mkdir(screensDirectory, { recursive: true });
  await fs.writeFile(path.join(screensDirectory, 'main.html'), '<main><button id="title-start" class="probe" data-action="start">Start</button></main>\n', 'utf8');
  await fs.writeFile(path.join(screensDirectory, 'main.css'), '.probe { position: absolute; left: 20px; top: 20px; width: 40px; height: 40px; background-image: url("Asset/pixel.png"); }\n', 'utf8');
  await fs.writeFile(path.join(layout.settingsRoot, 'game-screens.json'), JSON.stringify({
    version: 1, initial: 'title', stylesheet: 'screens/main.css',
    screens: { title: { title: 'Title', template: 'screens/main.html', background: 'ui/backgrounds/spring-ensemble-key-visual.jpg' } },
  }), 'utf8');

  const destination = path.join(layout.buildRoot, 'main.nsp.json');
  const packaged = await pack(path.join(layout.scenesRoot, 'main.tds'), destination, { projectRoot });
  const packagedImage = path.join(layout.buildRoot, 'asset', 'Asset', 'pixel.png');
  assert.deepEqual(await fs.readFile(packagedImage), imageBytes);
  const screen = JSON.parse(await fs.readFile(path.join(layout.buildRoot, 'asset', 'ui', 'game-screens.json'), 'utf8')).screens.title;

  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage();
    await page.route('http://asset-test/**', async route => route.fulfill({ status: 200, contentType: 'image/png', body: await fs.readFile(packagedImage) }));
    await page.setContent('<!doctype html><main id="mount"></main>');
    await page.addScriptTag({ path: path.resolve(__dirname, '../Edit/screen-document.js') });
    const browserImage = await page.evaluate(async tree => {
      const fragment = NovelScreenDocument.buildScreenDom(tree, document, {
        assetUrl: value => `http://asset-test/asset/${value}`,
      });
      document.querySelector('#mount').append(fragment);
      const background = getComputedStyle(document.querySelector('.probe')).backgroundImage;
      const image = new Image(); image.src = background.slice(5, -2); await image.decode();
      return { background, width: image.naturalWidth };
    }, screen.uiTree);
    assert.match(browserImage.background, /http:\/\/asset-test\/asset\/Asset\/pixel\.png/);
    assert.ok(browserImage.width > 0, 'Browser decoded the copied screen CSS image');
  } finally {
    await browser.close();
  }
  const native = process.env.NOVEL_NATIVE_EXE || path.resolve(__dirname, '../native/build/Release/novel_player.exe');
  try {
    await fs.access(native);
    const captureDirectory = path.join(root, 'native-captures');
    const result = spawnSync(native, [destination, '--screen-render-smoke'], {
      encoding: 'utf8', timeout: 15_000,
      env: { ...process.env, NOVEL_SCREEN_CAPTURE_DIR: captureDirectory, SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy' },
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    const capture = decodePng(await fs.readFile(path.join(captureDirectory, 'title.png')));
    const center = (Math.floor(capture.height * 40 / 720) * capture.width + Math.floor(capture.width * 40 / 1280)) * capture.channels;
    assert.ok(capture.pixels[center] > 220 && capture.pixels[center + 1] < 50 && capture.pixels[center + 2] < 60,
      `Native SDL paints the packaged uppercase-Asset image at the CSS background location; pixel=${[...capture.pixels.subarray(center, center + 3)]}`);
  } catch (error) {
    if (error.code === 'ENOENT') t.skip('Native player is not built; package copy and Browser decode assertions passed');
    else throw error;
  }
  assert.equal(packaged.native_ui.game_screens, 'ui/game-screens.json');
});

test('pack rejects linked files referenced by screen HTML and CSS before creating output', async t => {
  const cases = [
    { name: 'HTML img', document: 'html' },
    { name: 'CSS url()', document: 'css' },
  ];
  for (const linkType of ['hardlink', 'symlink']) {
    for (const item of cases) {
      await t.test(`${item.name} ${linkType}`, async subtest => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-linked-screen-asset-'));
        subtest.after(() => fs.rm(root, { recursive: true, force: true }));
        const projectRoot = path.join(root, 'project');
        seedEmptyProject(projectRoot);
        const layout = projectLayout(projectRoot);
        await fs.writeFile(path.join(layout.scenesRoot, 'main.tds'), 'say narrator "linked screen asset"\n', 'utf8');
        const externalImage = path.join(root, 'external.png');
        await fs.copyFile(path.resolve(__dirname, '../native/engine_data/ui/dialogue_box.png'), externalImage);
        const linkedImage = path.join(layout.assetsRoot, 'linked.png');
        try {
          if (linkType === 'hardlink') await fs.link(externalImage, linkedImage);
          else await fs.symlink(externalImage, linkedImage, 'file');
        } catch (error) {
          if (linkType === 'symlink' && ['EPERM', 'EACCES', 'ENOSYS', 'EOPNOTSUPP'].includes(error.code)) {
            subtest.skip(`File symlinks are unavailable: ${error.code}`);
            return;
          }
          throw error;
        }

        const screensDirectory = path.join(layout.settingsRoot, 'screens');
        await fs.mkdir(screensDirectory, { recursive: true });
        await fs.writeFile(path.join(screensDirectory, 'main.html'), item.document === 'html'
          ? '<main><button data-action="start">Start</button><img src="linked.png" alt=""></main>\n'
          : '<main><button class="probe" data-action="start">Start</button></main>\n', 'utf8');
        if (item.document === 'css') await fs.writeFile(path.join(screensDirectory, 'main.css'), '.probe { background-image: url("linked.png"); }\n', 'utf8');
        await fs.writeFile(path.join(layout.settingsRoot, 'game-screens.json'), JSON.stringify({
          version: 1,
          initial: 'title',
          ...(item.document === 'css' ? { stylesheet: 'screens/main.css' } : {}),
          screens: { title: { title: 'Title', template: 'screens/main.html' } },
        }), 'utf8');

        const destination = path.join(layout.buildRoot, 'main.nsp.json');
        await assert.rejects(
          pack(path.join(layout.scenesRoot, 'main.tds'), destination, { projectRoot }),
          error => /作品ファイルは通常の単独ファイルである必要があります/.test(error.message),
        );
        await assert.rejects(fs.access(destination), { code: 'ENOENT' });
        assert.deepEqual(await fs.readFile(externalImage), await fs.readFile(path.resolve(__dirname, '../native/engine_data/ui/dialogue_box.png')));
      });
    }
  }
});

test('pack rejects screen images reached through an external asset-root junction', async t => {
  for (const document of ['html', 'css']) {
    await t.test(document, async subtest => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-screen-asset-junction-'));
      subtest.after(() => fs.rm(root, { recursive: true, force: true }));
      const projectRoot = path.join(root, 'project');
      seedEmptyProject(projectRoot);
      const layout = projectLayout(projectRoot);
      const outsideAssets = path.join(root, 'outside-assets');
      await fs.mkdir(outsideAssets, { recursive: true });
      await fs.copyFile(path.resolve(__dirname, '../native/engine_data/ui/dialogue_box.png'), path.join(outsideAssets, 'pixel.png'));
      await fs.symlink(outsideAssets, path.join(layout.assetsRoot, 'linked'), 'junction');
      await fs.writeFile(path.join(layout.scenesRoot, 'main.tds'), 'say narrator "linked screen asset"\n', 'utf8');
      const screensDirectory = path.join(layout.settingsRoot, 'screens');
      await fs.mkdir(screensDirectory, { recursive: true });
      await fs.writeFile(path.join(screensDirectory, 'main.html'), document === 'html'
        ? '<main><button data-action="start">Start</button><img src="linked/pixel.png" alt=""></main>\n'
        : '<main><button class="probe" data-action="start">Start</button></main>\n', 'utf8');
      if (document === 'css') await fs.writeFile(path.join(screensDirectory, 'main.css'), '.probe { background-image: url("linked/pixel.png"); }\n', 'utf8');
      await fs.writeFile(path.join(layout.settingsRoot, 'game-screens.json'), JSON.stringify({
        version: 1,
        initial: 'title',
        ...(document === 'css' ? { stylesheet: 'screens/main.css' } : {}),
        screens: { title: { title: 'Title', template: 'screens/main.html' } },
      }), 'utf8');

      const destination = path.join(layout.buildRoot, 'main.nsp.json');
      await assert.rejects(pack(path.join(layout.scenesRoot, 'main.tds'), destination, { projectRoot }), /Path is outside the project\./);
      await assert.rejects(fs.access(destination), { code: 'ENOENT' });
      assert.ok((await fs.stat(path.join(outsideAssets, 'pixel.png'))).isFile());
    });
  }
});

test('pack cannot overwrite an unreferenced project asset with a custom output path', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-unreferenced-asset-pack-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, 'project');
  seedEmptyProject(projectRoot);
  const layout = projectLayout(projectRoot);
  await fs.writeFile(path.join(layout.scenesRoot, 'main.tds'), 'say narrator "preserve source"\n', 'utf8');
  const sourceAsset = path.join(layout.assetsRoot, 'unreferenced.png');
  const original = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  await fs.writeFile(sourceAsset, original);

  await assert.rejects(
    pack(path.join(layout.scenesRoot, 'main.tds'), sourceAsset, { projectRoot }),
    /Package output cannot overwrite a source file\./,
  );
  assert.deepEqual(await fs.readFile(sourceAsset), original);
});

test('pack does not leave a compiled screen manifest when a referenced image is missing', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-missing-screen-image-pack-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, 'project');
  seedEmptyProject(projectRoot);
  const layout = projectLayout(projectRoot);
  await fs.writeFile(path.join(layout.scenesRoot, 'main.tds'), 'say narrator "missing screen image"\n', 'utf8');
  const screensDirectory = path.join(layout.settingsRoot, 'screens');
  await fs.mkdir(screensDirectory, { recursive: true });
  await fs.writeFile(path.join(screensDirectory, 'main.html'), '<main><button data-action="start">Start</button><img alt="" src="asset/missing.png"></main>\n', 'utf8');
  await fs.writeFile(path.join(layout.settingsRoot, 'game-screens.json'), JSON.stringify({
    version: 1, initial: 'title', screens: { title: { title: 'Title', template: 'screens/main.html' } },
  }), 'utf8');

  const destination = path.join(layout.buildRoot, 'main.nsp.json');
  await assert.rejects(pack(path.join(layout.scenesRoot, 'main.tds'), destination, { projectRoot }), /ENOENT/);
  await assert.rejects(fs.access(destination), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(layout.buildRoot, 'asset', 'ui', 'game-screens.json')), { code: 'ENOENT' });
});

test('failed repack rolls back the previous package and copied assets', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-package-rollback-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, 'project');
  seedEmptyProject(projectRoot);
  const layout = projectLayout(projectRoot);
  const sourceImage = path.join(layout.assetsRoot, 'screen.png');
  const previousImage = Buffer.from('previous-image-bytes');
  await fs.writeFile(sourceImage, previousImage);
  const screensDirectory = path.join(layout.settingsRoot, 'screens');
  await fs.mkdir(screensDirectory, { recursive: true });
  const templatePath = path.join(screensDirectory, 'main.html');
  const template = image => `<main><button data-action="start">Start</button><img alt="" src="asset/${image}"></main>\n`;
  await fs.writeFile(templatePath, template('screen.png'), 'utf8');
  await fs.writeFile(path.join(layout.settingsRoot, 'game-screens.json'), JSON.stringify({
    version: 1, initial: 'title', screens: { title: { title: 'Title', template: 'screens/main.html' } },
  }), 'utf8');

  const destination = path.join(layout.buildRoot, 'main.nsp.json');
  await pack(path.join(layout.scenesRoot, 'main.tds'), destination, { projectRoot });
  const previousPackage = await fs.readFile(destination);
  const previousManifest = await fs.readFile(path.join(layout.buildRoot, 'asset', 'ui', 'game-screens.json'));
  const previousPackagedImage = await fs.readFile(path.join(layout.buildRoot, 'asset', 'screen.png'));

  await fs.writeFile(sourceImage, 'new-image-bytes');
  await fs.writeFile(templatePath, template('missing.png'), 'utf8');
  await assert.rejects(pack(path.join(layout.scenesRoot, 'main.tds'), destination, { projectRoot }), /ENOENT/);
  assert.deepEqual(await fs.readFile(destination), previousPackage, 'a failed build must preserve the previous complete package');
  assert.deepEqual(await fs.readFile(path.join(layout.buildRoot, 'asset', 'ui', 'game-screens.json')), previousManifest);
  assert.deepEqual(await fs.readFile(path.join(layout.buildRoot, 'asset', 'screen.png')), previousPackagedImage, 'assets copied before the failure must roll back');
  assert.equal((await fs.readdir(layout.buildRoot)).some(name => name.startsWith('.novel-pack-stage-')), false, 'temporary staging directories must be removed');
});

test('pack commit failure restores files already installed from the staging area', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-package-commit-rollback-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, 'project');
  seedEmptyProject(projectRoot);
  const layout = projectLayout(projectRoot);
  const sourceImage = path.join(layout.assetsRoot, 'screen.png');
  await fs.writeFile(sourceImage, 'old-image');
  const screensDirectory = path.join(layout.settingsRoot, 'screens');
  await fs.mkdir(screensDirectory, { recursive: true });
  await fs.writeFile(path.join(screensDirectory, 'main.html'), '<main><button data-action="start">Start</button><img alt="" src="asset/screen.png"></main>\n', 'utf8');
  await fs.writeFile(path.join(layout.settingsRoot, 'game-screens.json'), JSON.stringify({
    version: 1, initial: 'title', screens: { title: { title: 'Title', template: 'screens/main.html' } },
  }), 'utf8');
  const destination = path.join(layout.buildRoot, 'main.nsp.json');
  await pack(path.join(layout.scenesRoot, 'main.tds'), destination, { projectRoot });
  const previousPackage = await fs.readFile(destination);
  const previousImage = await fs.readFile(path.join(layout.buildRoot, 'asset', 'screen.png'));
  await fs.writeFile(sourceImage, 'new-image');

  const originalRename = fs.rename;
  let injected = false;
  fs.rename = async (from, to) => {
    if (!injected && path.resolve(to) === path.resolve(destination) && String(from).includes('.novel-pack-stage-')) {
      injected = true;
      throw Error('injected package install failure');
    }
    return originalRename(from, to);
  };
  try {
    await assert.rejects(pack(path.join(layout.scenesRoot, 'main.tds'), destination, { projectRoot }), /injected package install failure/);
  } finally {
    fs.rename = originalRename;
  }
  assert.deepEqual(await fs.readFile(destination), previousPackage, 'failed final package install restores the previous NSP');
  assert.deepEqual(await fs.readFile(path.join(layout.buildRoot, 'asset', 'screen.png')), previousImage, 'failed final package install restores assets committed earlier');
  assert.equal((await fs.readdir(layout.buildRoot)).some(name => name.startsWith('.novel-pack-stage-')), false);
});

test('pack resolves current-layout theme images from the project asset root', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-theme-asset-pack-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, 'project');
  seedEmptyProject(projectRoot);
  const layout = projectLayout(projectRoot);
  await fs.writeFile(path.join(layout.scenesRoot, 'main.tds'), 'say narrator "theme asset"\n');
  const image = path.join(layout.assetsRoot, 'panel.png');
  await fs.copyFile(path.resolve(__dirname, '../native/engine_data/ui/dialogue_box.png'), image);
  const theme = JSON.parse(await fs.readFile(path.resolve(__dirname, '../Title/setting/player-ui.json'), 'utf8'));
  theme.dialog.image = 'panel.png';
  theme.dialog.nameplate.image = '';
  await fs.writeFile(path.join(layout.settingsRoot, 'player-ui.json'), JSON.stringify(theme), 'utf8');
  await fs.appendFile(layout.settingFile, '\nnative_ui_theme = player-ui.json\n', 'utf8');

  const destination = path.join(layout.buildRoot, 'main.nsp.json');
  const packaged = await pack(path.join(layout.scenesRoot, 'main.tds'), destination, { projectRoot });
  assert.equal(packaged.native_ui.native_ui_theme, 'ui/player-ui.json');
  assert.deepEqual(await fs.readFile(path.join(layout.buildRoot, 'asset', 'ui', 'panel.png')), await fs.readFile(image));
  await assertNativeLoadsPackage(t, destination);
});

test('pack resolves legacy theme images beside the legacy theme file', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-legacy-theme-pack-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, 'project');
  const scenesRoot = path.join(projectRoot, 'senario');
  const assetsRoot = path.join(projectRoot, 'asset');
  await fs.mkdir(scenesRoot, { recursive: true });
  await fs.mkdir(path.join(assetsRoot, 'ui'), { recursive: true });
  await fs.writeFile(path.join(scenesRoot, 'main.tds'), 'say narrator "legacy theme asset"\n', 'utf8');
  const image = path.join(assetsRoot, 'ui', 'panel.png');
  await fs.copyFile(path.resolve(__dirname, '../native/engine_data/ui/dialogue_box.png'), image);
  const theme = JSON.parse(await fs.readFile(path.resolve(__dirname, '../Title/setting/player-ui.json'), 'utf8'));
  theme.dialog.image = 'panel.png';
  theme.dialog.nameplate.image = '';
  const themeFileName = 'player..ui.json';
  await fs.writeFile(path.join(assetsRoot, 'ui', themeFileName), JSON.stringify(theme), 'utf8');
  const settingFile = path.join(projectRoot, 'setting.txt');
  await fs.writeFile(settingFile, `scenario_dir = senario\nasset_dir = asset\nstart_file = main.tds\nnative_ui_theme = ui/${themeFileName}\n`, 'utf8');

  const destination = path.join(projectRoot, '.novel', 'build', 'main.nsp.json');
  const packaged = await pack(path.join(scenesRoot, 'main.tds'), destination, { projectRoot });
  assert.equal(packaged.native_ui.native_ui_theme, `ui/${themeFileName}`);
  await fs.access(path.join(path.dirname(destination), 'asset', 'ui', themeFileName));
  assert.deepEqual(await fs.readFile(path.join(path.dirname(destination), 'asset', 'ui', 'panel.png')), await fs.readFile(image));
  await assertNativeLoadsPackage(t, destination, '--screen-shortcut-restart-smoke');
});

test('pack copies a corrupt theme image without decoding it; Browser and Native reject the payload at render time', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-corrupt-theme-image-pack-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, 'project');
  seedEmptyProject(projectRoot);
  const layout = projectLayout(projectRoot);
  await fs.writeFile(path.join(layout.scenesRoot, 'main.tds'), 'asset bg audit_frame = "asset/ui/backgrounds/spring-ensemble-key-visual.jpg"\nsay narrator "corrupt theme asset"\n', 'utf8');
  const validFrame = path.resolve(__dirname, '../Title/asset/ui/backgrounds/spring-ensemble-key-visual.jpg');
  const frameTarget = path.join(layout.assetsRoot, 'ui', 'backgrounds', 'spring-ensemble-key-visual.jpg');
  await fs.mkdir(path.dirname(frameTarget), { recursive: true });
  await fs.copyFile(validFrame, frameTarget);
  const corruptBytes = Buffer.from([0, 1, 2, 3, 4]);
  await fs.writeFile(path.join(layout.assetsRoot, 'broken.png'), corruptBytes);
  const theme = JSON.parse(await fs.readFile(path.resolve(__dirname, '../Title/setting/player-ui.json'), 'utf8'));
  theme.dialog.image = 'broken.png';
  theme.dialog.nameplate.image = '';
  await fs.writeFile(path.join(layout.settingsRoot, 'player-ui.json'), JSON.stringify(theme), 'utf8');
  await fs.appendFile(layout.settingFile, '\nnative_ui_theme = player-ui.json\n', 'utf8');

  const destination = path.join(layout.buildRoot, 'main.nsp.json');
  const packaged = await pack(path.join(layout.scenesRoot, 'main.tds'), destination, { projectRoot });
  assert.equal(packaged.native_ui.native_ui_theme, 'ui/player-ui.json');
  const packagedImage = path.join(layout.buildRoot, 'asset', 'ui', 'broken.png');
  assert.deepEqual(await fs.readFile(packagedImage), corruptBytes);

  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage();
    await page.route('http://asset-test/**', async route => route.fulfill({ status: 200, contentType: 'image/png', body: await fs.readFile(packagedImage) }));
    await page.setContent('<!doctype html><main></main>');
    const decoded = await page.evaluate(async () => {
      const image = new Image(); image.src = 'http://asset-test/asset/ui/broken.png';
      try { await image.decode(); return true; } catch { return false; }
    });
    assert.equal(decoded, false, 'Browser image.decode rejects the copied corrupt theme asset');
  } finally {
    await browser.close();
  }

  await t.test('Native theme image decode', async subtest => {
    const native = process.env.NOVEL_NATIVE_EXE || path.resolve(__dirname, '../native/build/Release/novel_player.exe');
    try { await fs.access(native); }
    catch (error) { if (error.code === 'ENOENT') { subtest.skip('Native player is not built'); return; } throw error; }
    const captureDirectory = path.join(root, 'native-captures');
    const result = spawnSync(native, [destination, '--screen-render-smoke'], {
      encoding: 'utf8', timeout: 15_000,
      env: { ...process.env, NOVEL_SCREEN_CAPTURE_DIR: captureDirectory, SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy' },
    });
    assert.notEqual(result.status, 0, 'Native rejects the image when constructing the packaged theme');
    assert.match(result.stderr, /media decoder|image/i, result.stderr || result.error?.message);
  });
});

test('pack includes images used only by keyboard-visible focus styles', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-focus-visible-asset-pack-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, 'project');
  seedEmptyProject(projectRoot);
  const layout = projectLayout(projectRoot);
  await fs.writeFile(path.join(layout.scenesRoot, 'main.tds'), 'say narrator "focus visible asset"\n');

  const imageRelative = 'ui/keyboard-focus.png';
  const image = path.join(layout.assetsRoot, imageRelative);
  await fs.mkdir(path.dirname(image), { recursive: true });
  await fs.copyFile(path.resolve(__dirname, '../native/engine_data/ui/dialogue_box.png'), image);
  const screensDirectory = path.join(layout.settingsRoot, 'screens');
  await fs.mkdir(screensDirectory, { recursive: true });
  await fs.writeFile(path.join(screensDirectory, 'main.html'), '<main><button class="focused" data-action="start">Start</button></main>\n', 'utf8');
  await fs.writeFile(path.join(screensDirectory, 'main.css'), `.focused:focus-visible { background-image: url("asset/${imageRelative}"); }\n`, 'utf8');
  await fs.writeFile(path.join(layout.settingsRoot, 'game-screens.json'), JSON.stringify({
    version: 1,
    initial: 'title',
    stylesheet: 'screens/main.css',
    screens: { title: { title: 'Title', template: 'screens/main.html' } },
  }), 'utf8');

  const destination = path.join(layout.buildRoot, 'main.nsp.json');
  const packaged = await pack(path.join(layout.scenesRoot, 'main.tds'), destination, { projectRoot });
  assert.equal(packaged.native_ui.game_screens, 'ui/game-screens.json');
  assert.ok(packaged.native_ui);
  await assertNativeLoadsPackage(t, destination);
  assert.deepEqual(await fs.readFile(path.join(layout.buildRoot, 'asset', imageRelative)), await fs.readFile(image));
  const screen = JSON.parse(await fs.readFile(path.join(layout.buildRoot, 'asset', 'ui', 'game-screens.json'), 'utf8')).screens.title;
  assert.equal(screen.uiTree[0].children[0].focusVisibleStyle['background-image'], `url("asset/${imageRelative}")`);
});
