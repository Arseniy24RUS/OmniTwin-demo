import type { Feature, MultiPolygon, Polygon } from 'geojson';
import type { CityBuildingV2, CityCellDescriptorV2, CityCellV2 } from './data/CityPackV2';
import type { VerifiedCityBuildingSnapshot } from '../renderer/verifiedCityBuildingTypes';

type Bounds = readonly [number, number, number, number];
type BuildingFeature = Feature<Polygon | MultiPolygon>;
interface Candidate {
  id: string;
  feature: BuildingFeature;
  vertices: number;
  digest: string;
  cellKey: string;
  occurrences: number;
}

export interface VerifiedCityBuildingOptions {
  datasetVersion: string;
  /** Only hash-verified active cells, never metadata-only getLayout() rows. */
  cells: readonly CityCellV2[];
  viewport?: { bbox: Bounds };
  /** Complete cell inventory from the verified manifest, not inferred spatial coverage. */
  sourceCoverage?: {
    bounds: Bounds;
    cells: readonly Pick<CityCellDescriptorV2, 'key' | 'bbox' | 'buildingCount'>[];
  };
  maxCells?: number;
  maxBuildings?: number;
  maxVertices?: number;
}

const limits = { cells: 64, buildings: 12_000, vertices: 500_000 } as const;
const compareText = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const boundedLimit = (value: number | undefined, maximum: number) =>
  value === undefined ? maximum : Number.isFinite(value) ? Math.max(0, Math.min(maximum, Math.floor(value))) : 0;

function isBounds(value: unknown): value is Bounds {
  return Array.isArray(value) && value.length === 4 && value.every(Number.isFinite)
    && value[0] >= -180 && value[2] <= 180 && value[1] >= -90 && value[3] <= 90
    && value[0] < value[2] && value[1] < value[3];
}

function isCell(cell: CityCellV2 | null | undefined): boolean {
  return Boolean(cell && cell.contract === 'DemoCityCellV2' && typeof cell.key === 'string' && cell.key !== ''
    && isBounds(cell.bbox) && Array.isArray(cell.buildings));
}

/** Streaming, key-order-independent content fingerprint. Source verification belongs to CityPackV2. */
function fingerprint(value: unknown): string {
  let a = 2166136261, b = 0x9e3779b9;
  const text = (textValue: string) => {
    for (let index = 0; index < textValue.length; index++) {
      const code = textValue.charCodeAt(index);
      a = Math.imul(a ^ code, 16777619);
      b = Math.imul(b ^ code, 2246822519);
    }
  };
  const visit = (item: unknown): void => {
    if (Array.isArray(item)) {
      text('['); for (const child of item) { visit(child); text(','); } text(']');
    } else if (item !== null && typeof item === 'object') {
      text('{');
      for (const key of Object.keys(item).sort(compareText)) {
        text(JSON.stringify(key)); text(':'); visit((item as Record<string, unknown>)[key]); text(',');
      }
      text('}');
    } else {
      text(JSON.stringify(item) ?? 'undefined');
    }
  };
  visit(value);
  return `${(a >>> 0).toString(16).padStart(8, '0')}${(b >>> 0).toString(16).padStart(8, '0')}`;
}

/** No closing, simplification, reprojection, spatial matching, or replacement geometry. */
function footprintVertices(value: unknown, budget: number): number | 'invalid' | 'over_budget' {
  if (!value || typeof value !== 'object') return 'invalid';
  const geometry = value as { type?: unknown; coordinates?: unknown };
  if (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon') return 'invalid';
  if (!Array.isArray(geometry.coordinates) || geometry.coordinates.length === 0) return 'invalid';
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  let count = 0;
  for (const polygon of polygons) {
    if (!Array.isArray(polygon) || polygon.length === 0) return 'invalid';
    for (const ring of polygon) {
      if (!Array.isArray(ring) || ring.length < 4) return 'invalid';
      let areaTwice = 0;
      for (let index = 0; index < ring.length; index++) {
        const point: unknown = ring[index];
        if (!Array.isArray(point) || point.length < 2 || !point.every(Number.isFinite)
          || Math.abs(point[0]) > 180 || Math.abs(point[1]) > 90) return 'invalid';
        count++;
        if (count > budget) return 'over_budget';
        if (index > 0) {
          const first = ring[0] as number[], previous = ring[index - 1] as number[];
          areaTwice += (previous[0]! - first[0]!) * (point[1] - first[1]!)
            - (point[0] - first[0]!) * (previous[1]! - first[1]!);
        }
      }
      const first = ring[0] as number[], last = ring[ring.length - 1] as number[];
      if (first.length !== last.length || !first.every((number, index) => number === last[index])
        || !Number.isFinite(areaTwice) || areaTwice === 0) return 'invalid';
    }
  }
  return count;
}

function featureFor(row: CityBuildingV2): BuildingFeature {
  const attributes = row.sourceAttributes ?? {};
  const minimum = typeof attributes.min_height === 'string' && attributes.min_height.trim() !== ''
    ? Number(attributes.min_height) : NaN;
  const properties: Record<string, unknown> = {
    ...attributes,
    canonical_id: row.id,
    height: row.heightM,
    height_quality: row.heightQuality,
    min_height: Number.isFinite(minimum) && minimum >= 0 && minimum <= row.heightM ? minimum : 0,
    building_use: row.use,
  };
  if (typeof row.name === 'string' && row.name !== '') properties.name = row.name;
  // The compiler stores this explicit field, although older CityBuildingV2 typings omit it.
  // Never derive it from a numeric suffix: compiled IDs and merged basemap IDs differ.
  const osmId = (row as CityBuildingV2 & { osmId?: unknown }).osmId;
  if (typeof osmId === 'string' && osmId.trim() !== '') properties.osm_id = osmId;
  return { type: 'Feature', id: row.id, properties, geometry: row.footprint as Polygon | MultiPolygon };
}

/** Bounded lexicographic top-K, with O(log K) insertion and no all-building index. */
function retainCandidate(heap: Candidate[], byId: Map<string, Candidate>, candidate: Candidate, cap: number): void {
  const duplicate = byId.get(candidate.id);
  if (duplicate) {
    const occurrences = duplicate.occurrences + 1;
    if (compareText(candidate.cellKey, duplicate.cellKey) < 0
      || candidate.cellKey === duplicate.cellKey && compareText(candidate.digest, duplicate.digest) < 0) {
      Object.assign(duplicate, candidate);
    }
    duplicate.occurrences = occurrences;
    return;
  }
  if (cap === 0 || heap.length === cap && compareText(candidate.id, heap[0]!.id) >= 0) return;
  byId.set(candidate.id, candidate);
  if (heap.length < cap) {
    heap.push(candidate);
    let index = heap.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (compareText(heap[parent]!.id, heap[index]!.id) >= 0) break;
      [heap[parent], heap[index]] = [heap[index]!, heap[parent]!]; index = parent;
    }
    return;
  }
  byId.delete(heap[0]!.id); heap[0] = candidate;
  let index = 0;
  for (;;) {
    const left = index * 2 + 1, right = left + 1;
    if (left >= heap.length) break;
    const largest = right < heap.length && compareText(heap[right]!.id, heap[left]!.id) > 0 ? right : left;
    if (compareText(heap[index]!.id, heap[largest]!.id) >= 0) break;
    [heap[index], heap[largest]] = [heap[largest]!, heap[index]!]; index = largest;
  }
}

/** Exact rectangle-union sweep; inspecting only viewport corners misses interior holes. */
function coversViewport(cells: readonly CityCellV2[], viewport: Bounds): boolean {
  const rectangles = cells.map(cell => [
    Math.max(viewport[0], cell.bbox[0]), Math.max(viewport[1], cell.bbox[1]),
    Math.min(viewport[2], cell.bbox[2]), Math.min(viewport[3], cell.bbox[3]),
  ] as Bounds).filter(box => box[0] < box[2] && box[1] < box[3]);
  const edges = [...new Set([viewport[0], viewport[2], ...rectangles.flatMap(box => [box[0], box[2]])])].sort((a, b) => a - b);
  for (let index = 1; index < edges.length; index++) {
    const west = edges[index - 1]!, east = edges[index]!;
    const intervals = rectangles.filter(box => box[0] <= west && box[2] >= east)
      .map(box => [box[1], box[3]] as const).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let coveredTo = viewport[1];
    for (const [south, north] of intervals) {
      if (south > coveredTo) return false;
      coveredTo = Math.max(coveredTo, north);
      if (coveredTo >= viewport[3]) break;
    }
    if (coveredTo < viewport[3]) return false;
  }
  return true;
}

/**
 * build-city-pack-v2.mjs places each whole footprint in every intersected z16
 * cell. The verified manifest therefore distinguishes empty water/road-only
 * cells from missing populated cells, without runtime joins or new geometry.
 */
function coversSourceInventory(
  loaded: ReadonlyMap<string, CityCellV2>,
  viewport: Bounds,
  inventory: NonNullable<VerifiedCityBuildingOptions['sourceCoverage']>,
): boolean {
  if (!isBounds(inventory.bounds) || !Array.isArray(inventory.cells)
    || viewport[0] < inventory.bounds[0] || viewport[1] < inventory.bounds[1]
    || viewport[2] > inventory.bounds[2] || viewport[3] > inventory.bounds[3]) return false;
  for (const descriptor of inventory.cells) {
    if (!descriptor || typeof descriptor.key !== 'string' || descriptor.key === '' || !isBounds(descriptor.bbox)
      || !Number.isSafeInteger(descriptor.buildingCount) || descriptor.buildingCount < 0) return false;
    const box: Bounds = descriptor.bbox;
    if (descriptor.buildingCount === 0 || box[0] >= viewport[2] || box[2] <= viewport[0]
      || box[1] >= viewport[3] || box[3] <= viewport[1]) continue;
    const cell = loaded.get(descriptor.key);
    if (!cell || cell.buildings.length !== descriptor.buildingCount
      || !box.every((value, index) => value === cell.bbox[index])) return false;
  }
  return true;
}

/** Expand only through source area already proved complete; never assume that
 * a loaded-cell bounding box covers its missing interior or neighboring cells. */
function retainedCoverageBounds(cells:readonly CityCellV2[],bounds:Bounds,covers:(bounds:Bounds)=>boolean):Bounds {
  let result=[...bounds] as [number,number,number,number];
  for(const side of [0,2,1,3] as const){
    const lower=side<2;
    const edges=[...new Set(cells.map(cell=>cell.bbox[side]).filter(edge=>lower?edge<result[side]:edge>result[side]))]
      .sort((a,b)=>lower?a-b:b-a);
    for(const edge of edges){
      const candidate=[...result] as [number,number,number,number];candidate[side]=edge;
      if(covers(candidate)){result=candidate;break;}
    }
  }
  return result;
}

/**
 * Render/pick the exact footprints from verified active cells. Retains at most 64
 * cells, 12,000 building candidates and 500,000 emitted vertices; never clips a
 * building. Bounds are conservative: any invalid/omitted source row makes the
 * result partial. Omission diagnostics count source rows before deduplication,
 * so duplicate omitted records are not disguised as a unique-building census.
 */
export function buildVerifiedCityBuildings(options: VerifiedCityBuildingOptions): VerifiedCityBuildingSnapshot {
  const maxCells = boundedLimit(options.maxCells, limits.cells);
  const maxBuildings = boundedLimit(options.maxBuildings, limits.buildings);
  const maxVertices = boundedLimit(options.maxVertices, limits.vertices);
  const retainedCells = new Map<string, CityCellV2>();
  let invalidBuildings = 0, incompleteCells = false;
  for (const cell of options.cells) {
    if (!isCell(cell)) {
      invalidBuildings += Array.isArray(cell?.buildings) ? cell.buildings.length : 0;
      incompleteCells = true; continue;
    }
    const duplicate = retainedCells.get(cell.key);
    if (duplicate) {
      if (duplicate !== cell && compareText(fingerprint([cell.bbox, cell.buildings]), fingerprint([duplicate.bbox, duplicate.buildings])) < 0) {
        retainedCells.set(cell.key, cell);
      }
      continue;
    }
    if (retainedCells.size < maxCells) { retainedCells.set(cell.key, cell); continue; }
    incompleteCells = true;
    const largestKey = [...retainedCells.keys()].sort(compareText).at(-1);
    if (largestKey !== undefined && compareText(cell.key, largestKey) < 0) {
      retainedCells.delete(largestKey); retainedCells.set(cell.key, cell);
    }
  }
  // Count against the final retained keys, not heap eviction order. Repeated
  // omitted source records remain explicit without retaining an unbounded set.
  const omittedCellRows = options.cells.reduce((count, cell) => count
    + (isCell(cell) && !retainedCells.has(cell.key) ? cell.buildings.length : 0), 0);
  const cells = [...retainedCells.values()].sort((a, b) => compareText(a.key, b.key));
  const heap: Candidate[] = [], byId = new Map<string, Candidate>();
  let validRows = 0;
  for (const cell of cells) {
    for (const row of cell.buildings) {
      if (!row || typeof row.id !== 'string' || row.id.trim() === '' || !Number.isFinite(row.heightM) || row.heightM <= 0) {
        invalidBuildings++; continue;
      }
      const vertices = footprintVertices(row.footprint, maxVertices);
      if (vertices === 'invalid') { invalidBuildings++; continue; }
      validRows++;
      if (vertices === 'over_budget' || maxBuildings === 0) continue;
      if (!byId.has(row.id) && heap.length === maxBuildings && compareText(row.id, heap[0]!.id) >= 0) continue;
      const feature = featureFor(row);
      retainCandidate(heap, byId, { id: row.id, feature, vertices, digest: fingerprint(feature), cellKey: cell.key, occurrences: 1 }, maxBuildings);
    }
  }
  const features: BuildingFeature[] = [], digests: string[] = [], canonicalIds = new Set<string>();
  let vertexCount = 0, representedRows = 0;
  for (const candidate of heap.sort((a, b) => compareText(a.id, b.id))) {
    if (vertexCount + candidate.vertices > maxVertices) continue;
    features.push(candidate.feature); digests.push(candidate.digest); canonicalIds.add(candidate.id);
    vertexCount += candidate.vertices; representedRows += candidate.occurrences;
  }
  const omittedBuildings = omittedCellRows + validRows - representedRows;
  const bounds = options.viewport?.bbox;
  const hasSourceCoverage = isBounds(bounds) && (options.sourceCoverage
    ? coversSourceInventory(retainedCells, bounds, options.sourceCoverage) : coversViewport(cells, bounds));
  const coverage = !isBounds(bounds) ? 'unresolved'
    : incompleteCells || invalidBuildings > 0 || omittedBuildings > 0 || !hasSourceCoverage
      ? 'partial_viewport' : 'complete_viewport';
  const coverageBounds=coverage==='complete_viewport'?retainedCoverageBounds(cells,bounds!,candidate=>options.sourceCoverage
    ?coversSourceInventory(retainedCells,candidate,options.sourceCoverage):coversViewport(cells,candidate)):null;
  // Metadata can refresh independently; camera-only coverage changes must not
  // trigger a GeoJSON source rebuild when the emitted content is unchanged.
  const signature = fingerprint([options.datasetVersion, cells.map(cell => [cell.key, cell.bbox]), digests]);
  return { datasetVersion: options.datasetVersion, signature, data: { type: 'FeatureCollection', features }, canonicalIds,
    cells: cells.map(cell => cell.key), coverage, coverageBounds, omittedBuildings, invalidBuildings, vertexCount };
}
