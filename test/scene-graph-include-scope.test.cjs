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
    await fs.writeFile(path.join(project.scenesRoot, 'Included.tds'), [
      'fn echo(value: int) -> int {',
      '  int temporary = value',
      '  return temporary',
      '}',
      '',
    ].join('\n'), 'utf8');
    await fs.writeFile(path.join(project.scenesRoot, 'Chapter.tds'), 'scene chapter { say narrator "Chapter" }\n', 'utf8');
    await fs.writeFile(path.join(project.scenesRoot, 'main.tds'), [
      'include "included.tds" as helper',
      'global int result = 0',
      'scene main {',
      '  set result = helper.echo(1)',
      '  goto "chapter.tds"',
      '}',
      '',
    ].join('\n'), 'utf8');
    process.env.NOVEL_PROJECT_ROOT = root;

    const { sceneGraph } = require('../Edit/server');
    const graph = await sceneGraph();
    const owner = graph.nodes.find((node) => node.id === 'main.tds');
    const module = graph.nodes.find((node) => node.id === 'Included.tds');
    assert.ok(graph.edges.some((edge) => edge.from === 'main.tds' && edge.to === 'Chapter.tds' && edge.kind === 'goto'), 'goto edges use the actual on-disk file spelling');
    assert.ok(owner && module, 'both include owner and module have graph nodes');
    assert.ok(graph.edges.some((edge) => edge.from === 'main.tds' && edge.to === 'Included.tds' && edge.kind === 'include'), 'include edges use the actual on-disk file spelling');
    assert.ok(!owner.variables.some((variable) => ['value', 'temporary'].includes(variable.name)), 'include owner excludes module function parameters and locals');
    for (const name of ['value', 'temporary']) {
      const variable = module.variables.find((item) => item.name === name);
      assert.ok(variable, `module graph retains ${name}`);
      assert.equal(variable.definedIn, 'echo');
      assert.ok(variable.definitions.every((location) => location.file === 'Included.tds'));
      assert.ok(variable.references.every((location) => location.file === 'Included.tds'));
    }
    console.log('PASS scene graph keeps included function variables in their defining file');
  } finally {
    if (previousRoot === undefined) delete process.env.NOVEL_PROJECT_ROOT;
    else process.env.NOVEL_PROJECT_ROOT = previousRoot;
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
