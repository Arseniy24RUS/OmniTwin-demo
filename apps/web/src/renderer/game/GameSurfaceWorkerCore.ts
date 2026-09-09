import {prepareGameRoadSurfaces} from './GameRoadSurfaces';
import {prepareGameLandCover} from './GameLandCover';
import {prepareGameLandUseGround} from './GameLandUseGround';
import {prepareGameVegetation} from './gameVegetationPlacement';
import {prepareGameCourtyardGround} from './GameCourtyardGround';
import {prepareGameBuildingContacts} from './GameBuildingContacts';
import {GAME_SURFACE_KINDS,GAME_SURFACE_WORKER_LIMITS as L,gameSurfaceTransferables,
 type GameSurfaceJob,type GameSurfaceKind,type GameSurfaceJobTelemetry,type GameSurfaceReadyResult,type GameSurfaceResponse,type GameSurfaceResult} from './gameSurfaceProtocol';

const record=(v:unknown):v is Record<string,unknown>=>Boolean(v)&&typeof v==='object'&&!Array.isArray(v);
const id=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=1;
const errorText=(error:unknown)=>error instanceof Error?error.message.slice(0,160):'Surface preparation failed';
interface Size{bytes:number;vertices:number;uniqueBytes:number;uniqueVertices:number;objects:Set<object>}
/** A bounded graph walk rejects non-data values and cycles before source helpers.
 * Shared arrays/Sets are accounted once; source coordinates are never copied.
 * All of this runs in the Worker, not during main-thread postMessage. */
function measure(value:unknown,maxBytes:number,input:boolean,packetSeen?:ReadonlySet<object>):Size{
 let bytes=0,vertices=0,uniqueBytes=0,uniqueVertices=0,nodes=0;const seen=new Set<object>(),active=new Set<object>(),objects=new Set<object>();
 const spend=(n:number,unique:boolean)=>{bytes+=n;if(unique)uniqueBytes+=n;if(bytes>maxBytes)throw Error('Surface data byte budget exceeded');};
 const visit=(v:unknown,depth:number,unique:boolean):void=>{
  if(++nodes>L.inputNodes||depth>L.depth)throw Error('Surface data traversal budget exceeded');
  if(v===null||v===undefined){spend(8,unique);return;}
  if(typeof v==='string'){if(v.length>L.stringLength)throw Error('Surface string budget exceeded');spend(16+v.length*2,unique);return;}
  if(typeof v==='number'){if(!Number.isFinite(v))throw Error('Surface nonfinite data');spend(8,unique);return;}
  if(typeof v==='boolean'){spend(4,unique);return;}
  if(typeof v!=='object')throw Error('Surface requires cloneable data, not callbacks');
  if(active.has(v))throw Error('Surface cyclic data unsupported');if(seen.has(v))return;seen.add(v);active.add(v);
  unique=unique&&!packetSeen?.has(v);if(unique&&packetSeen)objects.add(v);spend(32,unique);
  if(ArrayBuffer.isView(v)){if(!(v.buffer instanceof ArrayBuffer))throw Error('Surface shared buffers unsupported');spend(v.byteLength,unique);}
  else if(v instanceof ArrayBuffer)spend(v.byteLength,unique);
  else if(v instanceof Set){for(const item of v){spend(8,unique);visit(item,depth+1,unique);}}
  else if(Array.isArray(v)){
   if(input&&v.length>=2&&typeof v[0]==='number'&&typeof v[1]==='number'){if(++vertices>L.sourceVertices)throw Error('Surface source vertex budget exceeded');if(unique)uniqueVertices++;}
   spend(v.length*8,unique);for(const item of v)visit(item,depth+1,unique);
  }else{
   const prototype=Object.getPrototypeOf(v);if(prototype!==Object.prototype&&prototype!==null)throw Error('Surface requires plain source records');
   const keys=Object.keys(v);spend(keys.length*8,unique);for(const key of keys){spend(key.length*2,unique);visit((v as Record<string,unknown>)[key],depth+1,unique);}
  }
  active.delete(v);
 };
 visit(value,0,true);return{bytes,vertices,uniqueBytes,uniqueVertices,objects};
}
function arrayBound(v:unknown,max:number){if(!Array.isArray(v)||v.length>max)throw Error('Surface source feature budget exceeded');}
function validateCollections(job:GameSurfaceJob):void{
 const options=job.options;
 if('isPointClear'in options&&options.isPointClear!==undefined)throw Error('Surface clearance callbacks cannot cross Worker boundary');
 if('features'in job)arrayBound(job.features,4096);
 if(job.kind==='roads'){arrayBound(job.roads,8192);if(job.options.bridgeFeatures!==undefined)arrayBound(job.options.bridgeFeatures,4096);}
 if('roads'in options)arrayBound(options.roads,8192);
 if('waterFeatures'in options)arrayBound(options.waterFeatures,4096);
 if('buildings'in options&&options.buildings){
  const source=options.buildings;if(!record(source.data)||!(source.canonicalIds instanceof Set)||source.canonicalIds.size>12000)throw Error('Surface building source invalid');
  arrayBound(source.data.features,12000);
 }
}
function prepare(job:GameSurfaceJob):GameSurfaceReadyResult['prepared']{
 switch(job.kind){
  case'roads':return prepareGameRoadSurfaces(job.roads,job.options);
  case'landCover':return prepareGameLandCover(job.features,job.options,job.previousRetainedBytes??0);
  case'landUseGround':return prepareGameLandUseGround(job.features,job.options,job.previousRetainedBytes??0);
  case'vegetation':return prepareGameVegetation(job.features,job.options);
  case'courtyardGround':return prepareGameCourtyardGround(job.options,job.previousRetainedBytes??0);
  case'buildingContacts':return prepareGameBuildingContacts(job.options,job.previousRetainedBytes??0);
 }
}
/** Stateless computation host. The main client owns stale-generation rejection,
 * per-component retention, queue coalescing and renderer disposal. */
export class GameSurfaceWorkerCore{
 handle(message:unknown):GameSurfaceResponse{
  const requestId=record(message)&&id(message.requestId)?message.requestId:0,generation=record(message)&&id(message.generation)?message.generation:0;
  const reject=(message:string):GameSurfaceResponse=>({type:'rejected',requestId,generation,message});
  if(!record(message)||message.type!=='prepare'||!requestId||!generation||!Array.isArray(message.jobs)||!message.jobs.length||message.jobs.length>L.jobs)return reject('Invalid surface request envelope');
  const kinds=new Set<GameSurfaceKind>();
  for(const job of message.jobs){if(!record(job)||typeof job.kind!=='string'||!GAME_SURFACE_KINDS.includes(job.kind as GameSurfaceKind)||kinds.has(job.kind as GameSurfaceKind))return reject('Invalid or duplicate surface job');kinds.add(job.kind as GameSurfaceKind);}
  const results:GameSurfaceResult[]=[],packetSeen=new Set<object>();let inputBytes=0,sourceVertices=0,resultBytes=0;
  for(const value of message.jobs){
   const job=value as GameSurfaceJob,start=performance.now(),telemetry:GameSurfaceJobTelemetry={inputBytes:0,sourceVertices:0,resultBytes:0,bufferBytes:0,prepareMs:0};
   const finish=(result:GameSurfaceResult)=>{telemetry.prepareMs=performance.now()-start;results.push(result);};
   try{
    if(!record(job.options))throw Error('Surface options missing');
    const size=measure(job,L.inputBytes,true,packetSeen);telemetry.inputBytes=size.bytes;telemetry.sourceVertices=size.vertices;
    if(inputBytes+size.uniqueBytes>L.totalInputBytes||sourceVertices+size.uniqueVertices>L.totalSourceVertices)throw Error('Surface total source budget exceeded');
    inputBytes+=size.uniqueBytes;sourceVertices+=size.uniqueVertices;for(const object of size.objects)packetSeen.add(object);
    if('previousRetainedBytes'in job&&job.previousRetainedBytes!==undefined&&(!Number.isSafeInteger(job.previousRetainedBytes)||job.previousRetainedBytes<0))throw Error('Surface retained byte count invalid');
    if(job.options.loading){finish({kind:job.kind,status:'retained',reason:'loading',telemetry});continue;}
    if((job.kind==='roads'||job.kind==='vegetation')&&(!job.options.buildings||job.options.buildings.coverage!=='complete_viewport'||job.options.buildings.invalidBuildings||job.options.buildings.omittedBuildings)){
     finish({kind:job.kind,status:'retained',reason:'unverified',telemetry});continue;
    }
    validateCollections(job);
    const prepared=prepare(job),measured=measure(prepared,L.resultBytes,false);telemetry.resultBytes=measured.bytes;
    if(resultBytes+measured.bytes>L.totalResultBytes)throw Error('Surface total result byte budget exceeded');
    const result={kind:job.kind,status:'ready',prepared,telemetry} as GameSurfaceReadyResult;
    telemetry.bufferBytes=gameSurfaceTransferables({type:'prepared',requestId,generation,results:[result]}).reduce((sum,buffer)=>sum+buffer.byteLength,0);
    resultBytes+=measured.bytes;finish(result);
   }catch(error){finish({kind:job.kind,status:'error',message:errorText(error),telemetry});}
  }
  const response:GameSurfaceResponse={type:'prepared',requestId,generation,results};
  response.telemetry={inputBytes,sourceVertices,resultBytes,bufferBytes:gameSurfaceTransferables(response).reduce((sum,buffer)=>sum+buffer.byteLength,0),prepareMs:results.reduce((sum,result)=>sum+result.telemetry.prepareMs,0)};
  return response;
 }
}
