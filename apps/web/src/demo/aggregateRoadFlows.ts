import type { CityRoad } from './cityRoadGraph';
import { hashSeed } from '../renderer/rng';
import type { AggregateRoadFlowSegment, AggregateRoadFlowSnapshot } from '../renderer/aggregateRoadFlow';
import { createPresentationMeterBridge } from '../renderer/presentationMeterBridge';

export type { AggregateRoadFlowSnapshot } from '../renderer/aggregateRoadFlow';
export const AGGREGATE_ROAD_FLOW_SOURCE_LABEL = 'OpenStreetMap / OpenMapTiles road geometry; schematic animated direction only, not observed traffic, individual vehicles or population.';

type Candidate = AggregateRoadFlowSegment & { distance: number; rank: number };
const compare = (a: Candidate, b: Candidate) => a.distance - b.distance || a.rank - b.rank || a.id.localeCompare(b.id);
const validPoint = (point: unknown): point is readonly [number, number] => Array.isArray(point) && point.length === 2
  && point.every(Number.isFinite) && Math.abs(point[0]) <= 180 && Math.abs(point[1]) <= 85.05112878;

/** Fixed-size max heap: the farthest retained segment is always first. */
function retainNearest(heap: Candidate[], retainedIds: Set<string>, candidate: Candidate, cap: number): void {
  if (!cap || retainedIds.has(candidate.id)) return;
  if (heap.length < cap) {
    let index = heap.length;
    heap.push(candidate);
    retainedIds.add(candidate.id);
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (compare(heap[parent]!, candidate) >= 0) break;
      heap[index] = heap[parent]!;
      index = parent;
    }
    heap[index] = candidate;
    return;
  }
  if (compare(candidate, heap[0]!) >= 0) return;
  retainedIds.delete(heap[0]!.id);
  retainedIds.add(candidate.id);
  let index = 0;
  while (index * 2 + 1 < heap.length) {
    let child = index * 2 + 1;
    if (child + 1 < heap.length && compare(heap[child + 1]!, heap[child]!) > 0) child += 1;
    if (compare(candidate, heap[child]!) >= 0) break;
    heap[index] = heap[child]!;
    index = child;
  }
  heap[index] = candidate;
}

export function buildAggregateRoadFlows(options: {
  roads: readonly CityRoad[];
  origin: readonly [number, number];
  maxInstances?: number;
  maxDistanceMeters?: number;
}): AggregateRoadFlowSnapshot {
  const { origin } = options;
  if (origin.length !== 2 || !origin.every(Number.isFinite) || Math.abs(origin[0]) > 180 || Math.abs(origin[1]) > 85.05112878) throw new RangeError('Aggregate flow origin must be valid WGS84');
  const requested = options.maxInstances ?? 96;
  if (!Number.isFinite(requested) || requested < 0) throw new RangeError('Aggregate flow cap must be finite and non-negative');
  const cap = Math.min(256, Math.floor(requested));
  const distanceLimit = Math.max(50, Math.min(20_000, options.maxDistanceMeters ?? 12_000));
  if (!Number.isFinite(distanceLimit)) throw new RangeError('Aggregate flow distance must be finite');
  const bridge = createPresentationMeterBridge(origin);
  const local = ([longitude, latitude]: readonly [number, number]): readonly [number, number, number] => bridge.fromGeographic(longitude, latitude, 0.12);
  const candidates: Candidate[] = [];
  const retainedIds = new Set<string>();
  const diagnostics = { inputRoads: options.roads.length, invalidRoads: 0, excludedNonDrivableRoads: 0,
    scannedSegments: 0, invalidSegments: 0, skippedShortSegments: 0, outsideDistanceSegments: 0,
    withinDistanceSegments: 0, peakRetainedCandidates: 0 };
  // Every loaded segment is visited to find the true nearest set, but retained
  // memory is O(cap), never O(city geometry). A malformed segment cannot abort
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
      if (distance > distanceLimit) { diagnostics.outsideDistanceSegments += 1; continue; }
      diagnostics.withinDistanceSegments += 1;
      if (cap === 0) continue;
      const sourceKey = `${road.id}:${road.coordinates[index - 1]!.join(',')}>${road.coordinates[index]!.join(',')}`;
      const rank = hashSeed(sourceKey);
      const reverse = road.oneway === -1 || (road.oneway === 0 && (rank & 1) === 1);
      const id = `road-flow-${rank.toString(16)}-${hashSeed(`flow:${sourceKey}`).toString(16)}`;
      retainNearest(candidates, retainedIds, { id, sourceRoadId: road.id, start: reverse ? b : a, end: reverse ? a : b,
        phase: ((rank >>> 4) % 997) / 997, speedMps: 7 + rank % 7, lengthMeters, distance, rank }, cap);
      diagnostics.peakRetainedCandidates = Math.max(diagnostics.peakRetainedCandidates, candidates.length);
    }
  }
  const selected = candidates.sort(compare);
  const segments = selected.map(({ distance: _distance, rank: _rank, ...segment }) => segment);
  const signature = hashSeed(`${origin.join(',')}:${JSON.stringify(segments)}`).toString(16);
  return { representation: 'schematic_road_flow', sourceLabel: AGGREGATE_ROAD_FLOW_SOURCE_LABEL, signature, origin,
    timeOriginSeconds: Date.UTC(2026, 0, 1) / 1_000, segments, diagnostics };
}
