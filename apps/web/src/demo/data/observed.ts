/** Published city-level aggregates, never character records or model predictions. */
export interface ObservedCitySnapshot {
  year: number;
  asOf: string;
  population: number;
  male: number;
  female: number;
  ageSex: Array<{ ageBand: string; male: number; female: number }>;
  sourceId?: string;
}
export interface ObservedCityReferenceV1 {
  datasetId: string;
  representation: 'observed_reference';
  territory: { id: string; name: string; oktmo: string };
  snapshots: ObservedCitySnapshot[];
  /** Historical stock releases may exist without a cleared age-sex table. */
  history?: Array<{ year: number; asOf: string; population: number; sourceId?: string }>;
  sources: Array<{ id: string; title: string; url: string; publishedAt?: string; sha256?: string }>;
  notes: string[];
  seriesBreaks: Array<{ year: number; label: string }>;
}
const count = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;

/** Validate partitions instead of accepting overlapping headline/age subtotals. */
export function validateObservedCity(value: unknown): ObservedCityReferenceV1 {
  const reference = value as ObservedCityReferenceV1;
  if (!reference || reference.representation !== 'observed_reference' || !reference.datasetId
    || reference.territory?.id !== 'RU-CHE-SET' || reference.territory.oktmo !== '75701000'
    || !Array.isArray(reference.snapshots) || !reference.snapshots.length
    || !Array.isArray(reference.sources) || !reference.sources.length
    || !Array.isArray(reference.notes) || !Array.isArray(reference.seriesBreaks)) throw new Error('Invalid observed city reference');
  for (const source of reference.sources) {
    if (!source.id || !source.title || !source.url.startsWith('https://')) throw new Error('Invalid observed source provenance');
  }
  const years = new Set<number>();
  if (reference.history) {
    const historicalYears = new Set<number>();
    for (const point of reference.history) {
      if (!count(point.year) || !count(point.population) || point.asOf !== `${point.year}-01-01` || historicalYears.has(point.year)) throw new Error('Invalid observed history');
      historicalYears.add(point.year);
    }
  }
  for (const snapshot of reference.snapshots) {
    if (!count(snapshot.year) || years.has(snapshot.year) || snapshot.asOf !== `${snapshot.year}-01-01`
      || ![snapshot.population, snapshot.male, snapshot.female].every(count)
      || snapshot.male + snapshot.female !== snapshot.population || !Array.isArray(snapshot.ageSex)) throw new Error('Inconsistent observed stock');
    years.add(snapshot.year);
    const historical = reference.history?.find(point => point.year === snapshot.year);
    if (historical && historical.population !== snapshot.population) throw new Error('Conflicting observed source vintages');
    let nextAge = 0; let men = 0; let women = 0;
    for (const row of snapshot.ageSex) {
      const band = /^(\d+)(?:[-–](\d+)|(\+))$/.exec(row.ageBand);
      if (!band || Number(band[1]) !== nextAge || !count(row.male) || !count(row.female)) throw new Error('Overlapping or missing observed age partition');
      const end = band[3] ? Infinity : Number(band[2]);
      if (end < nextAge) throw new Error('Invalid observed age band');
      nextAge = end + 1; men += row.male; women += row.female;
    }
    if (nextAge !== Infinity || men !== snapshot.male || women !== snapshot.female) throw new Error('Observed pyramid does not conserve population');
  }
  return reference;
}
/** No nearest-year substitution, extrapolation, or scientific scenario lookup. */
export const getObservedSnapshot = (reference: ObservedCityReferenceV1, year: number) => reference.snapshots.find(row => row.year === year) ?? null;
