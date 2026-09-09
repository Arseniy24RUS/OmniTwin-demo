import {describe,it,expect} from 'vitest';
import {prepareGameLaneMarkings,type GameMarkingSegment} from './GameLaneMarkings';
const segment=(key:string,a:readonly[number,number],b:readonly[number,number],extra:Partial<GameMarkingSegment>={}):GameMarkingSegment=>
  ({key,a,b,width:12.6,lanes:4,eligible:true,level:0,...extra});
const options={center:[0,0] as const,phaseOrigin:[0,0] as const,maxMarks:512,isPointClear:()=>true,spend:()=>{}};
describe('source metric lane markings',()=>{
  it('uses 14cm-wide 3m dashes with symmetric physical lane separators and deterministic input ordering',()=>{
    const main=segment('main',[-40,0],[40,0]);const result=prepareGameLaneMarkings([main],options);
    expect(result.markings.length).toBeGreaterThan(0);
    expect([...new Set(result.markings.map(m=>m.offset))]).toEqual([-3,0,3]);
    for(const mark of result.markings){const p=mark.points;expect(Math.hypot(p[1]![0]-p[0]![0],p[1]![1]-p[0]![1])).toBeCloseTo(3,6);expect(Math.hypot(p[3]![0]-p[0]![0],p[3]![1]-p[0]![1])).toBeCloseTo(.14,6)}
    expect(prepareGameLaneMarkings([main,main],options).markings).toEqual(result.markings);
  });
  it('leaves crossing mouths and bends clear while omitting narrow and ineligible roads',()=>{
    const result=prepareGameLaneMarkings([segment('main',[-45,0],[45,0],{lanes:2,width:6.6}),segment('stem',[0,0],[0,45],{lanes:2,width:6.6}),
      segment('narrow',[-40,20],[40,20],{width:4}),segment('service',[-40,-20],[40,-20],{eligible:false}),
      segment('bend',[45,0],[49,30],{lanes:2,width:6.6})],options);
    expect(result.markings.length).toBeGreaterThan(0);
    for(const mark of result.markings){expect(mark.sourceKey).not.toBe('narrow');expect(mark.sourceKey).not.toBe('service');
      const c=mark.points.reduce((p,q)=>[p[0]!+q[0]/4,p[1]!+q[1]/4],[0,0]);expect(Math.hypot(c[0]!,c[1]!)).toBeGreaterThan(6.3);expect(Math.hypot(c[0]!-45,c[1]!)).toBeGreaterThan(6.3)}
    expect(result.diagnostics.skippedJunctionMarks).toBeGreaterThan(0);
  });
  it('respects the supplied exact building/bounds disk guard and the global mark cap',()=>{
    const marks=prepareGameLaneMarkings([segment('main',[-400,0],[400,0])],{...options,maxMarks:5,
      isPointClear:(x,z,r)=>x-r>=-30&&x+r<=30&&z-r>=-20&&z+r<=20&&Math.abs(x)>8});
    expect(marks.markings).toHaveLength(5);expect(marks.diagnostics.truncated).toBe(true);
    for(const mark of marks.markings)for(const p of mark.points){expect(Math.abs(p[0])).toBeLessThan(30);expect(Math.abs(p[0])).toBeGreaterThan(6)}
  });
});
