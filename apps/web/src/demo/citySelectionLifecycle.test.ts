// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SceneRuntime } from '../renderer/runtime/SceneRuntime';
import { TelemetryBus } from '../renderer/runtime/TelemetryBus';
import type { VisualEntity } from '../renderer/types';

vi.mock('maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url', () => ({ default: '/unit-worker.mjs' }));

// Exercise the runtime boundary without a browser or an independent frame loop.
// Selection refreshes originate in worker/membership publication; only the
// InteractionController's publishSelectedEntity entry is a user gesture.
type SelectionState = {
  selectedId: string | null;
  rendererMode: 'universal_lowpoly';
  publishedSelectedView: VisualEntity | null;
  publishedSelectedActivity: VisualEntity['activity'] | null;
  livingEntityViews: { byId: Map<string, VisualEntity> };
  onSelect: ReturnType<typeof vi.fn>;
};
type SelectionMethods = {
  notifySelectedLivingEntity(refreshCurrentView?: boolean): void;
  publishSelectedEntity(entity: VisualEntity | null): void;
};
const entity = (activity: VisualEntity['activity']): VisualEntity => ({
  id: 'demo-p-selected', kind: 'person', representation: 'focus_person_1to1',
  longitude: 61.4, latitude: 55.16, heading: 0, representedCount: 1,
  activity, color: '#ffffff', seed: 1,
});
const dispose: (() => void)[] = [];
afterEach(() => { for (const cleanup of dispose.splice(0)) cleanup(); });
function fixture() {
  const person = entity('home');
  const root = document.createElement('div');
  const telemetry = new TelemetryBus({ root, getAdapters: () => [] });
  const instance = new SceneRuntime({
    root, container: root, telemetry,
    camera: { longitude: 61.4, latitude: 55.16, zoom: 16, pitch: 55, bearing: 0 },
    entities: [], selectedId: person.id, activeLayers: new Set(),
    presentationMinutes: 600, presentationClock: null, reducedMotion: false,
    performanceMode: false, rendererQuality: 'balanced', rendererMode: 'universal_lowpoly',
    weather: 'clear', cityRendererV2: false, mapProvider: 'openfreemap',
    sceneCachePolicy: 'memory', scenePack: null, sceneDetailUnavailableReason: null,
    onSelect: vi.fn(), onSourceState: vi.fn(), onPartsState: vi.fn(), onReadiness: vi.fn(),
    dependencies: { readDeviceCapabilities: () => ({ hardwareConcurrency: 4,
      deviceMemoryGb: 4, devicePixelRatio: 1, mobile: false, webgl2: false }) },
  });
  // Keep map/adapters unattached, but use the real constructor/gesture callback.
  const runtime = Object.assign(instance, {
    livingEntityViews: { byId: new Map([[person.id, person]]) },
  }) as unknown as SelectionState & SelectionMethods;
  dispose.push(() => { instance.dispose(); telemetry.dispose(); });
  return { runtime, person };
}

describe('selected living view publication', () => {
  it('refreshes retained activity and replaced membership without replaying a user pick', () => {
    const { runtime, person } = fixture();
    runtime.notifySelectedLivingEntity(false);
    expect(runtime.publishedSelectedView).toBe(person);
    expect(runtime.publishedSelectedActivity).toBe('home');
    expect(runtime.onSelect).not.toHaveBeenCalled();

    person.activity = 'walk';
    runtime.notifySelectedLivingEntity(false);
    expect(runtime.publishedSelectedActivity).toBe('walk');
    expect(runtime.onSelect).not.toHaveBeenCalled();

    const replacement = entity('work');
    runtime.livingEntityViews.byId.set(person.id, replacement);
    runtime.notifySelectedLivingEntity(false);
    expect(runtime.publishedSelectedView).toBe(replacement);
    expect(runtime.publishedSelectedActivity).toBe('work');
    expect(runtime.onSelect).not.toHaveBeenCalled();
  });

  it('still emits exactly one callback for each actual gesture, including clear', () => {
    const { runtime, person } = fixture();
    runtime.publishSelectedEntity(person);
    expect(runtime.onSelect).toHaveBeenCalledTimes(1);
    expect(runtime.onSelect).toHaveBeenLastCalledWith(person);
    runtime.notifySelectedLivingEntity(false);
    expect(runtime.onSelect).toHaveBeenCalledTimes(1);
    runtime.publishSelectedEntity(person);
    expect(runtime.onSelect).toHaveBeenCalledTimes(2);
    runtime.publishSelectedEntity(null);
    expect(runtime.onSelect).toHaveBeenCalledTimes(3);
    expect(runtime.onSelect).toHaveBeenLastCalledWith(null);
    runtime.selectedId = null;
    runtime.notifySelectedLivingEntity(false);
    expect(runtime.publishedSelectedView).toBeNull();
    expect(runtime.publishedSelectedActivity).toBeNull();
    expect(runtime.onSelect).toHaveBeenCalledTimes(3);
  });
});
