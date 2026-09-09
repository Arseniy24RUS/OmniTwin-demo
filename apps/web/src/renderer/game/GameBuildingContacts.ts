import {MercatorCoordinate} from 'maplibre-gl';
import {BufferAttribute,Group,InstancedBufferAttribute,InstancedBufferGeometry,Mesh,ShaderMaterial,Vector2} from 'three';
import {localToMercatorMatrix,type GameOrigin} from './cameraAdapter';
import {canonicalBuildingExtrusionHeights} from './canonicalBuildingPicking';
import {triangulateSourceWater} from './waterTriangulation';
import type {GameVegetationOptions} from './GameVegetation';

export const GAME_BUILDING_CONTACT_LIMITS=Object.freeze({features:12000,sourceVertices:150000,edges:24000,gridCells:32768,gridEntries:100000,
  cells:{low:1024,medium:3072,high:4096},operations:2_000_000,bytes:8*1024*1024,cellMeters:2,widthMeters:1,topMeters:.022,opacity:.18,edgesPerCell:8});
type Edge=readonly[number,number,number,number];
export interface GameContactCell{readonly x:number;readonly z:number;readonly size:number;readonly edges:readonly Edge[]}
const squaredDistance=(x:number,z:number,e:Edge)=>{const dx=e[2]-e[0],dz=e[3]-e[1],length=dx*dx+dz*dz,t=length?Math.max(0,Math.min(1,((x-e[0])*dx+(z-e[1])*dz)/length)):0;return(x-e[0]-t*dx)**2+(z-e[1]-t*dz)**2;};
export function sampleGameBuildingContact(cell:GameContactCell,x:number,z:number){const d=Math.sqrt(Math.min(...cell.edges.map(e=>squaredDistance(x,z,e))));return GAME_BUILDING_CONTACT_LIMITS.opacity*Math.max(0,1-d/GAME_BUILDING_CONTACT_LIMITS.widthMeters)**2;}
function distanceToCell(e:Edge,c:{x:number;z:number;size:number}){
  let low=0,high=1;for(const[a,b,min,max]of [[e[0],e[2],c.x,c.x+c.size],[e[1],e[3],c.z,c.z+c.size]]){const d=b!-a!;
    if(Math.abs(d)<1e-12){if(a!<min!||a!>max!){high=-1;break;}}else{const p=(min!-a!)/d,q=(max!-a!)/d;low=Math.max(low,Math.min(p,q));high=Math.min(high,Math.max(p,q));}}
  if(low<=high)return 0;
  let nearest=Infinity;for(const x of [c.x,c.x+c.size])for(const z of [c.z,c.z+c.size])nearest=Math.min(nearest,squaredDistance(x,z,e));
  for(let i=0;i<4;i+=2){const dx=Math.max(c.x-e[i]!,0,e[i]!-(c.x+c.size)),dz=Math.max(c.z-e[i+1]!,0,e[i+1]!-(c.z+c.size));nearest=Math.min(nearest,dx*dx+dz*dz);}return nearest;
}
const validBounds=(b:unknown):b is readonly[number,number,number,number]=>Array.isArray(b)&&b.length===4&&b.every(Number.isFinite)&&b[0]<b[2]&&b[1]<b[3];
const failure=(message:string):never=>{throw Error(`Building contacts ${message}`);};
/** Lighting only. Disjoint grid cells evaluate distance to the exact source wall
 * segments. Corner/neighbor strips therefore take the darkest contact once,
 * without translucent overdraw. Building depth hides the interior half-strip. */
export function prepareGameBuildingContacts(options:GameVegetationOptions,previousRetainedBytes=0){
  const L=GAME_BUILDING_CONTACT_LIMITS,s=options.buildings,tier=options.qualityTier??'medium';localToMercatorMatrix(options.origin);
  if(!s||s.coverage!=='complete_viewport'||s.invalidBuildings||s.omittedBuildings||!validBounds(s.coverageBounds)||!validBounds(options.bounds)
    ||!Object.hasOwn(L.cells,tier)||s.data.features.length>L.features||!Number.isFinite(previousRetainedBytes)||previousRetainedBytes<0||previousRetainedBytes>L.bytes)return failure('require bounded complete verified source');
  const anchor=MercatorCoordinate.fromLngLat([options.origin.longitude,options.origin.latitude]),meter=anchor.meterInMercatorCoordinateUnits();
  const local=(p:readonly number[])=>{if(p.length<2||!p.every(Number.isFinite)||Math.abs(p[0]!)>180||Math.abs(p[1]!)>=85.051129)return failure('coordinate invalid');const m=MercatorCoordinate.fromLngLat([p[0]!,p[1]!]);return new Vector2((m.x-anchor.x)/meter,(m.y-anchor.y)/meter);};
  const a=local([Math.max(s.coverageBounds[0],options.bounds[0]),Math.min(s.coverageBounds[3],options.bounds[3])]),b=local([Math.min(s.coverageBounds[2],options.bounds[2]),Math.max(s.coverageBounds[1],options.bounds[1])]);
  if(a.x>=b.x||a.y>=b.y)return failure('coverage intersection empty');
  const diagnostics={buildings:0,raisedBuildings:0,sourceEdges:0,sourceVertices:0,duplicates:0,cells:0,subdivisions:0,gridEntries:0,gridCells:0,operations:0,truncated:false,estimatedPeakBytes:0};
  const spend=(n=1)=>{diagnostics.operations+=n;if(diagnostics.operations>L.operations)return failure('work budget exceeded');};
  const edges:Edge[]=[],edgeKeys=new Set<string>(),ids=new Set<string>(),work:NonNullable<Parameters<typeof triangulateSourceWater>[1]>={remaining:500000};let keyBytes=0;
  for(const f of s.data.features){const id=String(f.properties?.canonical_id??f.id??'');if(!id||!s.canonicalIds.has(id)||ids.has(id))return failure('canonical identity invalid');ids.add(id);
    if(canonicalBuildingExtrusionHeights(f.properties??{},16).base>0){diagnostics.raisedBuildings++;continue;}
    const polygons=f.geometry.type==='Polygon'?[f.geometry.coordinates]:f.geometry.type==='MultiPolygon'?f.geometry.coordinates:null;if(!polygons)return failure('source geometry invalid');let relevant=false;
    for(const polygon of polygons){if(!polygon.length||polygon.length>64)return failure('rings invalid');const rings:Vector2[][]=[];
      for(const ring of polygon){if(ring.length<4||ring.length>4096)return failure('ring invalid');diagnostics.sourceVertices+=ring.length;if(diagnostics.sourceVertices>L.sourceVertices)return failure('source vertex budget exceeded');
        const points:Vector2[]=[];for(const p of ring){const v=local(p);if(!points.length||!v.equals(points.at(-1)!))points.push(v);}if(!points[0]!.equals(points.at(-1)!))return failure('ring is not closed');points.pop();if(points.length<3)return failure('ring collapsed');rings.push(points);}
      const outer=rings[0]!,west=Math.min(...outer.map(p=>p.x)),east=Math.max(...outer.map(p=>p.x)),north=Math.min(...outer.map(p=>p.y)),south=Math.max(...outer.map(p=>p.y));
      if(east<a.x-L.widthMeters||west>b.x+L.widthMeters||south<a.y-L.widthMeters||north>b.y+L.widthMeters)continue;
      const topology=triangulateSourceWater(rings,work);if(!topology||topology.repairedIntersections)return failure('source topology invalid');
      relevant=true;for(const ring of rings)for(let i=0;i<ring.length;i++){const p=ring[i]!,q=ring[(i+1)%ring.length]!,first=[p.x,p.y,q.x,q.y],second=[q.x,q.y,p.x,p.y];
        const forward=first.map(v=>v.toFixed(4)).join(','),reverse=second.map(v=>v.toFixed(4)).join(','),key=forward<reverse?forward:reverse;
        if(edgeKeys.has(key)){diagnostics.duplicates++;continue;}edgeKeys.add(key);keyBytes+=key.length*2;edges.push((forward<reverse?first:second) as unknown as Edge);if(edges.length>L.edges)return failure('edge budget exceeded');}
    }if(relevant)diagnostics.buildings++;
  }
  diagnostics.sourceEdges=edges.length;
  const sourceMemory=previousRetainedBytes+edges.length*96+keyBytes+diagnostics.sourceVertices*80+s.data.features.length*80;
  if(sourceMemory>L.bytes)return failure('source memory budget exceeded');
  // Grid phase is anchored to the retained Mercator origin; cells are disjoint
  // and unchanged by source feature order or native/detail ownership changes.
  const grid=new Map<string,{x:number;z:number;size:number;edges:Edge[]}>(),step=L.cellMeters;
  for(const edge of edges){const x0=Math.max(Math.floor((Math.min(edge[0],edge[2])-L.widthMeters)/step),Math.ceil(a.x/step)),x1=Math.min(Math.floor((Math.max(edge[0],edge[2])+L.widthMeters)/step),Math.floor(b.x/step)-1);
    const z0=Math.max(Math.floor((Math.min(edge[1],edge[3])-L.widthMeters)/step),Math.ceil(a.y/step)),z1=Math.min(Math.floor((Math.max(edge[1],edge[3])+L.widthMeters)/step),Math.floor(b.y/step)-1);
    for(let x=x0;x<=x1;x++)for(let z=z0;z<=z1;z++){spend();const cell={x:x*step,z:z*step,size:step};if(distanceToCell(edge,cell)>L.widthMeters**2)continue;const key=`${x},${z}`,record=grid.get(key);if(record)record.edges.push(edge);else grid.set(key,{...cell,edges:[edge]});
      if(++diagnostics.gridEntries>L.gridEntries||grid.size>L.gridCells||sourceMemory+grid.size*176+diagnostics.gridEntries*8>L.bytes)return failure('grid budget exceeded');}
  }
  diagnostics.gridCells=grid.size;
  const cx=(a.x+b.x)*.5,cz=(a.y+b.y)*.5,queue=[...grid.values()].sort((a,b)=>(a.x-cx)**2+(a.z-cz)**2-((b.x-cx)**2+(b.z-cz)**2)||a.x-b.x||a.z-b.z),cells:GameContactCell[]=[];
  const memory=(count:number)=>sourceMemory+count*144*6+grid.size*176+diagnostics.gridEntries*8;
  const add=(cell:GameContactCell)=>{if(cells.length>=L.cells[tier]||memory(cells.length+1)>L.bytes){diagnostics.truncated=true;return;}
    if(cell.edges.length>L.edgesPerCell){if(cell.size<=.125)return failure('dense source contact corner unresolved');diagnostics.subdivisions++;const size=cell.size*.5;
      for(const x of [cell.x,cell.x+size])for(const z of [cell.z,cell.z+size]){const child={x,z,size,edges:cell.edges.filter(e=>{spend();return distanceToCell(e,{x,z,size})<=L.widthMeters**2;})};if(child.edges.length)add(child);}return;}
    cells.push({...cell,edges:[...cell.edges].sort((a,b)=>a[0]-b[0]||a[1]-b[1]||a[2]-b[2]||a[3]-b[3])});};
  for(const cell of queue)add(cell);
  const packed=new Float32Array(cells.length*36);for(let i=0;i<cells.length;i++){const c=cells[i]!,x=c.x+c.size*.5,z=c.z+c.size*.5,at=i*36;packed.set([x,z,c.size,0],at);
    for(let j=0;j<8;j++){const e=c.edges[j];packed.set(e?[e[0]-x,e[1]-z,e[2]-x,e[3]-z]:[10000,10000,10001,10000],at+4+j*4);}}
  diagnostics.cells=cells.length;diagnostics.estimatedPeakBytes=memory(cells.length);if(diagnostics.estimatedPeakBytes>L.bytes)return failure('memory budget exceeded');
  return{cells,packed,diagnostics};
}
function material(){
  const declarations=Array.from({length:8},(_,i)=>`attribute vec4 contactEdge${i};varying vec4 contactEdgeV${i};`).join('\n'),varyings=Array.from({length:8},(_,i)=>`varying vec4 contactEdgeV${i};`).join('\n');
  const m=new ShaderMaterial({transparent:true,depthWrite:false,depthTest:true,toneMapped:false,uniforms:{contactY:{value:GAME_BUILDING_CONTACT_LIMITS.topMeters}},
    vertexShader:`attribute vec4 contactCell;varying vec2 contactPoint;uniform float contactY;${declarations}
void main(){contactPoint=position.xy*contactCell.z;${Array.from({length:8},(_,i)=>`contactEdgeV${i}=contactEdge${i};`).join('')}gl_Position=projectionMatrix*modelViewMatrix*vec4(contactCell.x+contactPoint.x,contactY,contactCell.y+contactPoint.y,1.0);}`,
    fragmentShader:`precision highp float;varying vec2 contactPoint;${varyings}
float wallDistance(vec4 edge){vec2 d=edge.zw-edge.xy;float t=clamp(dot(contactPoint-edge.xy,d)/max(dot(d,d),0.0000001),0.0,1.0);return length(contactPoint-edge.xy-d*t);}
void main(){float distanceToWall=10000.0;${Array.from({length:8},(_,i)=>`distanceToWall=min(distanceToWall,wallDistance(contactEdgeV${i}));`).join('')}
float fade=max(0.0,1.0-distanceToWall/${GAME_BUILDING_CONTACT_LIMITS.widthMeters.toFixed(1)});float alpha=${GAME_BUILDING_CONTACT_LIMITS.opacity}*fade*fade;if(alpha<0.001)discard;gl_FragColor=vec4(0.06,0.075,0.09,alpha);}`});
  m.name='source-building-contact-lighting';m.userData={representation:'visual_synthesis',lightingOnly:true,widthMeters:1};return m;
}
export class GameBuildingContacts{
  readonly object=new Group();readonly telemetry={state:'empty' as 'empty'|'ready'|'loading_retained'|'error_retained'|'disposed',representation:'visual_synthesis',lightingOnly:true,
    buildings:0,raisedBuildings:0,cells:0,sourceEdges:0,duplicates:0,subdivisions:0,truncated:false,geometryUpdates:0,geometryBytes:0,retainedBytes:0,estimatedPeakBytes:0,draws:0,lastError:null as string|null};
  private mesh:Mesh<InstancedBufferGeometry,ShaderMaterial>|null=null;private origin:GameOrigin|null=null;private packed:Float32Array|null=null;private disposed=false;
  constructor(){this.object.name='source-building-contact-lighting';this.object.matrixAutoUpdate=false;this.object.userData.lightingOnly=true;}
  private retain(origin:GameOrigin){if(this.origin)try{this.object.matrix.copy(localToMercatorMatrix(origin).invert().multiply(localToMercatorMatrix(this.origin)));this.object.matrixWorldNeedsUpdate=true;}catch{}}
  update(options:GameVegetationOptions){if(this.disposed)return this.telemetry;if(options.loading){this.telemetry.state='loading_retained';this.retain(options.origin);return this.telemetry;}
    try{const result=prepareGameBuildingContacts(options,this.telemetry.retainedBytes),changed=!this.packed||this.packed.length!==result.packed.length||this.packed.some((v,i)=>v!==result.packed[i]);
      if(changed){const g=new InstancedBufferGeometry();g.setAttribute('position',new BufferAttribute(new Float32Array([-.5,-.5,0,.5,-.5,0,.5,.5,0,-.5,.5,0]),3));g.setIndex([0,2,1,0,3,2]);
        for(let n=0;n<9;n++){const array=new Float32Array(result.cells.length*4);for(let i=0;i<result.cells.length;i++)array.set(result.packed.subarray(i*36+n*4,i*36+n*4+4),i*4);g.setAttribute(n===0?'contactCell':`contactEdge${n-1}`,new InstancedBufferAttribute(array,4));}g.instanceCount=result.cells.length;
        if(this.mesh){this.mesh.geometry.dispose();this.mesh.geometry=g;}else{this.mesh=new Mesh(g,material());this.mesh.frustumCulled=false;this.mesh.raycast=()=>{};this.object.add(this.mesh);}this.packed=result.packed;this.telemetry.geometryUpdates++;}
      this.mesh!.material.uniforms.contactY!.value=GAME_BUILDING_CONTACT_LIMITS.topMeters-(options.origin.altitude??0);this.mesh!.visible=result.cells.length>0;this.origin={...options.origin};this.object.matrix.identity();this.object.matrixWorldNeedsUpdate=true;
      const bytes=result.packed.byteLength+60;Object.assign(this.telemetry,result.diagnostics,{state:'ready',geometryBytes:bytes,retainedBytes:bytes*2+result.packed.byteLength,draws:result.cells.length?1:0,lastError:null});
    }catch(error){this.telemetry.state='error_retained';this.telemetry.lastError=error instanceof Error?error.message.slice(0,180):'Contact preparation failed';this.retain(options.origin);}return this.telemetry;
  }
  dispose(){if(this.disposed)return;this.disposed=true;this.mesh?.geometry.dispose();this.mesh?.material.dispose();this.mesh=null;this.packed=null;this.origin=null;this.object.clear();Object.assign(this.telemetry,{state:'disposed',cells:0,draws:0,geometryBytes:0,retainedBytes:0,estimatedPeakBytes:0});}
}
