import type { EnvironmentStateV1 } from '../types';
import type { EnvironmentWeatherUnavailableReason } from '../environment/weather';

export type SceneGeometryStatus =
  | 'SCENE_GEOMETRY_READY'
  | 'SCENE_GEOMETRY_PARTIAL'
  | 'SCENE_GEOMETRY_UNAVAILABLE';

export type SceneAppearanceStatus =
  | 'APPEARANCE_SOURCE'
  | 'APPEARANCE_SYNTHETIC'
  | 'APPEARANCE_UNAVAILABLE';

export type SceneMovementProvenance =
  | 'source_network'
  | 'visual_synthesis'
  | 'unavailable';

export const MIXED_SOURCE_APPEARANCE_LABEL_RU =
  'Геометрия источника · внешний вид visual_synthesis';

export interface RendererFrameContext {
  nowMs: number;
  deltaMs: number;
  presentationMinutes: number;
  absolutePresentationSeconds: number;
  paused: boolean;
  baseRateSecondsPerWallSecond: number;
  speedMultiplier: number;
  reducedMotion: boolean;
  sceneTimeZone: string | null;
  environment: EnvironmentStateV1 | null;
}

export interface RendererSceneContributionTelemetry {
  id: string;
  ready: boolean;
  cameraOccluded?: boolean;
  /**
   * True only when every active detail cell is attached and its building
   * footprint geometry is source-attested. Appearance provenance is separate.
   */
  detailedBuildingGeometryReady?: boolean;
  weatherBindingStatus?:
    | 'WEATHER_READY'
    | 'WEATHER_SYNTHETIC'
    | 'WEATHER_UNAVAILABLE';
  weatherDisplayLabel?: string | null;
  weatherCondition?: 'clear' | 'cloudy' | 'rain' | 'snow' | null;
  weatherSourceProvenance?:
    | 'reanalysis_environment'
    | 'external_environment'
    | 'visual_synthesis'
    | null;
  weatherWindDirectionProvenance?:
    | 'reanalysis_environment'
    | 'external_environment'
    | 'visual_synthesis'
    | null;
  weatherCycleId?: string | null;
  weatherCycleStepIndex?: number | null;
  weatherCycleStepIndices?: readonly number[];
  weatherSourceReferences?: readonly { sourceTimeIso: string; weight: number }[];
  weatherLocalDateKey?: string | null;
  weatherLocalMinuteOfDay?: number | null;
  weatherResolvedTemperatureC?: number | null;
  weatherResolvedPrecipitationMmPerHour?: number | null;
  weatherResolvedCloudCover?: number | null;
  weatherResolvedWindMps?: number | null;
  weatherResolvedWindDirectionDegrees?: number | null;
  weatherPresentationTimeIso?: string | null;
  weatherSourceTimeIso?: string | null;
  weatherManifestSha256?: string | null;
  weatherCyclePayloadSha256?: string | null;
  weatherCycleCompiles?: number;
  weatherSourceInputSha256?: string | null;
  weatherTemporalMappingPolicy?:
    | 'daily_cycle'
    | 'annual_2025_non_leap_replay'
    | null;
  weatherTemporalMappingDerivationVersion?: '1.0.0' | null;
  weatherTemporalMappingFormula?: string | null;
  weatherBindingReason?: EnvironmentWeatherUnavailableReason | 'visual_override' | null;
  /** Optional current+halo batch lifecycle exposed by streamed city contributions. */
  planCells?: readonly string[];
  planCellAdds?: number;
  planCellRemoves?: number;
  planCellRebuilds?: number;
  /** Aggregate current+halo composition used by the qualifying urban visual gate. */
  urbanComposition?: {
    buildings: number;
    buildingArchetypes: readonly string[];
    roads: number;
    sidewalks: number;
    crosswalks: number;
    trees: number;
    streetFurnitureKinds: readonly string[];
    /** Actual source building instances submitted by the Three city controller. */
    renderedBuildings: number;
    /** Actual Three draw groups owned by all attached city cell controllers. */
    renderedDrawGroups: number;
  };
  sceneDetailStatus?:
    | 'SCENE_DETAIL_READY'
    | 'SCENE_DETAIL_PARTIAL'
    | 'SCENE_DETAIL_UNAVAILABLE';
  /** Source-geometry completeness is independent from presentation appearance. */
  sceneGeometryStatus?: SceneGeometryStatus;
  /** Appearance may remain non-scientific synthesis while geometry is source-ready. */
  sceneAppearanceStatus?: SceneAppearanceStatus;
  sceneMovementProvenance?: SceneMovementProvenance;
  sceneAppearanceScientificClaim?: false | null;
  sceneAppearanceSynthesisVersion?: '1.0.0' | null;
}

/**
 * Generic lifecycle shared by optional renderer subsystems. The owner of the
 * backend context (for example the single Three.js adapter) attaches and
 * disposes contributions; contributions never own the MapLibre map or WebGL
 * renderer themselves.
 */
export interface RendererSceneContribution<TContext, TSnapshot> {
  readonly id: string;
  attach: (context: TContext, signal: AbortSignal) => void | Promise<void>;
  update: (snapshot: TSnapshot) => void;
  frame?: (frame: RendererFrameContext) => void;
  telemetry?: () => RendererSceneContributionTelemetry;
  dispose: () => void;
}
