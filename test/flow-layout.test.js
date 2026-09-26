'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { chooseColumnCount, layerFolders, normalizeBounds, optimizeFolderGrid, refineFolderVerticalPositions, routeEdges, separateOverlappingFolders } = require('../Edit/flow-layout');

test('flow layout minimizes crossings for a layered branch', () => {
  const layout = layerFolders(['chapter-a', 'chapter-b', 'route-a', 'route-b'], [
    { from: 'chapter-a', to: 'route-b' },
    { from: 'chapter-b', to: 'route-a' },
  ]);

  assert.deepEqual(layout.columns.get(0), ['chapter-a', 'chapter-b']);
  assert.deepEqual(layout.columns.get(1), ['route-b', 'route-a']);
});

test('flow layout condenses cycles so back-edges do not push every folder outward', () => {
  const layout = layerFolders(['a', 'b', 'c', 'd', 'e'], [
    { from: 'a', to: 'b' }, { from: 'b', to: 'a' },
    { from: 'b', to: 'c' }, { from: 'c', to: 'd' }, { from: 'd', to: 'c' },
    { from: 'd', to: 'e' },
  ]);

  assert.equal(layout.depthByFolder.get('a'), layout.depthByFolder.get('b'));
  assert.equal(layout.depthByFolder.get('c'), layout.depthByFolder.get('d'));
  assert.equal(layout.depthByFolder.get('c'), layout.depthByFolder.get('a') + 1);
  assert.equal(layout.depthByFolder.get('e'), layout.depthByFolder.get('d') + 1);
});

test('flow bounds normalize negative manual offsets and include same-folder edge lanes', () => {
  const folders = new Map([['chapter', { x: -200, y: -100, width: 100, height: 3000 }]]);
  const nodes = new Map([
    ['chapter/a.tds', { x: -180, y: -50, width: 76 }],
    ['chapter/b.tds', { x: -180, y: 2200, width: 76 }],
  ]);
  const bounds = normalizeBounds(folders, nodes, [{ from: 'chapter/a.tds', to: 'chapter/b.tds' }], 36, 42, (file) => file.split('/')[0]);

  assert.ok([...folders.values(), ...nodes.values()].every((position) => position.x >= 0 && position.y >= 0));
  assert.ok(bounds.width >= folders.get('chapter').x + folders.get('chapter').width + 42);
  assert.ok(bounds.height >= folders.get('chapter').y + folders.get('chapter').height + 42);
  assert.ok(bounds.shiftX > 0 && bounds.shiftY > 0);
});

test('flow layout wraps long paths to maximize readable viewport scale', () => {
  assert.equal(chooseColumnCount(Array(10).fill(240), 800, 800, 214, 30, 30, 42), 4);
  assert.equal(chooseColumnCount([240, 240, 240], 800, 800, 214, 30, 30, 42), 3);
});

test('edge routing separates parallel, loop, and backward transitions into distinct lanes', () => {
  const positions = new Map([
    ['a/one.tds', { x: 100, y: 80, width: 160 }],
    ['a/two.tds', { x: 100, y: 130, width: 160 }],
    ['b/one.tds', { x: 290, y: 100, width: 160 }],
  ]);
  const edges = [
    { from: 'a/one.tds', to: 'b/one.tds', kind: 'goto' },
    { from: 'a/two.tds', to: 'b/one.tds', kind: 'include' },
    { from: 'a/one.tds', to: 'a/two.tds', kind: 'goto' },
    { from: 'b/one.tds', to: 'a/one.tds', kind: 'goto' },
    { from: 'a/two.tds', to: 'a/two.tds', kind: 'goto' },
  ];
  const folderOf = (file) => file.split('/')[0];
  const routes = routeEdges(edges, positions, 36, folderOf);
  assert.equal(new Set([...routes.values()].map((route) => route.d)).size, edges.length, 'every relationship gets its own path');
  assert.equal(routes.get(edges[2]).type, 'loop');
  assert.equal(routes.get(edges[3]).type, 'return');
  assert.ok(routes.get(edges[4]).bounds.top < positions.get('a/two.tds').y, 'self-loop arcs above its scene instead of collapsing to a line');
  assert.ok(routes.get(edges[3]).bounds.right > 450, 'backward edge gets an outer return lane');
  assert.ok(routes.get(edges[1]).d !== routes.get(edges[0]).d, 'parallel routes do not overlap exactly');
});

test('high-degree source edges use separate ports and rounded orthogonal routes', () => {
  const positions = new Map([['main.tds', { x: 0, y: 160, width: 150 }]]);
  const edges = Array.from({ length: 8 }, (_, index) => {
    const id = `chapter/scene${index + 1}.tds`;
    positions.set(id, { x: 340, y: 30 + index * 42, width: 170 });
    return { from: 'main.tds', to: id, kind: 'include' };
  });
  const routes = routeEdges(edges, positions, 36, (file) => file.includes('/') ? file.split('/')[0] : '(root)');
  const ordered = edges.map((edge) => routes.get(edge));
  const sourceOffsets = ordered.map((route) => route.sourceOffset);
  assert.ok(Math.max(...sourceOffsets) - Math.min(...sourceOffsets) >= 29, 'ports use almost the full node edge');
  assert.ok(sourceOffsets.every((offset, index) => index === 0 || offset > sourceOffsets[index - 1]), 'port order follows destination order to avoid fan crossings');
  assert.equal(new Set(ordered.map((route) => route.d)).size, edges.length, 'each target keeps a distinct visible route');
  assert.ok(ordered.every((route) => route.d.includes('Q')), 'all connectors use rounded orthogonal bends');
});

test('incoming and outgoing routes on the same right edge use distinct ports', () => {
  const positions = new Map([
    ['chapters/banquet.tds', { x: 100, y: 80, width: 180 }],
    ['routes/return.tds', { x: 420, y: 20, width: 180 }],
    ['routes/next.tds', { x: 420, y: 180, width: 180 }],
  ]);
  const incoming = { from: 'routes/return.tds', to: 'chapters/banquet.tds', kind: 'goto' };
  const outgoing = { from: 'chapters/banquet.tds', to: 'routes/next.tds', kind: 'goto' };
  const folderOf = file => file.split('/')[0];
  const routes = routeEdges([incoming, outgoing], positions, 36, folderOf);
  const arrival = routes.get(incoming), departure = routes.get(outgoing);
  assert.equal(arrival.x2, departure.x1, 'both routes meet the node right edge');
  assert.ok(departure.y1 - arrival.y2 >= 10, 'arrival arrow and departure line are visibly separated');
  assert.ok(arrival.targetOffset < 0 && departure.sourceOffset > 0, 'arrival is above departure');

  const forwardIncoming = { from: 'routes/left.tds', to: 'chapters/banquet.tds', kind: 'goto' };
  positions.set(forwardIncoming.from, { x: -160, y: 80, width: 140 });
  const forward = routeEdges([forwardIncoming, outgoing], positions, 36, folderOf);
  assert.equal(forward.get(forwardIncoming).targetOffset, 0, 'left-side arrivals retain their centered port');
  assert.equal(forward.get(outgoing).sourceOffset, 0, 'a departure without right-side arrivals stays centered');
});

test('self-loop returns to its allocated incoming port', () => {
  const edge = { from: 'chapters/banquet.tds', to: 'chapters/banquet.tds', kind: 'goto' };
  const positions = new Map([[edge.from, { x: 100, y: 80, width: 180 }]]);
  const route = routeEdges([edge], positions, 36, file => file.split('/')[0]).get(edge);
  assert.ok(route.y2 < route.y1, 'self-loop arrow lands above the outgoing line');
  assert.match(route.d, new RegExp(`${route.x2} ${route.y2}$`), 'path ends at its target port');
});

test('edge bounds include outer return lanes so the complete graph stays in view', () => {
  const folders = new Map([['a', { x: 100, y: 60, width: 160, height: 100 }], ['b', { x: 290, y: 60, width: 160, height: 100 }]]);
  const nodes = new Map([
    ['a/one.tds', { x: 100, y: 80, width: 160 }],
    ['b/one.tds', { x: 290, y: 100, width: 160 }],
  ]);
  const bounds = normalizeBounds(folders, nodes, [{ from: 'b/one.tds', to: 'a/one.tds' }], 36, 42, (file) => file.split('/')[0], false);
  assert.ok(bounds.width >= 450 + 42);
});

test('a route around an unrelated folder uses the same rounded orthogonal style', () => {
  const edge = { from: 'a/source.tds', to: 'b/target.tds', kind: 'goto' };
  const nodes = new Map([
    [edge.from, { x: 10, y: 120, width: 120 }],
    [edge.to, { x: 510, y: 120, width: 120 }],
  ]);
  const folders = new Map([
    ['a', { x: 0, y: 105, width: 150, height: 70 }],
    ['block', { x: 250, y: 80, width: 150, height: 160 }],
    ['b', { x: 500, y: 105, width: 150, height: 70 }],
  ]);
  const route = routeEdges([edge], nodes, 36, (file) => file.split('/')[0], folders).get(edge);
  assert.equal(route.type, 'detour');
  assert.ok((route.d.match(/Q/g) || []).length >= 3, 'the detour rounds its corners like every other route');
  assert.doesNotMatch(route.d, /C/, 'detours do not switch to another curve grammar');
  assert.ok(route.bounds.top < folders.get('block').y, 'the path passes above the intervening folder');
});

test('auto-arrange pushes overlapping folder boxes down without disturbing separate columns', () => {
  const input = [
    { id: 'a', x: 0, y: 0, width: 200, height: 150 },
    { id: 'b', x: 150, y: 80, width: 200, height: 150 },
    { id: 'c', x: 170, y: 100, width: 200, height: 50 },
    { id: 'separate', x: 500, y: 0, width: 200, height: 150 },
  ];
  const result = separateOverlappingFolders(input, 30);
  for (let i = 0; i < result.length; i++) for (let j = i + 1; j < result.length; j++) {
    const a = result[i], b = result[j];
    const overlaps = a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
    assert.equal(overlaps, false, `${a.id} and ${b.id} do not overlap`);
  }
  assert.equal(result.find((folder) => folder.id === 'separate').y, 0);
  assert.deepEqual(input.map((folder) => folder.y), [0, 80, 100, 0], 'input positions are not mutated');
  const spaced = separateOverlappingFolders([
    { id: 'top', x: 0, y: 0, width: 200, height: 100 },
    { id: 'bottom', x: 0, y: 110, width: 200, height: 100 },
  ], 30);
  assert.equal(spaced.find((folder) => folder.id === 'bottom').y, 130, 'a narrow existing gap is expanded to the requested spacing');
});

test('grid selection scores crossings, backward edges, route length, aspect, and row balance', () => {
  const folders = Array.from({ length: 8 }, (_, index) => ({ id: `f${index}`, width: 200, height: 120 }));
  const edges = [
    ['f0', 'f3'], ['f2', 'f3'], ['f4', 'f5'], ['f1', 'f0'], ['f0', 'f6'], ['f1', 'f4'],
    ['f3', 'f0'], ['f1', 'f4'], ['f2', 'f0'], ['f2', 'f7'], ['f1', 'f0'], ['f5', 'f2'],
  ].map(([from, to]) => ({ from, to }));
  const layout = optimizeFolderGrid(folders, edges, 1000, 700, 30, 30, 42);
  const oldScaleOnlyChoice = chooseColumnCount(folders.map((folder) => folder.height), 1000, 700, 214, 30, 30, 42);

  assert.equal(layout.columnCount, 4);
  assert.notEqual(layout.columnCount, oldScaleOnlyChoice, 'graph metrics can change the scale-only column choice');
  assert.ok(layout.metrics.crossings > 0);
  assert.ok(layout.metrics.backwardEdges > 0);
  assert.ok(layout.metrics.meanEdgeLength > 0);
  assert.ok(Number.isFinite(layout.metrics.aspectPenalty) && Number.isFinite(layout.metrics.rowWaste));
  assert.equal(layout.score, Math.max(...layout.candidates.map((candidate) => candidate.score)));
  for (let i = 0; i < folders.length; i++) for (let j = i + 1; j < folders.length; j++) {
    const a = layout.positions.get(folders[i].id), b = layout.positions.get(folders[j].id);
    const overlap = a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
    assert.equal(overlap, false, `${folders[i].id} and ${folders[j].id} remain separate`);
  }
});

test('geometric placement moves a short hub toward its targets without overlapping tall folders', () => {
  const folders = [
    { id: 'root', width: 180, height: 70 },
    { id: 'chapters', width: 180, height: 370 },
    { id: 'appendix', width: 180, height: 260 },
    { id: 'gaiden', width: 180, height: 300 },
    { id: 'routes', width: 180, height: 250 },
  ];
  const positions = new Map(folders.map((folder, index) => [folder.id, {
    x: 42 + (index === 4 ? 3 : index) * 244,
    y: index === 4 ? 382 : 42,
    width: folder.width,
    height: folder.height,
  }]));
  const edges = [
    ['root', 'chapters'], ['root', 'appendix'], ['root', 'gaiden'], ['root', 'routes'],
    ['chapters', 'appendix'], ['chapters', 'routes'], ['appendix', 'gaiden'],
  ].map(([from, to]) => ({ from, to }));
  const refined = refineFolderVerticalPositions(folders, edges, positions);
  assert.ok(refined.positions.get('root').y > 42, 'the hub is not pinned to the top of taller destinations');
  assert.ok(refined.after.verticalDistance < refined.before.verticalDistance, 'connections become more vertically aligned');
  assert.ok(refined.after.obstructions <= refined.before.obstructions, 'alignment does not send more lines through folder boxes');
  for (let i = 0; i < folders.length; i++) for (let j = i + 1; j < folders.length; j++) {
    const a = refined.positions.get(folders[i].id), b = refined.positions.get(folders[j].id);
    assert.ok(a.x + a.width + 30 <= b.x || b.x + b.width + 30 <= a.x
      || a.y + a.height + 30 <= b.y || b.y + b.height + 30 <= a.y, `${folders[i].id} and ${folders[j].id} keep their spacing`);
  }
});
