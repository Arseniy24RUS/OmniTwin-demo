import {MercatorCoordinate} from 'maplibre-gl';
import {BufferAttribute,BufferGeometry,Group,Mesh,Vector2,type MeshStandardMaterial} from 'three';
import {localToMercatorMatrix,type GameOrigin} from './cameraAdapter';
import type {GameVegetationOptions} from './GameVegetation';
import {triangulateSourceWater} from './waterTriangulation';
import {createGameCourtyardGroundMaterial,updateGameCourtyardGroundMaterial} from './gameCourtyardGroundMaterial';
export type GameCourtyardGroundOptions=GameVegetationOptions;
export const GAME_COURTYARD_GROUND_LIMITS=Object.freeze({features:12000,polygons:16000,sourceVertices:500000,projectedVertices:16384,ringVertices:4096,rings:64,courtyards:128,
  vertices:{low:4096,medium:8192,high:16384},operations:2_000_000,bytes:8*1024*1024,borderWidthMeters:.5,topMeters:.016,borderTopMeters:.019});
type P=readonly [number,number];type Bounds=readonly [number,number,number,number];
interface SourcePolygon{id:string;rings:P[][];bounds:Bounds;local?:Vector2[][]}
const fail=(message:string):never=>{throw Error(`Courtyard ground ${message}`);};
function validBounds(b:unknown):b is Bounds{return Array.isArray(b)&&b.length===4&&b.every(Number.isFinite)&&b[0]<b[2]&&b[1]<b[3];}
function extent(ring:readonly P[]):Bounds{let w=Infinity,s=Infinity,e=-Infinity,n=-Infinity;for(const[x,y]of ring){w=Math.min(w,x);s=Math.min(s,y);e=Math.max(e,x);n=Math.max(n,y);}return[w,s,e,n];}
const overlap=(a:Bounds,b:Bounds)=>a[0]<=b[2]&&a[2]>=b[0]&&a[1]<=b[3]&&a[3]>=b[1];
const within=(a:Bounds,b:Bounds)=>a[0]>=b[0]&&a[2]<=b[2]&&a[1]>=b[1]&&a[3]<=b[3];
function area(r:readonly Vector2[]){let a=0;for(let i=0;i<r.length;i++){const p=r[i]!,q=r[(i+1)%r.length]!;a+=p.x*q.y-q.x*p.y;}return a*.5;}
function inside(p:Vector2,r:readonly Vector2[]){let yes=false;for(let i=0,j=r.length-1;i<r.length;j=i++){const a=r[i]!,b=r[j]!;if((a.y>p.y)!==(b.y>p.y)&&p.x<(b.x-a.x)*(p.y-a.y)/(b.y-a.y)+a.x)yes=!yes;}return yes;}
const cross=(a:Vector2,b:Vector2,c:Vector2)=>(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
function crossing(a:readonly Vector2[],b:readonly Vector2[],spend:(n:number)=>void){
  spend(a.length*b.length);for(let i=0;i<a.length;i++)for(let j=0;j<b.length;j++){const p=a[i]!,q=a[(i+1)%a.length]!,r=b[j]!,s=b[(j+1)%b.length]!;
    if(cross(p,q,r)*cross(p,q,s)<-1e-10&&cross(r,s,p)*cross(r,s,q)<-1e-10)return true;}return false;
}
function ringKey(r:readonly Vector2[]){let first=0;for(let i=1;i<r.length;i++)if(r[i]!.x<r[first]!.x||r[i]!.x===r[first]!.x&&r[i]!.y<r[first]!.y)first=i;
  const a=Array.from({length:r.length},(_,i)=>r[(first+i)%r.length]!.toArray()),b=Array.from({length:r.length},(_,i)=>r[(first-i+r.length)%r.length]!.toArray());return[JSON.stringify(a),JSON.stringify(b)].sort()[0]!;}
function clip(subject:Vector2[],triangle:Vector2[]){let p=subject;const t=area(triangle)>0?triangle:[...triangle].reverse();
  for(let i=0;i<3&&p.length;i++){const a=t[i]!,b=t[(i+1)%3]!,next:Vector2[]=[];for(let j=0;j<p.length;j++){const c=p[j]!,d=p[(j+1)%p.length]!,dc=cross(a,b,c),dd=cross(a,b,d),ci=dc>=-1e-8,di=dd>=-1e-8;
    if(ci)next.push(c);if(ci!==di){const f=dc/(dc-dd);next.push(new Vector2(c.x+(d.x-c.x)*f,c.y+(d.y-c.y)*f));}}p=next;}return p;
}
/** Only enclosed rings of complete verified source buildings qualify. Other
 * source building outers become exact islands; ambiguous crossing solids leave
 * their whole courtyard on the existing basemap rather than inventing a cut. */
export function prepareGameCourtyardGround(options:GameCourtyardGroundOptions,previousRetainedBytes=0){
  const L=GAME_COURTYARD_GROUND_LIMITS,tier=options.qualityTier??'medium',snapshot=options.buildings;localToMercatorMatrix(options.origin);
  if(!snapshot||snapshot.coverage!=='complete_viewport'||snapshot.invalidBuildings||snapshot.omittedBuildings||!validBounds(snapshot.coverageBounds)||!validBounds(options.bounds))return fail('requires complete verified source coverage');
  if(!Object.hasOwn(L.vertices,tier)||!Array.isArray(options.roads)||snapshot.data.features.length>L.features||!Number.isFinite(previousRetainedBytes)||previousRetainedBytes<0||previousRetainedBytes>L.bytes)return fail('admission invalid');
  const diagnostics={courtyards:0,islands:0,duplicates:0,omittedCoverage:0,omittedObstructions:0,omittedBudget:0,sourceVertices:0,projectedVertices:0,vertices:0,triangles:0,borderTriangles:0,operations:0,estimatedPeakBytes:0};
  const spend=(n:number)=>{diagnostics.operations+=n;if(diagnostics.operations>L.operations)return fail('topology work budget exceeded');};
  const source:SourcePolygon[]=[];
  for(const feature of snapshot.data.features){const id=String(feature.properties?.canonical_id??feature.id??'');if(!id||!snapshot.canonicalIds.has(id))return fail('canonical identity not verified');
    const polygons=feature.geometry?.type==='Polygon'?[feature.geometry.coordinates]:feature.geometry?.type==='MultiPolygon'?feature.geometry.coordinates:null;if(!polygons)return fail('source geometry invalid');
    for(const rings of polygons){if(!Array.isArray(rings)||!rings.length||rings.length>L.rings)return fail('source rings invalid');
      for(const ring of rings){if(!Array.isArray(ring)||ring.length<4||ring.length>L.ringVertices)return fail('source ring invalid');diagnostics.sourceVertices+=ring.length;
        if(diagnostics.sourceVertices>L.sourceVertices)return fail('source inspection budget exceeded');for(const p of ring)if(!Array.isArray(p)||p.length<2||!Number.isFinite(p[0])||!Number.isFinite(p[1])||Math.abs(p[0]!)>180||Math.abs(p[1]!)>=85.051129)return fail('source coordinate invalid');}
      // Horizontal coordinates have been checked; retain caller-owned rings.
      source.push({id,rings:rings as unknown as P[][],bounds:extent(rings[0]! as unknown as P[])});if(source.length>L.polygons)return fail('polygon budget exceeded');}}
  source.sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:a.bounds[0]-b.bounds[0]||a.bounds[1]-b.bounds[1]);
  const center=MercatorCoordinate.fromLngLat([options.origin.longitude,options.origin.latitude]),meter=center.meterInMercatorCoordinateUnits();
  const local=(record:SourcePolygon)=>record.local??=(record.rings.map(r=>{const points:Vector2[]=[];for(const [lon,lat]of r){const p=MercatorCoordinate.fromLngLat([lon,lat]),v=new Vector2((p.x-center.x)/meter,(p.y-center.y)/meter);if(!points.length||!v.equals(points.at(-1)!))points.push(v);}if(points.length>1&&points[0]!.equals(points.at(-1)!))points.pop();
    diagnostics.projectedVertices+=points.length;if(points.length<3||diagnostics.projectedVertices>L.projectedVertices)return fail('projected vertex budget exceeded');return points;}));
  const positions:number[]=[],border:number[]=[],seen=new Set<string>(),ownerIds=new Set<string>();let keyBytes=0;
  const memory=(vertices:number)=>vertices*32*6+previousRetainedBytes+source.length*160+diagnostics.projectedVertices*128+keyBytes;
  const pushTriangle=(a:Vector2,b:Vector2,c:Vector2,isBorder:boolean)=>{if(Math.abs(cross(a,b,c))<1e-8)return;const p=cross(a,b,c)>0?[a,c,b]:[a,b,c];for(const v of p){positions.push(v.x,(isBorder?L.borderTopMeters:L.topMeters)-(options.origin.altitude??0),v.y);border.push(isBorder?1:0);}if(isBorder)diagnostics.borderTriangles++;};
  const work:NonNullable<Parameters<typeof triangulateSourceWater>[1]>={remaining:500000};
  for(const owner of source){if(owner.rings.length<2)continue;const ownerLocal=local(owner),validated=triangulateSourceWater(ownerLocal,work);if(!validated||validated.repairedIntersections)return fail('source building topology invalid');
    for(let h=1;h<owner.rings.length;h++){const bounds=extent(owner.rings[h]!),outer=ownerLocal[h]!,key=ringKey(outer);if(seen.has(key)){diagnostics.duplicates++;continue;}seen.add(key);keyBytes+=key.length*2;
      // The viewport selects complete source floors, just as it selects complete
      // buildings. It must not cut a verified courtyard at a mobile screen edge.
      if(!within(bounds,snapshot.coverageBounds)||!overlap(bounds,options.bounds)){diagnostics.omittedCoverage++;continue;}
      let blocked=false;const islands:Vector2[][]=[],islandKeys=new Set<string>();
      for(const obstacle of source){if(obstacle===owner||!overlap(bounds,obstacle.bounds))continue;const rings=local(obstacle),r=rings[0]!;
        if(rings.some(ring=>crossing(outer,ring,spend))){blocked=true;break;}spend(outer.length*rings.reduce((n,r)=>n+r.length,0));
        if(outer.some(p=>inside(p,r)&&!rings.slice(1).some(hole=>inside(p,hole)))){
          // Identical source hole boundaries are duplicates, not solid islands.
          if(!rings.slice(1).some(hole=>ringKey(hole)===key)){blocked=true;break;}
        }
        spend(r.length*outer.length);if(r.every(p=>inside(p,outer))){const k=ringKey(r);if(!islandKeys.has(k)){islandKeys.add(k);islands.push(r);}}
      }
      if(blocked){diagnostics.omittedObstructions++;continue;}
      const visibleIslands=islands.filter((r,i)=>!islands.some((s,j)=>i!==j&&inside(r[0]!,s)));const rings=[outer,...visibleIslands],triangulated=triangulateSourceWater(rings,work);
      if(!triangulated||triangulated.repairedIntersections){diagnostics.omittedObstructions++;continue;}
      const count=triangulated.triangles.length*3;if(diagnostics.courtyards>=L.courtyards||border.length+count>L.vertices[tier]||memory(border.length+count)>L.bytes){diagnostics.omittedBudget++;continue;}
      for(const [a,b,c]of triangulated.triangles)pushTriangle(triangulated.points[a]!,triangulated.points[b]!,triangulated.points[c]!,false);
      diagnostics.courtyards++;diagnostics.islands+=visibleIslands.length;ownerIds.add(owner.id);
      for(let r=0;r<rings.length;r++){const ring=rings[r]!,sign=(area(ring)>0?1:-1)*(r===0?1:-1);
        for(let i=0;i<ring.length;i++){const a=ring[i]!,b=ring[(i+1)%ring.length]!,length=a.distanceTo(b);if(length<1e-6)continue;const n=new Vector2(-(b.y-a.y)/length*L.borderWidthMeters*sign,(b.x-a.x)/length*L.borderWidthMeters*sign),quad=[a,b,b.clone().add(n),a.clone().add(n)];
          for(const indexes of triangulated.triangles){spend(12);const tri=indexes.map(i=>triangulated.points[i]!),clipped=clip(quad,tri);for(let j=1;j<clipped.length-1;j++){
            if(border.length+3>L.vertices[tier]||memory(border.length+3)>L.bytes){diagnostics.omittedBudget++;break;}pushTriangle(clipped[0]!,clipped[j]!,clipped[j+1]!,true);}}
        }
      }
    }
  }
  const count=border.length,typedPositions=new Float32Array(positions),typedBorder=new Float32Array(border),normals=new Float32Array(count*3),indices=new Uint32Array(count);for(let i=0;i<count;i++){normals[i*3+1]=1;indices[i]=i;}
  const geometryBytes=typedPositions.byteLength+typedBorder.byteLength+normals.byteLength+indices.byteLength;
  Object.assign(diagnostics,{vertices:count,triangles:count/3,estimatedPeakBytes:memory(count)});if(diagnostics.estimatedPeakBytes>L.bytes)return fail('memory budget exceeded');
  return{positions:typedPositions,normals,indices,border:typedBorder,geometryBytes,diagnostics,ownerIds:[...ownerIds].sort()};
}
function equal(a:ArrayLike<number>,b:ArrayLike<number>){if(a.length!==b.length)return false;for(let i=0;i<a.length;i++)if(a[i]!==b[i])return false;return true;}
export class GameCourtyardGround{
  readonly object=new Group();readonly telemetry={state:'empty' as 'empty'|'ready'|'loading_retained'|'error_retained'|'disposed',representation:'visual_synthesis' as const,
    courtyardClassification:'source_enclosed_hole_not_surveyed_paving',roadsPolicy:'source_road_surfaces_above_unmodified_floor',courtyards:0,islands:0,duplicates:0,omittedCoverage:0,omittedObstructions:0,omittedBudget:0,
    sourceVertices:0,projectedVertices:0,vertices:0,triangles:0,borderTriangles:0,operations:0,geometryUpdates:0,geometryBytes:0,retainedBytes:0,estimatedPeakBytes:0,draws:0,lastError:null as string|null};
  private mesh:Mesh<BufferGeometry,MeshStandardMaterial>|null=null;private origin:GameOrigin|null=null;private disposed=false;
  constructor(){this.object.name='verified-source-courtyard-ground';this.object.userData.provenance='visual_synthesis';this.object.matrixAutoUpdate=false;}
  private retain(origin:GameOrigin){if(this.origin)try{this.object.matrix.copy(localToMercatorMatrix(origin).invert().multiply(localToMercatorMatrix(this.origin)));this.object.matrixWorldNeedsUpdate=true;}catch{}}
  update(options:GameCourtyardGroundOptions){if(this.disposed)return this.telemetry;if(options.loading){this.telemetry.state='loading_retained';this.retain(options.origin);return this.telemetry;}
    try{const result=prepareGameCourtyardGround(options,this.telemetry.retainedBytes),old=this.mesh?.geometry,changed=!old||!equal(old.getAttribute('position').array,result.positions)||!equal(old.getAttribute('courtyardBorder').array,result.border);
      if(changed){const geometry=new BufferGeometry();geometry.setAttribute('position',new BufferAttribute(result.positions,3));geometry.setAttribute('normal',new BufferAttribute(result.normals,3));geometry.setAttribute('courtyardBorder',new BufferAttribute(result.border,1));geometry.setIndex(new BufferAttribute(result.indices,1));
        if(result.indices.length){geometry.computeBoundingBox();geometry.computeBoundingSphere();}if(this.mesh){this.mesh.geometry=geometry;old?.dispose();}else{this.mesh=new Mesh(geometry,createGameCourtyardGroundMaterial());this.mesh.name='courtyard-paving-and-edge-course';this.mesh.receiveShadow=true;this.mesh.castShadow=false;this.mesh.raycast=()=>{};this.mesh.userData.provenance='visual_synthesis';this.object.add(this.mesh);}this.telemetry.geometryUpdates++;}
      updateGameCourtyardGroundMaterial(this.mesh!.material,options.origin);this.mesh!.visible=result.indices.length>0;this.origin={...options.origin};this.object.matrix.identity();this.object.matrixWorldNeedsUpdate=true;
      Object.assign(this.object.userData,{ownerIds:result.ownerIds,datasetVersion:options.buildings?.datasetVersion,sourceSignature:options.buildings?.signature});
      Object.assign(this.telemetry,result.diagnostics,{state:'ready',geometryBytes:result.geometryBytes,retainedBytes:result.geometryBytes*2,draws:result.indices.length?1:0,lastError:null});
    }catch(error){this.telemetry.state='error_retained';this.telemetry.lastError=error instanceof Error?error.message.slice(0,180):'Courtyard preparation failed';this.retain(options.origin);}return this.telemetry;
  }
  dispose(){if(this.disposed)return;this.disposed=true;this.mesh?.geometry.dispose();this.mesh?.material.dispose();this.mesh=null;this.origin=null;this.object.clear();Object.assign(this.telemetry,{state:'disposed',courtyards:0,vertices:0,triangles:0,geometryBytes:0,retainedBytes:0,estimatedPeakBytes:0,draws:0});}
}
