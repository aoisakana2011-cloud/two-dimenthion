const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require('../build/audit-tools/node_modules/playwright');
const { seedEmptyProject } = require('../tools/project-layout');

const repoRoot = path.resolve(__dirname, '..');

async function startServer(projectRoot) {
  const child = spawn(process.execPath, [path.join(repoRoot, 'Edit/server.js'), '--project', projectRoot], {
    cwd: repoRoot, env: { ...process.env, PORT: '0' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
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
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-parallel-browser-'));
  const layout = seedEmptyProject(path.join(tempRoot, 'project'));
  const pixel = path.join(layout.assetsRoot, 'pixel.png');
  const broken = path.join(layout.assetsRoot, 'broken.png');
  await fs.copyFile(path.join(repoRoot, 'native/engine_data/ui/dialogue_box.png'), pixel);
  await fs.copyFile(pixel, broken);
  const server = await startServer(layout.projectRoot);
  let browser;
  try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage();
    page.setDefaultTimeout(12_000);
    await page.addInitScript(() => {
      const decode = HTMLImageElement.prototype.decode;
      HTMLImageElement.prototype.decode = function (...args) {
        if (this.src.includes('/broken.png')) return Promise.reject(new Error('injected parallel decode failure'));
        return decode.apply(this, args);
      };
    });

    await fs.writeFile(path.join(layout.scenesRoot, 'main.tds'), `asset bg room = "asset/pixel.png"
character hero {
  name = "Hero"
  pose normal = "asset/pixel.png"
}
scene main {
  parallel {
    bg room crossfade 240
    show hero.normal left fade 120
    camera zoom 1.5 at 640 360 over 240
  }
  goto after_parallel
}
scene after_parallel {
  say narrator "parallel complete"
}`, 'utf8');
    await page.goto(`${server.base}/player.html?source=main.tds`);
    await page.locator('#text').getByText('parallel complete').waitFor();
    const success = await page.evaluate(() => ({
      logicalTimeMs: runtime.sceneState.logicalTimeMs,
      scene: runtime.currentSceneName,
      background: runtime.sceneState.background?.asset,
      hero: runtime.sceneState.characters.hero && {
        visible: runtime.sceneState.characters.hero.visible,
        opacity: runtime.sceneState.characters.hero.opacity,
        slot: runtime.sceneState.characters.hero.slot,
      },
      zoom: runtime.sceneState.camera.zoom,
      renderedHero: Boolean(document.querySelector('#characters #char-hero')),
    }));
    assert.deepEqual(success, {
      logicalTimeMs: 240, scene: 'after_parallel', background: 'room', hero: { visible: true, opacity: 1, slot: 'left' }, zoom: 1.5, renderedHero: true,
    }, `Browser parallel group should start all three timed changes and advance by the longest duration: ${JSON.stringify(success)}`);

    await fs.writeFile(path.join(layout.scenesRoot, 'failure.tds'), `asset bg broken = "asset/broken.png"
character hero {
  name = "Hero"
  pose normal = "asset/pixel.png"
}
scene main {
  parallel {
    show hero.normal left fade 200
    bg broken crossfade 200
  }
  say narrator "must not run"
}`, 'utf8');
    await page.goto(`${server.base}/player.html?source=failure.tds`);
    await page.waitForFunction(() => document.querySelector('#speaker-text')?.textContent === 'Runtime Error');
    const failure = await page.evaluate(() => ({
      logicalTimeMs: runtime.sceneState.logicalTimeMs,
      visibleCharacters: Object.values(runtime.sceneState.characters).filter(character => character.visible).length,
      renderedCharacters: document.querySelectorAll('#characters .actor').length,
      overlays: document.querySelectorAll('#stage .player-effect').length,
      text: document.querySelector('#text')?.textContent,
    }));
    assert.equal(failure.logicalTimeMs, 0);
    assert.equal(failure.visibleCharacters, 0);
    assert.equal(failure.renderedCharacters, 0, `failed preparation must leave no staged actor in the DOM: ${JSON.stringify(failure)}`);
    assert.equal(failure.overlays, 0);
    assert.doesNotMatch(failure.text, /must not run/);
    process.stdout.write('PASS Browser parallel playback and transactional preparation rollback\n');
  } finally {
    await browser?.close();
    await stopServer(server.child);
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
