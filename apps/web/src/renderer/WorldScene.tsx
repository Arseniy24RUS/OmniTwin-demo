import { useEffect, useMemo, useRef, useState } from 'react';
import 'maplibre-gl/dist/maplibre-gl.css';
import { CanvasFallback } from './CanvasFallback';
import {
  rendererCapability,
  rendererCapabilityLabel,
  type RendererCapability,
  type RendererPartsState,
} from './capabilityState';
import { rendererQualityProfile } from './qualityProfile';
import {
  SceneRuntime,
  isResolvedWorldCamera,
  type SceneRuntimeReadiness,
} from './runtime/SceneRuntime';
import { TelemetryBus } from './runtime/TelemetryBus';
import { MIXED_SOURCE_APPEARANCE_LABEL_RU } from './runtime/sceneContribution';
import { resolveSourceState } from './sourceState';
import { DEFAULT_RENDERER_MODE } from './types';
import { useRendererPerformancePolicyV3 } from './useRendererPerformancePolicyV3';
import type {
  MapSourceState,
  VisualEntity,
  WorldCamera,
  WorldLayer,
  WorldLens,
  WorldSceneProps,
} from './types';
import './renderer.css';

const EMPTY_SCENE_CELL_HINTS: readonly string[] = [];

const UNRESOLVED_CAMERA: WorldCamera = {
  longitude: 0,
  latitude: 0,
  zoom: 2,
  pitch: 0,
  bearing: 0,
};

const DEFAULT_LAYERS: ReadonlySet<WorldLayer> = new Set([
  'agents',
  'population',
  'movement',
  'infrastructure',
  'buildings',
  'land',
  'weather',
]);

const EMPTY_PARTS: RendererPartsState = {
  maplibre: false,
  deck: false,
  three: false,
  deckFailed: false,
  threeFailed: false,
  livingWorkerFallback: false,
};

const EMPTY_READINESS: SceneRuntimeReadiness = {
  manifestVerified: false,
  cellsReady: false,
  contributionsReady: false,
  contributionDetailStatus: null,
};

function lensColor(entity: VisualEntity, lens: WorldLens): string {
  if (entity.kind === 'vehicle') return lens === 'ecology' ? '#a8d87b' : '#ffb64d';
  if (entity.representation === 'focus_person_1to1') return '#ffffff';
  if (lens === 'movement') return '#68a6b5';
  if (lens === 'infrastructure') return '#77a7ff';
  if (lens === 'economy') return '#f3b5ff';
  if (lens === 'ecology') return '#76f0a8';
  return entity.color;
}

export function environmentDayPhase(minutes: number): 'night' | 'dawn' | 'day' | 'dusk' {
  const normalized = ((Math.floor(minutes) % 1_440) + 1_440) % 1_440;
  if (normalized < 300 || normalized >= 1_320) return 'night';
  if (normalized < 420) return 'dawn';
  if (normalized < 1_140) return 'day';
  return 'dusk';
}

export function resolveProviderSourceState(
  mapProvider: NonNullable<WorldSceneProps['mapProvider']>,
  input: {
    mapEnabled: boolean;
    navigatorOnline: boolean;
    query: string;
  },
): MapSourceState {
  return resolveSourceState({
    ...input,
    // navigator.onLine describes the external provider, not same-origin
    // content-addressed scene assets.
    navigatorOnline: mapProvider === 'openfreemap' ? input.navigatorOnline : true,
  });
}

export function resolveSceneDetailDisplayStatus(input: {
  cityRendererV2: boolean;
  isFallback: boolean;
  terminalSceneDetail: boolean;
  sourceDetailStatus: string | null;
  capability: RendererCapability;
  v2Ready: boolean;
  representationComplete: boolean;
  contributionDetailStatus: SceneRuntimeReadiness['contributionDetailStatus'];
}): Exclude<SceneRuntimeReadiness['contributionDetailStatus'], null> {
  if (
    !input.cityRendererV2
    || input.isFallback
    || input.terminalSceneDetail
    || input.sourceDetailStatus === 'unavailable'
    || input.sourceDetailStatus === 'offline_fallback'
    || input.contributionDetailStatus === 'SCENE_DETAIL_UNAVAILABLE'
  ) return 'SCENE_DETAIL_UNAVAILABLE';
  if (
    input.capability === 'ready'
    && input.v2Ready
    && input.representationComplete
    && input.contributionDetailStatus === 'SCENE_DETAIL_READY'
  ) return 'SCENE_DETAIL_READY';
  return 'SCENE_DETAIL_PARTIAL';
}

function longitudeDistanceDegrees(left: number, right: number): number {
  const delta = Math.abs(left - right) % 360;
  return Math.min(delta, 360 - delta);
}

export function WorldScene({
  verifiedCityBuildings = null,
  aggregateRoadFlows = null,
  presentationMovement = null,
  onMapFeatures,
  hideTechnicalHud = false,
  highlightedBuildingId = null,
  camera,
  entities = [],
  entitiesV2 = [],
  mobilityPresentationMovement = [],
  sceneCellHints = EMPTY_SCENE_CELL_HINTS,
  selectedId = null,
  onSelect,
  onBuildingSelect,
  onVerifiedMovementChange,
  onCameraChange,
  onViewportChange,
  onSourceStateChange,
  viewMode = '3d',
  weather = 'clear',
  weatherVisualOverride = null,
  representationCoverage = 1,
  representationConsistent = true,
  presentationMinutes = 19 * 60 + 42,
  presentationClock = null,
  mapEnabled = true,
  mapProvider = 'openfreemap',
  rendererMode = DEFAULT_RENDERER_MODE,
  modelOverlayStatus = 'disabled',
  activeLayers = DEFAULT_LAYERS,
  activeLens = 'population',
  performanceMode = false,
  rendererQuality = 'adaptive',
  diagnostics = true,
  reducedMotion = false,
  cityRendererV2 = true,
  sceneCachePolicy = 'auto',
  sceneMemoryBudgetBytes,
  sceneDeviceTier,
  scenePack = null,
  sceneBindingStatus,
  className = '',
}: WorldSceneProps) {
  const sceneRootRef = useRef<HTMLDivElement>(null);
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<SceneRuntime | null>(null);
  const telemetryRef = useRef<TelemetryBus | null>(null);
  const onSelectRef = useRef(onSelect);
  const onBuildingSelectRef = useRef(onBuildingSelect);
  const onVerifiedMovementChangeRef = useRef(onVerifiedMovementChange);
  const onCameraChangeRef = useRef(onCameraChange);
  const onViewportChangeRef = useRef(onViewportChange);
  const onMapFeaturesRef = useRef(onMapFeatures);
  onMapFeaturesRef.current = onMapFeatures;
  const [networkRevision, setNetworkRevision] = useState(0);
  const [parts, setParts] = useState<RendererPartsState>(EMPTY_PARTS);
  const [readiness, setReadiness] = useState<SceneRuntimeReadiness>(EMPTY_READINESS);
  const [pickEvidence, setPickEvidence] = useState<{
    revision: number;
    entityId: string;
    representation: VisualEntity['representation'] | 'none';
  }>({ revision: 0, entityId: 'none', representation: 'none' });
  const [environmentBinding, setEnvironmentBinding] = useState<{
    status: string;
    reason: string;
    label: string;
  } | null>(null);
  const [sceneVisualReadiness, setSceneVisualReadiness] = useState<{
    geometryStatus: string;
    appearanceStatus: string;
  } | null>(null);
  const [sourceState, setSourceState] = useState<MapSourceState>(() =>
    resolveProviderSourceState(mapProvider, {
      mapEnabled,
      navigatorOnline: typeof navigator === 'undefined' ? true : navigator.onLine,
      query: typeof window === 'undefined' ? '' : window.location.search,
    }),
  );
  const qualityProfile = useMemo(
    () => rendererQualityProfile(
      rendererQuality,
      typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1,
    ),
    [rendererQuality],
  );
  const performancePolicyV3 = useRendererPerformancePolicyV3(
    rendererQuality,
    reducedMotion,
  );
  const cameraResolved = isResolvedWorldCamera(camera);
  const legacySceneDebug = rendererMode === 'legacy_scene_debug';
  // Universal mode may consume the selected scene as an optional movement /
  // environment stream, but it must not remount the MapLibre surface when
  // that independently loaded binding changes. updateScene owns later swaps.
  const runtimeBootstrapScenePack = scenePack;
  const legacyBootstrapScenePack = legacySceneDebug ? scenePack : null;
  const bootstrapSceneBindingStatus = legacySceneDebug ? sceneBindingStatus : undefined;
  const targetCamera = useMemo<WorldCamera>(() => {
    if (!cameraResolved) return UNRESOLVED_CAMERA;
    return {
      ...camera,
      pitch: viewMode === '3d' ? Math.min(camera.pitch, qualityProfile.maxPitch) : 0,
      bearing: viewMode === '3d' ? camera.bearing : 0,
    };
  }, [camera, cameraResolved, qualityProfile.maxPitch, viewMode]);

  const visibleEntities = useMemo(
    () => entities.filter((entity) => {
      if (entity.kind === 'vehicle') return activeLayers.has('movement');
      if (entity.representation === 'focus_person_1to1') return activeLayers.has('agents');
      return activeLayers.has('population');
    }),
    [activeLayers, entities],
  );
  const visibleVehicles = useMemo(
    () => visibleEntities.filter((entity) => entity.kind === 'vehicle').length,
    [visibleEntities],
  );
  const visiblePedestrians = visibleEntities.length - visibleVehicles;
  const selectedVisibleEntity = useMemo(
    () => selectedId ? visibleEntities.find((entity) => entity.id === selectedId) ?? null : null,
    [selectedId, visibleEntities],
  );
  const selectedEntityCentered = Boolean(
    selectedVisibleEntity
    && longitudeDistanceDegrees(targetCamera.longitude, selectedVisibleEntity.longitude) <= 0.00001
    && Math.abs(targetCamera.latitude - selectedVisibleEntity.latitude) <= 0.00001,
  );
  const renderedEntities = useMemo(
    () => visibleEntities.map((entity) => {
      const color = lensColor(entity, activeLens);
      return color === entity.color ? entity : { ...entity, color };
    }),
    [activeLens, visibleEntities],
  );

  onSelectRef.current = onSelect;
  onBuildingSelectRef.current = onBuildingSelect;
  onVerifiedMovementChangeRef.current = onVerifiedMovementChange;
  onCameraChangeRef.current = onCameraChange;
  onViewportChangeRef.current = onViewportChange;

  const recordPick = (entity: VisualEntity | null) => {
    setPickEvidence((current) => ({
      revision: current.revision + 1,
      entityId: entity?.id ?? 'none',
      representation: entity?.representation ?? 'none',
    }));
    onSelectRef.current?.(entity);
  };

  const recordBuildingPick = (building: Parameters<NonNullable<WorldSceneProps['onBuildingSelect']>>[0]) => {
    onBuildingSelectRef.current?.(building);
  };

  const recordVerifiedMovement = (
    movement: Parameters<NonNullable<WorldSceneProps['onVerifiedMovementChange']>>[0],
  ) => {
    onVerifiedMovementChangeRef.current?.(movement);
  };

  useEffect(() => {
    const handleNetworkChange = () => setNetworkRevision((revision) => revision + 1);
    window.addEventListener('online', handleNetworkChange);
    window.addEventListener('offline', handleNetworkChange);
    return () => {
      window.removeEventListener('online', handleNetworkChange);
      window.removeEventListener('offline', handleNetworkChange);
    };
  }, []);

  useEffect(() => {
    onSourceStateChange?.(sourceState);
  }, [onSourceStateChange, sourceState]);

  useEffect(() => {
    const root = sceneRootRef.current;
    if (!root) return undefined;
    const readVisibleBindings = () => {
      const status = root.dataset.environmentBindingStatus;
      const reason = root.dataset.environmentBindingReason;
      const label = root.dataset.environmentDisplayLabel;
      if (status && reason && label) {
        setEnvironmentBinding((current) => (
          current?.status === status && current.reason === reason && current.label === label
            ? current
            : { status, reason, label }
        ));
      }
      const geometryStatus = root.dataset.sceneGeometryStatus;
      const appearanceStatus = root.dataset.sceneAppearanceStatus;
      if (geometryStatus && appearanceStatus) {
        setSceneVisualReadiness((current) => (
          current?.geometryStatus === geometryStatus
            && current.appearanceStatus === appearanceStatus
            ? current
            : { geometryStatus, appearanceStatus }
        ));
      }
    };
    readVisibleBindings();
    const observer = new MutationObserver(readVisibleBindings);
    observer.observe(root, {
      attributes: true,
      attributeFilter: [
        'data-environment-binding-status',
        'data-environment-binding-reason',
        'data-environment-display-label',
        'data-scene-geometry-status',
        'data-scene-appearance-status',
      ],
    });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const root = sceneRootRef.current;
    const container = mapContainerRef.current;
    if (!root || !container) return undefined;

    setParts(EMPTY_PARTS);
    setReadiness(EMPTY_READINESS);
    const telemetry = new TelemetryBus({
      root,
      getAdapters: () => runtimeRef.current?.getAdapters() ?? [],
    });
    telemetryRef.current = telemetry;
    telemetry.initialize();

    const initialState = resolveProviderSourceState(mapProvider, {
      mapEnabled,
      navigatorOnline: navigator.onLine,
      query: window.location.search,
    });
    if (initialState === 'offline_fallback') {
      setSourceState(initialState);
      telemetry.markFallback();
      return () => {
        telemetry.dispose();
        if (telemetryRef.current === telemetry) telemetryRef.current = null;
      };
    }

    const terminalBindingFailure = cityRendererV2
      && bootstrapSceneBindingStatus !== undefined
      && bootstrapSceneBindingStatus !== 'compatible';
    if (
      !cameraResolved
      || (legacySceneDebug && cityRendererV2 && !legacyBootstrapScenePack && !terminalBindingFailure)
    ) {
      setSourceState('checking');
      return () => {
        telemetry.dispose();
        if (telemetryRef.current === telemetry) telemetryRef.current = null;
      };
    }

    setSourceState('checking');
    const sceneDetailUnavailableReason = terminalBindingFailure
      ? bootstrapSceneBindingStatus ?? 'unavailable'
      : legacySceneDebug && cityRendererV2 && legacyBootstrapScenePack?.sourceDetailStatus !== 'available'
        ? legacyBootstrapScenePack?.sourceDetailStatus ?? null
        : null;
    const runtime = new SceneRuntime({
      verifiedCityBuildings,
      aggregateRoadFlows,
      presentationMovement,
      onMapFeatures: (features) => onMapFeaturesRef.current?.(features),
      root,
      container,
      telemetry,
      camera: targetCamera,
      entities: renderedEntities,
      entitiesV2,
      mobilityPresentationMovement,
      sceneCellHints,
      selectedId,
      activeLayers,
      presentationMinutes,
      presentationClock,
      reducedMotion,
      performanceMode,
      rendererQuality,
      weather,
      weatherVisualOverride,
      cityRendererV2,
      rendererMode,
      mapProvider,
      sceneCachePolicy,
      sceneMemoryBudgetBytes,
      sceneDeviceTier,
      scenePack: runtimeBootstrapScenePack,
      sceneDetailUnavailableReason,
      onSelect: recordPick,
      onBuildingSelect: recordBuildingPick,
      onVerifiedMovementChange: recordVerifiedMovement,
      onCameraChange: (nextCamera) => onCameraChangeRef.current?.(nextCamera),
      onViewportChange: (viewport) => onViewportChangeRef.current?.(viewport),
      onSourceState: setSourceState,
      onPartsState: setParts,
      onReadiness: setReadiness,
    });
    runtimeRef.current = runtime;
    runtime.setHighlightedBuilding(highlightedBuildingId);
    void runtime.start();

    return () => {
      if (runtimeRef.current === runtime) runtimeRef.current = null;
      runtime.dispose();
      telemetry.dispose();
      if (telemetryRef.current === telemetry) telemetryRef.current = null;
    };
  }, [
    cameraResolved,
    cityRendererV2,
    legacySceneDebug,
    mapEnabled,
    mapProvider,
    networkRevision,
    performanceMode,
    reducedMotion,
    rendererQuality,
    rendererMode,
    sceneCachePolicy,
    sceneDeviceTier,
    sceneMemoryBudgetBytes,
    legacyBootstrapScenePack?.immutableCellBaseUrl,
    legacyBootstrapScenePack?.loadCell,
    legacyBootstrapScenePack?.loadManifest,
    legacyBootstrapScenePack?.manifest,
    legacyBootstrapScenePack?.manifestSha256,
    legacyBootstrapScenePack?.manifestUrl,
    legacyBootstrapScenePack?.sceneId,
    legacyBootstrapScenePack?.sceneTimeZone,
    legacyBootstrapScenePack?.sceneVersion,
    legacyBootstrapScenePack?.sourceDetailStatus,
    bootstrapSceneBindingStatus,
  ]);

  useEffect(() => {
    if (!cameraResolved) return;
    const runtime = runtimeRef.current;
    runtime?.updateScene({
      verifiedCityBuildings,
      aggregateRoadFlows,
      presentationMovement,
      camera: targetCamera,
      entities: renderedEntities,
      entitiesV2,
      mobilityPresentationMovement,
      selectedId,
      presentationMinutes,
      presentationClock,
      reducedMotion,
      weather,
      weatherVisualOverride,
      rendererQuality,
      scenePack,
      living: null,
    });
    runtime?.updateSceneCellHints(sceneCellHints);
  }, [
    cameraResolved,
    aggregateRoadFlows,
    verifiedCityBuildings,
    presentationMovement,
    presentationMinutes,
    presentationClock,
    reducedMotion,
    rendererQuality,
    renderedEntities,
    entitiesV2,
    mobilityPresentationMovement,
    sceneCellHints,
    scenePack,
    selectedId,
    targetCamera,
    weather,
    weatherVisualOverride,
  ]);

  useEffect(() => {
    runtimeRef.current?.updateLayers(activeLayers);
  }, [activeLayers]);

  useEffect(() => {
    runtimeRef.current?.setHighlightedBuilding(highlightedBuildingId);
  }, [highlightedBuildingId]);

  useEffect(() => {
    if (cameraResolved) runtimeRef.current?.updateCamera(targetCamera);
  }, [cameraResolved, targetCamera]);

  const isFallback = sourceState === 'offline_fallback';
  const modelSceneDetailUnavailable = cityRendererV2 && (
    (sceneBindingStatus !== undefined && sceneBindingStatus !== 'compatible') ||
    (scenePack !== null && scenePack.sourceDetailStatus !== 'available') ||
    modelOverlayStatus === 'unavailable'
  );
  const terminalSceneDetail = legacySceneDebug && modelSceneDetailUnavailable;
  const baseCapability = rendererCapability(parts, isFallback, rendererMode);
  const v2Ready = readiness.manifestVerified &&
    readiness.cellsReady &&
    readiness.contributionsReady;
  const representationComplete = Number.isFinite(representationCoverage)
    && representationCoverage >= 1
    && representationConsistent;
  const capability = terminalSceneDetail && parts.maplibre
    ? 'degraded'
    : legacySceneDebug && cityRendererV2 && baseCapability === 'ready' && !v2Ready
      ? 'initializing'
      : baseCapability;
  const sceneDetailStatus = resolveSceneDetailDisplayStatus({
    cityRendererV2,
    isFallback,
    terminalSceneDetail: modelSceneDetailUnavailable,
    sourceDetailStatus: scenePack?.sourceDetailStatus ?? null,
    capability,
    v2Ready,
    representationComplete,
    contributionDetailStatus: readiness.contributionDetailStatus,
  });
  const showsSyntheticAppearanceDisclosure =
    sceneVisualReadiness?.geometryStatus === 'SCENE_GEOMETRY_READY'
    && sceneVisualReadiness.appearanceStatus === 'APPEARANCE_SYNTHETIC';
  const adapterLabel = [
    parts.maplibre ? 'maplibre' : null,
    parts.deck ? 'deck' : null,
    parts.three ? 'three' : null,
  ].filter(Boolean).join('+') || 'canvas';
  const nightOpacity = 1 - Math.max(
    0,
    Math.sin(((presentationMinutes - 360) / 1_440) * Math.PI),
  );
  const hasAuthoritativeSceneWeather = cityRendererV2
    && scenePack?.sourceDetailStatus === 'available';
  const displayedWeather = weatherVisualOverride
    ?? (hasAuthoritativeSceneWeather ? 'scene' : weather);
  const weatherOwner = weatherVisualOverride !== null
    ? 'visual_override'
    : hasAuthoritativeSceneWeather
      ? 'scene_pack'
      : 'legacy';
  const visibleEnvironmentStatus = weatherOwner === 'visual_override'
    ? 'WEATHER_SYNTHETIC'
    : environmentBinding?.status
      ?? (weatherOwner === 'scene_pack' ? 'WEATHER_UNAVAILABLE' : 'WEATHER_SYNTHETIC');
  const visibleEnvironmentReason = weatherOwner === 'visual_override'
    ? 'visual_override'
    : environmentBinding?.reason ?? 'none';
  const visibleEnvironmentLabel = weatherOwner === 'visual_override'
    ? 'Визуальный погодный override · visual_synthesis'
    : environmentBinding?.label
      ?? (weatherOwner === 'scene_pack'
        ? 'Погодный слой недоступен'
        : 'Синтетический погодный пресет');

  return (
    <div
      ref={sceneRootRef}
      className={`ot-world-scene ot-world-scene--${viewMode} ot-world-scene--${displayedWeather} ${className}`}
      data-testid="world-canvas"
      data-map-source-state={sourceState}
      data-map-provider={mapProvider}
      data-renderer-mode={rendererMode}
      data-model-overlay-status={modelOverlayStatus}
      data-renderer-adapters={adapterLabel}
      data-renderer-state={capability}
      data-renderer-quality={rendererQuality}
      data-performance-policy-status={performancePolicyV3.status}
      data-performance-policy-source={performancePolicyV3.source}
      data-performance-policy-contract-version={performancePolicyV3.policy.contractVersion}
      data-performance-policy-id={performancePolicyV3.policy.policyId}
      data-performance-policy-requested-tier={performancePolicyV3.requestedTier}
      data-performance-policy-tier={performancePolicyV3.policy.tier}
      data-performance-policy-reduced-motion={performancePolicyV3.policy.reducedMotion}
      data-performance-policy-minimum-moving-fps={performancePolicyV3.policy.minimumMovingFps}
      data-performance-policy-error-kind={performancePolicyV3.errorKind ?? 'none'}
      data-city-renderer-version={cityRendererV2 ? 'v2' : 'legacy'}
      data-scene-mode={viewMode}
      data-scene-status={capability}
      data-scene-id={scenePack?.sceneId ?? 'unresolved'}
      data-scene-binding-status={sceneBindingStatus ?? 'unresolved'}
      data-scene-source-detail-status={scenePack?.sourceDetailStatus ?? 'unresolved'}
      data-scene-detail-status={sceneDetailStatus}
      data-scene-detail-reason={modelSceneDetailUnavailable
        ? scenePack?.sourceDetailStatus ?? sceneBindingStatus ?? 'unavailable'
        : 'none'}
      data-scene-manifest-verified={readiness.manifestVerified}
      data-scene-manifest-sha256={scenePack?.manifestSha256 ?? 'unresolved'}
      data-scene-cells-ready={readiness.cellsReady}
      data-scene-contributions-ready={readiness.contributionsReady}
      data-camera-resolved={cameraResolved}
      data-environment-day-phase={environmentDayPhase(presentationMinutes)}
      data-environment-weather={displayedWeather === 'scene' ? undefined : displayedWeather}
      data-environment-weather-owner={weatherOwner}
      data-environment-weather-override={weatherVisualOverride ?? 'none'}
      data-representation-coverage={representationCoverage}
      data-representation-complete={representationComplete}
      data-representation-consistent={representationConsistent}
      data-visible-entities={visibleEntities.length}
      data-visible-pedestrians={visiblePedestrians}
      data-visible-vehicles={visibleVehicles}
      data-selected-entity-id={selectedId ?? 'none'}
      data-selected-entity-visible={selectedVisibleEntity !== null}
      data-selected-entity-centered={selectedEntityCentered}
      data-pick-revision={pickEvidence.revision}
      data-last-picked-entity-id={pickEvidence.entityId}
      data-last-picked-entity-representation={pickEvidence.representation}
    >
      <div
        ref={mapContainerRef}
        className="ot-world-scene__map"
        aria-hidden={isFallback || !cameraResolved}
      />
      {isFallback && !hideTechnicalHud ? (
        <div className="ot-world-scene__fallback" data-testid="offline-fallback">
          <CanvasFallback
            camera={targetCamera}
            entities={renderedEntities}
            selectedId={selectedId}
            onSelect={recordPick}
            presentationMinutes={presentationMinutes}
            weather={weather}
            viewMode={viewMode}
            activeLayers={activeLayers}
            reducedMotion={reducedMotion}
          />
        </div>
      ) : null}
      {sourceState === 'checking' ? (
        <div className="ot-world-scene__loading" role="status">
          <span className="ot-world-scene__spinner" />
          Подключаем картографию…
        </div>
      ) : null}
      <div
        className="ot-world-scene__diagnostics"
        hidden={hideTechnicalHud}
        aria-label={diagnostics ? 'Диагностика renderer и источник погоды' : 'Источник погоды'}
        style={showsSyntheticAppearanceDisclosure ? {
          flexWrap: 'wrap',
          maxWidth: 'calc(100% - 28px)',
        } : undefined}
      >
        {diagnostics ? (
          <output
            className={`ot-world-scene__capability ot-world-scene__capability--${capability}`}
            data-testid="renderer-capability-status"
            role="status"
          >
            {rendererCapabilityLabel(capability, rendererMode)}
          </output>
        ) : null}
        <output
          className="ot-world-scene__environment"
          data-testid="environment-binding-status"
          data-weather-binding-status={visibleEnvironmentStatus}
          data-weather-binding-reason={visibleEnvironmentReason}
          role="status"
        >
          {visibleEnvironmentLabel}
        </output>
        {showsSyntheticAppearanceDisclosure ? (
          <output
            className="ot-world-scene__environment ot-world-scene__appearance"
            data-testid="scene-appearance-status"
            role="status"
            style={{ flexBasis: '100%', maxWidth: '100%', whiteSpace: 'normal' }}
          >
            {MIXED_SOURCE_APPEARANCE_LABEL_RU}
          </output>
        ) : null}
        {diagnostics ? (
          <output className="ot-world-scene__fps" data-testid="renderer-fps">FPS …</output>
        ) : null}
      </div>
      {!diagnostics && parts.livingWorkerFallback ? (
        <output
          className="ot-world-scene__capability ot-world-scene__capability--degraded ot-world-scene__worker-warning"
          data-testid="living-worker-fallback-status"
          role="status"
        >
          RENDERER_DEGRADED · WORKER_FALLBACK
        </output>
      ) : null}
      <div
        className="ot-world-scene__night"
        style={{ opacity: Math.min(0.42, nightOpacity * 0.32) }}
        aria-hidden="true"
      />
      {displayedWeather === 'rain' && activeLayers.has('weather') ? (
        <div className="ot-world-scene__rain" aria-hidden="true" />
      ) : null}
      {displayedWeather === 'snow' && activeLayers.has('weather') ? (
        <div className="ot-world-scene__snow" aria-hidden="true" />
      ) : null}
    </div>
  );
}
