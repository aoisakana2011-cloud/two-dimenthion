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
  const nextProjectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-editor-quick-access-next-'));
  const previousProjectRoot = process.env.NOVEL_PROJECT_ROOT;
  const layout = seedEmptyProject(projectRoot);
  const targetPath = path.join(layout.scenesRoot, 'chapters', 'target.tds');
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, 'fn bonus() -> int {\n  return 1\n}\nscene target {\n  say narrator "target"\n}\n', 'utf8');
  const nextLayout = seedEmptyProject(nextProjectRoot);
  await fs.writeFile(path.join(nextLayout.scenesRoot, 'new-project.tds'), 'fn new_project_symbol() -> int {\n  return 2\n}\nscene new_project { wait 1 }\n', 'utf8');
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
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Accessibility.enable');
    const axNodes = async () => (await cdp.send('Accessibility.getFullAXTree')).nodes;
    await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
    const editor = page.locator('#editor');
    const quick = page.locator('#quick-access');
    const input = page.locator('#quick-access-input');
    await editor.waitFor();
    await page.waitForFunction(() => document.querySelectorAll('#file-tree .scene-file').length >= 2);
    const explorer = page.locator('#file-tree');
    assert.equal(await explorer.getAttribute('role'), 'group', 'the Explorer exposes an ordinary keyboard-operable group instead of an incomplete ARIA tree widget');
    const folderToggle = explorer.locator('.scene-folder-toggle').filter({ hasText: 'senario' }).first();
    await folderToggle.focus();
    assert.equal(await folderToggle.getAttribute('aria-expanded'), 'false');
    await page.keyboard.press('Enter');
    assert.equal(await folderToggle.getAttribute('aria-expanded'), 'true', 'Enter expands a folder disclosure');
    const chapterToggle = explorer.locator('.scene-folder-toggle').filter({ hasText: 'chapters' }).first();
    await chapterToggle.focus();
    await page.keyboard.press('Space');
    assert.equal(await chapterToggle.getAttribute('aria-expanded'), 'true', 'Space expands a nested folder disclosure');
    const chapterFile = explorer.locator('[data-path="senario/chapters/target.tds"] .scene-file-open');
    await chapterFile.waitFor();
    assert.equal(await chapterFile.getAttribute('aria-label'), 'senario/chapters/target.tds', 'Explorer file actions expose the complete path for duplicate basenames');
    await page.keyboard.press('Space');
    assert.equal(await chapterToggle.getAttribute('aria-expanded'), 'false', 'Space collapses the focused folder disclosure');

    const tabs = page.locator('#editor-tabs');
    assert.equal(await tabs.getAttribute('role'), 'group');
    assert.equal(await tabs.locator('[role="tab"]').count(), 0, 'document tabs do not claim the ARIA tab pattern without its arrow-key behavior');
    const activeDocumentButton = tabs.locator('.editor-tab.active .editor-tab-name');
    await activeDocumentButton.waitFor();
    assert.equal(await activeDocumentButton.getAttribute('aria-pressed'), 'true', 'active document selection is exposed as a pressed button');
    const activeDocumentName = await activeDocumentButton.getAttribute('aria-label');
    const tabsAx = await axNodes();
    assert.ok(tabsAx.some(node => node.role?.value === 'group' && node.name?.value === '開いているファイル'), 'Edge exposes the named open-document group');
    assert.ok(tabsAx.some(node => node.role?.value === 'button' && node.name?.value === activeDocumentName), 'Edge exposes the active document selector as a named button');

    await page.keyboard.press('Control+Shift+p');
    assert.equal(await quick.isVisible(), true, 'Ctrl+Shift+P opens the command palette');
    assert.equal(await input.evaluate((element) => element === document.activeElement), true, 'palette input receives focus');
    assert.equal(await input.getAttribute('role'), 'combobox');
    assert.equal(await input.getAttribute('placeholder'), '> Search commands');
    assert.equal(await input.getAttribute('aria-label'), 'Search commands or files');
    assert.equal(await input.getAttribute('aria-expanded'), 'true');
    assert.equal(await input.getAttribute('aria-controls'), 'quick-access-results');
    const paletteAx = await axNodes();
    assert.ok(paletteAx.some(node => node.role?.value === 'dialog' && node.name?.value === 'Search commands or files'), 'Edge AX tree exposes the named modal dialog');
    assert.ok(paletteAx.some(node => node.role?.value === 'combobox' && node.name?.value === 'Search commands or files'), 'Edge AX tree exposes the named combobox');
    assert.ok(paletteAx.some(node => node.role?.value === 'listbox' && node.name?.value === '候補'), 'Edge AX tree exposes the candidate listbox');
    const activeOptionId = await input.getAttribute('aria-activedescendant');
    assert.ok(activeOptionId && await page.locator(`#${activeOptionId}`).getAttribute('role') === 'option', 'combobox points to its selected listbox option');
    assert.ok(paletteAx.some(node => node.role?.value === 'option' && node.name?.value), 'Edge AX tree exposes named candidate options');
    await input.press('Tab');
    assert.equal(await quick.locator('[role="dialog"]').evaluate(element => element.contains(document.activeElement)), true, 'Tab remains inside the modal');
    await page.keyboard.press('Shift+Tab');
    assert.equal(await quick.locator('[role="dialog"]').evaluate(element => element.contains(document.activeElement)), true, 'Shift+Tab remains inside the modal');
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

    const opener = page.locator('[data-menu="file"]');
    await opener.focus();
    await page.evaluate(() => openQuickAccess('command'));
    await input.press('Escape');
    await page.waitForFunction(() => document.querySelector('#quick-access')?.hidden);
    assert.equal(await opener.evaluate((element) => element === document.activeElement), true, 'Escape restores focus to the Quick Access opener');

    await page.keyboard.press('Control+p');
    assert.equal(await quick.isVisible(), true, 'Ctrl+P opens quick file navigation');
    assert.equal(await input.getAttribute('placeholder'), 'Search files');
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
    await page.evaluate(() => refreshScenes());
    let releaseOldWorkspaceResponse;
    let oldWorkspaceRequestStarted;
    const oldWorkspaceRequest = new Promise((resolve) => { oldWorkspaceRequestStarted = resolve; });
    await page.route('**/api/scene?name=chapters%2Ftarget.tds', async (route) => {
      oldWorkspaceRequestStarted();
      await new Promise((resolve) => { releaseOldWorkspaceResponse = resolve; });
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        name: 'chapters/target.tds', source: 'fn stale_old_project_symbol() -> int { return 1 }', revision: 'stale',
      }) });
    });
    await page.keyboard.press('Control+t');
    await input.fill('#');
    await oldWorkspaceRequest;
    await page.evaluate(async (root) => { updateDirtyState(false); await openProjectAt(root); }, nextProjectRoot);
    await page.locator('.quick-access-item').filter({ hasText: 'new_project_symbol' }).waitFor();
    releaseOldWorkspaceResponse();
    await page.waitForTimeout(100);
    assert.equal(await page.locator('.quick-access-item').filter({ hasText: 'stale_old_project_symbol' }).count(), 0, 'a workspace-symbol response from the previous project cannot replace refreshed results');
    assert.ok(await page.locator('.quick-access-item').filter({ hasText: 'new_project_symbol' }).count() > 0, 'Quick Access refreshes symbols for the newly opened project');
    await page.unroute('**/api/scene?name=chapters%2Ftarget.tds');

    await input.press('Escape');
    await editor.fill('scene main {\n  say narrator true\n}\n');
    await page.keyboard.press('Control+Enter');
    const diagnostic = page.locator('#result .diagnostic-link').first();
    await diagnostic.waitFor();
    const diagnosticAx = await axNodes();
    assert.ok(diagnosticAx.some(node => node.role?.value === 'button' && /エラー|error/.test(node.name?.value || '')), 'Edge AX tree exposes diagnostics as named buttons');
    assert.ok(diagnosticAx.some(node => node.role?.value === 'region' && node.name?.value === '検証結果'), 'Edge AX tree exposes Problems as a named region');
    await page.keyboard.press('Control+Shift+m');
    assert.equal(await page.locator('#result').evaluate(element => element === document.activeElement), true, 'Problems shortcut focuses the diagnostics region');
    await page.keyboard.press('Tab');
    assert.equal(await diagnostic.evaluate(element => element === document.activeElement), true, 'diagnostics can be reached by keyboard');
    await page.keyboard.press('Enter');
    assert.equal(await editor.evaluate(element => element.selectionStart), await editor.evaluate(element => element.value.indexOf('say narrator')), 'activating a diagnostic moves selection to its source line');

    await page.keyboard.press('Escape');
    await editor.fill('say narrator "one"\nsay narrator "two"');
    await editor.evaluate((element) => element.setSelectionRange(0, element.value.length));
    await page.keyboard.press('Control+/');
    assert.match(await editor.inputValue(), /^# say narrator "one"\n# say narrator "two"$/, 'Ctrl+/ comments every selected line');
    await page.keyboard.press('Control+k');
    await page.keyboard.press('Control+u');
    assert.equal(await editor.inputValue(), 'say narrator "one"\nsay narrator "two"', 'Ctrl+K Ctrl+U uncomments selected lines');

    await editor.fill('x'.repeat(800));
    const noWrapMetrics = await editor.evaluate((element) => ({ whiteSpace: getComputedStyle(element).whiteSpace, clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }));
    assert.equal(noWrapMetrics.whiteSpace, 'pre', 'the editor does not visually wrap long lines by default');
    assert.ok(noWrapMetrics.scrollWidth > noWrapMetrics.clientWidth, 'long lines remain horizontally scrollable');
    await page.keyboard.press('Alt+z');
    assert.equal(await page.locator('.app-shell').evaluate((element) => element.classList.contains('word-wrap-on')), true, 'Alt+Z enables optional word wrapping');
    assert.equal(await editor.evaluate((element) => getComputedStyle(element).whiteSpace), 'pre-wrap');
    await page.keyboard.press('Alt+z');
    assert.equal(await page.locator('.app-shell').evaluate((element) => element.classList.contains('word-wrap-on')), false, 'Alt+Z restores horizontal scrolling');

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
    await fs.rm(nextProjectRoot, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
