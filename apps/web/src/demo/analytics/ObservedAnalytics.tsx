import {useEffect, useId, useMemo, useRef, useState} from 'react';
import type {ObservedCityReferenceV1, ObservedCitySnapshot} from '../data/observed';
import {getObservedSnapshot} from '../data/observed';
import {SeriesChart} from './charts';
import './analytics.css';
import './observed.css';

const numbers = new Intl.NumberFormat('ru-RU');
export const observedNumber = (value: number) => numbers.format(value);
export const observedDate = (asOf: string) => asOf.split('-').reverse().join('.');
const isOpenAge = (ageBand: string) => /\+\s*$/.test(ageBand);
export const observedHistory = (reference: ObservedCityReferenceV1) => [...(reference.history?.length ? reference.history : reference.snapshots)].sort((a, b) => a.year - b.year);

/** Recompute geometry at actual CSS width, retaining readable SVG labels on mobile. */
export function useObservedWidth(initial = 360) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(initial);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(entries => {
      const next = Math.max(260, Math.round(entries[0]?.contentRect.width ?? initial));
      setWidth(old => old === next ? old : next);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [initial]);
  return {ref, width};
}

export function ObservedPyramid({snapshot, compact = false}: {snapshot: ObservedCitySnapshot; compact?: boolean}) {
  const {ref, width} = useObservedWidth(compact ? 300 : 360);
  const title = useId();
  const bands = snapshot.ageSex.filter(row => !isOpenAge(row.ageBand)).sort((a, b) => parseInt(b.ageBand) - parseInt(a.ageBand));
  const open = snapshot.ageSex.filter(row => isOpenAge(row.ageBand));
  const rowHeight = compact ? 6 : 21;
  const top = 24; const height = Math.max(72, bands.length * rowHeight + 53);
  const center = width / 2; const side = Math.max(50, center - 50);
  const maximum = Math.max(1, ...bands.flatMap(row => [row.male, row.female]));
  return <div ref={ref} className={`observed-pyramid ${compact ? 'is-compact' : ''}`} data-testid="observed-age-chart">
    {bands.length ? <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby={title}>
      <title id={title}>Возрастно-половая структура на {observedDate(snapshot.asOf)}</title>
      <desc>Официальные численности. Мужчины слева, женщины справа. Только закрытые пятилетние группы; открытая возрастная группа приведена отдельно. Каждая полоса — число людей, не доля и не число персонажей.</desc>
      <text x={center - 43} y={12} textAnchor="end">Мужчины</text><text x={center + 43} y={12}>Женщины</text>
      {[0, .5, 1].map(fraction => <g key={fraction} aria-hidden="true">{[-1, 1].map(direction => <g key={direction}>
        <line x1={center + direction * (26 + fraction * side)} x2={center + direction * (26 + fraction * side)} y1={top - 3} y2={height - 27} className="observed-grid" />
        {(!compact || fraction !== .5) ? <text x={center + direction * (26 + fraction * side)} y={height - 10} textAnchor="middle" className="observed-axis">{fraction === 0 ? '0' : `${Math.round(maximum * fraction / 1000)} тыс.`}</text> : null}
      </g>)}</g>)}
      {bands.map((row, index) => <g key={row.ageBand} data-age-band={row.ageBand}>
        {(!compact || index % 4 === 0 || index === bands.length - 1) ? <text x={center} y={top + index * rowHeight + rowHeight / 2 + 3.5} textAnchor="middle" className="observed-age-label">{row.ageBand.replace('-', '–')}</text> : null}
        {(['male', 'female'] as const).map(sex => {
          const barWidth = row[sex] / maximum * side;
          return <rect key={sex} x={sex === 'male' ? center - 26 - barWidth : center + 26} y={top + index * rowHeight}
            width={barWidth} height={Math.max(2, rowHeight - (compact ? 1.5 : 4))} fill={sex === 'male' ? '#39c8db' : '#aa96ce'}>
            <title>{row.ageBand} · {sex === 'male' ? 'мужчины' : 'женщины'}: {observedNumber(row[sex])} человек</title>
          </rect>;
        })}
      </g>)}
    </svg> : <p className="observed-caption">Возрастная детализация для этого среза не опубликована в наборе.</p>}
    {open.map(row => <div className="observed-open-age" data-testid="observed-open-age" key={row.ageBand}>
      <strong>{row.ageBand}</strong><span>М {observedNumber(row.male)}</span><span>Ж {observedNumber(row.female)}</span><small>Открытая группа, отдельно от пятилетних полос</small>
    </div>)}
  </div>;
}

function snapshotSources(reference: ObservedCityReferenceV1, snapshot: {sourceId?: string}) {
  return snapshot.sourceId ? reference.sources.filter(source => source.id === snapshot.sourceId) : reference.sources;
}

/** History totals plus the selected exact age partition, never demo-person rows. */
export function buildObservedCsv(reference: ObservedCityReferenceV1, year: number) {
  const selected = getObservedSnapshot(reference, year);
  if (!selected) throw new Error('No official snapshot for selected year');
  const header = ['dataset_id', 'representation', 'oktmo', 'territory', 'as_of', 'year', 'age_band', 'sex', 'population', 'source_ids', 'source_urls', 'series_break'];
  const escape = (value: string | number) => `"${String(value).replaceAll('"', '""')}"`;
  const row = (snapshot: {year: number; asOf: string; sourceId?: string}, age: string, sex: string, population: number) => [
    reference.datasetId, reference.representation, reference.territory.oktmo, reference.territory.name, snapshot.asOf, snapshot.year,
    age, sex, population, snapshotSources(reference, snapshot).map(source => source.id).join('; '), snapshotSources(reference, snapshot).map(source => source.url).join('; '),
    reference.seriesBreaks.filter(item => item.year === snapshot.year).map(item => item.label).join('; '),
  ];
  const rows = observedHistory(reference).flatMap(point => {
    const snapshot = getObservedSnapshot(reference, point.year);
    return [row(point, 'all', 'total', point.population), ...(snapshot ? [row(snapshot, 'all', 'male', snapshot.male), row(snapshot, 'all', 'female', snapshot.female)] : [])];
  });
  rows.push(...selected.ageSex.flatMap(age => [row(selected, age.ageBand, 'male', age.male), row(selected, age.ageBand, 'female', age.female)]));
  return '\uFEFF' + [header, ...rows].map(cells => cells.map(escape).join(',')).join('\n') + '\n';
}

export interface ObservedAnalyticsProps {
  reference: ObservedCityReferenceV1;
  year: number;
  onYearChange: (year: number) => void;
  onFictional: () => void;
}

export function ObservedAnalytics({reference, year, onYearChange, onFictional}: ObservedAnalyticsProps) {
  const snapshot = getObservedSnapshot(reference, year);
  const ordered = useMemo(() => [...reference.snapshots].sort((a, b) => a.year - b.year), [reference]);
  const historyRows = useMemo(() => observedHistory(reference), [reference]);
  const series = useMemo(() => [{id: 'observed-population', label: 'Постоянное население', color: '#39c8db', points: historyRows.map(item => ({year: item.year, value: item.population}))}], [historyRows]);
  const breaks = reference.seriesBreaks.map(item => item.year);
  const history = useObservedWidth();
  const [exportStatus, setExportStatus] = useState('');
  function exportCsv() {
    try {
      const href = URL.createObjectURL(new Blob([buildObservedCsv(reference, year)], {type: 'text/csv;charset=utf-8'}));
      const link = document.createElement('a'); link.href = href; link.download = `chelyabinsk-official-${year}.csv`; link.hidden = true;
      document.body.append(link); link.click();
      window.setTimeout(() => {link.remove(); URL.revokeObjectURL(href);}, 60_000);
      setExportStatus('CSV официальных агрегатов подготовлен');
    } catch (error) {setExportStatus(error instanceof Error ? error.message : 'Не удалось подготовить CSV');}
  }
  return <section className="da-workspace observed-analytics" data-testid="observed-analytics" aria-label="Официальная статистика Челябинска">
    <header className="da-page-heading"><div><p className="da-eyebrow">Город · опубликованные данные</p><h1>Население Челябинска</h1><p>{reference.territory.name} · ОКТМО {reference.territory.oktmo}. Исторические наблюдения, не прогноз.</p></div><span className="observed-badge">Официальная статистика</span></header>
    <div className="observed-toolbar"><label><span>Срез на 1 января</span><select aria-label="Год официальной статистики" value={year} onChange={event => onYearChange(Number(event.target.value))}>{!snapshot ? <option value={year}>{year} — нет данных</option> : null}{ordered.map(item => <option key={item.year} value={item.year}>{item.year}</option>)}</select></label><button type="button" onClick={onFictional}>Модельные персонажи</button></div>
    {!snapshot ? <p className="da-empty" role="status">Нет официального среза за {year} год. Выберите опубликованный год; текущая дата и модельный год не заменяют дату наблюдения.</p> : <>
      <dl className="observed-totals"><div><dt>Постоянное население · {observedDate(snapshot.asOf)}</dt><dd data-testid="observed-population">{observedNumber(snapshot.population)}<small>человек</small></dd></div><div><dt>Мужчины</dt><dd>{observedNumber(snapshot.male)}</dd></div><div><dt>Женщины</dt><dd>{observedNumber(snapshot.female)}</dd></div></dl>
      <div className="observed-chart-grid"><section><h2>История численности</h2><p className="observed-caption">Численность на 1 января каждого года</p><div ref={history.ref}><SeriesChart series={series} width={history.width} title="Опубликованная численность населения Челябинска" selectedYear={year} breakYears={breaks} provenanceText="Опубликованные официальные агрегаты. Это не синтетические персонажи и не прогноз. Разрывы линии обозначают пересмотр статистического ряда." /></div>
        {reference.seriesBreaks.map(item => <p className="observed-revision" key={item.year}><span>{item.year}</span>{item.label}. Линия не соединяет несопоставимые участки.</p>)}
      </section><section><h2>Возрастно-половая структура</h2><p className="observed-caption">{observedDate(snapshot.asOf)} · численность, человек</p><ObservedPyramid snapshot={snapshot} /><p className="observed-caption">Официальные агрегаты не связываются с конкретными вымышленными персонажами.</p></section></div>
      <section className="observed-data"><div className="observed-data-heading"><div><h2>Точные значения и выгрузка</h2><p className="observed-caption">CSV: весь исторический ряд и возрастные группы выбранного среза; дата, ОКТМО и ссылки на источники в каждой строке.</p></div><button type="button" data-testid="observed-export" onClick={exportCsv}>Скачать CSV</button></div><p className="observed-export-status" role="status">{exportStatus}</p>
        <div className="observed-table-pair"><div className="observed-table-scroll" tabIndex={0} role="region" aria-label="Исторический ряд, таблица"><table data-testid="observed-history-table"><caption>Постоянное население на дату. Прочерк: половой состав не опубликован в этом наборе.</caption><thead><tr><th>Дата</th><th>Всего</th><th>Мужчины</th><th>Женщины</th></tr></thead><tbody>{historyRows.map(item => {const detail = getObservedSnapshot(reference, item.year); return <tr key={item.year} className={item.year === year ? 'is-selected' : ''}><th scope="row">{observedDate(item.asOf)}{breaks.includes(item.year) ? ' *' : ''}</th><td>{observedNumber(item.population)}</td><td>{detail ? observedNumber(detail.male) : '—'}</td><td>{detail ? observedNumber(detail.female) : '—'}</td></tr>;})}</tbody></table></div>
        <div className="observed-table-scroll" tabIndex={0} role="region" aria-label="Возраст и пол, таблица"><table data-testid="observed-age-table"><caption>Возраст и пол · {observedDate(snapshot.asOf)}</caption><thead><tr><th>Возраст</th><th>Мужчины</th><th>Женщины</th><th>Всего</th></tr></thead><tbody>{snapshot.ageSex.map(item => <tr key={item.ageBand}><th scope="row">{item.ageBand}</th><td>{observedNumber(item.male)}</td><td>{observedNumber(item.female)}</td><td>{observedNumber(item.male + item.female)}</td></tr>)}</tbody></table></div></div>
      </section>
    </>}
    <section className="observed-sources"><h2>Источники и границы интерпретации</h2><ul>{reference.sources.map(source => <li key={source.id}><a href={source.url} target="_blank" rel="noreferrer">{source.title} ↗</a>{source.publishedAt ? <span> · опубликовано {source.publishedAt}</span> : null}</li>)}</ul>{reference.notes.map(note => <p key={note}>{note}</p>)}<p>Модельные персонажи и подготовленные демосценарии — отдельный вымышленный набор. Численность персонажей не является численностью города.</p></section>
  </section>;
}
