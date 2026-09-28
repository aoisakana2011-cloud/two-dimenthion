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
  await fs.writeFile(path.join(auditLayout.scenesRoot, 'analysis-side.tds'), 'scene analysis_side { choice { "continue" { goto analysis_side_target } "open chapter" { goto "analysis-target.tds" } } }\nscene analysis_side_target { wait 1 }\n');
  await fs.writeFile(path.join(auditLayout.scenesRoot, 'analysis-target.tds'), 'scene analysis_target { wait 1 }\n');
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
    page.on('pageerror', (error) => pageErrors.push(error.message));
    const saveAllFromMenu = async () => {
      await page.locator('[data-menu="file"]').click();
      await page.locator('[data-menu-action="save"]').click();
    };
    const rightClickToken = (line, name) => editor.evaluate((element, target) => {
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
    await page.goto(`${base}/index.html`);
    const editor = page.locator('#editor');
    await editor.waitFor();
    const initialSceneGraph = await page.evaluate(async () => (await (await fetch('/api/scene-graph')).json()));
    assert.deepEqual(initialSceneGraph.nodes.find((node) => node.id === 'analysis-side.tds')?.localGotos?.map((item) => item.scene), ['analysis_side_target']);
    const apiExternalGoto = initialSceneGraph.edges.find((edge) => edge.from === 'analysis-side.tds' && edge.to === 'analysis-target.tds');
    assert.ok(apiExternalGoto, 'file-target goto is represented as a Scene Flow connection');
    assert.equal(apiExternalGoto.transitions[0].fromScene, 'analysis_side');
    assert.equal(apiExternalGoto.transitions[0].toScene, 'analysis_target');
    assert.equal(apiExternalGoto.transitions[0].choice, 'open chapter');
    assert.ok(apiExternalGoto.transitions[0].line > 0);
    const originalEditorSource = await editor.inputValue();
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
    await page.waitForFunction(() => [...document.querySelectorAll('#suggestions .suggestion')].some((item) => item.textContent.includes('std/math.tds')));
    await editor.fill('include "std/math.tds" as math\nfloat sample = math.si');
    await page.waitForFunction(() => [...document.querySelectorAll('#suggestions .suggestion')].some((item) => item.textContent.includes('sin')));
    await editor.fill(originalEditorSource);
    await page.locator('[data-activity="presentation"]').click();
    const presentationCardStyle = await page.locator('.presentation-card').first().evaluate((element) => ({
      background: getComputedStyle(element).backgroundColor,
      borderLeft: getComputedStyle(element).borderLeftWidth,
    }));
    assert.deepEqual(presentationCardStyle, { background: 'rgba(0, 0, 0, 0)', borderLeft: '0px' }, 'presentation guidance uses flat workbench sections rather than cards');
    await page.locator('[data-presentation-action="player-ui"]').click();
    const settingsGroupStyle = await page.locator('.player-ui-settings-group').first().evaluate((element) => ({
      background: getComputedStyle(element).backgroundColor,
      borderLeft: getComputedStyle(element).borderLeftWidth,
    }));
    assert.deepEqual(settingsGroupStyle, { background: 'rgba(0, 0, 0, 0)', borderLeft: '0px' }, 'player settings groups are separated by rules instead of boxed cards');
    await page.locator('[data-presentation-action="game-screens"]').click();
    const gameScreenDialogStyle = await page.locator('.game-screen-settings').evaluate((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const close = element.querySelector('.project-settings-close').getBoundingClientRect();
      return { background: style.backgroundColor, border: style.borderColor, radius: style.borderRadius, width: Math.round(rect.width), closeWidth: Math.round(close.width), closeHeight: Math.round(close.height) };
    });
    assert.deepEqual(gameScreenDialogStyle, { background: 'rgb(37, 37, 38)', border: 'rgb(60, 60, 60)', radius: '3px', width: 1000, closeWidth: 26, closeHeight: 26 }, 'game-screen editor dialog uses a compact neutral workbench surface and compact close control');
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
    await page.locator('.project-settings-close').click();
    await page.locator('[data-activity="explorer"]').click();
    await page.locator('[data-menu="help"]').click();
    await page.locator('[data-menu-action="syntax"]').click();
    assert.equal(await page.locator('.language-guide strong').textContent(), '.tds 構文ヘルプ');
    assert.ok(await page.locator('.language-guide .guide-section').count() >= 8);
    assert.equal(await page.locator('.language-guide .guide-section').first().getAttribute('open'), '');
    const dialogueHelp = page.locator('.language-guide .guide-section').filter({ hasText: '台詞と変数' });
    assert.match(await dialogueHelp.textContent(), /文字列リテラルから始まる式/);
    assert.match(await dialogueHelp.locator('pre').textContent(), /say "点数: " \+ str\(score\)/);
    const dslHelpExamples = await page.locator('.language-guide .guide-section pre').evaluateAll((nodes) => nodes.slice(0, 6).map((node) => node.textContent));
    for (const example of dslHelpExamples) assert.doesNotThrow(() => parse(example), `IDE help example is invalid TDS:\n${example}`);
    assert.equal((await page.request.get(`${base}/docs/tds-language-and-editor-guide.md`)).ok(), true);
    await page.locator('.language-guide .guide-close').click();
    const validFunctionTooltipExample = 'fn greet() -> none {\n}';
    assert.doesNotThrow(() => parse(validFunctionTooltipExample));
    await editor.fill(validFunctionTooltipExample);
    await rightClickToken(1, 'fn');
    await page.locator('.syntax-tooltip-signature').waitFor();
    assert.match(await page.locator('.syntax-tooltip-signature').textContent(), /-> <戻り値>/);
    assert.match(await page.locator('.syntax-tooltip-description').textContent(), /戻り値の型を -> で必ず指定/);
    const declarationHelpSource = 'struct Vec2 {\n  x: float\n  y: float\n}\nfn scale(point: Vec2, factor: float) -> float {\n  return factor\n}\nscene main {\n  wait 1\n}\n';
    await editor.fill(declarationHelpSource);
    await rightClickToken(5, 'scale');
    await page.locator('.variable-tooltip').waitFor({ state: 'visible' });
    assert.match(await page.locator('.variable-tooltip').textContent(), /scale\(point: Vec2, factor: float\) -> float/);
    assert.match(await page.locator('.variable-tooltip').textContent(), /戻り値: float/);
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
    assert.match(await variableTooltip.textContent(), /スコープ: function \(render_route\)/);
    assert.match(await variableTooltip.textContent(), /定義 \(1\)/);
    assert.match(await variableTooltip.textContent(), /参照・埋め込み \(1\)/);
    assert.doesNotMatch(await variableTooltip.textContent(), /許容値:/, 'same-name local parameter must not inherit a global threshold');
    await variableTooltip.locator('.variable-tooltip-location').first().click();
    assert.equal(await editor.evaluate((element) => element.value.slice(element.selectionStart, element.selectionEnd)), 'route', 'definition navigation selects the exact symbol');
    await editor.fill(wrappedReferenceSource);
    await page.waitForTimeout(1100);
    await rightClickToken(2, 'route');
    await variableTooltip.waitFor({ state: 'visible' });
    await variableTooltip.locator('.variable-tooltip-location').nth(1).click();
    assert.equal(await editor.evaluate((element) => element.selectionStart), wrappedReferenceSource.indexOf('{route}') + 1, 'reference navigation selects the variable even on a wrapped Japanese line');
    await editor.fill(referenceSource);
    await page.waitForTimeout(1100);
    await rightClickToken(5, 'route');
    await variableTooltip.waitFor({ state: 'visible' });
    assert.match(await variableTooltip.textContent(), /スコープ: global/);
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
    await page.route('**/api/scene-graph', async (route) => {
      if (!injectExplorerGraph) return route.continue();
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
    await page.waitForFunction(() => document.querySelector('#file-info .file-info-stat-local')?.textContent === '遷移先 4').catch(async (error) => {
      const rendered = await fileInfo.textContent();
      throw Error(`explorer metadata did not render; injected=${injectExplorerGraph}; scene=${await page.locator('#scene-name').inputValue()}; info=${rendered}; ${error.message}`);
    });
    assert.equal(await fileInfo.locator('.file-info-stat-local').textContent(), '遷移先 4');
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
    assert.match(await fileInfo.locator('[data-kind="variables"]').textContent(), /このファイルの定義 1 · 参照 690/);
    assert.equal(await fileInfo.locator('[data-kind="variables"] .file-info-variable-jump').count(), 3);
    assert.equal(await fileInfo.locator('.file-info-stat-warning').count(), 1, 'unreachable files show a warning badge in the summary');
    injectExplorerGraph = 'empty';
    await currentFile.click({ button: 'right' });
    await page.locator('.file-context-menu [role="menuitem"]').nth(2).click();
    await page.waitForFunction(() => document.querySelector('#file-info .file-info-stat-local')?.textContent === '遷移先 0');
    assert.equal(await fileInfo.locator('[data-kind="local-targets"]').count(), 0);
    assert.equal(await fileInfo.locator('[data-kind="targets"]').count(), 0, 'an empty transition section is omitted instead of showing a dead disclosure bar');
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
    await page.route('**/api/project-build', async (route) => {
      projectBuildRequest = route.request().postDataJSON();
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, build: true, fileCount: 2, diagnostics: [], name: 'test.nsp.json', path: 'build/native-packages/test.nsp.json', instructions: 4 }) });
    });
    await page.locator('[data-menu="run"]').click();
    assert.deepEqual(await page.locator('[data-menu-popup="run"] [role="menuitem"]').allTextContents(), ['ビルド Ctrl+Enter', '再生']);
    await page.locator('[data-menu-action="build"]').click();
    await page.waitForFunction(() => document.querySelector('#status')?.textContent.includes('ファイル精査完了'));
    assert.equal(projectBuildRequest.name, await page.locator('#scene-name').inputValue());
    assert.match(await page.locator('#result').textContent(), /コンパイル完了: 全 2 ファイル/);
    let playRequest = false;
    await page.route('**/api/project-build-status', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ built: false, changedFiles: ['main.tds'], reason: 'scenario-changed' }) }));
    await page.route('**/api/native-play', async (route) => { playRequest = true; return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) }); });
    await page.locator('[data-menu="run"]').click();
    await page.locator('[data-menu-action="play"]').click();
    await page.locator('.editor-dialog button').first().click();
    await page.waitForFunction(() => document.querySelector('#status')?.textContent.includes('起動しました'));
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
    await editor.fill(`str editor_title = "文字列"
scene analysis {
  if 1 == 2 {
    say narrator "到達しない"
  }
  say narrator editor_title
}`);
    await page.waitForFunction(() => document.querySelector('#result')?.textContent.includes('constant-condition'), null, { timeout: 10000 });
    const resultText = await page.locator('#result').textContent();
    if (!resultText.includes('constant-condition')) throw new Error(`Live diagnostics were not rendered: ${resultText}`);
    assert.match(await page.locator('#result').textContent(), /警告 [1-9]/);
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
    assert.doesNotMatch(await page.locator('#result').textContent(), /unreachable-code\s+line 3:/);
    await editor.fill('scene start {\n  goto live\n  wait 1\n\n  say narrator "never"\n}\nscene live { wait 1 }\nscene dead {\n  wait 2\n\n  say narrator "still never"\n}');
    await page.waitForFunction(() => document.querySelector('#result')?.textContent.includes('3-5 line') && document.querySelector('#result')?.textContent.includes('8-12 line'));
    const collapsedDiagnostics = await page.locator('#result').textContent();
    assert.match(collapsedDiagnostics, /unreachable-code\s+3-5 line/);
    assert.match(collapsedDiagnostics, /unreachable-scene\s+8-12 line/);
    assert.doesNotMatch(collapsedDiagnostics, /unreachable-code\s+9(?:-|\s)line/);
    await editor.fill('scene start {\n  bg missing_one\n  wait "bad"\n  say missing_two "hello"\n}');
    await page.waitForFunction(() => document.querySelectorAll('#result .diagnostic-error').length >= 3);
    const continuedTypeDiagnostics = await page.locator('#result').textContent();
    for (const line of [2, 3, 4]) assert.match(continuedTypeDiagnostics, new RegExp(`line ${line}:`));
    const unicodeTypeError = 'str result = "😀" + missing';
    const expectedColumn = unicodeTypeError.indexOf('missing') + 1;
    await editor.fill(unicodeTypeError);
    await page.waitForFunction((column) => document.querySelector('#result')?.textContent.includes(`line 1:${column}`), expectedColumn);
    const unicodeTypeDiagnostic = page.locator('#result .diagnostic-link').filter({ hasText: 'type-error' }).first();
    await unicodeTypeDiagnostic.click();
    assert.equal(await editor.evaluate((element) => element.selectionStart), expectedColumn - 1);
    await editor.fill('say narrator "unterminated\nwait (\nsay narrator "valid"');
    await page.waitForFunction(() => document.querySelector('#result')?.textContent.includes('syntax-error') && document.querySelectorAll('#result .diagnostic-error').length >= 2);
    const continuedSyntaxDiagnostics = await page.locator('#result').textContent();
    assert.match(continuedSyntaxDiagnostics, /line 1:/);
    assert.match(continuedSyntaxDiagnostics, /line 2:/);
    await editor.fill('asset bg missing = "asset/__missing_diagnostic_jump__.png"\nscene start { bg missing }');
    await page.waitForFunction(() => document.querySelector('#result')?.textContent.includes('project-error'));
    const projectErrorLink = page.locator('#result .diagnostic-link').filter({ hasText: 'project-error' }).first();
    assert.equal(await projectErrorLink.getAttribute('title'), 'クリックして該当行へ移動');
    await projectErrorLink.click();
    assert.equal(await editor.evaluate((element) => document.activeElement === element), true);
    const missingAssetSource = 'asset bg missing = "asset/__missing_diagnostic_jump__.png"\nscene start { bg missing }';
    assert.equal(await editor.evaluate((element) => element.selectionStart), missingAssetSource.indexOf('asset/__missing_diagnostic_jump__.png'));
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
    await editor.fill(`asset bg school = "asset/bg/school.jpg"
fn greet(name: str) -> none {
  # greeting
  say narrator "Hello {name}"
}
scene start { greet("range") }`);
    await page.waitForTimeout(100);
    for (const selector of ['.hl-keyword', '.hl-type', '.hl-function', '.hl-declaration', '.hl-scene', '.hl-asset', '.hl-string', '.hl-interpolation', '.hl-comment', '.hl-punctuation']) {
      assert.ok(await page.locator(`#highlight ${selector}`).count() >= 1, `Missing syntax scope ${selector}`);
    }
    await editor.fill(`asset bg school = "asset/bg/school.jpg"
fn greet(name: str) -> none {
  # greeting
  say narrator "Hello {name}"
}
scene start {
  greet("range")
  show hero.normal far_left
}`);
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
