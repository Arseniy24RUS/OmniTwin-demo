import {describe,it,expect,vi} from 'vitest';
import {MercatorCoordinate} from 'maplibre-gl';
import {Mesh,Vector3,type BufferGeometry,type MeshStandardMaterial,ShaderLib} from 'three';
import type {VerifiedCityBuildingSnapshot} from '../verifiedCityBuildingTypes';
import {localToMercatorMatrix} from './cameraAdapter';
import {GameCourtyardGround,prepareGameCourtyardGround,GAME_COURTYARD_GROUND_LIMITS} from './GameCourtyardGround';
import {sampleGameCourtyardFloor} from './gameCourtyardGroundMaterial';
const origin={longitude:61.39466,latitude:55.1654},matrix=localToMercatorMatrix(origin);
const ring=(x=0,z=0,n=100)=>[[x,z],[x+n,z],[x+n,z+n],[x,z+n],[x,z]];
function geo(p:readonly number[]){const q=new Vector3(p[0],0,p[1]).applyMatrix4(matrix),ll=new MercatorCoordinate(q.x,q.y).toLngLat();return[ll.lng,ll.lat];}
function feature(id:string,rings:number[][][]){return{type:'Feature' as const,id,properties:{canonical_id:id},geometry:{type:'Polygon' as const,coordinates:rings.map(r=>r.map(geo))}};}
function options(){const a=geo([-20,-20]),b=geo([200,200]),bounds=[a[0]!,b[1]!,b[0]!,a[1]!] as const;
  const buildings:VerifiedCityBuildingSnapshot={datasetVersion:'source-v2',signature:'a',canonicalIds:new Set(['owner']),data:{type:'FeatureCollection',features:[feature('owner',[ring(),ring(10,10,80)])]},cells:['verified-cell'],coverage:'complete_viewport',coverageBounds:bounds,invalidBuildings:0,omittedBuildings:0,vertexCount:10};
  return{origin,bounds,buildings,roads:[],qualityTier:'high' as const};}
function groundMesh(g:GameCourtyardGround){return g.object.children[0] as Mesh<BufferGeometry,MeshStandardMaterial>;}
describe('source-hole courtyard ground',()=>{
  it('preserves the exact concave courtyard and excludes a real building island',()=>{
    const opts=options(),hole=[[10,10],[90,10],[90,35],[35,35],[35,90],[10,90],[10,10]];
    opts.buildings.data.features=[feature('owner',[ring(),hole]),feature('island',[ring(15,15,8)])];opts.buildings.canonicalIds=new Set(['owner','island']);
    const result=prepareGameCourtyardGround(opts);expect(result.diagnostics.courtyards).toBe(1);expect(result.diagnostics.islands).toBe(1);
    let area=0;for(let i=0;i<result.indices.length;i+=3){const p=[0,1,2].map(k=>{const v=result.indices[i+k]!*3;return[result.positions[v]!,result.positions[v+1]!,result.positions[v+2]!]});
      const x=p.reduce((n,v)=>n+v[0]!/3,0),z=p.reduce((n,v)=>n+v[2]!/3,0);expect(x>10-1e-4&&z>10-1e-4&&x<90+1e-4&&z<90+1e-4).toBe(true);
      expect(x>35&&z>35).toBe(false);expect(x>15&&x<23&&z>15&&z<23).toBe(false);
      expect(p.every(v=>v[1]!<.025)).toBe(true);
      if(result.border[result.indices[i]!]===0){const[a,b,c]=p;area+=Math.abs((b![0]!-a![0]!)*(c![2]!-a![2]!)-(b![2]!-a![2]!)*(c![0]!-a![0]!))/2;}
    }
    expect(area).toBeCloseTo(3375-64,2);expect(result.diagnostics.borderTriangles).toBeGreaterThan(0);
  });
  it('deduplicates identical source holes and keeps roads above the uninterrupted floor',()=>{
    const opts=options(),source=JSON.stringify(opts);const a=prepareGameCourtyardGround(opts);const road={coordinates:[[0,50],[100,50]].map(geo),className:'residential',lanes:2};
    const b=prepareGameCourtyardGround({...opts,roads:[road as never]});expect(b.positions).toEqual(a.positions);expect(b.indices).toEqual(a.indices);expect(JSON.stringify(opts)).toBe(source);
    opts.buildings.data.features.push(feature('owner-copy',[ring(),ring(10,10,80).reverse()]));opts.buildings.canonicalIds=new Set(['owner','owner-copy']);
    const repeated=prepareGameCourtyardGround(opts);expect(repeated.diagnostics.courtyards).toBe(1);expect(repeated.diagnostics.duplicates).toBe(1);
    expect(Math.max(...a.positions.filter((_,i)=>i%3===1))).toBeLessThan(.025);
  });
  it('does not synthesize ground for open U shapes, unknown coverage, intersecting islands or an out-of-coverage hole',()=>{
    const opts=options();opts.buildings.data.features=[feature('owner',[[[0,0],[100,0],[100,100],[80,100],[80,20],[20,20],[20,100],[0,100],[0,0]]])];
    expect(prepareGameCourtyardGround(opts).diagnostics.courtyards).toBe(0);
    expect(()=>prepareGameCourtyardGround({...options(),buildings:null})).toThrow();expect(()=>prepareGameCourtyardGround({...options(),buildings:{...options().buildings,coverage:'partial_viewport'}})).toThrow();
    const crossing=options();crossing.buildings.data.features.push(feature('cross',[ring(5,30,10)]));crossing.buildings.canonicalIds=new Set(['owner','cross']);
    expect(prepareGameCourtyardGround(crossing).diagnostics.omittedObstructions).toBe(1);
    const small=options(),nw=geo([20,20]),se=geo([70,70]);small.bounds=[nw[0]!,se[1]!,se[0]!,nw[1]!] as never;
    small.buildings.coverageBounds=small.bounds;
    expect(prepareGameCourtyardGround(small).diagnostics.omittedCoverage).toBe(1);
  });
  it('keeps the complete verified floor when a mobile viewport intersects only part of its source hole',()=>{
    const full=options(),expected=prepareGameCourtyardGround(full),nw=geo([20,20]),se=geo([70,70]);
    const narrow={...full,bounds:[nw[0]!,se[1]!,se[0]!,nw[1]!] as const};
    const actual=prepareGameCourtyardGround(narrow);expect(actual.diagnostics.courtyards).toBe(1);expect(actual.positions).toEqual(expected.positions);
    const outsideNW=geo([110,110]),outsideSE=geo([130,130]);
    expect(prepareGameCourtyardGround({...full,bounds:[outsideNW[0]!,outsideSE[1]!,outsideSE[0]!,outsideNW[1]!] as const}).diagnostics.courtyards).toBe(0);
  });
  it('retains a viable generation while loading/invalid, is deterministic at rest, and disposes once',()=>{
    const ground=new GameCourtyardGround(),opts=options();ground.update(opts);expect(ground.telemetry.state).toBe('ready');expect(ground.telemetry.draws).toBe(1);
    const mesh=groundMesh(ground),geometry=mesh.geometry,disposeGeometry=vi.spyOn(geometry,'dispose'),disposeMaterial=vi.spyOn(mesh.material,'dispose');
    ground.update(opts);expect(mesh.geometry).toBe(geometry);expect(ground.telemetry.geometryUpdates).toBe(1);
    ground.update({...opts,loading:true});expect(ground.telemetry.state).toBe('loading_retained');expect(mesh.geometry).toBe(geometry);
    ground.update({...opts,buildings:null});expect(ground.telemetry.state).toBe('error_retained');expect(mesh.geometry).toBe(geometry);
    expect(ground.telemetry.estimatedPeakBytes).toBeLessThanOrEqual(GAME_COURTYARD_GROUND_LIMITS.bytes);expect(mesh.material.transparent).toBe(false);
    ground.dispose();ground.dispose();expect(disposeGeometry).toHaveBeenCalledTimes(1);expect(disposeMaterial).toHaveBeenCalledTimes(1);expect(ground.telemetry.draws).toBe(0);
  });
  it('caps complete courtyard floors and border details under one bounded allocation regardless of source ordering',()=>{
    const opts=options(),nw=geo([-20,-20]),se=geo([600,600]);opts.bounds=[nw[0]!,se[1]!,se[0]!,nw[1]!] as never;opts.buildings.coverageBounds=opts.bounds;
    opts.buildings.data.features=Array.from({length:150},(_,i)=>feature(`owner-${String(i).padStart(3,'0')}`,[ring((i%15)*30,Math.floor(i/15)*30,20),ring((i%15)*30+2,Math.floor(i/15)*30+2,16)]));
    opts.buildings.canonicalIds=new Set(opts.buildings.data.features.map(f=>String(f.id)));
    const a=prepareGameCourtyardGround({...opts,qualityTier:'low'});opts.buildings.data.features.reverse();const b=prepareGameCourtyardGround({...opts,qualityTier:'low'});
    expect(a.positions).toEqual(b.positions);expect(a.diagnostics.omittedBudget).toBeGreaterThan(0);expect(a.positions.length/3).toBeLessThanOrEqual(GAME_COURTYARD_GROUND_LIMITS.vertices.low);
    expect(a.diagnostics.estimatedPeakBytes).toBeLessThanOrEqual(GAME_COURTYARD_GROUND_LIMITS.bytes);
  });
  it('uses restrained half-metre paving, finite anti-aliased joints and no clock',()=>{
    const a=sampleGameCourtyardFloor([.25,.25],.001),joint=sampleGameCourtyardFloor([0,.25],.001),far=sampleGameCourtyardFloor([0,.25],1);
    expect(a.paverMeters).toBe(.5);expect(a.color[0]-joint.color[0]).toBeGreaterThan(.005);expect(a.color[0]-joint.color[0]).toBeLessThan(.045);
    expect(Math.abs(far.color[0]-sampleGameCourtyardFloor([.25,.25],1).color[0])).toBeLessThan(.015);
    for(const p of [[-1000,2000],[0,0],[.5,.5]] as const)expect(sampleGameCourtyardFloor(p,.1).color.every(Number.isFinite)).toBe(true);
    const g=new GameCourtyardGround();g.update(options());const shader={vertexShader:ShaderLib.standard.vertexShader,fragmentShader:ShaderLib.standard.fragmentShader,uniforms:{}};
    groundMesh(g).material.onBeforeCompile(shader,{} as never);expect(shader.fragmentShader).toContain('0.5');expect(shader.fragmentShader).toContain('fwidth');expect(shader.fragmentShader).not.toContain('uniform float time');g.dispose();
  });
});
