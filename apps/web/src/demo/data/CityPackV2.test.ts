import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { CityPackV2, canonicalCityBuildingId } from './CityPackV2';
import type { CityPackManifestV2, CityCellV2 } from './CityPackV2';

const digest=(text:string)=>createHash('sha256').update(text).digest('hex');
function fixture() {
  const building={index:0,id:'openmaptiles_buildings:100',aliases:['openmaptiles_buildings:102'],center:[61.4026,55.1644] as [number,number],districtId:'RU-CHE-SET-CEN',use:'residential' as const,areaM2:300,levels:9,heightM:27,heightQuality:'derived_floors',capacityWeight:96,classificationProvenance:'source_attribute'};
  const cells:CityCellV2[]=Array.from({length:4},(_,i)=>({contract:'DemoCityCellV2',key:`16/${43945+i}/20700`,bbox:[61.39+i*.005,55.16,61.395+i*.005,55.17],buildings:[building],roads:[]}));
  const records=new Map<string,string>();
  const asset=(url:string,value:unknown)=>{const text=JSON.stringify(value);records.set(`https://fixture.test/${url}`,text);return{url,sha256:digest(text),bytes:Buffer.byteLength(text)};};
  const entries=cells.map(c=>({...asset(`${c.key}.json`,c),key:c.key,bbox:c.bbox,buildingCount:1,roadCount:0}));
  const page={...asset('page.json',{contract:'DemoBuildingPageV2',firstIndex:0,buildings:[building]}),firstIndex:0,count:1,firstId:building.id,lastId:building.id};
  const manifest={contract:'DemoCityPackManifestV2',packId:'fixture',datasetVersion:'fixture',bounds:[61.39,55.16,61.415,55.17],coverage:{districtIds:['RU-CHE-SET-CEN']},cells:entries,cellZoom:16,buildingPages:[page],buildingPageSize:512} as CityPackManifestV2;
  const fetcher=vi.fn(async(input:RequestInfo|URL)=>{const text=records.get(String(input));return text?new Response(text):new Response('',{status:404});});
  return{manifest,cells,building,records,fetcher};
}
describe('municipal geometry lazy loading',()=>{
  it('binds native fetch to its browser global for both manifest and asset requests',async()=>{
    const f=fixture(); f.records.set('https://fixture.test/manifest.json',JSON.stringify(f.manifest));
    const originalFetch=globalThis.fetch;
    const guardedFetch=async function(this:unknown,input:RequestInfo|URL){
      if(this!==globalThis)throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
      return f.fetcher(input);
    };
    try {
      globalThis.fetch=guardedFetch as typeof fetch;
      const pack=await CityPackV2.load('https://fixture.test/');
      expect(await pack.loadBuildingByIndex(0)).toMatchObject({id:f.building.id});
      await pack.updateViewport({longitude:61.4,latitude:55.164,zoom:16},[61.39,55.16,61.415,55.17]);
      expect(pack.telemetry.activeCells).toBeGreaterThan(0);
    }finally{globalThis.fetch=originalFetch;}
  });
  it('also preserves global binding when native fetch is explicitly injected',async()=>{
    const f=fixture();
    const fetcher=async function(this:unknown,input:RequestInfo|URL){
      if(this!==globalThis)throw new TypeError('Illegal invocation');
      return f.fetcher(input);
    };
    const pack=await CityPackV2.load('https://fixture.test/',f.manifest,undefined,{fetcher:fetcher as typeof fetch});
    expect(await pack.loadBuildingByIndex(0)).toMatchObject({id:f.building.id});
  });
  it('loads only bounded selected cells, deduplicates buildings and reuses retained cells',async()=>{
    const f=fixture(),pack=await CityPackV2.load('https://fixture.test/',f.manifest,undefined,{fetcher:f.fetcher,maxActiveCells:2,maxCachedCells:3});
    const camera={longitude:61.4,latitude:55.164,zoom:16,pitch:55};
    await pack.updateViewport(camera,[61.39,55.16,61.415,55.17]);
    expect(pack.telemetry.activeCells).toBe(2);expect(pack.getLayout().buildings).toHaveLength(1);
    const calls=f.fetcher.mock.calls.length;await pack.updateViewport(camera,[61.39,55.16,61.415,55.17]);expect(f.fetcher).toHaveBeenCalledTimes(calls);
    expect(pack.getBuilding('openmaptiles_buildings:102')?.id).toBe('openmaptiles_buildings:100');
  });
  it('loads exact metadata by index or source alias without fetching global index',async()=>{
    const f=fixture(),pack=await CityPackV2.load('https://fixture.test/',f.manifest,undefined,{fetcher:f.fetcher});
    expect(await pack.loadBuildingByIndex(0)).toMatchObject({id:f.building.id});
    expect(await pack.loadBuilding('openmaptiles_buildings:102')).toMatchObject({id:f.building.id});
    expect(f.fetcher).toHaveBeenCalledTimes(1);expect(await pack.loadBuilding('invalid:0')).toBeNull();
  });
  it('preserves last good geometry on failures, stale responses and abort',async()=>{
    const f=fixture(),pack=await CityPackV2.load('https://fixture.test/',f.manifest,undefined,{fetcher:f.fetcher,maxActiveCells:1,maxCachedCells:1});
    await pack.updateViewport({longitude:61.392,latitude:55.164,zoom:16,pitch:0},[61.39,55.16,61.395,55.17]);
    const prior=pack.getLayout();f.records.clear();
    await expect(pack.updateViewport({longitude:61.413,latitude:55.164,zoom:16,pitch:0},[61.41,55.16,61.415,55.17])).rejects.toThrow();
    expect(pack.getLayout()).toBe(prior);expect(pack.telemetry.status).toBe('stale');
    const controller=new AbortController();controller.abort();
    await expect(pack.updateViewport({longitude:61.413,latitude:55.164,zoom:16,pitch:0},undefined,controller.signal)).rejects.toMatchObject({name:'AbortError'});
    expect(pack.getLayout()).toBe(prior);
  });
  it('rejects wrong content hashes and does not reinterpret arbitrary ID suffixes',async()=>{
    const f=fixture();f.records.set('https://fixture.test/page.json','{}');
    const pack=await CityPackV2.load('https://fixture.test/',f.manifest,undefined,{fetcher:f.fetcher});
    await expect(pack.loadBuildingByIndex(0)).rejects.toThrow(/length|hash/i);
    expect(canonicalCityBuildingId('openmaptiles_buildings:102')).toBe('openmaptiles_buildings:100');
    expect(canonicalCityBuildingId('openmaptiles_buildings:103')).toBe('openmaptiles_buildings:103');
    expect(canonicalCityBuildingId('openmaptiles_buildings:107')).toBeNull();
  });
  it('decodes explicit gzip and caps the retained cache across viewport changes',async()=>{
    const f=fixture(),page=f.manifest.buildingPages[0]!,text=f.records.get('https://fixture.test/page.json')!,compressed=gzipSync(text);
    page.gzip={url:'page.json.gz',sha256:createHash('sha256').update(compressed).digest('hex'),bytes:compressed.length};
    const fetcher=vi.fn(async(input:RequestInfo|URL)=>String(input).endsWith('.gz')?new Response(compressed):f.fetcher(input));
    const pack=await CityPackV2.load('https://fixture.test/',f.manifest,undefined,{fetcher,maxActiveCells:2,maxCachedCells:3});
    expect(await pack.loadBuildingByIndex(0)).toMatchObject({id:f.building.id});
    expect(String(fetcher.mock.calls[0]?.[0])).toContain('.gz');
    await pack.updateViewport({longitude:61.392,latitude:55.164,zoom:16,pitch:0},[61.39,55.16,61.395,55.17]);
    await pack.updateViewport({longitude:61.413,latitude:55.164,zoom:16,pitch:0},[61.41,55.16,61.415,55.17]);
    expect(pack.telemetry.residentCells).toBeLessThanOrEqual(3);
  });
  it('does not let a late older viewport replace the current cells',async()=>{
    const f=fixture();let finish:(response:Response)=>void=()=>{};
    const oldURL=`https://fixture.test/${f.cells[0]!.key}.json`;
    const fetcher=vi.fn(async(input:RequestInfo|URL)=>String(input)===oldURL?new Promise<Response>(resolve=>{finish=resolve;}):f.fetcher(input));
    const pack=await CityPackV2.load('https://fixture.test/',f.manifest,undefined,{fetcher,maxActiveCells:1});
    const old=pack.updateViewport({longitude:61.392,latitude:55.164,zoom:16,pitch:0},[61.39,55.16,61.395,55.17]);
    const current=await pack.updateViewport({longitude:61.407,latitude:55.164,zoom:16,pitch:0},[61.405,55.16,61.41,55.17]);
    finish(new Response(f.records.get(oldURL)!));await expect(old).rejects.toMatchObject({name:'AbortError'});
    expect(pack.getActiveCells()[0]?.key).toBe(current[0]?.key);expect(pack.telemetry.status).toBe('ready');
  });
});
