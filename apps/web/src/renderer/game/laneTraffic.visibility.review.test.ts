import {describe,expect,it} from 'vitest';
import {LaneTraffic} from './laneTraffic';

describe('independent endpoint visibility interpolation review',()=>{
  it('does not crossfade a released pedestrian onto a still-visible outgoing car at the same source endpoint',()=>{
    const traffic=new LaneTraffic();
    const carInput={id:'departing-car',routeKey:'source-car',path:[[-20,0],[0,0]] as const,sourceDistance:19,sourceTime:21,sourceSpeed:7,laneSpeed:7,atGrade:true};
    const pedestrianInput={id:'waiting-pedestrian',routeKey:'source-walk',path:[[0,0],[-20,0]] as const,sourceDistance:0,sourceTime:21,sourceSpeed:1.2,laneSpeed:1.2,kind:'pedestrian' as const,atGrade:true};
    traffic.sync([carInput]);traffic.sampleWindow(21,0);
    traffic.sync([carInput,pedestrianInput]);
    const window=traffic.sampleWindow(21,.25),car=window.previous.get('departing-car')!,pedestrian=window.previous.get('waiting-pedestrian')!;
    expect(car.visible).toBe(true);expect(pedestrian.visible).toBe(false);
    const nextCar=window.next.get('departing-car')!,nextPedestrian=window.next.get('waiting-pedestrian')!;
    // Actual GPU opacity interpolates previous/next visibility. Do not release
    // the waiting body halfway through the outgoing body's fade in one window.
    for(let step=1;step<10;step++){
      const alpha=step/10,carOpacity=1+(Number(nextCar.visible)-1)*alpha,pedestrianOpacity=Number(nextPedestrian.visible)*alpha;
      const carX=car.point[0]+(nextCar.point[0]-car.point[0])*alpha,pedestrianX=pedestrian.point[0]+(nextPedestrian.point[0]-pedestrian.point[0])*alpha;
      expect(carOpacity<=.05||pedestrianOpacity<=.05||Math.abs(carX-pedestrianX)>=2.25+.35).toBe(true);
    }
    // Admission must eventually resume after the old actor is actually gone;
    // hiding every new actor forever is not a valid fix.
    traffic.sampleWindow(21.5,0);
    expect(traffic.sampleWindow(21.75,0).previous.get('waiting-pedestrian')!.visible).toBe(true);
  });
});
