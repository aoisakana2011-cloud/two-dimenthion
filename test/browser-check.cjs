// Run after npm run build and installing playwright in build/audit-tools.
const { chromium } = require('../build/audit-tools/node_modules/playwright');
const { handleApi, serveStatic } = require('../Edit/server');
const fs = require('node:fs/promises'), http = require('node:http'), path = require('node:path');
const assert = require('node:assert/strict');
(async () => {
  const root = path.resolve(__dirname, '../Title/asset');
  const dir = await fs.mkdtemp(path.join(root, '__audit_'));
  const relative = path.basename(dir) + '/pixel.png';
   await fs.copyFile(path.resolve(__dirname, '../native/engine_data/ui/dialogue_box.png'), path.join(dir, 'pixel.png'));
   const audioRelative = path.basename(dir) + '/tone.ogg';
   await fs.copyFile(path.resolve(__dirname, '../build/audit-smoke/assets/tone.ogg'), path.join(dir, 'tone.ogg'));
  const server = http.createServer(async (req, res) => {
    try { const url = new URL(req.url, 'http://127.0.0.1'); if (url.pathname.startsWith('/api/')) await handleApi(req, res, url); else await serveStatic(res, url.pathname); }
    catch (error) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: error.message })); }
  });
  let browser;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
    const page = await browser.newPage(); page.setDefaultTimeout(10_000); const errors = []; page.on('pageerror', e => errors.push(e.message));
    let compiledSceneName = '';
    page.on('request', async request => {
      if (new URL(request.url()).pathname === '/api/compile') compiledSceneName = request.postDataJSON()?.name || '';
    });
    let source = `asset image first = "asset/${relative}"
 asset image second = "asset/${relative}"
 asset voice greeting = "asset/${audioRelative}"
character hero {
  name = "Hero"
  pose normal = "asset/${relative}"
}
character friend {
  name = "Friend"
  pose normal = "asset/${relative}"
}
str result = str(9007199254740992 + 1)
fn answer() -> int { int n = 7
return n }
show image first left
 show image second right
 play voice greeting blocking
show hero.normal left fade 10
show friend.normal right x-12 y+34
clear image first
hide hero
choice "choose" {
"continue" { say hero result + ":" + str(answer()) }
}`;
    await page.route('**/api/scene?*', route => route.fulfill({ json: { name: '__audit.tds', source } }));
    await page.goto(base + '/player.html?source=__audit.tds&debug=offset-smoke');
    await page.locator('.choice').waitFor().catch(async (error) => {
      throw new Error(`choice was not shown: ${await page.locator('#speaker').textContent()} / ${await page.locator('#text').textContent()} (${errors.join('; ') || error.message})`);
    });
    assert.equal(compiledSceneName, '__audit.tds');
    assert.equal(await page.locator('#image-first').count(), 0);
    assert.equal(await page.locator('#image-second').count(), 1);
    assert.equal(await page.locator('#char-hero').count(), 0);
    assert.equal(await page.locator('#char-friend').count(), 1);
    assert.equal(await page.locator('#char-friend').evaluate(element => element.style.transform), 'translateX(calc(-50% - 12px))');
    assert.equal(await page.locator('#char-friend').evaluate(element => element.style.bottom), '-34px');
    await page.locator('.choice').click();
    await page.waitForFunction(() => document.querySelector('#text').textContent === '9007199254740993:7');
    assert.equal(await page.locator('#speaker').textContent(), 'Hero');
    await page.screenshot({ path: path.resolve(__dirname, '../build/browser-regression.png') });
    const auditCases = require('./fixtures/audit-cases.json');
    for (const [id, expression, expected] of [
      ['loop', 'str(hits)', '1'],
      ['condition_effect', 'str(result)', '1'],
      ['argument_effect', 'str(result)', '1'],
      ['dictionary_alias', 'str(result)', '1'],
      ['dictionary_side_effect', 'str(d["y"])', '9'],
      ['const_shadow', 'str(result)', '2'],
    ]) {
      source = auditCases[id].source + '\nsay narrator ' + expression;
      await page.reload();
      await page.waitForFunction(value => document.querySelector('#text').textContent === value, expected);
      // Narrator lines intentionally suppress the speaker nameplate text.
      assert.equal(await page.locator('#speaker').textContent(), '', id);
    }
    source = auditCases.interpolation_side_effect.source + '\nsay narrator str(state)';
    await page.reload();
    await page.locator('.choice').click();
    await page.waitForFunction(() => document.querySelector('#text').textContent === '1');
    const invalidConst = await page.request.post(base + '/api/validate', { data: { name: '__audit.tds', source: 'const dict[int] d = {"x":1}\nunset d["x"]' } });
    const constReport = await invalidConst.json();
    assert.equal(constReport.ok, false);
    assert.ok(constReport.diagnostics.some(item => item.severity === 'error' && /const/.test(item.message)));
    const reservedName = await page.request.post(base + '/api/validate', { data: { name: '__audit.tds', source: 'int const = 1' } });
    const reservedReport = await reservedName.json();
    assert.equal(reservedReport.ok, false);
    assert.ok(reservedReport.diagnostics.some(item => item.severity === 'error' && /予約語/.test(item.message)));
    const slotSource = `character hero {
  name = "Hero"
  pose normal = "asset/char/aokami.png"
}
show hero.normal far_left`;
    const slotValidation = await page.request.post(base + '/api/validate', { data: { name: '__audit.tds', source: slotSource } });
    const slotReport = await slotValidation.json();
    assert.equal(slotReport.ok, true, slotReport.error);
    const slotCompile = await page.request.post(base + '/api/compile', { data: { name: '__audit.tds', source: slotSource } });
    const slotCompiled = await slotCompile.json();
    assert.equal(slotCompiled.ok, true, slotCompiled.error);
    assert.deepEqual(slotCompiled.program.globals.at(-1).args.slice(0, 2).map(argument => argument.value), ['hero.normal', 'far_left']);
    source = 'choice { "bad" { int x = 1 / 0 } }';
    await page.reload(); await page.locator('.choice').click();
    await page.waitForFunction(() => document.querySelector('#speaker').textContent === 'PLAYER ERROR');
    assert.match(await page.locator('#text').textContent(), /除算/);
    assert.deepEqual(errors, []);
    console.log('PASS browser: API BigInt round trip, character pixel offsets, image clear, fade, choice click, function call, error propagation, audit runtime cases and const diagnostics');
  } finally {
    await browser?.close(); await new Promise(resolve => server.close(resolve));
    // dir was created with mkdtemp directly below the resolved assets root.
    if (path.dirname(dir) === root) await fs.rm(dir, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
