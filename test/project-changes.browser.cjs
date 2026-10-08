'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { chromium } = require('../build/audit-tools/node_modules/playwright');
const { seedEmptyProject } = require('../tools/project-layout');

async function main() {
  const root = path.resolve(__dirname, '..');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-project-changes-'));
  const layout = seedEmptyProject(path.join(temp, 'project'));
  const mainFile = path.join(layout.scenesRoot, 'main.tds');
  const settingConflictFile = path.join(layout.settingsRoot, 'conflict.txt');
  await fs.writeFile(settingConflictFile, 'scene settings baseline\n');
  let child, browser;
  try {
    child = spawn(process.execPath, [path.join(root, 'Edit', 'server.js'), '--project', layout.projectRoot], {
      cwd: root, env: { ...process.env, PORT: '0', NOVEL_TEMP_STARTUP_WORKSPACE: '1', NOVEL_EDITOR_RECENT_FILE: path.join(temp, 'recent.json') },
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const base = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error(`Server start timeout: ${output}`)), 30000);
      const check = () => {
        const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
        if (match) { clearTimeout(timer); resolve(match[0]); }
      };
      child.stdout.on('data', check);
      child.stderr.on('data', check);
      child.once('exit', (code) => { clearTimeout(timer); reject(Error(`Server exited ${code}: ${output}`)); });
    });
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage();
    const sceneReads = [];
    const clickScene = async (name) => {
      const item = page.locator('#file-tree .scene-file').filter({ hasText: name });
      await item.evaluate((element) => {
        let parent = element.parentElement;
        while (parent) {
          if (parent.classList.contains('scene-folder-contents') && parent.hidden) parent.previousElementSibling?.querySelector('.scene-folder-toggle')?.click();
          parent = parent.parentElement;
        }
      });
      await item.click();
    };
    page.on('request', (request) => {
      if (request.url().includes('/api/scene?')) sceneReads.push(new URL(request.url()).searchParams.get('name'));
    });
    await page.goto(`${base}/index.html`);
    await page.waitForFunction(() => document.querySelector('#scene-name')?.value === 'main.tds' && Boolean(projectChangesToken));
    // A clean external edit is picked up by the periodic timer without a page reload.
    await fs.writeFile(mainFile, 'scene main {\n  say narrator "external update"\n}\n');
    await page.waitForFunction(() => document.querySelector('#editor')?.value.includes('external update'), null, { timeout: 12000 });
    assert.deepEqual([...new Set(sceneReads)], ['main.tds'], 'unchanged scene bodies are not fetched');

    let resolveSaveResponse;
    let notifySaveResponseHeld;
    const saveResponseHeld = new Promise((resolve) => { notifySaveResponseHeld = resolve; });
    await page.route((url) => url.pathname === '/api/scene' && url.search === '', async (route) => {
      if (route.request().method() !== 'PUT') return route.continue();
      const response = await route.fetch();
      notifySaveResponseHeld();
      await new Promise((resolve) => { resolveSaveResponse = resolve; });
      return route.fulfill({ response });
    });
    const submittedSource = 'scene main {\n  say narrator "saved snapshot"\n}\n';
    const newerSource = 'scene main {\n  say narrator "typed during save"\n}\n';
    await page.locator('#editor').fill(submittedSource);
    await page.evaluate(() => { window.pendingSceneSave = window.novelEditorApi.save(); });
    await saveResponseHeld;
    assert.match(await fs.readFile(mainFile, 'utf8'), /saved snapshot/, 'the server has committed the submitted snapshot before its response is released');
    await page.locator('#editor').fill(newerSource);
    resolveSaveResponse();
    await page.evaluate(() => window.pendingSceneSave);
    assert.match(await page.locator('#editor').inputValue(), /typed during save/);
    assert.equal(await page.locator('.dirty-mark').evaluate((element) => element.classList.contains('visible')), true,
      'edits made after the submitted save snapshot must remain dirty when its response arrives');
    assert.match(await fs.readFile(mainFile, 'utf8'), /saved snapshot/);
    await page.unrouteAll({ behavior: 'wait' });
    await page.evaluate(() => window.novelEditorApi.save());
    await page.waitForFunction(() => !document.querySelector('.dirty-mark')?.classList.contains('visible'));

    const added = path.join(layout.scenesRoot, 'later.tds');
    await fs.writeFile(added, 'scene later {\n  say narrator "later"\n}\n');
    await page.evaluate(() => pollProjectChanges());
    await page.waitForFunction(() => [...document.querySelectorAll('#file-tree .scene-file')].some((item) => item.dataset.path.endsWith('/later.tds')));
    assert.deepEqual([...new Set(sceneReads)], ['main.tds'], 'adding a file updates the tree without loading its body');

    let releaseSwitchedSave;
    let notifySwitchedSaveHeld;
    const switchedSaveHeld = new Promise((resolve) => { notifySwitchedSaveHeld = resolve; });
    await page.route((url) => url.pathname === '/api/scene' && url.search === '', async (route) => {
      if (route.request().method() !== 'PUT') return route.continue();
      const response = await route.fetch();
      notifySwitchedSaveHeld();
      await new Promise((resolve) => { releaseSwitchedSave = resolve; });
      return route.fulfill({ response });
    });
    await page.evaluate(() => { window.pendingSceneSave = window.novelEditorApi.save(); });
    await switchedSaveHeld;
    await clickScene('later.tds');
    await page.waitForFunction(() => document.querySelector('#scene-name')?.value === 'later.tds');
    releaseSwitchedSave();
    await page.evaluate(() => window.pendingSceneSave);
    assert.equal(await page.locator('#scene-name').inputValue(), 'later.tds', 'a delayed save response must not switch the active tab back to its saved file');
    await page.unrouteAll({ behavior: 'wait' });
    await clickScene('main.tds');
    await page.waitForFunction(() => document.querySelector('#scene-name')?.value === 'main.tds');

    await fs.unlink(added);
    await page.evaluate(() => pollProjectChanges());
    await page.waitForFunction(() => ![...document.querySelectorAll('#file-tree .scene-file')].some((item) => item.dataset.path.endsWith('/later.tds')));
    await page.waitForFunction(() => ![...document.querySelectorAll('#editor-tabs .editor-tab .editor-tab-name')].some((button) => button.title === 'later.tds'));

    await page.locator('#editor').fill('scene main {\n  say narrator "unsaved local"\n}\n');
    await fs.writeFile(mainFile, 'scene main {\n  say narrator "external conflict"\n}\n');
    await page.evaluate(() => pollProjectChanges());
    assert.match(await page.locator('#editor').inputValue(), /unsaved local/, 'unsaved edits are never overwritten');
    assert.match(await page.locator('#status').textContent(), /外部で変更/, 'an external conflict is visible');
    assert.deepEqual([...new Set(sceneReads)], ['main.tds', 'later.tds'], 'dirty files are not loaded again after an explicit open');
    await page.keyboard.press('Control+s');
    await page.waitForFunction(() => Boolean(document.querySelector('#runtime-error')?.textContent));
    assert.match(await page.locator('#runtime-error').textContent(), /シナリオファイルが外部で変更されました。再読み込みしてから保存してください。/,
      'the scene conflict explains how to recover');
    assert.match(await page.locator('#editor').inputValue(), /unsaved local/, 'a stale scene save keeps the local buffer');
    assert.equal(await page.locator('.dirty-mark').evaluate((element) => element.classList.contains('visible')), true,
      'a stale scene save leaves the local document dirty');
    assert.match(await fs.readFile(mainFile, 'utf8'), /external conflict/, 'a stale scene save does not replace the external file');
    await page.evaluate(() => openScene('main.tds'));
    await page.waitForFunction(() => document.querySelector('#editor')?.value.includes('external conflict'));
    assert.equal(await page.locator('.dirty-mark').evaluate((element) => element.classList.contains('visible')), false,
      'reopening the conflicted scene reloads the current disk version and clears dirty state');

    await page.evaluate(() => openSettingFile('setting/conflict.txt'));
    await page.waitForFunction(() => document.querySelector('#scene-name')?.value === 'setting/conflict.txt');
    const settingTab = page.locator('#editor-tabs .editor-tab').filter({ hasText: 'conflict.txt' });
    assert.equal(await settingTab.count(), 1, 'opening a setting document creates its own tab');
    assert.equal(await settingTab.locator('.editor-tab-name').getAttribute('aria-pressed'), 'true', 'the active setting document button is selected');
    await page.locator('#editor-tabs .editor-tab-name').filter({ hasText: 'main.tds' }).click();
    await page.waitForFunction(() => document.querySelector('#scene-name')?.value === 'main.tds');
    await settingTab.locator('.editor-tab-name').click();
    await page.waitForFunction(() => document.querySelector('#scene-name')?.value === 'setting/conflict.txt');
    const fallbackTab = await settingTab.evaluate((tab) => {
      const tabs = [...tab.parentElement.querySelectorAll('.editor-tab')];
      const index = tabs.indexOf(tab);
      const target = tabs[index + 1] || tabs[index - 1];
      return target?.querySelector('.editor-tab-name')?.title || '';
    });
    const closeState = await page.evaluate(() => {
      window.__closeConfirmCalls = [];
      window.__closeClicks = [];
      document.querySelector('#editor-tabs').addEventListener('click', (event) => window.__closeClicks.push({ target: event.target?.className, tag: event.target?.tagName }), true);
      window.confirm = (message) => { window.__closeConfirmCalls.push(message); return true; };
      return { isDirty, activeSettingDocument, sceneName: sceneName.value, editorValue: editor.value, openTabs: [...openTabs] };
    });
    assert.equal(closeState.isDirty, false, 'loading and selecting a clean setting document leaves it clean');
    await settingTab.locator('.editor-tab-close').click();
    await page.waitForTimeout(300);
    const closeOutcome = await page.evaluate(() => ({ confirms: window.__closeConfirmCalls, clicks: window.__closeClicks, openTabs: [...openTabs] }));
    assert.deepEqual(closeOutcome.confirms, [], 'closing a clean setting document does not ask for confirmation');
    assert.ok(closeOutcome.clicks.some((event) => event.target === 'editor-tab-close'), 'the real close button receives the click');
    assert.ok(!closeOutcome.openTabs.includes('setting/conflict.txt'), 'closing removes the setting document from open tabs');
    await page.waitForFunction((name) => [...document.querySelectorAll('#editor-tabs .editor-tab.active .editor-tab-name[aria-pressed="true"]')]
      .some((button) => button.title === name), fallbackTab);
    assert.equal(await page.locator('#editor-tabs .editor-tab').filter({ hasText: 'conflict.txt' }).count(), 0, 'closing the setting tab removes it and activates the remaining document');
    await page.evaluate(() => openSettingFile('setting/conflict.txt'));
    await page.waitForFunction(() => document.querySelector('#scene-name')?.value === 'setting/conflict.txt');
    const localSetting = 'local settings edit\n';
    const externalSetting = 'external settings update\n';
    await page.locator('#editor').fill(localSetting);
    await fs.writeFile(settingConflictFile, externalSetting);
    await page.keyboard.press('Control+s');
    await page.waitForFunction(() => Boolean(document.querySelector('#runtime-error')?.textContent));
    assert.match(await page.locator('#runtime-error').textContent(), /設定ファイルが外部で変更されました。再読み込みしてから保存してください。/,
      'the setting conflict explains how to recover');
    assert.equal(await page.locator('#editor').inputValue(), localSetting, 'a stale setting save keeps the local buffer');
    assert.equal(await page.locator('.dirty-mark').evaluate((element) => element.classList.contains('visible')), true,
      'a stale setting save leaves the local document dirty');
    assert.equal(await fs.readFile(settingConflictFile, 'utf8'), externalSetting, 'a stale setting save does not replace the external file');
    await page.evaluate(() => openSettingFile('setting/conflict.txt'));
    assert.equal(await page.locator('#editor').inputValue(), externalSetting, 'reopening the conflicted setting reloads the current disk version');
    assert.equal(await page.locator('.dirty-mark').evaluate((element) => element.classList.contains('visible')), false,
      'reopening the conflicted setting clears dirty state');
    console.log('PASS project changes browser: periodic delta reload, add/remove, and dirty-edit protection');
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (child && child.exitCode === null) {
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      else child.kill('SIGTERM');
    }
    await fs.rm(temp, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
