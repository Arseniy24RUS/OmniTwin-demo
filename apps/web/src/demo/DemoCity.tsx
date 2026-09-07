import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { WorldScene } from '../renderer/WorldScene';
import type { MapSourceState, RendererBuildingSelection, RendererMapFeatureSnapshot, RendererQuality, VisualEntity, WorldCamera } from '../renderer/types';
import type { StaticDemoProvider } from './data';
import type { DemoContextV1 } from './types';
import { buildCityRoadGraph } from './cityRoadGraph';
import { cityLayoutFromFeatures } from './cityLayout';
import { buildCityPresenceFrame, CITY_PRESENTATION_EPOCH_SECONDS } from './cityPresence';
import './city.css';

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
  const [drawn, setDrawn] = useState({ people: 0, vehicles: 0, frames: 0 });
  useEffect(() => {
    const element = section.current;
    if (!element) return;
    const read = () => {
      const world = element.querySelector<HTMLElement>('[data-testid="world-canvas"]');
      if (!world) return;
      const next = { people: Number(world.dataset.deckPedestrians || 0), vehicles: Number(world.dataset.deckVehicles || 0), frames: Number(world.dataset.deckRenderedFrames || 0) };
      setDrawn((previous) => previous.people === next.people && previous.vehicles === next.vehicles && Boolean(previous.frames) === Boolean(next.frames) ? previous : next);
    };
    const observer = new MutationObserver(read);
    observer.observe(element, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-deck-pedestrians', 'data-deck-vehicles', 'data-deck-rendered-frames'] });
    read();
    return () => observer.disconnect();
  }, []);
  const [sourceState, setSourceState] = useState<MapSourceState>('checking');
  const [layoutRevision, setLayoutRevision] = useState(0);
  const layoutSignature = useRef('');
  const seek = useRef({ minutes: context.presentationMinutes, revision: 0 });
  if (Math.abs(context.presentationMinutes - seek.current.minutes) > 2) seek.current.revision += 1;
  seek.current.minutes = context.presentationMinutes;
  const minute = Math.floor(context.presentationMinutes);
  const individualView = context.camera.zoom >= 15.5;
  const cameraCell = `${context.camera.longitude.toFixed(3)}:${context.camera.latitude.toFixed(3)}:${Math.floor(context.camera.zoom)}`;
  const frame = useMemo(() => buildCityPresenceFrame(provider, { ...context, presentationMinutes: minute }, {
    maxPeople: individualView ? quality === 'performance' ? 180 : 500 : 0,
    maxVehicles: individualView ? quality === 'performance' ? 40 : 100 : 0,
    selectedId,
  }), [provider, context.scenario, context.year, context.territoryId, context.cohort, minute, cameraCell, individualView, quality, selectedId, layoutRevision]);
  const layoutCounts = useMemo(() => {
    const layout = provider.getLayout();
    return { buildings: layout.buildings.length, roads: layout.roads.length };
  }, [provider, layoutRevision]);
  const clock = useMemo(() => ({
    absolutePresentationSeconds: CITY_PRESENTATION_EPOCH_SECONDS + context.presentationMinutes * 60,
    paused: !context.playing,
    baseRateSecondsPerWallSecond: 1,
    speedMultiplier: Math.max(0.1, context.speed),
    seekRevision: seek.current.revision,
  }), [context.presentationMinutes, context.playing, context.speed]);

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
  const highlightedBuildingId = selectedId?.startsWith('openmaptiles_buildings:') ? selectedId
    : selectedId ? provider.getPresence(selectedId, context.presentationMinutes, context.scenario, context.year)?.buildingId ?? null : null;
  return <section ref={section} className="demo-city" data-testid="demo-city" aria-label="Живой Челябинск"
    data-source-state={sourceState} data-map-features-ready={layoutCounts.roads > 0 && layoutCounts.buildings > 0}
    data-layout-buildings={layoutCounts.buildings} data-layout-roads={layoutCounts.roads}
    data-visible-people={drawn.frames ? drawn.people : 0} data-visible-vehicles={drawn.frames ? drawn.vehicles : 0}
    data-scheduled-people={frame.peopleCount} data-scheduled-vehicles={frame.vehicleCount}>
    <WorldScene camera={context.camera} viewMode={viewMode ?? (context.camera.pitch === 0 ? '2d' : '3d')} entities={frame.entities}
      mobilityPresentationMovement={frame.movementEntities} presentationMovement={frame.movement}
      selectedId={selectedId} onSelect={selectActor} onBuildingSelect={selectBuilding}
      highlightedBuildingId={highlightedBuildingId}
      onCameraChange={onCameraChange} onMapFeatures={handleFeatures} onSourceStateChange={setSourceState}
      presentationMinutes={context.presentationMinutes} presentationClock={clock}
      weather={context.weather} weatherVisualOverride={context.weather} rendererQuality={quality}
      diagnostics={false} hideTechnicalHud cityRendererV2 mapProvider="openfreemap" rendererMode="universal_lowpoly" />
    {unavailable ? <div className="demo-city__offline" role="status"><strong>Карта временно недоступна</strong><span>Проверьте подключение к интернету. Демонстрационные профили и аналитика продолжают работать.</span></div> : null}
    {sourceState === 'online_degraded' ? <div className="demo-city__notice" role="status">Часть картографических слоёв загружается</div> : null}
    <div className="demo-city__caption"><span className="demo-city__live-dot" />
      <span>{drawn.frames && drawn.people + drawn.vehicles > 0 ? 'Город живёт' : 'Загружаем городской слой'}</span>
      {layoutCounts.roads && (!individualView || drawn.frames > 0) ? <span className="demo-city__counts">{individualView ? `${drawn.people} пешеходов · ${drawn.vehicles} машин в слое` : 'Приблизьте карту, чтобы увидеть жителей'}</span> : null}
    </div>
    <div className="demo-city__hint">Выберите человека, автомобиль или здание</div>
  </section>;
}
