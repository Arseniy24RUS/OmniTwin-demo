// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { StaticDemoProvider } from '../data/StaticDemoProvider';
import type { DemoContextV1, DemoDataset, DemoDatasetManifestV1, DemoLegacyExport } from '../types';
import { DemoAnalytics } from './DemoAnalytics';
import { DemoScenarios } from './DemoScenarios';
import * as canonical from './canonical';

const fixtureRoot = process.cwd().replaceAll('\\', '/').endsWith('/apps/web') ? 'public/demo' : 'apps/web/public/demo';
const read = (name: string) => JSON.parse(readFileSync(resolve(process.cwd(), fixtureRoot, name), 'utf8'));
const provider = new StaticDemoProvider(read('dataset.json') as DemoDataset, read('manifest.json') as DemoDatasetManifestV1, read('legacy-synthetic-chelyabinsk-v1.json') as DemoLegacyExport);
const context: DemoContextV1 = {datasetId: provider.manifest.datasetId, territoryId: 'RU-CHE-SET', scenario: 'baseline', year: 2026, cohort: null, presentationMinutes: 480, weather: 'clear', playing: false, speed: 1, camera: {longitude: 61.4, latitude: 55.16, zoom: 16, pitch: 45, bearing: 0}};
beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), clear: () => values.clear()});
});
afterEach(() => {cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals();});

describe('static analytical workspace', () => {
  it('renders existing chart/table semantics and changes the shared year without an API', () => {
    const change = vi.fn();
    render(<DemoAnalytics provider={provider} context={context} onContextChange={change} />);
    expect(screen.getByRole('heading', {name: 'Возрастно-половая структура'})).toBeTruthy();
    expect(screen.getByTestId('analytics-canonical-table').querySelectorAll('tbody tr')).toHaveLength(10);
    fireEvent.change(screen.getByLabelText('Демографический год'), {target: {value: '2030'}});
    expect(change).toHaveBeenCalledWith({year: 2030});
  });
  it('opens exactly the clicked age/sex cohort, including keyboard selection', () => {
    const change = vi.fn(); const select = vi.fn();
    render(<DemoAnalytics provider={provider} context={context} onContextChange={change} onSelectCohort={select} />);
    fireEvent.keyDown(screen.getByRole('button', {name: /^Женщины, 18-34:/}), {key: 'Enter'});
    expect(select).toHaveBeenCalledWith({ageBand: '18-34', sex: 'female'});
    expect(change).toHaveBeenCalledWith({cohort: {ageBand: '18-34', sex: 'female'}});
  });
  it('does not manufacture events for the initial stock', () => {
    render(<DemoAnalytics provider={provider} context={context} onContextChange={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Набор показателей'), {target: {value: 'events'}});
    expect(screen.getByTestId('analytics-canonical-table').textContent).toContain('нет агрегатов');
    expect(screen.getByTestId('analytics-export').hasAttribute('disabled')).toBe(true);
  });
  it('compares prepared snapshots and leaves numbers unchanged when editing a draft', () => {
    const change = vi.fn();
    const {rerender} = render(<DemoScenarios provider={provider} context={{...context, scenario: 'inflow', year: 2036}} onContextChange={change} />);
    const result = screen.getByTestId('scenario-population-delta').textContent;
    expect(result?.replace(/\s/g, '')).toContain('+1620');
    fireEvent.change(screen.getByLabelText('Название'), {target: {value: 'Новая гипотеза'}});
    fireEvent.change(screen.getByLabelText(/Рождаемость/), {target: {value: '25'}});
    expect(screen.getByTestId('scenario-population-delta').textContent).toBe(result);
    fireEvent.change(screen.getByLabelText('Сценарий B'), {target: {value: 'ageing'}});
    expect(change).toHaveBeenCalledWith({scenario: 'ageing'});
    rerender(<DemoScenarios provider={provider} context={{...context, scenario: 'ageing', year: 2036}} onContextChange={change} />);
    expect(screen.getByTestId('scenario-population-delta').textContent?.replace(/\s/g, '')).toContain('-1325');
  });
  it('uses shared A/B context on mount and after a global scenario change', () => {
    const change = vi.fn();
    const {rerender} = render(<DemoScenarios provider={provider} context={{...context, year: 2036}} onContextChange={change} />);
    expect((screen.getByLabelText('Сценарий B') as HTMLSelectElement).value).toBe('baseline');
    expect(screen.getByTestId('scenario-population-delta').textContent?.replace(/\s/g, '')).toContain('0человек');
    fireEvent.change(screen.getByLabelText('Сценарий A'), {target: {value: 'ageing'}});
    expect(change).toHaveBeenCalledWith({comparisonScenario: 'ageing'});
    rerender(<DemoScenarios provider={provider} context={{...context, scenario: 'inflow', comparisonScenario: 'ageing', year: 2036}} onContextChange={change} />);
    expect((screen.getByLabelText('Сценарий A') as HTMLSelectElement).value).toBe('ageing');
    expect((screen.getByLabelText('Сценарий B') as HTMLSelectElement).value).toBe('inflow');
    expect(screen.getByTestId('scenario-population-delta').textContent?.replace(/\s/g, '')).toContain('+2945');
  });
  it('restricts population, pyramid and table to the cohort and labels missing group events', () => {
    render(<DemoAnalytics provider={provider} context={{...context, cohort: {ageBand: '18-34', sex: 'female'}}} onContextChange={vi.fn()} />);
    expect(screen.getByTestId('analytics-population').textContent).toContain('707');
    expect(screen.getByRole('button', {name: /^Женщины, 18-34:/}).getAttribute('aria-label')).toContain('707');
    expect(screen.queryByRole('button', {name: /^Мужчины,/})).toBeNull();
    expect(screen.getByTestId('analytics-canonical-table').querySelectorAll('tbody tr')).toHaveLength(7);
    expect(screen.getAllByText(/нет групповых данных/i).length).toBeGreaterThan(0);
  });
  it('passes the filtered rows and scope to the actual CSV export boundary', async () => {
    const download = vi.spyOn(canonical, 'downloadCanonicalCsv').mockResolvedValue('saved');
    render(<DemoAnalytics provider={provider} context={{...context, cohort: {ageBand: '18-34', sex: 'female'}}} onContextChange={vi.fn()} />);
    fireEvent.click(screen.getByTestId('analytics-export'));
    await waitFor(() => expect(download).toHaveBeenCalledOnce());
    const rows = download.mock.calls[0]![0];
    expect(rows.filter(row => row.stockAsOf !== null).reduce((sum, row) => sum + (row.value ?? 0), 0)).toBe(707);
    expect(rows.every(row => row.cohortAgeBand === '18-34' && row.cohortSex === 'female' && row.analysisScope === 'cohort_cross_section')).toBe(true);
    expect(rows.filter(row => row.stockAsOf === null).every(row => row.value === null && row.coverage === null)).toBe(true);
  });
  it('compares the same cohort in both scenarios and never duplicates identical-scenario CSV rows', async () => {
    const cohort = {ageBand: '18-34', sex: 'female'} as const;
    const download = vi.spyOn(canonical, 'downloadCanonicalCsv').mockResolvedValue('saved');
    const {rerender} = render(<DemoScenarios provider={provider} context={{...context, scenario: 'inflow', cohort, year: 2036}} onContextChange={vi.fn()} />);
    const a = provider.getPeople({scenario: 'baseline', year: 2036, ...cohort}).total;
    const b = provider.getPeople({scenario: 'inflow', year: 2036, ...cohort}).total;
    expect(screen.getByTestId('scenario-population-delta').textContent?.replace(/\s/g, '')).toContain(String(b - a));
    rerender(<DemoScenarios provider={provider} context={{...context, cohort}} onContextChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', {name: '↓ CSV сравнения'}));
    await waitFor(() => expect(download).toHaveBeenCalledOnce());
    expect(download.mock.calls[0]![0].filter(row => row.stockAsOf !== null)).toHaveLength(1);
  });
});
