/** Source-polyline road compilation. No geographic matching, new routes or inferred bridge elevations. */
import { projectLocal } from './geometry.mjs';

const LIMITS = Object.freeze({ roads: 2048, segments: 12000, vertices: 400000, junctionArms: 12 });
const TOP = 0.05, CURB_TOP = 0.20, CURB_WIDTH = 0.16, PATCH_LENGTH = 8, EPS = 1e-8;
const CLASS_WIDTH = Object.freeze({ motorway: 14, trunk: 12, primary: 10, secondary: 9, tertiary: 8,
  residential: 6, unclassified: 6, road: 6, living_street: 5, service: 4, track: 3,
  pedestrian: 5, footway: 2, path: 1.5, cycleway: 2.5, steps: 2, corridor: 2, platform: 3 });
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const add = (a, b, scale = 1) => [a[0] + b[0] * scale, a[1] + b[1] * scale];
const distance = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
const validPoint = p => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1])
  && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 85.05112878;
const enabled = value => value === true || typeof value === 'string' && !['', 'no', 'false', '0'].includes(value.toLowerCase());

function widthFor(road) {
  const raw = road.widthM ?? road.width ?? road.sourceAttributes?.width ?? road.tags?.width;
  const width = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\s*\d+(?:\.\d+)?\s*(?:m)?\s*$/u.test(raw)
    ? Number(raw.trim().replace(/m$/u, '').trim()) : NaN;
  if (Number.isFinite(width) && width >= 0.3 && width <= 40) return { width, kind: 'source', invalidSourceWidth: false };
  const lanes = Number(road.lanes);
  if (road.drivable !== false && Number.isInteger(lanes) && lanes >= 1 && lanes <= 12) {
    return { width: lanes * 3 + 0.6, kind: 'lanes', invalidSourceWidth: raw !== undefined };
  }
  return { width: CLASS_WIDTH[road.className] ?? (road.drivable === false ? 2 : 5), kind: 'class', invalidSourceWidth: raw !== undefined };
}

/** Liang-Barsky on the centerline, with a width margin so visible road edges are not lost. */
function clipLine(a, b, bounds, margin = 0) {
  let start = 0, end = 1;
  const delta = [b[0] - a[0], b[1] - a[1]];
  for (let axis = 0; axis < 2; axis++) {
    if (Math.abs(delta[axis]) < EPS) {
      if (a[axis] < bounds[axis] - margin || a[axis] > bounds[axis + 2] + margin) return null;
    } else {
      const t0 = (bounds[axis] - margin - a[axis]) / delta[axis], t1 = (bounds[axis + 2] + margin - a[axis]) / delta[axis];
      start = Math.max(start, Math.min(t0, t1)); end = Math.min(end, Math.max(t0, t1));
      if (start >= end) return null;
    }
  }
  return { a: add(a, delta, start), b: add(a, delta, end), start, end };
}

function clippedPolygon(points, bounds) {
  let polygon = points;
  for (const [axis, bound, sign] of [[0, bounds[0], 1], [0, bounds[2], -1], [1, bounds[1], 1], [1, bounds[3], -1]]) {
    const result = [];
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i], b = polygon[(i + 1) % polygon.length];
      const insideA = sign * (a[axis] - bound) >= 0, insideB = sign * (b[axis] - bound) >= 0;
      if (insideA) result.push(a);
      if (insideA !== insideB) {
        const t = (bound - a[axis]) / (b[axis] - a[axis]);
        const p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; p[axis] = bound; result.push(p);
      }
    }
    polygon = result;
    if (!polygon.length) return [];
  }
  polygon = polygon.filter((point, i) => distance(point, polygon[(i + 1) % polygon.length]) > EPS);
  if (polygon.length < 3) return [];
  const area = polygon.reduce((sum, p, i) => { const q = polygon[(i + 1) % polygon.length]; return sum + p[0] * q[1] - p[1] * q[0]; }, 0);
  if (Math.abs(area) < EPS) return [];
  return area < 0 ? polygon.toReversed() : polygon;
}

function convexHull(entries) {
  const sorted = [...entries].sort((a, b) => a.point[0] - b.point[0] || a.point[1] - b.point[1]);
  const unique = [];
  for (const entry of sorted) {
    const prior = unique.at(-1);
    if (prior && distance(prior.point, entry.point) < EPS) prior.arms.add(entry.arm);
    else unique.push({ point: entry.point, arms: new Set([entry.arm]) });
  }
  if (unique.length < 3) return unique;
  const side = values => { const hull = []; for (const entry of values) {
    while (hull.length >= 2 && cross(hull.at(-2).point, hull.at(-1).point, entry.point) <= EPS) hull.pop();
    hull.push(entry);
  } return hull; };
  return [...side(unique).slice(0, -1), ...side(unique.toReversed()).slice(0, -1)];
}

/**
 * Output: glTF X=east/Y=up/Z=-north, WGS84 tangent metres. Source centerlines
 * never move. Surface width may be measured or explicitly visual-derived.
 * Curbs, lane marks and junction fills are visual synthesis, not OSM assertions.
 * UVs are normalized per <=8m patch for parent atlas remapping/subdivision.
 * LOD 1 uses <=24m patches and omits curbs/markings before allocating geometry.
 * Tunnel/bridge/nonzero-layer records are omitted: layer is not an elevation.
 */
export function buildRoadSurfaces(roads, { origin, boundsMeters, lod = 0 }) {
  if (!validPoint(origin)) throw new Error('Road surface origin must be a finite WGS84 point');
  if (!Array.isArray(boundsMeters) || boundsMeters.length !== 4 || !boundsMeters.every(Number.isFinite)
    || boundsMeters[0] >= boundsMeters[2] || boundsMeters[1] >= boundsMeters[3]
    || boundsMeters[2] - boundsMeters[0] > 20000 || boundsMeters[3] - boundsMeters[1] > 20000) {
    throw new Error('Road surface bounds must be an ordered local metre rectangle no wider than 20 km');
  }
  if (!Array.isArray(roads)) throw new Error('Road surfaces require an array of source roads');
  if (lod !== 0 && lod !== 1) throw new Error('Road surface lod must be 0 or 1');
  const patchLength = lod === 1 ? 24 : PATCH_LENGTH;
  const diagnostics = { inputRoadRows: roads.length, duplicateRoadRows: 0, retainedRoads: 0, invalidRoads: 0,
    invalidSegments: 0, degenerateSegments: 0, outsideSegments: 0, renderedSegments: 0, clippedSegments: 0,
    omittedTunnelRoads: 0, omittedBridgeRoads: 0, omittedLayerRoads: 0, invalidLayerRoads: 0,
    excludedNonTraversableRoads: 0, sourceWidthRoads: 0, laneWidthRoads: 0, classWidthRoads: 0,
    invalidSourceWidthRoads: 0, omittedRoadRowsByCap: 0, omittedSegmentsByCap: 0,
    sharedNodeJunctions: 0, polylineJunctions: 0, junctionTriangles: 0, maxJunctionRadiusMeters: 0,
    omittedComplexJunctions: 0, vertexCount: 0, triangleCount: 0, omittedPatchesByCap: 0,
    limits: LIMITS, baseHeightMeters: TOP, curbHeightMeters: CURB_TOP - TOP, curbWidthMeters: CURB_WIDTH,
    lod, decorationPolicy: lod === 1 ? 'none_coarse_lod' : 'curbs_and_markings',
    uvMode: 'normalized_per_patch', maxSurfacePatchLengthMeters: patchLength,
    elevationPolicy: 'omit_tunnels_bridges_and_nonzero_layers_without_metric_elevation',
    widthPolicy: 'source_width_else_visual_lanes_3m_plus_0_6m_else_visual_class_width',
    curbPolicy: 'visual_edge_solids_not_observed_curb_inventory', partial: false };
  const retained = new Map();
  for (const road of roads) {
    if (!road || typeof road.id !== 'string' || !road.id || !Array.isArray(road.coordinates) || road.coordinates.length < 2) { diagnostics.invalidRoads++; continue; }
    if (enabled(road.tunnel)) { diagnostics.omittedTunnelRoads++; continue; }
    if (enabled(road.bridge)) { diagnostics.omittedBridgeRoads++; continue; }
    const layer = road.layer == null ? 0 : Number(road.layer);
    if (!Number.isFinite(layer)) { diagnostics.invalidLayerRoads++; continue; }
    if (layer !== 0) { diagnostics.omittedLayerRoads++; continue; }
    if (road.drivable === false && road.walkable === false) { diagnostics.excludedNonTraversableRoads++; continue; }
    const info = widthFor(road);
    let visible = false, invalidSegments = 0;
    for (let i = 1; i < road.coordinates.length; i++) {
      const a = road.coordinates[i - 1], b = road.coordinates[i];
      if (!validPoint(a) || !validPoint(b)) { invalidSegments++; continue; }
      if (clipLine(projectLocal(a, origin), projectLocal(b, origin), boundsMeters, info.width / 2 + CURB_WIDTH)) { visible = true; break; }
    }
    if (!visible) { diagnostics.invalidSegments += invalidSegments; diagnostics.outsideSegments += road.coordinates.length - 1 - invalidSegments; continue; }
    const prior = retained.get(road.id);
    if (prior) {
      diagnostics.duplicateRoadRows++;
      const signature = value => JSON.stringify([value.coordinates, value.nodeIds, value.widthM, value.width, value.lanes, value.className, value.drivable, value.oneway]);
      if (compare(signature(road), signature(prior.road)) < 0) retained.set(road.id, { road, info });
      continue;
    }
    if (retained.size < LIMITS.roads) retained.set(road.id, { road, info });
    else {
      diagnostics.omittedRoadRowsByCap++;
      let largest = ''; for (const key of retained.keys()) if (compare(key, largest) > 0) largest = key;
      if (compare(road.id, largest) < 0) { retained.delete(largest); retained.set(road.id, { road, info }); }
    }
  }
  diagnostics.retainedRoads = retained.size;
  const segments = [], nodes = new Map();
  const nodeKey = (road, index, point, clipped, segmentId, end) => {
    if (clipped) return `clip:${segmentId}:${end}`;
    let id = road.nodeIds?.[index] ?? (index === 0 ? road.startNodeId : index === road.coordinates.length - 1 ? road.endNodeId : null);
    if (typeof id !== 'string' || !id || /(?:undefined|null)$/u.test(id)) id = `polyline:${road.id}:${index}`;
    // Shared identity with inconsistent coordinates must not move or merge the source positions.
    return `${id}@${point[0]},${point[1]}`;
  };
  for (const { road, info } of [...retained.values()].sort((a, b) => compare(a.road.id, b.road.id))) {
    diagnostics[info.kind === 'source' ? 'sourceWidthRoads' : info.kind === 'lanes' ? 'laneWidthRoads' : 'classWidthRoads']++;
    if (info.invalidSourceWidth) diagnostics.invalidSourceWidthRoads++;
    for (let i = 1; i < road.coordinates.length; i++) {
      if (!validPoint(road.coordinates[i - 1]) || !validPoint(road.coordinates[i])) { diagnostics.invalidSegments++; continue; }
      const a = projectLocal(road.coordinates[i - 1], origin), b = projectLocal(road.coordinates[i], origin);
      if (distance(a, b) < 0.10) { diagnostics.degenerateSegments++; continue; }
      const clipped = clipLine(a, b, boundsMeters, info.width / 2 + CURB_WIDTH);
      if (!clipped) { diagnostics.outsideSegments++; continue; }
      if (segments.length >= LIMITS.segments) { diagnostics.omittedSegmentsByCap++; continue; }
      const length = distance(clipped.a, clipped.b);
      if (length < 0.10) { diagnostics.degenerateSegments++; continue; }
      const id = `${road.id}:${i - 1}`, direction = [(clipped.b[0] - clipped.a[0]) / length, (clipped.b[1] - clipped.a[1]) / length];
      const segment = { id, road, info, a: clipped.a, b: clipped.b, direction, length, trimA: 0, trimB: 0 };
      segments.push(segment); if (clipped.start > EPS || clipped.end < 1 - EPS) diagnostics.clippedSegments++;
      for (const [end, point, index, isClipped, sign] of [['a', clipped.a, i - 1, clipped.start > EPS, 1], ['b', clipped.b, i, clipped.end < 1 - EPS, -1]]) {
        const key = nodeKey(road, index, point, isClipped, id, end);
        if (!nodes.has(key)) nodes.set(key, { point, arms: [] });
        nodes.get(key).arms.push({ segment, end, direction: direction.map(value => value * sign), id: `${id}:${end}` });
      }
    }
  }
  const junctions = [];
  for (const node of nodes.values()) {
    if (node.arms.length < 2) continue;
    if (node.arms.length > LIMITS.junctionArms) { diagnostics.omittedComplexJunctions++; continue; }
    const entries = [], sourceIds = [...new Set(node.arms.map(arm => arm.segment.road.id))].sort(compare);
    const half = Math.max(...node.arms.map(arm => arm.segment.info.width / 2));
    for (const arm of node.arms) {
      const setback = Math.min(half * 1.15 + CURB_WIDTH, arm.segment.length * 0.4, 12);
      arm.segment[arm.end === 'a' ? 'trimA' : 'trimB'] = setback;
      const mouth = add(node.point, arm.direction, setback), normal = [-arm.direction[1], arm.direction[0]];
      for (const sign of [-1, 1]) entries.push({ point: add(mouth, normal, sign * arm.segment.info.width / 2), arm: arm.id });
    }
    const hull = convexHull(entries);
    if (hull.length < 3) continue;
    diagnostics[sourceIds.length > 1 ? 'sharedNodeJunctions' : 'polylineJunctions']++;
    for (const entry of hull) diagnostics.maxJunctionRadiusMeters = Math.max(diagnostics.maxJunctionRadiusMeters, distance(node.point, entry.point));
    junctions.push({ hull, sourceIds, material: node.arms.some(arm => arm.segment.road.drivable !== false) ? 'asphalt' : 'paving' });
  }

  const batches = new Map();
  function batch(material, provenance) {
    const key = `${material}:${provenance}`;
    if (!batches.has(key)) batches.set(key, { name: `roads-${material}-${provenance}`, material, provenance,
      positions: [], normals: [], uvs: [], indices: [], sourceIds: new Set() });
    return batches.get(key);
  }
  function reserve(count) {
    if (diagnostics.vertexCount + count > LIMITS.vertices) { diagnostics.omittedPatchesByCap++; return false; }
    return true;
  }
  function triangle(out, a, b, c, uv = [[0, 0], [1, 0], [1, 1]]) {
    const u = b.map((value, i) => value - a[i]), v = c.map((value, i) => value - a[i]);
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]], length = Math.hypot(...n);
    if (length < EPS) return;
    const base = out.positions.length / 3;
    for (const [index, point] of [a, b, c].entries()) {
      out.positions.push(...point); out.normals.push(...n.map(value => Object.is(value / length, -0) ? 0 : value / length));
      out.uvs.push(...uv[index]); out.indices.push(base + index);
    }
    diagnostics.vertexCount += 3; diagnostics.triangleCount++;
  }
  function polygon(points, material, provenance, sourceIds, height = TOP, bottom = null) {
    const ring = clippedPolygon(points, boundsMeters);
    if (ring.length < 3) return true;
    const required = (ring.length - 2) * 3 * (bottom === null ? 1 : 2) + (bottom === null ? 0 : ring.length * 6);
    if (!reserve(required)) return false;
    const out = batch(material, provenance); for (const id of sourceIds) out.sourceIds.add(id);
    const minE = Math.min(...ring.map(p => p[0])), minN = Math.min(...ring.map(p => p[1]));
    const spanE = Math.max(EPS, Math.max(...ring.map(p => p[0])) - minE), spanN = Math.max(EPS, Math.max(...ring.map(p => p[1])) - minN);
    const position = (p, y) => [p[0], y, -p[1]], uv = p => [Math.max(0, Math.min(1, (p[0] - minE) / spanE)), Math.max(0, Math.min(1, (p[1] - minN) / spanN))];
    for (let i = 1; i < ring.length - 1; i++) {
      const points = [ring[0], ring[i], ring[i + 1]];
      triangle(out, ...points.map(p => position(p, height)), points.map(uv));
      if (bottom !== null) triangle(out, ...points.toReversed().map(p => position(p, bottom)), points.toReversed().map(uv));
    }
    if (bottom !== null) for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      triangle(out, position(a, bottom), position(b, bottom), position(b, height));
      triangle(out, position(a, bottom), position(b, height), position(a, height), [[0, 0], [1, 1], [0, 1]]);
    }
    return true;
  }
  function curb(a, b, outward, sourceIds) {
    const length = distance(a, b), count = Math.max(1, Math.ceil(length / patchLength));
    for (let i = 0; i < count; i++) {
      const p = [a[0] + (b[0] - a[0]) * i / count, a[1] + (b[1] - a[1]) * i / count];
      const q = [a[0] + (b[0] - a[0]) * (i + 1) / count, a[1] + (b[1] - a[1]) * (i + 1) / count];
      if (!polygon([p, q, add(q, outward, CURB_WIDTH), add(p, outward, CURB_WIDTH)], 'curb', 'visual_synthesis', sourceIds, CURB_TOP, TOP)) return false;
    }
    return true;
  }
  const decorations = [];
  for (const segment of segments) {
    const a = add(segment.a, segment.direction, segment.trimA), b = add(segment.b, segment.direction, -segment.trimB);
    const length = distance(a, b), normal = [-segment.direction[1], segment.direction[0]], half = segment.info.width / 2;
    const material = segment.road.drivable === false ? 'paving' : 'asphalt';
    const provenance = segment.info.kind === 'source' ? 'source_geometry' : 'visual_synthesis';
    const count = Math.max(1, Math.ceil(length / patchLength));
    let emitted = false;
    for (let i = 0; i < count; i++) {
      const p = add(a, segment.direction, length * i / count), q = add(a, segment.direction, length * (i + 1) / count);
      if (!polygon([add(p, normal, half), add(q, normal, half), add(q, normal, -half), add(p, normal, -half)], material, provenance, [segment.road.id])) break;
      emitted = true;
    }
    if (emitted) diagnostics.renderedSegments++;
    if (lod === 0) decorations.push({ segment, a, b, length, normal, half, material });
  }
  // Semantic surfaces and source-node connections have priority over decoration.
  for (const junction of junctions) {
    const before = diagnostics.triangleCount;
    polygon(junction.hull.map(entry => entry.point), junction.material, 'visual_synthesis', junction.sourceIds);
    diagnostics.junctionTriangles += diagnostics.triangleCount - before;
  }
  for (const { segment, a, b, length, normal, half, material } of decorations) {
    for (const sign of [-1, 1]) curb(add(a, normal, half * sign), add(b, normal, half * sign), normal.map(value => value * sign), [segment.road.id]);
    if (material === 'asphalt' && Number(segment.road.lanes) >= 2 && segment.road.oneway === false) {
      for (let d = 2; d + 3 <= length - 2; d += 9) {
        const p = add(a, segment.direction, d), q = add(a, segment.direction, d + 3);
        if (!polygon([add(p, normal, .06), add(q, normal, .06), add(q, normal, -.06), add(p, normal, -.06)], 'marking', 'visual_synthesis', [segment.road.id], TOP + .006)) break;
      }
    }
  }
  for (const junction of junctions) {
    if (lod === 1) break;
    for (let i = 0; i < junction.hull.length; i++) {
      const a = junction.hull[i], b = junction.hull[(i + 1) % junction.hull.length];
      if ([...a.arms].some(arm => b.arms.has(arm))) continue; // A mouth is open, not an edge curb.
      const length = distance(a.point, b.point);
      if (length > EPS) curb(a.point, b.point, [(b.point[1] - a.point[1]) / length, -(b.point[0] - a.point[0]) / length], junction.sourceIds);
    }
  }
  diagnostics.partial = diagnostics.invalidRoads + diagnostics.invalidSegments + diagnostics.invalidLayerRoads
    + diagnostics.omittedTunnelRoads + diagnostics.omittedBridgeRoads + diagnostics.omittedLayerRoads
    + diagnostics.omittedRoadRowsByCap + diagnostics.omittedSegmentsByCap + diagnostics.omittedPatchesByCap + diagnostics.omittedComplexJunctions > 0;
  return { meshes: [...batches.values()].filter(mesh => mesh.indices.length).sort((a, b) => compare(a.name, b.name))
    .map(mesh => ({ ...mesh, sourceIds: [...mesh.sourceIds].sort(compare) })), diagnostics };
}
