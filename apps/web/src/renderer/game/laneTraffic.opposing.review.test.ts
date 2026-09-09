import {describe,expect,it} from 'vitest';
import {LaneTraffic,type LaneTrafficVehicle} from './laneTraffic';
import fixture from '../../demo/fixtures/cityJunctionColdMergePaths.json';

function separation(traffic:LaneTraffic,time:number,ids:readonly [string,string]):number{
  const frame=traffic.sampleWindow(time,.25),a=frame.previous.get(ids[0])!,b=frame.previous.get(ids[1])!;
  const nextA=frame.next.get(ids[0])!,nextB=frame.next.get(ids[1])!;let minimum=Infinity;
  for(let step=0;step<=10;step++){
    const alpha=step/10,opacityA=Number(a.visible)+(Number(nextA.visible)-Number(a.visible))*alpha;
    const opacityB=Number(b.visible)+(Number(nextB.visible)-Number(b.visible))*alpha;
    if(opacityA<=.05||opacityB<=.05)continue;
    const x=a.point[0]+(nextA.point[0]-a.point[0])*alpha-b.point[0]-(nextB.point[0]-b.point[0])*alpha;
    const y=a.point[1]+(nextA.point[1]-a.point[1])*alpha-b.point[1]-(nextB.point[1]-b.point[1])*alpha;
    minimum=Math.min(minimum,Math.hypot(x,y));
  }
  return minimum;
}

describe('independent partial-corridor opposing direction review',()=>{
  it('reserves an overlapping source interval across different full-route keys and eventually releases the waiting direction',()=>{
    const traffic=new LaneTraffic();
    const a:LaneTrafficVehicle={id:'incumbent-east',routeKey:'source-a',path:[[0,0],[100,0]],singleLaneKey:'full-path-a',sourceDistance:40,sourceTime:0,sourceSpeed:7,laneSpeed:7,atGrade:false};
    const b:LaneTrafficVehicle={id:'entrant-west',routeKey:'source-b',path:[[120,0],[20,0]],singleLaneKey:'full-path-b',sourceDistance:40,sourceTime:0,sourceSpeed:7,laneSpeed:7,atGrade:false};
    traffic.sync([a]);expect(traffic.sampleWindow(0,0).previous.get(a.id)!.visible).toBe(true);
    traffic.sync([a,b]);let previousA=40,minDistance=Infinity,enteredB=false,movedB=false;
    for(let step=0;step<=100;step++){
      const time=step*.25;minDistance=Math.min(minDistance,separation(traffic,time,[a.id,b.id]));
      const probe=traffic.readProbe([a.id,b.id]),first=probe.vehicles.find(v=>v.id===a.id)!,second=probe.vehicles.find(v=>v.id===b.id)!;
      expect(first.distance).toBeGreaterThanOrEqual(previousA-1e-7);previousA=first.distance;
      if(first.distance<100-1e-7)expect(first.visible).toBe(true);
      enteredB ||= second.visible;movedB ||= second.visible&&second.distance>41;
    }
    expect(minDistance).toBeGreaterThanOrEqual(4.5-1e-4);
    expect(enteredB).toBe(true);expect(movedB).toBe(true);
    expect(traffic.readProbe()).toMatchObject({admissionOverflows:0,followingOverflows:0,sourceReanchors:0});
  });
  it('separates opposing cars on the exact partially shared1209325386/1295642549 source geometries',()=>{
    const sourceA=fixture.paths.find(p=>p.kind==='vehicle'&&p.sourceCorridorKey==='["osm-road:1209325386"]'&&p.points[0]![1]!>1300)!;
    const sourceB=fixture.paths.find(p=>p.kind==='vehicle'&&p.sourceCorridorKey==='["osm-road:1209325386","osm-road:1295642549"]'&&p.points[0]![0]!< -1800)!;
    expect(sourceA).toBeDefined();expect(sourceB).toBeDefined();
    const path=(points:number[][])=>points.map(p=>[p[0]!,p[1]!] as const);
    // Geometry is an exact copy of the checked-in actual cold-view fixture.
    // Initial phases below are explicit synthetic boundary conditions, not a
    // claim to replay every preceding admission from the browser trace.
    const a:LaneTrafficVehicle={id:'source1209325386-car',routeKey:'short-corridor',path:path(sourceA.points),sourceDistance:44,sourceTime:0,sourceSpeed:7,laneSpeed:7,
      singleLaneKey:'complete-short-path',atGrade:true,traversal:'ping_pong',sourceDirection:'reverse',sourceCorridorKey:sourceA.sourceCorridorKey};
    const b:LaneTrafficVehicle={id:'source1295642549-car',routeKey:'long-corridor',path:path(sourceB.points),sourceDistance:147,sourceTime:0,sourceSpeed:7,laneSpeed:7,
      singleLaneKey:'complete-long-path',atGrade:true,traversal:'ping_pong',sourceDirection:'forward',sourceCorridorKey:sourceB.sourceCorridorKey};
    const traffic=new LaneTraffic();traffic.sync([a]);traffic.sampleWindow(0,0);traffic.sync([a,b]);
    let minimum=Infinity;for(let step=0;step<=32;step++){
      minimum=Math.min(minimum,separation(traffic,step*.25,[a.id,b.id]));
      expect(traffic.readProbe([a.id]).vehicles[0]!.visible).toBe(true);
    }
    expect(minimum).toBeGreaterThanOrEqual(4.5-1e-4);
  });
  it('keeps the shared bridge section reserved when full corridors carry different grade and provenance sets',()=>{
    const sourceA=fixture.paths.find(p=>p.kind==='vehicle'&&p.atGrade===false&&p.sourceCorridorKey?.includes('781811257')&&p.points[0]![0]!> -1480)!;
    const sourceB=fixture.paths.find(p=>p.kind==='vehicle'&&p.atGrade===true&&p.sourceCorridorKey==='["osm-road:1535233144","osm-road:656926464","osm-road:880551577"]')!;
    expect(sourceA).toBeDefined();expect(sourceB).toBeDefined();
    const path=(points:number[][])=>points.map(p=>[p[0]!,p[1]!] as const);
    // Both source corridors contain the exact same reversed source edges and
    // verified road656926464/880551577, although their complete ID sets differ.
    const a:LaneTrafficVehicle={id:'bridge-incumbent',routeKey:'bridge-long',path:path(sourceA.points),sourceDistance:140,sourceTime:0,sourceSpeed:7,laneSpeed:7,
      singleLaneKey:'whole-bridge-a',atGrade:false,sourceCorridorKey:sourceA.sourceCorridorKey};
    const b:LaneTrafficVehicle={id:'bridge-entrant',routeKey:'bridge-partial',path:path(sourceB.points),sourceDistance:159,sourceTime:0,sourceSpeed:7,laneSpeed:7,
      singleLaneKey:'whole-bridge-b',atGrade:true,sourceCorridorKey:sourceB.sourceCorridorKey};
    const traffic=new LaneTraffic();traffic.sync([a]);traffic.sampleWindow(0,0);traffic.sync([a,b]);let minimum=Infinity;
    for(let step=0;step<=16;step++){
      minimum=Math.min(minimum,separation(traffic,step*.25,[a.id,b.id]));
      expect(traffic.readProbe([a.id]).vehicles[0]!.visible).toBe(true);
    }
    expect(minimum).toBeGreaterThanOrEqual(4.5-1e-4);
  });
  it('drains a bent shared corridor instead of giving its two consecutive sections to opposing occupants forever',()=>{
    const a:LaneTrafficVehicle={id:'old-east-then-south',routeKey:'bent-short',path:[[-40,0],[0,0],[0,40]],sourceDistance:20,sourceTime:0,sourceSpeed:7,laneSpeed:7,
      singleLaneKey:'whole-bent-a',atGrade:false};
    const b:LaneTrafficVehicle={id:'new-north-then-west',routeKey:'bent-long',path:[[0,60],[0,0],[-60,0]],sourceDistance:40,sourceTime:0,sourceSpeed:7,laneSpeed:7,
      singleLaneKey:'whole-bent-b',atGrade:false};
    const traffic=new LaneTraffic();traffic.sync([a]);traffic.sampleWindow(0,0);traffic.sync([a,b]);
    let minimum=Infinity,previousA=20,enteredB=false,movedB=false;
    for(let step=0;step<=180;step++){
      minimum=Math.min(minimum,separation(traffic,step*.25,[a.id,b.id]));
      const rows=traffic.readProbe([a.id,b.id]).vehicles,first=rows.find(v=>v.id===a.id)!,second=rows.find(v=>v.id===b.id)!;
      expect(first.distance).toBeGreaterThanOrEqual(previousA-1e-7);previousA=first.distance;
      if(first.distance<80-1e-7)expect(first.visible).toBe(true);
      enteredB ||= second.visible;movedB ||= second.visible&&second.distance>70;
    }
    expect(minimum).toBeGreaterThanOrEqual(4.5-1e-4);
    // Incumbent has60m left at7m/s; even starting the entrant at its source
    // start after full drain needs less than26s total.45s allows ample margin.
    expect(previousA).toBeGreaterThanOrEqual(80-1e-7);expect(enteredB).toBe(true);expect(movedB).toBe(true);
  });
});
