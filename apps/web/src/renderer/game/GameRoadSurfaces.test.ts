import { describe, expect, it, vi } from 'vitest';
import { MercatorCoordinate } from 'maplibre-gl';
import { BoxGeometry, Mesh, MeshBasicMaterial, Raycaster, Vector3 } from 'three';
import type { CityRoadV2 } from '../../demo/data/CityPackV2';
import type { VerifiedCityBuildingSnapshot } from '../verifiedCityBuildingTypes';
import { localToMercatorMatrix } from './cameraAdapter';
import { GameRoadSurfaces, GAME_ROAD_SURFACE_LIMITS, prepareGameRoadSurfaces } from './GameRoadSurfaces';
import { resolveGameRoadWidth } from './gameRoadWidth';
import miassBridge from './fixtures/miass-bridge-deck-v1.json';

const origin = { longitude: 61.39466, latitude: 55.1654 }, transform = localToMercatorMatrix(origin);
function geographic([x, z]: readonly number[]): [number, number] {
  const p = new Vector3(x, 0, z).applyMatrix4(transform), ll = new MercatorCoordinate(p.x, p.y).toLngLat(); return [ll.lng, ll.lat];
}
function road(id: string, points: number[][], extra: Partial<CityRoadV2> = {}): CityRoadV2 {
  return { id, coordinates: points.map(geographic), className: 'residential', lanes: 2, oneway: false, walkable: true, drivable: true,
    nodeIds: points.map((_, i) => `${id}-${i}`), startNodeId: `${id}-0`, endNodeId: `${id}-${points.length - 1}`,
    bridge: false, tunnel: false, layer: 0, maxspeed: null, ...extra };
}
function options() {
  const nw = geographic([-50, -50]), se = geographic([50, 50]), bounds = [nw[0], se[1], se[0], nw[1]] as const;
  const buildings: VerifiedCityBuildingSnapshot = { datasetVersion: 'city-v2', signature: 'b', data: { type: 'FeatureCollection', features: [] },
    canonicalIds: new Set(), cells: ['source-cell'], coverage: 'complete_viewport', coverageBounds: bounds, invalidBuildings: 0,
    omittedBuildings: 0, vertexCount: 0 };
  return { origin, bounds, buildings, qualityTier: 'high' as const };
}
function triangleContains(point: number[], a: number[], b: number[], c: number[]) {
  const cross = (p: number[], q: number[], r: number[]) => (q[0]! - p[0]!) * (r[1]! - p[1]!) - (q[1]! - p[1]!) * (r[0]! - p[0]!);
  const signs = [cross(a, b, point), cross(b, c, point), cross(c, a, point)];
  return signs.every(n => n >= -1e-5) || signs.every(n => n <= 1e-5);
}
function covered(positions: Float32Array, x: number, z: number) {
  for (let i = 0; i < positions.length; i += 9) if (triangleContains([x, z], [positions[i]!, positions[i + 2]!],
    [positions[i + 3]!, positions[i + 5]!], [positions[i + 6]!, positions[i + 8]!])) return true;
  return false;
}

describe('source metric road surfaces', () => {
  it('retains material programs across changed and temporarily empty road geometry',()=>{
    const surfaces=new GameRoadSurfaces(),config=options();surfaces.update([road('moving',[[-40,0],[40,0]])],config);
    const original=new Map(surfaces.object.children.map(object=>[object.name,(object as Mesh).material]));
    const disposals=[...original.values()].map(material=>vi.spyOn(material as MeshBasicMaterial,'dispose'));
    surfaces.update([road('moving',[[-40,4],[40,4]])],config);
    for(const object of surfaces.object.children)expect((object as Mesh).material).toBe(original.get(object.name));
    surfaces.update([],config);expect(disposals.every(spy=>spy.mock.calls.length===0)).toBe(true);
    surfaces.update([road('moving',[[-40,8],[40,8]])],config);
    for(const object of surfaces.object.children)expect((object as Mesh).material).toBe(original.get(object.name));
    surfaces.dispose();expect(disposals.every(spy=>spy.mock.calls.length===1)).toBe(true);
  });
  it('adds bounded light lane paint while preserving bridge holes, building clearance and original road coordinates',()=>{
    const config=options();config.buildings.data.features.push({type:'Feature',id:'obstacle',properties:{},geometry:{type:'Polygon',coordinates:
      [[[-5,-5],[5,-5],[5,5],[-5,5],[-5,-5]].map(geographic)]}});
    config.buildings.canonicalIds.add('obstacle');config.buildings.vertexCount=5;
    const source=road('painted',[[-80,0],[80,0]],{lanes:2}),copy=JSON.stringify(source),result=prepareGameRoadSurfaces([source],config);
    expect(result.diagnostics.laneMarkings).toBeGreaterThan(0);
    const paint=Array.from(result.batches.paving.positions).filter((_,i)=>i%3===1);expect(paint.every(y=>Math.abs(y-.078)<1e-6)).toBe(true);
    expect(covered(result.batches.paving.positions,0,0)).toBe(false);expect(JSON.stringify(source)).toBe(copy);
    for(let i=0;i<result.batches.paving.positions.length;i+=3)expect(Math.abs(result.batches.paving.positions[i]!)).toBeLessThanOrEqual(50.001);
    expect(result.geometryBytes*6+result.diagnostics.markingClearanceBytes).toBeLessThanOrEqual(GAME_ROAD_SURFACE_LIMITS.bytes);
  });
  it('restores the real Miass deck and metric bridge roads without water gaps or depth overlays', () => {
    const ring = miassBridge.deck.geometry.coordinates[0]!;
    const bounds = [Math.min(...ring.map(p => p[0]!)) - .001, Math.min(...ring.map(p => p[1]!)) - .001,
      Math.max(...ring.map(p => p[0]!)) + .001, Math.max(...ring.map(p => p[1]!)) + .001] as const;
    const config = { ...options(), origin: miassBridge.origin, bounds, buildings: { ...options().buildings, coverageBounds: bounds },
      bridgeFeatures: [miassBridge.deck] };
    const input = miassBridge.roads.flatMap(feature => (feature.geometry.type === 'MultiLineString' ? feature.geometry.coordinates : [feature.geometry.coordinates])
      .map((coordinates, i) => ({ ...road(`${feature.id}-${i}`, [[0, 0], [1, 1]], {bridge:true,layer:1}), coordinates: coordinates as [number,number][],
        className: feature.properties.class, drivable: feature.properties.class !== 'path', lanes: feature.properties.class === 'path' ? null : 3 })));
    const result = prepareGameRoadSurfaces(input, config);
    expect(result.diagnostics.bridgeDeckPolygons).toBe(1); expect(result.diagnostics.confirmedBridgeRoads).toBe(4);
    expect(result.batches.asphalt.positions.length).toBeGreaterThan(0);
    const inverse = localToMercatorMatrix(config.origin).invert();
    const local = (p: readonly number[]) => { const m=MercatorCoordinate.fromLngLat([p[0]!,p[1]!]);return new Vector3(m.x,m.y,0).applyMatrix4(inverse); };
    const corners = ring.slice(0,-1).map(local);
    for (let u=.05;u<1;u+=.1) for(let v=.05;v<1;v+=.1){
      const near=corners[0]!.clone().lerp(corners[1]!,u),far=corners[3]!.clone().lerp(corners[2]!,u),p=near.lerp(far,v);
      expect(covered(result.batches.paving.positions,p.x,p.z)).toBe(true);
    }
    const surfaces=new GameRoadSurfaces();surfaces.update(input,config);expect(surfaces.telemetry.draws).toBeLessThanOrEqual(3);
    const vehicleRoad=input.find(row=>row.drivable)!;
    const roadPoint=local(vehicleRoad.coordinates[0]!).lerp(local(vehicleRoad.coordinates.at(-1)!),.5);
    const actor=new Mesh(new BoxGeometry(1,1.5,1),new MeshBasicMaterial());actor.position.set(roadPoint.x,.85,roadPoint.z);actor.updateMatrixWorld();surfaces.object.updateMatrixWorld(true);
    const hits=new Raycaster(new Vector3(roadPoint.x,10,roadPoint.z),new Vector3(0,-1,0)).intersectObjects([actor,...surfaces.object.children]);
    expect(hits[0]!.object).toBe(actor);expect(hits.some(hit=>hit.object!==actor&&Math.abs(hit.point.y-.065)<1e-5)).toBe(true);
    actor.geometry.dispose();actor.material.dispose();surfaces.dispose();
  });

  it('clips bridge roads to confirmed decks including holes, deduplicates fragments, and omits unmatched levels',()=>{
    const rings=[[[-20,-10],[20,-10],[20,10],[-20,10],[-20,-10]],[[-3,-3],[-3,3],[3,3],[3,-3],[-3,-3]]];
    const deck={id:0,sourceLayer:'transportation',properties:{class:'bridge',brunnel:'bridge',layer:1},geometry:{type:'Polygon',coordinates:rings.map(r=>r.map(geographic))}};
    const inputs=[road('confirmed',[[-40,0],[40,0]],{bridge:true,layer:1}),road('wrong-level',[[-40,7],[40,7]],{bridge:true,layer:2}),road('tunnel',[[-40,-7],[40,-7]],{tunnel:true,layer:1})];
    const config={...options(),bridgeFeatures:[deck]};const result=prepareGameRoadSurfaces(inputs,config);
    expect(result.diagnostics.confirmedBridgeRoads).toBe(1);expect(result.diagnostics.omittedElevatedRoads).toBe(2);
    for(const surface of ['asphalt','paving'] as const){expect(covered(result.batches[surface].positions,0,0)).toBe(false);expect(covered(result.batches[surface].positions,25,0)).toBe(false)}
    expect(covered(result.batches.asphalt.positions,10,0)).toBe(true);expect(covered(result.batches.asphalt.positions,0,7)).toBe(false);
    const reversed={...deck,id:'other-tile',geometry:{...deck.geometry,coordinates:deck.geometry.coordinates.map(r=>[...r].reverse())}};
    const duplicate=prepareGameRoadSurfaces([...inputs].reverse(),{...config,bridgeFeatures:[reversed,deck,deck]});
    expect(duplicate.batches).toEqual(result.batches);expect(duplicate.diagnostics.bridgeDeckPolygons).toBe(1);
    const surfaces=new GameRoadSurfaces();surfaces.update(inputs,config);const children=[...surfaces.object.children];
    surfaces.update(inputs,{...config,bridgeFeatures:[{...deck,geometry:{type:'Polygon',coordinates:[]}}]});
    expect(surfaces.telemetry.state).toBe('error_retained');expect(surfaces.object.children).toEqual(children);surfaces.dispose();
  });

  it('keeps the full metric bridge width across internal deck triangulation edges',()=>{
    const deck={properties:{class:'bridge',brunnel:'bridge',layer:1},geometry:{type:'Polygon',coordinates:
      [[[-20,-10],[20,-10],[20,10],[-20,10],[-20,-10]].map(geographic)]}};
    const result=prepareGameRoadSurfaces([road('bridge',[[-15,0],[15,0]],{bridge:true,layer:1,lanes:3})],{...options(),bridgeFeatures:[deck]});
    for(let x=-14;x<=14;x+=2)for(let z=-4;z<=4;z+=1)expect(covered(result.batches.asphalt.positions,x,z)).toBe(true);
    expect(result.curbEdges).toHaveLength(0);
    expect(Array.from(result.batches.paving.positions).filter((_,i)=>i%3===1).every(y=>Math.abs(y-.045)<1e-5||Math.abs(y-.078)<1e-5)).toBe(true);
    expect(Math.max(...Array.from(result.batches.asphalt.positions).filter((_,i)=>i%3===1))).toBeCloseTo(.065,5);
  });

  it('renders exact Mercator centerlines at source width or the disclosed lane/class width', () => {
    expect(resolveGameRoadWidth({ lanes: 4, className: 'primary', drivable: true }).width).toBe(12.6);
    expect(resolveGameRoadWidth({ width: '9 m', lanes: 4 }).source).toBe('source');
    expect(resolveGameRoadWidth({ className: 'footway', drivable: false }).width).toBe(2);
    const input = road('main', [[-30, 0], [30, 0]], { lanes: 4 }); const before = JSON.stringify(input);
    const result = prepareGameRoadSurfaces([input], options()); const positions = result.batches.asphalt.positions;
    expect(Math.min(...Array.from(positions).filter((_, i) => i % 3 === 2))).toBeCloseTo(-6.3, 5);
    expect(Math.max(...Array.from(positions).filter((_, i) => i % 3 === 2))).toBeCloseTo(6.3, 5);
    expect(covered(positions, 0, 0)).toBe(true); expect(result.diagnostics.laneWidthRoads).toBe(1);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('keeps a T junction continuous and has no curb wall across its open mouths', () => {
    const result = prepareGameRoadSurfaces([road('main', [[-40, 0], [40, 0]]), road('stem', [[0, 0], [0, 40]])], options());
    const asphalt = result.batches.asphalt.positions;
    for (const [x, z] of [[0, 0], [-3, 0], [3, 0], [0, 3], [0, 10], [-30, 0], [30, 0]]) expect(covered(asphalt, x!, z!)).toBe(true);
    for (const curb of result.curbEdges) {
      const x = (curb.a[0] + curb.b[0]) / 2, z = (curb.a[1] + curb.b[1]) / 2;
      expect(Math.abs(x) < 3.299 && z > -3.299 && z < 35).toBe(false);
      expect(Math.abs(z) < 3.299 && x > -35 && x < 35).toBe(false);
    }
  });

  it('deduplicates reversed, repeated source segments and preserves rounded end coverage', () => {
    const a = road('a', [[-20, 0], [20, 0]]), b = road('b', [[20, 0], [-20, 0]]);
    const single = prepareGameRoadSurfaces([a], options()), duplicate = prepareGameRoadSurfaces([b, a, a], options());
    expect(duplicate.batches.asphalt.positions).toEqual(single.batches.asphalt.positions);
    expect(duplicate.batches.curb.positions).toEqual(single.batches.curb.positions);
    expect(covered(single.batches.asphalt.positions, 22, 0)).toBe(true);
    expect(covered(single.batches.asphalt.positions, 23.5, 3.5)).toBe(false);
    const surfaces = new GameRoadSurfaces(); surfaces.update([a], options()); const updates = surfaces.telemetry.geometryUpdates;
    surfaces.update([b, a, a], options()); expect(surfaces.telemetry.geometryUpdates).toBe(updates); surfaces.dispose();
  });

  it('clips every surface and curb vertex to actual verified source bounds', () => {
    const result = prepareGameRoadSurfaces([road('outside', [[-200, 0], [200, 0]], { lanes: 4 })], options());
    for (const batch of Object.values(result.batches)) for (let i = 0; i < batch.positions.length; i += 3) {
      expect(batch.positions[i]).toBeGreaterThanOrEqual(-50.0001); expect(batch.positions[i]).toBeLessThanOrEqual(50.0001);
      expect(batch.positions[i + 2]).toBeGreaterThanOrEqual(-50.0001); expect(batch.positions[i + 2]).toBeLessThanOrEqual(50.0001);
    }
    expect(result.curbEdges.some(edge => Math.abs(edge.a[0] - edge.b[0]) < 1e-6 && Math.abs(edge.a[0]) > 49)).toBe(false);
  });

  it('uses distinct pedestrian paving and omits unmeasured elevated or underground roads', () => {
    const result = prepareGameRoadSurfaces([road('path', [[-40, 10], [40, 10]], { className: 'footway', drivable: false, lanes: null }),
      road('bridge', [[-30, 0], [30, 0]], { bridge: true }), road('tunnel', [[-30, 20], [30, 20]], { tunnel: true }),
      road('level', [[-30, 30], [30, 30]], { layer: 1 })], options());
    expect(result.batches.asphalt.positions).toHaveLength(0); expect(result.batches.paving.positions.length).toBeGreaterThan(0);
    expect(result.diagnostics.omittedElevatedRoads).toBe(3);
  });

  it('retains prior viable geometry through loading, unverified coverage, errors and rejects excessive inputs', () => {
    const surfaces = new GameRoadSurfaces(), roads = [road('a', [[-30, 0], [30, 0]])];
    surfaces.update(roads, options()); const children = [...surfaces.object.children], updates = surfaces.telemetry.geometryUpdates;
    surfaces.update(roads, options()); expect(surfaces.telemetry.geometryUpdates).toBe(updates);
    surfaces.update([], { ...options(), loading: true }); expect(surfaces.telemetry.state).toBe('loading_retained');
    surfaces.update(roads, { ...options(), buildings: null }); expect(surfaces.telemetry.state).toBe('unverified_retained');
    surfaces.update([{ ...roads[0]!, coordinates: [] }], options()); expect(surfaces.telemetry.state).toBe('error_retained');
    expect(surfaces.object.children).toEqual(children);
    expect(() => prepareGameRoadSurfaces(Array.from({ length: GAME_ROAD_SURFACE_LIMITS.roads + 1 }, () => roads[0]!), options())).toThrow(/budget/u);
    surfaces.dispose();
  });

  it('owns at most three opaque PBR meshes within 16MiB and disposes each resource once', () => {
    const surfaces = new GameRoadSurfaces(); surfaces.update([road('a', [[-30, 0], [30, 0]]),
      road('p', [[0, -30], [0, 30]], { className: 'footway', drivable: false, lanes: null })], options());
    const meshes = surfaces.object.children as Mesh[];
    expect(meshes.length).toBeLessThanOrEqual(3); expect(meshes.length).toBeGreaterThan(1);
    const disposals = meshes.map(mesh => vi.spyOn(mesh.geometry, 'dispose'));
    for (const mesh of meshes) { expect((mesh.material as { transparent: boolean }).transparent).toBe(false); expect(mesh.receiveShadow).toBe(true); }
    expect(surfaces.telemetry.retainedBytes).toBeLessThanOrEqual(16 * 1024 * 1024);
    surfaces.dispose(); surfaces.dispose(); for (const spy of disposals) expect(spy).toHaveBeenCalledOnce();
    expect(surfaces.object.children).toHaveLength(0); expect(surfaces.telemetry.retainedBytes).toBe(0);
  });

  it('prioritizes complete road bodies before omitting excessive curb decoration', () => {
    const roads = Array.from({ length: 120 }, (_, i) => road(`short-${i}`, [[-45 + i % 20 * 4.5, -40 + Math.floor(i / 20) * 12],
      [-43 + i % 20 * 4.5, -40 + Math.floor(i / 20) * 12]], { lanes: null, className: 'service' }));
    const result = prepareGameRoadSurfaces(roads, options());
    expect(result.diagnostics.retainedSegments).toBe(roads.length);
    expect(result.geometryBytes * 4).toBeLessThanOrEqual(GAME_ROAD_SURFACE_LIMITS.bytes);
    for (const batch of Object.values(result.batches)) for (let i = 0; i < batch.normals.length; i += 3) {
      expect(Math.hypot(batch.normals[i]!, batch.normals[i + 1]!, batch.normals[i + 2]!)).toBeCloseTo(1, 5);
    }
    for (let i = 1; i < result.batches.asphalt.normals.length; i += 3) expect(result.batches.asphalt.normals[i]).toBe(1);
  });
});
