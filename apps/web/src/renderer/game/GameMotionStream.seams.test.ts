import {describe,expect,it} from 'vitest';
import {MercatorCoordinate} from 'maplibre-gl';
import {ActorColumnsBridge} from './actorColumnsBridge';
import {LaneTraffic,type LaneTrafficVehicle} from './laneTraffic';
import type {GameActorColumns} from './GameActors';
import type {VisualEntity,WorldSceneMovementPayload} from '../types';
import {sampleGameHeading,shortestHeadingDelta,updateGameHeading} from './gameActorHeading';
import {GameMotionStream} from './GameMotionStream';

const origin={longitude:61.39466,latitude:55.1654},epoch=Date.UTC(2026,0,1)/1000;
const car=(id:string,distance:number,path:readonly(readonly[number,number])[],speed=8):LaneTrafficVehicle=>({id,routeKey:id,path,sourceDistance:distance,sourceTime:0,sourceSpeed:speed,laneSpeed:speed});
function fixture(inputs:readonly LaneTrafficVehicle[]){
 const anchor=MercatorCoordinate.fromLngLat([origin.longitude,origin.latitude]),meter=anchor.meterInMercatorCoordinateUnits();
 const geo=(point:readonly[number,number])=>{const value=new MercatorCoordinate(anchor.x+point[0]*meter,anchor.y+point[1]*meter).toLngLat();return[value.lng,value.lat] as const;};
 const entities:VisualEntity[]=inputs.map((row,i)=>({id:row.id,kind:'vehicle',representation:'focus_person_1to1',representedCount:1,longitude:origin.longitude,latitude:origin.latitude,heading:0,activity:'drive',color:'#777777',seed:i}));
 const movement:WorldSceneMovementPayload={nodes:[],edges:inputs.map(row=>({edgeId:row.id,fromNodeId:'a',toNodeId:'b',edgeKind:'lane',crossesRoad:false,direction:'forward',allowedModes:['car'],geometry:row.path.map(geo),visualSpeedMetersPerSecond:{pedestrian:null,car:row.laneSpeed,bicycle:null,transit:null}})),
  routes:inputs.map(row=>({routeId:row.routeKey,mode:'car',edgeIds:[row.id],traversal:row.traversal??'once'}))};
 const sources=inputs.map(row=>({id:row.id,entityKind:'vehicle' as const,presentationTime:new Date((epoch+row.sourceTime)*1000).toISOString(),motion:{mode:'network_edge' as const,edgeId:row.id,routeId:row.routeKey,
  progress:row.sourceDistance/row.path.slice(1).reduce((n,p,i)=>n+Math.hypot(p[0]-row.path[i]![0],p[1]-row.path[i]![1]),0),speedMps:row.sourceSpeed,direction:'forward' as const}}));
 const traffic=new LaneTraffic(),bridge=new ActorColumnsBridge(entities,movement,sources,origin,epoch,{laneTraffic:traffic});
 // Match the existing traffic regression's exact metric corridors. The bridge
 // still performs all column conversion, opacity and heading production.
 traffic.reset();traffic.sync(inputs);
 const sample=(time:number,horizon=.25)=>{const value=bridge.sample(time,horizon);return{columns:{...value,ids:[...value.ids],previousPositions:value.previousPositions.slice(),nextPositions:value.nextPositions.slice(),headings:value.headings.slice(),
  previousOpacities:value.previousOpacities!.slice(),nextOpacities:value.nextOpacities!.slice()},signals:structuredClone(traffic.readSignals())};};
 return{traffic,bridge,sample};
}
function at(columns:GameActorColumns,id:string,time:number){const i=columns.ids.indexOf(id),alpha=Math.max(0,Math.min(1,(time-columns.previousTime)/(columns.currentTime-columns.previousTime)));if(i<0)throw Error('Missing fixture actor');
 return {point:Array.from({length:3},(_,axis)=>columns.previousPositions[i*3+axis]!+(columns.nextPositions[i*3+axis]!-columns.previousPositions[i*3+axis]!)*alpha),
  opacity:columns.previousOpacities![i]!+(columns.nextOpacities![i]!-columns.previousOpacities![i]!)*alpha,heading:Math.PI-columns.headings[i]!*Math.PI/180};}
function seam(before:GameActorColumns,after:GameActorColumns,id:string,time:number){const a=at(before,id,time),b=at(after,id,time),state=updateGameHeading(undefined,a.heading,before.previousTime,'fixture');
 const headingBefore=sampleGameHeading(state,time),headingAfter=sampleGameHeading(updateGameHeading({...state},b.heading,after.previousTime,'fixture'),time);
 return{distance:Math.hypot(...a.point.map((v,i)=>v-b.point[i]!)),opacity:Math.abs(a.opacity-b.opacity),heading:Math.abs(shortestHeadingDelta(headingBefore,headingAfter)),targetHeading:Math.abs(shortestHeadingDelta(a.heading,b.heading))};}
function signalFixture(){const f=fixture([car('east',0,[[-40,0],[40,0]]),car('south',33,[[0,-40],[0,40]])]);f.sample(0);f.sample(9.9,0);return f;}

describe('real actor-column asynchronous slice seams',()=>{
 it('characterizes the unsafe delayed overlap and the continuous start-boundary alternative',()=>{
  const f=signalFixture(),before=f.sample(9.9),after=f.sample(10.1);
  expect(seam(before.columns,after.columns,'south',10.15).distance).toBeCloseTo(.4,4);
  expect(seam(before.columns,after.columns,'south',10.1)).toMatchObject({distance:0,opacity:0,heading:0});
  expect(before.signals.junctions[0]!.phase).toBe('clearance');expect(after.signals.junctions[0]!.phase).toBe('vehicle');
 });
 it('a touching .25-second green slice keeps the old predicted stop position at its start',()=>{
  const f=signalFixture(),before=f.sample(9.9),after=f.sample(10.15);
  expect(seam(before.columns,after.columns,'south',10.15)).toMatchObject({distance:0,opacity:0,heading:0});
  expect(after.columns.currentTime-after.columns.previousTime).toBeCloseTo(.25);
 });
 it.each([.2,.25])('characterizes signal, entry and reversal seams for %ss starts',step=>{
  const cases=[{name:'signal',f:signalFixture(),from:9.9,until:11.5},
   {name:'entry',f:fixture([car('leader',4,[[0,0],[10,0]]),car('entrant',0,[[0,0],[10,0]])]),from:0,until:2},
   {name:'turn',f:fixture([{...car('turn',90,[[0,0],[100,0]],10),traversal:'ping_pong',sourceDirection:'forward'}]),from:0,until:2.5}];
  const report=[];
  for(const value of cases){let previous=value.f.sample(value.from),maxPosition=0,maxHeading=0,maxTarget=0,visibilityChanges=0;
   for(let index=1;value.from+index*step<=value.until+1e-9;index++){
    const time=value.from+index*step,next=value.f.sample(time);
    for(const id of next.columns.ids){const delta=seam(previous.columns,next.columns,id,time);maxPosition=Math.max(maxPosition,delta.distance);maxHeading=Math.max(maxHeading,delta.heading);maxTarget=Math.max(maxTarget,delta.targetHeading);if(delta.opacity>.001)visibilityChanges++;}
    previous=next;
   }
   report.push({name:value.name,maxPosition,maxHeading,maxTarget,visibilityChanges});
  }
  if(step===.25){
   for(const value of report){expect(value.maxPosition).toBeLessThan(1e-6);expect(value.maxHeading).toBeLessThan(1e-6);}
   expect(report.map(value=>value.visibilityChanges)).toEqual([0,1,0]);
  }else{
   expect(report[0]!.maxPosition).toBeLessThan(1e-6);expect(report[1]!.maxPosition).toBeCloseTo(.2933333,5);expect(report[2]!.maxPosition).toBeCloseTo(.8,5);
   expect(report.map(value=>value.visibilityChanges)).toEqual([0,3,0]);
  }
  expect(report[2]!.maxTarget).toBeCloseTo(Math.PI); // Existing eased heading absorbs the source reversal.
 });
 it('a late actual worker slice resumes the stopped signal fixture without a positional teleport',()=>{
  const f=signalFixture(),stream=new GameMotionStream<ReturnType<typeof f.sample>&{requestId:number}>(9.9);
  const request=stream.request()!,before={...f.sample(request.timeSeconds,request.horizonSeconds),requestId:request.requestId};stream.accept(before);stream.tick(0,9.9,true,1);
  const held=stream.tick(1000,10.9,true,1);expect(stream.diagnostics.underflow).toBe(true);
  const next=stream.request()!,after={...f.sample(next.timeSeconds,next.horizonSeconds),requestId:next.requestId};stream.accept(after);
  const resumed=stream.tick(1000,10.9,true,1);expect(resumed.timeSeconds).toBe(held.timeSeconds);expect(resumed.frames).toHaveLength(1);
  expect(seam(before.columns,resumed.frames[0]!.columns,'south',resumed.timeSeconds).distance).toBeLessThan(1e-4);
  expect(resumed.frames[0]!.signals.junctions[0]!.phase).toBe('vehicle');
 });
 it.each([1,16])('bounded catch-up at %sx follows the same straight source slices and shared signal time',speed=>{
  const f=fixture([car('moving',20,[[0,0],[1000,0]])]);
  const stream=new GameMotionStream<ReturnType<typeof f.sample>&{requestId:number}>(0);
  const refill=()=>{for(let i=0;i<5;i++){const request=stream.request();if(!request)break;stream.accept({...f.sample(request.timeSeconds,request.horizonSeconds),requestId:request.requestId});}};
  refill();let shown=stream.tick(0,.3,true,speed),displayed=shown.frames.at(-1)!,prior=at(displayed.columns,'moving',shown.timeSeconds).point[0]!,priorTime=shown.timeSeconds;
  for(let wall=20;wall<=1000;wall+=20){refill();const authoritative=.3+wall/1000*speed;shown=stream.tick(wall,authoritative,true,speed);displayed=shown.frames.at(-1)??displayed;
   const position=at(displayed.columns,'moving',shown.timeSeconds).point[0]!;
   expect(shown.timeSeconds).toBeGreaterThanOrEqual(priorTime);expect(shown.timeSeconds).toBeLessThanOrEqual(authoritative);
   expect(shown.timeSeconds-priorTime).toBeLessThanOrEqual(.020*speed*1.1+1e-8);
   expect(position).toBeCloseTo(20+8*shown.timeSeconds,4);expect(position-prior).toBeLessThanOrEqual(8*.020*speed*1.1+1e-4);
   expect(displayed.signals.time).toBe(displayed.columns.previousTime);expect(stream.diagnostics.underflow).toBe(false);
   prior=position;priorTime=shown.timeSeconds;
  }
  const paused=stream.tick(5000,.3+speed,false,speed);expect(paused.timeSeconds).toBe(priorTime);expect(stream.diagnostics.catchupMultiplier).toBe(1);
 });
});
