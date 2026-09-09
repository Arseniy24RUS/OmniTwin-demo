import { ShapeUtils, Vector2 } from 'three';

export const WATER_REPAIR_LIMITS = Object.freeze({ intersections: 64, pairChecks: 500000, components: 65 });
type Triangle = [number, number, number];
export interface WaterTriangulation { points: Vector2[]; triangles: Triangle[]; repairedIntersections: number }
const cross = (a: Vector2, b: Vector2, c: Vector2) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
function inside(point: Vector2, ring: readonly Vector2[]) {
  let value = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!, b = ring[j]!;
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) value = !value;
  }
  return value;
}
function properIntersection(a: Vector2, b: Vector2, c: Vector2, d: Vector2): Vector2 | null {
  const dx = b.x - a.x, dy = b.y - a.y, ex = d.x - c.x, ey = d.y - c.y;
  const determinant = dx * ey - dy * ex;
  if (Math.abs(determinant) < 1e-12) return null;
  const px = c.x - a.x, py = c.y - a.y;
  const t = (px * ey - py * ex) / determinant, u = (px * dy - py * dx) / determinant;
  if (t <= 1e-10 || t >= 1 - 1e-10 || u <= 1e-10 || u >= 1 - 1e-10) return null;
  return new Vector2(a.x + t * dx, a.y + t * dy);
}
function verifiedTriangles(rings: readonly (readonly Vector2[])[]): WaterTriangulation | null {
  const copies = rings.map(ring => [...ring]), points = copies.flat();
  const triangles = ShapeUtils.triangulateShape(copies[0]!, copies.slice(1)) as Triangle[];
  const expected = Math.abs(ShapeUtils.area(copies[0]!)) - copies.slice(1).reduce((sum, ring) => sum + Math.abs(ShapeUtils.area(ring)), 0);
  const area = triangles.reduce((sum, [a, b, c]) => sum + Math.abs(cross(points[a]!, points[b]!, points[c]!)) / 2, 0);
  if (!(expected > .0001) || Math.abs(area - expected) > Math.max(.02, expected * 1e-5)) return null;
  return { points, triangles, repairedIntersections: 0 };
}

/**
 * MVT clipping can turn a shore touching a tile edge into a slightly crossed
 * ring. Keep its exact edges and split their proper intersections into simple
 * components. This preserves the source even-odd fill, not a convex hull or a
 * tolerance that paints across real land. Ambiguous overlapping loops reject.
 */
export function triangulateSourceWater(rings: readonly (readonly Vector2[])[], workBudget: {remaining:number} = { remaining: WATER_REPAIR_LIMITS.pairChecks }): WaterTriangulation | null {
  if (!rings.length || rings.some(ring => ring.length < 3)) return null;
  const direct = verifiedTriangles(rings);
  if (direct) return direct;
  let checks = 0, intersections = 0;
  const spend = () => ++checks <= WATER_REPAIR_LIMITS.pairChecks && --workBudget.remaining >= 0;
  const pending = [[...rings[0]!]], simple: Vector2[][] = [];
  while (pending.length) {
    const ring = pending.pop()!;
    let split = false;
    search: for (let i = 0; i < ring.length; i++) for (let j = i + 2; j < ring.length; j++) {
      if (i === 0 && j === ring.length - 1) continue;
      if (!spend()) return null;
      const point = properIntersection(ring[i]!, ring[(i + 1) % ring.length]!, ring[j]!, ring[(j + 1) % ring.length]!);
      if (!point) continue;
      if (++intersections > WATER_REPAIR_LIMITS.intersections) return null;
      pending.push([point, ...ring.slice(i + 1, j + 1)], [point, ...ring.slice(j + 1), ...ring.slice(0, i + 1)]);
      split = true; break search;
    }
    if (!split) {
      if (simple.length >= WATER_REPAIR_LIMITS.components || !verifiedTriangles([ring])) return null;
      simple.push(ring);
    }
  }
  if (!intersections) return null; // For example a hole outside its source outer boundary.
  // Components from a clean split may touch at the split point, but must not
  // cross each other or nest: those topologies need a different source repair.
  const probes = simple.map(ring => {
    const result = verifiedTriangles([ring])!, [a, b, c] = result.triangles[0]!;
    return new Vector2((result.points[a]!.x + result.points[b]!.x + result.points[c]!.x) / 3,
      (result.points[a]!.y + result.points[b]!.y + result.points[c]!.y) / 3);
  });
  for (let i = 0; i < simple.length; i++) {
    if (!inside(probes[i]!, rings[0]!)) return null;
    for (let j = i + 1; j < simple.length; j++) {
      const a = simple[i]!, b = simple[j]!;
      if (inside(probes[i]!, b) || inside(probes[j]!, a)) return null;
      for (let p = 0; p < a.length; p++) for (let q = 0; q < b.length; q++) {
        if (!spend() || properIntersection(a[p]!, a[(p + 1) % a.length]!, b[q]!, b[(q + 1) % b.length]!)) return null;
      }
    }
  }
  const componentHoles: Vector2[][][] = simple.map(() => []);
  for (const hole of rings.slice(1)) {
    const owners = simple.flatMap((outer, index) => hole.every(point => inside(point, outer)) ? [index] : []);
    if (owners.length !== 1) return null;
    componentHoles[owners[0]!]!.push([...hole]);
  }
  const result: WaterTriangulation = { points: [], triangles: [], repairedIntersections: intersections };
  for (let i = 0; i < simple.length; i++) {
    const component = verifiedTriangles([simple[i]!, ...componentHoles[i]!]);
    if (!component) return null;
    const offset = result.points.length;
    result.points.push(...component.points);
    result.triangles.push(...component.triangles.map(([a, b, c]): Triangle => [a + offset, b + offset, c + offset]));
  }
  return result;
}
