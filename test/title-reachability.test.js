const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { analyzeScript, sceneReachability } = require('../dist/checker/analyzer');
const { resolveProjectScript } = require('../tools/project');

test('Title exposes every included chapter, route, gaiden, appendix, and ending from its opening menu', async () => {
  const scenesRoot = path.resolve(__dirname, '../Title/senario');
  const source = await fs.readFile(path.join(scenesRoot, 'main.tds'), 'utf8');
  const script = await resolveProjectScript(source, scenesRoot, new Set(), 'main.tds');
  const unreachable = analyzeScript(script, 'main.tds').filter((item) => item.code === 'unreachable-scene');
  const reachability = sceneReachability(script);

  assert.deepEqual(unreachable, []);
  assert.equal(reachability.reachableScenes.size, script.scenes.length);
});
