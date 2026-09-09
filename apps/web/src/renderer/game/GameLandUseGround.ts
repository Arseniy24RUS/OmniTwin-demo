import {MercatorCoordinate} from 'maplibre-gl';
import {BufferAttribute,BufferGeometry,Group,Mesh,Vector2,type MeshStandardMaterial} from 'three';
import {localToMercatorMatrix,type GameOrigin} from './cameraAdapter';
import type {GameVegetationFeature,GameVegetationOptions,GameVegetationRoad} from './GameVegetation';
import {triangulateSourceWater} from './waterTriangulation';
import {resolveGameRoadWidth} from './gameRoadWidth';
import {createGameLandUseGroundMaterial,updateGameLandUseGroundMaterial} from './gameLandUseGroundMaterial';
export interface GameLandUseGroundOptions extends GameVegetationOptions {waterFeatures:readonly GameVegetationFeature[]}
/** Native map footways can be absent from the verified movement road subset.
 * These exact source lines are clearance masks only; they never create routes. */
export function sourceGroundRoadMasks(features:readonly GameVegetationFeature[]):GameVegetationRoad[]{
 if(features.length>GAME_LAND_USE_GROUND_LIMITS.features*4)throw Error('Native road mask feature budget exceeded');let vertices=0;
 return features.filter(f=>f.sourceLayer==='transportation'&&(f.geometry?.type==='LineString'||f.geometry?.type==='MultiLineString')).flatMap(f=>{
  const g=f.geometry!,raw=g.type==='LineString'?[g.coordinates]:g.coordinates;if(!Array.isArray(raw))throw Error('Native road mask lines invalid');
  const lines=raw.filter(line=>{if(!Array.isArray(line))throw Error('Native road mask line invalid');vertices+=line.length;if(vertices>GAME_LAND_USE_GROUND_LIMITS.sourceVertices)throw Error('Native road mask vertex budget exceeded');
   for(const p of line)if(!Array.isArray(p)||p.length<2||!Number.isFinite(p[0])||!Number.isFinite(p[1])||Math.abs(p[0])>180||Math.abs(p[1])>=85.051129)throw Error('Native road mask coordinate invalid');
   // A clipped MVT component can have one point (actual LEN source891837810).
   // It covers no pixels. Drop only exact zero-length parts, not real segments.
   return line.length>1&&line.some(p=>p[0]!==line[0][0]||p[1]!==line[0][1]);});
  if(!lines.length)return[];const geometry=lines.length===raw.length?g:{type:'MultiLineString',coordinates:lines};
  return[{geometry,properties:f.properties,className:String(f.properties?.class==='path'?f.properties?.subclass??'path':f.properties?.class??'road')}];
 });
}
export const GAME_LAND_USE_GROUND_LIMITS=Object.freeze({features:4096,buildings:12000,roads:8192,sourceVertices:250000,projectedVertices:32768,ringVertices:4096,rings:64,maskPieces:8192,indexEntries:65536,operations:4_000_000,
 vertices:{low:6144,medium:49152,high:49152},bytes:8*1024*1024});
type P=[number,number];type Bounds=readonly[number,number,number,number];
const TOP=.006,EPS=1e-8,CELL=64,SUPPORTED=new Set(['education','residential','industrial','garages','commercial','retail','hospital','university']);
const GREEN=new Set(['grass','park','garden','wood','forest']);
const fail=(message:string):never=>{throw Error(`Landuse ground ${message}`);};
const cross=(a:P,b:P,c:P)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
function area(p:readonly P[]){let n=0;for(let i=0;i<p.length;i++){const a=p[i]!,b=p[(i+1)%p.length]!;n+=a[0]*b[1]-b[0]*a[1];}return n/2;}
function clean(p:P[]){const out=p.filter((v,i)=>Math.hypot(v[0]-p[(i+1)%p.length]![0],v[1]-p[(i+1)%p.length]![1])>EPS);if(out.length<3||Math.abs(area(out))<EPS)return [];return area(out)<0?out.reverse():out;}
function half(p:P[],a:P,b:P,inside:boolean){const out:P[]=[],sign=inside?1:-1;for(let i=0;i<p.length;i++){const u=p[i]!,v=p[(i+1)%p.length]!,du=cross(a,b,u),dv=cross(a,b,v),iu=du*sign>=0,iv=dv*sign>=0;if(iu)out.push(u);if(iu!==iv){const t=du/(du-dv);out.push([u[0]+(v[0]-u[0])*t,u[1]+(v[1]-u[1])*t]);}}return clean(out);}
function subtract(subject:P[],mask:P[]){let inside=subject;const out:P[][]=[];for(let i=0;i<mask.length&&inside.length;i++){const a=mask[i]!,b=mask[(i+1)%mask.length]!,piece=half(inside,a,b,false);if(piece.length)out.push(piece);inside=half(inside,a,b,true);}return out;}
function extent(p:readonly P[]):Bounds{let w=Infinity,s=Infinity,e=-Infinity,n=-Infinity;for(const[x,z]of p){w=Math.min(w,x);s=Math.min(s,z);e=Math.max(e,x);n=Math.max(n,z);}return[w,s,e,n];}
const overlap=(a:Bounds,b:Bounds)=>a[0]<=b[2]&&a[2]>=b[0]&&a[1]<=b[3]&&a[3]>=b[1];
const validBounds=(b:unknown):b is Bounds=>Array.isArray(b)&&b.length===4&&b.every(Number.isFinite)&&b[0]<b[2]&&b[1]<b[3];
function key(p:readonly P[]){let first=0;for(let i=1;i<p.length;i++)if(p[i]![0]<p[first]![0]||p[i]![0]===p[first]![0]&&p[i]![1]<p[first]![1])first=i;return JSON.stringify(Array.from({length:p.length},(_,i)=>p[(first+i)%p.length]));}
function capsule(a:P,b:P,r:number){const angle=Math.atan2(b[1]-a[1],b[0]-a[0]),out:P[]=[];for(let i=0;i<=6;i++){const t=angle-Math.PI/2+i*Math.PI/6;out.push([b[0]+Math.cos(t)*r,b[1]+Math.sin(t)*r]);}for(let i=0;i<=6;i++){const t=angle+Math.PI/2+i*Math.PI/6;out.push([a[0]+Math.cos(t)*r,a[1]+Math.sin(t)*r]);}return clean(out);}
/** Source landuse is an area identity, not a surveyed pavement classification.
 * One neutral visual material uses only these polygons. Unknown land is absent.
 * Exact source water/green and complete building outers (including their yards),
 * plus documented metric road corridors, are subtracted before buffer creation. */
export function prepareGameLandUseGround(features:readonly GameVegetationFeature[],options:GameLandUseGroundOptions,previousRetainedBytes=0){
 const L=GAME_LAND_USE_GROUND_LIMITS,tier=options.qualityTier??'medium',snapshot=options.buildings;localToMercatorMatrix(options.origin);
 if(!snapshot||snapshot.coverage!=='complete_viewport'||snapshot.invalidBuildings||snapshot.omittedBuildings||!validBounds(snapshot.coverageBounds)||!validBounds(options.bounds))return fail('requires complete verified source coverage');
 if(!Object.hasOwn(L.vertices,tier)||!Array.isArray(features)||features.length>L.features||!Array.isArray(options.waterFeatures)||options.waterFeatures.length>L.features||!Array.isArray(options.roads)||options.roads.length>L.roads||snapshot.data.features.length>L.buildings||!Number.isFinite(previousRetainedBytes)||previousRetainedBytes<0||previousRetainedBytes>L.bytes)return fail('admission invalid');
 const diagnostics={sourceAreas:0,sourceClasses:[] as string[],ignoredFeatures:0,duplicates:0,sourceVertices:0,projectedVertices:0,maskPieces:0,indexEntries:0,operations:0,vertices:0,triangles:0,truncated:false,estimatedPeakBytes:0};
 const spend=(n=1)=>{diagnostics.operations+=n;if(diagnostics.operations>L.operations)return fail('topology work budget exceeded');};
 const anchor=MercatorCoordinate.fromLngLat([options.origin.longitude,options.origin.latitude]),meter=anchor.meterInMercatorCoordinateUnits();
 const local=(v:unknown):P=>{if(!Array.isArray(v)||v.length<2||!Number.isFinite(v[0])||!Number.isFinite(v[1])||Math.abs(v[0])>180||Math.abs(v[1])>=85.051129)return fail('source coordinate invalid');const q=MercatorCoordinate.fromLngLat([v[0],v[1]]);return[(q.x-anchor.x)/meter,(q.y-anchor.y)/meter];};
 const a=local([Math.max(options.bounds[0],snapshot.coverageBounds[0]),Math.min(options.bounds[3],snapshot.coverageBounds[3])]),b=local([Math.min(options.bounds[2],snapshot.coverageBounds[2]),Math.max(options.bounds[1],snapshot.coverageBounds[1])]);
 const bounds:Bounds=[a[0],a[1],b[0],b[1]];if(!validBounds(bounds))return fail('source and view coverage do not overlap');
 const rectangle:P[]=[[bounds[0],bounds[1]],[bounds[2],bounds[1]],[bounds[2],bounds[3]],[bounds[0],bounds[3]]];
 const clip=(input:P[])=>{let p=clean(input);for(let i=0;i<4&&p.length;i++)p=half(p,rectangle[i]!,rectangle[(i+1)%4]!,true);return p;};
 const masks:{points:P[];bounds:Bounds}[]=[],sources:P[][]=[],seenMasks=new Set<string>(),seenSources=new Set<string>();let keyBytes=0,clippedVertices=0;
 const memory=(outputVertices=0)=>previousRetainedBytes+diagnostics.projectedVertices*112+clippedVertices*96+keyBytes+diagnostics.indexEntries*24+masks.length*160+sources.length*128+outputVertices*24*6;
 const checkMemory=(vertices=0)=>{diagnostics.estimatedPeakBytes=Math.max(diagnostics.estimatedPeakBytes,memory(vertices));if(diagnostics.estimatedPeakBytes>L.bytes)return fail('CPU/GPU preparation memory budget exceeded');};
 const append=(points:P[],mask:boolean)=>{const p=clip(points);if(!p.length)return;
  const retain=(piece:P[])=>{if(!piece.length)return;const k=key(piece),seen=mask?seenMasks:seenSources;if(seen.has(k)){diagnostics.duplicates++;return;}seen.add(k);keyBytes+=k.length*2;
   clippedVertices+=piece.length;if(mask){masks.push({points:piece,bounds:extent(piece)});if(masks.length>L.maskPieces)return fail('mask piece budget exceeded');}else sources.push(piece);checkMemory();};
  if(mask){retain(p);return;}
  // Spatially divide the same source triangles before subtraction. A 400m
  // parcel must not repeatedly test every fragment against all distant roads.
  // The adjacent opaque pieces use one world-space shader and cover the exact
  // original polygon; this grid is not a drawn texture or invented parcel.
  const box=extent(p);for(let z=Math.floor(box[1]/CELL);z<=Math.floor(box[3]/CELL);z++)for(let x=Math.floor(box[0]/CELL);x<=Math.floor(box[2]/CELL);x++){
   spend(p.length*4);const cell:P[]=[[x*CELL,z*CELL],[(x+1)*CELL,z*CELL],[(x+1)*CELL,(z+1)*CELL],[x*CELL,(z+1)*CELL]];let q=p;for(let i=0;i<4&&q.length;i++)q=half(q,cell[i]!,cell[(i+1)%4]!,true);retain(q);
  }
 };
 const triangulate=(geometry:unknown,mask:boolean,outerOnly=false)=>{
  const g=geometry as {type?:string;coordinates?:unknown},polygons=g?.type==='Polygon'?[g.coordinates]:g?.type==='MultiPolygon'&&Array.isArray(g.coordinates)?g.coordinates:null;if(!polygons)return fail('declared polygon invalid');
  for(const raw of polygons){if(!Array.isArray(raw)||!raw.length||raw.length>L.rings)return fail('source rings invalid');
   const rings:P[][]=[];let temporaryVertices=0;for(const r of raw){if(!Array.isArray(r)||r.length<3||r.length>L.ringVertices)return fail('source ring invalid');diagnostics.sourceVertices+=r.length;if(diagnostics.sourceVertices>L.sourceVertices)return fail('source vertex budget exceeded');temporaryVertices+=r.length;if(memory()+temporaryVertices*112>L.bytes)return fail('transient source memory budget exceeded');
    const points:P[]=[];for(const v of r){const q=local(v);if(!points.length||q[0]!==points.at(-1)![0]||q[1]!==points.at(-1)![1])points.push(q);}if(points.length>1&&points[0]![0]===points.at(-1)![0]&&points[0]![1]===points.at(-1)![1])points.pop();rings.push(points);}
   if(new Set(rings[0]!.map(p=>p.join(','))).size<3){if(rings.slice(1).some(r=>new Set(r.map(p=>p.join(','))).size>=3))return fail('collapsed outer with actual holes');continue;}
   if(!overlap(extent(rings[0]!),bounds))continue;const actual=(outerOnly?rings.slice(0,1):rings).filter(r=>new Set(r.map(p=>p.join(','))).size>=3);
   diagnostics.projectedVertices+=actual.reduce((n,r)=>n+r.length,0);if(diagnostics.projectedVertices>L.projectedVertices)return fail('projected vertex budget exceeded');checkMemory();
   const budget={remaining:L.operations-diagnostics.operations},result=triangulateSourceWater(actual.map(r=>r.map(p=>new Vector2(...p))),budget);spend(L.operations-diagnostics.operations-budget.remaining);if(!result)return fail('source holes or triangulation invalid');
   for(const triangle of result.triangles){spend();append(triangle.map(i=>result.points[i]!.toArray() as P),mask);}
  }
 };
 for(const f of features){const p=f.properties??{},className=String(p.class??'').toLowerCase();if(f.sourceLayer==='landuse'&&SUPPORTED.has(className)){diagnostics.sourceAreas++;diagnostics.sourceClasses.push(className);triangulate(f.geometry,false);}
  else if(['landuse','landcover','park'].includes(f.sourceLayer??'')&&['class','subclass','natural','leisure'].some(k=>GREEN.has(String(p[k]??'').toLowerCase())))triangulate(f.geometry,true);else diagnostics.ignoredFeatures++;}
 for(const f of options.waterFeatures)triangulate(f.geometry,true);
 for(const f of snapshot.data.features){const id=String(f.properties?.canonical_id??f.id??'');if(!id||!snapshot.canonicalIds.has(id))return fail('canonical mask identity unverified');triangulate(f.geometry,true,true);}
 for(const road of options.roads){const g=(road.geometry??{type:'LineString',coordinates:road.coordinates}) as {type?:string;coordinates?:unknown};const lines=g.type==='LineString'?[g.coordinates]:g.type==='MultiLineString'&&Array.isArray(g.coordinates)?g.coordinates:null;if(!lines)return fail('road mask geometry missing');
  const radius=resolveGameRoadWidth(road).width/2+.16;for(const line of lines){if(!Array.isArray(line)||line.length<2)return fail('road mask geometry invalid');diagnostics.sourceVertices+=line.length;if(diagnostics.sourceVertices>L.sourceVertices)return fail('source vertex budget exceeded');const p=line.map(local);for(let i=1;i<p.length;i++){spend();if(Math.hypot(p[i]![0]-p[i-1]![0],p[i]![1]-p[i-1]![1])>.01)append(capsule(p[i-1]!,p[i]!,radius),true);}}}
 const grid=new Map<string,number[]>();const buckets=(box:Bounds,fn:(key:string)=>void)=>{for(let z=Math.floor(box[1]/CELL);z<=Math.floor(box[3]/CELL);z++)for(let x=Math.floor(box[0]/CELL);x<=Math.floor(box[2]/CELL);x++){spend();fn(`${x}:${z}`);}};
 // Wide source/road masks run first. Cutting a narrow duplicate corridor first
 // makes unnecessary slivers that its wider verified counterpart later erases.
 masks.sort((a,b)=>Math.abs(area(b.points))-Math.abs(area(a.points))||key(a.points).localeCompare(key(b.points)));for(let i=0;i<masks.length;i++)buckets(masks[i]!.bounds,k=>{const list=grid.get(k)??[];list.push(i);grid.set(k,list);diagnostics.indexEntries++;if(diagnostics.indexEntries>L.indexEntries)return fail('mask index budget exceeded');});checkMemory();
 const output:number[]=[];sources.sort((a,b)=>key(a).localeCompare(key(b)));
 for(const source of sources){let pieces=[source];const candidates=new Set<number>(),box=extent(source);buckets(box,k=>{for(const i of grid.get(k)??[])candidates.add(i);});
  for(const i of [...candidates].sort((a,b)=>a-b)){const mask=masks[i]!;if(!overlap(box,mask.bounds))continue;const next:P[][]=[];let transientVertices=pieces.reduce((n,p)=>n+p.length,0);for(const piece of pieces){spend(piece.length*mask.points.length);const fragments=overlap(extent(piece),mask.bounds)?subtract(piece,mask.points):[piece];transientVertices+=fragments.reduce((n,p)=>n+p.length,0);if(memory(output.length/3)+transientVertices*96>L.bytes)return fail('mask fragmentation memory budget exceeded');next.push(...fragments);}pieces=next;if(pieces.length>L.vertices[tier])return fail('mask fragmentation budget exceeded');if(!pieces.length)break;}
  // The native map remains underneath. Never publish a partial polygon: a
  // budget rejection retains the previous complete generation and is explicit.
  for(const p of pieces){const count=(p.length-2)*3;if(output.length/3+count>L.vertices[tier])return fail('complete generation vertex budget exceeded');checkMemory(output.length/3+count);for(let i=1;i<p.length-1;i++)for(const v of[p[0]!,p[i+1]!,p[i]!])output.push(v[0],TOP-(options.origin.altitude??0),v[1]);}
 }
 const positions=new Float32Array(output),normals=new Float32Array(output.length);for(let i=1;i<normals.length;i+=3)normals[i]=1;
 Object.assign(diagnostics,{sourceClasses:[...new Set(diagnostics.sourceClasses)].sort(),maskPieces:masks.length,vertices:positions.length/3,triangles:positions.length/9});checkMemory(diagnostics.vertices);
 return{positions,normals,geometryBytes:positions.byteLength+normals.byteLength,diagnostics};
}
function equal(a:ArrayLike<number>,b:ArrayLike<number>){if(a.length!==b.length)return false;for(let i=0;i<a.length;i++)if(a[i]!==b[i])return false;return true;}
export class GameLandUseGround{
 readonly object=new Group();readonly telemetry={state:'empty' as 'empty'|'ready'|'loading_retained'|'error_retained'|'disposed',representation:'visual_synthesis' as const,surfaceClassification:'unsurveyed_neutral_landuse_ground' as const,
  sourceAreas:0,sourceClasses:[] as string[],ignoredFeatures:0,duplicates:0,sourceVertices:0,projectedVertices:0,maskPieces:0,indexEntries:0,operations:0,vertices:0,triangles:0,truncated:false,estimatedPeakBytes:0,geometryBytes:0,retainedBytes:0,geometryUpdates:0,draws:0,lastError:null as string|null};
 private mesh:Mesh<BufferGeometry,MeshStandardMaterial>|null=null;private origin:GameOrigin|null=null;private disposed=false;
 constructor(){this.object.name='source-class-neutral-ground';this.object.userData.provenance='visual_synthesis';this.object.matrixAutoUpdate=false;}
 private retain(origin:GameOrigin){if(this.origin)try{this.object.matrix.copy(localToMercatorMatrix(origin).invert().multiply(localToMercatorMatrix(this.origin)));this.object.matrixWorldNeedsUpdate=true;}catch{}}
 update(features:readonly GameVegetationFeature[],options:GameLandUseGroundOptions){if(this.disposed)return this.telemetry;if(options.loading){this.telemetry.state='loading_retained';this.retain(options.origin);return this.telemetry;}
  try{const r=prepareGameLandUseGround(features,options,this.telemetry.retainedBytes),old=this.mesh?.geometry;if(!old||!equal(old.getAttribute('position').array,r.positions)){const geometry=new BufferGeometry();geometry.setAttribute('position',new BufferAttribute(r.positions,3));geometry.setAttribute('normal',new BufferAttribute(r.normals,3));if(r.positions.length){geometry.computeBoundingBox();geometry.computeBoundingSphere();}
    if(this.mesh){this.mesh.geometry=geometry;old?.dispose();}else{this.mesh=new Mesh(geometry,createGameLandUseGroundMaterial());this.mesh.name='source-class-neutral-ground';this.mesh.receiveShadow=true;this.mesh.userData.provenance='visual_synthesis';this.mesh.userData.pickable=false;this.mesh.raycast=()=>{};this.object.add(this.mesh);}this.telemetry.geometryUpdates++;}
   updateGameLandUseGroundMaterial(this.mesh!.material,options.origin,options.qualityTier??'medium');this.mesh!.visible=r.positions.length>0;this.origin={...options.origin};this.object.matrix.identity();this.object.matrixWorldNeedsUpdate=true;
   Object.assign(this.object.userData,{sourceId:options.sourceId??null,datasetVersion:options.datasetVersion??null});Object.assign(this.telemetry,r.diagnostics,{state:'ready',geometryBytes:r.geometryBytes,retainedBytes:r.geometryBytes*2,draws:r.positions.length?1:0,lastError:null});
  }catch(e){this.telemetry.state='error_retained';this.telemetry.lastError=e instanceof Error?e.message.slice(0,180):'Ground preparation failed';this.retain(options.origin);}return this.telemetry;
 }
 dispose(){if(this.disposed)return;this.disposed=true;this.mesh?.geometry.dispose();this.mesh?.material.dispose();this.mesh=null;this.origin=null;this.object.clear();Object.assign(this.telemetry,{state:'disposed',vertices:0,triangles:0,draws:0,geometryBytes:0,retainedBytes:0,estimatedPeakBytes:0});}
}
