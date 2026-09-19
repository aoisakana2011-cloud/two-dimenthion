const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pack } = require('../tools/pack');

async function createProject(files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-global-scope-'));
  const scenesRoot = path.join(root, 'senario');
  const assetsRoot = path.join(root, 'asset');
  await fs.mkdir(scenesRoot, { recursive: true });
  await fs.mkdir(assetsRoot, { recursive: true });
  for (const [name, source] of Object.entries(files)) await fs.writeFile(path.join(scenesRoot, name), source);
  return { root, scenesRoot, assetsRoot };
}

test('only main declarations and explicit global declarations cross files', async (t) => {
  const local = await createProject({
    'main.tds': 'goto "first.tds"',
    'first.tds': 'int shared = 7\ngoto "end.tds"',
    'end.tds': 'int result = shared',
  });
  t.after(() => fs.rm(local.root, { recursive: true, force: true }));
  await assert.rejects(
    pack(path.join(local.scenesRoot, 'main.tds'), path.join(local.root, 'local.json'), local),
    /未定義の変数 'shared'/,
  );

  const globalProject = await createProject({
    'main.tds': 'goto "first.tds"',
    'first.tds': 'global int shared = 7\ngoto "end.tds"',
    'end.tds': 'int result = shared',
  });
  t.after(() => fs.rm(globalProject.root, { recursive: true, force: true }));
  const packed = await pack(
    path.join(globalProject.scenesRoot, 'main.tds'),
    path.join(globalProject.root, 'global.json'),
    globalProject,
  );
  assert.ok(packed.files['end.tds'].variables.some((variable) => variable.name === 'shared'));
});
