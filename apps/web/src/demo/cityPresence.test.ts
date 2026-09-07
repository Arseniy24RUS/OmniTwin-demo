import { describe, expect, it } from 'vitest';
import { buildCityPresenceFrame, CITY_PRESENTATION_EPOCH_SECONDS, type CityPresenceProvider } from './cityPresence';
import type { DemoContextV1, DemoLayout, DemoPresence, PublicFictionalPersonV1 } from './types';
import { compileLivingSceneMovement } from '../renderer/living/sceneMovement';
import { createLivingPartition } from '../renderer/living/partition';
import { createLivingSimulation, interpolateLivingSimulation, seekLivingSimulation } from '../renderer/living/simulation';
import { livingRouteAdherenceViolations } from '../renderer/living/telemetry';

const context: DemoContextV1 = {
  datasetId: 'fixture', scenario: 'baseline', year: 2026, territoryId: 'RU-CHE-SET', cohort: null,
  presentationMinutes: 720.9, weather: 'clear', playing: true, speed: 1,
  camera: { longitude: 61.4, latitude: 55.16, zoom: 18, pitch: 45, bearing: 0 },
};
const roads: DemoLayout['roads'] = [
  { id: 'path', coordinates: [[61.4, 55.16], [61.402, 55.16], [61.402, 55.161]], walkable: true, drivable: false },
  { id: 'road', coordinates: [[61.4, 55.161], [61.403, 55.161]], walkable: false, drivable: true },
];
const profile = (id: string, householdId = id): PublicFictionalPersonV1 => ({
  contract: 'PublicFictionalPersonV1', id, name: id, age: 30, ageBand: '18-34', sex: 'female',
  employment: 'employed', occupation: 'demo', householdId, householdSize: 1,
  territoryId: 'district', territoryName: 'Demo', biography: 'Fictional', interests: [],
  scenario: 'baseline', demographicYear: 2026, datasetId: 'fixture',
  representation: 'fictional_demo', spatialRepresentation: 'visual_synthesis', isFictional: true,
});
const presence = (personId: string, state: DemoPresence['state'] = 'outdoor'): DemoPresence => ({
  personId, state, buildingId: null, vehicleId: state === 'vehicle' ? 'vehicle:family' : null,
  roadId: state === 'vehicle' ? 'road' : 'path',
  position: state === 'vehicle' ? [61.4015, 55.161] : [61.402, 55.1605],
  routeProgress: 0.5, direction: 'forward', speedMps: state === 'vehicle' ? 6 : 1.25,
  activity: 'Fictional trip', representation: 'visual_synthesis',
});
function provider(rows: Array<{ person: PublicFictionalPersonV1; presence: DemoPresence }>, layoutRoads = roads): CityPresenceProvider {
  return {
    getLayout: () => ({ buildings: [], roads: layoutRoads }),
    getVisibleCandidates: () => rows.map(({ person }) => person),
    getPresence: (id) => rows.find(({ person }) => person.id === id)?.presence ?? null,
    getPerson: (id) => rows.find(({ person }) => person.id === id)?.person ?? null,
  };
}

describe('provider city presence frame', () => {
  it('renders outdoors people and one actual household vehicle, keeping indoor people in rosters', () => {
    const rows = ['outdoor', 'vehicle', 'vehicle', 'home', 'work', 'study', 'unplaced'].map((state, index) => ({
      person: profile(`person:${index}`), presence: presence(`person:${index}`, state as DemoPresence['state']),
    }));
    const frame = buildCityPresenceFrame(provider(rows), context);
    expect(frame.entities.map(({ id }) => id)).toEqual(['person:0', 'vehicle:family']);
    expect(frame.peopleCount).toBe(1);
    expect(frame.vehicleCount).toBe(1);
    expect(frame.entities.find(({ id }) => id === 'person:0')).toMatchObject({ longitude: 61.402, latitude: 55.1605 });
    expect(frame.presentationTimeSeconds).toBe(CITY_PRESENTATION_EPOCH_SECONDS + 720 * 60);
  });

  it('passes one integer-minute anchor into the provider and preserves that frame within the minute', () => {
    const seen: number[] = [];
    const source = provider([{ person: profile('a'), presence: presence('a') }]);
    const initial = source.getPresence;
    source.getPresence = (id, minute, scenario, year) => { seen.push(minute); return initial(id, minute, scenario, year); };
    expect(buildCityPresenceFrame(source, context)).toEqual(buildCityPresenceFrame(source, { ...context, presentationMinutes: 720.1 }));
    expect(seen).toEqual([720, 720]);
  });

  it('keeps exact provider positions on the graph while reconciling source versus local distance metrics', () => {
    const frame = buildCityPresenceFrame(provider([{ person: profile('a'), presence: presence('a') }]), context);
    const origin = [context.camera.longitude, context.camera.latitude] as const;
    const compiled = compileLivingSceneMovement({ ...frame.movement, entities: frame.movementEntities,
      origin, presentationTimeSeconds: frame.presentationTimeSeconds });
    const partition = createLivingPartition(frame.entities, { origin, zoom: 18, screenSizePixels: 20,
      movementGraph: compiled.graph, routeIdByEntityId: compiled.routeIdByEntityId, routePhaseByEntityId: compiled.routePhaseByEntityId });
    const simulation = createLivingSimulation(partition, { presentationTimeSeconds: frame.presentationTimeSeconds });
    expect(frame.movementEntities[0]!.motion.progress).not.toBe(0.5);
    expect(partition.position.currentX[0]).toBeCloseTo((61.402 - 61.4) * Math.cos(55.16 * Math.PI / 180) * 111_320, 2);
    expect(partition.position.currentY[0]).toBeCloseTo((55.1605 - 55.16) * 110_540, 2);
    seekLivingSimulation(simulation, frame.presentationTimeSeconds + 10);
    expect(livingRouteAdherenceViolations(partition, interpolateLivingSimulation(simulation))).toBe(0);
  });

  it('honors context filters, caps and camera proximity without duplicate profile identities', () => {
    const rows = Array.from({ length: 900 }, (_, i) => ({ person: profile(`person:${i}`), presence: presence(`person:${i}`) }));
    expect(buildCityPresenceFrame(provider(rows), context, { maxPeople: 999 }).peopleCount).toBe(500);
    expect(buildCityPresenceFrame(provider(rows), context, { maxPeople: 7 }).peopleCount).toBe(7);
    expect(buildCityPresenceFrame(provider(rows), { ...context, cohort: { sex: 'male' } }).peopleCount).toBe(0);
    expect(buildCityPresenceFrame(provider(rows), { ...context, territoryId: 'missing' }).peopleCount).toBe(0);
    expect(buildCityPresenceFrame(provider(rows), { ...context, camera: { ...context.camera, longitude: 71 } }).peopleCount).toBe(0);
    const duplicates = provider([rows[0]!, rows[0]!]);
    expect(buildCityPresenceFrame(duplicates, context).peopleCount).toBe(1);
  });

  it('adds an explicitly selected moving person beyond the bounded pool and prioritizes its actor', () => {
    const rows = [
      { person: profile('a'), presence: presence('a') },
      { person: profile('selected'), presence: presence('selected') },
    ];
    const source = provider(rows);
    source.getVisibleCandidates = () => [rows[0]!.person];
    expect(buildCityPresenceFrame(source, context, { maxPeople: 1, selectedId: 'selected' }).entities[0]?.id).toBe('selected');
    rows[1]!.presence = { ...presence('selected'), state: 'home', buildingId: 'home' };
    expect(buildCityPresenceFrame(source, context, { maxPeople: 1, selectedId: 'selected' }).entities[0]?.id).toBe('a');
  });

  it('fails closed for missing geometry, bad positions and mismatched modes', () => {
    const person = profile('a');
    expect(buildCityPresenceFrame(provider([{ person, presence: presence('a') }], []), context).entities).toEqual([]);
    const invalid = { ...presence('a'), position: [61.405, 55.165] as [number, number] };
    expect(buildCityPresenceFrame(provider([{ person, presence: invalid }]), context).entities).toEqual([]);
    const carOnPath = { ...presence('a', 'vehicle'), roadId: 'path' };
    expect(buildCityPresenceFrame(provider([{ person, presence: carOnPath }]), context).entities).toEqual([]);
  });

  it('builds directed routes without reversing them and rejects inconsistent shared-edge speeds', () => {
    const sourceRoads = roads.map((road) => ({ ...road, oneway: road.id === 'road' }));
    const frame = buildCityPresenceFrame(provider([{ person: profile('a'), presence: presence('a', 'vehicle') }], sourceRoads), context);
    expect(frame.movement.edges[0]?.direction).toBe('forward');
    expect(frame.movement.routes[0]?.traversal).toBe('once');
    const differentSpeeds = provider([
      { person: profile('a'), presence: presence('a') },
      { person: profile('b'), presence: { ...presence('b'), speedMps: 2 } },
    ]);
    expect(() => buildCityPresenceFrame(differentSpeeds, context)).toThrow(/speed/);
  });
});
