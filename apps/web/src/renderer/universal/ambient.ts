import { createDeterministicRng, hashSeed } from '../rng';
import { universalInstanceCaps, universalSemanticLodForZoom } from './lod';
import type { MultiPolygonCoordinates } from './vegetation';
import {
  isGeoPosition,
  sourceIdentityKey,
  type GeoPosition,
  type UniversalQualityTier,
  type UniversalSourceIdentity,
  type VisualSynthesisDisclosure,
} from './types';

export const AMBIENT_VISUAL_SYNTHESIS_LABEL_RU =
  'Визуальный синтез · декоративные объекты · не данные модели';

interface AmbientSourceAnchorBase extends UniversalSourceIdentity {
  readonly sourceLayer: string;
}

export interface AmbientRoadAnchor extends AmbientSourceAnchorBase {
  readonly kind: 'road';
  readonly coordinates: readonly GeoPosition[];
}

export interface AmbientFootwayAnchor extends AmbientSourceAnchorBase {
  readonly kind: 'footway';
  readonly coordinates: readonly GeoPosition[];
}

export interface AmbientBuildingAnchor extends AmbientSourceAnchorBase {
  readonly kind: 'building';
  readonly polygons: MultiPolygonCoordinates;
}

export interface AmbientPoiAnchor extends AmbientSourceAnchorBase {
  readonly kind: 'poi';
  readonly coordinate: GeoPosition;
}

export type AmbientSourceAnchor =
  | AmbientRoadAnchor
  | AmbientFootwayAnchor
  | AmbientBuildingAnchor
  | AmbientPoiAnchor;

export type AmbientPlacementQuality =
  | 'source_line_interpolation'
  | 'source_polygon_boundary'
  | 'source_point';

export interface AmbientVisualSynthesisDescriptor extends VisualSynthesisDisclosure {
  readonly id: string;
  readonly kind: 'vehicle' | 'person';
  readonly representation: 'ambient_individual' | 'ambient_flow_cluster';
  readonly representedCount: 0;
  readonly coordinate: GeoPosition;
  readonly headingDegrees: number;
  readonly speedMetersPerSecond: number;
  readonly placementQuality: AmbientPlacementQuality;
  readonly sourceAnchorKind: AmbientSourceAnchor['kind'];
  readonly sourceKey: string;
  readonly sourceLayer: string;
  readonly seed: number;
}

export interface BuildAmbientVisualSynthesisOptions {
  readonly zoom: number;
  readonly qualityTier: UniversalQualityTier;
  /** Authoritative presentation time. Wall-clock time must never be used. */
  readonly presentationTimeSeconds: number;
  readonly seed?: string | number;
  readonly maximumInstances?: number;
  readonly reducedMotion?: boolean;
}

export interface AmbientVisualSynthesisFrame extends VisualSynthesisDisclosure {
  readonly version: 1;
  /** Stable across presentation-time ticks; retained GPU buffers key off this value. */
  readonly layoutKey: string;
  readonly frameKey: string;
  readonly presentationTimeSeconds: number;
  readonly qualityTier: UniversalQualityTier;
  readonly zoom: number;
  readonly maximumInstances: number;
  readonly vehicleCount: number;
  readonly personCount: number;
  readonly instances: readonly AmbientVisualSynthesisDescriptor[];
  readonly requiresContinuousFrames: boolean;
}

interface PathSample {
  readonly coordinate: GeoPosition;
  readonly headingDegrees: number;
}

const DISCLOSURE = {
  provenance: 'visual_synthesis',
  temporalMapping: 'visual_synthesis',
  scientificClaim: false,
  displayLabel: AMBIENT_VISUAL_SYNTHESIS_LABEL_RU,
} as const;

function validateLine(coordinates: readonly GeoPosition[], kind: string): void {
  if (coordinates.length < 2 || coordinates.some((position) => !isGeoPosition(position))) {
    throw new RangeError(`${kind} source anchor requires at least two valid WGS84 positions`);
  }
}

function validatePolygons(polygons: MultiPolygonCoordinates): void {
  if (polygons.length === 0) throw new RangeError('Building source anchor requires a polygon');
  for (const polygon of polygons) {
    const outer = polygon[0];
    if (!outer || outer.length < 3 || outer.some((position) => !isGeoPosition(position))) {
      throw new RangeError('Building source anchor requires a valid outer ring');
    }
  }
}

function validateAnchor(anchor: AmbientSourceAnchor): void {
  sourceIdentityKey(anchor);
  if (!anchor.sourceLayer.trim()) throw new RangeError('Ambient source anchor requires sourceLayer');
  if (anchor.kind === 'road' || anchor.kind === 'footway') {
    validateLine(anchor.coordinates, anchor.kind);
  } else if (anchor.kind === 'building') {
    validatePolygons(anchor.polygons);
  } else if (!isGeoPosition(anchor.coordinate)) {
    throw new RangeError('POI source anchor requires a valid WGS84 point');
  }
}

function distanceMeters(left: GeoPosition, right: GeoPosition): number {
  const latitudeRadians = (left[1] + right[1]) * Math.PI / 360;
  const dx = (right[0] - left[0]) * 111_320 * Math.cos(latitudeRadians);
  const dy = (right[1] - left[1]) * 110_574;
  return Math.hypot(dx, dy);
}

function pathLengthMeters(coordinates: readonly GeoPosition[]): number {
  let length = 0;
  for (let index = 1; index < coordinates.length; index += 1) {
    length += distanceMeters(coordinates[index - 1], coordinates[index]);
  }
  return length;
}

function headingDegrees(left: GeoPosition, right: GeoPosition): number {
  const latitudeRadians = (left[1] + right[1]) * Math.PI / 360;
  const east = (right[0] - left[0]) * Math.cos(latitudeRadians);
  const north = right[1] - left[1];
  return (Math.atan2(east, north) * 180 / Math.PI + 360) % 360;
}

function samplePath(
  coordinates: readonly GeoPosition[],
  distanceAlongMeters: number,
): PathSample {
  const total = pathLengthMeters(coordinates);
  if (total <= Number.EPSILON) {
    return { coordinate: coordinates[0], headingDegrees: 0 };
  }
  let remaining = ((distanceAlongMeters % total) + total) % total;
  for (let index = 1; index < coordinates.length; index += 1) {
    const left = coordinates[index - 1];
    const right = coordinates[index];
    const segment = distanceMeters(left, right);
    if (remaining <= segment || index === coordinates.length - 1) {
      const amount = segment <= Number.EPSILON ? 0 : Math.min(1, remaining / segment);
      return {
        coordinate: [
          left[0] + (right[0] - left[0]) * amount,
          left[1] + (right[1] - left[1]) * amount,
        ],
        headingDegrees: headingDegrees(left, right),
      };
    }
    remaining -= segment;
  }
  return { coordinate: coordinates[coordinates.length - 1], headingDegrees: 0 };
}

function ambientCapForLod(
  zoom: number,
  tier: UniversalQualityTier,
  requested: number | undefined,
): number {
  const maximum = universalInstanceCaps(tier).maxAmbientInstances;
  const requestedCap = Math.max(0, Math.floor(requested ?? maximum));
  const capped = Math.min(maximum, requestedCap);
  return universalSemanticLodForZoom(zoom) === 'extrusions'
    ? Math.min(capped, tier === 'high' ? 1_200 : tier === 'mid' ? 600 : 250)
    : capped;
}

function spacingMeters(
  kind: AmbientSourceAnchor['kind'],
  tier: UniversalQualityTier,
  detailed: boolean,
): number {
  const base = kind === 'road'
    ? tier === 'high' ? 110 : tier === 'mid' ? 180 : 300
    : tier === 'high' ? 35 : tier === 'mid' ? 60 : 100;
  return detailed ? base : base * 4;
}

function sourcePath(anchor: AmbientSourceAnchor): readonly GeoPosition[] | null {
  if (anchor.kind === 'road' || anchor.kind === 'footway') return anchor.coordinates;
  if (anchor.kind === 'building') return anchor.polygons[0]?.[0] ?? null;
  return null;
}

function desiredAnchorCount(
  anchor: AmbientSourceAnchor,
  tier: UniversalQualityTier,
  detailed: boolean,
): number {
  if (anchor.kind === 'building' || anchor.kind === 'poi') return detailed ? 1 : 0;
  const length = pathLengthMeters(anchor.coordinates);
  const perAnchorMaximum = anchor.kind === 'road' ? 24 : 16;
  return Math.min(perAnchorMaximum, Math.max(1, Math.ceil(
    length / spacingMeters(anchor.kind, tier, detailed),
  )));
}

function descriptorFor(
  anchor: AmbientSourceAnchor,
  ordinal: number,
  options: BuildAmbientVisualSynthesisOptions,
  detailed: boolean,
): AmbientVisualSynthesisDescriptor {
  const sourceKey = sourceIdentityKey(anchor);
  const seed = hashSeed(`${options.seed ?? 'omnitwin-ambient-v1'}:${sourceKey}:${ordinal}`);
  const rng = createDeterministicRng(seed);
  const kind = anchor.kind === 'road' ? 'vehicle' : 'person';
  const speedMetersPerSecond = kind === 'vehicle'
    ? 6 + rng() * 8
    : anchor.kind === 'footway' ? 0.8 + rng() * 0.9 : 0;
  const path = sourcePath(anchor);
  let coordinate: GeoPosition;
  let direction = 0;
  let placementQuality: AmbientPlacementQuality;
  if (anchor.kind === 'poi') {
    coordinate = anchor.coordinate;
    direction = rng() * 360;
    placementQuality = 'source_point';
  } else if (path) {
    const length = pathLengthMeters(path);
    const initialDistance = rng() * length;
    const motionDistance = options.reducedMotion
      ? 0
      : options.presentationTimeSeconds * speedMetersPerSecond;
    const sample = samplePath(path, initialDistance + motionDistance);
    coordinate = sample.coordinate;
    direction = sample.headingDegrees;
    placementQuality = anchor.kind === 'building'
      ? 'source_polygon_boundary'
      : 'source_line_interpolation';
  } else {
    throw new RangeError('Ambient source anchor has no usable source geometry');
  }
  return {
    ...DISCLOSURE,
    id: `ambient-${kind}-${hashSeed(`${sourceKey}:${ordinal}`).toString(16).padStart(8, '0')}`,
    kind,
    representation: detailed ? 'ambient_individual' : 'ambient_flow_cluster',
    representedCount: 0,
    coordinate,
    headingDegrees: direction,
    speedMetersPerSecond,
    placementQuality,
    sourceAnchorKind: anchor.kind,
    sourceKey,
    sourceLayer: anchor.sourceLayer,
    seed,
  };
}

/**
 * Builds decorative life from explicit source geometry. Vehicles are possible
 * only on source roads; people are possible only on footways, buildings, or POIs.
 */
export function buildAmbientVisualSynthesis(
  anchors: readonly AmbientSourceAnchor[],
  options: BuildAmbientVisualSynthesisOptions,
): AmbientVisualSynthesisFrame {
  if (!Number.isFinite(options.presentationTimeSeconds)) {
    throw new RangeError('presentationTimeSeconds must be finite');
  }
  for (const anchor of anchors) validateAnchor(anchor);
  const semanticLod = universalSemanticLodForZoom(options.zoom);
  const detailed = semanticLod === 'detail';
  const cap = semanticLod === 'territory' || semanticLod === 'footprints'
    ? 0
    : ambientCapForLod(options.zoom, options.qualityTier, options.maximumInstances);
  const caps = universalInstanceCaps(options.qualityTier);
  const vehicleCap = Math.min(caps.maxAmbientVehicles, Math.round(cap * 0.4));
  const peopleCap = Math.min(caps.maxAmbientPeople, cap - vehicleCap);
  const unique = new Map<string, AmbientSourceAnchor>();
  for (const anchor of anchors) unique.set(`${anchor.kind}\u0000${sourceIdentityKey(anchor)}`, anchor);
  const ordered = [...unique.values()].sort((left, right) => {
    const leftPriority = hashSeed(`${options.seed ?? 'omnitwin-ambient-v1'}:${sourceIdentityKey(left)}`);
    const rightPriority = hashSeed(`${options.seed ?? 'omnitwin-ambient-v1'}:${sourceIdentityKey(right)}`);
    return leftPriority - rightPriority;
  });
  const instances: AmbientVisualSynthesisDescriptor[] = [];
  let vehicles = 0;
  let people = 0;
  for (const anchor of ordered) {
    const kind = anchor.kind === 'road' ? 'vehicle' : 'person';
    const available = kind === 'vehicle' ? vehicleCap - vehicles : peopleCap - people;
    if (available <= 0) continue;
    const count = Math.min(available, desiredAnchorCount(anchor, options.qualityTier, detailed));
    for (let ordinal = 0; ordinal < count; ordinal += 1) {
      instances.push(descriptorFor(anchor, ordinal, options, detailed));
    }
    if (kind === 'vehicle') vehicles += count;
    else people += count;
    if (instances.length >= cap) break;
  }
  const effectiveTime = options.reducedMotion ? 0 : options.presentationTimeSeconds;
  const layoutSignature = JSON.stringify({
    zoom: Math.round(options.zoom * 100) / 100,
    qualityTier: options.qualityTier,
    cap,
    ids: instances.map((instance) => instance.id),
  });
  const layoutKey = `ambient-layout-${hashSeed(layoutSignature).toString(16).padStart(8, '0')}`;
  const frameSignature = `${layoutKey}:${Math.round(effectiveTime * 10) / 10}`;
  return {
    version: 1,
    layoutKey,
    frameKey: `ambient-visual-${hashSeed(frameSignature).toString(16).padStart(8, '0')}`,
    presentationTimeSeconds: options.presentationTimeSeconds,
    qualityTier: options.qualityTier,
    zoom: options.zoom,
    maximumInstances: cap,
    vehicleCount: vehicles,
    personCount: people,
    instances,
    requiresContinuousFrames: !options.reducedMotion
      && instances.some((instance) => instance.speedMetersPerSecond > 0),
    ...DISCLOSURE,
  };
}
