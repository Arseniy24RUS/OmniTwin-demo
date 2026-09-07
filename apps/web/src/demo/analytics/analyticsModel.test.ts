import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { StaticDemoProvider } from '../data/StaticDemoProvider';
import type { DemoDataset, DemoDatasetManifestV1, DemoLegacyExport } from '../types';
import { ageSexFromCanonicalRows, cohortSnapshot, filterCanonicalRows, legacyCanonicalRows, signedComponentSeries, snapshotRows, stockFlowResidual } from './analyticsModel';
import { buildCanonicalCsv } from './canonical';
import { emptyDraft, parseDraft } from './draft';

const read = (name: string) => JSON.parse(readFileSync(new URL(`../../../public/demo/${name}`, import.meta.url), 'utf8'));
const provider = new StaticDemoProvider(read('dataset.json') as DemoDataset, read('manifest.json') as DemoDatasetManifestV1, read('legacy-synthetic-chelyabinsk-v1.json') as DemoLegacyExport);

describe('ported analytics connected to one public fixture', () => {
  it('uses the same exact cohort for the population, yearly cross-sections and CSV', () => {
    const cohort = {ageBand: '18-34', sex: 'female'} as const;
    const timeline = provider.getTimeline('baseline').map(snapshot => cohortSnapshot(provider, snapshot, cohort));
    expect(timeline[0]!.population).toBe(707);
    expect(provider.getSnapshot('baseline', 2026)!.population).toBe(8246);
    for (const snapshot of timeline) {
      expect(snapshot.population).toBe(provider.getPeople({scenario: 'baseline', year: snapshot.year, territoryId: snapshot.territoryId, ...cohort}).total);
      expect(snapshot.ageSex.reduce((sum, row) => sum + row.male + row.female, 0)).toBe(snapshot.population);
      expect(snapshot.births).toBeNull();
      expect(snapshot.deaths).toBeNull();
      expect(snapshot.netChange).toBeNull();
    }
    const rows = snapshotRows(timeline[0]!, 'Челябинск', cohort);
    expect(rows.filter(row => row.stockAsOf !== null)).toMatchObject([{ageBand: '18-34', sex: 'female', value: 707}]);
    expect(rows.filter(row => row.stockAsOf === null).every(row => row.value === null)).toBe(true);
    const csv = buildCanonicalCsv(rows, {smallCellThreshold: 1});
    expect(csv).toContain('"cohort_age_band","cohort_sex","cohort_employment"');
    expect(csv).toContain('"18-34","female"');
    expect(csv).not.toContain('"8246"');
  });
  it('respects territory and employment without treating an empty cohort as missing', () => {
    const source = provider.getSnapshot('inflow', 2032, 'RU-CHE-SET-CEN')!;
    const cohort = {ageBand: '70+', sex: 'male', employment: 'retired'} as const;
    const result = cohortSnapshot(provider, source, cohort);
    expect(result.population).toBe(provider.getPeople({scenario: 'inflow', year: 2032, territoryId: 'RU-CHE-SET-CEN', ...cohort}).total);
    expect(result.employment.retired).toBe(result.population);
    const empty = cohortSnapshot(provider, source, {ageBand: '0-17', employment: 'retired'});
    expect(empty.population).toBe(0);
    expect(empty.households).toBe(0);
    expect(cohortSnapshot(provider, source, null)).toBe(source);
  });
  it('selects one exact territory without adding parent or child totals', () => {
    const rows = legacyCanonicalRows(provider.legacy, 'RU-CHE-SET');
    expect(rows).toHaveLength(26);
    expect(filterCanonicalRows(rows, 'population', 2025, 2025).reduce((sum, row) => sum + row.value!, 0)).toBe(8225);
    expect(filterCanonicalRows(rows, 'population', 2026, 2026).reduce((sum, row) => sum + row.value!, 0)).toBe(8246);
    expect(ageSexFromCanonicalRows(rows).reduce((sum, row) => sum + row.male! + row.female!, 0)).toBe(8246);
    expect(legacyCanonicalRows(provider.legacy, 'missing')).toEqual([]);
  });
  it('retains null for initial events and places subsequent events in their own year', () => {
    const timeline = provider.getTimeline('baseline');
    expect(snapshotRows(timeline[0]!, 'Челябинск')).toHaveLength(10);
    const rows = snapshotRows(timeline[1]!, 'Челябинск');
    expect(rows.filter(row => row.stockAsOf === null)).toHaveLength(6);
    expect(rows.find(row => row.eventType === 'death')).toMatchObject({periodStart: '2026-01-01', periodEnd: '2026-12-31', value: timeline[1]!.deaths});
    const series = signedComponentSeries(timeline);
    expect(series.find(row => row.id === 'death')!.points[0]).toEqual({year: 2025, value: null});
    expect(series.find(row => row.id === 'death')!.points[1]).toEqual({year: 2026, value: -timeline[1]!.deaths!});
    expect(stockFlowResidual(timeline[0]!, timeline[1]!)).toBe(0);
    expect(stockFlowResidual(timeline[0]!, timeline[2]!)).toBeNull();
  });
  it('exports independently identified scenario slices with exact fictional counts', () => {
    const baseline = provider.getSnapshot('baseline', 2036)!;
    const inflow = provider.getSnapshot('inflow', 2036)!;
    expect(inflow.population - baseline.population).toBe(1620);
    const rows = [...snapshotRows(baseline, 'Челябинск'), ...snapshotRows(inflow, 'Челябинск')];
    const csv = buildCanonicalCsv(rows, {smallCellThreshold: 1});
    expect(csv).toContain('"dataset_id","scenario_id","representation"');
    expect(csv).toContain('"baseline","fictional_demo"');
    expect(csv).toContain('"inflow","fictional_demo"');
    expect(csv).not.toContain('suppressed_small_cell');
  });
  it('keeps missing, zero and an inverted period distinct', () => {
    const rows = legacyCanonicalRows(provider.legacy, 'RU-CHE-SET');
    expect(filterCanonicalRows(rows, 'overview', 2027, 2025)).toEqual([]);
    const age = ageSexFromCanonicalRows([{...rows[0]!, ageBand: '0-17', sex: 'male', value: null}, {...rows[0]!, ageBand: '0-17', sex: 'female', value: 0}]);
    expect(age).toEqual([{ageBand: '0-17', male: null, female: 0}]);
  });
  it('accepts only an explicit uncomputed local draft and bounded assumptions', () => {
    expect(parseDraft(emptyDraft())).toEqual(emptyDraft());
    expect(parseDraft({...emptyDraft(), status: 'complete'})).toBeNull();
    expect(parseDraft({...emptyDraft(), parameters: {...emptyDraft().parameters, fertility: Infinity}})).toBeNull();
  });
});
