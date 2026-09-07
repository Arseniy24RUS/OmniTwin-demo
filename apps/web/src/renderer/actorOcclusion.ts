import { presentationHeightLimitM, resolveSourceBuildingHeight } from './buildingSource';

type Point3 = readonly [number, number, number];
export interface ActorOccluderFeature {
  readonly geometry: { readonly type: string; readonly coordinates?: unknown } | null;
  readonly properties?: Readonly<Record<string, unknown>> | null;
  readonly layer?: { readonly type?: string };
}

function inRing(point: readonly [number, number], ring: readonly Point3[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!; const b = ring[j]!;
    if ((a[1] > point[1]) !== (b[1] > point[1])
      && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

/** Screen-space barycentric interpolation of NDC depth (the rasterizer's depth). */
function triangleDepth(point: readonly [number, number], a: Point3, b: Point3, c: Point3, requireInside: boolean): number | null {
  const denominator = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
  if (Math.abs(denominator) < 1e-9) return null;
  const u = ((b[1] - c[1]) * (point[0] - c[0]) + (c[0] - b[0]) * (point[1] - c[1])) / denominator;
  const v = ((c[1] - a[1]) * (point[0] - c[0]) + (a[0] - c[0]) * (point[1] - c[1])) / denominator;
  const w = 1 - u - v;
  if (requireInside && (u < -1e-6 || v < -1e-6 || w < -1e-6)) return null;
  return u * a[2] + v * b[2] + w * c[2];
}

/**
 * Click-only, bounded geometric occlusion check against the same rendered
 * source building heights. No framebuffer, private MapLibre API or actor scan.
 * Compare with the nearest actor vertex/marker depth: block only when a wall
 * is in front of the entire actor, preserving partially visible silhouettes.
 */
export function actorBuildingOcclusion(options: {
  point: readonly [number, number];
  actorNearestDepth: number;
  features: readonly ActorOccluderFeature[];
  zoom: number;
  project: (geographic: Point3) => Point3;
}): 'clear' | 'occluded' | 'unavailable' {
  if (!options.point.every(Number.isFinite) || !Number.isFinite(options.actorNearestDepth) || options.features.length > 64) return 'unavailable';
  let vertexBudget = 8_192;
  const closer = (depth: number | null) => depth !== null && Number.isFinite(depth) && depth < options.actorNearestDepth - 1e-7;
  for (const feature of options.features) {
    const geometry = feature.geometry;
    if (!geometry || !Array.isArray(geometry.coordinates)) return 'unavailable';
    const polygons = geometry.type === 'Polygon' ? [geometry.coordinates]
      : geometry.type === 'MultiPolygon' ? geometry.coordinates : null;
    if (!polygons) return 'unavailable';
    const properties = feature.properties ?? {};
    const extruded = feature.layer?.type === 'fill-extrusion';
    const top = extruded ? Math.min(resolveSourceBuildingHeight(properties).heightM, presentationHeightLimitM(options.zoom)) : 0;
    const minHeight = [properties.min_height, properties.render_min_height].map(Number).find((value) => Number.isFinite(value) && value > 0) ?? 0;
    const base = extruded ? minHeight : 0;
    for (const polygon of polygons) {
      if (!Array.isArray(polygon) || polygon.length === 0) return 'unavailable';
      const roofs: Point3[][] = [];
      const bases: Point3[][] = [];
      for (const ring of polygon) {
        if (!Array.isArray(ring) || ring.length < 3 || (vertexBudget -= ring.length) < 0) return 'unavailable';
        const roof: Point3[] = []; const bottom: Point3[] = [];
        for (const point of ring) {
          if (!Array.isArray(point) || point.length < 2 || !point.slice(0, 2).every(Number.isFinite)) return 'unavailable';
          const high = options.project([point[0] as number, point[1] as number, top]);
          const low = options.project([point[0] as number, point[1] as number, base]);
          if (!high.every(Number.isFinite) || !low.every(Number.isFinite)) return 'unavailable';
          roof.push(high); bottom.push(low);
        }
        roofs.push(roof); bases.push(bottom);
      }
      if (inRing(options.point, roofs[0]!) && !roofs.slice(1).some((hole) => inRing(options.point, hole))) {
        const roof = roofs[0]!;
        for (let index = 2; index < roof.length; index += 1) {
          const depth = triangleDepth(options.point, roof[0]!, roof[index - 1]!, roof[index]!, false);
          if (depth !== null) { if (closer(depth)) return 'occluded'; break; }
        }
      }
      if (!extruded) continue;
      for (let ring = 0; ring < roofs.length; ring += 1) {
        const roof = roofs[ring]!; const bottom = bases[ring]!;
        for (let index = 0; index < roof.length; index += 1) {
          const next = (index + 1) % roof.length;
          if (closer(triangleDepth(options.point, bottom[index]!, bottom[next]!, roof[next]!, true))
            || closer(triangleDepth(options.point, bottom[index]!, roof[next]!, roof[index]!, true))) return 'occluded';
        }
      }
    }
  }
  return 'clear';
}
