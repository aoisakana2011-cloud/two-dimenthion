const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require('../build/audit-tools/node_modules/playwright');

const root = path.resolve(__dirname, '..');
const serverScript = path.join(root, 'Edit', 'server.js');

async function startServer(projectRoot, env) {
  const child = spawn(process.execPath, [serverScript, '--project', projectRoot], {
    cwd: root,
    env: { ...env, PORT: '0' },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += String(chunk); });
  child.stderr.on('data', (chunk) => { output += String(chunk); });
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error(`server startup timeout: ${output}`)), 15_000);
    const inspect = () => {
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    };
    child.stdout.on('data', inspect);
    child.stderr.on('data', inspect);
    child.once('exit', (code) => { clearTimeout(timer); reject(Error(`server exited ${code}: ${output}`)); });
  });
  return { child, base };
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  await new Promise((resolve) => { child.once('exit', resolve); child.kill(); });
}

(async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-full-workflow-'));
  const home = path.join(tempRoot, 'isolated-home');
  const bootstrap = path.join(tempRoot, 'bootstrap');
  const projectName = 'E2E title';
  const projectRoot = path.join(tempRoot, projectName);
  await Promise.all([fs.mkdir(home), fs.mkdir(bootstrap)]);
  const env = { ...process.env, USERPROFILE: home, HOME: home };
  let server;
  let browser;
  try {
    server = await startServer(bootstrap, env);
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const context = await browser.newContext();
    const editorPage = await context.newPage();
    editorPage.setDefaultTimeout(12_000);
    const pageErrors = [];
    editorPage.on('pageerror', (error) => pageErrors.push(error.message));
    await editorPage.goto(`${server.base}/index.html`);
    await editorPage.locator('#editor').waitFor();

    // Create a project from the actual project picker, with its recent-project
    // state isolated under the temporary home directory.
    await editorPage.locator('[data-menu="file"]').click();
    await editorPage.locator('[data-menu-action="new-project"]').click();
    await editorPage.waitForFunction((expected) => document.querySelector('#project-picker-path')?.value === expected, bootstrap);
    await editorPage.locator('#project-picker-path').fill(tempRoot);
    await editorPage.locator('#project-picker-go').click();
    await editorPage.waitForFunction((expected) => document.querySelector('#project-picker-path')?.value === expected, tempRoot);
    await editorPage.locator('#project-picker-create').click();
    const projectNameDialog = editorPage.locator('.editor-dialog').filter({ has: editorPage.locator('input') });
    await projectNameDialog.locator('input').fill(projectName);
    await projectNameDialog.getByRole('button', { name: '決定' }).click();
    await editorPage.waitForFunction((name) => document.querySelector('#scene-name')?.value === name, 'main.tds');
    const project = await editorPage.evaluate(async () => (await (await fetch('/api/project')).json()).projectRoot);
    assert.equal(path.resolve(project), path.resolve(projectRoot));
    const initialTheme = await editorPage.evaluate(async () => {
      const response = await fetch('/api/player-ui');
      return { status: response.status, payload: await response.json() };
    });
    assert.equal(initialTheme.status, 200, 'new projects must have a usable browser-player theme');
    assert.equal(initialTheme.payload.path, '');
    assert.equal(initialTheme.payload.theme.version, 1);

    await editorPage.locator('[data-menu="file"]').click();
    await editorPage.locator('[data-menu-action="project-settings"]').click();
    await editorPage.locator('.project-settings').waitFor();
    await editorPage.locator('.project-settings footer .project-settings-save').click();
    await editorPage.waitForFunction(() => document.querySelector('#status')?.textContent.includes('作品設定を保存しました'));
    const savedTheme = await editorPage.evaluate(async () => (await (await fetch('/api/project')).json()).settings.native_ui_theme);
    assert.equal(savedTheme, 'ui/player-ui.json');
    assert.equal(JSON.parse(await fs.readFile(path.join(projectRoot, 'asset', 'ui', 'player-ui.json'), 'utf8')).version, 1);

    await editorPage.locator('.scene-folder[data-path="senario"] .tree-action').click();
    const newSceneDialog = editorPage.locator('.editor-dialog').filter({ has: editorPage.locator('input') });
    await newSceneDialog.locator('input').fill('chapter.tds');
    await newSceneDialog.getByRole('button', { name: '決定' }).click();
    const chapterFile = editorPage.locator('.scene-file[data-path="senario/chapter.tds"]');
    await chapterFile.waitFor({ state: 'attached' });
    await editorPage.locator('.scene-folder[data-path="senario"]').click();
    await chapterFile.waitFor();

    const projectAssets = path.join(projectRoot, 'asset');
    await fs.copyFile(path.join(root, 'native', 'engine_data', 'ui', 'dialogue_box.png'), path.join(projectAssets, 'pixel.png'));
    await fs.writeFile(path.join(projectRoot, 'senario', 'common.tds'), 'fn shared_helper() -> none { wait 1 }\n', 'utf8');
    const source = [
      'include "common.tds"',
      'asset image portrait = "asset/pixel.png"',
      'global int score = 0',
      'scene main {',
      '  show image portrait center',
      '  choice "Continue?" {',
      '    "Add one" {',
      '      set score = score + 1',
      '      say narrator "Score {score}"',
      '    }',
      '  }',
      '  goto "chapter.tds"',
      '}',
      '',
    ].join('\n');
    const unformattedSource = [
      'include "common.tds"',
      'asset image portrait="asset/pixel.png"',
      'global int score=0',
      'scene main{',
      'show image portrait center',
      'choice "Continue?"{',
      '"Add one"{',
      'set score=score+1',
      'say narrator "Score {score}"',
      '}',
      '}',
      'goto "chapter.tds"',
      '}',
      '',
    ].join('\n');
    const chapterSource = 'scene chapter {\n  say narrator "Chapter reached"\n}\n';
    const editor = editorPage.locator('#editor');
    await editor.fill(unformattedSource);
    await editorPage.waitForFunction(() => document.querySelector('#status')?.textContent.includes('検証に成功しました'));
    assert.equal(await editor.inputValue(), unformattedSource, 'startup restore must not replace edits after a project switch');
    await editorPage.locator('[data-menu="file"]').click();
    await editorPage.locator('[data-menu-action="save"]').click();
    await editorPage.waitForFunction(() => document.querySelector('#status')?.textContent.includes('保存しました'));
    const savedBeforeBuild = await editorPage.evaluate(async () => (await (await fetch('/api/scene?name=main.tds')).json()).source);
    assert.equal(savedBeforeBuild, source);
    assert.equal(await editor.inputValue(), source, 'saving must canonicalize the editor source');
    const flowData = await editorPage.evaluate(async () => (await (await fetch('/api/scene-graph', { cache: 'no-store' })).json()));
    assert.equal(flowData.version, 2);
    assert.equal(flowData.edges.some((edge) => edge.from === 'main.tds' && edge.to === 'common.tds' && edge.kind === 'include'), true);
    assert.equal(flowData.edges.some((edge) => edge.from === 'main.tds' && edge.to === 'chapter.tds' && edge.kind === 'goto'), true);
    assert.equal(flowData.nodes.find((node) => node.id === 'common.tds')?.reachable, true);
    const flowPage = await context.newPage();
    flowPage.setDefaultTimeout(12_000);
    await flowPage.goto(`${server.base}/flow.html`);
    await flowPage.locator('#flow-search').waitFor();
    await flowPage.locator('.flow-node').first().waitFor();
    assert.ok(await flowPage.locator('.include-edge').count() >= 1);
    await flowPage.locator('#show-includes').uncheck();
    assert.equal(await flowPage.locator('.include-edge').count(), 0);
    await flowPage.locator('#show-includes').check();
    await flowPage.locator('#flow-search').fill('common.tds');
    assert.equal(await flowPage.locator('.flow-node').count(), 1);
    await flowPage.locator('#flow-search').fill('');
    await flowPage.close();

    await editorPage.locator('.scene-file[data-path="senario/chapter.tds"] .scene-file-open').click();
    await editorPage.waitForFunction(() => document.querySelector('#scene-name')?.value === 'chapter.tds');
    await editor.fill(chapterSource);
    await editorPage.waitForFunction(() => document.querySelector('#result')?.textContent.includes('問題ありません'));
    await editorPage.locator('[data-menu="file"]').click();
    await editorPage.locator('[data-menu-action="save"]').click();
    await editorPage.waitForFunction(() => document.querySelector('#status')?.textContent.includes('保存しました'));
    const savedChapter = await editorPage.evaluate(async () => (await (await fetch('/api/scene?name=chapter.tds')).json()).source);
    assert.equal(savedChapter, chapterSource);
    await editorPage.locator('.scene-file[data-path="senario/main.tds"] .scene-file-open').click();
    await editorPage.waitForFunction(() => document.querySelector('#scene-name')?.value === 'main.tds');
    await fs.writeFile(path.join(projectRoot, 'senario', 'chapter.tds'), 'scene chapter{say narrator "Chapter reached"}\n', 'utf8');
    const directFormattedChapter = await editorPage.evaluate(() => window.novelEditorApi.format('scene chapter{say narrator "Chapter reached"}\n'));
    assert.equal(directFormattedChapter, chapterSource, 'formatter API must canonicalize an unformatted closed scene');
    await editorPage.locator('[data-menu="edit"]').click();
    await editorPage.locator('[data-menu-action="format-project"]').click();
    await editorPage.evaluate(async () => window.novelEditorApi.lastFormatProject());
    await editorPage.waitForFunction(async (expected) => {
      const response = await fetch('/api/scene?name=chapter.tds', { cache: 'no-store' });
      return response.ok && (await response.json()).source === expected;
    }, chapterSource);
    const formattedClosedChapter = await editorPage.evaluate(async () => (await (await fetch('/api/scene?name=chapter.tds', { cache: 'no-store' })).json()).source);
    assert.equal(formattedClosedChapter, chapterSource);

    const rollbackA = 'scene rollback_a{say narrator "Rollback A"}\n';
    const rollbackB = 'scene rollback_b{say narrator "Rollback B"}\n';
    await fs.writeFile(path.join(projectRoot, 'senario', 'rollback_a.tds'), rollbackA, 'utf8');
    await fs.writeFile(path.join(projectRoot, 'senario', 'rollback_b.tds'), rollbackB, 'utf8');
    let rollbackPutCount = 0;
    await editorPage.route('**/api/scene', async (route) => {
      if (route.request().method() !== 'PUT') return route.continue();
      rollbackPutCount += 1;
      if (rollbackPutCount === 2) return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'injected format failure' }) });
      return route.continue();
    });
    const rollbackResult = await editorPage.evaluate(async () => {
      try {
        await window.novelEditorApi.formatProject();
        return null;
      } catch (error) {
        return String(error?.message || error);
      }
    });
    assert.match(rollbackResult, /injected format failure/);
    assert.equal(await fs.readFile(path.join(projectRoot, 'senario', 'rollback_a.tds'), 'utf8'), rollbackA);
    assert.equal(await fs.readFile(path.join(projectRoot, 'senario', 'rollback_b.tds'), 'utf8'), rollbackB);
    await editorPage.unroute('**/api/scene');

    await fs.writeFile(path.join(projectRoot, 'senario', 'chapter.tds'), 'scene chapter{say narrator "Compile boundary"}\n', 'utf8');
    await editorPage.locator('[data-menu="run"]').click();
    await editorPage.locator('[data-menu-action="compile"]').click();
    await editorPage.waitForFunction(() => document.querySelector('#status')?.textContent.includes('ファイル精査完了')).catch(async (error) => {
      const state = await editorPage.evaluate(() => ({ status: document.querySelector('#status')?.textContent, result: document.querySelector('#result')?.textContent }));
      throw Error(`project compile did not complete: ${JSON.stringify(state)} (${error.message})`);
    });
    const compileFormattedChapter = await editorPage.evaluate(async () => (await (await fetch('/api/scene?name=chapter.tds', { cache: 'no-store' })).json()).source);
    assert.equal(compileFormattedChapter, 'scene chapter {\n  say narrator "Compile boundary"\n}\n', 'compile must persist project-wide formatting');
    const packageFile = path.join(projectRoot, '.novel', 'build', 'main.nsp.json');
    const packageData = JSON.parse(await fs.readFile(packageFile, 'utf8'));
    assert.equal(packageData.program.scenes[0].name, 'main');

    const playerPage = await context.newPage();
    playerPage.setDefaultTimeout(12_000);
    playerPage.on('pageerror', (error) => pageErrors.push(error.message));
    await playerPage.goto(`${server.base}/player.html`);
    await playerPage.locator('.choice').waitFor().catch(async (error) => {
      throw Error(`player did not show a choice: ${await playerPage.locator('#speaker-text').textContent()} / ${await playerPage.locator('#text').textContent()} (${pageErrors.join('; ') || error.message})`);
    });
    assert.equal(await playerPage.locator('#image-portrait').evaluate((image) => image.naturalWidth > 0), true);
    await playerPage.locator('.choice').click();
    await playerPage.waitForFunction(() => document.querySelector('#text')?.textContent === 'Score 1');
    await playerPage.locator('#next').click();
    await playerPage.waitForFunction(() => document.querySelector('#text')?.textContent === 'Compile boundary');
    assert.deepEqual(pageErrors, []);

    // A syntax error must reach the editor, then a corrected save must survive
    // both a page reload and a fresh server process.
    await editor.fill('scene main {\n  wait (\n}\n');
    await editorPage.waitForFunction(() => document.querySelector('#result')?.textContent.includes('syntax-error'));
    await editor.fill(source);
    await editorPage.waitForFunction(() => document.querySelector('#result')?.textContent.includes('問題ありません'));
    await editorPage.locator('[data-menu="file"]').click();
    await editorPage.locator('[data-menu-action="save"]').click();
    await editorPage.waitForFunction(() => document.querySelector('#status')?.textContent.includes('保存しました'));
    await editorPage.reload();
    await editorPage.waitForFunction((expected) => document.querySelector('#editor')?.value === expected, source).catch(async (error) => {
      const state = await editorPage.evaluate(() => ({ scene: document.querySelector('#scene-name')?.value, source: document.querySelector('#editor')?.value, status: document.querySelector('#status')?.textContent }));
      throw Error(`editor reload did not restore the saved source: ${JSON.stringify(state)} (${error.message})`);
    });
    await stopServer(server.child);
    server = await startServer(projectRoot, env);
    await editorPage.goto(`${server.base}/index.html?scene=main.tds`);
    await editorPage.waitForFunction((expected) => document.querySelector('#editor')?.value === expected, source);
    assert.equal(await editorPage.evaluate(async () => (await (await fetch('/api/scene?name=main.tds')).json()).source), source);

    const reloadedPlayer = await context.newPage();
    reloadedPlayer.setDefaultTimeout(12_000);
    reloadedPlayer.on('pageerror', (error) => pageErrors.push(error.message));
    await reloadedPlayer.goto(`${server.base}/player.html`);
    await reloadedPlayer.locator('.choice').waitFor();
    await reloadedPlayer.locator('.choice').click();
    await reloadedPlayer.waitForFunction(() => document.querySelector('#text')?.textContent === 'Score 1');
    assert.deepEqual(pageErrors, []);
    console.log('PASS full workflow: create project, edit, save, compile, image/dialogue/choice/state, diagnostics/fix, reload and restart');
  } finally {
    await browser?.close();
    await stopServer(server?.child);
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
