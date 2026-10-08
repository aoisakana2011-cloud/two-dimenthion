'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('../build/audit-tools/node_modules/playwright');
const { seedEmptyProject } = require('../tools/project-layout');

async function main() {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-editor-find-'));
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
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
    await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
    const editor = page.locator('#editor');
    const panel = page.locator('#editor-find');
    await editor.waitFor();
    assert.equal(await page.locator('#editor-find-input').getAttribute('placeholder'), '検索', 'the field shows only the concise VS Code-style search hint');
    assert.equal(await page.locator('#editor-find-previous').textContent(), '↑', 'previous match uses a plain up arrow');
    assert.equal(await page.locator('#editor-find-next').textContent(), '↓', 'next match uses a plain down arrow');
    const controlOrder = await page.locator('#editor-find .editor-find-row:first-child > button').evaluateAll((buttons) => buttons.map((button) => button.id));
    assert.deepEqual(controlOrder, ['editor-find-replace-toggle', '', '', '', 'editor-find-previous', 'editor-find-next', 'editor-find-scope', 'editor-find-close'], 'only essential controls remain in a predictable VS Code-like order');
    await editor.fill('sora Sora soraX\nsora');
    await editor.evaluate((element) => element.setSelectionRange(0, 9));

    await page.keyboard.press('Control+f');
    assert.equal(await panel.isVisible(), true, 'Ctrl+F opens the in-editor find widget');
    assert.equal(await page.locator('#editor-find-input').evaluate((element) => element === document.activeElement), true, 'find input receives focus');
    const fieldWidths = await page.evaluate(() => ({
      search: document.querySelector('#editor-find-input').getBoundingClientRect().width,
      replace: document.querySelector('#editor-replace-input').getBoundingClientRect().width,
    }));
    assert.ok(Math.abs(fieldWidths.search - fieldWidths.replace) <= 1, `search and replace fields have equal widths: ${JSON.stringify(fieldWidths)}`);
    await page.locator('#editor-find-input').fill('sora');
    assert.match(await page.locator('#editor-find-count').textContent(), /1 \/ 4/);
    assert.equal(await editor.evaluate((element) => element.value.slice(element.selectionStart, element.selectionEnd)), 'sora', 'the active occurrence is selected in the document');
    await page.locator('#editor-find-input').fill('missing');
    assert.equal(await page.locator('#editor-find-count').textContent(), '結果はありません。', 'empty results use the concise standard message');
    await page.locator('#editor-find-input').fill('sora');
    await page.locator('#editor-find-next').click();
    assert.match(await page.locator('#editor-find-count').textContent(), /2 \/ 4/);
    assert.match(await editor.evaluate((element) => element.value.slice(element.selectionStart, element.selectionEnd)), /^sora$/i, 'next-match navigation moves the document selection');
    await page.locator('#editor-find-previous').click();
    assert.match(await page.locator('#editor-find-count').textContent(), /1 \/ 4/);
    await page.keyboard.press('F3');
    assert.match(await page.locator('#editor-find-count').textContent(), /2 \/ 4/);
    await page.keyboard.press('Shift+F3');
    assert.match(await page.locator('#editor-find-count').textContent(), /1 \/ 4/);
    assert.equal(await page.locator('#editor-find-highlights .editor-find-hit').count(), 4, 'all matches are visibly highlighted in the editor');
    assert.equal(await page.locator('#editor-find-highlights .editor-find-hit-active').count(), 1, 'the active match is distinguished');

    await page.locator('[data-editor-find-option="regex"]').click();
    await page.locator('#editor-find-input').fill('[');
    assert.match(await page.locator('#editor-find-count').textContent(), /Regex Error/);
    await page.locator('#editor-find-input').fill('sora');
    await page.locator('[data-editor-find-option="regex"]').click();

    await page.locator('[data-editor-find-option="case"]').click();
    assert.match(await page.locator('#editor-find-count').textContent(), /1 \/ 3/);
    await page.locator('[data-editor-find-option="word"]').click();
    assert.match(await page.locator('#editor-find-count').textContent(), /1 \/ 2/);
    await page.locator('#editor-find-scope').click();
    assert.match(await page.locator('#editor-find-count').textContent(), /1 \/ 1/);
    assert.equal(await page.locator('#editor-find-scope').getAttribute('aria-pressed'), 'true');

    await page.locator('#editor-find-scope').click();
    await page.locator('[data-editor-find-option="word"]').click();
    await page.locator('[data-editor-find-option="case"]').click();
    assert.match(await page.locator('#editor-find-count').textContent(), /1 \/ 4/);
    const bounds = await page.evaluate(() => {
      const panelRect = document.querySelector('#editor-find').getBoundingClientRect();
      const editorRect = document.querySelector('.editor-wrap').getBoundingClientRect();
      return { top: panelRect.top - editorRect.top, right: editorRect.right - panelRect.right, width: panelRect.width };
    });
    assert.ok(bounds.top >= 0 && bounds.top < 20 && bounds.right >= 0, 'find widget is compact and anchored inside the editor upper-right corner');
    await page.setViewportSize({ width: 720, height: 900 });
    await page.waitForFunction(() => {
      const search = document.querySelector('#editor-find-input').getBoundingClientRect().width;
      const replace = document.querySelector('#editor-replace-input').getBoundingClientRect().width;
      return Math.abs(search - replace) <= 1;
    });
    const narrowBounds = await page.evaluate(() => {
      const panelRect = document.querySelector('#editor-find').getBoundingClientRect();
      const editorRect = document.querySelector('.editor-wrap').getBoundingClientRect();
      return { left: panelRect.left, editorLeft: editorRect.left, right: panelRect.right, editorRight: editorRect.right };
    });
    assert.ok(narrowBounds.left >= narrowBounds.editorLeft && narrowBounds.right <= narrowBounds.editorRight, 'widget stays within the editor at a narrow viewport');
    await page.setViewportSize({ width: 1360, height: 900 });
    if (process.env.NOVEL_FIND_SCREENSHOT) await page.screenshot({ path: process.env.NOVEL_FIND_SCREENSHOT });

    await page.keyboard.press('Control+h');
    assert.equal(await page.locator('#editor-replace-row').isVisible(), true, 'Ctrl+H opens the replace row');
    await page.locator('#editor-replace-input').fill('mio');
    await page.locator('#editor-replace-one').click();
    assert.equal(await editor.inputValue(), 'mio Sora soraX\nsora', 'replace changes the active match only');
    await page.locator('#editor-replace-input').press('Control+Enter');
    assert.equal(await editor.inputValue(), 'mio mio mioX\nmio', 'Ctrl+Enter replaces all remaining matches');
    assert.equal(await page.locator('.dirty-mark').evaluate((element) => element.classList.contains('visible')), true, 'replacement marks the document dirty');

    await page.keyboard.press('Escape');
    assert.equal(await panel.isVisible(), false, 'Escape closes the find widget');
    assert.equal(await editor.evaluate((element) => element === document.activeElement), true, 'closing restores editor focus');
    await page.keyboard.press('Control+z');
    assert.equal(await editor.inputValue(), 'mio Sora soraX\nsora', 'replace-all is one undoable editor operation');
    await page.keyboard.press('Control+z');
    assert.equal(await editor.inputValue(), 'sora Sora soraX\nsora', 'single replacements are undoable too');
    const longSourceLines = Array.from({ length: 120 }, (_, index) => `line ${index + 1}${[5, 15, 25, 35, 45, 55, 115].includes(index + 1) ? ' needle' : ''}`);
    const longSource = longSourceLines.join('\n');
    await editor.fill(longSource);
    await editor.evaluate((element) => { element.scrollTop = 0; element.setSelectionRange(0, 0); });
    await page.keyboard.press('Control+f');
    await page.locator('#editor-find-input').fill('needle');
    assert.equal(await page.locator('#editor-find-count').textContent(), '1 / 7 件');
    const expectedLastMatch = longSource.lastIndexOf('needle');
    for (let index = 1; index < 7; index++) await page.locator('#editor-find-next').click();
    assert.equal(await page.locator('#editor-find-count').textContent(), '7 / 7 件', 'the count tracks the active occurrence');
    const navigationState = await editor.evaluate((element) => ({
      start: element.selectionStart,
      end: element.selectionEnd,
      scrollTop: element.scrollTop,
      overlayScrollTop: document.querySelector('#editor-find-highlights').scrollTop,
      lineNumberScrollTop: document.querySelector('#line-numbers').scrollTop,
    }));
    assert.deepEqual({ start: navigationState.start, end: navigationState.end }, { start: expectedLastMatch, end: expectedLastMatch + 'needle'.length }, 'navigation selects the exact active match');
    assert.ok(navigationState.scrollTop > 0, 'navigation scrolls the document to a distant match');
    assert.equal(navigationState.overlayScrollTop, navigationState.scrollTop, 'syntax and find overlays remain synchronized while navigating');
    assert.equal(navigationState.lineNumberScrollTop, navigationState.scrollTop, 'line numbers remain synchronized while navigating');
    await page.keyboard.press('Escape');
    await editor.fill('x '.repeat(1205));
    await editor.evaluate((element) => element.setSelectionRange(element.value.length - 2, element.value.length - 1));
    await page.keyboard.press('Control+f');
    assert.match(await page.locator('#editor-find-count').textContent(), /1205 \/ 1205/);
    assert.equal(await page.locator('#editor-find-highlights .editor-find-hit').count(), 1001, 'highlight overlay stays bounded while keeping a distant active match visible');
    assert.equal(await page.locator('#editor-find-highlights .editor-find-hit-active').count(), 1);
    await page.keyboard.press('Escape');
    assert.ok(bounds.width <= 440 && bounds.width >= 300, 'widget keeps the requested compact width');
    console.log('PASS editor find: shortcuts, navigation, options, selection scope, replace/replace-all, focus and compact placement');
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
    if (previousProjectRoot === undefined) delete process.env.NOVEL_PROJECT_ROOT;
    else process.env.NOVEL_PROJECT_ROOT = previousProjectRoot;
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
