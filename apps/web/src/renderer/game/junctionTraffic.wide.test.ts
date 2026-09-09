import {describe,expect,it} from 'vitest';
import fixture from '../../demo/fixtures/cityJunctionWidePaths.json';
import coldFixture from '../../demo/fixtures/cityJunctionColdWidePaths.json';
import mergeFixture from '../../demo/fixtures/cityJunctionColdMergePaths.json';
import {JunctionTraffic,type JunctionPath} from './junctionTraffic';

describe('actual wide source corridor topology',()=>{
  it('bounds repeated intermediate merging across cold source churn',()=>{
    const traffic=new JunctionTraffic();
    const paths:JunctionPath[]=mergeFixture.paths.map(path=>{
      if(path.kind!=='vehicle'&&path.kind!=='pedestrian')throw Error('Invalid fixture actor kind');
      return {...path,kind:path.kind,points:path.points.map(point=>[point[0]!,point[1]!] as const)};
    });
    traffic.sync(paths,mergeFixture.time);
    const {diagnostics,junctions}=traffic.readSignals();
    expect(diagnostics.paths).toBe(121);
    expect(diagnostics.overflowReasons).toEqual([]);
    expect(diagnostics.mergeRefChecks).toBeLessThanOrEqual(250000);
    expect(junctions.length).toBeLessThanOrEqual(256);
  });
  it('merges duplicate body contacts before admitting cold-start retained geometry',()=>{
    const traffic=new JunctionTraffic();
    const paths:JunctionPath[]=coldFixture.paths.map(path=>{
      if(path.kind!=='vehicle'&&path.kind!=='pedestrian')throw Error('Invalid fixture actor kind');
      return {...path,kind:path.kind,points:path.points.map(point=>[point[0]!,point[1]!] as const)};
    });
    traffic.sync(paths,coldFixture.time);
    const {diagnostics,junctions}=traffic.readSignals();
    expect(diagnostics.paths).toBe(126);
    expect(diagnostics.overflowReasons).toEqual([]);
    expect(diagnostics.overflow).toBe(0);
    expect(diagnostics.mergeRefChecks).toBeLessThanOrEqual(250000);
    expect(junctions.length).toBeLessThanOrEqual(256);
    expect(junctions.every(node=>node.approaches.length<=32)).toBe(true);
    for(const time of [coldFixture.time+5,coldFixture.time+10]){
      traffic.sync(paths,time);
      const refreshed=traffic.readSignals().junctions;
      expect(new Set(refreshed.map(node=>node.id)).size).toBe(refreshed.length);
      const approaches=refreshed.flatMap(node=>node.approaches);
      expect(new Set(approaches.map(approach=>approach.id)).size).toBe(approaches.length);
    }
  });
  it('partitions local crossings and shared corridors without overflowing or duplicating physical approaches',()=>{
    const paths:JunctionPath[]=fixture.paths.map(path=>{
      if(path.kind!=='vehicle'&&path.kind!=='pedestrian')throw Error('Invalid fixture actor kind');
      return {...path,kind:path.kind,points:path.points.map(point=>[point[0]!,point[1]!] as const)};
    });
    const traffic=new JunctionTraffic();traffic.sync(paths,55500);
    const sample=traffic.readSignals();
    expect(fixture.sourceActorCount).toBe(618);
    expect(sample.diagnostics.paths).toBe(104);
    expect(sample.diagnostics.overflow).toBe(0);
    expect(sample.diagnostics.longitudinalReservations).toBeGreaterThan(0);
    expect(sample.junctions.length).toBeLessThanOrEqual(256);
    for(const node of sample.junctions){
      expect(node.approaches.length).toBeLessThanOrEqual(32);
      expect(new Set(node.approaches.map(approach=>approach.id)).size).toBe(node.approaches.length);
    }
  });
});
