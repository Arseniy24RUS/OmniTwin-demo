import { describe, expect, it } from 'vitest';
import { compileLivingSceneMovement } from '../renderer/living/sceneMovement';
import { createLivingPartition } from '../renderer/living/partition';
import { createLivingSimulation, interpolateLivingSimulation, seekLivingSimulation } from '../renderer/living/simulation';
import { livingRouteAdherenceViolations, livingStablePositionHash } from '../renderer/living/telemetry';
import { buildCityRoadGraph, type CityTransportationFeature } from './cityRoadGraph';

const origin = [61.4, 55.16] as const;
const epoch = 1_735_700_400;
const walkCoordinates = [[61.399, 55.16], [61.4, 55.1602], [61.402, 55.16]];
const carCoordinates = [[61.399, 55.161], [61.4, 55.161], [61.402, 55.162]];
const feature = (
  coordinates: number[][],
  properties: Record<string, unknown> = { class: 'path', subclass: 'footway' },
): CityTransportationFeature => ({
  sourceLayer: 'transportation', properties,
  geometry: { type: 'LineString', coordinates },
});
const build = (features: readonly CityTransportationFeature[]) => buildCityRoadGraph({
  features, origin, presentationTimeSeconds: epoch,
});

describe('source road demo graph', () => {
  it('has no graph or actors until real transportation lines arrive', () => {
    const result = build([]);
    expect(result.entities).toEqual([]);
    expect(result.movement.edges).toEqual([]);
    expect(result.sourceLabel).toMatch(/OpenMapTiles/);
  });

  it('deduplicates and retains IDs under feature, multiline and bidirectional vertex ordering', () => {
    const walk = feature(walkCoordinates);
    const car = feature(carCoordinates, { class: 'minor' });
    const result = build([walk, car]);
    const reordered = build([car, feature([...walkCoordinates].reverse()), walk, car]);
    expect(reordered.signature).toBe(result.signature);
    expect(reordered.roads).toEqual(result.roads);
    expect(reordered.entities).toEqual(result.entities);
    expect(new Set(result.entities.map(({ id }) => id)).size).toBe(result.entities.length);
    const multiline = (lines: number[][][]): CityTransportationFeature => ({
      properties: { class: 'path', subclass: 'footway' },
      geometry: { type: 'MultiLineString', coordinates: lines },
    });
    expect(build([multiline([walkCoordinates, carCoordinates])]).signature)
      .toBe(build([multiline([carCoordinates, walkCoordinates])]).signature);
  });

  it('never moves actors across disconnected line pieces or invalid vertices', () => {
    const result = build([
      feature([[61.4, 55.16], [NaN, 55.16], [61.402, 55.16]]),
      feature([[61.4, 55.16], [61.4, 55.16]]),
      feature([[200, 55.16], [200.1, 55.16]]),
      { properties: { class: 'path' }, geometry: { type: 'Polygon', coordinates: [walkCoordinates] } },
      { properties: { class: 'path' }, geometry: { type: 'MultiLineString', coordinates: [walkCoordinates, carCoordinates] } },
    ]);
    expect(result.roads).toHaveLength(2);
    expect(result.movement.routes.every(({ edgeIds }) => edgeIds.length === 1)).toBe(true);
    expect(() => compileLivingSceneMovement({
      ...result.movement, entities: result.movementEntities, origin, presentationTimeSeconds: epoch,
    })).not.toThrow();
  });

  it('uses walking paths for people and roads for cars, respecting known restrictions', () => {
    const prohibited = [
      { class: 'rail', subclass: 'tram' }, { class: 'ferry' }, { class: 'aerialway' },
      { class: 'path', subclass: 'cycleway' }, { class: 'minor_construction' },
      { class: 'minor', access: false }, { class: 'path', access: 'private' },
      { class: 'path', foot: 'no' }, { class: 'minor', motor_vehicle: 'no' },
      { class: 'minor', brunnel: 'tunnel' },
    ];
    expect(build(prohibited.map((properties) => feature(walkCoordinates, properties))).entities).toEqual([]);
    const result = build([
      feature(walkCoordinates), feature(carCoordinates, { class: 'primary', oneway: -1 }),
    ]);
    expect(result.movement.edges.find(({ edgeKind }) => edgeKind === 'sidewalk')?.allowedModes).toEqual(['pedestrian']);
    const lane = result.movement.edges.find(({ edgeKind }) => edgeKind === 'lane')!;
    expect(lane.allowedModes).toEqual(['car']);
    expect(lane.direction).not.toBe('bidirectional');
    expect(result.movement.routes.find(({ mode }) => mode === 'car')?.traversal).toBe('once');
  });

  it('clips actual segments to the camera window, including lines whose endpoints lie outside it', () => {
    const bounds = [61.399, 55.159, 61.401, 55.161] as const;
    const result = buildCityRoadGraph({
      features: [feature([[61.38, 55.16], [61.42, 55.16]]), feature([[70, 50], [70.1, 50.1]])],
      origin, bounds, presentationTimeSeconds: epoch,
    });
    expect(result.roads).toHaveLength(1);
    expect(result.roads[0]!.coordinates).toEqual([[bounds[0], 55.16], [bounds[2], 55.16]]);
    for (const actor of result.entities) {
      expect(actor.longitude).toBeGreaterThanOrEqual(bounds[0]);
      expect(actor.longitude).toBeLessThanOrEqual(bounds[2]);
      expect(actor.latitude).toBe(55.16);
    }
  });

  it('preserves supplied profile IDs and enforces hard actor and road budgets', () => {
    const features = Array.from({ length: 100 }, (_, index) => feature([
      [61.398, 55.158 + index * 0.00004], [61.404, 55.158 + index * 0.00004],
    ], { class: index % 2 ? 'path' : 'minor' }));
    const result = buildCityRoadGraph({ features, origin, presentationTimeSeconds: epoch, maxPeople: 1_000, maxCars: 1_000 });
    expect(result.entities.filter(({ kind }) => kind !== 'vehicle').length).toBeLessThanOrEqual(500);
    expect(result.entities.filter(({ kind }) => kind === 'vehicle').length).toBeLessThanOrEqual(100);
    expect(result.roads.length).toBeLessThanOrEqual(512);
    const options = { features, origin, presentationTimeSeconds: epoch, peopleIds: ['demo:alice', 'demo:bob'], vehicleIds: ['demo:car'] };
    const profiled = buildCityRoadGraph(options);
    expect(profiled.entities.map(({ id }) => id).sort()).toEqual(['demo:alice', 'demo:bob', 'demo:car']);
    expect(buildCityRoadGraph({ ...options, peopleIds: ['demo:bob', 'demo:alice'] }).entities).toEqual(profiled.entities);
    expect(() => buildCityRoadGraph({ ...options, vehicleIds: ['demo:alice'] })).toThrow(/unique/);
  });

  it('retains source roads when actors are disabled so the provider can register its layout', () => {
    const result = buildCityRoadGraph({ features: [feature(walkCoordinates)], origin,
      presentationTimeSeconds: epoch, maxPeople: 0, maxCars: 0 });
    expect(result.roads).toHaveLength(1);
    expect(result.entities).toEqual([]);
    expect(result.movement.routes).toEqual([]);
  });

  it('keeps closed source routes connected and supplies legal directions at every phase anchor', () => {
    const result = build([
      feature([...walkCoordinates, walkCoordinates[0]!]),
      feature([...carCoordinates, carCoordinates[0]!], { class: 'minor', oneway: -1 }),
    ]);
    expect(result.movement.routes.every(({ traversal }) => traversal === 'loop')).toBe(true);
    const compiled = compileLivingSceneMovement({
      ...result.movement, entities: result.movementEntities, origin, presentationTimeSeconds: epoch,
    });
    expect(() => createLivingPartition(result.entities, {
      zoom: 18, origin, screenSizePixels: 16,
      movementGraph: compiled.graph, routeIdByEntityId: compiled.routeIdByEntityId,
      routePhaseByEntityId: compiled.routePhaseByEntityId,
    })).not.toThrow();
  });

  it('compiles into a valid retained partition and follows supplied polylines while moving', () => {
    const result = build([feature(walkCoordinates), feature(carCoordinates, { class: 'minor' })]);
    const compiled = compileLivingSceneMovement({
      ...result.movement, entities: result.movementEntities, origin, presentationTimeSeconds: epoch,
    });
    const partition = createLivingPartition(result.entities, {
      zoom: 18, origin, screenSizePixels: 16,
      movementGraph: compiled.graph, routeIdByEntityId: compiled.routeIdByEntityId,
      routePhaseByEntityId: compiled.routePhaseByEntityId,
    });
    const simulation = createLivingSimulation(partition, { presentationTimeSeconds: epoch });
    const before = livingStablePositionHash(partition, interpolateLivingSimulation(simulation));
    seekLivingSimulation(simulation, epoch + 5);
    const frame = interpolateLivingSimulation(simulation);
    expect(livingStablePositionHash(partition, frame)).not.toBe(before);
    expect(livingRouteAdherenceViolations(partition, frame)).toBe(0);
    expect(result.entities.every((entity) => entity.kind === 'vehicle'
      ? entity.representedCount === 0 : entity.kind === 'focus' && entity.representedCount === 1)).toBe(true);
  });

  it('rejects invalid origins, clock epochs, bounds and option budgets', () => {
    const options = { features: [], origin, presentationTimeSeconds: epoch };
    expect(() => buildCityRoadGraph({ ...options, origin: [Infinity, 0] })).toThrow(/origin/);
    expect(() => buildCityRoadGraph({ ...options, presentationTimeSeconds: NaN })).toThrow(/epoch/);
    expect(() => buildCityRoadGraph({ ...options, bounds: [62, 56, 61, 55] })).toThrow(/bounds/);
    expect(() => buildCityRoadGraph({ ...options, maxPeople: NaN })).toThrow(/budget/);
  });
});
