import {describe,expect,it} from 'vitest';
import {JunctionTraffic,type JunctionActor,type JunctionPath} from './junctionTraffic';
import {LaneTraffic,type LaneTrafficVehicle} from './laneTraffic';

// Synthetic metric source fixtures: no geographic observations or new runtime paths.
const actor=(id:string,pathKey:string,distance:number,desired=distance,fresh=false):JunctionActor=>({id,pathKey,distance,desired,fresh,entered:true});
const route=(key:string,points:JunctionPath['points'],kind:JunctionPath['kind']='vehicle'):JunctionPath=>({key,points,kind,atGrade:true});
const moving=(id:string,path:LaneTrafficVehicle['path'],sourceDistance:number,sourceTime:number,speed:number):LaneTrafficVehicle=>({id,routeKey:id,path,sourceDistance,sourceTime,sourceSpeed:speed,laneSpeed:speed,atGrade:true});

describe('independent junction body and liveness review',()=>{
  it('reserves overlapping car bodies at offset lane endpoints whose centreline segments do not intersect',()=>{
    const traffic=new JunctionTraffic();traffic.sync([route('east',[[-20,2],[0,2]]),route('south',[[2,-20],[2,0]])],1);
    const caps=traffic.constrain([actor('incumbent','east',18,19.5),actor('entrant','south',18,19.5,true)],1);
    const a=caps.get('incumbent')!,b=caps.get('entrant')!;
    expect(a.distance).toBe(19.5);
    // Two perpendicular 4.5m x 2m body rectangles overlap when both axis
    // separations are below half-length + half-width = 3.25m.
    const dx=Math.abs((-20+a.distance)-2),dz=Math.abs(2-(-20+b.distance));
    expect(!b.visible||dx>=3.25||dz>=3.25).toBe(true);
  });
  it('keeps a fresh pedestrian hidden if their path begins inside an occupied vehicle body envelope',()=>{
    const traffic=new JunctionTraffic();traffic.sync([route('car',[[-20,0],[20,0]]),route('walk',[[0,1.1],[0,20]],'pedestrian')],21);
    const caps=traffic.constrain([actor('old-car','car',20,20),actor('new-walker','walk',0,.1,true)],21);
    expect(caps.get('old-car')!.distance).toBe(20);
    const walker=caps.get('new-walker')!;
    // 1m vehicle half-width + .35m pedestrian radius, using actual source positions.
    expect(!walker.visible||1.1+walker.distance>=1.35).toBe(true);
  });
  it('does not advance across a stop line after green ends within the interpolation horizon',()=>{
    const traffic=new LaneTraffic();traffic.sync([moving('east',[[-40,0],[40,0]],32,7.9,5),moving('south',[[0,-40],[0,40]],0,7.9,5)]);
    const sample=traffic.sampleWindow(7.9,.25);
    expect(sample.previous.get('east')!.distance).toBe(32);
    // The car reaches the stop line at8.1, after clearance starts at8.0.
    expect(sample.next.get('east')!.distance).toBeLessThanOrEqual(33+1e-7);
  });
  it('drains two nearby source junctions whose occupied zones overlap instead of retaining a circular wait',()=>{
    const traffic=new LaneTraffic();traffic.sync([
      moving('east',[[-40,0],[40,0]],32,12,2),
      moving('north-then-south',[[13,20],[13,-.4],[0,-.4],[0,20]],22,12,.2),
    ]);
    let previous=traffic.sampleWindow(12,0).previous;
    for(let tick=121;tick<=1500;tick++){
      const time=tick/10,frame=traffic.sampleWindow(time,0).previous;
      for(const[id,row]of frame)expect(row.distance).toBeGreaterThanOrEqual(previous.get(id)!.distance-1e-7);
      const a=frame.get('east')!,b=frame.get('north-then-south')!;
      if(a.visible&&b.visible)expect(Math.hypot(a.point[0]-b.point[0],a.point[1]-b.point[1])).toBeGreaterThanOrEqual(5);
      if(tick===900){expect(b.distance).toBeGreaterThan(37);expect(a.distance).toBeLessThan(40);}
      previous=frame;
    }
    // The merged zone ends at station40.4 on the slow source route. Starting
    // at22 at t12 needs92s at .2m/s just to clear it (t104), followed by the
    // next eastbound green at t120. Releasing east by t90 would be unsafe.
    expect(previous.get('east')!.distance).toBeGreaterThan(50);
    expect(previous.get('north-then-south')!.distance).toBeGreaterThan(45);
  });
});
