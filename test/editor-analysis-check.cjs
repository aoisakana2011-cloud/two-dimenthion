const { chromium } = require('../build/audit-tools/node_modules/playwright');
const { parse } = require('../dist');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { seedEmptyProject } = require('../tools/project-layout');
const assert = require('node:assert/strict');

(async () => {
  const auditProjectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-editor-analysis-'));
  const previousProjectRoot = process.env.NOVEL_PROJECT_ROOT;
  const auditLayout = seedEmptyProject(auditProjectRoot);
  await fs.mkdir(path.join(auditLayout.assetsRoot, 'bg'), { recursive: true });
  await fs.copyFile(path.resolve(__dirname, '../Title/asset/bg/title.png'), path.join(auditLayout.assetsRoot, 'bg', 'preview-test.png'));
  await fs.writeFile(path.join(auditLayout.assetsRoot, 'bg', 'invalid-preview.png'), 'not an image', 'utf8');
  const previewWav = Buffer.alloc(44 + 32_000);
  previewWav.write('RIFF', 0); previewWav.writeUInt32LE(previewWav.length - 8, 4); previewWav.write('WAVE', 8);
  previewWav.write('fmt ', 12); previewWav.writeUInt32LE(16, 16); previewWav.writeUInt16LE(1, 20); previewWav.writeUInt16LE(1, 22);
  previewWav.writeUInt32LE(8000, 24); previewWav.writeUInt32LE(8000, 28); previewWav.writeUInt16LE(1, 32); previewWav.writeUInt16LE(8, 34);
  previewWav.write('data', 36); previewWav.writeUInt32LE(previewWav.length - 44, 40);
  await fs.writeFile(path.join(auditLayout.assetsRoot, 'bg', 'preview-test.wav'), previewWav);
  await fs.copyFile(path.resolve(__dirname, 'fixtures/asset-preview.webm'), path.join(auditLayout.assetsRoot, 'bg', 'preview-test.webm'));
  await fs.writeFile(path.join(auditLayout.scenesRoot, 'analysis-side.tds'), 'scene analysis_side { choice { "continue" { goto analysis_side_target } "open chapter" { goto "analysis-target.tds" } } }\nscene analysis_side_target { wait 1 }\n');
  await fs.writeFile(path.join(auditLayout.scenesRoot, 'analysis-target.tds'), 'scene analysis_target { wait 1 }\n');
  await fs.writeFile(path.join(auditLayout.scenesRoot, 'navigation-slow.tds'), 'scene slow {\n  wait 11\n}\n');
  await fs.writeFile(path.join(auditLayout.scenesRoot, 'navigation-fast.tds'), 'scene fast {\n  wait 22\n}\n');
  await fs.writeFile(path.join(auditLayout.settingsRoot, 'navigation-slow.txt'), 'slow setting response\n');
  await fs.writeFile(path.join(auditLayout.settingsRoot, 'navigation-fast.txt'), 'fast setting response\n');
  await fs.writeFile(path.join(auditLayout.scenesRoot, 'diagnostic-module.tds'), 'asset image absent = "asset/__missing_from_included_module__.png"\n');
  const validSyntaxDiagnosticModuleSource = 'fn healthy() -> none {\n}\n';
  const syntaxDiagnosticModulePath = path.join(auditLayout.scenesRoot, 'syntax-diagnostic-module.tds');
  await fs.writeFile(syntaxDiagnosticModulePath, validSyntaxDiagnosticModuleSource, 'utf8');
  await fs.writeFile(path.join(auditLayout.assetsRoot, 'char', 'aokami.png'), Buffer.alloc(0));
  await fs.writeFile(path.join(auditLayout.dataRoot, 'variables.json'), JSON.stringify({ staticVariables: [
    { name: 'route', type: 'str', value: 'summer', possibleValues: ['summer', 'winter'] },
    { name: 'score', type: 'int', value: '0', min: '0', max: '9' },
  ] }, null, 2));
  process.env.NOVEL_PROJECT_ROOT = auditProjectRoot;
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
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    page.setDefaultTimeout(10_000);
    const pageErrors = [];
    const failedRequests = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('requestfailed', (request) => failedRequests.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText || 'unknown error'}`));
    const saveAllFromMenu = async () => {
      await page.locator('[data-menu="file"]').click();
      await page.locator('[data-menu-action="save"]').click();
    };
    const rightClickToken = async (line, name) => {
      await editor.evaluate((element, target) => {
      const source = element.value;
      const sourceLine = source.split(/\r?\n/)[target.line - 1];
      const index = sourceLine.indexOf(target.name);
      if (index < 0) throw new Error(`token '${target.name}' is not on line ${target.line}`);
      const absolute = source.split(/\r?\n/).slice(0, target.line - 1).reduce((offset, value) => offset + value.length + 1, 0) + index;
      const walker = document.createTreeWalker(document.querySelector('#highlight'), NodeFilter.SHOW_TEXT);
      let offset = 0, rect = null;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (absolute >= offset && absolute < offset + node.length) {
          const range = document.createRange();
          range.setStart(node, absolute - offset);
          range.setEnd(node, absolute - offset + 1);
          rect = range.getBoundingClientRect();
          break;
        }
        offset += node.length;
      }
      if (!rect) throw new Error(`could not locate rendered token '${target.name}'`);
      element.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
      }));
      }, { line, name });
      const menuItems = page.locator('.editor-context-item');
      await menuItems.nth(1).waitFor({ state: 'visible' });
      await menuItems.nth(1).click();
    };
    await page.goto(`${base}/index.html`);
    const editor = page.locator('#editor');
    await editor.waitFor();
    const fileMenuTrigger = page.locator('[data-menu="file"]');
    await fileMenuTrigger.focus();
    await page.keyboard.press('ArrowDown');
    assert.equal(await fileMenuTrigger.getAttribute('aria-expanded'), 'true');
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.menuAction), 'open-project', 'ArrowDown opens a menu at its first item');
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.menuAction), 'project-settings', 'ArrowDown moves between menu items');
    await page.keyboard.press('End');
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.menuAction), 'save', 'End moves to the last menu item');
    await page.keyboard.press('Home');
    await page.keyboard.press('Escape');
    assert.equal(await fileMenuTrigger.getAttribute('aria-expanded'), 'false');
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.menu), 'file', 'Escape closes the menu and restores focus to its trigger');
    const preEscapeDiagnosticSource = await editor.inputValue();
    const escapeSource = String.raw`str value = "a\nb\q"`;
    await page.evaluate(async (source) => { editor.value = source; await validate(); }, escapeSource);
    assert.match(await page.locator('#result').textContent(), /1:19.*\u4e0d\u660e\u306a escape sequence/, 'Browser IDE reports the source column and localized unknown-escape diagnostic');
    await page.evaluate(async (source) => { editor.value = source; await validate(); }, preEscapeDiagnosticSource);
    assert.equal(await page.locator('#result').getAttribute('aria-live'), null, 'the detailed diagnostic list is not repeatedly announced as a live region');
    assert.equal(await page.locator('#status').getAttribute('role'), 'status', 'the concise validation summary remains available to screen readers');
    await page.evaluate(() => { window.__quickAccessOpener = document.activeElement; openCommandPalette(); });
    const commandPalette = page.locator('#quick-access .quick-access-panel');
    await page.locator('#quick-access-input').waitFor({ state: 'visible' });
    assert.equal(await commandPalette.getAttribute('aria-modal'), 'true');
    await page.keyboard.press('Tab');
    assert.equal(await commandPalette.evaluate((dialog) => dialog.contains(document.activeElement)), true, 'command palette focus remains in its modal dialog');
    await page.keyboard.press('Shift+Tab');
    assert.equal(await commandPalette.evaluate((dialog) => dialog.contains(document.activeElement)), true, 'command palette reverse tab remains in its modal dialog');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('#quick-access')?.hidden);
    assert.equal(await page.evaluate(() => document.activeElement === window.__quickAccessOpener || (window.__quickAccessOpener === document.body && document.activeElement === document.querySelector('#editor'))), true, 'closing command palette restores its opener, with the Editor as the fallback for body focus');
    const initialSceneGraph = await page.evaluate(async () => (await (await fetch('/api/scene-graph')).json()));
    assert.deepEqual(initialSceneGraph.nodes.find((node) => node.id === 'analysis-side.tds')?.localGotos?.map((item) => item.scene), ['analysis_side_target']);
    const apiExternalGoto = initialSceneGraph.edges.find((edge) => edge.from === 'analysis-side.tds' && edge.to === 'analysis-target.tds');
    assert.ok(apiExternalGoto, 'file-target goto is represented as a Scene Flow connection');
    assert.equal(apiExternalGoto.transitions[0].fromScene, 'analysis_side');
    assert.equal(apiExternalGoto.transitions[0].toScene, 'analysis_target');
    assert.equal(apiExternalGoto.transitions[0].choice, 'open chapter');
    assert.ok(apiExternalGoto.transitions[0].line > 0);
    const originalEditorSource = await editor.inputValue();
    const originalSceneName = await page.locator('#scene-name').inputValue();
    const originalOpenTabs = await page.evaluate(() => [...openTabs]);
    await page.evaluate(() => updateDirtyState(false));
    const originalRevision = await page.request.get(`${base}/api/scene?name=${encodeURIComponent(originalSceneName)}`).then((response) => response.json());
    const externallySavedSource = 'scene external_version { wait 22 }\n';
    const localConflictDraft = 'scene local_version { wait 11 }\n';
    const formattedConflictDraft = 'scene local_version {\n  wait 11\n}\n';
    const externalWrite = await page.request.put(`${base}/api/scene`, { data: { name: originalSceneName, source: externallySavedSource, expectedRevision: originalRevision.revision } });
    assert.equal(externalWrite.status(), 200, 'external source update succeeds against the loaded revision');
    await editor.fill(localConflictDraft);
    assert.equal(await page.locator('.dirty-mark').evaluate((element) => element.classList.contains('visible')), true, 'local edits mark the active document dirty before save');
    await page.locator('[data-menu="file"]').click();
    const localSaveResponse = page.waitForResponse((response) => response.url().includes('/api/scene') && response.request().method() === 'PUT');
    await page.locator('[data-menu-action="save"]').click();
    assert.equal((await localSaveResponse).status(), 409, 'Editor save surfaces the server revision conflict');
    await page.waitForFunction(() => document.querySelector('#status')?.textContent.includes('失敗しました'));
    assert.equal(await editor.inputValue(), formattedConflictDraft, '409 conflict keeps the formatted local draft in the editor');
    assert.equal(await page.locator('.dirty-mark').evaluate((element) => element.classList.contains('visible')), true, '409 conflict does not clear the dirty indicator');
    assert.equal((await page.request.get(`${base}/api/scene?name=${encodeURIComponent(originalSceneName)}`).then((response) => response.json())).source, externallySavedSource, 'the failed local save does not overwrite the external version');
    const restoreOriginal = await page.request.put(`${base}/api/scene`, { data: { name: originalSceneName, source: originalEditorSource } });
    assert.equal(restoreOriginal.status(), 200);
    await page.evaluate((name) => { updateDirtyState(false); return openScene(name); }, originalSceneName);
    await page.waitForFunction((source) => document.querySelector('#editor')?.value === source, originalEditorSource);
    await page.route('**/api/scene?name=navigation-slow.tds', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 350));
      await route.continue();
    });
    await page.evaluate(async () => {
      const slow = jumpToLocation({ file: 'navigation-slow.tds', line: 2 });
      await new Promise((resolve) => setTimeout(resolve, 25));
      const fast = jumpToLocation({ file: 'navigation-fast.tds', line: 2 });
      await Promise.all([slow, fast]);
    });
    assert.equal(await page.locator('#scene-name').inputValue(), 'navigation-fast.tds', 'a slower earlier cross-file diagnostic jump cannot replace the later requested document');
    assert.equal(await editor.inputValue(), 'scene fast {\n  wait 22\n}\n');
    await page.unroute('**/api/scene?name=navigation-slow.tds');
    await page.route('**/api/setting-file**', async (route) => {
      if (route.request().url().includes('navigation-slow.txt')) await new Promise((resolve) => setTimeout(resolve, 350));
      await route.continue();
    });
    await page.evaluate(async () => {
      const slow = openSettingFile('setting/navigation-slow.txt');
      await new Promise((resolve) => setTimeout(resolve, 25));
      const fast = openScene('navigation-fast.tds');
      await Promise.all([slow, fast]);
    });
    assert.equal(await page.locator('#scene-name').inputValue(), 'navigation-fast.tds', 'a stale setting-file response cannot replace a later scene navigation');
    assert.equal(await editor.inputValue(), 'scene fast {\n  wait 22\n}\n');
    await page.unroute('**/api/setting-file**');
    await page.route('**/api/scene?name=navigation-slow.tds', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 350));
      await route.continue();
    });
    await page.evaluate(async () => {
      const slow = openScene('navigation-slow.tds');
      await new Promise((resolve) => setTimeout(resolve, 25));
      const fast = openSettingFile('setting/navigation-fast.txt');
      await Promise.all([slow, fast]);
    });
    assert.equal(await page.locator('#scene-name').inputValue(), 'setting/navigation-fast.txt', 'a later setting-file navigation invalidates a stale scene response');
    assert.equal(await editor.inputValue(), 'fast setting response\n');
    await page.unroute('**/api/scene?name=navigation-slow.tds');
    await page.route('**/api/setting-file**', async (route) => {
      if (route.request().url().includes('navigation-slow.txt')) await new Promise((resolve) => setTimeout(resolve, 350));
      await route.continue();
    });
    await page.evaluate(async () => {
      const slow = openSettingFile('setting/navigation-slow.txt');
      await new Promise((resolve) => setTimeout(resolve, 25));
      const fast = openAssetDocument('asset/bg/preview-test.png');
      await Promise.all([slow, fast]);
    });
    assert.equal(await page.locator('#asset-document-viewer').isVisible(), true, 'a stale setting-file response cannot replace a later asset preview');
    assert.equal(await page.locator('#asset-document-path').textContent(), 'asset/bg/preview-test.png');
    await page.unroute('**/api/setting-file**');
    await page.evaluate((name) => openScene(name), originalSceneName);
    await page.evaluate(({ tabs, active }) => { openTabs.splice(0, openTabs.length, ...tabs); renderEditorTabs(active); }, { tabs: originalOpenTabs, active: originalSceneName });
    await editor.fill(originalEditorSource);
    await editor.evaluate((element) => { element.style.lineHeight = '100px'; });
    await editor.fill(Array(300).fill('wait 1').join('\n'));
    await page.waitForFunction(() => document.querySelector('#editor').scrollHeight > document.querySelector('#editor').clientHeight * 10);
    await editor.evaluate((element) => { element.scrollTop = (element.scrollHeight - element.clientHeight) * 0.6; });
    await page.waitForTimeout(50);
    await editor.evaluate((element) => element.dispatchEvent(new Event('scroll')));
    const minimapGeometry = async () => page.evaluate(() => {
      const editorElement = document.querySelector('#editor');
      const map = document.querySelector('#minimap');
      const viewport = document.querySelector('#minimap-viewport');
      const track = map.clientHeight;
      const range = Math.max(0, editorElement.scrollHeight - editorElement.clientHeight);
      const height = parseFloat(viewport.style.height);
      return { height, expectedHeight: Math.min(track, track * (range ? editorElement.clientHeight / editorElement.scrollHeight : 1)), top: parseFloat(viewport.style.top), scrollTop: editorElement.scrollTop, range, expectedTop: (range ? Math.max(0, Math.min(1, editorElement.scrollTop / range)) : 0) * Math.max(0, track - height) };
    });
    let minimapMetrics = await minimapGeometry();
    assert.ok(Math.abs(minimapMetrics.height - minimapMetrics.expectedHeight) < 0.75, 'minimap viewport height reflects the true visible fraction without an oversized minimum');
    assert.ok(Math.abs(minimapMetrics.top - minimapMetrics.expectedTop) < 0.75, `minimap viewport position follows the editor scroll position: ${JSON.stringify(minimapMetrics)}`);
    await page.setViewportSize({ width: 1600, height: 700 });
    await page.waitForFunction(() => {
      const editorElement = document.querySelector('#editor');
      const map = document.querySelector('#minimap');
      return map.clientHeight > 0 && editorElement.clientHeight > 0;
    });
    await page.waitForTimeout(50);
    minimapMetrics = await minimapGeometry();
    assert.ok(Math.abs(minimapMetrics.height - minimapMetrics.expectedHeight) < 0.75, `viewport indicator is recalculated after resizing the editor: ${JSON.stringify(minimapMetrics)}`);
    await page.setViewportSize({ width: 1600, height: 1000 });
    await editor.evaluate((element) => { element.style.lineHeight = ''; });
    await editor.fill(originalEditorSource);
    await editor.fill('include "std/');
    await page.waitForFunction(() => [...document.querySelectorAll('#suggestions .suggestion')].some((item) => item.textContent.includes('std/math.tds'))).catch(async (error) => {
      const state = await page.evaluate(() => ({
        status: document.querySelector('#status')?.textContent,
        suggestions: [...document.querySelectorAll('#suggestions .suggestion')].map((item) => item.textContent),
        visible: !document.querySelector('#suggestions')?.hidden,
      }));
      throw Error(`standard-library include completion did not render: ${JSON.stringify(state)}; page errors=${pageErrors.join(' | ')}; failed requests=${failedRequests.join(' | ')}; ${error.message}`);
    });
    await editor.fill('include "std/math.tds" as math\nfloat sample = math.si');
    await page.waitForFunction(() => [...document.querySelectorAll('#suggestions .suggestion')].some((item) => item.textContent.includes('sin')));
    await editor.fill(originalEditorSource);
    await page.evaluate(() => openScene('std/math.tds'));
    assert.equal(await editor.getAttribute('readonly'), '');
    assert.match(await editor.inputValue(), /fn sin/);
    await page.evaluate((name) => openScene(name), originalSceneName);
    await page.waitForFunction(() => !document.querySelector('#editor')?.readOnly);
    await page.locator('[data-activity="presentation"]').click();
    const presentationCardStyle = await page.locator('.presentation-card').first().evaluate((element) => ({
      background: getComputedStyle(element).backgroundColor,
      borderLeft: getComputedStyle(element).borderLeftWidth,
    }));
    assert.deepEqual(presentationCardStyle, { background: 'rgba(0, 0, 0, 0)', borderLeft: '0px' }, 'presentation guidance uses flat workbench sections rather than cards');
    await page.locator('[data-presentation-action="player-ui"]').click();
    const settingsGroupStyle = await page.locator('#ui-settings-fields').evaluate((element) => ({
      background: getComputedStyle(element).backgroundColor,
      borderLeft: getComputedStyle(element).borderLeftWidth,
    }));
    assert.deepEqual(settingsGroupStyle, { background: 'rgba(0, 0, 0, 0)', borderLeft: '0px' }, 'player settings groups are separated by rules instead of boxed cards');
    await page.locator('[data-ui-settings-section="message"]').click();
    const messageSize = page.locator('#ui-settings-fields label.ui-settings-field').filter({ hasText: '文字サイズ' }).locator('input[type="number"]').first();
    const originalMessageSize = Number(await messageSize.inputValue());
    const previewFrame = page.frameLocator('#ui-settings-player-preview');
    const liveMessage = previewFrame.locator('#text');
    await page.waitForFunction((size) => {
      const frame = document.querySelector('#ui-settings-player-preview');
      return frame?.contentDocument?.querySelector('#text')?.style.fontSize === `${size}px`;
    }, originalMessageSize);
    const editedMessageSize = originalMessageSize + 3;
    await messageSize.fill(String(editedMessageSize));
    await page.waitForFunction((size) => document.querySelector('#ui-settings-player-preview')?.contentDocument?.querySelector('#text')?.style.fontSize === `${size}px`, editedMessageSize);
    assert.equal(await page.locator('#ui-settings-dirty').isVisible(), true, 'field edits mark the theme draft dirty');
    assert.equal(await page.locator('#ui-settings-save').isEnabled(), true);
    await page.locator('#ui-settings-revert').click();
    assert.equal(Number(await page.locator('#ui-settings-fields label.ui-settings-field').filter({ hasText: '文字サイズ' }).locator('input[type="number"]').first().inputValue()), originalMessageSize);
    await page.waitForFunction((size) => document.querySelector('#ui-settings-player-preview')?.contentDocument?.querySelector('#text')?.style.fontSize === `${size}px`, originalMessageSize);
    assert.equal(await page.locator('#ui-settings-dirty').isVisible(), false, 'revert restores both the form and live Player preview');
    await page.locator('#ui-settings-fields label.ui-settings-field').filter({ hasText: '文字サイズ' }).locator('input[type="number"]').first().fill(String(editedMessageSize));
    await page.locator('#ui-settings-save').click();
    await page.waitForFunction(() => document.querySelector('#ui-settings-dirty')?.hidden === true);
    const savedPlayerTheme = await (await page.request.get(`${base}/api/player-ui`)).json();
    assert.equal(savedPlayerTheme.theme.dialog.message.size, editedMessageSize, 'Save persists the field-editor value through the real Player UI endpoint');
    assert.equal(await liveMessage.evaluate((element) => getComputedStyle(element).fontSize), `${editedMessageSize}px`, 'saved value remains applied to the live Player preview');
    await page.locator('[data-ui-settings-section="advanced"]').click();
    const themeJsonEditor = page.locator('#ui-settings-json');
    const invalidTheme = JSON.parse(await themeJsonEditor.inputValue());
    invalidTheme.dialog.message.size = -1;
    await themeJsonEditor.fill(JSON.stringify(invalidTheme, null, 2));
    assert.equal(await page.locator('#ui-settings-save').isEnabled(), true, 'Advanced JSON permits a syntactically valid draft to reach server validation');
    await page.locator('#ui-settings-save').click();
    await page.locator('#ui-settings-error').waitFor({ state: 'visible' });
    const afterRejectedTheme = await (await page.request.get(`${base}/api/player-ui`)).json();
    assert.deepEqual(afterRejectedTheme.theme, savedPlayerTheme.theme, 'invalid negative font size is rejected without replacing the saved theme');
    await page.locator('#ui-settings-revert').click();
    assert.equal(await page.locator('#ui-settings-dirty').isVisible(), false, 'revert clears the rejected Advanced JSON draft');
    for (const invalidFontSize of [13.5, 513]) {
      const invalidControlTheme = JSON.parse(await themeJsonEditor.inputValue());
      invalidControlTheme.controls = { enabled: true, anchor: 'stage', buttons: [{ action: 'save', fontSize: invalidFontSize }] };
      await themeJsonEditor.fill(JSON.stringify(invalidControlTheme, null, 2));
      if (invalidFontSize === 13.5) {
        await page.waitForFunction(() => document.querySelector('#ui-settings-player-preview')?.contentDocument?.querySelector('#player-controls button')?.style.fontSize === '13.5px');
      }
      await page.locator('#ui-settings-save').click();
      await page.locator('#ui-settings-error').waitFor({ state: 'visible' });
      const afterRejectedControlTheme = await (await page.request.get(`${base}/api/player-ui`)).json();
      assert.deepEqual(afterRejectedControlTheme.theme, savedPlayerTheme.theme, `control fontSize ${invalidFontSize} is rejected without replacing the saved theme`);
      await page.locator('#ui-settings-revert').click();
    }
    await page.locator('#ui-settings-preview-target').selectOption('message');
    const previewScale = await page.locator('#ui-settings-preview-stage').evaluate((element) => element.getBoundingClientRect().width / 1280);
    const messageBox = await page.locator('#ui-preview-message').boundingBox();
    const xField = page.locator('#ui-settings-fields label.ui-settings-field').filter({ hasText: /^X/ }).locator('input[type="number"]');
    const yField = page.locator('#ui-settings-fields label.ui-settings-field').filter({ hasText: /^Y/ }).locator('input[type="number"]');
    const widthField = page.locator('#ui-settings-fields label.ui-settings-field').filter({ hasText: /^幅/ }).locator('input[type="number"]');
    const heightField = page.locator('#ui-settings-fields label.ui-settings-field').filter({ hasText: /^高さ/ }).locator('input[type="number"]');
    const xBeforeDrag = Number(await xField.inputValue());
    const yBeforeDrag = Number(await yField.inputValue());
    await page.mouse.move(messageBox.x + messageBox.width / 2, messageBox.y + messageBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(messageBox.x + messageBox.width / 2 + 16 * previewScale, messageBox.y + messageBox.height / 2 + 8 * previewScale, { steps: 2 });
    await page.mouse.up();
    assert.equal(Number(await xField.inputValue()), xBeforeDrag + 16, 'dragging the message preview updates its logical X coordinate');
    assert.equal(Number(await yField.inputValue()), yBeforeDrag + 8, 'dragging the message preview updates its logical Y coordinate');
    await page.waitForFunction(({ x, y }) => {
      const text = document.querySelector('#ui-settings-player-preview')?.contentDocument?.querySelector('#text');
      return text?.style.left === `${x}px` && text?.style.top === `${y}px`;
    }, { x: xBeforeDrag + 16, y: yBeforeDrag + 8 });
    const widthBeforeResize = Number(await widthField.inputValue());
    const heightBeforeResize = Number(await heightField.inputValue());
    const resizeBox = await page.locator('#ui-preview-resize-handle').boundingBox();
    await page.mouse.move(resizeBox.x + resizeBox.width / 2, resizeBox.y + resizeBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(resizeBox.x + resizeBox.width / 2 + 16 * previewScale, resizeBox.y + resizeBox.height / 2 + 8 * previewScale, { steps: 2 });
    await page.mouse.up();
    assert.equal(Number(await widthField.inputValue()), widthBeforeResize + 16, 'resizing the message preview updates its logical width');
    assert.equal(Number(await heightField.inputValue()), heightBeforeResize + 8, 'resizing the message preview updates its logical height');
    await page.waitForFunction(({ width, height }) => {
      const text = document.querySelector('#ui-settings-player-preview')?.contentDocument?.querySelector('#text');
      return text?.style.width === `${width}px` && text?.style.height === `${height}px`;
    }, { width: widthBeforeResize + 16, height: heightBeforeResize + 8 });
    await page.locator('#ui-settings-revert').click();
    assert.equal(await page.locator('#ui-settings-dirty').isVisible(), false, 'revert restores the saved theme after move and resize');
    await page.locator('[data-activity="presentation"]').click();
    await page.locator('[data-presentation-action="game-screens"]').click();
    const gameScreenDialogStyle = await page.locator('.game-screen-settings').evaluate((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const close = element.querySelector('.project-settings-close').getBoundingClientRect();
      return { background: style.backgroundColor, border: style.borderColor, radius: style.borderRadius, width: Math.round(rect.width), closeWidth: Math.round(close.width), closeHeight: Math.round(close.height) };
    });
    assert.deepEqual(gameScreenDialogStyle, { background: 'rgb(37, 37, 38)', border: 'rgb(60, 60, 60)', radius: '3px', width: 1000, closeWidth: 26, closeHeight: 26 }, 'game-screen editor dialog uses a compact neutral workbench surface and compact close control');
    assert.equal(await page.locator('.game-screen-settings').getAttribute('aria-labelledby')?.then(async (id) => page.locator(`#${id}`).count()), 1, 'modal dialog is named by its visible heading');
    await page.locator('.game-screen-settings button:not(:disabled)').last().focus();
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('project-settings-close')), true, 'Tab wraps from the last game-screen dialog control to its close button');
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.locator('.game-screen-settings').evaluate((dialog) => dialog.contains(document.activeElement)), true, 'Shift+Tab remains inside the modal dialog');
    assert.equal(await page.locator('body').evaluate((body) => getComputedStyle(body, '::before').position), 'fixed', 'modal backdrop blocks interaction with the editor behind the dialog');
    await page.locator('.game-screen-settings .project-settings-close').click();
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-presentation-action')), 'game-screens', 'closing a modal restores focus to the control that opened it');
    await page.locator('[data-menu="file"]').click();
    await page.locator('[data-menu-action="project-settings"]').click();
    const projectSettings = page.locator('.project-settings');
    await projectSettings.waitFor();
    assert.equal(await projectSettings.getByText('Start Scene', { exact: true }).count(), 1);
    assert.equal(await projectSettings.getByText('Scenario Folder', { exact: true }).count(), 1);
    assert.equal(await projectSettings.getByText('Asset Folder', { exact: true }).count(), 1);
    assert.equal(await projectSettings.locator('h2').filter({ hasText: /^Assets$/ }).count(), 1);
    assert.equal(await page.locator('#asset-document-viewer').getAttribute('aria-label'), 'Asset file preview');
    assert.equal(await page.locator('#asset-document-metadata').getAttribute('aria-label'), 'Asset details');
    await projectSettings.locator('.project-settings-close').click();
    await page.locator('[data-activity="explorer"]').click();
    const assetFolder = page.locator('.scene-folder[data-path="asset"]');
    await assetFolder.click();
    const assetSubfolder = page.locator('.scene-folder[data-path="asset/bg"]');
    await assetSubfolder.click();
    await page.locator('.scene-file[data-path="asset/bg/preview-test.png"] .scene-file-open').click();
    await page.waitForFunction(() => document.querySelector('#asset-document-image')?.naturalWidth > 0);
    assert.equal(await page.locator('#asset-document-viewer').isVisible(), true);
    assert.equal(await page.locator('#editor').getAttribute('readonly'), '');
    assert.deepEqual(await page.locator('#asset-document-metadata dt').allTextContents(), ['Width', 'Height', 'Aspect Ratio', 'Pixel Count', 'Orientation', 'Format', 'File Size', 'Modified', 'Duration']);
    assert.ok(parseInt(await page.locator('[data-asset-meta="width"]').textContent(), 10) > 0);
    assert.ok(parseInt(await page.locator('[data-asset-meta="height"]').textContent(), 10) > 0);
    assert.equal(await page.locator('[data-asset-meta="orientation"]').textContent(), 'Landscape');
    const loadedAssetSource = await editor.inputValue();
    await editor.focus();
    await page.keyboard.type('a');
    assert.equal(await editor.inputValue(), loadedAssetSource, 'Asset Preview keeps the source editor read-only');
    await page.locator('.scene-file[data-path="asset/bg/preview-test.wav"] .scene-file-open').click();
    await page.waitForFunction(() => document.querySelector('[data-asset-meta="duration"]')?.textContent !== '—');
    assert.equal(await page.locator('[data-asset-meta="duration"]').textContent(), '0:04');
    assert.equal(await page.locator('[data-asset-label="orientation"]').textContent(), 'Type');
    assert.equal(await page.locator('[data-asset-meta="orientation"]').textContent(), 'Audio');
    await page.locator('.scene-file[data-path="asset/bg/preview-test.webm"] .scene-file-open').click();
    await page.waitForFunction(() => document.querySelector('#asset-document-video')?.videoWidth === 32);
    assert.equal(await page.locator('#asset-document-video').evaluate((video) => video.videoHeight), 24);
    assert.equal(await page.locator('[data-asset-meta="duration"]').textContent(), '0:01');
    await page.locator('.scene-file[data-path="asset/bg/invalid-preview.png"] .scene-file-open').click();
    await page.waitForFunction(() => !document.querySelector('#asset-document-error')?.hidden);
    assert.match(await page.locator('#asset-document-error').textContent(), /invalid-preview\.png/);
    await page.evaluate((name) => openScene(name), originalSceneName);
    await page.waitForFunction(() => document.querySelector('#asset-document-viewer')?.hidden);
    await page.waitForFunction(() => !document.querySelector('#editor')?.readOnly);
    for (const name of ['std/math.tds', 'asset/bg/preview-test.png', 'asset/bg/preview-test.wav', 'asset/bg/preview-test.webm', 'asset/bg/invalid-preview.png']) {
      const tab = page.locator('#editor-tabs .editor-tab').filter({ has: page.locator(`.editor-tab-name[title="${name}"]`) });
      if (await tab.count()) await tab.locator('.editor-tab-close').click();
    }
    await page.locator('[data-activity="presentation"]').click();
    await page.locator('[data-presentation-action="game-screens"]').click();
    await page.locator('.game-screen-settings').waitFor();
    await page.setViewportSize({ width: 800, height: 600 });
    const compactDialogBounds = await page.locator('.game-screen-settings').evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width) };
    });
    assert.ok(compactDialogBounds.left >= 0 && compactDialogBounds.right <= 800 && compactDialogBounds.width <= 768, 'game-screen dialog stays inside a compact viewport');
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.locator('.game-screen-settings .project-settings-close').click();
    const builtinColor = await page.evaluate(() => {
      const sample = document.createElement('span'); sample.className = 'hl-builtin'; document.body.append(sample);
      const color = getComputedStyle(sample).color; sample.remove(); return color;
    });
    assert.equal(builtinColor, 'rgb(117, 190, 255)', 'built-in syntax highlighting follows the editor blue accent, not purple');
    await page.locator('[data-activity="explorer"]').click();
    await page.locator('[data-menu="help"]').click();
    await page.locator('[data-menu-action="syntax"]').click();
    assert.equal(await page.locator('.language-guide strong').textContent(), '.tds Syntax Help');
    assert.ok(await page.locator('.language-guide .guide-section').count() >= 8);
    assert.equal(await page.locator('.language-guide .guide-section').first().getAttribute('open'), '');
    const dialogueHelp = page.locator('.language-guide .guide-section').filter({ hasText: 'Dialogue, Variables & Strings' });
    const shortcutHelp = page.locator('.language-guide .guide-section').filter({ hasText: 'Editor shortcuts' });
    assert.match(await shortcutHelp.textContent(), /Indent selection/);
    assert.match(await dialogueHelp.textContent(), /String literal/);
    assert.match(await dialogueHelp.textContent(), /dotted field.*引数なしfunction call/);
    assert.doesNotMatch(await dialogueHelp.textContent(), /String interpolation expands \{expression\}/);
    assert.match(await dialogueHelp.locator('pre').textContent(), /say "点数: " \+ str\(score\)/);
    const dslHelpExamples = await page.locator('.language-guide .guide-section:not(:has(summary:text-is("Editor shortcuts"))) pre').evaluateAll((nodes) => nodes.map((node) => node.textContent));
    for (const example of dslHelpExamples) assert.doesNotThrow(() => parse(example), `IDE help example is invalid TDS:\n${example}`);
    assert.equal((await page.request.get(`${base}/docs/tds-language-and-editor-guide.md`)).ok(), true);
    const detailedReference = page.locator('.language-guide .guide-reference');
    await detailedReference.click();
    await page.locator('.guide-book-entry').first().waitFor();
    assert.equal(await page.locator('.language-guide').count(), 1, 'full reference opens inside the existing syntax reference instead of a new page');
    await page.locator('.guide-search').fill('dict[float]');
    assert.ok(await page.locator('.guide-book-entry').count() > 0, 'book search returns matching reference chapters');
    await page.locator('.guide-book-entry').first().click();
    assert.match(await page.locator('.guide-book-page').textContent(), /dict\[float\]/, 'selected chapter displays the matching detailed syntax');
    await detailedReference.click();
    assert.ok(await page.locator('.guide-section').first().isVisible(), 'the in-place reader returns to compact help without navigating away');
    await page.locator('.language-guide .guide-close').click();
    await editor.fill('character hero {\n  pose normal = "asset/hero.png"\n}');
    await rightClickToken(2, 'pose');
    await page.locator('.syntax-tooltip-signature').waitFor();
    assert.equal(await page.locator('.syntax-tooltip-signature').textContent(), 'pose <Pose Name> = "<Image Path>"');
    const validFunctionTooltipExample = 'fn greet() -> none {\n}';
    assert.doesNotThrow(() => parse(validFunctionTooltipExample));
    await editor.fill(validFunctionTooltipExample);
    await rightClickToken(1, 'fn');
    await page.locator('.syntax-tooltip-signature').waitFor();
    assert.match(await page.locator('.syntax-tooltip-signature').textContent(), /-> <return type>/);
    assert.match(await page.locator('.syntax-tooltip-description').textContent(), /戻り値の型を -> で必ず指定/);
    const declarationHelpSource = 'struct Vec2 {\n  x: float\n  y: float\n}\nfn scale(point: Vec2, factor: float) -> float {\n  return factor\n}\nscene main {\n  wait 1\n}\n';
    await editor.fill(declarationHelpSource);
    await rightClickToken(5, 'scale');
    await page.locator('.variable-tooltip').waitFor({ state: 'visible' });
    assert.match(await page.locator('.variable-tooltip').textContent(), /scale\(point: Vec2, factor: float\) -> float/);
    await rightClickToken(1, 'Vec2');
    await page.locator('.variable-tooltip').waitFor({ state: 'visible' });
    assert.match(await page.locator('.variable-tooltip').textContent(), /struct Vec2/);
    assert.match(await page.locator('.variable-tooltip').textContent(), /x: float/);
    assert.match(await page.locator('.variable-tooltip').textContent(), /y: float/);
    await editor.fill('');
    // Startup restores the last/first scene after an 800 ms timer.
    await page.waitForTimeout(1200);
    const referenceSource = 'fn render_route(route: str) -> none {\n  say narrator "日本語の見出し: {route}"\n}\nscene main {\n  say narrator "選択中: {route}"\n  say narrator "点数: {score}"\n}\n';
    const wrappedReferenceSource = referenceSource.replace('{route}', `${'日本語の見出し: '.repeat(24)}{route}`);
    await editor.fill(wrappedReferenceSource);
    await page.waitForTimeout(1200);
    await rightClickToken(2, 'route');
    const variableTooltip = page.locator('.variable-tooltip');
    await variableTooltip.waitFor({ state: 'visible' });
    assert.match(await variableTooltip.textContent(), /Scope: function \(render_route\)/);
    assert.match(await variableTooltip.textContent(), /定義/);
    assert.match(await variableTooltip.textContent(), /analysis-side\.tds:1/);
    assert.doesNotMatch(await variableTooltip.textContent(), /許容値:/, 'same-name local parameter must not inherit a global threshold');
    await variableTooltip.locator('.variable-tooltip-location').first().click();
    assert.equal(await editor.evaluate((element) => element.value.slice(element.selectionStart, element.selectionEnd)), 'route', 'definition navigation selects the exact symbol');
    await page.evaluate((name) => openScene(name), originalSceneName);
    await page.waitForFunction((name) => document.querySelector('#scene-name')?.value === name, originalSceneName);
    await editor.fill(wrappedReferenceSource);
    await page.waitForTimeout(1100);
    await rightClickToken(2, 'route');
    await variableTooltip.waitFor({ state: 'visible' });
    const wrappedRouteFacts = await page.evaluate(async () => {
      try { return { variables: (await compiledVariablesForCurrentSource(sceneName.value, editor.value)).filter(variable => variable.name === 'route') }; }
      catch (error) {
        const response = await fetch('/api/compile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: sceneName.value, source: editor.value }) });
        return { scene: sceneName.value, source: editor.value, error: error.message, apiStatus: response.status, api: await response.json() };
      }
    });
    assert.ok(await variableTooltip.locator('.variable-tooltip-location').count() > 1, `wrapped reference has no second navigable location: ${JSON.stringify({ text: await variableTooltip.textContent(), facts: wrappedRouteFacts })}`);
    await variableTooltip.locator('.variable-tooltip-location').nth(1).click();
    assert.equal(await editor.evaluate((element) => element.selectionStart), wrappedReferenceSource.indexOf('{route}') + 1, 'reference navigation selects the variable even on a wrapped Japanese line');
    await editor.fill(referenceSource);
    await page.waitForTimeout(1100);
    await rightClickToken(5, 'route');
    await variableTooltip.waitFor({ state: 'visible' });
    assert.match(await variableTooltip.textContent(), /Scope: global/);
    assert.match(await variableTooltip.textContent(), /設定された値: summer, winter/);
    await rightClickToken(6, 'score');
    await variableTooltip.waitFor({ state: 'visible' });
    assert.match(await variableTooltip.textContent(), /許容範囲: 0 ～ 9/);
    await saveAllFromMenu();
    assert.equal(await page.locator('#split-editor').count(), 0);
    assert.equal(await page.locator('#new-scene').count(), 0);
    const topLevelFolder = page.locator('#file-tree > .scene-folder[data-path="senario"]');
    const topLevelContents = topLevelFolder.locator('xpath=following-sibling::div[1]');
    assert.equal(await topLevelContents.getAttribute('hidden'), '');
    await topLevelFolder.click();
    assert.equal(await topLevelContents.getAttribute('hidden'), null);
    await topLevelFolder.click();
    assert.equal(await topLevelContents.getAttribute('hidden'), '');
    await topLevelFolder.click();
    assert.equal(await topLevelContents.getAttribute('hidden'), null);
    const currentScene = await page.locator('#scene-name').inputValue();
    let folderPath = 'senario';
    for (const part of currentScene.split('/').slice(0, -1)) {
      folderPath += '/' + part;
      const folder = page.locator(`.scene-folder[data-path="${folderPath}"]`);
      if (await folder.locator('xpath=following-sibling::div[1]').getAttribute('hidden') !== null) await folder.click();
    }
    const currentFile = page.locator(`#file-tree .scene-file[data-path="senario/${currentScene}"]`);
    const activeSource = await editor.inputValue();
    const localTargetScene = activeSource.match(/^\s*scene\s+([A-Za-z_][A-Za-z0-9_]*)/m)?.[1];
    assert.ok(localTargetScene, `the active scenario has a scene declaration: ${currentScene}`);
    let injectExplorerGraph = null;
    let explorerGraphRaceCount = 0;
    let releaseOldExplorerGraph;
    let oldExplorerGraphFinishedResolve;
    const oldExplorerGraphFinished = new Promise((resolve) => { oldExplorerGraphFinishedResolve = resolve; });
    let firstExplorerGraphSeenResolve;
    const firstExplorerGraphSeen = new Promise((resolve) => { firstExplorerGraphSeenResolve = resolve; });
    await page.route('**/api/scene-graph', async (route) => {
      if (!injectExplorerGraph) return route.continue();
      if (injectExplorerGraph === 'race') {
        explorerGraphRaceCount += 1;
        if (explorerGraphRaceCount === 1) {
          firstExplorerGraphSeenResolve();
          await new Promise((resolve) => { releaseOldExplorerGraph = resolve; });
          await route.fulfill({ json: { version: 2, nodes: [{ id: currentScene, localGotos: [{ scene: 'stale-target', file: currentScene }], variables: [] }], edges: [] } });
          oldExplorerGraphFinishedResolve();
          return;
        }
        await route.fulfill({ json: { version: 2, nodes: [{ id: currentScene, localGotos: [{ scene: 'latest-one', file: currentScene }, { scene: 'latest-two', file: currentScene }], variables: [] }], edges: [] } });
        return;
      }
      const emptyTargets = injectExplorerGraph === 'empty';
      injectExplorerGraph = false;
      const variables = [
        { name: 'amount', type: 'int', scope: 'function', definedIn: 'route_summer', definitions: [{ file: currentScene, line: 1, column: 4, scope: 'function', container: 'route_summer' }], references: Array.from({ length: 690 }, () => ({ file: currentScene, line: 2, scope: 'function', container: 'route_summer' })) },
        { name: 'amount', type: 'int', scope: 'function', definedIn: 'route_after', definitions: [{ file: currentScene, line: 3, column: 4, scope: 'function', container: 'route_after' }], references: [{ file: currentScene, line: 4, scope: 'function', container: 'route_after' }] },
        { name: 'route', type: 'str', scope: 'global', definedIn: currentScene, definitions: [{ file: currentScene, line: 5, column: 7, scope: 'global', container: currentScene }], references: [{ file: currentScene, line: 6, scope: 'global', container: currentScene }] },
      ];
      await route.fulfill({ json: {
        version: 2,
        nodes: [{ id: currentScene, variables, localGotos: emptyTargets ? [] : [{ scene: localTargetScene, file: currentScene, gotoLine: 1 }], reachable: emptyTargets }],
        edges: emptyTargets ? [] : [
          ...['chapters/chapter01.tds', 'routes/sora.tds', 'routes/nene.tds'].map((to) => ({ from: currentScene, to, kind: 'goto' })),
          { from: currentScene, to: 'shared/common.tds', kind: 'include' },
        ],
      } });
    });
    injectExplorerGraph = true;
    await currentFile.click({ button: 'right' });
    await page.locator('.file-context-menu [role="menuitem"]').nth(2).click();
    const fileInfo = page.locator('#file-info');
    await page.waitForFunction(() => document.querySelector('#file-info .file-info-stat-local')?.textContent === 'Destinations 4').catch(async (error) => {
      const rendered = await fileInfo.textContent();
      throw Error(`explorer metadata did not render; injected=${injectExplorerGraph}; scene=${await page.locator('#scene-name').inputValue()}; info=${rendered}; ${error.message}`);
    });
    assert.equal(await fileInfo.locator('.file-info-stat-local').textContent(), 'Destinations 4');
    assert.equal(await fileInfo.locator('[data-kind="local-targets"] summary .file-info-section-label').textContent(), 'Scenes in this file');
    assert.equal(await fileInfo.locator('[data-kind="targets"] summary .file-info-section-label').textContent(), 'Destinations');
    assert.equal(await fileInfo.locator('[data-kind="variables"] summary .file-info-section-label').textContent(), 'Variables');
    assert.equal(await fileInfo.locator('.file-info-section').count(), 3);
    const inspectorStyle = await fileInfo.evaluate((element) => ({
      background: getComputedStyle(element).backgroundColor,
      sidebarBackground: getComputedStyle(element.closest('.sidebar')).backgroundColor,
      outerOverflowY: getComputedStyle(element).overflowY,
      innerOverflowY: getComputedStyle(element.querySelector('.file-info-list')).overflowY,
    }));
    assert.deepEqual(inspectorStyle, { background: 'rgba(0, 0, 0, 0)', sidebarBackground: 'rgb(24, 24, 24)', outerOverflowY: 'visible', innerOverflowY: 'visible' }, 'inspector uses the sidebar surface and does not create nested scrollbars');
    const inspectorPalette = await fileInfo.evaluate((element) => {
      const title = getComputedStyle(element.querySelector('.file-info-title'));
      const local = getComputedStyle(element.querySelector('.file-info-stat-local'));
      const variables = getComputedStyle(element.querySelector('.file-info-stat-variables'));
      const count = getComputedStyle(element.querySelector('.file-info-section-count'));
      const link = getComputedStyle(element.querySelector('.file-info-link'));
      const targetMeta = getComputedStyle(element.querySelector('.file-info-target-meta'));
      const list = getComputedStyle(element.querySelector('.file-info-list'));
      return {
        titleRail: title.borderLeftWidth,
        titleInset: title.paddingLeft,
        local: [local.color, local.backgroundColor, local.borderTopWidth],
        variables: [variables.color, variables.backgroundColor, variables.borderTopWidth],
        count: [count.color, count.backgroundColor, count.borderRadius],
        link: [link.backgroundColor, link.borderTopWidth, link.appearance],
        linkDecoration: getComputedStyle(element.querySelector('.file-info-link'), '::before').content,
        targetMetaInset: targetMeta.paddingLeft,
        listStyle: list.listStyleType,
      };
    });
    assert.deepEqual(inspectorPalette, {
      titleRail: '0px',
      titleInset: '0px',
      local: ['rgb(157, 157, 157)', 'rgba(0, 0, 0, 0)', '0px'],
      variables: ['rgb(157, 157, 157)', 'rgba(0, 0, 0, 0)', '0px'],
      count: ['rgb(133, 133, 133)', 'rgba(0, 0, 0, 0)', '0px'],
      link: ['rgba(0, 0, 0, 0)', '0px', 'none'],
      linkDecoration: 'none',
      targetMetaInset: '5px',
      listStyle: 'none',
    }, 'file metadata counts are neutral text rather than colored badge chips');
    const selectedTextStyle = await editor.evaluate((element) => {
      const scene = element.value.match(/\bscene\s+([A-Za-z_][A-Za-z0-9_]*)/);
      if (!scene) throw new Error('active scenario has no selectable scene declaration');
      const start = scene.index + scene[0].lastIndexOf(scene[1]);
      element.focus();
      element.setSelectionRange(start, start + scene[1].length);
      return {
        selectedText: element.value.slice(element.selectionStart, element.selectionEnd),
        selectionBackground: getComputedStyle(element, '::selection').backgroundColor,
      };
    });
    assert.deepEqual(selectedTextStyle, { selectedText: localTargetScene, selectionBackground: 'rgba(38, 79, 120, 0.4)' }, 'selection tint stays translucent so syntax-colored text remains visible');
    if (process.env.NOVEL_EDITOR_SCREENSHOT) await page.screenshot({ path: process.env.NOVEL_EDITOR_SCREENSHOT });
    await editor.evaluate((element) => { element.setSelectionRange(0, 0); element.blur(); });
    assert.equal(await fileInfo.locator('[data-kind="local-targets"] .file-info-list li').count(), 1);
    assert.match(await fileInfo.locator('[data-kind="local-targets"]').textContent(), new RegExp(localTargetScene));
    await fileInfo.locator('.file-info-link-scene').click();
    assert.equal(await editor.evaluate((element) => element.value.slice(element.selectionStart, element.selectionEnd)), localTargetScene, 'a local goto entry navigates to its scene declaration');
    assert.equal(await fileInfo.locator('[data-kind="targets"] .file-info-list li').count(), 3);
    assert.match(await fileInfo.locator('[data-kind="targets"]').textContent(), /chapters\/chapter01\.tds/);
    assert.equal(await fileInfo.locator('[data-kind="variables"] .file-info-list li').count(), 3, 'a large reference count is summarized per binding, not expanded into hundreds of rows');
    assert.match(await fileInfo.locator('[data-kind="variables"]').textContent(), /route_summer/);
    assert.match(await fileInfo.locator('[data-kind="variables"]').textContent(), /1 definitions · 690 references/);
    assert.equal(await fileInfo.locator('[data-kind="variables"] .file-info-variable-jump').count(), 3);
    assert.equal(await fileInfo.locator('.file-info-stat-warning').count(), 1, 'unreachable files show a warning badge in the summary');
    injectExplorerGraph = 'empty';
    await currentFile.click({ button: 'right' });
    await page.locator('.file-context-menu [role="menuitem"]').nth(2).click();
    await page.waitForFunction(() => document.querySelector('#file-info .file-info-stat-local')?.textContent === 'Destinations 0');
    assert.equal(await fileInfo.locator('[data-kind="local-targets"]').count(), 0);
    assert.equal(await fileInfo.locator('[data-kind="targets"]').count(), 0, 'an empty transition section is omitted instead of showing a dead disclosure bar');
    injectExplorerGraph = 'race';
    await currentFile.click({ button: 'right' });
    await page.locator('.file-context-menu [role="menuitem"]').nth(2).click();
    await firstExplorerGraphSeen;
    await currentFile.click({ button: 'right' });
    await page.locator('.file-context-menu [role="menuitem"]').nth(2).click();
    await page.waitForFunction(() => document.querySelector('#file-info [data-kind="local-targets"] .file-info-section-count')?.textContent === '2');
    releaseOldExplorerGraph();
    await oldExplorerGraphFinished;
    await page.waitForTimeout(50);
    assert.equal(await fileInfo.locator('[data-kind="local-targets"] .file-info-section-count').textContent(), '2', 'a delayed older Explorer metadata response cannot replace a later refresh for the same active file');
    await page.unroute('**/api/scene-graph');
    const deleteButton = currentFile.locator('.tree-action.delete');
    assert.equal(await deleteButton.locator('xpath=..').evaluate((element) => element.tagName), 'DIV');
    await deleteButton.click();
    await page.locator('.editor-dialog').waitFor();
    assert.match(await page.locator('.editor-dialog').textContent(), /削除しますか/);
    await page.getByRole('button', { name: 'キャンセル' }).click();
    assert.equal(await page.locator('.editor-tab-split').first().isVisible(), true);
    assert.equal(await page.locator('.editor-tab-split').first().textContent(), '→');
    const leftTabFontSize = await page.locator('#editor-tabs .editor-tab-name').first().evaluate((element) => getComputedStyle(element).fontSize);
    const tabControlCenters = await page.locator('.editor-tab').first().evaluate((tab) => {
      const split = tab.querySelector('.editor-tab-split').getBoundingClientRect();
      const close = tab.querySelector('.editor-tab-close').getBoundingClientRect();
      return [split.top + split.height / 2, close.top + close.height / 2];
    });
    assert.ok(Math.abs(tabControlCenters[0] - tabControlCenters[1]) < 0.5);
    const splitScene = 'analysis-side.tds';
    const splitFile = page.locator('#file-tree .scene-file[data-path="senario/analysis-side.tds"]');
    await splitFile.locator('.scene-file-open').click({ modifiers: ['Shift'] });
    await page.waitForFunction(() => document.querySelector('#split-group')?.hidden === false);
    assert.equal(await page.locator('#split-group').isVisible(), true);
    const splitFrame = page.frameLocator('#split-frame');
    await splitFrame.locator('#editor').waitFor();
    await page.waitForFunction((name) => document.querySelector('#split-frame')?.contentWindow?.document.querySelector('#scene-name')?.value === name, splitScene);
    assert.equal(await splitFrame.locator('html.embedded-editor').count(), 1);
    assert.equal(await page.locator('#editor-tabs .editor-tab').count(), 0);
    assert.equal(await page.locator('#split-tabs .editor-tab').count(), 1);
    assert.equal(await page.locator('#split-tabs .editor-tab-unsplit').textContent(), '←');
    assert.equal(await page.locator('#split-tabs .editor-tab-name').evaluate((element) => getComputedStyle(element).fontSize), leftTabFontSize);
    await page.locator('#split-tabs .editor-tab-unsplit').click();
    await page.locator('#editor-tabs .editor-tab').first().waitFor();
    assert.equal(await page.locator('#editor-tabs .editor-tab').count(), 1);
    assert.equal(await page.locator('#split-tabs .editor-tab').count(), 0);
    assert.equal(await page.locator('#split-group').isVisible(), false);
    await page.locator('#editor-tabs .editor-tab-split').click();
    await splitFrame.locator('#editor').waitFor();
    await page.waitForFunction((name) => document.querySelector('#split-frame')?.contentWindow?.document.querySelector('#scene-name')?.value === name, splitScene);
    assert.equal(await page.locator('#editor-tabs .editor-tab').count(), 0);
    assert.equal(await page.locator('#split-tabs .editor-tab').count(), 1);
    await splitFrame.locator('#editor').fill('unsaved right pane before project switch');
    let projectOpenRequests = 0;
    await page.route('**/api/project/open', async (route) => {
      projectOpenRequests += 1;
      return route.fulfill({ json: { ok: true, title: 'unexpected project switch', projectRoot: 'unexpected' } });
    });
    await page.locator('[data-menu="file"]').click();
    await page.locator('[data-menu-action="open-project"]').click();
    const folderPrompt = page.locator('.editor-dialog').filter({ has: page.locator('input') });
    await folderPrompt.getByRole('button', { name: '決定' }).click();
    await page.locator('.editor-dialog').waitFor();
    assert.equal(projectOpenRequests, 0, 'dirty right pane must be confirmed before the project switch request');
    await page.locator('.editor-dialog').getByRole('button', { name: 'キャンセル' }).click();
    assert.equal(await splitFrame.locator('body').evaluate((element) => element.ownerDocument.defaultView.novelEditorApi.isDirty()), true);
    await saveAllFromMenu();
    await page.waitForFunction(() => document.querySelector('#split-frame')?.contentWindow?.novelEditorApi?.isDirty() === false);
    assert.equal(await page.locator('#save-split').count(), 0);
    assert.match(await page.locator('[data-menu-action="save"]').textContent(), /すべて保存/);
    const splitControlCenters = await page.locator('#split-tabs .editor-tab').evaluate((tab) => [...tab.querySelectorAll('.editor-tab-unsplit,.editor-tab-close')].map((button) => {
      const rect = button.getBoundingClientRect(); return rect.top + rect.height / 2;
    }));
    assert.ok(splitControlCenters.every((center) => Math.abs(center - splitControlCenters[0]) < 0.5));
    const splitResizer = page.locator('#split-resizer');
    assert.equal(await splitResizer.isVisible(), true);
    assert.equal(await splitFrame.locator('body').evaluate(() => typeof window.novelEditorApi?.save), 'function');
    assert.equal(await splitFrame.locator('body').evaluate(() => window.novelEditorApi.isDirty()), false);
    const oldSplitWidth = Number(await splitResizer.getAttribute('aria-valuenow'));
    await splitResizer.press('ArrowRight');
    assert.equal(Number(await splitResizer.getAttribute('aria-valuenow')), oldSplitWidth + 5);
    await page.route('**/api/scene', async (route) => {
      if (route.request().method() !== 'PUT') return route.continue();
      const body = route.request().postDataJSON();
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ name: body.name }) });
    });
    await splitFrame.locator('#editor').fill('unsaved split test');
    assert.equal(await splitFrame.locator('body').evaluate(() => window.novelEditorApi.isDirty()), true);
    await saveAllFromMenu();
    await page.waitForFunction(() => document.querySelector('#split-frame')?.contentWindow?.novelEditorApi?.isDirty() === false);
    assert.equal(await splitFrame.locator('body').evaluate(() => window.novelEditorApi.isDirty()), false);
    await splitFrame.locator('#editor').fill('unsaved split test 2');
    page.once('dialog', (dialog) => dialog.dismiss());
    await page.locator('#split-tabs .editor-tab-close').click();
    assert.equal(await page.locator('#split-group').isVisible(), true);
    await saveAllFromMenu();
    await page.waitForFunction(() => document.querySelector('#split-frame')?.contentWindow?.novelEditorApi?.isDirty() === false);
    await page.locator('#split-tabs .editor-tab-unsplit').click();
    await page.locator('#editor-tabs .editor-tab').first().waitFor();
    assert.equal(await page.locator('#split-group').isVisible(), false);
    await editor.fill(originalEditorSource);
    let projectBuildRequest;
    let failNextBuild = false;
    let delayProjectBuild = true;
    let releaseProjectBuild;
    let markProjectBuildStarted;
    const projectBuildStarted = new Promise((resolve) => { markProjectBuildStarted = resolve; });
    await page.route('**/api/project-build', async (route) => {
      projectBuildRequest = route.request().postDataJSON();
      if (failNextBuild) {
        failNextBuild = false;
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
          ok: false, build: true, fileCount: 1,
          diagnostics: [{ severity: 'error', code: 'type-error', message: 'invalid value', file: projectBuildRequest.name, line: 1, column: 1 }],
          error: 'invalid value',
        }) });
      }
      if (delayProjectBuild) {
        delayProjectBuild = false;
        markProjectBuildStarted();
        await new Promise((resolve) => { releaseProjectBuild = resolve; });
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
          ok: true, build: true, fileCount: 2,
          diagnostics: [{ severity: 'warning', code: 'stale-build-warning', message: 'belongs to build snapshot', file: projectBuildRequest.name, line: 1, column: 1 }],
          name: 'test.nsp.json', path: 'build/native-packages/test.nsp.json', instructions: 4,
        }) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, build: true, fileCount: 2, diagnostics: [], name: 'test.nsp.json', path: 'build/native-packages/test.nsp.json', instructions: 4 }) });
    });
    await page.locator('[data-menu="run"]').click();
    assert.deepEqual(await page.locator('[data-menu-popup="run"] [role="menuitem"]').allTextContents(), ['Build Ctrl+Enter', '再生']);
    await page.locator('[data-menu-action="build"]').click();
    await projectBuildStarted;
    await editor.fill('scene main { wait 2 }');
    releaseProjectBuild();
    await page.waitForFunction(() => document.querySelector('#status')?.textContent.includes('現在の編集内容を検証しています'));
    assert.doesNotMatch(await page.locator('#result').textContent(), /stale-build-warning/, 'a project-build response must not attach diagnostics to a buffer changed during the request');
    await page.waitForFunction(() => document.querySelector('#status')?.textContent.includes('Validation complete: Error 0 / Warning 0 / Info 0'));
    assert.equal(projectBuildRequest.name, await page.locator('#scene-name').inputValue());
    assert.doesNotMatch(await page.locator('#result').textContent(), /stale-build-warning/);
    failNextBuild = true;
    await page.locator('[data-menu="run"]').click();
    await page.locator('[data-menu-action="build"]').click();
    await page.waitForFunction(() => document.querySelector('#result')?.textContent.includes('Build failed: Error 1 / 1 file'));
    assert.equal(await page.locator('#status').textContent(), 'Build failed: Error 1 / 1 file', 'Build failure status uses standard English technical wording and matches the diagnostic heading');
    let playRequest = false;
    await page.route('**/api/project-build-status', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ built: false, changedFiles: ['main.tds'], reason: 'scenario-changed' }) }));
    await page.route('**/api/native-play', async (route) => { playRequest = true; return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) }); });
    const nativePlayResponse = page.waitForResponse((response) => response.url().includes('/api/native-play'));
    await page.locator('[data-menu="run"]').click();
    await page.locator('[data-menu-action="play"]').click();
    await page.locator('.editor-dialog button').first().click();
    await nativePlayResponse;
    assert.equal(playRequest, true, 'accepting the build prompt should build and then start playback');
    await editor.fill('ch');
    await page.waitForFunction(() => ['character', 'choice'].every((word) => [...document.querySelectorAll('#suggestions .suggestion')].some((button) => button.textContent.includes(word))));
    const chSuggestions = await page.locator('#suggestions .suggestion').allTextContents();
    assert.equal(chSuggestions.some((word) => word.trim().replace(/^›\s*/, '') === 'char'), false);
    await editor.fill('a');
    await page.waitForFunction(() => document.querySelector('#suggestions')?.textContent.includes('asset'));
    const aSuggestions = await page.locator('#suggestions .suggestion').allTextContents();
    assert.equal(aSuggestions.some((word) => word.trim().replace(/^›\s*/, '') === 'at'), false);
    await editor.fill('sa');
    await page.waitForFunction(() => document.querySelector('#suggestions')?.textContent.includes('say'));
    await editor.press('Enter');
    assert.equal(await editor.inputValue(), 'say');
    await editor.press('Space');
    await editor.type('nar');
    await page.waitForFunction(() => document.querySelector('#suggestions')?.textContent.includes('narrator'));
    await editor.press('Enter');
    assert.equal(await editor.inputValue(), 'say narrator ""');
    assert.ok((await page.locator('#scene-name').inputValue()).length > 0);
    await editor.fill('scene local_start { wait 1 }\nscene local_target { wait 1 }\ngoto local_t');
    await page.waitForFunction(() => [...document.querySelectorAll('#suggestions .suggestion')].some((button) => button.textContent.includes('local_target')));
    const localGotoSuggestions = (await page.locator('#suggestions .suggestion').allTextContents()).map((value) => value.trim().replace(/^›\s*/, ''));
    assert.deepEqual(localGotoSuggestions, ['local_target']);
    const projectScenes = (await (await page.request.get(`${base}/api/scenes`)).json()).scenes;
    const externalGoto = projectScenes.map((name) => ({ name, prefix: name.slice(0, -1) })).find(({ name, prefix }) => prefix && projectScenes.filter((candidate) => candidate.startsWith(prefix)).length === 1 && prefix.length < name.length);
    assert.ok(externalGoto, 'project should contain a file name with a unique completion prefix');
    await editor.fill(`goto "${externalGoto.prefix}`);
    await page.waitForFunction((name) => [...document.querySelectorAll('#suggestions .suggestion')].some((button) => button.textContent.includes(name)), externalGoto.name);
    const externalGotoSuggestions = (await page.locator('#suggestions .suggestion').allTextContents()).map((value) => value.trim().replace(/^›\s*/, ''));
    assert.deepEqual(externalGotoSuggestions, [externalGoto.name]);
    await editor.fill('character aokami {\n  name = "蒼神"\n  pose normal = "asset/char/aokami.png"\n}\nshow ao');
    await page.waitForFunction(() => document.querySelector('#suggestions')?.textContent.includes('aokami'));
    await editor.press('Enter');
    assert.match(await editor.inputValue(), /show aokami\.$/);
    await editor.type('no');
    await page.waitForFunction(() => document.querySelector('#suggestions')?.textContent.includes('normal'));
    await editor.press('Enter');
    assert.match(await editor.inputValue(), /show aokami\.normal$/);
    await editor.press('Space');
    await editor.type('ce');
    await page.waitForFunction(() => document.querySelector('#suggestions')?.textContent.includes('center'));
    await editor.press('Enter');
    assert.match(await editor.inputValue(), /show aokami\.normal center$/);
    await editor.fill('show aokami.normal far');
    await page.waitForFunction(() => document.querySelector('#suggestions')?.textContent.includes('far_left'));
    await editor.press('Enter');
    assert.equal(await editor.inputValue(), 'show aokami.normal far_left');
    await editor.fill('show aokami.normal far_');
    await page.waitForFunction(() => document.querySelector('#suggestions')?.textContent.includes('far_left'));
    await editor.press('Enter');
    assert.equal(await editor.inputValue(), 'show aokami.normal far_left');
    const formattedCompletionSource = 'scene main{\nshow aokami.normal far\n}';
    const formattedCompletion = 'scene main {\n  show aokami.normal far\n}';
    await editor.fill(formattedCompletionSource);
    const completionCaret = formattedCompletionSource.indexOf('far') + 'far'.length;
    await editor.evaluate((element, caret) => element.setSelectionRange(caret, caret), completionCaret);
    await editor.press('Control+Shift+f');
    assert.equal(await editor.inputValue(), formattedCompletion);
    assert.equal(await editor.evaluate((element) => element.selectionStart), formattedCompletion.indexOf('far') + 'far'.length);
    await page.waitForFunction(() => document.querySelector('#suggestions')?.textContent.includes('far_left'));
    await editor.press('Enter');
    assert.equal(await editor.inputValue(), 'scene main {\n  show aokami.normal far_left\n}');
    await editor.fill('show image placeholder far_r');
    await page.waitForFunction(() => document.querySelector('#suggestions')?.textContent.includes('far_right'));
    await editor.press('Enter');
    assert.equal(await editor.inputValue(), 'show image placeholder far_right');
    await editor.fill('show image placeholder far_');
    await page.waitForFunction(() => document.querySelector('#suggestions')?.textContent.includes('far_right'));
    await editor.press('Enter');
    assert.equal(await editor.inputValue(), 'show image placeholder far_left');
    await editor.fill('play voice greeting blo');
    await page.waitForFunction(() => document.querySelector('#suggestions')?.textContent.includes('blocking'));
    await editor.press('Enter');
    assert.equal(await editor.inputValue(), 'play voice greeting blocking');
    await editor.fill('cho');
    await page.waitForFunction(() => {
      const items = [...document.querySelectorAll('#suggestions .suggestion')].map((button) => button.textContent.trim().replace(/^›\s*/, ''));
      return items.length === 1 && items[0] === 'choice';
    });
    await editor.press('Enter');
    assert.equal(await editor.inputValue(), 'choice');
    await editor.fill('if(score==1)');
    await editor.press('Enter');
    assert.equal(await editor.inputValue(), 'if (score == 1) {\n  \n}\n');
    await editor.fill(`str editor_title = "文字列"\nscene analysis {\n  if 1 == 2 {\n    say narrator "到達しない"\n  }\n  say narrator editor_title\n}`);
    await page.waitForFunction(() => document.querySelector('#result')?.textContent.includes('constant-condition'), null, { timeout: 10000 });
    const resultText = await page.locator('#result').textContent();
    if (!resultText.includes('constant-condition')) throw new Error(`Live diagnostics were not rendered: ${resultText}`);
    assert.match(await page.locator('#result').textContent(), /Warning [1-9]/);
    await page.waitForFunction(() => document.querySelector('#status')?.textContent.includes('Validation complete: Error 0 / Warning'));
    assert.match(await page.locator('#status').textContent(), /Validation complete: Error 0 \/ Warning [1-9]/);
    assert.ok(await page.locator('#highlight .hl-warning').count() >= 1);
    assert.ok((await page.locator('#highlight .hl-line').nth(3).getAttribute('class')).includes('hl-unreachable'));
    assert.equal((await page.locator('#highlight .hl-line').nth(5).getAttribute('class')).includes('hl-unreachable'), false);
    await editor.fill('asset bg first = "asset/bg/mori.jpg"\nasset bg second = "asset/bg/mori.jpg"\nscene main {\n  bg first\n  bg second\n}');
    await page.waitForFunction(() => document.querySelector('#result')?.textContent.includes('background-replacement'));
    assert.match(await page.locator('#result').textContent(), /background-replacement/);
    await editor.fill('scene start {\n  goto ending\n  say narrator "first"\n  say narrator "second"\n}\nscene ending { wait 1 }');
    await page.waitForFunction(() => [2, 3].every((index) => document.querySelectorAll('#highlight .hl-line')[index]?.classList.contains('hl-unreachable')));
    const unreachableSay = page.locator('#highlight .hl-line');
    const unreachableClasses = await unreachableSay.evaluateAll((rows) => rows.map((row) => row.className));
    assert.deepEqual(unreachableClasses.slice(2, 4).map((value) => value.includes('hl-unreachable')), [true, true]);
    assert.equal(await unreachableSay.nth(3).locator('.hl-string').evaluate((node) => getComputedStyle(node).color), await unreachableSay.nth(2).evaluate((node) => getComputedStyle(node).color));
    assert.equal(await unreachableSay.nth(2).evaluate((node) => getComputedStyle(node).textDecorationLine), 'none');
    await editor.fill('scene start {\n  goto ending\n  choice "route" {\n    "one" {\n      wait 1\n    }\n    "two" { wait 2 }\n  }\n}\nscene ending { wait 1 }');
    await page.waitForFunction(() => [2, 3, 4, 5, 6, 7].every((index) => document.querySelectorAll('#highlight .hl-line')[index]?.classList.contains('hl-unreachable')));
    const unreachableChoice = page.locator('#highlight .hl-line');
    assert.equal(await unreachableChoice.nth(3).locator('.hl-string').evaluate((node) => getComputedStyle(node).color), await unreachableChoice.nth(2).evaluate((node) => getComputedStyle(node).color));
    assert.match(await page.locator('#file-info').textContent(), /3-8 line/);
    assert.doesNotMatch(await page.locator('#file-info').textContent(), /3 line - 8 line/);
    assert.match(await page.locator('#result').textContent(), /unreachable-code\s+3-8 line/);
    assert.doesNotMatch(await page.locator('#result').textContent(), /unreachable-code\s+line 3, column/);
    await editor.fill('scene start {\n  goto live\n  wait 1\n\n  say narrator "never"\n}\nscene live { wait 1 }\nscene dead {\n  wait 2\n\n  say narrator "still never"\n}');
    await page.waitForFunction(() => document.querySelector('#result')?.textContent.includes('3-5 line') && document.querySelector('#result')?.textContent.includes('8-12 line'));
    const collapsedDiagnostics = await page.locator('#result').textContent();
    assert.match(collapsedDiagnostics, /unreachable-code\s+3-5 line/);
    assert.match(collapsedDiagnostics, /unreachable-scene\s+8-12 line/);
    assert.doesNotMatch(collapsedDiagnostics, /unreachable-code\s+9(?:-|\s)line/);
    await editor.fill('scene start {\n  bg missing_one\n  wait "bad"\n  say missing_two "hello"\n}');
    await page.waitForFunction(() => document.querySelectorAll('#result .diagnostic-error').length >= 3);
    const continuedTypeDiagnostics = await page.locator('#result').textContent();
    for (const line of [2, 3, 4]) assert.match(continuedTypeDiagnostics, new RegExp(`line ${line}, column`));
    const unicodeTypeError = 'str result = "😀" + missing';
    const expectedColumn = unicodeTypeError.indexOf('missing') + 1;
    await editor.fill(unicodeTypeError);
    await page.waitForFunction((column) => document.querySelector('#result')?.textContent.includes(`line 1, column ${column}`), expectedColumn);
    const unicodeTypeDiagnostic = page.locator('#result .diagnostic-link').filter({ hasText: 'type-error' }).first();
    await unicodeTypeDiagnostic.click();
    assert.equal(await editor.evaluate((element) => element.selectionStart), expectedColumn - 1);
    await editor.fill('scene unicode {\u2028  wait "bad"\u2029}');
    await page.waitForFunction(() => document.querySelector('#result')?.textContent.includes('line 2, column'));
    assert.equal(await page.locator('#line-numbers').innerText(), '1\n2\n3', 'editor line numbers follow every line separator accepted by the DSL lexer');
    assert.ok(await page.locator('#highlight .hl-line').nth(1).evaluate(node => node.classList.contains('hl-error')), 'diagnostic underlines use the lexer line after a Unicode separator');
    await editor.fill('say narrator "unterminated\nwait (\nsay narrator "valid"');
    await page.waitForFunction(() => document.querySelector('#result')?.textContent.includes('syntax-error') && document.querySelectorAll('#result .diagnostic-error').length >= 2);
    const continuedSyntaxDiagnostics = await page.locator('#result').textContent();
    assert.match(continuedSyntaxDiagnostics, /行 1:14/);
    assert.match(continuedSyntaxDiagnostics, /行 2:7/);
    await editor.fill('asset bg missing = "asset/__missing_diagnostic_jump__.png"\nscene start { bg missing }');
    await page.waitForFunction(() => document.querySelector('#result')?.textContent.includes('project-error'));
    const projectErrorLink = page.locator('#result .diagnostic-link').filter({ hasText: 'project-error' }).first();
    assert.equal(await projectErrorLink.getAttribute('title'), 'Click to jump to this line');
    await projectErrorLink.click();
    assert.equal(await editor.evaluate((element) => document.activeElement === element), true);
    const missingAssetSource = 'asset bg missing = "asset/__missing_diagnostic_jump__.png"\nscene start { bg missing }';
    assert.equal(await editor.evaluate((element) => element.selectionStart), missingAssetSource.indexOf('asset/__missing_diagnostic_jump__.png'));
    const includedModuleSource = 'asset image absent = "asset/__missing_from_included_module__.png"\n';
    await editor.fill('include diagnostic-module.tds as diagnostics\nscene start { wait 1 }');
    await page.waitForFunction(() => document.querySelector('#result')?.textContent.includes('diagnostic-module.tds'));
    const includedAssetDiagnostic = page.locator('#result .diagnostic-link').filter({ hasText: 'project-error' }).first();
    await includedAssetDiagnostic.click();
    await page.waitForFunction(() => document.querySelector('#scene-name')?.value === 'diagnostic-module.tds');
    assert.equal(await editor.inputValue(), includedModuleSource);
    assert.equal(await editor.evaluate((element) => element.selectionStart), includedModuleSource.indexOf('asset/__missing_from_included_module__.png'));
    await fs.writeFile(syntaxDiagnosticModulePath, 'fn broken() -> none {\n  wait (\n}\n', 'utf8');
    await editor.fill('include syntax-diagnostic-module.tds as syntax_diagnostic\nscene start { wait 1 }');
    await page.waitForFunction(() => document.querySelector('#result')?.textContent.includes('syntax-diagnostic-module.tds'));
    const includedSyntaxDiagnostic = page.locator('#result .diagnostic-link').filter({ hasText: 'syntax-error' }).first();
    assert.match(await includedSyntaxDiagnostic.textContent(), /syntax-diagnostic-module\.tds.*行 2:9/);
    await includedSyntaxDiagnostic.click();
    await page.waitForFunction(() => document.querySelector('#scene-name')?.value === 'syntax-diagnostic-module.tds');
    const includedSyntaxSource = 'fn broken() -> none {\n  wait (\n}\n';
    assert.equal(await editor.evaluate((element) => element.selectionStart), includedSyntaxSource.indexOf('\n') + 1 + 8,
      'cross-file syntax diagnostics navigate to the included file and original token column');
    await fs.writeFile(syntaxDiagnosticModulePath, validSyntaxDiagnosticModuleSource, 'utf8');
    const linkedUnreachableSource = 'scene start {\ngoto ending\nsay narrator "dead"\n}\nscene ending { wait 1 }';
    await editor.fill(linkedUnreachableSource);
    await page.waitForFunction(() => document.querySelector('#result')?.textContent.includes('unreachable-code'));
    const unreachableLink = page.locator('#result .diagnostic-link').filter({ hasText: 'unreachable-code' }).first();
    await unreachableLink.click();
    assert.equal(await editor.evaluate((element) => element.selectionStart), linkedUnreachableSource.indexOf('say narrator'));
    await editor.press('Control+Shift+f');
    const linkedUnreachableFormatted = 'scene start {\n  goto ending\n  say narrator "dead"\n}\nscene ending {\n  wait 1\n}';
    assert.equal(await editor.inputValue(), linkedUnreachableFormatted);
    assert.equal(await editor.evaluate((element) => element.selectionStart), linkedUnreachableFormatted.indexOf('say narrator'));
    await editor.fill('scene formatted {\nsay narrator "line"\n}');
    await page.locator('#scene-name').focus();
    await page.keyboard.press('Control+Shift+F');
    assert.equal(await editor.inputValue(), 'scene formatted {\n  say narrator "line"\n}');
    await editor.fill('scene menu_format{say narrator "menu"}');
    await page.locator('[data-menu="edit"]').click();
    await page.locator('[data-menu-action="format"]').click();
    assert.equal(await editor.inputValue(), 'scene menu_format {\n  say narrator "menu"\n}');
    await editor.fill('scene project_format{say narrator "project"}');
    await page.locator('[data-menu="edit"]').click();
    await page.locator('[data-menu-action="format-project"]').click();
    await page.waitForFunction(() => document.querySelector('#editor')?.value === 'scene project_format {\n  say narrator "project"\n}');
    const unformatted = 'dict[int] data={"brace":"{ untouched }"}\nif(j==2){\nsay narrator "a  b {j}" # keep  comment\n}\nelse{\nfor i from 2 to 0 step -1{\nsay narrator "miss"\n}\n}';
    const formatted = 'dict[int] data = { "brace": "{ untouched }" }\nif (j == 2) {\n  say narrator "a  b {j}"  # keep  comment\n} else {\n  for i from 2 to 0 step -1 {\n    say narrator "miss"\n  }\n}';
    await editor.fill(unformatted);
    await editor.dispatchEvent('keydown', { key: 'Process', code: 'KeyF', ctrlKey: true, shiftKey: true });
    assert.equal(await editor.inputValue(), formatted);
    await editor.press('Control+z');
    assert.equal(await editor.inputValue(), unformatted);
    await editor.press('Control+Shift+z');
    assert.equal(await editor.inputValue(), formatted);
    await editor.fill('choice "please" {\n  "a" {\n    say narrator "ok"\n    }}');
    await editor.press('Control+Shift+f');
    assert.equal(await editor.inputValue(), 'choice "please" {\n  "a" {\n    say narrator "ok"\n  }\n}');
    const structuredUnformatted = 'scene nested{\nif ready{\nset value=-1\nsay narrator "text } { # stays inside string" // keep  comment\n}else{\nwhile value>0{\nset value=value-1\n}\n}\n}';
    const structuredFormatted = 'scene nested {\n  if ready {\n    set value = -1\n    say narrator "text } { # stays inside string"  // keep  comment\n  } else {\n    while value > 0 {\n      set value = value - 1\n    }\n  }\n}';
    await editor.fill(structuredUnformatted);
    await editor.press('Control+Shift+f');
    assert.equal(await editor.inputValue(), structuredFormatted);
    await editor.press('Control+Shift+f');
    assert.equal(await editor.inputValue(), structuredFormatted, 'formatting must be idempotent');
    await editor.fill(structuredUnformatted);
    const selectedStart = structuredUnformatted.indexOf('say narrator');
    const selectedEnd = selectedStart + 'say narrator "text'.length;
    await editor.evaluate((element, range) => element.setSelectionRange(range.start, range.end), { start: selectedStart, end: selectedEnd });
    await editor.press('Control+Shift+f');
    const formattedSelectedStart = structuredFormatted.indexOf('say narrator');
    assert.equal(await editor.evaluate((element) => element.selectionStart), formattedSelectedStart);
    assert.equal(await editor.evaluate((element) => element.selectionEnd), formattedSelectedStart + 'say narrator "text'.length);
    await editor.fill(structuredUnformatted);
    const multiStart = structuredUnformatted.indexOf('if ready');
    const multiEnd = structuredUnformatted.indexOf('\n}\n}', multiStart);
    await editor.evaluate((element, range) => element.setSelectionRange(range.start, range.end), { start: multiStart, end: multiEnd });
    await editor.press('Control+Shift+f');
    const formattedMultiStart = structuredFormatted.indexOf('if ready');
    const formattedMultiEnd = structuredFormatted.indexOf('set value = value - 1', formattedMultiStart) + 'set value = value - 1'.length;
    assert.equal(await editor.evaluate((element) => element.selectionStart), formattedMultiStart);
    assert.equal(await editor.evaluate((element) => element.selectionEnd), formattedMultiEnd);
    const markerCollisionSource = 'scene main{\nsay narrator "__NOVEL_EDITOR_CURSOR__ __NOVEL_EDITOR_SELECTION_END__"\n}';
    const markerCollisionFormatted = 'scene main {\n  say narrator "__NOVEL_EDITOR_CURSOR__ __NOVEL_EDITOR_SELECTION_END__"\n}';
    await editor.fill(markerCollisionSource);
    const collisionCaret = markerCollisionSource.indexOf('__NOVEL_EDITOR_SELECTION_END__');
    await editor.evaluate((element, caret) => element.setSelectionRange(caret, caret), collisionCaret);
    await editor.press('Control+Shift+f');
    assert.equal(await editor.inputValue(), markerCollisionFormatted);
    assert.equal(await editor.evaluate((element) => element.selectionStart), markerCollisionFormatted.indexOf('__NOVEL_EDITOR_SELECTION_END__'));
    const identifierCaretSource = 'scene main{\nshow hero.normal far_left\n}';
    const identifierCaretFormatted = 'scene main {\n  show hero.normal far_left\n}';
    await editor.fill(identifierCaretSource);
    const identifierCaret = identifierCaretSource.indexOf('far_left') + 'far'.length;
    await editor.evaluate((element, caret) => element.setSelectionRange(caret, caret), identifierCaret);
    await editor.press('Control+Shift+f');
    assert.equal(await editor.inputValue(), identifierCaretFormatted);
    assert.equal(await editor.evaluate((element) => element.selectionStart), identifierCaretFormatted.indexOf('far_left') + 'far'.length);
    await editor.fill(identifierCaretSource);
    const identifierSelectionStart = identifierCaretSource.indexOf('far_left') + 1;
    const identifierSelectionEnd = identifierCaretSource.indexOf('far_left') + 'far_le'.length;
    await editor.evaluate((element, range) => element.setSelectionRange(range.start, range.end), { start: identifierSelectionStart, end: identifierSelectionEnd });
    await editor.press('Control+Shift+f');
    assert.equal(await editor.inputValue(), identifierCaretFormatted);
    const formattedIdentifierStart = identifierCaretFormatted.indexOf('far_left') + 1;
    const formattedIdentifierEnd = identifierCaretFormatted.indexOf('far_left') + 'far_le'.length;
    assert.equal(await editor.evaluate((element) => element.selectionStart), formattedIdentifierStart);
    assert.equal(await editor.evaluate((element) => element.selectionEnd), formattedIdentifierEnd);
    const operatorCaretSource = 'scene main{\nif score>=10{\nsay narrator "ok"\n}\n}';
    const operatorCaretFormatted = 'scene main {\n  if score >= 10 {\n    say narrator "ok"\n  }\n}';
    await editor.fill(operatorCaretSource);
    const operatorCaret = operatorCaretSource.indexOf('>=') + 1;
    await editor.evaluate((element, caret) => element.setSelectionRange(caret, caret), operatorCaret);
    await editor.press('Control+Shift+f');
    assert.equal(await editor.inputValue(), operatorCaretFormatted);
    assert.equal(await editor.evaluate((element) => element.selectionStart), operatorCaretFormatted.indexOf('>=') + 1);
    await editor.fill(operatorCaretSource);
    const operatorSelectionStart = operatorCaretSource.indexOf('>=');
    const operatorSelectionEnd = operatorSelectionStart + 2;
    await editor.evaluate((element, range) => element.setSelectionRange(range.start, range.end), { start: operatorSelectionStart, end: operatorSelectionEnd });
    await editor.press('Control+Shift+f');
    assert.equal(await editor.inputValue(), operatorCaretFormatted);
    assert.equal(await editor.evaluate((element) => element.selectionStart), operatorCaretFormatted.indexOf('>='));
    assert.equal(await editor.evaluate((element) => element.selectionEnd), operatorCaretFormatted.indexOf('>=') + 2);
    const unaryCaretSource = 'scene main{\nset value=-1\n}';
    const unaryCaretFormatted = 'scene main {\n  set value = -1\n}';
    await editor.fill(unaryCaretSource);
    const unaryCaret = unaryCaretSource.indexOf('-1');
    await editor.evaluate((element, caret) => element.setSelectionRange(caret, caret), unaryCaret);
    await editor.press('Control+Shift+f');
    assert.equal(await editor.inputValue(), unaryCaretFormatted);
    assert.equal(await editor.evaluate((element) => element.selectionStart), unaryCaretFormatted.indexOf('-1'));
    const wholeDocumentSource = 'scene whole{\nsay narrator "all"\n}\n';
    const wholeDocumentFormatted = 'scene whole {\n  say narrator "all"\n}\n';
    await editor.fill(wholeDocumentSource);
    await editor.evaluate((element) => element.setSelectionRange(0, element.value.length));
    await editor.press('Control+Shift+f');
    assert.equal(await editor.inputValue(), wholeDocumentFormatted);
    assert.equal(await editor.evaluate((element) => element.selectionStart), 0);
    assert.equal(await editor.evaluate((element) => element.selectionEnd), wholeDocumentFormatted.length);
    await editor.fill(structuredUnformatted);
    await editor.press('Control+Shift+f');
    assert.equal(await editor.inputValue(), structuredFormatted);
    await editor.press('End');
    await editor.type('x');
    assert.equal((await editor.inputValue()).endsWith('}x'), true);
    await editor.press('Control+z');
    assert.equal(await editor.inputValue(), structuredFormatted, 'undo must remove typing before formatting');
    await editor.press('Control+z');
    assert.equal(await editor.inputValue(), structuredUnformatted, 'second undo must restore the pre-format source');
    await editor.press('Control+Shift+z');
    assert.equal(await editor.inputValue(), structuredFormatted, 'redo must restore formatting');
    await editor.press('Control+Shift+z');
    assert.equal((await editor.inputValue()).endsWith('}x'), true, 'second redo must restore typing');
    const branchWhitespaceSource = 'if 1==1{\nsay narrator "yes"\n}\n\nelif 1==0{\nsay narrator "maybe"\n}\n\nelse{\nsay narrator "no"\n}';
    const branchWhitespaceFormatted = 'if 1 == 1 {\n  say narrator "yes"\n} elif 1 == 0 {\n  say narrator "maybe"\n} else {\n  say narrator "no"\n}';
    await editor.fill(branchWhitespaceSource);
    const branchSelectionStart = branchWhitespaceSource.indexOf('say narrator "maybe"');
    const branchSelectionEnd = branchSelectionStart + 'say narrator "maybe"'.length;
    await editor.evaluate((element, range) => element.setSelectionRange(range.start, range.end), { start: branchSelectionStart, end: branchSelectionEnd });
    await editor.press('Control+Shift+f');
    assert.equal(await editor.inputValue(), branchWhitespaceFormatted);
    assert.equal(await editor.evaluate((element) => element.selectionStart), branchWhitespaceFormatted.indexOf('say narrator "maybe"'));
    assert.equal(await editor.evaluate((element) => element.selectionEnd), branchWhitespaceFormatted.indexOf('say narrator "maybe"') + 'say narrator "maybe"'.length);
    const formatterCorpus = [
      ['scene crlf {\r\nsay narrator "line"\r\n\r\n}', 'scene crlf {\n  say narrator "line"\n\n}'],
      ['scene tabs {\t\r\n\tif ready {\t\r\n\tset value=-1\t\r\n\t}\t\r\n}', 'scene tabs {\n  if ready {\n    set value = -1\n  }\n}'],
      ['set value=- -1', 'set value = - -1'],
      ['for i from -1 to +1 step -1{say narrator "loop"}', 'for i from -1 to +1 step -1 {\n  say narrator "loop"\n}'],
      ['fn choose(data:dict[str])->str{return data["key"]}', 'fn choose(data: dict[str]) -> str {\n  return data["key"]\n}'],
      ['if score>=-1{say narrator "signed"}', 'if score >= -1 {\n  say narrator "signed"\n}'],
      ['if not(score==1){return(-1)}', 'if not (score == 1) {\n  return (-1)\n}'],
      ['choice(route){"ok"{say narrator "choice"}}', 'choice (route) {\n  "ok" {\n    say narrator "choice"\n  }\n}'],
      ['show hero.normal far_left', 'show hero.normal far_left'],
      ['show image splash far_right', 'show image splash far_right'],
      ['set item[0]=fn("a,b") # keep {comment}', 'set item[0] = fn("a,b")  # keep {comment}'],
      ['if ready { set data = { "key": 1 } }', 'if ready {\n  set data = { "key": 1 }\n}'],
      ['dict[int] data = {\n1: 2\n}', 'dict[int] data = {\n  1: 2\n}'],
      ['if ready {\nset data = {\n1: 2\n}\n}', 'if ready {\n  set data = {\n    1: 2\n  }\n}'],
      ['if ready {\nset data = {\n"nested": {\n"x": 1\n} # nested\n}\n}', 'if ready {\n  set data = {\n    "nested": {\n      "x": 1\n    }  # nested\n  }\n}'],
      ['if ready { set data = { "nested": { "x": 1 } } }', 'if ready {\n  set data = { "nested": { "x": 1 } }\n}'],
      ['if a { say narrator "A" } elif b { say narrator "B" } else { say narrator "C" }', 'if a {\n  say narrator "A"\n} elif b {\n  say narrator "B"\n} else {\n  say narrator "C"\n}'],
      ['scene trailing {\n  # comment   \n  say narrator "line"\t\n   \n}', 'scene trailing {\n  # comment\n  say narrator "line"\n\n}'],
      ['if a { say narrator "A" }\n\nelif b { say narrator "B" }\n\nelse { say narrator "C" }', 'if a {\n  say narrator "A"\n} elif b {\n  say narrator "B"\n} else {\n  say narrator "C"\n}'],
      ['dict[str] data={"x":{"y":1}}', 'dict[str] data = { "x": { "y": 1 } }'],
      ['set data = fn({ "x": 1 })', 'set data = fn({ "x": 1 })'],
      ['if ready { set data = fn({ "x": 1 }) }', 'if ready {\n  set data = fn({ "x": 1 })\n}'],
      ['if ready { say narrator "x" } # trailing block comment', 'if ready {\n  say narrator "x"\n}  # trailing block comment'],
      ['if ready { say narrator "x" } // trailing block comment', 'if ready {\n  say narrator "x"\n}  // trailing block comment'],
      ['character hero { name="Hero"\npose normal="asset/hero.png"\n}', 'character hero {\n  name = "Hero"\n  pose normal = "asset/hero.png"\n}'],
      ['character hero { name="Hero"\npose normal="asset/hero.png" }', 'character hero {\n  name = "Hero"\n  pose normal = "asset/hero.png"\n}'],
      ['struct Player{name:str\ncoins:int}\nPlayer p={"name":"Y","coins":0}', 'struct Player {\n  name: str\n  coins: int\n}\nPlayer p = { "name": "Y", "coins": 0 }'],
      ['set __NOVEL_EDITOR_CURSOR__value=1', 'set __NOVEL_EDITOR_CURSOR__value = 1'],
      ['fn build() -> dict[str] { return { "x": "y" } }', 'fn build() -> dict[str] {\n  return { "x": "y" }\n}'],
      ['fn greet() -> none { say narrator "hello" }', 'fn greet() -> none {\n  say narrator "hello"\n}'],
      ['choice "route"{"one"{say narrator "A"}"two"{say narrator "B"}}', 'choice "route" {\n  "one" {\n    say narrator "A"\n  }\n  "two" {\n    say narrator "B"\n  }\n}'],
      ['choice{"one"{say narrator "A"}"two"{say narrator "B"}}', 'choice {\n  "one" {\n    say narrator "A"\n  }\n  "two" {\n    say narrator "B"\n  }\n}'],
      ['choice{route{say narrator "A"}next(){say narrator "B"}}', 'choice {\n  route {\n    say narrator "A"\n  }\n  next() {\n    say narrator "B"\n  }\n}'],
      ['choice choose({"key":"go"}){"ok"{say narrator "A"}}', 'choice choose({ "key": "go" }) {\n  "ok" {\n    say narrator "A"\n  }\n}'],
      ['choice{-(route){say narrator "A"}}', 'choice {\n  -(route) {\n    say narrator "A"\n  }\n}'],
      ['choice "route"{"a {b}"{say narrator "A"}}', 'choice "route" {\n  "a {b}" {\n    say narrator "A"\n  }\n}'],
      ['choice "route"{"a \\"b\\" {c}"{say narrator "A"}}', 'choice "route" {\n  "a \\"b\\" {c}" {\n    say narrator "A"\n  }\n}'],
      ['say narrator "escaped \\"quote\\" and \\{brace\\}"', 'say narrator "escaped \\"quote\\" and \\{brace\\}"'],
      ['scene commands{bg background\nbgm music\nshow hero.normal center fade 250\nplay se click\nplay voice line blocking\nplay video movie async\neffect fade black 500\nwait 100\nclear image splash\ngoto "next.tds"\n}', 'scene commands {\n  bg background\n  bgm music\n  show hero.normal center fade 250\n  play se click\n  play voice line blocking\n  play video movie async\n  effect fade black 500\n  wait 100\n  clear image splash\n  goto "next.tds"\n}'],
      ['global dict[str] labels={"first":{"next":"go"}}\nscene main{choice labels["first"]["next"]{"ok"{say narrator "selected"}}}', 'global dict[str] labels = { "first": { "next": "go" } }\nscene main {\n  choice labels["first"]["next"] {\n    "ok" {\n      say narrator "selected"\n    }\n  }\n}'],
      ['fn calculate(a:int,b:dict[str])->dict[int]{if a>=0 and not(b["ready"]=="no"){return {"ok":1}}else{return {"ok":0}}}', 'fn calculate(a: int, b: dict[str]) -> dict[int] {\n  if a >= 0 and not (b["ready"] == "no") {\n    return { "ok": 1 }\n  } else {\n    return { "ok": 0 }\n  }\n}'],
      ['scene incomplete {\nset value = fn(\n{"key":1}\n)\n}', 'scene incomplete {\n  set value = fn(\n  { "key": 1 }\n  )\n}'],
      ['}\nelse ] include if else "unterminated ] "unterminated { parallel', '}\nelse] include if else "unterminated ] " unterminated {\n  parallel'],
      ['\uFEFFscene bom{say narrator "normalized"}', 'scene bom {\n  say narrator "normalized"\n}'],
      ['scene unicode {\u2028say narrator "line"\u2029}', 'scene unicode {\n  say narrator "line"\n}'],
    ];
    for (const [input, expected] of formatterCorpus) {
      await editor.fill(input);
      await editor.press('Control+Shift+f');
      assert.equal(await editor.inputValue(), expected, `formatter corpus mismatch for ${input}`);
      await editor.press('Control+Shift+f');
      assert.equal(await editor.inputValue(), expected, `formatter corpus is not idempotent for ${input}`);
    }
    const formatterFuzzFailure = await editor.evaluate(() => {
      const atoms = [
        'scene main {', 'if ready {', 'say narrator "text {x}"', 'set value = -1',
        'choice {', 'choice choose(', '"label" {', 'route {', 'next() {', 'return { "x": 1 }',
        'set data = { "x": 1 }', 'set data = { "x": 1', '}', '} else {', 'wait 1', '# comment { }',
        '// comment { }', ''
      ];
      for (let seed = 1; seed <= 1000; seed++) {
        let value = seed;
        const lines = [];
        for (let index = 0; index < 8; index++) {
          value = (value * 1664525 + 1013904223) >>> 0;
          lines.push(atoms[value % atoms.length].replace(/ /g, () => (value++ % 4 === 0 ? '  ' : ' ')));
        }
        const source = lines.join('\n');
        const once = window.novelEditorApi.format(source);
        if (once !== window.novelEditorApi.format(once)) return { seed, source, once };
      }
      return null;
    });
    assert.equal(formatterFuzzFailure, null, 'formatter must be idempotent across generated whitespace/brace cases');
    const semanticSource = 'scene main{\nif 1==1{\nsay narrator "same meaning"\n}else{\nsay narrator "unreachable"\n}\n}';
    await editor.fill(semanticSource);
    const semanticFormatted = await editor.evaluate((element) => window.novelEditorApi.format(element.value));
    const originalCompile = await page.request.post(`${base}/api/compile`, { data: { name: 'main.tds', source: semanticSource } });
    const formattedCompile = await page.request.post(`${base}/api/compile`, { data: { name: 'main.tds', source: semanticFormatted } });
    assert.equal(originalCompile.ok(), true);
    assert.equal(formattedCompile.ok(), true);
    assert.deepEqual((await formattedCompile.json()).program, (await originalCompile.json()).program, 'formatting must preserve compiled semantics');
    const semanticCorpus = [
      'dict[int] data={"x":1}\nscene main{\nset data["x"]=2\nchoice "route"{"go"{set data["x"]=3}}\n}',
      'character hero { name="Hero" }\nscene main{say narrator "character metadata remains compilable"}',
      'dict[str] labels={"first":"go"}\nscene main{choice labels["first"]{"ok"{say narrator "selected"}}}',
      'dict[str] labels={"first":"go"}\nstr suffix=" now"\nscene main{choice labels["first"] + suffix {"ok"{say narrator "selected"}}}',
      'fn choose(data: dict[str]) -> str { return data["key"] }\nscene main{choice choose({"key":"go"}){"ok"{say narrator "selected"}}}',
      'scene main{if 1==1{say narrator "yes"}\n\nelif 1==0{say narrator "maybe"}\n\nelse{say narrator "no"}}',
      'fn check(score: int) -> int { if not(score==1){ return(-1) } return(0) }',
      'str audit_semantic_route="go"\nscene main{choice(audit_semantic_route){"ok"{say narrator "selected"}}}',
      'character hero {\nname="Hero"\npose normal="asset/char/aokami.png"\n}\nscene main{show hero.normal far_left}',
      'asset image splash="asset/char/aokami.png"\nscene main{show image splash far_right}',
    ];
    const withoutLocations = (value) => {
      if (Array.isArray(value)) return value.map(withoutLocations);
      if (!value || typeof value !== 'object') return value;
      const locationKeys = new Set(['line', 'column', 'startLine', 'startColumn', 'endLine', 'endColumn']);
      return Object.fromEntries(Object.entries(value).filter(([key]) => !locationKeys.has(key)).map(([key, item]) => [key, withoutLocations(item)]));
    };
    for (const source of semanticCorpus) {
      const formatted = await editor.evaluate((element, value) => window.novelEditorApi.format(value), source);
      const original = await page.request.post(`${base}/api/compile`, { data: { name: 'semantic.tds', source } });
      const reformatted = await page.request.post(`${base}/api/compile`, { data: { name: 'semantic.tds', source: formatted } });
      if (!original.ok()) throw new Error(`semantic corpus source must compile: ${source}\n${await original.text()}`);
      if (!reformatted.ok()) throw new Error(`formatted semantic corpus source must compile: ${formatted}\n${await reformatted.text()}`);
      assert.equal(original.ok(), true, `semantic corpus source must compile: ${source}`);
      assert.equal(reformatted.ok(), true, `formatted semantic corpus source must compile: ${formatted}`);
      assert.deepEqual(withoutLocations((await reformatted.json()).program), withoutLocations((await original.json()).program), 'mixed dictionary/novel blocks must preserve compiled semantics');
    }
    const locationSource = 'scene main {\ngoto end\nsay narrator "dead"\n}\nscene end { wait 1 }';
    const locationFormatted = await editor.evaluate((element, source) => window.novelEditorApi.format(source), locationSource);
    const locationBefore = await page.request.post(`${base}/api/validate`, { data: { name: 'main.tds', source: locationSource } });
    const locationAfter = await page.request.post(`${base}/api/validate`, { data: { name: 'main.tds', source: locationFormatted } });
    assert.equal(locationBefore.ok(), true);
    assert.equal(locationAfter.ok(), true);
    const beforeDiagnostics = (await locationBefore.json()).diagnostics.filter((item) => item.code === 'unreachable-code');
    const afterDiagnostics = (await locationAfter.json()).diagnostics.filter((item) => item.code === 'unreachable-code');
    assert.equal(beforeDiagnostics.length, 1);
    assert.equal(afterDiagnostics.length, 1);
    assert.equal(afterDiagnostics[0].line, beforeDiagnostics[0].line);
    assert.equal(afterDiagnostics[0].message, beforeDiagnostics[0].message);
    assert.equal(afterDiagnostics[0].column, 3, 'diagnostic column must follow formatted indentation');
    await editor.fill('undo');
    await editor.press('End');
    await editor.type('x');
    await editor.press('Control+z');
    assert.equal(await editor.inputValue(), 'undo');
    await editor.fill('choice "please" {\n  "a" {\n  }\n}\nroot');
    await editor.press('End');
    await editor.press('Enter');
    assert.equal(await editor.inputValue(), 'choice "please" {\n  "a" {\n  }\n}\nroot\n');
    const indentSource = 'scene main {\n  say narrator "one"\n  wait 1\n}';
    await editor.fill(indentSource);
    const indentStart = indentSource.indexOf('  say');
    const indentEnd = indentSource.indexOf('\n}', indentStart);
    await editor.evaluate((element, range) => element.setSelectionRange(range.start, range.end), { start: indentStart, end: indentEnd });
    await editor.press('Tab');
    assert.equal(await editor.inputValue(), 'scene main {\n    say narrator "one"\n    wait 1\n}');
    assert.equal(await editor.evaluate((element) => element.selectionStart), indentStart + 2);
    assert.equal(await editor.evaluate((element) => element.selectionEnd), indentEnd + 4);
    await editor.press('Control+z');
    assert.equal(await editor.inputValue(), indentSource);
    await editor.press('Control+Shift+z');
    assert.equal(await editor.inputValue(), 'scene main {\n    say narrator "one"\n    wait 1\n}');
    await editor.press('Shift+Tab');
    assert.equal(await editor.inputValue(), indentSource);
    assert.equal(await editor.evaluate((element) => element.selectionStart), indentStart);
    assert.equal(await editor.evaluate((element) => element.selectionEnd), indentEnd);
    await editor.fill('');
    const pastedSource = 'scene pasted{\nsay narrator "paste  {x}"\n}';
    await editor.evaluate((element, value) => {
      const data = new DataTransfer();
      data.setData('text/plain', value);
      element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
    }, pastedSource);
    assert.equal(await editor.inputValue(), 'scene pasted {\n  say narrator "paste  {x}"\n}');
    await editor.fill('');
    const droppedSource = 'scene dropped{\nsay narrator "drop"\n}';
    await editor.evaluate((element, value) => {
      const data = new DataTransfer();
      data.setData('text/plain', value);
      element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
    }, droppedSource);
    assert.equal(await editor.inputValue(), 'scene dropped {\n  say narrator "drop"\n}');
    await editor.fill('scene generated');
    await editor.press('Escape');
    await editor.press('Enter');
    assert.equal(await editor.inputValue(), 'scene generated {\n  \n}\n');
    await editor.fill('scene braced {');
    await editor.press('Escape');
    await editor.press('Enter');
    assert.equal(await editor.inputValue(), 'scene braced {\n  \n}');
    await editor.fill('fn greet(name: str) -> none');
    await editor.press('Escape');
    await editor.press('Enter');
    assert.equal(await editor.inputValue(), 'fn greet(name: str) -> none {\n  \n}\n');
    await editor.fill('fn build() -> dict[str]');
    await editor.press('Escape');
    await editor.press('Enter');
    assert.equal(await editor.inputValue(), 'fn build() -> dict[str] {\n  \n}\n');
    await editor.fill('choice');
    await editor.press('Escape');
    await editor.press('Enter');
    assert.equal(await editor.inputValue(), 'choice {\n  "" {\n  }\n}\n');
    await editor.fill('choice {');
    await editor.press('Escape');
    await editor.press('Enter');
    assert.equal(await editor.inputValue(), 'choice {\n  "" {\n  }\n}');
    await editor.fill('elif ready');
    await editor.press('Escape');
    await editor.press('Enter');
    assert.equal(await editor.inputValue(), 'elif ready {\n  \n}\n');
    await editor.fill('scene closing {\n  say narrator "done"\n  ');
    await editor.press('}');
    assert.equal(await editor.inputValue(), 'scene closing {\n  say narrator "done"\n}');
    await editor.fill('scene virtual {\nsay narrator "line"');
    await editor.evaluate((element) => element.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertLineBreak' })));
    assert.equal(await editor.inputValue(), 'scene virtual {\nsay narrator "line"\n', 'ordinary newline does not reformat preceding lines');
    await editor.fill('scene virtual_close {\n  say narrator "line"\n  ');
    await editor.evaluate((element) => element.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: '}' })));
    assert.equal(await editor.inputValue(), 'scene virtual_close {\n  say narrator "line"\n}');
    await editor.fill(`asset bg school = "asset/bg/school.jpg"\nfn greet(name: str) -> none {\n  # greeting\n  say narrator "Hello {name}"\n}\nscene start { greet("range") }`);
    await page.waitForTimeout(100);
    for (const selector of ['.hl-keyword', '.hl-type', '.hl-function', '.hl-declaration', '.hl-scene', '.hl-asset', '.hl-string', '.hl-interpolation', '.hl-comment', '.hl-punctuation']) {
      assert.ok(await page.locator(`#highlight ${selector}`).count() >= 1, `Missing syntax scope ${selector}`);
    }
    await editor.fill(`asset bg school = "asset/bg/school.jpg"\nfn greet(name: str) -> none {\n  # greeting\n  say narrator "Hello {name}"\n}\nscene start {\n  greet("range")\n  show hero.normal far_left\n}`);
    await page.waitForTimeout(100);
    assert.ok(await page.locator('#highlight .hl-builtin').filter({ hasText: 'far_left' }).count() >= 1);
    assert.equal(await page.locator('#highlight .hl-string').first().evaluate((element) => getComputedStyle(element).color), 'rgb(156, 220, 254)');
    assert.deepEqual(pageErrors, []);
    console.log('PASS editor: grammar-aware autocomplete, Ctrl+Shift+F formatting, live diagnostics, scoped syntax highlighting');
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(auditProjectRoot, { recursive: true, force: true });
    if (previousProjectRoot === undefined) delete process.env.NOVEL_PROJECT_ROOT;
    else process.env.NOVEL_PROJECT_ROOT = previousProjectRoot;
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
