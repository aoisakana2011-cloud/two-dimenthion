'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('../build/audit-tools/node_modules/playwright');
const { seedEmptyProject } = require('../tools/project-layout');

async function main() {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-flow-debug-values-'));
  const previousProjectRoot = process.env.NOVEL_PROJECT_ROOT;
  seedEmptyProject(projectRoot);
  process.env.NOVEL_PROJECT_ROOT = projectRoot;
  const { handleApi, serveStatic } = require('../Edit/server');
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (url.pathname === '/__flow-debug-host') {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end('<!doctype html><iframe id="flow" src="/flow.html"></iframe><script>window.flowMessages=[];addEventListener("message",event=>flowMessages.push(event.data))</script>');
      } else if (url.pathname.startsWith('/api/')) await handleApi(request, response, url);
      else await serveStatic(response, url.pathname);
    } catch (error) {
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: error.message }));
    }
  });
  let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage();
    const variables = [
      { name: 'enabled', type: 'bool' },
      { name: 'flags', type: { kind: 'list', value: 'bool' } },
      { name: 'routes', type: { kind: 'dict', value: 'bool' } },
      { name: 'status', type: { kind: 'struct', name: 'DebugStatus' } },
    ].map(variable => ({
      ...variable, mutable: true, scope: 'global',
      definitions: [{ file: 'main.tds', line: 1 }],
      references: [{ file: 'main.tds', line: 3 }],
    }));
    await page.route('**/api/scene-graph', route => route.fulfill({ json: {
      version: 2,
      nodes: [{
        id: 'main.tds', reachable: true, sceneNames: ['main'],
        sceneLocations: [{ name: 'main', line: 1, endLine: 5 }],
        variables, structTypes: [{ name: 'DebugStatus', fields: { active: 'bool', label: 'str' } }], characterTypes: [],
      }],
      edges: [],
    } }));
    await page.route('**/api/flow-domains**', route => {
      const query = new URL(route.request().url()).searchParams;
      const names = (query.get('names') || '').split(',').filter(Boolean);
      return route.fulfill({ json: { domains: Object.fromEntries(names.map(name => [name, { kind: 'unknown', values: [] }])) } });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/__flow-debug-host`);
    const frame = page.frameLocator('#flow');
    await frame.locator('.flow-node[data-file="main.tds"]').waitFor();
    await frame.locator('#flow-test-vars input[data-name="enabled"]').waitFor();
    await page.waitForFunction(() => {
      const frame = document.querySelector('#flow');
      return frame?.contentDocument?.querySelectorAll('#flow-test-vars input[data-name]').length === 4
        && !frame.contentDocument.querySelector('#flow-test-run').disabled;
    });
    await frame.locator('input[data-name="enabled"]').fill('true');
    await frame.locator('input[data-name="flags"]').fill('["true"]');
    await frame.locator('input[data-name="routes"]').fill('{"common":true}');
    await frame.locator('input[data-name="status"]').fill('{"active":true,"label":"debug"}');
    await frame.locator('#flow-test-run').click();
    await frame.getByRole('status').filter({ hasText: 'JSON配列' }).waitFor();
    assert.equal(await page.evaluate(() => window.flowMessages.some(message => message.type === 'scene-flow:debug-play')), false,
      'a collection with elements of the wrong JSON type must not start debug playback');

    await frame.locator('input[data-name="flags"]').fill('[true,false]');
    await frame.locator('#flow-test-run').click();
    await page.waitForFunction(() => window.flowMessages.some(message => message.type === 'scene-flow:debug-play'));
    const payload = await page.evaluate(() => window.flowMessages.find(message => message.type === 'scene-flow:debug-play'));
    assert.equal(payload.variables.enabled.value, 'true');
    assert.equal(payload.variables.flags.value, '[true,false]');
    assert.equal(payload.variables.routes.value, '{"common":true}');
    assert.deepEqual(payload.variables.status.fields, { active: 'bool', label: 'str' });
    assert.equal(payload.variables.status.value, '{"active":true,"label":"debug"}');
    console.log('PASS Scene Flow validates bool/list/dict/struct debug values and sends typed overrides to the editor');
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
    if (previousProjectRoot === undefined) delete process.env.NOVEL_PROJECT_ROOT;
    else process.env.NOVEL_PROJECT_ROOT = previousProjectRoot;
    const tempRoot = await fs.realpath(os.tmpdir());
    const createdRoot = await fs.realpath(projectRoot);
    if (path.dirname(createdRoot) !== tempRoot || !path.basename(createdRoot).startsWith('novel-flow-debug-values-')) {
      throw Error(`refusing to remove an unexpected test directory: ${createdRoot}`);
    }
    await fs.rm(createdRoot, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
