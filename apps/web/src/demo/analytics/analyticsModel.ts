import type { DemoAgeBand, DemoCohort, DemoLegacyExport, DemoSnapshot } from '../types';
import type { StaticDemoProvider } from '../data/StaticDemoProvider';
import { ageBandFor, employmentFor } from '../data/fictionalProfile.mjs';
import type { ChartSeries, PyramidDatum } from './charts';
import type { CanonicalRow } from './canonical';

export const hasCohort = (cohort: DemoCohort | null | undefined) => Boolean(cohort?.ageBand || cohort?.sex || cohort?.employment);
export function cohortDescription(cohort: DemoCohort | null | undefined) {
  const employment = {child: 'дошкольники', student: 'учащиеся', employed: 'занятые', retired: 'пенсионеры', not_employed: 'не занятые'};
  return [cohort?.ageBand, cohort?.sex === 'male' ? 'мужчины' : cohort?.sex === 'female' ? 'женщины' : null, cohort?.employment ? employment[cohort.employment] : null].filter(Boolean).join(' · ');
}

/** Exact repeated cross-sections, not a fixed longitudinal membership or event attribution. */
export function cohortSnapshot(provider: StaticDemoProvider, source: DemoSnapshot, cohort: DemoCohort | null | undefined): DemoSnapshot {
  if (!hasCohort(cohort)) return source;
  const ageSex = source.ageSex.filter(row => !cohort?.ageBand || row.ageBand === cohort.ageBand).map(row => ({ageBand: row.ageBand, male: 0, female: 0}));
  const byAge = new Map(ageSex.map(row => [row.ageBand, row]));
  const employment: DemoSnapshot['employment'] = {child: 0, student: 0, employed: 0, retired: 0, not_employed: 0};
  const households = new Set<string>();
  let population = 0;
  for (const person of provider.dataset.data[source.scenario].people) {
    if (person.entryYear > source.year || (person.exitYear !== null && person.exitYear <= source.year)) continue;
    if (source.territoryId !== 'RU-CHE-SET' && person.territoryId !== source.territoryId) continue;
    if (cohort?.sex && person.sex !== cohort.sex) continue;
    const age = ageBandFor(source.year - person.birthYear);
    if (cohort?.ageBand && age !== cohort.ageBand) continue;
    const status = employmentFor(person, source.year);
    if (cohort?.employment && status !== cohort.employment) continue;
    byAge.get(age)![person.sex] += 1;
    employment[status] += 1;
    households.add(person.householdId);
    population += 1;
  }
  return {...source, population, ageSex, employment, households: households.size,
    births: null, deaths: null, immigration: null, emigration: null, internalIn: null, internalOut: null, netChange: null};
}

/** Event colour/sign semantics retained from the original AnalyticsView. */
export const COMPONENTS = [
  { key: 'births', event: 'live_birth', label: 'Рождения', color: '#39c8db', sign: 1 },
  { key: 'deaths', event: 'death', label: 'Смерти', color: '#f08c9c', sign: -1 },
  { key: 'immigration', event: 'external_immigration', label: 'Внешний приток', color: '#8cd5ae', sign: 1 },
  { key: 'emigration', event: 'external_emigration', label: 'Внешний отток', color: '#e8b078', sign: -1 },
  { key: 'internalIn', event: 'internal_migration_in', label: 'Внутренний приток', color: '#9986ee', sign: 1 },
  { key: 'internalOut', event: 'internal_migration_out', label: 'Внутренний отток', color: '#ceafe3', sign: -1 },
] as const;

export function signedComponentSeries(snapshots: readonly DemoSnapshot[]): ChartSeries[] {
  return COMPONENTS.map(component => ({
    id: component.event, label: component.label, color: component.color,
    dash: component.sign < 0 ? '5 4' : undefined,
    points: snapshots.map(snapshot => ({ year: snapshot.year - 1, value: snapshot[component.key] === null ? null : snapshot[component.key]! * component.sign })),
  }));
}

export function snapshotRows(snapshot: DemoSnapshot, geographyName: string, cohort?: DemoCohort | null): CanonicalRow[] {
  const base = {
    geographyId: snapshot.territoryId, geographyName, period: snapshot.stockAsOf,
    stockAsOf: snapshot.stockAsOf, periodStart: null, periodEnd: null,
    provenance: 'synthetic', coverage: 1, runMode: 'synthetic',
    datasetId: snapshot.datasetId, scenarioId: snapshot.scenario, representation: 'fictional_demo',
    cohortAgeBand: cohort?.ageBand ?? null, cohortSex: cohort?.sex ?? null, cohortEmployment: cohort?.employment ?? null,
    analysisScope: hasCohort(cohort) ? 'cohort_cross_section' : 'territory',
  };
  const people: CanonicalRow[] = snapshot.ageSex.filter(row => !cohort?.ageBand || row.ageBand === cohort.ageBand).flatMap(row => (['male', 'female'] as const).filter(sex => !cohort?.sex || sex === cohort.sex).map(sex => ({
    ...base, metric: 'population', unit: 'persons', ageBand: row.ageBand, sex, value: row[sex],
  })));
  // The initial stock has no preceding fictional transition; do not invent zero events.
  if (snapshot.births === null && !hasCohort(cohort)) return people;
  const events: CanonicalRow[] = COMPONENTS.map(component => ({
    ...base, stockAsOf: null, periodStart: `${snapshot.year - 1}-01-01`, periodEnd: `${snapshot.year - 1}-12-31`,
    period: `${snapshot.year - 1}`, metric: component.event, eventType: component.event,
    unit: 'events', value: hasCohort(cohort) ? null : snapshot[component.key], coverage: hasCohort(cohort) ? null : 1,
  }));
  return [...people, ...events];
}

export function stockFlowResidual(previous: DemoSnapshot, current: DemoSnapshot): number | null {
  if (previous.scenario !== current.scenario || previous.territoryId !== current.territoryId || current.year !== previous.year + 1) return null;
  if (COMPONENTS.some(component => current[component.key] === null)) return null;
  const change = COMPONENTS.reduce((total, component) => total + current[component.key]! * component.sign, 0);
  return current.population - previous.population - change;
}

export function legacyCanonicalRows(legacy: DemoLegacyExport, territoryId: string): CanonicalRow[] {
  const geography = legacy.geography.find(row => row.id === territoryId);
  if (!geography) return [];
  const geographyName = String(geography.name_ru ?? territoryId);
  // Select one exact hierarchy level. Parent and child rows must never be added together.
  return [...legacy.population, ...legacy.events_aggregate].filter(row => row.geography_id === territoryId).map(row => {
    const stockAsOf = typeof row.stock_as_of === 'string' ? row.stock_as_of : null;
    const periodStart = typeof row.period_start === 'string' ? row.period_start : null;
    const periodEnd = typeof row.period_end === 'string' ? row.period_end : null;
    if ((stockAsOf !== null) === (periodStart !== null && periodEnd !== null)) throw new Error('Legacy aggregate violates the temporal contract');
    if (row.value !== null && (typeof row.value !== 'number' || !Number.isFinite(row.value))) throw new Error('Legacy aggregate contains a non-numeric value');
    if (row.provenance !== 'synthetic') throw new Error('The public legacy demo must contain only synthetic rows');
    return {
      geographyId: territoryId, geographyName, stockAsOf, periodStart, periodEnd,
      period: stockAsOf ?? `${periodStart} — ${periodEnd}`, metric: stockAsOf ? 'population' : String(row.event_type),
      ageBand: typeof row.age_band === 'string' ? row.age_band : null,
      sex: typeof row.sex === 'string' ? row.sex : null,
      eventType: typeof row.event_type === 'string' ? row.event_type : null,
      unit: String(row.unit), value: row.value as number | null, provenance: 'synthetic',
      coverage: typeof row.coverage === 'number' ? row.coverage : null,
      runMode: 'synthetic', datasetId: legacy.sourceRunId, representation: 'synthetic_legacy_fixture',
    };
  });
}

export function ageSexFromCanonicalRows(rows: readonly CanonicalRow[]): PyramidDatum[] {
  const latest = rows.filter(row => row.stockAsOf !== null).map(row => row.stockAsOf!).sort().at(-1);
  const byAge = new Map<string, PyramidDatum>();
  for (const row of rows) {
    if (row.stockAsOf !== latest || !row.ageBand || (row.sex !== 'male' && row.sex !== 'female')) continue;
    const item = byAge.get(row.ageBand) ?? { ageBand: row.ageBand as DemoAgeBand, male: null, female: null };
    item[row.sex] = row.value;
    byAge.set(row.ageBand, item);
  }
  return [...byAge.values()];
}

export function filterCanonicalRows(rows: readonly CanonicalRow[], dataset: 'overview' | 'population' | 'events', start: number, end: number): CanonicalRow[] {
  return rows.filter(row => {
    if (dataset === 'population' && row.stockAsOf === null) return false;
    if (dataset === 'events' && row.stockAsOf !== null) return false;
    const year = Number((row.stockAsOf ?? row.periodStart)?.slice(0, 4));
    return Number.isFinite(year) && year >= start && year <= end;
  });
}
