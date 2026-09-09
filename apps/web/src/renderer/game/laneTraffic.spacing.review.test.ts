import {describe,expect,it} from 'vitest';
import {LaneTraffic} from './laneTraffic';

describe('independent cross-segment queue convergence review',()=>{
  it('propagates a shared outgoing-segment stop back to the follower before finalizing an interpolation window',()=>{
    // Synthetic source paths isolate longitudinal presentation spacing. A source
    // path bend and another route share the outgoing segment exactly. Marking
    // them grade-separated disables junction policy for this queue-only test.
    const path=[[0,0],[20,0],[20,50]] as const;
    const traffic=new LaneTraffic();traffic.sync([
      {id:'leader',routeKey:'turn',path,sourceDistance:18.2,sourceTime:0,sourceSpeed:5,laneSpeed:5,atGrade:false},
      {id:'follower',routeKey:'turn',path,sourceDistance:10.2,sourceTime:0,sourceSpeed:5,laneSpeed:5,atGrade:false},
      {id:'outgoing-stop',routeKey:'outgoing',path:[[20,0],[20,50]],sourceDistance:7.8,sourceTime:0,sourceSpeed:0,laneSpeed:0,atGrade:false},
    ]);
    const window=traffic.sampleWindow(0,.5),leader=window.previous.get('leader')!,follower=window.previous.get('follower')!;
    expect(leader.distance-follower.distance).toBeCloseTo(8,8);
    for(let step=0;step<=10;step++){
      const alpha=step/10,nextLeader=window.next.get('leader')!,nextFollower=window.next.get('follower')!;
      const ld=leader.distance+(nextLeader.distance-leader.distance)*alpha,fd=follower.distance+(nextFollower.distance-follower.distance)*alpha;
      expect(ld-fd).toBeGreaterThanOrEqual(8-1e-7);
      expect(ld).toBeGreaterThanOrEqual(leader.distance);
      expect(fd).toBeGreaterThanOrEqual(follower.distance);
    }
  });
});
