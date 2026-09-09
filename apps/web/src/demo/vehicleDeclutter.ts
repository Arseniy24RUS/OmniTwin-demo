import { actorPlaneQuad } from '../renderer/actorPhysical';
import { hashSeed } from '../renderer/rng';

/** Renderer-only input in camera-local metres; these coordinates are never moved. */
export interface VehicleGlyphCandidate {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly heading: number;
  readonly selected?: boolean;
}
export interface VehicleDeclutterDiagnostics {
  candidateCount: number;
  retainedCount: number;
  suppressedOverlap: number;
  suppressedBudget: number;
  suppressedComparisonBudget: number;
  comparisons: number;
  previousRetainedCount: number;
  /** Still-active previous members kept through a later visual overlap. */
  retainedOverlap: number;
  partial: boolean;
}
export interface VehicleDeclutterOptions {
  maxVehicles?: number;
  /** Optional caller-owned snapshot. It cannot resurrect absent or inactive IDs. */
  previousVehicleIds?: ReadonlySet<string>;
  /** Game motion keeps active instances; only overlapping new entrants are suppressed. */
  preserveActiveMembership?: boolean;
  maxComparisons?: number;
}
type Point = readonly [number, number];
interface Body<T> {
  item: T;
  rank: number;
  previous: boolean;
  center: Point;
  axes: readonly [Point, Point];
  half: Point;
}
const MAX_INPUT = 5_001;
const MAX_VEHICLES = 1_800;
const MAX_COMPARISONS = 100_000;
const CELL_METRES = 6;
const PADDING_METRES = 0.15;

function bounded(value: number | undefined, maximum: number): number {
  if (value === undefined) return maximum;
  if (!Number.isInteger(value) || value < 0 || value > maximum) throw new RangeError('Vehicle display budget is outside its bound');
  return value;
}
function body<T extends VehicleGlyphCandidate>(item: T, previousIds?: ReadonlySet<string>): Body<T> {
  const rank = hashSeed(item.id);
  // Exactly the active Deck body's size, bearing and small forward anchor offset.
  // Padding adds only a 30cm visual gap, not an isotropic road/lane exclusion zone.
  const quad = actorPlaneQuad({ kind: 'vehicle', appearance: rank % 8,
    origin: [item.x, item.y, 0], headingDegrees: item.heading }, 'body');
  const width: Point = [quad[1][0] - quad[0][0], quad[1][1] - quad[0][1]];
  const length: Point = [quad[3][0] - quad[0][0], quad[3][1] - quad[0][1]];
  const w = Math.hypot(...width); const l = Math.hypot(...length);
  return { item, rank, previous: previousIds?.has(item.id) ?? false,
    center: [(quad[0][0] + quad[2][0]) / 2, (quad[0][1] + quad[2][1]) / 2],
    axes: [[width[0] / w, width[1] / w], [length[0] / l, length[1] / l]],
    half: [w / 2 + PADDING_METRES, l / 2 + PADDING_METRES] };
}
function dot(a: Point, b: Point): number { return a[0] * b[0] + a[1] * b[1]; }
function overlaps<T>(a: Body<T>, b: Body<T>): boolean {
  const delta: Point = [b.center[0] - a.center[0], b.center[1] - a.center[1]];
  for (const axis of [...a.axes, ...b.axes]) {
    const radius = a.half[0] * Math.abs(dot(a.axes[0], axis)) + a.half[1] * Math.abs(dot(a.axes[1], axis))
      + b.half[0] * Math.abs(dot(b.axes[0], axis)) + b.half[1] * Math.abs(dot(b.axes[1], axis));
    if (Math.abs(dot(delta, axis)) >= radius - 1e-8) return false;
  }
  return true;
}

/**
 * A pure display subset, not traffic/collision simulation or population sampling.
 * Applies at a five-second presence anchor only: GPU interpolation may overlap
 * again between anchors. No schedules, identities, route positions or rosters
 * change. A game renderer can retain still-active previous members through later
 * overlaps; this is a continuous display subset, not collision simulation. New
 * entrants still respect the occupied glyphs. Cold reloads remain deterministic.
 */
export function declutterVehicleGlyphs<T extends VehicleGlyphCandidate>(
  input: readonly T[], options: VehicleDeclutterOptions = {},
): { retained: T[]; diagnostics: VehicleDeclutterDiagnostics } {
  if (input.length > MAX_INPUT) throw new RangeError('Vehicle display input exceeds its bounded pool');
  const limit = bounded(options.maxVehicles, MAX_VEHICLES);
  const comparisonLimit = bounded(options.maxComparisons, MAX_COMPARISONS);
  const ids = new Set<string>();
  for (const item of input) {
    if (!item.id || ids.has(item.id) || ![item.x, item.y, item.heading].every(Number.isFinite)
      || Math.abs(item.x) > 10_000_000 || Math.abs(item.y) > 10_000_000) throw new RangeError('Vehicle display identity or geometry is invalid');
    ids.add(item.id);
  }
  const ordered = input.map(item => body(item, options.previousVehicleIds)).sort((a, b) =>
    Number(Boolean(b.item.selected)) - Number(Boolean(a.item.selected)) || Number(b.previous) - Number(a.previous)
    || a.rank - b.rank || (a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0));
  const bins = new Map<string, Body<T>[]>();
  const retained: T[] = [];
  const diagnostics: VehicleDeclutterDiagnostics = { candidateCount: input.length, retainedCount: 0,
    suppressedOverlap: 0, suppressedBudget: 0, suppressedComparisonBudget: 0, comparisons: 0,
    previousRetainedCount: 0, retainedOverlap: 0, partial: false };
  for (const candidate of ordered) {
    if (retained.length >= limit) { diagnostics.suppressedBudget += 1; continue; }
    if (diagnostics.partial) { diagnostics.suppressedComparisonBudget += 1; continue; }
    const x = Math.floor(candidate.center[0] / CELL_METRES); const y = Math.floor(candidate.center[1] / CELL_METRES);
    let blocked = false, retainedOverlap = false;
    // The largest padded body diagonal is <6m, so 3x3 centre bins cover every
    // potential intersection, including different routes and sharp junctions.
    neighbors: for (let dx = -1; dx <= 1; dx += 1) for (let dy = -1; dy <= 1; dy += 1) {
      for (const other of bins.get(`${x + dx}:${y + dy}`) ?? []) {
        if (diagnostics.comparisons >= comparisonLimit) { diagnostics.partial = true; break neighbors; }
        diagnostics.comparisons += 1;
        if (overlaps(candidate, other)) {
          if(options.preserveActiveMembership&&candidate.previous&&other.previous){retainedOverlap=true;continue;}
          blocked = true; break neighbors;
        }
      }
    }
    if (diagnostics.partial) { diagnostics.suppressedComparisonBudget += 1; continue; }
    if (blocked) { diagnostics.suppressedOverlap += 1; continue; }
    retained.push(candidate.item); if (candidate.previous) diagnostics.previousRetainedCount += 1;
    if(retainedOverlap)diagnostics.retainedOverlap+=1;
    const key = `${x}:${y}`; const bin = bins.get(key);
    if (bin) bin.push(candidate); else bins.set(key, [candidate]);
  }
  diagnostics.retainedCount = retained.length;
  return { retained, diagnostics };
}
