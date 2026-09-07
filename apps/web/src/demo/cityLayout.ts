import { resolveRendererBuildingSelection } from '../renderer/buildingSource';
import type { RendererMapFeatureSnapshot } from '../renderer/types';
import type { DemoLayout } from './types';
import type { CityRoad } from './cityRoadGraph';

/** Only source-qualified features with actual polygon coordinates enter occupancy. */
export function cityLayoutFromFeatures(snapshot: RendererMapFeatureSnapshot, roads: readonly CityRoad[]): DemoLayout {
  const buildings = new Map<string, DemoLayout['buildings'][number]>();
  for (const feature of snapshot.buildings) {
    const selection = resolveRendererBuildingSelection(snapshot.buildingSource, feature);
    if (!selection || buildings.has(selection.canonicalId)) continue;
    const geometry = feature.geometry;
    const ring = geometry.type === 'Polygon' ? geometry.coordinates[0]
      : geometry.type === 'MultiPolygon' ? geometry.coordinates[0]?.[0] : null;
    if (!ring || ring.length < 3) continue;
    const positions = ring.filter((point) => point.length >= 2 && Number.isFinite(point[0]) && Number.isFinite(point[1]));
    if (positions.length < 3) continue;
    const center: [number, number] = [
      (Math.min(...positions.map((point) => point[0]!)) + Math.max(...positions.map((point) => point[0]!))) / 2,
      (Math.min(...positions.map((point) => point[1]!)) + Math.max(...positions.map((point) => point[1]!))) / 2,
    ];
    const category = String(feature.properties?.class ?? feature.properties?.building ?? '').toLowerCase();
    const use = /school|university|college|kindergarten/u.test(category) ? 'study'
      : /office|commercial|retail|industrial|hospital/u.test(category) ? 'work'
      : /residential|house|apartments/u.test(category) ? 'residential' : 'mixed';
    buildings.set(selection.canonicalId, {
      id: selection.canonicalId, center, use,
      name: typeof feature.properties?.name === 'string' ? feature.properties.name : undefined,
    });
  }
  return {
    buildings: [...buildings.values()],
    roads: roads.map((road) => ({
      id: road.id,
      coordinates: (road.oneway === -1 ? [...road.coordinates].reverse() : road.coordinates).map(([lon, lat]) => [lon, lat]),
      oneway: road.oneway !== 0,
      walkable: road.walkable,
      drivable: road.drivable,
    })),
  };
}
