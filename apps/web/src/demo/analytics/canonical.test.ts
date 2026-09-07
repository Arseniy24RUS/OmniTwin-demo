import { describe, expect, it } from 'vitest';
import { buildCanonicalCsv, formatNullableNumber, type CanonicalRow } from './canonical';

const rows: CanonicalRow[] = [{
  geographyId: 'GEO-930',
  geographyName: 'Город N',
  period: '2026-01-01',
  stockAsOf: '2026-01-01',
  periodStart: null,
  periodEnd: null,
  metric: 'Население "всего"',
  value: null,
  unit: 'persons',
  provenance: 'synthetic',
  coverage: 1,
  runMode: 'synthetic',
}];

function csvRecords(csv: string): Array<Record<string, string>> {
  const lines = csv.trim().split('\n');
  const cells = (line: string) => line
    .replace(/^\uFEFF/, '')
    .slice(1, -1)
    .split('","')
    .map((value) => value.replaceAll('""', '"'));
  const header = cells(lines[0]);
  return lines.slice(1).map((line) => Object.fromEntries(cells(line).map((value, index) => [header[index], value])));
}


describe('analytics data boundary', () => {
  it('keeps missing distinct from a measured zero and exports provenance', () => {
    expect(formatNullableNumber(null)).toBe('—');
    expect(formatNullableNumber(0)).toBe('0');
    const csv = buildCanonicalCsv(rows);
    expect(csv).toContain('"Население ""всего"""');
    expect(csv).toContain('"synthetic"');
    expect(csv).toContain('"","persons"');
  });

  it('suppresses positive small count cells in CSV without changing zero or missing', () => {
    const disclosed = csvRecords(buildCanonicalCsv([
      { ...rows[0], metric: 'population', ageBand: 'small', sex: 'female', value: 9 },
      { ...rows[0], metric: 'population', ageBand: 'complement', sex: 'female', value: 12 },
      { ...rows[0], metric: 'population', ageBand: 'zero', sex: 'female', value: 0 },
      { ...rows[0], metric: 'population', ageBand: 'missing', sex: 'female', value: null },
    ]));
    const byAge = new Map(disclosed.map((record) => [record.age_band, record]));
    expect(byAge.get('small')).toMatchObject({ value: '', disclosure_status: 'suppressed_small_cell' });
    expect(byAge.get('complement')).toMatchObject({ value: '', disclosure_status: 'suppressed_complementary' });
    expect(byAge.get('zero')).toMatchObject({ value: '0', disclosure_status: '' });
    expect(byAge.get('missing')).toMatchObject({ value: '', disclosure_status: '' });
    expect(buildCanonicalCsv([{ ...rows[0], value: 4 }], { smallCellThreshold: 4 })).toContain('"4","persons"');
  });

  it('suppresses a complementary event component so stock-flow identity cannot recover the primary cell', () => {
    const eventBase: CanonicalRow = {
      ...rows[0],
      period: '2025-01-01 — 2025-12-31',
      stockAsOf: null,
      periodStart: '2025-01-01',
      periodEnd: '2025-12-31',
      ageBand: null,
      sex: null,
      unit: 'events',
    };
    const exported = csvRecords(buildCanonicalCsv([
      { ...eventBase, metric: 'live_birth', eventType: 'live_birth', value: 50 },
      { ...eventBase, metric: 'death', eventType: 'death', value: 9 },
      { ...eventBase, metric: 'external_immigration', eventType: 'external_immigration', value: 30 },
      { ...eventBase, metric: 'external_emigration', eventType: 'external_emigration', value: 20 },
      { ...eventBase, metric: 'internal_migration_in', eventType: 'internal_migration_in', value: 40 },
      { ...eventBase, metric: 'internal_migration_out', eventType: 'internal_migration_out', value: 31 },
      { ...eventBase, metric: 'population_stock_delta', eventType: null, value: 60, unit: 'persons' },
    ]));
    const byEvent = new Map(exported.map((record) => [record.event_type || record.metric, record]));
    expect(byEvent.get('death')).toMatchObject({ value: '', disclosure_status: 'suppressed_small_cell' });
    expect(byEvent.get('external_emigration')).toMatchObject({ value: '', disclosure_status: 'suppressed_complementary' });
    for (const eventType of ['live_birth', 'external_immigration', 'internal_migration_in', 'internal_migration_out']) {
      expect(byEvent.get(eventType)?.disclosure_status).toBe('');
    }

    const visibleNetBeforeSuppressedOutflows = Number(byEvent.get('live_birth')?.value)
      + Number(byEvent.get('external_immigration')?.value)
      + Number(byEvent.get('internal_migration_in')?.value)
      - Number(byEvent.get('internal_migration_out')?.value);
    const unresolvedOutflows = visibleNetBeforeSuppressedOutflows - Number(byEvent.get('population_stock_delta')?.value);
    expect(unresolvedOutflows).toBe(29);
    expect(unresolvedOutflows).not.toBe(9);
  });

  it('fails closed instead of exporting a partition with one primary cell and no sibling', () => {
    expect(() => buildCanonicalCsv([{ ...rows[0], metric: 'population', ageBand: '0-9', value: 8 }]))
      .toThrow(/CSV_DISCLOSURE_UNSAFE/);
    expect(() => buildCanonicalCsv([{
      ...rows[0],
      stockAsOf: null,
      periodStart: '2025-01-01',
      periodEnd: '2025-12-31',
      unit: 'events',
      metric: 'death',
      eventType: 'death',
      value: 8,
    }])).toThrow(/CSV_DISCLOSURE_UNSAFE/);
  });

  it('adds deterministic complementary suppression so a primary cell cannot be recovered from its total', () => {
    const partition: CanonicalRow[] = [
      { ...rows[0], metric: 'population', ageBand: 'all', sex: 'female', value: 109 },
      { ...rows[0], metric: 'population', ageBand: '0-9', sex: 'female', value: 9 },
      { ...rows[0], metric: 'population', ageBand: '10-19', sex: 'female', value: 40 },
      { ...rows[0], metric: 'population', ageBand: '20-29', sex: 'female', value: 60 },
      { ...rows[0], metric: 'population', ageBand: '0-9', sex: 'male', value: 11 },
    ];
    const byAgeAndSex = (input: CanonicalRow[]) => new Map(csvRecords(buildCanonicalCsv(input)).map((record) => [
      `${record.sex}:${record.age_band}`,
      record,
    ]));

    const disclosed = byAgeAndSex(partition);
    expect(disclosed.get('female:0-9')).toMatchObject({ value: '', disclosure_status: 'suppressed_small_cell' });
    expect(disclosed.get('female:10-19')).toMatchObject({ value: '', disclosure_status: 'suppressed_complementary' });
    expect(disclosed.get('female:20-29')).toMatchObject({ value: '60', disclosure_status: '' });
    expect(disclosed.get('female:all')).toMatchObject({ value: '109', disclosure_status: '' });
    expect(disclosed.get('male:0-9')).toMatchObject({ value: '11', disclosure_status: '' });

    const residualAcrossSuppressedDetails = Number(disclosed.get('female:all')?.value)
      - Number(disclosed.get('female:20-29')?.value);
    expect(residualAcrossSuppressedDetails).toBe(49);
    expect(residualAcrossSuppressedDetails).not.toBe(9);
    expect(partition.map((row) => row.value)).toEqual([109, 9, 40, 60, 11]);

    const reordered = byAgeAndSex([...partition].reverse());
    for (const key of ['female:0-9', 'female:10-19', 'female:20-29', 'female:all', 'male:0-9']) {
      expect(reordered.get(key)?.disclosure_status).toBe(disclosed.get(key)?.disclosure_status);
    }
  });

  it('leaves count partitions without small cells unchanged and never treats null as zero', () => {
    const disclosed = csvRecords(buildCanonicalCsv([
      { ...rows[0], metric: 'households', ageBand: 'all', value: 100 },
      { ...rows[0], metric: 'households', ageBand: 'group-a', value: 40 },
      { ...rows[0], metric: 'households', ageBand: 'group-b', value: 60 },
      { ...rows[0], metric: 'missing_count', value: null },
      { ...rows[0], metric: 'measured_zero', value: 0 },
    ]));
    expect(disclosed.slice(0, 3).map(({ value, disclosure_status: status }) => ({ value, status }))).toEqual([
      { value: '100', status: '' },
      { value: '40', status: '' },
      { value: '60', status: '' },
    ]);
    expect(disclosed[3]).toMatchObject({ value: '', disclosure_status: '' });
    expect(disclosed[4]).toMatchObject({ value: '0', disclosure_status: '' });
  });

});
