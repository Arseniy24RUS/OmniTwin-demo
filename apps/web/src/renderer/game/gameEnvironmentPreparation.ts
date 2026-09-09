import {Mesh,OrthographicCamera,PMREMGenerator,REVISION,type Material,type Texture,type WebGLRenderer,type WebGLRenderTarget} from 'three';
import {waitForGamePrograms,type GameCompiledProgram} from './gameShaderPreparation';

/** Pinned Three185 adds the GGX convolution shader but its public compile method
 * warms only the equirectangular converter. This adapter uses its own generator's
 * actual allocated materials; no shader copy or alternate environment model. */
interface PmremContract {
 _setSize:(size:number)=>void;_allocateTargets:()=>WebGLRenderTarget;
 _ggxMaterial:Material|null;_equirectMaterial:Material|null;_lodMeshes:Mesh[];
 compileEquirectangularShader:()=>void;fromEquirectangular:(texture:Texture,target:WebGLRenderTarget)=>WebGLRenderTarget;dispose:()=>void;
}
export interface GameEnvironmentPreparation {promise:Promise<WebGLRenderTarget>;cancel:()=>void}
export function prepareGameEnvironment(renderer:WebGLRenderer,source:Texture,
 factory:()=>PmremContract=()=>new PMREMGenerator(renderer) as unknown as PmremContract):GameEnvironmentPreparation{
 const width=(source.image as {width?:number})?.width;
 if(REVISION!=='185'||!Number.isFinite(width)||width!==128)throw Error('Unsupported authored environment/Three PMREM contract');
 const generator=factory();
 for(const name of ['_setSize','_allocateTargets','compileEquirectangularShader','fromEquirectangular','dispose'] as const)
  if(typeof generator[name]!=='function')throw Error('Unsupported Three PMREM preparation contract');
 const gl=renderer.getContext(),camera=new OrthographicCamera(-1,1,1,-1,0,1);
 let output:WebGLRenderTarget|null=null,disposed=false,generatorDisposed=false,cancelWait=()=>{};
 const disposeGenerator=()=>{if(!generatorDisposed){generatorDisposed=true;generator.dispose();}};
 const state=<T>(action:()=>T):T=>{
  const oldTarget=renderer.getRenderTarget(),fbo=gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer|null;
  const viewport=gl.getParameter(gl.VIEWPORT) as Int32Array,depthRange=gl.getParameter(gl.DEPTH_RANGE) as Float32Array;
  try{renderer.resetState();return action();}finally{
   renderer.resetState();renderer.setRenderTarget(oldTarget);gl.bindFramebuffer(gl.FRAMEBUFFER,fbo);
   gl.viewport(viewport[0]!,viewport[1]!,viewport[2]!,viewport[3]!);gl.depthRange(depthRange[0]!,depthRange[1]!);
  }
 };
 const programs=new Set<GameCompiledProgram>();
 try{state(()=>{
  generator._setSize(width!/4);output=generator._allocateTargets();renderer.setRenderTarget(output);
  generator.compileEquirectangularShader();
  const geometry=generator._lodMeshes[0]?.geometry;
  if(!geometry||!generator._ggxMaterial||!generator._equirectMaterial)throw Error('Three PMREM did not expose allocated convolution materials');
  for(const material of [generator._equirectMaterial,generator._ggxMaterial]){
   renderer.compile(new Mesh(geometry,material),camera);
   const record=renderer.properties.get(material) as {programs?:Map<string,GameCompiledProgram>};
   if(!record.programs?.size)throw Error('PMREM shader programs unavailable');
   for(const program of record.programs.values())programs.add(program);
  }
 });}catch(error){disposeGenerator();(output as WebGLRenderTarget|null)?.dispose();throw error;}
 const wait=waitForGamePrograms({programs:[...programs],validate:program=>{
  if(gl.isContextLost())throw Error('WebGL context lost during environment preparation');
  if(!gl.getProgramParameter(program.program!,gl.LINK_STATUS))throw Error('Environment shader link failed');
  program.getUniforms();program.getAttributes();
 }});cancelWait=wait.cancel;
 const promise=wait.promise.then(()=>{
  if(disposed)throw new DOMException('Environment preparation cancelled','AbortError');
  const result=state(()=>generator.fromEquirectangular(source,output!));
  if(result!==output)throw Error('PMREM output ownership changed');disposeGenerator();return result;
 }).catch(error=>{disposeGenerator();output?.dispose();output=null;throw error;});
 return{promise,cancel:()=>{if(disposed)return;disposed=true;cancelWait();disposeGenerator();output?.dispose();output=null;}};
}
