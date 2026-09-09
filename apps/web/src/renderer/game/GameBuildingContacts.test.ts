import {describe,it,expect,vi} from 'vitest';
import {MercatorCoordinate} from 'maplibre-gl';
import {Vector3,Mesh,type InstancedBufferGeometry,type ShaderMaterial} from 'three';
import {localToMercatorMatrix} from './cameraAdapter';
import {GameBuildingContacts,prepareGameBuildingContacts,sampleGameBuildingContact,GAME_BUILDING_CONTACT_LIMITS} from './GameBuildingContacts';
import type {GameVegetationOptions} from './GameVegetation';
const origin={longitude:61.39466,latitude:55.1654},matrix=localToMercatorMatrix(origin);
function geo(x:number,z:number){const p=new Vector3(x,0,z).applyMatrix4(matrix),ll=new MercatorCoordinate(p.x,p.y).toLngLat();return[ll.lng,ll.lat];}
const ring=(x=0,z=0,n=20)=>[[x,z],[x+n,z],[x+n,z+n],[x,z+n],[x,z]];
function feature(id:string,rings:number[][][],base=0){return{type:'Feature' as const,id,properties:{canonical_id:id,render_height:8,min_height:base},geometry:{type:'Polygon' as const,coordinates:rings.map(r=>r.map(p=>geo(p[0]!,p[1]!)))}};}
function options(features=[feature('a',[ring(),ring(5,5,10)])]):GameVegetationOptions{const nw=geo(-10,-10),se=geo(80,80),bounds=[nw[0]!,se[1]!,se[0]!,nw[1]!] as const;return{origin,bounds,roads:[],qualityTier:'high',buildings:{datasetVersion:'source',signature:'a',canonicalIds:new Set(features.map(f=>f.id)),data:{type:'FeatureCollection',features},cells:['source'],coverage:'complete_viewport',coverageBounds:bounds,invalidBuildings:0,omittedBuildings:0,vertexCount:features.reduce((n,f)=>n+f.geometry.coordinates.flat().length,0)}};}
describe('source building contact lighting',()=>{
  it('gives the same bounded metric falloff at the outer wall and the actual courtyard-hole wall',()=>{
    const result=prepareGameBuildingContacts(options());expect(result.cells.length).toBeGreaterThan(0);
    for(const p of [[-.1,10],[5.1,10]] as const){const c=result.cells.find(c=>p[0]>=c.x&&p[0]<c.x+c.size&&p[1]>=c.z&&p[1]<c.z+c.size)!;expect(c).toBeDefined();expect(sampleGameBuildingContact(c,...p)).toBeGreaterThan(.12);}
    for(const p of [[-1.2,10],[10,10]] as const){const c=result.cells.find(c=>p[0]>=c.x&&p[0]<c.x+c.size&&p[1]>=c.z&&p[1]<c.z+c.size);expect(c?sampleGameBuildingContact(c,...p):0).toBe(0);}
    expect(result.diagnostics.estimatedPeakBytes).toBeLessThanOrEqual(GAME_BUILDING_CONTACT_LIMITS.bytes);
  });
  it('does not compound corners, concave edges or duplicate/adjacent source boundaries',()=>{
    const r=[[0,0],[20,0],[20,8],[8,8],[8,20],[0,20],[0,0]],opts=options([feature('a',[r]),feature('b',[ring(20,0,20)])]),result=prepareGameBuildingContacts(opts);
    for(let i=0;i<result.cells.length;i++)for(let j=i+1;j<result.cells.length;j++){const a=result.cells[i]!,b=result.cells[j]!;expect(Math.min(a.x+a.size,b.x+b.size)-Math.max(a.x,b.x)>1e-7&&Math.min(a.z+a.size,b.z+b.size)-Math.max(a.z,b.z)>1e-7).toBe(false);}
    const c=result.cells.find(c=>8.1>=c.x&&8.1<c.x+c.size&&8.1>=c.z&&8.1<c.z+c.size)!;expect(sampleGameBuildingContact(c,8.1,8.1)).toBeLessThanOrEqual(.18);
    const original=JSON.stringify(opts);prepareGameBuildingContacts(opts);expect(JSON.stringify(opts)).toBe(original);
    const neighbors=options([feature('left',[ring()]),feature('right',[ring(20,0,20)])]),first=prepareGameBuildingContacts(neighbors);neighbors.buildings!.data.features.reverse();
    expect(prepareGameBuildingContacts(neighbors).packed).toEqual(first.packed);
  });
  it('omits raised bases and never emits outside verified source coverage',()=>{
    expect(prepareGameBuildingContacts(options([feature('float',[ring()],2)])).cells.length).toBe(0);
    const opts=options();opts.buildings!.coverage='partial_viewport';expect(()=>prepareGameBuildingContacts(opts)).toThrow();
    const result=prepareGameBuildingContacts(options());for(const c of result.cells)expect(c.x>=-10.001&&c.z>=-10.001&&c.x+c.size<=80.001&&c.z+c.size<=80.001).toBe(true);
    expect(GAME_BUILDING_CONTACT_LIMITS.topMeters).toBeGreaterThan(.019);expect(GAME_BUILDING_CONTACT_LIMITS.topMeters).toBeLessThan(.025);
  });
  it('keeps a single static generation during repeated/loading inputs and disposes it once',()=>{
    const contact=new GameBuildingContacts(),opts=options();contact.update(opts);const mesh=contact.object.children[0] as Mesh<InstancedBufferGeometry,ShaderMaterial>,geometry=mesh.geometry,dispose=vi.spyOn(geometry,'dispose');
    expect(contact.telemetry.draws).toBe(1);expect(mesh.material.depthWrite).toBe(false);expect(mesh.material.depthTest).toBe(true);
    contact.update(opts);expect(contact.telemetry.geometryUpdates).toBe(1);contact.update({...opts,loading:true});expect(mesh.geometry).toBe(geometry);contact.update({...opts,buildings:null});expect(mesh.geometry).toBe(geometry);expect(contact.telemetry.state).toBe('error_retained');
    expect(mesh.material.fragmentShader).not.toContain('time');contact.dispose();contact.dispose();expect(dispose).toHaveBeenCalledTimes(1);
  });
  it('caps source-backed cells deterministically without exceeding old/new generation memory',()=>{
    const features=Array.from({length:130},(_,i)=>feature(`building-${i}`,[ring((i%10)*6,Math.floor(i/10)*6,4)])),opts={...options(features),qualityTier:'low' as const};
    const a=prepareGameBuildingContacts(opts);expect(a.diagnostics.truncated).toBe(true);expect(a.cells.length).toBeLessThanOrEqual(GAME_BUILDING_CONTACT_LIMITS.cells.low);
    opts.buildings!.data.features.reverse();const b=prepareGameBuildingContacts(opts,a.packed.byteLength*3);expect(b.packed).toEqual(a.packed);expect(b.diagnostics.estimatedPeakBytes).toBeLessThanOrEqual(GAME_BUILDING_CONTACT_LIMITS.bytes);
    const invalid=options();invalid.buildings!.data.features[0]!.geometry.coordinates[0]![1]![0]=NaN;expect(()=>prepareGameBuildingContacts(invalid)).toThrow();
  });
});
