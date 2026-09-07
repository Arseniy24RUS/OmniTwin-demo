import { describe, expect, it } from 'vitest';
import { demoPerformancePolicy } from '../renderer/demoPerformancePolicy';
import { rendererAssetUrl } from '../renderer/assetUrl';
import { mapStyleLayerVisibility } from '../renderer/mapLayerPolicy';
import { resolveRendererBuildingSelection } from '../renderer/buildingSource';
import { OPENMAPTILES_BUILDINGS_SOURCE } from '../renderer/mapProvider';

describe('static demo renderer configuration', () => {
  it('keeps useful city detail with bounded local policy profiles', () => {
    for (const quality of ['performance', 'balanced', 'adaptive', 'cinematic'] as const) {
      const policy = demoPerformancePolicy(quality, false);
      expect(policy.phaseProfiles.living_motion.facadePattern).toBe(true);
      expect(policy.phaseProfiles.emergency_30.facadePattern).toBe(false);
      expect(policy.scheduler.maxFps).toBeLessThanOrEqual(60);
      expect(demoPerformancePolicy(quality, false)).toBe(policy);
    }
  });
  it('resolves local assets under the deployment base without changing external endpoints', () => {
    const path = rendererAssetUrl('/map/fonts/test.pbf');
    expect(path).toContain('/map/fonts/test.pbf');
    expect(rendererAssetUrl(path)).toBe(path);
    expect(rendererAssetUrl('https://tiles.openfreemap.org/planet')).toBe('https://tiles.openfreemap.org/planet');
  });
  it('retains source extrusions and exact building picks in reduced demo detail', () => {
    const active = new Set(['buildings'] as const);
    expect(mapStyleLayerVisibility('omnitwin-building-motion-3d', active, 'compatibility_30', true)).toBe('visible');
    expect(mapStyleLayerVisibility('omnitwin-building-motion-flat', active, 'compatibility_30', true)).toBe('none');
    expect(mapStyleLayerVisibility('omnitwin-building-motion-3d', active, 'compatibility_30')).toBe('none');
    expect(resolveRendererBuildingSelection(OPENMAPTILES_BUILDINGS_SOURCE, {
      id: 123, source: 'openmaptiles', sourceLayer: 'building', layer: { id: 'omnitwin-building-motion-3d' },
    })?.canonicalId).toBe('openmaptiles_buildings:123');
  });
  it('respects the infrastructure toggle for source-backed pedestrian paths', () => {
    expect(mapStyleLayerVisibility('walkways', new Set(['infrastructure']))).toBe('visible');
    expect(mapStyleLayerVisibility('walkways', new Set(['buildings']))).toBe('none');
  });
});
