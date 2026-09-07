import { useId } from 'react';
import type { DemoAgeBand, DemoCohort } from '../types';

/** SVG layout and mirrored age/sex encoding carried forward from AnalyticsView. */
export interface PyramidDatum { ageBand: DemoAgeBand; male: number | null; female: number | null }
export interface ChartPoint { year: number; value: number | null }
export interface ChartSeries { id: string; label: string; color: string; points: readonly ChartPoint[]; dash?: string }
export type CohortSelection = Pick<DemoCohort, 'ageBand' | 'sex'>;

const formatter = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const numberLabel = (value: number) => formatter.format(value);
const ageStart = (band: string) => Number(band.match(/\d+/u)?.[0] ?? 0);

function activate(event: React.KeyboardEvent<SVGElement>, action: () => void) {
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); action(); }
}

export function AgeSexPyramid({ data, title = 'Возрастно-половая структура', maxValue, cohort, sexFilter, onSelectCohort }: {
  data: readonly PyramidDatum[];
  title?: string;
  maxValue?: number;
  cohort?: CohortSelection | null;
  sexFilter?: DemoCohort['sex'];
  onSelectCohort?: (selection: CohortSelection) => void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  if (!data.length) return <p className="da-empty">Возрастно-половой срез отсутствует.</p>;
  const width = 680;
  const height = Math.max(304, data.length * 23 + 82);
  const center = width / 2;
  const top = 34;
  const rowHeight = (height - 88) / data.length;
  const halfWidth = center - 75;
  const sorted = [...data].sort((a, b) => ageStart(b.ageBand) - ageStart(a.ageBand));
  const maximum = Math.max(1, maxValue ?? 0, ...data.flatMap(row => [row.male ?? 0, row.female ?? 0]));
  return <svg className="da-pyramid" viewBox={`0 0 ${width} ${height}`} role={onSelectCohort ? 'group' : 'img'} aria-labelledby={`${titleId} ${descriptionId}`}>
    <title id={titleId}>{title}</title>
    <desc id={descriptionId}>Мужчины слева, женщины справа. Шкала от 0 до {numberLabel(maximum)} человек с каждой стороны.{onSelectCohort ? ' Выберите полосу мышью или клавишей Enter, чтобы открыть персонажей группы.' : ''}</desc>
    <text x={center - 160} y={18} textAnchor="middle" className="da-svg-label">Мужчины</text>
    <text x={center + 160} y={18} textAnchor="middle" className="da-svg-label">Женщины</text>
    {[0, .5, 1].map(fraction => <g key={fraction} aria-hidden="true">
      {[-1, 1].map(side => <g key={side}>
        <line x1={center + side * (30 + fraction * halfWidth)} x2={center + side * (30 + fraction * halfWidth)} y1={top} y2={height - 47} className="da-gridline" />
        <text x={center + side * (30 + fraction * halfWidth)} y={height - 26} textAnchor="middle" className="da-svg-tick">{numberLabel(Math.round(maximum * fraction))}</text>
      </g>)}
    </g>)}
    {sorted.map((row, index) => <g key={row.ageBand}>
      <text x={center} y={top + (index + .5) * rowHeight + 5} textAnchor="middle" className="da-svg-tick">{row.ageBand}</text>
      {(['male', 'female'] as const).filter(sex => !sexFilter || sex === sexFilter).map(sex => {
        const value = row[sex];
        const barWidth = ((value ?? 0) / maximum) * halfWidth;
        const barHeight = Math.max(4, Math.min(36, rowHeight - 4));
        const selected = Boolean(cohort && (!cohort.ageBand || cohort.ageBand === row.ageBand) && (!cohort.sex || cohort.sex === sex));
        const label = `${sex === 'male' ? 'Мужчины' : 'Женщины'}, ${row.ageBand}: ${value === null ? 'нет данных' : numberLabel(value)} человек`;
        return <rect key={sex} x={sex === 'male' ? center - 30 - barWidth : center + 30} y={top + index * rowHeight + (rowHeight - barHeight) / 2}
          width={Math.max(value === null ? 0 : 1, barWidth)} height={barHeight} rx={2}
          fill={sex === 'male' ? '#39c8db' : '#9986ee'} opacity={cohort && !selected ? .42 : .92}
          stroke={selected ? '#f4e7a2' : 'none'} strokeWidth={2}
          className={onSelectCohort ? 'da-bar da-bar--interactive' : 'da-bar'}
          role={onSelectCohort ? 'button' : undefined} tabIndex={onSelectCohort ? 0 : undefined} aria-label={label}
          onClick={onSelectCohort ? () => onSelectCohort({ ageBand: row.ageBand, sex }) : undefined}
          onKeyDown={onSelectCohort ? event => activate(event, () => onSelectCohort({ ageBand: row.ageBand, sex })) : undefined}>
          <title>{label}</title>
        </rect>;
      })}
    </g>)}
    <text x={center} y={height - 4} textAnchor="middle" className="da-svg-caption">Численность, человек</text>
  </svg>;
}

/** Preserve missing-value gaps; an absent year is never a zero or interpolated result. */
export function linePath(points: readonly ChartPoint[], x: (year: number) => number, y: (value: number) => number): string {
  let connected = false;
  return points.map(point => {
    if (point.value === null) { connected = false; return ''; }
    const segment = `${connected ? 'L' : 'M'}${x(point.year).toFixed(2)},${y(point.value).toFixed(2)}`;
    connected = true;
    return segment;
  }).filter(Boolean).join(' ');
}

export function SeriesChart({ series, title, selectedYear, onSelectYear, includeZero = false, unit = 'человек' }: {
  series: readonly ChartSeries[];
  title: string;
  selectedYear?: number;
  onSelectYear?: (year: number) => void;
  includeZero?: boolean;
  unit?: string;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const points = series.flatMap(item => item.points).filter((point): point is { year: number; value: number } => point.value !== null);
  if (!points.length) return <p className="da-empty">Для выбранного периода нет значений.</p>;
  const width = 740; const height = 292;
  const years = [...new Set(points.map(point => point.year))].sort((a, b) => a - b);
  const rawMin = Math.min(...points.map(point => point.value), ...(includeZero ? [0] : []));
  const rawMax = Math.max(...points.map(point => point.value), ...(includeZero ? [0] : []));
  const padding = Math.max(1, (rawMax - rawMin) * .13);
  const minimum = rawMin - padding; const maximum = rawMax + padding;
  const x = (year: number) => 62 + (year - years[0]!) / Math.max(1, years.at(-1)! - years[0]!) * (width - 90);
  const y = (value: number) => 25 + (1 - (value - minimum) / (maximum - minimum)) * (height - 74);
  return <svg className="da-series" viewBox={`0 0 ${width} ${height}`} role={onSelectYear ? 'group' : 'img'} aria-labelledby={`${titleId} ${descriptionId}`}>
    <title id={titleId}>{title}</title>
    <desc id={descriptionId}>{series.map(item => `${item.label}: ${item.points.map(point => `${point.year} — ${point.value === null ? 'нет данных' : numberLabel(point.value)}`).join('; ')}`).join('. ')}. Единица: {unit}. Все значения синтетические.</desc>
    {[0, .25, .5, .75, 1].map(fraction => {
      const value = minimum + (maximum - minimum) * fraction;
      return <g key={fraction} aria-hidden="true"><line x1={62} x2={width - 28} y1={y(value)} y2={y(value)} className="da-gridline" /><text x={53} y={y(value) + 4} textAnchor="end" className="da-svg-tick">{numberLabel(Math.round(value))}</text></g>;
    })}
    {minimum <= 0 && maximum >= 0 ? <line x1={62} x2={width - 28} y1={y(0)} y2={y(0)} className="da-zero-line" /> : null}
    <text x={62} y={13} className="da-svg-caption">{unit}</text>
    {years.filter((_, index) => index % Math.max(1, Math.ceil(years.length / 6)) === 0 || index === years.length - 1).map(year => <text key={year} x={x(year)} y={height - 18} textAnchor="middle" className="da-svg-tick">{year}</text>)}
    {selectedYear !== undefined && selectedYear >= years[0]! && selectedYear <= years.at(-1)! ? <line x1={x(selectedYear)} x2={x(selectedYear)} y1={24} y2={height - 49} className="da-year-line" /> : null}
    {series.map(item => <g key={item.id}>
      <path d={linePath(item.points, x, y)} fill="none" stroke={item.color} strokeWidth={2.6} strokeDasharray={item.dash} vectorEffect="non-scaling-stroke" />
      {item.points.filter((point): point is {year: number; value: number} => point.value !== null).map(point => {
        const label = `${item.label}, ${point.year}: ${numberLabel(point.value)} ${unit}`;
        return <circle key={point.year} cx={x(point.year)} cy={y(point.value)} r={point.year === selectedYear ? 5 : 3.3} fill={item.color}
          className={onSelectYear ? 'da-point da-point--interactive' : 'da-point'}
          role={onSelectYear ? 'button' : undefined} tabIndex={onSelectYear ? 0 : undefined} aria-label={label}
          onClick={onSelectYear ? () => onSelectYear(point.year) : undefined}
          onKeyDown={onSelectYear ? event => activate(event, () => onSelectYear(point.year)) : undefined}><title>{label}</title></circle>;
      })}
    </g>)}
  </svg>;
}

export function ChartLegend({ series }: { series: readonly Pick<ChartSeries, 'id' | 'label' | 'color' | 'dash'>[] }) {
  return <ul className="da-chart-legend" aria-label="Обозначения графика">{series.map(item => <li key={item.id}><svg viewBox="0 0 28 10" aria-hidden="true"><line x1={1} x2={27} y1={5} y2={5} stroke={item.color} strokeWidth={2.4} strokeDasharray={item.dash} /><circle cx={14} cy={5} r={2.5} fill={item.color} /></svg>{item.label}</li>)}</ul>;
}
