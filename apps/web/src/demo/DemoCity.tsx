import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { WorldScene } from '../renderer/WorldScene';
import type { MapSourceState, RendererBuildingSelection, RendererMapFeatureSnapshot, RendererViewportSnapshot, RendererQuality, VisualEntity, WorldCamera } from '../renderer/types';
import type { StaticDemoProvider } from './data';
import type { MovementCoverage } from './data/CityDemoProviderV2';
import type { DemoContextV1 } from './types';
import { buildCityRoadGraph } from './cityRoadGraph';
import { cityLayoutFromFeatures } from './cityLayout';
import { buildCityPresenceFrame, cityPresenceAnchorMinutes, CITY_PRESENTATION_EPOCH_SECONDS } from './cityPresence';
import { buildAggregateRoadFlows } from './aggregateRoadFlows';
import { RetainedCityGeometry } from './retainedCityGeometry';
import type { CityPackV2 } from './data/CityPackV2';
import { useCityMovementPreparation, cityMovementHandoff, retainCityOverviewFlows } from './useCityMovementPreparation';
import './city.css';
const TiledGameScene=lazy(()=>import('../renderer/game/TiledGameScene'));

export interface DemoCitySelection {
  kind: 'person' | 'vehicle' | 'building';
  id: string;
  label: string;
  coordinates?: readonly [number, number];
}

export interface DemoCityProps {
  provider: StaticDemoProvider;
  context: DemoContextV1;
  selectedId?: string | null;
  quality?: RendererQuality;
  viewMode?: '2d' | '3d';
  onCameraChange?: (camera: WorldCamera) => void;
  onSelect?: (selection: DemoCitySelection | null) => void;
  onLayoutChange?: () => void;
}

/** The original renderer, supplied exclusively by fictional public demo data. */
export function DemoCity({ provider, context, selectedId = null, quality = 'balanced', viewMode, onCameraChange, onSelect, onLayoutChange }: DemoCityProps) {
  const section = useRef<HTMLElement>(null);
  const [drawn, setDrawn] = useState({ people: 0, vehicles: 0, aggregateFlows: 0, frames: 0 });
  useEffect(() => {
    const element = section.current;
    if (!element) return;
    const read = () => {
      const world = element.querySelector<HTMLElement>('[data-testid="world-canvas"]');
      if (!world) return;
      const next = { people: Number(world.dataset.deckPedestrians || 0), vehicles: Number(world.dataset.deckVehicles || 0), aggregateFlows: Number(world.dataset.deckAggregateRoadFlows || 0), frames: Number(world.dataset.deckRenderedFrames || 0) };
      setDrawn((previous) => previous.people === next.people && previous.vehicles === next.vehicles && previous.aggregateFlows === next.aggregateFlows && Boolean(previous.frames) === Boolean(next.frames) ? previous : next);
    };
    const observer = new MutationObserver(read);
    observer.observe(element, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-deck-pedestrians', 'data-deck-vehicles', 'data-deck-aggregate-road-flows', 'data-deck-rendered-frames'] });
    read();
    return () => observer.disconnect();
  }, []);
  const [sourceState, setSourceState] = useState<MapSourceState>('checking');
  const [layoutRevision, setLayoutRevision] = useState(0);
  const [viewport, setViewport] = useState<RendererViewportSnapshot | null>(null);
  const handleViewport = useCallback((next: RendererViewportSnapshot) => {
    setViewport(previous => previous?.revision === next.revision ? previous : next);
  }, []);
  const layoutSignature = useRef('');
  const seek = useRef({ minutes: context.presentationMinutes, command: context.presentationSeekRevision, revision: 0 });
  if (context.presentationSeekRevision !== seek.current.command || Math.abs(context.presentationMinutes - seek.current.minutes) > 2) seek.current.revision += 1;
  seek.current.minutes = context.presentationMinutes;
  seek.current.command = context.presentationSeekRevision;
  const movementMinute = cityPresenceAnchorMinutes(context.presentationMinutes);
  const individualView = context.camera.zoom >= 15.5;
  const cameraCell = `${context.camera.longitude.toFixed(3)}:${context.camera.latitude.toFixed(3)}:${Math.floor(context.camera.zoom)}`;
  // The radius fallback is initial-only. Rotation, fractional zoom and CSS
  // resize each get one actual-bound request after the MapLibre event settles.
  const viewportRevision = viewport?.revision ?? cameraCell;
  const onPrepared=useCallback(()=>{setLayoutRevision(value=>value+1);onLayoutChange?.();},[onLayoutChange]);
  const preparation=useCityMovementPreparation({provider,context,viewport,revision:viewportRevision,onPrepared});
  const populationState=preparation.status, populationError=preparation.error;
  const vehicleSelectionScope=JSON.stringify([context.scenario,context.year,context.territoryId,context.cohort,seek.current.revision,individualView,quality,context.cityGraphicsBackend]);
  const previousVehicleSelection=useRef<{provider:StaticDemoProvider;scope:string;ids:ReadonlySet<string>}|null>(null);
  const frame = useMemo(() => buildCityPresenceFrame(provider, { ...context, presentationMinutes: movementMinute }, {
    maxPeople: individualView ? quality === 'performance' ? 160 : quality === 'cinematic' ? 1200 : 500 : 0,
    maxVehicles: individualView ? quality === 'performance' ? 320 : quality === 'cinematic' ? 1800 : 800 : 0,
    selectedId,
    preserveActiveVehicleMembership:context.cityGraphicsBackend==='tiled_game',
    previousVehicleIds:previousVehicleSelection.current?.provider===provider&&previousVehicleSelection.current.scope===vehicleSelectionScope
      ?previousVehicleSelection.current.ids:undefined,
  }), [provider, context.scenario, context.year, context.territoryId, context.cohort, movementMinute, cameraCell, individualView, quality, selectedId, layoutRevision,vehicleSelectionScope]);
  useEffect(()=>{
    // Preference belongs to a committed display, not to new hash-ranked candidates
    // at every five-second anchor. Current provider presence still owns membership
    // and positions: an absent/inactive car is never resurrected from this ID set.
    if(populationState==='loading'&&preparation.lastCommittedRenderable&&!frame.entities.length
      &&previousVehicleSelection.current?.provider===provider&&previousVehicleSelection.current.scope===vehicleSelectionScope)return;
    previousVehicleSelection.current={provider,scope:vehicleSelectionScope,ids:new Set(frame.entities.filter(entity=>entity.kind==='vehicle').map(entity=>entity.id))};
  },[provider,vehicleSelectionScope,frame,populationState,preparation.lastCommittedRenderable]);
  const layoutCounts = useMemo(() => {
    const layout = provider.getLayout();
    return { buildings: layout.buildings.length, roads: layout.roads.length };
  }, [provider, layoutRevision]);
  const exactCityPack = 'cityPackV2' in provider ? provider.cityPackV2 as CityPackV2 : null;
  const retainedGeometry=useRef<RetainedCityGeometry>(null!);
  if(!retainedGeometry.current)retainedGeometry.current=new RetainedCityGeometry();
  const geometry = useMemo(() => {
    if (!exactCityPack) return null;
    const cells = exactCityPack.getActiveCells();
    if (!cells.length && exactCityPack.telemetry.status === 'empty') return null;
    return retainedGeometry.current.update({ datasetVersion: exactCityPack.manifest.datasetVersion, cells, viewport: viewport ?? undefined,
      sourceCoverage: exactCityPack.manifest.bounds && exactCityPack.manifest.cells
        ? { bounds: exactCityPack.manifest.bounds, cells: exactCityPack.manifest.cells } : undefined });
  }, [exactCityPack, layoutRevision, viewportRevision, populationState]);
  const verifiedCityBuildings=geometry?.buildings??null;
  const gameSourceRoads=context.cityGraphicsBackend==='tiled_game'?geometry?.roads:undefined;
  const gameSourceCorridors=useMemo(()=>context.cityGraphicsBackend==='tiled_game'?provider.getLayout().roads:undefined,
    [provider,layoutRevision,frame,context.cityGraphicsBackend]);
  // Do not replace the city's streamed buildings with a bounded central patch.
  // Outside close, completely covered views, preserve the whole OMT source.
  const exactBuildingSource = individualView && verifiedCityBuildings?.coverage === 'complete_viewport' ? verifiedCityBuildings : null;
  const handoff=cityMovementHandoff(individualView,preparation.lastCommittedRenderable,frame.peopleCount+frame.vehicleCount);
  const previousFlows=useRef<ReturnType<typeof buildAggregateRoadFlows>|null>(null);
  const availableFlows = useMemo(() => buildAggregateRoadFlows({
    origin: [viewport?.camera.longitude ?? context.camera.longitude, viewport?.camera.latitude ?? context.camera.latitude],
    viewport: viewport ?? undefined,
    roads: provider.getLayout().roads.map(road => ({ ...road,
      className: 'source-road', oneway: road.oneway ? 1 as const : 0 as const,
      walkable: road.walkable !== false, drivable: road.drivable !== false,
    })), maxInstances: quality === 'performance' ? 48 : 96,
  }), [provider, cameraCell, viewportRevision, individualView, quality, layoutRevision]);
  const aggregateFlows=retainCityOverviewFlows(handoff,availableFlows,previousFlows.current);
  if(availableFlows?.segments.length)previousFlows.current=availableFlows;
  const clock = useMemo(() => ({
    absolutePresentationSeconds: CITY_PRESENTATION_EPOCH_SECONDS + context.presentationMinutes * 60,
    paused: !context.playing,
    baseRateSecondsPerWallSecond: 1,
    speedMultiplier: Math.max(0.1, context.speed),
    seekRevision: seek.current.revision,
  }), [context.presentationMinutes, context.playing, context.speed, context.presentationSeekRevision]);

  const handleFeatures = useCallback((snapshot: RendererMapFeatureSnapshot) => {
    const roads = buildCityRoadGraph({
      features: snapshot.transportation.flatMap((feature) => (
        feature.geometry.type === 'LineString' || feature.geometry.type === 'MultiLineString'
          ? [{ id: feature.id, properties: feature.properties, geometry: feature.geometry }]
          : []
      )),
      origin: [snapshot.camera.longitude, snapshot.camera.latitude],
      presentationTimeSeconds: CITY_PRESENTATION_EPOCH_SECONDS,
      maxDistanceMeters: 2_500, maxPeople: 0, maxCars: 0,
    });
    const layout = cityLayoutFromFeatures(snapshot, roads.roads);
    const signature = `${roads.signature}:${layout.buildings.map((item) => item.id).sort().join(',')}`;
    if (layoutSignature.current === signature) return;
    layoutSignature.current = signature;
    provider.registerLayout(layout);
    setLayoutRevision((value) => value + 1);
    onLayoutChange?.();
  }, [provider, onLayoutChange]);

  const selectActor = useCallback((entity: VisualEntity | null) => {
    if (!entity) { onSelect?.(null); return; }
    const person = entity.kind === 'vehicle' ? null : provider.getPerson(entity.id, context.scenario, context.year);
    const vehicle = entity.kind === 'vehicle' ? provider.getVehicle(entity.id, context.presentationMinutes, context.scenario, context.year) : null;
    onSelect?.({ kind: entity.kind === 'vehicle' ? 'vehicle' : 'person', id: entity.id,
      label: person?.name ?? vehicle?.label ?? 'Демонстрационный объект',
      coordinates: [entity.longitude, entity.latitude] });
  }, [provider, context.scenario, context.year, context.presentationMinutes, onSelect]);

  const selectBuilding = useCallback((selection: RendererBuildingSelection | null) => {
    if (!selection) return;
    const building = provider.getLayout().buildings.find((item) => item.id === selection.canonicalId);
    onSelect?.({ kind: 'building', id: selection.canonicalId, label: building?.name || 'Здание Челябинска', coordinates: building?.center });
  }, [provider, onSelect]);

  const unavailable = sourceState === 'offline_fallback';
  const movementCoverage = 'movementCoverage' in provider ? provider.movementCoverage as MovementCoverage : null;
  const highlightedBuildingId = selectedId?.startsWith('openmaptiles_buildings:') ? selectedId
    : selectedId ? provider.getPresence(selectedId, context.presentationMinutes, context.scenario, context.year)?.buildingId ?? null : null;
  return <section ref={section} className="demo-city" data-testid="demo-city" aria-label="Живой Челябинск"
    data-source-state={sourceState} data-map-features-ready={layoutCounts.roads > 0 && layoutCounts.buildings > 0}
    data-layout-buildings={layoutCounts.buildings} data-layout-roads={layoutCounts.roads}
    data-population-state={populationState}
    data-population-error={populationError}
    data-movement-handoff={handoff}
    data-movement-updating={preparation.updating}
    data-movement-preview={provider.movementPreviewOverlay?.version??'none'}
    data-graphics-backend={context.cityGraphicsBackend??'native_map'}
    data-movement-coverage={movementCoverage ? JSON.stringify(movementCoverage) : undefined}
    data-vehicle-declutter={JSON.stringify(frame.vehicleDeclutter)}
    data-visible-people={drawn.frames ? drawn.people : 0} data-visible-vehicles={drawn.frames ? drawn.vehicles : 0}
    data-scheduled-people={frame.peopleCount} data-scheduled-vehicles={frame.vehicleCount}
    data-flow-allocation={aggregateFlows?.diagnostics.allocation ?? 'none'}
    data-flow-occupied-cells={aggregateFlows?.diagnostics.occupiedViewportCells ?? 0}
    data-flow-selected-cells={aggregateFlows?.diagnostics.selectedViewportCells ?? 0}
    data-building-geometry-coverage={verifiedCityBuildings?.coverage ?? (exactCityPack ? 'loading' : 'basemap')}
    data-building-geometry-mode={exactBuildingSource ? 'verified_exact' : 'basemap'}>
    <Suspense fallback={<div className="demo-city__notice">Подготавливаем графический слой</div>}>
    {(() => { const Scene=context.cityGraphicsBackend==='tiled_game'?TiledGameScene:WorldScene;return <Scene camera={context.camera} viewMode={viewMode ?? (context.camera.pitch === 0 ? '2d' : '3d')} entities={frame.entities}
      populationDatasetId={provider.manifest.datasetId}
      mobilityPresentationMovement={frame.movementEntities} presentationMovement={frame.movement}
      aggregateRoadFlows={aggregateFlows}
      verifiedCityBuildings={exactBuildingSource}
      verifiedCityBuildingBounds={exactBuildingSource?viewport?.bbox:undefined}
      gameSourceRoads={gameSourceRoads}
      gameSourceCorridors={gameSourceCorridors}
      trafficContextKey={JSON.stringify([provider.manifest.datasetId,context.scenario,context.year,context.territoryId,context.cohort])}
      selectedId={selectedId} onSelect={selectActor} onBuildingSelect={selectBuilding}
      highlightedBuildingId={highlightedBuildingId}
      onCameraChange={onCameraChange} onViewportChange={handleViewport} onMapFeatures={handleFeatures} onSourceStateChange={setSourceState}
      presentationMinutes={context.presentationMinutes} presentationClock={clock}
      weather={context.weather} weatherVisualOverride={context.weather} rendererQuality={quality}
      diagnostics={false} hideTechnicalHud cityRendererV2 mapProvider="openfreemap" rendererMode="universal_lowpoly" />; })()}
    </Suspense>
    {unavailable ? <div className="demo-city__offline" role="status"><strong>Карта временно недоступна</strong><span>Проверьте подключение к интернету. Демонстрационные профили и аналитика продолжают работать.</span></div> : null}
    <div className="demo-city__caption"><span className="demo-city__live-dot" />
      <span>{!individualView && layoutCounts.roads > 0 ? 'Общий план города' : drawn.frames && drawn.people + drawn.vehicles > 0 ? 'Город живёт' : populationState==='loading' ? 'Загружаем движение рядом с камерой' : movementCoverage?.status==='partial' ? 'Неполная выборка движения' : drawn.frames ? 'Нет перемещений в выбранной области' : 'Загружаем городской слой'}</span>
      {layoutCounts.roads && (!individualView || drawn.frames > 0) ? <span className="demo-city__counts">{individualView ? `${drawn.people} пешеходов · ${drawn.vehicles} машин в слое` : `${drawn.aggregateFlows} условных дорожных потоков · не число машин или жителей. Приблизьте карту, чтобы увидеть жителей`}</span> : null}
      {preparation.updating?<span className="demo-city__counts">Обновляем выборку · текущее движение сохранено</span>:null}
      {provider.movementPreviewOverlay?<span className="demo-city__counts">Маршруты квартала{provider.movementPreviewOverlay.delivery==='public_pinned'?'':' · локальная проверка'}</span>:null}
      {sourceState === 'online_degraded' ? <span className="demo-city__coverage" role="status">Часть картографических слоёв загружается</span> : null}
      {populationState === 'error' ? <span className="demo-city__coverage" role="status">Не удалось загрузить жителей этой области. Карта остаётся доступной.</span> : null}
      {individualView && populationState === 'ready' && movementCoverage?.status === 'partial'
        ? <span className="demo-city__coverage" role="status">Показана ограниченная выборка движения. Приблизьте карту для более полного покрытия улиц.</span> : null}
      {exactCityPack && !exactBuildingSource ? <span className="demo-city__coverage" data-testid="building-coverage-notice" role="status">
        {!individualView ? 'На общем плане — базовая карта. Приблизьте её для точного выбора зданий.'
          : 'Пока показана полная базовая карта. Для точного выбора зданий нужен весь обзор: дождитесь загрузки или приблизьте карту.'}
      </span> : null}
    </div>
    <div className="demo-city__hint">Выберите человека, автомобиль или здание</div>
  </section>;
}
