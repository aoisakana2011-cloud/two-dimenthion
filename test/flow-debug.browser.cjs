'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require('../build/audit-tools/node_modules/playwright');
const { seedEmptyProject } = require('../tools/project-layout');

async function main() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-flow-debug-'));
  const project = seedEmptyProject(path.join(temp, 'project'));
  await fs.mkdir(path.join(project.assetsRoot, 'char'), { recursive: true });
  await fs.writeFile(path.join(project.assetsRoot, 'char', 'sample.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6a8AAAAASUVORK5CYII=', 'base64'));
  await fs.writeFile(path.join(project.dataRoot, 'variables.json'), JSON.stringify({
    staticVariables: [
      { name: 'level', type: 'int', value: 0, min: 0, max: 4 },
      { name: 'risky', type: 'int', value: 0, min: 0, max: 4 },
    ],
  }));
  await fs.writeFile(path.join(project.scenesRoot, 'main.tds'), 'global int score = 0\nscene main {\n  say narrator "before"\n  say narrator "Score {score}"\n  goto "chapter.tds"\n}\n');
  await fs.writeFile(path.join(project.scenesRoot, 'chapter.tds'), 'scene chapter {\n  say narrator "Chapter {score}"\n}\n');
  await fs.writeFile(path.join(project.scenesRoot, 'branch.tds'), 'scene branch {\n  if score > 0 {\n    say narrator "positive"\n  } else {\n    say narrator "zero"\n  }\n}\n');
  await fs.writeFile(path.join(project.scenesRoot, 'domains.tds'), 'global int domainScore = 0\nscene domains {\n  choice "choose" {\n    "a" { set domainScore = 2 }\n    "b" { set domainScore = 5 }\n  }\n  say narrator "Domain {domainScore}"\n}\n');
  await fs.writeFile(path.join(project.scenesRoot, 'seed.tds'), 'global int seedScore = 0\nscene seed {\n  set seedScore = 7\n  say narrator "Seed {seedScore}"\n}\n');
  await fs.writeFile(path.join(project.scenesRoot, 'multi.tds'), 'scene first {\n  say narrator "First scene"\n}\nscene second {\n  say narrator "Second scene"\n}\n');
  await fs.writeFile(path.join(project.scenesRoot, 'characters.tds'), 'character hero {\n  name = "Hero Display"\n}\ncharacter goi {\n  name = "五位"\n}\ncharacter toshihito {\n  name = "利仁"\n}\ncharacter sample {\n  name = "Sample"\n  pose normal = "asset/char/sample.png"\n}\n');
  await fs.writeFile(path.join(project.scenesRoot, 'speaker.tds'), 'global int directValue = 8\nscene speaker {\n  say narrator str(directValue)\n  say hero "External speaker"\n  say goi "Go-i"\n  say toshihito "Toshihito"\n}\n');
  await fs.writeFile(path.join(project.scenesRoot, 'sprite.tds'), 'scene sprite {\n  show sample.normal left\n  say narrator "Native-size sprite"\n}\n');
  await fs.writeFile(path.join(project.scenesRoot, 'analyzed.tds'), 'global int computed = 0\nfn prepare() -> none {\n  if 1 < 2 {\n    set computed = 1\n  } else {\n    set computed = 99\n  }\n  for i from 1 to 3 {\n    set computed = computed + i\n  }\n}\nscene analyzed {\n  prepare()\n  while computed < 8 {\n    set computed = computed + 1\n  }\n  say narrator "Analyzed {computed}"\n}\n');
  await fs.writeFile(path.join(project.scenesRoot, 'dict.tds'), 'global dict[int] points = {"x": 0}\nscene dict_test {\n  choice "choose" {\n    "one" { set points["x"] = 1 }\n    "two" { set points["x"] = 2 }\n  }\n  say narrator str(points["x"])\n}\n');
  await fs.writeFile(path.join(project.scenesRoot, 'struct.tds'), 'struct Mood {\n  label: str\n  count: int\n}\nglobal Mood mood = { "label": "none", "count": 0 }\nscene struct_test {\n  say narrator "{mood.label}"\n}\n');
  const boundedSource = `fn stabilize() -> none {
  for i from 1 to 300 {
    set level = level
    set risky = risky + 1
  }
}
stabilize()
global int outcome = 0
scene bounded {
  if level > 4 {
    set outcome = 1
  } else {
    set outcome = 2
  }
  say narrator "Bounded {outcome}"
  say narrator "Risky {risky}"
}
`;
  await fs.writeFile(path.join(project.scenesRoot, 'bounded.tds'), boundedSource);
  const child = spawn(process.execPath, [path.resolve(__dirname, '..', 'Edit', 'server.js'), '--project', project.projectRoot], {
    cwd: path.resolve(__dirname, '..'), env: { ...process.env, PORT: '0', NOVEL_TEMP_STARTUP_WORKSPACE: '1', NOVEL_EDITOR_RECENT_FILE: path.join(temp, 'recent.json') },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let browser;
  try {
    let output = '';
    const base = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error(`server timeout: ${output}`)), 30000);
      const check = () => { const match = output.match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timer); resolve(match[0]); } };
      child.stdout.on('data', (value) => { output += String(value); check(); });
      child.stderr.on('data', (value) => { output += String(value); check(); });
      child.once('exit', (code) => reject(Error(`server exited ${code}: ${output}`)));
    });
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${base}/index.html`);
    await page.waitForFunction(() => Boolean(document.querySelector('#scene-name')?.value));
    await page.evaluate(() => openScene('main.tds'));
    await page.locator('[data-activity="flow"]').click();
    const flow = page.frameLocator('#scene-flow-frame');
    const waitForFlowDomains = async (...names) => {
      try {
        await page.waitForFunction((expected) => {
          const frame = document.querySelector('#scene-flow-frame')?.contentDocument;
          const run = frame?.querySelector('#flow-test-run');
          return Boolean(run && !run.disabled && expected.every((name) => {
            const variable = frame.querySelector(`#flow-test-vars [data-name="${CSS.escape(name)}"]`);
          return variable && ['exact', 'finite', 'unknown'].includes(variable.dataset.domainKind)
            && (variable.dataset.domainKind === 'exact' || Array.isArray(JSON.parse(variable.dataset.domainValues || 'null')))
            && (variable.dataset.domainKind !== 'exact' || !frame.querySelector(`#flow-test-vars input[data-name="${CSS.escape(name)}"]`));
          }));
        }, names);
      } catch (error) {
        const state = await page.evaluate(async (expected) => {
          const frame = document.querySelector('#scene-flow-frame')?.contentDocument;
          const file = frame?.querySelector('#flow-test-file')?.textContent;
          const graph = await (await fetch('/api/scene-graph')).json();
          const node = graph.nodes?.find((item) => item.id === file);
          return { scene: frame?.querySelector('#flow-test-scene')?.value, line: frame?.querySelector('#flow-test-line')?.value, nodeError: node?.error, nodeDiagnostics: node?.diagnostics, nodeVariables: node?.variables?.map((item) => ({ name: item.name, type: item.type, mutable: item.mutable, scope: item.scope, references: item.references })), runDisabled: frame?.querySelector('#flow-test-run')?.disabled, variables: expected.map((name) => ({ name, element: frame?.querySelector(`#flow-test-vars [data-name="${CSS.escape(name)}"]`)?.outerHTML })), content: frame?.querySelector('#flow-test-vars')?.innerHTML };
        }, names);
        throw Error(`${error.message}; Scene Flow variable state: ${JSON.stringify(state)}`);
      }
    };
    await flow.locator('.flow-node[data-file="main.tds"]').click();
    const sidebarLayout = await flow.locator('.controls').evaluate((side) => {
      const panel = side.querySelector('.flow-test-panel').getBoundingClientRect();
      const legend = side.querySelector('.legend').getBoundingClientRect();
      return { panelBottom: panel.bottom, legendTop: legend.top, panelTop: panel.top, filterBottom: side.querySelector('.flow-filters').getBoundingClientRect().bottom };
    });
    assert.ok(sidebarLayout.panelTop >= sidebarLayout.filterBottom - 1 && sidebarLayout.panelBottom <= sidebarLayout.legendTop + 1, `test controls and legend must not overlap: ${JSON.stringify(sidebarLayout)}`);
    await page.setViewportSize({ width: 900, height: 640 });
    const compactLayout = await flow.locator('.controls').evaluate((side) => ({
      panel: side.querySelector('.flow-test-panel').getBoundingClientRect().toJSON(),
      legend: side.querySelector('.legend').getBoundingClientRect().toJSON(),
      filter: side.querySelector('.flow-filters').getBoundingClientRect().toJSON(),
    }));
    assert.ok(compactLayout.panel.top >= compactLayout.filter.bottom - 1 && compactLayout.panel.bottom <= compactLayout.legend.top + 1 && compactLayout.panel.height > 100, `compact test panel overlaps: ${JSON.stringify(compactLayout)}`);
    await page.setViewportSize({ width: 1440, height: 900 });
    const mainSceneOption = flow.locator('#flow-test-scene option').first();
    assert.equal(await mainSceneOption.textContent(), 'main', 'scene selector shows only the scene name');
    assert.equal(await flow.locator('#flow-test-line').inputValue(), '2', 'scene starts at its scene declaration line by default');
    await page.waitForFunction(() => document.querySelector('#highlight .hl-start')?.textContent.includes('scene main'));
    await flow.locator('#flow-test-line').fill('4');
    await waitForFlowDomains('score');
    const mainScore = flow.locator('#flow-test-vars .flow-test-confirmed[data-name="score"]');
    await mainScore.waitFor();
    assert.match(await mainScore.textContent(), /score = 0/);
    assert.equal(await flow.locator('#flow-test-vars input[data-name="score"]').count(), 0, 'a confirmed variable has no editable field');
    await flow.locator('#flow-test-run').click();
    const player = page.frameLocator('.debug-player-panel iframe');
    await player.locator('#text').getByText('Score 0').waitFor().catch(async (error) => {
      throw Error(`${error.message}; player=${await player.locator('#text').textContent().catch(() => '<none>')}; runMessage=${await flow.locator('#flow-test-message').textContent()}; status=${await page.locator('#status').textContent().catch(() => '<none>')}; runtimeError=${await page.locator('#runtime-error').textContent().catch(() => '<none>')}; panelCount=${await page.locator('.debug-player-panel').count()}; location=${await page.locator('[data-debug-location]').textContent().catch(() => '<none>')}; errors=${errors.join(' | ')}`);
    });
    await page.waitForFunction(() => {
      const frame = document.querySelector('.debug-player-panel iframe');
      const stage = frame?.contentDocument?.querySelector('#stage');
      if (!frame || !stage) return false;
      const width = Number.parseFloat(stage.style.width), height = Number.parseFloat(stage.style.height);
      const rendered = frame.getBoundingClientRect(), viewport = frame.parentElement.getBoundingClientRect();
      return frame.contentWindow.innerWidth === width && frame.contentWindow.innerHeight === height
        && Math.abs(rendered.width / viewport.width - 1) < 0.02;
    }, null, { timeout: 5000 });
    const playerAspect = await page.locator('.debug-player-panel iframe').evaluate((frame) => {
      const stage = frame.contentDocument.querySelector('#stage');
      const stageRect = stage.getBoundingClientRect();
      const renderedFrame = frame.getBoundingClientRect();
      const viewport = frame.parentElement.getBoundingClientRect();
      return {
        playerViewport: `${frame.contentWindow.innerWidth}x${frame.contentWindow.innerHeight}`,
        logicalWidth: Number.parseFloat(stage.style.width),
        logicalHeight: Number.parseFloat(stage.style.height),
        rendered: stageRect.width / stageRect.height,
        miniatureScale: renderedFrame.width / viewport.width,
      };
    });
    assert.equal(playerAspect.playerViewport, `${playerAspect.logicalWidth}x${playerAspect.logicalHeight}`, `the player must render at its full configured resolution before scaling down: ${JSON.stringify(playerAspect)}`);
    assert.ok(Math.abs(playerAspect.rendered - playerAspect.logicalWidth / playerAspect.logicalHeight) < 0.02, `the stage keeps its real-play layout: ${JSON.stringify(playerAspect)}`);
    assert.ok(playerAspect.miniatureScale > 0 && playerAspect.miniatureScale < 1, `the complete rendered player should be uniformly reduced into the test window: ${JSON.stringify(playerAspect)}`);
    await page.locator('[data-debug-location]').waitFor();
    assert.match(await page.locator('[data-debug-location]').textContent(), /main\.tds:4/);
    assert.equal(await page.locator('#scene-name').inputValue(), 'main.tds');
    await page.waitForFunction(() => document.querySelector('#highlight .hl-running')?.textContent.includes('Score'));
    assert.equal(await page.locator('#highlight .hl-running').count(), 1);
    const runningRow = await page.locator('#highlight .hl-running').evaluate((row) => {
      const rect = row.getBoundingClientRect();
      const editor = document.querySelector('#editor').getBoundingClientRect();
      return { background: getComputedStyle(row).backgroundColor, visible: rect.bottom > editor.top && rect.top < editor.bottom };
    });
    assert.notEqual(runningRow.background, 'rgba(0, 0, 0, 0)', 'the executing line has a visible background');
    assert.equal(runningRow.visible, true, 'the executing line is scrolled into the editor viewport');
    assert.equal(await page.locator('#editor').evaluate((element) => element.value.slice(element.selectionStart, element.selectionEnd).trim()), 'say narrator "Score {score}"');
    await player.locator('#dialogue').evaluate((element) => element.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await player.locator('#text').getByText('Chapter 0').waitFor();
    await page.waitForFunction(() => document.querySelector('#scene-name')?.value === 'chapter.tds' && document.querySelector('#highlight .hl-running')?.textContent.includes('Chapter'));
    await page.getByRole('button', { name: 'Scene Flow' }).click();
    await flow.locator('.flow-node[data-file="sprite.tds"]').click();
    await flow.locator('#flow-test-run').click();
    const spritePlayer = page.frameLocator('.debug-player-panel iframe');
    await spritePlayer.locator('#text').getByText('Native-size sprite').waitFor();
    const spriteGeometry = await page.locator('.debug-player-panel iframe').evaluate((frame) => {
      const stage = frame.contentDocument.querySelector('#stage');
      const actor = frame.contentDocument.querySelector('#characters .actor');
      const stageRect = stage.getBoundingClientRect(), actorRect = actor.getBoundingClientRect();
      return {
        stage: { width: stageRect.width, height: stageRect.height },
        sprite: { width: actorRect.width, height: actorRect.height, centerX: actorRect.left + actorRect.width / 2, bottom: actorRect.bottom },
      };
    });
    assert.deepEqual(spriteGeometry.stage, { width: 1280, height: 720 }, 'the mini-player renders the configured logical canvas');
    assert.deepEqual(spriteGeometry.sprite, { width: 720, height: 720, centerX: 332.796875, bottom: 720 }, `a sprite uses the native fit-to-canvas size and 26% left slot: ${JSON.stringify(spriteGeometry)}`);
    await page.getByRole('button', { name: 'Scene Flow' }).click();
    await flow.locator('.flow-node[data-file="branch.tds"]').click();
    await waitForFlowDomains('score');
    const uncertainScore = flow.locator('#flow-test-vars input[data-name="score"]');
    await uncertainScore.waitFor();
    assert.equal(await flow.locator('#flow-test-vars .flow-test-confirmed[data-name="score"]').count(), 0, 'an uncertain variable appears only in the editable group');
    await uncertainScore.fill('invalid');
    assert.equal(await uncertainScore.inputValue(), 'invalid', 'the invalid override is present before validation');
    await flow.locator('#flow-test-run').click();
    await page.waitForFunction(() => Boolean(document.querySelector('#scene-flow-frame')?.contentDocument?.querySelector('#flow-test-message')?.textContent));
    assert.match(await flow.locator('#flow-test-message').textContent(), /整数/);
    assert.equal(await page.locator('.debug-player-panel').count(), 0, 'invalid overrides never start playback');
    await uncertainScore.fill('9');
    assert.equal(await flow.locator('#flow-test-line').inputValue(), '1', 'editing a variable must not change the selected start line');
    await flow.locator('#flow-test-run').click();
    await player.locator('#text').getByText('positive').waitFor();
    await page.getByRole('button', { name: 'Scene Flow' }).click();
    await flow.locator('.flow-node[data-file="struct.tds"]').click();
    await waitForFlowDomains('mood');
    const confirmedMood = flow.locator('#flow-test-vars .flow-test-confirmed[data-name="mood"]');
    await confirmedMood.waitFor();
    assert.match(await confirmedMood.textContent(), /mood = \{label: "none", count: 0\}/);
    assert.equal(await flow.locator('#flow-test-vars input[data-name="mood"]').count(), 0, 'confirmed structs are also read-only');
    await flow.locator('#flow-test-run').click();
    await player.locator('#text').getByText('none').waitFor();
    await page.getByRole('button', { name: '停止', exact: true }).click();
    assert.equal(await page.locator('.debug-player-panel').count(), 0, 'stop closes the test player');
    await page.locator('[data-activity="flow"]').click();
    await flow.locator('.flow-node[data-file="dict.tds"]').click();
    await flow.locator('#flow-test-line').fill('7');
    await waitForFlowDomains('points');
    const pointsOverride = flow.locator('#flow-test-vars input[data-name="points"]');
    await pointsOverride.waitFor();
    assert.equal(await pointsOverride.getAttribute('data-domain-kind'), 'finite');
    assert.equal(await flow.locator('#flow-test-vars .flow-test-confirmed[data-name="points"]').count(), 0);
    await pointsOverride.fill('{"x":5}');
    await flow.locator('#flow-test-run').click();
    await player.locator('#text').getByText('5', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Scene Flow' }).click();
    await flow.locator('.flow-node[data-file="branch.tds"]').click();
    await waitForFlowDomains('score');
    await flow.locator('#flow-test-vars input[data-name="score"]').fill('9');
    await flow.locator('#flow-test-run').click();
    await player.locator('#text').getByText('positive').waitFor();
    await page.getByRole('button', { name: 'Scene Flow' }).click();
    await flow.locator('.flow-node[data-file="branch.tds"]').click();
    await flow.locator('#flow-test-line').fill('3');
    await flow.locator('#flow-test-run').click();
    await player.locator('#text').getByText('positive').waitFor();
    await page.waitForFunction(() => document.querySelector('#highlight .hl-running')?.textContent.includes('positive'));
    await page.getByRole('button', { name: 'Scene Flow' }).click();
    assert.equal(await page.locator('#highlight .hl-running').count(), 0);
    await flow.locator('.flow-node[data-file="domains.tds"]').click();
    await flow.locator('#flow-test-line').fill('7');
    await waitForFlowDomains('domainScore');
    await flow.locator('.flow-test-variable:has(input[data-name="domainScore"]) .flow-test-domain').getByText(/候補 2: 2 \/ 5/).waitFor();
    await flow.locator('#flow-test-vars input[data-name="domainScore"]').fill('5');
    await flow.locator('#flow-test-run').click();
    await player.locator('#text').getByText('Domain 5').waitFor();
    await page.getByRole('button', { name: 'Scene Flow' }).click();
    await flow.locator('.flow-node[data-file="seed.tds"]').click();
    await flow.locator('#flow-test-line').fill('4');
    await waitForFlowDomains('seedScore');
    const seedScore = flow.locator('#flow-test-vars .flow-test-confirmed[data-name="seedScore"]');
    await seedScore.waitFor();
    assert.match(await seedScore.textContent(), /seedScore = 7/);
    assert.equal(await flow.locator('#flow-test-vars input[data-name="seedScore"]').count(), 0);
    await flow.locator('#flow-test-run').click();
    await player.locator('#text').getByText('Seed 7').waitFor();
    await page.getByRole('button', { name: 'Scene Flow' }).click();
    await flow.locator('.flow-node[data-file="chapter.tds"]').click();
    await flow.locator('#flow-test-scene').selectOption('chapter');
    const externalScore = flow.locator('#flow-test-vars input[data-name="score"]');
    await externalScore.waitFor();
    await waitForFlowDomains('score');
    await externalScore.fill('9');
    assert.equal(await externalScore.inputValue(), '9');
    await flow.locator('#flow-test-run').click();
    await player.locator('#text').getByText('Chapter 9').waitFor().catch(async (error) => { throw Error(`${error.message}; text=${await player.locator('#text').textContent().catch(() => '<none>')}; input=${await flow.locator('#flow-test-vars input[data-name="score"]').inputValue().catch(() => '<none>')}; message=${await flow.locator('#flow-test-message').textContent()}; errors=${errors.join(' | ')}`); });
    await page.waitForFunction(() => document.querySelector('#scene-name')?.value === 'chapter.tds' && document.querySelector('#highlight .hl-running')?.textContent.includes('Chapter'));
    await page.getByRole('button', { name: 'Scene Flow' }).click();
    await flow.locator('.flow-node[data-file="multi.tds"]').click();
    await flow.locator('#flow-test-scene').selectOption('second');
    assert.equal(await flow.locator('#flow-test-line').inputValue(), '4', 'changing scene defaults to its scene line');
    await flow.locator('#flow-test-line').fill('2');
    assert.equal(await flow.locator('#flow-test-run').isDisabled(), true, 'a line from another scene cannot start playback');
    await flow.locator('#flow-test-line').fill('5');
    await flow.locator('#flow-test-run').click();
    await player.locator('#text').getByText('Second scene').waitFor();
    await page.getByRole('button', { name: 'Scene Flow' }).click();
    await flow.locator('#flow-test-scene').selectOption('first');
    assert.equal(await flow.locator('#flow-test-line').inputValue(), '1', 'switching scenes defaults to the new scene line');
    await flow.locator('#flow-test-run').click();
    await player.locator('#text').getByText('First scene').waitFor();
    await page.getByRole('button', { name: 'Scene Flow' }).click();
    await flow.locator('.flow-node[data-file="speaker.tds"]').click();
    await waitForFlowDomains('hero', 'goi', 'toshihito', 'directValue');
    const speakerNode = await page.evaluate(async () => (await (await fetch('/api/scene-graph')).json()).nodes.find((node) => node.id === 'speaker.tds'));
    assert.ok(speakerNode?.variables?.some((item) => item.name === 'hero'), 'speaker identifiers are indexed as character-variable references');
    const speakerDomains = await page.evaluate(async () => (await (await fetch('/api/flow-domains?file=speaker.tds&scene=speaker&line=2&names=hero,goi,toshihito,directValue')).json()));
    assert.deepEqual(speakerDomains.domains.hero, { kind: 'exact', values: ['{"name":"Hero Display"}'] });
    assert.deepEqual(speakerDomains.domains.goi, { kind: 'exact', values: ['{"name":"五位"}'] });
    assert.deepEqual(speakerDomains.domains.toshihito, { kind: 'exact', values: ['{"name":"利仁"}'] });
    assert.deepEqual(speakerDomains.domains.directValue, { kind: 'exact', values: ['8'] });
    const directValue = flow.locator('#flow-test-vars .flow-test-confirmed[data-name="directValue"]');
    const heroValue = flow.locator('#flow-test-vars .flow-test-confirmed[data-name="hero"]');
    await directValue.waitFor();
    await heroValue.waitFor();
    assert.match(await directValue.textContent(), /directValue = 8/);
    assert.match(await heroValue.textContent(), /hero = \{name: "Hero Display"\}/);
    const confirmedList = flow.locator('#flow-test-vars .flow-test-confirmed-list');
    assert.equal(await confirmedList.locator('.flow-test-confirmed').count(), 4, 'each confirmed global has its own row');
    const confirmedText = await confirmedList.textContent();
    assert.match(confirmedText, /goi = \{name: "五位"\}/);
    assert.match(confirmedText, /toshihito = \{name: "利仁"\}/);
    const listStyle = await confirmedList.locator('.flow-test-confirmed').first().evaluate((element) => ({
      display: getComputedStyle(element).display,
      border: getComputedStyle(element).borderBottomWidth,
    }));
    assert.deepEqual(listStyle, { display: 'block', border: '0px' }, 'each confirmed variable gets a plain line, not a card');
    assert.equal(await flow.locator('#flow-test-vars input[data-name="directValue"], #flow-test-vars input[data-name="hero"], #flow-test-vars input[data-name="goi"], #flow-test-vars input[data-name="toshihito"]').count(), 0, 'confirmed values are read-only');
    if (process.env.NOVEL_FLOW_SCREENSHOT) await page.screenshot({ path: process.env.NOVEL_FLOW_SCREENSHOT });
    await flow.locator('body').evaluate(() => {
      const staleInput = document.createElement('input');
      staleInput.dataset.name = 'directValue';
      staleInput.value = '999';
      document.querySelector('.flow-test-confirmed[data-name="directValue"]').append(staleInput);
    });
    await flow.locator('#flow-test-run').click();
    await player.locator('#text').getByText('8', { exact: true }).waitFor();
    await player.locator('#dialogue').evaluate((element) => element.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await player.locator('#text').getByText('External speaker').waitFor();
    assert.equal(await player.locator('#speaker-text').textContent(), 'Hero Display', 'direct test playback resolves an external character display name');
    await page.getByRole('button', { name: 'Scene Flow' }).click();
    await flow.locator('.flow-node[data-file="analyzed.tds"]').click();
    await flow.locator('#flow-test-line').fill('17');
    const analyzedDomains = await page.evaluate(async () => (await (await fetch('/api/flow-domains?file=analyzed.tds&scene=analyzed&line=17&names=computed')).json()));
    assert.deepEqual(analyzedDomains.domains.computed, { kind: 'exact', values: ['8'] }, 'function branches and finite loops are analyzed through the while-loop to the selected line');
    await waitForFlowDomains('computed');
    const computedValue = flow.locator('#flow-test-vars .flow-test-confirmed[data-name="computed"]');
    await computedValue.waitFor();
    assert.match(await computedValue.textContent(), /computed = 8/);
    assert.equal(await flow.locator('#flow-test-vars input[data-name="computed"]').count(), 0, 'exact values are never rendered as editable inputs');
    await flow.locator('#flow-test-run').click();
    await player.locator('#text').getByText('Analyzed 8').waitFor();
    await page.getByRole('button', { name: 'Scene Flow' }).click();
    await flow.locator('.flow-node[data-file="bounded.tds"]').click();
    await waitForFlowDomains('level', 'outcome', 'risky');
    const boundedLevel = flow.locator('#flow-test-vars input[data-name="level"]');
    await boundedLevel.waitFor();
    assert.equal(await boundedLevel.getAttribute('data-domain-kind'), 'finite', 'narrow configured min/max exposes uncertain candidates as an editable value set');
    await flow.locator('.flow-test-variable:has(input[data-name="level"]) .flow-test-domain').getByText(/候補 5/).waitFor();
    const riskyInput = flow.locator('#flow-test-vars input[data-name="risky"]');
    await riskyInput.waitFor();
    assert.equal(await riskyInput.getAttribute('data-domain-kind'), 'unknown', 'a possibly out-of-range write must not be narrowed by table constraints');
    const beforeBranch = flow.locator('#flow-test-vars .flow-test-confirmed[data-name="outcome"]');
    await beforeBranch.waitFor();
    assert.match(await beforeBranch.textContent(), /outcome = 0/);
    await flow.locator('#flow-test-run').click();
    await player.locator('#text').getByText('Bounded 2').waitFor();
    await player.locator('#dialogue').evaluate((element) => element.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await player.locator('#text').getByText('Risky 300').waitFor();
    await page.getByRole('button', { name: 'Scene Flow' }).click();
    const boundedSayLine = boundedSource.split('\n').findIndex((part) => part.includes('say narrator "Bounded')) + 1;
    await flow.locator('#flow-test-line').fill(String(boundedSayLine));
    await waitForFlowDomains('outcome');
    const afterBranch = flow.locator('#flow-test-vars .flow-test-confirmed[data-name="outcome"]');
    await afterBranch.waitFor();
    assert.match(await afterBranch.textContent(), /outcome = 2/, 'configured range removes the impossible threshold branch before the selected line');
    assert.equal(await flow.locator('#flow-test-vars input[data-name="outcome"]').count(), 0, 'the branch result is exact and read-only');
    await flow.locator('#flow-test-run').click();
    await player.locator('#text').getByText('Bounded 2').waitFor().catch(async (error) => {
      throw Error(`${error.message}; text=${await player.locator('#text').textContent().catch(() => '<none>')}; line=${await flow.locator('#flow-test-line').inputValue()}; message=${await flow.locator('#flow-test-message').textContent()}; location=${await page.locator('[data-debug-location]').textContent().catch(() => '<none>')}; errors=${errors.join(' | ')}`);
    });
    await page.getByRole('button', { name: 'Scene Flow' }).click();
    await flow.locator('.flow-node[data-file="multi.tds"]').click();
    await flow.locator('#flow-test-pick-line').click();
    await page.waitForFunction(() => document.querySelector('#scene-flow-host')?.hidden === true);
    const editorPoint = await page.locator('#editor').evaluate((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return { x: rect.left + 60, y: rect.top + (parseFloat(style.paddingTop) || 0) + 1.5 * parseFloat(style.lineHeight) };
    });
    await page.mouse.move(editorPoint.x, editorPoint.y);
    await page.waitForFunction(() => document.querySelector('#highlight .hl-pick-hover')?.textContent.includes('First scene'));
    await page.mouse.click(editorPoint.x, editorPoint.y);
    await page.waitForFunction(() => document.querySelector('#scene-flow-host')?.hidden === false);
    await page.waitForFunction(() => document.querySelector('#scene-flow-frame')?.contentDocument?.querySelector('#flow-test-line')?.value === '2');
    assert.equal(await flow.locator('#flow-test-line').inputValue(), '2', 'clicked source line returns to Scene Flow');
    assert.match(await fs.readFile(path.join(project.scenesRoot, 'main.tds'), 'utf8'), /global int score = 0/, 'debug overrides never modify the scenario');
    assert.deepEqual(errors, []);
    console.log('PASS Scene Flow debug: line entry, variable domains, player, cross-file live highlight');
  } finally {
    await browser?.close();
    if (child.exitCode === null) child.kill();
    await fs.rm(temp, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
