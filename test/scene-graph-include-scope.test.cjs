'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { seedEmptyProject } = require('../tools/project-layout');

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-flow-scope-'));
  const previousRoot = process.env.NOVEL_PROJECT_ROOT;
  try {
    const project = seedEmptyProject(root);
    await fs.writeFile(path.join(project.scenesRoot, 'included.tds'), [
      'fn echo(value: int) -> int {',
      '  int temporary = value',
      '  return temporary',
      '}',
      '',
    ].join('\n'), 'utf8');
    await fs.writeFile(path.join(project.scenesRoot, 'main.tds'), [
      'include "included.tds" as helper',
      'global int result = 0',
      'scene main {',
      '  set result = helper.echo(1)',
      '}',
      '',
    ].join('\n'), 'utf8');
    process.env.NOVEL_PROJECT_ROOT = root;

    const { sceneGraph } = require('../Edit/server');
    const graph = await sceneGraph();
    const owner = graph.nodes.find((node) => node.id === 'main.tds');
    const module = graph.nodes.find((node) => node.id === 'included.tds');
    assert.ok(owner && module, 'both include owner and module have graph nodes');
    assert.ok(!owner.variables.some((variable) => ['value', 'temporary'].includes(variable.name)), 'include owner excludes module function parameters and locals');
    for (const name of ['value', 'temporary']) {
      const variable = module.variables.find((item) => item.name === name);
      assert.ok(variable, `module graph retains ${name}`);
      assert.equal(variable.definedIn, 'echo');
      assert.ok(variable.definitions.every((location) => location.file === 'included.tds'));
      assert.ok(variable.references.every((location) => location.file === 'included.tds'));
    }
    console.log('PASS scene graph keeps included function variables in their defining file');
  } finally {
    if (previousRoot === undefined) delete process.env.NOVEL_PROJECT_ROOT;
    else process.env.NOVEL_PROJECT_ROOT = previousRoot;
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
