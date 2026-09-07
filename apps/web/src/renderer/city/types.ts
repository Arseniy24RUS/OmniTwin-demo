import type * as Three from 'three';
import type { RendererQuality } from '../types';
import type {
  RendererFrameContext,
  RendererSceneContribution,
  RendererSceneContributionTelemetry,
  SceneAppearanceStatus,
  SceneGeometryStatus,
  SceneMovementProvenance,
} from '../runtime/sceneContribution';
import type {
  EnvironmentWeatherUnavailableReason,
  LivingCityWeatherMode,
  WeatherSample2025,
} from '../environment/weather';
import type {
  EnvironmentCyclePlaybackSource,
  EnvironmentCycleSourceReference,
} from '../environment/weatherCycle';

export type CityVisualProvenance =
  | 'source_geometry'
  | 'mixed_source_geometry_synthetic_appearance'
  | 'synthetic_visual';
export interface CityPlanFieldProvenance {
  /** Footprints, centrelines and object positions, not inferred height/style. */
  readonly geometry: 'source_geometry' | 'synthetic_visual';
  /** Height/floors/archetype/roof/facade fields used by the renderer. */
  readonly buildingAppearance: 'source_attributes' | 'visual_synthesis';
  /** Authored/source-linked furniture attributes versus procedural placement. */
  readonly streetFurniture: 'source_attributes' | 'visual_synthesis';
  /** Authored movement network/speeds versus presentation-only routes. */
  readonly movement: 'source_network' | 'visual_synthesis';
}
export type BuildingRoofStyle = 'flat' | 'parapet' | 'gable' | 'hip' | 'sawtooth';
export type RussianBuildingArchetype =
  | 'panel_5'
  | 'panel_9'
  | 'brick_midrise'
  | 'stalinist'
  | 'tower_16'
  | 'industrial'
  | 'civic'
  | 'private_house'
  | 'commercial_pavilion';

export interface PointMeters {
  readonly east: number;
  readonly north: number;
}

export interface CitySceneBoundsMeters {
  readonly width: number;
  readonly height: number;
}

export interface CityBuilding {
  readonly id: string;
  /** Exact authored footprint in district-local metres when source geometry is available. */
  readonly footprint?: readonly PointMeters[];
  readonly center: PointMeters;
  readonly width: number;
  readonly depth: number;
  readonly rotationRadians: number;
  readonly height: number;
  readonly floors: number;
  readonly archetype: RussianBuildingArchetype;
  readonly roofStyle: BuildingRoofStyle;
  readonly facadePaletteIndex: number;
  readonly seed: number;
}

export type RoadOrientation = 'east_west' | 'north_south';

export interface CityRoad {
  readonly id: string;
  /** Full authored centreline. Rendering must not collapse it to its endpoints. */
  readonly points?: readonly PointMeters[];
  readonly center: PointMeters;
  readonly orientation: RoadOrientation;
  readonly length: number;
  readonly width: number;
  readonly laneCount: number;
}

export interface CitySidewalk {
  readonly id: string;
  /** Full authored centreline. Rendering must not collapse it to its endpoints. */
  readonly points?: readonly PointMeters[];
  readonly center: PointMeters;
  readonly orientation: RoadOrientation;
  readonly length: number;
  readonly width: number;
}

export interface CityCrosswalk {
  readonly id: string;
  /** Full authored centreline. Rendering must not collapse it to its endpoints. */
  readonly points?: readonly PointMeters[];
  readonly center: PointMeters;
  readonly orientation: RoadOrientation;
  readonly length: number;
  readonly width: number;
  readonly stripeCount: number;
}

export type StreetPropKind = 'tree' | 'bench' | 'street_lamp' | 'transit_stop' | 'bollard';

export interface StreetProp {
  readonly id: string;
  readonly kind: StreetPropKind;
  readonly position: PointMeters;
  readonly rotationRadians: number;
  readonly scale: number;
  readonly variant: number;
}

export interface CityRoute {
  readonly id: string;
  readonly points: readonly PointMeters[];
  readonly closed: boolean;
}

export interface CityVehicle {
  readonly id: string;
  readonly routeId: string;
  readonly offset01: number;
  readonly speedMetersPerSecond: number;
  readonly colorPaletteIndex: number;
  readonly kind: 'car' | 'bus';
}

export interface CityDistrictPlan {
  readonly id: string;
  readonly seed: string;
  readonly bounds: CitySceneBoundsMeters;
  readonly visualProvenance: CityVisualProvenance;
  readonly fieldProvenance: CityPlanFieldProvenance;
  readonly scientificClaim: false;
  readonly buildings: readonly CityBuilding[];
  readonly roads: readonly CityRoad[];
  readonly sidewalks: readonly CitySidewalk[];
  readonly crosswalks: readonly CityCrosswalk[];
  readonly props: readonly StreetProp[];
  readonly routes: readonly CityRoute[];
  readonly vehicles: readonly CityVehicle[];
}

export interface CityWorldAnchor {
  readonly mercatorX: number;
  readonly mercatorY: number;
  readonly mercatorZ: number;
  readonly meterInMercatorUnits: number;
}

export interface CitySceneLayerVisibility {
  readonly buildings: boolean;
  readonly infrastructure: boolean;
  /** Controls precipitation particles; sourced light/sky state remains active. */
  readonly weather: boolean;
}

/** One immutable current/halo geometry batch positioned in shared Mercator space. */
export interface CityPlanCell {
  /** Stable z/x/y key supplied by the scene streamer. */
  readonly cellKey: string;
  readonly primary: boolean;
  readonly anchor: CityWorldAnchor;
  readonly plan: CityDistrictPlan;
}

export interface LivingCityThreeContext {
  readonly THREE: typeof import('three');
  readonly scene: Three.Scene;
  readonly camera: Three.Camera;
  readonly renderer: Three.WebGLRenderer;
  readonly map?: unknown;
  readonly requestRepaint: () => void;
}

export interface CitySceneSnapshot {
  readonly anchor: CityWorldAnchor;
  readonly plan?: CityDistrictPlan;
  /** Sorted current+halo batches. Runtime owns cross-cell stable-ID deduplication. */
  readonly planCells?: readonly CityPlanCell[];
  readonly presentationTime: Date | string | number;
  /** Authoritative continuous presentation clock at snapshot creation. */
  readonly absolutePresentationSeconds?: number;
  /** Mandatory IANA zone belonging to the displayed scene/cell. */
  readonly timeZone: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly quality: RendererQuality;
  readonly reducedMotion: boolean;
  readonly layerVisibility?: CitySceneLayerVisibility;
  readonly weatherMode: LivingCityWeatherMode;
  /** Explicit presentation-only override; null/undefined leaves verified cycle ownership intact. */
  readonly weatherVisualOverride?: LivingCityWeatherMode | null;
  readonly weatherIntensity?: number;
  readonly weatherSample?: WeatherSample2025;
  /** Immutable, manifest-hash-bound source for no-refetch time-indexed playback. */
  readonly weatherCyclePlayback?: EnvironmentCyclePlaybackSource;
  /** Exact fail-closed reason when an authored environment cannot be source-bound. */
  readonly weatherBindingUnavailableReason?: EnvironmentWeatherUnavailableReason;
}

export interface CitySceneContributionTelemetry extends RendererSceneContributionTelemetry {
  readonly id: 'living-city';
  readonly attached: boolean;
  readonly detailedBuildingGeometryReady: boolean;
  readonly buildings: number;
  readonly trees: number;
  readonly props: number;
  readonly vehicles: number;
  readonly weatherParticles: number;
  readonly drawGroups: number;
  /** Sorted keys of batches currently attached to the shared Three scene. */
  readonly planCells: readonly string[];
  /** Cumulative streaming operations, excluding final contribution disposal. */
  readonly planCellAdds: number;
  readonly planCellRemoves: number;
  readonly planCellRebuilds: number;
  readonly urbanComposition: {
    readonly buildings: number;
    readonly buildingArchetypes: readonly RussianBuildingArchetype[];
    readonly roads: number;
    readonly sidewalks: number;
    readonly crosswalks: number;
    readonly trees: number;
    readonly streetFurnitureKinds: readonly Exclude<StreetPropKind, 'tree'>[];
    readonly renderedBuildings: number;
    readonly renderedDrawGroups: number;
  };
  readonly quality: Exclude<RendererQuality, 'adaptive'> | null;
  readonly sceneDetailStatus:
    | 'SCENE_DETAIL_READY'
    | 'SCENE_DETAIL_PARTIAL'
    | 'SCENE_DETAIL_UNAVAILABLE';
  readonly sceneGeometryStatus: SceneGeometryStatus;
  readonly sceneAppearanceStatus: SceneAppearanceStatus;
  readonly sceneMovementProvenance: SceneMovementProvenance;
  readonly sceneAppearanceScientificClaim: false | null;
  readonly sceneAppearanceSynthesisVersion: '1.0.0' | null;
  readonly visualProvenance: CityVisualProvenance | null;
  readonly weatherBindingStatus:
    | 'WEATHER_READY'
    | 'WEATHER_SYNTHETIC'
    | 'WEATHER_UNAVAILABLE';
  readonly weatherDisplayLabel: string | null;
  readonly weatherCondition: LivingCityWeatherMode | null;
  readonly weatherSourceProvenance:
    | 'reanalysis_environment'
    | 'external_environment'
    | 'visual_synthesis'
    | null;
  readonly weatherWindDirectionProvenance:
    | 'reanalysis_environment'
    | 'external_environment'
    | 'visual_synthesis'
    | null;
  readonly weatherCycleId: string | null;
  readonly weatherCycleStepIndex: number | null;
  readonly weatherCycleStepIndices: readonly number[];
  readonly weatherSourceReferences: readonly EnvironmentCycleSourceReference[];
  readonly weatherLocalDateKey: string | null;
  readonly weatherLocalMinuteOfDay: number | null;
  readonly weatherResolvedTemperatureC: number | null;
  readonly weatherResolvedPrecipitationMmPerHour: number | null;
  readonly weatherResolvedCloudCover: number | null;
  readonly weatherResolvedWindMps: number | null;
  readonly weatherResolvedWindDirectionDegrees: number | null;
  readonly weatherCycleCompiles: number;
  readonly weatherPresentationTimeIso: string | null;
  readonly weatherSourceTimeIso: string | null;
  readonly weatherManifestSha256: string | null;
  readonly weatherCyclePayloadSha256: string | null;
  readonly weatherSourceInputSha256: string | null;
  readonly weatherTemporalMappingPolicy:
    | 'daily_cycle'
    | 'annual_2025_non_leap_replay'
    | null;
  readonly weatherTemporalMappingDerivationVersion: '1.0.0' | null;
  readonly weatherTemporalMappingFormula: string | null;
  readonly weatherBindingReason: EnvironmentWeatherUnavailableReason | 'visual_override' | null;
}

export interface CitySceneContribution extends RendererSceneContribution<
  LivingCityThreeContext,
  CitySceneSnapshot
> {
  readonly id: 'living-city';
  frame: (frame: RendererFrameContext) => void;
  telemetry: () => CitySceneContributionTelemetry;
}
