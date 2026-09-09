import {describe,it,expect} from 'vitest';
import {GAME_HEADING_POLICY,updateGameHeading,sampleGameHeading,shortestHeadingDelta} from './gameActorHeading';
const radians=(degrees:number)=>degrees*Math.PI/180;
describe('clock-driven presentation heading',()=>{
  it('eases a source corner continuously under a bounded physical angular rate',()=>{
    const heading=updateGameHeading(undefined,0,100,'run');updateGameHeading(heading,radians(90),101,'run');
    expect(sampleGameHeading(heading,101)).toBe(0);expect(sampleGameHeading(heading,101.3)).toBeGreaterThan(0);expect(sampleGameHeading(heading,101.3)).toBeLessThan(radians(90));
    for(let t=101;t<104;t+=.001)expect(Math.abs(sampleGameHeading(heading,t+.001)-sampleGameHeading(heading,t))/.001).toBeLessThanOrEqual(GAME_HEADING_POLICY.maxRadiansPerSecond+1e-4);
    expect(sampleGameHeading(heading,104)).toBeCloseTo(radians(90));
  });
  it('crosses the ±180 boundary by two degrees and gives a continuous endpoint half-turn',()=>{
    const heading=updateGameHeading(undefined,radians(179),0,'run');updateGameHeading(heading,radians(-179),1,'run');
    expect(heading.delta).toBeCloseTo(radians(2));expect(Math.abs(shortestHeadingDelta(sampleGameHeading(heading,2),radians(-179)))).toBeLessThan(1e-9);
    updateGameHeading(heading,radians(1),2,'run');expect(Math.abs(heading.delta)).toBeCloseTo(Math.PI);expect(heading.duration).toBeGreaterThan(1);
    expect(Math.abs(shortestHeadingDelta(sampleGameHeading(heading,2),sampleGameHeading(heading,2.016)))).toBeLessThan(radians(2));
  });
  it('retargets from the actual in-progress angle and repeated source samples do not restart the turn',()=>{
    const heading=updateGameHeading(undefined,0,0,'run');updateGameHeading(heading,1,1,'run');const at=sampleGameHeading(heading,1.2);
    updateGameHeading(heading,2,1.2,'run');expect(sampleGameHeading(heading,1.2)).toBeCloseTo(at,12);const start=heading.start;
    for(let t=1.3;t<1.8;t+=.1)updateGameHeading(heading,2,t,'run');expect(heading.start).toBe(start);expect(sampleGameHeading(heading,4)).toBeCloseTo(2);
  });
  it('freezes on the simulation clock and resets orientation on explicit small seeks or context changes',()=>{
    const heading=updateGameHeading(undefined,0,100,'run:0');updateGameHeading(heading,1,101,'run:0');const paused=sampleGameHeading(heading,101.2);
    for(let i=0;i<100;i++)expect(sampleGameHeading(heading,101.2)).toBe(paused);
    updateGameHeading(heading,-1,101.21,'run:1');expect(sampleGameHeading(heading,101.21)).toBe(-1);expect(heading.duration).toBe(0);
    updateGameHeading(heading,2,90,'run:1');expect(sampleGameHeading(heading,90)).toBe(2);
  });
});
