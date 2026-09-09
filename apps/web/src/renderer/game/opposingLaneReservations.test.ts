import {describe,expect,it} from 'vitest';
import {OpposingLaneReservations,OPPOSING_LANE_LIMITS} from './opposingLaneReservations';
import coldFixture from '../../demo/fixtures/cityJunctionColdMergePaths.json';

describe('bounded shared display-line direction reservations',()=>{
  it('reserves only the shared interval and admits the opposite direction when source occupancy leaves',()=>{
    const policy=new OpposingLaneReservations();policy.sync([{key:'a',points:[[0,0],[100,0]]},{key:'b',points:[[140,0],[20,0]]}]);
    const old={id:'old',pathKey:'a',distance:50,desired:51,entered:true,fresh:false};
    const fresh={id:'new',pathKey:'b',distance:90,desired:90,entered:true,fresh:true};
    const first=policy.constrain([old,fresh]);
    expect(first.get('old')!.distance).toBe(51);expect(first.get('new')).toEqual({distance:35,visible:true});
    expect(policy.constrain([fresh]).get('new')).toEqual({distance:90,visible:true});
    expect(policy.diagnostics.overflow).toBe(0);
  });
  it('does not join nearby or disjoint source lines and removes prior topology on sync',()=>{
    const policy=new OpposingLaneReservations();policy.sync([{key:'a',points:[[0,0],[100,0]]},{key:'b',points:[[100,.01],[0,.01]]},
      {key:'c',points:[[150,0],[120,0]]}]);
    expect(policy.diagnostics.sections).toBe(0);
    policy.sync([{key:'a',points:[[0,0],[100,0]]},{key:'b',points:[[100,0],[0,0]]}]);
    expect(policy.diagnostics.sections).toBe(1);policy.sync([]);expect(policy.diagnostics.sections).toBe(0);
  });
  it('holds every eligible input on bounded overflow, including paths after the rejected prefix',()=>{
    const policy=new OpposingLaneReservations();
    const paths=Array.from({length:OPPOSING_LANE_LIMITS.paths+1},(_,i)=>({key:`path-${i}`,points:[[0,0],[100,0]] as const}));
    policy.sync(paths);
    const caps=policy.constrain([{id:'old',pathKey:paths[0]!.key,distance:20,desired:21,entered:true,fresh:false},
      {id:'new',pathKey:paths.at(-1)!.key,distance:20,desired:21,entered:true,fresh:true}]);
    expect(policy.diagnostics.overflow).toBe(1);expect(caps.get('old')).toEqual({distance:20,visible:true});
    expect(caps.get('new')).toEqual({distance:20,visible:false});
  });
  it('rejects nonfinite or degenerate source geometry',()=>{
    const policy=new OpposingLaneReservations();
    expect(()=>policy.sync([{key:'bad',points:[[0,0],[NaN,0]]}])).toThrow();
    expect(()=>policy.sync([{key:'bad',points:[[0,0],[0,0]]}])).toThrow();
  });
  it('reserves a connected bend with direction parity aligned through the authored path',()=>{
    const policy=new OpposingLaneReservations();policy.sync([
      {key:'a',points:[[-40,0],[0,0],[-40,40]]},
      {key:'b',points:[[-60,60],[0,0],[-60,0]]},
      {key:'follower',points:[[-60,0],[0,0],[-20,20]]},
    ]);
    expect(policy.diagnostics.sections).toBe(1);
    const old={id:'old',pathKey:'a',distance:20,desired:21,entered:true,fresh:false};
    const fresh={id:'new',pathKey:'b',distance:65,desired:66,entered:true,fresh:true};
    const follower={id:'follower',pathKey:'follower',distance:10,desired:11,entered:true,fresh:false};
    const caps=policy.constrain([old,fresh,follower]);
    expect(caps.get('old')!.distance).toBe(21);expect(caps.get('follower')!.distance).toBe(11);
    expect(caps.get('new')!.distance).toBeLessThan(24);
    expect(policy.constrain([fresh]).get('new')!.distance).toBe(66);
    expect(policy.diagnostics.overflow).toBe(0);
  });
  it('builds the actual retained cold-view geometry and its reverse legs within fixed work limits',()=>{
    const policy=new OpposingLaneReservations(),paths=coldFixture.paths.filter(path=>path.kind==='vehicle')
      .flatMap((path,index)=>{
        const points=path.points.map(point=>[point[0]!,point[1]!] as const);
        return [{key:`source-${index}`,points},{key:`reverse-${index}`,points:[...points].reverse()}];
      });
    policy.sync(paths);
    expect(paths.length).toBeGreaterThan(20);expect(policy.diagnostics.sections).toBeGreaterThan(0);
    expect(policy.diagnostics.overflow).toBe(0);
    // Authored source roads130057432/433/434 retrace a connected section in
    // opposite orientations; that component explicitly serializes new actors.
    expect(policy.diagnostics.exclusiveSections).toBe(1);
    expect(policy.diagnostics.pairChecks).toBeLessThan(OPPOSING_LANE_LIMITS.pairChecks);
    expect(policy.diagnostics.mergeChecks).toBeLessThan(OPPOSING_LANE_LIMITS.mergeChecks);
  });
  it('reports ambiguous self-reversal and holds a fresh entrant while the incumbent drains',()=>{
    const policy=new OpposingLaneReservations();policy.sync([{key:'returning',points:[[0,0],[20,0],[0,0]]}]);
    expect(policy.diagnostics.exclusiveSections).toBe(1);expect(policy.diagnostics.overflow).toBe(0);
    const old={id:'old',pathKey:'returning',distance:10,desired:11,entered:true,fresh:false};
    const entrant={id:'new',pathKey:'returning',distance:1,desired:2,entered:true,fresh:true};
    const caps=policy.constrain([old,entrant]);
    expect(caps.get('old')).toEqual({distance:11,visible:true});
    expect(caps.get('new')!.visible).toBe(false);
    expect(policy.constrain([entrant]).get('new')).toEqual({distance:2,visible:true});
  });
});
