import {describe,it,expect,vi} from 'vitest';
import {MercatorCoordinate} from 'maplibre-gl';
import {Vector3} from 'three';
import {localToMercatorMatrix} from './cameraAdapter';
import type {VerifiedCityBuildingSnapshot} from '../verifiedCityBuildingTypes';
import {prepareGameRoadSurfaces} from './GameRoadSurfaces';
import {prepareGameLandCover} from './GameLandCover';
import {prepareGameLandUseGround} from './GameLandUseGround';
import {prepareGameVegetation,type GameVegetationFeature} from './gameVegetationPlacement';
import {prepareGameCourtyardGround} from './GameCourtyardGround';
import {prepareGameBuildingContacts} from './GameBuildingContacts';
import * as landCoverModule from './GameLandCover';
import {GameSurfaceWorkerCore} from './GameSurfaceWorkerCore';
import {gameSurfaceTransferables,GAME_SURFACE_WORKER_LIMITS,type GameSurfaceJob,type GameSurfaceRequest} from './gameSurfaceProtocol';

const origin={longitude:61.39466,latitude:55.1654},matrix=localToMercatorMatrix(origin);
function geo(x:number,z:number):[number,number]{const p=new Vector3(x,0,z).applyMatrix4(matrix),ll=new MercatorCoordinate(p.x,p.y).toLngLat();return[ll.lng,ll.lat];}
const ring=(x:number,z:number,size:number)=>[[x,z],[x+size,z],[x+size,z+size],[x,z+size],[x,z]].map(([a,b])=>geo(a!,b!));
function fixture(){
 const a=geo(-120,-120),b=geo(120,120),bounds=[a[0],b[1],b[0],a[1]] as const;
 const buildings:VerifiedCityBuildingSnapshot={datasetVersion:'test-source',signature:'source-geometry',coverage:'complete_viewport',coverageBounds:bounds,canonicalIds:new Set(['source-building']),cells:['source-cell'],invalidBuildings:0,omittedBuildings:0,vertexCount:10,
  data:{type:'FeatureCollection',features:[{type:'Feature',id:'source-building',properties:{canonical_id:'source-building',height:12},geometry:{type:'Polygon',coordinates:[ring(0,0,40),ring(10,10,20)]}}]}};
 const roads=[{id:'source-road',coordinates:[geo(-90,-60),geo(90,-60)],className:'residential',lanes:2,oneway:false,walkable:true,drivable:true,bridge:false,tunnel:false,layer:0}];
 const green:GameVegetationFeature[]=[{id:'park',sourceLayer:'landuse',properties:{class:'park'},geometry:{type:'Polygon',coordinates:[ring(-100,-100,200),ring(0,0,40)]}},{id:'tree',sourceLayer:'landcover',properties:{natural:'tree'},geometry:{type:'Point',coordinates:geo(70,70)}}];
 const land:GameVegetationFeature[]=[{id:'residential',sourceLayer:'landuse',properties:{class:'residential'},geometry:{type:'Polygon',coordinates:[ring(-110,-110,220)]}}];
 const options={origin,bounds,buildings,roads,qualityTier:'high' as const,sourceId:'verified-map',datasetVersion:'test-source'};
 const jobs:GameSurfaceJob[]=[{kind:'roads',roads,options},{kind:'landCover',features:green,options,previousRetainedBytes:1024},{kind:'landUseGround',features:land,options:{...options,waterFeatures:[]},previousRetainedBytes:1024},
  {kind:'vegetation',features:green,options},{kind:'courtyardGround',options,previousRetainedBytes:1024},{kind:'buildingContacts',options,previousRetainedBytes:1024}];
 return{jobs,options,roads,green,land};
}
function request(jobs:readonly GameSurfaceJob[],requestId=1,generation=1):GameSurfaceRequest{return{type:'prepare',requestId,generation,jobs};}
function reference(job:GameSurfaceJob){switch(job.kind){
 case'roads':return prepareGameRoadSurfaces(job.roads,job.options);
 case'landCover':return prepareGameLandCover(job.features,job.options,job.previousRetainedBytes);
 case'landUseGround':return prepareGameLandUseGround(job.features,job.options,job.previousRetainedBytes);
 case'vegetation':return prepareGameVegetation(job.features,job.options);
 case'courtyardGround':return prepareGameCourtyardGround(job.options,job.previousRetainedBytes);
 case'buildingContacts':return prepareGameBuildingContacts(job.options,job.previousRetainedBytes);
}}
describe('stateless surface geometry Worker core',()=>{
 it('caps accepted source packets at 64 MiB while charging shared building/options graphs only once',()=>{
  expect(GAME_SURFACE_WORKER_LIMITS.inputBytes).toBe(32*1024*1024);expect(GAME_SURFACE_WORKER_LIMITS.totalInputBytes).toBe(64*1024*1024);
  const {jobs}=fixture(),padding=Array(240).fill('x'.repeat(65536));
  for(const job of jobs)(job.options as unknown as Record<string,unknown>).budgetFixture=padding;
  const core=new GameSurfaceWorkerCore(),response=core.handle(request(jobs));if(response.type!=='prepared')throw Error('fixture');
  expect(response.results.every(result=>result.status==='ready')).toBe(true);
  expect(response.telemetry!.inputBytes).toBeGreaterThan(30*1024*1024);expect(response.telemetry!.inputBytes).toBeLessThan(32*1024*1024);
  expect(response.results.reduce((sum,result)=>sum+result.telemetry.inputBytes,0)).toBeGreaterThan(6*30*1024*1024);
  const independent=fixture().jobs.slice(0,3).map(job=>({...job,options:{...job.options,budgetFixture:[...padding]}}));
  const bounded=core.handle(request(independent as GameSurfaceJob[]));if(bounded.type!=='prepared')throw Error('fixture');
  expect(bounded.results[0]!.status).toBe('ready');expect(bounded.results[1]!.status).toBe('ready');expect(bounded.results[2]).toMatchObject({status:'error',message:'Surface total source budget exceeded'});
 });
 it('matches all six existing source preparation results through structured clone including holes and diagnostics',()=>{
  const{jobs}=fixture(),before=structuredClone(jobs),core=new GameSurfaceWorkerCore(),result=core.handle(structuredClone(request(jobs,7,9)));
  expect(result.type).toBe('prepared');if(result.type!=='prepared')throw Error('No prepared response');
  expect(result).toMatchObject({requestId:7,generation:9});expect(result.results).toHaveLength(6);
  for(const [i,item]of result.results.entries()){
   expect(item.status,`${item.kind}: ${'message'in item?item.message:''}`).toBe('ready');if(item.status!=='ready')continue;
   expect(item.prepared).toEqual(reference(jobs[i]!));expect(item.telemetry.inputBytes).toBeGreaterThan(0);expect(item.telemetry.resultBytes).toBeGreaterThan(0);
   expect(item.telemetry.sourceVertices).toBeGreaterThan(0);expect(item.telemetry.resultBytes).toBeLessThanOrEqual(GAME_SURFACE_WORKER_LIMITS.resultBytes);
   if(item.kind==='vegetation')expect(item.prepared.placements.length).toBeGreaterThan(0);
   else if(item.kind==='roads')expect(item.prepared.batches.asphalt.positions.length).toBeGreaterThan(0);
   else if(item.kind==='buildingContacts')expect(item.prepared.packed.length).toBeGreaterThan(0);
   else expect(item.prepared.positions.length).toBeGreaterThan(0);
  }
  expect(jobs).toEqual(before);expect(jobs[0]!.options.buildings?.canonicalIds).toBeInstanceOf(Set);
 });
 it('transfers only unique output buffers and does not detach or mutate source geometry',()=>{
  const{jobs}=fixture(),copy=structuredClone(jobs),response=new GameSurfaceWorkerCore().handle(request(jobs)),buffers=gameSurfaceTransferables(response);
  expect(buffers.length).toBeGreaterThan(10);expect(new Set(buffers).size).toBe(buffers.length);const bytes=buffers.reduce((n,b)=>n+b.byteLength,0);expect(bytes).toBeGreaterThan(0);
  const cloned=structuredClone(response,{transfer:buffers});expect(buffers.every(b=>b.byteLength===0)).toBe(true);expect(gameSurfaceTransferables(cloned).reduce((n,b)=>n+b.byteLength,0)).toBe(bytes);expect(jobs).toEqual(copy);
 });
 it('isolates one invalid geometry and source-budget failure while other components succeed',()=>{
  const{jobs}=fixture(),bad=jobs.find(j=>j.kind==='landCover')!;
  if(bad.kind!=='landCover')throw Error('fixture');bad.features=[{properties:{class:'grass'},geometry:{type:'Polygon',coordinates:[[[NaN,55],[61,55],[61,56],[NaN,55]]]}}];
  const result=new GameSurfaceWorkerCore().handle(request(jobs));expect(result.type).toBe('prepared');if(result.type!=='prepared')return;
  expect(result.results.filter(r=>r.status==='ready')).toHaveLength(5);expect(result.results[1]).toMatchObject({kind:'landCover',status:'error'});
  const f=fixture(),roads=f.jobs[0]!;if(roads.kind!=='roads')throw Error('fixture');roads.roads=Array(8193).fill(f.roads[0]);
  const bounded=new GameSurfaceWorkerCore().handle(request(f.jobs));expect(bounded.type).toBe('prepared');if(bounded.type==='prepared'){expect(bounded.results[0]).toMatchObject({status:'error',message:'Surface source feature budget exceeded'});expect(bounded.results[1]!.status).toBe('ready');}
 });
 it('preserves loading and unverified retention without changing other component error semantics',()=>{
  const{jobs}=fixture();for(const job of jobs)job.options.loading=true;
  const core=new GameSurfaceWorkerCore(),loading=core.handle(request(jobs));expect(loading.type).toBe('prepared');if(loading.type==='prepared')expect(loading.results.every(r=>r.status==='retained'&&r.reason==='loading')).toBe(true);
  const f=fixture();for(const job of f.jobs)if('buildings'in job.options)job.options.buildings=null;
  const unverified=core.handle(request(f.jobs));expect(unverified.type).toBe('prepared');if(unverified.type==='prepared'){
   expect(unverified.results[0]).toMatchObject({kind:'roads',status:'retained',reason:'unverified'});expect(unverified.results[3]).toMatchObject({kind:'vegetation',status:'retained',reason:'unverified'});
   expect(unverified.results[1]!.status).toBe('ready');expect(unverified.results[2]!.status).toBe('error');expect(unverified.results[4]!.status).toBe('error');expect(unverified.results[5]!.status).toBe('error');
  }
 });
 it('forwards prior retained memory exactly and rejects callback clearance without silently omitting it',()=>{
  const f=fixture(),job=f.jobs[1]!;if(job.kind!=='landCover')throw Error('fixture');job.previousRetainedBytes=8*1024*1024;
  expect(()=>reference(job)).toThrow();const result=new GameSurfaceWorkerCore().handle(request([job,f.jobs[0]!]));expect(result.type).toBe('prepared');if(result.type==='prepared'){expect(result.results[0]!.status).toBe('error');expect(result.results[1]!.status).toBe('ready');}
  const callback={...f.jobs[3],options:{...f.options,isPointClear:()=>false}};
  const refused=new GameSurfaceWorkerCore().handle(request([callback as GameSurfaceJob,f.jobs[0]!]));expect(refused.type).toBe('prepared');if(refused.type==='prepared'){expect(refused.results[0]).toMatchObject({status:'error'});expect(refused.results[1]!.status).toBe('ready');}
 });
 it('rejects bad envelopes, duplicates, cycles and oversized outputs without retaining job state',()=>{
  const core=new GameSurfaceWorkerCore(),{jobs}=fixture();
  for(const value of[null,{},request([]),request(jobs,0),request(jobs,1,0),request([jobs[0]!,jobs[0]!]),{...request(jobs),jobs:[...jobs,jobs[0]]}])expect(core.handle(value).type).toBe('rejected');
  const cyclic={...jobs[1],options:{...jobs[1]!.options}} as Record<string,unknown>;cyclic.self=cyclic;
  const response=core.handle(request([cyclic as unknown as GameSurfaceJob,jobs[0]!]));if(response.type!=='prepared')throw Error('fixture');expect(response.results[0]).toMatchObject({status:'error',message:'Surface cyclic data unsupported'});expect(response.results[1]!.status).toBe('ready');
  const result=reference(jobs[1]!);const spy=vi.spyOn(landCoverModule,'prepareGameLandCover').mockReturnValueOnce({...result,positions:new Float32Array(GAME_SURFACE_WORKER_LIMITS.resultBytes/4+1)} as ReturnType<typeof prepareGameLandCover>);
  try{const oversized=core.handle(request([jobs[1]!,jobs[0]!]));if(oversized.type!=='prepared')throw Error('fixture');expect(oversized.results[0]).toMatchObject({status:'error',message:'Surface data byte budget exceeded'});expect(oversized.results[1]!.status).toBe('ready');}finally{spy.mockRestore();}
  // Core only echoes lifetime generations; the client rejects stale replies.
  expect(core.handle(request([jobs[1]!],19,3))).toMatchObject({type:'prepared',requestId:19,generation:3});expect(core.handle(request([jobs[1]!],20,2))).toMatchObject({type:'prepared',requestId:20,generation:2});
 });
});
