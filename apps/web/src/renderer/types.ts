import type { CityDistrictPlan, CityPlanCell, CityWorldAnchor } from './city/types';
import type {
  EnvironmentStateV1 as ContractEnvironmentStateV1,
  MovementEdgeV1 as ContractMovementEdgeV1,
  MovementGraphV1 as ContractMovementGraphV1,
  MovementNodeV1 as ContractMovementNodeV1,
  SceneCellDescriptorV1 as ContractSceneCellDescriptorV1,
  SceneManifestV1 as ContractSceneManifestV1,
  VisualEntityV2 as ContractVisualEntityV2,
} from '@omnitwin/contracts';
import type { WeatherSample2025 } from './environment/weather';
import type { VegetationRenderInstance } from './universal/vegetation';
import type { EnvironmentCyclePlaybackSource } from './environment/weatherCycle';
import type {
  LivingPartition,
  LivingQaSnapshot,
  LivingRenderFrame,
} from './living/types';
import type {
  LivingSceneMovementEntitySource,
  LivingSceneMovementEdgeSource,
  LivingSceneMovementNodeSource,
  LivingSceneMovementRouteSource,
} from './living/sceneMovement';
import type {
  SceneCachePolicy,
  SceneCell,
  SceneCellLoadRequest,
  SceneDeviceTier,
} from './sceneStreamer';
import type {
  RendererFrameContext,
  RendererSceneContributionTelemetry,
} from './runtime/sceneContribution';

export type MapSourceState =
  | 'checking'
  | 'online'
  | 'online_degraded'
  | 'local_scene_ready'
  | 'offline_fallback';
export type SceneBindingStatus = 'compatible' | 'not_found' | 'ambiguous' | 'incompatible';

/** The source-backed renderer is the product default; the scene diorama is debug-only. */
export type RendererMode = 'universal_lowpoly' | 'legacy_scene_debug';
export const DEFAULT_RENDERER_MODE: RendererMode = 'universal_lowpoly';

export type MapSourceRole = 'basemap' | 'buildings' | 'terrain';
export type MapSourceTransport = 'tilejson_mvt' | 'xyz_mvt' | 'pmtiles' | 'raster_dem' | 'retained_geojson';
export type MapSourceAuth = 'none' | 'runtime_token';
export type StaticSourceAvailability = 'checking' | 'ready' | 'degraded' | 'unavailable';

export interface MapSourceSchemaV1 {
  id: string;
  version: string;
  /** Every layer listed here must be present before a source is promoted to ready. */
  requiredLayers: readonly string[];
}

export interface MapSourceRightsV1 {
  browserCache: boolean;
  edgeCache: boolean;
  proxy: boolean;
  prefetch: 'none' | 'visible_only' | 'visible_plus_one_ring';
}

/** Runtime-delivered provider contract. It describes data; it never embeds credentials. */
export interface MapSourceDescriptorV1 {
  contractVersion: 1;
  id: string;
  role: MapSourceRole;
  transport: MapSourceTransport;
  schema: MapSourceSchemaV1;
  datasetVersion: string;
  url: string;
  minZoom: number;
  maxZoom: number;
  auth: MapSourceAuth;
  /** Public basemap, explicitly non-production inspection data, or production delivery. */
  usage: 'public_service' | 'development_inspection' | 'production';
  attributionHtml: string;
  rights: MapSourceRightsV1;
}

export interface StaticMapLayerStateV1 {
  basemap: StaticSourceAvailability;
  buildings: StaticSourceAvailability;
  terrain: StaticSourceAvailability;
  activeBuildingSourceId: string | null;
  buildingFallbackActive: boolean;
  buildingFailureReason: string | null;
}

export type BuildingHeightQuality =
  | 'exact'
  | 'derived_floors'
  | 'provider_derived'
  | 'approximate_fixed_5m';

export interface BuildingFootprintV1 {
  type: 'Polygon' | 'MultiPolygon';
  /** Authored WGS84 coordinates retained verbatim from the selected source. */
  coordinates: unknown;
}

export interface NormalizedBuildingV1 {
  buildingId: string;
  sourceFeatureId: string | number | null;
  parentBuildingId: string | null;
  footprint: BuildingFootprintV1;
  heightM: number;
  heightQuality: BuildingHeightQuality;
  numFloors: number | null;
  minHeightM: number;
  buildingClass: string | null;
  facadeColor: string | null;
  roofColor: string | null;
  facadeMaterial: string | null;
  roofMaterial: string | null;
  roofShape: string | null;
  sourceId: string;
  datasetVersion: string;
}

export type ViewMode = '2d' | '3d';

export type RendererQuality = 'adaptive' | 'cinematic' | 'balanced' | 'performance';

export type WeatherMode = 'clear' | 'cloudy' | 'rain' | 'snow';

export type WorldLayer =
  | 'agents'
  | 'population'
  | 'movement'
  | 'infrastructure'
  | 'buildings'
  | 'land'
  | 'weather';

export type WorldLens =
  | 'population'
  | 'movement'
  | 'infrastructure'
  | 'economy'
  | 'ecology';

export type VisualRepresentation =
  | 'focus_person_1to1'
  | 'aggregate_proxy'
  | 'ambient_only';

export type VisualEntityKind = 'person' | 'vehicle' | 'focus';

export interface VisualEntity {
  id: string;
  kind: VisualEntityKind;
  representation: VisualRepresentation;
  longitude: number;
  latitude: number;
  heading: number;
  /** The count represented visually. It is never a scientific expansion weight. */
  representedCount: number;
  activity: 'home' | 'walk' | 'work' | 'study' | 'transit' | 'leisure' | 'ambient';
  color: string;
  seed: number;
}

export interface WorldCamera {
  longitude: number;
  latitude: number;
  zoom: number;
  pitch: number;
  bearing: number;
}

export interface RendererPresentationClock {
  /** Authoritative presentation-clock anchor; never Date.now()/wall-clock derived. */
  absolutePresentationSeconds: number;
  paused: boolean;
  /** Product clock rate before the selected multiplier (120 at normal playback). */
  baseRateSecondsPerWallSecond: number;
  /** Explicit UI multiplier. Current product controls use 1, 4, and 16. */
  speedMultiplier: number;
  /**
   * Monotonic user-seek token. Periodic playback ticks preserve it; an
   * explicit rewind, reset, slider change, or absolute visual query increments it.
   */
  seekRevision?: number;
}

export interface WorldSceneProps {
  /** Verified active-cell geometry for both drawing and native building selection. */
  verifiedCityBuildings?: import('./verifiedCityBuildingTypes').VerifiedCityBuildingSnapshot | null;
  /** Exact bounds used to establish that snapshot's coverage, not a later camera bbox. */
  verifiedCityBuildingBounds?: readonly [number,number,number,number];
  /** Bounded verified source roads for preview-only lane/sidewalk presentation widths. */
  gameSourceRoads?: readonly import('../demo/data/CityPackV2').CityRoadV2[];
  /** Exact provider corridor-to-source-road provenance, independent of renderer edge IDs. */
  gameSourceCorridors?: import('../demo/types').DemoLayout['roads'];
  /** Semantic slice changes re-anchor presentation queues, independently of camera motion. */
  trafficContextKey?: string;
  aggregateRoadFlows?: import('./aggregateRoadFlow').AggregateRoadFlowSnapshot | null;
  /** Display-only routes extracted from the active public basemap. */
  presentationMovement?: WorldSceneMovementPayload | null;
  onMapFeatures?: (features: RendererMapFeatureSnapshot) => void;
  hideTechnicalHud?: boolean;
  highlightedBuildingId?: string | null;
  camera?: WorldCamera;
  entities?: readonly VisualEntity[];
  /** Canonical V2 motion/provenance rows; legacy VisualEntity coordinates remain adapter input only. */
  entitiesV2?: readonly VisualEntityV2[];
  /** Contract-validated local focus-sample motion, kept separate from VisualEntityV2 privacy rows. */
  mobilityPresentationMovement?: readonly LivingSceneMovementEntitySource[];
  /** Exact loaded LivingCellSliceV1 cellIds used to prioritize verified scene graph cells. */
  sceneCellHints?: readonly string[];
  selectedId?: string | null;
  onSelect?: (entity: VisualEntity | null) => void;
  onBuildingSelect?: (building: RendererBuildingSelection | null) => void;
  /** Verified current+halo movement graph published by the mounted runtime. */
  onVerifiedMovementChange?: (movement: WorldSceneMovementPayload | null) => void;
  onCameraChange?: (camera: WorldCamera) => void;
  /** Settled actual ground bounds; independent of tile/source feature availability. */
  onViewportChange?: (viewport: RendererViewportSnapshot) => void;
  onSourceStateChange?: (state: MapSourceState) => void;
  viewMode?: ViewMode;
  weather?: WeatherMode;
  /** Explicit presentation-only override; null leaves verified scene weather authoritative. */
  weatherVisualOverride?: WeatherMode | null;
  /** Exact API-declared share of viewport allocation represented by visual entities. */
  representationCoverage?: number;
  /** Final API-summary to renderer-row conservation/reconciliation result. */
  representationConsistent?: boolean;
  presentationMinutes?: number;
  presentationClock?: RendererPresentationClock | null;
  mapEnabled?: boolean;
  /** Explicit basemap provider. PMTiles requires a verified scene-level descriptor. */
  /** scene_only keeps Agent/street views on same-origin scene assets with no external tiles. */
  mapProvider?: 'openfreemap' | 'pmtiles' | 'scene_only';
  /** Source-backed rendering is default; the scene renderer is an explicit debug route. */
  rendererMode?: RendererMode;
  /** Independent model overlay state; it never controls static basemap availability. */
  modelOverlayStatus?: 'disabled' | 'loading' | 'ready' | 'unavailable';
  activeLayers?: ReadonlySet<WorldLayer>;
  activeLens?: WorldLens;
  /** Explicit renderer benchmark mode; never changes model or bundle semantics. */
  performanceMode?: boolean;
  rendererQuality?: RendererQuality;
  diagnostics?: boolean;
  reducedMotion?: boolean;
  /** Enables optional v2 streaming/contribution hooks; false keeps the v0.8 visual path explicit. */
  cityRendererV2?: boolean;
  sceneCachePolicy?: SceneCachePolicy;
  sceneMemoryBudgetBytes?: number;
  sceneDeviceTier?: SceneDeviceTier;
  /** Strict catalog-selected immutable scene binding. Missing bindings fail closed in v2. */
  scenePack?: WorldScenePackBinding | null;
  sceneBindingStatus?: SceneBindingStatus;
  className?: string;
}

/** Exact provider-qualified MapLibre building selection; never name/spatial joined. */
export interface RendererBuildingSelection {
  readonly canonicalId: string;
  readonly providerId: string;
  readonly datasetVersion: string;
  readonly featureId: string;
  readonly layerId: string;
  readonly sourceLayer: string | null;
}

export interface RendererViewportSnapshot {
  readonly camera: WorldCamera;
  /** Actual MapLibre ground extent: west, south, east, north. */
  readonly bbox: readonly [number, number, number, number];
  readonly widthCss: number;
  readonly heightCss: number;
  /** Quantized pose/bounds/CSS-size signature, not a per-frame counter. */
  readonly revision: string;
}

export interface RendererMapFeatureSnapshot {
  readonly transportation: readonly import('geojson').Feature[];
  readonly buildings: readonly import('maplibre-gl').MapGeoJSONFeature[];
  readonly buildingSource: MapSourceDescriptorV1 | null;
  readonly camera: WorldCamera;
}

/** Canonical wire types are owned and runtime-validated by @omnitwin/contracts. */
export type SceneManifestV1 = ContractSceneManifestV1;
export type SceneCellDescriptorV1 = ContractSceneCellDescriptorV1;
export type EnvironmentStateV1 = ContractEnvironmentStateV1;
export type VisualEntityV2 = ContractVisualEntityV2;
export type MovementNodeV1 = ContractMovementNodeV1;
export type MovementEdgeV1 = ContractMovementEdgeV1;
export type MovementGraphV1 = ContractMovementGraphV1;

export interface WorldSceneMovementPayload {
  /** Validated cell nodes retained with authored WGS84 positions. */
  nodes: readonly LivingSceneMovementNodeSource[];
  /** Validated cell edges with their decoded authored WGS84 polylines. */
  edges: readonly LivingSceneMovementEdgeSource[];
  /** Authored manifest routes. Runtime never invents route connectivity. */
  routes: readonly LivingSceneMovementRouteSource[];
}

export interface WorldSceneCityPayload {
  anchor: CityWorldAnchor;
  plan: CityDistrictPlan | null;
  /** Stable, sorted current+halo batches composed by SceneRuntime. */
  planCells?: readonly CityPlanCell[];
  environment: EnvironmentStateV1 | null;
  entitiesV2: readonly VisualEntityV2[];
  movement: WorldSceneMovementPayload | null;
  presentationTimeIso: string;
  weatherSample: WeatherSample2025 | null;
  /** Hash-bound annual/daily cycle resolved from the verified manifest. */
  weatherCyclePlayback: EnvironmentCyclePlaybackSource | null;
}

export interface WorldSceneCellLoadResponse {
  cell: SceneCell;
  /** Hash of the exact manifest bytes used to assemble this immutable cell. */
  sceneManifestSha256: string;
  descriptor: SceneCellDescriptorV1 | null;
  immutableAssets: readonly {
    url: string;
    sha256: string;
    bytes: number;
  }[];
  cityPayload: WorldSceneCityPayload | null;
  estimateBytes: number;
  dispose?: () => void;
}

/** Stable public shorthand and previous name retained for adapter compatibility. */
export type SceneCellLoadResponse = WorldSceneCellLoadResponse;
export type WorldSceneCellResource = WorldSceneCellLoadResponse;

export interface SceneImmutableAssetRequest {
  /** Selected immutable scene identity used to constrain same-origin URLs. */
  sceneId: string;
  url: string;
  sha256: string;
  /** Exact byte length when declared by the manifest/index. */
  bytes?: number | null;
  accept?: string;
  /** Required MIME substring for binary formats such as PMTiles/GLB/KTX2. */
  contentType?: string;
}

export interface SceneVerifiedAsset {
  url: string;
  sha256: string;
  bytes: ArrayBuffer;
  contentType: string | null;
}

export interface SceneImmutableAssetLoader {
  load(request: SceneImmutableAssetRequest, signal: AbortSignal): Promise<SceneVerifiedAsset>;
  dispose(): void;
}

export interface WorldSceneCellLoadRequest extends SceneCellLoadRequest {
  sceneId: string;
  sceneVersion: string;
  sceneTimeZone: string;
  /** Runtime-owned verified cache path; focus trajectories must never use it. */
  assetLoader: SceneImmutableAssetLoader;
}

export type WorldScenePackBinding =
  | {
      sceneId: string;
      sceneVersion: string;
      sceneTimeZone: string;
      geographyCatalogSha256: string;
      manifestSha256: string;
      sourceDetailStatus: 'available';
      manifest: SceneManifestV1 | null;
      /**
       * Bootstrap/caller payload. Once cells stream, SceneRuntime owns the
       * composed current+halo payload and retains it across null same-binding
       * clock/settings snapshots.
       */
      cityPayload: WorldSceneCityPayload | null;
    } & (
      | {
          immutableCellBaseUrl: string;
          manifestUrl: string;
          loadManifest?: (
            signal: AbortSignal,
            assetLoader: SceneImmutableAssetLoader,
          ) => Promise<SceneManifestV1>;
          loadCell?: (request: WorldSceneCellLoadRequest) => Promise<WorldSceneCellResource>;
        }
      | {
          immutableCellBaseUrl: null;
          manifestUrl: null;
          loadManifest: (
            signal: AbortSignal,
            assetLoader: SceneImmutableAssetLoader,
          ) => Promise<SceneManifestV1>;
          loadCell: (request: WorldSceneCellLoadRequest) => Promise<WorldSceneCellResource>;
        }
    )
  | {
      sceneId: string;
      sceneVersion: string;
      sceneTimeZone: string;
      manifestSha256: string;
      sourceDetailStatus: 'unavailable' | 'offline_fallback';
      immutableCellBaseUrl: null;
      manifestUrl: null;
      manifest: null;
      cityPayload: null;
      loadManifest?: never;
      loadCell?: never;
    };

export interface RendererLivingSnapshot {
  partition: LivingPartition;
  frame: LivingRenderFrame;
  telemetry: LivingQaSnapshot;
  /** Hard-floor governor may retain only non-pickable aggregate flows. */
  individualActorsEnabled?: boolean;
}

export interface RendererSceneSnapshot {
  verifiedCityBuildings?: import('./verifiedCityBuildingTypes').VerifiedCityBuildingSnapshot | null;
  aggregateRoadFlows?: import('./aggregateRoadFlow').AggregateRoadFlowSnapshot | null;
  presentationMovement?: WorldSceneMovementPayload | null;
  camera: WorldCamera;
  entities: readonly VisualEntity[];
  /** Current viewport V2 rows override stale cell-captured entity metadata during pan refresh. */
  entitiesV2?: readonly VisualEntityV2[];
  /** Routed local-pseudonymous focus sample; never coerced into VisualEntityV2. */
  mobilityPresentationMovement?: readonly LivingSceneMovementEntitySource[];
  selectedId: string | null;
  presentationMinutes: number;
  presentationClock: RendererPresentationClock | null;
  reducedMotion: boolean;
  /** Runtime-owned layer state shared by MapLibre and Three contributions. */
  activeLayers?: ReadonlySet<WorldLayer>;
  weather: WeatherMode;
  /** Explicit presentation-only override; null/undefined leaves scene weather authoritative. */
  weatherVisualOverride?: WeatherMode | null;
  rendererQuality: RendererQuality;
  scenePack: WorldScenePackBinding | null;
  living: RendererLivingSnapshot | null;
}

export interface RendererAdapterTelemetry {
  /** Schematic road-direction marks, never included in people/vehicle totals. */
  aggregateRoadFlows?: number;
  pedestrians: number;
  vehicles: number;
  renderedFrames: number;
  updates: number;
  rebuilds: number;
  /** Geometric pose-buffer allocations; stable playback must keep this flat. */
  actorPoseAllocations?: number;
  actorPoseCapacity?: { readonly people: number; readonly vehicles: number };
  /** Geometric columnar-buffer growth events; stable hot frames must not increment it. */
  livingBufferAllocations?: number;
  contributions?: readonly RendererSceneContributionTelemetry[];
  living?: LivingQaSnapshot;
  /** Stable logical IDs actually submitted to this adapter's primary partition. */
  submittedIds?: readonly string[];
  /** Camera-window and budget accounting for retained Living submissions. */
  livingSubmission?: {
    readonly planned: number;
    readonly eligible: number;
    readonly submitted: number;
    readonly cameraCulled: number;
    readonly budgetCulled: number;
    readonly activeCellCount: number | null;
    readonly activeCellKey: string | null;
    readonly cellEnumerationOverflowed: boolean;
  };
  /** Nearest profile-eligible submitted focus person for click-only visual QA. */
  pickCandidate?: {
    readonly physicalHeightPixels?: number;
    readonly impostorMix?: number;
    readonly id: string;
    readonly kind: 'person';
    readonly x: number;
    readonly y: number;
    readonly layerId: 'omnitwin-living-people';
    readonly representation: 'focus_person_1to1';
    readonly profileEligible: true;
    /** False is allowed only so QA can reframe a guard-ring focus target. */
    readonly onCanvas: boolean;
  };
  /** Public demo QA: projections of bounded, actually submitted GPU rows. */
  presentationPickCandidates?: readonly {
    readonly physicalHeightPixels?: number;
    readonly impostorMix?: number;
    readonly id: string;
    readonly kind: 'person' | 'vehicle';
    readonly x: number;
    readonly y: number;
    readonly onCanvas: boolean;
  }[];
  /** Click-only GPU picking diagnostics; never contains source/raw identity. */
  clickPicking?: {
    readonly attempts: number;
    readonly hits: number;
    readonly misses: number;
    readonly errors: number;
    readonly consumed: number;
    readonly lastStatus: 'idle' | 'hit' | 'miss' | 'error' | 'coordinate_mismatch';
    readonly lastLogicalId: string | null;
    readonly lastLayerId: string | null;
    readonly lastError: string | null;
    readonly lastX: number | null;
    readonly lastY: number | null;
  };
}

export interface RendererVegetationIconMappingEntry {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly anchorX?: number;
  readonly anchorY?: number;
  readonly mask?: boolean;
}

export interface RendererVegetationSnapshot {
  readonly instances: readonly VegetationRenderInstance[];
  readonly maximumSizePixels: number;
  readonly atlasUrl: string;
  readonly iconMapping: Readonly<Record<string, RendererVegetationIconMappingEntry>>;
  readonly beforeId: string | null;
}

export interface RendererAdapter {
  updateAggregateRoadFlows?: (snapshot: import('./aggregateRoadFlow').AggregateRoadFlowSnapshot | null) => void;
  kind: 'deck' | 'three';
  dispose: () => void;
  update: (entities: readonly VisualEntity[], selectedId: string | null) => void;
  /** Click-only GPU picker. Returns the exact logical ID submitted by this adapter. */
  pickAt?: (x: number, y: number) => string | null;
  /** Re-evaluates viewport cell culling after camera movement, including while paused. */
  updateCameraWindow?: () => void;
  /** Optional v2 hook; legacy adapters continue to use update(). */
  updateScene?: (snapshot: RendererSceneSnapshot) => void;
  /** Columnar, mutually exclusive LivingCity renderer partition. */
  updateLiving?: (snapshot: RendererLivingSnapshot, selectedId: string | null) => void;
  /** Retained source-backed decorative vegetation; independent of living/model rows. */
  updateVegetation?: (snapshot: RendererVegetationSnapshot) => void;
  clearVegetation?: () => void;
  /** Optional backend-owned contribution frame. MapLibre remains the frame source. */
  frame?: (frame: RendererFrameContext) => void;
  telemetry: () => RendererAdapterTelemetry;
}
