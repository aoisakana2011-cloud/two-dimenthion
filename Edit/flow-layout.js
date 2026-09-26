'use strict';

(function exposeFlowLayout(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FlowLayout = api;
})(typeof globalThis === 'undefined' ? this : globalThis, () => {
  function layerFolders(folderIds, edges) {
    const ids = [...new Set(folderIds)];
    const order = new Map(ids.map((id, index) => [id, index]));
    const known = new Set(ids);
    const adjacency = new Map(ids.map((id) => [id, new Set()]));
    for (const edge of edges || []) {
      if (known.has(edge.from) && known.has(edge.to) && edge.from !== edge.to) adjacency.get(edge.from).add(edge.to);
    }

    let nextIndex = 0;
    const indexes = new Map(), lowLinks = new Map(), stack = [], onStack = new Set(), components = [];
    const visit = (id) => {
      indexes.set(id, nextIndex); lowLinks.set(id, nextIndex); nextIndex++;
      stack.push(id); onStack.add(id);
      for (const target of adjacency.get(id)) {
        if (!indexes.has(target)) { visit(target); lowLinks.set(id, Math.min(lowLinks.get(id), lowLinks.get(target))); }
        else if (onStack.has(target)) lowLinks.set(id, Math.min(lowLinks.get(id), indexes.get(target)));
      }
      if (lowLinks.get(id) !== indexes.get(id)) return;
      const component = [];
      let member;
      do { member = stack.pop(); onStack.delete(member); component.push(member); } while (member !== id);
      component.sort((a, b) => order.get(a) - order.get(b));
      components.push(component);
    };
    ids.forEach((id) => { if (!indexes.has(id)) visit(id); });

    const componentOf = new Map();
    components.forEach((component, index) => component.forEach((id) => componentOf.set(id, index)));
    const componentEdges = components.map(() => new Set());
    const incoming = components.map(() => new Set());
    for (const [from, targets] of adjacency) for (const to of targets) {
      const source = componentOf.get(from), target = componentOf.get(to);
      if (source === target || componentEdges[source].has(target)) continue;
      componentEdges[source].add(target); incoming[target].add(source);
    }

    const componentOrder = components.map((component) => Math.min(...component.map((id) => order.get(id))));
    const remainingIncoming = incoming.map((sources) => new Set(sources));
    const pending = components.map((_, index) => index).filter((index) => remainingIncoming[index].size === 0);
    pending.sort((a, b) => componentOrder[a] - componentOrder[b]);
    const depth = components.map(() => 0), topological = [];
    while (pending.length) {
      const source = pending.shift(); topological.push(source);
      for (const target of componentEdges[source]) {
        depth[target] = Math.max(depth[target], depth[source] + 1);
        remainingIncoming[target].delete(source);
        if (remainingIncoming[target].size === 0) {
          pending.push(target); pending.sort((a, b) => componentOrder[a] - componentOrder[b]);
        }
      }
    }

    const columns = new Map();
    topological.forEach((component) => {
      const layer = depth[component];
      if (!columns.has(layer)) columns.set(layer, []);
      columns.get(layer).push(component);
    });
    const maxLayer = Math.max(0, ...columns.keys());
    const ranks = () => {
      const result = new Map();
      for (const layer of columns.keys()) columns.get(layer).forEach((component, index) => result.set(component, index));
      return result;
    };
    const sweep = (layer, neighborLayer, neighborsFor) => {
      const current = columns.get(layer), neighborRanks = ranks();
      const score = (component) => {
        const neighbors = [...neighborsFor(component)].filter((candidate) => depth[candidate] === neighborLayer);
        if (!neighbors.length) return null;
        return neighbors.reduce((sum, candidate) => sum + neighborRanks.get(candidate), 0) / neighbors.length;
      };
      current.sort((left, right) => {
        const leftScore = score(left), rightScore = score(right);
        if (leftScore === null && rightScore === null) return componentOrder[left] - componentOrder[right];
        if (leftScore === null) return 1;
        if (rightScore === null) return -1;
        return leftScore - rightScore || componentOrder[left] - componentOrder[right];
      });
    };
    for (let pass = 0; pass < 4; pass++) {
      for (let layer = 1; layer <= maxLayer; layer++) sweep(layer, layer - 1, (component) => incoming[component]);
      for (let layer = maxLayer - 1; layer >= 0; layer--) sweep(layer, layer + 1, (component) => componentEdges[component]);
    }

    const orderedColumns = new Map();
    for (const [layer, members] of columns) orderedColumns.set(layer, members.flatMap((component) => components[component]));
    const depthByFolder = new Map();
    ids.forEach((id) => depthByFolder.set(id, depth[componentOf.get(id)]));
    return { columns: orderedColumns, depthByFolder, componentByFolder: componentOf };
  }

  function countCrossings(order, edges) {
    const rank = order instanceof Map ? order : new Map(order.map((id, index) => [id, index]));
    const pairs = (edges || []).filter((edge) => rank.has(edge.from) && rank.has(edge.to))
      .map((edge) => [rank.get(edge.from), rank.get(edge.to)]);
    let crossings = 0;
    for (let i = 0; i < pairs.length; i++) for (let j = i + 1; j < pairs.length; j++) {
      if ((pairs[i][0] - pairs[j][0]) * (pairs[i][1] - pairs[j][1]) < 0) crossings++;
    }
    return crossings;
  }

  function orderNodes(nodeIds, edges, passes = 8) {
    const ids = [...new Set(nodeIds)].sort((a, b) => a.localeCompare(b, 'ja'));
    const members = new Set(ids), outgoing = new Map(ids.map((id) => [id, []])), incoming = new Map(ids.map((id) => [id, []]));
    for (const edge of edges || []) {
      if (!members.has(edge.from) || !members.has(edge.to) || edge.from === edge.to) continue;
      outgoing.get(edge.from).push(edge.to); incoming.get(edge.to).push(edge.from);
    }
    let order = ids;
    const score = (id, neighbors, rank) => {
      const related = neighbors.get(id);
      if (!related.length) return null;
      return related.reduce((sum, other) => sum + rank.get(other), 0) / related.length;
    };
    for (let pass = 0; pass < passes; pass++) {
      for (const neighbors of [incoming, outgoing]) {
        const rank = new Map(order.map((id, index) => [id, index]));
        order = [...order].sort((a, b) => {
          const left = score(a, neighbors, rank), right = score(b, neighbors, rank);
          if (left === null && right === null) return rank.get(a) - rank.get(b);
          if (left === null) return 1;
          if (right === null) return -1;
          return left - right || rank.get(a) - rank.get(b);
        });
      }
    }
    return order;
  }

  function roundedPolylinePath(points, radius = 5) {
    const path = [points[0]];
    for (const point of points.slice(1)) {
      const last = path[path.length - 1];
      if (point.x !== last.x || point.y !== last.y) path.push(point);
    }
    let d = `M${path[0].x} ${path[0].y}`;
    for (let index = 1; index < path.length - 1; index++) {
      const previous = path[index - 1], corner = path[index], next = path[index + 1];
      const inX = corner.x - previous.x, inY = corner.y - previous.y;
      const outX = next.x - corner.x, outY = next.y - corner.y;
      const inLength = Math.hypot(inX, inY), outLength = Math.hypot(outX, outY);
      if (Math.abs(inX * outY - inY * outX) < 1e-6) { d += `L${corner.x} ${corner.y}`; continue; }
      const bend = Math.min(radius, inLength / 2, outLength / 2);
      const before = { x: corner.x - inX / inLength * bend, y: corner.y - inY / inLength * bend };
      const after = { x: corner.x + outX / outLength * bend, y: corner.y + outY / outLength * bend };
      d += `L${before.x} ${before.y}Q${corner.x} ${corner.y} ${after.x} ${after.y}`;
    }
    const end = path[path.length - 1];
    return d + `L${end.x} ${end.y}`;
  }

  function routeEdges(edges, nodePositions, nodeHeight, folderOf, folderPositions = null) {
    const outgoing = new Map(), incoming = new Map(), rightIncoming = new Map(), groups = new Map(), loops = new Map(), backwards = [];
    const get = (map, key) => { if (!map.has(key)) map.set(key, []); return map.get(key); };
    const valid = (edges || []).filter((edge) => nodePositions.has(edge.from) && nodePositions.has(edge.to));
    for (const edge of valid) {
      get(outgoing, edge.from).push(edge); get(incoming, edge.to).push(edge);
      const fromFolder = folderOf(edge.from), toFolder = folderOf(edge.to);
      if (fromFolder === toFolder || nodePositions.get(edge.to).x <= nodePositions.get(edge.from).x) {
        get(rightIncoming, edge.to).push(edge);
      }
      if (fromFolder === toFolder) get(loops, fromFolder).push(edge);
      else {
        const from = nodePositions.get(edge.from), to = nodePositions.get(edge.to);
        if (to.x <= from.x) backwards.push(edge);
        else get(groups, `${fromFolder}\u0000${toFolder}`).push(edge);
      }
    }
    const sorted = (list, key) => list.sort((a, b) => key(a).localeCompare(key(b), 'ja'));
    const edgeKey = (edge) => `${edge.from}\u0000${edge.to}\u0000${edge.kind || ''}`;
    const rankPorts = (list, source) => [...list].sort((a, b) => {
      const aOther = source ? a.to : a.from;
      const bOther = source ? b.to : b.from;
      const aPos = nodePositions.get(aOther), bPos = nodePositions.get(bOther);
      return (aPos.y - bPos.y) || edgeKey(a).localeCompare(edgeKey(b), 'ja');
    });
    const portOffset = (list, edge, source) => {
      const ranked = rankPorts(list, source);
      const index = ranked.indexOf(edge);
      return ranked.length < 2 ? 0 : (index / (ranked.length - 1) - 0.5) * Math.min(nodeHeight - 6, (ranked.length - 1) * 4.5);
    };
    const sharedSourcePorts = new Map(), sharedTargetPorts = new Map();
    for (const [file, arriving] of rightIncoming) {
      const leaving = outgoing.get(file);
      if (!leaving?.length) continue;
      const incomingOrder = rankPorts(arriving, false), outgoingOrder = rankPorts(leaving, true);
      const count = incomingOrder.length + outgoingOrder.length;
      const spacing = Math.min(12, (nodeHeight - 8) / (count - 1));
      const first = -spacing * (count - 1) / 2;
      incomingOrder.forEach((edge, index) => sharedTargetPorts.set(edge, first + index * spacing));
      outgoingOrder.forEach((edge, index) => sharedSourcePorts.set(edge, first + (incomingOrder.length + index) * spacing));
    }
    for (const list of outgoing.values()) sorted(list, (edge) => edge.to);
    for (const list of incoming.values()) sorted(list, (edge) => edge.from);
    for (const list of groups.values()) list.sort((a, b) => {
      const fromDelta = nodePositions.get(a.from).y - nodePositions.get(b.from).y;
      return fromDelta || (nodePositions.get(a.to).y - nodePositions.get(b.to).y) || edgeKey(a).localeCompare(edgeKey(b), 'ja');
    });
    for (const list of loops.values()) sorted(list, edgeKey);
    backwards.sort((a, b) => edgeKey(a).localeCompare(edgeKey(b), 'ja'));
    const maxRight = Math.max(0, ...[...nodePositions.values()].map((position) => position.x + position.width));
    const topFolder = (file) => {
      const folder = folderOf(file);
      return folder === '(root)' ? folder : folder.split('/')[0];
    };
    const obstacles = folderPositions ? [...folderPositions].filter(([id]) => id === '(root)' || !id.includes('/')) : [];
    const routes = new Map();
    for (const edge of valid) {
      const from = nodePositions.get(edge.from), to = nodePositions.get(edge.to);
      const x1 = from.x + from.width;
      const sameFolder = folderOf(edge.from) === folderOf(edge.to);
      const isBackward = !sameFolder && to.x <= from.x;
      const x2 = sameFolder || isBackward ? to.x + to.width : to.x;
      const sourceOffset = sharedSourcePorts.get(edge) ?? portOffset(outgoing.get(edge.from), edge, true);
      const targetOffset = sharedTargetPorts.get(edge) ?? portOffset(incoming.get(edge.to), edge, false);
      const sourceCenterY = from.y + nodeHeight / 2, targetCenterY = to.y + nodeHeight / 2;
      const y1 = sourceCenterY + sourceOffset, y2 = targetCenterY + targetOffset;
      let points, type;
      if (sameFolder) {
        const list = loops.get(folderOf(edge.from)), lane = list.indexOf(edge);
        const channel = 38 + lane * 13 + Math.min(80, Math.abs(y2 - y1) * 0.06);
        const right = Math.max(x1, x2) + channel;
        const selfLoop = edge.from === edge.to;
        const lift = selfLoop ? 28 + lane * 8 : 0;
        points = selfLoop
          ? [{ x: x1, y: y1 }, { x: right, y: y1 }, { x: right, y: y2 - lift }, { x: x1 + 12, y: y2 - lift }, { x: x1 + 12, y: y2 }, { x: x1, y: y2 }]
          : [{ x: x1, y: y1 }, { x: right, y: y1 }, { x: right, y: y2 }, { x: x2, y: y2 }];
        type = 'loop';
      } else if (isBackward) {
        const lane = backwards.indexOf(edge), channel = maxRight + 42 + lane * 14;
        points = [{ x: x1, y: y1 }, { x: channel, y: y1 }, { x: channel, y: y2 }, { x: x2, y: y2 }];
        type = 'return';
      } else {
        const list = groups.get(`${folderOf(edge.from)}\u0000${folderOf(edge.to)}`), lane = list.indexOf(edge);
        const bend = (lane - (list.length - 1) / 2) * 9, dx = x2 - x1;
        const channel = dx > 12 ? Math.max(x1 + 6, Math.min(x2 - 6, x1 + dx / 2 + bend)) : x1 + dx / 2;
        points = [{ x: x1, y: y1 }, { x: channel, y: y1 }, { x: channel, y: y2 }, { x: x2, y: y2 }];
        type = 'forward';
        if (obstacles.length && dx > 30) {
          const unrelated = obstacles.filter(([id, rect]) => id !== topFolder(edge.from) && id !== topFolder(edge.to)
            && rect.x < x2 && rect.x + rect.width > x1);
          const blocked = unrelated.some(([, rect]) => points.slice(1).some((point, index) =>
            segmentIntersectsRect(points[index], point, rect, 7)));
          if (blocked) {
            const departureX = x1 + Math.min(18, dx / 4);
            const arrivalX = x2 - Math.min(18, dx / 4);
            const between = unrelated.map(([, rect]) => rect).filter((rect) => rect.x < arrivalX && rect.x + rect.width > departureX);
            if (between.length) {
              const above = Math.min(...between.map((rect) => rect.y)) - 16;
              const below = Math.max(...between.map((rect) => rect.y + rect.height)) + 16;
              const guideY = Math.abs(y1 - above) + Math.abs(y2 - above) + Math.max(0, 16 - above) * .5
                <= Math.abs(y1 - below) + Math.abs(y2 - below) ? above : below;
              points = [{ x: x1, y: y1 }, { x: departureX, y: y1 }, { x: departureX, y: guideY },
                { x: arrivalX, y: guideY }, { x: arrivalX, y: y2 }, { x: x2, y: y2 }];
              type = 'detour';
            }
          }
        }
      }
      const d = roundedPolylinePath(points);
      const bounds = {
        left: Math.min(...points.map((point) => point.x)), top: Math.min(...points.map((point) => point.y)),
        right: Math.max(...points.map((point) => point.x)), bottom: Math.max(...points.map((point) => point.y)),
      };
      routes.set(edge, { d, type, bounds, x1, y1, x2, y2, sourceOffset, targetOffset });
    }
    return routes;
  }

  function normalizeBounds(folderPositions, nodePositions, edges, nodeHeight, padding, folderOf, normalize = true) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const include = (left, top, right, bottom) => {
      minX = Math.min(minX, left); minY = Math.min(minY, top);
      maxX = Math.max(maxX, right); maxY = Math.max(maxY, bottom);
    };
    for (const position of folderPositions.values()) include(position.x, position.y, position.x + position.width, position.y + position.height);
    for (const position of nodePositions.values()) include(position.x, position.y, position.x + position.width, position.y + nodeHeight);
    for (const route of routeEdges(edges, nodePositions, nodeHeight, folderOf, folderPositions).values()) {
      include(route.bounds.left, route.bounds.top, route.bounds.right, route.bounds.bottom);
    }
    if (!Number.isFinite(minX)) return { width: padding * 2, height: padding * 2, shiftX: 0, shiftY: 0 };
    const shiftX = normalize ? padding - minX : 0, shiftY = normalize ? padding - minY : 0;
    for (const position of folderPositions.values()) { position.x += shiftX; position.y += shiftY; }
    for (const position of nodePositions.values()) { position.x += shiftX; position.y += shiftY; }
    return {
      width: Math.ceil(maxX + shiftX + padding),
      height: Math.ceil(maxY + shiftY + padding),
      shiftX,
      shiftY,
    };
  }

  function properSegmentsCross(a, b, c, d) {
    const cross = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
    const abC = cross(a, b, c), abD = cross(a, b, d), cdA = cross(c, d, a), cdB = cross(c, d, b);
    return abC * abD < -1e-6 && cdA * cdB < -1e-6;
  }

  function segmentIntersectsRect(start, end, rect, margin = 4) {
    const left = rect.x - margin, right = rect.x + rect.width + margin;
    const top = rect.y - margin, bottom = rect.y + rect.height + margin;
    const dx = end.x - start.x, dy = end.y - start.y;
    let enter = 0, leave = 1;
    for (const [direction, distance] of [
      [-dx, start.x - left], [dx, right - start.x], [-dy, start.y - top], [dy, bottom - start.y],
    ]) {
      if (Math.abs(direction) < 1e-9) { if (distance < 0) return false; continue; }
      const parameter = distance / direction;
      if (direction < 0) enter = Math.max(enter, parameter);
      else leave = Math.min(leave, parameter);
      if (enter > leave) return false;
    }
    return enter < 1 && leave > 0;
  }

  function folderGeometry(positions, relations) {
    const segments = relations.map((edge) => {
      const from = positions.get(edge.from), to = positions.get(edge.to);
      return {
        ...edge,
        start: { x: from.x + from.width, y: from.y + from.height / 2 },
        end: { x: to.x <= from.x ? to.x + to.width : to.x, y: to.y + to.height / 2 },
      };
    });
    let verticalDistance = 0, length = 0, obstructions = 0, crossings = 0;
    for (const segment of segments) {
      verticalDistance += Math.abs(segment.end.y - segment.start.y);
      length += Math.hypot(segment.end.x - segment.start.x, segment.end.y - segment.start.y);
      for (const [id, rect] of positions) {
        if (id !== segment.from && id !== segment.to && segmentIntersectsRect(segment.start, segment.end, rect)) obstructions++;
      }
    }
    for (let index = 0; index < segments.length; index++) for (let other = index + 1; other < segments.length; other++) {
      const a = segments[index], b = segments[other];
      if (a.from === b.from || a.from === b.to || a.to === b.from || a.to === b.to) continue;
      if (properSegmentsCross(a.start, a.end, b.start, b.end)) crossings++;
    }
    const bottom = Math.max(0, ...[...positions.values()].map((rect) => rect.y + rect.height));
    return { verticalDistance, length, obstructions, crossings, bottom };
  }

  function refineFolderVerticalPositions(folders, relations, initialPositions, gap = 30, padding = 42) {
    const positions = new Map([...initialPositions].map(([id, rect]) => [id, { ...rect }]));
    const originals = new Map([...positions].map(([id, rect]) => [id, rect.y]));
    const edges = [...new Map((relations || []).filter((edge) => positions.has(edge.from) && positions.has(edge.to) && edge.from !== edge.to)
      .map((edge) => [`${edge.from}\u0000${edge.to}`, edge])).values()];
    const geometryBefore = folderGeometry(positions, edges);
    const cost = () => {
      const metrics = folderGeometry(positions, edges);
      const displacement = [...positions].reduce((sum, [id, rect]) => sum + Math.abs(rect.y - originals.get(id)), 0);
      return metrics.verticalDistance + metrics.length * .18 + metrics.obstructions * 250
        + metrics.crossings * 120 + metrics.bottom * .12 + displacement * .02;
    };
    const ordered = [...folders].sort((a, b) => {
      const degree = (id) => edges.reduce((count, edge) => count + (edge.from === id || edge.to === id ? 1 : 0), 0);
      return degree(b.id) - degree(a.id) || String(a.id).localeCompare(String(b.id), 'ja');
    });
    const limit = Math.max(...[...positions.values()].map((rect) => rect.y + rect.height))
      + Math.max(...folders.map((folder) => folder.height)) + gap;
    for (let pass = 0; pass < 6; pass++) {
      let changed = false;
      for (const folder of ordered) {
        const rect = positions.get(folder.id), original = rect.y;
        const candidates = new Set([original, originals.get(folder.id), padding]);
        for (const edge of edges) {
          const neighborId = edge.from === folder.id ? edge.to : edge.to === folder.id ? edge.from : null;
          if (!neighborId) continue;
          const neighbor = positions.get(neighborId);
          candidates.add(neighbor.y + (neighbor.height - rect.height) / 2);
        }
        for (const [id, other] of positions) {
          if (id === folder.id) continue;
          candidates.add(other.y + other.height + gap);
          candidates.add(other.y - rect.height - gap);
        }
        let bestY = original, bestCost = cost();
        for (const candidate of candidates) {
          const y = Math.max(padding, Math.round(candidate));
          if (y > limit || y === original) continue;
          const overlaps = [...positions].some(([id, other]) => id !== folder.id
            && rect.x < other.x + other.width + gap && other.x < rect.x + rect.width + gap
            && y < other.y + other.height + gap && other.y < y + rect.height + gap);
          if (overlaps) continue;
          rect.y = y;
          const candidateCost = cost();
          if (candidateCost < bestCost - 1e-6) { bestCost = candidateCost; bestY = y; }
        }
        rect.y = bestY;
        if (bestY !== original) changed = true;
      }
      if (!changed) break;
    }
    return { positions, before: geometryBefore, after: folderGeometry(positions, edges) };
  }

  function optimizeFolderGrid(folders, edges, availableWidth, availableHeight, columnGap, rowGap, padding) {
    const items = [...folders];
    if (!items.length) return { columnCount: 1, positions: new Map(), width: padding * 2, height: padding * 2, score: 0, metrics: {}, candidates: [] };
    const known = new Set(items.map((folder) => folder.id));
    const relations = [...new Map((edges || []).filter((edge) => known.has(edge.from) && known.has(edge.to) && edge.from !== edge.to)
      .map((edge) => [`${edge.from}\u0000${edge.to}`, { from: edge.from, to: edge.to }])).values()];
    const maxFolderWidth = Math.max(...items.map((folder) => folder.width));
    const usableWidth = Math.max(1, availableWidth), usableHeight = Math.max(1, availableHeight);
    const candidates = [];
    for (let columnCount = 1; columnCount <= items.length; columnCount++) {
      const positions = new Map(), rows = [];
      let y = padding;
      for (let start = 0, row = 0; start < items.length; start += columnCount, row++) {
        const members = items.slice(start, start + columnCount);
        const rowHeight = Math.max(...members.map((folder) => folder.height));
        members.forEach((folder, index) => {
          const column = row % 2 ? columnCount - 1 - index : index;
          positions.set(folder.id, { x: padding + column * (maxFolderWidth + columnGap), y, width: folder.width, height: folder.height });
        });
        rows.push({ height: rowHeight, members });
        y += rowHeight + (start + columnCount < items.length ? rowGap : 0);
      }
      const usedColumns = Math.min(columnCount, items.length);
      const width = padding * 2 + usedColumns * maxFolderWidth + (usedColumns - 1) * columnGap;
      const height = y + padding;
      const diagonal = Math.max(1, Math.hypot(width, height));
      const centers = new Map([...positions].map(([id, rect]) => [id, { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }]));
      let crossings = 0, edgeLength = 0, backwardEdges = 0;
      const segments = relations.map((edge) => {
        const from = centers.get(edge.from), to = centers.get(edge.to);
        edgeLength += Math.hypot(to.x - from.x, to.y - from.y);
        if (to.x < from.x) backwardEdges++;
        return { ...edge, fromPoint: from, toPoint: to };
      });
      for (let i = 0; i < segments.length; i++) for (let j = i + 1; j < segments.length; j++) {
        const a = segments[i], b = segments[j];
        if (a.from === b.from || a.from === b.to || a.to === b.from || a.to === b.to) continue;
        if (properSegmentsCross(a.fromPoint, a.toPoint, b.fromPoint, b.toPoint)) crossings++;
      }
      const possibleCrossings = segments.length * (segments.length - 1) / 2;
      const crossingRatio = possibleCrossings ? crossings / possibleCrossings : 0;
      const backwardRatio = segments.length ? backwardEdges / segments.length : 0;
      const meanEdgeLength = segments.length ? edgeLength / segments.length / diagonal : 0;
      const rowWaste = rows.reduce((sum, row) => sum + row.members.reduce((part, folder) => part + row.height - folder.height, 0), 0)
        / Math.max(1, rows.reduce((sum, row) => sum + row.height * row.members.length, 0));
      const fitScale = Math.max(0, Math.min(1, usableWidth / width, usableHeight / height));
      const viewportAspect = usableWidth / usableHeight, layoutAspect = width / height;
      const aspectPenalty = Math.min(1, Math.abs(Math.log(layoutAspect / viewportAspect)) / 2);
      const edgeLengthPenalty = Math.min(1, meanEdgeLength / 0.75);
      const lastRowUse = (items.length % columnCount || columnCount) / columnCount;
      const score = fitScale * 40 + (1 - crossingRatio) * 24 + (1 - backwardRatio) * 12
        + (1 - edgeLengthPenalty) * 12 + (1 - aspectPenalty) * 7 + (1 - rowWaste) * 3 + lastRowUse * 2;
      candidates.push({ columnCount, positions, width, height, score, metrics: {
        fitScale, crossings, crossingRatio, backwardEdges, backwardRatio,
        meanEdgeLength, edgeLengthPenalty, aspectPenalty, rowWaste, lastRowUse,
      } });
    }
    candidates.sort((a, b) => b.score - a.score || b.metrics.fitScale - a.metrics.fitScale
      || a.metrics.crossings - b.metrics.crossings || b.columnCount - a.columnCount);
    const best = candidates[0];
    const refined = refineFolderVerticalPositions(items, relations, best.positions, rowGap, padding);
    best.positions = refined.positions;
    best.height = Math.ceil(refined.after.bottom + padding);
    best.metrics.geometryBefore = refined.before;
    best.metrics.geometryAfter = refined.after;
    return { ...best, candidates };
  }

  function chooseColumnCount(layerHeights, availableWidth, availableHeight, columnWidth, columnGap, rowGap, padding) {
    const count = layerHeights.length;
    if (!count) return 1;
    let bestCount = 1, bestScale = -Infinity;
    for (let columns = 1; columns <= count; columns++) {
      let totalHeight = padding * 2;
      for (let row = 0; row < count; row += columns) {
        totalHeight += Math.max(...layerHeights.slice(row, row + columns));
        if (row + columns < count) totalHeight += rowGap;
      }
      const usedColumns = Math.min(columns, count);
      const totalWidth = padding * 2 + usedColumns * columnWidth + (usedColumns - 1) * columnGap;
      const scale = Math.min(1, availableWidth / totalWidth, availableHeight / totalHeight);
      if (scale > bestScale + 1e-6 || (Math.abs(scale - bestScale) <= 1e-6 && columns > bestCount)) {
        bestCount = columns; bestScale = scale;
      }
    }
    return bestCount;
  }

  function separateOverlappingFolders(folders, gap = 30) {
    const positions = folders.map((folder) => ({ ...folder }));
    for (let pass = 0; pass < positions.length; pass++) {
      let moved = false;
      positions.sort((a, b) => a.y - b.y || a.x - b.x || String(a.id).localeCompare(String(b.id), 'ja'));
      for (let i = 0; i < positions.length; i++) for (let j = i + 1; j < positions.length; j++) {
        const upper = positions[i], lower = positions[j];
        const horizontalOverlap = upper.x < lower.x + lower.width && upper.x + upper.width > lower.x;
        const verticalOverlap = upper.y < lower.y + lower.height + gap && upper.y + upper.height + gap > lower.y;
        if (!horizontalOverlap || !verticalOverlap) continue;
        lower.y = upper.y + upper.height + gap;
        moved = true;
      }
      if (!moved) break;
    }
    return positions;
  }

  return { layerFolders, orderNodes, countCrossings, routeEdges, normalizeBounds, chooseColumnCount, optimizeFolderGrid, refineFolderVerticalPositions, separateOverlappingFolders };
});
