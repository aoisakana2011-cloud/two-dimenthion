'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('../build/audit-tools/node_modules/playwright');
const { seedEmptyProject } = require('../tools/project-layout');

async function main() {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-scrollbar-test-'));
  const previousProjectRoot = process.env.NOVEL_PROJECT_ROOT;
  seedEmptyProject(projectRoot);
  process.env.NOVEL_PROJECT_ROOT = projectRoot;
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
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ channel: 'msedge', headless: true });

    const inspect = async (page, selector) => page.evaluate((target) => {
      const element = document.querySelector(target);
      if (!element) throw new Error(`Missing scrollbar host: ${target}`);
      const style = getComputedStyle(element);
      const scrollbar = getComputedStyle(element, '::-webkit-scrollbar');
      const thumb = getComputedStyle(element, '::-webkit-scrollbar-thumb');
      const track = getComputedStyle(element, '::-webkit-scrollbar-track');
      const button = getComputedStyle(element, '::-webkit-scrollbar-button');
      return {
        standardWidth: style.scrollbarWidth,
        webkitWidth: scrollbar.width,
        webkitHeight: scrollbar.height,
        thumbColor: thumb.backgroundColor,
        thumbClip: thumb.backgroundClip,
        thumbBorder: thumb.borderTopWidth,
        trackColor: track.backgroundColor,
        arrowButtonDisplay: button.display,
      };
    }, selector);
    const expected = {
      standardWidth: 'thin',
      webkitWidth: '9px',
      webkitHeight: '9px',
      thumbColor: 'rgb(85, 85, 85)',
      thumbClip: 'content-box',
      thumbBorder: '2px',
      trackColor: 'rgba(0, 0, 0, 0)',
      arrowButtonDisplay: 'none',
    };

    const editorPage = await browser.newPage({ viewport: { width: 1360, height: 900 } });
    await editorPage.goto(`${base}/index.html`);
    await editorPage.locator('#editor').waitFor();
    assert.deepEqual(await inspect(editorPage, '.sidebar'), expected, 'editor sidebar uses the shared slim scrollbar');
    const editorExceptions = await editorPage.evaluate(() => ({
      editor: [getComputedStyle(document.querySelector('#editor')).scrollbarWidth, getComputedStyle(document.querySelector('#editor'), '::-webkit-scrollbar').display],
      tabs: [getComputedStyle(document.querySelector('.editor-tabs')).scrollbarWidth, getComputedStyle(document.querySelector('.editor-tabs'), '::-webkit-scrollbar').display],
      diagnostics: [getComputedStyle(document.querySelector('.validation-card pre')).scrollbarWidth, getComputedStyle(document.querySelector('.validation-card pre'), '::-webkit-scrollbar').display],
    }));
    assert.deepEqual(editorExceptions, {
      editor: ['none', 'none'],
      tabs: ['none', 'none'],
      diagnostics: ['none', 'none'],
    }, 'custom minimap and intentionally hidden rails stay hidden');

    const flowPage = await browser.newPage({ viewport: { width: 1360, height: 900 } });
    await flowPage.goto(`${base}/flow.html`);
    await flowPage.locator('#graph').waitFor();
    assert.deepEqual(await inspect(flowPage, '#graph'), expected, 'Scene Flow canvas uses the shared scrollbar instead of a thicker local override');
    assert.deepEqual(await inspect(flowPage, '#details'), expected, 'Scene Flow details use the shared scrollbar');

    const playerPage = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await playerPage.goto(`${base}/player.html`);
    await playerPage.locator('#text').waitFor();
    assert.deepEqual(await inspect(playerPage, '#text'), expected, 'player text uses the same neutral scrollbar');

    console.log('PASS scrollbar theme: editor, Scene Flow, and player; minimap, tabs, and compact diagnostics remain intentionally hidden');
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
    if (previousProjectRoot === undefined) delete process.env.NOVEL_PROJECT_ROOT;
    else process.env.NOVEL_PROJECT_ROOT = previousProjectRoot;
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
