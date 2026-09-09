import {BackSide,DoubleSide,FrontSide,Material,Mesh,MeshDepthMaterial,Object3D,PCFShadowMap,type Camera,type Scene,type WebGLRenderer,type WebGLRenderTarget} from 'three';
import type {GameShaderPreparation} from './GameShaderReadiness';

/** Exact small adapter for pinned Three0.185. isReady is present in installed
 * WebGLProgram, though its matching @types declaration omits it. */
export interface GameCompiledProgram {program:WebGLProgram|undefined;isReady:()=>boolean;getUniforms:()=>unknown;getAttributes:()=>unknown}
export interface GameProgramWaitOptions {programs:readonly GameCompiledProgram[];validate:(program:GameCompiledProgram)=>void;
 now?:()=>number;schedule?:(callback:()=>void)=>unknown;cancelSchedule?:(id:unknown)=>void;timeoutMs?:number}

/** Unlike Three.compileAsync, captures ALL material variants and supports
 * disposal/context loss. Error/uniform queries occur only after readiness. */
export function waitForGamePrograms(options:GameProgramWaitOptions):GameShaderPreparation{
 const now=options.now??(()=>performance.now()),schedule=options.schedule??(callback=>setTimeout(callback,10));
 const cancelSchedule=options.cancelSchedule??(id=>clearTimeout(id as ReturnType<typeof setTimeout>));
 const pending=new Set(options.programs);let timer:unknown=null,done=false,resolve!:()=>void,reject!:(error:Error)=>void;
 const started=now(),timeout=options.timeoutMs??15000;
 const promise=new Promise<void>((yes,no)=>{resolve=yes;reject=no;});
 const finish=(error?:Error)=>{if(done)return;done=true;if(timer!==null)cancelSchedule(timer);timer=null;error?reject(error):resolve();};
 const poll=()=>{timer=null;if(done)return;try{
  if(now()-started>timeout)throw Error('Shader readiness timed out');
  for(const program of pending){if(!program.program)throw Error('Shader program disposed during preparation');if(program.isReady()){options.validate(program);pending.delete(program);}}
  if(!pending.size)finish();else timer=schedule(poll);
 }catch(error){finish(error instanceof Error?error:Error(String(error)));}};
 // Yield after issuing compilation even on implementations without KHR support.
 // Such implementations expose no nonblocking completion guarantee.
 timer=schedule(poll);
 return{promise,cancel:()=>finish(new DOMException('Shader preparation cancelled','AbortError'))};
}

type ShadowSource=Material&{map?:MeshDepthMaterial['map'];alphaMap?:MeshDepthMaterial['alphaMap'];alphaTest:number;alphaToCoverage:boolean;
 displacementMap?:MeshDepthMaterial['displacementMap'];displacementScale?:number;displacementBias?:number;wireframe?:boolean;wireframeLinewidth?:number};
export function copyGameDepthFlags(target:MeshDepthMaterial,source:Material):void{
 const s=source as ShadowSource;
 target.visible=source.visible;target.side=source.shadowSide??(source.side===FrontSide?BackSide:source.side===BackSide?FrontSide:DoubleSide);
 target.map=s.map??null;target.alphaMap=s.alphaMap??null;target.alphaTest=s.alphaToCoverage ? .5 : s.alphaTest;
 target.clipShadows=source.clipShadows;target.clippingPlanes=source.clippingPlanes;target.clipIntersection=source.clipIntersection;
 target.displacementMap=s.displacementMap??null;target.displacementScale=s.displacementScale??1;target.displacementBias=s.displacementBias??0;
 target.wireframe=s.wireframe??false;target.wireframeLinewidth=s.wireframeLinewidth??1;
}

/** Only the custom depth material belongs to this preparation adapter. Source
 * geometry, source PBR materials and shared textures keep their existing owner. */
export function releaseGameDepthMaterials(root:Object3D,owned:Map<Mesh,MeshDepthMaterial>):void{
 root.traverse(object=>{const mesh=object as Mesh,depth=owned.get(mesh);if(!depth)return;
  owned.delete(mesh);if(mesh.customDepthMaterial===depth)mesh.customDepthMaterial=undefined;depth.dispose();
 });
}

/** Each custom depth material is retained with its owning mesh; same geometry,
 * map, alpha clipping, side and displacement as Three's PCF shadow material. */
export function prepareGameObjectShaders(options:{renderer:WebGLRenderer;root:Object3D;camera:Camera;scene:Scene;
 scratch:WebGLRenderTarget|null;extraRoots?:readonly Object3D[];shadowModes?:readonly boolean[];depthMaterials:Map<Mesh,MeshDepthMaterial>}):GameShaderPreparation{
 const {renderer,root,camera,scene,scratch,depthMaterials}=options,gl=renderer.getContext();
 if(renderer.shadowMap.enabled&&renderer.shadowMap.type!==PCFShadowMap)throw Error('Shader preparation requires the configured PCF shadow contract');
 const programs=new Set<GameCompiledProgram>();
 const remember=(materials:Set<Material>)=>{for(const material of materials){
  const props=renderer.properties.get(material) as {programs?:Map<string,GameCompiledProgram>};
  if(!props.programs?.size)throw Error('Three did not expose compiled material programs');
  for(const program of props.programs.values()){if(typeof program.isReady!=='function')throw Error('Unsupported Three shader readiness contract');programs.add(program);}
 }};
 const shadowEnabled=renderer.shadowMap.enabled,oldTarget=renderer.getRenderTarget(),framebuffer=gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer|null;
 const viewport=gl.getParameter(gl.VIEWPORT) as Int32Array,depthRange=gl.getParameter(gl.DEPTH_RANGE) as Float32Array;
 try{
  renderer.resetState();
  const roots=[root,...(options.extraRoots??[])];
  for(const enabled of new Set(options.shadowModes??[shadowEnabled])){
   renderer.shadowMap.enabled=enabled;
   renderer.setRenderTarget(null);for(const object of roots)remember(renderer.compile(object,camera,scene));
   if(scratch){renderer.setRenderTarget(scratch);for(const object of roots)remember(renderer.compile(object,camera,scene));}
  }
  renderer.shadowMap.enabled=shadowEnabled;
  if(scratch){
   renderer.setRenderTarget(scratch);
   for(const object of roots)object.traverse(child=>{
    const mesh=child as Mesh;if(!mesh.isMesh||!mesh.castShadow)return;
    let depth=depthMaterials.get(mesh);if(!depth){
     if(mesh.customDepthMaterial)throw Error('Custom source shadow material requires an explicit preparation contract');
     depth=new MeshDepthMaterial();depth.name='game-prepared-pcf-depth';depthMaterials.set(mesh,depth);mesh.customDepthMaterial=depth;
    }
    for(const material of Array.isArray(mesh.material)?mesh.material:[mesh.material]){
     copyGameDepthFlags(depth,material);depth.needsUpdate=true;
     const proxy=mesh.clone(false) as Mesh;proxy.material=depth;proxy.customDepthMaterial=undefined;
     remember(renderer.compile(proxy,camera,scene));
    }
   });
  }
 }finally{
  // No scene render or main-FBO clear is requested here. Three may initialize
  // its own environment targets. Restore shared state even on preprocessing
  // failure; async callbacks only query shader-program readiness.
  renderer.shadowMap.enabled=shadowEnabled;renderer.resetState();renderer.setRenderTarget(oldTarget);gl.bindFramebuffer(gl.FRAMEBUFFER,framebuffer);
  gl.viewport(viewport[0]!,viewport[1]!,viewport[2]!,viewport[3]!);gl.depthRange(depthRange[0]!,depthRange[1]!);
 }
 return waitForGamePrograms({programs:[...programs],validate:program=>{
  if(gl.isContextLost())throw Error('WebGL context lost during shader preparation');
  if(!gl.getProgramParameter(program.program!,gl.LINK_STATUS))throw Error('Game shader link failed: '+(gl.getProgramInfoLog(program.program!)??''));
  // Retains Three's own diagnostics, attribute and uniform checks; it is safe to
  // query these only after KHR completion has already reported readiness.
  program.getUniforms();program.getAttributes();
 }});
}
