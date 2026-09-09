import {describe,expect,it,vi} from 'vitest';
import {GameMotionClient,type GameMotionPort} from './GameMotionClient';
import {GameMotionWorkerCore} from './GameMotionWorkerCore';
import type {GameMotionRequest,GameMotionResponse,GameMotionSource} from './gameMotionProtocol';

function source(id='a'):GameMotionSource{return{origin:{longitude:61.4,latitude:55.16},epochSeconds:0,
 entities:[{id,kind:'vehicle',representation:'focus_person_1to1',representedCount:1,longitude:61.4,latitude:55.16,heading:0,seed:1,activity:'drive',color:'#777777'}],
 presentationMovement:null,mobilityPresentationMovement:[],verifiedCityBuildings:null,verifiedCityBuildingBounds:null,gameSourceRoads:[],gameSourceCorridors:[]};}
class FakePort{
 readonly sent:GameMotionRequest[]=[];readonly pending:GameMotionRequest[]=[];readonly core=new GameMotionWorkerCore();
 readonly listeners=new Map<string,Set<(event:unknown)=>void>>();terminated=0;throwPost=false;
 postMessage(message:GameMotionRequest){if(this.throwPost)throw Error('post unavailable');this.sent.push(message);this.pending.push(structuredClone(message));}
 addEventListener(type:string,listener:(event:unknown)=>void){if(!this.listeners.has(type))this.listeners.set(type,new Set());this.listeners.get(type)!.add(listener);}
 removeEventListener(type:string,listener:(event:unknown)=>void){this.listeners.get(type)?.delete(listener);}
 terminate(){this.terminated++;}
 emit(response:GameMotionResponse){for(const callback of this.listeners.get('message')??[])callback({data:response});}
 error(type='error'){for(const callback of this.listeners.get(type)??[])callback({type});}
 reply(change?:(response:GameMotionResponse)=>GameMotionResponse){const request=this.pending.shift();if(!request)throw Error('No fake worker request');const result=this.core.handle(request);this.emit(change?change(result):result);return result;}
}
function setup(){const port=new FakePort(),dirty=vi.fn(),error=vi.fn();let wall=0;const client=new GameMotionClient(port as unknown as GameMotionPort,0,{onDirty:dirty,onError:error,now:()=>wall});
 return{port,client,dirty,error,setWall:(value:number)=>{wall=value;},tick:(value:number,seconds=value/1000,playing=true,speed=1)=>{wall=value;return client.tick(value,seconds,playing,speed);}};}
function initial(f:ReturnType<typeof setup>){f.client.setSource(source());f.port.reply();f.port.reply();return f.tick(0);}

describe('persistent asynchronous motion transport',()=>{
 it('anchors only the initial sample after startup, never a live-source refresh after underflow',()=>{
  const f=setup();f.tick(0);f.client.setSource(source());f.tick(5000,5);f.port.reply();
  expect(f.port.sent.at(-1)).toMatchObject({type:'sample',timeSeconds:5});f.port.reply();expect(f.tick(5050,5.05).timeSeconds).toBe(5);
  f.client.setSource(source('b'));f.tick(10000,10);f.port.reply();f.port.reply();
  expect(f.port.sent.at(-1)).toMatchObject({type:'sample',timeSeconds:5.5,sourceRevision:2});f.client.dispose();
 });
 it('keeps one flight and coalesces every intermediate source revision',()=>{
  const f=setup();f.client.setSource(source('a'));for(let i=0;i<30;i++)f.client.setSource(source('latest-'+i));
  expect(f.port.pending).toHaveLength(1);expect(f.port.sent).toHaveLength(1);f.port.reply();
  expect(f.port.pending).toHaveLength(1);expect(f.port.sent.at(-1)).toMatchObject({type:'configure',sourceRevision:31});
  f.port.reply();expect(f.port.pending).toHaveLength(1);expect(f.port.sent.at(-1)).toMatchObject({type:'sample',sourceRevision:31});
  f.port.reply();expect(f.tick(0).frames[0]!.columns.ids).toEqual(['latest-29']);expect(f.error).not.toHaveBeenCalled();f.client.dispose();
 });
 it('refills from completed replies without a render tick and stops at the bounded ready queue',()=>{
  const f=setup();f.tick(0);f.client.setSource(source());f.port.reply();
  for(let i=0;i<5;i++)f.port.reply();
  expect(f.client.diagnostics.bufferedFrames).toBe(5);expect(f.port.pending).toHaveLength(0);expect(f.port.sent.filter(m=>m.type==='sample')).toHaveLength(5);
  expect(f.client.frame).toBeNull();f.client.dispose();
 });
 it('coalesces repeated seeks, discards old-generation replies and starts only at the newest seek',()=>{
  const f=setup();f.client.setSource(source());for(const time of [10,20,30,40])f.client.reset(time);
  expect(f.port.pending).toHaveLength(1);const stale=f.port.reply();expect(f.port.pending).toHaveLength(1);
  expect(f.port.sent.at(-1)).toMatchObject({type:'configure',generation:5,source:source()});expect(f.port.sent.at(-1)).not.toHaveProperty('sourcePatch');f.port.emit(stale);expect(f.port.pending).toHaveLength(1);
  f.port.reply();expect(f.port.sent.at(-1)).toMatchObject({type:'sample',generation:5,timeSeconds:40});f.port.reply();
  const shown=f.tick(0,40);expect(shown.frames[0]!.generation).toBe(5);expect(shown.timeSeconds).toBe(40);expect(f.error).not.toHaveBeenCalled();f.client.dispose();
 });
 it('sends only changed source fields against the last acknowledged base, including a pending rollback',()=>{
  const f=setup(),a=source();f.client.setSource(a);f.port.reply();f.port.reply();f.tick(0);
  const graph={nodes:[],edges:[],routes:[]};f.client.setSource({...a,presentationMovement:graph});f.port.reply();
  expect(f.port.sent.at(-1)).toMatchObject({type:'configure',sourceRevision:2,baseSourceRevision:1,sourcePatch:{presentationMovement:graph}});
  expect(f.port.sent.at(-1)).not.toHaveProperty('source');
  f.client.setSource({...a,entities:source('new').entities});f.port.reply();
  expect(f.port.sent.at(-1)).toMatchObject({type:'configure',sourceRevision:3,baseSourceRevision:2,sourcePatch:{presentationMovement:null,entities:source('new').entities}});
  const patch=f.port.sent.at(-1);if(patch?.type!=='configure'||!patch.sourcePatch)throw Error('Missing patch');expect(Object.keys(patch.sourcePatch).sort()).toEqual(['entities','presentationMovement']);
  f.port.reply();expect(f.error).not.toHaveBeenCalled();f.client.dispose();
 });
 it('reuses only validated immutable identity arrays while dynamic sample buffers stay independent',()=>{
  const f=setup();initial(f);const old=f.client.frame!;f.port.reply();const next=f.tick(250,.25).frames.at(-1)!;
  expect(next.columns.ids).toBe(old.columns.ids);expect(next.columns.kinds).toBe(old.columns.kinds);expect(next.columns.seeds).toBe(old.columns.seeds);
  expect(next.columns.previousPositions).not.toBe(old.columns.previousPositions);expect(next.columns.nextPositions).not.toBe(old.columns.nextPositions);f.client.dispose();
 });
 it('applies diagnostics, IDs and signal snapshots only with their displayed source window',()=>{
  const f=setup();initial(f);const old=f.client.frame!;expect(old.columns.ids).toEqual(['a']);
  // A future old-source slice is already in flight; a new source waits FIFO.
  f.client.setSource(source('b'));f.port.reply();f.port.reply();
  expect(f.client.diagnostics.configuredRevision).toBe(2);expect(f.client.frame).toBe(old);expect(f.client.diagnostics.sourcePending).toBe(true);
  f.port.reply(response=>response.type==='sample'?{...response,signals:{...response.signals,diagnostics:{...response.signals.diagnostics,overflow:17}}}:response);
  expect(f.tick(100,.1).frames).toEqual([]);expect(f.client.frame).toBe(old);
  const next=f.tick(500,.5).frames.at(-1)!;expect(next.sourceRevision).toBe(2);expect(next.columns.ids).toEqual(['b']);
  expect(next.diagnostics.actorCounts).toEqual({people:0,vehicles:1});expect(next.signals.diagnostics.overflow).toBe(17);f.client.dispose();
 });
 it('holds pause through a late reply and config ack without sampling backwards or endlessly refilling',()=>{
  const f=setup();initial(f);f.tick(100,.1,true);f.tick(100,.1,false);const count=f.port.sent.length;
  f.port.reply();expect(f.port.sent).toHaveLength(count);const frame=f.client.frame;
  f.client.setSource(source('b'));f.port.reply();expect(f.port.pending).toHaveLength(0);
  expect(f.tick(5000,.1,false)).toMatchObject({timeSeconds:.1,frames:[]});expect(f.client.frame).toBe(frame);
  expect(f.client.diagnostics.sourcePending).toBe(true);expect(f.tick(5000,.1,true).timeSeconds).toBe(.1);
  expect(f.port.sent.at(-1)).toMatchObject({type:'sample',timeSeconds:.5,sourceRevision:2});f.client.dispose();
 });
 it('initializes late populated inventory after an empty cold paused frame with a bounded queue',()=>{
  const f=setup();f.tick(0,0,false);f.client.setSource({...source(),entities:[]});f.port.reply();f.port.reply();
  expect(f.tick(0,0,false).frames.at(-1)?.columns.ids).toEqual([]);
  const initialGeneration=f.client.diagnostics.generation;
  // Loading the source must not require the user to start playback when no
  // actor has ever been displayed. The nonempty paused-retention test above
  // still prevents source refresh from rewinding an already visible actor.
  f.client.setSource(source('late-source-car'));
  for(let i=0;i<8&&f.port.pending.length;i++){f.port.reply();f.tick(100+i,0,false);}
  expect(f.client.frame?.columns.ids).toEqual(['late-source-car']);
  expect(f.client.frame?.diagnostics.actorCounts).toEqual({people:0,vehicles:1});
  expect(f.client.diagnostics.generation).toBeGreaterThan(initialGeneration);
  expect(f.client.diagnostics.sourcePending).toBe(false);expect(f.client.diagnostics.presentationSeconds).toBe(0);
  expect(f.port.pending).toHaveLength(0);expect(f.port.sent.filter(m=>m.type==='sample').length).toBeLessThanOrEqual(7);
  expect(f.error).not.toHaveBeenCalled();f.client.dispose();
 });
 it('refreshes partial cold paused actors and late route diagnostics at the same frozen time',()=>{
  const f=setup();f.tick(0,0,false);f.client.setSource(source('a'));f.port.reply();f.port.reply();f.tick(0,0,false);
  const original=f.client.frame!;expect(original.columns.ids).toEqual(['a']);expect(original.diagnostics.motion.openLoopsClamped).toBe(0);
  const next:GameMotionSource={...source('a'),entities:[...source('a').entities,...source('b').entities],
   presentationMovement:{nodes:[],edges:[{edgeId:'late-edge',fromNodeId:'presence:a:start',toNodeId:'presence:a:end',edgeKind:'lane',crossesRoad:false,direction:'bidirectional',allowedModes:['car'],
    geometry:[[61.399,55.16],[61.401,55.16]],visualSpeedMetersPerSecond:{pedestrian:null,car:7,bicycle:null,transit:null}}],
    routes:[{routeId:'late-route',mode:'car',edgeIds:['late-edge'],traversal:'loop'}]},
   mobilityPresentationMovement:[{id:'a',entityKind:'vehicle',presentationTime:new Date(0).toISOString(),motion:{mode:'network_edge',edgeId:'late-edge',routeId:'late-route',progress:.5,speedMps:7,direction:'forward'}}]};
  f.client.setSource(next);expect(f.client.frame).toBe(original);
  for(let i=0;i<8&&f.port.pending.length;i++){f.port.reply();f.tick(100+i,0,false);}
  expect(f.client.frame?.columns.ids).toEqual(['a','b']);expect(f.client.frame?.diagnostics.actorCounts).toEqual({people:0,vehicles:2});
  expect(f.client.frame?.diagnostics.motion.openLoopsClamped).toBe(1);
  expect(f.client.frame?.generation).toBe(original.generation);expect(f.client.frame?.timeSeconds).toBe(0);
  expect(f.port.sent.filter(m=>m.type==='sample').every(m=>m.type==='sample'&&m.timeSeconds===0)).toBe(true);
  expect(f.client.diagnostics.presentationSeconds).toBe(0);expect(f.client.diagnostics.sourcePending).toBe(false);
  expect(f.port.pending).toHaveLength(0);expect(f.error).not.toHaveBeenCalled();f.client.dispose();
 });
 it('fails closed on worker/post failure and never performs a main-thread solver fallback',()=>{
  const f=setup();initial(f);const frame=f.client.frame,count=f.port.sent.length;f.port.error();
  f.client.setSource(source('b'));f.tick(1000);expect(f.port.sent).toHaveLength(count);expect(f.client.frame).toBe(frame);expect(f.error).toHaveBeenCalledTimes(1);f.client.dispose();
  const g=setup();g.port.throwPost=true;g.client.setSource(source());expect(g.error).toHaveBeenCalledWith('post unavailable');expect(g.client.diagnostics.error).toBe('post unavailable');g.client.dispose();
 });
 it('rejects same-revision identity mutation instead of attaching old IDs to new coordinates',()=>{
  const f=setup();initial(f);const frame=f.client.frame;
  f.port.reply(response=>response.type==='sample'?{...response,columns:{...response.columns,ids:['unexpected-new-id']}}:response);
  expect(f.error).toHaveBeenCalledTimes(1);expect(f.client.frame).toBe(frame);expect(f.client.diagnostics.error).toMatch(/membership|identity/i);f.client.dispose();
 });
 it('bounds source diagnostic retention during many paused source-only acknowledgements',()=>{
  const f=setup();initial(f);f.tick(0,0,false);f.port.reply();
  for(let i=0;i<40;i++){f.client.setSource(source('source-'+i));f.port.reply();}
  expect(f.port.pending).toHaveLength(0);
  const retained=(f.client as unknown as{sources:Map<number,unknown>}).sources;
  expect(retained.size).toBeLessThanOrEqual(8);f.client.dispose();
 });
 it('disposal releases queued/displayed output and ignores late worker events',()=>{
  const f=setup();initial(f);const request=f.port.pending[0]!;f.client.dispose();f.client.dispose();
  expect(f.port.terminated).toBe(1);expect([...f.port.listeners.values()].every(set=>set.size===0)).toBe(true);
  f.port.emit(f.port.core.handle(request));f.port.error();expect(f.error).not.toHaveBeenCalled();
  expect(f.client.frame).toBeNull();expect(f.tick(1000).frames).toEqual([]);expect(f.client.diagnostics.bufferedFrames).toBe(0);
 });
});
