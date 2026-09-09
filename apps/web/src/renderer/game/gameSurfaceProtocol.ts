import type {GameRoadSurfaceSource,GameRoadSurfacesOptions,prepareGameRoadSurfaces} from './GameRoadSurfaces';
import type {GameLandCoverOptions,prepareGameLandCover} from './GameLandCover';
import type {GameLandUseGroundOptions,prepareGameLandUseGround} from './GameLandUseGround';
import type {GameVegetationFeature,GameVegetationOptions,prepareGameVegetation} from './gameVegetationPlacement';
import type {prepareGameCourtyardGround} from './GameCourtyardGround';
import type {prepareGameBuildingContacts} from './GameBuildingContacts';

/** Only cloned source data crosses this boundary. Renderer callbacks stay on main. */
export type GameSurfaceVegetationOptions=Omit<GameVegetationOptions,'isPointClear'>;
export type GameSurfaceJob=
 |{kind:'roads';roads:readonly GameRoadSurfaceSource[];options:GameRoadSurfacesOptions}
 |{kind:'landCover';features:readonly GameVegetationFeature[];options:GameLandCoverOptions;previousRetainedBytes?:number}
 |{kind:'landUseGround';features:readonly GameVegetationFeature[];options:Omit<GameLandUseGroundOptions,'isPointClear'>;previousRetainedBytes?:number}
 |{kind:'vegetation';features:readonly GameVegetationFeature[];options:GameSurfaceVegetationOptions}
 |{kind:'courtyardGround';options:GameSurfaceVegetationOptions;previousRetainedBytes?:number}
 |{kind:'buildingContacts';options:GameSurfaceVegetationOptions;previousRetainedBytes?:number};
export type GameSurfaceKind=GameSurfaceJob['kind'];
export interface GameSurfacePreparedByKind{
 roads:ReturnType<typeof prepareGameRoadSurfaces>;
 landCover:ReturnType<typeof prepareGameLandCover>;
 landUseGround:ReturnType<typeof prepareGameLandUseGround>;
 vegetation:ReturnType<typeof prepareGameVegetation>;
 courtyardGround:ReturnType<typeof prepareGameCourtyardGround>;
 buildingContacts:ReturnType<typeof prepareGameBuildingContacts>;
}
export interface GameSurfaceJobTelemetry{
 /** Conservative data accounting, not a JS heap or GPU allocation reading.
  * Packet telemetry deduplicates accepted job graphs. sourceVertices counts
  * unique numeric coordinate-like tuples; each source compiler also validates
  * its exact geometry counts. Failed input validation has no complete count. */
 inputBytes:number;sourceVertices:number;resultBytes:number;bufferBytes:number;prepareMs:number;
}
export type GameSurfaceReadyResult={
 [K in GameSurfaceKind]:{kind:K;status:'ready';prepared:GameSurfacePreparedByKind[K];telemetry:GameSurfaceJobTelemetry}
}[GameSurfaceKind];
export type GameSurfacePreparedResult=GameSurfaceReadyResult
 |{kind:GameSurfaceKind;status:'retained';reason:'loading'|'unverified';telemetry:GameSurfaceJobTelemetry}
 |{kind:GameSurfaceKind;status:'error';message:string;telemetry:GameSurfaceJobTelemetry};
export type GameSurfaceResult=GameSurfacePreparedResult;
export interface GameSurfaceRequest{type:'prepare';requestId:number;generation:number;jobs:readonly GameSurfaceJob[]}
export type GameSurfaceResponse=
 |{type:'prepared';requestId:number;generation:number;results:GameSurfaceResult[];telemetry?:GameSurfaceJobTelemetry}
 |{type:'rejected';requestId:number;generation:number;message:string};
// Accepted preparation data ceilings, not an allocation guard for the initial
// structured clone. The client bounds source inventories and has one flight.
export const GAME_SURFACE_WORKER_LIMITS=Object.freeze({jobs:6,inputBytes:32*1024*1024,totalInputBytes:64*1024*1024,inputNodes:4_000_000,
 sourceVertices:1_000_000,totalSourceVertices:1_000_000,depth:24,stringLength:65536,resultBytes:16*1024*1024,totalResultBytes:64*1024*1024});
export const GAME_SURFACE_KINDS:readonly GameSurfaceKind[]=['roads','landCover','landUseGround','vegetation','courtyardGround','buildingContacts'];

/** Only the exact prepared-output arrays are transferred, never source buffers.
 * Repeated views of the same ArrayBuffer are included once. */
export function gameSurfaceTransferables(response:GameSurfaceResponse):ArrayBuffer[]{
 const buffers=new Set<ArrayBuffer>();
 const add=(view:ArrayBufferView)=>{if(!(view.buffer instanceof ArrayBuffer))throw Error('Surface output requires owned ArrayBuffer');buffers.add(view.buffer);};
 if(response.type==='prepared')for(const result of response.results){if(result.status!=='ready')continue;
  switch(result.kind){
   case'roads':for(const batch of Object.values(result.prepared.batches)){add(batch.positions);add(batch.normals);}break;
   case'vegetation':break;
   case'buildingContacts':add(result.prepared.packed);break;
   case'landUseGround':add(result.prepared.positions);add(result.prepared.normals);break;
   case'landCover':add(result.prepared.positions);add(result.prepared.normals);add(result.prepared.indices);break;
   case'courtyardGround':add(result.prepared.positions);add(result.prepared.normals);add(result.prepared.indices);add(result.prepared.border);break;
  }
 }
 return [...buffers];
}
