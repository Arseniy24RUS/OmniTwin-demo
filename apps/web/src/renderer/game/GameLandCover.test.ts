import {describe,it,expect,vi} from 'vitest';
import {MercatorCoordinate} from 'maplibre-gl';
import {Mesh,ShaderLib,Vector3,type BufferGeometry,type MeshStandardMaterial} from 'three';
import {GameLandCover,GAME_LAND_COVER_LIMITS,prepareGameLandCover} from './GameLandCover';
import {landCoverCoordinates,sampleGameLandCover,GAME_LAND_COVER_PERIOD_METERS} from './gameLandCoverMaterial';
import {localToMercatorMatrix} from './cameraAdapter';
import type {GameVegetationFeature} from './GameVegetation';
const origin={longitude:61.39466,latitude:55.1654},matrix=localToMercatorMatrix(origin);
function geo([x,z]:readonly number[]){const p=new Vector3(x,0,z).applyMatrix4(matrix),ll=new MercatorCoordinate(p.x,p.y).toLngLat();return [ll.lng,ll.lat];}
const ring=(x=0,z=0,n=100)=>[[x,z],[x+n,z],[x+n,z+n],[x,z+n],[x,z]];
function feature(rings:number[][][]= [ring()],properties:Record<string,unknown>={class:'park'}):GameVegetationFeature{return {sourceLayer:'landuse',properties,geometry:{type:'Polygon',coordinates:rings.map(r=>r.map(geo))}};}
function mesh(land:GameLandCover){return land.object.children[0] as Mesh<BufferGeometry,MeshStandardMaterial>;}
describe('source metric land cover',()=>{
  it('preserves exact source corners, concavity and holes with upward triangles below water and roads',()=>{
    const f=[feature([ring(),ring(30,30,40)]),feature([[[200,0],[300,0],[300,40],[240,40],[240,100],[200,100],[200,0]]])],copy=JSON.stringify(f),result=prepareGameLandCover(f,{origin});
    let area=0;for(let i=0;i<result.indices.length;i+=3){const pts=[0,1,2].map(k=>{const j=result.indices[i+k]!*3;expect(result.positions[j+1]).toBeCloseTo(.01,7);return[result.positions[j]!,result.positions[j+2]!];});
      const[a,b,c]=pts,cross=(b![0]!-a![0]!)*(c![1]!-a![1]!)-(b![1]!-a![1]!)*(c![0]!-a![0]!);expect(cross).toBeLessThan(0);area-=cross/2;
      const x=pts.reduce((s,p)=>s+p[0]!/3,0),z=pts.reduce((s,p)=>s+p[1]!/3,0);expect(x>30&&x<70&&z>30&&z<70).toBe(false);expect(x>240&&z>40).toBe(false);
    }
    expect(area).toBeCloseTo(14800,2);expect(JSON.stringify(f)).toBe(copy);
    const originalCorners=new Set([ring(),ring(30,30,40),[[200,0],[300,0],[300,40],[240,40],[240,100],[200,100]]].flat().map(p=>p.join(',')));
    for(let i=0;i<result.positions.length;i+=3)expect(originalCorners.has(`${Math.round(result.positions[i]!)},${Math.round(result.positions[i+2]!)}`)).toBe(true);
  });
  it('accepts only explicit supported source classes and deduplicates polygons independent of IDs/winding/input order',()=>{
    const a=feature(),rev=feature([ring().reverse()]),ignored=['residential','industrial','water','farmland','scrub'].map(c=>feature([ring(200)],{class:c}));
    const land=new GameLandCover();land.update([a,rev,...ignored],{origin});expect(land.telemetry.polygons).toBe(1);expect(land.telemetry.duplicates).toBe(1);
    const geometry=mesh(land).geometry;land.update([...ignored,rev,a],{origin});expect(mesh(land).geometry).toBe(geometry);expect(land.telemetry.geometryUpdates).toBe(1);
    expect(land.telemetry.draws).toBe(1);expect(mesh(land).receiveShadow).toBe(true);expect(mesh(land).material.transparent).toBe(false);land.dispose();
    const multi={...feature(),geometry:{type:'MultiPolygon',coordinates:[[ring().map(geo)],[ring(200).map(geo)]]}};
    expect(prepareGameLandCover([multi],{origin}).diagnostics.polygons).toBe(2);
    for(const name of ['grass','park','garden','wood','forest'])expect(prepareGameLandCover([feature([ring()],{class:name})],{origin}).diagnostics.polygons).toBe(1);
  });
  it('retains prior viable surfaces and world placement on loading, malformed holes, excessive rings and invalid quality',()=>{
    const land=new GameLandCover();land.update([feature()],{origin});const geometry=mesh(land).geometry,changedOrigin={longitude:61.4,latitude:55.17};
    land.update([],{origin:changedOrigin,loading:true});expect(land.telemetry.state).toBe('loading_retained');expect(mesh(land).geometry).toBe(geometry);
    const world=new Vector3().fromBufferAttribute(geometry.getAttribute('position'),0).applyMatrix4(land.object.matrix).applyMatrix4(localToMercatorMatrix(changedOrigin));
    const initial=new Vector3().fromBufferAttribute(geometry.getAttribute('position'),0).applyMatrix4(matrix);expect(world.distanceTo(initial)).toBeLessThan(1e-12);
    const invalidCoordinates={...feature(),geometry:{type:'Polygon',coordinates:[[[NaN,55],[61,55],[61,56]]]}};
    for(const features of [[feature([ring(),ring(300)])],[feature(Array.from({length:GAME_LAND_COVER_LIMITS.ringsPerPolygon+1},()=>ring()))],[invalidCoordinates]]){
      land.update(features,{origin:changedOrigin});expect(land.telemetry.state).toBe('error_retained');expect(mesh(land).geometry).toBe(geometry);
    }
    for(const qualityTier of ['invalid','constructor']){land.update([feature()],{origin,qualityTier:qualityTier as 'high'});expect(land.telemetry.state).toBe('error_retained');}land.dispose();
  });
  it('caps complete polygons and estimated CPU/GPU peak, reuses buffers and disposes exactly once',()=>{
    const land=new GameLandCover(),f=Array.from({length:GAME_LAND_COVER_LIMITS.polygons+4},(_,i)=>feature([ring(i*2,0,1)]));land.update(f,{origin,qualityTier:'low'});
    expect(land.telemetry.polygons).toBe(GAME_LAND_COVER_LIMITS.polygons);expect(land.telemetry.omittedPolygons).toBe(4);expect(land.telemetry.estimatedPeakBytes).toBeLessThanOrEqual(8*1024*1024);
    const gd=vi.spyOn(mesh(land).geometry,'dispose'),md=vi.spyOn(mesh(land).material,'dispose');land.dispose();land.dispose();expect(gd).toHaveBeenCalledTimes(1);expect(md).toHaveBeenCalledTimes(1);expect(land.telemetry.retainedBytes).toBe(0);
  });
  it('bounds complex source verification work and accounts for an older larger retained surface',()=>{
    const land=new GameLandCover();land.update([feature()],{origin});const geometry=mesh(land).geometry;
    const largeRing=Array.from({length:3072},(_,i)=>[100*Math.cos(i*Math.PI*2/3072),100*Math.sin(i*Math.PI*2/3072)]);
    land.update([feature([largeRing])],{origin,qualityTier:'high'});
    expect(land.telemetry.state).toBe('error_retained');expect(land.telemetry.lastError).toContain('work budget');expect(mesh(land).geometry).toBe(geometry);
    const empty=prepareGameLandCover([],{origin},2*1024*1024);expect(empty.diagnostics.estimatedPeakBytes).toBe(2*1024*1024);
    expect(()=>prepareGameLandCover([],{origin},NaN)).toThrow('memory accounting');land.dispose();
  });
  it('skips a truly collapsed MVT component without suppressing its valid neighbours',()=>{
    // Actual waterfront landcover fragment, source dataset 138afac3f0d74f256838eda3b7afd24259f640fac0dcd4a60ff49140a18f66a4.
    const collapsed:GameVegetationFeature={id:13721838612,sourceLayer:'landcover',properties:{class:'grass',subclass:'grass'},geometry:{type:'Polygon',coordinates:[[
      [61.39692306518555,55.17132848736057],[61.39692306518555,55.17132848736057],[61.39692306518555,55.17132848736057]]]}};
    const input=[feature(),collapsed],snapshot=JSON.stringify(input),land=new GameLandCover();land.update(input,{origin});
    expect(land.telemetry.state).toBe('ready');expect(land.telemetry.polygons).toBe(1);expect(land.telemetry.collapsedPolygons).toBe(1);expect(land.telemetry.collapsedRings).toBe(1);
    expect(JSON.stringify(input)).toBe(snapshot);land.dispose();
  });
  it('omits only zero-area collapsed holes and rejects a collapsed outer ring carrying real holes',()=>{
    const collapse=[[30,30],[30,30],[30,30]],land=new GameLandCover();land.update([feature([ring(),collapse,ring(50,50,.01)])],{origin});
    expect(land.telemetry.state).toBe('ready');expect(land.telemetry.collapsedRings).toBe(1);expect(land.telemetry.vertices).toBe(8,'the small real hole keeps all four corners');
    const geometry=mesh(land).geometry;land.update([feature([collapse,ring(50,50,1)])],{origin});expect(land.telemetry.state).toBe('error_retained');expect(mesh(land).geometry).toBe(geometry);land.dispose();
  });
  it('anchors physical texture scale to the world across rebasing and repeats color, normal and roughness seamlessly',()=>{
    const other={longitude:61.4,latitude:55.17},world=new Vector3(25,0,38).applyMatrix4(matrix),local=world.clone().applyMatrix4(localToMercatorMatrix(other).invert());
    const a=landCoverCoordinates([25,38],origin),b=landCoverCoordinates([local.x,local.z],other),period=GAME_LAND_COVER_PERIOD_METERS;
    for(let i=0;i<2;i++)expect((a[i]!-b[i]!)/period).toBeCloseTo(Math.round((a[i]!-b[i]!)/period),7);
    const base=landCoverCoordinates([0,0],origin),metre=landCoverCoordinates([1,0],origin);expect(metre[0]-base[0]).toBeCloseTo(1,9);
    const colors=[];for(const p of [[.011,4.18],[7.83,15.991],[255.999,37.005]]){const sample=sampleGameLandCover(p as[number,number]);for(const q of [[p[0]!+period,p[1]!],[p[0]!,p[1]!+period]]){
      const adjacent=sampleGameLandCover(q as[number,number]);sample.color.forEach((v,i)=>expect(adjacent.color[i]).toBeCloseTo(v,7));sample.normal.forEach((v,i)=>expect(adjacent.normal[i]).toBeCloseTo(v,7));expect(adjacent.roughness).toBeCloseTo(sample.roughness,7);
    }colors.push(sample.color[1]);expect(Math.hypot(...sample.normal)).toBeCloseTo(1,10);expect(sample.roughness).toBeGreaterThan(.85);}
    expect(Math.max(...colors)-Math.min(...colors)).toBeGreaterThan(.01);
  });
  it('patches the standard lit shader with analytic color, filtered micro normal and roughness without time/canvas/texture assets',()=>{
    const land=new GameLandCover();land.update([feature()],{origin,qualityTier:'high'});const material=mesh(land).material;
    const shader={vertexShader:ShaderLib.standard.vertexShader,fragmentShader:ShaderLib.standard.fragmentShader,uniforms:{}};
    material.onBeforeCompile(shader as never,{} as never);expect(shader.vertexShader).toContain('landSurface = position.xz');expect(shader.fragmentShader).toContain('landHeightGradient');
    expect(shader.fragmentShader).toContain('roughnessFactor');expect(shader.fragmentShader).toContain('dFdx(landSurface)');expect(shader.fragmentShader).toContain('#include <lights_fragment_begin>');expect(material.map).toBeNull();
    expect(Object.keys(shader.uniforms).sort()).toEqual(['landDetail','landOffset','landScale']);land.dispose();
  });
});
