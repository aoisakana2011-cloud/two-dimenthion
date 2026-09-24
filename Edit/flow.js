const graph = document.querySelector('#graph');
const details = document.querySelector('#details');
const status = document.querySelector('#status');
const flowCount = document.querySelector('#flow-count');
let data = null;
let selected = '';
let rangePicker = null;
let layoutStorageKey = '';
let savedFolderOffsets = {};
let panState = null;
let dragState = null;
let flowZoom = 1;
const flowFilter = { query: '', showIncludes: true };
function sendToEditor(message) {
  if (window.parent === window) return false;
  window.parent.postMessage(message, location.origin);
  return true;
}
window.setFlowRangePicker = (target) => { rangePicker = target; };

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
  const picker = rangePicker ? document.querySelector(`#${rangePicker}`) : null;
  if (picker) {
    picker.value = file;
    window.updateFlowPicker?.(rangePicker);
  }
  document.querySelectorAll('.flow-node').forEach((node) => node.classList.toggle('selected', node.dataset.file === file));
  details.replaceChildren();
  const heading = document.createElement('div'); heading.className = 'detail-title'; heading.textContent = file;
  details.append(heading);
  detailGroup('転移元', data.edges.filter((edge) => edge.to === file).map((edge) => edge.from));
  detailGroup('転移先', data.edges.filter((edge) => edge.from === file).map((edge) => edge.to));
  const node = data.nodes.find((item) => item.id === file);
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

window.showFlowValidation = (report) => {
  const route = report.path || [];
  const path = new Set(route);
  const checked = new Set(report.checked || []);
  const errorFiles = new Set((report.errors || []).map((error) => error.file));
  document.querySelectorAll('.flow-node').forEach((node) => {
    const file = node.dataset.file;
    node.classList.toggle('validation-path', path.has(file));
    node.classList.toggle('validation-checked', checked.has(file) && !path.has(file));
    node.classList.toggle('validation-error', errorFiles.has(file));
  });
  document.querySelectorAll('.flow-edge').forEach((edge) => {
    const from = edge.dataset.from, to = edge.dataset.to;
    edge.classList.toggle('validation-path', route.some((file, index) => file === from && route[index + 1] === to));
  });
  if (route.length) window.selectFlowNode(route[0]);
};

function folderDepths(folders, edges) {
  const depths = new Map(folders.map((folder) => [folder, 0]));
  const folderEdges = edges.map((edge) => [folderOf(edge.from), folderOf(edge.to)]).filter(([from, to]) => from !== to);
  for (let pass = 0; pass < folders.length; pass++) {
    let changed = false;
    for (const [from, to] of folderEdges) {
      const next = Math.min(folders.length - 1, (depths.get(from) || 0) + 1);
      if (next > (depths.get(to) || 0)) { depths.set(to, next); changed = true; }
    }
    if (!changed) break;
  }
  return depths;
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
  const topFolders = [...tree.children.values()];
  const topFolderOf = (file) => {
    const folder = folderOf(file);
    return folder === '(root)' ? folder : folder.split('/')[0];
  };
  const topEdges = view.edges.map((edge) => ({ from: topFolderOf(edge.from), to: topFolderOf(edge.to) }));
  const depths = folderDepths(topFolders.map((folder) => folder.path), topEdges);
  const columns = new Map();
  topFolders.forEach((folder) => {
    const depth = depths.get(folder.path) || 0;
    if (!columns.has(depth)) columns.set(depth, []);
    columns.get(depth).push(folder);
  });

  const folderWidth = 214, folderGapX = 100, folderGapY = 30, nodeHeight = 36, nodeGap = 6, headerHeight = 27, padding = 42;
  const folderPositions = new Map(), nodePositions = new Map();
  const measureFolder = (folder, depth) => {
    folder.width = Math.max(132, folderWidth - depth * 18);
    folder.nodes.sort((a, b) => a.id.localeCompare(b.id));
    const children = [...folder.children.values()].sort((a, b) => a.path.localeCompare(b.path, 'ja'));
    children.forEach((child) => measureFolder(child, depth + 1));
    const nodesHeight = folder.nodes.length * nodeHeight + Math.max(0, folder.nodes.length - 1) * nodeGap;
    const childrenHeight = children.reduce((sum, child, index) => sum + child.height + (index ? 10 : 0), 0);
    folder.height = headerHeight + 10 + nodesHeight + (nodesHeight && childrenHeight ? 10 : 0) + childrenHeight + 10;
  };
  topFolders.forEach((folder) => measureFolder(folder, 0));
  const placeFolder = (folder, x, y, depth) => {
    folderPositions.set(folder.path, { x, y, width: folder.width, height: folder.height, folder });
    let cursor = y + headerHeight + 10;
    folder.nodes.forEach((node, index) => {
      nodePositions.set(node.id, { x: x + 12, y: cursor + index * (nodeHeight + nodeGap), width: folder.width - 24 });
    });
    cursor += folder.nodes.length * nodeHeight + Math.max(0, folder.nodes.length - 1) * nodeGap;
    if (folder.nodes.length && folder.children.size) cursor += 10;
    [...folder.children.values()].sort((a, b) => a.path.localeCompare(b.path, 'ja')).forEach((child) => {
      placeFolder(child, x + 12, cursor, depth + 1);
      cursor += child.height + 10;
    });
  };
  let totalHeight = padding;
  for (const [depth, columnFolders] of columns) {
    let y = padding;
    columnFolders.sort((a, b) => a.path.localeCompare(b.path, 'ja')).forEach((folder) => {
      const x = padding + depth * (folderWidth + folderGapX);
      placeFolder(folder, x, y, 0);
      y += folder.height + folderGapY;
    });
    totalHeight = Math.max(totalHeight, y);
  }
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
  const maxDepth = Math.max(0, ...columns.keys());
  const width = Math.max(graph.clientWidth, padding * 2 + (maxDepth + 1) * folderWidth + maxDepth * folderGapX, ...[...folderPositions.values()].map((position) => position.x + position.width + padding));
  const height = Math.max(graph.clientHeight, totalHeight + padding - folderGapY, ...[...folderPositions.values()].map((position) => position.y + position.height + padding));
  const root = svg('svg', { class: 'flow-svg', width, height, viewBox: `0 0 ${width} ${height}` });
  root.style.transformOrigin = '0 0';
  if (flowZoom !== 1) root.style.transform = `scale(${flowZoom})`;
  const defs = svg('defs');
  const marker = svg('marker', { id: 'arrow', markerWidth: 8, markerHeight: 8, refX: 7, refY: 3, orient: 'auto' });
  marker.append(svg('path', { d: 'M0 0v6l7-3z', class: 'flow-arrow' })); defs.append(marker); root.append(defs);

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
    view.edges.forEach((edge) => {
    const from = nodePositions.get(edge.from), to = nodePositions.get(edge.to); if (!from || !to) return;
    if (folderOf(edge.from) === folderOf(edge.to)) {
      const x1 = from.x + from.width, y1 = from.y + nodeHeight / 2, x2 = to.x + to.width, y2 = to.y + nodeHeight / 2;
      const loop = 52 + Math.abs(y2 - y1) * 0.18;
      const path = svg('path', { d: `M${x1} ${y1}C${x1 + loop} ${y1} ${x2 + loop} ${y2} ${x2} ${y2}`, class: `flow-edge folder-edge ${edge.kind === 'include' ? 'include-edge' : ''}`, 'marker-end': 'url(#arrow)' }); path.dataset.from = edge.from; path.dataset.to = edge.to; edgeLayer.append(path);
      return;
    }
    const x1 = from.x + from.width, y1 = from.y + nodeHeight / 2, x2 = to.x, y2 = to.y + nodeHeight / 2, offset = Math.max(35, Math.abs(x2 - x1) / 2);
    const path = svg('path', { d: `M${x1} ${y1}C${x1 + offset} ${y1} ${x2 - offset} ${y2} ${x2} ${y2}`, class: `flow-edge ${edge.kind === 'include' ? 'include-edge' : ''}`, 'marker-end': 'url(#arrow)' }); path.dataset.from = edge.from; path.dataset.to = edge.to; edgeLayer.append(path);
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
    const name = svg('text', { x: 11, y: 22 }); name.textContent = fileLabel(node.id); item.append(name);
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
    const dx = current.x - dragState.startX, dy = current.y - dragState.startY;
    if (Math.abs(dx) + Math.abs(dy) > 2) dragState.moved = true;
    if (!dragState.moved) return;
    dragState.dx = dx; dragState.dy = dy;
    dragState.items.forEach(({ element, position, x, y }) => {
      position.x = x + dx; position.y = y + dy;
      element?.setAttribute('transform', `translate(${position.x} ${position.y})`);
    });
    drawEdges();
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
  if (event.data?.type === 'scene-flow:refresh') refreshFlowGraph().catch(showFlowLoadError);
});
fetch('/api/project', { cache: 'no-store' }).then((response) => response.ok ? response.json() : {}).catch(() => ({})).then((project) => {
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
  const rect = graph.getBoundingClientRect();
  const x = event.clientX - rect.left, y = event.clientY - rect.top;
  const nextZoom = Math.max(0.45, Math.min(2.5, flowZoom * Math.exp(-event.deltaY * 0.001)));
  if (nextZoom === flowZoom) return;
  const factor = nextZoom / flowZoom;
  root.style.transformOrigin = '0 0'; root.style.transform = `scale(${nextZoom})`;
  graph.scrollLeft = (graph.scrollLeft + x) * factor - x;
  graph.scrollTop = (graph.scrollTop + y) * factor - y;
  flowZoom = nextZoom;
}, { passive: false });
let resizeTimer;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => data && render(data), 100); });

document.querySelectorAll('[data-flow-view]').forEach((link) => link.addEventListener('click', (event) => { if (sendToEditor({ type: 'scene-flow:view', view: link.dataset.flowView })) event.preventDefault(); }));
document.querySelectorAll('[data-flow-action]').forEach((button) => button.addEventListener('click', () => { const action = button.dataset.flowAction; if (action === 'editor') { if (!sendToEditor({ type: 'scene-flow:view', view: 'explorer' })) window.location.href = '/'; } if (action === 'validate') document.querySelector('#validate')?.click(); if (action === 'toggle-details') document.querySelector('.details')?.classList.toggle('is-hidden'); if (action === 'help' && !sendToEditor({ type: 'scene-flow:help' })) window.location.href = '/?help=language'; }));

const filterPanel = document.createElement('div');
filterPanel.className = 'flow-filters';
filterPanel.innerHTML = '<label>Filter <input id="flow-search" type="search" placeholder="scene or diagnostic" autocomplete="off"></label><label class="flow-check"><input id="show-includes" type="checkbox" checked> show include relations</label>';
document.querySelector('.controls .range')?.before(filterPanel);
document.querySelector('#flow-search')?.addEventListener('input', (event) => { flowFilter.query = event.target.value; if (data) render(data); });
document.querySelector('#show-includes')?.addEventListener('change', (event) => { flowFilter.showIncludes = event.target.checked; if (data) render(data); });
