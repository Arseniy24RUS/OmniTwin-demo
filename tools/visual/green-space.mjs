/** Build-time source green cover and explicitly illustrative vegetation; never invent land use. */
import { ShapeUtils, Vector2 } from 'three';
import { projectLocal, signedArea, stableHash, triangle } from './geometry.mjs';
import { pointInRing } from '../geo/city-geography.mjs';
import { buildTreeMeshes } from './tree-crowns.mjs';
import { buildCourtyardDetails } from './courtyard-details.mjs';

const EPS = 1e-7, BASE = .025, GRID = 12;
const LIMITS = Object.freeze({ features: 10000, sourceVertices: 300000, groundVertices: 500000,
  overlayOperations: 1000000, fragments: 1024, candidateAttempts: 200000, trees: 1000 });
// Kept identical to road-surfaces.mjs widthFor: no inferred measured widths.
const CLASS_WIDTH = Object.freeze({ motorway: 14, trunk: 12, primary: 10, secondary: 9, tertiary: 8,
  residential: 6, unclassified: 6, road: 6, living_street: 5, service: 4, track: 3,
  pedestrian: 5, footway: 2, path: 1.5, cycleway: 2.5, steps: 2, corridor: 2, platform: 3 });
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const validPoint = p => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1])
  && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 85.05112878;
const enabled = value => value === true || typeof value === 'string' && !['', 'no', 'false', '0'].includes(value.toLowerCase());
const cross = (a, b, p) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
const insideBounds = (p, b) => p[0] >= b[0] - EPS && p[1] >= b[1] - EPS && p[0] <= b[2] + EPS && p[1] <= b[3] + EPS;
const overlaps = (a, b) => a[0] <= b[2] + EPS && a[2] >= b[0] - EPS && a[1] <= b[3] + EPS && a[3] >= b[1] - EPS;
function boundsOf(points, margin = 0) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const p of points) { b[0] = Math.min(b[0], p[0]); b[1] = Math.min(b[1], p[1]); b[2] = Math.max(b[2], p[0]); b[3] = Math.max(b[3], p[1]); }
  return [b[0] - margin, b[1] - margin, b[2] + margin, b[3] + margin];
}
function distanceToSegment(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], den = dx * dx + dy * dy;
  const t = den ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / den)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
const ringDistance = (point, ring) => ring.reduce((d, p, i) => Math.min(d, distanceToSegment(point, p, ring[(i + 1) % ring.length])), Infinity);
const inPolygon = (p, rings) => (pointInRing(p, rings[0]) || ringDistance(p, rings[0]) < EPS)
  && !rings.slice(1).some(r => pointInRing(p, r) || ringDistance(p, r) < EPS);
const inGeometry = (p, polygons) => polygons.some(rings => inPolygon(p, rings));

/** Coordinate-stable muted variation; no UV stretching or invented land-cover boundary. */
function groundTint([e,n]) {
  const x=e/64,y=n/64,ix=Math.floor(x),iy=Math.floor(y),smooth=v=>v*v*(3-2*v),tx=smooth(x-ix),ty=smooth(y-iy);
  const value=(i,j)=>stableHash(`ground-tint-v1:${i}:${j}`)/0xffffffff;
  return .93+.07*((value(ix,iy)*(1-tx)+value(ix+1,iy)*tx)*(1-ty)+(value(ix,iy+1)*(1-tx)+value(ix+1,iy+1)*tx)*ty);
}

/** Small bounded spatial hash, with large objects in a separate list instead of millions of buckets. */
function spatialIndex() {
  const buckets = new Map(), large = [], size = 48;
  function cells(b) {
    const range = [Math.floor(b[0] / size), Math.floor(b[1] / size), Math.floor(b[2] / size), Math.floor(b[3] / size)];
    if ((range[2] - range[0] + 1) * (range[3] - range[1] + 1) > 4096) return null;
    const keys = []; for (let x = range[0]; x <= range[2]; x++) for (let y = range[1]; y <= range[3]; y++) keys.push(`${x}:${y}`);
    return keys;
  }
  return {
    add(item) { const keys = cells(item.bounds); if (!keys) { large.push(item); return; }
      for (const key of keys) { if (!buckets.has(key)) buckets.set(key, []); buckets.get(key).push(item); } },
    query(b) { const keys = cells(b), items = new Set(large);
      for (const list of keys ? keys.map(key => buckets.get(key) ?? []) : buckets.values()) for (const item of list) items.add(item);
      return [...items].filter(item => overlaps(b, item.bounds)); },
  };
}

function classification(feature) {
  const p = feature.properties ?? {}, lower = value => String(value ?? '').toLowerCase();
  const layer = lower(feature.sourceLayer), tags = ['class', 'subclass', 'natural', 'landuse', 'leisure', 'type'].map(key => lower(p[key]));
  const forbidden = ['pitch', 'playground', 'water', 'waterway', 'wetland', 'reservoir', 'river', 'lake', 'rail', 'railway', 'railroad'];
  if (forbidden.includes(layer) || tags.some(t => forbidden.includes(t)) || p.railway && p.railway !== 'no') return { kind: 'forbidden', priority: 10, trees: false };
  if (feature.geometry?.type === 'Point') {
    return tags.includes('tree') || ['tree', 'trees', 'treepoints'].includes(layer)
      ? { kind: 'tree', priority: 9, trees: false } : null;
  }
  for (const [kind, priority] of [['forest', 5], ['wood', 5], ['park', 4], ['garden', 3], ['grass', 1]]) {
    if (tags.includes(kind)) return { kind, priority, trees: kind !== 'grass' };
  }
  return null;
}

function localPolygons(geometry, origin, budget) {
  const source = geometry?.type === 'Polygon' ? [geometry.coordinates] : geometry?.type === 'MultiPolygon' ? geometry.coordinates : null;
  if (!Array.isArray(source) || !source.length) return null;
  const polygons = [];
  for (const sourceRings of source) {
    if (!Array.isArray(sourceRings) || !sourceRings.length) return null;
    const rings = [];
    for (const sourceRing of sourceRings) {
      if (!Array.isArray(sourceRing) || sourceRing.length < 4 || sourceRing.length > 30000) return null;
      budget.count += sourceRing.length; if (budget.count > LIMITS.sourceVertices) return null;
      if (!sourceRing.every(validPoint)) return null;
      if (sourceRing[0][0] !== sourceRing.at(-1)[0] || sourceRing[0][1] !== sourceRing.at(-1)[1]) return null;
      const ring = sourceRing.slice(0, -1).map(p => projectLocal(p, origin)).filter((p, i, points) => i === 0 || Math.hypot(p[0] - points[i - 1][0], p[1] - points[i - 1][1]) > EPS);
      if (ring.length < 3 || !ring.every(p => p.every(Number.isFinite)) || Math.abs(signedArea(ring)) < EPS) return null;
      if ((signedArea(ring) > 0) !== (rings.length === 0)) ring.reverse();
      rings.push(ring);
    }
    if (rings.slice(1).some(hole => !pointInRing(hole[0], rings[0]))) return null;
    polygons.push(rings);
  }
  return polygons;
}

function cleanPolygon(points) {
  const p = points.filter((v, i) => Math.hypot(v[0] - points[(i + 1) % points.length][0], v[1] - points[(i + 1) % points.length][1]) > EPS);
  if (p.length < 3 || Math.abs(signedArea(p)) < EPS) return [];
  return signedArea(p) < 0 ? p.toReversed() : p;
}
function halfPlane(polygon, a, b, keepInside) {
  const out = [], sign = keepInside ? 1 : -1;
  for (let i = 0; i < polygon.length; i++) {
    const p = polygon[i], q = polygon[(i + 1) % polygon.length], d = cross(a, b, p), e = cross(a, b, q);
    const ip = d * sign >= 0, iq = e * sign >= 0;
    if (ip) out.push(p);
    if (ip !== iq) { const t = d / (d - e); out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]); }
  }
  return cleanPolygon(out);
}
function clipBounds(polygon, bounds) {
  const ring = [[bounds[0], bounds[1]], [bounds[2], bounds[1]], [bounds[2], bounds[3]], [bounds[0], bounds[3]]];
  let out = polygon; for (let i = 0; i < 4 && out.length; i++) out = halfPlane(out, ring[i], ring[(i + 1) % 4], true);
  return out;
}
function subtractConvex(polygon, cutter) {
  let inside = polygon; const result = [];
  for (let i = 0; i < cutter.length && inside.length; i++) {
    const a = cutter[i], b = cutter[(i + 1) % cutter.length], outside = halfPlane(inside, a, b, false);
    if (outside.length) result.push(outside); inside = halfPlane(inside, a, b, true);
  }
  return result;
}
function triangulate(polygons, bounds) {
  const pieces = [];
  for (const rings of polygons) {
    const vertices = rings.flat(), faces = ShapeUtils.triangulateShape(rings[0].map(p => new Vector2(...p)), rings.slice(1).map(r => r.map(p => new Vector2(...p))));
    for (const face of faces) { const polygon = clipBounds(cleanPolygon(face.map(i => vertices[i])), bounds); if (polygon.length) pieces.push(polygon); }
  }
  return pieces;
}
function sourceRoadWidth(road) {
  const raw = road.widthM ?? road.width ?? road.sourceAttributes?.width ?? road.tags?.width;
  const width = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\s*\d+(?:\.\d+)?\s*(?:m)?\s*$/u.test(raw)
    ? Number(raw.trim().replace(/m$/u, '').trim()) : NaN;
  if (Number.isFinite(width) && width >= .3 && width <= 40) return { width, kind: 'source' };
  const lanes = Number(road.lanes);
  if (road.drivable !== false && Number.isInteger(lanes) && lanes >= 1 && lanes <= 12) return { width: lanes * 3 + .6, kind: 'lanes' };
  return { width: CLASS_WIDTH[road.className] ?? (road.drivable === false ? 2 : 5), kind: 'class' };
}

function makeMesh(name, material, sourceIds, extra = {}) {
  return { name, material, positions: [], normals: [], uvs: [], colors: [], indices: [], sourceIds, ...extra };
}

/**
 * Inputs are already verified WGS84 source features, compiled building footprints and road polylines.
 * Call ONCE for the complete quarter before partitioning returned treeId-owned meshes into tiles.
 * maxTrees is global to this call (hard maximum 1000), never an observed inventory count.
 * Ground preserves actual polygon holes, clipped after triangulation. Overlaps use exact convex
 * subtraction, priority forest/wood > park > garden > grass, then stable source identity.
 * A 12m grid is anchored to the shared origin + seed, not each feature/tile bounding box.
 * Explicit tree point coordinates are source-backed; ALL tree species/shapes/dimensions are synthesis.
 */
export function buildGreenSpace(features, buildings, roads, { origin, boundsMeters, maxTrees = 1000, maxDecorations = maxTrees > 0 ? 96 : 0, lod = 0, seed = 'green-space-v1' }) {
  if (!validPoint(origin)) throw new Error('Green space origin must be finite WGS84');
  if (!Array.isArray(boundsMeters) || boundsMeters.length !== 4 || !boundsMeters.every(Number.isFinite)
    || boundsMeters.some(v => Math.abs(v) > 2000000) || boundsMeters[0] >= boundsMeters[2] || boundsMeters[1] >= boundsMeters[3]
    || boundsMeters[2] - boundsMeters[0] > 20000 || boundsMeters[3] - boundsMeters[1] > 20000) throw new Error('Green space bounds must be ordered local metres, at most 20km wide');
  if (![features, buildings, roads].every(Array.isArray)) throw new Error('Green space requires feature, building and road arrays');
  if ([features, buildings, roads].some(list => list.length > LIMITS.features)) throw new Error('Green space source array exceeds bounded inventory limit');
  if (!Number.isInteger(maxTrees) || maxTrees < 0 || lod !== 0 && lod !== 1) throw new Error('Green space maxTrees must be nonnegative integer; lod must be 0 or 1');
  const cap = Math.min(maxTrees, LIMITS.trees), budget = { count: 0 };
  const diagnostics = { inputFeatures: features.length, eligibleGroundFeatures: 0, rejectedFeatures: 0, invalidFeatures: 0,
    duplicateFeatures: 0, invalidBuildings: 0, invalidRoadSegments: 0, sourceWidthRoads: 0, laneWidthRoads: 0, classWidthRoads: 0,
    excludedByBuildings: 0, excludedByRoads: 0, excludedByForbiddenLand: 0, excludedByTreeSpacing: 0,
    candidateAttempts: 0, candidateLimitReached: false, omittedTreesByCap: 0, observedPointTrees: 0, syntheticTrees: 0,
    groundVertexCount: 0, overlayOperations: 0, groundBudgetExhausted: false, treesSuppressedByInvalidExclusions: false,
    maxTrees: cap, gridSpacingMeters: GRID, baseHeightMeters: BASE, seed: String(seed), lod, limits: LIMITS,
    groundPolicy: 'source_polygons_with_holes_clipped_then_priority_union', treePolicy: 'explicit_points_first_else_12m_grid_only_in_wood_forest_park_garden',
    dimensionsPolicy: 'visual_synthesis_radius_2_to_3m_height_5_to_9m', buildingClearanceMeters: 2.5, roadClearanceMeters: 2,
    crownPolicy: 'opaque_three_lobe_broadleaf_max_200_triangles_per_tree',
    groundMaterialPolicy: 'solid_muted_green_with_analytic_vertex_variation_until_metric_tiling',
    roadWidthPolicy: 'source_width_else_visual_lanes_3m_plus_0_6m_else_visual_class_width',
    verticalRoadPolicy: 'ignore_explicit_tunnels_conservatively_exclude_other_source_corridors', partial: false };
  const accepted = [], exact = [], forbidden = [], identities = new Set(), courtyardAreas = [];
  const sorted = features.map(f => ({ f, key: `${f?.sourceLayer ?? ''}:${String(f?.id ?? '')}`, signature: JSON.stringify(f) }))
    .sort((a, b) => compare(a.key, b.key) || compare(a.signature, b.signature));
  for (const { f, key, signature } of sorted) {
    if (!f || f.id === undefined || f.id === null || String(f.id) === '') { diagnostics.invalidFeatures++; continue; }
    const identity = `${key}:${signature}`; if (identities.has(identity)) { diagnostics.duplicateFeatures++; continue; } identities.add(identity);
    const policy = classification(f); if (!policy) { diagnostics.rejectedFeatures++; continue; }
    const item = { id: String(f.id), key, sourceLayer: f.sourceLayer ?? '', policy };
    if (policy.kind === 'tree') {
      if (!validPoint(f.geometry.coordinates)) { diagnostics.invalidFeatures++; continue; }
      const point = projectLocal(f.geometry.coordinates, origin); if (insideBounds(point, boundsMeters)) exact.push({ ...item, point }); continue;
    }
    const polygons = localPolygons(f.geometry, origin, budget);
    if (!polygons) { diagnostics.invalidFeatures++; continue; }
    const bounds = boundsOf(polygons.flat(2)); if (!overlaps(bounds, boundsMeters)) continue;
    const record = { ...item, polygons, bounds };
    if (policy.kind === 'forbidden') forbidden.push(record); else accepted.push(record);
  }
  accepted.sort((a, b) => b.policy.priority - a.policy.priority || compare(a.key, b.key));
  diagnostics.eligibleGroundFeatures = accepted.length;
  const forbiddenIndex = spatialIndex(), groundIndex = spatialIndex(), buildingIndex = spatialIndex(), roadIndex = spatialIndex();
  for (const item of forbidden) forbiddenIndex.add(item);
  for (const building of buildings) {
    const polygons = localPolygons(building?.footprint ?? building?.geometry, origin, budget);
    if (!polygons) { diagnostics.invalidBuildings++; continue; }
    const bounds = boundsOf(polygons.flat(2), 2.5); if (overlaps(bounds, boundsMeters)) {
      buildingIndex.add({ polygons, bounds });
      if(building.id)polygons.forEach((rings,polygonIndex)=>rings.slice(1).forEach((hole,holeIndex)=>courtyardAreas.push({
        key:`building-hole:${building.id}:${polygonIndex}:${holeIndex}`,sourceIds:[String(building.id)],kind:'courtyard_hole',rings:[hole],
      })));
    }
  }
  for (const road of roads) {
    if (enabled(road?.tunnel ?? road?.properties?.tunnel)) continue;
    const coordinates = road?.coordinates ?? (road?.geometry?.type === 'LineString' ? road.geometry.coordinates : null);
    if (!Array.isArray(coordinates) || coordinates.length < 2) { diagnostics.invalidRoadSegments++; continue; }
    const normalized = { ...road?.properties, ...road }, info = sourceRoadWidth(normalized), clearance = info.width / 2 + 2;
    diagnostics[info.kind === 'source' ? 'sourceWidthRoads' : info.kind === 'lanes' ? 'laneWidthRoads' : 'classWidthRoads']++;
    budget.count += coordinates.length;
    if (budget.count > LIMITS.sourceVertices) { diagnostics.invalidRoadSegments++; continue; }
    for (let i = 1; i < coordinates.length; i++) {
      if (!validPoint(coordinates[i - 1]) || !validPoint(coordinates[i])) { diagnostics.invalidRoadSegments++; continue; }
      const a = projectLocal(coordinates[i - 1], origin), b = projectLocal(coordinates[i], origin), bounds = boundsOf([a, b], clearance);
      if (overlaps(bounds, boundsMeters)) roadIndex.add({ a, b, clearance, bounds });
    }
  }
  // Invalid exclusion geometry cannot be treated as empty space.
  diagnostics.treesSuppressedByInvalidExclusions = diagnostics.invalidBuildings + diagnostics.invalidRoadSegments > 0;
  const meshes = [];
  for (const item of forbidden) for (const polygon of triangulate(item.polygons, boundsMeters)) groundIndex.add({ polygon, bounds: boundsOf(polygon) });
  for (const item of accepted) {
    const out = makeMesh(`green-ground:${item.key}`, 'grass', [item.id], { ownerId: item.key, sourceLayer: item.sourceLayer, surfaceClass: item.policy.kind, provenance: 'source_geometry' });
    for (const sourcePiece of triangulate(item.polygons, boundsMeters)) {
      if (diagnostics.groundBudgetExhausted) break;
      let pieces = [sourcePiece];
      for (const mask of groundIndex.query(boundsOf(sourcePiece))) {
        if (!pieces.length) break;
        const next = [];
        for (const piece of pieces) {
          if (++diagnostics.overlayOperations > LIMITS.overlayOperations) { diagnostics.groundBudgetExhausted = true; break; }
          if (overlaps(boundsOf(piece), mask.bounds)) next.push(...subtractConvex(piece, mask.polygon)); else next.push(piece);
        }
        pieces = next;
        if (pieces.length > LIMITS.fragments || diagnostics.groundBudgetExhausted) { diagnostics.groundBudgetExhausted = true; pieces = []; break; }
      }
      for (const polygon of pieces) {
        const vertexCount = (polygon.length - 2) * 3;
        if (diagnostics.groundVertexCount + vertexCount > LIMITS.groundVertices) { diagnostics.groundBudgetExhausted = true; break; }
        const bounds = boundsOf(polygon), width = Math.max(EPS, bounds[2] - bounds[0]), depth = Math.max(EPS, bounds[3] - bounds[1]);
        for (let i = 1; i < polygon.length - 1; i++) {
          const p = [polygon[0], polygon[i], polygon[i + 1]];
          triangle(out, p.map(v => [v[0], BASE, -v[1]]), p.map(v => [(v[0] - bounds[0]) / width, (v[1] - bounds[1]) / depth]), p.map(groundTint));
        }
        diagnostics.groundVertexCount += vertexCount; groundIndex.add({ polygon, bounds });
      }
    }
    if (out.indices.length) meshes.push(out);
  }
  const treePlacements = [], usedGrid = new Set(), usedPoints = new Set(), treeIndex = spatialIndex();
  function excluded(point) {
    const b = [point[0], point[1], point[0], point[1]];
    if (forbiddenIndex.query(b).some(item => inGeometry(point, item.polygons))) { diagnostics.excludedByForbiddenLand++; return true; }
    if (buildingIndex.query(b).some(item => inGeometry(point, item.polygons) || item.polygons.some(rings => rings.some(ring => ringDistance(point, ring) < 2.5 - EPS)))) { diagnostics.excludedByBuildings++; return true; }
    if (roadIndex.query(b).some(item => distanceToSegment(point, item.a, item.b) < item.clearance - EPS)) { diagnostics.excludedByRoads++; return true; }
    return false;
  }
  function placement(item, point, suffix, provenance) {
    const id = `green-tree:${item.key}${suffix}`, hash = stableHash(`${seed}:${id}`), radiusMeters = 2 + (hash % 1001) / 1000;
    return { id, sourceIds: [item.id], sourceLayer: item.sourceLayer, point, position: [point[0], BASE, -point[1]], radiusMeters,
      heightMeters: 5 + (stableHash(`${seed}:${id}:height`) % 4001) / 1000, provenance,
      dimensionsProvenance: 'visual_synthesis', ...(provenance === 'visual_synthesis' ? { gridSpacingMeters: GRID } : {}) };
  }
  function retain(p, observed) {
    const key = p.point.map(v => v.toFixed(3)).join(':'); if (usedPoints.has(key)) return;
    if (excluded(p.point)) return;
    if (!observed && treeIndex.query([p.point[0] - 6, p.point[1] - 6, p.point[0] + 6, p.point[1] + 6])
      .some(other => Math.hypot(p.point[0] - other.point[0], p.point[1] - other.point[1]) < p.radiusMeters + other.radiusMeters)) { diagnostics.excludedByTreeSpacing++; return; }
    usedPoints.add(key);
    if (treePlacements.length >= cap) { diagnostics.omittedTreesByCap++; return; }
    treePlacements.push(p); treeIndex.add({ ...p, bounds: [...p.point, ...p.point] });
    diagnostics[observed ? 'observedPointTrees' : 'syntheticTrees']++;
  }
  if (cap > 0 && !diagnostics.treesSuppressedByInvalidExclusions) {
    for (const item of exact) retain(placement(item, item.point, '', 'source_geometry'), true);
    const phase = [stableHash(`${seed}:east`) % 12000 / 1000, stableHash(`${seed}:north`) % 12000 / 1000];
    for (const item of accepted) {
      if (!item.policy.trees || diagnostics.candidateLimitReached) continue;
      const b = [Math.max(boundsMeters[0], item.bounds[0]), Math.max(boundsMeters[1], item.bounds[1]), Math.min(boundsMeters[2], item.bounds[2]), Math.min(boundsMeters[3], item.bounds[3])];
      for (let iy = Math.ceil((b[1] - phase[1]) / GRID); iy <= Math.floor((b[3] - phase[1]) / GRID); iy++) {
        if (diagnostics.candidateLimitReached) break;
        for (let ix = Math.ceil((b[0] - phase[0]) / GRID); ix <= Math.floor((b[2] - phase[0]) / GRID); ix++) {
          if (diagnostics.candidateAttempts >= LIMITS.candidateAttempts) { diagnostics.candidateLimitReached = true; break; }
          diagnostics.candidateAttempts++;
          const key = `${ix}:${iy}`, point = [ix * GRID + phase[0], iy * GRID + phase[1]];
          if (usedGrid.has(key) || !inGeometry(point, item.polygons)) continue;
          usedGrid.add(key);
          const p = placement(item, point, `:grid:${key}`, 'visual_synthesis');
          if (item.polygons.every(rings => !inPolygon(point, rings) || rings.some(ring => ringDistance(point, ring) < p.radiusMeters))) continue;
          retain(p, false);
        }
      }
    }
  }
  for (const p of treePlacements) meshes.push(...buildTreeMeshes(p, {lod,baseHeight:BASE}));
  for(const item of accepted)if(['park','garden'].includes(item.policy.kind))item.polygons.forEach((rings,index)=>courtyardAreas.push({
    key:`source-${item.policy.kind}:${item.key}:${index}`,sourceIds:[item.id],kind:`source_${item.policy.kind}`,rings,
  }));
  const details=buildCourtyardDetails(courtyardAreas,{boundsMeters,existingTrees:treePlacements,
    maxDecorations:diagnostics.treesSuppressedByInvalidExclusions||diagnostics.invalidFeatures>0?0:maxDecorations,seed:`${seed}:furniture`,
    isBlocked(point,radius){
      const b=[point[0]-radius,point[1]-radius,point[0]+radius,point[1]+radius];
      if(forbiddenIndex.query(b).some(item=>inGeometry(point,item.polygons)||item.polygons.some(rings=>rings.some(ring=>ringDistance(point,ring)<radius))))return true;
      if(buildingIndex.query(b).some(item=>inGeometry(point,item.polygons)||item.polygons.some(rings=>rings.some(ring=>ringDistance(point,ring)<radius+.35))))return true;
      return roadIndex.query(b).some(item=>distanceToSegment(point,item.a,item.b)<item.clearance+radius);
    },
  });
  meshes.push(...details.meshes);diagnostics.courtyardDetails=details.diagnostics;
  diagnostics.partial = diagnostics.invalidFeatures > 0 || diagnostics.groundBudgetExhausted || diagnostics.candidateLimitReached
    || diagnostics.treesSuppressedByInvalidExclusions || diagnostics.omittedTreesByCap > 0;
  diagnostics.vertexCount = meshes.reduce((n, m) => n + m.positions.length / 3, 0);
  diagnostics.trees = treePlacements.length;
  return { meshes, diagnostics, treePlacements, decorationPlacements:details.placements };
}
