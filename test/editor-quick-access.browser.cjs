'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('../build/audit-tools/node_modules/playwright');
const { seedEmptyProject } = require('../tools/project-layout');

async function main() {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-editor-quick-access-'));
  const previousProjectRoot = process.env.NOVEL_PROJECT_ROOT;
  const layout = seedEmptyProject(projectRoot);
  const targetPath = path.join(layout.scenesRoot, 'chapters', 'target.tds');
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, 'fn bonus() -> int {\n  return 1\n}\nscene target {\n  say narrator "target"\n}\n', 'utf8');
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
    const quick = page.locator('#quick-access');
    const input = page.locator('#quick-access-input');
    await editor.waitFor();
    await page.waitForFunction(() => document.querySelectorAll('#file-tree .scene-file').length >= 2);

    await page.keyboard.press('Control+Shift+p');
    assert.equal(await quick.isVisible(), true, 'Ctrl+Shift+P opens the command palette');
    assert.equal(await input.evaluate((element) => element === document.activeElement), true, 'palette input receives focus');
    await input.fill('>Ctrl+B');
    await page.locator('.quick-access-item').first().waitFor();
    await page.waitForTimeout(100);
    const filteredCommandText = await page.locator('.quick-access-item').first().textContent();
    assert.match(filteredCommandText, /Ctrl\+B/, `fuzzy search ranks the sidebar command first; got ${filteredCommandText}`);
    await page.keyboard.press('Enter');
    assert.equal(await quick.isVisible(), false, 'running a command closes the palette');
    assert.equal(await page.locator('.app-shell').evaluate((element) => element.classList.contains('sidebar-hidden')), true, 'palette invokes an existing view command');

    await page.keyboard.press('F1');
    await input.fill('>Ctrl+B');
    await page.waitForTimeout(100);
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('.app-shell').evaluate((element) => element.classList.contains('sidebar-hidden')), false, 'recent commands can be rerun');

    await page.keyboard.press('Control+p');
    assert.equal(await quick.isVisible(), true, 'Ctrl+P opens quick file navigation');
    await input.fill('target');
    const targetItem = page.locator('.quick-access-item').filter({ hasText: 'chapters/target.tds' }).first();
    await targetItem.waitFor();
    await targetItem.click();
    await page.waitForFunction(() => document.querySelector('#scene-name').value === 'chapters/target.tds');

    await page.keyboard.press('Control+g');
    assert.equal(await quick.isVisible(), true, 'Ctrl+G opens line navigation');
    assert.equal(await input.evaluate((element) => element === document.activeElement), true, 'line search receives focus on open');
    await input.fill(':5:3');
    const lineItem = page.locator('.quick-access-item').filter({ hasText: '行 5' }).first();
    await lineItem.waitFor();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(50);
    assert.equal(await quick.isVisible(), false, 'choosing a line closes quick access');
    const jumpedLine = await editor.evaluate((element) => element.value.slice(0, element.selectionStart).split('\n').length);
    assert.equal(jumpedLine, 5, 'Ctrl+G navigates to the requested line');

    await page.keyboard.press('Control+Shift+o');
    await input.fill('@target');
    await page.locator('.quick-access-item').filter({ hasText: 'target' }).first().waitFor();
    await page.locator('.quick-access-item').filter({ hasText: 'target' }).first().click();
    assert.equal(await editor.evaluate((element) => element.value.slice(element.selectionStart, element.selectionEnd)), 'target', 'current-file symbol navigation selects its declaration');

    await page.keyboard.press('Control+t');
    await input.fill('#bonus');
    const workspaceSymbol = page.locator('.quick-access-item').filter({ hasText: 'bonus' }).first();
    await workspaceSymbol.waitFor({ timeout: 10000 });
    assert.match(await workspaceSymbol.textContent(), /chapters\/target\.tds/, 'workspace symbols include declarations from other files');

    await input.press('Escape');
    await editor.fill('say narrator "one"\nsay narrator "two"');
    await editor.evaluate((element) => element.setSelectionRange(0, element.value.length));
    await page.keyboard.press('Control+/');
    assert.match(await editor.inputValue(), /^# say narrator "one"\n# say narrator "two"$/, 'Ctrl+/ comments every selected line');
    await page.keyboard.press('Control+k');
    await page.keyboard.press('Control+u');
    assert.equal(await editor.inputValue(), 'say narrator "one"\nsay narrator "two"', 'Ctrl+K Ctrl+U uncomments selected lines');

    await page.keyboard.press('Alt+z');
    assert.equal(await page.locator('.app-shell').evaluate((element) => element.classList.contains('word-wrap-off')), true, 'Alt+Z toggles persisted word wrapping');
    await page.keyboard.press('Alt+z');
    assert.equal(await page.locator('.app-shell').evaluate((element) => element.classList.contains('word-wrap-off')), false);

    await page.keyboard.press('Control+Shift+e');
    assert.equal(await page.locator('#file-tree').evaluate((element) => element === document.activeElement), true, 'Ctrl+Shift+E focuses the explorer tree');

    await editor.fill('scene main{say narrator "x"}');
    await page.keyboard.press('Control+Shift+f');
    assert.match(await editor.inputValue(), /scene main\s*\{\s*\n/, 'Ctrl+Shift+F still formats rather than opening find');
    assert.equal(await page.locator('#editor-find').isVisible(), false, 'format shortcut does not open find');
    await page.keyboard.press('Escape');
    console.log('PASS editor quick access: command palette, recents, file/line/symbol navigation, comments, wrap and shortcut compatibility');
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
    if (previousProjectRoot === undefined) delete process.env.NOVEL_PROJECT_ROOT;
    else process.env.NOVEL_PROJECT_ROOT = previousProjectRoot;
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
