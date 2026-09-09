import {describe,expect,it,vi} from 'vitest';
import {BackSide,BoxGeometry,FrontSide,Mesh,MeshDepthMaterial,MeshStandardMaterial,PCFShadowMap,PerspectiveCamera,Scene,Texture,WebGLRenderTarget,type WebGLRenderer} from 'three';
import {copyGameDepthFlags,prepareGameObjectShaders,releaseGameDepthMaterials,waitForGamePrograms,type GameCompiledProgram} from './gameShaderPreparation';

function fixture(){let ready=false;const program={program:{} as WebGLProgram,isReady:()=>ready,getUniforms:vi.fn(),getAttributes:vi.fn()} satisfies GameCompiledProgram;
 const callbacks:(()=>void)[]=[],validate=vi.fn(),cancelSchedule=vi.fn();let now=0;
 const job=waitForGamePrograms({programs:[program],validate,now:()=>now,schedule:cb=>{callbacks.push(cb);return callbacks.length;},cancelSchedule,timeoutMs:100});
 return{program,job,validate,cancelSchedule,ready:()=>{ready=true;},time:(value:number)=>{now=value;},poll:()=>callbacks.shift()?.()};}
describe('pinned Three shader program preparation',()=>{
 it('never performs link/uniform validation while parallel compilation is pending',async()=>{
  const f=fixture();f.poll();expect(f.validate).not.toHaveBeenCalled();f.ready();f.poll();await f.job.promise;expect(f.validate).toHaveBeenCalledWith(f.program);
 });
 it('cancels poll callbacks and rejects without querying a disposed program',async()=>{
  const f=fixture();const rejection=expect(f.job.promise).rejects.toThrow(/cancelled/);f.job.cancel();f.program.program=undefined;f.poll();await rejection;expect(f.validate).not.toHaveBeenCalled();expect(f.cancelSchedule).toHaveBeenCalled();
 });
 it('bounds never-ready driver programs and propagates link validation errors',async()=>{
  const f=fixture();const timeout=expect(f.job.promise).rejects.toThrow(/timed out/);f.time(101);f.poll();await timeout;
  const callbacks:(()=>void)[]=[],bad=waitForGamePrograms({programs:[{...f.program,isReady:()=>true}],validate:()=>{throw Error('invalid shadow link');},schedule:cb=>{callbacks.push(cb);return 1;},cancelSchedule:vi.fn()});
  const rejected=expect(bad.promise).rejects.toThrow('invalid shadow link');callbacks.shift()!();await rejected;
 });
 it('mirrors PCF source side, alpha map and displacement without changing source material',()=>{
  const source=new MeshStandardMaterial({side:FrontSide,map:new Texture(),alphaMap:new Texture(),alphaTest:.3,displacementMap:new Texture(),displacementScale:2,displacementBias:.1});
  const target=new MeshDepthMaterial();copyGameDepthFlags(target,source);
  expect(target.side).toBe(BackSide);expect(target.map).toBe(source.map);expect(target.alphaMap).toBe(source.alphaMap);expect(target.alphaTest).toBe(.3);expect(target.displacementScale).toBe(2);expect(target.displacementBias).toBe(.1);expect(source.side).toBe(FrontSide);
  source.alphaToCoverage=true;source.shadowSide=FrontSide;copyGameDepthFlags(target,source);expect(target.alphaTest).toBe(.5);expect(target.side).toBe(FrontSide);
 });
 it('releases only owned depth materials over repeated cells, preserving shared source resources',()=>{
  const geometry=new BoxGeometry(),texture=new Texture(),material=new MeshStandardMaterial({map:texture});
  const geometryDispose=vi.spyOn(geometry,'dispose'),textureDispose=vi.spyOn(texture,'dispose'),materialDispose=vi.spyOn(material,'dispose');
  const owned=new Map<Mesh,MeshDepthMaterial>();
  for(let index=0;index<200;index++){
   const mesh=new Mesh(geometry,material),depth=new MeshDepthMaterial({map:texture}),disposed=vi.spyOn(depth,'dispose');owned.set(mesh,depth);mesh.customDepthMaterial=depth;
   releaseGameDepthMaterials(mesh,owned);releaseGameDepthMaterials(mesh,owned);expect(owned.size).toBe(0);expect(mesh.customDepthMaterial).toBeUndefined();expect(disposed).toHaveBeenCalledTimes(1);
  }
  expect(geometryDispose).not.toHaveBeenCalled();expect(textureDispose).not.toHaveBeenCalled();expect(materialDispose).not.toHaveBeenCalled();
 });
 it('captures every main/scratch/depth program variant and restores shared framebuffer state',async()=>{
  vi.useFakeTimers();
  try{
   const mesh=new Mesh(new BoxGeometry(),new MeshStandardMaterial());mesh.castShadow=true;
   const scene=new Scene(),scratch=new WebGLRenderTarget(1,1),depthMaterials=new Map<Mesh,MeshDepthMaterial>();
   let target:WebGLRenderTarget|null=null,phase=0;const programs:GameCompiledProgram[]=[],properties=new Map<object,{programs:Map<string,GameCompiledProgram>}>();
   const gl={FRAMEBUFFER_BINDING:1,VIEWPORT:2,DEPTH_RANGE:3,FRAMEBUFFER:4,LINK_STATUS:5,getParameter:(key:number)=>key===2?[1,2,3,4]:key===3?[0,1]:null,
    bindFramebuffer:vi.fn(),viewport:vi.fn(),depthRange:vi.fn(),isContextLost:()=>false,getProgramParameter:()=>true};
   const renderer={shadowMap:{enabled:true,type:PCFShadowMap},getContext:()=>gl,getRenderTarget:()=>target,setRenderTarget:(value:WebGLRenderTarget|null)=>{target=value;},resetState:vi.fn(),properties:{get:(material:object)=>properties.get(material)},
    compile:(root:Mesh)=>{const material=root.material as MeshStandardMaterial,kind=material.type==='MeshDepthMaterial'?'depth':`${target?'scratch':'main'}-${renderer.shadowMap.enabled}`;
     const record=properties.get(material)??{programs:new Map<string,GameCompiledProgram>()};properties.set(material,record);
     const program={program:{} as WebGLProgram,isReady:()=>phase>=(kind==='depth'?2:1),getUniforms:vi.fn(),getAttributes:vi.fn()};record.programs.set(kind,program);programs.push(program);return new Set([material]);}} as unknown as WebGLRenderer;
   const job=prepareGameObjectShaders({renderer,root:mesh,camera:new PerspectiveCamera(),scene,scratch,depthMaterials,shadowModes:[false,true]});
   let done=false;void job.promise.then(()=>{done=true;});
   expect(target).toBeNull();expect(renderer.shadowMap.enabled).toBe(true);expect(gl.viewport).toHaveBeenCalledWith(1,2,3,4);expect(mesh.customDepthMaterial).toBe(depthMaterials.get(mesh));expect(programs).toHaveLength(5);
   phase=1;await vi.advanceTimersByTimeAsync(10);expect(done).toBe(false);expect(programs[4]!.getUniforms).not.toHaveBeenCalled();
   phase=2;await vi.advanceTimersByTimeAsync(10);await job.promise;expect(done).toBe(true);expect(programs.every(p=>(p.getUniforms as ReturnType<typeof vi.fn>).mock.calls.length===1)).toBe(true);
  }finally{vi.useRealTimers();}
 });
});
