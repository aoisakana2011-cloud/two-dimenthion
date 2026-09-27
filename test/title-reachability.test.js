const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
process.env.NOVEL_PROJECT_ROOT = path.resolve(__dirname, '../Title');
const { sceneGraph } = require('../Edit/server');

test('Modern Nijumenso story reaches every scenario and all three romance routes', async () => {
  const graph = await sceneGraph();
  const files = graph.nodes.map(node => node.id).filter(file => file !== 'common.tds');
  assert.equal(files.includes('main.tds'), true);
  assert.equal(files.length, 31);
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
  for (const route of ['mio', 'chihaya', 'rei']) {
    assert.ok(files.some(file => file.startsWith(`routes/${route}_`)), `missing ${route} route`);
    assert.ok(files.includes(`endings/${route}_together.tds`), `missing ${route} romance ending`);
  }
});
