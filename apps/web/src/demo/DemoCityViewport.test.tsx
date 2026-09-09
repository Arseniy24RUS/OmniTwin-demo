// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { WorldSceneProps, RendererViewportSnapshot } from '../renderer/types';
import { StaticDemoProvider } from './data/StaticDemoProvider';
import { DEFAULT_CONTEXT } from './navigation';
import type { CityCellV2 } from './data/CityPackV2';
import type { DemoDatasetManifestV1, DemoLayout } from './types';

type SceneFixtureProps=WorldSceneProps & {populationDatasetId?:string};
const fixture = vi.hoisted(() => ({ props: null as SceneFixtureProps | null, frameMinutes: [] as number[], flowOptions: [] as Array<{ viewport?: RendererViewportSnapshot; origin: readonly [number, number] }> }));
vi.mock('../renderer/WorldScene', () => ({ WorldScene: (props: WorldSceneProps) => { fixture.props = props; return null; } }));
vi.mock('../renderer/game/TiledGameScene', () => ({ default: (props: WorldSceneProps) => { fixture.props = props; return null; } }));
vi.mock('./cityPresence', () => ({ CITY_PRESENTATION_EPOCH_SECONDS: 0, cityPresenceAnchorMinutes: (minutes: number) => Math.floor((minutes * 60 + 1e-7) / 5) * 5 / 60,
  buildCityPresenceFrame: (_provider: unknown, context: { presentationMinutes: number }) => { fixture.frameMinutes.push(context.presentationMinutes); return { entities: [], movementEntities: [], movement: null, peopleCount: 0, vehicleCount: 0 }; } }));
vi.mock('./aggregateRoadFlows', () => ({ buildAggregateRoadFlows: (options: { viewport?: RendererViewportSnapshot; origin: readonly [number, number] }) => { fixture.flowOptions.push(options); return null; } }));
import { DemoCity } from './DemoCity';

const manifest: DemoDatasetManifestV1 = {
  contract: 'DemoDatasetManifestV1', datasetId: 'demo-city-viewport-test', version: '1',
  representation: 'fictional_demo', scientificClaim: false, predictiveValidation: false,
  startYear: 2026, endYear: 2036, initialPopulation: 0, seed: 1, assets: {},
  provenance: { source: 'Empty unit-test fixture', notes: 'No population or geometry asset reads.', sourceHashes: {} }, licenses: [],
};
function makeProvider(prepareViewport: StaticDemoProvider['prepareViewport'], layout: DemoLayout = { roads: [], buildings: [] }) {
  const provider = new StaticDemoProvider({ datasetId: manifest.datasetId, territories: [], scenarios: [],
    data: { baseline: { id: 'baseline', people: [], snapshots: [] }, inflow: { id: 'inflow', people: [], snapshots: [] },
      ageing: { id: 'ageing', people: [], snapshots: [] } } }, manifest,
  { contract: 'OriginalSyntheticBundleExportV1', sourceRunId: 'synthetic-chelyabinsk-v1', run: {}, completion: {},
    geography: [], population: [], events_aggregate: [] });
  provider.prepareViewport = prepareViewport;
  vi.spyOn(provider, 'getLayout').mockReturnValue(layout);
  return provider;
}
afterEach(() => { cleanup(); fixture.props = null; fixture.frameMinutes.length = 0; fixture.flowOptions.length = 0; });

it('forwards exact connected-corridor source road provenance to the game scene',async()=>{
  const layout:DemoLayout={buildings:[],roads:[{id:'osm-connected-corridor-v1:car:fixture',coordinates:[[61.4,55.16],[61.401,55.16]],
    sourceRoadIds:['osm-road:10','osm-road:11'],segments:[{roadId:'osm-road:10',fromNodeId:'n1',toNodeId:'n2'},{roadId:'osm-road:11',fromNodeId:'n2',toNodeId:'n3'}]}]};
  const provider=makeProvider(vi.fn(async()=>{}),layout);
  render(<DemoCity provider={provider} context={{...DEFAULT_CONTEXT,cityGraphicsBackend:'tiled_game'}}/>);
  await waitFor(()=>expect(fixture.props?.gameSourceCorridors).toEqual(layout.roads));
  expect(fixture.props?.gameSourceCorridors?.[0]?.sourceRoadIds).toEqual(['osm-road:10','osm-road:11']);
});

it('forwards small explicit seeks, including repeated time values, without treating ordinary ticks as seeks',async()=>{
  const provider=makeProvider(vi.fn(async()=>{}));
  const context={...DEFAULT_CONTEXT,playing:true,presentationMinutes:690,presentationSeekRevision:0};
  const view=render(<DemoCity provider={provider} context={context}/>);
  await waitFor(()=>expect(fixture.props).not.toBeNull());
  expect(fixture.props?.presentationClock?.seekRevision).toBe(0);
  view.rerender(<DemoCity provider={provider} context={{...context,presentationMinutes:690.1}}/>);
  expect(fixture.props?.presentationClock?.seekRevision).toBe(0);
  view.rerender(<DemoCity provider={provider} context={{...context,presentationMinutes:689,presentationSeekRevision:1}}/>);
  expect(fixture.props?.presentationClock?.seekRevision).toBe(1);
  view.rerender(<DemoCity provider={provider} context={{...context,presentationMinutes:689,presentationSeekRevision:2}}/>);
  expect(fixture.props?.presentationClock?.seekRevision).toBe(2);
});

it('draws verified footprints only for a fully covered close viewport, preserving the whole basemap otherwise', async () => {
  let finish: (() => void) | undefined;
  let cells: CityCellV2[] = [];
  let state = 'empty';
  // Bind failure to the requested viewport, not an incidental effect-call ordinal:
  // overview/detail transitions now correctly prepare separate hook scopes.
  const prepareViewport = vi.fn<StaticDemoProvider['prepareViewport']>().mockImplementation(async (_context, _signal, viewport) => {
    if (viewport?.revision === 'pan') throw new Error('Fixture viewport failed');
  }).mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  const provider = Object.assign(makeProvider(prepareViewport, { roads: [], buildings: [{ id: 'metadata-only-do-not-draw', center: [61.405, 55.165] }] }), {
    cityPackV2: { getActiveCells: () => cells, get telemetry() { return { status: state }; }, manifest: { datasetVersion: 'verified-fixture' } },
  });
  const view = render(<DemoCity provider={provider} context={{ ...DEFAULT_CONTEXT, playing: false }} />);
  expect(fixture.props?.populationDatasetId).toBe(provider.manifest.datasetId);
  expect(fixture.props?.verifiedCityBuildings).toBeNull();
  cells = [{ contract: 'DemoCityCellV2', key: '16/1/1', bbox: [61.40,55.16,61.41,55.17], roads: [], buildings: [{
    index: 0, id: 'openmaptiles_buildings:853220400', aliases: [], center: [61.405,55.165], districtId: 'RU-CHE-SET-CEN',
    use: 'work', areaM2: 100, levels: 4, heightM: 12, heightQuality: 'derived_floors', capacityWeight: 1, classificationProvenance: 'source_attribute',
    footprint: { type: 'Polygon', coordinates: [[[61.404,55.164],[61.406,55.164],[61.406,55.166],[61.404,55.164]]] },
  }] }];
  state = 'ready'; await act(async () => finish?.());
  expect(fixture.props?.verifiedCityBuildings).toBeNull();
  const closeViewport = { camera: { ...DEFAULT_CONTEXT.camera, zoom: 17.3 }, bbox: [61.402,55.162,61.408,55.168] as [number,number,number,number], widthCss: 390, heightCss: 654, revision: 'close' };
  act(() => fixture.props?.onViewportChange?.(closeViewport));
  await waitFor(() => expect(fixture.props?.verifiedCityBuildings?.data.features).toHaveLength(1));
  expect(fixture.props?.verifiedCityBuildings?.data.features[0]?.id).toBe('openmaptiles_buildings:853220400');
  const signature = fixture.props!.verifiedCityBuildings!.signature;
  view.rerender(<DemoCity provider={provider} context={{ ...DEFAULT_CONTEXT, playing: false, camera: { ...DEFAULT_CONTEXT.camera, zoom: 14.8 } }} />);
  expect(fixture.props?.verifiedCityBuildings).toBeNull();
  view.rerender(<DemoCity provider={provider} context={{ ...DEFAULT_CONTEXT, playing: false }} />);
  expect(fixture.props?.verifiedCityBuildings?.signature).toBe(signature);
  act(() => fixture.props?.onViewportChange?.({ camera: DEFAULT_CONTEXT.camera, bbox: [61.39,55.15,61.43,55.2], widthCss: 390, heightCss: 654, revision: 'pan' }));
  await waitFor(() => expect(view.getByTestId('demo-city').getAttribute('data-population-state')).toBe('error'));
  expect(fixture.props?.verifiedCityBuildings).toBeNull();
  expect(view.getByTestId('building-coverage-notice').textContent).toContain('базовая карта');
});

it('retains the flow allocation between clock ticks and reallocates on settled bearing/CSS viewport changes', async () => {
  const prepareViewport = vi.fn(async () => {});
  const provider = makeProvider(prepareViewport);
  const context = { ...DEFAULT_CONTEXT, camera: { ...DEFAULT_CONTEXT.camera, zoom: 14.8 }, presentationMinutes: 720, playing: true };
  const view = render(<DemoCity provider={provider} context={context} />);
  await waitFor(() => expect(prepareViewport).toHaveBeenCalledTimes(1));
  const actual: RendererViewportSnapshot = { camera: { ...context.camera, bearing: 94, pitch: 60 }, bbox: [61.39, 55.15, 61.43, 55.2], widthCss: 1480, heightCss: 800, revision: 'flow-1' };
  act(() => fixture.props?.onViewportChange?.(actual));
  await waitFor(() => expect(prepareViewport).toHaveBeenCalledTimes(2));
  expect(fixture.flowOptions.at(-1)?.viewport).toEqual(actual);
  expect(fixture.flowOptions.at(-1)?.origin).toEqual([actual.camera.longitude, actual.camera.latitude]);
  const count = fixture.flowOptions.length;
  view.rerender(<DemoCity provider={provider} context={{ ...context, presentationMinutes: 720.2 }} />);
  expect(fixture.flowOptions).toHaveLength(count);
  act(() => fixture.props?.onViewportChange?.({ ...actual }));
  expect(fixture.flowOptions).toHaveLength(count);
  const resized = { ...actual, widthCss: 390, heightCss: 654, camera: { ...actual.camera, bearing: -24 }, revision: 'flow-2' };
  act(() => fixture.props?.onViewportChange?.(resized));
  await waitFor(() => expect(prepareViewport).toHaveBeenCalledTimes(3));
  expect(fixture.flowOptions.at(-1)?.viewport).toEqual(resized);
});

it('passes actual camera+bbox to provider and does not repeat a settled snapshot', async () => {
  const prepareViewport = vi.fn(async () => {});
  const provider = makeProvider(prepareViewport);
  render(<DemoCity provider={provider} context={{ ...DEFAULT_CONTEXT, playing: false }} />);
  await waitFor(() => expect(prepareViewport).toHaveBeenCalledTimes(1));
  const actual: RendererViewportSnapshot = { camera: { ...DEFAULT_CONTEXT.camera, bearing: 94, pitch: 60 }, bbox: [61.39, 55.15, 61.43, 55.2], widthCss: 1480, heightCss: 800, revision: 'actual-1' };
  act(() => fixture.props?.onViewportChange?.(actual));
  await waitFor(() => expect(prepareViewport).toHaveBeenCalledTimes(2));
  expect(prepareViewport).toHaveBeenLastCalledWith(expect.objectContaining({ camera: actual.camera }), expect.any(AbortSignal), actual);
  act(() => fixture.props?.onViewportChange?.({ ...actual }));
  expect(prepareViewport).toHaveBeenCalledTimes(2);
  const resized = { ...actual, widthCss: 390, revision: 'actual-2' };
  act(() => fixture.props?.onViewportChange?.(resized));
  await waitFor(() => expect(prepareViewport).toHaveBeenCalledTimes(3));
});

it('reconciles movement every five seconds without per-frame builds or repeated viewport fetches', async () => {
  const prepareViewport = vi.fn(async () => {});
  const provider = makeProvider(prepareViewport);
  const context = { ...DEFAULT_CONTEXT, presentationMinutes: 720, playing: true };
  const view = render(<DemoCity provider={provider} context={context} />);
  await waitFor(() => expect(prepareViewport).toHaveBeenCalledTimes(1));
  const initialBuilds = fixture.frameMinutes.length;
  for (const second of [1, 2, 4.9]) view.rerender(<DemoCity provider={provider} context={{ ...context, presentationMinutes: 720 + second / 60 }} />);
  expect(fixture.frameMinutes).toHaveLength(initialBuilds);
  view.rerender(<DemoCity provider={provider} context={{ ...context, presentationMinutes: 720 + 5 / 60 }} />);
  expect(fixture.frameMinutes).toHaveLength(initialBuilds + 1);
  expect(fixture.frameMinutes.at(-1)).toBe(720 + 5 / 60);
  expect(prepareViewport).toHaveBeenCalledTimes(1);
});
