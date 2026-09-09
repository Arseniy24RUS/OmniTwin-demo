import { describe, expect, it } from 'vitest';
import { GeoJSONWrapper } from '@maplibre/vt-pbf';
import { createExpression, featureFilter, type FilterSpecification } from '@maplibre/maplibre-gl-style-spec';
import { BUILDING_FACADE_PATTERN_EXPRESSION, BUILDING_ROOF_PATTERN_EXPRESSION, buildingHighlightFilter } from '../renderer/buildingSource';

function tileFeature(id: string | number, properties: Record<string, string>) {
  return new GeoJSONWrapper([{ id, type: 3, tags: properties,
    geometry: [[[0,0],[10,0],[10,10],[0,0]]] }]).feature(0);
}

describe('exact building highlight with the installed MapLibre tile pipeline', () => {
  it.each(['openmaptiles_buildings:853220400', 'openmaptiles_buildings:159526353'])(
    'highlights %s by canonical property before native-pick promoteId runs', canonical => {
      // GeoJSONWrapper is the actual dependency used by MapLibre's worker.
      // It parses string IDs numerically before the extrusion bucket's filter.
      const raw = tileFeature(canonical, { canonical_id: canonical });
      expect(Number.isNaN(raw.id)).toBe(true);
      const old = featureFilter(buildingHighlightFilter(canonical, false) as FilterSpecification, 'layers[0].filter');
      expect(old.filter({ zoom: 17.3 }, raw)).toBe(false);
      const exact = featureFilter(buildingHighlightFilter(canonical, true) as FilterSpecification, 'layers[1].filter');
      expect(exact.filter({ zoom: 17.3 }, raw)).toBe(true);
      expect(exact.filter({ zoom: 17.3 }, { ...raw, properties: { canonical_id: 'another-building' } })).toBe(false);
    },
  );

  it('preserves the basemap numeric ID filter', () => {
    const raw = tileFeature(159526353, {});
    const filter = featureFilter(buildingHighlightFilter('159526353', false) as FilterSpecification, 'layers[0].filter');
    expect(filter.filter({ zoom: 17.3 }, raw)).toBe(true);
    expect(filter.filter({ zoom: 17.3 }, tileFeature(159526354, {}))).toBe(false);
  });

  it('keeps source material selection independent of raw tile IDs, without a fabricated numeric palette seed', () => {
    for (const [expression, properties, expected] of [
      [BUILDING_FACADE_PATTERN_EXPRESSION, { building: 'commercial' }, 'omnitwin:facade-slate'],
      [BUILDING_FACADE_PATTERN_EXPRESSION, { building: 'apartments' }, 'omnitwin:facade-plaster'],
      [BUILDING_ROOF_PATTERN_EXPRESSION, { 'roof:material': 'metal' }, 'omnitwin:roof-metal'],
    ] as const) {
      expect(JSON.stringify(expression)).not.toContain('["id"]');
      const compiled = createExpression(expression, 'layers[0].paint.fill-extrusion-pattern');
      if (compiled.result !== 'success') throw new Error('Fixture material expression did not compile');
      for (const id of [17, 853220400, 'openmaptiles_buildings:853220400']) {
        expect(compiled.value.evaluate({ zoom: 17.3 }, tileFeature(id, properties))).toBe(expected);
      }
    }
  });
});
