// @vitest-environment jsdom
import {afterEach, describe, expect, it, vi} from 'vitest';
import {cleanup, fireEvent, render, screen} from '@testing-library/react';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import type {ObservedCityReferenceV1} from '../data/observed';
import type {StaticDemoProvider} from '../data/StaticDemoProvider';
import {DEFAULT_CONTEXT} from '../navigation';
import {DemoAnalytics} from './DemoAnalytics';
import {ObservedAnalytics, ObservedPyramid, buildObservedCsv} from './ObservedAnalytics';
import {ObservedSummary} from './ObservedSummary';
import {linePath} from './charts';

// Small layout-only age bins; production values must come from the verified reference.
const reference = {
  datasetId: 'observed-reference-layout-test', representation: 'observed_reference',
  territory: {id: 'RU-CHE-SET', name: 'Челябинский городской округ', oktmo: '75701000'},
  snapshots: [
    {year: 2021, asOf: '2021-01-01', population: 1100000, male: 500000, female: 600000, ageSex: [{ageBand: '0-4', male: 100, female: 90}, {ageBand: '65-69', male: 120, female: 150}, {ageBand: '70+', male: 200, female: 300}]},
    {year: 2022, asOf: '2022-01-01', population: 1186284, male: 530000, female: 656284, ageSex: []},
    {year: 2023, asOf: '2023-01-01', population: 1182517, male: 530000, female: 652517, ageSex: []},
    {year: 2024, asOf: '2024-01-01', population: 1177058, male: 529412, female: 647646, ageSex: [{ageBand: '0-4', male: 100, female: 90}, {ageBand: '95-99', male: 20, female: 30}, {ageBand: '100+', male: 2, female: 3}]},
  ],
  sources: [{id: 'official-test', title: 'Официальный источник — тест контракта', url: 'https://rosstat.gov.ru/test-reference', publishedAt: '2024-08-01'}],
  notes: ['Наблюдаемый исторический ряд, не прогноз.'], seriesBreaks: [{year: 2022, label: 'Пересмотр после переписи'}],
} as ObservedCityReferenceV1;
afterEach(() => {cleanup(); vi.restoreAllMocks();});

describe('official reference remains separate from fictional demo people', () => {
  it('renders the exact selected date/count and sends year/source changes without fictional cohort selection', () => {
    const year = vi.fn(); const fictional = vi.fn();
    const {container} = render(<ObservedAnalytics reference={reference} year={2024} onYearChange={year} onFictional={fictional} />);
    expect(screen.getByTestId('observed-population').textContent?.replace(/\s/g, '')).toContain('1177058');
    expect(screen.getByTestId('observed-age-table').textContent).toContain('100+');
    expect(container.querySelector('desc')?.textContent).not.toContain('Все значения синтетические');
    expect(screen.getAllByText(/Пересмотр после переписи/).length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText('Год официальной статистики'), {target: {value: '2023'}});
    expect(year).toHaveBeenCalledWith(2023);
    fireEvent.click(screen.getByRole('button', {name: 'Модельные персонажи'}));
    expect(fictional).toHaveBeenCalledOnce();
    expect(container.querySelectorAll('svg [role="button"]')).toHaveLength(0);
  });
  it('does not assign equal five-year bar height to any open-ended age group', () => {
    const {container, rerender} = render(<ObservedPyramid snapshot={reference.snapshots[0]!} />);
    expect(container.querySelector('[data-age-band="70+"]')).toBeNull();
    expect(screen.getByTestId('observed-open-age').textContent).toContain('70+');
    rerender(<ObservedPyramid snapshot={reference.snapshots[3]!} />);
    expect(container.querySelector('[data-age-band="100+"]')).toBeNull();
    expect(screen.getByTestId('observed-open-age').textContent).toContain('100+');
  });
  it('breaks the polyline before a statistical revision while retaining both observed points', () => {
    expect(linePath([{year: 2021, value: 1}, {year: 2022, value: 2}, {year: 2023, value: 3}], x => x - 2021, y => y, [2022])).toBe('M0.00,1.00 M1.00,2.00 L2.00,3.00');
  });
  it('exports exact official values with date, geography code, source and representation', () => {
    const csv = buildObservedCsv(reference, 2024);
    expect(csv).toContain('"observed_reference","75701000"');
    expect(csv).toContain('"2024-01-01","2024","all","total","1177058"');
    expect(csv).toContain('"2024-01-01","2024","all","male","529412"');
    expect(csv).toContain('"https://rosstat.gov.ru/test-reference"');
    expect(csv).toContain('"100+","female","3"');
    expect(csv).not.toContain('fictional_demo');
    expect(csv).not.toContain('"2026"');
  });
  it('keeps observed population primary and fictional character count separately labelled in the map summary', () => {
    const analytics = vi.fn(); const scenarios = vi.fn();
    render(<ObservedSummary reference={reference} year={2024} onAnalytics={analytics} onScenarios={scenarios} characterCount={8246} />);
    expect(screen.getByTestId('observed-summary-population').textContent?.replace(/\s/g, '')).toContain('1177058');
    expect(screen.getByText(/8\s*246/).textContent).toContain('персонаж');
    fireEvent.click(screen.getByRole('button', {name: 'Открыть аналитику'}));
    fireEvent.click(screen.getByRole('button', {name: 'Демосценарии'}));
    expect(analytics).toHaveBeenCalledOnce(); expect(scenarios).toHaveBeenCalledOnce();
  });
  it('does not silently relabel a missing official year as current information', () => {
    render(<ObservedAnalytics reference={reference} year={2026} onYearChange={vi.fn()} onFictional={vi.fn()} />);
    expect(screen.getAllByRole('status').some(item => item.textContent?.includes('Нет официального среза'))).toBe(true);
    expect(screen.queryByTestId('observed-population')).toBeNull();
  });
  it('uses scalar-only history without inventing old sex/age partitions or selectable snapshots', () => {
    const scalarReference: ObservedCityReferenceV1 = {...reference, snapshots: [reference.snapshots[3]!], history: [
      {year: 2021, asOf: '2021-01-01', population: 1187960},
      {year: 2022, asOf: '2022-01-01', population: 1186284},
      {year: 2023, asOf: '2023-01-01', population: 1182517},
      {year: 2024, asOf: '2024-01-01', population: 1177058},
    ]};
    render(<ObservedAnalytics reference={scalarReference} year={2024} onYearChange={vi.fn()} onFictional={vi.fn()} />);
    expect(screen.getByLabelText('Год официальной статистики').querySelectorAll('option')).toHaveLength(1);
    expect(screen.getByTestId('observed-history-table').querySelectorAll('tbody tr')).toHaveLength(4);
    const csv = buildObservedCsv(scalarReference, 2024);
    expect(csv).toContain('"2021-01-01","2021","all","total","1187960"');
    expect(csv).not.toContain('"2021-01-01","2021","all","male"');
    expect(csv).not.toContain('"2021-01-01","2021","all","female"');
  });
  it('uses the reviewed 2024 public artifact as twenty closed bands and a separate exact 100+ total', () => {
    const repository = process.cwd().replaceAll('\\', '/').endsWith('/apps/web') ? resolve(process.cwd(), '../..') : process.cwd();
    const artifact = JSON.parse(readFileSync(resolve(repository, 'data/observed/chelyabinsk-official-city-2024.json'), 'utf8'));
    const snapshot = {year: 2024, asOf: artifact.stockAsOf, population: artifact.totals.total, male: artifact.totals.male, female: artifact.totals.female, ageSex: artifact.ageSex};
    const {container} = render(<ObservedPyramid snapshot={snapshot} />);
    expect(container.querySelectorAll('[data-age-band] rect')).toHaveLength(40);
    expect(snapshot.population).toBe(1177058);
    expect(screen.getByTestId('observed-open-age').textContent).toContain('М 53');
    expect(screen.getByTestId('observed-open-age').textContent).toContain('Ж 111');
  });
  it('fails explicitly for unsupported observed territories instead of falling back to fictional counts', () => {
    const provider = {observedCity: reference} as unknown as StaticDemoProvider;
    const change = vi.fn();
    const {rerender} = render(<DemoAnalytics provider={provider} context={{...DEFAULT_CONTEXT, analyticsSource: 'observed', territoryId: 'RU-CHE-SET-KUR'}} onContextChange={change} />);
    expect(screen.getByRole('status').textContent).toContain('только для Челябинского городского округа целиком');
    expect(screen.queryByTestId('analytics-population')).toBeNull();
    fireEvent.click(screen.getByRole('button', {name: 'Весь городской округ'}));
    expect(change).toHaveBeenCalledWith({territoryId: 'RU-CHE-SET'});
    rerender(<DemoAnalytics provider={provider} context={{...DEFAULT_CONTEXT, analyticsSource: 'observed', observedYear: 2024, territoryId: 'RU-CHE-SET', cohort: {sex: 'male'}}} onContextChange={change} />);
    expect(screen.getByTestId('observed-population').textContent?.replace(/\s/g, '')).toContain('1177058');
  });
});
