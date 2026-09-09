import {describe,it,expect,vi,beforeEach,afterEach} from 'vitest';
import {createHash} from 'node:crypto';
import {createCatalogAssetPolicy} from './catalogAssetPolicy';
import {loadCityVisualCatalogCell,type LoadedCityVisualCatalog} from './cityVisualCatalog';
import type {CityVisualPack} from './cityVisualPack';
import {BuildingCacheAdmission} from './buildingCacheAdmission';
import {BuildingTileCache} from './BuildingTileCache';
const fixture=vi.hoisted(()=>({root:'https://example.org/catalog/runtime.json',cell:'https://example.org/catalog/cells/a/manifest.json'}));
vi.mock('./cityVisualCatalog',()=>({
  createCityVisualCatalogTileset:()=>({tilesetUrl:fixture.root,cellManifestUrls:new Map([[fixture.cell,{key:'a'}]]),
    tileset:{root:{boundingVolume:{box:[1,2,3,4,0,0,0,4,0,0,0,4]},children:[]}}}),
  loadCityVisualCatalogCell:vi.fn(),
}));
const mesh='https://example.org/catalog/cells/a/tiles/near.glb',shared='https://example.org/catalog/materials/color.jpg',alias='https://example.org/catalog/cells/a/materials/color.jpg';
const origin={longitude:61.4,latitude:55.16,altitude:0};
function pack():CityVisualPack{
  const sha256=createHash('sha256').update('content').digest('hex');
  return {origin,tileset:{root:{transform:Array(16).fill(0),content:{uri:'tiles/near.glb'}}},assetIntegrity:[mesh,shared].map(url=>({url,sha256,bytes:7})),assetAliases:[{fromUrl:alias,toUrl:shared}]} as unknown as CityVisualPack;
}
const catalog={manifest:{coverage:{status:'partial',compiledCells:1,plannedCells:4}}} as LoadedCityVisualCatalog;
describe('catalog streaming asset policy',()=>{
  beforeEach(()=>vi.mocked(loadCityVisualCatalogCell).mockReset());
  afterEach(()=>vi.useRealTimers());
  it('releases two stalled child bodies after a camera change while keeping the committed parent and denying same-frame retries',async()=>{
    vi.useFakeTimers();const secondMesh=mesh.replace('near.glb','second.glb'),sourcePack=pack();
    vi.mocked(loadCityVisualCatalogCell).mockResolvedValue({...sourcePack,assetIntegrity:[...sourcePack.assetIntegrity,{...sourcePack.assetIntegrity[0]!,url:secondMesh}]});
    const cancelled=vi.fn(),fetcher=vi.fn(async()=>new Response(new ReadableStream<Uint8Array>({cancel:cancelled})));
    const policy=createCatalogAssetPolicy(catalog,origin,fetcher);await policy.fetchData(fixture.cell);
    const admission=new BuildingCacheAdmission({maxBytes:100}),cache=new BuildingTileCache(admission,8);
    const parent={content:{uri:'parent.glb'}},children=[mesh,secondMesh].map(uri=>({content:{uri}})),errors:unknown[]=[];
    cache.add(parent,()=>{});admission.loaded('parent.glb',100);admission.reconcile(['parent.glb'],['parent.glb'],'old-view');
    for(const tile of children){
      const abort=new AbortController();expect(cache.add(tile,()=>abort.abort())).toBe(true);
      // This is the existing TilesRenderer load-error/public cache-removal path.
      void policy.fetchData(tile.content.uri,{signal:abort.signal}).catch(error=>{
        // TilesRenderer suppresses an explicitly aborted owner or AbortError;
        // transport timeout must reach the real load-error branch instead.
        if(abort.signal.aborted||error.name==='AbortError')return;
        errors.push(error);admission.reject(tile.content.uri);cache.remove(tile);
      });
    }
    await vi.advanceTimersByTimeAsync(1000);
    expect(admission.reconcile(['parent.glb'],['parent.glb'],'new-view')).toEqual([]);cache.markAllUnused();cache.unloadUnusedContent();
    expect(admission.diagnostics).toMatchObject({pending:2,staging:2,committedBytes:100});expect(cancelled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(24000);
    expect(errors).toHaveLength(2);expect(errors).toEqual([expect.objectContaining({name:'CityAssetStallError'}),expect.objectContaining({name:'CityAssetStallError'})]);
    expect(cancelled).toHaveBeenCalledTimes(2);expect(cache.has(parent)).toBe(true);
    expect(admission.diagnostics).toMatchObject({pending:0,staging:0,committedBytes:100});
    for(const tile of children)expect(cache.add(tile,()=>{})).toBe(false);
    expect(cache.add({content:{uri:'new-neighborhood.glb'}},()=>{})).toBe(true);expect(vi.getTimerCount()).toBe(0);
  });
  it('bounds a server that never sends headers and forwards its abort without an automatic fetch loop',async()=>{
    vi.useFakeTimers();vi.mocked(loadCityVisualCatalogCell).mockResolvedValue(pack());let signal:AbortSignal|undefined;
    const fetcher=vi.fn((_url:RequestInfo|URL,init?:RequestInit)=>{signal=init?.signal??undefined;return new Promise<Response>(()=>{});});
    const policy=createCatalogAssetPolicy(catalog,origin,fetcher);await policy.fetchData(fixture.cell);
    let error:unknown;void policy.fetchData(mesh).catch(value=>{error=value;});
    await vi.advanceTimersByTimeAsync(25000);expect(error).toMatchObject({name:'CityAssetStallError'});
    expect(signal?.aborted).toBe(true);expect(fetcher).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
  });
  it('serves the verified synthetic root without fetching cells and registers resources only after pinned cell preparation',async()=>{
    const fetcher=vi.fn(async()=>new Response('content'));
    vi.mocked(loadCityVisualCatalogCell).mockResolvedValue(pack());
    const policy=createCatalogAssetPolicy(catalog,origin,fetcher);
    expect((await (await policy.fetchData(fixture.root)).json()).root.children).toEqual([]);
    expect(loadCityVisualCatalogCell).not.toHaveBeenCalled();expect(fetcher).not.toHaveBeenCalled();
    expect(()=>policy.resolve(mesh)).toThrow(/inventory/);
    const [first,second]=await Promise.all([policy.fetchData(fixture.cell),policy.fetchData(fixture.cell)]);
    const json=await first.json();expect(await second.json()).toEqual(json);expect(loadCityVisualCatalogCell).toHaveBeenCalledOnce();
    expect(json.root.transform[15]).toBeCloseTo(1);expect(json.root.content.uri).toBe('tiles/near.glb');
    expect(policy.resolve(alias)).toBe(shared);await policy.fetchData(alias);
    expect(fetcher).toHaveBeenCalledWith(shared,expect.objectContaining({credentials:'omit',redirect:'error'}));
    expect(policy.diagnostics.registeredAssets).toBe(2);
  });
  it('keeps failed cell resources unauthorized and rejects corrupt asset bytes after valid metadata',async()=>{
    vi.mocked(loadCityVisualCatalogCell).mockRejectedValueOnce(Error('cell integrity mismatch')).mockResolvedValueOnce(pack());
    const policy=createCatalogAssetPolicy(catalog,origin,async()=>new Response('damaged'));
    await expect(policy.fetchData(fixture.cell)).rejects.toThrow('cell integrity');
    expect(()=>policy.resolve(alias)).toThrow(/inventory/);
    await policy.fetchData(fixture.cell);
    await expect(policy.fetchData(mesh)).rejects.toThrow(/integrity/);
    expect((await policy.fetchData(fixture.root)).ok).toBe(true);
    const abort=new AbortController();abort.abort();await expect(policy.fetchData(fixture.cell,{signal:abort.signal})).rejects.toMatchObject({name:'AbortError'});
  });
});
