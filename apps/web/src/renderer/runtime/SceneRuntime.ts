import type {
  ErrorEvent as MapLibreErrorEvent,
  Map as MapLibreMap,
  MapOptions,
} from 'maplibre-gl';
import {
  SceneCellDescriptorV1Schema,
  SceneManifestV1Schema,
} from '@omnitwin/contracts';
import mapLibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { attachDeckOverlay } from '../deckAdapter';
import {
  UNIVERSAL_BUILDING_ACTIVE_SHADOW_LAYER_IDS,
  UNIVERSAL_BUILDING_SOURCE_ID,
  UNIVERSAL_WATER_GLOSS_LAYER_ID,
  applyUniversalBuildingStyle,
  loadLocalMapStyle,
} from '../mapStyle';
import { MapStyleController } from '../mapStyleController';
import { livingFrameAdvanceDue } from './livingFrameCadence';
import { applyCityTilePack, loadCityTilePack } from '../cityTilePack';
import {
  applyUniversalSourceTileLodProfile,
  universalMapPerformanceOptions,
  type UniversalRenderPhase,
} from '../motionLodPolicy';
import { rendererQualityProfile } from '../qualityProfile';
import {
  BUILDING_PICK_LAYER_IDS,
  BUILDING_HEIGHT_EXPRESSION,
  resolveRendererBuildingSelection,
} from '../buildingSource';
import {
  SceneStreamer,
  sceneCellForCamera,
  sceneCellFromHint,
  type SceneCachePolicy,
  type SceneCell,
  type SceneDeviceTier,
  type SceneStreamResource,
} from '../sceneStreamer';
import {
  createRetainedLivingEntityViews,
  createLivingRenderFrameBuffer,
  interpolateLivingRenderFramePair,
  livingFrameToVisualEntities,
  type LivingRenderFramePair,
  type RetainedLivingEntityViews,
  updateRetainedLivingEntityView,
  updateRetainedLivingEntityViews,
} from '../living/adapters';
import {
  createLivingWorldPipeline,
  type LivingWorldPipeline,
} from '../living/pipeline';
import { type CreateLivingPartitionOptions } from '../living/partition';
import {
  LivingActivity,
  LivingLod,
  type LivingDeviceCaps,
  type LivingRenderFrame,
} from '../living/types';
import {
  LIVING_ROUTE_LOCKED_ACTIVITY_PROFILE,
  resolveLivingActivityAtPresentationSeconds,
  supportedLivingActivityScheduleDescriptor,
} from '../living/activitySchedule';
import { livingActivityQaSnapshot } from '../living/telemetry';
import {
  createLivingPerformanceMovementFixture,
  type LivingSceneMovementEntitySource,
} from '../living/sceneMovement';
import type {
  MapSourceState,
  MapSourceDescriptorV1,
  RendererAdapter,
  RendererPresentationClock,
  RendererQuality,
  RendererMode,
  RendererBuildingSelection,
  RendererMapFeatureSnapshot,
  RendererViewportSnapshot,
  RendererSceneSnapshot,
  SceneImmutableAssetLoader,
  SceneManifestV1,
  VisualEntity,
  VisualEntityV2,
  WorldCamera,
  WorldLayer,
  WorldSceneCityPayload,
  WorldSceneCellResource,
  WorldSceneMovementPayload,
  WorldScenePackBinding,
  WeatherMode,
} from '../types';
import { DEFAULT_RENDERER_MODE } from '../types';
import type { ThreeLayerAdapter } from '../threeAdapter';
import type { ThreeEntityLayerOptions } from '../threeAdapter';
import type { CityDistrictPlan, CityPlanCell } from '../city/types';
import type {
  ScenePmtilesAssetBinding,
  ScenePmtilesProtocolHandle,
} from '../scenePmtilesProtocol';
import { FrameScheduler } from './FrameScheduler';
import {
  InteractionController,
  cameraChanged,
  readMapCamera,
} from './InteractionController';
import { TelemetryBus } from './TelemetryBus';
import type { RendererFrameContext } from './sceneContribution';
import {
  createLivingSimulationController,
  isValidatedLivingWorkerFrameResponse,
  type LivingSimulationController,
} from '../workers/livingSimulationController';
import type { LivingWorkerFrameResponse } from '../workers/livingWorkerProtocol';
import {
  compileRuntimeSceneMovement,
  mergeSceneMovementPayloads,
  type RuntimeMovementTelemetry,
} from './sceneMovementBinding';
import { createSceneAssetLoader } from './sceneAssetCache';
import { dynamicInstanceCap } from '../lod';
import {
  OPENFREE_MAP_BASEMAP_SOURCE,
  OFFICIAL_OVERTURE_DEVELOPMENT_BUILDINGS_SOURCE,
  OPENMAPTILES_BUILDINGS_SOURCE,
  resolveBuildingSourceSelection,
  type BuildingSourceSelection,
} from '../mapProvider';
import {
  registerUniversalPmtilesProtocol,
  type UniversalPmtilesProtocolHandle,
} from '../universalPmtilesProtocol';
import {
  AdaptivePixelBudgetController,
  resolvePixelBudget,
  type PixelBudgetPolicy,
} from './pixelBudget';
import {
  applyLivingVisualBudget,
  type LivingVisualBudgetResult,
} from './livingVisualBudget';
import {
  attachMapGpuFrameTimer,
  type MapGpuFrameTimer,
  type MapGpuFrameTimerSnapshot,
} from './mapGpuFrameTimer';
import {
  RendererPerformanceGovernor,
  type RendererPerformanceGovernorDecision,
} from './performanceGovernor';
import {
  createUniversalAppearanceFrame,
  diffUniversalAppearanceFrames,
  type UniversalAppearanceFrame,
} from '../universal/appearance';
import { mapToEnvironmentCycle2025 } from '../environment/cycle2025';
import { calculateSunLightState } from '../environment/sunLight';
import {
  createVisualWeatherSample,
  deriveWeatherUniforms,
} from '../environment/weather';
import { universalInstanceCaps, universalVegetationProfile } from '../universal/lod';
import type { UniversalQualityTier } from '../universal/types';
import {
  extractSourceVegetationFeatures,
  generateVegetationInstances,
  type QuerySourceVegetationFeatureLike,
} from '../universal/vegetation';
import {
  readLivingCityDeviceCapabilities,
  resolveLivingCityQualityCaps,
  type LivingCityDeviceCapabilities,
} from '../environment/qualityCaps';
import {
  UNIVERSAL_MATERIAL_ATLAS_VERSION,
  UNIVERSAL_MATERIAL_ATLAS_PNG_URL,
  UNIVERSAL_VEGETATION_ICON_MAPPING,
  universalMaterialImageId,
  type UniversalMaterialImageKey,
} from '../materialAtlas';

type MapStyle = Exclude<MapOptions['style'], string | null | undefined>;

type PerformanceQaEpochName = 'general_plan' | 'camera_flight' | 'actor_motion';

interface PerformanceQaEpochSnapshot {
  readonly schema: 'omnitwin.performance-epoch.v1';
  readonly name: PerformanceQaEpochName;
  readonly status: 'collecting' | 'complete';
  readonly startedAtMs: number;
  readonly endedAtMs: number | null;
  readonly durationMs: number;
  readonly frameTimestampsMs: readonly number[];
  readonly frameDeltasMs: readonly number[];
  readonly renderedFrames: number;
  readonly gpu: {
    readonly status: string;
    readonly sampleCount: number;
    readonly frameTimesMs: readonly number[];
  };
  readonly phase: {
    readonly name: string;
    readonly motionProfile: string;
    readonly governorStatus: string;
    readonly dprScale: number;
  };
}

interface PerformanceQaHook {
  startEpoch(name: PerformanceQaEpochName): void;
  stopEpoch(): PerformanceQaEpochSnapshot | null;
  snapshot(): PerformanceQaEpochSnapshot | null;
}

export const UNIVERSAL_BUILDING_INIT_TIMEOUT_MS = 7_000;

async function promiseWithDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  setTimer: SceneRuntimeDependencies['setTimeout'],
  clearTimer: SceneRuntimeDependencies['clearTimeout'],
  timeoutCode: string,
): Promise<T> {
  let timer: number | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimer(() => reject(new Error(timeoutCode)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimer(timer);
  }
}

export interface RendererPartsState {
  maplibre: boolean;
  deck: boolean;
  three: boolean;
  deckFailed: boolean;
  threeFailed: boolean;
  livingWorkerFallback: boolean;
}

export interface SceneRuntimeReadiness {
  manifestVerified: boolean;
  cellsReady: boolean;
  contributionsReady: boolean;
  contributionDetailStatus:
    | 'SCENE_DETAIL_READY'
    | 'SCENE_DETAIL_PARTIAL'
    | 'SCENE_DETAIL_UNAVAILABLE'
    | null;
}

interface ResizeObserverHandle {
  observe: (target: Element) => void;
  disconnect: () => void;
}

interface PendingLivingSeek {
  revision: number;
  presentationTimeSeconds: number;
  reducedMotion: boolean;
}

export interface SceneRuntimeDependencies {
  loadMapLibre: () => Promise<typeof import('maplibre-gl')>;
  loadStyle: (signal: AbortSignal) => Promise<MapStyle>;
  loadManifest: (
    binding: Extract<WorldScenePackBinding, { sourceDetailStatus: 'available' }>,
    signal: AbortSignal,
    cachePolicy: SceneCachePolicy,
    assetLoader: SceneImmutableAssetLoader,
  ) => Promise<SceneManifestV1>;
  attachDeck: typeof attachDeckOverlay;
  createThree: (
    map: MapLibreMap,
    entities: readonly VisualEntity[],
    selectedId: string | null,
    quality: RendererQuality,
    options?: ThreeEntityLayerOptions,
  ) => Promise<ThreeLayerAdapter>;
  createResizeObserver: (callback: ResizeObserverCallback) => ResizeObserverHandle;
  now: () => number;
  setTimeout: (callback: () => void, delayMs: number) => number;
  clearTimeout: (handle: number | undefined) => void;
  createLivingController: typeof createLivingSimulationController;
  registerScenePmtiles: (
    registry: typeof import('maplibre-gl'),
    binding: ScenePmtilesAssetBinding,
  ) => Promise<ScenePmtilesProtocolHandle>;
  registerUniversalPmtiles: typeof registerUniversalPmtilesProtocol;
  readDeviceCapabilities: typeof readLivingCityDeviceCapabilities;
  attachMapGpuFrameTimer: typeof attachMapGpuFrameTimer;
}

export interface SceneRuntimeOptions {
  aggregateRoadFlows?: import('../aggregateRoadFlow').AggregateRoadFlowSnapshot | null;
  presentationMovement?: WorldSceneMovementPayload | null;
  onMapFeatures?: (features: RendererMapFeatureSnapshot) => void;
  root: HTMLElement;
  container: HTMLElement;
  telemetry: TelemetryBus;
  camera: WorldCamera;
  entities: readonly VisualEntity[];
  entitiesV2?: readonly VisualEntityV2[];
  mobilityPresentationMovement?: readonly LivingSceneMovementEntitySource[];
  sceneCellHints?: readonly string[];
  selectedId: string | null;
  activeLayers: ReadonlySet<WorldLayer>;
  presentationMinutes: number;
  presentationClock: RendererPresentationClock | null;
  reducedMotion: boolean;
  performanceMode: boolean;
  rendererQuality: RendererQuality;
  /** Universal MapLibre/deck is the default; Three scene geometry is debug-only. */
  rendererMode?: RendererMode;
  buildingSourceSelection?: BuildingSourceSelection;
  weather: WeatherMode;
  /** Presentation-only override; omitted/null keeps verified scene weather authoritative. */
  weatherVisualOverride?: WeatherMode | null;
  cityRendererV2: boolean;
  mapProvider: 'openfreemap' | 'pmtiles' | 'scene_only';
  sceneCachePolicy: SceneCachePolicy;
  sceneMemoryBudgetBytes?: number;
  sceneDeviceTier?: SceneDeviceTier;
  scenePack: WorldScenePackBinding | null;
  /** Terminal scene-detail reason; MapLibre may still run online without detail. */
  sceneDetailUnavailableReason: string | null;
  onSelect?: (entity: VisualEntity | null) => void;
  onBuildingSelect?: (building: RendererBuildingSelection | null) => void;
  onVerifiedMovementChange?: (movement: WorldSceneMovementPayload | null) => void;
  onCameraChange?: (camera: WorldCamera) => void;
  onViewportChange?: (viewport: RendererViewportSnapshot) => void;
  onSourceState: (state: MapSourceState) => void;
  onPartsState: (state: RendererPartsState) => void;
  onReadiness: (readiness: SceneRuntimeReadiness) => void;
  dependencies?: Partial<SceneRuntimeDependencies>;
}

function sceneBindingIdentity(binding: WorldScenePackBinding | null): string | null {
  if (!binding) return null;
  return [
    binding.sceneId,
    binding.sceneVersion,
    binding.sceneTimeZone,
    binding.sourceDetailStatus === 'available' ? binding.geographyCatalogSha256 : '',
    binding.manifestSha256,
    binding.sourceDetailStatus,
  ].join('\u0000');
}

const EMPTY_PARTS: RendererPartsState = {
  maplibre: false,
  deck: false,
  three: false,
  deckFailed: false,
  threeFailed: false,
  livingWorkerFallback: false,
};

/** Production bundles may use the pinned inspection archive only on loopback. */
export function loopbackUniversalInspectionEnabled(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/^\[|\]$/gu, '');
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

const SHA256 = /^[a-f0-9]{64}$/u;

export function verifySceneManifest(
  binding: Pick<
    Extract<WorldScenePackBinding, { sourceDetailStatus: 'available' }>,
    'sceneId' | 'sceneVersion' | 'sceneTimeZone' | 'geographyCatalogSha256' | 'manifestSha256'
  >,
  value: unknown,
): SceneManifestV1 {
  const raw = value && typeof value === 'object'
    ? value as Record<string, unknown>
    : null;
  if (
    !SHA256.test(binding.manifestSha256) ||
    raw?.sceneId !== binding.sceneId ||
    raw?.sceneVersion !== binding.sceneVersion ||
    raw?.timeZone !== binding.sceneTimeZone ||
    (raw?.coverage as Record<string, unknown> | undefined)?.geographyCatalogSha256 !== binding.geographyCatalogSha256
  ) throw new Error('Scene manifest does not match the selected catalog binding');
  const parsed = SceneManifestV1Schema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 4)
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Scene manifest schema rejected: ${issues}`);
  }
  const manifest = parsed.data;
  return manifest;
}

export function verifySceneCellResource(
  binding: Pick<WorldScenePackBinding, 'sceneId' | 'manifestSha256'>,
  cell: SceneCell,
  resource: WorldSceneCellResource,
): WorldSceneCellResource {
  const parsed = SceneCellDescriptorV1Schema.safeParse(resource.descriptor);
  const descriptor = parsed.success ? parsed.data : null;
  if (
    !descriptor ||
    resource.cell.key !== cell.key ||
    descriptor.sceneId !== binding.sceneId ||
    descriptor.z !== cell.z ||
    descriptor.x !== cell.x ||
    descriptor.y !== cell.y ||
    descriptor.cellId !== `z${cell.z}/${cell.x}/${cell.y}` ||
    descriptor.scientificClaim !== false ||
    resource.sceneManifestSha256 !== binding.manifestSha256 ||
    !SHA256.test(resource.sceneManifestSha256) ||
    !Number.isFinite(resource.estimateBytes) ||
    resource.estimateBytes < 0 ||
    resource.immutableAssets.some((asset) => (
      !asset.url || !/^[a-f0-9]{64}$/u.test(asset.sha256) ||
      !Number.isSafeInteger(asset.bytes) || asset.bytes < 0
    ))
  ) throw new Error(`Scene cell resource rejected: ${cell.key}`);
  return resource;
}

function parseManifestBytes(
  binding: Extract<WorldScenePackBinding, { sourceDetailStatus: 'available' }>,
  bytes: ArrayBuffer,
): SceneManifestV1 {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error('Scene manifest is not valid JSON');
  }
  return verifySceneManifest(binding, value);
}

export async function loadBoundManifest(
  binding: Extract<WorldScenePackBinding, { sourceDetailStatus: 'available' }>,
  signal: AbortSignal,
  _cachePolicy: SceneCachePolicy,
  assetLoader?: SceneImmutableAssetLoader,
): Promise<SceneManifestV1> {
  if (binding.manifest) return verifySceneManifest(binding, binding.manifest);
  if (binding.loadManifest) {
    if (!assetLoader) throw new Error('Runtime immutable scene asset loader is unavailable');
    return verifySceneManifest(binding, await binding.loadManifest(signal, assetLoader));
  }
  if (!binding.manifestUrl) throw new Error('Scene manifest loader is unavailable');
  if (!assetLoader) throw new Error('Runtime immutable scene asset loader is unavailable');
  const asset = await assetLoader.load({
    sceneId: binding.sceneId,
    url: binding.manifestUrl,
    sha256: binding.manifestSha256,
    accept: 'application/json',
  }, signal);
  return parseManifestBytes(binding, asset.bytes);
}

function defaultDependencies(): SceneRuntimeDependencies {
  return {
    loadMapLibre: () => import('maplibre-gl'),
    loadStyle: loadLocalMapStyle,
    loadManifest: loadBoundManifest,
    attachDeck: attachDeckOverlay,
    createThree: async (map, entities, selectedId, quality, options) => {
      const { createThreeEntityLayer } = await import('../threeAdapter');
      return createThreeEntityLayer(map, entities, selectedId, quality, options);
    },
    createResizeObserver: (callback) => new ResizeObserver(callback),
    now: () => performance.now(),
    setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
    clearTimeout: (handle) => window.clearTimeout(handle),
    createLivingController: createLivingSimulationController,
    registerScenePmtiles: async (registry, binding) => {
      const { registerScenePmtilesProtocol } = await import('../scenePmtilesProtocol');
      return registerScenePmtilesProtocol(registry, binding);
    },
    registerUniversalPmtiles: registerUniversalPmtilesProtocol,
    readDeviceCapabilities: readLivingCityDeviceCapabilities,
    attachMapGpuFrameTimer,
  };
}

/** Resolves the universal visual ceiling once; adaptive no longer implies high. */
export function resolveUniversalDecorationTier(
  requestedQuality: RendererQuality,
  explicitDeviceTier: SceneDeviceTier | undefined,
  detectedCapabilities: LivingCityDeviceCapabilities,
): UniversalQualityTier {
  const effective = resolveLivingCityQualityCaps(
    requestedQuality,
    detectedCapabilities,
  ).effectiveQuality;
  const detectedTier: UniversalQualityTier = effective === 'performance'
    ? 'low'
    : effective === 'balanced' ? 'mid' : 'high';
  if (!explicitDeviceTier) return detectedTier;
  const explicitCeiling: UniversalQualityTier = explicitDeviceTier === 'low'
    ? 'low'
    : explicitDeviceTier === 'medium' ? 'mid' : 'high';
  const rank: Readonly<Record<UniversalQualityTier, number>> = { low: 0, mid: 1, high: 2 };
  return rank[detectedTier] <= rank[explicitCeiling] ? detectedTier : explicitCeiling;
}

function rendererQualityForUniversalTier(
  tier: UniversalQualityTier,
): Exclude<RendererQuality, 'adaptive'> {
  if (tier === 'low') return 'performance';
  if (tier === 'mid') return 'balanced';
  return 'cinematic';
}

type UniversalVegetationSourceLayer = 'tree' | 'landcover' | 'park';

export function filterUniversalVegetationSourceRows(
  rows: readonly QuerySourceVegetationFeatureLike[],
  sourceLayer: UniversalVegetationSourceLayer,
): readonly QuerySourceVegetationFeatureLike[] {
  return rows.filter((row) => {
    if (sourceLayer === 'tree') return row.geometry?.type === 'Point';
    if (sourceLayer === 'park') {
      return row.geometry?.type === 'Polygon' || row.geometry?.type === 'MultiPolygon';
    }
    const featureClass = String(
      row.properties?.class ?? row.properties?.natural ?? row.properties?.landuse ?? '',
    ).toLowerCase();
    return ['wood', 'forest'].includes(featureClass)
      && (row.geometry?.type === 'Polygon' || row.geometry?.type === 'MultiPolygon');
  });
}

export function universalVegetationGenerationSeed(
  tier: UniversalQualityTier,
): string {
  return [
    'omnitwin-universal-vegetation-v1',
    OPENFREE_MAP_BASEMAP_SOURCE.datasetVersion,
    tier,
  ].join(':');
}

function cameraTileEpoch(camera: WorldCamera): string {
  const zoom = Math.max(0, Math.min(16, Math.floor(camera.zoom)));
  const scale = 2 ** zoom;
  const x = Math.floor(((camera.longitude + 180) / 360) * scale);
  const latitudeRadians = Math.max(-85.05112878, Math.min(85.05112878, camera.latitude))
    * Math.PI / 180;
  const y = Math.floor((1 - Math.asinh(Math.tan(latitudeRadians)) / Math.PI) / 2 * scale);
  return `${zoom}/${x}/${y}`;
}

export function styleWithScenePmtiles(
  style: MapStyle,
  handle: ScenePmtilesProtocolHandle,
): MapStyle {
  const canonicalSource = style.sources.openmaptiles;
  if (!canonicalSource || canonicalSource.type !== 'vector') {
    throw new Error('Canonical OpenMapTiles vector source is unavailable');
  }
  return {
    ...style,
    metadata: {
      ...(style.metadata ?? {}),
      'omnitwin:mode': 'verified-scene-pmtiles',
    },
    sources: {
      ...style.sources,
      openmaptiles: handle.sourceSpecification,
    },
  } as MapStyle;
}

/** A same-origin street-scale style: no external source, glyph, sprite, or tile URL survives. */
export function sceneOnlyMapStyle(): MapStyle {
  return {
    version: 8,
    name: 'OmniTwin verified scene only',
    metadata: { 'omnitwin:mode': 'verified-scene-only' },
    sources: {},
    layers: [{
      id: 'scene-only-background',
      type: 'background',
      paint: { 'background-color': '#071117' },
    }],
  } as MapStyle;
}

export function isResolvedWorldCamera(camera: WorldCamera | undefined): camera is WorldCamera {
  return Boolean(
    camera &&
    Number.isFinite(camera.longitude) &&
    Number.isFinite(camera.latitude) &&
    Number.isFinite(camera.zoom) &&
    Number.isFinite(camera.pitch) &&
    Number.isFinite(camera.bearing) &&
    camera.longitude >= -180 &&
    camera.longitude <= 180 &&
    camera.latitude >= -85.05112878 &&
    camera.latitude <= 85.05112878 &&
    camera.zoom >= 0
  );
}

export function isValidPresentationClock(
  clock: RendererPresentationClock | null,
): boolean {
  return clock === null || (
    Number.isFinite(clock.absolutePresentationSeconds) &&
    Number.isFinite(clock.baseRateSecondsPerWallSecond) &&
    clock.baseRateSecondsPerWallSecond > 0 &&
    Number.isFinite(clock.speedMultiplier) &&
    clock.speedMultiplier > 0 &&
    (clock.seekRevision === undefined || (
      Number.isSafeInteger(clock.seekRevision) && clock.seekRevision >= 0
    ))
  );
}

export function presentationSecondsAt(
  clock: RendererPresentationClock | null,
  anchorNowMs: number,
  nowMs: number,
  fallbackPresentationSeconds: number,
): number {
  if (!clock) return fallbackPresentationSeconds;
  if (clock.paused) return clock.absolutePresentationSeconds;
  const elapsedWallSeconds = Math.max(0, nowMs - anchorNowMs) / 1_000;
  return clock.absolutePresentationSeconds + elapsedWallSeconds *
    clock.baseRateSecondsPerWallSecond * clock.speedMultiplier;
}

export function presentationAnchorSeconds(
  clock: RendererPresentationClock | null,
  presentationTimeIso: string | null | undefined,
  fallbackPresentationMinutes: number,
): number {
  if (clock) return clock.absolutePresentationSeconds;
  const parsed = presentationTimeIso ? Date.parse(presentationTimeIso) / 1_000 : Number.NaN;
  return Number.isFinite(parsed) ? parsed : fallbackPresentationMinutes * 60;
}

/**
 * Reconciles periodic UI clock anchors with the renderer's continuous clock.
 * Active playback may move forward to a newer authoritative anchor, but timer
 * jitter must never rewind an already-rendered instant. A paused-to-paused
 * anchor change remains an explicit seek and may move in either direction.
 */
export function reanchorPresentationSeconds(
  currentPresentationSeconds: number,
  previousInputClock: RendererPresentationClock | null,
  nextInputClock: RendererPresentationClock | null,
  nextInputPresentationSeconds: number,
): number {
  if (!previousInputClock || !nextInputClock) return nextInputPresentationSeconds;
  if ((previousInputClock.seekRevision ?? 0) !== (nextInputClock.seekRevision ?? 0)) {
    return nextInputPresentationSeconds;
  }
  if (
    previousInputClock.absolutePresentationSeconds ===
    nextInputClock.absolutePresentationSeconds
  ) return currentPresentationSeconds;
  if (!previousInputClock.paused || !nextInputClock.paused) {
    return Math.max(currentPresentationSeconds, nextInputPresentationSeconds);
  }
  return nextInputPresentationSeconds;
}

function presentationMinutesAt(absolutePresentationSeconds: number): number {
  return ((absolutePresentationSeconds / 60) % 1_440 + 1_440) % 1_440;
}

function updateSemanticHash(hash: number, value: string | number): number {
  const source = String(value);
  let next = hash;
  for (let index = 0; index < source.length; index += 1) {
    next ^= source.charCodeAt(index);
    next = Math.imul(next, 16_777_619);
  }
  return next >>> 0;
}

function canonicalPlanItem(
  value: unknown,
  anchor?: CityPlanCell['anchor'],
): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalPlanItem(item, anchor)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  if (
    anchor
    && typeof record.east === 'number'
    && typeof record.north === 'number'
    && Number.isFinite(record.east)
    && Number.isFinite(record.north)
  ) {
    const worldX = anchor.mercatorX + record.east * anchor.meterInMercatorUnits;
    const worldY = anchor.mercatorY - record.north * anchor.meterInMercatorUnits;
    return `{${JSON.stringify('worldX')}:${worldX.toFixed(10)},${
      JSON.stringify('worldY')
    }:${worldY.toFixed(10)}}`;
  }
  return `{${Object.keys(record).sort().map(
    (key) => `${JSON.stringify(key)}:${canonicalPlanItem(record[key], anchor)}`,
  ).join(',')}}`;
}

function retainLowestCellOwner<T extends { readonly id: string }>(
  items: readonly T[],
  owners: Map<string, { readonly cellKey: string; readonly semantic: string }>,
  cellKey: string,
  anchor: CityPlanCell['anchor'],
): { readonly items: readonly T[]; readonly conflicts: number } {
  const retained: T[] = [];
  let conflicts = 0;
  for (const item of items) {
    const semantic = canonicalPlanItem(item, anchor);
    const previous = owners.get(item.id);
    if (previous === undefined) {
      owners.set(item.id, { cellKey, semantic });
      retained.push(item);
    } else if (previous.cellKey === cellKey || previous.semantic !== semantic) conflicts += 1;
  }
  return { items: retained, conflicts };
}

export interface ComposedCityPlanCells {
  readonly planCells: readonly CityPlanCell[];
  readonly conflicts: number;
}

export function gateSceneDetailForMovement(
  detailStatus: SceneRuntimeReadiness['contributionDetailStatus'],
  movementStatus: RuntimeMovementTelemetry['status'],
  movementRequired: boolean,
): SceneRuntimeReadiness['contributionDetailStatus'] {
  if (!movementRequired || movementStatus === 'ready') return detailStatus;
  return detailStatus === 'SCENE_DETAIL_READY' ? 'SCENE_DETAIL_PARTIAL' : detailStatus;
}

/**
 * Assigns every static feature ID to the lexicographically lowest loaded
 * cell. Primary focus never changes ownership, so promoting a prefetched halo
 * does not rebuild unchanged Three geometry.
 */
export function composeCityPlanCells(
  resources: readonly SceneStreamResource<WorldSceneCellResource>[],
): ComposedCityPlanCells {
  const owners = {
    buildings: new Map<string, { cellKey: string; semantic: string }>(),
    roads: new Map<string, { cellKey: string; semantic: string }>(),
    sidewalks: new Map<string, { cellKey: string; semantic: string }>(),
    crosswalks: new Map<string, { cellKey: string; semantic: string }>(),
    props: new Map<string, { cellKey: string; semantic: string }>(),
    routes: new Map<string, { cellKey: string; semantic: string }>(),
    vehicles: new Map<string, { cellKey: string; semantic: string }>(),
  };
  const planCells: CityPlanCell[] = [];
  let conflicts = 0;
  for (const { cell, resource, primary } of resources.toSorted(
    (left, right) => left.cell.key.localeCompare(right.cell.key),
  )) {
    const payload = resource.cityPayload;
    const plan = payload?.plan;
    if (!payload || !plan) continue;
    const buildings = retainLowestCellOwner(plan.buildings, owners.buildings, cell.key, payload.anchor);
    const roads = retainLowestCellOwner(plan.roads, owners.roads, cell.key, payload.anchor);
    const sidewalks = retainLowestCellOwner(plan.sidewalks, owners.sidewalks, cell.key, payload.anchor);
    const crosswalks = retainLowestCellOwner(plan.crosswalks, owners.crosswalks, cell.key, payload.anchor);
    const props = retainLowestCellOwner(plan.props, owners.props, cell.key, payload.anchor);
    const routes = retainLowestCellOwner(plan.routes, owners.routes, cell.key, payload.anchor);
    const vehicles = retainLowestCellOwner(plan.vehicles, owners.vehicles, cell.key, payload.anchor);
    conflicts += buildings.conflicts + roads.conflicts + sidewalks.conflicts
      + crosswalks.conflicts + props.conflicts + routes.conflicts + vehicles.conflicts;
    const deduplicated: CityDistrictPlan = {
      ...plan,
      buildings: buildings.items,
      roads: roads.items,
      sidewalks: sidewalks.items,
      crosswalks: crosswalks.items,
      props: props.items,
      routes: routes.items,
      vehicles: vehicles.items,
    };
    planCells.push({
      cellKey: cell.key,
      primary,
      anchor: payload.anchor,
      plan: deduplicated,
    });
  }
  return { planCells, conflicts };
}

export function livingPartitionSemanticKey(snapshot: RendererSceneSnapshot): string {
  let hash = 2_166_136_261;
  for (const entity of snapshot.entities) {
    for (const value of [
      entity.id, entity.kind, entity.representation, entity.representedCount,
      entity.activity, entity.color, entity.seed,
    ]) hash = updateSemanticHash(hash, value);
  }
  const movement = snapshot.presentationMovement ?? snapshot.scenePack?.cityPayload?.movement;
  const activityRows = runtimeMovementEntitiesV2(snapshot);
  const scheduled = activityRows.some((entity) => 'activityScheduleProfile' in entity);
  if (scheduled) {
    const descriptor = supportedLivingActivityScheduleDescriptor(
      snapshot.scenePack?.sceneTimeZone ?? 'unresolved',
    );
    for (const value of [
      descriptor.classification,
      String(descriptor.scientificClaim),
      descriptor.policy,
      descriptor.timeZone,
      descriptor.derivationVersion,
      descriptor.formula,
    ]) hash = updateSemanticHash(hash, value);
  }
  for (const id of movement?.nodes.map(({ nodeId }) => nodeId) ?? []) {
    hash = updateSemanticHash(hash, id);
  }
  for (const id of movement?.edges.map(({ edgeId }) => edgeId) ?? []) {
    hash = updateSemanticHash(hash, id);
  }
  for (const id of movement?.routes.map(({ routeId }) => routeId) ?? []) {
    hash = updateSemanticHash(hash, id);
  }
  for (const entity of activityRows) {
    for (const value of [
      entity.id,
      entity.entityKind,
      entity.representation,
      entity.representedCount,
      entity.activity,
      'activityScheduleProfile' in entity
        ? ((entity as ScheduledVisualEntityV2).activityScheduleProfile
          ?? LIVING_ROUTE_LOCKED_ACTIVITY_PROFILE)
        : 'no-activity-profile',
      entity.position.cellId,
      entity.position.longitude,
      entity.position.latitude,
      entity.heading,
      entity.motion.mode,
      entity.motion.routeId ?? 'no-route',
      entity.motion.edgeId ?? 'no-edge',
      entity.motion.progress ?? 'no-progress',
      entity.motion.speedMps,
      entity.motion.direction ?? 'no-direction',
      entity.presentationTime,
    ]) hash = updateSemanticHash(hash, value);
  }
  for (const entity of snapshot.mobilityPresentationMovement ?? []) {
    for (const value of [
      entity.id,
      entity.entityKind,
      entity.motion.mode,
      entity.motion.routeId ?? 'no-route',
      entity.motion.edgeId ?? 'no-edge',
      entity.motion.progress ?? 'no-progress',
      entity.motion.speedMps,
      entity.motion.direction ?? 'no-direction',
      entity.presentationTime,
    ]) hash = updateSemanticHash(hash, value);
  }
  // Camera translation changes only the retained z16 submission window. It
  // must not replace the simulation partition or restart its worker. A small
  // zoom bucket still lets screen-space LOD change at deterministic points.
  const zoomBucket = Math.floor(snapshot.camera.zoom * 4) / 4;
  return [
    zoomBucket,
    snapshot.selectedId ?? 'no-selection',
    snapshot.scenePack?.sceneId ?? 'no-scene',
    snapshot.scenePack?.sceneVersion ?? 'no-version',
    snapshot.scenePack?.manifestSha256 ?? 'no-manifest',
    snapshot.scenePack?.cityPayload?.plan?.id ?? 'no-plan',
    snapshot.entities.length,
    hash.toString(16),
  ].join('|');
}

/** Non-empty viewport rows win; empty/missing rows retain verified cell-stream movement. */
export function runtimeMovementEntitiesV2(
  snapshot: Pick<RendererSceneSnapshot, 'entitiesV2' | 'scenePack'>,
): readonly VisualEntityV2[] {
  const viewportRows = snapshot.entitiesV2;
  return viewportRows && viewportRows.length > 0
    ? viewportRows
    : snapshot.scenePack?.cityPayload?.entitiesV2 ?? [];
}

type ScheduledVisualEntityV2 = VisualEntityV2 & {
  readonly activityScheduleProfile: number | null;
};

function livingActivityCodeFromV2(activity: VisualEntityV2['activity']): LivingActivity {
  if (activity === 'work') return LivingActivity.WORK;
  if (activity === 'study') return LivingActivity.STUDY;
  if (activity === 'travel' || activity === 'ambient') return LivingActivity.TRANSIT;
  if (activity === 'leisure') return LivingActivity.LEISURE;
  return LivingActivity.HOME;
}

/**
 * Converts one already contract-validated viewport into the retained SoA seam.
 * The response activity is checked only at its source timestamp; every later
 * frame is derived from the profile and absolute presentation clock.
 */
export function runtimeLivingActivitySchedule(
  snapshot: RendererSceneSnapshot,
): CreateLivingPartitionOptions['activitySchedule'] {
  const sourceRows = runtimeMovementEntitiesV2(snapshot);
  if (sourceRows.length === 0) return undefined;
  const scheduledRows = sourceRows.filter(
    (entity): entity is ScheduledVisualEntityV2 => 'activityScheduleProfile' in entity,
  );
  // Explicit legacy/bootstrap rows predate the v2 schedule contract. Parsed
  // current v2 responses always carry the field on every row.
  if (scheduledRows.length === 0) return undefined;
  if (scheduledRows.length !== sourceRows.length) {
    throw new Error('Living activity schedule is only present on part of the viewport');
  }
  const timeZone = snapshot.scenePack?.sceneTimeZone;
  if (!timeZone) throw new Error('Living activity schedule requires a bound scene time zone');
  const descriptor = supportedLivingActivityScheduleDescriptor(timeZone);
  const mobilityIds = new Set(
    snapshot.mobilityPresentationMovement?.map(({ id }) => id) ?? [],
  );
  const allRenderedIds = new Set(snapshot.entities.map(({ id }) => id));
  const renderedIds = new Set(
    snapshot.entities.filter(({ id }) => !mobilityIds.has(id)).map(({ id }) => id),
  );
  const renderedRows = scheduledRows.filter((entity) => renderedIds.has(entity.id));
  if (renderedRows.length !== renderedIds.size
    || renderedIds.size + mobilityIds.size !== snapshot.entities.length) {
    throw new Error('Living activity schedule rows do not match renderer logical entities');
  }
  const profileByEntityId = new Map<string, number | null>();
  for (const entity of renderedRows) {
    if (profileByEntityId.has(entity.id)) {
      throw new Error(`Living activity schedule has missing or duplicate logical id: ${entity.id}`);
    }
    const profile = entity.activityScheduleProfile;
    const routeLocked = entity.motion.mode === 'network_edge';
    if (routeLocked && profile !== null) {
      throw new Error(`Living routed activity profile must be null: ${entity.id}`);
    }
    if (!routeLocked && entity.entityKind === 'person'
      && (!Number.isSafeInteger(profile) || profile === null || profile < 0 || profile > 11)) {
      throw new Error(`Living stationary person activity profile is invalid: ${entity.id}`);
    }
    if (!routeLocked && entity.entityKind !== 'person') {
      throw new Error(`Living non-person entity is not route-locked: ${entity.id}`);
    }
    const sourcePresentationSeconds = Date.parse(entity.presentationTime) / 1_000;
    if (!Number.isFinite(sourcePresentationSeconds)) {
      throw new Error(`Living activity schedule source time is invalid: ${entity.id}`);
    }
    const expected = resolveLivingActivityAtPresentationSeconds(
      descriptor,
      profile ?? LIVING_ROUTE_LOCKED_ACTIVITY_PROFILE,
      sourcePresentationSeconds,
    );
    if (livingActivityCodeFromV2(entity.activity) !== expected) {
      throw new Error(`Living activity schedule snapshot is inconsistent: ${entity.id}`);
    }
    profileByEntityId.set(entity.id, profile);
  }
  for (const entity of snapshot.mobilityPresentationMovement ?? []) {
    if (!allRenderedIds.has(entity.id)) {
      throw new Error(`Living mobility presentation row is not rendered: ${entity.id}`);
    }
    if (profileByEntityId.has(entity.id)) {
      throw new Error(`Living mobility presentation duplicates a viewport row: ${entity.id}`);
    }
    profileByEntityId.set(entity.id, null);
  }
  return { descriptor, profileByEntityId };
}

/**
 * Treats Worker messages as untrusted structured-clone input. The main thread
 * validates the complete render column boundary before any adapter can consume
 * it, so malformed data fails the renderer closed instead of producing NaNs.
 */
export function assertLivingWorkerFrameResponse(
  response: unknown,
  expectedCount: number,
): asserts response is LivingWorkerFrameResponse {
  if (!Number.isSafeInteger(expectedCount) || expectedCount < 0) {
    throw new Error('living_worker_expected_count_invalid');
  }
  if (!response || typeof response !== 'object') {
    throw new Error('living_worker_response_invalid');
  }
  const candidate = response as Record<string, unknown>;
  if (candidate.type !== 'living-frame') {
    throw new Error('living_worker_response_type_invalid');
  }
  if (
    candidate.operation !== 'initialize'
    && candidate.operation !== 'advance'
    && candidate.operation !== 'seek'
  ) {
    throw new Error('living_worker_response_operation_invalid');
  }
  const frame = candidate.frame;
  if (!frame || typeof frame !== 'object') {
    throw new Error('living_worker_frame_invalid');
  }
  const frameRecord = frame as Record<string, unknown>;
  for (const columnName of ['x', 'y', 'heading'] as const) {
    const column = frameRecord[columnName];
    if (!(column instanceof Float32Array)) {
      throw new Error(`living_worker_frame_${columnName}_type_invalid`);
    }
    if (column.length !== expectedCount) {
      throw new Error(`living_worker_frame_${columnName}_length_invalid`);
    }
    for (let index = 0; index < column.length; index += 1) {
      if (!Number.isFinite(column[index])) {
        throw new Error(`living_worker_frame_${columnName}_non_finite`);
      }
    }
  }
  const activity = frameRecord.activity;
  if (!(activity instanceof Uint8Array)) {
    throw new Error('living_worker_frame_activity_type_invalid');
  }
  if (activity.length !== expectedCount) {
    throw new Error('living_worker_frame_activity_length_invalid');
  }
  for (let index = 0; index < activity.length; index += 1) {
    if (activity[index]! > LivingActivity.STUDY) {
      throw new Error('living_worker_frame_activity_value_invalid');
    }
  }
  if (
    !Number.isFinite(frameRecord.alpha)
    || Number(frameRecord.alpha) < 0
    || Number(frameRecord.alpha) > 1
    || !Number.isSafeInteger(frameRecord.simulationTick)
    || Number(frameRecord.simulationTick) < 0
  ) {
    throw new Error('living_worker_frame_metadata_invalid');
  }
  const telemetry = candidate.telemetry;
  if (
    !telemetry
    || typeof telemetry !== 'object'
    || !Number.isFinite((telemetry as Record<string, unknown>).presentationTimeSeconds)
  ) {
    throw new Error('living_worker_telemetry_invalid');
  }
}

/**
 * A bounded readiness sentinel. It samples across the full collection and
 * never projects every entity in a hot renderer update.
 */
export function projectedEntitySentinel(
  map: Pick<MapLibreMap, 'getCanvas' | 'project'>,
  entities: readonly VisualEntity[],
  maximumChecks = 256,
): 0 | 1 {
  if (entities.length === 0 || maximumChecks <= 0) return 0;
  const canvas = map.getCanvas();
  const checks = Math.min(entities.length, Math.max(1, Math.floor(maximumChecks)));
  for (let check = 0; check < checks; check += 1) {
    const index = Math.min(
      entities.length - 1,
      Math.floor((check * entities.length) / checks),
    );
    const entity = entities[index];
    if (!entity || !Number.isFinite(entity.longitude) || !Number.isFinite(entity.latitude)) continue;
    if (entityProjectedOnCanvas(map, canvas, entity)) return 1;
  }
  return 0;
}

function entityProjectedOnCanvas(
  map: Pick<MapLibreMap, 'project'>,
  canvas: Pick<HTMLCanvasElement, 'clientWidth' | 'clientHeight'>,
  entity: Pick<VisualEntity, 'longitude' | 'latitude'>,
): boolean {
  if (!Number.isFinite(entity.longitude) || !Number.isFinite(entity.latitude)) return false;
  const point = map.project([entity.longitude, entity.latitude]);
  return point.x >= 0 && point.y >= 0
    && point.x <= canvas.clientWidth && point.y <= canvas.clientHeight;
}

export function projectedVisualEntity(
  map: Pick<MapLibreMap, 'getCanvas' | 'project'>,
  entity: Pick<VisualEntity, 'longitude' | 'latitude'>,
): 0 | 1 {
  return entityProjectedOnCanvas(map, map.getCanvas(), entity) ? 1 : 0;
}

const WEB_MERCATOR_EQUATOR_METERS = 40_075_016.686;

/** Deterministic projected bounds used by the LOD partition before adapter attach. */
export function projectedEntityScreenSizes(
  camera: Pick<WorldCamera, 'latitude' | 'zoom'>,
  entities: readonly VisualEntity[],
): Float32Array {
  const latitudeScale = Math.max(
    0.01,
    Math.cos((Math.max(-85, Math.min(85, camera.latitude)) * Math.PI) / 180),
  );
  const pixelsPerMeter = (512 * 2 ** camera.zoom) /
    (WEB_MERCATOR_EQUATOR_METERS * latitudeScale);
  const sizes = new Float32Array(entities.length);
  for (let index = 0; index < entities.length; index += 1) {
    const entity = entities[index]!;
    const meters = entity.kind === 'vehicle' ? 4.2 : 1.8;
    sizes[index] = Math.max(0, pixelsPerMeter * meters);
  }
  return sizes;
}

/** Owns exactly one MapLibre surface and every lifecycle coupled to it. */
export class SceneRuntime {
  private readonly root: HTMLElement;
  private readonly container: HTMLElement;
  private readonly telemetry: TelemetryBus;
  private readonly dependencies: SceneRuntimeDependencies;
  private readonly lifecycle = new AbortController();
  private readonly onSourceState: SceneRuntimeOptions['onSourceState'];
  private readonly onPartsState: SceneRuntimeOptions['onPartsState'];
  private readonly onReadiness: SceneRuntimeOptions['onReadiness'];
  private readonly onSelect?: SceneRuntimeOptions['onSelect'];
  private readonly onBuildingSelect?: SceneRuntimeOptions['onBuildingSelect'];
  private readonly onVerifiedMovementChange?: SceneRuntimeOptions['onVerifiedMovementChange'];
  private readonly onCameraChange?: SceneRuntimeOptions['onCameraChange'];
  private readonly onViewportChange?: SceneRuntimeOptions['onViewportChange'];
  private readonly onMapFeatures?: SceneRuntimeOptions['onMapFeatures'];
  private mapFeatureRevision = '';
  private lastMapFeatureScanMs = Number.NEGATIVE_INFINITY;
  private highlightedBuildingId: string | null = null;
  private readonly performanceMode: boolean;
  private readonly rendererQuality: RendererQuality;
  private readonly rendererMode: RendererMode;
  private readonly cityRendererV2: boolean;
  private readonly mapProvider: SceneRuntimeOptions['mapProvider'];
  private readonly sceneCachePolicy: SceneCachePolicy;
  private readonly sceneMemoryBudgetBytes?: number;
  private readonly sceneDeviceTier?: SceneDeviceTier;
  private readonly decorationTier: UniversalQualityTier;
  private readonly assetLoader: ReturnType<typeof createSceneAssetLoader>;
  private scenePmtilesProtocol: ScenePmtilesProtocolHandle | null = null;
  private universalPmtilesProtocol: UniversalPmtilesProtocolHandle | null = null;
  private universalFallbackStyle: MapStyle | null = null;
  private universalBuildingFallbackApplied = false;
  private activeBuildingSource: MapSourceDescriptorV1 | null = null;
  private universalAppearanceFrame: UniversalAppearanceFrame | null = null;
  private readonly baseMapOnly: boolean;
  private scenePack: WorldScenePackBinding | null;
  private sceneCellHints: readonly string[];
  /** Current+halo composition owned by this mounted runtime, never by React props. */
  private runtimeCityPayload: {
    bindingIdentity: string;
    value: WorldSceneCityPayload;
  } | null = null;
  private verifiedManifest: {
    bindingIdentity: string;
    value: SceneManifestV1;
  } | null = null;
  /** Optional universal movement/environment binding currently loading or terminally attempted. */
  private optionalSceneLoadIdentity: string | null = null;
  private map: MapLibreMap | null = null;
  private resizeObserver: ResizeObserverHandle | null = null;
  private styleController: MapStyleController | null = null;
  private universalRenderPhase: UniversalRenderPhase = 'settled_paused';
  private cameraMoving = false;
  private interactionController: InteractionController | null = null;
  private frameScheduler: FrameScheduler | null = null;
  private readonly pixelBudgetController: AdaptivePixelBudgetController;
  private readonly performanceGovernor: RendererPerformanceGovernor | null;
  private mapGpuFrameTimer: MapGpuFrameTimer | null = null;
  private performanceQaHook: PerformanceQaHook | null = null;
  private mapGpuFrameTimerSupported = false;
  private performanceGovernorActivated = false;
  private lastPerformanceSampleAtMs = Number.NEGATIVE_INFINITY;
  private demoPerformanceWarmupStarted = false;
  private lastPerformanceGpuSampleCount = 0;
  private lastPerformanceDecision: RendererPerformanceGovernorDecision['kind'] | null = null;
  /** Clock-anchor React updates must not re-upload unchanged Deck binary columns. */
  private deckLivingUpdateSkips = 0;
  private streamer: SceneStreamer<WorldSceneCellResource> | null = null;
  private streamerCameraMoveActive = false;
  private livingPipeline: LivingWorldPipeline | null = null;
  private livingController: LivingSimulationController | null = null;
  private latestLivingWorkerFrame: {
    readonly frame: LivingRenderFrame;
    readonly presentationTimeSeconds: number;
  } | null = null;
  private livingRenderFramePair: LivingRenderFramePair | null = null;
  private livingRenderFrameBuffer: LivingRenderFrame | null = null;
  private livingEntityViews: RetainedLivingEntityViews | null = null;
  private publishedSelectedView: VisualEntity | null = null;
  private publishedSelectedActivity: VisualEntity['activity'] | null = null;
  private adapters: RendererAdapter[] = [];
  private mapListenerDisposers: Array<() => void> = [];
  private loadTimer: number | undefined;
  private vegetationRefreshTimer: number | undefined;
  private vegetationRefreshRevision = 0;
  private vegetationCacheKey: string | null = null;
  private vegetationStyleEpoch = 0;
  private universalVegetationCount = 0;
  private universalVegetationOverlayReady = false;
  private universalMaterialAtlasReady = false;
  /** Remains false until a real precipitation draw layer is mounted. */
  private universalPrecipitationOverlayReady = false;
  private parts: RendererPartsState = { ...EMPTY_PARTS };
  private targetCamera: WorldCamera;
  private entities: readonly VisualEntity[];
  private selectedId: string | null;
  private activeLayers: ReadonlySet<WorldLayer>;
  private presentationMinutes: number;
  private presentationClock: RendererPresentationClock | null;
  private inputPresentationClock: RendererPresentationClock | null;
  private absolutePresentationSeconds: number;
  private staticPresentationSeconds: number;
  private clockAnchorNowMs: number;
  private reducedMotion: boolean;
  private currentSnapshot: RendererSceneSnapshot;
  private activeCellResource: WorldSceneCellResource | null = null;
  private movementMergeConflicts = 0;
  private movementReadinessStatus: RuntimeMovementTelemetry['status'] = 'unavailable';
  private staticPlanMergeConflicts = 0;
  private readiness: SceneRuntimeReadiness = {
    manifestVerified: false,
    cellsReady: false,
    contributionsReady: false,
    contributionDetailStatus: null,
  };
  private loaded = false;
  private mapRenderRevision = 0;
  private appliedUniversalSourceTileLod: {
    map: MapLibreMap;
    profileKey: 'moving' | 'settled';
    buildingSourceId: string;
    basemapSource: unknown;
    buildingSource: unknown;
  } | null = null;
  private providerErrors = 0;
  private disposed = false;
  private fallback = false;
  private projectionDirty = true;
  private lastProjectionMs = Number.NEGATIVE_INFINITY;
  private lastReadinessMs = Number.NEGATIVE_INFINITY;
  private lastWorkerSubmitMs = Number.NEGATIVE_INFINITY;
  private lastWorkerRequestedSeconds: number | null = null;
  private livingUsesNearCadence = false;
  private livingPartitionKey: string | null = null;
  private livingPartitionReplacements = 0;
  private livingWorkerGeneration = 0;
  private livingWorkerFailed = false;
  private requestedSeekRevision = 0;
  private appliedSeekRevision = 0;
  private pendingLivingSeek: PendingLivingSeek | null = null;
  private activeLivingSeek: PendingLivingSeek | null = null;

  constructor(options: SceneRuntimeOptions) {
    if (!isValidPresentationClock(options.presentationClock)) {
      throw new Error('Renderer presentation clock is invalid');
    }
    this.root = options.root;
    this.container = options.container;
    this.telemetry = options.telemetry;
    this.targetCamera = options.camera;
    this.rendererMode = options.rendererMode ?? DEFAULT_RENDERER_MODE;
    this.baseMapOnly = this.rendererMode === 'legacy_scene_debug'
      && options.cityRendererV2
      && options.sceneDetailUnavailableReason !== null;
    this.entities = this.baseMapOnly ? [] : options.entities;
    this.selectedId = options.selectedId;
    this.activeLayers = new Set(options.activeLayers);
    this.telemetry.setActiveLayers(this.activeLayers);
    this.presentationMinutes = options.presentationMinutes;
    this.presentationClock = options.presentationClock;
    this.inputPresentationClock = options.presentationClock;
    this.requestedSeekRevision = options.presentationClock?.seekRevision ?? 0;
    this.appliedSeekRevision = this.requestedSeekRevision;
    this.absolutePresentationSeconds = presentationAnchorSeconds(
      options.presentationClock,
      options.scenePack?.cityPayload?.presentationTimeIso,
      options.presentationMinutes,
    );
    this.staticPresentationSeconds = this.absolutePresentationSeconds;
    this.reducedMotion = options.reducedMotion;
    this.performanceMode = options.performanceMode;
    this.rendererQuality = options.rendererQuality;
    this.cityRendererV2 = options.cityRendererV2;
    this.mapProvider = options.mapProvider;
    this.sceneCachePolicy = options.sceneCachePolicy;
    this.sceneMemoryBudgetBytes = options.sceneMemoryBudgetBytes;
    this.sceneDeviceTier = options.sceneDeviceTier;
    this.assetLoader = createSceneAssetLoader({
      cachePolicy: options.sceneCachePolicy,
      memoryBudgetBytes: options.sceneMemoryBudgetBytes,
      deviceTier: options.sceneDeviceTier,
    });
    this.telemetry.setAssetCache(this.assetLoader.snapshot());
    this.telemetry.setMapProvider({ requested: this.mapProvider, status: 'checking' });
    this.scenePack = options.scenePack;
    this.sceneCellHints = [...new Set(options.sceneCellHints ?? [])];
    this.onSelect = options.onSelect;
    this.onBuildingSelect = options.onBuildingSelect;
    this.onVerifiedMovementChange = options.onVerifiedMovementChange;
    this.onCameraChange = options.onCameraChange;
    this.onViewportChange = options.onViewportChange;
    this.onMapFeatures = options.onMapFeatures;
    this.onSourceState = options.onSourceState;
    this.onPartsState = options.onPartsState;
    this.onReadiness = options.onReadiness;
    this.dependencies = { ...defaultDependencies(), ...options.dependencies };
    this.decorationTier = resolveUniversalDecorationTier(
      this.rendererQuality,
      this.sceneDeviceTier,
      this.dependencies.readDeviceCapabilities(),
    );
    this.pixelBudgetController = new AdaptivePixelBudgetController({
      initialScale: this.decorationTier === 'high' ? 0.85 : 1,
      targetFrameMs: this.decorationTier === 'high'
        ? 1_000 / 120
        : this.decorationTier === 'mid' ? 1_000 / 60 : 1_000 / 30,
    });
    this.performanceGovernor = this.rendererMode === 'universal_lowpoly'
      ? new RendererPerformanceGovernor({
          preserveIndividualPresentation: Boolean(this.onMapFeatures),
          qualityTier: this.decorationTier,
          initialDprScale: this.decorationTier === 'high'
            ? 0.85
            : this.decorationTier === 'low' ? 0.75 : 1,
        })
      : null;
    this.publishPerformanceGovernorTelemetry(
      this.performanceGovernor ? 'waiting_gpu_sample' : 'disabled',
    );
    this.clockAnchorNowMs = this.dependencies.now();
    this.currentSnapshot = {
      aggregateRoadFlows: options.aggregateRoadFlows ?? null,
      presentationMovement: options.presentationMovement,
      camera: options.camera,
      entities: this.entities,
      entitiesV2: options.entitiesV2,
      mobilityPresentationMovement: options.mobilityPresentationMovement,
      selectedId: options.selectedId,
      presentationMinutes: options.presentationMinutes,
      presentationClock: options.presentationClock,
      reducedMotion: options.reducedMotion,
      activeLayers: this.activeLayers,
      weather: options.weather,
      weatherVisualOverride: options.weatherVisualOverride ?? null,
      rendererQuality: options.rendererQuality,
      scenePack: options.scenePack,
      living: null,
    };
    this.telemetry.setSceneIdentity(options.scenePack ? {
      sceneId: options.scenePack.sceneId,
      sceneVersion: options.scenePack.sceneVersion,
      manifestSha256: options.scenePack.manifestSha256,
      manifestVerified: false,
    } : null);
    this.root.dataset.rendererMode = this.rendererMode;
    this.root.dataset.mapIdle = 'false';
    this.root.dataset.mapTilesLoaded = 'false';
    this.root.dataset.mapRenderRevision = '0';
    this.root.dataset.threeGroupCount = this.rendererMode === 'universal_lowpoly' ? '0' : 'pending';
    this.root.dataset.dynamicInstanceCap = String(
      this.rendererMode === 'universal_lowpoly'
        ? universalInstanceCaps(this.decorationTier).maxAmbientInstances
        : dynamicInstanceCap(this.rendererQuality),
    );
    this.root.dataset.decorationTier = this.decorationTier;
    this.updateBuildingSourceSelection(options.buildingSourceSelection ?? {
      active: OPENMAPTILES_BUILDINGS_SOURCE,
      state: 'degraded',
      fallbackActive: true,
      reason: 'overture_not_configured',
    });
    if (this.cityRendererV2 && !this.baseMapOnly) {
      this.rebuildLivingPipeline(this.currentSnapshot);
    }
    this.installPerformanceQaHook();
  }

  getAdapters(): readonly RendererAdapter[] {
    return this.adapters;
  }

  async start(): Promise<void> {
    if (this.disposed || this.map) return;
    try {
      if (
        this.rendererMode === 'legacy_scene_debug' &&
        this.cityRendererV2 &&
        !this.baseMapOnly &&
        (!this.scenePack || this.scenePack.sourceDetailStatus !== 'available')
      ) throw new Error('Renderer v2 requires an available selected scene binding');
      const selectedScenePack = this.cityRendererV2
        && !this.baseMapOnly
        && this.scenePack?.sourceDetailStatus === 'available'
        ? this.scenePack
        : null;
      const manifestRequiredForMap = this.rendererMode === 'legacy_scene_debug'
        || this.mapProvider === 'pmtiles';
      if (this.rendererMode === 'universal_lowpoly' && !manifestRequiredForMap) {
        this.beginOptionalUniversalSceneLoad(selectedScenePack);
      }
      const manifestPromise = selectedScenePack && manifestRequiredForMap
        ? this.dependencies.loadManifest(
            selectedScenePack,
            this.lifecycle.signal,
            this.sceneCachePolicy,
            this.assetLoader,
          )
        : Promise.resolve(null);
      const [mapLibre, style, manifest, cityTilePack] = await Promise.all([
        this.dependencies.loadMapLibre(),
        this.dependencies.loadStyle(this.lifecycle.signal),
        manifestPromise,
        this.onMapFeatures ? loadCityTilePack({ signal: this.lifecycle.signal }) : Promise.resolve(null),
      ]);
      this.telemetry.setAssetCache(this.assetLoader.snapshot());
      if (!this.isActive()) return;
      let resolvedStyle = style;
      if (this.rendererMode === 'universal_lowpoly') {
        this.universalFallbackStyle = applyUniversalBuildingStyle(
          resolvedStyle,
          OPENMAPTILES_BUILDINGS_SOURCE,
          { qualityTier: this.decorationTier, ...(this.onMapFeatures ? { materialDetailZoom: 16 } : {}) },
        );
        const developmentPrimary = !this.onMapFeatures && loopbackUniversalInspectionEnabled(window.location.hostname)
          ? OFFICIAL_OVERTURE_DEVELOPMENT_BUILDINGS_SOURCE
          : null;
        if (developmentPrimary) {
          const registration = this.dependencies.registerUniversalPmtiles(
            mapLibre,
            developmentPrimary,
          );
          try {
            const handle = await promiseWithDeadline(
              registration,
              UNIVERSAL_BUILDING_INIT_TIMEOUT_MS,
              this.dependencies.setTimeout,
              this.dependencies.clearTimeout,
              'OVERTURE_BUILDING_INIT_TIMEOUT',
            );
            if (!this.isActive()) {
              handle.dispose();
              return;
            }
            this.universalPmtilesProtocol = handle;
            resolvedStyle = applyUniversalBuildingStyle(resolvedStyle, developmentPrimary, {
              qualityTier: this.decorationTier,
            });
            this.updateBuildingSourceSelection(resolveBuildingSourceSelection({
              primary: developmentPrimary,
              fallback: OPENMAPTILES_BUILDINGS_SOURCE,
              primaryState: 'ready',
              fallbackState: 'ready',
            }));
          } catch (error) {
            // A registration that resolves after the deadline must not leak a
            // protocol binding or replace the already-selected whole-source fallback.
            void registration.then((lateHandle) => lateHandle.dispose(), () => undefined);
            resolvedStyle = this.universalFallbackStyle;
            this.universalBuildingFallbackApplied = true;
            this.updateBuildingSourceSelection(resolveBuildingSourceSelection({
              primary: developmentPrimary,
              fallback: OPENMAPTILES_BUILDINGS_SOURCE,
              primaryState: 'unavailable',
              fallbackState: 'ready',
              primaryFailureReason: error instanceof Error
                ? error.message
                : 'overture_registration_failed',
            }));
          }
        } else {
          resolvedStyle = this.universalFallbackStyle;
          this.universalBuildingFallbackApplied = true;
        }
      }
      if (this.mapProvider === 'scene_only') {
        resolvedStyle = sceneOnlyMapStyle();
      }
      if (this.mapProvider === 'pmtiles') {
        const basemap = manifest?.basemap;
        if (!manifest || !basemap || basemap.format !== 'pmtiles') {
          this.telemetry.setMapProvider({ requested: 'pmtiles', status: 'unavailable' });
          throw new Error('Verified scene PMTiles basemap is unavailable');
        }
        const handle = await this.dependencies.registerScenePmtiles(mapLibre, {
          featureEnabled: true,
          sceneId: manifest.sceneId,
          assetPath: basemap.path,
          assetUrl: `/scenes/${manifest.sceneId}/${basemap.sha256}/${basemap.path}`,
          sha256: basemap.sha256,
          bytes: basemap.bytes,
          attribution: basemap.attribution,
          applicationOrigin: window.location.origin,
        });
        if (!this.isActive()) {
          handle.dispose();
          return;
        }
        this.scenePmtilesProtocol = handle;
        resolvedStyle = styleWithScenePmtiles(style, handle);
      }
      this.telemetry.setMapProvider({ requested: this.mapProvider, status: 'ready' });
      if (
        this.rendererMode === 'legacy_scene_debug' &&
        this.cityRendererV2 && !this.baseMapOnly && !manifest
      ) {
        throw new Error('Selected scene manifest is unavailable');
      }
      if (manifest && selectedScenePack) {
        if (sceneBindingIdentity(this.scenePack) !== sceneBindingIdentity(selectedScenePack)) {
          throw new Error('Selected scene binding changed while its manifest was loading');
        }
        this.verifiedManifest = {
          bindingIdentity: sceneBindingIdentity(selectedScenePack)!,
          value: manifest,
        };
        this.scenePack = this.withVerifiedManifest(this.scenePack);
        this.currentSnapshot = { ...this.currentSnapshot, scenePack: this.scenePack };
        if (this.rendererMode === 'universal_lowpoly') {
          this.optionalSceneLoadIdentity = sceneBindingIdentity(selectedScenePack);
          this.root.dataset.universalSceneStreamStatus = 'manifest_ready';
          this.root.dataset.universalSceneStreamReason = 'none';
        }
      }
      this.setReadiness({
        manifestVerified: this.rendererMode === 'universal_lowpoly'
          ? true
          : this.cityRendererV2 ? Boolean(manifest) : true,
        cellsReady: this.rendererMode === 'universal_lowpoly'
          ? true
          : this.readiness.cellsReady,
        contributionsReady: this.rendererMode === 'universal_lowpoly'
          ? true
          : this.readiness.contributionsReady,
        contributionDetailStatus: this.baseMapOnly
          ? 'SCENE_DETAIL_UNAVAILABLE'
          : this.readiness.contributionDetailStatus,
      });
      if (this.scenePack) {
        this.telemetry.setSceneIdentity({
          sceneId: this.scenePack.sceneId,
          sceneVersion: this.scenePack.sceneVersion,
          manifestSha256: this.scenePack.manifestSha256,
          manifestVerified: this.cityRendererV2
            ? Boolean(
                this.verifiedManifest
                && sceneBindingIdentity(this.scenePack) === this.verifiedManifest.bindingIdentity
              )
            : true,
        });
      }
      mapLibre.setWorkerUrl(mapLibreWorkerUrl);
      if (cityTilePack) {
        resolvedStyle = applyCityTilePack(resolvedStyle, cityTilePack);
        this.updateBuildingSourceSelection({
          active: { ...OPENMAPTILES_BUILDINGS_SOURCE, datasetVersion: cityTilePack.manifest.datasetVersion },
          state: 'ready', fallbackActive: false, reason: null,
        });
        this.root.dataset.demoCityPack = cityTilePack.manifest.packId;
        this.root.dataset.demoCityPackTiles = String(cityTilePack.manifest.tileCount);
      } else if (this.onMapFeatures) this.root.dataset.demoCityPack = 'streaming_fallback';
      const effectiveQuality = this.rendererMode === 'universal_lowpoly'
        ? rendererQualityForUniversalTier(this.decorationTier)
        : this.rendererQuality;
      const profile = rendererQualityProfile(
        effectiveQuality,
        typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1,
      );
      const initialBounds = this.container.getBoundingClientRect();
      const pixelPolicy = this.pixelPolicyForBounds(initialBounds);
      this.publishPixelBudget(pixelPolicy);
      const camera = this.targetCamera;
      const map = new mapLibre.Map({
        container: this.container,
        style: resolvedStyle,
        center: [camera.longitude, camera.latitude],
        zoom: camera.zoom,
        pitch: camera.pitch,
        bearing: camera.bearing,
        attributionControl: { compact: false },
        pixelRatio: pixelPolicy.pixelRatio,
        cooperativeGestures: !this.onMapFeatures,
        maxPitch: profile.maxPitch,
        fadeDuration: this.reducedMotion ? 0 : profile.mapFadeDuration,
        ...(this.rendererMode === 'universal_lowpoly'
          ? universalMapPerformanceOptions()
          : {}),
        ...(this.onMapFeatures ? {
          ...(cityTilePack ? { transformRequest: cityTilePack.transformRequest } : {}),
          minZoom: 12,
          maxZoom: 20,
          maxBounds: [[61.10, 54.95], [61.70, 55.38]] as [[number, number], [number, number]],
          renderWorldCopies: false,
        } : {}),
      });
      if (!this.isActive()) {
        map.remove();
        return;
      }
      this.map = map;
      this.installMapLifecycle(map, mapLibre.NavigationControl);
    } catch (error: unknown) {
      if (this.lifecycle.signal.aborted || this.disposed) return;
      this.telemetry.setMapProvider({ requested: this.mapProvider, status: 'unavailable' });
      this.switchToFallback();
    }
  }

  setHighlightedBuilding(id: string | null): void {
    this.highlightedBuildingId = id;
    const map = this.map;
    if (!map?.isStyleLoaded() || !map.getSource('openmaptiles')) return;
    const layerId = 'demo-selected-building';
    const featureId = id?.startsWith('openmaptiles_buildings:') ? id.slice('openmaptiles_buildings:'.length) : null;
    if (!featureId) {
      if (map.getLayer(layerId)) map.setLayoutProperty(layerId, 'visibility', 'none');
      return;
    }
    const filter = ['==', ['to-string', ['coalesce', ['id'], ['get', 'id']]], featureId] as unknown as NonNullable<Parameters<MapLibreMap['setFilter']>[1]>;
    if (map.getLayer(layerId)) {
      map.setFilter(layerId, filter);
      map.setLayoutProperty(layerId, 'visibility', 'visible');
    } else {
      map.addLayer({ id: layerId, type: 'fill-extrusion', source: 'openmaptiles', 'source-layer': 'building',
        filter, paint: { 'fill-extrusion-color': '#66d4c7', 'fill-extrusion-opacity': 0.65,
          'fill-extrusion-height': ['+', BUILDING_HEIGHT_EXPRESSION, 0.8] as never,
          'fill-extrusion-base': 0, 'fill-extrusion-vertical-gradient': true } });
    }
  }

  updateScene(snapshot: RendererSceneSnapshot): void {
    if (this.disposed) return;
    if (!isValidPresentationClock(snapshot.presentationClock)) {
      throw new Error('Renderer presentation clock is invalid');
    }
    const previousBindingIdentity = sceneBindingIdentity(this.scenePack);
    const previousSelectedId = this.selectedId;
    const previousLiving = this.currentSnapshot.living;
    this.entities = this.baseMapOnly ? [] : snapshot.entities;
    this.selectedId = snapshot.selectedId;
    const incomingScenePack = this.withVerifiedManifest(snapshot.scenePack);
    if (
      this.runtimeCityPayload
      && sceneBindingIdentity(incomingScenePack) !== this.runtimeCityPayload.bindingIdentity
    ) {
      this.runtimeCityPayload = null;
      this.onVerifiedMovementChange?.(null);
    }
    const scenePack = this.withRuntimeCityPayload(incomingScenePack);
    const nextBindingIdentity = sceneBindingIdentity(scenePack);
    if (
      this.rendererMode === 'universal_lowpoly'
      && previousBindingIdentity !== nextBindingIdentity
    ) this.resetOptionalUniversalSceneBinding(nextBindingIdentity);
    const previousSeekRevision = this.inputPresentationClock?.seekRevision ?? 0;
    const nextSeekRevision = snapshot.presentationClock?.seekRevision ?? 0;
    if (nextSeekRevision < previousSeekRevision) {
      throw new Error('Renderer presentation seek revision must be monotonic');
    }
    const explicitSeek = nextSeekRevision !== previousSeekRevision;
    const nowMs = this.dependencies.now();
    const currentPresentationSeconds = presentationSecondsAt(
      this.presentationClock,
      this.clockAnchorNowMs,
      nowMs,
      this.staticPresentationSeconds,
    );
    const nextInputPresentationSeconds = presentationAnchorSeconds(
      snapshot.presentationClock,
      scenePack?.cityPayload?.presentationTimeIso,
      snapshot.presentationMinutes,
    );
    this.absolutePresentationSeconds = reanchorPresentationSeconds(
      currentPresentationSeconds,
      this.inputPresentationClock,
      snapshot.presentationClock,
      nextInputPresentationSeconds,
    );
    this.presentationMinutes = snapshot.presentationMinutes;
    this.inputPresentationClock = snapshot.presentationClock;
    this.presentationClock = snapshot.presentationClock
      ? {
          ...snapshot.presentationClock,
          absolutePresentationSeconds: this.absolutePresentationSeconds,
        }
      : null;
    this.staticPresentationSeconds = this.absolutePresentationSeconds;
    this.clockAnchorNowMs = nowMs;
    if (this.onMapFeatures) {
      this.root.dataset.demoClockPaused = String(this.presentationClock?.paused ?? true);
      this.root.dataset.demoClockAnchorSeconds = this.absolutePresentationSeconds.toFixed(3);
    }
    this.reducedMotion = snapshot.reducedMotion;
    this.scenePack = scenePack;
    this.telemetry.setSceneIdentity(scenePack ? {
      sceneId: scenePack.sceneId,
      sceneVersion: scenePack.sceneVersion,
      manifestSha256: scenePack.manifestSha256,
      manifestVerified: Boolean(
        this.verifiedManifest
        && sceneBindingIdentity(scenePack) === this.verifiedManifest.bindingIdentity
      ),
    } : null);
    this.currentSnapshot = {
      ...snapshot,
      entities: this.entities,
      entitiesV2: snapshot.entitiesV2 ?? this.currentSnapshot.entitiesV2,
      mobilityPresentationMovement: snapshot.mobilityPresentationMovement
        ?? this.currentSnapshot.mobilityPresentationMovement,
      activeLayers: this.activeLayers,
      presentationClock: this.presentationClock,
      scenePack,
      living: this.currentSnapshot.living,
    };
    if (this.rendererMode === 'universal_lowpoly') {
      this.beginOptionalUniversalSceneLoad(
        scenePack?.sourceDetailStatus === 'available' ? scenePack : null,
      );
    }
    if (this.cityRendererV2 && !this.baseMapOnly) {
      this.rebuildLivingPipeline(this.currentSnapshot);
    }
    this.notifySelectedLivingEntity();
    if (explicitSeek) {
      this.requestedSeekRevision = nextSeekRevision;
      this.publishLivingLifecycle();
      this.queueLivingSeek({
        revision: nextSeekRevision,
        presentationTimeSeconds: this.absolutePresentationSeconds,
        reducedMotion: this.reducedMotion,
      });
    }
    for (const adapter of this.adapters) {
      const unchangedUniversalDeckLiving = this.rendererMode === 'universal_lowpoly'
        && adapter.kind === 'deck'
        && previousSelectedId === this.selectedId
        && previousLiving === this.currentSnapshot.living;
      if (unchangedUniversalDeckLiving) {
        adapter.updateAggregateRoadFlows?.(this.currentSnapshot.aggregateRoadFlows ?? null);
        // The UI publishes a new presentation-clock anchor once per second.
        // The Living worker owns motion frames and already calls updateLiving
        // at its bounded cadence, so uploading the same binary columns here is
        // redundant. Preserve a future Deck scene contribution independently.
        adapter.updateScene?.(this.currentSnapshot);
        this.deckLivingUpdateSkips += 1;
        this.root.dataset.deckLivingUpdateSkips = String(this.deckLivingUpdateSkips);
        continue;
      }
      this.applySnapshotToAdapter(adapter);
    }
    this.projectionDirty = true;
    this.telemetry.notifyAdaptersChanged();
    this.updateContinuousFrames();
    if (this.rendererMode === 'universal_lowpoly' && this.map && this.loaded) {
      this.settleRendererPerformanceIfIdle(this.map);
      this.applyUniversalRenderPhase(this.map, this.resolveUniversalRenderPhase());
      this.applyUniversalAppearance(this.map, this.absolutePresentationSeconds);
    }
    this.frameScheduler?.invalidate();
  }

  updateCamera(camera: WorldCamera): void {
    if (this.disposed || !isResolvedWorldCamera(camera)) return;
    this.targetCamera = camera;
    this.currentSnapshot = { ...this.currentSnapshot, camera };
    const map = this.map;
    if (!map) {
      this.streamer?.updateCamera(camera);
      return;
    }
    const current = readMapCamera(map);
    const settled = !cameraChanged(current, camera);
    this.telemetry.setCamera({ current, target: camera, settled });
    this.projectionDirty = true;
    if (settled) {
      this.streamer?.updateCamera(camera);
      this.frameScheduler?.invalidate();
      return;
    }
    if (this.rendererMode === 'universal_lowpoly') {
      this.cameraMoving = true;
      this.streamer?.beginCameraMove();
      this.streamerCameraMoveActive = true;
      this.mapGpuFrameTimer?.resetFrameIntervals?.();
      this.applyUniversalRenderPhase(map, 'camera_motion');
    } else {
      this.streamer?.updateCamera(camera);
    }
    map.easeTo({
      center: [camera.longitude, camera.latitude],
      zoom: camera.zoom,
      pitch: camera.pitch,
      bearing: camera.bearing,
      duration: this.reducedMotion ? 0 : 700,
    });
  }

  updateSceneCellHints(cellIds: readonly string[]): void {
    if (this.disposed) return;
    const next = [...new Set(cellIds)];
    if (next.length === this.sceneCellHints.length
      && next.every((cellId, index) => cellId === this.sceneCellHints[index])) return;
    this.sceneCellHints = next;
    this.streamer?.updateExactCells(next);
  }

  updateLayers(activeLayers: ReadonlySet<WorldLayer>): void {
    if (this.disposed) return;
    this.activeLayers = new Set(activeLayers);
    this.currentSnapshot = {
      ...this.currentSnapshot,
      activeLayers: this.activeLayers,
    };
    this.styleController?.setActiveLayers(this.activeLayers);
    this.telemetry.setActiveLayers(this.activeLayers);
    if (this.cityRendererV2) {
      for (const adapter of this.adapters) adapter.updateScene?.(this.currentSnapshot);
      this.telemetry.notifyAdaptersChanged();
    }
    if (this.rendererMode === 'universal_lowpoly' && this.map && this.loaded) {
      this.vegetationCacheKey = null;
      this.applyUniversalRenderPhase(this.map, this.resolveUniversalRenderPhase());
      if (this.hasDetailedPresentation()) {
        this.scheduleUniversalVegetation(this.map, readMapCamera(this.map), true);
      }
    }
    this.updateContinuousFrames();
    this.frameScheduler?.invalidate();
  }

  updateBuildingSourceSelection(selection: BuildingSourceSelection): void {
    const previousProviderId = this.activeBuildingSource?.id ?? null;
    this.activeBuildingSource = selection.active;
    if (previousProviderId !== (selection.active?.id ?? null)) this.onBuildingSelect?.(null);
    this.root.dataset.buildingSourceState = selection.state;
    this.root.dataset.activeBuildingSource = selection.active?.id ?? 'none';
    this.root.dataset.buildingSourceFallbackActive = String(selection.fallbackActive);
    this.root.dataset.buildingSourceReason = selection.reason ?? 'none';
    if (this.rendererMode === 'universal_lowpoly' && this.map && this.loaded) {
      this.applyUniversalSourceTileLod(this.map, this.universalRenderPhase);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.sceneCellHints = [];
    this.onVerifiedMovementChange?.(null);
    this.lifecycle.abort();
    this.disposeMapSurface();
  }

  private resetOptionalUniversalSceneBinding(_nextIdentity: string | null): void {
    this.sceneCellHints = [];
    this.streamer?.dispose();
    this.streamer = null;
    this.streamerCameraMoveActive = false;
    this.optionalSceneLoadIdentity = null;
    this.verifiedManifest = null;
    this.runtimeCityPayload = null;
    this.onVerifiedMovementChange?.(null);
    this.activeCellResource = null;
    this.movementMergeConflicts = 0;
    this.root.dataset.universalSceneStreamStatus = 'disabled';
    this.root.dataset.universalSceneStreamReason = 'binding_changed';
  }

  /**
   * Verifies the optional universal scene independently from MapLibre startup.
   * A rejected manifest disables only movement/environment streaming; it never
   * switches the retained map to the full-canvas fallback.
   */
  private beginOptionalUniversalSceneLoad(
    binding: Extract<WorldScenePackBinding, { sourceDetailStatus: 'available' }> | null,
  ): void {
    if (this.rendererMode !== 'universal_lowpoly' || !this.cityRendererV2) return;
    if (!binding) {
      if (!this.optionalSceneLoadIdentity) {
        this.root.dataset.universalSceneStreamStatus = 'disabled';
        this.root.dataset.universalSceneStreamReason = 'scene_not_available';
      }
      return;
    }
    const bindingIdentity = sceneBindingIdentity(binding)!;
    if (this.verifiedManifest?.bindingIdentity === bindingIdentity) {
      this.root.dataset.universalSceneStreamStatus = this.streamer
        ? this.root.dataset.individualLivingCellsEnabled === 'false'
          ? 'aggregate_only'
          : 'streaming'
        : 'manifest_ready';
      this.root.dataset.universalSceneStreamReason = this.streamer
        && this.root.dataset.individualLivingCellsEnabled === 'false'
        ? 'individual_cells_suspended'
        : 'none';
      this.installSceneStreamerIfEligible();
      return;
    }
    if (this.optionalSceneLoadIdentity === bindingIdentity) return;
    this.optionalSceneLoadIdentity = bindingIdentity;
    this.root.dataset.universalSceneStreamStatus = 'manifest_loading';
    this.root.dataset.universalSceneStreamReason = 'none';
    void Promise.resolve().then(() => this.dependencies.loadManifest(
      binding,
      this.lifecycle.signal,
      this.sceneCachePolicy,
      this.assetLoader,
    )).then((manifest) => {
      if (
        !this.isActive()
        || this.optionalSceneLoadIdentity !== bindingIdentity
        || sceneBindingIdentity(this.scenePack) !== bindingIdentity
      ) return;
      this.verifiedManifest = { bindingIdentity, value: manifest };
      this.scenePack = this.withVerifiedManifest(this.scenePack);
      this.currentSnapshot = { ...this.currentSnapshot, scenePack: this.scenePack };
      this.root.dataset.universalSceneStreamStatus = 'manifest_ready';
      this.root.dataset.universalSceneStreamReason = 'none';
      this.telemetry.setSceneIdentity({
        sceneId: binding.sceneId,
        sceneVersion: binding.sceneVersion,
        manifestSha256: binding.manifestSha256,
        manifestVerified: true,
      });
      this.telemetry.setAssetCache(this.assetLoader.snapshot());
      this.installSceneStreamerIfEligible();
    }).catch((error: unknown) => {
      if (
        !this.isActive()
        || this.optionalSceneLoadIdentity !== bindingIdentity
        || sceneBindingIdentity(this.scenePack) !== bindingIdentity
      ) return;
      this.root.dataset.universalSceneStreamStatus = 'unavailable';
      this.root.dataset.universalSceneStreamReason = error instanceof Error
        ? error.message
        : 'manifest_load_failed';
      this.telemetry.setSceneIdentity({
        sceneId: binding.sceneId,
        sceneVersion: binding.sceneVersion,
        manifestSha256: binding.manifestSha256,
        manifestVerified: false,
      });
    });
  }

  private installSceneStreamerIfEligible(): void {
    if (this.streamer || !this.map || !this.cityRendererV2 || this.baseMapOnly) return;
    const availableScene = this.scenePack?.sourceDetailStatus === 'available'
      ? this.scenePack
      : null;
    if (!availableScene) return;
    const bindingIdentity = sceneBindingIdentity(availableScene)!;
    if (
      this.rendererMode === 'universal_lowpoly'
      && this.verifiedManifest?.bindingIdentity !== bindingIdentity
    ) return;
    const cellLoader = availableScene.loadCell;
    if (!cellLoader) {
      if (this.rendererMode === 'universal_lowpoly') {
        this.root.dataset.universalSceneStreamStatus = 'unavailable';
        this.root.dataset.universalSceneStreamReason = 'cell_loader_unavailable';
      }
      return;
    }
    this.streamer = new SceneStreamer<WorldSceneCellResource>({
      loadCell: async (request) => {
        const resource = await cellLoader({
          ...request,
          sceneId: availableScene.sceneId,
          sceneVersion: availableScene.sceneVersion,
          sceneTimeZone: availableScene.sceneTimeZone,
          assetLoader: this.assetLoader,
        });
        this.telemetry.setAssetCache(this.assetLoader.snapshot());
        return verifySceneCellResource(availableScene, request.cell, resource);
      },
      releaseCell: (resource) => resource.dispose?.(),
      onResourcesChange: (resources) => this.updateStreamResources(resources),
      estimateBytes: (resource) => resource.estimateBytes,
      cachePolicy: this.sceneCachePolicy,
      memoryBudgetBytes: this.sceneMemoryBudgetBytes,
      deviceTier: this.sceneDeviceTier,
      onChange: (snapshot) => {
        this.telemetry.setStreamer(snapshot);
        const ready = !snapshot.individualCellsEnabled || (
          snapshot.desiredCells > 0
          && snapshot.activeCells === snapshot.desiredCells
          && snapshot.pendingCells === 0
          && snapshot.failedCells === 0
        );
        if (this.rendererMode === 'universal_lowpoly') {
          this.root.dataset.universalSceneDesiredCells = String(snapshot.desiredCells);
          this.root.dataset.universalSceneActiveCells = String(snapshot.activeCells);
          this.root.dataset.universalSceneFailedCells = String(snapshot.failedCells);
          this.root.dataset.universalSceneStreamStatus = !snapshot.individualCellsEnabled
            ? 'aggregate_only'
            : snapshot.failedCells > 0 ? 'degraded' : ready ? 'ready' : 'streaming';
          this.root.dataset.universalSceneStreamReason = !snapshot.individualCellsEnabled
            ? 'individual_cells_suspended'
            : snapshot.failedCells > 0 ? 'cell_load_failed' : 'none';
        } else {
          this.setReadiness({ cellsReady: ready });
        }
      },
    });
    const individualCellsEnabled = (
      this.targetCamera.zoom >= 15.5
      && (this.performanceGovernor?.snapshot.individualActorsEnabled ?? true)
    );
    this.streamer.setIndividualCellsEnabled(individualCellsEnabled);
    this.streamer.updateExactCells(this.sceneCellHints);
    if (this.rendererMode === 'universal_lowpoly') {
      this.root.dataset.universalSceneStreamStatus = individualCellsEnabled
        ? 'streaming'
        : 'aggregate_only';
      this.root.dataset.universalSceneStreamReason = individualCellsEnabled
        ? 'none'
        : 'individual_cells_suspended';
    }
    this.streamer.updateCamera(this.targetCamera);
  }

  private installMapLifecycle(
    map: MapLibreMap,
    NavigationControl: typeof import('maplibre-gl').NavigationControl,
  ): void {
    this.resizeObserver = this.dependencies.createResizeObserver((entries) => {
      if (!this.isActiveMap(map)) return;
      const bounds = entries.at(-1)?.contentRect ?? this.container.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) return;
      this.applyPixelBudget(map, bounds);
      map.resize();
      this.frameScheduler?.invalidate('resize');
      this.publishFrameSchedulerState();
    });
    this.resizeObserver.observe(this.container);
    this.styleController = new MapStyleController(map, {
      preserveBaseExtrusions: Boolean(this.onMapFeatures),
      baseBuildingLayerIntentionallyAbsent: this.mapProvider === 'scene_only',
      onOwnershipChange: (ownership) => this.telemetry.setMapStyleOwnership(ownership),
    });
    this.styleController.setActiveLayers(this.activeLayers);
    this.telemetry.setMapStyleOwnership(this.styleController.ownershipSnapshot());
    if (this.rendererMode === 'universal_lowpoly') this.attachPerformanceTimer(map);
    this.frameScheduler = new FrameScheduler({
      repaint: () => {
        if (this.isActiveMap(map)) map.triggerRepaint();
      },
      targetFramesPerSecond: this.decorationTier === 'high'
        ? 120
        : this.decorationTier === 'mid' ? 60 : 30,
      onFrame: (frame) => {
        this.requestLivingWorkerFrame(frame);
        if (this.rendererMode === 'legacy_scene_debug') {
          this.applyLivingFrameInterpolation(frame);
        }
        for (const adapter of this.adapters) adapter.frame?.(frame);
        if (
          this.rendererMode === 'universal_lowpoly'
          && Math.floor(presentationMinutesAt(frame.absolutePresentationSeconds) / 15)
            !== this.universalAppearanceFrame?.sunBucket
        ) {
          this.applyUniversalAppearance(map, frame.absolutePresentationSeconds);
        }
        if (
          this.rendererQuality === 'adaptive'
          && this.shouldUseAdaptivePixelFallback()
          && this.pixelBudgetController.observeFrame(frame.deltaMs)
        ) {
          this.applyPixelBudget(map, this.container.getBoundingClientRect());
        }
      },
      readPresentationState: (nowMs) => {
        const clock = this.presentationClock;
        this.absolutePresentationSeconds = presentationSecondsAt(
          clock,
          this.clockAnchorNowMs,
          nowMs,
          this.staticPresentationSeconds,
        );
        return {
          presentationMinutes: presentationMinutesAt(this.absolutePresentationSeconds),
          absolutePresentationSeconds: this.absolutePresentationSeconds,
          paused: clock?.paused ?? true,
          baseRateSecondsPerWallSecond: clock?.baseRateSecondsPerWallSecond ?? 0,
          speedMultiplier: clock?.speedMultiplier ?? 0,
          reducedMotion: this.reducedMotion,
          sceneTimeZone: this.scenePack?.sceneTimeZone ?? null,
          environment: this.scenePack?.cityPayload?.environment ?? null,
        };
      },
    });
    const handleVisibility = () => {
      this.frameScheduler?.setVisible(!document.hidden);
      this.updateContinuousFrames();
      this.publishFrameSchedulerState();
    };
    document.addEventListener('visibilitychange', handleVisibility);
    this.mapListenerDisposers.push(
      () => document.removeEventListener('visibilitychange', handleVisibility),
    );
    this.installSceneStreamerIfEligible();
    this.interactionController = new InteractionController({
      map,
      getEntities: () => this.livingEntityViews?.entities ?? this.entities,
      getEntityById: (id) => (this.rendererMode === 'universal_lowpoly'
        ? this.refreshLivingEntityViewById(id)
        : this.livingEntityViews?.byId.get(id) ?? null)
        ?? (this.rendererMode === 'legacy_scene_debug'
          ? this.entities.find((entity) => entity.id === id) ?? null
          : null),
      getLiving: () => this.currentSnapshot.living,
      pickAt: (x, y) => {
        for (const adapter of this.adapters) {
          const picked = adapter.pickAt?.(x, y) ?? null;
          if (picked) return picked;
        }
        return null;
      },
      pickBuildingAt: (x, y) => {
        if (this.rendererMode !== 'universal_lowpoly' || !this.activeBuildingSource) return null;
        const styleLayerIds = new Set(map.getStyle().layers?.map(({ id }) => id) ?? []);
        const layers = (BUILDING_PICK_LAYER_IDS as readonly string[]).filter(
          (id) => styleLayerIds.has(id),
        );
        if (layers.length === 0) return null;
        // One click produces exactly one MapLibre feature query. Decoration
        // layers are not present in `layers`, so they cannot steal selection.
        const features = map.queryRenderedFeatures([x, y], { layers });
        for (const feature of features) {
          const selection = resolveRendererBuildingSelection(
            this.activeBuildingSource,
            feature,
          );
          if (selection) return selection;
        }
        return null;
      },
      allowCpuEntityPicking: this.rendererMode === 'legacy_scene_debug',
      readTargetCamera: () => this.targetCamera,
      onSelect: this.publishSelectedEntity,
      onBuildingSelect: this.onBuildingSelect,
      onCameraChange: (camera) => {
        if (this.rendererMode === 'universal_lowpoly') {
          this.applyUniversalAppearance(map, this.absolutePresentationSeconds, false, camera);
          if (this.hasDetailedPresentation()) {
            this.scheduleUniversalVegetation(map, camera);
          }
        }
        this.onCameraChange?.(camera);
      },
      onCamera: (camera) => this.telemetry.setCamera(camera),
      onViewportChange: this.onViewportChange,
      onStreamCamera: (camera) => {
        this.streamer?.updateCamera(camera);
        for (const adapter of this.adapters) adapter.updateCameraWindow?.();
        this.projectionDirty = true;
      },
      onMotionChange: (moving) => {
        if (this.rendererMode !== 'universal_lowpoly') return;
        this.cameraMoving = moving;
        if (moving) {
          this.streamer?.beginCameraMove();
          this.streamerCameraMoveActive = true;
          this.mapGpuFrameTimer?.resetFrameIntervals?.();
        } else {
          this.settleRendererPerformanceIfIdle(map);
        }
        const nextPhase = moving
          ? 'camera_motion'
          : this.resolveUniversalRenderPhase(readMapCamera(map));
        this.applyUniversalRenderPhase(
          map,
          nextPhase,
        );
        if (!moving && this.streamerCameraMoveActive) {
          this.streamer?.endCameraMove(readMapCamera(map));
          this.streamerCameraMoveActive = false;
        }
      },
      onIdle: (camera) => {
        this.publishMapFeatures(map, camera);
        this.sampleProjection(this.dependencies.now(), true);
        if (this.rendererMode === 'universal_lowpoly') {
          this.refreshUniversalMaterialAtlasReadiness(map);
          this.applyUniversalAppearance(map, this.absolutePresentationSeconds, false, camera);
          if (this.hasDetailedPresentation()) {
            this.scheduleUniversalVegetation(map, camera);
          }
        }
        this.publishMapLifecycleReadiness(map, true);
      },
    });
    this.streamer?.updateCamera(this.targetCamera);
    this.telemetry.setCamera({
      current: readMapCamera(map),
      target: this.targetCamera,
      settled: !cameraChanged(readMapCamera(map), this.targetCamera),
    });
    this.setParts({ maplibre: true });
    this.publishReadiness();
    map.addControl(new NavigationControl({ showCompass: false }), 'bottom-right');

    const handleRender = () => {
      const nowMs = this.dependencies.now();
      this.recordMapRenderReadiness(map);
      if (this.onMapFeatures && nowMs - this.lastMapFeatureScanMs > 2_000 && map.isStyleLoaded()) {
        this.publishMapFeatures(map, readMapCamera(map));
      }
      this.sampleRendererPerformance(map, nowMs);
      this.sampleProjection(nowMs);
      if (nowMs - this.lastReadinessMs >= 1_000) this.publishReadiness(nowMs);
      this.frameScheduler?.recordRender(nowMs);
      this.telemetry.recordRender(nowMs);
    };
    const handleError = (event: MapLibreErrorEvent) => {
      if (!this.isActiveMap(map)) return;
      const message = String(event.error?.message ?? '');
      if (!/style|source|tile|network|fetch|failed|404|403/i.test(message)) return;
      this.providerErrors += 1;
      this.root.dataset.mapProviderErrorCount = String(this.providerErrors);
      this.root.dataset.mapProviderLastError = message || 'unknown_map_provider_error';
      if (this.rendererMode === 'universal_lowpoly') {
        if (this.isUniversalBuildingError(event, message)) {
          this.applyOpenMapTilesBuildingFallback(map, message || 'overture_runtime_error');
        }
        // Building and tile failures are degradations of a retained MapLibre
        // surface. They must be visible before load, but never destroy canvas.
        this.onSourceState('online_degraded');
        return;
      }
      if (this.loaded) {
        if (this.mapProvider === 'openfreemap') this.onSourceState('online_degraded');
        else this.switchToFallback();
      }
    };
    const handleLoad = () => this.handleMapLoad(map);
    const handleStyleLoad = () => {
      if (!this.isActiveMap(map) || this.rendererMode !== 'universal_lowpoly') return;
      this.appliedUniversalSourceTileLod = null;
      this.vegetationStyleEpoch += 1;
      this.vegetationCacheKey = null;
      this.styleController?.apply();
      this.setHighlightedBuilding(this.highlightedBuildingId);
      this.applyUniversalRenderPhase(map, this.resolveUniversalRenderPhase(readMapCamera(map)), true);
      this.applyPerformanceGovernorFeatureVisibility(map);
      this.refreshUniversalMaterialAtlasReadiness(map);
      this.applyUniversalAppearance(map, this.absolutePresentationSeconds, true, readMapCamera(map));
      if (this.hasDetailedPresentation()) {
        this.scheduleUniversalVegetation(map, readMapCamera(map), true);
      }
    };
    map.on('render', handleRender);
    const handleSourceWork = () => this.publishMapLifecycleReadiness(map, false);
    map.on('dataloading', handleSourceWork);
    map.on('sourcedata', handleSourceWork);
    map.on('error', handleError);
    map.on('load', handleLoad);
    map.on('style.load', handleStyleLoad);
    this.mapListenerDisposers.push(
      () => map.off('render', handleRender),
      () => map.off('dataloading', handleSourceWork),
      () => map.off('sourcedata', handleSourceWork),
      () => map.off('error', handleError),
      () => map.off('load', handleLoad),
      () => map.off('style.load', handleStyleLoad),
    );
    this.loadTimer = this.dependencies.setTimeout(() => {
      if (this.rendererMode === 'universal_lowpoly') {
        this.loadTimer = undefined;
        this.providerErrors += 1;
        this.root.dataset.mapProviderErrorCount = String(this.providerErrors);
        this.root.dataset.mapProviderLastError = 'MAP_LOAD_DEADLINE_EXCEEDED';
        this.root.dataset.mapLoadDeadlineExceeded = 'true';
        this.applyOpenMapTilesBuildingFallback(map, 'MAP_LOAD_DEADLINE_EXCEEDED');
        this.onSourceState('online_degraded');
        return;
      }
      this.switchToFallback();
    }, 10_000);
  }

  private isUniversalBuildingError(event: MapLibreErrorEvent, message: string): boolean {
    const sourceId = (event as unknown as { sourceId?: unknown }).sourceId;
    return sourceId === UNIVERSAL_BUILDING_SOURCE_ID
      || /omnitwin-pmtiles|overture(?:maps)?|buildings\.pmtiles/i.test(message);
  }

  /** Public MapLibre lifecycle facts, not the throttled diagnostic FPS counter. */
  private publishMapLifecycleReadiness(map: MapLibreMap, idle: boolean): void {
    if (!this.isActiveMap(map)) return;
    this.root.dataset.mapIdle = String(idle);
    try {
      this.root.dataset.mapTilesLoaded = String(map.areTilesLoaded());
    } catch {
      this.root.dataset.mapTilesLoaded = 'unknown';
    }
  }

  private recordMapRenderReadiness(map: MapLibreMap): void {
    if (!this.isActiveMap(map)) return;
    // Every real render advances this value immediately. TelemetryBus otherwise
    // flushes at 1 Hz, too slowly to establish an 800 ms paused quiet window.
    this.root.dataset.mapRenderRevision = String(++this.mapRenderRevision);
    this.root.dataset.mapIdle = 'false';
    // Source/idle events refresh areTilesLoaded; do not scan tile caches on
    // every animation frame just to publish this lightweight revision.
  }

  private applyOpenMapTilesBuildingFallback(map: MapLibreMap, reason: string): void {
    if (
      !this.isActiveMap(map)
      || this.universalBuildingFallbackApplied
      || !this.universalFallbackStyle
    ) return;
    this.universalBuildingFallbackApplied = true;
    this.universalPmtilesProtocol?.dispose();
    this.universalPmtilesProtocol = null;
    this.universalMaterialAtlasReady = false;
    this.publishUniversalDecorationTelemetry();
    map.setStyle(this.universalFallbackStyle);
    this.updateBuildingSourceSelection(resolveBuildingSourceSelection({
      primary: OFFICIAL_OVERTURE_DEVELOPMENT_BUILDINGS_SOURCE,
      fallback: OPENMAPTILES_BUILDINGS_SOURCE,
      primaryState: 'unavailable',
      fallbackState: 'ready',
      primaryFailureReason: reason,
    }));
    this.telemetry.setMapProvider({ requested: this.mapProvider, status: 'ready' });
  }

  /** A bounded public-map snapshot for the standalone fictional presentation. */
  private publishMapFeatures(map: MapLibreMap, camera: WorldCamera): void {
    if (!this.onMapFeatures || !this.isActiveMap(map) || !map.getSource('openmaptiles')) return;
    this.lastMapFeatureScanMs = this.dependencies.now();
    try {
      const transportation = map.querySourceFeatures('openmaptiles', { sourceLayer: 'transportation' }).slice(0, 2_000);
      const layers = (BUILDING_PICK_LAYER_IDS as readonly string[]).filter((id) => map.getLayer(id));
      const buildings = layers.length ? map.queryRenderedFeatures(undefined, { layers }).slice(0, 1_500) : [];
      this.root.dataset.demoRenderedBuildings = String(buildings.length);
      this.root.dataset.demoBuildingLayers = JSON.stringify((map.getStyle().layers ?? []).filter((layer) => layers.includes(layer.id)));
      const canvas = map.getCanvas();
      const buildingCandidates: { id: string; kind: 'building'; x: number; y: number; onCanvas: boolean }[] = [];
      if (this.activeBuildingSource && buildings.length) {
        for (const vertical of [0.45, 0.6, 0.35, 0.72]) {
          for (const horizontal of [0.5, 0.4, 0.6, 0.3, 0.7]) {
            const x = Math.round(canvas.clientWidth * horizontal), y = Math.round(canvas.clientHeight * vertical);
            const feature = map.queryRenderedFeatures([x, y], { layers })[0];
            const selection = feature && resolveRendererBuildingSelection(this.activeBuildingSource, feature);
            if (selection && !buildingCandidates.some((item) => item.id === selection.canonicalId)) buildingCandidates.push({ id: selection.canonicalId, kind: 'building', x, y, onCanvas: true });
          }
          if (buildingCandidates.length >= 4) break;
        }
      }
      this.root.dataset.demoBuildingPickCandidates = JSON.stringify(buildingCandidates);
      const revision = [
        camera.longitude.toFixed(3), camera.latitude.toFixed(3), camera.zoom.toFixed(1),
        transportation.length, buildings.length,
        ...buildings.slice(0, 20).map((item) => item.id ?? item.properties?.id ?? ''),
      ].join(':');
      if (revision === this.mapFeatureRevision || (!transportation.length && !buildings.length)) return;
      this.mapFeatureRevision = revision;
      this.onMapFeatures({ transportation, buildings, buildingSource: this.activeBuildingSource, camera });
    } catch {
      // A source/style swap is transient; retain the last successfully loaded layout.
    }
  }

  private handleMapLoad(map: MapLibreMap): void {
    if (!this.isActiveMap(map) || this.loaded) return;
    this.loaded = true;
    this.setHighlightedBuilding(this.highlightedBuildingId);
    this.dependencies.clearTimeout(this.loadTimer);
    this.loadTimer = undefined;
    this.onSourceState(
      this.mapProvider === 'openfreemap'
        ? this.providerErrors > 0 ? 'online_degraded' : 'online'
        : 'local_scene_ready',
    );
    this.styleController?.apply();
    if (this.rendererMode === 'universal_lowpoly') {
      this.applyUniversalRenderPhase(map, this.resolveUniversalRenderPhase(readMapCamera(map)), true);
      this.applyPerformanceGovernorFeatureVisibility(map);
      this.refreshUniversalMaterialAtlasReadiness(map);
      this.applyUniversalAppearance(map, this.absolutePresentationSeconds, true);
      if (this.hasDetailedPresentation()) {
        this.scheduleUniversalVegetation(map, readMapCamera(map), true);
      }
    }
    this.sampleProjection(this.dependencies.now(), true);
    this.publishMapFeatures(map, readMapCamera(map));
    if (this.baseMapOnly) {
      this.telemetry.setContributionState({ count: 0, ready: 0, cameraOccluded: null });
      this.setReadiness({
        manifestVerified: false,
        cellsReady: false,
        contributionsReady: false,
        contributionDetailStatus: 'SCENE_DETAIL_UNAVAILABLE',
      });
      return;
    }
    void this.attachAdapters(map);
  }

  private async attachAdapters(map: MapLibreMap): Promise<void> {
    void this.dependencies.attachDeck(map, this.entities, this.selectedId, {
      maximumInstances: this.rendererMode === 'universal_lowpoly'
        ? universalInstanceCaps(this.decorationTier).maxAmbientInstances
        : dynamicInstanceCap(this.rendererQuality),
      // Deck 9's attribute-transition allocator is not safe for retained
      // external binary subarrays whose cohort length changes with camera-cell
      // culling (Chrome reports GL_INVALID_VALUE and the picking FBO is empty).
      // Worker snapshots remain event-driven; smooth uniform-time interpolation
      // will replace this only after it has its own fixed-capacity GPU buffer.
      gpuTransitionDurationMs: 0,
    })
      .then((adapter) => {
        if (!this.isActiveMap(map)) {
          adapter.dispose();
          return;
        }
        this.adapters.push(adapter);
        this.applySnapshotToAdapter(adapter);
        if (
          this.rendererMode === 'universal_lowpoly'
          && this.hasDetailedPresentation()
        ) {
          this.vegetationCacheKey = null;
          this.scheduleUniversalVegetation(map, readMapCamera(map), true);
        }
        this.setParts({ deck: true });
        this.telemetry.notifyAdaptersChanged();
        this.updateContinuousFrames();
        this.publishReadiness();
        this.frameScheduler?.invalidate('adapter');
      })
      .catch(() => {
        if (this.isActiveMap(map)) this.setParts({ deckFailed: true });
      });

    if (this.rendererMode === 'universal_lowpoly') {
      this.updateContinuousFrames();
      this.publishReadiness();
      return;
    }

    let adapter: ThreeLayerAdapter | null = null;
    try {
      adapter = await this.dependencies.createThree(
        map,
        this.entities,
        this.selectedId,
        this.rendererQuality,
        {
          cityRendererV2: this.cityRendererV2,
          initialScene: this.currentSnapshot,
        },
      );
      if (!this.isActiveMap(map)) {
        adapter.dispose();
        return;
      }
      map.addLayer(adapter.layer);
      this.adapters.push(adapter);
      this.applySnapshotToAdapter(adapter);
      this.setParts({ three: true });
      this.telemetry.notifyAdaptersChanged();
      this.updateContinuousFrames();
      this.publishReadiness();
      this.frameScheduler?.invalidate('adapter');
    } catch {
      adapter?.dispose();
      if (this.isActiveMap(map)) this.setParts({ threeFailed: true });
    }
  }

  private updateContinuousFrames(): void {
    const scheduler = this.frameScheduler;
    if (!scheduler) return;
    const clock = this.presentationClock;
    const timelinePlaying = Boolean(
      clock && !clock.paused && !this.reducedMotion
      && clock.baseRateSecondsPerWallSecond * clock.speedMultiplier > 0,
    );
    const dynamicLayersActive = this.activeLayers.has('agents')
      || this.activeLayers.has('population')
      || this.activeLayers.has('movement');
    const renderableDeckEntities =
      (this.currentSnapshot.living?.telemetry.primaryRenderer.deck ?? 0) > 0
      || (this.currentSnapshot.aggregateRoadFlows?.segments.length ?? 0) > 0;
    scheduler.setVisible(typeof document === 'undefined' || !document.hidden);
    scheduler.setReasonActive('performance', this.performanceMode && timelinePlaying);
    scheduler.setReasonActive(
      'timeline',
      this.rendererMode === 'universal_lowpoly'
        ? timelinePlaying && dynamicLayersActive && this.parts.deck && renderableDeckEntities
        : this.cityRendererV2 && !this.reducedMotion,
    );
    scheduler.setReasonActive(
      'adapter',
      this.rendererMode === 'legacy_scene_debug'
        && this.adapters.some((adapter) => Boolean(adapter.frame)),
    );
    this.publishFrameSchedulerState();
  }

  private rebuildLivingPipeline(snapshot: RendererSceneSnapshot, force = false): void {
    const livingBudget = this.rendererMode === 'universal_lowpoly'
      ? applyLivingVisualBudget({
          entities: snapshot.entities,
          // Local focus-sample movement is deliberately not VisualEntityV2.
          // Align each source below after the shared visual cap has selected IDs.
          entitiesV2: snapshot.mobilityPresentationMovement?.length
            ? undefined
            : runtimeMovementEntitiesV2(snapshot),
          selectedId: snapshot.selectedId,
          tier: this.decorationTier,
          focusCapPolicy: snapshot.mobilityPresentationMovement?.length ? 'bounded' : 'exempt',
          strictTierCaps: Boolean(snapshot.mobilityPresentationMovement?.length),
        })
      : null;
    const livingSnapshot: RendererSceneSnapshot = livingBudget
      ? (() => {
          if (!snapshot.mobilityPresentationMovement?.length) {
            return {
              ...snapshot,
              entities: livingBudget.entities,
              entitiesV2: livingBudget.entitiesV2,
            };
          }
          const retainedIds = new Set(livingBudget.entities.map(({ id }) => id));
          return {
            ...snapshot,
            entities: livingBudget.entities,
            entitiesV2: runtimeMovementEntitiesV2(snapshot).filter(({ id }) => retainedIds.has(id)),
            mobilityPresentationMovement: snapshot.mobilityPresentationMovement.filter(
              ({ id }) => retainedIds.has(id),
            ),
          };
        })()
      : snapshot;
    if (livingBudget) this.publishLivingVisualBudget(livingBudget);
    const semanticKey = livingPartitionSemanticKey(livingSnapshot);
    if (!force && semanticKey === this.livingPartitionKey && this.livingPipeline) return;
    const origin = [livingSnapshot.camera.longitude, livingSnapshot.camera.latitude] as const;
    const cityPayload = livingSnapshot.scenePack?.cityPayload ?? null;
    const presentationTimeSeconds = presentationAnchorSeconds(
      livingSnapshot.presentationClock,
      cityPayload?.presentationTimeIso,
      livingSnapshot.presentationMinutes,
    );
    const movement = this.performanceMode
      ? {
          compiled: createLivingPerformanceMovementFixture(livingSnapshot.entities),
          telemetry: {
            status: 'ready' as const,
            routedEntities: livingSnapshot.entities.length,
            unboundEntities: 0,
            violations: 0,
            reason: null,
          },
        }
      : compileRuntimeSceneMovement(
          origin,
          livingSnapshot.presentationMovement ?? cityPayload?.movement ?? null,
          livingSnapshot.entities,
          runtimeMovementEntitiesV2(livingSnapshot),
          presentationTimeSeconds,
          this.movementMergeConflicts,
          livingSnapshot.mobilityPresentationMovement ?? [],
        );
    this.telemetry.setMovement(movement.telemetry);
    this.movementReadinessStatus = movement.telemetry.status;
    const governed = this.performanceGovernor?.snapshot;
    const basePartitionCaps = livingBudget?.partitionCaps;
    const partitionCaps: Readonly<LivingDeviceCaps> | undefined = basePartitionCaps
      ? Object.freeze({
          ...basePartitionCaps,
          maxDetailedPedestrians: Math.min(
            basePartitionCaps.maxDetailedPedestrians,
            governed?.nearPeopleCap ?? basePartitionCaps.maxDetailedPedestrians,
          ),
          maxDetailedVehicles: Math.min(
            basePartitionCaps.maxDetailedVehicles,
            governed?.nearVehicleCap ?? basePartitionCaps.maxDetailedVehicles,
          ),
          maxDetailed: Math.min(
            basePartitionCaps.maxDetailed,
            (governed?.nearPeopleCap ?? basePartitionCaps.maxDetailedPedestrians)
              + (governed?.nearVehicleCap ?? basePartitionCaps.maxDetailedVehicles),
          ),
        })
      : undefined;
    const partitionOptions: CreateLivingPartitionOptions = {
      zoom: livingSnapshot.camera.zoom,
      origin,
      rendererPolicy: this.rendererMode === 'universal_lowpoly'
        ? 'deck_only'
        : 'legacy_split',
      screenSizePixels: projectedEntityScreenSizes(
        livingSnapshot.camera,
        livingSnapshot.entities,
      ),
      selectedId: livingSnapshot.selectedId,
      caps: partitionCaps,
      movementGraph: movement.compiled?.graph,
      routeIdByEntityId: movement.compiled?.routeIdByEntityId,
      routePhaseByEntityId: movement.compiled?.routePhaseByEntityId,
      activitySchedule: runtimeLivingActivitySchedule(livingSnapshot),
    };
    const simulationOptions = {
      presentationTimeSeconds,
      reducedMotion: livingSnapshot.reducedMotion,
    };
    if (!this.livingPipeline) {
      this.livingPipeline = createLivingWorldPipeline(
        livingSnapshot.entities,
        partitionOptions,
        undefined,
        simulationOptions,
      );
    } else {
      this.livingPipeline.replace(livingSnapshot.entities, partitionOptions, simulationOptions);
    }
    const partition = this.livingPipeline.simulation().partition;
    this.livingUsesNearCadence = false;
    for (let index = 0; index < partition.count; index += 1) {
      if (
        partition.presentation.visible[index] !== 0
        && partition.presentation.lod[index]! >= LivingLod.DETAILED
      ) {
        this.livingUsesNearCadence = true;
        break;
      }
    }
    this.publishLivingWorkerCadence();
    this.livingPartitionKey = semanticKey;
    this.livingPartitionReplacements += 1;
    this.publishLivingLifecycle();
    this.updateLivingSnapshot();
    this.installLivingController();
  }

  private publishLivingVisualBudget(budget: LivingVisualBudgetResult): void {
    this.root.dataset.livingBudgetInputEntities = String(budget.input.total);
    this.root.dataset.livingBudgetRetainedEntities = String(budget.retained.total);
    this.root.dataset.livingBudgetOmittedEntities = String(budget.omitted.total);
    this.root.dataset.livingBudgetOmittedRepresented = String(
      budget.omitted.representedPopulation,
    );
    this.root.dataset.livingBudgetCapExemptEntities = String(budget.capExemptRetained.total);
    this.root.dataset.livingBudgetPeopleCap = String(budget.limits.people);
    this.root.dataset.livingBudgetVehicleCap = String(budget.limits.vehicles);
  }

  private installLivingController(): void {
    if (this.activeLivingSeek) this.pendingLivingSeek = this.activeLivingSeek;
    this.activeLivingSeek = null;
    const previousController = this.livingController;
    this.resetLivingFrameInterpolation(previousController);
    previousController?.dispose();
    this.livingController = null;
    this.lastWorkerSubmitMs = Number.NEGATIVE_INFINITY;
    this.lastWorkerRequestedSeconds = null;
    const pipeline = this.livingPipeline;
    if (!pipeline) {
      this.telemetry.setLivingWorker(null);
      return;
    }
    this.livingWorkerFailed = false;
    const controller = this.dependencies.createLivingController(pipeline.simulation());
    this.livingController = controller;
    this.setParts({ livingWorkerFallback: controller.telemetry().mode === 'inline_fallback' });
    this.livingWorkerGeneration += 1;
    this.publishLivingLifecycle();
    this.telemetry.setLivingWorker(controller.telemetry());
    void controller.ready.then((response) => {
      if (this.disposed || this.livingController !== controller) return;
      this.applyLivingWorkerFrame(response);
      this.telemetry.setLivingWorker(controller.telemetry());
    }).catch((error: unknown) => this.handleLivingWorkerFailure(controller, error));
    this.dispatchLivingSeek();
  }

  private requestLivingWorkerFrame(frame: RendererFrameContext): void {
    const controller = this.livingController;
    if (!controller || this.disposed) return;
    if (this.activeLivingSeek || this.pendingLivingSeek) return;
    const governor = this.performanceGovernor?.snapshot;
    const updateHz = this.livingUsesNearCadence
      ? governor?.nearUpdateHz ?? 10
      : governor?.midUpdateHz ?? 2;
    if (!livingFrameAdvanceDue({ paused: frame.paused, presentationSeconds: frame.absolutePresentationSeconds,
      previousRequestedSeconds: this.lastWorkerRequestedSeconds, nowMs: frame.nowMs,
      previousSubmitMs: this.lastWorkerSubmitMs, updateHz })) return;
    this.lastWorkerSubmitMs = frame.nowMs;
    this.lastWorkerRequestedSeconds = frame.absolutePresentationSeconds;
    void controller.advanceTo(
      frame.absolutePresentationSeconds,
      frame.reducedMotion,
    ).then((result) => {
      if (this.disposed || this.livingController !== controller) return;
      if (result.status === 'processed') this.applyLivingWorkerFrame(result.value);
      this.telemetry.setLivingWorker(controller.telemetry());
    }).catch((error: unknown) => this.handleLivingWorkerFailure(controller, error));
    this.telemetry.setLivingWorker(controller.telemetry());
  }

  private queueLivingSeek(seek: PendingLivingSeek): void {
    this.resetLivingFrameInterpolation();
    this.pendingLivingSeek = seek;
    this.dispatchLivingSeek();
  }

  private dispatchLivingSeek(): void {
    const controller = this.livingController;
    const seek = this.pendingLivingSeek;
    if (!controller || !seek || this.activeLivingSeek || this.disposed) return;
    this.pendingLivingSeek = null;
    this.activeLivingSeek = seek;
    this.lastWorkerRequestedSeconds = seek.presentationTimeSeconds;
    void controller.seek(
      seek.presentationTimeSeconds,
      seek.reducedMotion,
    ).then((result) => {
      if (this.disposed || this.livingController !== controller) return;
      if (result.status !== 'processed') {
        throw new Error(`living_seek_${result.status}`);
      }
      if (this.activeLivingSeek?.revision !== seek.revision) {
        throw new Error('living_seek_revision_mismatch');
      }
      this.applyLivingWorkerFrame(result.value);
      this.appliedSeekRevision = seek.revision;
      this.activeLivingSeek = null;
      this.telemetry.setLivingWorker(controller.telemetry());
      this.publishLivingLifecycle();
      this.dispatchLivingSeek();
    }).catch((error: unknown) => {
      if (this.livingController === controller) this.activeLivingSeek = null;
      this.handleLivingWorkerFailure(controller, error);
    });
    this.telemetry.setLivingWorker(controller.telemetry());
  }

  private publishLivingLifecycle(): void {
    this.telemetry.setLivingLifecycle({
      partitionReplacements: this.livingPartitionReplacements,
      workerGeneration: this.livingWorkerGeneration,
      requestedSeekRevision: this.requestedSeekRevision,
      appliedSeekRevision: this.appliedSeekRevision,
    });
  }

  private publishLivingWorkerCadence(): void {
    const snapshot = this.performanceGovernor?.snapshot;
    this.root.dataset.livingWorkerCadence = this.livingUsesNearCadence ? 'near' : 'mid';
    this.root.dataset.livingWorkerTargetHz = String(
      this.livingUsesNearCadence
        ? snapshot?.nearUpdateHz ?? 10
        : snapshot?.midUpdateHz ?? 2,
    );
  }

  private applyLivingWorkerFrame(response: LivingWorkerFrameResponse): void {
    const pipeline = this.livingPipeline;
    if (!pipeline) return;
    if (!isValidatedLivingWorkerFrameResponse(response)) {
      assertLivingWorkerFrameResponse(response, pipeline.simulation().partition.count);
    }
    const presentationTimeSeconds = response.telemetry.presentationTimeSeconds;
    const oldPair = this.livingRenderFramePair;
    const previous = this.latestLivingWorkerFrame;
    const matchingBuffers = previous
      && previous.frame.x.length === response.frame.x.length
      && previous.frame.y.length === response.frame.y.length
      && previous.frame.heading.length === response.frame.heading.length
      && previous.frame.activity.length === response.frame.activity.length;
    this.livingRenderFramePair = previous
      && matchingBuffers
      && presentationTimeSeconds > previous.presentationTimeSeconds
      ? {
          previous: previous.frame,
          previousPresentationTimeSeconds: previous.presentationTimeSeconds,
          current: response.frame,
          currentPresentationTimeSeconds: presentationTimeSeconds,
        }
      : null;
    this.latestLivingWorkerFrame = { frame: response.frame, presentationTimeSeconds };
    // Universal Deck retains the worker pair on GPU and changes only a time
    // uniform while MapLibre is already rendering. The CPU interpolation
    // buffer remains a legacy Three/debug compatibility path.
    if (
      this.rendererMode === 'legacy_scene_debug'
      && (
        !this.livingRenderFrameBuffer
        || this.livingRenderFrameBuffer.x.length !== response.frame.x.length
      )
    ) this.livingRenderFrameBuffer = createLivingRenderFrameBuffer(response.frame.x.length);
    // The persistent worker already publishes the dynamic activity/hash QA.
    // Re-scanning all activity columns here would duplicate its 10 Hz work.
    const telemetry = response.telemetry;
    const living = {
      partition: pipeline.simulation().partition,
      frame: response.frame,
      telemetry,
      individualActorsEnabled:
        this.performanceGovernor?.snapshot.individualActorsEnabled ?? true,
      ...(this.rendererMode === 'universal_lowpoly'
        ? { gpuInterpolationPair: this.livingRenderFramePair }
        : {}),
    };
    this.refreshLivingEntityViews(living.partition, living.frame);
    this.currentSnapshot = { ...this.currentSnapshot, living };
    this.telemetry.setLiving(telemetry);
    for (const adapter of this.adapters) adapter.updateLiving?.(living, this.selectedId);
    if (this.presentationClock?.paused) this.frameScheduler?.invalidate();
    this.reconcileLivingAdapters();
    const retainedFrames = new Set<LivingRenderFrame>([response.frame]);
    if (this.livingRenderFramePair) {
      retainedFrames.add(this.livingRenderFramePair.previous);
      retainedFrames.add(this.livingRenderFramePair.current);
    }
    const retiredFrames = new Set<LivingRenderFrame>();
    if (oldPair) {
      retiredFrames.add(oldPair.previous);
      retiredFrames.add(oldPair.current);
    }
    if (previous) retiredFrames.add(previous.frame);
    for (const retired of retiredFrames) {
      if (!retainedFrames.has(retired)) this.livingController?.releaseFrame(retired);
    }
  }

  private applyLivingFrameInterpolation(frame: RendererFrameContext): void {
    const pair = this.livingRenderFramePair;
    const output = this.livingRenderFrameBuffer;
    const current = this.currentSnapshot.living;
    if (!pair || !output || !current) return;
    const pairDuration = pair.currentPresentationTimeSeconds
      - pair.previousPresentationTimeSeconds;
    const targetPresentationTimeSeconds = frame.paused || frame.reducedMotion
      ? frame.absolutePresentationSeconds
      : frame.absolutePresentationSeconds - pairDuration;
    const interpolated = interpolateLivingRenderFramePair(
      pair,
      targetPresentationTimeSeconds,
      output,
      current.partition.activitySchedule,
    );
    const telemetry = {
      ...current.telemetry,
      activity: livingActivityQaSnapshot(
        current.partition,
        interpolated,
        targetPresentationTimeSeconds,
      ),
      presentationTimeSeconds: targetPresentationTimeSeconds,
    };
    const living = { ...current, frame: interpolated, telemetry };
    this.refreshLivingEntityViews(living.partition, living.frame);
    this.currentSnapshot = { ...this.currentSnapshot, living };
    this.telemetry.setLiving(telemetry);
    for (const adapter of this.adapters) adapter.updateLiving?.(living, this.selectedId);
  }

  private resetLivingFrameInterpolation(
    controller: LivingSimulationController | null = this.livingController,
  ): void {
    if (controller) {
      // A seek keeps the currently published snapshot readable until the
      // replacement arrives. Recycling that exact frame would transfer and
      // detach its arrays while click/picking code can still observe it.
      const publishedFrame = this.currentSnapshot.living?.frame ?? null;
      const frames = new Set<LivingRenderFrame>();
      if (this.latestLivingWorkerFrame) frames.add(this.latestLivingWorkerFrame.frame);
      if (this.livingRenderFramePair) {
        frames.add(this.livingRenderFramePair.previous);
        frames.add(this.livingRenderFramePair.current);
      }
      for (const frame of frames) {
        if (frame !== publishedFrame) controller.releaseFrame(frame);
      }
    }
    this.latestLivingWorkerFrame = null;
    this.livingRenderFramePair = null;
    this.livingRenderFrameBuffer = null;
  }

  private handleLivingWorkerFailure(
    controller: LivingSimulationController,
    error: unknown,
  ): void {
    if (this.disposed || this.livingController !== controller) return;
    const message = error instanceof Error ? error.message : 'living_worker_runtime_failure';
    this.livingWorkerFailed = true;
    this.telemetry.setLivingWorker(controller.telemetry(), message);
    this.setParts({ deckFailed: true, threeFailed: true });
    this.setReadiness({ contributionsReady: false });
  }

  private updateLivingSnapshot(): void {
    const pipeline = this.livingPipeline;
    if (!pipeline) {
      this.currentSnapshot = { ...this.currentSnapshot, living: null };
      this.livingEntityViews = null;
      this.publishedSelectedView = null;
      this.publishedSelectedActivity = null;
      this.telemetry.setLiving(null);
      return;
    }
    const living = {
      partition: pipeline.simulation().partition,
      frame: pipeline.snapshot(),
      telemetry: pipeline.telemetry(),
      individualActorsEnabled:
        this.performanceGovernor?.snapshot.individualActorsEnabled ?? true,
    };
    this.refreshLivingEntityViews(living.partition, living.frame);
    this.currentSnapshot = { ...this.currentSnapshot, living };
    this.telemetry.setLiving(living.telemetry);
  }

  private retainSelectedEntity(entity: VisualEntity | null): void {
    this.publishedSelectedView = entity;
    this.publishedSelectedActivity = entity?.activity ?? null;
  }

  /** Only InteractionController gestures may notify the owning UI of a pick. */
  private readonly publishSelectedEntity = (entity: VisualEntity | null): void => {
    this.retainSelectedEntity(entity);
    this.onSelect?.(entity);
  };

  private notifySelectedLivingEntity(refreshCurrentView = true): void {
    if (!this.selectedId) {
      this.publishedSelectedView = null;
      this.publishedSelectedActivity = null;
      return;
    }
    const entity = this.rendererMode === 'universal_lowpoly' && refreshCurrentView
      ? this.refreshLivingEntityViewById(this.selectedId)
      : this.livingEntityViews?.byId.get(this.selectedId) ?? null;
    if (!entity) return;
    if (entity !== this.publishedSelectedView
      || entity.activity !== this.publishedSelectedActivity) {
      // Worker activity and membership replacement keep the selected view
      // current; they must not replay a click and reopen a collapsed inspector.
      this.retainSelectedEntity(entity);
    }
  }

  private refreshLivingEntityViews(
    partition: ReturnType<LivingWorldPipeline['simulation']>['partition'],
    frame: LivingRenderFrame,
  ): void {
    if (!this.livingEntityViews || this.livingEntityViews.partition !== partition) {
      this.livingEntityViews = createRetainedLivingEntityViews(partition, frame);
    } else if (this.rendererMode === 'legacy_scene_debug') {
      updateRetainedLivingEntityViews(this.livingEntityViews, partition, frame);
    } else if (this.selectedId) {
      updateRetainedLivingEntityView(
        this.livingEntityViews,
        partition,
        frame,
        this.selectedId,
      );
    }
    this.projectionDirty = true;
    this.notifySelectedLivingEntity(false);
  }

  /**
   * Universal deck rendering consumes the binary SoA frame directly. Keep the
   * object view cold and materialize only the row needed by selection/picking.
   */
  private refreshLivingEntityViewById(id: string): VisualEntity | null {
    const retained = this.livingEntityViews;
    const living = this.currentSnapshot.living;
    if (!retained || !living || retained.partition !== living.partition) {
      return retained?.byId.get(id) ?? null;
    }
    return updateRetainedLivingEntityView(retained, living.partition, living.frame, id);
  }

  private applySnapshotToAdapter(adapter: RendererAdapter): void {
    adapter.updateAggregateRoadFlows?.(this.currentSnapshot.aggregateRoadFlows ?? null);
    if (this.cityRendererV2) adapter.updateScene?.(this.currentSnapshot);
    const living = this.cityRendererV2 ? this.currentSnapshot.living : null;
    if (living && adapter.updateLiving) {
      adapter.updateLiving(living, this.selectedId);
      this.reconcileLivingAdapters();
      return;
    }
    if (living && !adapter.updateScene) {
      adapter.update(
        livingFrameToVisualEntities(living.partition, living.frame, adapter.kind),
        this.selectedId,
      );
      this.reconcileLivingAdapters();
      return;
    }
    if (adapter.updateScene) return;
    adapter.update(this.entities, this.selectedId);
    this.reconcileLivingAdapters();
  }

  private withVerifiedManifest(
    scenePack: WorldScenePackBinding | null,
  ): WorldScenePackBinding | null {
    if (
      !scenePack ||
      scenePack.sourceDetailStatus !== 'available' ||
      !this.verifiedManifest ||
      sceneBindingIdentity(scenePack) !== this.verifiedManifest.bindingIdentity
    ) return scenePack;
    if (scenePack.manifest === this.verifiedManifest.value) return scenePack;
    return { ...scenePack, manifest: this.verifiedManifest.value };
  }

  /**
   * Clock/settings renders may resend the immutable binding's bootstrap data.
   * Once cells have streamed, the runtime-owned composition is authoritative
   * until the binding identity changes or a newer stream composition replaces it.
   */
  private withRuntimeCityPayload(
    scenePack: WorldScenePackBinding | null,
  ): WorldScenePackBinding | null {
    const runtimePayload = this.runtimeCityPayload;
    if (
      !runtimePayload
      || !scenePack
      || scenePack.sourceDetailStatus !== 'available'
      || sceneBindingIdentity(scenePack) !== runtimePayload.bindingIdentity
    ) return scenePack;
    if (scenePack.cityPayload === runtimePayload.value) return scenePack;
    return { ...scenePack, cityPayload: runtimePayload.value };
  }

  private reconcileLivingAdapters(): void {
    const pipeline = this.livingPipeline;
    if (!pipeline) {
      this.telemetry.setLivingReconciliation(null);
      return;
    }
    const deckTelemetry = this.adapters.find((adapter) => adapter.kind === 'deck')
      ?.telemetry();
    const deckIds = deckTelemetry?.submittedIds ?? [];
    const threeIds = this.adapters.find((adapter) => adapter.kind === 'three')
      ?.telemetry().submittedIds ?? [];
    this.telemetry.setLivingReconciliation(
      pipeline.reconcileAdapters({
        deckIds,
        threeIds,
        intentionalDeckOmissions: deckTelemetry?.livingSubmission
          ? deckTelemetry.livingSubmission.cameraCulled
            + deckTelemetry.livingSubmission.budgetCulled
          : 0,
      }),
    );
  }

  private updateStreamResources(
    resources: readonly SceneStreamResource<WorldSceneCellResource>[],
  ): void {
    if (this.disposed || this.fallback) return;
    const primary = resources.find(({ primary: isPrimary }) => isPrimary);
    const composedPlans = this.rendererMode === 'legacy_scene_debug'
      ? composeCityPlanCells(resources)
      : { planCells: [], conflicts: 0 };
    this.staticPlanMergeConflicts = composedPlans.conflicts;
    this.telemetry.setScenePlanConflicts(composedPlans.conflicts);
    if (this.rendererMode === 'legacy_scene_debug') {
      this.styleController?.setDetailedBuildingFootprintBounds(
        resources.flatMap(({ resource }) => (
          resource.descriptor
            && resource.cityPayload?.plan
            && resource.cityPayload.plan.fieldProvenance.geometry === 'source_geometry'
            && resource.cityPayload.plan.buildings.length > 0
            ? [resource.descriptor.bbox]
            : []
        )),
      );
    }
    const exactHintKeys = new Set(
      this.sceneCellHints
        .map((cellId) => sceneCellFromHint(cellId)?.key ?? null)
        .filter((key): key is string => key !== null),
    );
    const exactHintResources = resources.filter(
      ({ cell, primary: isPrimary }) => !isPrimary && exactHintKeys.has(cell.key),
    );
    // Legacy rendering is primary-strict. Universal rendering composes the
    // primary graph with exact LivingCellSlice hints, or uses those hints as a
    // bounded fallback when primary is unavailable. Speculative halo cells are
    // never promoted to a movement authority.
    const movementResources = this.rendererMode === 'legacy_scene_debug'
      ? primary ? [primary] : []
      : primary ? [primary, ...exactHintResources] : exactHintResources;
    const payloads = movementResources
      .map(({ resource }) => resource.cityPayload?.movement ?? null)
      .filter((payload): payload is NonNullable<typeof payload> => payload !== null);
    const mergedMovement = mergeSceneMovementPayloads(payloads);
    const carrier = primary?.resource.cityPayload
      ? primary.resource
      : movementResources.find(({ resource }) => resource.cityPayload !== null)?.resource ?? null;
    const entitiesById = new Map<string, VisualEntityV2>();
    let entityConflicts = 0;
    // Exact-hint cells provide only their verified route graph. They must not
    // silently widen the primary cell's privacy-scoped entity projection.
    for (const { resource } of primary ? [primary] : []) {
      for (const entity of resource.cityPayload?.entitiesV2 ?? []) {
        const previous = entitiesById.get(entity.id);
        if (previous && JSON.stringify(previous) !== JSON.stringify(entity)) entityConflicts += 1;
        else if (!previous) entitiesById.set(entity.id, entity);
      }
    }
    this.movementMergeConflicts = mergedMovement.conflicts + entityConflicts;
    const trustedMovement = this.movementMergeConflicts === 0
      ? mergedMovement.payload
      : null;
    const bindingIdentity = sceneBindingIdentity(this.scenePack);
    if (!bindingIdentity || this.scenePack?.sourceDetailStatus !== 'available') {
      this.onVerifiedMovementChange?.(null);
      return;
    }
    this.onVerifiedMovementChange?.(trustedMovement);
    if (!carrier?.cityPayload) {
      if (this.runtimeCityPayload) {
        this.runtimeCityPayload = null;
        this.activeCellResource = null;
        this.scenePack = { ...this.scenePack, cityPayload: null };
        this.currentSnapshot = { ...this.currentSnapshot, scenePack: this.scenePack };
        this.rebuildLivingPipeline(this.currentSnapshot, true);
        for (const adapter of this.adapters) this.applySnapshotToAdapter(adapter);
      }
      return;
    }
    const primaryPayload = primary?.resource.cityPayload ?? null;
    const cityPayload: WorldSceneCityPayload = {
      ...carrier.cityPayload,
      // Universal mode consumes scene cells only as an optional movement,
      // entity and environment stream. Static city geometry remains owned by
      // streamed MapLibre tiles and is never retained as a hidden diorama.
      plan: !primaryPayload || this.rendererMode === 'universal_lowpoly'
        ? null
        : primaryPayload.plan,
      environment: primaryPayload?.environment ?? null,
      movement: trustedMovement,
      entitiesV2: primaryPayload ? [...entitiesById.values()] : [],
      weatherSample: primaryPayload?.weatherSample ?? null,
      weatherCyclePlayback: primaryPayload?.weatherCyclePlayback ?? null,
      planCells: !primaryPayload || this.rendererMode === 'universal_lowpoly'
        ? undefined
        : composedPlans.planCells,
    };
    this.runtimeCityPayload = { bindingIdentity, value: cityPayload };
    this.activeCellResource = primary?.resource ?? null;
    this.scenePack = { ...this.scenePack, cityPayload };
    this.currentSnapshot = { ...this.currentSnapshot, scenePack: this.scenePack };
    this.rebuildLivingPipeline(this.currentSnapshot, true);
    for (const adapter of this.adapters) this.applySnapshotToAdapter(adapter);
  }

  private publishReadiness(nowMs = this.dependencies.now()): void {
    this.lastReadinessMs = nowMs;
    const contributionTelemetry = this.adapters.flatMap(
      (adapter) => adapter.telemetry().contributions ?? [],
    );
    const cameraOcclusion = contributionTelemetry
      .map((contribution) => contribution.cameraOccluded)
      .filter((value): value is boolean => typeof value === 'boolean');
    const ready = contributionTelemetry.filter((contribution) => contribution.ready).length;
    const reportedDetailStatus = contributionTelemetry.length === 0
      ? null
      : contributionTelemetry.some(
          (contribution) => contribution.sceneDetailStatus === 'SCENE_DETAIL_UNAVAILABLE',
        )
        ? 'SCENE_DETAIL_UNAVAILABLE' as const
        : contributionTelemetry.every(
            (contribution) => contribution.sceneDetailStatus === 'SCENE_DETAIL_READY',
          )
          ? 'SCENE_DETAIL_READY' as const
          : 'SCENE_DETAIL_PARTIAL' as const;
    const universalMapOwnsBuildings = this.rendererMode === 'universal_lowpoly';
    const buildingContribution = universalMapOwnsBuildings
      ? undefined
      : contributionTelemetry.find(
          (contribution) => contribution.id === 'living-city'
            || contribution.detailedBuildingGeometryReady !== undefined,
        );
    const buildingGeometryAttested = universalMapOwnsBuildings || !buildingContribution
      || buildingContribution.detailedBuildingGeometryReady !== undefined;
    const buildingGeometryReady = !universalMapOwnsBuildings
      && buildingContribution?.detailedBuildingGeometryReady === true;
    if (!universalMapOwnsBuildings) {
      this.styleController?.setDetailedBuildingOwner(
        buildingGeometryReady ? 'three' : 'maplibre',
      );
    }
    const ownership = universalMapOwnsBuildings
      ? null
      : this.styleController?.ownershipSnapshot();
    const mapLibreExtrusionsAbsent = this.mapProvider === 'scene_only';
    const buildingOwnershipReady = !buildingGeometryReady || Boolean(
      ownership?.detailedBuildingOwner === 'three' &&
      (mapLibreExtrusionsAbsent || ownership.mapLibreBuildingExtrusionsMasked) &&
      !ownership.ownershipConflict
    );
    const buildingGatedDetailStatus = reportedDetailStatus === 'SCENE_DETAIL_READY' && (
      !buildingGeometryAttested || !buildingOwnershipReady
    )
      ? 'SCENE_DETAIL_PARTIAL' as const
      : reportedDetailStatus;
    const movementRequired = this.rendererMode === 'legacy_scene_debug'
      && this.scenePack?.sourceDetailStatus === 'available'
      && this.scenePack.manifest?.capabilities.movementNetwork === true;
    const movementReady = !movementRequired || this.movementReadinessStatus === 'ready';
    const contributionDetailStatus = gateSceneDetailForMovement(
      buildingGatedDetailStatus,
      this.movementReadinessStatus,
      movementRequired,
    );
    this.telemetry.setContributionState({
      count: contributionTelemetry.length,
      ready,
      cameraOccluded: cameraOcclusion.length > 0 ? cameraOcclusion.some(Boolean) : null,
    });
    this.setReadiness({
      contributionsReady: this.rendererMode === 'universal_lowpoly'
        ? true
        : this.cityRendererV2
        ? contributionTelemetry.length > 0 &&
          ready === contributionTelemetry.length &&
          buildingGeometryAttested &&
          buildingOwnershipReady &&
          !this.livingWorkerFailed &&
          this.staticPlanMergeConflicts === 0 &&
          movementReady
        : true,
      contributionDetailStatus,
    });
  }

  private setReadiness(patch: Partial<SceneRuntimeReadiness>): void {
    const next = { ...this.readiness, ...patch };
    if (
      next.manifestVerified === this.readiness.manifestVerified &&
      next.cellsReady === this.readiness.cellsReady &&
      next.contributionsReady === this.readiness.contributionsReady
      && next.contributionDetailStatus === this.readiness.contributionDetailStatus
    ) return;
    this.readiness = next;
    this.onReadiness(next);
  }

  private sampleProjection(nowMs: number, force = false): void {
    const map = this.map;
    if (!map || !this.loaded) return;
    if (!force && !this.projectionDirty && nowMs - this.lastProjectionMs < 1_000) return;
    if (!force && nowMs - this.lastProjectionMs < 1_000) return;
    const entities = this.livingEntityViews?.entities ?? this.entities;
    this.telemetry.setProjectedEntities(projectedEntitySentinel(map, entities));
    const selectedEntity = this.selectedId
      ? this.livingEntityViews?.byId.get(this.selectedId)
        ?? this.entities.find((entity) => entity.id === this.selectedId)
      : undefined;
    this.telemetry.setSelectedEntityProjected(Boolean(
      selectedEntity && projectedVisualEntity(map, selectedEntity) === 1,
    ));
    this.lastProjectionMs = nowMs;
    this.projectionDirty = false;
  }

  private setParts(patch: Partial<RendererPartsState>): void {
    this.parts = { ...this.parts, ...patch };
    this.onPartsState(this.parts);
  }

  private universalQualityTier(): UniversalQualityTier {
    return this.decorationTier;
  }

  private refreshUniversalMaterialAtlasReadiness(map: MapLibreMap): void {
    let ready = false;
    try {
      ready = map.hasImage(universalMaterialImageId('ground-grass-day'));
    } catch {
      // A missing secondary sprite degrades decoration, never the retained basemap.
    }
    const changed = this.universalMaterialAtlasReady !== ready;
    this.universalMaterialAtlasReady = ready;
    if (changed) this.applyPerformanceGovernorFeatureVisibility(map);
    this.publishUniversalDecorationTelemetry();
  }

  private applyUniversalAppearance(
    map: MapLibreMap,
    absolutePresentationSeconds: number,
    force = false,
    camera: WorldCamera = this.currentSnapshot.camera,
  ): void {
    const minuteOfDay = presentationMinutesAt(absolutePresentationSeconds);
    const sunBucket = Math.floor(minuteOfDay / 15);
    const bucketMinutes = sunBucket * 15;
    // Demo controls express Chelyabinsk local wall time (UTC+5), on an
    // explicitly illustrative summer day independent of demographic year.
    const localOffsetMinutes = this.onMapFeatures ? 300 : 0;
    const presentationDate = new Date(Date.UTC(2025, 5, 21) + (bucketMinutes - localOffsetMinutes) * 60_000);
    const cycle = mapToEnvironmentCycle2025(
      presentationDate,
      this.scenePack?.sceneTimeZone ?? (this.onMapFeatures ? 'Asia/Yekaterinburg' : 'Europe/Moscow'),
    );
    const weatherMode = this.currentSnapshot.weatherVisualOverride
      ?? this.currentSnapshot.weather;
    const sample = createVisualWeatherSample(
      cycle,
      weatherMode,
      weatherMode === 'clear' ? 0 : 0.72,
      `universal:${weatherMode}`,
    );
    const sun = calculateSunLightState(
      cycle,
      camera.latitude,
      camera.longitude,
      sample.cloudCover,
    );
    const qualityTier = this.universalQualityTier();
    const weather = deriveWeatherUniforms(
      sample,
      sun,
      universalInstanceCaps(qualityTier).maxPrecipitationInstances,
      this.reducedMotion,
    );
    const next = createUniversalAppearanceFrame({
      zoom: camera.zoom,
      pitch: camera.pitch,
      presentationMinutes: bucketMinutes,
      qualityTier,
      sun,
      weather,
      reducedMotion: this.reducedMotion,
    });
    const diff = diffUniversalAppearanceFrames(
      force ? null : this.universalAppearanceFrame,
      next,
    );
    for (const command of diff.commands) {
      try {
        if (command.kind === 'set-light') {
          // MapLibre's intensity also suppresses the opposite-face ambient
          // term. A restrained direct light keeps warm walls readable.
          const light = this.onMapFeatures
            ? { ...command.value, intensity: Math.min(0.36, command.value.intensity) }
            : command.value;
          map.setLight(light as Parameters<MapLibreMap['setLight']>[0]);
          if (this.onMapFeatures) this.root.dataset.demoLight = JSON.stringify(light);
        } else if (command.kind === 'set-sky') {
          map.setSky(command.value);
        } else if (map.getLayer(command.layerId)) {
          map.setPaintProperty(
            command.layerId,
            command.property as never,
            command.value as never,
          );
        }
      } catch {
        // Unsupported sky/paint APIs or absent optional style layers must not remove the map.
      }
    }
    const previous = force ? null : this.universalAppearanceFrame;
    if (
      force
      || JSON.stringify(previous?.shadow ?? null) !== JSON.stringify(next.shadow)
    ) {
      UNIVERSAL_BUILDING_ACTIVE_SHADOW_LAYER_IDS.forEach((layerId) => {
        try {
          if (!map.getLayer(layerId)) return;
          const translation = next.shadow.bucketTranslations[0] ?? [0, 0];
          map.setPaintProperty(layerId, 'fill-translate', translation as never);
          map.setPaintProperty(
            layerId,
            'fill-opacity',
            next.shadow.mode === 'contact_ao_projected_flat'
              ? next.shadow.opacity
              : 0,
          );
        } catch {
          // Optional decoration layers may be unavailable while a style is replacing itself.
        }
      });
    }
    if (
      force
      || JSON.stringify(previous?.water ?? null) !== JSON.stringify(next.water)
    ) {
      try {
        if (map.getLayer(UNIVERSAL_WATER_GLOSS_LAYER_ID)) {
          if (!this.universalMaterialAtlasReady) {
            map.setPaintProperty(UNIVERSAL_WATER_GLOSS_LAYER_ID, 'fill-opacity', 0);
          } else {
            map.setPaintProperty(
              UNIVERSAL_WATER_GLOSS_LAYER_ID,
              'fill-pattern',
              universalMaterialImageId(next.water.patternId as UniversalMaterialImageKey),
            );
            map.setPaintProperty(
              UNIVERSAL_WATER_GLOSS_LAYER_ID,
              'fill-opacity',
              next.water.opacity,
            );
          }
        }
      } catch {
        // Missing sprites or pattern support degrade to the retained solid water layer.
      }
    }
    this.universalAppearanceFrame = next;
    this.root.dataset.universalAppearanceFrame = next.frameKey;
    this.root.dataset.universalAppearanceLod = next.semanticLod;
    this.root.dataset.universalSunBucket = String(next.sunBucket);
    this.root.dataset.universalWaterPitchBucket = String(next.waterPitchBucket);
    this.root.dataset.universalPrecipitationMode = next.precipitation.mode;
    this.root.dataset.universalPrecipitationRequestedInstances = String(
      next.precipitation.activeInstances,
    );
    this.root.dataset.universalPrecipitationInstances = String(
      this.universalPrecipitationOverlayReady ? next.precipitation.activeInstances : 0,
    );
    this.publishUniversalDecorationTelemetry();
    this.frameScheduler?.setReasonActive(
      'weather',
      this.universalPrecipitationOverlayReady
        && next.requiresContinuousFrames
        && !this.reducedMotion,
    );
    this.root.dataset.universalPrecipitationOverlayReady = String(
      this.universalPrecipitationOverlayReady,
    );
    if (diff.requiresRepaint) this.frameScheduler?.invalidate('weather');
    this.publishFrameSchedulerState();
  }

  private publishUniversalDecorationTelemetry(): void {
    const frame = this.universalAppearanceFrame;
    const clampCount = Number(this.root.dataset.presentationHeightClampCount ?? 0);
    const decoration = {
      materialAtlasVersion: this.universalMaterialAtlasReady
        ? frame?.materialAtlasVersion ?? UNIVERSAL_MATERIAL_ATLAS_VERSION
        : 'none',
      materialAtlasReady: this.universalMaterialAtlasReady,
      decorationTier: this.decorationTier,
      shadowMode: frame?.shadowMode ?? 'contact_ao',
      waterMode: frame?.waterMode ?? 'static_directional_gloss',
      vegetationMode: frame?.vegetationMode ?? 'forest_fill',
      vegetationCount: this.universalVegetationCount,
      vegetationOverlayReady: this.universalVegetationOverlayReady,
      presentationHeightClampPolicy: 'zoom_lod_180_to_500m',
      presentationHeightClampCount: Number.isFinite(clampCount) ? clampCount : 0,
    } as const;
    this.root.dataset.materialAtlasVersion = decoration.materialAtlasVersion;
    this.root.dataset.materialAtlasReady = String(decoration.materialAtlasReady);
    this.root.dataset.decorationTier = decoration.decorationTier;
    this.root.dataset.shadowMode = decoration.shadowMode;
    this.root.dataset.waterMode = decoration.waterMode;
    this.root.dataset.vegetationMode = decoration.vegetationMode;
    this.root.dataset.vegetationCount = String(decoration.vegetationCount);
    this.root.dataset.vegetationOverlayReady = String(decoration.vegetationOverlayReady);
    this.root.dataset.presentationHeightClampPolicy = decoration.presentationHeightClampPolicy;
    this.telemetry.setUniversalDecoration(decoration);
  }

  private hasDetailedPresentation(): boolean {
    return this.universalRenderPhase === 'settled_paused'
      || Boolean(this.onMapFeatures && this.universalRenderPhase === 'living_motion');
  }

  private resolveUniversalRenderPhase(
    camera: WorldCamera = this.map ? readMapCamera(this.map) : this.targetCamera,
  ): UniversalRenderPhase {
    const floorMode = (
      this.performanceGovernor?.snapshot as unknown as {
        floorMode?: 'normal' | 'emergency_30' | 'compatibility_30';
      } | undefined
    )?.floorMode;
    if (floorMode === 'compatibility_30') return 'compatibility_30';
    if (floorMode === 'emergency_30') return 'emergency_30';
    if (this.cameraMoving) return 'camera_motion';
    // Individual z16 living cells are intentionally absent below this gate.
    // The same inexpensive parent-only pass covers the general-plan gap.
    if (camera.zoom < 15.5) return 'general_plan';
    const clock = this.presentationClock;
    const timelinePlaying = Boolean(
      clock && !clock.paused && !this.reducedMotion
      && clock.baseRateSecondsPerWallSecond * clock.speedMultiplier > 0,
    );
    return timelinePlaying ? 'living_motion' : 'settled_paused';
  }

  private applyUniversalRenderPhase(
    map: MapLibreMap,
    phase: UniversalRenderPhase,
    force = false,
  ): void {
    if (this.rendererMode !== 'universal_lowpoly') return;
    const changed = phase !== this.universalRenderPhase;
    this.universalRenderPhase = phase;
    this.root.dataset.rendererPhase = phase;
    this.root.dataset.motionProfile = String(phase !== 'settled_paused');
    const individualCellsEnabled = readMapCamera(map).zoom >= 15.5
      && (this.performanceGovernor?.snapshot.individualActorsEnabled ?? true)
      && phase !== 'emergency_30'
      && phase !== 'compatibility_30';
    this.streamer?.setIndividualCellsEnabled(individualCellsEnabled);
    this.root.dataset.individualLivingCellsEnabled = String(individualCellsEnabled);
    this.applyPerformanceGovernorFeatureVisibility(map);
    if (force) this.styleController?.apply();
    this.applyUniversalSourceTileLod(map, this.onMapFeatures ? 'settled_paused' : phase);
    const tierFps = this.decorationTier === 'high' ? 120 : this.decorationTier === 'mid' ? 60 : 30;
    this.frameScheduler?.setTargetFramesPerSecond(
      this.performanceGovernor?.snapshot.targetFramesPerSecond
      ?? (phase === 'emergency_30' || phase === 'compatibility_30'
        ? Math.min(30, tierFps)
        : tierFps),
    );
    if (!this.hasDetailedPresentation()) {
      this.dependencies.clearTimeout(this.vegetationRefreshTimer);
      this.vegetationRefreshTimer = undefined;
      this.vegetationRefreshRevision += 1;
      if (changed || force || this.universalVegetationOverlayReady) {
        this.vegetationCacheKey = null;
        this.clearUniversalVegetation();
      }
    } else if (changed && this.loaded) {
      this.vegetationCacheKey = null;
      this.scheduleUniversalVegetation(map, readMapCamera(map), true);
    }
    this.publishFrameSchedulerState();
  }

  private applyUniversalSourceTileLod(
    map: MapLibreMap,
    phase: UniversalRenderPhase = this.universalRenderPhase,
  ): void {
    const buildingSourceId = this.activeBuildingSource?.id === OPENMAPTILES_BUILDINGS_SOURCE.id
      ? 'openmaptiles'
      : UNIVERSAL_BUILDING_SOURCE_ID;
    const next = {
      map,
      profileKey: phase === 'settled_paused' ? 'settled' as const : 'moving' as const,
      buildingSourceId,
      basemapSource: map.getSource('openmaptiles'),
      buildingSource: map.getSource(buildingSourceId),
    };
    const previous = this.appliedUniversalSourceTileLod;
    // MapLibre's setter dirties the source even when both numeric budgets are
    // unchanged. Retain the successful assignment until its source/style changes.
    if (previous?.map === next.map && previous.profileKey === next.profileKey
      && previous.buildingSourceId === next.buildingSourceId
      && previous.basemapSource === next.basemapSource
      && previous.buildingSource === next.buildingSource) return;
    const result = applyUniversalSourceTileLodProfile(map, phase, {
      basemapSourceId: 'openmaptiles',
      buildingSourceId,
    });
    this.appliedUniversalSourceTileLod = result.status === 'applied' ? next : null;
    this.root.dataset.sourceTileLodStatus = result.status;
    this.root.dataset.sourceTileLodMissing = result.missingSourceIds.join(',');
    this.root.dataset.sourceTileLod = result.profileKey === 'settled'
      ? 'settled:3/2'
      : 'moving:2/1.25+2/1.5';
  }

  private clearUniversalVegetation(): void {
    for (const adapter of this.adapters) {
      try {
        adapter.clearVegetation?.();
      } catch {
        // Decoration failure must not affect the retained basemap/model layers.
      }
    }
    this.universalVegetationCount = 0;
    this.universalVegetationOverlayReady = false;
    this.publishUniversalDecorationTelemetry();
  }

  private scheduleUniversalVegetation(
    map: MapLibreMap,
    camera: WorldCamera,
    force = false,
  ): void {
    if (this.rendererMode !== 'universal_lowpoly') return;
    this.dependencies.clearTimeout(this.vegetationRefreshTimer);
    const revision = ++this.vegetationRefreshRevision;
    this.vegetationRefreshTimer = this.dependencies.setTimeout(() => {
      this.vegetationRefreshTimer = undefined;
      if (!this.isActiveMap(map) || revision !== this.vegetationRefreshRevision) return;
      this.refreshUniversalVegetation(map, camera, force);
    }, 120);
  }

  private refreshUniversalVegetation(
    map: MapLibreMap,
    camera: WorldCamera,
    force: boolean,
  ): void {
    if (!this.loaded) return;
    if (this.performanceGovernor?.snapshot.treeBillboardsEnabled === false) {
      const disabledKey = `${this.vegetationStyleEpoch}:governor-disabled`;
      if (!force && this.vegetationCacheKey === disabledKey) return;
      this.vegetationCacheKey = disabledKey;
      this.clearUniversalVegetation();
      return;
    }
    if (!this.activeLayers.has('land')) {
      const disabledKey = `${this.vegetationStyleEpoch}:land-disabled`;
      if (!force && this.vegetationCacheKey === disabledKey) return;
      this.vegetationCacheKey = disabledKey;
      this.clearUniversalVegetation();
      return;
    }
    const profile = universalVegetationProfile(this.decorationTier, camera.zoom);
    const cacheKey = [
      this.vegetationStyleEpoch,
      cameraTileEpoch(camera),
      this.decorationTier,
      profile.maxInstances,
    ].join(':');
    if (!force && cacheKey === this.vegetationCacheKey) return;
    this.vegetationCacheKey = cacheKey;
    if (!profile.enabled) {
      this.clearUniversalVegetation();
      return;
    }
    const queried: QuerySourceVegetationFeatureLike[] = [];
    for (const sourceLayer of ['tree', 'landcover', 'park'] as const) {
      try {
        const rows = map.querySourceFeatures('openmaptiles', { sourceLayer });
        queried.push(...filterUniversalVegetationSourceRows(rows, sourceLayer));
      } catch {
        // Providers need not expose every optional vegetation source-layer.
      }
    }
    const features = extractSourceVegetationFeatures(queried, {
      sourceId: OPENFREE_MAP_BASEMAP_SOURCE.id,
      datasetVersion: OPENFREE_MAP_BASEMAP_SOURCE.datasetVersion,
    });
    let instances;
    try {
      instances = generateVegetationInstances(features, {
        zoom: camera.zoom,
        qualityTier: this.decorationTier,
        maximumInstances: profile.maxInstances,
        seed: universalVegetationGenerationSeed(this.decorationTier),
      });
    } catch {
      // Conflicting or malformed provider geometry is skipped without hiding the city.
      this.clearUniversalVegetation();
      return;
    }
    const mapWithStyle = map as MapLibreMap & {
      getStyle?: () => { layers?: readonly { id?: string; type?: string }[] };
    };
    const beforeId = mapWithStyle.getStyle?.().layers?.find((layer) => layer.type === 'symbol')?.id
      ?? null;
    let submittedToAdapter = false;
    for (const adapter of this.adapters) {
      if (typeof adapter.updateVegetation !== 'function') continue;
      try {
        adapter.updateVegetation({
          instances,
          maximumSizePixels: profile.maxSizePixels,
          atlasUrl: UNIVERSAL_MATERIAL_ATLAS_PNG_URL,
          iconMapping: UNIVERSAL_VEGETATION_ICON_MAPPING,
          beforeId,
        });
        submittedToAdapter = true;
      } catch {
        // The decorative overlay is independently degradable.
      }
    }
    if (!submittedToAdapter) {
      this.clearUniversalVegetation();
      return;
    }
    this.universalVegetationOverlayReady = true;
    this.universalVegetationCount = instances.length;
    this.publishUniversalDecorationTelemetry();
  }

  private attachPerformanceTimer(map: MapLibreMap): void {
    this.mapGpuFrameTimer?.dispose();
    this.mapGpuFrameTimer = null;
    this.mapGpuFrameTimerSupported = false;
    this.lastPerformanceGpuSampleCount = 0;
    this.lastPerformanceSampleAtMs = Number.NEGATIVE_INFINITY;
    try {
      const timer = this.dependencies.attachMapGpuFrameTimer(map, {
        now: this.dependencies.now,
      });
      this.mapGpuFrameTimer = timer;
      const snapshot = timer.snapshot();
      this.mapGpuFrameTimerSupported = snapshot.supported;
      this.telemetry.setMapGpuFrameTiming(snapshot);
      this.publishPerformanceGovernorTelemetry(
        this.performanceGovernor
          ? snapshot.supported ? 'waiting_gpu_sample' : 'unsupported_fallback'
          : 'disabled',
      );
    } catch {
      // Capability discovery is optional. The retained adaptive pixel budget is
      // the only fallback and never competes with a sampled GPU governor.
      this.telemetry.setMapGpuFrameTiming(null);
      this.publishPerformanceGovernorTelemetry(
        this.performanceGovernor ? 'unsupported_fallback' : 'disabled',
      );
    }
  }

  private sampleRendererPerformance(map: MapLibreMap, nowMs: number): void {
    const timer = this.mapGpuFrameTimer;
    if (!timer || nowMs - this.lastPerformanceSampleAtMs < 250) return;
    this.lastPerformanceSampleAtMs = nowMs;
    const timing = timer.snapshot();
    this.telemetry.setMapGpuFrameTiming(timing);
    const extensionSupported = Boolean(timing.extensionSupported ?? timing.supported);
    this.mapGpuFrameTimerSupported = extensionSupported;

    const governor = this.performanceGovernor;
    if (!governor) {
      this.publishPerformanceGovernorTelemetry('disabled');
      return;
    }
    if (this.onMapFeatures && !this.performanceGovernorActivated) {
      // Shader compilation, initial tile decoding, and worker attachment are
      // loading costs, not measurements of steady-state animation pressure.
      if (!this.loaded || !this.parts.deck || !map.isStyleLoaded()) return;
      if (!this.demoPerformanceWarmupStarted) {
        this.demoPerformanceWarmupStarted = true;
        timer.resetFrameIntervals?.();
        this.root.dataset.demoPerformanceWarmup = 'sampling';
        return;
      }
      if ((timing.renderIntervalWindowSampleCount ?? timing.rendererSubmissionWallWindowSampleCount) < 120) return;
      this.root.dataset.demoPerformanceWarmup = 'complete';
    }
    const frameIntervalMedianMs = timing.renderIntervalMedianMilliseconds
      ?? timing.rendererSubmissionWallMedianMilliseconds;
    const frameIntervalP95Ms = timing.renderIntervalP95Milliseconds
      ?? timing.rendererSubmissionWallP95Milliseconds;
    if (frameIntervalMedianMs === null || frameIntervalP95Ms === null) {
      this.publishPerformanceGovernorTelemetry(
        this.performanceGovernorActivated
          ? 'active'
          : extensionSupported ? 'waiting_gpu_sample' : 'unsupported_fallback',
      );
      return;
    }

    const freshGpuSample = timing.sampleCount > this.lastPerformanceGpuSampleCount;
    if (freshGpuSample) {
      this.lastPerformanceGpuSampleCount = timing.sampleCount;
    }
    const firstSample = !this.performanceGovernorActivated;
    this.performanceGovernorActivated = true;
    const clock = this.presentationClock;
    const timelinePlaying = Boolean(
      clock && !clock.paused && !this.reducedMotion
      && clock.baseRateSecondsPerWallSecond * clock.speedMultiplier > 0,
    );
    const decision = governor.observe({
      // MapLibre exposes no public CPU submission boundary in 6.4.x. The
      // render-event interval is the unconditional hard-floor fallback; GPU
      // timing only classifies pressure after its asynchronous window is ready.
      cpuFrameMs: frameIntervalMedianMs,
      gpuFrameMs: freshGpuSample && (timing.readyForGovernor ?? (
        timing.supported && timing.medianMilliseconds !== null
      )) ? timing.medianMilliseconds : null,
      frameIntervalP95Ms,
      moving: this.cameraMoving || timelinePlaying,
      wallTimeMs: nowMs,
    });
    if (firstSample) {
      this.applyPixelBudget(map, this.container.getBoundingClientRect());
      this.applyPerformanceGovernorFeatureVisibility(map);
    }
    if (decision) {
      this.lastPerformanceDecision = decision.kind;
      this.applyPerformanceGovernorDecision(map, decision);
    }
    this.publishPerformanceGovernorTelemetry('active');
  }

  private settleRendererPerformanceIfIdle(map: MapLibreMap): void {
    const clock = this.presentationClock;
    const playing = Boolean(clock && !clock.paused && !this.reducedMotion
      && clock.baseRateSecondsPerWallSecond * clock.speedMultiplier > 0);
    if (this.cameraMoving || playing) return;
    const decision = this.performanceGovernor?.settle(this.dependencies.now());
    if (!decision) return;
    this.lastPerformanceDecision = decision.kind;
    this.applyPerformanceGovernorDecision(map, decision);
    this.publishPerformanceGovernorTelemetry('active');
  }

  private publishPerformanceGovernorTelemetry(
    status: 'disabled' | 'waiting_gpu_sample' | 'active' | 'unsupported_fallback',
  ): void {
    this.telemetry.setRendererPerformanceGovernor({
      status,
      snapshot: this.performanceGovernor?.snapshot ?? null,
      lastDecision: this.lastPerformanceDecision,
      cpuInput: status === 'active' ? 'render_interval_p95' : 'none',
      gpuInput: status === 'active' && this.mapGpuFrameTimer?.snapshot().readyForGovernor
        ? 'disjoint_timer_query_median'
        : 'none',
    });
  }

  private applyPerformanceGovernorDecision(
    map: MapLibreMap,
    decision: RendererPerformanceGovernorDecision,
  ): void {
    if (decision.previous.recoveryProbe !== decision.next.recoveryProbe) {
      // The recovery gate must observe this probe's cadence, not the previous
      // capped stream. Resetting measurements does not invent frame samples.
      this.mapGpuFrameTimer?.resetFrameIntervals?.();
    }
    if (decision.previous.dprScale !== decision.next.dprScale) {
      this.applyPixelBudget(map, this.container.getBoundingClientRect());
    }
    if (
      decision.previous.treeBillboardsEnabled !== decision.next.treeBillboardsEnabled
    ) {
      this.vegetationCacheKey = null;
      if (
        decision.next.treeBillboardsEnabled
        && this.hasDetailedPresentation()
      ) {
        this.scheduleUniversalVegetation(map, readMapCamera(map), true);
      } else {
        this.dependencies.clearTimeout(this.vegetationRefreshTimer);
        this.vegetationRefreshTimer = undefined;
        this.vegetationRefreshRevision += 1;
        this.clearUniversalVegetation();
      }
    }
    if (
      decision.previous.nearPeopleCap !== decision.next.nearPeopleCap
      || decision.previous.nearVehicleCap !== decision.next.nearVehicleCap
    ) {
      this.rebuildLivingPipeline(this.currentSnapshot, true);
      for (const adapter of this.adapters) this.applySnapshotToAdapter(adapter);
    } else if (
      decision.previous.nearUpdateHz !== decision.next.nearUpdateHz
      || decision.previous.midUpdateHz !== decision.next.midUpdateHz
    ) this.publishLivingWorkerCadence();
    this.applyUniversalRenderPhase(map, this.resolveUniversalRenderPhase(), true);
  }

  private applyPerformanceGovernorFeatureVisibility(map: MapLibreMap): void {
    const snapshot = this.performanceGovernor?.snapshot;
    if (!snapshot) return;
    // The controller is the only material visibility/range writer. Resolve
    // phase first, then apply its complete snapshot, including style reloads.
    const phase = this.universalRenderPhase;
    const settled = phase === 'settled_paused';
    this.styleController?.setRenderState(phase, {
      atlasReady: this.universalMaterialAtlasReady,
      facadePatternEnabled: settled || snapshot.facadePatternEnabled,
      roofCapEnabled: settled || snapshot.roofCapEnabled,
      projectedShadowEnabled: settled || snapshot.projectedShadowEnabled,
      contactAoEnabled: settled || snapshot.contactAoEnabled,
      retainDuringCameraMotion: Boolean(this.onMapFeatures),
    });
    this.root.dataset.buildingMaterialPhase = phase;
    this.root.dataset.buildingMaterialAtlasReady = String(this.universalMaterialAtlasReady);
    this.root.dataset.rendererGovernorRecoveryProbe = String(snapshot.recoveryProbe);
  }

  private shouldUseAdaptivePixelFallback(): boolean {
    if (this.rendererMode === 'universal_lowpoly' && this.performanceGovernor) return false;
    if (this.rendererQuality !== 'adaptive') return false;
    return true;
  }

  private currentAdaptivePixelScale(): number {
    if (this.rendererMode === 'universal_lowpoly' && this.performanceGovernor) {
      return this.performanceGovernor.snapshot.dprScale;
    }
    if (this.rendererQuality !== 'adaptive') return 1;
    return this.pixelBudgetController.scale;
  }

  private pixelPolicyForBounds(bounds: Pick<DOMRectReadOnly, 'width' | 'height'>): PixelBudgetPolicy {
    const cssWidth = bounds.width || this.root.clientWidth || window.innerWidth || 1;
    const cssHeight = bounds.height || this.root.clientHeight || window.innerHeight || 1;
    const effectiveQuality = this.rendererMode === 'universal_lowpoly'
      ? rendererQualityForUniversalTier(this.decorationTier)
      : this.rendererQuality;
    const profile = rendererQualityProfile(
      effectiveQuality,
      typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1,
    );
    const policy = resolvePixelBudget({
      cssWidth,
      cssHeight,
      devicePixelRatio: typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1,
      quality: effectiveQuality,
      adaptiveScale: this.rendererMode === 'universal_lowpoly'
        || this.rendererQuality === 'adaptive'
        ? this.currentAdaptivePixelScale()
        : 1,
    });
    const pixelRatio = Math.min(profile.pixelRatio, policy.pixelRatio);
    const drawingBufferWidth = Math.max(1, Math.round(cssWidth * pixelRatio));
    const drawingBufferHeight = Math.max(1, Math.round(cssHeight * pixelRatio));
    return {
      ...policy,
      pixelRatio,
      drawingBufferWidth,
      drawingBufferHeight,
      drawingBufferPixels: drawingBufferWidth * drawingBufferHeight,
    };
  }

  private applyPixelBudget(
    map: MapLibreMap,
    bounds: Pick<DOMRectReadOnly, 'width' | 'height'>,
  ): void {
    if (bounds.width <= 0 || bounds.height <= 0) return;
    const policy = this.pixelPolicyForBounds(bounds);
    if (Math.abs(map.getPixelRatio() - policy.pixelRatio) > 0.01) {
      map.setPixelRatio(policy.pixelRatio);
    }
    this.publishPixelBudget(policy);
  }

  private publishPixelBudget(policy: PixelBudgetPolicy): void {
    this.root.dataset.rendererPixelRatio = policy.pixelRatio.toFixed(3);
    this.root.dataset.drawingBufferWidth = String(policy.drawingBufferWidth);
    this.root.dataset.drawingBufferHeight = String(policy.drawingBufferHeight);
    this.root.dataset.drawingBufferPixels = String(policy.drawingBufferPixels);
    this.root.dataset.drawingBufferPixelBudget = String(policy.pixelBudget);
    this.root.dataset.adaptivePixelScale = this.currentAdaptivePixelScale().toFixed(2);
  }

  private publishFrameSchedulerState(): void {
    const snapshot = this.frameScheduler?.snapshot();
    this.root.dataset.schedulerVisible = String(snapshot?.visible ?? false);
    this.root.dataset.schedulerRepaintPending = String(snapshot?.repaintPending ?? false);
    this.root.dataset.schedulerContinuous = String(
      (snapshot?.continuousReasons.length ?? 0) > 0,
    );
    this.root.dataset.schedulerContinuousReasons = snapshot?.continuousReasons.join(',') ?? '';
    this.root.dataset.schedulerPendingReason = snapshot?.pendingReason ?? 'none';
    this.root.dataset.schedulerTargetFps = String(snapshot?.targetFramesPerSecond ?? 0);
    this.root.dataset.schedulerCadenceScheduled = String(snapshot?.cadenceScheduled ?? false);
    this.telemetry.setRenderActivity(
      (snapshot?.continuousReasons.length ?? 0) > 0 ? 'continuous' : 'event_driven',
      this.dependencies.now(),
    );
  }

  private installPerformanceQaHook(): void {
    if (
      this.rendererMode !== 'universal_lowpoly'
      || typeof window === 'undefined'
      || !loopbackUniversalInspectionEnabled(window.location.hostname)
    ) return;
    const qaWindow = window as typeof window & {
      __OMNITWIN_PERFORMANCE_QA__?: PerformanceQaHook;
    };
    const hook: PerformanceQaHook = {
      startEpoch: (name) => {
        if (!(['general_plan', 'camera_flight', 'actor_motion'] as const).includes(name)) {
          throw new RangeError(`Unsupported performance epoch: ${String(name)}`);
        }
        this.telemetry.startMeasurementEpoch(name, this.dependencies.now(), {
          targetFramesPerSecond: 30,
          phaseMetadata: {
            rendererPhase: this.universalRenderPhase,
            motionProfile: this.root.dataset.motionProfile ?? 'false',
            governorStatus: this.root.dataset.rendererGovernorStatus ?? 'disabled',
            dprScale: this.currentAdaptivePixelScale(),
          },
        });
      },
      stopEpoch: () => this.performanceQaEpochSnapshot(
        this.telemetry.stopMeasurementEpoch(this.dependencies.now()),
      ),
      snapshot: () => this.performanceQaEpochSnapshot(
        this.telemetry.measurementEpochSnapshot(),
      ),
    };
    this.performanceQaHook = hook;
    qaWindow.__OMNITWIN_PERFORMANCE_QA__ = hook;
  }

  private performanceQaEpochSnapshot(
    epoch: ReturnType<TelemetryBus['measurementEpochSnapshot']>,
  ): PerformanceQaEpochSnapshot | null {
    if (!epoch) return null;
    const name = epoch.name as PerformanceQaEpochName;
    if (!(['general_plan', 'camera_flight', 'actor_motion'] as const).includes(name)) return null;
    const gpuStart = epoch.gpuFrameTimingStart;
    const gpuEnd = epoch.gpuFrameTimingEnd ?? this.mapGpuFrameTimer?.snapshot() ?? null;
    const gpuSampleCount = Math.max(
      0,
      (gpuEnd?.sampleCount ?? 0) - (gpuStart?.sampleCount ?? 0),
    );
    return Object.freeze({
      schema: 'omnitwin.performance-epoch.v1' as const,
      name,
      status: epoch.status === 'complete' ? 'complete' as const : 'collecting' as const,
      startedAtMs: epoch.startedAtMs,
      endedAtMs: epoch.stoppedAtMs,
      durationMs: epoch.durationMs,
      frameTimestampsMs: epoch.frameTimestampsMs,
      frameDeltasMs: epoch.frameDeltasMs,
      renderedFrames: epoch.frameCount,
      gpu: Object.freeze({
        status: gpuEnd?.status ?? 'unavailable',
        sampleCount: gpuSampleCount,
        // The public timer intentionally publishes bounded percentiles rather
        // than retaining another hot-path copy of every GPU sample.
        frameTimesMs: Object.freeze([] as number[]),
      }),
      phase: Object.freeze({
        name: String(epoch.phaseMetadata.rendererPhase ?? this.universalRenderPhase),
        motionProfile: String(epoch.phaseMetadata.motionProfile ?? 'false'),
        governorStatus: String(
          epoch.phaseMetadata.governorStatus
          ?? this.root.dataset.rendererGovernorStatus
          ?? 'disabled',
        ),
        dprScale: Number(
          epoch.phaseMetadata.dprScale ?? this.currentAdaptivePixelScale(),
        ),
      }),
    });
  }

  private switchToFallback(): void {
    if (!this.isActive() || this.fallback) return;
    this.fallback = true;
    this.lifecycle.abort();
    this.disposeMapSurface();
    this.telemetry.setMapProvider({ requested: this.mapProvider, status: 'unavailable' });
    this.telemetry.markFallback(this.dependencies.now());
    this.setReadiness({
      manifestVerified: false,
      cellsReady: false,
      contributionsReady: false,
      contributionDetailStatus: null,
    });
    this.parts = { ...EMPTY_PARTS };
    this.onPartsState(this.parts);
    this.onSourceState('offline_fallback');
  }

  private disposeMapSurface(): void {
    this.dependencies.clearTimeout(this.loadTimer);
    this.loadTimer = undefined;
    this.dependencies.clearTimeout(this.vegetationRefreshTimer);
    this.vegetationRefreshTimer = undefined;
    this.vegetationRefreshRevision += 1;
    this.interactionController?.dispose();
    this.interactionController = null;
    this.styleController?.dispose();
    this.styleController = null;
    this.streamer?.dispose();
    this.streamer = null;
    this.streamerCameraMoveActive = false;
    this.pendingLivingSeek = null;
    this.activeLivingSeek = null;
    const livingController = this.livingController;
    this.resetLivingFrameInterpolation(livingController);
    livingController?.dispose();
    this.livingController = null;
    this.livingPipeline?.dispose();
    this.livingPipeline = null;
    this.assetLoader.dispose();
    this.scenePmtilesProtocol?.dispose();
    this.scenePmtilesProtocol = null;
    this.universalPmtilesProtocol?.dispose();
    this.universalPmtilesProtocol = null;
    this.mapGpuFrameTimer?.dispose();
    this.mapGpuFrameTimer = null;
    this.mapGpuFrameTimerSupported = false;
    this.telemetry.setMapGpuFrameTiming(null);
    this.frameScheduler?.dispose();
    this.frameScheduler = null;
    if (typeof window !== 'undefined' && this.performanceQaHook) {
      const qaWindow = window as typeof window & {
        __OMNITWIN_PERFORMANCE_QA__?: PerformanceQaHook;
      };
      if (qaWindow.__OMNITWIN_PERFORMANCE_QA__ === this.performanceQaHook) {
        delete qaWindow.__OMNITWIN_PERFORMANCE_QA__;
      }
      this.performanceQaHook = null;
    }
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    for (const disposeListener of this.mapListenerDisposers.splice(0)) disposeListener();
    const adapters = this.adapters.splice(0);
    for (const adapter of adapters) adapter.dispose();
    const map = this.map;
    this.map = null;
    map?.remove();
  }

  private isActive(): boolean {
    return !this.disposed && !this.fallback && !this.lifecycle.signal.aborted;
  }

  private isActiveMap(map: MapLibreMap): boolean {
    return this.isActive() && this.map === map;
  }
}
