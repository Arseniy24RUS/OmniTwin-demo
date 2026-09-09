import type { CityRoad } from './cityRoadGraph';
import { hashSeed } from '../renderer/rng';
import type { AggregateRoadFlowSegment, AggregateRoadFlowSnapshot } from '../renderer/aggregateRoadFlow';
import { createPresentationMeterBridge } from '../renderer/presentationMeterBridge';
import { WebMercatorViewport } from '@deck.gl/core';
import type { RendererViewportSnapshot } from '../renderer/types';

export type { AggregateRoadFlowSnapshot } from '../renderer/aggregateRoadFlow';
export const AGGREGATE_ROAD_FLOW_SOURCE_LABEL = 'OpenStreetMap / OpenMapTiles road geometry; schematic animated direction only, not observed traffic, individual vehicles or population.';

type Candidate = AggregateRoadFlowSegment & { distance: number; rank: number; cell: number };
const compare = (a: Candidate, b: Candidate) => a.distance - b.distance || a.rank - b.rank || a.id.localeCompare(b.id);
const compareHash = (a: Candidate, b: Candidate) => a.rank - b.rank || a.id.localeCompare(b.id);
const validPoint = (point: unknown): point is readonly [number, number] => Array.isArray(point) && point.length === 2
  && point.every(Number.isFinite) && Math.abs(point[0]) <= 180 && Math.abs(point[1]) <= 85.05112878;

/** Fixed-size max heap: the farthest retained segment is always first. */
function retainNearest(heap: Candidate[], retainedIds: Set<string>, candidate: Candidate, cap: number, order = compare): void {
  if (!cap || retainedIds.has(candidate.id)) return;
  if (heap.length < cap) {
    let index = heap.length;
    heap.push(candidate);
    retainedIds.add(candidate.id);
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (order(heap[parent]!, candidate) >= 0) break;
      heap[index] = heap[parent]!;
      index = parent;
    }
    heap[index] = candidate;
    return;
  }
  if (order(candidate, heap[0]!) >= 0) return;
  retainedIds.delete(heap[0]!.id);
  retainedIds.add(candidate.id);
  let index = 0;
  while (index * 2 + 1 < heap.length) {
    let child = index * 2 + 1;
    if (child + 1 < heap.length && order(heap[child + 1]!, heap[child]!) > 0) child += 1;
    if (order(candidate, heap[child]!) >= 0) break;
    heap[index] = heap[child]!;
    index = child;
  }
  heap[index] = candidate;
}

function removeWorst(heap: Candidate[], retainedIds: Set<string>): void {
  retainedIds.delete(heap[0]!.id);
  const last = heap.pop()!;
  if (!heap.length) return;
  let index = 0;
  while (index * 2 + 1 < heap.length) {
    let child = index * 2 + 1;
    if (child + 1 < heap.length && compareHash(heap[child + 1]!, heap[child]!) > 0) child += 1;
    if (compareHash(last, heap[child]!) >= 0) break;
    heap[index] = heap[child]!;
    index = child;
  }
  heap[index] = last;
}

/** Screen-space strata follow pitch, bearing and CSS aspect ratio, not a radius. */
function screenGrid(viewport: RendererViewportSnapshot) {
  const { widthCss, heightCss, camera } = viewport;
  if (![widthCss, heightCss].every(value => Number.isFinite(value) && value > 0)
    || !Object.values(camera).every(Number.isFinite)) throw new RangeError('Aggregate flow viewport must be finite with positive CSS dimensions');
  const projection = new WebMercatorViewport({ ...camera, width: widthCss, height: heightCss });
  const columns = Math.max(2, Math.min(8, Math.round(Math.sqrt(24 * widthCss / heightCss))));
  const rows = Math.max(2, Math.min(8, Math.round(24 / columns)));
  const matrix = projection.viewProjectionMatrix;
  const clip = (point: readonly [number, number]) => {
    const world = projection.projectPosition([point[0], point[1], 0.12]);
    return [0, 1, 2, 3].map(row => matrix[row]! * world[0] + matrix[4 + row]! * world[1] + matrix[8 + row]! * world[2] + matrix[12 + row]!);
  };
  return {
    columns, rows,
    cell(a: readonly [number, number], b: readonly [number, number]): number {
      const start = clip(a); const end = clip(b);
      if (![...start, ...end].every(Number.isFinite)) return -1;
      let enter = 0; let exit = 1;
      // Homogeneous frustum clipping also rejects geometry behind the camera.
      // Only its visible centre allocates a stratum: rendered source endpoints,
      // stable identity, speed and phase are never clipped or regenerated.
      for (let axis = 0; axis < 3; axis += 1) {
        for (const sign of [-1, 1]) {
          const from = start[3]! + sign * start[axis]!;
          const to = end[3]! + sign * end[axis]!;
          if (from < 0 && to < 0) return -1;
          if (from < 0) enter = Math.max(enter, from / (from - to));
          if (to < 0) exit = Math.min(exit, from / (from - to));
          if (enter > exit) return -1;
        }
      }
      const t = (enter + exit) / 2;
      const w = start[3]! + (end[3]! - start[3]!) * t;
      if (w <= 0) return -1;
      const x = (start[0]! + (end[0]! - start[0]!) * t) / w;
      const y = (start[1]! + (end[1]! - start[1]!) * t) / w;
      return Math.min(rows - 1, Math.max(0, Math.floor((1 - y) / 2 * rows))) * columns
        + Math.min(columns - 1, Math.max(0, Math.floor((x + 1) / 2 * columns)));
    },
  };
}

export function buildAggregateRoadFlows(options: {
  roads: readonly CityRoad[];
  origin: readonly [number, number];
  maxInstances?: number;
  maxDistanceMeters?: number;
  /** Settled actual map viewport. Before its first callback, use nearest-radius allocation. */
  viewport?: RendererViewportSnapshot;
}): AggregateRoadFlowSnapshot {
  const { origin } = options;
  if (origin.length !== 2 || !origin.every(Number.isFinite) || Math.abs(origin[0]) > 180 || Math.abs(origin[1]) > 85.05112878) throw new RangeError('Aggregate flow origin must be valid WGS84');
  const requested = options.maxInstances ?? 96;
  if (!Number.isFinite(requested) || requested < 0) throw new RangeError('Aggregate flow cap must be finite and non-negative');
  // The game overview has a separate cheap, unpickable streak budget. Existing
  // native callers keep their explicit 96/192 limits; these are never people.
  const cap = Math.min(1024, Math.floor(requested));
  // Actual viewport clipping replaces the initial radius fallback. An explicit
  // caller distance restriction still applies before allocation in either mode.
  const distanceLimit = options.viewport && options.maxDistanceMeters === undefined ? null
    : Math.max(50, Math.min(20_000, options.maxDistanceMeters ?? 12_000));
  if (distanceLimit !== null && !Number.isFinite(distanceLimit)) throw new RangeError('Aggregate flow distance must be finite');
  const bridge = createPresentationMeterBridge(origin);
  const local = ([longitude, latitude]: readonly [number, number]): readonly [number, number, number] => bridge.fromGeographic(longitude, latitude, 0.12);
  const candidates: Candidate[] = [];
  const retainedIds = new Set<string>();
  const grid = options.viewport ? screenGrid(options.viewport) : null;
  const cells = Array.from({ length: grid ? grid.columns * grid.rows : 0 }, (_, cell) => ({
    heap: [] as Candidate[], rank: hashSeed(`aggregate-cell:${grid!.columns}:${grid!.rows}:${cell}`), seen: false,
  }));
  const compareCell = (a: number, b: number) => cells[a]!.rank - cells[b]!.rank || a - b;
  const diagnostics = { inputRoads: options.roads.length, invalidRoads: 0, excludedNonDrivableRoads: 0,
    scannedSegments: 0, invalidSegments: 0, skippedShortSegments: 0, outsideDistanceSegments: 0,
    withinDistanceSegments: 0, peakRetainedCandidates: 0, allocation: grid ? 'viewport_grid' as const : 'nearest_radius' as const,
    outsideViewportSegments: 0, viewportColumns: grid?.columns ?? 0, viewportRows: grid?.rows ?? 0,
    occupiedViewportCells: 0, selectedViewportCells: 0 };
  // Every loaded segment is visited, but all cell heaps together retain at most
  // cap candidates (plus <=32 cell records), never O(city geometry). A malformed segment cannot abort
  // the world or connect two valid vertices across a missing point.
  for (const road of options.roads) {
    if (!road || typeof road.id !== 'string' || !road.id || ![-1, 0, 1].includes(road.oneway)
      || !Array.isArray(road.coordinates) || road.coordinates.length < 2) { diagnostics.invalidRoads += 1; continue; }
    if (!road.drivable) { diagnostics.excludedNonDrivableRoads += 1; continue; }
    let previous = validPoint(road.coordinates[0]) ? local(road.coordinates[0]) : null;
    for (let index = 1; index < road.coordinates.length; index += 1) {
      diagnostics.scannedSegments += 1;
      const a = previous;
      const b = validPoint(road.coordinates[index]) ? local(road.coordinates[index]!) : null;
      previous = b;
      if (!a || !b || !a.every(Number.isFinite) || !b.every(Number.isFinite)) { diagnostics.invalidSegments += 1; continue; }
      const lengthMeters = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (lengthMeters < 12) { diagnostics.skippedShortSegments += 1; continue; }
      const t = Math.max(0, Math.min(1, -(a[0] * (b[0] - a[0]) + a[1] * (b[1] - a[1])) / lengthMeters ** 2));
      const distance = Math.hypot(a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]));
      if (distanceLimit !== null && distance > distanceLimit) { diagnostics.outsideDistanceSegments += 1; continue; }
      diagnostics.withinDistanceSegments += 1;
      const cell = grid ? grid.cell(road.coordinates[index - 1]!, road.coordinates[index]!) : 0;
      if (cell < 0) { diagnostics.outsideViewportSegments += 1; continue; }
      if (grid) cells[cell]!.seen = true;
      if (cap === 0) continue;
      const sourceKey = `${road.id}:${road.coordinates[index - 1]!.join(',')}>${road.coordinates[index]!.join(',')}`;
      const rank = hashSeed(sourceKey);
      const reverse = road.oneway === -1 || (road.oneway === 0 && (rank & 1) === 1);
      const id = `road-flow-${rank.toString(16)}-${hashSeed(`flow:${sourceKey}`).toString(16)}`;
      const candidate = { id, sourceRoadId: road.id, start: reverse ? b : a, end: reverse ? a : b,
        phase: ((rank >>> 4) % 997) / 997, speedMps: 7 + rank % 7, lengthMeters, distance, rank, cell };
      if (!grid) retainNearest(candidates, retainedIds, candidate, cap);
      else if (!retainedIds.has(id)) {
        const own = cells[cell]!.heap;
        if (retainedIds.size < cap) retainNearest(own, retainedIds, candidate, cap, compareHash);
        else {
          // Equivalent to round-robin occupied cells, then hash-ranked roads
          // within each cell. Dense intersections cannot consume another cell's
          // share; sparse cells donate unused slots. Order/duplicate invariant.
          let worst = cell;
          for (let other = 0; other < cells.length; other += 1) {
            if (cells[other]!.heap.length > cells[worst]!.heap.length
              || (cells[other]!.heap.length === cells[worst]!.heap.length && compareCell(other, worst) > 0)) worst = other;
          }
          if (own.length + 1 < cells[worst]!.heap.length
            || (own.length + 1 === cells[worst]!.heap.length && compareCell(cell, worst) < 0)) {
            removeWorst(cells[worst]!.heap, retainedIds);
            retainNearest(own, retainedIds, candidate, cap, compareHash);
          } else retainNearest(own, retainedIds, candidate, own.length, compareHash);
        }
      }
      diagnostics.peakRetainedCandidates = Math.max(diagnostics.peakRetainedCandidates, retainedIds.size);
    }
  }
  diagnostics.occupiedViewportCells = cells.filter(cell => cell.seen).length;
  diagnostics.selectedViewportCells = cells.filter(cell => cell.heap.length > 0).length;
  const selected = grid ? cells.flatMap(cell => cell.heap).sort((a, b) => compareCell(a.cell, b.cell) || compareHash(a, b)) : candidates.sort(compare);
  const segments = selected.map(({ distance: _distance, rank: _rank, cell: _cell, ...segment }) => segment);
  const signature = hashSeed(`${origin.join(',')}:${JSON.stringify(segments)}`).toString(16);
  return { representation: 'schematic_road_flow', sourceLabel: AGGREGATE_ROAD_FLOW_SOURCE_LABEL, signature, origin,
    timeOriginSeconds: Date.UTC(2026, 0, 1) / 1_000, segments, diagnostics };
}
