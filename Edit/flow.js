const graph = document.querySelector('#graph');
const details = document.querySelector('#details');
const status = document.querySelector('#status');
const flowCount = document.querySelector('#flow-count');
const canvasHeader = document.querySelector('.canvas > header');
const flowCountLabel = document.createElement('span');
flowCountLabel.className = 'flow-count-label';
flowCountLabel.append(flowCount);
const flowActions = document.createElement('div');
flowActions.className = 'flow-canvas-actions';
[['fit', '全体表示'], ['auto-layout', '自動配置']].forEach(([action, label]) => {
  const button = document.createElement('button');
  button.type = 'button'; button.dataset.flowAction = action; button.className = 'flow-layout-action'; button.textContent = label;
  flowActions.append(button);
});
const flowInstructions = canvasHeader?.querySelector('small');
if (canvasHeader && flowInstructions) {
  canvasHeader.insertBefore(flowCountLabel, flowInstructions);
  canvasHeader.insertBefore(flowActions, flowInstructions);
  flowInstructions.className = 'flow-instructions';
}
let data = null;
let selected = '';
let layoutStorageKey = '';
let flowProjectRoot = '';
let savedFolderOffsets = {};
let panState = null;
let dragState = null;
let flowZoom = 1;
let flowWorldWidth = 0;
let flowWorldHeight = 0;
let initialFlowFit = true;
const flowFilter = { query: '', showIncludes: false };
function sendToEditor(message) {
  if (window.parent === window) return false;
  window.parent.postMessage(message, location.origin);
  return true;
}
const folderOf = (file) => {
  const parts = String(file).replaceAll('\\', '/').split('/');
  return parts.length > 1 ? parts.slice(0, -1).join('/') : '(root)';
};
const fileLabel = (file) => String(file).replaceAll('\\', '/').split('/').pop().replace(/(?:\.novel)?\.tds$/i, '');
const svg = (name, attrs = {}) => {
  const element = document.createElementNS('http://www.w3.org/2000/svg', name);
  Object.entries(attrs).forEach(([key, value]) => element.setAttribute(key, value));
  return element;
};
function editorLink(file) {
  const element = document.createElement('a');
  element.className = 'detail-link';
  element.href = '/?scene=' + encodeURIComponent(file);
  element.addEventListener('click', (event) => { if (sendToEditor({ type: 'scene-flow:open-scene', scene: file })) event.preventDefault(); });
  element.textContent = file;
  return element;
}
function detailGroup(title, items) {
  if (!items.length) return;
  const box = document.createElement('div'); box.className = 'detail-group';
  const heading = document.createElement('div'); heading.className = 'group-label'; heading.textContent = title;
  box.append(heading);
  [...new Set(items)].forEach((item) => box.append(editorLink(item)));
  details.append(box);
}
function transitionGroup(title, transitions, fallbackFile) {
  if (!transitions.length) return;
  const box = document.createElement('div'); box.className = 'detail-group transition-group';
  const heading = document.createElement('div'); heading.className = 'group-label'; heading.textContent = `${title} (${transitions.length})`;
  box.append(heading);
  transitions.forEach((transition) => {
    const row = document.createElement('div'); row.className = 'transition-row';
    const context = document.createElement('span'); context.className = 'transition-context';
    context.textContent = `${transition.fromScene || 'scene'} → ${transition.toScene || fileLabel(fallbackFile)}${transition.choice ? ` · ${transition.choice}` : ''}`;
    row.append(context);
    const targetFile = transition.toFile || fallbackFile;
    const target = editorLink(targetFile); target.classList.add('transition-target');
    target.textContent = `${targetFile}${transition.line ? `:${transition.line}` : ''}`;
    row.append(target); box.append(row);
  });
  details.append(box);
}
function diagnosticGroup(node) {
  const diagnostics = node?.diagnostics || [];
  if (!diagnostics.length) return;
  const box = document.createElement('div'); box.className = 'detail-group diagnostic-group';
  const heading = document.createElement('div'); heading.className = 'group-label'; heading.textContent = `Diagnostics (${diagnostics.length})`;
  box.append(heading);
  diagnostics.forEach((diagnostic) => {
    const row = document.createElement('div'); row.className = `flow-diagnostic ${diagnostic.severity || 'warning'}`;
    row.textContent = `${diagnostic.severity || 'warning'} ${diagnostic.code || 'diagnostic'}: ${diagnostic.message || ''}`;
    if (diagnostic.line) row.title = `${diagnostic.file || node.id}:${diagnostic.line}:${diagnostic.column || 1}`;
    row.addEventListener('click', () => {
      if (sendToEditor({ type: 'scene-flow:open-scene', scene: diagnostic.file || node.id, line: diagnostic.line, column: diagnostic.column })) return;
      window.location.href = '/?scene=' + encodeURIComponent(diagnostic.file || node.id);
    });
    box.append(row);
  });
  details.append(box);
}
function filteredFlow(flow) {
  const query = flowFilter.query.trim().toLocaleLowerCase();
  const nodes = flow.nodes.filter((node) => {
    if (!query) return true;
    const haystack = [node.id, node.label, ...(node.diagnostics || []).flatMap((item) => [item.code, item.message])].join(' ').toLocaleLowerCase();
    return haystack.includes(query);
  });
  const ids = new Set(nodes.map((node) => node.id));
  const edges = flow.edges.filter((edge) => (flowFilter.showIncludes || edge.kind !== 'include') && ids.has(edge.from) && ids.has(edge.to));
  return { ...flow, nodes, edges };
}
function variableTypeLabel(type) {
  if (typeof type === 'string') return type;
  if (!type || typeof type !== 'object') return 'unknown';
  if (type.kind === 'struct' && typeof type.name === 'string') {
    return type.name.startsWith('character:') ? `character ${type.name.slice('character:'.length)}` : `struct ${type.name}`;
  }
  if (type.kind === 'dict') return `dict<${type.value || 'unknown'}>`;
  return 'unknown';
}
function selectNode(file) {
  selected = file;
  updateFlowTestPanel();
  document.querySelectorAll('.flow-node').forEach((node) => node.classList.toggle('selected', node.dataset.file === file));
  const flowSvg = graph.querySelector('.flow-svg');
  if (flowSvg) flowSvg.dataset.hasSelection = 'true';
  const outgoingNeighbors = new Map();
  const incomingNeighbors = new Map();
  const addNeighbor = (map, from, to) => {
    if (!map.has(from)) map.set(from, []);
    map.get(from).push(to);
  };
  document.querySelectorAll('.flow-edge').forEach((edge) => {
    const isRelated = edge.dataset.from === file || edge.dataset.to === file;
    edge.classList.toggle('is-related', isRelated);
    addNeighbor(outgoingNeighbors, edge.dataset.from, edge.dataset.to);
    addNeighbor(incomingNeighbors, edge.dataset.to, edge.dataset.from);
  });
  const relationDistances = new Map();
  const collectDistances = (neighbors) => {
    const distances = new Map([[file, 0]]);
    const queue = [file];
    for (let index = 0; index < queue.length; index++) {
      const current = queue[index];
      const distance = distances.get(current) + 1;
      for (const next of neighbors.get(current) || []) {
        if (distances.has(next)) continue;
        distances.set(next, distance);
        queue.push(next);
        if (next !== file) {
          const previousDistance = relationDistances.get(next);
          if (previousDistance === undefined || distance < previousDistance) relationDistances.set(next, distance);
        }
      }
    }
  };
  collectDistances(outgoingNeighbors);
  collectDistances(incomingNeighbors);
  document.querySelectorAll('.flow-node').forEach((node) => {
    const isSelected = node.dataset.file === file;
    const distance = relationDistances.get(node.dataset.file);
    node.classList.toggle('related', !isSelected && distance !== undefined);
    if (!isSelected && distance !== undefined) {
      const strength = Math.max(0, 1 - (distance - 1) / 4);
      node.style.setProperty('--relation-percent', `${Math.round(strength * 100)}%`);
      node.dataset.relationDistance = String(distance);
    } else {
      node.style.removeProperty('--relation-percent');
      delete node.dataset.relationDistance;
    }
  });
  details.replaceChildren();
  details.scrollTop = 0;
  const heading = document.createElement('div'); heading.className = 'detail-title'; heading.textContent = file;
  details.append(heading);
  detailGroup('転移元', data.edges.filter((edge) => edge.to === file).map((edge) => edge.from));
  detailGroup('転移先', data.edges.filter((edge) => edge.from === file).map((edge) => edge.to));
  const node = data.nodes.find((item) => item.id === file);
  if (node?.sceneNames?.length) {
    const scenes = document.createElement('div'); scenes.className = 'detail-meta';
    scenes.textContent = `${node.sceneNames.length} scenes: ${node.sceneNames.join(', ')}`;
    details.append(scenes);
  }
  const outgoing = data.edges.filter((edge) => edge.from === file && edge.kind === 'goto')
    .flatMap((edge) => (edge.transitions || []).map((item) => ({ ...item, toFile: edge.to })));
  const local = (node?.localGotos || []).map((item) => ({
    fromScene: item.fromScene, toScene: item.scene, choice: item.choice, line: item.gotoLine, toFile: item.file,
  }));
  transitionGroup('Goto destinations', [...local, ...outgoing], file);
  if (node?.reachable === false) {
    const warning = document.createElement('div'); warning.className = 'flow-error'; warning.textContent = '開始ファイルから到達できません'; details.append(warning);
  }
  if (node?.error) {
    const warning = document.createElement('div'); warning.className = 'flow-error'; warning.textContent = 'このファイルは解析できません'; details.append(warning);
  }
  if (node?.scenes) {
    const sceneSummary = document.createElement('div'); sceneSummary.className = 'detail-meta';
    sceneSummary.textContent = `scenes: ${node.scenes.reachable}/${node.scenes.total} reachable`;
    details.append(sceneSummary);
  }
  diagnosticGroup(node);
  if (node?.variables?.length) {
    const box = document.createElement('div'); box.className = 'detail-group';
    const title = document.createElement('div'); title.className = 'group-label'; title.textContent = '変数'; box.append(title);
    const groups = new Map();
    node.variables.forEach((variable) => { const type = variableTypeLabel(variable.type); if (!groups.has(type)) groups.set(type, []); groups.get(type).push(variable.name); });
    groups.forEach((names, type) => {
      const heading = document.createElement('div'); heading.className = 'variable-type'; heading.textContent = `${type}:`; box.append(heading);
      names.forEach((name) => { const row = document.createElement('div'); row.className = 'variable'; row.textContent = name; row.title = 'Ctrl+クリックで定義を開く'; row.addEventListener('click', (event) => { if (!event.ctrlKey && !event.metaKey) return; event.preventDefault(); if (!sendToEditor({ type: 'scene-flow:open-scene', scene: file, symbol: name })) window.location.href = '/?scene=' + encodeURIComponent(file) + '&symbol=' + encodeURIComponent(name); }); box.append(row); });
    });
    details.append(box);
  }
}
window.selectFlowNode = (file) => {
  if (!data?.nodes.some((node) => node.id === file)) return;
  selectNode(file);
  document.querySelector(`.flow-node[data-file="${CSS.escape(file)}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
};

function setFlowZoom(nextZoom, anchor = null) {
  const root = graph.querySelector('.flow-svg');
  if (!root) return;
  const next = Math.max(0.05, Math.min(2.5, nextZoom));
  const rect = graph.getBoundingClientRect();
  const anchorX = anchor ? anchor.x - rect.left : 0;
  const anchorY = anchor ? anchor.y - rect.top : 0;
  const worldX = (graph.scrollLeft + anchorX) / flowZoom;
  const worldY = (graph.scrollTop + anchorY) / flowZoom;
  flowZoom = next;
  root.setAttribute('width', String(Math.ceil(flowWorldWidth * flowZoom)));
  root.setAttribute('height', String(Math.ceil(flowWorldHeight * flowZoom)));
  graph.scrollLeft = anchor ? Math.max(0, worldX * flowZoom - anchorX) : 0;
  graph.scrollTop = anchor ? Math.max(0, worldY * flowZoom - anchorY) : 0;
}

function fitFlowGraph() {
  if (!flowWorldWidth || !flowWorldHeight || graph.clientWidth <= 0 || graph.clientHeight <= 0) return false;
  const availableWidth = Math.max(1, graph.clientWidth - 36);
  const availableHeight = Math.max(1, graph.clientHeight - 36);
  setFlowZoom(Math.min(2.5, availableWidth / flowWorldWidth, availableHeight / flowWorldHeight));
  initialFlowFit = false;
  return true;
}

function render(flow) {
  data = flow;
  const view = filteredFlow(flow);
  const tree = { path: '', label: '', nodes: [], children: new Map() };
  const ensureFolder = (folder) => {
    const parts = folder === '(root)' ? ['(root)'] : folder.split('/');
    let branch = tree, path = '';
    parts.forEach((part) => {
      path = path ? `${path}/${part}` : part;
      if (!branch.children.has(part)) branch.children.set(part, { path, label: path, nodes: [], children: new Map() });
      branch = branch.children.get(part);
    });
    return branch;
  };
  view.nodes.forEach((node) => {
    const folder = folderOf(node.id);
    ensureFolder(folder).nodes.push(node);
  });
  const topFolders = [...tree.children.values()].sort((a, b) => a.path.localeCompare(b.path, 'ja'));
  const topFolderOf = (file) => {
    const folder = folderOf(file);
    return folder === '(root)' ? folder : folder.split('/')[0];
  };
  const topEdges = view.edges.map((edge) => ({ from: topFolderOf(edge.from), to: topFolderOf(edge.to) }));
  const layered = window.FlowLayout.layerFolders(topFolders.map((folder) => folder.path), topEdges);
  const columns = new Map();
  topFolders.forEach((folder) => {
    const depth = layered.depthByFolder.get(folder.path) || 0;
    if (!columns.has(depth)) columns.set(depth, []);
    columns.get(depth).push(folder);
  });
  for (const [depth, folders] of columns) {
    const order = new Map((layered.columns.get(depth) || []).map((id, index) => [id, index]));
    folders.sort((left, right) => order.get(left.path) - order.get(right.path));
  }
  const layerEntries = [...columns].sort(([left], [right]) => left - right);

  const folderWidth = 214, layoutGapX = 30, folderGapX = 48, folderGapY = 48;
  const nodeHeight = 36, nodeGap = 6, headerHeight = 27, padding = 18, layoutPadding = 42;
  const folderPositions = new Map(), nodePositions = new Map();
  const internalTransitionCounts = new Map();
  for (const edge of view.edges) {
    const sourceFolder = folderOf(edge.from);
    if (sourceFolder === folderOf(edge.to)) internalTransitionCounts.set(sourceFolder, (internalTransitionCounts.get(sourceFolder) || 0) + 1);
  }
  const measureFolder = (folder, depth) => {
    const baseWidth = Math.max(132, folderWidth - depth * 18);
    const internalTransitions = internalTransitionCounts.get(folder.path) || 0;
    folder.routeGutter = internalTransitions ? 24 + (internalTransitions - 1) * 12 : 0;
    folder.width = baseWidth + folder.routeGutter;
    const nodeIds = folder.nodes.map((node) => node.id);
    const orderedNodeIds = window.FlowLayout.orderNodes(nodeIds, view.edges);
    const nodeOrder = new Map(orderedNodeIds.map((id, index) => [id, index]));
    folder.nodes.sort((a, b) => nodeOrder.get(a.id) - nodeOrder.get(b.id));
    const children = [...folder.children.values()].sort((a, b) => a.path.localeCompare(b.path, 'ja'));
    children.forEach((child) => measureFolder(child, depth + 1));
    const nodesHeight = folder.nodes.length * nodeHeight + Math.max(0, folder.nodes.length - 1) * nodeGap;
    const childrenHeight = children.reduce((sum, child, index) => sum + child.height + (index ? 10 : 0), 0);
    folder.height = headerHeight + 10 + nodesHeight + (nodesHeight && childrenHeight ? 10 : 0) + childrenHeight + 10;
  };
  topFolders.forEach((folder) => measureFolder(folder, 0));
  const orderedFolders = layerEntries.flatMap(([, folders]) => folders);
  const optimizedLayout = window.FlowLayout.optimizeFolderGrid(
    orderedFolders.map((folder) => ({ id: folder.path, width: folder.width, height: folder.height })),
    topEdges,
    graph.clientWidth - 36,
    graph.clientHeight - 36,
    layoutGapX,
    30,
    layoutPadding,
  );
  const maxFolderWidth = Math.max(0, ...orderedFolders.map((folder) => folder.width));
  for (const position of optimizedLayout.positions.values()) {
    const column = Math.round((position.x - layoutPadding) / (maxFolderWidth + layoutGapX));
    position.x = padding + column * (maxFolderWidth + folderGapX);
  }
  optimizedLayout.width = padding * 2 + optimizedLayout.columnCount * maxFolderWidth
    + Math.max(0, optimizedLayout.columnCount - 1) * folderGapX;
  optimizedLayout.height = optimizedLayout.positions.size
    ? Math.ceil(Math.max(...[...optimizedLayout.positions.values()].map((position) => position.y + position.height)) + padding)
    : padding * 2;
  const placeFolder = (folder, x, y, depth) => {
    folderPositions.set(folder.path, { x, y, width: folder.width, height: folder.height, folder });
    let cursor = y + headerHeight + 10;
    folder.nodes.forEach((node, index) => {
      nodePositions.set(node.id, { x: x + 12, y: cursor + index * (nodeHeight + nodeGap), width: folder.width - 24 - folder.routeGutter });
    });
    cursor += folder.nodes.length * nodeHeight + Math.max(0, folder.nodes.length - 1) * nodeGap;
    if (folder.nodes.length && folder.children.size) cursor += 10;
    [...folder.children.values()].sort((a, b) => a.path.localeCompare(b.path, 'ja')).forEach((child) => {
      placeFolder(child, x + 12, cursor, depth + 1);
      cursor += child.height + 10;
    });
  };
  orderedFolders.forEach((folder) => {
    const position = optimizedLayout.positions.get(folder.path);
    placeFolder(folder, position.x, position.y, 0);
  });
  const applyFolderOffsets = (folder, parentX = 0, parentY = 0) => {
    const own = savedFolderOffsets[folder.path] || {};
    const offsetX = parentX + (Number.isFinite(own.x) ? own.x : 0);
    const offsetY = parentY + (Number.isFinite(own.y) ? own.y : 0);
    const position = folderPositions.get(folder.path);
    position.x += offsetX; position.y += offsetY;
    folder.nodes.forEach((node) => { const nodePosition = nodePositions.get(node.id); nodePosition.x += offsetX; nodePosition.y += offsetY; });
    [...folder.children.values()].forEach((child) => applyFolderOffsets(child, offsetX, offsetY));
  };
  topFolders.forEach((folder) => applyFolderOffsets(folder));
  const separated = window.FlowLayout.separateOverlappingFolders(orderedFolders.map((folder) => {
    const position = folderPositions.get(folder.path);
    return { id: folder.path, x: position.x, y: position.y, width: position.width, height: position.height };
  }), folderGapY);
  const targetY = new Map(separated.map((folder) => [folder.id, folder.y]));
  const moveFolderTree = (folder, deltaY) => {
    if (!deltaY) return;
    folderPositions.get(folder.path).y += deltaY;
    folder.nodes.forEach((node) => { nodePositions.get(node.id).y += deltaY; });
    [...folder.children.values()].forEach((child) => moveFolderTree(child, deltaY));
  };
  topFolders.forEach((folder) => moveFolderTree(folder, targetY.get(folder.path) - folderPositions.get(folder.path).y));
  const bounds = window.FlowLayout.normalizeBounds(folderPositions, nodePositions, view.edges, nodeHeight, padding, folderOf);
  const layoutWidth = optimizedLayout.width;
  flowWorldWidth = Math.max(1, bounds.width, layoutWidth);
  flowWorldHeight = Math.max(1, bounds.height, optimizedLayout.height);
  const root = svg('svg', { class: 'flow-svg', width: Math.ceil(flowWorldWidth * flowZoom), height: Math.ceil(flowWorldHeight * flowZoom), viewBox: `0 0 ${flowWorldWidth} ${flowWorldHeight}`, preserveAspectRatio: 'none' });
  root.dataset.layoutColumns = String(optimizedLayout.columnCount);
  root.dataset.layoutScore = optimizedLayout.score.toFixed(2);
  root.dataset.layoutMetrics = JSON.stringify(optimizedLayout.metrics);
  const resizeCanvasToPositions = () => {
    const currentBounds = window.FlowLayout.normalizeBounds(folderPositions, nodePositions, view.edges, nodeHeight, padding, folderOf, false);
    flowWorldWidth = Math.max(1, currentBounds.width, layoutWidth);
    flowWorldHeight = Math.max(1, currentBounds.height, optimizedLayout.height);
    root.setAttribute('viewBox', `0 0 ${flowWorldWidth} ${flowWorldHeight}`);
    root.setAttribute('width', String(Math.ceil(flowWorldWidth * flowZoom)));
    root.setAttribute('height', String(Math.ceil(flowWorldHeight * flowZoom)));
  };
  const defs = svg('defs');
  const marker = svg('marker', { id: 'arrow', markerWidth: 8, markerHeight: 8, refX: 7, refY: 3, orient: 'auto' });
  marker.append(svg('path', { d: 'M0 0v6l7-3z', class: 'flow-arrow' })); defs.append(marker);
  const includeMarker = svg('marker', { id: 'include-arrow', markerWidth: 8, markerHeight: 8, refX: 7, refY: 3, orient: 'auto' });
  includeMarker.append(svg('path', { d: 'M0 0v6l7-3z', class: 'flow-arrow include-arrow' })); defs.append(includeMarker); root.append(defs);

  const folderElements = new Map(), nodeElements = new Map();
  const drawFolder = (folder) => {
    const position = folderPositions.get(folder.path);
    const box = svg('g', { class: 'flow-folder', transform: `translate(${position.x} ${position.y})` });
    box.dataset.folder = folder.path;
    box.append(svg('rect', { class: 'flow-folder-frame', y: 9, width: position.width, height: position.height - 9, rx: 3 }));
    const labelWidth = Math.min(position.width - 18, Math.max(48, folder.label.length * 7 + 18));
    box.append(svg('rect', { class: 'flow-folder-label-bg', x: 9, y: 1, width: labelWidth, height: 18 }));
    const title = svg('text', { class: 'flow-folder-title', x: 17, y: 14 }); title.textContent = folder.label;
    box.append(title); root.append(box); folderElements.set(folder.path, box);
    box.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.stopPropagation();
      const point = root.createSVGPoint(); point.x = event.clientX; point.y = event.clientY;
      const start = point.matrixTransform(root.getScreenCTM().inverse());
      const items = [];
      const collect = (current) => {
        const folderPosition = folderPositions.get(current.path);
        items.push({ element: folderElements.get(current.path), position: folderPosition, x: folderPosition.x, y: folderPosition.y });
        current.nodes.forEach((node) => { const nodePosition = nodePositions.get(node.id); items.push({ element: nodeElements.get(node.id), position: nodePosition, x: nodePosition.x, y: nodePosition.y }); });
        [...current.children.values()].forEach(collect);
      };
      collect(folder);
      dragState = { folder, items, startX: start.x, startY: start.y, moved: false, dx: 0, dy: 0 };
      box.setPointerCapture(event.pointerId);
    });
    [...folder.children.values()].sort((a, b) => a.path.localeCompare(b.path, 'ja')).forEach(drawFolder);
  };
  topFolders.forEach(drawFolder);
  const edgeLayer = svg('g', { class: 'flow-edges' });
  const drawEdges = () => {
    edgeLayer.replaceChildren();
    const routes = window.FlowLayout.routeEdges(view.edges, nodePositions, nodeHeight, folderOf, folderPositions);
    view.edges.forEach((edge) => {
      const route = routes.get(edge); if (!route) return;
      const isInclude = edge.kind === 'include';
      const path = svg('path', { d: route.d, class: `flow-edge ${route.type}-edge ${isInclude ? 'include-edge' : ''}`, 'marker-end': isInclude ? 'url(#include-arrow)' : 'url(#arrow)' });
      path.dataset.from = edge.from; path.dataset.to = edge.to; path.dataset.kind = edge.kind || 'goto'; edgeLayer.append(path);
      if (edge.kind === 'goto' && edge.transitions?.length) {
        const title = svg('title');
        title.textContent = edge.transitions.map((item) => `${item.fromScene || 'scene'} → ${item.toScene || fileLabel(edge.to)}${item.choice ? ` · ${item.choice}` : ''} (line ${item.line})`).join('\n');
        path.append(title);
      }
    });
  };
  drawEdges();
  root.append(edgeLayer);
  view.nodes.forEach((node) => {
    const position = nodePositions.get(node.id);
    const warning = (node.diagnostics || []).some((diagnostic) => diagnostic.severity !== 'error');
    const item = svg('g', { class: `flow-node${node.reachable === false ? ' unreachable' : ''}${node.error ? ' error' : ''}${warning ? ' warning' : ''}`, transform: `translate(${position.x} ${position.y})`, tabindex: 0, role: 'button' });
    item.dataset.file = node.id;
    item.append(svg('rect', { width: position.width, height: nodeHeight, rx: 3 }));
    const name = svg('text', { x: 11, y: 22 });
    const sceneCount = node.sceneNames?.length || node.scenes?.total || 0;
    name.textContent = sceneCount > 1 ? `${fileLabel(node.id)} · ${sceneCount} scenes` : fileLabel(node.id);
    item.append(name);
    if (node.diagnostics?.length) { const title = svg('title'); title.textContent = node.diagnostics.map((diagnostic) => diagnostic.message).join('\n'); item.append(title); }
    item.addEventListener('click', () => selectNode(node.id));
    item.addEventListener('dblclick', () => { if (!sendToEditor({ type: 'scene-flow:open-scene', scene: node.id })) location.href = '/?scene=' + encodeURIComponent(node.id); });
    item.addEventListener('keydown', (event) => { if (event.key === 'Enter') selectNode(node.id); });
    root.append(item);
    nodeElements.set(node.id, item);
  });
  root.addEventListener('pointermove', (event) => {
    if (!dragState) return;
    const point = root.createSVGPoint(); point.x = event.clientX; point.y = event.clientY;
    const current = point.matrixTransform(root.getScreenCTM().inverse());
    let dx = current.x - dragState.startX, dy = current.y - dragState.startY;
    dx = Math.max(dx, padding - Math.min(...dragState.items.map((item) => item.x)));
    dy = Math.max(dy, padding - Math.min(...dragState.items.map((item) => item.y)));
    if (Math.abs(dx) + Math.abs(dy) > 2) dragState.moved = true;
    if (!dragState.moved) return;
    dragState.dx = dx; dragState.dy = dy;
    dragState.items.forEach(({ element, position, x, y }) => {
      position.x = x + dx; position.y = y + dy;
      element?.setAttribute('transform', `translate(${position.x} ${position.y})`);
    });
    drawEdges();
    resizeCanvasToPositions();
  });
  const finishNodeDrag = () => {
    if (!dragState) return;
    if (dragState.moved) {
      const previous = savedFolderOffsets[dragState.folder.path] || { x: 0, y: 0 };
      savedFolderOffsets[dragState.folder.path] = { x: previous.x + dragState.dx, y: previous.y + dragState.dy };
      try { if (layoutStorageKey) localStorage.setItem(layoutStorageKey, JSON.stringify(savedFolderOffsets)); } catch { /* storage can be disabled */ }
    }
    dragState = null;
  };
  root.addEventListener('pointerup', finishNodeDrag);
  root.addEventListener('pointercancel', finishNodeDrag);
  graph.replaceChildren(root);
  if (initialFlowFit) fitFlowGraph();
  status.textContent = '準備完了';
  const count = (value, singular) => `${value} ${singular}${value === 1 ? '' : 's'}`;
  flowCount.textContent = [count(folderPositions.size, 'folder'), count(view.nodes.length, 'scene'), count(view.edges.length, 'relation')].join(' / ');
  if (view.nodes.length) selectNode(selected && nodePositions.has(selected) ? selected : view.nodes[0].id);
  else { selected = ''; details.textContent = 'No matching scenes'; }
}

async function refreshFlowGraph() {
  const response = await fetch('/api/scene-graph', { cache: 'no-store' });
  if (!response.ok) throw Error('Scene Flow API error: ' + response.status);
  render(await response.json());
}
function showFlowLoadError(error) {
  status.textContent = 'Error'; status.title = error.message; details.textContent = error.message; flowCount.textContent = '';
}
window.addEventListener('message', (event) => {
  if (event.origin !== location.origin || event.source !== window.parent) return;
  if (event.data?.type === 'scene-flow:refresh') {
    if (typeof event.data.projectRoot === 'string' && flowProjectRoot && event.data.projectRoot !== flowProjectRoot) {
      flowProjectRoot = event.data.projectRoot;
      selected = '';
      flowTestSelectionKey = '';
      flowVariableDrafts.clear();
      flowTestLine.value = '';
      flowTestVars.replaceChildren();
      layoutStorageKey = `novel-scene-flow-layout:${flowProjectRoot || location.origin}`;
      try { savedFolderOffsets = JSON.parse(localStorage.getItem(layoutStorageKey) || '{}') || {}; } catch { savedFolderOffsets = {}; }
      initialFlowFit = true;
    }
    refreshFlowGraph().catch(showFlowLoadError);
  }
  if (event.data?.type === 'scene-flow:line-picked') {
    const node = data?.nodes.find((item) => item.id === selected);
    const scene = node?.sceneLocations?.find((item) => item.name === flowTestScene.value);
    const line = Number(event.data.line);
    if (node && scene && event.data.file === node.id && event.data.scene === scene.name && Number.isSafeInteger(line) && line >= scene.line && line <= scene.endLine) {
      flowTestLine.value = String(line);
      updateFlowTestPanel();
    }
  }
});
fetch('/api/project', { cache: 'no-store' }).then((response) => response.ok ? response.json() : {}).catch(() => ({})).then((project) => {
  flowProjectRoot = project.projectRoot || '';
  layoutStorageKey = `novel-scene-flow-layout:${project.projectRoot || location.origin}`;
  try { savedFolderOffsets = JSON.parse(localStorage.getItem(layoutStorageKey) || '{}') || {}; } catch { savedFolderOffsets = {}; }
  return refreshFlowGraph();
}).catch(showFlowLoadError);

graph.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || event.target.closest('.flow-node')) return;
  panState = { x: event.clientX, y: event.clientY, left: graph.scrollLeft, top: graph.scrollTop, pointerId: event.pointerId };
  graph.classList.add('panning');
  graph.setPointerCapture(event.pointerId);
});
graph.addEventListener('pointermove', (event) => {
  if (!panState || panState.pointerId !== event.pointerId) return;
  graph.scrollLeft = panState.left - (event.clientX - panState.x);
  graph.scrollTop = panState.top - (event.clientY - panState.y);
});
const finishPan = (event) => { if (!panState || panState.pointerId !== event.pointerId) return; panState = null; graph.classList.remove('panning'); };
graph.addEventListener('pointerup', finishPan);
graph.addEventListener('pointercancel', finishPan);
graph.addEventListener('wheel', (event) => {
  const root = graph.querySelector('.flow-svg');
  if (!root) return;
  if (!event.ctrlKey) {
    event.preventDefault();
    graph.scrollTop += event.deltaY;
    return;
  }
  event.preventDefault();
  const nextZoom = flowZoom * Math.exp(-event.deltaY * 0.001);
  if (nextZoom === flowZoom) return;
  setFlowZoom(nextZoom, { x: event.clientX, y: event.clientY });
}, { passive: false });
let resizeTimer;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (!data) return; render(data); fitFlowGraph(); }, 100); });

document.querySelectorAll('[data-flow-view]').forEach((link) => link.addEventListener('click', (event) => { if (sendToEditor({ type: 'scene-flow:view', view: link.dataset.flowView })) event.preventDefault(); }));
document.querySelectorAll('[data-flow-action]').forEach((button) => button.addEventListener('click', () => {
  const action = button.dataset.flowAction;
  if (action === 'editor') { if (!sendToEditor({ type: 'scene-flow:view', view: 'explorer' })) window.location.href = '/'; }
  if (action === 'toggle-details') document.querySelector('.details')?.classList.toggle('is-hidden');
  if (action === 'help' && !sendToEditor({ type: 'scene-flow:help' })) window.location.href = '/?help=language';
  if (action === 'fit') fitFlowGraph();
  if (action === 'auto-layout' && data) {
    savedFolderOffsets = {};
    try { if (layoutStorageKey) localStorage.setItem(layoutStorageKey, '{}'); } catch { /* storage can be disabled */ }
    flowZoom = 1;
    render(data);
    fitFlowGraph();
  }
}));

const filterPanel = document.createElement('div');
filterPanel.className = 'flow-filters';
filterPanel.innerHTML = '<label>Filter <input id="flow-search" type="search" placeholder="scene or diagnostic" autocomplete="off"></label><label class="flow-check"><input id="show-includes" type="checkbox"> show include relations</label>';
document.querySelector('.controls h1')?.after(filterPanel);
const flowTestPanel = document.createElement('section');
flowTestPanel.className = 'flow-test-panel';
flowTestPanel.innerHTML = '<h2>ここからテスト</h2><div id="flow-test-file" class="flow-test-file">ノードを選択</div><label class="flow-test-field">開始scene<select id="flow-test-scene"></select></label><label class="flow-test-field">開始行<span class="flow-test-line-controls"><input id="flow-test-line" type="text" inputmode="numeric" autocomplete="off"><button id="flow-test-pick-line" type="button" aria-label="編集画面で開始行を選ぶ" title="編集画面で開始行を選ぶ">&gt;</button></span></label><div class="flow-test-subtitle">実行時点の変数 <span>確定値は自動適用</span></div><div id="flow-test-vars"></div><button id="flow-test-run" type="button">ここから再生</button><div id="flow-test-message" role="status"></div>';
filterPanel.after(flowTestPanel);
const flowTestScene = document.querySelector('#flow-test-scene');
const flowTestLine = document.querySelector('#flow-test-line');
const flowTestVars = document.querySelector('#flow-test-vars');
let flowDomainRequest = 0;
let flowDomains = {};
let flowTestSelectionKey = '';
let flowTestVariableDefinitions = new Map();
const flowVariableDrafts = new Map();
function confirmedFlowDomain(name) {
  const found = flowDomains[name];
  return found?.kind === 'exact' && Array.isArray(found.values) && found.values.length === 1 ? found : null;
}
function displayFlowDomainValue(variable, value) {
  if (variable.type === 'str') return JSON.stringify(value);
  if (variable.fields) {
    try {
      const object = JSON.parse(value);
      if (object && typeof object === 'object' && !Array.isArray(object)) {
        return `{${Object.entries(variable.fields).map(([name, type]) => `${name}: ${type === 'str' ? JSON.stringify(object[name] ?? '') : object[name] ?? ''}`).join(', ')}}`;
      }
    } catch {}
  }
  return String(value);
}
function renderFlowTestVariables() {
  flowTestVars.replaceChildren();
  const definitions = [...flowTestVariableDefinitions.values()];
  const confirmed = definitions.filter((variable) => confirmedFlowDomain(variable.name));
  const uncertain = definitions.filter((variable) => !confirmedFlowDomain(variable.name));
  if (confirmed.length) {
    const group = document.createElement('section'); group.className = 'flow-test-group flow-test-confirmed-group';
    const heading = document.createElement('div'); heading.className = 'flow-test-group-heading'; heading.textContent = '確定値'; group.append(heading);
    const list = document.createElement('div'); list.className = 'flow-test-confirmed-list';
    for (const variable of confirmed) {
      const value = displayFlowDomainValue(variable, confirmedFlowDomain(variable.name).values[0]);
      const row = document.createElement('span'); row.className = 'flow-test-confirmed'; row.dataset.name = variable.name; row.dataset.domainKind = 'exact';
      const name = document.createElement('span'); name.className = 'flow-test-confirmed-name'; name.textContent = `${variable.name} = `;
      const result = document.createElement('span'); result.className = 'flow-test-confirmed-value'; result.textContent = value; result.title = value;
      row.append(name, result); list.append(row);
    }
    group.append(list);
    flowTestVars.append(group);
  }
  if (uncertain.length) {
    const group = document.createElement('section'); group.className = 'flow-test-group flow-test-uncertain-group';
    const heading = document.createElement('div'); heading.className = 'flow-test-group-heading'; heading.textContent = '初期値を指定（不確定）'; group.append(heading);
    const drafts = flowVariableDrafts.get(flowTestSelectionKey) || new Map();
    for (const variable of uncertain) {
      const found = flowDomains[variable.name] || { kind: 'unknown', values: [] };
      const row = document.createElement('label'); row.className = 'flow-test-variable';
      const name = document.createElement('span'); name.textContent = `${variable.name} : ${variable.type}`;
      const info = document.createElement('small'); info.className = 'flow-test-domain';
      const values = found.values.map((value) => displayFlowDomainValue(variable, value));
      info.textContent = found.kind === 'finite' ? `候補 ${values.length}: ${values.slice(0, 4).join(' / ')}${values.length > 4 ? ' …' : ''}` : '不明';
      info.title = found.kind === 'finite' ? values.join(' / ') : '値を特定できないため、開始値を指定できます';
      const input = document.createElement('input'); input.type = 'text'; input.autocomplete = 'off'; input.dataset.name = variable.name; input.dataset.type = variable.type; input.dataset.domainKind = found.kind; input.dataset.domainValues = JSON.stringify(found.values); input.placeholder = '変更しない場合は空欄';
      if (variable.fields) input.dataset.fields = JSON.stringify(variable.fields);
      input.value = drafts.get(variable.name) || '';
      row.append(name, info, input); group.append(row);
    }
    flowTestVars.append(group);
  }
  if (!definitions.length) flowTestVars.textContent = '変更が必要な変数はありません';
}
async function refreshFlowDomains(node, scene, line, names) {
  const requestId = ++flowDomainRequest;
  flowDomains = {};
  const run = document.querySelector('#flow-test-run');
  if (!node || !scene || !names.length) return;
  run.disabled = true;
  try {
    const query = new URLSearchParams({ file: node.id, scene: scene.name, line: String(line), names: names.join(',') });
    const response = await fetch(`/api/flow-domains?${query}`, { cache: 'no-store' });
    const result = await response.json();
    if (!response.ok) throw Error(result.error || '値集合を解析できませんでした');
    if (requestId !== flowDomainRequest) return;
    flowDomains = result.domains || {};
    renderFlowTestVariables();
    run.disabled = false;
  } catch (error) {
    if (requestId !== flowDomainRequest) return;
    flowDomains = Object.fromEntries(names.map((name) => [name, { kind: 'unknown', values: [] }]));
    renderFlowTestVariables();
    document.querySelector('#flow-test-message').textContent = error.message;
    run.disabled = false;
  }
}
function updateFlowTestPanel() {
  if (!flowTestPanel || !data) return;
  const node = data.nodes.find((item) => item.id === selected);
  document.querySelector('#flow-test-file').textContent = node?.id || 'ノードを選択';
  const previousScene = flowTestScene.value;
  const previousLine = flowTestLine.value;
  const previousValues = new Map([...flowTestVars.querySelectorAll('input[data-name]')].map((input) => [input.dataset.name, input.value]));
  if (flowTestSelectionKey) {
    const saved = new Map(flowVariableDrafts.get(flowTestSelectionKey) || []);
    for (const [name, value] of previousValues) saved.set(name, value);
    flowVariableDrafts.set(flowTestSelectionKey, saved);
  }
  flowTestScene.replaceChildren();
  for (const scene of node?.sceneLocations || []) {
    const option = document.createElement('option'); option.value = scene.name; option.textContent = scene.name; flowTestScene.append(option);
  }
  if ([...flowTestScene.options].some((option) => option.value === previousScene)) flowTestScene.value = previousScene;
  const selectedScene = node?.sceneLocations?.find((scene) => scene.name === flowTestScene.value) || node?.sceneLocations?.[0];
  const selectionKey = selectedScene ? `${node.id}\0${selectedScene.name}` : '';
  const sameSelection = selectionKey === flowTestSelectionKey;
  flowTestLine.value = sameSelection ? previousLine : selectedScene?.line || '';
  flowTestSelectionKey = selectionKey;
  flowTestLine.min = selectedScene?.line || 1;
  flowTestLine.max = selectedScene?.endLine || '';
  ++flowDomainRequest;
  flowDomains = {};
  flowTestVars.replaceChildren();
  const line = flowTestLine.value === '' ? null : Number(flowTestLine.value);
  const validLine = line === null || Boolean(selectedScene && Number.isSafeInteger(line) && line >= selectedScene.line && line <= selectedScene.endLine);
  const cutoff = line === null || !validLine ? selectedScene?.line || 1 : line;
  const variables = (node?.variables || []).filter((variable) => {
    const type = variableTypeLabel(variable.type);
    const structure = variable.type?.kind === 'struct' && (node.structTypes?.find((item) => item.name === variable.type.name)
      || node.characterTypes?.find((item) => item.name === variable.type.name));
    if (!['int', 'str', 'dict<int>', 'dict<str>'].includes(type) && !structure) return false;
    if (!variable.mutable) return false;
    if (variable.scope !== 'global' && !(variable.definitions || []).some((definition) => (definition.file || node.id) === node.id && Number(definition.line || 0) < cutoff)) return false;
    return (variable.references || []).some((reference) => (reference.file || node.id) === node.id && Number(reference.line || 0) >= cutoff);
  });
  const seen = new Set();
  flowTestVariableDefinitions = new Map();
  for (const variable of variables) {
    if (seen.has(variable.name)) continue;
    seen.add(variable.name);
    const definition = { name: variable.name, type: variableTypeLabel(variable.type) };
    if (variable.type?.kind === 'struct') {
      const fields = node.structTypes?.find((item) => item.name === variable.type.name)?.fields
        || node.characterTypes?.find((item) => item.name === variable.type.name)?.fields;
      if (fields) definition.fields = fields;
    }
    flowTestVariableDefinitions.set(variable.name, definition);
  }
  if (!seen.size) flowTestVars.textContent = '変更が必要な変数はありません';
  else flowTestVars.textContent = '解析中…';
  document.querySelector('#flow-test-run').disabled = !selectedScene || !validLine;
  document.querySelector('#flow-test-message').textContent = validLine ? '' : `${selectedScene?.line || 1}〜${selectedScene?.endLine || 1}行から指定してください`;
  if (selectedScene && validLine) sendToEditor({ type: 'scene-flow:start-line-preview', file: node.id, scene: selectedScene.name, line: cutoff });
  if (seen.size && selectedScene && validLine) refreshFlowDomains(node, selectedScene, cutoff, [...seen]);
}
flowTestScene.addEventListener('change', updateFlowTestPanel);
flowTestLine.addEventListener('input', () => {
  updateFlowTestPanel();
  const node = data?.nodes.find((item) => item.id === selected);
  const scene = node?.sceneLocations?.find((item) => item.name === flowTestScene.value);
  const line = Number(flowTestLine.value);
  if (node && scene && Number.isSafeInteger(line) && line >= scene.line && line <= scene.endLine) {
    sendToEditor({ type: 'scene-flow:start-line-preview', file: node.id, scene: scene.name, line });
  }
});
document.querySelector('#flow-test-pick-line').addEventListener('click', () => {
  const node = data?.nodes.find((item) => item.id === selected);
  const scene = node?.sceneLocations?.find((item) => item.name === flowTestScene.value);
  if (node && scene) {
    sendToEditor({ type: 'scene-flow:pick-line', file: node.id, scene: scene.name, startLine: scene.line, endLine: scene.endLine });
  }
});
flowTestVars.addEventListener('input', (event) => {
  if (!event.target.matches('input[data-name]') || !flowTestSelectionKey) return;
  const draft = flowVariableDrafts.get(flowTestSelectionKey) || new Map();
  draft.set(event.target.dataset.name, event.target.value);
  flowVariableDrafts.set(flowTestSelectionKey, draft);
});
document.querySelector('#flow-test-run').addEventListener('click', () => {
  const node = data?.nodes.find((item) => item.id === selected);
  if (!node) return;
  const scene = node.sceneLocations?.find((item) => item.name === flowTestScene.value);
  const line = flowTestLine.value === '' ? null : Number(flowTestLine.value);
  const message = document.querySelector('#flow-test-message');
  if (line !== null && (!Number.isSafeInteger(line) || !scene || line < scene.line || line > scene.endLine)) { message.textContent = '選択したscene内の行を指定してください'; return; }
  const variables = {};
  for (const definition of flowTestVariableDefinitions.values()) {
    const exact = confirmedFlowDomain(definition.name);
    // Confirmed values are authoritative and read-only. Only controls in the
    // uncertain group can override a start value, even if stale DOM remains.
    const input = exact ? null : flowTestVars.querySelector(`.flow-test-uncertain-group input[data-name="${CSS.escape(definition.name)}"]`);
    const valueText = exact ? exact.values[0] : input?.value ? input.value : null;
    if (valueText === null) continue;
    if (definition.type === 'int' && !/^[+-]?\d+$/.test(valueText)) { message.textContent = `${definition.name} は整数で入力してください`; input?.focus(); return; }
    if (definition.type.startsWith('dict<')) {
      let value;
      try { value = JSON.parse(valueText); } catch { message.textContent = `${definition.name} はJSON辞書で入力してください`; input?.focus(); return; }
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.values(value).some((entry) => definition.type === 'dict<int>' ? !(Number.isSafeInteger(entry) || (typeof entry === 'string' && /^[+-]?\d+$/.test(entry))) : typeof entry !== 'string')) { message.textContent = `${definition.name} の値の型が正しくありません`; input?.focus(); return; }
    }
    if (definition.fields) {
      let value;
      try { value = JSON.parse(valueText); } catch { message.textContent = `${definition.name} はJSON構造体で入力してください`; input?.focus(); return; }
      const fields = definition.fields;
      const matches = value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === Object.keys(fields).length
        && Object.entries(fields).every(([name, type]) => type === 'int'
          ? Number.isSafeInteger(value[name]) || (typeof value[name] === 'string' && /^[+-]?\d+$/.test(value[name]))
          : typeof value[name] === 'string');
      if (!matches) { message.textContent = `${definition.name} のフィールドが型と一致しません`; input?.focus(); return; }
    }
    variables[definition.name] = { type: definition.fields ? 'struct' : definition.type, value: valueText, ...(definition.fields ? { fields: definition.fields } : {}) };
  }
  if (!sendToEditor({ type: 'scene-flow:debug-play', file: node.id, scene: scene?.name, line, variables })) { message.textContent = '編集画面内のシーンフローから実行してください'; return; }
  message.textContent = '再生を準備しています…';
});
document.querySelector('#flow-search')?.addEventListener('input', (event) => { flowFilter.query = event.target.value; if (data) { render(data); fitFlowGraph(); } });
document.querySelector('#show-includes')?.addEventListener('change', (event) => { flowFilter.showIncludes = event.target.checked; if (data) { render(data); fitFlowGraph(); } });
