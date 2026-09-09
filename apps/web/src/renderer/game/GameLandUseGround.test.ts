import {describe,it,expect,vi} from 'vitest';
import {MercatorCoordinate} from 'maplibre-gl';
import {Mesh,Vector3,ShaderLib,type BufferGeometry,type MeshStandardMaterial} from 'three';
import type {VerifiedCityBuildingSnapshot} from '../verifiedCityBuildingTypes';
import {localToMercatorMatrix} from './cameraAdapter';
import {GameLandUseGround,prepareGameLandUseGround,GAME_LAND_USE_GROUND_LIMITS,sourceGroundRoadMasks} from './GameLandUseGround';
import {sampleGameLandUseGround} from './gameLandUseGroundMaterial';
import type {GameVegetationFeature} from './GameVegetation';
import actualEducation from './fixtures/kal-education-landuse.json';
import actualNativeRoad from './fixtures/len-collapsed-native-road.json';
const origin={longitude:61.39759185,latitude:55.1881126},matrix=localToMercatorMatrix(origin);
function geo(p:readonly number[]){const q=new Vector3(p[0],0,p[1]).applyMatrix4(matrix),ll=new MercatorCoordinate(q.x,q.y).toLngLat();return[ll.lng,ll.lat] as [number,number];}
const ring=(x=0,z=0,n=100)=>[[x,z],[x+n,z],[x+n,z+n],[x,z+n],[x,z]];
function area(rings:number[][][]=[ring()],className='education',sourceLayer='landuse'):GameVegetationFeature{return{id:'test-landuse',sourceLayer,properties:{class:className},geometry:{type:'Polygon',coordinates:rings.map(r=>r.map(geo))}};}
function options(){const a=geo([-10,-10]),b=geo([110,110]),bounds=[a[0],b[1],b[0],a[1]] as const;
 const buildings:VerifiedCityBuildingSnapshot={signature:'verified',datasetVersion:'city-v2',coverage:'complete_viewport',coverageBounds:bounds,canonicalIds:new Set(),cells:['source'],invalidBuildings:0,omittedBuildings:0,vertexCount:0,data:{type:'FeatureCollection',features:[]}};
 return{origin,bounds,buildings,roads:[],waterFeatures:[] as GameVegetationFeature[],qualityTier:'high' as const};}
function triangles(result:ReturnType<typeof prepareGameLandUseGround>){const out:number[][][]=[];for(let i=0;i<result.positions.length;i+=9)out.push([0,3,6].map(k=>[result.positions[i+k]!,result.positions[i+k+1]!,result.positions[i+k+2]!]));return out;}
function mesh(g:GameLandUseGround){return g.object.children[0] as Mesh<BufferGeometry,MeshStandardMaterial>;}
describe('source-class neutral ground',()=>{
 it('triangulates the actual KAL education source fragments without modifying source records',()=>{
  const input=actualEducation.features as GameVegetationFeature[],copy=JSON.stringify(input),r=prepareGameLandUseGround(input,options());expect(r.diagnostics.sourceClasses).toEqual(['education']);expect(r.positions.length).toBeGreaterThan(0);expect(JSON.stringify(input)).toBe(copy);
 });
 it('uses only verified landuse education/residential/industrial/garages geometry and preserves concavity and real holes',()=>{
  const input=[area([[[0,0],[100,0],[100,40],[40,40],[40,100],[0,100],[0,0]],ring(10,10,10)]),area([ring(200)],'neighbourhood'),area([ring(200)],'unknown')],result=prepareGameLandUseGround(input,options());
  let sum=0;for(const t of triangles(result)){const[a,b,c]=t;sum+=Math.abs((b![0]!-a![0]!)*(c![2]!-a![2]!)-(c![0]!-a![0]!)*(b![2]!-a![2]!))/2;
   const x=t.reduce((s,p)=>s+p[0]!/3,0),z=t.reduce((s,p)=>s+p[2]!/3,0);expect(x>40&&z>40).toBe(false);expect(x>10&&x<20&&z>10&&z<20).toBe(false);expect(t.every(p=>p[1]!<.01)).toBe(true);}
  expect(sum).toBeCloseTo(6300,1);expect(result.diagnostics.sourceClasses).toEqual(['education']);expect(result.diagnostics.ignoredFeatures).toBe(2);
  for(const name of ['residential','industrial','garages'])expect(prepareGameLandUseGround([area([ring()],name)],options()).positions.length).toBeGreaterThan(0);
  expect(prepareGameLandUseGround([area([ring()],'education','poi')],options()).positions.length).toBe(0);
 });
 it('subtracts source water, explicit green, complete building outer/courtyard and metric CityRoadV2 corridors',()=>{
  const opts=options(),building={type:'Feature' as const,id:'b',properties:{canonical_id:'b'},geometry:{type:'Polygon' as const,coordinates:[ring(5,5,20).map(geo),ring(10,10,10).map(geo)]}};
  opts.buildings.data.features=[building];opts.buildings.canonicalIds=new Set(['b']);opts.waterFeatures=[area([ring(60,0,40)],'lake','water')];
  const road={coordinates:[geo([0,50]),geo([100,50])],widthM:6,className:'service'};
  const result=prepareGameLandUseGround([area(),area([ring(5,70,20)],'grass','landcover')],{...opts,roads:[road]});
  expect(result.diagnostics.maskPieces).toBeGreaterThan(0);
  for(const t of triangles(result)){const x=t.reduce((s,p)=>s+p[0]!/3,0),z=t.reduce((s,p)=>s+p[2]!/3,0);
   expect(x>5&&x<25&&z>5&&z<25).toBe(false);expect(x>60&&z<40).toBe(false);expect(x>5&&x<25&&z>70&&z<90).toBe(false);expect(Math.abs(z-50)).toBeGreaterThanOrEqual(3.15);}
  expect(JSON.stringify(building.geometry.coordinates)).toContain(JSON.stringify(geo([10,10])));
 });
 it('retains native source footways even when the verified movement road subset has no such road',()=>{
  const geometry={type:'LineString',coordinates:[geo([0,50]),geo([100,50])]},features=[{id:17,sourceLayer:'transportation',properties:{class:'path',subclass:'footway',width:2},geometry}],before=JSON.stringify(features);
  const roads=sourceGroundRoadMasks(features),r=prepareGameLandUseGround([area()],{...options(),roads});expect(roads[0]!.geometry).toBe(geometry);expect(roads[0]!.className).toBe('footway');expect(JSON.stringify(features)).toBe(before);
  for(const t of triangles(r))expect(Math.abs(t.reduce((s,p)=>s+p[2]!/3,0)-50)).toBeGreaterThanOrEqual(1.15);
  expect(sourceGroundRoadMasks([{...features[0]!,sourceLayer:'poi'}])).toEqual([]);
 });
 it('omits the actual zero-length native tile component without discarding its real road segments',()=>{
  const copy=JSON.stringify(actualNativeRoad),roads=sourceGroundRoadMasks([actualNativeRoad as GameVegetationFeature]);
  const g=roads[0]!.geometry as {type:string;coordinates:number[][][]};expect(g.type).toBe('MultiLineString');expect(g.coordinates.every(line=>line.length>=2)).toBe(true);
  expect(g.coordinates.length).toBe(38);expect(g.coordinates).toContain(actualNativeRoad.geometry.coordinates[3]);expect(JSON.stringify(actualNativeRoad)).toBe(copy);
 });
 it('clips to proven source coverage, deduplicates and retains prior geometry on incomplete or malformed masks',()=>{
  const g=new GameLandUseGround(),opts=options(),input=[area(),area()];g.update(input,opts);expect(g.telemetry.state).toBe('ready');expect(g.telemetry.duplicates).toBeGreaterThan(0);const geometry=mesh(g).geometry;
  g.update([...input].reverse(),opts);expect(mesh(g).geometry).toBe(geometry);expect(g.telemetry.geometryUpdates).toBe(1);
  g.update([],{...opts,loading:true});expect(mesh(g).geometry).toBe(geometry);
  g.update(input,{...opts,roads:[{className:'service'}]});expect(g.telemetry.state).toBe('error_retained');expect(mesh(g).geometry).toBe(geometry);
  const other={longitude:61.4,latitude:55.19};g.update(input,{...opts,origin:other,buildings:null});expect(g.telemetry.state).toBe('error_retained');
  const p=new Vector3().fromBufferAttribute(geometry.getAttribute('position'),0),a=p.clone().applyMatrix4(matrix),b=p.clone().applyMatrix4(g.object.matrix).applyMatrix4(localToMercatorMatrix(other));expect(a.distanceTo(b)).toBeLessThan(1e-12);g.dispose();
 });
 it('bounds allocations and owns one static opaque draw with idempotent disposal',()=>{
  const g=new GameLandUseGround(),opts=options();g.update([area()],opts);expect(g.telemetry.draws).toBe(1);expect(g.telemetry.estimatedPeakBytes).toBeLessThanOrEqual(GAME_LAND_USE_GROUND_LIMITS.bytes);
  expect(mesh(g).material.transparent).toBe(false);expect(mesh(g).receiveShadow).toBe(true);const geometry=mesh(g).geometry,gd=vi.spyOn(geometry,'dispose'),md=vi.spyOn(mesh(g).material,'dispose');
  g.update(Array.from({length:GAME_LAND_USE_GROUND_LIMITS.features+1},()=>area()),opts);expect(g.telemetry.state).toBe('error_retained');expect(mesh(g).geometry).toBe(geometry);
  g.dispose();g.dispose();expect(gd).toHaveBeenCalledTimes(1);expect(md).toHaveBeenCalledTimes(1);expect(g.telemetry.retainedBytes).toBe(0);
 });
 it('retains a whole previous generation rather than cutting an accepted source polygon at the output cap',()=>{
  const g=new GameLandUseGround(),opts={...options(),qualityTier:'low' as const};g.update([area()],opts);const prior=mesh(g).geometry;
  const many=Array.from({length:1200},(_,i)=>area([ring((i%40)*2,Math.floor(i/40)*2,1)]));g.update(many,opts);
  expect(g.telemetry.state).toBe('error_retained');expect(g.telemetry.lastError).toContain('vertex');expect(mesh(g).geometry).toBe(prior);g.dispose();
 });
 it('has quiet physically filtered variation without a texture asset, clock or large repeated grid',()=>{
  const samples=Array.from({length:40},(_,i)=>sampleGameLandUseGround([i*.79,i*.41],.05));expect(new Set(samples.map(s=>s.color[0].toFixed(5))).size).toBeGreaterThan(30);
  for(const p of [[.03,2.17],[64.81,5.3],[255.93,127.11]] as const){for(const footprint of [0,.03,.5,10]){const a=sampleGameLandUseGround(p,footprint),b=sampleGameLandUseGround([p[0]+256,p[1]],footprint);a.color.forEach((v,i)=>{expect(v).toBeGreaterThan(.15);expect(v).toBeLessThan(.5);expect(b.color[i]).toBeCloseTo(v,8);});expect(Math.hypot(...a.normal)).toBeCloseTo(1,8);expect(a.roughness).toBeGreaterThan(.85);}}
  const g=new GameLandUseGround();g.update([area()],options());const shader={vertexShader:ShaderLib.standard.vertexShader,fragmentShader:ShaderLib.standard.fragmentShader,uniforms:{}};mesh(g).material.onBeforeCompile(shader as never,{} as never);
  expect(shader.fragmentShader).toContain('dFdx(landUseSurface)');expect(shader.fragmentShader).not.toMatch(/uniform.*time/i);expect(mesh(g).material.map).toBeNull();g.dispose();
 });
});
