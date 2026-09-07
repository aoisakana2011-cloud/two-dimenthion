const { chromium } = require('../build/audit-tools/node_modules/playwright');
const { handleApi, serveStatic } = require('../Edit/server');
const http = require('node:http');
const assert = require('node:assert/strict');

(async () => {
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
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(`${base}/index.html`);
    const editor = page.locator('#editor');
    await editor.waitFor();
    // Startup restores the last/first scene after an 800 ms timer.
    await page.waitForTimeout(1200);
    assert.equal(await page.locator('#split-editor').count(), 0);
    assert.equal(await page.locator('#new-scene').count(), 0);
    assert.equal(await page.locator('[data-predict="say "] small').textContent(), 'セリフ');
    const topLevelFolder = page.locator('#file-tree > .scene-folder').first();
    const topLevelContents = topLevelFolder.locator('xpath=following-sibling::div[1]');
    assert.equal(await topLevelContents.getAttribute('hidden'), '');
    await topLevelFolder.click();
    assert.equal(await topLevelContents.getAttribute('hidden'), null);
    await topLevelFolder.click();
    assert.equal(await topLevelContents.getAttribute('hidden'), '');
    await topLevelFolder.click();
    assert.equal(await topLevelContents.getAttribute('hidden'), null);
    const currentScene = await page.locator('#scene-name').inputValue();
    const currentFile = page.locator(`#file-tree .scene-file[data-path="scenes/${currentScene}"]`);
    const deleteButton = currentFile.locator('.tree-action.delete');
    assert.equal(await deleteButton.locator('xpath=..').evaluate((element) => element.tagName), 'DIV');
    await deleteButton.click();
    await page.locator('.editor-dialog').waitFor();
    assert.match(await page.locator('.editor-dialog').textContent(), /削除しますか/);
    await page.getByRole('button', { name: 'キャンセル' }).click();
    assert.equal(await page.locator('.editor-tab-split').first().isVisible(), true);
    assert.equal(await page.locator('.editor-tab-split').first().textContent(), '->|');
    const leftTabFontSize = await page.locator('#editor-tabs .editor-tab-name').first().evaluate((element) => getComputedStyle(element).fontSize);
    const tabControlCenters = await page.locator('.editor-tab').first().evaluate((tab) => {
      const split = tab.querySelector('.editor-tab-split').getBoundingClientRect();
      const close = tab.querySelector('.editor-tab-close').getBoundingClientRect();
      return [split.top + split.height / 2, close.top + close.height / 2];
    });
    assert.ok(Math.abs(tabControlCenters[0] - tabControlCenters[1]) < 0.5);
    await currentFile.locator('.scene-file-open').click({ modifiers: ['Shift'] });
    assert.equal(await page.locator('#split-group').isVisible(), true);
    const splitFrame = page.frameLocator('#split-frame');
    await splitFrame.locator('#editor').waitFor();
    assert.equal(await splitFrame.locator('html.embedded-editor').count(), 1);
    assert.equal(await page.locator('#editor-tabs .editor-tab').count(), 0);
    assert.equal(await page.locator('#split-tabs .editor-tab').count(), 1);
    assert.equal(await page.locator('#split-tabs .editor-tab-unsplit').textContent(), '|<-');
    assert.equal(await page.locator('#split-tabs .editor-tab-name').evaluate((element) => getComputedStyle(element).fontSize), leftTabFontSize);
    await page.locator('#split-tabs .editor-tab-unsplit').click();
    await page.locator('#editor-tabs .editor-tab').first().waitFor();
    assert.equal(await page.locator('#editor-tabs .editor-tab').count(), 1);
    assert.equal(await page.locator('#split-tabs .editor-tab').count(), 0);
    assert.equal(await page.locator('#split-group').isVisible(), false);
    await page.locator('#editor-tabs .editor-tab-split').click();
    await splitFrame.locator('#editor').waitFor();
    assert.equal(await page.locator('#editor-tabs .editor-tab').count(), 0);
    assert.equal(await page.locator('#split-tabs .editor-tab').count(), 1);
    assert.equal(await page.locator('#save-split').count(), 0);
    assert.equal(await page.locator('#save').textContent(), 'すべて保存');
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
    await page.locator('#save').click();
    await page.waitForFunction(() => document.querySelector('#save')?.textContent === 'すべて保存');
    assert.equal(await splitFrame.locator('body').evaluate(() => window.novelEditorApi.isDirty()), false);
    await splitFrame.locator('#editor').fill('unsaved split test 2');
    page.once('dialog', (dialog) => dialog.dismiss());
    await page.locator('#close-split').click();
    assert.equal(await page.locator('#split-group').isVisible(), true);
    await page.locator('#save').click();
    await page.waitForFunction(() => document.querySelector('#save')?.textContent === 'すべて保存');
    await page.locator('#split-tabs .editor-tab-unsplit').click();
    await page.locator('#editor-tabs .editor-tab').first().waitFor();
    assert.equal(await page.locator('#split-group').isVisible(), false);
    assert.deepEqual(await page.locator('[data-predict]').evaluateAll((buttons) => buttons.map((button) => button.dataset.predict)), [
      'char ', 'say ', 'bgm ', 'play se ', 'choice ', 'if ', 'for ', 'asset ', 'fn ', 'goto '
    ]);
    assert.equal(await page.locator('[data-predict="asset "]').isVisible(), false);
    assert.equal(await page.locator('#insert-toggle').textContent(), '展開');
    assert.equal(await page.locator('#insert-toggle').getAttribute('aria-expanded'), 'false');
    await page.locator('#insert-toggle').click();
    assert.equal(await page.locator('[data-predict="asset "]').isVisible(), true);
    assert.equal(await page.locator('#insert-toggle').textContent(), '閉じる');
    assert.equal(await page.locator('#insert-toggle').getAttribute('aria-expanded'), 'true');
    await editor.fill('');
    await page.locator('[data-predict="say "]').click();
    assert.equal(await editor.inputValue(), 'say ');
    assert.equal(await page.locator('#suggestions').isVisible(), false);
    await editor.type('n');
    await page.waitForTimeout(100);
    assert.equal(await page.locator('#suggestions').isVisible(), false);
    await editor.type('a');
    await page.waitForFunction(() => document.querySelector('#suggestions')?.textContent.includes('narrator'));
    assert.match(await page.locator('#suggestions .suggestion.active').textContent(), /^Enter › narrator$/);
    await editor.press('Enter');
    assert.equal(await editor.inputValue(), 'say narrator ""');
    assert.ok((await page.locator('#scene-name').inputValue()).length > 0);
    await editor.fill('character aokami { normal = "assets/char/aokami.png" }\n');
    await editor.press('End');
    await page.locator('[data-predict="char "]').click();
    assert.equal(await page.locator('#suggestions').isVisible(), false);
    await editor.type('ao');
    await page.waitForTimeout(200);
    assert.match(await page.locator('#suggestions').textContent(), /aokami/);
    await editor.fill('c');
    await page.waitForTimeout(100);
    assert.equal(await page.locator('#suggestions').isVisible(), false);
    await editor.fill('cho');
    await page.waitForFunction(() => document.querySelector('#suggestions')?.textContent.includes('choice'));
    await editor.press('Enter');
    assert.equal(await editor.inputValue(), 'choice ');
    await editor.fill('if(score==1)');
    await editor.press('Enter');
    assert.equal(await editor.inputValue(), 'if(score==1) {\n  \n}\n');
    await editor.fill(`str editor_title = "文字列"
scene analysis {
  if 1 == 2 {
    say narrator "到達しない"
  }
  say narrator title
}`);
    await page.waitForTimeout(1500);
    const resultText = await page.locator('#result').textContent();
    if (!resultText.includes('constant-condition')) throw new Error(`Live diagnostics were not rendered: ${resultText}`);
    assert.match(await page.locator('#result').textContent(), /警告 [1-9]/);
    assert.ok(await page.locator('#highlight .hl-warning').count() >= 1);
    await editor.fill('scene formatted {\nsay narrator "line"\n}');
    await page.locator('#scene-name').focus();
    await page.keyboard.press('Control+Shift+F');
    assert.equal(await editor.inputValue(), 'scene formatted {\n  say narrator "line"\n}');
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
    await editor.fill('undo');
    await editor.press('End');
    await editor.type('x');
    await editor.press('Control+z');
    assert.equal(await editor.inputValue(), 'undo');
    await editor.fill('choice "please" {\n  "a" {\n  }\n}\nroot');
    await editor.press('End');
    await editor.press('Enter');
    assert.equal(await editor.inputValue(), 'choice "please" {\n  "a" {\n  }\n}\nroot\n');
    await editor.fill(`asset bg school = "assets/bg/school.jpg"
fn greet(name: str) -> none {
  # greeting
  say narrator "Hello {name}"
}
scene start { greet("range") }`);
    await page.waitForTimeout(100);
    for (const selector of ['.hl-keyword', '.hl-type', '.hl-function', '.hl-declaration', '.hl-scene', '.hl-asset', '.hl-string', '.hl-interpolation', '.hl-comment', '.hl-punctuation']) {
      assert.ok(await page.locator(`#highlight ${selector}`).count() >= 1, `Missing syntax scope ${selector}`);
    }
    assert.equal(await page.locator('#highlight .hl-string').first().evaluate((element) => getComputedStyle(element).color), 'rgb(156, 220, 254)');
    assert.deepEqual(pageErrors, []);
    console.log('PASS editor: predictive command buttons, collapse behavior, Ctrl+Shift+F formatting, live diagnostics, scoped syntax highlighting');
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
