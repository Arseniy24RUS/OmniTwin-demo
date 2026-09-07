import type { StaticDemoProvider } from '../data/StaticDemoProvider';
import type { DemoContextV1, DemoScenarioId } from '../types';

export interface DemoAnalyticsProps {
  provider: StaticDemoProvider;
  context: DemoContextV1;
  onContextChange: (patch: Partial<DemoContextV1>) => void;
}

export function ContextFilters({ provider, context, onContextChange, showScenario = true }: DemoAnalyticsProps & {showScenario?: boolean}) {
  return <div className="da-context-filters" aria-label="Общий аналитический срез">
    <label><span>Территория</span><select aria-label="Территория аналитики" value={context.territoryId} onChange={event => onContextChange({territoryId: event.target.value})}>
      {provider.territories.map(territory => <option key={territory.id} value={territory.id}>{territory.name}</option>)}
    </select></label>
    {showScenario ? <label><span>Подготовленный сценарий</span><select aria-label="Сценарий аналитики" value={context.scenario} onChange={event => onContextChange({scenario: event.target.value as DemoScenarioId})}>
      {provider.scenarios.map(scenario => <option key={scenario.id} value={scenario.id}>{scenario.label}</option>)}
    </select></label> : null}
    <label><span>Срез на 1 января</span><select aria-label="Демографический год" value={context.year} onChange={event => onContextChange({year: Number(event.target.value)})}>
      {Array.from({length: provider.manifest.endYear - provider.manifest.startYear + 1}, (_, index) => provider.manifest.startYear + index).map(year => <option key={year} value={year}>{year}</option>)}
    </select></label>
  </div>;
}
