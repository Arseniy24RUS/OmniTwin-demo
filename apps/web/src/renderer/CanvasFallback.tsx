import { useCallback, useEffect, useRef } from 'react';
import { createDeterministicRng } from './rng';
import type {
  VisualEntity,
  WeatherMode,
  WorldCamera,
  WorldLayer,
} from './types';

interface CanvasFallbackProps {
  camera: WorldCamera;
  entities: readonly VisualEntity[];
  selectedId: string | null;
  onSelect: (entity: VisualEntity | null) => void;
  presentationMinutes: number;
  weather: WeatherMode;
  viewMode: '2d' | '3d';
  activeLayers: ReadonlySet<WorldLayer>;
  reducedMotion: boolean;
}

interface ScreenPoint {
  entity: VisualEntity;
  x: number;
  y: number;
}

function daylightFactor(minutes: number): number {
  const angle = ((minutes - 360) / 1440) * Math.PI * 2;
  return Math.max(0, Math.min(1, (Math.sin(angle) + 0.25) / 1.25));
}

function toScreen(
  entity: VisualEntity,
  camera: WorldCamera,
  width: number,
  height: number,
  minutes: number,
  reducedMotion: boolean,
): ScreenPoint {
  const longitudeSpan = 360 / 2 ** Math.max(0, camera.zoom - 0.6);
  const latitudeSpan = longitudeSpan * (height / Math.max(width, 1));
  const progress = reducedMotion ? 0 : ((minutes + (entity.seed % 1440)) % 1440) / 1440;
  const travel = entity.representation === 'ambient_only' ? (progress - 0.5) * 0.0012 : 0;
  const radians = (entity.heading * Math.PI) / 180;
  const longitude = entity.longitude + Math.sin(radians) * travel;
  const latitude = entity.latitude + Math.cos(radians) * travel;
  return {
    entity,
    x: width / 2 + ((longitude - camera.longitude) / longitudeSpan) * width,
    y: height / 2 - ((latitude - camera.latitude) / latitudeSpan) * height,
  };
}

function roundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
}

function drawCityBackdrop(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  minutes: number,
  mode: '2d' | '3d',
  weather: WeatherMode,
) {
  const daylight = daylightFactor(minutes);
  const sky = context.createLinearGradient(0, 0, 0, height);
  sky.addColorStop(0, daylight > 0.45 ? '#47758b' : '#071723');
  sky.addColorStop(0.52, daylight > 0.45 ? '#8ea5a4' : '#12314a');
  sky.addColorStop(1, '#061119');
  context.fillStyle = sky;
  context.fillRect(0, 0, width, height);

  const horizon = mode === '3d' ? height * 0.24 : 0;
  const rng = createDeterministicRng('omnitwin-procedural-city-backdrop-v1');
  context.fillStyle = daylight > 0.45 ? '#263f46' : '#091820';
  for (let index = 0; index < 42; index += 1) {
    const buildingWidth = width * (0.018 + rng() * 0.045);
    const buildingHeight = height * (0.05 + rng() * 0.18);
    const x = rng() * width;
    context.fillRect(x, horizon - buildingHeight, buildingWidth, buildingHeight);
  }

  context.fillStyle = daylight > 0.45 ? '#263a38' : '#071417';
  context.fillRect(0, horizon, width, height - horizon);

  if (mode === '3d') {
    const vanishingX = width * 0.57;
    context.fillStyle = daylight > 0.45 ? '#455251' : '#17242a';
    context.beginPath();
    context.moveTo(vanishingX - 6, horizon);
    context.lineTo(vanishingX + 6, horizon);
    context.lineTo(width * 0.84, height);
    context.lineTo(width * 0.18, height);
    context.closePath();
    context.fill();

    context.strokeStyle = `rgba(255, 184, 82, ${0.3 + (1 - daylight) * 0.55})`;
    context.lineWidth = 1.2;
    for (let lane = -3; lane <= 3; lane += 1) {
      context.beginPath();
      context.moveTo(vanishingX + lane * 2, horizon);
      context.lineTo(width * (0.51 + lane * 0.065), height);
      context.stroke();
    }
  } else {
    context.strokeStyle = daylight > 0.45 ? '#697675' : '#24343a';
    context.lineWidth = Math.max(5, width * 0.008);
    for (let index = 1; index < 6; index += 1) {
      context.beginPath();
      context.moveTo(0, (height / 6) * index);
      context.lineTo(width, (height / 6) * index + (index % 2 ? 12 : -12));
      context.stroke();
    }
  }

  if (weather === 'cloudy' || weather === 'rain' || weather === 'snow') {
    context.fillStyle = weather === 'rain' ? 'rgba(8, 18, 27, .38)' : 'rgba(25, 40, 49, .23)';
    context.fillRect(0, 0, width, height);
  }
  if (weather === 'rain') {
    context.strokeStyle = 'rgba(155, 208, 225, .35)';
    context.lineWidth = 1;
    for (let index = 0; index < 90; index += 1) {
      const x = (index * 83) % width;
      const y = (index * 47 + minutes * 2) % height;
      context.beginPath();
      context.moveTo(x, y);
      context.lineTo(x - 5, y + 15);
      context.stroke();
    }
  }
  if (weather === 'snow') {
    context.fillStyle = 'rgba(222, 239, 245, .72)';
    for (let index = 0; index < 90; index += 1) {
      const x = (index * 83 + (reducedSnowOffset(minutes) % 83)) % width;
      const y = (index * 47 + minutes) % height;
      context.beginPath();
      context.arc(x, y, index % 5 === 0 ? 1.8 : 1.1, 0, Math.PI * 2);
      context.fill();
    }
  }
}

function reducedSnowOffset(minutes: number): number {
  return Math.floor(minutes / 3);
}

export function CanvasFallback({
  camera,
  entities,
  selectedId,
  onSelect,
  presentationMinutes,
  weather,
  viewMode,
  activeLayers,
  reducedMotion,
}: CanvasFallbackProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pointsRef = useRef<ScreenPoint[]>([]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const bounds = canvas.getBoundingClientRect();
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(bounds.width));
    const height = Math.max(1, Math.round(bounds.height));
    const targetWidth = Math.round(width * pixelRatio);
    const targetHeight = Math.round(height * pixelRatio);
    if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
      canvas.width = targetWidth;
      canvas.height = targetHeight;
    }
    const context = canvas.getContext('2d');
    if (!context) return;
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.clearRect(0, 0, width, height);
    drawCityBackdrop(context, width, height, presentationMinutes, viewMode, weather);

    const points = entities
      .filter((entity) => {
        if (entity.kind === 'vehicle') return activeLayers.has('movement');
        if (entity.kind === 'focus') return activeLayers.has('agents');
        return activeLayers.has('population');
      })
      .map((entity) =>
        toScreen(
          entity,
          camera,
          width,
          height,
          presentationMinutes,
          reducedMotion,
        ),
      )
      .filter((point) => point.x > -12 && point.x < width + 12 && point.y > -12 && point.y < height + 12);
    pointsRef.current = points;

    for (const point of points) {
      const { entity, x, y } = point;
      const selected = entity.id === selectedId;
      if (selected) {
        context.beginPath();
        context.arc(x, y, 11, 0, Math.PI * 2);
        context.strokeStyle = '#ffffff';
        context.lineWidth = 1.5;
        context.stroke();
      }
      if (entity.kind === 'vehicle') {
        context.save();
        context.translate(x, y);
        context.rotate((entity.heading * Math.PI) / 180);
        roundedRect(context, -2.5, -5, 5, 10, 1.5);
        context.fillStyle = entity.color;
        context.fill();
        context.restore();
      } else {
        const radius = entity.kind === 'focus' ? 4.5 : 1.4 + Math.log10(entity.representedCount + 1) * 0.45;
        context.beginPath();
        context.arc(x, y, radius, 0, Math.PI * 2);
        context.fillStyle = entity.color;
        context.globalAlpha = entity.kind === 'focus' ? 1 : 0.72;
        context.fill();
        context.globalAlpha = 1;
      }
    }

    context.fillStyle = 'rgba(3, 12, 17, .82)';
    roundedRect(context, 16, height - 48, 235, 30, 6);
    context.fill();
    context.fillStyle = '#c7d5da';
    context.font = '500 11px Inter, system-ui, sans-serif';
    context.fillText('ЛОКАЛЬНЫЙ CANVAS · ДЕТЕРМИНИРОВАН', 28, height - 28);
  }, [
    activeLayers,
    camera,
    entities,
    presentationMinutes,
    reducedMotion,
    selectedId,
    viewMode,
    weather,
  ]);

  useEffect(() => {
    draw();
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [draw]);

  return (
    <canvas
      ref={canvasRef}
      className="ot-canvas-fallback"
      data-weather={weather}
      aria-label="Локальная детерминированная визуализация активной территории"
      onClick={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;
        let nearest: ScreenPoint | null = null;
        let distance = 22;
        for (const point of pointsRef.current) {
          const nextDistance = Math.hypot(point.x - x, point.y - y);
          if (nextDistance < distance) {
            distance = nextDistance;
            nearest = point;
          }
        }
        onSelect(nearest?.entity ?? null);
      }}
    />
  );
}
