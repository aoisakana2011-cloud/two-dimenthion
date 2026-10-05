'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('../build/audit-tools/node_modules/playwright');
const { seedEmptyProject } = require('../tools/project-layout');

(async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-symbol-help-'));
  const previousProjectRoot = process.env.NOVEL_PROJECT_ROOT;
  const layout = seedEmptyProject(projectRoot);
  await fs.writeFile(path.join(layout.dataRoot, 'variables.json'), JSON.stringify({
    staticVariables: [
      { name: 'route', type: 'str', value: 'summer', possibleValues: ['summer', 'winter'] },
      { name: 'volume', type: 'float', value: 0.5, min: 0, max: 1 },
    ],
  }, null, 2));
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
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
    const editor = page.locator('#editor');
    const contextMenu = page.locator('.editor-context-menu');
    await page.waitForFunction(() => document.querySelector('#scene-name')?.value === 'main.tds');
    const source = 'struct Vec2 {\n  x: float\n  y: float\n}\nglobal int score = 1\nfn scale(point: Vec2, factor: float) -> float {\n  return point.x * factor\n}\nscene main {\n  if score == 1 and score > 0 {\n    wait 1\n  }\n}\n';
    await editor.fill(source);
    const dispatchRightClickToken = async (line, name) => editor.evaluate((element, target) => {
      const lines = element.value.split(/\r?\n/);
      const index = lines[target.line - 1].indexOf(target.name);
      if (index < 0) throw Error(`missing ${target.name}`);
      const absolute = lines.slice(0, target.line - 1).reduce((offset, text) => offset + text.length + 1, 0) + index;
      const walker = document.createTreeWalker(document.querySelector('#highlight'), NodeFilter.SHOW_TEXT);
      let offset = 0;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (absolute >= offset && absolute < offset + node.length) {
          const range = document.createRange();
          range.setStart(node, absolute - offset); range.setEnd(node, absolute - offset + 1);
          const rect = range.getBoundingClientRect();
          element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }));
          return;
        }
        offset += node.length;
      }
      throw Error(`could not locate ${target.name}`);
    }, { line, name });
    const rightClickToken = async (line, name) => {
      await dispatchRightClickToken(line, name);
      await contextMenu.waitFor({ state: 'visible' });
      await contextMenu.getByRole('menuitem', { name: 'シンボル情報を表示' }).click();
    };
    const tooltip = page.locator('.variable-tooltip');
    await dispatchRightClickToken(6, 'scale');
    await contextMenu.waitFor({ state: 'visible' });
    const menuText = await contextMenu.textContent();
    assert.match(menuText, /定義へ移動[\s\S]*シンボル情報を表示[\s\S]*貼り付け[\s\S]*すべて選択/);
    assert.doesNotMatch(menuText, /切り取り|コピー/);
    assert.equal(await contextMenu.evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(37, 37, 38)');
    await contextMenu.getByRole('menuitem', { name: 'シンボル情報を表示' }).click();
    await tooltip.waitFor({ state: 'visible' });
    assert.match(await tooltip.textContent(), /scale\(point: Vec2, factor: float\) -> float/);
    assert.doesNotMatch(await tooltip.textContent(), /引数は宣言順|引数:|戻り値:/, 'the signature already contains parameter order, names, types, and return type');
    await dispatchRightClickToken(7, 'point');
    await contextMenu.getByRole('menuitem', { name: '定義へ移動' }).click();
    await page.waitForFunction(() => document.querySelector('#editor').value.slice(document.querySelector('#editor').selectionStart, document.querySelector('#editor').selectionEnd) === 'point');
    assert.equal(await editor.evaluate(element => element.value.slice(0, element.selectionStart).split('\n').length), 6, 'Go to Definition jumps to the parameter declaration');
    const factorUse = source.indexOf('factor', source.indexOf('return point'));
    await editor.evaluate((element, offset) => { element.focus(); element.setSelectionRange(offset, offset); }, factorUse);
    await editor.press('F12');
    await page.waitForFunction(() => document.querySelector('#editor').value.slice(document.querySelector('#editor').selectionStart, document.querySelector('#editor').selectionEnd) === 'factor');
    assert.equal(await editor.evaluate(element => element.value.slice(0, element.selectionStart).split('\n').length), 6, 'F12 uses the same definition resolver as the context menu');
    await rightClickToken(1, 'Vec2');
    await tooltip.waitFor({ state: 'visible' });
    assert.match(await tooltip.textContent(), /struct Vec2/);
    assert.doesNotMatch(await tooltip.textContent(), /フィールド名と型は宣言された内容が有効/);
    assert.match(await tooltip.textContent(), /x: float/);
    assert.match(await tooltip.textContent(), /y: float/);
    await rightClickToken(2, 'x');
    await tooltip.waitFor({ state: 'visible' });
    assert.match(await tooltip.textContent(), /x: float/, 'right-clicking a struct field shows its declared type');
    assert.doesNotMatch(await tooltip.textContent(), /構造体のフィールドです/);
    await rightClickToken(5, 'score');
    await tooltip.waitFor({ state: 'visible' });
    assert.match(await tooltip.textContent(), /宣言時の初期値: 1/);
    assert.match(await tooltip.textContent(), /変更可能です/);
    assert.doesNotMatch(await tooltip.textContent(), /実行時の値域は静的には確定していません/);
    await rightClickToken(9, 'main');
    await tooltip.waitFor({ state: 'visible' });
    assert.match(await tooltip.textContent(), /scene main/);
    assert.doesNotMatch(await tooltip.textContent(), /シーンの入口です/);
    await rightClickToken(10, '==');
    await tooltip.waitFor({ state: 'visible' });
    assert.match(await tooltip.textContent(), /等しいかを比較/);
    await rightClickToken(10, 'and');
    await tooltip.waitFor({ state: 'visible' });
    assert.match(await tooltip.textContent(), /両方とも真/);
    await editor.fill('scene main {\n  if route == "winter" {\n    say narrator str(volume)\n  }\n}\n');
    await rightClickToken(2, 'route');
    await tooltip.waitFor({ state: 'visible' });
    assert.match(await tooltip.textContent(), /summer, winter/, 'configured finite string domains are shown on references');
    await rightClickToken(3, 'volume');
    await tooltip.waitFor({ state: 'visible' });
    assert.match(await tooltip.textContent(), /0[\s\S]*1/, 'configured numeric bounds are shown on references');
    await editor.fill('fn calculate(amount: int) -> int {\n  int local_value = 3\n  return amount + local_value\n}\nscene main {\n  wait 1\n}\n');
    await rightClickToken(2, 'local_value');
    await tooltip.waitFor({ state: 'visible' });
    assert.match(await tooltip.textContent(), /local_value/);
    assert.match(await tooltip.textContent(), /3/, 'local declaration details are joined to compiler symbols by source location');
    await rightClickToken(1, 'amount');
    await tooltip.waitFor({ state: 'visible' });
    assert.match(await tooltip.textContent(), /amount/);
    assert.match(await tooltip.textContent(), /int/, 'function parameters are included in declaration help');
    const shadowedBindings = `scene main {
  choice "choose a branch" {
    "number" {
      int token = 3
      say narrator str(token)
    }
    "text" {
      str token = "ready"
      say narrator token
    }
  }
}
`;
    await editor.fill(shadowedBindings);
    const textTokenLine = shadowedBindings.split('\n').findIndex(line => line.includes('str token =')) + 1;
    await rightClickToken(textTokenLine, 'token');
    await tooltip.waitFor({ state: 'visible' });
    assert.match(await tooltip.textContent(), /token\s*:\s*str/, 'same-named declarations in sibling branches keep the selected binding type');
    assert.match(await tooltip.textContent(), /"ready"/, 'same-named declarations in sibling branches keep the selected initializer');
    await editor.fill('include "std/math.tds" as math\nscene main {\n  wait math.lerp(0.0, 1.0, 0.5)\n}\n');
    await rightClickToken(3, 'lerp');
    await tooltip.waitFor({ state: 'visible' });
    assert.match(await tooltip.textContent(), /math\.lerp\(a: float, b: float, amount: float\) -> float/);
    await tooltip.locator('.variable-tooltip-location').getByText(/std\/math\.tds:117/).click();
    await page.waitForFunction(() => document.querySelector('#scene-name')?.value === 'std/math.tds');
    const openTabs = await page.locator('#editor-tabs .editor-tab-name').allTextContents();
    assert.ok(openTabs.includes('main.tds'), 'opening a definition keeps the referring file open in its own tab');
    assert.ok(openTabs.includes('math.tds'), 'the standard-library definition opens in a separate editor tab');
    assert.match(await editor.inputValue(), /fn lerp\(a: float/);
    assert.equal(await editor.isEditable(), false, 'standard-library definitions are read-only');
    await editor.evaluate(element => element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 50, clientY: 50 })));
    await contextMenu.waitFor({ state: 'visible' });
    assert.equal(await contextMenu.getByRole('menuitem', { name: '切り取り' }).count(), 0, 'the context menu omits cut');
    assert.equal(await contextMenu.getByRole('menuitem', { name: 'コピー' }).count(), 0, 'the context menu omits copy');
    assert.equal(await contextMenu.getByRole('menuitem', { name: '貼り付け' }).isDisabled(), true, 'read-only source cannot be pasted into');
    await page.keyboard.press('Escape');
    await contextMenu.waitFor({ state: 'hidden' });
    await page.locator('#editor-tabs .editor-tab-name').filter({ hasText: 'main.tds' }).click();
    await page.waitForFunction(() => document.querySelector('#scene-name')?.value === 'main.tds');
    await editor.fill('include "std/motion/walk.tds" as walk\nscene main {\n  walk.character("ayase", 1.0, 1, 1.0, 2.0)\n  wait walk.walk_x(1.0, 1.0)\n}\n');
    await rightClickToken(3, 'character');
    await tooltip.waitFor({ state: 'visible' });
    assert.match(await tooltip.textContent(), /walk\.character\(target_character: str, distance_px: float, cycles: int, seconds: float, bob_px: float\) -> none/,
      'the reserved method name resolves to the qualified standard-library function rather than declaration syntax');
    await tooltip.locator('.variable-tooltip-location').getByText(/std\/motion\/walk\.tds:13/).click();
    await page.waitForFunction(() => document.querySelector('#scene-name')?.value === 'std/motion/walk.tds');
    assert.match(await editor.inputValue(), /fn character\(target_character: str, distance_px: float, cycles: int, seconds: float, bob_px: float\)/);
    await page.locator('#editor-tabs .editor-tab-name').filter({ hasText: 'main.tds' }).click();
    await page.waitForFunction(() => document.querySelector('#scene-name')?.value === 'main.tds');
    await editor.fill('include "std/motion/walk.tds" as walk\nscene main {\n  wait walk.walk_x(1.0, 1.0)\n}\n');
    await rightClickToken(3, 'walk_x');
    await tooltip.waitFor({ state: 'visible' });
    assert.match(await tooltip.textContent(), /walk\.walk_x\(distance_px: float, progress: float\) -> float/);
    await tooltip.locator('.variable-tooltip-location').getByText(/std\/motion\/walk\.tds:5/).click();
    await page.waitForFunction(() => document.querySelector('#scene-name')?.value === 'std/motion/walk.tds');
    const tabsWithStandardLibrary = await page.locator('#editor-tabs .editor-tab-name').allTextContents();
    assert.ok(tabsWithStandardLibrary.includes('walk.tds'), 'standard library definitions open in their own editor tab');
    assert.ok(tabsWithStandardLibrary.includes('main.tds'), 'navigating into a standard library definition preserves the caller tab');
    assert.match(await editor.inputValue(), /fn walk_x\(distance_px: float, progress: float\)/);
    assert.equal(await editor.isEditable(), false, 'bundled standard library source is opened read-only rather than saved into the project');
    await page.locator('#editor-tabs .editor-tab-name').filter({ hasText: 'main.tds' }).click();
    await page.waitForFunction(() => document.querySelector('#scene-name')?.value === 'main.tds');
    assert.match(await editor.inputValue(), /walk\.walk_x\(1\.0, 1\.0\)/, 'the caller tab remains independently selectable');
    assert.equal(await editor.isEditable(), true, 'returning to the project tab restores normal editing');
    await editor.evaluate(element => element.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, clientX: window.innerWidth - 1, clientY: window.innerHeight - 1,
    })));
    await contextMenu.waitFor({ state: 'visible' });
    const menuBounds = await contextMenu.evaluate(element => {
      const { right, bottom } = element.getBoundingClientRect();
      return { right, bottom };
    });
    assert.ok(menuBounds.right <= await page.evaluate(() => window.innerWidth), 'the context menu stays inside the right viewport edge');
    assert.ok(menuBounds.bottom <= await page.evaluate(() => window.innerHeight), 'the context menu stays inside the bottom viewport edge');
    await page.keyboard.press('Escape');
    await contextMenu.waitFor({ state: 'hidden' });
    console.log('PASS VS Code-style context menu: symbol help, definition navigation, F12, viewport clamping, and escape dismissal');
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
    if (previousProjectRoot === undefined) delete process.env.NOVEL_PROJECT_ROOT;
    else process.env.NOVEL_PROJECT_ROOT = previousProjectRoot;
    const tempRoot = await fs.realpath(os.tmpdir());
    const createdRoot = await fs.realpath(projectRoot);
    if (path.dirname(createdRoot) !== tempRoot || !path.basename(createdRoot).startsWith('novel-symbol-help-')) throw Error(`refusing to remove unexpected test directory: ${createdRoot}`);
    await fs.rm(createdRoot, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
