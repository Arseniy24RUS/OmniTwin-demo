import { MercatorCoordinate } from 'maplibre-gl';
import { Ray, ShapeUtils, Vector2, Vector3 } from 'three';
import { presentationHeightLimitM, resolveSourceBuildingHeight } from '../buildingSource';
import type { VerifiedCityBuildingSnapshot } from '../verifiedCityBuildingTypes';
import { localToMercatorMatrix, type GameOrigin } from './cameraAdapter';

/** Click-time work only; never retain a second copy of the city's meshes. */
export const CANONICAL_BUILDING_PICK_LIMITS = Object.freeze({
  renderedFeatures: 2048, buildings: 128, vertices: 32768, ringVertices: 4096, snapshotFeatures: 12000,
});

export interface CanonicalBuildingPickFeature {
  readonly id?: string | number | null;
  readonly source?: string;
  readonly properties?: Readonly<Record<string, unknown>> | null;
  readonly layer?: { readonly id?: string; readonly type?: string };
}
export interface CanonicalBuildingHit { id: string; point: Vector3; distance: number }
export interface CanonicalBuildingPickResult {
  hit: CanonicalBuildingHit | null;
  /** False means native occlusion is unknown: do not select an actor through it. */
  complete: boolean;
}
export interface CanonicalBuildingPickOptions {
  /** Same local East / Up / South metre ray as the shared Three scene. */
  ray: Ray;
  origin: GameOrigin;
  zoom: number;
  snapshot: VerifiedCityBuildingSnapshot | null;
  /** Only queryRenderedFeatures([x,y], {layers: banks.layerIds}) candidates. */
  features: readonly CanonicalBuildingPickFeature[];
  sourceId: string | null;
  layerIds: readonly string[];
  near?: number;
  far?: number;
}

/** Matches mapStyle's per-integer-stop min, then interpolate (not min after interpolation). */
export function canonicalBuildingExtrusionHeights(
  properties: Readonly<Record<string, unknown>>, zoom: number, roofCap = false,
): { base: number; top: number } {
  if (!Number.isFinite(zoom)) throw new Error('Invalid canonical building pick zoom');
  const raw = resolveSourceBuildingHeight(properties).heightM;
  const z = Math.max(13, Math.min(16, zoom)), lower = Math.floor(z), progress = z - lower;
  const a = Math.min(raw, presentationHeightLimitM(lower));
  const b = Math.min(raw, presentationHeightLimitM(Math.min(16, lower + 1)));
  let base = 0;
  for (const candidate of [properties.min_height, properties.render_min_height]) {
    if (typeof candidate !== 'number' && typeof candidate !== 'string') continue;
    const number = Number(candidate);
    if (Number.isFinite(number) && number > 0) { base = number; break; }
  }
  return { base, top: a + (b - a) * progress + (roofCap ? 0.25 : 0) };
}

const unavailable = (): CanonicalBuildingPickResult => ({ hit: null, complete: false });
const clear = (): CanonicalBuildingPickResult => ({ hit: null, complete: true });

/**
 * Native query results supply visibility and identity only. Their tile-clipped
 * polygons and copied properties never replace the verified snapshot geometry.
 * Roof triangulation preserves concavity and holes; every boundary has walls.
 * Distances are Euclidean metres, directly comparable with Three intersections.
 */
export function pickCanonicalBuildings(options: CanonicalBuildingPickOptions): CanonicalBuildingPickResult {
  const { ray, snapshot, sourceId } = options;
  const near = options.near ?? 0, far = options.far ?? Infinity;
  if (!Number.isFinite(options.zoom) || !ray.origin.toArray().every(Number.isFinite)
    || !ray.direction.toArray().every(Number.isFinite) || ray.direction.lengthSq() < 1e-20
    || !Number.isFinite(near) || near < 0 || !(far >= near)
    || options.features.length > CANONICAL_BUILDING_PICK_LIMITS.renderedFeatures) return unavailable();
  if (!sourceId || options.layerIds.length === 0) return options.features.length ? unavailable() : clear();
  const allowedLayers = new Set(options.layerIds);
  const candidates = new Map<string, boolean>();
  for (const feature of options.features) {
    if (feature.source !== sourceId || !feature.layer?.id || !allowedLayers.has(feature.layer.id)
      || feature.layer.type !== 'fill-extrusion') continue;
    const id = feature.properties?.canonical_id;
    if (typeof id !== 'string' || !id || feature.id !== id) return unavailable();
    candidates.set(id, candidates.get(id) === true || /-roof-3d$/u.test(feature.layer.id));
    if (candidates.size > CANONICAL_BUILDING_PICK_LIMITS.buildings) return unavailable();
  }
  if (!candidates.size) return clear();
  if (!snapshot || snapshot.data.features.length > CANONICAL_BUILDING_PICK_LIMITS.snapshotFeatures) return unavailable();
  const sources = new Map<string, VerifiedCityBuildingSnapshot['data']['features'][number]>();
  for (const feature of snapshot.data.features) {
    const id = feature.properties?.canonical_id;
    if (typeof id !== 'string' || !candidates.has(id)) continue;
    if (feature.id !== id || !snapshot.canonicalIds.has(id) || sources.has(id)) return unavailable();
    sources.set(id, feature);
  }
  if (sources.size !== candidates.size) return unavailable();
  try {
    const mercatorToLocal = localToMercatorMatrix(options.origin).invert();
    const localRay = ray.clone(); localRay.direction.normalize();
    const intersection = new Vector3();
    let hit: CanonicalBuildingHit | null = null, remainingVertices = CANONICAL_BUILDING_PICK_LIMITS.vertices;
    const intersect = (id: string, a: Vector3, b: Vector3, c: Vector3) => {
      if (!localRay.intersectTriangle(a, b, c, false, intersection)) return;
      const distance = intersection.distanceTo(localRay.origin);
      if (distance < near || distance > far) return;
      if (!hit || distance < hit.distance - 1e-7 || (Math.abs(distance - hit.distance) <= 1e-7 && id < hit.id)) {
        hit = { id, point: intersection.clone(), distance };
      }
    };
    for (const [id, source] of sources) {
      const { base, top } = canonicalBuildingExtrusionHeights(source.properties ?? {}, options.zoom, candidates.get(id));
      if (!Number.isFinite(top) || top < base) return unavailable();
      const geometry = source.geometry;
      const polygons = geometry?.type === 'Polygon' ? [geometry.coordinates]
        : geometry?.type === 'MultiPolygon' ? geometry.coordinates : null;
      if (!polygons?.length) return unavailable();
      for (const polygon of polygons) {
        if (!Array.isArray(polygon) || !polygon.length) return unavailable();
        const outlines: Vector2[][] = [], roofs: Vector3[][] = [], bases: Vector3[][] = [];
        for (const ring of polygon) {
          if (!Array.isArray(ring) || ring.length < 4 || ring.length > CANONICAL_BUILDING_PICK_LIMITS.ringVertices
            || (remainingVertices -= ring.length) < 0) return unavailable();
          const outline: Vector2[] = [], roof: Vector3[] = [], bottom: Vector3[] = [];
          for (const point of ring) {
            if (!Array.isArray(point) || point.length < 2 || !Number.isFinite(point[0]) || !Number.isFinite(point[1])
              || Math.abs(point[0]!) > 180 || Math.abs(point[1]!) >= 85.051129) return unavailable();
            const high = MercatorCoordinate.fromLngLat([point[0]!, point[1]!], top);
            const low = MercatorCoordinate.fromLngLat([point[0]!, point[1]!], base);
            const localHigh = new Vector3(high.x, high.y, high.z).applyMatrix4(mercatorToLocal);
            const localLow = new Vector3(low.x, low.y, low.z).applyMatrix4(mercatorToLocal);
            roof.push(localHigh); bottom.push(localLow); outline.push(new Vector2(localHigh.x, localHigh.z));
          }
          if (!outline[0]!.equals(outline.at(-1)!)) return unavailable();
          outline.pop(); roof.pop(); bottom.pop();
          if (outline.length < 3 || Math.abs(ShapeUtils.area(outline)) < 1e-8) return unavailable();
          outlines.push(outline); roofs.push(roof); bases.push(bottom);
        }
        const triangles = ShapeUtils.triangulateShape(outlines[0]!, outlines.slice(1));
        if (!triangles.length) return unavailable();
        const roofVertices = roofs.flat();
        for (const [a, b, c] of triangles) intersect(id, roofVertices[a!]!, roofVertices[b!]!, roofVertices[c!]!);
        for (let ringIndex = 0; ringIndex < roofs.length; ringIndex++) {
          const roof = roofs[ringIndex]!, bottom = bases[ringIndex]!;
          for (let i = 0; i < roof.length; i++) {
            const j = (i + 1) % roof.length;
            intersect(id, bottom[i]!, bottom[j]!, roof[j]!);
            intersect(id, bottom[i]!, roof[j]!, roof[i]!);
          }
        }
      }
    }
    return { hit, complete: true };
  } catch { return unavailable(); }
}
