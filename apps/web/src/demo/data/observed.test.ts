import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { validateObservedCity, getObservedSnapshot, type ObservedCityReferenceV1 } from './observed';

const fixture = (): ObservedCityReferenceV1 => ({
  datasetId: 'explicit-test-observed-reference', representation: 'observed_reference',
  territory: { id: 'RU-CHE-SET', name: 'Челябинский городской округ', oktmo: '75701000' },
  snapshots: [{ year: 2024, asOf: '2024-01-01', population: 10, male: 4, female: 6,
    ageSex: [{ ageBand: '0-4', male: 2, female: 3 }, { ageBand: '5+', male: 2, female: 3 }] }],
  sources: [{ id: 'test-only', title: 'Explicit tiny test fixture, not public statistics', url: 'https://74.rosstat.gov.ru/main_indicators' }],
  notes: [], seriesBreaks: [],
});
describe('independent observed city reference boundary', () => {
  it('publishes only reviewed historical totals and complete official city pyramids', () => {
    const reference = validateObservedCity(JSON.parse(readFileSync(new URL('../../../public/demo/observed-chelyabinsk-v1.json', import.meta.url), 'utf8')));
    expect(reference.history?.map(p => [p.year,p.population])).toEqual([[2021,1187960],[2022,1186284],[2023,1182517],[2024,1177058]]);
    expect(reference.snapshots.map(s => s.year)).toEqual([2023,2024]);
    expect(getObservedSnapshot(reference,2023)?.ageSex).toHaveLength(18);
    expect(getObservedSnapshot(reference,2024)?.ageSex).toHaveLength(21);
    expect(getObservedSnapshot(reference,2024)?.male).toBe(529412);
    expect(getObservedSnapshot(reference,2024)?.female).toBe(647646);
    expect(getObservedSnapshot(reference,2024)?.ageSex.at(-1)).toEqual({ageBand:'100+',male:53,female:111});
    expect(reference.seriesBreaks[0]?.year).toBe(2023);
    expect(JSON.stringify(reference)).not.toMatch(/registry_declared|raw\.pmo|localPath|sourceRows/);
  });
  it('validates exact observed sex and age partitions', () => expect(validateObservedCity(fixture()).snapshots[0]?.population).toBe(10));
  it('does not extrapolate to fictional demographic years', () => {
    expect(getObservedSnapshot(fixture(), 2026)).toBeNull();
    expect(getObservedSnapshot(fixture(), 2024)?.asOf).toBe('2024-01-01');
  });
  it('rejects inconsistent totals, duplicate dates and overlapping age partitions', () => {
    const totals = fixture(); totals.snapshots[0]!.male = 3;
    expect(() => validateObservedCity(totals)).toThrow();
    const duplicate = fixture(); duplicate.snapshots.push(duplicate.snapshots[0]!);
    expect(() => validateObservedCity(duplicate)).toThrow();
    const overlap = fixture(); overlap.snapshots[0]!.ageSex[1]!.ageBand = '0+';
    expect(() => validateObservedCity(overlap)).toThrow();
  });
  it('rejects null-as-zero, other territory and invented source protocols', () => {
    const missing = fixture(); (missing.snapshots[0] as unknown as {male: null}).male = null;
    expect(() => validateObservedCity(missing)).toThrow();
    const territory = fixture(); territory.territory.oktmo = 'not-chelyabinsk';
    expect(() => validateObservedCity(territory)).toThrow();
    const source = fixture(); source.sources[0]!.url = 'file:///private-source';
    expect(() => validateObservedCity(source)).toThrow();
  });
});
