import { describe, expect, it } from 'vitest';
import type { CityBuildingV2, CityCellV2 } from './data/CityPackV2';
import { buildVerifiedCityBuildings } from './verifiedCityBuildings';

const viewport = { bbox: [0, 0, 3, 3] as const };
function building(id = 'openmaptiles_buildings:853220400', overrides: Partial<CityBuildingV2> = {}): CityBuildingV2 {
  return {
    index: 0, id, aliases: ['openmaptiles_buildings:853220402'], center: [1, 1], districtId: null,
    use: 'work', areaM2: 100, levels: 3, heightM: 12, heightQuality: 'exact', capacityWeight: 0,
    classificationProvenance: 'source_attribute', name: 'Куба',
    sourceAttributes: { building: 'retail', 'roof:material': 'metal', 'building:material': 'brick', min_height: '2' },
    footprint: { type: 'Polygon', coordinates: [[[1, 1], [2, 1], [2, 2], [1, 2], [1, 1]]] },
    ...overrides,
  };
}
function cell(key = '16/1/1', buildings = [building()], bbox: CityCellV2['bbox'] = [0, 0, 3, 3]): CityCellV2 {
  return { contract: 'DemoCityCellV2', key, buildings, bbox, roads: [] };
}
const build = (cells: readonly CityCellV2[], options: Partial<Parameters<typeof buildVerifiedCityBuildings>[0]> = {}) =>
  buildVerifiedCityBuildings({ datasetVersion: 'verified-v2', cells, viewport, ...options });

describe('verified active-cell building render snapshots', () => {
  it('retains proven coverage beyond the last camera rectangle without crossing missing source cells', () => {
    const a=cell('a',[building()],[0,0,2,2]),b=cell('b',[],[2,0,4,2]);
    const sourceCoverage:NonNullable<Parameters<typeof buildVerifiedCityBuildings>[0]['sourceCoverage']>={bounds:[0,0,6,4],cells:[
      {key:'a',bbox:a.bbox,buildingCount:1},{key:'b',bbox:b.bbox,buildingCount:0},
      {key:'missing',bbox:[4,0,6,2],buildingCount:1},
      {key:'north',bbox:[0,2,6,4],buildingCount:1},
    ]};
    const result=build([a,b],{viewport:{bbox:[.5,.5,1.5,1.5]},sourceCoverage});
    expect(result.coverageBounds).toEqual([0,0,4,2]);
    expect(build([a,b],{viewport:{bbox:[.5,.5,1.5,1.5]},sourceCoverage,maxBuildings:0}).coverageBounds).toBeNull();
    // Without an inventory, the rectangle union must cover the expanded area.
    expect(build([a,b],{viewport:{bbox:[.5,.5,1.5,1.5]}}).coverageBounds).toEqual([0,0,4,2]);
  });
  it('keeps the exact compiled Kuba ID, footprint, source metadata and explicit OSM identity', () => {
    const kuba = { ...building(), osmId: 'way/85322040' };
    const snapshot = build([cell('a', [kuba])]);
    const feature = snapshot.data.features[0]!;
    expect(feature.id).toBe('openmaptiles_buildings:853220400');
    expect(feature.geometry).toBe(kuba.footprint);
    expect(feature.properties).toMatchObject({
      canonical_id: kuba.id, osm_id: 'way/85322040', name: 'Куба', height: 12, min_height: 2,
      building: 'retail', building_use: 'work', 'roof:material': 'metal', 'building:material': 'brick', height_quality: 'exact',
    });
    expect([...snapshot.canonicalIds]).toEqual([kuba.id]);
    expect(snapshot.coverage).toBe('complete_viewport');
    expect(snapshot.vertexCount).toBe(5);
  });

  it('does not reinterpret merged-like internal IDs or manufacture osm_id from any suffix', () => {
    const ids = ['openmaptiles_buildings:20783610', 'openmaptiles_buildings:159526353', 'openmaptiles_buildings:853220402'];
    const snapshot = build([cell('a', ids.map(id => building(id)))]);
    expect([...snapshot.canonicalIds]).toEqual([...ids].sort());
    for (const feature of snapshot.data.features) {
      expect(feature.properties?.canonical_id).toBe(feature.id);
      expect(feature.properties).not.toHaveProperty('osm_id');
    }
  });

  it('deduplicates exact IDs independently of cell and row order, with content-stable signatures', () => {
    const a = building('source:a'), b = building('source:b');
    const cells = [cell('z', [a, b]), cell('a', [b, a])];
    const first = build(cells);
    const second = build(cells.toReversed().map(value => ({ ...value, buildings: value.buildings.toReversed() })));
    expect(first).toEqual(second);
    expect(first.data.features).toHaveLength(2);
    expect(first.omittedBuildings).toBe(0);
    expect(build([cells[0]!, cells[0]!, cells[1]!])).toEqual(first);
    expect(build(cells, { datasetVersion: 'new-version' }).signature).not.toBe(first.signature);
  });

  it('changes signature for source geometry or properties at unchanged IDs and cell keys', () => {
    const source = building();
    const initial = build([cell('a', [source])]);
    expect(build([cell('a', [{ ...source, heightM: 21 }])]).signature).not.toBe(initial.signature);
    expect(build([cell('a', [{ ...source, sourceAttributes: { ...source.sourceAttributes, 'roof:material': 'tile' } }])]).signature).not.toBe(initial.signature);
    expect(build([cell('a', [{ ...source, footprint: { type: 'Polygon', coordinates: [[[1, 1], [2.1, 1], [2, 2], [1, 2], [1, 1]]] } }])]).signature).not.toBe(initial.signature);
    const reordered = { ...source, sourceAttributes: { min_height: '2', 'building:material': 'brick', 'roof:material': 'metal', building: 'retail' } };
    expect(build([cell('a', [reordered])]).signature).toBe(initial.signature);
  });

  it('keeps the content signature stable when only viewport coverage changes', () => {
    const cells = [cell()];
    const partial = build(cells, { viewport: { bbox: [-1, -1, 4, 4] } });
    const complete = build(cells);
    const unresolved = build(cells, { viewport: undefined });
    expect(partial.coverage).toBe('partial_viewport');
    expect(complete.coverage).toBe('complete_viewport');
    expect(unresolved.coverage).toBe('unresolved');
    expect(partial.data).toEqual(complete.data);
    expect(partial.signature).toBe(complete.signature);
    expect(unresolved.signature).toBe(complete.signature);
  });

  it('preserves MultiPolygon rings and holes exactly without inventing or joining geometry', () => {
    const footprint: NonNullable<CityBuildingV2['footprint']> = { type: 'MultiPolygon', coordinates: [
      [[[0, 0], [3, 0], [3, 3], [0, 3], [0, 0]], [[1, 1], [1, 2], [2, 2], [2, 1], [1, 1]]],
      [[[4, 0], [5, 0], [5, 1], [4, 1], [4, 0]]],
    ] };
    const snapshot = build([cell('a', [building('source:multi', { footprint })])]);
    expect(snapshot.data.features[0]!.geometry).toBe(footprint);
    expect(snapshot.vertexCount).toBe(15);
  });

  it('skips invalid source rows and reports partial coverage rather than fabricating footprints', () => {
    const rows = [
      building('no-footprint', { footprint: undefined }), building('bad-height', { heightM: NaN }),
      building('unclosed', { footprint: { type: 'Polygon', coordinates: [[[1, 1], [2, 1], [2, 2], [1, 2]]] } }),
      building('bad-coordinate', { footprint: { type: 'Polygon', coordinates: [[[1, 1], [NaN, 1], [2, 2], [1, 1]]] } }),
      building('empty', { footprint: { type: 'MultiPolygon', coordinates: [] } }), building(),
    ];
    const snapshot = build([cell('a', rows)]);
    expect(snapshot.data.features).toHaveLength(1);
    expect(snapshot.invalidBuildings).toBe(5);
    expect(snapshot.omittedBuildings).toBe(0);
    expect(snapshot.coverage).toBe('partial_viewport');
  });

  it('uses zero only for absent or invalid source minimum height and never changes total height', () => {
    for (const min_height of ['', '-1', 'NaN', '13']) {
      const snapshot = build([cell('a', [building('source:a', { sourceAttributes: { min_height } })])]);
      expect(snapshot.data.features[0]!.properties).toMatchObject({ height: 12, min_height: 0 });
    }
  });

  it('applies deterministic cell, building and whole-geometry vertex caps and reports omissions', () => {
    const cells = [cell('c', [building('source:c')]), cell('b', [building('source:b')]), cell('a', [building('source:a')])];
    for (const limit of [{ maxCells: 2 }, { maxBuildings: 2 }, { maxVertices: 10 }]) {
      const snapshot = build(cells, limit);
      expect(snapshot).toEqual(build(cells.toReversed(), limit));
      expect([...snapshot.canonicalIds]).toEqual(['source:a', 'source:b']);
      expect(snapshot.vertexCount).toBe(10);
      expect(snapshot.omittedBuildings).toBe(1);
      expect(snapshot.coverage).toBe('partial_viewport');
    }
    const tiny = build(cells, { maxVertices: 4 });
    expect(tiny.data.features).toHaveLength(0);
    expect(tiny.vertexCount).toBe(0);
    expect(tiny.omittedBuildings).toBe(3);
    expect(build(cells, { maxBuildings: 0 }).omittedBuildings).toBe(3);
  });

  it('does not call four covered corners a fully covered viewport when the center has a hole', () => {
    const frame = [
      cell('left', [], [0, 0, 1, 3]), cell('right', [], [2, 0, 3, 3]),
      cell('bottom', [], [1, 0, 2, 1]), cell('top', [], [1, 2, 2, 3]),
    ];
    expect(build(frame).coverage).toBe('partial_viewport');
    expect(build([...frame, cell('center', [], [1, 1, 2, 2])]).coverage).toBe('complete_viewport');
    expect(build([cell('all', [], [-1, -1, 4, 4])]).coverage).toBe('complete_viewport');
    expect(build([]).coverage).toBe('partial_viewport');
    expect(build(frame, { viewport: undefined }).coverage).toBe('unresolved');
    expect(build(frame, { viewport: { bbox: [3, 0, 0, 3] } }).coverage).toBe('unresolved');
  });

  it('detects interior sliver gaps and rejects invalid cell bounds for coverage', () => {
    const cells = [cell('a', [], [0, 0, 1.5, 3]), cell('b', [], [1.500000001, 0, 3, 3])];
    expect(build(cells).coverage).toBe('partial_viewport');
    expect(build([cell('bad', [building()], [0, NaN, 3, 3])]).coverage).toBe('partial_viewport');
  });

  it('uses explicit source inventory to allow empty water gaps and unloaded road-only cells', () => {
    const cells = [cell('left', [building('source:a')], [0, 0, 1, 3]), cell('right', [building('source:b')], [2, 0, 3, 3])];
    const sourceCoverage = { bounds: viewport.bbox, cells: [
      ...cells.map(value => ({ key: value.key, bbox: value.bbox, buildingCount: value.buildings.length })),
      { key: 'road-only', bbox: [1, 0, 2, 1] as [number, number, number, number], buildingCount: 0 },
    ] };
    const fallback = build(cells);
    const known = build(cells, { sourceCoverage });
    expect(fallback.coverage).toBe('partial_viewport');
    expect(known.coverage).toBe('complete_viewport');
    expect(known.signature).toBe(fallback.signature);
  });

  it('keeps unknown missing populated cells and viewports outside source bounds partial', () => {
    const loaded = cell('loaded');
    const sourceCoverage = { bounds: viewport.bbox, cells: [
      { key: loaded.key, bbox: loaded.bbox, buildingCount: 1 },
      { key: 'missing', bbox: [1, 1, 2, 2] as [number, number, number, number], buildingCount: 1 },
    ] };
    expect(build([loaded], { sourceCoverage }).coverage).toBe('partial_viewport');
    expect(build([loaded], { sourceCoverage: { ...sourceCoverage, cells: sourceCoverage.cells.slice(0, 1) } }).coverage).toBe('complete_viewport');
    expect(build([loaded], { sourceCoverage: { bounds: [0, 0, 2, 3], cells: [] } }).coverage).toBe('partial_viewport');
    expect(build([], { sourceCoverage: { bounds: viewport.bbox, cells: [] } }).coverage).toBe('complete_viewport');
  });

  it('keeps omission diagnostics stable when duplicate cells are outside the retained cap', () => {
    const a = cell('a', [building('source:a')]), b = cell('b', [building('source:b')]);
    expect(build([b, b, a], { maxCells: 1 })).toEqual(build([a, b, b], { maxCells: 1 }));
  });

  it('never allows optional limits to expand the 64-cell or 12,000-building envelope', () => {
    const cells = Array.from({ length: 66 }, (_, index) => cell(String(index).padStart(3, '0'), []));
    const boundedCells = build(cells, { maxCells: 100_000 });
    expect(boundedCells.cells).toHaveLength(64);
    expect(boundedCells.coverage).toBe('partial_viewport');
    const rows = Array.from({ length: 12_010 }, (_, index) => building(`source:${String(index).padStart(6, '0')}`));
    const boundedBuildings = build([cell('a', rows)], { maxBuildings: 100_000 });
    expect(boundedBuildings.data.features).toHaveLength(12_000);
    expect(boundedBuildings.omittedBuildings).toBe(10);
    expect(boundedBuildings.vertexCount).toBe(60_000);
    expect(boundedBuildings.signature).toBe(build([cell('a', rows.toReversed())], { maxBuildings: 100_000 }).signature);
  });

  it('does not mutate any verified source objects while building the snapshot', () => {
    const source = cell();
    const before = structuredClone(source);
    Object.freeze(source.buildings[0]!.sourceAttributes);
    Object.freeze(source.buildings[0]!.footprint);
    Object.freeze(source.buildings[0]); Object.freeze(source.buildings); Object.freeze(source);
    build([source]);
    expect(source).toEqual(before);
  });

  it('never expands the 500,000-vertex ceiling or truncates a polygon to fit', () => {
    const repeatedPoint = [0, 0];
    const ring = [[0, 0], [1, 0], [1, 1], [0, 1], ...Array<number[]>(499_997).fill(repeatedPoint)];
    const snapshot = build([cell('a', [building('source:large', { footprint: { type: 'Polygon', coordinates: [ring] } })])], { maxVertices: 1_000_000 });
    expect(snapshot.data.features).toHaveLength(0);
    expect(snapshot.vertexCount).toBe(0);
    expect(snapshot.omittedBuildings).toBe(1);
    expect(ring).toHaveLength(500_001);
  });
});
