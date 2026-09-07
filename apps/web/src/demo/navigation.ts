import type { DemoContextV1, DemoAgeBand, DemoScenarioId, DemoCohort } from './types';

export type DemoRoute='world'|'agents'|'scenarios'|'analytics'|'about';
export const DEFAULT_CONTEXT:DemoContextV1={datasetId:'omnitwin-public-fictional-chelyabinsk-v1',territoryId:'RU-CHE-SET',scenario:'baseline',year:2026,cohort:null,presentationMinutes:1100,weather:'clear',playing:true,speed:1,camera:{longitude:61.4026,latitude:55.1684,zoom:16.7,pitch:58,bearing:-24}};
export const ROUTES:Record<DemoRoute,string>={world:'Живой мир',agents:'Агенты',scenarios:'Сценарии',analytics:'Аналитика',about:'О проекте'};
const bounded=(s:string|null,fallback:number,min:number,max:number)=>s!==null&&s.trim()!==''&&Number.isFinite(Number(s))?Math.min(max,Math.max(min,Number(s))):fallback;
export function decodeLocation(hash:string):{route:DemoRoute;context:DemoContextV1;selection:string|null}{
  const [path,query='']=hash.replace(/^#\/?/,'').split('?'); const p=new URLSearchParams(query);
  const scenario=p.get('scenario');const age=p.get('age');const sex=p.get('sex'); const weather=p.get('weather');
  const cohort:DemoCohort={...(['0-17','18-34','35-54','55-69','70+'].includes(age||'')?{ageBand:age as DemoAgeBand}:{}),...(sex==='male'||sex==='female'?{sex:sex as 'male'|'female'}:{})};
  return {route:path in ROUTES?path as DemoRoute:'world',selection:p.get('selected'),context:{...DEFAULT_CONTEXT,
    scenario:['baseline','inflow','ageing'].includes(scenario||'')?scenario as DemoScenarioId:'baseline',
    ...(['baseline','inflow','ageing'].includes(p.get('compare')||'')?{comparisonScenario:p.get('compare') as DemoScenarioId}:{}),
    ...(p.has('q')?{agentQuery:p.get('q')!.slice(0,120)}:{}),
    ...(p.has('offset')?{agentOffset:Math.floor(bounded(p.get('offset'),0,0,20000))}:{}),
    year:Math.round(bounded(p.get('year'),2026,2026,2036)),territoryId:p.get('territory')||DEFAULT_CONTEXT.territoryId,
    cohort:Object.keys(cohort).length?cohort:null,presentationMinutes:bounded(p.get('minutes'),1100,0,1439.99),
    playing:p.get('paused')!=='1',speed:bounded(p.get('speed'),1,1,16),
    weather:['clear','cloudy','rain','snow'].includes(weather||'')?weather as DemoContextV1['weather']:'clear',
    camera:{longitude:bounded(p.get('lon'),DEFAULT_CONTEXT.camera.longitude,61.1,61.8),latitude:bounded(p.get('lat'),DEFAULT_CONTEXT.camera.latitude,54.95,55.4),zoom:bounded(p.get('zoom'),DEFAULT_CONTEXT.camera.zoom,11,18),pitch:bounded(p.get('pitch'),DEFAULT_CONTEXT.camera.pitch,0,60),bearing:bounded(p.get('bearing'),DEFAULT_CONTEXT.camera.bearing,-180,180)}
  }};
}
export function encodeLocation(route:DemoRoute,c:DemoContextV1,selection:string|null=null){
  const p=new URLSearchParams({scenario:c.scenario,year:String(c.year),territory:c.territoryId,minutes:String(c.presentationMinutes),paused:c.playing?'0':'1',speed:String(c.speed),weather:c.weather,lon:String(c.camera.longitude),lat:String(c.camera.latitude),zoom:String(c.camera.zoom),pitch:String(c.camera.pitch),bearing:String(c.camera.bearing)});
  if(c.cohort?.ageBand)p.set('age',c.cohort.ageBand); if(c.cohort?.sex)p.set('sex',c.cohort.sex); if(selection)p.set('selected',selection);
  if(c.comparisonScenario)p.set('compare',c.comparisonScenario);if(c.agentQuery!==undefined)p.set('q',c.agentQuery);if(c.agentOffset!==undefined)p.set('offset',String(c.agentOffset));
  return `#/${route}?${p}`;
}
