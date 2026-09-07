import {useId} from 'react';
import {getObservedSnapshot, type ObservedCityReferenceV1} from '../data/observed';
import {linePath} from './charts';
import {ObservedPyramid, observedDate, observedHistory, observedNumber, useObservedWidth} from './ObservedAnalytics';
import './observed.css';

export interface ObservedSummaryProps {
  reference: ObservedCityReferenceV1;
  year: number;
  onAnalytics: () => void;
  onScenarios: () => void;
  characterCount: number;
}
export function ObservedSummary({reference, year, onAnalytics, onScenarios, characterCount}: ObservedSummaryProps) {
  const snapshot = getObservedSnapshot(reference, year);
  const titleId = useId(); const {ref, width} = useObservedWidth(300);
  const history = observedHistory(reference);
  const points = history.map(item => ({year: item.year, value: item.population}));
  const min = Math.min(...points.map(item => item.value)); const max = Math.max(...points.map(item => item.value));
  const x = (value: number) => 8 + (value - history[0]!.year) / Math.max(1, history.at(-1)!.year - history[0]!.year) * (width - 16);
  const y = (value: number) => 10 + (max - value) / Math.max(1, max - min) * 49;
  const previous = history.find(item => item.year === year - 1);
  const revision = reference.seriesBreaks.find(item => item.year === year);
  const delta = snapshot && previous && !revision ? snapshot.population - previous.population : null;
  const source = reference.sources.find(item => item.id === snapshot?.sourceId) ?? reference.sources[0];
  if (!snapshot) return <section className="observed-summary"><p role="status">Нет официального среза за {year} год.</p><button onClick={onAnalytics}>Открыть аналитику</button></section>;
  return <section className="observed-summary" data-testid="observed-summary">
    <header><span className="observed-badge">Официальная статистика</span><h2>Население города</h2><p>{reference.territory.name}</p></header>
    <div className="observed-summary-count"><strong data-testid="observed-summary-population">{observedNumber(snapshot.population)}</strong><span>человек на {observedDate(snapshot.asOf)}</span></div>
    {delta !== null ? <p className="observed-summary-delta">{delta > 0 ? '+' : ''}{observedNumber(delta)} к {year - 1} году</p> : null}
    <div ref={ref} className="observed-mini-history"><div><h3>История численности</h3><span>{history[0]!.year}–{history.at(-1)!.year}</span></div><svg viewBox={`0 0 ${width} 80`} role="img" aria-labelledby={titleId}><title id={titleId}>Официальный исторический ряд численности; разрыв линии при пересмотре статистики</title><desc>{history.map(item => `${item.year}: ${observedNumber(item.population)}`).join('; ')}</desc><path d={linePath(points, x, y, reference.seriesBreaks.map(item => item.year))} fill="none" stroke="#39c8db" strokeWidth="2" vectorEffect="non-scaling-stroke" />{points.map(item => <circle key={item.year} cx={x(item.year)} cy={y(item.value)} r={item.year === year ? 3.5 : 1.5} fill="#39c8db" />)}<text x="8" y="77">{history[0]!.year}</text><text x={width - 8} y="77" textAnchor="end">{history.at(-1)!.year}</text></svg>{reference.seriesBreaks.map(item => <p key={item.year}>{item.year}: {item.label}</p>)}</div>
    <div className="observed-summary-pyramid"><h3>Возраст и пол · {year}</h3><ObservedPyramid snapshot={snapshot} compact /></div>
    <p className="observed-source-caption">Источник: {source ? <a href={source.url} target="_blank" rel="noreferrer">Росстат ↗</a> : 'не указан'} · ОКТМО {reference.territory.oktmo}</p>
    <div className="observed-summary-actions"><button onClick={onAnalytics}>Открыть аналитику</button><button onClick={onScenarios}>Демосценарии</button></div>
    <p className="observed-character-count">{observedNumber(characterCount)} вымышленных персонажей — отдельный демонабор, не население города.</p>
  </section>;
}
