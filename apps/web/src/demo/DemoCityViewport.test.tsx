// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { WorldSceneProps, RendererViewportSnapshot } from '../renderer/types';
import type { StaticDemoProvider } from './data';
import { DEFAULT_CONTEXT } from './navigation';

const fixture = vi.hoisted(() => ({ props: null as WorldSceneProps | null, frameMinutes: [] as number[] }));
vi.mock('../renderer/WorldScene', () => ({ WorldScene: (props: WorldSceneProps) => { fixture.props = props; return null; } }));
vi.mock('./cityPresence', () => ({ CITY_PRESENTATION_EPOCH_SECONDS: 0, cityPresenceAnchorMinutes: (minutes: number) => Math.floor((minutes * 60 + 1e-7) / 5) * 5 / 60,
  buildCityPresenceFrame: (_provider: unknown, context: { presentationMinutes: number }) => { fixture.frameMinutes.push(context.presentationMinutes); return { entities: [], movementEntities: [], movement: null, peopleCount: 0, vehicleCount: 0 }; } }));
vi.mock('./aggregateRoadFlows', () => ({ buildAggregateRoadFlows: () => null }));
import { DemoCity } from './DemoCity';
afterEach(() => { cleanup(); fixture.frameMinutes.length = 0; });

it('passes actual camera+bbox to provider and does not repeat a settled snapshot', async () => {
  const prepareViewport = vi.fn(async () => {});
  const provider = { prepareViewport, getLayout: () => ({ roads: [], buildings: [] }) } as unknown as StaticDemoProvider;
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
  const provider = { prepareViewport, getLayout: () => ({ roads: [], buildings: [] }) } as unknown as StaticDemoProvider;
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
