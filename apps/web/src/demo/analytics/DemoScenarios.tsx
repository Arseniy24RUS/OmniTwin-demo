import { useMemo, useState } from 'react';
import type { DemoScenarioId, DemoSnapshot } from '../types';
import { AgeSexPyramid, ChartLegend, SeriesChart, type ChartSeries } from './charts';
import { ContextFilters, type DemoAnalyticsProps } from './controls';
import { downloadCanonicalCsv, formatNullableNumber } from './canonical';
import { cohortDescription, cohortSnapshot, hasCohort, snapshotRows } from './analyticsModel';
import { DRAFT_KEY, DRAFT_PARAMETERS, emptyDraft, parseDraft } from './draft';
import './analytics.css';

const fmt = (value: number | null) => formatNullableNumber(value, 0);
const signed = (value: number) => `${value > 0 ? '+' : ''}${fmt(value)}`;
const olderPopulation = (snapshot: DemoSnapshot) => snapshot.ageSex.filter(row => row.ageBand === '70+').reduce((total, row) => total + row.male + row.female, 0);

function LocalDraft() {
  const [draft, setDraft] = useState(() => {
    try { return parseDraft(JSON.parse(localStorage.getItem(DRAFT_KEY) ?? 'null')) ?? emptyDraft(); }
    catch { return emptyDraft(); }
  });
  const [status, setStatus] = useState('');
  function save() {
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); setStatus('Черновик сохранён в этом браузере. Результат не рассчитан.'); }
    catch { setStatus('Браузер не разрешил локальное сохранение. Черновик остаётся на экране.'); }
  }
  return <details className="da-evidence da-local-draft"><summary>Собственный сценарий: локальный черновик</summary>
    <p>Запишите допущения для обсуждения. Эти параметры не меняют готовые результаты A/B и не запускают научную модель.</p>
    <div className="da-draft-fields"><label><span>Название</span><input value={draft.title} maxLength={120} onChange={event => setDraft({...draft, title: event.target.value})} /></label>
      <label><span>Гипотеза и обоснование</span><textarea value={draft.note} maxLength={2000} rows={3} onChange={event => setDraft({...draft, note: event.target.value})} placeholder="Какие изменения хотите проверить и почему?" /></label></div>
    <div className="da-draft-parameters">{DRAFT_PARAMETERS.map(([key, label]) => <label key={key}><span>{label}<output>{signed(draft.parameters[key] ?? 0)}%</output></span><input type="range" min={-30} max={30} step={1} value={draft.parameters[key]} onChange={event => setDraft({...draft, parameters: {...draft.parameters, [key]: Number(event.target.value)}})} /></label>)}</div>
    <div className="da-draft-actions"><button type="button" onClick={save}>Сохранить черновик</button><button type="button" onClick={() => {setDraft(emptyDraft()); setStatus('Поля очищены. Результаты сравнения не изменились.');}}>Очистить поля</button><span className="da-uncomputed">Не рассчитан</span></div><p role="status">{status}</p>
  </details>;
}

export function DemoScenarios({provider, context, onContextChange}: DemoAnalyticsProps) {
  const leftScenario = context.comparisonScenario ?? 'baseline';
  const rightScenario = context.scenario;
  const [exportStatus, setExportStatus] = useState('');
  const {year, territoryId} = context;
  const {ageBand, sex, employment} = context.cohort ?? {};
  const cohort = useMemo(() => hasCohort({ageBand, sex, employment}) ? {ageBand, sex, employment} : null, [ageBand, sex, employment]);
  const leftTimeline = useMemo(() => provider.getTimeline(leftScenario, territoryId).map(item => cohortSnapshot(provider, item, cohort)), [provider, leftScenario, territoryId, cohort]);
  const rightTimeline = useMemo(() => provider.getTimeline(rightScenario, territoryId).map(item => cohortSnapshot(provider, item, cohort)), [provider, rightScenario, territoryId, cohort]);
  const left = leftTimeline.find(item => item.year === year) ?? null;
  const right = rightTimeline.find(item => item.year === year) ?? null;
  const leftDefinition = provider.scenarios.find(item => item.id === leftScenario)!;
  const rightDefinition = provider.scenarios.find(item => item.id === rightScenario)!;
  const territoryName = provider.territories.find(item => item.id === territoryId)?.name ?? territoryId;
  const series: ChartSeries[] = useMemo(() => [
    {id: 'left', label: `A · ${leftDefinition.label}`, color: '#39c8db', points: leftTimeline.map(item => ({year: item.year, value: item.population}))},
    {id: 'right', label: `B · ${rightDefinition.label}`, color: '#f4b24d', dash: '8 4', points: rightTimeline.map(item => ({year: item.year, value: item.population}))},
  ], [leftTimeline, rightTimeline, leftDefinition.label, rightDefinition.label]);
  async function exportComparison() {
    if (!left || !right) return;
    try {
      const rows = leftScenario === rightScenario ? snapshotRows(left, territoryName, cohort) : [...snapshotRows(left, territoryName, cohort), ...snapshotRows(right, territoryName, cohort)];
      const result = await downloadCanonicalCsv(rows, `${provider.manifest.datasetId}-compare-${leftScenario}-${rightScenario}-${year}`, {smallCellThreshold: 1});
      setExportStatus(result === 'cancelled' ? 'Сохранение отменено' : 'Экспорт CSV подготовлен');
    } catch(error) { setExportStatus(error instanceof Error ? error.message : 'Не удалось подготовить CSV'); }
  }
  return <section className="demo-scenarios da-workspace" aria-label="Сравнение подготовленных сценариев" data-testid="demo-scenarios">
    <header className="da-page-heading"><div><p className="da-eyebrow">Один город · общая исходная численность</p><h1>Сценарии и различия</h1><p>Сравнение подготовленных вымышленных траекторий, связанных с теми же профилями и картой.</p></div><span className="da-source-tag">Синтетические результаты</span></header>
    <ContextFilters provider={provider} context={context} onContextChange={onContextChange} showScenario={false} />
    {cohort ? <p className="da-chart-footnote">Группа в обоих сценариях: {cohortDescription(cohort)}. Возраст и занятость определяются заново на каждую дату; CSV и численности ограничены этой группой. <button type="button" onClick={() => onContextChange({cohort: null})}>Сбросить группу ×</button></p> : null}
    <div className="da-scenario-selectors"><label><span><i className="da-dot da-dot--a" />A · Сценарий сравнения</span><select aria-label="Сценарий A" value={leftScenario} onChange={event => onContextChange({comparisonScenario: event.target.value as DemoScenarioId})}>{provider.scenarios.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select><small>{leftDefinition.description}</small></label>
      <span className="da-versus" aria-hidden="true">↔</span><label><span><i className="da-dot da-dot--b" />B · Активный сценарий</span><select aria-label="Сценарий B" value={rightScenario} onChange={event => onContextChange({scenario: event.target.value as DemoScenarioId})}>{provider.scenarios.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select><small>{rightDefinition.description}</small></label>
    </div>
    {leftScenario === rightScenario ? <p className="da-chart-footnote">A и B совпадают. Выберите другой сценарий B, чтобы сравнить подготовленные траектории; нулевая разница сейчас ожидаема.</p> : null}
    {!left || !right ? <p role="status" className="da-empty">Подготовленное сравнение для этого среза отсутствует.</p> : <>
      <div className="da-comparison-headline"><div><span>Различие B − A на 1 января {year}</span><strong data-testid="scenario-population-delta">{signed(right.population - left.population)} <small>человек</small></strong><p>{left.population === 0 ? 'Относительное изменение не определено при нулевой базе.' : `${right.population > left.population ? '+' : ''}${formatNullableNumber((right.population - left.population) / left.population * 100, 1)}% к варианту A`} · {territoryName}</p></div>
        <div className="da-comparison-actions"><span>Вариант B выбран в демо</span><button type="button" onClick={() => void exportComparison()}>↓ CSV сравнения</button><span role="status">{exportStatus}</span></div>
      </div>
      <div className="da-comparison-grid"><section className="da-chart-section"><header><div><h2>Численность по годам</h2><p>Одинаковые дата и территория для обоих сценариев.</p></div></header><SeriesChart series={series} title="Сравнение численности в сценариях A и B" selectedYear={year} onSelectYear={value => onContextChange({year: value})} /><ChartLegend series={series} /></section>
        <section className="da-comparison-table"><h2>Разница в выбранном срезе</h2><div className="da-table-scroll"><table className="da-table"><thead><tr><th scope="col">Показатель</th><th scope="col">A</th><th scope="col">B</th><th scope="col">B − A</th></tr></thead><tbody>{[
          ['Население', left.population, right.population], ['Занятые', left.employment.employed, right.employment.employed], ['Возраст 70+', olderPopulation(left), olderPopulation(right)], [cohort ? 'Домохозяйства с жителями группы' : 'Домохозяйства', left.households, right.households],
          [`Рождения, ${year - 1}`, left.births, right.births], [`Смерти, ${year - 1}`, left.deaths, right.deaths],
        ].map(([label, a, b]) => <tr key={String(label)}><th scope="row">{label}</th><td className="da-number">{fmt(a as number | null)}</td><td className="da-number">{fmt(b as number | null)}</td><td className="da-number">{a === null || b === null ? '—' : signed(Number(b) - Number(a))}</td></tr>)}</tbody></table></div><p className="da-table-note">{cohort ? 'Прочерк: групповые события или число уникальных домохозяйств недоступны. Представленные значения подсчитаны по вымышленным жителям группы.' : 'Прочерк означает отсутствие предшествующего периода. Все показатели взяты из выбранных подготовленных срезов.'}</p></section>
      </div>
      <div className="da-chart-grid da-comparison-pyramids">{([{key: 'left', snapshot: left, label: `A · ${leftDefinition.label}`}, {key: 'right', snapshot: right, label: `B · ${rightDefinition.label}`}]).map(item => <section className="da-chart-section" key={item.key}><header><div><h2>{item.label}</h2><p>Возрастно-половая структура · {year}</p></div></header><AgeSexPyramid data={item.snapshot.ageSex} sexFilter={cohort?.sex} title={`${item.label}: возрастно-половая структура`} maxValue={Math.max(...[...left.ageSex, ...right.ageSex].flatMap(row => [row.male, row.female]))} /></section>)}</div>
      <p className="da-chart-footnote">У обеих пирамид одинаковая шкала. Начальный срез {provider.manifest.startYear} общий; различия последующих лет определены сохранёнными событиями вымышленных жителей.</p>
    </>}
    <LocalDraft />
    <p className="da-scientific-note">Эта демонстрация показывает инструменты исследования сценариев. Подготовленные числа не являются прогнозом населения Челябинска и не подтверждают точность научной модели.</p>
  </section>;
}
