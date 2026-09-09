import {describe,expect,it,vi} from 'vitest';
import {Mesh,MeshBasicMaterial,BoxGeometry,DataTexture,WebGLRenderTarget,type WebGLRenderer} from 'three';
import {prepareGameEnvironment} from './gameEnvironmentPreparation';
import type {GameCompiledProgram} from './gameShaderPreparation';

describe('authored environment shader preparation',()=>{
 it('waits for converter and GGX programs before any environment draw, then retains only output',async()=>{
  vi.useFakeTimers();try{
   let ready=false,target:WebGLRenderTarget|null=null;
   const output=new WebGLRenderTarget(336,128),source=new DataTexture(new Uint8Array(128*64*4),128,64),sourceDispose=vi.spyOn(source,'dispose');
   const material=new MeshBasicMaterial(),program:GameCompiledProgram={program:{} as WebGLProgram,isReady:()=>ready,getUniforms:vi.fn(),getAttributes:vi.fn()};
   const generator={_setSize:vi.fn(),_allocateTargets:()=>output,_ggxMaterial:material,_equirectMaterial:material,_lodMeshes:[new Mesh(new BoxGeometry(),material)],
    compileEquirectangularShader:vi.fn(),fromEquirectangular:vi.fn(()=>output),dispose:vi.fn()};
   const gl={FRAMEBUFFER_BINDING:1,VIEWPORT:2,DEPTH_RANGE:3,FRAMEBUFFER:4,LINK_STATUS:5,getParameter:(key:number)=>key===2?[0,0,10,10]:key===3?[0,1]:null,
    bindFramebuffer:vi.fn(),viewport:vi.fn(),depthRange:vi.fn(),isContextLost:()=>false,getProgramParameter:()=>true};
   const renderer={getContext:()=>gl,getRenderTarget:()=>target,setRenderTarget:(value:WebGLRenderTarget|null)=>{target=value;},resetState:vi.fn(),
    compile:vi.fn(()=>new Set([material])),properties:{get:()=>({programs:new Map([['program',program]])})}} as unknown as WebGLRenderer;
   const job=prepareGameEnvironment(renderer,source,()=>generator);expect(generator.fromEquirectangular).not.toHaveBeenCalled();
   await vi.advanceTimersByTimeAsync(20);expect(generator.fromEquirectangular).not.toHaveBeenCalled();ready=true;await vi.advanceTimersByTimeAsync(10);
   expect(await job.promise).toBe(output);expect(generator._setSize).toHaveBeenCalledWith(32);expect(generator.fromEquirectangular).toHaveBeenCalledWith(source,output);
   expect(generator.dispose).toHaveBeenCalledOnce();expect(target).toBeNull();expect(sourceDispose).not.toHaveBeenCalled();
   const dispose=vi.spyOn(output,'dispose');job.cancel();expect(dispose).toHaveBeenCalledOnce();
  }finally{vi.useRealTimers();}
 });
 it('rejects unsupported PMREM internals before rendering or silently changing the environment',async()=>{
  const source=new DataTexture(new Uint8Array(4),1,1),renderer={} as WebGLRenderer;
  expect(()=>prepareGameEnvironment(renderer,source,()=>({}) as never)).toThrow(/PMREM|environment/);
 });
 it('cancels a pending environment without a late draw or repeated owned-resource disposal',async()=>{
  vi.useFakeTimers();try{
   const source=new DataTexture(new Uint8Array(128*64*4),128,64),output=new WebGLRenderTarget(336,128),dispose=vi.spyOn(output,'dispose');
   const material=new MeshBasicMaterial(),query=vi.fn(()=>false),program:GameCompiledProgram={program:{} as WebGLProgram,isReady:query,getUniforms:vi.fn(),getAttributes:vi.fn()};
   const generator={_setSize:vi.fn(),_allocateTargets:()=>output,_ggxMaterial:material,_equirectMaterial:material,_lodMeshes:[new Mesh(new BoxGeometry(),material)],
    compileEquirectangularShader:vi.fn(),fromEquirectangular:vi.fn(()=>output),dispose:vi.fn()};
   const gl={FRAMEBUFFER_BINDING:1,VIEWPORT:2,DEPTH_RANGE:3,FRAMEBUFFER:4,getParameter:(key:number)=>key===2?[0,0,10,10]:key===3?[0,1]:null,
    bindFramebuffer:vi.fn(),viewport:vi.fn(),depthRange:vi.fn()};
   const renderer={getContext:()=>gl,getRenderTarget:()=>null,setRenderTarget:vi.fn(),resetState:vi.fn(),compile:()=>new Set([material]),
    properties:{get:()=>({programs:new Map([['program',program]])})}} as unknown as WebGLRenderer;
   const job=prepareGameEnvironment(renderer,source,()=>generator),rejected=expect(job.promise).rejects.toThrow(/cancelled/);
   job.cancel();job.cancel();await vi.advanceTimersByTimeAsync(100);await rejected;
   expect(query).not.toHaveBeenCalled();expect(generator.fromEquirectangular).not.toHaveBeenCalled();expect(generator.dispose).toHaveBeenCalledOnce();expect(dispose).toHaveBeenCalledOnce();
  }finally{vi.useRealTimers();}
 });
});
