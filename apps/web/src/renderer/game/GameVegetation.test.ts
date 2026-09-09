import { describe, expect, it, vi } from 'vitest';
import { MercatorCoordinate } from 'maplibre-gl';
import { InstancedMesh, Vector3 } from 'three';
import type { VerifiedCityBuildingSnapshot } from '../verifiedCityBuildingTypes';
import type { CityRoadV2 } from '../../demo/data/CityPackV2';
import { localToMercatorMatrix } from './cameraAdapter';
import { GameVegetation, GAME_VEGETATION_LIMITS, prepareGameVegetation, type GameVegetationFeature } from './GameVegetation';

const origin = { longitude: 61.39466, latitude: 55.1654 };
const matrix = localToMercatorMatrix(origin);
function geographic([x, z]: readonly number[]) {
  const p = new Vector3(x, 0, z).applyMatrix4(matrix), ll = new MercatorCoordinate(p.x, p.y).toLngLat();
  return [ll.lng, ll.lat];
}
const ring = (x = 0, z = 0, width = 300, height = width) => [[x, z], [x + width, z], [x + width, z + height], [x, z + height], [x, z]];
function area(rings = [ring()], id = 'park-1'): GameVegetationFeature {
  return { id, sourceLayer: 'landuse', geometry: { type: 'Polygon', coordinates: rings.map(r => r.map(geographic)) }, properties: { class: 'park' } };
}
const geoBounds = (b = [-50, -50, 1050, 1050]) => {
  const nw = geographic([b[0], b[1]]), se = geographic([b[2], b[3]]);
  return [nw[0]!, se[1]!, se[0]!, nw[1]!] as const;
};
function options(localBounds = [-50, -50, 1050, 1050]) {
  const bounds = geoBounds(localBounds);
  const buildings: VerifiedCityBuildingSnapshot = { datasetVersion: 'city-v2', signature: 'a', data: { type: 'FeatureCollection', features: [] },
    canonicalIds: new Set(), cells: ['verified-cell'], coverage: 'complete_viewport', coverageBounds: bounds,
    invalidBuildings: 0, omittedBuildings: 0, vertexCount: 0 };
  return { origin, bounds, buildings, roads: [], qualityTier: 'high' as const, sourceId: 'openmaptiles', datasetVersion: 'source-release' };
}

describe('bounded source-backed game vegetation', () => {
  it('scatters only synthesized trees through the full stable cell while preserving exact source points',()=>{
    const point={id:'unchanged-point',sourceLayer:'poi',properties:{natural:'tree'},geometry:{type:'Point',coordinates:geographic([40,50])}};
    const result=prepareGameVegetation([area(),point],options());
    const exact=result.placements.find(p=>p.geometryQuality==='exact_tree_point')!;
    expect(exact.x).toBeCloseTo(40,6);expect(exact.z).toBeCloseTo(50,6);
    const fractions=result.placements.filter(p=>p.geometryQuality==='area_derived').map(p=>{
      const mercator=new Vector3(p.x,0,p.z).applyMatrix4(matrix),cell=mercator.x*40075016.68557849/30;return cell-Math.floor(cell);
    });
    expect(fractions.some(value=>value<.2)).toBe(true);
    expect(fractions.some(value=>value>.8)).toBe(true);
  });
  it('uses one varied canopy per tree instead of repeating the same multi-lobed crown assembly',()=>{
    const trees=new GameVegetation();trees.update([area()],options());
    const crowns=(trees.object.children as InstancedMesh[]).filter(mesh=>mesh.name.includes('crowns'));
    expect(crowns.reduce((sum,mesh)=>sum+mesh.count,0)).toBe(trees.telemetry.instances);
    const aspects=new Set<string>();
    for(const mesh of crowns)for(let i=0;i<mesh.count;i++){
      const a=mesh.instanceMatrix.array,offset=i*16;
      const x=Math.hypot(a[offset]!,a[offset+1]!,a[offset+2]!),z=Math.hypot(a[offset+8]!,a[offset+9]!,a[offset+10]!);
      aspects.add((x/z).toFixed(2));
    }
    expect(aspects.size).toBeGreaterThan(5);trees.dispose();
  });
  it('places crowns only inside actual park polygons, outside holes and concave cutouts', () => {
    const result = prepareGameVegetation([area([ring(), ring(90, 90, 120).reverse()]),
      area([[[400, 0], [700, 0], [700, 80], [480, 80], [480, 300], [400, 300], [400, 0]]], 'concave')], options());
    expect(result.placements.length).toBeGreaterThan(100);
    for (const p of result.placements) {
      expect(p.provenance).toBe('visual_synthesis');
      expect(p.x > 90 - p.radius && p.x < 210 + p.radius && p.z > 90 - p.radius && p.z < 210 + p.radius).toBe(false);
      expect(p.x > 480 && p.z > 80).toBe(false);
    }
  });

  it('deduplicates repeated and clipped source tiles on one stable world grid', () => {
    const full = prepareGameVegetation([area()], options()).placements;
    const split = prepareGameVegetation([area([ring(0, 0, 150, 300)]), area([ring(150, 0, 150, 300)]),
      area([ring(150, 0, 150, 300)].map(r => [...r].reverse()), 'other-tile-id')], options()).placements;
    expect(split.map(p => [p.id, p.x, p.z])).toEqual(full.map(p => [p.id, p.x, p.z]));
    expect(new Set(split.map(p => p.id)).size).toBe(split.length);
  });

  it('keeps crown radius plus 2.5m clear of exact building contours and source-width roads', () => {
    const opts = options();
    opts.buildings.data.features.push({ type: 'Feature', id: 'source:house', properties: { canonical_id: 'source:house' },
      geometry: { type: 'Polygon', coordinates: [ring(80, 80, 60).map(geographic)] } });
    opts.buildings.canonicalIds = new Set(['source:house']);
    const roads = [{ id: 'road-1', geometry: { type: 'LineString', coordinates: [[170, -20], [170, 320]].map(geographic) }, properties: { width: '12 m' } }];
    const result = prepareGameVegetation([area()], { ...opts, roads });
    expect(result.placements.length).toBeGreaterThan(100);
    for (const p of result.placements) {
      const gap = Math.hypot(Math.max(80 - p.x, 0, p.x - 140), Math.max(80 - p.z, 0, p.z - 140));
      expect(gap).toBeGreaterThanOrEqual(p.radius + 2.5 - 1e-5);
      expect(Math.abs(p.x - 170)).toBeGreaterThanOrEqual(p.radius + 6 + 2.5 - 1e-5);
    }
    expect(result.diagnostics.sourceWidthRoads).toBe(1);
  });

  it('accepts explicit source tree points but ignores arbitrary points and unsupported land classes', () => {
    const point = { id: 'tree-1', sourceLayer: 'poi', geometry: { type: 'Point', coordinates: geographic([40, 50]) }, properties: { natural: 'tree' } };
    const result = prepareGameVegetation([point, point, { ...point, id: 'bench', properties: { class: 'bench' } },
      { ...area(), properties: { class: 'residential' } }], options());
    expect(result.placements).toHaveLength(1); expect(result.placements[0]?.geometryQuality).toBe('exact_tree_point');
    expect(result.placements[0]?.x).toBeCloseTo(40, 6);
  });

  it('checks actual CityRoadV2 coordinates so a source footway cannot receive a tree', () => {
    const road: CityRoadV2 = { id: 'source-footway', coordinates: [[150, -20], [150, 320]].map(p => geographic(p) as [number, number]),
      nodeIds: ['node-a', 'node-b'], oneway: false, walkable: true, drivable: false, className: 'footway',
      startNodeId: 'node-a', endNodeId: 'node-b', lanes: null, maxspeed: null, bridge: false, tunnel: false, layer: 0 };
    const exactTree = { id: 'tree-on-footway', sourceLayer: 'poi', properties: { natural: 'tree' },
      geometry: { type: 'Point', coordinates: geographic([150, 150]) } };
    const result = prepareGameVegetation([area(), exactTree], { ...options(), roads: [road] });
    expect(result.diagnostics.classWidthRoads).toBe(1);
    expect(result.placements.length).toBeGreaterThan(100);
    expect(result.placements.some(p => p.geometryQuality === 'exact_tree_point')).toBe(false);
    for (const p of result.placements) expect(Math.abs(p.x - 150)).toBeGreaterThanOrEqual(p.radius + 1 + 2.5 - 1e-5);
  });

  it('uses the same lane-derived carriageway width as the visible metric road surface', () => {
    const road = { coordinates: [[150, -20], [150, 320]].map(p => geographic(p) as [number, number]),
      className: 'residential', lanes: 4, drivable: true };
    const result = prepareGameVegetation([area()], { ...options(), roads: [road] });
    expect(result.diagnostics.laneWidthRoads).toBe(1);
    for (const p of result.placements) expect(Math.abs(p.x - 150)).toBeGreaterThanOrEqual(p.radius + 6.3 + 2.5 - 1e-5);
  });

  it('rejects declared roads with missing, malformed or excessive coordinates instead of assuming clear land', () => {
    for (const road of [{ className: 'footway' }, { className: 'footway', coordinates: [] },
      { className: 'footway', coordinates: [[NaN, 55], [61, 55]] },
      { geometry: { type: 'MultiLineString', coordinates: [] } }]) {
      expect(() => prepareGameVegetation([area()], { ...options(), roads: [road] })).toThrow(/road/u);
    }
    const oversized = { className: 'footway', coordinates: Array.from({ length: GAME_VEGETATION_LIMITS.roadVertices + 1 }, () => geographic([150, 150])) };
    expect(() => prepareGameVegetation([area()], { ...options(), roads: [oversized] })).toThrow(/oversized/u);
    const trees = new GameVegetation(); trees.update([area()], options()); const prior = trees.placements;
    trees.update([area()], { ...options(), roads: [{ className: 'footway' }] });
    expect(trees.telemetry.state).toBe('error_retained'); expect(trees.placements).toBe(prior); trees.dispose();
  });

  it('caps tiers and preserves common locations across tier changes and input order', () => {
    const features = [area([ring(0, 0, 1000)])];
    const high = prepareGameVegetation(features, options());
    const low = prepareGameVegetation(features, { ...options(), qualityTier: 'low' });
    expect(high.placements).toHaveLength(GAME_VEGETATION_LIMITS.instances.high);
    expect(low.placements).toHaveLength(GAME_VEGETATION_LIMITS.instances.low);
    expect(low.placements.map(p => p.id)).toEqual(high.placements.slice(0, low.placements.length).map(p => p.id));
    expect(prepareGameVegetation([...features, ...features].reverse(), options()).placements).toEqual(high.placements);
  });

  it('never grows trees outside the verified rectangle and uses a disclosed class road width fallback', () => {
    const opts = options([20, 20, 280, 280]);
    const roads = [{ geometry: [[150, 0], [150, 300]].map(geographic), className: 'primary' }];
    const result = prepareGameVegetation([area()], { ...opts, roads });
    for (const p of result.placements) {
      expect(p.x - p.radius).toBeGreaterThanOrEqual(20 - 1e-5); expect(p.x + p.radius).toBeLessThanOrEqual(280 + 1e-5);
      expect(Math.abs(p.x - 150)).toBeGreaterThanOrEqual(p.radius + 5 + 2.5 - 1e-5);
    }
    expect(result.diagnostics.classWidthRoads).toBe(1);
    expect(result.diagnostics.roadWidthPolicy).toBe('source_width_else_visual_lanes_3m_plus_0_6m_else_visual_class_width');
  });

  it('retains viable meshes while loading or rejected data arrives, then updates once per new placement state', () => {
    const trees = new GameVegetation();
    trees.update([area()], options()); const children = [...trees.object.children]; const updates = trees.telemetry.bufferUpdates;
    trees.update([area(), area()], options()); expect(trees.telemetry.bufferUpdates).toBe(updates);
    trees.update([], { ...options(), loading: true }); expect(trees.telemetry.state).toBe('loading_retained');
    expect(trees.object.children).toEqual(children); expect(trees.telemetry.instances).toBeGreaterThan(0);
    trees.update([area()], { ...options(), buildings: null }); expect(trees.telemetry.state).toBe('unverified_retained');
    const bad = area(); bad.geometry = { type: 'Polygon', coordinates: [[[NaN, 55], [61, 55], [61, 56], [NaN, 55]]] };
    trees.update([bad], options()); expect(trees.telemetry.state).toBe('error_retained');
    expect(trees.telemetry.bufferUpdates).toBe(updates); trees.dispose();
  });

  it('uses at most three opaque instanced draws, bounded buffers, shadows and complete disposal', () => {
    const trees = new GameVegetation(); trees.update([area([ring(0, 0, 1000)])], options());
    expect(trees.object.children.length).toBeLessThanOrEqual(3);
    const meshes = trees.object.children as InstancedMesh[];
    const disposals = meshes.map(mesh => vi.spyOn(mesh.geometry, 'dispose'));
    const materialDisposals = meshes.map(mesh => vi.spyOn(mesh.material as { dispose(): void }, 'dispose'));
    for (const mesh of meshes) { expect(mesh.isInstancedMesh).toBe(true); expect(mesh.castShadow).toBe(true); expect(mesh.receiveShadow).toBe(true);
      expect((mesh.material as { transparent: boolean }).transparent).toBe(false); }
    expect(trees.telemetry.retainedBytes).toBeLessThan(1024 * 1024); expect(trees.telemetry.geometryBytes).toBeGreaterThan(0);
    trees.dispose(); trees.dispose(); expect(trees.object.children).toHaveLength(0); expect(trees.telemetry.retainedBytes).toBe(0);
    for (const disposal of [...disposals, ...materialDisposals]) expect(disposal).toHaveBeenCalledOnce();
  });

  it('rejects excessive or degenerate source input and respects extra verified route clearance', () => {
    expect(() => prepareGameVegetation(Array.from({ length: GAME_VEGETATION_LIMITS.features + 1 }, () => area()), options())).toThrow(/budget/u);
    expect(() => prepareGameVegetation([area([[[0, 0], [10, 0], [20, 0], [0, 0]]])], options())).toThrow(/Degenerate/u);
    const result = prepareGameVegetation([area()], { ...options(), isPointClear: (x, _z, radius) => x - radius > 100 });
    expect(result.placements.length).toBeGreaterThan(0);
    expect(result.placements.every(p => p.x - p.radius > 100)).toBe(true);
  });

  it('keeps crown geometry inside its declared collision radius', () => {
    const trees = new GameVegetation(); trees.update([area()], options());
    for (const child of trees.object.children as InstancedMesh[]) {
      const positions = child.geometry.getAttribute('position');
      for (let i = 0; i < positions.count; i++) {
        expect(Math.hypot(positions.getX(i), positions.getZ(i))).toBeLessThanOrEqual(1.00001);
        expect(positions.getY(i)).toBeGreaterThanOrEqual(-1e-6);
        expect(positions.getY(i)).toBeLessThanOrEqual(1.00001);
      }
      expect(child.instanceColor?.isInstancedBufferAttribute).toBe(true);
    }
    trees.dispose();
  });
});
