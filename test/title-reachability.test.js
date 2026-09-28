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
  const files = graph.nodes.map(node => node.id).filter(file => file !== 'common.tds');
  assert.equal(files.includes('main.tds'), true);
  assert.deepEqual(files, ['main.tds']);
  assert.deepEqual(graph.nodes.flatMap(node => node.diagnostics || []), []);

  assert.ok(graph.nodes.some(node => node.id === 'main.tds' && node.sceneLocations?.some(scene => scene.name === 'main')));

  const titlePath = path.join(isolatedProject, 'senario', 'title.tds');
  fs.writeFileSync(titlePath, 'scene title_front {\n  say narrator "Title"\n}\n\nscene title_after {\n  say narrator "After"\n}\n', 'utf8');
  fs.writeFileSync(path.join(isolatedProject, 'setting', 'game-screens.json'), JSON.stringify({
    version: 1, initial: 'title', titleScene: { file: 'title.tds', scene: 'title_front' },
    screens: { title: { items: [] } },
  }), 'utf8');
  const titleGraph = await sceneGraph();
  assert.equal(titleGraph.start, 'title.tds');
  assert.equal(titleGraph.startScene, 'title_front');
  assert.equal(titleGraph.nodes.find(node => node.id === 'title.tds').reachable, true);
  assert.equal(titleGraph.nodes.find(node => node.id === 'title.tds').error, false);
  const packaged = await pack(titlePath, path.join(isolatedProject, '.novel', 'build', 'title.nsp.json'), { projectRoot: isolatedProject });
  assert.equal(packaged.program.scenes[0].name, 'title_front', 'the native entry program begins at the configured TDS title scene');
});
