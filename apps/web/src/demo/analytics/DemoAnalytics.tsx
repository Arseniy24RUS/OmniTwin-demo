import { useMemo, useState } from 'react';
import type { DemoCohort } from '../types';
import { AgeSexPyramid, ChartLegend, SeriesChart, type ChartSeries } from './charts';
import { COMPONENTS, cohortDescription, cohortSnapshot, filterCanonicalRows, hasCohort, legacyCanonicalRows, signedComponentSeries, snapshotRows, stockFlowResidual } from './analyticsModel';
import { downloadCanonicalCsv, formatNullableNumber, type CanonicalRow } from './canonical';
import { ContextFilters, type DemoAnalyticsProps } from './controls';
import './analytics.css';

type DatasetFilter = 'overview' | 'population' | 'events';
const fmt = (value: number | null) => formatNullableNumber(value, 0);
const signed = (value: number | null) => value === null ? '—' : `${value > 0 ? '+' : ''}${fmt(value)}`;
const METRICS: Record<string, string> = { population: 'Население', ...Object.fromEntries(COMPONENTS.map(component => [component.event, component.label])) };

export function CanonicalTable({ rows, testId = 'analytics-canonical-table' }: {rows: readonly CanonicalRow[]; testId?: string}) {
  return <div className="da-table-scroll" role="region" aria-label="Канонические агрегаты, горизонтальная прокрутка" tabIndex={0}>
    <table className="da-table" data-testid={testId}><caption>Численности на дату и события за период; единицы не смешиваются.</caption>
      <thead><tr><th scope="col">Период / срез</th><th scope="col">Показатель</th><th scope="col">Группа</th><th scope="col" className="da-number">Значение</th><th scope="col">Происхождение</th></tr></thead>
      <tbody>{rows.length ? rows.map((row, index) => <tr key={`${row.period}-${row.metric}-${row.ageBand}-${row.sex}-${index}`}>
        <td>{row.stockAsOf ?? row.periodStart?.slice(0, 4)}</td><td>{METRICS[row.metric] ?? row.metric}</td>
        <td>{row.ageBand ? `${row.ageBand} · ${row.sex === 'male' ? 'мужчины' : 'женщины'}` : row.analysisScope === 'cohort_cross_section' ? 'Выбранная группа' : 'Все группы'}</td>
        <td className="da-number">{fmt(row.value)} <small>{row.value === null && row.analysisScope === 'cohort_cross_section' ? 'нет групповых данных' : row.unit === 'persons' ? 'чел.' : 'событий'}</small></td>
        <td><span className="da-provenance">synthetic</span></td>
      </tr>) : <tr><td colSpan={5}>Для выбранного периода нет агрегатов. Пропуски не заменены нулями.</td></tr>}</tbody>
    </table>
  </div>;
}

function ExportButton({ rows, filename, legacy = false }: {rows: CanonicalRow[]; filename: string; legacy?: boolean}) {
  const [status, setStatus] = useState('');
  async function exportCsv() {
    setStatus('Подготовка CSV…');
    try {
      const result = await downloadCanonicalCsv(rows, filename, legacy ? {} : { smallCellThreshold: 1 });
      setStatus(result === 'saved' ? 'CSV сохранён' : result === 'cancelled' ? 'Сохранение отменено' : 'Загрузка CSV началась');
    } catch (error) { setStatus(error instanceof Error ? error.message : 'Не удалось сохранить CSV'); }
  }
  return <div className="da-export"><button type="button" onClick={() => void exportCsv()} disabled={!rows.length} data-testid={legacy ? 'legacy-analytics-export' : 'analytics-export'}>↓ Скачать CSV</button><span role="status" className="da-export-status">{status}</span></div>;
}

export function DemoAnalytics({ provider, context, onContextChange, onSelectCohort }: DemoAnalyticsProps & {
  onSelectCohort?: (cohort: DemoCohort) => void;
}) {
  const { scenario, year, territoryId } = context;
  const {ageBand, sex, employment} = context.cohort ?? {};
  const cohort = useMemo(() => hasCohort({ageBand, sex, employment}) ? {ageBand, sex, employment} : null, [ageBand, sex, employment]);
  const [dataset, setDataset] = useState<DatasetFilter>('overview');
  const [rangeStart, setRangeStart] = useState(provider.manifest.startYear);
  const [rangeEnd, setRangeEnd] = useState(provider.manifest.endYear);
  const [showAllRows, setShowAllRows] = useState(false);
  const [legacyExpanded, setLegacyExpanded] = useState(false);
  const timeline = useMemo(() => provider.getTimeline(scenario, territoryId).map(item => cohortSnapshot(provider, item, cohort)), [provider, scenario, territoryId, cohort]);
  const snapshot = timeline.find(item => item.year === year) ?? null;
  const visibleTimeline = useMemo(() => timeline.filter(item => item.year >= rangeStart && item.year <= rangeEnd), [timeline, rangeStart, rangeEnd]);
  const territory = provider.territories.find(item => item.id === territoryId);
  const scenarioLabel = provider.scenarios.find(item => item.id === scenario)?.label ?? scenario;
  const rows = useMemo(() => {
    const selection = showAllRows ? visibleTimeline : snapshot ? [snapshot] : [];
    return selection.flatMap(item => snapshotRows(item, territory?.name ?? territoryId, cohort)).filter(row => dataset === 'overview' || (dataset === 'population' ? row.stockAsOf !== null : row.stockAsOf === null));
  }, [showAllRows, visibleTimeline, snapshot, territory?.name, territoryId, dataset, cohort]);
  const populationSeries: ChartSeries[] = useMemo(() => [{id: scenario, label: scenarioLabel, color: '#39c8db', points: visibleTimeline.map(item => ({year: item.year, value: item.population}))}], [scenario, scenarioLabel, visibleTimeline]);
  const components = useMemo(() => signedComponentSeries(visibleTimeline), [visibleTimeline]);
  const legacyRows = useMemo(() => legacyCanonicalRows(provider.legacy, territoryId), [provider, territoryId]);
  const legacyStockDates = [...new Set(legacyRows.map(row => row.stockAsOf).filter((date): date is string => date !== null))].sort();
  const accountingPass = timeline.slice(1).every((item, index) => stockFlowResidual(timeline[index]!, item) === 0);
  const selectCohort = (cohort: DemoCohort) => { onContextChange({cohort}); onSelectCohort?.(cohort); };
  if (!snapshot) return <section className="demo-analytics da-workspace"><h1>Аналитика</h1><ContextFilters provider={provider} context={context} onContextChange={onContextChange} /><p role="status" className="da-empty">Для выбранного сценария, территории и года нет подготовленного среза.</p></section>;
  const natural = snapshot.births === null || snapshot.deaths === null ? null : snapshot.births - snapshot.deaths;
  const migration = snapshot.immigration === null || snapshot.emigration === null || snapshot.internalIn === null || snapshot.internalOut === null ? null : snapshot.immigration - snapshot.emigration + snapshot.internalIn - snapshot.internalOut;
  const cohortLabel = cohortDescription(cohort);
  return <section className="demo-analytics da-workspace" aria-label="Аналитика вымышленного населения" data-testid="demo-analytics">
    <header className="da-page-heading"><div><p className="da-eyebrow">Данные → структура → персонажи</p><h1>Аналитика населения</h1><p>Единый набор для города, групп населения и подготовленных сценариев.</p></div><span className="da-source-tag">Синтетическая демонстрация</span></header>
    <ContextFilters provider={provider} context={context} onContextChange={onContextChange} />
    {cohort ? <p className="da-chart-footnote" data-testid="analytics-cohort-scope">Группа: {cohortLabel}. Все численности, графики и основной CSV ограничены этой группой. Возраст и занятость определяются заново на каждую дату: это ежегодные поперечные срезы, не неизменный состав людей.</p> : <p className="da-chart-footnote">Охват: все вымышленные жители выбранной территории.</p>}
    <dl className="da-stat-strip">
      <div><dt>Население на 1 января</dt><dd data-testid="analytics-population">{fmt(snapshot.population)}<small>человек{cohort ? ' в группе' : ''}</small></dd></div>
      <div><dt>Естественное изменение</dt><dd>{signed(natural)}<small>{cohort ? 'нет групповых данных' : year > provider.manifest.startYear ? `за ${year - 1} год` : 'нет предшествующего периода'}</small></dd></div>
      <div><dt>Миграционное сальдо</dt><dd>{signed(migration)}<small>{cohort ? 'нет групповых данных' : year > provider.manifest.startYear ? `за ${year - 1} год` : 'нет предшествующего периода'}</small></dd></div>
      <div><dt>Занятые персонажи{cohort ? ' группы' : ''}</dt><dd>{fmt(snapshot.employment.employed)}<small>{fmt(snapshot.households)} домохозяйств{cohort ? ' с жителями группы' : ''}</small></dd></div>
    </dl>
    <div className="da-chart-grid">
      <section className="da-chart-section"><header><div><h2>Возрастно-половая структура</h2><p>{territory?.name} · 1 января {year}</p></div></header>
        <AgeSexPyramid data={snapshot.ageSex} cohort={cohort} sexFilter={cohort?.sex} onSelectCohort={selected => selectCohort({...cohort, ...selected})} />
        <div className="da-chart-footnote"><span>Выберите полосу, чтобы открыть персонажей группы.</span>{cohortLabel ? <button type="button" onClick={() => onContextChange({cohort: null})}>Сбросить: {cohortLabel} ×</button> : null}</div>
      </section>
      <section className="da-chart-section"><header><div><h2>Динамика численности</h2><p>Stocks на 1 января · {scenarioLabel}</p></div></header>
        <SeriesChart series={populationSeries} title="Динамика синтетической численности" selectedYear={year} onSelectYear={selectedYear => onContextChange({year: selectedYear})} />
        <div className="da-chart-footnote"><span>Выбор точки меняет общий демографический год.</span><span>{rangeStart}–{rangeEnd}</span></div>
      </section>
    </div>
    <section className="da-chart-section da-components-section"><header><div><h2>Компоненты изменения населения</h2><p>Рождения и приток — выше нуля; смерти и отток — ниже. По оси X — год события.</p></div><div className="da-period-filter" aria-label="Диапазон графиков">
      <label><span>От среза</span><select aria-label="Начало диапазона" value={rangeStart} onChange={event => setRangeStart(Number(event.target.value))}>{timeline.map(item => <option key={item.year} value={item.year}>{item.year}</option>)}</select></label>
      <label><span>До среза</span><select aria-label="Конец диапазона" value={rangeEnd} onChange={event => setRangeEnd(Number(event.target.value))}>{timeline.map(item => <option key={item.year} value={item.year}>{item.year}</option>)}</select></label>
    </div></header>
      {cohort ? <p className="da-empty" role="status">Нет групповых данных о событиях. Изменение численности возрастной группы включает переходы через возрастные границы; его нельзя приписывать рождениям, смертям или миграции.</p> : rangeStart > rangeEnd ? <p className="da-empty" role="status">Начало диапазона позже окончания. Выберите согласованный период.</p> : <><SeriesChart series={components} title="Рождения, смерти и миграционные компоненты" includeZero selectedYear={year - 1} unit="событий" /><ChartLegend series={components} /></>}
      <p className="da-chart-footnote">Для начального среза {provider.manifest.startYear} нет событий предыдущего года. Это отсутствие данных, а не нулевые события.</p>
    </section>
    <section className="da-table-section"><header><div><h2>Канонические агрегаты</h2><p>{territory?.name} · {showAllRows ? 'выбранный диапазон' : `срез ${year} и предшествующий год`} · {rows.length} строк</p></div><ExportButton rows={rows} filename={`${provider.manifest.datasetId}-${scenario}-${territoryId}-${year}`} /></header>
      <div className="da-table-filters"><label><span>Показатели</span><select aria-label="Набор показателей" value={dataset} onChange={event => setDataset(event.target.value as DatasetFilter)}><option value="overview">Население и события</option><option value="population">Население</option><option value="events">События</option></select></label><label className="da-checkbox"><input type="checkbox" checked={showAllRows} onChange={event => setShowAllRows(event.target.checked)} />Все срезы диапазона</label><span className="da-fixed-filter">Run mode: synthetic · provenance: synthetic</span></div>
      <CanonicalTable rows={rows} /><p className="da-table-note">CSV содержит территорию, временные поля, сценарий, фильтры группы и происхождение. Данные этого набора целиком вымышлены; публичный экспорт сохраняет малые ячейки.{cohort ? ' Пустые значения событий означают отсутствие групповых данных.' : ''}</p>
    </section>
    <details className="da-evidence"><summary>Состав данных и проверка согласованности</summary><div className="da-evidence-grid">
      <dl><div><dt>Набор</dt><dd>{provider.manifest.datasetId}</dd></div><div><dt>Версия / seed</dt><dd>{provider.manifest.version} / {provider.manifest.seed}</dd></div><div><dt>Научная и прогнозная валидация</dt><dd>Не заявлены</dd></div><div><dt>Источник</dt><dd>{provider.manifest.provenance.source}</dd></div></dl>
      <ul className="da-checks"><li>Возраст × пол: {snapshot.ageSex.reduce((total, row) => total + row.male + row.female, 0) === snapshot.population ? 'сумма совпадает с населением' : 'несогласованность'}</li><li>Баланс stocks и событий: {cohort ? 'для группы не проверяется: нет групповых данных' : accountingPass ? 'сходится во всех переходах' : 'обнаружено расхождение'}</li><li>Каждый вымышленный житель имеет собственный профиль.</li><li>Местоположение и распорядок дня: visual_synthesis.</li></ul>
    </div><p>{provider.manifest.provenance.notes}</p></details>
    <details className="da-evidence da-legacy" open={legacyExpanded} onToggle={event => setLegacyExpanded(event.currentTarget.open)}><summary>Исходный стенд OmniTwin: два среза 2025–2026</summary><p>Сохранён отдельным неизменённым набором. Охват: вся выбранная территория, без фильтра группы. Его события и агрегаты не добавляются к расширенной демонстрационной траектории.</p>
      <dl className="da-legacy-stocks">{legacyStockDates.map(date => <div key={date}><dt>{date}</dt><dd>{fmt(legacyRows.filter(row => row.stockAsOf === date).reduce((total, row) => total + (row.value ?? 0), 0))} чел.</dd></div>)}</dl>
      <ExportButton rows={legacyRows} filename={`${provider.legacy.sourceRunId}-${territoryId}`} legacy />
      {legacyExpanded ? <CanonicalTable rows={filterCanonicalRows(legacyRows, 'overview', 2025, 2026)} testId="legacy-analytics-canonical-table" /> : null}
      <p className="da-table-note">Экспорт исходного стенда сохраняет прежние правила подавления малых count-ячеек; значения в таблице остаются исходными.</p>
    </details>
  </section>;
}
