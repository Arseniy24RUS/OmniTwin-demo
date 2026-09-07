import { afterEach, describe, expect, it, vi } from 'vitest';
import { generatePerformanceEntities } from './lod';
import { createLivingPartition } from './living/partition';
import { createLivingSimulation, interpolateLivingSimulation } from './living/simulation';
import type { RendererAdapter, RendererLivingSnapshot } from './types';
import { LivingActivity, LivingPrimaryRenderer } from './living/types';
import { livingCameraCellCodeForCoordinate } from './living/cameraCells';
import { UNIVERSAL_ACTOR_ATLAS_URL, UNIVERSAL_ACTOR_ICON_MAPPING } from './actorAtlas';
import {
  attachDeckOverlay,
  createDeckLivingBufferPool,
  writeDeckLivingBufferPool,
} from './deckAdapter';
import { generateVegetationInstances, type SourceTreeFeature } from './universal/vegetation';
import { buildAggregateRoadFlows } from '../demo/aggregateRoadFlows';
import type { RendererVegetationSnapshot } from './types';

const deckHarness = vi.hoisted(() => ({
  overlays: [] as Array<{
    props: Record<string, unknown>;
    setPropsCalls: Record<string, unknown>[];
    setProps(next: Record<string, unknown>): void;
    pickObject(params: Record<string, unknown>): unknown;
  }>,
  pickResult: null as unknown,
  pickCalls: [] as Record<string, unknown>[],
  projectCalls: [] as number[][],
}));

vi.mock('@deck.gl/mapbox', () => ({
  MapboxOverlay: class MockMapboxOverlay {
    props: Record<string, unknown>;
    setPropsCalls: Record<string, unknown>[] = [];

    constructor(props: Record<string, unknown>) {
      this.props = props;
      deckHarness.overlays.push(this);
    }

    setProps(next: Record<string, unknown>): void {
      this.setPropsCalls.push(next);
      this.props = { ...this.props, ...next };
    }

    pickObject(params: Record<string, unknown>): unknown {
      deckHarness.pickCalls.push(params);
      return deckHarness.pickResult;
    }

  },
}));

vi.mock('@deck.gl/layers', () => {
  class MockLayer {
    readonly id: string;
    readonly props: Record<string, unknown>;
    readonly attributeManager: {
      attributes: Record<string, { value: ArrayLike<number>; updateSubBuffer: ReturnType<typeof vi.fn> }>;
      setNeedsRedraw: ReturnType<typeof vi.fn>;
    };

    constructor(props: Record<string, unknown>) {
      this.id = String(props.id);
      this.props = props;
      const binary = props.data as {
        attributes?: Record<string, { value: ArrayLike<number> }>;
      } | undefined;
      const source = binary?.attributes ?? {};
      const attributeNames: Record<string, string> = {
        getPreviousPosition: 'instancePreviousPositions',
        getPosition: 'instancePositions',
        getAngle: 'instanceAngles',
      };
      const attributes: MockLayer['attributeManager']['attributes'] = {};
      for (const [sourceName, targetName] of Object.entries(attributeNames)) {
        const value = source[sourceName]?.value;
        if (value) attributes[targetName] = { value, updateSubBuffer: vi.fn() };
      }
      this.attributeManager = { attributes, setNeedsRedraw: vi.fn() };
    }

    getShaders(): { modules: unknown[] } {
      return { modules: [] };
    }

    getAttributeManager() {
      return this.attributeManager;
    }

    project(xyz: number[]): number[] {
      deckHarness.projectCalls.push([...xyz]);
      return [400, 300 - xyz[2]! * 10, 0];
    }

    setNeedsRedraw(): void {}
  }
  return {
    IconLayer: MockLayer,
    PathLayer: MockLayer,
    ScatterplotLayer: MockLayer,
  };
});

afterEach(() => {
  deckHarness.overlays.length = 0;
  deckHarness.pickResult = null;
  deckHarness.pickCalls.length = 0;
  deckHarness.projectCalls.length = 0;
});

function livingFixture(pedestrianCount: number, vehicleCount: number): RendererLivingSnapshot {
  const entities = generatePerformanceEntities({ pedestrianCount, vehicleCount });
  const partition = createLivingPartition(entities, {
    zoom: 16,
    origin: [37.6176, 55.7558],
    screenSizePixels: 1,
  });
  const frame = interpolateLivingSimulation(createLivingSimulation(partition));
  return { partition, frame, telemetry: {} as RendererLivingSnapshot['telemetry'] };
}

function livingFixtureWithFocus(): RendererLivingSnapshot {
  const entities = generatePerformanceEntities({ pedestrianCount: 2, vehicleCount: 1 });
  entities[0] = {
    ...entities[0]!,
    id: `agt_${'a'.repeat(24)}`,
    kind: 'focus',
    representation: 'focus_person_1to1',
    representedCount: 1,
  };
  const partition = createLivingPartition(entities, {
    zoom: 16,
    origin: [37.6176, 55.7558],
    screenSizePixels: 1,
  });
  partition.presentation.primaryRenderer[0] = LivingPrimaryRenderer.DECK;
  partition.presentation.visible[0] = 1;
  const frame = interpolateLivingSimulation(createLivingSimulation(partition));
  return { partition, frame, telemetry: {} as RendererLivingSnapshot['telemetry'] };
}

describe('Deck living columnar buffers', () => {
  it('keeps physical body size independent of focus and selection and writes explicit ground elevation', () => {
    const living = livingFixtureWithFocus();
    const pool = createDeckLivingBufferPool();
    writeDeckLivingBufferPool(living, null, pool);
    expect(pool.radii[0]).toBeCloseTo(1.8);
    expect(pool.radii[1]).toBeCloseTo(1.8);
    const initialSizes = [...pool.radii.subarray(0, pool.length)];
    writeDeckLivingBufferPool(living, pool.submittedIds[2]!, pool);
    expect([...pool.radii.subarray(0, pool.length)]).toEqual(initialSizes);
    expect(pool.positions.length).toBe(pool.capacity * 3);
    expect(pool.previousPositions.length).toBe(pool.capacity * 3);
    for (let index = 0; index < pool.length; index += 1) {
      const expectedZ = index < pool.pedestrianCount ? 0 : 0.1;
      expect(pool.positions[index * 3 + 2]).toBeCloseTo(expectedZ);
      expect(pool.previousPositions[index * 3 + 2]).toBeCloseTo(expectedZ);
    }
  });

  it('bounds ordinary one-to-one people without revoking profile eligibility or native cohort IDs', () => {
    const entities = generatePerformanceEntities({ pedestrianCount: 20, vehicleCount: 0 }).map((entity) => ({
      ...entity, kind: 'person' as const, representation: 'focus_person_1to1' as const,
      representedCount: 1,
    }));
    const partition = createLivingPartition(entities, {
      zoom: 16, origin: [0, 0], screenSizePixels: 1, rendererPolicy: 'deck_only',
    });
    const frame = interpolateLivingSimulation(createLivingSimulation(partition));
    const pool = createDeckLivingBufferPool();
    const selected = entities[19]!.id;
    writeDeckLivingBufferPool({ partition, frame, telemetry: {} as RendererLivingSnapshot['telemetry'] }, selected, pool, 5);
    expect(pool.length).toBe(5);
    expect(pool.focusPedestrianCount).toBe(5);
    expect(pool.submittedIds[0]).toBe(selected);
    expect(pool.budgetCulledCount).toBe(15);
    expect([...pool.radii.subarray(0, 5)].every((size) => Math.abs(size - 1.8) < 1e-6)).toBe(true);
  });

  it('reuses the same typed and ID buffers for 120 frames at the 10k/2k ladder', () => {
    const living = livingFixture(10_000, 2_000);
    const pool = createDeckLivingBufferPool();
    writeDeckLivingBufferPool(living, null, pool);
    const buffers = {
      previousPositions: pool.previousPositions,
      positions: pool.positions,
      radii: pool.radii,
      fillColors: pool.fillColors,
      lineColors: pool.lineColors,
      headings: pool.headings,
      activity: pool.activity,
      iconDefinitions: pool.iconDefinitions,
      focusPedestrianIndices: pool.focusPedestrianIndices,
      criticalPedestrianIndices: pool.criticalPedestrianIndices,
      regularPedestrianIndices: pool.regularPedestrianIndices,
      criticalVehicleIndices: pool.criticalVehicleIndices,
      regularVehicleIndices: pool.regularVehicleIndices,
      sourceIndices: pool.sourceIndices,
      submittedIds: pool.submittedIds,
    };

    for (let frame = 0; frame < 120; frame += 1) {
      expect(writeDeckLivingBufferPool(living, null, pool)).toBe(pool);
    }

    expect(pool).toMatchObject({
      length: 12_000,
      pedestrianCount: 10_000,
      vehicleCount: 2_000,
      allocationCount: 1,
      selectionAllocationCount: 1,
      selectionScans: 1,
      staticColumnUpdates: 1,
      dynamicColumnUpdates: 121,
      capacity: 16_384,
      candidateCapacity: 16_384,
    });
    expect(pool.positions).toBe(buffers.positions);
    expect(pool.previousPositions).toBe(buffers.previousPositions);
    expect(pool.radii).toBe(buffers.radii);
    expect(pool.fillColors).toBe(buffers.fillColors);
    expect(pool.lineColors).toBe(buffers.lineColors);
    expect(pool.headings).toBe(buffers.headings);
    expect(pool.activity).toBe(buffers.activity);
    expect(pool.iconDefinitions).toBe(buffers.iconDefinitions);
    expect(pool.focusPedestrianIndices).toBe(buffers.focusPedestrianIndices);
    expect(pool.criticalPedestrianIndices).toBe(buffers.criticalPedestrianIndices);
    expect(pool.regularPedestrianIndices).toBe(buffers.regularPedestrianIndices);
    expect(pool.criticalVehicleIndices).toBe(buffers.criticalVehicleIndices);
    expect(pool.regularVehicleIndices).toBe(buffers.regularVehicleIndices);
    expect(pool.sourceIndices).toBe(buffers.sourceIndices);
    expect(pool.submittedIds).toBe(buffers.submittedIds);
    expect(pool.submittedIds).toHaveLength(12_000);
    expect(new Set(pool.submittedIds).size).toBe(12_000);
  });

  it('grows geometrically once and then stabilizes at the next capacity', () => {
    const pool = createDeckLivingBufferPool();
    writeDeckLivingBufferPool(livingFixture(8, 1), null, pool);
    const firstPositions = pool.positions;
    expect(pool).toMatchObject({ capacity: 16, allocationCount: 1 });

    writeDeckLivingBufferPool(livingFixture(16, 1), null, pool);
    expect(pool).toMatchObject({ capacity: 32, allocationCount: 2, length: 17 });
    expect(pool.positions).not.toBe(firstPositions);
    const grownPositions = pool.positions;

    writeDeckLivingBufferPool(livingFixture(12, 2), null, pool);
    expect(pool).toMatchObject({ capacity: 32, allocationCount: 2, length: 14 });
    expect(pool.positions).toBe(grownPositions);
  });

  it('copies dynamic frame activity into retained columnar storage', () => {
    const living = livingFixture(3, 1);
    living.frame.activity.fill(LivingActivity.STUDY);
    const pool = createDeckLivingBufferPool();
    writeDeckLivingBufferPool(living, null, pool);
    expect([...pool.activity.subarray(0, pool.length)])
      .toEqual(new Array(pool.length).fill(LivingActivity.STUDY));
    const activityBuffer = pool.activity.buffer;
    living.frame.activity.fill(LivingActivity.TRANSIT);
    writeDeckLivingBufferPool(living, null, pool);
    expect(pool.activity.buffer).toBe(activityBuffer);
    expect([...pool.activity.subarray(0, pool.length)])
      .toEqual(new Array(pool.length).fill(LivingActivity.TRANSIT));
  });

  it('enforces the supplied GPU instance cap without reallocating on later frames', () => {
    const living = livingFixture(10_000, 2_000);
    const pool = createDeckLivingBufferPool();
    writeDeckLivingBufferPool(living, null, pool, 5_000);
    const positions = pool.positions;
    expect(pool).toMatchObject({
      length: 5_000,
      capacity: 8_192,
      allocationCount: 1,
      pedestrianCount: 4_167,
      vehicleCount: 833,
    });
    expect(pool.pedestrianCount + pool.vehicleCount).toBe(5_000);
    writeDeckLivingBufferPool(living, null, pool, 5_000);
    expect(pool.positions).toBe(positions);
    expect(pool.allocationCount).toBe(1);
  });

  it('submits only active camera cells while retaining selection, not all profile-eligible IDs', () => {
    const entities = [
      { ...generatePerformanceEntities({ pedestrianCount: 1, vehicleCount: 0 })[0]!, id: 'inside', longitude: 0, latitude: 0 },
      { ...generatePerformanceEntities({ pedestrianCount: 1, vehicleCount: 0 })[0]!, id: 'outside', longitude: 10, latitude: 0 },
      {
        ...generatePerformanceEntities({ pedestrianCount: 1, vehicleCount: 0 })[0]!,
        id: 'focus',
        kind: 'focus' as const,
        representation: 'focus_person_1to1' as const,
        representedCount: 1,
        longitude: 20,
        latitude: 0,
      },
    ];
    const partition = createLivingPartition(entities, {
      zoom: 18,
      origin: [0, 0],
      screenSizePixels: 1,
    });
    // The deck-only renderer policy is threaded into partition creation by the
    // runtime integration; make the focused fixture reflect that submitted SoA.
    partition.presentation.primaryRenderer[2] = LivingPrimaryRenderer.DECK;
    partition.presentation.visible[2] = 1;
    const frame = interpolateLivingSimulation(createLivingSimulation(partition));
    const activeCode = livingCameraCellCodeForCoordinate(0, 0)!;
    const pool = createDeckLivingBufferPool();
    writeDeckLivingBufferPool(
      { partition, frame, telemetry: {} as RendererLivingSnapshot['telemetry'] },
      'outside',
      pool,
      10,
      new Set([activeCode]),
    );
    expect(pool.submittedIds).toEqual(['inside', 'outside']);
  });
});

describe('Deck retained vegetation composition', () => {
  it('keeps one non-pickable aggregate road pass separate from actor totals and freezes its GPU time while paused', async () => {
    const map = { transform: {}, getStyle: () => ({ layers: [] }), addControl: vi.fn(), removeControl: vi.fn() };
    const adapter = await attachDeckOverlay(map as never, [], null);
    const snapshot = buildAggregateRoadFlows({ origin: [0, 0], roads: [{ id: 'road', coordinates: [[0, 0], [0.001, 0]], oneway: 1, className: 'primary', drivable: true, walkable: false }] });
    adapter.updateAggregateRoadFlows?.(snapshot);
    const overlay = deckHarness.overlays[0]!;
    const layers = overlay.props.layers as Array<{ id: string; props: Record<string, unknown>; elapsedSecondsForTelemetry?: () => number }>;
    const flow = layers.find(({ id }) => id === 'omnitwin-aggregate-road-flow')!;
    expect(flow.props).toMatchObject({ pickable: false, radiusUnits: 'pixels', radiusMaxPixels: 2 });
    expect(adapter.telemetry()).toMatchObject({ pedestrians: 0, vehicles: 0, aggregateRoadFlows: 1 });
    const frame = { nowMs: 0, deltaMs: 16, presentationMinutes: 0, absolutePresentationSeconds: snapshot.timeOriginSeconds + 10, paused: false,
      baseRateSecondsPerWallSecond: 1, speedMultiplier: 1, reducedMotion: false, sceneTimeZone: null, environment: null };
    adapter.frame?.(frame);
    expect(flow.elapsedSecondsForTelemetry?.()).toBe(10);
    const updates = overlay.setPropsCalls.length;
    adapter.frame?.({ ...frame, absolutePresentationSeconds: frame.absolutePresentationSeconds + 1 });
    expect(flow.elapsedSecondsForTelemetry?.()).toBe(11);
    adapter.frame?.({ ...frame, absolutePresentationSeconds: frame.absolutePresentationSeconds + 2, paused: true });
    expect(flow.elapsedSecondsForTelemetry?.()).toBe(11);
    expect(overlay.setPropsCalls.length).toBe(updates);
    adapter.updateAggregateRoadFlows?.(snapshot);
    expect(overlay.setPropsCalls.length).toBe(updates);
    adapter.updateAggregateRoadFlows?.(null);
    expect((overlay.props.layers as typeof layers).some(({ id }) => id === flow.id)).toBe(false);
  });

  it('rejects a native actor hit proven behind a rendered source building without an actor scan', async () => {
    const canvas = { clientWidth: 800, clientHeight: 600, addEventListener: vi.fn(), removeEventListener: vi.fn() };
    const polygon = [[0, 0], [10 / 111_320, 0], [10 / 111_320, 10 / 110_540], [0, 10 / 110_540], [0, 0]];
    const queryRenderedFeatures = vi.fn(() => [{ layer: { id: 'building-3d', type: 'fill-extrusion' }, properties: { height: 5 }, geometry: { type: 'Polygon', coordinates: [polygon] } }]);
    const map = { transform: {}, getStyle: () => ({ layers: [{ id: 'building-3d', type: 'fill-extrusion' }] }),
      getCanvas: () => canvas, getBearing: () => 0, getPitch: () => 55, getZoom: () => 17, queryRenderedFeatures, addControl: vi.fn(), removeControl: vi.fn() };
    const entities = [{ ...generatePerformanceEntities({ pedestrianCount: 1, vehicleCount: 0 })[0]!, kind: 'person' as const,
      representation: 'focus_person_1to1' as const, representedCount: 1, longitude: 5 / 111_320, latitude: 5 / 110_540 }];
    const partition = createLivingPartition(entities, { zoom: 17, origin: [0, 0], screenSizePixels: 1, rendererPolicy: 'deck_only' });
    const frame = interpolateLivingSimulation(createLivingSimulation(partition));
    const adapter = await attachDeckOverlay(map as never, [], null);
    adapter.updateLiving?.({ partition, frame, telemetry: {} as RendererLivingSnapshot['telemetry'] }, null);
    const layers = deckHarness.overlays[0]!.props.layers as Array<{ id: string; project: (point: number[]) => number[] }>;
    const people = layers.find(({ id }) => id === 'omnitwin-living-people')!;
    people.project = ([x, y, z]) => [x!, y!, -z!];
    deckHarness.pickResult = { picked: true, index: 0, layer: people, x: 5, y: 5, pixelRatio: 1 };
    const click = canvas.addEventListener.mock.calls.find(([event]) => event === 'click')![1] as (event: { offsetX: number; offsetY: number }) => void;
    expect(queryRenderedFeatures).not.toHaveBeenCalled();
    click({ offsetX: 5, offsetY: 5 });
    expect(adapter.pickAt?.(5, 5)).toBeNull();
    expect(queryRenderedFeatures).toHaveBeenCalledTimes(1);
    expect(adapter.telemetry().clickPicking?.lastError).toBe('building_occluded');
    queryRenderedFeatures.mockReturnValue([]);
    click({ offsetX: 5, offsetY: 5 });
    expect(adapter.pickAt?.(5, 5)).toBe(entities[0]!.id);
  });

  it('keeps one billboard IconLayer through living and legacy updates', async () => {
    const sourceTree: SourceTreeFeature = {
      kind: 'tree',
      sourceId: 'openmaptiles',
      datasetVersion: '2026-08-01',
      sourceFeatureId: 'spruce-1',
      coordinate: [61.401, 55.161],
      species: 'spruce',
    };
    const instances = generateVegetationInstances([sourceTree], {
      zoom: 17,
      qualityTier: 'mid',
      seed: 'deck-vegetation',
    });
    const iconKey = `tree-conifer-${instances[0]!.spriteVariant}`;
    const snapshot: RendererVegetationSnapshot = {
      instances,
      maximumSizePixels: 48,
      atlasUrl: '/assets/universal-materials/omnitwin-lowpoly-atlas-v1.png',
      iconMapping: {
        [iconKey]: { x: 0, y: 0, width: 32, height: 48, anchorY: 48 },
      },
      beforeId: null,
    };
    const map = {
      transform: {},
      getStyle: () => ({
        layers: [
          { id: 'buildings', type: 'fill-extrusion' },
          { id: 'place-labels', type: 'symbol' },
        ],
      }),
      addControl: vi.fn(),
      removeControl: vi.fn(),
    };
    const adapter = await attachDeckOverlay(map as never, [], null, {
      gpuTransitionDurationMs: 0,
    });

    adapter.updateVegetation?.(snapshot);
    const overlay = deckHarness.overlays[0]!;
    const layersAfterVegetation = overlay.props.layers as Array<{
      id: string;
      props: Record<string, unknown>;
    }>;
    const vegetationLayer = layersAfterVegetation.find(
      (layer) => layer.id === 'omnitwin-universal-vegetation',
    );
    expect(vegetationLayer?.props).toMatchObject({
      alphaCutoff: 0.35,
      beforeId: 'place-labels',
      billboard: true,
      iconAtlas: snapshot.atlasUrl,
      pickable: false,
      sizeMaxPixels: 48,
    });
    expect((vegetationLayer?.props.getIcon as (instance: typeof instances[number]) => string)(
      instances[0]!,
    )).toBe(iconKey);

    adapter.updateLiving?.(livingFixture(3, 1), null);
    const layersAfterLiving = overlay.props.layers as Array<{ id: string }>;
    expect(layersAfterLiving.map((layer) => layer.id)).toContain('omnitwin-living-people');
    expect(layersAfterLiving.map((layer) => layer.id)).toContain('omnitwin-living-vehicles');
    expect(layersAfterLiving.map((layer) => layer.id)).toContain('omnitwin-universal-vegetation');

    adapter.update([], null);
    const layersAfterLegacy = overlay.props.layers as Array<{ id: string }>;
    expect(layersAfterLegacy.map((layer) => layer.id)).toContain('omnitwin-universal-vegetation');

    adapter.clearVegetation?.();
    const layersAfterClear = overlay.props.layers as Array<{ id: string }>;
    expect(layersAfterClear.map((layer) => layer.id)).not.toContain('omnitwin-universal-vegetation');
  });

  it('clamps billboard pixel size to the renderer safety ceiling', async () => {
    const map = {
      transform: {},
      getStyle: () => ({ layers: [{ id: 'labels', type: 'symbol' }] }),
      addControl: vi.fn(),
      removeControl: vi.fn(),
    };
    const adapter = await attachDeckOverlay(map as never, [], null);
    const instances = generateVegetationInstances([{
      kind: 'tree',
      sourceId: 'openmaptiles',
      datasetVersion: '2026-08-01',
      sourceFeatureId: 'tree-size-cap',
      coordinate: [61.401, 55.161],
    }], {
      zoom: 17,
      qualityTier: 'high',
      seed: 'deck-size-cap',
    });
    const iconKey = `tree-decid-${instances[0]!.spriteVariant}`;
    adapter.updateVegetation?.({
      instances,
      maximumSizePixels: 1_000,
      atlasUrl: '/assets/universal-materials/omnitwin-lowpoly-atlas-v1.png',
      iconMapping: {
        [iconKey]: { x: 0, y: 0, width: 32, height: 48, anchorY: 48 },
      },
      beforeId: null,
    });
    const overlay = deckHarness.overlays[0]!;
    const layer = (overlay.props.layers as Array<{ id: string; props: Record<string, unknown> }>)
      .find((candidate) => candidate.id === 'omnitwin-universal-vegetation');
    expect(layer?.props.sizeMaxPixels).toBe(64);
  });

  it('keeps focus people, aggregate people, and vehicles in privacy-safe instanced cohorts', async () => {
    const canvas = {
      clientWidth: 800,
      clientHeight: 600,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    const map = {
      transform: {},
      getStyle: () => ({ layers: [{ id: 'labels', type: 'symbol' }] }),
      getCanvas: () => canvas,
      project: () => ({ x: 400, y: 300 }),
      addControl: vi.fn(),
      removeControl: vi.fn(),
    };
    const adapter = await attachDeckOverlay(map as never, [], null, {
      gpuTransitionDurationMs: 0,
    });
    adapter.updateLiving?.(livingFixtureWithFocus(), null);
    const layers = deckHarness.overlays[0]!.props.layers as Array<{
      id: string;
      props: Record<string, unknown>;
    }>;
    const people = layers.find((layer) => layer.id === 'omnitwin-living-people');
    const aggregatePeople = layers.find(
      (layer) => layer.id === 'omnitwin-living-aggregate-people',
    );
    const vehicles = layers.find((layer) => layer.id === 'omnitwin-living-vehicles');
    expect(people?.props.pickable).toBe(true);
    expect(aggregatePeople?.props.pickable).toBe(false);
    expect(vehicles?.props.pickable).toBe(true);
    expect(people?.props).toMatchObject({
      beforeId: 'labels',
      billboard: false,
      iconAtlas: UNIVERSAL_ACTOR_ATLAS_URL,
      iconMapping: UNIVERSAL_ACTOR_ICON_MAPPING,
      sizeUnits: 'meters',
      sizeScale: 1,
      sizeMinPixels: 0,
      parameters: { depthWriteEnabled: true, depthCompare: 'less-equal' },
    });
    expect(vehicles?.props).toMatchObject({
      beforeId: 'labels',
      billboard: false,
      iconAtlas: UNIVERSAL_ACTOR_ATLAS_URL,
      iconMapping: UNIVERSAL_ACTOR_ICON_MAPPING,
      sizeUnits: 'meters',
      sizeScale: 1,
      sizeMinPixels: 0,
      parameters: { depthWriteEnabled: true, depthCompare: 'less-equal' },
    });
    const shaders = (people as unknown as {
      getShaders: () => { vs: string; fs: string; modules: Array<{ name?: string; vs?: string; inject?: Record<string, string> }> };
    }).getShaders();
    const shaderModules = shaders.modules;
    const interpolationModule = shaderModules.find(
      (module) => module.name === 'omnitwinLivingInterpolation',
    );
    expect(interpolationModule?.vs).toContain(
      'layout(std140) uniform omnitwinLivingInterpolationUniforms',
    );
    expect(shaders.vs).toContain('mix(instancePreviousPositions, instancePositions');
    expect(shaders.vs).toContain('project_size(offsetMeters)');
    expect(shaders.vs).toContain('vec3(omnitwinLivingInterpolation.cameraRight * metres.x, -metres.y)');
    expect(shaders.vs).not.toContain('project_pixel_size');
    expect(shaders.fs).toContain('DECKGL_FILTER_COLOR(fragColor, geometry)');
    expect((people?.props.data as { length: number }).length).toBe(1);
    expect((aggregatePeople?.props.data as { length: number }).length).toBe(1);
    expect((vehicles?.props.data as { length: number }).length).toBe(1);
    expect(adapter.telemetry().pickCandidate).toMatchObject({
      id: `agt_${'a'.repeat(24)}`,
      kind: 'person',
      layerId: 'omnitwin-living-people',
      representation: 'focus_person_1to1',
      profileEligible: true,
      onCanvas: true,
    });
    const peopleAttributes = (people?.props.data as {
      attributes: Record<string, { value: ArrayLike<number>; size: number }>;
    }).attributes;
    const vehicleAttributes = (vehicles?.props.data as {
      attributes: Record<string, { value: ArrayLike<number>; size: number }>;
    }).attributes;
    expect(peopleAttributes.instanceIconDefs?.size).toBe(7);
    expect(peopleAttributes.getPosition?.size).toBe(3);
    expect(peopleAttributes.getPreviousPosition?.size).toBe(3);
    expect(peopleAttributes.getWidth?.value).toHaveLength(1);
    expect(vehicleAttributes.getPosition?.value[2]).toBeCloseTo(0.1);
    expect(deckHarness.projectCalls.some(([x, y, z]) => (
      x === vehicleAttributes.getPosition?.value[0]
      && y === vehicleAttributes.getPosition?.value[1]
      && Math.abs(z! - 0.1) < 1e-6
    ))).toBe(true);
    expect(peopleAttributes.instanceIconDefs?.value).toHaveLength(7);
    expect(peopleAttributes.getAngle).toBeUndefined();
    expect(vehicleAttributes.instanceIconDefs?.value).toHaveLength(7);
    expect(vehicleAttributes.getAngle?.value).toHaveLength(1);

    expect(deckHarness.overlays[0]?.props).toMatchObject({
      _animate: false,
      _pickable: false,
      pickingRadius: 8,
    });
  });

  it('advances a retained worker-frame pair with uniform time and no position resubmission', async () => {
    const map = {
      transform: {},
      getStyle: () => ({ layers: [{ id: 'labels', type: 'symbol' }] }),
      addControl: vi.fn(),
      removeControl: vi.fn(),
    };
    const adapter = await attachDeckOverlay(map as never, [], null, {
      gpuTransitionDurationMs: 0,
    });
    const previous = livingFixtureWithFocus();
    const currentFrame = {
      ...previous.frame,
      x: new Float32Array(previous.frame.x),
      y: new Float32Array(previous.frame.y),
      heading: new Float32Array(previous.frame.heading),
      activity: new Uint8Array(previous.frame.activity),
      simulationTick: previous.frame.simulationTick + 1,
    };
    currentFrame.x[0] += 20;
    const current = {
      partition: previous.partition,
      frame: currentFrame,
      telemetry: previous.telemetry,
      gpuInterpolationPair: {
        previous: previous.frame,
        previousPresentationTimeSeconds: 100,
        current: currentFrame,
        currentPresentationTimeSeconds: 102,
      },
    };

    adapter.updateLiving?.(current, null);
    const overlay = deckHarness.overlays[0]!;
    const layers = overlay.props.layers as Array<{
      id: string;
      props: Record<string, unknown>;
      interpolationAlphaForTelemetry?: () => number;
    }>;
    const focusLayer = layers.find((layer) => layer.id === 'omnitwin-living-people')!;
    const data = focusLayer.props.data as {
      attributes: Record<string, { value: ArrayLike<number>; size: number }>;
    };
    const previousPositionView = data.attributes.getPreviousPosition!.value;
    const currentPositionView = data.attributes.getPosition!.value;
    const setPropsCount = overlay.setPropsCalls.length;
    expect(Array.from(previousPositionView)).not.toEqual(Array.from(currentPositionView));
    expect(focusLayer.interpolationAlphaForTelemetry?.()).toBe(0);

    adapter.frame?.({
      nowMs: 1_000,
      deltaMs: 16,
      presentationMinutes: 0,
      absolutePresentationSeconds: 103,
      paused: false,
      baseRateSecondsPerWallSecond: 1,
      speedMultiplier: 1,
      reducedMotion: false,
      sceneTimeZone: null,
      environment: null,
    });

    expect(focusLayer.interpolationAlphaForTelemetry?.()).toBe(0.5);
    expect(overlay.setPropsCalls).toHaveLength(setPropsCount);
    const layersAfterTick = overlay.props.layers as typeof layers;
    const focusAfterTick = layersAfterTick.find(
      (layer) => layer.id === 'omnitwin-living-people',
    )!;
    const dataAfterTick = focusAfterTick.props.data as typeof data;
    expect(focusAfterTick).toBe(focusLayer);
    expect(dataAfterTick.attributes.getPreviousPosition!.value).toBe(previousPositionView);
    expect(dataAfterTick.attributes.getPosition!.value).toBe(currentPositionView);
    expect((adapter.telemetry() as ReturnType<RendererAdapter['telemetry']> & {
      livingGpuInterpolation?: {
        mode: string;
        positionBufferUpdates: number;
        uniformTimeUpdates: number;
        pairReady: boolean;
        alpha: number;
      };
    }).livingGpuInterpolation).toEqual({
      mode: 'retained_pair_uniform_time',
      positionBufferUpdates: 1,
      uniformTimeUpdates: 1,
      pairReady: true,
      alpha: 0.5,
    });
  });

  it('keeps initialized living layers stable and uploads only dynamic columns on worker ticks', async () => {
    const triggerRepaint = vi.fn();
    const map = {
      transform: {},
      getZoom: () => 16,
      getStyle: () => ({ layers: [{ id: 'labels', type: 'symbol' }] }),
      triggerRepaint,
      addControl: vi.fn(),
      removeControl: vi.fn(),
    };
    const adapter = await attachDeckOverlay(map as never, [], null);
    const previous = livingFixtureWithFocus();
    adapter.updateLiving?.(previous, null);
    const overlay = deckHarness.overlays[0]!;
    const initialLayers = overlay.props.layers as Array<{
      id: string;
      attributeManager: {
        attributes: Record<string, { updateSubBuffer: ReturnType<typeof vi.fn> }>;
      };
    }>;
    const initialSetPropsCount = overlay.setPropsCalls.length;
    const currentFrame = {
      ...previous.frame,
      x: new Float32Array(previous.frame.x),
      y: new Float32Array(previous.frame.y),
      heading: new Float32Array(previous.frame.heading),
      activity: new Uint8Array(previous.frame.activity),
      simulationTick: previous.frame.simulationTick + 1,
    };
    currentFrame.x[0] += 5;
    const current = {
      partition: previous.partition,
      frame: currentFrame,
      telemetry: previous.telemetry,
      gpuInterpolationPair: {
        previous: previous.frame,
        previousPresentationTimeSeconds: 100,
        current: currentFrame,
        currentPresentationTimeSeconds: 102,
      },
    };

    adapter.updateLiving?.(current, null);

    expect(overlay.props.layers).toBe(initialLayers);
    expect(overlay.setPropsCalls).toHaveLength(initialSetPropsCount);
    const focusLayer = initialLayers.find((layer) => layer.id === 'omnitwin-living-people')!;
    expect(focusLayer.attributeManager.attributes.instancePreviousPositions?.updateSubBuffer)
      .toHaveBeenCalledTimes(1);
    expect(focusLayer.attributeManager.attributes.instancePositions?.updateSubBuffer)
      .toHaveBeenCalledTimes(1);
    const halo = initialLayers.find((layer) => layer.id === 'omnitwin-living-selection-halo')!;
    expect(halo.attributeManager.attributes.instancePositions?.updateSubBuffer)
      .toHaveBeenCalledTimes(1);
    expect(triggerRepaint).toHaveBeenCalledTimes(1);
  });

  it('draws a selection-only non-pickable halo with the same retained physical anchor', async () => {
    const map = { transform: {}, getStyle: () => ({ layers: [] }), addControl: vi.fn(), removeControl: vi.fn() };
    const living = livingFixtureWithFocus();
    const selected = living.partition.identity.ids[0]!;
    const adapter = await attachDeckOverlay(map as never, [], selected);
    adapter.updateLiving?.(living, selected);
    const layers = deckHarness.overlays[0]!.props.layers as Array<{ id: string; props: Record<string, unknown> }>;
    const halo = layers.find(({ id }) => id === 'omnitwin-living-selection-halo')!;
    const people = layers.find(({ id }) => id === 'omnitwin-living-people')!;
    expect(halo.props).toMatchObject({ actorMode: 2, pickable: false, sizeUnits: 'meters' });
    const haloData = halo.props.data as { length: number; attributes: Record<string, { value: Float32Array }> };
    const peopleData = people.props.data as typeof haloData;
    expect(haloData.length).toBe(1);
    expect(haloData.attributes.getPosition!.value.buffer).toBe(peopleData.attributes.getPosition!.value.buffer);
    expect(haloData.attributes.getSize!.value[0]).toBeCloseTo(1.8);
    adapter.updateLiving?.(living, null);
    const unselected = deckHarness.overlays[0]!.props.layers as typeof layers;
    expect((unselected.find(({ id }) => id === halo.id)!.props.data as typeof haloData).length).toBe(0);
  });

  it('submits only non-pickable aggregate proxies below z15.5', async () => {
    const map = {
      transform: {},
      getZoom: () => 15.499,
      getStyle: () => ({ layers: [{ id: 'labels', type: 'symbol' }] }),
      addControl: vi.fn(),
      removeControl: vi.fn(),
    };
    const adapter = await attachDeckOverlay(map as never, [], null);
    adapter.updateLiving?.(livingFixtureWithFocus(), null);
    const telemetry = adapter.telemetry();
    const layers = deckHarness.overlays[0]!.props.layers as Array<{
      id: string;
      props: Record<string, unknown>;
    }>;
    const aggregate = layers.find((layer) => layer.id === 'omnitwin-living-aggregate-people')!;
    const focus = layers.find((layer) => layer.id === 'omnitwin-living-people')!;
    const vehicles = layers.find((layer) => layer.id === 'omnitwin-living-vehicles')!;

    expect((aggregate.props.data as { length: number }).length).toBe(1);
    expect((focus.props.data as { length: number }).length).toBe(0);
    expect((vehicles.props.data as { length: number }).length).toBe(0);
    expect(telemetry).toMatchObject({ pedestrians: 1, vehicles: 0 });
    expect(telemetry.pickCandidate).toBeUndefined();
  });

  it('keeps only aggregate flow when the hard-floor governor disables individual actors', async () => {
    const map = {
      transform: {},
      getZoom: () => 17,
      getStyle: () => ({ layers: [{ id: 'labels', type: 'symbol' }] }),
      addControl: vi.fn(),
      removeControl: vi.fn(),
    };
    const adapter = await attachDeckOverlay(map as never, [], null);
    adapter.updateLiving?.({
      ...livingFixtureWithFocus(),
      individualActorsEnabled: false,
    } as RendererLivingSnapshot & { individualActorsEnabled: boolean }, null);
    const layers = deckHarness.overlays[0]!.props.layers as Array<{
      id: string;
      props: Record<string, unknown>;
    }>;

    expect((layers.find((layer) => layer.id === 'omnitwin-living-aggregate-people')!
      .props.data as { length: number }).length).toBe(1);
    expect((layers.find((layer) => layer.id === 'omnitwin-living-people')!
      .props.data as { length: number }).length).toBe(0);
    expect((layers.find((layer) => layer.id === 'omnitwin-living-vehicles')!
      .props.data as { length: number }).length).toBe(0);
    expect(adapter.telemetry().pickCandidate).toBeUndefined();
  });

  it('consumes capture-phase Deck person and vehicle hits once in MapLibre click order', async () => {
    const listeners = new Map<string, EventListener>();
    const canvas = {
      addEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
        if (typeof listener === 'function') listeners.set(type, listener);
      }),
      removeEventListener: vi.fn(),
    };
    const map = {
      transform: {},
      getStyle: () => ({ layers: [{ id: 'labels', type: 'symbol' }] }),
      getCanvas: () => canvas,
      addControl: vi.fn(),
      removeControl: vi.fn(),
    };
    const adapter = await attachDeckOverlay(map as never, [], null, {
      gpuTransitionDurationMs: 0,
    });
    adapter.updateLiving?.(livingFixtureWithFocus(), null);
    const overlay = deckHarness.overlays[0]!;
    const telemetry = adapter.telemetry();
    const personId = telemetry.submittedIds?.[0];
    const vehicleId = telemetry.submittedIds?.[telemetry.pedestrians];

    expect(adapter.pickAt?.(120, 80)).toBeNull();
    deckHarness.pickResult = {
      picked: true,
      index: 0,
      layer: { id: 'omnitwin-living-people' },
      x: 120,
      y: 80,
    };
    listeners.get('pointerdown')?.({ offsetX: 120, offsetY: 80 } as PointerEvent);
    expect(deckHarness.pickCalls).toHaveLength(0);
    listeners.get('click')?.({ offsetX: 120, offsetY: 80 } as MouseEvent);
    expect(overlay.props._pickable).toBe(false);
    expect(overlay.setPropsCalls.slice(-2)).toEqual([
      { _pickable: true },
      { _pickable: false },
    ]);
    expect(deckHarness.pickCalls).toEqual([{
      x: 120,
      y: 80,
      radius: 8,
      layerIds: ['omnitwin-living-people', 'omnitwin-living-vehicles'],
    }]);
    expect(adapter.pickAt?.(120, 80)).toBe(personId);
    expect(adapter.pickAt?.(120, 80)).toBeNull();

    deckHarness.pickResult = {
      picked: true,
      index: 0,
      layer: { id: 'omnitwin-living-vehicles' },
      x: 144,
      y: 96,
    };
    listeners.get('click')?.({ offsetX: 144, offsetY: 96 } as MouseEvent);
    expect(adapter.pickAt?.(144, 96)).toBe(vehicleId);
    expect(overlay.props._pickable).toBe(false);
    expect(deckHarness.pickCalls).toHaveLength(2);

    adapter.dispose();
    expect(canvas.removeEventListener).toHaveBeenCalledTimes(2);
  });

  it('turns a capture-phase Deck miss or mismatched event into a true building-fallback miss', async () => {
    const listeners = new Map<string, EventListener>();
    const canvas = {
      addEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
        if (typeof listener === 'function') listeners.set(type, listener);
      }),
      removeEventListener: vi.fn(),
    };
    const map = {
      transform: {},
      getStyle: () => ({ layers: [{ id: 'labels', type: 'symbol' }] }),
      getCanvas: () => canvas,
      addControl: vi.fn(),
      removeControl: vi.fn(),
    };
    const adapter = await attachDeckOverlay(map as never, [], null, {
      gpuTransitionDurationMs: 0,
    });
    adapter.updateLiving?.(livingFixtureWithFocus(), null);

    deckHarness.pickResult = {
      picked: true,
      index: 0,
      layer: { id: 'omnitwin-living-people' },
      x: 120,
      y: 80,
    };
    listeners.get('click')?.({ offsetX: 120, offsetY: 80 } as MouseEvent);
    deckHarness.pickResult = null;
    listeners.get('click')?.({ offsetX: 120, offsetY: 80 } as MouseEvent);
    expect(adapter.pickAt?.(120, 80)).toBeNull();

    deckHarness.pickResult = {
      picked: true,
      index: 0,
      layer: { id: 'omnitwin-living-vehicles' },
      x: 120,
      y: 80,
    };
    listeners.get('click')?.({ offsetX: 120, offsetY: 80 } as MouseEvent);
    expect(adapter.pickAt?.(140, 80)).toBeNull();
    expect(adapter.pickAt?.(120, 80)).toBeNull();

    deckHarness.pickResult = {
      picked: true,
      index: 0,
      layer: { id: 'unrelated-deck-layer' },
      x: 120,
      y: 80,
    };
    listeners.get('click')?.({ offsetX: 120, offsetY: 80 } as MouseEvent);
    expect(adapter.pickAt?.(120, 80)).toBeNull();
    expect(deckHarness.pickCalls).toHaveLength(4);
  });

  it('reculls a retained paused snapshot only when the guarded camera-cell key changes', async () => {
    let bounds = { west: -0.001, south: -0.001, east: 0.001, north: 0.001 };
    const map = {
      transform: {},
      getStyle: () => ({ layers: [{ id: 'labels', type: 'symbol' }] }),
      getBounds: () => ({
        getWest: () => bounds.west,
        getSouth: () => bounds.south,
        getEast: () => bounds.east,
        getNorth: () => bounds.north,
      }),
      addControl: vi.fn(),
      removeControl: vi.fn(),
    };
    const base = generatePerformanceEntities({ pedestrianCount: 1, vehicleCount: 0 })[0]!;
    const entities = [
      { ...base, id: 'west-view', longitude: 0, latitude: 0 },
      { ...base, id: 'east-view', longitude: 10, latitude: 0 },
    ];
    const partition = createLivingPartition(entities, {
      zoom: 18,
      origin: [0, 0],
      screenSizePixels: 1,
    });
    const frame = interpolateLivingSimulation(createLivingSimulation(partition));
    const snapshot = {
      partition,
      frame,
      telemetry: {} as RendererLivingSnapshot['telemetry'],
    };
    const adapter = await attachDeckOverlay(map as never, [], null, {
      gpuTransitionDurationMs: 0,
    });
    adapter.updateLiving?.(snapshot, null);
    expect(adapter.telemetry().submittedIds).toEqual(['west-view']);
    const firstUpdates = adapter.telemetry().updates;

    adapter.updateCameraWindow?.();
    expect(adapter.telemetry().updates).toBe(firstUpdates);

    bounds = { west: 9.999, south: -0.001, east: 10.001, north: 0.001 };
    // Worker frames may arrive while MapLibre is moving. They update retained
    // positions but must not churn z16 membership before moveend.
    adapter.updateLiving?.(snapshot, null);
    expect(adapter.telemetry().submittedIds).toEqual(['west-view']);
    const beforeMoveendUpdates = adapter.telemetry().updates;

    adapter.updateCameraWindow?.();
    expect(adapter.telemetry().submittedIds).toEqual(['east-view']);
    expect(adapter.telemetry().updates).toBe(beforeMoveendUpdates + 1);
  });
});
