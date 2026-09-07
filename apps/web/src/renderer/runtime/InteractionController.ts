import type { Map as MapLibreMap, MapMouseEvent } from 'maplibre-gl';
import type {
  RendererAdapter,
  RendererBuildingSelection,
  RendererViewportSnapshot,
  VisualEntity,
  WorldCamera,
} from '../types';
import {
  LivingPrimaryRenderer,
  type LivingPartition,
  type LivingRenderFrame,
} from '../living/types';

const METERS_PER_LATITUDE_DEGREE = 110_540;

function normalizedLongitude(longitude: number): number {
  return ((longitude + 540) % 360) - 180;
}

export interface CameraTelemetryState {
  current: WorldCamera;
  target: WorldCamera;
  settled: boolean;
}

export interface InteractionControllerOptions {
  map: MapLibreMap;
  getEntities: () => readonly VisualEntity[];
  /** Optional retained O(1) lookup for GPU-picked logical IDs. */
  getEntityById?: (id: string) => VisualEntity | null;
  /** Retained render columns used by the adapters; null preserves the legacy static path. */
  getLiving?: () => {
    readonly partition: LivingPartition;
    readonly frame: LivingRenderFrame;
  } | null | undefined;
  /** Click-only GPU picking seam; omitted by legacy adapters. */
  pickAt?: RendererAdapter['pickAt'];
  /** Exactly one click-only semantic MapLibre building query after an actor GPU miss. */
  pickBuildingAt?: (x: number, y: number) => RendererBuildingSelection | null;
  /** Legacy/debug safety net. Universal mode keeps click cost independent of actor count. */
  allowCpuEntityPicking?: boolean;
  readTargetCamera: () => WorldCamera;
  onSelect?: (entity: VisualEntity | null) => void;
  onBuildingSelect?: (building: RendererBuildingSelection | null) => void;
  onCameraChange?: (camera: WorldCamera) => void;
  onViewportChange?: (viewport: RendererViewportSnapshot) => void;
  onCamera?: (state: CameraTelemetryState) => void;
  onStreamCamera?: (camera: WorldCamera) => void;
  /** Announces camera motion before the expensive shared canvas renders it. */
  onMotionChange?: (moving: boolean) => void;
  onIdle?: (camera: WorldCamera) => void;
}

export function cameraChanged(left: WorldCamera, right: WorldCamera): boolean {
  return (
    Math.abs(left.longitude - right.longitude) > 0.00001 ||
    Math.abs(left.latitude - right.latitude) > 0.00001 ||
    Math.abs(left.zoom - right.zoom) > 0.02 ||
    Math.abs(left.pitch - right.pitch) > 0.2 ||
    Math.abs(left.bearing - right.bearing) > 0.2
  );
}

export function readMapCamera(map: MapLibreMap): WorldCamera {
  const center = map.getCenter();
  return {
    longitude: center.lng,
    latitude: center.lat,
    zoom: map.getZoom(),
    pitch: map.getPitch(),
    bearing: map.getBearing(),
  };
}

export class InteractionController {
  private disposed = false;
  private readonly map: MapLibreMap;
  private readonly getEntities: () => readonly VisualEntity[];
  private readonly getEntityById?: InteractionControllerOptions['getEntityById'];
  private readonly getLiving?: InteractionControllerOptions['getLiving'];
  private readonly pickAt?: InteractionControllerOptions['pickAt'];
  private readonly pickBuildingAt?: InteractionControllerOptions['pickBuildingAt'];
  private readonly allowCpuEntityPicking: boolean;
  private readonly readTargetCamera: () => WorldCamera;
  private readonly onSelect?: (entity: VisualEntity | null) => void;
  private readonly onBuildingSelect?: InteractionControllerOptions['onBuildingSelect'];
  private readonly onCameraChange?: (camera: WorldCamera) => void;
  private readonly onViewportChange?: InteractionControllerOptions['onViewportChange'];
  private viewportRevision = '';
  private readonly onCamera?: (state: CameraTelemetryState) => void;
  private readonly onStreamCamera?: (camera: WorldCamera) => void;
  private readonly onMotionChange?: (moving: boolean) => void;
  private readonly onIdle?: (camera: WorldCamera) => void;

  private readonly handleClick = (event: MapMouseEvent) => {
    let gpuPickedId: string | null = null;
    try {
      gpuPickedId = this.pickAt?.(event.point.x, event.point.y) ?? null;
    } catch {
      // An unavailable/interrupted picking pass is a normal CPU-fallback miss.
    }
    if (gpuPickedId) {
      const exact = this.getEntityById
        ? this.getEntityById(gpuPickedId)
        : this.getEntities().find((entity) => entity.id === gpuPickedId) ?? null;
      this.onSelect?.(exact);
      this.onBuildingSelect?.(null);
      return;
    }

    let building: RendererBuildingSelection | null = null;
    try {
      building = this.pickBuildingAt?.(event.point.x, event.point.y) ?? null;
    } catch {
      // Style replacement/context loss makes a building query a normal click miss.
    }
    if (building) {
      this.onSelect?.(null);
      this.onBuildingSelect?.(building);
      return;
    }

    if (!this.allowCpuEntityPicking) {
      this.onSelect?.(null);
      this.onBuildingSelect?.(null);
      return;
    }

    const entities = this.getEntities();
    const living = this.getLiving?.();
    let nearest: VisualEntity | null = null;
    let nearestDistance = 24;

    if (living) {
      const { partition, frame } = living;
      if (frame.x.length !== partition.count || frame.y.length !== partition.count
        || partition.identity.ids.length !== partition.count) {
        this.onSelect?.(null);
        return;
      }
      const longitudeMeters = Math.max(
        1e-6,
        111_320 * Math.cos((Math.max(-85, Math.min(85, partition.originLatitude)) * Math.PI) / 180),
      );
      const coordinate: [number, number] = [0, 0];
      let nearestIndex = -1;
      for (let index = 0; index < partition.count; index += 1) {
        if (partition.presentation.visible[index] === 0
          || partition.presentation.primaryRenderer[index] === LivingPrimaryRenderer.NONE) continue;
        coordinate[0] = normalizedLongitude(
          partition.originLongitude + frame.x[index]! / longitudeMeters,
        );
        coordinate[1] = partition.originLatitude
          + frame.y[index]! / METERS_PER_LATITUDE_DEGREE;
        const point = this.map.project(coordinate);
        const distance = Math.hypot(point.x - event.point.x, point.y - event.point.y);
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearestIndex = index;
        }
      }
      if (nearestIndex >= 0) {
        const nearestId = partition.identity.ids[nearestIndex]!;
        for (const entity of entities) {
          if (entity.id === nearestId) {
            nearest = entity;
            break;
          }
        }
      }
    } else {
      for (const entity of entities) {
        const point = this.map.project([entity.longitude, entity.latitude]);
        const distance = Math.hypot(point.x - event.point.x, point.y - event.point.y);
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearest = entity;
        }
      }
    }
    this.onSelect?.(nearest);
    this.onBuildingSelect?.(null);
  };

  private readonly handleMoveStart = () => {
    this.onMotionChange?.(true);
  };

  private readonly handleMoveEnd = () => {
    const current = readMapCamera(this.map);
    const target = this.readTargetCamera();
    this.onMotionChange?.(false);
    this.onCamera?.({ current, target, settled: !cameraChanged(current, target) });
    this.onStreamCamera?.(current);
    this.onCameraChange?.(current);
    this.publishViewport();
  };

  private readonly handleIdle = () => {
    const current = readMapCamera(this.map);
    const target = this.readTargetCamera();
    this.onCamera?.({ current, target, settled: !cameraChanged(current, target) });
    this.onIdle?.(current);
    this.publishViewport();
  };

  /** Event-driven: never connected to move/render/RAF, no source-query dependency. */
  private readonly publishViewport = () => {
    if (this.disposed || !this.onViewportChange) return;
    let snapshot: RendererViewportSnapshot;
    try {
      if (this.map.isMoving?.()) return;
      const camera = readMapCamera(this.map); const bounds = this.map.getBounds();
      const canvas = this.map.getCanvas(); const widthCss = canvas.clientWidth; const heightCss = canvas.clientHeight;
      const bbox = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()] as const;
      if (widthCss <= 0 || heightCss <= 0 || ![...Object.values(camera), ...bbox, widthCss, heightCss].every(Number.isFinite)) return;
      const revision = [camera.longitude.toFixed(6), camera.latitude.toFixed(6), camera.zoom.toFixed(3),
        camera.pitch.toFixed(2), camera.bearing.toFixed(2), ...bbox.map(value => value.toFixed(6)), widthCss, heightCss].join(':');
      if (revision === this.viewportRevision) return;
      this.viewportRevision = revision; snapshot = { camera, bbox, widthCss, heightCss, revision };
    } catch {
      // Startup, teardown and invalid transforms preserve the last good viewport.
      return;
    }
    this.onViewportChange(snapshot);
  };

  constructor({
    map,
    getEntities,
    getEntityById,
    getLiving,
    pickAt,
    pickBuildingAt,
    allowCpuEntityPicking = true,
    readTargetCamera,
    onSelect,
    onBuildingSelect,
    onCameraChange,
    onViewportChange,
    onCamera,
    onStreamCamera,
    onMotionChange,
    onIdle,
  }: InteractionControllerOptions) {
    this.map = map;
    this.getEntities = getEntities;
    this.getEntityById = getEntityById;
    this.getLiving = getLiving;
    this.pickAt = pickAt;
    this.pickBuildingAt = pickBuildingAt;
    this.allowCpuEntityPicking = allowCpuEntityPicking;
    this.readTargetCamera = readTargetCamera;
    this.onSelect = onSelect;
    this.onBuildingSelect = onBuildingSelect;
    this.onCameraChange = onCameraChange;
    this.onViewportChange = onViewportChange;
    this.onCamera = onCamera;
    this.onStreamCamera = onStreamCamera;
    this.onMotionChange = onMotionChange;
    this.onIdle = onIdle;
    map.on('click', this.handleClick);
    map.on('movestart', this.handleMoveStart);
    map.on('moveend', this.handleMoveEnd);
    map.on('idle', this.handleIdle);
    map.on('load', this.publishViewport);
    map.on('resize', this.publishViewport);
    this.publishViewport();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.map.off('click', this.handleClick);
    this.map.off('movestart', this.handleMoveStart);
    this.map.off('moveend', this.handleMoveEnd);
    this.map.off('idle', this.handleIdle);
    this.map.off('load', this.publishViewport);
    this.map.off('resize', this.publishViewport);
  }
}
