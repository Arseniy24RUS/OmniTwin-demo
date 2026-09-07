import { createDeterministicRng, hashSeed } from '../rng';
import { universalVegetationProfile } from './lod';
import {
  isGeoPosition,
  sourceIdentityKey,
  type GeoPosition,
  type UniversalQualityTier,
  type UniversalSourceIdentity,
  type VisualSynthesisDisclosure,
} from './types';

export type PolygonCoordinates = readonly (readonly GeoPosition[])[];
export type MultiPolygonCoordinates = readonly PolygonCoordinates[];

export type VegetationSourceIdentityDecision =
  | 'source_feature_id'
  | 'provider_derived_geometry_hash';

interface VegetationSourceIdentityMetadata {
  readonly sourceIdentityDecision?: VegetationSourceIdentityDecision;
  readonly sourceLayer?: string | null;
}

export interface SourceTreeFeature extends UniversalSourceIdentity, VegetationSourceIdentityMetadata {
  readonly kind: 'tree';
  readonly coordinate: GeoPosition;
  readonly species?: string | null;
}

export interface SourceForestFeature extends UniversalSourceIdentity, VegetationSourceIdentityMetadata {
  readonly kind: 'forest';
  /** Tile-normalized WGS84 polygons. The first ring is outer; following rings are holes. */
  readonly polygons: MultiPolygonCoordinates;
  readonly forestClass?: string | null;
}

export type SourceVegetationFeature = SourceTreeFeature | SourceForestFeature;

export type VegetationGeometryQuality = 'exact_tree_point' | 'area_derived';
export type VegetationSpriteFamily = 'deciduous' | 'conifer' | 'shrub';

export interface VegetationClassification extends VisualSynthesisDisclosure {
  readonly sourceKey: string;
  readonly sourceBacked: true;
  readonly geometryQuality: VegetationGeometryQuality;
  readonly sourceIdentityDecision: VegetationSourceIdentityDecision;
  readonly renderMode: 'low_poly_tree' | 'low_poly_forest_canopy';
}

export interface VegetationRenderInstance extends VegetationClassification {
  readonly id: string;
  readonly coordinate: GeoPosition;
  readonly rotationDegrees: number;
  readonly scale: number;
  readonly colorVariant: number;
  readonly spriteFamily: VegetationSpriteFamily;
  readonly spriteVariant: number;
  readonly seed: number;
}

export interface GenerateVegetationOptions {
  readonly zoom: number;
  readonly qualityTier: UniversalQualityTier;
  readonly seed?: string | number;
  readonly maximumInstances?: number;
}

/** Minimal structural subset returned by MapLibre querySourceFeatures(). */
export interface QuerySourceVegetationFeatureLike {
  readonly id?: unknown;
  readonly sourceLayer?: unknown;
  readonly sourceTileKey?: unknown;
  readonly geometry?: {
    readonly type?: unknown;
    readonly coordinates?: unknown;
  } | null;
  readonly properties?: Readonly<Record<string, unknown>> | null;
}

export interface ExtractSourceVegetationOptions {
  readonly sourceId: string;
  readonly datasetVersion: string;
  /** Ordered provider-declared stable ID properties used only when feature.id is absent. */
  readonly featureIdProperties?: readonly string[];
}

const VEGETATION_DISCLOSURE = {
  provenance: 'visual_synthesis',
  temporalMapping: 'visual_synthesis',
  scientificClaim: false,
} as const;

const WEB_MERCATOR_CIRCUMFERENCE_METERS = 40_075_016.685_578_49;
const WEB_MERCATOR_MAX_LATITUDE = 85.051_128_78;
const MAX_GRID_CELLS_PER_FEATURE = 100_000;

type ProjectedPosition = readonly [x: number, y: number];
type ProjectedRing = readonly ProjectedPosition[];
type ProjectedPolygon = readonly ProjectedRing[];

interface ForestGridCandidate {
  readonly coordinate: GeoPosition;
  readonly idKey: string;
  readonly priority: number;
}

function normalizedFeatureId(value: unknown): string | number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizedOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function firstPropertyString(
  properties: Readonly<Record<string, unknown>> | null | undefined,
  keys: readonly string[],
): string | null {
  if (!properties) return null;
  for (const key of keys) {
    const value = normalizedOptionalString(properties[key]);
    if (value) return value;
  }
  return null;
}

function parseGeoPosition(value: unknown): GeoPosition | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const longitude = value[0];
  const latitude = value[1];
  if (typeof longitude !== 'number' || typeof latitude !== 'number') return null;
  const position: GeoPosition = [longitude, latitude];
  return isGeoPosition(position) ? position : null;
}

function parseRing(value: unknown): readonly GeoPosition[] | null {
  if (!Array.isArray(value)) return null;
  const positions = value.map(parseGeoPosition);
  if (positions.length < 3 || positions.some((position) => position === null)) return null;
  return positions as readonly GeoPosition[];
}

function parsePolygon(value: unknown): PolygonCoordinates | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const rings = value.map(parseRing);
  if (rings.some((ring) => ring === null)) return null;
  return rings as PolygonCoordinates;
}

function parseMultiPolygon(value: unknown): MultiPolygonCoordinates | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const polygons = value.map(parsePolygon);
  if (polygons.some((polygon) => polygon === null)) return null;
  return polygons as MultiPolygonCoordinates;
}

function canonicalCoordinate(position: GeoPosition): string {
  const longitude = Object.is(position[0], -0) ? 0 : position[0];
  const latitude = Object.is(position[1], -0) ? 0 : position[1];
  return `${longitude},${latitude}`;
}

function leastCyclicRotation(tokens: readonly string[]): readonly string[] {
  if (tokens.length <= 1) return tokens;
  const doubled = [...tokens, ...tokens];
  let left = 0;
  let right = 1;
  let offset = 0;
  while (left < tokens.length && right < tokens.length && offset < tokens.length) {
    const comparison = doubled[left + offset]!.localeCompare(doubled[right + offset]!);
    if (comparison === 0) {
      offset += 1;
      continue;
    }
    if (comparison > 0) {
      left += offset + 1;
      if (left === right) left += 1;
    } else {
      right += offset + 1;
      if (left === right) right += 1;
    }
    offset = 0;
  }
  const start = Math.min(left, right);
  return doubled.slice(start, start + tokens.length);
}

function canonicalRingIdentity(ring: readonly GeoPosition[]): string {
  const tokens = ring.map(canonicalCoordinate);
  if (tokens.length > 1 && tokens[0] === tokens[tokens.length - 1]) tokens.pop();
  const forward = leastCyclicRotation(tokens).join(';');
  const reverse = leastCyclicRotation([...tokens].reverse()).join(';');
  return forward.localeCompare(reverse) <= 0 ? forward : reverse;
}

function canonicalPolygonIdentity(polygon: PolygonCoordinates): string {
  const outer = canonicalRingIdentity(polygon[0]!);
  const holes = polygon.slice(1).map(canonicalRingIdentity).sort();
  return [outer, ...holes].join('|');
}

function canonicalMultiPolygonIdentity(polygons: MultiPolygonCoordinates): string {
  return polygons.map(canonicalPolygonIdentity).sort().join('||');
}

function providerDerivedAreaFeatureId(
  sourceId: string,
  datasetVersion: string,
  sourceLayer: string | null,
  forestClass: string | null,
  polygons: MultiPolygonCoordinates,
): string {
  const canonical = [
    sourceId,
    datasetVersion,
    sourceLayer ?? 'area',
    forestClass ?? 'unclassified',
    canonicalMultiPolygonIdentity(polygons),
  ].join('\u0000');
  return `provider-area-${hashSeed(canonical).toString(16).padStart(8, '0')}-${hashSeed(`${canonical}:identity`).toString(16).padStart(8, '0')}`;
}

function validateRing(ring: readonly GeoPosition[]): void {
  if (ring.length < 3 || ring.some((position) => !isGeoPosition(position))) {
    throw new RangeError('Vegetation polygon rings require at least three valid WGS84 positions');
  }
}

function validateFeature(feature: SourceVegetationFeature): void {
  sourceIdentityKey(feature);
  if (feature.kind === 'tree') {
    if (!isGeoPosition(feature.coordinate)) {
      throw new RangeError('Source tree requires a valid WGS84 point');
    }
    return;
  }
  if (feature.polygons.length === 0) {
    throw new RangeError('Source forest requires at least one polygon');
  }
  for (const polygon of feature.polygons) {
    if (polygon.length === 0) throw new RangeError('Source forest polygon requires an outer ring');
    for (const ring of polygon) validateRing(ring);
  }
}

export function classifyVegetationFeature(
  feature: SourceVegetationFeature,
): VegetationClassification {
  validateFeature(feature);
  const exact = feature.kind === 'tree';
  const sourceIdentityDecision = feature.sourceIdentityDecision ?? 'source_feature_id';
  const identityDisclosure = sourceIdentityDecision === 'provider_derived_geometry_hash'
    ? ' · ID рассчитан из полной геометрии источника'
    : '';
  return {
    sourceKey: sourceIdentityKey(feature),
    sourceBacked: true,
    geometryQuality: exact ? 'exact_tree_point' : 'area_derived',
    sourceIdentityDecision,
    renderMode: exact ? 'low_poly_tree' : 'low_poly_forest_canopy',
    ...VEGETATION_DISCLOSURE,
    displayLabel: exact
      ? 'Дерево · точка из источника · low-poly представление'
      : `Лесной полог · размещение рассчитано внутри исходного полигона${identityDisclosure}`,
  };
}

function unwrapLongitude(longitude: number, reference: number): number {
  let result = longitude;
  while (result - reference > 180) result -= 360;
  while (result - reference < -180) result += 360;
  return result;
}

function unwrapRing(
  ring: readonly GeoPosition[],
  initialReference = ring[0]?.[0] ?? 0,
): readonly GeoPosition[] {
  const result: GeoPosition[] = [];
  let reference = initialReference;
  for (const [longitude, latitude] of ring) {
    const unwrapped = unwrapLongitude(longitude, reference);
    result.push([unwrapped, latitude]);
    reference = unwrapped;
  }
  return result;
}

function ringAreaSquareMeters(ring: readonly GeoPosition[]): number {
  const unwrapped = unwrapRing(ring);
  const meanLatitude = unwrapped.reduce((sum, position) => sum + position[1], 0)
    / unwrapped.length;
  const metersPerLongitudeDegree = 111_320 * Math.cos(meanLatitude * Math.PI / 180);
  const metersPerLatitudeDegree = 110_574;
  let doubledArea = 0;
  for (let index = 0; index < unwrapped.length; index += 1) {
    const current = unwrapped[index]!;
    const next = unwrapped[(index + 1) % unwrapped.length]!;
    doubledArea += current[0] * metersPerLongitudeDegree * next[1] * metersPerLatitudeDegree
      - next[0] * metersPerLongitudeDegree * current[1] * metersPerLatitudeDegree;
  }
  return Math.abs(doubledArea) / 2;
}

function polygonAreaSquareMeters(polygon: PolygonCoordinates): number {
  const outer = polygon[0];
  if (!outer) return 0;
  const holes = polygon.slice(1).reduce((sum, ring) => sum + ringAreaSquareMeters(ring), 0);
  return Math.max(0, ringAreaSquareMeters(outer) - holes);
}

function featureAreaSquareMeters(feature: SourceForestFeature): number {
  return feature.polygons.reduce((sum, polygon) => sum + polygonAreaSquareMeters(polygon), 0);
}

function pointInProjectedRing(position: ProjectedPosition, ring: ProjectedRing): boolean {
  let inside = false;
  for (let currentIndex = 0, previousIndex = ring.length - 1;
    currentIndex < ring.length;
    previousIndex = currentIndex, currentIndex += 1) {
    const current = ring[currentIndex];
    const previous = ring[previousIndex];
    const crossesLatitude = (current[1] > position[1]) !== (previous[1] > position[1]);
    const longitudeAtLatitude = (previous[0] - current[0])
      * (position[1] - current[1]) / ((previous[1] - current[1]) || Number.EPSILON)
      + current[0];
    if (crossesLatitude && position[0] < longitudeAtLatitude) inside = !inside;
  }
  return inside;
}

function pointInProjectedPolygon(
  position: ProjectedPosition,
  polygon: ProjectedPolygon,
): boolean {
  const outer = polygon[0];
  return Boolean(outer)
    && pointInProjectedRing(position, outer!)
    && polygon.slice(1).every((hole) => !pointInProjectedRing(position, hole));
}

function projectLongitude(longitude: number): number {
  return ((longitude + 180) / 360) * WEB_MERCATOR_CIRCUMFERENCE_METERS;
}

function projectLatitude(latitude: number): number {
  const clamped = Math.max(
    -WEB_MERCATOR_MAX_LATITUDE,
    Math.min(WEB_MERCATOR_MAX_LATITUDE, latitude),
  );
  const radians = clamped * Math.PI / 180;
  const normalized = (1 - Math.log(Math.tan(Math.PI / 4 + radians / 2)) / Math.PI) / 2;
  return normalized * WEB_MERCATOR_CIRCUMFERENCE_METERS;
}

function unprojectPosition([x, y]: ProjectedPosition): GeoPosition {
  const unwrappedLongitude = x / WEB_MERCATOR_CIRCUMFERENCE_METERS * 360 - 180;
  const longitude = ((unwrappedLongitude + 180) % 360 + 360) % 360 - 180;
  const normalizedY = y / WEB_MERCATOR_CIRCUMFERENCE_METERS;
  const latitude = Math.atan(Math.sinh(Math.PI * (1 - 2 * normalizedY))) * 180 / Math.PI;
  return [longitude, latitude];
}

function projectPolygon(polygon: PolygonCoordinates): ProjectedPolygon {
  const outerUnwrapped = unwrapRing(polygon[0]!);
  const outerReference = outerUnwrapped.reduce((sum, position) => sum + position[0], 0)
    / outerUnwrapped.length;
  return polygon.map((ring, index) => {
    const unwrapped = index === 0 ? outerUnwrapped : unwrapRing(ring, outerReference);
    return unwrapped.map(([longitude, latitude]) => [
      projectLongitude(longitude),
      projectLatitude(latitude),
    ] as const);
  });
}

function projectedBounds(polygon: ProjectedPolygon): readonly [number, number, number, number] {
  let minimumX = Number.POSITIVE_INFINITY;
  let minimumY = Number.POSITIVE_INFINITY;
  let maximumX = Number.NEGATIVE_INFINITY;
  let maximumY = Number.NEGATIVE_INFINITY;
  for (const ring of polygon) {
    for (const [x, y] of ring) {
      minimumX = Math.min(minimumX, x);
      minimumY = Math.min(minimumY, y);
      maximumX = Math.max(maximumX, x);
      maximumY = Math.max(maximumY, y);
    }
  }
  return [minimumX, minimumY, maximumX, maximumY];
}

function qualityAreaPerTree(tier: UniversalQualityTier): number {
  if (tier === 'high') return 625;
  if (tier === 'mid') return 1_600;
  return 3_600;
}

function stableFeatureKey(feature: SourceVegetationFeature): string {
  return [
    feature.kind,
    feature.sourceId.trim(),
    feature.datasetVersion.trim(),
    typeof feature.sourceFeatureId,
    String(feature.sourceFeatureId).trim(),
  ].join('\u0000');
}

function stableAreaCellKey(
  feature: SourceForestFeature,
  gridColumns: number,
  canonicalCellX: number,
  cellY: number,
): string {
  return [
    'area',
    feature.sourceId.trim(),
    feature.datasetVersion.trim(),
    gridColumns,
    canonicalCellX,
    cellY,
  ].join('\u0000');
}

function spriteFamilyForFeature(feature: SourceVegetationFeature): VegetationSpriteFamily {
  const description = (feature.kind === 'tree' ? feature.species : feature.forestClass)
    ?.trim()
    .toLocaleLowerCase('en-US') ?? '';
  if (/(shrub|bush|кустар)/u.test(description)) return 'shrub';
  if (/(conifer|pine|spruce|fir|cedar|larch|сос|ел|пихт|кедр|листвен)/u.test(description)) {
    return 'conifer';
  }
  return 'deciduous';
}

function makeInstance(
  classification: VegetationClassification,
  coordinate: GeoPosition,
  idKey: string,
  seed: number,
  spriteFamily: VegetationSpriteFamily,
): VegetationRenderInstance {
  const rng = createDeterministicRng(seed);
  const spriteVariantCount = spriteFamily === 'deciduous' ? 8 : 4;
  return {
    ...classification,
    id: `vegetation-${hashSeed(idKey).toString(16).padStart(8, '0')}-${hashSeed(`${idKey}:id`).toString(16).padStart(8, '0')}`,
    coordinate,
    rotationDegrees: rng() * 360,
    scale: 0.82 + rng() * 0.38,
    colorVariant: Math.floor(rng() * 4),
    spriteFamily,
    spriteVariant: Math.floor(rng() * spriteVariantCount),
    seed,
  };
}

function allocateForestCounts(
  features: readonly SourceForestFeature[],
  available: number,
  areaPerTree: number,
): readonly number[] {
  const desired = features.map((feature) => Math.max(
    1,
    Math.ceil(featureAreaSquareMeters(feature) / areaPerTree),
  ));
  const desiredTotal = desired.reduce((sum, value) => sum + value, 0);
  if (desiredTotal <= available) return desired;
  const allocated = desired.map((value) => Math.min(
    value,
    Math.floor(available * value / desiredTotal),
  ));
  let remaining = available - allocated.reduce((sum, value) => sum + value, 0);
  const priority = features
    .map((feature, index) => ({ index, priority: hashSeed(sourceIdentityKey(feature)) }))
    .sort((left, right) => left.priority - right.priority);
  while (remaining > 0) {
    let assigned = false;
    for (const item of priority) {
      if (remaining === 0) break;
      if (allocated[item.index] >= desired[item.index]) continue;
      allocated[item.index] += 1;
      remaining -= 1;
      assigned = true;
    }
    if (!assigned) break;
  }
  return allocated;
}

function collectForestGridCandidates(
  feature: SourceForestFeature,
  seed: string | number,
  gridColumns: number,
  candidates: Map<string, ForestGridCandidate>,
): void {
  const cellSize = WEB_MERCATOR_CIRCUMFERENCE_METERS / gridColumns;
  const featureKey = stableFeatureKey(feature);

  for (const sourcePolygon of feature.polygons) {
    const polygon = projectPolygon(sourcePolygon);
    const [minimumX, minimumY, maximumX, maximumY] = projectedBounds(polygon);
    const firstCellX = Math.floor(minimumX / cellSize);
    const lastCellX = Math.floor(maximumX / cellSize);
    const firstCellY = Math.floor(minimumY / cellSize);
    const lastCellY = Math.floor(maximumY / cellSize);
    const columnCount = Math.max(0, lastCellX - firstCellX + 1);
    const rowCount = Math.max(0, lastCellY - firstCellY + 1);
    const stride = Math.max(
      1,
      Math.ceil(Math.sqrt(columnCount * rowCount / MAX_GRID_CELLS_PER_FEATURE)),
    );
    const strideOffsetX = hashSeed(`${featureKey}:stride-x`) % stride;
    const strideOffsetY = hashSeed(`${featureKey}:stride-y`) % stride;

    for (let cellY = firstCellY; cellY <= lastCellY; cellY += 1) {
      if (((cellY % stride) + stride) % stride !== strideOffsetY) continue;
      for (let cellX = firstCellX; cellX <= lastCellX; cellX += 1) {
        if (((cellX % stride) + stride) % stride !== strideOffsetX) continue;
        const canonicalCellX = ((cellX % gridColumns) + gridColumns) % gridColumns;
        const idKey = stableAreaCellKey(feature, gridColumns, canonicalCellX, cellY);
        if (candidates.has(idKey)) continue;
        const rng = createDeterministicRng(`${seed}:grid:${canonicalCellX}:${cellY}`);
        const position: ProjectedPosition = [
          (cellX + 0.15 + rng() * 0.7) * cellSize,
          (cellY + 0.15 + rng() * 0.7) * cellSize,
        ];
        if (!pointInProjectedPolygon(position, polygon)) continue;
        candidates.set(idKey, {
          coordinate: unprojectPosition(position),
          idKey,
          priority: hashSeed(`${seed}:priority:${idKey}`),
        });
      }
    }
  }
}

function sampleForest(
  feature: SourceForestFeature,
  count: number,
  seed: string | number,
  tier: UniversalQualityTier,
): readonly ForestGridCandidate[] {
  if (count <= 0) return [];
  const areaPerTree = qualityAreaPerTree(tier);
  const targetSpacing = Math.sqrt(areaPerTree);
  const baseGridColumns = Math.max(
    1,
    Math.round(WEB_MERCATOR_CIRCUMFERENCE_METERS / targetSpacing),
  );
  const candidates = new Map<string, ForestGridCandidate>();
  const tinySourcePolygon = featureAreaSquareMeters(feature) < areaPerTree;
  // A fixed refinement keeps the same wrapped global cells on every tile and
  // avoids the viewport-dependent popping caused by retrying at variable grids.
  const refinementFactors = tinySourcePolygon ? [16] : [1];
  for (const factor of refinementFactors) {
    collectForestGridCandidates(feature, seed, baseGridColumns * factor, candidates);
    if (candidates.size > 0) break;
  }

  return [...candidates.values()]
    .sort((left, right) => left.priority - right.priority || left.idKey.localeCompare(right.idKey))
    .slice(0, count);
}

function polygonIdentity(polygon: PolygonCoordinates): string {
  return canonicalPolygonIdentity(polygon);
}

/** Merges repeated or tile-clipped copies without inventing a screen-derived identity. */
function mergeSourceFeatures(
  features: readonly SourceVegetationFeature[],
): readonly SourceVegetationFeature[] {
  const ordered = [...features].sort((left, right) => (
    sourceIdentityKey(left).localeCompare(sourceIdentityKey(right))
  ));
  const exact = new Map<string, SourceTreeFeature>();
  const forests = new Map<string, {
    representative: SourceForestFeature;
    polygons: Map<string, PolygonCoordinates>;
    forestClasses: Set<string>;
  }>();
  for (const feature of ordered) {
    const key = stableFeatureKey(feature);
    if (feature.kind === 'tree') {
      const existing = exact.get(key);
      if (existing && (
        existing.coordinate[0] !== feature.coordinate[0]
        || existing.coordinate[1] !== feature.coordinate[1]
      )) {
        throw new RangeError(`Source tree identity has conflicting coordinates: ${key}`);
      }
      if (!existing) exact.set(key, feature);
      continue;
    }
    let group = forests.get(key);
    if (!group) {
      group = {
        representative: feature,
        polygons: new Map(),
        forestClasses: new Set(),
      };
      forests.set(key, group);
    }
    for (const polygon of feature.polygons) {
      const identity = polygonIdentity(polygon);
      if (!group.polygons.has(identity)) group.polygons.set(identity, polygon);
    }
    const forestClass = feature.forestClass?.trim();
    if (forestClass) group.forestClasses.add(forestClass);
  }
  const merged: Array<{ key: string; feature: SourceVegetationFeature }> = [
    ...[...exact.entries()].map(([key, feature]) => ({
      key,
      feature: { ...feature, sourceTileKey: undefined },
    })),
    ...[...forests.entries()].map(([key, group]) => ({
      key,
      feature: {
        ...group.representative,
        sourceTileKey: undefined,
        polygons: [...group.polygons.entries()]
          .sort((left, right) => left[0].localeCompare(right[0]))
          .map((entry) => entry[1]),
        forestClass: [...group.forestClasses].sort()[0]
          ?? group.representative.forestClass
          ?? null,
      },
    })),
  ];
  return merged
    .sort((left, right) => left.key.localeCompare(right.key))
    .map((item) => item.feature);
}

/**
 * Converts source-query rows into the strict source-backed vegetation model.
 * Unsupported rows and unidentified Point rows are ignored. Area rows without
 * an upstream ID receive a disclosed provider-derived hash of their complete,
 * canonical geometry. Repeated identical tile fragments therefore dedupe.
 */
export function extractSourceVegetationFeatures(
  rows: readonly QuerySourceVegetationFeatureLike[],
  options: ExtractSourceVegetationOptions,
): readonly SourceVegetationFeature[] {
  const sourceId = options.sourceId.trim();
  const datasetVersion = options.datasetVersion.trim();
  if (!sourceId) throw new RangeError('Vegetation extraction requires sourceId');
  if (!datasetVersion) throw new RangeError('Vegetation extraction requires datasetVersion');
  const featureIdProperties = options.featureIdProperties ?? ['id', 'osm_id', 'fid'];
  const extracted: SourceVegetationFeature[] = [];

  for (const row of rows) {
    let sourceFeatureId = normalizedFeatureId(row.id);
    if (sourceFeatureId === null && row.properties) {
      for (const propertyName of featureIdProperties) {
        sourceFeatureId = normalizedFeatureId(row.properties[propertyName]);
        if (sourceFeatureId !== null) break;
      }
    }
    const geometryType = row.geometry?.type;
    const sourceTileKey = normalizedOptionalString(row.sourceTileKey);
    const sourceLayer = normalizedOptionalString(row.sourceLayer);

    if (geometryType === 'Point') {
      if (sourceFeatureId === null) continue;
      const coordinate = parseGeoPosition(row.geometry?.coordinates);
      if (!coordinate) continue;
      extracted.push({
        sourceId,
        datasetVersion,
        sourceFeatureId,
        ...(sourceTileKey ? { sourceTileKey } : {}),
        kind: 'tree',
        sourceIdentityDecision: 'source_feature_id',
        sourceLayer,
        coordinate,
        species: firstPropertyString(row.properties, [
          'species',
          'species:en',
          'genus',
          'taxon',
        ]),
      });
      continue;
    }

    const polygons = geometryType === 'Polygon'
      ? (() => {
          const polygon = parsePolygon(row.geometry?.coordinates);
          return polygon ? [polygon] : null;
        })()
      : geometryType === 'MultiPolygon'
        ? parseMultiPolygon(row.geometry?.coordinates)
        : null;
    if (!polygons) continue;
    const forestClass = firstPropertyString(row.properties, [
      'forest_class',
      'class',
      'subclass',
      'landuse',
      'natural',
      'type',
    ]);
    const sourceIdentityDecision: VegetationSourceIdentityDecision = sourceFeatureId === null
      ? 'provider_derived_geometry_hash'
      : 'source_feature_id';
    sourceFeatureId ??= providerDerivedAreaFeatureId(
      sourceId,
      datasetVersion,
      sourceLayer,
      forestClass,
      polygons,
    );
    extracted.push({
      sourceId,
      datasetVersion,
      sourceFeatureId,
      ...(sourceTileKey ? { sourceTileKey } : {}),
      kind: 'forest',
      sourceIdentityDecision,
      sourceLayer,
      polygons,
      forestClass,
    });
  }

  return mergeSourceFeatures(extracted);
}

/**
 * Creates source-constrained low-poly vegetation at detail LOD. Exact source
 * tree points are retained; forest instances are visibly marked area-derived.
 */
export function generateVegetationInstances(
  features: readonly SourceVegetationFeature[],
  options: GenerateVegetationOptions,
): readonly VegetationRenderInstance[] {
  for (const feature of features) validateFeature(feature);
  const profile = universalVegetationProfile(options.qualityTier, options.zoom);
  if (!profile.enabled) return [];
  const cap = Math.max(0, Math.min(
    profile.maxInstances,
    Math.floor(options.maximumInstances ?? profile.maxInstances),
  ));
  if (cap === 0) return [];
  const seed = options.seed ?? 'omnitwin-universal-vegetation-v1';
  const ordered = mergeSourceFeatures(features);
  const exact = ordered.filter((feature): feature is SourceTreeFeature => feature.kind === 'tree');
  const result: VegetationRenderInstance[] = [];
  for (const feature of exact.slice(0, cap)) {
    const classification = classifyVegetationFeature(feature);
    const idKey = `exact\u0000${stableFeatureKey(feature)}`;
    const instanceSeed = hashSeed(`${seed}:${idKey}`);
    result.push(makeInstance(
      classification,
      feature.coordinate,
      idKey,
      instanceSeed,
      spriteFamilyForFeature(feature),
    ));
  }
  if (result.length >= cap) return result;
  const forests = ordered.filter((feature): feature is SourceForestFeature => feature.kind === 'forest');
  const allocations = allocateForestCounts(
    forests,
    cap - result.length,
    qualityAreaPerTree(options.qualityTier),
  );
  forests.forEach((feature, featureIndex) => {
    const classification = classifyVegetationFeature(feature);
    const candidates = sampleForest(
      feature,
      allocations[featureIndex] ?? 0,
      seed,
      options.qualityTier,
    );
    candidates.forEach((candidate) => {
      const instanceSeed = hashSeed(`${seed}:${candidate.idKey}`);
      result.push(makeInstance(
        classification,
        candidate.coordinate,
        candidate.idKey,
        instanceSeed,
        spriteFamilyForFeature(feature),
      ));
    });
  });
  const deduplicated = new Map<string, VegetationRenderInstance>();
  for (const instance of result) {
    if (!deduplicated.has(instance.id)) deduplicated.set(instance.id, instance);
  }
  return [...deduplicated.values()].slice(0, cap);
}
