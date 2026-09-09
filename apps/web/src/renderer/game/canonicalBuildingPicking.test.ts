import { describe, expect, it } from 'vitest';
import { MercatorCoordinate } from 'maplibre-gl';
import { Ray, Vector3 } from 'three';
import type { Feature, Polygon } from 'geojson';
import type { VerifiedCityBuildingSnapshot } from '../verifiedCityBuildingTypes';
import { localToMercatorMatrix } from './cameraAdapter';
import { CANONICAL_BUILDING_PICK_LIMITS, canonicalBuildingExtrusionHeights, pickCanonicalBuildings } from './canonicalBuildingPicking';

const origin = { longitude: 61.39466, latitude: 55.1654 };
const transform = localToMercatorMatrix(origin);
const sourceId = 'canonical-source-0';
const wallLayer = 'canonical-bank-0-building-3d';
const roofLayer = 'canonical-bank-0-omnitwin-building-roof-3d';
const layerIds = [wallLayer, roofLayer];
function geographic([x, z]: number[]) {
  const point = new Vector3(x, 0, z).applyMatrix4(transform);
  const ll = new MercatorCoordinate(point.x, point.y, point.z).toLngLat();
  return [ll.lng, ll.lat];
}
const square = (x = 0, z = 0, size = 20) => [[x, z], [x + size, z], [x + size, z + size], [x, z + size], [x, z]];
function building(id: string, rings = [square()], properties: Record<string, unknown> = {}): Feature<Polygon> {
  return { type: 'Feature', id, properties: { canonical_id: id, height: 10, ...properties },
    geometry: { type: 'Polygon', coordinates: rings.map(ring => ring.map(geographic)) } };
}
function snapshot(features: Feature<Polygon>[]): VerifiedCityBuildingSnapshot {
  return { datasetVersion: 'source-v1', signature: 'snapshot-1', data: { type: 'FeatureCollection', features },
    canonicalIds: new Set(features.map(feature => String(feature.id))), cells: ['cell-1'], coverage: 'complete_viewport',
    omittedBuildings: 0, invalidBuildings: 0, vertexCount: features.reduce((n, f) => n + f.geometry.coordinates.flat().length, 0) };
}
function rendered(id: string, roof = false) {
  return { id, source: sourceId, properties: { canonical_id: id, height: 999 },
    layer: { id: roof ? roofLayer : wallLayer, type: 'fill-extrusion' } };
}
function pick(ray: Ray, buildings: Feature<Polygon>[], features = buildings.map(f => rendered(String(f.id))), extra = {}) {
  return pickCanonicalBuildings({ ray, origin, zoom: 18, snapshot: snapshot(buildings), features, sourceId, layerIds, ...extra });
}
const down = (x: number, z: number, y = 30) => new Ray(new Vector3(x, y, z), new Vector3(0, -1, 0));

describe('canonical native building ray picking', () => {
  it('hits the exact snapshot roof and active roof cap, not clipped query geometry or query height', () => {
    const house = building('source:a');
    const body = pick(down(10, 10), [house]);
    const cap = pick(down(10, 10), [house], [rendered('source:a'), rendered('source:a', true)]);
    expect(body.complete).toBe(true); expect(body.hit?.id).toBe('source:a');
    expect(body.hit?.point.y).toBeCloseTo(10, 3);
    expect(cap.hit?.point.y).toBeCloseTo(10.25, 3);
    expect(cap.hit?.distance).toBeCloseTo(19.75, 3);
  });

  it('keeps a courtyard hole open but intersects its inward-facing walls', () => {
    const house = building('source:a', [square(), square(5, 5, 10).reverse()]);
    expect(pick(down(10, 10), [house]).hit).toBeNull();
    const wall = pick(new Ray(new Vector3(10, 4, 10), new Vector3(1, 0, 0)), [house]);
    expect(wall.hit?.id).toBe('source:a'); expect(wall.hit?.distance).toBeCloseTo(5, 5);
    expect(pick(down(2, 2), [house]).hit?.id).toBe('source:a');
  });

  it('preserves concave footprints and all MultiPolygon components', () => {
    const house = building('source:a', [[[0, 0], [20, 0], [20, 5], [5, 5], [5, 20], [0, 20], [0, 0]]]);
    expect(pick(down(15, 15), [house]).hit).toBeNull();
    expect(pick(down(2, 15), [house]).hit?.id).toBe('source:a');
    const state = snapshot([house]);
    state.data.features[0] = { ...house, geometry: { type: 'MultiPolygon', coordinates: [house.geometry.coordinates,
      building('unused', [square(50, 0)]).geometry.coordinates] } };
    expect(pick(down(60, 10), [house], [rendered('source:a')], { snapshot: state }).hit?.id).toBe('source:a');
  });

  it('respects the rendered base height and does not add an invisible bottom face', () => {
    const house = building('source:a', [square()], { min_height: 5, render_min_height: 2 });
    const horizontal = (y: number) => new Ray(new Vector3(-10, y, 10), new Vector3(1, 0, 0));
    expect(pick(horizontal(3), [house]).hit).toBeNull();
    expect(pick(horizontal(7), [house]).hit?.distance).toBeCloseTo(10, 5);
    const upward = pick(new Ray(new Vector3(10, 0, 10), new Vector3(0, 1, 0)), [house]);
    expect(upward.hit?.point.y).toBeCloseTo(10, 3);
  });

  it('returns metre distances comparable to actual foreground and background actor intersections', () => {
    const ray = new Ray(new Vector3(-10, 3, 10), new Vector3(1, 0, 0));
    const result = pick(ray, [building('source:far', [square(40, 0)]), building('source:near')]);
    expect(result.hit?.id).toBe('source:near'); expect(result.hit?.distance).toBeCloseTo(10, 5);
    expect(8 < result.hit!.distance).toBe(true); // Visible foreground actor wins.
    expect(15 < result.hit!.distance).toBe(false); // Actor behind the wall is occluded.
    expect(pick(ray, [building('source:near')], undefined, { far: 9 }).hit).toBeNull();
  });

  it('deduplicates material/tile copies and rejects stale or unrelated identities', () => {
    const house = building('source:a');
    const first = pick(down(10, 10), [house]);
    const repeated = pick(down(10, 10), [house], Array.from({ length: 100 }, () => rendered('source:a')));
    expect(repeated.hit?.distance).toBe(first.hit?.distance); expect(repeated.complete).toBe(true);
    expect(pick(down(10, 10), [house], [{ ...rendered('source:a'), source: 'openmaptiles' }]).hit).toBeNull();
    expect(pick(down(10, 10), [house], [rendered('source:stale')])).toMatchObject({ hit: null, complete: false });
    expect(pick(down(10, 10), [house], [{ ...rendered('source:a'), id: 'source:b' }])).toMatchObject({ hit: null, complete: false });
  });

  it('fails closed on malformed or over-budget geometry without returning a partially checked foreground', () => {
    const malformed = building('source:bad'); malformed.geometry.coordinates[0]![1]![0] = NaN;
    expect(pick(down(10, 10), [building('source:a'), malformed])).toMatchObject({ hit: null, complete: false });
    const tooMany = Array.from({ length: CANONICAL_BUILDING_PICK_LIMITS.renderedFeatures + 1 }, () => rendered('source:a'));
    expect(pick(down(10, 10), [building('source:a')], tooMany)).toMatchObject({ hit: null, complete: false });
    expect(pick(new Ray(new Vector3(), new Vector3()), [building('source:a')])).toMatchObject({ hit: null, complete: false });
  });

  it('uses the supplied origin altitude and leaves source geometry and ray unchanged', () => {
    const house = building('source:a'); const before = JSON.stringify(house); const ray = down(10, 10);
    const moved = pick(ray, [house], undefined, { origin: { ...origin, altitude: 3 } });
    expect(moved.hit?.point.y).toBeCloseTo(7, 3);
    expect(JSON.stringify(house)).toBe(before); expect(ray.origin.y).toBe(30); expect(ray.direction.y).toBe(-1);
  });

  it('matches integer-stop presentation height interpolation and source height precedence', () => {
    expect(canonicalBuildingExtrusionHeights({ height: 200 }, 13.5)).toEqual({ base: 0, top: 190 });
    expect(canonicalBuildingExtrusionHeights({ height: 1000 }, 20, true)).toEqual({ base: 0, top: 500.25 });
    expect(canonicalBuildingExtrusionHeights({ height: 0, 'building:levels': '4', render_height: 40, min_height: 0, render_min_height: '2' }, 18))
      .toEqual({ base: 2, top: 12 });
    expect(canonicalBuildingExtrusionHeights({}, 18)).toEqual({ base: 0, top: 5 });
  });
});
