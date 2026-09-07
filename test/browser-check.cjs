// Run after npm run build and installing playwright in build/audit-tools.
const { chromium } = require('../build/audit-tools/node_modules/playwright');
const { handleApi, serveStatic } = require('../Edit/server');
const fs = require('node:fs/promises'), http = require('node:http'), path = require('node:path');
const assert = require('node:assert/strict');
(async () => {
  const root = path.resolve(__dirname, '../Edit/assets');
  const dir = await fs.mkdtemp(path.join(root, '__audit_'));
  const relative = path.basename(dir) + '/pixel.png';
  await fs.copyFile(path.resolve(__dirname, '../native/engine_data/ui/dialogue_box.png'), path.join(dir, 'pixel.png'));
  const server = http.createServer(async (req, res) => {
    try { const url = new URL(req.url, 'http://127.0.0.1'); if (url.pathname.startsWith('/api/')) await handleApi(req, res, url); else await serveStatic(res, url.pathname); }
    catch (error) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: error.message })); }
  });
  let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
    const page = await browser.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
    let compiledSceneName = '';
    page.on('request', async request => {
      if (new URL(request.url()).pathname === '/api/compile') compiledSceneName = request.postDataJSON()?.name || '';
    });
    let source = `asset image first = "${relative}"
asset image second = "${relative}"
character hero { normal = "${relative}" }
character friend { normal = "${relative}" }
str result = str(9007199254740992 + 1)
fn answer() -> int { int n = 7
return n }
show image first left
show image second right
show char hero left normal fade 10
show char friend right normal
clear image first
clear char hero
choice "choose" {
"continue" { say none result + ":" + str(answer()) }
}`;
    await page.route('**/api/scene?*', route => route.fulfill({ json: { name: '__audit.tds', source } }));
    await page.goto(base + '/player.html?source=__audit.tds');
    await page.locator('.choice').waitFor();
    assert.equal(compiledSceneName, '__audit.tds');
    assert.equal(await page.locator('#image-first').count(), 0);
    assert.equal(await page.locator('#image-second').count(), 1);
    assert.equal(await page.locator('#char-hero').count(), 0);
    assert.equal(await page.locator('#char-friend').count(), 1);
    await page.locator('.choice').click();
    await page.waitForFunction(() => document.querySelector('#text').textContent === '9007199254740993:7');
    assert.equal(await page.locator('#speaker').textContent(), '');
    await page.screenshot({ path: path.resolve(__dirname, '../build/browser-regression.png') });
    source = 'choice { "bad" { int x = 1 / 0 } }';
    await page.reload(); await page.locator('.choice').click();
    await page.waitForFunction(() => document.querySelector('#speaker').textContent === 'PLAYER ERROR');
    assert.match(await page.locator('#text').textContent(), /除算/);
    assert.deepEqual(errors, []);
    console.log('PASS browser: API BigInt round trip, image/character clear, fade, choice click, function call, error propagation');
  } finally {
    await browser?.close(); await new Promise(resolve => server.close(resolve));
    // dir was created with mkdtemp directly below the resolved assets root.
    if (path.dirname(dir) === root) await fs.rm(dir, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
