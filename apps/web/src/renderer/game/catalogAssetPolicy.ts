import {createCityVisualCatalogTileset,loadCityVisualCatalogCell,type LoadedCityVisualCatalog} from './cityVisualCatalog';
import {fetchVerifiedAsset,type GameAssetIntegrity} from './verifiedAssetResponse';
import type {GameOrigin} from './cameraAdapter';
import type {CityVisualPack} from './cityVisualPack';
import {flatCatalogCellTransform} from './catalogProjection';

/** Lazy verified external tilesets, controlled by the existing tile download queue. */
export function createCatalogAssetPolicy(catalog:LoadedCityVisualCatalog,origin:GameOrigin,fetcher:typeof fetch=fetch){
  const root=createCityVisualCatalogTileset(catalog,origin);
  // Culling-only padding for the lazy wrappers before their precise, flattened
  // child root is known. It does not change source geometry or building heights.
  const runtimeRoot=structuredClone(root.tileset);
  for(const tile of [runtimeRoot.root,...runtimeRoot.root.children])for(const i of [3,7,11]) (tile.boundingVolume.box as number[])[i]+=200;
  const rootJson=JSON.stringify(runtimeRoot);
  const registry=new Map<string,GameAssetIntegrity>(),aliases=new Map<string,string>();
  const prepared=new Map<string,string>(),pending=new Map<string,Promise<string>>();
  let metadataBytes=rootJson.length*2;
  const absolute=(value:string)=>{
    const url=new URL(value,root.tilesetUrl);
    if(url.search||url.hash||url.username||url.password)throw new Error('Unsupported catalog asset URL');
    return url.href;
  };
  const resolve=(value:string)=>{
    const source=absolute(value),url=aliases.get(source)??source;
    if(url!==root.tilesetUrl&&!root.cellManifestUrls.has(url)&&!registry.has(url))throw new Error('City catalog asset is absent from the verified inventory');
    return url;
  };
  function register(pack:CityVisualPack){
    if(registry.size+pack.assetIntegrity.length>32768)throw new Error('Catalog resource metadata budget exceeded');
    for(const descriptor of pack.assetIntegrity){
      const prior=registry.get(descriptor.url);
      if(prior&&(prior.sha256!==descriptor.sha256||prior.bytes!==descriptor.bytes))throw new Error('Conflicting catalog resource identity');
    }
    for(const descriptor of pack.assetIntegrity)registry.set(descriptor.url,descriptor);
    for(const alias of pack.assetAliases??[]){
      if(!registry.has(alias.toUrl)||registry.has(alias.fromUrl)||aliases.has(alias.fromUrl)&&aliases.get(alias.fromUrl)!==alias.toUrl)throw new Error('Invalid verified catalog alias');
      aliases.set(alias.fromUrl,alias.toUrl);
    }
  }
  const prepare=async(url:string,signal?:AbortSignal|null):Promise<string>=>{
    const old=prepared.get(url);if(old){prepared.delete(url);prepared.set(url,old);return old;}
    const inflight=pending.get(url);if(inflight)return inflight;
    const descriptor=root.cellManifestUrls.get(url)!;
    const operation=loadCityVisualCatalogCell(catalog,descriptor.key,{fetcher,signal:signal??undefined}).then(pack=>{
      signal?.throwIfAborted();register(pack);
      const projected=structuredClone(pack.tileset);projected.root.transform=flatCatalogCellTransform(pack.origin,origin);
      const json=JSON.stringify(projected);metadataBytes+=json.length*2;prepared.set(url,json);
      // Parsed hierarchy ownership belongs to TilesRenderer; duplicate source JSON
      // has an independent small LRU and never retains geometry or population data.
      while(prepared.size>32){const key=prepared.keys().next().value!;metadataBytes-=prepared.get(key)!.length*2;prepared.delete(key);}
      return json;
    }).finally(()=>pending.delete(url));pending.set(url,operation);return operation;
  };
  return {
    ...root,resolve,
    get diagnostics(){return {registeredAssets:registry.size,preparedMetadata:prepared.size,pendingMetadata:pending.size,
      metadataBytes:metadataBytes+registry.size*256+aliases.size*384,coverage:catalog.manifest.coverage};},
    async fetchData(value:string,init:RequestInit={}):Promise<Response>{
      const url=resolve(value);init.signal?.throwIfAborted();
      if(url===root.tilesetUrl)return new Response(rootJson,{headers:{'content-type':'application/json'}});
      if(root.cellManifestUrls.has(url))return new Response(await prepare(url,init.signal),{headers:{'content-type':'application/json'}});
      return fetchVerifiedAsset(registry.get(url)!,{...init,credentials:'omit',redirect:'error',mode:'cors',method:'GET'},fetcher);
    },
  };
}
