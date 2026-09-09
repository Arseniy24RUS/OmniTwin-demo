/**
 * Bounded offline connected route pools for fictional visual movement.
 * Connectivity comes only from identical OSM node IDs, never nearby coordinates.
 * These are local source-road corridors, NOT calculated home/work commutes.
 * Inputs and returned retained objects are immutable by contract. No I/O or AI.
 */
import { roadModePolicy,roadVisualWeight,MOVEMENT_ROAD_POLICY_VERSION } from './movement-road-policy.mjs';
const EARTH_METERS_PER_DEGREE = 111_195;
const VERSION = 'osm-connected-corridor-v2';
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
  const segments = []; const adjacency = new Map(); const firstSegments = new Map(); const lastSegments = new Map();const roadSegments=new Map();
  const rules=new Map(roads.map(r=>[r.id,{walk:roadModePolicy(r,'walk'),car:roadModePolicy(r,'car')}]));
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
        // Geometry has two orientations; each mode independently permits traversal.
        add(road.nodeIds[end], ordinal * 2 + 1);
        if(!roadSegments.has(road.id))roadSegments.set(road.id,[]);roadSegments.get(road.id).push(ordinal);
        if (!firstSegments.has(road.id)) firstSegments.set(road.id, ordinal);
        lastSegments.set(road.id, ordinal);
      }
      start = end; length = 0;
    }
  }
  const sourceNodeCount = counts.size; counts.clear(); positions.clear();
  const cache = new Map(); let builtRoutes = 0; let cacheHits = 0;
  const policyId = hash(`${MOVEMENT_ROAD_POLICY_VERSION}:${policy.seed}:${policy.targetMeters}:${policy.maxMeters}:${policy.maxSegments}`).toString(16);
  const permitted=(directed,mode)=>{const r=rules.get(segments[directed>>>1].road.id)[mode];return directed&1?r.reverse:r.forward;};
  const onward=(directed,mode,used)=>{const s=segments[directed>>>1],node=directed&1?s.from:s.to;return (adjacency.get(node)??[]).filter(d=>(d>>>1)!==(directed>>>1)&&!used?.has(d>>>1)&&permitted(d,mode));};
  const vertexPair = (segment, reverse, outgoing) => {
    const i = outgoing ? reverse ? segment.end : segment.start : reverse ? segment.start + 1 : segment.end - 1;
    return reverse ? [segment.road.coordinates[i], segment.road.coordinates[i - 1]] : [segment.road.coordinates[i], segment.road.coordinates[i + 1]];
  };
  function build(roadId, { mode = 'walk', direction = 'forward' } = {}) {
    check(['walk', 'car'].includes(mode) && ['forward', 'reverse'].includes(direction), 'Invalid corridor mode/direction.');
    const startRoad = byId.get(roadId); const reverse = direction === 'reverse';const modeRules=rules.get(roadId)?.[mode];
    if (!startRoad || !modeRules?.[reverse?'reverse':'forward'] || !firstSegments.has(roadId)) return null;
    const key = `${roadId}:${mode}:${direction}`;
    if (cache.has(key)) { const result = cache.get(key); cache.delete(key); cache.set(key, result); cacheHits++; return result; }
    let directed = (reverse ? lastSegments.get(roadId) : firstSegments.get(roadId)) * 2 + Number(reverse);
    const used = new Set(); const routeSegments = []; const coordinates = []; const sourceRoadIds = []; const sourceRoadSet = new Set();
    let lengthMeters = 0; let oneway = false; let walkable = true; let drivable = true; let termination = 'dead_end';
    while (directed !== null) {
      const ordinal = directed >>> 1; const reversed = Boolean(directed & 1); const segment = segments[ordinal];
      used.add(ordinal);const modeRule=rules.get(segment.road.id)[mode];oneway ||= !modeRule.forward||!modeRule.reverse;walkable &&= rules.get(segment.road.id).walk.eligible;drivable &&= rules.get(segment.road.id).car.eligible;
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
      let next = null; let bestScore = Infinity; let bestRank = Infinity; let bestKey = '';
      for (const candidate of adjacency.get(node) ?? []) {
        const candidateOrdinal = candidate >>> 1; if (used.has(candidateOrdinal)) continue;
        const edge = segments[candidateOrdinal]; if (!permitted(candidate,mode)) continue;
        const candidateReverse = Boolean(candidate & 1); const outgoing = directionVector(...vertexPair(edge, candidateReverse, true));
        const turn = Math.floor(Math.max(0, Math.min(2, 1 - heading[0] * outgoing[0] - heading[1] * outgoing[1])) * 4);
        const candidateKey = `${edge.key}:${candidateReverse ? 'r' : 'f'}`;
        const rank = hash(`${policy.seed}:${key}:${candidateKey}`);
        const exits=onward(candidate,mode,used).length;
        const weight=roadVisualWeight(edge.road,mode,{lengthMeters:edge.length,connectedExits:exits?2:1});
        const score=turn-Math.log2(Math.max(.001,weight))+(exits?0:6);
        if (score < bestScore || score === bestScore && (rank < bestRank || rank === bestRank && candidateKey < bestKey)) { next = candidate; bestScore = score; bestRank = rank; bestKey = candidateKey; }
      }
      directed = next;
    }
    if (coordinates.length < 2 || lengthMeters <= 0) return null;
    const result = { id: `${VERSION}:${key}:${policyId}`, coordinates, oneway, walkable, drivable, lengthMeters, sourceRoadIds,sourceRoadClasses:sourceRoadIds.map(id=>byId.get(id).className??null),modePolicy:MOVEMENT_ROAD_POLICY_VERSION,allocationRepresentation:'visual_synthesis_not_observed_traffic',segments: routeSegments, termination, connectivity: 'source_node_ids', semantics: 'connected_source_road_local_visual_synthesis_not_home_work_route' };
    cache.set(key, result); builtRoutes++;
    while (cache.size > policy.maxCachedRoutes) cache.delete(cache.keys().next().value);
    return result;
  }
  function buildBest(roadId,{mode='walk'}={}){const forward=build(roadId,{mode}),reverse=build(roadId,{mode,direction:'reverse'});return !forward?reverse:!reverse?forward:reverse.lengthMeters>forward.lengthMeters+1e-6?reverse:forward;}
  const seedRoad=roads.reduce((best,r)=>!best||r.id<best.id?r:best,null),seedOrigin=seedRoad?.coordinates[0]??[0,0],seedScaleX=EARTH_METERS_PER_DEGREE*Math.cos(seedOrigin[1]*Math.PI/180),project=p=>[(p[0]-seedOrigin[0])*seedScaleX,(p[1]-seedOrigin[1])*EARTH_METERS_PER_DEGREE],seedGrid=new Map(),seedMetrics=new Map();
  for(const road of roads){const box=[Infinity,Infinity,-Infinity,-Infinity];for(const p of road.coordinates){const q=project(p);box[0]=Math.min(box[0],Math.floor(q[0]/500));box[1]=Math.min(box[1],Math.floor(q[1]/500));box[2]=Math.max(box[2],Math.floor(q[0]/500));box[3]=Math.max(box[3],Math.floor(q[1]/500));}check((box[2]-box[0]+1)*(box[3]-box[1]+1)<=4096,'Unbounded seed road extent');
    for(let x=box[0];x<=box[2];x++)for(let y=box[1];y<=box[3];y++){const k=`${x}:${y}`;if(!seedGrid.has(k))seedGrid.set(k,[]);seedGrid.get(k).push(road);}
    const info={};for(const mode of ['walk','car']){const links=new Set();let lengthMeters=0;for(const ordinal of roadSegments.get(road.id)??[]){const s=segments[ordinal];lengthMeters+=s.length;for(const node of [s.from,s.to])for(const d of adjacency.get(node)??[])if(segments[d>>>1].road.id!==road.id&&permitted(d,mode))links.add(segments[d>>>1].road.id);if(s.from===s.to)links.add('closed-source-loop');}info[mode]={lengthMeters,connectedExits:links.has('closed-source-loop')?2:links.size};}seedMetrics.set(road.id,info);
  }
  function selectSeed(point,{mode='walk',maxDistanceMeters=750}={}){check(['walk','car'].includes(mode)&&Array.isArray(point)&&point.length===2&&point.every(Number.isFinite)&&Number.isFinite(maxDistanceMeters)&&maxDistanceMeters>0&&maxDistanceMeters<=750,'Invalid bounded source seed query');const p=project(point),radius=Math.ceil(maxDistanceMeters/500),cx=Math.floor(p[0]/500),cy=Math.floor(p[1]/500),candidates=new Set();
    for(let x=cx-radius;x<=cx+radius;x++)for(let y=cy-radius;y<=cy+radius;y++)for(const r of seedGrid.get(`${x}:${y}`)??[])candidates.add(r);
    let best=null;for(const road of candidates){if(!rules.get(road.id)[mode].eligible)continue;let d=Infinity;for(let i=1;i<road.coordinates.length;i++){const a=project(road.coordinates[i-1]),b=project(road.coordinates[i]),dx=b[0]-a[0],dy=b[1]-a[1],den=dx*dx+dy*dy,t=den?Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/den)):0;d=Math.min(d,Math.hypot(p[0]-a[0]-t*dx,p[1]-a[1]-t*dy));}if(d>maxDistanceMeters)continue;
      const info=seedMetrics.get(road.id)[mode],weight=roadVisualWeight(road,mode,info),score=(d+25)/Math.sqrt(Math.max(.001,weight));if(!best||score<best.score||score===best.score&&road.id<best.sourceRoadId)best={sourceRoadId:road.id,distanceMeters:d,score,visualWeight:weight,...info,policyVersion:MOVEMENT_ROAD_POLICY_VERSION};}
    return best;
  }
  return { build,buildBest,selectSeed,stats: () => ({ sourceRoads: roads.length, sourceNodes: sourceNodeCount, segments: segments.length, junctions: adjacency.size, cachedRoutes: cache.size, builtRoutes, cacheHits,modePolicy:MOVEMENT_ROAD_POLICY_VERSION,walkEligibleRoads:roads.filter(r=>rules.get(r.id).walk.eligible).length,carEligibleRoads:roads.filter(r=>rules.get(r.id).car.eligible).length }), clearCache: () => cache.clear() };
}
