// @vitest-environment jsdom
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { WorldSceneProps } from '../renderer/types';
import { hashSeed } from '../renderer/rng';
import { StaticDemoProvider } from './data/StaticDemoProvider';
import { DEFAULT_CONTEXT } from './navigation';
import type { DemoDatasetManifestV1, DemoPresence, PublicFictionalPersonV1 } from './types';

const fixture = vi.hoisted(() => ({ scene: null as WorldSceneProps | null }));
vi.mock('../renderer/WorldScene', () => ({ WorldScene: (props: WorldSceneProps) => { fixture.scene = props; return null; } }));
vi.mock('../renderer/game/TiledGameScene', () => ({ default: (props: WorldSceneProps) => { fixture.scene = props; return null; } }));
vi.mock('./aggregateRoadFlows', () => ({ buildAggregateRoadFlows: () => null }));
import { DemoCity } from './DemoCity';

const manifest: DemoDatasetManifestV1 = {
  contract: 'DemoDatasetManifestV1', datasetId: 'vehicle-retention-fixture', version: '1',
  representation: 'fictional_demo', scientificClaim: false, predictiveValidation: false,
  startYear: 2026, endYear: 2036, initialPopulation: 2, seed: 1, assets: {},
  provenance: { source: 'Fictional crossing unit fixture', notes: 'No external data.', sourceHashes: {} }, licenses: [],
};
const context = { ...DEFAULT_CONTEXT, presentationMinutes: 750, presentationSeekRevision: 0, playing: true,
  camera: { longitude: 61.4, latitude: 55.16, zoom: 17.2, pitch: 45, bearing: 0 } };
const sortedIds = ['fixture-car-a', 'fixture-car-b'].sort((a,b) => hashSeed(a)-hashSeed(b));
const newcomerId = sortedIds[0]!, retainedId = sortedIds[1]!;
const profile = (id: string): PublicFictionalPersonV1 => ({
  contract: 'PublicFictionalPersonV1', id, name: id, age: 30, ageBand: '18-34', sex: 'female', employment: 'employed',
  occupation: 'demo', householdId: id, householdSize: 1, territoryId: 'RU-CHE-SET', territoryName: 'Fixture', biography: 'Fictional',
  interests: [], scenario: 'baseline', demographicYear: 2026, datasetId: manifest.datasetId,
  representation: 'fictional_demo', spatialRepresentation: 'visual_synthesis', isFictional: true,
});
function makeProvider() {
  const provider = new StaticDemoProvider({ datasetId: manifest.datasetId, territories: [], scenarios: [],
    data: { baseline: { id: 'baseline', people: [], snapshots: [] }, inflow: { id: 'inflow', people: [], snapshots: [] },
      ageing: { id: 'ageing', people: [], snapshots: [] } } }, manifest,
  { contract: 'OriginalSyntheticBundleExportV1', sourceRunId: 'synthetic-chelyabinsk-v1', run: {}, completion: {}, geography: [], population: [], events_aggregate: [] });
  provider.prepareViewport = vi.fn(async () => {});
  vi.spyOn(provider, 'getLayout').mockReturnValue({ buildings: [], roads: [{ id: 'road', coordinates: [[61.4,55.16],[61.41,55.16]], drivable: true, walkable: false }] });
  const people = [profile('old-driver'), profile('new-driver')];
  vi.spyOn(provider, 'getVisibleCandidates').mockImplementation(() => [...people]);
  vi.spyOn(provider, 'getPerson').mockImplementation(id => people.find(person => person.id === id) ?? null);
  let oldActive = true;
  vi.spyOn(provider, 'getPresence').mockImplementation((id, minute): DemoPresence => {
    const elapsed = Math.round((minute - 750) * 60), old = id === 'old-driver';
    const active = old ? oldActive : elapsed >= 5;
    const distance = 100 + elapsed * 8 + (old ? 0 : 1);
    return { personId: id, state: active ? 'vehicle' : 'home', buildingId: active ? null : 'home',
      vehicleId: active ? old ? retainedId : newcomerId : null, roadId: active ? 'road' : null,
      position: active ? [61.4 + distance / (111195 * Math.cos(55.16 * Math.PI / 180)), 55.16] : null,
      routeProgress: .5, direction: 'forward', speedMps: 8, routeMode: 'ping_pong',
      activity: 'Fictional trip', representation: 'visual_synthesis' };
  });
  return { provider, stopOld: () => { oldActive = false; } };
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); fixture.scene = null; });

it('keeps an already displayed canonical car when a lower-ranked newcomer enters its glyph at the five-second refresh', async () => {
  const { provider } = makeProvider();
  const view = render(<DemoCity provider={provider} context={context} />);
  await waitFor(() => expect(view.getByTestId('demo-city').dataset.populationState).toBe('ready'));
  expect(fixture.scene?.entities?.map(entity => entity.id)).toEqual([retainedId]);
  const initialLongitude = fixture.scene!.entities![0]!.longitude;
  for (const seconds of [5,10,15]) {
    view.rerender(<DemoCity provider={provider} context={{...context,presentationMinutes:750+seconds/60}} />);
    expect(fixture.scene?.entities?.map(entity => entity.id)).toEqual([retainedId]);
    expect((fixture.scene!.entities![0]!.longitude-initialLongitude)*111195*Math.cos(55.16*Math.PI/180)).toBeCloseTo(seconds*8,5);
    expect(JSON.parse(view.getByTestId('demo-city').dataset.vehicleDeclutter!).previousRetainedCount).toBe(1);
  }
});

it('resets preference on an explicit seek instead of carrying a history-dependent display into another time', async () => {
  const { provider } = makeProvider();
  const view = render(<DemoCity provider={provider} context={context} />);
  await waitFor(() => expect(view.getByTestId('demo-city').dataset.populationState).toBe('ready'));
  view.rerender(<DemoCity provider={provider} context={{...context,presentationMinutes:750+5/60}} />);
  expect(fixture.scene?.entities?.map(entity => entity.id)).toEqual([retainedId]);
  view.rerender(<DemoCity provider={provider} context={{...context,presentationMinutes:750+5/60,presentationSeekRevision:1}} />);
  expect(fixture.scene?.entities?.map(entity => entity.id)).toEqual([newcomerId]);
});

it('releases an inactive retained car and accepts the current provider entrant without copying stale positions', async () => {
  const { provider, stopOld } = makeProvider();
  const view = render(<DemoCity provider={provider} context={context} />);
  await waitFor(() => expect(view.getByTestId('demo-city').dataset.populationState).toBe('ready'));
  expect(fixture.scene?.entities?.map(entity => entity.id)).toEqual([retainedId]);
  stopOld();
  view.rerender(<DemoCity provider={provider} context={{...context,presentationMinutes:750+5/60}} />);
  expect(fixture.scene?.entities?.map(entity => entity.id)).toEqual([newcomerId]);
  expect(fixture.scene?.entities?.[0]?.longitude).toBeCloseTo(61.4+141/(111195*Math.cos(55.16*Math.PI/180)),9);
});

it('preserves two active game cars through a later crossing while the native renderer keeps its overlap policy', async () => {
  const { provider, stopOld } = makeProvider();
  const original = vi.mocked(provider.getPresence).getMockImplementation()!;
  vi.mocked(provider.getPresence).mockImplementation((id,minute,scenario,year) => {
    const row=original(id,minute,scenario,year);
    if(id!=='new-driver')return row;
    const elapsed=Math.round((minute-750)*60),distance=171-elapsed*7;
    return {...row!,state:'vehicle',vehicleId:newcomerId,roadId:'road',buildingId:null,
      position:[61.4+distance/(111195*Math.cos(55.16*Math.PI/180)),55.16],direction:'reverse',speedMps:7};
  });
  const gameContext={...context,cityGraphicsBackend:'tiled_game' as const};
  const view=render(<DemoCity provider={provider} context={gameContext}/>);
  await waitFor(()=>expect(fixture.scene?.entities).toHaveLength(2));
  view.rerender(<DemoCity provider={provider} context={{...gameContext,presentationMinutes:750+5/60}}/>);
  expect(fixture.scene?.entities?.map(entity=>entity.id).sort()).toEqual([...sortedIds]);
  expect(JSON.parse(view.getByTestId('demo-city').dataset.vehicleDeclutter!).retainedOverlap).toBe(1);
  view.rerender(<DemoCity provider={provider} context={{...gameContext,cityGraphicsBackend:'native_map',presentationMinutes:750+5/60}}/>);
  expect(fixture.scene?.entities).toHaveLength(1);
  stopOld();
  view.rerender(<DemoCity provider={provider} context={{...gameContext,presentationMinutes:750+10/60}}/>);
  await waitFor(()=>expect(fixture.scene?.entities?.map(entity=>entity.id)).toEqual([newcomerId]));
});
