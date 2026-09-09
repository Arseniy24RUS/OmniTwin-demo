import { describe, expect, it, vi } from 'vitest';
import { MercatorCoordinate } from 'maplibre-gl';
import { Mesh, type BufferGeometry, type ShaderMaterial } from 'three';
import { GameWater, GAME_WATER_LIMITS, GAME_WATER_PERIOD_METERS, sampleGameWaterNormal, waterSurfaceCoordinates, type GameWaterFeature } from './GameWater';
import miassClipped from './fixtures/miass-water-clipped-v1.json';

const origin = { longitude: 61.39466, latitude: 55.1654 };
const reference = MercatorCoordinate.fromLngLat([origin.longitude, origin.latitude]);
function geographic(point: readonly number[]) {
  const ll = new MercatorCoordinate(reference.x + point[0] * reference.meterInMercatorCoordinateUnits(), reference.y + point[1] * reference.meterInMercatorCoordinateUnits()).toLngLat();
  return [ll.lng, ll.lat];
}
function polygon(rings: number[][][], id = 'source-water'): GameWaterFeature {
  return { id, geometry: { type: 'Polygon', coordinates: rings.map(ring => ring.map(geographic)) } };
}
function rectangle(x = 0, z = 0, size = 100) {
  return polygon([[[x, z], [x + size, z], [x + size, z + size], [x, z + size], [x, z]]]);
}
function mesh(water: GameWater) { return water.object.children[0] as Mesh<BufferGeometry, ShaderMaterial>; }
function triangles(water: GameWater) {
  const geometry = mesh(water).geometry, positions = geometry.getAttribute('position'), indices = geometry.getIndex()!;
  return Array.from({ length: indices.count / 3 }, (_, i) => Array.from({ length: 3 }, (_, corner) => {
    const index = indices.getX(i * 3 + corner); return [positions.getX(index), positions.getZ(index)];
  }));
}
function area(water: GameWater) {
  return triangles(water).reduce((sum, [a, b, c]) => sum + Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2, 0);
}

describe('retained source-water rendering', () => {
  it('renders all actual Miass fragments despite sub-metre self-crossings on the source tile clipping edge', () => {
    const water = new GameWater(); water.update(miassClipped.features, miassClipped.origin, 'medium');
    expect(water.telemetry.polygons).toBe(5); expect(water.telemetry.skippedFeatures).toBe(0);
    expect(water.telemetry.repairedPolygons).toBe(1); expect(water.telemetry.repairIntersections).toBe(2);
    const original = JSON.stringify(miassClipped.features);
    const count = water.telemetry.geometryUpdates;
    water.update([...miassClipped.features].reverse(), miassClipped.origin, 'medium');
    expect(water.telemetry.geometryUpdates).toBe(count); expect(JSON.stringify(miassClipped.features)).toBe(original);
    water.dispose();
  });

  it('preserves an island when a crossed source outline is split into its original even-odd water components', () => {
    const water = new GameWater();
    water.update([polygon([[[0, 0], [20, 20], [0, 20], [20, 0], [0, 0]],
      [[8, 2], [12, 2], [12, 4], [8, 4], [8, 2]]])], origin, 'medium');
    expect(water.telemetry.polygons).toBe(1); expect(water.telemetry.repairedPolygons).toBe(1);
    expect(area(water)).toBeCloseTo(192, 3);
    for (const triangle of triangles(water)) {
      const [x, z] = triangle.reduce(([x, z], p) => [x + p[0] / 3, z + p[1] / 3], [0, 0]);
      expect(x > 8 && x < 12 && z > 2 && z < 4).toBe(false);
    }
    water.dispose();
  });

  it('triangulates concave banks and island holes without filling their dry areas', () => {
    const water = new GameWater();
    water.update([
      polygon([[[0, 0], [100, 0], [100, 100], [0, 100], [0, 0]], [[30, 30], [70, 30], [70, 70], [30, 70], [30, 30]]]),
      polygon([[[200, 0], [300, 0], [300, 40], [240, 40], [240, 100], [200, 100], [200, 0]]]),
    ], origin, 'medium');
    expect(area(water)).toBeCloseTo(14800, 2);
    for (const triangle of triangles(water)) {
      const [x, z] = triangle.reduce(([x, z], p) => [x + p[0] / 3, z + p[1] / 3], [0, 0]);
      expect(x > 30 && x < 70 && z > 30 && z < 70).toBe(false);
      expect(x > 240 && x < 300 && z > 40 && z < 100).toBe(false);
    }
    expect(water.telemetry.polygons).toBe(2); water.dispose();
  });

  it('deduplicates identical buffered tiles regardless of winding, start vertex, ID or input order', () => {
    const a = rectangle(), b = rectangle(200), ring = (a.geometry as { coordinates: number[][][] }).coordinates[0];
    const reversed = [...ring.slice(0, -1)].reverse();
    const rotated = [...reversed.slice(2), ...reversed.slice(0, 2)]; rotated.push(rotated[0]);
    const duplicate: GameWaterFeature = { id: 'another-tile', geometry: { type: 'Polygon', coordinates: [rotated] } };
    const water = new GameWater(); water.update([a, b, duplicate], origin, 'medium');
    const retained = mesh(water).geometry;
    expect(water.telemetry.polygons).toBe(2); expect(water.telemetry.duplicates).toBe(1);
    water.update([duplicate, b, a], origin, 'medium');
    expect(mesh(water).geometry).toBe(retained); expect(water.telemetry.geometryUpdates).toBe(1);
    expect(mesh(water).material.transparent).toBe(false); expect(mesh(water).material.depthWrite).toBe(true);
    water.dispose();
  });

  it('preserves split features sharing one source ID and accepts MultiPolygon', () => {
    const a = rectangle(), b = rectangle(100), c = rectangle(200);
    const water = new GameWater();
    water.update([a, b, { geometry: { type: 'MultiPolygon', coordinates: [(c.geometry as { coordinates: number[][][] }).coordinates] } }], origin, 'high');
    expect(water.telemetry.polygons).toBe(3); expect(area(water)).toBeCloseTo(30000, 2);
    water.dispose();
  });

  it('bounds geometry deterministically and retains the last valid mesh after an oversized input', () => {
    const features = Array.from({ length: GAME_WATER_LIMITS.maxPolygons + 8 }, (_, i) => rectangle(i * 2, 0, 1));
    const water = new GameWater(); water.update(features, origin, 'low');
    expect(water.telemetry.polygons).toBe(GAME_WATER_LIMITS.maxPolygons);
    expect(water.telemetry.truncatedPolygons).toBe(8);
    expect(water.telemetry.vertices).toBeLessThanOrEqual(GAME_WATER_LIMITS.vertices.low);
    expect(water.telemetry.geometryBytes).toBeLessThanOrEqual(GAME_WATER_LIMITS.vertices.low * 24);
    const previous = mesh(water).geometry;
    water.update([...features].reverse(), origin, 'low'); expect(mesh(water).geometry).toBe(previous);
    expect(() => water.update(Array.from({ length: GAME_WATER_LIMITS.maxInputFeatures + 1 }, () => rectangle()), origin, 'low')).toThrow(/limit/i);
    expect(mesh(water).geometry).toBe(previous); water.dispose();
  });

  it('skips malformed water without turning holes or lines into a global plane', () => {
    const water = new GameWater();
    water.update([{ geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] } },
      { geometry: { type: 'Polygon', coordinates: [[[0, 0], [NaN, 1], [0, 0]]] } }], origin, 'medium');
    expect(water.telemetry.polygons).toBe(0); expect(mesh(water).visible).toBe(false);
    expect(water.telemetry.skippedFeatures).toBe(2); water.dispose();
  });

  it('rejects a hole outside its shoreline and keeps diagnostics stable on repeated input', () => {
    const invalid = polygon([[[0, 0], [100, 0], [100, 100], [0, 100]], [[130, 30], [170, 30], [170, 70], [130, 70]]]);
    const water = new GameWater(); water.update([invalid, rectangle(200)], origin, 'medium');
    expect(water.telemetry.polygons).toBe(1); expect(water.telemetry.skippedFeatures).toBe(1);
    const geometry = mesh(water).geometry;
    water.update([invalid, rectangle(200)], origin, 'medium');
    expect(water.telemetry.skippedFeatures).toBe(1); expect(mesh(water).geometry).toBe(geometry);
    const malformed: GameWaterFeature = { geometry: { type: 'MultiPolygon', coordinates: Array.from({ length: GAME_WATER_LIMITS.maxInputFeatures + 1 }, () => []) } };
    expect(() => water.update([malformed], origin, 'medium')).toThrow(/limit/i);
    expect(mesh(water).geometry).toBe(geometry); water.dispose();
  });

  it('keeps world-space normal phases continuous across mesh origins and periodic seams', () => {
    const anotherOrigin = { longitude: 61.42, latitude: 55.17 };
    const another = MercatorCoordinate.fromLngLat([anotherOrigin.longitude, anotherOrigin.latitude]);
    const point = MercatorCoordinate.fromLngLat(geographic([170, -60]) as [number, number]);
    const local = (o: MercatorCoordinate) => [(point.x - o.x) / o.meterInMercatorCoordinateUnits(), (point.y - o.y) / o.meterInMercatorCoordinateUnits()] as const;
    const a = waterSurfaceCoordinates(local(reference), origin), b = waterSurfaceCoordinates(local(another), anotherOrigin);
    const normalA = sampleGameWaterNormal(a, 321.75, 'medium'), normalB = sampleGameWaterNormal(b, 321.75, 'medium');
    normalA.forEach((value, index) => expect(value).toBeCloseTo(normalB[index], 6));
    const wrapped = sampleGameWaterNormal([a[0] + GAME_WATER_PERIOD_METERS, a[1] - GAME_WATER_PERIOD_METERS], 321.75, 'high');
    normalA.forEach((value, index) => expect(value).toBeCloseTo(wrapped[index], 10));
    expect(sampleGameWaterNormal(a, 322.75, 'medium')).not.toEqual(normalA);
  });

  it('keeps stylized ripple slopes subtle instead of turning wide coherent waves into bright color bands',()=>{
    let energy=0;
    for(let i=0;i<1024;i++){
      const normal=sampleGameWaterNormal([(i*47.317)%256,(i*91.127)%256],17.3,'medium');
      energy+=normal[0]*normal[0]+normal[2]*normal[2];
    }
    const rms=Math.sqrt(energy/1024);expect(rms).toBeLessThan(.032);expect(rms).toBeGreaterThan(.008);
  });

  it('uses only the supplied clock, keeps buffers retained, and freezes low quality', () => {
    const water = new GameWater(); water.update([rectangle()], origin, 'medium');
    const geometry = mesh(water).geometry, uniforms = mesh(water).material.uniforms;
    water.setTime(100.25); expect(uniforms.waterTime.value).toBe(100.25);
    for (let i = 0; i < 120; i++) water.setTime(100.25);
    expect(uniforms.waterTime.value).toBe(100.25); expect(mesh(water).geometry).toBe(geometry);
    water.setTime(101); expect(uniforms.waterTime.value).toBe(101);
    water.update([rectangle()], origin, 'low'); water.setTime(1000);
    expect(uniforms.waterTime.value).toBe(0); expect(uniforms.rippleStrength.value).toBe(0);
    expect(sampleGameWaterNormal([33, 47], 1000, 'low')).toEqual([0, 1, 0]);
    expect(() => water.setTime(NaN)).toThrow(/clock/i);
    const dispose = vi.spyOn(mesh(water).geometry, 'dispose'); water.dispose(); water.dispose();
    expect(dispose).toHaveBeenCalledTimes(1); expect(water.object.children).toHaveLength(0);
  });
});
