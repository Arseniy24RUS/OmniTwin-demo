import { describe, expect, it } from 'vitest';
import { MercatorCoordinate } from 'maplibre-gl';
import type { Polygon, MultiPolygon, Position } from 'geojson';
import type { VerifiedCityBuildingSnapshot } from '../renderer/verifiedCityBuildingTypes';
import { ACTOR_CLEARANCE_LIMITS, buildActorRoadHints, createActorFootprintClearance } from '../renderer/game/actorFootprintClearance';
import type { CityRoadV2 } from './data/CityPackV2';
import type { WorldSceneMovementPayload } from '../renderer/types';
import { existsSync, readFileSync } from 'node:fs';
import { buildVerifiedCityBuildings } from './verifiedCityBuildings';
import type { CityCellV2 } from './data/CityPackV2';
import { createHash } from 'node:crypto';
import { ActorColumnsBridge } from '../renderer/game/actorColumnsBridge';

const origin = { longitude: 61.39466, latitude: 55.1654, altitude: 0 };
const anchor = MercatorCoordinate.fromLngLat([origin.longitude, origin.latitude]);
const meter = anchor.meterInMercatorCoordinateUnits();
function geographic(east: number, south: number): Position {
  const point = new MercatorCoordinate(anchor.x + east * meter, anchor.y + south * meter).toLngLat();
  return [point.lng, point.lat];
}
function ring(west: number, north: number, east: number, south: number): Position[] {
  return [[west, north], [east, north], [east, south], [west, south], [west, north]].map(([x, z]) => geographic(x!, z!));
}
const nw = geographic(-100, -100), se = geographic(100, 100);
const viewportBounds = [nw[0]!, se[1]!, se[0]!, nw[1]!] as const;
const polygon = (...rings: Position[][]): Polygon => ({ type: 'Polygon', coordinates: rings });
function snapshot(...geometries: (Polygon | MultiPolygon)[]): VerifiedCityBuildingSnapshot {
  let vertexCount = 0;
  for (const geometry of geometries) for (const part of geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates)
    for (const line of part) vertexCount += line.length;
  return { datasetVersion: 'verified-test', signature: 'fixture', coverage: 'complete_viewport',
    omittedBuildings: 0, invalidBuildings: 0, vertexCount, cells: ['verified-cell'],
    canonicalIds: new Set(geometries.map((_, i) => `building:${i}`)),
    data: { type: 'FeatureCollection', features: geometries.map((geometry, i) => ({ type: 'Feature',
      id: `building:${i}`, properties: { canonical_id: `building:${i}` }, geometry })) } };
}
const build = (value = snapshot(polygon(ring(0, 0, 10, 10)))) => createActorFootprintClearance({ snapshot: value, origin, viewportBounds });

describe('verified actor footprint clearance', () => {
  it('uses bridge-compatible East/South physical metres and circular body clearance at walls and corners', () => {
    const guard = build()!;
    expect(guard).not.toBeNull();
    expect(guard.isPointClear(5, 5, .35)).toBe(false);
    expect(guard.isPointClear(-.34, 5, .35)).toBe(false);
    expect(guard.isPointClear(-.35, 5, .35)).toBe(false);
    expect(guard.isPointClear(-.36, 5, .35)).toBe(true);
    expect(guard.isPointClear(5, -.36, .35)).toBe(true);
    expect(guard.isPointClear(-.24, -.24, .35)).toBe(false);
    expect(guard.isPointClear(-.26, -.26, .35)).toBe(true);
    expect(guard.isPointClear(0, 5, 0)).toBe(false);
  });

  it('preserves courtyard holes, with a margin along inner walls regardless of ring orientation', () => {
    for (const reverse of [false, true]) {
      const rings = [ring(0, 0, 20, 20), ring(5, 5, 15, 15)];
      const guard = build(snapshot(polygon(...rings.map(value => reverse ? value.toReversed() : value))))!;
      expect(guard.isPointClear(10, 10, .35)).toBe(true);
      expect(guard.isPointClear(5.34, 10, .35)).toBe(false);
      expect(guard.isPointClear(5, 10, 0)).toBe(false);
      expect(guard.isPointClear(5.36, 10, .35)).toBe(true);
      expect(guard.isPointClear(2, 10, .35)).toBe(false);
    }
  });

  it('treats multipolygon components and other buildings as a union, never as extra holes', () => {
    const value = snapshot({ type: 'MultiPolygon', coordinates: [[ring(0, 0, 10, 10)], [ring(20, 0, 30, 10)]] },
      polygon(ring(12, 2, 18, 8)));
    const guard = build(value)!;
    expect(guard.diagnostics.polygons).toBe(3);
    expect(guard.isPointClear(5, 5, .35)).toBe(false);
    expect(guard.isPointClear(25, 5, .35)).toBe(false);
    expect(guard.isPointClear(15, 5, .35)).toBe(false);
    expect(guard.isPointClear(11, 5, .35)).toBe(true);
  });

  it('requires the entire body within the verified viewport and rejects invalid query values', () => {
    const guard = build(snapshot())!;
    expect(guard.isPointClear(0, 0, .35)).toBe(true);
    for (const args of [[100.1, 0, 0], [99.8, 0, .35], [-99.8, 0, .35], [0, -99.8, .35],
      [0, 99.8, .35], [NaN, 0, 0], [0, Infinity, 0], [0, 0, -1], [0, 0, Infinity], [0, 0, 5.01]])
      expect(guard.isPointClear(args[0]!, args[1]!, args[2]!)).toBe(false);
  });

  it('never builds a guard from incomplete or inconsistent snapshots', () => {
    expect(createActorFootprintClearance({ snapshot: null, origin, viewportBounds })).toBeNull();
    for (const changes of [{ coverage: 'partial_viewport' as const }, { coverage: 'unresolved' as const },
      { omittedBuildings: 1 }, { invalidBuildings: 1 }, { vertexCount: 4 }, { canonicalIds: new Set<string>() }])
      expect(build({ ...snapshot(polygon(ring(0, 0, 10, 10))), ...changes })).toBeNull();
    expect(createActorFootprintClearance({ snapshot: snapshot(), origin: { ...origin, latitude: NaN }, viewportBounds })).toBeNull();
    expect(createActorFootprintClearance({ snapshot: snapshot(), origin, viewportBounds: [1, 2, 0, 3] })).toBeNull();
  });

  it('rejects malformed coordinates and blocks finite ambiguous topology by its entire envelope', () => {
    for (const geometry of [polygon(ring(0, 0, 10, 10).slice(0, -1)), polygon([[0, 0], [NaN, 1], [1, 1], [0, 0]])])
      expect(build(snapshot(geometry))).toBeNull();
    for (const geometry of [
      polygon([[0, 0], [10, 10], [0, 10], [8, 0], [0, 0]].map(([x, z]) => geographic(x!, z!))),
      polygon([[0, 0], [10, 0], [5, 0], [10, 10], [0, 10], [0, 0]].map(([x, z]) => geographic(x!, z!))),
      polygon(ring(0, 0, 20, 20), ring(20, 5, 25, 10)),
      polygon(ring(0, 0, 20, 20), ring(25, 5, 30, 10)),
      polygon(ring(0, 0, 20, 20), ring(5, 5, 12, 12), ring(10, 10, 15, 15)),
      polygon(ring(0, 0, 20, 20), ring(5, 5, 15, 15), ring(6, 6, 8, 8)),
    ]) {
      const guard = build(snapshot(geometry))!;
      expect(guard.diagnostics.conservativePolygons).toBe(1);
      expect(guard.isPointClear(2, 2, .35)).toBe(false);
      expect(guard.isPointClear(-10, -10, .35)).toBe(true);
    }
  });

  it('honors construction/query work budgets without partial-success geometry or growing caches', () => {
    const value = snapshot(polygon(ring(0, 0, 20, 20), ring(5, 5, 15, 15)));
    for (const limits of [{ vertices: 5 }, { gridEntries: 1 }, { topologyChecks: 1 }, { gridCells: 1 }])
      expect(createActorFootprintClearance({ snapshot: value, origin, viewportBounds, limits })).toBeNull();
    const tiny = createActorFootprintClearance({ snapshot: value, origin, viewportBounds, limits: { queryEdges: 3 } })!;
    expect(tiny.isPointClear(10, 10, .35)).toBe(false);
    const guard = build(value)!;
    const before = { ...guard.diagnostics };
    for (let i = 0; i < 10_000; i++) expect(guard.isPointClear(10, 10, .35)).toBe(true);
    expect(guard.diagnostics).toEqual(before);
    expect(guard.diagnostics.vertices).toBeLessThanOrEqual(ACTOR_CLEARANCE_LIMITS.vertices);
    expect(guard.diagnostics.gridEntries).toBeLessThanOrEqual(ACTOR_CLEARANCE_LIMITS.gridEntries);
    expect(guard.diagnostics.indexBytes).toBeLessThan(64_000);
    expect(createActorFootprintClearance({ snapshot: value, origin,
      viewportBounds: [60, 54, 63, 56] })).toBeNull();
  });

  it('does not retain mutable source geometry or change answers on feature reordering', () => {
    const value = snapshot(polygon(ring(0, 0, 10, 10)), polygon(ring(20, 0, 30, 10)));
    const first = build(value)!;
    const second = build({ ...value, data: { ...value.data, features: value.data.features.toReversed() } })!;
    value.data.features[0]!.geometry.coordinates.length = 0;
    for (const x of [-1, 0, 5, 11, 20, 25, 31]) expect(first.isPointClear(x, 5, .35)).toBe(second.isPointClear(x, 5, .35));
  });

  it('confines conservative topology fallback to its own envelope while preserving other courtyard holes', () => {
    const invalid = polygon([[-30, -30], [-20, -20], [-30, -20], [-22, -30], [-30, -30]].map(([x, z]) => geographic(x!, z!)));
    const guard = build(snapshot(invalid, polygon(ring(0, 0, 20, 20), ring(5, 5, 15, 15))))!;
    expect(guard.diagnostics.conservativePolygons).toBe(1);
    expect(guard.isPointClear(-25, -25, .35)).toBe(false);
    expect(guard.isPointClear(10, 10, .35)).toBe(true);
    expect(guard.isPointClear(2, 2, .35)).toBe(false);
  });

  const cityRoot = new URL('../../public/city-v2/chelyabinsk-osm-138afac3f0d74f25/cells/16/', import.meta.url);
  it.skipIf(!existsSync(cityRoot))('accepts the five real source cells requested first by the paused quarter QA', () => {
    for (const name of ['43944/20676-8c7c1fd8a7c0e189.json', '43944/20675-554d416aafaff65d.json',
      '43945/20676-3bed03093390eee0.json', '43943/20676-6e318636e71b2499.json', '43944/20677-9d8514d6f39037ec.json']) {
      const cell = JSON.parse(readFileSync(new URL(name, cityRoot), 'utf8')) as CityCellV2;
      const source = buildVerifiedCityBuildings({ datasetVersion: 'local-verified-qa', cells: [cell], viewport: { bbox: cell.bbox } });
      expect(source.coverage).toBe('complete_viewport');
      expect(createActorFootprintClearance({ snapshot: source, origin, viewportBounds: cell.bbox }), name).not.toBeNull();
    }
  });
  it.skipIf(!existsSync(cityRoot))('contains the real repeated-vertex halo footprint without disabling the whole quarter', () => {
    const bytes = readFileSync(new URL('43943/20675-66cc2190a84bf04f.json', cityRoot));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe('66cc2190a84bf04f07a1f0019429028636ec21a22823fd24ff3fc0e6875fe6a5');
    const cell = JSON.parse(bytes.toString()) as CityCellV2;
    const source = buildVerifiedCityBuildings({ datasetVersion: 'local-verified-qa', cells: [cell], viewport: { bbox: cell.bbox } });
    expect(source.coverage).toBe('complete_viewport');
    const guard = createActorFootprintClearance({ snapshot: source, origin, viewportBounds: cell.bbox });
    expect(guard).not.toBeNull();
    expect(guard!.diagnostics.conservativeBuildingIds).toContain('openmaptiles_buildings:185832733');
    expect(guard!.diagnostics.conservativePolygons).toBe(1);
    expect(guard!.isPointClear(-9999, -9999, .35)).toBe(false);
  });
});

describe('source-backed actor road hints', () => {
  const road = (id: string, extra: Partial<CityRoadV2> = {}): CityRoadV2 => ({ id, coordinates: [[61.4, 55.16], [61.41, 55.16]],
    nodeIds: ['a', 'b'], startNodeId: 'a', endNodeId: 'b', className: 'primary', lanes: 4, maxspeed: 60,
    oneway: false, walkable: true, drivable: true, bridge: false, tunnel: false, layer: 0, ...extra });
  const movement = (...fromNodes: string[]): WorldSceneMovementPayload => ({ nodes: [], routes: [], edges: fromNodes.map((fromNodeId, i) => ({
    edgeId: `edge:${i}`, fromNodeId, toNodeId: 'end', edgeKind: 'sidewalk', crossesRoad: false, direction: 'bidirectional',
    allowedModes: ['pedestrian'], geometry: [[61.4, 55.16], [61.41, 55.16]],
    visualSpeedMetersPerSecond: { pedestrian: 1.2, car: null, bicycle: null, transit: null } })) });

  it('resolves a connected corridor through explicit constituent IDs and uses its narrowest verified class',()=>{
    const hints=buildActorRoadHints(movement('presence:connected:start'),[road('a'),road('b',{className:'service',lanes:null})],
      [{id:'connected',oneway:false,drivable:true,sourceRoadIds:['a','b'],segments:[{roadId:'a'},{roadId:'b'}]}]);
    expect(hints.get('edge:0')).toMatchObject({atGrade:true,className:'service',geometryKind:'carriageway_centerline',
      sourceRoadIds:['a','b'],widthScope:'minimum_constituent_corridor'});
    expect(hints.get('edge:0')?.lanes).toBeUndefined();
  });
  it('distinguishes missing corridor provenance from a verified bridge while disabling synthetic placement for both',()=>{
    const hints=buildActorRoadHints(movement('presence:missing:start','presence:bridge-corridor:start'),[road('bridge',{bridge:true})],
      [{id:'missing',sourceRoadIds:['absent']},{id:'bridge-corridor',sourceRoadIds:['bridge']}]);
    expect(hints.get('edge:0')).toMatchObject({atGrade:false,gradeUnverified:true});
    expect(hints.get('edge:1')).toMatchObject({atGrade:false,gradeUnverified:false});
  });

  it('joins exact authored from-node strings without parsing, fuzzy names or spatial matches', () => {
    const roads = [road('osm:road:12'), road('footway', { className: 'footway', drivable: false, lanes: null })];
    const hints = buildActorRoadHints(movement('presence:osm:road:12:start', 'presence:footway:start',
      'prefix-presence:osm:road:12:start', 'presence:osm:road:12:start:tail', 'presence:missing:start'), roads);
    expect([...hints]).toEqual([['edge:0', { atGrade: true, className: 'primary', lanes: 4, geometryKind: 'carriageway_centerline',oneway:false,drivable:true }],
      ['edge:1', { atGrade: true, className: 'footway', geometryKind: 'pedestrian_centerline',oneway:false,drivable:false }]]);
  });

  it('does not classify conflicting pedestrian and motor access as a surveyed sidewalk', () => {
    const hints = buildActorRoadHints(movement('presence:bad:start', 'presence:unknown:start'), [
      road('bad', { className:'footway', drivable:true }), road('unknown', { className:'unknown', drivable:false }),
    ]);
    expect(hints.get('edge:0')).toEqual({atGrade:false});
    expect(hints.get('edge:1')?.geometryKind).toBeUndefined();
  });

  it('explicitly denies bridge/tunnel/nonzero/unknown grade to prevent a default-width fallback', () => {
    const roads = [road('bridge', { bridge: true }), road('tunnel', { tunnel: true }), road('layer', { layer: 1 }),
      road('bad-layer', { layer: NaN }), road('bad-lanes', { lanes: -1 })];
    const hints = buildActorRoadHints(movement(...roads.map(r => `presence:${r.id}:start`)), roads);
    expect(hints.size).toBe(5);
    for (const hint of hints.values()) expect(hint).toEqual({ atGrade: false });
  });

  it('fails closed for contradictory source duplicates and ambiguous repeated edge IDs', () => {
    const base = road('a');
    for (const roads of [[base, { ...base }], [base, road('a', { bridge: true })], [road('a', { bridge: true }), base]]) {
      const hints = buildActorRoadHints(movement('presence:a:start'), roads);
      expect(hints.get('edge:0')?.atGrade).toBe(roads[0]!.bridge === roads[1]!.bridge);
    }
    const duplicate = movement('presence:a:start', 'presence:a:start'); duplicate.edges[1]!.edgeId = 'edge:0';
    expect(buildActorRoadHints(duplicate, [base]).get('edge:0')).toEqual({ atGrade: false });
  });

  it('keeps an ambiguous bridge edge on its original corridor instead of re-enabling default-width displacement', () => {
    const graph = movement('presence:a:start', 'presence:unmatched:start', 'presence:unmatched:start');
    graph.edges[1]!.edgeId = 'edge:0'; graph.edges[2]!.edgeKind = 'lane';
    const hints = buildActorRoadHints(graph, [road('a', { bridge: true })]);
    const entity = { id: 'fixture', kind: 'person' as const, representation: 'focus_person_1to1' as const, representedCount: 1,
      longitude: origin.longitude, latitude: origin.latitude, heading: 90, activity: 'walk' as const, color: '#dddddd', seed: 15 };
    const source = { id: entity.id, entityKind: 'person' as const, presentationTime: '2026-01-01T00:00:00Z',
      motion: { mode: 'network_edge' as const, routeId: null, edgeId: 'edge:0', progress: .5, speedMps: 1, direction: 'forward' as const } };
    const bridge = new ActorColumnsBridge([entity], graph, [source], origin, Date.UTC(2026, 0, 1) / 1000,
      { roadHintsByEdgeId: hints, isPointClear: () => true });
    const unchanged = new ActorColumnsBridge([entity], graph, [source], origin, Date.UTC(2026, 0, 1) / 1000, { derivePairedSidewalks: false });
    expect(bridge.sidewalkPreview.derivedActors).toBe(0);
    expect([...bridge.sample(0).previousPositions]).toEqual([...unchanged.sample(0).previousPositions]);
  });
});
