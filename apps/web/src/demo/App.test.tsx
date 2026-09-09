// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { DemoBuildingOccupancy, DemoContextV1, DemoPage, DemoPeopleQuery, DemoScenarioId, PublicFictionalPersonV1 } from './types';
const api = vi.hoisted(() => ({load:vi.fn(),city:vi.fn(),activation:vi.fn()}));
vi.mock('./data/loadDemoProvider', () => ({loadDemoProvider:api.load}));
vi.mock('./data/cityAssetActivation', () => ({readCityActivation:api.activation}));
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
    getLayout:vi.fn(()=>({buildings:[],roads:[]})),
    getBuildingOccupancy:vi.fn((_id?:string,_minutes?:number,_scenario?:DemoScenarioId,_year?:number,_offset=0,_limit=50):DemoBuildingOccupancy => ({...page(),buildingId:'b-1',assignedResidents:17,assignedWorkers:4,presentNow:1,representation:'visual_synthesis'})),
    getVehicle:vi.fn(() => ({id:'v-1',label:'Семейный автомобиль',occupants:[person],occupancy:1,capacity:4})),
  };
}
let provider:ReturnType<typeof fixture>;
beforeEach(() => {provider=fixture();api.city.mockClear();api.load.mockReset().mockResolvedValue(provider);api.activation.mockReset().mockResolvedValue({});history.replaceState(null,'','#/agents?dataset=city-v2&scenario=inflow&year=2032&stats=fictional&paused=1');});
afterEach(() => {cleanup();vi.restoreAllMocks();});

describe('asynchronous city shell', () => {
  it('opens the newly activated city with detailed graphics on a clean link while preserving explicit native links',async()=>{
    provider.manifest.datasetId='omnitwin-fictional-city-v2';
    history.replaceState(null,'','#/world?paused=1');
    const view=render(<App/>);await waitFor(()=>expect(api.city.mock.lastCall?.[0].context.datasetId).toBe(provider.manifest.datasetId));
    expect(api.city.mock.lastCall?.[0].context.cityGraphicsBackend).toBe('tiled_game');
    view.unmount();api.city.mockClear();history.replaceState(null,'','#/world?paused=1&graphics=native_map');
    render(<App/>);await waitFor(()=>expect(api.city.mock.lastCall?.[0].context.datasetId).toBe(provider.manifest.datasetId));
    expect(api.city.mock.lastCall?.[0].context.cityGraphicsBackend).toBe('native_map');
  });
  it('reloads the movement provider when same-document navigation changes the graphics context',async()=>{
    history.replaceState(null,'','#/world?dataset=city-v2&graphics=native_map&paused=1');
    render(<App/>);await waitFor(()=>expect(api.city).toHaveBeenCalled());
    expect(api.load).toHaveBeenCalledTimes(1);
    act(()=>{location.hash='#/world?dataset=city-v2&graphics=tiled_game&paused=1';});
    await waitFor(()=>expect(api.load).toHaveBeenCalledTimes(2));
    await waitFor(()=>expect(api.city.mock.lastCall?.[0].context.cityGraphicsBackend).toBe('tiled_game'));
  });
  it('marks even a small playing slider seek explicitly, without marking speed or pause as a seek',async()=>{
    history.replaceState(null,'','#/world?dataset=city-v2&minutes=690&paused=0');
    render(<App/>);
    await waitFor(()=>expect(api.city).toHaveBeenCalled());
    const revision=api.city.mock.lastCall?.[0].context.presentationSeekRevision??0;
    fireEvent.change(screen.getByRole('slider',{name:'Время визуализации'}),{target:{value:'689'}});
    expect(api.city.mock.lastCall?.[0].context.presentationSeekRevision).toBe(revision+1);
    fireEvent.change(screen.getByRole('combobox',{name:'Скорость движения'}),{target:{value:'16'}});
    fireEvent.click(screen.getByTestId('play-toggle'));
    expect(api.city.mock.lastCall?.[0].context.presentationSeekRevision).toBe(revision+1);
  });
  const legacyId='omnitwin-public-fictional-chelyabinsk-v1';
  const cityId='omnitwin-fictional-city-v2';
  const eligibleActivation={defaultDatasetId:cityId,cityAssets:{baseUrl:`https://storage.googleapis.com/omnitwin-demo-city-assets/packs/${'a'.repeat(64)}/`,populationManifestSha256:'b'.repeat(64),spatialManifestSha256:'c'.repeat(64)}};
  const useLegacy=()=>{provider.manifest.datasetId=legacyId;provider.manifest.initialPopulation=8246;history.replaceState(null,'',`#/world?dataset=${legacyId}&paused=1&stats=fictional&selected=building:b-1`);};
  it.each([{}, {cityAssets:eligibleActivation.cityAssets}, {defaultDatasetId:legacyId,cityAssets:eligibleActivation.cityAssets}])('labels the legacy world and occupancy without an upgrade offer for inactive activation %j', async activation=>{
    useLegacy();api.activation.mockResolvedValue(activation);render(<App/>);
    const notice=await screen.findByTestId('legacy-dataset-notice');
    expect(notice.textContent?.replace(/\s/g,'')).toContain('8246');
    expect(notice.textContent).toContain('вымышленных');
    expect(notice.textContent).toContain('не заселённость всего Челябинска');
    await waitFor(()=>expect(screen.getByTestId('building-present-now')).toBeTruthy());
    expect(screen.getByTestId('selection-inspector').textContent).toContain('персонажей старого демонабора сейчас внутри');
    expect(screen.queryByRole('button',{name:'Открыть обновлённый город'})).toBeNull();
    expect(location.hash).toContain(`dataset=${legacyId}`);
    expect(api.activation).toHaveBeenCalledOnce();
  });
  it('offers an explicit activated upgrade, preserves the scene slice, and restores the complete legacy URL with Back',async()=>{
    useLegacy();api.activation.mockResolvedValue(eligibleActivation);
    const next={...fixture(),manifest:{datasetId:cityId,initialPopulation:1177058}};
    api.load.mockImplementation((_base,dataset)=>Promise.resolve(dataset===cityId?next:provider));
    history.replaceState(null,'',`#/world?dataset=${legacyId}&paused=1&scenario=inflow&compare=ageing&year=2032&stats=fictional&observedYear=2023&minutes=690&speed=4&weather=rain&lon=61.43&lat=55.19&zoom=17.3&pitch=35&bearing=42&age=70%2B&sex=female&q=old-name&offset=100&selected=building:b-1`);
    render(<App/>);
    const upgrade=await screen.findByRole('button',{name:'Открыть обновлённый город'});
    const before={...api.city.mock.lastCall?.[0].context} as DemoContextV1;const beforeHash=location.hash;
    const push=vi.spyOn(history,'pushState');fireEvent.click(upgrade);
    await waitFor(()=>expect(api.city.mock.lastCall?.[0].context.datasetId).toBe(cityId));
    expect(push).toHaveBeenCalledOnce();
    expect(api.city.mock.lastCall?.[0].context).toMatchObject({...before,datasetId:cityId,cohort:null,agentQuery:undefined,agentOffset:undefined});
    expect(api.city.mock.lastCall?.[0].selectedId).toBeNull();
    const upgraded=new URLSearchParams(location.hash.split('?')[1]);
    for(const key of ['selected','age','sex','q','offset'])expect(upgraded.has(key)).toBe(false);
    expect(screen.queryByTestId('legacy-dataset-notice')).toBeNull();
    act(()=>history.back());
    await waitFor(()=>expect(api.city.mock.lastCall?.[0].context.datasetId).toBe(legacyId));
    expect(location.hash).toBe(beforeHash);
    expect(api.city.mock.lastCall?.[0].context).toEqual(before);
    expect(api.city.mock.lastCall?.[0].selectedId).toBe('b-1');
  });
  it('checks legacy activation once across clock rerenders, aborts on unmount, and fails closed on read errors',async()=>{
    useLegacy();const pending=deferred<typeof eligibleActivation>();api.activation.mockReturnValueOnce(pending.promise);
    const view=render(<App/>);await waitFor(()=>expect(api.activation).toHaveBeenCalledOnce());
    const signal=api.activation.mock.calls[0]?.[1] as AbortSignal;
    fireEvent.change(screen.getByRole('slider',{name:'Время визуализации'}),{target:{value:'800'}});
    fireEvent.change(screen.getByRole('slider',{name:'Время визуализации'}),{target:{value:'810'}});
    expect(api.activation).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button',{name:'Открыть обновлённый город'})).toBeNull();
    view.unmount();expect(signal.aborted).toBe(true);await act(async()=>pending.resolve(eligibleActivation));
    api.activation.mockRejectedValueOnce(new Error('Unapproved city asset namespace'));render(<App/>);
    await waitFor(()=>expect(api.activation).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('button',{name:'Открыть обновлённый город'})).toBeNull();
    expect(screen.getByTestId('legacy-dataset-notice')).toBeTruthy();
  });
  it('does not turn an unmatched rendered building into a zero-population building', async () => {
    provider.getBuildingOccupancy.mockReturnValue({...page([]),buildingId:'b-unknown',assignedResidents:0,assignedWorkers:0,presentNow:0,coverageStatus:'no_index',representation:'visual_synthesis'});
    history.replaceState(null,'','#/world?dataset=city-v2&paused=1&selected=building:b-unknown');
    render(<App/>);
    await waitFor(()=>expect(screen.getByText('Для этого контура пока нет индекса заселённости')).toBeTruthy());
    expect(screen.queryByTestId('building-present-now')).toBeNull();
    expect(screen.queryByTestId('building-roster-page')).toBeNull();
    expect(screen.getByTestId('selection-inspector').textContent).toContain('Это не означает, что здание пустует');
  });
  it('separates building assignments, current visitors and complete paginated presence', async () => {
    provider.getBuildingOccupancy.mockImplementation((_id,_minutes,_scenario,_year,offset=0,limit=50) => ({
      buildingId:'b-1',assignedResidents:375,assignedWorkers:122,assignedStudents:31,visitorsNow:1800,
      presentNow:2137,total:2137,offset,limit,nextOffset:offset+limit<2137?offset+limit:null,
      items:Array.from({length:limit},(_,i)=>({...person,id:`roster-${offset+i}`,name:`Житель ${offset+i+1}`})),representation:'visual_synthesis',
    }));
    history.replaceState(null,'','#/world?dataset=city-v2&paused=1&minutes=690&selected=building:b-1');
    render(<App/>);
    const inspector=await screen.findByTestId('selection-inspector');
    await waitFor(()=>expect(within(inspector).getByTestId('building-present-now').textContent?.replace(/\s/g,'')).toBe('2137'));
    expect(within(inspector).getByText('Назначено жителей', {selector:'dt'}).nextElementSibling?.textContent).toBe('375');
    expect(within(inspector).getByText('Работников', {selector:'dt'}).nextElementSibling?.textContent).toBe('122');
    expect(within(inspector).getByText('Учащихся', {selector:'dt'}).nextElementSibling?.textContent).toBe('31');
    expect(within(inspector).getByText('Посетителей сейчас', {selector:'dt'}).nextElementSibling?.textContent?.replace(/\s/g,'')).toBe('1800');
      expect(within(inspector).getByTestId('building-roster-page').textContent?.replace(/\s/g,'')).toBe('1–50из2137');
      const panel=inspector.closest('aside')!;panel.scrollTop=1200;
      fireEvent.click(within(inspector).getByRole('button', {name:'Следующая страница жителей здания'}));
      expect(panel.scrollTop).toBe(0);
    expect(within(inspector).getByTestId('building-roster-page').textContent?.replace(/\s/g,'')).toBe('51–100из2137');
    expect(within(inspector).getByText('Житель 51')).toBeTruthy();
    expect(provider.prepareBuilding).toHaveBeenCalledOnce();
    act(()=>{history.pushState(null,'','#/world?dataset=city-v2&paused=1&minutes=1100&selected=building:b-1');dispatchEvent(new PopStateEvent('popstate'));});
    await waitFor(()=>expect(within(inspector).getByTestId('building-roster-page').textContent?.replace(/\s/g,'')).toBe('1–50из2137'));
      expect(provider.prepareBuilding).toHaveBeenLastCalledWith('b-1',1100,'baseline',2026,expect.any(AbortSignal));
    });
  it('distinguishes a verified empty building from missing coverage across selection changes',async()=>{
    provider.getBuildingOccupancy.mockImplementation(id=>({...page([]),buildingId:id??'b-missing',assignedResidents:0,assignedWorkers:0,presentNow:0,
      coverageStatus:id==='b-unknown'?'no_index':'covered',representation:'visual_synthesis'}));
    history.replaceState(null,'','#/world?dataset=city-v2&paused=1&selected=building:b-empty');
    render(<App/>);
    await waitFor(()=>expect(screen.getByTestId('building-present-now').textContent).toBe('0'));
    act(()=>api.city.mock.lastCall?.[0].onSelect({kind:'building',id:'b-unknown'}));
    await waitFor(()=>expect(screen.getByText('Для этого контура пока нет индекса заселённости')).toBeTruthy());
    expect(screen.queryByTestId('building-present-now')).toBeNull();
    act(()=>api.city.mock.lastCall?.[0].onSelect({kind:'building',id:'b-empty'}));
    await waitFor(()=>expect(screen.getByTestId('building-present-now').textContent).toBe('0'));
    expect(screen.queryByText('Для этого контура пока нет индекса заселённости')).toBeNull();
  });
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
