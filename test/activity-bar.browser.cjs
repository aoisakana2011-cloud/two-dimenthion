'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('../build/audit-tools/node_modules/playwright');
const { seedEmptyProject } = require('../tools/project-layout');

async function main() {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-activity-bar-'));
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
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 800, height: 250 } });
    await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
    await page.locator('#editor').waitFor();

    const geometry = await page.evaluate(() => {
      const bar = document.querySelector('.activity-bar');
      const buttons = [...bar.querySelectorAll('.activity-button')];
      const screen = bar.querySelector('[data-activity="presentation"]');
      const flow = bar.querySelector('[data-activity="flow"]');
      const spacer = bar.querySelector('.activity-spacer');
      return {
        buttonHeights: buttons.map(button => button.getBoundingClientRect().height),
        separateThemeIcon: Boolean(bar.querySelector('[data-activity="ui-settings"]')),
        screenBeforeSpacer: Boolean(screen.compareDocumentPosition(spacer) & Node.DOCUMENT_POSITION_FOLLOWING),
        screenAfterFlow: Boolean(flow.compareDocumentPosition(screen) & Node.DOCUMENT_POSITION_FOLLOWING),
        screenVisible: screen.getBoundingClientRect().height > 0 && getComputedStyle(screen).display !== 'none',
      };
    });
    assert.deepEqual(geometry.buttonHeights, [48, 48, 48, 48], 'activity icons keep the same fixed size in a short window');
    assert.equal(geometry.separateThemeIcon, false, 'Player UI Theme has no separate activity icon');
    assert.equal(geometry.screenBeforeSpacer, true, 'screen settings stay in the upper pinned activity group');
    assert.equal(geometry.screenAfterFlow, true, 'screen settings follow the main navigation icons');
    assert.equal(geometry.screenVisible, true);

    await page.goto(`http://127.0.0.1:${server.address().port}/flow.html`);
    const flowPresentation = page.locator('[data-flow-view="presentation"]');
    assert.equal(await flowPresentation.isVisible(), true, 'Scene Flow has a visible Display / Presentation Settings icon');
    assert.equal(await flowPresentation.getAttribute('title'), '表示・演出設定');
    await flowPresentation.click();
    await page.waitForFunction(() => document.querySelector('[data-activity="presentation"]')?.classList.contains('active') && document.querySelector('.sidebar')?.classList.contains('presentation-mode'));
    await page.locator('[data-activity="flow"]').click();
    const embeddedFlowPresentation = page.frameLocator('#scene-flow-frame').locator('[data-flow-view="presentation"]');
    await embeddedFlowPresentation.click();
    await page.waitForFunction(() => document.querySelector('[data-activity="presentation"]')?.classList.contains('active') && document.querySelector('.sidebar')?.classList.contains('presentation-mode') && document.querySelector('#scene-flow-host')?.hidden);

    const screenButton = page.locator('[data-activity="presentation"]');
    await screenButton.click();
    await page.waitForFunction(() => document.querySelector('[data-activity="presentation"]')?.classList.contains('active') && document.querySelector('.sidebar')?.classList.contains('presentation-mode'));
    await page.locator('[data-presentation-action="player-ui"]').click();
    await page.locator('#ui-settings-page').waitFor({ state: 'visible' });
    assert.equal(await screenButton.getAttribute('class').then(value => value.includes('active')), true, 'the combined screen settings icon remains active while Player UI Theme is open');
    await page.locator('[data-activity="explorer"]').click();
    assert.equal(await screenButton.isVisible(), true, 'screen settings icon remains available after changing activities');
    console.log('PASS activity bar: screen settings stay pinned, match icon sizing and remain available after view changes');
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
    if (previousProjectRoot === undefined) delete process.env.NOVEL_PROJECT_ROOT;
    else process.env.NOVEL_PROJECT_ROOT = previousProjectRoot;
    await fs.rm(projectRoot, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });

