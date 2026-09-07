import type { Map as MapLibreMap } from 'maplibre-gl';
import { COORDINATE_SYSTEM, type Layer, type PickingInfo } from '@deck.gl/core';
import type { IconLayer as DeckIconLayer } from '@deck.gl/layers';
import { livingActorFragmentShader, livingActorUniforms, livingActorVertexShader } from './actorShaders';
import { ACTOR_ALPHA_CUTOFF, actorPhysicalMetrics, actorPlaneQuad, personImpostorMix, VEHICLE_GROUND_CLEARANCE_METERS } from './actorPhysical';
import { actorBuildingOcclusion } from './actorOcclusion';
import { BUILDING_PICK_LAYER_IDS } from './buildingSource';
import { createPresentationMeterBridge } from './presentationMeterBridge';
import { hashSeed } from './rng';
import { aggregateRoadFlowUniforms, type AggregateRoadFlowSnapshot } from './aggregateRoadFlow';
import {
  UNIVERSAL_ACTOR_ATLAS_URL,
  UNIVERSAL_ACTOR_ICON_MAPPING,
  universalActorGaitFrame,
  writeUniversalActorIconDefinition,
} from './actorAtlas';
import { LivingKind, LivingPrimaryRenderer, LivingRepresentation } from './living/types';
import type {
  RendererAdapter,
  RendererLivingSnapshot,
  RendererVegetationSnapshot,
  VisualEntity,
} from './types';
import type { VegetationRenderInstance } from './universal/vegetation';
import {
  livingCameraCellExtentKey,
  livingCameraCellCodeForCoordinate,
  livingDetailModeForZoom,
  selectLivingCameraCells,
  type LivingCameraBounds,
  type LivingCameraCellSelection,
  type LivingDetailMode,
} from './living/cameraCells';

type MapLibreWithInternalCamera = MapLibreMap & {
  transform?: unknown;
  _camera?: { transform: unknown };
};

/** @deck.gl/mapbox reads this extra layer prop when grouping interleaved layers. */
type DeckInterleavedLayerProps = {
  readonly beforeId?: string;
};
type PhysicalActorLayerProps = DeckInterleavedLayerProps & {
  readonly actorMode: 0 | 1 | 2;
};

const LIVING_PEOPLE_LAYER_ID = 'omnitwin-living-people';
const LIVING_AGGREGATE_PEOPLE_LAYER_ID = 'omnitwin-living-aggregate-people';
const LIVING_VEHICLE_LAYER_ID = 'omnitwin-living-vehicles';
const LIVING_SELECTION_HALO_LAYER_ID = 'omnitwin-living-selection-halo';
const LIVING_CLICK_PICK_RADIUS_PIXELS = 8;
const LIVING_CLICK_COORDINATE_TOLERANCE_PIXELS = 12;

interface PendingLivingClickPick {
  readonly x: number;
  readonly y: number;
  readonly logicalId: string | null;
}

interface DeckLivingMotionPair {
  readonly previous: RendererLivingSnapshot['frame'];
  readonly previousPresentationTimeSeconds: number;
  readonly current: RendererLivingSnapshot['frame'];
  readonly currentPresentationTimeSeconds: number;
}

type RendererLivingMotionSnapshot = RendererLivingSnapshot & {
  /** Runtime-owned worker frame pair. It is deliberately not React state. */
  readonly gpuInterpolationPair?: DeckLivingMotionPair | null;
  /** Hard-floor governor seam; false retains only non-pickable aggregates. */
  readonly individualActorsEnabled?: boolean;
};

/** deck.gl 9 reads the legacy transform accessor that MapLibre 6 keeps under its camera. */
function installDeckMapLibreCompatibility(map: MapLibreMap): () => void {
  const compatibleMap = map as MapLibreWithInternalCamera;
  if (compatibleMap.transform) return () => undefined;
  if (!compatibleMap._camera?.transform) {
    throw new Error('MapLibre transform is unavailable for the interleaved deck.gl adapter');
  }
  Object.defineProperty(compatibleMap, 'transform', {
    configurable: true,
    get: () => compatibleMap._camera?.transform,
  });
  return () => {
    try {
      delete compatibleMap.transform;
    } catch {
      // Map removal will dispose the compatibility accessor with the instance.
    }
  };
}

function toColor(hex: string, alpha = 255): [number, number, number, number] {
  const normalized = hex.replace('#', '').padEnd(6, '0');
  return [
    Number.parseInt(normalized.slice(0, 2), 16),
    Number.parseInt(normalized.slice(2, 4), 16),
    Number.parseInt(normalized.slice(4, 6), 16),
    alpha,
  ];
}

function firstSymbolLayerId(map: MapLibreMap): string | null {
  return map.getStyle().layers?.find((layer) => layer.type === 'symbol')?.id ?? null;
}

function vegetationIconKey(instance: VegetationRenderInstance): string {
  const prefix = instance.spriteFamily === 'conifer'
    ? 'tree-conifer'
    : instance.spriteFamily === 'shrub'
      ? 'tree-shrub'
      : 'tree-decid';
  const variantCount = instance.spriteFamily === 'deciduous' ? 8 : 4;
  const variant = ((instance.spriteVariant % variantCount) + variantCount) % variantCount;
  return `${prefix}-${variant}`;
}

function cameraBounds(map: MapLibreMap): LivingCameraBounds | null {
  const getBounds = (map as MapLibreMap & {
    getBounds?: () => {
      getWest(): number;
      getSouth(): number;
      getEast(): number;
      getNorth(): number;
    };
  }).getBounds;
  if (typeof getBounds !== 'function') return null;
  try {
    const bounds = getBounds.call(map);
    return {
      west: bounds.getWest(),
      south: bounds.getSouth(),
      east: bounds.getEast(),
      north: bounds.getNorth(),
    };
  } catch {
    return null;
  }
}

/** Reused columnar storage for the exclusive Deck living partition. */
export interface DeckLivingBufferPool {
  meterBridge: ReturnType<typeof createPresentationMeterBridge> | null;
  capacity: number;
  candidateCapacity: number;
  length: number;
  pedestrianCount: number;
  /** Profile-eligible people occupy the first contiguous pedestrian cohort. */
  focusPedestrianCount: number;
  vehicleCount: number;
  plannedCount: number;
  eligibleCount: number;
  cameraCulledCount: number;
  budgetCulledCount: number;
  /** Number of geometric capacity growth events, not rendered frames. */
  allocationCount: number;
  /** Growth events for retained selection scratch columns. */
  selectionAllocationCount: number;
  /** Full membership scans. Dynamic worker frames do not increase this. */
  selectionScans: number;
  /** Monotonic identity of the submitted instance cohort. */
  selectionRevision: number;
  staticColumnUpdates: number;
  dynamicColumnUpdates: number;
  detailCulledCount: number;
  /** Previous worker positions retained for shader interpolation. */
  previousPositions: Float32Array;
  /** Current worker positions retained as the interpolation target. */
  positions: Float32Array;
  /** Legacy field name; now the atlas quad height in physical metres. */
  radii: Float32Array;
  widths: Float32Array;
  fillColors: Uint8Array;
  lineColors: Uint8Array;
  headings: Float32Array;
  activity: Uint8Array;
  /** Seven floats per instance, consumed directly by IconLayer's shader attributes. */
  iconDefinitions: Float32Array;
  focusPedestrianIndices: Int32Array;
  criticalPedestrianIndices: Int32Array;
  regularPedestrianIndices: Int32Array;
  criticalVehicleIndices: Int32Array;
  regularVehicleIndices: Int32Array;
  /** Partition row for each retained GPU instance. */
  sourceIndices: Int32Array;
  submittedIds: string[];
  selectionPartition: RendererLivingSnapshot['partition'] | null;
  selectionSelectedId: string | null;
  selectionMaximumInstances: number;
  selectionCameraCellCodes: ReadonlySet<number> | null;
  selectionDetailMode: LivingDetailMode;
}

export function createDeckLivingBufferPool(): DeckLivingBufferPool {
  return {
    meterBridge: null,
    capacity: 0,
    candidateCapacity: 0,
    length: 0,
    pedestrianCount: 0,
    focusPedestrianCount: 0,
    vehicleCount: 0,
    plannedCount: 0,
    eligibleCount: 0,
    cameraCulledCount: 0,
    budgetCulledCount: 0,
    allocationCount: 0,
    selectionAllocationCount: 0,
    selectionScans: 0,
    selectionRevision: 0,
    staticColumnUpdates: 0,
    dynamicColumnUpdates: 0,
    detailCulledCount: 0,
    previousPositions: new Float32Array(0),
    positions: new Float32Array(0),
    radii: new Float32Array(0),
    widths: new Float32Array(0),
    fillColors: new Uint8Array(0),
    lineColors: new Uint8Array(0),
    headings: new Float32Array(0),
    activity: new Uint8Array(0),
    iconDefinitions: new Float32Array(0),
    focusPedestrianIndices: new Int32Array(0),
    criticalPedestrianIndices: new Int32Array(0),
    regularPedestrianIndices: new Int32Array(0),
    criticalVehicleIndices: new Int32Array(0),
    regularVehicleIndices: new Int32Array(0),
    sourceIndices: new Int32Array(0),
    submittedIds: [],
    selectionPartition: null,
    selectionSelectedId: null,
    selectionMaximumInstances: Number.NaN,
    selectionCameraCellCodes: null,
    selectionDetailMode: 'individual',
  };
}

function ensureDeckLivingCapacity(pool: DeckLivingBufferPool, required: number): void {
  if (required <= pool.capacity) return;
  let capacity = Math.max(16, pool.capacity);
  while (capacity < required) capacity *= 2;
  pool.capacity = capacity;
  pool.previousPositions = new Float32Array(capacity * 3);
  pool.positions = new Float32Array(capacity * 3);
  pool.radii = new Float32Array(capacity);
  pool.widths = new Float32Array(capacity);
  pool.fillColors = new Uint8Array(capacity * 4);
  pool.lineColors = new Uint8Array(capacity * 4);
  pool.headings = new Float32Array(capacity);
  pool.activity = new Uint8Array(capacity);
  pool.iconDefinitions = new Float32Array(capacity * 7);
  pool.sourceIndices = new Int32Array(capacity);
  pool.allocationCount += 1;
}

function ensureDeckLivingCandidateCapacity(
  pool: DeckLivingBufferPool,
  required: number,
): void {
  if (required <= pool.candidateCapacity) return;
  let capacity = Math.max(16, pool.candidateCapacity);
  while (capacity < required) capacity *= 2;
  pool.candidateCapacity = capacity;
  pool.focusPedestrianIndices = new Int32Array(capacity);
  pool.criticalPedestrianIndices = new Int32Array(capacity);
  pool.regularPedestrianIndices = new Int32Array(capacity);
  pool.criticalVehicleIndices = new Int32Array(capacity);
  pool.regularVehicleIndices = new Int32Array(capacity);
  pool.selectionAllocationCount += 1;
}

/**
 * Mutates one retained buffer set. No typed array, ID array, or per-entity
 * object is allocated when the exclusive Deck cohort stays within capacity.
 */
export function writeDeckLivingBufferPool(
  living: RendererLivingSnapshot,
  selectedId: string | null,
  pool: DeckLivingBufferPool,
  maximumInstances = Number.POSITIVE_INFINITY,
  activeCameraCellCodes?: ReadonlySet<number> | null,
  previousFrame: RendererLivingSnapshot['frame'] = living.frame,
  detailMode: LivingDetailMode = 'individual',
): DeckLivingBufferPool {
  const { partition, frame } = living;
  if (!pool.meterBridge || pool.meterBridge.origin[0] !== partition.originLongitude || pool.meterBridge.origin[1] !== partition.originLatitude) {
    pool.meterBridge = createPresentationMeterBridge([partition.originLongitude, partition.originLatitude]);
  }
  if (previousFrame.x.length !== partition.count || previousFrame.y.length !== partition.count) {
    throw new Error('Deck living previous-position buffers do not match the partition');
  }
  const cap = Math.max(0, Math.floor(maximumInstances));
  const normalizedCameraCellCodes = activeCameraCellCodes ?? null;
  const selectionChanged = (
    pool.selectionPartition !== partition
    || pool.selectionSelectedId !== selectedId
    || pool.selectionMaximumInstances !== cap
    || pool.selectionCameraCellCodes !== normalizedCameraCellCodes
    || pool.selectionDetailMode !== detailMode
  );
  if (selectionChanged) {
    ensureDeckLivingCandidateCapacity(pool, partition.count);
    let focusPedestrians = 0;
    let criticalPedestrians = 0;
    let regularPedestrians = 0;
    let criticalVehicles = 0;
    let regularVehicles = 0;
    let plannedDeck = 0;
    let detailEligibleDeck = 0;
    const longitudeMeters = Math.max(
      1,
      Math.cos((partition.originLatitude * Math.PI) / 180) * 111_320,
    );
    for (let index = 0; index < partition.count; index += 1) {
      if (partition.presentation.primaryRenderer[index] !== LivingPrimaryRenderer.DECK) continue;
      plannedDeck += 1;
      const representation = partition.identity.representation[index];
      if (
        detailMode !== 'individual'
        && representation !== LivingRepresentation.AGGREGATE_PROXY
      ) continue;
      detailEligibleDeck += 1;
      const vehicle = partition.identity.kind[index] === LivingKind.VEHICLE;
      const profileEligible = !vehicle && representation === LivingRepresentation.FOCUS_1_TO_1;
      // One-to-one/profile eligibility is not a focus, camera, or budget waiver.
      const critical = partition.identity.ids[index] === selectedId;
      if (normalizedCameraCellCodes && !critical) {
        const longitude = ((
          partition.originLongitude + frame.x[index]! / longitudeMeters + 540
        ) % 360) - 180;
        const latitude = partition.originLatitude + frame.y[index]! / 110_540;
        const code = livingCameraCellCodeForCoordinate(longitude, latitude);
        if (code === null || !normalizedCameraCellCodes.has(code)) continue;
      }
      if (vehicle) {
        if (critical) pool.criticalVehicleIndices[criticalVehicles++] = index;
        else pool.regularVehicleIndices[regularVehicles++] = index;
      } else if (profileEligible && critical) {
        pool.criticalPedestrianIndices[criticalPedestrians++] = index;
      } else if (profileEligible) {
        pool.focusPedestrianIndices[focusPedestrians++] = index;
      } else {
        pool.regularPedestrianIndices[regularPedestrians++] = index;
      }
    }
    const retainedCriticalPedestrians = criticalPedestrians;
    const eligiblePedestrians = focusPedestrians + criticalPedestrians + regularPedestrians;
    const eligibleVehicles = criticalVehicles + regularVehicles;
    const eligible = eligiblePedestrians + eligibleVehicles;
    const critical = retainedCriticalPedestrians + criticalVehicles;
    const length = Math.min(eligible, Math.max(cap, critical));
    const remaining = Math.max(0, length - critical);
    const nonCriticalPedestrians = eligiblePedestrians - retainedCriticalPedestrians;
    const nonCriticalVehicles = eligibleVehicles - criticalVehicles;
    const nonCritical = nonCriticalPedestrians + nonCriticalVehicles;
    let vehicleExtra = nonCritical === 0
      ? 0
      : Math.min(nonCriticalVehicles, Math.round(remaining * nonCriticalVehicles / nonCritical));
    let pedestrianExtra = Math.min(nonCriticalPedestrians, remaining - vehicleExtra);
    let unassigned = remaining - vehicleExtra - pedestrianExtra;
    const moreVehicles = Math.min(unassigned, nonCriticalVehicles - vehicleExtra);
    vehicleExtra += moreVehicles;
    unassigned -= moreVehicles;
    pedestrianExtra += Math.min(unassigned, nonCriticalPedestrians - pedestrianExtra);
    const vehicleLimit = criticalVehicles + vehicleExtra;
    const pedestrianLimit = retainedCriticalPedestrians + pedestrianExtra;
    ensureDeckLivingCapacity(pool, length);
    let output = 0;
    let pedestrians = 0;
    let vehicles = 0;

    const writeStaticIndex = (index: number, vehicle: boolean): void => {
      const id = partition.identity.ids[index]!;
      pool.sourceIndices[output] = index;
      pool.submittedIds[output] = id;
      const selected = id === selectedId;
      const metrics = actorPhysicalMetrics(vehicle ? 'vehicle' : 'person', hashSeed(id) % 8);
      pool.radii[output] = vehicle ? metrics.atlasQuadHeightMeters : metrics.bodyHeightMeters!;
      pool.widths[output] = metrics.atlasQuadWidthMeters;
      const packed = partition.identity.colorRgba[index]!;
      pool.fillColors[output * 4] = selected ? 255 : (packed >>> 24) & 0xff;
      pool.fillColors[output * 4 + 1] = selected ? 255 : (packed >>> 16) & 0xff;
      pool.fillColors[output * 4 + 2] = selected ? 255 : (packed >>> 8) & 0xff;
      // Full-colour atlas pixels provide the appearance. The binary colour
      // column controls only opacity when `mask:false` and stays retained.
      pool.fillColors[output * 4 + 3] = selected ? 255 : 238;
      pool.lineColors[output * 4] = selected ? 255 : pool.fillColors[output * 4]!;
      pool.lineColors[output * 4 + 1] = selected ? 255 : pool.fillColors[output * 4 + 1]!;
      pool.lineColors[output * 4 + 2] = selected ? 255 : pool.fillColors[output * 4 + 2]!;
      pool.lineColors[output * 4 + 3] = 225;
      writeUniversalActorIconDefinition(
        pool.iconDefinitions,
        output,
        id,
        vehicle ? 'vehicle' : 'person',
        vehicle ? 0 : universalActorGaitFrame(id, 0, 0),
      );
      if (vehicle) vehicles += 1;
      else pedestrians += 1;
      output += 1;
    };

    const writeCandidates = (
      candidates: Int32Array,
      count: number,
      maximum: number,
      vehicle: boolean,
    ): number => {
      const take = Math.min(count, maximum);
      for (let offset = 0; offset < take; offset += 1) {
        writeStaticIndex(candidates[offset]!, vehicle);
      }
      return take;
    };

    // One membership scan is reused until partition, camera cells, selected
    // identity, detail mode or budget changes. Worker position frames never
    // revisit all partition rows.
    const criticalPedestriansWritten = writeCandidates(
      pool.criticalPedestrianIndices,
      criticalPedestrians,
      pedestrianLimit,
      false,
    );
    const ordinaryPedestrianSlots = pedestrianLimit - criticalPedestriansWritten;
    const ordinaryPedestrians = focusPedestrians + regularPedestrians;
    const profileSlots = ordinaryPedestrians === 0 ? 0 : Math.min(
      focusPedestrians,
      Math.round(ordinaryPedestrianSlots * focusPedestrians / ordinaryPedestrians),
    );
    const focusPedestriansWritten = writeCandidates(
      pool.focusPedestrianIndices,
      focusPedestrians,
      profileSlots,
      false,
    );
    writeCandidates(
      pool.regularPedestrianIndices,
      regularPedestrians,
      pedestrianLimit - focusPedestriansWritten - criticalPedestriansWritten,
      false,
    );
    const criticalVehiclesWritten = writeCandidates(
      pool.criticalVehicleIndices,
      criticalVehicles,
      vehicleLimit,
      true,
    );
    writeCandidates(
      pool.regularVehicleIndices,
      regularVehicles,
      vehicleLimit - criticalVehiclesWritten,
      true,
    );
    if (output !== length) {
      throw new Error(`Deck living buffer length mismatch: wrote ${output} of ${length}`);
    }
    pool.submittedIds.length = length;
    pool.length = length;
    pool.pedestrianCount = pedestrians;
    pool.focusPedestrianCount = criticalPedestriansWritten + focusPedestriansWritten;
    pool.vehicleCount = vehicles;
    pool.plannedCount = plannedDeck;
    pool.eligibleCount = eligible;
    pool.detailCulledCount = Math.max(0, plannedDeck - detailEligibleDeck);
    pool.cameraCulledCount = Math.max(0, detailEligibleDeck - eligible);
    pool.budgetCulledCount = Math.max(0, eligible - length);
    pool.selectionPartition = partition;
    pool.selectionSelectedId = selectedId;
    pool.selectionMaximumInstances = cap;
    pool.selectionCameraCellCodes = normalizedCameraCellCodes;
    pool.selectionDetailMode = detailMode;
    pool.selectionScans += 1;
    pool.selectionRevision += 1;
    pool.staticColumnUpdates += 1;
  }

  // GPU positions stay in compact local metre offsets. This avoids deck.gl's
  // per-update Float64 -> fp64 split/copy while preserving sub-metre precision
  // across one settlement partition.
  for (let output = 0; output < pool.length; output += 1) {
    const sourceIndex = pool.sourceIndices[output]!;
    const groundClearance = partition.identity.kind[sourceIndex] === LivingKind.VEHICLE
      ? VEHICLE_GROUND_CLEARANCE_METERS : 0;
    pool.meterBridge.write(pool.positions, output * 3, frame.x[sourceIndex]!, frame.y[sourceIndex]!, groundClearance);
    pool.meterBridge.write(pool.previousPositions, output * 3, previousFrame.x[sourceIndex]!, previousFrame.y[sourceIndex]!, groundClearance);
    pool.headings[output] = frame.heading[sourceIndex]!;
    pool.activity[output] = frame.activity[sourceIndex]!;
  }
  pool.dynamicColumnUpdates += 1;
  return pool;
}

/**
 * Attaches deck.gl as an interleaved analytical/aggregate layer. Imports are
 * deliberately deferred until the online MapLibre surface is usable.
 */
export async function attachDeckOverlay(
  map: MapLibreMap,
  initialEntities: readonly VisualEntity[],
  initialSelectedId: string | null,
  options: {
    maximumInstances?: number;
    gpuTransitionDurationMs?: number;
  } = {},
): Promise<RendererAdapter> {
  const removeCompatibility = installDeckMapLibreCompatibility(map);
  const [{ MapboxOverlay }, { IconLayer, ScatterplotLayer, PathLayer }] = await Promise.all([
    import('@deck.gl/mapbox'),
    import('@deck.gl/layers'),
  ]);

  // Deck's stock attribute transition allocates/cycles GL buffers and has
  // previously failed in this shared MapLibre context. This narrow subclass
  // instead retains two worker snapshots and changes one shader uniform on a
  // MapLibre-owned render. It never owns a requestAnimationFrame loop.
  let livingInterpolationAlpha = 1;
  let aggregateElapsedSeconds = 0;
  let aggregateFrameInitialized = false;
  class AggregateFlowLayer extends ScatterplotLayer<Record<string, never>, DeckInterleavedLayerProps> {
    static override layerName = 'OmnitwinAggregateFlowLayer';
    override getShaders() {
      const shaders = super.getShaders();
      return { ...shaders, modules: [...(shaders.modules ?? []), aggregateRoadFlowUniforms] };
    }
    override initializeState(): void {
      super.initializeState();
      this.getAttributeManager()?.addInstanced({
        instanceFlowEnds: { size: 3, accessor: 'getFlowEnd', defaultValue: [0, 0, 0] },
        instanceFlowTiming: { size: 2, accessor: 'getFlowTiming', defaultValue: [0, 0] },
      });
    }
    override draw(parameters: Parameters<InstanceType<typeof ScatterplotLayer>['draw']>[0]): void {
      this.state.model?.shaderInputs.setProps({ omnitwinAggregateFlow: { elapsedSeconds: aggregateElapsedSeconds } });
      super.draw(parameters);
    }
    elapsedSecondsForTelemetry(): number { return aggregateElapsedSeconds; }
  }
  class InterpolatedLivingIconLayer extends IconLayer<
    Record<string, never>,
    PhysicalActorLayerProps
  > {
    static override layerName = 'InterpolatedLivingIconLayer';

    override getShaders() {
      const shaders = super.getShaders();
      return {
        ...shaders,
        vs: livingActorVertexShader,
        fs: livingActorFragmentShader,
        modules: [...(shaders.modules ?? []), livingActorUniforms],
      };
    }

    override initializeState(): void {
      super.initializeState();
      this.getAttributeManager()?.addInstanced({
        instancePreviousPositions: {
          size: 3,
          type: 'float64',
          fp64: this.use64bitPositions(),
          accessor: 'getPreviousPosition',
        },
        instanceWidths: { size: 1, accessor: 'getWidth', defaultValue: 1 },
      });
    }

    override draw(parameters: Parameters<DeckIconLayer['draw']>[0]): void {
      const bearing = typeof map.getBearing === 'function' ? map.getBearing() * Math.PI / 180 : 0;
      this.state.model?.shaderInputs.setProps({
        omnitwinLivingInterpolation: {
          alpha: livingInterpolationAlpha,
          cameraRight: [Math.cos(bearing), -Math.sin(bearing)],
          actorMode: this.props.actorMode === 1 && typeof map.getPitch === 'function' && map.getPitch() < 15
            ? 3 : this.props.actorMode,
        },
      });
      super.draw(parameters);
    }

    interpolationAlphaForTelemetry(): number {
      return livingInterpolationAlpha;
    }

    /**
     * Uploads only columns changed by a worker frame. The pinned deck.gl 9.3
     * Attribute API writes into the already allocated GPU buffer and avoids a
     * Layer/AttributeManager diff. False asks the adapter to use the safe
     * descriptor-rebuild fallback (normally only before the first draw).
     */
    uploadRetainedDynamicAttributes(includeAngle: boolean): boolean {
      const attributeManager = this.getAttributeManager() as unknown as {
        attributes: Record<string, {
          updateSubBuffer?: (range?: { startOffset?: number; endOffset?: number }) => void;
        } | undefined>;
        setNeedsRedraw?: () => void;
      } | null;
      if (!attributeManager) return false;
      const attributes = [
        attributeManager.attributes.instancePreviousPositions,
        attributeManager.attributes.instancePositions,
        ...(includeAngle ? [attributeManager.attributes.instanceAngles] : []),
      ];
      if (attributes.some((attribute) => typeof attribute?.updateSubBuffer !== 'function')) {
        return false;
      }
      for (const attribute of attributes) attribute!.updateSubBuffer!({ startOffset: 0 });
      attributeManager.setNeedsRedraw?.();
      this.setNeedsRedraw();
      return true;
    }
  }

  const maximumInstances = Math.max(
    0,
    Math.floor(options.maximumInstances ?? Number.POSITIVE_INFINITY),
  );
  let entities = initialEntities.slice(0, maximumInstances);
  let selectedId = initialSelectedId;
  let renderedFrames = 0;
  let updateCount = 0;
  let pedestrianCount = entities.filter((entity) => entity.kind !== 'vehicle').length;
  let vehicleCount = entities.length - pedestrianCount;
  let submittedIds = entities.map((entity) => entity.id);
  const livingBuffers = createDeckLivingBufferPool();
  let activeCells: LivingCameraCellSelection | null = null;
  let activeCellCodes: ReadonlySet<number> | null = null;
  let activeCellExtentKey: string | null = null;
  const detailModeFromMap = (): LivingDetailMode => {
    const getZoom = (map as MapLibreMap & { getZoom?: () => number }).getZoom;
    return typeof getZoom === 'function'
      ? livingDetailModeForZoom(getZoom.call(map))
      : 'individual';
  };
  let activeDetailMode: LivingDetailMode = detailModeFromMap();
  let cameraWindowInitialized = false;
  let activeIndividualActorsEnabled = true;
  let latestLiving: RendererLivingSnapshot | null = null;
  let pendingLivingClickPick: PendingLivingClickPick | null = null;
  let clickPickAttempts = 0;
  let clickPickHits = 0;
  let clickPickMisses = 0;
  let clickPickErrors = 0;
  let clickPickConsumed = 0;
  let lastClickPickStatus: NonNullable<
    ReturnType<RendererAdapter['telemetry']>['clickPicking']
  >['lastStatus'] = 'idle';
  let lastClickPickLogicalId: string | null = null;
  let lastClickPickLayerId: string | null = null;
  let lastClickPickError: string | null = null;
  let lastClickPickX: number | null = null;
  let lastClickPickY: number | null = null;
  let livingPositionBufferUpdates = 0;
  let livingUniformTimeUpdates = 0;
  let livingInterpolationPairReady = false;
  let livingPreviousPresentationTimeSeconds: number | null = null;
  let livingCurrentPresentationTimeSeconds: number | null = null;
  let livingLayerSelectionRevision = -1;

  const logicalIdForLivingPick = (info: Pick<PickingInfo, 'picked' | 'index' | 'layer'>) => {
    if (!info.picked || !Number.isSafeInteger(info.index) || info.index < 0) return null;
    const layerId = info.layer?.id;
    const submittedIndex = layerId === LIVING_PEOPLE_LAYER_ID
      ? info.index
      : layerId === LIVING_VEHICLE_LAYER_ID
        ? livingBuffers.pedestrianCount + info.index
        : -1;
    return submittedIndex >= 0 ? livingBuffers.submittedIds[submittedIndex] ?? null : null;
  };

  const refreshActiveCells = (individualActorsEnabled = true): boolean => {
    const nextDetailMode = individualActorsEnabled ? detailModeFromMap() : 'aggregate';
    const detailModeChanged = nextDetailMode !== activeDetailMode;
    activeDetailMode = nextDetailMode;
    if (activeDetailMode === 'aggregate') {
      const changed = detailModeChanged || activeCells !== null || activeCellExtentKey !== null;
      activeCells = null;
      activeCellCodes = null;
      activeCellExtentKey = null;
      return changed;
    }
    const bounds = cameraBounds(map);
    const extentKey = bounds ? livingCameraCellExtentKey(bounds, 1) : null;
    if (!detailModeChanged && extentKey === activeCellExtentKey) return false;
    activeCellExtentKey = extentKey;
    if (!bounds) {
      const changed = detailModeChanged || activeCells !== null;
      activeCells = null;
      activeCellCodes = null;
      return changed;
    }
    const next = selectLivingCameraCells(bounds, 1);
    if (!detailModeChanged && next.key === activeCells?.key) return false;
    activeCells = next;
    // At world-scale views bounded enumeration intentionally degrades to the
    // existing instance cap instead of allocating an enormous cell set.
    activeCellCodes = next.overflowed ? null : new Set(next.cellCodes);
    return true;
  };

  const buildLayers = () => {
    const aggregateEntities = entities.filter(
      (entity) => entity.representation === 'aggregate_proxy',
    );
    const focusEntities = entities.filter(
      (entity) => entity.id === selectedId && entity.representation === 'focus_person_1to1',
    );
    const movingVehicles = entities.filter((entity) => entity.kind === 'vehicle');

    return [
      new ScatterplotLayer<VisualEntity>({
        id: 'omnitwin-aggregate-proxies',
        data: aggregateEntities,
        pickable: false,
        stroked: true,
        filled: true,
        radiusUnits: 'pixels',
        getPosition: (entity) => [entity.longitude, entity.latitude],
        getRadius: (entity) =>
          entity.id === selectedId
            ? 10
            : Math.min(7, 3 + Math.log10(entity.representedCount + 1) * 1.35),
        getFillColor: (entity) => toColor(entity.color, entity.id === selectedId ? 250 : 178),
        getLineColor: (entity) =>
          entity.id === selectedId ? [255, 255, 255, 255] : toColor(entity.color, 225),
        lineWidthUnits: 'pixels',
        getLineWidth: (entity) => (entity.id === selectedId ? 2.2 : 0.8),
        updateTriggers: {
          getRadius: selectedId,
          getFillColor: selectedId,
          getLineColor: selectedId,
          getLineWidth: selectedId,
        },
      }),
      new ScatterplotLayer<VisualEntity>({
        id: 'omnitwin-focus-person-halo',
        data: focusEntities,
        pickable: false,
        stroked: true,
        filled: false,
        radiusUnits: 'meters',
        getPosition: (entity) => [entity.longitude, entity.latitude, 0.04],
        getRadius: 0.8,
        getLineColor: [53, 215, 223, 230],
        parameters: { depthWriteEnabled: true, depthCompare: 'less-equal' },
        lineWidthUnits: 'pixels',
        getLineWidth: 2,
      }),
      new PathLayer<VisualEntity>({
        id: 'omnitwin-ambient-movement',
        data: movingVehicles,
        pickable: false,
        widthUnits: 'pixels',
        getWidth: 2.2,
        getColor: [255, 182, 77, 190],
        getPath: (entity) => {
          const direction = (entity.heading * Math.PI) / 180;
          const delta = 0.00045;
          return [
            [entity.longitude - Math.sin(direction) * delta, entity.latitude - Math.cos(direction) * delta],
            [entity.longitude, entity.latitude],
          ];
        },
      }),
    ];
  };

  const buildLivingLayers = (
    living: RendererLivingSnapshot,
    allowRetainedDynamicUpload = false,
  ) => {
    const motionSnapshot = living as RendererLivingMotionSnapshot;
    const individualActorsEnabled = motionSnapshot.individualActorsEnabled !== false;
    if (
      !cameraWindowInitialized
      || individualActorsEnabled !== activeIndividualActorsEnabled
    ) {
      refreshActiveCells(individualActorsEnabled);
      cameraWindowInitialized = true;
      activeIndividualActorsEnabled = individualActorsEnabled;
    }
    const motion = motionSnapshot.gpuInterpolationPair;
    const validMotion = Boolean(
      motion
      && motion.previous.x.length === living.partition.count
      && motion.previous.y.length === living.partition.count
      && motion.current === living.frame
      && Number.isFinite(motion.previousPresentationTimeSeconds)
      && Number.isFinite(motion.currentPresentationTimeSeconds)
      && motion.currentPresentationTimeSeconds > motion.previousPresentationTimeSeconds,
    );
    livingInterpolationPairReady = validMotion;
    livingPreviousPresentationTimeSeconds = validMotion
      ? motion!.previousPresentationTimeSeconds
      : null;
    livingCurrentPresentationTimeSeconds = validMotion
      ? motion!.currentPresentationTimeSeconds
      : null;
    livingInterpolationAlpha = validMotion ? 0 : 1;
    const columns = writeDeckLivingBufferPool(
      living,
      selectedId,
      livingBuffers,
      maximumInstances,
      activeCellCodes,
      validMotion ? motion!.previous : living.frame,
      activeDetailMode,
    );
    livingPositionBufferUpdates += 1;
    pedestrianCount = columns.pedestrianCount;
    vehicleCount = columns.vehicleCount;
    submittedIds = columns.submittedIds;
    if (
      allowRetainedDynamicUpload
      && columns.selectionRevision === livingLayerSelectionRevision
    ) {
      let aggregateUpdated = false;
      let vehicleUpdated = false;
      let focusUpdated = false;
      let haloUpdated = false;
      for (const layer of primaryLayers) {
        const retained = layer as InterpolatedLivingIconLayer;
        if (typeof retained.uploadRetainedDynamicAttributes !== 'function') continue;
        if (layer.id === LIVING_AGGREGATE_PEOPLE_LAYER_ID) {
          aggregateUpdated = retained.uploadRetainedDynamicAttributes(false);
        } else if (layer.id === LIVING_VEHICLE_LAYER_ID) {
          vehicleUpdated = retained.uploadRetainedDynamicAttributes(true);
        } else if (layer.id === LIVING_PEOPLE_LAYER_ID) {
          focusUpdated = retained.uploadRetainedDynamicAttributes(false);
        } else if (layer.id === LIVING_SELECTION_HALO_LAYER_ID) {
          haloUpdated = retained.uploadRetainedDynamicAttributes(false);
        }
      }
      if (aggregateUpdated && vehicleUpdated && focusUpdated && haloUpdated) {
        (map as MapLibreMap & { triggerRepaint?: () => void }).triggerRepaint?.();
        return primaryLayers;
      }
    }
    livingLayerSelectionRevision = columns.selectionRevision;
    const beforeId = firstSymbolLayerId(map) ?? undefined;
    const binaryLayer = (
      id: string,
      offset: number,
      length: number,
      kind: 'person' | 'vehicle',
      pickable: boolean,
      halo = false,
    ) => {
      const attributes: Record<string, unknown> = {
        getPreviousPosition: {
          value: columns.previousPositions.subarray(offset * 3, (offset + length) * 3),
          size: 3,
        },
        getPosition: {
          value: columns.positions.subarray(offset * 3, (offset + length) * 3),
          size: 3,
        },
        getSize: { value: columns.radii.subarray(offset, offset + length), size: 1 },
        getWidth: { value: columns.widths.subarray(offset, offset + length), size: 1 },
        getColor: {
          value: columns.fillColors.subarray(offset * 4, (offset + length) * 4),
          size: 4,
        },
        // `instanceIconDefs` bypasses string accessors and icon transforms.
        // Its seven-float shader layout is pinned to the installed IconLayer 9
        // implementation and remains stable for the retained pool.
        instanceIconDefs: {
          value: columns.iconDefinitions.subarray(offset * 7, (offset + length) * 7),
          size: 7,
        },
      };
      if (kind === 'vehicle') {
        attributes.getAngle = {
          value: columns.headings.subarray(offset, offset + length),
          size: 1,
        };
      }
      return new InterpolatedLivingIconLayer({
        id,
        data: { length, attributes } as never,
        beforeId,
        coordinateSystem: COORDINATE_SYSTEM.METER_OFFSETS,
        coordinateOrigin: [
          living.partition.originLongitude,
          living.partition.originLatitude,
          0,
        ],
        iconAtlas: UNIVERSAL_ACTOR_ATLAS_URL,
        iconMapping: UNIVERSAL_ACTOR_ICON_MAPPING,
        // The custom shader supplies world-Z cylindrical people, not IconLayer's
        // screen-facing billboard. Ground vehicles remain actual XY planes.
        billboard: false,
        actorMode: halo ? 2 : kind === 'person' ? 1 : 0,
        pickable,
        alphaCutoff: ACTOR_ALPHA_CUTOFF,
        parameters: { depthWriteEnabled: true, depthCompare: 'less-equal' },
        sizeUnits: 'meters',
        sizeBasis: 'height',
        sizeScale: 1,
        sizeMinPixels: 0,
        sizeMaxPixels: Number.MAX_SAFE_INTEGER,
        getAngle: 0,
        // The custom retained-pair shader is the only motion interpolation
        // path. Stock transitions remain explicitly disabled.
        transitions: undefined,
      });
    };
    const aggregatePedestrianCount = columns.pedestrianCount - columns.focusPedestrianCount;
    const selectedIndex = selectedId === null ? -1 : columns.submittedIds.indexOf(selectedId);
    return [
      binaryLayer(
        LIVING_SELECTION_HALO_LAYER_ID,
        Math.max(0, selectedIndex),
        selectedIndex < 0 ? 0 : 1,
        'person',
        false,
        true,
      ),
      // Aggregate proxies deliberately cannot resolve to a profile. Keeping
      // them in a separate non-pickable cohort makes that privacy rule true in
      // the GPU picking buffer instead of relying on a later UI guard.
      binaryLayer(
        LIVING_AGGREGATE_PEOPLE_LAYER_ID,
        columns.focusPedestrianCount,
        aggregatePedestrianCount,
        'person',
        false,
      ),
      binaryLayer(
        LIVING_VEHICLE_LAYER_ID,
        columns.pedestrianCount,
        columns.vehicleCount,
        'vehicle',
        activeDetailMode === 'individual',
      ),
      // Draw the bounded profile-eligible cohort last among actors. It uses
      // physical vertex depth against MapLibre, not always-on-top priority.
      binaryLayer(
        LIVING_PEOPLE_LAYER_ID,
        0,
        columns.focusPedestrianCount,
        'person',
        activeDetailMode === 'individual',
      ),
    ];
  };

  const buildVegetationLayer = (snapshot: RendererVegetationSnapshot) => {
    const atlasUrl = snapshot.atlasUrl.trim();
    if (!atlasUrl || snapshot.instances.length === 0) return null;
    const maximumSizePixels = Number.isFinite(snapshot.maximumSizePixels)
      ? Math.max(1, Math.min(64, snapshot.maximumSizePixels))
      : 36;
    const mappedInstances = snapshot.instances.filter(
      (instance) => snapshot.iconMapping[vegetationIconKey(instance)] !== undefined,
    );
    if (mappedInstances.length === 0) return null;
    const beforeId = snapshot.beforeId ?? firstSymbolLayerId(map) ?? undefined;
    return new IconLayer<VegetationRenderInstance, DeckInterleavedLayerProps>({
      id: 'omnitwin-universal-vegetation',
      data: mappedInstances,
      beforeId,
      iconAtlas: atlasUrl,
      iconMapping: snapshot.iconMapping,
      billboard: true,
      pickable: false,
      alphaCutoff: 0.35,
      sizeUnits: 'meters',
      sizeMinPixels: 4,
      sizeMaxPixels: maximumSizePixels,
      getPosition: (instance) => instance.coordinate,
      getIcon: vegetationIconKey,
      getSize: (instance) => (
        (instance.geometryQuality === 'exact_tree_point' ? 10 : 11.5) * instance.scale
      ),
      getAngle: 0,
      getColor: [255, 255, 255, 245],
    });
  };

  let primaryLayers: Layer[] = buildLayers();
  let vegetationLayer: Layer | null = null;
  let aggregateFlowLayer: Layer | null = null;
  let aggregateFlowSnapshot: AggregateRoadFlowSnapshot | null = null;
  const composedLayers = () => {
    if (!vegetationLayer && !aggregateFlowLayer) return primaryLayers;
    return [...primaryLayers, ...(aggregateFlowLayer ? [aggregateFlowLayer] : []), ...(vegetationLayer ? [vegetationLayer] : [])];
  };

  const overlay = new MapboxOverlay({
    interleaved: true,
    layers: composedLayers(),
    // The MapLibre-owned scheduler is the sole animation source. Deck must
    // never start a parallel private requestAnimationFrame loop.
    _animate: false,
    // Picking is armed only around the capture-phase native click query below.
    // Deck's own delayed click recognizer therefore performs no second pass,
    // and ordinary pointermove cannot trigger a hover picking pass.
    _pickable: false,
    pickingRadius: LIVING_CLICK_PICK_RADIUS_PIXELS,
    onAfterRender: () => {
      renderedFrames += 1;
    },
  });
  map.addControl(overlay);

  const clickSurface = (map as MapLibreMap & {
    getCanvas?: () => Pick<HTMLCanvasElement, 'addEventListener' | 'removeEventListener'>;
  }).getCanvas?.() ?? null;
  const pickedActorOcclusion = (picked: PickingInfo): 'clear' | 'occluded' | 'unavailable' => {
    if (!latestLiving || typeof map.queryRenderedFeatures !== 'function') return 'clear';
    const available = new Set(map.getStyle().layers?.map(({ id }) => id) ?? []);
    const layers = BUILDING_PICK_LAYER_IDS.filter((id) => available.has(id));
    if (layers.length === 0) return 'clear';
    const layer = picked.layer;
    if (!layer || typeof layer.project !== 'function') return 'unavailable';
    const vehicle = layer.id === LIVING_VEHICLE_LAYER_ID;
    const index = picked.index + (vehicle ? livingBuffers.pedestrianCount : 0);
    if (index < 0 || index >= livingBuffers.length) return 'unavailable';
    const anchor = [0, 1, 2].map((axis) => {
      const offset = index * 3 + axis;
      return livingBuffers.previousPositions[offset]! + (livingBuffers.positions[offset]! - livingBuffers.previousPositions[offset]!) * livingInterpolationAlpha;
    });
    const bearing = map.getBearing() * Math.PI / 180;
    const topView = !vehicle && map.getPitch() < 15;
    const quad = topView ? [[-0.28, -0.35], [0.28, -0.35], [0.28, 0.35], [-0.28, 0.35]].map(([dx, dy]) => [anchor[0]! + dx!, anchor[1]! + dy!, 0.1])
      : actorPlaneQuad({ kind: vehicle ? 'vehicle' : 'person', appearance: hashSeed(livingBuffers.submittedIds[index]!) % 8,
        origin: [anchor[0]!, anchor[1]!, 0], headingDegrees: livingBuffers.headings[index]!, cameraRight: [Math.cos(bearing), -Math.sin(bearing)] });
    const depths = quad.map((point) => layer.project([...point])[2]!);
    depths.push(layer.project([anchor[0]!, anchor[1]!, vehicle || topView ? 0.1 : 0.9])[2]!);
    if (!depths.every(Number.isFinite)) return 'unavailable';
    const pixelRatio = picked.pixelRatio;
    const canvas = map.getCanvas();
    const point: [number, number] = picked.devicePixel && Number.isFinite(pixelRatio) && pixelRatio > 0
      ? [(picked.devicePixel[0] + 0.5) / pixelRatio, canvas.clientHeight - (picked.devicePixel[1] + 0.5) / pixelRatio]
      : [picked.x, picked.y];
    // This one bounded query runs only after a native actor hit. If occluded,
    // the normal semantic building-selection query may follow once.
    const features = map.queryRenderedFeatures(point, { layers });
    return actorBuildingOcclusion({ point, actorNearestDepth: Math.min(...depths), features, zoom: map.getZoom(), project: ([longitude, latitude, z]) => {
      const projected = layer.project(livingBuffers.meterBridge!.fromGeographic(longitude, latitude, z));
      return [projected[0]!, projected[1]!, projected[2]!];
    } });
  };
  const captureLivingClick = (event: MouseEvent) => {
    const x = event.offsetX;
    const y = event.offsetY;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      pendingLivingClickPick = null;
      return;
    }
    clickPickAttempts += 1;
    lastClickPickX = x;
    lastClickPickY = y;
    lastClickPickLogicalId = null;
    lastClickPickLayerId = null;
    lastClickPickError = null;
    overlay.setProps({ _pickable: true });
    let logicalId: string | null = null;
    try {
      const picked = overlay.pickObject({
        x,
        y,
        radius: LIVING_CLICK_PICK_RADIUS_PIXELS,
        layerIds: [LIVING_PEOPLE_LAYER_ID, LIVING_VEHICLE_LAYER_ID],
      });
      if (picked) {
        lastClickPickLayerId = picked.layer?.id ?? null;
        logicalId = logicalIdForLivingPick(picked);
        if (logicalId) {
          const occlusion = pickedActorOcclusion(picked);
          if (occlusion !== 'clear') {
            logicalId = null;
            lastClickPickError = occlusion === 'occluded' ? 'building_occluded' : 'building_occlusion_unavailable';
          }
        }
      }
      lastClickPickLogicalId = logicalId;
      if (logicalId) {
        clickPickHits += 1;
        lastClickPickStatus = 'hit';
      } else {
        clickPickMisses += 1;
        lastClickPickStatus = 'miss';
      }
    } catch (error) {
      // Context loss/style replacement is an explicit actor miss. MapLibre's
      // later semantic click remains free to query a source-backed building.
      clickPickErrors += 1;
      lastClickPickStatus = 'error';
      lastClickPickError = error instanceof Error
        ? error.message.slice(0, 160)
        : 'unknown_pick_error';
    } finally {
      overlay.setProps({ _pickable: false });
    }
    pendingLivingClickPick = { x, y, logicalId };
  };
  const cancelLivingPointerPick = () => {
    pendingLivingClickPick = null;
  };
  // Query Deck only for an actual click. A pointerdown may be the beginning of
  // a MapLibre pan and must not spend a synchronous GPU read or publish a fake
  // miss. Capture order still fills the one-shot result before MapLibre emits
  // its semantic map click.
  clickSurface?.addEventListener('click', captureLivingClick, { capture: true });
  clickSurface?.addEventListener('pointercancel', cancelLivingPointerPick, { capture: true });

  return {
    kind: 'deck',
    updateAggregateRoadFlows(snapshot) {
      if (snapshot?.signature === aggregateFlowSnapshot?.signature && Boolean(snapshot) === Boolean(aggregateFlowSnapshot)) return;
      aggregateFlowSnapshot = snapshot;
      aggregateFrameInitialized = false;
      aggregateElapsedSeconds = 0;
      const segments = snapshot?.segments ?? [];
      if (segments.length > 256) throw new RangeError('Aggregate road flow renderer cap exceeded');
      aggregateFlowLayer = segments.length && snapshot ? new AggregateFlowLayer({
        id: 'omnitwin-aggregate-road-flow',
        beforeId: firstSymbolLayerId(map) ?? undefined,
        data: { length: segments.length, attributes: {
          getPosition: { value: new Float32Array(segments.flatMap(({ start }) => [...start])), size: 3 },
          getFlowEnd: { value: new Float32Array(segments.flatMap(({ end }) => [...end])), size: 3 },
          getFlowTiming: { value: new Float32Array(segments.flatMap(({ phase, speedMps, lengthMeters }) => [phase, speedMps / lengthMeters])), size: 2 },
        } } as never,
        coordinateSystem: COORDINATE_SYSTEM.METER_OFFSETS,
        coordinateOrigin: [snapshot.origin[0], snapshot.origin[1], 0],
        pickable: false,
        billboard: true,
        stroked: false,
        filled: true,
        radiusUnits: 'pixels', getRadius: 1.6, radiusMinPixels: 0, radiusMaxPixels: 2,
        getFillColor: [98, 216, 220, 205],
        parameters: { depthWriteEnabled: false, depthCompare: 'less-equal' },
      }) : null;
      overlay.setProps({ layers: composedLayers() });
    },
    update(nextEntities, nextSelectedId) {
      latestLiving = null;
      entities = nextEntities.slice(0, maximumInstances);
      selectedId = nextSelectedId;
      pedestrianCount = entities.filter((entity) => entity.kind !== 'vehicle').length;
      vehicleCount = entities.length - pedestrianCount;
      submittedIds = entities.map((entity) => entity.id);
      updateCount += 1;
      primaryLayers = buildLayers();
      overlay.setProps({ layers: composedLayers() });
    },
    updateLiving(nextLiving, nextSelectedId) {
      latestLiving = nextLiving;
      selectedId = nextSelectedId;
      updateCount += 1;
      const previousLayers = primaryLayers;
      primaryLayers = buildLivingLayers(nextLiving, true);
      if (primaryLayers !== previousLayers) {
        overlay.setProps({ layers: composedLayers() });
      }
    },
    updateCameraWindow() {
      if (!latestLiving) return;
      const individualActorsEnabled = (
        latestLiving as RendererLivingMotionSnapshot
      ).individualActorsEnabled !== false;
      const changed = refreshActiveCells(individualActorsEnabled);
      cameraWindowInitialized = true;
      activeIndividualActorsEnabled = individualActorsEnabled;
      if (!changed) return;
      updateCount += 1;
      primaryLayers = buildLivingLayers(latestLiving);
      overlay.setProps({ layers: composedLayers() });
    },
    updateVegetation(snapshot) {
      vegetationLayer = buildVegetationLayer(snapshot);
      updateCount += 1;
      overlay.setProps({ layers: composedLayers() });
    },
    clearVegetation() {
      if (!vegetationLayer) return;
      vegetationLayer = null;
      updateCount += 1;
      overlay.setProps({ layers: composedLayers() });
    },
    frame(frame) {
      if (aggregateFlowSnapshot && (!aggregateFrameInitialized || (!frame.paused && !frame.reducedMotion))) {
        aggregateElapsedSeconds = frame.absolutePresentationSeconds - aggregateFlowSnapshot.timeOriginSeconds;
        aggregateFrameInitialized = true;
      }
      if (
        !latestLiving
        || !livingInterpolationPairReady
        || livingPreviousPresentationTimeSeconds === null
        || livingCurrentPresentationTimeSeconds === null
      ) return;
      const duration = livingCurrentPresentationTimeSeconds
        - livingPreviousPresentationTimeSeconds;
      const targetPresentationTimeSeconds = frame.paused || frame.reducedMotion
        ? frame.absolutePresentationSeconds
        : frame.absolutePresentationSeconds - duration;
      const nextAlpha = Math.max(0, Math.min(1, (
        targetPresentationTimeSeconds - livingPreviousPresentationTimeSeconds
      ) / duration));
      if (Math.abs(nextAlpha - livingInterpolationAlpha) <= 1e-6) return;
      livingInterpolationAlpha = nextAlpha;
      livingUniformTimeUpdates += 1;
      // No overlay.setProps(), layer rebuild, typed-array write, or private RAF
      // is needed. The current MapLibre repaint draws with this uniform.
    },
    pickAt(x, y) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      const pending = pendingLivingClickPick;
      // One native Deck result belongs to exactly one MapLibre click. Consume
      // explicit misses too so building selection runs only after this pass.
      pendingLivingClickPick = null;
      if (!pending) return null;
      clickPickConsumed += 1;
      if (Math.hypot(pending.x - x, pending.y - y)
        > LIVING_CLICK_COORDINATE_TOLERANCE_PIXELS) {
        lastClickPickStatus = 'coordinate_mismatch';
        return null;
      }
      return pending.logicalId;
    },
    dispose() {
      clickSurface?.removeEventListener('click', captureLivingClick, { capture: true });
      clickSurface?.removeEventListener('pointercancel', cancelLivingPointerPick, { capture: true });
      try {
        map.removeControl(overlay);
      } catch {
        // The MapLibre map may already have removed all controls.
      }
      removeCompatibility();
    },
    telemetry() {
      const presentationPickCandidates: NonNullable<ReturnType<RendererAdapter['telemetry']>['presentationPickCandidates']>[number][] = [];
      let pickCandidate: NonNullable<ReturnType<RendererAdapter['telemetry']>['pickCandidate']>
        | undefined;
      const getCanvas = (map as MapLibreMap & {
        getCanvas?: () => Pick<HTMLCanvasElement, 'clientWidth' | 'clientHeight'>;
      }).getCanvas;
      if (latestLiving && typeof getCanvas === 'function') {
        const canvas = getCanvas.call(map);
        // Use the rendered layer's public projection in its local-metre frame,
        // including torso/ground elevation. Map.project() has no altitude input;
        // fixed pixel offsets become wrong after camera/physical-size changes.
        const projectActor = (index: number, kind: 'person' | 'vehicle') => {
          const layer = primaryLayers.find(({ id }) => id === (
            kind === 'person' ? LIVING_PEOPLE_LAYER_ID : LIVING_VEHICLE_LAYER_ID
          ));
          if (!layer || typeof layer.project !== 'function') return null;
          const xyz = [0, 1, 2].map((axis) => {
            const offset = index * 3 + axis;
            return livingBuffers.previousPositions[offset]!
              + (livingBuffers.positions[offset]! - livingBuffers.previousPositions[offset]!)
                * livingInterpolationAlpha;
          });
          if (kind === 'person') {
            xyz[2] += typeof map.getPitch === 'function' && map.getPitch() < 15 ? 0.1 : 0.9;
          }
          try {
            const [x, y] = layer.project(xyz);
            if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
            if (kind === 'vehicle') return { x: x!, y: y! };
            const topView = typeof map.getPitch === 'function' && map.getPitch() < 15;
            const bearing = typeof map.getBearing === 'function' ? map.getBearing() * Math.PI / 180 : 0;
            const dx = Math.cos(bearing) * 0.35; const dy = -Math.sin(bearing) * 0.35;
            const low = layer.project(topView ? [xyz[0]! - dx, xyz[1]! - dy, 0.1] : [xyz[0]!, xyz[1]!, 0]);
            const high = layer.project(topView ? [xyz[0]! + dx, xyz[1]! + dy, 0.1] : [xyz[0]!, xyz[1]!, 1.8]);
            const physicalHeightPixels = Math.hypot(high[0]! - low[0]!, high[1]! - low[1]!);
            return { x: x!, y: y!, physicalHeightPixels, impostorMix: personImpostorMix(physicalHeightPixels) };
          } catch {
            // Layer not initialized yet: no invented or stale screen target.
            return null;
          }
        };
        let offCanvasFocusCandidate: typeof pickCandidate;
        for (let index = 0; index < livingBuffers.focusPedestrianCount; index += 1) {
          const point = projectActor(index, 'person');
          if (!point) continue;
          const onCanvas = point.x >= 0 && point.y >= 0
            && point.x <= canvas.clientWidth && point.y <= canvas.clientHeight;
          const candidate: NonNullable<
            ReturnType<RendererAdapter['telemetry']>['pickCandidate']
          > = {
            id: livingBuffers.submittedIds[index]!,
            kind: 'person',
            x: point.x,
            y: point.y,
            layerId: LIVING_PEOPLE_LAYER_ID,
            representation: 'focus_person_1to1',
            profileEligible: true,
            onCanvas,
            physicalHeightPixels: point.physicalHeightPixels,
            impostorMix: point.impostorMix,
          };
          if (onCanvas) {
            pickCandidate = candidate;
            break;
          }
          offCanvasFocusCandidate ??= candidate;
        }
        pickCandidate ??= offCanvasFocusCandidate;
        for (const kind of ['person', 'vehicle'] as const) {
          const candidates: typeof presentationPickCandidates = [];
          const start = kind === 'person' ? 0 : livingBuffers.pedestrianCount;
          const count = kind === 'person' ? livingBuffers.focusPedestrianCount : livingBuffers.vehicleCount;
          for (let index = start; index < start + count; index += 1) {
            const point = projectActor(index, kind);
            if (!point) continue;
            const onCanvas = point.x > 40 && point.y > 40 && point.x < canvas.clientWidth - 40 && point.y < canvas.clientHeight - 80;
            if (!onCanvas) continue;
            candidates.push({ id: livingBuffers.submittedIds[index]!, kind, x: Math.round(point.x * 10) / 10, y: Math.round(point.y * 10) / 10, onCanvas,
              physicalHeightPixels: point.physicalHeightPixels, impostorMix: point.impostorMix });
          }
          const distance = (candidate: typeof candidates[number]) => Math.hypot(candidate.x - canvas.clientWidth * 0.5, candidate.y - canvas.clientHeight * 0.6);
          candidates.sort((left, right) => distance(left) - distance(right));
          presentationPickCandidates.push(...candidates.slice(0, 12));
        }
      }
      return {
        aggregateRoadFlows: aggregateFlowSnapshot?.segments.length ?? 0,
        pedestrians: pedestrianCount,
        vehicles: vehicleCount,
        renderedFrames,
        updates: updateCount,
        rebuilds: 0,
        livingBufferAllocations: livingBuffers.allocationCount,
        // Kept local to this adapter until the public telemetry contract gets
        // a version bump. QA may read it structurally without changing wire
        // compatibility for existing RendererAdapterTelemetry consumers.
        livingGpuInterpolation: latestLiving ? {
          mode: livingInterpolationPairReady ? 'retained_pair_uniform_time' : 'snapshot',
          positionBufferUpdates: livingPositionBufferUpdates,
          uniformTimeUpdates: livingUniformTimeUpdates,
          pairReady: livingInterpolationPairReady,
          alpha: livingInterpolationAlpha,
        } : undefined,
        submittedIds,
        livingSubmission: latestLiving ? {
          planned: livingBuffers.plannedCount,
          eligible: livingBuffers.eligibleCount,
          submitted: livingBuffers.length,
          cameraCulled: livingBuffers.cameraCulledCount,
          budgetCulled: livingBuffers.budgetCulledCount,
          activeCellCount: activeCells?.overflowed ? null : activeCells?.cells.length ?? null,
          activeCellKey: activeCells?.key ?? null,
          cellEnumerationOverflowed: activeCells?.overflowed ?? false,
        } : undefined,
        pickCandidate,
        presentationPickCandidates,
        clickPicking: {
          attempts: clickPickAttempts,
          hits: clickPickHits,
          misses: clickPickMisses,
          errors: clickPickErrors,
          consumed: clickPickConsumed,
          lastStatus: lastClickPickStatus,
          lastLogicalId: lastClickPickLogicalId,
          lastLayerId: lastClickPickLayerId,
          lastError: lastClickPickError,
          lastX: lastClickPickX,
          lastY: lastClickPickY,
        },
      };
    },
  };
}
