import { describe, expect, it, vi } from 'vitest';
import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec';
import type { StyleSpecification } from 'maplibre-gl';
import { applyUniversalBuildingStyle, setUniversalBuildingDetailFallback } from '../renderer/mapStyle';
import { OPENMAPTILES_BUILDINGS_SOURCE } from '../renderer/mapProvider';

const base: StyleSpecification = { version: 8,
  sprite: [{ id: 'omnitwin', url: 'https://example.org/materials' }],
  sources: { openmaptiles: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' } }, layers: [] };
const layer = (style: StyleSpecification, id: string) => style.layers.find((item) => item.id === id)!;

describe('explicit city material detail', () => {
  it('keeps the default mid/high material thresholds and AO unchanged', () => {
    const mid = applyUniversalBuildingStyle(base, OPENMAPTILES_BUILDINGS_SOURCE, { qualityTier: 'mid' });
    expect(layer(mid, 'omnitwin-building-facade-3d')).toBeUndefined();
    expect(layer(mid, 'building-3d')).not.toHaveProperty('maxzoom');
    const high = applyUniversalBuildingStyle(base, OPENMAPTILES_BUILDINGS_SOURCE, { qualityTier: 'high' });
    expect(layer(high, 'omnitwin-building-facade-3d')).toMatchObject({ minzoom: 17 });
    expect(layer(high, 'building-3d')).toMatchObject({ maxzoom: 17 });
    expect(layer(mid, 'omnitwin-building-contact-ao')).toMatchObject({ paint: { 'line-opacity': 0.34 } });
  });

  it('enables existing atlas facade and roof layers at the explicit city zoom on mid/high', () => {
    for (const qualityTier of ['mid', 'high'] as const) {
      const result = applyUniversalBuildingStyle(base, OPENMAPTILES_BUILDINGS_SOURCE, { qualityTier, materialDetailZoom: 16 });
      expect(layer(result, 'building-3d')).toMatchObject({ minzoom: 13, maxzoom: 16 });
      expect(layer(result, 'omnitwin-building-facade-3d')).toMatchObject({ minzoom: 16 });
      expect(layer(result, 'omnitwin-building-roof-3d')).toMatchObject({ minzoom: 16 });
      expect(JSON.stringify(layer(result, 'omnitwin-building-facade-3d'))).toContain('omnitwin:facade-brick');
      expect(JSON.stringify(layer(result, 'omnitwin-building-roof-3d'))).toContain('omnitwin:roof-');
      expect(layer(result, 'omnitwin-building-contact-ao')).toMatchObject({ paint: { 'line-opacity': 0.5 } });
      expect(validateStyleMin(result).map(({ message }) => message)).toEqual([]);
    }
    const low = applyUniversalBuildingStyle(base, OPENMAPTILES_BUILDINGS_SOURCE, { qualityTier: 'low', materialDetailZoom: 16 });
    expect(layer(low, 'omnitwin-building-facade-3d')).toBeUndefined();
    expect(layer(low, 'building-3d')).not.toHaveProperty('maxzoom');
  });

  it('restores actual base extrusions whenever the facade pass is disabled and avoids redundant changes', () => {
    const style = applyUniversalBuildingStyle(base, { ...OPENMAPTILES_BUILDINGS_SOURCE,
      schema: { ...OPENMAPTILES_BUILDINGS_SOURCE.schema, requiredLayers: ['building', 'building_part'] } },
    { qualityTier: 'mid', materialDetailZoom: 16 });
    const layers = new Map(style.layers.map((item) => [item.id, { ...item }]));
    const map = { getLayer: (id: string) => layers.get(id),
      setLayerZoomRange: vi.fn((id: string, minzoom: number, maxzoom: number) => { Object.assign(layers.get(id)!, { minzoom, maxzoom }); }) };
    setUniversalBuildingDetailFallback(map, false);
    for (const id of ['building-3d', 'building-parts-3d']) expect(map.getLayer(id)).toMatchObject({ minzoom: 13, maxzoom: 24 });
    expect(map.setLayerZoomRange).toHaveBeenCalledTimes(2);
    setUniversalBuildingDetailFallback(map, false);
    expect(map.setLayerZoomRange).toHaveBeenCalledTimes(2);
    setUniversalBuildingDetailFallback(map, true);
    for (const id of ['building-3d', 'building-parts-3d']) expect(map.getLayer(id)).toMatchObject({ minzoom: 13, maxzoom: 16 });
    expect(map.setLayerZoomRange).toHaveBeenCalledTimes(4);
    expect(layer(style, 'building-3d')).toMatchObject({ maxzoom: 16 });
  });

  it('ignores absent detail layers and rejects invalid opt-in thresholds', () => {
    const map = { getLayer: () => undefined, setLayerZoomRange: vi.fn() };
    setUniversalBuildingDetailFallback(map, false);
    expect(map.setLayerZoomRange).not.toHaveBeenCalled();
    for (const materialDetailZoom of [NaN, Infinity, 12, 23]) {
      expect(() => applyUniversalBuildingStyle(base, OPENMAPTILES_BUILDINGS_SOURCE, { materialDetailZoom })).toThrow(/materialDetailZoom/);
    }
  });
});
