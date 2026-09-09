import {describe,it,expect,vi} from 'vitest';
import {prepareGameLandCover} from './GameLandCover';
import type {GameSurfaceJob,GameSurfaceResponse} from './gameSurfaceProtocol';

describe('surface worker message entry',()=>{
 it('echoes request identity and transfers prepared arrays through the message boundary without a renderer',async()=>{
  const responses:GameSurfaceResponse[]=[],detached:number[]=[];
  const post=vi.fn((response:GameSurfaceResponse,buffers:ArrayBuffer[])=>{
   responses.push(structuredClone(response,{transfer:buffers}));detached.push(...buffers.map(buffer=>buffer.byteLength));
  });
  vi.stubGlobal('postMessage',post);vi.stubGlobal('onmessage',null);
  try{
   await import('./gameSurfaceWorker');
   const message=(globalThis as unknown as {onmessage:(event:{data:unknown})=>void}).onmessage;
   message({data:{type:'prepare',requestId:3,generation:8,jobs:[]}});
   expect(responses[0]).toMatchObject({type:'rejected',requestId:3,generation:8});
   const job:GameSurfaceJob={kind:'landCover',options:{origin:{longitude:61.4,latitude:55.16}},features:[{
    id:'source-ground',sourceLayer:'landuse',properties:{class:'grass'},geometry:{type:'Polygon',coordinates:[[[61.4,55.16],[61.401,55.16],[61.401,55.161],[61.4,55.161],[61.4,55.16]]]}
   }]};
   const before=structuredClone(job);message({data:{type:'prepare',requestId:4,generation:8,jobs:[structuredClone(job)]}});
   const response=responses[1]!;expect(response).toMatchObject({type:'prepared',requestId:4,generation:8});
   if(response.type!=='prepared')throw Error('Expected prepared output');
   const result=response.results[0]!;expect(result).toMatchObject({kind:'landCover',status:'ready'});
   if(result.status!=='ready'||result.kind!=='landCover')throw Error('Expected land geometry');
   expect(result.prepared).toEqual(prepareGameLandCover(job.features,job.options));
   expect(result.prepared.positions.byteLength).toBeGreaterThan(0);expect(detached).toHaveLength(3);expect(detached.every(bytes=>bytes===0)).toBe(true);expect(job).toEqual(before);
  }finally{vi.unstubAllGlobals();}
 });
});
