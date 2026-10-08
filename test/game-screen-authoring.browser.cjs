'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('../build/audit-tools/node_modules/playwright');
const { seedEmptyProject } = require('../tools/project-layout');

async function main() {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-screen-authoring-'));
  const oldProjectRoot = process.env.NOVEL_PROJECT_ROOT;
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
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
    page.setDefaultTimeout(10000);
    const base = `http://127.0.0.1:${server.address().port}`;
    await page.goto(`${base}/index.html`);
    await page.locator('#editor').waitFor();
    await page.locator('[data-activity="presentation"]').click();
    await page.locator('[data-presentation-action="game-screens"]').click();
    const dialog = page.locator('.game-screen-settings');
    await dialog.waitFor();
    const close = dialog.locator('.project-settings-close');
    await close.focus();
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'SELECT', 'Tab enters the screen selector');
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('project-settings-close')), true, 'Shift+Tab wraps to the close control');
    await page.locator('.game-screen-toolbar button').last().click();
    const htmlLink = page.locator('.game-screen-source-link').filter({ hasText: 'screens/title.html' });
    const cssLink = page.locator('.game-screen-source-link').filter({ hasText: 'screens/shared.css' });
    await htmlLink.waitFor();
    assert.equal(await page.locator('.game-screen-inspector textarea').count(), 0, 'HTML/CSS source is not embedded in the screen settings panel');
    assert.equal(await page.locator('.game-screen-source-link').count(), 2, 'the panel contains only the HTML and shared CSS source links');
    await htmlLink.click();
    await page.waitForFunction(() => document.querySelector('#scene-name')?.value === 'setting/screens/title.html');
    await page.waitForFunction(() => document.querySelector('#highlight .token.tag'));
    assert.ok(await page.locator('#highlight .token.attr-name').count() > 0, 'HTML source uses Prism markup tokens');
    const htmlTagColor = await page.locator('#highlight .token.tag').first().evaluate(element => getComputedStyle(element).color);
    const htmlAttributeColor = await page.locator('#highlight .token.attr-name').first().evaluate(element => getComputedStyle(element).color);
    const minimapHtmlTagColor = await page.locator('#minimap-content .token.tag').first().evaluate(element => getComputedStyle(element).color);
    const tdsKeywordColor = await page.evaluate(() => { const probe = document.createElement('span'); probe.className = 'hl-keyword'; document.body.append(probe); const color = getComputedStyle(probe).color; probe.remove(); return color; });
    const tdsPropertyColor = await page.evaluate(() => { const probe = document.createElement('span'); probe.className = 'hl-property'; document.body.append(probe); const color = getComputedStyle(probe).color; probe.remove(); return color; });
    assert.equal(htmlTagColor, tdsKeywordColor, 'HTML tag color shares the TDS keyword palette');
    assert.equal(htmlAttributeColor, tdsPropertyColor, 'HTML attribute color shares the TDS property palette');
    assert.equal(minimapHtmlTagColor, tdsKeywordColor, 'HTML minimap tag color shares the TDS keyword palette');
    const saved = await (await page.request.get(`${base}/api/game-screens`)).json();
    const titleDocument = saved.screens.screens.title.template;
    assert.equal(saved.documents[titleDocument].includes('<main id="legacy-title">'), true, 'following the code-editor link persists newly created screen source');
    const editor = page.locator('#editor');
    const validSource = await editor.inputValue();
    const editedSource = validSource.replace('<main id="legacy-title">', '<main id="legacy-title" class="code-edited">');
    assert.notEqual(editedSource, validSource);
    await editor.fill(editedSource);
    await page.locator('[data-menu="file"]').click();
    await page.locator('[data-menu-action="save"]').click();
    await page.waitForFunction(async () => (await (await fetch('/api/setting-file?name=screens%2Ftitle.html')).json()).source.includes('class="code-edited"'));

    await page.locator('[data-activity="presentation"]').click();
    await page.locator('[data-presentation-action="game-screens"]').click();
    const reopenedDialog = page.locator('.game-screen-settings');
    await reopenedDialog.waitFor();
    const reopenedCssLink = reopenedDialog.locator('.game-screen-source-link').filter({ hasText: 'screens/shared.css' });
    await reopenedCssLink.click();
    await page.waitForFunction(() => document.querySelector('#scene-name')?.value === 'setting/screens/shared.css');
    assert.match(await editor.inputValue(), /#legacy-title/);
    await page.waitForFunction(() => document.querySelector('#highlight .token.selector'));
    assert.ok(await page.locator('#highlight .token.property').count() > 0, 'CSS source uses Prism CSS tokens');
    const cssSelectorColor = await page.locator('#highlight .token.selector').first().evaluate(element => getComputedStyle(element).color);
    const cssPropertyColor = await page.locator('#highlight .token.property').first().evaluate(element => getComputedStyle(element).color);
    const minimapCssSelectorColor = await page.locator('#minimap-content .token.selector').first().evaluate(element => getComputedStyle(element).color);
    const minimapCssPropertyColor = await page.locator('#minimap-content .token.property').first().evaluate(element => getComputedStyle(element).color);
    const tdsIdentifierColor = await page.evaluate(() => { const probe = document.createElement('span'); probe.className = 'hl-variable'; document.body.append(probe); const color = getComputedStyle(probe).color; probe.remove(); return color; });
    const cssTdsPropertyColor = await page.evaluate(() => { const probe = document.createElement('span'); probe.className = 'hl-property'; document.body.append(probe); const color = getComputedStyle(probe).color; probe.remove(); return color; });
    assert.equal(cssSelectorColor, tdsIdentifierColor, 'CSS selector color shares the TDS identifier palette');
    assert.equal(cssPropertyColor, cssTdsPropertyColor, 'CSS property color shares the TDS property palette');
    assert.equal(minimapCssSelectorColor, tdsIdentifierColor, 'CSS minimap selector color shares the TDS identifier palette');
    assert.equal(minimapCssPropertyColor, cssTdsPropertyColor, 'CSS minimap property color shares the TDS property palette');
    await page.goto(`${base}/player.html`);
    await page.locator('#screen-overlay [data-action="start"]').waitFor();
    assert.equal(await page.locator('#screen-overlay [data-action="start"]').count(), 1, 'Browser Player loads the corrected authored screen');
    console.log('PASS screen authoring: source links, code-editor HTML/CSS editing and save, modal traversal, Browser Player load');
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
    if (oldProjectRoot === undefined) delete process.env.NOVEL_PROJECT_ROOT;
    else process.env.NOVEL_PROJECT_ROOT = oldProjectRoot;
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
