import {describe,expect,it,vi} from 'vitest';
import {LaneTraffic} from './laneTraffic';
import {JunctionTraffic} from './junctionTraffic';
import {sampleGameHeading,updateGameHeading,type GameHeadingState} from './gameActorHeading';

function replaySourceCorner(){
    // Exact local metric source vertices, captured from osm-road:92291103 and
    // osm-road:1168436293. No invented lateral trajectory or source coordinates.
    // The initialization is a directed regression scenario, not an observation.
    const carPath = [[432.07803918056595,-108.02733649375067],[429.2134825231717,-176.9816220153837],
      [435.3173382810461,-177.24850086919363],[452.61265485837083,-177.89345816439163]] as const;
    const pedestrianPath = [[435.2093616455481,-179.56145160742824],[400.7140019966911,-177.90457811896076]] as const;
    const firstSegment=Math.hypot(carPath[1][0]-carPath[0][0],carPath[1][1]-carPath[0][1]);
    const carInput={id:'turning-van',routeKey:'actual-source-car-corner',path:carPath,sourceDistance:firstSegment-2,sourceTime:12,sourceSpeed:7,laneSpeed:7,atGrade:true};
    const pedestrianInput={id:'waiting-walker',routeKey:'actual-source-pedestrian-segment',path:pedestrianPath,sourceDistance:2.9,sourceTime:12,sourceSpeed:1.2,laneSpeed:1.2,kind:'pedestrian' as const,atGrade:true};
    const traffic=new LaneTraffic();traffic.sync([pedestrianInput]);
    expect(traffic.sampleWindow(12,0).previous.get('waiting-walker')!.visible).toBe(true);
    // The walker is already visible when a later inventory adds the car. A
    // newly discovered bend envelope must retain this person's body and make
    // the car yield; it cannot pass by hiding that incumbent pedestrian.
    traffic.sync([carInput,pedestrianInput]);
    let heading:GameHeadingState|undefined,minimum=Infinity,comparisons=0;
    for(let frame=0;frame<40;frame++){
      const time=12+frame*.2,window=traffic.sampleWindow(time,.2),car=window.previous.get('turning-van')!,walker=window.previous.get('waiting-walker')!;
      expect(walker.visible).toBe(true);
      heading=updateGameHeading(heading,Math.PI-car.heading*Math.PI/180,time,'review');
      for(let step=0;step<=10;step++){
        const alpha=step/10,nextCar=window.next.get('turning-van')!,nextWalker=window.next.get('waiting-walker')!;
        if(!car.visible||!walker.visible||!nextCar.visible||!nextWalker.visible)continue;
        const x=car.point[0]+(nextCar.point[0]-car.point[0])*alpha,z=car.point[1]+(nextCar.point[1]-car.point[1])*alpha;
        const dx=walker.point[0]+(nextWalker.point[0]-walker.point[0])*alpha-x,dz=walker.point[1]+(nextWalker.point[1]-walker.point[1])*alpha-z;
        const yaw=sampleGameHeading(heading,time+.2*alpha),side=Math.abs(dx*Math.cos(yaw)-dz*Math.sin(yaw)),forward=Math.abs(dx*Math.sin(yaw)+dz*Math.cos(yaw));
        // Largest real near-car asset is a 4.5x2m van. The pedestrian radius
        // is the controller's explicit .35m footprint, including a stopped body.
        minimum=Math.min(minimum,Math.hypot(Math.max(0,side-1),Math.max(0,forward-2.25))-.35);comparisons++;
      }
    }
    expect(comparisons).toBeGreaterThan(100);
    return minimum;
}

describe('independent rendered turning-body junction review',()=>{
  it('keeps the full smoothly rotating van clear of a waiting pedestrian on the actual source corner',()=>{
    expect(replaySourceCorner()).toBeGreaterThanOrEqual(-.0001);
  });
  it('corroborates the original body collision when only the bend-envelope speed metadata is disabled',()=>{
    // Directed test-only counterfactual: preserve source paths, actor speeds,
    // clocks, IDs and the rendered heading interpolation. Suppress only the
    // new envelope's speed metadata to show the passing fixture is not vacuous.
    const original=JunctionTraffic.prototype.sync;
    const spy=vi.spyOn(JunctionTraffic.prototype,'sync').mockImplementation(function(inputs,time,isPointClear){
      return original.call(this,inputs.map(input=>({...input,maxSpeedMetersPerSecond:0})),time,isPointClear);
    });
    try{expect(replaySourceCorner()).toBeLessThan(-.03);}finally{spy.mockRestore();}
  });
});
