'use strict';

const assert = require('node:assert/strict');
const { chromium } = require('../build/audit-tools/node_modules/playwright');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { seedEmptyProject } = require('../tools/project-layout');

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-language-reference-'));
  const previousRoot = process.env.NOVEL_PROJECT_ROOT;
  const layout = seedEmptyProject(root);
  process.env.NOVEL_PROJECT_ROOT = root;
  const { handleApi, serveStatic } = require('../Edit/server');
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (url.pathname.startsWith('/api/')) await handleApi(request, response, url);
      else await serveStatic(response, url.pathname);
    } catch (error) {
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: error.message }));
    }
  });
  let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const pageUrl = `http://127.0.0.1:${server.address().port}/index.html`;
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(pageUrl);
    await page.locator('#editor').waitFor();
    await page.locator('[data-menu="help"]').click();
    await page.locator('[data-menu-action="syntax"]').click();
    await page.locator('.language-guide').waitFor();
    const originalUrl = page.url();
    await page.locator('.guide-reference').click();
    await page.locator('.guide-book-entry').first().waitFor();
    assert.equal(await page.locator('.language-guide').count(), 1);
    assert.equal(page.url(), originalUrl, 'opening the detailed reference does not navigate to another page');
    await page.locator('.guide-search').fill('dict[float]');
    assert.ok(await page.locator('.guide-book-entry').count() > 0);
    await page.locator('.guide-book-entry').first().click();
    assert.match(await page.locator('.guide-book-page').textContent(), /dict\[float\]/);
    await page.locator('.guide-search').fill('no-such-language-item');
    assert.equal(await page.locator('.guide-book-entry').count(), 0);
    assert.match(await page.locator('.guide-book-page').textContent(), /No matching sections/);
    await page.locator('.guide-reference').click();
    assert.ok(await page.locator('.guide-section').first().isVisible());
    assert.deepEqual(pageErrors, []);
    console.log('PASS in-place syntax reference: chapters, search, no-result state, and no navigation');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
    if (previousRoot === undefined) delete process.env.NOVEL_PROJECT_ROOT;
    else process.env.NOVEL_PROJECT_ROOT = previousRoot;
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
