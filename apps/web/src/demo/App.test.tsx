// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { DemoContextV1, DemoPage, DemoPeopleQuery, DemoScenarioId, PublicFictionalPersonV1 } from './types';
const api = vi.hoisted(() => ({load:vi.fn(),city:vi.fn()}));
vi.mock('./data/loadDemoProvider', () => ({loadDemoProvider:api.load}));
vi.mock('./DemoCity', () => ({DemoCity:(props:unknown) => {api.city(props);return <div>Test city</div>}}));
vi.mock('./analytics', () => ({DemoAnalytics:() => <div>Test analytics</div>, DemoScenarios:() => <div>Test scenarios</div>}));
vi.mock('./ResidentChat', () => ({ResidentChat:() => <div>Test chat</div>}));
vi.mock('./FictionalPortrait', () => ({FictionalPortrait:() => <div>Portrait</div>}));
import App from './App';

const person:PublicFictionalPersonV1 = {contract:'PublicFictionalPersonV1',id:'city-p-100001',name:'Житель города',age:38,ageBand:'35-54',sex:'female',employment:'employed',occupation:'Инженер',householdId:'city-h-1',householdSize:2,territoryId:'RU-CHE-SET',territoryName:'Челябинск',biography:'Вымышленный профиль',interests:[],scenario:'inflow',demographicYear:2032,datasetId:'city-v2',representation:'fictional_demo',spatialRepresentation:'visual_synthesis',isFictional:true};
const page = (items:PublicFictionalPersonV1[] = [person]):DemoPage<PublicFictionalPersonV1> => ({items,total:items.length,offset:0,limit:50,nextOffset:null});
function deferred<T>() { let resolve!:(value:T)=>void;let reject!:(error:Error)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no});return {promise,resolve,reject}; }
function fixture() {
  return {
    manifest:{datasetId:'city-v2',initialPopulation:1177058},
    territories:[{id:'RU-CHE-SET',name:'Челябинск',parentId:null}],
    scenarios:[{id:'baseline',label:'Базовый'},{id:'inflow',label:'Приток'}],
    getSnapshot:vi.fn(() => null), getPeople:vi.fn(() => page([])),
    queryPeople:vi.fn(async (_query:DemoPeopleQuery,_signal?:AbortSignal) => page()),
    preparePerson:vi.fn(async (_id:string,_scenario:DemoScenarioId,_year:number,_signal?:AbortSignal) => {}),
    prepareBuilding:vi.fn(async (_id:string,_minutes:number,_scenario:DemoScenarioId,_year:number,_signal?:AbortSignal) => {}),
    prepareVehicle:vi.fn(async (_id:string,_minutes:number,_scenario:DemoScenarioId,_year:number,_signal?:AbortSignal) => {}),
    getPerson:vi.fn(() => person), getPresence:vi.fn(() => null),
    getBuildingOccupancy:vi.fn(() => ({...page(),buildingId:'b-1',assignedResidents:17,assignedWorkers:4,presentNow:1})),
    getVehicle:vi.fn(() => ({id:'v-1',label:'Семейный автомобиль',occupants:[person],occupancy:1,capacity:4})),
  };
}
let provider:ReturnType<typeof fixture>;
beforeEach(() => {provider=fixture();api.city.mockClear();api.load.mockReset().mockResolvedValue(provider);history.replaceState(null,'','#/agents?dataset=city-v2&scenario=inflow&year=2032&stats=fictional&paused=1');});
afterEach(() => {cleanup();vi.restoreAllMocks();});

describe('asynchronous city shell', () => {
  it.each(['map', 'handle'] as const)('resets the scrolled profile when collapsing through %s', async action => {
    history.replaceState(null,'','#/world?dataset=city-v2&scenario=inflow&year=2032&stats=fictional&paused=1');
    render(<App/>);
    await waitFor(() => expect(api.city).toHaveBeenCalled());
    act(() => api.city.mock.lastCall?.[0].onSelect({kind:'person',id:person.id}));
    const showOnMap = await screen.findByRole('button', {name:'Показать на карте'});
    const panel = screen.getByTestId('selection-inspector').closest('aside')!;
    const camera = {...api.city.mock.lastCall?.[0].context.camera};
    expect(panel.classList.contains('expanded')).toBe(true);
    panel.scrollTop = 420;
    fireEvent.click(action === 'map' ? showOnMap : screen.getByRole('button', {name:'Развернуть или свернуть сводку'}));
    expect(panel.classList.contains('expanded')).toBe(false);
    expect(panel.scrollTop).toBe(0);
    expect(screen.getByRole('heading', {name:person.name})).toBeTruthy();
    expect(api.city.mock.lastCall?.[0].context.camera).toEqual(camera);
    expect(api.city.mock.lastCall?.[0].selectedId).toBe(person.id);
    expect(provider.preparePerson).toHaveBeenCalledOnce();
  });
  it.each([null, 2])('renders household size %s honestly in the list and profile', async householdSize => {
    const selected = {...person, householdSize};
    provider.queryPeople.mockResolvedValue(page([selected]));
    provider.getPerson.mockReturnValue(selected);
    history.replaceState(null,'',`#/agents?dataset=city-v2&scenario=inflow&year=2032&stats=fictional&paused=1&selected=person:${person.id}`);
    render(<App/>);
    await waitFor(() => expect(provider.getPerson).toHaveBeenCalled());
    const row = screen.getByRole('row', {name: new RegExp(person.name)});
    const expected = householdSize === null ? '—' : `${householdSize} чел.`;
    expect(within(row).getAllByRole('cell')[4].textContent).toBe(expected);
    expect(screen.getByText('Домохозяйство', {selector:'dt'}).nextElementSibling?.textContent).toBe(expected);
  });
  it('lets the loader choose the default and canonicalizes its version without a second load', async () => {
    history.replaceState(null,'','#/agents?paused=1');
    render(<App/>);
    await waitFor(() => expect(screen.getByText(person.name)).toBeTruthy());
    expect(api.load).toHaveBeenCalledOnce();
    expect(api.load.mock.calls[0]?.[1]).toBeUndefined();
    expect(location.hash).toContain('dataset=city-v2');
  });
  it('reloads an explicit dataset on history restore and ignores an aborted loader', async () => {
    const first=deferred<ReturnType<typeof fixture>>();api.load.mockReturnValueOnce(first.promise);
    render(<App/>);
    await waitFor(() => expect(api.load).toHaveBeenCalledOnce());
    const signal=api.load.mock.calls[0]?.[2] as AbortSignal;
    const next={...fixture(),manifest:{datasetId:'other-version',initialPopulation:8246}};
    api.load.mockResolvedValueOnce(next);
    act(()=>{history.pushState(null,'','#/agents?dataset=other-version&paused=1');dispatchEvent(new PopStateEvent('popstate'));});
    await waitFor(() => expect(next.queryPeople).toHaveBeenCalledOnce());
    expect(signal.aborted).toBe(true);
    await act(async()=>first.resolve(provider));
    expect(location.hash).toContain('dataset=other-version');
    expect(provider.queryPeople).not.toHaveBeenCalled();
  });
  it('recovers the previously loaded dataset after an unsupported version fails', async () => {
    render(<App/>);
    await waitFor(() => expect(screen.getByText(person.name)).toBeTruthy());
    api.load.mockRejectedValueOnce(new Error('Unknown dataset'));
    act(()=>{history.pushState(null,'','#/agents?dataset=unknown&paused=1');dispatchEvent(new PopStateEvent('popstate'));});
    await waitFor(() => expect(screen.getByText('Unknown dataset')).toBeTruthy());
    act(()=>{history.pushState(null,'','#/agents?dataset=city-v2&paused=1');dispatchEvent(new PopStateEvent('popstate'));});
    await waitFor(() => expect(screen.getByText(person.name)).toBeTruthy());
    expect(api.load).toHaveBeenCalledTimes(2);
  });
  it('labels the city index as ID-only and exposes unsupported-search errors', async () => {
    provider.manifest.datasetId='omnitwin-fictional-city-v2';
    history.replaceState(null,'','#/agents?dataset=omnitwin-fictional-city-v2&paused=1');
    render(<App/>);
    await waitFor(() => expect(screen.getByLabelText('ID жителя')).toBeTruthy());
    expect(screen.getByText('Поиск по ID; имя и занятие — в карточке')).toBeTruthy();
    provider.queryPeople.mockRejectedValueOnce(new Error('Для городского набора используйте полный ID жителя.'));
    fireEvent.change(screen.getByLabelText('ID жителя'),{target:{value:'Мария'}});
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('полный ID'));
    expect(screen.queryByText('В выбранном срезе жители не найдены.')).toBeNull();
  });
  it('does not let callbacks from the previous map overwrite a restored camera URL', async () => {
    history.replaceState(null,'','#/world?dataset=city-v2&paused=1&zoom=17.6&lon=61.41&lat=55.17');
    render(<App/>);
    await waitFor(() => expect(api.city).toHaveBeenCalled());
    const previous=api.city.mock.lastCall?.[0] as {context:DemoContextV1;onCameraChange:(camera:DemoContextV1['camera'])=>void};
    act(()=>{history.pushState(null,'','#/world?dataset=city-v2&paused=1&zoom=16.7&lon=61.405&lat=55.16');dispatchEvent(new PopStateEvent('popstate'));});
    await waitFor(() => expect(api.city.mock.lastCall?.[0].context.camera.zoom).toBe(16.7));
    act(()=>previous.onCameraChange(previous.context.camera));
    expect(new URLSearchParams(location.hash.split('?')[1]).get('zoom')).toBe('16.7');
  });
  it('waits for real query totals and aborts stale searches', async () => {
    const first=deferred<DemoPage<PublicFictionalPersonV1>>();provider.queryPeople.mockReturnValueOnce(first.promise);
    render(<App/>);
    await waitFor(() => expect(provider.queryPeople).toHaveBeenCalledOnce());
    expect(screen.getByRole('status').textContent).toContain('Загружаем жителей');
    expect(screen.queryByText(/0 вымышленных жителей/)).toBeNull();
    expect(provider.queryPeople.mock.calls[0]?.[0]).toMatchObject({scenario:'inflow',year:2032,limit:50});
    const signal=provider.queryPeople.mock.calls[0]?.[1] as AbortSignal;
    fireEvent.change(screen.getByLabelText('Поиск жителя'),{target:{value:'Инженер'}});
    await waitFor(() => expect(screen.getByText(person.name)).toBeTruthy());
    expect(signal.aborted).toBe(true);
    await act(async () => first.resolve(page([{...person,id:'stale',name:'Устаревший ответ'}])));
    expect(screen.queryByText('Устаревший ответ')).toBeNull();
    expect(provider.getPeople).not.toHaveBeenCalled();
  });
  it.each(['person','building','vehicle'] as const)('prepares a selected %s before reading synchronous details', async kind => {
    const ready=deferred<void>();
    const prepare=kind==='person'?provider.preparePerson:kind==='building'?provider.prepareBuilding:provider.prepareVehicle;
    const getter=kind==='person'?provider.getPerson:kind==='building'?provider.getBuildingOccupancy:provider.getVehicle;
    prepare.mockReturnValueOnce(ready.promise);
    history.replaceState(null,'',`#/agents?dataset=city-v2&scenario=inflow&year=2032&stats=fictional&paused=1&selected=${kind}:${kind==='person'?person.id:kind==='building'?'b-1':'v-1'}`);
    render(<App/>);
    await waitFor(() => expect(prepare).toHaveBeenCalledOnce());
    expect(getter).not.toHaveBeenCalled();
    expect(screen.getByTestId('selection-inspector').textContent).toContain('Загружаем');
    const args=prepare.mock.calls[0] as unknown[];
    expect(args.slice(kind==='person'?1:2,kind==='person'?3:4)).toEqual(['inflow',2032]);
    await act(async () => ready.resolve());
    await waitFor(() => expect(getter).toHaveBeenCalled());
    expect(screen.getByTestId('selection-inspector').textContent).not.toContain('Загружаем');
  });
  it('aborts the previous demographic preparation and never shows its stale profile', async () => {
    const first=deferred<void>();const next=deferred<void>();
    provider.preparePerson.mockReturnValueOnce(first.promise).mockReturnValueOnce(next.promise);
    history.replaceState(null,'',`#/agents?dataset=city-v2&scenario=inflow&year=2032&stats=fictional&paused=1&selected=person:${person.id}`);
    render(<App/>);
    await waitFor(() => expect(provider.preparePerson).toHaveBeenCalledOnce());
    const signal=provider.preparePerson.mock.calls[0]?.[3] as AbortSignal;
    act(()=>{history.pushState(null,'',`#/agents?dataset=city-v2&scenario=baseline&year=2034&stats=fictional&paused=1&selected=person:${person.id}`);dispatchEvent(new PopStateEvent('popstate'));});
    await waitFor(() => expect(provider.preparePerson).toHaveBeenCalledTimes(2));
    expect(provider.preparePerson.mock.calls[1]?.slice(1,3)).toEqual(['baseline',2034]);
    expect(signal.aborted).toBe(true);
    await act(async()=>first.resolve());
    expect(provider.getPerson).not.toHaveBeenCalled();
    await act(async()=>next.resolve());
    await waitFor(() => expect(provider.getPerson).toHaveBeenCalledWith(person.id,'baseline',2034));
  });
  it('uses manifest population in About rather than the legacy fixture count', async () => {
    history.replaceState(null,'','#/about?dataset=city-v2&paused=1');
    render(<App/>);
    await waitFor(() => expect(screen.getByText(/Все интерактивные жители вымышлены/)).toBeTruthy());
    const disclosure=screen.getByText(/Все интерактивные жители вымышлены/).textContent?.replace(/\s/g,'');
    expect(disclosure).toContain('1177058');
    expect(disclosure).not.toContain('8246');
  });
  it('shows a preparation error instead of an empty building count and cancels on close', async () => {
    const ready=deferred<void>();provider.prepareBuilding.mockReturnValueOnce(ready.promise);
    history.replaceState(null,'','#/agents?dataset=city-v2&paused=1&selected=building:b-1');
    render(<App/>);
    await waitFor(() => expect(provider.prepareBuilding).toHaveBeenCalledOnce());
    const signal=provider.prepareBuilding.mock.calls[0]?.[4] as AbortSignal;
    await act(async () => ready.reject(new Error('Shard unavailable')));
    expect(screen.getByRole('alert').textContent).toContain('Shard unavailable');
    expect(provider.getBuildingOccupancy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText('Закрыть профиль'));
    expect(signal.aborted).toBe(true);
  });
});
