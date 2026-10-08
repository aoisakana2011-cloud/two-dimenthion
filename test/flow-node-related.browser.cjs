'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { chromium } = require('../build/audit-tools/node_modules/playwright');
const { seedEmptyProject } = require('../tools/project-layout');

const root = path.resolve(__dirname, '..');

async function startServer(projectRoot) {
  const child = spawn(process.execPath, [path.join(root, 'Edit', 'server.js'), '--project', projectRoot], {
    cwd: root, env: { ...process.env, PORT: '0', NOVEL_TEMP_STARTUP_WORKSPACE: '1' }, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += String(chunk); });
  child.stderr.on('data', chunk => { output += String(chunk); });
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error(`Scene Flow server startup timeout: ${output}`)), 15_000);
    const inspect = () => {
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    };
    child.stdout.on('data', inspect);
    child.stderr.on('data', inspect);
    child.once('exit', code => { clearTimeout(timer); reject(Error(`Scene Flow server exited ${code}: ${output}`)); });
  });
  return { child, base };
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
  else child.kill('SIGTERM');
  await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 5_000))]);
}

(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-flow-related-'));
  const project = seedEmptyProject(path.join(tempRoot, 'project'));
  const chain = ['ancestor-5', 'ancestor-4', 'ancestor-3', 'ancestor-2', 'ancestor-1', 'main',
    'chapter-1', 'chapter-2', 'chapter-3', 'chapter-4', 'chapter-5'];
  const graph = {
    nodes: [...chain.map(id => `${id}.tds`), 'appendix/unused.tds'].map(id => ({
      id, label: path.basename(id, '.tds'), sceneNames: [path.basename(id, '.tds')], reachable: true, diagnostics: [], variables: [],
    })),
    edges: chain.slice(1).map((id, index) => ({ from: `${chain[index]}.tds`, to: `${id}.tds`, kind: 'goto' })),
  };
  let server, browser;
  try {
    server = await startServer(project.projectRoot);
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/scene-graph', route => route.fulfill({ json: graph }));
    await page.goto(`${server.base}/flow.html`);
    await page.waitForFunction(() => document.querySelectorAll('.flow-node').length === 12);
    await page.locator('.flow-node[data-file="main.tds"]').click();
    assert.equal(await page.locator('.flow-node.selected').count(), 1);
    assert.equal(await page.locator('.flow-node.related').count(), 10, 'all visible ancestors and descendants are included');
    assert.equal(await page.locator('.flow-node[data-file="chapter-1.tds"]').evaluate(node => node.classList.contains('related')), true);
    assert.equal(await page.locator('.flow-node[data-file="ancestor-1.tds"]').evaluate(node => node.classList.contains('related')), true);
    assert.equal(await page.locator('.flow-node[data-file="appendix/unused.tds"]').evaluate(node => node.classList.contains('related')), false);
    const colors = await page.locator('.flow-node').evaluateAll(nodes => Object.fromEntries(nodes.map(node => [
      node.dataset.file, getComputedStyle(node.querySelector('rect')).fill,
    ])));
    const colorDistance = (left, right) => {
      const rgb = value => {
        const channels = value.match(/[\d.]+/g).slice(0, 3).map(Number);
        return value.startsWith('color(srgb') ? channels.map(channel => channel * 255) : channels;
      };
      const leftRgb = rgb(left), rightRgb = rgb(right);
      return leftRgb.reduce((sum, channel, index) => sum + Math.abs(channel - rightRgb[index]), 0);
    };
    const neutral = colors['appendix/unused.tds'];
    const nearDistance = colorDistance(colors['chapter-1.tds'], neutral);
    const middleDistance = colorDistance(colors['chapter-3.tds'], neutral);
    const farDistance = colorDistance(colors['chapter-4.tds'], neutral);
    assert.ok(nearDistance > middleDistance && middleDistance > farDistance && farDistance > 0,
      `emphasis fades with graph distance: ${JSON.stringify({ nearDistance, middleDistance, farDistance })}`);
    assert.ok(colorDistance(colors['chapter-5.tds'], neutral) < 0.01, 'distant descendants return to the surrounding node color');
    assert.ok(colorDistance(colors['ancestor-5.tds'], neutral) < 0.01, 'distant ancestors return to the surrounding node color');

    await page.locator('.flow-node[data-file="appendix/unused.tds"]').click();
    assert.equal(await page.locator('.flow-node.selected').count(), 1);
    assert.equal(await page.locator('.flow-node.related').count(), 0, 'selection change clears stale neighbor emphasis');
    const selectedNode = page.locator('.flow-node[data-file="appendix/unused.tds"]');
    await selectedNode.focus();
    await selectedNode.press('Enter');
    assert.equal(await selectedNode.getAttribute('aria-keyshortcuts'), 'F2');
    await page.setViewportSize({ width: 1000, height: 800 });
    assert.equal(await page.locator('.details').isVisible(), false, 'narrow layout hides Details but keeps the graph keyboard action');
    await selectedNode.press('F2');
    await page.waitForURL(/\?scene=appendix%2Funused\.tds$/);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${server.base}/flow.html`);
    await page.waitForFunction(() => document.querySelectorAll('.flow-node').length === 12);
    await page.locator('.flow-node[data-file="appendix/unused.tds"]').click();
    const openScene = page.locator('#details .flow-open-scene');
    assert.equal(await openScene.getAttribute('aria-label'), 'Open appendix/unused.tds in Editor');
    await openScene.focus();
    await openScene.press('Enter');
    await page.waitForURL(/\?scene=appendix%2Funused\.tds$/);
    assert.deepEqual(errors, []);
    console.log('PASS Scene Flow selected-node and direct-neighbor emphasis');
  } finally {
    if (browser) await browser.close().catch(() => {});
    await stopServer(server?.child);
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
