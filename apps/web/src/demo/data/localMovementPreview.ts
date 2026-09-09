import {isLocalCityApplication} from './localCityApplication';
/** Explicit tiled-game localhost preview, or the loader-resolved clean V2 default.
 * Never a public dataset activation or an override of an explicit native link. */
export function acceptsLocalMovementPreview(development:boolean,href:string,defaultDatasetId?:string):boolean {
  if(!isLocalCityApplication(development,'/',href))return false;
  const url=new URL(href);
  const query=new URLSearchParams(url.hash.split('?')[1]??'');
  if(query.get('graphics')==='tiled_game'&&query.get('dataset')==='omnitwin-fictional-city-v2')return true;
  return defaultDatasetId==='omnitwin-fictional-city-v2'&&!query.has('dataset')
    &&(!query.has('graphics')||query.get('graphics')==='tiled_game')
    &&!query.get('selected')?.startsWith('person:demo-p-');
}
export function parseLocalMovementPreview(value:unknown,baseUrl:string){
  const item=value as {manifestUrl?:unknown;manifestSha256?:unknown}|null;
  if(!item||typeof item.manifestUrl!=='string'||typeof item.manifestSha256!=='string'||!/^[a-f0-9]{64}$/.test(item.manifestSha256))throw Error('Movement preview requires a pinned manifest');
  const root=new URL('movement-preview-v2/',baseUrl),url=new URL(item.manifestUrl,root);
  if(url.origin!==root.origin||!url.pathname.startsWith(root.pathname)||url.search||url.hash||url.username||url.password||!url.pathname.endsWith('.json'))throw Error('Movement preview namespace mismatch');
  return {manifestUrl:url.href,manifestSha256:item.manifestSha256};
}
export async function readLocalMovementPreview(baseUrl:string,signal?:AbortSignal,defaultDatasetId?:string){
  const href=globalThis.location?.href??'';
  if(!isLocalCityApplication(import.meta.env.DEV,baseUrl,href)||!acceptsLocalMovementPreview(import.meta.env.DEV,href,defaultDatasetId))return undefined;
  const root=new URL(baseUrl,globalThis.location.href);
  const response=await fetch(new URL('movement-preview-v2/activation.json',root),{signal,cache:'no-store'});
  if(response.status===404)return undefined;
  if(!response.ok)throw Error(`Local movement preview HTTP ${response.status}`);
  return parseLocalMovementPreview(await response.json(),root.href);
}
