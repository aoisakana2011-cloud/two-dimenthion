'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('../build/audit-tools/node_modules/playwright');
const { seedEmptyProject } = require('../tools/project-layout');

async function main() {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-editor-typing-'));
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
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/index.html`);
    const editor = page.locator('#editor');
    await editor.waitFor();
    await page.waitForFunction(() => document.querySelector('#scene-name')?.value === 'main.tds' && document.querySelector('#editor')?.value.includes('scene main'));

    async function select(source, start, end = start) {
      await editor.fill(source);
      await editor.evaluate((element, range) => element.setSelectionRange(range.start, range.end), { start, end });
      await editor.press('Escape');
    }
    async function caret() { return editor.evaluate(element => element.selectionStart); }

    const ordinary = 'scene main {\n  say narrator "one"\n  wait 1\n}';
    const ordinaryCaret = ordinary.indexOf('"one"') + '"one"'.length;
    await select(ordinary, ordinaryCaret);
    await editor.press('Enter');
    const indented = 'scene main {\n  say narrator "one"\n  \n  wait 1\n}';
    assert.equal(await editor.inputValue(), indented, 'Enter preserves indentation and untouched lines');
    assert.equal(await caret(), ordinaryCaret + 3, 'caret follows inherited indentation');
    await editor.press('Control+z');
    assert.equal(await editor.inputValue(), ordinary, 'one undo removes the newline');
    await editor.press('Control+Shift+z');
    assert.equal(await editor.inputValue(), indented, 'redo restores the newline');

    await select('  say narrator "hello"', 6);
    await editor.press('Enter');
    assert.equal(await editor.inputValue(), '  say \n  narrator "hello"', 'Enter splits within a line');

    const selectionStart = ordinary.indexOf('narrator');
    await select(ordinary, selectionStart, selectionStart + 'narrator'.length);
    await editor.press('Enter');
    assert.equal(await editor.inputValue(), 'scene main {\n  say \n   "one"\n  wait 1\n}', 'Enter replaces the selection and preserves untouched suffix spacing');

    const paired = 'scene main {\n  if ready {}\n}';
    const pairCaret = paired.indexOf('{}') + 1;
    await select(paired, pairCaret);
    await editor.press('Enter');
    assert.equal(await editor.inputValue(), 'scene main {\n  if ready {\n    \n  }\n}', 'Enter between braces creates an indented body');
    assert.equal(await caret(), pairCaret + 5);

    await select('scene main {\n  \n}', 15);
    await editor.press('Enter');
    assert.equal(await editor.inputValue(), 'scene main {\n\n  \n}', 'Enter on whitespace avoids trailing spaces');

    await select('scene main {\n  wait 1\n}', 0);
    await editor.press('Enter');
    assert.equal(await editor.inputValue(), '\nscene main {\n  wait 1\n}', 'Enter at the first column does not duplicate indentation');

    await select('scene main {', 'scene main {'.length);
    await editor.press('Enter');
    assert.equal(await editor.inputValue(), 'scene main {\n  \n}', 'new block starts with an indented editable body');
    assert.equal(await caret(), 'scene main {\n  '.length, 'caret stays inside the indented body');
    await editor.type('wait 1');
    assert.equal(await editor.inputValue(), 'scene main {\n  wait 1\n}', 'typing after block creation keeps the inherited indentation');

    await select('scene main {\n  say narrator "line"', 'scene main {\n  say narrator "line"'.length);
    await editor.evaluate(element => element.dispatchEvent(new InputEvent('beforeinput', {
      bubbles: true, cancelable: true, inputType: 'insertLineBreak',
    })));
    assert.equal(await editor.inputValue(), 'scene main {\n  say narrator "line"\n  ', 'beforeinput newline uses the same indentation behavior');

    const commentedBlock = 'scene main {\n  if ready { # explanation';
    await select(commentedBlock, commentedBlock.length);
    await editor.press('Enter');
    assert.equal(await editor.inputValue(), `${commentedBlock}\n    `, 'Enter after an opening brace and trailing comment indents the block body');

    const slashCommentBlock = 'scene main {\n  if ready { // explanation';
    await select(slashCommentBlock, slashCommentBlock.length);
    await editor.press('Enter');
    assert.equal(await editor.inputValue(), `${slashCommentBlock}\n    `, 'slash comments after an opening brace keep body indentation');

    const existingClose = 'scene main {\n  if ready {\n  }\n}';
    await select(existingClose, existingClose.indexOf('  if ready {') + '  if ready {'.length);
    await editor.press('Enter');
    assert.equal(await editor.inputValue(), 'scene main {\n  if ready {\n    \n  }\n}', 'Enter before an existing closing brace places the caret in the body');

    const unfinishedIf = 'scene main {\n  if ready\n  wait 1\n}';
    await select(unfinishedIf, unfinishedIf.indexOf('  if ready') + '  if ready'.length);
    await editor.press('Enter');
    assert.equal(await editor.inputValue(), 'scene main {\n  if ready {\n    \n  }\n  wait 1\n}', 'Enter expands an unfinished if without changing the following line');
    assert.equal(await caret(), 'scene main {\n  if ready {\n    '.length);

    const choice = 'scene main {\n  choice "Pick" {';
    await select(choice, choice.length);
    await editor.press('Enter');
    assert.equal(await editor.inputValue(), 'scene main {\n  choice "Pick" {\n    "" {\n    }\n  }', 'choice skeleton indents the option line');

    await select('  wait 1', 4);
    await editor.press('Shift+Tab');
    assert.equal(await editor.inputValue(), 'wait 1', 'Shift+Tab outdents the current line');
    await editor.press('Escape');
    await editor.press('Tab');
    assert.equal(await editor.inputValue(), 'wa  it 1', 'Tab inserts two spaces at the caret');

    await select('scene main {\n    wait 1\n}', 'scene main {\n    wait 1'.length);
    await editor.press('Home');
    assert.equal(await caret(), 'scene main {\n    '.length, 'Home moves to the first non-whitespace character');
    await editor.press('Home');
    assert.equal(await caret(), 'scene main {\n'.length, 'a second Home moves to the absolute line start');

    await select('scene main {\n  wait 1\n}', 'scene main {\n  wait 1'.length);
    await editor.press('Control+BracketRight');
    assert.equal(await editor.inputValue(), 'scene main {\n    wait 1\n}', 'Ctrl+] indents the current line');
    await editor.press('Control+BracketLeft');
    assert.equal(await editor.inputValue(), 'scene main {\n  wait 1\n}', 'Ctrl+[ outdents the current line');

    await editor.fill('scene analysis {\n  if 1 == 2 {\n    wait 1\n  }\n}');
    await page.waitForFunction(() => document.querySelector('#result')?.textContent.includes('constant-condition'), null, { timeout: 5000 });

    console.log('PASS editor typing: Enter, selection, braces, whitespace, undo/redo, beforeinput, Tab, Home, line indent shortcuts');
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
    if (previousProjectRoot === undefined) delete process.env.NOVEL_PROJECT_ROOT;
    else process.env.NOVEL_PROJECT_ROOT = previousProjectRoot;
    const tempRoot = await fs.realpath(os.tmpdir());
    const createdRoot = await fs.realpath(projectRoot);
    if (path.dirname(createdRoot) !== tempRoot || !path.basename(createdRoot).startsWith('novel-editor-typing-')) {
      throw Error(`refusing to remove an unexpected test directory: ${createdRoot}`);
    }
    await fs.rm(createdRoot, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
