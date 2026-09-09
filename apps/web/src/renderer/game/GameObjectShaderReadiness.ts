import {DoubleSide,type BufferGeometry,type Material,type Object3D,type ShaderMaterial} from 'three';
import type {GameShaderPreparation} from './GameShaderReadiness';

type Renderable=Object3D&{geometry:BufferGeometry;material:Material|Material[];isInstancedMesh?:boolean;instanceColor?:unknown;isSkinnedMesh?:boolean};
type Status='queued'|'pending'|'ready'|'failed';
interface Entry{object:Renderable;signature:string;visible:boolean;status:Status}
function renderable(object:Object3D):object is Renderable{return Boolean((object as Renderable).geometry&&(object as Renderable).material);}
const shaderSources=new WeakMap<Material,{vertex:unknown;fragment:unknown;revision:number}>();
function materialSignature(material:Material):unknown[]{
 const shader=material as ShaderMaterial,previous=shaderSources.get(material);
 const source=previous&&previous.vertex===shader.vertexShader&&previous.fragment===shader.fragmentShader?previous:
  {vertex:shader.vertexShader,fragment:shader.fragmentShader,revision:(previous?.revision??0)+1};shaderSources.set(material,source);
 // Three increments version twice on EVERY ordinary double-sided transparent
 // draw. Track its actual shader/defines/features instead of those internal bumps.
 const doublePass=material.transparent&&material.side===DoubleSide&&!material.forceSinglePass;
 return[material.uuid,doublePass?null:material.version,material.side,material.transparent,material.forceSinglePass,material.alphaTest,
  material.alphaHash,material.alphaToCoverage,material.vertexColors,material.toneMapped,material.customProgramCacheKey(),source.revision,shader.defines];
}
/** Position/count updates are uniforms or buffer uploads. Only shader-affecting
 * material versions, vertex layouts and instancing/morph features invalidate. */
function signature(object:Renderable):string{
 const geometry=object.geometry,materials=Array.isArray(object.material)?object.material:[object.material];
 return JSON.stringify([materials.map(materialSignature),
  Object.entries(geometry.attributes).map(([key,value])=>[key,value.itemSize,value.normalized]).sort(),
  Object.entries(geometry.morphAttributes).map(([key,values])=>[key,values?.length??0]).sort(),
  Boolean(object.isInstancedMesh),Boolean(object.instanceColor),Boolean(object.isSkinnedMesh),object.castShadow]);
}

/** Auxiliary objects can arrive after the city tile gate settled. This bounded
 * batch controller hides only new shader variants and never owns scene assets.
 * One compiling batch and one coalesced current inventory; no self render loop. */
export class GameObjectShaderReadiness{
 private readonly entries=new Map<Object3D,Entry>();
 private active:{entries:Entry[];cancel:()=>void}|null=null;private disposed=false;private failures=0;private lastError:string|null=null;
 constructor(private readonly options:{maxObjects:number;prepare:(objects:readonly Object3D[],onCompiled:()=>void)=>GameShaderPreparation;onChange:()=>void;onRelease?:(object:Object3D)=>void}){
  if(!Number.isInteger(options.maxObjects)||options.maxObjects<1||options.maxObjects>1024)throw Error('Invalid auxiliary shader object budget');
 }
 stage(roots:readonly Object3D[]):void{
  if(this.disposed)return;
  const objects=new Set<Renderable>();for(const root of roots)root.traverse(object=>{if(renderable(object))objects.add(object);});
  if(objects.size>this.options.maxObjects)throw Error('Auxiliary shader object budget exceeded');
  // Replacing a road mesh keeps its pooled material's live program references.
  // Reuse only variants from this current inventory, never unbounded history.
  const readySignatures=new Set([...this.entries.values()].filter(entry=>entry.status==='ready').map(entry=>entry.signature));
  let invalidate=false;
  for(const [object,entry]of this.entries)if(!objects.has(entry.object)){
   if(entry.status==='pending')invalidate=true;object.visible=entry.visible;this.entries.delete(object);this.options.onRelease?.(object);
  }
  for(const object of objects){const key=signature(object),previous=this.entries.get(object);
   if(previous?.signature===key)continue;
   if(previous?.status==='pending')invalidate=true;
   // A new shadow caster needs its own depth-material ownership even when its
   // colour program matches an incumbent's pooled material.
   const ready=readySignatures.has(key)&&(!object.castShadow||Boolean(previous)),entry:Entry={object,signature:key,visible:previous?.visible??object.visible,status:ready?'ready':'queued'};
   this.entries.set(object,entry);object.visible=ready?entry.visible:false;
  }
  if(invalidate)this.cancelActive();
  this.enforce();this.pump();
 }
 enforce():void{for(const entry of this.entries.values())if(entry.status!=='ready')entry.object.visible=false;}
 isReady(root:Object3D):boolean{let ready=true;root.traverse(object=>{if(renderable(object)&&this.entries.get(object)?.status!=='ready')ready=false;});return ready;}
 hasFailed(root:Object3D):boolean{let failed=false;root.traverse(object=>{if(this.entries.get(object)?.status==='failed')failed=true;});return failed;}
 get diagnostics(){let pendingMeshes=0,readyMeshes=0,failedMeshes=0;for(const entry of this.entries.values()){
  if(entry.status==='ready')readyMeshes++;else if(entry.status==='failed')failedMeshes++;else pendingMeshes++;
 }return{pendingMeshes,readyMeshes,failedMeshes,compilingBatches:this.active?1:0,failures:this.failures,lastError:this.lastError};}
 dispose():void{if(this.disposed)return;this.disposed=true;this.cancelActive();for(const entry of this.entries.values())entry.object.visible=entry.visible;this.entries.clear();}
 private cancelActive():void{const active=this.active;this.active=null;if(!active)return;
  for(const entry of active.entries)if(this.entries.get(entry.object)===entry&&entry.status==='pending')entry.status='queued';active.cancel();
 }
 private pump():void{
  if(this.disposed||this.active)return;const entries=[...this.entries.values()].filter(entry=>entry.status==='queued');if(!entries.length)return;
  for(const entry of entries)entry.status='pending';
  const active={entries,cancel:()=>{}};this.active=active;
  const finish=(error?:unknown)=>{if(this.disposed||this.active!==active)return;this.active=null;
   if(error){this.failures++;this.lastError=error instanceof Error?error.message:String(error);}
   for(const entry of entries)if(this.entries.get(entry.object)===entry){entry.status=error?'failed':'ready';entry.object.visible=error?false:entry.visible;}
   this.options.onChange();this.pump();
  };
  const compiled=()=>{if(this.active===active)for(const entry of entries)if(this.entries.get(entry.object)===entry)entry.signature=signature(entry.object);};
  try{const job=this.options.prepare(entries.map(entry=>entry.object),compiled);active.cancel=job.cancel;
   // Three's transparent two-pass preparation itself increments material.version.
   compiled();
   void job.promise.then(()=>finish(),finish);
  }catch(error){finish(error);}
 }
}
