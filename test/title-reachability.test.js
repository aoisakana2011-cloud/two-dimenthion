const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { seedEmptyProject } = require('../tools/project-layout');
const { pack } = require('../tools/pack');
const isolatedProject = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-scene-graph-'));
seedEmptyProject(isolatedProject);
process.env.NOVEL_PROJECT_ROOT = isolatedProject;
const { sceneGraph } = require('../Edit/server');

test('scene graph resolves the configured entry scene in an isolated project fixture', async t => {
  t.after(() => fs.rmSync(isolatedProject, { recursive: true, force: true }));
  const graph = await sceneGraph();
  const files = graph.nodes.filter(node => node.type !== 'screen').map(node => node.id).filter(file => file !== 'common.tds');
  assert.equal(files.includes('main.tds'), true);
  assert.deepEqual(files, ['main.tds']);
  assert.deepEqual(graph.nodes.flatMap(node => node.diagnostics || []), []);

  assert.ok(graph.nodes.some(node => node.id === 'main.tds' && node.sceneLocations?.some(scene => scene.name === 'main')));

  const titlePath = path.join(isolatedProject, 'senario', 'title.tds');
  fs.writeFileSync(titlePath, 'scene title_front {\n  say narrator "Title"\n}\n\nscene title_after {\n  say narrator "After"\n}\n', 'utf8');
  fs.writeFileSync(path.join(isolatedProject, 'setting', 'game-screens.json'), JSON.stringify({
    version: 1, initial: 'title', titleScene: { file: 'title.tds', scene: 'title_front' },
    screens: { title: { items: [{ id: 'start', type: 'button', label: 'Start', action: 'start', x: 0, y: 0, width: 100, height: 40 }] } },
  }), 'utf8');
  const titleGraph = await sceneGraph();
  assert.equal(titleGraph.start, 'main.tds', 'setting.txt start_file remains the runtime entry');
  assert.equal(titleGraph.startScene, null, 'game-screens titleScene no longer selects a TDS entry scene');
  assert.equal(titleGraph.nodes.some(node => node.type === 'screen' && node.screen === 'title'), true, 'the explicit start() call adds the configured screen node');
  assert.ok(titleGraph.edges.some(edge => edge.kind === 'screen') && titleGraph.edges.some(edge => edge.kind === 'resume'));
  assert.equal(titleGraph.nodes.find(node => node.id === 'title.tds').reachable, false, 'legacy titleScene does not make the file reachable');
  assert.equal(titleGraph.nodes.find(node => node.id === 'title.tds').error, false);

  fs.writeFileSync(path.join(isolatedProject, 'senario', 'main.tds'), 'fn unused() -> none {\n  start()\n}\nscene main {\n  say narrator "No screen call on this path"\n}\n', 'utf8');
  const unusedStartGraph = await sceneGraph();
  assert.equal(unusedStartGraph.nodes.some(node => node.type === 'screen'), false, 'an uncalled function does not add a front-end screen node');

  fs.writeFileSync(path.join(isolatedProject, 'senario', 'helper.tds'), 'fn title() -> str {\n  start()\n  return "Title"\n}\n', 'utf8');
  fs.writeFileSync(path.join(isolatedProject, 'senario', 'main.tds'), 'include "helper.tds" as ui\nscene main {\n  say narrator ui.title()\n}\n', 'utf8');
  const reachableStartGraph = await sceneGraph();
  assert.equal(reachableStartGraph.nodes.some(node => node.type === 'screen'), true, 'an included function start effect inside a dialogue expression adds the screen node');

  fs.writeFileSync(path.join(isolatedProject, 'senario', 'helper.tds'), 'fn open() -> none {\n  while true { wait 1 }\n  start()\n}\n', 'utf8');
  fs.writeFileSync(path.join(isolatedProject, 'senario', 'main.tds'), 'include "helper.tds" as ui\nscene main {\n  ui.open()\n}\n', 'utf8');
  const unreachableStartGraph = await sceneGraph();
  assert.equal(unreachableStartGraph.nodes.some(node => node.type === 'screen'), false, 'a start() after a non-returning loop does not add an unreachable screen node');

  const packaged = await pack(titlePath, path.join(isolatedProject, '.novel', 'build', 'title.nsp.json'), { projectRoot: isolatedProject });
  assert.deepEqual(packaged.program.scenes.map(scene => scene.name), ['title_front', 'title_after'], 'packaging preserves the TDS source order and ignores the legacy titleScene selector');

  fs.writeFileSync(path.join(isolatedProject, 'senario', 'Entry.TDS'), 'scene entry { say narrator "Entry" }\n', 'utf8');
  const settingsPath = path.join(isolatedProject, 'setting', 'setting.txt');
  fs.writeFileSync(settingsPath, fs.readFileSync(settingsPath, 'utf8').replace('start_file = main.tds', 'start_file = entry.tds'), 'utf8');
  const caseVariantEntryGraph = await sceneGraph();
  assert.equal(caseVariantEntryGraph.start, 'Entry.TDS', 'Scene Flow uses the actual on-disk spelling for a case-insensitive configured entry');
  assert.equal(caseVariantEntryGraph.nodes.find(node => node.id === 'Entry.TDS').reachable, true);
});
