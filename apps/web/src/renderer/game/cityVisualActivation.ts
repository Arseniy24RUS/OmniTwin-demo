export interface CityVisualActivation {
  contract:'CityVisualActivationV1';version:1;
  populationDatasetId:string;sourceDatasetVersion:string;
  manifest:{url:string;bytes:number;sha256:string};
}
const sha=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
/** The application owns this independent root pin; an asset cannot authorize itself. */
export function parseCityVisualActivation(value:unknown,populationDatasetId:string):CityVisualActivation {
  const item=value as Partial<CityVisualActivation>|null;
  if(!item||item.contract!=='CityVisualActivationV1'||item.version!==1||!sha(item.sourceDatasetVersion)
    ||!item.manifest||!sha(item.manifest.sha256)||!Number.isSafeInteger(item.manifest.bytes)
    ||item.manifest.bytes<1||item.manifest.bytes>1048576||typeof item.manifest.url!=='string')throw Error('Invalid visual activation');
  if(item.populationDatasetId!==populationDatasetId)throw Error('Visual activation population mismatch');
  const url=new URL(item.manifest.url);
  if(url.href!==item.manifest.url||url.origin!=='https://storage.googleapis.com'||url.username||url.password||url.search||url.hash
    ||!/^\/omnitwin-demo-city-assets\/packs\/[a-f0-9]{64}\/city-visual-v1\/manifest\.json$/.test(url.pathname))throw Error('Invalid visual activation namespace');
  return {contract:'CityVisualActivationV1',version:1,populationDatasetId,sourceDatasetVersion:item.sourceDatasetVersion,
    manifest:{url:url.href,bytes:item.manifest.bytes,sha256:item.manifest.sha256}};
}

export async function readCityVisualActivation(options:{applicationBaseUrl:string;development:boolean;populationDatasetId:string;signal?:AbortSignal;fetcher?:typeof fetch}) {
  const root=new URL(options.applicationBaseUrl);
  if(options.development&&['127.0.0.1','localhost','[::1]'].includes(root.hostname))return {
    mode:'local_preview' as const,manifestUrl:new URL('city-visual-v1/manifest.json',root).href,
    manifestIntegrity:undefined,sourceDatasetVersion:undefined,
  };
  const response=await (options.fetcher??fetch)(new URL('city-visual-activation.json',root),{
    signal:options.signal,credentials:'omit',redirect:'error',cache:'no-cache',
  });
  if(!response.ok||!response.body)throw Error(`Visual activation unavailable (${response.status})`);
  const reader=response.body.getReader(),parts:Uint8Array[]=[];let length=0;
  try{
    for(;;){options.signal?.throwIfAborted();const {done,value}=await reader.read();if(done)break;
      length+=value.byteLength;if(length>32768)throw Error('Visual activation too large');parts.push(value);
    }
  }catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
  const bytes=new Uint8Array(length);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}
  const activation=parseCityVisualActivation(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)),options.populationDatasetId);
  return {mode:'published' as const,manifestUrl:activation.manifest.url,manifestIntegrity:activation.manifest,sourceDatasetVersion:activation.sourceDatasetVersion};
}
