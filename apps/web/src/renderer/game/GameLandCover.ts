import {MercatorCoordinate} from 'maplibre-gl';
import {BufferAttribute,BufferGeometry,Group,Mesh,Vector2,type MeshStandardMaterial} from 'three';
import {localToMercatorMatrix,type GameOrigin} from './cameraAdapter';
import type {GameVegetationFeature} from './GameVegetation';
import {triangulateSourceWater} from './waterTriangulation';
import {createGameLandCoverMaterial,updateGameLandCoverMaterial} from './gameLandCoverMaterial';
export interface GameLandCoverOptions{origin:GameOrigin;qualityTier?:'low'|'medium'|'high';loading?:boolean;bounds?:readonly [number,number,number,number];sourceId?:string;datasetVersion?:string}
export const GAME_LAND_COVER_LIMITS=Object.freeze({features:4096,inputVertices:32768,ringsPerPolygon:64,ringVertices:4096,polygons:256,
  vertices:{low:4096,medium:8192,high:16384},bytes:8*1024*1024,repairPairChecks:500000,boundaryChecks:8*1024*1024});
type Point=[number,number];
interface Polygon{key:string;rings:Point[][];vertices:number}
const fail=(text:string):never=>{throw Error(`Land cover ${text}`);};
const compare=(a:Point,b:Point)=>a[0]-b[0]||a[1]-b[1];
const same=(a:Point,b:Point)=>a[0]===b[0]&&a[1]===b[1];
function canonicalRing(value:unknown):Point[]|null{
  if(!Array.isArray(value)||value.length<3||value.length>GAME_LAND_COVER_LIMITS.ringVertices)return fail('ring invalid or oversized');const points:Point[]=[];
  for(const item of value){if(!Array.isArray(item)||item.length<2||!Number.isFinite(item[0])||!Number.isFinite(item[1])||Math.abs(item[0])>180||Math.abs(item[1])>=85.051129)return fail('source coordinate invalid');
    const p:Point=[item[0],item[1]];if(!points.length||!same(points.at(-1)!,p))points.push(p);}
  if(points.length>1&&same(points[0]!,points.at(-1)!))points.pop();
  // Exact repeated MVT coordinates can collapse a clipped component to a point
  // or segment. Such a ring has no filled area; no tolerance erases real holes.
  if(new Set(points.map(p=>`${p[0]},${p[1]}`)).size<3)return null;
  let first=0;for(let i=1;i<points.length;i++)if(compare(points[i]!,points[first]!)<0)first=i;
  const forward=Array.from({length:points.length},(_,i)=>points[(first+i)%points.length]!),reverse=Array.from({length:points.length},(_,i)=>points[(first-i+points.length)%points.length]!);
  for(let i=1;i<points.length;i++){const c=compare(forward[i]!,reverse[i]!);if(c)return c<0?forward:reverse;}return forward;
}
function classified(f:GameVegetationFeature){
  const p=f.properties;if(!p)return false;
  return ['class','subclass','landuse','landcover','leisure','natural','forest_class'].some(k=>typeof p[k]==='string'&&['grass','park','garden','wood','forest'].includes((p[k] as string).trim().toLowerCase()));
}
function boundsOf(ring:Point[]){let w=Infinity,s=Infinity,e=-Infinity,n=-Infinity;for(const[x,y]of ring){w=Math.min(w,x);s=Math.min(s,y);e=Math.max(e,x);n=Math.max(n,y);}return[w,s,e,n];}
function inRing(x:number,z:number,ring:readonly Vector2[]){let yes=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){const a=ring[i]!,b=ring[j]!;if((a.y>z)!==(b.y>z)&&x<(b.x-a.x)*(z-a.y)/(b.y-a.y)+a.x)yes=!yes;}return yes;}
/** Source-only geometry. No generated parcels, clipping rectangles or population data. */
export function prepareGameLandCover(features:readonly GameVegetationFeature[],options:GameLandCoverOptions,previousRetainedBytes=0){
  const L=GAME_LAND_COVER_LIMITS,tier=options.qualityTier??'medium';if(!Object.hasOwn(L.vertices,tier))return fail('quality tier invalid');localToMercatorMatrix(options.origin);
  if(!Array.isArray(features)||features.length>L.features)return fail('feature limit exceeded');
  const bounds=options.bounds;if(bounds&&(bounds.length!==4||!bounds.every(Number.isFinite)||bounds[0]>=bounds[2]||bounds[1]>=bounds[3]))return fail('coverage bounds invalid');
  if(!Number.isFinite(previousRetainedBytes)||previousRetainedBytes<0||previousRetainedBytes>L.bytes)return fail('previous memory accounting invalid');
  const diagnostics={polygons:0,duplicates:0,ignoredFeatures:0,omittedPolygons:0,collapsedPolygons:0,collapsedRings:0,sourceVertices:0,vertices:0,triangles:0,repairedPolygons:0,repairIntersections:0,boundaryChecks:0,estimatedPeakBytes:0};
  const unique=new Map<string,Polygon>();let keyBytes=0;
  for(const feature of features){
    if(!classified(feature)){diagnostics.ignoredFeatures++;continue;}
    const g=feature.geometry,candidates=g?.type==='Polygon'?[g.coordinates]:g?.type==='MultiPolygon'&&Array.isArray(g.coordinates)?g.coordinates:null;
    if(!candidates?.length||candidates.length>L.features)return fail('declared source polygon invalid');
    for(const candidate of candidates){
      if(!Array.isArray(candidate)||!candidate.length||candidate.length>L.ringsPerPolygon)return fail('polygon ring count invalid');
      for(const ring of candidate){if(!Array.isArray(ring))return fail('ring invalid');diagnostics.sourceVertices+=ring.length;if(diagnostics.sourceVertices>L.inputVertices)return fail('source vertex limit exceeded');}
      if(previousRetainedBytes+diagnostics.sourceVertices*128+keyBytes>L.bytes)return fail('source preparation memory budget exceeded');
      const sourceRings=candidate.map(canonicalRing);diagnostics.collapsedRings+=sourceRings.filter(ring=>ring===null).length;
      if(!sourceRings[0]){if(sourceRings.slice(1).some(Boolean))return fail('collapsed outer boundary has nonempty holes');diagnostics.collapsedPolygons++;continue;}
      const rings=sourceRings.filter((ring):ring is Point[]=>ring!==null);rings.splice(1,rings.length-1,...rings.slice(1).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))));
      const extent=boundsOf(rings[0]!);if(bounds&&(extent[0]!>bounds[2]||extent[2]!<bounds[0]||extent[1]!>bounds[3]||extent[3]!<bounds[1])){diagnostics.omittedPolygons++;continue;}
      const key=JSON.stringify(rings);if(unique.has(key)){diagnostics.duplicates++;continue;}keyBytes+=key.length*2;
      if(previousRetainedBytes+diagnostics.sourceVertices*128+keyBytes>L.bytes)return fail('source preparation memory budget exceeded');
      unique.set(key,{key,rings,vertices:rings.reduce((sum,ring)=>sum+ring.length,0)});
    }
  }
  const p=MercatorCoordinate.fromLngLat([options.origin.longitude,options.origin.latitude]),meter=p.meterInMercatorCoordinateUnits(),work={remaining:L.repairPairChecks};
  const prepared:NonNullable<ReturnType<typeof triangulateSourceWater>>[]=[];let totalVertices=0,totalIndices=0;
  for(const polygon of [...unique.values()].sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0)){
    if(prepared.length>=L.polygons||totalVertices+polygon.vertices>L.vertices[tier]){diagnostics.omittedPolygons++;continue;}
    const rings=polygon.rings.map(ring=>ring.map(([lon,lat])=>{const q=MercatorCoordinate.fromLngLat([lon,lat]);return new Vector2((q.x-p.x)/meter,(q.y-p.y)/meter);}));
    const result=triangulateSourceWater(rings,work);if(!result)return fail('source holes or triangulation invalid');
    // Area checks alone cannot guarantee a hole was not bridged incorrectly.
    diagnostics.boundaryChecks+=result.triangles.length*polygon.vertices;
    if(diagnostics.boundaryChecks>L.boundaryChecks)return fail('source boundary verification work budget exceeded');
    for(const triangle of result.triangles){const a=result.points[triangle[0]]!,b=result.points[triangle[1]]!,c=result.points[triangle[2]]!,x=(a.x+b.x+c.x)/3,z=(a.y+b.y+c.y)/3;
      if(!inRing(x,z,rings[0]!)||rings.slice(1).some(ring=>inRing(x,z,ring)))return fail('triangle outside source boundary');}
    if(totalVertices+result.points.length>L.vertices[tier]){diagnostics.omittedPolygons++;continue;}
    prepared.push(result);totalVertices+=result.points.length;totalIndices+=result.triangles.length*3;
    if(result.repairedIntersections){diagnostics.repairedPolygons++;diagnostics.repairIntersections+=result.repairedIntersections;}
  }
  const geometryBytes=totalVertices*24+totalIndices*4;
  // Reserve both previous/new CPU+GPU arrays plus conservative transient source,
  // projected point and triangle records. Caller-owned source objects are excluded.
  diagnostics.estimatedPeakBytes=geometryBytes*2+Math.max(geometryBytes*2,previousRetainedBytes)+diagnostics.sourceVertices*128+keyBytes+prepared.length*256;
  if(diagnostics.estimatedPeakBytes>L.bytes)return fail('CPU/GPU preparation memory budget exceeded');
  const positions=new Float32Array(totalVertices*3),normals=new Float32Array(totalVertices*3),indices=new Uint32Array(totalIndices);let vertex=0,index=0;
  for(const polygon of prepared){const offset=vertex;for(const point of polygon.points){positions.set([point.x,.01-(options.origin.altitude??0),point.y],vertex*3);normals[vertex*3+1]=1;vertex++;}
    for(const[a,b,c]of polygon.triangles){const p=polygon.points[a]!,q=polygon.points[b]!,r=polygon.points[c]!,positive=(q.x-p.x)*(r.y-p.y)-(q.y-p.y)*(r.x-p.x)>0;indices.set([offset+a,offset+(positive?c:b),offset+(positive?b:c)],index);index+=3;}}
  Object.assign(diagnostics,{polygons:prepared.length,vertices:totalVertices,triangles:totalIndices/3});return{positions,normals,indices,geometryBytes,diagnostics};
}
function equals(a:ArrayLike<number>,b:ArrayLike<number>){if(a.length!==b.length)return false;for(let i=0;i<a.length;i++)if(a[i]!==b[i])return false;return true;}
/** One opaque draw in the shared scene, with retained lit geometry and no RAF. */
export class GameLandCover{
  readonly object=new Group();readonly telemetry={representation:'source_landcover_visual_synthesis' as const,state:'empty' as 'empty'|'ready'|'loading_retained'|'error_retained'|'disposed',
    polygons:0,duplicates:0,ignoredFeatures:0,omittedPolygons:0,collapsedPolygons:0,collapsedRings:0,sourceVertices:0,vertices:0,triangles:0,repairedPolygons:0,repairIntersections:0,boundaryChecks:0,geometryUpdates:0,geometryBytes:0,retainedBytes:0,estimatedPeakBytes:0,draws:0,lastError:null as string|null};
  private mesh:Mesh<BufferGeometry,MeshStandardMaterial>|null=null;private origin:GameOrigin|null=null;private disposed=false;
  constructor(){this.object.name='source-metric-land-cover';this.object.userData.provenance='visual_synthesis';this.object.matrixAutoUpdate=false;}
  private retain(origin:GameOrigin){if(this.origin)try{this.object.matrix.copy(localToMercatorMatrix(origin).invert().multiply(localToMercatorMatrix(this.origin)));this.object.matrixWorldNeedsUpdate=true;}catch{}}
  applyPrepared(result:ReturnType<typeof prepareGameLandCover>,options:GameLandCoverOptions){return this.update([],options,result);}
  retainWhilePreparing(origin:GameOrigin):void{if(this.disposed)return;this.telemetry.state='loading_retained';this.retain(origin);}
  retainFailure(message:string,origin:GameOrigin):void{if(this.disposed)return;this.telemetry.state='error_retained';this.telemetry.lastError=message.slice(0,180);this.retain(origin);}
  update(features:readonly GameVegetationFeature[],options:GameLandCoverOptions,preparedResult?:ReturnType<typeof prepareGameLandCover>){
    if(this.disposed)return this.telemetry;if(options.loading){this.telemetry.state='loading_retained';this.retain(options.origin);return this.telemetry;}
    try{
      const result=preparedResult??prepareGameLandCover(features,options,this.telemetry.retainedBytes),old=this.mesh?.geometry;
      const changed=!old||!equals(old.getAttribute('position').array,result.positions)||!equals(old.getIndex()!.array,result.indices);
      if(changed){const geometry=new BufferGeometry();geometry.setAttribute('position',new BufferAttribute(result.positions,3));geometry.setAttribute('normal',new BufferAttribute(result.normals,3));geometry.setIndex(new BufferAttribute(result.indices,1));
        if(result.positions.length){geometry.computeBoundingBox();geometry.computeBoundingSphere();}
        if(this.mesh){this.mesh.geometry=geometry;old?.dispose();}else{this.mesh=new Mesh(geometry,createGameLandCoverMaterial());this.mesh.name='metric-source-ground';this.mesh.receiveShadow=true;this.mesh.castShadow=false;this.mesh.userData.provenance='visual_synthesis';this.mesh.userData.pickable=false;this.mesh.raycast=()=>{};this.object.add(this.mesh);}this.telemetry.geometryUpdates++;}
      updateGameLandCoverMaterial(this.mesh!.material,options.origin,options.qualityTier??'medium');this.mesh!.visible=result.indices.length>0;
      Object.assign(this.object.userData,{sourceId:options.sourceId??null,datasetVersion:options.datasetVersion??null});
      this.origin={...options.origin};this.object.matrix.identity();this.object.matrixWorldNeedsUpdate=true;
      Object.assign(this.telemetry,result.diagnostics,{state:'ready',geometryBytes:result.geometryBytes,retainedBytes:result.geometryBytes*2,draws:result.indices.length?1:0,lastError:null});
    }catch(error){this.telemetry.state='error_retained';this.telemetry.lastError=error instanceof Error?error.message.slice(0,160):'Land cover preparation failed';this.retain(options.origin);}return this.telemetry;
  }
  dispose(){if(this.disposed)return;this.disposed=true;this.mesh?.geometry.dispose();this.mesh?.material.dispose();this.mesh=null;this.origin=null;this.object.clear();
    Object.assign(this.telemetry,{state:'disposed',polygons:0,vertices:0,triangles:0,geometryBytes:0,retainedBytes:0,estimatedPeakBytes:0,draws:0});}
}
