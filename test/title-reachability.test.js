const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
process.env.NOVEL_PROJECT_ROOT = path.resolve(__dirname, '../Title');
const { sceneGraph } = require('../Edit/server');

test('Imogayu reaches every chapter and both endings without scene diagnostics', async () => {
  const graph = await sceneGraph();
  const files = graph.nodes.map(node => node.id);
  assert.deepEqual(files, [
    'chapters/banquet.tds', 'chapters/feast.tds', 'chapters/lake.tds',
    'chapters/road.tds', 'endings/another.tds', 'endings/quiet.tds', 'main.tds',
  ]);
  assert.deepEqual(graph.nodes.flatMap(node => node.diagnostics || []), []);

  const reached = new Set(['main.tds']);
  const queue = ['main.tds'];
  for (const file of queue) {
    for (const edge of graph.edges.filter(edge => edge.from === file && edge.kind === 'goto')) {
      if (reached.has(edge.to)) continue;
      reached.add(edge.to);
      queue.push(edge.to);
    }
  }
  assert.deepEqual([...reached].sort(), [...files].sort());
});
