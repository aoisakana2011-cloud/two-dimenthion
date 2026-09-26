'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { chromium } = require('../build/audit-tools/node_modules/playwright');
const { seedEmptyProject } = require('../tools/project-layout');

const root = path.resolve(__dirname, '..');
const serverScript = path.join(root, 'Edit', 'server.js');

async function startServer(projectRoot, env) {
  const child = spawn(process.execPath, [serverScript, '--project', projectRoot], {
    cwd: root, env: { ...env, PORT: '0', NOVEL_TEMP_STARTUP_WORKSPACE: '1' }, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += String(chunk); });
  child.stderr.on('data', (chunk) => { output += String(chunk); });
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error(`Scene Flow server startup timed out:\n${output}`)), 30_000);
    const inspect = () => {
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    };
    child.stdout.on('data', inspect); child.stderr.on('data', inspect);
    child.once('exit', (code) => { clearTimeout(timer); reject(Error(`Scene Flow server exited ${code}:\n${output}`)); });
  });
  return { child, base };
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
  else child.kill('SIGTERM');
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), new Promise((resolve) => setTimeout(resolve, 5_000))]);
}

async function assertTopLevelFoldersDoNotOverlap(page, message) {
  const overlaps = await page.locator('.flow-folder').evaluateAll((elements) => {
    const boxes = elements.filter((element) => !element.parentElement.closest('.flow-folder'))
      .map((element) => {
        const box = element.getBoundingClientRect();
        return { name: element.dataset.folder, x: box.x, y: box.y, width: box.width, height: box.height };
      });
    const collisions = [];
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      if (a.name.startsWith(`${b.name}/`) || b.name.startsWith(`${a.name}/`)) continue;
      if (a.x < b.x + b.width - 1 && a.x + a.width > b.x + 1 && a.y < b.y + b.height - 1 && a.y + a.height > b.y + 1) {
        collisions.push([a.name, b.name]);
      }
    }
    return collisions;
  });
  assert.deepEqual(overlaps, [], `${message}: ${JSON.stringify(overlaps)}`);
}

async function main() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-flow-layout-'));
  const project = seedEmptyProject(path.join(tempRoot, 'project'));
  const folders = Array.from({ length: 10 }, (_, index) => `chapter${String(index + 1).padStart(2, '0')}`);
  const nodes = folders.flatMap((folder) => Array.from({ length: 5 }, (_, index) => ({
    id: `${folder}/scene${index + 1}.tds`, label: `scene${index + 1}`, reachable: true, diagnostics: [],
    variables: folder === 'chapter01' && index === 0
      ? Array.from({ length: 80 }, (_, number) => ({ name: `variable_${number + 1}`, type: 'int' })) : [],
  })));
  const edges = [];
  folders.forEach((folder, index) => {
    edges.push({ from: `${folder}/scene1.tds`, to: `${folder}/scene5.tds`, kind: 'goto' });
    edges.push({ from: `${folder}/scene5.tds`, to: `${folder}/scene1.tds`, kind: 'goto' });
    if (index + 1 < folders.length) edges.push({ from: `${folder}/scene2.tds`, to: `${folders[index + 1]}/scene2.tds`, kind: 'goto' });
  });
  edges.push({ from: 'chapter01/scene1.tds', to: 'chapter01/scene2.tds', kind: 'include' });
  edges.push({ from: 'chapter03/scene3.tds', to: 'chapter08/scene3.tds', kind: 'goto' });
  edges.push({ from: 'chapter08/scene4.tds', to: 'chapter03/scene4.tds', kind: 'goto' });
  let graphPayload = { nodes, edges };

  let server, browser;
  try {
    server = await startServer(project.projectRoot, { ...process.env, NOVEL_EDITOR_RECENT_FILE: path.join(tempRoot, 'recent.json') });
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const storageKey = `novel-scene-flow-layout:${project.projectRoot}`;
    await page.addInitScript(({ key }) => {
      if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({
        chapter03: { x: -950, y: -1200 }, chapter06: { x: 4200, y: 2300 },
      }));
    }, { key: storageKey });
    await page.route('**/api/scene-graph', (route) => route.fulfill({ json: graphPayload }));
    await page.goto(`${server.base}/flow.html`);
    await page.waitForFunction(() => document.querySelectorAll('.flow-node').length === 50, null, { timeout: 12_000 }).catch(async (error) => {
      const state = await page.evaluate(() => ({ status: document.querySelector('#status')?.textContent, flowCount: document.querySelector('#flow-count')?.textContent, helper: Boolean(window.FlowLayout) }));
      throw Error(`Synthetic graph did not render: ${JSON.stringify(state)}; page errors=${errors.join(' | ')}; ${error.message}`);
    });
    assert.equal(await page.locator('#start, #end, #validate, #swap-range, #result, [data-range-target]').count(), 0,
      'the redundant manual route-validation panel is absent');
    assert.equal(await page.locator('.controls .flow-filters').count(), 1, 'scene filtering remains available');
    assert.equal(await page.locator('.controls .legend').count(), 1, 'reachability and edge legend remains available');
    await page.locator('.flow-node[data-file="chapter01/scene1.tds"]').click();
    const detailsGeometry = await page.locator('#details').evaluate((element) => {
      const pane = element.closest('.details');
      return {
        contentHeight: element.scrollHeight, viewportHeight: element.clientHeight,
        paneBottom: pane.getBoundingClientRect().bottom,
        contentBottom: element.getBoundingClientRect().bottom,
        scrollbarWidth: getComputedStyle(element).scrollbarWidth,
      };
    });
    assert.ok(detailsGeometry.contentHeight > detailsGeometry.viewportHeight, 'many variables overflow the details viewport');
    assert.ok(detailsGeometry.contentBottom <= detailsGeometry.paneBottom + 1,
      `details stay inside the workbench: ${JSON.stringify(detailsGeometry)}`);
    assert.equal(detailsGeometry.scrollbarWidth, 'thin', 'details retain the shared slim scrollbar');
    await page.locator('#details').hover();
    await page.mouse.wheel(0, 1800);
    await page.waitForFunction(() => document.querySelector('#details').scrollTop > 0);
    const scrollAtEnd = await page.locator('#details').evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      const last = [...element.querySelectorAll('.variable')].at(-1);
      return { scrollTop: element.scrollTop, lastBottom: last.getBoundingClientRect().bottom, viewportBottom: element.getBoundingClientRect().bottom };
    });
    assert.ok(scrollAtEnd.scrollTop > 0 && scrollAtEnd.lastBottom <= scrollAtEnd.viewportBottom + 1,
      `last variable is reachable: ${JSON.stringify(scrollAtEnd)}`);
    await page.locator('.flow-node[data-file="chapter01/scene2.tds"]').click();
    assert.equal(await page.locator('#details').evaluate((element) => element.scrollTop), 0, 'selecting another file resets details scroll');
    assert.equal(await page.locator('.include-edge').count(), 0, 'include dependencies are hidden by default');
    await page.locator('#show-includes').check();

    const edgeSummary = await page.locator('.flow-edge').evaluateAll((paths) => ({
      count: paths.length,
      unique: new Set(paths.map((path) => path.getAttribute('d'))).size,
      uniformRoutes: paths.every((path) => !path.getAttribute('d').includes('C')),
      returns: paths.filter((path) => path.classList.contains('return-edge')).length,
      includes: paths.filter((path) => path.classList.contains('include-edge'))
        .every((path) => path.getAttribute('marker-end') === 'url(#include-arrow)'),
      includeOpacity: Number(getComputedStyle(paths.find((path) => path.classList.contains('include-edge'))).opacity),
      includeWidth: parseFloat(getComputedStyle(paths.find((path) => path.classList.contains('include-edge'))).strokeWidth),
      includeColor: getComputedStyle(paths.find((path) => path.classList.contains('include-edge'))).stroke,
      legend: document.querySelector('.legend')?.textContent || '',
    }));
    assert.equal(edgeSummary.unique, edgeSummary.count, 'parallel edges and loops use distinct SVG paths');
    assert.ok(edgeSummary.uniformRoutes, 'goto and include connections use one orthogonal route grammar');
    assert.ok(edgeSummary.returns >= 2, 'cycles use the dedicated return lanes');
    assert.ok(edgeSummary.includes, 'include edges use their own arrow marker when enabled');
    assert.ok(edgeSummary.includeOpacity >= 0.8, 'include dependencies remain clearly visible');
    assert.ok(edgeSummary.includeWidth >= 1.5, 'include lines are thicker than background decoration');
    assert.equal(edgeSummary.includeColor, 'rgb(194, 160, 102)', 'include lines use the theme-matched brass accent');
    assert.match(edgeSummary.legend, /シーン遷移/);
    assert.match(edgeSummary.legend, /include/);
    const chosenMetrics = await page.locator('.flow-svg').evaluate((svg) => ({
      columns: Number(svg.dataset.layoutColumns), score: Number(svg.dataset.layoutScore), metrics: JSON.parse(svg.dataset.layoutMetrics),
    }));
    assert.ok(chosenMetrics.columns > 0 && Number.isFinite(chosenMetrics.score));
    assert.ok(Number.isFinite(chosenMetrics.metrics.crossingRatio) && Number.isFinite(chosenMetrics.metrics.backwardRatio));

    const bounds = await page.locator('.flow-svg').evaluate((svg) => {
      const box = svg.getBBox(), view = svg.viewBox.baseVal;
      const graph = document.querySelector('#graph').getBoundingClientRect(), rendered = svg.getBoundingClientRect();
      return { box: { x: box.x, y: box.y, right: box.x + box.width, bottom: box.y + box.height }, view: { width: view.width, height: view.height }, graph: { width: graph.width, height: graph.height }, rendered: { width: rendered.width, height: rendered.height } };
    });
    assert.ok(bounds.box.x >= 0 && bounds.box.y >= 0, 'negative saved offsets are normalized');
    assert.ok(bounds.box.right <= bounds.view.width && bounds.box.bottom <= bounds.view.height, 'all edges and nodes fit the SVG canvas');
    assert.ok(bounds.rendered.width <= bounds.graph.width + 1 && bounds.rendered.height <= bounds.graph.height + 1, 'the initial view fits the graph viewport');
    await page.getByRole('button', { name: '自動配置' }).click();
    assert.equal(await page.evaluate((key) => localStorage.getItem(key), storageKey), '{}');
    await assertTopLevelFoldersDoNotOverlap(page, 'auto-arrange keeps all chapter folders separate');
    const collidingOffsets = await page.locator('.flow-folder').evaluateAll((elements) => Object.fromEntries(elements
      .filter((element) => !element.dataset.folder.includes('/'))
      .map((element) => {
        const [x, y] = element.getAttribute('transform').match(/[+-]?[\d.]+/g).map(Number);
        return [element.dataset.folder, { x: 42 - x, y: 42 - y }];
      })));
    await page.evaluate(({ key, offsets }) => localStorage.setItem(key, JSON.stringify(offsets)), { key: storageKey, offsets: collidingOffsets });
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('.flow-node').length === 50);
    await assertTopLevelFoldersDoNotOverlap(page, 'initial render resolves saved positions that place every folder on top of each other');
    await page.getByRole('button', { name: '自動配置' }).click();
    const fitWidth = await page.locator('.flow-svg').getAttribute('width');
    const graphBox = await page.locator('#graph').boundingBox();
    await page.keyboard.down('Control');
    await page.mouse.move(graphBox.x + graphBox.width / 2, graphBox.y + graphBox.height / 2);
    await page.mouse.wheel(0, -180);
    await page.keyboard.up('Control');
    await page.waitForFunction((width) => Number(document.querySelector('.flow-svg')?.getAttribute('width')) > Number(width), fitWidth);
    await page.getByRole('button', { name: '全体表示' }).click();
    const refitted = await page.locator('.flow-svg').evaluate((svg) => ({
      graph: document.querySelector('#graph').getBoundingClientRect(), rendered: svg.getBoundingClientRect(),
    }));
    assert.ok(refitted.rendered.width <= refitted.graph.width + 1 && refitted.rendered.height <= refitted.graph.height + 1);

    const unevenCounts = [1, 19, 3, 27, 2, 14, 5, 23, 1, 11];
    const unevenFolders = unevenCounts.map((_, index) => `volume${String(index + 1).padStart(2, '0')}`);
    const folderIndexPath = (index, folder) => index % 2 ? `${folder}/route/branch` : folder;
    graphPayload = {
      nodes: unevenFolders.flatMap((folder, folderIndex) => Array.from({ length: unevenCounts[folderIndex] }, (_, index) => ({
        id: `${folderIndexPath(folderIndex, folder)}/scene${String(index + 1).padStart(2, '0')}.tds`, label: `scene${index + 1}`, reachable: true, diagnostics: [], variables: [],
      }))),
      edges: [],
    };
    unevenFolders.forEach((folder, index) => {
      if (index + 1 < unevenFolders.length) {
        const from = `${folderIndexPath(index, folder)}/scene01.tds`;
        const targetFolder = unevenFolders[index + 1];
        const to = `${folderIndexPath(index + 1, targetFolder)}/scene01.tds`;
        graphPayload.edges.push({ from, to, kind: 'goto' });
      }
    });
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('.flow-node').length === 106);
    await page.getByRole('button', { name: '自動配置' }).click();
    await assertTopLevelFoldersDoNotOverlap(page, 'auto-arrange keeps short and tall folders separate');

    graphPayload = {
      nodes: [{ id: 'chapter01/only-scene.tds', label: 'only-scene', reachable: true, diagnostics: [], variables: [] }],
      edges: [],
    };
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('.flow-node').length === 1);
    const smallGraphFit = await page.locator('.flow-svg').evaluate((svg) => {
      const graph = document.querySelector('#graph').getBoundingClientRect();
      const rendered = svg.getBoundingClientRect();
      const world = svg.viewBox.baseVal;
      return { zoom: rendered.width / world.width, graph: { width: graph.width, height: graph.height }, rendered: { width: rendered.width, height: rendered.height } };
    });
    assert.ok(smallGraphFit.zoom > 1, `a small graph should use the viewport instead of staying at 100%; zoom=${smallGraphFit.zoom}`);
    assert.ok(smallGraphFit.rendered.width <= smallGraphFit.graph.width + 1 && smallGraphFit.rendered.height <= smallGraphFit.graph.height + 1, 'small graph remains fully visible after fitting');
    graphPayload = {
      nodes: ['chapters/banquet.tds', 'routes/return.tds', 'routes/next.tds']
        .map(id => ({ id, label: id.split('/').at(-1), reachable: true, diagnostics: [], variables: [] })),
      edges: [
        { from: 'routes/return.tds', to: 'chapters/banquet.tds', kind: 'goto' },
        { from: 'chapters/banquet.tds', to: 'routes/next.tds', kind: 'goto' },
      ],
    };
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('.flow-edge').length === 2);
    const sharedPortGeometry = await page.locator('.flow-svg').evaluate((element) => {
      const arrival = element.querySelector('.flow-edge[data-to="chapters/banquet.tds"]');
      const departure = element.querySelector('.flow-edge[data-from="chapters/banquet.tds"]');
      const end = arrival.getPointAtLength(arrival.getTotalLength());
      const start = departure.getPointAtLength(0);
      return { arrival: { x: end.x, y: end.y }, departure: { x: start.x, y: start.y } };
    });
    assert.ok(Math.abs(sharedPortGeometry.arrival.x - sharedPortGeometry.departure.x) < 1,
      `incoming and outgoing routes should attach to the same node edge: ${JSON.stringify(sharedPortGeometry)}`);
    assert.ok(sharedPortGeometry.departure.y - sharedPortGeometry.arrival.y >= 10,
      `incoming arrow and outgoing line should not overlap: ${JSON.stringify(sharedPortGeometry)}`);
    graphPayload = {
      nodes: [
        { id: 'main.tds', label: 'main', sceneNames: ['main', 'extra_story_menu'], localGotos: [{ fromScene: 'main', scene: 'extra_story_menu', file: 'main.tds', gotoLine: 20, choice: 'More stories' }], reachable: true, diagnostics: [], variables: [] },
        { id: 'chapters/chapter01.tds', label: 'chapter01', sceneNames: ['chapter01_s01'], reachable: true, diagnostics: [], variables: [] },
        { id: 'appendix/archive.tds', label: 'archive', sceneNames: ['archive'], reachable: true, diagnostics: [], variables: [] },
      ],
      edges: [
        { from: 'main.tds', to: 'chapters/chapter01.tds', kind: 'goto', transitions: [{ fromScene: 'main', toScene: 'chapter01_s01', choice: 'Start story', line: 12 }] },
        { from: 'chapters/chapter01.tds', to: 'appendix/archive.tds', kind: 'goto', transitions: [{ fromScene: 'chapter01_s01', toScene: 'archive', choice: '', line: 8 }] },
      ],
    };
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('.flow-node').length === 3);
    await page.locator('.flow-node[data-file="main.tds"]').click();
    const mainDetails = await page.locator('#details').textContent();
    assert.match(mainDetails, /main → extra_story_menu · More stories/);
    assert.match(mainDetails, /main → chapter01_s01 · Start story/);
    assert.match(mainDetails, /chapters\/chapter01\.tds:12/);
    assert.match(await page.locator('.flow-edge[data-from="main.tds"] title').textContent(), /chapter01_s01 · Start story \(line 12\)/);
    assert.equal(await page.locator('.flow-edge.is-related').count(), 1, 'selecting a scene highlights only its connected transitions');
    const unrelatedOpacity = await page.locator('.flow-edge:not(.is-related)').evaluate((edge) => Number(getComputedStyle(edge).opacity));
    assert.ok(unrelatedOpacity >= 0.4 && unrelatedOpacity <= 0.55,
      `unrelated transitions remain visible without overpowering the selected route; opacity=${unrelatedOpacity}`);

    process.env.NOVEL_PROJECT_ROOT = path.join(root, 'Title');
    graphPayload = await require('../Edit/server').sceneGraph();
    await page.reload();
    await page.waitForFunction((count) => document.querySelectorAll('.flow-node').length === count, graphPayload.nodes.length);
    const titleLayout = await page.locator('.flow-svg').evaluate((element) => {
      const positions = [...document.querySelectorAll('.flow-folder')].map((folder) => ({
        id: folder.dataset.folder,
        y: Number(folder.getAttribute('transform').match(/translate\([^ ]+ ([^)]+)\)/)?.[1]),
      }));
      const screenFolders = [...document.querySelectorAll('.flow-folder')].map((folder) => ({
        id: folder.dataset.folder,
        x: folder.getBoundingClientRect().x,
        y: folder.getBoundingClientRect().y,
        width: folder.getBoundingClientRect().width,
        height: folder.getBoundingClientRect().height,
      }));
      return { positions, screenFolders, metrics: JSON.parse(element.dataset.layoutMetrics) };
    });
    const titleFolders = [...titleLayout.screenFolders].sort((a, b) => a.y - b.y);
    assert.deepEqual(titleFolders.map(folder => folder.id), ['(root)', 'chapters', 'endings']);
    assert.ok(titleFolders.every(folder => folder.width >= 165), 'Title scene labels stay readable');
    for (let index = 1; index < titleFolders.length; index++) {
      const previous = titleFolders[index - 1], current = titleFolders[index];
      assert.ok(current.y - previous.y - previous.height >= 32,
        `Title folders have comfortable vertical spacing: ${JSON.stringify(titleFolders)}`);
    }
    assert.ok(titleLayout.metrics.geometryAfter.verticalDistance <= titleLayout.metrics.geometryBefore.verticalDistance,
      'Title scene connections are no less aligned after geometric placement');
    assert.ok(titleLayout.metrics.geometryAfter.obstructions <= titleLayout.metrics.geometryBefore.obstructions,
      `Title layout should not add folder crossings: ${JSON.stringify({ before: titleLayout.metrics.geometryBefore, after: titleLayout.metrics.geometryAfter })}`);
    const titleEdgeHits = await page.locator('.flow-svg').evaluate((element) => {
      const folders = [...element.querySelectorAll('.flow-folder')].map((group) => {
        const [, x, y] = group.getAttribute('transform').match(/translate\(([^ ]+) ([^)]+)\)/).map(Number);
        const frame = group.querySelector('.flow-folder-frame');
        return { id: group.dataset.folder, x, y, width: Number(frame.getAttribute('width')), height: Number(frame.getAttribute('height')) };
      });
      const hits = [];
      for (const edge of element.querySelectorAll('.flow-edge')) {
        const start = edge.dataset.from.includes('/') ? edge.dataset.from.split('/')[0] : '(root)';
        const end = edge.dataset.to.includes('/') ? edge.dataset.to.split('/')[0] : '(root)';
        const length = edge.getTotalLength();
        for (const folder of folders) {
          if (folder.id === start || folder.id === end) continue;
          for (let index = 1; index < 24; index++) {
            const point = edge.getPointAtLength(length * index / 24);
            if (point.x > folder.x && point.x < folder.x + folder.width
              && point.y > folder.y + 9 && point.y < folder.y + folder.height + 9) {
              hits.push({ from: edge.dataset.from, to: edge.dataset.to, folder: folder.id, x: point.x, y: point.y });
              break;
            }
          }
        }
      }
      return hits;
    });
    assert.equal(titleEdgeHits.length, 0, `Title edge paths avoid unrelated folder boxes: ${JSON.stringify(titleEdgeHits)}`);
    await assertTopLevelFoldersDoNotOverlap(page, 'Title geometric placement keeps its real folders separate');
    if (process.env.NOVEL_FLOW_SCREENSHOT) await page.screenshot({ path: process.env.NOVEL_FLOW_SCREENSHOT, fullPage: false });
    assert.deepEqual(errors, [], 'Scene Flow renders without browser errors');
    console.log('PASS Scene Flow layout: dense and current Title graphs, shared ports, cycles, fit and collision-free auto-arrange');
  } finally {
    if (browser) await browser.close().catch(() => {});
    await stopServer(server?.child);
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
