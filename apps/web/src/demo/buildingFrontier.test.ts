import {describe, expect, it} from 'vitest';
import {chooseBuildingFrontier,fitBuildingFrontier, type BuildingFrontierTile} from '../renderer/game/buildingFrontier';

const root:BuildingFrontierTile={key:'root',parentKey:null,canonicalIds:['a','b'],drawable:true};
const a:BuildingFrontierTile={key:'a',parentKey:'root',canonicalIds:['a'],drawable:true};
const b:BuildingFrontierTile={key:'b',parentKey:'root',canonicalIds:['b'],drawable:true};
describe('drawable building frontier ownership',()=>{
  it('bounds visible detail by retained geometry bytes and returns farther owners to canonical coarse',()=>{
    const candidate=chooseBuildingFrontier([a,b],['a','b'],'missing',true);
    const metrics=[{key:'a',bytes:80,distance:20},{key:'b',bytes:70,distance:5}];
    expect(fitBuildingFrontier([a,b],candidate,metrics,100)).toMatchObject({tileKeys:['b'],canonicalIds:['b']});
    expect(fitBuildingFrontier([a,b],candidate,metrics,200)).toEqual(candidate);
    expect(fitBuildingFrontier([a,b],candidate,metrics,50).canonicalIds).toEqual([]);
  });
  it('uses a drawable retained parent when the library reports an empty LOD frontier',()=>{
    expect(chooseBuildingFrontier([root,a,b],[],root.key).tileKeys).toEqual(['root']);
  });
  it('never draws a REPLACE parent and children as duplicate building owners',()=>{
    expect(chooseBuildingFrontier([root,a,b],['root','a'],root.key).tileKeys).toEqual(['root']);
    const next=chooseBuildingFrontier([root,a,b],['a','b'],root.key);
    expect(next.tileKeys).toEqual(['a','b']);expect(next.canonicalIds).toEqual(['a','b']);
  });
  it('permits partial detail only with the exact list of owners so canonical coarse fills the rest',()=>{
    expect(chooseBuildingFrontier([root,a,{...b,drawable:false}],['a','b'],root.key).canonicalIds).toEqual(['a']);
  });
  it('prefers a prepared child with canonical native remainder, even while its cached parent is loaded',()=>{
    expect(chooseBuildingFrontier([root,a,b],['root','a'],root.key,true).tileKeys).toEqual(['a']);
    expect(chooseBuildingFrontier([root,a,b],['root','a'],root.key,true).canonicalIds).toEqual(['a']);
  });
  it('does not claim readiness when no geometry remains drawable',()=>{
    expect(chooseBuildingFrontier([{...root,drawable:false}],[],root.key).tileKeys).toEqual([]);
  });
  it('rejects overlapping siblings and malformed graph ownership',()=>{
    expect(()=>chooseBuildingFrontier([a,{...b,canonicalIds:['a']}],['a','b'],'missing')).toThrow(/owner/i);
    expect(()=>chooseBuildingFrontier([a,a],['a'],'root')).toThrow(/duplicate/i);
  });
});
