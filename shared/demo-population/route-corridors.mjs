/**
 * Bounded offline connected route pools for fictional visual movement.
 * Connectivity comes only from identical OSM node IDs, never nearby coordinates.
 * These are local source-road corridors, NOT calculated home/work commutes.
 * Inputs and returned retained objects are immutable by contract. No I/O or AI.
 */
const EARTH_METERS_PER_DEGREE = 111_195;
const VERSION = 'osm-connected-corridor-v1';
const check = (value, message) => { if (!value) throw new Error(message); };
const hash = (text) => {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
};
const delta = (a, b) => [(b[0] - a[0]) * Math.cos(a[1] * Math.PI / 180), b[1] - a[1]];
const distance = (a, b) => Math.hypot(...delta(a, b)) * EARTH_METERS_PER_DEGREE;
const directionVector = (a, b) => { const [x, y] = delta(a, b); const length = Math.hypot(x, y); return length ? [x / length, y / length] : [0, 0]; };

/**
 * Build one graph, then call build(sourceRoadId, {mode:'walk'|'car', direction})
 * for whichever nearest-source-road bindings are actually needed. The cache is
 * a bounded LRU; eviction affects cost only, never IDs or route selection.
 * Split only at shared source nodes/endpoints; internal shape vertices remain
 * part of the original line. A bridge crossing without a shared ID stays apart.
 */
export function createRouteCorridorBuilder(roads, options = {}) {
  const policy = { targetMeters: 1000, maxMeters: 1500, maxSegments: 12, seed: 9202026, maxCachedRoutes: 1024, ...options };
  check(Number.isFinite(policy.targetMeters) && policy.targetMeters > 0 && Number.isFinite(policy.maxMeters) && policy.maxMeters >= policy.targetMeters && policy.maxMeters <= 1500 && Number.isInteger(policy.maxSegments) && policy.maxSegments >= 1 && policy.maxSegments <= 12 && Number.isSafeInteger(policy.seed) && Number.isInteger(policy.maxCachedRoutes) && policy.maxCachedRoutes >= 1 && policy.maxCachedRoutes <= 16_384, 'Invalid bounded corridor policy.');
  check(Array.isArray(roads) && roads.length <= 150_000, 'Invalid bounded road input.');
  const byId = new Map(); const counts = new Map(); const positions = new Map(); let vertices = 0;
  for (const road of roads) {
    check(typeof road?.id === 'string' && road.id.length > 0 && road.id.length <= 160 && !byId.has(road.id), 'Invalid or duplicate source road ID.');
    check(Array.isArray(road.coordinates) && road.coordinates.length >= 2 && Array.isArray(road.nodeIds) && road.nodeIds.length === road.coordinates.length, 'Source road node/coordinate count mismatch.');
    check(typeof road.oneway === 'boolean' && typeof road.walkable === 'boolean' && typeof road.drivable === 'boolean', 'Road direction and mode rules must be normalized booleans.');
    vertices += road.coordinates.length; check(vertices <= 2_000_000, 'Unbounded source vertex count.'); byId.set(road.id, road);
    for (let i = 0; i < road.coordinates.length; i++) {
      const p = road.coordinates[i]; const node = road.nodeIds[i];
      check(typeof node === 'string' && node.length > 0 && node.length <= 160, 'Invalid source node ID.');
      check(Array.isArray(p) && p.length === 2 && p.every(Number.isFinite) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 85.05112878, 'Invalid source node coordinate.');
      const existing = positions.get(node);
      check(!existing || Math.abs(existing[0] - p[0]) < 1e-7 && Math.abs(existing[1] - p[1]) < 1e-7, 'Conflicting coordinate for one source node ID.');
      if (!existing) positions.set(node, p); counts.set(node, (counts.get(node) ?? 0) + 1);
    }
  }
  const segments = []; const adjacency = new Map(); const firstSegments = new Map(); const lastSegments = new Map();
  const add = (node, directed) => {
    let list = adjacency.get(node); if (!list) { list = []; adjacency.set(node, list); }
    check(list.length < 256, 'Unbounded source-node junction degree.'); list.push(directed);
  };
  for (const road of roads) {
    let start = 0; let length = 0;
    for (let end = 1; end < road.coordinates.length; end++) {
      length += distance(road.coordinates[end - 1], road.coordinates[end]);
      if (end !== road.coordinates.length - 1 && counts.get(road.nodeIds[end]) < 2) continue;
      if (length > 0.001) {
        const ordinal = segments.length;
        segments.push({ road, start, end, length, from: road.nodeIds[start], to: road.nodeIds[end], key: `${road.id}:${start}:${end}` });
        add(road.nodeIds[start], ordinal * 2);
        // Conservative: pedestrian corridors also respect normalized oneway.
        // Do not manufacture a reverse edge when richer access rules are absent.
        if (!road.oneway) add(road.nodeIds[end], ordinal * 2 + 1);
        if (!firstSegments.has(road.id)) firstSegments.set(road.id, ordinal);
        lastSegments.set(road.id, ordinal);
      }
      start = end; length = 0;
    }
  }
  const sourceNodeCount = counts.size; counts.clear(); positions.clear();
  const cache = new Map(); let builtRoutes = 0; let cacheHits = 0;
  const policyId = hash(`${policy.seed}:${policy.targetMeters}:${policy.maxMeters}:${policy.maxSegments}`).toString(16);
  const vertexPair = (segment, reverse, outgoing) => {
    const i = outgoing ? reverse ? segment.end : segment.start : reverse ? segment.start + 1 : segment.end - 1;
    return reverse ? [segment.road.coordinates[i], segment.road.coordinates[i - 1]] : [segment.road.coordinates[i], segment.road.coordinates[i + 1]];
  };
  function build(roadId, { mode = 'walk', direction = 'forward' } = {}) {
    check(['walk', 'car'].includes(mode) && ['forward', 'reverse'].includes(direction), 'Invalid corridor mode/direction.');
    const startRoad = byId.get(roadId); const reverse = direction === 'reverse'; const modeFlag = mode === 'car' ? 'drivable' : 'walkable';
    if (!startRoad || !startRoad[modeFlag] || reverse && startRoad.oneway || !firstSegments.has(roadId)) return null;
    const key = `${roadId}:${mode}:${direction}`;
    if (cache.has(key)) { const result = cache.get(key); cache.delete(key); cache.set(key, result); cacheHits++; return result; }
    let directed = (reverse ? lastSegments.get(roadId) : firstSegments.get(roadId)) * 2 + Number(reverse);
    const used = new Set(); const routeSegments = []; const coordinates = []; const sourceRoadIds = []; const sourceRoadSet = new Set();
    let lengthMeters = 0; let oneway = false; let walkable = true; let drivable = true; let termination = 'dead_end';
    while (directed !== null) {
      const ordinal = directed >>> 1; const reversed = Boolean(directed & 1); const segment = segments[ordinal];
      used.add(ordinal); oneway ||= segment.road.oneway; walkable &&= segment.road.walkable; drivable &&= segment.road.drivable;
      if (!sourceRoadSet.has(segment.road.id)) { sourceRoadSet.add(segment.road.id); sourceRoadIds.push(segment.road.id); }
      const step = reversed ? -1 : 1; const start = reversed ? segment.end : segment.start; const end = reversed ? segment.start : segment.end;
      if (!coordinates.length) coordinates.push(segment.road.coordinates[start]);
      let segmentMeters = 0; let clipped = false;
      for (let i = start; i !== end; i += step) {
        const a = segment.road.coordinates[i]; const b = segment.road.coordinates[i + step]; const d = distance(a, b);
        const room = policy.maxMeters - lengthMeters;
        if (d > room + 1e-6) {
          const t = room / d;
          coordinates.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
          segmentMeters += room; lengthMeters += room; clipped = true; break;
        }
        coordinates.push(b); segmentMeters += d; lengthMeters += d;
      }
      routeSegments.push({ roadId: segment.road.id, fromNodeId: reversed ? segment.to : segment.from, toNodeId: clipped ? null : reversed ? segment.from : segment.to, startVertex: start, endVertex: end, direction: reversed ? 'reverse' : 'forward', lengthMeters: segmentMeters, clipped });
      if (clipped || lengthMeters >= policy.maxMeters - 1e-6) { termination = 'distance_budget'; break; }
      if (lengthMeters >= policy.targetMeters) { termination = 'target_reached'; break; }
      if (routeSegments.length >= policy.maxSegments) { termination = 'segment_budget'; break; }
      const node = reversed ? segment.from : segment.to; const heading = directionVector(...vertexPair(segment, reversed, false));
      let next = null; let bestTurn = Infinity; let bestRank = Infinity; let bestKey = '';
      for (const candidate of adjacency.get(node) ?? []) {
        const candidateOrdinal = candidate >>> 1; if (used.has(candidateOrdinal)) continue;
        const edge = segments[candidateOrdinal]; if (!edge.road[modeFlag]) continue;
        const candidateReverse = Boolean(candidate & 1); const outgoing = directionVector(...vertexPair(edge, candidateReverse, true));
        const turn = Math.floor(Math.max(0, Math.min(2, 1 - heading[0] * outgoing[0] - heading[1] * outgoing[1])) * 4);
        const candidateKey = `${edge.key}:${candidateReverse ? 'r' : 'f'}`;
        const rank = hash(`${policy.seed}:${key}:${candidateKey}`);
        if (turn < bestTurn || turn === bestTurn && (rank < bestRank || rank === bestRank && candidateKey < bestKey)) { next = candidate; bestTurn = turn; bestRank = rank; bestKey = candidateKey; }
      }
      directed = next;
    }
    if (coordinates.length < 2 || lengthMeters <= 0) return null;
    const result = { id: `${VERSION}:${key}:${policyId}`, coordinates, oneway, walkable, drivable, lengthMeters, sourceRoadIds, segments: routeSegments, termination, connectivity: 'source_node_ids', semantics: 'connected_source_road_local_visual_synthesis_not_home_work_route' };
    cache.set(key, result); builtRoutes++;
    while (cache.size > policy.maxCachedRoutes) cache.delete(cache.keys().next().value);
    return result;
  }
  return { build, stats: () => ({ sourceRoads: roads.length, sourceNodes: sourceNodeCount, segments: segments.length, junctions: adjacency.size, cachedRoutes: cache.size, builtRoutes, cacheHits }), clearCache: () => cache.clear() };
}
